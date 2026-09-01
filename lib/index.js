/**
 * dsh-music-player host half: a plain Cordis plugin running in the host
 * process. It scans the local music directory (default $HOME/Music, or a
 * directory configured through the settings page), streams audio per track
 * through /dsh-music/<id> with Range/seek support, and answers the browser
 * half's JSON calls (manifest / intent / set-root) over the same webServer.
 * It also registers the `music_play` model tool, which lets the CLI/agent ask
 * to play a track; the browser half polls /dsh-music/intent to pick it up.
 *
 * All registrations are effects so the row unmounts cleanly.
 */

// ---- settings constants, mirrored by the client via the manifest route ----
const AUDIO_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', webm: 'audio/webm', aiff: 'audio/aiff', aif: 'audio/aiff',
}

const QQ_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function isAudioName(name) {
  const i = name.lastIndexOf('.')
  return i > 0 && Object.prototype.hasOwnProperty.call(AUDIO_TYPES, name.slice(i + 1).toLowerCase())
}
function audioType(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? (AUDIO_TYPES[name.slice(i + 1).toLowerCase()] || 'application/octet-stream') : 'application/octet-stream'
}

// 在线 QQ 音乐：把取链返回的 filename（如 "F000<mid><mid>.flac" / "M800<mid><mid>.mp3"）
// 映射成普通用户能看懂的通俗音质标签，随播放流一起回传浏览器显示在播放条上。
// 服务端授予的档位以 filename 前缀 + 扩展名为准：
//   - 四档 FLAC（AI00 / Q001 / Q000 / F000）→ 无损
//   - OGG（O801）与 320k MP3（M800）→ 高音质（用户感知一致，并入同一档）
//   - 128k MP3（M500）→ 标准
// 取不到 / 未知档位返回空串，此时播放条只显示「QQ音乐」。
export function qqQualityLabel(filename) {
  const f = String(filename || '')
  const ext = (f.slice(f.lastIndexOf('.') + 1) || '').toLowerCase()
  if (ext === 'flac') return '无损'
  if (ext === 'ogg') return '高音质'
  if (ext === 'mp3') {
    // filename 形如 "M800<mid><mid>.mp3"：mp3 档位由前缀决定（320k 高音质 / 128k 标准）。
    if (/^M800/i.test(f)) return '高音质'
    if (/^M500/i.test(f)) return '标准'
  }
  return ''
}

// ---- 本地音乐：解析音频文件头识别真实音质 ----
// 扫描时读每首歌的前 ~64KB 解析容器头，得到编码/采样率/位深/声道/码率，映射成与
// 在线 QQ 一致的「无损 / 高音质 / 标准」三档。无新依赖（纯 node:fs + Buffer）。
const AUDIO_HEADER_LEN = 64 * 1024
const AUDIO_LOSSY_HIGH_KBPS = 256 // 有损 ≥ 256kbps 视为「高音质」，否则「标准」
const AUDIO_CODEC_NAMES = { FLAC: 'FLAC', WAV: 'WAV', AIFF: 'AIFF', MP3: 'MP3', AAC: 'AAC', OGG: 'OGG', Opus: 'Opus' }

function mpegLayer3Kbps(version, idx) {
  if (idx === 0 || idx > 14) return 0
  if (version === 1) return [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][idx]
  return [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][idx]
}
function mpegSampleRate(version, idx) {
  if (idx > 2) return 0
  if (version === 1) return [44100, 48000, 32000][idx]
  if (version === 2) return [22050, 24000, 16000][idx]
  return [11025, 12000, 8000][idx]
}
// AIFF 80-bit 扩展浮点采样率解码。
function aiffSampleRate(b, off) {
  const exp = ((b[off] & 0x7f) << 8) | b[off + 1]
  let mant = 0
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[off + 2 + i]
  if (exp === 0 && mant === 0) return 0
  if (exp === 0x7fff) return 0
  return (mant / 2 ** 63) * 2 ** (exp - 16383)
}

// 在缓冲区里扫描 MPEG 音频（MP3 Layer III）帧头，返回首帧的码率/采样率/声道。
// 带「下一帧同步」校验：按帧长跳到下一帧位置应再遇一个合法同步字，能显著降低
// 非音频数据（如 FLAC 流里碰巧出现的 0xFF..）被误判成 MP3 的假同步概率。
function parseMpegFrame(b, off) {
  const n = b.length
  for (let i = off; i + 4 <= n; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue
    // 跳过 ADTS（裸 AAC）帧：byte1 低半字节为 0x1/0x9 且 layer 位为 0。
    if ((b[i + 1] & 0x0f) === 0x01 || (b[i + 1] & 0x0f) === 0x09) continue
    const versionBits = (b[i + 1] >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (b[i + 1] >> 1) & 0x03 // 1=Layer III
    if (versionBits === 1 || layerBits !== 1) continue // 保留位 / 非 Layer III
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5
    const kbps = mpegLayer3Kbps(version, (b[i + 2] >> 4) & 0x0f)
    const rate = mpegSampleRate(version, (b[i + 2] >> 2) & 0x03)
    if (kbps === 0 || rate === 0) continue
    // 帧长一致性：Layer III 帧长 = (samplesPerFrame/8 * bitrate) / samplerate + padding。
    const padding = (b[i + 2] >> 1) & 0x01
    const frameLen = Math.floor((version === 1 ? 144 : 72) * kbps * 1000 / rate) + padding
    if (i + frameLen + 4 <= n) {
      const nx = i + frameLen
      if (!(b[nx] === 0xff && (b[nx + 1] & 0xe0) === 0xe0)) continue // 下一帧不同步 → 假同步，继续找
    }
    const chmode = (b[i + 3] >> 6) & 0x03
    return { bitrateKbps: kbps, sampleRate: rate, channels: chmode === 3 ? 1 : 2, tier: kbps >= AUDIO_LOSSY_HIGH_KBPS ? '高音质' : '标准' }
  }
  return null
}

// 有界 M4A/MP4 盒解析：取 mvhd(时长) 与 stsd>mp4a(采样率/声道)。注意 stsd 带自己的
// version/flags/entry_count 头（8 字节），递归进 stsd 时要先跳过它；真实文件嵌套
// moov>trak>mdia>minf>stbl>stsd>mp4a 达 6 层，深度上限放宽到 8。
function parseM4a(b, n) {
  let sampleRate = 0, channels = 0, duration = 0, timescale = 1, hasMp4a = false
  const walk = (start, end, depth) => {
    let off = start
    while (off + 8 <= end) {
      const size = b.readUInt32BE(off)
      const type = b.toString('ascii', off + 4, off + 8)
      if (size < 8) break
      const cs = off + 8
      const ce = Math.min(off + size, end)
      if (type === 'mvhd' && cs + 16 <= ce) {
        if (b[cs] === 0) { timescale = b.readUInt32BE(cs + 12); duration = b.readUInt32BE(cs + 16) }
        else if (cs + 28 <= ce) { timescale = b.readUInt32BE(cs + 20); duration = b.readUInt32BE(cs + 24) * 2 ** 32 + b.readUInt32BE(cs + 28) }
      }
      if (type === 'mp4a' && cs + 28 <= ce) {
        channels = b.readUInt16BE(cs + 16)
        sampleRate = Math.round(b.readUInt32BE(cs + 24) / 65536)
        hasMp4a = true
      }
      if (depth < 8) walk(cs + (type === 'stsd' ? 8 : 0), ce, depth + 1)
      off += size
    }
  }
  walk(0, n, 0)
  if (!hasMp4a) return null
  return { sampleRate, channels, durationSec: timescale > 0 ? duration / timescale : 0 }
}

// 有界 EBML(WebM) 扫描：找 CodecID / SamplingFrequency / Channels。
function parseEbml(b, n) {
  let codec = '', rate = 0, ch = 0
  for (let i = 0; i + 2 < n;) {
    const id = b[i]
    if (id === 0x86 && i + 2 <= n) { // CodecID
      const len = b[i + 1]
      if (i + 2 + len <= n) codec = b.toString('ascii', i + 2, i + 2 + len)
      i += 2 + len
    } else if (id === 0xb5 && i + 2 <= n) { // SamplingFrequency (float)
      const len = b[i + 1]
      if (len === 4 && i + 6 <= n) rate = b.readUInt32BE(i + 2)
      i += 2 + len
    } else if (id === 0x9f && i + 2 <= n) { // Channels (uint)
      const len = b[i + 1]
      if (len === 1 && i + 3 <= n) ch = b[i + 2]
      i += 2 + len
    } else { i++ }
  }
  if (codec === 'A_OPUS') return { codec: 'Opus', sampleRate: rate, channels: ch, tier: '高音质' }
  if (codec === 'A_VORBIS') return { codec: 'OGG', sampleRate: rate, channels: ch, tier: '' }
  return null
}

// 在 buf[off] 处按魔数识别容器格式并解析（FLAC/WAV/AIFF/OGG/M4A/EBML）。用 subarray
// 让各解析器的内部偏移都相对容器起点，便于处理「ID3 前缀 + 真实容器」的组合文件
// （部分下载工具会给 FLAC/OGG 贴一个 ID3v2 标签）。
function parseContainerAt(buf, off, size) {
  const b = buf.subarray(off)
  const n = b.length
  if (n < 8) return null
  const ascii = (o, l) => b.toString('ascii', o, o + l)
  // FLAC
  if (ascii(0, 4) === 'fLaC') {
    if ((b[4] & 0x7f) === 0 && n >= 42) { // STREAMINFO 块：type 0 + 34 字节体
      const v = (BigInt(b.readUInt32BE(18)) << 32n) | BigInt(b.readUInt32BE(22))
      const sampleRate = Number((v >> 44n) & 0xfffffn)
      const channels = Number((v >> 41n) & 0x7n) + 1
      const bits = Number((v >> 36n) & 0x1fn) + 1
      return { codec: 'FLAC', sampleRate, channels, bitDepth: bits, tier: '无损' }
    }
    return { codec: 'FLAC', tier: '无损' }
  }
  // WAV
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    let p = 12
    while (p + 8 <= n) {
      const id = ascii(p, 4)
      const sz = b.readUInt32LE(p + 4)
      if (id === 'fmt ') {
        const fmt = b.readUInt16LE(p + 8)
        if (fmt === 1 || fmt === 3) return { codec: 'WAV', sampleRate: b.readUInt32LE(p + 12), channels: b.readUInt16LE(p + 10), bitDepth: b.readUInt16LE(p + 22), tier: '无损' }
        return { codec: 'WAV', tier: '无损' }
      }
      p += 8 + sz + (sz & 1)
    }
    return { codec: 'WAV', tier: '无损' }
  }
  // AIFF / AIFC
  if (ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) {
    let p = 12
    while (p + 8 <= n) {
      const id = ascii(p, 4)
      const sz = b.readUInt32BE(p + 4)
      if (id === 'COMM') {
        const rate = aiffSampleRate(b, p + 16)
        return { codec: 'AIFF', sampleRate: Math.round(rate), channels: b.readUInt16BE(p + 8), bitDepth: b.readUInt16BE(p + 14), tier: '无损' }
      }
      p += 8 + sz + (sz & 1)
    }
    return { codec: 'AIFF', tier: '无损' }
  }
  // Ogg（Vorbis / Opus）
  if (ascii(0, 4) === 'OggS') {
    const head = b.toString('latin1', 0, Math.min(n, 128))
    const vi = head.indexOf('\x01vorbis')
    if (vi >= 0 && vi + 24 <= n) {
      const ch = b[vi + 11]
      const rate = b.readUInt32LE(vi + 12)
      const bitrateNom = b.readUInt32LE(vi + 20)
      return { codec: 'OGG', sampleRate: rate, channels: ch, bitrateKbps: Math.round(bitrateNom / 1000), tier: bitrateNom >= AUDIO_LOSSY_HIGH_KBPS * 1000 ? '高音质' : '标准' }
    }
    const oi = head.indexOf('OpusHead')
    if (oi >= 0 && oi + 13 <= n) {
      return { codec: 'Opus', sampleRate: b.readUInt32LE(oi + 12), channels: oi + 10 <= n ? b[oi + 9] : 0, tier: '高音质' }
    }
    return null
  }
  // M4A / MP4
  if (ascii(4, 4) === 'ftyp') {
    const m = parseM4a(b, n)
    if (m) {
      const bitrate = size > 0 && m.durationSec > 0 ? Math.round((size * 8) / m.durationSec / 1000) : 0
      return { codec: 'AAC', sampleRate: m.sampleRate, channels: m.channels, bitrateKbps: bitrate, tier: bitrate > 0 ? (bitrate >= AUDIO_LOSSY_HIGH_KBPS ? '高音质' : '标准') : '' }
    }
    return null
  }
  // WebM / EBML
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return parseEbml(b, n) || null
  }
  return null
}

/**
 * 解析音频文件头（前几十 KB）识别音质。返回
 * { codec, sampleRate?, channels?, bitDepth?, bitrateKbps?, tier? } 或 null。
 * tier 与在线一致的三档：无损 / 高音质 / 标准。`size` 为完整文件大小（M4A 估码率用）。
 * 按内容（魔数）而非扩展名识别：扩展名标错的文件如实反映真实格式。
 * 导出供测试。
 */
export function parseAudioMeta(buf, ext = '', size = 0) {
  const b = buf
  if (b.length < 8) return null
  try {
    // 带 ID3v2 前缀：可能是 MP3，也可能是「ID3 + 真实容器」（部分下载工具给 FLAC/OGG 贴 ID3）。
    // 先跳标签、按内容识别容器；识别不出再兜底扫 MPEG 帧（避免把 FLAC 数据误判成 MP3）。
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // 'ID3'
      const tagSize = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
      const skip = 10 + tagSize + ((b[5] & 0x10) ? 10 : 0)
      if (skip >= b.length) return null
      const c = parseContainerAt(b, skip, size)
      if (c) return c
      const r = parseMpegFrame(b, skip)
      if (r) return { codec: 'MP3', ...r }
      return null
    }
    // 无 ID3：先容器，后裸 MPEG（无标签的 mp3）
    const c = parseContainerAt(b, 0, size)
    if (c) return c
    const r = parseMpegFrame(b, 0)
    if (r) return { codec: 'MP3', ...r }
    return null
  } catch { /* 解析失败 → null（无标签） */ }
  return null
}

// 拼成播放条标签：「格式 · 档位」（如 FLAC · 无损 / MP3 · 高音质）。分不出档时只显示格式。
export function audioQualityLabel(meta) {
  if (!meta || !meta.codec) return ''
  const name = AUDIO_CODEC_NAMES[meta.codec] || meta.codec
  return meta.tier ? name + ' · ' + meta.tier : name
}

// =====================================================================
// 内嵌歌词提取：从音频文件自带的元数据标签里读回内嵌歌词，返回原始歌词文本
// （多为标准 LRC 格式，含 [mm:ss] 时间戳，可直接交给 parseLrc）或 null。
//
// 支持的容器/标签：
//   · FLAC：VORBIS_COMMENT 块里的 LYRICS / UNSYNCEDLYRICS 键（千千静听/酷狗等写入，
//     实测为完整 LRC 文本，含 [ti:]/[ar:] 头与逐句时间戳）。
//   · MP3：ID3v2 的 USLT（未同步歌词）帧。
//   · OGG/Opus：与 FLAC 同构的 Vorbis 注释（OggS 首包里的 \x01vorbis 注释），复用 FLAC 逻辑。
//
// 已知边界：MP3 的 SYLT（同步歌词）帧体为二进制、编码复杂，暂不解析（返回 null，
// 交由在线兜底）；部分「ID3 前缀 + 真实容器」的组合文件会先跳标签再按容器识别。
// 仅当解出「非空歌词文本」才返回——只有 [ti:]/[ar:] 头、没有正文的「空歌词」视为无词。
// 纯函数、无副作用，导出供测试。
// =====================================================================
export function extractEmbeddedLyric(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  const head = buf.toString('ascii', 0, 4)
  if (head === 'fLaC') return extractFlacLyric(buf)
  if (head === 'OggS') return extractOggLyric(buf)
  // MP3：ID3v2 标签（USLT 帧）；也可能是「ID3 前缀 + FLAC/OGG 容器」。
  // 注意：ID3 后紧跟版本字节，只取前 3 字节比对，避免把版本字节带进魔数。
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const ly = extractId3Uslt(buf)
    if (ly !== null) return ly
    const inner = skipId3Prefix(buf)
    if (inner !== null) {
      const h2 = inner.toString('ascii', 0, 4)
      if (h2 === 'fLaC') return extractFlacLyric(inner)
      if (h2 === 'OggS') return extractOggLyric(inner)
    }
  }
  return null
}

// 跳过一个 ID3v2 标签，返回其后内容（若标签尺寸合法）；否则 null。
function skipId3Prefix(buf) {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null
  const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  const footer = (buf[5] & 0x10) ? 10 : 0
  const skip = 10 + tagSize + footer
  if (skip >= buf.length) return null
  return buf.subarray(skip)
}

// —— FLAC：遍历元数据块，在 VORBIS_COMMENT（type 4）里找 LYRICS 键 ——
function extractFlacLyric(buf) {
  let p = 4
  let last = false
  while (!last && p + 4 <= buf.length) {
    const hdr = buf[p]
    last = !!(hdr & 0x80)
    const type = hdr & 0x7f
    const len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]
    const body = p + 4
    if (type === 4) {
      const text = readVorbisLyrics(buf, body, Math.min(body + len, buf.length))
      if (text !== null) return text
    }
    p = body + len
    if (p > buf.length) break
  }
  return null
}

// —— OGG（Vorbis/Opus）：首包后的注释包（类型 3，含 \x01vorbis 或 \x80opus 头的包）
//    里是 Vorbis 注释，结构与 FLAC 的 VORBIS_COMMENT 一致 ——
function extractOggLyric(buf) {
  const head = buf.toString('latin1', 0, Math.min(buf.length, 2000))
  // 在 OggS 页面里定位注释页：第一页通常是识别头（\x01vorbis / OpusHead），
  // 第二页是注释页（含 vorbis 注释）。这里做一次宽松扫描，命中 \x01vorbis 注释头即解析。
  const idx = head.indexOf('\x01vorbis')
  if (idx < 0) return null
  // 注释包紧随识别头之后；其首字段就是 vendor 长度（与 FLAC 相同的 vorbis 注释布局）。
  const start = idx + 7 // 跳过 "\x01vorbis" 与 type
  return readVorbisLyrics(buf, start, Math.min(buf.length, 64 * 1024))
}

// 在 [start, end) 内按 Vorbis 注释布局解析，返回 LYRICS/UNSYNCEDLYRICS 键的值（非空时）。
function readVorbisLyrics(buf, start, end) {
  let q = start
  if (q + 4 > end) return null
  const vlen = buf.readUInt32LE(q); q += 4
  q += vlen
  if (q + 4 > end) return null
  const count = buf.readUInt32LE(q); q += 4
  let lyric = null
  for (let i = 0; i < count && q + 4 <= end; i++) {
    const clen = buf.readUInt32LE(q); q += 4
    if (q + clen > end) break
    const cmt = buf.toString('utf8', q, q + clen)
    q += clen
    const eq = cmt.indexOf('=')
    if (eq < 0) continue
    const key = cmt.slice(0, eq).toUpperCase()
    const val = cmt.slice(eq + 1)
    if ((key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'UNSYNCED LYRICS') && val.trim() !== '') {
      lyric = val
    }
  }
  return lyric
}

// —— MP3：遍历 ID3v2 帧，读取 USLT（未同步歌词）帧 ——
function extractId3Uslt(buf) {
  if (buf.length < 10) return null
  const major = buf[3]
  const syncsafe = major >= 4 // v2.4+ 用 syncsafe 尺寸；v2.3 及更早用普通 32 位
  const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  const end = Math.min(10 + tagSize, buf.length)
  let p = 10
  while (p + 10 <= end) {
    const id = buf.toString('latin1', p, p + 4)
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    let fsz
    if (syncsafe) fsz = ((buf[p + 4] & 0x7f) << 21) | ((buf[p + 5] & 0x7f) << 14) | ((buf[p + 6] & 0x7f) << 7) | (buf[p + 7] & 0x7f)
    else fsz = buf.readUInt32BE(p + 4)
    const fflags = buf.readUInt16BE(p + 8)
    const frameEnd = p + 10 + fsz
    let off = p + 10
    if (fflags & 0x80) off += 4          // compression
    if (fflags & 0x40) off += 1          // encryption method
    if (fflags & 0x20) off += 1          // grouping id
    if (id === 'USLT' && off + 4 <= frameEnd) {
      const enc = buf[off]
      // USLT 体：编码字节 + 3 字节语言 + 内容描述（按编码终止）+ 歌词正文
      const textStart = off + 4
      let descEnd = id3FindTerminator(buf, textStart, frameEnd, enc)
      if (descEnd === -1) descEnd = textStart
      const text = id3DecodeText(buf, descEnd, frameEnd, enc)
      if (text !== null && text.trim() !== '') return text
    }
    p = frameEnd
  }
  return null
}

// 返回 [start, end) 内第一个按 enc 编码的字符串终止符位置（指向终止符之后的正文起点），
// 找不到返回 -1。
function id3FindTerminator(buf, start, end, enc) {
  let i = start
  if (enc === 0 || enc === 3) {
    // ISO-8859-1 / UTF-8：单字节 0x00
    while (i < end) { if (buf[i] === 0x00) return i + 1; i++ }
  } else {
    // UTF-16（带 BOM 或 BE）：双字节 0x00 0x00
    while (i + 1 < end) { if (buf[i] === 0x00 && buf[i + 1] === 0x00) return i + 2; i++ }
  }
  return -1
}

// 按 enc 编码解码 [start, end) 的歌词正文。
function id3DecodeText(buf, start, end, enc) {
  if (start >= end) return ''
  const slice = buf.subarray(start, end)
  try {
    if (enc === 0) return slice.toString('latin1')
    if (enc === 1 || enc === 2) {
      // UTF-16（可能带 BOM）
      return new TextDecoder('utf-16le', { fatal: false }).decode(slice)
    }
    return slice.toString('utf8') // enc 3：UTF-8
  } catch { return '' }
}

// Books: local novel files we can read and turn into speech — plain text
// (.txt) and EPUB (a ZIP container whose spine XHTML we flatten to text).
function isBookName(name) {
  const i = name.lastIndexOf('.')
  if (i <= 0) return false
  const ext = name.slice(i + 1).toLowerCase()
  return ext === 'txt' || ext === 'epub'
}
// Upper bound of characters sent to the TTS model in one synthesis call.
// Kept small: a 500-char chunk measured ~20-50s of synthesis (the browser shows
// "缓冲中" the whole time), while a ~150-char chunk synthesizes in ~5-10s. With
// the synthesized-audio cache below, the next chunk is generated while the
// current one plays, so smaller chunks lower first-audio latency without
// audible gaps between blocks. This caps how much text goes into ONE synthesis
// call (each chunk is synthesized separately). It is NOT the subtitle line cap:
// the client divides a chunk's text into display lines (splitSentences) and
// does not use this limit.
export const MAX_TTS_CHARS = 150

// Chinese dialogue quotes treated as atomic when splitting prose: a 。！？…； inside
// “...” / 「...」 / 『...』 must NOT cut the sentence, so the whole quoted speech
// stays together in one chunk (and reads as a single utterance).
const QUOTE_PAIRS = { '“': '”', '「': '」', '『': '』', '"': '"' }
const isQuoteOpen = (c) => Object.prototype.hasOwnProperty.call(QUOTE_PAIRS, c)
const isLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF
// Natural clause-pause characters: prefer breaking an over-long sentence here
// rather than hard-slicing mid-word. `，`/`、` etc. never split a quoted span.
const CLAUSE_BREAKS = '，、：；——…'

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs'
import { dirname, basename, parse as pathParse, join as pathJoin } from 'node:path'
import { inflateRawSync, inflateSync } from 'node:zlib'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import * as QQ from './qq.js'
import * as KG from './kugou.js'
import { getOnlineLyric } from './lyric.js'
import { whatsNewFor, whatsNewState, WELCOME, PREF_SEEN_VERSION } from './whatsnew.js'
import {
  PRESET_CATEGORIES, LIMITS,
  sanitizeEditionInput, buildEdition, applyRetention, findInCooldown, partitionStaleNews,
  summarizeEdition, metaForEdition, estimateMinutes, formatDateCn,
  sanitizeSchedulePrefs, runStateAlive, sanitizeModelSelection,
  normalizeShiftItemCount, evenItemQuota, capCategoriesToQuota,
} from './news-core.js'

// 插件版本号 + 简介：从包根 package.json 读取，随 /dsh-music/manifest 下发给浏览器，
// 供播放面板「关于」页展示（单一数据源，无需在两端手工维护）。
const require = createRequire(import.meta.url)
const PKG_META = (() => {
  try {
    const p = require('../package.json')
    return { version: String(p.version || ''), description: String(p.description || '') }
  } catch (e) { return { version: '', description: '' } }
})()
const PKG_VERSION = PKG_META.version
const PKG_DESCRIPTION = PKG_META.description

// 版本更新弹窗（What's New）：当前版本的更新条目 + 历史列表（whatsnew.js 维护，
// 发版时在数组顶部追加）。entry 为 null 表示本版没写条目 → 不弹窗。
const WHATSNEW_PKG = whatsNewFor(PKG_VERSION)

// ---- book structure parsing (title / preface / chapters / epilogue) ----
// Heuristic, rule-based parser that splits a novel's normalized text into
// sections so the reader can show a table of contents and jump to a chapter.
// Validated against a corpus of real books; see docs/book-parsing-design.md for
// the algorithm and its documented limits.
// Numerals run up to 8 chars for 4-digit chapters (第一千九百九十九 = 7), and 两
// is a valid digit (第两千零一章) — capping at {1,5} silently dropped every
// chapter numbered 第一千一百零一 … (6+ chars) from the TOC.
const STRUCT_NUM_CHARS = '0-9一二两三四五六七八九十百千万零〇'
const STRUCT_CHAPTER_RE = new RegExp('^第\\s*[' + STRUCT_NUM_CHARS + ']{1,8}\\s*[章节回卷]')
const STRUCT_PART_RE = new RegExp('^第\\s*[' + STRUCT_NUM_CHARS + ']{1,8}\\s*(?:部|篇|集)|^(?:卷|部|篇|集|部分)\\s*[' + STRUCT_NUM_CHARS + ']+|^[' + STRUCT_NUM_CHARS + ']{1,4}\\s*(?:部|卷|篇|集)')
const STRUCT_PREFACE_WORDS = ['前言', '自序', '序言', '序文', '代序', '引言', '楔子', '引子', '题记', '开篇', '开端', '卷首语', '卷前语', '简介', '内容简介', '内容提要', '提要', '作者简介', '出版说明', '编者按', '导读', '序']
const STRUCT_EPILOGUE_WORDS = ['尾声', '后记', '结语', '跋', '补记', '附记', '附录', '番外', '外传', '终章', '结局', '大结局']
const STRUCT_NUM_RE = /^[0-9]{1,3}[.、．\s]/
const STRUCT_CN_NUM_RE = /^[一二三四五六七八九十]{1,4}[、．. 　]/
const STRUCT_BULLET_RE = /^[◇◆●▲▪·•]/
const STRUCT_TOC_RE = /^目录/

// Volume-prefixed chapter: `精绝古城 第五章 火瓢虫` — a short volume name, then
// the chapter token, then the title. Common in multi-volume compendiums where
// every heading repeats its volume (鬼吹灯全集 style). The full line stays the
// heading text so the TOC still tells the volumes apart.
const STRUCT_VOL_CHAPTER_RE = new RegExp(
  '^([\\u4e00-\\u9fffA-Za-z0-9]{2,12})\\s+(第[' + STRUCT_NUM_CHARS + ']{1,8}[章节回卷])\\s+([^。！？；…\\n]{2,20})$'
)

// Strong heading kinds only: a decorated line may adopt these once its
// decoration is stripped, never the riskier named/bullet/num kinds.
const STRUCT_DECOR_SAFE_KINDS = new Set(['chapter', 'part', 'preface', 'epilogue'])

// Classify a line's heading patterns. Returns null when the line does not look
// like a structured heading (the caller then applies the named/body heuristics).
function structClassifyHeading(s) {
  if (STRUCT_TOC_RE.test(s)) return { kind: 'toc', len: s.length, text: s }
  if (STRUCT_PART_RE.test(s)) return { kind: 'part', len: s.length, text: s }
  if (STRUCT_CHAPTER_RE.test(s)) return { kind: 'chapter', len: s.length, text: s }
  for (const w of STRUCT_PREFACE_WORDS) {
    if (s === w || s.startsWith(w + ' ') || s.startsWith(w + '　') || s.startsWith(w + '：') || s.startsWith(w + ':')) {
      if (s.length <= 14) return { kind: 'preface', len: s.length, text: s }
    }
  }
  for (const w of STRUCT_EPILOGUE_WORDS) {
    if (s === w || s.startsWith(w + ' ') || s.startsWith(w + '　')) {
      if (s.length <= 14) return { kind: 'epilogue', len: s.length, text: s }
    }
  }
  return null
}

function structClassifyLine(raw) {
  // Strip WPS/Founder typesetting codes (〖BT3〗/〖KH*2〗) and invisible leftovers
  // (private-use area, zero-width) that GBK decoding can leave after a sentence —
  // they would defeat the $ anchors below. The cleaned `text` is what becomes the
  // section heading.
  const s = raw
    .replace(/[〖【][^〗】]{0,24}[〗】]/g, '')
    .replace(/[\uE000-\uF8FF\uFFFD\u200b\u200c\u200d\u00a0\u3000]/g, '')
    .trim()
  if (s === '') return { kind: 'body', len: 0, text: '' }
  // A line made purely of ornament (———— / ······ / ***…) is a visual separator,
  // not a heading — without this guard the dash rows become bogus sections that
  // read their dashes aloud and swallow the whole tail of the book.
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(s)) return { kind: 'body', len: 0, text: '' }
  const direct = structClassifyHeading(s)
  if (direct) return direct
  // Decorated headings are the norm in downloaded .txt files:
  // `★盗墓笔记·秦岭神树篇·南派三叔·第一章 老痒出狱`. Strip a bounded run of
  // leading ornament symbols and `前缀·` chains, then re-classify the remainder.
  // Only strong heading kinds may match, the line must stay heading-sized, and
  // the stored text is the clean remainder — so the TTS reads `第一章 老痒出狱`,
  // not the star and the site credits.
  if (s.length <= 40) {
    let t = s.replace(/^[\s★●◆◇■□▲△☆♦♣♥♠▪#*•▶►~～-]+/, '')
    for (let i = 0; i < 6 && /^[^，。！？；：、""''（）()【】\[\]《》]{1,12}[·•]/.test(t); i++) {
      t = t.replace(/^[^，。！？；：、""''（）()【】\[\]《》]{1,12}[·•]/, '').trim()
    }
    if (t && t !== s) {
      const res = structClassifyHeading(t)
      if (res && STRUCT_DECOR_SAFE_KINDS.has(res.kind)) {
        return { kind: res.kind, len: res.text.length, text: res.text }
      }
    }
    // Volume-prefixed chapter (`精绝古城 第五章 火瓢虫`): the whole line stays
    // the heading so the TOC still tells the volumes apart. Sentence-final
    // punctuation anywhere disqualifies it (that would be a body line).
    if (s.length <= 30 && !/[。！？；…]/.test(s)) {
      const vm = STRUCT_VOL_CHAPTER_RE.exec(s)
      if (vm !== null) return { kind: 'chapter', len: s.length, text: s }
    }
  }
  if (STRUCT_BULLET_RE.test(s) && s.length <= 25) return { kind: 'bullet', len: s.length, text: s }
  if ((STRUCT_NUM_RE.test(s) || STRUCT_CN_NUM_RE.test(s)) && s.length <= 22) return { kind: 'num', len: s.length, text: s }
  // A standalone short line with no sentence-final punctuation is a common
  // "named section" convention in Chinese literary fiction (e.g. "麻将牌").
  // Lines containing quote marks never qualify: a quoted `“有害吗？”大奎马上问`
  // is dialogue, and in blank-line-separated txt layouts such a line would
  // otherwise be crowned a fake section heading swallowing everything after it.
  if (s.length >= 2 && s.length <= 12 && !/[。！？；…！？"”]$/.test(s)
    && !/["“”『』「」]/.test(s) && !/[，,、：:（）()《》]/.test(s) && !/^\d+$/.test(s) && !/^[一二三四五六七八九十]+$/.test(s)
    && !/^(完|全文完|全书完|本[书卷篇]完)$/.test(s)) return { kind: 'named', len: s.length, text: s }
  return { kind: 'body', len: s.length, text: s }
}

const STRUCT_HEADING_KINDS = new Set(['chapter', 'part', 'preface', 'epilogue', 'toc', 'bullet', 'num', 'named'])

function structHeadingScore(kind, len, prevBlank, nextBlank, nextLen) {
  let s = 0
  switch (kind) {
    case 'chapter': s += 8; break
    case 'part': s += 7; break
    case 'preface': s += 7; break
    case 'epilogue': s += 7; break
    case 'toc': s += 6; break
    case 'named': s += 5; break
    case 'bullet': s += 3; break
    case 'num': s += 3; break
    default: return 0
  }
  if (len <= 6) s += 2
  else if (len <= 14) s += 1
  else if (len > 30) s -= 2
  else if (len > 50) s -= 3
  if (prevBlank || nextBlank) s += 1
  if (nextLen > 20 && nextLen > len * 1.5) s += 1
  return Math.max(0, Math.min(10, s))
}

function structStripTitle(s) { return s.replace(/[《》""「」\s]/g, '') }

function structDeriveFront(front, filenameHint) {
  let title = ''
  let author = ''
  const name = filenameHint.replace(/\.[^.]+$/, '')
  const fm = name.match(/^(.+?)\s*(?:作者|著)\s*[：:]\s*(.+)$/)
  if (fm) { title = structStripTitle(fm[1].trim()); author = fm[2].trim() }
  else { title = structStripTitle(name) }
  let t = title
  let a = author
  for (const s of front.slice(0, 6)) {
    const am = s.match(/^(?:作者|作\s*者|作者：|著\s*者)[：:]?\s*(.+)$/)
    if (am && am[1].length <= 20 && !a) { a = am[1]; continue }
    // a front line like "真相 作者：石楠" (no 《》 wrapper)
    const fam = s.match(/^(.{1,20}?)\s*(?:作者|著)\s*[：:]\s*(.{1,20})$/)
    if (fam && fam[2].trim() !== '' && !a) { t = fam[1].trim(); a = fam[2].trim(); continue }
    const pm = s.match(/^(?:出版社|出版)\s*[：:]?\s*(.+)$/)
    if (pm && pm[1].length <= 30) continue
    if (s.startsWith('《') && s.endsWith('》') && s.length <= 40) { t = s.slice(1, -1); continue }
    const bm = s.match(/^(.{1,12}?)[《]([^》]{1,40})[》]/)
    if (bm && !a) { a = bm[1].trim(); t = bm[2]; continue }
    const bm2 = s.match(/^《([^》]{1,40})》\s*(.{1,12})?$/)
    if (bm2 && !a) { t = bm2[1]; if (bm2[2] && bm2[2].trim()) a = bm2[2].trim(); continue }
    if (a === '' && !am && /^\S{1,12}$/.test(s) && !/第|序|章|[《》]/.test(s)) a = s
  }
  return { title: t || title, author: a || author }
}

/**
 * Split a novel's text into structured sections. Exported for tests.
 * Returns { title, author, sections: [{type, heading, startLine, chars, bodyLines, charStart, charLen, textStart}] }
 * where charStart/charLen are offsets in the "content" space (concatenated
 * trimmed non-blank lines), and textStart is the heading's offset in the
 * normalized input text — used to align chunk boundaries so a chapter jump is
 * exact instead of ±1 chunk.
 *
 * `metaOverride` (optional) supplies authoritative { title, author } (e.g. the
 * OPF metadata of an EPUB) that wins over the heuristic filename/front-matter
 * guess — used by the .epub branch where the real title is rarely inferable
 * from the file name alone.
 */
export function parseBookStructure(text, filenameHint = '', metaOverride = null) {
  const norm = String(text).replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
  const rawLines = norm.split('\n')
  const lines = []
  let running = 0
  for (const raw of rawLines) {
    const s = raw.trim()
    const lead = raw.length - raw.trimStart().length
    lines.push({ text: raw, s, blank: s === '', off: running + lead })
    running += raw.length + 1
  }
  for (const ln of lines) if (!ln.blank) ln.cls = structClassifyLine(ln.s)

  // Pass B: mark TOC blocks (>=3 consecutive heading-like lines with no body
  // line between them) so a duplicated 目录 doesn't produce fake sections.
  let i = 0
  while (i < lines.length) {
    if (lines[i].blank || !STRUCT_HEADING_KINDS.has(lines[i].cls.kind)) { i++; continue }
    let j = i
    while (j < lines.length && !lines[j].blank && STRUCT_HEADING_KINDS.has(lines[j].cls.kind)) j++
    if (j - i >= 3) for (let k = i; k < j; k++) lines[k].cls.kind = 'toc'
    i = j
  }

  // Pass C: decide real headings via confidence score + context.
  const real = new Array(lines.length).fill(false)
  for (let k = 0; k < lines.length; k++) {
    const ln = lines[k]
    if (ln.blank) continue
    const c = ln.cls
    if (!STRUCT_HEADING_KINDS.has(c.kind)) continue
    // Printed TOCs often list each chapter on its own line followed by a page
    // number ("…/12"). If the next non-blank line ends with such a ref, this
    // heading is a TOC row — suppress it (the real chapter appears later).
    // e.g. 一个县委书记的故事.txt: "第一章 一根针执政官" → "1. 石头砸在桌面上…/1"
    if (c.kind !== 'toc') {
      let pn = k + 1
      while (pn < lines.length && lines[pn].blank) pn++
      if (pn < lines.length && /\/\d+\s*$/.test(lines[pn].s)) { c.kind = 'toc'; continue }
    }
    if (c.kind === 'toc') continue
    const prevBlank = k === 0 || lines[k - 1].blank
    const nextIdx = k + 1 < lines.length ? k + 1 : -1
    const nextBlank = nextIdx === -1 || lines[nextIdx].blank
    let nextLen = 0
    let nn = nextIdx
    while (nn !== -1 && lines[nn].blank) nn = nn + 1 < lines.length ? nn + 1 : -1
    if (nn !== -1) nextLen = lines[nn].s.length
    const score = structHeadingScore(c.kind, c.len, prevBlank, nextBlank, nextLen)
    const prevHeading = k > 0 && !lines[k - 1].blank && STRUCT_HEADING_KINDS.has(lines[k - 1].cls.kind)
    const sitsAlone = prevBlank || prevHeading
    const STRONG = c.kind === 'chapter' || c.kind === 'part' || c.kind === 'preface'
      || c.kind === 'epilogue' || c.kind === 'toc'
    // Strong headings don't need a blank line above (some books run a chapter
    // heading straight after the previous paragraph); the length penalty in
    // structHeadingScore keeps mid-paragraph long lines out.
    if (STRONG) { if (score >= 7) real[k] = true; continue }
    if (c.kind === 'named') {
      // The riskiest kind: a short standalone line could be a lyric/song quote.
      // Trust only when it sits on a blank line, the next non-blank line is a
      // long body paragraph, and the line above isn't another short line (a run
      // of short lines = lyrics/poem).
      const aboveIsNamed = k > 0 && !lines[k - 1].blank && lines[k - 1].cls.kind === 'named'
      if (!(prevBlank && nextLen > 20 && !aboveIsNamed)) continue
    }
    if (score >= 6 && sitsAlone) real[k] = true
  }

  // Pass D: group body lines under each real heading; pre-heading lines = front matter.
  const sections = []
  let front = []
  let cur = null
  const flush = () => { if (cur !== null) { sections.push(cur); cur = null } }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].blank) continue
    if (real[k]) {
      flush()
      cur = { type: lines[k].cls.kind, heading: lines[k].cls.text, startLine: k + 1, body: [], textStart: lines[k].off }
      continue
    }
    if (cur !== null) cur.body.push(lines[k].s)
    else front.push(lines[k].s)
  }
  flush()

  // char spans FIRST, so the noise gate below can judge body size.
  let charPos = 0
  for (const sec of sections) {
    sec.chars = sec.body.join('').length
    sec.bodyLines = sec.body.length
    sec.charStart = charPos
    sec.charLen = sec.heading.length + sec.chars
    charPos += sec.charLen
    delete sec.body
  }

  // Noise gate: a short standalone line opening a tiny block is usually a
  // quote / date / diary stub, not a real section — fold it back into the
  // previous section's body. Real named headings (story titles, chapter
  // sub-heads) open a substantial body, so those survive.
  const NAMED_MIN_BODY = 600
  for (let i2 = 1; i2 < sections.length; i2++) {
    const sec = sections[i2]
    if (sec.type !== 'named' || sec.chars >= NAMED_MIN_BODY) continue
    const prev = sections[i2 - 1]
    prev.chars += sec.heading.length + sec.chars
    prev.bodyLines += 1 + sec.bodyLines
    prev.charLen += sec.heading.length + sec.chars
    sections.splice(i2, 1)
    i2--
  }

  const derived = structDeriveFront(front, filenameHint)
  const meta = {
    title: (metaOverride && metaOverride.title) || derived.title,
    author: (metaOverride && metaOverride.author) || derived.author,
  }
  return {
    title: meta.title,
    author: meta.author,
    sections: sections.map((s) => ({
      type: s.type, heading: s.heading, startLine: s.startLine,
      chars: s.chars, bodyLines: s.bodyLines, charStart: s.charStart, charLen: s.charLen,
      textStart: s.textStart,
    })),
  }
}

// ---- EPUB support: minimal ZIP container reader + XHTML → plain text ----
// An EPUB is a ZIP archive whose spine (reading order) references XHTML
// chapters. We keep the plugin's zero-runtime-dependency design by reading the
// container with a small hand-rolled ZIP parser (EOCD → central directory →
// local headers) and inflating deflate entries with node:zlib — no third-party
// unzip/XML library. Only the "book file → plain text" stage is format
// specific: everything downstream (parseBookStructure → splitBookChunks → TTS)
// is text-driven and unchanged. The whole extractor is exported for tests.
const ZIP_EOCD = 0x06054b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50

function normalizeZipName(name) {
  return String(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/')
}

// Read the ZIP central directory (entry table) from a raw byte buffer.
// Returns [{ name, method, flags, compSize, uncompSize, localOffset }].
export function zipEntries(buf) {
  // EOCD signature: scan backwards over the trailing comment (max 65535 bytes).
  let eocd = -1
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD) { eocd = i; break }
  }
  if (eocd === -1) throw new Error('不是有效的 EPUB：找不到 ZIP 中央目录')
  const entryCount = buf.readUInt16LE(eocd + 10)
  if (entryCount === 0xffff) throw new Error('不支持 ZIP64 的 EPUB')
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset + cdSize > buf.length) throw new Error('不是有效的 EPUB：中央目录越界')
  const entries = []
  let p = cdOffset
  for (let n = 0; n < entryCount && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== ZIP_CENTRAL) throw new Error('不是有效的 EPUB：中央目录条目损坏')
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      flags: buf.readUInt16LE(p + 8),
      compSize: buf.readUInt32LE(p + 20),
      uncompSize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// Read + inflate one entry by name (exact match, case-insensitive fallback).
// Supports method 0 (stored) and 8 (deflate); anything else — e.g. method 99,
// the AES flag DRM'd books use — raises a clear Chinese error.
export function zipReadEntry(buf, entries, name) {
  const want = normalizeZipName(name)
  let ent = entries.find((e) => normalizeZipName(e.name) === want)
  if (ent === undefined) {
    const low = want.toLowerCase()
    ent = entries.find((e) => normalizeZipName(e.name).toLowerCase() === low)
  }
  if (ent === undefined) throw new Error('EPUB 中缺少条目: ' + name)
  const lo = ent.localOffset
  if (lo < 0 || lo + 30 > buf.length || buf.readUInt32LE(lo) !== ZIP_LOCAL) {
    throw new Error('EPUB 条目损坏: ' + ent.name)
  }
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const end = start + ent.compSize
  if (end > buf.length) throw new Error('EPUB 条目数据越界: ' + ent.name)
  const data = buf.subarray(start, end)
  if (ent.method === 0) return Buffer.from(data)
  if (ent.method === 8) {
    try { return inflateRawSync(data) }
    catch { try { return inflateSync(data) } catch { throw new Error('EPUB 条目解压失败: ' + ent.name) } }
  }
  throw new Error('不支持的 EPUB 压缩方式 ' + ent.method + ': ' + ent.name)
}

// Decode XML/XHTML bytes: UTF-8 (spec default) or UTF-16 when a BOM says so.
function decodeXmlBuf(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)
  return buf.toString('utf8')
}

function xmlAttr(tag, attr) {
  const m = tag.match(new RegExp('\\b' + attr + '\\s*=\\s*(["\'])([^"\']*)\\1', 'i'))
  return m ? m[2] : ''
}

// Match an XML element's text regardless of namespace prefix: "dc:title",
// "dcterms:title", or a bare "title" all hit the same rule.
function firstXmlText(xml, tag) {
  const bare = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag
  const re = new RegExp('<[\\w-]*:?' + bare + '\\b[^>]*>([\\s\\S]*?)</[\\w-]*:?' + bare + '>', 'i')
  const m = xml.match(re)
  return m ? decodeEntities(m[1].trim()) : ''
}

// Small HTML named-entity table — enough for real-world (esp. Chinese) prose;
// unknown entities are left as-is. Numeric entities (&#...; / &#x...;) are
// decoded separately, so no full HTML spec table is needed.
const HTML_ENTITIES = {
  nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', times: '\u00d7',
  middot: '\u00b7', copy: '\u00a9', dagger: '\u2020', Dagger: '\u2021',
  emsp: '\u2003', ensp: '\u2002', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  bull: '\u2022', sect: '\u00a7', para: '\u00b6', deg: '\u00b0', plusmn: '\u00b1',
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178',
  laquo: '\u00ab', raquo: '\u00bb', lsaquo: '\u2039', rsaquo: '\u203a',
}
export function decodeEntities(s) {
  const fromCodePoint = (cp) => (Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '')
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&([A-Za-z][A-Za-z0-9]+);/g, (m, n) => (n in HTML_ENTITIES ? HTML_ENTITIES[n] : m))
}

// Block-level elements that must start a new text line (paragraphs, headings,
// list items, table cells), so extracted text looks like a plain .txt novel —
// which the line-based parseBookStructure expects.
const HTML_BLOCK_TAGS = 'p|div|h1|h2|h3|h4|h5|h6|li|ul|ol|dl|dt|dd|blockquote|pre|section|article|header|footer|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|caption|details|summary|main|aside'
// Elements whose whole content is dropped (metadata / non-prose markup).
const HTML_DROP_TAGS = 'script|style|nav|svg|head|template|object|iframe|embed|link|meta|base|map|noscript|rp|rt|ruby'

// Convert an XHTML chapter into plain text (one paragraph per line). Well-formed
// XHTML means tags nest and close, so the whole-element and tag-stripping
// regexes are safe on real files.
export function htmlToText(html) {
  let s = String(html)
  s = s.replace(/<!--[\s\S]*?-->/g, '') // comments
  for (const t of HTML_DROP_TAGS.split('|')) {
    s = s.replace(new RegExp('<' + t + '(?:\\s[^>]*)?>[\\s\\S]*?</' + t + '>', 'gi'), '')
  }
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<hr\s*\/?>/gi, '\n\n')
  for (const t of HTML_BLOCK_TAGS.split('|')) {
    s = s.replace(new RegExp('<' + t + '(?:\\s[^>]*)?>', 'gi'), '\n')
    s = s.replace(new RegExp('</' + t + '>', 'gi'), '\n')
  }
  s = s.replace(/<[^>]+>/g, '') // any remaining tags (spans, links, images…)
  s = decodeEntities(s)
  // Collapse horizontal whitespace, keep paragraph breaks as single newlines.
  s = s.replace(/[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  // Drop common reading artifacts that are empty/whitespace-only lines after
  // collapsing, then return trimmed.
  return s.replace(/^\s+|\s+$/g, '').replace(/\n{3,}/g, '\n\n')
}

// Turn an EPUB byte buffer into plain text (spine reading order) plus the OPF
// title/author. Throws a Chinese error on malformed/DRM'd/encrypted books so
// the caller can surface it (the /book routes already map throws to 500).
export function readEpubBuffer(buf) {
  const entries = zipEntries(buf)
  const zipRead = (name) => {
    const norm = normalizeZipName(name)
    const hit = entries.some((e) => {
      const en = normalizeZipName(e.name)
      return en === norm || en.toLowerCase() === norm.toLowerCase()
    })
    return hit ? zipReadEntry(buf, entries, name) : null
  }

  // 1. container.xml → path of the package document (OPF).
  const container = zipRead('META-INF/container.xml')
  if (container === null) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml')
  const rootfile = decodeXmlBuf(container).match(/<[\w-]*:?rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i)
  if (rootfile === null) throw new Error('不是有效的 EPUB：container.xml 缺少 rootfile')
  const opfPath = rootfile[1]
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  // 2. Package document: metadata + manifest + spine (reading order).
  const opfBuf = zipRead(opfPath)
  if (opfBuf === null) throw new Error('EPUB 缺少包文档: ' + opfPath)
  const opf = decodeXmlBuf(opfBuf)
  const title = firstXmlText(opf, 'dc:title')
  const author = firstXmlText(opf, 'dc:creator')

  const manifest = new Map()
  let m
  const itemRe = /<[\w-]*:?item\b[^>]*\/?>/gi
  while ((m = itemRe.exec(opf)) !== null) {
    const id = xmlAttr(m[0], 'id')
    const href = xmlAttr(m[0], 'href')
    const media = xmlAttr(m[0], 'media-type').toLowerCase()
    if (id !== '' && href !== '') manifest.set(id, { href: decodeEntities(href), media })
  }
  const spine = []
  const spineRe = /<[\w-]*:?itemref\b[^>]*\/?>/gi
  while ((m = spineRe.exec(opf)) !== null) {
    const idref = xmlAttr(m[0], 'idref')
    // linear="no" items (endnotes, footnotes, page lists) are not part of the
    // primary reading order — skip them for read-aloud.
    if (idref !== '' && xmlAttr(m[0], 'linear').toLowerCase() !== 'no') spine.push(idref)
  }

  // 3. Encrypted/DRM'd entries (META-INF/encryption.xml) — skip the spine items
  // we cannot decrypt instead of reading mojibake.
  const encrypted = new Set()
  const encBuf = zipRead('META-INF/encryption.xml')
  if (encBuf !== null) {
    const encRe = /<(?:\w+:)?CipherReference\b[^>]*URI\s*=\s*["']([^"']+)["']/gi
    let em
    while ((em = encRe.exec(decodeXmlBuf(encBuf))) !== null) {
      encrypted.add(normalizeZipName(decodeEntities(em[1])))
    }
  }

  // 4. Concatenate spine XHTML in reading order into one plain-text novel.
  const parts = []
  for (const idref of spine) {
    const item = manifest.get(idref)
    if (item === undefined) continue
    if (item.media !== '' && !/html|xhtml/.test(item.media)) continue // images/css/ncx in spine
    const href = opfDir + item.href
    if (encrypted.has(normalizeZipName(href))) continue
    const xhtmlBuf = zipRead(href)
    if (xhtmlBuf === null) continue
    const text = htmlToText(decodeXmlBuf(xhtmlBuf))
    if (text !== '') parts.push(text)
  }
  if (parts.length === 0) throw new Error('EPUB 中没有任何可朗读的正文内容')
  return { text: parts.join('\n\n'), title, author }
}

// ---- book chunking into TTS blocks ----
// Maximum length of a "clean, short" chapter heading that gets its own
// dedicated TTS chunk. Real headings are a handful of characters (e.g.
// "第一章 闪电划过星空"); anything longer is almost certainly an inline heading
// that has already swallowed the following body text (parseBookStructure
// classifies whole lines), so we refuse to isolate it — isolating would only
// move the merged body into a "heading" chunk. Keep the old merge behaviour
// for those instead.
const MAX_HEADING_CHARS = 30

// Locate where a heading ends inside a sentence segment, using two bounds and
// taking the smaller one:
//   1) the end of the heading's own line (next '\n') — exact when the heading
//      sits on its own line (the normal case);
//   2) the end of an elastic-whitespace match of the heading string against the
//      source — guards against inline headings so a short heading never
//      swallows the rest of a long paragraph.
// `heading` is the cleaned heading (WPS codes / full-width spaces already
// stripped by structClassifyLine), so source whitespace runs are treated
// elastically.
//
// Returns { start, end } — the span of the clean heading text inside the
// segment — or null when it cannot be located. start may sit past `from`:
// decorated lines (`★书名·作者·第一章 xxx`) carry ornament before the heading,
// and that prefix belongs to the previous chunk while `第一章 …` opens the new
// one, so the TTS reads the bare chapter title.
function headingEndInSegment(segText, from, heading) {
  // Bound 1: end of the heading's line in the raw segment (newlines preserved).
  const nl = segText.indexOf('\n', from)
  const lineEnd = nl === -1 ? segText.length : nl
  // Bound 2: elastic whitespace match of the heading string.
  let i = from
  let j = 0
  while (j < heading.length) {
    const hc = heading[j]
    if (/\s/.test(hc)) { j++; continue } // heading whitespace: skip (any run)
    while (i < segText.length && /\s/.test(segText[i])) i++ // source whitespace: skip
    if (i >= segText.length || segText[i] !== hc) break // mismatch → heading ends here
    i++
    j++
  }
  if (j === heading.length) {
    // Skip a trailing whitespace run so "标题　" does not keep its padding.
    while (i < segText.length && /\s/.test(segText[i])) i++
    return { start: from, end: Math.min(lineEnd, i) }
  }
  // The heading text does not start at `from` — a decorated line. Locate the
  // heading within that line so only the ornament stays behind. The search is
  // whitespace-elastic because the stored heading may differ from the source by
  // full-width spaces (structClassifyLine strips \u3000 from `第三十四章　偷袭`).
  const src = Array.from(heading).map((h) => (/\s/.test(h) ? '\\s*' : h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')
  const m = new RegExp(src).exec(segText.slice(from, lineEnd + 1))
  if (m !== null && m.index > 0) return { start: from + m.index, end: from + m.index + m[0].length }
  return null
}

// A cut at a clause break must still leave a meaningful chunk. Without this
// floor, the last outside-quote break of a "他说：“…long quote…”" segment is the
// lead-in colon itself (everything after it is inQuote), so the splitter chips
// off a 2-3 char "他说：" orphan chunk sandwiched between two full ones.
const MIN_PIECE_CHARS = 20

// Split one over-long (and already quote-atomic) sentence into pieces each
// <= MAX_TTS_CHARS. Adaptive, in decreasing preference:
//   1. a natural clause pause outside quotes (dialogue stays whole);
//   2. any sentence/clause pause inside the window — including inside a quoted
//      span. A segment long enough to reach splitOversize cannot stay one chunk
//      anyway, so cutting a long monologue at its own punctuation beats a hard
//      slice at the cap;
//   3. hard slice (only when the window holds no pause at all).
// Both break tiers respect MIN_PIECE_CHARS. A short dialogue never reaches this
// function (only >MAX_TTS_CHARS segments do), so it is never split mid-quote.
// Never splits a surrogate pair (rare CJK extensions / emoji stay intact).
//
// `protectPrefix` (default 0): the first `protectPrefix` chars are an atomic
// prefix (a tail merged in from the packer's buffer) and must never be cut —
// all candidate break points are searched from `protectPrefix` onward. Without
// it, merging cur+sentence and re-splitting would simply cut the cur/sentence
// seam back out (the seam is the last outside-quote pause), recreating the
// orphan chunk we merged to eliminate.
function splitOversize(sentence, protectPrefix = 0) {
  const n = sentence.length
  // Positions inside a quoted span: these are atomic, we must not cut there.
  const inQuote = new Array(n).fill(false)
  let k = 0
  while (k < n) {
    if (isQuoteOpen(sentence[k])) {
      const close = sentence.indexOf(QUOTE_PAIRS[sentence[k]], k + 1)
      if (close !== -1) {
        for (let q = k; q <= close; q++) inQuote[q] = true
        k = close + 1
        continue
      }
    }
    k++
  }
  const pieces = []
  let start = 0
  while (start < n) {
    // What remains already fits in a single chunk: take it whole instead of
    // subdividing the shrinking tail at clause pauses into tiny pieces — that
    // fragmentation produced consecutive short chunks in body prose.
    if (n - start <= MAX_TTS_CHARS) {
      pieces.push(sentence.slice(start))
      break
    }
    let end = start + MAX_TTS_CHARS
    // Don't split a surrogate pair: if end lands on a low surrogate, back off one.
    if (end < n && isLowSurrogate(sentence.charCodeAt(end))) end--
    const from = Math.max(start, protectPrefix)
    // Tier 1: last natural clause break inside [from, end) that is outside
    // quotes — but only when it leaves a meaningful piece (see MIN_PIECE_CHARS).
    let brk = -1
    for (let j = from; j < end; j++) {
      if (!inQuote[j] && CLAUSE_BREAKS.indexOf(sentence[j]) !== -1) brk = j
    }
    let pieceEnd
    if (brk > from && brk + 1 - from >= MIN_PIECE_CHARS) {
      pieceEnd = brk + 1
    } else {
      // Tier 2: last sentence/clause pause anywhere in the window, quotes
      // included — a long monologue is split at its own punctuation instead of
      // a bare hard slice, and no tiny lead-in/orphan piece can survive.
      let any = -1
      for (let j = from; j < end; j++) {
        if (CLAUSE_BREAKS.indexOf(sentence[j]) !== -1 || '。！？'.indexOf(sentence[j]) !== -1) any = j
      }
      if (any > from && any + 1 - from >= MIN_PIECE_CHARS) {
        pieceEnd = any + 1
      } else {
        // Tier 3: no usable pause. Prefer to end the piece on the last
        // outside-quote character, so a quoted dialogue isn't split apart. Only
        // fall back to a hard slice when the whole window is inside one quote.
        // When the protected prefix already covers the whole window (from >=
        // end), nothing in [0, end) may be cut — take the window whole (end,
        // never from+1, which could exceed MAX_TTS_CHARS by 1).
        let outside = -1
        for (let j = end - 1; j > from; j--) {
          if (!inQuote[j]) { outside = j; break }
        }
        pieceEnd = outside > from ? outside + 1 : (from >= end ? end : Math.max(from + 1, end))
      }
    }
    // Avoid leaving a tiny tail behind: if the remainder after this cut would
    // be a micro-chunk, back the cut off to an earlier pause so both sides stay
    // meaningful. Dialogue-heavy novels hit this constantly — a long quote
    // followed by a short attribution (`…尾声。”韩立一边听着余子童的讲解，`)
    // used to leave a 10-19 char tail chunk sandwiched between two full ones.
    if (pieceEnd < n && n - pieceEnd < MIN_PIECE_CHARS) {
      const isPause = (j) => CLAUSE_BREAKS.indexOf(sentence[j]) !== -1 || '。！？'.indexOf(sentence[j]) !== -1
      const fits = (j) => j + 1 - from >= MIN_PIECE_CHARS && n - (j + 1) >= MIN_PIECE_CHARS
      let alt = -1
      for (let j = end - 1; j > from; j--) { // prefer a pause outside quotes
        if (fits(j) && !inQuote[j] && isPause(j)) { alt = j; break }
      }
      if (alt === -1) {
        for (let j = end - 1; j > from; j--) { // else any pause, quotes included
          if (fits(j) && isPause(j)) { alt = j; break }
        }
      }
      if (alt > from) pieceEnd = alt + 1
    }
    pieces.push(sentence.slice(start, pieceEnd))
    start = pieceEnd
  }
  return pieces
}

/**
 * Split prose into natural chunks (<= MAX_TTS_CHARS each). Sentences are
 * accumulated up to the cap (so each block is a few sentences of speech),
 * only closing a block when the next sentence would overflow. Paragraph
 * newlines are folded into whitespace. Quoted dialogue (“...”) is atomic — a
 * .?!…; inside the quotes never splits the segment, so a dialogue that fits in
 * one chunk always reads as a single utterance. A single over-long segment is
 * split adaptively (outside-quote clause pauses first, then the segment's own
 * punctuation, hard slice last) instead of a raw slice at the cap.
 *
 * Optional `breaks` = sorted list of section headings, each
 * { start, text } where `start` is the heading's char offset in `text` and
 * `text` is the heading string (s.heading from parseBookStructure). A break is
 * applied at sub-segment precision: text before the break stays in the previous
 * chunk, and the heading itself opens a NEW chunk — so a chapter jump starts
 * exactly at the heading even when a divider page ("《书名》作者") shares the
 * sentence segment with it.
 *
 * A clean short heading (< = MAX_HEADING_CHARS) gets its own dedicated chunk so
 * the TTS reads the chapter title alone with a natural pause before the body;
 * long/inline-polluted headings fall back to the old merge (title + body in the
 * same chunk) so we never turn a whole paragraph into a "heading" block.
 *
 * Exported for tests (same pattern as parseBookStructure).
 * Returns { chunks, fromChunkOfBreak } where fromChunkOfBreak[i] is the chunk
 * index opened by breaks[i] (undefined if that break opened no chunk).
 */
export function splitBookChunks(text, breaks = null) {
  const chunks = []
  const fromChunkOfBreak = []
  // Sentence segments with their original char offsets in `text`. Quoted dialogue
  // (…“...”…) is atomic: a 。！？…；，、 inside the quotes never cuts the segment, so the
  // whole dialogue stays together and the TTS reads it as a single utterance.
  // Breaking also at the clause pauses ，、 keeps a comma-heavy description as many
  // small segments, so the greedy packer fills each block close to the cap
  // instead of one giant segment hitting splitOversize (whose shrinking tail
  // fragmented into tiny chunks in the middle of body prose).
  const segs = []
  let segStart = 0
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (isQuoteOpen(c)) {
      // Find this opener's closing quote; if present, the whole quoted span is
      // atomic — skip past it so nothing inside can split the segment.
      const close = text.indexOf(QUOTE_PAIRS[c], i + 1)
      if (close !== -1) { i = close + 1; continue }
      // Unmatched opener: treat as a normal character and keep scanning.
    }
    if ('。！？；…，、'.indexOf(c) !== -1) {
      segs.push({ s: text.slice(segStart, i + 1), start: segStart })
      segStart = i + 1
    }
    i++
  }
  if (segStart < text.length) segs.push({ s: text.slice(segStart), start: segStart })
  let cur = ''
  let curOpener = -1 // break index that opened the chunk being accumulated
  let bi = 0
  const push = () => {
    if (cur.trim().length > 0) {
      if (curOpener >= 0) fromChunkOfBreak[curOpener] = chunks.length
      chunks.push(cur.trim())
    }
    cur = ''
    curOpener = -1
  }
  // Push split pieces, keeping the chapter-break opener on the first one so a
  // jump still lands on the chunk that opens the section. The LAST piece of a
  // split is never pushed here: it is fed back into `cur` (returned below) so
  // the packer decides whether it stands alone or merges with what follows —
  // a split tail must not become an orphan chunk by construction.
  const pushPieces = (pieces) => {
    for (let pi = 0; pi < pieces.length; pi++) {
      const piece = pieces[pi]
      if (pi === pieces.length - 1) {
        // final piece: re-enter the packer (may merge with the next segment)
        cur = piece
        if (curOpener >= 0) fromChunkOfBreak[curOpener] = chunks.length
        curOpener = -1
        continue
      }
      if (curOpener >= 0) fromChunkOfBreak[curOpener] = chunks.length
      chunks.push(piece)
      curOpener = -1
    }
  }
  const addSentence = (rawSentence) => {
    const sentence = rawSentence.replace(/\s*\n+\s*/g, ' ').trim()
    if (sentence.length === 0) return
    if (cur.length + sentence.length <= MAX_TTS_CHARS) {
      // A single sentence longer than the cap cannot share a chunk, so it can
      // only reach the split path when the buffer is empty.
      if (sentence.length > MAX_TTS_CHARS) pushPieces(splitOversize(sentence))
      else cur += sentence
      return
    }
    // cur + sentence would overflow. Decide by the cap alone (no extra
    // threshold): if cur is not yet a full block (cur < MAX_TTS_CHARS), it is
    // an unfinished tail — fold it into the next sentence and let splitOversize
    // cut the merged text at pauses that keep both sides meaningful. Only a
    // block that already reached the cap is a genuine full block worth
    // flushing. (The old `cur < MIN_PIECE_CHARS` guard missed tails of 20+,
    // and a `sentence > MAX` guard missed tails followed by a 137-char
    // sentence that a chapter break split out of an over-long segment.)
    //
    // Guard: the merge must have a usable pause inside splitOversize's FIRST
    // cut window [seam, 150) — otherwise the first piece would fall to a hard
    // Tier-3 slice mid-word (e.g. cur=139 + a 23-char sentence whose only
    // pause sits past position 150 → window holds no pause → hard cut). In
    // that case do not merge: flush cur as a natural block boundary (it ends
    // on a pause) and let the sentence start fresh.
    if (cur.length > 0 && cur.length < MAX_TTS_CHARS) {
      const merged = cur + sentence
      const seam = merged.length - sentence.length
      // splitOversize's first window ends at MAX_TTS_CHARS (start=0), and its
      // search starts at max(0, protectPrefix) = seam. So the usable range is
      // [seam, MAX_TTS_CHARS). A pause is usable only if it leaves a piece of
      // >= MIN_PIECE_CHARS (matching splitOversize's own Tier-1/2 gate) —
      // otherwise splitOversize would reject it and fall to a hard Tier-3
      // slice mid-word (e.g. cur=136 + 41-char sentence whose only pause in
      // the window leaves a 13-char piece → hard cut). In that case do not
      // merge: flush cur as a natural block boundary (it ends on a pause) and
      // let the sentence start fresh.
      let pauseAt = -1
      const winEnd = Math.min(MAX_TTS_CHARS, merged.length)
      for (let j = seam; j < winEnd; j++) {
        if (CLAUSE_BREAKS.indexOf(merged[j]) !== -1 || '。！？'.indexOf(merged[j]) !== -1) pauseAt = j
      }
      if (pauseAt > seam && pauseAt + 1 - seam >= MIN_PIECE_CHARS) {
        // The cur portion is an atomic prefix — splitOversize must not cut the
        // cur/sentence seam back out (that would recreate the orphan chunk).
        cur = ''
        pushPieces(splitOversize(merged, seam))
        return
      }
    }
    push()
    if (sentence.length > MAX_TTS_CHARS) pushPieces(splitOversize(sentence))
    else cur += sentence
  }
  for (const seg of segs) {
    if (breaks && breaks.length > 0) {
      while (bi < breaks.length && breaks[bi].start < seg.start) bi++
      if (bi < breaks.length && breaks[bi].start < seg.start + seg.s.length) {
        const off = breaks[bi].start - seg.start
        const headingText = breaks[bi].text
        // A clean short heading gets its own dedicated chunk so the TTS reads
        // "第一章 闪电划过星空" alone with a natural pause before the body.
        // Long headings are almost certainly inline-polluted (the parser has
        // already merged the body into the heading string) — keep them merged.
        const cleanShort = typeof headingText === 'string' && headingText.length > 0 && headingText.length <= MAX_HEADING_CHARS
        // Locate the clean heading inside the segment. For decorated lines
        // (`★书名·作者·第一章 xxx`) it sits past the break offset — the ornament
        // stays with the previous chunk and the bare title opens the new one.
        const hit = cleanShort ? headingEndInSegment(seg.s, off, headingText) : null
        const bodyStart = hit ? hit.end : off
        // Everything before the heading — the segment prefix plus any ornament
        // (`★书名·作者·`) — belongs to the previous chunk. hit.start === off in
        // the plain case, so the slice must not be skipped just because the
        // heading sits at the very start of its segment.
        const preEnd = hit ? hit.start : off
        if (preEnd > 0) addSentence(seg.s.slice(0, preEnd))
        push()
        if (cleanShort && hit) {
          curOpener = bi // the heading chunk opens this section
          addSentence(seg.s.slice(hit.start, hit.end))
          push() // records fromChunkOfBreak[bi] = heading chunk index
          addSentence(seg.s.slice(bodyStart)) // body continues in a fresh chunk
        } else {
          // Could not isolate the heading in the source (unmatched / polluted) —
          // fall back to the original behaviour (heading + body share a chunk).
          curOpener = bi
          addSentence(seg.s.slice(off))
        }
        bi++
        // swallow any further breaks inside this same segment (rare)
        while (bi < breaks.length && breaks[bi].start < seg.start + seg.s.length) bi++
        continue
      }
    }
    addSentence(seg.s)
  }
  push()
  if (chunks.length === 0) chunks.push(text.trim())
  return { chunks, fromChunkOfBreak }
}

// ---- LRC 歌词解析 ----
// 把标准 .lrc 解析为 [{ t, text }]（t 为秒）。支持一行多个时间戳、[offset:±ms]
// 全局偏移标签；[ti:]/[ar:]/[al:] 等元数据标签与空行直接跳过。乱序时间戳按 t 重排。
export function parseLrc(text) {
  const out = []
  let offsetS = 0
  const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '')
    // [offset:±ms] 对整个文件生效（偏移量毫秒）。
    const om = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/.exec(line)
    if (om !== null) { offsetS = (parseInt(om[1], 10) || 0) / 1000; continue }
    const tags = []
    let m
    TIME_RE.lastIndex = 0
    let contentStart = 0
    // 注意：exec 匹配失败后 lastIndex 会被重置为 0，所以文本起点要在循环里记录。
    while ((m = TIME_RE.exec(line)) !== null) { tags.push(m); contentStart = TIME_RE.lastIndex }
    if (tags.length === 0) continue
    const content = line.slice(contentStart).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (content === '') continue
    for (const tag of tags) {
      const min = parseInt(tag[1], 10) || 0
      const sec = parseInt(tag[2], 10) || 0
      const fracS = tag[3] !== undefined && tag[3] !== '' ? Number('0.' + tag[3]) : 0
      out.push({ t: min * 60 + sec + fracS + offsetS, text: content })
    }
  }
  out.sort((a, b) => a.t - b.t || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
  return out
}

// =====================================================================
// 从本地歌词（同名 .lrc 或内嵌歌词）里拆出「格式 C」的逐句翻译。
//
// 背景：在线 QQ/酷狗歌词有平台下发的结构化 trans 字段，客户端用 mergeLyricTrans
// 合并成「原文 ／ 翻译」。而本地 .lrc 是纯文本，翻译没有标准字段，其中一种常见
// 写法是「翻译行带自己的时间戳、紧跟在原句后」：
//     [00:01.00]Sparrows outside the window   （外文歌：原文）
//     [00:01.50]窗外的麻雀                     （翻译成中文）
// 或（中文歌配英文翻译）：
//     [00:01.00]窗外的麻雀
//     [00:01.50]Sparrows outside the window
//
// 翻译方向不靠猜：本函数先统计整首歌词的主语言——「外文(拉丁)为主」还是「中文(CJK)
// 为主」，据此决定哪类行是翻译（主歌词的少数语言行）。主流「外文歌→中文翻译」与
// 「中文歌→外文翻译」两种方向都覆盖；无明确主语言（如纯中文且无外文行）则不拆。
//
// 判定规则（从严，避免误伤歌名/水印等）：
//   1. 行分类：latin=含 ≥3 个英文字母且无 CJK；cjk=含 ≥2 个汉字且无英文字母；
//      其余（中英混杂的水印/歌名等）归为 other，不计入主语言统计、也不作翻译候选。
//   2. 翻译类 = 主语言的反类（主 latin → 翻译为 cjk；主 cjk → 翻译为 latin）。
//   3. 候选翻译行须与「前一条非翻译行」时间戳相差 < 0.6s（与 mergeLyricTrans 配对
//      阈值一致），即紧跟原句；或与前一条翻译行时间戳相同（同时间戳多翻译）。
//   4. 主语言无法判定（两方向行数相等或都无）→ 不拆。
// 导出供测试。
// =====================================================================
export function splitTranslatedLyric(lines) {
  if (!Array.isArray(lines)) return { lrc: [], trans: [] }
  // 1) 统计整首歌词的主语言方向（忽略中英混杂的 other 行，如水印/歌名）。
  //    翻译行（紧跟原句、通常与原句 1:1）也会被计入统计，故数量可能持平——
  //    平局时以「第一个非杂项行」的语言裁决（首句通常是原文而非翻译）。
  let latinCount = 0
  let cjkCount = 0
  let firstMeaningfulClass = null
  const texts = lines.map((l) => String((l && l.text) || '').trim())
  for (const t of texts) {
    const cls = lyricClassOf(t)
    if (cls === 'latin') { latinCount++; if (firstMeaningfulClass === null) firstMeaningfulClass = 'latin' }
    else if (cls === 'cjk') { cjkCount++; if (firstMeaningfulClass === null) firstMeaningfulClass = 'cjk' }
  }
  // 翻译类 = 主语言的反类。主语言 = 数量多者；平局取首行语言；仍无法判定 → 不拆。
  let mainClass
  if (latinCount > cjkCount) mainClass = 'latin'
  else if (cjkCount > latinCount) mainClass = 'cjk'
  else mainClass = firstMeaningfulClass
  if (mainClass === null) return { lrc: lines, trans: [] }
  const transClass = mainClass === 'latin' ? 'cjk' : 'latin'

  // 2) 逐行拆分：翻译类且紧跟原句（或与前一条翻译同时间戳）→ 拆为 trans。
  const out = []
  const trans = []
  let lastKeepIdx = -1
  let lastTransT = null
  for (let i = 0; i < lines.length; i++) {
    const text = texts[i]
    const cls = lyricClassOf(text)
    const isTrans = cls === transClass
    const afterKeep = lastKeepIdx >= 0 && Math.abs(lines[i].t - out[lastKeepIdx].t) < 0.6
    const sameTransT = lastTransT !== null && lines[i].t === lastTransT
    if (isTrans && (afterKeep || sameTransT)) {
      trans.push({ t: lines[i].t, text })
      lastTransT = lines[i].t
      continue // 不加入主歌词行
    }
    out.push(lines[i])
    lastKeepIdx = out.length - 1
    lastTransT = null
  }
  return { lrc: out, trans }
}

// 行语言分类：'latin'（外文为主）| 'cjk'（中文为主）| 'other'（中英混杂/非歌词）。
function lyricClassOf(text) {
  const letters = (text.match(/[a-zA-Z]/g) || []).length
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  if (letters >= 3 && cjk === 0) return 'latin'
  if (cjk >= 2 && letters === 0) return 'cjk'
  return 'other'
}

export const name = 'dsh-music-player'
export const inject = ['webServer', 'fs', 'shell', 'tools', 'systemPrompt', 'llm']

export function apply(ctx) {
  let home = null
  let musicRoot = null
  let bookRoot = null
  let tracks = []
  let books = []
  let pendingIntent = null
  let startupPromise = null

  const getHome = async () => {
    if (home !== null) return home
    try {
      // os.homedir() resolves the user's home cross-platform (Windows uses
      // C:\Users\<name>; POSIX /Users/<name> or /home/<name>). The $HOME shell
      // variable does not exist under cmd/powershell on Windows, so fall back
      // to the shell only when os.homedir() is unusable.
      const osHome = (typeof os !== 'undefined' && os.homedir) ? os.homedir() : ''
      if (osHome !== '') { home = osHome; return home }
    } catch { /* fall through to shell */ }
    try {
      const result = await ctx.shell.run(ctx.shell.resolve({ command: 'printf %s "$HOME"' }))
      const value = String((result.stdout && result.stdout.text) || '').trim()
      home = value || null
    } catch {
      home = null
    }
    return home
  }
  // ---- persisted music root (survives DSH restarts) ----
  // A tiny JSON state file under the DSH home keeps the configured root across
  // process restarts; an unreadable or non-directory stored root is ignored so
  // the player falls back to the default ~/Music instead of failing to load.
  const stateFile = async () => {
    const h = await getHome()
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/music-player-state.json'
  }
  const loadStoredRoot = async () => {
    const file = await stateFile()
    if (file === null) return { music: null, books: null }
    try {
      const text = readFileSync(file, 'utf8')
      const data = JSON.parse(text)
      return {
        music: data && typeof data.root === 'string' && data.root !== '' ? data.root : null,
        books: data && typeof data.bookRoot === 'string' && data.bookRoot !== '' ? data.bookRoot : null,
      }
    } catch {
      return { music: null, books: null }
    }
  }
  const saveRoot = async (patched) => {
    const file = await stateFile()
    if (file === null) return
    try {
      // Write directly with node:fs: the host ctx.fs service may fence writes
      // under a workspace policy, which silently dropped the state file.
      let prev = {}
      if (existsSync(file)) {
        const prevText = readFileSync(file, 'utf8')
        if (prevText.trim()) { try { prev = JSON.parse(prevText) } catch { prev = {} } }
      }
      const next = { ...prev, ...patched }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
    } catch {
      // persistence is best-effort; an unwritable state file only loses the
      // remembered directory, never breaks playback
    }
  }
  const publicTracks = () => tracks.map((t) => ({
    id: t.id, name: t.name, url: t.url, size: t.size, ext: t.ext, path: t.path,
    quality: t.quality || '',
  }))
  const publicBooks = () => books.map((b) => ({
    id: b.id, name: b.name, size: b.size, url: '/dsh-music/book/' + b.id, path: b.path,
  }))

  // ---- 自建歌单（playlists）----
  // 歌单数据独立持久化到 ~/.dsh/music-player-playlists.json。成员以「绝对路径」为稳定键，
  // 不受曲库重扫的 id 变化影响；「我最喜欢」(pl-fav) 是系统默认歌单，首次启动自动创建。
  const FAV_PLAYLIST_ID = 'pl-fav'
  const FAV_PLAYLIST_NAME = '我最喜欢'
  let playlists = [] // [{id,name,fixed,trackPaths:[absPath],createdAt,updatedAt}]

  const playlistsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/music-player-playlists.json'
  }
  const loadPlaylists = async () => {
    const file = await playlistsFile()
    let list = []
    if (file !== null) {
      try {
        const text = readFileSync(file, 'utf8')
        const data = JSON.parse(text)
        if (data && Array.isArray(data.playlists)) list = data.playlists
      } catch { /* unreadable -> start with the system playlist only */ }
    }
    list = list
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({
        id: p.id, name: p.name, fixed: !!p.fixed,
        trackPaths: Array.isArray(p.trackPaths)
          ? p.trackPaths.filter((x) => typeof x === 'string' && x !== '')
          : [],
        createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0,
      }))
    // 系统默认歌单「我最喜欢」恒存在（固定第二位）。
    if (!list.some((p) => p.id === FAV_PLAYLIST_ID)) {
      list.unshift({ id: FAV_PLAYLIST_ID, name: FAV_PLAYLIST_NAME, fixed: true, trackPaths: [], createdAt: Date.now(), updatedAt: Date.now() })
    }
    playlists = list
  }
  const savePlaylists = async () => {
    const file = await playlistsFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, playlists }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }
  const findPlaylist = (id) => playlists.find((p) => p.id === id) || null

  // ---- 每日新闻播报（news editions / 定时偏好 / 执行态 / 失败日志）----
  // 全部新闻数据持久化到 ~/.dsh/music-player-news.json：
  //   editions[]      期次（结构化数据 + 口播稿分块 + sessionId 执行会话绑定）
  //   schedulePrefs   面板「定时规则编辑器」的偏好（含 model；Host 自维护定时器据此触发）
  //   runState        当前收集运行态（含执行会话 sessionId；news_broadcast/reportFailure 清除）
  //   failures[]      最近收集失败日志（透传工具错误，≤10 条）
  // 音频不落盘：TTS 懒合成（播放到哪块合成哪块），复用 synthesizeCached 内存缓存。
  // 定时由 Host 自维护（Node setInterval），每次执行新建一个「执行会话」并绑定结果。
  let news = { editions: [], schedulePrefs: sanitizeSchedulePrefs({}), runState: null, failures: [] }
  // 执行会话表（内存，不落盘）：sessionId -> { handle, editionId }，供删除期次时联动销毁会话。
  const execSessions = new Map()

  const newsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/music-player-news.json'
  }
  const loadNews = async () => {
    const file = await newsFile()
    let data = null
    if (file !== null) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object') data = parsed
      } catch { /* 不可读 -> 空白起步 */ }
    }
    news = {
      editions: data && Array.isArray(data.editions)
        ? data.editions.filter((e) => e && typeof e === 'object' && Array.isArray(e.chunks))
        : [],
      schedulePrefs: sanitizeSchedulePrefs({}, data && data.schedulePrefs),
      runState: data && data.runState && typeof data.runState === 'object' ? data.runState : null,
      failures: data && Array.isArray(data.failures) ? data.failures.slice(-LIMITS.failuresKept) : [],
    }
    return news
  }
  const saveNews = async () => {
    const file = await newsFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({
        version: 1,
        editions: news.editions,
        schedulePrefs: news.schedulePrefs,
        runState: runStateAlive(news.runState, Date.now()) ? news.runState : null,
        failures: news.failures,
      }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort：持久化失败不阻断播报 */ }
  }
  const pushFailure = (entry) => {
    news.failures.push({ ts: Date.now(), ...entry })
    if (news.failures.length > LIMITS.failuresKept) news.failures.shift()
  }
  // 班次范围（scope）→ 人类可读摘要（工具输出/失败日志共用）。
  // scope 必填（至少一个类别或主题，规整时空范围已兜底为全预设类别）；纯主题范围只列主题。
  const scopeSummary = (scope) => {
    const s = scope || {}
    const cats = (s.categories && s.categories.length > 0) ? s.categories : []
    const topics = (s.topics && s.topics.length > 0) ? s.topics : []
    if (cats.length === 0 && topics.length === 0) return PRESET_CATEGORIES.join('/')
    const catText = cats.length > 0 ? cats.join('/') : ''
    const topicText = topics.length > 0 ? `主题:${topics.join(',')}` : ''
    return [catText, topicText].filter(Boolean).join('+')
  }

  // ---- 执行会话 + 统一执行入口 ----
  // 每次执行（定时到点 / 面板立即执行）新建一个「执行会话」并绑定结果；删除期次时联动销毁。
  // 创建失败 / 无 agents 服务 / 无模型可建 → 返回 null，调用方优雅回退。
  // 模型来源：面板 schedulePrefs.model（用户选），否则复制最近一个活跃 root 会话的模型。
  // name：可选的会话名（如「05-30 08:00 科技」），创建成功后经 sessionTitle.rename 显式命名
  // （注入的 followup 是 plugin 来源、不满足 session-title 的 user 资格，无法自动命名）；
  // 会话同时归入「新闻收集」命名工作区（见 newsWorkspaceDir），不再挂在「未分组」下。
  // 返回 { sessionId, agent }，失败返回 null。
  const deriveAgentModel = () => {
    const agentsSvc = ctx.get ? ctx.get('agents') : null
    const roots = agentsSvc && typeof agentsSvc.roots === 'function'
      ? agentsSvc.roots().filter((a) => a && a.session && typeof a.followup === 'function')
      : []
    const source = roots[roots.length - 1] || null
    const prefModel = news.schedulePrefs && news.schedulePrefs.model
    const provider = (prefModel && prefModel.provider) || (source && source.options && source.options.provider) || ''
    const model = (prefModel && prefModel.model) || (source && source.options && source.options.model) || ''
    return (provider && model) ? { provider, model } : null
  }

  // 新闻执行会话的专属工作区：目录 ~/.dsh/news（尊重 DSH_HOME，与 stateFile 同一套解析），
  // 显示名「新闻收集」。目录不存在则创建并取规范路径（realpath，符号链接一并解析——
  // 工作区路径与会话 header cwd 都用这套规范比对）。任何一步失败都返回 null，回退旧 cwd 逻辑。
  const NEWS_WORKSPACE_TITLE = '新闻收集'
  const newsWorkspaceDir = async () => {
    const h = await getHome()
    const base = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
      || (h === null ? null : h + '/.dsh')
    if (base === null) return null
    const dir = base + '/news'
    try {
      mkdirSync(dir, { recursive: true })
      return realpathSync(dir)
    } catch {
      return null
    }
  }

  // 工作区注册表：当前 DSH 服务名为 'workspaceRegistry'；兼容旧名 'workspace'。
  // 按能力（archiveSession）判定，缺失时返回 null（分组/归档均 best-effort）。
  const resolveWorkspaceRegistry = () => {
    if (!ctx || typeof ctx.get !== 'function') return null
    for (const name of ['workspaceRegistry', 'workspace']) {
      let svc = null
      try { svc = ctx.get(name) } catch { svc = null }
      if (svc && typeof svc.archiveSession === 'function') return svc
    }
    return null
  }

  // 方案A：等 workspaceRegistry 就绪再归档（修复启动清理竞态）。
  // 问题：DSH 启动时所有 bundle 条目并行挂载，音乐插件 apply 里 fire-and-forget 的启动清理
  // 会在 workspaceRegistry 的异步 init 完成前就调 archiveSession——此时 requireState() 抛
  // 「workspace registry is not started yet」，错误被吞掉 → 期次删了但会话没归档，且因
  // partitionStaleNews 只从「仍存在的旧期次」反查 sessionId，这些孤儿会话此后永远不会再被归档。
  // 这里轮询等到「可归档」状态：resolve 到服务（构造完成）且 requireState 已就位
  // （archiveSession 内部的 sessionKnown 会走 sessionPersistence 兜底，足以找到持久化会话）。
  // 就绪后立即返回（每次清理只真正等一次）；超时返回 null（归档 best-effort 跳过，不影响期次清理）。
  const waitRegistryReady = async (timeoutMs = 20000, appearGraceMs = 2000) => {
    const started = Date.now()
    const deadline = started + timeoutMs
    for (;;) {
      const registry = resolveWorkspaceRegistry()
      if (registry) {
        try {
          // requireState() 未就位时该 getter 抛「workspace registry is not started yet」
          void registry.archivedSessionIds
          return registry
        } catch { /* init 进行中，继续等 */ }
      } else if (Date.now() - started > appearGraceMs) {
        return null // 从未出现过：无 workspaceRegistry 的环境，归档本就不可行，不空等整个超时
      }
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  const createExecutionSession = async (name) => {
    const agentsSvc = ctx.get ? ctx.get('agents') : null
    if (!agentsSvc || typeof agentsSvc.roots !== 'function' || typeof agentsSvc.get !== 'function') return null
    const m = deriveAgentModel()
    if (!m) return null
    const { provider, model } = m
    const roots = agentsSvc.roots().filter((a) => a && a.session && typeof a.followup === 'function')
    const source = roots[roots.length - 1] || null
    // cwd 指向新闻专属目录：DSH 工作区按「会话 header cwd === 工作区路径」校验成员资格，
    // 会话创建后把这个目录注册为「新闻收集」工作区并 attach，会话即归入命名分组而不是「未分组」。
    const newsDir = await newsWorkspaceDir()
    const cwd = newsDir
      || (source && source.session && source.session.header && source.session.header.cwd)
      || (await getHome())
      || null
    const sessionId = 'news-exec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const createFn = (typeof agentsSvc.create === 'function')
      ? agentsSvc.create.bind(agentsSvc)
      : (ctx.agents && typeof ctx.agents.create === 'function') ? ctx.agents.create.bind(ctx.agents) : null
    if (!createFn) return null
    // 装配标准 agent 组合（含 web_search / web_fetch 等工具）：解析默认 standing preset，
    // 在 setup 里 mount 到新会话。若 presets 服务缺失（无 roster 的部署），web 工具在宿主
    // 全局层可见，无需 mount，直接裸建即可。任何一步失败都降级为裸建（不 crash）。
    const presets = ctx.get ? ctx.get('agentPresets') : null
    let resolvedId
    let setup
    if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
      try {
        const preset = await presets.resolve(undefined)
        resolvedId = preset && preset.id
        if (resolvedId) {
          setup = async (agentCtx) => {
            await presets.mount(agentCtx, resolvedId)
          }
        }
      } catch {
        resolvedId = undefined
        setup = undefined
      }
    }
    try {
      const handle = await createFn({
        sessionId,
        agentOptions: { provider, model },
        meta: {
          ...(cwd ? { cwd } : {}),
          ...(resolvedId ? { agentPreset: resolvedId } : {}),
        },
        ...(setup ? { setup } : {}),
      })
      const agent = handle && handle.agent ? handle.agent : null
      if (!agent) return null
      execSessions.set(sessionId, { handle, editionId: null })
      // 显式命名执行会话（时间 + 类别）：sessionTitle.rename 同步固定标题。
      if (name) {
        const titles = ctx.get ? ctx.get('sessionTitle') : null
        if (titles && typeof titles.rename === 'function') {
          try {
            titles.rename(agent.session, String(name))
          } catch { /* best-effort：命名失败不影响收集 */ }
        }
      }
      // 归入「新闻收集」命名分组：registry.create 幂等（同路径返回既有实体），attach 把
      // 会话登记进该工作区账本。任一步失败都吞掉——分组失败不影响收集本身。
      if (newsDir) {
        const registry = resolveWorkspaceRegistry()
        if (registry && typeof registry.create === 'function') {
          try {
            const ws = await registry.create(newsDir, NEWS_WORKSPACE_TITLE)
            if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sessionId)
          } catch { /* best-effort：分组失败不影响收集 */ }
        }
      }
      return { sessionId, agent }
    } catch {
      return null
    }
  }

  // 删除期次时「销毁」对应执行会话：
  // 1) 销毁运行中的 agent——优先用本进程内存表里持有的句柄；否则（跨重启后句柄丢失）尽力
  //    resume→dispose 兜底（DSH 的 agents 服务只允许创建者经句柄 dispose）。
  // 2) 把该会话「归档」——DSH 没有删除持久化会话的 API（sessionPersistence 只追加、不删除；
  //    AgentHandle.dispose 只拆内存里运行的 agent，持久化 JSONL 重启后仍会被重新加载）。
  //    唯一能让会话从会话列表/分组/搜索里彻底消失（且跨重启保持）的官方机制是
  //    ctx.workspaceRegistry.archiveSession(id)：归档集合持久化在 storage domain，重启不丢，
  //    UI 对所有归档会话一律隐藏。任何一步失败都吞掉（best-effort，不阻断删除期次）。
  // 参数 registry：可选——启动清理时由 purgeStaleNews 等就绪后一次性传入（避免逐会话重复等待）；
  //    不传（如删除单条期次时，宿主已完全启动）则内部 waitRegistryReady() 立即返回。
  const disposeExecutionSession = async (sessionId, registryOverride = undefined) => {
    if (!sessionId) return
    // (1) 销毁运行中的 agent（本进程句柄优先，否则 resume→dispose 兜底）
    const rec = execSessions.get(sessionId)
    if (rec && rec.handle && typeof rec.handle.dispose === 'function') {
      try { await rec.handle.dispose() } catch {}
      execSessions.delete(sessionId)
    } else {
      try {
        const agentsSvc = ctx.get ? ctx.get('agents') : null
        if (agentsSvc && typeof agentsSvc.resume === 'function') {
          const m = deriveAgentModel()
          if (m) {
            const handle = await agentsSvc.resume({
              resumeSessionId: sessionId,
              agentOptions: { provider: m.provider, model: m.model },
            })
            if (handle && typeof handle.dispose === 'function') { try { await handle.dispose() } catch {} }
          }
        }
      } catch { /* best-effort */ }
    }
    // (2) 归档：让该会话从会话列表彻底消失且跨重启保持隐藏。
    try {
      const registry = registryOverride !== undefined ? registryOverride : await waitRegistryReady()
      if (registry) {
        await registry.archiveSession(sessionId)
      }
    } catch (error) {
      // best-effort：归档失败不影响删除期次，但留一行日志便于排查（此前静默吞掉导致
      // 期次删了、会话却永久遗留而无人察觉）。
      console.log('[dsh-music-player] 归档执行会话失败（' + sessionId + '）：' + ((error && error.message) || String(error)))
    }
  }

  // 把指令作为 user 消息注入指定 agent（镜像 harness schedule 插件的 followup 官方模式）。
  const followupInstruction = (agent, text) => {
    if (!agent || !agent.session || typeof agent.followup !== 'function') return false
    const message = {
      id: 'news-auto-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-music-player' },
    }
    agent.followup(message)
    return true
  }

  // 统一执行入口：定时到点 + 面板立即执行都走这里（只是触发点不同）。
  // 新建执行会话 → 设 runState(含 sessionId) → 注入收集指令。
  const runCollection = async (shiftId) => {
    await loadNews()
    // 单收集槽位：已有收集（定时/手动）在跑时拒绝新触发。冷却窗只能挡住重复「期次」，
    // 挡不住重复的「收集过程」——不拦截的话连点 ▶ 会创建多个执行会话白白各跑一轮搜索。
    // runState 带 10 分钟 TTL（agent 漏报失败时自动复位），不会永久卡死。
    if (runStateAlive(news.runState, Date.now())) {
      // 提示里用班次触发时刻而非内部随机 id（对用户是乱码）
      const cur = news.runState.shiftId
        ? (news.schedulePrefs.shifts || []).find((x) => x.id === news.runState.shiftId) : null
      const who = cur ? cur.time + ' 班次' : (news.runState.shiftId ? '定时任务' : '手动')
      return { ok: false, busy: true, error: '已有收集进行中（' + who + '），请等当前收集完成' }
    }
    const shift = shiftId ? (news.schedulePrefs.shifts || []).find((x) => x.id === shiftId) : null
    const scopeText = scopeSummary(shift ? shift.scope : null)
    const autoplay = shift ? shift.autoplay !== false : true
    // 会话名称 = 创建会话的当前时间 + 任务的类别。
    const nowD = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const timeLabel = `${p2(nowD.getMonth() + 1)}-${p2(nowD.getDate())} ${p2(nowD.getHours())}:${p2(nowD.getMinutes())}`
    const scopeLabel = scopeSummary(shift ? shift.scope : null)
    const sessionName = `${timeLabel} ${scopeLabel}`
    const session = await createExecutionSession(sessionName)
    if (session === null) return { ok: false, fallback: true, error: 'agents 服务不可用或无法创建执行会话' }
    news.runState = { shiftId: shiftId || null, sessionId: session.sessionId, startedAt: Date.now(), scope: scopeText }
    await saveNews()
    const playText = autoplay === false ? '收集完成后先不播放（静默收集）' : '收集完成后立即用 news_broadcast 提交并自动播放'
    // 范围精确性：明确允许提交的类别名（scope.categories + 自定义主题），否则 agent 常把
    // 大类里的热点（如科技里的 AI）自行另立类别，输出与班次配置不符。工具层另有过滤兜底。
    let scopeRule = ''
    // 班次新闻条数预算：指令里给出全期条数与「多类别尽量平均分配」的配额，agent 按此收集；
    // 工具层另有 capCategoriesToQuota 兜底收敛（见 news_broadcast execute）。
    let countRule = ''
    if (shift) {
      const cats = (shift.scope && shift.scope.categories && shift.scope.categories.length > 0) ? shift.scope.categories : PRESET_CATEGORIES
      const topics = (shift.scope && shift.scope.topics && shift.scope.topics.length > 0) ? shift.scope.topics : []
      scopeRule = '提交 news_broadcast 时 categories 只能使用：' + cats.join('、') +
        (topics.length > 0 ? '；自定义主题可建与主题同名的类别（' + topics.join('、') + '）' : '') +
        '。严禁自行增加范围外的类别。'
      const itemCount = normalizeShiftItemCount(shift.itemCount)
      const units = cats.length + topics.length // 类别 + 自定义主题 = 输出类别数
      const quota = evenItemQuota(itemCount, units)
      // 配额全相等时（能整除）只说「每类约 X 条」，不等才说范围（如 3~2），避免「4~4」这类啰嗦。
      const qLo = quota[0], qHi = quota[quota.length - 1]
      const quotaText = units > 1
        ? (qLo === qHi
          ? `，${units} 个类别尽量平均分配（每类约 ${qLo} 条）`
          : `，${units} 个类别尽量平均分配（每类约 ${qLo}~${qHi} 条，余数给靠前类别）`)
        : ''
      countRule = `本期共收集 ${itemCount} 条新闻${quotaText}，全期不超过 ${itemCount} 条。`
    }
    // 显式注入当前日期与时间：执行会话是全新 agent、不知道今天几号，不注入就会先调工具去查
    // 时间，浪费时间还可能猜错日期锚定错新闻。星期几对「周报/本周」类查询也有用。
    const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六']
    const nowText = `今天是 ${nowD.getFullYear()}年${nowD.getMonth() + 1}月${nowD.getDate()}日 星期${WEEKDAY_CN[nowD.getDay()]}，当前时间 ${p2(nowD.getHours())}:${p2(nowD.getMinutes())}`
    const text = (shiftId
      ? `立即执行我的 ${shift.time} 新闻班次（班次 id ${shift.id}）：${nowText}。请收集${scopeText}相关的今日头条——搜索查询词一律用上面的日期锚定当天（如「${nowD.getMonth() + 1}月${nowD.getDate()}日 热搜榜」），${countRule}整理后提交播报，${playText}。${scopeRule}请按新闻收集流程执行。`
      : `${nowText}。请收集今日头条——搜索查询词一律用该日期锚定当天，并按新闻收集流程执行，${playText}。`)
    followupInstruction(session.agent, text)
    return { ok: true, sessionId: session.sessionId, agent: session.agent }
  }

  // ---- Host 自维护定时器 ----
  // 读 schedulePrefs.shifts 每天到点触发 runCollection（每次执行新建一个执行会话并绑定结果）。
  // 宿主进程常驻，Node setInterval 可靠；保存偏好即重建；宿主重启后由启动流程重建。
  // 不再依赖 DSH 会话级 schedule——定时器完全脱离会话存活，会话销毁不影响到点触发。
  let newsTimer = null
  const newsTimerFired = new Map() // shiftId -> 最近一次已触发的分钟键，避免同分钟内重复
  const minuteKeyOf = (d) => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
    + ' ' + d.getHours() + ':' + d.getMinutes()
  const rebuildTimer = async () => {
    await loadNews()
    if (newsTimer !== null) { clearInterval(newsTimer); newsTimer = null }
    newsTimerFired.clear()
    const tick = () => {
      const p = news.schedulePrefs
      if (!p || !p.enabled || !Array.isArray(p.shifts) || p.shifts.length === 0) return
      const now = new Date()
      const key = minuteKeyOf(now)
      for (const s of p.shifts) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) continue
        const [hh, mm] = s.time.split(':').map(Number)
        if (now.getHours() !== hh || now.getMinutes() !== mm) continue
        if (newsTimerFired.get(s.id) === key) continue
        newsTimerFired.set(s.id, key)
        void runCollection(s.id).then((r) => {
          // 定时触发撞上进行中的收集（如手动立即执行还没跑完）：跳过本轮并留痕
          if (r && r.busy) console.log('[dsh-music-player] 定时触发跳过（' + s.time + '）：已有收集进行中')
        })
      }
    }
    newsTimer = setInterval(tick, 30 * 1000) // 每 30s 检查一次；到分钟即触发一次
    tick()
  }
  ctx.effect(() => () => { if (newsTimer !== null) { clearInterval(newsTimer); newsTimer = null } }, 'music-player: news host timer')

  // ---- 每日 03:00 过期清理：不再保留多天新闻 ----
  // 两个触发点走同一入口 purgeStaleNews（按 createdAt 幂等，重复执行无副作用）：
  //   1) 每次启动：无条件检查一次，存在非今天收集的期次/失败记录就直接清理（不受 03:00 限制）；
  //   2) 每天 03:00 后的首个检查点：宿主常驻跨天时也能按时清理（每自然日最多一次）。
  // 清理范围 = 今天 00:00 之前的全部期次与失败记录，并联动销毁/归档其执行会话——与手动
  // 删除期次完全同一套联动（disposeExecutionSession：本进程句柄优先，跨重启 resume→dispose
  // 兜底 + workspaceRegistry.archiveSession 跨重启隐藏）。
  const NEWS_CLEANUP_HOUR = 3
  let newsCleanupTimer = null
  let newsCleanupLastDay = null // 最近一次已执行清理的日期键，保证每天最多跑一次
  // 注意：这里绝不 await loadNews()——内存态 news 就是唯一活真相，清理函数若在飞行途中
  // 用磁盘快照覆盖内存，会把并发写入（如正在提交的期次）吞掉。调用方负责先 loadNews。
  // 变更段（partition→过滤）是同步的，只有 saveNews/归档在异步尾段，不留覆盖窗口。
  const purgeStaleNews = (now = new Date()) => {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const { staleEditions, staleFailures, sessionIds } = partitionStaleNews(news.editions, news.failures, startOfToday)
    if (staleEditions.length === 0 && staleFailures.length === 0) {
      return Promise.resolve({ editions: 0, failures: 0, sessions: 0 })
    }
    const staleEditionIds = new Set(staleEditions.map((e) => e.id))
    news.editions = news.editions.filter((e) => !staleEditionIds.has(e.id))
    news.failures = news.failures.filter((f) => !staleFailures.includes(f))
    return (async () => {
      await saveNews()
      // 方案A：清理前等 workspaceRegistry 就绪（一次，避免逐会话重复等待）。注册表未就绪时
      // archiveSession 会抛「not started yet」被吞 → 期次删了会话却永久遗留；等就绪后再归档。
      const registry = await waitRegistryReady()
      for (const sid of sessionIds) {
        try { await disposeExecutionSession(sid, registry) } catch { /* best-effort：归档失败不影响清理 */ }
      }
      console.log('[dsh-music-player] 每日清理：删除期次 ' + staleEditions.length + ' 期、失败记录 ' + staleFailures.length + ' 条，联动处理执行会话 ' + sessionIds.length + ' 个')
      return { editions: staleEditions.length, failures: staleFailures.length, sessions: sessionIds.length }
    })()
  }
  const runDueCleanup = async () => {
    const now = new Date()
    if (now.getHours() < NEWS_CLEANUP_HOUR) return
    const dayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate()
    if (newsCleanupLastDay === dayKey) return
    newsCleanupLastDay = dayKey
    await purgeStaleNews(now)
  }
  const rebuildCleanupTimer = async () => {
    await loadNews()
    if (newsCleanupTimer !== null) { clearInterval(newsCleanupTimer); newsCleanupTimer = null }
    newsCleanupTimer = setInterval(() => { void runDueCleanup().catch(() => {}) }, 30 * 1000) // 与班次定时器同节奏
    void purgeStaleNews().catch(() => {}) // 启动即检查：存在非今天的新闻就直接清理（不等 03:00）
  }
  ctx.effect(() => () => { if (newsCleanupTimer !== null) { clearInterval(newsCleanupTimer); newsCleanupTimer = null } }, 'music-player: news daily cleanup timer')


  // ---- 播放偏好持久化（volume / mode / playback / 小说进度 / QQ UI）----
  // 这些状态原本存在浏览器 localStorage，而 localStorage 按「源(origin)」隔离。
  // dsh-desktop 每次启动给 Harness Web 服务分配一个随机端口，导致源每次变化、
  // localStorage 每次都读不到——重启后音量/播放顺序/上次播放内容全丢。现在
  // 所有持久化状态统一存 Host 端文件（DSH_HOME 固定不变，DSH 进程重启不丢），
  // 客户端启动时 GET /prefs 以快照为准恢复，改动经 POST /prefs 合并写回。
  // 值一律以字符串存储，与客户端 loadPref 对齐。
  let serverPrefs = {} // { 'dsh-music-volume': '0.8', 'dsh-music-mode': 'order', ... }
  const PREF_ALLOW = new Set([
    'dsh-music-mode', 'dsh-music-volume', 'dsh-music-voice', 'dsh-music-scope',
    'dsh-music-panel-pos', 'dsh-music-lyric-panel-pos', 'dsh-music-playback', 'dsh-music-qq-playback', 'dsh-music-kg-playback', 'dsh-music-books-playback',
    'dsh-music-qq-fav', 'dsh-music-qq-history', 'dsh-music-qq-ui', 'dsh-music-kg-history',
    'dsh-music-show-lyric', 'dsh-music-show-viz', 'dsh-music-show-progress',
    'dsh-music-show-quality', 'dsh-music-show-bar-bg',
    // 歌词/字幕面板透明模式（与客户端 PREF_KEYS 对齐，漏掉会被 sanitizePrefs 静默
    // 丢弃 → 刷新后面板透明开关重置回默认开）。
    'dsh-music-lyric-panel-ghost',
    'dsh-music-immerse',
    // 歌词动效：换行风格（与客户端 PREF_KEYS 对齐，漏掉会被 sanitizePrefs 静默丢弃
    // → 表现为「配置刷新后重置」）。跑马灯/边缘渐隐是内置行为，无对应配置键。
    'dsh-music-lyric-fx',
    // 频谱样式：柱状图/波形图（与客户端 PREF_KEYS 对齐，漏掉同样会被 sanitizePrefs
    // 静默丢弃 → 刷新后频谱样式重置回柱状图）。
    'dsh-music-viz-mode',
    // 版本更新弹窗「已看过哪个版本」标记（PREF_SEEN_VERSION，与 whatsnew.js /
    // 客户端 PREF_KEYS 三处对齐；漏掉会被静默丢弃 → 每次启动都弹更新窗）。
    PREF_SEEN_VERSION,
  ])
  const LYRIC_FX_ALLOW = new Set(['none', 'slide', 'blur', 'karaoke'])
  const VIZ_MODE_ALLOW = new Set(['bars', 'wave'])
  const PREF_VALUE_MAX = 256 * 1024 // 单键上限（books 进度 map / QQ 队列可能较大）
  const sanitizePrefs = (input) => {
    const out = {}
    if (!input || typeof input !== 'object') return out
    for (const k of Object.keys(input)) {
      if (!PREF_ALLOW.has(k)) continue
      const v = input[k]
      if (typeof v !== 'string' || v === '' || v.length > PREF_VALUE_MAX) continue
      if (k === 'dsh-music-volume') {
        const n = Number(v)
        if (!Number.isFinite(n)) continue
        out[k] = String(Math.min(1, Math.max(0, n)))
        continue
      }
      if (k === 'dsh-music-immerse') {
        const n = Number(v)
        if (!Number.isFinite(n)) continue
        out[k] = String(Math.min(1, Math.max(0, n)))
        continue
      }
      if (k === 'dsh-music-mode') {
        if (v !== 'single' && v !== 'order' && v !== 'shuffle') continue
        out[k] = v
        continue
      }
      if (k === 'dsh-music-lyric-fx') {
        // 枚举校验：脏数据丢弃（客户端读取端有同样的白名单兜底，双保险）。
        if (!LYRIC_FX_ALLOW.has(v)) continue
        out[k] = v
        continue
      }
      if (k === 'dsh-music-viz-mode') {
        // 枚举校验：只接受 bars / wave，脏数据丢弃。
        if (!VIZ_MODE_ALLOW.has(v)) continue
        out[k] = v
        continue
      }
      if (k === PREF_SEEN_VERSION) {
        // 版本号形态校验（主.次.修订 可带预发布段，如 0.8.0-beta.1）：脏数据丢弃。
        if (!/^[0-9A-Za-z.+\-]{1,32}$/.test(v)) continue
        out[k] = v
        continue
      }
      out[k] = v
    }
    return out
  }
  const prefsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/music-player-prefs.json'
  }
  const loadPrefs = async () => {
    const file = await prefsFile()
    serverPrefs = {}
    if (file === null) return serverPrefs
    try {
      const text = readFileSync(file, 'utf8')
      const data = JSON.parse(text)
      if (data && typeof data === 'object' && data.prefs && typeof data.prefs === 'object') {
        serverPrefs = sanitizePrefs(data.prefs)
      }
    } catch { /* 不可读 -> 空 */ }
    return serverPrefs
  }
  const savePrefs = async () => {
    const file = await prefsFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 2, prefs: serverPrefs }, null, 2) + '\n', 'utf8')
    } catch { /* best-effort */ }
  }

  // ---- 版本更新弹窗（What's New）：随 manifest 下发给浏览器的四件套 ----
  // whatsNew = 当前版条目（null = 本版没写条目，客户端不弹）；
  // whatsNewHistory = 历史条目（新→旧，≤10 条，「历史版本」折叠列表数据源）；
  // whatsNewWelcome = 首装欢迎页卖点内容；whatsNewState = 弹窗判定结论
  //（fresh/upgrade/seen/downgrade，判定逻辑在 whatsnew.js，客户端只执行）。
  // 判定读 serverPrefs 的已看标记，因此每次下发前重读一遍 prefs 文件保证新鲜
  //（另一窗口刚关闭弹窗写入的标记，本窗口刷新后立即可见）。manifest 与 rescan
  // 两个下发点共用。
  const whatsNewPayload = async () => {
    await loadPrefs()
    return {
      whatsNew: WHATSNEW_PKG.entry,
      whatsNewHistory: WHATSNEW_PKG.history,
      whatsNewWelcome: WELCOME,
      whatsNewState: whatsNewState(PKG_VERSION, serverPrefs[PREF_SEEN_VERSION] || '', serverPrefs),
    }
  }

  // ---- 在线 QQ 音乐：cookie 持久化 + 登录会话（扫码登录后取高音质直链） ----
  // cookie 仅存 Host 端（~/.dsh/music-player-qq-cookie.json，0600），不进入浏览器。
  // loginFrom 记录本次登录方式：'qq'=QQ 扫码 / 'wx'=微信扫码（随 cookie 持久化，
  // 供「关于」页区分展示）。
  const qq = { cookie: '', isVip: null, nickname: '', loginFrom: '' }
  let qqLoginSession = null // { key, mode, expiresAt, imageDataUrl }
  let qqCookieLoaded = false

  const qqCookieFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/music-player-qq-cookie.json'
  }
  const loadQQCookie = async () => {
    if (qqCookieLoaded) return
    qqCookieLoaded = true
    const file = await qqCookieFile()
    if (file === null) return
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data && typeof data.cookie === 'string' && data.cookie !== '') qq.cookie = data.cookie
      if (data && typeof data.nickname === 'string' && data.nickname !== '') qq.nickname = data.nickname
      // 老版本 cookie 文件没有 loginFrom 字段 → 留空（未知），不强行猜测登录方式。
      if (data && typeof data.loginFrom === 'string' && (data.loginFrom === 'qq' || data.loginFrom === 'wx')) qq.loginFrom = data.loginFrom
    } catch { /* unreadable -> not logged in */ }
  }
  const saveQQCookie = async () => {
    const file = await qqCookieFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cookie: qq.cookie, nickname: qq.nickname, loginFrom: qq.loginFrom, savedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 })
    } catch { /* best-effort */ }
  }
  const clearQQCookie = async () => {
    qq.cookie = ''; qq.isVip = null; qq.nickname = ''; qq.loginFrom = ''
    clearQQTakeCache()
    const file = await qqCookieFile()
    if (file !== null) { try { writeFileSync(file, JSON.stringify({ cookie: '' }), { encoding: 'utf8', mode: 0o600 }) } catch { /* ignore */ } }
  }
  const qqUin = () => {
    const m = /(?:^|;)\s*?uin=([^;]+)/.exec(qq.cookie)
    return m ? m[1].trim() : ''
  }
  const refreshQQVip = async () => {
    if (qq.cookie === '') { qq.isVip = false; return false }
    if (qq.isVip === null) { try { qq.isVip = await QQ.detectVip(qq.cookie) } catch { qq.isVip = false } }
    return !!qq.isVip
  }
  // 取链结果按 songmid 短缓存（TTL 5 分钟，在 vkey 直链有效期之内）：同一首歌的
  // <audio> 加载与频谱信封（loadEnvelope）两次请求都命中 /qq/play 路由，缓存保证
  // 两次拿到同一档位 —— 「真实品质」标签（X-DSH-QQ-Quality）与真正播放的流一致，
  // 顺带省一次 vkey 往返。登录/登出时清空，避免跨账号串档。
  const QQ_TAKE_TTL_MS = 5 * 60 * 1000
  const qqTakeCache = new Map() // songmid -> { url, filename, quality, ts }
  const qqTake = async (songmid) => {
    const hit = qqTakeCache.get(songmid)
    if (hit !== undefined && Date.now() - hit.ts < QQ_TAKE_TTL_MS) return hit
    // 取链始终按「无损 → OGG → 320k → 128k」完整顺序请求，由服务端授予哪个就播哪个
    // （真实品质）。不依赖 detectVip 开关：VIP 账号能拿无损、非 VIP 无损档自动为空并
    // 降到 320k/128k，标签始终反映实际授予的档位。
    const dl = await QQ.getDownloadURL(songmid, qq.cookie, true)
    const entry = { url: dl.url || '', filename: dl.filename || '', quality: qqQualityLabel(dl.filename), ts: Date.now() }
    if (entry.url !== '') {
      qqTakeCache.set(songmid, entry)
      if (qqTakeCache.size > 200) qqTakeCache.delete(qqTakeCache.keys().next().value)
    }
    return entry
  }
  const clearQQTakeCache = () => qqTakeCache.clear()

  // ---- 在线酷狗音乐：登录态（token+userid+设备身份）持久化，结构与 qq 对齐 ----
  // 设备身份（guid/mid/dfid）首登时生成并长期复用——酷狗侧按设备指纹做风控，
  // 每次换新指纹反而更危险。mid 是 30+ 位十进制大数，全程字符串处理。
  const kg = {
    session: { guid: '', mid: '', dfid: '-', token: '', userid: '', vip_type: '', vip_token: '' },
    loggedIn: false,
    isVip: null,
  }
  let kgLoginSession = null
  let kgCookieLoaded = false
  let kgCookieLoadInFlight = null // 首次读取进行中的共享 Promise（见 loadKGCookie 的在途去重）
  // 最近一次写 cookie 的时间戳（ms），≈ 最近一次登录/刷新 token 的时间。
  // 主动续命（maybeRefreshKgSession）据此判断 token 是否已陈旧、需要提前换新。
  let kgSavedAt = 0

  const kgCookieFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : base + '/music-player-kugou-cookie.json'
  }
  // ⚠️ 在途去重：kgCookieLoaded 标志在同步路径先置位，而 kg.loggedIn 要等文件
  // 读完才赋值——启动后同一 tick 内的第二个请求若只看标志位，会带着初始的
  // loggedIn:false 直奔「未登录」401。首个读取完成前，后来者共享同一次读取。
  const loadKGCookie = async () => {
    if (kgCookieLoadInFlight) return kgCookieLoadInFlight
    if (kgCookieLoaded) return
    kgCookieLoadInFlight = (async () => {
      kgCookieLoaded = true
      const file = await kgCookieFile()
      if (file === null) return
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        if (data && typeof data.session === 'object' && data.session) {
          for (const k of Object.keys(kg.session)) {
            if (typeof data.session[k] === 'string' && data.session[k] !== '') kg.session[k] = data.session[k]
          }
        }
        if (data && typeof data.savedAt === 'number' && data.savedAt > 0) kgSavedAt = data.savedAt
        kg.loggedIn = !!(kg.session.token && kg.session.userid)
        if (!kg.session.mid) kg.session.mid = '' // 保持空：login/start 时统一生成
      } catch { /* unreadable -> not logged in */ }
    })()
    try { await kgCookieLoadInFlight } finally { kgCookieLoadInFlight = null }
  }
  const saveKGCookie = async () => {
    const file = await kgCookieFile()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      kgSavedAt = Date.now()
      writeFileSync(file, JSON.stringify({ session: kg.session, loggedIn: kg.loggedIn, savedAt: kgSavedAt }), { encoding: 'utf8', mode: 0o600 })
    } catch { /* best-effort */ }
  }
  // 确保酷狗设备身份（mid/dfid）存在：匿名浏览「分类」等也要走 Android 网关签名，
  // 未登录时设备身份尚未生成。缺 mid 则创建并注册真实 dfid、持久化到 cookie 文件。
  const ensureKugouDevice = async () => {
    await loadKGCookie()
    if (kg.session.mid) return
    const fresh = KG.createDeviceIdentity()
    Object.assign(kg.session, fresh)
    let warning = ''
    try {
      const reg = await KG.registerDevice(kg.session)
      if (reg && reg.dfid) kg.session.dfid = reg.dfid
    } catch (regErr) {
      warning = '设备注册失败，已用临时身份继续：' + String((regErr && regErr.message) || regErr)
    }
    await saveKGCookie()
    if (warning) kg.logger && kg.logger.warn && kg.logger.warn(warning)
  }
  const kgTakeCacheKg = new Map() // hash -> { url, quality, bitrate, ts }
  // 取链「进行中」去重：同一 hash 的 <audio> GET 与音质 HEAD 探测几乎同时到达，
  // 都先于缓存写入而 miss → 各自取一次链（实测每首歌取链两次）。这里把在途取链的
  // Promise 共享给并发请求，同一首歌只真正取链一次。
  const kgTakeInFlight = new Map() // hash -> Promise<entry>

  // 登录态动作的统一包装：碰到「登录态与设备不匹配」(20017/20018) 先静默
  // 刷新一次标准作用域 token（v5/login_by_token）再原样重试。
  // 若连刷新都返回「设备不匹配」（token 已被酷狗判定失效/与设备解绑，20018），
  // 登录态不可挽回——自动清空本地会话并带上 kgLoginDead 标记，让客户端回到扫码
  // 登录页，而不是一直挂在「刷新登录态失败」的报错里（酷狗无续命接口，只能重扫）。
  const KG_AUTH_DEAD_RE = /20017|20018|20028|设备不匹配/
  const kgWithFreshToken = async (fn) => {
    // 主动续命：token 陈旧（>12h 未刷新）先静默换新，避免过期后只能重扫。
    await maybeRefreshKgSession()
    try { return await fn() } catch (e) {
      const m = String((e && e.message) || e)
      if (!KG_AUTH_DEAD_RE.test(m) || !kg.loggedIn) throw e
      let refreshed
      try {
        refreshed = await KG.refreshSession(kg.session)
      } catch (re) {
        const rm = String((re && re.message) || re)
        if (!KG_AUTH_DEAD_RE.test(rm)) throw re
        // 刷新也失败 → 会话确实死了：清掉 cookie 并打标记，客户端据此重扫。
        await clearKGCookie()
        const dead = new Error('酷狗登录已失效（登录态与设备不匹配），请重新扫码登录')
        dead.kgLoginDead = true
        throw dead
      }
      if (!refreshed.token) throw e
      kg.session.token = refreshed.token
      kg.session.vip_type = refreshed.vip_type || kg.session.vip_type
      kg.session.vip_token = refreshed.vip_token || kg.session.vip_token
      if (refreshed.t1) kg.session.t1 = refreshed.t1
      await saveKGCookie()
      return await fn()
    }
  }
  // 酷狗路由错误序列化：带出 kgLoginDead 标记，供前端识别「登录已失效需重扫」。
  const writeKgErr = (res, err, status = 502) => {
    const payload = { ok: false, error: String((err && err.message) || err) }
    if (err && err.kgLoginDead) payload.kgLoginDead = true
    writeJson(res, payload, status)
  }

  // 取歌元数据缓存（hash -> 完整歌曲对象），供 /kg/play 按需取链使用。
  const kgSongCache = new Map()
  const KQ_SONG_MAX = 600
  const rememberKgSongs = (songs) => {
    for (const s of songs || []) {
      if (!s || !s.hash) continue
      kgSongCache.set(s.hash, s)
    }
    while (kgSongCache.size > KQ_SONG_MAX) kgSongCache.delete(kgSongCache.keys().next().value)
  }
  const getKgSong = (hash) => kgSongCache.get(hash)

  const clearKGCookie = async () => {
    // 先加载已持久化的会话，确保能保留真实设备指纹（登出路由等调用方可能还没 load）。
    await loadKGCookie()
    // 只清登录态（token/userid/vip），保留设备指纹（guid/mid/dfid）：
    // 登出/失效后重扫仍以「老设备」身份回归，酷狗按设备指纹风控，稳定指纹比
    // 每次换新更安全。指纹在下次 login/start 时被复用（见 /kg/login/start）。
    kg.session = {
      guid: kg.session.guid || '',
      mid: kg.session.mid || '',
      dfid: kg.session.dfid && kg.session.dfid !== '-' ? kg.session.dfid : '-',
      token: '', userid: '', vip_type: '', vip_token: '',
    }
    kg.loggedIn = false; kg.isVip = null
    kgSavedAt = 0
    kgTakeCacheKg.clear()
    const file = await kgCookieFile()
    if (file !== null) { try { writeFileSync(file, JSON.stringify({ session: kg.session, loggedIn: false, savedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 }) } catch { /* ignore */ } }
  }
  // 主动续命：登录态还在但距上次刷新超过 KG_REFRESH_TTL 时，先静默调一次
  // v5/login_by_token 换新 token（社区标准 24h 一刷，留余量取 12h），让 token
  // 在过期前被续上，避免「好端端突然要重扫」。刷新失败且报设备不匹配 → token
  // 已死，自动登出并带 kgLoginDead 标记；其他失败（网络等）忽略，原请求照常。
  // ⚠️ 在途去重：TTL 到期瞬间的并发请求（取链 HEAD/GET 几乎同时到达）会各自
  // 用同一个旧 token 发两次 login_by_token——若酷狗换发新 token 时作废旧
  // token，第二发必收 20018，会把还活着的会话误判成「登录已死」清掉。这里把
  // 在途刷新的 Promise 共享给并发调用：同一时刻最多只有一次真实刷新请求。
  // 【临时观察 2026-08-30】12h 主动续命屏蔽中：观察 token 不主动刷新时能否自然
  // 存活 24h+（社区称 login_by_token 24h 一刷即可续命，但酷狗真实过期线未知）。
  // 被动路径全部保留：业务接口撞 20017/20018 仍会先静默补救刷新（kgWithFreshToken
  // 的 catch 分支），扫码登录成功后的立即换标准作用域刷新（login/check）也照旧。
  // 因此观察期的两种可能结果都可见：token 到期时若续命接口仍受理 → 播放不中断、
  // cookie 文件 token 变化（savedAt 更新）；若已死 → 面板弹「请重新扫码登录」。
  // 恢复方式：本行改为 () => true，或运行环境设 DSH_KG_PROACTIVE_REFRESH=on。
  // 注意：kg-collect 测试套件显式设 on，主动续命与在途去重逻辑仍有测试看护。
  const kgProactiveRefreshOn = () => process.env.DSH_KG_PROACTIVE_REFRESH === 'on'
  const KG_REFRESH_TTL = 12 * 60 * 60 * 1000
  let kgRefreshInFlight = null
  const maybeRefreshKgSession = async () => {
    await loadKGCookie()
    if (!kgProactiveRefreshOn()) return // 【临时观察】12h 主动续命屏蔽中，见上方注释
    if (!kg.loggedIn) return
    if (kgSavedAt > 0 && Date.now() - kgSavedAt < KG_REFRESH_TTL) return
    if (kgRefreshInFlight) return kgRefreshInFlight
    const tokenAtStart = kg.session.token
    kgRefreshInFlight = (async () => {
      try {
        const refreshed = await KG.refreshSession(kg.session)
        // 刷新期间发生了重扫/登出（token 已换）→ 本次结果作废：不回写旧 token 的
        // 刷新产物，避免覆盖刚登录的新会话。
        if (kg.session.token !== tokenAtStart) return
        if (!refreshed.token) return
        kg.session.token = refreshed.token
        kg.session.vip_type = refreshed.vip_type || kg.session.vip_type
        kg.session.vip_token = refreshed.vip_token || kg.session.vip_token
        if (refreshed.t1) kg.session.t1 = refreshed.t1
        await saveKGCookie()
      } catch (e) {
        // 同上：刷新期间已重扫 → 旧 token 的死活不再关我们的事，别误清新会话。
        if (kg.session.token !== tokenAtStart) return
        const m = String((e && e.message) || e)
        if (!KG_AUTH_DEAD_RE.test(m)) return
        await clearKGCookie()
        const dead = new Error('酷狗登录已失效（登录态与设备不匹配），请重新扫码登录')
        dead.kgLoginDead = true
        throw dead
      } finally {
        kgRefreshInFlight = null
      }
    })()
    return kgRefreshInFlight
  }

  // 取链结果短缓存（同 QQ）：同一首歌的 <audio> 加载与频谱信封两次请求命中 /kg/play，
  // 缓存保证两拿到的档位一致且省一次 tracker 往返。失败原因随 entry 带回给路由展示。
  const KQ_TAKE_TTL_MS = 5 * 60 * 1000
  const kgTake = async (song) => {
    const hit = kgTakeCacheKg.get(song.hash)
    if (hit !== undefined && Date.now() - hit.ts < KQ_TAKE_TTL_MS) return hit
    // 已有在途取链 → 复用，避免 HEAD/GET 并发各自取一次。
    const inFlight = kgTakeInFlight.get(song.hash)
    if (inFlight) return inFlight
    const p = (async () => {
      let entry
      try {
        const dl = await kgWithFreshToken(() => KG.getDownloadURL(song, kg.session))
        entry = { url: dl.url || '', quality: dl.quality || '', bitrate: dl.bitrate || 0, ts: Date.now() }
      } catch (e) {
        entry = { url: '', quality: '', bitrate: 0, err: String((e && e.message) || e), ts: Date.now() }
      }
      if (entry.url !== '') {
        kgTakeCacheKg.set(song.hash, entry)
        if (kgTakeCacheKg.size > 200) kgTakeCacheKg.delete(kgTakeCacheKg.keys().next().value)
      }
      return entry
    })()
    kgTakeInFlight.set(song.hash, p)
    try {
      return await p
    } finally {
      kgTakeInFlight.delete(song.hash)
    }
  }

  // 把歌单成员（绝对路径）解析为可播放对象；文件已删/不可读 -> null（计入 missing）。
  // 读取音频文件头解析音质（按路径缓存，曲库扫描与歌单成员共用，避免重复读盘）。
  // 返回 { codec, sampleRate, ..., label } 或 null（不可读/无法识别 → 无音质标签）。
  // MP3/FLAC 若带超大 ID3v2 标签（如内嵌大封面），真实容器/首帧会被推到 64KB 之后——
  // 一次性连续读取「标签 + 其后一段」，保证解析器的偏移与文件偏移对齐。
  const audioMetaCache = {}
  const readAudioMeta = (absPath, size) => {
    if (audioMetaCache[absPath] !== undefined) return audioMetaCache[absPath]
    let meta = null
    try {
      const fd = openSync(absPath, 'r')
      try {
        const first = Buffer.alloc(AUDIO_HEADER_LEN)
        const got = readSync(fd, first, 0, AUDIO_HEADER_LEN, 0)
        let header = first.subarray(0, got)
        if (got >= 10 && first[0] === 0x49 && first[1] === 0x44 && first[2] === 0x33) { // 'ID3'
          const tagSize = ((first[6] & 0x7f) << 21) | ((first[7] & 0x7f) << 14) | ((first[8] & 0x7f) << 7) | (first[9] & 0x7f)
          const tagEnd = 10 + tagSize + ((first[5] & 0x10) ? 10 : 0)
          if (tagEnd > got && size > 0 && tagEnd < size) {
            const want = Math.min(tagEnd + AUDIO_HEADER_LEN, size)
            const full = Buffer.alloc(want)
            const got2 = readSync(fd, full, 0, want, 0)
            header = full.subarray(0, got2)
          }
        }
        const parsed = parseAudioMeta(header, '', size)
        if (parsed) meta = { ...parsed, label: audioQualityLabel(parsed) }
      } finally { closeSync(fd) }
    } catch { /* 不可读/损坏 → 无标签 */ }
    audioMetaCache[absPath] = meta
    return meta
  }

  const resolvePlaylistMember = (path) => {
    try {
      const st = statSync(path)
      if (!st.isFile()) return null
      return {
        id: 'p:' + path,
        name: basename(path),
        url: '/dsh-music/file?path=' + encodeURIComponent(path),
        size: st.size || 0,
        path,
        quality: (readAudioMeta(path, st.size || 0) || {}).label || '',
      }
    } catch { return null }
  }
  const publicPlaylist = (p) => {
    const members = p.trackPaths.map(resolvePlaylistMember).filter(Boolean)
    return {
      id: p.id, name: p.name, fixed: p.fixed,
      count: members.length,
      missing: p.trackPaths.length - members.length,
      tracks: members,
    }
  }
  const publicPlaylists = () => playlists.map(publicPlaylist)
  // /dsh-music/file 只放行已登记路径（歌单成员 ∪ 曲库扫描集），防任意文件访问。
  const isRegisteredAudioPath = (path) => {
    const inPlaylist = playlists.some((p) => p.trackPaths.includes(path))
    const inLibrary = tracks.some((t) => t.path === path)
    return inPlaylist || inLibrary
  }
  // 找与音频同目录同名的 .lrc 歌词文件（精确匹配优先；Linux 区分大小写，
  // 大小写变体回退到目录扫描）。
  const findLrcForAudio = (audioPath) => {
    const dot = audioPath.lastIndexOf('.')
    const stem = dot > 0 ? audioPath.slice(0, dot) : audioPath
    const exact = stem + '.lrc'
    try { if (existsSync(exact) && statSync(exact).isFile()) return exact } catch { /* fallthrough */ }
    const dir = dirname(audioPath)
    const base = basename(audioPath)
    const baseStem = dot > 0 ? base.slice(0, base.lastIndexOf('.')) : base
    try {
      for (const e of readdirSync(dir)) {
        const edot = e.lastIndexOf('.')
        if (edot <= 0) continue
        if (e.slice(0, edot).toLowerCase() === baseStem.toLowerCase() && e.slice(edot + 1).toLowerCase() === 'lrc') {
          return pathJoin(dir, e)
        }
      }
    } catch { /* unreadable dir -> no lrc */ }
    return null
  }

  // ---- 内嵌歌词读取（按 track.path 缓存）----
  // 从音频文件自带的元数据标签里提取内嵌歌词（FLAC LYRICS / MP3 USLT）。读取文件
  // 前缀（含 ID3 标签与 FLAC 元数据块；带超大内嵌封面的文件把 VORBIS_COMMENT 推后，
  // 故放宽到 EMBEDDED_SCAN_LEN），用 readBufToString 兼容 UTF-8/GB 编码，命中则返回
  // 原始歌词文本，否则 null。结果按路径 + mtime 缓存，避免每次播放重复读盘解析。
  const embeddedLyricCache = {}
  const EMBEDDED_SCAN_LEN = 512 * 1024
  const readEmbeddedLyric = (absPath, size) => {
    const st = (() => { try { return statSync(absPath) } catch { return null } })()
    const mtime = st ? st.mtimeMs : 0
    const cached = embeddedLyricCache[absPath]
    if (cached !== undefined && cached.mtime === mtime) return cached.text
    let text = null
    try {
      const want = Math.min(size > 0 ? size : EMBEDDED_SCAN_LEN, EMBEDDED_SCAN_LEN)
      const fd = openSync(absPath, 'r')
      try {
        const buf = Buffer.alloc(want)
        const got = readSync(fd, buf, 0, want, 0)
        const raw = extractEmbeddedLyric(buf.subarray(0, got))
        if (raw !== null && raw.trim() !== '') text = readBufToString(Buffer.from(raw))
      } finally { closeSync(fd) }
    } catch { text = null }
    embeddedLyricCache[absPath] = { mtime, text }
    return text
  }

  // ---- 本地歌曲在线歌词兜底缓存（按 track.path，LRU + TTL）----
  // 正命中 6h、空命中 30min：避免每次播放重复打 QQ/LRCLIB；容量上限 500 条。
  const lyricOnlineCache = new Map()
  const LYRIC_ONLINE_TTL = 6 * 60 * 60 * 1000
  const LYRIC_ONLINE_TTL_EMPTY = 30 * 60 * 1000
  const LYRIC_ONLINE_MAX = 500
  const lyricOnlineCacheGet = (path) => {
    const e = lyricOnlineCache.get(path)
    if (!e) return null
    if (Date.now() - e.ts > e.ttl) { lyricOnlineCache.delete(path); return null }
    return e.payload
  }
  const lyricOnlineCacheSet = (path, payload, ttl) => {
    if (lyricOnlineCache.has(path)) lyricOnlineCache.delete(path)
    lyricOnlineCache.set(path, { ts: Date.now(), ttl, payload })
    if (lyricOnlineCache.size > LYRIC_ONLINE_MAX) {
      const k = lyricOnlineCache.keys().next().value
      if (k !== undefined) lyricOnlineCache.delete(k)
    }
  }
  // songmid → 单曲信息（数字 songID 等）缓存：QRC 接口要数字 ID。null 也缓存
  // （解析不到的 mid 不再每首都重试）；容量上限 300，超了淘汰最早写入。
  const qqMidInfoCache = new Map()
  const QQ_MID_INFO_MAX = 300

  const scan = async (rootPath, kinds = { music: true, books: false }) => {
    const target = await ctx.fs.resolve(rootPath)
    const info = await ctx.fs.stat(target)
    if (info === undefined || info.type !== 'directory') {
      throw new Error('不是有效的目录: ' + rootPath)
    }
    const rootStr = ctx.fs.processPath(target)
    const found = []
    const foundBooks = []
    const wantMusic = kinds.music
    const wantBooks = kinds.books
    const walk = async (dir, depth) => {
      if (depth > 4 || (found.length >= 500 && foundBooks.length >= 200)) return
      // Tolerant listing (all entries, see listEntries): dsh-fs-local's listDir
      // aborts on the first unreadable child, so scanning a drive root (or any
      // dir with protected entries) would silently yield zero tracks.
      const entries = listEntries(dir)
      for (const entry of entries) {
        if (found.length >= 500 && foundBooks.length >= 200) return
        const abs = pathJoin(dir, entry.name)
        try {
          if (entry.isDir) { await walk(abs, depth + 1); continue }
          if (wantMusic && isAudioName(entry.name)) {
            const st = statSync(abs)
            if (!st.isFile()) continue
            const rel = abs.startsWith(rootStr) ? abs.slice(rootStr.length + 1) : entry.name
            found.push({
              name: rel, path: abs, size: st.size || 0,
              ext: entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase(),
              quality: (readAudioMeta(abs, st.size || 0) || {}).label || '',
            })
          } else if (wantBooks && isBookName(entry.name) && foundBooks.length < 200) {
            const st = statSync(abs)
            if (!st.isFile()) continue
            const rel = abs.startsWith(rootStr) ? abs.slice(rootStr.length + 1) : entry.name
            foundBooks.push({ name: rel, path: abs, size: st.size || 0 })
          }
        } catch {
          // unreadable entry: skip it, keep walking the rest
        }
      }
    }
    await walk(rootStr, 0)
    found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    foundBooks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { rootPath: rootStr, found, foundBooks }
  }

  const refresh = async () => {
    if (musicRoot === null && bookRoot === null) {
      tracks = []; books = []
      return { root: null, bookRoot: null, tracks: [], books: [], count: 0 }
    }
    tracks = []
    books = []
    if (musicRoot !== null) {
      try {
        const { found } = await scan(musicRoot, { music: true, books: false })
        tracks = found.map((t, i) => ({
          id: String(i), name: t.name, path: t.path, size: t.size, ext: t.ext, url: '/dsh-music/' + i,
          quality: t.quality || '',
        }))
      } catch { /* keep empty */ }
    }
    if (bookRoot !== null) {
      try {
        const { foundBooks } = await scan(bookRoot, { music: false, books: true })
        books = foundBooks.map((b, i) => ({
          id: 'b' + i, name: b.name, path: b.path, size: b.size, url: '/dsh-music/book/b' + i,
        }))
      } catch { /* keep empty */ }
    }
    return { root: musicRoot, bookRoot, tracks: publicTracks(), books: publicBooks(), count: tracks.length }
  }
  const init = async () => {
    const h = await getHome()
    // Use path.join so the default root uses the platform separator; on Windows
    // a bare h + '/Music' produced a mixed "C:\Users\x/Music" root.
    let root = h === null ? null : pathJoin(h, 'Music')
    let broot = null
    const stored = await loadStoredRoot()
    // music root
    if (stored.music) {
      try {
        const target = await ctx.fs.resolve(stored.music)
        const info = await ctx.fs.stat(target)
        if (info !== undefined && info.type === 'directory') root = ctx.fs.processPath(target)
      } catch { /* keep default */ }
    }
    // book root: default to the same directory as music if none stored
    if (stored.books) {
      try {
        const target = await ctx.fs.resolve(stored.books)
        const info = await ctx.fs.stat(target)
        if (info !== undefined && info.type === 'directory') broot = ctx.fs.processPath(target)
      } catch { /* unreadable -> leave null and fall back below */ }
    }
    if (broot === null) broot = root // default books = music dir
    musicRoot = root
    bookRoot = broot
    await loadPlaylists()
    try {
      return await refresh()
    } catch (err) {
      musicRoot = null
      bookRoot = null
      tracks = []
      books = []
      return { root: null, tracks: [], books: [], count: 0, error: String((err && err.message) || err) }
    }
  }
  const ensureStarted = () => { if (startupPromise === null) startupPromise = init(); return startupPromise }

  // ---- AI 讲书：MiMo TTS（复用 DSH 模型配置）----
  // 我们复用 DSH 已配置的模型：从 ctx.llm.listProviders() 里按 xiaomi/mimo
  // 关键字过滤出一个 provider 作为 TTS 来源。key 从该 provider 的
  // apiKeyEnv（settings.yaml 里约定，其实是环境变量名）读取；也可以直接用
  // MIMO_API_KEY 环境变量 + 固定 MiMo 端点作兜底，方便未在 DSH 里配 provider 时。
  const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
  const MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts'
  // 只保留四种中文声音，默认白桦（男声）。
  const MIMO_DEFAULT_VOICE = '白桦'
  // Built-in Chinese voices for mimo-v2.5-tts (official list). Exposed to the
  // browser via /manifest so the reader can pick a voice; the chosen voice rides
  // the chunk URL.
  const MIMO_VOICES = [
    { id: '冰糖', label: '冰糖', gender: '女', lang: '中文' },
    { id: '茉莉', label: '茉莉', gender: '女', lang: '中文' },
    { id: '苏打', label: '苏打', gender: '男', lang: '中文' },
    { id: '白桦', label: '白桦', gender: '男', lang: '中文' },
  ]
  const MIMO_VOICE_IDS = new Set(MIMO_VOICES.map((v) => v.id))
  const safeVoice = (v) => (typeof v === 'string' && MIMO_VOICE_IDS.has(v) ? v : MIMO_DEFAULT_VOICE)

  const settingsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : pathJoin(base, 'settings.yaml')
  }
  const credentialsFile = async () => {
    const h = await getHome()
    const base = (process.env.DSH_HOME) || (h === null ? null : h + '/.dsh')
    return base === null ? null : pathJoin(base, '.credentials.yaml')
  }
  // Reuse the api key the user already configured in DSH. DSH stores configured
  // provider keys in ~/.dsh/.credentials.yaml keyed by the same name as
  // settings.yaml's apiKeyEnv, so read it there (falling back to a real env var).
  // Since DSH v1 the file nests keys under a refs: block (two-space indent,
  // root "version: 1"); older builds used a flat layout with keys at column 0.
  // Allow leading whitespace so both layouts resolve.
  const readCredential = async (envName) => {
    if (!envName) return null
    if (process.env[envName]) return process.env[envName]
    try {
      const file = await credentialsFile()
      if (file === null || !existsSync(file)) return null
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (const ln of lines) {
        const m = new RegExp('^\\s*' + envName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:=]\\s*(.+?)\\s*$').exec(ln)
        if (m) return m[1]
      }
      return null
    } catch { return null }
  }
  const findSettingsProvider = async (keyword) => {
    // settings.yaml -> llm-pi-ai.providers -> providers whose key mention the
    // keyword. Returns { baseURL, apiKeyEnv } or null. Handles both full
    // entries (displayName/api/baseURL/models) and slim ones that only declare
    // apiKeyEnv — many users register a TTS provider that way.
    try {
      const file = await settingsFile()
      if (file === null || !existsSync(file)) return null
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      // Locate the providers: block header.
      const provIdx = lines.findIndex((l) => /^\s{2}providers:\s*$/.test(l))
      if (provIdx < 0) return null
      // Iterate provider blocks: a 4-space-indented "<key>:" starts each one;
      // the provider keeps going until the next 4-space key or a dedent.
      let i = provIdx + 1
      while (i < lines.length) {
        const start = lines[i]
        if (!/^ {4}[A-Za-z0-9_.-]+:\s*$/.test(start)) { i++; continue }
        const id = start.trim().replace(/:$/, '')
        const block = []
        let j = i + 1
        while (j < lines.length && /^ {6}/.test(lines[j])) { block.push(lines[j]); j++ }
        if ((id + '\n' + block.join('\n')).toLowerCase().includes(keyword)) {
          for (const ln of block) {
            const am = /^\s*apiKeyEnv:\s*(\S+)\s*$/.exec(ln)
            if (am) {
              const bm = block.find((b2) => /^\s*baseURL:\s*(\S+)/.test(b2))
              const baseURL = bm ? bm.replace(/^\s*baseURL:\s*/, '').trim() : ''
              // 提供方显示名：settings.yaml 里可能声明了 displayName（完整条目）；
              // 没有则退回提供方 id。
              const dm = block.find((b2) => /^\s*displayName:\s*(.+?)\s*$/.test(b2))
              const displayName = dm ? dm.replace(/^\s*displayName:\s*/, '').replace(/^["']|["']$/g, '').trim() : ''
              return { id, displayName, baseURL, apiKeyEnv: am[1].trim() }
            }
          }
        }
        i = j
      }
      return null
    } catch { return null }
  }
  const resolveTts = async () => {
    // 1) 优先：from ctx.llm.listProviders() find xiaomi/mimo provider id
    let providerFound = false
    let providerId = null
    let providerName = ''
    try {
      const provs = (ctx.llm && typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : []) || []
      const hit = provs.find((p) => /xiaomi|mimo/i.test(String(p.id || '') + ' ' + String(p.name || '')))
      if (hit) { providerFound = true; providerId = hit.id; providerName = String(hit.name || hit.id || '') }
    } catch { /* ignore */ }
    // 2) settings.yaml provider lookup by keyword (may reveal apiKeyEnv even if
    //    listProviders doesn't list a slim provider)
    let baseURL = null
    let apiKeyEnv = null
    const sp = await findSettingsProvider('xiaomi') || await findSettingsProvider('mimo')
    if (sp) {
      providerFound = true
      providerId = providerId || sp.id
      providerName = providerName || sp.displayName || sp.id || ''
      baseURL = sp.baseURL
      apiKeyEnv = sp.apiKeyEnv
    }
    // key: from the user's DSH-configured provider credential (env var or
    // ~/.dsh/.credentials.yaml), else MIMO_API_KEY
    let key = null
    if (apiKeyEnv) key = await readCredential(apiKeyEnv)
    if (!key) key = await readCredential('MIMO_API_KEY')
    if (!baseURL) baseURL = MIMO_DEFAULT_BASE_URL
    let reason = ''
    if (key) reason = 'ok'
    else if (providerFound) reason = 'provider已配置，但未读到 ' + (apiKeyEnv || 'MIMO_API_KEY') + '的值。请在 DSH 模型设置中确认已填入xiaomi密钥。'
    else reason = '未找到xiaomi提供方。请在DSH模型设置中配置。'
    return { providerId, providerName, baseURL, apiKeyEnv, key, configured: !!key, reason }
  }
  const ttsCache = {}
  const ttsState = async () => {
    if (ttsCache.checked !== undefined) return ttsCache
    const r = await resolveTts()
    ttsCache.checked = true
    ttsCache.configured = r.configured
    ttsCache.reason = r.reason
    // 实际匹配到的提供方名称（DSH 模型配置 / settings.yaml），供「关于」页展示。
    ttsCache.provider = r.providerName || r.providerId || ''
    return ttsCache
  }

  // Synthesize a chunk of prose into a Buffer of wav audio (non-streaming, format=wav).
  const synthesize = async (text, voice) => {
    const { baseURL, key } = await resolveTts()
    if (!key) throw new Error('未配置xiaomi提供方（缺少api key）')
    const body = {
      model: MIMO_DEFAULT_MODEL,
      messages: [
        { role: 'user', content: '请用讲故事、有感情的语气朗读以下内容。' },
        { role: 'assistant', content: text },
      ],
      audio: { format: 'wav', voice: safeVoice(voice) },
      stream: false,
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    let res
    try {
      res = await fetch(baseURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': key },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if (err.name === 'AbortError') throw new Error('TTS 请求超时')
      throw err
    }
    clearTimeout(timer)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error('TTS 请求失败 ' + res.status + ' ' + detail.slice(0, 300))
    }
    const json = await res.json()
    const data = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.audio && json.choices[0].message.audio.data
    if (typeof data !== 'string') throw new Error('TTS 响应缺少音频数据')
    const buf = Buffer.from(data, 'base64')
    // Verify it is actually a playable WAVE file so the browser <audio> can
    // decode it; otherwise report a precise diagnosis instead of feeding it
    // invalid bytes. A shallow RIFF/WAVE check is NOT enough: a header-only or
    // non-PCM wav passes it and the browser then "plays" silence while the
    // reader's clock keeps advancing — the exact "没声音但时长还在走" symptom.
    // Parse the fmt + data chunks and reject degenerate files outright.
    validateWav(buf)
    // Return the MiMo audio as-is: the 24kHz source played clearly in the smoke
    // test, and our naive linear-interpolation resample to 48kHz degraded
    // intelligibility. Revisit resampling only if it becomes the confirmed cause.
    return buf
  }
  // Strict WAV sanity check: refuses to serve audio the browser would decode
  // but hear as silence/broken output. Throws with a precise message so the
  // client surfaces it (with retry) instead of playing a silent chunk.
  const validateWav = (buf) => {
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('TTS 返回的不是有效的 WAV 音频（前4字节=' + (buf.length >= 4 ? buf.toString('ascii', 0, 4) : '<空>') + '）——请改用支持 wav 的模型或检查 API 返回')
    }
    // Walk the RIFF chunks to locate fmt + data.
    let fmtFormat = -1
    let fmtRate = -1
    let fmtCh = -1
    let fmtBits = -1
    let fmtByteRate = -1
    let dataSize = -1
    let dataStart = -1
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const sz = buf.readUInt32LE(off + 4)
      if (id === 'fmt ' && sz >= 16) {
        fmtFormat = buf.readUInt16LE(off + 8)
        fmtCh = buf.readUInt16LE(off + 10)
        fmtRate = buf.readUInt32LE(off + 12)
        fmtByteRate = buf.readUInt32LE(off + 16)
        fmtBits = buf.readUInt16LE(off + 22)
      } else if (id === 'data') {
        dataSize = sz
        dataStart = off + 8 // payload begins right after the 8-byte chunk header
      }
      off += 8 + sz + (sz % 2)
      if (off > buf.length) break
    }
    const actualData = (dataSize >= 0 && dataStart >= 0) ? Math.min(dataSize, Math.max(0, buf.length - dataStart)) : 0
    const available = (dataStart >= 0) ? Math.max(0, buf.length - dataStart) : 0
    const problems = []
    if (fmtFormat !== 1) problems.push('非 PCM 格式(fmt=' + fmtFormat + ')')
    if (!(fmtRate >= 4000 && fmtRate <= 192000)) problems.push('采样率异常(' + fmtRate + 'Hz)')
    if (!(fmtCh >= 1 && fmtCh <= 8)) problems.push('声道数异常(' + fmtCh + ')')
    if (!(fmtBits === 8 || fmtBits === 16 || fmtBits === 24 || fmtBits === 32)) problems.push('位深异常(' + fmtBits + ')')
    // Byte rate must be consistent with the header, else the browser computes a
    // wildly wrong duration (duration = dataSize / byteRate) and "plays" silence
    // for the inflated remainder — the "没声音但时长差 3 分钟" symptom.
    if (fmtBits % 8 === 0 && fmtByteRate > 0 && fmtByteRate !== fmtRate * fmtCh * (fmtBits / 8)) {
      problems.push('字节率异常(byteRate=' + fmtByteRate + '，应为' + (fmtRate * fmtCh * (fmtBits / 8)) + ')')
    }
    if (dataSize < 2 || actualData < 2) problems.push('音频数据为空(data=' + dataSize + ')')
    // Truncated data chunk: declared length bigger than what's actually in the
    // buffer — same inflated-duration/silence symptom in the browser.
    if (dataSize >= 0 && dataStart >= 0 && dataSize > available) {
      problems.push('音频数据被截断(声明=' + dataSize + '，实际=' + available + ')')
    }
    // Sample-level silence detection: reject wavs whose PCM content is
    // effectively silent (all samples near zero). Real speech peaks at 1e4~3e4
    // (16-bit full scale 32767); genuine silence sits at ~0, so a low threshold
    // never rejects real speech. Early-exit on the first audible sample, so real
    // chunks are scanned almost instantly (only silent wavs scan the whole data).
    if (fmtBits === 16 && actualData >= 2 && !problems.some((p) => p.startsWith('音频数据为空') || p.startsWith('音频数据被截断'))) {
      const n = Math.floor(actualData / 2)
      let peak = 0
      for (let i = 0; i < n; i++) {
        const a = Math.abs(buf.readInt16LE(dataStart + i * 2))
        if (a > peak) peak = a
        if (peak > 200) break
      }
      if (peak <= 200) problems.push('音频内容静音(峰值=' + peak + ')')
    }
    if (problems.length > 0) {
      logTts({
        kind: 'degenerate',
        detail: problems.join('，'),
        wav: { rate: fmtRate, ch: fmtCh, bits: fmtBits, byteRate: fmtByteRate, declared: dataSize, actual: available, bytes: buf.length },
      })
      throw new Error('TTS 返回的 WAV 异常（' + problems.join('，') + '）——该段无法朗读，请重试或检查 API')
    }
  }

  // In-memory synthesized-audio cache + in-flight dedup.
  // The browser requests the same chunk URL more than once per listen (the
  // playing <audio> and the hidden preload <audio> both hit it, and replaying a
  // book hits it again), and each synthesis costs seconds-to-tens-of-seconds.
  // Caching the Buffer here turns those repeat requests into instant hits and
  // prevents two concurrent requests for the same chunk from synthesizing twice.
  // Keyed by book id + chunk index (stable within a session; deterministic
  // synthesis given a fixed voice/model makes the cache safe).
  const ttsAudioCache = new Map()
  const ttsAudioInflight = new Map()
  const MAX_TTS_CACHE_CHUNKS = 80
  // Recent TTS synthesis diagnostics (successes with timing + every failure and
  // every degenerate-wav rejection), served at /dsh-music/tts-logs so the user
  // can confirm what a "没声音但时长还在走" episode was actually caused by.
  const ttsLog = []
  const MAX_TTS_LOG = 60
  const logTts = (entry) => {
    ttsLog.push({ ts: Date.now(), ...entry })
    if (ttsLog.length > MAX_TTS_LOG) ttsLog.shift()
  }
  const synthesizeCached = async (cacheKey, text, voice) => {
    const hit = ttsAudioCache.get(cacheKey)
    if (hit !== undefined) return hit
    const inFlight = ttsAudioInflight.get(cacheKey)
    if (inFlight !== undefined) return inFlight
    const t0 = Date.now()
    const p = synthesize(text, voice)
      .then((buf) => {
        ttsAudioInflight.delete(cacheKey)
        ttsAudioCache.set(cacheKey, buf)
        if (ttsAudioCache.size > MAX_TTS_CACHE_CHUNKS) {
          const oldest = ttsAudioCache.keys().next().value
          ttsAudioCache.delete(oldest)
        }
        logTts({ kind: 'ok', key: cacheKey, ms: Date.now() - t0, bytes: buf.length, head: text.slice(0, 12) })
        return buf
      })
      .catch((err) => {
        ttsAudioInflight.delete(cacheKey)
        logTts({ kind: 'error', key: cacheKey, ms: Date.now() - t0, error: String((err && err.message) || err).slice(0, 160), head: text.slice(0, 12) })
        throw err
      })
    ttsAudioInflight.set(cacheKey, p)
    return p
  }

  const readBufToString = (buf) => {
    // Decode with the platform's built-in TextDecoder (Node ships ICU, so it
    // decodes UTF-8, UTF-16, and the GB family natively — no extra dependency).
    // Order: byte-order marks first, then strict UTF-8, then GB18030 (a superset
    // of GBK/GB2312, the encoding Windows saves Chinese .txt in by default).
    const txt = (enc, arr) => {
      try { return new TextDecoder(enc, { fatal: false }).decode(arr) } catch { return null }
    }
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return buf.subarray(3).toString('utf8') // UTF-8 with BOM
    }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return txt('utf-16le', buf.subarray(2))
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return txt('utf-16be', buf)
    // No BOM: validate strict UTF-8; only fall to GB18030 when it isn't.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      return txt('gb18030', buf) || buf.toString('utf8')
    }
  }

  // Turn a book's path into plain text (bounded to MAX_TTS_CHARS downstream).
  // Handles UTF-8 (with/without BOM), UTF-16 BOM, and GBK/GB2312/GB18030
  // (typical Windows .txt), plus EPUB (a ZIP whose spine XHTML is flattened to
  // text by readEpubBuffer). Returns { text, title, author } — the epub branch
  // carries the OPF title/author so structure meta is authoritative. The result
  // is cached per path so the (relatively expensive) epub unzip runs once per
  // session, matching the existing chunks/structure caches.
  const bookTextCache = {}
  const readBookText = (absPath) => {
    if (bookTextCache[absPath] !== undefined) return bookTextCache[absPath]
    const raw = readFileSync(absPath)
    const result = /\.epub$/i.test(absPath)
      ? readEpubBuffer(raw)
      : { text: readBufToString(raw), title: '', author: '' }
    let text = result.text
      .replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length === 0) throw new Error('该小说文件为空，无法合成')
    result.text = text
    bookTextCache[absPath] = result
    return result
  }

  // Load a book's text and split into chunks; cache per path to avoid re-reading
  // the file on every block request. Chunks are aligned so each section heading
  // starts a new chunk (structure-aware), which makes chapter jumps exact.
  const bookChunksCache = {}
  const bookStructCache = {}
  const loadBookChunks = (absPath, filenameHint) => {
    if (bookChunksCache[absPath] !== undefined) return bookChunksCache[absPath]
    const info = readBookText(absPath)
    const st = bookStructCache[absPath] !== undefined
      ? bookStructCache[absPath]
      : (bookStructCache[absPath] = parseBookStructure(info.text, filenameHint || basename(absPath), { title: info.title, author: info.author }))
    const breaks = st.sections
      .filter((s) => Number.isFinite(s.textStart) && s.textStart >= 0)
      .map((s) => ({ start: s.textStart, text: s.heading }))
    bookChunksCache[absPath] = splitBookChunks(info.text, breaks).chunks
    return bookChunksCache[absPath]
  }

  // Structure meta (title / author / section list) for a book, cached per path.
  // Each section carries a fromChunk index (which TTS chunk starts the section)
  // so the reader can jump straight to a chapter. Because every section heading
  // opens its own chunk, fromChunk is the chunk opened by that section's break —
  // exact by construction (falling back to the char-offset heuristic only if a
  // heading somehow opened no chunk).
  const bookMetaCache = {}
  const loadBookMeta = (absPath, filenameHint) => {
    if (bookMetaCache[absPath] !== undefined) return bookMetaCache[absPath]
    const info = readBookText(absPath)
    const st = bookStructCache[absPath] !== undefined
      ? bookStructCache[absPath]
      : (bookStructCache[absPath] = parseBookStructure(info.text, filenameHint, { title: info.title, author: info.author }))
    const breaks = st.sections
      .filter((s) => Number.isFinite(s.textStart) && s.textStart >= 0)
      .map((s) => ({ start: s.textStart, text: s.heading }))
    const { chunks, fromChunkOfBreak } = splitBookChunks(info.text, breaks)
    const cum = []
    let acc = 0
    for (const c of chunks) { acc += c.length; cum.push(acc) }
    // 逐块累积字符偏移：charOffsets[k] = 前 k 个块的字符数之和（charOffsets[0]=0，
    // charOffsets[total] = 全书总字符数）。浏览器端用它做「已读字符 / 全书字符」的
    // 实时进度——每块字符数已知，无需合成也能得到稳定的全书占比（时长做不到：
    // 全书总时长在合成本书之前是不可知的）。
    const charOffsets = new Array(chunks.length + 1)
    charOffsets[0] = 0
    for (let i = 0; i < chunks.length; i++) charOffsets[i + 1] = charOffsets[i] + chunks[i].length
    const upperBound = (x) => {
      let lo = 0, hi = cum.length - 1, ans = 0
      while (lo <= hi) {
        const m = (lo + hi) >> 1
        if (cum[m] <= x) { ans = m + 1; lo = m + 1 } else hi = m - 1
      }
      return Math.min(ans, Math.max(0, chunks.length - 1))
    }
    const sections = st.sections.map((s, i) => {
      const exact = Number.isInteger(fromChunkOfBreak[i]) && fromChunkOfBreak[i] >= 0 ? fromChunkOfBreak[i] : -1
      const fromChunk = exact >= 0 ? exact : upperBound(s.charStart)
      const endChunk = upperBound(s.charStart + s.charLen)
      return {
        type: s.type,
        heading: s.heading,
        fromChunk,
        chunks: Math.max(1, endChunk - fromChunk + 1),
        chars: s.chars,
        startLine: s.startLine,
      }
    })
    bookMetaCache[absPath] = {
      title: st.title, author: st.author, total: chunks.length,
      sections, charOffsets, totalChars: charOffsets[chunks.length],
    }
    return bookMetaCache[absPath]
  }

  // Tolerant directory listing for the picker and the scan. dsh-fs-local's
  // listDir is all-or-nothing: one unreadable child (pagefile.sys, System
  // Volume Information, ...) aborts the entire listing, which made drive roots
  // (and any dir containing protected entries) show up empty. Enumerate with
  // node:fs instead, skip entries that cannot be stat'd, and report every
  // entry with an isDir flag so callers can filter (picker: dirs only;
  // scan: dirs to recurse + audio files to collect).
  const listEntries = (dirPath) => {
    let dirents = []
    try { dirents = readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' }) } catch { return [] }
    const out = []
    for (const ent of dirents) {
      try {
        const isDir = ent.isDirectory() || (ent.isSymbolicLink() && statSync(pathJoin(dirPath, ent.name)).isDirectory())
        out.push({ name: ent.name, isDir })
      } catch {
        // unreadable entry (EPERM/EBUSY/...): skip it, keep listing the rest
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return out
  }

  // Breadcrumb segments for an absolute native path, ordered from the root down
  // to the deepest component. Each crumb carries its cumulative path so the
  // browser picker can jump straight to any ancestor directory (and, at the
  // root crumb, back to the filesystem root). The root itself (e.g. "/" or
  // "C:\") is the leading crumb. The sentinel drive-list view has no real path,
  // so it yields no crumbs.
  const buildCrumbs = (abs) => {
    if (!abs || abs === '__drives__') return []
    const parsed = pathParse(abs)
    const root = parsed.root || ''
    const crumbs = []
    if (root) crumbs.push({ name: root, path: root })
    const parts = []
    let d = parsed.dir
    if (d && d !== root) {
      while (d && d !== root) { parts.unshift(basename(d)); d = dirname(d) }
    }
    let cur = root
    for (const p of parts) {
      cur = cur === '' ? p : pathJoin(cur, p)
      crumbs.push({ name: p, path: cur })
    }
    if (parsed.base && parsed.base !== root) {
      cur = cur === '' ? parsed.base : pathJoin(cur, parsed.base)
      crumbs.push({ name: parsed.base, path: cur })
    }
    return crumbs
  }

  // ---- shared HTTP helpers ----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }
  // POSIX（macOS/Linux）没有盘符概念：「本机」映射到文件系统根 /。这里返回根目录
  // 的真实目录/文件列表（而非空列表）——否则点击「本机」后选择器是空死胡同，
  // 再也无法选择任何目录。供 /dsh-music/dir 与 /dsh-music/files 的 __drives__ 分支共用。
  const posixRootListing = () => {
    const dirs = []
    const files = []
    for (const e of listEntries('/')) {
      const item = { name: e.name, path: pathJoin('/', e.name) }
      if (e.isDir) dirs.push(item); else files.push(item)
    }
    return { dirs, files }
  }
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname
      // JSON API routes
      if (pathname === '/dsh-music/manifest' && req.method === 'GET') {
        await ensureStarted()
        await loadQQCookie()
        const ts = await ttsState()
        const wn = await whatsNewPayload()
        writeJson(res, {
          root: musicRoot, bookRoot, tracks: publicTracks(), books: publicBooks(), count: tracks.length,
          playlists: publicPlaylists(),
          ttsConfigured: ts.configured, ttsReason: ts.reason, ttsProvider: ts.provider || '', voices: MIMO_VOICES,
          qqLoggedIn: !!qq.cookie, qqUin: qqUin(), qqNickname: qq.nickname, qqLoginFrom: qq.loginFrom,
          kgLoggedIn: kg.loggedIn,
          version: PKG_VERSION,
          description: PKG_DESCRIPTION,
          ...wn,
        })
        return
      }
      // 手动重扫：重新遍历当前音乐/小说目录并返回最新列表（面板「刷新」按钮调用）。
      if (pathname === '/dsh-music/rescan' && req.method === 'POST') {
        await ensureStarted()
        try {
          const r = await refresh()
          const ts = await ttsState()
          const wn = await whatsNewPayload()
          writeJson(res, {
            ok: true, root: r.root, bookRoot: r.bookRoot,
            tracks: r.tracks, books: r.books, count: r.count,
            playlists: publicPlaylists(),
            ttsConfigured: ts.configured, ttsReason: ts.reason, ttsProvider: ts.provider || '', voices: MIMO_VOICES,
            qqLoggedIn: !!qq.cookie, qqUin: qqUin(), qqNickname: qq.nickname, qqLoginFrom: qq.loginFrom,
            kgLoggedIn: kg.loggedIn,
            version: PKG_VERSION,
            description: PKG_DESCRIPTION,
            ...wn,
          })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }
      // 播放偏好读写（volume/mode/voice/scope/panel-pos/playback/books-playback）。
      // GET 返回完整快照；POST 为合并语义：{ prefs: {k:v,...} } 写入，
      // { remove: [k,...] } 删除指定键。见 lib/index.js 的 serverPrefs 说明。
      if (pathname === '/dsh-music/prefs' && req.method === 'GET') {
        await loadPrefs()
        writeJson(res, { ok: true, prefs: serverPrefs })
        return
      }
      if (pathname === '/dsh-music/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        await loadPrefs()
        const patch = sanitizePrefs(body && body.prefs ? body.prefs : body)
        serverPrefs = { ...serverPrefs, ...patch }
        const remove = Array.isArray(body && body.remove)
          ? body.remove.filter((k) => typeof k === 'string' && PREF_ALLOW.has(k))
          : []
        for (const k of remove) delete serverPrefs[k]
        await savePrefs()
        writeJson(res, { ok: true, prefs: serverPrefs })
        return
      }
      if (pathname === '/dsh-music/set-root' && req.method === 'POST') {
        const body = await readBody(req)
        const rawPath = body && typeof body.path === 'string' ? body.path.trim() : ''
        if (rawPath === '') { writeJson(res, { ok: false, error: '路径不能为空' }, 400); return }
        const expanded = rawPath.startsWith('~/') ? ((await getHome()) || '') + '/' + rawPath.slice(2) : rawPath
        try {
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { ok: false, error: '目录不存在或不可读: ' + expanded }, 400)
            return
          }
          musicRoot = ctx.fs.processPath(target)
          const data = await refresh()
          await saveRoot({ root: musicRoot })
          writeJson(res, { ok: true, root: data.root, bookRoot: data.bookRoot, tracks: data.tracks, books: data.books, count: data.count })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }
      if (pathname === '/dsh-music/set-book-root' && req.method === 'POST') {
        const body = await readBody(req)
        const rawPath = body && typeof body.path === 'string' ? body.path.trim() : ''
        if (rawPath === '') { writeJson(res, { ok: false, error: '路径不能为空' }, 400); return }
        const expanded = rawPath.startsWith('~/') ? ((await getHome()) || '') + '/' + rawPath.slice(2) : rawPath
        try {
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { ok: false, error: '目录不存在或不可读: ' + expanded }, 400)
            return
          }
          bookRoot = ctx.fs.processPath(target)
          const data = await refresh()
          await saveRoot({ bookRoot })
          writeJson(res, { ok: true, root: data.root, bookRoot: data.bookRoot, tracks: data.tracks, books: data.books, count: data.count })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500)
        }
        return
      }
      // List the immediate subdirectories of a library-visible path, for the
      // browser directory picker used by the playback-list "选择音乐目录" button.
      // List the immediate subdirectories AND files of a library-visible path,
      // for the browser directory picker used by the playback-list
      // "选择音乐目录" button. Directories come first (their entries are
      // browsable); file entries are informational and not navigable. An
      // empty/missing path starts from the user's home directory.
      if (pathname === '/dsh-music/dir' && req.method === 'GET') {
        await ensureStarted()
        const raw = url.searchParams.get('path') || ''
        try {
          // Windows has no single root that lists every drive, so expose a
          // sentinel ("__drives__") that enumerates the available drive roots.
          // Browsing "up" from a drive root (e.g. C:\) lands here so users can
          // switch to another drive.
          if (raw === '__drives__') {
            const isWin = typeof process !== 'undefined' && process.platform === 'win32'
            if (isWin) {
              const roots = []
              for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
                const root = letter + ':\\'
                try { if (existsSync(root)) roots.push({ name: root, path: root }) } catch {}
              }
              writeJson(res, { path: '__drives__', name: '本机磁盘', up: null, dirs: roots, files: [], crumbs: [] })
            } else {
              // POSIX：本机 = 根 /，返回真实列表（可继续往下浏览，不是空死胡同）。
              const rl = posixRootListing()
              writeJson(res, { path: '/', name: '/', up: null, dirs: rl.dirs, files: rl.files, crumbs: buildCrumbs('/') })
            }
            return
          }
          const base = raw === '' ? ((await getHome()) || '/') : raw
          const expanded = base.startsWith('~/') ? ((await getHome()) || '') + '/' + base.slice(2) : base
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { error: '目录不存在或不可读', path: expanded }, 400)
            return
          }
          const abs = ctx.fs.processPath(target)
          // Parent / name computation must use the host filesystem's separators
          // (Windows uses "\" and drive roots like C:\, POSIX uses "/"), so do it
          // with node:path rather than guessing a separator in the browser.
          const atRoot = pathParse(abs).dir === abs
          // On Windows, "up" from a drive root goes to the drive-list sentinel so
          // users can switch drives; at the POSIX root there is nowhere to go.
          const up = atRoot
            ? (process.platform === 'win32' ? '__drives__' : null)
            : dirname(abs)
          // Tolerant listing (see listEntries): skip unreadable entries so
          // drive roots like C:\ still show their normal folders instead of an
          // empty list. Directories are offered by the picker (browsable);
          // plain files are listed after them purely as context (not navigable).
          const dirs = []
          const files = []
          for (const e of listEntries(abs)) {
            const item = { name: e.name, path: pathJoin(abs, e.name) }
            if (e.isDir) dirs.push(item); else files.push(item)
          }
          writeJson(res, { path: abs, name: basename(abs) || abs, up, dirs, files, crumbs: buildCrumbs(abs) })
        } catch (err) {
          writeJson(res, { error: String((err && err.message) || err) }, 500)
        }
        return
      }
      if (pathname === '/dsh-music/intent' && req.method === 'GET') {
        const it = pendingIntent
        pendingIntent = null
        // 带 ts 的意图（新闻播报定时/静默场景）有时效：浏览器没开时 intent 会滞留数小时，
        // 若不过期，用户几天后打开页面会突然自动播放旧简报。过期意图直接丢弃——
        // 期次本身已持久化（「待播」徽标回看），宁缺毋扰。音乐/讲书意图不带 ts，行为不变。
        if (it && typeof it.ts === 'number' && Date.now() - it.ts > 120 * 1000) {
          writeJson(res, null)
          return
        }
        writeJson(res, it || null)
        return
      }
      // ---- 每日新闻播报路由（与 /dsh-music/book/* 同构的懒合成播放管线）----
      //   GET    /dsh-music/news                -> 期次列表（第一层列表数据源）
      //   GET    /dsh-music/news/<id>/meta      -> { total, sections, charOffsets, itemChunk, ... }
      //   GET    /dsh-music/news/<id>/text?from=n -> 第 n 块字幕文本
      //   GET    /dsh-music/news/<id>?from=n&voice= -> 第 n 块 WAV（懒合成 + 缓存）
      //   DELETE /dsh-music/news/<id>           -> 删除某期（并销毁其对应的执行会话）
      //   POST   /dsh-music/news/play {id}      -> 推送播放（面板按钮）
      //   POST   /dsh-music/news/played {id}    -> 标记已播（清除「待播」徽标）
      //   GET    /dsh-music/news/runstate       -> 当前收集运行态（runCollection 设置，broadcast/reportFailure 清除）
      //   GET/POST /dsh-music/news/schedule     -> 定时偏好读写（面板定时规则编辑器；保存即重建 Host 定时器）
      //   POST   /dsh-music/news/run-now {shiftId} -> 立即执行（统一走 runCollection，新建执行会话）
      //   POST   /dsh-music/news/purge-stale    -> 每日 03:00 清理同一入口：删除今天之前的期次/失败记录并归档会话
      //   GET    /dsh-music/news/models         -> 可用 provider/model（新闻采集模型选择器）
      if (pathname === '/dsh-music/news' && req.method === 'GET') {
        await loadNews()
        // 最新期次排最前（createdAt 降序）：面板列表按返回序直接渲染，最新的在最上面。
        const editions = [...news.editions].sort((a, b) => b.createdAt - a.createdAt)
        writeJson(res, { ok: true, editions: editions.map(summarizeEdition) })
        return
      }
      if (pathname === '/dsh-music/news/runstate' && req.method === 'GET') {
        await loadNews()
        const alive = runStateAlive(news.runState, Date.now())
        writeJson(res, { ok: true, run: alive ? news.runState : null })
        return
      }
      // 供面板「新闻采集模型」选择器：列出可用 provider 及各 provider 的模型。
      // 依赖 ctx.llm 服务（懒获取）：缺失时返回空列表，选择器隐藏/降级为「跟随当前会话」。
      if (pathname === '/dsh-music/news/models' && req.method === 'GET') {
        const llm = ctx.get ? ctx.get('llm') : null
        let providers = []
        if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
          const list = []
          try {
            for (const p of llm.listProviders()) {
              let models = []
              try {
                models = (await llm.listModels(p.id)).map((m) => ({ id: m.id, name: m.name || m.id }))
              } catch {
                models = []
              }
              list.push({ id: p.id, name: p.name || p.id, models })
            }
          } catch {
            list.length = 0
          }
          providers = list
        }
        writeJson(res, { ok: true, providers })
        return
      }
      if (pathname === '/dsh-music/news/schedule' && (req.method === 'GET' || req.method === 'POST')) {
        await loadNews()
        if (req.method === 'GET') {
          writeJson(res, { ok: true, schedulePrefs: news.schedulePrefs, failures: news.failures.slice(-10) })
          return
        }
        const body = await readBody(req)
        const patch = body && typeof body.schedulePrefs === 'object' ? body.schedulePrefs : body
        const prev = news.schedulePrefs
        const next = sanitizeSchedulePrefs(patch || {}, prev)
        // 内容有实质变化才递增版本号（纯 GET 后重复 POST 不制造「未同步」噪音）。
        const changed = JSON.stringify({ e: next.enabled, s: next.shifts })
          !== JSON.stringify({ e: prev.enabled, s: prev.shifts })
        next.prefVersion = changed ? (prev.prefVersion || 0) + 1 : prev.prefVersion
        next.syncedVersion = changed ? Math.min(prev.syncedVersion, next.prefVersion - 1) : prev.syncedVersion
        news.schedulePrefs = next
        await saveNews()
        void rebuildTimer() // 保存即生效：按新偏好重建 Host 定时器
        writeJson(res, { ok: true, schedulePrefs: next, changed })
        return
      }
      // 清除收集失败记录（面板失败提示行「✕」）：清空后 GET 不再返回失败，提示消失。
      // 与「收集成功自动清空」互补——用户看完/解决后手动点掉，无需等下一次收集。
      if (pathname === '/dsh-music/news/failures/clear' && req.method === 'POST') {
        await loadNews()
        const cleared = news.failures.length
        if (cleared > 0) { news.failures = []; await saveNews() }
        writeJson(res, { ok: true, cleared })
        return
      }
      // 立即执行班次：走统一执行入口 runCollection（新建执行会话并注入指令，不等时刻）。
      if (pathname === '/dsh-music/news/run-now' && req.method === 'POST') {
        await loadNews()
        const body = await readBody(req)
        const shift = (news.schedulePrefs.shifts || []).find((x) => x.id === (body && body.shiftId))
        if (!shift) { writeJson(res, { ok: false, error: '班次不存在' }, 404); return }
        const r = await runCollection(shift.id)
        if (!r.ok) { writeJson(res, { ok: false, busy: Boolean(r.busy), fallback: !r.busy, error: r.error }); return }
        writeJson(res, { ok: true, sessionId: r.sessionId })
        return
      }
      // 手动触发每日清理（与 03:00 定时任务同一入口）：删除今天 00:00 之前的期次与失败记录，
      // 并联动销毁/归档其执行会话。按 createdAt 幂等，重复调用无副作用（诊断/测试用）。
      if (pathname === '/dsh-music/news/purge-stale' && req.method === 'POST') {
        await loadNews() // 先吸收磁盘最新状态，再在内存态上执行清理
        const r = await purgeStaleNews()
        writeJson(res, { ok: true, ...r })
        return
      }
      if (pathname === '/dsh-music/news/play' && req.method === 'POST') {
        await loadNews()
        const body = await readBody(req)
        const hit = news.editions.find((e) => e.id === (body && body.id))
        if (!hit) { writeJson(res, { ok: false, error: '期次不存在' }, 404); return }
        pendingIntent = { action: 'play', kind: 'news', id: hit.id, name: hit.title, ts: Date.now() }
        writeJson(res, { ok: true, editionId: hit.id })
        return
      }
      if (pathname === '/dsh-music/news/played' && req.method === 'POST') {
        await loadNews()
        const body = await readBody(req)
        const hit = news.editions.find((e) => e.id === (body && body.id))
        if (hit && !hit.played) { hit.played = true; await saveNews() }
        writeJson(res, { ok: true })
        return
      }
      if (pathname.startsWith('/dsh-music/news/')) {
        const rest = pathname.slice('/dsh-music/news/'.length)
        const isMeta = rest.endsWith('/meta')
        const isText = rest.endsWith('/text')
        const id = isMeta ? rest.slice(0, -'/meta'.length) : isText ? rest.slice(0, -'/text'.length) : rest
        if (id === '') { writeJson(res, { ok: false, error: '缺少期次 id' }, 400); return }
        if (req.method === 'DELETE') {
          await loadNews()
          const hit = news.editions.find((e) => e.id === id)
          const before = news.editions.length
          news.editions = news.editions.filter((e) => e.id !== id)
          const removed = news.editions.length < before
          if (removed) {
            // 删除联动：销毁该期次对应的执行会话（本进程句柄优先，跨重启走 resume→dispose 兜底），并清映射。
            await disposeExecutionSession(hit && hit.sessionId)
            await saveNews()
          }
          writeJson(res, { ok: removed, error: removed ? undefined : '期次不存在' }, removed ? 200 : 404)
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
        await loadNews()
        const edition = news.editions.find((e) => e.id === id)
        if (!edition) { writeJson(res, { ok: false, error: '期次不存在' }, 404); return }
        if (isMeta) {
          writeJson(res, { ok: true, ...metaForEdition(edition) })
          return
        }
        const fromParam = new URL(req.url || '/', 'http://x').searchParams.get('from')
        const from = Number.isFinite(parseInt(fromParam, 10)) ? Math.max(0, parseInt(fromParam, 10)) : 0
        if (isText) {
          if (from >= edition.chunks.length) { writeJson(res, { ok: false, error: '期次结束' }); return }
          writeJson(res, { ok: true, from, text: edition.chunks[from] })
          return
        }
        if (from >= edition.chunks.length) {
          res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('期次结束')
          return
        }
        try {
          const voice = (new URL(req.url || '/', 'http://x').searchParams.get('voice') || '').trim() || undefined
          const voiceKey = voice || 'default'
          const wav = await synthesizeCached('news:' + id + ':' + from + ':' + voiceKey, edition.chunks[from], voice)
          res.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Content-Length': String(wav.length),
            'Cache-Control': 'public, max-age=3600',
          })
          if (req.method === 'GET') res.end(wav)
          else res.end()
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String((err && err.message) || err))
        }
        return
      }
      // TTS 合成诊断日志（最近 60 条，含每次失败/退化 WAV），便于排查
      // 「没声音但时长继续走」等异常。
      if (pathname === '/dsh-music/tts-logs' && req.method === 'GET') {
        writeJson(res, { logs: ttsLog.slice() })
        return
      }
      // AI 讲书：一本书的元信息（总块数）或某个块的 wav。
      //   GET /dsh-music/book/<id>/meta  -> { id, name, total, size }  (JSON)
      //   GET /dsh-music/book/<id>?from=n -> chunk n as wav audio
      if (pathname.startsWith('/dsh-music/book/') && (req.method === 'GET' || req.method === 'HEAD')) {
        await ensureStarted()
        const rest = pathname.slice('/dsh-music/book/'.length) // "<id>", "<id>/meta" or "<id>/text"
        const isMeta = rest.endsWith('/meta')
        const isText = rest.endsWith('/text')
        const id = isMeta ? rest.slice(0, -'/meta'.length) : isText ? rest.slice(0, -'/text'.length) : rest
        const book = books.find((b) => b.id === id)
        if (book === undefined) { res.writeHead(404); res.end(); return }
        try {
          // book.path is an absolute native path string; read directly with node:fs.
          // Do NOT run it through ctx.fs.resolve() (DSH's fs returns a non-string
          // descriptor, which native readFileSync rejects).
          const chunks = loadBookChunks(book.path, book.name)
          if (isMeta) {
            // Structure meta (title/author/sections) is computed once and cached;
            // total is the authoritative chunk count from loadBookChunks.
            const meta = loadBookMeta(book.path, book.name)
            writeJson(res, {
              id, name: book.name, size: book.size,
              total: chunks.length,
              title: meta.title, author: meta.author, sections: meta.sections,
              // 逐块累积字符偏移 + 全书总字符：浏览器端据此算「已读字符/全书字符」
              // 的实时进度条（见 check-book progress）。
              charOffsets: meta.charOffsets, totalChars: meta.totalChars,
            })
            return
          }
          const fromParam = url.searchParams.get('from')
          const from = fromParam !== null ? parseInt(fromParam, 10) : 0
          const idx = Number.isFinite(from) && from >= 0 ? from : 0
          if (isText) {
            // 实时字幕：直接返回该块的纯文本（不合成音频），供播放条逐句滚动。
            if (idx >= chunks.length) { writeJson(res, { ok: false, error: '章节结束' }); return }
            writeJson(res, { ok: true, from: idx, text: chunks[idx] })
            return
          }
          if (idx >= chunks.length) { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('章节结束'); return }
          // The voice rides the chunk URL (?voice=...); it is part of the cache
          // key so switching voices re-synthesizes instead of replaying stale audio.
          const voice = safeVoice(url.searchParams.get('voice'))
          // synthesizeCached dedupes the play + preload requests for the same
          // chunk (and makes replays instant) instead of re-running TTS.
          const wav = await synthesizeCached(book.id + ':' + idx + ':' + voice, chunks[idx], voice)
          const headers = {
            'Content-Type': 'audio/wav',
            'Content-Length': String(wav.length),
            // Cacheable so the hidden preload <audio> actually warms the browser
            // cache and the following chunk switch is near-instant (a no-store
            // header was defeating the double-buffering preload entirely).
            'Cache-Control': 'public, max-age=3600',
          }
          res.writeHead(200, headers)
          if (req.method === 'GET') res.end(wav)
          else res.end()
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String((err && err.message) || err))
        }
        return
      }
      // ---- 自建歌单 CRUD ----
      // POST /dsh-music/playlist {name} -> 新建
      if (pathname === '/dsh-music/playlist' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const name = body && typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') { writeJson(res, { ok: false, error: '歌单名不能为空' }, 400); return }
        const id = 'pl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
        playlists.push({ id, name, fixed: false, trackPaths: [], createdAt: Date.now(), updatedAt: Date.now() })
        await savePlaylists()
        writeJson(res, { ok: true, playlist: publicPlaylist(findPlaylist(id)) })
        return
      }
      // POST /dsh-music/playlist/rename {id,name}
      if (pathname === '/dsh-music/playlist/rename' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const name = body && typeof body.name === 'string' ? body.name.trim() : ''
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        if (name === '') { writeJson(res, { ok: false, error: '歌单名不能为空' }, 400); return }
        if (pl.fixed) { writeJson(res, { ok: false, error: '系统默认歌单不可重命名' }, 400); return }
        pl.name = name
        pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music/playlist/delete {id}
      if (pathname === '/dsh-music/playlist/delete' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const id = body && typeof body.id === 'string' ? body.id : ''
        const idx = playlists.findIndex((p) => p.id === id)
        if (idx < 0) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        if (playlists[idx].fixed) { writeJson(res, { ok: false, error: '系统默认歌单不可删除' }, 400); return }
        playlists.splice(idx, 1)
        await savePlaylists()
        writeJson(res, { ok: true })
        return
      }
      // POST /dsh-music/playlist/add {id,paths:[...]}（去重、保序追加、跳过无效/非音频）
      if (pathname === '/dsh-music/playlist/add' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const paths = Array.isArray(body && body.paths)
          ? body.paths.filter((x) => typeof x === 'string' && x.trim() !== '')
          : []
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        let added = 0
        for (const raw of paths) {
          const p = raw.trim()
          if (!isAudioName(p) || pl.trackPaths.includes(p)) continue
          try { const st = statSync(p); if (!st.isFile()) continue } catch { continue }
          pl.trackPaths.push(p)
          added++
        }
        if (added > 0) pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, added, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music/playlist/remove {id,paths:[...]}
      if (pathname === '/dsh-music/playlist/remove' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const paths = new Set(Array.isArray(body && body.paths) ? body.paths : [])
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        const before = pl.trackPaths.length
        pl.trackPaths = pl.trackPaths.filter((p) => !paths.has(p))
        if (pl.trackPaths.length !== before) pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, removed: before - pl.trackPaths.length, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music/playlist/clear {id}（一键清空：移出全部歌曲，含已失效；任何歌单都允许，fixed 也可清空）
      if (pathname === '/dsh-music/playlist/clear' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        const cleared = pl.trackPaths.length
        pl.trackPaths = []
        pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, cleared, playlist: publicPlaylist(pl) })
        return
      }
      // POST /dsh-music/playlist/reorder {id,paths:[...]}（全量顺序替换，补回未提及的旧成员）
      if (pathname === '/dsh-music/playlist/reorder' && req.method === 'POST') {
        await ensureStarted()
        const body = await readBody(req)
        const pl = findPlaylist(body && typeof body.id === 'string' ? body.id : '')
        const paths = Array.isArray(body && body.paths) ? body.paths.filter((x) => typeof x === 'string') : []
        if (pl === null) { writeJson(res, { ok: false, error: '歌单不存在' }, 404); return }
        const current = new Set(pl.trackPaths)
        const reordered = paths.filter((p) => current.has(p))
        for (const p of pl.trackPaths) if (!reordered.includes(p)) reordered.push(p)
        pl.trackPaths = reordered
        pl.updatedAt = Date.now()
        await savePlaylists()
        writeJson(res, { ok: true, playlist: publicPlaylist(pl) })
        return
      }
      // ---- 文件系统多选器：列目录 + 音频文件（歌单「添加歌曲」用）----
      // 与 /dsh-music/dir 相同的浏览体验（上级/跨盘符），但额外返回音频文件供多选勾选。
      if (pathname === '/dsh-music/files' && req.method === 'GET') {
        await ensureStarted()
        const raw = url.searchParams.get('path') || ''
        try {
          if (raw === '__drives__') {
            const isWin = typeof process !== 'undefined' && process.platform === 'win32'
            if (isWin) {
              const roots = []
              for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
                const root = letter + ':\\'
                try { if (existsSync(root)) roots.push({ name: root, path: root }) } catch {}
              }
              writeJson(res, { path: '__drives__', name: '本机磁盘', up: null, dirs: roots, files: [], crumbs: [] })
            } else {
              // POSIX：本机 = 根 /，返回真实列表（可继续往下浏览，不是空死胡同）。
              const rl = posixRootListing()
              writeJson(res, { path: '/', name: '/', up: null, dirs: rl.dirs, files: rl.files, crumbs: buildCrumbs('/') })
            }
            return
          }
          const base = raw === '' ? ((await getHome()) || '/') : raw
          const expanded = base.startsWith('~/') ? ((await getHome()) || '') + '/' + base.slice(2) : base
          const target = await ctx.fs.resolve(expanded)
          const info = await ctx.fs.stat(target)
          if (info === undefined || info.type !== 'directory') {
            writeJson(res, { error: '目录不存在或不可读', path: expanded }, 400)
            return
          }
          const abs = ctx.fs.processPath(target)
          const atRoot = pathParse(abs).dir === abs
          const up = atRoot ? (process.platform === 'win32' ? '__drives__' : null) : dirname(abs)
          const dirs = []
          const files = []
          for (const e of listEntries(abs)) {
            try {
              if (e.isDir) { dirs.push({ name: e.name, path: pathJoin(abs, e.name) }); continue }
              if (isAudioName(e.name)) {
                const st = statSync(pathJoin(abs, e.name))
                if (st.isFile()) {
                  files.push({ name: e.name, path: pathJoin(abs, e.name), size: st.size || 0, ext: e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase() })
                }
              }
            } catch { /* skip unreadable entries */ }
          }
          writeJson(res, { path: abs, name: basename(abs) || abs, up, dirs, files, crumbs: buildCrumbs(abs) })
        } catch (err) {
          writeJson(res, { error: String((err && err.message) || err) }, 500)
        }
        return
      }
      // ---- 在线 QQ 音乐：登录 / 状态 / 搜索 / 播放（登录可用高音质） ----
      // 扫码登录仅存 Host 端 cookie；浏览器经 /dsh-music/qq/play/<songmid> 同源代理流播，
      // 规避 music.qq.com 对浏览器直接跨域/防盗链的限制（与本地 /file 路由同一模式）。
      if (pathname === '/dsh-music/qq/status' && req.method === 'GET') {
        await loadQQCookie()
        writeJson(res, { loggedIn: !!qq.cookie, uin: qqUin(), nickname: qq.nickname, loginFrom: qq.loginFrom })
        return
      }
      if (pathname === '/dsh-music/qq/login/start' && req.method === 'POST') {
        const body = await readBody(req)
        const mode = body && body.mode === 'qq' ? 'qq' : 'wx'
        try {
          const session = mode === 'qq' ? await QQ.createQRLogin() : await QQ.createWXQRLogin()
          qqLoginSession = { key: session.key, mode, expiresAt: session.expiresAt, imageDataUrl: session.imageDataUrl }
          writeJson(res, { ok: true, key: session.key, image: session.imageDataUrl, mode, expiresAt: session.expiresAt })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      if (pathname === '/dsh-music/qq/login/check' && req.method === 'GET') {
        const key = url.searchParams.get('key') || ''
        if (key === '') { writeJson(res, { ok: false, error: 'missing key' }, 400); return }
        try {
          const isWx = /(?:^|&)type=wx(?:&|$)/.test(key)
          const result = isWx ? await QQ.checkWXQRLogin(key) : await QQ.checkQRLogin(key)
          if (result.status === 'success') {
            qq.cookie = result.cookie || ''
            qq.isVip = null
            clearQQTakeCache()
            qq.nickname = (result.extra && result.extra.nickname) || qq.nickname || ''
            qq.loginFrom = isWx ? 'wx' : 'qq'
            await saveQQCookie()
            writeJson(res, { ok: true, status: 'success', loggedIn: !!qq.cookie, uin: qqUin(), nickname: qq.nickname, loginFrom: isWx ? 'wx' : 'qq', message: result.message, extra: result.extra })
          } else {
            writeJson(res, { ok: true, status: result.status, message: result.message, extra: result.extra })
          }
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      if (pathname === '/dsh-music/qq/login/logout' && req.method === 'POST') {
        await clearQQCookie()
        writeJson(res, { ok: true, loggedIn: false })
        return
      }
      if (pathname === '/dsh-music/qq/search' && req.method === 'GET') {
        const w = (url.searchParams.get('w') || '').trim()
        if (w === '') { writeJson(res, { ok: false, error: 'missing query' }, 400); return }
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        await loadQQCookie()
        try {
          const isVip = await refreshQQVip()
          const s = await QQ.search(w, qq.cookie, page)
          writeJson(res, { ok: true, isVip, results: s.results, total: s.total, page: s.page })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      if (pathname.startsWith('/dsh-music/qq/play/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const songmid = decodeURIComponent(pathname.slice('/dsh-music/qq/play/'.length))
        if (!/^[A-Za-z0-9]+$/.test(songmid)) { res.writeHead(400); res.end(); return }
        await loadQQCookie()
        try {
          const dl = await qqTake(songmid)
          if (!dl.url) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('无法获取播放地址（可能是 VIP 或版权限制）')
            return
          }
          const upHeaders = { 'User-Agent': QQ_USER_AGENT, 'Referer': 'http://y.qq.com' }
          if (typeof req.headers.range === 'string') upHeaders['Range'] = req.headers.range
          const stream = await fetch(dl.url, { headers: upHeaders })
          const headers = {
            'Content-Type': stream.headers.get('content-type') || 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          }
          // 真实品质：把服务端授予的档位（取链 filename）随播放流回传，播放条据此显示
          // 「QQ音乐 · 无损/高音质/标准」。无标签时不带该头，播放条只显示「QQ音乐」。
          // 注意：Node 的 writeHead 拒绝非 ASCII（CJK）响应头值，中文标签必须
          // percent-encode 成纯 ASCII 再下发，客户端读取时 decodeURIComponent 还原。
          if (dl.quality) headers['X-DSH-QQ-Quality'] = encodeURIComponent(dl.quality)
          const cr = stream.headers.get('content-range'); if (cr) headers['Content-Range'] = cr
          const cl = stream.headers.get('content-length'); if (cl) headers['Content-Length'] = cl
          res.writeHead(stream.status, headers)
          if (req.method === 'HEAD') { res.end(); return }
          if (stream.body) { for await (const chunk of stream.body) res.write(chunk) }
          res.end()
        } catch (err) {
          try { res.writeHead(500); res.end() } catch { /* ignore */ }
        }
        return
      }
      // ---- 在线 QQ 歌单：推荐 / 分类 / 分类歌单 / 歌单搜索 / 歌单歌曲 ----
      if (pathname === '/dsh-music/qq/playlist-categories' && req.method === 'GET') {
        await loadQQCookie()
        try { writeJson(res, { ok: true, categories: await QQ.getPlaylistCategories(qq.cookie) }) }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/qq/playlist-search' && req.method === 'GET') {
        const w = (url.searchParams.get('w') || '').trim()
        if (w === '') { writeJson(res, { ok: false, error: 'missing query' }, 400); return }
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        await loadQQCookie()
        try {
          const s = await QQ.searchPlaylist(w, qq.cookie, page)
          writeJson(res, { ok: true, playlists: s.results, total: s.total, page: s.page })
        }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/qq/playlists' && req.method === 'GET') {
        const category = (url.searchParams.get('category') || '').trim()
        await loadQQCookie()
        try {
          if (category === '') writeJson(res, { ok: true, playlists: await QQ.getRecommendedPlaylists(qq.cookie) })
          else {
            const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
            writeJson(res, { ok: true, playlists: await QQ.getCategoryPlaylists(category, page, 20, qq.cookie) })
          }
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/qq/my-playlists' && req.method === 'GET') {
        await loadQQCookie()
        try { writeJson(res, { ok: true, playlists: await QQ.getMyPlaylists(qq.cookie), uin: qqUin() }) }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // 收藏/取消收藏在线 QQ 歌曲到「我喜欢」（dirId=201）。
      if (pathname === '/dsh-music/qq/fav' && req.method === 'POST') {
        const body = await readBody(req)
        const action = body && body.action === 'remove' ? 'remove' : 'add'
        const song = (body && body.song) || {}
        await loadQQCookie()
        try {
          const ok = action === 'remove'
            ? await QQ.removeQQFav(song, qq.cookie)
            : await QQ.addQQFav(song, qq.cookie)
          writeJson(res, { ok, faved: action === 'add' ? ok : !ok })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // 把在线歌曲加入某个自建歌单（dirId/tid 取自我的歌单）。
      if (pathname === '/dsh-music/qq/playlist-add' && req.method === 'POST') {
        const body = await readBody(req)
        const song = (body && body.song) || {}
        const dirId = Number((body && body.dirId)) || 0
        const tid = Number((body && body.tid)) || 0
        await loadQQCookie()
        try {
          const ok = await QQ.addSongToPlaylist(song, dirId, tid, qq.cookie)
          writeJson(res, { ok })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // 从歌单移除歌曲（DelSonglist）；「我喜欢」也是 dirId=201，同在列。
      if (pathname === '/dsh-music/qq/playlist-remove' && req.method === 'POST') {
        const body = await readBody(req)
        const song = (body && body.song) || {}
        const dirId = Number((body && body.dirId)) || 0
        const tid = Number((body && body.tid)) || 0
        await loadQQCookie()
        try {
          const ok = await QQ.deleteSongFromPlaylist(song, dirId, tid, qq.cookie)
          writeJson(res, { ok })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // 创建自建歌单（DirCreate），返回新歌单 id/name。
      if (pathname === '/dsh-music/qq/playlist-create' && req.method === 'POST') {
        const body = await readBody(req)
        const name = String((body && body.name) || '').trim()
        if (name === '') { writeJson(res, { ok: false, error: '歌单名不能为空' }, 400); return }
        await loadQQCookie()
        try {
          const created = await QQ.createPlaylist(name, qq.cookie)
          writeJson(res, { ok: true, playlist: created })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // 删除自建歌单（DelPlaylist / PlaylistBaseWrite）。仅限本人创建的歌单；「我喜欢」不可删。
      if (pathname === '/dsh-music/qq/playlist-delete' && req.method === 'POST') {
        const body = await readBody(req)
        const dirId = Number((body && body.dirId)) || 0
        if (!dirId) { writeJson(res, { ok: false, error: '缺少歌单 dirId' }, 400); return }
        await loadQQCookie()
        try {
          const ok = await QQ.deletePlaylist(dirId, qq.cookie)
          writeJson(res, { ok })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // 获取「我喜欢」已收藏歌曲的 songid + songmid 列表（供播放时判断当前曲目是否已收藏）。
      if (pathname === '/dsh-music/qq/liked' && req.method === 'GET') {
        await loadQQCookie()
        try {
          const fav = await QQ.getQQFavIds(qq.cookie)
          writeJson(res, { ok: true, ids: (fav && fav.ids) || [], mids: (fav && fav.mids) || [] })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname.startsWith('/dsh-music/qq/playlist/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/dsh-music/qq/playlist/'.length))
        if (id === '' || !/^[0-9A-Za-z:]+$/.test(id)) { writeJson(res, { ok: false, error: 'bad id' }, 400); return }
        await loadQQCookie()
        try {
          const detail = await QQ.getPlaylistSongs(id, qq.cookie)
          writeJson(res, { ok: true, playlist: detail })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 404) }
        return
      }
      // ---- 在线 QQ 发现：排行榜 / 新歌速递（均匿名可用）----
      if (pathname === '/dsh-music/qq/top-lists' && req.method === 'GET') {
        await loadQQCookie()
        try { writeJson(res, { ok: true, groups: await QQ.getTopLists(qq.cookie) }) }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/qq/top-songs' && req.method === 'GET') {
        const topId = (url.searchParams.get('topId') || '').trim()
        if (!/^[0-9]+$/.test(topId)) { writeJson(res, { ok: false, error: 'bad topId' }, 400); return }
        const offset = parseInt(url.searchParams.get('offset') || '0', 10)
        const num = parseInt(url.searchParams.get('num') || '30', 10)
        await loadQQCookie()
        try { writeJson(res, { ok: true, toplist: await QQ.getTopListSongs(topId, qq.cookie, Number.isFinite(offset) ? offset : 0, Number.isFinite(num) ? num : 30) }) }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/qq/new-songs' && req.method === 'GET') {
        const type = parseInt(url.searchParams.get('type') || '5', 10)
        await loadQQCookie()
        try { writeJson(res, { ok: true, result: await QQ.getNewSongs(Number.isFinite(type) ? type : 5, qq.cookie) }) }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // ---- 在线 QQ 歌词（匿名取词，parseLrc 解析 + 可选逐句翻译 trans）----
      if (pathname === '/dsh-music/qq/lyric' && req.method === 'GET') {
        const songmid = (url.searchParams.get('songmid') || '').trim()
        if (songmid === '' || !/^[0-9A-Za-z_-]+$/.test(songmid)) { writeJson(res, { ok: false, error: 'bad songmid' }, 400); return }
        await loadQQCookie()
        // —— QRC 逐字歌词优先：songmid → 数字 songID（单曲详情端点，会话内缓存）→
        // GetPlayLyricInfo。任何失败静默回落普通 LRC；qrc_t=0（该曲无逐字数据）也回落。
        try {
          let info = qqMidInfoCache.get(songmid)
          if (info === undefined) {
            try {
              info = await QQ.getSongInfoByMid(songmid, qq.cookie)
            } catch { info = null } // 解析不到数字 ID：记住 null，不再每首都重试
            qqMidInfoCache.set(songmid, info)
            if (qqMidInfoCache.size > QQ_MID_INFO_MAX) {
              const k = qqMidInfoCache.keys().next().value
              if (k !== undefined) qqMidInfoCache.delete(k)
            }
          }
          if (info) {
            const q = await QQ.getQrcLyric(info, qq.cookie)
            if (q !== null && Array.isArray(q.lines) && q.lines.length > 0) {
              writeJson(res, { ok: true, hasLyric: true, source: 'qq-qrc', wordLines: q.lines })
              return
            }
          }
        } catch { /* QRC 失败 → 普通 LRC 兜底 */ }
        try {
          const { lyric, trans } = await QQ.getLyric(songmid, qq.cookie)
          const lrc = parseLrc(lyric)
          writeJson(res, { ok: true, hasLyric: lrc.length > 0, lrc, trans: parseLrc(trans) })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // ===================== 在线酷狗音乐（/dsh-music/kg/*）=====================
      // 登录态 / 搜索 / 取链流播 / 歌词(LRC+逐字KRC) / 歌单与榜单。能力面与 /qq/* 对齐；
      // 端点与签名的调研佐证见 docs/kugou-integration-research.md。

      const KG_STREAM_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'

      if (pathname === '/dsh-music/kg/status' && req.method === 'GET') {
        await loadKGCookie()
        writeJson(res, { loggedIn: kg.loggedIn, userid: kg.session.userid || '' })
        return
      }
      if (pathname === '/dsh-music/kg/login/start' && req.method === 'POST') {
        await loadKGCookie()
        try {
          // 复用已持久化的设备指纹（guid/mid/dfid，登出/失效时保留）：重扫 = 老设备
          // 回归，酷狗按设备指纹风控，稳定指纹比每次换新更安全（kgqd 等生产工具即
          // 注册一次长期复用）。仅当没有可用指纹（首次登录 / 旧版本 cookie / 此前
          // 注册失败留下的临时 dfid）时才重建并注册真实 dfid（r_register_dev）。
          // 酷狗把「token ↔ 设备」绑定校验：伪造 dfid 出码的 token 会在取链(20028
          // 本次请求需要验证)/云歌单(20017)处处被风控拦截，必须先注册再扫码。
          let warning = ''
          if (!kg.session.mid || !kg.session.dfid || kg.session.dfid === '-') {
            const fresh = KG.createDeviceIdentity()
            Object.assign(kg.session, fresh)
            try {
              const reg = await KG.registerDevice(kg.session)
              kg.session.dfid = reg.dfid
            } catch (regErr) {
              warning = '设备注册失败，已用临时身份继续：' + String((regErr && regErr.message) || regErr)
            }
          }
          const session = await KG.createQRLogin(kg.session)
          kgLoginSession = { key: session.key, expiresAt: session.expiresAt }
          await saveKGCookie()
          writeJson(res, { ok: true, key: session.key, image: session.imageDataUrl, expiresAt: session.expiresAt, ...(warning ? { warning } : {}) })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      if (pathname === '/dsh-music/kg/login/check' && req.method === 'GET') {
        const key = url.searchParams.get('key') || ''
        if (key === '') { writeJson(res, { ok: false, error: 'missing key' }, 400); return }
        try {
          const result = await KG.checkQRLogin(key, kg.session)
          if (result.status === 'success' && result.tokenInfo) {
            kg.session.token = result.tokenInfo.token
            kg.session.userid = result.tokenInfo.userid
            kg.session.vip_type = result.tokenInfo.vip_type || ''
            kg.session.vip_token = result.tokenInfo.vip_token || ''
            // 立刻刷新一次（v5/login_by_token）：把扫码 token 兑换为标准作用域，
            // 消除云歌单/取链的设备作用域拒绝（kgqd 生产环境同款动作）。
            let refreshNote = ''
            try {
              const refreshed = await KG.refreshSession(kg.session)
              if (refreshed.token) {
                kg.session.token = refreshed.token
                kg.session.vip_type = refreshed.vip_type || kg.session.vip_type
                kg.session.vip_token = refreshed.vip_token || kg.session.vip_token
                if (refreshed.t1) kg.session.t1 = refreshed.t1
                refreshNote = '已刷新为标准会话'
              }
            } catch (e) { void e /* 刷新失败不阻断登录 */ }
            kg.loggedIn = !!(kg.session.token && kg.session.userid)
            kg.isVip = null
            kgTakeCacheKg.clear()
            await saveKGCookie()
            writeJson(res, { ok: true, status: 'success', loggedIn: kg.loggedIn, userid: kg.session.userid, message: result.message, refresh: refreshNote })
          } else {
            writeJson(res, { ok: true, status: result.status, message: result.message, extra: result.extra })
          }
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      if (pathname === '/dsh-music/kg/login/logout' && req.method === 'POST') {
        await clearKGCookie()
        writeJson(res, { ok: true, loggedIn: false })
        return
      }
      if (pathname === '/dsh-music/kg/search' && req.method === 'GET') {
        const w = (url.searchParams.get('w') || '').trim()
        if (w === '') { writeJson(res, { ok: false, error: 'missing query' }, 400); return }
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        try {
          const s = await KG.search(w, '', page)
          rememberKgSongs(s.results)
          writeJson(res, { ok: true, results: s.results, total: s.total, page: s.page })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname.startsWith('/dsh-music/kg/play/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const hash = decodeURIComponent(pathname.slice('/dsh-music/kg/play/'.length)).toLowerCase()
        if (!/^[0-9a-f]{32}$/.test(hash)) { res.writeHead(400); res.end(); return }
        await loadKGCookie()
        let song = getKgSong(hash) || { hash }
        try {
          const dl = await kgTake(song)
          if (!dl.url) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('无法获取播放地址（' + (dl.err || '可能是 VIP/版权限制，或登录态需刷新：请退出后重新扫码') + '）')
            return
          }
          const upHeaders = { 'User-Agent': KG_STREAM_UA }
          if (typeof req.headers.range === 'string') upHeaders['Range'] = req.headers.range
          const stream = await fetch(dl.url, { headers: upHeaders })
          const headers = {
            'Content-Type': stream.headers.get('content-type') || 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          }
          // 真实品质随播放流回传（酷狗 tracker 会按账号权限授予档位），播放条据此显示标签。
          if (dl.quality) headers['X-DSH-KG-Quality'] = encodeURIComponent(dl.quality)
          const cr = stream.headers.get('content-range'); if (cr) headers['Content-Range'] = cr
          const cl = stream.headers.get('content-length'); if (cl) headers['Content-Length'] = cl
          res.writeHead(stream.status, headers)
          if (req.method === 'HEAD') { res.end(); return }
          if (stream.body) { for await (const chunk of stream.body) res.write(chunk) }
          res.end()
        } catch (err) {
          void err
          try { res.writeHead(500); res.end() } catch { /* ignore */ }
        }
        return
      }
      // ---- 酷狗歌词：逐字 KRC 优先 → 普通 LRC 兜底（形状对齐 /qq/lyric）----
      if (pathname === '/dsh-music/kg/lyric' && req.method === 'GET') {
        const hash = (url.searchParams.get('hash') || '').trim().toLowerCase()
        if (!/^[0-9a-f]{0,32}$/.test(hash)) { writeJson(res, { ok: false, error: 'bad hash' }, 400); return }
        const title = (url.searchParams.get('title') || '').trim()
        const artist = (url.searchParams.get('artist') || '').trim()
        const durationSec = Math.round(Number(url.searchParams.get('duration') || '0') || 0)
        const args = { hash, keyword: [title, artist].filter(Boolean).join(' '), durationSec, title, artist }
        try {
          const w = await KG.getWordLines(args)
          if (w && Array.isArray(w.lines) && w.lines.length > 0) {
            // KRC 内嵌翻译（type=1 行序已与主歌词对齐）：转成客户端消费的 [{t,text}]
            const trans = Array.isArray(w.translations)
              ? w.translations.map((txt, i) => ({ t: (w.lines[i] && w.lines[i].t) || i * 5, text: txt })).filter((x) => x.text)
              : []
            writeJson(res, { ok: true, hasLyric: true, source: 'kg-krc', wordLines: w.lines, trans })
            return
          }
        } catch { /* KRC 失败/无逐字数据 → LRC 兜底 */ }
        try {
          const g = await KG.getLyric(args)
          const lrc = parseLrc(g.lyric)
          writeJson(res, { ok: true, hasLyric: lrc.length > 0, lrc })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      // ---- 酷狗歌单（推荐/分类/分类歌单/搜索/详情，匿名；个人歌单需登录）----
      if (pathname === '/dsh-music/kg/playlists' && req.method === 'GET') {
        const category = (url.searchParams.get('category') || '').trim()
        try {
          if (category === '') {
            const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
            const r = await KG.getRecommendedPlaylists('', page)
            writeJson(res, { ok: true, playlists: r.playlists, total: r.total, page: r.page })
          } else {
            await ensureKugouDevice()
            const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
            writeJson(res, { ok: true, playlists: await KG.getCategoryPlaylists(category, page, 20, kg.session) })
          }
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/playlist-categories' && req.method === 'GET') {
        try {
          await ensureKugouDevice()
          writeJson(res, { ok: true, categories: await KG.getPlaylistCategories(kg.session) })
        }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/playlist-search' && req.method === 'GET') {
        const w = (url.searchParams.get('w') || '').trim()
        if (w === '') { writeJson(res, { ok: false, error: 'missing query' }, 400); return }
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
        try {
          const s = await KG.searchPlaylist(w, '', page)
          writeJson(res, { ok: true, playlists: s.results, total: s.total, page: s.page })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname.startsWith('/dsh-music/kg/playlist/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/dsh-music/kg/playlist/'.length))
        if (!/^[0-9]+$/.test(id)) { writeJson(res, { ok: false, error: 'bad id' }, 400); return }
        try {
          const detail = await KG.getPlaylistSongs(id)
          rememberKgSongs(detail.songs)
          writeJson(res, { ok: true, playlist: detail })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 404) }
        return
      }
      // 我的歌单 / 写操作：都要求登录态 token
      if (pathname === '/dsh-music/kg/my-playlists' && req.method === 'GET') {
        await loadKGCookie()
        if (!kg.loggedIn) { writeJson(res, { ok: false, error: '未登录' }, 401); return }
        try { writeJson(res, { ok: true, playlists: await kgWithFreshToken(() => KG.getMyPlaylists(kg.session)), userid: kg.session.userid }) }
        catch (err) { writeKgErr(res, err, 502) }
        return
      }
      // 酷狗「我喜欢」已收藏歌曲集合（hash + fileId + 该歌单 listid），供播放条爱心
      // 点亮判断与收藏切换（对齐 /dsh-music/qq/liked）。
      if (pathname === '/dsh-music/kg/liked' && req.method === 'GET') {
        await loadKGCookie()
        if (!kg.loggedIn) { writeJson(res, { ok: false, error: '未登录' }, 401); return }
        try {
          const mine = await kgWithFreshToken(() => KG.getMyPlaylists(kg.session))
          const liked = (mine || []).find((p) => p.kind === 'own' && p.isLike)
          let listId = 0, files = []
          if (liked && liked.id) {
            listId = Number(liked.id) || 0
            const songs = await kgWithFreshToken(() => KG.getMyPlaylistSongs(liked.id, kg.session))
            files = songs.map((x) => ({ hash: x.hash, fileId: x.fileId || 0 })).filter((x) => x.hash)
          }
          writeJson(res, { ok: true, listId, hashes: files.map((x) => x.hash), files })
        } catch (err) { writeKgErr(res, err, 502) }
        return
      }
      // 我的歌单详情（云歌单 listid；歌曲带 fileId 供移除接口使用）。
      if (pathname.startsWith('/dsh-music/kg/my-playlist/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/dsh-music/kg/my-playlist/'.length))
        if (!/^[0-9]+$/.test(id)) { writeJson(res, { ok: false, error: 'bad id' }, 400); return }
        await loadKGCookie()
        if (!kg.loggedIn) { writeJson(res, { ok: false, error: '未登录' }, 401); return }
        try {
          let songs = []
          // 先看该 listid 是不是收藏歌单：是则用 get_other_list_file_nofilt（传 creatorGid），
          // 否则用云歌单 get_list_all_file。收藏歌单的副本常为空（m_count=0），必须走前者。
          const mine = await kgWithFreshToken(() => KG.getMyPlaylists(kg.session))
          const mineItem = (mine || []).find((p) => String(p.id) === String(id))
          if (mineItem && mineItem.kind === 'collect' && mineItem.creatorGid) {
            songs = await kgWithFreshToken(() => KG.getCollectedPlaylistSongs(mineItem.creatorGid, kg.session))
          } else {
            songs = await kgWithFreshToken(() => KG.getMyPlaylistSongs(id, kg.session))
          }
          rememberKgSongs(songs)
          writeJson(res, { ok: true, playlist: { id, name: '', songs } })
        } catch (err) { writeKgErr(res, err, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/playlist-remove' && req.method === 'POST') {
        const body = await readBody(req)
        const listId = Number((body && body.listId)) || 0
        const fileId = Number((body && body.fileId)) || 0
        await loadKGCookie()
        try { writeJson(res, { ok: await kgWithFreshToken(() => KG.deleteSongFromPlaylist(fileId, listId, kg.session)) }) }
        catch (err) { writeKgErr(res, err, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/playlist-create' && req.method === 'POST') {
        const body = await readBody(req)
        const name = String((body && body.name) || '').trim()
        if (name === '') { writeJson(res, { ok: false, error: '歌单名不能为空' }, 400); return }
        await loadKGCookie()
        try { writeJson(res, { ok: true, playlist: await kgWithFreshToken(() => KG.createPlaylist(name, kg.session)) }) }
        catch (err) { writeKgErr(res, err, 502) }
        return
      }
      // 收藏别人的歌单（v5/add_list type=1）：需要被收藏歌单的 specialid + 创建者 userid。
      if (pathname === '/dsh-music/kg/playlist-collect' && req.method === 'POST') {
        const body = await readBody(req)
        const playlist = (body && body.playlist) || {}
        await loadKGCookie()
        if (!kg.loggedIn) { writeJson(res, { ok: false, error: '未登录' }, 401); return }
        try { writeJson(res, { ok: true, playlist: await kgWithFreshToken(() => KG.collectPlaylist(playlist, kg.session)) }) }
        catch (err) { writeKgErr(res, err, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/playlist-delete' && req.method === 'POST') {
        const body = await readBody(req)
        const listId = Number((body && body.listId)) || 0
        if (!listId) { writeJson(res, { ok: false, error: '缺少歌单 listId' }, 400); return }
        await loadKGCookie()
        try { writeJson(res, { ok: await kgWithFreshToken(() => KG.deletePlaylist(listId, kg.session)) }) }
        catch (err) { writeKgErr(res, err, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/playlist-add' && req.method === 'POST') {
        const body = await readBody(req)
        const song = (body && body.song) || {}
        const listId = Number((body && body.listId)) || 0
        await loadKGCookie()
        try { writeJson(res, { ok: await kgWithFreshToken(() => KG.addSongToPlaylist(song, listId, kg.session)) }) }
        catch (err) { writeKgErr(res, err, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/top-lists' && req.method === 'GET') {
        await loadKGCookie()
        try { writeJson(res, { ok: true, groups: await KG.getTopLists(kg.session) }) }
        catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }
      if (pathname === '/dsh-music/kg/top-songs' && req.method === 'GET') {
        const rankId = (url.searchParams.get('rankId') || '').trim()
        if (!/^[0-9]+$/.test(rankId)) { writeJson(res, { ok: false, error: 'bad rankId' }, 400); return }
        const offset = parseInt(url.searchParams.get('offset') || '0', 10)
        const num = parseInt(url.searchParams.get('num') || '30', 10)
        try {
          const top = await KG.getTopListSongs(rankId, kg.session, Number.isFinite(offset) ? offset : 0, Number.isFinite(num) ? num : 30)
          rememberKgSongs(top.songs)
          writeJson(res, { ok: true, toplist: top })
        } catch (err) { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502) }
        return
      }

      // ---- 歌词（本地音频同名 .lrc）----
      // 只放行已登记路径（任一歌单成员 ∪ 曲库扫描集），与 /dsh-music/file 同守卫。
      // 用 readBufToString 解码，兼容 UTF-8（含 BOM）/UTF-16/GBK 保存的 .lrc。
      if (pathname === '/dsh-music/lyric' && req.method === 'GET') {
        await ensureStarted()
        const rawPath = url.searchParams.get('path') || ''
        if (rawPath === '') { writeJson(res, { ok: false, error: 'missing path' }, 400); return }
        if (!isAudioName(rawPath) || !isRegisteredAudioPath(rawPath)) { writeJson(res, { ok: false, error: 'forbidden' }, 403); return }
        // 优先级：同名 .lrc → 文件内嵌歌词 → （无则客户端转 /lyric/online）。
        const lrcPath = findLrcForAudio(rawPath)
        if (lrcPath !== null) {
          try {
            const raw = parseLrc(readBufToString(readFileSync(lrcPath)))
            const { lrc, trans } = splitTranslatedLyric(raw)
            writeJson(res, { ok: true, hasLrc: true, source: 'local', name: basename(lrcPath), lrc, ...(trans.length > 0 ? { trans } : {}) })
          } catch (err) {
            writeJson(res, { ok: false, hasLrc: true, error: String((err && err.message) || err) }, 500)
          }
          return
        }
        // 无同名 .lrc：读文件内嵌歌词（FLAC LYRICS / MP3 USLT），解析后同样走本地渲染。
        const embedded = readEmbeddedLyric(rawPath, (() => { try { return statSync(rawPath).size || 0 } catch { return 0 } })())
        if (embedded !== null) {
          try {
            const raw = parseLrc(embedded)
            if (raw.length > 0) {
              const { lrc, trans } = splitTranslatedLyric(raw)
              writeJson(res, { ok: true, hasLrc: true, source: 'embedded', name: '内嵌歌词', lrc, ...(trans.length > 0 ? { trans } : {}) })
              return
            }
          } catch { /* 内嵌词解析失败 → 视为无词，转在线兜底 */ }
        }
        writeJson(res, { ok: false, hasLrc: false })
        return
      }
      // ---- 本地歌曲在线歌词兜底（QQ 音乐 → LRCLIB）----
      // 客户端先请求 /lyric；本地无同名 .lrc 时再请求本端点：先复查本地（幂等），
      // 无则在线取词（QQ 匿名官方歌词含逐句翻译；LRCLIB 免费同步 LRC），按 track.path
      // LRU 缓存避免重复请求；无匹配/失败返回 hasLyric:false，播放不受影响。
      if (pathname === '/dsh-music/lyric/online' && req.method === 'GET') {
        await ensureStarted()
        const rawPath = url.searchParams.get('path') || ''
        if (rawPath === '') { writeJson(res, { ok: false, error: 'missing path' }, 400); return }
        if (!isAudioName(rawPath) || !isRegisteredAudioPath(rawPath)) { writeJson(res, { ok: false, error: 'forbidden' }, 403); return }
        // 本地同名 .lrc 优先（幂等：若已出现则直接返回本地，不浪费在线请求）。
        const lrcPath = findLrcForAudio(rawPath)
        if (lrcPath !== null) {
          try {
            const raw = parseLrc(readBufToString(readFileSync(lrcPath)))
            const { lrc, trans } = splitTranslatedLyric(raw)
            writeJson(res, { ok: true, hasLyric: lrc.length > 0, source: 'local', lrc, ...(trans.length > 0 ? { trans } : {}) })
          } catch (err) {
            writeJson(res, { ok: false, hasLyric: true, error: String((err && err.message) || err) }, 500)
          }
          return
        }
        // 次之：文件内嵌歌词（FLAC LYRICS / MP3 USLT）——同样属本地来源，直接返回，不浪费在线请求。
        const embeddedOnline = readEmbeddedLyric(rawPath, (() => { try { return statSync(rawPath).size || 0 } catch { return 0 } })())
        if (embeddedOnline !== null) {
          try {
            const raw = parseLrc(embeddedOnline)
            if (raw.length > 0) {
              const { lrc, trans } = splitTranslatedLyric(raw)
              writeJson(res, { ok: true, hasLyric: true, source: 'embedded', lrc, ...(trans.length > 0 ? { trans } : {}) })
              return
            }
          } catch { /* 内嵌词解析失败 → 转在线兜底 */ }
        }
        // 在线兜底：LRU 缓存命中直接返回（正命中 6h / 空命中 30min）。
        const cached = lyricOnlineCacheGet(rawPath)
        if (cached !== null) { writeJson(res, cached); return }
        // 搜索关键词：优先客户端给的标题（文件名去扩展名），否则从路径派生命名。
        let title = (url.searchParams.get('title') || '').trim()
        if (title === '') {
          const fn = basename(rawPath)
          const dot = fn.lastIndexOf('.')
          title = dot > 0 ? fn.slice(0, dot) : fn
        }
        const artist = (url.searchParams.get('artist') || '').trim()
        const durRaw = Number(url.searchParams.get('duration'))
        const duration = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null
        await loadQQCookie()
        let payload = { ok: true, hasLyric: false }
        try {
          const hit = await getOnlineLyric({ title, artist, duration, qqCookie: qq.cookie })
          if (hit !== null && Array.isArray(hit.wordLines) && hit.wordLines.length > 0) {
            // 逐字歌词（QRC）：精确行窗口 [{t,end,text}]，与 lrc 形态互斥。
            payload = {
              ok: true, hasLyric: true, source: hit.source,
              wordLines: hit.wordLines, matched: hit.matched,
            }
          } else if (hit !== null) {
            const lrc = parseLrc(hit.lrcText)
            payload = {
              ok: true, hasLyric: lrc.length > 0, source: hit.source,
              lrc, matched: hit.matched,
              ...(hit.transText !== '' ? { trans: parseLrc(hit.transText) } : {}),
            }
          }
        } catch (err) {
          payload = { ok: false, error: String((err && err.message) || err) }
        }
        // 只缓存成功响应（含空结果）：错误/瞬时故障不缓存，避免之后 30 分钟都不再重试。
        if (payload.ok) {
          lyricOnlineCacheSet(rawPath, payload, payload.hasLyric ? LYRIC_ONLINE_TTL : LYRIC_ONLINE_TTL_EMPTY)
        }
        writeJson(res, payload)
        return
      }
      // ---- 通用文件流式路由（歌单成员专用，Range/seek）----
      // 只放行已登记路径（任一歌单成员 ∪ 曲库扫描集）。直接用 node:fs 读写，
      // 避免 DSH ctx.fs 对工作区外路径的围栏（与讲书读取小说文件的方式一致）。
      if (pathname === '/dsh-music/file' && (req.method === 'GET' || req.method === 'HEAD')) {
        await ensureStarted()
        const rawPath = url.searchParams.get('path') || ''
        if (rawPath === '') { res.writeHead(400); res.end(); return }
        if (!isAudioName(rawPath) || !isRegisteredAudioPath(rawPath)) { res.writeHead(403); res.end(); return }
        let st
        try { st = statSync(rawPath) } catch { res.writeHead(404); res.end(); return }
        if (!st.isFile()) { res.writeHead(404); res.end(); return }
        const size = st.size || 0
        let start = 0
        let end = size - 1
        let status = 200
        const range = req.headers.range
        if (typeof range === 'string') {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
          if (m !== null && (m[1] !== '' || m[2] !== '')) {
            if (m[1] !== '') {
              start = parseInt(m[1], 10)
              end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
            } else {
              start = Math.max(size - parseInt(m[2], 10), 0)
              end = size - 1
            }
            if (!Number.isFinite(start) || start > end || start >= size) {
              res.writeHead(416, { 'Content-Range': 'bytes */' + size })
              res.end()
              return
            }
            status = 206
          }
        }
        const bytes = readFileSync(rawPath)
        const slice = bytes.slice(start, end + 1)
        const headers = {
          'Content-Type': audioType(rawPath),
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Cache-Control': 'no-store',
        }
        if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
        res.writeHead(status, headers)
        if (req.method === 'HEAD') { res.end(); return }
        res.end(slice)
        return
      }
      // audio streaming
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      // Ensure the library scan completes before resolving a track, so a
      // streaming/HEAD request that arrives before any manifest call (or at
      // startup) still finds its track instead of spuriously 404ing.
      await ensureStarted()
      const id = pathname.slice('/dsh-music/'.length)
      const track = tracks.find((t) => t.id === id)
      if (track === undefined) { res.writeHead(404); res.end(); return }
      const target = await ctx.fs.resolve(track.path)
      const info = await ctx.fs.stat(target)
      if (info === undefined || info.type !== 'file' || info.size === undefined) { res.writeHead(404); res.end(); return }
      const size = info.size
      let start = 0
      let end = size - 1
      let status = 200
      const range = req.headers.range
      if (typeof range === 'string') {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        if (m !== null && (m[1] !== '' || m[2] !== '')) {
          if (m[1] !== '') {
            start = parseInt(m[1], 10)
            end = m[2] !== '' ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
          } else {
            start = Math.max(size - parseInt(m[2], 10), 0)
            end = size - 1
          }
          if (!Number.isFinite(start) || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + size })
            res.end()
            return
          }
          status = 206
        }
      }
      const bytes = await ctx.fs.readBytes(target, undefined, size)
      const slice = bytes.slice(start, end + 1)
      const headers = {
        'Content-Type': audioType(track.name),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-store',
      }
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
      res.writeHead(status, headers)
      if (req.method === 'HEAD') { res.end(); return }
      res.end(slice)
    } catch (err) {
      try { res.writeHead(500); res.end() } catch {}
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-music', handler: serve }), 'music-player: routes')

  // ---- model tool: music_play ----
  const PLAY_ACTIONS = ['play', 'pause', 'resume', 'stop', 'next', 'prev']
  const tool = {
    name: 'music_play',
    description: '控制 DSH 本地音乐库与小说库的播放。播放时可按歌曲名/歌手/小说名关键词搜索并播放（不传 query 则播放第一首音乐，没有音乐则播放第一本小说），或按歌单名播放自建歌单（playlist 参数）；也可用 action 执行暂停/继续/停止/下一首·下一章/上一首·上一章。传 source=web 时会改走「在线 QQ 音乐」（需已在播放面板登录，登录后可播 VIP/高音质）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '歌曲名/歌手/小说名关键词，用于搜索并播放。仅当 action 为 play（默认）时使用，可留空' },
        playlist: { type: 'string', description: '歌单名关键词，播放指定自建歌单（含默认歌单「我最喜欢」）。仅当 action 为 play（默认）时使用，优先级高于 query，可留空' },
        source: { type: 'string', enum: ['local', 'web'], description: '播放来源：local 本地库/小说（默认）；web 在线 QQ 音乐（需登录解锁 VIP/高音质）。仅当 action 为 play 时使用' },
        action: { type: 'string', enum: PLAY_ACTIONS, description: '要执行的动作：play 播放（默认）、pause 暂停、resume 继续、stop 停止、next 下一首/下一章、prev 上一首/上一章' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string' }, played: { type: 'boolean' }, kind: { type: 'string' },
          track: { type: 'string' }, matches: { type: 'number' }, count: { type: 'number' },
          notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || (value && value.track ? '已请求播放：' + value.track : '音乐库/小说库为空') }]
      },
    },
    async execute(args) {
      await ensureStarted()
      const musicCount = tracks.length
      const bookCount = books.length
      const action = args && typeof args.action === 'string' && PLAY_ACTIONS.includes(args.action) ? args.action : 'play'
      // 歌单播放不依赖曲库是否为空（歌单可含曲库外的本地文件），因此先于空库守卫判断。
      const playlistQuery = args && typeof args.playlist === 'string' ? args.playlist.trim().toLowerCase() : ''
      const source = args && typeof args.source === 'string' && ['local', 'web'].includes(args.source) ? args.source : 'local'

      if (musicCount === 0 && bookCount === 0 && playlistQuery === '' && source !== 'web') {
        const notice = '本地音乐库与小说库均为空。请打开播放列表面板，点击「选择音乐目录」/「选择小说目录」配置。'
        return { action, played: false, track: '', matches: 0, count: 0, notice }
      }

      // Non-play actions just relay a transport command to the browser player.
      // For novels the client maps next/prev to chapter jumps.
      if (action !== 'play') {
        pendingIntent = { action }
        const labels = {
          pause: '已请求暂停播放', resume: '已请求继续播放', stop: '已请求停止播放',
          next: '已请求播放下一首/下一章', prev: '已请求播放上一首/上一章',
        }
        const notice = labels[action] + '。若浏览器拦截自动操作，请在播放条上点击对应按钮。'
        return { action, played: false, track: '', matches: 0, count: Math.max(musicCount, bookCount), notice }
      }

      // play with a playlist name: play the whole playlist (priority over query).
      if (playlistQuery !== '') {
        const pools = playlists.filter((p) => p.name.toLowerCase().includes(playlistQuery))
        const hit = playlists.find((p) => p.name.toLowerCase() === playlistQuery) || pools[0]
        if (hit === undefined) {
          const names = playlists.map((p) => p.name).join('、') || '（暂无歌单）'
          return { action, played: false, track: '', matches: 0, count: 0, notice: '没有找到歌单「' + (args && args.playlist) + '」。现有歌单：' + names }
        }
        const members = publicPlaylist(hit).tracks
        if (members.length === 0) {
          return { action, played: false, track: '', matches: 0, count: 0, notice: '歌单「' + hit.name + '」为空，请先在播放面板该歌单里点「添加歌曲」加入音乐。' }
        }
        pendingIntent = { action: 'play', playlistId: hit.id, playlistName: hit.name, id: members[0].id, name: members[0].name }
        return {
          action, played: true, track: members[0].name, matches: members.length, count: members.length,
          notice: '已请求播放歌单「' + hit.name + '」（' + members.length + ' 首）。若被拦截请点 ▶ 解锁。',
        }
      }

      // source=web: 播放在线 QQ 音乐（既走匿名免费曲，也走登录态 VIP/高音质）。
      const query0 = args && typeof args.query === 'string' ? args.query.trim() : ''
      if (action === 'play' && source === 'web' && query0 !== '') {
        try {
          const isVip = await refreshQQVip()
          const { results } = await QQ.search(query0, qq.cookie)
          if (results.length === 0) {
            return { action, played: false, track: '', matches: 0, count: 0, notice: '在线 QQ 音乐未找到「' + query0 + '」' }
          }
          const pick = qq.cookie ? results[0] : (results.find((r) => r.payplay !== 1) || results[0])
          pendingIntent = { action: 'play', kind: 'qq', id: pick.songmid, name: pick.title, artists: pick.artists, source: 'qq' }
          return {
            action, played: true, kind: 'qq', track: pick.title, matches: results.length, count: results.length,
            notice: '已请求在线播放 QQ 音乐「' + pick.title + '」（' + (pick.artists || []).join('/') + '）' + (qq.cookie ? '，登录态' + (isVip ? '可播高音质' : '') : '。若为 VIP 曲目请先在播放面板登录。') + '。若被拦截请点 ▶ 解锁。',
          }
        } catch (err) {
          return { action, played: false, track: '', matches: 0, count: 0, notice: '在线 QQ 音乐搜索失败：' + String((err && err.message) || err) }
        }
      }

      // play: search both music tracks and novels (.txt). A book-only match
      // starts AI 讲书; otherwise fall back to the music behaviour.
      const query = args && typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
      const bookPool = query === '' ? [] : books.filter((b) => b.name.toLowerCase().includes(query))
      const musicPool = query === '' ? tracks : tracks.filter((t) => t.name.toLowerCase().includes(query))

      // Empty query: play the first available track (music first, else a novel).
      if (query === '') {
        if (musicCount > 0) {
          const pick = tracks[0]
          pendingIntent = { action: 'play', id: pick.id, name: pick.name }
          return {
            action, played: true, track: pick.name, matches: tracks.length, count: musicCount,
            notice: '已请求播放「' + pick.name + '」。浏览器可能拦截自动播放，请在页面播放条上点击一次▶解锁。',
          }
        }
        const pick = books[0]
        pendingIntent = { action: 'play', kind: 'book', id: pick.id, name: pick.name }
        return {
          action, played: true, kind: 'book', track: pick.name, matches: bookCount, count: bookCount,
          notice: '已请求播放小说「' + pick.name + '」。讲书需已配置xiaomi TTS；若被拦截请点 ▶ 解锁。',
        }
      }

      // A novel-only match → AI 讲书 (prefer an exact filename match).
      if (bookPool.length > 0 && musicPool.length === 0) {
        const pick = books.find((b) => b.name.toLowerCase() === query) || bookPool[0]
        pendingIntent = { action: 'play', kind: 'book', id: pick.id, name: pick.name }
        return {
          action, played: true, kind: 'book', track: pick.name, matches: bookPool.length, count: bookCount,
          notice: '已请求播放小说「' + pick.name + '」（匹配 ' + bookPool.length + ' / 共 ' + bookCount + ' 本）。讲书需已配置xiaomi TTS；若被拦截请点 ▶ 解锁。',
        }
      }

      if (musicPool.length === 0) {
        const notice = '没有找到包含「' + (args && args.query) + '」的音乐或小说（音乐 ' + musicCount + ' 首，小说 ' + bookCount + ' 本）。'
        return { action, played: false, track: '', matches: 0, count: musicCount, notice }
      }
      // Prefer an exact (case-insensitive) filename match over the first substring hit.
      const pick = tracks.find((t) => t.name.toLowerCase() === query) || musicPool[0]
      pendingIntent = { action: 'play', id: pick.id, name: pick.name }
      return {
        action, played: true, track: pick.name, matches: musicPool.length, count: musicCount,
        notice: '已请求播放「' + pick.name + '」（匹配 ' + musicPool.length + ' / 共 ' + musicCount + ' 首）。浏览器可能拦截自动播放，请在页面播放条上点击一次▶解锁。',
      }
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'music-player: music_play tool')

  // ---- model tool: news_broadcast（每日新闻播报提交）----
  // agent 先自行用 web_search 收集并整理，再把结构化数据提交到本工具；工具端负责
  // 校验规整 → 冷却窗去重 → 模板渲染分块 → 持久化 → 推送播放条（autoplay）。
  const newsBroadcastTool = {
    name: 'news_broadcast',
    description: '把收集整理好的当日新闻提交为语音播报。调用前必须已用 web_search 完成收集与筛选（按类别多查询、带当天日期、跨源去重、只保留可确认时效的条目）。每条 item 的 summary 建议控制在 200 字以内（仅建议：代码不做任何截断，生成多长就播报多长，请在自然完整的句子处收尾，过短则信息量不足）。source 必填（如「新华社」「微博热搜」）。同一班次 10 分钟内重复提交会被跳过（冷却窗），确需强制重收传 force:true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '期次标题，如「早间新闻播报」「AI 新闻简报」，默认「今日新闻播报」；仅对话直接播报时生效——定时/立即执行班次的收集（shiftId 命中已配置班次）由 Host 统一命名为「M月D日 HH:MM 新闻播报」，传了也会被覆盖，不必精心起名' },
        date: { type: 'string', description: '新闻日期 YYYY-MM-DD，默认今天' },
        categories: {
          type: 'array',
          description: '分类别的新闻条目（必填，至少 1 类 1 条）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: '类别名（预设：热点/国内/国际/科技/财经/体育/娱乐；自定义主题直接用主题名，如 AI）' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string', description: '条目标题' },
                    summary: { type: 'string', description: '中性口播内容，建议不超过 200 字（仅建议、代码不截断，生成长度即播报长度）；条目标题不参与播报（只在面板展示），摘要须自含主语：开头点明「谁/什么事」再讲细节，让听众不看面板也能听懂' },
                    source: { type: 'string', description: '来源名（必标）' },
                    url: { type: 'string', description: '原文链接' },
                    publishedAt: { type: 'string', description: '发布时间线索（可选）' },
                  },
                  required: ['title', 'summary'],
                },
              },
            },
            required: ['name', 'items'],
          },
        },
        opening: { type: 'string', description: '自定义开场白（可选，默认模板）' },
        closing: { type: 'string', description: '自定义结语（可选，默认模板）' },
        voice: { type: 'string', description: 'AI 声音（可选，默认取用户偏好）' },
        autoplay: { type: 'boolean', description: '是否立即推送播放（默认 true；静默收集班次传 false）' },
        force: { type: 'boolean', description: '冷却窗内强制重新收集（默认 false）' },
        shiftId: { type: 'string', description: '产生本次收集的定时班次 id（定时任务触发时填，对话触发不填）' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, skipped: { type: 'boolean' }, editionId: { type: 'string' },
          categories: { type: 'number' }, items: { type: 'number' }, chunks: { type: 'number' },
          estMinutes: { type: 'number' }, notice: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || '新闻播报提交失败' }]
      },
    },
    async execute(args) {
      await loadNews()
      // 班次新闻条数（itemCount）：命中已配置班次时，全期上限 = itemCount（1-20，默认 8），
      // 单类别可超过默认 8 条/类（如 1 类 12 条）；多类别时下方按平均配额收敛。
      const originShiftId = (typeof args.shiftId === 'string' && args.shiftId.trim() !== '')
        ? args.shiftId.trim() : 'manual'
      const budgetShift = originShiftId !== 'manual'
        ? (news.schedulePrefs.shifts || []).find((s) => s.id === originShiftId) : null
      const shiftItemCount = budgetShift ? normalizeShiftItemCount(budgetShift.itemCount) : null
      // 单类别上限提到 itemCount（可超过默认 8 条/类），全期上限保持默认 20——
      // 「按班次条数收敛」交给下方 capCategoriesToQuota 做（含多类别平均分配），
      // 避免 sanitize 按提交顺序提前截断，把后面的类别整类截成 0 条。
      const limits = shiftItemCount !== null
        ? { itemsPerCategory: shiftItemCount, totalItems: LIMITS.totalItems } : undefined
      const check = sanitizeEditionInput(args, { today: new Date().toISOString().slice(0, 10), limits })
      if (!check.ok) {
        return { ok: false, skipped: false, editionId: '', categories: 0, items: 0, chunks: 0, estMinutes: 0, notice: check.error }
      }
      const input = check.value
      const now = Date.now()
      // 班次触发的收集：期次标题由 Host 确定性命名为「M月D日 HH:MM 新闻播报」，不依赖
      // agent 自觉——标题无约束时，每次执行的全新 agent 会即兴起名（「每日热点新闻播报」
      // 「AI 今日头条丨…」各不相同），期次列表与口播报名风格漂移。日期取期次 date 字段，
      // 与口播开场「您好，这里是{title}」的日期去重判断一致（标题已含 M月D日 不再追加）；
      // shiftId 未命中已配置班次（班次已删）或对话直接播报时保留 agent 命名/默认标题。
      let scopeFilterNote = ''
      if (input.originShiftId !== 'manual') {
        const shift = (news.schedulePrefs.shifts || []).find((s) => s.id === input.originShiftId)
        if (shift) {
          const dayPart = /(\d{1,2}月\d{1,2}日)/.exec(formatDateCn(input.date))
          input.title = `${dayPart ? dayPart[1] : ''} ${shift.time} 新闻播报`.trim()
          // 班次范围精确性：提交的类别必须落在班次范围内（scope.categories ∪ 自定义
          // 主题——主题可建同名类别）。agent 常把大类里的热点（如科技里的 AI）自行
          // 另立类别，导致输出与班次配置不符：范围外类别整体过滤并在通知中说明；
          // 全部越界则拒绝生成，让 agent 按范围重提。
          if (shift.scope) {
            const allowed = new Set([...(shift.scope.categories || []), ...(shift.scope.topics || [])])
            const kept = input.categories.filter((c) => allowed.has(c.name))
            const dropped = input.categories.filter((c) => !allowed.has(c.name))
            if (kept.length === 0) {
              return { ok: false, skipped: false, editionId: '', categories: 0, items: 0, chunks: 0, estMinutes: 0,
                notice: `本次提交的类别（${input.categories.map((c) => c.name).join('/')}）均不在班次范围内（${[...allowed].join('/')}），期次未生成。请只收集并提交班次范围内的类别。` }
            }
            if (dropped.length > 0) {
              scopeFilterNote = '已按班次范围过滤范围外类别：' +
                dropped.map((c) => `${c.name}（${c.items.length} 条）`).join('、')
              input.categories = kept
              input.itemCount = kept.reduce((n, c) => n + c.items.length, 0)
            }
          }
        }
      }
      // 班次新闻条数：多类别时按平均配额收敛（每类 ≤ 其均摊份额，余数给靠前类别），
      // 保证「选取多个类别时尽量平均分配」；单类别时配额=itemCount，天然归该类。
      // sanitize 已按 limits 截到全期上限，这里只做「类别间尽量平均」的再分配。
      let budgetNote = ''
      if (shiftItemCount !== null && input.categories.length > 1) {
        const res = capCategoriesToQuota(input.categories, shiftItemCount)
        input.categories = res.categories
        input.itemCount = res.categories.reduce((n, c) => n + c.items.length, 0)
        if (res.dropped > 0) {
          budgetNote = `已按班次条数（${shiftItemCount} 条）平均分配各类别：` +
            res.categories.map((c) => `${c.name}（${c.items.length} 条）`).join('、')
        }
      }
      if (!input.force) {
        const hit = findInCooldown(news.editions, { originShiftId: input.originShiftId, now })
        if (hit) {
          return {
            ok: true, skipped: true, editionId: hit.id, categories: 0, items: 0, chunks: 0, estMinutes: 0,
            notice: `该班次（${input.originShiftId}）${Math.round((now - hit.createdAt) / 60000)} 分钟前刚收集过（期次 ${hit.id}），本次已按冷却窗跳过。内容通常不会有实质变化；若确需重新收集（如事件有新进展），请传 force:true。`,
          }
        }
      }
      const stamp = new Date(now)
      const pad2 = (n) => String(n).padStart(2, '0')
      // 期次 id 日期段用「本地时间」（与期次 title/date 的用户感知一致；toISOString 是 UTC，
      // 会导致东八区晚上生成的 id 日期与面板显示日期差一天）。
      const id = 'news-' + stamp.getFullYear() + pad2(stamp.getMonth() + 1) + pad2(stamp.getDate())
        + '-' + pad2(stamp.getHours()) + pad2(stamp.getMinutes()) + '-' + Math.random().toString(36).slice(2, 6)
      const edition = buildEdition(input, { id, createdAt: now })
      // 绑定执行会话：若本次收集由「执行会话」触发（定时/立即执行），把该会话 id 记到期次，
      // 供删除期次时联动销毁对应会话；对话内直接播报（无执行会话）则不绑定。
      const execSessionId = news.runState && news.runState.sessionId ? news.runState.sessionId : null
      if (execSessionId) edition.sessionId = execSessionId
      news.editions.push(edition)
      news.editions = applyRetention(news.editions)
      // 收集成功即清空失败记录：失败提示是「最近一次收集失败」的风向标，成功一次说明
      // 问题已恢复（如搜索余额不足充值后），再挂旧失败会误导用户——重启/刷新后也照常消失。
      if (news.failures.length > 0) news.failures = []
      // 收集完成即清除运行态：任一收集结束都意味着当前运行结束（手动/定时均适用）。
      news.runState = null
      await saveNews()
      // 记录 期次→执行会话 映射（供删除联动）；若会话已不在（极少数）则忽略。
      if (execSessionId && execSessions.has(execSessionId)) {
        const rec = execSessions.get(execSessionId)
        rec.editionId = id
      }
      const played = input.autoplay
        ? (() => { pendingIntent = { action: 'play', kind: 'news', id, name: edition.title, ts: Date.now() }; return true })()
        : false
      const parts = [
        `已生成第 ${news.editions.filter((e) => (e.originShiftId || 'manual') === input.originShiftId).length} 期（本班次保留 7 期）`,
        `${input.itemCount} 条 / ${edition.chunks.length} 块 / 约 ${estimateMinutes(edition.totalChars)} 分钟`,
      ]
      if (scopeFilterNote) parts.push(scopeFilterNote)
      if (budgetNote) parts.push(budgetNote)
      if (played) parts.push('已推送播放条开播（浏览器可能拦截自动播放，请点 ▶ 解锁）')
      else parts.push('静默收集：未推送播放，可在面板「新闻播报」页签查看或播放')
      return {
        ok: true, skipped: false, editionId: id,
        categories: input.categories.length, items: input.itemCount, chunks: edition.chunks.length,
        estMinutes: estimateMinutes(edition.totalChars), notice: parts.join('；') + '。',
      }
    },
  }
  ctx.effect(() => ctx.tools.register(newsBroadcastTool), 'music-player: news_broadcast tool')

  // ---- model tool: news_schedule（新闻定时偏好读写 / 执行态上报 / 失败上报）----
  const newsScheduleTool = {
    name: 'news_schedule',
    description: '查询新闻播报的定时偏好与执行态、上报收集失败。定时器由 Host 端自维护（每次执行自动新建一个执行会话并绑定结果），无需 agent 创建/同步 DSH 定时任务。收集失败（换词重试后仍无结果或工具报错）时 reportFailure 透传错误；get 可读取当前偏好/运行态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'reportFailure'], description: 'get 查询偏好与状态；reportFailure 上报收集失败' },
        shiftId: { type: 'string', description: '班次 id（reportFailure 时填）' },
        kind: { type: 'string', enum: ['error', 'empty'], description: '失败类型：error=工具调用报错，empty=搜索成功但无可确认时效的结果（reportFailure 时填）' },
        reason: { type: 'string', description: '失败原因（透传工具错误码与消息原文，不做推断，≤160 字）（reportFailure 时填）' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, data: { type: 'string' }, notice: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: (value && value.notice) || '' }]
      },
    },
    async execute(args) {
      await loadNews()
      const action = args && typeof args.action === 'string' ? args.action : 'get'
      const shiftId = args && typeof args.shiftId === 'string' ? args.shiftId.trim() : ''
      if (action === 'reportFailure') {
        const kind = args && args.kind === 'empty' ? 'empty' : 'error'
        const reason = String((args && args.reason) || '').slice(0, 160)
        const sessionId = news.runState && news.runState.sessionId ? news.runState.sessionId : null
        pushFailure({ shiftId: shiftId || null, kind, reason, ...(sessionId ? { sessionId } : {}) })
        news.runState = null // 任一收集失败也结束当前运行
        await saveNews()
        return { ok: true, data: '', notice: '已记录收集失败（' + kind + '：' + reason + '）。本期次不生成，面板会展示失败并提示可立即执行补收。' }
      }
      // get：偏好 + 最近失败 + 运行态摘要
      const p = news.schedulePrefs
      const desc = {
        enabled: p.enabled,
        shifts: p.shifts.map((s) => ({
          id: s.id, time: s.time, autoplay: s.autoplay,
          itemCount: s.itemCount, // 班次新闻条数（1-20，默认 8）
          scope: s.scope,
          scopeSummary: scopeSummary(s.scope),
        })),
        prefVersion: p.prefVersion,
        syncedVersion: p.syncedVersion,
        model: p.model, // 用户选择的「新闻采集模型」（null = 跟随当前活跃会话）
        running: runStateAlive(news.runState, Date.now()) ? news.runState : null,
        recentFailures: news.failures.slice(-5),
        notice: !p.enabled
          ? '每日定时已停用。'
          : p.shifts.length === 0 && p.prefVersion === 0
            ? '面板尚未配置定时班次。'
            : '定时偏好由 Host 端自维护，保存即生效（无需 agent 同步）。',
      }
      return { ok: true, data: JSON.stringify(desc), notice: desc.notice }
    },
  }
  ctx.effect(() => ctx.tools.register(newsScheduleTool), 'music-player: news_schedule tool')

  // ---- light prompt hint so the agent knows it can play local music/novels ----
  ctx.systemPrompt.section({
    name: 'tool:music-player', order: 116,
    text: '本机已挂载 DSH音乐播放器 与 AI 讲书：可用 music_play 工具按关键词播放 ~/Music（或设置的目录）里的音乐，或按歌单名播放自建歌单（playlist 参数），或按小说名播放本地 .txt/.epub 小说（AI 讲书，需配置xiaomi提供方）；也可传 source=web 播放在线 QQ 音乐（需在播放面板登录，登录后可播 VIP/高音质）；并支持 action 暂停/继续/停止/下一首·下一章/上一首·上一章。',
  })

  // ---- 新闻播报使用指引：驱动 agent 用 web_search 收集 → news_broadcast 提交 ----
  ctx.systemPrompt.section({
    name: 'tool:music-player-news', order: 117,
    text: [
      '本机支持「每日热点新闻播报」。当用户要求播报/收集新闻（或触发新闻定时任务）时：',
      '1) 用 web_search 按类别多查询（每批 1~4 条、全部带当天日期锚定，如「5月30日 热搜榜」「5月30日 国内要闻 新华社」）；类别来源优先级：热点→微博热搜/百度热搜/知乎热榜聚合报道（按热度排序、标榜单位）；国内→新华社/人民日报/央视/澎湃；国际→参考消息/环球网/CGTN；科技→36氪/IT之家；财经→财新/第一财经；体育→央视体育/懂球帝；娱乐→新浪娱乐/中国新闻网文娱；自定义主题（如 AI）→ 主题词组合查询并优先该主题权威垂直媒体（AI→机器之心/量子位）；',
      '2) 质量控制：只保留可确认时效的条目（publishedAt 或正文时间线索，存疑即弃）；同一事件跨源去重只留最权威一条；每类 ≤8 条、全期 ≤20 条；班次若配置了「新闻条数」（1-20，默认 8，触发班次时指令会给出本期条数与多类别平均配额），以该条数为全期上限并按配额在各类别间尽量平均分配（单类别则全部归该类）；每条摘要**建议控制在 200 字以内**（这只是建议而非硬性限制：代码不做任何截断，生成多长就播报多长——请在自然完整的句子处收尾，既保证信息完整又不拖慢单条节奏；过短则信息量不足）；摘要为中性口播内容，讲清事件要点、背景与影响，必标 source，不做猜测性推断；**条目标题不参与播报**（只在面板列表展示），因此每条摘要必须**自含主语**：开头点明「谁/什么事」，再讲进展与影响，让听众不看面板也能听懂每条在讲什么；提交的 categories 必须与班次范围一致（触发班次时指令会给允许的类别名），严禁自行新增范围外的类别（如科技班次里另立「AI」类——AI 内容应归入科技类，除非班次自定义主题声明了 AI）；无班次的对话播报按内容合理分类即可；',
      '3) 正常流程要用 web_fetch 抓取条目原文核实与补充细节（挑重要的抓，每类 1~3 条权威来源即可，不必逐条全抓）；单次报错（如 WEB_BLOCKED_URL「resolves to a non-public IP address」——常见于本机代理 fake-ip DNS 模式，该环境下所有域名都会报错）时：确认性重试 1 次仍失败即放弃抓取，该条以 web_search 摘要为准继续整理，本会话后续条目不再尝试 web_fetch；web_fetch 失败不影响期次生成、不要走失败上报；只有 web_search 本身失败才按第 5 条处理；',
      '4) 调 news_broadcast 提交（用户没说「先别播」时 autoplay 默认 true；静默收集传 false）；同一班次 10 分钟内重复提交会被冷却窗跳过；',
      '5) 失败处理：搜索成功但无结果→换查询词重试 2~3 次，仍无果调 news_schedule {action:"reportFailure", kind:"empty"} 并告知用户；工具调用报错→确认性重试 1 次即放弃，reportFailure 透传错误码与消息原文（不要推断原因），本期次不生成、绝不用旧数据顶替；',
      '6) 定时由 Host 端自维护：用户在面板「⏰ 每日定时」配置班次（时刻/范围/新闻条数/是否立即播放/新闻采集模型）即生效，到点 Host 自动新建一个执行会话去收集并绑定结果，无需 agent 创建/同步 DSH 定时任务；用户要求查看/修改/取消定时时，引导其到面板操作即可。',
    ].join('\n'),
  })

  void loadQQCookie()
  void ensureStarted()
  void rebuildTimer() // 启动时按持久化偏好重建 Host 定时器
  void rebuildCleanupTimer() // 启动时重建每日 03:00 过期清理定时器（并补跑当日未执行的清理）
}
