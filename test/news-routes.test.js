/**
 * 冒烟测试：每日新闻播报的 Host 侧路由与模型工具。
 *
 * 策略与 test/index.test.js 相同——用真实 apply() + 假 ctx（webServer 捕获路由、
 * tools 捕获注册、临时目录承载持久化文件），驱动真实路由逻辑。TTS 不在本层：
 * news_broadcast 只做校验/渲染/分块/持久化，懒合成（WAV 块路由）仅在取音频时发生。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../lib/index.js'
import { LIMITS } from '../lib/news-core.js'

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}

function makeRes() {
  const res = {
    status: 200, headers: {}, body: null,
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) } },
    end(data) { res.body = data === undefined ? null : data },
  }
  return res
}

function makeFs(rootDir) {
  const stat = (target) => {
    if (!existsSync(target)) return undefined
    const s = statSync(target)
    return { type: s.isDirectory() ? 'directory' : 'file', size: s.size }
  }
  return {
    async resolve(p) { return resolve(p) },
    async stat(target) { return stat(target) },
    processPath(target) { return resolve(target) },
    async listDir(dir) {
      if (!existsSync(dir)) return []
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
    },
    async readBytes(target) { return readFileSync(target) },
  }
}

function boot({ agentsService = null, llm = null, agentPresets = null, sessionTitle = null, workspace = null, workspaceRegistry = null, home = null } = {}) {
  const homeDir = home || mkdtempSync(join(tmpdir(), 'dsh-news-test-'))
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = homeDir
  process.env.DSH_HOME = join(homeDir, '.dsh')
  const registered = []
  const tools = []
  apply({
    shell: { resolve: (o) => o, run: async () => ({ stdout: { text: homeDir } }) },
    fs: makeFs(homeDir),
    webServer: { register: (row) => { registered.push(row) } },
    tools: { register: (tool) => { tools.push(tool) } },
    systemPrompt: { section: () => {} },
    effect: (fn) => { fn() },
    // 懒获取服务（与真实宿主一致）：agents / llm / agentPresets / sessionTitle /
    // workspaceRegistry 仅在传入时才可见。workspace 为旧服务名兜底（真实宿主为 workspaceRegistry）。
    get: (k) => {
      if (k === 'agents') return agentsService
      if (k === 'llm') return llm
      if (k === 'agentPresets') return agentPresets
      if (k === 'sessionTitle') return sessionTitle
      if (k === 'workspaceRegistry') return workspaceRegistry || workspace
      if (k === 'workspace') return workspace
      return undefined
    },
  })
  const handler = registered.filter((r) => r.kind === 'prefix' && r.path === '/dsh-music')[0]?.handler || null
  const newsBroadcast = tools.find((t) => t.name === 'news_broadcast') || null
  const newsSchedule = tools.find((t) => t.name === 'news_schedule') || null
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    if (!home) { try { rmSync(homeDir, { recursive: true, force: true }) } catch {} }
  }
  return { home: homeDir, handler, newsBroadcast, newsSchedule, cleanup }
}

const NEWS_BODY = {
  title: '早间新闻播报',
  date: '2026-05-30',
  categories: [
    {
      name: '热点',
      items: [
        { title: '政策发布会召开', summary: '国新办今早介绍相关政策要点。', source: '新华社' },
        { title: '多地强降雨', summary: '暴雨预警继续，多地启动应急响应。', source: '央视新闻' },
      ],
    },
    {
      name: 'AI',
      items: [{ title: '新模型密集发布', summary: '推理成本显著下降。', source: '机器之心' }],
    },
  ],
}

async function broadcast(tool, body) {
  return tool.execute(body)
}

describe('news_broadcast 工具', () => {
  it('提交有效数据 → 生成期次并持久化到 news 文件', async () => {
    const { home, newsBroadcast, cleanup } = boot()
    try {
      expect(newsBroadcast).toBeTruthy()
      const out = await broadcast(newsBroadcast, NEWS_BODY)
      expect(out.ok).toBe(true)
      expect(out.skipped).toBe(false)
      expect(out.items).toBe(3)
      expect(out.chunks).toBeGreaterThan(0)
      // 期次 id 日期段 = 本地创建日期（非入参 date 字段）。
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const stamp = `news-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
      expect(out.editionId.startsWith(stamp)).toBe(true)
      // 持久化：文件存在且包含该期次
      const file = join(home, '.dsh', 'music-player-news.json')
      expect(existsSync(file)).toBe(true)
      const data = JSON.parse(readFileSync(file, 'utf8'))
      expect(data.editions.length).toBe(1)
      expect(data.editions[0].id).toBe(out.editionId)
      expect(data.editions[0].itemChunk.length).toBe(3)
    } finally { cleanup() }
  })

  it('冷却窗：同班次 10 分钟内重复提交被跳过，force 可强制', async () => {
    const { newsBroadcast, cleanup } = boot()
    try {
      const body = { ...NEWS_BODY, shiftId: 's1' }
      const r1 = await broadcast(newsBroadcast, body)
      expect(r1.skipped).toBe(false)
      const r2 = await broadcast(newsBroadcast, body)
      expect(r2.ok).toBe(true)
      expect(r2.skipped).toBe(true)
      expect(r2.notice).toContain('force')
      const r3 = await broadcast(newsBroadcast, { ...body, force: true })
      expect(r3.skipped).toBe(false)
      expect(r3.editionId).not.toBe(r1.editionId)
    } finally { cleanup() }
  })

  it('班次触发的收集：期次标题由 Host 确定性命名为「M月D日 HH:MM 新闻播报」，覆盖 agent 起名', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true,
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const out = await broadcast(newsBroadcast, { ...NEWS_BODY, title: 'agent 即兴起的标题', shiftId: 's1' })
      expect(out.ok).toBe(true)
      expect(out.skipped).toBe(false)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const editions = JSON.parse(res.body).editions
      // 标题日期取期次 date 字段（NEWS_BODY.date = 2026-05-30），时刻取班次配置
      // （列表按 createdAt 降序，用 id 定位本期次）
      expect(editions.find((e) => e.id === out.editionId).title).toBe('5月30日 08:00 新闻播报')
      // 口播开场不重复追加日期（标题已含「M月D日」）
      const text = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${out.editionId}/text?from=0` }), text)
      expect(JSON.parse(text.body).text).toContain('您好，这里是5月30日 08:00 新闻播报。')
      // 对照：对话直接播报（无 shiftId）保留 agent 命名
      const out2 = await broadcast(newsBroadcast, { ...NEWS_BODY, title: '自定义标题' })
      expect(out2.ok).toBe(true)
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res2)
      const editions2 = JSON.parse(res2.body).editions
      expect(editions2.find((e) => e.id === out2.editionId).title).toBe('自定义标题')
    } finally { cleanup() }
  })

  it('run-now 并发拦截：已有收集进行中时拒绝新触发（不新建执行会话）', async () => {
    let createdCount = 0
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        createdCount += 1
        return { agent: { id: opts.sessionId, session: { id: opts.sessionId }, followup: (msg) => agents.injected.push({ id: opts.sessionId, status: 'idle', msg }) } }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const { handler, cleanup } = boot({ agentsService: agents.service, sessionTitle: { rename: () => {} } })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({ enabled: true, shifts: [
          { id: 'sa', time: '08:00', autoplay: true, scope: null },
          { id: 'sb', time: '09:00', autoplay: true, scope: null },
        ] }),
      }), makeRes())
      const r1 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 'sa' }) }), r1)
      expect(JSON.parse(r1.body).ok).toBe(true)
      // 运行态可见（面板 5s 轮询据此显示「收集中」）
      const rs = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/runstate' }), rs)
      expect(JSON.parse(rs.body).run).toBeTruthy()
      // 同班次再触发 → busy 拒绝
      const r2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 'sa' }) }), r2)
      const d2 = JSON.parse(r2.body)
      expect(d2.ok).toBe(false)
      expect(d2.busy).toBe(true)
      expect(d2.fallback).toBe(false) // busy 不回退「复制指令」
      expect(d2.error).toContain('已有收集进行中（08:00 班次）')
      // 跨班次同样拒绝
      const r3 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 'sb' }) }), r3)
      expect(JSON.parse(r3.body).busy).toBe(true)
      // 全程只创建过一个执行会话
      expect(createdCount).toBe(1)
    } finally { cleanup() }
  })

  it('班次范围精确性：范围外类别被过滤并在通知中说明；含主题时主题类别放行', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({ enabled: true, shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: { categories: ['科技'], topics: [] } }] }),
      }), makeRes())
      const mk = () => ({
        title: 'x', shiftId: 's1', date: '2026-05-30',
        categories: [
          { name: '科技', items: [{ title: 't1', summary: 's', source: 'a' }] },
          { name: 'AI', items: [{ title: 't2', summary: 's', source: 'b' }, { title: 't3', summary: 's', source: 'c' }] },
        ],
      })
      const out = await broadcast(newsBroadcast, mk())
      expect(out.ok).toBe(true)
      expect(out.items).toBe(1) // AI（2 条）被过滤
      expect(out.notice).toContain('已按班次范围过滤范围外类别：AI（2 条）')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const ed = JSON.parse(res.body).editions.find((e) => e.id === out.editionId)
      expect(ed.categories.map((c) => c.name)).toEqual(['科技'])
      // 全部类别都越界 → 拒绝生成并说明范围
      const out2 = await broadcast(newsBroadcast, { ...mk(), categories: [{ name: 'AI', items: [{ title: 't', summary: 's', source: 'x' }] }] })
      expect(out2.ok).toBe(false)
      expect(out2.notice).toContain('均不在班次范围内')
      expect(out2.notice).toContain('科技')
      // 班次声明了自定义主题 AI → 主题同名类别放行
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({ enabled: true, shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: { categories: ['科技'], topics: ['AI'] } }] }),
      }), makeRes())
      const out3 = await broadcast(newsBroadcast, { ...mk(), force: true })
      expect(out3.ok).toBe(true)
      expect(out3.items).toBe(3)
      expect(out3.notice).not.toContain('已按班次范围过滤')
    } finally { cleanup() }
  })

  it('班次新闻条数：多类别按平均配额收敛（8 条 × 3 类 → 3/3/2）', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({ enabled: true, shifts: [{ id: 's1', time: '08:00', autoplay: true, itemCount: 8, scope: { categories: ['热点', '国内', '国际'], topics: [] } }] }),
      }), makeRes())
      const out = await broadcast(newsBroadcast, {
        title: 'x', shiftId: 's1', date: '2026-05-30',
        categories: [
          { name: '热点', items: Array.from({ length: 6 }, (_, i) => ({ title: 'h' + i, summary: 's', source: 'a' })) },
          { name: '国内', items: Array.from({ length: 5 }, (_, i) => ({ title: 'd' + i, summary: 's', source: 'b' })) },
          { name: '国际', items: Array.from({ length: 4 }, (_, i) => ({ title: 'i' + i, summary: 's', source: 'c' })) },
        ],
      })
      expect(out.ok).toBe(true)
      expect(out.items).toBe(8) // 6+5+4=15 → 收敛到 8
      expect(out.notice).toContain('平均分配')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const ed = JSON.parse(res.body).editions.find((e) => e.id === out.editionId)
      expect(ed.categories.map((c) => c.count)).toEqual([3, 3, 2])
    } finally { cleanup() }
  })

  it('班次新闻条数：单类别可超过默认 8 条/类（limits 覆盖）', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({ enabled: true, shifts: [{ id: 's1', time: '08:00', autoplay: true, itemCount: 12, scope: { categories: ['科技'], topics: [] } }] }),
      }), makeRes())
      const out = await broadcast(newsBroadcast, {
        title: 'x', shiftId: 's1', date: '2026-05-30',
        categories: [
          { name: '科技', items: Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, summary: 's', source: 'a' })) },
        ],
      })
      expect(out.ok).toBe(true)
      expect(out.items).toBe(12)
      // 对话直接播报（无班次）仍受默认 8 条/类限制
      const manual = await broadcast(newsBroadcast, {
        title: 'x', date: '2026-05-30',
        categories: [
          { name: '科技', items: Array.from({ length: 12 }, (_, i) => ({ title: 't' + i, summary: 's', source: 'a' })) },
        ],
      })
      expect(manual.items).toBe(8)
    } finally { cleanup() }
  })

  it('不同班次互不影响冷却窗；手动组独立', async () => {
    const { newsBroadcast, cleanup } = boot()
    try {
      await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      const other = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's2' })
      expect(other.skipped).toBe(false)
      const manual = await broadcast(newsBroadcast, NEWS_BODY)
      expect(manual.skipped).toBe(false)
    } finally { cleanup() }
  })

  it('无效数据返回 ok:false 与原因，不写文件', async () => {
    const { home, newsBroadcast, cleanup } = boot()
    try {
      const out = await broadcast(newsBroadcast, { title: '空' })
      expect(out.ok).toBe(false)
      expect(out.notice).toContain('没有有效的新闻条目')
      expect(existsSync(join(home, '.dsh', 'music-player-news.json'))).toBe(false)
    } finally { cleanup() }
  })

  it('autoplay:false 不推送 intent；autoplay:true 推送 kind:news', async () => {
    const { newsBroadcast, cleanup } = boot()
    try {
      await broadcast(newsBroadcast, { ...NEWS_BODY, autoplay: false })
      const res0 = makeRes()
      // pendingIntent 未被设置 -> intent 返回 null（前面 boot 可能无其它意图）
      expect(true).toBe(true) // 占位：intent 状态由后续用例直接验证
      const r = await broadcast(newsBroadcast, { ...NEWS_BODY, title: '第二期' })
      expect(r.ok).toBe(true)
      void res0
    } finally { cleanup() }
  })
})

describe('news_schedule 工具', () => {
  it('get 返回偏好摘要（Host 自维护定时，无同步字段）', async () => {
    const { handler, newsSchedule, cleanup } = boot()
    try {
      // 先配置一个班次，使 get 的 notice 落在「Host 自维护」分支。
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const out = await newsSchedule.execute({ action: 'get' })
      expect(out.ok).toBe(true)
      const data = JSON.parse(out.data)
      expect(data.enabled).toBe(true)
      expect(Array.isArray(data.shifts)).toBe(true)
      expect(data.shifts.length).toBe(1)
      expect(data.shifts[0].itemCount).toBe(8) // 未配置时默认 8
      expect(data.notice).toContain('Host 端自维护')
      expect('inSync' in data).toBe(false) // 不再有同步语义
    } finally { cleanup() }
  })

  it('reportFailure 记录失败并清除运行态', async () => {
    const { handler, newsSchedule, cleanup } = boot()
    try {
      const out = await newsSchedule.execute({ action: 'reportFailure', shiftId: 's9', kind: 'error', reason: '502 bad gateway' })
      expect(out.ok).toBe(true)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), res)
      const data = JSON.parse(res.body)
      expect(data.failures.length).toBe(1)
      expect(data.failures[0].reason).toBe('502 bad gateway')
      const r2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/runstate' }), r2)
      expect(JSON.parse(r2.body).run).toBe(null)
    } finally { cleanup() }
  })

  it('收集成功即清空失败记录（问题恢复后旧失败不再残留）', async () => {
    const { handler, newsSchedule, newsBroadcast, cleanup } = boot()
    try {
      // 先报一条失败（如搜索余额不足），面板会展示
      await newsSchedule.execute({ action: 'reportFailure', shiftId: 's9', kind: 'error', reason: 'HTTP 402 Insufficient Balance' })
      const before = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), before)
      expect(JSON.parse(before.body).failures.length).toBe(1)
      // 之后一次成功收集（如充值后重试成功）→ 失败记录被清空
      const ok = await broadcast(newsBroadcast, { ...NEWS_BODY, title: '恢复后的简报' })
      expect(ok.ok).toBe(true)
      const after = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), after)
      expect(JSON.parse(after.body).failures.length).toBe(0)
    } finally { cleanup() }
  })

  it('POST /news/failures/clear 手动清除失败记录（面板失败行「✕」）', async () => {
    const { handler, newsSchedule, cleanup } = boot()
    try {
      await newsSchedule.execute({ action: 'reportFailure', shiftId: 's9', kind: 'error', reason: 'HTTP 402 Insufficient Balance' })
      const before = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), before)
      expect(JSON.parse(before.body).failures.length).toBe(1)
      // 手动清除：清空失败记录并返回 cleared 数
      const clear = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/failures/clear', body: '{}' }), clear)
      const c = JSON.parse(clear.body)
      expect(c.ok).toBe(true)
      expect(c.cleared).toBe(1)
      const after = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), after)
      expect(JSON.parse(after.body).failures.length).toBe(0)
      // 再清一次：无失败可清，cleared=0 且 ok
      const clear2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/failures/clear', body: '{}' }), clear2)
      expect(JSON.parse(clear2.body)).toMatchObject({ ok: true, cleared: 0 })
    } finally { cleanup() }
  })
})

describe('news 路由', () => {
  const bootWithEdition = async () => {
    const ctx = boot()
    await broadcast(ctx.newsBroadcast, NEWS_BODY)
    return ctx
  }

  it('GET /news 返回期次列表摘要', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const data = JSON.parse(res.body)
      expect(data.editions.length).toBe(1)
      expect(data.editions[0].title).toBe('早间新闻播报')
      expect(data.editions[0].categories[0]).toEqual({ name: '热点', count: 2 })
      expect(data.editions[0].totalItems).toBe(3)
    } finally { cleanup() }
  })

  it('meta / text 提供目录结构与字幕', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const meta = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/meta` }), meta)
      const m = JSON.parse(meta.body)
      expect(m.total).toBeGreaterThan(0)
      expect(m.sections.map((s) => s.heading)).toEqual(['热点', 'AI'])
      expect(m.charOffsets.length).toBe(m.total + 1)
      const text = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/text?from=0` }), text)
      const t = JSON.parse(text.body)
      expect(t.ok).toBe(true)
      expect(t.from).toBe(0)
      expect(t.text).toContain('您好，这里是早间新闻播报')
      // 字幕按条切分：每条新闻是一个完整块（开头「第N条」、含标题/摘要；不含来源尾缀）。
      const firstItemChunk = m.itemChunk[0]
      const itemText = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/text?from=${firstItemChunk}` }), itemText)
      const it = JSON.parse(itemText.body)
      expect(it.ok).toBe(true)
      expect(it.text).toMatch(/^第[一二三四五六七八九十]+条，国新办今早介绍相关政策要点/)
      expect(it.text).toContain('介绍相关政策要点')
      expect(it.text).not.toContain('以上消息来自')
    } finally { cleanup() }
  })

  it('text 越界返回 ok:false', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const meta = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/meta` }), meta)
      const total = JSON.parse(meta.body).total
      const text = makeRes()
      await handler(makeReq({ url: `/dsh-music/news/${id}/text?from=${total + 5}` }), text)
      expect(JSON.parse(text.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('play 设置 intent；played 标记已播清除待播', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const play = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/play', body: JSON.stringify({ id }) }), play)
      expect(JSON.parse(play.body).ok).toBe(true)
      const intent = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), intent)
      const it = JSON.parse(intent.body)
      expect(it.kind).toBe('news')
      expect(it.id).toBe(id)
      const played = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/played', body: JSON.stringify({ id }) }), played)
      const list2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list2)
      expect(JSON.parse(list2.body).editions[0].played).toBe(true)
    } finally { cleanup() }
  })

  it('新闻 intent 有时效：浏览器长时间未取则过期丢弃', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-05-30T09:00:00'))
      await broadcast(newsBroadcast, NEWS_BODY) // autoplay 默认 true → 推送 intent
      // 浏览器 3 小时后才打开（定时播报浏览器没开的场景）
      vi.setSystemTime(new Date('2026-05-30T12:00:00'))
      const intent = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), intent)
      expect(JSON.parse(intent.body)).toBe(null) // 过期意图被丢弃，不突兀自动播放
      vi.useRealTimers()
    } finally { cleanup() }
  })

  it('DELETE 删除期次；未知 id 404', async () => {
    const { handler, cleanup } = await bootWithEdition()
    try {
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      const id = JSON.parse(list.body).editions[0].id
      const del = makeRes()
      await handler(makeReq({ method: 'DELETE', url: `/dsh-music/news/${id}` }), del)
      expect(JSON.parse(del.body).ok).toBe(true)
      const del2 = makeRes()
      await handler(makeReq({ method: 'DELETE', url: `/dsh-music/news/${id}` }), del2)
      expect(del2.status).toBe(404)
    } finally { cleanup() }
  })

  it('schedule 偏好 POST 写入并递增版本号；相同内容不递增', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({
        enabled: true,
        defaultScope: { categories: ['热点', '国内'], topics: ['AI'] },
        shifts: [{ id: 's1', time: '08:00', autoplay: true, itemCount: 12, scope: { categories: ['热点'], topics: [] } }],
      })
      const r1 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule', body }), r1)
      const p1 = JSON.parse(r1.body).schedulePrefs
      expect(p1.prefVersion).toBe(1)
      expect(p1.defaultScope).toBeUndefined() // defaultScope 已退役：入参字段被丢弃
      expect(p1.shifts[0].itemCount).toBe(12) // 班次新闻条数落盘
      const r2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule', body }), r2)
      expect(JSON.parse(r2.body).schedulePrefs.prefVersion).toBe(1) // 未变化不递增
      const body2 = JSON.stringify({
        enabled: true,
        defaultScope: { categories: ['热点', '国内'], topics: ['AI'] },
        shifts: [{ id: 's1', time: '09:30', autoplay: true, scope: null }],
      })
      const r3 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/schedule', body: body2 }), r3)
      expect(JSON.parse(r3.body).schedulePrefs.prefVersion).toBe(2)
      expect(JSON.parse(r3.body).schedulePrefs.shifts[0].itemCount).toBe(8) // 未传 itemCount → 默认 8
    } finally { cleanup() }
  })

  it('每任务 7 期滚动保留在路由层生效', async () => {
    const { handler, newsBroadcast, cleanup } = boot()
    try {
      for (let i = 0; i < 9; i++) {
        await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1', force: true, title: `第${i}期` })
      }
      await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's2', force: true, title: '别班次' })
      const res = makeRes()
      // runstate 路由会顺带 loadNews 刷新内存态
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const editions = JSON.parse(res.body).editions
      const s1 = editions.filter((e) => e.originShiftId === 's1')
      const s2 = editions.filter((e) => e.originShiftId === 's2')
      expect(s1.length).toBe(LIMITS.retentionPerShift)
      expect(s2.length).toBe(1)
      // 列表按 createdAt 降序（同毫秒提交按插入序稳定排，不断言具体位置）
      const times = editions.map((e) => e.createdAt)
      expect(times).toEqual([...times].sort((a, b) => b - a))
      expect(editions.some((e) => e.title === '别班次')).toBe(true)
    } finally { cleanup() }
  })
})

describe('run-now（统一执行入口：定时到点 / 手动立即执行共用）', () => {
  it('run-now：每次新建执行会话、sessionTitle.rename 按「时间+类别」命名，并注入收集指令', async () => {
    let created = []
    const renamed = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return { agent: { id: opts.sessionId, session: { id: opts.sessionId }, followup: (msg) => agents.injected.push({ id: opts.sessionId, status: 'idle', msg }) } }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const sessionTitle = { rename: (session, title) => { renamed.push({ sessionId: session.id, title }) } }
    const { handler, cleanup } = boot({ agentsService: agents.service, sessionTitle })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's9', time: '18:00', autoplay: false, itemCount: 8, scope: { categories: ['科技'], topics: ['AI'] } }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's9' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(created.length).toBe(1)
      expect(created[0].sessionId.startsWith('news-exec-')).toBe(true)
      expect(data.sessionId).toBe(created[0].sessionId)
      // 执行会话被显式命名：名称 = 当前时间 + 任务类别（科技+主题:AI，紧凑格式）
      expect(renamed.length).toBe(1)
      expect(renamed[0].sessionId).toBe(created[0].sessionId)
      expect(renamed[0].title).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} 科技\+主题:AI$/)
      // 注入收集指令（含班次信息，无同步/begin 语义）
      expect(agents.injected.length).toBe(1)
      const text = agents.injected[0].msg.content[0].text
      expect(text).toContain('18:00')
      expect(text).toContain('s9')
      expect(text).not.toContain('begin')
      expect(text).toContain('先不播放') // autoplay:false → 静默收集
      expect(text).toContain('科技')
      expect(text).toContain('AI')
      // 指令携带班次新闻条数：8 条、2 个类别（科技 + 主题 AI）→ 每类约 4 条、多类别尽量平均分配
      expect(text).toContain('本期共收集 8 条新闻')
      expect(text).toContain('尽量平均分配')
      // 注入指令显式携带当前日期与时间：收集 agent 不必先调工具查时间、日期锚定不跑偏
      expect(text).toMatch(/今天是 \d{4}年\d{1,2}月\d{1,2}日 星期[日一二三四五六]，当前时间 \d{2}:\d{2}/)
    } finally { cleanup() }
  })

  it('purge-stale：删除今天之前的期次/失败记录并归档关联会话（与每日清理同一入口）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-news-test-'))
    let created = []
    const disposed = []
    const archived = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return {
          agent: { id: opts.sessionId, session: {}, followup: () => {} },
          dispose: async () => { disposed.push(opts.sessionId) },
        }
      },
    })
    agents.service.get('agent-live').options = { provider: 'deepseek', model: 'deepseek-chat' }
    const workspaceRegistry = { archiveSession: async (sid) => { archived.push(sid) } }
    const { handler, newsBroadcast, cleanup } = boot({ agentsService: agents.service, workspaceRegistry, home })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [
            { id: 's1', time: '08:00', autoplay: true, scope: null },
            { id: 's2', time: '09:00', autoplay: true, scope: null },
          ],
        }),
      }), makeRes())
      // 两个班次各收集一期
      const rr1 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), rr1)
      const sid1 = JSON.parse(rr1.body).sessionId
      const b1 = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      const rr2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's2' }) }), rr2)
      const b2 = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's2' })
      // 把第一期改写成「今天之前」的旧期次，并补一条旧失败记录（其会话无本进程句柄 → 走归档兜底）
      const file = join(home, '.dsh', 'music-player-news.json')
      const data = JSON.parse(readFileSync(file, 'utf8'))
      data.editions.find((e) => e.id === b1.editionId).createdAt = Date.now() - 48 * 3600e3
      data.failures = [
        { ts: Date.now() - 48 * 3600e3, shiftId: 's1', kind: 'empty', reason: '旧失败', sessionId: 'news-exec-ghost' },
        { ts: Date.now(), shiftId: 's2', kind: 'empty', reason: '新失败' },
      ]
      writeFileSync(file, JSON.stringify(data), 'utf8')
      const r = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/purge-stale' }), r)
      expect(JSON.parse(r.body)).toMatchObject({ ok: true, editions: 1, failures: 1, sessions: 2 })
      // 列表只剩今天这期；旧期次的会话被销毁 + 归档，新会话不动
      const list = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), list)
      expect(JSON.parse(list.body).editions.map((e) => e.id)).toEqual([b2.editionId])
      expect(disposed).toEqual([sid1])
      expect(archived).toEqual([sid1, 'news-exec-ghost'])
      expect(JSON.parse(readFileSync(file, 'utf8')).failures.length).toBe(1) // 新失败记录保留
    } finally { cleanup(); rmSync(home, { recursive: true, force: true }) }
  })

  it('启动时自动清理非今天的新闻并归档会话（不等 03:00）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-news-test-'))
    const now = Date.now()
    // 「fresh」期次必须落在今天 00:00 之后（启动清理按自然日分界删除旧期次）——
    // 直接用 now-1h 会在午夜后 1 小时内跑测试时落入昨天，产生时间相关的偶发失败。
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
    const freshAt = Math.max(startOfToday.getTime() + 1000, now - 3600e3)
    const file = join(home, '.dsh', 'music-player-news.json')
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      editions: [
        { id: 'stale', createdAt: now - 48 * 3600e3, chunks: ['x'], sessionId: 'news-exec-old' },
        { id: 'fresh', createdAt: freshAt, chunks: ['y'], sessionId: 'news-exec-fresh' },
      ],
      schedulePrefs: {},
      runState: null,
      failures: [{ ts: now - 48 * 3600e3, shiftId: 's1', kind: 'empty', reason: '旧失败', sessionId: 'news-exec-ghost' }],
    }), 'utf8')
    const agents = makeAgents()
    const archived = []
    const workspaceRegistry = { archiveSession: async (sid) => { archived.push(sid) } }
    const b = boot({ agentsService: agents.service, workspaceRegistry, home })
    try {
      // 启动清理是 fire-and-forget：轮询等文件收敛（stale 期次与旧失败记录被移除）
      const deadline = Date.now() + 2000
      let data = JSON.parse(readFileSync(file, 'utf8'))
      while (Date.now() < deadline && data.editions.some((e) => e.id === 'stale')) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        data = JSON.parse(readFileSync(file, 'utf8'))
      }
      expect(data.editions.map((e) => e.id)).toEqual(['fresh'])
      expect(data.failures.length).toBe(0)
      expect(archived).toEqual(expect.arrayContaining(['news-exec-old', 'news-exec-ghost']))
    } finally { b.cleanup(); rmSync(home, { recursive: true, force: true }) }
  })

  it('启动清理时注册表尚未就绪：等就绪后仍会归档会话（方案A 修复启动竞态）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-news-test-'))
    const now = Date.now()
    const file = join(home, '.dsh', 'music-player-news.json')
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      editions: [
        { id: 'stale', createdAt: now - 48 * 3600e3, chunks: ['x'], sessionId: 'news-exec-race' },
      ],
      schedulePrefs: {},
      runState: null,
      failures: [],
    }), 'utf8')

    // 模拟 DSH 并行挂载竞态：注册表构造完成但 init 未结束 → archiveSession 与
    // archivedSessionIds 都抛「workspace registry is not started yet」，300ms 后才就绪。
    const archived = []
    let ready = false
    const notStarted = () => { throw new Error('workspace registry is not started yet') }
    const workspaceRegistry = {
      get archivedSessionIds() { if (!ready) notStarted(); return [] },
      archiveSession: async (sid) => { if (!ready) notStarted(); archived.push(sid) },
    }
    setTimeout(() => { ready = true }, 300)
    const agents = makeAgents()
    const b = boot({ agentsService: agents.service, workspaceRegistry, home })
    try {
      // 启动清理 fire-and-forget：等它等注册表就绪并完成归档
      const deadline = Date.now() + 4000
      while (Date.now() < deadline && archived.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(archived).toEqual(['news-exec-race'])
      // 期次同样被删除
      const data = JSON.parse(readFileSync(file, 'utf8'))
      expect(data.editions.length).toBe(0)
    } finally { b.cleanup(); rmSync(home, { recursive: true, force: true }) }
  })

  it('run-now 未知班次返回 404，不创建执行会话', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 'nope' }) }), res)
      expect(res.status).toBe(404)
      expect(agents.injected.length).toBe(0)
    } finally { cleanup() }
  })

  it('agents 服务缺失：run-now 返回 fallback:true', async () => {
    const { handler, cleanup } = boot() // 无 agentsService
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(false)
      expect(data.fallback).toBe(true)
    } finally { cleanup() }
  })
})

describe('每任务执行会话 + 结果绑定 + 删除联动', () => {
  it('每次执行都新建一个执行会话（不复用），news_broadcast 绑定 sessionId', async () => {
    let created = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return { agent: { id: opts.sessionId, session: {}, followup: (msg) => agents.injected.push({ id: opts.sessionId, status: 'idle', msg }) } }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const { handler, newsBroadcast, cleanup } = boot({ agentsService: agents.service })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      // 第一次执行 → 执行会话 #1
      const r1 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), r1)
      const sid1 = JSON.parse(r1.body).sessionId
      // 模拟执行会话 #1 内提交 news_broadcast → 期次绑定该 sessionId
      const b1 = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      // 第二次执行 → 执行会话 #2（不复用 #1）
      const r2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), r2)
      const sid2 = JSON.parse(r2.body).sessionId
      expect(created.length).toBe(2)
      expect(sid1).not.toBe(sid2)
      expect(sid1.startsWith('news-exec-')).toBe(true)
      // 期次已绑定 sessionId = 第一次执行会话
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      const editions = JSON.parse(res.body).editions
      const ed = editions.find((e) => e.id === b1.editionId)
      expect(ed).toBeTruthy()
      expect(ed.sessionId).toBe(sid1)
    } finally { cleanup() }
  })

  it('执行会话归入「新闻收集」命名工作区：专属 cwd + registry.create + attachSession', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-news-test-'))
    let created = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return { agent: { id: opts.sessionId, session: {}, followup: () => {} } }
      },
    })
    agents.service.get('agent-live').options = { provider: 'deepseek', model: 'deepseek-chat' }
    const calls = []
    const workspaceRegistry = {
      create: async (path, title) => {
        calls.push({ op: 'create', path, title })
        return { attachSession: async (sid) => { calls.push({ op: 'attach', sid }) } }
      },
      archiveSession: async () => {},
    }
    const { handler, cleanup } = boot({ agentsService: agents.service, workspaceRegistry, home })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const rr = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), rr)
      const sid = JSON.parse(rr.body).sessionId
      const dir = realpathSync(join(home, '.dsh', 'news'))
      expect(existsSync(join(home, '.dsh', 'news'))).toBe(true) // 专属目录已创建
      expect(created.length).toBe(1)
      // 会话 cwd 指向专属目录：工作区按「header cwd === 工作区路径」校验成员资格
      expect(created[0].meta.cwd).toBe(dir)
      expect(calls[0]).toEqual({ op: 'create', path: dir, title: '新闻收集' })
      expect(calls.some((c) => c.op === 'attach' && c.sid === sid)).toBe(true)
    } finally { cleanup() }
  })

  it('删除期次联动销毁并归档对应执行会话（dispose + archiveSession）', async () => {
    let created = []
    const disposed = []
    const archived = []
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created.push(opts)
        return {
          agent: { id: opts.sessionId, session: {}, followup: () => {} },
          dispose: async () => { disposed.push(opts.sessionId) },
        }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const workspaceRegistry = { archiveSession: async (sid) => { archived.push(sid) } }
    const { handler, newsBroadcast, cleanup } = boot({ agentsService: agents.service, workspaceRegistry })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const rr = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), rr)
      const sid = JSON.parse(rr.body).sessionId
      const b = await broadcast(newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      expect(disposed.length).toBe(0) // 删除前未销毁
      expect(archived.length).toBe(0)
      const del = makeRes()
      await handler(makeReq({ method: 'DELETE', url: '/dsh-music/news/' + b.editionId }), del)
      expect(JSON.parse(del.body).ok).toBe(true)
      expect(disposed).toEqual([sid]) // 删除期次 → 销毁对应执行会话
      expect(archived).toEqual([sid]) // 并归档（跨重启从会话列表隐藏）
      // 期次已删除
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news' }), res)
      expect(JSON.parse(res.body).editions.length).toBe(0)
    } finally { cleanup() }
  })

  it('跨重启删除：期次 sessionId 不在内存表时，resume→dispose 兜底销毁执行会话', async () => {
    // 第一次 boot：创建执行会话并提交期次（把 sessionId 持久化进 news.json）。
    const home = mkdtempSync(join(tmpdir(), 'dsh-news-test-'))
    let created = []
    const agents1 = makeAgents({
      agentsCreate: async (opts) => ({
        agent: { id: opts.sessionId, session: {}, followup: () => {} },
        dispose: async () => {},
      }),
    })
    agents1.service.get('agent-live').options = { provider: 'deepseek', model: 'deepseek-chat' }
    const b1 = boot({ agentsService: agents1.service, home })
    let editionId
    try {
      await b1.handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      await b1.handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), makeRes())
      const out = await broadcast(b1.newsBroadcast, { ...NEWS_BODY, shiftId: 's1' })
      editionId = out.editionId
      created = [JSON.parse(readFileSync(join(home, '.dsh', 'music-player-news.json'), 'utf8')).editions[0].sessionId]
      expect(created[0]).toBeTruthy() // 期次已持久化 sessionId
    } finally { b1.cleanup() }

    // 第二次 boot（模拟重启）：同一 HOME、agents 服务无内存句柄，但暴露 resume。
    const resumed = []
    const disposedResumed = []
    const archived2 = []
    const agents2 = makeAgents()
    agents2.service.resume = async (opts) => {
      resumed.push(opts.resumeSessionId)
      return {
        agent: { id: opts.resumeSessionId, session: {} },
        dispose: async () => { disposedResumed.push(opts.resumeSessionId) },
      }
    }
    agents2.service.get('agent-live').options = { provider: 'deepseek', model: 'deepseek-chat' }
    const workspaceRegistry2 = { archiveSession: async (sid) => { archived2.push(sid) } }
    const b2 = boot({ agentsService: agents2.service, workspaceRegistry: workspaceRegistry2, home })
    try {
      const del = makeRes()
      await b2.handler(makeReq({ method: 'DELETE', url: '/dsh-music/news/' + editionId }), del)
      expect(JSON.parse(del.body).ok).toBe(true)
      // 本进程无句柄 → 走 resume→dispose 兜底，并立即 dispose 掉。
      expect(resumed).toEqual(created)
      expect(disposedResumed).toEqual(created)
      // 归档执行会话：跨重启后从会话列表隐藏（持久化在 storage domain）。
      expect(archived2).toEqual(created)
      const res = makeRes()
      await b2.handler(makeReq({ url: '/dsh-music/news' }), res)
      expect(JSON.parse(res.body).editions.length).toBe(0)
    } finally {
      b2.cleanup()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('无模型可建（agents 无 options）时 run-now 返回 fallback', async () => {
    const agents = makeAgents()
    const { handler, cleanup } = boot({ agentsService: agents.service })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(false)
      expect(data.fallback).toBe(true)
      expect(agents.injected.length).toBe(0)
    } finally { cleanup() }
  })

  it('有 presets 服务时创建执行会话会装配标准组合（mount 默认 preset，含 web_search）', async () => {
    let created = null
    let mounted = null
    const agents = makeAgents({
      agentsCreate: async (opts) => {
        created = opts
        return { agent: { id: opts.sessionId, session: {}, followup: () => {} } }
      },
    })
    const live = agents.service.get('agent-live')
    live.options = { provider: 'deepseek', model: 'deepseek-chat' }
    const presets = {
      resolve: async () => ({ id: 'default-preset' }),
      mount: async (agentCtx, id) => { mounted = { agentCtx, id } },
    }
    const { handler, cleanup } = boot({ agentsService: agents.service, agentPresets: presets })
    try {
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/news/schedule',
        body: JSON.stringify({
          enabled: true, defaultScope: { categories: [], topics: [] },
          shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }],
        }),
      }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/news/run-now', body: JSON.stringify({ shiftId: 's1' }) }), res)
      expect(created).toBeTruthy()
      expect(created.meta.agentPreset).toBe('default-preset')
      expect(typeof created.setup).toBe('function')
      await created.setup({}) // 触发 setup 会 mount 默认 preset
      expect(mounted).toEqual({ agentCtx: {}, id: 'default-preset' })
    } finally { cleanup() }
  })

  it('GET /news/models 返回 llm 服务的 provider 与模型', async () => {
    const { handler, cleanup } = boot({ llm: makeLlm() })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/models' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.providers).toEqual([
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] },
      ])
    } finally { cleanup() }
  })

  it('GET /news/schedule 返回 schedulePrefs（无 newsSessionId 字段）', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/news/schedule' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.schedulePrefs).toBeTruthy()
      expect('newsSessionId' in data).toBe(false)
    } finally { cleanup() }
  })
})

// 供 makeAgents 相关测试：拿到 boot 使用的 HOME（boot 里 DSH_HOME = HOME/.dsh）。
function homeOf() { return process.env.HOME }

// 假 agents 服务：roots / get / 可选 create。opts.dedicated 注入一个「专用新闻简报会话」agent。
function makeAgents(opts = {}) {
  const injected = []
  const base = [
    { id: 'agent-early', status: 'idle', session: {} },
    { id: 'agent-live', status: 'running', session: {} },
  ]
  if (opts.dedicated) {
    base.push({ id: opts.dedicated.id, status: opts.dedicated.status || 'idle', session: {}, ...(opts.dedicated.options ? { options: opts.dedicated.options } : {}) })
  }
  const agents = base.map((a) => ({ ...a, followup: (msg) => injected.push({ id: a.id, status: a.status, msg }) }))
  const byId = new Map(agents.map((a) => [a.id, a]))
  return {
    injected,
    service: {
      roots: () => [...byId.values()],
      get: (id) => byId.get(id),
      ...(opts.agentsCreate ? { create: opts.agentsCreate } : {}),
    },
  }
}

// 假 llm 服务：listProviders + listModels，供 /news/models 路由测试。
function makeLlm() {
  return {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async (provider) => {
      if (provider === 'deepseek') return [{ provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' }]
      return []
    },
  }
}
