# 在线音乐播放功能 · 实现文档（QQ 音乐）

> 目标：在本插件（dsh-music-player）中新增「播放在线音乐」能力。
> 实现方式：**QQ 音乐（腾讯系）**，Host 端直连 `musicu.fcg` / 传统 `y.qq.com` 端点，
> 浏览器经 `/dsh-music` 同源代理流播。
>
> 状态：**已实现并落地**。**需扫码登录后使用**（QQ 登录或微信登录），登录后可用
> 歌单 / 排行榜 / 新歌 / 搜索 / 播放 / 收藏「我喜欢」全部功能，VIP 曲目可播高音质。

---

## 0. 使用声明（重要，请务必阅读）

本功能通过**非官方接口**访问 QQ 音乐资源，所播放/收藏的歌曲、歌单、榜单等内容，其**版权归
版权所有者及 QQ 音乐平台（腾讯音乐娱乐集团）所有**。

**使用范围限制：**
- ✅ 仅限**个人学习、技术研究、日常个人试听**使用；
- ❌ **严禁用于任何商业用途**（包括但不限于商业推广、盈利性运营、收费服务、企业内部分发）；
- ❌ **禁止公开传播、二次分发、转载、转售**本功能所获取的任何内容；
- ❌ **禁止绕过平台的任何技术保护措施**（DRM 等）用于非法目的。

**责任声明：**
1. 使用者应对自己的使用行为及其后果负全部责任；
2. 因使用非官方接口登录/播放可能导致的**账号风控、封禁、限流**，以及可能引发的**法律与版权纠纷**，
   均由使用者自行承担，本项目作者不承担任何直接或间接责任；
3. 本项目不提供任何形式的商业授权或技术担保；如您用于商业或侵权用途，请立即停止。

如不同意上述条款，请**不要使用**本功能的在线部分。

---

## 1. 方案概览

- **单一来源：QQ 音乐**。版权覆盖广，且扫码登录链路（QQ `ptqrlogin` / 微信 `open.weixin.qq.com`）可打通，
  登录后走 `musicu.fcg` vkey 取链，VIP/高音质可靠。
- **需登录使用**：未登录时 QQ 音乐页签仅显示登录入口，不发起浏览/搜索请求。

---

## 2. 架构与代理方案

### 2.1 Host 出网（无需额外运行时）

- 插件 Host 端是跑在 DSH 宿主进程里的普通 Node 模块（`lib/index.js` 已直接用 `node:fs` / `node:http`），
  `package.json` 要求 Node ≥ 20 → **全局 `fetch` 可用**。
- 因此 Host 可直接请求 `u.y.qq.com` / `c.y.qq.com` 等外网端点，无需 PHP / 二进制 / 额外运行时。

### 2.2 浏览器端约束（CORS）与同源代理

- 浏览器**不能**直接请求 `music.qq.com` / `u.y.qq.com`（无 CORS 头，且腾讯有防盗链/Referer 校验）。
- 复用插件既有的 `/dsh-music` 前缀代理架构：

```
GET /dsh-music/qq/play/<songmid>     → Host 用 vkey 接口换取真实音频 URL，
                                        再以流式（pipe）回传浏览器（边下边播）
```

- 走代理后 `<audio>` 是**同源**加载：现有实时频谱（`decodeAudioData`）正常工作，与本地文件行为一致。
- 登录 cookie 只存 Host（`~/.dsh/music-player-qq-cookie.json`，0600 权限），不进浏览器，降低泄露面。

---

## 3. 已实现的接口清单（Host 端）

> 以下接口均需登录态（Host 已持久化的 cookie）；未登录时接口返回未登录错误。

### 3.1 登录 / 状态

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/dsh-music/qq/login/start` | 生成二维码会话（`mode=qq` 或 `mode=wx`） |
| GET | `/dsh-music/qq/login/check` | 轮询扫码状态（`waiting/scanned/success/expired/failed`） |
| POST | `/dsh-music/qq/login/logout` | 退出登录，清空 Host cookie |
| GET | `/dsh-music/qq/status` | 登录态 + uin + 昵称 |

- 登录态持久化到 `~/.dsh/music-player-qq-cookie.json`（0600），刷新/重启后仍有效。
- 微信登录响应含大整数 `musicid`（~1e18），用 `parseJsonPreserveBigInt` 保留精度。

### 3.2 搜索 / 播放

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/dsh-music/qq/search?w=` | 歌曲搜索（返回带 `songmid` 的歌曲数组） |
| GET | `/dsh-music/qq/play/<songmid>` | 登录态 vkey 取链并流式代理；VIP 登录可播高音质 |

### 3.3 歌单

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/dsh-music/qq/playlist-categories` | 分类列表（语种/曲风等，共 60+ 类） |
| GET | `/dsh-music/qq/playlists?category=&page=` | 推荐歌单（空 category）或某分类歌单（分页，每页 20） |
| GET | `/dsh-music/qq/playlist-search?w=` | 歌单搜索 |
| GET | `/dsh-music/qq/playlist/<id>` | 歌单详情（含歌曲列表，带 `songmid`） |
| GET | `/dsh-music/qq/my-playlists` | 我的歌单（当前账号创建/收藏） |
| POST | `/dsh-music/qq/playlist-create` | 创建自建歌单（`name`，返回 `{id,name}`） |
| POST | `/dsh-music/qq/playlist-delete` | 删除自建歌单（`dirId`；「我喜欢」dirId=201 不可删） |

### 3.4 发现（排行榜 / 新歌）

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/dsh-music/qq/top-lists` | 排行榜全部分组（巅峰榜/地区榜/特色榜等） |
| GET | `/dsh-music/qq/top-songs?topId=&offset=&num=` | 某榜单歌曲列表（带 `songmid`；`offset`/`num` 分页，返回 `total`/`hasMore` 支持加载更多） |
| GET | `/dsh-music/qq/new-songs?type=` | 新歌速递（type 5 最新 / 1 内地 / 6 港台 / 2 欧美 / 4 韩国） |

### 3.5 收藏「我喜欢」

| 方法 | 端点 | 说明 |
|---|---|---|
| POST | `/dsh-music/qq/fav` | 收藏/取消收藏（`action=add|remove`，写入「我喜欢」dirId 201） |
| GET | `/dsh-music/qq/liked` | 读取「我喜欢」已收藏歌曲的 `songid` + `songmid` 集合 |

---

## 4. 前端 UI

- 播放面板新增顶级 tab「**QQ音乐**」，与「本地音乐」「AI讲书」并列。
- 未登录：仅显示两个居中登录按钮（QQ 登录 / 微信登录）+ 免责声明。
- 登录后主 UI：顶部工具栏（播放列表 / 退出登录）+ 6 个子 tab：
  **我的歌单 / 推荐歌单 / 分类歌单 / 排行榜 / 新歌 / 搜索**。
- 歌单/榜单以**卡片式**展示（封面图 + 名称 + 元信息）。
- 搜索支持历史记录；收藏爱心按钮实时反映「我喜欢」状态。
- 详细 UI 与交互见 [online-music-ui-design.md](online-music-ui-design.md)。

---

## 5. 关键技术点

### 5.1 登录态 comm（musicu.fcg 必需字段）

```js
{
  ct: 11, cv: 14090008, v: 14090008,
  tmeAppID: 'qqmusic', uid: uin, qq: uin, loginUin: uin,
  authst: musickey, tmeLoginType: '1'|'2'   // 登录后注入
}
```

### 5.2 大整数保真（parseJsonPreserveBigInt）

- 微信登录 `musicid` / `uin` 可达 ~1e18，超出 JS 安全整数（2^53）。
- 自定义 JSON 解析器把超范围整数字面量保留为字符串，避免歌单/收藏串号。

### 5.3 HTML 实体解码（decodeEntities）

- QQ 接口返回的歌单名/歌曲名/歌手名/描述/分类名等可能带 `&#...;` / `&amp;` 实体。
- 所有用户可见字符串在 Host 端统一 `decodeEntities` 解码。

### 5.4 收藏匹配键（songmid 优先）

- 判断「当前曲目是否已收藏」：`songmid`（稳定字符串）优先，`songid` 兜底。
- 读接口失败时回退到 localStorage 本地兜底集合，保证爱心状态可靠。

### 5.5 榜单/歌单图片

- 榜单封面用 `frontPicUrl`（300×300 方形，带榜名）；歌单用 `cover`/`imgurl`。
- 所有图片 URL 统一 `http→https`。

---

## 6. 风险与限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| **法律/合规** | 非官方接口 + 流播受版权保护音乐，违反平台 ToS，有侵权/封号风险 | 登录前免责声明；定位「个人试听/学习」；README 明确 |
| **接口稳定性** | 逆向接口随时改版/封 IP | 登录态取链相对稳定；本地音乐库仍为首选 |
| **VIP/DRM/区域** | 部分歌曲需登录才可播，极少数版权下架不可播 | 登录可解锁大部分；失败给明确报错 |
| **账号风控** | 第三方登录可能触发平台风控/封禁 | 明确免责；支持一键退出；cookie 仅 Host 持有 |
| **会话过期** | cookie/session 时效短，可能需重新扫码。凭据还在 ≠ 一定有效，但**判准很难**：`GetLoginUserInfo` 这类接口对有效会话也可能返回错误码（QQ 实测 500003），歌单类读接口匿名也通，主动探测极易误报——而误报会把正常登录的用户踢回登录页（实测事故：刚登录 QQ 音乐，一刷新就提示过期） | **不做任何主动过期探测**：`/qq/status`、`/kg/status`、`/nc/status` 只报「凭据是否存在」，`/manifest` 同理，也不在启动/定时任务里探测。过期只在**实际使用**中暴露：① 酷狗业务接口撞 20017/20018 → `kgWithFreshToken` 清会话 → 客户端复查 status 回登录页；② 在线曲目**整列都播不出来**（单曲失败仍按版权/VIP 自动跳下一首）→ 客户端判定「疑似登录失效」，停止跳歌并把面板切回登录 UI（QQ 两入口由用户选；酷狗/网易云自动出码）。三家 `/xx/play` 取链失败一律 404 + 说明文案，不做 401 判定 |



---

## 7. 与本地播放器的关系

- 在线曲目**不入曲库扫描、不占用 500 首上限**，独立维护（`scope: { kind: 'qq' }`）。
- 在线播放进度（当前曲目 + 队列 + 来源）持久化到 localStorage，刷新后可恢复。
- 在线曲目走同一个 `<audio>` 播放条与频谱，只是来源标记为 QQ 音乐。

---

## 8. 文件结构

| 文件 | 职责 |
|---|---|
| `lib/qq.js` | QQ 音乐接口封装（登录/搜索/歌单/删除歌单/排行榜/新歌/收藏 + 工具函数） |
| `lib/index.js` | `/dsh-music/qq/*` 路由 + cookie 持久化 |
| `lib/client.js` | 浏览器端 QQ 音乐 UI（登录/浏览/搜索/播放/收藏） |
| `test/qq.test.js` / `test/qq-bigint.test.js` | 接口与工具函数测试 |
