/**
 * dsh-music-player 版本更新弹窗（What's New）数据模块。
 *
 * 每次发版在 WHATS_NEW 数组【顶部】追加一条本版条目（version 与 package.json
 * 同步），Host 经 /dsh-music/manifest 下发给浏览器弹出「新版本」窗口；更早的
 * 条目成为「历史版本」折叠列表的内容，只保留最近 WHATS_NEW_MAX 条。
 *
 * 「是否弹、以哪种模式弹」的判定也在本模块（whatsNewState），由 Host 结合
 * serverPrefs 里的已看标记计算后随 manifest 下发结论，浏览器端不再自行比较
 * 版本号（client.js 无法 import 本模块，见该文件头部说明）：
 *   - 'fresh'     首次安装：无已看记录且 prefs 里没有任何其他键
 *   - 'upgrade'   升级：已看记录比当前版旧（含「老用户无记录」启发式）
 *   - 'seen'      当前版本已经看过，不再打扰
 *   - 'downgrade' 降级安装：静默把已看标记改写为当前版，不弹
 */

// serverPrefs 里「已看过哪个版本」的键（与 lib/index.js PREF_ALLOW、
// lib/client.js PREF_KEYS 三处保持一致；漏登记会被 sanitizePrefs 静默丢弃，
// 表现为「每次启动都弹」）。
export const PREF_SEEN_VERSION = 'dsh-music-seen-version'

// 历史条目保留上限：更早的条目不随 manifest 下发（控制响应体积）。
export const WHATS_NEW_MAX = 10

// 首次安装（welcome 模式）展示的核心卖点，独立于任何版本条目。
export const WELCOME = {
  title: '欢迎使用 DSH 音乐播放器',
  sections: [
    {
      type: 'feature',
      items: [
        '本地音乐：自动扫描 ~/Music（或自定义目录），FLAC / MP3 / WAV 等主流格式自动识别音质档位',
        'AI 讲书：.txt / .epub 小说经 TTS 合成朗读，支持章节目录、倍速与续播',
        '在线音乐：内置 QQ 音乐 / 酷狗，扫码登录后可播 VIP 曲目与高音质',
        '对话点歌：注册 music_play 模型工具，对 AI 说一句即可点歌 / 听书 / 切歌单',
      ],
    },
  ],
}

// 版本更新条目：新 → 旧。type 仅支持 feature / improve / fix（未知类型按
// improve 渲染兜底）。date 为该版本发布日期（YYYY-MM-DD）。
export const WHATS_NEW = [
  {
    version: '0.8.1',
    date: '2026-09-02',
    title: '修复与打磨：RSS 信源池、工作日定时与 UI 细节',
    sections: [
      {
        type: 'fix',
        items: [
          'AI 讲书中小说分块算法',
          '新闻播报增加 RSS 数据收集，可以减少 web search 产生的费用',
          '完善新闻播报定时任务，支持工作日定时',
          '修复一些小问题，打磨 UI 细节',
        ],
      },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-09-01',
    title: '新增每日新闻播报、内嵌歌词与歌词翻译',
    sections: [
      {
        type: 'feature',
        items: [
          '新增每日新闻播报功能：需配置文本模型（有 Token 消耗），使用与 AI 讲书相同的 AI 语音（xiaomi）',
          '支持音乐文件内嵌歌词',
          '支持带翻译的歌词',
        ],
      },
      {
        type: 'fix',
        items: ['修复一些小问题'],
      },
    ],
  },
  {
    version: '0.7.3',
    date: '2026-08-30',
    title: '播放条交互优化与版本更新弹窗',
    sections: [
      {
        type: 'feature',
        items: [
          '控制按钮滑入滑出：改为播放条右侧区域捕获鼠标事件',
          '歌词/字幕面板：单击播放条中歌词打开',
          '播放面板：单击播放条中歌曲/小说名称打开',
          '版本更新弹窗：首次安装或升级后自动介绍本版变化与重点特性',
        ],
      },
    ],
  },
]

// ---- semver 比较（零依赖，够用即可）----
// 解析 "主.次.修订[-预发布]"，如 '0.10.0'、'0.8.0-beta.1'。无法解析的段按 0 处理。
function parseSemver(v) {
  const s = String(v || '').trim().replace(/^v/i, '')
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?$/.exec(s)
  if (!m) return { nums: [0, 0, 0], pre: null }
  const pre = m[4] === undefined ? null : m[4].split('.')
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre }
}

// a < b → -1；a === b → 0；a > b → 1。预发布版低于同版本号的正式版
// （0.8.0-beta.1 < 0.8.0）；预发布标识逐段比较，数字段按数值、其余按字典序。
export function cmpSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1 // 正式版 > 预发布
  if (pb.pre === null) return -1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1 // 段数少的一方更低（1.0.0-alpha < 1.0.0-alpha.1）
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) { const d = Number(x) - Number(y); if (d !== 0) return d < 0 ? -1 : 1 }
    else if (xn !== yn) return xn ? -1 : 1 // 数字段 < 非数字段（semver 规则）
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// 查询指定版本的条目与历史列表（历史含当前版，新 → 旧，截断到 WHATS_NEW_MAX）。
// 当前版没有条目时 entry 为 null（Host 据此不下发弹窗内容）。
export function whatsNewFor(version) {
  const cur = String(version || '')
  const entry = WHATS_NEW.find((e) => e && e.version === cur) || null
  return { entry, history: WHATS_NEW.slice(0, WHATS_NEW_MAX) }
}

// 弹窗判定（见文件头注释）。prefs 为 serverPrefs 快照（键值对）；
// 「老用户启发式」：无已看记录但 prefs 里已有其他键（音量/播放进度等），
// 视为从旧版本升级上来的老用户 → 'upgrade' 而非 'fresh'。
export function whatsNewState(current, seenVersion, prefs) {
  const cur = String(current || '')
  const seen = String(seenVersion || '')
  if (seen !== '' && cmpSemver(seen, cur) > 0) return 'downgrade'
  if (seen === cur) return 'seen'
  if (seen !== '') return 'upgrade'
  const hasOthers = prefs !== null && typeof prefs === 'object'
    && Object.keys(prefs).some((k) => k !== PREF_SEEN_VERSION)
  return hasOthers ? 'upgrade' : 'fresh'
}
