/**
 * lib/qq.js — QQ 音乐「扫码登录 + 在线搜索 + 登录态取链」底层模块。
 *
 * 纯 Node（Node ≥ 20，用全局 fetch），无第三方依赖，无编译步骤。
 * 实现参考 guohuiyuan/music-lib 的 qq/ 包（go-music-dl 的底层库），移植为 ESM：
 *   - 纯 QQ 扫码：ssl.ptlogin2.qq.com/ptqrshow + ptqrlogin（需大陆 IP，接口有地理/WAF 风控）
 *   - 微信扫码：open.weixin.qq.com/connect/qrconnect + lp.open.weixin.qq.com（各地可达）
 *   - 取链：u.y.qq.com/cgi-bin/musicu.fcg 的 music.vkey.GetVkey / UrlGetVkey（登录态可选高音质）
 *
 * ⚠️ 合规：均为非官方接口 + 流播受版权保护音乐，仅用于个人试听/学习，违反平台 ToS，风险自担。
 */

import { decryptHex as qrcDecryptHex, parseQrc as qrcParse } from './qrc.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const REF_WX = 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/'
const WX_APPID = 'wx48db31d50e334801'
const WX_CONNECT = 'https://open.weixin.qq.com/connect/qrconnect'
const WX_CHECK = 'https://lp.open.weixin.qq.com/connect/l/qrconnect'
const QQ_SHOW = 'https://ssl.ptlogin2.qq.com/ptqrshow'
const QQ_CHECK = 'https://ssl.ptlogin2.qq.com/ptqrlogin'

// QQ/微信端点到 Host 的网络不稳定（尤其微信 check 端点偶发挂起），Node 的
// fetch 默认无超时，一旦端点不响应，登录轮询会永久卡住、模态窗停在扫码界面。
// 统一给所有出网请求加超时（AbortController），超时即抛错，由 Host/前端继续轮询。
async function fetchWithTimeout(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// hash33: 与 QQ ptlogin 的 Go 参考实现一致 —— Go 源码为 `h += (h<<5) + c`，等价于 `h = h*33 + c`。
// 注意：不是 `h*32 + c`（即缺少 +h 会算错 ptqrtoken，导致 ptqrlogin 返回 403）。
export function hash33(s) { let h = 0; for (const c of s) h = ((h * 33) + c.charCodeAt(0)) >>> 0; return h & 0x7fffffff }

function responseCookies(res) {
  const out = {}
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  for (const c of list) {
    const p = c.split(';')[0]; const i = p.indexOf('='); if (i < 0) continue
    const k = p.slice(0, i).trim(); const v = p.slice(i + 1).trim()
    // Set-Cookie 里可能同时给「真实值」和「删除标记」（空值 + Expires=1970 / Max-Age=0）。
    // 空值删除标记不应覆盖已有的真实值（否则会把 p_skey / p_uin 等清空）。
    if (v === '' && out[k] != null && out[k] !== '') continue
    out[k] = v
  }
  return out
}
export function joinCookieMap(cookies) {
  return Object.keys(cookies).filter(k => k.trim() && (cookies[k] || '').trim()).sort().map(k => `${k}=${cookies[k]}`).join('; ')
}

// =====================================================================
// 纯 QQ 扫码（ptqrshow / ptqrlogin）。ptqrlogin 凭证端点在非大陆 IP 下会被风控拦 403。
// =====================================================================
export async function createQRLogin() {
  const p = new URLSearchParams()
  p.set('appid', '716027609'); p.set('e', '2'); p.set('l', 'M'); p.set('s', '3'); p.set('d', '72'); p.set('v', '4')
  p.set('t', (Date.now() / 1e12).toFixed(17)) // == go: float64(UnixNano)/1e18
  p.set('daid', '383'); p.set('pt_3rd_aid', '100497308')
  const res = await fetchWithTimeout(`${QQ_SHOW}?${p.toString()}`, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/' }, redirect: 'manual' })
  if (res.status !== 200) throw new Error(`qq qr show http ${res.status}`)
  const image = Buffer.from(await res.arrayBuffer())
  const cookies = responseCookies(res)
  const qrsig = (cookies.qrsig || '').trim()
  if (!qrsig) throw new Error('qq qr show missing qrsig')
  return {
    source: 'qq', key: new URLSearchParams({ qrsig }).toString(),
    imageDataUrl: `data:image/png;base64,${image.toString('base64')}`,
    expiresAt: Date.now() + 2 * 60 * 1000,
    extra: { qrsig },
  }
}

export async function checkQRLogin(keyStr) {
  const v = new URLSearchParams(keyStr)
  const qrsig = (v.get('qrsig') || '').trim()
  if (!qrsig) throw new Error('qq qr login key missing qrsig')
  const p = new URLSearchParams()
  p.set('u1', 'https://graph.qq.com/oauth2.0/login_jump')
  p.set('ptqrtoken', String(hash33(qrsig)))
  p.set('ptredirect', '100'); p.set('h', '1'); p.set('t', '1'); p.set('g', '1'); p.set('from_ui', '1'); p.set('ptlang', '2052')
  p.set('action', `0-0-${Date.now()}`)
  p.set('js_ver', '21072115'); p.set('js_type', '1'); p.set('login_sig', '')
  p.set('pt_uistyle', '40'); p.set('aid', '716027609'); p.set('daid', '383'); p.set('pt_3rd_aid', '100497308')
  p.set('has_onekey', '1'); p.set('pttype', '1'); p.set('service', 'ptqrlogin'); p.set('nodirect', '0')
  const res = await fetchWithTimeout(`${QQ_CHECK}?${p.toString()}`, {
    headers: { 'User-Agent': UA, 'Referer': 'https://xui.ptlogin2.qq.com/', 'Cookie': `qrsig=${qrsig}` },
    redirect: 'manual',
  })
  if (res.status !== 200) return { source: 'qq', key: keyStr, status: 'failed', message: `http ${res.status}`, extra: {} }
  const raw = await res.text()
  const [code, redirectURL, message] = parseQQQRCheck(raw)
  const result = { source: 'qq', key: keyStr, status: mapQQQRStatus(code), message, extra: { code } }
  if (result.status !== 'success') return result
  let cookies = responseCookies(res)
  if (redirectURL) { try { cookies = await fetchQQRedirectCookies(redirectURL, cookies) } catch (e) { result.extra.redirect_error = e.message } }
  // 关键：QQ 扫码成功拿到的是 QQ 网页 cookie（uin/superkey…），本身不含 QQ 音乐的 musickey。
  // 参照 GitHub-ZC/wp_MusicApi util/login_qq_scan.js：需再走「graph.qq.com OAuth 换取 code →
  // musicu.fcg QQConnectLogin.LoginServer/QQLogin 换 musickey」两步，才能拿到 qm_keyst/musickey。
  // 否则 getMyPlaylists 等接口因缺 authst 报 code 80030（未登录）。
  try { cookies = await exchangeQQMusicAuthst(cookies, redirectURL, result) } catch (e) { result.extra.authst_error = e.message }
  result.cookies = normalizeQQMusicCookies(cookies)
  result.cookie = joinCookieMap(result.cookies)
  return result
}

// 参考 GitHub-ZC/wp_MusicApi util/login_qq_scan.js：QQ 扫码登录后补齐 QQ 音乐登录态（musickey）。
// 步骤：① 跟随 pt_auth_key 跳转收集 graph.qq.com cookie；② OAuth authorize 拿 code；
//       ③ musicu.fcg QQConnectLogin.LoginServer/QQLogin 用 code 换 musickey。
async function exchangeQQMusicAuthst(cookies, redirectURL, result) {
  // 直接从 cookies 对象读取（不经过 joinCookieMap，避免它过滤掉空值/特殊字符的 key）。
  const getC = (k) => { const v = cookies && typeof cookies === 'object' ? cookies[k] : undefined; return v != null ? String(v).trim() : '' }
  const graphCookie = joinCookieMap(cookies)
  const gtkSrc = getC('p_skey') || getC('skey') || getC('qqmusic_key') || getC('p_lskey') || getC('lskey') || getC('qm_keyst') || getC('p_skey_forbid')
  const g_tk = qqGtk(gtkSrc)
  const OAuth = 'https://graph.qq.com/oauth2.0/authorize'
  const OAuthRedirect = 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/'
  const ui = 'DFEC5395-9E69-4D3E-96A6-300BB770874D'
  const oauthParams = new URLSearchParams()
  oauthParams.set('response_type', 'code'); oauthParams.set('client_id', '100497308')
  oauthParams.set('redirect_uri', OAuthRedirect); oauthParams.set('scope', 'all'); oauthParams.set('state', 'state')
  oauthParams.set('switch', ''); oauthParams.set('from_ptlogin', '1'); oauthParams.set('src', '1')
  oauthParams.set('update_auth', '1'); oauthParams.set('openapi', '80901010_1030'); oauthParams.set('g_tk', String(g_tk))
  oauthParams.set('auth_time', String(Date.now())); oauthParams.set('ui', ui)
  const oauthRes = await fetchWithTimeout(OAuth, { method: 'POST', headers: { 'User-Agent': UA, 'Referer': 'https://xui.ptlogin2.qq.com/', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': graphCookie }, body: oauthParams.toString(), redirect: 'manual' })
  const location = oauthRes.headers.get('location') || ''
  for (const [k, v] of Object.entries(responseCookies(oauthRes))) cookies[k] = v
  let code = (location.match(/[?&]code=([^&]+)/) || [])[1] || (location.match(/[?&]code%3D([^&]+)/) || [])[1] || ''
  if (!code && getC('qm_keyst') && getC('uin')) return cookies
  if (!code) { result.extra.oauth_no_code = location.slice(0, 120); return cookies }
  // ③ musicu.fcg QQLogin 换 musickey
  const payload = JSON.stringify({ comm: { g_tk: 5381, platform: 'yqq', ct: 24, cv: 0 }, req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } } })
  const QQLoginCookie = joinCookieMap(cookies)
  const endpoints = ['https://u.y.qq.com/cgi-bin/musicu.fcg', 'https://szu.y.qq.com/cgi-bin/musicu.fcg', 'https://shu.y.qq.com/cgi-bin/musicu.fcg']
  let lastErr
  for (const api of endpoints) {
    const r = await fetchWithTimeout(api, { method: 'POST', headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/', 'Origin': 'https://y.qq.com', 'Accept': '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': QQLoginCookie }, body: payload })
    const body = await r.text()
    for (const [k, v] of Object.entries(responseCookies(r))) if (!cookies[k]) cookies[k] = v
    if (r.status !== 200) { lastErr = new Error(`qq login http ${r.status}`); continue }
    let parsed; try { parsed = parseJsonPreserveBigInt(body) } catch { lastErr = new Error('qq login json'); continue }
    if (parsed.code !== 0 || parsed.req?.code !== 0) { lastErr = new Error(`qq login api error: ${parsed.req?.message || parsed.req?.msg || parsed.message || parsed.msg}`); continue }
    // 从响应 data 提取 musickey（与微信类似）
    const data = parsed.req?.data || {}
    const dataCookies = wxLoginDataCookies(data)
    for (const [k, v] of Object.entries(dataCookies)) if (!cookies[k]) cookies[k] = v
    const mu = cookies.musickey || cookies.qqmusic_key || cookies.qm_keyst
    if (mu) { cookies.qqmusic_key = mu; cookies.qm_keyst = mu; if (!cookies.uin) cookies.uin = cookies.musicid || cookies.uin }
    return cookies
  }
  if (lastErr) result.extra.authst_api_error = lastErr.message
  return cookies
}

function parseQQQRCheck(raw) {
  const matches = raw.match(/'([^']*)'/g) || []
  const codes = matches.map(m => m.slice(1, -1))
  return [codes[0] || '', codes[2] || '', codes[4] || '']
}
function mapQQQRStatus(code) { return { '0': 'success', '65': 'expired', '66': 'waiting', '67': 'scanned' }[code] || 'failed' }

async function fetchQQRedirectCookies(redirectURL, cookies) {
  let currentURL = redirectURL
  const collected = { ...cookies }
  let referer = 'https://y.qq.com/'
  for (let i = 0; i < 8 && currentURL; i++) {
    const res = await fetchWithTimeout(currentURL, { headers: { 'User-Agent': UA, 'Referer': referer, 'Cookie': joinCookieMap(collected) }, redirect: 'manual' })
    for (const [k, v] of Object.entries(responseCookies(res))) collected[k] = v
    const location = res.headers.get('location')
    if (!location || res.status < 300 || res.status >= 400) break
    currentURL = new URL(location, currentURL).toString()
    referer = currentURL
  }
  return collected
}

// =====================================================================
// 微信扫码（open.weixin.qq.com / lp.open.weixin.qq.com）—— 各地可达。
// =====================================================================
export async function createWXQRLogin() {
  const state = `music-lib-${Date.now()}`
  const p = new URLSearchParams()
  p.set('appid', WX_APPID); p.set('redirect_uri', REF_WX); p.set('response_type', 'code')
  p.set('scope', 'snsapi_login'); p.set('state', state)
  p.set('href', 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect')
  const loginURL = `${WX_CONNECT}?${p.toString()}`
  const res = await fetchWithTimeout(loginURL, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/' }, redirect: 'manual' })
  if (res.status !== 200) throw new Error(`wx qr connect http ${res.status}`)
  const body = await res.text()
  const uuid = parseWXUUID(body)
  if (!uuid) throw new Error('wx qr connect missing uuid')
  const imageUrl = `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`
  let imageDataUrl = ''
  try {
    const imgRes = await fetchWithTimeout(imageUrl)
    const img = Buffer.from(await imgRes.arrayBuffer())
    const ext = looksLikePng(img) ? 'png' : 'jpeg'
    imageDataUrl = `data:image/${ext};base64,${img.toString('base64')}`
  } catch { /* 拉图失败则让浏览器直接加载 imageUrl */ }
  return {
    source: 'qq', key: new URLSearchParams({ type: 'wx', uuid, state }).toString(),
    url: loginURL, imageUrl, imageDataUrl,
    expiresAt: Date.now() + 5 * 60 * 1000,
    extra: { login_type: 'wx', uuid, state },
  }
}
function looksLikePng(buf) { return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 }

export async function checkWXQRLogin(keyStr) {
  const v = new URLSearchParams(keyStr)
  const uuid = (v.get('uuid') || '').trim()
  const state = (v.get('state') || 'STATE').trim()
  if (!uuid) throw new Error('wx qr login key missing uuid')
  // 微信 check 端点是【长轮询】：连接会挂起约 15s 后才返回状态（wx_errcode）。
  // 超时必须 >15s，否则长轮询还没返回就被 abort，永远读不到状态（扫码界面卡死）。
  const res = await fetchWithTimeout(`${WX_CHECK}?${new URLSearchParams({ uuid, _: String(Date.now()) }).toString()}`, { headers: { 'User-Agent': UA, 'Referer': WX_CONNECT }, redirect: 'manual' }, 25000)
  const raw = await res.text()
  const [code, wxCode] = parseWXCheck(raw)
  const status = mapWXStatus(code)
  const message = { '405': '登录成功', '402': '二维码已过期', '404': '已扫码，请在微信中确认', '408': '等待扫码中' }[code] || raw.trim()
  const result = { source: 'qq', key: keyStr, status, message, extra: { code, login_type: 'wx' } }
  if (status !== 'success') return result
  if (!wxCode) { result.status = 'failed'; result.message = 'wechat auth code missing'; return result }
  const { cookies, extra } = await exchangeWXCodeForCookies(wxCode)
  for (const k of Object.keys(extra)) result.extra[k] = extra[k]
  result.extra.state = state
  result.cookies = normalizeQQMusicCookies(cookies)
  result.cookie = joinCookieMap(result.cookies)
  return result
}
function parseWXCheck(raw) {
  const code = (raw.match(/wx_errcode\s*=\s*'?([0-9]+)'?/) || [])[1] || ''
  const wxCode = (raw.match(/wx_code\s*=\s*["']([^"']*)["']/) || [])[1] || ''
  return [code, wxCode]
}
function mapWXStatus(code) { return { '405': 'success', '402': 'expired', '404': 'scanned', '408': 'waiting' }[code] || 'failed' }

// 保留大整数的 JSON 解析：QQ 音乐微信登录返回的 musicid/uin 高达 1e18（远超
// JS 安全整数 2^53），用 JSON.parse 会丢精度，导致拿到的 uin 是错的、歌单变成
// 别人的。此解析器把超出安全范围的整数字面量保留为字符串，避免精度丢失。
export function parseJsonPreserveBigInt(text) {
  let i = 0
  const ws = () => { while (i < text.length && /[\s]/.test(text[i])) i++ }
  const parseValue = () => {
    ws()
    const c = text[i]
    if (c === '{') return parseObject()
    if (c === '[') return parseArray()
    if (c === '"') return parseString()
    if (text.startsWith('true', i)) { i += 4; return true }
    if (text.startsWith('false', i)) { i += 5; return false }
    if (text.startsWith('null', i)) { i += 4; return null }
    return parseNumber()
  }
  const parseObject = () => {
    i++
    const o = {}
    ws()
    if (text[i] === '}') { i++; return o }
    for (;;) {
      ws()
      const k = parseString()
      ws()
      if (text[i] === ':') i++
      o[k] = parseValue()
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === '}') { i++; return o }
      throw new Error('bad object')
    }
  }
  const parseArray = () => {
    i++
    const a = []
    ws()
    if (text[i] === ']') { i++; return a }
    for (;;) {
      a.push(parseValue())
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === ']') { i++; return a }
      throw new Error('bad array')
    }
  }
  const parseString = () => {
    i++
    let s = ''
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') {
        i++
        const e = text[i]
        if (e === 'n') s += '\n'
        else if (e === 't') s += '\t'
        else if (e === 'r') s += '\r'
        else if (e === 'b') s += '\b'
        else if (e === 'f') s += '\f'
        else if (e === 'u') { s += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16)); i += 4 }
        else s += e
        i++
      } else { s += text[i]; i++ }
    }
    i++
    return s
  }
  const parseNumber = () => {
    const start = i
    if (text[i] === '-') i++
    while (i < text.length && /[0-9]/.test(text[i])) i++
    let isFloat = false
    if (text[i] === '.') { isFloat = true; i++; while (i < text.length && /[0-9]/.test(text[i])) i++ }
    if (text[i] === 'e' || text[i] === 'E') { isFloat = true; i++; if (text[i] === '+' || text[i] === '-') i++; while (i < text.length && /[0-9]/.test(text[i])) i++ }
    const raw = text.slice(start, i)
    if (isFloat) return Number(raw)
    const n = Number(raw)
    return Number.isSafeInteger(n) ? n : raw // 超出安全范围 → 保留字符串
  }
  return parseValue()
}

async function exchangeWXCodeForCookies(wxCode) {
  const payload = JSON.stringify({
    comm: { tmeAppID: 'qqmusic', tmeLoginType: '1', g_tk: 5381, platform: 'yqq', ct: 24, cv: 0 },
    req: { module: 'music.login.LoginServer', method: 'Login', param: { strAppid: WX_APPID, code: wxCode } },
  })
  const endpoints = ['https://u.y.qq.com/cgi-bin/musicu.fcg', 'https://szu.y.qq.com/cgi-bin/musicu.fcg', 'https://shu.y.qq.com/cgi-bin/musicu.fcg']
  let lastErr
  for (const api of endpoints) {
    const res = await fetchWithTimeout(api, { method: 'POST', headers: { 'User-Agent': UA, 'Referer': REF_WX, 'Origin': 'https://y.qq.com', 'Accept': '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': 'login_type=2' }, body: payload })
    const body = await res.text()
    const cookies = responseCookies(res)
    if (res.status !== 200) { lastErr = new Error(`wx login http ${res.status}`); continue }
    let parsed; try { parsed = parseJsonPreserveBigInt(body) } catch { lastErr = new Error('wx login json parse'); continue }
    if (parsed.code !== 0 || parsed.req?.code !== 0) { lastErr = new Error(`wx login api error: ${parsed.req?.message || parsed.req?.msg || parsed.message || parsed.msg}`); continue }
    const data = parsed.req?.data || {}
    for (const [k, val] of Object.entries(wxLoginDataCookies(data))) if (!cookies[k]) cookies[k] = val
    return { cookies, extra: { endpoint: api, nickname: wxLoginNickname(data) } }
  }
  throw lastErr || new Error('wx login failed')
}
function val(data, ...keys) { for (const k of keys) { const v = data[k]; if (typeof v === 'string' && v.trim()) return v.trim(); if (typeof v === 'number' && v > 0) return String(v) } return '' }
// 尽力从微信登录响应里取一个可展示的昵称（不同版本键名不一，做兜底）。
// decodeEntities 是函数声明（提升），此处可安全引用；昵称也可能带 HTML 实体。
function wxLoginNickname(data) {
  const direct = val(data, 'nickname', 'nick', 'name', 'user_name', 'strNickname', 'stringName', 'wx_nickname', 'nickName')
  if (direct) return decodeEntities(direct)
  const nested = data && typeof data === 'object' && (data.profile || data.user_info || data.userInfo || data.baseInfo)
  if (nested && typeof nested === 'object') return decodeEntities(val(nested, 'nickname', 'nick', 'name', 'user_name', 'nickName'))
  return ''
}
function wxLoginDataCookies(data) {
  const r = {}
  const musicID = val(data, 'musicid', 'musicId', 'userid', 'user_id', 'uin'); if (musicID) r.musicid = musicID
  const musicKey = val(data, 'musickey', 'music_key', 'qqmusic_key', 'qm_keyst', 'strMusicKey'); if (musicKey) { r.musickey = musicKey; r.qqmusic_key = musicKey; r.qm_keyst = musicKey }
  const refreshKey = val(data, 'refresh_key', 'refreshKey'); if (refreshKey) r.refresh_key = refreshKey
  const refreshToken = val(data, 'refresh_token', 'refreshToken'); if (refreshToken) r.refresh_token = refreshToken
  const openID = val(data, 'openid', 'openId', 'wxopenid', 'strOpenid'); if (openID) { r.openid = openID; r.wxopenid = openID }
  const unionID = val(data, 'unionid', 'unionId', 'wxunionid', 'strUnionid'); if (unionID) { r.unionid = unionID; r.wxunionid = unionID }
  const accessToken = val(data, 'access_token', 'accessToken', 'wxaccess_token'); if (accessToken) r.wxaccess_token = accessToken
  // encrypt_uin：部分读接口（如 CgiGetDiss 取「我喜欢」）需要 enc_host_uin。
  const encUin = val(data, 'encrypt_uin', 'encryptUin', 'encuin', 'euin', 'str_encrypt_uin'); if (encUin) r.encrypt_uin = encUin
  return r
}

export function normalizeQQMusicCookies(cookies) {
  const r = { ...cookies }
  const first = (...xs) => { for (const x of xs) { if (x && String(x).trim()) return String(x).trim() } return '' }
  if (!r.uin) r.uin = first(r.ptui_loginuin, r.luin, r.pt2gguin, r.superuin, r.p_uin, r.musicid, r.userid, r.wxuin)
  if (!r.qqmusic_key) r.qqmusic_key = first(r.p_skey, r.skey, r.musickey)
  if (!r.qm_keyst) r.qm_keyst = r.qqmusic_key
  // 避免给 cookie map 塞 undefined/null 值（joinCookieMap / 后续字符串处理会崩溃）
  for (const k of Object.keys(r)) if (r[k] == null) delete r[k]
  return r
}

function parseWXUUID(raw) {
  const pats = [/connect\/l\/qrconnect\?uuid=([A-Za-z0-9_-]+)/, /window\.QRLogin\.uuid\s*=\s*"([^"]+)"/, /\/connect\/qrcode\/([A-Za-z0-9_-]+)/]
  for (const re of pats) { const m = raw.match(re); if (m && m[1]) return m[1] }
  return ''
}

// =====================================================================
// 搜索（legacy，匿名可用）与登录态取链（UrlGetVkey，可反 VIP/高音质）
// =====================================================================
// 歌曲搜索：支持分页（page 从 1 起，每页 n=60，即接口单请求上限；实测 n≥61 仍只回 60、
// n≥100 直接返回空）。返回 { results, total, page }，total 为接口返回的总条数
// （totalnum，实测热门词可达 600+，故单请求拿不全、前端仍需「加载更多」）。
export async function search(keyword, cookie = '', page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${new URLSearchParams({ w: keyword, format: 'json', p: String(p), n: '60', t: '0', cr: '1' }).toString()}`
  const headers = { 'User-Agent': UA, 'Referer': 'https://y.qq.com/' }
  if (cookie) headers['Cookie'] = cookie
  const res = await fetchWithTimeout(url, { headers })
  const j = await res.json()
  const results = (j.data?.song?.list || []).map(s => ({
    id: s.songmid, songmid: s.songmid, title: dec(s.songname),
    songid: s.songid, songtype: s.songtype || 0,
    artists: (s.singer || []).map(x => dec(x.name)),
    album: dec(s.albumname), interval: s.interval,
    payplay: s.pay?.payplay, pay: s.pay,
    source: 'qq',
  }))
  const total = Number(j.data?.song?.totalnum) || results.length
  return { results, total, page: p }
}

export async function detectVip(cookie) {
  if (!cookie) return false
  const songMID = '004YZbkL2MNHoY'
  // VIP 探测用无损档（FLAC）：无损只有 VIP 会员能取到；M500/M800 免费档在 VIP 歌曲上
  // 往往被锁（无 purl），用它探测会把 VIP 账号误判为非 VIP。四个无损档都试一遍，
  // 任一能取到即视为 VIP。
  const prefixes = ['AI00', 'Q001', 'Q000', 'F000']
  const filenames = prefixes.map((p) => `${p}${songMID}${songMID}.flac`)
  const body = urlGetVkeyBody(cookie, prefixes.map(() => songMID), filenames)
  const j = await postMusicu(body, cookie)
  if (j.req_1?.code !== 0) return false
  return (j.req_1?.data?.midurlinfo || []).some((x) => x && x.purl)
}

export async function getDownloadURL(songmid, cookie = '', isVip = false) {
  const prefixes = isVip ? ['AI00', 'Q001', 'Q000', 'F000', 'O801', 'M800', 'M500'] : ['M800', 'M500']
  const exts = isVip ? ['flac', 'flac', 'flac', 'flac', 'ogg', 'mp3', 'mp3'] : ['mp3', 'mp3']
  const filenames = prefixes.map((p, i) => `${p}${songmid}${songmid}.${exts[i]}`)
  const body = urlGetVkeyBody(cookie, prefixes.map(() => songmid), filenames)
  const j = await postMusicu(body, cookie)
  const infos = j.req_1?.data?.midurlinfo || []
  for (const f of filenames) { const info = infos.find(x => x.filename === f); if (info && info.purl) return { url: 'https://ws.stream.qqmusic.qq.com/' + info.purl, filename: f } }
  return { url: '', filename: '' }
}

function urlGetVkeyBody(cookie, songmids, filenames) {
  return {
    comm: { cv: 4747474, ct: 24, format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, platform: 'yqq.json', needNewCode: 1, uin: 0 },
    req_1: { module: 'music.vkey.GetVkey', method: 'UrlGetVkey', param: { guid: String(Math.floor(Math.random() * 9e9) + 1e9), songmid: songmids, songtype: songmids.map(() => 0), uin: '0', loginflag: 1, platform: '20', filename: filenames } },
  }
}
async function postMusicu(body, cookie) {
  const headers = { 'User-Agent': UA, 'Referer': 'http://y.qq.com', 'Content-Type': 'application/json' }
  if (cookie) headers['Cookie'] = cookie
  const res = await fetchWithTimeout('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST', headers, body: JSON.stringify(body) })
  return res.json()
}

// =====================================================================
// 歌单：推荐 / 分类 / 分类歌单 / 歌单搜索 / 歌单歌曲（均匿名可用，登录只影响 VIP 可播性）
// 参考 go-music-dl/music-lib qq/playlist.go。
// =====================================================================
const httpsCover = (u) => (u || '').replace(/^http:/, 'https:')
const plLink = (id) => `https://y.qq.com/n/ryqq/playlist/${id}`
// 解码 QQ 音乐接口返回的 HTML 实体（标题/描述/歌手名里可能带 &#...; 或 &amp; 等）。
export function decodeEntities(str) {
  if (typeof str !== 'string' || str === '') return str
  return str
    .replace(/&#(\d+);/g, (m, n) => { const cp = Number(n); return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { const cp = parseInt(h, 16); return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
}
const dec = decodeEntities

// 歌词：经典 fcg 接口（fcg_query_lyric_new），nobase64=1 直接返回纯 LRC 文本
// （含 [ti:]/[ar:]/[offset:] 元数据与 [mm:ss] 时间戳）。匿名可访问；`trans` 为
// 逐句翻译（部分外语歌才有）。与取链同构：纯 Node fetch、超时、HTML 实体解码。
export async function getLyric(songmid, cookie = '') {
  const p = new URLSearchParams({
    songmid, format: 'json', nobase64: '1', g_tk: '5381', loginUin: '0', hostUin: '0',
    inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq.json', needNewCode: '0',
  })
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${p.toString()}`
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/', ...(cookie ? { Cookie: cookie } : {}) } })
  const j = await res.json().catch(() => null)
  if (!j || j.retcode !== 0 || typeof j.lyric !== 'string' || j.lyric === '') {
    throw new Error('未获取到歌词（retcode=' + ((j && j.retcode) || res.status) + '）')
  }
  return { lyric: dec(j.lyric), trans: typeof j.trans === 'string' ? dec(j.trans) : '' }
}

// =====================================================================
// 逐字歌词（QRC）：GetPlayLyricInfo 匿名接口。param 要求数字 songID + 时长 +
// 歌名/歌手/专辑的 base64（与 y.qq.com 客户端行为一致），qrc:1 表示想要逐字流。
// 响应 data.lyric 是 hex 密文；data.qrc_t ≠ 0 才代表这首歌确实有逐字歌词，
// 否则（qrc_t=0 而 lrc_t≠0）只是回落了普通 LRC —— 此时返回 null 让调用方走 LRC 路径。
// 解密/解析委托给 lib/qrc.js（独立实现的自定义 3DES + zlib inflate + 行解析）。
// 所有网络/解密错误一律向上抛错，由调用方（lyric.js 编排层）静默回落，不打扰播放。
// =====================================================================

// songmid → 数字 songID 等信息：经典单曲详情端点（匿名 GET）。
// QRC 接口只认数字 ID，而在线播放链路手里只有 songmid —— 这个端点补上缺环。
// 失败抛错由调用方静默处理（回落普通 LRC，不影响播放）。
export async function getSongInfoByMid(songmid, cookie = '') {
  const p = new URLSearchParams({ songmid: String(songmid), format: 'json' })
  const url = `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?${p.toString()}`
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/', ...(cookie ? { Cookie: cookie } : {}) } })
  const j = await res.json().catch(() => null)
  const s = Array.isArray(j && j.data) && j.data[0]
  if (!s || !Number(s.id)) throw new Error('单曲信息未找到（songmid=' + songmid + '）')
  return {
    songid: Number(s.id),
    interval: Math.round(Number(s.interval) || 0),
    title: dec(s.name || ''),
    artist: (s.singer || []).map((x) => dec(x.name)).join('/'),
    album: dec((s.album && s.album.name) || ''),
  }
}

export async function getQrcLyric({ songid, interval, title = '', artist = '', album = '' }, cookie = '') {
  const idNum = Number(songid)
  if (!Number.isFinite(idNum) || idNum <= 0) throw new Error('qrc 缺少数字 songid')
  const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64')
  const param = {
    albumName: b64(album),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: Math.max(0, Math.round(Number(interval) || 0)),
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: b64(artist),
    songID: idNum,
    songName: b64(title),
    trans: 1,
    trans_t: 0,
    type: 0,
  }
  const body = JSON.stringify({
    comm: { ct: '19', cv: '2111', format: 'json' },
    req: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param },
  })
  const res = await fetchWithTimeout('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body,
  })
  const j = await res.json().catch(() => null)
  if (!j || Number(j.code) !== 0) throw new Error(`GetPlayLyricInfo code=${j && j.code}`)
  const r = j.req || {}
  if (Number(r.code) !== 0) throw new Error(`GetPlayLyricInfo req.code=${r.code}`)
  const data = r.data || {}
  const cipherHex = typeof data.lyric === 'string' ? data.lyric : ''
  if (cipherHex === '') return null
  const hasWordData = String(data.qrc_t ?? '0') !== '0'
  if (!hasWordData) return null // 只有普通 LRC，没有逐字流
  const plain = qrcDecryptHex(cipherHex)
  if (!plain.includes('<')) throw new Error('qrc 明文缺少 XML 包裹')
  // 关键修正：QQ 的 QRC 行时长 [start,dur] 经常把行尾拖腔乃至后续间奏一并编码
  // （实测「晴天」有一行标了 21.4s、实际演唱约 4s）——直接用它当扫色窗口就会在
  // 长间奏被摊平。但词级时间是精确的：取最后一个词的结束时刻收紧行窗口，
  // 无词级行回退原行时长。客户端消费的仍是 {t,end,text}，零改动。
  const VOCAL_TAIL_MS = 400     // 唱完后再让高亮保持一小会的自然尾巴
  const lines = qrcParse(plain).map((l) => {
    let endMs = l.startMs + l.durMs
    if (Array.isArray(l.words) && l.words.length > 0) {
      const wordEndMax = Math.max(...l.words.map((w) => w.startMs + w.durMs))
      // 词结束合理（落在行区间内且不是坏数据）才采用；再保证最小可读时长。
      if (wordEndMax > l.startMs && wordEndMax <= l.startMs + l.durMs) {
        endMs = Math.min(endMs, Math.max(l.startMs + 600, wordEndMax + VOCAL_TAIL_MS))
      }
    }
    return {
      t: l.startMs / 1000,          // 统一到客户端使用的秒时基
      end: endMs / 1000,
      text: l.text,
      // 词级时间轴（words）当前不下发：逐字点亮渲染已移除，只保留精确行窗口喂
      // 整行扫色；lib/qrc.js 的 words 解析能力保留（将来恢复零成本）。
    }
  }).filter((l) => l.text !== '')
  return { kind: 'qrc', lines }
}

export async function getRecommendedPlaylists(cookie = '') {
  const body = { comm: { ct: 24 }, recomPlaylist: { method: 'get_hot_recommend', module: 'playlist.HotRecommendServer', param: { async: 1, cmd: 2 } } }
  const res = await postMusicu(body, cookie)
  const vhot = (res.recomPlaylist && res.recomPlaylist.data && res.recomPlaylist.data.v_hot) || []
  return vhot.filter((x) => x.content_id && x.title).map((x) => ({
    id: String(x.content_id), name: dec(x.title), cover: httpsCover(x.cover),
    playCount: x.listen_num || 0, trackCount: (x.song_cnt || x.song_count || 0), creator: dec(x.username || ''),
    source: 'qq', link: plLink(x.content_id),
  }))
}

export async function getPlaylistCategories(cookie = '') {
  const apiURL = `https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?${new URLSearchParams({ format: 'json', inCharset: 'utf8', outCharset: 'utf-8' }).toString()}`
  const res = await fetchWithTimeout(apiURL, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/', ...(cookie ? { Cookie: cookie } : {}) } })
  const j = await res.json()
  const cats = []
  for (const g of (j.data && j.data.categories) || []) {
    for (const it of (g.items || [])) {
      if (!it.categoryId || it.usable === 0 || it.categoryId === 10000000) continue
      cats.push({ id: String(it.categoryId), name: dec(it.categoryName), group: dec(g.categoryGroupName || '') })
    }
  }
  return cats
}

export async function getCategoryPlaylists(categoryID = '10000000', page = 1, limit = 20, cookie = '') {
  const offset = (page - 1) * limit
  const p = new URLSearchParams()
  p.set('picmid', '1'); p.set('rnd', '0.1'); p.set('g_tk', '5381'); p.set('loginUin', '0'); p.set('hostUin', '0')
  p.set('format', 'json'); p.set('inCharset', 'utf8'); p.set('outCharset', 'utf-8'); p.set('notice', '0')
  p.set('platform', 'yqq.json'); p.set('needNewCode', '0')
  p.set('categoryId', String(categoryID)); p.set('sortId', '5')
  p.set('sin', String(offset)); p.set('ein', String(offset + limit - 1))
  const apiURL = `https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?${p.toString()}`
  const res = await fetchWithTimeout(apiURL, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/', ...(cookie ? { Cookie: cookie } : {}) } })
  const j = await res.json()
  return (j.data && j.data.list || []).filter((x) => x.dissid && x.dissname).map((x) => ({
    id: x.dissid, name: dec(x.dissname), cover: httpsCover(x.imgurl),
    trackCount: (x.song_count || x.song_num || 0), playCount: x.listennum || 0, creator: dec((x.creator && x.creator.name) || ''),
    description: dec(x.introduction || ''), source: 'qq', link: plLink(x.dissid),
  }))
}

/** 歌单搜索（每页 num_per_page=50，即接口单请求上限；实测 n≥60 返回空，且每页返回数
 *  不固定：49/46/44/35）。注意：该接口响应里 totalnum/total_num 缺失（实测为 None），
 *  total 只能回退为当前页长度，前端「是否还有更多」须用「最近一页返回较满(≥20)」判定。 */
export async function searchPlaylist(keyword, cookie = '', page = 1) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const param = new URLSearchParams({ query: keyword, page_no: String(p - 1), num_per_page: '50', format: 'json', remoteplace: 'txt.yqq.playlist', flag_qc: '0' })
  const apiURL = `http://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?${param.toString()}`
  const res = await fetchWithTimeout(apiURL, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/portal/search.html', ...(cookie ? { Cookie: cookie } : {}) } })
  let text = await res.text()
  const i = text.indexOf('('); const e = text.lastIndexOf(')')
  if (i >= 0 && e > i) text = text.slice(i + 1, e)
  const j = JSON.parse(text)
  const results = (j.data && j.data.list || []).filter((x) => x.dissid && x.dissname).map((x) => ({
    id: x.dissid, name: dec(x.dissname), cover: httpsCover(x.imgurl),
    trackCount: x.song_count || 0, playCount: x.listennum || 0, creator: dec((x.creator && x.creator.name) || ''),
    source: 'qq', link: plLink(x.dissid),
  }))
  const d = j.data || {}
  const total = Number(d.totalnum ?? d.total_num) || results.length
  return { results, total, page: p }
}

export async function getPlaylistSongs(id, cookie = '') {
  id = String(id).trim()
  const p = new URLSearchParams()
  p.set('type', '1'); p.set('json', '1'); p.set('utf8', '1'); p.set('onlysong', '0'); p.set('disstid', id)
  p.set('format', 'json'); p.set('g_tk', '5381'); p.set('loginUin', '0'); p.set('hostUin', '0')
  p.set('inCharset', 'utf8'); p.set('outCharset', 'utf-8'); p.set('notice', '0'); p.set('platform', 'yqq'); p.set('needNewCode', '0')
  const endpoints = [
    `https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${p.toString()}`,
    `http://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${p.toString()}`,
  ]
  let lastErr
  for (const apiURL of endpoints) {
    try {
      const res = await fetchWithTimeout(apiURL, { headers: { 'User-Agent': UA, 'Referer': 'https://y.qq.com/', ...(cookie ? { Cookie: cookie } : {}) } })
      let text = await res.text()
      if (text.trimStart().startsWith('MusicJsonCallback(')) { const i = text.indexOf('('); const e = text.lastIndexOf(')'); text = text.slice(i + 1, e) }
      const j = JSON.parse(text)
      const cd = (j.cdlist || [])[0]
      if (!cd) { lastErr = new Error('playlist not found'); continue }
      return {
        id, name: dec(cd.dissname || ''), creator: dec(cd.nickname || ''), description: dec(cd.desc || ''),
        cover: httpsCover(cd.logo), trackCount: cd.songnum || 0, source: 'qq', link: plLink(id),
        songs: (cd.songlist || []).map((s) => ({
          id: s.songmid, songmid: s.songmid, title: dec(s.songname),
          songid: s.songid, songtype: s.songtype || 0,
          artists: (s.singer || []).map((x) => dec(x.name)), album: dec(s.albumname),
          payplay: s.pay ? s.pay.payplay : 0, source: 'qq',
        })).filter((s) => s.songmid),
      }
    } catch (err) { lastErr = err }
  }
  throw lastErr || new Error('playlist not found')
}

// 我的歌单（登录后）：当前账号创建/收藏的歌单列表。需要登录态 cookie。
// 参考 @yakult-green-tea/qq-music-api 的 music.musicasset.PlaylistBaseRead / GetPlaylistByUin：
// comm 里必须带真实 App 版本号(cv/v) + authst/musickey + qq/uid/loginUin，否则接口当未登录返回空。
export async function getMyPlaylists(cookie = '') {
  if (!cookie) return []
  const cv = (k) => { const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]+)').exec(cookie); return m ? m[1].trim() : '' }
  const uin = cv('uin') || cv('musicid')
  if (!uin) return []
  const musickey = cv('qqmusic_key') || cv('qm_keyst') || cv('musickey') || cv('p_skey')
  // 登录类型：cookie 里没有就按 musickey 前缀推断（W_X 开头 = 微信）。
  let loginType = cv('tmeLoginType')
  if (!loginType) loginType = (musickey && musickey.startsWith('W_X')) ? '1' : '2'
  const comm = {
    ct: 11, cv: 14090008, v: 14090008, format: 'json',
    inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, platform: 'yqq.json',
    needNewCode: 1, tmeAppID: 'qqmusic', uid: uin, qq: uin, loginUin: uin,
  }
  if (musickey) { comm.authst = musickey; comm.tmeLoginType = loginType }
  const body = {
    comm,
    // 注意：GetPlaylistByUin 的 uin 必须是【字符串】（数值会触发上游 code 10006）。
    req_0: { module: 'music.musicasset.PlaylistBaseRead', method: 'GetPlaylistByUin', param: { uin } },
  }
  const j = await postMusicu(body, cookie)
  const res = j.req_0 || j['music.musicasset.PlaylistBaseRead']
  const rawSnippet = (x) => { try { const s = JSON.stringify(x); return s ? s.slice(0, 300) : String(x) } catch { return String(x) } }
  if (!res) throw new Error('我的歌单接口无响应（顶层 code=' + j.code + '，raw=' + rawSnippet(j) + '）')
  if (Number(res.code) !== 0) throw new Error('获取我的歌单失败：' + ((res.message || res.msg) || ('code ' + res.code)) + '｜raw=' + rawSnippet(res))
  const list = res.data?.v_playlist || []
  return list.filter((x) => x.tid && x.dirName).map((x) => {
    const dirId = Number(x.dirId) || Number(x.tid) || 0
    // QQ 的「我喜欢」是系统默认歌单（dirId 固定 201）；其余为本账号自建歌单。
    // 腾讯 GetPlaylistByUin 里没有「收藏别人的歌单」条目（收藏走单独的收藏接口），
    // 所以只区分 默认(201) / 自建。
    const isDefault = dirId === 201
    return {
      id: String(x.tid), dirId, tid: Number(x.tid) || 0,
      name: dec(x.dirName), cover: httpsCover(x.picUrl),
      trackCount: x.songNum || 0, playCount: 0, creator: dec(x.nick || ''), source: 'qq', link: plLink(x.tid),
      isDefault,
      kind: isDefault ? 'default' : 'own',
    }
  })
}

// 构建带登录态的 musicu comm（含版本号 cv/v + authst/musickey + qq/uid/loginUin）。
function buildAuthedComm(cookie) {
  const cv = (k) => { const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]+)').exec(cookie); return m ? m[1].trim() : '' }
  const uin = cv('uin') || cv('musicid')
  const musickey = cv('qqmusic_key') || cv('qm_keyst') || cv('musickey') || cv('p_skey')
  let loginType = cv('tmeLoginType')
  if (!loginType) loginType = (musickey && musickey.startsWith('W_X')) ? '1' : '2'
  const comm = {
    ct: 11, cv: 14090008, v: 14090008, format: 'json',
    inCharset: 'utf-8', outCharset: 'utf-8', notice: 0, platform: 'yqq.json',
    needNewCode: 1, tmeAppID: 'qqmusic', uid: uin, qq: uin, loginUin: uin,
  }
  if (musickey) { comm.authst = musickey; comm.tmeLoginType = loginType }
  return { comm, uin, musickey }
}

// QQ 音乐 g_tk（CSRF）由 musickey 计算，seed=5381。写操作（AddSonglist 等）必需。
function qqGtk(musickey) {
  if (!musickey) return 5381
  let h = 5381
  for (let i = 0; i < musickey.length; i++) h += (h << 5) + musickey.charCodeAt(i)
  return h & 0x7fffffff
}

// 通用的「歌单写操作」：调用指定 module 的写接口。
// method 为 AddSonglist / DelSonglist（PlaylistDetailWrite）或 AddPlaylist / DelPlaylist（PlaylistBaseWrite）。
// 成功返回 res.data（可能为 {}）；失败抛错。写操作需要登录态 + g_tk(CSRF)。
async function playlistDetailWrite(method, param, cookie, module = 'music.musicasset.PlaylistDetailWrite') {
  if (!cookie) throw new Error('未登录，无法操作歌单')
  const { comm, musickey } = buildAuthedComm(cookie)
  const g_tk = qqGtk(musickey)
  if (g_tk) { comm.g_tk = g_tk; comm.g_tk_new_20200303 = g_tk }
  const body = { comm, req_0: { module, method, param } }
  const j = await postMusicu(body, cookie)
  const res = j.req_0 || j[module]
  const rawSnippet = (x) => { try { const s = JSON.stringify(x); return s ? s.slice(0, 300) : String(x) } catch { return String(x) } }
  const retCode = res?.data?.retCode
  if (retCode !== undefined) {
    if (Number(retCode) === 0) return res.data || {}
    throw new Error('歌单操作失败（retCode=' + retCode + '，raw=' + rawSnippet(j) + '）')
  }
  const code = res ? Number(res.code) : (j.code !== undefined ? Number(j.code) : NaN)
  if (code === 0) return (res && res.data) || {}
  throw new Error('歌单操作失败（code=' + code + '｜method=' + method + '｜param=' + rawSnippet(param) + '｜raw=' + rawSnippet(j) + '）')
}

// 收藏/取消收藏歌曲到「我喜欢」（dirId 固定 201）。song 需含 songid（数值）、songtype。
async function qqFavWrite(song, cookie, method) {
  const songId = Number(song.songid) || 0
  if (!songId) throw new Error('缺少歌曲 songid，无法收藏')
  await playlistDetailWrite(method, {
    dirId: 201,
    tid: 0,
    bFmtUtf8: true,
    v_songInfo: [{ songId, songType: Number(song.songtype) || 0 }],
  }, cookie)
  return true
}

export async function addQQFav(song, cookie = '') {
  return qqFavWrite(song, cookie, 'AddSonglist')
}
export async function removeQQFav(song, cookie = '') {
  return qqFavWrite(song, cookie, 'DelSonglist')
}

// 把歌曲加入某个自建歌单（dirId = 该歌单的目录 id，tid = 歌单 tid，可为 0）。
export async function addSongToPlaylist(song, dirId, tid = 0, cookie = '') {
  const songId = Number(song.songid) || 0
  if (!songId) throw new Error('缺少歌曲 songid，无法加入歌单')
  await playlistDetailWrite('AddSonglist', {
    dirId: Number(dirId) || 0,
    tid: Number(tid) || 0,
    bFmtUtf8: true,
    v_songInfo: [{ songId, songType: Number(song.songtype) || 0 }],
  }, cookie)
  return true
}

// 把歌曲从某个歌单移除（DelSonglist）。「我喜欢」也是 dirId=201，同在列。
// tid 固定 0 即可（与 addSongToPlaylist 一致）。
export async function deleteSongFromPlaylist(song, dirId, tid = 0, cookie = '') {
  const songId = Number(song.songid) || 0
  if (!songId) throw new Error('缺少歌曲 songid，无法从歌单移除')
  await playlistDetailWrite('DelSonglist', {
    dirId: Number(dirId) || 0,
    tid: Number(tid) || 0,
    bFmtUtf8: true,
    v_songInfo: [{ songId, songType: Number(song.songtype) || 0 }],
  }, cookie)
  return true
}

// 创建自建歌单（AddPlaylist / PlaylistBaseWrite），返回 { id, name }。
// AddPlaylist 响应把新歌单信息嵌套在 data.result 下（dirId/dirName/tid）。
export async function createPlaylist(name, cookie = '') {
  const dirName = String(name || '').trim()
  if (dirName === '') throw new Error('歌单名不能为空')
  const data = await playlistDetailWrite('AddPlaylist', { dirName }, cookie, 'music.musicasset.PlaylistBaseWrite')
  const result = (data && data.result) || data || {}
  const id = Number(result.dirId) || Number(result.dirid) || Number(result.tid) || Number(result.id) || Number(result.content_id) || 0
  return { id, name: dec(result.dirName || result.dirname || result.name || dirName) }
}

// 删除自建歌单（DelPlaylist / PlaylistBaseWrite）。dirId = 该歌单的目录 id。
// 只能删除本人创建的歌单；「我喜欢」（dirId=201）不允许删除，由前端隐藏入口。
// DelPlaylist 响应把结果嵌套在 data.result 下；成功返回 true，失败抛错。
export async function deletePlaylist(dirId, cookie = '') {
  const id = Number(dirId) || 0
  if (!id) throw new Error('缺少歌单 dirId，无法删除')
  if (id === 201) throw new Error('「我喜欢」不可删除')
  await playlistDetailWrite('DelPlaylist', { dirId: id }, cookie, 'music.musicasset.PlaylistBaseWrite')
  return true
}

// 获取「我喜欢」（dirid=201）里已收藏歌曲的 songid + songmid 集合，用于播放时判断当前曲目是否已收藏。
// 返回 { ids: number[], mids: string[] }——songmid 是稳定字符串标识，避免 songid 大整数/类型不一致导致匹配失败。
export async function getQQFavIds(cookie = '') {
  if (!cookie) throw new Error('未登录，无法读取「我喜欢」')
  const { comm, uin } = buildAuthedComm(cookie)
  // enc_host_uin：CgiGetDiss 取「我喜欢」（dirid=201）需要加密后的 uin。
  // 微信登录响应带 encrypt_uin；纯 QQ 账号退化为明文 uin（多数情况下可用）。
  const cv = (k) => { const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]+)').exec(cookie); return m ? m[1].trim() : '' }
  const encUin = cv('encrypt_uin') || cv('encuin') || cv('euin') || uin
  const param = { disstid: 0, dirid: 201, tag: true, song_begin: 0, song_num: 300, userinfo: true, orderlist: true }
  if (encUin) param.enc_host_uin = encUin
  const body = {
    comm,
    req_0: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param,
    },
  }
  const j = await postMusicu(body, cookie)
  const res = j.req_0 || j['music.srfDissInfo.DissInfo']
  if (!res || Number(res.code) !== 0) {
    throw new Error('读取「我喜欢」失败：' + ((res && (res.message || res.msg)) || ('code ' + (res && res.code))))
  }
  // 从 CgiGetDiss 响应 data 里找出歌曲列表：真实字段可能是 songlist / song_info /
  // dirinfo.songlist 等，逐个扫描，取第一个含歌曲标识的数组。
  // 注意 CgiGetDiss 的歌曲对象字段是 mid/id/name（搜索/歌单接口是 songmid/songid/songname）。
  const findSongList = (data, depth = 0) => {
    if (!data || typeof data !== 'object' || depth > 4) return null
    // 优先直接命中已知的歌曲列表字段名（避免把 dirinfo 等带 id 的对象误判）。
    for (const k of ['songlist', 'song_info', 'songInfoList', 'songinfo', 'songs', 'musiclist']) {
      const v = data[k]
      if (Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object') return v
    }
    for (const k of Object.keys(data)) {
      const v = data[k]
      if (Array.isArray(v)) {
        if (v.length > 0 && v[0] && typeof v[0] === 'object'
          && (v[0].songmid || v[0].songid || v[0].songname || v[0].mid || v[0].id || v[0].name)) return v
        continue
      }
      if (v && typeof v === 'object') {
        const found = findSongList(v, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  const songlist = findSongList(res.data) || []
  // CgiGetDiss 字段：id/songid（数字 ID）、mid/songmid（字符串 ID）；两者取其一，songmid 优先匹配。
  const ids = songlist.map((s) => Number(s.songid || s.id)).filter((x) => Number.isFinite(x) && x > 0)
  const mids = songlist.map((s) => String(s.songmid || s.mid || '')).filter((x) => x !== '')
  return { ids, mids }
}

// =====================================================================
// 发现：排行榜 + 新歌速递（均匿名可用，无需登录）
// 参考 Rain120/qq-music-api：musicToplist.ToplistInfoServer + newsong.NewSongServer。
// =====================================================================

// 排行榜分类（所有榜单分组）。匿名可用。
export async function getTopLists(cookie = '') {
  const body = { comm: { ct: 24, cv: 0, format: 'json', platform: 'yqq.json', needNewCode: 1 }, req_0: { module: 'musicToplist.ToplistInfoServer', method: 'GetAll', param: {} } }
  const j = await postMusicu(body, cookie)
  const res = j.req_0 || j['musicToplist.ToplistInfoServer']
  if (!res || Number(res.code) !== 0) throw new Error('获取排行榜失败：' + ((res && (res.message || res.msg)) || ('code ' + (res && res.code))))
  const groups = (res.data && res.data.group) || []
  return groups.map((g) => ({
    id: String(g.groupId || ''), name: dec(g.groupName || ''),
    toplists: (g.toplist || []).map((t) => ({
      id: String(t.topId), name: dec(t.title || ''), intro: dec(t.intro || ''),
      // headPicUrl 是无文字版（纯色底 + 中央图标）；R500x500 缩为 R300x300 减小体积。
      // frontPicUrl 带榜名文字，仅在无 headPicUrl 时回退。
      cover: httpsCover((t.headPicUrl || t.frontPicUrl || '').replace(/R[0-9]+x[0-9]+/, 'R300x300')),
      listenNum: t.listenNum || 0, totalNum: t.totalNum || 0,
      updateTime: t.updateTime || '', period: t.period || '',
    })),
  })).filter((g) => g.toplists.length > 0)
}

// 排行榜详情歌曲。匿名可用；返回带 songmid 的歌曲对象（可直接播放）。
// 用 musicu 的 music.musicToplist.Toplist/GetDetail 分页取数：offset/num 支持翻页；
// 接口本身不设 num 上限，大 num（实测 num≥榜单总数，最大榜 热歌榜 299 首）可一次拿全
// 整榜，无需前端「加载更多」（旧版 fcg_v8_toplist_cp.fcg 无法翻页且最多只返回 50 首）。
// 返回 { id, name, cover, updateTime, total, hasMore, songs }。
export async function getTopListSongs(topId, cookie = '', offset = 0, num = 30) {
  const off = Math.max(0, parseInt(offset, 10) || 0)
  const size = Math.max(1, Math.min(500, parseInt(num, 10) || 30))
  const body = {
    comm: { ct: 24, cv: 0, format: 'json', platform: 'yqq.json', needNewCode: 1 },
    req_0: { module: 'music.musicToplist.Toplist', method: 'GetDetail', param: { topId: Number(topId), offset: off, num: size, withTags: true } },
  }
  const j = await postMusicu(body, cookie)
  const res = j.req_0 || j['music.musicToplist.Toplist']
  if (!res || Number(res.code) !== 0) throw new Error('获取榜单失败：' + ((res && (res.message || res.msg)) || ('code ' + (res && res.code))))
  const data = (res.data && res.data.data) || {}
  const list = (res.data && Array.isArray(res.data.songInfoList) ? res.data.songInfoList : []).map((x) => {
    const s = (x && x.songInfo) || x || {}
    return {
      id: s.mid, songmid: s.mid, title: dec(s.name || s.title || ''),
      songid: s.id || s.songid, songtype: s.type || s.songtype || 0,
      artists: (s.singer || []).map((v) => dec(v.name)),
      album: s.album ? dec(s.album.name || '') : '', interval: s.interval,
      payplay: (s.pay && (s.pay.payplay || s.pay.pay_play)) || 0, source: 'qq',
    }
  }).filter((s) => s.songmid)
  const total = Number(data.totalNum) || list.length
  return {
    id: String(topId),
    name: dec(data.title || ''),
    cover: httpsCover((data.headPicUrl || data.frontPicUrl || '').replace(/R[0-9]+x[0-9]+/, 'R300x300')),
    intro: dec(data.intro || ''),
    updateTime: data.updateTime || data.period || '',
    total,
    hasMore: off + list.length < total,
    songs: list,
  }
}

// 新歌速递（首页推荐-新歌）。匿名可用。type: 5 最新 / 1 内地 / 6 港台 / 2 欧美 / 4 韩国。
export async function getNewSongs(type = 5, cookie = '') {
  const body = { comm: { ct: 24, cv: 0, format: 'json', platform: 'yqq.json', needNewCode: 1 }, req_0: { module: 'newsong.NewSongServer', method: 'get_new_song_info', param: { type: Number(type) || 5 } } }
  const j = await postMusicu(body, cookie)
  const res = j.req_0 || j['newsong.NewSongServer']
  if (!res || Number(res.code) !== 0) throw new Error('获取新歌失败：' + ((res && (res.message || res.msg)) || ('code ' + (res && res.code))))
  const data = res.data || {}
  const songlist = (data.songlist || []).filter((s) => s && s.mid).map((s) => ({
    id: s.mid, songmid: s.mid, title: dec(s.name || s.title || ''),
    songid: s.id, songtype: s.type || s.songtype || 0,
    artists: (s.singer || []).map((x) => dec(x.name)),
    album: s.album ? dec(s.album.name || '') : '', interval: s.interval,
    payplay: s.pay ? s.pay.payplay : 0, source: 'qq',
  }))
  const lan = (data.lanlist || []).find((x) => String(x.type) === String(type))
  return {
    type, label: dec((lan && lan.lan) || '最新'), songs: songlist,
  }
}
