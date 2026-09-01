import { describe, it, expect } from 'vitest'
import {
  CN_HOLIDAYS, calendarForYear, buildCalendar, isCalendarWorkday,
  parseTimorCalendarYear, sanitizeCalendarCache,
} from '../lib/calendar.js'

const d = (s) => {
  const [y, m, dd] = s.split('-').map(Number)
  return new Date(y, m - 1, dd)
}

describe('CN_HOLIDAYS 内置日历（数据来自国务院放假安排通知）', () => {
  it('内置 2025 与 2026 两年数据', () => {
    expect(Object.keys(CN_HOLIDAYS).sort()).toEqual(['2025', '2026'])
  })
  it('2026 国庆放假（即使在工作日也放假）、周末调休补班记为工作日', () => {
    const y26 = CN_HOLIDAYS['2026']
    // 国庆 10-01~10-07 放假
    expect(y26['10-01']).toBe('holiday')
    expect(y26['10-02']).toBe('holiday') // 周五也放假
    expect(y26['10-07']).toBe('holiday')
    expect(y26['10-08']).toBeUndefined() // 10-08 为普通工作日，不在表内
    // 调休补班：9-20（周日）、10-10（周六）
    expect(y26['09-20']).toBe('workday')
    expect(y26['10-10']).toBe('workday')
  })
  it('2025 春节调休与 2026 元旦调休', () => {
    expect(CN_HOLIDAYS['2025']['01-28']).toBe('holiday') // 除夕
    expect(CN_HOLIDAYS['2025']['02-04']).toBe('holiday')
    expect(CN_HOLIDAYS['2025']['01-26']).toBe('workday')
    expect(CN_HOLIDAYS['2025']['02-08']).toBe('workday')
    expect(CN_HOLIDAYS['2026']['01-04']).toBe('workday') // 元旦补班
    expect(CN_HOLIDAYS['2026']['01-03']).toBe('holiday')
  })
})

describe('isCalendarWorkday（工作日含节假日/调休判断）', () => {
  const y26 = calendarForYear(2026)
  it('法定节假日：即使落在工作日也不上班', () => {
    expect(isCalendarWorkday(d('2026-10-01'), y26)).toBe(false) // 周四·国庆
    expect(isCalendarWorkday(d('2026-10-02'), y26)).toBe(false) // 周五·国庆
    expect(isCalendarWorkday(d('2026-10-07'), y26)).toBe(false) // 周三·国庆
    expect(isCalendarWorkday(d('2026-09-25'), y26)).toBe(false) // 周五·中秋
  })
  it('周末调休补班：即使落在周末也算工作日', () => {
    expect(isCalendarWorkday(d('2026-10-10'), y26)).toBe(true) // 周六·国庆补班
    expect(isCalendarWorkday(d('2026-09-20'), y26)).toBe(true) // 周日·国庆补班
    expect(isCalendarWorkday(d('2026-01-04'), y26)).toBe(true) // 周日·元旦补班
    expect(isCalendarWorkday(d('2025-02-08'), y26)).toBe(false) // 2025-02-08 不在 2026 表 → 周六默认非工作日
  })
  it('不在日历中的日期按星期回退：周一至周五=工作日、周六/周日=非工作日', () => {
    expect(isCalendarWorkday(d('2026-10-12'), y26)).toBe(true) // 周一
    expect(isCalendarWorkday(d('2026-10-08'), y26)).toBe(true) // 周四·非假期
    expect(isCalendarWorkday(d('2026-10-11'), y26)).toBe(false) // 周日
    expect(isCalendarWorkday(d('2026-10-03'), y26)).toBe(false) // 周六·但被国庆覆盖为放假
  })
  it('缺省日历（undefined）仅按星期判断', () => {
    expect(isCalendarWorkday(d('2026-10-12'), undefined)).toBe(true)
    expect(isCalendarWorkday(d('2026-10-11'), undefined)).toBe(false)
  })
  it('无效日期返回 false', () => {
    expect(isCalendarWorkday(new Date('invalid'), y26)).toBe(false)
    expect(isCalendarWorkday(null, y26)).toBe(false)
  })
})

describe('calendarForYear / buildCalendar', () => {
  it('calendarForYear 返回静态表的拷贝，可叠加外部覆盖（覆盖优先）', () => {
    const m = calendarForYear(2026, { '10-10': 'holiday', '12-31': 'workday', '99-99': 'bogus' })
    expect(m['10-01']).toBe('holiday')
    expect(m['10-10']).toBe('holiday') // 外部覆盖生效
    expect(m['12-31']).toBe('workday') // 外部新增生效
    expect(m['99-99']).toBeUndefined() // 非法值忽略
    // 不污染静态表
    expect(CN_HOLIDAYS['2026']['10-10']).toBe('workday')
  })
  it('calendarForYear 未知年份返回空对象（不抛错）', () => {
    expect(calendarForYear(2030)).toEqual({})
  })
  it('buildCalendar 合并多年份（含外部覆盖年份）', () => {
    const c = buildCalendar({ 2027: { '01-01': 'holiday' } })
    expect(Object.keys(c).sort()).toEqual(['2025', '2026', '2027'])
    expect(c['2026']['10-10']).toBe('workday')
    expect(c['2027']['01-01']).toBe('holiday')
  })
})

describe('parseTimorCalendarYear（在线接口解析）', () => {
  it('解析 holiday:true → holiday、holiday:false → workday', () => {
    const json = {
      code: 0,
      holiday: {
        '10-01': { holiday: true, name: '国庆节', date: '2026-10-01' },
        '10-10': { holiday: false, name: '国庆节后补班', after: true, date: '2026-10-10' },
        '02-14': { holiday: false, name: '春节前补班', date: '2026-02-14' },
      },
    }
    expect(parseTimorCalendarYear(json)).toEqual({
      '10-01': 'holiday',
      '10-10': 'workday',
      '02-14': 'workday',
    })
  })
  it('响应结构非法 / 无有效条目 → null', () => {
    expect(parseTimorCalendarYear(null)).toBe(null)
    expect(parseTimorCalendarYear({ code: 0, holiday: {} })).toBe(null)
    expect(parseTimorCalendarYear({ code: 1, msg: 'error' })).toBe(null)
    // 键格式非法 / holiday 字段缺失 → 丢弃
    const j = { holiday: { '99-99': { holiday: true }, '10-01': { foo: 1 } } }
    expect(parseTimorCalendarYear(j)).toBe(null)
  })
  it('与内置静态表一致（用真实接口样例 2026 抽查）', () => {
    const json = {
      holiday: {
        '10-01': { holiday: true, name: '国庆节' },
        '10-07': { holiday: true, name: '国庆节' },
        '09-20': { holiday: false, name: '中秋节前补班' },
        '10-10': { holiday: false, name: '国庆节后补班' },
        '01-04': { holiday: false, name: '元旦后补班' },
      },
    }
    const m = parseTimorCalendarYear(json)
    expect(m['10-01']).toBe('holiday')
    expect(m['10-07']).toBe('holiday')
    expect(m['09-20']).toBe('workday')
    expect(m['10-10']).toBe('workday')
    expect(m['01-04']).toBe('workday')
  })
})

describe('sanitizeCalendarCache（在线缓存落盘/加载规整）', () => {
  it('空输入 → 空缓存（不抛错）', () => {
    expect(sanitizeCalendarCache(null)).toEqual({ byYear: {}, fetchedAt: {}, source: 'timor.tech' })
    expect(sanitizeCalendarCache('x')).toEqual({ byYear: {}, fetchedAt: {}, source: 'timor.tech' })
  })
  it('保留合法条目、丢弃非法键/值，fetchedAt 同步', () => {
    const c = sanitizeCalendarCache({
      byYear: {
        '2026': { '10-01': 'holiday', '10-10': 'workday', '99-99': 'holiday', '10-11': 'bogus' },
        '20xx': { '01-01': 'holiday' },
      },
      fetchedAt: { '2026': 1234567890 },
      source: 'timor.tech',
    })
    expect(c.byYear['2026']).toEqual({ '10-01': 'holiday', '10-10': 'workday' })
    expect(c.fetchedAt['2026']).toBe(1234567890)
    expect(c.byYear['20xx']).toBeUndefined()
    expect(c.source).toBe('timor.tech')
  })
})
