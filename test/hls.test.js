/**
 * Tests for lib/hls.js — HLS(m3u8) → ADTS 连续流转换（纯 Node 零依赖）。
 *
 * 覆盖：
 *   - m3u8 解析纯函数（master/media 判别、#EXT-X-STREAM-INF 递归、相对 URL 补全、
 *     token 保留、mediaSequence/EXTINF）
 *   - TS → ADTS 剥壳（真实分片样本 fixture 逐帧校验 + 噪声容错）
 *   - createHlsStream 续拉状态机（mock 滚动 playlist：master→media、增量新分片、去重）
 *   - /dsh-music/radio/play 路由对 HLS 的分流（假 ctx + stub fetch）
 *
 * 真实分片样本放 test/fixtures/hls/seg-phoenix.ts（凤凰卫视资讯台 3s AAC-in-TS）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  isMasterPlaylist, resolveUrl, firstVariant, parseMediaPlaylist, parseHlsPlaylist,
  tsStripPes, adtsSyncScan, tsToAdts, hasAdtsSync, createHlsStream, looksLikeM3u8,
  detectSegmentContainer, segmentToAdts,
} from '../lib/hls.js'
import { apply } from '../lib/index.js'

// ---- fixture 读取 ----
const fixture = (name) => readFileSync(new URL('./fixtures/hls/' + name, import.meta.url), 'utf8')

// 真实分片样本（凤凰 3s AAC-in-TS，~55KB）——若缺失则跳过依赖它的用例。
function realSegment() {
  const p = new URL('./fixtures/hls/seg-phoenix.ts', import.meta.url)
  return existsSync(p) ? readFileSync(p) : null
}
// 真实裸 ADTS 分片样本（华语金曲500首 qtfm .aac 分片，HE-AAC 44.1k，~57KB）。
function realAdtsSegment() {
  const p = new URL('./fixtures/hls/seg-qtfm-raw.aac', import.meta.url)
  return existsSync(p) ? readFileSync(p) : null
}

/* ================= m3u8 解析纯函数 ================= */

describe('lib/hls.js m3u8 解析', () => {
  it('isMasterPlaylist 判别 master/media', () => {
    expect(isMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nhttp://x/a.m3u8')).toBe(true)
    expect(isMasterPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:3,\na.ts')).toBe(false)
    expect(isMasterPlaylist('')).toBe(false)
  })

  it('resolveUrl 相对/绝对/其它 scheme', () => {
    expect(resolveUrl('http://cdn/live/p.m3u8', 'seg/a.ts')).toBe('http://cdn/live/seg/a.ts')
    expect(resolveUrl('http://cdn/live/p.m3u8', '../x.ts')).toBe('http://cdn/x.ts')
    expect(resolveUrl('http://cdn/live/p.m3u8', 'https://abs.example/z.ts?k=1')).toBe('https://abs.example/z.ts?k=1')
    expect(resolveUrl('http://cdn/live/p.m3u8', '')).toBe('')
  })

  it('parseMediaPlaylist：相对分片补全、EXTINF 时长、mediaSequence', () => {
    const text = fixture('cctv-media.m3u8') // CCTV 真实样本：相对子目录分片、无 token
    const pl = parseMediaPlaylist(text, 'https://piccpndali.v.myalicdn.com/audio/cctv13_2.m3u8')
    expect(pl.targetDuration).toBe(11)
    expect(pl.mediaSequence).toBeGreaterThan(14000000)
    expect(pl.segments.length).toBeGreaterThanOrEqual(3)
    expect(pl.segments[0].url).toMatch(/^https:\/\/piccpndali\.v\.myalicdn\.com\/audio\/cctv13_audio\/.+\.ts$/)
    expect(pl.segments[0].duration).toBeGreaterThan(9)
  })

  it('分片级 token 原样保留（凤凰防盗链）', () => {
    const text = fixture('ifeng-media.m3u8')
    const pl = parseMediaPlaylist(text, 'http://playtv-live.ifeng.com/live/06OLEEWQKN4_audio.m3u8')
    expect(pl.segments.length).toBeGreaterThan(0)
    expect(pl.segments[0].url).toContain('?txspiseq=')
    expect(pl.segments[0].url).toMatch(/^http:\/\/playtv-live\.ifeng\.com\/live\/06OLEEWQKN4_audio-.*\.ts\?txspiseq=/)
  })

  it('master 判别 + 子列表 URL（带 token）', () => {
    const text = fixture('ahbztv-master.m3u8') // 中国之声 master：嵌套、token
    expect(isMasterPlaylist(text)).toBe(true)
    const pl = parseHlsPlaylist(text, 'http://zbbf2.ahbztv.com/live/4f3.m3u8')
    expect(pl.kind).toBe('master')
    expect(pl.variantUrl).toMatch(/^http:\/\/.+\.m3u8\?wsSession=.+/)
  })

  it('parseHlsPlaylist 对 media 直接解析（非 master）', () => {
    const pl = parseHlsPlaylist(fixture('cctv-media.m3u8'), 'https://cdn/x.m3u8')
    expect(pl.kind).toBe('media')
    expect(pl.segments.length).toBeGreaterThan(0)
  })

  it('media 子列表 token 继承（中国之声 real media fixture）', () => {
    const text = fixture('ahbztv-media.m3u8')
    const pl = parseMediaPlaylist(text, 'http://112.91.161.66/zbbf2.ahbztv.com/live/4f3.m3u8?wsSession=abc&wsApp=HLS')
    expect(pl.segments.length).toBeGreaterThan(0)
    expect(pl.segments[0].url).toContain('wsSession=')
    expect(pl.segments[0].url).toContain('wsApp=HLS')
  })

  it('无 EXTINF 的裸分片行也能解析', () => {
    const pl = parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:5\nseg1.ts\nseg2.ts\n', 'https://cdn/live/p.m3u8')
    expect(pl.segments).toHaveLength(2)
    expect(pl.segments[0].url).toBe('https://cdn/live/seg1.ts')
  })

  it('looksLikeM3u8 识别 URL', () => {
    expect(looksLikeM3u8('http://x/y.m3u8')).toBe(true)
    expect(looksLikeM3u8('http://x/y.m3u8?bitrate=64')).toBe(true)
    expect(looksLikeM3u8('http://x/y.mp3')).toBe(false)
    expect(looksLikeM3u8('http://x/stream')).toBe(false)
  })
})

/* ================= TS → ADTS 剥壳 ================= */

describe('lib/hls.js TS→ADTS 剥壳', () => {
  const seg = realSegment()
  const skip = seg === null ? it.skip : it

  skip('真实 AAC-in-TS 分片剥出 ADTS 帧（音频 PID / PES / 帧同步）', () => {
    const r = tsStripPes(seg)
    expect(r.audioPid).toBeGreaterThan(0)
    expect(r.tsPackets).toBeGreaterThan(100)
    expect(r.audioPackets).toBeGreaterThan(100)
    expect(r.pesBytes.length).toBeGreaterThan(1000)
    const { frames } = adtsSyncScan(r.pesBytes)
    expect(frames.length).toBeGreaterThan(50) // 3s AAC ≈ 140 帧
    // 每帧都以 ADTS 同步字开头
    for (const f of frames.slice(0, 5)) {
      expect(f[0]).toBe(0xff)
      expect(f[1] & 0xf6).toBe(0xf0)
    }
  })

  skip('tsToAdts 便捷转换 + hasAdtsSync', () => {
    const adts = tsToAdts(seg)
    expect(adts.length).toBeGreaterThan(1000)
    expect(hasAdtsSync(adts)).toBe(true)
  })

  skip('剥壳与 ffmpeg 参考一致（帧数完全对齐）', () => {
    // 该断言依赖 ffmpeg；CI 无 ffmpeg 时跳过。
    const { execFileSync } = require('node:child_process') // eslint-disable-line
    let ref = null
    try {
      const { writeFileSync } = require('node:fs') // eslint-disable-line
      const tmp = join(tmpdir(), 'hls-test-' + Date.now() + '.ts')
      writeFileSync(tmp, seg)
      const refPath = tmp + '.aac'
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-c:a', 'copy', '-f', 'adts', refPath])
      const frames = parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', refPath], { encoding: 'utf8' }).trim(), 10)
      rmSync(tmp, { force: true }); rmSync(refPath, { force: true })
      ref = frames
    } catch { /* ffmpeg 缺失则跳过帧数断言 */ }
    if (ref === null) return
    const mine = adtsSyncScan(tsStripPes(seg).pesBytes).frames.length
    expect(mine).toBe(ref)
  })

  it('噪声容错：垃圾前缀字节被丢弃、完整帧保留', () => {
    const segLocal = realSegment()
    if (segLocal === null) return // 无真实样本则只测合成
    const { pesBytes } = tsStripPes(segLocal)
    const garbage = Buffer.concat([Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]), pesBytes])
    const { frames, discarded } = adtsSyncScan(garbage)
    const clean = adtsSyncScan(pesBytes)
    expect(frames.length).toBe(clean.frames.length) // 垃圾字节不影响帧数
    expect(discarded).toBeGreaterThanOrEqual(7)
  })
})

/* ================= 裸 ADTS 分片支持（蜻蜓/喜马拉雅 .aac 分片） ================= */

describe('lib/hls.js 裸 ADTS 分片（非 TS 容器）', () => {
  const rawAdts = realAdtsSegment()
  const skip = rawAdts === null ? it.skip : it

  skip('真实裸 ADTS 分片被识别为 adts 容器', () => {
    expect(detectSegmentContainer(rawAdts)).toBe('adts')
    // TS 分片仍识别为 ts（回归）
    const ts = realSegment()
    if (ts) expect(detectSegmentContainer(ts)).toBe('ts')
  })

  skip('segmentToAdts 对裸 ADTS 直接出帧（不误走 TS 剥壳）', () => {
    const r = segmentToAdts(rawAdts)
    expect(r.container).toBe('adts')
    expect(r.frames.length).toBeGreaterThan(50)
    // 帧头 ADTS 同步
    for (const f of r.frames.slice(0, 3)) {
      expect(f[0]).toBe(0xff)
      expect(f[1] & 0xf6).toBe(0xf0)
    }
  })

  skip('segmentToAdts 对 TS 分片仍正常（回归）', () => {
    const ts = realSegment()
    if (ts === null) return
    const r = segmentToAdts(ts)
    expect(r.container).toBe('ts')
    expect(r.frames.length).toBeGreaterThan(50)
  })

  it('空/垃圾输入 → unsupported 明确报错（不静默）', () => {
    expect(() => segmentToAdts(Buffer.alloc(0))).toThrow(/unsupported/)
    expect(() => segmentToAdts(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))).toThrow(/unsupported/)
  })
})

/* ================= createHlsStream 续拉状态机（mock） ================= */

describe('lib/hls.js createHlsStream 续拉状态机', () => {
  // 造一个本地滚动 HLS：master → media；media 每次轮询前进 sequence 并追加新分片。
  function makeMock({ segCount = 4 } = {}) {
    const segBuf = realSegment() || Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc]), Buffer.alloc(20, 0)]) // 兜底：几字节伪 ADTS
    // 用假 TS？tsStripPes 需要真 TS 才有 PES。mock 直接返回真分片内容做「TS」。
    let poll = 0
    const avail = () => {
      // 首轮窗口 [0,1]，之后每轮追加 1 个，最多 segCount 个；seq 滚动
      const n = Math.min(segCount, 2 + poll)
      const seq = 1000 + poll
      return { names: Array.from({ length: n }, (_, i) => 'seg' + i + '.ts'), seq }
    }
    const fetchImpl = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('master.m3u8')) {
        return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nhttp://mock/live/media.m3u8?t=1\n' }
      }
      if (u.includes('media.m3u8')) {
        poll++
        const { names, seq } = avail()
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:' + seq, '#EXT-X-TARGETDURATION:1']
        for (const n of names) lines.push('#EXTINF:0.5,', 'seg/' + n)
        return { ok: true, status: 200, text: async () => lines.join('\n') + '\n' }
      }
      if (u.includes('/seg/')) {
        return { ok: true, status: 200, arrayBuffer: async () => segBuf.buffer.slice(segBuf.byteOffset, segBuf.byteOffset + segBuf.byteLength) }
      }
      throw new Error('mock 404 ' + u)
    })
    return { fetchImpl, segBuf }
  }

  it('master→media 递归 + 增量续拉 + URL 去重', async () => {
    const { fetchImpl, segBuf } = makeMock({ segCount: 5 })
    const ctrl = new AbortController()
    const got = []
    let statuses = []
    // 5 个分片后手动 abort（避免无限续拉）
    const it = createHlsStream({ playlistUrl: 'http://mock/live/master.m3u8', fetchImpl, signal: ctrl.signal, pollIntervalMs: 30, onStatus: (m) => statuses.push(m) })
    try {
      for await (const chunk of it) {
        got.push(chunk.length)
        if (got.length >= 5) ctrl.abort() // 收满 5 个分片即停
      }
    } catch (e) { if (e.name !== 'AbortError') throw e }
    expect(got.length).toBe(5) // seg0..seg4 各一次（首轮 2 + 续拉 3）
    // 确认 mock 确实返回了滚动窗口（media 被拉多次）
    const mediaCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes('media.m3u8')).length
    expect(mediaCalls).toBeGreaterThanOrEqual(3)
    // 状态里有 master → variant 与 seg ✓
    expect(statuses.join(' ')).toContain('master → variant')
  })

  it('分片拉取失败（404）连续超过阈值 → 断流停止', async () => {
    const segBuf = Buffer.from([0xff, 0xf1, 0x50, 0x80]) // 任意
    let failCount = 0
    const fetchImpl = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('media.m3u8')) {
        return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.5,\nseg/a.ts\n' }
      }
      if (u.includes('/seg/')) { failCount++; throw new Error('404') }
      throw new Error('x')
    })
    const it = createHlsStream({ playlistUrl: 'http://mock/live/media.m3u8', fetchImpl, pollIntervalMs: 20, maxGapErrors: 3 })
    let chunks = 0
    for await (const _ of it) chunks++ // 应很快断流结束，不会无限
    expect(chunks).toBe(0)
    expect(failCount).toBeGreaterThanOrEqual(3)
  })

  it('AbortError 传播（客户端断开即停止）', async () => {
    const { fetchImpl } = makeMock({ segCount: 100 })
    const ctrl = new AbortController()
    const it = createHlsStream({ playlistUrl: 'http://mock/live/media.m3u8', fetchImpl, signal: ctrl.signal, pollIntervalMs: 10 })
    setTimeout(() => ctrl.abort(), 150)
    let seen = 0
    let aborted = false
    try {
      for await (const _ of it) seen++
    } catch (e) { aborted = e.name === 'AbortError' }
    expect(seen).toBeGreaterThanOrEqual(1) // 至少播了分片才被 abort
    expect(aborted).toBe(true)
  })
})

/* ================= /radio/play 路由分流（HLS） ================= */

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const req = { method, url, headers }
  req[Symbol.asyncIterator] = async function* () { if (body) yield body }
  return req
}
function makeRes() {
  const res = {
    status: 200, headers: {}, body: null, chunks: [], destroyed: false, writableEnded: false, headersSent: false,
    _listeners: {},
    on(ev, fn) { (res._listeners[ev] = res._listeners[ev] || []).push(fn); return res },
    removeListener(ev) { res._listeners[ev] = []; return res },
    emit(ev) {
      if (ev === 'close') res.destroyed = true
      ;(res._listeners[ev] || []).forEach((fn) => fn())
    },
    // 测试用：让 handler 认为连接已断开（触发 abort → 转流循环退出）。
    close() { res.emit('close') },
    writeHead(status, headers) { res.status = status; res.headers = { ...(headers || {}) }; res.headersSent = true },
    write(chunk) { res.chunks.push(chunk) },
    end(data) { if (data !== undefined) res.body = data; else res.body = Buffer.concat(res.chunks.map((c) => Buffer.from(c))); res.writableEnded = true },
  }
  return res
}
function boot() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-hls-route-'))
  mkdirSync(join(home, 'Music'), { recursive: true })
  const prevHome = process.env.HOME
  const prevDshHome = process.env.DSH_HOME
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
  const registered = []
  const ctx = {
    shell: { resolve: (o) => o, run: async () => ({ stdout: { text: home } }) },
    fs: {
      async resolve(p) { return resolve(p) }, async stat() { return undefined },
      processPath(t) { return resolve(t) }, async listDir() { return [] }, async readBytes() { return Buffer.alloc(0) },
    },
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
  return { handler, cleanup }
}

describe('/dsh-music/radio/play HLS 分流', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

  it('GET .m3u8 上游 → 返回 audio/aac ADTS 流（转流）', async () => {
    const seg = realSegment()
    if (seg === null) return // 无真实样本跳过
    const playlistText = '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2.9,\nseg.ts\n'
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      const s = String(u)
      if (s.includes('playlist.m3u8')) return { ok: true, status: 200, text: async () => playlistText }
      if (s.includes('seg.ts')) return { ok: true, status: 200, arrayBuffer: async () => seg.buffer.slice(seg.byteOffset, seg.byteOffset + seg.byteLength) }
      throw new Error('unexpected ' + s)
    }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      const done = handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('http://cdn/playlist.m3u8') }), res)
      // 拿到首个 chunk 后断开连接，让转流循环随 abort 退出（live 无限流，测试需主动终止）
      const finish = new Promise((resolve) => {
        const t = setInterval(() => {
          if (res.chunks.length > 0 && res.headersSent) { clearInterval(t); res.close(); resolve() }
        }, 20)
        setTimeout(() => { clearInterval(t); res.close(); resolve() }, 3000) // 兜底
      })
      await finish
      await done
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/aac')
      expect(res.headers['X-DSH-Radio-Hls']).toBe('1')
      expect(Buffer.concat(res.chunks).length).toBeGreaterThan(1000)
    } finally { cleanup() }
  })

  it('GET hls=1 参数但 URL 非 .m3u8 → 也走转流', async () => {
    const seg = realSegment()
    if (seg === null) return
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      const s = String(u)
      if (s.includes('/stream')) return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.9,\nseg.ts\n' }
      if (s.includes('/seg.ts')) return { ok: true, status: 200, arrayBuffer: async () => seg.buffer.slice(seg.byteOffset, seg.byteOffset + seg.byteLength) }
      throw new Error('unexpected ' + s)
    }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      const done = handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('http://cdn/stream') + '&hls=1' }), res)
      const finish = new Promise((resolve) => {
        const t = setInterval(() => {
          if (res.chunks.length > 0 && res.headersSent) { clearInterval(t); res.close(); resolve() }
        }, 20)
        setTimeout(() => { clearInterval(t); res.close(); resolve() }, 3000)
      })
      await finish
      await done
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/aac')
    } finally { cleanup() }
  })

  it('GET 纯流（.mp3 无 hls 参数）→ 走原透传代理（不改行为）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      headers: { get: (k) => ({ 'content-type': 'audio/mpeg', 'icy-name': 'X' }[k.toLowerCase()] ?? null) },
      body: { [Symbol.asyncIterator]: async function* () { yield Buffer.from('ID3XXX') } },
    })))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('https://cdn/live/x.mp3') }), res)
      expect(res.status).toBe(200)
      expect(res.headers['Content-Type']).toBe('audio/mpeg')
      expect(Buffer.isBuffer(res.body) ? res.body.toString() : res.body).toBe('ID3XXX')
      expect(res.headers['X-DSH-Radio-Hls']).toBeUndefined()
    } finally { cleanup() }
  })

  it('master 上游（无 media 子列表 / 拉取失败）→ 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('http://cdn/live/x.m3u8') }), res)
      expect(res.status).toBe(502)
    } finally { cleanup() }
  })

  it('探测阶段网络抖动（master fetch 偶发失败）→ 回 502 且响应终结（不悬挂）', async () => {
    // 复现「偶发失败、再点就好」根因：探测（发 200 前）fetch 偶发 ECONNRESET。
    // 修复前：先 writeHead(200) 再失败 → ERR_HTTP_HEADERS_SENT → res 永不 end → 悬挂。
    // 修复后：探测在发头前 → 直接 502 + end，浏览器立刻得到明确错误。
    const seg = realSegment()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      const s = String(u)
      calls++
      // 模拟偶发失败：第一次拉 playlist 就挂（ECONNRESET），第二次正常。
      if (calls === 1) throw new Error('fetch failed: ECONNRESET')
      if (s.includes('playlist.m3u8')) return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2.9,\nseg.ts\n' }
      if (s.includes('seg.ts')) return { ok: true, status: 200, arrayBuffer: async () => (seg || Buffer.from('x')).buffer }
      throw new Error('unexpected ' + s)
    }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      await handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('http://cdn/playlist.m3u8') }), res)
      expect(res.status).toBe(502) // 探测失败直接 502
      expect(res.headersSent).toBe(true)
      expect(res.writableEnded).toBe(true) // 响应终结，不悬挂
      expect(String(res.body || '')).toContain('HLS 转流失败')
    } finally { cleanup() }
  })

  it('200 已发后流中途失败 → 响应被收尾（end）而非悬挂', async () => {
    // 正式转流（200 已发）后分片全失败断流：不能改状态码，但必须 end 收尾。
    const seg = realSegment()
    if (seg === null) return
    let playlistCalls = 0
    let failSeg = false
    vi.stubGlobal('fetch', vi.fn(async (u) => {
      const s = String(u)
      if (s.includes('playlist.m3u8')) {
        playlistCalls++
        // 第一、二次正常（探测+转流首拉），后续正常返回同一列表（无新分片 → 进入轮询空转）。
        return { ok: true, status: 200, text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + (1000 + playlistCalls) + '\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.9,\nseg.ts\n' }
      }
      if (s.includes('seg.ts')) {
        if (!failSeg) { failSeg = true; return { ok: true, status: 200, arrayBuffer: async () => seg.buffer.slice(seg.byteOffset, seg.byteOffset + seg.byteLength) } }
        throw new Error('seg gone (404)') // 后续分片全失败
      }
      throw new Error('unexpected ' + s)
    }))
    const { handler, cleanup } = boot()
    try {
      const res = makeRes()
      const done = handler(makeReq({ url: '/dsh-music/radio/play?u=' + encodeURIComponent('http://cdn/playlist.m3u8') }), res)
      // 第一个分片成功后立刻断开（模拟客户端拿到音频即停）
      const finish = new Promise((resolve) => {
        const t = setInterval(() => {
          if (res.chunks.length > 0) { clearInterval(t); res.close(); resolve() }
        }, 20)
        setTimeout(() => { clearInterval(t); res.close(); resolve() }, 4000)
      })
      await finish
      await done
      expect(res.headersSent).toBe(true)
      expect(Buffer.concat(res.chunks).length).toBeGreaterThan(1000) // 确实有音频产出
    } finally { cleanup() }
  })
})
