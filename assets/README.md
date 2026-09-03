# Screenshots / 截图

放在这里的截图用于 dsh-market 插件市场的 AppStore 风格详情页展示，也会出现在本仓库 README。

## 声明方式

在仓库根（`package.json` 同级）的 `screenshots.json` 里声明 1-8 张图片路径（相对该文件自身，即相对仓库根）。awesome-dsh-plugin 的构建脚本会从本仓库读取该文件、解析成 `raw.githubusercontent.com` 链接供市场使用——之后想增删截图，直接改这里推本仓库即可，**无需再给 awesome-dsh-plugin 提 PR**。

```json
[
  "assets/screenshot-bar.png",
  "assets/screenshot-qq.png",
  "assets/screenshot-kg.png",
  "assets/screenshot-novel.png",
  "assets/screenshot-panel-qq.png",
  "assets/screenshot-panel-kg.png"
]
```

> 规则（见 awesome-dsh-plugin `contributing.md`）：1-8 张；相对路径不能跳出本目录（无前导 `/`、无 `..`）；截图需为 PNG 且保存在本仓库。不声明时市场会退回从 README 抽取图片——声明只是为了控制顺序与内容。

## 截图清单

请在浏览器里打开 DSH Web GUI、播放对应内容后，用系统截图（macOS `Cmd+Shift+4` / `Cmd+Shift+3`）截取以下画面，按命名存进本目录：

| 文件名 | 截图内容 |
|---|---|
| `screenshot-bar.png` | 播放本地音乐：聊天输入区上方的**播放条**（歌名 + 时间 + 模式/音量/列表按钮） |
| `screenshot-qq.png` | 播放 QQ 音乐（在线音乐页签） |
| `screenshot-kg.png` | 播放酷狗音乐（在线音乐页签） |
| `screenshot-novel.png` | AI 讲书：播放小说时的**正在播放条**（章节名 + 时间 + 控制按钮） |
| `screenshot-panel-qq.png` | QQ 音乐播放面板 |
| `screenshot-panel-kg.png` | 酷狗音乐播放面板 |

> 任意一张缺失或不佳都没关系——补齐后随版本一起更新即可。
