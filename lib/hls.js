/**
 * lib/hls.js — HLS（m3u8）电台 → 连续 ADTS 流的纯 Node 转换模块（零外部依赖）。
 *
 * 背景（详见 docs/internet-radio-design.md §5.2 定稿）：
 *   音频 HLS 的两种主流分片容器（实测均需支持）：
 *   - MPEG-TS 188B 分片：广播级标准（CCTV-13 myalicdn / 凤凰 ifeng / 中国之声 ahbztv），
 *     AAC-LC 48000Hz stereo，PMT 常为空节目——按 PES 流 ID（0xC0-0xDF）直接提取；
 *   - 裸 ADTS 分片：蜻蜓/喜马拉雅等直接发 .aac 分片（如华语金曲500首 qtfm），
 *     分片本身即 ADTS 帧流（HE-AAC 等），无需剥壳直接过帧同步。
 *   两种都归一为自描述 ADTS 帧流（0xFFF 同步字 + 帧长），Chromium <audio> 以
 *   chunked 流式（无 Content-Length）可直接播放（duration=null 直播特征）。
 *
 * 本模块对外核心：
 *   - parseHlsPlaylist(text, url)        判 master/media、递归子列表、分片 URL 补全（保留 token）
 *   - tsStripPes(buf) / adtsSyncScan(buf) TS 剥壳 / ADTS 帧同步纯函数（也可单独测试）
 *   - segmentToAdts(buf)                  分片字节（TS 或裸 ADTS）→ ADTS 帧数组（统一入口）
 *   - createHlsStream({ playlistUrl, fetchImpl, signal })  async generator：持续产出 ADTS 字节
 *     （拉 media playlist → 增量拉新分片 → 归一化 → yield；按 TARGETDURATION 轮询续拉）
 *
 * 支持：master 嵌套（递归取第一个子列表）、分片级/子列表级 token（URL 查询串原样保留）、
 * 相对/绝对分片 URL（含 scheme-relative //host/...）、滚动 playlist 续拉（live）、
 * TS 与裸 ADTS 两种分片容器。
 * 不支持（明确抛错，不静默）：fMP4/CMAF、加密 HLS EXT-X-KEY、纯视频 TS、非 AAC 编码。
 */

// ---- m3u8 解析（纯函数） ----

// 判 master：含 #EXT-X-STREAM-INF 即为主播放列表（其下是子列表 URL）。
export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(String(text || ''))
}

// 从文本抽非注释行（去空白、去 BOM、去行尾 CR）。
function uriLines(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

// 相对 URL → 绝对：基于当前列表 URL。
export function resolveUrl(base, ref) {
  if (!ref) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return ref // 已是绝对（http/https 或其它 scheme）
  try {
    return new URL(ref, base).href
  } catch { return ref }
}

// 取 master 的第一个可用子列表 URL（取紧随 #EXT-X-STREAM-INF 之后的 URI 行）。
export function firstVariant(masterText, masterUrl) {
  const lines = uriLines(masterText)
  return lines.length > 0 ? resolveUrl(masterUrl, lines[0]) : ''
}

// 解析 media playlist：返回 { targetDuration, mediaSequence, segments:[{url,duration}] }
// segments 为「播放列表里出现的分片 URI（已补全为绝对 URL）」，按出现顺序，token 查询串保留。
export function parseMediaPlaylist(text, playlistUrl) {
  const raw = String(text || '')
  let targetDuration = 0
  let mediaSequence = 0
  const mDur = /#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/i.exec(raw)
  const mSeq = /#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i.exec(raw)
  if (mDur) targetDuration = parseFloat(mDur[1]) || 0
  if (mSeq) mediaSequence = parseInt(mSeq[1], 10) || 0
  const segments = []
  let pendingDur = null
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) {
      const inf = /^#EXTINF:\s*([\d.]+)/i.exec(t)
      if (inf) pendingDur = parseFloat(inf[1]) || 0
      continue
    }
    segments.push({ url: resolveUrl(playlistUrl, t), duration: pendingDur })
    pendingDur = null
  }
  return { targetDuration, mediaSequence, segments }
}

// 智能入口：给任一 m3u8 文本 + 其 URL → 若 master 递归取第一个子列表再解析。
// media：返回 { kind:'media', targetDuration, mediaSequence, segments }
// master：返回 { kind:'master', variantUrl }
export function parseHlsPlaylist(text, url) {
  if (isMasterPlaylist(text)) {
    return { kind: 'master', variantUrl: firstVariant(text, url) }
  }
  return { kind: 'media', ...parseMediaPlaylist(text, url) }
}

// ---- TS → ADTS 剥壳（纯函数） ----

const TS_PACKET = 188
const TS_SYNC = 0x47

/**
 * 从一段 MPEG-TS 字节里剥出全部 AAC 音频净载（PES payload 拼接）。
 * 逐 188B 包：校验 sync；解 PID/PUSI/adaptation field；PUSI 包 payload 以 0x000001 开头
 * 且 stream_id ∈ 0xC0..0xDF（MPEG audio/AAC）→ 记为音频 PID；此后只收该 PID 净载，
 * PUSI 起始包剥 PES 头，余下净载拼接。
 * 返回 { audioPid, pesBytes, tsPackets, audioPackets, audioPesStart }（audioPesStart 供流式拼接用）。
 */
export function tsStripPes(tsBuf) {
  const n = Math.floor(tsBuf.length / TS_PACKET)
  let audioPid = -1
  const chunks = []
  let tsPackets = 0
  let audioPackets = 0
  let audioPesStart = -1 // 首个音频 PES 的净载起始偏移（供流式增量剥壳起点）
  for (let i = 0; i < n; i++) {
    const o = i * TS_PACKET
    if (tsBuf[o] !== TS_SYNC) continue
    tsPackets++
    const b1 = tsBuf[o + 1]
    const pid = ((b1 & 0x1f) << 8) | tsBuf[o + 2]
    const pusi = (b1 & 0x40) !== 0
    const afc = (tsBuf[o + 3] >> 4) & 0x3
    if (afc === 0) continue // reserved
    let p = o + 4
    if (afc === 2 || afc === 3) {
      const afl = tsBuf[o + 4] // adaptation_field_length
      p = o + 5 + afl
    }
    if (p >= o + TS_PACKET) continue // adaptation only, no payload
    const payload = tsBuf.subarray(p, o + TS_PACKET)
    if (pusi) {
      // 尝试识别 PES：起始码 0x000001
      if (payload.length >= 4 && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        const sid = payload[3]
        if (sid >= 0xc0 && sid <= 0xdf) {
          if (audioPid === -1) audioPesStart = p
          audioPid = pid
          audioPackets++
          chunks.push(stripPesHeader(payload))
          continue
        }
      }
      // 非音频 PES 起始包：跳过（其它流）
      continue
    }
    if (pid === audioPid) {
      audioPackets++
      chunks.push(payload)
    }
  }
  return { audioPid, pesBytes: Buffer.concat(chunks), tsPackets, audioPackets, audioPesStart }
}

// 剥 PES 头：0x000001 + stream_id + PES_packet_length(2)；常规流（byte6 '10' 前缀）
// 再剥 flags(1)+flags(1)+header_data_length(1)+可选头。容错：解析失败返回 payload.subarray(6)。
export function stripPesHeader(payload) {
  if (payload.length < 9) return payload.subarray(6)
  const b6 = payload[6]
  if ((b6 & 0xc0) === 0x80) {
    const hdrLen = payload[8]
    const start = 9 + hdrLen
    if (start <= payload.length) return payload.subarray(start)
    return payload.subarray(9)
  }
  return payload.subarray(6)
}

/**
 * ADTS 帧同步扫描：把「可能含缝隙/前缀垃圾」的字节流切成完整 ADTS 帧。
 * 返回 { frames:[Buffer], frameBytes, discarded }
 */
export function adtsSyncScan(buf) {
  const frames = []
  let i = 0
  let discarded = 0
  const len = buf.length
  while (i + 7 <= len) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xf6) !== 0xf0) {
      i++
      discarded++
      continue
    }
    const frameLen = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5)
    if (frameLen < 7 || i + frameLen > len) {
      discarded += len - i
      break
    }
    frames.push(buf.subarray(i, i + frameLen))
    i += frameLen
  }
  return { frames, frameBytes: frames.reduce((a, f) => a + f.length, 0), discarded }
}

// 便捷：TS Buffer → ADTS 帧（纯内存，测试/小样本用）。
export function tsToAdts(tsBuf) {
  const { pesBytes } = tsStripPes(tsBuf)
  const { frames } = adtsSyncScan(pesBytes)
  return Buffer.concat(frames)
}

// 探测一段字节是 MPEG-TS 容器还是裸 ADTS：
//   - TS：以 0x47 同步包开头（188B 对齐），前若干字节内 0x47 命中率高；
//   - ADTS：以 0xFFF 同步字开头。
// 返回 'ts' | 'adts' | 'unknown'（内容不足/无法判别时 unknown，由调用方按内容容错）。
export function detectSegmentContainer(buf) {
  if (!buf || buf.length < 16) return 'unknown'
  // TS：检查开头连续若干个 188B 边界是否都是 0x47
  if (buf[0] === 0x47) {
    let hits = 0
    const maxPkts = Math.min(8, Math.floor(buf.length / TS_PACKET))
    for (let i = 0; i < maxPkts; i++) {
      if (buf[i * TS_PACKET] === 0x47) hits++
    }
    if (hits >= Math.max(3, Math.ceil(maxPkts * 0.6))) return 'ts'
  }
  // ADTS：0xFFF 同步 + 帧长在合法范围
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) {
    const frameLen = ((buf[3] & 0x03) << 11) | (buf[4] << 3) | (buf[5] >> 5)
    if (frameLen >= 7 && frameLen <= 8191) return 'adts'
  }
  return 'unknown'
}

/**
 * 分片字节 → ADTS 帧数组（统一入口，兼容两种 HLS 音频分片容器）：
 *   - MPEG-TS 容器（广播级标准，CCTV/凤凰/央广等）：tsStripPes 剥壳 → adtsSyncScan；
 *   - 裸 ADTS（蜻蜓/喜马拉雅等直接 .aac 分片）：直接 adtsSyncScan。
 * 返回 { frames:[Buffer], container, frameBytes, discarded }
 * 两者都不是 → 抛 unsupported（明确报错，不静默）。
 */
export function segmentToAdts(buf) {
  if (!buf || buf.length === 0) throw new Error('unsupported: 空分片')
  const container = detectSegmentContainer(buf)
  let pes = null
  if (container === 'ts') {
    pes = tsStripPes(buf)
    if (pes.audioPid === -1 || pes.pesBytes.length === 0) {
      throw new Error('unsupported: TS 分片无 AAC 音频净载（可能非 AAC-in-TS）')
    }
    const { frames } = adtsSyncScan(pes.pesBytes)
    if (frames.length === 0) throw new Error('unsupported: TS 剥壳后无 ADTS 帧')
    return { frames, container, frameBytes: frames.reduce((a, f) => a + f.length, 0), discarded: 0 }
  }
  if (container === 'adts') {
    const { frames } = adtsSyncScan(buf)
    if (frames.length === 0) throw new Error('unsupported: ADTS 无有效帧')
    return { frames, container, frameBytes: frames.reduce((a, f) => a + f.length, 0), discarded: 0 }
  }
  // 未知：退化尝试——先按 TS 剥（可能前几字节垃圾），再按裸 ADTS 扫
  const tsFallback = tsStripPes(buf)
  if (tsFallback.audioPid !== -1 && tsFallback.pesBytes.length > 0) {
    const { frames } = adtsSyncScan(tsFallback.pesBytes)
    if (frames.length > 0) return { frames, container: 'ts', frameBytes: frames.reduce((a, f) => a + f.length, 0), discarded: 0 }
  }
  const adtsFallback = adtsSyncScan(buf)
  if (adtsFallback.frames.length > 0) return { frames: adtsFallback.frames, container: 'adts', frameBytes: adtsFallback.frameBytes, discarded: adtsFallback.discarded }
  throw new Error('unsupported: 分片既非 MPEG-TS 也非 ADTS（可能 fMP4/加密 HLS）')
}

// 判断一段 bytes 是否含 ADTS 同步字（用于剥壳后自检 / 探测）。
export function hasAdtsSync(buf, minFrames = 1) {
  let count = 0
  let i = 0
  const len = buf.length
  while (i + 7 <= len && count < minFrames) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0) {
      const frameLen = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5)
      if (frameLen >= 7 && i + frameLen <= len) { count++; i += frameLen; continue }
    }
    i++
  }
  return count >= minFrames
}

// ---- 网络小工具（对齐 radio.js 风格；调用方也可注入 fetchImpl） ----

export const HLS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) dsh-music-player/0.9 (hls)'

async function fetchText(url, fetchImpl, { timeoutMs = 15000, signal } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': HLS_UA }, signal: ctrl.signal, redirect: 'follow' })
    if (!r.ok) throw new Error('playlist http ' + r.status)
    return await r.text()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

async function fetchBuffer(url, fetchImpl, { timeoutMs = 20000, signal } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onAbort = () => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const r = await fetchImpl(url, { headers: { 'User-Agent': HLS_UA }, signal: ctrl.signal, redirect: 'follow' })
    if (!r.ok) throw new Error('segment http ' + r.status)
    const ab = await r.arrayBuffer()
    return Buffer.from(ab)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

// ---- 端到端：media playlist → ADTS 字节（一次快照） ----
// 拉当前 media playlist 的 segments 全部分片并剥壳（测试/小样本一次性用）。
export async function snapshotMediaToAdts(playlistUrl, { fetchImpl = fetch } = {}) {
  const text = await fetchText(playlistUrl, fetchImpl)
  const pl = parseHlsPlaylist(text, playlistUrl)
  if (pl.kind === 'master') throw new Error('snapshotMediaToAdts 收到 master（应先用 resolveMediaUrl 落到 media）')
  const out = []
  for (const seg of pl.segments) {
    const buf = await fetchBuffer(seg.url, fetchImpl)
    out.push(Buffer.concat(segmentToAdts(buf).frames))
  }
  return Buffer.concat(out)
}

// ---- 探测/解析：把任意 HLS URL（master 或 media）落到 media playlist ----
// 返回 { url: mediaUrl, playlist: parseMediaPlaylist 结果 }；
// 失败（拉取错误 / master 无子列表 / 嵌套超一层）直接抛错，供路由在「发响应头前」探测。
// 注：这会把 playlist 拉两遍（探测一次 + createHlsStream 正式拉一次）——live playlist
// 每拉一次窗口前进一点，属可接受开销；换来的是「确认可播后再回 200」的错误语义。
export async function resolveMediaPlaylist(playlistUrl, fetchImpl = fetch, signal, onStatus) {
  const status = (msg) => { if (typeof onStatus === 'function') onStatus(msg) }
  if (!playlistUrl) throw new Error('缺少 playlistUrl')
  let mediaUrl = playlistUrl
  let text = await fetchText(playlistUrl, fetchImpl, { signal })
  let pl = parseHlsPlaylist(text, playlistUrl)
  if (pl.kind === 'master') {
    if (!pl.variantUrl) throw new Error('master 无子列表 URL')
    status('master → variant')
    mediaUrl = pl.variantUrl
    text = await fetchText(mediaUrl, fetchImpl, { signal })
    pl = parseHlsPlaylist(text, mediaUrl)
    if (pl.kind === 'master') throw new Error('嵌套超过一层（暂不支持多层 master）')
  }
  return { url: mediaUrl, playlist: pl }
}

// ---- 流式转换器（生产核心）：持续产出 ADTS 字节 ----
// 用法：for await (const chunk of createHlsStream({ playlistUrl, signal })) { res.write(chunk) }
//   playlistUrl 可以是 master 或 media URL；内部自动递归到 media。
// 行为：
//   - 解析 playlist → 若是 master 递归取子列表 → 得到 media URL；
//   - 逐个拉取当前 segments（从第一个未播的开始）剥壳 yield（静默跳过拉取失败的分片，
//     连续失败达到阈值视为断流停止，由调用方/客户端重连兜底）；
//   - 播完当前列表后按 targetDuration 轮询重拉 playlist，增量拉新分片，直到 signal.aborted。
// 选项：{ fetchImpl, pollIntervalMs, maxGapErrors, signal, onStatus }
export async function* createHlsStream({ playlistUrl, fetchImpl = fetch, signal, pollIntervalMs, maxGapErrors = 5, onStatus } = {}) {
  if (!playlistUrl) throw new Error('缺少 playlistUrl')
  const status = (msg) => { if (onStatus) onStatus(msg) }
  const abortErr = () => (signal && signal.aborted ? new DOMException('Aborted', 'AbortError') : null)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const isAborted = () => !!(signal && signal.aborted)

  // 1) 落到 media URL（master 递归一层）
  const media = await resolveMediaPlaylist(playlistUrl, fetchImpl, signal, status)
  let mediaUrl = media.url
  let pl = media.playlist
  const targetDuration = pl.targetDuration || 5
  let pollMs = pollIntervalMs || Math.max(1000, Math.min(targetDuration * 1000 * 0.8, 10000))
  status('media targetDuration=' + targetDuration + 's, poll=' + pollMs + 'ms')

  let gapErrors = 0
  let mediaSeq = pl.mediaSequence // 最新 media sequence（供轮询续拉记录/诊断）
  let seen = new Set() // 只记录「成功播过」的分片 URL；失败不记录 → 轮询时会再次出现并重试

  // 拉一个分片并剥壳 → 返回 ADTS 帧数组（调用方展开为字节块）。
  // 成功即把 url 记入 seen；失败抛错（AbortError 直传，unsupported 直传，其余网络错由调用方计 gap）。
  async function fetchSegmentAdts(url) {
    const buf = await fetchBuffer(url, fetchImpl, { signal })
    // 兼容两种 HLS 音频分片容器：MPEG-TS（CCTV/凤凰/央广）与裸 ADTS（蜻蜓/喜马拉雅 .aac 分片）。
    const { frames, container } = segmentToAdts(buf)
    status('seg ✓ [' + container + '] ' + frames.length + ' ADTS frames')
    seen.add(url)
    return frames
  }

  // 展开一个分片的 ADTS 帧数组为连续字节块
  async function* emitSegment(url) {
    const frames = await fetchSegmentAdts(url)
    let acc = []
    let accLen = 0
    for (const f of frames) { acc.push(f); accLen += f.length }
    if (accLen > 0) yield Buffer.concat(acc, accLen)
  }

  // 播一个分片并处理失败语义：yield 其字节块；成功清 gap（恢复），失败（非 Abort/unsupported）计 gap。
  async function* playSegment(seg) {
    try {
      yield* emitSegment(seg.url)
      gapErrors = 0 // 播出成功 → 连续失败中断，恢复计数
    } catch (err) {
      if (err && err.name === 'AbortError') throw err
      if (String(err && err.message || err).startsWith('unsupported:')) throw err
      gapErrors++
    }
  }

  // 首次：播当前 media 窗口（live 从「现在」开始）。分片拉取失败 → gap 累积（连失超阈值即断流）。
  for (const seg of pl.segments) {
    if (isAborted()) throw abortErr()
    yield* playSegment(seg)
    if (gapErrors >= maxGapErrors) { status('gap: 连续 ' + gapErrors + ' 个分片失败，断流'); break }
  }

  // 2) 轮询续拉：每次重拉 playlist，播「尚未成功播过」的新分片。
  //    live playlist 滚动：MEDIA-SEQUENCE 前进 + 末尾追加新分片；旧分片过期剔除。
  //    成功过的分片在 seen 里不会重播；失败过的分片不在 seen，下轮 fresh 会再含它 → 重试。
  while (!isAborted()) {
    await sleep(pollMs)
    if (isAborted()) throw abortErr()
    let fresh
    try {
      const text = await fetchText(mediaUrl, fetchImpl, { signal })
      const p2 = parseHlsPlaylist(text, mediaUrl)
      if (p2.kind !== 'media') continue // 子列表意外变 master，忽略本轮
      if (p2.targetDuration) pollMs = Math.min(pollMs, Math.max(1000, p2.targetDuration * 1000 * 0.8)) // 保守收敛
      fresh = p2.segments.filter((s) => !seen.has(s.url))
      mediaSeq = p2.mediaSequence
    } catch (err) {
      if (err && err.name === 'AbortError') throw err
      gapErrors++
      if (gapErrors >= maxGapErrors) { status('gap: playlist 连续拉取失败 ' + gapErrors + ' 次，断流'); break }
      continue
    }
    // 注意：列表拉取成功不清分片侧 gapErrors——gap 只在「成功播出一个分片」时清零
    //（playSegment 内），否则连续分片失败会被每轮的列表成功掩盖、永远到不了断流阈值。
    for (const seg of fresh) {
      if (isAborted()) throw abortErr()
      yield* playSegment(seg)
      if (gapErrors >= maxGapErrors) { status('gap: 连续 ' + gapErrors + ' 个分片失败，断流'); break }
    }
    if (gapErrors >= maxGapErrors) break
  }
}

// ---- 便捷：media URL 探测（HEAD 或首段）----
export function looksLikeM3u8(url) {
  return /\.m3u8(\?|$)/i.test(String(url || ''))
}

export default { isMasterPlaylist, resolveUrl, firstVariant, parseMediaPlaylist, parseHlsPlaylist, tsStripPes, stripPesHeader, adtsSyncScan, tsToAdts, hasAdtsSync, detectSegmentContainer, segmentToAdts, resolveMediaPlaylist, createHlsStream, snapshotMediaToAdts, looksLikeM3u8 }
