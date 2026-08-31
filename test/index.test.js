/**
 * Unit/integration tests for the dsh-music-player host half (lib/index.js).
 *
 * Strategy: drive the plugin's real `apply()` with a fake `ctx` whose `webServer`
 * captures the registered HTTP handler, and whose `fs` is backed by on-disk files
 * in a temporary directory. This exercises the actual route logic — manifest,
 * set-root, Range/seek streaming, 404, HEAD — against real bytes.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as QRC from '../lib/qrc.js'

import {
  apply, parseBookStructure, splitBookChunks, parseLrc, MAX_TTS_CHARS,
  zipEntries, zipReadEntry, htmlToText, decodeEntities, readEpubBuffer, qqQualityLabel,
  parseAudioMeta, audioQualityLabel, extractEmbeddedLyric, splitTranslatedLyric,
} from '../lib/index.js'

// ---- tiny fake HTTP req/res (enough for the plugin's routes) ----
function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  // readBody does `for await (const chunk of req)` over body
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}

function makeRes() {
  const calls = []
  const res = {
    status: 200,
    headers: {},
    body: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = { ...(headers || {}) }
    },
    end(data) { res.body = data === undefined ? null : data },
  }
  calls.push(res)
  return res
}

// ---- mock ctx.fs backed by a real temp directory ----
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
      return readdirSync(dir, { withFileTypes: true }).map((e) => {
        const target = join(dir, e.name)
        const s = statSync(target)
        return {
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          target,
          size: s.size,
        }
      })
    },
    async readBytes(target, _offset, _size) { return readFileSync(target) },
  }
}

// ---- minimal ZIP writer (stored or deflate) + EPUB fixture builder ----
// Used to construct real EPUB byte buffers on the fly so the host's epub reader
// (and the /book routes against a real .epub file) can be tested end-to-end.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function buildZip(entries, compress = false) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    let data = e.data
    let method = 0
    if (compress) { data = deflateRawSync(data); method = 8 }
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // sig
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed size
    local.writeUInt32LE(e.data.length, 22) // uncompressed size
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    chunks.push(local, name, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // sig
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8) // flags
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(0, 12) // mod time
    cd.writeUInt16LE(0, 14) // mod date
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30) // extra len
    cd.writeUInt16LE(0, 32) // comment len
    cd.writeUInt16LE(0, 34) // disk number
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42) // local header offset
    central.push(cd, name)
    offset += 30 + name.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const cdOffset = offset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // sig
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([Buffer.concat(chunks), cdBuf, eocd])
}

// Build a minimal-but-standard EPUB buffer. `chapters` is an array of XHTML
// body strings (or { body, media } objects). Options: `compress` (deflate the
// zip), `spineLinear` ({ ch0: 'no' } marks an itemref linear="no"),
// `encryptedPaths` (paths listed in META-INF/encryption.xml, e.g. DRM), and
// `nsPrefix` (e.g. 'opf' → <opf:item>/<opf:itemref> namespace-prefixed tags,
// as some real-world EPUB2 files are written).
function buildEpub({ title = '测试之书', author = '测试作者', chapters = [], compress = false, spineLinear = {}, encryptedPaths = [], nsPrefix = '' } = {}) {
  const files = []
  files.push({ name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8') })
  files.push({
    name: 'META-INF/container.xml',
    data: Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`, 'utf8'),
  })
  const P = nsPrefix === '' ? '' : nsPrefix + ':'
  const items = []
  const spine = []
  chapters.forEach((ch, i) => {
    const c = typeof ch === 'string' ? { body: ch } : ch
    const id = 'ch' + i
    const href = 'ch' + i + '.xhtml'
    const media = c.media || 'application/xhtml+xml'
    items.push(`<${P}item id="${id}" href="${href}" media-type="${media}"/>`)
    const linear = spineLinear[id] === 'no' ? ' linear="no"' : ''
    spine.push(`<${P}itemref idref="${id}"${linear}/>`)
    files.push({ name: 'OEBPS/' + href, data: Buffer.from(c.body, 'utf8') })
  })
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>${items.join('\n    ')}</manifest>
  <spine>${spine.join('\n    ')}</spine>
</package>`
  files.push({ name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') })
  if (encryptedPaths.length > 0) {
    files.push({
      name: 'META-INF/encryption.xml',
      data: Buffer.from(`<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
${encryptedPaths.map((p) => `<enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="${p}"/></enc:CipherData></enc:EncryptedData>`).join('\n')}
</encryption>`, 'utf8'),
    })
  }
  return buildZip(files, compress)
}

// A realistic chapter XHTML used by most epub fixtures below.
const epubChapter = (heading, body, extraHead = '') => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${heading}</title><style>p { color: red }</style></head>
<body>${extraHead}<h1>${heading}</h1><p>${body}</p></body></html>`

// ---- build a ctx + boot a plugin instance against a temp "home" ----
function boot({ files = {}, musicFiles = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-music-test-'))

  // default music root = <home>/Music, mirroring the plugin's default.
  const musicDir = join(home, 'Music')
  mkdirSync(musicDir, { recursive: true })
  for (const [name, content] of Object.entries(musicFiles)) {
    writeFileSync(join(musicDir, name), content)
  }
  // any extra paths from `files` (relative to home)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(home, rel)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }

  // env-controlled state file location; saved before apply() reads HOME via shell.
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')

  const fs = makeFs(home)
  const registered = []
  const tools = []
  const loader = {
    name: 'test-loader',
    ctx: {
      shell: {
        resolve: (o) => o,
        run: async () => ({ stdout: { text: home } }),
      },
      fs,
      webServer: {
        register: (row) => { registered.push(row) },
      },
      tools: {
        register: (tool) => { tools.push(tool) },
      },
      systemPrompt: {
        section: () => {},
      },
      effect: (fn) => { fn() },
    },
  }

  apply(loader.ctx)

  const routes = registered.filter((r) => r.kind === 'prefix' && r.path === '/dsh-music')
  const handler = routes.length > 0 ? routes[0].handler : null

  const cleanup = () => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    if (prevDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevDshHome
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }

  return { home, musicDir, handler, tools, cleanup }
}

afterEach(() => { /* cleanup handled per-boot to avoid cross-test state */ })

describe('dsh-music-player host routes', () => {
  it('reports the scanned library via /dsh-music/manifest', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'a.mp3': 'AUDIO-A', 'b.flac': 'AUDIO-B' },
    })
    try {
      expect(handler).toBeTruthy()
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.count).toBe(2)
      expect(data.root).toBe(musicDir)
      const names = data.tracks.map((t) => t.name).sort()
      expect(names).toEqual(['a.mp3', 'b.flac'])
      // 关于页数据源：manifest 下发插件版本号、简介（package.json description）与酷狗登录态。
      expect(typeof data.version).toBe('string')
      expect(data.version.length).toBeGreaterThan(0)
      expect(typeof data.description).toBe('string')
      expect(data.description.length).toBeGreaterThan(0)
      expect(data.kgLoggedIn).toBe(false)
      // 未登录时 QQ 登录方式为空字符串（'qq'/'wx' 仅在登录成功后写入）。
      expect(data.qqLoginFrom).toBe('')
    } finally { cleanup() }
  })

  it('persists playback prefs to the Host via /dsh-music/prefs', async () => {
    const { home, handler, cleanup } = boot()
    try {
      // fresh boot -> empty snapshot
      const res0 = makeRes()
      await handler(makeReq({ url: '/dsh-music/prefs' }), res0)
      expect(JSON.parse(res0.body)).toEqual({ ok: true, prefs: {} })

      // POST merges known string values
      const res1 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: { 'dsh-music-volume': '0.65', 'dsh-music-mode': 'shuffle', 'dsh-music-voice': '碧瑶' } }) }),
        res1,
      )
      const d1 = JSON.parse(res1.body)
      expect(d1.ok).toBe(true)
      expect(d1.prefs['dsh-music-volume']).toBe('0.65')
      expect(d1.prefs['dsh-music-mode']).toBe('shuffle')
      expect(d1.prefs['dsh-music-voice']).toBe('碧瑶')

      // the state is written to disk under DSH_HOME (survives restarts)
      const prefsFile = join(home, '.dsh', 'music-player-prefs.json')
      expect(existsSync(prefsFile)).toBe(true)
      const onDisk = JSON.parse(readFileSync(prefsFile, 'utf8'))
      expect(onDisk.prefs['dsh-music-mode']).toBe('shuffle')

      // GET reflects the persisted snapshot
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/prefs' }), res2)
      const d2 = JSON.parse(res2.body)
      expect(d2.prefs['dsh-music-volume']).toBe('0.65')

      // remove clears a key without touching the others
      const res3 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ remove: ['dsh-music-mode'] }) }),
        res3,
      )
      const d3 = JSON.parse(res3.body)
      expect('dsh-music-mode' in d3.prefs).toBe(false)
      expect(d3.prefs['dsh-music-volume']).toBe('0.65')
    } finally { cleanup() }
  })

  it('sanitizes prefs: drops unknown keys, invalid volume/mode and oversize values', async () => {
    const { handler, cleanup } = boot()
    try {
      const big = 'x'.repeat(300 * 1024)
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: { 'evil-key': '1', 'dsh-music-volume': '1.5', 'dsh-music-mode': 'bogus', 'dsh-music-playback': big } }) }),
        res,
      )
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect('evil-key' in d.prefs).toBe(false)        // not in the allowlist
      expect(d.prefs['dsh-music-volume']).toBe('1')     // clamped to 0..1
      expect('dsh-music-mode' in d.prefs).toBe(false)   // invalid mode dropped
      expect('dsh-music-playback' in d.prefs).toBe(false) // oversize dropped
    } finally { cleanup() }
  })

  it('accepts QQ-related prefs (qq-fav / qq-history / qq-ui) through the allowlist', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-qq-fav': JSON.stringify({ ids: [1, 2], mids: ['a', 'b'] }),
          'dsh-music-qq-history': JSON.stringify(['周杰伦', '七里香']),
          'dsh-music-qq-ui': JSON.stringify({ layer: 'playlist', plId: 'x', plName: '歌单' }),
        } }) }),
        res,
      )
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(JSON.parse(d.prefs['dsh-music-qq-fav']).mids).toEqual(['a', 'b'])
      expect(JSON.parse(d.prefs['dsh-music-qq-history'])).toContain('周杰伦')
      expect(JSON.parse(d.prefs['dsh-music-qq-ui']).layer).toBe('playlist')
    } finally { cleanup() }
  })

  it('accepts KuGou-related prefs (kg-playback / kg-history) through the allowlist (persistence regression)', async () => {
    // 回归：酷狗播放进度+队列曾漏出 Host 白名单，POST 被 sanitizePrefs 静默丢弃，
    // 导致「播酷狗时刷新页面，播放条恢复成 QQ 音乐」（restoreLatest 找不到酷狗记录、
    // kgTs=-1，回退到时间戳最新的 QQ 记录）。kg-playback / kg-history 必须能存、
    // 能 GET 回读——否则刷新后酷狗播放数据不落盘。
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-kg-playback': JSON.stringify({ id: 'kg:abc123', name: '晴天', artists: ['周杰伦'], position: 42, duration: 260, queue: [{ hash: 'abc123', title: '晴天', artists: ['周杰伦'] }], source: '在线', ts: 1234567890 }),
          'dsh-music-kg-history': JSON.stringify(['周杰伦', '酷狗热搜']),
        } }) }),
        res,
      )
      let d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      const saved = JSON.parse(d.prefs['dsh-music-kg-playback'])
      expect(saved.id).toBe('kg:abc123')
      expect(saved.position).toBe(42)
      expect(saved.queue[0].hash).toBe('abc123')
      expect(JSON.parse(d.prefs['dsh-music-kg-history'])).toContain('周杰伦')
      // GET 回读：快照里确实持久化了酷狗记录
      const g = makeRes()
      await handler(makeReq({ method: 'GET', url: '/dsh-music/prefs' }), g)
      const gd = JSON.parse(g.body)
      expect(JSON.parse(gd.prefs['dsh-music-kg-playback']).id).toBe('kg:abc123')
      expect(JSON.parse(gd.prefs['dsh-music-kg-history'])).toContain('酷狗热搜')
    } finally { cleanup() }
  })

  it('accepts the lyric fx pref through the allowlist, drops invalid fx and non-config keys (persistence regression)', async () => {
    // 回归：新配置键若漏出 Host 白名单，POST 会被 sanitizePrefs 静默丢弃，
    // 表现为「歌词动效设置刷新后重置」。fx 必须能存、能 GET 回读；
    // 跑马灯/边缘渐隐是内置行为，不再有配置键（历史残留应被清理）。
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-lyric-fx': 'karaoke',
          'dsh-music-show-quality': '0',
          'dsh-music-show-bar-bg': '0',
          'dsh-music-qq-playback': JSON.stringify({ id: 'qq:1', queue: [] }),
          'dsh-music-lyric-marquee': '0',
          'dsh-music-lyric-mask': '1',
        } }) }),
        res,
      )
      let d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.prefs['dsh-music-lyric-fx']).toBe('karaoke')
      expect(d.prefs['dsh-music-show-quality']).toBe('0')
      expect(d.prefs['dsh-music-show-bar-bg']).toBe('0')
      expect(d.prefs['dsh-music-qq-playback']).toBe(JSON.stringify({ id: 'qq:1', queue: [] }))
      expect('dsh-music-lyric-marquee' in d.prefs).toBe(false) // 已下线的配置键
      expect('dsh-music-lyric-mask' in d.prefs).toBe(false)
      // 非法 fx 枚举值丢弃
      const res2 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-lyric-fx': 'bogus',
        } }) }),
        res2,
      )
      d = JSON.parse(res2.body)
      // bogus 被丢弃：快照里仍是第一次存的 karaoke，绝不是 bogus
      expect(d.prefs['dsh-music-lyric-fx']).toBe('karaoke')
    } finally { cleanup() }
  })

  it('accepts the viz-mode pref through the allowlist, drops invalid values (persistence regression)', async () => {
    // 回归：新配置键若漏出 Host 白名单，POST 会被 sanitizePrefs 静默丢弃，
    // 表现为「频谱样式设置刷新后重置回柱状图」。viz-mode 必须能存、能 GET 回读。
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-viz-mode': 'wave',
        } }) }),
        res,
      )
      let d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.prefs['dsh-music-viz-mode']).toBe('wave')
      // GET 回读：快照里确实持久化了 wave
      const g = makeRes()
      await handler(makeReq({ method: 'GET', url: '/dsh-music/prefs' }), g)
      const gd = JSON.parse(g.body)
      expect(gd.prefs['dsh-music-viz-mode']).toBe('wave')
      // 非法枚举值丢弃
      const res2 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-viz-mode': 'bogus',
        } }) }),
        res2,
      )
      d = JSON.parse(res2.body)
      // bogus 被丢弃：快照里仍是第一次存的 wave，绝不是 bogus
      expect(d.prefs['dsh-music-viz-mode']).toBe('wave')
    } finally { cleanup() }
  })

  it('accepts the lyric-panel pos pref through the allowlist (persistence regression)', async () => {
    // 回归：歌词/字幕面板的位置曾漏出 Host 白名单，POST 被 sanitizePrefs 静默丢弃，
    // 表现为「刷新后歌词面板回到默认位置」。位置必须能存、能 GET 回读。
    const { handler, cleanup } = boot()
    try {
      const pos = JSON.stringify({ x: 120, y: 80, w: 420, h: 480 })
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-lyric-panel-pos': pos,
        } }) }),
        res,
      )
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.prefs['dsh-music-lyric-panel-pos']).toBe(pos)
      // GET 回读：快照里确实持久化了位置
      const g = makeRes()
      await handler(makeReq({ method: 'GET', url: '/dsh-music/prefs' }), g)
      const gd = JSON.parse(g.body)
      expect(gd.prefs['dsh-music-lyric-panel-pos']).toBe(pos)
      expect(JSON.parse(gd.prefs['dsh-music-lyric-panel-pos']).x).toBe(120)
    } finally { cleanup() }
  })

  it('accepts the lyric-panel ghost pref through the allowlist (persistence regression)', async () => {
    // 回归：歌词面板透明模式开关必须能经 POST 存入 Host、GET 回读，否则表现为
    // 「刷新后透明开关重置回默认开」。与 lyric-panel-pos 白名单回归同规格。
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/prefs', body: JSON.stringify({ prefs: {
          'dsh-music-lyric-panel-ghost': '0',
        } }) }),
        res,
      )
      const d = JSON.parse(res.body)
      expect(d.ok).toBe(true)
      expect(d.prefs['dsh-music-lyric-panel-ghost']).toBe('0')
      const g = makeRes()
      await handler(makeReq({ method: 'GET', url: '/dsh-music/prefs' }), g)
      const gd = JSON.parse(g.body)
      expect(gd.prefs['dsh-music-lyric-panel-ghost']).toBe('0')
    } finally { cleanup() }
  })

  it('lists .txt novels as books in the manifest', async () => {
    // Books share the default root with music until a separate book root is set.
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'a.mp3': 'AUDIO-A', 'novel.txt': '第一章 起源。' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.tracks.map((t) => t.name)).toEqual(['a.mp3'])
      expect(data.books.map((b) => b.name)).toEqual(['novel.txt'])
      expect(data.bookRoot).toBe(musicDir)
      // book URLs route through the /book/ path
      expect(data.books[0].url.startsWith('/dsh-music/book/')).toBe(true)
    } finally { cleanup() }
  })

  it('recognizes a Windows-style GBK-encoded .txt as a book', async () => {
    // Windows often saves .txt as GBK (multi-byte, not valid UTF-8). The scanner
    // matches by extension, so a GBK byte buffer must still surface as a book.
    // "第一章" in GBK/GB2312: 第=B5DA 一=D2BB 章=D5C2
    const gbk = Buffer.from([0xB5, 0xDA, 0xD2, 0xBB, 0xD5, 0xC2])
    const { handler, cleanup } = boot({
      musicFiles: { 'gbk-novel.txt': gbk },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.books.map((b) => b.name)).toEqual(['gbk-novel.txt'])
      expect(data.tracks).toEqual([])
    } finally { cleanup() }
  })

  it('synthesizing a book without a TTS key returns a clear error', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'novel.txt': 'Hey 这是一段小说文本。' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0' }), res)
      // No key in the test env -> host returns 500 with a Chinese diagnostic,
      // not a crash.
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('未配置') // "未配置"
    } finally { cleanup() }
  })

  it('excludes non-audio files from the manifest', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'a.mp3': 'A', 'notes.txt': 'not audio', 'cover.jpg': 'img' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      expect(JSON.parse(res.body).count).toBe(1)
    } finally { cleanup() }
  })

  it('streams a track with 200 and the correct content-type and bytes', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'X'.repeat(100) } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/0' }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(res.headers['Content-Length']).toBe('100')
      expect(Buffer.from(res.body).length).toBe(100)
    } finally { cleanup() }
  })

  it('honours a Range request with a 206 partial response', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABCDEFGHIJ' } }) // 10 bytes
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music/0', headers: { range: 'bytes=2-5' } }),
        res,
      )
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 2-5/10')
      expect(Buffer.from(res.body).toString()).toBe('CDEF')
      expect(res.headers['Content-Length']).toBe('4')
    } finally { cleanup() }
  })

  it('honours a suffix Range request (bytes=-N)', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABCDEFGHIJ' } })
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music/0', headers: { range: 'bytes=-3' } }),
        res,
      )
      expect(res.status).toBe(206)
      expect(Buffer.from(res.body).toString()).toBe('HIJ')
    } finally { cleanup() }
  })

  it('rejects an unsatisfiable range with 416', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'ABC' } })
    try {
      const res = makeRes()
      await handler(
        makeReq({ url: '/dsh-music/0', headers: { range: 'bytes=10-20' } }),
        res,
      )
      expect(res.status).toBe(416)
      expect(res.headers['Content-Range']).toBe('bytes */3')
    } finally { cleanup() }
  })

  it('returns 404 for an unknown track id', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/999' }), res)
      expect(res.status).toBe(404)
    } finally { cleanup() }
  })

  it('supports HEAD requests with no body', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'HEADBODY' } })
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'HEAD', url: '/dsh-music/0' }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Length']).toBe('8')
    } finally { cleanup() }
  })

  it('switches the library root via /dsh-music/set-root', async () => {
    const { handler, home, cleanup } = boot({ musicFiles: { 'a.mp3': 'AAA' } })
    try {
      // add a second music directory under the temp home
      const other = join(home, 'OtherMusic')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, 'x.wav'), 'WAVDATA')

      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/set-root', body: JSON.stringify({ path: other }) }),
        res,
      )
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(data.count).toBe(1)
      expect(data.tracks[0].name).toBe('x.wav')
    } finally { cleanup() }
  })

  it('rejects a set-root to a non-directory path with 400', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'not-a-dir.txt': 'hi' },
    })
    try {
      const res = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/dsh-music/set-root', body: JSON.stringify({ path: join(home, 'not-a-dir.txt') }) }),
        res,
      )
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).ok).toBe(false)
    } finally { cleanup() }
  })

  it('re-scans the current directory via /dsh-music/rescan (manual refresh)', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'a.mp3': 'AAA' } })
    try {
      // 初始扫描 1 首
      const res0 = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res0)
      expect(JSON.parse(res0.body).count).toBe(1)

      // 新增文件后，manifest 仍返回旧的内存扫描结果（不动态刷新）
      writeFileSync(join(musicDir, 'new.mp3'), 'NEWBYTES')
      const res1 = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res1)
      expect(JSON.parse(res1.body).count).toBe(1)

      // 手动 rescan 后能看到新文件
      const res2 = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/rescan' }), res2)
      const data = JSON.parse(res2.body)
      expect(data.ok).toBe(true)
      expect(data.count).toBe(2)
      expect(data.tracks.map((t) => t.name).sort()).toEqual(['a.mp3', 'new.mp3'])
    } finally { cleanup() }
  })
})

describe('dsh-music-player /dir route', () => {
  it('lists subdirectories with parent/up info and files after them', async () => {
    const { handler, home, cleanup } = boot({
      files: {
        'Music/sub-a/song.mp3': 'A',
        'Music/sub-b/song.mp3': 'B',
        'Music/notes.txt': 'not a dir',
        'Music/cover.jpg': 'img',
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.name).toBe('Music')
      expect(data.up).toBe(home)
      // directories come first
      const dirNames = data.dirs.map((d) => d.name)
      expect(dirNames).toEqual(['sub-a', 'sub-b'])
      // plain files are listed as context (not only audio)
      const fileNames = data.files.map((f) => f.name)
      expect(fileNames).toEqual(['cover.jpg', 'notes.txt'])
    } finally { cleanup() }
  })

  it('reports up=null at the filesystem root', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const root = resolve('/')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=' + encodeURIComponent(root) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.up).toBe(null)
    } finally { cleanup() }
  })

  it('returns breadcrumb crumbs that walk the full absolute path', async () => {
    const { handler, home, cleanup } = boot({ files: { 'Music/sub-a/song.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(Array.isArray(data.crumbs)).toBe(true)
      expect(data.crumbs.length).toBeGreaterThanOrEqual(2)
      // The deepest crumb is the current directory itself.
      const last = data.crumbs[data.crumbs.length - 1]
      expect(last.name).toBe('Music')
      expect(last.path).toBe(data.path)
      // The home directory appears as an ancestor crumb that accumulates to `home`.
      const homeCrumb = data.crumbs.find((c) => c.path === home)
      expect(homeCrumb).toBeTruthy()
      expect(homeCrumb.name).toBe(home.replace(/[\\/]+$/, '').split(/[\\/]/).pop())
      // Crumbs accumulate from the root: each path is a strict prefix of the next.
      for (let i = 1; i < data.crumbs.length; i += 1) {
        expect(data.crumbs[i].path.startsWith(data.crumbs[i - 1].path)).toBe(true)
      }
    } finally { cleanup() }
  })

  it('returns a valid crumb walk for the __drives__ sentinel', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=__drives__' }), res)
      const data = JSON.parse(res.body)
      // On non-Windows the sentinel resolves to the POSIX root ("/").
      expect(Array.isArray(data.crumbs)).toBe(true)
      expect(data.crumbs.length).toBeGreaterThanOrEqual(0)
      if (data.crumbs.length > 0) {
        expect(data.crumbs[data.crumbs.length - 1].path).toBe(data.path)
      }
    } finally { cleanup() }
  })

  it('handles the __drives__ sentinel on this (non-Windows) host', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/dir?path=__drives__' }), res)
      const data = JSON.parse(res.body)
      expect([null, '/']).toContain(data.up)
      if (data.path === '/') {
        // 回归防护：POSIX 下「本机」应列出真实的根目录内容，不能是空列表——
        // 否则 macOS/Linux 点了「本机」后列表为空、再也选不了任何目录。
        expect(Array.isArray(data.dirs)).toBe(true)
        expect(Array.isArray(data.files)).toBe(true)
        expect(data.dirs.length + data.files.length).toBeGreaterThan(0)
      }
    } finally { cleanup() }
  })
})

describe('dsh-music-player music_play tool', () => {
  it('registers a music_play tool with the expected name', async () => {
    const { tools, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      expect(tool).toBeTruthy()
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      // the tool declares a query parameter
      expect(tool.parameters.properties.query.type).toBe('string')
    } finally { cleanup() }
  })

  it('returns a notice when the library is empty', async () => {
    const { tools, cleanup } = boot({ musicFiles: {} })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({})
      expect(out.played).toBe(false)
      expect(typeof out.notice).toBe('string')
      expect(out.notice.length).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  it('sets a play intent with the picked track id on a query play', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'A', 'other.mp3': 'B' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: 'song' })
      expect(out.played).toBe(true)
      expect(out.action).toBe('play')
      expect(out.track).toBe('song.mp3')
      expect(out.matches).toBe(1)
      expect(out.count).toBe(2)
      // the intent it queued for the browser carries the play action + id/name
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(typeof intent.id).toBe('string')
      expect(intent.name).toBe('song.mp3')
    } finally { cleanup() }
  })

  it('prefers an exact filename match over a substring match', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A', 'ab.mp3': 'B' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: 'a' })   // matches both a.mp3 and ab.mp3
      expect(out.played).toBe(true)
      expect(out.matches).toBe(2)
      expect(out.track).toBe('a.mp3')                   // exact filename match wins
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      expect(JSON.parse(res.body).name).toBe('a.mp3')
    } finally { cleanup() }
  })

  it('queues a pause intent for the browser player', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ action: 'pause' })
      expect(out.action).toBe('pause')
      expect(out.played).toBe(false)
      expect(out.count).toBe(1)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      // transport actions carry no id
      expect(JSON.parse(res.body)).toEqual({ action: 'pause' })
    } finally { cleanup() }
  })

  it('queues next/prev/stop/resume intents', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      for (const action of ['next', 'prev', 'stop', 'resume']) {
        const out = await tool.execute({ action })
        expect(out.action).toBe(action)
        const res = makeRes()
        await handler(makeReq({ url: '/dsh-music/intent' }), res)
        expect(JSON.parse(res.body)).toEqual({ action })
      }
    } finally { cleanup() }
  })

  it('plays a novel via music_play when the query matches only a book', async () => {
    const { tools, handler, cleanup } = boot({
      musicFiles: { 'song.mp3': 'A', '真相 作者：石楠.txt': '第一章\n这是正文。' },
    })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: '真相' })
      expect(out.played).toBe(true)
      expect(out.kind).toBe('book')
      expect(out.track).toContain('真相')
      // the queued intent targets the novel for AI 讲书
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(intent.kind).toBe('book')
      expect(intent.name).toContain('真相')
    } finally { cleanup() }
  })

  it('plays the first novel when the library has music but the query hits no track', async () => {
    const { tools, handler, cleanup } = boot({
      musicFiles: { 'song.mp3': 'A', '中国制造 作者：周梅森.txt': '第一章\n这是正文。' },
    })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ query: '中国制造' })
      expect(out.played).toBe(true)
      expect(out.kind).toBe('book')
      expect(out.track).toContain('中国制造')
    } finally { cleanup() }
  })

  it('plays the first novel when the library has no music at all', async () => {
    const { tools, handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n这是正文。' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({})
      expect(out.played).toBe(true)
      expect(out.kind).toBe('book')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      expect(JSON.parse(res.body).kind).toBe('book')
    } finally { cleanup() }
  })
})

describe('dsh-music-player parseBookStructure', () => {
  it('splits a novel into 简介 / chapters / 尾声 and derives title+author', () => {
    const text = [
      '中国制造 作者：周梅森',
      '',
      '简介',
      '这是一段简介内容，概述全书。',
      '',
      '第一章　闪电划过星空',
      '这是第一章的正文，情节展开。',
      '',
      '第二章　最长的一天',
      '这是第二章的正文，剧情继续。',
      '',
      '尾声',
      '这就是尾声了。',
    ].join('\n')
    const st = parseBookStructure(text, '中国制造 作者：周梅森.txt')
    expect(st.title).toBe('中国制造')
    expect(st.author).toBe('周梅森')
    const types = st.sections.map((s) => s.type)
    expect(types).toEqual(['preface', 'chapter', 'chapter', 'epilogue'])
    expect(st.sections[1].heading).toContain('第一章')
  })

  it('recognizes 6-char-numeral chapter numbers (第一千一百零一…)', () => {
    // {1,5} numerals capped the parser at 五-digit chapter numbers, silently
    // dropping every chapter from 第一千一百零一 on (6+ numeral chars) — ~800
    // missing TOC entries in a 2400-chapter book. 两 as a digit is covered too.
    const chapters = ['第一千一百零一章 洞下激战', '第一千九百九十九章 终局', '第两千零一章 天戈灭敌']
    for (const heading of chapters) {
      const text = [heading, '这一章的正文内容足够长，用来验证标题可以被正确识别。'].join('\n')
      const st = parseBookStructure(text.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, ''), 'novel.txt')
      expect(st.sections.length).toBe(1)
      expect(st.sections[0].type).toBe('chapter')
      expect(st.sections[0].heading.replace(/\s+/g, '')).toBe(heading.replace(/\s+/g, ''))
    }
  })

  it('recognizes volume-prefixed chapter headings (卷名 第X章 标题)', () => {
    // Multi-volume compendiums repeat the volume name in every heading:
    // `精绝古城 第五章 火瓢虫`. These exceed the named length cap and must be
    // classified as chapters with the full line (volume + chapter) kept, so the
    // TOC still tells the volumes apart.
    const text = [
      '精绝古城 第五章 火瓢虫',
      '这一章的正文内容足够长，用来验证标题可以被正确识别。',
      '',
      '精绝古城 第六章 九层妖楼',
      '这一章的正文内容也足够长，同样用来验证分块的对齐。',
    ].join('\n')
    const st = parseBookStructure(text.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, ''), 'novel.txt')
    expect(st.sections.length).toBe(2)
    expect(st.sections.every((s) => s.type === 'chapter')).toBe(true)
    expect(st.sections.map((s) => s.heading)).toEqual(['精绝古城 第五章 火瓢虫', '精绝古城 第六章 九层妖楼'])
  })

  it('never crowns ornament separator lines (———— / ······) section headings', () => {
    // Dash/bullet rows are visual separators; treating them as headings reads
    // the dashes aloud and lets one of them swallow the whole tail of a book.
    const text = [
      '第一章 开端',
      '这一章的正文内容足够长，用来验证标题可以被正确识别。',
      '',
      '————————————',
      '······',
      '',
      '第二章 承接',
      '这一章的正文内容也足够长，用来验证分隔线不会截断正文。',
    ].join('\n')
    const st = parseBookStructure(text.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, ''), 'novel.txt')
    for (const s of st.sections) {
      expect(s.heading).not.toContain('—')
      expect(s.heading).not.toContain('····')
    }
    const chapters = st.sections.filter((s) => s.type === 'chapter')
    expect(chapters.length).toBe(2)
  })

  it('recognizes standalone short-line (named) section headings like 麻将牌', () => {
    const text = [
      '县级夫人 作者：杨晓升',
      '',
      '麻将牌',
      '男人当道，女人当家。这是正文第一段，文字很长很长很长很长很长。' + '正文。'.repeat(220),
      '',
      '青远县',
      '这也是一个分节的正文段落，内容同样足够长，足以视为正文。' + '正文。'.repeat(220),
      '',
      '尾声',
      '结束了。',
    ].join('\n')
    const st = parseBookStructure(text, '县级夫人 作者：杨晓升.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['named', 'named', 'epilogue'])
    expect(st.sections[0].heading).toBe('麻将牌')
    expect(st.sections[1].heading).toBe('青远县')
  })

  it('never crowns a standalone quoted dialogue line a named section heading', () => {
    // In blank-line-separated txt layouts a short dialogue line like
    // `“有害吗？”大奎马上问` sits alone between blanks exactly like a named
    // sub-title would — but it is body text, and treating it as a heading once
    // swallowed the entire rest of the book into a fake section.
    const text = [
      '七星鲁王宫完整版',
      '50年前，长沙镖子岭。4个土夫子正蹲在一个土丘上，所有人都不说话。',
      '',
      '“有害吗？”大奎马上问',
      '',
      '三叔摇了摇头，把烟头按灭在地上，接着讲起了当年发生在这片芦苇荡里的故事，语气十分沉重。',
    ].join('\n')
    const st = parseBookStructure(text, '七星鲁王宫完整版.txt')
    for (const s of st.sections) {
      expect(s.heading).not.toContain('有害吗')
    }
    // the book-title line may remain a named section; the dialogue must not
    expect(st.sections.some((s) => s.heading.includes('有害吗'))).toBe(false)
  })

  it('rejects a run of short lyric lines as headings', () => {
    const text = [
      '第一章',
      '这是第一章的正文第一行。',
      '',
      '能不能让我陪着你走',
      '既然你说留不住你',
      '回去的路有些黑暗',
      '担心让你一个人走',
      '',
      '第二章',
      '这是第二章的正文。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    const chapters = st.sections.filter((s) => s.type === 'chapter')
    expect(chapters.length).toBe(2)
    // none of the lyric lines became a section
    for (const s of st.sections) {
      expect(['能不能', '既然', '回去', '担心']).not.toContain(s.heading.slice(0, 2))
    }
  })

  it('suppresses a duplicated 目录 TOC block', () => {
    const text = [
      '目录',
      '第一章　标题一',
      '第二章　标题二',
      '第三章　标题三',
      '',
      '第一章　标题一',
      '这是第一章正文。很长很长。',
      '',
      '第二章　标题二',
      '这是第二章正文。很长很长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    // only the two real chapters; the toc block must not produce sections
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('suppresses TOC rows that carry trailing page-number refs (…/12)', () => {
    const text = [
      '第一章 标题一',
      '1. 小节一——一句话介绍。/1',
      '2. 小节二——一句话介绍。/4',
      '',
      '第一章 标题一',
      '这是第一章正文，内容很长很长很长很长很长很长很长很长很长。',
      '',
      '第二章 标题二',
      '1. 小节甲——一句话介绍。/9',
      '2. 小节乙——一句话介绍。/12',
      '',
      '第二章 标题二',
      '这是第二章正文，内容同样很长很长很长很长很长很长很长很长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    // only the two real chapters survive; the /N-page-ref rows are suppressed
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('strips WPS typesetting codes before classification', () => {
    const text = '第一章\n正文内容很长。\n\n〖BT3〗第二章\n第二段正文。\n'
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
    expect(st.sections[1].heading).toBe('第二章')
  })

  it('folds a tiny named section back into the previous section (noise gate)', () => {
    const text = [
      '第一章',
      '这是第一章正文，很长很长的一段文字内容，足够长了。',
      '',
      '小节',
      '这是一段超过二十个字的短正文内容。它只有这一段。',
      '',
      '第二章',
      '这是第二章正文内容。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
  })

  it('accepts a strong heading with no blank line above it', () => {
    const text = [
      '第一部 禁地',
      '这是第一部的正文。',
      '第二部 荒 村',
      '这是第二部的正文。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.map((s) => s.type)).toEqual(['part', 'part'])
    expect(st.sections[1].heading).toBe('第二部 荒 村')
  })

  it('reports a valid textStart (offset in the normalized text) per section', () => {
    const text = [
      '第一章 标题甲',
      '这是第一章正文，句子足够长。',
      '',
      '第二章 标题乙',
      '这是第二章正文，句子足够长。',
    ].join('\n')
    const st = parseBookStructure(text, 'novel.txt')
    expect(st.sections.length).toBe(2)
    const norm = text.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
    for (const s of st.sections) {
      expect(typeof s.textStart).toBe('number')
      expect(s.textStart).toBeGreaterThanOrEqual(0)
      expect(s.textStart).toBeLessThan(norm.length)
      // the offset points at the heading text in the normalized source
      expect(norm.slice(s.textStart, s.textStart + s.heading.length)).toContain(
        s.heading.replace(/\s+/g, '').slice(0, 2),
      )
    }
    // section offsets are increasing
    expect(st.sections[1].textStart).toBeGreaterThan(st.sections[0].textStart)
  })
})

describe('dsh-music-player splitBookChunks (heading gets its own chunk)', () => {
  const norm = (t) => t.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '')
  const breaksOf = (st) => st.sections
    .filter((s) => Number.isFinite(s.textStart) && s.textStart >= 0)
    .map((s) => ({ start: s.textStart, text: s.heading }))

  it('puts each clean chapter heading in its own chunk, body in the next', () => {
    const text = [
      '第一章　闪电划过星空',
      '这是第一章的正文，情节开始展开。故事继续推进。',
      '',
      '第二章　最长的一天',
      '这是第二章的正文，剧情继续发展。',
    ].join('\n')
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    // two chapters -> heading chunks + body chunks
    expect(fromChunkOfBreak).toEqual([0, 2])
    expect(chunks[0]).toContain('第一章')
    expect(chunks[0]).not.toContain('这是第一章的正文')
    expect(chunks[1]).toContain('这是第一章的正文')
    expect(chunks[2]).toContain('第二章')
    expect(chunks[2]).not.toContain('这是第二章的正文')
    expect(chunks[3]).toContain('这是第二章的正文')
    // section opener = the heading chunk, monotonic
    expect(fromChunkOfBreak[1]).toBeGreaterThan(fromChunkOfBreak[0])
  })

  it('does not merge the heading text into the following body chunk', () => {
    const text = '第一章　起\n这是第一章正文，句子足够长，用来确认标题不粘进正文。'
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    expect(fromChunkOfBreak[0]).toBe(0)
    expect(chunks[0]).toContain('第一章')
    // body chunk starts with the actual prose, not the heading
    expect(chunks[1]).toMatch(/^这是第一章正文/)
  })

  it('falls back to the old merge for an inline/polluted long heading (no crash, no giant heading chunk)', () => {
    // heading + body on the same line: parseBookStructure already merged the
    // whole line into `heading`, so it is longer than MAX_HEADING_CHARS and the
    // chunker must keep the old merge behaviour instead of isolating a bogus
    // "heading" that is actually most of a paragraph.
    const text = '第一章 闪电划过星空 这是第一章的正文，情节开始展开，故事继续推进。\n\n第二章 最长的一天 这是第二章的正文，剧情继续发展。\n'
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    expect(chunks.length).toBeGreaterThan(0)
    // both breaks still open chunks (monotonic) and every chunk is bounded by
    // MAX_TTS_CHARS + a heading line, never the whole remaining text
    expect(fromChunkOfBreak.length).toBe(2)
    expect(fromChunkOfBreak[1]).toBeGreaterThan(fromChunkOfBreak[0])
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
  })

  it('falls back gracefully when the heading cannot be matched in the source (e.g. WPS codes)', () => {
    const text = '〖BT3〗第二章\n这是第二章的正文，内容很长。'
    const n = norm(text)
    const st = parseBookStructure(n, 'novel.txt')
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    expect(chunks.length).toBeGreaterThan(0)
    // the break still opens a chunk and nothing crashes; the isolated heading
    // chunk holds the clean title (the WPS code stays in the chunk before it)
    expect(fromChunkOfBreak.length).toBe(1)
    const hIdx = fromChunkOfBreak[0]
    expect(hIdx).toBeGreaterThanOrEqual(0)
    expect(chunks[hIdx]).toBe('第二章')
    expect(chunks.join('')).toContain('这是第二章的正文')
  })

  it('recognizes decorated chapter headings and reads the bare title', () => {
    // Downloaded .txt files usually carry ornament + site credits before the
    // chapter token. The parser must strip them for the TOC, and the chunker
    // must isolate the bare `第一章 …` title while the ornament stays behind.
    const text = [
      '★盗墓笔记·秦岭神树篇·南派三叔·第一章 老痒出狱',
      '这句话才短短的几个字，却把我的思绪全部都吸引了过去。',
      '',
      '★盗墓笔记·秦岭神树篇·南派三叔·第二章 六角铃铛',
      '这一章的正文内容，长度足够验证正文与标题是分开的两个块。',
    ].join('\n')
    const n = norm(text)
    const st = parseBookStructure(n, '秦岭神树篇.txt')
    expect(st.sections.length).toBe(2)
    expect(st.sections.map((s) => s.type)).toEqual(['chapter', 'chapter'])
    expect(st.sections.map((s) => s.heading)).toEqual(['第一章 老痒出狱', '第二章 六角铃铛'])
    const { chunks, fromChunkOfBreak } = splitBookChunks(n, breaksOf(st))
    const strip = (s) => s.replace(/\s+/g, '')
    expect(strip(chunks.join(''))).toBe(strip(n)) // 装饰前缀不丢字
    const hIdx = fromChunkOfBreak[0]
    expect(chunks[hIdx]).toBe('第一章 老痒出狱') // 标题独块且是干净标题
  })

  it('handles an empty / no-section book without crashing', () => {
    const n = norm('这是一本没有章节标题的书。只有正文。')
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('没有章节标题')
  })

  it('keeps a quoted dialogue intact even when it contains 。？ inside', () => {
    // A 。！？…； inside “...” must NOT cut the sentence: the whole dialogue stays in
    // one chunk (and reads as a single utterance), so it is never split mid-quote.
    const n = norm('他说：“你来了吗？我等你很久了。”她点点头。')
    const { chunks } = splitBookChunks(n, [])
    // content preserved & exactly one chunk (short sentence + both quotes)
    expect(chunks.join('')).toBe(n)
    expect(chunks.length).toBe(1)
    // the ? inside the quote did not open a chunk boundary inside the quote
    const holder = chunks[0]
    expect(holder).toContain('你来了吗？我等你很久了。”')
    expect(holder.includes('“你来了吗')).toBe(true)
  })

  it('never produces a chunk longer than MAX_TTS_CHARS', () => {
    // a long run of normal sentences well over the cap
    const n = norm(('这是第一句话，里面有一个逗号分句。'.repeat(40)))
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
  })

  it('splits an over-long sentence at a clause pause (adaptive), not a raw hard cut', () => {
    // one giant sentence (no 。 inside) longer than the cap, dense with commas
    const clauses = Array.from({ length: 40 }, (_, i) => '这是第' + (i + 1) + '个分句：').join('')
    const n = norm(clauses + '至此完毕。')
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.length).toBeGreaterThan(1)
    // content preserved (nothing truncated)
    expect(chunks.join('')).toBe(n)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
    // every chunk boundary lands on a clause pause, never mid-word
    for (let i = 0; i < chunks.length - 1; i++) expect(chunks[i].endsWith('：')).toBe(true)
  })

  it('does not cut inside a quoted dialogue even when a chunk boundary is forced', () => {
    // Place a small dialogue in the middle of a comma-laden run that overflows
    // the cap. The adaptive splitter must keep “...” together — the boundary ends
    // up outside the quotes, never inside them.
    const filler = '一二三四五六七八九十，'
    const dialogue = '“他说完就走了。”'
    const n = norm(filler.repeat(9) + dialogue + filler.repeat(9))
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.join('')).toBe(n)
    // the chunk holding the opening quote carries the whole dialogue intact
    const holder = chunks.find((c) => c.includes('“'))
    expect(holder).toBeTruthy()
    expect(holder).toContain('他说完就走了。”')
    // each chunk stays within the cap
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
  })

  // Regression: body prose must not fragment into runs of consecutive short
  // chunks. Two guards: ，、 now break segments (a comma-heavy description is
  // packed into ~150-char blocks instead of one giant segment hitting
  // splitOversize), and splitOversize takes any tail that fits in a single
  // chunk whole (no re-subdividing the shrinking tail at clause pauses).
  it('keeps a comma-heavy long description as clean ~150 blocks (no consecutive short chunks)', () => {
    const desc = '极长的描述句'.repeat(23) + '，然后没有句号地继续往下写，直到这里才终于告一段落。'
    const n = norm(['开头几个短句。', desc, '结尾两个短句。', '最后一句。'].join('\n'))
    const { chunks } = splitBookChunks(n, [])
    const strip = (s) => s.replace(/\s+/g, '')
    expect(strip(chunks.join(''))).toBe(strip(n)) // 文本保留（仅空白折叠）
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
    // 主块接近上限，而不是整段碎成多个小片
    expect(Math.max(...chunks.map((c) => c.length))).toBeGreaterThanOrEqual(120)
    // 不存在"连续>=2个 <40字"的碎块（正文不应出现连续少内容分块）
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].length < 40) {
        let j = i
        while (j < chunks.length && chunks[j].length < 40) j++
        if (j - i >= 2) throw new Error('出现连续短块: ' + chunks.slice(i, j).join('|'))
        i = j
      }
    }
  })

  it('does not break a quoted dialogue at its internal ，、 (atomic quote still holds)', () => {
    const n = norm('他说：“你来了吗？我等你，很久了。”她点点头。')
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.join('')).toBe(n) // 引号内逗号不分离对话与叙述
    const holder = chunks.find((c) => c.includes('“'))
    expect(holder).toBeTruthy()
    expect(holder).toContain('你来了吗？我等你，很久了。”')
  })

  it('takes the tail of an over-long unpunctuated sentence as one chunk', () => {
    const n = norm('无标点'.repeat(60)) // 180 chars, no break punctuation
    const { chunks } = splitBookChunks(n, [])
    expect(chunks.join('')).toBe(n)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
    expect(Math.max(...chunks.map((c) => c.length))).toBeGreaterThanOrEqual(150)
    // tail is a single block (150, 30) rather than several tiny pieces
    expect(chunks.length).toBe(2)
  })

  it('never chips a tiny 他说： lead-in chunk off a long quoted monologue', () => {
    // For `他说：“…long quote…”` the last outside-quote clause break of the first
    // window is the lead-in colon itself (everything after it is inQuote), so the
    // old splitter cut a 3-char `他说：` orphan chunk out from between two full
    // ones. The lead-in must stay glued to the quote it introduces.
    const quote = '今天的情况大家都看到了，形势比人强，我们必须立刻做出判断，不能再犹豫下去了，任何拖延都会付出代价，这是摆在我们面前最现实的难题，也是必须要跨过去的一道坎。'
    const n = norm(['前情交代一句。', '他说：“' + quote.repeat(2) + '”', '后续叙述。'].join('\n'))
    const { chunks } = splitBookChunks(n, [])
    const strip = (s) => s.replace(/\s+/g, '')
    expect(strip(chunks.join(''))).toBe(strip(n)) // 文本保留
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_TTS_CHARS)
    const holder = chunks.find((c) => c.includes('他说：'))
    expect(holder).toBeTruthy()
    expect(holder).toContain('他说：“') // 引出语与对话同块，不单独成 3 字孤儿块
  })
})

describe('dsh-music-player parseLrc', () => {
  it('parses [mm:ss] timestamps with text into sorted lines', () => {
    const lrc = parseLrc('[00:12.00]第一句\n[00:30.5]第二句\n[01:02]第三句\n')
    expect(lrc).toEqual([
      { t: 12, text: '第一句' },
      { t: 30.5, text: '第二句' },
      { t: 62, text: '第三句' },
    ])
  })
  it('duplicates a line across multiple timestamps and re-sorts unsorted input', () => {
    const lrc = parseLrc('[00:20.00][00:10.00]重复句\n')
    expect(lrc).toEqual([
      { t: 10, text: '重复句' },
      { t: 20, text: '重复句' },
    ])
  })
  it('applies [offset:±ms] to all timestamps and skips metadata tags', () => {
    const lrc = parseLrc('[ti:标题]\n[ar:歌手]\n[offset:-500]\n[00:10.00]歌词\n')
    expect(lrc).toEqual([{ t: 9.5, text: '歌词' }])
  })
  it('strips html-ish tags and drops empty/untimed lines', () => {
    const lrc = parseLrc('[00:01.00]<i>斜体</i>歌词\n\n没有时间戳的一行\n[00:02.00]\n')
    expect(lrc).toEqual([
      { t: 1, text: '斜体歌词' },
    ])
  })
  it('handles three-digit millisecond fractions and empty input', () => {
    expect(parseLrc('[00:00.500]半秒\n')).toEqual([{ t: 0.5, text: '半秒' }])
    expect(parseLrc('')).toEqual([])
  })
})

describe('dsh-music-player splitTranslatedLyric (本地歌词「格式 C」翻译拆分)', () => {
  it('splits a latin translation line that closely follows its Chinese line (<0.6s)', () => {
    const { lrc, trans } = splitTranslatedLyric([
      { t: 1, text: '窗外的麻雀' },
      { t: 1.5, text: 'Sparrows outside the window' },
      { t: 5, text: '雨下整夜' },
      { t: 5.4, text: 'Rain falls all night' },
    ])
    expect(lrc).toEqual([
      { t: 1, text: '窗外的麻雀' },
      { t: 5, text: '雨下整夜' },
    ])
    expect(trans).toEqual([
      { t: 1.5, text: 'Sparrows outside the window' },
      { t: 5.4, text: 'Rain falls all night' },
    ])
  })
  it('splits a Chinese translation following its English line (外文歌 → 中文翻译，主流方向)', () => {
    const { lrc, trans } = splitTranslatedLyric([
      { t: 1, text: 'Sparrows outside the window' },
      { t: 1.5, text: '窗外的麻雀' },
      { t: 5, text: 'Rain falls all night' },
      { t: 5.4, text: '雨下整夜' },
    ])
    expect(lrc).toEqual([
      { t: 1, text: 'Sparrows outside the window' },
      { t: 5, text: 'Rain falls all night' },
    ])
    expect(trans).toEqual([
      { t: 1.5, text: '窗外的麻雀' },
      { t: 5.4, text: '雨下整夜' },
    ])
  })
  it('keeps pure-Chinese lyric lines as-is with no translation', () => {
    const { lrc, trans } = splitTranslatedLyric([
      { t: 1, text: '窗外的麻雀' },
      { t: 5, text: '雨下整夜' },
    ])
    expect(lrc).toHaveLength(2)
    expect(trans).toEqual([])
  })
  it('does NOT split latin watermark/song-title lines that have no nearby Chinese line', () => {
    const { lrc, trans } = splitTranslatedLyric([
      { t: 0, text: 'LeefenChen-月光游侠 QQ群:24275039' },
      { t: 1, text: '窗外的麻雀' },
    ])
    expect(lrc).toHaveLength(2) // 水印行保留在主歌词（无对应中文原句）
    expect(trans).toEqual([])
  })
  it('does NOT split a latin line too far from its Chinese line (>=0.6s)', () => {
    const { lrc, trans } = splitTranslatedLyric([
      { t: 1, text: '窗外的麻雀' },
      { t: 5, text: 'Sparrows outside the window' },
    ])
    expect(lrc).toHaveLength(2)
    expect(trans).toEqual([])
  })
  it('splits an English line followed closely by its Chinese line (外文在前 + 中文紧跟 → 中文是翻译)', () => {
    // 双向判定下：1 英文 + 1 中文平局 → 首行(英文)为主语言 → 中文为翻译类，
    // 紧跟(0.5s<0.6s)的中文被拆为翻译——覆盖「外文歌→中文翻译」的方向。
    const { lrc, trans } = splitTranslatedLyric([
      { t: 0.5, text: 'Sparrows outside' },
      { t: 1, text: '窗外的麻雀' },
    ])
    expect(lrc).toEqual([{ t: 0.5, text: 'Sparrows outside' }])
    expect(trans).toEqual([{ t: 1, text: '窗外的麻雀' }])
  })
  it('treats same-timestamp extra translation lines as translation too (does not pollute main lyric)', () => {
    // 中文歌 + 英文翻译：主语言中文，紧跟原句的多个同时间戳英文行都归为翻译。
    const { lrc, trans } = splitTranslatedLyric([
      { t: 1, text: '窗外的麻雀' },
      { t: 2, text: '雨下整夜' },
      { t: 2.5, text: 'Sparrows outside' },
      { t: 2.5, text: 'Another translation' },
    ])
    expect(lrc).toEqual([
      { t: 1, text: '窗外的麻雀' },
      { t: 2, text: '雨下整夜' },
    ])
    expect(trans).toHaveLength(2)
    expect(trans.map((t) => t.text)).toEqual(expect.arrayContaining(['Sparrows outside', 'Another translation']))
  })
  it('handles empty / non-array input gracefully', () => {
    expect(splitTranslatedLyric([])).toEqual({ lrc: [], trans: [] })
    expect(splitTranslatedLyric(null)).toEqual({ lrc: [], trans: [] })
  })
})

describe('dsh-music-player /lyric route', () => {
  it('serves parsed LRC for a track with a sibling .lrc (case-insensitive fallback)', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'song.mp3': 'M', 'Song.LRC': '[00:01.00]第一句\n[00:05.50]第二句\n' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.hasLrc).toBe(true)
      expect(body.lrc).toEqual([
        { t: 1, text: '第一句' },
        { t: 5.5, text: '第二句' },
      ])
    } finally { cleanup() }
  })
  it('reports hasLrc:false when no sibling .lrc exists', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'song.mp3': 'M' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(false)
      expect(body.hasLrc).toBe(false)
    } finally { cleanup() }
  })
  it('forbids unregistered paths (403) and rejects a missing path (400)', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'song.mp3': 'M' } })
    try {
      const res1 = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric?path=' + encodeURIComponent('/etc/passwd.mp3') }), res1)
      expect(res1.status).toBe(403)
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric' }), res2)
      expect(res2.status).toBe(400)
    } finally { cleanup() }
  })
  // 构造带 LYRICS 键的 FLAC（无同名 .lrc 时，/lyric 应回落到文件内嵌歌词）。
  function flacWithEmbeddedLrc(lrcText) {
    const streaminfo = Buffer.alloc(42)
    streaminfo.write('fLaC', 0, 'ascii'); streaminfo[4] = 0x00
    streaminfo.writeUIntBE(34, 5, 3)
    streaminfo.writeUInt32BE(0, 18); streaminfo.writeUInt32BE(0, 22)
    const vendor = Buffer.from('enc'); const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)]
    parts[0].writeUInt32LE(vendor.length, 0); parts[2].writeUInt32LE(1, 0)
    const key = Buffer.from('LYRICS=' + lrcText)
    const len = Buffer.alloc(4); len.writeUInt32LE(key.length, 0)
    parts.push(len, key)
    const vbody = Buffer.concat(parts)
    const vhdr = Buffer.alloc(4); vhdr[0] = 0x04 | 0x80; vhdr.writeUIntBE(vbody.length, 1, 3)
    return Buffer.concat([streaminfo, vhdr, vbody])
  }
  it('serves embedded lyrics (file-internal LYRICS tag) when no sibling .lrc, marked source=embedded', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'song.flac': flacWithEmbeddedLrc('[00:01.00]内嵌第一句\n[00:05.00]内嵌第二句\n') },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric?path=' + encodeURIComponent(join(musicDir, 'song.flac')) }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.hasLrc).toBe(true)
      expect(body.source).toBe('embedded')
      expect(body.lrc).toEqual([
        { t: 1, text: '内嵌第一句' },
        { t: 5, text: '内嵌第二句' },
      ])
    } finally { cleanup() }
  })
  it('prefers a sibling .lrc over the file-embedded lyrics (source=local)', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: {
        'song.flac': flacWithEmbeddedLrc('[00:01.00]内嵌歌词\n'),
        'song.lrc': '[00:01.00]同名歌词\n',
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric?path=' + encodeURIComponent(join(musicDir, 'song.flac')) }), res)
      const body = JSON.parse(res.body)
      expect(body.source).toBe('local')
      expect(body.lrc).toEqual([{ t: 1, text: '同名歌词' }])
    } finally { cleanup() }
  })
  it('extracts format-C translation from a sibling .lrc into trans (原文 / 翻译 可合并)', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: {
        'song.mp3': 'M',
        'song.lrc': '[00:01.00]窗外的麻雀\n[00:01.50]Sparrows outside the window\n[00:05.00]雨下整夜\n',
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) }), res)
      const body = JSON.parse(res.body)
      expect(body.source).toBe('local')
      expect(body.lrc).toEqual([
        { t: 1, text: '窗外的麻雀' },
        { t: 5, text: '雨下整夜' },
      ])
      expect(body.trans).toEqual([{ t: 1.5, text: 'Sparrows outside the window' }])
    } finally { cleanup() }
  })
})

describe('dsh-music-player /lyric/online route (本地无歌词 → 在线兜底)', () => {
  // 按 URL 分发的 fetch stub：QQ 搜索 / QQ 歌词 / LRCLIB 搜索，并记录调用次数。
  function makeStub({ qqSearch = [], qqLyric = null, lrclib = [], qqSongInfo = null, qqQrc = null }) {
    const calls = { qqSearch: 0, qqLyric: 0, lrclib: 0, qqSongInfo: 0, qqQrc: 0 }
    const fn = async (url, opts = {}) => {
      const u = String(url)
      if (u.includes('c.y.qq.com/soso/fcgi-bin/client_search_cp')) {
        calls.qqSearch++
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { song: { totalnum: qqSearch.length, list: qqSearch } } }) }
      }
      if (u.includes('c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new')) {
        calls.qqLyric++
        return { ok: true, status: 200, json: async () => (qqLyric || { retcode: -1, lyric: '' }) }
      }
      if (u.includes('lrclib.net/api/search')) {
        calls.lrclib++
        return { ok: true, status: 200, json: async () => lrclib }
      }
      if (u.includes('fcg_play_single_song.fcg')) {
        calls.qqSongInfo++
        return { ok: true, status: 200, json: async () => (qqSongInfo === null ? { code: 0, data: [] } : { code: 0, data: [qqSongInfo] }) }
      }
      if (u.includes('musicu.fcg')) {
        // 只服务 GetPlayLyricInfo；其它模块调用视为意外（防止误接上游）。
        let module_ = ''
        try { module_ = JSON.parse(opts.body).req.module } catch {}
        if (module_ !== 'music.musichallSong.PlayLyricInfo') throw new Error('unexpected musicu module: ' + module_)
        calls.qqQrc++
        return { ok: true, status: 200, json: async () => (qqQrc || { code: 0, req: { code: 0, data: {} } }) }
      }
      throw new Error('unexpected stub url: ' + u)
    }
    fn.calls = calls
    return fn
  }
  const qqSong = (songmid, title, artist, interval) => ({ songmid, songname: title, singer: [{ name: artist }], interval, payplay: 0 })
  const lrclibRec = (id, trackName, artistName, duration, syncedLyrics) => ({ id, trackName, artistName, duration, instrumental: false, syncedLyrics })
  // QRC 单曲信息桩（fcg_play_single_song.fcg 响应形态）
  const songInfo = (id, name, artist, interval) => ({ id, mid: 'S1', name, interval, singer: [{ name: artist }], album: { name: '专辑' } })

  it('qq/lyric prefers word-level QRC (songmid→数字ID→GetPlayLyricInfo) and returns wordLines', async () => {
    const { handler, cleanup } = boot()
    const qrcText = '<QrcInfos>\n[500,2000]你(500,700)好(1200,600)世(1800,400)\n</QrcInfos>'
    const stub = makeStub({
      qqSongInfo: songInfo(97773, '晴天', '周杰伦', 269),
      qqQrc: { code: 0, req: { code: 0, data: { lyric: QRC.encryptHex(qrcText), qrc_t: 1761231326, lrc_t: 0, trans: '', trans_t: 0 } } },
      qqLyric: { retcode: 0, lyric: '[00:01.00]不该走LRC\n' }, // 不应被用到
    })
    vi.stubGlobal('fetch', stub)
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=S1' }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.source).toBe('qq-qrc')
      // 词尾收紧以原行尾为上界：这里词尾(+尾巴)=2600ms ≥ 原行尾 2500ms → 窗口不变；
      // 若词尾早于行尾（真实长间奏数据）则被收紧到词尾+400ms。
      expect(body.wordLines).toEqual([{ t: 0.5, end: 2.5, text: '你好世' }])
      expect(stub.calls.qqSongInfo).toBe(1)
      expect(stub.calls.qqQrc).toBe(1)
      expect(stub.calls.qqLyric).toBe(0)

      // 第二次请求同一首歌：mid→ID 已缓存（不再打单曲详情），但歌词仍实时解密
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=S1' }), res2)
      expect(JSON.parse(res2.body).source).toBe('qq-qrc')
      expect(stub.calls.qqSongInfo).toBe(1)
      expect(stub.calls.qqQrc).toBe(2)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('qq/lyric falls back to plain LRC when the song has no word data (qrc_t=0)', async () => {
    const { handler, cleanup } = boot()
    const stub = makeStub({
      qqSongInfo: songInfo(449205, '稻香', '周杰伦', 223),
      qqQrc: { code: 0, req: { code: 0, data: { lyric: 'aabbccdd00112233'.repeat(50), qrc_t: 0, lrc_t: 1728477663 } } }, // 加密数据但无逐字
      qqLyric: { retcode: 0, lyric: '[00:01.00]对这个世界如果你有太多的抱怨\n', trans: '' },
    })
    vi.stubGlobal('fetch', stub)
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=S1' }), res)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.source).toBeUndefined()         // 走了旧形态（无 source 字段）
      expect(body.lrc[0].text).toContain('太多的抱怨')
      expect(stub.calls.qqLyric).toBe(1)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('qq/lyric falls back to plain LRC when songmid cannot resolve to a numeric id', async () => {
    const { handler, cleanup } = boot()
    const stub = makeStub({
      qqSongInfo: null,                           // fcg 端点返回空 data → 解析失败
      qqLyric: { retcode: 0, lyric: '[00:01.00]跌落谷底也不失意\n', trans: '' },
    })
    vi.stubGlobal('fetch', stub)
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=UNKNOWN' }), res)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.lrc[0].text).toContain('不失意')
      expect(stub.calls.qqSongInfo).toBe(1)
      expect(stub.calls.qqQrc).toBe(0)            // 无数字 ID → 不该发起 QRC 请求
      // 失败结果已缓存：再来一次不重试 fcg
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/qq/lyric?songmid=UNKNOWN' }), res2)
      expect(JSON.parse(res2.body).ok).toBe(true)
      expect(stub.calls.qqSongInfo).toBe(1)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('returns 400 for a missing path and 403 for an unregistered path', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'song.mp3': 'M' } })
    try {
      const res1 = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric/online' }), res1)
      expect(res1.status).toBe(400)
      const res2 = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric/online?path=' + encodeURIComponent('/etc/passwd.mp3') }), res2)
      expect(res2.status).toBe(403)
      // 未登记路径不得触发任何在线请求
      expect(res2.status).toBe(403)
    } finally { cleanup() }
  })

  it('serves a local sibling .lrc with source local when present (no online fetch)', async () => {
    const { handler, musicDir, cleanup } = boot({
      musicFiles: { 'song.mp3': 'M', 'song.lrc': '[00:01.00]第一句\n[00:05.50]第二句\n' },
    })
    let fetches = 0
    vi.stubGlobal('fetch', async () => { fetches++; throw new Error('should not fetch') })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric/online?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.hasLyric).toBe(true)
      expect(body.source).toBe('local')
      expect(body.lrc).toEqual([
        { t: 1, text: '第一句' },
        { t: 5.5, text: '第二句' },
      ])
      expect(fetches).toBe(0)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('falls back to QQ online lyric (source qq) when no local .lrc exists', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'song.mp3': 'M' } })
    const stub = makeStub({
      qqSearch: [qqSong('S1', '七里香', '周杰伦', 297)],
      qqLyric: { retcode: 0, lyric: '[00:01.00]窗外的麻雀\n[00:05.00]雨下整夜\n', trans: '[00:01.00]Sparrow\n' },
    })
    vi.stubGlobal('fetch', stub)
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric/online?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) + '&title=%E4%B8%83%E9%87%8C%E9%A6%99&artist=%E5%91%A8%E6%9D%B0%E4%BC%A6&duration=297' }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.hasLyric).toBe(true)
      expect(body.source).toBe('qq')
      expect(body.matched.songmid).toBe('S1')
      expect(body.lrc[0]).toEqual({ t: 1, text: '窗外的麻雀' })
      expect(body.trans).toEqual([{ t: 1, text: 'Sparrow' }])
      expect(stub.calls.qqSearch).toBe(1)
      expect(stub.calls.qqLyric).toBe(1)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('falls through to LRCLIB (source lrclib) when QQ has no matching song', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'song.mp3': 'M' } })
    const stub = makeStub({
      qqSearch: [qqSong('S9', '稻香', '周杰伦', 240)], // 标题不匹配 → QQ 分数不足
      lrclib: [lrclibRec(7, '七里香', '周杰伦', 297, '[00:01.00]窗外的麻雀\n[00:05.00]雨下整夜\n')],
    })
    vi.stubGlobal('fetch', stub)
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/lyric/online?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) + '&title=%E4%B8%83%E9%87%8C%E9%A6%99&artist=%E5%91%A8%E6%9D%B0%E4%BC%A6' }), res)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.hasLyric).toBe(true)
      expect(body.source).toBe('lrclib')
      expect(body.matched.id).toBe(7)
      expect(body.lrc.length).toBe(2)
      expect(stub.calls.qqSearch).toBe(1) // QQ 搜到但分数不足 → 继续走 LRCLIB
      expect(stub.calls.lrclib).toBe(1)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('caches a positive hit by path so a repeat request performs no new fetch', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'song.mp3': 'M' } })
    const stub = makeStub({
      qqSearch: [qqSong('S1', '晴天', '周杰伦', 269)],
      qqLyric: { retcode: 0, lyric: '[00:01.00]故事的小黄花\n', trans: '' },
    })
    vi.stubGlobal('fetch', stub)
    try {
      const url = '/dsh-music/lyric/online?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) + '&title=%E6%99%B4%E5%A4%A9&artist=%E5%91%A8%E6%9D%B0%E4%BC%A6'
      const res1 = makeRes()
      await handler(makeReq({ url }), res1)
      expect(JSON.parse(res1.body).source).toBe('qq')
      const res2 = makeRes()
      await handler(makeReq({ url }), res2)
      const body2 = JSON.parse(res2.body)
      expect(body2.source).toBe('qq')
      expect(body2.lrc).toEqual([{ t: 1, text: '故事的小黄花' }])
      expect(stub.calls.qqSearch).toBe(1) // 第二次命中缓存，不再出网
      expect(stub.calls.qqLyric).toBe(1)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })

  it('caches a negative result (no lyric) and returns hasLyric:false on repeat', async () => {
    const { handler, musicDir, cleanup } = boot({ musicFiles: { 'song.mp3': 'M' } })
    const stub = makeStub({ qqSearch: [], lrclib: [] })
    vi.stubGlobal('fetch', stub)
    try {
      const url = '/dsh-music/lyric/online?path=' + encodeURIComponent(join(musicDir, 'song.mp3')) + '&title=no-such-song'
      const res1 = makeRes()
      await handler(makeReq({ url }), res1)
      const body1 = JSON.parse(res1.body)
      expect(body1.ok).toBe(true)
      expect(body1.hasLyric).toBe(false)
      const res2 = makeRes()
      await handler(makeReq({ url }), res2)
      expect(JSON.parse(res2.body).hasLyric).toBe(false)
      expect(stub.calls.qqSearch).toBe(1) // 空结果也缓存，避免反复打接口
      expect(stub.calls.lrclib).toBe(1)
    } finally { cleanup(); vi.unstubAllGlobals() }
  })
})

describe('dsh-music-player book text route', () => {
  it('returns the plain text of a chunk from /book/<id>/text?from=n', async () => {
    const text = '第一章 开始。\n这是正文第一块，内容足够长以便分块。'
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': text } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0/text?from=0' }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(typeof body.text).toBe('string')
      expect(body.text.length).toBeGreaterThan(0)
      expect(body.from).toBe(0)
      // chunk text must come from the file content
      expect(text.includes(body.text) || body.text.includes('第一章')).toBe(true)
    } finally { cleanup() }
  })
  it('reports ok:false beyond the last chunk', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '只有一段。' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0/text?from=999' }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(false)
    } finally { cleanup() }
  })
})

describe('dsh-music-player book structure meta route', () => {
  it('returns title/author/sections with monotonic fromChunk from /book/<id>/meta', async () => {
    const text = [
      '真相 作者：石楠',
      '',
      '第一章',
      '这是第一章正文，句子长度足以形成多个分块。',
      '',
      '第二章',
      '这是第二章正文。',
      '',
      '尾声',
      '结束了。',
    ].join('\n')
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': text } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0/meta' }), res)
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body)
      expect(data.title).toBe('真相')
      expect(data.author).toBe('石楠')
      expect(Array.isArray(data.sections)).toBe(true)
      expect(data.sections.length).toBeGreaterThan(0)
      // fromChunk is a valid chunk index and non-decreasing across sections
      let prev = -1
      for (const sec of data.sections) {
        expect(sec.fromChunk).toBeGreaterThanOrEqual(0)
        expect(sec.fromChunk).toBeLessThan(data.total)
        expect(sec.fromChunk).toBeGreaterThanOrEqual(prev)
        expect(typeof sec.heading).toBe('string')
        expect(sec.heading.length).toBeGreaterThan(0)
        prev = sec.fromChunk
      }
      // 讲书进度条依赖的「逐块累积字符偏移」：长度 = chunk 数 + 1，首项为 0、单调
      // 不减，末项(全书总字符)与 totalChars 一致，且恒为正。
      expect(Array.isArray(data.charOffsets)).toBe(true)
      expect(data.charOffsets).toHaveLength(data.total + 1)
      expect(data.charOffsets[0]).toBe(0)
      for (let i = 1; i < data.charOffsets.length; i++) {
        expect(data.charOffsets[i]).toBeGreaterThanOrEqual(data.charOffsets[i - 1])
        expect(data.charOffsets[i] - data.charOffsets[i - 1]).toBeGreaterThan(0) // 每块非空
      }
      expect(data.totalChars).toBe(data.charOffsets[data.charOffsets.length - 1])
      expect(data.totalChars).toBeGreaterThan(0)
    } finally { cleanup() }
  })
})

describe('dsh-music-player EPUB reader', () => {
  it('flattens a stored-zip epub to plain text in spine order with OPF metadata', () => {
    const epub = buildEpub({
      chapters: [
        epubChapter('第一章 开始', '这是第一章的正文，包含 <b>加粗</b> 与 &amp; 实体，还有 &#20108; 字。'),
        epubChapter('第二章 发展', '这是第二章的正文。'),
      ],
    })
    const r = readEpubBuffer(epub)
    expect(r.title).toBe('测试之书')
    expect(r.author).toBe('测试作者')
    // spine order preserved, headings on their own lines (h1 → newline)
    expect(r.text.indexOf('第一章 开始')).toBeLessThan(r.text.indexOf('第二章 发展'))
    expect(r.text).toContain('这是第一章的正文，包含 加粗 与 & 实体，还有 二 字。')
    expect(r.text).toContain('这是第二章的正文。')
  })

  it('reads a deflate-compressed (method 8) epub', () => {
    const epub = buildEpub({
      compress: true,
      chapters: [epubChapter('第一章 压缩', '这段来自被 deflate 压缩的章节。')],
    })
    const r = readEpubBuffer(epub)
    expect(r.text).toContain('第一章 压缩')
    expect(r.text).toContain('这段来自被 deflate 压缩的章节。')
  })

  it('reads an EPUB2 whose OPF uses namespace-prefixed tags (<opf:item>/<opf:itemref>)', () => {
    // Regression: real-world EPUB2 files (e.g. so-novel exports) prefix the OPF
    // tags with the package namespace; tag matching must be prefix-agnostic.
    const epub = buildEpub({
      nsPrefix: 'opf',
      chapters: [epubChapter('第一章 前缀', '命名空间前缀的章节也能读到。')],
    })
    const r = readEpubBuffer(epub)
    expect(r.title).toBe('测试之书')
    expect(r.text).toContain('第一章 前缀')
    expect(r.text).toContain('命名空间前缀的章节也能读到。')
  })

  it('drops nav/head/style and decodes numeric + named entities', () => {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>不该出现</title></head><body>
<nav epub:type="toc"><ol><li><a href="ch0.xhtml">目录入口</a></li></ol></nav>
<p>正文段落，包含 &nbsp;空格&nbsp; 与 &#x4E8C;&#20108; 字。</p></body></html>`
    const epub = buildEpub({ chapters: [body] })
    const r = readEpubBuffer(epub)
    expect(r.text).not.toContain('目录入口')
    expect(r.text).not.toContain('不该出现')
    expect(r.text).toContain('正文段落，包含 空格 与 二二 字。')
  })

  it('skips linear="no" spine items (endnotes/footnotes) for read-aloud', () => {
    const epub = buildEpub({
      chapters: [
        epubChapter('第一章 正文', '主体内容。'),
        epubChapter('注释', '这是尾注，不应被朗读。'),
      ],
      spineLinear: { ch1: 'no' },
    })
    const r = readEpubBuffer(epub)
    expect(r.text).toContain('第一章 正文')
    expect(r.text).not.toContain('尾注')
  })

  it('skips encrypted/DRM spine items instead of reading mojibake', () => {
    const epub = buildEpub({
      chapters: [
        epubChapter('第一章 可读', '这段是明文。'),
        epubChapter('第二章 加密', '这段被 DRM 加密，无法解密。'),
      ],
      encryptedPaths: ['OEBPS/ch1.xhtml'],
    })
    const r = readEpubBuffer(epub)
    expect(r.text).toContain('第一章 可读')
    expect(r.text).not.toContain('第二章 加密')
  })

  it('throws a clear Chinese error for bytes that are not a zip', () => {
    expect(() => readEpubBuffer(Buffer.from('this is definitely not an epub', 'utf8'))).toThrow(/EPUB/)
  })

  it('zipReadEntry returns stored and deflate bytes, and raises on missing entries', () => {
    const data = buildZip([
      { name: 'a.txt', data: Buffer.from('hello stored', 'utf8') },
      { name: 'b.txt', data: Buffer.from('hello deflate', 'utf8') },
    ], true)
    const entries = zipEntries(data)
    expect(entries.length).toBe(2)
    expect(zipReadEntry(data, entries, 'a.txt').toString()).toBe('hello stored')
    expect(zipReadEntry(data, entries, 'b.txt').toString()).toBe('hello deflate')
    expect(() => zipReadEntry(data, entries, 'missing.txt')).toThrow(/缺少条目/)
  })

  it('htmlToText converts blocks to lines and strips non-prose elements', () => {
    const html = '<html><head><title>t</title><script>var x=1;</script></head><body>'
      + '<h1>标题</h1><p>第一段 <span>内联</span></p><p>第二段</p>'
      + '<svg><text>矢量字</text></svg><br/>换行后'
      + '</body></html>'
    const text = htmlToText(html)
    expect(text).toContain('标题')
    expect(text).not.toContain('var x')
    expect(text).not.toContain('矢量字')
    expect(text).toContain('第一段 内联')
    expect(text).toContain('第二段')
    expect(text).toContain('换行后')
  })

  it('decodeEntities handles numeric and named entities', () => {
    expect(decodeEntities('a&amp;b&#x4E8C;&#20108;&ldquo;x&rdquo;')).toBe('a&b二二“x”')
    expect(decodeEntities('&#x1F600;')).toBe('\u{1F600}')
  })
})

describe('dsh-music-player QQ quality label (qqQualityLabel)', () => {
  it('maps取链 filename 前缀/扩展名到通俗音质标签', () => {
    // 四档 FLAC（AI00/Q001/Q000/F000）→ 无损
    expect(qqQualityLabel('AI00abcdefabcdef.flac')).toBe('无损')
    expect(qqQualityLabel('Q001abcdefabcdef.flac')).toBe('无损')
    expect(qqQualityLabel('Q000abcdefabcdef.flac')).toBe('无损')
    expect(qqQualityLabel('F000abcdefabcdef.flac')).toBe('无损')
    // OGG（O801）与 320k MP3（M800）→ 高音质
    expect(qqQualityLabel('O801abcdefabcdef.ogg')).toBe('高音质')
    expect(qqQualityLabel('M800abcdefabcdef.mp3')).toBe('高音质')
    // 128k MP3（M500）→ 标准
    expect(qqQualityLabel('M500abcdefabcdef.mp3')).toBe('标准')
  })

  it('returns an empty label for unknown / empty filenames', () => {
    expect(qqQualityLabel('')).toBe('')
    expect(qqQualityLabel(null)).toBe('')
    expect(qqQualityLabel(undefined)).toBe('')
    expect(qqQualityLabel('XYZabcdefabcdef.weird')).toBe('')
  })
})

describe('dsh-music-player local audio quality (parseAudioMeta)', () => {
  // ---- 各格式文件头构造器（覆盖解析器读取的偏移）----
  function flacBytes({ rate = 44100, ch = 2, bits = 16, total = 44100 * 60 } = {}) {
    const b = Buffer.alloc(42)
    b.write('fLaC', 0, 'ascii')
    b[4] = 0x00 // STREAMINFO（非 last）
    b.writeUIntBE(34, 5, 3)
    const v = (BigInt(rate) << 44n) | (BigInt(ch - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(total)
    b.writeUInt32BE(Number(v >> 32n), 18)
    b.writeUInt32BE(Number(v & 0xffffffffn), 22)
    return b
  }
  function wavBytes({ rate = 44100, ch = 2, bits = 16 } = {}) {
    const fmt = Buffer.alloc(24)
    fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8)
    fmt.writeUInt16LE(ch, 10); fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * ch * bits / 8, 16)
    fmt.writeUInt16LE(ch * bits / 8, 20); fmt.writeUInt16LE(bits, 22)
    const data = Buffer.alloc(8); data.write('data', 0, 'ascii'); data.writeUInt32LE(0, 4)
    const body = Buffer.concat([fmt, data])
    const out = Buffer.alloc(12 + body.length)
    out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(4 + body.length, 4); out.write('WAVE', 8, 'ascii')
    body.copy(out, 12)
    return out
  }
  function aiffBytes({ rate = 44100, ch = 2, bits = 16 } = {}) {
    const comm = Buffer.alloc(26)
    comm.write('COMM', 0, 'ascii'); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(ch, 8)
    comm.writeUInt32BE(0, 10); comm.writeUInt16BE(bits, 14)
    const e = Math.floor(Math.log2(rate))
    const mant = (rate / 2 ** e) * 2 ** 63
    comm.writeUInt16BE(e + 16383, 16); comm.writeUInt32BE(Math.floor(mant / 2 ** 32), 18); comm.writeUInt32BE((mant >>> 0) >>> 0, 22)
    const form = Buffer.alloc(12 + comm.length)
    form.write('FORM', 0, 'ascii'); form.writeUInt32BE(comm.length + 4, 4); form.write('AIFF', 8, 'ascii')
    comm.copy(form, 12)
    return form
  }
  function mp3Bytes({ kbps = 320, withId3 = false } = {}) {
    const idx = { 32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7, 112: 8, 128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14 }[kbps]
    const frame = Buffer.alloc(64) // 足够长，避免 <8 字节早退
    frame[0] = 0xff; frame[1] = 0xfb // MPEG1 LayerIII
    frame[2] = (idx << 4) | 0x02 // bitrate + samplerate index 0 (44100)
    frame[3] = 0x00 // 双声道
    if (!withId3) return frame
    const id3 = Buffer.alloc(10); id3.write('ID3', 0, 'ascii'); id3[3] = 4; id3[4] = 0; id3[5] = 0
    return Buffer.concat([id3, frame])
  }
  function m4aBytes({ rate = 44100, ch = 2, bits = 16, durSec = 240 } = {}) {
    const box = (type, body) => {
      const out = Buffer.alloc(8 + body.length)
      out.writeUInt32BE(8 + body.length, 0); out.write(type, 4, 'ascii'); body.copy(out, 8)
      return out
    }
    const mvhdBody = Buffer.alloc(20)
    mvhdBody[0] = 0 // version 0
    mvhdBody.writeUInt32BE(1000, 12) // timescale
    mvhdBody.writeUInt32BE(durSec * 1000, 16) // duration
    const mp4aBody = Buffer.alloc(28)
    mp4aBody.writeUInt16BE(ch, 16) // channelcount
    mp4aBody.writeUInt16BE(bits, 18) // samplesize
    mp4aBody.writeUInt32BE(Math.round(rate * 65536), 24) // samplerate 16.16
    const stsdBody = Buffer.alloc(8); stsdBody.writeUInt32BE(1, 4)
    const stsd = box('stsd', Buffer.concat([stsdBody, box('mp4a', mp4aBody)]))
    const moov = box('moov', Buffer.concat([box('mvhd', mvhdBody), stsd]))
    const ftypBody = Buffer.alloc(8); ftypBody.write('M4A ', 0, 'ascii'); ftypBody.writeUInt32BE(0, 4)
    return Buffer.concat([box('ftyp', ftypBody), moov])
  }
  function oggVorbisBytes({ rate = 44100, ch = 2, bitrate = 320000 } = {}) {
    const ident = Buffer.alloc(28)
    ident[0] = 1; Buffer.from('vorbis', 'ascii').copy(ident, 1)
    ident.writeUInt32LE(0, 7); ident[11] = ch; ident.writeUInt32LE(rate, 12); ident.writeUInt32LE(bitrate, 20)
    const page = Buffer.alloc(28 + ident.length)
    page.write('OggS', 0, 'ascii'); page[4] = 0; page[5] = 2; page[26] = 1; page[27] = ident.length
    ident.copy(page, 28)
    return page
  }
  function oggOpusBytes({ rate = 48000, ch = 2 } = {}) {
    const head = Buffer.alloc(19)
    head.write('OpusHead', 0, 'ascii'); head[8] = 1; head[9] = ch; head.writeUInt16LE(312, 10); head.writeUInt32LE(rate, 12); head.writeUInt16LE(0, 16); head[18] = 0
    const page = Buffer.alloc(28 + head.length)
    page.write('OggS', 0, 'ascii'); page[4] = 0; page[5] = 2; page[26] = 1; page[27] = head.length
    head.copy(page, 28)
    return page
  }

  it('FLAC → 无损，带采样率/位深/声道', () => {
    const m = parseAudioMeta(flacBytes())
    expect(m).toMatchObject({ codec: 'FLAC', sampleRate: 44100, channels: 2, bitDepth: 16, tier: '无损' })
  })
  it('WAV → 无损，带采样率/位深/声道', () => {
    expect(parseAudioMeta(wavBytes())).toMatchObject({ codec: 'WAV', sampleRate: 44100, channels: 2, bitDepth: 16, tier: '无损' })
  })
  it('AIFF → 无损，80 位扩展浮点采样率解码正确', () => {
    expect(parseAudioMeta(aiffBytes())).toMatchObject({ codec: 'AIFF', sampleRate: 44100, channels: 2, bitDepth: 16, tier: '无损' })
  })
  it('MP3 320k → 高音质；128k → 标准', () => {
    expect(parseAudioMeta(mp3Bytes({ kbps: 320 }))).toMatchObject({ codec: 'MP3', bitrateKbps: 320, sampleRate: 44100, tier: '高音质' })
    expect(parseAudioMeta(mp3Bytes({ kbps: 128 }))).toMatchObject({ codec: 'MP3', bitrateKbps: 128, tier: '标准' })
  })
  it('MP3 带 ID3v2 标签也能解析', () => {
    expect(parseAudioMeta(mp3Bytes({ kbps: 256, withId3: true }))).toMatchObject({ codec: 'MP3', bitrateKbps: 256, tier: '高音质' })
  })
  it('M4A/AAC 按文件大小与时长估码率分档', () => {
    const hi = parseAudioMeta(m4aBytes({ durSec: 240 }), '', 5 * 1024 * 1024) // ~175kbps
    expect(hi).toMatchObject({ codec: 'AAC', sampleRate: 44100, channels: 2 })
    expect(hi.bitrateKbps).toBeGreaterThan(0)
    const lo = parseAudioMeta(m4aBytes({ durSec: 600 }), '', 4 * 1024 * 1024) // ~55kbps
    expect(lo.tier).toBe('标准')
  })
  it('OGG Vorbis 高码率 → 高音质；低码率 → 标准', () => {
    expect(parseAudioMeta(oggVorbisBytes({ bitrate: 320000 }))).toMatchObject({ codec: 'OGG', sampleRate: 44100, tier: '高音质' })
    expect(parseAudioMeta(oggVorbisBytes({ bitrate: 128000 }))).toMatchObject({ codec: 'OGG', tier: '标准' })
  })
  it('OGG Opus → 高音质', () => {
    expect(parseAudioMeta(oggOpusBytes())).toMatchObject({ codec: 'Opus', sampleRate: 48000, channels: 2, tier: '高音质' })
  })
  it('无法识别的字节 → null（无标签）', () => {
    expect(parseAudioMeta(Buffer.from('this is just text', 'utf8'))).toBeNull()
    expect(parseAudioMeta(Buffer.alloc(4))).toBeNull()
  })
  it('audioQualityLabel 拼成「格式 · 档位」', () => {
    expect(audioQualityLabel({ codec: 'FLAC', tier: '无损' })).toBe('FLAC · 无损')
    expect(audioQualityLabel({ codec: 'MP3', tier: '高音质' })).toBe('MP3 · 高音质')
    expect(audioQualityLabel({ codec: 'AAC', tier: '' })).toBe('AAC')
    expect(audioQualityLabel(null)).toBe('')
  })

  it('识别「ID3 前缀 + 真实容器」的文件（部分下载工具给 FLAC 贴 ID3）→ 无损而非误判 MP3', () => {
    // 真实库里的 .flac 常带 ID3v2 前缀：跳完标签后必须按内容识别成 FLAC，
    // 而不是在 FLAC 数据里误找 MPEG 同步而错标成 MP3（回归）。
    const id3 = Buffer.alloc(10)
    id3.write('ID3', 0, 'ascii'); id3[3] = 4; id3[4] = 0; id3[5] = 0
    const combo = Buffer.concat([id3, flacBytes()])
    expect(parseAudioMeta(combo)).toMatchObject({ codec: 'FLAC', tier: '无损' })
    // 无标签前缀的正常 FLAC 不受影响
    expect(parseAudioMeta(flacBytes())).toMatchObject({ codec: 'FLAC', tier: '无损' })
  })

  it('reports local track quality in the manifest (扫描时解析文件头)', async () => {
    const { handler, cleanup } = boot({
      musicFiles: {
        'song.flac': flacBytes(),
        'song.mp3': mp3Bytes({ kbps: 128 }),
        'garbage.mp3': 'not really an mp3, just text', // 解析不出 → 无标签
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      const byName = Object.fromEntries(data.tracks.map((t) => [t.name, t.quality]))
      expect(byName['song.flac']).toBe('FLAC · 无损')
      expect(byName['song.mp3']).toBe('MP3 · 标准')
      expect(byName['garbage.mp3']).toBe('')
    } finally { cleanup() }
  })
})

describe('dsh-music-player 内嵌歌词提取 (extractEmbeddedLyric)', () => {
  const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
  const plain32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }

  // 构造带 VORBIS_COMMENT 的 FLAC：STREAMINFO + VORBIS_COMMENT，可注入 LYRICS 键。
  function flacWithComment(comments = []) {
    const streaminfo = Buffer.alloc(42)
    streaminfo.write('fLaC', 0, 'ascii'); streaminfo[4] = 0x00
    streaminfo.writeUIntBE(34, 5, 3)
    streaminfo.writeUInt32BE(0, 18); streaminfo.writeUInt32BE(0, 22)
    // VORBIS_COMMENT 块（type 4）
    const vendor = Buffer.from('test-encoder')
    const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)]
    parts[0].writeUInt32LE(vendor.length, 0)
    parts[2].writeUInt32LE(comments.length, 0)
    for (const c of comments) {
      const cbuf = Buffer.from(c)
      const len = Buffer.alloc(4); len.writeUInt32LE(cbuf.length, 0)
      parts.push(len, cbuf)
    }
    const vbody = Buffer.concat(parts)
    const vblockHdr = Buffer.alloc(4)
    vblockHdr[0] = 0x04 | 0x80 // type 4 + last
    vblockHdr.writeUIntBE(vbody.length, 1, 3)
    return Buffer.concat([streaminfo, vblockHdr, vbody])
  }

  // 构造带 USLT 帧的 MP3（ID3v2.3 或 v2.4）。
  function mp3WithUslt({ lyricText, enc = 3, descriptor = '', major = 4, lang = 'eng' } = {}) {
    const bodyParts = [Buffer.from([enc]), Buffer.from(lang)]
    if (enc === 1 || enc === 2) bodyParts.push(Buffer.from(descriptor, 'utf16le'), Buffer.from([0, 0]))
    else bodyParts.push(Buffer.from(descriptor, 'utf8'), Buffer.from([0]))
    if (enc === 1) bodyParts.push(Buffer.from(lyricText, 'utf16le'))
    else bodyParts.push(Buffer.from(lyricText, 'utf8'))
    const body = Buffer.concat(bodyParts)
    const size = major >= 4 ? syncsafe(body.length) : plain32(body.length)
    const frame = Buffer.concat([Buffer.from('USLT'), size, Buffer.from([0, 0]), body])
    const tagSize = major >= 4 ? syncsafe(frame.length) : plain32(frame.length)
    const tag = Buffer.concat([Buffer.from('ID3'), Buffer.from([major, 0]), Buffer.from([0x00]), tagSize, frame])
    return Buffer.concat([tag, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00])])
  }

  const LRC = '[00:01.00]窗外的麻雀\n[00:05.50]雨下整夜\n'

  it('FLAC LYRICS 键（标准 LRC）直接提取', () => {
    const buf = flacWithComment(['TITLE=七里香', 'LYRICS=' + LRC])
    expect(extractEmbeddedLyric(buf)).toBe(LRC)
  })
  it('FLAC UNSYNCEDLYRICS 键同样识别', () => {
    const buf = flacWithComment(['UNSYNCEDLYRICS=' + LRC])
    expect(extractEmbeddedLyric(buf)).toBe(LRC)
  })
  it('FLAC 无 LYRICS 键 → null', () => {
    expect(extractEmbeddedLyric(flacWithComment(['TITLE=x', 'ARTIST=y']))).toBeNull()
    // LYRICS 存在但为空串 → 视为无词
    expect(extractEmbeddedLyric(flacWithComment(['LYRICS=']))).toBeNull()
  })
  it('MP3 USLT 帧（UTF-8, ID3v2.4）提取', () => {
    expect(extractEmbeddedLyric(mp3WithUslt({ lyricText: LRC, enc: 3, major: 4 }))).toBe(LRC)
  })
  it('MP3 USLT 帧（ID3v2.3 非 syncsafe 尺寸）提取', () => {
    expect(extractEmbeddedLyric(mp3WithUslt({ lyricText: LRC, enc: 3, major: 3 }))).toBe(LRC)
  })
  it('MP3 USLT 帧（UTF-16, enc=1）提取', () => {
    expect(extractEmbeddedLyric(mp3WithUslt({ lyricText: LRC, enc: 1, major: 4 }))).toBe(LRC)
  })
  it('MP3 USLT 带非空内容描述（descriptor）也能跳过取词', () => {
    expect(extractEmbeddedLyric(mp3WithUslt({ lyricText: LRC, enc: 3, descriptor: 'lyrics', major: 4 }))).toBe(LRC)
  })
  it('MP3 无 USLT 帧 → null', () => {
    // 只有 ID3 头 + MPEG 帧，无歌词帧
    const id3 = Buffer.alloc(10); id3.write('ID3', 0, 'ascii'); id3[3] = 4; id3[4] = 0; id3[5] = 0
    expect(extractEmbeddedLyric(Buffer.concat([id3, Buffer.from([0xff, 0xfb, 0x90, 0x00])]))).toBeNull()
    // 纯 MPEG、无 ID3
    expect(extractEmbeddedLyric(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBeNull()
  })
  it('「ID3 前缀 + FLAC」组合文件：先试 USLT（无），再跳标签按 FLAC 取词', () => {
    const id3 = Buffer.alloc(10); id3.write('ID3', 0, 'ascii'); id3[3] = 4; id3[4] = 0; id3[5] = 0
    const combo = Buffer.concat([id3, flacWithComment(['LYRICS=' + LRC])])
    expect(extractEmbeddedLyric(combo)).toBe(LRC)
  })
  it('OGG 开头但无 \x01vorbis 注释头 → null（不误报）', () => {
    const page = Buffer.alloc(60); page.write('OggS', 0, 'ascii')
    expect(extractEmbeddedLyric(page)).toBeNull()
  })
  it('非法/过短输入 → null', () => {
    expect(extractEmbeddedLyric(Buffer.alloc(4))).toBeNull()
    expect(extractEmbeddedLyric('not a buffer')).toBeNull()
    expect(extractEmbeddedLyric(null)).toBeNull()
  })
})

describe('dsh-music-player EPUB as a book', () => {
  it('lists .epub novels as books in the manifest', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'test-novel.epub': buildEpub({ chapters: [epubChapter('第一章 开始', '正文。')] }) },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.books.map((b) => b.name)).toEqual(['test-novel.epub'])
      expect(data.tracks).toEqual([])
    } finally { cleanup() }
  })

  it('serves OPF title/author + chapter sections from /book/<id>/meta', async () => {
    const { handler, cleanup } = boot({
      musicFiles: {
        'test-novel.epub': buildEpub({
          chapters: [
            epubChapter('第一章 开始', '这是第一章的正文，句子长度足以形成多个分块。'),
            epubChapter('第二章 发展', '这是第二章的正文。'),
            epubChapter('尾声', '结束了。'),
          ],
        }),
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0/meta' }), res)
      expect(res.status).toBe(200)
      const data = JSON.parse(res.body)
      // OPF metadata wins over the heuristic filename guess ("test-novel")
      expect(data.title).toBe('测试之书')
      expect(data.author).toBe('测试作者')
      expect(Array.isArray(data.sections)).toBe(true)
      expect(data.sections.length).toBeGreaterThanOrEqual(2)
      expect(data.sections[0].heading).toContain('第一章')
      // every section maps to a valid chunk index
      for (const sec of data.sections) {
        expect(sec.fromChunk).toBeGreaterThanOrEqual(0)
        expect(sec.fromChunk).toBeLessThan(data.total)
      }
    } finally { cleanup() }
  })

  it('serves readable chunk text from /book/<id>/text?from=n for an epub', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'test-novel.epub': buildEpub({ chapters: [epubChapter('第一章 开始', '这是正文，足够长以便分块。')] }) },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0/text?from=0' }), res)
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.text).toContain('第一章')
    } finally { cleanup() }
  })

  it('returns a clear 500 (not a crash) for a malformed .epub file', async () => {
    const { handler, cleanup } = boot({
      musicFiles: { 'broken.epub': 'definitely not a zip archive' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0/meta' }), res)
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('EPUB')
    } finally { cleanup() }
  })
})

describe('dsh-music-player TTS chunk synthesis & diagnostics', () => {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b }
  // Build a minimal WAV with a fmt chunk (defaults: PCM/1ch/24000Hz/16bit) and a
  // data chunk of the given bytes. Used to stub the MiMo TTS API response.
  // `declaredDataSize`/`byteRate` override the header fields to fabricate the
  // broken WAVs the API occasionally returns (truncated data / wrong byte rate).
  function pcmWav({ data = Buffer.alloc(0), fmt = 1, ch = 1, rate = 24000, bits = 16, declaredDataSize, byteRate } = {}) {
    const realByteRate = rate * ch * bits / 8
    const fmtChunk = Buffer.concat([
      Buffer.from('fmt ', 'ascii'), u32(16), u16(fmt), u16(ch), u32(rate),
      u32(byteRate !== undefined ? byteRate : realByteRate), u16(ch * bits / 8), u16(bits),
    ])
    const declared = declaredDataSize !== undefined ? declaredDataSize : data.length
    const dataChunk = Buffer.concat([Buffer.from('data', 'ascii'), u32(declared), data])
    const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, dataChunk])
    return Buffer.concat([Buffer.from('RIFF', 'ascii'), u32(body.length), body])
  }
  // Point the TTS provider at a stub returning the given wav as base64 audio.
  function stubTts(wav) {
    vi.stubGlobal('fetch', async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { audio: { data: wav.toString('base64') } } }] }),
    }))
  }
  // The plugin resolves its key from env/credentials; tests set MIMO_API_KEY.
  function withTtsKey() {
    const prev = process.env.MIMO_API_KEY
    process.env.MIMO_API_KEY = 'test-key'
    return () => { if (prev === undefined) delete process.env.MIMO_API_KEY; else process.env.MIMO_API_KEY = prev }
  }

  it('serves a valid synthesized chunk as audio/wav with the exact bytes', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n正文内容。\n第二章\n更多正文。' } })
    const restore = withTtsKey()
    // realistic 16-bit PCM samples at real-speech amplitude (peak ~16000), so the
    // silence check passes
    const sample = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v, 0); return b }
    const data = Buffer.concat([sample(16000), sample(-16000), sample(8000), sample(-8000), sample(12000), sample(-12000), sample(2000), sample(-2000)])
    const wav = pcmWav({ data })
    try {
      stubTts(wav)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0?from=0' }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/wav')
      const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body)
      expect(body.equals(wav)).toBe(true)
    } finally { restore(); cleanup(); vi.unstubAllGlobals() }
  })

  it('rejects a header-only (empty data) wav with a 500 and records the diagnosis', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n正文内容。' } })
    const restore = withTtsKey()
    try {
      stubTts(pcmWav({})) // fmt present but data chunk empty
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0?from=0' }), res)
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('音频数据为空')
      // the diagnosis is recorded and served at /tts-logs
      const lres = makeRes()
      await handler(makeReq({ url: '/dsh-music/tts-logs' }), lres)
      expect(lres.status).toBe(200)
      const logs = JSON.parse(lres.body).logs
      expect(logs.some((l) => l.kind === 'degenerate')).toBe(true)
    } finally { restore(); cleanup(); vi.unstubAllGlobals() }
  })

  it('rejects a non-PCM wav (IEEE float) with a 500', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n正文内容。' } })
    const restore = withTtsKey()
    try {
      stubTts(pcmWav({ fmt: 3, data: Buffer.alloc(4) })) // fmt=3 = IEEE float
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0?from=0' }), res)
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('非 PCM')
    } finally { restore(); cleanup(); vi.unstubAllGlobals() }
  })

  it('rejects a truncated wav (declared data bigger than the buffer) with a 500', async () => {
    // A truncated data chunk makes the browser report a long duration and play
    // silence for the missing remainder — the "没声音但时长差几分钟" symptom.
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n正文内容。' } })
    const restore = withTtsKey()
    try {
      stubTts(pcmWav({ data: Buffer.from([0, 0, 1, 0]), declaredDataSize: 100000 }))
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0?from=0' }), res)
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('被截断')
      // the diagnosis is recorded with the wav header details
      const lres = makeRes()
      await handler(makeReq({ url: '/dsh-music/tts-logs' }), lres)
      const logs = JSON.parse(lres.body).logs
      const degen = logs.find((l) => l.kind === 'degenerate')
      expect(degen).toBeTruthy()
      expect(degen.wav.declared).toBe(100000)
    } finally { restore(); cleanup(); vi.unstubAllGlobals() }
  })

  it('rejects a wav whose byteRate disagrees with the header (inflated duration) with a 500', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n正文内容。' } })
    const restore = withTtsKey()
    try {
      // byteRate is 1/10 of the real 48000 → browser would compute a 10x duration
      stubTts(pcmWav({ data: Buffer.from([0, 0, 1, 0, 2, 0]), byteRate: 4800 }))
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0?from=0' }), res)
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('字节率异常')
    } finally { restore(); cleanup(); vi.unstubAllGlobals() }
  })

  it('rejects an all-silent wav (zero samples) with a 500', async () => {
    // A correct-header but silent wav plays as silence for its whole duration.
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n正文内容。' } })
    const restore = withTtsKey()
    try {
      stubTts(pcmWav({ data: Buffer.alloc(4096) })) // 4096 zero bytes = silent 16-bit PCM
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/book/b0?from=0' }), res)
      expect(res.status).toBe(500)
      expect(String(res.body)).toContain('静音')
    } finally { restore(); cleanup(); vi.unstubAllGlobals() }
  })

  it('resolves the TTS key from the DSH v1 refs:-nested credentials layout', async () => {
    // DSH >= v1 stores keys under a refs: block at two-space indent.
    const { handler, cleanup } = boot({
      files: {
        '.dsh/settings.yaml': 'llm-pi-ai:\n  providers:\n    xiaomi:\n      apiKeyEnv: XIAOMI_API_KEY\n',
        '.dsh/.credentials.yaml': 'version: 1\nrefs:\n  XIAOMI_API_KEY: sk-from-refs\n',
      },
      musicFiles: { 'novel.txt': '第一章\n正文。' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      expect(res.status).toBe(200)
      const manifest = JSON.parse(res.body)
      expect(manifest.ttsConfigured).toBe(true)
      expect(manifest.ttsReason).toBe('ok')
      // 「关于」页展示的提供方名称来自 settings.yaml 里实际匹配到的 provider id。
      expect(manifest.ttsProvider).toBe('xiaomi')
    } finally { cleanup() }
  })

  it('still resolves the TTS key from the legacy flat credentials layout', async () => {
    // Pre-v1 DSH wrote keys at column 0; that layout must keep working.
    const { handler, cleanup } = boot({
      files: {
        '.dsh/settings.yaml': 'llm-pi-ai:\n  providers:\n    xiaomi:\n      apiKeyEnv: XIAOMI_API_KEY\n',
        '.dsh/.credentials.yaml': 'XIAOMI_API_KEY: sk-flat\n',
      },
      musicFiles: { 'novel.txt': '第一章\n正文。' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body).ttsConfigured).toBe(true)
    } finally { cleanup() }
  })

  it('reports TTS as unconfigured when no xiaomi key is configured', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'novel.txt': '第一章\n正文。' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      expect(res.status).toBe(200)
      const manifest = JSON.parse(res.body)
      expect(manifest.ttsConfigured).toBe(false)
      expect(String(manifest.ttsReason)).toContain('未找到')
    } finally { cleanup() }
  })
})

describe('dsh-music-player playlists', () => {
  // helper: run a JSON POST and return the parsed body
  async function post(handler, url, payload) {
    const res = makeRes()
    await handler(
      makeReq({ method: 'POST', url, body: JSON.stringify(payload) }),
      res,
    )
    return { status: res.status, data: JSON.parse(res.body) }
  }

  it('exposes the fixed system playlist 我最喜欢 in the manifest', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(Array.isArray(data.playlists)).toBe(true)
      const fav = data.playlists.find((p) => p.id === 'pl-fav')
      expect(fav).toBeTruthy()
      expect(fav.name).toBe('我最喜欢')
      expect(fav.fixed).toBe(true)
      expect(fav.count).toBe(0)
      expect(fav.tracks).toEqual([])
    } finally { cleanup() }
  })

  it('creates a custom playlist and reports it in the manifest', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const r = await post(handler, '/dsh-music/playlist', { name: '通勤' })
      expect(r.status).toBe(200)
      expect(r.data.ok).toBe(true)
      expect(r.data.playlist.id).toMatch(/^pl-/)
      expect(r.data.playlist.name).toBe('通勤')
      expect(r.data.playlist.fixed).toBe(false)
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const names = JSON.parse(res.body).playlists.map((p) => p.name)
      expect(names).toContain('通勤')
    } finally { cleanup() }
  })

  it('rejects an empty playlist name', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const r = await post(handler, '/dsh-music/playlist', { name: '   ' })
      expect(r.status).toBe(400)
      expect(r.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('adds audio files to a playlist (dedup, skip invalid) and streams them via /file', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'extra/clip.mp3': 'CLIPDATA', 'extra/notes.txt': 'nope' },
      musicFiles: { 'a.mp3': 'A' },
    })
    try {
      const clip = join(home, 'extra', 'clip.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const id = created.data.playlist.id
      // adding the same path twice should dedup; a .txt must be skipped
      const add = await post(handler, '/dsh-music/playlist/add', {
        id, paths: [clip, clip, join(home, 'extra', 'notes.txt')],
      })
      expect(add.data.ok).toBe(true)
      expect(add.data.added).toBe(1)
      expect(add.data.playlist.count).toBe(1)
      expect(add.data.playlist.missing).toBe(0)
      expect(add.data.playlist.tracks[0].name).toBe('clip.mp3')
      expect(add.data.playlist.tracks[0].url.startsWith('/dsh-music/file?path=')).toBe(true)
      expect(add.data.playlist.tracks[0].size).toBe('CLIPDATA'.length)
      // the generic streaming route serves the playlist member
      const res = makeRes()
      await handler(makeReq({ url: add.data.playlist.tracks[0].url }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(Buffer.from(res.body).toString()).toBe('CLIPDATA')
    } finally { cleanup() }
  })

  it('streams a playlist member with Range (206) via /file', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'extra/clip.mp3': 'ABCDEFGHIJ' },
    })
    try {
      const clip = join(home, 'extra', 'clip.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      await post(handler, '/dsh-music/playlist/add', { id: created.data.playlist.id, paths: [clip] })
      const res = makeRes()
      await handler(makeReq({
        url: '/dsh-music/file?path=' + encodeURIComponent(clip),
        headers: { range: 'bytes=2-5' },
      }), res)
      expect(res.status).toBe(206)
      expect(res.headers['Content-Range']).toBe('bytes 2-5/10')
      expect(Buffer.from(res.body).toString()).toBe('CDEF')
    } finally { cleanup() }
  })

  it('rejects /file for an unregistered path with 403 and a missing file with 404', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'secret.mp3': 'SECRET', 'm/clip.mp3': 'CLIP' },
    })
    try {
      const secret = join(home, 'secret.mp3')
      // never added to any playlist -> not registered
      const forbidden = makeRes()
      await handler(makeReq({ url: '/dsh-music/file?path=' + encodeURIComponent(secret) }), forbidden)
      expect(forbidden.status).toBe(403)
      // register a real file, then delete it from disk -> still registered, now 404
      const clip = join(home, 'm', 'clip.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      await post(handler, '/dsh-music/playlist/add', { id: created.data.playlist.id, paths: [clip] })
      rmSync(clip, { force: true })
      const gone = makeRes()
      await handler(makeReq({ url: '/dsh-music/file?path=' + encodeURIComponent(clip) }), gone)
      expect(gone.status).toBe(404)
    } finally { cleanup() }
  })

  it('removes tracks from a playlist', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music/playlist/add', { id, paths: [a, b] })
      const rm = await post(handler, '/dsh-music/playlist/remove', { id, paths: [a] })
      expect(rm.data.removed).toBe(1)
      expect(rm.data.playlist.tracks.map((t) => t.name)).toEqual(['b.mp3'])
    } finally { cleanup() }
  })

  it('clears a playlist entirely (including the fixed one) via /playlist/clear', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music/playlist/add', { id, paths: [a, b] })
      const clr = await post(handler, '/dsh-music/playlist/clear', { id })
      expect(clr.data.ok).toBe(true)
      expect(clr.data.cleared).toBe(2)
      expect(clr.data.playlist.count).toBe(0)
      expect(clr.data.playlist.tracks).toEqual([])
      // fixed 系统歌单也可以清空
      await post(handler, '/dsh-music/playlist/add', { id: 'pl-fav', paths: [a] })
      const clrFav = await post(handler, '/dsh-music/playlist/clear', { id: 'pl-fav' })
      expect(clrFav.data.cleared).toBe(1)
      expect(clrFav.data.playlist.fixed).toBe(true)
      expect(clrFav.data.playlist.count).toBe(0)
      // unknown id -> 404
      const nf = await post(handler, '/dsh-music/playlist/clear', { id: 'pl-nope' })
      expect(nf.status).toBe(404)
    } finally { cleanup() }
  })

  it('reorders playlist members, appending unmentioned ones at the end', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B', 'm/c.mp3': 'C' },
    })
    try {
      const a = join(home, 'm', 'a.mp3')
      const b = join(home, 'm', 'b.mp3')
      const c = join(home, 'm', 'c.mp3')
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const id = created.data.playlist.id
      await post(handler, '/dsh-music/playlist/add', { id, paths: [a, b, c] })
      const re = await post(handler, '/dsh-music/playlist/reorder', { id, paths: [c, a] })
      expect(re.data.ok).toBe(true)
      expect(re.data.playlist.tracks.map((t) => t.name)).toEqual(['c.mp3', 'a.mp3', 'b.mp3'])
    } finally { cleanup() }
  })

  it('renames a custom playlist but rejects renaming the fixed one', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const ok = await post(handler, '/dsh-music/playlist/rename', { id: created.data.playlist.id, name: '新名字' })
      expect(ok.data.ok).toBe(true)
      expect(ok.data.playlist.name).toBe('新名字')
      const fixed = await post(handler, '/dsh-music/playlist/rename', { id: 'pl-fav', name: '改' })
      expect(fixed.status).toBe(400)
      expect(fixed.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('deletes a custom playlist but rejects deleting the fixed one', async () => {
    const { handler, cleanup } = boot({ musicFiles: {} })
    try {
      const created = await post(handler, '/dsh-music/playlist', { name: 'P' })
      const ok = await post(handler, '/dsh-music/playlist/delete', { id: created.data.playlist.id })
      expect(ok.data.ok).toBe(true)
      const fixed = await post(handler, '/dsh-music/playlist/delete', { id: 'pl-fav' })
      expect(fixed.status).toBe(400)
      expect(fixed.data.ok).toBe(false)
    } finally { cleanup() }
  })

  it('persists playlists to the state file and reloads a pre-seeded file', async () => {
    const { handler, home, cleanup } = boot({
      files: {
        '.dsh/music-player-playlists.json': JSON.stringify({
          version: 1,
          playlists: [{ id: 'pl-seed', name: '预置歌单', fixed: false, trackPaths: [], createdAt: 1, updatedAt: 1 }],
        }),
      },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const names = JSON.parse(res.body).playlists.map((p) => p.name)
      expect(names).toContain('预置歌单') // loaded from the pre-seeded file
      expect(names).toContain('我最喜欢') // system playlist still guaranteed
      // a create writes the file back
      await post(handler, '/dsh-music/playlist', { name: '持久' })
      const file = join(home, '.dsh', 'music-player-playlists.json')
      expect(existsSync(file)).toBe(true)
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.playlists.map((p) => p.name)).toContain('持久')
    } finally { cleanup() }
  })

  it('lists directories plus audio files (excluding others) via /files', async () => {
    const { handler, home, cleanup } = boot({
      files: { 'Music/sub/song.mp3': 'A', 'Music/a.mp3': 'B', 'Music/b.mp3': 'C', 'Music/notes.txt': 'x' },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/files?path=' + encodeURIComponent(join(home, 'Music')) }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      expect(data.dirs.map((d) => d.name)).toEqual(['sub'])
      const fileNames = data.files.map((f) => f.name).sort()
      expect(fileNames).toEqual(['a.mp3', 'b.mp3'])
      for (const f of data.files) expect(typeof f.path).toBe('string')
    } finally { cleanup() }
  })

  it('plays a playlist via the music_play playlist param', async () => {
    const { handler, tools, home, cleanup } = boot({
      files: { 'm/a.mp3': 'A', 'm/b.mp3': 'B' },
    })
    try {
      const created = await post(handler, '/dsh-music/playlist', { name: '最爱' })
      const pl = created.data.playlist
      await post(handler, '/dsh-music/playlist/add', { id: pl.id, paths: [join(home, 'm', 'a.mp3')] })
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ playlist: '最爱' })
      expect(out.played).toBe(true)
      expect(out.matches).toBe(1)
      expect(out.track).toBe('a.mp3')
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/intent' }), res)
      const intent = JSON.parse(res.body)
      expect(intent.action).toBe('play')
      expect(intent.playlistId).toBe(pl.id)
      expect(intent.playlistName).toBe('最爱')
      expect(intent.id).toBeTruthy()
    } finally { cleanup() }
  })

  it('reports an unknown playlist name via music_play', async () => {
    const { tools, cleanup } = boot({ musicFiles: { 'a.mp3': 'A' } })
    try {
      const tool = tools.find((t) => t.name === 'music_play')
      const out = await tool.execute({ playlist: '不存在的歌单' })
      expect(out.played).toBe(false)
      expect(out.notice).toContain('没有找到歌单')
    } finally { cleanup() }
  })
})

describe("dsh-music-player What's New (版本更新弹窗)", () => {
  it('manifest 下发四件套：首装为 fresh，写过已看标记后为 seen', async () => {
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      const data = JSON.parse(res.body)
      expect(res.status).toBe(200)
      // 四件套：当前版条目 / 历史列表 / 欢迎内容 / 判定结论
      expect(Array.isArray(data.whatsNewHistory)).toBe(true)
      expect(data.whatsNewHistory.length).toBeGreaterThan(0)
      expect(data.whatsNewWelcome && Array.isArray(data.whatsNewWelcome.sections)).toBe(true)
      expect(['fresh', 'upgrade', 'seen', 'downgrade']).toContain(data.whatsNewState)
      // 条目允许缺省（本版没写就不下发），但存在时必须对应当前版本号
      if (data.whatsNew !== null) {
        expect(data.whatsNew.version).toBe(data.version)
      }
      // 首装（无任何 prefs 记录）→ fresh
      expect(data.whatsNewState).toBe('fresh')

      // 客户端关闭弹窗后 POST 的已看标记：写入并持久化，判定翻转为 seen
      const res2 = makeRes()
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/prefs',
        body: JSON.stringify({ prefs: { 'dsh-music-seen-version': data.version } }),
      }), res2)
      expect(JSON.parse(res2.body).ok).toBe(true)
      const res3 = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res3)
      expect(JSON.parse(res3.body).whatsNewState).toBe('seen')
      // 注：loadPrefs 每次都重读 prefs 文件，所以上一步的 seen 判定本身已证明
      // 标记落盘——新进程重读同样能拿到。
    } finally { cleanup() }
  })

  it('老用户启发式：无已看记录但 prefs 已有其他键 → upgrade', async () => {
    const { handler, cleanup } = boot({
      files: { '.dsh/music-player-prefs.json': JSON.stringify({ version: 2, prefs: { 'dsh-music-volume': '0.5' } }) },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      expect(JSON.parse(res.body).whatsNewState).toBe('upgrade')
    } finally { cleanup() }
  })

  it('降级安装判定为 downgrade；seen-version 脏值被 sanitize 丢弃', async () => {
    const { handler, cleanup } = boot({
      files: { '.dsh/music-player-prefs.json': JSON.stringify({ version: 2, prefs: { 'dsh-music-seen-version': '99.0.0' } }) },
    })
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/manifest' }), res)
      expect(JSON.parse(res.body).whatsNewState).toBe('downgrade')

      // POST 非版本号形态的脏值 → 被 sanitizePrefs 丢弃，原值保持不变
      const res2 = makeRes()
      await handler(makeReq({
        method: 'POST', url: '/dsh-music/prefs',
        body: JSON.stringify({ prefs: { 'dsh-music-seen-version': 'not a version!' } }),
      }), res2)
      const res3 = makeRes()
      await handler(makeReq({ url: '/dsh-music/prefs' }), res3)
      expect(JSON.parse(res3.body).prefs['dsh-music-seen-version']).toBe('99.0.0')
    } finally { cleanup() }
  })

  it('rescan 路由同样下发 What\'s New 四件套', async () => {
    const { handler, cleanup } = boot({ musicFiles: { 'a.mp3': 'AUDIO' } })
    try {
      const res = makeRes()
      await handler(makeReq({ method: 'POST', url: '/dsh-music/rescan' }), res)
      const data = JSON.parse(res.body)
      expect(data.ok).toBe(true)
      expect(Array.isArray(data.whatsNewHistory)).toBe(true)
      expect(['fresh', 'upgrade', 'seen', 'downgrade']).toContain(data.whatsNewState)
      expect(data.whatsNewWelcome && Array.isArray(data.whatsNewWelcome.sections)).toBe(true)
    } finally { cleanup() }
  })
})
