/**
 * 中国法定节假日 / 调休日历（离线内置，无需网络）。
 *
 * 数据来源：国务院办公厅历年《关于部分节假日安排的通知》：
 *   2025：国办发明电〔2024〕12 号（2024-11-12 发布）
 *   2026：国办发明电〔2025〕7 号（2025-11-04 发布）
 * 每年年底国务院公布次年安排后，在本文件 CN_HOLIDAYS 追加一年的键值对即可，
 * 逻辑无需改动；不在日历内的年份/日期自动回退「周一至周五 = 工作日」。
 *
 * 语义：
 *   'holiday' = 法定节假日放假（即使落在工作日也不上班）
 *   'workday' = 周末调休补班（即使落在周末也要上班）
 *
 * 本模块为纯逻辑（不依赖 fs / 网络 / DSH），可独立单测；lib/news-core.js 的
 * shiftFiresAt 借它判断「仅工作日」班次是否到点触发。
 */

/** 各年份节假日/调休表：'YYYY' → { 'MM-DD': 'holiday'|'workday' }。 */
export const CN_HOLIDAYS = {
  2025: {
    // 元旦：1月1日（周三）放假 1 天，不调休
    '01-01': 'holiday',
    // 春节：1月28日（除夕）至2月4日放假调休 8 天；1月26日（周日）、2月8日（周六）上班
    '01-28': 'holiday', '01-29': 'holiday', '01-30': 'holiday', '01-31': 'holiday',
    '02-01': 'holiday', '02-02': 'holiday', '02-03': 'holiday', '02-04': 'holiday',
    '01-26': 'workday', '02-08': 'workday',
    // 清明节：4月4日至6日放假 3 天
    '04-04': 'holiday', '04-05': 'holiday', '04-06': 'holiday',
    // 劳动节：5月1日至5日放假调休 5 天；4月27日（周日）上班
    '05-01': 'holiday', '05-02': 'holiday', '05-03': 'holiday', '05-04': 'holiday', '05-05': 'holiday',
    '04-27': 'workday',
    // 端午节：5月31日至6月2日放假 3 天
    '05-31': 'holiday', '06-01': 'holiday', '06-02': 'holiday',
    // 国庆节、中秋节：10月1日至8日放假调休 8 天；9月28日（周日）、10月11日（周六）上班
    '10-01': 'holiday', '10-02': 'holiday', '10-03': 'holiday', '10-04': 'holiday',
    '10-05': 'holiday', '10-06': 'holiday', '10-07': 'holiday', '10-08': 'holiday',
    '09-28': 'workday', '10-11': 'workday',
  },
  2026: {
    // 元旦：1月1日至3日放假调休 3 天；1月4日（周日）上班
    '01-01': 'holiday', '01-02': 'holiday', '01-03': 'holiday',
    '01-04': 'workday',
    // 春节：2月15日至23日放假调休 9 天；2月14日（周六）、2月28日（周六）上班
    '02-15': 'holiday', '02-16': 'holiday', '02-17': 'holiday', '02-18': 'holiday',
    '02-19': 'holiday', '02-20': 'holiday', '02-21': 'holiday', '02-22': 'holiday', '02-23': 'holiday',
    '02-14': 'workday', '02-28': 'workday',
    // 清明节：4月4日至6日放假 3 天
    '04-04': 'holiday', '04-05': 'holiday', '04-06': 'holiday',
    // 劳动节：5月1日至5日放假调休 5 天；5月9日（周六）上班
    '05-01': 'holiday', '05-02': 'holiday', '05-03': 'holiday', '05-04': 'holiday', '05-05': 'holiday',
    '05-09': 'workday',
    // 端午节：6月19日至21日放假 3 天
    '06-19': 'holiday', '06-20': 'holiday', '06-21': 'holiday',
    // 中秋节：9月25日至27日放假 3 天
    '09-25': 'holiday', '09-26': 'holiday', '09-27': 'holiday',
    // 国庆节：10月1日至7日放假调休 7 天；9月20日（周日）、10月10日（周六）上班
    '10-01': 'holiday', '10-02': 'holiday', '10-03': 'holiday', '10-04': 'holiday',
    '10-05': 'holiday', '10-06': 'holiday', '10-07': 'holiday',
    '09-20': 'workday', '10-10': 'workday',
  },
}

/**
 * 合并某年的工作日历：静态内置 + 外部覆盖（如未来在线同步的节假日数据），
 * 覆盖条目优先；非法值忽略。返回该年的 { 'MM-DD': 'holiday'|'workday' } 映射。
 */
export function calendarForYear(year, extra) {
  const base = CN_HOLIDAYS[year] || {}
  if (!extra || typeof extra !== 'object') return { ...base }
  const out = { ...base }
  for (const k of Object.keys(extra)) {
    const v = extra[k]
    if (v === 'holiday' || v === 'workday') out[k] = v
  }
  return out
}

/**
 * 合并多年份的完整日历：{ 'YYYY': { 'MM-DD': 'holiday'|'workday' } }。
 * 供 Host 定时器一次性构建后复用；extraByYear 为可选的外部覆盖（如在线同步数据）。
 */
export function buildCalendar(extraByYear) {
  const years = new Set([...Object.keys(CN_HOLIDAYS), ...Object.keys(extraByYear || {})])
  const out = {}
  for (const y of years) out[y] = calendarForYear(y, extraByYear && extraByYear[y])
  return out
}

/**
 * 判断某天是否为工作日（含节假日/调休语义）：
 *  - 日历命中：'workday'（周末调休补班）→ 工作日；'holiday'（法定节假日）→ 非工作日；
 *  - 未命中：默认周一至周五为工作日、周六/周日为非工作日。
 * @param {Date} date
 * @param {object} [yearMap] 该年的 { 'MM-DD': 'holiday'|'workday' } 日历；缺省仅按星期判断
 */
export function isCalendarWorkday(date, yearMap) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const t = yearMap && yearMap[mm + '-' + dd]
  if (t === 'holiday') return false // 法定节假日放假（即使工作日也不上班）
  if (t === 'workday') return true // 周末调休补班（即使周末也要上班）
  const dow = date.getDay()
  return dow !== 0 && dow !== 6
}

/**
 * 解析 timor.tech 整年节假日接口（https://timor.tech/api/holiday/year/<year>）的响应：
 *   { "holiday": { "MM-DD": { "holiday": true|false, "name": "…", "date": "YYYY-MM-DD" }, … } }
 * holiday:true = 法定节假日放假；holiday:false = 周末调休补班。
 * 返回该年 { 'MM-DD': 'holiday'|'workday' } 映射；响应结构非法/无有效条目返回 null。
 */
export function parseTimorCalendarYear(json) {
  if (!json || typeof json !== 'object') return null
  const h = json.holiday
  if (!h || typeof h !== 'object') return null
  const out = {}
  for (const k of Object.keys(h)) {
    const v = h[k]
    if (!v || typeof v !== 'object' || typeof v.holiday !== 'boolean') continue
    if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(k)) continue
    out[k] = v.holiday ? 'holiday' : 'workday'
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 规整持久化的在线节假日缓存（Host 落盘 / 加载共用）：
 *   { byYear: { 'YYYY': { 'MM-DD': 'holiday'|'workday' } }, fetchedAt: { 'YYYY': ts }, source }
 * 非法字段丢弃、超限截断；损坏输入回退为空缓存（不影响功能——回落内置表/周一至周五）。
 */
export function sanitizeCalendarCache(input) {
  const out = { byYear: {}, fetchedAt: {}, source: 'timor.tech' }
  if (!input || typeof input !== 'object') return out
  if (typeof input.source === 'string' && input.source !== '') out.source = input.source.slice(0, 40)
  const byYear = input.byYear && typeof input.byYear === 'object' ? input.byYear : {}
  const fetchedAt = input.fetchedAt && typeof input.fetchedAt === 'object' ? input.fetchedAt : {}
  for (const y of Object.keys(byYear)) {
    if (!/^\d{4}$/.test(y)) continue
    const m = byYear[y]
    if (!m || typeof m !== 'object') continue
    const clean = {}
    for (const k of Object.keys(m)) {
      const v = m[k]
      if ((v === 'holiday' || v === 'workday') && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(k)) {
        clean[k] = v
      }
    }
    if (Object.keys(clean).length > 0) {
      out.byYear[y] = clean
      out.fetchedAt[y] = Number(fetchedAt[y]) > 0 ? Number(fetchedAt[y]) : 0
    }
  }
  return out
}
