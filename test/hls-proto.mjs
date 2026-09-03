/**
 * test/hls-proto.mjs — HLS 播放方案「最后不确定点」原型验证（纯 Node 零依赖）。
 *
 * 目的：验证两条核心纯函数 + 一条端到端结论——
 *   1) m3u8 解析：master/media 判别、#EXT-X-STREAM-INF 子列表、分片 URL 补全；
 *   2) MPEG-TS → 裸 ADTS 剥壳：188B 包 → PES 净载 → ADTS 帧同步；
 *   3) 剥壳产物可被解码（ffprobe 解出 AAC-LC）+ 与 ffmpeg -c:a copy -f adts 基准
 *      对比（帧数/时长接近）→ 证明「ADTS 连续流」是 Chromium <audio> 可直接消费的形态。
 *
 * 运行：node test/hls-proto.mjs [样本路径...]
 *   默认读 /tmp 下已抓取的真实分片；也可传路径。最后用实时 m3u8 拉一遍（网络）。
 *
 * 这些纯函数通过验证后将平移到 lib/hls.js（生产模块），此文件本身不进产物。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/* ============================ m3u8 解析（纯函数） ============================ */

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

// 取 master 的第一个可用子列表 URL（无 #EXT-X-STREAM-INF 属性解析需要——取紧随其后的行）。
export function firstVariant(masterText, masterUrl) {
  const lines = uriLines(masterText)
  return lines.length > 0 ? resolveUrl(masterUrl, lines[0]) : ''
}

// 解析 media playlist：返回 { targetDuration, mediaSequence, segments: [{url, duration}] }
// segments 为「播放列表里出现的分片 URI（已补全为绝对 URL）」，按出现顺序。
export function parseMediaPlaylist(text, playlistUrl) {
  const raw = String(text || '')
  let targetDuration = 0
  let mediaSequence = 0
  const durRe = /#EXT-X-TARGETDURATION:\s*(\d+(?:\.\d+)?)/i
  const seqRe = /#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i
  const mDur = durRe.exec(raw)
  const mSeq = seqRe.exec(raw)
  if (mDur) targetDuration = parseFloat(mDur[1]) || 0
  if (mSeq) mediaSequence = parseInt(mSeq[1], 10) || 0
  const lines = String(raw).split(/\r?\n/)
  const segments = []
  let pendingDur = null
  for (const line of lines) {
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
// 返回 { kind: 'master'|'media', targetDuration, mediaSequence, segments, variantUrl? }
export function parseHlsPlaylist(text, url) {
  if (isMasterPlaylist(text)) {
    const variantUrl = firstVariant(text, url)
    return { kind: 'master', variantUrl }
  }
  return { kind: 'media', ...parseMediaPlaylist(text, url) }
}

/* ============================ TS → ADTS 剥壳（纯函数） ============================ */

const TS_PACKET = 188
const SYNC = 0x47

/**
 * 从一段 MPEG-TS 字节里剥出全部 AAC 音频净载（PES payload 拼接）。
 *
 * 做法（对齐 ffprobe 实测：主流中文 HLS 台是 AAC-LC-in-TS，PMT 常为空节目，
 * 不能依赖 PAT/PMT 的 ES 列表）：
 *   - 逐 188B 包走：校验 sync 0x47；解 PID 与 PUSI；
 *   - 识别「音频 PID」：PUSI 包 payload 以 0x000001 开头且 stream_id ∈ 0xC0..0xDF
 *     （MPEG audio / AAC）→ 该 PID 记为音频流；此后只收此 PID 的净载；
 *   - 每个音频包剥 TS 头 + adaptation field，PUSI 起始包再剥 PES 头，余下净载拼接。
 * 返回 { audioPid, pesBytes, tsPackets, audioPackets }
 */
export function tsStripPes(tsBuf) {
  const n = Math.floor(tsBuf.length / TS_PACKET)
  let audioPid = -1
  const chunks = []
  let tsPackets = 0
  let audioPackets = 0
  for (let i = 0; i < n; i++) {
    const o = i * TS_PACKET
    if (tsBuf[o] !== SYNC) continue
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
  return { audioPid, pesBytes: Buffer.concat(chunks), tsPackets, audioPackets }
}

// 剥 PES 头：0x000001 + stream_id + PES_packet_length(2)；
// 常规流（byte6 '10' 前缀）再剥 flags(1)+flags(1)+header_data_length(1)+可选头。
// 容错：任何一步解析失败 → 返回「从 payload 里找 ADTS 同步字」的退化结果。
export function stripPesHeader(payload) {
  if (payload.length < 9) return payload.subarray(6)
  const sid = payload[3]
  // PES_packet_length 之后，常规音频流必有 '10' 前缀 + PTS_DTS_flags 等
  const b6 = payload[6]
  if ((b6 & 0xc0) === 0x80) {
    const hdrLen = payload[8]
    const start = 9 + hdrLen
    if (start <= payload.length) return payload.subarray(start)
    return payload.subarray(9) // 容错：头长越界，尽量往前
  }
  // 无 '10' 前缀的裸净载（少见）：尝试跳过 PES 基本头
  return payload.subarray(6)
}

/**
 * ADTS 帧同步扫描：把「可能含缝隙/前缀垃圾」的字节流切成完整 ADTS 帧。
 * 返回 { frames: Buffer[], 完整帧字节数, 丢弃字节数, syncErrors }
 * 每帧校验：0xFFF 同步 + 帧长 ≥ 7 + 帧长 ≤ 8191 + 落在缓冲区内。
 */
export function adtsSyncScan(buf) {
  const frames = []
  let i = 0
  let discarded = 0
  let syncErrors = 0
  const len = buf.length
  while (i + 7 <= len) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xf6) !== 0xf0) {
      i++
      discarded++
      continue
    }
    const frameLen = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5)
    if (frameLen < 7 || i + frameLen > len) {
      // 帧长越界 → 视为噪声（尾部不完整帧），放弃剩余
      discarded += len - i
      break
    }
    frames.push(buf.subarray(i, i + frameLen))
    i += frameLen
  }
  return { frames, frameBytes: frames.reduce((a, f) => a + f.length, 0), discarded, syncErrors }
}

// 便捷：TS → 完整 ADTS 帧数组
export function tsToAdtsFrames(tsBuf) {
  const { pesBytes } = tsStripPes(tsBuf)
  const sync = adtsSyncScan(pesBytes)
  return {
    ...sync,
    audioPid: tsStripPes(tsBuf).audioPid,
    adts: Buffer.concat(sync.frames),
  }
}

/* ============================ 验证逻辑（main） ============================ */

function fmt(n) {
  return Number(n).toLocaleString('en-US')
}

function probeSummary(path) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', path], { encoding: 'utf8' })
    const g = (re) => { const m = re.exec(out); return m ? m[1] : '?' }
    return {
      codec: g(/codec_name=(\w+)/), profile: g(/profile=(\w+)/),
      rate: g(/sample_rate=(\d+)/), channels: g(/channels=(\d+)/),
      duration: g(/duration=([\d.]+)/),
    }
  } catch (e) {
    return { error: String(e.message).slice(0, 80) }
  }
}

export async function verifyRealSegment(filePath, label) {
  const ts = readFileSync(filePath)
  const { audioPid, pesBytes, tsPackets, audioPackets } = tsStripPes(ts)
  const sync = adtsSyncScan(pesBytes)
  const adts = Buffer.concat(sync.frames)
  const outPath = filePath.replace(/\.ts$/, '') + '.proto.aac'
  writeFileSync(outPath, adts)

  // ffmpeg 基准：同输入 -c:a copy -f adts（参考实现）
  const refPath = filePath.replace(/\.ts$/, '') + '.ref.aac'
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', filePath, '-c:a', 'copy', '-f', 'adts', refPath])
  } catch { /* ffmpeg 不可用时跳过基准对比 */ }

  const mine = probeSummary(outPath)
  const ref = existsSync(refPath) ? probeSummary(refPath) : null
  const refFrames = ref && existsSync(refPath) ? null : null
  let refFramesCount = null
  if (existsSync(refPath)) {
    try {
      refFramesCount = parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', refPath], { encoding: 'utf8' }).trim(), 10)
    } catch { refFramesCount = null }
  }

  return {
    label,
    size: ts.length,
    tsPackets, audioPackets, audioPid,
    pesBytes: pesBytes.length,
    adtsFrames: sync.frames.length,
    adtsBytes: adts.length,
    discarded: sync.discarded,
    outPath, refPath,
    mine, ref,
    refFramesCount,
    ratio: refFramesCount ? (100 * sync.frames.length / refFramesCount).toFixed(1) + '%' : 'n/a',
  }
}

export async function run() {
  console.log('=== HLS 原型验证：TS → ADTS 剥壳（真实分片） ===\n')
  const files = process.argv.slice(2)
  const results = []
  if (files.length === 0) {
    // 默认用已抓取样本
    const defaults = ['/tmp/hls_bundle2.ts', '/tmp/ph1.ts', '/tmp/cnr1.ts']
    for (const f of defaults) if (existsSync(f)) files.push(f)
  }
  for (const f of files) {
    if (!existsSync(f)) { console.log(`跳过不存在: ${f}`); continue }
    const r = await verifyRealSegment(f, f)
    results.push(r)
    console.log(`\n--- ${r.label} (${fmt(r.size)} B) ---`)
    console.log(`TS包=${fmt(r.tsPackets)}  音频PID=${r.audioPid}  音频包=${fmt(r.audioPackets)}  PES净载=${fmt(r.pesBytes)}B`)
    console.log(`剥壳→ADTS帧=${fmt(r.adtsFrames)}  (${fmt(r.adtsBytes)}B)  丢弃=${fmt(r.discarded)}B  同步帧率=${(100 * r.adtsFrames / Math.max(1, Math.floor(r.pesBytes / 20))).toFixed(2)}%`)
    console.log(`  我剥壳 ffprobe : ${r.mine.codec} ${r.mine.profile} ${r.mine.rate}Hz ${r.mine.channels}ch ${r.mine.duration}s`)
    if (r.ref) console.log(`  ffmpeg 基准     : ${r.ref.codec} ${r.ref.profile} ${r.ref.rate}Hz ${r.ref.channels}ch ${r.ref.duration}s  (帧数=${r.refFramesCount ?? '?'})`)
    if (r.refFramesCount) console.log(`  帧数对比: mine=${r.adtsFrames} vs ffmpeg=${r.refFramesCount} → ${r.ratio}`)
  }
  console.log('\n=== 结论 ===')
  for (const r of results) {
    const ok = r.mine.codec === 'aac' && r.mine.profile === 'LC' && r.adtsFrames > 0
    console.log(`${ok ? '✅' : '❌'} ${r.label}: ${ok ? '剥壳成功，AAC-LC 可解码' : '剥壳异常: ' + JSON.stringify(r.mine)}`)
  }
  return results
}

/* ============================ m3u8 解析验证（真实 fixture） ============================ */

export function verifyM3u8Fixtures() {
  console.log('\n=== m3u8 解析验证（真实 fixture）===\n')
  const dir = new URL('./fixtures/hls/', import.meta.url)
  const read = (name) => readFileSync(new URL(name, dir), 'utf8')
  const checks = []

  // 1) CCTV media：相对子目录分片 → 应补全为绝对 URL
  const cctvUrl = 'https://piccpndali.v.myalicdn.com/audio/cctv13_2.m3u8'
  const cctv = parseMediaPlaylist(read('cctv-media.m3u8'), cctvUrl)
  checks.push(['CCTV: master 判别=false', isMasterPlaylist(read('cctv-media.m3u8')) === false])
  checks.push(['CCTV: targetDuration=11', cctv.targetDuration === 11])
  checks.push(['CCTV: 4 分片', cctv.segments.length === 4])
  const seg0 = cctv.segments[0].url
  checks.push(['CCTV: 相对分片补全绝对', seg0 === 'https://piccpndali.v.myalicdn.com/audio/cctv13_audio/1788400708_14277217.ts'])
  checks.push(['CCTV: EXTINF 时长', Math.abs(cctv.segments[0].duration - 10.005) < 0.001])
  checks.push(['CCTV: mediaSequence', cctv.mediaSequence === 14277217])

  // 2) 凤凰 media：分片带 ?txspiseq= token → 必须原样保留（token 是防盗链鉴权）
  const ifengUrl = 'http://playtv-live.ifeng.com/live/06OLEEWQKN4_audio.m3u8'
  const ifeng = parseMediaPlaylist(read('ifeng-media.m3u8'), ifengUrl)
  checks.push(['凤凰: 分片 token 保留', /txspiseq=/.test(ifeng.segments[0].url)])
  checks.push(['凤凰: 相对+token 补全', ifeng.segments[0].url.startsWith('http://playtv-live.ifeng.com/live/06OLEEWQKN4_audio-') && ifeng.segments[0].url.includes('?txspiseq=')])

  // 3) 中国之声 master：嵌套 → 应判 master 并取出子列表绝对 URL（带 wsSession token）
  const masterUrl = 'http://zbbf2.ahbztv.com/live/4f3.m3u8'
  const masterText = read('ahbztv-master.m3u8')
  checks.push(['中国之声: master 判别=true', isMasterPlaylist(masterText) === true])
  const variant = parseHlsPlaylist(masterText, masterUrl)
  checks.push(['中国之声: kind=master', variant.kind === 'master'])
  checks.push(['中国之声: 子列表 URL 绝对且带 token', variant.variantUrl.startsWith('http://') && variant.variantUrl.includes('wsSession=') && variant.variantUrl.includes('.m3u8')])

  // 4) 中国之声 media：子列表分片带完整 token（含 wsApp）
  const mediaText = read('ahbztv-media.m3u8')
  const childUrl = variant.variantUrl || masterUrl
  const media = parseMediaPlaylist(mediaText, childUrl)
  checks.push(['中国之声 media: 分片非空', media.segments.length > 0])
  checks.push(['中国之声 media: 分片绝对且继承 token', media.segments[0].url.startsWith('http://') && media.segments[0].url.includes('wsSession=') && media.segments[0].url.includes('.ts')])

  // 5) 合成边界：master 里 #EXT-X-STREAM-INF 与 URI 之间允许空行/注释；绝对 URL 直通
  const synthMaster = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\n# 注释行\n\nhttps://cdn.example.com/variant/stream.m3u8?x=1\n'
  const sm = parseHlsPlaylist(synthMaster, 'http://origin/live.m3u8')
  checks.push(['合成 master: 子列表绝对 URL 直通', sm.variantUrl === 'https://cdn.example.com/variant/stream.m3u8?x=1'])

  // 6) 合成边界：没有 EXTINF 的裸分片行（某些台省略）
  const bare = parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\nseg1.ts\nseg2.ts\n', 'https://cdn.example.com/live/p.m3u8')
  checks.push(['裸分片无 EXTINF 也能解析', bare.segments.length === 2 && bare.segments[0].url === 'https://cdn.example.com/live/seg1.ts'])

  // 7) 滚动续拉核心：mediaSequence 前进 + 新分片追加 → 增量识别
  const older = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2,\na100.ts\n#EXTINF:2,\na101.ts\n'
  const newer = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:101\n#EXTINF:2,\na101.ts\n#EXTINF:2,\na102.ts\n#EXTINF:2,\na103.ts\n'
  const p1 = parseMediaPlaylist(older, 'https://cdn/live/p.m3u8')
  const p2 = parseMediaPlaylist(newer, 'https://cdn/live/p.m3u8')
  const p2urls = new Set(p2.segments.map((s) => s.url))
  const fresh = p2.segments.filter((s) => !p1.segments.some((x) => x.url === s.url))
  checks.push(['滚动续拉: 新列表含 2 个新分片', fresh.length === 2 && fresh[0].url.endsWith('a102.ts')])
  checks.push(['滚动续拉: mediaSequence 前进', p2.mediaSequence === 101 && p1.mediaSequence === 100])

  let pass = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}`)
    if (ok) pass++
  }
  console.log(`\nm3u8 解析: ${pass}/${checks.length} 通过`)
  return checks.length > 0 && pass === checks.length
}

// 直接运行（node test/hls-proto.mjs）
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('hls-proto.mjs')) {
  const m3u8ok = verifyM3u8Fixtures()
  run().then((r) => {
    const tsOk = r.every((x) => x.mine.codec === 'aac' && x.adtsFrames > 0)
    console.log(`\n===== 汇总: m3u8=${m3u8ok ? '✅' : '❌'}  TS→ADTS=${tsOk ? '✅' : '❌'} =====`)
    process.exit(m3u8ok && tsOk ? 0 : 1)
  }).catch((e) => { console.error(e); process.exit(1) })
}
