# 网络电台（Internet Radio）播放 · 可行性分析与实现设计

> 目标：在本插件（dsh-music-player）中新增「网络电台」能力：**按关键词/国家/分类浏览全球电台目录，
> 点播即听，无账号门槛**，并让 `music_play` 工具也能按电台名/类别直接开播。
>
> 状态：**已实现并发布**（目录/收藏/纯流播放 + HLS 转流播放，见 §5.2 定稿方案）。本文档为设计与实测记录。
>
> 一句话结论：**完全可行**，且因为插件已有「Host 出网取流 + `/dsh-music` 同源流式代理」的成熟架构
> （QQ/酷狗/网易云三路在线源同构），电台功能主要是**再复制一路数据源**，真正的增量难点只有一个：
> **HLS（m3u8）电台的播放**——约四成中文电台是纯 MP3/AAC 流可直接播，但热门的央广/凤凰/CRI/蜻蜓等
> 中文台大多只发 m3u8（实测 CN top200 里 hls:1 占 41.5%）。

---

## 0. 术语与结论速览

| 术语 | 含义 |
|---|---|
| **纯流（plain stream）** | 服务器直出连续的 MP3/AAC 字节流（Icecast/Shoutcast/部分 qtfm 直链）。`<audio src>` 可直接播放 |
| **HLS 流** | 服务器给一个 `.m3u8` 播放列表，浏览器需按列表请求分片 `.ts`/`.aac` 并拼接。`<audio>` 不能直接播 m3u8（Safari 除外） |
| **ICY 元数据** | 电台流里每隔一段内嵌的当前曲名（`StreamTitle`），Icecast/Shoutcast 专属 |

**三条实测结论（本机 2026-09 验证）：**

1. **radio-browser.info 目录 API 本机可达**（`de1.api.radio-browser.info` 等镜像），返回结构化 JSON：
   台名 / 国家 / 语言 / 标签 / codec / bitrate / `hls:0|1` / 播放 URL（`url_resolved`）/ 投票数。覆盖全球
   ~4 万电台，中国区含 央广（CNR-1/2）、CRI、凤凰卫视、蜻蜓/喜马拉雅聚合台等。
2. **本机可直连绝大多数电台流**：央广 `https://lhttp.qtfm.cn/live/15318317/64k.mp3`（MP3，HTTP 200 持续出流）、
   国际台 `https://icecast.walmradio.com:8443/classic`（MP3，HTTP 200，带 `icy-name`）均直接连通。
   即 Host 出网取流无额外网络障碍（与 QQ/酷狗取链同一套 `fetch` 出网模式）。
3. **HLS 是中文主流台的核心问题且形态可转流**：实测 CN top200 里 hls:1 占 **41.5%**（votes/clickcount
   排序一致；凤凰/CCTV 伴音/CNR/CRI/蜻蜓等高票台几乎全 HLS），而全球 topvote 前 100 是 0%——
   HLS 支持为中文主流台而生。实测主流中文 HLS 台（CCTV-13 / 凤凰 / 中国之声，三家不同 CDN）**统一为
   AAC-LC-in-MPEG-TS**，纯 Node 剥 TS 壳可得 Chromium `<audio>` 直接消费的 ADTS 连续流（§5.2 方案 C′ 定稿）。

---

## 1. 开源社区参考（调研结论）

### 1.1 目录数据源：radio-browser.info（首选）

- 官网目录站 [radio-browser.info](https://www.radio-browser.info/)（又名 radio-browser、community radio browser），
  全球最大**开放**电台目录（数万电台、CC 开放数据）。
- API 文档：[radio-browser-api-documentation（AnowHosting 镜像文档）](https://github.com/AnowHosting/radio-browser-api-documentation)、
  [radio-browser-api（ivandotv 的 Node 客户端 + API 文档）](https://github.com/ivandotv/radio-browser-api)。
- 端点形态（JSON 直出，无需 key、无登录）：
  - `GET https://de1.api.radio-browser.info/json/stations/search?name=&countrycode=CN&tag=&language=&order=votes&reverse=true&hidebroken=true&limit=…`
  - `GET .../json/stations/topclick/50`（点击榜）、`.../json/stations/topvote/50`（投票榜）、`.../json/stations/byuuid/<uuid>`
  - `GET .../json/countries`、`.../json/tags`、`.../json/languages`（元数据枚举）
  - 服务器发现：`all.api.radio-browser.info` 302 到可用镜像（实测本机对该聚合域名不稳，建议**直连一组已知镜像并做故障转移**，见 §3.3）。
- 每个电台对象关键字段（实测样例）：`stationuuid / name / url / url_resolved / homepage / favicon /
  country / countrycode / languagecodes / tags / codec / bitrate / hls / votes / clickcount / lastcheckok`。
  `lastcheckok=1` + `hidebroken=true` 即代表社区刚验证过可播。

### 1.2 其他可选源（备选 / 增补）

| 来源 | 说明 | 适合 |
|---|---|---|
| [iptv-org/iptv](https://github.com/iptv-org/iptv)（含 iptv-org/api） | 开源 IPTV/电台 M3U 聚合（各国 `.m3u8`），有 China radio 频道 | 增补中文台 / 提供 m3u8 集 |
| [gao/radio.m3u（SLCA2020 等镜像）](https://github.com/SLCA2020/gao/blob/master/radio.m3u) | TVBox 生态维护的中文电台 m3u | 手动收藏补充 |
| 蜻蜓 fm `lhttp.qingting.fm` / qtfm 直链 | 大量中文网络台直链（radio-browser 已聚合一部分） | 中文台精修 |
| Azuracast / 各站自有 icecast | 个人/社群电台 | 高级自定义 |

> 首版建议**只做 radio-browser.info 一个目录源**（数据最全、无 key、结构化），把「收藏」做在本地
> （用户自建收藏夹），不引入第二个目录源的维护成本。中文台数量少的问题由「收藏」兜底，
> 或后续版本再加蜻蜓/iptv-org 中文频道表。

### 1.3 播放器参考实现

- [sqrt-ch/sqrtRADIO](https://github.com/sqrt-ch/sqrtRADIO)：M3U 电台列表播放器，同时支持 **HLS 与 Icecast**
  纯流——先试纯流、失败降级 hls.js 的思路可借鉴。
- [jailsonsb2/RadioPlayer](https://github.com/jailsonsb2/RadioPlayer)：Icecast/Shoutcast/Zeno/Azuracast，
  展示「Now playing / 专辑图 / 歌词」——**ICY `StreamTitle` 解析 + 展示当前曲目**即这一路的成熟范式。
- [Borewit/music-metadata-icy](https://github.com/Borewit/music-metadata-icy)：把流式音频响应中的 ICY
  元数据解码出来的 JS 库（解析 `StreamTitle='...'`）。
- [warren-bank/node-HLS-Proxy](https://github.com/warren-bank/node-HLS-Proxy)：
  Node 端 HLS 代理（改写 m3u8 里的分片 URL 为相对/代理 URL），早期方案参考；定稿改走 Host 转流（§5.2）。
- 浏览器端直接 `<audio>` 播 AAC/MP3 纯流无需任何库；Chromium 对部分 `AAC ADTS` 直连有已知怪癖
  （[Icecast #2376: AAC HTML5 audio player in Chrome no fallback](https://gitlab.xiph.org/xiph/icecast-server/-/work_items/2376)），
  遇到时靠「Host 转码」几乎不可行，应靠**同源代理 + 换流**缓解（见 §5.6）。

---

## 2. 与现有架构的映射（为什么说“几乎免费”）

插件当前已有三路在线音乐源（QQ / 酷狗 / 网易云），全部走同一套模式。电台接入可完全复用：

| 现有能力 | 位置 | 电台如何复用 |
|---|---|---|
| Host 端 HTTP 路由注册 `ctx.webServer.register({kind:'prefix', path:'/dsh-music', handler: serve})` | `lib/index.js:5217` | 新增 `/dsh-music/radio/*` 分支即可（与 `/dsh-music/qq/*` 并列） |
| 取链后**同源流式代理**（`fetch` 上游 → `res.writeHead` → `for await` pipe） | `lib/index.js` `/dsh-music/qq/play/<mid>`（约 4245-4279） | `/dsh-music/radio/play?u=<url>` 用同一套代码改 URL 来源 |
| Host 出网 `fetch` + 超时（`AbortController`）+ UA/Referer 头 | `lib/qq.js:26`、`lib/index.js` | 新建 `lib/radio.js` 照抄 |
| JSON 缓存与目录浏览路由（`/dsh-music/qq/playlists?category=` 等） | `lib/index.js` | `/dsh-music/radio/search|countries|tags|top|byuuid` |
| 客户端 tab 体系（竖排按钮 + pane 常驻渲染 + ttsHint） | `lib/client.js:8280-8366` | 新增 `tab: 'radio'` + `RadioPanel` |
| 播放条来源徽标（QQ/酷狗/网易云）与「格式·档位」 | `lib/client.js:4265-4282` | 电台标「网络电台」，显示 codec/bitrate 或「正在播放: 曲名」 |
| `resolvePlayable` + `startPlay` + `audio.src = track.url` | `lib/client.js:758-790 / 2399-2449` | 电台 station 就是一个「无限长 track」：url=`/dsh-music/radio/play?u=…` |
| 进度持久化 / 恢复（各 source 独立快照） | `lib/client.js:savePlayback/loadPlayback/restore*` | 电台只记「当前台 + 是否在播」，不记 position |
| scope 体系 | `kind: 'library'|'playlist'|'qq'|'kg'|'nc'|'book'` | 加 `kind: 'radio'`（改到 `restoreScope`、`scopeKey`、activeIds 等处） |
| 系统提示注入 | `lib/index.js:5756`（`ctx.systemPrompt.section`） | 补一句「可播网络电台」 |
| `music_play` 模型工具 | `lib/index.js:5222-5378` | 加 `source='radio'` / `query` 命中电台 |
| 免责声明（非官方接口/版权） | 各在线源文档 + about 页 | 电台目录本身无版权风险（CC 数据 + 电台公开流），收藏与播放遵守台站 ToS |

---

## 3. Host 端设计（lib/radio.js + index.js 路由）

### 3.1 新增 `lib/radio.js`（纯 Node、零依赖、复用 qq.js 的 fetch+timeout 范式）

```js
// 目录查询：包装 radio-browser.info 的 /json/stations/* 等端点
export async function search({ name, countrycode, tag, language, order, limit })  // → Station[]
export async function topBy(order='votes'|'clickcount', limit)                   // → Station[]
export async function countries() / tags() / languages()                          // 元数据（供 UI 下拉）
export async function byUuid(uuid)
export async function resolveStream(station)   // 探测（可选）：确认 content-type / hls / 可达
// Station 归一化字段：{ id: stationuuid, name, country, countrycode, language, tags,
//   codec, bitrate, hls, url, favicon, homepage, votes, clickcount, lastcheckok }
```

要点：
- 多个镜像 `de1/si1/fr1/...api.radio-browser.info` **逐个尝试做故障转移**（`all.api.radio-browser.info`
  实测不稳）。
- 全部请求带超时（默认 ~8s，目录请求可 15s）与自定义 UA。
- 服务器返回的字段名不做假设：用宽容取值（对齐 `lib/qq.js` 的 `val()` 风格）。
- **radio-browser 的 `url` 常有 302/跳转**，播放时应取 `url_resolved`（API 已尽量解析）或由代理侧跟随跳转。

### 3.2 新增路由（都挂在现有 `/dsh-music` 前缀下）

```
GET  /dsh-music/radio/search?name=&countrycode=&tag=&language=&order=&limit=   → { ok, stations: [...] }
GET  /dsh-music/radio/top?group=&limit=50&offset=0                            → { ok, stations: [...] }（热门，分组+分页见 §4.5）
GET  /dsh-music/radio/cn?group=&limit=50&offset=0                            → { ok, stations: [...] }（「中文电台」视图，分组+分页见 §4.5）
GET  /dsh-music/radio/countries | /tags | /languages                            → { ok, list: [...] }
GET  /dsh-music/radio/favs            → { ok, favs: [...] }                     （本地收藏，见 §3.4）
POST /dsh-music/radio/favs            → 增删收藏（{ station, fav: bool }）
GET  /dsh-music/radio/play?u=<url>&hls=0|1&ct=<content-type>                    → 流式代理
GET  /dsh-music/radio/meta?u=<url>    → （可选）拉一小段流解析 ICY StreamTitle（见 §5.7）
GET  /dsh-music/radio/servers         → 探测可用镜像（启动时跑一次并缓存）
```

**播放代理 `/radio/play`（关键）**：与 `/qq/play/<mid>` 同构，但有电台特有差异——

```js
const upHeaders = {
  'User-Agent': RADIO_UA,
  'Icy-MetaData': '1',                 // 请求 ICY 元数据（台站支持时返回）
  // 不转发浏览器 Range（直播流不支持 seek；本地曲目的 Range 语义在此不适用）
}
const stream = await fetch(dl.url, { headers: upHeaders, redirect: 'follow' })
const headers = {
  'Content-Type': stream.headers.get('content-type') || 'audio/mpeg',
  'Cache-Control': 'no-store',
  'X-DSH-Radio-Name': encodeURIComponent(icyName || '') ,   // 把台站 icy-name 透传
  'X-DSH-Radio-Codec': ...,
}
res.writeHead(stream.status, headers)
for await (const chunk of stream.body) res.write(chunk)
```

- **不转发 Range/不 Seek**：直播是单向无限流，播放条进度语义要特判（见 §4.4）。
- **ICY 元数据默认不进播放流**（`Icy-MetaData:1` 会让流里每隔 N 字节插入一段元数据块，若不解析会
  产生爆音/卡顿；而 Chromium 的 `<audio>` 无法消费带 ICY 的流）。两种取法见 §5.7。

### 3.3 镜像选择与缓存

- `radioServers()`：启动/首次调用时 `GET /json/servers` 拿镜像列表（实测本机返回 `de1`），
  缓存 24h；失败时回退内置默认镜像数组。
- 目录响应按查询串做 **LRU 内存缓存（≤ 50 条，TTL 10min）**，避免切 tab 反复打目录源。
- 收藏、镜像列表等持久化到 `~/.dsh/music-player-radio.json`（对齐现有 qq cookie / news json 的
  落盘方式：`stateFile()`/`readJsonAtomic/writeJsonAtomic`，0600）。

### 3.4 收藏：本地收藏夹（不做远端账号）

电台无需登录，收藏天然放本地即可：
- `favs`：`[{ id: stationuuid, name, url, favicon, country, codec, hls, addedAt }]`
- UI「♥ 收藏」按钮 + 「我的电台」子 tab；收藏与自建歌单**同构但独立**（电台不是歌曲，
  不需要进入曲库/歌单的数量上限与「我最喜欢」体系）。
- （实现注记：早期版有「手动添加任意 URL」弹窗，后按产品决策移除——radio-browser 目录 +
  收藏已覆盖主流场景；收藏数据文件里仍允许手工写入任意合法 URL 的台。）

### 3.5 与 music_play 工具的集成

`music_play`（`lib/index.js:5222+`）目前枚举 `source: ['local','web','netease']`。电台建议**不加新枚举，
而是加一个动作语义**：当 `query` 命中电台且现有本地/在线曲库都无结果时，落一个 `pendingIntent`：

```js
// 调 /dsh-music/radio/search（带 query）→ 取第一条 lastcheckok=1 的台
pendingIntent = {
  action: 'play', kind: 'radio', id: st.id,
  name: st.name, url: '/dsh-music/radio/play?u=' + encodeURIComponent(st.url) + '&hls=' + st.hls,
  source: 'radio',
}
```

可选项（后续版）：`source='radio'` 显式语义 = 「只搜电台」；以及"按类别开播"（把某 tag 前 N 个台
排成一个队列，next 轮播不同台）。首版不做队列、只做「点台即播」。

---

## 4. 客户端设计（lib/client.js）

### 4.1 新增 tab「电台」

- `store.tab` 加 `'radio'`（默认仍 `'music'`）。
- 左侧 tab 栏（`lib/client.js:8352`）在网易云后插 `tabBtn('radio', '电台')`。
- 内容区（`listBody`，8317-8325）加一个 pane：
  `React.createElement('div', { className:'dsh-music-qq-pane', style: paneStyle('radio') }, React.createElement(RadioPanel, { panelRef }))`。
- `RadioPanel` 是一个**独立组件**（复用 QQ/KG/NC Panel 的结构与 CSS 类），内部 useState 管理
  当前视图：`首页(推荐/热门) / 我的电台(收藏) / 浏览(国家·标签) / 搜索`；非活动 pane 不卸载，
  切走再回来状态保留（既有 pane 模式天然支持）。

UI 布局建议：
- 顶部：搜索框（台名/国家/标签）+ 国家下拉 + 「刷新镜像」。
- 台列表行：favicon（失败回退音符图标）+ 台名 + 国家/语言/标签小字 + codec·kbps 徽标 + 「▶」+「♥」。
- 点「▶」/行 → `startRadio(station)`；点「♥」→ 收藏/取消。
- 每个台行显示社区健康度（`lastcheckok=1`），broken 台置灰提示「社区标记不可播」。

### 4.2 状态与来源接入（最小侵入）

仿照 qq/kg/nc 的既有模式：

1. `store.scope` 增加 `{ kind: 'radio' }`；`restoreScope`（3536）、`activeIds/scopeKey`、`restoreLatest`
   的判断分支补 `radio`（3590-3801 区间）。
2. `resolvePlayable`（758-790）加一支：
   ```js
   if (String(id).startsWith('radio:')) {
     const st = radioById(String(id).slice(6))   // 收藏/最近电台表里查
     return { id, name: st.name, url: st.playUrl, artists: [], quality: st.codec + (st.bitrate?' · '+st.bitrate+'k':'') }
   }
   ```
3. 新增 `startRadio(station)`：`set({ scope:{kind:'radio'} })` → 内部走 `startPlay('radio:'+st.id)`。
   （`startPlay` 的 `audio.src = track.url; audio.load(); audio.play()` 全部复用。）
4. 播放条徽标（4265-4282）：加 `isRadio` 分支，标「电台」，title 附台站信息。
   电台无歌词 → `loadLyricForTrack` 分支里跳过/清空（电台行不显示歌词）。
5. 电台是「**不可 seek 的无限流**」：`onTime/onDur` 与 `duration` 需要特判（见 §4.4），
   否则 `audio.duration=Infinity` 会污染进度条与自动续播逻辑。

### 4.3 队列/下一台

直播电台没有"曲目"，`step(1)`（下一首）语义改为「换到同一收藏/搜索结果里的下一个台」：
- `buildShuffleQueue`/`onEnded→step` 在 `scope.kind==='radio'` 时基于**当前电台列表（搜索结果/收藏）**
  推进。直播流一般不会自然 ended（除非断流），断流重连策略见 §5.6。

### 4.4 直播流的进度/时长特判（关键差异点）

- `audio.duration` 对直播流是 `Infinity`（或一直增长）。**不要写入 `store.duration`**，或显示为「直播」。
- 不显示可拖进度条；播放条上的「-mm:ss / mm:ss」改为「LIVE」红点或台名。
- `onEnded`：直播流被服务器掐断会触发 ended，应尝试自动重连（退避 3s）而不是自动切下一台
  （对齐讲书看门狗的思路）。

### 4.5 「中文电台」子视图（RadioPanel 内新增，支持主题分组浏览）

> 需求：用户想听国内主流电台时不必手动搜索——在电台面板（主 tab 已更名「网络电台」）内
> 增加一个**「中文电台」子 tab**，且目录列表**按主题分组**（全部/新闻/音乐/交通/财经/文艺/
> 故事/体育），点哪组只拉哪组的数据，覆盖远超单一 Top N。

**数据口径（纯 live 目录，零维护）：**

- Host 端：
  - `GET /dsh-music/radio/cn?group=<g>&limit=50&offset=<n>` → `lib/radio.js` 的 `cnMainstream`：
    `countrycode=CN` +（非 all 时）`tag=<g>` 查询 radio-browser（`hidebroken=true`、votes 排序、
    **单请求上限 200 条**；`tag=a,b` 不支持 OR、`tagList` 是 AND，故每组=单 tag，「全部」=不带 tag）。
  - `GET /dsh-music/radio/top?group=<g>&limit=50&offset=<n>` → `worldTop`：'all' 与各分组统一走
    `search?order=votes`（实测与 topvote 前段几乎一致，且 **search 支持 offset 翻页**；topvote 端点
    不支持可靠翻页）。
- **分页加载**（用户决策）：每页 **50 条**，客户端先加载第一页，列表底部「加载更多」按钮点击后带
  `offset=50/100/…` 追加下一页，直到返回不足一页（到底）隐藏按钮。radio-browser 实测 offset 翻页
  有效（相邻页无重叠）。
- 滤噪缓冲：每页向目录取 limit+少量缓冲、剔除噪音台后仍凑满一页展示（噪音台不占页容量）。
- **hls 自然混排**（用户决策）：上游不支持按 hls 过滤（`is_hls`/`hls` 参数实测被忽略），故分页
  语义=每页按 votes 序自然混排；hls:1 台与纯流台同列表（HLS 已可播，见 §5.2），不做重排。
- 分组 tag 词经实测校准（CN 区 tag 分布：news 397/music 542/traffic 166/economics 40/
  literature 21/storytelling 18/sport 14），定义见 `lib/radio.js` 的 `CN_GROUP_TAGS` /
  `WORLD_GROUP_TAGS`；key 与客户端 `RADIO_CN_GROUPS` / `RADIO_TOP_GROUPS` 一一对应。
- **会话内缓存（按组分页累积）**：`topMap[group]` / `cnMap[group]` 存 `{ rows, offset, done }`，
  翻过的页不再重拉、切组/切回直接显示已加载部分；请求去重（busy ref），失败允许重试。

**UI（RadioPanel view 增加 `'cn'` 与 `'top'` 分组 pill 行）：**

- 顶部 viewtabs：我的电台 → 最近播放 → 中文电台 → 热门电台 → 搜索（5 tab）。
- 「中文电台」/「热门电台」视图在 viewtabs 下方各有一行**主题 pill**（复用 `.dsh-music-qq-cat`
  分类 chip 样式）：中文 = 全部/新闻/音乐/交通/财经/文艺/故事/体育；热门 = 全部/音乐/新闻/
  古典/摇滚/爵士/谈话。激活态高亮；切换组即触发该组首屏加载（缓存命中则直接显示）。
- 列表行与其它视图共用 `renderRows`：`hls:0` 直接播；`hls:1` 直接播（走 §5.2 转流），
  以「HLS」格式徽章标注（HLS 台 codec 目录里多为 UNKNOWN，徽章替代无意义的 codec）。
- 列表底部「加载更多」按钮：目录未到底（`done=false`）时显示，点击追加下一页并保持滚动位置；
  正在加载时按钮置灰「加载中…」，到底后隐藏。
- 提示行说明视图数据源、主题筛选与 HLS 标注原因。

**覆盖说明（为什么不是「全部 2071 个都列出」）：** radio-browser 中国区通过检测的台约
2071 个；列表按 votes 序分页逐屏加载（每屏 50，可一直「加载更多」直到该分组目录到底——
单请求上限 200，超过 200 的组如需完全拉全需翻页聚合，另立）。「全部」与各主题组都能翻到
radio-browser 对该查询可返回的深度，覆盖远大于早期一次性 60 行上限。

**与「热门电台」的关系：** 热门是全球高票台（杂），中文电台是国内可听台（聚焦），
两者数据源独立（`topMap` vs `cnMap`，收藏/最近用 `rows`），避免串台。

**HLS 分期（已并入首版）：** 中文主流台（央广/凤凰/CRI/CCTV 伴音）多为 m3u8，靠 §5.2 定稿的
**Host 端纯 Node 转流**（HLS→ADTS 连续流）全量可播；列表不再灰显 HLS 台，仅以「HLS」格式徽章标注。

---

## 5. 关键技术点与分叉决策

### 5.1 范围分级（强烈建议按此分期）

| 期 | 内容 | 工作量 |
|---|---|---|
| **P0（核心）** | radio-browser 目录 + 搜索 + 收藏 + **纯流（mp3/aac 直连）播放** | 中（1-2 天） |
| **P1（中文台刚需）** | HLS 支持（见 5.2） | 中 |
| **P2（体验）** | ICY 当前曲目、直播态 UI、断流重连 | 小-中 |
| **P3（可选）** | 手动 m3u8 URL、队列轮播、按 tag 自动换台 | 小 |

> 中文台（央广/凤凰/CRI/部分蜻蜓）绝大多数是 HLS——靠 §5.2 定稿的 Host 转流方案，「中文电台」
> 子 tab（§4.5）里这些主流台已全量可播（以「HLS」徽章标注）。

### 5.2 HLS 播放方案（已定稿：Host 端纯 Node 转流，零外部依赖）

> **定稿结论（2026-09 实测 + 浏览器验证后）**：P1 采用 **Host 端「HLS → ADTS 连续流」纯 Node 转换**，
> 不改动 `lib/client.js` 播放链路、不引入 hls.js/ffmpeg。中文主流 HLS 台是两种 AAC 分片容器之一：
> **MPEG-TS 188B 分片**（央广/凤凰/CCTV 等广播级标准，AAC-LC）或**裸 ADTS .aac 分片**（蜻蜓/喜马拉雅，
> 华语金曲500首等，常为 HE-AAC）——均归一为 Chromium `<audio>` 原生可播的 ADTS 连续流，已实测出声。

**为什么放弃 hls.js（原方案 A/B）：**

| 原方案 | 放弃原因（实测/代码核查） |
|---|---|
| A：浏览器端 hls.js 直连 | 分片请求打台站 CDN 撞 CORS/防盗链/混合内容；hls.js 需 vendor 化，但 client.js 是**手写扁平 UMD**（`lib/vendor/qrcode.mjs` 先例从未被引用，DSH loader 是否认 vendor 相对路径未验证），加载路径不确定 |
| B：Host 改写 m3u8 + client hls.js | 需动 client 播放链路（`<audio>` + 谱 tap + error/ended/reconnect 全要挂 hls.js 事件），改动面大；改写器还要处理嵌套 master + 分片级 token |
| C：Host HLS→连续流（ffmpeg） | 需引入 ffmpeg 外部依赖；转码开销大 |

**定稿方案 C′：Host 端纯 Node「拉 m3u8 → 分片归一化 → 出 ADTS 连续流」**

- **可行性根因（实测）**：音频 HLS 有两种主流分片容器，实测均需支持——
  - **MPEG-TS 188B 分片**（CCTV-13 myalicdn / 凤凰 ifeng / 中国之声 ahbztv）：AAC-LC 48k stereo，
    PMT 常为空节目——按 PES 流 ID（`0xC0-0xDF`）提取，不依赖 PAT/PMT；
  - **裸 ADTS .aac 分片**（华语金曲500首 qtfm 等蜻蜓/喜马拉雅系）：分片本身即 ADTS 帧流
    （HE-AAC 44.1k 等），无需剥壳直接过帧同步。
  - 探测按内容判别（0x47 同步包 → TS；0xFFF 同步字 → ADTS），见 `segmentToAdts`。
- **浏览器端兼容（实测）**：归一化产物是**自描述 ADTS 帧流**（`0xFFF` 同步字 + 帧长），headless Chrome
  以 chunked 流式（无 Content-Length）播放 **`playing`/`timeupdate` 正常、`readyState=4`、`duration=null`**
  （直播流特征）；AAC-LC 与 HE-AAC(SBR) 均实测可播——**`<audio>` 原生可播，client 播放链路零改动**。
- **覆盖的 m3u8 形态（实测）**：单层相对分片（CCTV）/ 分片级 token（凤凰 `?txspiseq=`）/
  **master 嵌套 + 子列表 token 继承**（中国之声，CN 票数第 6）、scheme-relative 分片 URL
  （蜻蜓 `//ls-hw-ot.qtfm.cn/...`）——解析器需递归一层、保留查询串并补全协议相对 URL。
- **局限（诚实声明）**：仅支持 AAC（TS 或裸 ADTS 容器）；fMP4/CMAF `m4s`、加密 HLS（EXT-X-KEY）、
  非 AAC 编码不支持，遇到给明确报错（「该台编码暂不支持」）而非静默失败。实测主流中文台全中，覆盖面好。

**实现要点（lib/hls.js）：**

1. **m3u8 解析**：`parseHlsPlaylist(text, url)` 判 master/media；master 取第一个 `#EXT-X-STREAM-INF`
   子列表（递归一层）；media 返回 `{ targetDuration, mediaSequence, segments:[{url,duration}] }`，
   相对分片补全绝对 URL、保留查询串。
2. **分片归一化**：`segmentToAdts(buf)` 按内容探测容器——TS（0x47 同步包）走 `tsStripPes`（188B 包 →
   解 PID/PUSI/adaptation field → 音频 PID 按 PES 流 ID `0xC0-0xDF` 识别 → 剥 PES 头拼净载）；
   裸 ADTS（0xFFF 同步字）直接过帧同步；两者皆非则明确报 unsupported。
3. **ADTS 同步**：`adtsSyncScan(buf)` 按帧长切帧（容错丢噪声字节），输出完整 ADTS 帧。
4. **续拉状态机**：以 `TARGETDURATION` 为周期轮询 media playlist → 增量拉新分片（按 URL 去重）→
   归一化 pipe 出流；客户端断开 abort；单分片失败重试 1 次、连续失败按断流语义结束（client 30s 重连守卫兜底）。
5. **路由分流**：`/radio/play` 的 `u` 指向 `.m3u8` 或 `content-type: application/vnd.apple.mpegurl`
   （或 `hls=1`）时走 HLS 转换分支，否则走现有纯流代理。响应 `Content-Type: audio/aac` + `no-store`。

**验证路径（已执行，2026-09-03）：**

```bash
node test/hls-proto.mjs          # 纯函数验证：m3u8 17/17 + TS 剥壳 vs ffmpeg 基准 100% 帧对齐
node test/hls-browser-proto.mjs  # headless Chrome 流式播放裸 ADTS：playing/readyState=4 ✅
```

纯函数原型当前在 `test/hls-proto.mjs`，验证通过后平移为生产模块 `lib/hls.js`（配 vitest 单测，
fixtures 在 `test/fixtures/hls/`：CCTV/凤凰/中国之声 master+media 真实抓取样本 + 凤凰 TS 分片 +
蜻蜓裸 ADTS 分片）。

### 5.3 同源代理的必要性（与 QQ 取链同因）

- 浏览器直连电台 URL 会遇到 CORS/防盗链/混合内容；经 `/dsh-music/radio/play` 同源代理后
  `<audio>`/转流产物是同源加载，实时频谱（`captureStream+AnalyserNode`，`lib/client.js` 头部）直接可用。
- 现状 `<audio>` 频谱 tap 已按「在线源」验证可用（QQ 流即经代理）。电台流（纯流与 HLS 转流）走同一路径零改动。

### 5.4 `<audio>` 与 ICY：不要让浏览器吃带元数据的流

- 请求 `Icy-MetaData:1` 时台站会在音频流中**周期性插入元数据块**；Chromium `<audio>` 遇到会报
  `MEDIA_ELEMENT_ERROR`/花屏爆音。**播放流必须请求 `Icy-MetaData:0`**（默认）。
- 「正在播放的曲名」另走 §5.7 的旁路探测，不污染播放流。

### 5.5 为何不需要 client 第三方库（定稿说明）

- 定稿方案把 HLS 复杂度全部关在 **Host 端**（`lib/hls.js` 纯 Node 剥壳），浏览器端仍是原生
  `<audio>` + 现有 `lib/client.js` 播放链路，**不需要任何 client 侧第三方库**（hls.js 等）。
- 若未来要支持 fMP4/加密 HLS 等 Host 端无法剥壳的形态，才需评估 hls.js；届时 client.js 是
  **手写扁平 UMD**（`window.__ModuleLoader__.load`），引入外部库需 vendor 化且验证 DSH loader
  是否认 vendor 相对路径（`lib/vendor/qrcode.mjs` 先例从未被引用，路径未验证）。当前无此需求。

### 5.6 断流 / 坏台 / 格式怪癖

- radio-browser 有 `lastcheckok` 字段，但**仍可能失效**：播放失败/静音 5s 的台自动
  换下一个候选或提示「该台不可播，试试下一个」。
- HLS 转流台若编码不支持（非 AAC：fMP4/加密 HLS 等），代理侧报明确错误「该台编码暂不支持」；
  Host 出网/剥壳失败对单台确认性重试 1 次仍失败即放弃并提示（对齐 news 的失败策略）。
- 纯流台若在 Chromium 播不出（AAC ADTS 怪癖等），提示换台（不转码）。
- **裸 AAC(aacp) 无限流概率性解码失败（实测 AsiaFM高清音乐台等）**：`audio/aacp` 无帧头原始 AAC
  经 chunked 无限流送达时，Chromium `<audio>` 解码器初始化**概率性失败**（`PIPELINE_ERROR_DECODE`，
  表现「偶发播放失败、再点就好」；headless 多次实测成功率非 100%）。代理层预缓冲实测不能根治
  （Chrome 对"200 + 无限流 + 裸 AAC"的时序敏感）。对策：**client 播放失败自动退避重试
  ≤3 次**（`RADIO_RETRY_MAX`，600ms×n 退避），此类台重开流即恢复，用户几乎无感知。

### 5.7 「正在播放」曲名（ICY StreamTitle，P2 可选）

- 播放流不带 ICY 元数据，但可**另开一条短连接**：Host 对同一 URL 发 `Icy-MetaData:1` + `Range`
  拉 ~几十 KB，解析元数据长度与 `StreamTitle='…'`，按间隔轮询（30s）更新
  `/dsh-music/radio/meta?u=`，客户端在台名下显示「正在播放：曲名」。
- 参考 [Borewit/music-metadata-icy](https://github.com/Borewit/music-metadata-icy) 的解析逻辑
  （其代码量很小，可参考手写）。
- HLS 台通常没有 ICY；部分台站另有 JSON API（如 qtfm）可轮询当前节目，属于锦上添花，首版可不做。

### 5.8 版权与合规（写进免责声明）

- radio-browser.info 目录本身是 **CC/开放数据**；电台**公开直播流**的收听通常免费、面向公众。
  相比 QQ/酷狗的非官方点播接口，电台的合规风险显著更低。
- 但仍须：不转播/不录制分发、不绕过任何付费墙或 DRM、遵守台站 ToS、说明内容版权归台站/版权方。
- about 页与新增提示沿用现有免责声明句式（QQ/kg/nc 已有模板，改一句即可）。

---

## 6. 代码级落点清单（改动文件）

| 文件 | 改动 |
|---|---|
| `lib/radio.js`（已建） | 目录 API 封装（search/top/countries/tags/servers 故障转移）+ 归一化 + 收藏读写 + ICY 解析（P2 预留） |
| `lib/hls.js`（新增） | HLS 转流：m3u8 解析（master/media/递归/token）+ TS→ADTS 剥壳 + 续拉状态机（§5.2） |
| `lib/index.js` | `/dsh-music/radio/play` 分流：`.m3u8`/`hls=1` 走 `lib/hls.js` 转流，否则纯流代理；`music_play` 去掉 `!s.hls` 过滤 |
| `lib/client.js` | HLS 台从「灰显禁播」改为可播：`playStation` 去掉 hls 拦截、行样式去掉 `.hls-only` 禁播、加「HLS」格式徽章 |
| `docs/internet-radio-design.md`（本文档） | 本设计定稿 |
| `test/radio.test.js` / `test/hls.test.js`（新增） | 目录/收藏/路由 + m3u8 解析/TS 剥壳/续拉纯函数单测（fixtures 在 `test/fixtures/hls/`） |
| `test/hls-proto.mjs`（验证原型） | 纯函数原型 + ffmpeg 基准对比（`node test/hls-proto.mjs`） |
| `test/hls-browser-proto.mjs`（验证原型） | headless Chrome 流式播放裸 ADTS 验证 |
| `README.md` | 功能清单补「网络电台（含 HLS）」 |

---

## 7. 验证路径（按本机现状可直接执行）

```bash
# 1) 目录源连通性（已实测通过）
curl -s 'https://de1.api.radio-browser.info/json/stations/search?countrycode=CN&hidebroken=true&limit=3&order=votes&reverse=true'

# 2) 纯流台可播（已实测通过：央广 / 国际台 icecast 均 200 持续出流）
curl -sI 'https://lhttp.qtfm.cn/live/15318317/64k.mp3' | head

# 3) 自动化验证
npm test                      # vitest（radio + hls 单测）
node test/hls-proto.mjs       # HLS 转流纯函数 + ffmpeg 基准对比
# 4) 手动：面板电台 tab → 搜“中国之声” → 播放（纯流 mp3 应出声）；再搜“凤凰”/“CCTV”播一个 hls:1 的台（转流出声）
```

---

## 8. 决策摘要（给实现者的速查）

1. **目录源 = radio-browser.info**（无 key、结构化、实测可达；多镜像故障转移）。
2. **纯流（mp3/aac）**：`<audio>` 直播，原生可播。
3. **HLS（中文台刚需）已并入首版**：**Host 端纯 Node 转流**（`lib/hls.js`：拉 m3u8 → 分片归一化 → 出
   ADTS 连续流，见 §5.2）——client 零改动、无新依赖、TS 与裸 ADTS 两种容器实测覆盖主流中文台；
   不支持形态（fMP4/加密 HLS）明确报错。
4. **播放一律经 `/dsh-music/radio/play` 同源代理**（CORS/防盗链/频谱兼容），且**请求流不带 ICY 元数据**。
5. **直播特判**：duration=∞ → 显示 LIVE、禁用 seek、ended 走断流重连而非下一首。
6. **收藏放本地**（`~/.dsh/music-player-radio.json`），不依赖任何远端账号（手动添加 URL 的 UI 已移除）。
7. **工具接入**：`music_play` 显式 `source='radio'` 搜电台开播（含 HLS 台）。
8. **合规**：目录 CC 数据 + 公开流，风险低于点播源；仍写免责声明（不录制分发、不绕付费墙）。

---

## 附录 A：本机实测记录（2026-09）

| 项目 | 结果 |
|---|---|
| `de1.api.radio-browser.info/json/stations/topclick/5` | HTTP 200，返回完整 station JSON（含 hls/codec/url_resolved/votes） |
| `all.api.radio-browser.info`（发现端点） | 直连 ECONNRESET → 需内置镜像数组逐个故障转移 |
| `json/stations/search?countrycode=CN&hidebroken=true` | 返回 央广 CNR-1/2、CRI 环球/英语、凤凰卫视中文/资讯、蜻蜓/喜马拉雅聚合台、CCTV-13 伴音 等（中文覆盖可用） |
| `https://lhttp.qtfm.cn/live/15318317/64k.mp3`（CNR-1 中国之声） | HTTP 200 `audio/mpeg`，持续出流（首块 5.7KB），770ms 首字节 |
| `https://icecast.walmradio.com:8443/classic` | HTTP 200 `audio/mpeg` + `icy-name: Classic Vinyl HD`，持续出流 |
| 上述 icecast 流带 `Icy-MetaData:1` 请求 | `icy-metaint: 16000`，40KB 内解析出 `StreamTitle="The Impossible Dream by Liberace…"` → **当前曲目旁路解析可行** |
| `http://ngcdn002.cnr.cn/live/jjzs/index.m3u8`（CNR-2 经济之声） | HTTP 200 `application/vnd.apple.mpegurl`，同目录相对分片简单形态 → 代理改写直接 |
| **HLS 占比（2026-09-03 实测）** | CN top200 `hls:1` 占 41.5%（votes 与 clickcount 排序一致）；全球 topvote/100 占 0% → HLS 是中文主流台问题 |
| **主流 HLS 台编码（ffprobe 实测）** | CCTV-13（myalicdn）/ 凤凰资讯（ifeng）/ 中国之声（ahbztv，master 嵌套+token）分片全部 **AAC-LC 48k stereo MPEG-TS** |
| **TS→ADTS 剥壳（纯 Node vs ffmpeg 基准）** | 三个真实分片 ADTS 帧数 **100% 对齐**（1876/140/94 = ffmpeg 1876/140/94），0 丢弃 |
| **Chromium 播裸 ADTS 连续流（headless 实测）** | chunked 流式 `audio/aac`：`playing`+`timeupdate` 正常、`readyState=4`、`duration=null`（直播特征）→ **client 零改动可播** |

> 说明：本机网络环境（macOS，直连/代理）下目录源与多数台流可达；实际用户网络可能不同，
> 因此 UI 需保留「换镜像 / 台不可播提示」，且 broken 台（`lastcheckok=0`）默认隐藏可切。
