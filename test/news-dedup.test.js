/**
 * 工具层确定性去重纯函数单测（RFC: docs/news-rss-pool-rfc.md §7）。
 * 覆盖：normalizeTitle（标点/前缀/日期剥离）、bigrams/bigramJaccard、
 * titlesDuplicate（相等/包含/Jaccard）、dedupeItemsAgainst（批内/参照组/升级替换）。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeTitle, bigrams, bigramJaccard, unigramJaccard, titlesDuplicate, dedupeItemsAgainst,
} from '../lib/news-core.js'

describe('normalizeTitle', () => {
  it('小写化 + 去全角/半角标点 + 折叠空白', () => {
    // 全角 ｜！ 等被替换为空格后折叠；「某AI模型发布」的 AI 与 模型 相邻无空格。
    expect(normalizeTitle(' 独家｜重磅！某AI模型发布！！ ')).toBe('某ai模型发布')
    expect(normalizeTitle('新华社：政策发布，多地响应')).toBe('新华社 政策发布 多地响应')
  })
  it('去前缀词（独家/重磅/快讯/突发等，循环剥）', () => {
    expect(normalizeTitle('独家重磅快讯：某某事件')).toBe('某某事件')
    expect(normalizeTitle('突发！刚刚，某某地发生地震')).toBe('某某地发生地震')
  })
  it('去数字日期片段', () => {
    expect(normalizeTitle('2026年5月30日 国新办发布会')).not.toContain('2026')
    expect(normalizeTitle('5月30日 科技新闻')).not.toContain('5月')
  })
  it('空/极短输入返回清理后文本', () => {
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle('！！！')).toBe('')
  })
})

describe('bigrams / bigramJaccard', () => {
  it('中文按字对取 bigram', () => {
    expect(bigrams('政策')).toEqual(new Set(['政策']))
    expect(bigrams('政策发布').size).toBe(3) // 政策/策发/发布
  })
  it('完全相似 = 1，完全无关 = 0', () => {
    expect(bigramJaccard('政策发布会召开', '政策发布会召开')).toBe(1)
    expect(bigramJaccard('苹果', '火箭')).toBe(0)
  })
  it('相似标题 unigram Jaccard 较高（bigram 单信号过严，unigram 补足）', () => {
    expect(unigramJaccard('多地迎来强降雨', '多地持续强降雨')).toBeGreaterThan(0.5)
    expect(bigramJaccard('多地迎来强降雨', '多地持续强降雨')).toBeLessThan(0.5) // bigram 不足
  })
})

describe('titlesDuplicate', () => {
  it('相等 → 重复', () => {
    expect(titlesDuplicate('政策发布', '政策发布')).toBe(true)
  })
  it('较长包含较短且长度比 ≥ 0.6 → 重复', () => {
    expect(titlesDuplicate('多地迎来强降雨并启动应急响应', '多地迎来强降雨')).toBe(true)
  })
  it('Jaccard ≥ 0.7 → 重复', () => {
    expect(titlesDuplicate('多地迎来强降雨', '多地持续强降雨')).toBe(true)
  })
  it('无关标题不误判', () => {
    expect(titlesDuplicate('政策发布会召开', '娱乐新片上映')).toBe(false)
  })
})

describe('dedupeItemsAgainst', () => {
  const refs = [
    { title: '多地迎来强降雨', summary: 's', source: '央视新闻' },
    { title: 'AI 模型密集发布', summary: 's', source: '机器之心' },
  ]
  it('与参照组重复的条目被剔除', () => {
    const items = [
      { title: '多地迎来强降雨', summary: '重复', source: '央视新闻' },
      { title: '新一代模型发布', summary: '新的', source: 'IT之家' },
    ]
    const r = dedupeItemsAgainst(items, refs)
    expect(r.kept.map((k) => k.title)).toEqual(['新一代模型发布'])
    expect(r.dropped).toHaveLength(1)
    expect(r.upgrades).toBe(0)
  })
  it('批内互斥去重（同一提交里措辞不同的重复）', () => {
    const items = [
      { title: '多地迎来强降雨', summary: 'a', source: '央视' },
      { title: '多地持续强降雨', summary: 'b', source: '新华社' }, // 与上条重复 → 剔除
      { title: '新片上映', summary: 'c', source: '新浪' },
    ]
    const r = dedupeItemsAgainst(items, [])
    expect(r.kept).toHaveLength(2)
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0].title).toBe('多地持续强降雨')
  })
  it('来源更权威（official）可升级替换参照条目', () => {
    const sourceRank = (s) => (s === '新华社' ? 3 : s === '央视新闻' ? 2 : s === 'IT之家' ? 1 : 0)
    const items = [
      { title: '多地迎来强降雨', summary: '官方口径', source: '新华社' },
    ]
    const r = dedupeItemsAgainst(items, refs, { sourceRank })
    expect(r.upgrades).toBe(1)
    expect(r.kept).toHaveLength(1) // 提交保留
    expect(r.dropped).toHaveLength(0)
  })
  it('提交来源不更权威 → 照常剔除', () => {
    const sourceRank = (s) => (s === '新华社' ? 3 : s === '央视新闻' ? 2 : 0)
    const items = [{ title: '多地迎来强降雨', summary: '二手', source: '某聚合号' }]
    const r = dedupeItemsAgainst(items, refs, { sourceRank })
    expect(r.dropped).toHaveLength(1)
    expect(r.kept).toHaveLength(0)
  })
  it('空输入安全', () => {
    expect(dedupeItemsAgainst([], refs)).toEqual({ kept: [], dropped: [], upgrades: 0, upgradedRefs: [], refHashes: [] })
    expect(dedupeItemsAgainst(null, refs)).toEqual({ kept: [], dropped: [], upgrades: 0, upgradedRefs: [], refHashes: [] })
  })
})

describe('dedupeItemsAgainst keepUnseen / maxKeep / refHashes', () => {
  const refs = [
    { title: '多地迎来强降雨', summary: 's', source: '央视新闻' },
    { title: 'AI 模型密集发布', summary: 's', source: '机器之心' },
  ]
  it('keepUnseen：优先保留与参照组不重复的条目，凑满配额，多余整批丢弃', () => {
    const items = [
      { title: '多地迎来强降雨', summary: '重复', source: '央视新闻' },
      { title: '某新片上映', summary: '新', source: '新浪娱乐' },
      { title: '某企业完成融资', summary: '新', source: '36氪' },
      { title: 'AI 模型密集发布', summary: '重复', source: '机器之心' },
    ]
    const r = dedupeItemsAgainst(items, refs, { keepUnseen: 2 })
    expect(r.kept.map((k) => k.title)).toEqual(['某新片上映', '某企业完成融资']) // 新条目优先，2 条即满
    expect(r.dropped.map((d) => d.title)).toEqual(['多地迎来强降雨', 'AI 模型密集发布'])
    expect(r.upgrades).toBe(0)
  })
  it('keepUnseen：参照组无重复时按原序取前 N 条；不足 N 则全保留', () => {
    const items = [
      { title: '新闻甲', summary: 's', source: 'a' },
      { title: '新闻乙', summary: 's', source: 'b' },
      { title: '新闻丙', summary: 's', source: 'c' },
    ]
    expect(dedupeItemsAgainst(items, refs, { keepUnseen: 2 }).kept.map((k) => k.title)).toEqual(['新闻甲', '新闻乙'])
    expect(dedupeItemsAgainst(items, refs, { keepUnseen: 5 }).kept).toHaveLength(3)
  })
  it('keepUnseen：与参照重复但来源更权威（升级）的条目计入新条目', () => {
    const sourceRank = (s) => (s === '新华社' ? 3 : s === '央视新闻' ? 2 : 0)
    const items = [
      { title: '多地持续强降雨', summary: '官方口径', source: '新华社' }, // 升级（保留）
      { title: '某新片上映', summary: '新', source: '新浪娱乐' },
      { title: '某企业融资', summary: '新', source: '36氪' },
    ]
    const r = dedupeItemsAgainst(items, refs, { sourceRank, keepUnseen: 2 })
    expect(r.upgrades).toBe(1)
    expect(r.kept.map((k) => k.title)).toEqual(['多地持续强降雨', '某新片上映'])
    expect(r.upgradedRefs.map((x) => x.title)).toEqual(['多地迎来强降雨'])
  })
  it('maxKeep：保留上限截断（按原序），超出进 dropped', () => {
    const items = [
      { title: '新闻甲', summary: 's', source: 'a' },
      { title: '新闻乙', summary: 's', source: 'b' },
      { title: '新闻丙', summary: 's', source: 'c' },
    ]
    const r = dedupeItemsAgainst(items, refs, { maxKeep: 2 })
    expect(r.kept.map((k) => k.title)).toEqual(['新闻甲', '新闻乙'])
    expect(r.dropped.map((d) => d.title)).toEqual(['新闻丙'])
  })
  it('refHashes：参照组 ∪ 本轮保留条目（供多次提交累加参照）', () => {
    const r1 = dedupeItemsAgainst([
      { title: '某新片上映', summary: 's', source: 'a' },
      { title: '某企业融资', summary: 's', source: 'b' },
    ], refs)
    expect(r1.kept).toHaveLength(2)
    // 参照组的 2 条 + 本轮新增 2 条 = 4 个指纹。
    expect(r1.refHashes).toHaveLength(4)
    expect(r1.refHashes).toContain(normalizeTitle('多地迎来强降雨'))
    expect(r1.refHashes).toContain(normalizeTitle('某新片上映'))
    // 第二轮以 refHashes 为参照：已报事件被排除，只保留新条目。
    const r2 = dedupeItemsAgainst([
      { title: '多地持续强降雨', summary: '同事件', source: '央视新闻' },
      { title: '全新事件', summary: '新', source: 'c' },
    ], refs.concat(r1.kept))
    expect(r2.kept.map((k) => k.title)).toEqual(['全新事件'])
    expect(r2.dropped.map((d) => d.title)).toEqual(['多地持续强降雨'])
  })
  it('includeRefs:false 时 refHashes 只含本轮新条目', () => {
    const r = dedupeItemsAgainst([{ title: '某新片上映', summary: 's', source: 'a' }], refs, { includeRefs: false })
    expect(r.refHashes).toHaveLength(1)
    expect(r.refHashes).toContain(normalizeTitle('某新片上映'))
  })
})
