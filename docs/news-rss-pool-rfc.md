# RFC · 新闻播报信源池（RSS）与工具层去重

> 状态：**已实现**（M-R1 ~ M-R4 全部落地，627 个测试通过；实现落点见 §12）
> 关联：`docs/daily-news-briefing-design.md` §8.5 预留的 M4 演进（已升级为 M5）
> 目标：把「每次收集都从全网重搜」升级为「Host 侧维护 RSS 信源池 → 收集时先从池中筛选、
> web_search 补盲」；同时把「LLM 自觉去重」升级为「工具层确定性去重」。
> 范围：P0（信源池 + 信源分级）、P1（工具层去重 + 两阶段配额化）。
> 明确不做（本文档范围内）：pgvector 语义去重、新闻 API（GNews/SerpAPI）、自写爬虫、KOL 源进默认池。

---

## 1. 动机与目标

### 1.1 现状的四个软肋（对照参考方案）

| # | 软肋 | 现状 | 后果 |
|---|---|---|---|
| 1 | 无订阅概念 | 每次触发 = 全新 `web_search`（提示词 §8.2 的方法论），无信源池 | 索引覆盖不全（设计文档 §8.3「诚实边界」已自认）；token 成本按班次数线性放大；无法做增量 |
| 2 | 时效锚不可靠 | 只认 `web_search` 返回的 `publishedAt`，缺失即弃 | 核心源带 pubDate 却不利用；「无 publishedAt 即弃」造成漏报 |
| 3 | 去重靠 LLM 自觉 | 提示词「同一事件跨源去重只留最权威」；工具层只有冷却窗（防同班次重复提交），无内容级去重 | 同一事件不同措辞可在不同轮次/不同班次重复进期；跨班次去重被设计文档 §7.4 自己承认「不成立」 |
| 4 | 深抓无纪律 | 「挑重要的抓」是 agent 临场判断，每类抓几条无硬约束 | 两阶段策略（快筛 → 深析）有雏形但没固化，成本不受控 |

### 1.2 目标

1. **RSS 信源池**（P0）：Host 端按固定节奏拉取 5~10 个核心源的 RSS，形成「原始条目池」，
   收集时 agent 先从池中筛选整理，`web_search` 降为补盲通道。
2. **信源分级**（P0）：把提示词里的「优先源清单」升级为持久化的四级信源池
   （官方源 / 权威媒体 / 优质二手 / KOL），去重取权威、面板权威徽标都读这份数据。
3. **工具层确定性去重**（P1）：`news_broadcast` 提交时对条目标题做归一化 + 相似度比对，
   与**本期次内**及**当日已有期次**的条目去重，命中即丢弃并写进 notice。
4. **两阶段分析配额化**（P1）：提示词显式固定「先摘要快筛 → 再按配额深抓」，
   `web_fetch` 深抓条目数按类别配额硬约束。

### 1.3 非目标

- pgvector / 向量语义去重：单日 ≤20 条、跨期 ≤7×N 期的规模，标题归一化 + 相似度足够。
- 新闻 API（GNews/SerpAPI）与自写爬虫：已有 `web_search` 聚合通道，第三方 API 引入密钥与
  配额管理；真要补信源，RSS 优于爬虫（无反爬、pubDate 可靠、无登录墙）。爬虫排在 RSS 之后，
  不随本 RFC 落地。
- KOL 源进默认信源池：本产品是「权威可信播报」定位（必标来源、不做猜测推断），
  默认池只到「权威媒体」级；KOL 至多作为自定义主题的兜底（见 §5.4）。
- Host 端自动整理（方案 B 全自动）：本 RFC 只做「喂料」，整理仍是 agent 在环。

---

## 2. 总体架构（信源池在现有管线的位置）

```
                         ┌─────────────────────────────── Host 进程 ───────────────────────────────┐
                         │                                                                          │
   RSS 源列表（持久化） ──► RSS 拉取器（Node fetch，无浏览器）                                        │
   ~/.dsh/music-player-news.json                                                            │
   { rss: { feeds[],  … } }  │      │  原始条目池（内存 + 磁盘快照）                                     │
                         │      │  pool: { items: [{feedId, title, url, publishedAt,            │
                         │      │           summary, hash}], fetchedAt }                        │
                         │      ▼                                                                  │
                         │  poolSummary() ──► 池状态摘要（新条目计数 + 每源最新时间）                  │
                         │      │                                                                  │
                         │      ▼                                                                  │
                         │  注入收集指令：                                                          │
                         │  「以下条目来自信源池（已按发布时间排序），从池中筛选相关条目；               │
                         │   池中不足时再用 web_search 补盲，补盲查询词一律带日期锚定」                  │
                         │      │                                                                  │
                         │      ▼                                                                  │
                         │  agent（执行会话）： web_search 补盲 + web_fetch 深抓（配额内）            │
                         │      │  ──► news_broadcast ──► 工具层确定性去重（P1）→ 期次                │
                         └──────────────────────────────────────────────────────────────────────────┘
```

设计要点：

- **懒拉取（收集前同步拉）**：无后台定时器——每次新闻收集执行（`runCollection`）前先同步
  `pullPoolOnce()` 拉一轮最新条目，再组装收集指令；agent 筛的就是刚拉到的新鲜数据，快且省。
- **agent 仍是唯一整理者**：池只是「喂料」；去重/筛选/摘要/分类/口播全部保持 agent 在环
  （方案 A 的既定架构不动）。
- **两路并行的切换策略**：池是主路（确定、低成本、有 pubDate），`web_search` 是补盲
  （池外突发、自定义主题、池拉取失败的降级）。详细切换规则见 §6。
- **增量友好**：池记录每源最近一次拉取到的条目，只保留增量；收集指令给出「池内新条目」，
  天然支持「与早班重复的仅保留重大进展」的跨班次去重前提。

---

## 3. 数据模型

### 3.1 信源池配置（持久化，并入 `~/.dsh/music-player-news.json` 顶层）

```jsonc
{
  // 现有字段：editions / schedulePrefs / runState / failures（不变）
  "version": 2, // 1 → 2：新增 rss 段
  "rss": {
    "enabled": true,                       // 总开关；关闭 = 完全不拉取，退回纯 web_search
    "feeds": [
      {
        "id": "xinhuashe",                 // 稳定 id（slug），不可变；默认池内置
        "url": "https://rss.news.cn/…/rss.xml",
        "tier": "official",                // 信源分级：official|major|secondary|kol
        "category": "国内",                 // 该源主投类别（提示词用它做类别对齐）
        "enabled": true,
        "title": "新华社"
      }
    ]
  },
  "pool": {
    "fetchedAt": 1750000000000,            // 最近一次成功拉取时间
    "lastOk": { "xinhuashe": 1750000000000 }, // 每源最近成功时间（供失败判定/增量）
    "items": [                             // 原始条目池（含增量，见 §3.3 保留策略）
      {
        "feedId": "xinhuashe",
        "title": "…",
        "url": "https://…",
        "publishedAt": "2026-05-30T08:02:00+08:00", // RSS pubDate（可靠时间锚）
        "summary": "…",                    // RSS 自带摘要/描述，可为空
        "hash": "sha1…",                   // 内容指纹（去重/增量用，见 §7）
        "firstSeen": 1750000000000,        // 首次进入池的时间（池生命周期/清理用）
        "usedIn": []                       // 已进入哪些期次 id（面板溯源/跨期去重用）
      }
    ]
  }
}
```

### 3.2 默认信源池（内置 10 源，已实测今日新鲜）

> 全部 URL 于 2026-09 实机验证：插件 `parseRssXml` 解析通过、**最新条目 pubDate 距今 < 2 天**。
> 曾臆造的 rss.news.cn / rss.cctv.com / rss.cankaoxiaoxi.com / rss.caixin.com 等域名不存在或
> 已改版；人民网 5 频道（2025-06 停更）、新浪科技/体育（2018 停更）、新浪娱乐/中新网娱乐
> （空壳 0 条）均已弃用——**仅「能解析 + 有时间锚」不够，必须检查时间锚新鲜度**。

| feedId | 源 | tier | category | 说明 |
|---|---|---|---|---|
| chinanews-china | 中新网时政 | official | 国内 | 官方通讯社，30 条/日 |
| chinanews-world | 中新网国际 | official | 国际 | 官方通讯社，30 条/日 |
| chinanews-finance | 中新网财经 | official | 财经 | 官方通讯社，30 条/日 |
| chinanews-sports | 中新网体育 | official | 体育 | 官方通讯社，30 条/日 |
| chinanews-culture | 中新网文化 | official | 娱乐 | 含文娱，30 条/日 |
| chinanews-scroll | 中新网即时 | official | 热点 | 滚动新闻，30 条/日 |
| chinanews-import | 中新网要闻 | official | 热点 | 要闻导读，30 条/日 |
| ithome | IT之家 | major | 科技 | 科技垂直，60 条/日 |
| qbitai | 量子位 | major | 科技 | AI 垂直，10 条/日 |
| sspai | 少数派 | major | 科技 | 数字生活，10 条/日 |

- **分级语义**：
  - `official` 一手官方源：政府/机构/官方媒体原发（中新网）。
  - `major` 权威媒体：有编辑把关的主流/垂直媒体（IT之家、量子位、少数派）。
  - `secondary` 优质二手源：聚合/解读类（后续可选，默认池不配）。
  - `kol` 个人/KOL：不进默认池，仅自定义主题兜底（§5.4）。
- **配置入口**：面板「信源池配置」子视图（默认池开关 + 增删自定义 feed + 恢复暂停源）。
  自定义 feed 表单：URL + 分级 + 主投类别 + 名称。范围：`rss.feeds` 上限 30 个
  （默认 10 + 自定义 20）。**无拉取节奏配置**——池数据在每次收集执行前懒拉取。
- **面板展示**：新闻页签新增一行「信源池」状态（源数 / 池内条目 / 最近拉取时间 / 失败数），
  失败源可单独停用。详见 §9。

### 3.3 池条目保留与清理

- **只保留增量**：`pool.items` 只存「进入池后尚未进入任何期次」的条目（`usedIn` 为空）。
  进入期次后置 `usedIn`，由下一次拉取后的清理摘除——池子不膨胀，且「未用过」的
  条目在下一班次仍可用（如高频静默班次与低频播报班次共享池）。
- **生命周期上限**：`pool.items` ≤ 500 条（老条目在拉取成功后按 `firstSeen` 淘汰，
  防单次故障期间堆积）。
- **过期口径**：条目按 `publishedAt` 超过 48 小时即从池中清理（新闻时效性；超出后即使
  未用也不再进入播报，宁缺毋假）。
- **与每日 03:00 清理的关系**：`pool.items` 与 `editions` 不同——池是「原材料」，
  今日没播完的条目次日作废（48h 上限），由池自身清理负责，不进 `purgeStaleNews` 的
  期次清理（期次清理逻辑不动）。

---

## 4. Host 懒拉取（RSS 拉取器）

### 4.1 调度（懒加载，无后台定时器）

**不做轮询定时器**——池数据只在「要用了」的时刻去获取：每次新闻收集执行（`runCollection`）
组装指令前，先同步 `pullPoolOnce()` 拉一轮（池启用且无并发拉取时），随后注入
【信源池材料】。这与节假日日历的懒拉取同一原则：**没跑新闻收集就不产生任何 RSS 请求**，
无需手动刷新、无「拉取节奏」配置。

```
触发点：
  1) 每次 runCollection（定时到点 / 面板「▶ 立即执行」）收集前
实现：直接 await pullPoolOnce()（内部 poolPulling 防重入；失败静默降级 → 不注入池材料）
清理：无定时器，无 dispose 需求
```

### 4.2 一轮拉取流程

```
pullPoolOnce():
  1. loadNews() 读 rss 配置；enabled=false 或无可用 feed → 直接返回
  2. 对每个 enabled feed 并行 fetch（Node 内置 fetch，超时 15s/feed，总并发 ≤4）
     ├─ HTTP 非 200 / 超时 / 网络错误 → 记 feedFailure（§4.4），本轮跳过该源
     ├─ 200 → 解析 XML → items[]（title/link/pubDate/description）
     │    ├─ 非 XML（HTML 误报/反爬页）→ 记失败并停用该源（自动禁 24h，见 §4.4）
     │    └─ 正常 → 增量入库（§4.3）
  3. 有任一源成功 → 更新 pool.fetchedAt；saveNews()
  4. 池状态摘要写入内存（供下次收集指令注入，§5.2）
```

- **不进 agent 会话**：拉取是纯 Host 侧 Node 代码（`fetch` + XML 解析），不占 agent token、
  不依赖会话存活（与现有「收集在主机进程后台完成」原则一致）。
- **XML 解析**：不引第三方依赖（保持插件零依赖风格）——写一个 ~50 行的轻量
  `<item>`/`<entry>` 提取器（兼容 RSS 2.0 `<item>` 与 Atom `<entry>`），只取
  title/link/pubDate/description，HTML 实体解码 + 标签剥除。详见 §10 实现要点。
- **池状态不落盘粒度**：`pool.items` 落盘（重启后可续用），但「每源最近一次拉取到的
  条目标题」这类增量水位只在内存维护即可——重启后以「已进入期次的 usedIn + publishedAt
  去重」自然收敛，不需要持久化水位。

### 4.3 增量入库与去重（池内）

```
for each parsed item:
  key = url 规范化（去 query 中 utm_*/from= 等）或（title 归一化 + pubDate）
  hash = sha1(key)
  if 池内已存在同 hash → skip（更新 firstSeen 不动）
  if 同 url 已进入过某期次（usedIn 非空，由 editions 反查）→ skip（不再重入池）
  else push { feedId, title, url, publishedAt, summary, hash, firstSeen: now, usedIn: [] }
```

- 池内去重与 §7 的工具层去重是**两套**：池内按 url/hash 精确去重（防同一 feed 重复拉取），
  工具层按标题相似度去重（防跨源重复进期次）。分工不同，不重复实现。

### 4.4 拉取失败处理

| 现象 | 处理 |
|---|---|
| 单源 HTTP 错误/超时 | 记 `feedFailure`（feedId + 错误码 + 消息，最近 5 条），本轮跳过该源；下轮自动重试 |
| 连续 3 次失败 | 该源**自动停用 24h**（`feeds[i].suspendedUntil`），面板展示「已暂停」；到期自动恢复 |
| 返回非 XML | 视为异常，同连续失败处理（防被反爬页/登录页毒化） |
| 全部源失败（网络层） | 记一条失败摘要（`pool.lastError`），不 panic；收集时 agent 走纯 web_search 降级（§6） |
| 拉取失败对收集的影响 | **不影响**：收集触发与拉取解耦，池里旧条目仍可用，或直接走 web_search |

- **失败不联网上报**：与现有失败哲学一致（§7.3「不做诊断、只透传现象」），`feedFailure`
  记录错误码 + 消息原文，面板展示 + 通用排查指引（检查网络/源 URL 有效性）。
- 本机 fake-ip 代理环境（WEB_BLOCKED_URL 实测踩坑）：`web_fetch` 工具受 DSH 防 SSRF 保护会
  对 fake-ip 解析域名报错，但 **Host 侧 Node fetch 不走那个保护**——它直连（经系统代理）。
  因此 RSS 拉取器天然免疫该问题，这是相对 `web_fetch` 的又一个优势（README FAQ 可注明）。

---

## 5. 与 agent 的接口：收集指令注入

### 5.1 注入时机

`runCollection`（lib/index.js §L1916）在组装收集指令文本时，若 `poolSummary()` 有可用的
池条目，把池摘要作为**事实材料**注入（放在现有 `nowText` 之后、`scopeText` 之前），
其余流程（执行会话、runState、冷却窗、提交）完全不变。

### 5.2 注入内容（指令模板，中文）

```
【信源池材料】以下条目来自本地 RSS 信源池（按发布时间倒序，共 N 条，池更新于 HH:MM）：
— 08:02 [新华社/国内]《标题》：摘要（前 80 字）…
— 07:45 [IT之家/科技]《标题》：摘要（前 80 字）…
…（最多注入 60 条，按 publishedAt 倒序；超过 60 条只给最新的 60 条）

请先检查信源池材料：池中与本期范围（类别/主题）匹配的条目优先采用（直接采信
pubDate，无需再核时效）；池中不足或缺少的类别/突发主题，再用 web_search 补盲——
补盲查询词一律带当天日期锚定（与现有规则一致）。
```

- **注入上限 60 条**：池条目摘要 ≤80 字截断，60 条约 5~6k 字符，控制在执行会话的
  followup 消息体合理长度内。
- **只注入与班次范围相关的池条目**：`runCollection` 已知道 `shift.scope`（类别 + 主题），
  注入前按「源的主投类别 ∈ scope.categories 或 源的分级为 official 或 feed 标题命中主题」
  过滤，避免把与本期无关的池材料塞给 agent（省 token、防干扰）。
- **对话直接播报**（shiftId 为空，手动）：注入全部池条目（同样 ≤60 条），由 agent
  自行归类。

### 5.3 agent 侧规则（提示词 §8 新增小节）

```
7) 信源池：收集指令里会出现【信源池材料】。规则：
   - 池内条目自带可靠 pubDate，时效直接采信，不再需要「publishedAt 缺失即弃」判断；
   - 同一事件池内与 web_search 结果重复时，取分级更高者（official > major > secondary > kol），
     同级取池内条目（有 pubDate 且已去重）；
   - 池内条目摘要不足 200 字时，用 web_fetch 抓原文补细节（受 §9 深抓配额约束）；
   - 池内没有的类别/主题条目，一律 web_search 补盲。
```

### 5.4 自定义主题与 KOL 兜底

- 自定义主题（班次 `scope.topics`）默认不在池内（池的默认源是预设类别向）。
- 若用户给某个主题配置了专属 feed（面板信源池增删时选择「归属主题」），则该 feed 的条目
  在该主题班次时正常注入——KOL 源只有在用户**显式添加**该 KOL 的 RSS 时才进池（不进默认池），
  这是「KOL 兜底」的唯一入口。
- 主题匹配在注入端做（§5.2 的过滤规则），agent 不需要自己判断。

---

## 6. 与 web_search 的切换策略（补盲决策）

### 6.1 决策规则（按优先级）

| 场景 | 数据来源 | 说明 |
|---|---|---|
| 池内有匹配条目 | **池为主** | 直接采信 pubDate；摘要不足再 web_fetch |
| 池内该类别条目不足 | 池 + web_search 补盲 | 补盲只补缺口（如池内科技只有 2 条、配额 3 → 搜 1 条） |
| 自定义主题 | web_search 为主 | 主题默认不在池；除非用户配了专属 feed |
| 热点（跨领域热度榜） | **web_search 为主** | 热榜本质是「当下全网热度」，池的定时快照追不上实时榜；池只作素材底料 |
| 池拉取故障 / 池被禁用 | web_search 全量 | 完全退回现有流程，能力不降级 |
| 突发重大事件（agent 判断池里没有） | web_search 补盲 | 池是定时快照，天然滞后；突发靠搜索兜 |

### 6.2 原则

- **池永不成为瓶颈**：池不可用（禁用/全失败/条目过期）时，收集流程**原样**退化为今天的
  纯 `web_search` 流程——提示词把池当「可选加强」，不是「必需前置」。
- **同一事件的权威裁决**：池内（official/major）与搜索命中同一事件 → 取分级更高者；
  同级 → 取池内（pubDate 可靠 + 已去重）。此规则放提示词，agent 在环裁决。
- **增量/跨班次**：池内「已用条目」不再注入（`usedIn` 非空即摘除），天然减少跨班次重复；
  突发同一事件在池中重复出现（不同 feed）由 §7 工具层兜底。

---

## 7. P1 · 工具层确定性去重

### 7.1 位置与原则

- 位置：`news_broadcast.execute`（lib/index.js §L4818）在 `sanitizeEditionInput` 之后、
  冷却窗之前；新建纯函数放 `lib/news-core.js`（可单测，沿用现有纯逻辑风格）。
- 原则：**去重是硬性约束**（与冷却窗同级，非提示词建议）；命中即丢弃条目并写 notice
  （丢弃条数、示例标题），全部命中则拒绝生成（与现有「全部越界拒绝」同语义）。

### 7.2 归一化（title → 指纹）

```
normalizeTitle(title):
  1. 小写化
  2. 去全角/半角标点（[，。！？、；：""''（）【】《》…] → 空格）
  3. 去「独家 / 重磅 / 快讯 / 刚刚 / 突发 / 官宣 / 首发」等前缀词（可配置词表）
  4. 去数字日期片段（2026年5月30日 / 05-30 / 5月30日）
  5. 连续空白折叠、trim
```

### 7.3 相似度判定

- 对每条提交条目的 `normalizeTitle`，与以下两组比对：
  - **组 A · 本期次内**：已通过去重的本批次条目（防同一提交里措辞不同的重复）；
  - **组 B · 当日已有期次**：`news.editions` 中 `date === 本期 date` 的条目
    （跨班次/跨手动触发的当日去重——补上设计文档 §7.4 承认的缺口）。
- 判定（无需向量库，规则可测）：
  - 相等 → 重复；
  - 较长者包含较短者且长度比 ≥ 0.6 → 重复；
  - 编辑距离 ≤ max(2, 0.15 × 较短者长度) → 重复（实现用简单 DP 或 bigram Jaccard ≥ 0.7 代替，
    二选一，倾向 bigram Jaccard：更省、中文友好）。
- **来源白名单例外**：同一事件若提交条目的 `source` 是 official 而旧条目是 major/secondary，
  保留 official 替换旧条目（在 `news_broadcast` 内对该条目做「升级替换」：从旧期次中移除
  旧条目，新条目照常进本期间次——旧期次音频已生成不可变，故只做「数据层移除 + notice 说明」，
  不做音频重生成）。

### 7.4 输出

- `notice` 追加：「工具层去重剔除 X 条与本期/当日已报重复的条目（如《…》）」。
- 去重后条目数不足（如类别被去重掏空）→ 按现有「无有效条目拒绝生成」路径处理。
- **跨日去重不做**：只比当日（与期次「只保留当天」口径一致），昨日条目已过期清理。

### 7.5 当日多期收集的去重补足（短收问题修复）

同类任务（同一班次）当天多次执行时，若「当日已报」条目被硬性剔除，后跑的任务会收不满
配置的新闻条数（如目标 8 条、实际只报 4 条）。**去重不放松**，而是「按需冗余 + 信息注入 +
收敛后置」三管齐下：

1. **按需候选冗余**：仅当**当天该班次已执行过**（去重会真的剔除条目）时，班次指令才要求
   每类按目标条数 1.5~2 倍提交候选（`news_broadcast` 提交上限相应放宽到 2× 班次条数）；
   当天首次执行无去重风险，提交上限保持 = 班次条数，**不做无谓冗余、不浪费 token**；
2. **已报清单注入**：`runCollection` 在收集指令里附【已报条目】清单（当日已有期次的
   标题列表），执行会话的 agent 知道今天已报过哪些，优先收集**未报过**的新条目；
3. **收敛后置**：`capCategoriesToQuota` 从「去重前」移到「去重后」执行——候选先经
   工具层去重（剔除与今日已报重复的），剩下的都是新条目，再按班次条数/类别配额收敛
   到目标条数。去重剔除的是「重复候选」，不影响最终条数凑满。

配套：池条目入库时用 `markPoolUsed` 记录 `usedIn`，`filterPoolForScope` 排除已报
条目（不再注入），`prunePool` 也按 `usedIn` 摘除——从源头减少当日多次执行的重复候选。

---

## 8. P1 · 两阶段分析配额化

### 8.1 提示词固化（§8.2 的 4 步流水线改为显式两阶段）

```
阶段一 · 快筛（全部条目）：
  先用 web_search 摘要（和池内 summary）判断「与本期范围相关 + 值得报」，
  不动 web_fetch —— 快筛阶段只产生「候选清单」，不抓全文。

阶段二 · 深抓（仅候选，配额内）：
  只对候选清单中「信息量不足 / 最可能缺细节」的条目 web_fetch 原文，
  配额：每类 ≤ 2 条、全期 ≤ 6 条（默认；可随班次 itemCount 线性放宽，
  如 itemCount=20 时每类 ≤ 3 条、全期 ≤ 8 条）。
  抓取失败（含 WEB_BLOCKED_URL）按现有规则：确认性重试 1 次即放弃，
  该条以摘要为准，本会话后续不再尝试 web_fetch。
```

### 8.2 收益

- 成本可控：深抓从「临场随缘」变成「配额内定点」，token 上界可预期；
- 与信源池叠加后，池内条目带 summary 通常**无需深抓**（摘要足够口播），
  深抓主要留给 web_search 补盲命中的条目——配额按「每类 ≤2 条」进一步自然收敛。

### 8.3 与现有失败哲学的衔接

- web_fetch 失败**不影响期次生成**（现有规则不变）；配额只是「计划内深抓」的纪律，
  失败不补抓、不重试超配额。

---

## 9. 面板与 API（新增/变更）

### 9.1 新增 API

**无信源池相关 API。** RSS 信源池**没有任何 UI 与配置接口**（无状态行、无配置子视图、
无 `GET/POST /news/rss`、无 `/rss/resume`）——由 Host 在后台自动懒拉取使用，默认内置
10 源、默认开启，无需用户配置。池配置仅从持久化文件读取（旧版本用户改过的配置仍加载，
新装直接使用默认池）。

- 校验：`sanitizeRssPrefs` 纯函数入 `news-core.js`（feed id 生成/去重、URL 合法性、
  tier/category 白名单、feeds ≤30），与 `sanitizeSchedulePrefs` 同风格。`pollMinutes` 已退役
  （懒拉取，无后台定时器），旧配置该字段被丢弃。
- 持久化：并入 `music-player-news.json` 的 `rss` + `pool` 段（version 2），
  `saveNews` 一并写（`pool.items` 每次拉取后 saveNews——与期次同文件，避免新增文件）。
- 池材料注入：`runCollection` 收集前懒拉取后，按班次范围 `filterPoolForScope` 预筛并注入
  【信源池材料】；对话直接播报经 `news_schedule {action:'pool'}` 获取同一材料。

### 9.2 面板变更（新闻页签）

**无信源池呈现**——新闻页签只保留「定时状态行 + 期次列表」，不新增任何池状态行/配置入口。
RSS 信源池对用户完全透明：Host 每次收集前在后台自动拉取使用。

---

## 10. 实现要点与里程碑

### 10.1 新增/修改文件

| 文件 | 变更 |
|---|---|
| `lib/news-core.js` | 新增：`normalizeTitle`、`bigramJaccard`、`dedupeItemsAgainst`（工具层去重纯函数）、`sanitizeRssPrefs`、`parseRssXml`（轻量 XML 提取）、`poolSummary`、`prunePool`（48h/500 条/usedIn 清理）、`filterPoolForScope`（注入过滤） |
| `lib/index.js` | 新增：`pullPoolOnce`（懒拉取器，由 `runCollection` 收集前调用）、`rss` 路由 3 条、`news_broadcast.execute` 里插入去重调用、`runCollection` 注入池摘要、`saveNews`/`loadNews` 读写 `rss`/`pool` 段 |
| 提示词 | §8 新增「信源池」小节（§5.3）+ 两阶段流水线改写（§8.1） |
| `docs/daily-news-briefing-design.md` | 标记 §8.5 演进落地；补充本 RFC 链接 |
| `docs/daily-news-briefing-ui.md` | §9.2 面板变更 |
| `test/news-core.test.js` / 新增 `test/news-rss.test.js` | 去重/池清理/解析/配置校验单测 |
| `README.md` FAQ | RSS 池说明 + fake-ip 环境免影响说明 |

### 10.2 里程碑

- **M-R1 Host 池骨架**：`parseRssXml` / `sanitizeRssPrefs` / `prunePool` / `poolSummary` 纯函数 +
  单测；`pullPoolOnce` + rss 路由（配置读写）。
- **M-R2 收集接入**：`runCollection` 收集前懒拉取池摘要 + 提示词 §5.3/§8.1 更新；手动播报/
  定时班次双路径联调。
- **M-R3 工具层去重**：`normalizeTitle` / `bigramJaccard` / `dedupeItemsAgainst` + 单测；
  `news_broadcast` 接入 + notice 输出；官方源升级替换。
- **M-R4 面板**：**无信源池 UI**（状态行/配置子视图/API 均不提供）——池对用户完全透明，Host 后台自动使用。

### 10.3 风险与回退

| 风险 | 缓解 |
|---|---|
| 默认源 URL 失效/反爬 | 内置源逐一验证；单源失败自动停用 24h 不阻塞；用户可增删 feed |
| XML 解析器过简（非标准 feed） | 只兼容 RSS 2.0 `<item>` + Atom `<entry>`（99% 覆盖）；解析失败按单源失败处理 |
| 池条目污染（摘要含广告/无关内容） | 摘要截断 80 字 + 过滤「广告/推广」关键词；最终取舍仍由 agent 把关 |
| 注入过长撑爆消息体 | 注入上限 60 条 + 摘要 80 字截断 + 按 scope 预过滤 |
| 池拉取加重 Host 负担 | 仅收集执行时懒拉、并行、15s 超时；单轮全失败即跳过，无重试风暴；未用收集零请求 |
| 去重误杀（不同事件标题相似） | 相似度阈值保守（Jaccard ≥ 0.7）+ 仅当日比对 + notice 透明报告丢弃条目，用户可见可纠 |

### 10.4 明确不做（本期）

- pgvector 语义去重、新闻 API、自写爬虫（见 §1.3）。
- 池条目的全文抓取/正文入库（池只存标题+摘要+pubDate；正文深抓仍由 agent 按配额 web_fetch）。
- 多期聚合周报/归档搜索（超出本 RFC 范围）。

---

## 11. 决策记录

| 项 | 决定 |
|---|---|
| 架构 | Host 侧拉取 + agent 在环整理，不动方案 A 骨架；池是「可选加强」非「必需前置」 |
| 默认池规模 | 内置 10 源（official 7 + major 3），开箱即用；无 UI 配置，Host 后台直接使用 |
| 拉取节奏 | **懒拉取**：无后台定时器、无手动刷新——每次新闻收集执行前 `runCollection` 同步拉一轮 |
| 池条目保留 | 未用条目 ≤500 条、48h 过期；已用条目摘除（usedIn） |
| 去重 | 工具层硬约束：标题归一化 + bigram Jaccard ≥0.7 + 当日比对（本期次内 ∪ 当日已有期次）；official 源可升级替换 |
| 深抓配额 | 每类 ≤2 条、全期 ≤6 条（默认），随 itemCount 线性放宽 |
| 切换策略 | 池为主、web_search 补盲；热点/自定义主题/池故障 → web_search 为主或全量 |
| 失败处理 | 单源失败自动停用 24h；全池失败降级纯 web_search；错误透传不诊断 |

---

## 12. 实现落点（已实现，2026-09）

| 里程碑 | 落点 | 说明 |
|---|---|---|
| M-R1 池骨架 | `lib/news-core.js`：`DEFAULT_RSS_FEEDS` / `RSS_TIERS` / `sanitizeRssPrefs` / `parseRssXml` / `parseRssDate` / `mergePoolItems` / `prunePool` / `filterPoolForScope` / `poolSummary` / `normalizeFeedUrl` / `decodeRssEntities`；`lib/index.js`：`rss`+`pool` 持久化段（version 2）、`pullPoolOnce` / `recordFeedFailure`（连续 3 次自动停用 24h） | 默认池 10 源开箱即用（2026-09 实测全部今日新鲜，见 §3.2）；懒拉取：无后台定时器，仅在收集执行时拉（与节假日日历同一原则）；`pullPoolOnce` 不内部 `loadNews`（与 purgeStaleNews 同一约束，防并发覆盖） |
| M-R2 收集接入 | `runCollection` 收集前懒拉取、按班次范围 `filterPoolForScope` 预筛池条目、注入【信源池材料】；系统提示词新增「信源池优先 + 两阶段收集」小节 | 池是「可选加强」非「必需前置」——无池/池空/拉取失败时指令不注入，agent 走纯 web_search |
| M-R3 工具层去重 | `lib/news-core.js`：`normalizeTitle` / `bigrams` / `unigrams` / `setJaccard` / `bigramJaccard` / `unigramJaccard` / `titlesDuplicate` / `dedupeItemsAgainst`；`news_broadcast.execute` 在 sanitize → 冷却窗之间插入去重（比对本批次 ∪ 当日已有期次），official 源升级替换（旧期次数据层移除 + notice 报告） | 中文短标题适配：unigram 补 bigram 单信号；数字编号（第1号/第10号）不做包含判断；去数字后同模板视为编号差异不误杀 |
| M-R4 前端 | `lib/client.js` NewsPane：**无信源池 UI**（不渲染状态行/配置子视图，无相关 fetch/state/路由调用） | 池对用户完全透明——界面无任何 RSS 信源池呈现，Host 后台自动懒拉取使用 |
| 文档 | `docs/news-rss-pool-rfc.md`（本文件）、`daily-news-briefing-design.md`（M5 已实现）、`daily-news-briefing-ui.md`（无信源池 UI）、`README.md`（信源池 + 工具层去重条目） | — |
| 测试 | `test/news-rss.test.js`（31）+ `news-routes.test.js`（懒拉取集成 + 去重集成）+ `client.test.js`（无信源池 UI）；全量通过 | Host 懒拉取测试 stub 全局 fetch 返回假 RSS，避免真网络 |

### 与 RFC 正文的偏差

1. **`prunePool` 的 publishedAt 超龄判定**（§3.3，二次修正）：初版加了 1h 入库宽限（防刚拉的旧条目被裁），实测发现**方向反了**——停更源残留的旧闻（人民网 2025-06 缓存）正是污染源，宽限反而让它们留在池里毒化 agent。改为**发布 > 48h 直接淘汰，无宽限**：池定位当日新闻，拉取成功后立即 prune 即清走旧闻。
2. **`titlesDuplicate` 加了数字编号守卫**（§7.3）：纯字母数字标题（t1/t10）与「第1号/第10号」类编号标题不做包含/Jaccard 误判——去重宁可漏不可错杀，误杀会丢新闻。
3. **移除后台拉取定时器，改为收集前懒拉取**（§4.1，架构变更）：早期版本有 `rebuildPoolTimer`
   （默认 30 分钟轮询 + 启动 60s 首拉，并因测试环境 stub 全局 fetch 做首拉延迟）。后改为
   **懒加载**：无后台定时器、无启动拉取，`runCollection` 每次收集前同步 `pullPoolOnce()`——
   没跑新闻收集就不产生任何 RSS 请求；「立即拉取」按钮与 `/news/rss/pull` 路由一并移除。
4. **`runCollection` 池新鲜度保障 → 升级为懒拉取主机制**（§5.2）：早期版本按「距上次拉取 ≥
   拉取节奏」才在收集前补拉（配合后台定时器）。懒加载改造后，收集前**无条件**同步
   `pullPoolOnce()`，保证每次注入的【信源池材料】都是刚拉到的最新数据；拉取失败静默降级
   （池空 → 不注入，agent 走 web_search）。
5. **`news_schedule` 新增 `action:'pool'`**（§5.2）：agent 在**对话直接播报**（不走 runCollection）时主动调 `news_schedule {action:'pool'}` 获取【信源池材料】（可传 categories/topics 过滤）——对话播报此前完全没有池注入通道，提示词「信源池优先」成了空话。系统提示词第 0 条明确要求每次收集先调 pool。
6. **默认池必须「今日新鲜」而非仅「可解析」**（§3.2，实测踩坑）：首版验证只看 HTTP 200 + `parseRssXml` 能解析 + 有时间锚，**没检查时间锚是否新鲜**——人民网 5 频道（2025-06 停更）、新浪科技/体育（2018 停更）全被误收进默认池，agent 按「存疑即弃」全丢。二次验证改为「最新条目 pubDate 距今 < 2 天」，默认池换为中新网 7 频道 + IT之家/量子位/少数派（10 源全部今日新鲜）。新增 `DEFAULT_RSS_FEEDS_VERSION=2`：未手工改过的旧配置自动升级新默认池（`custom` 标记区分用户是否改过）。
