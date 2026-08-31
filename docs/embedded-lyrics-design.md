# 本地音乐「文件内嵌歌词」支持 · 设计与实现

> 目标：**本地音乐播放时，若音频文件自身带歌词标签（如 FLAC 的 `LYRICS`、MP3 的 `USLT`），
> 直接读取并显示，无需额外 `.lrc` 文件，也无需走在线兜底**。
>
> 状态：**已实现并落地**，测试覆盖纯函数解析 + `/lyric` 路由 + 客户端来源标记。
> 另含扩展：**本地歌词（同名 `.lrc` 与内嵌歌词）的「格式 C」逐句翻译识别与合并**（见 §5.5）。

---

## 0. 背景与问题

本地音乐播放的歌词来源原本只有两条路：

1. **同名 `.lrc`**：`/dsh-music/lyric` 用 `findLrcForAudio()` 找与音频同目录同名的 `.lrc`。
2. **在线兜底**：没有 `.lrc` 时，客户端请求 `/dsh-music/lyric/online`，由 Host 按
   文件名拆「歌名/歌手」去 QQ → 酷狗 → LRCLIB 匹配取词。

但**很多音频文件把歌词写进了文件本身的元数据标签**（内嵌歌词）：
- **FLAC / OGG / Opus**：Vorbis 注释里的 `LYRICS` / `UNSYNCEDLYRICS` 键；
- **MP3**：ID3v2 的 `USLT`（未同步歌词）帧。

这类文件既有同步歌词、又是本地来源，之前却完全没被读取——没有 `.lrc` 时只能退而求其次
走在线匹配，既不准确也可能因为翻唱/冷门而匹配失败。

**实测样本**（用户本地曲库）：`download/王力宏`、`download/汪峰` 下的 7 个 FLAC 文件
内嵌了标准 LRC 歌词（含 `[ti:]`/`[ar:]` 头、逐句 `[mm:ss.xx]` 时间戳、多时间戳行），且
**均无同名 `.lrc`**——正是「内嵌歌词」能直接派上用场的典型场景。

---

## 1. 结论

**完全可行，且实现轻量。** 关键原因：内嵌歌词（尤其是 FLAC 的 `LYRICS`）**通常就是标准
LRC 格式**，项目已有的 `parseLrc()`（`lib/index.js`）可直接复用，无需新解析器。唯一的新
工作是「**从音频文件元数据里把这些歌词读出来**」——纯解析、无第三方依赖、无网络请求。

---

## 2. 现状盘点（已具备的能力）

| 能力 | 位置 | 说明 |
|---|---|---|
| LRC 解析 | `parseLrc()`（`lib/index.js`） | 标准 `.lrc` → `[{t,text}]`，支持多时间戳/offset |
| 音频文件头解析 | `parseAudioMeta()` / `readAudioMeta()` | 已按魔数识别 FLAC/MP3 等容器并读文件头 |
| 本地歌词路由 | `GET /dsh-music/lyric?path=` | `findLrcForAudio()` 找同名 `.lrc` |
| 在线兜底路由 | `GET /dsh-music/lyric/online?path=` | 无本地词时 QQ → 酷狗 → LRCLIB |
| 客户端渲染 | `loadLyricForTrack`（`lib/client.js`） | 本地 `.lrc` / 在线 / 讲书共用同一渲染位 |

增量只有一块：**读取文件内嵌歌词**，并在 `/lyric` 路由里把它排在「同名 `.lrc` 之后、
在线兜底之前」。

---

## 3. 取词优先级（落地后的最终顺序）

```
同名 .lrc  →  文件内嵌歌词  →  在线兜底（QQ → 酷狗 → LRCLIB）
```

- **同名 `.lrc` 仍第一优先**：外部人工整理的 `.lrc` 通常更准、更可控，且这是既有行为，不改。
- **文件内嵌歌词第二**：无需额外文件、无网络，且多为官方/精确同步歌词。
- **在线兜底最后**：前两者都没有时才出网匹配。

`/lyric` 与 `/lyric/online` 两端点都实现了「先复查本地（同名 `.lrc` → 内嵌），无再走后续」的
幂等逻辑，避免重复出网。

---

## 4. 内嵌歌词的容器/标签格式

### 4.1 FLAC / OGG / Opus —— Vorbis 注释 `LYRICS` 键

- FLAC：`fLaC` 后是元数据块序列；`VORBIS_COMMENT` 块（type 4）内是 Vorbis 注释。
- OGG/Opus：OggS 页面里的 `\x01vorbis` 注释包，布局与 FLAC 的 VORBIS_COMMENT 一致。
- 注释格式：`KEY=value`，键大小写不敏感。项目读取 `LYRICS`、`UNSYNCEDLYRICS`、
  `UNSYNCED LYRICS` 三个常见键。
- 值通常就是**完整 LRC 文本**（`[ti:]`/`[ar:]` 头 + `[mm:ss.xx]` 逐句），实测即如此。

### 4.2 MP3 —— ID3v2 `USLT`（未同步歌词）帧

- `USLT` 帧体：编码字节（0=ISO-8859-1 / 1=UTF-16 / 2=UTF-16BE / 3=UTF-8）+ 3 字节语言
  + 内容描述（按编码 null 终止）+ 歌词正文。
- ID3v2.4 用 syncsafe 尺寸、v2.3 用普通 32 位尺寸——按**主版本字节**判断（`major >= 4`）。
- 项目已支持 UTF-8 / UTF-16 / ISO-8859-1 三种编码的正文提取。
- **已知边界**：`SYLT`（同步歌词）帧体是二进制、编码复杂，**暂不解析**（返回 null 走在线兜底）；
  实测用户曲库的 MP3 也无 `USLT`，故优先级影响不大。

### 4.3 编码处理

内嵌歌词文本用项目已有的 `readBufToString()` 解码（兼容 UTF-8 含 BOM / UTF-16 / GB18030）：
- 有的文件 `LYRICS` 头带 `[encoding:gb2312]` 但**实际字节是 UTF-8**（实测汪峰《飞得更高》），
  `readBufToString` 的「先严格 UTF-8 校验、失败再回退 GB18030」策略能正确应对——
  不会因为声明标签而被误导，也不会漏掉真 GB 编码。

---

## 5. 实现

### 5.1 纯函数 `extractEmbeddedLyric(buf)`（`lib/index.js`，导出供测试）

输入文件头 Buffer，输出内嵌歌词**原文**（LRC 文本）或 `null`：

- FLAC：遍历元数据块，在 `VORBIS_COMMENT` 里找 `LYRICS`/`UNSYNCEDLYRICS`。
- OGG：定位 `\x01vorbis` 注释包，按 Vorbis 注释布局解析。
- MP3：遍历 ID3v2 帧，读取 `USLT` 正文（支持 v2.3/v2.4、多编码）。
- 组合文件：`ID3 前缀 + FLAC/OGG`（下载工具常见）先试 USLT，再跳 ID3 标签按容器识别。
- 只有非空歌词才返回；只有 `[ti:]/[ar:]` 头没有正文的「空歌词」视为无词。

### 5.2 路由层读取 `readEmbeddedLyric(absPath, size)`（`lib/index.js`）

- 读文件前缀（≤512KB，覆盖 ID3 标签与 FLAC 元数据块；带超大内嵌封面的文件把
  VORBIS_COMMENT 推后，故放宽），跑 `extractEmbeddedLyric`，再经 `readBufToString` 解码。
- 按 `path + mtime` 缓存结果，避免每次播放重复读盘解析。

### 5.3 路由接线

- `GET /dsh-music/lyric?path=`：`findLrcForAudio` 无果 → `readEmbeddedLyric` → 有则
  `parseLrc` 返回 `{ ok:true, hasLrc:true, source:'embedded', lrc }`。
- `GET /dsh-music/lyric/online?path=`：幂等复查本地时同样先 `.lrc` 再内嵌，命中即返回，
  不浪费在线请求。

### 5.4 客户端来源标记（`lib/client.js`）

- `loadLyricForTrack` 依据响应 `source === 'embedded'` 用
  `noteLyricSource('embedded', '文件内嵌歌词')`，播放条歌词元素 `data-src="embedded"`
  （与 `local` 区分），控制台也会打印 `歌词源: embedded` 便于诊断。

### 5.5 本地歌词的逐句翻译（「格式 C」拆分）

在线 QQ/酷狗歌词有平台下发的结构化 `trans` 字段，客户端用 `mergeLyricTrans` 合并成
「原文 ／ 翻译」。而本地 `.lrc` / 内嵌歌词是纯文本，翻译没有标准字段。为支持常见的
「翻译行带自己的时间戳、紧跟在原句后」写法，新增纯函数 `splitTranslatedLyric(lrc)`。

**支持双向方向**（翻译通常是少数语言行，主语言由整首统计决定）：
- **外文歌 → 中文翻译**（主流）：
  ```
  [00:01.00]Sparrows outside the window
  [00:01.50]窗外的麻雀   ← 中文行紧跟外文原句 → 拆为翻译
  ```
- **中文歌 → 外文翻译**：
  ```
  [00:01.00]窗外的麻雀
  [00:01.50]Sparrows outside the window   ← 外文行紧跟中文原句 → 拆为翻译
  ```

判定规则（从严）：
1. **行分类**：`latin`（≥3 个英文字母且无 CJK）、`cjk`（≥2 个汉字且无英文字母）、
   `other`（中英混杂的水印/歌名，不计入统计也不作翻译候选）。
2. **主语言** = 数量多者；**平局取第一个非杂项行的语言**（首句通常是原文而非翻译）。
   翻译类 = 主语言的反类。主语言无法判定 → 不拆。
3. 候选翻译行须与「前一条主歌词行」时间戳相差 < 0.6s（与 `mergeLyricTrans` 配对阈值
   一致），或与前一条翻译行同时间戳（同时间戳多翻译）。翻译离原句太远（≥0.6s）的不拆。
4. 歌名/水印（如 `LeefenChen-月光游侠 QQ群:...`）属 `other` 类，不误拆。
- **接线**：`/lyric` 与 `/lyric/online` 的本地（同名 `.lrc` / 内嵌）分支都先
  `splitTranslatedLyric(raw)`，把 `trans` 随响应下发（无翻译则不带该键）。
- **客户端**：`loadLyricForTrack` 本地路径改为 `musicLyric = mergeLyricTrans(d.lrc, d.trans)`，
  与在线歌词同一条合并管线，逐句合并成「原文 ／ 翻译」；来源日志标注「（含逐句翻译）」。

---

## 6. 测试

| 层 | 文件 | 用例 |
|---|---|---|
| 纯函数单测 | `test/index.test.js` | FLAC `LYRICS`/`UNSYNCEDLYRICS`、空歌词、无键；MP3 USLT v2.4/v2.3、UTF-8/UTF-16/带 descriptor；ID3+FLAC 组合；OGG 无注释 → null；非法输入；`splitTranslatedLyric`（格式 C 拆分/纯中文/水印不误拆/翻译太远/翻译在前/同时间戳多翻译/空输入） |
| 路由 | `test/index.test.js` `/lyric route` | 内嵌歌词返回 `source:'embedded'` 与正确 LRC；同名 `.lrc` 优先于内嵌；本地 `.lrc` 格式 C 翻译 → 返回 `trans` |
| 客户端 | `test/client.test.js` | `/lyric` 返回 `source:'embedded'` → `data-src="embedded"` 且逐句渲染；本地 `.lrc` 带 `trans` → 合并成「原文 ／ 翻译」显示 |

全量测试 `npx vitest run` 561 例通过。

---

## 7. 风险与边界

| 项 | 说明 | 缓解 |
|---|---|---|
| **内嵌歌词缺失** | 多数本地文件并无内嵌歌词 | 读不到 → 静默回退到在线兜底/无歌词，行为不变 |
| **SYLT（MP3 同步歌词）** | 二进制编码复杂，未解析 | 走在线兜底；用户曲库无此场景 |
| **超大内嵌封面** | 把 VORBIS_COMMENT 推到 512KB 后 | 读不到该文件的内嵌词 → 静默回退在线；不影响播放 |
| **编码混杂** | 声明与实际编码不符 | `readBufToString` 严格 UTF-8 优先、GB18030 兜底 |
| **版权/合规** | 内嵌歌词版权归著作权人 | 与普通 `.lrc` 同为本地内容，仅供个人试听；不做任何分发 |
| **新增依赖** | — | 无：纯 Buffer 解析，复用 `parseLrc`/`readBufToString` |

---

## 8. 工作量与影响面

| 模块 | 内容 | 影响 |
|---|---|---|
| `lib/index.js` | `extractEmbeddedLyric` 纯函数 + `readEmbeddedLyric` 路由助手 + `/lyric`、`/lyric/online` 接线 | 新增 |
| `lib/client.js` | 来源标记支持 `embedded` | 一处分支 |
| `test/index.test.js` | 纯函数 11 例 + 路由 2 例 | 新增 |
| `test/client.test.js` | 内嵌来源渲染 1 例 | 新增 |
| `README.md` / `docs/` | 特性说明 + 本文档 | 文档 |

**对现有行为零破坏**：所有旧路径（同名 `.lrc`、在线兜底、无歌词）保持不变，内嵌只是
多了一个「第二优先的本地来源」。
