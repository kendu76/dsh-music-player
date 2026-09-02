/**
 * lib/lyric.js — 本地歌曲「在线歌词兜底」：QQ 音乐 → 酷狗 → 网易云 → LRCLIB。
 *
 * 场景：本地音乐没有同名 .lrc 时，先用文件名（可带歌手/时长）在 QQ 匿名接口搜歌、
 * 取官方歌词（含逐句翻译）；QQ 无果再查酷狗（KRC 逐字，含内嵌翻译）；再查网易云
 * （LRC+逐句翻译，匿名可用）；最后查 LRCLIB（免费、无需 key、返回同步 LRC）。
 *
 * 纯 Node（Node ≥ 20，用全局 fetch），无第三方依赖，无编译步骤。
 *
 * ⚠️ 合规：歌词文本/翻译版权归著作权人及对应平台所有，仅供个人学习、技术研究、
 * 日常个人试听使用；严禁商业用途、公开传播、二次分发。非官方接口随时可能变更，
 * 所有出网请求带超时，失败一律静默回退（保持「无歌词」的现状，不打扰播放）。
 */

import * as QQ from './qq.js'
import * as KG from './kugou.js'
import * as NC from './netease.js'

const LRCLIB_API = 'https://lrclib.net/api'
const LRCLIB_UA = 'dsh-music-player/1.0 (local lyric fallback; rate-limited+cached)'

// 出网统一超时（与 qq.js 同构）：Node fetch 默认无超时，端点挂起会让播放流程卡住。
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// =====================================================================
// LRCLIB（https://lrclib.net）— 免费公开歌词 API，无需 key、CORS 开启、返回同步 LRC。
// 端点：GET /api/search?q=  （模糊，返回数组 ≤20 条，无结果返回空数组）
//       GET /api/get/<id>  （按 id 取单条）
// 记录字段：id / trackName / artistName / albumName / duration / instrumental /
//          plainLyrics / syncedLyrics（标准 LRC：[mm:ss.xx] 时间戳 + [ti:]/[ar:] 元数据）
// 注意：URL 查询参数必须百分号编码（直接放中文会 400）——用 URLSearchParams 构造。
// =====================================================================

// 搜索并归一化为候选数组（只保留带同步歌词的非纯音乐候选；纯音乐没有逐字歌词意义）。
export async function lrclibSearch(keyword) {
  const p = new URLSearchParams({ q: String(keyword || '') })
  const res = await fetchWithTimeout(`${LRCLIB_API}/search?${p.toString()}`, {
    headers: { Accept: 'application/json', 'User-Agent': LRCLIB_UA },
  })
  if (res.status !== 200) throw new Error('lrclib search http ' + res.status)
  const arr = await res.json().catch(() => null)
  if (!Array.isArray(arr)) throw new Error('lrclib search payload')
  return arr
    .filter((r) => r && typeof r.trackName === 'string'
      && typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim() !== '')
    .map((r) => ({
      id: r.id,
      title: r.trackName,
      artist: r.artistName || '',
      duration: Number(r.duration),
      instrumental: !!r.instrumental,
      synced: r.syncedLyrics,
    }))
}

// =====================================================================
// 匹配打分：把候选（标题/歌手/时长/是否纯音乐）与期望值比对，返回 0..100 置信度。
// 标题为主信号（精确 60 / 包含 42 / 分词重叠），歌手为强副信号（精确 30 / 包含 20），
// 时长相近加分，纯音乐重罚。仅当分数 ≥ MIN_SCORE 才采信，避免「错配歌词」比「没有歌词」更糟。
// 导出供测试。
// =====================================================================

// 归一化用于比对：小写、去空白与常见分隔/标点/括号/引号。
export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000\-_/\\,.;:，。；：！？!?·'"“”‘’（）()\[\]【】《》〈〉<>「」『』…—～~]+/g, '')
    .trim()
}

// 轻量分词：拉丁词 + CJK 二元组（2-gram），供「包含」都不满足时做重叠匹配。
function tokenize(s) {
  const out = []
  for (const w of s.match(/[a-z0-9]+/g) || []) out.push(w)
  const cjk = s.replace(/[a-z0-9]+/g, '')
  for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2))
  return out
}

export function scoreCandidate(cand, want) {
  const wt = normalizeText(want && want.title)
  const wa = want && want.artist ? normalizeText(want.artist) : ''
  const ct = normalizeText(cand && cand.title)
  const ca = cand && cand.artist ? normalizeText(cand.artist) : ''
  let score = 0
  if (wt !== '' && ct !== '') {
    if (ct === wt) score += 60
    else if (ct.includes(wt) || wt.includes(ct)) score += 42
    else {
      const wts = tokenize(wt); const cts = tokenize(ct)
      const inter = wts.filter((t) => cts.includes(t)).length
      if (inter > 0) score += Math.min(40, inter * 12)
    }
  }
  if (wa !== '' && ca !== '') {
    if (ca === wa) score += 30
    else if (ca.includes(wa) || wa.includes(ca)) score += 20
  } else if (wa === '') {
    score += 5 // 未知歌手：中性偏袒（不惩罚，也不确认）
  }
  const cd = Number(cand && cand.duration)
  const wd = Number(want && want.duration)
  if (Number.isFinite(cd) && cd > 0 && Number.isFinite(wd) && wd > 0) {
    const d = Math.abs(cd - wd)
    if (d <= 5) score += 12
    else if (d <= 15) score += 6
  }
  if (cand && cand.instrumental) score -= 40
  return score
}

// 在候选中挑最高分者；返回 { best, score }（best 可为 null）。
export function pickBest(candidates, want) {
  let best = null, bestScore = -1
  for (const c of candidates) {
    const s = scoreCandidate(c, want)
    if (s > bestScore) { bestScore = s; best = c }
  }
  return { best, score: bestScore }
}

// 采信阈值：标题精确(60)即接受；「包含 + 时长接近」也可达 ~54；含糊不取。
const MIN_SCORE = 52

// =====================================================================
// 在线兜底主入口：依次尝试 QQ 音乐 → LRCLIB。
// 入参 { title, artist, duration?, qqCookie? }；返回统一结构或 null：
//   { source: 'qq'|'lrclib', matched: {title, artist, songmid?|id?, score},
//     lrcText, transText }   // transText 仅 QQ（逐句翻译，可为空串）
// 两个源都失败/无好匹配时返回 null（调用方按「无歌词」处理）。
// =====================================================================
export async function getOnlineLyric({ title = '', artist = '', duration = null, qqCookie = '' } = {}) {
  const want = {
    title: String(title || '').trim(),
    artist: String(artist || '').trim(),
    duration: Number.isFinite(duration) ? duration : null,
  }
  if (want.title === '') return null

  // 1) QQ 音乐（匿名搜索 + 官方歌词；先试逐字 QRC，再退普通 LRC）
  try {
    const kw = want.artist !== '' ? want.title + ' ' + want.artist : want.title
    const s = await QQ.search(kw, qqCookie, 1)
    const cands = (s.results || []).map((r) => ({
      title: r.title,
      artist: (r.artists || []).join('/'),
      duration: Number(r.interval),
      songmid: r.songmid,
      songid: r.songid,
      album: r.album || '',
      instrumental: false,
    }))
    const { best, score } = pickBest(cands, want)
    if (best && best.songmid && score >= MIN_SCORE) {
      // —— QRC 逐字歌词优先：需要数字 songID。接口只对有逐字数据的歌返回 qrc_t≠0，
      //    否则返回 null（此时自然落到下方普通 LRC）；任何网络/解密错误也静默回落。
      //    成功返回的 wordLines 是秒时基的精确行窗口 [{t,end,text}]。
      try {
        const q = await QQ.getQrcLyric({
          songid: best.songid,
          interval: best.duration > 0 ? best.duration : (want.duration ?? 0),
          title: best.title,
          artist: best.artist,
          album: best.album,
        }, qqCookie)
        if (q !== null && Array.isArray(q.lines) && q.lines.length > 0) {
          return {
            source: 'qq-qrc',
            matched: { title: best.title, artist: best.artist, songmid: best.songmid, score },
            wordLines: q.lines,
            lrcText: '',
            transText: '',
          }
        }
      } catch { /* QRC 失败 → 普通 LRC 兜底 */ }
      const g = await QQ.getLyric(best.songmid, qqCookie)
      const lrcText = (g.lyric || '').trim()
      if (lrcText !== '') {
        return {
          source: 'qq',
          matched: { title: best.title, artist: best.artist, songmid: best.songmid, score },
          lrcText,
          transText: (g.trans || '').trim(),
        }
      }
    }
  } catch { /* QQ 失败/无匹配 → 尝试下一源 */ }

  // 2) 酷狗音乐（匿名搜索 + KRC 逐字/LRC；词窗结构直接复用 qrc 形状）
  try {
    const kw = want.artist !== '' ? want.title + ' ' + want.artist : want.title
    const s = await KG.search(kw, '', 1)
    const cands = (s.results || []).map((r) => ({
      title: r.title,
      artist: (r.artists || []).join('/'),
      duration: Number(r.interval),
      hash: r.hash,
      albumAudioId: r.albumAudioId,
    }))
    const { best, score } = pickBest(cands, want)
    if (best && best.hash && score >= MIN_SCORE) {
      // —— 逐字 KRC 优先（内部自带候选打分与回落逻辑）；词窗形状与 qq-qrc 一致
      try {
        const w = await KG.getWordLines({
          hash: best.hash,
          title: best.title,
          artist: best.artist,
          durationSec: best.duration > 0 ? best.duration : (want.duration ?? 0),
        })
        if (w !== null && Array.isArray(w.lines) && w.lines.length > 0) {
          return {
            source: 'kg-krc',
            matched: { title: best.title, artist: best.artist, hash: best.hash, score },
            wordLines: w.lines,
            translations: w.translations || null,
            lrcText: '',
            transText: '',
          }
        }
      } catch { /* KRC 失败 → 普通 LRC 兜底 */ }
      const g = await KG.getLyric({
        hash: best.hash,
        title: best.title,
        artist: best.artist,
        durationSec: best.duration > 0 ? best.duration : (want.duration ?? 0),
      })
      const lrcText = (g.lyric || '').trim()
      if (lrcText !== '') {
        return {
          source: 'kugou',
          matched: { title: best.title, artist: best.artist, hash: best.hash, score },
          lrcText,
          transText: '',
        }
      }
    }
  } catch { /* 酷狗失败/无匹配 → 尝试下一源 */ }

  // 2.5) 网易云音乐（匿名搜索 + LRC+逐句翻译；YRC 逐字覆盖率有限，此处先回落整行 LRC）
  try {
    const kw = want.artist !== '' ? want.title + ' ' + want.artist : want.title
    const s = await NC.search(kw, '', 1)
    const cands = (s.results || []).map((r) => ({
      title: r.title,
      artist: (r.artists || []).join('/'),
      duration: Number(r.interval),
      id: r.id,
    }))
    const { best, score } = pickBest(cands, want)
    if (best && best.id && score >= MIN_SCORE) {
      const g = await NC.getLyric(best.id)
      const lrcText = (g.lyric || '').trim()
      if (lrcText !== '') {
        return {
          source: 'netease',
          matched: { title: best.title, artist: best.artist, id: best.id, score },
          lrcText,
          transText: (g.trans || '').trim(),
        }
      }
    }
  } catch { /* 网易云失败/无匹配 → 尝试下一源 */ }

  // 3) LRCLIB（免费、无需 key、同步 LRC）
  try {
    const cands = await lrclibSearch(want.title)
    const { best, score } = pickBest(cands, want)
    if (best && best.synced && score >= MIN_SCORE) {
      return {
        source: 'lrclib',
        matched: { title: best.title, artist: best.artist, id: best.id, score },
        lrcText: best.synced.trim(),
        transText: '',
      }
    }
  } catch { /* 失败静默 */ }

  return null
}
