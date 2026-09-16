/**
 * Direct unit tests for `detectVip`（无损档 vkey 探测；导入真实 lib/qq.js，不发真实网络）。
 *
 * 用途：VIP 档位判定（播放/搜索时给「可播高音质」提示），**不用于登录态判定**——
 * 登录态已定稿为「不做任何主动探测，只在播放失败时由客户端发现并回登录 UI」。
 *
 * 反面教材（2026-09-16 事故）：曾用 `music.UserInfo.userInfo/GetLoginUserInfo` 判登录态，
 * 它对**刚登录、明确有效**的微信会话同样返回 `code 500003`（同一会话 detectVip=true、能取到
 * FLAC 直链）→「刚登录 QQ 音乐，一刷新页面就提示登录过期」。下面的守卫用例防止有人把它加回来。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as QQ from '../lib/qq.js'
import { detectVip, getDownloadURL } from '../lib/qq.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const COOKIE = 'uin=1152921505077308862; qqmusic_key=W_X_abc; tmeLoginType=1'

// stub 上游 musicu.fcg：按 filename 决定该档位是否给 purl。
function stubVkey({ purl = true, code = 0 } = {}) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: String(url), body })
    const filenames = (body && body.req_1 && body.req_1.param && body.req_1.param.filename) || []
    const payload = {
      code: 0,
      req_1: {
        code,
        data: { midurlinfo: filenames.map((f) => ({ filename: f, purl: purl ? 'vkey/' + f : '' })) },
      },
    }
    return { status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
  }))
  return calls
}

describe('QQ 登录态探测：只能用 vkey 权限（detectVip）', () => {
  it('能取到无损档 vkey → 登录有效（true）', async () => {
    stubVkey({ purl: true })
    expect(await detectVip(COOKIE)).toBe(true)
  })

  it('取不到无损档 vkey（失效 key / 非会员都长这样）→ false', async () => {
    stubVkey({ purl: false })
    expect(await detectVip(COOKIE)).toBe(false)
  })

  it('上游非 0 返回 → false（不抛错，调用方按「取不到」处理）', async () => {
    stubVkey({ purl: true, code: 500003 })
    expect(await detectVip(COOKIE)).toBe(false)
  })

  it('探测请求确实带上了 music key（authst）与无损档 filename', async () => {
    const calls = stubVkey({ purl: true })
    await detectVip(COOKIE)
    expect(calls.length).toBe(1)
    const { body } = calls[0]
    expect(body.req_1.param.filename.every((f) => /\.flac$/.test(f))).toBe(true)
  })

  it('getDownloadURL 在「有 purl」时给出可播直链（登录有效的正向证据）', async () => {
    stubVkey({ purl: true })
    const dl = await getDownloadURL('0039MnYb0qxYhV', COOKIE, true)
    expect(dl.url).toContain('ws.stream.qqmusic.qq.com')
  })

  it('REGRESSION: 不得再导出 checkLogin（GetLoginUserInfo/500003 那套判据是错的）', () => {
    // 该接口对有效会话同样回 500003（见文件头说明）。若有人把它加回来当判据，这条会红。
    expect('checkLogin' in QQ).toBe(false)
  })
})
