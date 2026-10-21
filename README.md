# cnki-cli

在命令行里检索知网、下载 PDF。零依赖，任何能执行命令的 AI 都能用。

Claude Code、Cursor、Codex、WorkBuddy、DSH —— 只要它能跑 `node cnki.js ...`，就能用。

---

## 为什么有这个

知网下载有几个固定的麻烦：验证码、`来源应用不正确(01)`、弹「另存为」、一篇一篇点。

DSH 上有插件版（[dsh-cnki-helper](https://github.com/BigFier/dsh-cnki-helper)），用内置浏览器，实测零验证码。但它只能在 DSH 里跑。

这个项目是命令行版，给 DSH 之外的工具用。

**先说清楚一件事**：命令行版**没有**零验证码的能力。原因在下面「为什么命令行版会出验证码」一节。它能用，但要过验证码。

---

## 开始之前，先确认三件事

**一、你要有知网的使用权限。**

这个工具只负责「检索 + 点下载 + 把文件收好」，它不提供权限。没有机构订阅（或没登录）的话，能搜到标题，但点 PDF 下载不会有文件，会报「无 PDF 下载按钮」。

高校学生用校园网或机构账号登录即可。`node cnki.js login` 会打开浏览器让你登录，登录状态存在 `~/.cnki-cli/profile`。

**二、会出验证码，需要你手动滑一下。**

不是 bug，是命令行版的固有限制。详见后面一节。

**三、Windows + Node.js 22 以上。**

浏览器用你系统上已装的 Edge 或 Chrome，不会额外下载。

---

## 安装

需要 Node.js 22 以上（内置 `WebSocket` 和 `fetch`），以及已安装的 Edge 或 Chrome。

不用 `npm install` —— 没有任何依赖。

```bash
git clone https://github.com/BigFier/cnki-cli.git
cd cnki-cli
node cnki.js status
```

`status` 会附带启动一个浏览器窗口并连上知网，确认环境能跑通。

---

## 用法

```bash
node cnki.js search "日本文学" --limit 10
node cnki.js download 3
node cnki.js download 1-5 --out "D:\文献"
node cnki.js status
node cnki.js login
```

### search

```bash
$ node cnki.js search "日本文学" --limit 5

检索「日本文学」：5 条

1. 20世纪80年代初日本“文学者反核运动”的兴起及其引发的思想论争
   戴宇;李萌 | 2026-09-05
2. 《挪威的森林》对日本文学的影响和传承作用
   喻苏苏;刘洪昊 | 2026-08-30
3. 四六文与日本文学的关系
   芳贺矢一;蒙显鹏 | 2026-08-26
```

结果会存到 `~/.cnki-cli/last-search.json`，供 `download` 用。

加 `--json` 输出结构化数据，给 agent 解析更稳：

```bash
node cnki.js search "日本文学" --limit 5 --json
```

### download

```bash
$ node cnki.js download 3

下载 1 篇 → D:\文献

[1/1] 四六文与日本文学的关系
    ✔ 3001 KB → 四六文与日本文学的关系_芳贺矢一;蒙显鹏.pdf

完成：成功 1/1
```

序号写法：

| 写法 | 含义 |
|---|---|
| `1` | 第 1 篇 |
| `3-5` | 第 3 到第 5 篇 |
| `1,4,7` | 第 1、4、7 篇 |
| `0` | 全部 |

篇间隔固定 8 秒，这是知网过量下载口径的保守值。

### status

```bash
$ node cnki.js status

运行时：Node v24.20.0
浏览器：C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
用户数据：C:\Users\Administrator\.cnki-cli\profile
下载目录：D:\文献

知网：⚠ 当前出现验证码
结果行数：0
页面首行：请完成安全验证 向右滑动完成验证
```

### login

打开浏览器窗口让你手动登录（机构登录或账号登录）。登录状态存在 `~/.cnki-cli/profile`，之后复用。

---

## 为什么命令行版会出验证码

这是实测出来的，不是猜的。

同一天、同一台机器、同一个机构账号，四种组合的对照：

| 浏览器 | 验证码 |
|---|---|
| DSH 内置浏览器（Electron） | **零** |
| 系统 Edge（本工具的浏览器） | **每次都有** |
| Firefox（invisible_playwright） | 每次都有 |
| Chromium | 每次都有 |

指纹伪装、登录态、浏览器内核、profile 历史这四项都单独做过对照排除。结论是：**验证码跟「是不是 DSH 那个浏览器实例」强相关**，而命令行版拿不到那个实例。

所以命令行版的处理方式是：**探测到验证码就把浏览器窗口留给你，你滑一下，工具继续**。

```bash
[验证码] 出现「kns 滑块」
        请在浏览器窗口里手动完成，最长等待 180 秒…
[验证码] 已通过
```

一次滑动的成本，换来的是任何 AI 都能调用。

---

## 给 AI 的用法

把这段丢给你的 AI：

```
知网下载工具在 D:\tools\cnki-cli\cnki.js（Node 22+，零依赖）。

我要下几篇论文，你这样做：

1. node cnki.js search "关键词" --limit 10 --json
   读 JSON，看标题和作者，挑出我要的

2. node cnki.js download <序号> --out "D:\文献"
   序号从 1 开始，支持 1-5 这种区间

3. 如果输出里出现「请在浏览器窗口里手动完成」，告诉我一声，
   我去点验证码，你等我回话再继续

下完把文件名列给我。一次不要超过 10 篇。
```

命令行对 agent 来说是最简单的接口：不用协议、不用起服务、不占 token，就是敲命令读输出。

---

## 实现要点

几个不显然的地方，改代码时会用到。

**用 CDP 而不是 Playwright。**
Node 22 自带 `WebSocket`，直接连浏览器调试端口就够了。这样零依赖，也不用下载 300MB 的 Chromium——用系统上已有的 Edge。

```
node cnki.js
   ├─ spawn msedge --remote-debugging-port=9333 --user-data-dir=~/.cnki-cli/profile
   ├─ fetch http://127.0.0.1:9333/json/version → webSocketDebuggerUrl
   ├─ WebSocket 连上去，Target.createTarget + attachToTarget
   └─ Runtime.evaluate 跑脚本，Page.navigate 翻页
```

**`Runtime.evaluate` 的返回值要自己序列化。**
CDP 的 `returnByValue` 对对象不总是可靠。所有页面脚本统一包成 `JSON.stringify({ok, v})` 再带回，由 Node 侧解析。这样页面抛错也能拿到而不是静默变 `null`。

**下载靠 iframe，不靠 `ctx.browser.download` 那种 fetch。**
知网的下载接口在 `bar.cnki.net`，跟 `kns.cnki.net` 不同源，用 `fetch` 会被跨域拦。注入一个带 `sandbox="allow-same-origin allow-scripts allow-downloads"` 的隐藏 iframe，让它自己发请求，就不跨域了。

**Windows 上文件先写 `.tmp` 再改名。**
Chromium 的下载行为是这样。所以判断「下完了没」不能看扩展名，要按「大小稳定 + 文件头是 `%PDF`」两个条件。

**浏览器的用户数据目录要固定。**
`~/.cnki-cli/profile`。这样登录状态和 cookie 会留存，不用每次都登录。

---

## 已知限制

- **只在 Windows 上测过。** 路径和浏览器查找逻辑是按 Windows 写的，macOS/Linux 要改 `findBrowser()`。
- **每一步都要过验证码。** 见上一节，这是命令行版的固有限制。
- **下载期间没有进度条。** 多篇时会一直等到全部结束才返回。要看进度就拆成几次调。
- **授权范围决定能不能下。** 机构账号没订的刊物，PDF 按钮点了不会有文件，会报「无 PDF 下载按钮」。
- **`search` 的结果靠 `last-search.json` 传递。** 换关键词重新 search 会覆盖，之前的结果就没了。

---

## 合规

高校图书馆的规定一般明确禁止用软件或下载工具批量下载电子资源。中山大学图书馆的表述是「禁止使用软件或下载工具下载电子资源」。

本工具按个人查阅强度做了硬约束（篇间 8 秒），但**这不改变上面的规定**。用它做超出个人阅读范围的批量采集，后果由使用者承担：知网对过量下载的处理是封 IP 24 小时；机构层面可能追责。

建议一次不超过 10 篇，下完就停。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

第三方工具，与同方知网（北京）技术有限公司无隶属关系，也未获其授权或背书。

## 相关

- [dsh-cnki-helper](https://github.com/BigFier/dsh-cnki-helper) — DSH 插件版，零验证码
- [kh-coder-headless](https://github.com/BigFier/kh-coder-headless) — 同一作者，把 KH Coder 做成命令行
