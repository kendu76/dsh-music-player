/**
 * lib/fetch-limit.js 单测：并发上限 / 最小间隔（空闲不等待）/ 有界队列 / 排队被 abort。
 *
 * 用真实定时器 + 小参数（ms 级）跑，避免假定时器把「排队与超时的交互」测成假的。
 */
import { describe, it, expect } from 'vitest'
import { createLimiter } from '../lib/fetch-limit.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('createLimiter', () => {
  it('空闲时首个请求立即启动，不付最小间隔的等待', async () => {
    const lim = createLimiter({ maxConcurrent: 2, minGapMs: 200, maxQueue: 4 })
    let delay = -1
    const t0 = Date.now()
    await lim.run(async () => { delay = Date.now() - t0 })
    expect(delay).toBeGreaterThanOrEqual(0)
    // 阈值留足余量（CI 上事件循环可能被拖慢）：关键是要明显小于 minGap(200ms) —— 旧实现无条件
    // setTimeout(gap)，这里会是 ~200ms。
    expect(delay).toBeLessThan(150)
  })

  it('并发上限：5 个任务同时提交，峰值并发 ≤ maxConcurrent', async () => {
    const lim = createLimiter({ maxConcurrent: 2, minGapMs: 0, maxQueue: 8 })
    let inFlight = 0
    let peak = 0
    let done = 0
    await Promise.all(Array.from({ length: 5 }, () => lim.run(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await sleep(15)
      inFlight -= 1
      done += 1
    })))
    expect(peak).toBe(2)
    expect(done).toBe(5)
  })

  it('最小间隔：连续请求的启动时刻间隔 ≥ minGapMs', async () => {
    const lim = createLimiter({ maxConcurrent: 4, minGapMs: 40, maxQueue: 8 })
    const starts = []
    await Promise.all(Array.from({ length: 3 }, () => lim.run(async () => { starts.push(Date.now()) })))
    starts.sort((a, b) => a - b)
    expect(starts.length).toBe(3)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30)
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(30)
  })

  it('队列有界：超出 maxQueue 的请求立即失败，且任务不执行', async () => {
    const lim = createLimiter({ maxConcurrent: 1, minGapMs: 0, maxQueue: 1 })
    let ran = 0
    let releaseFirst = null
    const first = lim.run(() => new Promise((res) => { ran += 1; releaseFirst = res })) // 占住唯一额度
    await sleep(5)
    const second = lim.run(async () => { ran += 1 })                                   // 进队列（占满 maxQueue=1）
    await expect(lim.run(async () => { ran += 1 })).rejects.toThrow(/queue full/)
    releaseFirst()
    await Promise.all([first, second])
    expect(ran).toBe(2)   // 第三个从未执行
    expect(lim.queued()).toBe(0)
  })

  it('排队中被 abort → 以 AbortError 失败、任务不执行（超时预算覆盖排队时间）', async () => {
    const lim = createLimiter({ maxConcurrent: 1, minGapMs: 0, maxQueue: 8 })
    let unblock = null
    const blocking = lim.run(() => new Promise((res) => { unblock = res })) // 占住唯一额度
    await sleep(10)
    let ran = false
    const ctrl = new AbortController()
    const queued = lim.run(() => { ran = true }, { signal: ctrl.signal })
    expect(lim.queued()).toBe(1)
    setTimeout(() => ctrl.abort(), 20)
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(ran).toBe(false)          // 根本没发出上游请求
    expect(lim.queued()).toBe(0)     // 已出队，不占资源
    unblock()
    await blocking
  })

  it('已 abort 的 signal 直接失败、不占队列；run() 的返回值/异常原样透传', async () => {
    const lim = createLimiter({ maxConcurrent: 2, minGapMs: 0, maxQueue: 1 })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(lim.run(() => 1, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(lim.queued()).toBe(0)
    await expect(lim.run(async () => 'ok')).resolves.toBe('ok')
    await expect(lim.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(lim.running()).toBe(0) // 异常路径也归还额度
  })
})
