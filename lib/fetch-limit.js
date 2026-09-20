/**
 * lib/fetch-limit.js — 极简出网限流器（并发上限 + 最小启动间隔 + **有界**队列）。
 *
 * 背景：插件里有若干「不依赖用户交互」的自动出网请求（典型：本地歌曲没歌词时按歌自动
 * 触发的在线歌词兜底）。连续切歌时它们会对第三方非官方接口形成无上限的并发请求，既可能
 * 耗尽配额/被限流封禁，也没有任何资源上限（CWE-770）。本模块提供一个小而明确的限流器：
 *
 *   - maxConcurrent：同时在跑的请求数上限；
 *   - minGapMs：两次**启动**之间的最小间隔（上一次请求过去足够久时，下一次立即启动——
 *     即空闲时首个请求不额外等待）；
 *   - maxQueue：排队长度上限，超出立即失败（**资源有界**，而不是无限堆积）。
 *
 * 关键语义（与「超时兜底」配合使用，别写反）：
 *   调用方应**先**起自己的超时计时器，再把请求交给 limiter.run()，并把 signal 传进来。
 *   这样排队等待也吃这份超时预算：排队超时 → 立刻出队失败、**根本不会发出上游请求**；
 *   否则队列一长，超时兜底会被排队拖成 ⌊k/并发⌋×timeout，退化成「明明做了超时却还是会
 *   长时间卡住」。
 *
 * 无第三方依赖；实例是进程内共享的，请按调用方（模块/端点）各建一个实例，避免相互排队。
 */

function makeAbortError() {
  // 与 fetch 被 abort 时抛出的错误同形（调用方一律按「失败 → 静默回退」处理）。
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

/**
 * @param {{ maxConcurrent?: number, minGapMs?: number, maxQueue?: number }} [opts]
 * @returns {{ run: (task: () => any, o?: { signal?: AbortSignal }) => Promise<any>, queued: () => number, running: () => number }}
 */
export function createLimiter({ maxConcurrent = 2, minGapMs = 250, maxQueue = 8 } = {}) {
  let running = 0
  let lastStartAt = 0
  let gapTimer = null
  const queue = []

  const pump = () => {
    if (gapTimer !== null) return          // 已安排了下一次启动（间隔未到）
    if (running >= maxConcurrent) return   // 并发已满
    if (queue.length === 0) return
    const wait = Math.max(0, lastStartAt + minGapMs - Date.now())
    if (wait > 0) {
      // 只在「距上次启动不足 minGapMs」时才等——空闲后的第一个请求 wait=0、立即启动。
      gapTimer = setTimeout(() => { gapTimer = null; pump() }, wait)
      return
    }
    const item = queue.shift()
    running += 1
    lastStartAt = Date.now()
    item.start()
    pump()                                 // 还有额度就继续（仍受 minGapMs 约束）
  }

  const release = () => {
    running = Math.max(0, running - 1)
    pump()
  }

  const run = (task, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(makeAbortError()); return }
    if (queue.length >= maxQueue) { reject(new Error('fetch queue full (' + maxQueue + ')')); return }
    const item = { start: null }
    // 排队期间被 abort（调用方的超时到点）：直接出队、失败，不发上游请求。
    const onAbort = () => {
      const i = queue.indexOf(item)
      if (i >= 0) queue.splice(i, 1)
      reject(makeAbortError())
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    item.start = () => {
      if (signal) signal.removeEventListener('abort', onAbort)
      Promise.resolve().then(task).then(
        (value) => { release(); resolve(value) },
        (err) => { release(); reject(err) },
      )
    }
    queue.push(item)
    pump()
  })

  return { run, queued: () => queue.length, running: () => running }
}
