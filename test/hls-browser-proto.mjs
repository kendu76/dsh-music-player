/**
 * test/hls-browser-proto.mjs — 最后不确定点浏览器验证（纯 Node + Chrome CDP，零 npm 依赖）。
 *
 * 问题：Chromium 的 <audio> 能否直接播放「裸 ADTS 连续流」（无 Content-Length、
 * Content-Type: audio/aac 的无限流）？这正是 HLS→ADTS 转流后浏览器端要消费的形态。
 *
 * 做法：
 *   1. 起本地 HTTP 服务：把真实剥壳产物（.proto.aac）按块流式发出，模拟「live 分片
 *      持续追加」；Content-Type: audio/aac、无 Content-Length、Chunked。
 *   2. 起 headless Chrome（CDP），注入 <audio> 播该流，采样事件/属性。
 *   3. 判定：能否触发 playing（有声音数据进入解码）？duration 是否 Infinity/增长？
 *      结束前 timeupdate 是否前进？
 *
 * 运行：node test/hls-browser-proto.mjs [aac路径]   （默认 /tmp/cctv_bundle.aac）
 */
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const AAC = process.argv[2] || '/tmp/cctv_bundle.aac'
const CHUNK_MS = 300 // 每块间隔（模拟分片到达节奏）
const CHUNK_BYTES = 32 * 1024 // 每块字节（模拟~0.7s音频/块）

if (!existsSync(AAC)) { console.error('缺少 AAC 样本:', AAC); process.exit(2) }

// ---------- 1) 流式 HTTP 服务 ----------
const audio = readFileSync(AAC)
const server = createServer((req, res) => {
  if (req.url === '/stream.aac') {
    res.writeHead(200, {
      'Content-Type': 'audio/aac',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none',
    })
    let off = 0
    const timer = setInterval(() => {
      if (off >= audio.length) { clearInterval(timer); res.end(); return }
      res.write(audio.subarray(off, off + CHUNK_BYTES))
      off += CHUNK_BYTES
    }, CHUNK_MS)
    req.on('close', () => clearInterval(timer))
  } else {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>ok</html>')
  }
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const streamUrl = `http://127.0.0.1:${port}/stream.aac`
console.log(`流服务: ${streamUrl}  (${audio.length}B 音频, 每 ${CHUNK_MS}ms 发 ${CHUNK_BYTES}B)`)

// ---------- 2) headless Chrome via CDP ----------
const userData = `/tmp/dsh-hls-chrome-${process.pid}`

function cdpsend(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// 用固定调试端口起 headless Chrome
function startChrome(port) {
  return spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    'about:blank',
  ], { stdio: 'ignore' })
}

const DEBUG_PORT = 9333 + Math.floor(Math.random() * 500)
const chrome2 = startChrome(DEBUG_PORT)
try {
  // 等调试端口就绪
  let version = null
  for (let i = 0; i < 40 && !version; i++) {
    await new Promise((r) => setTimeout(r, 250))
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      version = await r.json()
    } catch { /* not ready */ }
  }
  if (!version) { console.error('Chrome 调试端口未就绪'); process.exit(3) }
  console.log('Chrome CDP 就绪:', version.Browser)

  const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
  const page = pages.find((p) => p.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  await cdpsend(ws, 1, 'Runtime.enable')
  // 注意：不要 Page.navigate('about:blank')——实测 navigate 后页面处于特殊状态，
  // <audio> 会稳定 MEDIA_ELEMENT_ERROR；直接用 Chrome 启动时自带的初始页即可。
  await new Promise((r) => setTimeout(r, 800))

  // 注入并播放
  const evalJs = async (expr) => {
    const r = await cdpsend(ws, Math.floor(Math.random() * 1e6), 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }

  const result = await evalJs(`(async () => {
    const url = ${JSON.stringify(streamUrl)};
    const audio = new Audio();
    audio.preload = 'auto';
    // 收集事件时间线
    const events = [];
    ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','playing','timeupdate','ended','error','stalled','waiting','durationchange','progress'].forEach((ev) => {
      audio.addEventListener(ev, () => {
        events.push(ev + '@' + Math.round(audio.currentTime * 10) / 10);
      });
    });
    audio.src = url;
    audio.volume = 0.3;
    const playPromise = audio.play();
    if (playPromise && playPromise.catch) playPromise.catch((e) => events.push('playreject:' + e.name));
    // 观察 12s（音频 40s，观察前半段即可判定能否持续播放）
    await new Promise((res) => setTimeout(res, 12000));
    const snapshot = {
      events: events.slice(0, 40),
      readyState: audio.readyState, // 0..4
      currentTime: Math.round(audio.currentTime * 100) / 100,
      duration: audio.duration,
      paused: audio.paused,
      ended: audio.ended,
      networkState: audio.networkState,
      error: audio.error ? { code: audio.error.code, msg: audio.error.message } : null,
      bufferedEnd: audio.buffered.length ? Math.round(audio.buffered.end(audio.buffered.length - 1) * 100) / 100 : -1,
    };
    audio.pause();
    audio.src = '';
    return snapshot;
  })()`)

  console.log('\n===== 浏览器验证结果 =====')
  console.log(JSON.stringify(result, null, 2))

  // ---------- 判定 ----------
  const evs = result.events || []
  const gotPlaying = evs.some((e) => e.startsWith('playing'))
  const gotTimeupdate = evs.some((e) => e.startsWith('timeupdate'))
  const gotError = evs.some((e) => e.startsWith('error')) || result.error
  const timeAdvanced = (result.currentTime || 0) > 2
  const readyHigh = (result.readyState || 0) >= 3

  console.log('\n===== 判定 =====')
  console.log(`触发 playing     : ${gotPlaying ? '✅' : '❌'}`)
  console.log(`触发 timeupdate  : ${gotTimeupdate ? '✅' : '❌'}`)
  console.log(`currentTime 前进 : ${timeAdvanced ? '✅' : '❌'} (${result.currentTime}s)`)
  console.log(`readyState≥3     : ${readyHigh ? '✅' : '❌'} (${result.readyState})`)
  console.log(`无 error         : ${!gotError ? '✅' : '❌ ' + JSON.stringify(result.error)}`)
  console.log(`duration         : ${result.duration} (直播流应为 Infinity 或持续增长)`)

  const pass = gotPlaying && gotTimeupdate && timeAdvanced && !gotError
  console.log(`\n${pass ? '✅ 裸 ADTS 连续流可被 Chromium <audio> 播放' : '❌ 播放失败，需另寻容器方案'}`)
  ws.close()
  process.exit(pass ? 0 : 1)
} finally {
  try { chrome2?.kill() } catch {}
  server.close()
}
