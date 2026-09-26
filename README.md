# dsh-agent-log

Agent 工作记录 / 任务复盘 / 自动生成项目报告 —— DSH 插件。

从 DSH 会话日志**只读**还原一次任务到底做了什么，产出可读的《本次 Agent 工作报告》。

## 安装（从 GitHub，交给 DSH 自己装）

```bash
dsh plugin --profile web install Neo65536-engineer/dsh-agent-log
```

装完重启 DSH（重跑 `dsh web` / 重开桌面版）即可。

> 这一行也是社区插件市场的**代执行通道**：市场会优先提取 README 里指向本仓库的
> `dsh plugin install/add` 指令，弹确认后交给官方 CLI 执行。所以这个 target 必须写对
> —— 它要和 `package.json` 的 `repository.url` / `homepage` / `bugs` 三处保持一致。

### 披露（装之前你该知道的）

| 项 | 值 |
| --- | --- |
| 云端依赖 | **无**。不发任何数据到远端，`network: []` |
| 离线可用 | **是**。全部逻辑在本地读日志文件 |
| 凭据 / API key | **不需要**，也不存储任何凭据 |
| 文件系统权限 | **只读** `$DSH_HOME/sessions`、`$DSH_HOME/storages/session_projcache` |
| 会不会改我的东西 | 不改。**不写会话数据**；只有你显式传 `out` 时才往你指定的路径写报告 |
| 数据保留 | 无（不建任何索引/缓存文件；只有进程内存里 12 份日志的 LRU 缓存） |

## 依赖关系与版本兼容性

### 一、包依赖：**零运行时依赖**

```jsonc
// package.json 里没有这些字段，是刻意的
"dependencies":      // 不声明 —— 零运行时依赖
"peerDependencies":  // 不声明 —— 见下面「为什么不声明 peerDependencies」
"devDependencies":   // 不声明 —— 测试用到 DSH 校验器时走 node_modules 里的 junction
```

源码里**只 import Node 内建模块**（`node:fs` / `node:path` / `node:zlib` / `node:url` /
`node:child_process` / `node:os`），**没有一处 `import`／`require` 任何 `@deepseek-ai/*` 包**。
自证（只匹配真正的 import 语句，注释里提到包名不算）：

```bash
grep -rnE "^\s*(import .* from|.*require\()['\"]@deepseek-ai" index.js client.js core bin \
  && echo "↑ 有命中就说明耦合了宿主包" || echo "✓ 零宿主包依赖"
```

因此：安装不需要 `npm install`，不需要构建，不需要联网，也不存在
「旧版宿主包副本遮蔽宿主」那类事故（[STANDARD §6.6](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 的经典坑）。

### 二、它实际依赖的是**宿主契约**（而不是包）

零包依赖不等于零耦合 —— 真正要盯的是下面这些**宿主接口**。DESKTOP 版与 Web 版都是同一套：

| 方向 | 用到的契约 | 用在哪 |
| --- | --- | --- |
| 宿主 | `ctx.get('tools').register({ name, description, parameters, output, execute })` + `ctx.effect` | 注册 `work_report` 工具 |
| 宿主 | `ctx.inject(['webServer'])` → `webServer.register({ kind: 'prefix', path, handler })` | 只读 HTTP 路由（**可选依赖**：headless profile 没有它时插件照常激活，只是不挂路由） |
| 宿主 | `exec.agent.session.header.id` | 判定"当前是谁的会话"（拿不到时**不回退到"最近被改动的会话"**） |
| 宿主 | Cordis 生命周期 `apply` / `inject` / `effect` / `ctx.logger` | 插件入口 |
| 客户端 | `sidebarRightTabs.register(...)` + `slots.register('sidebar.right.pane.tab', ...)`，`inject: ['@deepseek-ai/dsh-client-ui-sidebar-right']` | 右侧边栏面板 |
| 客户端 | `props.sessionId` | 面板绑定自己所属的会话 |
| 数据 | 会话日志 `sessions/<ws>/<sid>/session[.vN].jsonl.zstd`（N 个 zstd 帧顺序拼接 + JSONL） | 全部数据的来源 |
| 数据 | `storages/session_projcache/sessions/<sid>.json` 的 `tokenUsage.totals` / `sessionStats` | Token 与步数的权威值 |

### 三、实测过的 DSH 版本

| DSH | 形态 | 实测结论 |
| --- | --- | --- |
| **0.1.5-rc.3** | Web（`dsh web`，runner 安装） | 开发期全程在此版本；13 个测试文件全绿 |
| **0.1.7-rc.1** | 桌面版（`dsh-plugin-desktop` 2.0.14 内置，app 内 154 个 `@deepseek-ai/*` 包） | 工具注册、路由、面板全部实测通过（右侧边栏「+」→「Agent 工作报告」） |
| **0.1.7-rc.2** | Web（`dsh web`，2026-09-26 升级后） | 客户端 bundle 进入 application 批次并 200 加载；宿主路由返回真实数据 |

也就是说：**同一个插件同时跑在 0.1.7-rc.1（桌面）与 0.1.7-rc.2（Web）上**，
说明它没有把版本钉在某一个补丁上。

### 四、升级 DSH 会不会影响使用？——**不会静默坏，但要盯三处**

**为什么不会静默坏**：本插件不声明 `peerDependencies`，而 DSH 的版本门禁实现是
`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`：

```js
if (!Object.hasOwn(fields, 'peerDependencies')) return void 0;   // 没有该字段 → 直接放行
```

所以升级 DSH **不会**因为版本门禁把它拦下（反过来，声明了 `@deepseek-ai/dsh-*` 并把版本
钉死的插件会被拒绝 —— 本机已有实例被拒）。

**但有三种情况值得你知道**：

1. **会话日志格式升级**（如 v3 → v4）。读者按魔数 `28 B5 2F FD` 逐帧切、按 `.vN` 取最高版本，
   v0–v4 都兼容，未知版本会被跳过而不是崩。真出问题会在报告里表现为数字变少，而不是报错。
2. **宿主接口改签名**（最可能需要跟的一次）。如果哪天 `tools.register` 或
   `webServer.register` 换了契约，现象是**插件激活但工具/面板不出现**。
   这正是「陈旧模块自检」要防的那类静默故障 —— 插件会自己报出来。
3. **投影缓存路径/字段变动**。它只影响 Token 与步数这两个**权威值**，
   报告里其余内容仍从会话日志算；缺失时会回落到日志累加值。

**升级后自检（一条命令）**：

```bash
node bin/verify-loaded.mjs      # 读会话日志的 request/header，确认 work_report 真在工具列表里
node bin/verify-compose.mjs     # 确认插件仍在组合树里（不依赖运行中的 DSH）
```

两条都过 → 升级没有影响；只有 `verify-compose` 过而 `verify-loaded` 不过 → 是宿主接口层的问题。

> 本机同时存在**两个 DSH 运行时**：桌面版 `E:\tools\dsh-desktop\...\resources\app`
> （app 2.0.14，内含 dsh 0.1.7-rc.1）与 runner `E:\tools\dsh\runner`（`dsh web` 用它，
> 0.1.7-rc.2）。改插件后两者都要重启才生效，详见下文「这台机器上有两个 DSH 运行时」。

## 它回答什么

用户要的 8 个维度，全部有据可查：

| 问题 | 数据来源 |
| --- | --- |
| 任务是什么 | `turn/start` + `user/message`（真实用户输入） |
| 用了哪些工具 | `tool/call` 的 `name` 直方图 |
| 读了哪些文件 | `tool/call` 中 `read` / `grep` / `glob` / `read_image` 的 `file_path` / `path` |
| 改了哪些文件 | 同上，`write` / `edit` |
| 运行了哪些命令 | `tool/call` 中 `pwsh` / `bash` 的 `command` |
| 测试是否通过 | **三态判定，宁可说「未判定」也不谎报「通过」**：① 测试运行器自己打印的失败/通过汇总（最可靠）② 只有在退出码**能归因到测试命令**时才用它兜底。命令被管道接走、或测试后面还有别的语句时，退出码其实来自别人 —— 这时若没有汇总就标「未判定」并写明原因，绝不猜 |
| 测试运行器的识别范围 | `npm`/`pnpm`/`yarn`/`bun` + `test`/`vitest`/`jest`/`check`/`lint`/**`verify`**（含 `test:xxx`）、`npx` 系列、`node --test`、`pytest`、`go test`、`cargo test`、`dotnet test`、`gradle test`、`mvn … test`。裸运行器名（`vitest`/`jest`/`mocha`/`playwright test`）只在**语句开头或由包装器引入**时才算；**引号里的字符串不算** —— `echo "npm test"`、`grep vitest package.json` 不会被当成"跑过测试" |
| 失败过几次、为什么 | `tool/result.error`（权威）+ `[exit code: N]`（兜底） |
| 用了多少 Token | `assistant/message.usage` 逐条累加 + 投影缓存的会话总量 |
| 最终有没有完成 | `turn/end.reason.kind` ∈ `completed` / `aborted` / `interrupted` |

## 数据源（实测，非推测）

```
<DSH_HOME>/sessions/<workspace-slug>/<sessionId>/session[.vN].jsonl.zstd
<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
```

**关键格式事实**：`.jsonl.zstd` 是 **N 个独立 zstd 帧顺序拼接**，不是单帧、也不是长度前缀容器。
Node 的 `zstdDecompressSync` 只解第一帧（曾有文件 1MB 只解出 195 字节），
必须按魔数 `28 B5 2F FD` 切帧后逐帧解压。已在 43 个真实会话（含 7595 帧的大会话）上验证。

事件信封统一为 `{ type, seq, time, data }`。v3 / v4 事件类型兼容。

## 用法

### 1. 作为 agent 工具（装进 DSH 后）

模型可调用 `work_report`：

```
work_report({})                                  # 复盘当前会话
work_report({ turns: 3 })                        # 只看最近 3 轮
work_report({ sessionId: "session-2e667305" })   # 复盘指定会话
work_report({ out: "reports/task.md" })          # 同时落盘（相对「会话工作目录」）
work_report({ format: "json" })                  # 拿结构化数据自己处理
work_report({ format: "html", out: "报告.html" }) # 生成可下载/可打印的 HTML 文档
```

> `sessionId` 省略时，取**调用方自己的会话**（来自执行上下文 `exec.agent.session.header.id`）。
> 拿不到才退回「最近被改动的会话」，并在报告里显式标注——**绝不会把别人的会话当成你的**。

### 2. 离线 CLI（不需要装插件）

```bash
# 单会话复盘
node bin/worklog.mjs --list                  # 列出所有会话
node bin/worklog.mjs --latest                # 最近一个会话的报告
node bin/worklog.mjs <sessionId>             # 指定会话
node bin/worklog.mjs <sessionId> --out r.md  # 写入文件
node bin/worklog.mjs <sessionId> --json      # 结构化输出

# 日报 / 周报（跨会话按时间聚合）
node bin/worklog.mjs --period --since today        # 今天的日报
node bin/worklog.mjs --period --since 7d           # 最近 7 天
node bin/worklog.mjs --period --since week         # 本周（周一起）
node bin/worklog.mjs --period --since 30d --out 月报.md
node bin/worklog.mjs --period --since 2026-09-20 --until 2026-09-25
```

`--since` 接受 `today` / `yesterday` / `week` / `7d` / `30d` / `YYYY-MM-DD`。

日报/周报回答的是「这段时间我让 agent 干了什么」，包含：按天分布表、工具使用占比、
文件产出清单、逐日逐任务明细（含首次失败原因）、以及这段时间的经验小结。

> 报告里「N 个会话有任务」与「另有 M 个会话仅跨范围续跑」是两个不同口径：
> 前者是范围内**发起了任务轮次**的会话，后者是只**有事件**落在范围内的会话（跨天续跑）。


### 3. HTTP 路由（装进 DSH 后）

```
GET /plugins/dsh-agent-log/report?format=json&sessionId=...&turns=N
GET /plugins/dsh-agent-log/report?format=markdown
GET /plugins/dsh-agent-log/report?format=html          # 自包含可下载文档
GET /plugins/dsh-agent-log/report?list=1               # 最近会话列表（面板选择器用）
```

### 4. 右侧 Sidebar 面板（装进 DSH 后）

在右侧边栏的「+」里选 **Agent 工作报告**，或从引导页进入。
面板有 7 个页签：**总览 / 工具 / 命令 / 文件 / 测试 / 失败 / 轮次**，
工具条上有：**刷新 · 自动 · 下载 · .md · 会话选择器**。

**可下载的报告文档。** 「下载」把当前这份报告动态生成成一份**自包含 HTML 文档**
（`core/html.mjs`，内联样式、无外部依赖，可直接双击打开或打印成 PDF）；
「.md」下载 Markdown 源文件。文件名形如
`本次Agent工作报告-3b21b705-20260925T1830.html`。
文档由**宿主侧**渲染（前端只负责取回来存盘），所以面板、离线 CLI、agent 工具三条路径
拿到的报告永远是同一份，不会两边规则漂移。

> 对应接口：`GET /plugins/dsh-agent-log/report?format=html`；
> agent 工具也支持 `work_report({ format: "html", out: "报告.html" })`。

面板绑定**自己所属的会话**：框架把会话标准工具包（`sessionId`）作为 props 传给面板正文
（与已发布的文件面板同一个约定：`function FilesBody({ useTabInfo, sessionId, ... })`）。
**这一点必须做对**——路由在不给 `sessionId` 时会退回「最近被改动的会话」，
并发会话（子代理 / 另一个窗口）会让面板显示成别人的会话。若框架没给出 `sessionId`，
面板会在标题栏显式标注「⚠️ 未指定会话，按「最近活跃」选取」，并且可以用选择器手动切换。

总览页给出用户最关心的九项：**任务**（原始提示词）、结论（最终有没有完成）、轮次/步数、
工具调用、命令执行、失败与疑似、测试、读写文件、以及各类 Token。

面板顶部若出现黄色提示 **「宿主加载的是旧版插件模块」**，说明宿主内存里的代码落后于磁盘——
见下面的「⚡ 改完宿主代码必须重启」。

数据来自上面的 HTTP 路由，前端不做日志解析。

> ⚠️ **布局坑（真机出现过）**：`.worklog-who` 曾经写成 `flex:1 1 100%`。
> 面板根是竖排 flex，`flex-grow` 会把它撑满剩余高度，于是**页签栏被挤到底部、
> 中间留出一大片空白**。所有非正文的条状元素都必须是 `flex:0 0 auto`，
> 只有 `.worklog-body` 允许 grow。`test/panel-data-check.mjs` 现在有针对性护栏。
>
> ⚠️ **key 坑（真机出现过）**：`Fails()` 曾经把标题写成 `key: 'h1'`、条目写成 `` key: `h${i}` ``——
> 第 2 条失败正好也叫 `'h1'`，疑似标题 `'h2'` 又和第 3 条撞车。
> React 按 key 复用节点，**撞车会留下陈旧节点**：切到别的页签后那行标题被"复制"成两份、
> 刷新也不消失。规律：**同一个兄弟数组里，标题与条目的 key 必须用不同前缀**。
> `test/keys-check.mjs` 现在会把 7 个页签全渲染一遍并逐个检查 key 唯一性。

### 面板的两种栏

顶部是**操作栏**（品牌色描边 + 图标的动作：`↻ 刷新` / `❙❙ 自动` / `⤓ HTML` / `⤓ MD` + 会话选择器），
下面才是**页签栏**（中性 pill）。两者刻意用不同视觉，避免"动作"和"位置"混淆。
信息行只显示**对话名**（不显示 session id）；`✓ 已下载 …` 是操作反馈，4 秒后自动消失。

## 设计取舍

**零运行时依赖。** 插件刻意**不 import 任何 `@deepseek-ai/*` 包**：工具定义用原生 JSON Schema 手写。
这样 `link:` 安装的插件不需要自带 `node_modules`，也就绕开了符号链接导致的模块解析问题
（Node 默认按 realpath 解析，从工作区目录向上找不到 profile 的依赖）。

**只读。** 从不写会话数据。DSH 的规则是「会话日志是唯一事实来源」，
且 `Session.append()` 不能设置 `ignorable` 标记，追加自定义事件会让会话无法重新打开——
所以本插件只做派生读取。

**失败判定分两级。** 权威信号是 `tool/result.error`（结构化）。
命令类工具再从输出文本读 `[exit code: N]` 兜底，但 Windows 上
`… | Select-Object -First N` 会因 broken pipe 让管道非 0 退出——这类降级为**疑似**，
单独成节，不混进失败总数。否则报告会被假阳性淹没。

## 开发

```bash
npm run verify      # 全部离线验收（13 个测试文件，逐个跑完再汇总）
npm run preflight   # 只读安装预检（不改任何文件）
```

> `verify` 走 `test/run-all.mjs`：**逐个跑完再汇总**，不再用 `a && b && c` 串联。
> 串联的后果是第一个失败文件一挂后面全都不跑，而命令只显示「失败」——覆盖被静默截断。

| 测试 | 覆盖 | 规模 |
| --- | --- | --- |
| `test/offline-check.mjs` | 工具定义 + DSH 真实 schema 校验器 + execute 通路 + 数据一致性 | 28 项 |
| `test/host-apply-check.mjs` | 宿主 `apply()`：工具注册、路由契约、可选依赖缺失、handler 真跑 | 27 项 |
| `test/client-check.mjs` | 客户端：ModuleLoader 契约、tab 注册、组件构造、主题 token 存在性 | 38 项 |
| `test/panel-data-check.mjs` | 面板各页签的数据通路 + **布局/下载护栏**（有失败必须列得出来、无失败必须空状态） | 53 项 |
| `test/keys-check.mjs` | **7 个页签全渲染一遍，逐个检查兄弟节点 key 唯一性**（key 撞车会留下陈旧节点） | 9 项 |
| `test/regression-fixes.mjs` | **本轮修掉的缺陷的回归**：陈旧模块自检、参数校验、会话身份、`out` 基准、HTML 文档、**测试栏三态判定与误报防护**、`turns` 重算、文案、CLI | 114 项 |
| `test/token-guard-check.mjs` | 反向验证 token 校验逻辑本身能抓到坏 token | 1 项 |
| `test/robustness-check.mjs` | **边写边读**：任意位置截断、退化输入、目录边界 | 20 项 |
| `test/install-check.mjs` | 安装/回滚端到端（在沙箱里真跑 `--apply` + `--rollback`） | 28 项 |
| `test/postinstall-smoke.mjs` | **装后冒烟**：从 profile 解析、宿主/客户端入口能加载、门禁通过 | 27 项 |
| `test/accuracy-audit.mjs` | **逐会话对照 DSH 权威投影缓存** | 全部会话 |
| `test/usage-semantics-check.mjs` | Token 累加口径判定（逐条累加 vs 取最大） | 全部会话 |
| `test/step-semantics-check.mjs` | 步数口径判定（`step/start` vs `step/end`） | 全部会话 |

后三个是**语义正确性**测试：其余证明"代码能跑、边界不崩、装得上"，它们证明"数字是对的"。
它们用 `test/_live.mjs` 判定"活跃会话"：**只把 `DSH_SESSION_ID` 当活跃会话是错的**——
并发子代理会话的投影缓存还没写进去，会被判「非活跃必须完全一致」而必红，
且失败集合每轮都在变。现在按日志 mtime 判定活跃，并**对任何会话都硬性要求「不许比权威少」**。

## ⚠️ 这台机器上有两个 DSH 运行时

**开发时必须对着「真正在跑的那个」验证，否则会验错对象。**

| 位置 | 版本 | 用途 |
| --- | --- | --- |
| `E:\tools\dsh-desktop\DSH Desktop\resources\app\` | **0.1.7-rc.1** | ✅ **Desktop app 实际运行的就是它** |
| `E:\tools\dsh\runner\` | 0.1.5-rc.3 | 旧的 web profile 运行时，已不是当前 GUI |

`desktop` profile **由 Electron 应用独占管理**，`dsh --profile desktop --dump-config` 会被拒绝
（`error: profile "desktop" is managed exclusively by the Electron application`），
所以只能用装后冒烟测试（`npm run smoke`）来验，不能靠 dump-config。

`node_modules/@deepseek-ai/*` 是**开发期**指向真实运行时（Desktop app）的 junction，
仅为让测试能调用 DSH 的 `assertSupportedJsonSchema` 与核对主题 token。运行时不需要它。

## 安装

```bash
npm run preflight   # 1. 只读预检（默认行为，绝不动配置）
npm run install     # 2. 备份 → 改 profile → pnpm install
npm run smoke       # 3. 装后冒烟（从 profile 真实解析并加载宿主/客户端入口）
npm run compose     # 4. 组合验证（确认插件真的进了 DSH 的组合树）
npm run loaded      # 5. 加载验证（读会话日志确认 work_report 已进入工具列表）
npm run rollback    # 需要时回滚到安装前
```

### 两种来源形态：`link:` 与 `file:`（自动判定）

安装器要面对两种完全不同的东西，它们该用的依赖协议也不同：

| 形态 | 特征 | 协议 | 为什么 |
| --- | --- | --- | --- |
| **开发检出** | 有 `test/` 或 `.git` | `link:` | profile **直接解析到插件目录本身**：改一行代码立即生效 |
| **下载来的包** | 解压出来的目录，没有 `test/`、没有 `.git` | `file:` | pnpm 把插件**复制**进 profile 的 `node_modules`：源目录之后可以删/挪 |

不传参数时按 `test/` 或 `.git` 自动判定（用"发布产物一定没有的东西"当信号）。
也可以显式指定：

```bash
node bin/install.mjs --apply                 # 自动判定
node bin/install.mjs --apply --file          # 强制 file:（分发包）
node bin/install.mjs --apply --link          # 强制 link:（开发检出）
node bin/install.mjs --apply --source-dir D:\pkg\dsh-agent-log   # 指定插件源目录
```

> 为什么必须支持 `file:`：早先这里**硬编码 `link:`**，于是"下载一个包再装"这条路
> 会指向一个不存在的开发目录，而 `pnpm install` 可能先成功、重启后才静默不加载。
> `test/install-check.mjs` 现在会造一份**去掉 `test/` 的拷贝**当分发包，
> 装完**删掉源目录**再验证插件依然能加载 —— 这是 `file:` 唯一有意义的地方。

### 装前会顺手关掉 pnpm 11 的一个门禁

pnpm 11 起 `strictDepBuilds` 默认是 `true`：只要有依赖带构建脚本而未被显式批准，
`pnpm install` 就以**非 0 退出**（`ERR_PNPM_IGNORED_BUILDS`）。
这个报错跟"插件装不上"毫无关系，却会让安装器误判失败并自动回滚。

所以安装器会在 profile 的 `pnpm-workspace.yaml` 里补一行 `strictDepBuilds: false`
（用**文本追加**，不重新序列化，避免抹掉 profile 里原有的解释性注释）。
本插件零运行时依赖、自身也没有 postinstall，不需要批准任何构建。

### ⚡ 不需要重启 —— HMR 会热挂载

**实测：安装完成后约 5 秒，插件就被热挂载了，无需重启 DSH。**

证据（会话 `session-888db2c6` 的 `request/header` 事件，DSH 自己记的）：

| seq | 时间 (UTC) | 工具数 | 含 `work_report` |
| --- | --- | --- | --- |
| 11 | 04:06:17 | 31 | — |
| 1064 | 07:06:04 | 31 | — |
| **1685** | **07:24:40** | **32** | ✅ **首次出现** |
| 2029 | 07:31:15 | 32 | ✅ |

安装完成时间是 07:24:35 UTC —— **5 秒后** `work_report` 就带着完整 schema 出现在工具列表里。

原因：profile 组合里挂着 `@deepseek-ai/dsh-hmr`（`disabled: !!js '!ctx.get('profileContext')'`，
有 profile 上下文时启用）。它监视 Loader 条目变化，启用普通插件时会**新增 Loader 条目**。

`dsh-client-modules` 的文档也印证了这一点：
「已打开的 Web 页面通过 HMR 传输跟随 Host 的完整模块图。**启用普通插件会添加其 Loader 条目**」。
只有「移除或替换 bootstrap」才需要刷新页面。

所以：

| 部分 | 生效方式 |
| --- | --- |
| 宿主侧（`work_report` 工具、HTTP 路由） | 安装时**HMR 自动挂载，无需任何操作** |
| 客户端侧（右侧边栏面板） | 同上走 HMR；若面板没出现，**刷新一下页面**（F5）通常即可 |
| 兜底 | 重启 DSH 一定生效 |

### ⚠️ 但**改代码**之后是另一回事：宿主模块不会热重载

上面说的是「**装**插件」。**编辑宿主侧文件之后，HMR 不会重新 import 它们**——
Node 的 ESM 模块一旦加载就缓存住，而 HMR 只处理 Loader 条目的增删。

这会造成一种最难查的状态：**客户端是新的（页面会重新拉 bundle），宿主是旧的**。
真实症状：面板「工具 / 命令 / 文件」三个页签**恒为空**，而「总览」和「失败」正常——
因为新前端去读 `totals.toolDetail` / `allCommands` / `fileDetail`，而旧宿主根本不产出这三个字段。

| 改了什么 | 生效方式 |
| --- | --- |
| `client.js`（面板） | 刷新页面（F5）通常即可 |
| **`index.js` / `core/*.mjs`（宿主）** | **必须重启 DSH**（改完 `client.js` 也一样刷新一次） |

为了让这种状态不再静默，插件现在**自己会报**：

- 启动与每次请求时对照磁盘 mtime，一旦发现关键模块比加载时刻新，就在日志里告警；
- 路由 payload 带 `diagnostics.freshness`，工具输出与 **面板顶部都会显示黄色横幅**：
  「宿主加载的是旧版插件模块（时间），磁盘上更新的文件：…。请重启 DSH。」

所以正常流程是：改代码 → `npm run verify` → 重启 DSH → 刷新页面。

`npm run loaded` 直接从会话日志读最近一次 `request/header` 的工具列表来判定是否已加载
（不看界面、不需要截图）：

```
$ npm run loaded
  ✓ 工具列表里出现了 `work_report` —— 插件已加载
```

> 为什么不用 HTTP 探路由：DSH 的 web server 对**所有**未认证请求返回 403
> （连 `/` 和随机路径都是 403），外部探测无法区分「路由不存在」与「被拒绝」。

### 组合验证是怎么做到的

`desktop` profile 由 Electron 应用独占管理，`dsh --profile desktop --dump-config`
会被直接拒绝，所以没法直接 dump 真实 profile 的组合结果。

`npm run compose`（`bin/verify-compose.mjs`）的办法是造一个**临时 profile**：
复制真实 profile 的配置文件，`node_modules` 用 **junction 复用**（不复制，秒级完成），
再用 app 自带的 dsh CLI dump 它。组合结果与真实 profile 等价，于是能在**不重启**的前提下确认：

- `cordis.patch.yml` 合法且被应用
- bundle 被识别
- 插件确实进了组合树（输出里出现 `# == dsh-agent-log` 与对应的 id/name 行）

脚本最后会删掉临时 profile，并检查源 profile 的 `node_modules` 未被 junction 清理误伤
（**必须先删 junction 再删目录，顺序反了会连带删掉目标内容**）。

> 已验证：`desktop` 的组合输出第 1266 行出现了
> `# == dsh-agent-log` / `- id: dsh-agent-log` / `name: dsh-agent-log`，
> 形态与已知能工作的 `dsh-inline-images` 完全一致。

预检会检查：插件本体完整性、profile 可解析、**pnpm 版本与 profile 的
`.modules.yaml` 记录是否一致**（不一致会导致 `ERR_PNPM_*`）、node 版本、
sessions 目录可读性。任一阻塞项存在时不会写入。

`--apply` 是**幂等**的：配置已经是目标状态时不会重复写、也不会产生多余备份。
`--rollback` 取**最早**的那份备份，即插件安装前的状态。

### 应用会不会覆盖我改的 profile？

不会。`@deepseek-ai/dsh-app-boot` 里唯一会重写 profile manifest 的地方是
`normalizeShippedProfile`，它的条件是（`lib/index.js:856`）：

```js
if (!(installationOwned !== void 0 && sameBundles(bundles, installationOwned))) return manifest;
```

**只有当前 bundle 列表与"随安装发布的元组"逐项完全相同**才会被归一化重写。
我们往列表里加了第 8 个 bundle，`sameBundles` 为 false → 直接原样返回，不写盘。
另外 `initProfile` 也明确写着 "Existing files are never touched"。

### 版本兼容性门禁（重要）

DSH 0.1.7-rc.1 会在安装/启动时检查插件的 `peerDependencies`。
判定实现在 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`：

```js
if (!Object.hasOwn(fields, 'peerDependencies')) return void 0;   // 没有该字段 → 直接放行
```

**本插件不声明 `peerDependencies`**（也零运行时依赖），因此门禁直接放行。
反之，声明了 `@deepseek-ai/dsh-*` 并把版本钉死的插件会被拒绝 ——
例如环境里的 `@wingsky-1/dsh-mcp-manager@0.2.5` 就因此被拒。

### 踩过的坑（已修，勿回退）

1. **`type` 不能是数组。** DSH 的 JSON Schema 子集只接受单个标量 type。
   `type: ['string','null']` 会被 `assertSupportedJsonSchema` 拒绝 → 插件注册失败。
   可空字段应省略 `type`（注释型 schema）。
2. **JSON 格式不能附加说明文字。** 早期版本在 JSON 输出后面拼诊断脚注，导致调用方 `JSON.parse` 失败。
3. **一个会话目录里可能有多份日志，必须按格式版本取最高的。**
   DSH 升级格式时保留旧文件，同目录会并存：
   `session.jsonl.zstd`（v0，旧，**内容不完整**）与 `session.v3.jsonl.zstd`（当前）。
   按 `readdir` 顺序取第一个会读到旧的 v0 文件 —— **静默少算**。
   实测某会话因此只读出 **1/7** 的轮次、39/146 的步数。
   现在按 `.vN` 取最高版本（无 `.vN` 视为 v0）。
4. **步数口径 = 已关闭的步（`step/end`），不是 `step/start`。**
   DSH 对每个进入的步在 `finally` 里恰好追加一条 `step/end`，所以完成/失败/取消/max-tokens
   的步都落地。用 `step/start` 会多算当前正在跑的那一步。
5. **`cacheReadTokens` 是逐条增量，必须相加，不能取最大值。**
   我一度按"累计口径"改成取 max —— 实测判定：逐条累加在 **42/42** 个会话上与
   DSH 权威总量完全一致，取 max 则 **0/42** 命中。差一点就发货了。
   （对照：`totalTokens` 确实是累计上下文规模，那个才该取 max。）
6. **`webServer.register` 的路由契约是 `{ kind, path, handler }`**，不是 `{ method, path, handler }`。
   `kind` 取 `'exact'` 或 `'prefix'`。写错不会抛错，是**静默不匹配**——最难查的一类。
7. **主题 token 名必须核对，不能凭印象写。** 最初按猜测写了 `--dsw-alias-text-primary`、
   `--dsw-alias-bg-primary`、`--dsw-alias-border-secondary`、`--dsw-alias-status-success`、
   `--dsw-font-size-sm` 等 7 个**不存在**的 token。token 写错不会崩，
   但整个面板会静默退化成「没有样式」。
   真实名单：`--dsw-alias-label-primary/secondary`、`--dsw-alias-bg-base/layer-1/2/3`、
   `--dsw-alias-border-l1..l4`、`--dsw-alias-state-success/error/warn-primary`、
   `--dsw-font-xxs-12-font-size`、`--dsw-font-markdown-code-font-family`。
   `test/client-check.mjs` 现在会逐个 token 对照主题包校验。
8. **Windows 上无法用 `execFileSync` 调用 pnpm。**
   pnpm 是 `.cmd` 垫片：`execFileSync('pnpm')` → `ENOENT`（Windows 不补 `.cmd`）；
   `execFileSync('pnpm.cmd')` → `EINVAL`（Node 出于安全禁止无 shell 执行 `.cmd`）。
   必须走 `execSync`（带 shell）。这个坑会让安装器报出误导性的「找不到 pnpm」，
   而 pnpm 其实装得好好的。
9. **`--rollback` 必须取最早的备份。** 取最新会指到"上一次 `--apply` 之前"，
   而那时插件可能已经装好了 —— 回滚完插件还在配置里。实测踩过。
   配套修法：`--apply` 幂等时**不产生备份**。
10. **测试绝不能与真实安装共用备份目录。**
    备份目录现在可通过 `--backup-dir` 覆盖，测试必须指到自己的沙箱。
    这个缺陷真的发生过：跑一次 `install-check` 就把真实安装的备份删了，
    导致 `--rollback` 失效。（当时靠一份手工的独立备份救回来。）
11. **宿主模块改完不会热重载**（见上面单列一节）。症状是「面板除了总览全是空白」，
    因为新前端读 `totals.toolDetail` / `allCommands` / `fileDetail`，旧宿主不产出。
    现在插件会自检并在日志/工具输出/面板横幅里报出来。
12. **相对 `out` 不能按宿主进程 cwd 解析。** 宿主 cwd 是
    `E:\tools\dsh-desktop\DSH Desktop`（Electron 安装目录），按它解析会把报告写进应用目录，
    而报告头却写着「工作目录：E:\tools\work」。必须按 `record.cwd`（会话工作目录）解析。
13. **面板必须绑定它自己所属的会话。** 路由在缺 `sessionId` 时退回「最近被改动的会话」，
    并发会话（子代理、另一个窗口）一写日志就会把面板抢走，显示成别人的会话。
    正解：面板正文的 props 里就有 `sessionId`（框架的会话标准工具包）。
14. **`process.env.DSH_SESSION_ID` 在宿主进程里是空的。** 它由 `dsh-shell-env`
    **按每次模型 shell 调用**构造给子进程，从不写宿主 `process.env`。
    所以「省略 sessionId 就复盘当前会话」不能靠它 —— 实测过工具会把**并发兄弟子代理的会话**
    交上来（两者日志只差 2ms）。正解：`exec.agent.session.header.id`；
    拿不到时**不要静默回退到「最近被改动的会话」**，要么报错要么显式标注。
15. **测试自身的三个坑（都真的红过）：**
    - 断言不能依赖"最新会话恰好有失败"——那是数据依赖，换一天就红；
    - 不能用 `a && b && c` 串联——第一个文件一挂，后面全部不跑而命令只说"失败"；
    - "活跃会话"不能只认 `DSH_SESSION_ID`——并发子代理会话会被判"非活跃必须完全一致"而必红，
      且失败集合每轮都在变。现在用日志 mtime 判定活跃，并统一硬性要求"不许比权威少"。
16. **预览文本必须剥掉 ANSI 颜色码。** 命令失败时，`toolOutcome` 会把已经着色过的 stderr
    当"说明"写进报告和面板。ESC 字符本身不可见，报告里就只剩 `[38;2;140;140;140m` 这种垃圾；
    更糟的是 `firstLines` 按宽度截断，会把一条序列**从中间切断**，留下半截 `[38;2;` 永久驻留。
    修法是在源头 `firstLines` 里剥（CSI + OSC 两类），这样工具输出、面板、HTML 一起干净。
17. **"直接跑测试脚本"必须算跑过测试。** 早先只认 `node --test`，而本插件自己的入口是
    `node test/run-all.mjs` —— 于是报告对着自己的测试套件报「测试执行 0」。
    这是**硬性事实错误**，比漏统计更糟。现在额外认 `node <测试目录>/<文件>` 与
    `node *.test.*` / `*.spec.*`，同时不把 `node build.mjs` 之类误算成测试。
18. **`pnpm install` 的非 0 退出不一定代表安装失败。** pnpm 11 的
    `ERR_PNPM_IGNORED_BUILDS`（默认 `strictDepBuilds: true`）会让安装了带构建脚本依赖的
    profile 以非 0 退出，安装器据此自动回滚 —— 一个纯粹的假故障。见上面「装前会顺手关掉
    pnpm 11 的一个门禁」。
19. **失败路径里的回滚逻辑自己会炸。** `pnpm install` 失败时无条件 `readdirSync(backupDir)`，
    但在"配置已是目标状态"（幂等、未建备份）的分支里 `backupDir` 是 `null` ——
    回滚自身抛错，把真正的 pnpm 报错盖掉。现在按 `backupDir` 是否存在分流。
20. **健壮性测试的基线必须冻结成快照。** `listSessions` 报的 `bytes` 是列目录那一刻的 stat，
    而日志正在被实时追加；测试又去重读原文件，于是"字节数"和"实际读到的字节"不是同一份数据。
    实测这个文件在 0.3 秒内长了 7 万字节，导致截断断言的"最后一帧"错位、随机变红。
    现在先冻结一份 Buffer，后续截断与魔数计数都基于它。

### 已知的、非缺陷的行为

- **当前活跃会话的数字可能略领先于投影缓存。** 报告先读日志再读缓存，会话在这两次读之间
  又追加了事件。允许"我比权威多"，不允许"我比权威少"。`test/accuracy-audit.mjs` 按此规则判定。
- **活跃会话的步数可能比权威多 1**，因为那一步正在跑、还没写 `step/end`。
- **读到残缺的最后一帧是常态**（日志被边写边读）。读者会跳过它并把数量记在
  `diagnostics.damagedFrames`，不影响之前所有完整帧。

> ⚠️ **不要用 PowerShell 的 `Get-Content -Raw` / `Set-Content` 改这些源文件。**
> 默认编码不是 UTF-8，会把中文和模板字符串写坏，产生无法读取的文件。
> 改文件请用带 UTF-8 语义的工具。

## 安装（当前机器）

当前活跃 profile 是 `desktop`：

```jsonc
// E:\tools\dsh\profiles\desktop\package.json
"dependencies": { "dsh-agent-log": "link:E:/tools/work/plugins/dsh-agent-log" },
"dsh": { "profile": { "bundles": [ /* ... */, "dsh-agent-log" ] } }
```

然后在该 profile 目录 `pnpm install`，重启 DSH。

## 打包与发布

### 进 GitHub / 社区插件市场（准入条件）

收录靠 GitHub topic **`dsh-plugin`**：市场 CI 每 2 小时扫一次该 topic，命中即自动收录，
不需要申请或提 issue（其它建议 topic：`dsh`、`deepseek-harness`、`cordis-plugin`）。

准入要求与本地自查：

| 条件 | 本仓库现状 |
| --- | --- |
| 仓库公开 + topic `dsh-plugin` | 待你在 GitHub 上设置（建仓后 Settings → Topics） |
| `package.json` 声明 DSH 插件能力 | ✅ `dsh.plugin: true` + `dsh.bundle.patch` + `dsh.client` |
| 有效的 `cordis.patch.yml` | ✅ `insert` 一行，`name` = 包名（loader 按包名解析） |
| `repository` 字段 | ✅ 已填（市场靠它做"已安装/可更新"识别与卡片展示） |
| **产物型**（无需构建） | ✅ 纯 ESM 源码即产物：没有 `scripts.build`，`main`/`client` 指向的文件都在仓库里 → 市场不会弹构建确认，也不需要 `prepare` 授权 |
| 版本号 | ✅ `0.2.0`；**改代码必须 bump**，否则市场永远不显示「更新」 |
| 根目录无 `install.ps1` / `install.sh` | ✅ 安装器在 `bin/`，不会被误判为脚本型 |
| 披露字段 | ✅ `package.json` 的 `disclosure`（无云端/无凭据/只读/无保留） |

自查用第三方检查器（社区验证工具，非本项目依赖）：

```bash
git clone --depth 1 https://github.com/AphyTOT/dsh-plugin-preflight /tmp/pf
node /tmp/pf/bin/preflight.js --dir . --strict     # 期望：No findings
```

### ⚠️ 市场安装与本仓库安装器**二选一**，不要同时用

市场安装时会**自己**把你的 patch 注册进 profile 的 `cordis.patch.yml`；
本仓库的 `bin/install.mjs` 则是把包名追加进 profile 的 `dsh.profile.bundles`。
两条路同时生效 = 同一个插件被加载两次 → webserver 重复注册路由 → 启动崩溃
（社区 issue #39 就是这个坑）。

所以：**从市场/`dsh plugin add` 装的，就别再跑 `bin/install.mjs --apply`**；
反之亦然，用本仓库安装器装的不要再去市场点一次安装。

### 打包 tarball

```bash
npm run pack:check     # 先看 tarball 里到底装了什么（不落盘）
pnpm pack              # 产出 dsh-agent-log-<version>.tgz
```

`files` 白名单决定内容：`index.js`、`client.js`、`core/`、`bin/`、`cordis.patch.yml`、
`README.md`、`LICENSE`。**`test/` 不在里面** —— 这正好也是安装器判定
「开发检出 / 分发包」的信号（见上）。

### 从 tarball 安装（发布后的真实路径）

```bash
tar -xzf dsh-agent-log-0.2.0.tgz          # 解压出 package/ 目录
node package/bin/install.mjs --apply \
  --source-dir <解压出的绝对路径> --profile desktop
```

安装器会自动用 `file:` 协议（因为解压出来的包里没有 `test/`），
并在结束时确认包名能在 profile 的 `node_modules` 里解析到 —— 解析不到就判失败，
而不是打印一句"安装完成"然后重启后静默不加载。

### 发布到 npm registry 前必须做的两件事

1. **`package.json` 里的 `"private": true` 要删掉。** 它是给"只在本机 link 安装"用的，
   留着会让 `npm publish` / `pnpm publish` 直接拒绝。
   （走 GitHub + 市场这条路**不需要**动它，市场是按仓库安装的。）
2. **registry 与登录态。** 本机 `~/.npmrc` 指向 `https://registry.npmmirror.com/`（只读镜像），
   当前也没有任何登录凭据。要发布得先切到目标 registry 并 `npm login`。

> 注意 pnpm 11 起默认 `minimumReleaseAge: 1440`（新发布的包要满 1 天才允许被解析）。
> 自己发完想立刻在别的机器上装，需要在那台机器的 `pnpm-workspace.yaml` 里
> 设 `minimumReleaseAge: 0`，或把包名加进 `minimumReleaseAgeExclude`。

