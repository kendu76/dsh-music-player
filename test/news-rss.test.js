/**
 * RSS 信源池纯函数单测（RFC: docs/news-rss-pool-rfc.md §3/§4/§5）。
 * 覆盖：默认池、sanitizeRssPrefs、normalizeFeedUrl、parseRssXml、parseRssDate、
 * mergePoolItems（增量去重）、prunePool、filterPoolForScope、poolSummary。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RSS_FEEDS, RSS_TIERS, RSS_TIER_NAMES, LIMITS,
  normalizeFeedUrl, sanitizeRssPrefs, poolItemHash, parseRssXml, parseRssDate,
  mergePoolItems, prunePool, markPoolUsed, filterPoolForScope, poolSummary,
} from '../lib/news-core.js'

const RSS_2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>测试源</title>
  <item>
    <title>国新办发布会介绍政策要点</title>
    <link>https://example.com/a?utm_source=rss&amp;from=feed</link>
    <pubDate>Wed, 30 May 2026 08:02:00 +0800</pubDate>
    <description><![CDATA[今早国新办举行发布会，<b>介绍</b>相关政策要点。]]></description>
  </item>
  <item>
    <title>多地迎来强降雨</title>
    <link>https://example.com/b</link>
    <pubDate>Wed, 30 May 2026 07:45:00 +0800</pubDate>
    <description>中央气象台发布暴雨预警。</description>
  </item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>新一代模型发布</title>
    <link href="https://example.com/ai"/>
    <updated>2026-05-30T06:00:00+08:00</updated>
    <summary>多家厂商密集发布，推理成本显著下降。</summary>
  </entry>
</feed>`

describe('默认信源池', () => {
  it('内置 10 源 = official 7 + major 3，id 稳定唯一，预设类别全覆盖', () => {
    expect(DEFAULT_RSS_FEEDS).toHaveLength(10)
    const tiers = DEFAULT_RSS_FEEDS.reduce((m, f) => ((m[f.tier] = (m[f.tier] || 0) + 1), m), {})
    expect(tiers.official).toBe(7)
    expect(tiers.major).toBe(3)
    expect(new Set(DEFAULT_RSS_FEEDS.map((f) => f.id)).size).toBe(DEFAULT_RSS_FEEDS.length)
    // 覆盖：国内/国际/财经/体育/娱乐各 1、科技 3、热点 2。
    const byCat = DEFAULT_RSS_FEEDS.reduce((m, f) => ((m[f.category] = (m[f.category] || 0) + 1), m), {})
    for (const c of ['国内', '国际', '财经', '体育', '娱乐']) expect(byCat[c]).toBe(1)
    expect(byCat['科技']).toBe(3)
    expect(byCat['热点']).toBe(2)
  })
  it('分级词表与中文名完整', () => {
    expect(RSS_TIERS).toEqual(['official', 'major', 'secondary', 'kol'])
    expect(RSS_TIER_NAMES.official).toBe('官方源')
    expect(RSS_TIER_NAMES.kol).toBe('KOL')
  })
})

describe('normalizeFeedUrl', () => {
  it('去追踪参数与尾斜杠、http 归 https', () => {
    expect(normalizeFeedUrl('http://example.com/rss/?utm_source=rss&from=feed#x'))
      .toBe('https://example.com/rss')
    expect(normalizeFeedUrl('https://example.com/feed/')).toBe('https://example.com/feed')
  })
  it('保留非追踪参数', () => {
    const u = normalizeFeedUrl('https://example.com/rss?cat=tech&utm_medium=web')
    expect(u).toContain('cat=tech')
    expect(u).not.toContain('utm_')
  })
  it('非法输入原样返回', () => {
    expect(normalizeFeedUrl('')).toBe('')
    expect(normalizeFeedUrl('   ')).toBe('')
    expect(normalizeFeedUrl('not-a-url')).toBe('not-a-url')
  })
})

describe('sanitizeRssPrefs', () => {
  it('首次（无 input）→ 内置默认池、默认开启', () => {
    const r = sanitizeRssPrefs({})
    expect(r.enabled).toBe(true)
    expect(r.feeds).toHaveLength(DEFAULT_RSS_FEEDS.length)
    expect(r.feeds[0].id).toBe('chinanews-china')
  })
  it('拉取节奏（pollMinutes）已退役：输出不再含该字段，入参/旧配置的该字段被丢弃', () => {
    const r = sanitizeRssPrefs({ pollMinutes: 5 })
    expect(r.pollMinutes).toBeUndefined()
    // 旧配置带 pollMinutes → 同样被丢弃（不影响 feeds/开关）。
    const old = sanitizeRssPrefs({}, { enabled: true, pollMinutes: 60 })
    expect(old.pollMinutes).toBeUndefined()
    expect(old.enabled).toBe(true)
  })
  it('非法 feed 丢弃、合法保留、重名 id 去重生成新 id', () => {
    const r = sanitizeRssPrefs({ feeds: [
      { url: 'https://a.com/rss', title: '源A', tier: 'official', category: '国内' },
      { url: 'bad', title: '坏源' },
      { url: 'https://a.com/rss', title: '源A重复', tier: 'kol' }, // 同 url 但 id 不同会被保留？见下方
    ] })
    // 前两个：合法 + 非法丢弃；第三个 url 与第一个相同但 title 不同，sanitize 不去重（池内去重由 mergePoolItems 负责）。
    expect(r.feeds.length).toBe(2)
    expect(r.feeds[0].title).toBe('源A')
    expect(r.feeds[0].tier).toBe('official')
    expect(r.feeds[0].category).toBe('国内')
  })
  it('tier/category 非白名单回落默认', () => {
    const r = sanitizeRssPrefs({ feeds: [{ url: 'https://a.com', title: 'x', tier: 'bogus', category: '不存在' }] })
    expect(r.feeds[0].tier).toBe('major')
    expect(r.feeds[0].category).toBe('热点')
  })
  it('上限 30 个 feed', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ url: `https://a${i}.com/rss`, title: 's' + i }))
    expect(sanitizeRssPrefs({ feeds: many }).feeds).toHaveLength(LIMITS.rssFeeds)
  })
  it('suspendedUntil 透传', () => {
    const r = sanitizeRssPrefs({ feeds: [{ url: 'https://a.com', title: 'x', suspendedUntil: 12345 }] })
    expect(r.feeds[0].suspendedUntil).toBe(12345)
  })
  it('默认池版本升级：未手工改过的旧配置自动替换为新默认池', () => {
    // 旧 v1 配置（含已停更的人民网/新浪源），无 custom 标记 → 自动升级到新默认池。
    const old = sanitizeRssPrefs({}, {
      enabled: true, pollMinutes: 30, defaultVersion: 1,
      feeds: [
        { id: 'people-politics', title: '人民网时政', tier: 'official', category: '国内', url: 'https://www.people.com.cn/rss/politics.xml' },
        { id: 'sina-tech', title: '新浪科技', tier: 'major', category: '科技', url: 'https://rss.sina.com.cn/tech/rollnews.xml' },
      ],
    })
    expect(old.feeds[0].id).toBe('chinanews-china') // 已升级为新默认池
    expect(old.feeds).toHaveLength(DEFAULT_RSS_FEEDS.length)
    expect(old.defaultVersion).toBe(2)
  })
  it('用户手工改过（custom）→ 保留自定义 feeds，不跟随默认升级', () => {
    const custom = sanitizeRssPrefs({}, {
      enabled: true, pollMinutes: 30, defaultVersion: 1, custom: true,
      feeds: [{ id: 'my1', title: '我的源', tier: 'kol', category: '热点', url: 'https://my.com/rss' }],
    })
    expect(custom.feeds).toHaveLength(1)
    expect(custom.feeds[0].id).toBe('my1')
    expect(custom.custom).toBe(true)
  })
  it('面板保存 feeds → 标记 custom', () => {
    const r = sanitizeRssPrefs({ feeds: [{ url: 'https://a.com', title: 'x' }] }, { defaultVersion: 2 })
    expect(r.custom).toBe(true)
  })
})

describe('poolItemHash', () => {
  it('同 url（含追踪参数差异）同 hash；不同 url 不同 hash', () => {
    const a = poolItemHash({ url: 'https://e.com/a?utm_source=x' })
    const b = poolItemHash({ url: 'https://e.com/a' })
    const c = poolItemHash({ url: 'https://e.com/b' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
  it('url 缺失时按 title', () => {
    expect(poolItemHash({ title: '标题' })).toBe(poolItemHash({ title: '标题' }))
    expect(poolItemHash({})).toBe('')
  })
})

describe('parseRssXml', () => {
  it('解析 RSS 2.0 item（CDATA 摘要 + HTML 实体解码）', () => {
    const items = parseRssXml(RSS_2)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('国新办发布会介绍政策要点')
    expect(items[0].link).toBe('https://example.com/a?utm_source=rss&from=feed')
    expect(items[0].pubDate).toContain('Wed, 30 May 2026 08:02:00')
    expect(items[0].description).toBe('今早国新办举行发布会，介绍相关政策要点。')
  })
  it('解析 Atom entry（href 链接 + updated 时间）', () => {
    const items = parseRssXml(ATOM)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('新一代模型发布')
    expect(items[0].link).toBe('https://example.com/ai')
    expect(items[0].pubDate).toBe('2026-05-30T06:00:00+08:00')
  })
  it('非 XML / 空 → 空数组', () => {
    expect(parseRssXml('')).toEqual([])
    expect(parseRssXml('<html><body>oops</body></html>')).toEqual([])
  })
})

describe('parseRssDate', () => {
  it('RFC 822 带时区', () => {
    const t = parseRssDate('Wed, 30 May 2026 08:02:00 +0800')
    expect(t).toBe(new Date('2026-05-30T08:02:00+08:00').getTime())
  })
  it('RFC 822 无时区 → 本地时间', () => {
    const t = parseRssDate('Wed, 30 May 2026 08:02:00')
    const d = new Date(2026, 4, 30, 8, 2, 0)
    expect(t).toBe(d.getTime())
  })
  it('ISO 8601', () => {
    expect(parseRssDate('2026-05-30T08:02:00Z')).toBe(Date.parse('2026-05-30T08:02:00Z'))
  })
  it('非法 → null', () => {
    expect(parseRssDate('')).toBeNull()
    expect(parseRssDate('garbage')).toBeNull()
  })
})

describe('mergePoolItems', () => {
  it('增量入库：去池内重复 + 已用 hash + 本批重复', () => {
    const pool = []
    const usedHashes = new Set([poolItemHash({ url: 'https://e.com/used' })])
    const seen = new Set()
    const parsed = [
      { feedId: 'a', title: 'T1', link: 'https://e.com/1', publishedAt: 1, summary: 's1' },
      { feedId: 'a', title: 'T1dup', link: 'https://e.com/1?utm_source=rss', publishedAt: 2, summary: 'dup' }, // 同 hash → 批内去重
      { feedId: 'b', title: 'T2', link: 'https://e.com/2', publishedAt: 3, summary: 's2' },
      { feedId: 'c', title: 'Tused', link: 'https://e.com/used', publishedAt: 4, summary: 's3' }, // 已用 → 跳过
      { feedId: '', title: '', link: 'https://e.com/x' }, // 无标题 → 跳过
    ]
    const added = mergePoolItems(pool, parsed, { now: 100, usedHashes, seen })
    expect(added).toBe(2)
    expect(pool.map((p) => p.title)).toEqual(['T1', 'T2'])
    expect(pool[0].hash).toBe(poolItemHash({ url: 'https://e.com/1' }))
    // 再跑一轮：已入库的 T1/T2 不再重复加
    const added2 = mergePoolItems(pool, parsed, { now: 200, usedHashes, seen: new Set() })
    expect(added2).toBe(0)
  })
})

describe('prunePool', () => {
  it('摘除已用条目、超龄条目（publishedAt 直接淘汰，无宽限）、超量保最新', () => {
    const pool = [
      { hash: 'a', firstSeen: 150, usedIn: ['news-1'] }, // 已用 → 摘除
      { hash: 'b', firstSeen: 10, publishedAt: 1 }, // publishedAt 超龄（距 now 199 > maxAge 100）→ 摘除
      { hash: 'c', firstSeen: 150 }, // 保留
      { hash: 'd', firstSeen: 199 }, // 保留
    ]
    const r1 = prunePool(pool, { now: 200, maxAgeMs: 100, maxItems: 2 })
    expect(r1.removed).toBe(2)
    expect(pool.map((p) => p.hash)).toEqual(['c', 'd'])
    // 刚入库的旧条目（publishedAt 超龄）同样被裁——池定位当日新闻，停更源旧闻无价值。
    const pool2 = [{ hash: 'e', firstSeen: 190, publishedAt: 1 }]
    const r2 = prunePool(pool2, { now: 200, maxAgeMs: 100, maxItems: 1 })
    expect(r2.removed).toBe(1)
    expect(pool2).toHaveLength(0)
    // 超量裁最旧 → 保留 d（此时池只剩 c、d，裁掉 c）。
    const r3 = prunePool(pool, { now: 200, maxAgeMs: 100, maxItems: 1 })
    expect(r3.removed).toBe(1)
    expect(pool.map((p) => p.hash)).toEqual(['d'])
  })
})

describe('markPoolUsed', () => {
  it('把条目标记为已用（usedIn 去重）', () => {
    const pool = [{ hash: 'h1', usedIn: [] }, { hash: 'h2' }]
    const n = markPoolUsed(pool, ['h1', 'h2', 'h1'], 'news-1')
    expect(n).toBe(2)
    expect(pool[0].usedIn).toEqual(['news-1'])
    expect(pool[1].usedIn).toEqual(['news-1'])
    // 再次标记同一期次不重复
    expect(markPoolUsed(pool, ['h1'], 'news-1')).toBe(0)
  })
})

describe('filterPoolForScope', () => {
  const pool = [
    { title: '国内大事', feedTitle: '新华社', feedCategory: '国内', publishedAt: 300 },
    { title: 'AI 模型发布', feedTitle: 'IT之家', feedCategory: '科技', publishedAt: 200 },
    { title: '某 AI 大会', feedTitle: '36氪', feedCategory: '科技', publishedAt: 100 },
    { title: '娱乐八卦', feedTitle: '新浪娱乐', feedCategory: '娱乐', publishedAt: 50 },
  ]
  it('按类别命中 + 按主题命中 + 倒序', () => {
    const r = filterPoolForScope(pool, { categories: ['科技'], topics: [] })
    expect(r.map((p) => p.title)).toEqual(['AI 模型发布', '某 AI 大会'])
  })
  it('主题命中 feed 标题或条目标题', () => {
    const r = filterPoolForScope(pool, { categories: [], topics: ['AI'] })
    expect(r.map((p) => p.title)).toEqual(['AI 模型发布', '某 AI 大会'])
  })
  it('limit 截断', () => {
    const r = filterPoolForScope(pool, { categories: ['国内', '科技', '娱乐'] }, { limit: 2 })
    expect(r).toHaveLength(2)
  })
  it('official 级源无条件命中（RFC §5.2 规则 3）：标题/类别不带主题关键词也命中', () => {
    const items = [
      { title: '宏观政策落地', feedTitle: '新华社', feedCategory: '国内', feedTier: 'official', publishedAt: 300 },
      { title: 'AI 模型发布', feedTitle: 'IT之家', feedCategory: '科技', feedTier: 'major', publishedAt: 200 },
      { title: '某 AI 大会', feedTitle: '36氪', feedCategory: '科技', feedTier: 'kol', publishedAt: 100 },
      { title: '无关娱乐', feedTitle: '新浪娱乐', feedCategory: '娱乐', feedTier: 'major', publishedAt: 50 },
    ]
    const r = filterPoolForScope(items, { categories: [], topics: ['AI'] })
    // official 源条目标题无关键词也注入；major/kol 仍按关键词命中；major 且不相关的不命中
    expect(r.map((p) => p.title)).toEqual(['宏观政策落地', 'AI 模型发布', '某 AI 大会'])
  })
  it('official 无条件命中但已报过（usedIn 非空）仍排除', () => {
    const items = [
      { title: '宏观政策落地', feedTitle: '新华社', feedCategory: '国内', feedTier: 'official', usedIn: ['news-1'], publishedAt: 300 },
      { title: 'AI 模型发布', feedTitle: 'IT之家', feedCategory: '科技', feedTier: 'major', publishedAt: 200 },
    ]
    const r = filterPoolForScope(items, { categories: [], topics: ['AI'] })
    expect(r.map((p) => p.title)).toEqual(['AI 模型发布'])
  })
})

describe('poolSummary', () => {
  const pool = { enabled: true, fetchedAt: 1000, items: [
    { title: 'A', feedTitle: '新华社', feedCategory: '国内', publishedAt: 2000, summary: 's' },
    { title: 'B', feedTitle: 'IT之家', feedCategory: '科技', publishedAt: 1500, summary: 'x' },
  ] }
  const feeds = [
    { title: '新华社', enabled: true },
    { title: 'IT之家', enabled: true, suspendedUntil: 9999 }, // 已暂停
  ]
  it('生成注入文本（含时间、源、标题、摘要截断、暂停源提示）', () => {
    const r = poolSummary(pool, feeds, { now: 3000 })
    expect(r.ok).toBe(true)
    expect(r.total).toBe(2)
    expect(r.text).toContain('信源池材料')
    expect(r.text).toContain('《A》')
    expect(r.text).toContain('[新华社/国内]')
    expect(r.text).toContain('已暂停源：IT之家')
    expect(r.suspended).toEqual(['IT之家'])
  })
  it('池未启用 → 降级提示', () => {
    const r = poolSummary({ ...pool, enabled: false }, feeds, { now: 3000 })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('web_search 补盲')
  })
})
