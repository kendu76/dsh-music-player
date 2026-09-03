/**
 * lib/radio.js — 网络电台（Internet Radio）目录与播放底层模块。
 *
 * 纯 Node（Node ≥ 20，用全局 fetch），无第三方依赖，无编译步骤。
 * 目录数据源：radio-browser.info 开放目录（社区维护、无 key、无需登录，字段结构化）。
 *   - 端点：https://<mirror>.api.radio-browser.info/json/...
 *   - 官方服务器发现端点 all.api.radio-browser.info 实测不稳定（直连 ECONNRESET），
 *     因此内置已知镜像并按顺序做故障转移（de1/si1/fr1/fi1/at1/...），
 *     见 DEFAULT_MIRRORS 与下一段「镜像选择」。
 *
 * 合规：目录数据为开放数据（CC）；播放的是各电台公开直播流。不录制、不二次分发、
 * 不绕过付费墙/DRM，遵守台站 ToS，内容版权归台站/版权方。仅个人收听/学习使用。
 */

// radio-browser 的可用镜像前缀（社区维护；首选项 de1 实测可达）。
// all.api.radio-browser.info 会 302 到某个可用镜像，但直连不稳，故不走发现、直接试镜像。
const DEFAULT_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://si1.api.radio-browser.info',
  'https://fr1.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
]

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) dsh-music-player/0.9 (radio)'

// 统一超时：目录请求 ~10s，播放流探测可更长（由调用方传 timeoutMs）。
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ---- 镜像选择：模块级缓存（启动/首次调用探测一次，24h 内复用） ----
let mirrors = DEFAULT_MIRRORS.slice()
let mirrorsCheckedAt = 0
const MIRROR_TTL_MS = 24 * 60 * 60 * 1000

export function getMirrors() { return mirrors.slice() }
export function setMirrors(list) {
  const arr = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && /^https?:\/\//.test(x)) : []
  if (arr.length > 0) mirrors = arr
}
// 重置镜像缓存（测试与「刷新镜像」按钮用）。
export function resetMirrors() {
  mirrors = DEFAULT_MIRRORS.slice()
  mirrorsCheckedAt = 0
}

// 挑选当前可用镜像：并发对每个候选发一个轻量 GET /json/stats，取首个 200。
// 失败/超时逐个跳过；全部失败时退回默认列表第一个（由调用方在上游错误里提示）。
export async function pickMirror(force = false) {
  if (!force && mirrorsCheckedAt !== 0 && Date.now() - mirrorsCheckedAt < MIRROR_TTL_MS) {
    return mirrors[0]
  }
  const candidates = mirrors.slice()
  for (const base of candidates) {
    try {
      const r = await fetchWithTimeout(base + '/json/stats', { headers: { 'User-Agent': UA } }, 6000)
      if (r.ok) {
        mirrors = [base, ...candidates.filter((x) => x !== base)]
        mirrorsCheckedAt = Date.now()
        return base
      }
    } catch { /* try next */ }
  }
  // 全部失败：保持现状，返回第一个让调用方拿真实错误。
  mirrorsCheckedAt = Date.now()
  return candidates[0] || DEFAULT_MIRRORS[0]
}

// ---- 请求 radio-browser 并做镜像故障转移 ----
// 单个镜像失败（网络错误/5xx）就换下一个，最多把 DEFAULT 都试一遍。
async function rbGet(path, params = {}, timeoutMs = 12000) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const suffix = path + (qs.toString() !== '' ? '?' + qs.toString() : '')
  let lastErr = null
  for (const base of mirrors) {
    try {
      const r = await fetchWithTimeout(base + '/json/' + suffix, { headers: { 'User-Agent': UA } }, timeoutMs)
      if (!r.ok) { lastErr = new Error('radio-browser http ' + r.status + ' @ ' + base); continue }
      return await r.json()
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr || new Error('radio-browser 全部镜像不可达')
}

// ---- 归一化：把 radio-browser 的 station 对象收窄成本插件的稳定结构 ----
// 入站同时接受三种形态：radio-browser 原始对象（stationuuid）、本插件出站的
// 精简对象（id，见下方输出）、手动添加的台（无 uuid，仅 id 为空 + url 合法）。
// 输出保留 id + stationuuid 双写：客户端把对象原样 POST 回来（收藏/最近）时，
// 入站校验仍能从 stationuuid 取到标识，不会误判无效。
export function normalizeStation(s) {
  if (!s || typeof s !== 'object') return null
  const rawUuid = String(s.stationuuid || s.changeuuid || '')
  const id = rawUuid || String(s.id || '')
  const url = String(s.url_resolved || s.url || '').trim()
  if (!/^https?:\/\//.test(url)) return null
  const tags = String(s.tags || '')
    .split(',').map((t) => t.trim()).filter((t) => t !== '').slice(0, 6)
  const bitrate = Number(s.bitrate) || 0
  return {
    id, // 稳定主键：uuid；手动台（无 uuid）为空串，由 url 兜底
    stationuuid: rawUuid || id, // 兼容往返：raw / 出站对象都有
    name: String(s.name || '').trim() || '未命名电台',
    url, // 播放 URL（播放路由经同源代理取流）
    homepage: String(s.homepage || '').trim(),
    favicon: String(s.favicon || '').trim(),
    country: String(s.country || '').trim(),
    countrycode: String(s.countrycode || '').trim().toUpperCase(),
    state: String(s.state || '').trim(),
    language: String(s.language || '').trim(),
    tags,
    codec: String(s.codec || '').trim().toUpperCase(),
    bitrate,
    hls: Number(s.hls) === 1,
    votes: Number(s.votes) || 0,
    clickcount: Number(s.clickcount) || 0,
    lastcheckok: Number(s.lastcheckok) === 1,
  }
}

function normalizeList(data) {
  if (!Array.isArray(data)) return []
  return data.map(normalizeStation).filter((x) => x !== null)
}

// ---- 目录查询 ----
export async function search(opts = {}) {
  // hidebroken=true 过滤社区最近一次检测失败的台。
  const params = {
    hidebroken: 'true',
    order: opts.order || 'votes',
    reverse: 'true',
    limit: String(Math.max(1, Math.min(200, Number(opts.limit) || 40))),
  }
  const off = Number(opts.offset)
  if (Number.isFinite(off) && off > 0) params.offset = String(Math.floor(off))
  // 仅放行已知安全查询参数（name/nameExact/countrycode/tag/language）
  const safe = {
    name: opts.name, countrycode: opts.countrycode, tag: opts.tag, language: opts.language,
  }
  for (const [k, v] of Object.entries(safe)) {
    const s = String(v || '').trim()
    if (s !== '') params[k] = s
  }
  return normalizeList(await rbGet('stations/search', params))
}

export async function topBy(order, limit = 30) {
  // topclick / topvote 端点不接受 hidebroken 之外的附加查询，直接拼路径。
  const kind = order === 'clickcount' ? 'topclick' : 'topvote'
  const data = await rbGet('stations/' + kind + '/' + Math.max(1, Math.min(200, Number(limit) || 30)))
  return normalizeList(data)
}

// ---- 分组定义（UI 与 Host 共用的可查询主题）----
// 说明：radio-browser 的 tag 是社区自由填写的，语义需按实测校准；每组对应一次
// search?tag=<v> 查询（tag=a,b 不支持 OR、tagList 是 AND，故每组=单 tag Top200，
// 「全部」=不带 tag 的目录查询）。tag 词按 CN / 全球目录实测命中量与内容选取。
// 客户端侧需要展示同名文案（见 client.js 的 GROUPS），key 必须与此一致。
export const CN_GROUP_TAGS = {
  news: 'news', // 新闻
  music: 'music', // 音乐
  traffic: 'traffic', // 交通
  economics: 'economics', // 财经/经济
  literature: 'literature', // 文艺（故事/曲艺/文艺台）
  storytelling: 'storytelling', // 故事评书
  sport: 'sport', // 体育
}
export const WORLD_GROUP_TAGS = {
  music: 'music', // 音乐
  news: 'news', // 新闻
  classical: 'classical', // 古典
  rock: 'rock', // 摇滚
  jazz: 'jazz', // 爵士
  talk: 'talk', // 谈话
}

// 噪音剔除：CN 区社区条目混杂，只去掉显然不是「电台广播」的条目
// （白噪音/雨声/睡眠循环、相声合集类点播流、带时间戳后缀的重复条目），
// 不做「该收录哪些台」的名单式过滤——保证是纯 live 目录、零维护。
const NOISE = /白噪音|雨声|睡眠|轻音乐.*(雨|自然)|大自然的声音|休息音乐|相声合集|德云社|asmr|white\s?noise|【\d{4}|_?\d{4}[-.]\d{1,2}/i
export function isNoiseStation(s) {
  return NOISE.test(String((s && s.name) || ''))
}

// 分页取一页「目录 + 滤噪 + 截断」的结果：向 radio-browser 拉 limit+8 的缓冲，
// 剔除噪音台后仍能凑满 limit 条展示（噪音台不占页容量，避免越翻页越短）。
// 注意：不按 hls 重排——上游不支持按 hls 过滤，分页语义=每页按 votes 序的自然混排，
// 客户端对 hls:1 台灰显「需HLS支持」；保证「加载更多」拿到的就是目录里下一页的台。
async function pageSearch(params, pageSize = 50) {
  const want = Math.max(1, Math.min(200, Number(pageSize) || 50))
  const buf = Math.min(200 - want, 12) // 缓冲行（噪音剔除的余量），不能超过 200 上限
  const data = await search({ ...params, limit: want + buf })
  const clean = data.filter((s) => !isNoiseStation(s))
  return clean.slice(0, want)
}

// ---- 「中文电台」视图（countrycode=CN 实时查询，可按主题分组、offset 分页）----
export async function cnMainstream(group = 'all', limit = 50, offset = 0) {
  const tag = CN_GROUP_TAGS[group]
  return pageSearch({ countrycode: 'CN', tag, order: 'votes', offset }, limit)
}

// ---- 「热门电台」视图（全球高票，可按主题分组、offset 分页）----
// 分组：'all' 与其它组统一走 search?order=votes（实测与 topvote 前段几乎一致，
// 且 search 支持 offset 翻页；topvote 端点不支持可靠翻页）。同样滤噪后截断。
export async function worldTop(group = 'all', limit = 50, offset = 0) {
  const g = group === 'all' || group === '' || group === undefined ? '' : (WORLD_GROUP_TAGS[group] || group)
  return pageSearch({ tag: g, order: 'votes', offset }, limit)
}

export async function listCountries() {
  const data = await rbGet('countries', { order: 'name', hidebroken: 'true' })
  return Array.isArray(data)
    ? data.filter((c) => c && c.name && Number(c.stationcount) > 0)
      .map((c) => ({ name: String(c.name), code: String(c.iso_3166_1 || c.code || '').toUpperCase(), stationcount: Number(c.stationcount) || 0 }))
      .sort((a, b) => b.stationcount - a.stationcount)
    : []
}

export async function listTags() {
  const data = await rbGet('tags', { order: 'stationcount', reverse: 'true', hidebroken: 'true' })
  return Array.isArray(data)
    ? data.filter((t) => t && t.name && Number(t.stationcount) > 0).slice(0, 60)
      .map((t) => ({ name: String(t.name), stationcount: Number(t.stationcount) || 0 }))
    : []
}

// ---- 播放流探测（可选用）：HEAD 上游看 content-type / icy-name ----
// 注意：很多电台流不支持 HEAD 或对 HEAD 不返回正确头，探测失败不应阻止播放；
// 因此这里失败静默返回 null，由播放代理侧实际拉流决定。
export async function probeStream(url, timeoutMs = 8000) {
  try {
    const r = await fetchWithTimeout(url, { method: 'HEAD', headers: { 'User-Agent': UA } }, timeoutMs)
    return {
      ok: r.ok,
      status: r.status,
      contentType: r.headers.get('content-type') || '',
      icyName: r.headers.get('icy-name') || '',
      length: r.headers.get('content-length'),
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// ---- 轻量 JSON 文本安全取串（避免信任外部字段类型） ----
function safeString(v) {
  return typeof v === 'string' ? v : ''
}

// ICY 元数据解析（可选功能 P2 预留；P0 不用于播放流本身）。
// 给定一段带 ICY 元数据块的流字节与元数据间隔，返回解析出的 StreamTitle。
export function parseIcyMetadata(buf, metaint) {
  const interval = Number(metaint) || 0
  if (interval <= 0 || !Buffer.isBuffer(buf)) return ''
  // 首个元数据块位于 offset=interval 处：1 字节长度（按 16 计）+ 填充。
  const off = interval
  if (off + 1 > buf.length) return ''
  const len = buf[off] * 16
  if (len <= 0 || off + 1 + len > buf.length) return ''
  const block = buf.toString('latin1', off + 1, off + 1 + len)
  const m = block.match(/StreamTitle='([^']*)'/i)
  return m ? m[1] : ''
}

export default {
  search, topBy, cnMainstream, worldTop, isNoiseStation,
  CN_GROUP_TAGS, WORLD_GROUP_TAGS,
  listCountries, listTags, probeStream, normalizeStation,
  getMirrors, setMirrors, resetMirrors, pickMirror, safeString,
}
