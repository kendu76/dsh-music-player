/**
 * test/netease.test.js — 网易云底层模块纯函数测试。
 *
 * 覆盖：
 *   - 加密：eapi / linuxapi 为确定性算法（给定输入可独立复算期望值做向量固化）；
 *     weapi 的结构不变量（params base64 且按 16 字节块、encSecKey 为 256 位 hex、
 *     随机 secret 使两次调用结果不同）
 *   - 歌曲归一化 normalizeSong（fee/privilege/dt→秒/封面/链接，对齐 qq.js 字段）
 *   - YRC 逐字歌词解析 parseYrc（行/词时间轴、纯文本行、元数据行跳过、窗口收敛）
 *   - 登录二维码 QR SVG dataURL（可解出 <svg>，含 viewBox 与正确尺寸）
 *
 * 不发网络请求；加密期望值以「实现同款公式」在测试里独立复算（一旦算法漂移即红）。
 */

import { describe, it, expect, vi } from 'vitest'
import crypto from 'node:crypto'
import { weapi, linuxapi, eapi, normalizeSong, qrSvgDataUrl, subscribePlaylist, cookieValue } from '../lib/netease.js'
import { parseYrc } from '../lib/yrc.js'

describe('netease eapi（确定性向量）', () => {
  const aesEcbHex = (text, key) => {
    const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
    return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex').toUpperCase()
  }
  it('与公式独立复算一致', () => {
    const urlPath = '/eapi/song/enhance/player/url/v1'
    const obj = { ids: [2652820720], level: 'lossless', encodeType: 'flac' }
    const text = JSON.stringify(obj)
    const message = `nobody${urlPath}use${text}md5forencrypt`
    const digest = crypto.createHash('md5').update(message, 'utf8').digest('hex')
    const data = `${urlPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
    expect(eapi(urlPath, obj).params).toBe(aesEcbHex(data, 'e82ckenh8dichen8'))
  })
})

describe('netease linuxapi（确定性向量）', () => {
  const aesEcbHex = (text, key) => {
    const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null)
    return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex').toUpperCase()
  }
  it('与公式独立复算一致', () => {
    const inner = { s: '晴天', type: 1, offset: 0, limit: 30 }
    const text = JSON.stringify({ method: 'POST', url: 'http://music.163.com/api/cloudsearch/pc', params: inner })
    expect(linuxapi('http://music.163.com/api/cloudsearch/pc', inner).eparams).toBe(aesEcbHex(text, 'rFgB&h#%2?^eDg:Q'))
  })
})

describe('netease weapi（结构不变量）', () => {
  it('params 是 16 字节块的 base64；encSecKey 是 256 位 hex', () => {
    const w = weapi({ s: '晴天', type: 1 })
    const buf = Buffer.from(w.params, 'base64')
    expect(buf.length > 0).toBe(true)
    expect(buf.length % 16).toBe(0)
    expect(/^[0-9a-f]{256}$/.test(w.encSecKey)).toBe(true)
  })
  it('随机 secret → 两次调用结果不同', () => {
    const a = weapi({ s: 'x' })
    const b = weapi({ s: 'x' })
    expect(a.params).not.toBe(b.params)
    expect(a.encSecKey).not.toBe(b.encSecKey)
  })
})

describe('netease normalizeSong', () => {
  it('映射 id/title/artists/album/dt→秒/fee/privilege/source/link', () => {
    const s = normalizeSong({
      id: 2652820720,
      name: '晴天(深情版)',
      ar: [{ name: 'Lucky小爱' }, { name: '周杰伦' }],
      al: { id: 155555, name: '专辑名', picUrl: 'http://p1.music.126.net/cover.jpg' },
      dt: 278961,
      fee: 8,
      privilege: { st: 0, pl: 320000, dl: 0, maxbr: 320000 },
    })
    expect(s.id).toBe('2652820720')
    expect(s.title).toBe('晴天(深情版)')
    expect(s.artists).toEqual(['Lucky小爱', '周杰伦'])
    expect(s.album).toBe('专辑名')
    expect(s.interval).toBe(279) // 278961ms → 秒
    expect(s.fee).toBe(8)
    expect(s.privilege.pl).toBe(320000)
    expect(s.source).toBe('nc')
    expect(s.link).toContain('song?id=2652820720')
  })
  it('缺省字段容错（无 ar/al/privilege）', () => {
    const s = normalizeSong({ id: 1, name: 'x' })
    expect(s.artists).toEqual([])
    expect(s.album).toBe('')
    expect(s.interval).toBe(0)
    expect(s.fee).toBe(0)
    expect(s.privilege).toEqual({ st: 0, pl: 0, dl: 0, maxbr: 0 })
  })
  it('剥离 <em> 高亮标签', () => {
    const s = normalizeSong({ id: 1, name: '<em>晴天</em>', ar: [{ name: '<em>周杰伦</em>' }] })
    expect(s.title).toBe('晴天')
    expect(s.artists).toEqual(['周杰伦'])
  })
})

describe('netease parseYrc', () => {
  it('行/词时间轴 + 纯文本行 + 元数据跳过 + 窗口收敛', () => {
    const fixture = [
      '[ti:测试]',
      '[ar:某人]',
      '[1230,2450](1230,600,0)我(1830,500,0)们(2330,1350,0)的',
      '[3780,2200]副歌纯文本行',
      '',
    ].join('\n')
    const r = parseYrc(fixture)
    expect(r.wordLevel).toBe(true)
    expect(r.lines.length).toBe(2)
    // 行 1：词级时间轴（绝对毫秒 → 秒），窗口以最后词结束 + 400ms 尾巴收敛
    const l1 = r.lines[0]
    expect(l1.text).toBe('我们的')
    expect(l1.t).toBe(1.23)
    // 行窗口 = min(行尾 start+dur, 最后词尾+尾巴)；词尾(3680)+400 已超行尾(3680) → 取行尾
    expect(l1.end).toBeCloseTo((2330 + 1350) / 1000, 6)
    expect(l1.words.map((w) => w.text)).toEqual(['我', '们', '的'])
    expect(l1.words[0].t).toBeCloseTo(1.23, 6)
    expect(l1.words[0].end).toBeCloseTo(1.83, 6)
    // 行 2：无逐词标签 → 整行文本
    expect(r.lines[1].text).toBe('副歌纯文本行')
    expect(r.lines[1].t).toBe(3.78)
    expect(r.lines[1].end).toBeCloseTo(5.98, 6)
    expect(r.lines[1].words).toBeUndefined()
  })
  it('空输入/空行返回 null', () => {
    expect(parseYrc('')).toBeNull()
    expect(parseYrc('   \n  \n')).toBeNull()
  })
})

describe('netease subscribePlaylist（收藏歌单）', () => {
  // 回归：修复前 eapi 主路（真实登录态也 404「接口未找到」）+ weapi 备路传空 csrf
  // （403 illegal request）双挂 → 前端 toast「接口未找到！」。修复后 weapi 主路、
  // csrf_token 取自 cookie 的 __csrf，eapi 仅作兜底探测。
  function stubFetch(routes) {
    const calls = []
    const fn = vi.fn(async (url, options) => {
      const text = String(url)
      for (const [match, body, status = 200] of routes) {
        if (text.includes(match)) {
          calls.push({ url: text, reqBody: (options && options.body) || '' })
          return { ok: status < 400, status, headers: { getSetCookie: () => [] }, text: async () => body, json: async () => JSON.parse(body) }
        }
      }
      throw new Error('unexpected url ' + text)
    })
    const prev = globalThis.fetch
    globalThis.fetch = fn
    return { fn, calls, restore: () => { globalThis.fetch = prev } }
  }
  it('weapi 走主路：eapi 404 时不阻塞、weapi code=200 即成功', async () => {
    const cookie = 'MUSIC_U=abc123; __csrf=csrf456; NMTID=x'
    const s = stubFetch([
      // eapi（interface3）—— 修复前主路，真实登录态也返回「接口未找到！」
      ['interface3.music.163.com/eapi/playlist/subscribe', JSON.stringify({ code: 404, message: '接口未找到！' })],
      // weapi（music.163.com）—— 修复后主路，应成功
      ['music.163.com/weapi/playlist/subscribe', JSON.stringify({ code: 200 })],
    ])
    try {
      const ok = await subscribePlaylist('3778678', cookie, 'collect')
      expect(ok).toBe(true)
      // weapi 主路优先且成功即短路（eapi 只在 weapi 失败时才兜底探测）
      expect(s.calls.some((c) => c.url.includes('/weapi/playlist/subscribe'))).toBe(true)
      expect(s.calls.some((c) => c.url.includes('/eapi/playlist/subscribe'))).toBe(false)
    } finally {
      s.restore()
    }
  })
  it('csrf 取自 cookie 的 __csrf（空 csrf 会被服务端 403 拒绝）', () => {
    expect(cookieValue('MUSIC_U=abc; __csrf=csrf456; NMTID=x', '__csrf')).toBe('csrf456')
    expect(cookieValue('MUSIC_U=abc; NMTID=x', '__csrf')).toBe('')
  })
  it('weapi 非 200 且 eapi 也非 200 → 抛错并透出服务端消息', async () => {
    const cookie = 'MUSIC_U=abc123; __csrf=csrf456'
    const s = stubFetch([
      ['music.163.com/weapi/playlist/unsubscribe', JSON.stringify({ code: 403, message: 'illegal request!' })],
      ['interface3.music.163.com/eapi/playlist/unsubscribe', JSON.stringify({ code: 404, message: '接口未找到！' })],
    ])
    try {
      await expect(subscribePlaylist('3778678', cookie, 'uncollect')).rejects.toThrow(/取消收藏失败/)
    } finally {
      s.restore()
    }
  })
})

describe('netease qrSvgDataUrl', () => {
  it('返回 SVG dataURL，可解出 <svg> 且含 viewBox', () => {
    const dataUrl = qrSvgDataUrl('https://music.163.com/login?codekey=test-unikey')
    expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
    const svg = Buffer.from(dataUrl.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox=')
    expect(svg).toContain('</svg>')
  })
  it('不同内容产出不同二维码', () => {
    expect(qrSvgDataUrl('a')).not.toBe(qrSvgDataUrl('b'))
  })
})
