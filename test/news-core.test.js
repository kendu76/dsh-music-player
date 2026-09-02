import { describe, it, expect } from 'vitest'
import {
  PRESET_CATEGORIES, LIMITS, cnOrdinal, formatDateCn, sanitizeEditionInput,
  renderScript, splitScriptChunks, buildEdition, findInCooldown, partitionStaleNews,
  summarizeEdition, metaForEdition, estimateMinutes, sanitizeSchedulePrefs,
  sanitizeModelSelection, runStateAlive, shiftFiresAt,
  normalizeShiftItemCount, evenItemQuota, capCategoriesToQuota,
} from '../lib/news-core.js'
import { buildCalendar } from '../lib/calendar.js'

const VALID_BODY = {
  title: '早间新闻播报',
  date: '2026-05-30',
  categories: [
    {
      name: '热点',
      items: [
        { title: '某重大政策发布', summary: '今早国新办举行发布会，介绍相关政策要点。', source: '新华社', url: 'https://example.com/1', publishedAt: '08:02' },
        { title: '多地迎来强降雨', summary: '中央气象台继续发布暴雨预警，多地启动应急响应。', source: '央视新闻' },
      ],
    },
    {
      name: 'AI',
      items: [
        { title: '新一代模型发布', summary: '多家厂商密集发布新一代模型，推理成本显著下降。', source: '机器之心' },
      ],
    },
  ],
}

describe('cnOrdinal', () => {
  it('生成中文序数条目词', () => {
    expect(cnOrdinal(1)).toBe('第一条')
    expect(cnOrdinal(2)).toBe('第二条')
    expect(cnOrdinal(10)).toBe('第十条')
    expect(cnOrdinal(11)).toBe('第十一条')
    expect(cnOrdinal(20)).toBe('第二十条')
    expect(cnOrdinal(21)).toBe('第二十一条')
  })
})

describe('formatDateCn', () => {
  it('ISO 日期转中文', () => {
    expect(formatDateCn('2026-05-30')).toBe('2026年5月30日')
    expect(formatDateCn('garbage')).toBe('garbage')
  })
})

describe('sanitizeEditionInput', () => {
  it('接受有效输入并补默认值', () => {
    const r = sanitizeEditionInput({ categories: VALID_BODY.categories }, { today: '2026-05-30' })
    expect(r.ok).toBe(true)
    expect(r.value.title).toBe('今日新闻播报')
    expect(r.value.date).toBe('2026-05-30')
    expect(r.value.autoplay).toBe(true)
    expect(r.value.originShiftId).toBe('manual')
    expect(r.value.itemCount).toBe(3)
  })
  it('拒绝无有效条目的输入', () => {
    expect(sanitizeEditionInput({}).ok).toBe(false)
    expect(sanitizeEditionInput({ categories: [{ name: 'x' }] }).ok).toBe(false)
    expect(sanitizeEditionInput(null).ok).toBe(false)
  })
  it('超限条目被截断（每类/全期）', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, summary: 's' + i }))
    const r = sanitizeEditionInput({ categories: [{ name: '热点', items: many }] })
    expect(r.ok).toBe(true)
    expect(r.value.categories[0].items.length).toBe(LIMITS.itemsPerCategory)
  })
  it('summary 不截断：生成长度即最终长度（仅去首尾空白）', () => {
    // 字数上限只是提示词建议：代码不做任何截断，超长/无句末标点的内容原样保留
    //（超长条目由分块按句边界切成多块播报，内容不丢）。
    const long = '长'.repeat(270)
    const noPunct = '第一句讲要点，内容充实'.repeat(30)
    const r = sanitizeEditionInput({
      categories: [{ name: '热点', items: [
        { title: 't', summary: long },
        { title: 't2', summary: '  ' + noPunct + '  ' },
      ] }],
    })
    expect(r.value.categories[0].items[0].summary).toBe(long)
    expect(r.value.categories[0].items[1].summary).toBe(noPunct)
  })
  it('limits 覆盖每类/全期上限（班次新闻条数配置：单类别可超过默认 8 条/类）', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, summary: 's' + i }))
    const r = sanitizeEditionInput(
      { categories: [{ name: '热点', items: many }] },
      { limits: { itemsPerCategory: 12, totalItems: 12 } },
    )
    expect(r.ok).toBe(true)
    expect(r.value.categories[0].items.length).toBe(12)
    // 默认 limits 仍按 8/类、20/全期
    const d = sanitizeEditionInput({ categories: [{ name: '热点', items: many }] })
    expect(d.value.categories[0].items.length).toBe(LIMITS.itemsPerCategory)
  })
})

describe('normalizeShiftItemCount（班次新闻条数规整）', () => {
  it('默认 8，合法整数 1-20 原样保留', () => {
    expect(normalizeShiftItemCount(undefined)).toBe(8)
    expect(normalizeShiftItemCount(null)).toBe(8)
    expect(normalizeShiftItemCount('x')).toBe(8)
    expect(normalizeShiftItemCount(1)).toBe(1)
    expect(normalizeShiftItemCount(8)).toBe(8)
    expect(normalizeShiftItemCount(20)).toBe(20)
  })
  it('越界/小数收敛到 1-20', () => {
    expect(normalizeShiftItemCount(0)).toBe(1)
    expect(normalizeShiftItemCount(-3)).toBe(1)
    expect(normalizeShiftItemCount(21)).toBe(20)
    expect(normalizeShiftItemCount(99)).toBe(20)
    expect(normalizeShiftItemCount(7.6)).toBe(8)
  })
})

describe('evenItemQuota（多类别平均分配）', () => {
  it('8 条 × 3 类 → 3/3/2；能整除则全等', () => {
    expect(evenItemQuota(8, 3)).toEqual([3, 3, 2])
    expect(evenItemQuota(8, 2)).toEqual([4, 4])
    expect(evenItemQuota(10, 5)).toEqual([2, 2, 2, 2, 2])
    expect(evenItemQuota(1, 3)).toEqual([1, 0, 0])
  })
})

describe('capCategoriesToQuota（按班次条数收敛各类别）', () => {
  it('多类别按配额截断，余数给靠前类别', () => {
    const cats = [
      { name: '热点', items: Array.from({ length: 6 }, (_, i) => ({ title: 'h' + i, summary: 's' })) },
      { name: '国内', items: Array.from({ length: 5 }, (_, i) => ({ title: 'd' + i, summary: 's' })) },
      { name: '国际', items: Array.from({ length: 4 }, (_, i) => ({ title: 'i' + i, summary: 's' })) },
    ]
    const { categories, dropped } = capCategoriesToQuota(cats, 8)
    expect(categories.map((c) => c.items.length)).toEqual([3, 3, 2])
    expect(dropped).toBe(6 + 5 + 4 - 8)
    // 未超配额的类别原样保留
    const light = [
      { name: '热点', items: [{ title: 'h', summary: 's' }] },
      { name: '国内', items: [{ title: 'd', summary: 's' }] },
    ]
    const r2 = capCategoriesToQuota(light, 8)
    expect(r2.categories.map((c) => c.items.length)).toEqual([1, 1])
    expect(r2.dropped).toBe(0)
  })
  it('配额为 0 的类别被丢弃（条数预算小于类别数时）', () => {
    const cats = [
      { name: 'a', items: [{ title: 'a', summary: 's' }] },
      { name: 'b', items: [{ title: 'b', summary: 's' }] },
      { name: 'c', items: [{ title: 'c', summary: 's' }] },
    ]
    const { categories } = capCategoriesToQuota(cats, 1)
    expect(categories.length).toBe(1)
    expect(categories[0].name).toBe('a')
  })
})

describe('renderScript + splitScriptChunks', () => {
  const input = sanitizeEditionInput(VALID_BODY).value
  const { text, itemOffsets, categoryOffsets } = renderScript(input)

  it('开场含标题与日期（不再重复罗列类别）', () => {
    expect(text.startsWith('您好，这里是早间新闻播报，2026年5月30日。')).toBe(true)
    expect(text).not.toContain('今天的主要内容有')
  })
  it('标题已含日期时不重复追加日期', () => {
    const r = sanitizeEditionInput({
      title: '国内新闻播报 · 2026年8月31日', date: '2026-08-31',
      categories: [{ name: '国内', items: [{ title: 't', summary: 's。', source: 'x' }] }],
    }).value
    const { text: t2 } = renderScript(r)
    expect(t2.startsWith('您好，这里是国内新闻播报 · 2026年8月31日。')).toBe(true)
    // 只出现一次「2026年8月31日」（标题里的一次，开场不再追加）。
    expect(t2.match(/2026年8月31日/g).length).toBe(1)
  })
  it('条目句含序数、摘要（标题不播报）；不含来源尾缀', () => {
    expect(text).toContain('第一条，今早国新办举行发布会')
    expect(text).not.toContain('以上消息来自')
    expect(text).toContain('首先，将为您播报热点方面的新闻。')
    expect(text).toContain('接下来，将为您播报AI方面的新闻。')
  })
  it('摘要自带句号时不会出现重复句号', () => {
    // VALID_BODY 的 summary 不带句号；构造一个带句号的验证不出现「。。」
    const r = sanitizeEditionInput({
      categories: [{ name: '热点', items: [{ title: 't', summary: '事件要点。事件影响。' }] }],
    }).value
    const { text: t2 } = renderScript(r)
    expect(t2).toContain('第一条，事件要点。事件影响。')
    expect(t2).not.toContain('。。')
  })
  it('条目与类别偏移指向正确文本起点', () => {
    expect(text.slice(itemOffsets[0], itemOffsets[0] + 4)).toBe('第一条，')
    expect(text.startsWith('接下来，将为您播报AI方面的新闻。', categoryOffsets[1])).toBe(true)
  })
  it('分块均不超上限、拼接等于原文', () => {
    const chunks = splitScriptChunks(text)
    expect(chunks.join('')).toBe(text)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200)
  })
  it('空文本得到一个空块', () => {
    expect(splitScriptChunks('')).toEqual([''])
  })
  it('超长单句被硬切', () => {
    const chunks = splitScriptChunks('长'.repeat(450) + '。')
    expect(chunks.join('').length).toBe(451)
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
  })
})

describe('单类别期次（不播类别引导语）', () => {
  const single = sanitizeEditionInput({
    title: 'AI 新闻简报', date: '2026-08-31',
    opening: '各位听众早上好，今天是2026年8月31日，星期一。以下是今日国内要闻。',
    categories: [{ name: '国内', items: [
      { title: '政策发布', summary: '国新办介绍相关政策要点。', source: '新华社' },
      { title: '强降雨持续', summary: '多地启动应急响应。', source: '央视新闻' },
    ] }],
  }).value
  const { text, categoryOffsets } = renderScript(single)
  const e = buildEdition(single, { id: 'n9', createdAt: 1000 })

  it('开场后直接进第一条新闻，不再播类别引导', () => {
    expect(text).toContain('以下是今日国内要闻。第一条，国新办介绍相关政策要点。')
    expect(text).not.toContain('方面的新闻')
    expect(text).not.toContain('将为您播报')
  })
  it('类别偏移指向首条条目起点（目录跳转落到第一条新闻）', () => {
    expect(categoryOffsets.length).toBe(1)
    expect(text.slice(categoryOffsets[0], categoryOffsets[0] + 4)).toBe('第一条，')
  })
  it('categoryChunk 与 meta sections 对齐，跳转块即首条新闻；开场白独占一块', () => {
    expect(e.categoryChunk.length).toBe(1)
    const meta = metaForEdition(e)
    expect(meta.sections[0].heading).toBe('国内')
    expect(meta.sections[0].fromChunk).toBe(e.categoryChunk[0])
    expect(e.chunks[e.categoryChunk[0]].startsWith('第一条，')).toBe(true)
    expect(e.chunks[0]).toBe(single.opening)
  })
})

describe('buildEdition', () => {
  const input = sanitizeEditionInput(VALID_BODY).value
  const e = buildEdition(input, { id: 'n1', createdAt: 1000 })

  it('期次字段完整且 itemChunk 有效', () => {
    expect(e.id).toBe('n1')
    expect(e.originShiftId).toBe('manual')
    expect(e.totalChars).toBe(e.chunks.join('').length)
    expect(e.charOffsets[0]).toBe(0)
    expect(e.charOffsets.length).toBe(e.chunks.length + 1)
    expect(e.itemChunk.length).toBe(3)
    for (const c of e.itemChunk) expect(c).toBeGreaterThanOrEqual(0)
    expect(e.categoryChunk.length).toBe(2)
    expect(e.categoryChunk[1]).toBeGreaterThanOrEqual(e.categoryChunk[0])
  })
  it('metaForEdition 暴露目录结构与偏移', () => {
    const meta = metaForEdition(e)
    expect(meta.total).toBe(e.chunks.length)
    expect(meta.sections[0].heading).toBe('热点')
    expect(meta.sections[0].itemCount).toBe(2)
    expect(meta.itemChunk).toEqual(e.itemChunk)
  })
  it('estimateMinutes 至少 1 分钟且随字数增长', () => {
    expect(estimateMinutes(10)).toBe(1)
    expect(estimateMinutes(1500)).toBeGreaterThan(estimateMinutes(300))
  })
})

describe('findInCooldown（冷却窗）', () => {
  const e = { id: 'n1', originShiftId: 's1', createdAt: 1000, categories: [] }
  it('窗口内命中返回该期次', () => {
    expect(findInCooldown([e], { originShiftId: 's1', now: 1000 + LIMITS.cooldownMs - 1 })).toBe(e)
  })
  it('窗口外返回 null', () => {
    expect(findInCooldown([e], { originShiftId: 's1', now: 1000 + LIMITS.cooldownMs })).toBe(null)
  })
  it('不同班次不受影响', () => {
    expect(findInCooldown([e], { originShiftId: 's2', now: 1001 })).toBe(null)
  })
  it('取的是该班次最新一期判断', () => {
    const older = { id: 'n0', originShiftId: 's1', createdAt: 100, categories: [] }
    expect(findInCooldown([older, e], { originShiftId: 's1', now: 1200 })).toBe(e)
  })
})

describe('partitionStaleNews（每日 03:00 过期清理）', () => {
  const START = 1000 // 「今日 00:00」
  const old1 = { id: 'old1', createdAt: 500, sessionId: 'news-exec-a' }
  const old2 = { id: 'old2', createdAt: 999, sessionId: 'news-exec-b' }
  const fresh = { id: 'fresh', createdAt: 1000, sessionId: 'news-exec-c' } // 恰好今天 00:00 → 保留
  const newer = { id: 'newer', createdAt: 5000, sessionId: null }
  it('按 createdAt 分离今天之前的期次，边界值（=00:00）保留', () => {
    const { staleEditions } = partitionStaleNews([old1, old2, fresh, newer], [], START)
    expect(staleEditions.map((e) => e.id)).toEqual(['old1', 'old2'])
  })
  it('失败记录按 ts 分离；会话 id 去重汇总（期次 + 失败共用会话只出现一次）', () => {
    const failures = [
      { ts: 400, kind: 'empty', sessionId: 'news-exec-a' }, // 与 old1 同会话 → 去重
      { ts: 1200, kind: 'error' }, // 今天 → 保留
    ]
    const { staleFailures, sessionIds } = partitionStaleNews([old1, old2, fresh], failures, START)
    expect(staleFailures.length).toBe(1)
    expect(sessionIds).toEqual(['news-exec-a', 'news-exec-b'])
  })
  it('空输入与无会话字段安全', () => {
    expect(partitionStaleNews([], [], START)).toEqual({ staleEditions: [], staleFailures: [], sessionIds: [] })
    expect(partitionStaleNews([{ id: 'x', createdAt: 1 }], [], START).sessionIds).toEqual([])
  })
})

describe('summarizeEdition', () => {
  it('列表行含类别计数与播放状态', () => {
    const input = sanitizeEditionInput(VALID_BODY).value
    const e = { ...buildEdition(input, { id: 'n1', createdAt: 5 }), played: false }
    const s = summarizeEdition(e)
    expect(s.categories[0]).toEqual({ name: '热点', count: 2 })
    expect(s.totalItems).toBe(3)
    expect(s.played).toBe(false)
  })
})

describe('sanitizeSchedulePrefs', () => {
  it('默认值与班次规整', () => {
    const p = sanitizeSchedulePrefs({})
    expect(p.enabled).toBe(true)
    expect(p.shifts).toEqual([])
    expect(p.prefVersion).toBe(0)
    expect(p.syncedVersion).toBe(-1)
  })
  it('defaultScope 已退役：入参中的该字段被丢弃', () => {
    const p = sanitizeSchedulePrefs({
      defaultScope: { categories: ['热点', '不存在', '国内'], topics: ['AI', ''] },
    })
    expect(p.defaultScope).toBeUndefined()
  })
  it('班次时间非法被丢弃、超限截断、scope=null 兜底为全预设类别', () => {
    const p = sanitizeSchedulePrefs({
      shifts: [
        { id: 'a', time: '08:00', autoplay: false, scope: null },
        { id: 'b', time: '25:00' },
        { id: 'c', time: '12:30', autoplay: true, scope: { topics: Array.from({ length: 9 }, (_, i) => 't' + i) } },
      ],
    })
    expect(p.shifts.length).toBe(2)
    expect(p.shifts[0].autoplay).toBe(false)
    expect(p.shifts[0].scope).toEqual({ categories: PRESET_CATEGORIES, topics: [] })
    expect(p.shifts[1].scope.topics.length).toBe(LIMITS.topicsPerShift)
  })
  it('班次新闻条数：默认 8、越界收敛到 1-20', () => {
    const p = sanitizeSchedulePrefs({
      shifts: [
        { id: 'a', time: '08:00', itemCount: 12 },
        { id: 'b', time: '09:00', itemCount: 0 },
        { id: 'c', time: '10:00', itemCount: 99 },
        { id: 'd', time: '11:00' },
      ],
    })
    expect(p.shifts.map((s) => s.itemCount)).toEqual([12, 1, 20, 8])
  })
  it('班次「仅工作日执行」：显式 true 保留、缺失/非 true 一律 false', () => {
    const p = sanitizeSchedulePrefs({
      shifts: [
        { id: 'a', time: '08:00', workdaysOnly: true },
        { id: 'b', time: '09:00', workdaysOnly: false },
        { id: 'c', time: '10:00' }, // 旧数据无该字段 → false
        { id: 'd', time: '11:00', workdaysOnly: 1 }, // 非严格 true → false
      ],
    })
    expect(p.shifts.map((s) => s.workdaysOnly)).toEqual([true, false, false, false])
  })
  it('空范围兜底为全预设类别；纯主题范围原样保留', () => {
    const p = sanitizeSchedulePrefs({
      shifts: [
        { id: 'a', time: '08:00', scope: { categories: [], topics: [] } },
        { id: 'b', time: '09:00', scope: { categories: [], topics: ['AI'] } },
      ],
    })
    expect(p.shifts[0].scope).toEqual({ categories: PRESET_CATEGORIES, topics: [] })
    expect(p.shifts[1].scope).toEqual({ categories: [], topics: ['AI'] })
  })
  it('班次按触发时刻升序排列（乱序入参归一化）', () => {
    const p = sanitizeSchedulePrefs({
      shifts: [
        { id: 'x', time: '12:30' },
        { id: 'y', time: '09:00' },
        { id: 'z', time: '08:00' },
      ],
    })
    expect(p.shifts.map((s) => s.time)).toEqual(['08:00', '09:00', '12:30'])
  })
  it('班次数上限 6', () => {
    const shifts = Array.from({ length: 9 }, (_, i) => ({ time: `0${i}:00` }))
    expect(sanitizeSchedulePrefs({ shifts }).shifts.length).toBe(LIMITS.shifts)
  })
  it('保留上一版的版本号', () => {
    const prev = { prefVersion: 3, syncedVersion: 3 }
    expect(sanitizeSchedulePrefs({ shifts: [] }, prev).prefVersion).toBe(3)
    expect(sanitizeSchedulePrefs({ shifts: [] }, prev).syncedVersion).toBe(3)
  })
  it('model 字段规整（用户选的新闻采集模型）', () => {
    const p = sanitizeSchedulePrefs({ model: { provider: 'deepseek', model: 'deepseek-chat' } })
    expect(p.model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    // 非法/空 model → null（= 跟随当前活跃会话）
    expect(sanitizeSchedulePrefs({ model: { provider: '', model: 'x' } }).model).toBe(null)
    expect(sanitizeSchedulePrefs({ model: {} }).model).toBe(null)
    expect(sanitizeSchedulePrefs({ model: null }).model).toBe(null)
  })
  it('model 从上一版保留', () => {
    const prev = { model: { provider: 'deepseek', model: 'deepseek-chat' } }
    expect(sanitizeSchedulePrefs({ shifts: [] }, prev).model).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
})

describe('sanitizeModelSelection', () => {
  it('有效选择原样保留', () => {
    expect(sanitizeModelSelection({ provider: ' deepseek ', model: ' deepseek-chat ' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
  it('provider 或 model 缺失 → null', () => {
    expect(sanitizeModelSelection({ provider: 'deepseek' })).toBe(null)
    expect(sanitizeModelSelection({ model: 'deepseek-chat' })).toBe(null)
    expect(sanitizeModelSelection({})).toBe(null)
    expect(sanitizeModelSelection(null)).toBe(null)
    expect(sanitizeModelSelection('x')).toBe(null)
  })
})

describe('runStateAlive（TTL 懒过期）', () => {
  it('未超时存活、超时失效、空值失效', () => {
    const run = { shiftId: 's1', startedAt: 1000 }
    expect(runStateAlive(run, 1000 + LIMITS.runStateTtlMs - 1)).toBe(true)
    expect(runStateAlive(run, 1000 + LIMITS.runStateTtlMs)).toBe(false)
    expect(runStateAlive(null, 1000)).toBe(false)
  })
})

describe('shiftFiresAt（班次到点判断）', () => {
  // 2026-05-30 = 周六，2026-05-31 = 周日，2026-06-01 = 周一，2026-06-05 = 周五
  const SAT = new Date(2026, 4, 30) // 周六 getDay()=6
  const SUN = new Date(2026, 4, 31) // 周日 getDay()=0
  const MON = new Date(2026, 5, 1) // 周一 getDay()=1
  const FRI = new Date(2026, 5, 5) // 周五 getDay()=5
  const CAL = buildCalendar() // 2025/2026 内置工作日历（含法定节假日与调休补班）
  it('普通班次（非仅工作日）每天到点都触发', () => {
    const shift = { time: '08:00', workdaysOnly: false }
    expect(shiftFiresAt(shift, SAT)).toBe(true)
    expect(shiftFiresAt(shift, SUN)).toBe(true)
    expect(shiftFiresAt(shift, MON)).toBe(true)
    expect(shiftFiresAt(shift, FRI)).toBe(true)
  })
  it('仅工作日班次（无日历）：周六/周日跳过，周一至周五触发', () => {
    const shift = { time: '08:00', workdaysOnly: true }
    expect(shiftFiresAt(shift, SAT)).toBe(false)
    expect(shiftFiresAt(shift, SUN)).toBe(false)
    expect(shiftFiresAt(shift, MON)).toBe(true)
    expect(shiftFiresAt(shift, FRI)).toBe(true)
  })
  it('仅工作日班次（带日历）：法定节假日放假不触发，即使落在工作日', () => {
    const shift = { time: '08:00', workdaysOnly: true }
    expect(shiftFiresAt(shift, new Date(2026, 9, 1), CAL)).toBe(false) // 周四·国庆
    expect(shiftFiresAt(shift, new Date(2026, 9, 2), CAL)).toBe(false) // 周五·国庆
    expect(shiftFiresAt(shift, new Date(2026, 8, 25), CAL)).toBe(false) // 周五·中秋
  })
  it('仅工作日班次（带日历）：周末调休补班视为工作日照常触发', () => {
    const shift = { time: '08:00', workdaysOnly: true }
    expect(shiftFiresAt(shift, new Date(2026, 9, 10), CAL)).toBe(true) // 周六·国庆补班
    expect(shiftFiresAt(shift, new Date(2026, 8, 20), CAL)).toBe(true) // 周日·国庆补班
  })
  it('仅工作日班次（带日历）：普通工作日触发、普通周末跳过', () => {
    const shift = { time: '08:00', workdaysOnly: true }
    expect(shiftFiresAt(shift, new Date(2026, 9, 12), CAL)).toBe(true) // 周一
    expect(shiftFiresAt(shift, new Date(2026, 9, 11), CAL)).toBe(false) // 周日
  })
  it('旧数据（无 workdaysOnly 字段）按普通班次每天触发', () => {
    const shift = { time: '08:00' }
    expect(shiftFiresAt(shift, SAT)).toBe(true)
  })
  it('无效班次返回 false（不触发）', () => {
    expect(shiftFiresAt(null, MON)).toBe(false)
    expect(shiftFiresAt(undefined, MON)).toBe(false)
    expect(shiftFiresAt('x', MON)).toBe(false)
  })
})

describe('PRESET_CATEGORIES', () => {
  it('热点排第一', () => {
    expect(PRESET_CATEGORIES[0]).toBe('热点')
    expect(PRESET_CATEGORIES).toContain('国内')
  })
})
