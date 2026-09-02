/**
 * Unit tests for lib/lyric.js — 本地歌曲在线歌词兜底（QQ → 酷狗 → 网易云 → LRCLIB）。
 *
 * 打分/归一化是纯函数，直接测；getOnlineLyric 通过 stub 全局 fetch 按 URL 分发
 * QQ 搜索 / QQ 歌词 / LRCLIB 搜索 三种响应，验证兜底顺序与降级行为。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  normalizeText, scoreCandidate, pickBest, lrclibSearch, getOnlineLyric,
} from '../lib/lyric.js'

afterEach(() => { vi.unstubAllGlobals() })

// ---- fetch stub：按 URL 路由到 QQ 搜索 / QQ 歌词 / LRCLIB 搜索 ----
function makeFetchStub({ qqSearch = [], qqLyric = null, lrclib = [], callLog = null } = {}) {
  return async (url) => {
    const u = String(url)
    if (callLog) callLog.push(u)
    if (u.includes('c.y.qq.com/soso/fcgi-bin/client_search_cp')) {
      return {
        ok: true, status: 200,
        json: async () => ({ code: 0, data: { song: { totalnum: qqSearch.length, list: qqSearch } } }),
      }
    }
    if (u.includes('c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new')) {
      return { ok: true, status: 200, json: async () => (qqLyric || { retcode: -1, lyric: '' }) }
    }
    if (u.includes('lrclib.net/api/search')) {
      return { ok: true, status: 200, json: async () => lrclib }
    }
    if (u.includes('lrclib.net/api/get/')) {
      const id = Number(u.split('/').pop())
      const hit = lrclib.find((r) => r.id === id)
      return { ok: true, status: 200, json: async () => (hit || {}) }
    }
    throw new Error('unexpected url in stub: ' + u)
  }
}

const qqSong = (songmid, title, artist, interval) => ({
  songmid, songname: title, singer: [{ name: artist }], interval, payplay: 0,
})
const lrclibRec = (id, trackName, artistName, duration, syncedLyrics, instrumental = false) => ({
  id, trackName, artistName, duration, instrumental, syncedLyrics, plainLyrics: '',
})

describe('normalizeText', () => {
  it('lowercases and strips whitespace/punctuation/brackets', () => {
    expect(normalizeText(' 七里香 (Live) ')).toBe('七里香live')
    expect(normalizeText('Hotel California - 1976')).toBe('hotelcalifornia1976')
    expect(normalizeText('')).toBe('')
  })
})

describe('scoreCandidate', () => {
  const want = { title: '七里香', artist: '周杰伦', duration: 297 }
  it('scores an exact title + exact artist highest', () => {
    const s = scoreCandidate({ title: '七里香', artist: '周杰伦', duration: 300 }, want)
    expect(s).toBeGreaterThanOrEqual(90)
  })
  it('exact title alone still passes the accept threshold', () => {
    const s = scoreCandidate({ title: '七里香', artist: '某翻唱者', duration: 300 }, { ...want, artist: '' })
    expect(s).toBeGreaterThanOrEqual(60)
  })
  it('title-contains (+ duration close) passes; contains alone does not', () => {
    const c = { title: '七里香 (Live)', artist: '', duration: 299 }
    expect(scoreCandidate(c, { ...want, artist: '' })).toBeGreaterThanOrEqual(52)
    const alone = scoreCandidate({ title: '七里香 (Live)', artist: '', duration: 999 }, { title: '七里香', artist: '', duration: null })
    expect(alone).toBeLessThan(52)
  })
  it('penalizes instrumental candidates heavily', () => {
    const normal = scoreCandidate({ title: '七里香', artist: '周杰伦', duration: 297, instrumental: false }, want)
    const inst = scoreCandidate({ title: '七里香', artist: '周杰伦', duration: 297, instrumental: true }, want)
    expect(inst).toBeLessThan(normal - 30)
  })
  it('duration mismatch reduces but does not zero an exact-title match', () => {
    const close = scoreCandidate({ title: '七里香', artist: '周杰伦', duration: 301 }, want)
    const far = scoreCandidate({ title: '七里香', artist: '周杰伦', duration: 500 }, want)
    expect(far).toBeLessThan(close)
    expect(far).toBeGreaterThanOrEqual(80)
  })
})

describe('pickBest', () => {
  it('returns the highest-scoring candidate and its score', () => {
    const want = { title: '晴天', artist: '周杰伦' }
    const cands = [
      { title: '晴天', artist: '周杰伦' },
      { title: '晴天娃娃', artist: '周杰伦' },
      { title: '晴天', artist: '别人' },
    ]
    const { best, score } = pickBest(cands, want)
    expect(best).toBe(cands[0])
    expect(score).toBeGreaterThan(0)
  })
  it('returns best null and score -1 for empty candidates', () => {
    const { best, score } = pickBest([], { title: 'x' })
    expect(best).toBeNull()
    expect(score).toBe(-1)
  })
})

describe('lrclibSearch', () => {
  it('filters to records that have synced lyrics and maps fields', async () => {
    vi.stubGlobal('fetch', makeFetchStub({
      lrclib: [
        lrclibRec(1, '七里香', '周杰伦', 297, '[00:01.00]窗外的麻雀\n'),
        lrclibRec(2, '纯音乐', '无人声', 200, '', true), // 无同步歌词/纯音乐 → 过滤
        { id: 3, trackName: '坏记录' }, // 缺字段 → 过滤
      ],
    }))
    const out = await lrclibSearch('七里香')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 1, title: '七里香', artist: '周杰伦', duration: 297, instrumental: false })
    expect(out[0].synced).toContain('[00:01.00]')
  })
  it('percent-encodes the query keyword in the URL', async () => {
    let seen = ''
    vi.stubGlobal('fetch', makeFetchStub({
      lrclib: [],
      callLog: null,
    }))
    vi.stubGlobal('fetch', async (url) => { seen = String(url); return { ok: true, status: 200, json: async () => [] } })
    await lrclibSearch('七里香')
    expect(seen).toContain('/api/search?q=')
    expect(seen).not.toContain('七里香') // 未编码中文不应出现在 URL
  })
})

describe('getOnlineLyric (QQ → LRCLIB 兜底)', () => {
  it('returns null for an empty title without calling any source', async () => {
    let called = false
    vi.stubGlobal('fetch', async () => { called = true; throw new Error('should not fetch') })
    expect(await getOnlineLyric({ title: '   ' })).toBeNull()
    expect(called).toBe(false)
  })

  it('hits QQ first: matching search + official lyric (+trans) → source qq', async () => {
    vi.stubGlobal('fetch', makeFetchStub({
      qqSearch: [qqSong('S1', '七里香', '周杰伦', 297)],
      qqLyric: { retcode: 0, lyric: '[00:01.00]窗外的麻雀\n[00:05.00]雨下整夜\n', trans: '[00:01.00]Sparrow outside\n' },
    }))
    const hit = await getOnlineLyric({ title: '七里香', artist: '周杰伦', duration: 297 })
    expect(hit).not.toBeNull()
    expect(hit.source).toBe('qq')
    expect(hit.matched.songmid).toBe('S1')
    expect(hit.lrcText).toContain('窗外的麻雀')
    expect(hit.transText).toContain('Sparrow')
  })

  it('falls through to LRCLIB when QQ search returns nothing matching', async () => {
    vi.stubGlobal('fetch', makeFetchStub({
      qqSearch: [qqSong('S9', '稻香', '周杰伦', 240)], // 标题不匹配 → 分数不足
      qqLyric: { retcode: 0, lyric: '[00:01.00]对这个世界\n' },
      lrclib: [lrclibRec(1, '七里香', '周杰伦', 297, '[00:01.00]窗外的麻雀\n')],
    }))
    const hit = await getOnlineLyric({ title: '七里香', artist: '周杰伦', duration: 300 })
    expect(hit).not.toBeNull()
    expect(hit.source).toBe('lrclib')
    expect(hit.matched.id).toBe(1)
    expect(hit.lrcText).toContain('窗外的麻雀')
  })

  it('falls through to LRCLIB when the QQ lyric endpoint fails', async () => {
    const log = []
    vi.stubGlobal('fetch', makeFetchStub({
      qqSearch: [qqSong('S1', '七里香', '周杰伦', 297)],
      qqLyric: { retcode: -999, lyric: '' }, // 取词失败
      lrclib: [lrclibRec(2, '七里香', '周杰伦', 297, '[00:02.00]香\n')],
      callLog: log,
    }))
    const hit = await getOnlineLyric({ title: '七里香', artist: '周杰伦' })
    expect(hit).not.toBeNull()
    expect(hit.source).toBe('lrclib')
  })

  it('returns null when both sources yield no acceptable match', async () => {
    vi.stubGlobal('fetch', makeFetchStub({
      qqSearch: [],
      lrclib: [],
    }))
    expect(await getOnlineLyric({ title: '不存在的歌名xyz' })).toBeNull()
  })

  it('does not let one source throwing prevent the fallback chain', async () => {
    const callLog = []
    vi.stubGlobal('fetch', async (url) => {
      const u = String(url)
      callLog.push(u)
      if (u.includes('c.y.qq.com/soso/')) throw new Error('network down')
      if (u.includes('lrclib.net/api/search')) {
        return { ok: true, status: 200, json: async () => [lrclibRec(3, '七里香', '周杰伦', 297, '[00:01.00]x\n')] }
      }
      throw new Error('unexpected ' + u)
    })
    const hit = await getOnlineLyric({ title: '七里香' })
    expect(hit).not.toBeNull()
    expect(hit.source).toBe('lrclib')
    // QQ 搜索失败后仍依次尝试 酷狗 → 网易云 → LRCLIB，链路不被单个源拖垮
    // （callLog = QQ 1 + 酷狗 1 + 网易云 2（linux 主路失败 → weapi 备路，stub 均抛）
    //   + LRCLIB 1 = 5 跳）
    expect(callLog.length).toBe(5)
  })
})
