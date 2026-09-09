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
  getMyUserInfo: vi.fn(),
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
  // 主动续命已停用（2026-09-06）；本文件覆盖登录/失效登出/设备指纹等路径。
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
    // 主动续命已停用 + 无被动补救：token 真过期时业务接口报设备不匹配，直接登出
    // 让前端跳回扫码页重新扫码（酷狗无其他续命手段，重扫是唯一正道）。
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

describe('酷狗登录 token 直接使用：login/check 不再做登录后刷新', () => {
  it('扫码登录成功 → 直接存扫码 token，不调用 refreshSession（对齐 MakcRe）', async () => {
    writeFileSync(booted.cookieFile, JSON.stringify({
      session: { guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID', token: '', userid: '', vip_type: '', vip_token: '' },
      loggedIn: false, savedAt: Date.now(),
    }))
    vi.mocked(KG.createQRLogin).mockResolvedValue({ key: 'K9', imageDataUrl: '', expiresAt: Date.now() + 60000 })
    const startRes = makeRes()
    await booted.handler(makeReq({ method: 'POST', url: '/dsh-music/kg/login/start' }), startRes)
    const qrToken = 'qrtok' + 'x'.repeat(50)
    vi.mocked(KG.checkQRLogin).mockResolvedValue({ status: 'success', message: '登录成功', tokenInfo: { token: qrToken, userid: '1785839222', vip_type: '', vip_token: '' } })
    vi.mocked(KG.getMyUserInfo).mockResolvedValue({ userid: '1785839222', nickname: '杜双庆', pic: '', signature: '', username: '' })
    const checkRes = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/login/check?key=K9' }), checkRes)
    expect(JSON.parse(checkRes.body).loggedIn).toBe(true)
    expect(KG.refreshSession).not.toHaveBeenCalled() // 登录后不做刷新/兑换
    // 登录后抓了一次用户资料 → 响应与 cookie 都带昵称
    expect(KG.getMyUserInfo).toHaveBeenCalledTimes(1)
    expect(JSON.parse(checkRes.body).nickname).toBe('杜双庆')
    const saved = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved.loggedIn).toBe(true)
    expect(saved.session.token).toBe(qrToken) // cookie 存的就是扫码 token 本身
    expect(saved.session.nickname).toBe('杜双庆')
  })

  it('抓昵称失败不阻断登录（cookie nickname 留空，status 补抓兜底）', async () => {
    writeFileSync(booted.cookieFile, JSON.stringify({
      session: { guid: 'g', mid: '290402895447160996760242034854185275797', dfid: 'DFID', token: '', userid: '', vip_type: '', vip_token: '' },
      loggedIn: false, savedAt: Date.now(),
    }))
    vi.mocked(KG.createQRLogin).mockResolvedValue({ key: 'K9', imageDataUrl: '', expiresAt: Date.now() + 60000 })
    const startRes = makeRes()
    await booted.handler(makeReq({ method: 'POST', url: '/dsh-music/kg/login/start' }), startRes)
    vi.mocked(KG.checkQRLogin).mockResolvedValue({ status: 'success', message: '登录成功', tokenInfo: { token: 'tk' + 'x'.repeat(50), userid: '1785839222', vip_type: '', vip_token: '' } })
    vi.mocked(KG.getMyUserInfo).mockRejectedValueOnce(new Error('网络超时')) // 登录时抓失败
    const checkRes = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/login/check?key=K9' }), checkRes)
    expect(JSON.parse(checkRes.body).loggedIn).toBe(true) // 登录不受影响
    const saved1 = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved1.session.nickname).toBe('') // 昵称留空
    // 后续 status 请求补抓成功 → 昵称落 cookie 并返回
    vi.mocked(KG.getMyUserInfo).mockResolvedValue({ userid: '1785839222', nickname: '杜双庆', pic: '', signature: '', username: '' })
    const stRes = makeRes()
    await booted.handler(makeReq({ url: '/dsh-music/kg/status' }), stRes)
    expect(JSON.parse(stRes.body).nickname).toBe('杜双庆')
    const saved2 = JSON.parse(readFileSync(booted.cookieFile, 'utf8'))
    expect(saved2.session.nickname).toBe('杜双庆')
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
