/**
 * Unit/integration tests for the QQ 音乐 online routes added to lib/index.js.
 *
 * The real lib/qq.js makes network calls to Tencent endpoints, so it is mocked
 * here; the global `fetch` used by the /qq/play proxy is also stubbed so the
 * route can be exercised against a fake upstream stream without network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.mock('../lib/qq.js', () => ({
  createQRLogin: vi.fn(),
  createWXQRLogin: vi.fn(),
  checkQRLogin: vi.fn(),
  checkWXQRLogin: vi.fn(),
  search: vi.fn(),
  detectVip: vi.fn(),
  getDownloadURL: vi.fn(),
  getRecommendedPlaylists: vi.fn(),
  getPlaylistCategories: vi.fn(),
  getCategoryPlaylists: vi.fn(),
  searchPlaylist: vi.fn(),
  getPlaylistSongs: vi.fn(),
  getMyPlaylists: vi.fn(),
  addQQFav: vi.fn(),
  removeQQFav: vi.fn(),
  addSongToPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  deleteSongFromPlaylist: vi.fn(),
  getQQFavIds: vi.fn(),
  getTopLists: vi.fn(),
  getTopListSongs: vi.fn(),
  getNewSongs: vi.fn(),
  getLyric: vi.fn(),
}))

import * as QQ from '../lib/qq.js'
import { apply } from '../lib/index.js'

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}
function makeRes() {
  const res = {
    status: 200, headers: {}, body: null, chunks: [],
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) } },
    write(chunk) { res.chunks.push(chunk) },
    end(data) { if (data !== undefined) res.body = data; else res.body = Buffer.concat(res.chunks.map((c) => Buffer.from(c))).toString('utf8') },
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
  const home = mkdtempSync(join(tmpdir(), 'dsh-qq-test-'))
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

beforeEach(() => {
  vi.mocked(QQ.createQRLogin).mockResolvedValue({ key: 'qrsig=abc', imageDataUrl: 'data:image/png;base64,xxx', expiresAt: Date.now() + 60000 })
  vi.mocked(QQ.createWXQRLogin).mockResolvedValue({ key: 'type=wx&uuid=U&state=S', imageDataUrl: 'data:image/jpeg;base64,yyy', expiresAt: Date.now() + 60000 })
  vi.mocked(QQ.search).mockResolvedValue({ results: [{ id: '123', songmid: '123', title: '晴天', artists: ['周杰伦'], album: '叶惠美', payplay: 0, source: 'qq' }], total: 1, page: 1 })
  vi.mocked(QQ.detectVip).mockResolvedValue(true)
  vi.mocked(QQ.getDownloadURL).mockResolvedValue({ url: 'https://ws.stream.qqmusic.qq.com/up.mp3', filename: 'M500123123.mp3' })
  vi.mocked(QQ.getRecommendedPlaylists).mockResolvedValue([{ id: '111', name: '推荐歌单', creator: '作者', cover: '', trackCount: 10, source: 'qq' }])
  vi.mocked(QQ.getPlaylistCategories).mockResolvedValue([{ id: '1', name: '国语', group: '语种' }, { id: '2', name: '欧美', group: '语种' }])
  vi.mocked(QQ.getCategoryPlaylists).mockResolvedValue([{ id: '222', name: '分类歌单', creator: '作者', cover: '', trackCount: 8, source: 'qq' }])
  vi.mocked(QQ.searchPlaylist).mockResolvedValue({ results: [{ id: '333', name: '搜索歌单', creator: '作者', cover: '', trackCount: 5, source: 'qq' }], total: 1, page: 1 })
  vi.mocked(QQ.getPlaylistSongs).mockResolvedValue({ id: '111', name: '推荐歌单', creator: '作者', trackCount: 1, source: 'qq', songs: [{ id: '123', songmid: '123', title: '晴天', artists: ['周杰伦'], payplay: 0, source: 'qq' }] })
  vi.mocked(QQ.getMyPlaylists).mockResolvedValue([{ id: '444', name: '我的收藏', creator: '我', cover: '', trackCount: 3, source: 'qq', dirId: 444, tid: 444 }])
  vi.mocked(QQ.addQQFav).mockResolvedValue(true)
  vi.mocked(QQ.removeQQFav).mockResolvedValue(true)
  vi.mocked(QQ.addSongToPlaylist).mockResolvedValue(true)
  vi.mocked(QQ.deleteSongFromPlaylist).mockResolvedValue(true)
  vi.mocked(QQ.deletePlaylist).mockResolvedValue(true)
  vi.mocked(QQ.createPlaylist).mockResolvedValue({ id: 555, name: '新歌单' })
  vi.mocked(QQ.getQQFavIds).mockResolvedValue({ ids: [123, 456], mids: ['a', 'b'] })
  vi.mocked(QQ.getTopLists).mockResolvedValue([{ id: '0', name: '巅峰榜', toplists: [{ id: '62', name: '飙升榜', cover: 'https://x.jpg', listenNum: 123 }] }])
  vi.mocked(QQ.getTopListSongs).mockResolvedValue({ id: '62', name: '飙升榜', total: 100, hasMore: true, cover: '', updateTime: '', songs: [{ id: 'm1', songmid: 'm1', title: '飙升歌', artists: ['歌手'], payplay: 0, source: 'qq' }] })
  vi.mocked(QQ.getNewSongs).mockResolvedValue({ type: 5, label: '最新', songs: [{ id: 'n1', songmid: 'n1', title: '新歌', artists: ['歌手'], payplay: 0, source: 'qq' }] })
  vi.mocked(QQ.getLyric).mockResolvedValue({
    lyric: '[ti:晴天]\n[ar:周杰伦]\n[offset:0]\n[00:00.00]晴天\n[00:02.25]故事的小黄花\n',
    trans: '[00:00.00]翻译一\n[00:02.25]翻译二\n',
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('dsh-music-player QQ online routes', () => {
  it('reports not-logged-in via /dsh-music/qq/status', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/status' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ loggedIn: false })
    } finally { cleanup() }
  })

  it('creates a QR session via /dsh-music/qq/login/start (qq mode)', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/qq/login/start', body: JSON.stringify({ mode: 'qq' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.mode).toBe('qq')
      expect(data.key).toBe('qrsig=abc')
      expect(data.image).toContain('data:image/png;base64')
    } finally { cleanup() }
  })

  it('wechat login/start returns a jpeg data-url image', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/qq/login/start', body: JSON.stringify({ mode: 'wx' }) }), res)
      const data = JSON.parse(res.body)
      expect(data.mode).toBe('wx')
      expect(data.image).toContain('data:image/jpeg;base64')
      expect(data.key).toContain('type=wx')
    } finally { cleanup() }
  })

  it('logs in via /dsh-music/qq/login/check and persists the cookie (0600)', async () => {
    const { handler, home, cleanup } = boot()
    const cookie = 'uin=123; qqmusic_key=ABC; qm_keyst=ABC'
    vi.mocked(QQ.checkQRLogin).mockResolvedValue({ source: 'qq', key: 'qrsig=abc', status: 'success', cookie, cookies: { uin: '123' }, extra: {} })
    try {
      let res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/login/check?key=qrsig%3Dabc' }), res)
      expect(JSON.parse(res.body).status).toBe('success')
      expect(JSON.parse(res.body).loggedIn).toBe(true)
      const file = join(home, '.dsh', 'music-player-qq-cookie.json')
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.cookie).toBe(cookie)
      res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/status' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ loggedIn: true, uin: '123' })
    } finally { cleanup() }
  })

  it('reports waiting while the QR is unscanned', async () => {
    const { handler, cleanup } = boot()
    vi.mocked(QQ.checkQRLogin).mockResolvedValue({ source: 'qq', key: 'qrsig=abc', status: 'waiting', message: '', extra: {} })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/login/check?key=qrsig%3Dabc' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ status: 'waiting' })
    } finally { cleanup() }
  })

  it('logs out via /dsh-music/qq/login/logout', async () => {
    const { handler, home, cleanup } = boot()
    vi.mocked(QQ.checkQRLogin).mockResolvedValue({ source: 'qq', key: 'qrsig=abc', status: 'success', cookie: 'uin=123; qqmusic_key=ABC', extra: {} })
    try {
      await handler(makeReq({ url: '/dsh-music/qq/login/check?key=qrsig%3Dabc' }), makeRes())
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/qq/login/logout' }), res)
      expect(JSON.parse(res.body)).toMatchObject({ loggedIn: false })
      const file = join(home, '.dsh', 'music-player-qq-cookie.json')
      expect(JSON.parse(readFileSync(file, 'utf8')).cookie).toBe('')
    } finally { cleanup() }
  })

  it('searches QQ online via /dsh-music/qq/search (anonymous -> not vip)', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/search?w=%E6%99%B4%E5%A4%A9' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.isVip).toBe(false) // no cookie -> refreshQQVip short-circuits to false
      expect(data.results[0].title).toBe('晴天')
      expect(data.total).toBe(1)
      expect(QQ.search).toHaveBeenCalledWith('晴天', '', 1)
    } finally { cleanup() }
  })

  it('forwards the page param and returns total for paged song search', async () => {
    const { handler, cleanup } = boot()
    try {
      vi.mocked(QQ.search).mockResolvedValue({ results: [{ id: '456', songmid: '456', title: '夜曲', artists: ['周杰伦'], album: '十一月的萧邦', payplay: 0, source: 'qq' }], total: 42, page: 3 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/search?w=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=3' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.search).toHaveBeenCalledWith('周杰伦', '', 3)
      expect(data.results[0].title).toBe('夜曲')
      expect(data.total).toBe(42)
      expect(data.page).toBe(3)
    } finally { cleanup() }
  })

  it('proxies a QQ audio stream via /dsh-music/qq/play/<mid>', async () => {
    const { handler, cleanup } = boot()
    const fakeBody = (async function* () { yield Buffer.from('ID3AUDIO') })()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 206,
      headers: { get: (h) => h === 'content-type' ? 'audio/mpeg' : (h === 'content-length' ? '8' : h === 'content-range' ? 'bytes 0-7/100' : null) },
      body: fakeBody,
    })))
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/123', headers: { range: 'bytes=0-65535' } }), res)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(res.body).toBe('ID3AUDIO')
    } finally { cleanup() }
  })

  it('returns 404 for a QQ play with no resolvable URL', async () => {
    const { handler, cleanup } = boot()
    vi.mocked(QQ.getDownloadURL).mockResolvedValue({ url: '', filename: '' })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/99' }), res)
      expect(res.status).toBe(404)
      // 取链失败：不带「真实品质」头
      expect(res.headers['X-DSH-QQ-Quality']).toBeUndefined()
    } finally { cleanup() }
  })

  it('REGRESSION: /qq/status 只看「cookie 是否存在」，不做主动过期探测', async () => {
    // 2026-09-16 事故与两次返工后的定稿：曾用 music.UserInfo.userInfo/GetLoginUserInfo 判登录态，
    // 而它对**刚登录、明确有效**的微信会话同样返回 500003 → 「刚登录一刷新页面就提示登录过期」。
    // 结论：不做任何主动探测；过期只在**实际播放失败**时由客户端发现并把面板切回登录 UI。
    const { handler, cleanup } = boot()
    // 走真实登录流程把 cookie 放进内存（比直接写文件确定：启动期的 loadQQCookie 有竞态）
    // 微信态走 checkWXQRLogin（路由按 key 里的 type=wx 分流）
    vi.mocked(QQ.checkWXQRLogin).mockResolvedValue({ source: 'wx', key: 'type=wx&uuid=U&state=S', status: 'success', cookie: 'uin=123; qqmusic_key=ABC; tmeLoginType=1', cookies: { uin: '123' }, extra: {} })
    try {
      await handler(makeReq({ url: '/dsh-music/qq/login/check?key=type%3Dwx%26uuid%3DU%26state%3DS' }), makeRes())
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/status' }), res)
      const d = JSON.parse(res.body)
      expect(d).toMatchObject({ loggedIn: true, uin: '123', loginFrom: 'wx' })
      expect(d.authExpired).toBeUndefined() // 不再下发过期标记
      expect(vi.mocked(QQ.detectVip)).not.toHaveBeenCalled() // 也不做 vkey 探测
    } finally { cleanup() }
  })

  it('sends the X-DSH-QQ-Quality header (无损) from the取链 filename', async () => {
    const { handler, cleanup } = boot()
    vi.mocked(QQ.getDownloadURL).mockResolvedValue({ url: 'https://ws.stream.qqmusic.qq.com/x.flac', filename: 'F000123123.flac' })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: { get: (h) => h === 'content-type' ? 'audio/flac' : (h === 'content-length' ? '5' : null) },
      body: (async function* () { yield Buffer.from('DATA') })(),
    })))
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/123' }), res)
      expect(res.status).toBe(200)
      // 真实 Node 拒绝非 ASCII 响应头值：值必须 percent-encoded（纯 ASCII），解码后为中文标签
      expect(res.headers['X-DSH-QQ-Quality']).toBe(encodeURIComponent('无损'))
      expect(decodeURIComponent(res.headers['X-DSH-QQ-Quality'])).toBe('无损')
    } finally { cleanup() }
  })

  it('maps M800→高音质 and M500→标准 in the quality header', async () => {
    const cases = [
      { filename: 'M800123123.mp3', expect: '高音质' },
      { filename: 'O801123123.ogg', expect: '高音质' },
      { filename: 'M500123123.mp3', expect: '标准' },
    ]
    for (const c of cases) {
      const { handler, cleanup } = boot()
      vi.mocked(QQ.getDownloadURL).mockResolvedValue({ url: 'https://ws.stream.qqmusic.qq.com/x', filename: c.filename })
      vi.stubGlobal('fetch', vi.fn(async () => ({
        status: 200,
        headers: { get: (h) => h === 'content-type' ? 'audio/mpeg' : (h === 'content-length' ? '5' : null) },
        body: (async function* () { yield Buffer.from('DATA') })(),
      })))
      try {
        const res = makeRes()
        await handler(makeReq({ url: '/dsh-music/qq/play/123' }), res)
        expect(res.status).toBe(200)
        expect(decodeURIComponent(res.headers['X-DSH-QQ-Quality'])).toBe(c.expect)
      } finally { cleanup() }
    }
  })

  it('caches the取链 result per songmid so repeat requests get the same quality', async () => {
    const { handler, cleanup } = boot()
    const take = vi.fn(async () => ({ url: 'https://ws.stream.qqmusic.qq.com/x.flac', filename: 'Q000123123.flac' }))
    vi.mocked(QQ.getDownloadURL).mockImplementation(take)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: { get: (h) => h === 'content-type' ? 'audio/flac' : (h === 'content-length' ? '5' : null) },
      body: (async function* () { yield Buffer.from('DATA') })(),
    })))
    try {
      const r1 = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/123' }), r1)
      expect(decodeURIComponent(r1.headers['X-DSH-QQ-Quality'])).toBe('无损')
      const r2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/123' }), r2)
      expect(decodeURIComponent(r2.headers['X-DSH-QQ-Quality'])).toBe('无损')
      // 第二次命中缓存：不再发起取链（真实品质与真正播放的流一致）
      expect(take).toHaveBeenCalledTimes(1)
    } finally { cleanup() }
  })

  it('always requests the full (无损-first)取链 order, not gated on detectVip', async () => {
    // Regression: detectVip 用免费档探测会把 VIP 账号误判为非 VIP，导致取链只走
    // M800/M500（高音质/标准）而拿不到无损。取链必须始终按完整档位顺序请求，
    // 由服务端授予哪个播哪个（真实品质）。
    const { handler, cleanup } = boot()
    const take = vi.fn(async () => ({ url: 'https://ws.stream.qqmusic.qq.com/x.flac', filename: 'AI00123123.flac' }))
    vi.mocked(QQ.getDownloadURL).mockImplementation(take)
    vi.mocked(QQ.detectVip).mockResolvedValue(false) // 即使 detectVip 误判非 VIP…
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: { get: (h) => h === 'content-type' ? 'audio/flac' : (h === 'content-length' ? '5' : null) },
      body: (async function* () { yield Buffer.from('DATA') })(),
    })))
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/play/123' }), res)
      expect(res.status).toBe(200)
      // …取链仍以完整档位顺序（isVip=true）请求，服务端授予无损就显示无损
      expect(take.mock.calls[0][2]).toBe(true)
      expect(decodeURIComponent(res.headers['X-DSH-QQ-Quality'])).toBe('无损')
    } finally { cleanup() }
  })

  it('returns recommended playlists via /dsh-music/qq/playlists', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlists' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.playlists[0].name).toBe('推荐歌单')
    } finally { cleanup() }
  })

  it('returns category playlists via /dsh-music/qq/playlists?category=<id>', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlists?category=1&page=1' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getCategoryPlaylists).toHaveBeenCalledWith('1', 1, 20, '')
      expect(data.playlists[0].name).toBe('分类歌单')
    } finally { cleanup() }
  })

  it('returns playlist categories via /dsh-music/qq/playlist-categories', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-categories' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.categories).toHaveLength(2)
    } finally { cleanup() }
  })

  it('returns my playlists via /dsh-music/qq/my-playlists (logged-in only)', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/my-playlists' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getMyPlaylists).toHaveBeenCalled()
      expect(data.playlists[0].name).toBe('我的收藏')
    } finally { cleanup() }
  })

  it('adds/removes an online QQ song to/from 我喜欢 via /dsh-music/qq/fav', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ action: 'add', song: { songid: 123, songtype: 0 } })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/fav', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.faved).toBe(true)
      expect(QQ.addQQFav).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, '')
      // remove
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/fav', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'remove', song: { songid: 123, songtype: 0 } }) }), res2)
      const d2 = JSON.parse(res2.body)
      expect(QQ.removeQQFav).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, '')
      expect(d2.faved).toBe(false)
    } finally { cleanup() }
  })

  it('returns liked song ids via /dsh-music/qq/liked', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/liked' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getQQFavIds).toHaveBeenCalled()
      expect(data.ids).toEqual([123, 456])
    } finally { cleanup() }
  })

  it('adds a song to a user playlist via /dsh-music/qq/playlist-add', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ song: { songid: 123, songtype: 0 }, dirId: 444, tid: 444 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-add', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.addSongToPlaylist).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, 444, 444, '')
    } finally { cleanup() }
  })

  it('removes a song from a user playlist via /dsh-music/qq/playlist-remove', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ song: { songid: 123, songtype: 0 }, dirId: 444, tid: 0 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-remove', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.deleteSongFromPlaylist).toHaveBeenCalledWith({ songid: 123, songtype: 0 }, 444, 0, '')
    } finally { cleanup() }
  })

  it('creates a playlist via /dsh-music/qq/playlist-create', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ name: '新歌单' })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-create', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.playlist.name).toBe('新歌单')
      expect(QQ.createPlaylist).toHaveBeenCalledWith('新歌单', '')
    } finally { cleanup() }
  })

  it('rejects an empty playlist name via /dsh-music/qq/playlist-create', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-create', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '  ' }) }), res)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('deletes a user playlist via /dsh-music/qq/playlist-delete', async () => {
    const { handler, cleanup } = boot()
    try {
      const body = JSON.stringify({ dirId: 444 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-delete', method: 'POST', headers: { 'content-type': 'application/json' }, body }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.deletePlaylist).toHaveBeenCalledWith(444, '')
    } finally { cleanup() }
  })

  it('rejects a playlist delete without dirId via /dsh-music/qq/playlist-delete', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-delete', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }), res)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('surfaces a deletePlaylist failure via /dsh-music/qq/playlist-delete', async () => {
    const { handler, cleanup } = boot()
    try {
      vi.mocked(QQ.deletePlaylist).mockRejectedValue(new Error('「我喜欢」不可删除'))
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-delete', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dirId: 201 }) }), res)
      expect(res.status).toBe(502)
      expect(JSON.parse(res.body).ok).toBe(false)
      expect(JSON.parse(res.body).error).toContain('「我喜欢」不可删除')
    } finally { cleanup() }
  })

  it('searches playlists via /dsh-music/qq/playlist-search', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-search?w=%E5%91%A8%E6%9D%B0%E4%BC%A6' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.searchPlaylist).toHaveBeenCalledWith('周杰伦', '', 1)
      expect(data.playlists[0].name).toBe('搜索歌单')
    } finally { cleanup() }
  })

  it('forwards the page param and returns total for paged playlist search', async () => {
    const { handler, cleanup } = boot()
    try {
      vi.mocked(QQ.searchPlaylist).mockResolvedValue({ results: [{ id: '777', name: '周杰伦精选', creator: '作者', cover: '', trackCount: 40, source: 'qq' }], total: 30, page: 2 })
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist-search?w=%E5%91%A8%E6%9D%B0%E4%BC%A6&page=2' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.searchPlaylist).toHaveBeenCalledWith('周杰伦', '', 2)
      expect(data.playlists[0].name).toBe('周杰伦精选')
      expect(data.total).toBe(30)
      expect(data.page).toBe(2)
    } finally { cleanup() }
  })

  it('returns a playlist detail with songs via /dsh-music/qq/playlist/<id>', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/playlist/111' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.playlist.name).toBe('推荐歌单')
      expect(data.playlist.songs[0].title).toBe('晴天')
    } finally { cleanup() }
  })

  it('returns ranking groups via /dsh-music/qq/top-lists', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-lists' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getTopLists).toHaveBeenCalled()
      expect(data.groups[0].name).toBe('巅峰榜')
    } finally { cleanup() }
  })

  it('returns ranking songs via /dsh-music/qq/top-songs?topId=62', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-songs?topId=62' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getTopListSongs).toHaveBeenCalledWith('62', expect.any(String), 0, 30)
      expect(data.toplist.songs[0].title).toBe('飙升歌')
      expect(data.toplist.hasMore).toBe(true)
    } finally { cleanup() }
  })

  it('forwards offset/num for paginated top-songs', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-songs?topId=62&offset=30&num=30' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getTopListSongs).toHaveBeenCalledWith('62', expect.any(String), 30, 30)
    } finally { cleanup() }
  })

  it('returns new songs via /dsh-music/qq/new-songs?type=5', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/new-songs?type=5' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getNewSongs).toHaveBeenCalled()
      expect(data.result.songs[0].title).toBe('新歌')
    } finally { cleanup() }
  })

  it('rejects bad topId via /dsh-music/qq/top-songs', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/top-songs?topId=abc' }), res)
      expect(res.status).toBe(400)
    } finally { cleanup() }
  })

  it('returns parsed lyric + translation via /dsh-music/qq/lyric?songmid=', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=0039MnYb0qxYhV' }), res)
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(QQ.getLyric).toHaveBeenCalledWith('0039MnYb0qxYhV', '')
      expect(data.hasLyric).toBe(true)
      // 元数据行 [ti:]/[ar:] 被跳过，只保留带时间戳的歌词行
      expect(data.lrc).toEqual([
        { t: 0, text: '晴天' },
        { t: 2.25, text: '故事的小黄花' },
      ])
      // 逐句翻译同样解析为 [{t,text}]
      expect(data.trans).toEqual([
        { t: 0, text: '翻译一' },
        { t: 2.25, text: '翻译二' },
      ])
    } finally { cleanup() }
  })

  it('rejects a bad songmid via /dsh-music/qq/lyric', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=' + encodeURIComponent('非法 mid!') }), res)
      expect(res.status).toBe(400)
    } finally { cleanup() }
  })

  it('surfaces a getLyric failure (retcode!=0) as a 502', async () => {
    vi.mocked(QQ.getLyric).mockRejectedValueOnce(new Error('未获取到歌词（retcode=1101）'))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=__invalid__' }), res)
      expect(res.status).toBe(502)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(false)
      expect(String(data.error)).toContain('1101')
    } finally { cleanup() }
  })
})
