/**
 * lib/netease.js — 网易云音乐「扫码登录 + 在线搜索 + 匿名取链 + 歌单 + 歌词」底层模块。
 *
 * 纯 Node（Node ≥ 20，用全局 fetch 与 node:crypto），无第三方运行时依赖（二维码用
 * 内嵌 MIT 的 qrcode-generator，见 lib/vendor/qrcode.mjs）。
 *
 * 实现参考（均已在本机实测核验，详见 docs/netease-integration-research.md §2/§3）：
 *   - guohuiyuan/music-lib netease/*（本项目 QQ/酷狗移植的同源库）：登录扫码走
 *     interface.music.163.com 裸表单（type=3）、搜索走 linuxapi、取链 weapi 兜底
 *   - NeteaseCloudMusicApiEnhanced/api-enhanced（Binaryify 原版的继任者）：加密常量与端点语义风向标
 *   - 三套加密（weapi/linuxapi/eapi）全部用 node:crypto 实现；eapi 匿名已被网关门禁，
 *     保留实现仅供登录态高音质路线复测（MVP 用 weapi 即可）
 *
 * 能力面与 lib/qq.js / lib/kugou.js 对齐：搜索(含歌单/多分型) / 取链(匿名可播，免费歌
 * 320k、VIP 歌 45s 试听、版权歌 404) / 歌词(LRC+翻译+罗马音，YRC 逐字可选) /
 * 歌单(推荐/分类/广场/详情 trackIds+批量/我的歌单/榜单 63 榜) / 扫码登录(两跳直达 MUSIC_U)。
 *
 * ⚠️ 合规：均为非官方接口 + 流播受版权保护音乐，仅用于个人试听/学习，违反平台 ToS，
 * 风险自担；账号风控风险由使用者承担。严禁解灰/绕过版权限制（见 docs §4.5）。
 */

import crypto from 'node:crypto'
import { qrcode } from './vendor/qrcode.mjs'

// =====================================================================
// 常量与基础工具
// =====================================================================

const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152'
// weapi 常量（社区公开多年的事实数据）
const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const IV = '0102030405060708'
// linuxapi / eapi 密钥
const LINUXAPI_KEY = 'rFgB&h#%2?^eDg:Q'
const EAPI_KEY = 'e82ckenh8dichen8'
const MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const EXPONENT = '010001'
// 匿名请求的常规伪装 cookie（非必需，实测无 Cookie 头也可匿名取链）
const ANON_COOKIE = 'os=pc; appver=2.10.13'

export function md5Hex(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex') }

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// =====================================================================
// 三套加密（纯函数，导出供测试固化向量）—— 对齐社区实现与探针脚本
// =====================================================================

function aesCbc(text, key, iv = IV) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64')
}
function aesEcbHex(text, key) {
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex').toUpperCase()
}
function rsaNoPad(secretReversed) {
  // m^e mod n（等价 node RSA_NO_PADDING 左补零）；输出 256 位 hex
  const m = BigInt('0x' + Buffer.from(secretReversed, 'utf8').toString('hex'))
  const n = BigInt('0x' + MODULUS)
  const e = BigInt('0x' + EXPONENT)
  let r = 1n
  let b = m
  let k = e
  while (k > 0n) {
    if (k & 1n) r = (r * b) % n
    b = (b * b) % n
    k >>= 1n
  }
  return r.toString(16).padStart(256, '0')
}

/** weapi：双层 AES-128-CBC + RSA 无填充加密随机 secret，表单 params+encSecKey。 */
export function weapi(object) {
  const text = JSON.stringify(object)
  const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let secret = ''
  for (let i = 0; i < 16; i++) secret += pool[crypto.randomInt(pool.length)]
  return { params: aesCbc(aesCbc(text, PRESET_KEY), secret), encSecKey: rsaNoPad(secret.split('').reverse().join('')) }
}

/** linuxapi：AES-128-ECB 密封 {method,url,params}，表单 eparams。搜索主路。 */
export function linuxapi(innerUrl, paramsObj) {
  const text = JSON.stringify({ method: 'POST', url: innerUrl, params: paramsObj })
  return { eparams: aesEcbHex(text, LINUXAPI_KEY) }
}

/** eapi：AES-128-ECB 密封 `${url}-36cd479b6b5-${text}-36cd479b6b5-${md5}`。 */
export function eapi(urlPath, object) {
  const text = JSON.stringify(object)
  const message = `nobody${urlPath}use${text}md5forencrypt`
  const data = `${urlPath}-36cd479b6b5-${text}-36cd479b6b5-${md5Hex(message)}`
  return { params: aesEcbHex(data, EAPI_KEY) }
}

// =====================================================================
// 请求封装
// =====================================================================

async function formPost(fullUrl, body, { cookie = '', ua = UA_WEB } = {}) {
  const res = await fetchWithTimeout(fullUrl, {
    method: 'POST',
    headers: {
      'User-Agent': ua,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'http://music.163.com/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep null */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] }
}

const weapiPost = (path, obj, opts) => formPost('https://music.163.com' + path, weapi(obj), opts)
const linuxPost = (innerUrl, paramsObj, opts) => formPost('http://music.163.com/api/linux/forward', linuxapi(innerUrl, paramsObj), opts)
// eapi 请求（interface3.music.163.com）：补上客户端伪装 cookie（os=pc; appver=…），
// 与社区 api-enhanced 的 createOption(crypto:'eapi') 行为一致（登录态写操作走这条路）。
const eapiPost = (path, obj, opts = {}) => {
  const ck = String(opts.cookie || '')
  const merged = 'os=pc; appver=8.9.75; ' + ck
  return formPost('https://interface3.music.163.com' + path, eapi(path, obj), { ...opts, cookie: merged.trim() })
}
const getJson = async (url, cookie = '') => {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': UA_WEB, 'Referer': 'http://music.163.com/', ...(cookie ? { Cookie: cookie } : {}) },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep null */ }
  return { status: res.status, json, text }
}

/** 把 weapi/linuxapi 的「业务失败」统一抛成带 code 的 Error（路由层据此提示）。 */
function assertOk(j, what) {
  if (!j) throw new Error(`${what}失败（无响应）`)
  if (Number(j.code) !== 200) {
    const err = new Error(`${what}失败：${(j.msg || j.message) || ('code=' + j.code)}`)
    err.ncmCode = j.code
    throw err
  }
  return j
}

// =====================================================================
// 歌曲/歌单归一化
// =====================================================================

const dec = (s) => String(s ?? '').replace(/<\/?em(?:\s[^>]*)?>/gi, '').trim()

/**
 * 统一歌曲形状（对齐 qq.js/kugou.js 结果字段）。fee：0 免费 / 1 VIP / 4 数字专辑 /
 * 8 版权受限（低音质可免费听）；privilege.pl = 可播码率上限（320000=320k 等）。
 */
export function normalizeSong(o) {
  const s = o || {}
  const artists = Array.isArray(s.ar) ? s.ar.map((a) => dec(a && a.name)).filter(Boolean) : []
  const al = s.al && typeof s.al === 'object' ? s.al : {}
  const pr = s.privilege && typeof s.privilege === 'object' ? s.privilege : {}
  return {
    id: String(s.id ?? ''),
    title: dec(s.name || ''),
    artists,
    album: dec(al.name || ''),
    albumId: String(al.id ?? ''),
    cover: dec(al.picUrl || ''),
    interval: Math.round(Number(s.dt) / 1000) || 0,
    fee: Number(s.fee) || 0,
    privilege: { st: Number(pr.st) || 0, pl: Number(pr.pl) || 0, dl: Number(pr.dl) || 0, maxbr: Number(pr.maxbr) || 0 },
    source: 'nc',
    link: s.id ? `https://music.163.com/#/song?id=${s.id}` : '',
  }
}

function normalizePlaylistItem(p) {
  const o = p || {}
  return {
    id: String(o.id ?? ''),
    name: dec(o.name || ''),
    cover: dec(o.coverImgUrl || o.picUrl || ''),
    playCount: Number(o.playCount) || 0,
    trackCount: Number(o.trackCount) || 0,
    creator: dec((o.creator && o.creator.nickname) || o.copywriter || ''),
    description: dec(o.description || o.copywriter || ''),
    source: 'nc',
    link: o.id ? `https://music.163.com/#/playlist?id=${o.id}` : '',
  }
}

const songLink = (id) => (id ? `https://music.163.com/#/song?id=${id}` : '')

// =====================================================================
// 搜索 / 发现（匿名可用）
// =====================================================================

/**
 * 歌曲搜索（linuxapi 主路 + weapi /weapi/search/get 备路，均实测匿名可用）。
 * 返回 { results, total, page }。type：1 歌曲 / 10 专辑 / 100 歌手 / 1000 歌单 / 1004 MV。
 */
export async function search(keyword, cookie = '', page = 1, type = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const limit = 30
  const kw = String(keyword || '').trim()
  if (kw === '') return { results: [], total: 0, page: p }
  let j = null
  try {
    j = (await linuxPost('http://music.163.com/api/cloudsearch/pc', { s: kw, type, offset: (p - 1) * limit, limit }, { cookie: cookie || ANON_COOKIE })).json
  } catch { /* 回落 weapi */ }
  if (!j || Number(j.code) !== 200) {
    j = (await weapiPost('/weapi/search/get', { s: kw, type, offset: (p - 1) * limit, limit, total: true }, { cookie: cookie || ANON_COOKIE })).json
  }
  assertOk(j, '搜索')
  const result = (j && j.result) || {}
  const songs = Array.isArray(result.songs) ? result.songs : []
  return {
    results: songs.map(normalizeSong).filter((x) => x.id),
    total: Number(result.songCount) || songs.length,
    page: p,
  }
}

/** 歌单搜索（cloudsearch type=1000）。返回 { results, total, page }。 */
export async function searchPlaylist(keyword, cookie = '', page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const limit = 30
  const kw = String(keyword || '').trim()
  if (kw === '') return { results: [], total: 0, page: p }
  const j = (await linuxPost('http://music.163.com/api/cloudsearch/pc', { s: kw, type: 1000, offset: (p - 1) * limit, limit }, { cookie: cookie || ANON_COOKIE })).json
  assertOk(j, '歌单搜索')
  const playlists = (j && j.result && j.result.playlists) || []
  return {
    results: playlists.map(normalizePlaylistItem).filter((x) => x.id),
    total: Number(j.result.songCount) || playlists.length,
    page: p,
  }
}

/** 官方榜单列表（GET /api/toplist，匿名）。返回单组 { id:'', name:'', toplists }（对齐 kg 组结构）。 */
export async function getTopLists(_cookie = '') {
  const j = (await getJson('https://music.163.com/api/toplist')).json
  assertOk(j, '榜单列表')
  const toplists = (j.list || []).filter((t) => t.id && t.name).map((t) => ({
    id: String(t.id),
    name: dec(t.name),
    intro: dec(t.updateFrequency || t.description || ''),
    cover: dec(t.coverImgUrl || ''),
    updateTime: dec(t.updateFrequency || ''),
  }))
  return [{ id: '', name: '', toplists }]
}

/** 榜单详情 = 榜单 id 即歌单 id，复用歌单详情路线（匿名）。 */
export async function getTopListSongs(rankId, cookie = '', offset = 0, num = 30) {
  const detail = await getPlaylistSongs(rankId, cookie)
  const off = Math.max(0, parseInt(offset, 10) || 0)
  const size = Math.max(1, parseInt(num, 10) || 30)
  return {
    id: String(rankId),
    name: detail.name,
    cover: detail.cover,
    intro: detail.description,
    updateTime: '',
    total: detail.trackCount,
    hasMore: off + size < detail.trackCount,
    songs: detail.songs.slice(off, off + size),
  }
}

// =====================================================================
// 歌单（推荐/分类/广场/详情，匿名）
// =====================================================================

/** 推荐歌单（weapi /weapi/personalized/playlist，匿名）。 */
export async function getRecommendedPlaylists(_cookie = '', page = 1) {
  const j = (await weapiPost('/weapi/personalized/playlist', { limit: 30, total: true, n: 1000, csrf_token: '' }, { cookie: _cookie || ANON_COOKIE })).json
  assertOk(j, '推荐歌单')
  return (j.result || []).map(normalizePlaylistItem).filter((x) => x.id)
}

/** 歌单分类目录（weapi /weapi/playlist/catalogue，匿名）→ 扁平 [{ id: 分类名, name, group }]。 */
export async function getPlaylistCategories(_cookie = '') {
  const j = (await weapiPost('/weapi/playlist/catalogue', { csrf_token: '' }, { cookie: _cookie || ANON_COOKIE })).json
  assertOk(j, '歌单分类')
  const cats = []
  for (const sub of (j.sub || [])) {
    if (!sub.name || !sub.category) continue
    cats.push({ id: sub.name, name: sub.name, group: dec((j.categories && j.categories[String(sub.category)]) || '') })
  }
  return cats
}

/** 分类歌单 / 广场（weapi /weapi/playlist/list，匿名）。 */
export async function getCategoryPlaylists(category, page = 1, limit = 20, _cookie = '') {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const n = Math.max(1, Math.min(100, parseInt(limit, 10) || 20))
  const cat = String(category || '全部').trim()
  const j = (await weapiPost('/weapi/playlist/list', { cat, order: 'hot', limit: n, offset: (p - 1) * n, total: p === 1, csrf_token: '' }, { cookie: _cookie || ANON_COOKIE })).json
  assertOk(j, '分类歌单')
  return (j.playlists || []).map(normalizePlaylistItem).filter((x) => x.id)
}

/**
 * 歌单详情 + 全部歌曲。v6/playlist/detail 拿元数据 + trackIds（全量）+ tracks（仅前 n 首
 * 完整信息），剩余曲目用 v3/song/detail 批量（≤500/批）补齐 —— 对齐 music-lib 的
 * fetchPlaylistDetail（批 500）与 playlist_track_all 语义。
 */
export async function getPlaylistSongs(id, cookie = '') {
  const pid = String(id).trim()
  if (!/^[0-9]+$/.test(pid)) throw new Error('bad playlist id')
  const ck = cookie || ANON_COOKIE
  const j = (await weapiPost('/weapi/v6/playlist/detail', { id: pid, n: 1000, s: 8, csrf_token: '' }, { cookie: ck })).json
  assertOk(j, '歌单详情')
  const p = j.playlist || {}
  const trackIds = (p.trackIds || []).map((t) => String(t.id)).filter(Boolean)
  const have = new Set((p.tracks || []).map((t) => String(t.id)))
  let songs = (p.tracks || []).map(normalizeSong).filter((x) => x.id)
  const missing = trackIds.filter((tid) => !have.has(tid))
  // 批量补全缺失曲目
  if (missing.length > 0) {
    const BATCH = 500
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH)
      try {
        const c = JSON.stringify(batch.map((bid) => ({ id: bid })))
        const bj = (await weapiPost('/weapi/v3/song/detail', { c, ids: JSON.stringify(batch), csrf_token: '' }, { cookie: ck })).json
        if (Number(bj.code) === 200) {
          songs = songs.concat((bj.songs || []).map(normalizeSong).filter((x) => x.id))
        }
      } catch { /* 单批失败保留已取部分 */ }
    }
  }
  // 去重 + 保序（以 trackIds 顺序为准）
  const byId = new Map()
  for (const s of songs) if (!byId.has(s.id)) byId.set(s.id, s)
  const ordered = trackIds.map((tid) => byId.get(tid)).filter(Boolean)
  if (ordered.length > 0) songs = ordered
  return {
    id: pid,
    name: dec(p.name || ''),
    creator: dec((p.creator && p.creator.nickname) || ''),
    description: dec(p.description || ''),
    cover: dec(p.coverImgUrl || ''),
    trackCount: Number(p.trackCount) || songs.length,
    playCount: Number(p.playCount) || 0,
    source: 'nc',
    link: `https://music.163.com/#/playlist?id=${pid}`,
    songs,
  }
}

// =====================================================================
// 我的歌单（需登录 cookie；uid 从账号接口取）
// =====================================================================

/** 账号信息（/weapi/nuser/account/get）。未登录返回 null（实测匿名返回 account:null/profile:null）。 */
export async function getAccount(cookie = '') {
  if (!cookie) return null
  const j = (await weapiPost('/weapi/nuser/account/get', { csrf_token: '' }, { cookie })).json
  if (!j || Number(j.code) !== 200 || !j.profile || !j.profile.userId) return null
  return {
    userId: String(j.profile.userId),
    nickname: j.profile.nickname || '',
    vipType: Number(j.profile.vipType) || 0,
    account: j.account || null,
  }
}

/** 我的歌单（weapi /weapi/user/playlist?uid=；首个即「我喜欢的音乐」）。 */
export async function getMyPlaylists(cookie = '', page = 1, pagesize = 100) {
  if (!cookie) throw new Error('未登录，无法读取我的歌单')
  const acc = await getAccount(cookie)
  if (!acc) throw new Error('登录态已失效，请重新扫码登录')
  const p = Math.max(1, parseInt(page, 10) || 1)
  const n = Math.max(1, Math.min(100, parseInt(pagesize, 10) || 100))
  const j = (await weapiPost('/weapi/user/playlist', {
    uid: Number(acc.userId) || 0, limit: n, offset: (p - 1) * n, includeVideo: true, csrf_token: '',
  }, { cookie })).json
  assertOk(j, '我的歌单')
  const list = (j.playlist || []).map(normalizePlaylistItem)
  return list.map((item, i) => ({
    ...item,
    // 网易云用户歌单列表第一项恒为「我喜欢的音乐」（系统默认），其余为自建/收藏。
    // subscribed 字段区分收藏（true=收藏他人歌单）；自建歌单 creator 即本人。
    kind: i === 0 ? 'default' : (item.id && (j.playlist[i] || {}).subscribed === true ? 'collect' : 'own'),
    isLike: i === 0,
  }))
}

/**
 * 收藏 / 取消收藏歌单（需登录 cookie）。
 * ⚠️ 2025-09 真实登录态实测定主备：eapi `/eapi/playlist/subscribe|unsubscribe`
 * （body {id, checkToken:'v2'}）即使带登录态也返回 `{"code":404,"message":"接口未找到！"}`
 * ——老客户端端点已废弃（与 §2.3/§2.4 的「eapi 网关门禁、事实迁 xeapi」互证），不能作主路；
 * **weapi `/weapi/playlist/subscribe|unsubscribe` 是当前唯一可行路**，且 csrf_token 必须取
 * cookie 里的真实 `__csrf` 值（空串会被服务端以 `code 403 illegal request` 拒绝）。
 * 此处 weapi 主路 + eapi 探测兜底（仅收集报错消息、不拦截成功），code=200 即成功。
 * @param {string} id 歌单 id
 * @param {string} cookie 登录态 cookie（MUSIC_U; __csrf=…）
 * @param {'collect'|'uncollect'} action 收藏 / 取消收藏
 */
export async function subscribePlaylist(id, cookie = '', action = 'collect') {
  const pid = String(id).trim()
  if (!/^[0-9]+$/.test(pid)) throw new Error('bad playlist id')
  if (!cookie) throw new Error('未登录，无法收藏歌单')
  const sub = action === 'uncollect' ? 'unsubscribe' : 'subscribe'
  const csrf = cookieValue(cookie, '__csrf')
  const errors = []
  // 主路 weapi（实测 code=200 成功；csrf_token 必须与 cookie 内 __csrf 一致）
  try {
    const j = (await weapiPost(`/weapi/playlist/${sub}`, { id: pid, csrf_token: csrf }, { cookie })).json
    if (j && Number(j.code) === 200) return true
    errors.push((j && (j.message || j.msg)) || `weapi code=${j && j.code}`)
  } catch (e) { errors.push('weapi ' + ((e && e.message) || e)) }
  // 兜底 eapi：老客户端端点，实测登录态也 404「接口未找到」，仅作探测并透出服务端消息
  try {
    const j = (await eapiPost(`/eapi/playlist/${sub}`, { id: pid, checkToken: 'v2' }, { cookie })).json
    if (j && Number(j.code) === 200) return true
    errors.push((j && (j.message || j.msg)) || `eapi code=${j && j.code}`)
  } catch (e) { errors.push('eapi ' + ((e && e.message) || e)) }
  throw new Error((action === 'uncollect' ? '取消收藏失败：' : '收藏失败：') + errors.join('；'))
}

// =====================================================================
// 自建歌单写操作（创建 / 删除 / 歌曲加入·移除）——weapi，需登录 cookie。
// 2025-09 真实登录态全部实测：csrf_token 必须取 cookie 的 __csrf（空串 403），
// trackIds 为数组 JSON 字符串形态（如 '["123","456"]'）；加重复歌报 502「歌单内
// 歌曲重复」；版权受限(fee=8)歌也能加入。均不走 eapi（老端点已被网关门禁）。
// =====================================================================

/** 创建歌单（weapi /weapi/playlist/create）。privacy 0=公开 10=隐藏。返回新歌单。 */
export async function createPlaylist(name, cookie = '', privacy = 0) {
  if (!cookie) throw new Error('未登录，无法创建歌单')
  const n = String(name || '').trim()
  if (n === '') throw new Error('歌单名不能为空')
  const csrf = cookieValue(cookie, '__csrf')
  const j = (await weapiPost('/weapi/playlist/create', { name: n, privacy: Number(privacy) === 10 ? 10 : 0, csrf_token: csrf }, { cookie })).json
  assertOk(j, '创建歌单')
  const p = j.playlist || {}
  if (!p.id) throw new Error('创建歌单失败（服务端未返回歌单 id）')
  return {
    id: String(p.id),
    name: dec(p.name || n),
    cover: dec(p.coverImgUrl || ''),
    trackCount: 0,
    creator: '',
    source: 'nc',
    kind: 'own',
  }
}

/** 删除歌单（weapi /weapi/playlist/delete）。实测 code=200 即删除。 */
export async function deletePlaylist(id, cookie = '') {
  if (!cookie) throw new Error('未登录，无法删除歌单')
  const pid = String(id || '').trim()
  if (!/^[0-9]+$/.test(pid)) throw new Error('bad playlist id')
  const csrf = cookieValue(cookie, '__csrf')
  const j = (await weapiPost('/weapi/playlist/delete', { pid, csrf_token: csrf }, { cookie })).json
  if (!j || Number(j.code) !== 200) {
    const err = new Error('删除歌单失败：' + ((j && (j.message || j.msg)) || ('code=' + (j && j.code))))
    throw err
  }
  return true
}

/**
 * 歌曲加入 / 移出歌单（weapi /weapi/playlist/manipulate/tracks）。
 * trackIds 传歌曲 id 数组；op: 'add' 加入 / 'del' 移除。实测 code=200 即成功。
 */
export async function manipulateTracks(id, songIds, cookie = '', op = 'add') {
  if (!cookie) throw new Error('未登录，无法操作歌单')
  const pid = String(id || '').trim()
  if (!/^[0-9]+$/.test(pid)) throw new Error('bad playlist id')
  const ids = (Array.isArray(songIds) ? songIds : []).map((x) => String(x).trim()).filter((x) => /^[0-9]+$/.test(x))
  if (ids.length === 0) throw new Error('缺少歌曲 id')
  const act = op === 'del' ? 'del' : 'add'
  const csrf = cookieValue(cookie, '__csrf')
  const j = (await weapiPost('/weapi/playlist/manipulate/tracks', { op: act, pid, trackIds: JSON.stringify(ids), csrf_token: csrf }, { cookie })).json
  if (!j || Number(j.code) !== 200) {
    const err = new Error((act === 'del' ? '从歌单移除失败：' : '加入歌单失败：') + ((j && (j.message || j.msg)) || ('code=' + (j && j.code))))
    throw err
  }
  return true
}

// =====================================================================
// 取链（匿名可播：免费歌 320k 直链 / VIP 歌 45s 试听 / 版权歌 404）
// =====================================================================

const QUALITY_LABELS = { standard: '标准', exhigh: '高音质', lossless: '无损', hires: '无损', jyeffect: '无损', jymaster: '无损' }

/**
 * 取播放直链（weapi /weapi/song/enhance/player/url，br=999000 由服务端按账号权限授档）。
 * 返回 { url, level, br, fee, freeTrialInfo, code }；url 为空时上层按 fee/freeTrialInfo 提示。
 */
export async function getDownloadURL(id, cookie = '') {
  const sid = String(id).trim()
  if (!/^[0-9]+$/.test(sid)) throw new Error('bad song id')
  const j = (await weapiPost('/weapi/song/enhance/player/url', { ids: `[${sid}]`, br: 999000 }, { cookie: cookie || ANON_COOKIE })).json
  assertOk(j, '取链')
  const d = (j.data && j.data[0]) || {}
  return {
    id: sid,
    url: d.url || '',
    level: d.level || '',
    br: Number(d.br) || 0,
    fee: Number(d.fee) || 0,
    code: Number(d.code) || 0,
    freeTrialInfo: d.freeTrialInfo || null,
    quality: QUALITY_LABELS[d.level] || '',
  }
}

// =====================================================================
// 歌词：LRC + 逐句翻译 + 罗马音（匿名可用）；YRC 逐字（yv 参数，可选）
// =====================================================================

/**
 * 歌词（保底 GET /api/song/lyric；主路 weapi /weapi/song/lyric 带 yv 可拿 YRC）。
 * 返回 { lyric, trans, roma, yrc }（trans/roma/yrc 无则空串）。yrc 为逐字原文，由调用方
 * 决定是否用 lib/yrc.js 解析。
 */
export async function getLyric(id, cookie = '') {
  const sid = String(id).trim()
  if (!/^[0-9]+$/.test(sid)) throw new Error('bad song id')
  const ck = cookie || ANON_COOKIE
  // 主路 weapi（含 yv 逐字探测）
  let j = null
  try {
    j = (await weapiPost('/weapi/song/lyric', { csrf_token: '', id: sid, lv: -1, tv: -1, rv: -1, yv: -1 }, { cookie: ck })).json
  } catch { /* 回落 GET */ }
  if (!j || Number(j.code) !== 200) {
    j = (await getJson(`https://music.163.com/api/song/lyric?id=${sid}&lv=-1&kv=-1&tv=-1`)).json
  }
  if (!j || Number(j.code) !== 200) throw new Error(`歌词获取失败（code=${j && j.code}）`)
  const lrc = (j.lrc && j.lrc.lyric) || ''
  const yrc = (j.yrc && j.yrc.lyric) || ''
  if (lrc === '' && yrc === '') throw new Error('未获取到歌词')
  return {
    lyric: lrc,
    trans: (j.tlyric && j.tlyric.lyric) || '',
    roma: (j.romalrc && j.romalrc.lyric) || '',
    yrc,
  }
}

// =====================================================================
// 扫码登录（两跳直达 MUSIC_U；interface.music.163.com 裸表单，无需加密）
// =====================================================================

/**
 * ① 出码：返回 { source:'nc', key:unikey, imageDataUrl, url, expiresAt }。
 * 二维码内容 = https://music.163.com/login?codekey=<unikey>，用网易云 App 扫码。
 */
export async function createQRLogin() {
  const res = await formPost('https://interface.music.163.com/api/login/qrcode/unikey', { type: 3 }, { ua: UA_DESKTOP })
  if (!res.json || Number(res.json.code) !== 200 || !res.json.unikey) {
    throw new Error(`网易云出码失败（code=${res.json && res.json.code}，HTTP ${res.status}）`)
  }
  const unikey = String(res.json.unikey)
  const loginUrl = 'https://music.163.com/login?codekey=' + encodeURIComponent(unikey)
  return {
    source: 'nc',
    key: unikey,
    url: loginUrl,
    imageDataUrl: qrSvgDataUrl(loginUrl),
    expiresAt: Date.now() + 5 * 60 * 1000,
    extra: { codekey: unikey },
  }
}

/** 内嵌 qrcode-generator 把文本渲染成 SVG data URL（供 <img> 直接展示）。 */
export function qrSvgDataUrl(content) {
  const qr = qrcode(0, 'M')
  qr.addData(String(content || ''))
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 4, margin: 2 })
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}

function mapQRStatus(code) {
  return { 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'success' }[Number(code)] || 'failed'
}

/**
 * ② 轮询。成功（803）时响应体带 cookie 串（含 MUSIC_U/__csrf_token），
 * 同时 Set-Cookie 亦下发；返回 result.cookies/cookie 供落库。
 */
export async function checkQRLogin(keyStr) {
  const key = String(keyStr || '').trim()
  if (key === '') throw new Error('网易云扫码 key 缺失')
  const res = await formPost('https://interface.music.163.com/api/login/qrcode/client/login', { key, type: 3 }, { ua: UA_DESKTOP })
  const j = res.json || {}
  const status = mapQRStatus(j.code)
  const result = {
    source: 'nc',
    key,
    status,
    message: { expired: '二维码已过期', waiting: '等待扫码中', scanned: '已扫码，请在网易云音乐 App 中确认', success: '登录成功' }[status] || (j.message || '状态未知'),
    extra: { code: Number(j.code) },
  }
  if (status === 'success') {
    // 优先取响应体里的 cookie 串（comma 分隔的完整串），否则从 Set-Cookie 收集
    let cookie = String(j.cookie || '').trim()
    const cookies = {}
    if (!cookie) {
      for (const sc of res.setCookie) {
        const p = sc.split(';')[0]
        const i = p.indexOf('=')
        if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim()
      }
      cookie = Object.keys(cookies).filter((k) => cookies[k]).map((k) => `${k}=${cookies[k]}`).join('; ')
    }
    if (!cookie) { result.status = 'failed'; result.message = '登录成功但未取到 cookie，请重试'; return result }
    result.cookie = cookie
    result.cookies = cookies
  }
  return result
}

// =====================================================================
// 播放器内部用：把账号信息合并进 cookie 串（authst 之类不需要，网易云纯 cookie）
// =====================================================================

/** 从 cookie 串里取单个字段值（小工具，路由层判断登录态用）。 */
export function cookieValue(cookie, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(String(cookie || ''))
  return m ? m[1].trim() : ''
}
