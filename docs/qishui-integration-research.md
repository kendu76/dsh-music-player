# 接入汽水音乐 · 可行性调研报告

> 目标：评估在 dsh-music-player 中接入**汽水音乐**（字节跳动旗下音乐 App，与抖音互通）作为第三个在线来源，
> 判断其接口能力能否与现有 QQ（`lib/qq.js`）/ 酷狗（`lib/kugou.js`）实现**逐项对齐**，
> 并特别澄清「登录 / 歌单 / 歌词 / 搜索」四个核心能力的真实门槛。
>
> 方法：参考开源社区实现（guowenye/qishui-api、CharlesPikachu/musicdl 等），并**在本机对关键端点逐一实测验证**
> （见 §3，标注 ✅实测 / ⚠️受限 / ❌不通）。
>
> 结论先行：**「登录 + 歌单 + 逐字歌词 + 发现」均可行且复杂度与酷狗相当；「搜索」可行但依赖登录态或设备签名**
> （匿名空响应，见 §3.2）；**最大差异化风险在「播放」**——匿名只能拿到 30 秒试听切片（已实测），
> 完整播放必须登录且返回的是 **AES-CTR 加密音频**，需要在 Host 端解密后才能流播，
> 这是与 QQ/酷狗「直接代理 CDN 直链」最本质的区别（详见 §4.3 / §6）。

---

## 1. 结论速览

| 维度 | QQ 音乐（现状） | 酷狗音乐（现状） | 汽水音乐（调研结果） | 对齐判定 |
|---|---|---|---|---|
| 扫码登录 | ptlogin 两次换票 | 原生二维码一跳拿 token（酷狗 App） | **抖音 App 扫码**，Passport 两跳拿 sessionid | ✅ 更简单（无签名、无设备注册） |
| 搜索歌曲 | musicu 匿名 | song_search_v2 匿名 | **PC search 匿名空响应，需登录态或有效设备签名头** | ⚠️ 对齐方式不同（见 §3.2） |
| 歌单浏览（推荐/详情） | 匿名 | 匿名 | **App Luna 接口匿名可用**（discover/playlist/detail） | ✅ 更容易 |
| 我的歌单/收藏 | 需登录 | 需登录 | `/luna/pc/me/playlist`、`/me/collection/mixed`（需登录） | ✅ 需登录，未实测成功态 |
| 收藏「我喜欢」 | dirId=201 写接口 | 默认歌单 add_song 模拟 | **无明确红心接口，需进一步调研** | ⚠️ 缺口 |
| 普通歌词 | fcg LRC | 同端点 fmt=lrc | 分享页 `sentences`（含翻译行）；H5 `lyric.content` | ✅ |
| **逐字歌词** | QRC（3DES+zlib） | KRC（XOR+zlib） | **`[60,1470]<0,350,0>字…` 与 KRC 同构**（H5 seo_track 匿名可得） | ✅ 复杂度最低、零适配 |
| 播放 URL | 登录后 vkey | 登录后 tracker（必登录） | **匿名=30s 试听切片；完整=加密音频需 Host 解密** | ❌ 最大差异（见 §4.3） |
| 排行榜/新歌 | 匿名榜单 | 匿名 57 榜 | **无清晰榜单接口**，发现走 feed/歌单 | ⚠️ 有差异 |
| 登录态存储 | `~/.dsh/music-player-qq-cookie.json` | `~/.dsh/music-player-kugou-cookie.json` | `sessionid` Cookie 存 Host 即可 | ✅ 同构 |

> 一句话：**除「播放加密」外，其余能力接入成本 ≤ 酷狗；「播放加密」是本项目要额外啃的硬骨头。**

---

## 2. 参考（来源）仓库

| 仓库 | 语言 | 价值定位 |
|---|---|---|
| [guowenye/qishui-api](https://github.com/guowenye/qishui-api) | Node.js | **最完整、与本项目最同构**：抖音扫码登录、PC 搜索、歌单/电台/发现、分享页解析、逐字歌词、`spade_a` 解密与 AES-CTR 音频解密。README 能力表逐项标注「已验证」，含 live smoke 测试 |
| [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl)（`modules/sources/soda.py`） | Python | 独立印证：LunaPC 搜索参数、分享页试听链、`track_v2` → `url_player_info` → `PlayInfoList`（MainPlayUrl+PlayAuth）取链、`AudioDecryptor` 解密；**明确区分匿名试听（无损直链够用）/ 登录 VIP（PlayAuth 加密）** |
| [xuanlove.cn PHP 工具箱](https://www.xuanlove.cn/myworks/2104.html) | PHP | 汽水/QQ/网易三源解析下载，佐证分享页/H5 取链路线 |
| bbs.binmt.cc 汽水解密算法帖 | - | `encrypt_info`/`spade_a` 逐层拆解演示（仅供安全研究参考） |

（抖音侧通用签名 `X-Gorgon/X-Argus` 与「六神签名」工具包**本项目不需要**——汽水 Passport/Luna App/H5 接口均未强制要求该签名，见 §4.1/§4.2。）

---

## 3. 本机实测记录（2026-09-02，佐证下述结论）

### 3.1 域名与通道

```
PC 接口    https://api.qishui.com        （LunaPC UA + 可选 X-Helios/X-Medusa + Cookie）
App 接口   https://beta-luna.douyin.com   （Luna/19.1.0 Android UA，匿名即可用大部分）
分享页     https://music.douyin.com/qishui/share/track?track_id=<id>
H5 接口    https://beta-luna.douyin.com/luna/h5/seo_track?track_id=<id>&device_platform=web
音频 CDN   v5-se-ex-mc-luna.douyinvod.com / v3-luna.douyinvod.com / vod-luna.douyin.com
```

### 3.2 实测矩阵

| 实验 | 结果 |
|---|---|
| `GET music.douyin.com/qishui/share/track?track_id=7079108541549643812` | ✅ HTTP 200；`_ROUTER_DATA.loaderData.track_page.audioWithLyricsOption` 含 `trackName/artistName/track_id/vid/duration/url(试听CDN)/coverURL` + `trackInfo{album,artists}` + `lyrics.sentences[]`（55 句，逐字 `{startMs,endMs,text,words[]}`） |
| 试听 URL 直连（无 Cookie） | ✅ HTTP 206 `audio/mp4`，`ftypM4A`+`moov` 在前、Range 支持；**但 ffprobe 实测 `duration=30.000s`、~130kbps（487KB）**——只是 30 秒试听切片，且 `audition_info{start_time_ms:143808}` 表明切片取**歌曲中段** |
| `GET api.qishui.com/passport/web/get_qrcode/`（aid=386088） | ✅ HTTP 200；返回 `data.token`、**`data.qrcode`（内嵌 base64 PNG）**、`data.qrcode_index_url`、`expire_time`；文案要求「**抖音 APP**」扫码；下发了 `passport_csrf_token` Cookie |
| `POST api.qishui.com/passport/web/check_qrconnect/`（form 带 token） | ✅ HTTP 200 `{"data":{"status":"new"}}`（等待扫码）；按社区实现，抖音扫码确认后返回成功并 `Set-Cookie: sessionid=…` |
| `POST beta-luna.douyin.com/luna/discover` | ✅ HTTP 200，`blocks` 含 `discover_playlist_mix`/`discover_radio` → **推荐歌单/电台匿名可用** |
| `POST beta-luna.douyin.com/luna/playlist/detail`（playlist_id） | ✅ HTTP 200，`playlist{id,title,url_cover}` + `media_resources[]` + `has_more/next_cursor`（分页）匿名可用 |
| `GET beta-luna.douyin.com/luna/h5/seo_track?track_id=…&device_platform=web` | ✅ HTTP 200，匿名返回 `lyric.content`（**KRC 同构逐字格式** `[60,1470]<0,350,0>不…`，53 行）+ `track_player.url_player_info`（AWS4 签名 VOD 取链）+ `seo_track.track{id,name,duration,audition_info,preview,bit_rates,playable_range,album,artists}` |
| `GET <url_player_info>`（GetPlayInfo） | ⚠️ HTTP 200 但 `PlayInfoList` 仅 2 档（65kbps/247KB、130kbps/487KB），**均为 30s 试听切片，`PlayAuth:false`**；`EncryptionMethod/PlayAuthID` 字段存在（登录后同端点才会给完整+加密档） |
| `POST beta-luna.douyin.com/luna/media-player` | ❌ HTTP 200 但 `status_code:1000062「应用版本有风险」`——需 App 设备上下文（未带有效设备指纹） |
| `GET api.qishui.com/luna/pc/search/track?q=晴天&…`（LunaPC UA，无 Cookie） | ❌ HTTP 200 **空 body**；加 musicdl 里的示例 `X-Helios/X-Medusa` 仍空；换随机 `device_id/iid` 仍空（需有效设备三元组或登录态） |
| `GET api.qishui.com/luna/pc/me/playlist`（无 Cookie） | ⚠️ HTTP 200 但 `status_code:1000016 登录状态已失效`（需登录） |
| `GET api.qishui.com/luna/pc/me/collection/mixed`（无 Cookie） | ⚠️ 同上，需登录 |

> 说明：本机 curl/Node 直连可达上述域名（web_fetch 因代理 fake-ip 被 SSRF 拦，属环境因素，不影响结论）；
> 抖音扫码登录、登录态搜索、登录态完整播放、我的歌单成功态**需真实抖音账号扫码，本调研未做**（依赖社区已验证实现）。

---

## 4. 技术细节：四个核心能力逐项拆解

### 4.1 登录（比 QQ/酷狗都简单，✅ 可行）

| 步骤 | 端点 | 说明 |
|---|---|---|
| ① 出二维码 | `GET https://api.qishui.com/passport/web/get_qrcode/?passport_jssdk_version=2.4.13&passport_jssdk_type=normal&is_from_ttaccountsdk=1&aid=386088&next=https%3A%2F%2Fapi.qishui.com&need_logo=false&need_short_url=false&is_new_login=1`（普通 Chrome UA） | 返回 `data.token`（形如 `…_lq`）、**`data.qrcode`=内嵌 base64 PNG（可直接渲染，无需拼图 URL）**、`data.qrcode_index_url`、`expire_time`；下发 `passport_csrf_token` Cookie（轮询要带上） |
| ② 轮询 | `POST https://api.qishui.com/passport/web/check_qrconnect/?…`（form：`token` + 固定参数 + `passport_csrf_token` Cookie） | 状态 `new`（等待）/ `confirm`（已扫）/ 成功时**返回 `Set-Cookie: sessionid=…`** |
| ③ 使用 | 之后业务请求带 `Cookie: sessionid=…`（个人歌单/收藏/完整播放/登录态搜索） | 与酷狗 token 同构，存 Host `~/.dsh/music-player-qishui-cookie.json`（0600）即可 |

要点：
- **必须用「抖音 APP」扫码**（出码文案明确要求；用汽水音乐 App 可能不确认）。前端的扫码引导文案要写清楚。
- 无需 X-Gorgon/X-Argus、无需设备注册、无需签名盐——比酷狗的 `r_register_dev + Android 网关签名` 还轻。
- 登录态持久化只存 `sessionid` 一条即可，`passport_csrf_token` 仅在出码/轮询当次使用。
- **登录态生命周期**：`sessionid` **无官方刷新接口**（不像酷狗有 `login_by_token` 静默续期），过期/失效后只能重新扫码；
  实现时遇 `1000016` 即判定失效、清 Cookie 并引导重扫（参照酷狗 `kgLoginDead` 的处理，见附录 A）。

### 4.2 搜索（✅ 可行，但**匿名不可用**，⚠️ 需登录态或设备签名头）

- 接口：`GET https://api.qishui.com/luna/pc/search/track`（歌曲）/ `…/search/mixed`（混合）/ `…/search/playlist`（歌单搜索）
- 参数：`aid=386088`、`app_name=luna_pc`、`region=cn`、`device_id`、`iid`、`fp`、`version_name`、`cursor`、`q`、`search_id` 等（完整参数见 [qishui-api `pcSearchParams`](https://github.com/guowenye/qishui-api/blob/main/src/qishuiClient.js)）
- 头：`User-Agent: LunaPC/3.x` +（建议）`X-Helios` / `X-Medusa` +（登录后）`Cookie: sessionid`
- **实测匿名返回 HTTP 200 空 body**（含用 musicdl 示例 X-Helios/X-Medusa、随机新设备均空）。结论：搜索需要
  - 方案 A（推荐）：**登录态**——带 `sessionid` Cookie 搜索（qishui-api README 亦注明「可能需要 Cookie 或签名 header」）；
  - 方案 B：**有效设备三元组** `(device_id, X-Helios, X-Medusa)`——从 LunaPC 网页/客户端抓取，未登录也能搜（musicdl 即此路线），但三元组会轮换/封禁，维护成本高。
- 搜索结果结构：`result_groups[].data[]` → `entity.track{id,name,artists,album,duration}` / `entity.playlist`（musicdl 与 qishui-api normalizers 结构一致）。

### 4.3 播放（✅ 有路可走，但**加密是硬门槛**，❌ 与 QQ/酷狗本质不同）

**匿名态：只有 30 秒试听切片**
- 分享页 `audioWithLyricsOption.url` 或 H5 `track_player.url_player_info → GetPlayInfo → PlayInfoList` 拿到的都是 **30s 中段切片**（实测 65/130kbps 两档、`PlayAuth:false`、不加密、moov 在前、Range 可用）。
- 切片从歌曲中段截取（`audition_info.start_time_ms≈143808`），**不能当完整歌曲播放**。

**登录态：完整歌曲，但返回 AES-CTR 加密音频**
- 取链：`POST https://api.qishui.com/luna/pc/track_v2`（PC，body `{media_type:"track", queue_type, scene_name, track_id}`）→ `track_player.url_player_info` → `GetPlayInfo` → `PlayInfoList[]`，登录后含完整档（如 `highest` 260kbps，`Bitrate/Size/MainPlayUrl/BackupPlayUrl`）+ **`PlayAuth`**（内含 `spade_a` 密文）。
  （App 侧另有 `POST beta-luna.douyin.com/luna/media-player`，实测需 App 设备上下文，暂不作为首选。）
- **加密形态**：MP4 **CENC 加密**（`senc` 逐样本 IV、`enca` 加密音轨、`stco` 偏移），外层是自定义 `spade_a`（base64）经 [qishui-api `audioDecryptor.js`](https://github.com/guowenye/qishui-api/blob/main/src/audioDecryptor.js) 的两段变换还原 32 位 AES-128 密钥；每样本用各自 8 字节 IV 补齐 16 字节做 **AES-CTR** 解密；解密后重写 `moov/stsd/stco`、剔除 `senc/enca` 等 box，输出**明文 m4a**（若 stsd 含 `dfLa` 则输出 **flac**）。
- **对本项目的影响**：`<audio>` 只能播明文。因此完整播放必须走「Host 取链 → Host 解密 → 明文重流回浏览器」。
  - 最简单可落地的形态：**整文件解密后以明文流回**（一首歌 ~10MB，Node 内存可承受；qishui-api 已是整文件 base64 方案）；
  - 若要支持拖动/续播的 Range，需在 `stco` 重写时把偏移按需调整、并按请求区间仅解密对应样本段（AES-CTR 可随机访问，理论可行，但要写流式/分片解密，工作量集中在 `lib/qishui.js` + 一个新 `lib/qishui-decrypt.js`）。
  - **本项目现有 `/dsh-music/qq/play/<mid>`、`/dsh-music/kg/play/<hash>` 的「Host 代理流播」骨架可完全复用**——差别只在代理上游从「CDN 直链」变成「本地解密后的明文」。

### 4.4 歌词（✅ 最大亮点，几乎零适配）

- **逐字歌词匿名可得**：`GET https://beta-luna.douyin.com/luna/h5/seo_track?track_id=<id>&device_platform=web` 的 `lyric.content` 为
  `[起始ms,时长ms]<字内偏移ms,字时长ms,_>字…` —— **与酷狗 KRC 完全同构**，可映射到现有 `{t,end,text}` 行模型（+words），`lib/lyric.js` 编排层零改动接入（现有 `lib/krc.js`/`lib/qrc.js` 已消费同形状）。
- 分享页 `audioWithLyricsOption.lyrics.sentences[]` 也带逐字 `words[]` + 翻译行（`text` 形如「作曲：陈粒」等元信息行需按现有 `isMetadataLine` 过滤逻辑剔除）。
- 在线兜底链可插入：QQ → 酷狗 → **汽水** → LRCLIB。

### 4.5 歌单（✅ 浏览匿名可用；我的歌单/收藏需登录；⚠️ 写操作缺接口）

| 能力 | 端点 | 登录 | 实测 |
|---|---|---|---|
| 推荐歌单 | `POST beta-luna.douyin.com/luna/discover`（blocks→playlist_mix） | 否 | ✅ |
| 歌单详情+歌曲 | `POST beta-luna.douyin.com/luna/playlist/detail`（`playlist_id/cursor/count`） | 否 | ✅ |
| 歌单媒体流分页 | `POST /luna/feed/playlist-media` | 否 | 社区✅ |
| 我的歌单 | `GET api.qishui.com/luna/pc/me/playlist` | 是 | ⚠️未登录拒 |
| 我的收藏（混合） | `GET api.qishui.com/luna/pc/me/collection/mixed` | 是 | ⚠️未登录拒 |
| 歌单搜索 | `GET api.qishui.com/luna/pc/search/playlist`（/mixed 兜底） | 需登录/签名 | ⚠️同搜索 |
| **建/删歌单、加/删歌、红心收藏** | **qishui-api/musicdl 均未实现** | 需登录 | ❌ 需进一步调研 |

- 汽水更偏「feed/歌单」消费模型，**没有传统意义的「排行榜/新歌速递」独立接口**（发现即 `discover` 的推荐歌单/电台块）。
- 「我喜欢」红心：社区实现均未覆盖，若要做播放条爱心，可退化为**本地「我最喜欢」歌单**（与现有自建歌单机制天然兼容），或后续调研 `/luna/pc/me/collection/*` 的写操作。

---

## 5. 若立项实施：建议工程结构（与 QQ/酷狗镜像，供排期参考）

```
lib/qishui.js        —— 对标 lib/qq.js / lib/kugou.js：createQRLogin/checkQRLogin/
                        search/searchMixed/searchPlaylist/getPlaylistDetail/getDiscover/
                        getMyPlaylists/getMyCollections/getWordLines(H5逐字)/
                        getDownloadURL(track_v2→GetPlayInfo→PlayAuth)…
lib/qishui-decrypt.js —— spade_a 还原 AES 密钥 + CENC(AES-CTR) 整文件/分片解密（输出明文 m4a/flac；
                        算法可直接移植 qishui-api audioDecryptor.js，纯 node:crypto）
lib/index.js         —— 路由镜像 /dsh-music/qy/*（login/start|check|logout、search、play/<track_id>、
                        lyric、playlists、playlist/<id>、my-playlists、discover）
cookie 存储          —— ~/.dsh/music-player-qishui-cookie.json（sessionid，0600）
lib/client.js        —— 侧边栏新增「汽水音乐」页签（tabBtn('qy','汽水音乐')，与 qq/kg 同构）；
                        抖音扫码登录 → 推荐歌单/发现/搜索/我的歌单/播放/逐字歌词面板
test/qishui*.test.js —— 纯函数级用例：share 页解析、spade_a 解密向量、CENC 解密（可用样例密文固化）
```

分期建议：
- **P0（半日）**：分享页/H5 匿名能力跑通（曲目元数据 + 逐字歌词 + 试听链）——可先做「本地音乐无 .lrc 时的汽水逐字歌词兜底」尝到甜头；
- **P1（核心，1~2 天）**：抖音扫码登录 + 发现/歌单详情 + 我的歌单 + 搜索（登录态）；播放先落「登录完整档 + Host 整文件解密重流」（不做拖动 Range 也能听）；
- **P2（打磨）**：`spade_a`/CENC 分片解密 + Range 拖动续播、播放队列/进度独立持久化、歌曲页展示、歌词面板逐字扫色；
- **P3（可选）**：红心收藏（本地兜底或调研写接口）、feed/电台。

---

## 6. 缺口与风险清单

| # | 差异/风险 | 影响 | 缓解建议 |
|---|---|---|---|
| 1 | **匿名播放只有 30s 试听切片**（实测） | 未登录无法听完整歌曲，体验断崖 | UI 沿用「未登录只能浏览 + 扫码解锁」模式；明确提示试听为 30s 片段 |
| 2 | **完整歌曲为 CENC 加密**（spade_a→AES-CTR） | `<audio>` 不能直连，需 Host 解密重流，是唯一超 QQ/酷狗的工作量 | 移植 qishui-api audioDecryptor.js；P1 先整文件解密，P2 再分片+Range |
| 3 | **搜索匿名空响应** | 未登录搜索不可用 | 登录态搜索为主；暂不维护 X-Helios/X-Medusa 设备三元组（易轮换/封禁） |
| 4 | 红心收藏/歌单写操作无社区实现 | 播放条爱心、「我的歌单」写操作可能缺失 | 爱心退化为本地「我最喜欢」；写操作列为 P3 调研 |
| 5 | 无传统排行榜/新歌接口 | 面板「排行榜/新歌」子页签无法直接照搬 | 用「推荐歌单/发现/电台」替代；或后续单独调研榜单端点 |
| 6 | 登录用**抖音 App**扫码（非汽水 App） | 用户可能误拿汽水 App 扫 | 登录页/文案明确「请用抖音 APP 扫码」；提供二维码 base64 直接渲染 |
| 7 | 分享页/H5 接口改版快 | 取词/试听可能随前端改版失效 | 词/试听仅作兜底；完整播放走 track_v2 官方链路；容错降级 |
| 8 | 法律/合规与 ToS（非官方接口 + 加密规避 + 流播版权音乐） | 同 QQ/酷狗 | 沿用现有免责声明章节，汽水纳入同一「个人学习/试听」范围，加密解密仅限已授权内容 |
| 9 | 域名多、UA 区分（PC/App/H5） | 请求层要按接口选 UA | 收敛到 `lib/qishui.js` 一个 request 层，按 host+path 选 UA（可参考 kugou 的 gateway 分层做法） |

---

## 7. 与 QQ/酷狗实现的对比（接入成本参照）

| 环节 | 汽水 vs 酷狗 |
|---|---|
| 登录 | **更简单**：Passport 两跳（出码→轮询拿 sessionid），无设备注册/签名；唯一样化是「抖音 App 扫」 |
| 搜索 | **更麻烦**：酷狗匿名可用，汽水需登录态；同需 Host 代理 + 参数组装 |
| 歌单 | 同量级：浏览匿名（汽水是 App Luna 接口）；我的歌单需登录 |
| 歌词 | **更简单**：H5 直接给 KRC 同构逐字，无需解密步骤（酷狗 KRC 还要 XOR+zlib） |
| 播放 | **更麻烦**：酷狗只是「必登录+签名取链、拿到明文直链」；汽水登录后拿到的还是**加密**，要 Host 解密 |
| 持久化/UI | 完全同构：cookie 文件 + `/dsh-music/*` 路由 + 侧边栏 tab + 播放队列本地持久化 |

---

## 8. 合规提示

与 QQ/酷狗在线功能相同：本文所述均为非官方接口，涉及平台版权内容与加密技术，**仅限个人学习、技术研究、
日常试听**；严禁商业用途、内容再分发、批量抓取与版权规避；账号风控/法律风险由使用者自行承担。
正式落地时应随附与 `online-music-feasibility.md` 相同的使用声明，并明确「解密能力仅用于处理已获授权的内容」。

---

## 附录 A：接口错误码速查（实测/社区已知）

| code | 含义 | 触发场景 | 处理建议 |
|---|---|---|---|
| `0` | 成功 | QR 出码 `data.error_code` | — |
| `1000004` | `ERR_INVALID_PARAM` 参数非法 | `search/mixed` 缺有效设备上下文/签名头 | 换登录态或补设备三元组 |
| `1000016` | 登录状态已失效 | 我的歌单/收藏/完整播放未带或过期 `sessionid` | 判定登录失效→清 Cookie→引导重扫 |
| `1000062` | 应用版本有风险 | `/luna/media-player` 无有效 App 设备上下文 | 改用 PC `track_v2` 链路 |
| `1000006` | （需 App 上下文类） | `daily-mix` 等裸调 | 按需降级为 discover 替代 |

## 附录 B：开发调试样例（本机复现用，2026-09-02 实测可用）

```bash
# ① 分享页（曲目元数据 + 试听链 + 逐字 sentences）
curl 'https://music.douyin.com/qishui/share/track?track_id=7079108541549643812'

# ② H5 逐字歌词 + url_player_info（匿名，KRC 同构）
curl -H 'User-Agent: Luna/19.1.0 Android' \
  'https://beta-luna.douyin.com/luna/h5/seo_track?track_id=7079108541549643812&device_platform=web'

# ③ 发现页（推荐歌单/电台，匿名）
curl -X POST -H 'User-Agent: Luna/19.1.0 Android' -H 'Content-Type: application/json' -d '{}' \
  'https://beta-luna.douyin.com/luna/discover'

# ④ 歌单详情（匿名，分页）
curl -X POST -H 'User-Agent: Luna/19.1.0 Android' -H 'Content-Type: application/json' \
  -d '{"playlist_id":"7096700219496368135","count":5}' \
  'https://beta-luna.douyin.com/luna/playlist/detail'

# ⑤ 抖音扫码（出码，内嵌 base64 PNG + token）
curl 'https://api.qishui.com/passport/web/get_qrcode/?passport_jssdk_version=2.4.13&passport_jssdk_type=normal&is_from_ttaccountsdk=1&aid=386088&next=https%3A%2F%2Fapi.qishui.com&need_logo=false&need_short_url=false&is_new_login=1'
```

样例 ID：`track_id=7079108541549643812`（小半 / 陈粒，297s，audition 切片 30s@143808ms）、
`playlist_id=7096700219496368135`（「日本乐队| 劲酷の霓虹全女子摇滚乐」）。验证命令 `npm run smoke:live` 同款思路见 [qishui-api test/live-smoke.js](https://github.com/guowenye/qishui-api/blob/main/test/live-smoke.js)。

## 参考链接汇总

- https://github.com/guowenye/qishui-api（src/qishuiClient.js、src/audioDecryptor.js、src/routerData.js、test/live-smoke.js）
- https://github.com/CharlesPikachu/musicdl/blob/master/musicdl/modules/sources/soda.py（LunaPC 搜索参数、track_v2→GetPlayInfo 取链、PlayAuth 解密）
- https://www.xuanlove.cn/myworks/2104.html（PHP 三源解析工具，佐证分享页/H5 路线）
- https://bbs.binmt.cc/thread-167319-1-1.html / thread-167353-1-1.html（encrypt_info/spade_a 拆解，仅供安全研究）
