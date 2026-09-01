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
    expect(dedupeItemsAgainst([], refs)).toEqual({ kept: [], dropped: [], upgrades: 0, upgradedRefs: [] })
    expect(dedupeItemsAgainst(null, refs)).toEqual({ kept: [], dropped: [], upgrades: 0, upgradedRefs: [] })
  })
})
