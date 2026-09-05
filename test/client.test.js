/**
 * Front-end smoke tests for the browser half (lib/client.js).
 *
 * Strategy: load the client factory under jsdom with stubbed browser globals
 * (Audio / fetch / timers), run its apply() with a fake ctx whose slots capture
 * the registered React elements, then either renderToString them (static smoke)
 * or mount with react-dom/client + act to exercise interactions (open the
 * panel, switch to a playlist, clear it, reach the empty state).
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'

// React 18 requires this flag so act() works without warnings in test envs.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ---- captured plugin data ----
let factory = null
let registered = [] // [{ id, elementFactory }]
let manifest = null

// ---- minimal browser stubs ----
class FakeAudio {
  constructor() {
    this.listeners = {}
    this.currentTime = 0
    this.duration = 0
    this.volume = 0.8
    this.paused = true
    this.src = ''
    this.currentSrc = ''
    this.preload = 'auto'
    this.style = {}
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  removeEventListener() {}
  load() {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute() {}
}

function makePlaylist(id, name, fixed, paths) {
  return {
    id, name, fixed,
    count: paths.length, missing: 0,
    tracks: paths.map((p) => ({
      id: 'p:' + p, name: p.split('/').pop(),
      url: '/dsh-music/file?path=' + encodeURIComponent(p), size: 10, path: p,
    })),
  }
}

function jsonRes(obj) {
  return Promise.resolve({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) })
}
// 与客户端一致：字幕行长度按「去标点后的字数」计（标点不计入）。
const subPunct = '，。！？…：；、“”‘’（）《》—～·`~!@#$%^&*()-_=+[]{};\':",.<>/?\\|'
const subContentLen = (s) => [...String(s)].filter((c) => !subPunct.includes(c) && !/\s/.test(c)).length
// records the last /dsh-music/files path requested (to assert the initial dir)
let lastFilesUrl = null
// test hook: sections served for /dsh-music/book/*/meta (set before bootClient so
// the refresh-restore path — which fetches meta during load — sees them too)
let bookMetaSections = []
// test hook: per-book sections keyed by book id, so different books can report
// different structures (e.g. one with chapters, one without) in the same test.
let bookMetaById = {}
// test hook: per-book、逐块累积字符偏移（charOffsets）用于「已读字符/全书字符」的
// 讲书进度条测试；bookCharOffsetsById 可按 book id 覆盖 bookCharOffsets。
let bookCharOffsets = []
let bookCharOffsetsById = {}
// test hook: /dsh-music/book/*/text?from= response chunk text (for the AI 讲书
// subtitle-line splitting test).
let bookTextFixture = ''
// test hook: whether /dsh-music/qq/status reports logged-in (set before rendering).
let qqLoggedIn = false
// test hook: records /dsh-music/qq/fav POST bodies (action/song) for assertion.
let favCalls = []
// test hook: records /dsh-music/qq/playlist-delete POST bodies (dirId) + delete outcome.
let delPlaylistCalls = []
// test hook: makes the next /dsh-music/qq/playlist-delete POST fail (ok:false).
let delPlaylistFail = false
// test hook: records every /dsh-music/qq/* URL fetched, for asserting the
// "未登录不发外部请求 / 登录后才加载" gate.
let qqFetchLog = []
// test hook: /dsh-music/lyric?path= response (parsed LRC or {ok:false}).
let lyricFixture = null
// test hook: /dsh-music/lyric/online?path= response (本地无 .lrc → 在线兜底取词).
let lyricOnlineFixture = null
// test hook: /dsh-music/qq/lyric?songmid= response (QQ lyric + optional trans).
let qqLyricFixture = null
// ---- Host prefs mirror (the client's authoritative store is the Host; old
// localStorage is only a read-backup + upgrade migration source) ----
// `prefsServer` is the test's view of the Host's music-player-prefs.json.
// `prefsPosts` records every POST /dsh-music/prefs body for assertions.
// `prefsPostOpts` records the fetch options (e.g. keepalive) of each POST.
let prefsServer = {}
let prefsPosts = []
let prefsPostOpts = []
// ---- 每日新闻播报 fixtures（NewsPane 冒烟测试用）----
const newsEditionsFixture = [
  {
    id: 'news-20260530-0800-abcd', originShiftId: 's1', title: '早间新闻播报',
    date: '2026-05-30', createdAt: Date.now(), played: false,
    categories: [
      { name: '热点', count: 2 }, { name: '国内', count: 3 }, { name: 'AI', count: 2 },
    ],
    totalItems: 7, totalChars: 1800,
  },
  {
    id: 'news-20260529-1800-efgh', originShiftId: 'manual', title: '晚间新闻播报',
    date: '2026-05-29', createdAt: Date.now() - 86400000, played: true,
    categories: [{ name: '热点', count: 4 }],
    totalItems: 4, totalChars: 900,
  },
]
const newsMetaFixture = {
  ok: true, id: 'news-20260530-0800-abcd', title: '早间新闻播报', date: '2026-05-30',
  createdAt: newsEditionsFixture[0].createdAt, total: 4,
  sections: [
    { type: 'category', heading: '热点', fromChunk: 0, itemCount: 2 },
    { type: 'category', heading: '国内', fromChunk: 2, itemCount: 3 },
    { type: 'category', heading: 'AI', fromChunk: 3, itemCount: 2 },
  ],
  categories: [
    { name: '热点', items: [
      { title: '政策发布会召开', summary: '国新办今早介绍相关政策要点。', source: '新华社', url: '', publishedAt: '08:02' },
      { title: '多地强降雨', summary: '暴雨预警继续。', source: '央视新闻', url: '', publishedAt: '' },
    ] },
    { name: '国内', items: [
      { title: '国内条目一', summary: '摘要一。', source: '人民日报', url: '', publishedAt: '' },
      { title: '国内条目二', summary: '摘要二。', source: '新华社', url: '', publishedAt: '' },
      { title: '国内条目三', summary: '摘要三。', source: '澎湃', url: '', publishedAt: '' },
    ] },
    { name: 'AI', items: [
      { title: 'AI 条目一', summary: '推理成本下降。', source: '机器之心', url: '', publishedAt: '' },
      { title: 'AI 条目二', summary: '新模型发布。', source: '量子位', url: '', publishedAt: '' },
    ] },
  ],
  charOffsets: [0, 120, 260, 380, 500], totalChars: 500,
  itemChunk: [0, 0, 1, 2, 2, 3, 3], categoryChunk: [0, 2, 3],
}
const newsScheduleDefault = {
  enabled: true,
  // 旧数据兼容用例：scope=null 的存量定时任务，卡片按全部预设类别兜底展示（defaultScope 已退役，不再出现在数据里）
  shifts: [{ id: 's1', time: '08:00', autoplay: true, scope: null }], prefVersion: 1, syncedVersion: 1,
}
let newsScheduleServer = JSON.parse(JSON.stringify(newsScheduleDefault))
let newsFailuresServer = [] // 最近收集失败（非空时新闻列表页定时状态行下方显示失败提示行）
let newsRunState = null // 收集运行态（null=空闲；非 null 时面板显示「收集中」并禁用 ▶）
async function fetchStub(url, opts) {
  const u = String(url)
  const o = opts || {}
  // ---- 每日新闻播报：期次列表 / 运行态 / 定时偏好 / 期次 meta ----
  if (u === '/dsh-music/news') {
    return jsonRes({ ok: true, editions: newsEditionsFixture })
  }
  if (u === '/dsh-music/news/runstate') {
    return jsonRes({ ok: true, run: newsRunState })
  }
  if (u === '/dsh-music/news/failures/clear' && o && o.method === 'POST') {
    const cleared = newsFailuresServer.length
    newsFailuresServer = []
    return jsonRes({ ok: true, cleared })
  }
  if (u === '/dsh-music/news/schedule') {
    if (o && o.method === 'POST') {
      const body = JSON.parse(o.body || '{}')
      newsScheduleServer = body
      return jsonRes({ ok: true, schedulePrefs: newsScheduleServer, changed: true })
    }
    return jsonRes({ ok: true, schedulePrefs: newsScheduleServer, failures: newsFailuresServer })
  }
  if (u.startsWith('/dsh-music/news/') && u.endsWith('/meta')) {
    return jsonRes(newsMetaFixture)
  }
  if (u.startsWith('/dsh-music/news/') && u.includes('/text?from=')) {
    const from = parseInt(new URL('http://x' + u).searchParams.get('from') || '0', 10) || 0
    return jsonRes({ ok: true, from, text: bookTextFixture })
  }
  if (u === '/dsh-music/prefs') {
    if (o && o.method === 'POST') {
      const body = JSON.parse(o.body || '{}')
      prefsPosts.push(body)
      prefsPostOpts.push({ keepalive: o.keepalive, bodyLen: (o.body || '').length })
      Object.assign(prefsServer, body.prefs || {})
      for (const k of (body.remove || [])) delete prefsServer[k]
      return jsonRes({ ok: true, prefs: prefsServer })
    }
    return jsonRes({ ok: true, prefs: prefsServer })
  }
  if (String(u).startsWith('/dsh-music/qq/')) qqFetchLog.push(u.split('?')[0])
  if (u.startsWith('/dsh-music/lyric?path=')) {
    return jsonRes(lyricFixture || { ok: false, hasLrc: false })
  }
  if (u.startsWith('/dsh-music/lyric/online?path=')) {
    return jsonRes(lyricOnlineFixture || { ok: true, hasLyric: false })
  }
  if (u.startsWith('/dsh-music/qq/lyric?songmid=')) {
    return jsonRes(qqLyricFixture || { ok: false, error: 'no lyric' })
  }
  if (u === '/dsh-music/qq/fav' && o && o.method === 'POST') {
    try { favCalls.push(JSON.parse(o.body || '{}')) } catch {}
    return jsonRes({ ok: true, faved: true })
  }
  if (u === '/dsh-music/qq/playlist-delete' && o && o.method === 'POST') {
    try { delPlaylistCalls.push(JSON.parse(o.body || '{}')) } catch {}
    if (delPlaylistFail) return jsonRes({ ok: false, error: '删除失败（模拟）' })
    return jsonRes({ ok: true })
  }
  if (u === '/dsh-music/manifest') return jsonRes(manifest)
  if (u === '/dsh-music/set-root') {
    return jsonRes({ ok: true, root: '/music', bookRoot: '/books', tracks: manifest.tracks || [], books: manifest.books || [], count: (manifest.tracks || []).length })
  }
  if (u === '/dsh-music/set-book-root') {
    return jsonRes({ ok: true, root: '/music', bookRoot: '/books', tracks: manifest.tracks || [], books: manifest.books || [], count: (manifest.tracks || []).length })
  }
  if (u === '/dsh-music/intent') return jsonRes(null)
  if (u === '/dsh-music/qq/status') return jsonRes({ loggedIn: qqLoggedIn, uin: qqLoggedIn ? '123456' : '' })
  // 网络电台目录分页 stub：每组合成 120 行，首页 0..49 含既有夹具名（北京新闻广播/
  // 热门台A 等），offset 翻页取后续（用于「加载更多」测试）。hls 混入若干供灰显测试。
  function radioDirRows(kind, group, offset) {
    const off = offset || 0
    const size = 120
    const rows = []
    for (let i = 0; i < size; i++) {
      if (kind === 'cn' && group === 'music') {
        if (i === 0) rows.push({ id: 'cm1', stationuuid: 'cm1', name: '中文音乐台甲', url: 'https://radio.example/cm1.mp3', codec: 'MP3', bitrate: 128, hls: false, country: 'China', countrycode: 'CN', lastcheckok: true })
        else if (i === 1) rows.push({ id: 'cm2', stationuuid: 'cm2', name: '中文音乐台乙', url: 'https://radio.example/cm2.mp3', codec: 'MP3', bitrate: 0, hls: false, country: 'China', lastcheckok: true })
        else rows.push({ id: 'cnx' + i, stationuuid: 'cnx' + i, name: '中文音乐台' + (i + 1), url: 'https://radio.example/cnm' + i + '.mp3', codec: 'MP3', bitrate: 64, hls: (i % 10 === 0), country: 'China', countrycode: 'CN', lastcheckok: true })
        continue
      }
      if (kind === 'cn') {
        if (i === 0) rows.push({ id: 'cn1', stationuuid: 'cn1', name: '北京新闻广播', url: 'https://radio.example/bj.mp3', codec: 'MP3', bitrate: 64, hls: false, country: 'China', countrycode: 'CN', language: 'chinese', lastcheckok: true })
        else if (i === 1) rows.push({ id: 'cn2', stationuuid: 'cn2', name: '上海新闻广播', url: 'https://radio.example/sh.mp3', codec: 'MP3', bitrate: 64, hls: false, country: 'China', lastcheckok: true })
        else if (i === 2) rows.push({ id: 'cn3', stationuuid: 'cn3', name: '凤凰卫视资讯台', url: 'https://radio.example/ifeng.m3u8', codec: 'UNKNOWN', bitrate: 0, hls: true, country: 'China', lastcheckok: true })
        else rows.push({ id: 'cnx' + i, stationuuid: 'cnx' + i, name: '中文电台' + (i + 1), url: 'https://radio.example/cn' + i + '.mp3', codec: 'MP3', bitrate: 64, hls: (i % 10 === 0), country: 'China', countrycode: 'CN', lastcheckok: true })
      } else {
        if (i === 0) rows.push({ id: 'top1', stationuuid: 'top1', name: '热门台A', url: 'https://radio.example/top1.mp3', codec: 'MP3', bitrate: 96, hls: false, country: 'China', lastcheckok: true })
        else if (i === 1) rows.push({ id: 'top2', stationuuid: 'top2', name: '热门台B', url: 'https://radio.example/top2.mp3', codec: 'AAC', bitrate: 0, hls: false, country: 'USA', lastcheckok: true })
        else rows.push({ id: 'topx' + i, stationuuid: 'topx' + i, name: '全球热门' + (i + 1), url: 'https://radio.example/top' + i + '.mp3', codec: 'MP3', bitrate: 128, hls: false, country: i % 3 === 0 ? 'China' : 'USA', lastcheckok: true })
      }
    }
    return rows.slice(off, off + 50)
  }
  if (u.includes('/dsh-music/radio/top')) {
    radioTopFetches++
    const qp = (() => { try { return new URL('http://x' + u).searchParams } catch { return new URLSearchParams() } })()
    const group = qp.get('group') || 'all'
    const offset = parseInt(qp.get('offset') || '0', 10) || 0
    return jsonRes({ ok: true, stations: radioDirRows('top', group, offset) })
  }
  if (u.includes('/dsh-music/radio/cn')) {
    radioCnFetches++
    const qp = (() => { try { return new URL('http://x' + u).searchParams } catch { return new URLSearchParams() } })()
    const group = qp.get('group') || 'all'
    const offset = parseInt(qp.get('offset') || '0', 10) || 0
    return jsonRes({ ok: true, stations: radioDirRows('cn', group, offset) })
  }
  if (u === '/dsh-music/radio/favs' || u === '/dsh-music/radio/recent') {
    return jsonRes({ ok: true, favs: [], recent: [] })
  }
  if (u.includes('/dsh-music/radio/search')) {
    return jsonRes({ ok: true, stations: [
      { id: 'r1', stationuuid: 'r1', name: 'China Plus', url: 'https://radio.example/live.mp3', codec: 'MP3', bitrate: 128, hls: false, country: 'China', countrycode: 'CN', language: 'english', lastcheckok: true },
      { id: 'r2', stationuuid: 'r2', name: '央广中国之声', url: 'https://radio.example/cnr.mp3', codec: 'MP3', bitrate: 0, hls: false, country: 'China', lastcheckok: true },
    ] })
  }
  if (u === '/dsh-music/radio/favs' && o && o.method === 'POST') {
    const body = JSON.parse(o.body || '{}')
    if (body.action === 'remove') return jsonRes({ ok: true, faved: false, favs: [] })
    return jsonRes({ ok: true, faved: true, favs: [body.station] })
  }
  if (u === '/dsh-music/radio/recent' && o && o.method === 'POST') return jsonRes({ ok: true })
  if (u.includes('/dsh-music/qq/search')) {
    return jsonRes({ ok: true, isVip: false, results: [{ id: '123', songmid: '123', title: '晴天', artists: ['周杰伦'], album: '叶惠美', payplay: 0, source: 'qq' }] })
  }
  if (u === '/dsh-music/qq/my-playlists') {
    return jsonRes({ ok: true, playlists: [
      { id: 'mine1', name: '我的收藏', creator: '我', trackCount: 2, source: 'qq', dirId: 987, tid: 987 },
      { id: 'mine2', name: '第二个歌单', creator: '我', trackCount: 5, source: 'qq', dirId: 888, tid: 888 },
    ] })
  }
  if (u === '/dsh-music/qq/playlist-categories') {
    return jsonRes({ ok: true, categories: [{ id: '1', name: '国语', group: '语种' }, { id: '2', name: '欧美', group: '语种' }] })
  }
  if (u.includes('/dsh-music/qq/playlist-search')) {
    return jsonRes({ ok: true, playlists: [{ id: 's1', name: '周杰伦合集', creator: 'UP主', trackCount: 100, source: 'qq' }] })
  }
  if (u === '/dsh-music/qq/top-lists') {
    return jsonRes({ ok: true, groups: [{ id: '0', name: '巅峰榜', toplists: [{ id: '62', name: '飙升榜', cover: 'https://x.jpg', listenNum: 12345 }] }] })
  }
  if (u.includes('/dsh-music/qq/top-songs')) {
    const offset = parseInt(new URL('http://x' + u).searchParams.get('offset') || '0', 10) || 0
    // 榜单共 5 首，每页 2 首：offset 0 -> [a,b], 2 -> [c,d], 4 -> [e]
    const all = [
      { id: 'a', songmid: 'a', title: '飙升歌一', artists: ['歌手1'], payplay: 0, source: 'qq' },
      { id: 'b', songmid: 'b', title: '飙升歌二', artists: ['歌手2'], payplay: 0, source: 'qq' },
      { id: 'c', songmid: 'c', title: '飙升歌三', artists: ['歌手3'], payplay: 0, source: 'qq' },
      { id: 'd', songmid: 'd', title: '飙升歌四', artists: ['歌手4'], payplay: 0, source: 'qq' },
      { id: 'e', songmid: 'e', title: '飙升歌五', artists: ['歌手5'], payplay: 0, source: 'qq' },
    ]
    const page = all.slice(offset, offset + 2)
    return jsonRes({ ok: true, toplist: { id: '62', name: '飙升榜', cover: 'https://x.jpg', total: all.length, hasMore: offset + page.length < all.length, songs: page } })
  }
  if (u === '/dsh-music/qq/liked') {
    return jsonRes({ ok: true, ids: [789001, 999], mids: ['789', '999'] })
  }
  if (u.startsWith('/dsh-music/qq/playlist/')) {
    return jsonRes({ ok: true, playlist: { id: '111', name: '推荐歌单', creator: '作者', trackCount: 2, source: 'qq', songs: [
      { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], songid: 789001, songtype: 0, payplay: 0, source: 'qq' },
      { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], songid: 790002, songtype: 0, payplay: 0, source: 'qq' },
    ] } })
  }
  if (u === '/dsh-music/qq/playlists') {
    return jsonRes({ ok: true, playlists: [{ id: '111', name: '热门推荐', creator: '作者', trackCount: 50, source: 'qq' }] })
  }
  if (u.includes('/dsh-music/qq/playlists?category=')) {
    return jsonRes({ ok: true, playlists: [{ id: 'cat1', name: '国语歌单', creator: '作者', trackCount: 30, source: 'qq' }] })
  }
  if (u.includes('/dsh-music/book/') && u.endsWith('/meta')) {
    const id = u.split('/')[3] || 'b1'
    const sections = bookMetaById[id] !== undefined ? bookMetaById[id] : bookMetaSections
    const offsets = bookCharOffsetsById[id] !== undefined ? bookCharOffsetsById[id] : bookCharOffsets
    return jsonRes({
      id, name: '测试小说', total: 25, title: '测试小说', author: '佚名', sections,
      charOffsets: offsets, totalChars: offsets.length > 0 ? offsets[offsets.length - 1] : 0,
    })
  }
  if (u.includes('/dsh-music/book/') && u.includes('/text?from=')) {
    const from = parseInt(new URL('http://x' + u).searchParams.get('from') || '0', 10) || 0
    return jsonRes({ ok: true, from, text: bookTextFixture })
  }
  if (u.startsWith('/dsh-music/files')) {
    lastFilesUrl = u
    return jsonRes({ path: '/music', name: 'Music', up: '/', dirs: [], files: [{ name: 'a.mp3', path: '/music/a.mp3', size: 10, ext: 'mp3' }] })
  }
  if (u === '/dsh-music/playlist/clear') {
    const body = JSON.parse(o.body || '{}')
    const pl = (manifest.playlists || []).find((p) => p.id === body.id)
    if (pl) { pl.count = 0; pl.missing = 0; pl.tracks = [] }
    return jsonRes({ ok: true, cleared: 1, playlist: pl })
  }
  return jsonRes({})
}

// test hook: counts /dsh-music/radio/top and /radio/cn directory fetches —
// 热门/中文电台数据在面板会话内只拉一次（切回不重拉，缓存回归断言）。
let radioTopFetches = 0
let radioCnFetches = 0

async function bootClient() {
  factory = null
  registered = []
  radioTopFetches = 0
  radioCnFetches = 0
  window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('fetch', fetchStub)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  vi.stubGlobal('setInterval', () => 0) // intent poll: keep from firing
  vi.stubGlobal('clearInterval', () => {})
  window.confirm = () => true
  window.prompt = () => null

  // loading the module runs window.__ModuleLoader__.load -> captures the factory
  await import('../lib/client.js')
  expect(factory).toBeTruthy()
  const modExports = factory((name) => (name === 'react' ? React : undefined))

  const slots = {
    inject: (name, cb) => { cb() },
    register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
  }
  const ctx = {
    get: (k) => (k === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  }
  modExports.apply(ctx)
  // let the async loadTracks() (manifest fetch -> set store) finish
  await new Promise((r) => setTimeout(r, 0))
  return {
    bar: () => (registered.find((r) => r.id === 'music-player-bar') || {}).elementFactory,
    panel: () => (registered.find((r) => r.id === 'music-player-panel') || {}).elementFactory,
  }
}

// 轮询等待某个文本元素出现。用于 QQ/酷狗 面板点 tab 后异步渲染的子元素：
// 面板的 viewtabs 要等 /dsh-music/qq/status → setLoggedIn → 重渲染后才出现，
// 而单个 setTimeout(0) tick 在慢速/满载 runner（如 GitHub Actions 强制 Node 24）
// 上不足以等完这串异步，find() 会返回 undefined、后续 dispatchEvent 抛
// TypeError。这里用真实定时器轮询，对时序免疫（仅用于真实定时器测试，
// 不用于 vi.useFakeTimers() 的用例）。超时仍找不到则抛出以暴露问题。
// 默认 5s：2 核 CI runner 上全文件 142 用例并行跑时，fetch 链 + React 提交
// 可能被 CPU 争抢拖过 1.5s（实测出现过一次推荐歌单 viewtab 超时假失败）；
// 正常路径毫秒级返回，超时只影响真失败时多久报错。
async function waitForText(container, selector, text, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const el = [...container.querySelectorAll(selector)].find((b) => b.textContent === text);
    if (el) return el;
    if (Date.now() > deadline) throw new Error('waitForText 超时: ' + selector + ' ' + text);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function baseManifest() {
  return {
    root: '/music', bookRoot: '/books',
    tracks: [{ id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' }],
    books: [], count: 1, ttsConfigured: false, ttsReason: '', voices: [],
    playlists: [
      makePlaylist('pl-fav', '我最喜欢', true, []),
      makePlaylist('pl-1', '通勤', false, ['/music/a.mp3']),
    ],
  }
}

beforeEach(async () => {
  vi.resetModules()
  prefsServer = {}
  prefsPosts = []
  prefsPostOpts = []
  localStorage.clear() // isolated legacy browser-store between tests
  lastFilesUrl = null
  bookMetaSections = []
  bookMetaById = {}
  bookCharOffsets = []
  bookCharOffsetsById = {}
  qqLoggedIn = false
  favCalls = []
  delPlaylistCalls = []
  delPlaylistFail = false
  qqFetchLog = []
  lyricOnlineFixture = null
  manifest = baseManifest()
  newsScheduleServer = JSON.parse(JSON.stringify(newsScheduleDefault))
  newsFailuresServer = []
  newsRunState = null
  await bootClient()
})

describe('dsh-music-player client render smoke', () => {
  it('renders the now-playing bar without throwing', () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const html = renderToString(bar)
    expect(html).toContain('DSH音乐播放器')
    // idle state (no track) shows the music note icon
    expect(html).toContain('M12 3v10.55')
  })

  it('restores volume/mode/voice from the Host prefs snapshot and mirrors changes back (dsh-desktop fix)', async () => {
    // dsh-desktop: the Host snapshot is the only source of truth (no browser
    // storage at all). Seed the Host prefs and re-boot so the client restores
    // volume/mode/voice from it, then verify changes flush back to the Host.
    prefsServer = { 'dsh-music-volume': '0.42', 'dsh-music-mode': 'shuffle', 'dsh-music-voice': '碧瑶' }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar)) })

    // mode restored from Host ('乱序播放')
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('乱序播放'))
    expect(modeBtn).toBeTruthy()

    // volume restored from Host (42%)
    const volBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '音量')
    expect(volBtn).toBeTruthy()
    act(() => { volBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const volSlider = container.querySelector('.dsh-music-vol-slider')
    expect(volSlider).toBeTruthy()
    expect(volSlider.title).toBe('音量 42%')

    // changing the mode pushes the new value to the Host via POST /dsh-music/prefs
    const curModeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('乱序播放'))
    act(() => { curModeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const single = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('单曲循环'))
    expect(single).toBeTruthy()
    act(() => { single.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // the client flushes on an ~800ms debounce; wait for it to fire
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const modePost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-mode'])
    expect(modePost).toBeTruthy()
    expect(modePost.prefs['dsh-music-mode']).toBe('single')
    // the Host's persisted snapshot reflects the new mode too
    expect(prefsServer['dsh-music-mode']).toBe('single')
  })

  it('restores the last played track and QQ search history from the Host prefs after restart', async () => {
    // Real-world scenario: the Host file has a saved playback entry + QQ search
    // history. A fresh page load must restore both (bar shows the track, the
    // QQ search box shows the keyword) with NO browser storage.
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: '周杰伦 - Mine Mine.wav', position: 42, duration: 210, ts: 999999999 }),
      'dsh-music-qq-history': JSON.stringify(['刀郎']),
      'dsh-music-scope': JSON.stringify({ kind: 'library' }),
    }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // restorePlayback resolves the saved id '0' against the current library, so
    // the bar shows that track (baseManifest track 0 = "a.mp3" -> "a"), paused.
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('a')
    expect(container.querySelector('button[title="播放/暂停"]')).toBeTruthy()
    // open the panel -> QQ tab -> focus the search box -> history appears
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '刀郎')).toBe(true)
  })

  it('shows the current lyric line on the bar right after a paused refresh restore (no resume needed)', async () => {
    // Regression: play a track with a .lrc -> pause (lyric shows) -> refresh. On
    // boot the track is restored paused (audio never loaded, no timeupdate), so
    // the lyric data was only loaded lazily on ▶ and the bar stayed blank. It
    // must instead show the line at the restored position immediately.
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }),
      'dsh-music-scope': JSON.stringify({ kind: 'library' }),
    }
    lyricFixture = {
      ok: true, hasLrc: true, source: 'local',
      lrc: [
        { t: 0, text: '第一句歌词' },
        { t: 10, text: '第二句歌词' },
        { t: 40, text: '第三句歌词' },
        { t: 60, text: '第四句歌词' },
      ],
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-playback lyric fetch -> updateLyric (restored position 42s)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const lyric = container.querySelector('.dsh-music-bar-lyric')
    expect(lyric).toBeTruthy()
    // at the restored paused position (42s) the current line is the t=40 one
    expect(lyric.textContent).toContain('第三句歌词')
  })

  it('restores prefs even when the Host prefs fetch is slow (panel mounts before snapshot)', async () => {
    // Timing regression: in the real browser the /dsh-music/prefs fetch resolves
    // after the React tree mounts, so the QQ panel's mount-time history read sees
    // an empty snapshot. The prefsReady effect must re-apply it once it arrives.
    prefsServer = { 'dsh-music-qq-history': JSON.stringify(['七里香']) }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    // delay ONLY the /dsh-music/prefs GET to simulate network latency
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url) === '/dsh-music/prefs' && (!opts || !opts.method || opts.method === 'GET')) {
        return new Promise((resolve) => setTimeout(() => resolve(jsonRes({ ok: true, prefs: prefsServer })), 120))
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    // render the panel immediately (before the 120ms prefs fetch resolves)
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // open panel -> QQ -> search, focus input: history must be empty for now
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    // wait for the slow prefs fetch + prefsReady re-apply
    await act(async () => { await new Promise((r) => setTimeout(r, 160)) })
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '七里香')).toBe(true)
  })

  it('falls back to the old browser localStorage copy when the Host has no record (upgrade path)', async () => {
    // Pre-0.7 builds kept prefs under the SAME key names in localStorage. On
    // upgrade the Host file is empty, so the client must read the legacy browser
    // copy (mode + QQ history) and restore it — then migrate it into the Host.
    localStorage.setItem('dsh-music-mode', 'single')
    localStorage.setItem('dsh-music-qq-history', JSON.stringify(['刀郎']))
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // mode restored from the legacy browser copy ('单曲循环')
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('单曲循环'))
    expect(modeBtn).toBeTruthy()

    // QQ history restored from the legacy browser copy
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '刀郎')).toBe(true)

    // the legacy copy was migrated into the Host snapshot (read via loadPref)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // flush fires on an ~800ms debounce
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const migrated = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-mode'])
    expect(migrated).toBeTruthy()
    expect(migrated.prefs['dsh-music-mode']).toBe('single')
    expect(prefsServer['dsh-music-qq-history']).toBe(JSON.stringify(['刀郎']))
    // once adopted by the Host, the browser copies are removed — localStorage
    // is a one-way upgrade source and never keeps the migrated data.
    expect(localStorage.getItem('dsh-music-mode')).toBeNull()
    expect(localStorage.getItem('dsh-music-qq-history')).toBeNull()
  })

  it('电台 tab：搜索 → 播放 → 收藏（radio-browser 目录交互）', async () => {
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (name, cb) => { cb() }, register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory } }
    const ctx = { get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() }
    modExports.apply(ctx)
    await new Promise((r) => setTimeout(r, 0))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 切「电台」tab → 切「搜索」视图
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    expect(radioTab).toBeTruthy()
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()

    // 搜索「China」→ 出现 station 行
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'China')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = await waitForText(container, '.dsh-music-qq-station-name', 'China Plus')
    expect(row).toBeTruthy()

    // 点击行 → startRadioPlayback：audio.src 指向同源代理 + scope 置 radio
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const audioEl = audios[0] // 第一个 Audio 实例是主播放元素（第二个是讲书预加载 preAudio）
    expect(audioEl.src).toContain('/dsh-music/radio/play?u=')
    // 播放条名称显示电台名
    expect(container.querySelector('.dsh-music-bar-name-text').textContent).toContain('China Plus')

    // 收藏：点行尾 ♡ → POST /radio/favs（用包装 fetch 捕获请求）
    let radioFavPost = null
    const origFetch = global.fetch
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url) === '/dsh-music/radio/favs' && opts && opts.method === 'POST') radioFavPost = opts.body
      return origFetch(url, opts)
    })
    const favBtn = [...container.querySelectorAll('.dsh-music-qq-station-fav')][0]
    act(() => { favBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(radioFavPost).toBeTruthy()
    const favedBody = JSON.parse(radioFavPost)
    expect(favedBody.action).toBe('add')
    expect(favedBody.station.name).toBe('China Plus')

    // 播放电台后，Host prefs 必须收到 radio-playback（当前台）与 scope=radio——
    // 否则刷新后没有电台记录可恢复（会回退成别的来源）。
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // 等 debounce flush
    const radioSaved = JSON.parse(prefsServer['dsh-music-radio-playback'])
    expect(radioSaved.station.name).toBe('China Plus')
    expect(JSON.parse(prefsServer['dsh-music-scope']).kind).toBe('radio')
  })

  it('电台播放时播放条显示爱心按钮：点击收藏/取消收藏（走 Host /radio/favs）', async () => {
    // 回归：播放条爱心曾对电台隐藏（!isRadio）。电台收藏已支持 → 播放条也应
    // 能收藏/取消当前电台并点亮爱心（与列表 ♡ 同源：Host /radio/favs + store.radioFavs）。
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    let intent = null
    let intentPoll = null
    let favsServer = [] // 模拟 Host 收藏夹
    const baseFetch = fetchStub
    const fetcher = (url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/intent') return jsonRes(intent)
      if (u === '/dsh-music/radio/favs' && (!opts || !opts.method || opts.method === 'GET')) {
        return jsonRes({ ok: true, favs: favsServer.slice() })
      }
      if (u === '/dsh-music/radio/favs' && opts && opts.method === 'POST') {
        const b = JSON.parse(opts.body || '{}')
        const key = (s) => String((s && (s.id || s.stationuuid)) || '') || String((s && s.url) || '')
        if (b.action === 'remove') favsServer = favsServer.filter((f) => key(f) !== key(b.station))
        else if (!favsServer.some((f) => key(f) === key(b.station))) favsServer = [b.station, ...favsServer]
        return jsonRes({ ok: true, faved: b.action !== 'remove', favs: favsServer.slice() })
      }
      return baseFetch(url, opts)
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', (cb) => { intentPoll = cb; return 1 })
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const tick = () => new Promise((r) => setTimeout(r, 0))

    // 电台在播（radio intent）
    intent = { action: 'play', kind: 'radio', id: 'r1', name: 'China Plus', radioUrl: 'https://radio.example/live.mp3', codec: 'MP3', bitrate: 128, source: 'radio', hls: false }
    await act(async () => { await intentPoll() })
    await tick(); await tick()
    expect(audio.src).toContain('/dsh-music/radio/play?u=')
    act(() => { audio.emit('play') })

    // 播放条出现爱心按钮（电台不再隐藏）
    let heart = container.querySelector('.dsh-music-bar-btn.fav')
    expect(heart).toBeTruthy()
    expect(heart.className).not.toContain(' on') // 初始未收藏

    // 点击爱心 → 收藏（POST /radio/favs add）→ 点亮
    act(() => { heart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await tick(); await tick()
    heart = container.querySelector('.dsh-music-bar-btn.fav')
    expect(heart.className).toContain('on') // 收藏后点亮
    expect(favsServer.length).toBe(1)
    expect(favsServer[0].name).toBe('China Plus')

    // 再点爱心 → 取消收藏 → 熄灭
    act(() => { heart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await tick(); await tick()
    heart = container.querySelector('.dsh-music-bar-btn.fav')
    expect(heart.className).not.toContain('on')
    expect(favsServer.length).toBe(0)
  })

  it('电台播放失败自动退避重试（再点就好场景：首次 error 后自动重拉，不立即报错）', async () => {
    // 回归：AsiaFM高清音乐台等裸 AAC(aacp) 台在 Chromium 偶发解码失败（再点就好）。
    // radio onError 应自动退避重试（≤RADIO_RETRY_MAX 次），首次失败不弹「电台播放失败」。
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this); this.loadCount = 0 }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
      load() { this.loadCount++; super.load() }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (name, cb) => { cb() }, register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory } }
    const ctx = { get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() }
    modExports.apply(ctx)
    await new Promise((r) => setTimeout(r, 0))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 「网络电台」→ 「搜索」→ 搜到电台并播放（搜「China」出 China Plus 纯流台）
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'China')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const row = await waitForText(container, '.dsh-music-qq-station-name', 'China Plus')
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const playing = audios.find((a) => a.src && a.src.includes('/dsh-music/radio/play'))
    expect(playing).toBeTruthy()
    const loadBefore = playing.loadCount

    // 触发一次 error（模拟浏览器偶发解码失败）→ 应自动重试而非立即报错
    act(() => { playing.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
    // 尚未到退避延时，先确认没有立刻弹错误提示
    const errEl0 = container.querySelector('.dsh-music-bar-error, [class*="error"]')
    // 等退避（0.6s）+ 重试 load
    await act(async () => { await new Promise((r) => setTimeout(r, 900)) })
    // 自动重试 = 主 audio 再次 load 且 src 仍指向该电台
    expect(playing.loadCount).toBeGreaterThan(loadBefore)
    // 错误提示不应是「电台播放失败」（自动重试期间 error 被清空）
    const bodyText = container.textContent
    expect(bodyText).not.toContain('电台播放失败')
  })

  it('电台 tab：中文电台目录首屏失败自动重试后恢复（不永远卡在加载中）', async () => {
    // 回归：/radio/cn 偶发失败（上游镜像全部瞬时不可达）曾让目录视图永远停在
    // 「加载中…」——现在首屏失败自动退避重试 2 次，恢复后正常渲染列表。
    let cnFails = 2 // 前 2 次 /radio/cn 返回失败（首拉 + 第 1 次重试），第 3 次成功
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', (url, opts) => {
      const u = String(url)
      if (u.includes('/dsh-music/radio/cn') && cnFails > 0) {
        cnFails--
        return Promise.resolve(jsonRes({ ok: false, error: 'fetch failed' }))
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (name, cb) => { cb() }, register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory } }
    const ctx = { get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() }
    modExports.apply(ctx)
    await new Promise((r) => setTimeout(r, 0))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 网络电台 → 「中文电台」视图
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const cnTab = await waitForText(container, '.dsh-music-qq-viewtab', '中文电台')
    act(() => { cnTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // 前两次失败（含 0.6s/1.2s 退避）后第 3 次成功 → 目录正常渲染，不卡「加载中…」
    let cnLoaded = false
    for (let i = 0; i < 40 && !cnLoaded; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
      cnLoaded = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))
    }
    expect(cnLoaded).toBe(true)
    expect(cnFails).toBe(0) // 3 次请求都发过（首拉 + 2 次重试中的前 2 次失败已被消费）
    // 无「加载失败」残留文案
    expect(container.textContent).not.toContain('中文电台加载失败')
  })

  it('电台 tab：中文电台目录重试耗尽显示「加载失败 + 重试」，点重试恢复列表', async () => {
    // 回归：目录源持续失败时曾永远停在「加载中…」。现在自动重试 2 次后给出
    // 明确失败态 + 手动「重试」按钮；点重试成功即恢复列表。
    let failAll = true // 一直失败，直到点「重试」后翻转为成功
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', (url, opts) => {
      const u = String(url)
      if (u.includes('/dsh-music/radio/cn') && failAll) {
        return Promise.resolve(jsonRes({ ok: false, error: 'fetch failed' }))
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (name, cb) => { cb() }, register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory } }
    const ctx = { get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() }
    modExports.apply(ctx)
    await new Promise((r) => setTimeout(r, 0))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 网络电台 → 「中文电台」视图（持续失败）
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const cnTab = await waitForText(container, '.dsh-music-qq-viewtab', '中文电台')
    act(() => { cnTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // 等首拉 + 2 次退避重试（0.6s + 1.2s）耗尽 → 失败态 + 「重试」按钮出现
    let failVisible = false
    for (let i = 0; i < 50 && !failVisible; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
      failVisible = [...container.querySelectorAll('.dsh-music-empty')].some((b) => (b.textContent || '').includes('中文电台加载失败'))
    }
    expect(failVisible).toBe(true)
    const retryBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '重试')
    expect(retryBtn).toBeTruthy()

    // 翻转 stub 为成功，点「重试」→ 列表恢复
    failAll = false
    act(() => { retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    let cnLoaded = false
    for (let i = 0; i < 30 && !cnLoaded; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
      cnLoaded = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))
    }
    expect(cnLoaded).toBe(true)
    expect(container.textContent).not.toContain('中文电台加载失败')
  })

  it('电台 tab：切到「搜索」视图不显示热门电台残留（搜索引导态）', async () => {
    // 回归：search 视图曾直接渲染热门 rows（数据串台）。现在搜索视图有独立
    // searchResults（null=未搜），切过去应显示引导提示而非热门列表。
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 「网络电台」tab（默认我的电台视图）→ 切「热门电台」加载出热门列表
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const topTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '热门电台')
    act(() => { topTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 等热门目录异步加载完成（多轮 act 提交，避免 waitForText 无 act 包裹不触发渲染）
    let topVisible = false
    for (let i = 0; i < 20 && !topVisible; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
      topVisible = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('热门台A'))
    }
    expect(topVisible).toBe(true)

    // 切到「搜索」：此刻尚未搜索 → 应显示引导提示，绝不该出现热门台列表
    const searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 120)) })
    const empties = [...container.querySelectorAll('.dsh-music-empty')].map((e) => e.textContent)
    const stations = [...container.querySelectorAll('.dsh-music-qq-station-name')].map((e) => e.textContent)
    expect(empties.some((t) => (t || '').includes('开始搜索'))).toBe(true)
    expect(stations.some((t) => t.includes('热门台A'))).toBe(false)
    expect(container.querySelector('.dsh-music-qq-input')).toBeTruthy()
  })

  it('电台 tab：中文电台视图实时加载 CN 目录，纯流可播、HLS 台灰显不可播', async () => {
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (name, cb) => { cb() }, register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory } }
    const ctx = { get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() }
    modExports.apply(ctx)
    await new Promise((r) => setTimeout(r, 0))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 电台 tab → 「中文电台」
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const cnTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '中文电台')
    expect(cnTab).toBeTruthy()
    act(() => { cnTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // 等 CN 目录异步加载完成：北京新闻广播（纯流）+ 凤凰卫视资讯台（HLS 灰显）都出现
    let cnLoaded = false
    for (let i = 0; i < 20 && !cnLoaded; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
      cnLoaded = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))
    }
    expect(cnLoaded).toBe(true)

    const rows = [...container.querySelectorAll('.dsh-music-qq-station')]
    expect(rows.length).toBeGreaterThanOrEqual(3) // 首屏 50（含合成行），fixture 3 个命名台必在
    // 纯流台可播：点整行（.dsh-music-track 主体）→ startRadioPlayback
    const bjRow = rows.find((r) => r.textContent.includes('北京新闻广播'))
    act(() => { bjRow.querySelector('.dsh-music-track').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audios[0].src).toContain('/dsh-music/radio/play?u=')

    // HLS 台：可播（不再灰显/禁播），显示「HLS」徽章；点整行 → startRadioPlayback 且 URL 带 hls=1
    const ifengRow = rows.find((r) => r.textContent.includes('凤凰卫视资讯台'))
    expect(ifengRow.className).not.toContain('hls-only')
    expect(ifengRow.querySelector('.dsh-music-qq-station-tag.hls')).toBeTruthy() // HLS 徽章
    expect(ifengRow.querySelector('.dsh-music-track')).toBeTruthy() // 整行可点主体存在
    act(() => { ifengRow.querySelector('.dsh-music-track').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ifengAudio = audios.find((a) => a.src && a.src.includes('/dsh-music/radio/play'))
    expect(ifengAudio).toBeTruthy() // HLS 台同样触发播放
    expect(ifengAudio.src).toContain('hls=1') // 播放 URL 带 hls 标记（Host 走转流）
    // 音质徽章：HLS 台显示「电台 · HLS」，不再显示 UNKNOWN（codec=UNKNOWN 但 hls=true）
    const srcBadge = container.querySelector('.dsh-music-bar-src')
    expect(srcBadge).toBeTruthy()
    expect(srcBadge.textContent).toContain('电台')
    expect(srcBadge.textContent).toContain('HLS')
    expect(srcBadge.textContent).not.toContain('UNKNOWN')
    // 收藏钮仍可用（行尾独立按钮，stopPropagation 不影响整行点播）
    const favBtn = ifengRow.querySelector('.dsh-music-qq-station-fav')
    expect(favBtn).toBeTruthy()
  })

  it('中文电台：分组 pill 行展示，切「音乐」组只拉该组数据并渲染', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    radioCnFetches = 0
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 网络电台 → 「中文电台」视图
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const cnTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '中文电台')
    act(() => { cnTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 等「全部」组加载（默认分组 = all）
    let cnLoaded = false
    for (let i = 0; i < 20 && !cnLoaded; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      cnLoaded = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))
    }
    expect(cnLoaded).toBe(true)
    expect(radioCnFetches).toBe(1)

    // 分组 pill 行存在（中文电台：全部/新闻/音乐/交通/财经/文艺/故事/体育）
    const cats = [...container.querySelectorAll('.dsh-music-qq-cat')].map((b) => b.textContent)
    expect(cats).toEqual(['全部', '新闻', '音乐', '交通', '财经', '文艺', '故事', '体育'])
    // 「全部」当前激活
    expect(container.querySelector('.dsh-music-qq-cat.active').textContent).toBe('全部')

    // 切「音乐」组 → 只拉 /radio/cn?group=music 数据（stub 返回中文音乐台甲/乙）
    const musicCat = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '音乐')
    act(() => { musicCat.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    let musicLoaded = false
    for (let i = 0; i < 20 && !musicLoaded; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      musicLoaded = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('中文音乐台甲'))
    }
    expect(musicLoaded).toBe(true)
    expect(radioCnFetches).toBe(2) // all(1) + music(1)
    // 激活态切换到「音乐」；不再显示北京新闻广播（那是 all 组数据）
    expect(container.querySelector('.dsh-music-qq-cat.active').textContent).toBe('音乐')
    expect([...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))).toBe(false)

    // 切回「全部」：缓存命中不重拉，直接显示
    const allCat = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '全部')
    act(() => { allCat.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(radioCnFetches).toBe(2)
    expect([...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))).toBe(true)
  })

  it('网络电台：中文/热门列表先加载 50 条，点「加载更多」再追加下一页', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    radioTopFetches = 0; radioCnFetches = 0
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 网络电台 → 中文电台（默认全部组）
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const cnTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '中文电台')
    act(() => { cnTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 等首屏 50 条加载完成（合成行「中文电台51」在第 51..100 页，不在首页）
    let loaded = false
    for (let i = 0; i < 20 && !loaded; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      loaded = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('中文电台1'))
    }
    expect(loaded).toBe(true)
    // 首屏 50 条：能看到首页第 50 个合成台（中文电台50? 首页 i=49 → 中文电台50），
    // 看不到第 51 个（中文电台51，属于 offset=50 页）
    const names1 = [...container.querySelectorAll('.dsh-music-qq-station-name')].map((b) => b.textContent)
    // 首页 0..49：0/1/2 是命名台（北京/上海/凤凰），3..49 为合成台（47 个，中文电台4..中文电台50）
    expect(names1.filter((n) => n.startsWith('中文电台')).length).toBe(47)
    expect(names1.some((n) => n.includes('中文电台50'))).toBe(true)
    expect(names1.some((n) => n.includes('中文电台51'))).toBe(false)
    expect(radioCnFetches).toBe(1)
    // 「加载更多」按钮出现
    let moreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '加载更多')
    expect(moreBtn).toBeTruthy()

    // 点「加载更多」→ 追加 offset=50 页（中文电台51..100）
    act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    let secondLoaded = false
    for (let i = 0; i < 20 && !secondLoaded; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      secondLoaded = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('中文电台51'))
    }
    expect(secondLoaded).toBe(true)
    expect(radioCnFetches).toBe(2) // 首页 + 第二页
    // 0..99 行：3 命名台 + 97 合成台（i=3..99，名 中文电台4..中文电台100）
    const names2 = [...container.querySelectorAll('.dsh-music-qq-station-name')].map((b) => b.textContent)
    expect(names2.filter((n) => n.startsWith('中文电台')).length).toBe(97)
    expect(names2.some((n) => n.includes('北京新闻广播'))).toBe(true)
    // 仍可继续加载（120 未到底）：按钮还在
    moreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '加载更多')
    expect(moreBtn).toBeTruthy()
  })

  it('网络电台：热门/中文电台列表首次进入拉取一次，切走再切回不再重新请求（缓存）', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    radioTopFetches = 0; radioCnFetches = 0
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 打开面板 → 网络电台 tab（默认「我的电台」）→ 切「热门电台」首次加载一次
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const radioTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网络电台')
    act(() => { radioTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const topTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '热门电台')
    act(() => { topTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 等热门加载出
    let topVisible = false
    for (let i = 0; i < 20 && !topVisible; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      topVisible = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('热门台A'))
    }
    expect(topVisible).toBe(true)
    expect(radioTopFetches).toBe(1)

    // 切中文电台（拉一次 cn）
    const cnTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '中文电台')
    act(() => { cnTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    let cnVisible = false
    for (let i = 0; i < 20 && !cnVisible; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
      cnVisible = [...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))
    }
    expect(cnVisible).toBe(true)
    expect(radioCnFetches).toBe(1)

    // 热门 → 中文来回切：不再新增目录请求（缓存命中）
    act(() => { topTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(radioTopFetches).toBe(1)
    act(() => { cnTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(radioCnFetches).toBe(1)
    // 中文列表仍显示（缓存内容直接渲染，无需 loading）
    expect([...container.querySelectorAll('.dsh-music-qq-station-name')].some((b) => b.textContent.includes('北京新闻广播'))).toBe(true)
  })

  it('网络电台：重启后恢复当前台到播放条', async () => {
    // 模拟重启：Host prefs 里躺着一条电台播放记录。新会话必须恢复同一电台，
    // 播放条显示台名（暂停态），点 ▶ 重新拉流播放。
    // （配套 Host 白名单回归见 index.test.js：radio-playback/radio-history 必须
    // 能落盘——曾漏出 PREF_ALLOW 被 sanitizePrefs 静默丢弃，刷新后无电台记录可恢复。）
    prefsServer = {
      'dsh-music-radio-playback': JSON.stringify({
        station: {
          id: 'cn1', stationuuid: 'cn1', name: '北京新闻广播',
          url: 'https://radio.example/bj.mp3', codec: 'MP3', bitrate: 64,
          hls: false, country: 'China', countrycode: 'CN', lastcheckok: true,
        },
        ts: 999999999,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'radio' }),
    }
    const audios = []
    class RAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', RAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

    // restoreRadioPlayback ran during loadTracks: bar shows the radio station (paused)
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('北京新闻广播')
    // 点 ▶ → togglePlay 重新挂电台流
    const playBtn = [...container.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
    expect(playBtn).toBeTruthy()
    act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audios[0].src).toContain('/dsh-music/radio/play?u=')
  })

  it('never writes new data to the browser store (Host-only persistence)', async () => {
    // Regression guard for the "no browser storage" guarantee: a savePref (here
    // triggered by changing the play mode) must NOT appear in localStorage —
    // the Host is the only place new data is stored.
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // change mode: 顺序播放 -> 单曲循环 (default is 'order')
    const curModeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('顺序播放'))
    act(() => { curModeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const single = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('单曲循环'))
    act(() => { single.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })

    // flushed to the Host…
    expect(prefsPosts.some((p) => p.prefs && p.prefs['dsh-music-mode'] === 'single')).toBe(true)
    expect(prefsServer['dsh-music-mode']).toBe('single')
    // …but NOT mirrored into localStorage
    expect(localStorage.getItem('dsh-music-mode')).toBeNull()
  })

  it('keeps the Host value authoritative over a conflicting legacy localStorage copy', async () => {
    // If both the Host and the old browser store have a value, the Host wins.
    prefsServer = { 'dsh-music-mode': 'order', 'dsh-music-volume': '0.5' }
    localStorage.setItem('dsh-music-mode', 'single') // stale legacy conflict
    localStorage.setItem('dsh-music-volume', '0.9')
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // Host's 'order' (顺序播放) wins, not legacy 'single' (单曲循环)
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('顺序播放'))
    expect(modeBtn).toBeTruthy()
    const singleBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title.startsWith('单曲循环'))
    expect(singleBtn).toBeFalsy()
    // the stale browser duplicates are dropped once the Host snapshot has them
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(localStorage.getItem('dsh-music-mode')).toBeNull()
    expect(localStorage.getItem('dsh-music-volume')).toBeNull()
  })

  it('migrates the legacy single-book key into the per-book map on upgrade', async () => {
    // Pre-0.2.1 stored ONE book's progress in dsh-music-book-playback. On upgrade
    // it must fold into dsh-music-books-playback so the novel keeps its place.
    localStorage.setItem('dsh-music-book-playback', JSON.stringify({
      id: 'book:b1', name: '凡人修仙传.txt', from: 5, base: 100, pos: 42, total: 25, ts: 111,
    }))
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    manifest = { ...baseManifest(), books: [{ id: 'book:b1', name: '凡人修仙传.txt', url: '/dsh-music/book/b1/text?from=0', sections: [], total: 25, ext: 'txt' }] }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    // wait for the legacy migration (runs after loadServerPrefs resolves)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the per-book map now holds the legacy entry and flushes to the Host
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const map = JSON.parse(prefsServer['dsh-music-books-playback'] || '{}')
    expect(map['凡人修仙传.txt']).toBeTruthy()
    expect(map['凡人修仙传.txt'].pos).toBe(42)
    // 恢复阶段会把 ts 保鲜到当前时间（restoreBookPlayback 与 QQ 恢复同理：
    // 「更新时间戳，避免被当作旧数据」），但迁移本身不得丢失/破坏条目。
    expect(map['凡人修仙传.txt'].ts).toBeGreaterThan(111)
    // the legacy single-book key is gone from the browser store
    expect(localStorage.getItem('dsh-music-book-playback')).toBeNull()
  })

  it('restores the book (not newer-saved music) when the last activity was a book, and marks scope book', async () => {
    // Regression（刷新后讲书被切到音乐）: 讲书从不写 scope='book'（恢复快捷分支是
    // 死代码），而本地音乐的 restorePlayback 每次刷新都会把自己的 ts 重写为当前时间
    // → 讲书在 scope/时间戳两个信号上都系统性输给音乐。现在讲书恢复/播放会写
    // scope='book'（快捷分支生效）并保鲜自己的 ts：即使音乐记录的 ts 更新，刷新后
    // 也必须恢复讲书而不是音乐。
    const bm = baseManifest()
    manifest = { ...bm, ttsConfigured: true, books: [{ id: 'b1', name: '续播范畴测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '续播范畴测试文本。'
    prefsServer = {
      'dsh-music-scope': JSON.stringify({ kind: 'book' }),
      // 音乐记录 ts 比讲书「新」：旧逻辑会据此恢复音乐
      'dsh-music-playback': JSON.stringify({ id: bm.tracks[0].id, name: bm.tracks[0].name, position: 1, duration: 9, ts: 9999999999999 }),
      'dsh-music-books-playback': JSON.stringify({
        '续播范畴测试.txt': { from: 1, base: 5, pos: 2, total: 25, ts: 8888888888 },
      }),
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar)) })
    // 恢复的是讲书（不是 ts 更新的音乐）
    expect(container.querySelector('.dsh-music-bar').textContent).toContain('续播范畴测试')
    // 讲书恢复把范畴信号落盘为 'book'（下次刷新快捷分支直接命中）。pref 走 Host
    // 防抖 flush（localStorage 只读不写），等 flush 周期后断言 Host 侧的值。
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-scope'] || 'null')).toEqual({ kind: 'book' })
    bookTextFixture = ''
  })

  it('stays in the work state (no dim / controls expanded) when there is no playback content', async () => {
    // 无播放内容（插件刚安装 / 点击停止）：播放条恒定工作态 —— 不透明度 100%、控件组
    // 展开，不做「闲置/工作态」的特效（不半透明、不滑入滑出、时长不显示）。有内容时
    // 才启用那些交互（由上面的 hover/dim 测试覆盖）。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const barEl = container.querySelector('.dsh-music-bar')
    expect(barEl).toBeTruthy()
    const controls = container.querySelector('.dsh-music-bar-controls')
    expect(controls).toBeTruthy()
    // 无内容 → 恒定工作态：不加 dimmed、控件组 .on 展开、无时长
    expect(barEl.classList.contains('dimmed')).toBe(false)
    expect(controls.classList.contains('on')).toBe(true)
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
  })

  it('renders a 1px progress line at the bar bottom that fills with playback', async () => {
    // 播放进度细线：有内容且已获取时长时，在播放条底部渲染一条与播放条等宽、高 1px
    // 的细线，填充宽度 = position/duration * 100%；无内容/无时长时不渲染。
    const audios = []
    class LocalAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LocalAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 无时长（duration 为 0）：细线不渲染
      expect(container.querySelector('.dsh-music-bar-progress')).toBeNull()
      // 有时长后：进度 50/200 = 25%（duration 由 durationchange 事件写入 store）
      audio.duration = 200
      audio.currentTime = 50
      act(() => { audio.emit('durationchange') })
      act(() => { audio.emit('timeupdate') })
      const progress = container.querySelector('.dsh-music-bar-progress')
      expect(progress).toBeTruthy()
      const fill = container.querySelector('.dsh-music-bar-progress-fill')
      expect(fill).toBeTruthy()
      expect(fill.style.width).toBe('25%')
      // 推进到末尾 → 100%
      audio.currentTime = 200
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-progress-fill').style.width).toBe('100%')
      // 细线是播放条的直接子节点（绝对定位、等宽于播放条）
      const barEl = container.querySelector('.dsh-music-bar')
      expect(progress.parentNode).toBe(barEl)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('slides the right-side control buttons in/out on bar hover with a 1s slide-out delay', async () => {
    // Regression: the bar's right-side controls (heart/prev/play/next/stop/mode/
    // volume/panel) must be hidden by default and slide in on mouseenter, slide
    // out on mouseleave with a 1s delay (prevents accidental hide on a quick
    // mouse-out). The time text is part of that foreground cluster: it also
    // hides in the idle (collapsed) state and only shows while hovering.
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // play a local track so the transport buttons are present
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    expect(barEl).toBeTruthy()
    const controls = container.querySelector('.dsh-music-bar-controls')
    expect(controls).toBeTruthy()
    // 右端热区：鼠标移入它才触发按钮滑入（播放条其它区域不触发）。
    const hotspot = container.querySelector('.dsh-music-bar-hotspot')
    expect(hotspot).toBeTruthy()
    // 默认隐藏：无 .on，闲置态时长一并隐藏（新行为：时长只在操作时显示）
    expect(controls.classList.contains('on')).toBe(false)
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    // 播放条文件名去掉扩展名（本地音乐 a.mp3 -> a）；文件列表里仍保留 a.mp3
    const barName = container.querySelector('.dsh-music-bar-name')
    expect(barName).toBeTruthy()
    expect(barName.textContent).not.toContain('.mp3')
    expect(barName.textContent).toContain('a')
    expect(container.textContent).toContain('a.mp3')
    // 用假定时器控制 1s 滑出延迟。
    vi.useFakeTimers()
    try {
      // 鼠标进入播放条右端热区（.dsh-music-bar-hotspot）→ 控制按钮滑入（加 .on）。
      // React 的 onMouseEnter/onMouseLeave 由原生 mouseover/mouseout 事件驱动
      // （relatedTarget 为空 = 从外部进入/离开）。整个播放条其它区域不再触发。
      act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true)
      // 操作态：时长显示
      expect(container.querySelector('.dsh-music-bar-time')).toBeTruthy()
      // 鼠标离开 → 1s 延迟内按钮仍保持展开（防止误移出）
      act(() => { controls.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true)
      // 延迟内重新进入 → 取消隐藏，按钮保持展开
      act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      act(() => { vi.advanceTimersByTime(1500) })
      expect(controls.classList.contains('on')).toBe(true)
      // 离开后超过 1s → 按钮滑出隐藏（去 .on）
      act(() => { controls.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true) // 还在延迟内
      act(() => { vi.advanceTimersByTime(1000) })
      expect(controls.classList.contains('on')).toBe(false)
      // 离开后（闲置态）：时长一并隐藏
      expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    // 收藏/播放控制按钮在 controls 容器内
    expect(controls.querySelector('.dsh-music-bar-btn.fav')).toBeTruthy()
    expect([...controls.querySelectorAll('.dsh-music-bar-btn')].some((b) => b.title === '播放/暂停')).toBe(true)
  })

  it('only the right-end hotspot triggers the control buttons (bar left/middle area does NOT)', async () => {
    // Regression: 鼠标事件只挂在播放条右端热区（.dsh-music-bar-hotspot）上，播放条
    // 左/中部（歌名、歌词等区域）不再触发按钮组滑入——减少工作时误触发。同时验证
    // 从热区移到按钮（relatedTarget 仍在按钮组内）不会误收起。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    const controls = container.querySelector('.dsh-music-bar-controls')
    const hotspot = container.querySelector('.dsh-music-bar-hotspot')
    const nameEl = container.querySelector('.dsh-music-bar-name')
    expect(barEl).toBeTruthy()
    expect(controls).toBeTruthy()
    expect(hotspot).toBeTruthy()
    expect(nameEl).toBeTruthy()
    // 默认隐藏
    expect(controls.classList.contains('on')).toBe(false)
    // 鼠标移入播放条左中部（歌名区域）→ 不触发展开
    act(() => { nameEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(controls.classList.contains('on')).toBe(false)
    expect(barEl.classList.contains('dimmed')).toBe(true)
    // 鼠标移入右端热区 → 触发滑入
    act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(controls.classList.contains('on')).toBe(true)
    expect(barEl.classList.contains('dimmed')).toBe(false)
    // 从热区移到按钮（relatedTarget 在按钮组内）→ 保持展开，不误收起
    vi.useFakeTimers()
    try {
      const playBtn = [...controls.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
      act(() => { hotspot.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: playBtn })) })
      act(() => { vi.advanceTimersByTime(1500) })
      expect(controls.classList.contains('on')).toBe(true)
      // 从按钮组移出播放条（relatedTarget 在播放条外）→ 1s 后收起
      act(() => { controls.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(controls.classList.contains('on')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the panel on clicking the bar name (track) or the idle title', async () => {
    // 单击播放条左侧名称（有曲目时的 .dsh-music-bar-name）或停止状态的怠速标题
    // .dsh-music-bar-idle「DSH音乐播放器」→ 打开面板弹窗（再单击关闭，toggle）——
    // 与有曲目时单击歌名行为完全一致。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl).toBeTruthy()
    // 停止状态（无曲目）：单击标题 → 打开
    const idle = container.querySelector('.dsh-music-bar-idle')
    expect(idle).toBeTruthy()
    expect(panelEl.style.display).toBe('none')
    act(() => { idle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).not.toBe('none')
    // 再单击 → 关闭（toggle）
    act(() => { idle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
    // 播放本地曲目：先打开面板点 a.mp3（复用 idle 单击打开面板）
    act(() => { idle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const nameEl = container.querySelector('.dsh-music-bar-name-text')
    expect(nameEl).toBeTruthy()
    // 播放后面板仍打开 → 单击歌名文本 → 关闭（toggle）
    act(() => { nameEl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
    // 再单击歌名 → 重新打开
    act(() => { nameEl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).not.toBe('none')
  })

  it('closes the player panel with the Escape key', async () => {
    // Esc 关闭播放面板：面板打开时按 Esc → 关闭；再 Esc（面板已关）→ 不报错。
    // 内层自带 Esc 语义的弹层（.dsh-music-picker-overlay，如新建/重命名歌单的
    // prompt、删除确认、各在线平台登录、定时任务编辑、版本更新弹窗）在场时，
    // Esc 归弹层自身处理，不关闭面板——见下一个用例。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl).toBeTruthy()
    // 初始关闭
    expect(panelEl.style.display).toBe('none')
    // 打开面板（右侧「打开播放列表」按钮）
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).not.toBe('none')
    // Esc → 关闭
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
    // 面板已关时再按 Esc → 无副作用（不抛错、保持关闭）
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
  })

  it('Escape while an inner picker overlay is open closes only the overlay, not the panel', async () => {
    // 新建/重命名歌单等 prompt（portal 到 body 的 .dsh-music-picker-overlay）打开时
    // 按 Esc：面板保持打开，弹层自行关闭（PromptModal 自带的 onKeyDown 处理）。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl).toBeTruthy()
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).not.toBe('none')
    // 打开「＋ 新建歌单」prompt（音乐页子标签栏末尾的 ＋ 按钮）
    const addBtn = [...container.querySelectorAll('.dsh-music-subtab.add')].find((b) => b.title === '新建歌单')
    expect(addBtn).toBeTruthy()
    act(() => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const promptBox = container.querySelector('.dsh-music-picker-overlay')
    expect(promptBox).toBeTruthy()
    const input = promptBox.querySelector('.dsh-music-prompt-input')
    expect(input).toBeTruthy()
    // 内层弹层在场时按 Esc → 面板保持打开。真实场景焦点在弹层输入框内，
    // 事件从 input 冒泡：面板的 capture 处理器先看到弹层在场而让行，
    // 随后 PromptModal 自带的 onKeyDown 关掉弹层。
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).not.toBe('none')
    // prompt 已被 Esc 关闭
    expect(container.querySelector('.dsh-music-picker-overlay')).toBeNull()
    // 弹层已关、面板仍开 → 再按 Esc → 面板关闭
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
  })

  it('clicking the quality badge does NOT open the panel (track name/artist do)', async () => {
    // Regression: 单击事件挂在名称容器（.dsh-music-bar-name）上，歌名/歌手/章节
    // 等附属信息单击都打开面板；唯独音质徽章（.dsh-music-bar-src）不触发——它是纯
    // 信息展示，单击不应打开面板（由 togglePanelOnName 内的 closest 排除）。
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.flac', url: '/dsh-music/0', size: 10, ext: 'flac', path: '/music/a.flac', quality: 'FLAC · 无损', artists: ['周杰伦'] }] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // 打开面板 → 播放 a.flac（带音质徽章 + 歌手名）
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.flac'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl).toBeTruthy()
    // 关闭面板 → 初始为关（此时播放列表按钮 title 已变为「关闭播放列表」）
    act(() => { container.querySelector('button[title="关闭播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
    // 音质徽章存在
    const badge = container.querySelector('.dsh-music-bar-src')
    expect(badge).toBeTruthy()
    expect(badge.textContent).toContain('FLAC · 无损')
    // 单击音质徽章 → 面板仍关闭（不触发）
    act(() => { badge.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
    // 单击歌手名（.dsh-music-bar-artist）→ 面板打开（附属信息也可触发，仅徽章除外）
    const artistEl = container.querySelector('.dsh-music-bar-artist')
    expect(artistEl).toBeTruthy()
    expect(artistEl.textContent).toContain('周杰伦')
    act(() => { artistEl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).not.toBe('none')
    // 再单击歌手名 → 关闭（toggle）
    act(() => { artistEl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
  })

  it('keeps the name-click toggle working when the real mousedown→click order fires', async () => {
    // 回归：播放面板有全局 mousedown「点外部关闭」处理器。真实浏览器里 mousedown
    // 恒先于 click：面板打开时单击歌名，mousedown 先把面板关掉，随后的 click toggle
    // 又把它重新打开 → 表现为「再单击还是打开」。名称区已加入豁免名单（与右侧
    // 按钮组同理），本用例按真实顺序派发 mousedown + click，断言 toggle 正常关闭。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // 打开面板 → 播放 a.mp3（歌名区出现，面板保持打开）
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl.style.display).not.toBe('none')
    const nameEl = container.querySelector('.dsh-music-bar-name')
    expect(nameEl).toBeTruthy()
    // mousedown（点外部关闭的入口事件）→ 名称区豁免：面板保持打开
    act(() => { nameEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).not.toBe('none')
    // 随后的 click → toggle 正常关闭（不再被「mousedown 先关 + click 重开」抵消）
    act(() => { nameEl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(panelEl.style.display).toBe('none')
  })

  it('dims the whole bar to 50% opacity on mouse-leave (1s delay), full opacity on hover', async () => {
    // 后台静默播放效果：鼠标移入 → 播放条完全不透明（去 dimmed）；鼠标移出 1s 后 →
    // 控件组折叠的同时播放条变半透明（加 dimmed）。两者同一状态源（barHover）同步变化。
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const barEl = container.querySelector('.dsh-music-bar')
    expect(barEl).toBeTruthy()
    const controls = container.querySelector('.dsh-music-bar-controls')
    const hotspot = container.querySelector('.dsh-music-bar-hotspot')
    // 初始（未悬停）：半透明 dimmed
    expect(barEl.classList.contains('dimmed')).toBe(true)
    // 闲置态时长隐藏（新行为）
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    vi.useFakeTimers()
    try {
      // 鼠标移入右端热区 → 立即不透明（去 dimmed），控件组随之滑入
      act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      expect(controls.classList.contains('on')).toBe(true)
      // 操作态时长显示（新行为）
      expect(container.querySelector('.dsh-music-bar-time')).toBeTruthy()
      // 鼠标移出 → 1s 延迟内仍不透明（防误移出）
      act(() => { controls.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      // 延迟内重新进入 → 取消隐藏，保持不透明
      act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      act(() => { vi.advanceTimersByTime(1500) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      // 离开超过 1s → 控件组折叠，同时播放条变半透明
      act(() => { controls.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(controls.classList.contains('on')).toBe(false)
      expect(barEl.classList.contains('dimmed')).toBe(true)
      // 回到闲置态：时长再次隐藏（新行为）
      expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the controls expanded while the mode popup is open (portal hover fix)', async () => {
    // Regression: the mode popup is portaled to body (outside the bar DOM), so moving
    // the mouse onto it fires the bar's mouseleave. The buttons must NOT collapse
    // while a popup is open, otherwise the popup detaches and mispositions.
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const controls = container.querySelector('.dsh-music-bar-controls')
    const hotspot = container.querySelector('.dsh-music-bar-hotspot')
    act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(controls.classList.contains('on')).toBe(true)
    // 打开模式弹窗（默认模式=顺序播放）
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '顺序播放')
    expect(modeBtn).toBeTruthy()
    act(() => { modeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 弹窗打开 → 即使鼠标移出右端控件区（mouseout 触发 mouseleave），按钮仍保持展开。
    // 先开假定时器，让 mouseleave 安排的 1s 收起定时器成为假定时器，可被推进触发。
    vi.useFakeTimers()
    try {
      act(() => { controls.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
      expect(controls.classList.contains('on')).toBe(true)
      // 鼠标移出超过 1s：barHover 变为 false，但弹窗打开期间 .on 仍由 anyPopOpen 保持
      act(() => { vi.advanceTimersByTime(1200) })
      expect(controls.classList.contains('on')).toBe(true)
    } finally { vi.useRealTimers() }
    // 选择「单曲循环」→ 弹窗关闭
    const single = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('单曲循环'))
    expect(single).toBeTruthy()
    act(() => { single.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // Regression: 弹窗关闭后 .on 必须立即随 anyPopOpen 收起（此时 barHover 已为 false、
    // 鼠标已不在播放条上、不再触发 mouseleave），否则按钮组一直保持展开不折叠。
    expect(controls.classList.contains('on')).toBe(false)
  })

  it('draws an oscilloscope-style waveform from the live time-domain analyser data', async () => {
    // Waveform mode (dsh-music-viz-mode = 'wave') draws a single continuous curve from
    // getByteTimeDomainData instead of frequency bars. It is driven by the live
    // captureStream+AnalyserNode tap only — no offline fallback — so a non-flat time-domain
    // read must produce a stroked path, and no bars (fillRect) are drawn.
    prefsServer = { 'dsh-music-viz-mode': 'wave' }
    class FakeStream { getAudioTracks() { return [{ kind: 'audio' }] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { return new FakeStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.3; this.frequencyBinCount = 1024 }
      connect() {}
      getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 120 }
      getByteTimeDomainData(arr) {
        // A clear sine around the 128 center line: enough deviation to draw a real curve.
        for (let i = 0; i < arr.length; i++) arr[i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * 4 * i) / arr.length))
      }
    }
    class LiveCtx {
      constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    let strokes = 0
    const fakeCtx = {
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => { strokes++ },
      fillRect: () => {},
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', LiveCtx)
    vi.stubGlobal('XMLHttpRequest', class { open() {} send() {} })
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      strokes = 0
      act(() => { rafCb() })
      // Waveform mode draws one stroked curve PER frequency band (multi-line): the 3 bands
      // (low/mid/high) each call stroke() once, and no bars (fillRect) are drawn.
      expect(strokes).toBe(3)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('separates a low-frequency tone into the LOW band only (Hann window + soft band edges)', async () => {
    // 分频段波形必须真实反映频段归属：喂一个 100Hz 正弦（低频段 40-300Hz），
    // 低频线应有明显起伏、中/高频线应基本平直。Hann 窗抑制矩形窗频谱泄漏 + 频段
    // 边缘余弦过渡抑制砖墙振铃后，泄漏残差应被压到很小（画布 h=20，中/高频 span < 3px）。
    prefsServer = { 'dsh-music-viz-mode': 'wave' }
    class FakeStream { getAudioTracks() { return [{ kind: 'audio' }] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { return new FakeStream() }
    }
    class FakeAnalyser {
      constructor(ctx, toneHz) { this.ctx = ctx; this.toneHz = toneHz || 100; this.fftSize = 2048; this.smoothingTimeConstant = 0.3; this.frequencyBinCount = 1024 }
      connect() {}
      getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) arr[i] = 120 }
      getByteTimeDomainData(arr) {
        // 真实滚动窗：每帧推进 1/60s（≈800 样本），返回以当前时刻结尾的 2048 样本。
        // 这样客户端只把「新增样本」喂给滤波器，每个样本恰好滤波一次。
        this.ctx.currentTime += 1 / 60;
        const pos = Math.round(this.ctx.currentTime * this.ctx.sampleRate);
        for (let i = 0; i < arr.length; i++) arr[i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * this.toneHz * (pos - arr.length + i)) / this.ctx.sampleRate))
      }
    }
    class LiveCtx {
      constructor() { this.state = 'running'; this.sampleRate = 48000; this.currentTime = 0; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser(this) }
    }
    const strokes = [] // 每条 stroke 记录的 y 坐标
    let current = []
    const fakeCtx = {
      clearRect: () => {},
      beginPath: () => {},
      moveTo: (x, y) => { current.push(y) },
      lineTo: (x, y) => { current.push(y) },
      stroke: () => { strokes.push(current); current = [] },
      fillRect: () => {},
      fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', LiveCtx)
    vi.stubGlobal('XMLHttpRequest', class { open() {} send() {} })
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      strokes.length = 0; current = []
      // 多跑几帧让波形缓动(0.3)与自适应增益收敛
      for (let f = 0; f < 12; f++) act(() => { rafCb() })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      const last = strokes.slice(-3)
      expect(last.length).toBe(3)
      const span = (ys) => { let mn = Infinity, mx = -Infinity; for (const y of ys) { if (y < mn) mn = y; if (y > mx) mx = y; } return mx - mn }
      // 低音正弦 → 低频线明显起伏（span 大），中/高频线基本平直（span 小）
      expect(span(last[0])).toBeGreaterThan(10) // low
      expect(span(last[1])).toBeLessThan(3)    // mid
      expect(span(last[2])).toBeLessThan(3)    // high
      // 降采样包络：绘制按像素列取 min/max（每列 2 点）→ 每条线 2×画布宽 个顶点，
      // 而不是时域全窗口的 2048 点（锁定降采样生效，60px 画布画 2048 点是纯浪费）。
      expect(last[0].length).toBe(canvas.width * 2)
      // 关键回归：波形左右两端也要有真实振幅（时域滤波无窗函数，不会像 Hann 窗
      // 那样把两端淡出到中线）。包络保留每列极值 → 取低频线首/尾各 40 个点
      //（覆盖 ~1/3 画布宽，必含峰值），两端都应明显偏离中线。
      const edgeDev = (ys) => { let mx = 0; for (const y of ys) { const d = Math.abs(y - 10); if (d > mx) mx = d; } return mx }
      expect(edgeDev(last[0].slice(0, 40))).toBeGreaterThan(4)  // 左端有振幅
      expect(edgeDev(last[0].slice(-40))).toBeGreaterThan(4)    // 右端有振幅
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('drives the bars from the live captureStream+AnalyserNode spectrum when available', async () => {
    // Real-time path: when the <audio> exposes captureStream() (a read-only tap) and an
    // AudioContext provides a MediaStreamSource + AnalyserNode, drawViz must read
    // getByteFrequencyData every frame (not the offline FFT envelope). Here the offline
    // envelope XHR never delivers, so if the bars still move the live analyser path is
    // doing the work. The tap must NOT reroute audio (createMediaElementSource mutes the
    // player), so the analyser feeds off a MediaStreamSource, not a MediaElementSource.
    let freqCalls = 0
    let ctxSampleRate = 48000
    class FakeStream { getAudioTracks() { return [{ kind: 'audio' }] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { return new FakeStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.7; this.frequencyBinCount = 1024 }
      connect() {}
      getByteFrequencyData(arr) {
        freqCalls++
        // A single strong low-frequency tone (bin 1) lands only in the first log band =>
        // that bar should be much taller than the rest, proving the bars came from the
        // analyser (not the offline envelope, which never delivers). Only bin 1 is loud so it
        // does not overrun the next band's boundary under the 12-band log spacing.
        for (let i = 0; i < arr.length; i++) arr[i] = i === 1 ? 230 : 4
      }
    }
    class LiveCtx {
      constructor() { this.state = 'running'; this.sampleRate = ctxSampleRate; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    // Offline envelope XHR never calls onload => trackEnv stays null => the live
    // analyser is the ONLY source of band data.
    class HungXHR { open() {} send() {} }
    const rects = []
    const fakeCtx = {
      clearRect: () => {},
      fillRect: (x, y, w, h) => { rects.push({ x, y, w, h }) },
      fillStyle: '',
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', LiveCtx)
    vi.stubGlobal('XMLHttpRequest', HungXHR)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      const bottom = canvas.height - 1
      rects.length = 0
      act(() => { rafCb() })
      // The live analyser was read (offline envelope never delivered data).
      expect(freqCalls).toBeGreaterThan(0)
      // Dedupe on x to count the real bars (a bottom-anchored bar and its 3px trailing peak
      // cap would otherwise both satisfy the bottom-line filter).
      const bars = rects.filter((r) => r.y + r.h === bottom)
      expect(new Set(bars.map((r) => r.x)).size).toBe(12)
      // The low-frequency bar is still clearly taller than the high-frequency ones (the fixed
      // frequency weighting flattens but does not invert the spectrum).
      expect(bars[0].h).toBeGreaterThan(bars[1].h * 2)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('keeps the live bars low during a quiet passage (no per-band auto-gain inflation)', async () => {
    // Regression: per-band auto-gain normalized each band to its OWN peak, so an absolutely
    // quiet but steady band got inflated toward full — the "left bars a bit high when there's
    // little music" bug. The standard AnalyserNode normalization (byte/255) is driven by
    // ABSOLUTE loudness, so a faint spectrum must draw short bars, regardless of how steady it
    // is. The offline envelope XHR hangs, so the live analyser is the only source.
    let freqCalls = 0
    class FakeStream { getAudioTracks() { return [{ kind: 'audio' }] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { return new FakeStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.3; this.frequencyBinCount = 1024 }
      connect() {}
      getByteFrequencyData(arr) {
        freqCalls++
        // A faint, steady spectrum: every bin is just above the silence floor (byte 24). In
        // absolute dB this is quiet content, so the bars must stay short.
        for (let i = 0; i < arr.length; i++) arr[i] = 24
      }
    }
    class LiveCtx {
      constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    class HungXHR { open() {} send() {} }
    const rects = []
    const fakeCtx = { clearRect: () => {}, fillRect: (x, y, w, h) => { rects.push({ x, y, w, h }) }, fillStyle: '' }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', LiveCtx)
    vi.stubGlobal('XMLHttpRequest', HungXHR)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      rects.length = 0
      // A few frames so the bars settle; clear each frame so rects holds only the last frame.
      for (let i = 0; i < 6; i++) { rects.length = 0; act(() => { rafCb() }) }
      expect(freqCalls).toBeGreaterThan(0)
      const bottom = canvas.height - 1
      const bars = rects.filter((r) => r.y + r.h === bottom)
      expect(bars.length).toBe(12)
      // Absolute loudness drives the bar, so a quiet (faint) spectrum stays LOW. (Per-band
      // auto-gain would have inflated these to near-full.)
      expect(bars.every((r) => r.h < canvas.height * 0.5)).toBe(true)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('shows nothing when the live tap yields no audio track (no offline fallback)', async () => {
    // This browser's media pipeline won't let a Web Audio source/tap read the proxied
    // stream (an internal "getTopURL" TypeError), so captureStream returns a MediaStream
    // with NO audio track. setupLiveViz must not fail hard — it leaves the live analyser
    // unset, and since there is NO offline fallback, the visualization simply draws nothing
    // (audio is never touched).
    let freqCalls = 0
    let tapAttempted = false
    // Stream that carries no audio track (the getTopURL case in this environment).
    class EmptyStream { getAudioTracks() { return [] } }
    class LiveAudio extends FakeAudio {
      play() { this.paused = false; for (const fn of (this.listeners.play || [])) fn(); return Promise.resolve() }
      captureStream() { tapAttempted = true; return new EmptyStream() }
    }
    class FakeAnalyser {
      constructor() { this.fftSize = 2048; this.smoothingTimeConstant = 0.3; this.frequencyBinCount = 1024 }
      getByteFrequencyData(arr) { freqCalls++; for (let i = 0; i < arr.length; i++) arr[i] = 200 }
    }
    // AudioContext with a MediaStreamSource + AnalyserNode (but the stream has no track,
    // so setupLiveViz bails before using them).
    class NoTrackCtx {
      constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {} }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { this.state = 'closed' }
      createMediaStreamSource() { return { connect: () => {} } }
      createAnalyser() { return new FakeAnalyser() }
    }
    const rects = []
    const fakeCtx = { clearRect: () => {}, fillRect: (x, y, w, h) => { rects.push({ x, y, w, h }) }, fillStyle: '' }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    let rafCb = null
    vi.stubGlobal('Audio', LiveAudio)
    vi.stubGlobal('AudioContext', NoTrackCtx)
    vi.stubGlobal('XMLHttpRequest', class { open() {} send() {} })
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', (cb) => { rafCb = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    const origGetCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = () => fakeCtx
    try {
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const canvas = container.querySelector('.dsh-music-viz')
      expect(canvas).toBeTruthy()
      rects.length = 0
      freqCalls = 0
      act(() => { rafCb() })
      // The tap WAS attempted (captureStream called) but yielded no audio track, so
      // getByteFrequencyData should NOT be read and NO bars/waveform are drawn.
      expect(tapAttempted).toBe(true)
      expect(freqCalls).toBe(0)
      const bottom = canvas.height - 1
      const bars = rects.filter((r) => r.y + r.h === bottom)
      expect(bars.length).toBe(0)
    } finally {
      HTMLCanvasElement.prototype.getContext = origGetCtx
    }
  })

  it('does NOT close the portaled volume/mode popups when clicking inside them', async () => {
    // Regression: the volume/mode popups are portaled to body (outside the bar DOM),
    // so the old outside-click check (button container only) closed them on ANY click
    // including inside the popup. Must keep them open when the click target is inside.
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const hotspot = container.querySelector('.dsh-music-bar-hotspot')
    act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    // ---- 音量弹窗：打开后点击弹窗内部不应关闭 ----
    const volBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '音量')
    act(() => { volBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const volPop = document.querySelector('.dsh-music-bar-vol-pop')
    expect(volPop).toBeTruthy()
    // 点击弹窗内部（音量滑块容器）→ 弹窗保持打开
    act(() => { volPop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-bar-vol-pop')).toBeTruthy()
    // 点击播放条之外的空白处 → 弹窗关闭
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-bar-vol-pop')).toBeNull()
    // ---- 模式弹窗：打开后点击弹窗内部选项不应被「外部点击」误关闭 ----
    const modeBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '顺序播放')
    act(() => { modeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const modePop = document.querySelector('.dsh-music-mode-pop')
    expect(modePop).toBeTruthy()
    // 点击弹窗内部（空白处，非选项按钮）→ 弹窗保持打开
    act(() => { modePop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-mode-pop')).toBeTruthy()
    // 点击弹窗内一个选项 → 选项生效且弹窗关闭
    const shuffle = [...document.querySelectorAll('.dsh-music-mode-item')].find((b) => b.title.includes('乱序播放'))
    act(() => { shuffle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-mode-pop')).toBeNull()
  })

  it('opens the panel, shows subtabs, and renders the playlist detail with a 清空 button', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // open the panel via the bar's playlist button
    const openBtn = container.querySelector('button[title="打开播放列表"]')
    expect(openBtn).toBeTruthy()
    act(() => { openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // library view shows the subtab row
    expect(container.textContent).toContain('曲库')
    expect(container.textContent).toContain('我最喜欢')
    const tab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent === '通勤')
    expect(tab).toBeTruthy()
    // switch into the custom playlist -> detail with 清空/重命名/删除 + track row
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('清空')
    expect(container.textContent).toContain('重命名')
    expect(container.textContent).toContain('删除')
    expect(container.textContent).toContain('a.mp3')
    // the fixed playlist also gets a 清空 button (no rename/delete)
    const favTab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent.includes('我最喜欢'))
    act(() => { favTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('清空')
    expect(container.textContent).not.toContain('重命名')
    expect(container.textContent).not.toContain('删除')
  })

  it('exposes the full file path as the hover tooltip on a track row', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const trackBtn = container.querySelector('.dsh-music-track')
    expect(trackBtn).toBeTruthy()
    // manifest track a.mp3 carries path /music/a.mp3; hovering shows the whole path.
    expect(trackBtn.getAttribute('title')).toBe('/music/a.mp3')
  })

  it('clears a playlist to the empty state', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const tab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent === '通勤')
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('a.mp3')
    const clearBtn = [...container.querySelectorAll('.dsh-music-playlist-btn')].find((b) => b.textContent === '清空')
    expect(clearBtn).toBeTruthy()
    act(() => { clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 自定义确认弹窗（ConfirmModal）替代原 window.confirm：点「确定」确认
    const okBtn = [...container.querySelectorAll('.dsh-music-picker.confirm .dsh-music-picker-foot .dsh-music-settings-btn')].find((b) => b.textContent === '确定')
    expect(okBtn).toBeTruthy()
    act(() => { okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the fetch .then -> store update -> re-render
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('歌单为空')
  })

  it('opens the file picker from 添加歌曲 starting at the music root directory', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const tab = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent === '通勤')
    act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const addBtn = [...container.querySelectorAll('.dsh-music-playlist-btn')].find((b) => b.textContent.includes('添加歌曲'))
    expect(addBtn).toBeTruthy()
    act(() => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the FilePicker useEffect -> /dsh-music/files fetch
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // initial browse must point at the music root (/music), not home (empty)
    expect(lastFilesUrl).toBeTruthy()
    expect(lastFilesUrl).toMatch(/^\/dsh-music\/files\?path=/)
    expect(lastFilesUrl).not.toMatch(/path=$/)
    expect(lastFilesUrl).toContain(encodeURIComponent('/music'))
    // the picker shows the file it listed
    expect(container.textContent).toContain('a.mp3')
  })

  it('renders the directory picker as breadcrumbs with dirs first and inert files', async () => {
    // Serve the directory listing the 选择音乐目录 picker fetches, with crumbs.
    const dirFetch = vi.fn((url, opts) => {
      const u = String(url)
      if (u.startsWith('/dsh-music/dir')) {
        const target = decodeURIComponent((u.split('path=')[1] || ''))
        if (target === '/music') {
          return jsonRes({ path: '/music', name: 'music', up: '/', dirs: [{ name: 'Albums', path: '/music/Albums' }], files: [{ name: 'a.mp3', path: '/music/a.mp3' }, { name: 'cover.jpg', path: '/music/cover.jpg' }], crumbs: [{ name: '/', path: '/' }, { name: 'music', path: '/music' }] })
        }
        if (target === '/') {
          return jsonRes({ path: '/', name: '/', up: null, dirs: [], files: [], crumbs: [{ name: '/', path: '/' }] })
        }
        return jsonRes({ path: target, name: target, up: null, dirs: [], files: [], crumbs: [] })
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('fetch', dirFetch)

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const pickBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '选择音乐目录')
    expect(pickBtn).toBeTruthy()
    act(() => { pickBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // breadcrumb: [💻 本机][›][/][music][↑] — 本机进入盘符列表、↑ 回上级、根可点击、当前高亮。
    let crumbs = [...container.querySelectorAll('.dsh-music-picker-cur .dsh-music-crumb')]
    expect(crumbs.length).toBe(4)
    expect(crumbs[0].textContent).toBe('💻 本机')
    expect(crumbs[0].tagName).toBe('BUTTON')
    expect(crumbs[0].getAttribute('title')).toBe('本机磁盘')
    expect(crumbs[1].textContent).toBe('/')
    expect(crumbs[1].tagName).toBe('BUTTON')
    expect(crumbs[2].textContent).toBe('music')
    expect(crumbs[2].className).toContain('cur')
    expect(crumbs[3].textContent).toBe('↑')
    expect(crumbs[3].getAttribute('title')).toBe('上级目录')
    // list: the directory comes first (clickable button), then files (inert spans).
    const listItems = [...container.querySelectorAll('.dsh-music-picker-list .dsh-music-picker-item')]
    expect(listItems.map((el) => el.textContent.trim())).toEqual(['📁 Albums', '📄 a.mp3', '📄 cover.jpg'])
    expect(listItems[0].tagName).toBe('BUTTON')
    expect(listItems[1].tagName).toBe('SPAN')
    expect(listItems[2].tagName).toBe('SPAN')
    expect(listItems[1].className).toContain('file')
    // the empty hint no longer exists
    expect(container.textContent).not.toContain('本目录下无子目录')
    // click ↑ -> re-browse to the parent "/" and the path collapses to [本机][/].
    act(() => { crumbs[3].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    crumbs = [...container.querySelectorAll('.dsh-music-picker-cur .dsh-music-crumb')]
    expect(crumbs.length).toBe(2)
    expect(crumbs[0].textContent).toBe('💻 本机')
    expect(crumbs[1].textContent).toBe('/')
    expect(crumbs[1].className).toContain('cur')
    // 根目录无上级（up:null）→ ↑ 按钮不显示。
    expect(container.querySelector('.dsh-music-crumb.up')).toBeNull()
  })

  it('shows the configured root before the picker button with a full-path hover tooltip', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // The path in front of the 选择音乐目录 button is plain text (truncatable) whose
    // hover title is the full absolute path. It is NOT clickable (no breadcrumb).
    const cur = container.querySelector('.dsh-music-settings-cur')
    expect(cur).toBeTruthy()
    expect(cur.textContent).toContain('/music')
    expect(cur.getAttribute('title')).toBe('/music')
    expect(cur.querySelector('.dsh-music-crumb')).toBeNull()
  })

  it('resizes the panel via the corner handle and persists w/h', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const handle = container.querySelector('.dsh-music-resize')
    expect(handle).toBeTruthy()
    const panelEl = container.querySelector('.dsh-music-panel')
    // default: no inline geometry (CSS width / auto height), but a comfortable
    // auto-size min-height so a fresh (empty-list) panel does not open too short
    expect(panelEl.style.width).toBe('')
    expect(panelEl.style.minHeight).toBe('45vh')
    const pointer = (type, x, y) => {
      const ev = new Event(type, { bubbles: true })
      ev.clientX = x; ev.clientY = y; ev.button = 0; ev.pointerId = 1
      return ev
    }
    // drag the corner handle 100px right and 150px down
    act(() => { handle.dispatchEvent(pointer('pointerdown', 800, 600)) })
    act(() => { handle.dispatchEvent(pointer('pointermove', 900, 750)) })
    expect(parseInt(panelEl.style.width, 10)).toBe(700)   // 600 + 100
    expect(parseInt(panelEl.style.height, 10)).toBeGreaterThanOrEqual(200) // clamped min
    expect(panelEl.style.maxHeight).toBe('none') // explicit height wins over 72vh
    expect(panelEl.style.minHeight).toBe('') // auto-size min-height released once fixed
    // the resize is mirrored to the Host prefs (flushed on the ~800ms debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const saved = JSON.parse(prefsServer['dsh-music-panel-pos'])
    expect(saved).toMatchObject({ w: 700 })
    expect(typeof saved.h).toBe('number')
    // shrink back below the min clamps to 320
    act(() => { handle.dispatchEvent(pointer('pointermove', 500, 300)) })
    expect(parseInt(panelEl.style.width, 10)).toBe(320)
    act(() => { handle.dispatchEvent(pointer('pointerup', 500, 300)) })
  })

  it('opens the chapter TOC scrolled to the currently playing chapter (not the top)', async () => {
    // Re-boot with a book in the library so AI 讲书 (book) mode is available.
    const book = { id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }
    const sections = [
      { type: 'preface', heading: '前言', fromChunk: 0 },
      { type: 'chapter', heading: '第一章 起', fromChunk: 0 },
      { type: 'chapter', heading: '第二章 承', fromChunk: 5 },
      { type: 'chapter', heading: '第三章 转', fromChunk: 10 },
      { type: 'epilogue', heading: '后记', fromChunk: 20 },
    ]
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [book] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    // Serve the book's /meta (section structure); everything else falls back.
    const baseFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url).endsWith('/meta')) return jsonRes({ total: 25, title: '测试小说', author: '佚名', sections })
      return baseFetch(url, opts)
    })
    // jsdom has no scrollIntoView — spy on it to observe the TOC auto-scroll.
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // open the panel -> 小说 tab -> start the book
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('测试小说'))
    expect(bookRow).toBeTruthy()
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the async /meta fetch + chapter-structure state
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // jump forward twice: 第一章 -> 第二章 -> 第三章
    const next = container.querySelector('button[title="下一章"]')
    expect(next).toBeTruthy()
    act(() => { next.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { next.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // open the chapter TOC — it must auto-scroll to the active (current) chapter
    const tocBtn = container.querySelector('button[title="章节目录"]')
    expect(tocBtn).toBeTruthy()
    await act(async () => { tocBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)) })
    const toc = container.querySelector('.dsh-music-toc-list')
    expect(toc).toBeTruthy()
    // the popup must be a child of the button's relative wrapper (same anchor
    // pattern as the volume/mode popups — CSS positions it above the button).
    // 测试环境未提供 react-dom，portal 走内联回退（生产环境 portal 到 body）。
    const tocPanel = toc.closest('.dsh-music-toc')
    expect(tocPanel).toBeTruthy()
    expect(tocPanel.parentElement.classList.contains('dsh-music-toc-trigger')).toBe(true)
    expect(tocPanel.parentElement.contains(tocBtn)).toBe(true)
    // the popup anchors above the button via inline fixed positioning (anchorAbove)
    expect(tocPanel.style.position).toBe('fixed')
    // TOC 用 bottom 锚定（tocAnchorAbove）：底边贴住按钮上方、不被视口顶部钳制
    // 截断。jsdom 中 getBoundingClientRect 全零 → 走回退分支（bottom 被设置、top
    // 为空）；真实浏览器则 bottom = 距视口底边距离，始终贴住按钮上方 6px。
    expect(tocPanel.style.bottom).toBeTruthy()
    expect(tocPanel.style.top).toBe('')
    const activeItems = toc.querySelectorAll('.dsh-music-toc-item.active')
    expect(activeItems.length).toBe(1)
    expect(activeItems[0].textContent).toContain('第三章 转')
    // scrollIntoView must have been called on that active item (never on the top row)
    const tocScrollTargets = scrollSpy.mock.instances.filter((el) =>
      el && el.classList && el.classList.contains('dsh-music-toc-item') && el.classList.contains('active'))
    expect(tocScrollTargets.length).toBeGreaterThan(0)
    expect(tocScrollTargets.some((el) => el.textContent.includes('第三章 转'))).toBe(true)
    // the top (first) chapter must not have been the scroll target
    expect(tocScrollTargets.some((el) => el.textContent.includes('第一章 起'))).toBe(false)
  })

  it('anchors the AI 讲书 volume popup with bottom positioning (like the TOC, not cut off)', async () => {
    // Regression: the book-mode volume popup is variable-height (AI 声音 select +
    // 音量滑块), so it must use anchorPopAbove (bottom-anchored + height-capped) —
    // not anchorAbove (top + translateY(-100%)), which cuts off tall popups at the
    // viewport top and detaches their bottom edge from the bar.
    const book = { id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [book] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('测试小说'))
    expect(bookRow).toBeTruthy()
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const hotspot = container.querySelector('.dsh-music-bar-hotspot')
    expect(hotspot).toBeTruthy()
    act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    // 打开音量弹窗 → 讲书（book）模式
    const volBtn = [...container.querySelectorAll('.dsh-music-mode-trigger')].find((b) => b.title === '音量')
    expect(volBtn).toBeTruthy()
    act(() => { volBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const volPop = document.querySelector('.dsh-music-bar-vol-pop.book')
    expect(volPop).toBeTruthy()
    // 讲书音量弹窗用 anchorPopAbove：bottom 锚定（jsdom 中 rect 全零走回退分支，
    // bottom 被设置、top 为空）；真实浏览器则底边贴住按钮上方 6px、高度受限。
    expect(volPop.style.position).toBe('fixed')
    expect(volPop.style.bottom).toBeTruthy()
    expect(volPop.style.top).toBe('')
    // 弹窗内含 AI 声音选择 + 音量滑块
    expect(volPop.querySelector('.dsh-music-voice')).toBeTruthy()
    expect(volPop.querySelector('.dsh-music-vol-slider')).toBeTruthy()
  })

  it('shows the restored chapter immediately after a refresh (no play needed)', async () => {
    // Simulate a saved book playback at chunk 10 (第三章 转), then re-boot so
    // restoreLatest() runs during load — the same path as a page refresh.
    const sections = [
      { type: 'preface', heading: '前言', fromChunk: 0 },
      { type: 'chapter', heading: '第一章 起', fromChunk: 0 },
      { type: 'chapter', heading: '第二章 承', fromChunk: 5 },
      { type: 'chapter', heading: '第三章 转', fromChunk: 10 },
      { type: 'epilogue', heading: '后记', fromChunk: 20 },
    ]
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = sections
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '测试小说.txt': { from: 10, base: 300, pos: 3, total: 25, ts: 999999999 },
    }) }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch so currentSection arrives
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the restored chapter is appended after the book name (QQ-music「歌名 - 歌手」style),
    // and the trailing '.txt' is stripped from the displayed file name
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('测试小说')
    expect(nameSpan.textContent).toContain('第三章 转')
    expect(nameSpan.textContent).not.toContain('测试小说.txt')
    // no standalone section badge remains inside the bar
    expect(nameSpan.querySelector('.dsh-music-bar-section')).toBeNull()
    expect(container.querySelector('.dsh-music-bar-section')).toBeNull()
    // AI 讲书模式下播放条不显示当前/总时长
    expect(container.querySelector('.dsh-music-bar-time')).toBeNull()
    // the book name is prefixed by a MIC icon (not the music note)
    const nameIcon = container.querySelector('.dsh-music-bar-name .dsh-music-note path')
    expect(nameIcon).toBeTruthy()
    expect(nameIcon.getAttribute('d')).toContain('M12 14c')
    // opening the TOC now highlights the restored chapter (not the first one)
    const tocBtn = container.querySelector('button[title="章节目录"]')
    expect(tocBtn).toBeTruthy()
    await act(async () => { tocBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)) })
    const active = container.querySelector('.dsh-music-toc-item.active')
    expect(active).toBeTruthy()
    expect(active.textContent).toContain('第三章 转')
  })

  it('shows the restored book progress right after a refresh (before any play)', async () => {
    // Regression: after a refresh the book is restored PAUSED, so onTime never
    // fires and bookProgress would stay 0. The restore path must back-fill the
    // fill width from charOffsets once the meta loads — even before the user taps ▶.
    // Chunks: 10 / 20 / 30 chars, total 60. Restored at chunk index 2 → progress to
    // chunk start = offsets[2]/total = 30/60 = 50%.
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '进度恢复测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 10, 30, 60]
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '进度恢复测试.txt': { from: 2, base: 400, pos: 0, total: 25, ts: 999999999 },
    }) }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch so charOffsets land + bookProgress fills
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the progress fill is computed from the restored chunk, NOT stuck at 0
    const fill = container.querySelector('.dsh-music-bar-progress-fill')
    expect(fill).toBeTruthy()
    expect(parseFloat(fill.style.width)).toBeCloseTo(50, 1)
  })

  it('loads the current chunk subtitle when resuming a restored book (no gap until next chunk)', async () => {
    // Regression: after a refresh the book is restored PAUSED. Resuming via ▶ went
    // straight to audio.play() WITHOUT loadBookSubtitle, so the current chunk's
    // subtitleLines stayed empty — the lyric only appeared at the NEXT chunk. The
    // resume path must fetch & show the current chunk's subtitle immediately.
    const audios = []
    class ResumeAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '恢复字幕测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '这是恢复后应立刻出现的字幕。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({ '恢复字幕测试.txt': { from: 0, base: 0, pos: 0, total: 1, ts: 999999999 } }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResumeAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // BEFORE resuming there is no subtitle (paused restore never loads it)
    // Resume: click ▶ → togglePlay loads the chunk and must load the subtitle.
    act(() => { container.querySelector('button[title="播放/暂停"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the loadBookSubtitle /text fetch
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // give the media a duration + a position so updateLyric can pick line 0
    audio.duration = 10
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const lyric = container.querySelector('.dsh-music-bar-lyric')
    expect(lyric).toBeTruthy()
    expect(lyric.textContent).toContain('这是恢复后')
    bookTextFixture = ''
  })

  it('does NOT leak a restored in-chunk position into the NEXT chunk (resume near chunk end)', async () => {
    // Regression: resuming a book restores bookRestorePos (in-chunk position). When
    // that position sat at/near the chunk's END, the pin never released before the
    // chunk ended, so the stale pos leaked into the NEXT chunk — which got seeked
    // back to it (jumping each chunk to its end → 卡住/无声音/字幕不动). Advancing
    // to a new chunk must drop the pin.
    const audios = []
    class ResumeLeakAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '续播泄漏测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = [{ type: 'chapter', heading: '第一章 起', fromChunk: 0 }, { type: 'chapter', heading: '第二章 承', fromChunk: 2 }]
    bookCharOffsets = [0, 100, 200, 300]
    bookTextFixture = '续播块的文本内容，含若干句子用于字幕。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '续播泄漏测试.txt': { from: 2, base: 400, pos: 30, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResumeLeakAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('续播泄漏测试'))
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=2')

    // chunk 2 is 30s and the restored pos=30 sits at the very END: the pin never
    // releases (ct > 31 is impossible), so it holds until the chunk ends.
    audio.duration = 30
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('play') })
    audio.currentTime = 30
    act(() => { audio.emit('timeupdate') })
    // chunk 2 ends -> auto-advance to chunk 3
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=3')

    // chunk 3 starts fresh — a stale pin would re-seek it to 30 (clamped to end).
    audio.duration = 30
    audio.currentTime = 0.1
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1)
    bookTextFixture = ''
  })

  it('releases the restore pin when the saved in-chunk position is beyond the chunk (re-synthesized shorter)', async () => {
    // Regression: resuming into a chunk whose re-synthesized duration is SHORTER
    // than the saved in-chunk position. Seeking to the saved pos would clamp to the
    // end and instantly end the chunk (stall loop). The pin must release instead of
    // keeping the position pinned/unseekable.
    const audios = []
    class ShortChunkAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '短块续播测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 100, 200, 300]
    bookTextFixture = '短块续播。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '短块续播测试.txt': { from: 2, base: 400, pos: 30, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ShortChunkAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const ex = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    ex.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('短块续播测试'))
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=2')

    // chunk duration is only 20s, but saved pos is 30 (beyond duration).
    audio.duration = 20
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('play') })
    audio.currentTime = 0.1
    act(() => { audio.emit('timeupdate') })
    // Pin must have released (pos beyond duration), so currentTime is NOT forced to 30.
    expect(audio.currentTime).toBeLessThan(1)
    bookTextFixture = ''
  })

  it('pre-warms the resumed chunk at restore so a restart resume is instant (TTS cache cold)', async () => {
    // Regression: after restarting DSH the Host's in-memory TTS cache and the browser
    // HTTP cache are both empty, so the resumed chunk must be re-synthesized (several
    // to tens of seconds). While synthesizing, the bar sat pinned on the restored
    // position with no sound and no moving subtitle — the exact "重启后续播卡住"
    // symptom. The restore path must warm the resumed chunk in the background so the
    // tap ▶ is near-instant instead of hanging on a cold synthesis.
    const bookAudioFetches = []
    const wrappedFetch = (url, opts) => {
      const u = String(url)
      const m = /^\/dsh-music\/book\/(b\d+)\?from=(\d+)/.exec(u)
      if (m) bookAudioFetches.push({ id: m[1], from: parseInt(m[2], 10) })
      return fetchStub(url, opts)
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '预热续播测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 100, 200, 300]
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '预热续播测试.txt': { from: 2, base: 400, pos: 5, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', wrappedFetch)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    // flush the restore-time async /meta + warm-fetch path
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the resumed chunk (from=2) must have been warmed via a background fetch, so a
    // cold synthesis isn't left to the tap ▶ (which would show a frozen bar).
    expect(bookAudioFetches).toContainEqual({ id: 'b1', from: 2 })
    bookTextFixture = ''
  })

  it('shows the "AI 合成中…" feedback when resuming a cold chunk and clears it on playback start', async () => {
    // Regression: after restarting DSH the resumed chunk may still need synthesizing
    // (cold cache). The resume path (togglePlay) never armed the buffer indicator or
    // the 60s synthesis timeout, so the bar sat pinned on the restored position —
    // 无声音、字幕不动、看起来像卡住. The resume path must show the same
    // "AI 合成中… Ns" feedback as a fresh play, and clear it once playback truly starts.
    const audios = []
    class ResumeBufferAudio extends FakeAudio {
      constructor() { super(); audios.push(this); this._resolvePlay = null }
      play() {
        this.paused = false
        this._playPromise = new Promise((res) => { this._resolvePlay = res })
        return this._playPromise
      }
      resolvePlay() { if (this._resolvePlay) { const r = this._resolvePlay; this._resolvePlay = null; r() } }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '续播缓冲反馈测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '续播缓冲反馈文本。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '续播缓冲反馈测试.txt': { from: 2, base: 400, pos: 3, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResumeBufferAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // resume via ▶ → the bar must show the synthesis feedback while the chunk is cold
    act(() => { container.querySelector('button[title="播放/暂停"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeTruthy()
    // once playback truly starts, the feedback clears (no lingering spinner)
    audio.resolvePlay()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeNull()
    bookTextFixture = ''
  })

  it('jumps to the NEXT chunk when the saved position is beyond the re-synthesized chunk (no replay, no clamp-to-end stall)', async () => {
    // Regression ("重启后点以前听过的书 → 合成完响一下就没声音、字幕不动"): after a DSH
    // restart the chunk is re-synthesized and may come out SHORTER than the saved
    // in-chunk position. Seeking to that saved pos clamps to the chunk END, and the
    // browser may not fire `ended` — the audio stalls after a blip. Since the saved
    // position is past this chunk, the reader has effectively finished it, so the
    // correct resume is to JUMP to the next chunk — not replay this one, and never
    // force currentTime to an out-of-range/clamped position.
    const audios = []
    class ReSynthShorterAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '重合成变短续播.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 100, 200, 300]
    bookTextFixture = '重合成变短续播文本。'
    // saved pos=25 was valid for the OLD 30s chunk; after restart the re-synthesized
    // chunk is only 20s, so pos is now beyond the chunk (the user finished chunk 2).
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '重合成变短续播.txt': { from: 2, base: 400, pos: 25, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ReSynthShorterAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('重合成变短续播'))
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=2')

    // Duration still unknown (metadata not loaded) when the pin first runs: the pin
    // must NOT seek currentTime to pos yet (it would be clamped later to a wrong spot).
    audio.duration = NaN
    act(() => { audio.emit('durationchange') }) // onDur ignores NaN
    act(() => { audio.emit('play') })
    audio.currentTime = 0.1
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1) // not forced to the (unknown) pos

    // Duration resolves to 20s (< saved pos 25): the saved position is past the chunk,
    // so the reader has finished it — the book must JUMP to the NEXT chunk (from=3),
    // not re-listen chunk 2 and never force currentTime to the clamped 20s end.
    audio.duration = 20
    // 切块经 playBookFrom 的「等采集管线拆除落定再换 src」微任务，先 flush 再断言。
    await act(async () => { audio.emit('durationchange'); await Promise.resolve() })
    audio.currentTime = 0.1
    act(() => { audio.emit('timeupdate') })
    expect(audio.src).toContain('from=3')        // jumped forward to chunk 3
    expect(audio.currentTime).toBeLessThan(1)    // never clamped to the 20s end

    // The next chunk plays fresh (no stale pin), and the book continues normally.
    audio.duration = 30
    audio.currentTime = 0.1
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1)
    bookTextFixture = ''
  })

  it('advances when `ended` arrives during resume buffering, and swallows only the duplicate after a real advance', async () => {
    // Regression（冷启动续播残留卡死）: 恢复续播的块被重合成得比保存位置短时，旧实现
    // 在 togglePlay 里「时长未知就提前 seek」→ 被 browser 钳到块尾，`ended` 会在
    // 「AI 合成中」缓冲态（尚未切块过）到达，被旧逻辑 `if (bookBuffering) return`
    // 无条件吞掉 → 不切块、不报错、缓冲随后被 play promise 清掉 → 永久「没声音、
    // 字幕不动」。正确行为：①时长未知绝不提前 seek；②缓冲态中、尚无切块发生时，
    // ended 是「本块真结束」→ 清缓冲并切块；③切块后紧随的重复 ended 才是陈旧事件
    // （吞掉，防连跳两块）。
    const audios = []
    class ClampStallAudio extends FakeAudio {
      constructor() { super(); audios.push(this); this._resolvePlay = null }
      play() {
        this.paused = false
        this._playPromise = new Promise((res) => { this._resolvePlay = res })
        return this._playPromise
      }
      resolvePlay() { if (this._resolvePlay) { const r = this._resolvePlay; this._resolvePlay = null; r() } }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '钳尾续播测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '钳尾续播测试文本。'
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '钳尾续播测试.txt': { from: 2, base: 400, pos: 5, total: 25, ts: 999999999 },
    }) }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ClampStallAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // ▶ 续播 → src 指向恢复块；时长未知时绝不提前 seek（旧实现在此把越界位置塞进
    // currentTime、随后被钳到块尾埋雷）。
    act(() => { container.querySelector('button[title="播放/暂停"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=2')
    expect(audio.currentTime).toBe(0) // duration unknown → no early seek
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeTruthy()
    // 模拟钳尾：ended 带着缓冲态直接到达（没有 timeupdate/onDur 补救的窗口）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=3') // jumped to the next chunk, NOT stalled
    // 切块后紧随的陈旧重复 ended（旧块的）必须被吞掉——不连跳两块
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=3')
    // 新块真正开始播放 → 缓冲清除，此后 ended 恢复为真实切块语义
    audio.resolvePlay()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeNull()
    bookTextFixture = ''
  })

  it('does NOT append a chapter name or the “-” separator when the novel has no chapters', async () => {
    // A novel with no detectable section structure must show ONLY the book title
    // in the bar — no " - " and no chapter text appended (currentSection stays '').
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '无章节小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = [] // no structure -> parser returns empty sections
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({
      '无章节小说.txt': { from: 3, base: 100, pos: 1, total: 25, ts: 999999999 },
    }) }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // flush the restore-time async /meta fetch so currentSection would arrive only if sections exist
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    // title only: extension stripped, NO chapter appended, NO "- " separator
    expect(nameSpan.textContent).toContain('无章节小说')
    expect(nameSpan.textContent).not.toContain('无章节小说.txt')
    expect(nameSpan.textContent).not.toContain('-')
    expect(nameSpan.querySelector('.dsh-music-bar-artist')).toBeNull()
  })

  it('clears a stale chapter name when switching to a novel that has no chapters', async () => {
    // Regression: play a book WITH chapters (sets currentSection), then switch to
    // a book WITHOUT chapters. The bar must NOT show the previous book's chapter
    // (and no " - " separator) — currentSection must be reset on book switch.
    const sections = [
      { type: 'chapter', heading: '第一章 起', fromChunk: 0 },
      { type: 'chapter', heading: '第二章 承', fromChunk: 5 },
    ]
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [
      { id: 'b1', name: '有章节小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' },
      { id: 'b2', name: '无章节小说.txt', url: '/dsh-music/book/b2', size: 100, ext: 'txt' },
    ] }
    bookMetaById = { b1: sections, b2: [] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // play the chaptered book first
    const chBook = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('有章节小说'))
    expect(chBook).toBeTruthy()
    act(() => { chBook.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    let nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('有章节小说')
    expect(nameSpan.textContent).toContain('第一章 起')
    expect(nameSpan.textContent).toContain('-')
    // now switch to the chapter-less book
    const plainBook = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('无章节小说'))
    expect(plainBook).toBeTruthy()
    act(() => { plainBook.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('无章节小说')
    expect(nameSpan.textContent).not.toContain('.txt')      // extension stripped
    expect(nameSpan.textContent).not.toContain('第一章 起') // no stale chapter
    expect(nameSpan.textContent).not.toContain('-')         // no separator
    expect(nameSpan.querySelector('.dsh-music-bar-artist')).toBeNull()
  })

  it('keeps a quoted dialogue on a single AI 讲书 subtitle line (no split on 。? inside “”)', async () => {
    // The subtitle line for a book chunk is cut by splitSentences, which must
    // treat “...” as atomic — a 。/？ inside the quotes must NOT split the line.
    const audios = []
    class SubAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '对话测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“你来了吗？”她点头。'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', SubAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('对话测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // flush the /text fetch that fills subtitleLines
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // real chunk duration + position so updateLyric selects line 0
      audio.duration = 10
      audio.currentTime = 0
      act(() => { audio.emit('timeupdate') })
      // idle (non-hovered) bar shows the subtitle line
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      // the whole sentence is one line (content ≤20): the 。? inside “...” didn't split it
      expect(lyric.textContent).toContain('他说：“你来了吗？”她点头。')
      expect(lyric.textContent).toContain('你来了吗？”')
    } finally {
      bookTextFixture = ''
    }
  })

  it('wraps long AI 讲书 subtitle lines adaptively, each no longer than 20 chars', async () => {
    // A single long chunk (>20 content chars) full of commas: it must wrap into
    // ≤20-char lines at the natural clause pauses, and keep the dialogue whole.
    const audios = []
    class WrapAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '长句测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“我们走吧。”接着，他转身走了出去，留下我一个人在原地发呆，心里想着他刚才说的那一番话。'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', WrapAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('长句测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      const seen = new Set()
      // sample progress across the whole chunk so every subtitle line surfaces
      for (let t = 0; t <= 9.9; t += 0.05) {
        audio.currentTime = t
        act(() => { audio.emit('timeupdate') })
        const el = container.querySelector('.dsh-music-bar-lyric')
        if (el && el.textContent) seen.add(el.textContent)
      }
      // the long sentence wrapped into multiple lines, each line ≤ 20 汉字(去标点)
      expect(seen.size).toBeGreaterThan(1)
      for (const line of seen) expect(subContentLen(line)).toBeLessThanOrEqual(20)
      // the quoted dialogue stays on a single line (never split inside “”)
      const holder = [...seen].find((l) => l.includes('“我们走吧'))
      expect(holder).toBeTruthy()
      expect(holder).toContain('我们走吧。”')
    } finally {
      bookTextFixture = ''
    }
  })

  it('breaks a long quoted dialogue at its internal commas instead of a hard cut', async () => {
    // A single quoted dialogue longer than 20 content chars: when it must be
    // split, the cut should land on a comma (inside the quote) — a graceful
    // clause pause, NOT a hard slice at the content boundary.
    const audios = []
    class LongQuoteAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '长对话测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“我们先商量一下，然后再做决定，千万不要冲动。”'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LongQuoteAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('长对话测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      const seen = new Set()
      for (let t = 0; t <= 9.9; t += 0.05) {
        audio.currentTime = t
        act(() => { audio.emit('timeupdate') })
        const el = container.querySelector('.dsh-music-bar-lyric')
        if (el && el.textContent) seen.add(el.textContent)
      }
      // the long dialogue split into several lines, each ≤20 content chars
      expect(seen.size).toBeGreaterThan(1)
      for (const line of seen) expect(subContentLen(line)).toBeLessThanOrEqual(20)
      // every cut lands on a clause pause (comma) — never a bare hard slice
      for (const line of seen) expect(line.endsWith('，') || line.endsWith('。”')).toBe(true)
    } finally {
      bookTextFixture = ''
    }
  })

  it('breaks a long quoted dialogue at its internal 。！？ (sentence-end inside quotes) too', async () => {
    // splitSentences skips 。！？ inside quotes (only breaks at the closing quote),
    // so a long quoted dialogue may contain internal sentence ends. wrapSubtitleLine
    // must also cut at those 。！？ — not hard-slice mid-content.
    const audios = []
    class LongQuotePauseAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '长标点测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他说：“句子一。句子二？句子三。句子四。句子五。句子六。句子七。”'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LongQuotePauseAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('长标点测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      const seen = new Set()
      for (let t = 0; t <= 9.9; t += 0.05) {
        audio.currentTime = t
        act(() => { audio.emit('timeupdate') })
        const el = container.querySelector('.dsh-music-bar-lyric')
        if (el && el.textContent) seen.add(el.textContent)
      }
      // split into several lines, each ≤20 content chars, and every cut lands on 。！？，
      const enders = new Set('，。？！：；”')
      expect(seen.size).toBeGreaterThan(1)
      for (const line of seen) {
        expect(subContentLen(line)).toBeLessThanOrEqual(20)
        expect(enders.has(line.trim().slice(-1))).toBe(true) // 断在标点，不裸切
      }
    } finally {
      bookTextFixture = ''
    }
  })

  it('does not orphan a closing bracket （）at the start of a subtitle line (treated like a closing quote)', async () => {
    // A closing full-width bracket must ride the current line exactly like a
    // closing quote ”” does — never start a line on its own. This is the paired
    // punctuation handling introduced for （）／【】.
    const audios = []
    class BracketAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '括号测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '他（拿着一本很厚的书，然后慢慢翻开第一页。）站了起来。'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', BracketAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('括号测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      const seen = new Set()
      for (let t = 0; t <= 9.9; t += 0.05) {
        audio.currentTime = t
        act(() => { audio.emit('timeupdate') })
        const el = container.querySelector('.dsh-music-bar-lyric')
        if (el && el.textContent) seen.add(el.textContent)
      }
      // the fixture wraps into multiple lines (content > 20 chars)
      expect(seen.size).toBeGreaterThan(1)
      // the closing bracket is absorbed into the current line — never orphaning
      // at the start of a line
      for (const line of seen) expect(line.trim()).not.toMatch(/^[）】〉》]/)
      // and the full content is intact (the pair survives)
      expect([...seen].join('')).toContain('）')
    } finally {
      bookTextFixture = ''
    }
  })

  it('weights AI 讲书 subtitle timing by line length so a long line is not swapped out early', async () => {
    // Two lines: a long first sentence and a 2-char second. TTS duration ∝ chars,
    // so the long line should fill most of the chunk. At p=0.6 the uniform "1/N"
    // mapping would jump to the short line, but the char-weighted mapping must
    // still show the long line.
    const audios = []
    class WeightAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '加权测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '甲，乙，丙，丁，戊，己，庚，辛，壬，癸，子，丑，寅，卯，辰，巳，午，未，申，酉，戌，亥。'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', WeightAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('加权测试'))
      expect(bookRow).toBeTruthy()
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // p = 6/10 = 0.6 — uniform "floor(0.6 * 2) = 1" → the short line; weighted keeps the long one.
      audio.duration = 10
      audio.currentTime = 6
      act(() => { audio.emit('timeupdate') })
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      // the long first line (20 content chars) still shows, NOT the 2-char second line
      expect(lyric.textContent).toContain('甲')
      expect(lyric.textContent).not.toContain('亥')
      // and the early part of the chunk keeps the same long line
      audio.currentTime = 1
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toContain('甲')
    } finally {
      bookTextFixture = ''
    }
  })

  // Boot a fresh client instance whose FakeAudio can emit events, mount the bar +
  // panel, open the AI 讲书 tab, and click the matching book row. Returns the
  // mounted container and the created <audio> so a test can drive
  // currentTime/duration and read the rendered progress fill + percent readout.
  async function mountProgressBook({ bookName, charOffsets, text }) {
    const audios = []
    class ProgressAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: bookName, url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = charOffsets
    bookTextFixture = text
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ProgressAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    const preAudio = audios[1] // 隐藏预载元素（讲书双缓冲的 preAudio）
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    expect(bookTab).toBeTruthy()
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes(bookName))
    expect(bookRow).toBeTruthy()
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // flush the async /meta (charOffsets) + /text (subtitle) fetches
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    return { container, audio, preAudio }
  }

  it('fills the AI 讲书 progress bar by read-char / total-char (not chunk time ratio)', async () => {
    // Two chunks: chunk0 = 10 chars, chunk1 = 20 chars, total 30. 块内按时间占比插值
    // 到已读字符数，再除以全书字符——而不是用 position/duration（那会切块回退）。
    const { container, audio } = await mountProgressBook({ bookName: '进度测试.txt', charOffsets: [0, 10, 30], text: '甲' })
    audio.duration = 10
    audio.currentTime = 5 // chunk0 中点
    act(() => { audio.emit('timeupdate') })
    // consumed = offsets[0] + (10-0) * (5/10) = 5 ; progress = 5/30 ≈ 16.7%
    const fill = container.querySelector('.dsh-music-bar-progress-fill')
    expect(fill).toBeTruthy()
    expect(parseFloat(fill.style.width)).toBeCloseTo(16.67, 1)
    // 前进到 chunk0 末端 → consumed = 10 → 33.3%
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    expect(parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)).toBeCloseTo(33.33, 1)
    bookTextFixture = ''
  })

  it('keeps AI 讲书 progress monotonic across a chunk boundary (never steps back)', async () => {
    const { container, audio } = await mountProgressBook({ bookName: '跨块进度测试.txt', charOffsets: [0, 10, 30], text: '甲' })
    // chunk0 播完 → progress = offsets[1]/total = 10/30 = 33.3%
    audio.duration = 10
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    const p0 = parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)
    expect(p0).toBeCloseTo(33.33, 1)
    // chunk0 结束 → 自动切到 chunk1（bookFromRef = 1）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 新块从块内位置 0 开始：consumed = offsets[1] + 0 = 10 → 33.3%，与上一块末端连续
    audio.duration = 20
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const p1 = parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)
    expect(p1).toBeCloseTo(33.33, 1)      // 不是回退到更低的百分比
    expect(p1).toBeGreaterThanOrEqual(p0 - 0.001) // 单调：只增不减
    // 且随 chunk1 播放继续爬升（块内插值）
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    const p2 = parseFloat(container.querySelector('.dsh-music-bar-progress-fill').style.width)
    expect(p2).toBeGreaterThan(p1)
    expect(p2).toBeCloseTo((10 + 20 * 0.5) / 30 * 100, 1) // 50%
    bookTextFixture = ''
  })

  it('shows "AI 合成中…" when the preload request has not returned data yet (stalled synthesis)', async () => {
    // Regression（TTS 上游慢合成静默卡住）: preloadBook 在发起预取时同步置位
    // bookBufferedFrom，旧逻辑据此判定「已预热」→ ended 后静默切块（不显示任何
    // 缓冲提示）。若预取请求其实卡在合成（TTS 上游数十秒才返回），用户看到的是
    // 无声无息、字幕不动的「卡住」。修正：warmed 必须同时满足 preAudio 真拿到了
    // 可播数据（readyState>=1 / buffered 非空）；预取无数据 → 走非静默切块 →
    // 播放条显示「AI 合成中… Ns」+ 60s 超时兜底。
    const audios = []
    class StallPreloadAudio extends FakeAudio {
      constructor() { super(); audios.push(this); this._resolvePlay = null }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
      play() {
        this.paused = false
        // 切到卡住块后 play() 挂起（真实浏览器：无数据不派发 canplay，play 不 resolve）——
        // 直到手动 resolvePlay() 模拟「TTS 终于返回、开始播放」。
        this._playPromise = new Promise((res) => { this._resolvePlay = res })
        return this._playPromise
      }
      resolvePlay() { if (this._resolvePlay) { const r = this._resolvePlay; this._resolvePlay = null; r() } }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '卡住预取提示测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookCharOffsets = [0, 10, 30]
    bookTextFixture = '甲'
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', StallPreloadAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const preAudio = audios[1]
    expect(audio).toBeTruthy()
    expect(preAudio).toBeTruthy()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
    act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('卡住预取提示测试'))
    act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // chunk0 播放中，preloadBook(chunk1) 已发出（preAudio.src 指向 from=1）
    expect(String(audio.src || '')).toContain('from=0')
    expect(String(preAudio.src || '')).toContain('from=1')
    // 模拟预取请求卡住：preAudio 尚未拿到任何可播数据（真实浏览器此时 readyState=0）
    preAudio.readyState = 0
    preAudio.buffered = { length: 0 }
    // chunk0 播完 → 自动切 chunk1
    audio.duration = 10
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=1')
    // 预取无数据 → 非静默：播放条应显示「AI 合成中…」缓冲提示（而不是无声卡住）
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeTruthy()
    // TTS 终于返回、开始播放 → 缓冲提示清除
    audio.resolvePlay()
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeNull()
    bookTextFixture = ''
  })

  it('keeps the chunk switch silent (no buffer flash) when the preload is truly ready', async () => {
    // 对照：preAudio 真拿到了可播数据（readyState>=2）时，ended 切块仍是静默的——
    // 不闪「AI 合成中」提示（预热成功的正常路径，瞬时切换无感）。
    const { container, audio, preAudio } = await mountProgressBook({ bookName: '预热就绪静默测试.txt', charOffsets: [0, 10, 30], text: '甲' })
    expect(String(preAudio.src || '')).toContain('from=1')
    preAudio.readyState = 2 // HAVE_CURRENT_DATA：preAudio 已缓冲到可播数据
    preAudio.buffered = { length: 1 }
    audio.duration = 10
    audio.currentTime = 10
    act(() => { audio.emit('timeupdate') })
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('from=1')
    // preAudio 就绪 → 静默切块：无缓冲提示（正常预热路径不闪 spinner）
    expect(container.querySelector('.dsh-music-bar-buffering')).toBeNull()
    bookTextFixture = ''
  })

  it('tolerates a nearby comma just past the hard-cut boundary (line stays complete)', async () => {
    // 22 个连续汉字后接逗号、窗口内无任何停顿标点：硬切本会在第 20 字处断。容忍算法把
    // 行尾挪到边界后不远处（≤ SUBTITLE_TOLERANCE 字）的逗号之后，使这一行以完整分句结束。
    const fixture = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥，'
    const { container, audio } = await mountProgressBook({ bookName: '容忍标点测试.txt', charOffsets: [0, 40], text: fixture })
    audio.duration = 10
    const seen = new Set()
    for (let t = 0; t <= 9.9; t += 0.05) {
      audio.currentTime = t
      act(() => { audio.emit('timeupdate') })
      const el = container.querySelector('.dsh-music-bar-lyric')
      if (el && el.textContent) seen.add(el.textContent)
    }
    expect(seen.size).toBe(1)                 // 没有额外再拆出一行
    const line = [...seen][0]
    expect(subContentLen(line)).toBe(22)      // 容忍后略超 20 字
    expect(line.endsWith('，')).toBe(true)     // 且落在完整分句上，不是裸切
    bookTextFixture = ''
  })

  it('swallows a tiny chunk tail when the block is about to end (no stub line)', async () => {
    // 23 个连续汉字、无任何标点：硬切会拆成「20 字 + 3 字残行」。容忍算法在块尾只余
    // ≤ SUBTITLE_TOLERANCE 字时把尾巴并入本行，避免末尾出现一个极短残行。
    const fixture = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥走'
    const { container, audio } = await mountProgressBook({ bookName: '容忍块尾测试.txt', charOffsets: [0, 40], text: fixture })
    audio.duration = 10
    const seen = new Set()
    for (let t = 0; t <= 9.9; t += 0.05) {
      audio.currentTime = t
      act(() => { audio.emit('timeupdate') })
      const el = container.querySelector('.dsh-music-bar-lyric')
      if (el && el.textContent) seen.add(el.textContent)
    }
    expect(seen.size).toBe(1)                 // 不再拆出第 2 个极短残行
    const line = [...seen][0]
    expect(line).toBe(fixture)                // 整块吞进一行
    expect(subContentLen(line)).toBe(23)
    bookTextFixture = ''
  })

  it('double-clicking a track plays it without pausing or showing an autoplay-block error', async () => {
    // Capture the <audio> elements the plugin creates and mimic the real
    // browser: pause() aborts a still-pending play() promise with AbortError.
    // That is exactly the path that previously produced the bogus
    // "浏览器拦截了自动播放" message when a double-click's second click toggled
    // the just-started track to paused.
    const audios = []
    class PendingPlayAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      play() {
        this.paused = false
        this._playPromise = new Promise((res, rej) => { this._resolve = res; this._reject = rej })
        return this._playPromise
      }
      pause() {
        this.paused = true
        if (this._reject) {
          const rej = this._reject
          this._reject = null
          rej(Object.assign(new Error('The play() request was interrupted by a call to pause().'), { name: 'AbortError' }))
        }
      }
    }
    // Re-boot with the pending-play Audio stub (fresh module = fresh instances).
    vi.resetModules()
    registered = []
    lastFilesUrl = null
    manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', PendingPlayAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    // audios[0] is the main <audio>; audios[1] is the hidden preload element.
    const audio = audios[0]
    expect(audio).toBeTruthy()

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const trackBtn = container.querySelector('.dsh-music-track')
    expect(trackBtn).toBeTruthy()

    // First click of a double-click starts the track (play promise stays pending).
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    // allow React to re-render (the row is now active) before the second click
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(false)

    // Second click of the double-click (detail: 2) must be ignored: the track
    // keeps playing and no autoplay-block error is surfaced.
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(false)
    expect(container.textContent).not.toContain('浏览器拦截')
    expect(container.textContent).not.toContain('自动播放')

    // Some environments report detail=1 even for the second click of a double
    // click — the time-window fallback must still ignore it.
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(false)
    expect(container.textContent).not.toContain('浏览器拦截')

    // After the double-click window passes, a deliberate single click on the
    // active track still toggles (pause) — and that pause aborts the pending
    // play promise, which must NOT be misreported as an autoplay block.
    await new Promise((r) => setTimeout(r, 650))
    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.paused).toBe(true)
    expect(container.textContent).not.toContain('浏览器拦截')
    expect(container.textContent).not.toContain('自动播放')
  })

  it('shows the current lyric line in the bar only in the idle (collapsed-controls) state', async () => {
    // 需求规格：歌词位于频谱之后、时长之前，且仅"非使用态"（控件组已滑动折叠、
    // 播放条半透明 dimmed）显示；鼠标进入操作时收起，不给滑入的按钮让路。
    lyricFixture = {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: [{ t: 0, text: '第一句歌词' }, { t: 5, text: '第二句歌词' }],
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const barEl = container.querySelector('.dsh-music-bar')
      // 闲置态（控件组折叠、半透明）：歌词显示，且为当前行（currentTime=0 → 第一句）
      expect(barEl.classList.contains('dimmed')).toBe(true)
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('第一句歌词')
      // 来源标记：本地同名 .lrc → data-src="local"
      expect(lyric.getAttribute('data-src')).toBe('local')
      // 歌词在 .dsh-music-bar-controls（时长）之前、频谱之后（DOM 顺序断言）
      const controls = container.querySelector('.dsh-music-bar-controls')
      const hotspot = container.querySelector('.dsh-music-bar-hotspot')
      const idxLyric = [...barEl.children].indexOf(lyric)
      const idxControls = [...barEl.children].indexOf(controls)
      expect(idxLyric).toBeGreaterThanOrEqual(0)
      expect(idxLyric).toBeLessThan(idxControls)
      // 使用态（鼠标进入右端热区、控件组滑入）：歌词收起
      act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(barEl.classList.contains('dimmed')).toBe(false)
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()
      // 离开超过 1s → 回到闲置态 → 歌词恢复
      vi.useFakeTimers()
      try {
        act(() => { controls.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
        act(() => { vi.advanceTimersByTime(1200) })
      } finally { vi.useRealTimers() }
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(barEl.classList.contains('dimmed')).toBe(true)
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeTruthy()
    } finally { lyricFixture = null }
  })

  it('labels file-embedded lyrics source=embedded (data-src="embedded")', async () => {
    // /lyric 返回 source:'embedded'（文件内嵌歌词，非同名 .lrc）时，播放条歌词来源
    // 标记应为 embedded，与本地同名 .lrc（local）区分开。
    lyricFixture = {
      ok: true, hasLrc: true, source: 'embedded',
      lrc: [{ t: 0, text: '内嵌第一句' }, { t: 5, text: '内嵌第二句' }],
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('内嵌第一句')
      expect(lyric.getAttribute('data-src')).toBe('embedded')
    } finally { lyricFixture = null }
  })

  it('merges local .lrc format-C translation into "原文 ／ 翻译" on the bar lyric', async () => {
    // Host 从本地 .lrc 拆出的 trans（格式 C 翻译）会走与在线歌词相同的 mergeLyricTrans，
    // 把紧跟原句的翻译并入同一行「原文 ／ 翻译」显示。
    lyricFixture = {
      ok: true, hasLrc: true, source: 'local',
      lrc: [{ t: 0, text: '窗外的麻雀' }, { t: 5, text: '雨下整夜' }],
      trans: [{ t: 0.5, text: 'Sparrows outside the window' }],
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      // 播放条只显示当前行：t=0 的第一句已合并成「原文 ／ 翻译」
      expect(lyric.textContent).toContain('窗外的麻雀 ／ Sparrows outside the window')
      // 仍是本地 .lrc 来源
      expect(lyric.getAttribute('data-src')).toBe('local')
    } finally { lyricFixture = null }
  })

  it('clicking the bar lyric opens a full-lyric panel that highlights the current line', async () => {
    // 单击播放条歌词/字幕 → 打开歌词面板：显示完整歌词，当前行高亮并随播放推进
    // 更新；再单击可关闭。面板默认居中、独立于播放面板。
    const audios = []
    class LpAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    lyricFixture = {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: [{ t: 0, text: '第一句歌词' }, { t: 5, text: '第二句歌词' }],
    }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null
      manifest = baseManifest()
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', LpAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true
      window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = {
        inject: (name, cb) => { cb() },
        register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
      }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const audio = audios[0]
      expect(audio).toBeTruthy()
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const lyricPanel = registered.find((r) => r.id === 'music-player-lyric-panel').elementFactory()
      expect(lyricPanel).toBeTruthy()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel, lyricPanel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 默认关闭
      const lyricPanelEl = container.querySelector('.dsh-music-lyric-panel')
      expect(lyricPanelEl).toBeTruthy()
      expect(lyricPanelEl.style.display).toBe('none')
      // 透明模式默认开启 → 面板根节点带 ghost 类（CSS 隐去外壳背景/边框/阴影）
      expect(lyricPanelEl.classList.contains('ghost')).toBe(true)
      // 单击播放条歌词 → 打开面板
      const barLyric = container.querySelector('.dsh-music-bar-lyric')
      expect(barLyric).toBeTruthy()
      act(() => { barLyric.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).not.toBe('none')
      // 面板显示完整两行歌词，第一行（当前）高亮
      const lines = [...lyricPanelEl.querySelectorAll('.dsh-music-lyric-line')]
      expect(lines.length).toBe(2)
      expect(lines[0].textContent).toContain('第一句歌词')
      expect(lines[1].textContent).toContain('第二句歌词')
      expect(lines[0].classList.contains('active')).toBe(true)
      expect(lines[1].classList.contains('active')).toBe(false)
      // 推进到第二句 → 高亮随播放更新
      audio.currentTime = 6
      act(() => { audio.emit('timeupdate') })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lines2 = [...lyricPanelEl.querySelectorAll('.dsh-music-lyric-line')]
      expect(lines2[0].classList.contains('active')).toBe(false)
      expect(lines2[1].classList.contains('active')).toBe(true)
      // 再单击播放条歌词 → 关闭
      act(() => { barLyric.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).toBe('none')
    } finally { lyricFixture = null }
  })

  it('drops the ghost class when the lyric-panel transparency pref is off (restore solid shell)', async () => {
    // 透明模式回归：dsh-music-lyric-panel-ghost='0' 时面板根节点不带 ghost 类，
    // 恢复普通外壳（背景/边框/阴影由 CSS 提供，这里只验证类的开关随偏好联动）。
    const audios = []
    class GhostOffAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    lyricFixture = {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: [{ t: 0, text: '第一句歌词' }, { t: 5, text: '第二句歌词' }],
    }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null
      manifest = baseManifest()
      prefsServer = { 'dsh-music-lyric-panel-ghost': '0' }
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', GhostOffAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true
      window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = {
        inject: (name, cb) => { cb() },
        register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
      }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const audio = audios[0]
      expect(audio).toBeTruthy()
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const lyricPanel = registered.find((r) => r.id === 'music-player-lyric-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel, lyricPanel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const barLyric = container.querySelector('.dsh-music-bar-lyric')
      act(() => { barLyric.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyricPanelEl = container.querySelector('.dsh-music-lyric-panel')
      expect(lyricPanelEl.style.display).not.toBe('none')
      expect(lyricPanelEl.classList.contains('ghost')).toBe(false)
      // 空闲时 audio 未被使用也无妨——本用例只关心类名联动。
      void audio
    } finally { lyricFixture = null }
  })

  it('keeps the lyric panel always open on outside clicks (only the close button dismisses it)', async () => {
    // 歌词面板「常驻显示」：不再有钉住按钮，点击外部不关闭面板（一直显示），
    // 只有手动点关闭按钮才消失。单击歌词可开关面板。
    const audios = []
    class PinAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    lyricFixture = {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: [{ t: 0, text: '第一句歌词' }, { t: 5, text: '第二句歌词' }],
    }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null
      manifest = baseManifest()
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', PinAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true
      window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = {
        inject: (name, cb) => { cb() },
        register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
      }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const lyricPanel = registered.find((r) => r.id === 'music-player-lyric-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel, lyricPanel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyricPanelEl = container.querySelector('.dsh-music-lyric-panel')
      const barLyric = container.querySelector('.dsh-music-bar-lyric')
      // 已移除钉住按钮
      const pinBtn = container.querySelector('.dsh-music-lyric-panel button[title^="钉住"]')
      expect(pinBtn).toBeNull()
      // 单击歌词 → 打开面板
      act(() => { barLyric.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).not.toBe('none')
      // 点击外部 → 面板保持打开（一直显示）
      act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).not.toBe('none')
      // 再单击歌词 → 关闭（toggle）
      act(() => { barLyric.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).toBe('none')
      // 重新打开 → 只有手动点关闭按钮才关闭
      act(() => { barLyric.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).not.toBe('none')
      const closeBtn = container.querySelector('.dsh-music-lyric-panel button[title="关闭"]')
      expect(closeBtn).toBeTruthy()
      act(() => { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).toBe('none')
    } finally { lyricFixture = null }
  })

  it('restores the lyric panel position from the Host prefs after a refresh', async () => {
    // 回归：歌词面板位置曾漏出 Host 白名单，刷新后 GET /prefs 快照无此键 →
    // 面板回到默认位置。预置位置后重开面板应恢复持久化的 left/top/width/height。
    const audios = []
    class PosAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    lyricFixture = {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: [{ t: 0, text: '第一句歌词' }],
    }
    prefsServer = { 'dsh-music-lyric-panel-pos': JSON.stringify({ x: 123, y: 87, w: 430, h: 470 }) }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null
      manifest = baseManifest()
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', PosAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true
      window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = {
        inject: (name, cb) => { cb() },
        register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
      }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const lyricPanel = registered.find((r) => r.id === 'music-player-lyric-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel, lyricPanel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyricPanelEl = container.querySelector('.dsh-music-lyric-panel')
      // 预置位置已恢复：内联 geometry 为持久化值（而非默认居中）
      expect(lyricPanelEl.style.left).toBe('123px')
      expect(lyricPanelEl.style.top).toBe('87px')
      expect(lyricPanelEl.style.width).toBe('430px')
      expect(lyricPanelEl.style.height).toBe('470px')
      expect(lyricPanelEl.style.transform).toBe('none')
    } finally { lyricFixture = null }
  })

  it('updates the pinned lyric panel from AI 讲书 subtitles to QQ lyrics on source switch', async () => {
    // Regression: 歌词面板一直钉住时，从 AI 讲书切到 QQ 音乐播放，面板必须刷新为
    // QQ 歌词，而不是残留小说字幕。startQQPlayback 直接调 loadQQLyric（不经
    // loadLyricForTrack），若 loadQQLyric 不先 resetLyric，残留的 subtitleLines 会
    // 让 syncLyricPanelData 继续以字幕生成歌词行。
    const audios = []
    class SwitchAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [{ id: 'b1', name: '切换测试.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }] }
    bookMetaSections = []
    bookTextFixture = '第一章的旁白内容。第二句旁白。'
    qqLoggedIn = true
    qqLyricFixture = {
      ok: true, hasLyric: true,
      lrc: [{ t: 0, text: '告白气球' }, { t: 3, text: '亲爱的 爱上你' }],
      trans: [],
    }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', SwitchAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true
      window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = {
        inject: (name, cb) => { cb() },
        register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
      }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const audio = audios[0]
      expect(audio).toBeTruthy()
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const lyricPanel = registered.find((r) => r.id === 'music-player-lyric-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel, lyricPanel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // ---- 1) AI 讲书播放：填充字幕 ----
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const bookRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('切换测试'))
      act(() => { bookRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      audio.duration = 10
      audio.currentTime = 0
      act(() => { audio.emit('timeupdate') })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyricPanelEl = container.querySelector('.dsh-music-lyric-panel')
      // 单击字幕打开歌词面板 → 显示小说字幕
      const barLyric = container.querySelector('.dsh-music-bar-lyric')
      expect(barLyric).toBeTruthy()
      act(() => { barLyric.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(lyricPanelEl.style.display).not.toBe('none')
      const bookLines = [...lyricPanelEl.querySelectorAll('.dsh-music-lyric-line')].map((el) => el.textContent)
      expect(bookLines.join('')).toContain('第一章的旁白内容')
      // ---- 2) 切到 QQ 音乐播放：startQQPlayback（绕过 loadLyricForTrack）----
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 歌词面板应刷新为 QQ 歌词，不再显示小说字幕
      const qqLines = [...lyricPanelEl.querySelectorAll('.dsh-music-lyric-line')].map((el) => el.textContent)
      expect(qqLines.join('')).toContain('告白气球')
      expect(qqLines.join('')).toContain('亲爱的 爱上你')
      expect(qqLines.join('')).not.toContain('第一章的旁白内容')
      // 面板仍保持打开（钉住/未钉住都不应因切歌而关闭）
      expect(lyricPanelEl.style.display).not.toBe('none')
    } finally {
      bookTextFixture = ''
      bookMetaSections = []
      qqLyricFixture = null
    }
  })

  // 歌词换行动效装置：boot 后播放单曲目 a.mp3，返回可 emit timeupdate 的主 audio。
  // fxPref 为空时保持默认 none（无动效）；否则以 Host pref 预置 dsh-music-lyric-fx。
  // lrc 可覆盖默认两行测试词（构造间奏等场景）。
  async function mountMusicFx({ fxPref, localLrc = true, lrc } = {}) {
    const audios = []
    class FxAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    lyricFixture = localLrc ? {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: lrc || [{ t: 0, text: '第一句歌词' }, { t: 5, text: '第二句歌词' }],
    } : { ok: true, hasLrc: false, name: '', lrc: [] }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null; prefsPosts = []
      manifest = baseManifest()
      prefsServer = fxPref ? { 'dsh-music-lyric-fx': fxPref } : {}
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', FxAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true
      window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = {
        inject: (name, cb) => { cb() },
        register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef },
      }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const audio = audios[0]
      expect(audio).toBeTruthy()
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      return { container, audio }
    } finally { lyricFixture = null }
  }

  it("fx='slide'（显式选择）：每行歌词重挂载重放入场动画；无退场动画，上一句即时消失（data-prev 仅作入场延迟判定）", async () => {
    const { container, audio } = await mountMusicFx({ fxPref: 'slide' })
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    let outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer).toBeTruthy()
    // 关键回归：textContent 是「纯净的当前行」（退场伪元素已移除，上一句不残留 DOM）
    expect(outer.textContent).toBe('第一句歌词')
    let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('slide')
    expect(fxEl.getAttribute('data-prev')).toBeNull()
    // 默认开启边缘渐隐遮罩；jsdom 无布局不会误判溢出（无 marquee 类、无 data-over）
    expect(outer.getAttribute('data-mask')).toBe('1')
    expect(outer.getAttribute('data-over')).toBeNull()
    expect(container.querySelector('.dsh-music-bar-lyric-run.mq')).toBeNull()

    // 前进到第二句：key(seq) 变化强制重挂载 → 浏览器里入场动画重放；
    // 上一句即时消失，无 ::after 退场层；data-prev 仅保留供「首次挂载」延迟判定。
    const fxFirst = fxEl
    audio.currentTime = 6
    act(() => { audio.emit('timeupdate') })
    outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer.textContent).toBe('第二句歌词')
    fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl).not.toBe(fxFirst)                     // 确实重新挂载了
    expect(fxEl.getAttribute('data-prev')).toBe('第一句歌词')
    // 无退场层：新句元素上没有 ::after 伪元素（真实浏览器里上一句不叠映）
    expect(fxEl.nextSibling).toBeNull()
  })

  it('REGRESSION: 长句跑马灯运行中切到短句，短句不再带 mq（mock 布局复现换行时序）', async () => {
    const audios = []
    class FxAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    lyricFixture = {
      ok: true, hasLrc: true, name: 'a.lrc',
      lrc: [
        { t: 0, text: '这是一个非常非常长的歌词行用来触发跑马灯效果这是第二段很长很长', },
        { t: 5, text: '短句' },
      ],
    }
    try {
      vi.resetModules(); registered = []; lastFilesUrl = null; prefsPosts = []
      manifest = baseManifest()
      window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
      vi.stubGlobal('Audio', FxAudio)
      vi.stubGlobal('fetch', fetchStub)
      vi.stubGlobal('requestAnimationFrame', () => 0)
      vi.stubGlobal('cancelAnimationFrame', () => {})
      vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
      vi.stubGlobal('setInterval', () => 0)
      vi.stubGlobal('clearInterval', () => {})
      window.confirm = () => true; window.prompt = () => null
      await import('../lib/client.js')
      const modExports = factory((name) => (name === 'react' ? React : undefined))
      const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
      modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
      await new Promise((r) => setTimeout(r, 0))
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const audio = audios[0]
      // mock 布局：clip 可视宽 100px；run.clientWidth 按当前文本长度估算（长句溢出、
      // 短句不溢出）；run.scrollWidth 恒为大值——模拟 fx='slide'/'blur' 时新句 ::after
      // 装着上一句长文本把 scrollWidth 撑大的场景。回归：测量必须读 clientWidth，
      // 短句不因 scrollWidth 被撑大而误判为溢出。
      const clipEl = container.querySelector('.dsh-music-bar-lyric')
      const runEl = container.querySelector('.dsh-music-bar-lyric-run')
      expect(clipEl).toBeTruthy()
      expect(runEl).toBeTruthy()
      Object.defineProperty(clipEl, 'clientWidth', { configurable: true, get: () => 100 })
      Object.defineProperty(runEl, 'clientWidth', { configurable: true, get: () => Math.max(50, (runEl.textContent || '').length * 12) })
      Object.defineProperty(runEl, 'scrollWidth', { configurable: true, get: () => 9999 })
      // 触发重测：第一句长 → 应带 mq
      window.dispatchEvent(new Event('resize'))
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('这是一个非常非常长的歌词行用来触发跑马灯效果这是第二段很长很长')
      expect(container.querySelector('.dsh-music-bar-lyric-run.mq')).toBeTruthy()
      // 切到第二句（很短）→ 不得再带 mq
      audio.currentTime = 6
      act(() => { audio.emit('timeupdate') })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('短句')
      expect(container.querySelector('.dsh-music-bar-lyric-run.mq')).toBeNull()
    } finally { lyricFixture = null }
  })

  it("fx 默认 = 'none'（无动效）：不选择任何动效时行为与旧版硬切完全一致", async () => {
    // 回归：默认值必须是无动效——未显式选择的用户不应看到任何换行动效。
    const { container, audio } = await mountMusicFx()
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer.textContent).toBe('第一句歌词')
    const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('none')
    expect(fxEl.getAttribute('data-prev')).toBeNull()
    audio.currentTime = 6
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
    // 无 key → React 复用同一节点（重挂载才有的入场动画在这里不存在）
    expect(container.querySelector('.dsh-music-bar-lyric-fx')).toBe(fxEl)
  })

  it("fx='none'：与旧行为一致的硬切——不重挂载、无 data-prev、无动画属性", async () => {
    const { container, audio } = await mountMusicFx({ fxPref: 'none' })
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    const outer = container.querySelector('.dsh-music-bar-lyric')
    expect(outer.textContent).toBe('第一句歌词')
    const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('none')
    expect(fxEl.getAttribute('data-prev')).toBeNull()
    audio.currentTime = 6
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
    // 无 key → React 复用同一节点，即原始「硬切」语义
    expect(container.querySelector('.dsh-music-bar-lyric-fx')).toBe(fxEl)
    expect(fxEl.getAttribute('data-prev')).toBeNull()
  })

  it("fx='karaoke'：裸 LRC 也走音频时钟——窗口按字符估算封顶（min(间隔,估算)）", async () => {
    const { container, audio } = await mountMusicFx({ fxPref: 'karaoke' })
    audio.duration = 20
    audio.currentTime = 0
    act(() => { audio.emit('timeupdate') })
    let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(fxEl.getAttribute('data-fx')).toBe('karaoke')
    expect(fxEl.getAttribute('data-audioclock')).toBe('1')
    // 行1 间隔 5s，但「第一句歌词」5 汉字 ≈2.75s 更短 → 窗口取估算值；
    // 起点处 f=0 → 位置 70%
    expect(fxEl.style.backgroundPositionX).toBe('70.00%')
    audio.currentTime = 7
    act(() => { audio.emit('timeupdate') })
    fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    // 行2 是末行（间隔按总长兜底 15s），仍被估算值封顶为 2750ms；
    // 已过 2000ms → f≈0.7273 → (1.05−f)/1.5 ≈ 21.52%
    // 长间奏回归见下一个用例（构造 60s 间隔的独立装置）
  })

  it("fx='karaoke'：长间奏前一句与末行——唱完满亮一小会后歌词消隐（不再挂到下一句）", async () => {
    // 回归：裸 LRC 只有行起点。60s 的间隔曾被全额当扫色窗口 → 龟速；
    // 随后音频时钟+封顶解决摊平，但整句仍显示到下一句才开始。现在：
    // 窗口内正常扫色（估算封顶）→ 唱完且静默 >1.2s → 歌词消失。
    const { container, audio } = await mountMusicFx({
      fxPref: 'karaoke',
      lrc: [{ t: 0, text: '第一句歌词' }, { t: 60, text: '第二句歌词' }],
    })
    audio.duration = 120
    audio.currentTime = 1.5   // 行1 窗口内（~2.75s）：正常扫色
    act(() => { audio.emit('timeupdate') })
    let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第一句歌词')
    expect(fxEl.style.backgroundPositionX).toBe('33.64%')   // f=1500/2750 → (1.05−f)/1.5

    audio.currentTime = 30   // 行1 已唱完很久、处于长间奏中段 → 歌词应已消失
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()

    audio.currentTime = 61.5 // 行2 窗口内：重新出现
    act(() => { audio.emit('timeupdate') })
    fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
    expect(fxEl.style.backgroundPositionX).toBe('33.64%')   // 过 1500/2750

    audio.currentTime = 65   // 行2 唱完后同样消隐（静默到曲尾）
    act(() => { audio.emit('timeupdate') })
    expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()
  })

  it('QRC 行窗口：卡拉OK改音频时钟驱动——位置随 timeupdate 实时校准，间奏停满亮不摊平', async () => {
    // /lyric 无本地 .lrc → 在线兜底返回 qq-qrc 的精确行窗口 [{t,end,text}]。
    // 扫色不再用墙钟 CSS 动画（挂载锚定会因起播缓冲/卡顿漂移），而是每次
    // timeupdate 按 audio.currentTime 直写 background-position-x + 短过渡。
    lyricOnlineFixture = {
      ok: true, hasLyric: true, source: 'qq-qrc',
      wordLines: [
        { t: 0, end: 4.5, text: '第一句歌词' },
        { t: 4.5, end: 9, text: '第二句歌词' },
      ],
    }
    try {
      const { container, audio } = await mountMusicFx({ fxPref: 'karaoke', localLrc: false })
      audio.duration = 20
      audio.currentTime = 0
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第一句歌词')
      let fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      // 音频时钟模式生效：无 --kar-dur 动画变量，标记 data-audioclock；行起点 → 100%
      expect(fxEl.getAttribute('data-audioclock')).toBe('1')
      expect(fxEl.style.getPropertyValue('--kar-dur')).toBe('')
      expect(fxEl.style.backgroundPositionX).toBe('70.00%')

      // 行内进度：7s，第二行 [4.5,9]s 已过 2.5/4.5 → 位置 (1-5/9)=44.44%
      audio.currentTime = 7
      act(() => { audio.emit('timeupdate') })
      fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
      expect(fxEl.style.backgroundPositionX).toBe('32.96%')   // f=5/9 → (1.05−f)/1.5

      // 行内 seek 漂移修正：直接跳到行尾附近，下一拍立即对齐（旧墙钟动画做不到）
      audio.currentTime = 8.8
      act(() => { audio.emit('timeupdate') })
      fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(fxEl.style.backgroundPositionX).toBe('6.30%')   // (1.05−0.956)/1.5

      // 末行唱完后（9~20s 长间奏，静默 11s > 1.2s 阈值）：歌词消隐——不再挂到下一句
      audio.currentTime = 12
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()

      // 唱完前的瞬间（8.9s）：仍在显示（真实行窗口内）
      audio.currentTime = 8.9
      act(() => { audio.emit('timeupdate') })
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('第二句歌词')
      const el = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(el.getAttribute('data-fx')).toBe('karaoke')

      // 暂停：fx 层仍挂 fxfrozen 类（跑马灯/入场动画时钟冻结）
      act(() => { container.querySelector('button[title="播放/暂停"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.querySelector('.dsh-music-bar-lyric-fx').classList.contains('fxfrozen')).toBe(true)
    } finally { lyricOnlineFixture = null }
  })

  it('QRC 行窗口恒走整行扫色：词级数据即使存在也不渲染逐字 span（逐字点亮已移除）', async () => {
    // 回归：payload 里残留 words 字段（或未来恢复下发）也不得改变渲染——
    // fx 层无 data-wordmode、DOM 无 .dsh-music-word，扫色仍是整行渐变。
    lyricOnlineFixture = {
      ok: true, hasLyric: true, source: 'qq-qrc',
      wordLines: [
        { t: 0, end: 4, text: '你好世界', words: [
          { text: '你', s: 0, d: 1 }, { text: '好', s: 1, d: 1 },
        ] },
        { t: 4, end: 8, text: '再见了朋友' },
      ],
    }
    try {
      const { container, audio } = await mountMusicFx({ fxPref: 'karaoke', localLrc: false })
      audio.currentTime = 2.5
      act(() => { audio.emit('timeupdate') })
      const outer = container.querySelector('.dsh-music-bar-lyric')
      expect(outer.getAttribute('data-src')).toBe('qq-qrc')
      const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(fxEl.getAttribute('data-wordmode')).toBeNull()
      expect(fxEl.textContent).toBe('你好世界')
      expect(fxEl.querySelectorAll('.dsh-music-word').length).toBe(0)
      // 音频时钟模式：行 [0,4]s 已过 2.5s → 位置 (1-2500/4000)=37.50%
      expect(fxEl.getAttribute('data-audioclock')).toBe('1')
      expect(fxEl.style.backgroundPositionX).toBe('28.33%')   // f=2500/4000

      audio.currentTime = 5
      act(() => { audio.emit('timeupdate') })
      const fxEl2 = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('再见了朋友')
      expect(fxEl2.style.backgroundPositionX).toBe('53.33%')   // f=1000/4000
    } finally { lyricOnlineFixture = null }
  })

  it('falls back to the online lyric when a local track has no .lrc (no source badge)', async () => {
    // 本地无同名 .lrc（/lyric 返回 hasLrc:false）→ 客户端自动请求 /dsh-music/lyric/online
    // （Host 走 QQ → LRCLIB 兜底）；取到词后直接显示歌词，不显示歌词来源标识。
    lyricOnlineFixture = {
      ok: true, hasLyric: true, source: 'qq',
      matched: { title: '七里香', artist: '周杰伦', songmid: 'S1', score: 90 },
      lrc: [{ t: 0, text: '窗外的麻雀' }, { t: 5, text: '雨下整夜' }],
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.mp3'))
      act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('窗外的麻雀')
      // 来源可观测：在线兜底普通 LRC → data-src="qq"（诊断 QRC 是否生效的标记）
      expect(lyric.getAttribute('data-src')).toBe('qq')
      // 不显示来源标识（QQ / LRCLIB 小标已移除）
      expect(container.querySelector('.dsh-music-bar-lyric-src')).toBeNull()
    } finally { lyricOnlineFixture = null }
  })

  it('shows only two centered login buttons (QQ/微信登录) when not logged in', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    expect(onlineTab).toBeTruthy()
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // not logged in: only the two centered login buttons, no search/sub-tabs
    expect(container.textContent).toContain('QQ 登录')
    expect(container.textContent).toContain('微信登录')
    // 酷狗面板（第二个 .dsh-music-qq-pane，常驻渲染）也有登录按钮，断言需收窄到
    // 第一个 pane（QQ）内，否则会数到酷狗的「生成酷狗登录二维码」按钮。
    const qqPane = [...container.querySelectorAll('.dsh-music-qq-pane')][0]
    expect(qqPane.querySelector('.dsh-music-qq-input')).toBeNull()
    expect(qqPane.querySelector('.dsh-music-qq-viewtabs')).toBeNull()
    // both login buttons are the enlarged login-btn style and carry a risk disclaimer
    const btns = [...qqPane.querySelectorAll('.dsh-music-qq-login-btn')]
    expect(btns.length).toBe(2)
    expect(container.querySelector('.dsh-music-qq-login-warn')).toBeTruthy()
    expect(container.textContent).toContain('使用声明')
  })

  it('logged-in main UI: toolbar (播放列表 / 退出登录) + 4 sub-tabs + search flow', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // toolbar: 播放列表 (left) and 退出登录 (right), same ghost style
    expect(container.textContent).toContain('播放列表')
    expect(container.textContent).toContain('退出登录')
    const enterPl = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    const logoutBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '退出登录')
    expect(enterPl && enterPl.className.includes('ghost')).toBe(true)
    expect(logoutBtn && logoutBtn.className.includes('ghost')).toBe(true)
    // 6 sub-tabs: 我的歌单 / 推荐歌单 / 分类歌单 / 排行榜 / 新歌 / 搜索
    // 先等 viewtabs 渲染完成（登录态异步），避免单 tick 竞态读到空列表。
    await waitForText(container, '.dsh-music-qq-viewtab', '我的歌单')
    // 网易云面板（匿名可浏览）也常驻渲染同名 viewtab → 断言限定在「当前可见」的 QQ
    // 面板内（display:none 的 pane 仍在 DOM，全局 querySelectorAll 会混入第三源的按钮）。
    const visiblePane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => p.style.display !== 'none')
    const tabs = [...(visiblePane || container).querySelectorAll('.dsh-music-qq-viewtab')].map((b) => b.textContent)
    expect(tabs).toEqual(['我的歌单', '推荐歌单', '分类歌单', '排行榜', '新歌', '搜索'])
    // 搜索 sub-tab: input + search results
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '晴天')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('晴天')
    expect(container.textContent).toContain('周杰伦')  // artist name shows at the row tail
    // both songs and playlists exist → search results shown as two tabs, default 歌曲
    const resultTabs = [...container.querySelectorAll('.dsh-music-qq-resulttab')].map((b) => b.textContent)
    expect(resultTabs).toContain('歌曲')
    expect(resultTabs).toContain('相关歌单')
    // switch to 相关歌单 tab → playlists appear
    const plTab = [...container.querySelectorAll('.dsh-music-qq-resulttab')].find((b) => b.textContent === '相关歌单')
    act(() => { plTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('周杰伦合集')
  })

  it('loads more playlist search results via the 加载更多 button (page-2 append)', async () => {
    qqLoggedIn = true
    // 歌单搜索：第一页返回满页(50)→出现「加载更多」；第二页返回不同歌单→点击后追加。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      const url = String(u)
      if (url.includes('/dsh-music/qq/playlist-search')) {
        const page = parseInt(new URL(url, 'http://x').searchParams.get('page') || '1', 10)
        const list = page === 1
          ? Array.from({ length: 50 }, (_, i) => ({ id: 'pl' + i, name: '歌单' + i, creator: '作者', trackCount: 10, source: 'qq' }))
          : [{ id: 'pl20', name: '第2页歌单', creator: '作者', trackCount: 10, source: 'qq' }]
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: list, total: 51, page }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '周杰伦')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 切到「相关歌单」tab：满页 → 出现「加载更多」按钮
      const plTab = [...container.querySelectorAll('.dsh-music-qq-resulttab')].find((b) => b.textContent === '相关歌单')
      expect(plTab).toBeTruthy()
      act(() => { plTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
      expect(moreBtn).toBeTruthy()
      act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 第二页追加进来了
      expect(container.textContent).toContain('第2页歌单')
    } finally {
      window.fetch = origFetch
    }
  })

  it('酷狗歌曲搜索一次拿全：接口 total==已加载数 → 不出现「加载更多」按钮', async () => {
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u.startsWith('/dsh-music/kg/search')) return jsonRes({ ok: true, results: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
        { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
      ], page: 1, total: 2 })
      if (u.startsWith('/dsh-music/kg/playlist-search')) return jsonRes({ ok: true, playlists: [], page: 1, total: 0 })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [] })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const input = kgPane.querySelector('.dsh-music-qq-input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...kgPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('酷狗一号')
    // total==已加载数 → 一次拿全 → 不出现「加载更多」
    expect([...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].some((b) => b.textContent === '加载更多')).toBe(false)
  })

  it('QQ 歌单详情「播放全部」：整列表入队、从第一首开始播，播完自动接下一首', async () => {
    qqLoggedIn = true
    const audios = []
    class QQAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QQAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const card = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 歌单详情头出现「播放全部」
    const playAllBtn = [...container.querySelectorAll('.dsh-music-qq-playall')].find((b) => b.textContent.includes('播放全部'))
    expect(playAllBtn).toBeTruthy()
    act(() => { playAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 从第一首开始播（告白气球 songmid=789），第一行 active
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    const qqPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const rows = [...qqPane.querySelectorAll('.dsh-music-track-row')]
    expect(rows[0].classList.contains('active')).toBe(true)
    expect(rows[0].textContent).toContain('告白气球')
    expect(rows[1].classList.contains('active')).toBe(false)
    // 整列表入队：第一首播完自动接第二首（七里香 songmid=790）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/790')
  })

  it('QQ 排行榜「播放全部」：从第一首开始播，整列入队自动接下一首', async () => {
    qqLoggedIn = true
    const audios = []
    class QQAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QQAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const topsTab = await waitForText(container, '.dsh-music-qq-viewtab', '排行榜')
    act(() => { topsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const chart = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('飙升榜'))
    act(() => { chart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const playAllBtn = [...container.querySelectorAll('.dsh-music-qq-playall')].find((b) => b.textContent.includes('播放全部'))
    expect(playAllBtn).toBeTruthy()
    act(() => { playAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 从第一首开始播（飙升歌一 songmid=a），第一行 active
    expect(audio.src).toContain('/dsh-music/qq/play/a')
    const qqPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const rows = [...qqPane.querySelectorAll('.dsh-music-track-row')]
    expect(rows[0].classList.contains('active')).toBe(true)
    expect(rows[0].textContent).toContain('飙升歌一')
    // 整列入队：自动接下一首（飙升歌二 songmid=b）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/b')
  })

  it('QQ 新歌速递「播放全部」：从第一首开始播，整列入队自动接下一首', async () => {
    qqLoggedIn = true
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u.startsWith('/dsh-music/qq/new-songs')) return jsonRes({ ok: true, result: { type: 5, label: '最新', songs: [
        { id: 'n1', songmid: 'n1', title: '新歌一号', artists: ['歌手A'], album: '', interval: 200, payplay: 0, source: 'qq' },
        { id: 'n2', songmid: 'n2', title: '新歌二号', artists: ['歌手B'], album: '', interval: 200, payplay: 0, source: 'qq' },
      ] } })
      return baseFetch(url, opts)
    })
    const audios = []
    class QQAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QQAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const newTab = await waitForText(container, '.dsh-music-qq-viewtab', '新歌')
    act(() => { newTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 新歌头出现「播放全部」
    const playAllBtn = [...container.querySelectorAll('.dsh-music-qq-playall')].find((b) => b.textContent.includes('播放全部'))
    expect(playAllBtn).toBeTruthy()
    act(() => { playAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 从第一首开始播（新歌一号 songmid=n1），第一行 active
    expect(audio.src).toContain('/dsh-music/qq/play/n1')
    const qqPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const rows = [...qqPane.querySelectorAll('.dsh-music-track-row')]
    expect(rows[0].classList.contains('active')).toBe(true)
    expect(rows[0].textContent).toContain('新歌一号')
    // 整列入队：自动接下一首（新歌二号 songmid=n2）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/n2')
  })

  it('酷狗歌单详情「播放全部」：整列表入队、从第一首开始播，播完自动接下一首', async () => {
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u.startsWith('/dsh-music/kg/search')) return jsonRes({ ok: true, results: [], page: 1, total: 0 })
      if (u.startsWith('/dsh-music/kg/playlist-search')) return jsonRes({ ok: true, page: 1, playlists: [
        { id: '6409645', name: '周杰伦必听热歌', creatorId: '2132029040', gid: 'collection_3_2132029040_287_0', slid: '287', creator: '酷乐推荐', trackCount: 2, source: 'kugou', cover: '' },
      ] })
      if (u === '/dsh-music/kg/playlist/6409645') return jsonRes({ ok: true, playlist: {
        id: '6409645', name: '周杰伦必听热歌', creatorId: '2132029040', gid: 'collection_3_2132029040_287_0', slid: '287', creator: '酷乐推荐',
        description: '', songs: [
          { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
          { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
        ],
      } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const searchTab = await waitForText(kgPane, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = kgPane.querySelector('.dsh-music-qq-input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦必听热歌')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const plCard = [...kgPane.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('周杰伦必听热歌'))
    expect(plCard).toBeTruthy()
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const playAllBtn = [...kgPane.querySelectorAll('.dsh-music-qq-playall')].find((b) => b.textContent.includes('播放全部'))
    expect(playAllBtn).toBeTruthy()
    act(() => { playAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 从第一首开始播（酷狗一号 hash=KG1），第一行 active
    expect(audio.src).toContain('/dsh-music/kg/play/KG1')
    const rows = [...kgPane.querySelectorAll('.dsh-music-track-row')]
    expect(rows[0].classList.contains('active')).toBe(true)
    expect(rows[0].textContent).toContain('酷狗一号')
    // 整列表入队：播完自动接第二首（酷狗二号 hash=KG2）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/kg/play/KG2')
  })

  it('酷狗排行榜「播放全部」：从第一首开始播，整列入队自动接下一首', async () => {
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/top-lists') return jsonRes({ ok: true, groups: [{ id: '', name: '热门榜单', toplists: [{ id: '8888', name: '飙升榜', cover: '' }] }] })
      if (u.includes('/dsh-music/kg/top-songs')) {
        const all = [
          { id: 'kg0', hash: '0'.repeat(32), title: '飙升歌一', artists: ['歌手A'], source: 'kugou' },
          { id: 'kg1', hash: '1'.repeat(32), title: '飙升歌二', artists: ['歌手B'], source: 'kugou' },
        ]
        return jsonRes({ ok: true, toplist: { id: '8888', name: '飙升榜', total: all.length, hasMore: false, songs: all } })
      }
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const topsTab = await waitForText(kgPane, '.dsh-music-qq-viewtab', '排行榜')
    act(() => { topsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const chart = [...kgPane.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('飙升榜'))
    act(() => { chart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const playAllBtn = [...kgPane.querySelectorAll('.dsh-music-qq-playall')].find((b) => b.textContent.includes('播放全部'))
    expect(playAllBtn).toBeTruthy()
    act(() => { playAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 从第一首开始播（飙升歌一 hash=全0），第一行 active
    expect(audio.src).toContain('/dsh-music/kg/play/' + '0'.repeat(32))
    const rows = [...kgPane.querySelectorAll('.dsh-music-track-row')]
    expect(rows[0].classList.contains('active')).toBe(true)
    expect(rows[0].textContent).toContain('飙升歌一')
    // 整列入队：自动接下一首（飙升歌二 hash=全1）
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/kg/play/' + '1'.repeat(32))
  })

  it('remembers search keywords and lets you pick one from the dropdown', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    // type and search → keyword saved to history
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the keyword is persisted to the Host (flushed on the ~800ms debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-history'])).toContain('周杰伦')
    // focus the input again → history dropdown appears with the keyword
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '周杰伦')).toBe(true)
    // regression: the dropdown must be portaled + fixed (it would be clipped by
    // the panel's overflow:hidden otherwise — jsdom doesn't lay out CSS, so the
    // fixed positioning is what guarantees it escapes the clip in a real browser)
    const histPop = document.querySelector('.dsh-music-qq-hist')
    expect(histPop).toBeTruthy()
    expect(histPop.style.position).toBe('fixed')
    expect(histPop.style.top).toBeTruthy()
    expect(histPop.style.width).toBeTruthy()
    // clicking a history item fills the box and runs a new search
    const item = histItems.find((b) => b.textContent === '周杰伦')
    act(() => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('晴天')
    // regression: clicking the portaled dropdown must NOT close the panel (the
    // panel's outside-click handler treats portaled popups as "inside")
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl).toBeTruthy()
    expect(panelEl.style.display).not.toBe('none')
  })

  it('does NOT close the panel when clicking a portaled popup (history/TOC/mode/volume)', async () => {
    // Regression: popups are portaled to <body> (to escape the panel's
    // overflow:hidden clip), so a click on them is technically outside the
    // panel DOM. The panel's outside-click handler must treat these as "inside".
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const panelEl = container.querySelector('.dsh-music-panel')
    expect(panelEl.style.display).not.toBe('none')
    // baseline: a mousedown truly outside (document.body) closes the panel
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(panelEl.style.display).toBe('none')
    // reopen, then mousedown inside portaled popups appended to <body> must NOT close it
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const overlays = ['dsh-music-qq-hist', 'dsh-music-toc', 'dsh-music-mode-pop', 'dsh-music-bar-vol-pop', 'dsh-music-picker-overlay', 'dsh-music-add-pop']
    for (const cls of overlays) {
      const pop = document.createElement('div')
      pop.className = cls
      document.body.appendChild(pop)
      act(() => { pop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
      expect(panelEl.style.display).not.toBe('none')
      pop.remove()
    }
  })

  it('browses QQ playlists (recommend -> detail -> category)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单 for the browse flow
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // recommended playlists render straight in the online view
    expect(container.textContent).toContain('热门推荐')
    const recRow = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    expect(recRow).toBeTruthy()
    act(() => { recRow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('告白气球')
    // back -> 分类歌单 browse tab -> category chips -> category playlists
    const back = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '← 返回')
    act(() => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const categoryTab = await waitForText(container, '.dsh-music-qq-viewtab', '分类歌单')
    expect(categoryTab).toBeTruthy()
    act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('国语')
    const catChip = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '国语')
    act(() => { catChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('国语歌单')
  })

  it('loads more QQ 排行榜 songs via the 加载更多 button (append + hasMore)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 切到 排行榜 → 点「飙升榜」进入详情
    const topsTab = await waitForText(container, '.dsh-music-qq-viewtab', '排行榜')
    act(() => { topsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升榜')
    const card = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('飙升榜'))
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 第一页：2 首 + 总数 5 + 还有更多
    expect(container.textContent).toContain('飙升歌一')
    expect(container.textContent).toContain('飙升歌二')
    expect(container.textContent).toContain('2 / 5 首')
    const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
    expect(moreBtn).toBeTruthy()
    // 点加载更多 → 追加下一页
    act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升歌三')
    expect(container.textContent).toContain('飙升歌四')
    expect(container.textContent).toContain('4 / 5 首')
    // 再点 → 最后一首，hasMore=false 后按钮消失
    const moreBtn2 = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
    act(() => { moreBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升歌五')
    expect(container.textContent).toContain('5 / 5 首')
    expect([...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].some((b) => b.textContent === '加载更多')).toBe(false)
  })

  it('loads more KG 排行榜 songs via the 加载更多 button (append + hasMore)', async () => {
    // UI 层回归：排行榜详情顶部已渲染「加载更多」按钮（gated on topHasMore），
    // 旧代码因 host 端 total 塌成当前页长度（见 kugou-toplist.test.js）导致
    // topHasMore 恒 false，按钮永不出现。这里用正确 total=5 验证按钮出现、
    // 点击追加下一页、末页后消失。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/top-lists') return jsonRes({ ok: true, groups: [{ id: '', name: '热门榜单', toplists: [{ id: '8888', name: '飙升榜', cover: '' }] }] })
      if (u.includes('/dsh-music/kg/top-songs')) {
        const offset = parseInt(new URL('http://x' + u).searchParams.get('offset') || '0', 10)
        const all = ['飙升歌一', '飙升歌二', '飙升歌三', '飙升歌四', '飙升歌五']
        const page = all.slice(offset, offset + 2).map((title, i) => ({ id: 'kg' + (offset + i), hash: String(offset + i).padStart(32, '0'), title, artists: ['歌手'], source: 'kugou' }))
        return jsonRes({ ok: true, toplist: { id: '8888', name: '飙升榜', total: all.length, hasMore: offset + page.length < all.length, songs: page } })
      }
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const topsTab = await waitForText(container, '.dsh-music-qq-viewtab', '排行榜')
    act(() => { topsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升榜')
    const card = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('飙升榜'))
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 第一页：2 首 + 总数 5 + 出现「加载更多」
    expect(container.textContent).toContain('飙升歌一')
    expect(container.textContent).toContain('飙升歌二')
    expect(container.textContent).toContain('2 / 5 首')
    const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
    expect(moreBtn).toBeTruthy()
    // 点加载更多 → 追加下一页
    act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升歌三')
    expect(container.textContent).toContain('飙升歌四')
    expect(container.textContent).toContain('4 / 5 首')
    // 再点 → 最后一首，hasMore=false 后按钮消失
    const moreBtn2 = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
    expect(moreBtn2).toBeTruthy()
    act(() => { moreBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('飙升歌五')
    expect(container.textContent).toContain('5 / 5 首')
    expect([...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].some((b) => b.textContent === '加载更多')).toBe(false)
  })

  it('loads more recommended playlists via the 加载更多 button (deduped append)', async () => {
    qqLoggedIn = true
    // category 页返回不同的歌单（每次翻页返回 catN），用于验证追加。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u).includes('/dsh-music/qq/playlists?category=10000000')) {
        const page = parseInt(new URL(String(u), 'http://x').searchParams.get('page') || '1', 10)
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [{ id: 'more' + page, name: '更多歌单' + page, creator: '作者', trackCount: 20, source: 'qq' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 默认 tab 是 我的歌单 → 切到 推荐歌单
      const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('热门推荐')
      // 点「加载更多」→ 追加 more2
      const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
      expect(moreBtn).toBeTruthy()
      act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('更多歌单2')
    } finally {
      window.fetch = origFetch
    }
  })

  it('loads more playlists in 分类歌单 via the 加载更多 button', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u).includes('/dsh-music/qq/playlists?category=1')) {
        const page = parseInt(new URL(String(u), 'http://x').searchParams.get('page') || '1', 10)
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [{ id: 'catmore' + page, name: '分类更多' + page, creator: '作者', trackCount: 20, source: 'qq' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const categoryTab = await waitForText(container, '.dsh-music-qq-viewtab', '分类歌单')
      act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const catChip = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '国语')
      act(() => { catChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
      expect(moreBtn).toBeTruthy()
      act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('分类更多2')
    } finally {
      window.fetch = origFetch
    }
  })

  it('adds a QQ song to a my-playlist via the per-row + button popup', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    const favCalls = []
    window.fetch = (u, o) => {
      const url = String(u)
      if (url === '/dsh-music/qq/playlist-add' && o && o.method === 'POST') {
        try { favCalls.push(JSON.parse(o.body || '{}')) } catch {}
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '晴天')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 歌曲行尾部有「＋」按钮
      const songRow = [...container.querySelectorAll('.dsh-music-track-row')].find((r) => r.textContent.includes('晴天'))
      const plusBtn = songRow && songRow.querySelector('.dsh-music-playlist-mini.add')
      expect(plusBtn).toBeTruthy()
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 弹出「我的歌单」列表（弹窗 portal 到 body）
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('我的收藏'))
      expect(popItem).toBeTruthy()
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 触发加入请求
      expect(favCalls.length).toBe(1)
      expect(favCalls[0].song.songmid).toBe('123')
      expect(favCalls[0].dirId).toBeTruthy()
    } finally {
      window.fetch = origFetch
    }
  })

  it('shows a centered success toast when adding a local track to a playlist via ＋', async () => {
    // 「＋」→ 加入歌单 → 成功：面板窗口内居中显示「添加到XXX成功」，2s 后自动消失
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/playlist/add' && o && o.method === 'POST') {
        return jsonRes({ ok: true, added: 1, playlist: { id: 'pl-1', name: '通勤', count: 2, tracks: [] } })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 曲库每行的「＋」按钮
      const plusBtn = container.querySelector('.dsh-music-track-row .dsh-music-playlist-mini.add')
      expect(plusBtn).toBeTruthy()
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 弹窗列出歌单（含「通勤」）
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('通勤'))
      expect(popItem).toBeTruthy()
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 成功 toast：面板窗口内居中（.ok），文本=添加到通勤成功
      const toast = container.querySelector('.dsh-music-panel-toast')
      expect(toast).toBeTruthy()
      expect(toast.className).toContain('ok')
      expect(toast.textContent).toBe('添加到通勤成功')
      // 2s 后自动消失
      await act(async () => { await new Promise((r) => setTimeout(r, 2100)) })
      expect(container.querySelector('.dsh-music-panel-toast')).toBeNull()
    } finally {
      window.fetch = origFetch
    }
  })

  it('shows a centered failure toast and keeps the menu open when adding a local track fails', async () => {
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/playlist/add' && o && o.method === 'POST') {
        return jsonRes({ ok: false, error: '歌单不存在' })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const plusBtn = container.querySelector('.dsh-music-track-row .dsh-music-playlist-mini.add')
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('通勤'))
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const toast = container.querySelector('.dsh-music-panel-toast')
      expect(toast).toBeTruthy()
      expect(toast.className).toContain('err')
      expect(toast.textContent).toBe('添加到通勤失败')
      // 失败时加入弹窗保留（可换歌单重试）
      expect([...document.body.querySelectorAll('.dsh-music-add-pop-item')].some((b) => b.textContent.includes('通勤'))).toBe(true)
    } finally {
      window.fetch = origFetch
    }
  })

  it('shows a centered success toast when adding a QQ song to 我的歌单 via ＋', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/qq/playlist-add' && o && o.method === 'POST') {
        return jsonRes({ ok: true })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '晴天')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const songRow = [...container.querySelectorAll('.dsh-music-track-row')].find((r) => r.textContent.includes('晴天'))
      const plusBtn = songRow && songRow.querySelector('.dsh-music-playlist-mini.add')
      expect(plusBtn).toBeTruthy()
      act(() => { plusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 「我的歌单」自动加载 → 弹窗列出「我的收藏」
      const popItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('我的收藏'))
      expect(popItem).toBeTruthy()
      act(() => { popItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const toast = container.querySelector('.dsh-music-panel-toast')
      expect(toast).toBeTruthy()
      expect(toast.className).toContain('ok')
      expect(toast.textContent).toBe('添加到我的收藏成功')
    } finally {
      window.fetch = origFetch
    }
  })

  it('collapses and expands the category chips in 分类歌单', async () => {
    qqLoggedIn = true
    const origFetch = window.fetch
    const manyCats = Array.from({ length: 12 }, (_, i) => ({ id: 'c' + i, name: '分类' + i, group: '测试' }))
    window.fetch = (u, o) => {
      if (String(u).includes('/dsh-music/qq/playlist-categories')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, categories: manyCats }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      if (String(u).includes('/dsh-music/qq/playlists?category=')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const categoryTab = await waitForText(container, '.dsh-music-qq-viewtab', '分类歌单')
      act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 折叠态：只显示 8 个分类，且出现「展开全部分类」按钮
      expect(container.querySelectorAll('.dsh-music-qq-cat').length).toBe(8)
      const toggle = [...container.querySelectorAll('.dsh-music-qq-cat-toggle')].find((b) => b.textContent.includes('展开全部分类'))
      expect(toggle).toBeTruthy()
      act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 展开态：全部 12 个分类，出现「收起」
      expect(container.querySelectorAll('.dsh-music-qq-cat').length).toBe(12)
      const collapse = [...container.querySelectorAll('.dsh-music-qq-cat-toggle')].find((b) => b.textContent === '收起')
      expect(collapse).toBeTruthy()
      act(() => { collapse.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.querySelectorAll('.dsh-music-qq-cat').length).toBe(8)
    } finally {
      window.fetch = origFetch
    }
  })

  it('enters the playlist layer via 播放列表, shows a back button, and persists the layer', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放列表（无在线播放，显示空提示）→ 第 2 层
    const plBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    expect(plBtn).toBeTruthy()
    act(() => { plBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const back = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '← 返回')
    expect(back).toBeTruthy()
    expect(container.textContent).toContain('暂无歌曲')
    // the panel layer is persisted to the Host (flushed on the ~800ms debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('playlist')
    // 返回主 UI
    act(() => { back.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('推荐歌单')
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('main')
  })

  it('QQ 播放列表进入时定位到正在播放的曲目（scrollIntoView 命中 active 行）', async () => {
    qqLoggedIn = true
    // jsdom 无 scrollIntoView：spy 它，验证播放列表层时会把正在播放的 active 行滚到可见。
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 推荐歌单 → 打开「热门推荐」歌单（详情 mock 返回 告白气球 + 七里香 两首）
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const card = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放第二首（七里香）——让 active 行不是列表第一行，才能证明滚动到了它。
    const second = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('七里香'))
    act(() => { second.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('七里香')
    // 播放列表层应显示两首歌，其中正在播放的 七里香 是 active 行
    const activeRows = [...container.querySelectorAll('.dsh-music-track-row.active')]
    expect(activeRows.length).toBe(1)
    expect(activeRows[0].textContent).toContain('七里香')
    // scrollIntoView 必须被调用在 active 行上（证明播放列表层时定位到正在播放位置）
    const targets = scrollSpy.mock.instances.filter((el) =>
      el && el.classList && el.classList.contains('dsh-music-track-row') && el.classList.contains('active'))
    expect(targets.length).toBeGreaterThan(0)
  })

  it('shows a 音乐来源 (QQ音乐) badge on the bar when playing an online track', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // the bar should mark the source as QQ音乐 after the track name
    expect(container.textContent).toContain('QQ音乐')
    // and show the artist name next to the title
    expect(container.textContent).toContain('周杰伦')
  })

  it('shows the QQ quality tier inside the QQ音乐 badge when the play stream reports it', async () => {
    // 真实品质：Host 随 /qq/play 响应回传 X-DSH-QQ-Quality 头（percent-encoded），
    // 客户端用轻量 HEAD 立即读取，拼进播放条徽标（「QQ音乐 · 无损」）；没取到则只显示「QQ音乐」。
    qqLoggedIn = true
    const headStub = async (url, opts) => {
      const u = String(url)
      const o = opts || {}
      if (u.startsWith('/dsh-music/qq/play/') && o.method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-QQ-Quality' ? encodeURIComponent('无损') : null } })
      }
      return fetchStub(url, opts)
    }
    vi.stubGlobal('fetch', headStub)
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 徽标带品质标签：QQ音乐 · 无损
      expect(container.textContent).toContain('QQ音乐 · 无损')
      // 本地/讲书等其他来源不受影响，不会出现品质标签
      expect(container.textContent).not.toContain('QQ音乐 · 高音质')
    } finally {
      vi.unstubAllGlobals()
      document.body.innerHTML = ''
    }
  })

  it('re-fetches the quality via HEAD when clicking 下一首 (startPlay path)', async () => {
    // Regression: 切歌/自动续播走 step → startPlay（通用路径，不走 startQQPlayback），
    // 必须在 startPlay 里也触发 HEAD，否则下一首的品质标签不会出现。
    qqLoggedIn = true
    const headLog = []
    const headStub = async (url, opts) => {
      const u = String(url)
      const o = opts || {}
      if (u.startsWith('/dsh-music/qq/play/') && o.method === 'HEAD') {
        headLog.push(u)
        return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-QQ-Quality' ? encodeURIComponent('无损') : null } })
      }
      return fetchStub(url, opts)
    }
    vi.stubGlobal('fetch', headStub)
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('QQ音乐 · 无损')
      // 点「下一首」→ step → startPlay → 应为下一首(790) 再发一次 HEAD
      const nextBtn = container.querySelector('button[title="下一首"]')
      act(() => { nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(headLog).toContain('/dsh-music/qq/play/790')
      // 下一首的品质标签也应显示
      expect(container.textContent).toContain('QQ音乐 · 无损')
    } finally {
      vi.unstubAllGlobals()
      document.body.innerHTML = ''
    }
  })

  it('shows the KG quality tier via startPlay/下一首 (HEAD re-probe)', async () => {
    // Regression: KG 曲目经 startPlay（自动续播/上下曲）与刷新恢复续播时原本不发
    // HEAD 探测，音质徽章只显示「酷狗音乐」；startPlay 必须补一次 HEAD（与 QQ 同款）。
    const baseFetch = fetchStub
    const headLog = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      const o = opts || {}
      if (u.startsWith('/dsh-music/kg/play/') && o.method === 'HEAD') {
        headLog.push(u)
        return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-KG-Quality' ? encodeURIComponent('无损') : null } })
      }
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [{ id: 'p1', name: '我的酷狗歌单', creator: '我', trackCount: 2, source: 'kugou', cover: '' }] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
        { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
      ] } })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const plCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的酷狗歌单'))
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('酷狗一号'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 直接点歌 → startKGPlayback → HEAD 探测 → 徽标带品质标签
    expect(container.textContent).toContain('酷狗音乐 · 无损')
    // 点「下一首」→ step → startPlay（通用路径）→ 必须为 KG2 再发一次 HEAD
    const nextBtn = container.querySelector('button[title="下一首"]')
    act(() => { nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(headLog).toContain('/dsh-music/kg/play/KG2')
    expect(container.textContent).toContain('酷狗音乐 · 无损')
  })

  it('网易云播放条只显示一个「网易云 · 无损」来源徽章（不重复叠加品质芯片）', async () => {
    // Regression: sourceBadge（网易云 + 品质）与 localQualityBadge（仅品质）渲染条件都
    // 看 currentQuality —— 后者漏排除 nc: 前缀时同一品质被渲染两次（「网易云 · 无损」+「无损」），
    // QQ/KG 无此问题（qq:/kg: 都在排除列表）。修复后 nc 只走来源徽章、品质拼在来源名后。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      const o = opts || {}
      if (u === '/dsh-music/nc/status') return jsonRes({ loggedIn: true, nickname: '测试用户' })
      if (u === '/dsh-music/nc/my-playlists') {
        return jsonRes({ ok: true, playlists: [
          { id: 'ncp1', name: '我的网易云歌单', creator: '测试用户', trackCount: 1, source: 'nc' },
        ] })
      }
      if (u.startsWith('/dsh-music/nc/playlist/')) {
        return jsonRes({ ok: true, playlist: { id: 'ncp1', name: '我的网易云歌单', creator: '测试用户', trackCount: 1, source: 'nc', songs: [
          { id: 'NC1', title: '网易一号', artists: ['歌手A'], fee: 0, source: 'nc' },
        ] } })
      }
      // 取链流地址的 HEAD 探测：回传真实品质「无损」（与 Host X-DSH-NC-Quality 一致）
      if (u.startsWith('/dsh-music/nc/play/') && o.method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-NC-Quality' ? encodeURIComponent('无损') : null } })
      }
      if (u.startsWith('/dsh-music/nc/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/nc/lyric')) return jsonRes({ ok: true, hasLyric: false, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ncTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网易云')
    act(() => { ncTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 登录后默认「我的歌单」→ 等「我的网易云歌单」卡片出现（/nc/my-playlists 异步）
    let card = null
    for (let i = 0; i < 50 && !card; i++) {
      card = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的网易云歌单'))
      if (!card) await new Promise((r) => setTimeout(r, 10))
    }
    expect(card).toBeTruthy()
    act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 详情加载歌曲（/nc/playlist/ncp1）→ 点歌播放（startNCPlayback → loadNCQuality HEAD）
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('网易一号'))
    expect(song).toBeTruthy()
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放条只应有一个来源徽章，且品质拼在来源名后（不出现第二个裸品质芯片）
    const badges = [...container.querySelectorAll('.dsh-music-bar-src')]
    expect(badges.length).toBe(1)
    expect(badges[0].textContent).toBe('网易云 · 无损')
    expect(badges[0].textContent).not.toBe('无损')
    // 通篇不再出现重复的裸品质（textContent 层面也不会出现两个「无损」token 叠在徽章区）
    expect(container.textContent).toContain('网易云 · 无损')
  })

  it('取消收藏网易云收藏歌单：点 ☆ → 确认框 → POST playlist-collect(uncollect) → 从列表移除', async () => {
    // 对齐酷狗 mine 卡片：收藏的歌单（kind=collect）在「我的歌单」卡片右上角显示
    // 「☆ 取消收藏」，点它弹确认框，确认后调 /dsh-music/nc/playlist-collect
    // action=uncollect（该写接口经 weapi 主路 + 真实 __csrf 已实测可用），成功后本地移除。
    const baseFetch = fetchStub
    const uncollectCalls = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/nc/status') return jsonRes({ loggedIn: true, nickname: '测试用户' })
      if (u === '/dsh-music/nc/my-playlists') {
        return jsonRes({ ok: true, playlists: [
          { id: '2879349020', name: '收藏的华语歌单', kind: 'collect', creator: '别人', trackCount: 120, source: 'nc' },
          { id: 'ncp2', name: '我的自建歌单', kind: 'own', creator: '测试用户', trackCount: 2, source: 'nc' },
        ] })
      }
      if (u === '/dsh-music/nc/playlist-collect' && o.method === 'POST') {
        try { uncollectCalls.push(JSON.parse(o.body || '{}')) } catch {}
        return jsonRes({ ok: true, action: 'uncollect', id: '2879349020' })
      }
      if (u.startsWith('/dsh-music/nc/playlist/')) return jsonRes({ ok: true, playlist: { songs: [] } })
      if (u.startsWith('/dsh-music/nc/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/nc/lyric')) return jsonRes({ ok: true, hasLyric: false, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ncTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网易云')
    act(() => { ncTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 等「我的歌单」卡片渲染（/nc/my-playlists 异步）
    let colCard = null
    for (let i = 0; i < 50 && !colCard; i++) {
      colCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('收藏的华语歌单'))
      if (!colCard) await new Promise((r) => setTimeout(r, 10))
    }
    expect(colCard).toBeTruthy()
    // 收藏歌单卡片：标「收藏」、展示原作者、右上角有 ☆ 取消收藏按钮
    expect(colCard.textContent).toContain('收藏')
    expect(colCard.textContent).toContain('别人')
    const colDel = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('收藏的华语歌单'))
    expect(colDel).toBeTruthy()
    expect(colDel.title).toContain('取消收藏歌单')
    expect(colDel.textContent).toBe('☆')
    expect(colDel.className).toContain('uncollect')
    // 自建歌单（kind=own）右上角是「✕ 删除」（非 uncollect，删除自建歌单入口）
    const ownDel = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('我的自建歌单'))
    expect(ownDel).toBeTruthy()
    expect(ownDel.title).toContain('删除歌单')
    expect(ownDel.textContent).toBe('✕')
    expect(ownDel.className).not.toContain('uncollect')
    // 「我喜欢」（isLike）无任何删除按钮（系统默认歌单）
    const likeDel = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('我喜欢的音乐'))
    expect(likeDel).toBeFalsy()
    // 点 ☆ → 弹自定义确认框
    act(() => { colDel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const confirmBox = document.querySelector('.dsh-music-picker.confirm')
    expect(confirmBox).toBeTruthy()
    expect(confirmBox.textContent).toContain('取消收藏')
    expect(confirmBox.textContent).toContain('收藏的华语歌单')
    const okBtn = confirmBox.querySelector('.dsh-music-settings-btn.danger')
    expect(okBtn.textContent).toBe('取消收藏')
    act(() => { okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // POST action=uncollect + 从列表移除（收藏歌单消失、自建歌单仍在）
    expect(uncollectCalls.length).toBe(1)
    expect(uncollectCalls[0].action).toBe('uncollect')
    expect(String(uncollectCalls[0].id)).toBe('2879349020')
    expect([...container.querySelectorAll('.dsh-music-playlist-card')].find((c) => c.textContent.includes('收藏的华语歌单'))).toBeFalsy()
    expect([...container.querySelectorAll('.dsh-music-playlist-card')].find((c) => c.textContent.includes('我的自建歌单'))).toBeTruthy()
  })

  it('网易云自建歌单：歌曲行「＋」加入歌单（弹窗选已有/新建）、mine「−」移除、卡片「✕」删除', async () => {
    // 对齐 QQ/酷狗：非 mine 歌曲行「＋」→ 弹窗（我的歌单 + 新建）；mine 歌单详情行「−」
    // 移除；mine 自建歌单卡片右上角「✕」删除（需确认）。后端走 weapi create/manipulate/delete。
    const baseFetch = fetchStub
    const calls = { add: [], create: [], del: [], remove: [] }
    let minePlaysServer = [
      // 首个 = 我喜欢的音乐（系统默认），其余自建/收藏
      { id: '11001', name: '我喜欢的音乐', isLike: true, kind: 'default', creator: '', trackCount: 1, source: 'nc' },
      { id: '22001', name: '我的自建歌单', kind: 'own', creator: '我', trackCount: 2, source: 'nc' },
      { id: '33001', name: '收藏的别人的歌单', kind: 'collect', creator: '别人', trackCount: 3, source: 'nc' },
    ]
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/nc/status') return jsonRes({ loggedIn: true, nickname: '我' })
      if (u === '/dsh-music/nc/my-playlists') return jsonRes({ ok: true, playlists: minePlaysServer })
      if (u === '/dsh-music/nc/playlists') return jsonRes({ ok: true, playlists: [
        { id: 'rec1', name: '推荐歌单', creator: '网易云', trackCount: 1, source: 'nc' },
      ] })
      // mine 歌单详情：自建歌单 own1 有 2 首（我喜欢 like1 同样返回供「−」移除验证）
      if (u.startsWith('/dsh-music/nc/playlist/22001') || u.startsWith('/dsh-music/nc/playlist/11001')) {
        return jsonRes({ ok: true, playlist: { id: u.includes('11001') ? '11001' : '22001', name: u.includes('11001') ? '我喜欢的音乐' : '我的自建歌单', creator: u.includes('11001') ? '' : '我', trackCount: 2, songs: [
          { id: 's1', title: '歌单里的一', artists: ['A'], fee: 0, source: 'nc' },
          { id: 's2', title: '歌单里的二', artists: ['B'], fee: 0, source: 'nc' },
        ] } })
      }
      // 公开（推荐）歌单详情
      if (u.startsWith('/dsh-music/nc/playlist/rec1')) {
        return jsonRes({ ok: true, playlist: { id: 'rec1', name: '推荐歌单', creator: '网易云', trackCount: 1, songs: [
          { id: 's9', title: '公开歌单的歌曲', artists: ['C'], fee: 0, source: 'nc' },
        ] } })
      }
      if (u.startsWith('/dsh-music/nc/playlist/')) return jsonRes({ ok: true, playlist: { songs: [] } })
      if (u === '/dsh-music/nc/playlist-add' && o.method === 'POST') {
        try { calls.add.push(JSON.parse(o.body || '{}')) } catch {}
        return jsonRes({ ok: true })
      }
      if (u === '/dsh-music/nc/playlist-create' && o.method === 'POST') {
        try { calls.create.push(JSON.parse(o.body || '{}')) } catch {}
        const name = JSON.parse(o.body || '{}').name
        const created = { id: '44001', name, kind: 'own', trackCount: 0, source: 'nc' }
        minePlaysServer = [...minePlaysServer, created]
        return jsonRes({ ok: true, playlist: created })
      }
      if (u === '/dsh-music/nc/playlist-delete' && o.method === 'POST') {
        try { calls.del.push(JSON.parse(o.body || '{}')) } catch {}
        const id = JSON.parse(o.body || '{}').id
        minePlaysServer = minePlaysServer.filter((p) => String(p.id) !== String(id))
        return jsonRes({ ok: true })
      }
      if (u === '/dsh-music/nc/playlist-remove' && o.method === 'POST') {
        try { calls.remove.push(JSON.parse(o.body || '{}')) } catch {}
        return jsonRes({ ok: true })
      }
      if (u.startsWith('/dsh-music/nc/lyric')) return jsonRes({ ok: true, hasLyric: false, lrc: [], wordLines: [] })
      if (u.startsWith('/dsh-music/nc/play/')) return jsonRes({ ok: true })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ncTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网易云')
    act(() => { ncTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 登录后默认「我的歌单」：三张卡（我喜欢无按钮 / 自建 ✕ / 收藏 ☆）
    let mineCard = null
    for (let i = 0; i < 50 && !mineCard; i++) {
      mineCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的自建歌单'))
      if (!mineCard) await new Promise((r) => setTimeout(r, 10))
    }
    expect(mineCard).toBeTruthy()
    // mine 卡片类别徽章（对齐 QQ/酷狗）：我喜欢=「默认」(default)、自建=「自建」、收藏=「收藏」(collect)，均带语义 title
    const likeCardB = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我喜欢的音乐'))
    const ownCardB = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的自建歌单'))
    const colCardB = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('收藏的别人的歌单'))
    const likeTag = likeCardB && likeCardB.querySelector('.dsh-music-online-tag')
    const ownTag = ownCardB && ownCardB.querySelector('.dsh-music-online-tag')
    const colTag = colCardB && colCardB.querySelector('.dsh-music-online-tag')
    expect(likeTag).toBeTruthy()
    expect(likeTag.textContent).toBe('默认')
    expect(likeTag.className).toContain('default')
    expect(likeTag.title).toContain('系统默认歌单')
    expect(ownTag).toBeTruthy()
    expect(ownTag.textContent).toBe('自建')
    expect(ownTag.className).not.toContain('default')
    expect(ownTag.className).not.toContain('collect')
    expect(ownTag.title).toContain('自己创建的歌单')
    expect(colTag).toBeTruthy()
    expect(colTag.textContent).toBe('收藏')
    expect(colTag.className).toContain('collect')
    expect(colTag.title).toContain('收藏的歌单')
    // ① mine 自建歌单 ✕ 删除（确认框 → POST delete → 卡片移除）
    const ownDel = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('我的自建歌单'))
    expect(ownDel).toBeTruthy()
    expect(ownDel.title).toContain('删除歌单')
    expect(ownDel.className).not.toContain('uncollect')
    act(() => { ownDel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const confirmBox = document.querySelector('.dsh-music-picker.confirm')
    expect(confirmBox).toBeTruthy()
    const delBtn = confirmBox.querySelector('.dsh-music-settings-btn.danger')
    act(() => { delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(calls.del.length).toBe(1)
    expect(String(calls.del[0].id)).toBe('22001')
    // ② 公开（推荐）歌单详情里歌曲行有「＋」加入歌单
    const recTabBtn = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
    act(() => { recTabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    let recCard = null
    for (let i = 0; i < 50 && !recCard; i++) {
      recCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('推荐歌单'))
      if (!recCard) await new Promise((r) => setTimeout(r, 10))
    }
    act(() => { recCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row9 = [...container.querySelectorAll('.dsh-music-track-row')].find((r) => r.textContent.includes('公开歌单的歌曲'))
    expect(row9).toBeTruthy()
    const plus9 = row9.querySelector('.dsh-music-playlist-mini.add')
    expect(plus9).toBeTruthy()
    // ③ 点「＋」→ 弹窗只列可加入的歌单（收藏歌单是别人的，不可加歌，需排除）→ 点「我喜欢的音乐」
    act(() => { plus9.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    let popLike = null
    for (let i = 0; i < 50 && !popLike; i++) {
      popLike = [...document.body.querySelectorAll('.dsh-music-add-pop-item')].find((b) => b.textContent.includes('我喜欢的音乐'))
      if (!popLike) await new Promise((r) => setTimeout(r, 10))
    }
    expect(popLike).toBeTruthy()
    // 弹窗里不得出现收藏的别人的歌单（kind=collect）
    const popItems = [...document.body.querySelectorAll('.dsh-music-add-pop-item')]
    expect(popItems.some((b) => b.textContent.includes('收藏的别人的歌单'))).toBe(false)
    act(() => { popLike.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(calls.add.length).toBe(1)
    expect(String(calls.add[0].id)).toBe('11001')
    expect(calls.add[0].songIds).toEqual(['s9'])
    // ④ 重新点「＋」→ 弹窗「＋ 新建歌单」→ prompt 输入名字 → POST create + add
    const plus9b = [...container.querySelectorAll('.dsh-music-playlist-mini.add')].find((b) => b.title === '加入我的歌单')
    act(() => { plus9b.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const newItem = [...document.body.querySelectorAll('.dsh-music-add-pop-item.new')].find((b) => b.textContent.includes('新建歌单'))
    expect(newItem).toBeTruthy()
    act(() => { newItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const promptBox = document.querySelector('.dsh-music-picker.prompt')
    expect(promptBox).toBeTruthy()
    const input = promptBox.querySelector('.dsh-music-prompt-input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '新建网易云歌单')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const okBtn2 = [...promptBox.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '确定')
    act(() => { okBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(calls.create.length).toBe(1)
    expect(calls.create[0].name).toBe('新建网易云歌单')
    expect(calls.add.length).toBe(2)
    expect(String(calls.add[1].id)).toBe('44001')
    expect(calls.add[1].songIds).toEqual(['s9'])
    // ⑤ mine 详情（我的歌单 → 点开「收藏的别人的歌单」→ 歌曲行是「−」？收藏歌单 mine 详情不应有 − → 改点「我喜欢的音乐」）
    //    用「我喜欢的音乐」mine 详情验证「−」移除（=取消收藏该歌）
    const backBtn = [...container.querySelectorAll('.dsh-music-settings-btn.ghost')].find((b) => b.textContent === '← 返回')
    act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 回「我的歌单」tab
    const mineTabBtn = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '我的歌单')
    act(() => { mineTabBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const likeCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我喜欢的音乐'))
    expect(likeCard).toBeTruthy()
    act(() => { likeCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const rowM = [...container.querySelectorAll('.dsh-music-track-row')].find((r) => r.textContent.includes('歌单里的一'))
    expect(rowM).toBeTruthy()
    const minusBtn = rowM.querySelector('.dsh-music-playlist-mini.remove')
    expect(minusBtn).toBeTruthy()
    expect(minusBtn.title).toContain('移除')
    act(() => { minusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(calls.remove.length).toBe(1)
    expect(String(calls.remove[0].id)).toBe('11001')
    expect(calls.remove[0].songIds).toEqual(['s1'])
  })

  it('网易云推荐歌单「加载更多」：续载「全部」分类分页并去重追加', async () => {
    // 官方推荐接口（/weapi/personalized/playlist）一次 30 条、不支持翻页（offset 无效）。
    // 推荐 tab 的「加载更多」续载「全部」分类（cat=全部）的 hot 分页歌单，与已展示的
    // 推荐去重后追加（对齐 QQ「热门推荐 + 全部分类续页」）。未登录默认落在推荐 tab。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      const o = opts || {}
      // 登录（面板门禁与 QQ/酷狗一致：未登录只显示登录入口，浏览/搜索需登录后）
      if (u === '/dsh-music/nc/status') return jsonRes({ loggedIn: true, nickname: '测试用户' })
      if (u === '/dsh-music/nc/my-playlists') return jsonRes({ ok: true, playlists: [] })
      // 初始推荐（无 category 参数）：一批推荐歌单
      if (u === '/dsh-music/nc/playlists') {
        return jsonRes({ ok: true, playlists: [
          { id: 'rec1', name: '官方推荐一', creator: '网易云', trackCount: 30, source: 'nc' },
        ] })
      }
      // 「加载更多」→ cat=全部 的分页（每页 20 条满页，模拟真实接口还有更多）
      if (u.includes('/dsh-music/nc/playlists?category=')) {
        const page = parseInt(new URL('http://x' + u).searchParams.get('page') || '1', 10)
        const pagePlays = Array.from({ length: 20 }, (_, i) => ({
          id: 'all' + page + '-' + i, name: '全部分类更多' + page + '-' + (i + 1),
          creator: '用户', trackCount: 20, source: 'nc',
        }))
        return jsonRes({ ok: true, playlists: pagePlays })
      }
      if (u.startsWith('/dsh-music/nc/playlist/')) return jsonRes({ ok: true, playlist: { songs: [] } })
      if (u.startsWith('/dsh-music/nc/lyric')) return jsonRes({ ok: true, hasLyric: false, lrc: [], wordLines: [] })
      void o
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ncTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网易云')
    act(() => { ncTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 登录后默认「我的歌单」→ 切到「推荐歌单」tab（触发加载）
    let recTab = null
    for (let i = 0; i < 50 && !recTab; i++) {
      recTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '推荐歌单')
      if (!recTab) await new Promise((r) => setTimeout(r, 10))
    }
    expect(recTab).toBeTruthy()
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 等官方推荐卡片出现 + 「加载更多」按钮
    let recCard = null
    for (let i = 0; i < 50 && !recCard; i++) {
      recCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('官方推荐一'))
      if (!recCard) await new Promise((r) => setTimeout(r, 10))
    }
    expect(recCard).toBeTruthy()
    // 推荐 tab 有「加载更多」按钮（对齐分类 tab 的结构）
    let moreBtn = null
    for (let i = 0; i < 50 && !moreBtn; i++) {
      moreBtn = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
      if (!moreBtn) await new Promise((r) => setTimeout(r, 10))
    }
    expect(moreBtn).toBeTruthy()
    // 点「加载更多」→ 追加「全部」分类第 2 页的歌单
    act(() => { moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('全部分类更多2-1')
    // 点第二次 → 第 3 页
    const moreBtn2 = [...container.querySelectorAll('.dsh-music-qq-loadmore-btn')].find((b) => b.textContent === '加载更多')
    act(() => { moreBtn2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('全部分类更多3-1')
    // 官方推荐仍保留（去重追加不丢已有）
    expect(container.textContent).toContain('官方推荐一')
  })

  it('网易云搜索历史：搜索落盘 Host、重启后仍显示、点条目复搜、外点关闭下拉', async () => {
    // 对齐 QQ/酷狗：关键词搜索后写入 dsh-music-nc-history（Host 白名单），重启/刷新后
    // 聚焦搜索框下拉仍显示历史；点条目回填并复搜；点下拉外收起（regression：曾缺外点
    // 关闭 effect，下拉打开后无法靠点击外部收起）。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/nc/status') return jsonRes({ loggedIn: true, nickname: '我' })
      if (u === '/dsh-music/nc/my-playlists') return jsonRes({ ok: true, playlists: [] })
      if (u.includes('/dsh-music/nc/search?w=')) {
        return jsonRes({ ok: true, results: [{ id: 's9', title: '网易歌', artists: ['A'], fee: 0, source: 'nc' }], total: 1 })
      }
      if (u.includes('/dsh-music/nc/playlist-search')) return jsonRes({ ok: true, playlists: [], total: 0 })
      if (u.startsWith('/dsh-music/nc/lyric')) return jsonRes({ ok: true, hasLyric: false, lrc: [], wordLines: [] })
      if (u.startsWith('/dsh-music/nc/play/')) return jsonRes({ ok: true })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ncTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网易云')
    act(() => { ncTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 登录后默认 mine → 切「搜索」tab
    let searchTab = null
    for (let i = 0; i < 50 && !searchTab; i++) {
      searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
      if (!searchTab) await new Promise((r) => setTimeout(r, 10))
    }
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    // 输入并搜索 → 关键词写入历史
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '刀郎')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // debounce flush → Host prefs 里出现 nc-history
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-nc-history'])).toContain('刀郎')
    // 重新聚焦 → 历史下拉出现「刀郎」
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    let histItem = null
    for (let i = 0; i < 50 && !histItem; i++) {
      histItem = [...container.querySelectorAll('.dsh-music-qq-hist-item')].find((b) => b.textContent === '刀郎')
      if (!histItem) await new Promise((r) => setTimeout(r, 10))
    }
    expect(histItem).toBeTruthy()
    // portal 检查（下拉必须逃逸面板 overflow 裁剪）
    const histPop = document.querySelector('.dsh-music-qq-hist')
    expect(histPop).toBeTruthy()
    expect(histPop.style.position).toBe('fixed')
    // 点历史条目 → 回填 + 复搜（结果出现）+ 下拉收起
    act(() => { histItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('网易歌')
    expect(document.querySelector('.dsh-music-qq-hist')).toBeFalsy() // doSearch 已收起下拉
    // 再次聚焦打开下拉 → 点击下拉外（面板其它区域）→ 下拉关闭（外点关闭 effect）
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-qq-hist')).toBeTruthy()
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-qq-hist')).toBeFalsy()
  })

  it('重启恢复网易云搜索历史：Host 预置 nc-history → 聚焦搜索框即显示历史', async () => {
    // 模拟 DSH 重启后：Host prefs 里已有 dsh-music-nc-history（白名单修复后落盘的），
    // 新会话必须能读到并显示在历史下拉（对齐 QQ/KG「刷新后历史仍在」）。
    prefsServer = { 'dsh-music-nc-history': JSON.stringify(['周杰伦', '晴天']) }
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/nc/status') return jsonRes({ loggedIn: true, nickname: '我' })
      if (u === '/dsh-music/nc/my-playlists') return jsonRes({ ok: true, playlists: [] })
      if (u.includes('/dsh-music/nc/search?w=')) return jsonRes({ ok: true, results: [], total: 0 })
      if (u.includes('/dsh-music/nc/playlist-search')) return jsonRes({ ok: true, playlists: [], total: 0 })
      if (u.startsWith('/dsh-music/nc/lyric')) return jsonRes({ ok: true, hasLyric: false, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ncTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '网易云')
    act(() => { ncTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    let searchTab = null
    for (let i = 0; i < 50 && !searchTab; i++) {
      searchTab = [...container.querySelectorAll('.dsh-music-qq-viewtab')].find((b) => b.textContent === '搜索')
      if (!searchTab) await new Promise((r) => setTimeout(r, 10))
    }
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 等 Host 快照就绪（prefsReady 重读历史）后聚焦 → 历史出现
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const items = [...container.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(items.some((b) => b.textContent === '周杰伦')).toBe(true)
    expect(items.some((b) => b.textContent === '晴天')).toBe(true)
    // 清理：关闭历史下拉，避免 portal 到 body 的下拉 DOM 残留污染后续测试的全局查询
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelector('.dsh-music-qq-hist')).toBeFalsy()
  })

  it('酷狗登录已失效（服务端返回 kgLoginDead）→ 面板自动回到扫码登录页并提示重扫', async () => {
    // 服务端在「刷新登录态也遇设备不匹配(20018)」时已自动登出并回 kgLoginDead 标记。
    // 前端 json/kgPost 检测到即复位面板到 !loggedIn，展示「请重新扫码登录」而不是
    // 一直挂着「刷新登录态失败」的报错（用户「播着播着不能播、刷新后 UI 报错」场景）。
    const baseFetch = fetchStub
    const deadErr = '酷狗登录已失效（登录态与设备不匹配），请重新扫码登录'
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: false, error: deadErr, kgLoginDead: true })
      if (u === '/dsh-music/kg/liked') return jsonRes({ ok: false, error: deadErr, kgLoginDead: true })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 多 flush：挂载后 status → loggedIn=true → 触发 refreshMine/refreshKGFavIds →
    // 收到 kgLoginDead → markKgAuthDead → 面板 effect 复位到扫码登录页。
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')][1]
    expect(kgPane.querySelector('.dsh-music-qq-login-dead')).toBeTruthy()
    expect(kgPane.textContent).toContain('请重新扫码登录')
    expect(kgPane.textContent).toContain('酷狗音乐APP登录')
    // 不再处于已登录主界面（无「退出登录」工具栏）
    expect([...kgPane.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '退出登录')).toBe(false)
  })

  it('REGRESSION: 播放酷狗「我喜欢」歌单中的歌曲时，播放条爱心点亮（并可取消收藏）', async () => {
    // 酷狗「我喜欢」（is_def=2）里的歌曲：checkKGFavForCurrent 经 /dsh-music/kg/liked
    // 判断 hash 是否在集合中 → 点亮播放条爱心；再点爱心 → playlist-remove 取消收藏。
    const baseFetch = fetchStub
    const favCalls = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '2', name: '我喜欢', kind: 'own', isDefault: true, isDef: 2, creator: '', trackCount: 1, source: 'kugou', cover: 'data:image/jpeg;base64,xx' },
      ] })
      if (u === '/dsh-music/kg/liked') return jsonRes({ ok: true, listId: 2, hashes: ['KG1'], files: [{ hash: 'KG1', fileId: 7 }] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou', fileId: 7 },
      ] } })
      if (u.startsWith('/dsh-music/kg/play/') && o.method === 'HEAD') return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-KG-Quality' ? encodeURIComponent('无损') : null } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if ((u === '/dsh-music/kg/playlist-remove' || u === '/dsh-music/kg/playlist-add') && o.method === 'POST') {
        try { favCalls.push({ url: u, body: JSON.parse(o.body || '{}') }) } catch {}
        return jsonRes({ ok: true })
      }
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 我的歌单 → 打开「我喜欢」歌单 → 点里面的歌
    const plCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我喜欢'))
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('酷狗一号'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 等 checkKGFavForCurrent 的 /liked 集合就绪后，爱心应点亮
    const heart = container.querySelector('.dsh-music-bar-btn.fav')
    expect(heart).toBeTruthy()
    expect(heart.title).toContain('酷狗「我喜欢」')
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy()
    // 再点爱心 → 从酷狗「我喜欢」取消收藏（playlist-remove 带 listId + fileId）
    act(() => { heart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(favCalls.length).toBe(1)
    expect(favCalls[0].url).toContain('/dsh-music/kg/playlist-remove')
    expect(favCalls[0].body.listId).toBe(2)
    expect(favCalls[0].body.fileId).toBe(7)
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeNull()
  })

  it('酷狗：播放列表跟随「我的歌单」更新——打开播放列表时重拉来源歌单', async () => {
    const baseFetch = fetchStub
    let plSongs = [
      { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou', fileId: 7 },
    ]
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '2', name: '我喜欢', kind: 'own', isDefault: true, isDef: 2, creator: '', trackCount: 1, source: 'kugou', cover: 'data:image/jpeg;base64,xx' },
      ] })
      if (u === '/dsh-music/kg/liked') return jsonRes({ ok: true, listId: 2, hashes: ['KG1'], files: [{ hash: 'KG1', fileId: 7 }] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: plSongs } })
      if (u.startsWith('/dsh-music/kg/play/') && o.method === 'HEAD') return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-KG-Quality' ? encodeURIComponent('无损') : null } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')][1]
    // 我的歌单 → 打开「我喜欢」→ 点歌播放（队列来源 = 该歌单）
    const plCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我喜欢'))
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('酷狗一号'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 回到主界面（「播放列表」按钮在工具栏，歌单详情层没有）
    const backBtn = [...kgPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent.includes('返回'))
    act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 外部往「我喜欢」加了一首：来源歌单现在有 KG1 + KG2
    plSongs = [
      { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou', fileId: 7 },
      { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
    ]
    // 打开播放列表 → 应跟随歌单显示新歌「酷狗二号」（不再是旧的只有 KG1 的快照）
    const plBtn = [...kgPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    act(() => { plBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(kgPane.textContent).toContain('酷狗二号')
  })

  it('酷狗：播放列表已打开时，点爱心增删「我喜欢」→ 实时跟随更新', async () => {
    const baseFetch = fetchStub
    let plSongs = [
      { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou', fileId: 7 },
    ]
    const favCalls = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '2', name: '我喜欢', kind: 'own', isDefault: true, isDef: 2, creator: '', trackCount: 1, source: 'kugou', cover: 'data:image/jpeg;base64,xx' },
      ] })
      if (u === '/dsh-music/kg/liked') return jsonRes({ ok: true, listId: 2, hashes: ['KG1'], files: [{ hash: 'KG1', fileId: 7 }] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: plSongs } })
      if (u.startsWith('/dsh-music/kg/play/') && o.method === 'HEAD') return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-KG-Quality' ? encodeURIComponent('无损') : null } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u === '/dsh-music/kg/playlist-remove' && o.method === 'POST') {
        try { favCalls.push(JSON.parse(o.body || '{}')) } catch {}
        return jsonRes({ ok: true })
      }
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')][1]
    const plCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我喜欢'))
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('酷狗一号'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 回到主界面，打开播放列表（此时只有酷狗一号）
    const backBtn = [...kgPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent.includes('返回'))
    act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const plBtn = [...kgPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    act(() => { plBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(kgPane.textContent).not.toContain('酷狗二号')
    // 服务端「我喜欢」变成只剩 KG2（酷狗一号被移出）；点播放条爱心（取消收藏）→
    // kgQueueRev bump → 播放列表实时跟随重拉，显示酷狗二号（当前曲目保在队首）。
    plSongs = [
      { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
    ]
    const heart = container.querySelector('.dsh-music-bar-btn.fav')
    act(() => { heart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(favCalls.length).toBe(1)
    expect(kgPane.textContent).toContain('酷狗二号')
  })

  it('QQ：播放列表跟随「我的歌单」更新——打开播放列表时重拉来源歌单', async () => {
    const baseFetch = fetchStub
    let plSongs = [
      { id: 'AAA', songmid: 'AAA', title: 'QQ一号', artists: ['歌手A'], songid: 111, songtype: 0, payplay: 0, source: 'qq' },
    ]
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/qq/status') return jsonRes({ loggedIn: true, uin: '123456' })
      if (u === '/dsh-music/qq/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '201', dirId: 201, name: '我喜欢', creator: '我', trackCount: 1, source: 'qq', kind: 'default', isDefault: true },
      ] })
      if (u === '/dsh-music/qq/liked') return jsonRes({ ok: true, ids: [111], mids: ['AAA'] })
      if (u.startsWith('/dsh-music/qq/playlist/')) return jsonRes({ ok: true, playlist: { id: '201', songs: plSongs } })
      if (u.startsWith('/dsh-music/qq/play/') && o.method === 'HEAD') return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-QQ-Quality' ? encodeURIComponent('无损') : null } })
      if (u.startsWith('/dsh-music/qq/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/qq/lyric')) return jsonRes({ ok: true, lrc: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const qqTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { qqTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const qqPane = [...container.querySelectorAll('.dsh-music-qq-pane')][0]
    // 我的歌单（默认 tab）→ 打开「我喜欢」→ 点歌播放
    const plCard = [...qqPane.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我喜欢'))
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...qqPane.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('QQ一号'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 回到主界面（「播放列表」按钮在工具栏）
    const backBtn = [...qqPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent.includes('返回'))
    act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 外部往「我喜欢」加了一首
    plSongs = [
      { id: 'AAA', songmid: 'AAA', title: 'QQ一号', artists: ['歌手A'], songid: 111, songtype: 0, payplay: 0, source: 'qq' },
      { id: 'BBB', songmid: 'BBB', title: 'QQ二号', artists: ['歌手B'], songid: 222, songtype: 0, payplay: 0, source: 'qq' },
    ]
    const plBtn = [...qqPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    act(() => { plBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(qqPane.textContent).toContain('QQ二号')
  })

  it('酷狗：自建歌单卡片数目实时更新（−移除后本地计数 -1，服务端陈旧不覆盖）', async () => {
    const baseFetch = fetchStub
    const removeCalls = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      // 服务端始终返回自建歌单 trackCount=2（陈旧，不随移除变化）
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '2', name: '我喜欢', kind: 'own', isDefault: true, isDef: 2, creator: '', trackCount: 1, source: 'kugou', cover: 'data:image/jpeg;base64,xx' },
        { id: '5', name: '我的自建', kind: 'own', isDefault: false, creator: '', trackCount: 2, source: 'kugou', cover: '' },
      ] })
      if (u === '/dsh-music/kg/liked') return jsonRes({ ok: true, listId: 2, hashes: ['KG1'], files: [{ hash: 'KG1', fileId: 7 }] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'A', hash: 'A', title: '自建甲', artists: ['甲'], source: 'kugou', fileId: 11 },
        { id: 'B', hash: 'B', title: '自建乙', artists: ['乙'], source: 'kugou', fileId: 12 },
      ] } })
      if (u.startsWith('/dsh-music/kg/play/') && o.method === 'HEAD') return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-KG-Quality' ? encodeURIComponent('无损') : null } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u === '/dsh-music/kg/playlist-remove' && o.method === 'POST') {
        try { removeCalls.push(JSON.parse(o.body || '{}')) } catch {}
        return jsonRes({ ok: true })
      }
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')][1]
    // 我的歌单：自建歌单卡片显示 2 首
    const ownCard = [...kgPane.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的自建'))
    expect(ownCard.textContent).toContain('2 首')
    // 打开自建歌单 → 移除一首
    act(() => { ownCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...kgPane.querySelectorAll('.dsh-music-track-row')].find((b) => b.textContent.includes('自建甲'))
    const minusBtn = row.querySelector('.dsh-music-playlist-mini.remove')
    act(() => { minusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(removeCalls.length).toBe(1)
    expect(String(removeCalls[0].listId)).toBe('5')
    // 回到主界面：卡片数目实时变 1（本地计数表，服务端仍返回 2 也不覆盖）
    const backBtn = [...kgPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent.includes('返回'))
    act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ownCard2 = [...kgPane.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的自建'))
    expect(ownCard2.textContent).toContain('1 首')
  })

  it('酷狗：「我喜欢」卡片数目以本地集合长度为准（服务端计数滞后不影响）', async () => {
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      // 服务端说「我喜欢」有 5 首（陈旧），但 /kg/liked 返回真实集合只有 2 首
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '2', name: '我喜欢', kind: 'own', isDefault: true, isDef: 2, isLike: true, creator: '', trackCount: 5, source: 'kugou', cover: 'data:image/jpeg;base64,xx' },
      ] })
      if (u === '/dsh-music/kg/liked') return jsonRes({ ok: true, listId: 2, hashes: ['KG1', 'KG2'], files: [{ hash: 'KG1', fileId: 7 }, { hash: 'KG2', fileId: 8 }] })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')][1]
    const likeCard = [...kgPane.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我喜欢'))
    // 以本地集合为准：2 首（而非服务端的 5 首）
    expect(likeCard.textContent).toContain('2 首')
  })

  it('shows the local music quality chip (FLAC · 无损) on the bar', async () => {
    // 本地音乐：扫描时解析文件头得到「格式 · 档位」，startPlay 把 track.quality 写入
    // currentQuality，播放条显示品质芯片；与在线 QQ 的「QQ音乐 · 无损」互不叠加。
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.flac', url: '/dsh-music/0', size: 10, ext: 'flac', path: '/music/a.flac', quality: 'FLAC · 无损' }] }
    vi.resetModules()
    lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.flac'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放条带本地音质芯片
    expect(container.textContent).toContain('FLAC · 无损')
    // 不会叠加在线 QQ 徽标
    expect(container.textContent).not.toContain('QQ音乐 · 无损')
  })

  it('hides the quality badge when the 音质徽章显示 config toggle is off', async () => {
    // 系统配置「音质徽章显示」关闭后，歌名后不再显示本地「格式 · 音质」芯片
    // 与在线 QQ「QQ音乐 · 无损/高音质/标准」徽标；重新打开后恢复。
    prefsServer = { 'dsh-music-show-quality': '0' }
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.flac', url: '/dsh-music/0', size: 10, ext: 'flac', path: '/music/a.flac', quality: 'FLAC · 无损' }] }
    vi.resetModules(); registered = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.flac'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 开关关闭：本地音质芯片不显示，但歌名仍在
    expect(container.textContent).toContain('a')
    expect(container.textContent).not.toContain('FLAC · 无损')

    // 打开系统配置里的「音质徽章显示」开关 → 恢复显示
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const toggles = [...container.querySelectorAll('.dsh-music-toggle')]
    // 第 4 个开关 = 音质徽章显示（歌词显示/歌词面板透明/频谱之后、进度条之前），当前 OFF
    expect(toggles[3].getAttribute('aria-checked')).toBe('false')
    act(() => { toggles[3].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 返回播放条 → 音质芯片恢复
    const libraryTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { libraryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('FLAC · 无损')
  })

  it('adds the bare class to the bar (hides border/background) when the 播放条背景显示 toggle is off, keeping content', async () => {
    // 系统配置「播放条背景显示」：关闭后播放条外壳去掉边框与背景（加 .bare class），
    // 但歌名/歌词等内容保持不变（仍是同一 .dsh-music-bar 的子元素）。
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.flac', url: '/dsh-music/0', size: 10, ext: 'flac', path: '/music/a.flac', quality: 'FLAC · 无损' }] }
    prefsServer = {}
    vi.resetModules(); registered = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const track = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('a.flac'))
    act(() => { track.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 默认开启：播放条无 bare class，歌名正常显示
    let barEl = container.querySelector('.dsh-music-bar')
    expect(barEl.classList.contains('bare')).toBe(false)
    expect(barEl.textContent).toContain('a')
    // 打开系统配置 → 关闭「播放条背景显示」
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const toggles = [...container.querySelectorAll('.dsh-music-toggle')]
    // 第 6 个开关 = 播放条背景显示（位于进度条之后）
    expect(toggles[5].getAttribute('aria-checked')).toBe('true')
    act(() => { toggles[5].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 返回播放条：bare class 加上，内容（歌名）仍保留
    const libraryTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { libraryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    barEl = container.querySelector('.dsh-music-bar')
    expect(barEl.classList.contains('bare')).toBe(true)
    expect(barEl.textContent).toContain('a')
  })

  it('shows the QQ online lyric in the bar (idle state) with translation merged', async () => {
    // P2：在线 QQ 歌词。QQ 播放走 startQQPlayback（不走 startPlay），歌词从
    // /dsh-music/qq/lyric 按 songmid 取；有逐句翻译时合并为「原文 ／ 翻译」。
    const audios = []
    class LyricAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    qqLyricFixture = {
      ok: true, hasLyric: true,
      lrc: [{ t: 0, text: '告白气球' }, { t: 3, text: '亲爱的 爱上你' }],
      trans: [{ t: 3, text: 'darling I love you' }],
    }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', LyricAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    expect(audio).toBeTruthy()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const barEl = container.querySelector('.dsh-music-bar')
      const controls = container.querySelector('.dsh-music-bar-controls')
      const hotspot = container.querySelector('.dsh-music-bar-hotspot')
      expect(barEl.classList.contains('dimmed')).toBe(true)
      // 闲置态 → 歌词显示当前行（currentTime=0 → 第一行，无翻译）
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('告白气球')
      // 推进到 3.5s → 第二行 + 翻译合并（原文 ／ 翻译）
      act(() => { audio.currentTime = 3.5; audio.emit('timeupdate') })
      const lyric2 = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric2.textContent).toContain('亲爱的 爱上你')
      expect(lyric2.textContent).toContain('darling I love you')
      // 使用态（悬停右端热区）→ 歌词收起（与本地歌词同规格）
      act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      expect(container.querySelector('.dsh-music-bar-lyric')).toBeNull()
    } finally { qqLyricFixture = null }
  })

  it('QQ 在线歌曲也走 QRC 行窗口：karaoke 整行扫色窗口取精确行时长', async () => {
    // /dsh-music/qq/lyric 返回 wordLines 形态 → loadQQLyric 消费 musicWordLyric；
    // karaoke 动效下整行扫色的 --kar-dur 取 QRC 精确行时长；data-src="qq-qrc"。
    const audios = []
    class QrcAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    prefsServer = { 'dsh-music-lyric-fx': 'karaoke' }
    qqLyricFixture = {
      ok: true, hasLyric: true, source: 'qq-qrc',
      wordLines: [
        { t: 0, end: 3, text: '告白气球' },
        { t: 3, end: 6, text: '亲爱的 爱上你' },
      ],
    }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QrcAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
      act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 行窗口 [0,3]s → 音频时钟驱动：1.2s 处位置 (1-1200/3000)=60.00%
      audio.duration = 30
      audio.currentTime = 1.2
      act(() => { audio.emit('timeupdate') })
      const outer = container.querySelector('.dsh-music-bar-lyric')
      expect(outer.getAttribute('data-src')).toBe('qq-qrc')
      const fxEl = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(fxEl.getAttribute('data-wordmode')).toBeNull()
      expect(fxEl.textContent).toBe('告白气球')
      expect(fxEl.getAttribute('data-audioclock')).toBe('1')
      expect(fxEl.style.backgroundPositionX).toBe('43.33%')   // f=1200/3000
      expect(fxEl.querySelectorAll('.dsh-music-word').length).toBe(0)
      // 第二行窗口 [3,6]s：4.5s → 50.00%
      audio.currentTime = 4.5
      act(() => { audio.emit('timeupdate') })
      const fxEl2 = container.querySelector('.dsh-music-bar-lyric-fx')
      expect(container.querySelector('.dsh-music-bar-lyric').textContent).toBe('亲爱的 爱上你')
      expect(fxEl2.style.backgroundPositionX).toBe('36.67%')   // f=1500/3000
    } finally {
      qqLyricFixture = null
      prefsServer = {}
    }
  })

  it('clears the QQ artist from the bar when switching to a local track or novel', async () => {
    // Regression: after playing a QQ song (artists set), playing a local track
    // (no artists) or a novel used to leave the stale QQ artist on the bar,
    // because currentArtists was not reset. It must be cleared.
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // QQ 曲目播放中：歌手名显示
    expect(container.textContent).toContain('周杰伦')
    // 切回本地音乐，双击本地曲目（无 artists）→ 歌手名应消失
    const musicTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { musicTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const localRow = container.querySelector('.dsh-music-track')
    expect(localRow).toBeTruthy()
    act(() => { localRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    act(() => { localRow.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 本地曲目无歌手：artist 元素应消失（不再残留周杰伦）
    expect(container.querySelector('.dsh-music-bar-artist')).toBeNull()
    // bar 上不应再出现 QQ 歌手名（面板常驻后隐藏的 QQ 歌单内容仍在 DOM 中，
    // 因此只检查播放条 bar 本身，不检查整个 container）
    const barText = container.querySelector('.dsh-music-bar') ? container.querySelector('.dsh-music-bar').textContent : container.textContent
    expect(barText).not.toContain('周杰伦')
  })

  it('does NOT jump back to the QQ tab after choosing a directory while playing QQ', async () => {
    // Regression: saveRoot() used to call restoreLatest() -> restorePlayback(),
    // whose QQ branch force-set tab:'qq'. So while a QQ track was playing,
    // confirming a directory in 本地音乐/AI讲书 yanked the panel back to the
    // QQ音乐 tab. Changing the directory must only refresh the list.
    const audios = []
    class QAudio2 extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio2)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 播放一首 QQ 歌（让 currentId 变为 qq:，PREF_PLAYBACK 记录 QQ）
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 切到本地音乐 tab
    const musicTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { musicTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 选择音乐目录并确认（走 saveRoot）
    const pickBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '选择音乐目录')
    act(() => { pickBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const confirmBtn = [...container.querySelectorAll('.dsh-music-picker-foot .dsh-music-settings-btn')].find((b) => b.textContent === '选择此目录')
    act(() => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 目录确认后仍应停留在本地音乐（不跳回 QQ 音乐 tab）
    const activeTab = container.querySelector('.dsh-music-tab.active')
    expect(activeTab).toBeTruthy()
    expect(activeTab.textContent).toBe('本地音乐')
  })

  it('favorites an online QQ song via the heart button (adds to 我喜欢)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('七里香'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // heart button appears for the online track
    const heart = container.querySelector('.dsh-music-bar-btn.fav')
    expect(heart).toBeTruthy()
    act(() => { heart.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // called /dsh-music/qq/fav with action add for the current song
    expect(favCalls.length).toBeGreaterThan(0)
    expect(favCalls[0].action).toBe('add')
    expect(favCalls[0].song.songmid).toBe('790')
    // heart turns on (filled)
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy()
  })

  it('reflects per-song liked state: favorited songs show filled heart, others do not', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 告白气球 (songid 789001) IS in the liked ids -> heart filled after the async check
    const fav1 = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { fav1.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy()
    // 七里香 (songid 790002) is NOT in liked ids -> heart not filled
    const fav2 = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('七里香'))
    act(() => { fav2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeNull()
    // back to 告白气球 -> filled again (not stuck from a previous toggle)
    const fav3 = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { fav3.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy()
  })

  it('persists online QQ playback so a refresh can restore it (not showing local music)', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // savePlayback must persist the online QQ state to the Host (flushed on debounce)
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const saved = JSON.parse(prefsServer['dsh-music-qq-playback'])
    expect(saved.id).toBe('qq:789')
    expect(Array.isArray(saved.queue)).toBe(true)
    expect(saved.queue.length).toBe(2)
    // and the scope is remembered as qq (so refresh opens the online view)
    expect(JSON.parse(prefsServer['dsh-music-scope']).kind).toBe('qq')
  })

  it('persists the online QQ track position so a restart resumes mid-song', async () => {
    qqLoggedIn = true
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const audio = audios[0]
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 播到 1:00（全曲 4:00）时暂停：暂停会立即 savePlayback，位置必须被持久化
    audio.currentTime = 60
    audio.duration = 240
    act(() => { audio.emit('pause') })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // flush debounce
    const saved = JSON.parse(prefsServer['dsh-music-qq-playback'])
    expect(saved.id).toBe('qq:789')
    expect(saved.position).toBe(60)
    expect(saved.duration).toBe(240)
    expect(Array.isArray(saved.queue)).toBe(true)
  })

  it('restarts a restored online QQ track from its saved mid-song position', async () => {
    // 模拟重启：Host prefs 里躺着一条「播到 1:00」的 QQ 播放记录。新会话必须恢复
    // 同一曲目 + 队列，播放条显示 1:00 / 4:00（暂停态），点 ▶ 后把流 seek 到 60。
    prefsServer = {
      'dsh-music-qq-playback': JSON.stringify({
        id: 'qq:789', name: '告白气球', artists: ['周杰伦'],
        position: 60, duration: 240,
        queue: [
          { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], payplay: 0, source: 'qq' },
          { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], payplay: 0, source: 'qq' },
        ],
        source: '在线', ts: 999999999,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'qq' }),
    }
    qqLoggedIn = true
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // restorePlayback ran during loadTracks: bar shows the QQ track paused at 1:00 / 4:00
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('告白气球')
    // 播放条处于闲置（半透明）态时不显示时长；鼠标移入右端热区激活后显示恢复的位置。
    const hotspot = container.querySelector('.dsh-music-bar-hotspot')
    act(() => { hotspot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const timeSpan = container.querySelector('.dsh-music-bar-time')
    expect(timeSpan).toBeTruthy()
    expect(timeSpan.textContent).toBe('1:00 / 4:00')
    // click play -> togglePlay reloads the online stream URL and seeks to the saved spot
    const playBtn = [...container.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
    expect(playBtn).toBeTruthy()
    act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const audio = audios[0]
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    expect(audio.currentTime).toBeGreaterThanOrEqual(59.5) // 从 1:00 续播而非从头
    expect(audio.paused).toBe(false)
  })

  it('restarts a restored online KuGou track from its saved mid-song position', async () => {
    // 与 QQ 同构：Host prefs 里躺着一条「播到 1:00」的酷狗播放记录，新会话必须恢复
    // 同一曲目 + 队列，点 ▶ 后把流 seek 到 60。
    prefsServer = {
      'dsh-music-kg-playback': JSON.stringify({
        id: 'kg:ABC', name: '酷狗歌', artists: ['歌手'],
        position: 60, duration: 240,
        queue: [
          { id: 'ABC', hash: 'ABC', title: '酷狗歌', artists: ['歌手'], source: 'kugou' },
          { id: 'DEF', hash: 'DEF', title: '酷狗歌2', artists: ['歌手'], source: 'kugou' },
        ],
        source: '在线', ts: 999999999,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'kg' }),
    }
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('酷狗歌')
    // click play -> togglePlay reloads the KuGou stream URL and seeks to the saved spot
    const playBtn = [...container.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
    expect(playBtn).toBeTruthy()
    act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const audio = audios[0]
    expect(audio.src).toContain('/dsh-music/kg/play/ABC')
    expect(audio.currentTime).toBeGreaterThanOrEqual(59.5) // 从 1:00 续播而非从头
    expect(audio.paused).toBe(false)
  })

  it('restarts a restored online 网易云 track from its saved mid-song position', async () => {
    // 与 QQ/酷狗同构：Host prefs 里躺着一条「播到 1:00」的网易云播放记录。新会话必须
    // 恢复同一曲目 + 队列，点 ▶ 后 togglePlay 为 nc: 补加载流地址（在线流每次经代理
    // 按 id 重新取链，不能沿用旧 src）并把流 seek 到 60——修复前 nc: 漏了 togglePlay
    // 分支，<audio> 没有 src、点 ▶ 播不出声（刷新后无法续播）。
    prefsServer = {
      'dsh-music-nc-playback': JSON.stringify({
        id: 'nc:NC1', name: '网易一号', artists: ['歌手A'],
        position: 60, duration: 240,
        queue: [
          { id: 'NC1', title: '网易一号', artists: ['歌手A'], fee: 0, source: 'nc' },
          { id: 'NC2', title: '网易二号', artists: ['歌手B'], fee: 0, source: 'nc' },
        ],
        source: '在线', ts: 999999999,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'nc' }),
    }
    const baseFetch = fetchStub
    const headLog = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      const o = opts || {}
      // 取链流地址的 HEAD：回传真实品质（与 Host X-DSH-NC-Quality 一致）
      if (u.startsWith('/dsh-music/nc/play/') && o.method === 'HEAD') {
        headLog.push(u)
        return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-NC-Quality' ? encodeURIComponent('无损') : null } })
      }
      if (u.startsWith('/dsh-music/nc/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/nc/lyric')) return jsonRes({ ok: true, hasLyric: false, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    const audios = []
    class NCAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', NCAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // restoreLatest → restoreNCPlayback：bar 显示网易云曲目（暂停态）
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('网易一号')
    // 点 ▶ → togglePlay 的 nc: 分支补加载流地址 + seek 到保存位置
    const playBtn = [...container.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
    expect(playBtn).toBeTruthy()
    act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const audio = audios[0]
    expect(audio.src).toContain('/dsh-music/nc/play/NC1')
    expect(audio.currentTime).toBeGreaterThanOrEqual(59.5) // 从 1:00 续播而非从头
    expect(audio.paused).toBe(false)
    // 补发过一次 HEAD（真实品质徽章续播后可见）
    expect(headLog).toContain('/dsh-music/nc/play/NC1')
    // 点「下一首」→ step → startPlay（通用路径，不走 startNCPlayback）→ 必须为 NC2
    // 补发 HEAD（音质徽章在自动切歌/上下曲时也要出现，与 QQ/KG 对齐）。
    const nextBtn = container.querySelector('button[title="下一首"]')
    act(() => { nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(headLog).toContain('/dsh-music/nc/play/NC2')
    // 播放条仍只显示一个网易云来源徽章（startPlay 切歌后不出现第二个裸品质芯片）
    const badges = [...container.querySelectorAll('.dsh-music-bar-src')]
    expect(badges.length).toBe(1)
    expect(badges[0].textContent).toBe('网易云 · 无损')
  })

  it('REGRESSION: 刷新恢复酷狗「我喜欢」歌曲时集合仍在拉取中 → 爱心最终点亮', async () => {
    // 页面刷新后 restoreKGPlayback 恢复酷狗曲目时，/dsh-music/kg/liked 可能还在拉取
    // （网络延迟）。checkKGFavForCurrent 必须等集合就绪后再判断（Promise 缓存共享同一
    // 次请求），而不是在拉取中读到空集合把爱心误判为未收藏。
    prefsServer = {
      'dsh-music-kg-playback': JSON.stringify({
        id: 'kg:ABC', name: '酷狗歌', artists: ['歌手'],
        position: 0, duration: 240,
        queue: [{ id: 'ABC', hash: 'ABC', title: '酷狗歌', artists: ['歌手'], source: 'kugou' }],
        source: '我喜欢', ts: 999999999,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'kg' }),
    }
    const baseFetch = fetchStub
    const likedCalls = []
    let resolveLiked = null
    const likedGate = new Promise((res) => { resolveLiked = res })
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/liked') { likedCalls.push(u); return likedGate } // 挂起：模拟集合仍在拉取
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [{ id: '2', name: '我喜欢', kind: 'own', isDef: 2, isDefault: true, trackCount: 1, source: 'kugou', cover: '' }] })
      if (u.startsWith('/dsh-music/kg/play/') && o.method === 'HEAD') return Promise.resolve({ ok: true, status: 200, headers: { get: (n) => n === 'X-DSH-KG-Quality' ? encodeURIComponent('无损') : null } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // 等 restore 与登录检测都触发 /liked（此时集合仍挂起）
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan.textContent).toContain('酷狗歌') // 酷狗曲目已恢复
    expect(likedCalls.length).toBeGreaterThan(0) // /liked 已发起
    // 集合此刻就绪 → 爱心应点亮（Promise 缓存保证所有等待者拿到同一份结果）
    await act(async () => { resolveLiked(jsonRes({ ok: true, listId: 2, hashes: ['ABC'], files: [{ hash: 'ABC', fileId: 7 }] })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    const heart = container.querySelector('.dsh-music-bar-btn.fav')
    expect(heart).toBeTruthy()
    expect(container.querySelector('.dsh-music-bar-btn.fav.on')).toBeTruthy() // 爱心应点亮
  })

  it('restores KuGou playback over an older QQ record (newest timestamp wins)', async () => {
    // 回归：之前播过 QQ（旧 ts），最近在播酷狗（新 ts）。刷新后必须恢复到酷狗，
    // 而不是被旧 QQ 记录抢走（用户「播酷狗时刷新变回 QQ」的根因）。
    prefsServer = {
      'dsh-music-qq-playback': JSON.stringify({ id: 'qq:OLD789', name: '旧QQ歌', position: 10, duration: 100, queue: [{ songmid: 'OLD789', title: '旧QQ歌' }], source: '在线', ts: 100 }),
      'dsh-music-kg-playback': JSON.stringify({
        id: 'kg:NEWABC', name: '新酷狗歌', artists: ['歌手'],
        position: 45, duration: 200,
        queue: [{ id: 'NEWABC', hash: 'NEWABC', title: '新酷狗歌', artists: ['歌手'], source: 'kugou' }],
        source: '在线', ts: 200,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'kg' }),
    }
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // 必须恢复到酷狗曲目，而不是旧 QQ 曲目
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('新酷狗歌')
    expect(nameSpan.textContent).not.toContain('旧QQ歌')
  })

  it('restores KuGou via saved scope even when an older QQ record has a newer timestamp (scope override)', async () => {
    // 用户「播酷狗时刷新却恢复成 QQ」的场景：酷狗记录 ts 较小，但 scope 指示上次在
    // 酷狗范畴（scope={kind:'kg'}）。修复后按 scope 优先恢复酷狗，而不是被 ts 更大的
    // QQ 记录抢走。
    prefsServer = {
      'dsh-music-qq-playback': JSON.stringify({ id: 'qq:OLD789', name: '旧QQ歌', position: 10, duration: 100, queue: [{ songmid: 'OLD789', title: '旧QQ歌' }], source: '在线', ts: 999999 }),
      'dsh-music-kg-playback': JSON.stringify({
        id: 'kg:NEWABC', name: '新酷狗歌', artists: ['歌手'],
        position: 45, duration: 200,
        queue: [{ id: 'NEWABC', hash: 'NEWABC', title: '新酷狗歌', artists: ['歌手'], source: 'kugou' }],
        source: '在线', ts: 1,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'kg' }),
    }
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('新酷狗歌')
    expect(nameSpan.textContent).not.toContain('旧QQ歌')
  })

  it('persists online KuGou playback so a refresh can restore it (queue + position)', async () => {
    // 模拟已登录酷狗：面板落到「我的歌单」→ 点开歌单 → 点歌播放。savePlayback 必须
    // 把酷狗曲目+队列写入 dsh-music-kg-playback（与 QQ 同构）。
    prefsServer = { 'dsh-music-scope': JSON.stringify({ kind: 'kg' }) }
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [{ id: 'p1', name: '我的酷狗歌单', creator: '我', trackCount: 2, source: 'kugou', cover: '' }] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], payType: 3, privilege: 10, source: 'kugou' },
        { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], payType: 0, privilege: 0, source: 'kugou' },
        { id: 'KG3', hash: 'KG3', title: '酷狗三号', artists: ['歌手C'], payType: 1, privilege: 10, source: 'kugou' },
      ] } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 已登录 → 主 UI。点开「我的歌单」歌单卡片 → 歌单详情 → 点歌。
    const plCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的酷狗歌单'))
    expect(plCard).toBeTruthy()
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 付费歌带 VIP 标、免费歌不带（回归：酷狗 VIP 判定 pay_type/privilege > 0。
    // payType=1（如「西楼儿女」海来阿木版，搜索里可见）与 payType=3（歌单常见）
    // 都算付费；旧条件 ===1 只认 1、漏掉 3 → 歌单歌曲一律不显示 VIP）。
    const vipRows = [...container.querySelectorAll('.dsh-music-track-row')].filter((row) => row.querySelector('.dsh-music-online-tag.vip'))
    expect(vipRows.length).toBe(2)
    expect(vipRows.map((r) => r.textContent).filter((t) => t.includes('酷狗一号') && t.includes('VIP')).length).toBe(1)
    expect(vipRows.map((r) => r.textContent).filter((t) => t.includes('酷狗三号') && t.includes('VIP')).length).toBe(1)
    expect(vipRows.map((r) => r.textContent).filter((t) => t.includes('酷狗二号')).length).toBe(0)
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('酷狗一号'))
    expect(song).toBeTruthy()
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // savePlayback 持久化酷狗状态到 Host（debounce 后 flush）
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    const saved = JSON.parse(prefsServer['dsh-music-kg-playback'])
    expect(saved).toBeTruthy()
    expect(saved.id).toBe('kg:KG1')
    expect(Array.isArray(saved.queue)).toBe(true)
    expect(saved.queue.length).toBe(3)
    expect(JSON.parse(prefsServer['dsh-music-scope']).kind).toBe('kg')
  })

  it('loads KuGou lyrics on auto-advance / 下一首 via startPlay (regression)', async () => {
    // 回归：酷狗歌词原来只在面板直接点歌（startKGPlayback）时加载；自动续播/上下曲走
    // startPlay → loadLyricForTrack，但该函数漏了 kg: 分支且酷狗曲目没有本地 path，
    // 会提前 return → 自动/手动下一首时不出歌词（只有点同一首歌才出）。
    const baseFetch = fetchStub
    const lyricReq = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [{ id: 'p1', name: '我的酷狗歌单', creator: '我', trackCount: 2, source: 'kugou', cover: '' }] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
        { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
      ] } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) {
        lyricReq.push(u)
        const hash = new URL('http://x' + u).searchParams.get('hash') || ''
        return jsonRes({ ok: true, source: 'kugou', lrc: [{ t: 0, text: hash === 'KG1' ? '酷狗一号歌词' : '酷狗二号歌词' }] })
      }
      return baseFetch(url, opts)
    })
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const plCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('我的酷狗歌单'))
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('酷狗一号'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 直接点歌 → startKGPlayback → 歌词出现
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toContain('酷狗一号歌词')
    // 点「下一首」→ step → startPlay → 必须为酷狗二号再取词并显示歌词
    const nextBtn = container.querySelector('button[title="下一首"]')
    act(() => { nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(lyricReq.some((u) => new URL('http://x' + u).searchParams.get('hash') === 'KG2')).toBe(true)
    expect(container.querySelector('.dsh-music-bar-lyric').textContent).toContain('酷狗二号歌词')
  })

  it('marks 收藏 vs 自建 酷狗歌单 and hides delete/remove for collected + system playlists', async () => {
    // 酷狗「我的歌单」= 云歌单列表（自建 type=0 + 收藏 type=1 混排）。收藏歌单是别人的，
    // 卡片应标「收藏」角标、展示原作者、不提供 ✕ 删除；详情里也不该出现「−」移除按钮。
    // 系统默认歌单（默认收藏/我喜欢，isDefault）也不可删。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: 'own1', name: '我的自建歌单', kind: 'own', isDefault: false, creator: '', trackCount: 2, source: 'kugou', cover: '' },
        { id: 'def1', name: '我喜欢', kind: 'own', isDefault: true, creator: '', trackCount: 1, source: 'kugou', cover: '' },
        { id: 'col1', name: '周杰伦歌单', kind: 'collect', isDefault: false, creator: '别人', trackCount: 5, source: 'kugou', cover: '' },
      ] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
        { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
      ] } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 「我的歌单」是默认 tab：自建歌单有 ✕ 删除按钮、收藏歌单有 ☆ 取消收藏按钮、
    // 系统默认歌单（我喜欢）没有删除按钮。
    const cards = [...container.querySelectorAll('.dsh-music-playlist-card')]
    expect(cards.length).toBe(3)
    const ownCard = cards.find((c) => c.textContent.includes('我的自建歌单'))
    const defCard = cards.find((c) => c.textContent.includes('我喜欢'))
    const colCard = cards.find((c) => c.textContent.includes('周杰伦歌单'))
    expect(ownCard.textContent).toContain('自建')
    expect(colCard.textContent).toContain('收藏')
    expect(colCard.textContent).toContain('别人') // 收藏歌单展示原作者
    expect(defCard.textContent).toContain('默认')
    // 系统默认（我喜欢）用主题色「默认」标签（与 QQ 一致），收藏用金色、自建用灰色。
    expect(defCard.querySelector('.dsh-music-online-tag.default')).toBeTruthy()
    expect(colCard.querySelector('.dsh-music-online-tag.collect')).toBeTruthy()
    // 自建 → ✕ 删除；收藏 → ☆ 取消收藏；系统默认无删除按钮
    expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(2)
    const dels = [...container.querySelectorAll('.dsh-music-qq-mine-del')]
    const ownDel = dels.find((b) => b.title.includes('我的自建歌单'))
    const colDel = dels.find((b) => b.title.includes('周杰伦歌单'))
    expect(ownDel).toBeTruthy()
    expect(ownDel.title).toContain('删除歌单')
    expect(ownDel.textContent).toBe('✕')
    expect(colDel).toBeTruthy()
    expect(colDel.title).toContain('取消收藏歌单')
    expect(colDel.textContent).toBe('☆')
    expect(colDel.className).toContain('uncollect')
    // 打开「收藏」歌单详情：歌曲行是「＋ 加入我的歌单」，而不是「− 移除」
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container;
    act(() => { colCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const removeBtns = [...kgPane.querySelectorAll('.dsh-music-playlist-mini.remove')]
    expect(removeBtns.length).toBe(0)
    const addBtns = [...kgPane.querySelectorAll('.dsh-music-playlist-mini.add')]
    expect(addBtns.length).toBe(2)
    // 打开「自建」歌单详情：每首歌是「−」从该歌单移除
    act(() => { kgPane.querySelector('.dsh-music-settings-btn.ghost').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const ownCard2 = [...kgPane.querySelectorAll('.dsh-music-playlist-card')].find((c) => c.textContent.includes('我的自建歌单'))
    act(() => { ownCard2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(kgPane.querySelectorAll('.dsh-music-playlist-mini.remove').length).toBe(2)
    expect(kgPane.querySelectorAll('.dsh-music-playlist-mini.add').length).toBe(0)
  })

  it('取消收藏酷狗收藏歌单：点 ☆ → 确认框（取消收藏）→ POST playlist-delete → 从列表移除', async () => {
    const baseFetch = fetchStub
    const delCalls = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url); const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '8', name: '周杰伦歌单', kind: 'collect', isDefault: false, creator: '别人', trackCount: 5, source: 'kugou', cover: '' },
        { id: '3', name: '我的自建歌单', kind: 'own', isDefault: false, creator: '', trackCount: 2, source: 'kugou', cover: '' },
      ] })
      if (u === '/dsh-music/kg/playlist-delete' && o.method === 'POST') {
        try { delCalls.push(JSON.parse(o.body || '{}')) } catch {}
        return jsonRes({ ok: true })
      }
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
      ] } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 收藏歌单卡片的 ☆（取消收藏）按钮 → 点它
    const colDel = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('周杰伦歌单'))
    expect(colDel).toBeTruthy()
    expect(colDel.title).toContain('取消收藏')
    act(() => { colDel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 自定义确认框：标题「取消收藏」+ 危险按钮文案「取消收藏」
    const confirmBox = document.querySelector('.dsh-music-picker.confirm')
    expect(confirmBox).toBeTruthy()
    expect(confirmBox.textContent).toContain('取消收藏歌单')
    const okBtn = confirmBox.querySelector('.dsh-music-settings-btn.danger')
    expect(okBtn.textContent).toBe('取消收藏')
    act(() => { okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // POST /dsh-music/kg/playlist-delete 带收藏歌单的 listid（数字），并从列表移除
    expect(delCalls.length).toBe(1)
    expect(delCalls[0].listId).toBe(8)
    expect([...container.querySelectorAll('.dsh-music-playlist-card')].find((c) => c.textContent.includes('周杰伦歌单'))).toBeFalsy()
    // 自建歌单仍在
    expect([...container.querySelectorAll('.dsh-music-playlist-card')].find((c) => c.textContent.includes('我的自建歌单'))).toBeTruthy()
  })

  it('REGRESSION: 酷狗「我喜欢」用内嵌爱心封面、「默认收藏」等无封面显示音符占位', async () => {
    // 云歌单接口（v7/get_all_list）对系统默认歌单（is_def=1 默认收藏 / is_def=2 我喜欢）
    // 不返回 pic 封面字段。后端已为「我喜欢」内嵌 QQ 官方爱心封面（data URI），所以
    // 它渲染 <img>；「默认收藏」封面为空 → .dsh-music-playlist-cover.empty 音符占位块，
    // 而不是 <img src=""> 导致的空白；有封面的歌单仍正常出图。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: 'def1', name: '我喜欢', kind: 'own', isDefault: true, isDef: 2, creator: '', trackCount: 44, source: 'kugou', cover: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==mock' },
        { id: 'def2', name: '默认收藏', kind: 'own', isDefault: true, isDef: 1, creator: '', trackCount: 1, source: 'kugou', cover: '' },
        { id: 'own1', name: '我的自建歌单', kind: 'own', isDefault: false, creator: '', trackCount: 2, source: 'kugou', cover: 'https://c1.kgimg.com/custom/300/x.jpg' },
      ] })
      if (u.startsWith('/dsh-music/kg/my-playlist/')) return jsonRes({ ok: true, playlist: { songs: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
      ] } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 「我的歌单」是默认 tab：我喜欢 → <img>（内嵌爱心封面）；默认收藏 → 音符占位；有封面 → <img>
    const cards = [...container.querySelectorAll('.dsh-music-playlist-card')]
    expect(cards.length).toBe(3)
    const likeCard = cards.find((c) => c.textContent.includes('我喜欢'))
    const defCard = cards.find((c) => c.textContent.includes('默认收藏'))
    const ownCard = cards.find((c) => c.textContent.includes('我的自建歌单'))
    const likeImg = likeCard.querySelector('img.dsh-music-playlist-cover')
    expect(likeImg).toBeTruthy() // 我喜欢 → 内嵌爱心封面 <img>
    expect(likeImg.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/)
    expect(likeCard.querySelector('.dsh-music-playlist-cover.empty')).toBeNull()
    expect(defCard.querySelector('.dsh-music-playlist-cover.empty .dsh-music-note')).toBeTruthy() // 默认收藏 → 音符占位
    expect(defCard.querySelector('img.dsh-music-playlist-cover')).toBeNull()
    expect(ownCard.querySelector('img.dsh-music-playlist-cover')).toBeTruthy()
    // 占位音符 svg 有实际图形元素（path），不是空壳。
    expect(defCard.querySelector('.dsh-music-playlist-cover.empty .dsh-music-note path')).toBeTruthy()
  })

  it('酷狗搜索输入框内部出现「✕」一键清除内容', async () => {
    // 搜索框输入有内容时，输入框右内侧显示 ✕；点击后清空输入、✕ 消失。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u.startsWith('/dsh-music/kg/search')) return jsonRes({ ok: true, results: [], page: 1, total: 0 })
      if (u.startsWith('/dsh-music/kg/playlist-search')) return jsonRes({ ok: true, playlists: [] })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [] })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 切到「搜索」子 tab（默认落「我的歌单」）
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const input = kgPane.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    // 清除钮始终渲染（避免有无 × 导致输入框宽度/UI 抖动），空内容时仅 .hidden 隐藏
    expect(kgPane.querySelector('.dsh-music-qq-clear.hidden')).toBeTruthy()
    expect(kgPane.querySelector('.dsh-music-qq-clear:not(.hidden)')).toBeNull()
    // 输入内容 → ✕ 取消 .hidden 可见
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const clearBtn = kgPane.querySelector('.dsh-music-qq-clear:not(.hidden)')
    expect(clearBtn).toBeTruthy()
    expect(clearBtn.title).toBe('清空输入')
    // 点 ✕ → 输入清空、✕ 回到 .hidden
    act(() => { clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(input.value).toBe('')
    expect(kgPane.querySelector('.dsh-music-qq-clear.hidden')).toBeTruthy()
    expect(kgPane.querySelector('.dsh-music-qq-clear:not(.hidden)')).toBeNull()
  })

  it('REGRESSION: 搜索框与「歌曲/相关歌单」子tab在滚动容器之外，结果区滚动不引起整行偏移', async () => {
    // 搜索结果出现竖向滚动条时，输入框所在行与子tab行不应被滚动条挤窄——它们必须
    // 位于 .dsh-music-qq-body（唯一滚动容器）之外，只有结果内容在容器内滚动。
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u.startsWith('/dsh-music/kg/search')) return jsonRes({ ok: true, results: [
        { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
        { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
      ], page: 1, total: 2 })
      if (u.startsWith('/dsh-music/kg/playlist-search')) return jsonRes({ ok: true, playlists: [
        { id: 'P1', name: '周杰伦歌单', creator: '别人', trackCount: 5, source: 'kugou', cover: '' },
      ] })
      if (u === '/dsh-music/kg/my-playlists') return jsonRes({ ok: true, playlists: [] })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container
    const input = kgPane.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    // 输入关键词并搜索（歌曲 + 歌单都有结果 → 出现「歌曲/相关歌单」子tab）
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '周杰伦')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...kgPane.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 结果子tab 出现
    expect([...kgPane.querySelectorAll('.dsh-music-qq-resulttab')].map((b) => b.textContent)).toEqual(['歌曲', '相关歌单'])
    // 搜索框与子tab行都在 .dsh-music-qq-body 之外（body 内只有结果内容）
    const body = kgPane.querySelector('.dsh-music-qq-body')
    expect(body).toBeTruthy()
    expect(body.querySelector('.dsh-music-qq-search')).toBeNull()
    expect(body.querySelector('.dsh-music-qq-resulttabs')).toBeNull()
    expect(body.querySelector('.dsh-music-track-row')).toBeTruthy() // 歌曲结果在滚动容器内
    expect(kgPane.querySelector('.dsh-music-qq-search')).toBeTruthy()
    expect(kgPane.querySelector('.dsh-music-qq-resulttabs')).toBeTruthy()
  })

  it('collects a public KuGou playlist via the detail-page 收藏 button', async () => {
    // 公开歌单详情页头应有「☆ 收藏」按钮；点击后调 /dsh-music/kg/playlist-collect
    // （v5/add_list type=1），成功后置灰为「★ 已收藏」并刷新「我的歌单」。
    const baseFetch = fetchStub
    const collectCalls = []
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      const o = opts || {}
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      if (u === '/dsh-music/kg/my-playlists') {
        // 收藏后 refreshMine 会带上新收藏的歌单（kind=collect + originalId）
        const mine = [
          { id: 'own1', name: '我的自建歌单', kind: 'own', isDefault: false, creator: '', trackCount: 2, source: 'kugou', cover: '' },
        ];
        if (collectCalls.length > 0) mine.push({ id: '99', name: '周杰伦必听热歌', kind: 'collect', isDefault: false, creator: '酷乐推荐', originalId: '287', trackCount: 2, source: 'kugou', cover: '' });
        return jsonRes({ ok: true, playlists: mine })
      }
      if (u === '/dsh-music/kg/playlist-collect' && o.method === 'POST') {
        collectCalls.push(JSON.parse(o.body || '{}'))
        return jsonRes({ ok: true, playlist: { id: '99', name: '周杰伦必听热歌', originalId: '6409645' } })
      }
      // 搜索歌单结果 → 公开歌单卡片入口
      if (u.startsWith('/dsh-music/kg/search')) return jsonRes({ ok: true, results: [], page: 1, total: 0 })
      if (u.startsWith('/dsh-music/kg/playlist-search')) return jsonRes({ ok: true, page: 1, playlists: [
        { id: '6409645', name: '周杰伦必听热歌', creatorId: '2132029040', gid: 'collection_3_2132029040_287_0', slid: '287', creator: '酷乐推荐', trackCount: 2, source: 'kugou', cover: '' },
      ] })
      if (u === '/dsh-music/kg/playlist/6409645') return jsonRes({ ok: true, playlist: {
        id: '6409645', name: '周杰伦必听热歌', creatorId: '2132029040', gid: 'collection_3_2132029040_287_0', slid: '287', creator: '酷乐推荐',
        description: '', songs: [
          { id: 'KG1', hash: 'KG1', title: '酷狗一号', artists: ['歌手A'], source: 'kugou' },
          { id: 'KG2', hash: 'KG2', title: '酷狗二号', artists: ['歌手B'], source: 'kugou' },
        ],
      } })
      if (u.startsWith('/dsh-music/kg/play/')) return jsonRes({ ok: true })
      if (u.startsWith('/dsh-music/kg/lyric')) return jsonRes({ ok: true, lrc: [], wordLines: [] })
      return baseFetch(url, opts)
    })
    const audios = []
    class KGAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', KGAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const kgPane = [...container.querySelectorAll('.dsh-music-qq-pane')].find((p) => (p.style.display || '') !== 'none') || container;
    // 已登录 → 我的歌单 tab。切到「搜索」，输入并搜索 → 出现歌单卡片 → 点开公开歌单详情。
    const searchTab = await waitForText(kgPane, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = kgPane.querySelector('.dsh-music-qq-input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '周杰伦必听热歌');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 搜索走歌曲+歌单两条：歌曲空 → 结果 tab 落在「相关歌单」，点卡片进详情。
    const plCard = [...kgPane.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('周杰伦必听热歌'))
    expect(plCard).toBeTruthy()
    act(() => { plCard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 详情页头出现「☆ 收藏」，未收藏状态
    const collectBtn = [...kgPane.querySelectorAll('.dsh-music-qq-collect-pl')][0]
    expect(collectBtn).toBeTruthy()
    expect(collectBtn.textContent).toContain('收藏')
    expect(collectBtn.disabled).toBe(false)
    // 点击收藏 → POST /dsh-music/kg/playlist-collect
    act(() => { collectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(collectCalls.length).toBe(1)
    expect(collectCalls[0].playlist).toEqual({ specialId: '6409645', creatorId: '2132029040', creatorGid: 'collection_3_2132029040_287_0', name: '周杰伦必听热歌' })
    // 成功后按钮变为「已收藏」并禁用（我的歌单刷新后 originalId 匹配）
    const btn2 = [...kgPane.querySelectorAll('.dsh-music-qq-collect-pl')][0]
    expect(btn2.textContent).toContain('已收藏')
    expect(btn2.disabled).toBe(true)
  })

  it('restores KuGou search history from the Host prefs even when the prefs fetch is slow (panel mounts before snapshot)', async () => {
    // Timing regression: the /dsh-music/prefs snapshot can arrive AFTER the KG panel
    // mounts (like QQ, it is eagerly mounted and hidden with display:none). The mount-time
    // history read then sees an empty snapshot — serverPrefs is still null, so loadPref
    // falls back to the legacy localStorage copy (never written in new builds, so empty) —
    // and without a prefsReady re-read the history stays empty after a refresh. The KG
    // panel's [s.prefsReady] effect must re-apply it once the Host snapshot lands.
    prefsServer = { 'dsh-music-kg-history': JSON.stringify(['刀郎']) }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    // delay ONLY the /dsh-music/prefs GET to simulate network latency
    vi.stubGlobal('fetch', (url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/prefs' && (!opts || !opts.method || opts.method === 'GET')) {
        return new Promise((resolve) => setTimeout(() => resolve(jsonRes({ ok: true, prefs: prefsServer })), 120))
      }
      if (u === '/dsh-music/kg/status') return jsonRes({ loggedIn: true, userid: '123456' })
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    // render the panel immediately (before the 120ms prefs fetch resolves)
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // open panel -> 酷狗 tab -> 搜索 view tab: history must be empty for now
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const kgTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '酷狗音乐')
    act(() => { kgTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const input = container.querySelector('.dsh-music-qq-input')
    expect(input).toBeTruthy()
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(document.querySelectorAll('.dsh-music-qq-hist-item').length).toBe(0)
    // wait for the slow prefs fetch + the prefsReady re-apply, then focus again
    // （160ms 在慢 runner 上与 120ms 延迟竞态偶发失败，放宽到 300ms 消除抖动）
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    act(() => { input.dispatchEvent(new Event('focusin', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const histItems = [...document.querySelectorAll('.dsh-music-qq-hist-item')]
    expect(histItems.some((b) => b.textContent === '刀郎')).toBe(true)
  })

  it('starts a DIFFERENT track from 0 after refresh via the music_play intent (not the old position)', async () => {
    // Regression: after a refresh the player restores the last track PAUSED at its
    // saved position (restoredMusicPos). Switching to a different track via the
    // music_play intent used to leave restoredMusicPos set, so the new track was
    // seeked back to the PREVIOUS song's progress ("换歌从旧进度开始"). The intent
    // play path must drop the restore pin and reset the readout.
    const audios = []
    class IntentAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    let intent = null
    let intentPoll = null
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      if (String(url) === '/dsh-music/intent') return jsonRes(intent)
      return baseFetch(url, opts)
    })
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }),
    }
    manifest = {
      ...baseManifest(),
      tracks: [
        { id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' },
        { id: '1', name: 'b.mp3', url: '/dsh-music/1', size: 20, ext: 'mp3', path: '/music/b.mp3' },
      ],
      count: 2,
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', IntentAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', (cb) => { intentPoll = cb; return 1 })
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // after refresh restore: track 0 is current, paused at 0:42
    const nameSpan = container.querySelector('.dsh-music-bar-name')
    expect(nameSpan.textContent).toContain('a')

    // Host delivers a music_play intent for a DIFFERENT track (id '1').
    expect(intentPoll).toBeTruthy()
    intent = { action: 'play', id: '1', name: 'b.mp3' }
    await act(async () => { await intentPoll() })
    await new Promise((r) => setTimeout(r, 0))
    expect(audio.src).toContain('/dsh-music/1')

    // The new track plays from 0 — simulate a real browser 'play' + timeupdate.
    act(() => { audio.emit('play') })
    audio.currentTime = 0.05
    audio.duration = 100
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    // MUST NOT be re-seeked back to the old 42.
    expect(audio.currentTime).toBeLessThan(1)
  })

  it('starts a different QQ track from 0 after refresh (not the restored local track position)', async () => {
    // Regression: after a refresh a LOCAL track is restored PAUSED at 42
    // (restoredMusicPos set). Switching to an online QQ song used to reach
    // startQQPlayback WITHOUT clearing the pin, so the QQ stream was seeked back
    // to 42. startQQPlayback must drop the restore pin too.
    const audios = []
    class QAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }),
    }
    manifest = baseManifest()
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', QAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    // after refresh restore: local track 0 current, paused at 42
    expect(container.querySelector('.dsh-music-bar-name').textContent).toContain('a')

    // switch to the QQ panel and play an online song
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')

    // simulate a real browser 'play' + timeupdate — must start from ~0, not be seeked to 42
    act(() => { audio.emit('play') })
    audio.currentTime = 0.05
    audio.duration = 240
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })
    expect(audio.currentTime).toBeLessThan(1)
  })

  it('flushes a large QQ queue playback WITHOUT keepalive (64KiB browser limit regression)', async () => {
    // Regression: the playback save embeds the whole QQ queue; a long playlist
    // (800 songs) makes the POST body exceed the browser's 64KiB keepalive cap,
    // which used to make fetch throw and silently drop the playback write.
    // Large payloads must go out with keepalive=false.
    const bigSongs = Array.from({ length: 800 }, (_, i) => ({
      id: 'mid' + i, songmid: 'mid' + i, title: '测试歌曲 ' + i + ' 号', artists: ['测试歌手'], payplay: 0, source: 'qq',
    }))
    // seed the playlist-layer restore so the panel opens the big playlist
    prefsServer = { 'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: 'big', plName: '大队列歌单' }) }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; prefsPostOpts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url).startsWith('/dsh-music/qq/playlist/big')) {
        return jsonRes({ ok: true, playlist: { id: 'big', name: '大队列歌单', creator: '作者', trackCount: 800, source: 'qq', songs: bigSongs } })
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 50))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    // restoreUi loaded the big playlist layer -> click the first song
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('测试歌曲 0 号'))
    expect(song).toBeTruthy()
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // flush debounce

    const saved = JSON.parse(prefsServer['dsh-music-qq-playback'])
    expect(saved.queue.length).toBe(800)
    // the large body must NOT use keepalive (browser would throw >64KiB)
    const playbackPost = prefsPostOpts.find((o) => o.bodyLen > 60 * 1024)
    expect(playbackPost).toBeTruthy()
    expect(playbackPost.keepalive).toBe(false)
  })

  it('retries the restored QQ playlist when the first request returns empty songs (refresh-empty bug)', async () => {
    // Bug: 刷新后恢复歌单层时，QQ 歌单详情接口首次请求常返回空 songlist（冷缓存），
    // restoreUi 只发一次请求且无加载态/重试，导致「刷新后播放列表显示为空」；
    // 返回重进（openPlaylist 第二次请求）才取到完整列表。恢复路径应像 openPlaylist
    // 一样显示加载中并对空结果/失败自动重试。
    const retrySongs = [
      { id: 's1', songmid: 's1', title: '重试歌一', artists: ['歌手A'], payplay: 0, source: 'qq' },
      { id: 's2', songmid: 's2', title: '重试歌二', artists: ['歌手A'], payplay: 0, source: 'qq' },
    ]
    prefsServer = { 'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: 'retrypl', plName: '测试歌单' }) }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    let plCalls = 0
    vi.stubGlobal('fetch', (url, opts) => {
      if (String(url).startsWith('/dsh-music/qq/playlist/retrypl')) {
        plCalls++
        const empty = plCalls === 1
        return jsonRes({ ok: true, playlist: { id: 'retrypl', name: '测试歌单', creator: '作者', trackCount: 2, source: 'qq', songs: empty ? [] : retrySongs } })
      }
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 50))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 给恢复请求 + 重试留出时间（当前代码只有 1 次请求；修复后最多重试几次）
    await new Promise((r) => setTimeout(r, 2200))
    act(() => {})
    // 恢复的歌单层应自动重试并把完整列表显示出来（而不是停在「暂无歌曲」）
    expect(plCalls).toBeGreaterThan(1)
    const songRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('重试歌一'))
    expect(songRow).toBeTruthy()
    expect(container.textContent).not.toContain('暂无歌曲。')
  })

  it('restores the 在线播放列表 (queue) layer with the saved queue after refresh (queue-restore race)', async () => {
    // Bug: 刷新后 restoreUi 恢复「在线播放列表」（plId=''，来自 openQueue 保存）时，
    // prefsReady 置位早于 restorePlayback 把 qqQueue 灌好（loadTracks 先 set prefsReady、
    // 再等 manifest、最后 restoreLatest→灌队列），读取的是空快照 → 直接显示「暂无歌曲」；
    // 返回重进（openQueue）重新读取已就绪的队列才正常。
    prefsServer = {
      'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: '', plName: '' }),
      'dsh-music-qq-playback': JSON.stringify({
        id: 'qq:789', name: '告白气球', artists: ['周杰伦'],
        position: 10, duration: 240,
        queue: [
          { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], payplay: 0, source: 'qq' },
          { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], payplay: 0, source: 'qq' },
        ],
        source: '在线', ts: 999999999,
      }),
    }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', (url, opts) => {
      // 延迟 manifest：让 prefsReady 先到（触发 restoreUi 读空队列），restorePlayback
      // 灌 qqQueue 后到，精确复现竞态。
      if (String(url) === '/dsh-music/manifest') return new Promise((resolve) => setTimeout(() => resolve(jsonRes(manifest)), 300))
      return fetchStub(url, opts)
    })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 等 manifest 延迟（300ms）过后 restorePlayback 已把队列灌进 store
    await new Promise((r) => setTimeout(r, 600))
    act(() => {})
    // 恢复的「在线播放列表」应显示保存的队列歌曲，而不是「暂无歌曲」
    const songRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    expect(songRow).toBeTruthy()
    expect(container.textContent).not.toContain('暂无歌曲。')
  })

  it('shows the persisted online QQ queue even when the refresh restored local music (separate persistence)', async () => {
    // 核心场景：上次播的是本地音乐（本地 ts 最新），但 QQ 队列仍单独保存在
    // dsh-music-qq-playback。刷新后 restoreLatest 恢复本地，打开「在线播放列表」
    // 仍能看到之前保存的 QQ 队列——本地/在线互不影响、互不覆盖。
    prefsServer = {
      'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }),
      'dsh-music-qq-playback': JSON.stringify({
        id: 'qq:789', name: '告白气球', artists: ['周杰伦'],
        position: 10, duration: 240,
        queue: [
          { id: '789', songmid: '789', title: '告白气球', artists: ['周杰伦'], payplay: 0, source: 'qq' },
          { id: '790', songmid: '790', title: '七里香', artists: ['周杰伦'], payplay: 0, source: 'qq' },
        ],
        source: '在线', ts: 100,
      }),
      'dsh-music-scope': JSON.stringify({ kind: 'library' }),
    }
    manifest = { ...baseManifest(), tracks: [{ id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' }] }
    qqLoggedIn = true
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // 刷新恢复了本地音乐（本地 ts 最新 → 恢复本地，tab 停在本地音乐）
    expect(container.querySelector('.dsh-music-tab.active').textContent).toBe('本地音乐')
    // 打开 QQ 面板 → 点「播放列表」打开「在线播放列表」→ 仍能看到持久化的 QQ 队列
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const plBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    expect(plBtn).toBeTruthy()
    act(() => { plBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 显示持久化的 QQ 队列，而不是「暂无歌曲」
    const qqSongRow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    expect(qqSongRow).toBeTruthy()
    expect(container.textContent).not.toContain('暂无歌曲。')
  })

  it('refreshes the local library list via the 刷新 button (manual re-scan)', async () => {
    // 面板「刷新」按钮：点击后调用 /dsh-music/rescan，用返回的新列表替换曲库（无需重选目录）。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      if (String(u) === '/dsh-music/rescan' && o && o.method === 'POST') {
        return jsonRes({
          ok: true, root: '/music', bookRoot: '/books', count: 2,
          tracks: [
            { id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' },
            { id: '1', name: 'b.mp3', url: '/dsh-music/1', size: 12, ext: 'mp3', path: '/music/b.mp3' },
          ],
          books: [], playlists: manifest.playlists, voices: [],
        })
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 初始只有 a.mp3
      expect(container.textContent).toContain('a.mp3')
      expect(container.textContent).not.toContain('b.mp3')
      // 点「刷新」→ 重扫后显示新增的 b.mp3
      const refreshBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '刷新')
      expect(refreshBtn).toBeTruthy()
      act(() => { refreshBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('b.mp3')
      // 播放范围仍为曲库、tab 未被跳走（rescan 只刷列表，不触发 restorePlayback）
      expect(container.querySelector('.dsh-music-tab.active').textContent).toBe('本地音乐')
    } finally {
      window.fetch = origFetch
    }
  })

  it('loads 我的歌单 in its own sub-tab when logged in', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 我的歌单 sub-tab → my playlists load lazily
    const mineTab = await waitForText(container, '.dsh-music-qq-viewtab', '我的歌单')
    expect(mineTab).toBeTruthy()
    act(() => { mineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('我的收藏')
  })

  it('标识 QQ 我的歌单类别：我喜欢→默认、自建→自建', async () => {
    qqLoggedIn = true
    const baseFetch = fetchStub
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/qq/my-playlists') return jsonRes({ ok: true, playlists: [
        { id: '201', name: '我喜欢', creator: '我', trackCount: 14, source: 'qq', dirId: 201, tid: 201, isDefault: true, kind: 'default' },
        { id: '5', name: '我的自建', creator: '我', trackCount: 5, source: 'qq', dirId: 5, tid: 5, isDefault: false, kind: 'own' },
      ] })
      return baseFetch(url, opts)
    })
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const mineTab = await waitForText(container, '.dsh-music-qq-viewtab', '我的歌单')
    act(() => { mineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const likeCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((c) => c.textContent.includes('我喜欢'))
    const ownCard = [...container.querySelectorAll('.dsh-music-playlist-card')].find((c) => c.textContent.includes('我的自建'))
    expect(likeCard).toBeTruthy()
    expect(ownCard).toBeTruthy()
    // 我喜欢（dirId=201）→ 主题色「默认」标签；自建 → 「自建」标签
    const likeTag = likeCard.querySelector('.dsh-music-online-tag.default')
    expect(likeTag).toBeTruthy()
    expect(likeTag.textContent).toBe('默认')
    const ownTag = ownCard.querySelector('.dsh-music-online-tag')
    expect(ownTag).toBeTruthy()
    expect(ownTag.textContent).toBe('自建')
  })

  it('deletes a user playlist via the 我的歌单 card ✕ button after confirmation', async () => {
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 「我的歌单」已自动加载（登录态）→ 找到删除按钮并点击，弹出确认框
    const delBtn = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('我的收藏'))
    expect(delBtn).toBeTruthy()
    act(() => { delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toContain('删除歌单')
    expect(container.textContent).toContain('我的收藏')
    // 点「删除」确认 → 调用 Host 删除接口，卡片被移除
    const confirmDel = [...document.body.querySelectorAll('.dsh-music-picker.confirm .dsh-music-settings-btn')].find((b) => b.textContent === '删除')
    act(() => { confirmDel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(delPlaylistCalls).toEqual([{ dirId: 987 }])
    // mine1 已删除，mine2（第二个歌单）仍保留删除按钮
    expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(1)
    expect(container.textContent).not.toContain('我的收藏')
  })

  it('surfaces an error when deleting a playlist fails, keeping the card', async () => {
    qqLoggedIn = true
    delPlaylistFail = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const delBtn = [...container.querySelectorAll('.dsh-music-qq-mine-del')].find((b) => b.title.includes('我的收藏'))
    act(() => { delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const confirmDel = [...document.body.querySelectorAll('.dsh-music-picker.confirm .dsh-music-settings-btn')].find((b) => b.textContent === '删除')
    act(() => { confirmDel.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(delPlaylistCalls).toEqual([{ dirId: 987 }])
    // 失败时保留卡片并展示错误（两个歌单都保留）
    expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(2)
    expect(container.textContent).toContain('删除失败（模拟）')
  })

  it('shows the delete button ONLY on 我的歌单, never on 推荐/分类/搜索 playlists', async () => {
    // Regression: playRow used to receive the Array#map index as its 2nd arg, so in
    // 推荐/分类/搜索 (which call .map(playRow)) every card past the first wrongly got
    // a delete button. The mine flag must be strict `true` (only 我的歌单 passes it).
    qqLoggedIn = true
    // 让搜索歌单返回多条，验证任意非「我的歌单」来源都不出现删除按钮。
    const origFetch = window.fetch
    window.fetch = (u, o) => {
      const url = String(u)
      if (url.includes('/dsh-music/qq/playlist-search')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, playlists: [
          { id: '1001', name: '搜索歌单甲', creator: 'UP主', trackCount: 10, source: 'qq' },
          { id: '1002', name: '搜索歌单乙', creator: 'UP主', trackCount: 20, source: 'qq' },
          { id: '1003', name: '搜索歌单丙', creator: 'UP主', trackCount: 30, source: 'qq' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }
      return origFetch(u, o)
    }
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // ① 我的歌单：登录自动加载，所有本人创建的歌单都应有删除按钮
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(2)
      // ② 推荐歌单：不应出现任何删除按钮
      const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
      act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('热门推荐')
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(0)
      // ③ 分类歌单：不应出现任何删除按钮
      const categoryTab = await waitForText(container, '.dsh-music-qq-viewtab', '分类歌单')
      act(() => { categoryTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const catChip = [...container.querySelectorAll('.dsh-music-qq-cat')].find((b) => b.textContent === '国语')
      act(() => { catChip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('国语歌单')
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(0)
      // ④ 搜索歌单：多条结果，任意一条都不应出现删除按钮（回归 Array#map index bug）
      const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
      act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const input = container.querySelector('.dsh-music-qq-input')
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, '周杰伦')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
      act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 切到「相关歌单」
      const plTab = [...container.querySelectorAll('.dsh-music-qq-resulttab')].find((b) => b.textContent === '相关歌单')
      act(() => { plTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('搜索歌单甲')
      expect(container.textContent).toContain('搜索歌单乙')
      expect(container.textContent).toContain('搜索歌单丙')
      expect(container.querySelectorAll('.dsh-music-qq-mine-del').length).toBe(0)
    } finally { window.fetch = origFetch }
  })

  it('does NOT fetch QQ data endpoints when not logged in', async () => {
    // Regression: the QQ panel must treat login as the gate — while logged out,
    // opening the QQ tab issues only the local /status probe (host reads the
    // cookie file), never the data endpoints (categories / my-playlists / playlists).
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 未登录：只应请求 /dsh-music/qq/status（本地检测登录态），其余数据接口一律不发
    expect(container.textContent).toContain('QQ 登录') // 登录界面
    const dataEndpoints = ['/dsh-music/qq/my-playlists', '/dsh-music/qq/playlist-categories', '/dsh-music/qq/playlists']
    for (const ep of dataEndpoints) {
      expect(qqFetchLog).not.toContain(ep)
    }
  })

  it('fetches QQ data endpoints automatically once logged in', async () => {
    // When /status reports logged-in, the data endpoints load automatically
    // (categories + my-playlists + recommended) without waiting for a tab click.
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 登录后：我的歌单/分类/推荐均已自动请求
    expect(qqFetchLog).toContain('/dsh-music/qq/my-playlists')
    expect(qqFetchLog).toContain('/dsh-music/qq/playlist-categories')
    expect(qqFetchLog).toContain('/dsh-music/qq/playlists')
  })

  it('auto-advances to the next online QQ track when a track ends', async () => {
    // Regression: online (qq scope) used to return [] from activeIds() so step(1)
    // found no next track and playback stopped after one song. The active queue is
    // now kept in store.qqQueue so a finished track advances to the next one.
    const audios = []
    class DispatchAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', DispatchAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // queue = [789 告白气球, 790 七里香]; play the first online song
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // the track ends -> auto-advance to the next song in the online queue
    act(() => { audio.emit('ended') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/790')
  })

  it('auto-skips to the next online song when the current one fails to load', async () => {
    // Regression: a QQ track whose play URL returns an unplayable stream (版权
    // 下架/拿不到地址) used to stop the whole queue with a generic error. It must
    // auto-advance to the next song instead; only a single-song queue stops.
    const audios = []
    class ErrAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ErrAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // queue = [789 告白气球, 790 七里香]; play the first online song
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 789 加载失败（版权下架）→ 自动跳到下一首 790
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/790')
  })

  it('resets the skip counter when a skipped song plays successfully', async () => {
    // Regression: after auto-skipping a bad track (790), if the next track (789)
    // plays fine the consecutive-error counter must reset. Without the reset, a
    // 好歌↔坏歌 loop triples the count over three rounds and trips the
    // whole-queue-stop guard, halting playback even though 789 plays fine.
    const audios = []
    class ResetAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', ResetAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 播放 789（当作"好歌"）
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 循环三轮「789 播完→790 坏→跳过→789 播放成功」
    for (let round = 0; round < 3; round++) {
      act(() => { audio.emit('ended') })          // 789 播完 → 切到 790
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(audio.src).toContain('/dsh-music/qq/play/790')
      act(() => { audio.emit('error') })          // 790 失败 → 跳过
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(audio.src).toContain('/dsh-music/qq/play/789')
      act(() => { audio.emit('play') })           // 789 成功播放 → 计数清零
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    }
    // 三轮都正常跳过、从未误报整列失败；最终停在 789 且无错误
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    expect(container.textContent).not.toContain('音频加载或解码失败')
  })

  it('stops with an error when the only online song fails to load', async () => {
    // A single-song QQ queue that fails must NOT loop forever: it stops and
    // surfaces the error, so the user knows why playback halted.
    const audios = []
    class SoloAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', SoloAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 只播单曲（queue 只有这一首）：搜索点一首歌
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchTab = await waitForText(container, '.dsh-music-qq-viewtab', '搜索')
    act(() => { searchTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const searchInput = container.querySelector('.dsh-music-qq-input')
    expect(searchInput).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(searchInput, '晴天')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const searchBtn = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '搜索')
    act(() => { searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const srow = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('晴天'))
    expect(srow).toBeTruthy()
    act(() => { srow.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/123')
    // 单曲失败 → 不循环跳歌，停止并报错
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/123')
    expect(container.textContent).toContain('音频加载或解码失败')
  })

  it('stops after trying the whole queue when every online song fails', async () => {
    // Guard against an infinite skip loop: a 2-song queue where BOTH fail must
    // advance through the whole queue (789→790→wrap), then stop with the error
    // instead of cycling forever.
    const audios = []
    class AllBadAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', AllBadAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // 789 失败 → 跳到 790
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/790')
    // 790 也失败 → 队列走完，回绕回 789（这一圈已试完）
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // 789 再失败 → 已达队列长度，停止并报错（不再循环）
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.textContent).toContain('音频加载或解码失败')
    // 停止后即使再报错也不再跳到别处（src 不再变化）
    const srcAfterStop = audio.src
    act(() => { audio.emit('error') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toBe(srcAfterStop)
  })

  it('resumes a restored online QQ track when play is clicked after refresh', async () => {
    // Regression: after a refresh restore the QQ track is remembered, but audio.src
    // was empty so clicking play had nothing to load. togglePlay must reload the
    // online stream URL for a qq: current track.
    const audios = []
    class DispatchAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
    }
    vi.resetModules(); registered = []; lastFilesUrl = null; manifest = baseManifest(); qqLoggedIn = true
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', DispatchAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // default tab is 我的歌单 → switch to 推荐歌单
    const recTab = await waitForText(container, '.dsh-music-qq-viewtab', '推荐歌单')
    act(() => { recTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const row = [...container.querySelectorAll('.dsh-music-playlist-card')].find((b) => b.textContent.includes('热门推荐'))
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const song = [...container.querySelectorAll('.dsh-music-track')].find((b) => b.textContent.includes('告白气球'))
    act(() => { song.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
    // simulate a refresh-restore: fresh audio element, current track still the QQ one
    audio.src = ''
    audio.paused = true
    // click the play button -> togglePlay must reload the online stream URL and play
    const playBtn = [...container.querySelectorAll('.dsh-music-bar-btn')].find((b) => b.title === '播放/暂停')
    expect(playBtn).toBeTruthy()
    act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(audio.src).toContain('/dsh-music/qq/play/789')
  })

  it('starts the QQ login poll after generating a QR (ref-based, no stale closure)', async () => {
    // Regression: schedulePoll/pollLogin previously read qrKey/loginMode from a stale
    // React render closure, so after setQrKey(d.key) the poll saw an empty key and NEVER
    // fired — the modal stayed at the scan screen forever. This asserts the poll is issued.
    const checkCalls = []
    const baseFetch = globalThis.fetch
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/qq/login/start') return jsonRes({ ok: true, key: 'type=wx&uuid=U&state=S', image: 'data:image/jpeg;base64,xxx', mode: 'wx' })
      if (u.includes('/dsh-music/qq/login/check')) { checkCalls.push(u); return jsonRes({ ok: true, status: 'waiting', message: '等待扫码中', extra: {} }) }
      return baseFetch(u, opts)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await Promise.resolve() })
      const wxBtn = [...container.querySelectorAll('.dsh-music-qq-login-btn')].find((b) => b.textContent === '微信登录')
      expect(wxBtn).toBeTruthy()
      act(() => { wxBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // flush the async /start POST into the refs, then fire the 1.5s poll timer
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(2000) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(checkCalls.length).toBeGreaterThan(0)
      expect(checkCalls[0]).toContain('/dsh-music/qq/login/check?key=')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('lands on the main UI after QR login even if a playlist layer was persisted', async () => {
    // Regression: after login the panel used to restore the previously-persisted
    // playlist layer instead of showing the main UI. Login success must reset to main.
    // The persisted layer now lives in the Host prefs; seed it before boot.
    prefsServer = { 'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: '', plName: '' }) }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const baseFetch = globalThis.fetch
    const fetcher = vi.fn((url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/qq/login/start') return jsonRes({ ok: true, key: 'type=wx&uuid=U&state=S', image: 'data:image/jpeg;base64,xxx', mode: 'wx' })
      if (u.includes('/dsh-music/qq/login/check')) return jsonRes({ ok: true, status: 'success', uin: '123456', nickname: '我', loginFrom: 'wx' })
      return baseFetch(u, opts)
    })
    vi.stubGlobal('fetch', fetcher)
    vi.useFakeTimers()
    try {
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
      act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      // start the QR login
      const qqBtn = [...container.querySelectorAll('.dsh-music-qq-login-btn')].find((b) => b.textContent === 'QQ 登录')
      act(() => { qqBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // flush /start, then fire the 1.5s poll which returns success
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      act(() => { vi.advanceTimersByTime(2000) })
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      // should be on the MAIN UI now, not the playlist layer
      expect(container.textContent).toContain('推荐歌单') // a main-UI sub-tab
      expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(false) // not the playlist layer
      // login success reset the persisted layer to 'main'; let the debounced
      // flush (scheduled before fake timers were enabled) complete in real time
      vi.useRealTimers()
      await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
      expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('main')
      // 登录方式随登录流程实时同步到 store：切到「关于」页应显示「已登录（微信）」
      const aboutTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '关于')
      act(() => { aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const qqRow = [...container.querySelectorAll('.dsh-music-about-row')].find((r) => r.textContent.includes('QQ音乐'))
      expect(qqRow.textContent).toContain('已登录（微信）')
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('preserves the QQ playlist layer when switching tabs within a session', async () => {
    // Regression: QQOnlinePanel used to unmount on tab switch; on remount it restored
    // the persisted 'playlist' layer, so switching away and back yanked the user
    // around. With the panel kept mounted (CSS-hidden), layer is component state
    // that survives tab switches: entering the playlist layer and switching away
    // then back must KEEP the user in that layer.
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // enter the playlist layer once -> persisted as 'playlist' (flushed on debounce)
    const enterPl = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    act(() => { enterPl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) })
    expect(JSON.parse(prefsServer['dsh-music-qq-ui']).layer).toBe('playlist')
    // switch to 本地音乐 tab (QQOnlinePanel stays mounted, just hidden)
    const musicTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
    act(() => { musicTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // switch back to QQ音乐 tab -> the playlist layer must be PRESERVED
    const qqTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { qqTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(true) // still in the playlist layer
  })

  it('shows a genuine autoplay-block error exactly once (no duplicate in the settings block)', async () => {
    // A REAL autoplay block (NotAllowedError) must still surface the message —
    // but only once, in the panel list area, never duplicated in the settings block.
    const audios = []
    class BlockedAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      play() {
        this.paused = false
        return Promise.reject(Object.assign(new Error("play() failed because the user didn't interact with the document first: https://goo.gl/xX8pDD"), { name: 'NotAllowedError' }))
      }
    }
    vi.resetModules()
    registered = []
    lastFilesUrl = null
    manifest = baseManifest()
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', BlockedAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = {
      inject: (name, cb) => { cb() },
      register: (meta, elementFactory) => { registered.push({ id: meta.id, elementFactory }); return elementFactory },
    }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))

    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const trackBtn = container.querySelector('.dsh-music-track')
    expect(trackBtn).toBeTruthy()

    act(() => { trackBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) })
    // flush the rejected play() promise -> error state -> re-render
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // the autoplay-block message IS shown (genuine block), exactly once.
    // Note: with all tabs kept mounted (CSS-hidden), the hidden AI讲书 pane may
    // render its own unrelated error (e.g. 未配置xiaomi提供方), so count only
    // the errors whose text is the autoplay-block message.
    const blockErrors = [...container.querySelectorAll('.dsh-music-error')].filter((el) => el.textContent.includes('浏览器拦截'))
    expect(blockErrors.length).toBe(1)
    expect(blockErrors[0].textContent).toContain('自动播放')
  })

  it('keeps the QQ playlist layer when the panel is closed and reopened', async () => {
    // Regression: closing the panel used to unmount it (return null), wiping the
    // QQ panel's component state. With the panel kept mounted (CSS-hidden), the
    // playlist layer must survive a close + reopen cycle.
    qqLoggedIn = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const onlineTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { onlineTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // enter the playlist layer
    const enterPl = [...container.querySelectorAll('.dsh-music-settings-btn')].find((b) => b.textContent === '播放列表')
    expect(enterPl).toBeTruthy()
    act(() => { enterPl.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(true)
    // close the panel (CSS-hide, not unmount)
    act(() => { container.querySelector('button[title="关闭"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    // reopen -> still in the QQ playlist layer (component state preserved)
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const qqTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'QQ音乐')
    act(() => { qqTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect([...container.querySelectorAll('.dsh-music-settings-btn')].some((b) => b.textContent === '← 返回')).toBe(true)
  })

  it('renders the 系统配置 tab with lyric/spectrum/progress toggles defaulting on and persists changes', async () => {
    // Fresh boot: no prefs set -> both toggles default ON.
    prefsServer = {}; vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // switch to the new 系统配置 tab
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    expect(configTab).toBeTruthy()
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // six toggle rows (歌词显示 / 歌词面板透明 / 频谱显示 / 音质徽章显示 / 进度条显示 / 播放条背景显示)，
    // 默认全开；跑马灯/边缘渐隐是内置行为，不再提供开关。
    const toggles = [...container.querySelectorAll('.dsh-music-toggle')]
    expect(toggles.length).toBe(6)
    expect(toggles[0].getAttribute('aria-checked')).toBe('true') // 歌词显示
    expect(toggles[1].getAttribute('aria-checked')).toBe('true') // 歌词面板透明（默认开，紧跟歌词卡片下方）
    expect(toggles[2].getAttribute('aria-checked')).toBe('true') // 频谱显示
    expect(toggles[3].getAttribute('aria-checked')).toBe('true') // 音质徽章显示
    expect(toggles[4].getAttribute('aria-checked')).toBe('true') // 进度条显示
    expect(toggles[5].getAttribute('aria-checked')).toBe('true') // 播放条背景显示

    // 歌词动效分段选择器：四个选项，默认 none（无动效）选中（它排在频谱样式选择器之前）
    const segBtns = [...container.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segBtns.slice(0, 4).map((b) => b.textContent)).toEqual(['无动效', '上滑淡入', '模糊浮入', '卡拉OK'])
    expect(segBtns.slice(0, 4).findIndex((b) => b.classList.contains('on'))).toBe(0)
    act(() => { segBtns[3].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // 卡拉OK
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const fxPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-lyric-fx'])
    expect(fxPost).toBeTruthy()
    expect(fxPost.prefs['dsh-music-lyric-fx']).toBe('karaoke')

    // 频谱样式分段选择器：柱状图/波形图，默认「柱状图」选中；切到「波形图」并持久化。
    expect(segBtns.slice(4).map((b) => b.textContent)).toEqual(['柱状图', '波形图'])
    expect(segBtns.findIndex((b) => b.textContent === '柱状图' && b.classList.contains('on'))).toBe(4)
    act(() => { segBtns[5].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // 波形图
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const vizPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-viz-mode'])
    expect(vizPost).toBeTruthy()
    expect(vizPost.prefs['dsh-music-viz-mode']).toBe('wave')
    expect(prefsServer['dsh-music-viz-mode']).toBe('wave')

    // turn OFF the lyric toggle
    act(() => { toggles[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // turn OFF the lyric-panel ghost toggle（紧跟歌词卡片下方）
    act(() => { toggles[1].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // turn OFF the progress toggle
    act(() => { toggles[4].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // turn OFF the quality toggle
    act(() => { toggles[3].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    // turn OFF the bar-bg toggle
    act(() => { toggles[5].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const lyricPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-lyric'])
    expect(lyricPost).toBeTruthy()
    expect(lyricPost.prefs['dsh-music-show-lyric']).toBe('0')
    expect(prefsServer['dsh-music-show-lyric']).toBe('0')
    const progressPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-progress'])
    expect(progressPost).toBeTruthy()
    expect(progressPost.prefs['dsh-music-show-progress']).toBe('0')
    expect(prefsServer['dsh-music-show-progress']).toBe('0')
    const qualityPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-quality'])
    expect(qualityPost).toBeTruthy()
    expect(qualityPost.prefs['dsh-music-show-quality']).toBe('0')
    expect(prefsServer['dsh-music-show-quality']).toBe('0')
    const barBgPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-show-bar-bg'])
    expect(barBgPost).toBeTruthy()
    expect(barBgPost.prefs['dsh-music-show-bar-bg']).toBe('0')
    expect(prefsServer['dsh-music-show-bar-bg']).toBe('0')
    const ghostPost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-lyric-panel-ghost'])
    expect(ghostPost).toBeTruthy()
    expect(ghostPost.prefs['dsh-music-lyric-panel-ghost']).toBe('0')
    expect(prefsServer['dsh-music-lyric-panel-ghost']).toBe('0')

    // 歌词显示关闭 → 动效配置行联动隐藏（频谱样式选择器仍在，showViz 为开）；重新打开后恢复，
    // 且保留刚才选的 karaoke。
    expect(container.querySelectorAll('.dsh-music-config-seg-btn').length).toBe(2) // 仅频谱样式
    act(() => { toggles[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // lyric ON
    const segRestored = [...container.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segRestored.length).toBe(6)
    expect(segRestored.findIndex((b) => b.classList.contains('on'))).toBe(3) // karaoke remembered
    act(() => { toggles[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // OFF again

    // restart: the saved OFF value must be restored (not defaulted back to on)
    prefsServer = { ...prefsServer, 'dsh-music-show-lyric': '0', 'dsh-music-show-viz': '1', 'dsh-music-show-progress': '0', 'dsh-music-show-quality': '0', 'dsh-music-show-bar-bg': '0', 'dsh-music-lyric-panel-ghost': '0' }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const panel2 = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const bar2 = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const container2 = document.createElement('div')
    document.body.appendChild(container2)
    const root2 = createRoot(container2)
    act(() => { root2.render(React.createElement('div', null, bar2, panel2)) })
    act(() => { container2.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const configTab2 = [...container2.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const toggles2 = [...container2.querySelectorAll('.dsh-music-toggle')]
    expect(toggles2[0].getAttribute('aria-checked')).toBe('false') // lyric restored OFF
    expect(toggles2[1].getAttribute('aria-checked')).toBe('false') // lyric-panel ghost restored OFF
    expect(toggles2[2].getAttribute('aria-checked')).toBe('true')  // viz restored ON
    expect(toggles2[3].getAttribute('aria-checked')).toBe('false') // quality restored OFF
    expect(toggles2[4].getAttribute('aria-checked')).toBe('false') // progress restored OFF
    expect(toggles2[5].getAttribute('aria-checked')).toBe('false') // bar-bg restored OFF
    // 歌词显示恢复为 OFF → 动效配置行随之隐藏；重新打开歌词后出现，且跨重启
    // 恢复了之前选择的 karaoke。
    const segBtns2 = [...container2.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segBtns2.length).toBe(2) // 仅频谱样式（showViz=ON，lyric=OFF）
    act(() => { toggles2[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) }) // lyric ON
    const segShown2 = [...container2.querySelectorAll('.dsh-music-config-seg-btn')]
    expect(segShown2.length).toBe(6)
    expect(segShown2.findIndex((b) => b.classList.contains('on'))).toBe(3) // karaoke restored
    // 频谱样式也在跨重启后恢复为之前选择的「波形图」。
    expect(segShown2.findIndex((b) => b.textContent === '波形图' && b.classList.contains('on'))).toBe(5)
  })

  it('renders the 关于 tab with version, run status, and repo info from the manifest', async () => {
    // manifest 携带版本号 / TTS·QQ·酷狗登录态 → 关于页展示这些运行状态；
    // 并确认关于页不显示「选择音乐目录」设置块（与系统配置页同规格）。
    manifest = {
      ...baseManifest(),
      version: '0.6.7',
      description: '来自 package.json 的插件简介。',
      ttsConfigured: true, ttsReason: 'ok', ttsProvider: 'xiaomi-mimo',
      qqLoggedIn: true, qqUin: '123456', qqNickname: '测试用户', qqLoginFrom: 'wx',
      kgLoggedIn: true,
      books: [{ id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }],
    }
    vi.resetModules(); registered = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    // 侧栏存在「关于」tab；点击后展示关于页
    const aboutTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '关于')
    expect(aboutTab).toBeTruthy()
    act(() => { aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(container.querySelector('.dsh-music-about')).toBeTruthy()

    // 标题 + 版本徽章（取自 manifest）
    expect(container.querySelector('.dsh-music-about-title').textContent).toContain('DSH音乐播放器')
    expect(container.querySelector('.dsh-music-about-ver').textContent).toBe('v0.6.7')

    // 布局：插件名称 + 简介渲染在滚动列表之外（.dsh-music-about-top），不随卡片滚动；
    // 卡片组（.dsh-music-about）位于 .dsh-music-list 滚动列表内，滚动条只出现在卡片区。
    const top = container.querySelector('.dsh-music-about-top')
    const list = container.querySelector('.dsh-music-list')
    const about = container.querySelector('.dsh-music-about')
    expect(top).toBeTruthy()
    expect(about).toBeTruthy()
    expect(top.textContent).toContain('DSH音乐播放器')
    expect(top.textContent).toContain('v0.6.7')
    // 简介来自 manifest 下发的 package.json description（非硬编码）
    expect(top.textContent).toContain('来自 package.json 的插件简介。')
    // 头部在滚动列表之外（list 不包含头部），卡片在列表之内
    expect(list.contains(top)).toBe(false)
    expect(list.contains(about)).toBe(true)
    expect(about.querySelector('.dsh-music-about-card-title').textContent).toBe('运行状态')
    // 头部不含卡片内容（简介里出现的「音乐目录」不算，改用卡片独有文本判断），
    // 列表内的卡片区含全部卡片
    expect(top.textContent).not.toContain('运行状态')
    expect(top.textContent).not.toContain('曲库歌曲')
    expect(about.textContent).toContain('音乐目录')
    expect(about.textContent).not.toContain('功能特性')
    // 仓库地址是可跳转外链（<a target="_blank" rel="noopener noreferrer">）
    const repoLink = container.querySelector('.dsh-music-about-link')
    expect(repoLink).toBeTruthy()
    expect(repoLink.tagName).toBe('A')
    expect(repoLink.getAttribute('href')).toBe('https://github.com/kendu76/dsh-music-player')
    expect(repoLink.getAttribute('target')).toBe('_blank')
    expect(repoLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(repoLink.textContent).toBe('github.com/kendu76/dsh-music-player')

    // 运行状态行：目录 / 计数 / TTS / 登录态都来自 manifest 快照
    const rowText = [...container.querySelectorAll('.dsh-music-about-row')].map((r) => r.textContent)
    expect(rowText.some((t) => t.includes('音乐目录') && t.includes('/music'))).toBe(true)
    expect(rowText.some((t) => t.includes('小说目录') && t.includes('/books'))).toBe(true)
    expect(rowText.some((t) => t.includes('曲库歌曲') && t.includes('1 首'))).toBe(true)
    expect(rowText.some((t) => t.includes('本地小说') && t.includes('1 本'))).toBe(true)
    expect(rowText.some((t) => t.includes('AI 讲书/新闻播报') && t.includes('已配置') && t.includes('xiaomi-mimo'))).toBe(true)
    expect(rowText.some((t) => t.includes('QQ音乐') && t.includes('已登录（微信）') && !t.includes('测试用户'))).toBe(true)
    expect(rowText.some((t) => t.includes('酷狗音乐') && t.includes('已登录'))).toBe(true)

    // 版权 / 仓库信息
    expect(container.textContent).toContain('github.com/kendu76/dsh-music-player')
    expect(container.textContent).toContain('MIT')

    // 关于页不显示「选择音乐目录」设置块（与系统配置页同规格）
    expect(container.textContent).not.toContain('选择音乐目录')
  })

  it('关于页在 AI 讲书未配置时直接显示「未配置」', async () => {
    // 未配置 TTS 提供方：AI 讲书行显示简洁的「未配置」，不展示详细原因文案。
    manifest = { ...baseManifest(), ttsConfigured: false, ttsReason: '未找到xiaomi提供方。请在DSH模型设置中配置。' }
    vi.resetModules(); registered = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const aboutTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '关于')
    act(() => { aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const ttsRow = [...container.querySelectorAll('.dsh-music-about-row')]
      .find((r) => r.textContent.includes('AI 讲书'))
    expect(ttsRow).toBeTruthy()
    expect(ttsRow.textContent).toContain('未配置')
    // 不显示 Host 的详细诊断原因
    expect(ttsRow.textContent).not.toContain('未找到xiaomi提供方')
    expect(ttsRow.textContent).not.toContain('请在DSH模型设置中配置')
  })

  it('关于页的 QQ 登录状态区分微信/QQ 扫码，且不显示昵称或 QQ 号', async () => {
    // 登录方式随 manifest 下发：'wx' 显示「已登录（微信）」、'qq' 显示「已登录（QQ）」、
    // 未知（空）只显示「已登录」；昵称 / QQ 号一律不展示。
    const qqRowText = async (extra) => {
      manifest = { ...baseManifest(), qqLoggedIn: true, qqUin: '123456', qqNickname: '测试用户', ...extra }
      vi.resetModules(); registered = []; lastFilesUrl = null
      await bootClient()
      const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
      const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(React.createElement('div', null, bar, panel)) })
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const aboutTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '关于')
      act(() => { aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      return [...container.querySelectorAll('.dsh-music-about-row')]
        .find((r) => r.textContent.includes('QQ音乐')).textContent
    }
    expect(await qqRowText({ qqLoginFrom: 'wx' })).toContain('已登录（微信）')
    expect(await qqRowText({ qqLoginFrom: 'qq' })).toContain('已登录（QQ）')
    expect(await qqRowText({ qqLoginFrom: '' })).toContain('已登录')
    // 三种情况都不显示昵称 / QQ 号
    for (const from of ['wx', 'qq', '']) {
      const t = await qqRowText({ qqLoginFrom: from })
      expect(t).not.toContain('测试用户')
      expect(t).not.toContain('123456')
    }
  })

  it('renders the 沉浸感 slider defaulting to 50% and persists/restores a custom value', async () => {
    // default: immerse slider present at 50%
    prefsServer = {}; vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const configTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    const range = container.querySelector('.dsh-music-config-range')
    expect(range).toBeTruthy()
    expect(Number(range.value)).toBe(50)
    expect(container.querySelector('.dsh-music-config-val').textContent).toBe('50%')

    // default 50% 沉浸 -> bar opacity var is 1 - 0.5 = 0.5 (半透明)
    const barEl = container.querySelector('.dsh-music-bar')
    expect(Number(barEl.style.getPropertyValue('--dsh-music-immerse'))).toBeCloseTo(0.5, 5)

    // set it to 20% -> persists 0.2 to the Host (React onChange fires on 'input')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(range, '20')
      range.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 950)) }) // debounce flush
    const immersePost = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-immerse'])
    expect(immersePost).toBeTruthy()
    expect(Number(immersePost.prefs['dsh-music-immerse'])).toBeCloseTo(0.2, 5)
    expect(Number(prefsServer['dsh-music-immerse'])).toBeCloseTo(0.2, 5)
    // 20% 沉浸 -> opacity 1 - 0.2 = 0.8（趋向不透明，方向正确）
    expect(Number(barEl.style.getPropertyValue('--dsh-music-immerse'))).toBeCloseTo(0.8, 5)

    // restart: the saved 0.2 must be restored (slider shows 20%)
    prefsServer = { ...prefsServer, 'dsh-music-immerse': '0.2' }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    await bootClient()
    const panel2 = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const bar2 = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const container2 = document.createElement('div')
    document.body.appendChild(container2)
    const root2 = createRoot(container2)
    act(() => { root2.render(React.createElement('div', null, bar2, panel2)) })
    act(() => { container2.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const configTab2 = [...container2.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '系统配置')
    act(() => { configTab2.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const range2 = container2.querySelector('.dsh-music-config-range')
    expect(Number(range2.value)).toBe(20)
    expect(container2.querySelector('.dsh-music-config-val').textContent).toBe('20%')
  })
})

describe('版本更新弹窗（What\'s New）', () => {
  // 带 What's New 四件套的 manifest 夹具。日期/标题与真数据无关，只验证渲染与流转。
  function wnManifest(state) {
    const entry = {
      version: '0.7.3', date: '2026-08-30', title: '测试版本主题',
      sections: [{ type: 'feature', items: ['新功能甲'] }, { type: 'fix', items: ['修复乙'] }],
    }
    return {
      ...baseManifest(),
      version: '0.7.3', description: '测试简介文案',
      whatsNew: entry,
      whatsNewHistory: [
        entry,
        { version: '0.7.1', date: '2026-08-01', sections: [{ type: 'improve', items: ['旧版优化'] }] },
      ],
      whatsNewWelcome: { title: '欢迎使用 DSH 音乐播放器', sections: [{ type: 'feature', items: ['首装卖点一'] }] },
      whatsNewState: state,
    }
  }

  // 挂载播放条 + 播放面板（弹窗 portal 到 body，断言都查 document.body）。
  async function mountPanel() {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    return { container, root }
  }

  it('升级状态：延迟自动弹出当前版更新内容；关闭后写入已看标记', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; prefsServer = {}
    manifest = wnManifest('upgrade')
    await bootClient()
    const { container, root } = await mountPanel()
    try {
      // 首屏数据就绪后 ~600ms 才弹（弹窗 portal 到 body）
      await waitForText(document.body, '.dsh-music-whatsnew-title', '新版本 v0.7.3')
      // 头部常驻插件名：脱离面板也能一眼看出是哪个插件的更新说明
      expect(document.body.querySelector('.dsh-music-whatsnew-app').textContent).toBe('DSH音乐播放器')
      expect(document.body.textContent).toContain('测试版本主题')
      expect(document.body.textContent).toContain('新功能甲')
      expect(document.body.textContent).toContain('修复乙')
      expect(document.body.querySelector('.dsh-music-whatsnew-badge').textContent).toBe('NEW')
      // 历史折叠默认收起（旧版条目不可见），点开后出现
      expect(document.body.textContent).not.toContain('旧版优化')
      const toggle = document.body.querySelector('.dsh-music-whatsnew-hist-toggle')
      act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(document.body.textContent).toContain('旧版优化')
      // CTA 关闭弹窗 + 已看标记经 Host prefs 写出（~800ms 去抖 flush）
      const cta = [...document.body.querySelectorAll('.dsh-music-whatsnew-foot button')]
        .find((b) => b.textContent === '开始体验')
      act(() => { cta.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(document.body.querySelector('.dsh-music-whatsnew')).toBeNull()
      await act(async () => { await new Promise((r) => setTimeout(r, 1000)) })
      const post = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-seen-version'])
      expect(post).toBeTruthy()
      expect(post.prefs['dsh-music-seen-version']).toBe('0.7.3')
      expect(prefsServer['dsh-music-seen-version']).toBe('0.7.3')
    } finally {
      root.unmount(); container.remove()
    }
  })

  it('首装状态：欢迎模式展示卖点（无 NEW 徽章，CTA 为「开始使用」）', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; prefsServer = {}
    manifest = wnManifest('fresh')
    await bootClient()
    const { container, root } = await mountPanel()
    try {
      await waitForText(document.body, '.dsh-music-whatsnew-title', '欢迎使用 DSH 音乐播放器')
      // welcome 标题本身已含插件名，头部不再重复一行
      expect(document.body.querySelector('.dsh-music-whatsnew-app')).toBeNull()
      expect(document.body.textContent).toContain('首装卖点一')
      expect(document.body.querySelector('.dsh-music-whatsnew-badge')).toBeNull()
      const cta = [...document.body.querySelectorAll('.dsh-music-whatsnew-foot button')]
        .find((b) => b.textContent === '开始使用')
      expect(cta).toBeTruthy()
      act(() => { cta.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(document.body.querySelector('.dsh-music-whatsnew')).toBeNull()
    } finally {
      root.unmount(); container.remove()
    }
  })

  it('已看过（seen）：不再自动弹出', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; prefsServer = {}
    manifest = wnManifest('seen')
    await bootClient()
    const { container, root } = await mountPanel()
    try {
      // 越过 600ms 自动触发点后再确认没有弹窗
      await act(async () => { await new Promise((r) => setTimeout(r, 800)) })
      expect(document.body.querySelector('.dsh-music-whatsnew')).toBeNull()
    } finally {
      root.unmount(); container.remove()
    }
  })

  it('降级安装（downgrade）：不弹，且静默把已看标记改写为当前版', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; prefsServer = {}
    manifest = wnManifest('downgrade')
    await bootClient()
    const { container, root } = await mountPanel()
    try {
      await act(async () => { await new Promise((r) => setTimeout(r, 800)) })
      expect(document.body.querySelector('.dsh-music-whatsnew')).toBeNull()
      // 静默补写：避免用户在新旧版本间来回切换时反复被打扰
      await act(async () => { await new Promise((r) => setTimeout(r, 1000)) })
      const post = prefsPosts.find((p) => p.prefs && p.prefs['dsh-music-seen-version'])
      expect(post).toBeTruthy()
      expect(post.prefs['dsh-music-seen-version']).toBe('0.7.3')
    } finally {
      root.unmount(); container.remove()
    }
  })

  it('关于页「更新日志」可手动打开完整历史（history 模式：最新版展开、旧版本默认折叠）', async () => {
    vi.resetModules(); registered = []; prefsPosts = []; prefsServer = {}
    manifest = wnManifest('seen') // seen：确认自动弹不会发生，弹出的只可能是手动入口
    await bootClient()
    const { container, root } = await mountPanel()
    try {
      await act(async () => { await new Promise((r) => setTimeout(r, 800)) })
      expect(document.body.querySelector('.dsh-music-whatsnew')).toBeNull()
      // 打开面板 → 关于 tab → 「更新日志 | 查看」
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const aboutTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '关于')
      act(() => { aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const viewBtn = await waitForText(container, '.dsh-music-about-btn', '查看')
      act(() => { viewBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await waitForText(document.body, '.dsh-music-whatsnew-title', '更新日志')
      // history 模式：中性标题（无 NEW 徽章、无折叠开关）；最新版（v0.7.3）默认展开，
      // 以前版本（v0.7.1）默认折叠——只显示版本头部，点击头部才展开其特性。
      expect(document.body.querySelector('.dsh-music-whatsnew-badge')).toBeNull()
      expect(document.body.querySelector('.dsh-music-whatsnew-hist-toggle')).toBeNull()
      expect(document.body.textContent).toContain('新功能甲') // 最新版内容展开
      expect(document.body.textContent).toContain('v0.7.1') // 旧版本头部可见
      expect(document.body.textContent).not.toContain('旧版优化') // 旧版本特性默认折叠
      // 点旧版本头部 → 展开其特性
      const oldHead = [...document.body.querySelectorAll('.dsh-music-whatsnew-hist-head')]
        .find((el) => el.textContent.includes('v0.7.1'))
      act(() => { oldHead.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(document.body.textContent).toContain('旧版优化')
    } finally {
      root.unmount(); container.remove()
    }
  })
})

// ---- 每日新闻播报页签（NewsPane）冒烟 ----
describe('news pane（新闻播报页签）', () => {
  it('列表层渲染期次（待播徽标/类别 chips/定时状态行）', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      expect(tab).toBeTruthy()
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 状态行：⏰ 每日定时 + 定时任务数（Host 自维护，无同步状态）
      expect(container.textContent).toContain('⏰ 每日定时')
      expect(container.textContent).toContain('1 个定时任务')
      // 期次行：标题 + 待播徽标 + 类别 chips
      expect(container.textContent).toContain('早间新闻播报')
      expect(container.textContent).toContain('待播')
      expect(container.textContent).toContain('热点 2 · 国内 3 · AI 2')
      // 已播的旧期次不显示待播徽标：整卡文本不含「待播」（fixture 第二条 played=true）
      const rows = [...container.querySelectorAll('.dsh-music-news-card')]
      const playedRow = rows.find((r) => r.textContent.includes('晚间新闻播报'))
      expect(playedRow).toBeTruthy()
      expect(playedRow.textContent.includes('待播')).toBe(false)
      // 卡片两行布局：标题行 + 元信息行（时间 · 类别 chips）
      expect(playedRow.querySelector('.dsh-music-news-card-title')).toBeTruthy()
      expect(playedRow.querySelector('.dsh-music-news-card-meta').textContent).toContain('热点 4')
    } finally { }
  })

  it('详情层渲染类别分组条目，可切文字版', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 点期次标题进详情
      const row = [...container.querySelectorAll('.dsh-music-news-card')].find((r) => r.textContent.includes('早间新闻播报'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 详情层结构：头部（返回/操作栏）固定，仅下方内容列表滚动
      const headEl = container.querySelector('.dsh-music-news-head')
      const bodyEl = container.querySelector('.dsh-music-news-body')
      expect(headEl).toBeTruthy()
      expect(bodyEl).toBeTruthy()
      expect(headEl.textContent).toContain('早间新闻播报')
      expect(bodyEl.textContent).toContain('热点（2）')
      // 类别小节 + 条目（meta fixture）
      expect(container.textContent).toContain('热点（2）')
      expect(container.textContent).toContain('1. 政策发布会召开')
      expect(container.textContent).toContain('新华社 · 08:02')
      // 切文字版：来源行 + 免责尾注结构（文字版渲染同一 meta）
      const readBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '文字版')
      expect(readBtn).toBeTruthy()
      act(() => { readBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('2026-05-30 · 共 7 条')
      expect(container.textContent).toContain('—— 新华社 · 08:02')
      // 返回条目视图
      const backBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '◀ 条目视图')
      act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('▶ 播放整期')
    } finally { }
  })

  it('定时编辑器：定时任务卡片/添加弹窗渲染，保存触发 POST', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const statusBtn = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent.includes('⏰ 每日定时'))
      act(() => { statusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 定时任务卡片：时间 + 范围摘要 + 新闻条数 + 立即播放开关 + 操作按钮
      const cards = [...container.querySelectorAll('.dsh-music-news-shift-card')]
      expect(cards.length).toBe(1)
      expect(cards[0].textContent).toContain('08:00')
      // 旧 null scope 兜底展示全部预设类别，不再有「默认 · 」前缀（defaultScope 已退役）
      expect(cards[0].textContent).toContain('热点/国内/国际/科技/财经/体育/娱乐')
      expect(cards[0].textContent.includes('默认 · ')).toBe(false)
      // 卡片展示新闻条数：存量定时任务无 itemCount → 默认 8 条
      expect(cards[0].textContent).toContain('· 8 条')
      expect(cards[0].textContent).toContain('立即播放')
      // 添加定时任务按钮位于定时任务标题右侧，点击弹出设置弹窗（不是平铺在编辑器里）
      const addBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '＋ 添加定时任务')
      expect(addBtn).toBeTruthy()
      act(() => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 弹窗：标题 + 时刻输入 + 新闻条数 + 类别 chips + 确定（其它测试可能残留其它 overlay，按内容定位）
      const overlay = [...document.body.querySelectorAll('.dsh-music-picker-overlay')].find((el) => el.textContent.includes('添加定时任务'))
      expect(overlay).toBeTruthy()
      expect(overlay.textContent).toContain('添加定时任务')
      const timeInput = overlay.querySelector('input[type="time"]')
      expect(timeInput).toBeTruthy()
      // 新闻条数输入：默认 8（1-20 范围）
      const itemInput = overlay.querySelector('input[type="number"]')
      expect(itemInput).toBeTruthy()
      expect(Number(itemInput.value)).toBe(8)
      expect(overlay.textContent).toContain('条（1-20，默认 8')
      const chipBtns = [...overlay.querySelectorAll('.dsh-music-subtab')]
      expect(chipBtns.map((b) => b.textContent).indexOf('热点')).toBeGreaterThanOrEqual(0)
      // 范围必填：新定时任务默认一个类别都不选 → 「添加」禁用（无提示文案，仅按钮置灰）；选一个类别 → 恢复可用
      expect(chipBtns.every((b) => !b.className.includes('active'))).toBe(true)
      const okBtn0 = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '添加')
      expect(okBtn0.disabled).toBe(true)
      expect(overlay.textContent.includes('至少选择一个类别')).toBe(false)
      act(() => { chipBtns[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect([...overlay.querySelectorAll('button')].find((b) => b.textContent === '添加').disabled).toBe(false)
      // 改时刻后确定 → 新增定时任务（编辑器里的卡片从 1 变 2）
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(timeInput, '21:30')
        timeInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const okBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '添加')
      act(() => { okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 弹窗已关闭（overlay 从 DOM 移除；其它测试残留的 overlay 不影响）
      expect(overlay.isConnected).toBe(false)
      const cardsAfter = [...container.querySelectorAll('.dsh-music-news-shift-card')]
      expect(cardsAfter.length).toBe(2)
      expect(container.textContent).toContain('21:30')
      // 已移除全局「默认类别」区块与手动「保存」按钮（编辑即自动保存）
      expect(container.textContent.includes('默认类别')).toBe(false)
      expect([...container.querySelectorAll('button')].some((b) => b.textContent === '保存')).toBe(false)
      // 自动保存：防抖窗口（500ms）过后，POST 已把新增定时任务落盘（含默认新闻条数 8）
      await act(async () => { await new Promise((r) => setTimeout(r, 650)) })
      expect(newsScheduleServer.shifts.length).toBe(2)
      expect(newsScheduleServer.shifts[0].time).toBe('08:00')
      expect(newsScheduleServer.shifts[1].time).toBe('21:30')
      expect(newsScheduleServer.shifts[1].itemCount).toBe(8)
    } finally {
      newsScheduleServer = JSON.parse(JSON.stringify(newsScheduleDefault))
    }
  })

  it('定时编辑器：仅工作日定时任务显示「工作日」徽标，弹窗可勾选并落盘 workdaysOnly', async () => {
    newsScheduleServer = JSON.parse(JSON.stringify(newsScheduleDefault))
    newsScheduleServer.shifts[0].workdaysOnly = true
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const statusBtn = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent.includes('⏰ 每日定时'))
      act(() => { statusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 仅工作日定时任务卡片显示「工作日」徽标
      const cards = [...container.querySelectorAll('.dsh-music-news-shift-card')]
      expect(cards.length).toBe(1)
      expect(cards[0].textContent).toContain('工作日')
      // 添加定时任务弹窗：仅工作日勾选框存在且默认不勾选（排在「收集后立即播放」之后）
      const addBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '＋ 添加定时任务')
      act(() => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const overlay = [...document.body.querySelectorAll('.dsh-music-picker-overlay')].find((el) => el.textContent.includes('添加定时任务'))
      expect(overlay).toBeTruthy()
      expect(overlay.textContent).toContain('仅工作日执行（节假日除外）')
      const wdBoxes = [...overlay.querySelectorAll('input[type="checkbox"]')]
      expect(wdBoxes.length).toBeGreaterThanOrEqual(2)
      const wdBox = wdBoxes[wdBoxes.length - 1]
      expect(wdBox.checked).toBe(false)
      // 选一个类别 + 勾选仅工作日 → 添加 → 自动保存后服务端收到 workdaysOnly: true
      const chipBtns = [...overlay.querySelectorAll('.dsh-music-subtab')]
      act(() => { chipBtns[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      act(() => { wdBox.click() }) // click 触发 React onChange（toggle checked）
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const okBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === '添加')
      act(() => { okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect([...container.querySelectorAll('.dsh-music-news-shift-card')].length).toBe(2)
      await act(async () => { await new Promise((r) => setTimeout(r, 650)) })
      const newShift = newsScheduleServer.shifts.find((s) => s.id !== 's1')
      expect(newShift).toBeTruthy()
      expect(newShift.workdaysOnly).toBe(true)
      // 新定时任务卡片也显示「工作日」徽标
      const cardsAfter = [...container.querySelectorAll('.dsh-music-news-shift-card')]
      const added = cardsAfter.find((c) => c.textContent.includes(newShift.time))
      expect(added.textContent).toContain('工作日')
    } finally {
      newsScheduleServer = JSON.parse(JSON.stringify(newsScheduleDefault))
    }
  })

  it('定时编辑器：收集进行中时 ▶ 置灰显示 ⟳、状态行提示收集中', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      // 模拟一次收集正在运行
      newsRunState = { shiftId: 's1', sessionId: 'news-exec-demo', startedAt: Date.now(), scope: '热点/国内' }
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 列表页签状态行提示收集中：显示定时任务时刻而非内部随机 id
      expect(container.textContent).toContain('08:00 定时任务 收集中')
      expect(container.textContent).not.toContain('s1 收集中')
      // 进入定时编辑器：▶ 全部置灰且显示 ⟳
      const statusBtn = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent.includes('⏰ 每日定时'))
      act(() => { statusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const runBtns = [...container.querySelectorAll('.dsh-music-news-shift-card button')].filter((b) => b.textContent === '⟳')
      expect(runBtns.length).toBe(newsScheduleServer.shifts.length)
      expect(runBtns.every((b) => b.disabled)).toBe(true)
      expect(runBtns[0].title).toContain('收集进行中')
      // 运行中不出现可点的 ▶（恢复路径 run=null → ▶ 可点由空闲态用例覆盖）
      expect([...container.querySelectorAll('.dsh-music-news-shift-card button')].filter((b) => b.textContent === '▶').length).toBe(0)
    } finally {
      newsRunState = null
    }
  })

  it('添加定时任务：自定义主题输入即生效，无需回车（保存时自动收进 topics）', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const statusBtn = [...container.querySelectorAll('.dsh-music-subtab')].find((b) => b.textContent.includes('⏰ 每日定时'))
      act(() => { statusBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const addBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '＋ 添加定时任务')
      act(() => { addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const overlay = [...document.body.querySelectorAll('.dsh-music-picker-overlay')].find((el) => el.textContent.includes('添加定时任务'))
      expect(overlay).toBeTruthy()
      // 不选类别、主题输入框为空 → 「添加」禁用
      expect([...overlay.querySelectorAll('button')].find((b) => b.textContent === '添加').disabled).toBe(true)
      // 仅输入主题文本（不按回车）→ 「添加」即可点击
      const topicInput = overlay.querySelector('input[placeholder="如 AI、新能源汽车"]')
      expect(topicInput).toBeTruthy()
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(topicInput, 'AI')
        topicInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect([...overlay.querySelectorAll('button')].find((b) => b.textContent === '添加').disabled).toBe(false)
      // 直接点添加（不回车）→ 主题收进定时任务范围：topics=['AI']、categories=[]
      act(() => { [...overlay.querySelectorAll('button')].find((b) => b.textContent === '添加').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(overlay.isConnected).toBe(false)
      await act(async () => { await new Promise((r) => setTimeout(r, 650)) }) // 等防抖自动保存落盘
      expect(newsScheduleServer.shifts.length).toBe(2)
      expect(newsScheduleServer.shifts[1].scope.categories).toEqual([])
      expect(newsScheduleServer.shifts[1].scope.topics).toEqual(['AI'])
    } finally {
      newsScheduleServer = JSON.parse(JSON.stringify(newsScheduleDefault))
    }
  })

  it('新闻播完自动切回被打断的讲书（进度续播 + 字幕重载）', async () => {
    bookTextFixture = '小说块字幕。'
    manifest = {
      ...baseManifest(),
      ttsConfigured: true, ttsReason: '',
      books: [{ id: 'b1', name: '测试小说.txt', url: '/dsh-music/book/b1', size: 100, ext: 'txt' }],
    }
    // 讲书进度：播到第 2 块（分键持久化，新闻播放不覆盖）
    prefsServer = { 'dsh-music-books-playback': JSON.stringify({ '测试小说.txt': { from: 2, base: 30, pos: 0, total: 25, ts: 999999999 } }) }
    const audios = []
    class BAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    const textFetches = []
    let intent = null
    let intentPoll = null
    const baseFetch = fetchStub
    const fetcher = (url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/intent') return jsonRes(intent)
      if (u.includes('/text?from=')) textFetches.push(u)
      return baseFetch(url, opts)
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', BAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', (cb) => { intentPoll = cb; return 1 })
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const tick = () => new Promise((r) => setTimeout(r, 0))

    // (1) 讲书在播：b1 从第 2 块续播
    intent = { action: 'play', id: 'b1', name: '测试小说' }
    await act(async () => { await intentPoll() })
    await tick(); await tick()
    expect(audio.src).toContain('/dsh-music/book/b1')
    expect(audio.src).toContain('from=2')
    act(() => { audio.emit('play') })

    // (2) 定时任务新闻自动播报打断讲书
    intent = { action: 'play', kind: 'news', id: 'news-20260530-0800-abcd' }
    await act(async () => { await intentPoll() })
    await tick(); await tick()
    expect(audio.src).toContain('/dsh-music/news/news-20260530-0800-abcd')
    act(() => { audio.emit('play') })

    // (3) 新闻 4 块逐块 ended → 最后一块自然播完触发恢复
    for (let i = 0; i < 4; i++) {
      act(() => { audio.emit('ended') })
      await tick(); await tick()
    }

    // (4) 断言：切回 b1 并回到第 2 块进度；该块字幕重新加载（fetch /text?from=2）
    expect(audio.src).toContain('/dsh-music/book/b1')
    expect(audio.src).toContain('from=2')
    expect(audio.src).not.toContain('/dsh-music/news/')
    expect(textFetches.some((u) => u.includes('/dsh-music/book/b1/text?from=2'))).toBe(true)
    expect(container.querySelector('.dsh-music-bar-name').textContent).toContain('测试小说')
  })

  it('新闻列表：点击整行任意位置都进详情；行内按钮不误触导航', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 点击行容器自身（不点内部文字）→ 进入详情
      const row = container.querySelector('.dsh-music-news-body .dsh-music-news-card')
      expect(row.querySelector('.dsh-music-news-card-title')).toBeTruthy()
      expect(row.querySelector('.dsh-music-news-card-meta').textContent).toContain('热点')
      expect(row).toBeTruthy()
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('文字版') // 详情页切换按钮
      // 返回列表，点行内 🗑：仅弹删除确认，不进入详情（stopPropagation 生效）
      const backBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '← 返回')
      expect(backBtn).toBeTruthy()
      act(() => { backBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const delBtn = [...container.querySelectorAll('.dsh-music-news-body .dsh-music-news-card button')].find((b) => b.title === '删除')
      act(() => { delBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.textContent).toContain('确定删除这一期新闻简报吗')
      expect(container.textContent).not.toContain('文字版')
    } finally { }
  })

  it('新闻播完自动切回被打断的本地音乐（断点续播）', async () => {
    // 场景：音乐播放中 → 定时任务新闻自动播报（intent）→ 新闻自然播完 → 音乐从断点恢复。
    bookTextFixture = '新闻块字幕。'
    manifest = {
      ...baseManifest(),
      ttsConfigured: true, ttsReason: '', books: [],
      tracks: [
        { id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' },
        { id: '1', name: 'b.mp3', url: '/dsh-music/1', size: 20, ext: 'mp3', path: '/music/b.mp3' },
      ],
      count: 2,
    }
    // 音乐断点持久化：a.mp3 播到 42s（savePlayback 分键存储，新闻播放不覆盖它）
    prefsServer = { 'dsh-music-playback': JSON.stringify({ id: '0', name: 'a.mp3', position: 42, duration: 210, ts: 999999999 }) }
    const audios = []
    class RAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    // 提供真歌词：验证续播后歌词会重新加载（stop 清 lyricTrackId → 守卫失效重取）
    lyricFixture = { ok: true, hasLrc: true, lrc: '[00:01.00]测试歌词第一行' }
    const lyricFetches = []
    let intent = null
    let intentPoll = null
    const baseFetch = fetchStub
    const fetcher = (url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/intent') return jsonRes(intent)
      if (u.startsWith('/dsh-music/lyric?path=')) lyricFetches.push(u)
      return baseFetch(url, opts)
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', RAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', (cb) => { intentPoll = cb; return 1 })
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const tick = () => new Promise((r) => setTimeout(r, 0))

    // (1) 音乐在播：a.mp3（推进到 42s）
    intent = { action: 'play', id: '0', name: 'a.mp3' }
    await act(async () => { await intentPoll() })
    await tick()
    expect(audio.src).toContain('/dsh-music/0')
    act(() => { audio.emit('play') })
    audio.currentTime = 42
    audio.duration = 210
    act(() => { audio.emit('durationchange') })
    act(() => { audio.emit('timeupdate') })

    // (2) 定时任务新闻自动播报（intent）打断音乐 → 虚拟书管线接管
    intent = { action: 'play', kind: 'news', id: 'news-20260530-0800-abcd' }
    await act(async () => { await intentPoll() })
    await tick(); await tick()
    expect(audio.src).toContain('/dsh-music/news/news-20260530-0800-abcd')
    act(() => { audio.emit('play') })

    // (3) 新闻共 4 块，逐块 ended：最后一块自然播完 → 触发恢复
    for (let i = 0; i < 4; i++) {
      act(() => { audio.emit('ended') })
      await tick(); await tick()
    }

    // (4) 断言：切回 a.mp3 并 seek 到 42s 断点继续
    expect(audio.src).toContain('/dsh-music/0')
    expect(audio.src).not.toContain('/dsh-music/news/')
    expect(audio.currentTime).toBe(42)
    expect(container.querySelector('.dsh-music-bar-name').textContent).toContain('a')
    // 歌词重载：音乐起播 1 次 + 新闻播完续播再加载 1 次（stop 清 lyricTrackId 后守卫放行）
    await tick()
    expect(lyricFetches.length).toBeGreaterThanOrEqual(2)
  })

  it('新闻播完自动切回被打断的网络电台（直播流重新拉流续播）', async () => {
    // 场景：电台播放中 → 定时任务新闻自动播报（intent）→ 新闻自然播完 → 回到电台继续播。
    // 回归：snapshotNewsResume 曾漏掉 radio: 前缀，电台被当成 music → 恢复成本地音乐。
    bookTextFixture = '新闻块字幕。'
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [], tracks: [
      { id: '0', name: 'a.mp3', url: '/dsh-music/0', size: 10, ext: 'mp3', path: '/music/a.mp3' },
    ], count: 1 }
    prefsServer = {}
    const audios = []
    class RAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    let intent = null
    let intentPoll = null
    const baseFetch = fetchStub
    const fetcher = (url, opts) => {
      const u = String(url)
      if (u === '/dsh-music/intent') return jsonRes(intent)
      return baseFetch(url, opts)
    }
    vi.resetModules(); registered = []; prefsPosts = []; lastFilesUrl = null
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', RAudio)
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', (cb) => { intentPoll = cb; return 1 })
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true; window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (n, cb) => cb(), register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const audio = audios[0]
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    const tick = () => new Promise((r) => setTimeout(r, 0))

    // (1) 电台在播：radio intent（China Plus 纯流台）
    intent = { action: 'play', kind: 'radio', id: 'r1', name: 'China Plus', radioUrl: 'https://radio.example/live.mp3', codec: 'MP3', bitrate: 128, source: 'radio', hls: false }
    await act(async () => { await intentPoll() })
    await tick()
    expect(audio.src).toContain('/dsh-music/radio/play?u=')
    act(() => { audio.emit('play') })

    // (2) 定时任务新闻自动播报打断电台 → 虚拟书管线接管
    intent = { action: 'play', kind: 'news', id: 'news-20260530-0800-abcd' }
    await act(async () => { await intentPoll() })
    await tick(); await tick()
    expect(audio.src).toContain('/dsh-music/news/news-20260530-0800-abcd')
    act(() => { audio.emit('play') })

    // (3) 新闻 4 块逐块 ended → 自然播完触发恢复
    for (let i = 0; i < 4; i++) {
      act(() => { audio.emit('ended') })
      await tick(); await tick()
    }

    // (4) 断言：切回电台（/radio/play），而不是本地音乐 /dsh-music/0，也不是 news
    expect(audio.src).toContain('/dsh-music/radio/play?u=')
    expect(audio.src).not.toContain('/dsh-music/news/')
    expect(audio.src).not.toContain('/dsh-music/0')
  })

  it('新闻期次播放时显示字幕（走 /dsh-music/news/<id>/text 而非 /dsh-music/book/）', async () => {
    // Regression：loadBookSubtitle 曾硬编码 /dsh-music/book/<id>/text；新闻期次是虚拟书
    // （url=/dsh-music/news/<id>），打到不存在的路由 → 无声幕。现改用 book.url 作基座。
    bookTextFixture = '这是新闻播报的块字幕文本。'
    manifest = { ...baseManifest(), ttsConfigured: true, ttsReason: '', books: [] }
    const audios = []
    class NewsAudio extends FakeAudio {
      constructor() { super(); audios.push(this) }
      emit(type) { (this.listeners[type] || []).forEach((fn) => fn({ target: this })) }
    }
    window.__ModuleLoader__ = { load: (def) => { factory = def.factory } }
    vi.stubGlobal('Audio', NewsAudio)
    vi.stubGlobal('fetch', fetchStub)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
    vi.stubGlobal('setInterval', () => 0)
    vi.stubGlobal('clearInterval', () => {})
    window.confirm = () => true
    window.prompt = () => null
    await import('../lib/client.js')
    const modExports = factory((name) => (name === 'react' ? React : undefined))
    const slots = { inject: (name, cb) => { cb() }, register: (meta, ef) => { registered.push({ id: meta.id, elementFactory: ef }); return ef } }
    modExports.apply({ get: (k) => (k === 'slots' ? slots : undefined), effect: (fn) => fn() })
    await new Promise((r) => setTimeout(r, 0))
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const row = [...container.querySelectorAll('.dsh-music-news-card')].find((r) => r.textContent.includes('早间新闻播报'))
      act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const playBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '▶ 播放整期')
      act(() => { playBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 给媒体时长与位置，触发 updateLyric 选第 0 句
      const audio = audios[0]
      if (audio) { audio.duration = 10; audio.currentTime = 0; act(() => { audio.emit('timeupdate') }) }
      const lyric = container.querySelector('.dsh-music-bar-lyric')
      expect(lyric).toBeTruthy()
      expect(lyric.textContent).toContain('这是新闻播报')
    } finally {
      bookTextFixture = ''
    }
  })

  it('各 tab 底部提示（本地音乐/AI讲书/新闻播报/关于）统一使用 tts-hint 页脚，样式与文本风格一致', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      // AI讲书：底部编号列表，格式说明排首位
      const bookTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === 'AI讲书')
      expect(bookTab).toBeTruthy()
      act(() => { bookTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const bookHint = container.querySelector('.dsh-music-tts-hint')
      expect(bookHint).toBeTruthy()
      expect(bookHint.textContent).toContain('1. 支持 .txt / .epub 等格式。')
      expect(bookHint.textContent).toContain('2. AI 语音目前仅支持 xiaomi 提供方（限时免费），请在 DSH 设置中配置好再使用。')
      // 新闻播报：底部为编号列表（xiaomi 语音 + DeepSeek 搜索提示，分行显示）
      const newsTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { newsTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const newsHint = container.querySelector('.dsh-music-tts-hint')
      expect(newsHint).toBeTruthy()
      expect(newsHint.textContent).toContain('1. AI 语音目前仅支持 xiaomi 提供方（限时免费），请在 DSH 设置中配置好再使用。')
      expect(newsHint.textContent).toContain('2. 新闻收集需要 DeepSeek 搜索服务（web_search 使用 DeepSeek 官方 API），请在 DSH 设置中配置好再使用。')
      expect(newsHint.textContent.includes('支持 .txt')).toBe(false)
      // 本地音乐：底部为单条格式说明（顶部设置块不再显示提示）
      const musicTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '本地音乐')
      act(() => { musicTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const musicHint = container.querySelector('.dsh-music-tts-hint')
      expect(musicHint).toBeTruthy()
      expect(musicHint.textContent).toContain('支持 mp3 / m4a / flac / wav / ogg / opus / aac / webm 等格式，自动递归扫描子目录。')
      // 关于页：免责声明也在底部统一 tts-hint 页脚（与其它 tab 同款式）
      const aboutTab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '关于')
      act(() => { aboutTab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const aboutHint = container.querySelector('.dsh-music-tts-hint')
      expect(aboutHint).toBeTruthy()
      expect(aboutHint.textContent).toContain('在线音乐功能通过非官方接口访问，内容版权归版权方及平台所有，仅供个人学习、技术研究与日常试听，严禁商业用途与二次分发；账号风控与法律风险由使用者自行承担。')
      expect(container.querySelector('.dsh-music-about-note')).toBeNull() // 已并入统一页脚，不再有独立 note
    } finally { }
  })

  it('失败提示行：展示最近失败并带「✕」清除按钮，点击后清空并消失', async () => {
    const bar = registered.find((r) => r.id === 'music-player-bar').elementFactory()
    const panel = registered.find((r) => r.id === 'music-player-panel').elementFactory()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(React.createElement('div', null, bar, panel)) })
    try {
      // 预置一条收集失败（如搜索余额不足），新闻列表页定时状态行下方显示失败行
      newsFailuresServer = [{ ts: Date.now() - 60e3, shiftId: 's1', kind: 'error', reason: 'HTTP 402 Insufficient Balance' }]
      act(() => { container.querySelector('button[title="打开播放列表"]').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      const tab = [...container.querySelectorAll('.dsh-music-tab')].find((b) => b.textContent === '新闻播报')
      act(() => { tab.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      // 失败行渲染：⚠ + 时间 + 收集失败 + 原因，带 ✕ 按钮
      const failureEl = container.querySelector('.dsh-music-news-failure')
      expect(failureEl).toBeTruthy()
      expect(failureEl.textContent).toContain('收集失败')
      expect(failureEl.textContent).toContain('HTTP 402 Insufficient Balance')
      const closeBtn = failureEl.querySelector('.dsh-music-news-failure-close')
      expect(closeBtn).toBeTruthy()
      expect(closeBtn.textContent).toBe('✕')
      // 点击 ✕ → 调 /failures/clear → 失败行消失
      act(() => { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(newsFailuresServer.length).toBe(0) // mock 端已清空
      expect(container.querySelector('.dsh-music-news-failure')).toBeNull() // 展示同步消失
    } finally { }
  })
})
