/**
 * Direct unit tests for getTopListSongs pagination (imports the REAL lib/qq.js).
 *
 * The toplist now uses musicu's music.musicToplist.Toplist/GetDetail with
 * offset/num pagination (legacy fcg_v8_toplist_cp.fcg could not page and capped
 * at 50 songs). Global fetch is stubbed to exercise offset/hasMore/total logic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { getTopListSongs } from '../lib/qq.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(songCount, totalNum) {
  let lastBody = null
  vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
    lastBody = JSON.parse(opts.body)
    const param = lastBody.req_0.param
    const songs = Array.from({ length: songCount }, (_, i) => ({
      mid: 'm' + (param.offset + i),
      name: '歌' + (param.offset + i),
      singer: [{ name: '歌手' }],
      album: { name: '专辑' },
      interval: 200,
      pay: { pay_play: 1 },
    }))
    return { json: async () => ({
      code: 0,
      req_0: { code: 0, data: { data: { title: '飙升榜', totalNum, headPicUrl: 'http://x/pic.png' }, songInfoList: songs } },
    }) }
  }))
  return () => lastBody
}

describe('getTopListSongs pagination', () => {
  it('uses music.musicToplist.Toplist/GetDetail with offset+num', async () => {
    const getLastBody = stubFetch(30, 100)
    const r = await getTopListSongs(62, '', 0, 30)
    const body = getLastBody()
    expect(body.req_0.module).toBe('music.musicToplist.Toplist')
    expect(body.req_0.method).toBe('GetDetail')
    expect(body.req_0.param).toMatchObject({ topId: 62, offset: 0, num: 30 })
    expect(r.total).toBe(100)
    expect(r.hasMore).toBe(true) // 0 + 30 < 100
    expect(r.songs.length).toBe(30)
    expect(r.name).toBe('飙升榜')
    expect(r.cover).toBe('https://x/pic.png') // http -> https
    expect(r.songs[0].songmid).toBe('m0')
    expect(r.songs[0].payplay).toBe(1)
  })

  it('reports hasMore=false on the last page', async () => {
    stubFetch(10, 100)
    const r = await getTopListSongs(62, '', 90, 30)
    expect(r.songs.length).toBe(10)
    expect(r.hasMore).toBe(false) // 90 + 10 = 100
  })

  it('clamps num to [1,500] and defaults offset to 0', async () => {
    const getLastBody = stubFetch(50, 200)
    await getTopListSongs(62, '', -5, 999)
    const body = getLastBody()
    expect(body.req_0.param.offset).toBe(0) // negative offset clamped
    expect(body.req_0.param.num).toBe(500)  // num capped at 500 (old: 50)
  })

  it('大 num 一次拿全整榜（热歌榜 299 首：num≥total 全量返回、hasMore=false）', async () => {
    const getLastBody = stubFetch(299, 299)
    const r = await getTopListSongs(26, '', 0, 300)
    const body = getLastBody()
    expect(body.req_0.param).toMatchObject({ topId: 26, offset: 0, num: 300 })
    expect(r.songs.length).toBe(299)
    expect(r.total).toBe(299)
    expect(r.hasMore).toBe(false) // 0 + 299 >= 299
  })

  it('throws on a non-zero code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ code: 0, req_0: { code: -1, message: 'boom' } }) })))
    await expect(getTopListSongs(62, '')).rejects.toThrow('获取榜单失败')
  })
})
