# 接入网易云音乐 · 可行性调研报告（未实施，仅调研）

> 目标：评估在 dsh-music-player 中接入**网易云音乐**作为第三个在线来源，
> 判断其接口能力能否与现有 QQ 音乐（`lib/qq.js`）/ 酷狗（`lib/kugou.js`）实现**逐项对齐**，
> 重点关注登录、歌单、歌词、搜索四项能力。
>
> 方法：通读本仓库现有双源实现与调研文档；逐行核对开源社区实现
> （**guohuiyuan/music-lib 的 netease/ 包** —— 本项目 QQ/酷狗移植的同源参考库、
> Binaryify/NeteaseCloudMusicApi 原版及其社区继任者 api-enhanced）；
> 并在本机对关键端点逐一实测验证（§3 标注 ✅实测，探针脚本保留在 `/tmp/dsh-ncm-probe/ncm-probe*.mjs`
> —— 零依赖纯 Node、三套加密已跑通，可直接作为实施阶段的移植底稿）。
>
> 结论先行：**四项核心能力全部可对齐，且是三个源里门槛最低的**——加密体系纯 `node:crypto` 即可实现
> （无需 3DES/QRC 那类自定义解密）、扫码登录两跳直达 MUSIC_U、搜索/歌词/歌单/取链匿名即可用。
> 主要不确定点集中在「登录态高音质取链」与「YRC 逐字歌词」，需登录后复测（§5/§6）。

## 0. 与现有双源的能力对照速览

| 维度 | QQ 音乐（现状） | 酷狗（现状） | **网易云（本次调研）** | 对齐判定 |
|---|---|---|---|---|
| 搜索歌曲 | 匿名可用 | 匿名可用 | 匿名可用（linuxapi `/api/cloudsearch/pc`；weapi `/weapi/search/get` 双路均通） | ✅ |
| 搜索分型（专辑/歌手/歌单/MV） | 歌单可搜 | 歌单可搜 | ✅ type=10/100/1000/1004 全通（1002 用户被门禁） | ✅ 更全 |
| 播放 URL | 需登录态取链，免费歌未登录部分可播 | **必须登录** | **匿名即可播**：免费歌 320k 直链 ✅；VIP 歌匿名给 45 秒试听 ✅；版权受限歌 404 | ✅ 最宽松 |
| 高音质/VIP | 登录后无损档 | 登录后 qualities 全档 | 登录后 weapi `br=999000`（待复测）；社区继任者已把 url/v1 迁到 **xeapi** 新协议（匿名 eapi v1 实测被拒，与「端点迁移」互证） | ⚠️ 待复测 |
| 扫码登录 | ptlogin + 二次 OAuth 换 musickey（最繁琐，需大陆 IP） | 设备注册 + 一跳 token | **两跳**：unikey 出码 → 轮询 803 直接 Set-Cookie `MUSIC_U`（无设备注册、无二次换票、各地可达） | ✅ 最简 |
| 普通歌词 | LRC + 逐句翻译 | LRC/KRC | 匿名 GET `/api/song/lyric` → LRC + 翻译 ✅ | ✅ |
| **逐字歌词** | QRC（3DES+zlib） | KRC（XOR+zlib） | YRC（`yv` 参数，明文行文本）；**匿名抽样 8 首均为空，需登录复测** | ⚠️ 待复测 |
| 歌词翻译 | trans 逐句 | KRC 内嵌 | tlyric 独立字段 ✅（实测 719 字符）+ romalrc | ✅ |
| 推荐/分类歌单/榜单 | 匿名 | 匿名 | 匿名 ✅（personalized/playlist、playlist/list、catalogue、toplist 63 榜） | ✅ |
| 歌单详情 | 全量一次返回 | 分页 300 | v6 详情带 tracks + trackIds；**超大歌单走 trackIds → v3/song/detail 批量（500/批）** | ✅（多一步批查） |
| 我的歌单 | 需登录 | 需登录 | `/weapi/user/playlist?uid=` 按 uid 取（实测匿名传任意 uid 也返回公开歌单），自己的 uid 从登录态拿 | ✅ |
| 建/删歌单、加/删歌 | 需登录，社区已打通 | 需登录，社区已打通 | 需登录，社区已打通（playlist/create/delete/manipulate tracks），本次未实测 | ✅（社区验证充分） |
| 每日推荐/私人FM | — | — | 登录特性；匿名调 `/weapi/v3/discovery/recommend/songs` 返回 200 但无个性化内容 | ⚠️ 登录后可用 |
| 合规风险 | 非官方接口 | 非官方接口 + SSA 风控 | 非官方接口；删库事件（作者 2024-01 主动清库）后社区生态由 api-enhanced 等接棒、依旧活跃；个人自用风险同前两源 | ⚠️ 同级 |

---

## 1. 参考仓库与生态现状（「删库事件」后的社区格局）

| 仓库/包 | 语言 | 状态与价值 |
|---|---|---|
| [guohuiyuan/music-lib](https://github.com/guohuiyuan/music-lib) `netease/` 包 | Go | **本次主参考**（本项目 QQ/酷狗移植的同源库，活跃维护）。crypto/login/account/song/download/lyric/playlist/user_playlist 七个文件正好覆盖本项目所需；其扫码走 `interface.music.163.com` 裸表单（type=3），搜索走 linuxapi，取链 weapi 兜底 + VIP 时 eapi v1 |
| [NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | Node.js/TS | **Binaryify 原版的主力继任者**（持续维护，1700+ star，MIT）。npm `@neteasecloudmusicapienhanced/api`、Docker `moefurina/ncm-api`、中文文档齐全；已逆向 **xeapi 新协议**（url/v1、游客注册等接口已迁移），并跟进 `X-antiCheatToken` 反作弊头。本项目不引入其运行时，但**端点漂移以此为风向标** |
| Binaryify/NeteaseCloudMusicApi（原版） | Node.js | 历史上最权威的实现（约 3 万 star）。**2024-01-24 作者主动清空仓库**（仅留「保护版权，此仓库不再维护」README），2024-02 归档；媒体披露网易方曾提侵权诉求，但**无 GitHub 官方 DMCA 下架记录**（本次已核实 raw 源码 404）。其接口语义与加密算法仍是全社区的事实标准 |
| npm `NeteaseCloudMusicApi`（无 scope 同名包） | Node.js | 「备份续发」性质：代码为原版 v4 基线（4.32.0 一线），由社区沿用原账号发版；仅作老代码兼容参考 |
| [nooblong/NeteaseCloudMusicApiBackup](https://github.com/nooblong/NeteaseCloudMusicApiBackup)、[ILoveScratch2/NeteaseCloudMusicAPI-Mirror](https://github.com/ILoveScratch2/NeteaseCloudMusicAPI-Mirror) | Node.js | 原版删除前的代码备份/快照（本次 `util/crypto.js` 常量从镜像核对） |
| [xgxdmx/NeteaseMusic-API](https://github.com/xgxdmx/NeteaseMusic-API)、[Catamint/ncm-api-enhanced](https://github.com/Catamint/ncm-api-enhanced) | Node.js | api-enhanced 系的个人增强 fork（自 v4.28.0 起自维护） |
| pyncm（Python，活跃 fork lixvbnet/pyncm）/ Music163Api-Go (Go) / listen1 | 多语言 | 加密与端点的独立互证实现 |

**对依赖路线的启示**：与酷狗调研同结论 —— 本项目坚持「零第三方依赖、纯 Node 移植算法」，不引入上述任何包作为运行时依赖；它们只作为端点语义与算法的参考（音乐平台非官方接口生命线短，自持代码才可控、可修）。若未来协议大幅漂移（如 xeapi 全面铺开），再评估「进程内嵌入 api-enhanced」或「对接其 Docker 镜像」作为降级方案。

---

## 2. 技术细节：加密体系（接入的核心门槛，纯 node:crypto 可覆盖）

网易云现行三套请求封装，**全部可用 Node 内置 crypto 实现，无任何第三方依赖**（已在探针中验证可用）：

### 2.1 weapi（网页端主力，覆盖本项目全部匿名/登录态需求）

```
text      = JSON.stringify(业务参数)
secret    = 16 位随机 [A-Za-z0-9]
params    = base64( AES-128-CBC( base64( AES-128-CBC(text, key='0CoJUm6Qyw8W8jud', iv='0102030405060708') ),
                                    key=secret, iv='0102030405060708' ) )
encSecKey = RSA 无填充加密( reverse(secret) )，公钥固定（modulus 00e0b5…b8e7，exponent 010001），输出 256 位 hex
POST 表单  params=<encodeURIComponent(params)> & encSecKey=<hex>
请求头     Referer: http://music.163.com/  +  浏览器 UA
```

RSA 无填充 = `m^e mod n`（m 为反转后 secret 的字节大整数），10 行 BigInt 即可实现，无需 node-forge；探针即按此实现并全部请求成功。
实测要点：**完全不带 Cookie 头也能匿名调用**（§3 N5）；带 `os=pc; appver=…` cookie 是社区惯例，非必需。

### 2.2 linuxapi（Linux 客户端协议 —— 本次搜索实测主路）

```
eparams = hex大写( AES-128-ECB( JSON{method:'POST', url:'http://music.163.com/api/cloudsearch/pc',
                                 params:{s,type,offset,limit}}, key='rFgB&h#%2?^eDg:Q' ) )
POST http://music.163.com/api/linux/forward   表单字段 eparams
```

### 2.3 eapi（客户端协议，高音质取链备用路）

```
text    = JSON(业务参数)（含 header: {os:'pc', appver:…} 设备头）
message = `nobody${url}use${text}md5forencrypt`
data    = `${url}-36cd479b6b5-${text}-36cd479b6b5-${md5(message)}`
params  = hex大写( AES-128-ECB(data, key='e82ckenh8dichen8') )
POST https://interface3.music.163.com/eapi/…
```

⚠️ **实测坑位**：匿名态调 eapi（v1/老版、ids 数组/字符串、form/json 各组合）一律返回 `{"code":404,"message":"接口未找到！"}`——匿名/无设备上下文的 eapi 请求被直接门禁。生态调研给出佐证：**`song/enhance/player/url/v1` 等接口在新版客户端已迁移到 xeapi 协议**（api-enhanced 已用 xeapi 调 url/v1 与游客注册），eapi v1 这条路事实上在废弃。与 music-lib「仅 VIP 登录态走 eapi」的策略互证：**eapi 只作为登录态高音质路线的复测项，MVP 不依赖**。

### 2.4 xeapi（2024-25 新协议 —— 只需了解，MVP 不实现）

新版客户端协议：X25519 ECDH 会话 + AES-128-GCM，请求体为 `B/S/R` 三段 base64，会话密钥经响应头 `x-encr-ssid/x-encr-sskey` 下发复用，且依赖启动时向服务端拉取公钥。api-enhanced 已逆向实现（`util/crypto.js` 的 `xeapi()`），目前仅少数接口必须走它（url/v1 的新 level 语义、游客注册 `/api/register/anonimous`）。**自建项目把它当黑盒依赖即可，不必自己实现**；若未来 weapi 老接口全面收缩，再评估「进程内嵌入 api-enhanced」的降级路线。

### 2.5 大数/精度注意

与 QQ 微信登录 `musicid` 超过 2^53 同理：网易云的歌单 id、用户 uid 也可能超出 JS 安全整数
（如实测歌单 `14299671640` 尚安全，但 trackIds/uid 大户会越线）。**沿用 `lib/qq.js` 的 `parseJsonPreserveBigInt`** 或全程按字符串处理即可，无新增风险。

---

## 3. 本机实测记录（2026-09-02，佐证下述结论）

探针脚本：`/tmp/dsh-ncm-probe/ncm-probe.mjs`、`/tmp/dsh-ncm-probe/ncm-probe2.mjs`（零依赖纯 Node，已按 §2 实现三套加密）。

| # | 实验 | 结果 |
|---|---|---|
| A | weapi `/weapi/login/qrcode/unikey`（type=1） | ✅ `{code:200, unikey:"…"}` 出码成功 |
| B | weapi `/weapi/login/qrcode/client/login`（未扫轮询） | ✅ `code 801「等待扫码」` |
| N1 | interface.music.163.com `/api/login/qrcode/unikey`（**裸表单** type=3 + `NeteaseMusicDesktop/3.0.18` UA） | ✅ 同样出码成功 —— 登录链路连加密都不需要 |
| C1 | linuxapi `/api/cloudsearch/pc`（搜「晴天 周杰伦」） | ✅ songCount=251，带 `fee/pl/dl` 特权字段 |
| C2 | weapi `/weapi/cloudsearch/get/web` | ❌ `code 50000005` —— **该老端点匿名已废**（大量旧教程仍引用，勿走弯路） |
| C3 | weapi `/weapi/search/get`（经典搜索） | ✅ 仍匿名可用（与 C1 互为备份） |
| C-x | linuxapi 分型搜索 type=10/100/1000/1004 | ✅ 专辑/歌手/歌单/MV 全通；type=1002 用户搜索返回空（门禁，本项目不需要） |
| D | GET `/api/song/lyric?id=186016&lv=-1&tv=-1` | ✅ 匿名 LRC 1390 字符 + tlyric 翻译 |
| E | weapi `/weapi/song/lyric`（lv/tv/rv/yv=-1） | ✅ 200；晴天 tlyric 719 字符；两首样本 yrc 均空 |
| E2 | weapi `/weapi/song/lyric/v1`（lyric_new 参数组） | ✅ 200；返回新 JSON-flavor lrc + klyric + romalrc 字段；抽样 6 首 yrc 仍空 |
| F1 | weapi `/weapi/song/enhance/player/url`（免费歌，匿名） | ✅ **直链 320k mp3**（level=exhigh，CDN m701.music.126.net） |
| F2 | 同上（周杰伦《晴天》，版权受限对照） | ❌ `url:null, code:404` —— 灰色歌曲匿名不可播 |
| N4 | 同上（fee=1 VIP 歌，匿名） | ✅ 返回试听直链 + `freeTrialInfo{start:0,end:45}`（**45 秒试听**） |
| N5 | 同上（免费歌，**完全无 Cookie 头**） | ✅ 仍 320k —— 匿名取链不依赖任何 cookie |
| G/N2 | eapi `/eapi/song/enhance/player/url(/v1)`（匿名各变体） | ❌ `404「接口未找到」` —— 网关门禁；生态调研证实 url/v1 已迁 xeapi，eapi 该路事实废弃，登录态复测后取舍 |
| H | weapi `/weapi/v6/playlist/detail`（id=3778678 热歌榜，n=10） | ✅ 元数据 + trackIds 200 + tracks 10 |
| H2 | weapi `/weapi/v3/playlist/detail`（n=0）→ `/weapi/v3/song/detail`（c 批量 3 首） | ✅ trackIds 200 → 批量详情 3/3（music-lib 同构：**批 500**） |
| I | GET `/api/playlist/detail?id=…`（老端点） | ✅ 仍存活（备用路） |
| J/L | weapi `/weapi/playlist/list`（cat=华语）/ `/weapi/personalized/playlist` | ✅ 歌单广场/推荐匿名可用 |
| N7 | GET `/api/toplist` | ✅ 63 个官方榜单（飙升榜/新歌榜/原创榜…），榜单即歌单 id，复用 H 路线 |
| K | weapi `/weapi/nuser/account/get`（匿名） | ✅ `{code:200, account:null, profile:null}` —— **完美的登录态探测**（有 profile.userId 即已登录，`profile.vipType≠0` 即 VIP） |
| K2 | weapi `/weapi/user/playlist`（匿名传 uid=1） | ⚠️ 返回该 uid 的公开歌单 —— 说明该接口本质是「按 uid 查公开歌单」，无需登录也可查他人；「我的歌单」= 拿自己 uid 查 |
| M | weapi `/weapi/v3/discovery/recommend/songs`（匿名） | ⚠️ code 200 但无个性化内容 —— 每日推荐为登录特性 |

---

## 4. 各能力项：登录 / 搜索 / 歌词 / 歌单 / 取链

### 4.1 登录（三个源中最简：两跳直达 MUSIC_U）

与 QQ「ptlogin 扫码 → OAuth authorize 换 code → musicu 换 musickey」和酷狗「设备注册 → 出码」相比，网易云是**无设备注册、无二次换票**的直连流程：

| 步骤 | 端点（music-lib 主路，本次实测） | 说明 |
|---|---|---|
| ① 出码 | `POST https://interface.music.163.com/api/login/qrcode/unikey`，**裸表单** `type=3`，UA 带 `NeteaseMusicDesktop/3.0.18…` | 返回 `{code:200, unikey}`；二维码内容 = `https://music.163.com/login?codekey=<unikey>`，用网易云 App 扫 |
| ② 轮询 | `POST https://interface.music.163.com/api/login/qrcode/client/login`，表单 `key=<unikey>&type=3` | code：`800` 过期 / `801` 等待扫码 / `802` 已扫待确认 / **`803` 成功**（响应体带 `cookie` 串 + Set-Cookie `MUSIC_U`/`__csrf_token` 等） |
| ③ 使用 | 之后所有 weapi/linuxapi 请求带 `Cookie: MUSIC_U=…; __csrf_token=…` | 高音质、我的歌单、收藏写操作、每日推荐全部由它解锁 |

（weapi 加密版 `/weapi/login/qrcode/unikey` 同样可用 —— 探针 A/B —— 两路二选一即可。）

**实现要点与既有基建的对齐**：
- 二维码渲染：QQ 的 `ptqrshow` 直接回 PNG、酷狗回 base64 图，**网易云没有官方图片端点**，需要在端内把 `codekey` URL 编码成二维码图（内嵌一段 MIT 的 qrcode-generator 纯 JS 实现，Host 端出 dataURL，或客户端 canvas 渲染）。这是登录链路里唯一的新增「零件」。
- 登录态落库：沿用 `~/.dsh/music-player-<source>-cookie.json`（0600）模式，存 `{cookie, nickname, userId, vipType, loginAt}`。
- 登录态检查/VIP 判定：`/weapi/nuser/account/get`（实测匿名返回 `account:null/profile:null`，登录后 `profile.userId/vipType/nickname` 齐全）——对应 QQ 的 `detectVip` 探测歌取链法，网易云可直接读字段，**更稳**。
- 有效期与刷新：`MUSIC_U` 长期有效（社区经验以月/年计），但**二维码登录的 cookie 不支持 `/login/refresh` 续期**（api-enhanced 文档明确）——失效后重扫即可。失效表现为 `/weapi/nuser/account/get` 返回 `account:null` 或写操作 301。
- 游客兜底（可选）：`/api/register/anonimous`（新版走 xeapi）可拿游客 cookie `MUSIC_A`，用于垫「未登录报 400/需验证」的接口；本项目 MVP 全部走匿名直连（实测不垫也能用），暂不需要。
- IP 风控：账密/写操作类接口对**云机房 IP** 有 460 cheating、503 高频风控，社区案例显示云服务器上扫码轮询可能失败；**DSH 天然跑在用户本机/家宽网络，正好规避此风险**，无需实现 `realIP` 伪造。

**手机/邮箱密码登录**：`/weapi/login/cellphone` 社区现状是重度风控（网易云盾验证码频发，api-enhanced 文档明确警告「密码登录暂时不要使用」），**不要做**；二维码是唯一推荐路径。

### 4.2 搜索（匿名，linuxapi 主路 + weapi 经典备路）

```
主路  linuxapi → POST http://music.163.com/api/linux/forward
      inner: {method:'POST', url:'http://music.163.com/api/cloudsearch/pc',
              params:{s: 关键词, type: 1|10|100|1000|1004, offset, limit}}
备路  weapi  → POST /weapi/search/get   {s, type, offset, limit, total:true}   （实测仍匿名可用）
```

- 歌曲结果字段：`id / name / ar[] / al{name,picUrl} / dt(ms) / fee / privilege{st,pl,dl,maxbr}` ——
  `fee`：0 免费 / 1 VIP / 4 购买专辑 / 8 版权试听；`pl` 为可播码率上限。**归一化结构可直接对齐 `QQ.search()` 的 `{results,total,page}`**。
- type：1 歌曲 / 10 专辑 / 100 歌手 / 1000 歌单 / 1004 MV（1002 用户被门禁，无需）。
- 坑位：**`/weapi/cloudsearch/get/web`（旧教程最常引用的搜索端点）已匿名失效（50000005）**，社区 fork 已切换到 linuxapi 路，本项目直接按主路实现即可。

### 4.3 歌词（LRC + 翻译 + 罗马音；YRC 逐字待复测）

```
保底  GET https://music.163.com/api/song/lyric?id=<id>&lv=-1&kv=-1&tv=-1      ← 匿名，直接 LRC 文本
主路  weapi  POST /weapi/song/lyric   {csrf_token:'', id, lv:-1, tv:-1, rv:-1, yv:-1}
      → lrc.lyric（LRC）+ tlyric.lyric（逐句翻译）+ romalrc.lyric（罗马音）+ yrc.lyric（逐字，若有）
新格式 weapi POST /weapi/song/lyric/v1 {id, cp:false, tv:0, lv:0, rv:0, kv:0, yv:0, ytv:0, yrv:0}
      → 另含 klyric（卡拉 OK 时间轴）与新 JSON-flavor lrc
```

- 实测：匿名 LRC+翻译稳定可得（晴天 lrc 1390 字符 / tlyric 719 字符），与 `QQ.getLyric()` 返回形状 `{lyric, trans}` 一致，`lib/lyric.js` 兜底链加一环零障碍。生态侧评价一致：**歌词是所有能力里最稳定的一类，无频控级反爬、无需登录**。
- **YRC 逐字歌词**：接口参数在（`yv`，新版 `/weapi/song/lyric/v1`），格式与 QRC/KRC 同类（行 `[起始ms,时长ms]` + 词标签，明文无需解密，解析比 KRC 还简单）。但**匿名抽样 8 首（含 2024-25 热歌）yrc 全空**——歌词接口本身无需登录，故更可能是**权利人覆盖面有限**（逐字数据按歌曲逐条上架）；登录后复测定级；实现按「有则用、无则回落 LRC」的可选增强，不影响主链路。

### 4.4 歌单（浏览匿名全通；「我的歌单」登录后一行；写操作社区已打通）

| 能力 | 端点 | 登录 | 备注 |
|---|---|---|---|
| 推荐歌单 | weapi `/weapi/personalized/playlist` {limit,n:1000} | 否 | 首页推荐（✅实测） |
| 分类目录 | weapi `/weapi/playlist/catalogue` | 否 | `categories{分组名}` + `sub[]{name,category}`（music-lib 同款） |
| 分类歌单/广场 | weapi `/weapi/playlist/list` {cat,order:'hot',limit,offset,total} | 否 | ✅实测 |
| 歌单搜索 | linuxapi cloudsearch type=1000 | 否 | ✅实测 |
| 歌单详情 | weapi `/weapi/v6/playlist/detail` {id, n, s} | 否 | ✅实测；返回元数据+tracks(n)+trackIds(全量) |
| 超大歌单曲目 | v6/v3 详情取 trackIds → weapi `/weapi/v3/song/detail` {c:"[{id}…]", ids:"[…]"} | 否 | ✅实测（3/3）；**批 500**，酷狗 QRC 大歌单同思路 |
| 官方榜单 | GET `/api/toplist` → 列表；榜单 id 即歌单 id | 否 | ✅实测 63 榜，复用详情路线 |
| **我的歌单** | weapi `/weapi/user/playlist` {uid, limit, offset, includeVideo} | **uid 从登录态拿** | 首个即「我喜欢的音乐」（对齐 QQ dirId=201/酷狗默认歌单语义） |
| 收藏/创建/加歌/删歌 | `/weapi/playlist/manipulate/tracks`、`/weapi/playlist/create`、`/weapi/playlist/delete` 等 | 是 | 本次未实测；Binaryify 系实现最成熟、社区生产验证充分，接入时照抄语义 |

### 4.5 取播放 URL（核心差异点：**匿名即可播**，登录解锁高音质）

```
MVP 主路  weapi POST /weapi/song/enhance/player/url {ids:'[<id>]', br:999000}
          → data[0]{url, br, level, type, fee, freeTrialInfo, code}
登录增强  POST /api/song/enhance/player/url/v1（新版客户端已迁 xeapi 协议，level 语义：
          standard/exhigh/lossless/hires/jyeffect/vivid/jymaster/sky —— 需登录后复测取舍）
```

实测矩阵（匿名）：

| 歌曲类型 | 判定字段 | 结果 |
|---|---|---|
| 免费歌（fee=0/8） | privilege.pl=320000 | ✅ 320k mp3 直链（CDN m701/m802.music.126.net） |
| VIP 歌（fee=1） | freeTrialInfo | ✅ 45 秒试听直链（`start:0,end:45`）——播放条可显示「试听」 |
| 版权受限歌 | code=404, url=null | ❌ 灰色（如周杰伦原盘在网易云下架）；UI 需有明确报错文案 |

- 直链无防盗链（裸 fetch 可播），但**沿用现有流式代理模式**（`/dsh-music/<src>/play/<id>` 转发 Range），保证与 QQ/酷狗一致的体验并隔离 http 明文域名。
- 登录 + VIP 后：weapi 传 `br=999000` 预期返回无损；更高档（hires/母带等 level 语义）在新客户端走 xeapi 的 url/v1 —— **均待真实登录态复测**（匿名 eapi/xeapi 均不可用或未验证）。MVP 用 weapi 已覆盖匿名全场景。
- 兜底路（社区常用）：`https://music.163.com/song/media/outer/url?id=<id>.mp3` 302 重定向直链，可在 player/url 失败时作为降级再试一跳。
- **「解灰」明确不做**：api-enhanced 的 `/song/url/match`（跨平台匹配酷我/QQ/咪咕等恢复完整播放）属规避版权限制，法律风险高，本项目不集成。
- URL 有效期实测响应 `expi:1200`（约 20 分钟）→ 沿用 QQ 的 5 分钟取链短缓存策略即可。另注意直链域名是 **http**（m7/m8.music.126.net），Host 代理转发时保持现状即可（本项目 QQ/酷狗代理本就不挑协议）。

---

## 5. 缺口与风险清单

| # | 差异/风险 | 影响 | 缓解建议 |
|---|---|---|---|
| 1 | **YRC 逐字歌词匿名抽样为空**（接口在、样本全空） | 逐字扫色这一「特色体验」对网易云可能不可用或需登录 | 登录后复测；实现为可选增强（`yv=-1` 有则解析、无则 LRC+翻译保底），解析器工作量低于 KRC |
| 2 | **eapi 匿名被网关门禁**（404「接口未找到」）；url/v1 已迁 xeapi | 高音质（lossless/hires）路线不能匿名验证 | MVP 用 weapi（免费歌 320k 已够演示）；登录后复测 weapi br=999000，必要时评估 xeapi（当黑盒依赖） |
| 3 | 版权库特性：大量港台/欧美头部曲目录灰色（fee=1 试听 45s 或直接 404） | 搜索首条命中可能不可播（如「晴天」原盘） | 结果列表透出 `fee` 与可播性徽标；播放失败文案区分「VIP/试听」「版权受限」；自动尝试下一候选（酷狗页签已有同款逻辑可复用） |
| 4 | 二维码图无官方端点 | 登录 UI 需自行渲染 QR | 内嵌 MIT qrcode-generator 纯 JS（约 300 行，Host 或 client 出图） |
| 5 | 旧教程端点大量失效（cloudsearch/get/web 50000005、eapi 匿名门禁） | 照抄网上资料会踩空 | 本报告 §3 全部为本机实测；实现以 music-lib netease/ 包为主参照 |
| 6 | 社区上游格局：原版已死（作者 2024-01 主动删库），api-enhanced 等多头接棒，协议还在演进（xeapi、`X-antiCheatToken`） | 端点语义未来漂移时无单一权威参考 | 本项目零依赖自持算法；api-enhanced 持续维护可作风向标，漂移时快速对照；必要时降级为进程内嵌入它 |
| 7 | 风控：账密/写操作类接口对云机房 IP 有 460 cheating、503 高频（社区案例：云服务器上扫码轮询失败）；纯读接口基本只受 IP 频控 | 高频刷库会恶化网络环境 | **DSH 跑在用户本机/家宽，天然规避主要风控面**；再叠加固化 UA、按用户操作触发（不预取）、错误码友好提示（460/502/301）即可 |
| 8 | `music_play` 工具 source 枚举现为 `['local','web']`（web=QQ 硬编码） | 接入第三个源需动工具 schema 与 `pendingIntent` 分发 | 工具层 `source` 增加 `'netease'`（或 `web` 下加 provider 参数）；client 侧新增页签，模式完全镜像 kg |
| 9 | 法律/合规与 ToS（非官方接口流播版权音乐） | 同 QQ/酷狗 | 沿用现有免责声明；仅个人学习/试听，禁止商用与再分发 |

---

## 6. 若立项实施：建议工程结构（供排期参考，本次仅调研未动代码）

```
lib/netease.js      —— 对标 lib/qq.js / lib/kugou.js：三套加密（weapi/linuxapi/eapi）纯函数 +
                       createQRLogin/checkQRLogin/search/searchPlaylist/getTopLists/
                       getTopListSongs/getRecommendedPlaylists/getPlaylistCategories/
                       getCategoryPlaylists/getPlaylistSongs(trackIds+批量detail)/
                       getMyPlaylists/getDownloadURL/getLyric(+YRC 可选)
lib/yrc.js          —— YRC 行/词解析（输出形状 = qrc.js/krc.js 的 {t,end,text}，lib/lyric.js 零改动接入）
lib/index.js        —— 路由镜像 /dsh-music/nc/*：status/login(start·check·logout)/search/play/
                       lyric/playlists/playlist-*/my-playlists/top-lists/top-songs
cookie 存储          —— ~/.dsh/music-player-netease-cookie.json（{cookie,userId,nickname,vipType}，0600）
lib/lyric.js        —— 本地歌词兜底链扩为 QQ → 酷狗 → 网易云 → LRCLIB（网易云 LRC+翻译匿名可得，性价比高）
test/netease.test.js —— 三套加密向量固化、YRC 行词解析、fee/privilege 归一化等纯函数用例
```

分期建议：
- **P0（约半日）**：三套加密 + 搜索/榜单/歌单广场/歌单详情匿名只读跑通（零登录即可演示）；
- **P1（核心）**：扫码登录（两跳 + 内嵌 QR 渲染）→ 我的歌单/歌单写操作、登录态取链（weapi br=999000 复测，必要时评估 xeapi url/v1）、LRC+翻译歌词接入兜底链；
- **P2（增强）**：YRC 逐字歌词（登录复测后定级）、每日推荐/私人 FM、音乐工具 `source: 'netease'`。

与酷狗报告同一结论：**网易云是三源中实现成本最低的**（无设备指纹、无 token 刷新、无自定义解密、扫码最短），若要在酷狗之前选一个第三源先行，网易云的工程风险更小。

---

## 7. 合规提示

与 QQ/酷狗在线功能相同：本调研所述均为非官方接口，涉及平台版权内容，仅限个人学习、技术研究与日常试听；
严禁商业用途与内容再分发；账号风控风险自负。正式实现落地时应随附与 online-music-feasibility.md 相同的使用声明。

## 参考链接汇总

- https://github.com/guohuiyuan/music-lib（netease/{crypto,login,account,song,download,lyric,playlist,user_playlist}.go —— 主参考）
- https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced（主力继任者；util/crypto.js 含 xeapi、module/*.js 端点语义、中文文档、Docker `moefurina/ncm-api`）
- https://github.com/nooblong/NeteaseCloudMusicApiBackup · https://github.com/ILoveScratch2/NeteaseCloudMusicAPI-Mirror（原版删除前备份；加密常量核对）
- https://github.com/xgxdmx/NeteaseMusic-API · https://github.com/Catamint/ncm-api-enhanced（活跃维护 fork）
- https://github.com/Binaryify/NeteaseCloudMusicApi（原版，已归档 —— 接口语义事实标准）
- 删库事件：https://tech.ifeng.com/c/8WbVMJIGASL · https://www.donews.com/news/detail/4/3967225.html · https://www.oschina.net/news/276411
- 风控案例（云 IP 扫码失败）：https://blog.gitcode.com/24f8d1ee82643e0967063564dc301ffd.html
- 原理参考：https://github.com/metowolf/NeteaseCloudMusicApi/wiki（weapi 分析）
