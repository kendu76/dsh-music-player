/**
 * 新闻播报核心纯逻辑：入参校验、口播稿模板渲染、分块、保留策略、冷却窗、定时偏好规整。
 * 不依赖 fs / 网络 / DSH 服务，全部可独立单测；lib/index.js 只做持久化与服务接入。
 *
 * 设计依据：docs/daily-news-briefing-design.md（数据模型 §3 / 口播稿模板 §4 / 工具 §5.1）。
 */

/** 预设类别（热点排第一：跨领域 + 热度排序）。 */
export const PRESET_CATEGORIES = ['热点', '国内', '国际', '科技', '财经', '体育', '娱乐']

export const LIMITS = {
  categories: 8, // 单期类别数上限（预设 7 + 自定义余量）
  itemsPerCategory: 8,
  totalItems: 20,
  titleChars: 60,
  categoryNameChars: 20,
  sourceChars: 30,
  urlChars: 500,
  topicsPerShift: 5,
  shifts: 6,
  // 班次新闻条数（单期全期上限，多类别时尽量平均分配）：取值 1-20，默认 8。
  shiftItemCountMin: 1,
  shiftItemCountMax: 20,
  shiftItemCountDefault: 8,
  retentionPerShift: 7, // 每任务（班次）独立滚动保留期数
  cooldownMs: 10 * 60 * 1000, // 冷却窗：同班次 10 分钟内重复提交跳过
  runStateTtlMs: 10 * 60 * 1000, // 执行中状态 TTL（agent 漏报时自动复位）
  failuresKept: 10,
  // ---- RSS 信源池（RFC: docs/news-rss-pool-rfc.md）----
  rssFeeds: 30, // 信源池 feed 上限（默认 10 + 自定义 20）
  rssPollMin: 15, rssPollMax: 180, rssPollDefault: 30, // 拉取节奏（分钟）
  poolMaxItems: 500, // 池条目生命周期上限（超出按 firstSeen 保留最新）
  poolMaxAgeMs: 48 * 3600 * 1000, // 池条目最长保留（48h，超出即弃——新闻时效性）
  poolInjectMax: 60, // 单次收集指令注入池条目上限
  poolTitleChars: 60, // 注入行标题截断
  poolSummaryChars: 80, // 注入行摘要截断
  feedFailuresKept: 5, // 每源失败记录条数
  feedSuspendMs: 24 * 3600 * 1000, // 连续 3 次失败自动停用时长
}

/** 中文序数词：1 → 「第一条」…（支持到 99）。 */
export function cnOrdinal(n) {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n)
  if (n < 10) return '第' + digits[n] + '条'
  if (n === 10) return '第十条'
  if (n < 20) return '第十' + digits[n - 10] + '条'
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return '第' + digits[tens] + '十' + (ones === 0 ? '条' : digits[ones] + '条')
}

/** 'YYYY-MM-DD' → 'YYYY年M月D日'；解析失败原样返回。 */
export function formatDateCn(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr || ''))
  if (!m) return String(dateStr || '')
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`
}

const clip = (s, n) => {
  const t = String(s === undefined || s === null ? '' : s).trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 规整班次「新闻条数」：1-20 的整数，非法/缺失回退默认 8。 */
export function normalizeShiftItemCount(v) {
  if (v === undefined || v === null || v === '') return LIMITS.shiftItemCountDefault
  const n = Number(v)
  if (!Number.isFinite(n)) return LIMITS.shiftItemCountDefault
  return Math.min(LIMITS.shiftItemCountMax, Math.max(LIMITS.shiftItemCountMin, Math.round(n)))
}

/**
 * 平均分配预算：total 条尽量平均分给 count 个类别，返回每类的条数配额。
 * 算法：base = floor(total / count)，余数给前几个类别各 +1（如 8 条 × 3 类 → [3, 3, 2]）。
 */
export function evenItemQuota(total, count) {
  const k = Math.max(1, Math.floor(count))
  const t = Math.max(0, Math.floor(total))
  const base = Math.floor(t / k)
  const rem = t % k
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0))
}

/**
 * 按班次条数预算收敛各类别条目：每类截到其平均配额（多类别尽量平均分配）。
 * @returns {{ categories: object[], dropped: number }}
 */
export function capCategoriesToQuota(categories, total) {
  if (!Array.isArray(categories) || categories.length === 0) return { categories: categories || [], dropped: 0 }
  const quota = evenItemQuota(total, categories.length)
  let dropped = 0
  const out = categories.map((cat, i) => {
    const q = quota[i]
    if (q <= 0) { dropped += (cat.items || []).length; return null }
    if (cat.items.length > q) {
      dropped += cat.items.length - q
      return { ...cat, items: cat.items.slice(0, q) }
    }
    return cat
  }).filter(Boolean)
  return { categories: out, dropped }
}

/** 去掉末尾的标点与空白，供拼接时避免「。。」「。。」这类重复句号。 */
const trimEndPunct = (s) => String(s || '').replace(/[。！？.!?；;，,\s]+$/g, '')

/**
 * 校验并规整 news_broadcast 的入参。超限字段截断（不报错），结构性缺失才报错。
 * @param {object} opts - { today?, limits?: { itemsPerCategory?, totalItems? } } 自定义条数上限
 *   （班次配置了 itemCount 时传入：单类别可超过默认 8 条/类，全期以班次条数为上限）。
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function sanitizeEditionInput(body, { today, limits } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: '缺少新闻数据' }
  const itemsPerCategoryCap = limits && Number.isFinite(limits.itemsPerCategory)
    ? Math.max(1, Math.floor(limits.itemsPerCategory)) : LIMITS.itemsPerCategory
  const totalItemsCap = limits && Number.isFinite(limits.totalItems)
    ? Math.max(1, Math.floor(limits.totalItems)) : LIMITS.totalItems
  const rawCats = Array.isArray(body.categories) ? body.categories : []
  const title = clip(body.title, LIMITS.titleChars) || '今日新闻播报'
  const date = /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(body.date || ''))
    ? String(body.date)
    : (today || new Date().toISOString().slice(0, 10))
  const voice = typeof body.voice === 'string' && body.voice.trim() !== '' ? body.voice.trim() : null
  const categories = []
  let total = 0
  for (const c of rawCats) {
    if (categories.length >= LIMITS.categories) break
    if (!c || typeof c !== 'object') continue
    const name = clip(c.name, LIMITS.categoryNameChars)
    if (name === '') continue
    const rawItems = Array.isArray(c.items) ? c.items : []
    const items = []
    for (const it of rawItems) {
      if (items.length >= itemsPerCategoryCap || total >= totalItemsCap) break
      if (!it || typeof it !== 'object') continue
      const t = clip(it.title, LIMITS.titleChars)
      // 摘要不截断：字数上限只是提示词建议，生成长度即最终长度（超长由分块按句边界
      // 切成多块播报，内容不丢）；仅做首尾空白规整，空摘要仍视为无效条目。
      const summary = String(it.summary === undefined || it.summary === null ? '' : it.summary).trim()
      if (t === '' || summary === '') continue
      items.push({
        title: t,
        summary,
        source: clip(it.source, LIMITS.sourceChars),
        url: clip(it.url, LIMITS.urlChars),
        publishedAt: clip(it.publishedAt, 20),
      })
      total += 1
    }
    if (items.length > 0) categories.push({ name, items })
  }
  if (categories.length === 0) {
    return { ok: false, error: '没有有效的新闻条目（每条需要 title 与 summary）' }
  }
  return {
    ok: true,
    value: {
      title,
      date,
      categories,
      opening: typeof body.opening === 'string' ? clip(body.opening, 200) : '',
      closing: typeof body.closing === 'string' ? clip(body.closing, 200) : '',
      voice,
      autoplay: body.autoplay === undefined ? true : !!body.autoplay,
      force: !!body.force,
      originShiftId: typeof body.shiftId === 'string' && body.shiftId.trim() !== '' ? body.shiftId.trim() : 'manual',
      itemCount: total,
    },
  }
}

/**
 * 模板渲染口播稿。返回分片数组（含类别引导语/条目文本），并标注每个条目与类别
 * 在全文中的起始字符偏移——供分块后计算 itemChunk / 类别 fromChunk。
 * @returns {{ units: Array<{kind:'opening'|'categoryLead'|'item'|'closing', text:string}>, text: string, itemOffsets: number[], categoryOffsets: number[] }}
 */
export function renderScript({ title, date, categories, opening, closing }) {
  const parts = []
  const units = []
  const itemOffsets = []
  const categoryOffsets = []
  let pos = 0
  const push = (kind, text) => {
    units.push({ kind, text })
    parts.push(text)
    pos += text.length
  }
  // 开场：简洁播报台标与日期即可；具体类别由后面的「首先/接下来，将为您播报X方面的新闻」引导，避免重复啰嗦。
  if (opening) {
    push('opening', opening)
  } else {
    const dateCn = formatDateCn(date)
    // 标题若已自带日期（如「国内新闻播报 · 2026年8月31日」）则不重复追加，避免出现两个日期。
    const datePart = /(\d{1,2}月\d{1,2}日)/.exec(dateCn)
    const titleHasDate = datePart ? String(title).includes(datePart[1]) : String(title).includes(dateCn)
    push('opening', `您好，这里是${title}${titleHasDate ? '' : '，' + dateCn}。`)
  }
  // 类别与条目。**单类别期次不播类别引导**——单主题班次的开场（如「以下是今日
  // 国内要闻。」）往往已点名类别，再接「将为您播报国内方面的新闻。」明显重复；此时类别偏移改记在
  // 首条条目起点（目录跳转/上下类导航落到该类第一条新闻）。多类别仍保留全部引导语。
  const singleCategory = categories.length === 1
  categories.forEach((cat, ci) => {
    if (singleCategory) {
      categoryOffsets.push(pos)
    } else {
      const lead = ci === 0 ? `首先，将为您播报${cat.name}方面的新闻。` : `接下来，将为您播报${cat.name}方面的新闻。`
      push('categoryLead', lead)
      categoryOffsets.push(pos - lead.length)
    }
    cat.items.forEach((it) => {
      const seq = cnOrdinal(itemOffsets.length + 1)
      // 摘要自含主语（提示词要求开头点明「谁/什么事」），条目标题只在面板列表展示、
      // 不参与播报——模板念标题 + 摘要导语复述标题会同一句连播两遍，而摘要措辞与
      // 标题难以逐字对齐，代码层去重不可靠，从模板上移除标题才是根治。
      // 摘要已含全部内容，末尾补一个句号（先去掉摘要自带的尾部标点避免重复）。
      const sentence = `${seq === '第一条' ? '第一条' : seq}，${trimEndPunct(it.summary)}。`
      itemOffsets.push(pos)
      push('item', sentence)
    })
  })
  // 结语
  if (closing) {
    push('closing', closing)
  } else {
    push('closing', '以上就是今天的新闻播报，感谢收听。')
  }
  return { units, text: parts.join(''), itemOffsets, categoryOffsets }
}

/**
 * 按句子边界把口播稿切块：目标 ~120 字、上限 200 字；单句超限时硬切。
 * @returns {string[]}
 */
export function splitScriptChunks(text) {
  const sentences = []
  let buf = ''
  for (const ch of String(text)) {
    buf += ch
    if ('。！？；!?;\n'.includes(ch)) {
      sentences.push(buf)
      buf = ''
    }
  }
  if (buf !== '') sentences.push(buf)
  const chunks = []
  let cur = ''
  for (const s of sentences) {
    if (s.length > 200) {
      // 先把当前块落盘，再对超长句硬切。
      if (cur !== '') { chunks.push(cur); cur = '' }
      for (let i = 0; i < s.length; i += 200) chunks.push(s.slice(i, i + 200))
      continue
    }
    if (cur !== '' && cur.length + s.length > 200) {
      chunks.push(cur)
      cur = s
    } else if (cur.length + s.length >= 120 && cur.length + s.length <= 200) {
      // 满到目标区间即收块，保持块长稳定。
      cur += s
      chunks.push(cur)
      cur = ''
    } else {
      cur += s
    }
  }
  if (cur !== '') chunks.push(cur)
  return chunks.length > 0 ? chunks : ['']
}

/** 单块（字幕单元）字符上限：一条较长的完整新闻（标题+摘要 ≈ ≤310 字）默认仍装进一个块，
 * 保证字幕面板一帧就是一条完整新闻，同时容纳较充实的内容。 */
export const NEWS_ITEM_CHUNK_MAX = 400

/**
 * 按「一条新闻一个块」切分：每条 item / 其余引导语各为一个块，这样字幕面板每次显示的
 * 都是完整的一条新闻（或一段引导语）。**开场白与首个类别引导合并为一块**——让播报更早
 * 进入第一条新闻，缩短后续长新闻的 TTS 预合成等待（新闻较长合成耗时，分块越多第一条
 * 越晚出现、停顿感越明显）。超长单元（罕见，超过 maxChars）才在句边界内二次切分
 * （仍 ≤ maxChars），其余单元绝不跨条合并。
 * @param units renderScript 返回的单元列表
 * @returns {string[]}
 */
export function chunkByUnits(units, maxChars = NEWS_ITEM_CHUNK_MAX) {
  const chunks = []
  const list = units || []
  for (let i = 0; i < list.length; i++) {
    const u = list[i]
    const t = (u && typeof u.text === 'string') ? u.text : ''
    // 合并「开场 + 首个类别引导」为一块（默认开场总在 units[0]，其后跟首个 categoryLead）。
    if (i === 0 && u.kind === 'opening' && i + 1 < list.length
        && list[i + 1] && list[i + 1].kind === 'categoryLead' && t.length <= maxChars) {
      const lead = (list[i + 1] && typeof list[i + 1].text === 'string') ? list[i + 1].text : ''
      const merged = t + lead
      if (merged.length <= maxChars) {
        chunks.push(merged)
        i += 1 // 跳过已被合并的 categoryLead
        continue
      }
    }
    if (t.length <= maxChars) {
      chunks.push(t)
    } else {
      // 超长单元：按句边界切分，避免整块超 TTS 上限（splitScriptChunks 保证每块 ≤ maxChars）。
      for (const c of splitScriptChunks(t)) chunks.push(c)
    }
  }
  return chunks.length > 0 ? chunks : ['']
}

const chunkIndexOfOffset = (cum, offset) => {
  // cum[i] = 前 i 块的字符数；返回包含字符偏移 offset 的块号。
  let lo = 0, hi = cum.length - 1, ans = 0
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (cum[m] <= offset) { ans = m; lo = m + 1 } else hi = m - 1
  }
  return ans
}

/**
 * 由规整后的入参构建完整期次记录（渲染 + 分块 + 偏移映射）。
 * @returns {{ id, originShiftId, title, date, createdAt, voice, autoplay, categories, chunks, charOffsets, totalChars, itemChunk, categoryChunk }}
 */
export function buildEdition(input, { id, createdAt } = {}) {
  const { units, text, itemOffsets, categoryOffsets } = renderScript(input)
  // 按「一条新闻一个块」切分：字幕面板每次显示完整的一条新闻（或引导语/开场/结语）。
  const chunks = chunkByUnits(units)
  const charOffsets = new Array(chunks.length + 1)
  charOffsets[0] = 0
  for (let i = 0; i < chunks.length; i++) charOffsets[i + 1] = charOffsets[i] + chunks[i].length
  const cum = charOffsets.slice(0, chunks.length)
  return {
    id,
    originShiftId: input.originShiftId,
    title: input.title,
    date: input.date,
    createdAt: createdAt === undefined ? Date.now() : createdAt,
    voice: input.voice || null,
    autoplay: input.autoplay,
    categories: input.categories,
    chunks,
    charOffsets,
    totalChars: text.length,
    itemChunk: itemOffsets.map((off) => chunkIndexOfOffset(cum, off)),
    categoryChunk: categoryOffsets.map((off) => chunkIndexOfOffset(cum, off)),
  }
}

/** 每任务（班次）独立滚动保留：按 originShiftId 分组，各保留最新 7 期；返回裁剪后的数组。 */
export function applyRetention(editions, limit = LIMITS.retentionPerShift) {
  const counts = new Map()
  const kept = []
  // editions 按 createdAt 升序持久化；从新到旧数，组内前 limit 个保留。
  for (let i = editions.length - 1; i >= 0; i--) {
    const e = editions[i]
    const key = e.originShiftId || 'manual'
    const n = counts.get(key) || 0
    if (n < limit) { kept.push(e); counts.set(key, n + 1) }
  }
  return kept.reverse()
}

/** 冷却窗：同 originShiftId 在 windowMs 内已有期次则返回该期次，否则 null。 */
export function findInCooldown(editions, { originShiftId, now, windowMs = LIMITS.cooldownMs }) {
  for (let i = editions.length - 1; i >= 0; i--) {
    const e = editions[i]
    if ((e.originShiftId || 'manual') !== originShiftId) continue
    return (now - e.createdAt) < windowMs ? e : null
  }
  return null
}

/**
 * 每日 03:00 过期清理（不再保留多天新闻）：把「今日 00:00 之前」收集的期次与失败记录
 * 从保留集合中分离出来，并汇总它们关联的执行会话 id（去重、保序），供调用方联动销毁/归档。
 * 纯函数：不改动入参数组。
 * @returns {{ staleEditions: object[], staleFailures: object[], sessionIds: string[] }}
 */
export function partitionStaleNews(editions, failures, startOfTodayMs) {
  const staleEditions = (editions || []).filter((e) => Number(e && e.createdAt) < startOfTodayMs)
  const staleFailures = (failures || []).filter((f) => Number(f && f.ts) < startOfTodayMs)
  const sessionIds = []
  for (const e of staleEditions) {
    if (e && e.sessionId && !sessionIds.includes(e.sessionId)) sessionIds.push(e.sessionId)
  }
  for (const f of staleFailures) {
    if (f && f.sessionId && !sessionIds.includes(f.sessionId)) sessionIds.push(f.sessionId)
  }
  return { staleEditions, staleFailures, sessionIds }
}

/** 期次列表行摘要（第一层列表数据源）。 */
export function summarizeEdition(e) {
  return {
    id: e.id,
    originShiftId: e.originShiftId || 'manual',
    title: e.title,
    date: e.date,
    createdAt: e.createdAt,
    played: !!e.played,
    sessionId: e.sessionId || null, // 产生本次结果的执行会话 id（无执行会话则 null）
    categories: (e.categories || []).map((c) => ({ name: c.name, count: (c.items || []).length })),
    totalItems: (e.categories || []).reduce((n, c) => n + (c.items || []).length, 0),
    totalChars: e.totalChars,
  }
}

/** 期次 meta（/news/<id>/meta：章节结构 + 偏移，供客户端目录/进度/条目跳播）。 */
export function metaForEdition(e) {
  const sections = (e.categories || []).map((c, i) => ({
    type: 'category',
    heading: c.name,
    fromChunk: (e.categoryChunk && e.categoryChunk[i]) || 0,
    itemCount: (c.items || []).length,
  }))
  return {
    id: e.id,
    title: e.title,
    date: e.date,
    createdAt: e.createdAt,
    total: (e.chunks || []).length,
    sections,
    // 完整条目数据：面板「期次详情 / 文字版」直接由 meta 渲染（免第二次请求）。
    categories: e.categories || [],
    charOffsets: e.charOffsets,
    totalChars: e.totalChars,
    itemChunk: e.itemChunk || [],
    categoryChunk: e.categoryChunk || [],
  }
}

/** 播报时长估计（中文 TTS ≈ 260 字/分钟），向上取整，至少 1 分钟。 */
export function estimateMinutes(totalChars) {
  return Math.max(1, Math.ceil((totalChars || 0) / 260))
}

const normScope = (scope) => {
  const out = { categories: [], topics: [] }
  if (!scope || typeof scope !== 'object') return out
  if (Array.isArray(scope.categories)) {
    out.categories = scope.categories
      .filter((c) => typeof c === 'string' && PRESET_CATEGORIES.includes(c))
  }
  if (Array.isArray(scope.topics)) {
    out.topics = scope.topics
      .filter((t) => typeof t === 'string' && t.trim() !== '')
      .map((t) => clip(t, 20))
      .slice(0, LIMITS.topicsPerShift)
  }
  return out
}

/** 空范围兜底：班次收集范围必填（至少一个类别或主题），null/空一律规整为全部预设类别。 */
const emptyScope = () => ({ categories: PRESET_CATEGORIES.slice(), topics: [] })

const scopeIsEmpty = (s) =>
  (!s.categories || s.categories.length === 0) && (!s.topics || s.topics.length === 0)

/** 规整班次范围：null/空范围兜底为全预设类别（历史数据兼容），其余走白名单过滤。 */
const normShiftScope = (scope) => {
  const sc = normScope(scope)
  return scopeIsEmpty(sc) ? emptyScope() : sc
}

/**
 * 定时偏好规整（面板保存 / GET 返回共用）。非法字段丢弃、超限截断、版本号递增由调用方负责。
 * 注：defaultScope（全局默认类别）已退役——班次范围必填，不再有「继承默认」语义。
 */
export function sanitizeSchedulePrefs(input, prev) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const out = {
    enabled: input && typeof input === 'object' ? input.enabled !== false : base.enabled !== false,
    model: sanitizeModelSelection(input && input.model !== undefined ? input.model : base.model),
    shifts: [],
    prefVersion: Number.isInteger(base.prefVersion) ? base.prefVersion : 0,
    syncedVersion: Number.isInteger(base.syncedVersion) ? base.syncedVersion : -1,
  }
  const rawShifts = input && Array.isArray(input.shifts) ? input.shifts : (Array.isArray(base.shifts) ? base.shifts : [])
  for (const s of rawShifts) {
    if (out.shifts.length >= LIMITS.shifts) break
    if (!s || typeof s !== 'object') continue
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time || '')) ? String(s.time) : null
    if (time === null) continue
    out.shifts.push({
      id: typeof s.id === 'string' && s.id !== '' ? s.id.slice(0, 40) : 's' + Math.random().toString(36).slice(2, 8),
      time,
      autoplay: s.autoplay !== false,
      scope: normShiftScope(s.scope),
      itemCount: normalizeShiftItemCount(s.itemCount), // 班次新闻条数：1-20，默认 8
    })
  }
  // 归一化：班次按触发时刻升序（HH:MM 定长格式，字典序即时间序），列表展示/工具
  // 输出/定时日志的顺序与用户直觉一致，不依赖创建先后。
  out.shifts.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  return out
}

/**
 * 规整「新闻采集模型」选择：{ provider, model } 均为非空字符串才保留，否则 null（= 用当前活跃会话模型）。
 * 供面板定时编辑器保存 / 同步时创建专用会话使用。
 */
export function sanitizeModelSelection(input) {
  if (!input || typeof input !== 'object') return null
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (provider === '' || model === '') return null
  return { provider: provider.slice(0, 80), model: model.slice(0, 120) }
}

/** 执行中状态是否过期（TTL 懒过期）。 */
export function runStateAlive(run, now) {
  return !!(run && run.startedAt && (now - run.startedAt) < LIMITS.runStateTtlMs)
}

// ======================= RSS 信源池（P0，RFC §3/§4） =======================
// 全部纯逻辑：默认池、配置规整、XML 解析、增量入库、池裁剪、注入过滤、池摘要。
// Host 侧拉取器（lib/index.js rebuildPoolTimer / pullPoolOnce）只做调度与 fetch。

/** 信源分级：一手官方源 > 权威媒体 > 优质二手源 > KOL（RFC §1.2）。 */
export const RSS_TIERS = ['official', 'major', 'secondary', 'kol']
/** 分级 → 中文名（面板展示/提示词共用）。 */
export const RSS_TIER_NAMES = {
  official: '官方源', major: '权威媒体', secondary: '优质二手', kol: 'KOL',
}

/**
 * 内置默认信源池（RFC §3.2）：10 源 = official 7 + major 3，覆盖国内/国际/财经/科技/
 * 体育/娱乐/热点。全部 URL 于 2026-09 实测**今日新鲜**（parseRssXml 解析通过、
 * 最新条目 pubDate 距今 < 2 天）——曾入选的人民网 5 频道（2025-06 停更）、新浪
 * 科技/体育（2018 停更）、新浪娱乐/中新网娱乐（空壳）均已弃用。
 */
export const DEFAULT_RSS_FEEDS = [
  // 全部 URL 2026-09 实机验证：今日新鲜（最新条目 pubDate 距今 < 2 天）。
  // 中新网（官方通讯社，7 频道全覆盖，30 条/频道，今日更新）
  { id: 'chinanews-china', title: '中新网时政', tier: 'official', category: '国内', url: 'https://www.chinanews.com.cn/rss/china.xml' },
  { id: 'chinanews-world', title: '中新网国际', tier: 'official', category: '国际', url: 'https://www.chinanews.com.cn/rss/world.xml' },
  { id: 'chinanews-finance', title: '中新网财经', tier: 'official', category: '财经', url: 'https://www.chinanews.com.cn/rss/finance.xml' },
  { id: 'chinanews-sports', title: '中新网体育', tier: 'official', category: '体育', url: 'https://www.chinanews.com.cn/rss/sports.xml' },
  { id: 'chinanews-culture', title: '中新网文化', tier: 'official', category: '娱乐', url: 'https://www.chinanews.com.cn/rss/culture.xml' },
  { id: 'chinanews-scroll', title: '中新网即时', tier: 'official', category: '热点', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml' },
  { id: 'chinanews-import', title: '中新网要闻', tier: 'official', category: '热点', url: 'https://www.chinanews.com.cn/rss/importnews.xml' },
  // 科技垂直（IT之家 + 量子位 + 少数派，均今日更新）
  { id: 'ithome', title: 'IT之家', tier: 'major', category: '科技', url: 'https://www.ithome.com/rss/' },
  { id: 'qbitai', title: '量子位', tier: 'major', category: '科技', url: 'https://www.qbitai.com/feed' },
  { id: 'sspai', title: '少数派', tier: 'major', category: '科技', url: 'https://sspai.com/feed' },
]

/**
 * 默认信源池版本号：默认池内容变更（换源/停更源替换）时递增。
 * sanitizeRssPrefs 据此自动升级「未手工改过」的旧配置（用户改过 → custom 标记，不再跟随）。
 * v1 = 旧 12 源（含停更的人民网/新浪）；v2 = 新 10 源（中新网 7 频道 + IT之家/量子位/少数派，今日新鲜）。
 */
export const DEFAULT_RSS_FEEDS_VERSION = 2

const RSS_TIER_SET = new Set(RSS_TIERS)
const RSS_PRESET_CAT_SET = new Set(PRESET_CATEGORIES)

/** URL 规范化：去 query 追踪参数（utm_*、from、ref 等）、去 fragment、尾斜杠、协议归一为 https。 */
export function normalizeFeedUrl(url) {
  let s = String(url || '').trim()
  if (s === '') return ''
  try {
    const u = new URL(s)
    u.protocol = u.protocol === 'http:' ? 'https:' : u.protocol
    const keep = []
    for (const [k, v] of u.searchParams) {
      if (!/^(utm_|from|ref|spm|source|share_)/i.test(k)) keep.push([k, v])
    }
    u.search = ''
    for (const [k, v] of keep) u.searchParams.set(k, v)
    u.hash = ''
    let out = u.href
    if (u.pathname !== '/' && u.pathname.endsWith('/')) { u.pathname = u.pathname.slice(0, -1); out = u.href }
    return out
  } catch {
    return s
  }
}

/** 最小 HTML 实体解码（RSS 标题/链接/摘要里的 &amp; &lt; 等；&#xxx; 一并处理）。 */
const HTML_ENT_MIN = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
}
export function decodeRssEntities(s) {
  const fromCodePoint = (cp) => (Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '')
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z][A-Za-z0-9]+);/g, (m, n) => (n in HTML_ENT_MIN ? HTML_ENT_MIN[n] : m))
}

/**
 * 规整信源池配置（面板保存 / GET 返回共用）。与 sanitizeSchedulePrefs 同风格：
 * 非法字段丢弃、超限截断、默认池缺省补全。
 * 返回 { enabled, pollMinutes, feeds[], defaultVersion, custom }：
 * - 未提供 feeds（首次/旧数据）→ 内置默认池；
 * - 面板显式保存 feeds → 标记 custom:true（不再跟随默认池自动升级）；
 * - 未手工改过但默认池版本落后 → 自动替换为新默认池（换源/停更源替换后老用户自动升级）。
 */
export function sanitizeRssPrefs(input, prev) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const enabled = (input && typeof input === 'object' && input.enabled !== undefined)
    ? !!input.enabled : base.enabled !== false
  let poll = Number((input && input.pollMinutes !== undefined) ? input.pollMinutes : base.pollMinutes)
  if (!Number.isFinite(poll)) poll = LIMITS.rssPollDefault
  poll = Math.min(LIMITS.rssPollMax, Math.max(LIMITS.rssPollMin, Math.round(poll)))
  // feeds 来源（RFC §3.2）：
  //   1. 面板显式保存（input.feeds 存在）→ 用 input，标记 custom（用户改过，不再自动升级）；
  //   2. 否则旧配置未手工改过（!base.custom）且默认池版本落后 → 自动升级为新默认池；
  //   3. 否则沿用 base.feeds；base 无 feeds（首次）→ 默认池。
  const explicitInput = input && Array.isArray(input.feeds)
  const needUpgrade = !explicitInput && !base.custom
    && Number(base.defaultVersion || 0) < DEFAULT_RSS_FEEDS_VERSION
  let rawFeeds
  if (explicitInput) rawFeeds = input.feeds
  else if (needUpgrade || !Array.isArray(base.feeds)) rawFeeds = DEFAULT_RSS_FEEDS.slice()
  else rawFeeds = base.feeds
  const feeds = []
  const seen = new Set()
  for (const f of rawFeeds) {
    if (feeds.length >= LIMITS.rssFeeds) break
    if (!f || typeof f !== 'object') continue
    const url = normalizeFeedUrl(f.url)
    if (url === '' || !/^https?:\/\//i.test(url)) continue // 仅接受 http(s) URL
    const title = String(f.title === undefined || f.title === null ? '' : f.title).trim().slice(0, 40)
    if (title === '') continue
    const tier = RSS_TIER_SET.has(f.tier) ? f.tier : 'major'
    const category = RSS_PRESET_CAT_SET.has(f.category) ? f.category : '热点'
    // id：默认池按内置 id 匹配（保持稳定）；自定义生成 slug；重名去重。
    let id = typeof f.id === 'string' && f.id.trim() !== '' ? f.id.trim().slice(0, 40) : ''
    if (id === '' || seen.has(id)) {
      id = 'f' + Math.random().toString(36).slice(2, 8)
    }
    seen.add(id)
    const out = { id, title, tier, category, url, enabled: f.enabled !== false }
    // 自动停用标记（suspendedUntil）仅从既有配置透传（不在此新建）。
    if (f.suspendedUntil && Number.isFinite(Number(f.suspendedUntil))) {
      out.suspendedUntil = Number(f.suspendedUntil)
    }
    feeds.push(out)
  }
  // 未显式提供 feeds（且 base 也没有）时已用默认池；显式提供但全被过滤 → 空池（总开关仍可开，
  // 拉取器对空池直接跳过，收集走纯 web_search——RFC §6.2「池永不成为瓶颈」）。
  return {
    enabled, pollMinutes: poll, feeds,
    defaultVersion: DEFAULT_RSS_FEEDS_VERSION,
    // custom 标记：面板显式保存 → true；否则沿用旧配置的 custom（历史值透传）。
    custom: explicitInput ? true : (base.custom === true),
  }
}

/** 池条目内容指纹：url 规范化（优先）或 title 归一化（URL 缺失时）。 */
export function poolItemHash(item) {
  const url = normalizeFeedUrl(item && item.url)
  const key = url !== '' ? url : String(item && item.title || '').trim()
  if (key === '') return ''
  let h = 5381
  for (const ch of key) { h = ((h << 5) + h + ch.codePointAt(0)) >>> 0 }
  return 'h' + h.toString(36)
}

/** 轻量 RSS/Atom XML 解析（零依赖，仅取 title/link/pubDate/description，兼容 RSS 2.0 `<item>` 与 Atom `<entry>`）。 */
export function parseRssXml(xml) {
  const s = String(xml || '')
  const out = []
  // 剥注释与 CDATA，避免影响条目提取。
  const clean = s.replace(/<!--[\s\S]*?-->/g, '')
  // 统一取 item|entry 块。
  const blockRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi
  let m
  while ((m = blockRe.exec(clean)) !== null) {
    const body = m[2]
    const item = {}
    const grab = (tag) => {
      const r = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'i')
      const hit = r.exec(body)
      if (!hit) return ''
      // CDATA 内联处理。
      const inner = hit[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      return inner
    }
    const linkTag = /<(link)\b([^>]*)>([\s\S]*?)<\/\1\s*>/i.exec(body) || /<(link)\b([^>]*)\/>/i.exec(body)
    item.title = grab('title').replace(/\s+/g, ' ').trim()
    if (linkTag) {
      // <link>…text…</link> 优先取文本，否则取 href 属性（Atom）。
      const textLink = (linkTag[3] || '').trim()
      item.link = decodeRssEntities(textLink !== '' ? textLink : (/(?:^|\s)href=["']([^"']+)["']/i.exec(linkTag[2] || '') || [])[1] || '')
    }
    item.pubDate = grab('pubDate').trim() || grab('published').trim() || grab('updated').trim()
    // 摘要去 HTML 标签（RSS 描述常含 <b>/<p> 等内联标签，直接移除不补空格），再解码实体、折叠空白。
    item.description = grab('description').trim() || grab('summary').trim() || grab('content').trim()
    item.description = item.description
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    item.description = decodeRssEntities(item.description)
    if (item.title === '' && item.link === '') continue
    out.push(item)
  }
  return out
}

/**
 * 解析 RSS 日期字符串为时间戳（兼容 RFC 822 / ISO 8601 / 常见中文站点格式）。
 * 解析失败返回 null（调用方按「未知时效」处理：保留但标注，或由 agent 判断）。
 */
export function parseRssDate(str) {
  const s = String(str || '').trim()
  if (s === '') return null
  const t = Date.parse(s)
  if (Number.isFinite(t) && t > 0) return t
  // RFC 822 无时区（如 "Wed, 30 May 2026 08:02:00"）→ 按本地时间解析。
  const rfc = /^[A-Za-z]{3},\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/i.exec(s)
  if (rfc) {
    const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
    const mon = MONTHS[rfc[2].slice(0, 1).toUpperCase() + rfc[2].slice(1).toLowerCase()]
    if (mon === undefined) return null
    const d = new Date(Number(rfc[3]), mon, Number(rfc[1]), Number(rfc[4]), Number(rfc[5]), rfc[6] ? Number(rfc[6]) : 0)
    return Number.isFinite(d.getTime()) ? d.getTime() : null
  }
  return null
}

/**
 * 增量入库：把一轮解析出的条目并入池。按「url 规范化 hash」去重（池内已存在 / 已进过
 * 某期次 / 本批重复 → 跳过）。返回新增条数（供拉取器日志/摘要用）。
 * @param {object[]} poolItems 池条目数组（原地改：push 新条目）
 * @param {object[]} parsed parseRssXml 输出（含 feedId 由调用方补）
 * @param {{ now?: number, usedHashes?: Set<string>, seen?: Set<string> }} opts
 *   usedHashes：已进入期次的条目 hash（由 editions 反查构建，防同一 url 再次入池）；
 *   seen：本批内去重水位（调用方每轮拉取复用一个 Set）。
 * @returns {number}
 */
export function mergePoolItems(poolItems, parsed, { now = Date.now(), usedHashes = null, seen = null } = {}) {
  if (!Array.isArray(parsed)) return 0
  const inPool = new Set((poolItems || []).map((p) => p.hash))
  const batchSeen = seen || new Set()
  let added = 0
  for (const it of parsed) {
    if (!it || typeof it !== 'object') continue
    const title = String(it.title || '').trim()
    if (title === '') continue
    const item = {
      feedId: it.feedId || '',
      title: title.slice(0, LIMITS.titleChars),
      url: normalizeFeedUrl(it.link),
      publishedAt: it.publishedAt || null, // 时间戳（parseRssDate 已由调用方转好）
      summary: String(it.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      hash: poolItemHash({ url: it.link, title: it.title }),
      firstSeen: now,
      usedIn: [],
    }
    if (item.hash === '') continue
    if (inPool.has(item.hash)) continue
    if (usedHashes && usedHashes.has(item.hash)) continue
    if (batchSeen.has(item.hash)) continue
    batchSeen.add(item.hash)
    inPool.add(item.hash)
    poolItems.push(item)
    added += 1
  }
  return added
}

/** 池裁剪：超龄（48h）与超量（500 条，保最新）清理，摘除已用条目（usedIn 非空）。返回 { removed }。
 * publishedAt 超龄（发布 > 48h）直接淘汰——池定位是当日新闻，停更源残留的旧闻（如人民网
 * 2025-06 缓存）无论如何入池都无价值，拉取成功后立即 prune 即清走；不再设入库宽限。 */
export function prunePool(poolItems, { now = Date.now(), maxAgeMs = LIMITS.poolMaxAgeMs, maxItems = LIMITS.poolMaxItems } = {}) {
  const list = Array.isArray(poolItems) ? poolItems : []
  const kept = list.filter((it) => {
    if (!it) return false
    if (it.usedIn && it.usedIn.length > 0) return false // 已进入期次 → 摘除
    if (Number.isFinite(it.firstSeen) && (now - it.firstSeen) > maxAgeMs) return false
    // publishedAt 超龄直接淘汰（发布 > 48h 对播报无价值，含停更源残留旧闻）。
    if (it.publishedAt && Number.isFinite(it.publishedAt) && (now - it.publishedAt) > maxAgeMs) return false
    return true
  })
  // 超量：按 firstSeen 保最新。
  if (kept.length > maxItems) {
    kept.sort((a, b) => (Number(a.firstSeen) || 0) - (Number(b.firstSeen) || 0))
    kept.splice(0, kept.length - maxItems)
  }
  const removed = list.length - kept.length
  if (removed > 0) { poolItems.length = 0; for (const k of kept) poolItems.push(k) }
  return { removed }
}

/** 把已进入某期次的条目 hash 记入池（item.usedIn 置该期次 id）——删除期次时无需回滚（条目摘除即可）。 */
export function markPoolUsed(poolItems, hashes, editionId) {
  if (!Array.isArray(hashes)) return 0
  let n = 0
  for (const it of poolItems) {
    if (!it || !hashes.includes(it.hash)) continue
    if (!Array.isArray(it.usedIn)) it.usedIn = []
    if (!it.usedIn.includes(editionId)) { it.usedIn.push(editionId); n += 1 }
  }
  return n
}

/**
 * 按班次范围过滤池条目（注入前预筛）：命中规则（RFC §5.2）：
 *   1. feed 主投类别 ∈ scope.categories → 命中；
 *   2. feed 标题 / 条目标题命中任一主题关键词 → 命中；
 *   3. official 级源（一手官方）无条件命中（重大事件通常跨类别）。
 * 返回按 publishedAt 倒序（未知时效排最后）的条目数组。
 */
export function filterPoolForScope(poolItems, scope, { limit = LIMITS.poolInjectMax } = {}) {
  const s = scope || {}
  const cats = new Set(Array.isArray(s.categories) ? s.categories : [])
  const topics = (Array.isArray(s.topics) ? s.topics : []).map((t) => String(t || '').trim()).filter(Boolean)
  const hit = (it) => {
    if (!it) return false
    if (cats.has(it.feedCategory)) return true
    const titleText = String(it.title || '')
    for (const t of topics) {
      if (String(it.feedTitle || '').includes(t) || titleText.includes(t)) return true
    }
    return false
  }
  const list = (poolItems || []).filter(hit)
  list.sort((a, b) => {
    const pa = Number(a.publishedAt) || 0, pb = Number(b.publishedAt) || 0
    if (pa !== pb) return pb - pa
    return (Number(a.firstSeen) || 0) - (Number(b.firstSeen) || 0)
  })
  return list.slice(0, Math.max(1, Math.floor(limit)))
}

/**
 * 池摘要（收集指令注入 / 面板状态行共用）：返回池状态文本与统计。
 * @returns {{ ok: boolean, text: string, total: number, sinceMs: number|null, feedOk: number, feedFail: number, suspended: string[] }}
 */
export function poolSummary(pool, feeds, { now = Date.now(), injectLimit = LIMITS.poolInjectMax } = {}) {
  const p = pool || {}
  const items = Array.isArray(p.items) ? p.items : []
  const feedList = Array.isArray(feeds) ? feeds : []
  const enabledFeeds = feedList.filter((f) => f && f.enabled)
  const suspended = enabledFeeds.filter((f) => f.suspendedUntil && Number(f.suspendedUntil) > now).map((f) => f.title)
  const sinceMs = Number(p.fetchedAt) > 0 ? Number(p.fetchedAt) : null
  const total = items.length
  if (enabledFeeds.length === 0 || !p.enabled) {
    return { ok: false, text: '信源池未启用或无可用源，本轮收集走 web_search 补盲。', total: 0, sinceMs, feedOk: 0, feedFail: 0, suspended }
  }
  const lines = [
    `【信源池材料】以下条目来自本地 RSS 信源池（共 ${total} 条，池更新于 ${sinceMs ? new Date(sinceMs).toTimeString().slice(0, 5) : '未知'}）：`,
  ]
  const sorted = [...items].sort((a, b) => (Number(b.publishedAt) || 0) - (Number(a.publishedAt) || 0))
  for (const it of sorted.slice(0, injectLimit)) {
    const t = new Date(Number(it.publishedAt) || 0)
    const time = Number(it.publishedAt) ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '--:--'
    const title = String(it.title || '').slice(0, LIMITS.poolTitleChars)
    const sum = String(it.summary || '').slice(0, LIMITS.poolSummaryChars)
    lines.push(`— ${time} [${it.feedTitle || it.feedId || '?'}/${it.feedCategory || '?'}]《${title}》：${sum}`)
  }
  if (items.length > injectLimit) lines.push(`…（其余 ${items.length - injectLimit} 条略）`)
  if (suspended.length > 0) lines.push(`（已暂停源：${suspended.join('、')}——拉取连续失败自动停用）`)
  return { ok: true, text: lines.join('\n'), total, sinceMs, feedOk: enabledFeeds.length - suspended.length, feedFail: 0, suspended }
}

// ======================= 工具层确定性去重（P1，RFC §7） =======================
// 把「同一事件跨源去重」从提示词自觉升级为工具层硬约束：news_broadcast 提交时对
// 条目标题做归一化 + bigram Jaccard 相似度比对，与本期次内及当日已有期次去重。

/** 标题前缀词（归一化时剔除的营销/时效噪音，可扩充）。 */
const DEDUP_PREFIX_WORDS = [
  '独家', '重磅', '快讯', '刚刚', '突发', '官宣', '首发', '最新', '今日',
  '热点', '头条', '聚焦', '关注', '直击', '现场', '速递', '简报',
]

/**
 * 标题归一化 → 指纹（RFC §7.2）：
 * 小写化 → 去全角/半角标点 → 去前缀词 → 去数字日期片段 → 折叠空白。
 */
export function normalizeTitle(title) {
  let s = String(title || '').trim().toLowerCase()
  // 去全角/半角标点（保留字母数字与 CJK）。
  s = s.replace(/[\u3000-\u303f\uff00-\uffef!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\s]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  // 去前缀词（循环剥到不动为止）。
  let prev = ''
  while (s !== prev) {
    prev = s
    for (const w of DEDUP_PREFIX_WORDS) {
      if (s.startsWith(w)) { s = s.slice(w.length).replace(/^\s+/, ''); break }
    }
  }
  // 去数字日期片段（2026年5月30日 / 05-30 / 5月30日 / 2026-05-30）。
  s = s.replace(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g, ' ')
  s = s.replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, ' ')
  s = s.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ')
  s = s.replace(/\d{1,2}[-/.]\d{1,2}/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

/** 提取字符串的 bigram 集合（中文按字对、拉丁按字符对）。 */
export function bigrams(s) {
  const str = String(s || '')
  const set = new Set()
  if (str.length === 0) return set
  if (str.length === 1) { set.add(str); return set }
  for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2))
  return set
}

/** 提取字符串的字符（unigram）集合。 */
export function unigrams(s) {
  const set = new Set(String(s || ''))
  set.delete(' ')
  return set
}

/** 集合 Jaccard 相似度（0~1）。 */
export function setJaccard(A, B) {
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const g of A) if (B.has(g)) inter += 1
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}

/** bigram Jaccard 相似度（0~1）。 */
export function bigramJaccard(a, b) {
  return setJaccard(bigrams(a), bigrams(b))
}

/** unigram（字符级）Jaccard 相似度（0~1）——中文短标题的补充信号。 */
export function unigramJaccard(a, b) {
  return setJaccard(unigrams(a), unigrams(b))
}

/**
 * 判断两个归一化标题是否重复（RFC §7.3，中文短标题适配）：
 *   1. 相等 → true；
 *   2. 较长包含较短且长度比 ≥ 0.5 → true；
 *   3. max(bigram, unigram) Jaccard ≥ 0.55 → true（中文标题短，bigram 单信号过严，
 *      unigram 补足「多地迎来/持续强降雨」这类同事件不同措辞）。
 */
export function titlesDuplicate(normA, normB) {
  if (normA === '' || normB === '') return false
  if (normA === normB) return true
  // 纯数字/短字母编号（t1/t10、a/b、123）不做包含判断——数字编号的包含关系是假信号
  // （t10 包含 t1 但不同条目），且 Jaccard 阈值提得很高（编号必须几乎一致才算重复）。
  if (/^[\da-z]+$/.test(normA) && /^[\da-z]+$/.test(normB)) {
    return Math.max(bigramJaccard(normA, normB), unigramJaccard(normA, normB)) >= 0.9
  }
  const longer = normA.length >= normB.length ? normA : normB
  const shorter = normA.length >= normB.length ? normB : normA
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.5) {
    // 新增部分若纯数字/标点（如「第1号」vs「第10号」的数字后缀）→ 是编号差异而非同事件，
    // 不做包含判定；仅当新增部分含 CJK 语义字符才视为同一事件的不同措辞。
    const extra = longer.replace(shorter, '')
    if (!/^[\d\s\-—:：,.。()（）/]*$/.test(extra)) return true
  }
  // Jaccard 比较前剥离数字字符：编号标题（第1号/第2号）去数字后完全同模板，若剥离后
  // 归一化文本相同 → 视为同一事件（如「多地降雨(1)」「多地降雨(2)」）；否则交给 unigram。
  const stripDigits = (s) => s.replace(/\d+/g, '')
  const aNoDigits = stripDigits(normA)
  const bNoDigits = stripDigits(normB)
  if (aNoDigits !== '' && aNoDigits === bNoDigits) {
    // 去数字后完全相同：如「科技新闻第1号」vs「科技新闻第2号」→ 编号差异，不算重复。
    return false
  }
  return Math.max(bigramJaccard(normA, normB), unigramJaccard(normA, normB)) >= 0.55
}

/**
 * 工具层去重：把提交的条目与「参照组」（本期次内已通过者 ∪ 当日已有期次条目）比对，
 * 剔除重复。返回 { kept, dropped }（dropped 为被剔除的原始条目）。
 * @param {object[]} items 提交条目（含 title/summary/source）
 * @param {object[]} refs 参照组条目（当日已有期次的 items）
 * @param {{ sourceRank?: (s:string)=>number }} opts sourceRank：来源分级打分，越高越权威
 *   （用于 official 源升级替换：提交条目与参照重复但更权威时，保留提交条目并标记升级）。
 * @returns {{ kept: object[], dropped: object[], upgrades: number, upgradedRefs: object[] }}
 *   upgradedRefs：被升级替换掉的参照条目（调用方需在旧期次数据层移除）。
 */
export function dedupeItemsAgainst(items, refs, { sourceRank = () => 0 } = {}) {
  if (!Array.isArray(items) || items.length === 0) return { kept: [], dropped: [], upgrades: 0, upgradedRefs: [] }
  const seenNorm = new Set() // 本期次内已保留条目的归一化标题
  const refNorms = (refs || []).map((r) => ({ norm: normalizeTitle(r && r.title), source: r && r.source, item: r }))
  const kept = []
  const dropped = []
  const upgradedRefs = []
  let upgrades = 0
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const norm = normalizeTitle(it.title)
    if (norm === '') { kept.push(it); continue } // 无法归一化（极短/纯符号）→ 不误杀
    // 与本期次内已保留者比对。
    let dupInBatch = false
    for (const n of seenNorm) {
      if (titlesDuplicate(norm, n)) { dupInBatch = true; break }
    }
    // 与当日已有期次比对（含升级替换判定）。
    let dupRef = null
    let upgradeRef = false
    for (const r of refNorms) {
      if (r.norm === '') continue
      if (!titlesDuplicate(norm, r.norm)) continue
      dupRef = r
      // 提交条目来源比参照更权威 → 升级替换（保留提交、剔除参照——由调用方在期次数据层移除）。
      upgradeRef = sourceRank(it.source) > sourceRank(r.source)
      break
    }
    if (dupInBatch || (dupRef && !upgradeRef)) {
      dropped.push(it)
    } else {
      if (dupRef && upgradeRef) {
        upgrades += 1
        upgradedRefs.push(dupRef.item)
      }
      seenNorm.add(norm)
      kept.push(it)
    }
  }
  return { kept, dropped, upgrades, upgradedRefs }
}
