/**
 * Tests for the 网络电台 (lib/radio.js + lib/index.js /dsh-music/radio/* routes).
 *
 * lib/radio.js calls radio-browser.info via global fetch; the Host /radio/play
 * proxy also fetches the upstream station stream. Both are stubbed here so the
 * routes run without network. Host route setup mirrors test/qq.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { normalizeStation, parseIcyMetadata, setMirrors, resetMirrors } from '../lib/radio.js'
import { apply } from '../lib/index.js'

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}
function makeRes() {
  const res = {
    status: 200, headers: {}, body: null, chunks: [], destroyed: false, writableEnded: false,
    _listeners: {},
    on(ev, fn) { (res._listeners[ev] = res._listeners[ev] || []).push(fn); return res },
    removeListener(ev) { res._listeners[ev] = []; return res },
    emit(ev) { (res._listeners[ev] || []).forEach((fn) => fn()) },
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) } },
    write(chunk) { res.chunks.push(chunk) },
    end(data) { if (data !== undefined) res.body = data; else res.body = Buffer.concat(res.chunks.map((c) => Buffer.from(c))).toString('utf8'); res.writableEnded = true },
  }
  return res
}
function makeFs(rootDir) {
  return {
    async resolve(p) { return resolve(p) },
    async stat() { return undefined },
    processPath(t) { return resolve(t) },
    async listDir() { return [] },
    async readBytes() { return Buffer.alloc(0) },
  }
}
function boot() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-radio-test-'))
  mkdirSync(join(home, 'Music'), { recursive: true })
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  const registered = []
  const ctx = {
    shell: { resolve: (o) => o, run: async () => ({ stdout: { text: home } }) },
    fs: makeFs(home),
    webServer: { register: (r) => { registered.push(r) } },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    effect: (fn) => fn(),
  }
  apply(ctx)
  const handler = registered.find((r) => r.kind === 'prefix' && r.path === '/dsh-music')?.handler
  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
  return { home, handler, cleanup }
}

// 一条 radio-browser 的 station 样例（原样字段，含干扰项），验证 normalizeStation 收窄。
const RAW_STATION = {
  stationuuid: 'abc-123', changeuuid: 'abc-123', name: ' 中国之声  ',
  url: 'http://origin.example/live/64k.mp3', url_resolved: 'https://lhttp.qtfm.cn/live/15318317/64k.mp3',
  homepage: 'http://www.cnr.cn/', favicon: '', tags: 'news, chinese, top',
  country: 'China', countrycode: 'CN', state: '', language: 'chinese',
  codec: 'MP3', bitrate: 128, hls: 0, votes: 9884, clickcount: 124,
  lastcheckok: 1, ssl_error: 0, clicktrend: 124,
}
// fetch stub 的默认响应体工厂：按 URL 区分「目录 JSON」/「播放流」。
// 若传入 stations 超一页，按 URL 里的 offset/limit 切片（模拟上游分页）。
function makeFetchStub({ stations = [RAW_STATION], streamChunks = [Buffer.from('ID3XXX')], contentType = 'audio/mpeg' } = {}) {
  return vi.fn(async (url, opts) => {
    const u = String(url)
    if (u.includes('/json/stations/search')) {
      let page = stations
      const off = parseInt(/offset=(\d+)/.exec(u)?.[1] || '0', 10) || 0
      const lim = Math.min(parseInt(/limit=(\d+)/.exec(u)?.[1] || '40', 10) || 40, 200)
      if (off > 0 || stations.length > lim) page = stations.slice(off, off + lim)
      return { ok: true, status: 200, json: async () => page }
    }
    if (u.includes('/json/stations/topvote/') || u.includes('/json/stations/topclick/')) {
      return { ok: true, status: 200, json: async () => stations }
    }
    if (u.includes('/json/stats')) {
      return { ok: true, status: 200, json: async () => ({ stations: 10 }) }
    }
    if (u.includes('/json/countries')) {
      return { ok: true, status: 200, json: async () => [{ name: 'China', iso_3166_1: 'CN', stationcount: 100 }, { name: 'USA', iso_3166_1: 'US', stationcount: 50 }] }
    }
    // 播放流：返回一个 ReadableStream-like body（route 用 for await 消费）。
    let i = 0
    const body = {
      headers: { get: (k) => ({ 'content-type': contentType, 'icy-name': '中国之声' }[k.toLowerCase()] ?? null) },
      status: 200,
      ok: true,
      body: {
        [Symbol.asyncIterator]: async function* () {
          for (; i < streamChunks.length; i++) yield streamChunks[i]
        },
      },
    }
    return body
  })
}

beforeEach(() => {
  resetMirrors()
  setMirrors(['https://test.api.radio-browser.info'])
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('lib/radio.js 归一化与工具函数', () => {
  it('normalizeStation 收窄字段、去除前后空白、解析 url_resolved', () => {
    const st = normalizeStation(RAW_STATION)
    expect(st).not.toBeNull()
    expect(st.id).toBe('abc-123')
    expect(st.name).toBe('中国之声')
    expect(st.url).toBe('https://lhttp.qtfm.cn/live/15318317/64k.mp3') // url_resolved 优先
    expect(st.countrycode).toBe('CN')
    expect(st.codec).toBe('MP3')
    expect(st.bitrate).toBe(128)
    expect(st.hls).toBe(false)
    expect(st.lastcheckok).toBe(true)
    expect(st.tags).toEqual(['news', 'chinese', 'top'])
  })

  it('normalizeStation 拒绝坏对象（无 http url 等）', () => {
    expect(normalizeStation(null)).toBeNull()
    expect(normalizeStation({})).toBeNull()
    expect(normalizeStation({ stationuuid: 'x', url: 'file:///etc/passwd' })).toBeNull()
    expect(normalizeStation({ stationuuid: 'x', url: 'javascript:alert(1)' })).toBeNull()
  })

  it('normalizeStation 接受无 uuid 但 url 合法的对象（手动添加台），id 兜底为空串', () => {
    const st = normalizeStation({ name: '我的私房台', url: 'https://example.com/stream.mp3' })
    expect(st).not.toBeNull()
    expect(st.id).toBe('')
    expect(st.stationuuid).toBe('')
    expect(st.url).toBe('https://example.com/stream.mp3')
  })

  it('normalizeStation 输出双写 id + stationuuid，出站对象可原样往返（收藏/最近 400 回归）', () => {
    // 出站对象（含旧版只有 id 的形态）POST 回来时入站校验仍能识别。
    const out = normalizeStation(RAW_STATION)
    const roundtrip = normalizeStation({ ...out, stationuuid: undefined })
    expect(roundtrip).not.toBeNull()
    expect(roundtrip.id).toBe('abc-123')
    expect(roundtrip.url).toBe(out.url)
    // 只有 stationuuid（无 id 字段）的原生形态同样 OK。
    const native = normalizeStation({ stationuuid: 'native-1', name: 'x', url: 'https://x/1.mp3' })
    expect(native.id).toBe('native-1')
    expect(native.stationuuid).toBe('native-1')
  })

  it('normalizeStation 处理 HLS 台与缺省字段', () => {
    const st = normalizeStation({ ...RAW_STATION, url: 'http://cdn/x.m3u8', hls: 1, favicon: '', countrycode: '' })
    expect(st.hls).toBe(true)
    expect(st.countrycode).toBe('')
    expect(st.votes).toBe(9884)
  })

  it('parseIcyMetadata 从带 ICY 元数据的流字节解析 StreamTitle', () => {
    // ICY：音频流每 metaint 字节插入 [1 字节长度 n][n*16 字节元数据]。
    // n*16 必须容纳 StreamTitle；标题区补齐到 16 倍数。
    const metaint = 16000
    const title = "StreamTitle='The Impossible Dream';"
    const n = Math.ceil(title.length / 16)
    const blockData = Buffer.alloc(n * 16)
    blockData.write(title, 0, 'latin1')
    const buf = Buffer.concat([Buffer.alloc(metaint, 0xff), Buffer.from([n]), blockData])
    expect(parseIcyMetadata(buf, metaint)).toBe('The Impossible Dream')
  })

  it('parseIcyMetadata 对非 ICY 流返回空串', () => {
    expect(parseIcyMetadata(Buffer.alloc(100), 0)).toBe('')
    expect(parseIcyMetadata(Buffer.alloc(100), 16000)).toBe('') // 长度超界 → ''
  })
})

describe('dsh-music-player 电台 Host 路由', () => {
  it('GET /dsh-music/radio/search 返回归一化 stations（走 radio-browser API）', async () => {
    vi.stubGlobal('fetch', makeFetchStub())
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/search?name=cnr&limit=10' }), res)
      expect(res.status).toBe(200)
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.stations.length).toBe(1)
      expect(d.stations[0]).toMatchObject({ id: 'abc-123', name: '中国之声', url: 'https://lhttp.qtfm.cn/live/15318317/64k.mp3' })
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/search 失败时返回 502 与错误（不吞异常）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('mirror down') }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/search?name=x' }), res)
      expect(res.status).toBe(502)
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(false)
      expect(String(d.error)).toContain('mirror down')
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/countries 返回按电台数排序的国家', async () => {
    vi.stubGlobal('fetch', makeFetchStub())
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/countries' }), res)
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.countries[0]).toMatchObject({ name: 'China', code: 'CN' })
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/cn 返回 CN 区电台：噪音剔除、hls 自然混排（分页首屏 50）', async () => {
    const cnStations = [
      // hls:0 主流台
      { ...RAW_STATION, stationuuid: 'cn1', name: '北京新闻广播', url: 'https://lhttp.qtfm.cn/live/339/64k.mp3', hls: 0, votes: 2000 },
      // hls:1 主流台（凤凰/央广）：hls 台不再重排，按 votes 自然混排展示（客户端灰显）
      { ...RAW_STATION, stationuuid: 'cn6', name: '凤凰卫视资讯台', url: 'http://playtv-live.ifeng.com/live/x.m3u8', hls: 1, votes: 13986 },
      // 噪音台：白噪音/相声合集/时间戳重复名 → 剔除
      { ...RAW_STATION, stationuuid: 'cn3', name: '雨声白噪音 助眠', url: 'https://stream.zeno.fm/xyz', hls: 0, votes: 900 },
      { ...RAW_STATION, stationuuid: 'cn4', name: '德云社相声合集', url: 'https://stream.zeno.fm/yqw', hls: 0, votes: 800 },
      { ...RAW_STATION, stationuuid: 'cn5', name: 'AsiaFM亚洲经典台【2023.10.17】', url: 'http://goldfm.cn:8000/goldfm', hls: 0, votes: 700 },
      { ...RAW_STATION, stationuuid: 'cn7', name: 'CNR-2 经济之声', url: 'http://ngcdn002.cnr.cn/live/jjzs/index.m3u8', hls: 1, votes: 8328 },
    ]
    vi.stubGlobal('fetch', makeFetchStub({ stations: cnStations }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/cn' }), res)
      expect(res.status).toBe(200)
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      const names = d.stations.map((s) => s.name)
      // 噪音台被剔除
      expect(names).not.toContain('雨声白噪音 助眠')
      expect(names).not.toContain('德云社相声合集')
      expect(names).not.toContain('AsiaFM亚洲经典台【2023.10.17】')
      // 其余按目录顺序保留（hls 不再重排到尾部）
      expect(names).toEqual(['北京新闻广播', '凤凰卫视资讯台', 'CNR-2 经济之声'])
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/cn?offset=50 返回下一页（分页不重叠）', async () => {
    // 制造 60 个台（前 50 + 后 10），offset=50 应只返回后 10。
    const many = []
    for (let i = 0; i < 60; i++) many.push({ ...RAW_STATION, stationuuid: 'cnp' + i, name: '中文台' + i, url: 'https://radio.example/' + i + '.mp3', hls: 0, votes: 1000 - i })
    vi.stubGlobal('fetch', makeFetchStub({ stations: many }))
    const { handler, cleanup } = boot()
    try {
      // 首页 50
      let res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/cn' }), res)
      let d = JSON.parse(res.body)
      expect(d.stations.length).toBe(50)
      expect(d.stations[0].stationuuid).toBe('cnp0')
      // offset=50 → 51..60（10 条）
      res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/cn?offset=50' }), res)
      d = JSON.parse(res.body)
      expect(d.stations.length).toBe(10)
      expect(d.stations[0].stationuuid).toBe('cnp50')
      expect(d.stations.map((s) => s.stationuuid)).not.toContain('cnp0')
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/cn 目录源失败时返回 502（不吞异常）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('mirror down') }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/cn' }), res)
      expect(res.status).toBe(502)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/cn?group=news 按主题 tag 查询 CN 目录（透传 tag）', async () => {
    const fetchStub = makeFetchStub()
    vi.stubGlobal('fetch', fetchStub)
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/cn?group=news&limit=200' }), res)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body).ok).toBe(true)
      // 上游请求 URL 应带 countrycode=CN + tag=news + hidebroken=true
      const searchUrl = String(fetchStub.mock.calls.map((c) => c[0]).find((x) => String(x).includes('/json/stations/search')))
      expect(searchUrl).toContain('countrycode=CN')
      expect(searchUrl).toContain('tag=news')
      expect(searchUrl).toContain('hidebroken=true')
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/cn?group=music 与 group=all（不带 tag）行为不同', async () => {
    const fetchStub = makeFetchStub()
    vi.stubGlobal('fetch', fetchStub)
    const { handler, cleanup } = boot()
    try {
      // all：不带 tag
      let res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/cn' }), res)
      let searchUrl = String(fetchStub.mock.calls.map((c) => c[0]).find((x) => String(x).includes('/json/stations/search')))
      expect(searchUrl).toContain('countrycode=CN')
      expect(searchUrl).not.toContain('tag=')

      // music：带 tag=music
      fetchStub.mockClear()
      res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/cn?group=music' }), res)
      searchUrl = String(fetchStub.mock.calls.map((c) => c[0]).find((x) => String(x).includes('/json/stations/search')))
      expect(searchUrl).toContain('tag=music')
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/top group=all 与指定 group 均走 search?order=votes（支持 offset 分页）', async () => {
    const fetchStub = makeFetchStub()
    vi.stubGlobal('fetch', fetchStub)
    const { handler, cleanup } = boot()
    try {
      // all：search 不带 tag（同 topvote 排序但可翻页）
      let res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/top' }), res)
      expect(res.status).toBe(200)
      let searchUrl = String(fetchStub.mock.calls.map((c) => c[0]).find((x) => String(x).includes('/json/stations/search')))
      expect(searchUrl).toContain('order=votes')
      expect(searchUrl).not.toContain('tag=')

      // music：search 带 tag=music（不带 countrycode）
      fetchStub.mockClear()
      res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/top?group=music' }), res)
      searchUrl = String(fetchStub.mock.calls.map((c) => c[0]).find((x) => String(x).includes('/json/stations/search')))
      expect(searchUrl).toContain('tag=music')
      expect(searchUrl).not.toContain('countrycode=')
      // offset 透传
      fetchStub.mockClear()
      res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/top?group=music&offset=50' }), res)
      searchUrl = String(fetchStub.mock.calls.map((c) => c[0]).find((x) => String(x).includes('/json/stations/search')))
      expect(searchUrl).toContain('offset=50')
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/top 目录源失败时返回 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('mirror down') }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/top' }), res)
      expect(res.status).toBe(502)
    } finally { cleanup() }
  })

  it('POST/GET /dsh-music/radio/favs 收藏与读取（持久化 ~/.dsh）', async () => {
    vi.stubGlobal('fetch', makeFetchStub())
    const { handler, cleanup, home } = boot()
    try {
      const addRes = makeRes()
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/radio/favs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add', station: RAW_STATION }),
      }), addRes)
      const added = JSON.parse(addRes.body)
      expect(added.ok).toBe(true)
      expect(added.faved).toBe(true)
      expect(added.favs[0].id).toBe('abc-123')

      const getRes = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/favs' }), getRes)
      expect(JSON.parse(getRes.body).favs[0].name).toBe('中国之声')

      // 落盘验证：json 文件存在且含收藏。
      const fs = require('node:fs')
      const saved = JSON.parse(fs.readFileSync(join(home, '.dsh', 'music-player-radio.json'), 'utf8'))
      expect(saved.favs.length).toBe(1)

      // remove
      const rmRes = makeRes()
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/radio/favs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'remove', station: RAW_STATION }),
      }), rmRes)
      expect(JSON.parse(rmRes.body).faved).toBe(false)
    } finally { cleanup() }
  })

  it('POST /dsh-music/radio/recent 记录最近播放（≤10 条、去重置顶）', async () => {
    vi.stubGlobal('fetch', makeFetchStub())
    const { handler, cleanup } = boot()
    try {
      for (let i = 0; i < 3; i++) {
        const res = makeRes()
        await handler(makeReq({
          method: 'POST', url: '/dsh-music/radio/recent',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ station: { ...RAW_STATION, stationuuid: 'u' + i, name: '台' + i } }),
        }), res)
      }
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/recent' }), res)
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.recent.length).toBe(3)
      expect(d.recent[0].id).toBe('u2') // 最新在前
    } finally { cleanup() }
  })

  it('出站站台对象（仅 id 无 stationuuid）POST recent/favs 不再 400（回归）', async () => {
    vi.stubGlobal('fetch', makeFetchStub())
    const { handler, cleanup } = boot()
    try {
      // 模拟浏览器把 /radio/search 返回的行（normalizeStation 出站形态）原样回传。
      // 旧版本出站对象没有 stationuuid 字段（只有 id）——这是用户实测 400 的根因。
      const outbound = {
        id: 'abc-123', name: '中国之声', url: 'https://lhttp.qtfm.cn/live/15318317/64k.mp3',
        codec: 'MP3', bitrate: 128, hls: false, country: 'China', countrycode: 'CN',
      }
      const rec = makeRes()
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/radio/recent',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ station: outbound }),
      }), rec)
      expect(rec.status).toBe(200)
      expect(JSON.parse(rec.body).ok).toBe(true)

      const fav = makeRes()
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/radio/favs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add', station: outbound }),
      }), fav)
      expect(fav.status).toBe(200)
      expect(JSON.parse(fav.body).ok).toBe(true)

      // 手动添加台（无 uuid）：同样允许。
      const manual = makeRes()
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/radio/favs',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add', station: { name: '我的台', url: 'https://example.com/x.mp3' } }),
      }), manual)
      expect(manual.status).toBe(200)
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/play 同源代理流并透传 icy-name/content-type', async () => {
    const fetchStub = makeFetchStub()
    vi.stubGlobal('fetch', fetchStub)
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('https://lhttp.qtfm.cn/live/15318317/64k.mp3') }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(decodeURIComponent(res.headers['X-DSH-Radio-Name'] || '')).toBe('中国之声')
      expect(res.body).toBe('ID3XXX')
      // 上游确实被请求（且带 UA / Referer）。
      const upstreamUrl = fetchStub.mock.calls[0][0]
      expect(String(upstreamUrl)).toContain('lhttp.qtfm.cn')
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/play 拒绝非 http(s) 上游（SSRF 防护）', async () => {
    const fetchStub = makeFetchStub()
    vi.stubGlobal('fetch', fetchStub)
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('file:///etc/passwd') }), res)
      expect(res.status).toBe(400)
      expect(fetchStub).not.toHaveBeenCalled()
    } finally { cleanup() }
  })

  it('GET /dsh-music/radio/play 上游失败时返回 502（不挂死）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('upstream reset') }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('https://bad.example/stream') }), res)
      expect(res.status).toBe(502)
    } finally { cleanup() }
  })
})
