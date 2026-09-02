/**
 * lib/yrc.js — 网易云逐字歌词（YRC）解析。
 *
 * 与 lib/qrc.js（QQ QRC）/ lib/krc.js（酷狗 KRC）同层级，产出对齐：
 * 解析结果为 [{ t, end, text }]（秒时基、含行结束时间的精确行窗口），可直接喂给
 * 客户端现有的整行扫色逻辑；词级时间轴保留在 words 字段备用。
 *
 * YRC 格式（实测/参考 music-lib lyrics.ParseYRC，逐字数据明文、无需解密）：
 *   - 行：  [起始ms,持续ms]歌词内容
 *   - 词：  (词起始ms,词时长ms,占位)字…… —— 词起始为【绝对毫秒】（与 KRC 的行内相对偏移不同）
 *   - 纯文本行（无逐词标签）直接作为整行；元数据行 [ti:][ar:][by:] 等跳过
 *
 * ⚠️ 合规：歌词版权归著作权人及网易云平台所有，仅个人试听使用。
 */

// 行：`[startMs,durMs]content`
const LINE_RE = /^\[(\d+),(\d+)\](.*)$/
// 词：`(wordStartMs,wordDurMs,占位)text`（text 以 [ 或 ( 结束，避免吞掉后续标签）
const WORD_RE = /\((\d+),(\d+),\d+\)([^\(\[]*)/g

// 唱完后再让高亮保持一小会的自然尾巴（与 qrc.js/krc.js 同值，保持三来源行为一致）
const VOCAL_TAIL_MS = 400

/**
 * 解析 YRC 明文 → { lines, wordLevel }。
 * lines 形状与 qrc.js/krc.js 对齐：[{ t, end, text }]（t/end 秒时基；含词级时间轴的
 * 行额外带 words:[{ t, end, text }]）。
 */
export function parseYrc(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const lines = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (/^\[[A-Za-z#]+:/i.test(line)) continue // 元数据行 [ti:][ar:] 等
    const m = LINE_RE.exec(line)
    if (!m) continue
    const startMs = Number(m[1]) || 0
    const durMs = Number(m[2]) || 0
    const content = m[3]
    const words = []
    let plainText = ''
    WORD_RE.lastIndex = 0
    let w
    while ((w = WORD_RE.exec(content)) !== null) {
      const wText = w[3] || ''
      const wStart = Number(w[1]) || 0 // 绝对毫秒
      const wDur = Number(w[2]) || 0
      if (wText !== '') words.push({ startMs: wStart, durMs: wDur, text: wText })
      plainText += wText
    }
    // 无逐词标签：整行文本
    const finalText = (plainText !== '' ? plainText : content).trim()
    if (finalText === '') continue

    let endMs = startMs + Math.max(0, durMs)
    if (words.length > 0) {
      const absEndMax = Math.max(...words.map((x) => x.startMs + x.durMs))
      if (absEndMax > startMs && absEndMax <= startMs + Math.max(durMs, 1)) {
        endMs = Math.min(endMs, Math.max(startMs + 600, absEndMax + VOCAL_TAIL_MS))
      }
    }
    lines.push({
      t: startMs / 1000,
      end: endMs / 1000,
      text: finalText,
      ...(words.length > 0 ? { words: words.map((x) => ({ t: x.startMs / 1000, end: (x.startMs + x.durMs) / 1000, text: x.text })) } : {}),
    })
  }
  if (lines.length === 0) return null
  return { lines, wordLevel: lines.some((l) => Array.isArray(l.words)) }
}
