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
  retentionPerShift: 7, // 每任务（班次）独立滚动保留期数
  cooldownMs: 10 * 60 * 1000, // 冷却窗：同班次 10 分钟内重复提交跳过
  runStateTtlMs: 10 * 60 * 1000, // 执行中状态 TTL（agent 漏报时自动复位）
  failuresKept: 10,
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

/** 去掉末尾的标点与空白，供拼接时避免「。。」「。。」这类重复句号。 */
const trimEndPunct = (s) => String(s || '').replace(/[。！？.!?；;，,\s]+$/g, '')

/**
 * 校验并规整 news_broadcast 的入参。超限字段截断（不报错），结构性缺失才报错。
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function sanitizeEditionInput(body, { today } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: '缺少新闻数据' }
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
      if (items.length >= LIMITS.itemsPerCategory || total >= LIMITS.totalItems) break
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
