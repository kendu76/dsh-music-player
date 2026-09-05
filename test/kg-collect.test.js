/**
 * Host-level tests for 酷狗「收藏歌单」歌曲读取：
 *
 * 正确读法：收藏歌单的歌曲不在自己云歌单副本（get_list_all_file 常为空），
 * 必须用 /pubsongs/v2/get_other_list_file_nofilt 传收藏条目的 creatorGid
 * （= 原歌单 global_specialid）。本文件锁定：
 * - getMyPlaylists 的收藏条目带 creatorGid
 * - /dsh-music/kg/my-playlist/<id> 对收藏歌单走 getCollectedPlaylistSongs
 * - 自建歌单仍走 getMyPlaylistSongs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

vi.mock('../lib/kugou.js', () => ({
  getMyPlaylists: vi.fn(),
  getMyPlaylistSongs: vi.fn(),
  getCollectedPlaylistSongs: vi.fn(),
  getPlaylistSongs: vi.fn(),
  collectPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  deleteSongFromPlaylist: vi.fn(),
  getDownloadURL: vi.fn(),
  registerDevice: vi.fn(),
  createDeviceIdentity: vi.fn(),
  refreshSession: vi.fn(),
  loginStart: vi.fn(),
  createQRLogin: vi.fn(),
  checkQRLogin: vi.fn(),
  logout: vi.fn(),
}))

import * as KG from '../lib/kugou.js'
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
  const home = mkdtempSync(join(tmpdir(), 'dsh-kg-collect-'))
  mkdirSync(join(home, 'Music'), { recursive: true })
  mkdirSync(join(home, '.dsh'), { recursive: true })
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
  return { home, handler, cleanup, cookieFile: join(home, '.dsh', 'music-player-kugou-cookie.json') }
}

let booted
beforeEach(() => {
  // 主动续命默认开启（KG_REFRESH_TTL = 24h），生产与测试一致；本文件覆盖
  // 续命触发/在途去重/失效登出路径。
  booted = boot()
  writeFileSync(booted.cookieFile, JSON.stringify({
    session: {
      guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID',
      token: 'tok', userid: '1785839222', vip_type: '', vip_token: '',
    },
    loggedIn: true, savedAt: Date.now(),
  }))
  // 默认：收藏歌单条目带 creatorGid；getCollectedPlaylistSongs 返回歌曲
  vi.mocked(KG.getMyPlaylists).mockResolvedValue([
    { id: '8', name: '超带感欧美节奏', kind: 'collect', isDefault: false, creator: '时光如水', originalId: '188', creatorGid: 'collection_3_1314415167_188_0', trackCount: 32, source: 'kugou', cover: '' },
    { id: '3', name: '我的自建歌单', kind: 'own', isDefault: false, creator: '', trackCount: 2, source: 'kugou', cover: '' },
  ])
  vi.mocked(KG.getCollectedPlaylistSongs).mockResolvedValue([
    { id: 'a', hash: 'AAAA', title: 'All I Wanna Do', artists: ['Martin Jensen'], source: 'kugou' },
    { id: 'b', hash: 'BBBB', title: 'Lullaby', artists: ['Sigala'], source: 'kugou' },
  ])
  vi.mocked(KG.getMyPlaylistSongs).mockResolvedValue([
    { id: 'x', hash: 'XXXX', title: '自建歌', artists: ['甲'], source: 'kugou' },
  ])
})
afterEach(() => {
  vi.clearAllMocks()
  booted.cleanup()
})

describe('酷狗收藏歌单：走 get_other_list_file_nofilt（creatorGid）读歌', () => {
  it('REGRESSION: 收藏歌单详情用 getCollectedPlaylistSongs(creatorGid) 而非 getMyPlaylistSongs', async () => {
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlist/8' }), res)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(true)
    expect(d.playlist.songs.length).toBe(2)
    expect(KG.getCollectedPlaylistSongs).toHaveBeenCalledWith('collection_3_1314415167_188_0', expect.anything())
    expect(KG.getMyPlaylistSongs).not.toHaveBeenCalled()
  })

  it('自建歌单详情仍走 getMyPlaylistSongs（不误用收藏接口）', async () => {
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlist/3' }), res)
    expect(KG.getMyPlaylistSongs).toHaveBeenCalledWith('3', expect.anything())
    expect(KG.getCollectedPlaylistSongs).not.toHaveBeenCalled()
    expect(JSON.parse(res.body).playlist.songs.length).toBe(1)
  })

  it('列表里找不到该 listid（如越权/已删）→ 走 getMyPlaylistSongs 兜底', async () => {
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlist/999' }), res)
    expect(KG.getMyPlaylistSongs).toHaveBeenCalled()
    expect(JSON.parse(res.body).playlist.songs.length).toBe(1)
  })
})

describe('酷狗「我喜欢」集合接口（/dsh-music/kg/liked，供播放条爱心点亮）', () => {
  it('返回我喜欢歌单的 listId + 歌曲 hash 集合 + hash→fileId 映射', async () => {
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([
      { id: '2', name: '我喜欢', kind: 'own', isLike: true, isDef: 2, trackCount: 44, cover: 'data:image/jpeg;base64,xx' },
      { id: '3', name: '自建', kind: 'own', isLike: false, isDef: 0, trackCount: 2, cover: '' },
    ])
    vi.mocked(KG.getMyPlaylistSongs).mockResolvedValue([
      { id: 'a', hash: 'AAAA', title: 'All I Wanna Do', fileId: 2, source: 'kugou' },
      { id: 'b', hash: 'BBBB', title: 'Lullaby', fileId: 3, source: 'kugou' },
    ])
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/liked' }), res)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(true)
    expect(d.listId).toBe(2)
    expect(d.hashes).toEqual(['AAAA', 'BBBB'])
    expect(d.files).toEqual([{ hash: 'AAAA', fileId: 2 }, { hash: 'BBBB', fileId: 3 }])
    expect(KG.getMyPlaylistSongs).toHaveBeenCalledWith('2', expect.anything())
  })

  it('没有我喜欢歌单时返回空集合（ok:true）', async () => {
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([
      { id: '3', name: '自建', kind: 'own', isLike: false, isDef: 0, trackCount: 2, cover: '' },
    ])
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/liked' }), res)
    expect(res.status).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(true)
    expect(d.listId).toBe(0)
    expect(d.hashes).toEqual([])
    expect(d.files).toEqual([])
    expect(KG.getMyPlaylistSongs).not.toHaveBeenCalled()
  })

  it('未登录返回 401', async () => {
    writeFileSync(booted.cookieFile, JSON.stringify({ session: { token: '', userid: '' }, loggedIn: false, savedAt: Date.now() }))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/liked' }), res)
    expect(res.status).toBe(401)
  })
})

describe('酷狗登录态失效 → 不做被动补救，直接登出 + kgLoginDead 标记', () => {
  it('业务接口报设备不匹配（20017）→ 不刷新补救，清空会话并返回 kgLoginDead:true', async () => {
    // 被动补救已移除：token 失效由「请求前主动续命（24h TTL）」预防；若业务仍报
    // 设备不匹配，说明会话确实死了，直接登出让前端跳回扫码页，不再现场刷新重试。
    vi.mocked(KG.getMyPlaylists).mockRejectedValue(new Error('云歌单：登录态与设备不匹配（20017）'))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(502)
    const d = JSON.parse(res.body)
    expect(d.ok).toBe(false)
    expect(d.kgLoginDead).toBe(true)
    expect(d.error).toContain('请重新扫码登录')
    expect(KG.refreshSession).not.toHaveBeenCalled() // 无被动补救刷新
    expect(KG.getMyPlaylists).toHaveBeenCalledTimes(1) // 原请求只发一次
    // 会话已自动清空：cookie 文件 loggedIn:false，token 置空；但设备指纹（guid/mid/
    // dfid）保留——重扫以「老设备」身份回归，酷狗风控更友好。
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(false)
    expect(saved.session.token).toBe('')
    expect(saved.session.guid).toBe('g')
    expect(saved.session.mid).toBe('290402895447160996760242034854185275797')
    expect(saved.session.dfid).toBe('DFID')
  })

  it('业务接口报 20028（临时安全验证）→ 不登出、不带标记（登录态保留，稍后重试）', async () => {
    // 回归：20028「本次请求需要验证」是临时风控，不是 token 失效/设备不匹配。
    // 曾因误归入 KG_AUTH_DEAD_RE 导致播放中一次风控抖动就把用户登出（clearKGCookie）。
    vi.mocked(KG.getMyPlaylists).mockRejectedValue(new Error('触发酷狗安全验证，请稍后重试（20028）'))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(502)
    const d = JSON.parse(res.body)
    expect(d.kgLoginDead).toBeUndefined() // 20028 不触发登出
    expect(d.error).toContain('安全验证')
    expect(KG.refreshSession).not.toHaveBeenCalled()
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(true) // 登录态保留
    expect(saved.session.token).toBe('tok') // beforeEach 的 token 未被动过
  })

  it('业务错误非设备不匹配（如接口 4xx/网络类）→ 不登出、不带标记，原样报错', async () => {
    vi.mocked(KG.getMyPlaylists).mockRejectedValue(new Error('获取我的歌单失败：error_code=30020（HTTP 502）'))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(502)
    const d = JSON.parse(res.body)
    expect(d.kgLoginDead).toBeUndefined()
    expect(d.error).toContain('30020')
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(true) // 未登出
    expect(KG.refreshSession).not.toHaveBeenCalled()
  })
})

describe('酷狗登出/失效保留设备指纹（guid/mid/dfid），重扫=老设备回归', () => {
  it('手动退出登录：只清登录态，保留设备指纹', async () => {
    const res = makeRes()
    await booted.handler(makeReq({ method: 'POST', url: '/dsh-music/kg/login/logout' }), res)
    expect(res.status).toBe(200)
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(false)
    expect(saved.session.token).toBe('')
    expect(saved.session.guid).toBe('g')
    expect(saved.session.mid).toBe('290402895447160996760242034854185275797')
    expect(saved.session.dfid).toBe('DFID')
  })

  it('重扫（login/start）复用已保留的指纹，不再重建/注册', async () => {
    // 模拟「登出后」状态：有指纹、无 token
    writeFileSync(booted.cookieFile, JSON.stringify({
      session: { guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID', token: '', userid: '', vip_type: '', vip_token: '' },
      loggedIn: false, savedAt: Date.now(),
    }))
    vi.mocked(KG.createQRLogin).mockResolvedValue({ key: 'K1', imageDataUrl: 'data:image/png;base64,xx', expiresAt: Date.now() + 60000 })
    const res = makeRes()
    await booted.handler(makeReq({ method: 'POST', url: '/dsh-music/kg/login/start' }), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
    expect(KG.createDeviceIdentity).not.toHaveBeenCalled()
    expect(KG.registerDevice).not.toHaveBeenCalled()
    expect(KG.createQRLogin).toHaveBeenCalledWith(expect.objectContaining({ dfid: 'DFID', mid: '290402895447160996760242034854185275797', guid: 'g' }))
  })

  it('无可用指纹（首次登录/旧 cookie）→ 仍重建并注册', async () => {
    writeFileSync(booted.cookieFile, JSON.stringify({
      session: { guid: '', mid: '', dfid: '-', token: '', userid: '', vip_type: '', vip_token: '' },
      loggedIn: false, savedAt: Date.now(),
    }))
    vi.mocked(KG.createDeviceIdentity).mockReturnValue({ guid: 'ng', mid: '99999999999999999999999999999999999999', dfid: '-' })
    vi.mocked(KG.registerDevice).mockResolvedValue({ dfid: 'NEWDFID' })
    vi.mocked(KG.createQRLogin).mockResolvedValue({ key: 'K2', imageDataUrl: 'data:image/png;base64,yy', expiresAt: Date.now() + 60000 })
    const res = makeRes()
    await booted.handler(makeReq({ method: 'POST', url: '/dsh-music/kg/login/start' }), res)
    expect(res.status).toBe(200)
    expect(KG.createDeviceIdentity).toHaveBeenCalled()
    expect(KG.registerDevice).toHaveBeenCalled()
    expect(KG.createQRLogin).toHaveBeenCalledWith(expect.objectContaining({ dfid: 'NEWDFID', mid: '99999999999999999999999999999999999999' }))
  })
})

describe('酷狗主动续命：token 陈旧时提前静默刷新（>24h）', () => {
  it('savedAt 超过 24h → 请求前先静默刷新换新 token', async () => {
    writeFileSync(booted.cookieFile, JSON.stringify({
      session: { guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID', token: 'oldtok', userid: '1785839222', vip_type: '', vip_token: '' },
      loggedIn: true, savedAt: Date.now() - 25 * 60 * 60 * 1000,
    }))
    vi.mocked(KG.refreshSession).mockResolvedValue({ token: 'newtok', userid: '1785839222', vip_type: '', vip_token: '', t1: '' })
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([{ id: '3', name: '自建', kind: 'own', isLike: false, isDef: 0, trackCount: 1 }])
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(200)
    // 主动续命在请求前刷新了一次
    expect(KG.refreshSession).toHaveBeenCalledTimes(1)
    expect(KG.getMyPlaylists).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.session.token).toBe('newtok')
  })

  it('savedAt 新鲜（<24h）→ 不主动刷新，直接请求', async () => {
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([{ id: '3', name: '自建', kind: 'own', isLike: false, isDef: 0, trackCount: 1 }])
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(200)
    expect(KG.refreshSession).not.toHaveBeenCalled()
  })

  it('主动续命遇设备不匹配（token 已死）→ 自动登出 + kgLoginDead，且保留指纹', async () => {
    writeFileSync(booted.cookieFile, JSON.stringify({
      session: { guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID', token: 'oldtok', userid: '1785839222', vip_type: '', vip_token: '' },
      loggedIn: true, savedAt: Date.now() - 25 * 60 * 60 * 1000,
    }))
    vi.mocked(KG.refreshSession).mockRejectedValue(new Error('刷新登录态失败：登录态与设备不匹配（20018）'))
    const res = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    expect(res.status).toBe(502)
    const d = JSON.parse(res.body)
    expect(d.kgLoginDead).toBe(true)
    expect(KG.getMyPlaylists).not.toHaveBeenCalled() // 续命失败即死，不再发原请求
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(false)
    expect(saved.session.dfid).toBe('DFID') // 指纹仍保留
  })
})

describe('酷狗主动续命在途去重：并发请求共享一次刷新（防旧 token 二连发被误判已死）', () => {
  const seedStale = () => writeFileSync(booted.cookieFile, JSON.stringify({
    session: { guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID', token: 'oldtok', userid: '1785839222', vip_type: '', vip_token: '' },
    loggedIn: true, savedAt: Date.now() - 25 * 60 * 60 * 1000, // >24h TTL：后续请求都会通过「该刷新」检查
  }))
  // 可控刷新桩：started 在刷新真正发出时兑现（保证后续请求命中「在途」窗口），resolve/reject 手动放行
  const stallRefresh = () => {
    let settle, signalStarted
    const started = new Promise((r) => { signalStarted = r })
    vi.mocked(KG.refreshSession).mockImplementation(() => new Promise((resolve, reject) => { settle = { resolve, reject }; signalStarted() }))
    return { started, resolve: (v) => settle.resolve(v), reject: (e) => settle.reject(e) }
  }

  it('REGRESSION: 刷新在途时第二请求到达 → 共享同一刷新，login_by_token 只发一次', async () => {
    seedStale()
    const gate = stallRefresh()
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([])
    const p1 = booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), makeRes())
    await gate.started // 第一个请求已进入挂起的刷新
    const p2 = booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), makeRes())
    await new Promise((r) => setTimeout(r, 10)) // 给第二请求时间走到续命检查点
    expect(KG.refreshSession).toHaveBeenCalledTimes(1) // 命中在途共享，未二次发起
    gate.resolve({ token: 'newtok', userid: '1785839222', vip_type: '', vip_token: '', t1: '' })
    await Promise.all([p1, p2])
    expect(KG.refreshSession).toHaveBeenCalledTimes(1) // 全程仍只有一次真实刷新
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(true)
    expect(saved.session.token).toBe('newtok')
  })

  it('在途刷新被判死（20018）→ 两个调用方共享同一失败，会话只清一次', async () => {
    seedStale()
    const gate = stallRefresh()
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([])
    const res1 = makeRes(); const res2 = makeRes()
    const p1 = booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res1)
    await gate.started
    const p2 = booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res2)
    await new Promise((r) => setTimeout(r, 10))
    expect(KG.refreshSession).toHaveBeenCalledTimes(1)
    gate.reject(new Error('刷新登录态失败：登录态与设备不匹配（20018）'))
    await Promise.all([p1, p2])
    for (const res of [res1, res2]) {
      expect(res.status).toBe(502)
      expect(JSON.parse(res.body).kgLoginDead).toBe(true)
    }
    expect(KG.getMyPlaylists).not.toHaveBeenCalled() // 两个调用方都没再发业务请求
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(false)
  })

  it('刷新挂起期间发生重扫登录 → 旧 token 的刷新结果作废，不覆盖新会话', async () => {
    seedStale()
    const gate = stallRefresh()
    vi.mocked(KG.getMyPlaylists).mockResolvedValue([])
    const res = makeRes()
    const pPlay = booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res)
    await gate.started // 旧 token 的主动续命刷新已挂起
    // 重扫链路（真实时序）：出码 → 轮询成功换 qr token → 登录后标准作用域刷新
    vi.mocked(KG.createQRLogin).mockResolvedValue({ key: 'K9', imageDataUrl: '', expiresAt: Date.now() + 60000 })
    const startRes = makeRes()
    await booted.handler(makeReq({ method: 'POST', url: '/dsh-music/kg/login/start' }), startRes)
    const qrToken = 'qrtok' + 'x'.repeat(50)
    vi.mocked(KG.checkQRLogin).mockResolvedValue({ status: 'success', message: '登录成功', tokenInfo: { token: qrToken, userid: '1785839222', vip_type: '', vip_token: '' } })
    // login/check 的登录后刷新不再挂起：直接给标准作用域结果（新链路先完成）
    vi.mocked(KG.refreshSession).mockImplementation(() => Promise.resolve({ token: 'stdtok', userid: '1785839222', vip_type: '', vip_token: '', t1: '' }))
    const checkRes = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/login/check?key=K9' }), checkRes)
    // 放行迟到的旧 token 刷新结果（此时会话 token 已是 stdtok → 应被作废）
    gate.resolve({ token: 'STALE' + 'y'.repeat(50) })
    await pPlay
    expect(res.status).toBe(200) // 播放面板请求用新会话照常完成
    expect(KG.getMyPlaylists).toHaveBeenCalledWith(expect.objectContaining({ token: 'stdtok' }))
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.session.token).toBe('stdtok') // 迟到的旧刷新没有覆盖新登录 token
  })
})

describe('酷狗 cookie 冷启动在途去重：同一 tick 的并发请求共享首次读取', () => {
  it('REGRESSION: 启动后同一 tick 的两个请求 → 第二个不再因 kgCookieLoaded 已置位而误报 401', async () => {
    // beforeEach 刚写好 loggedIn:true 的 cookie 文件，此刻是本次 boot 的首次访问：
    // 首个请求挂起在「读文件」时，第二个请求必须等同它完成，而不是只看标志位就放行。
    const res1 = makeRes(); const res2 = makeRes()
    const p1 = booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res1)
    const p2 = booted.handler(makeReq({ url: '/dsh-music/kg/my-playlists' }), res2)
    await Promise.all([p1, p2])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200) // 修复前：401「未登录」（kg.loggedIn 尚未赋值）
    expect(JSON.parse(res2.body).ok).toBe(true)
  })
})

describe('酷狗取链去重：同一首歌的 HEAD/GET 并发只取一次链', () => {
  it('REGRESSION: /kg/play 的 HEAD + GET 同时到达 → getDownloadURL 只调用一次（in-flight 去重）', async () => {
    const hash = '688857974673645ce89eda26a36db19d'
    // 取链带延迟（模拟 tracker 慢）：并发请求在缓存写入前都 miss 的场景
    vi.mocked(KG.getDownloadURL).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ url: '', quality: '', bitrate: 0 }), 30)
    }))
    const res1 = makeRes(), res2 = makeRes()
    await Promise.all([
      booted.handler(makeReq({ method: 'GET', url: '/dsh-music/kg/play/' + hash }), res1),
      booted.handler(makeReq({ method: 'HEAD', url: '/dsh-music/kg/play/' + hash }), res2),
    ])
    // 取链结果为空 → 路由回 404（不触发对 url 的 fetch），仅用于验证只取一次链
    expect(res1.status).toBe(404)
    expect(res2.status).toBe(404)
    expect(KG.getDownloadURL).toHaveBeenCalledTimes(1)
  })
})
