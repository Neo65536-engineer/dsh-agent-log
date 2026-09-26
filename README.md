# dsh-agent-log

DSH 插件。从本机的 DSH 会话日志里只读还原一次任务做了什么，输出一份《本次 Agent 工作报告》。

报告内容包括：

- 这次的任务（你的原始输入）
- 用了哪些工具、各调用多少次
- 执行了哪些命令
- 读了哪些文件、改了哪些文件
- 测试有没有通过
- 失败了几次、分别是什么原因
- 消耗了多少 Token
- 最后完成了没有

数据全部来自本机会话日志。插件不联网，不需要 API key，不修改任何会话数据。

## 安装

两种安装方式，二选一。不要都用，否则插件会被加载两次。

### 桌面版（DSH Desktop）

桌面版的 profile 由应用自己管理，命令行改不了，请用应用内的插件管理器：

1. 侧边栏打开「插件」，点「添加插件」
2. 填入 `github:Neo65536-engineer/dsh-agent-log`
3. 点「安装」
4. 装完点「立即启用」。只安装不启用的话，插件不会加载
5. 等几秒，刷新页面（F5）

### 命令行（dsh web）

```bash
dsh plugin --profile web add github:Neo65536-engineer/dsh-agent-log
```

`--profile` 是必填的，要写你实际在跑的那个 profile（`dsh web` 一般是 `web`）。不填会报
`required option '--profile <name>' not specified`。

命令会自动把插件加进 profile 的组合，几秒后生效，不需要重启。

### 确认装上了

新开一个对话，让模型执行：

> 用 work_report 复盘一下这次任务

能出报告就是装好了。也可以在右侧边栏的「+」里找「Agent 工作报告」页签。

安装插件不需要重启 DSH。改动插件源码之后才需要重启。

## 用法

### 1. agent 工具 work_report

```js
work_report({})                                    // 复盘当前会话
work_report({ turns: 3 })                          // 只看最近 3 轮
work_report({ sessionId: "session-2e667305" })     // 指定会话（可只给前几位）
work_report({ format: "json" })                    // 返回结构化数据
work_report({ out: "reports/task.md" })            // 同时写入文件
work_report({ format: "html", out: "报告.html" })   // 生成可打印的 HTML
```

`out` 用相对路径时，按这次会话的工作目录解析。

### 2. 右侧边栏面板

右侧边栏「+」→「Agent 工作报告」。7 个页签：总览、工具、命令、文件、测试、失败、轮次。

工具条上是刷新、自动刷新、下载 HTML、下载 Markdown、会话选择器。下载的 HTML 是自包含文件，
可以直接打开或打印成 PDF。

面板默认显示它自己所属的那个会话。

### 3. 离线 CLI（不装插件也能用）

在仓库目录下执行：

```bash
node bin/worklog.mjs --list                   # 列出所有会话
node bin/worklog.mjs --latest                 # 最近一个会话的报告
node bin/worklog.mjs <sessionId>              # 指定会话
node bin/worklog.mjs <sessionId> --out r.md   # 写入文件
node bin/worklog.mjs <sessionId> --json       # 输出 JSON
```

日报和周报（把多个会话按时间聚合）：

```bash
node bin/worklog.mjs --period --since today
node bin/worklog.mjs --period --since 7d
node bin/worklog.mjs --period --since week
node bin/worklog.mjs --period --since 30d --out 月报.md
node bin/worklog.mjs --period --since 2026-09-20 --until 2026-09-25
```

`--since` / `--until` 可以用 `today`、`yesterday`、`week`、`7d`、`30d` 或 `YYYY-MM-DD`。

CLI 按 `$DSH_HOME` → `~/.dsh` 的顺序找会话日志，也可以用 `--home <目录>` 指定。

### 4. HTTP 路由

```
GET /plugins/dsh-agent-log/report?format=json&sessionId=...&turns=N
GET /plugins/dsh-agent-log/report?format=markdown
GET /plugins/dsh-agent-log/report?format=html
GET /plugins/dsh-agent-log/report?list=1
```

这条路由挂在 DSH 的 web server 上，和其它接口一样需要认证，未认证请求返回 403。

## 报告里的判定规则

- 测试结果是三态的：通过、未通过、未判定。只有在退出码确实能归因到测试命令时才用它；
  命令被管道接走、或测试后面还有别的语句时会标「未判定」并写明原因，不会算成通过。
  总览与面板也按三态显示（`9（通过 4 / 失败 1 / 未判定 4）`），不会把「未判定」吞掉让数字对不上。
- Windows 上 `… | Select-Object -First N` 会因为 broken pipe 非 0 退出。这类计入「疑似失败」，
  单独列出，不计入失败总数。
- 报告是快照。正在跑的那一轮标成「进行中」。
- 明细表最多列 80 行，「逐轮明细」也最多 80 轮，超出时会写明「只列前 80 条（共 N 条）」。
  总览里的数字始终是全量，完整明细用 `format: "json"` 取，或看侧边栏面板。
- 轮次完成率的分母是**已收尾的轮次**；正在跑的那一轮还没有结论，不计入，报告里会注明。
- 会话日志是多个 zstd 帧拼起来的。如果有帧读不出来，报告**开头**会挂一条醒目提示
  （面板与 HTML 同样有），因为那意味着数字可能偏小，极端情况下结论会与实际相反。
- 没指定会话、插件也拿不到调用方身份时，会复盘最近活跃的会话，并在报告里标注这一点。

## 权限

| 项 | 值 |
| --- | --- |
| 网络 | 不使用，不发任何数据 |
| API key / 凭据 | 不需要 |
| 读取 | `$DSH_HOME/sessions`、`$DSH_HOME/storages/session_projcache` |
| 写入 | 只有显式传 `out` 时才写你指定的那个文件；不写会话数据 |
| 索引 / 缓存文件 | 不建；只有进程内存里 12 份日志的缓存 |

会话日志里是完整的对话内容，所以导出的 HTML / Markdown 报告也包含这些内容，分享前自己确认一下。

## 出问题

**装了，但工具和面板都没有。**
确认桌面版点过「立即启用」——只安装不启用的话插件不会加载。然后刷新页面。再确认没有同时用
两种方式安装。

**面板顶部有黄色提示「宿主加载的是旧版插件模块」。**
这是改过插件源码之后的状态。Node 的 ESM 模块一旦加载就缓存住，HMR 只处理 Loader 条目的增删，
不会重新加载改过的宿主模块。重启 DSH 即可。只安装、不改代码的话不会出现。

**面板里「工具」「命令」「文件」是空的，但「总览」正常。**
同上：客户端已经是新的，宿主还是旧的。重启 DSH。

**报告里的数字和预期不一样。**
检查是否用了 `turns` 参数——用了之后总览会按截断后的轮次重算，报告开头也会写明
「本报告只统计最近 N 轮」。另外看总览下面的疑似失败说明。

**复盘到的是别的会话。**
只在没指定 `sessionId`、且插件拿不到调用方身份时发生，报告里会标注。显式传 `sessionId` 即可。

**报告太长。**
明细表默认截到 80 行。要完整数据用 `format: "json"`，或者看侧边栏面板（面板读的是完整数据）。

## 兼容性

- DSH：0.1.5-rc.3、0.1.7-rc.1（桌面版）、0.1.7-rc.2（`dsh web`）实测可用
- Node：>= 20
- 运行时依赖：无。不需要 `npm install`，不需要构建
- 会话日志格式 v0–v4

升级 DSH 后可以用这两条确认插件还正常：

```bash
node bin/verify-loaded.mjs     # 确认 work_report 在工具列表里
node bin/verify-compose.mjs    # 确认插件还在 profile 的组合树里
```

## 卸载

- 应用内装的：侧边栏「插件」→ dsh-agent-log → 卸载
- 命令行装的：`dsh plugin --profile <你的 profile> remove dsh-agent-log`
- 用仓库安装器装的：`node bin/install.mjs --rollback`（回滚到安装前的状态）

## 开发

见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 许可

MIT
