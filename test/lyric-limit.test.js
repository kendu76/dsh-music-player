/**
 * lib/lyric.js 的 LRCLIB 出网限流接线测试（test/fetch-limit.test.js 只测限流器本身）。
 *
 * 这里锁三件**必须在接线层成立**的事：
 *   1. 空闲时首次 lrclibSearch 不被限流器额外延迟（旧实现无条件等 250ms）；
 *   2. 同时发起多个 lrclibSearch 时，真实 fetch 并发 ≤ 2；
 *   3. 排队等待也吃调用方的超时预算：两个请求占满额度后，第三个在排队中到点即失败，
 *      **不会**在超时之后又发出一个上游请求（旧实现把计时器放在入队之后，排队时间不计入）。
 *
 * 单文件独立进程 + 独立模块表，因此 lyric.js 里的模块级限流器状态不会串到别的用例。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lrclibSearch } from '../lib/lyric.js'

const okJson = (payload) => ({ ok: true, status: 200, json: async () => payload })

let realFetch = null
beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { if (realFetch) vi.stubGlobal('fetch', realFetch) })

describe('lrclibSearch 出网限流接线', () => {
  it('空闲时首次请求立即发出（不被最小间隔拖 250ms）', async () => {
    vi.stubGlobal('fetch', async () => okJson([]))
    const t0 = Date.now()
    await lrclibSearch('七里香')
    // 阈值留足余量（CI 上事件循环可能被拖慢）：关键是要明显小于模块里的 250ms 最小间隔。
    expect(Date.now() - t0).toBeLessThan(150)
  })

  it('并发上限 2：同时发起 5 次，真实 fetch 峰值并发 ≤ 2', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight -= 1
      return okJson([])
    })
    await Promise.all(Array.from({ length: 5 }, () => lrclibSearch('x')))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('排队也吃超时预算：额度占满时第三个请求到点即失败，且不再发出上游请求', async () => {
    let calls = 0
    // 请求一律挂住（只认 abort）：占满并发额度后，第三个只能在队列里等自己的超时
    vi.stubGlobal('fetch', (url, opts = {}) => {
      calls += 1
      return new Promise((resolve, reject) => {
        if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    })
    await new Promise((r) => setTimeout(r, 300)) // 等模块级限流器彻底空闲（上一个用例的 minGap 窗口过去）
    const a = lrclibSearch('a', { timeoutMs: 600 }).catch((e) => e.name) // 立即拿到第一个额度
    await new Promise((r) => setTimeout(r, 300))                        // 满 250ms 最小间隔 → 第二个额度可用
    const b = lrclibSearch('b', { timeoutMs: 600 }).catch((e) => e.name)
    // 轮询直到两个请求都真的在跑（而不是死等固定毫秒，免得 CI 上定时器被拖慢时误判）
    const deadline = Date.now() + 2000
    while (calls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(calls).toBe(2)                        // 两个额度都被占住（都在挂着）
    const t0 = Date.now()
    const c = await lrclibSearch('c', { timeoutMs: 150 }).catch((e) => e.name)
    const elapsed = Date.now() - t0
    expect(c).toBe('AbortError')                 // 排队到点即失败
    expect(elapsed).toBeLessThan(400)            // ≈ 自己的超时（150ms），而不是「等前者结束(600ms) + 自己的超时」
    expect(calls).toBe(2)                        // 关键：第三个始终没有发出上游请求
    expect(await a).toBe('AbortError')
    expect(await b).toBe('AbortError')
  })
})
