# dsh-agent-log

**把「这次 Agent 到底干了什么」变成一份能读的报告。**

它从 DSH 的会话日志里**只读**还原一次任务的全过程 —— 用了哪些工具、读了改了哪些文件、
跑了哪些命令、测试过没过、失败过几次为什么、花了多少 Token、最后有没有做完 ——
并输出一份《本次 Agent 工作报告》。

- 全程离线，不联网、不需要 API key，不上传任何数据
- **不写**任何会话数据（只读会话日志）
- 零运行时依赖，装上即用

适合：任务复盘、写日报周报、排查某轮为什么失败、统计 agent 花了多少成本。

---

## 快速开始

### 如果你用的是 DSH 桌面版（DSH Desktop）

桌面版的 profile 由应用自己管理，命令行改不了它，请走应用内：

1. 侧边栏打开 **插件** → **添加插件**
2. 输入这一行（包名或地址）：

   ```
   github:Neo65536-engineer/dsh-agent-log
   ```

3. 点 **安装**；装完后点 **立即启用**（这一步别漏，否则装上了但没启用）
4. 等几秒，**刷新一下页面**

> 新版 DSH 装了插件会新增 Loader 条目，HMR 会热挂载，**正常不需要重启**。
> 面板没出现就刷新一次页面（F5）。

### 如果你用的是 `dsh web`

```bash
dsh plugin --profile web add github:Neo65536-engineer/dsh-agent-log
```

- `--profile` 是**必填**的，值必须是**你实际在跑的那个 profile**（`dsh web` 通常是 `web`）。
  不填会直接报 `required option '--profile <name>' not specified`。
- 命令会自动把插件加进该 profile 的组合并在几秒内热挂载，**不需要重启**。

### ⚠️ 两条路只用一条

应用内安装 与 `dsh plugin` 命令行安装是**两种机制**：前者注册进 profile 的
`cordis.patch.yml`，后者写进 `dsh.profile.bundles`。两条都用 = 同一个插件被加载两次。

插件现在会自己挡住"重复注册同一条 HTTP 路由"（那是双份加载唯一会直接崩掉应用的动作），
但**仍然请只选一条**：重复加载会多占一份内存，也会让日志变吵。

### 怎么确认真的装上了

不管哪条路，装完后**新开一个对话**，问模型：

> 用 work_report 复盘一下这次任务

能出报告就是装好了。也可以看右侧边栏的「+」里有没有 **Agent 工作报告** 这个页签。

---

## 装完能得到什么

### 一、让模型生成报告（agent 工具 `work_report`）

在对话里直接说，或让模型自己决定调用：

```
work_report({})                                    # 复盘当前会话
work_report({ turns: 3 })                          # 只看最近 3 轮（长会话聚焦）
work_report({ sessionId: "session-2e667305" })     # 复盘别的会话（可只给前几位）
work_report({ format: "json" })                    # 要结构化数据自己处理
work_report({ out: "reports/task.md" })            # 同时落盘
work_report({ format: "html", out: "报告.html" })   # 生成可下载/可打印的 HTML
```

`out` 是相对路径时会按**这次会话的工作目录**解析（不是 DSH 自己的安装目录）。

### 二、右侧边栏面板

右侧边栏「+」→ **Agent 工作报告**。7 个页签：
**总览 / 工具 / 命令 / 文件 / 测试 / 失败 / 轮次**。

工具条上有 **刷新 · 自动 · HTML 下载 · .md 下载 · 会话选择器**。
「HTML 下载」给出的是一份自包含文档（内联样式、无外部依赖），可直接双击打开或打印成 PDF。

面板默认绑定**它自己所属的会话**；如果你手动切换，它会明确标注当前展示的是哪个会话。

### 三、离线 CLI（不用装插件也能用）

在仓库目录里：

```bash
node bin/worklog.mjs --list                  # 列出所有会话
node bin/worklog.mjs --latest                # 最近一个会话的报告
node bin/worklog.mjs <sessionId>             # 指定会话
node bin/worklog.mjs <sessionId> --out r.md  # 写入文件
node bin/worklog.mjs <sessionId> --json      # 结构化输出
```

**日报 / 周报**（跨会话按时间聚合）：

```bash
node bin/worklog.mjs --period --since today        # 今天
node bin/worklog.mjs --period --since 7d           # 最近 7 天
node bin/worklog.mjs --period --since week         # 本周（周一起）
node bin/worklog.mjs --period --since 30d --out 月报.md
node bin/worklog.mjs --period --since 2026-09-20 --until 2026-09-25
```

`--since` / `--until` 接受 `today` / `yesterday` / `week` / `7d` / `30d` / `YYYY-MM-DD`。

CLI 需要能找到会话日志：默认按 `$DSH_HOME` → `~/.dsh` 找，也可以用 `--home <目录>` 显式指定
（显式指定后不会静默退回别的目录）。

### 四、HTTP 路由（高级用法）

```
GET /plugins/dsh-agent-log/report?format=json&sessionId=...&turns=N
GET /plugins/dsh-agent-log/report?format=markdown
GET /plugins/dsh-agent-log/report?format=html
GET /plugins/dsh-agent-log/report?list=1        # 最近会话列表
```

这条路由挂在 DSH 自己的 web server 上，**受宿主的鉴权保护**：
未认证请求（包括 `/`）统一返回 403。它本身没有也不该有独立的鉴权。

---

## 报告里写的是什么

| 你想知道 | 报告里的位置 | 数据来源 |
| --- | --- | --- |
| 任务是什么 | 逐轮明细里的「任务」 | 你的原始输入 |
| 用了哪些工具 | 二、用了哪些工具 | `tool/call` 的 `name` 直方图 |
| 跑了哪些命令 | 三、运行了哪些命令 | `pwsh` / `bash` 的 `command` |
| 读了 / 改了哪些文件 | 四、文件 | `read` / `write` / `edit` 等调用的路径参数 |
| 测试过没过 | 五、测试是否通过 | 测试运行器自己打印的汇总优先，退出码兜底 |
| 失败过几次、为什么 | 六、失败原因 | `tool/result.error`（权威）+ `[exit code: N]`（兜底） |
| 花了多少 Token | 一、总览 | 逐条累加 + DSH 投影缓存的会话总量 |
| 最后做完了没有 | 表头「结论」 | `turn/end.reason.kind` |

三件它**刻意不做**的事：

1. **不谎报测试通过。** 判定是三态的：通过 / 未通过 / **未判定**。
   退出码只有在能归因到测试命令时才用；命令被管道接走、或测试后面还有别的语句时，
   退出码其实来自别人 —— 这时标「未判定」并写明原因，绝不猜。
2. **不把假阳性算成失败。** Windows 上 `… | Select-Object -First N` 会因为 broken pipe
   非 0 退出。这类降级为**疑似**，单独成节，不混进失败总数 —— 否则报告会被噪音淹没。
3. **报告是快照。** 正在跑的那一轮会被诚实标注为「进行中」，不会把"还没结束"说成"0 秒完成"。

---

## 隐私与权限（装之前你该知道的）

| 项 | 值 |
| --- | --- |
| 云端依赖 | **无**。不发任何数据到远端 |
| 离线可用 | **是**。全部逻辑都在本地读日志文件 |
| 凭据 / API key | **不需要**，也不存储任何凭据 |
| 文件系统 | **只读** `$DSH_HOME/sessions`、`$DSH_HOME/storages/session_projcache` |
| 会不会改我的东西 | 不改。**不写会话数据**；只有你显式传 `out` 时才往你指定的路径写报告 |
| 数据保留 | 无。不建索引、不建缓存文件（只有进程内存里 12 份日志的 LRU 缓存） |
| 网络权限 | `none` |

> 顺带说明：会话日志里保存着**完整的对话内容**。报告是从它派生出来的，
> 所以下载下来的 HTML / Markdown 报告同样包含这些内容 —— 分享前请自己过一遍。

---

## 常见问题

**装完了，但工具和面板都没出现。**
按顺序检查：
1. 桌面版是否点了 **立即启用**？（只是"安装"不会启用）
2. 刷新一次页面（F5）。装了插件会新增 Loader 条目，HMR 会热挂载。
3. 是不是同时用两条路装了两次？只保留一条。
4. 面板顶部有没有黄色横幅？有的话它自己会说要重启 —— 见下一条。

**面板顶部出现黄色横幅「宿主加载的是旧版插件模块」。**
这说明**你改过插件的源码**：Node 的 ESM 模块一旦加载就缓存住，HMR 只处理 Loader 条目的
增删，**不会因为文件被编辑而重新 import 宿主模块**。请重启 DSH。
（只装插件、不改代码的话不会遇到这件事。）

**面板里「工具 / 命令 / 文件」三个页签是空的，但「总览」正常。**
同上：客户端已经是新的（页面会重新拉 bundle），宿主还是旧的。
重启 DSH 即可。插件会自己检测并报出这个状态，不会让你去猜。

**报告里的数字和我以为的不一样。**
先看「一、总览」下面的两条脚注：疑似失败、以及"进行中"的说明。
再看是不是用了 `turns` 参数 —— 传了 `turns` 之后，**总览会按截断后的轮次重算**，
报告头部也会明确写"本报告只统计最近 N 轮"。

**长会话的报告特别长。**
报告是要进模型上下文的，所以明细表有行数上限（默认 80 行），超了会写明
"此处只列前 80 条（共 N 条）"。**总览里的数字始终是全量**。
要完整明细就用 `format: "json"`（agent 工具）或 `format=json`（HTTP 路由），
或者看侧边栏面板 —— 面板读的是完整数据，不受这个上限影响。

**为什么「结论」是「⏳ 进行中」？**
报告是快照。当前这一轮还没写结束事件，所以它如实说"进行中"，而不是编一个结论。

**复盘出来是别人的会话。**
只会在你**没有指定会话、而且插件拿不到调用方身份**时发生，此时报告里会显式标注
"未指定会话，本次复盘的是最近活跃的会话"。显式传 `sessionId` 即可。
（插件不会把并发子代理或另一个窗口的会话当成你的。）

**存了很多会话，报告会不会很慢？**
日志是 zstd 压缩的、按需读取，解析结果按 (文件, 大小, mtime) 缓存，只保留最近 12 份。

---

## 兼容性

- **DSH**：0.1.5-rc.3 / 0.1.7-rc.1（桌面）/ 0.1.7-rc.2（`dsh web`）实测可用。
  插件不声明 `peerDependencies`，所以升级 DSH **不会**被版本门禁拦下。
- **Node**：>= 20（用到内置 zstd 解压）
- **运行时依赖**：零。不 import 任何 `@deepseek-ai/*` 包，不需要 `npm install`，不需要构建
- 会话日志 v0–v4 都兼容；未知格式版本会被跳过而不是崩

升级 DSH 后如果怀疑插件没跟上，可以跑：

```bash
node bin/verify-loaded.mjs      # 读会话日志确认 work_report 真在工具列表里
node bin/verify-compose.mjs     # 确认插件仍在 profile 的组合树里（不依赖运行中的 DSH）
```

---

## 卸载

- **应用内装的**：侧边栏「插件」→ 找到 dsh-agent-log → 卸载（会要求确认）
- **命令行装的**：`dsh plugin --profile <你的 profile> remove dsh-agent-log`
  （`remove` 之后 DSH 会顺带把它从 `dsh.profile.bundles` 里摘掉；没摘干净的话手动删那一行）
- **用仓库安装器装的**：

  ```bash
  node bin/install.mjs --rollback
  ```

  回滚取的是**最早**的那份备份，也就是插件安装前的状态。

---

## 开发

架构、测试、发布流程、以及一路上踩过的坑，都在 **[DEVELOPMENT.md](DEVELOPMENT.md)**。

```bash
npm run verify       # 全部离线验收（14 个测试文件）
npm run dev:setup    # 新克隆后先跑这个：把开发期校验器链接起来
```

## 许可

MIT
