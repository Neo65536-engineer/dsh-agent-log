# dsh-agent-log 开发文档

面向维护者。用户请看 [README.md](README.md)。

---

## 目录

- [代码结构](#代码结构)
- [它依赖什么](#它依赖什么)
- [数据源](#数据源)
- [本地安装（仓库安装器）](#本地安装仓库安装器)
- [开发环境准备](#开发环境准备)
- [测试](#测试)
- [组合验证与加载验证](#组合验证与加载验证)
- [⚠️ 绝不要把安装器挂成生命周期钩子](#-绝不要把安装器挂成生命周期钩子)
- [发布](#发布)
- [踩过的坑（已修，勿回退）](#踩过的坑已修勿回退)
- [已知的、非缺陷的行为](#已知的非缺陷的行为)

---

## 代码结构

```
index.js              宿主侧插件入口：注册 work_report 工具 + 只读 HTTP 路由
client.js             浏览器侧：右侧边栏面板（自注册，无构建）
core/session-log.mjs  会话日志读取（多帧 zstd 切割、事件解析、投影缓存）
core/collect.mjs      事件流 → 工作记录模型（工具/命令/文件/测试/失败/Token）
core/render.mjs       工作记录模型 → Markdown 报告
core/period.mjs       跨会话按时间聚合 → 日报/周报
core/html.mjs         Markdown → 自包含 HTML 文档
core/time.mjs         时间戳格式化的唯一出口（本地时间 + 时区标注）
bin/install.mjs       本机安装器 / 回滚器（默认只读预检）
bin/dev-setup.mjs     开发期：把 node_modules/@deepseek-ai 链到真实 DSH 运行时
bin/worklog.mjs       离线 CLI（不装插件也能用）
bin/verify-compose.mjs 组合验证（造临时 profile 后 dump）
bin/verify-loaded.mjs  加载验证（读会话日志确认工具已注册）
test/                 14 个离线验收文件 + 两个下划线开头的共享模块
```

**产物型仓库**：纯 ESM 源码即产物，没有 `scripts.build`，不需要构建。
`files` 白名单决定发布内容：`index.js`、`client.js`、`core/`、`bin/`、
`cordis.patch.yml`、`README.md`、`DEVELOPMENT.md`、`LICENSE`。
**`test/` 不在里面** —— 这正好也是安装器判定「开发检出 / 分发包」的信号。

---

## 它依赖什么

### 一、包依赖：**零运行时依赖**

```jsonc
// package.json 里没有这些字段，是刻意的
"dependencies":      // 不声明 —— 零运行时依赖
"peerDependencies":  // 不声明 —— 见下面「为什么不声明 peerDependencies」
"devDependencies":   // 不声明 —— 测试用到 DSH 校验器时走 dev:setup 建的 junction
```

源码里**只 import Node 内建模块**（`node:fs` / `node:path` / `node:zlib` / `node:url` /
`node:child_process` / `node:os`），**没有一处 `import`／`require` 任何 `@deepseek-ai/*` 包**。
自证（只匹配真正的 import 语句，注释里提到包名不算）：

```bash
grep -rnE "^\s*(import .* from|.*require\()['\"]@deepseek-ai" index.js client.js core bin \
  && echo "↑ 有命中就说明耦合了宿主包" || echo "✓ 零宿主包依赖"
```

因此安装不需要 `npm install`、不需要构建、不需要联网。

### 二、它实际依赖的是**宿主契约**

零包依赖不等于零耦合 —— 真正要盯的是这些**宿主接口**：

| 方向 | 用到的契约 | 用在哪 |
| --- | --- | --- |
| 宿主 | `ctx.get('tools').register({ name, description, parameters, output, execute })` + `ctx.effect` | 注册 `work_report` 工具 |
| 宿主 | `ctx.inject(['webServer'])` → `webServer.register({ kind: 'prefix', path, handler })` | 只读 HTTP 路由（**可选依赖**：headless profile 没有它时插件照常激活，只是不挂路由） |
| 宿主 | `exec.agent.session.header.id` | 判定"当前是谁的会话"（拿不到时**不回退到"最近被改动的会话"**） |
| 宿主 | Cordis 生命周期 `apply` / `inject` / `effect` / `ctx.logger` | 插件入口 |
| 宿主 | **服务是单例**：同一个 ctx 反复 `get('webServer')` 返回同一个对象 | 重复注册守卫按实例记账，依赖这条语义 |
| 客户端 | `sidebarRightTabs.register(...)` + `slots.register('sidebar.right.pane.tab', ...)`，`inject: ['@deepseek-ai/dsh-client-ui-sidebar-right']` | 右侧边栏面板 |
| 客户端 | `props.sessionId` | 面板绑定自己所属的会话 |
| 数据 | 会话日志 `sessions/<ws>/<sid>/session[.vN].jsonl.zstd` | 全部数据的来源 |
| 数据 | `storages/session_projcache/sessions/<sid>.json` 的 `tokenUsage.totals` / `sessionStats` | Token 与步数的权威值 |

### 三、实测过的 DSH 版本

| DSH | 形态 | 结论 |
| --- | --- | --- |
| 0.1.5-rc.3 | Web（`dsh web`，runner 安装） | 开发期全程在此版本 |
| 0.1.7-rc.1 | 桌面版（`dsh-plugin-desktop` 内置） | 工具注册、路由、面板实测通过 |
| 0.1.7-rc.2 | Web（`dsh web`） | 客户端 bundle 进入 application 批次；宿主路由返回真实数据 |

**升级 DSH 会不会静默坏？** 不会静默坏，但要盯三处：

1. **会话日志格式升级**（如 v4 → v5）。读者按魔数 `28 B5 2F FD` 逐帧切、按 `.vN` 取最高版本，
   v0–v4 都兼容，未知版本会被跳过而不是崩。真出问题会表现为数字变少，而不是报错。
2. **宿主接口改签名**（最可能需要跟的一次）。若 `tools.register` 或 `webServer.register`
   换了契约，现象是**插件激活但工具/面板不出现**。这正是"陈旧模块自检"要防的那类静默故障。
3. **投影缓存路径/字段变动**。只影响 Token 与步数两个权威值，缺失时回落到日志累加值。

为什么不会被版本门禁拦下：DSH 的判定实现在 `@deepseek-ai/dsh-app-boot` 的
`evaluatePluginCompatibility`：

```js
if (!Object.hasOwn(fields, 'peerDependencies')) return void 0;   // 没有该字段 → 直接放行
```

本插件不声明 `peerDependencies`，所以直接放行。反过来，声明了 `@deepseek-ai/dsh-*`
并把版本钉死的插件会被拒绝。

---

## 数据源

```
<DSH_HOME>/sessions/<workspace-slug>/<sessionId>/session[.vN].jsonl.zstd
<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
```

**关键格式事实**：`.jsonl.zstd` 是 **N 个独立 zstd 帧顺序拼接**，不是单帧、也不是长度前缀容器。
Node 的 `zstdDecompressSync` 只解第一帧（曾有文件 1MB 只解出 195 字节），
必须按魔数 `28 B5 2F FD` 切帧后逐帧解压。

事件信封统一为 `{ type, seq, time, data }`。v3 / v4 事件类型兼容。

---

## 本地安装（仓库安装器）

```bash
npm run preflight   # 1. 只读预检（默认行为，绝不动配置）
npm run apply       # 2. 备份 → 改 profile → pnpm install
npm run smoke       # 3. 装后冒烟（从 profile 真实解析并加载宿主/客户端入口）
npm run compose     # 4. 组合验证（确认插件真的进了 DSH 的组合树）
npm run loaded      # 5. 加载验证（读会话日志确认 work_report 已进入工具列表）
npm run rollback    # 需要时回滚到安装前
```

> ⚠️ 入口叫 `apply` 而不是 `install`。**这是刻意的** —— 见
> [绝不要把安装器挂成生命周期钩子](#-绝不要把安装器挂成生命周期钩子)。

### 定位规则（不写死任何机器路径）

- **DSH home**：`--home` → `$DSH_HOME` → `$DSH_PROFILE_DIR/../..` → `~/.dsh`，
  且必须真的含 `profiles/` 或 `sessions/`。
- **profile**：`--profile` → `$DSH_PROFILE` → **已装着本插件的那个** → 唯一的那个 →
  存在 `desktop` 则用它 → 都不成立就**报错并列出候选**（绝不替用户猜一个）。
- header 里会标明每个定位**来自哪条规则**，预检结尾还会回显一条可直接复制的完整命令。

### 备份目录跟随 profile

默认 `<profile>/.dsh-agent-log-backups`（可用 `--backup-dir` 覆盖）。

早先它默认在**插件目录**下（`.install-backups`），有两个真实问题：

1. `file:` 安装时插件目录就在 `<profile>/node_modules/dsh-agent-log` 里，
   下一次 `pnpm install` 可能重建整个 `node_modules`，**唯一的回滚点跟着消失**；
2. 备份天然属于"它改过的那个 profile"，放插件目录下就变成跨 profile 共享 ——
   "跑一次测试把真实安装的备份删了"这种事才可能发生（实测踩过，靠手工备份救回）。

### 两种来源形态：`link:` 与 `file:`（自动判定）

| 形态 | 特征 | 协议 | 为什么 |
| --- | --- | --- | --- |
| **开发检出** | 有 `test/` 或 `.git` | `link:` | profile **直接解析到插件目录本身**：改一行代码立即生效 |
| **下载来的包** | 没有 `test/`、没有 `.git` | `file:` | pnpm 把插件**复制**进 profile 的 `node_modules`：源目录之后可以删/挪 |

```bash
node bin/install.mjs --apply                 # 自动判定
node bin/install.mjs --apply --file          # 强制 file:（分发包）
node bin/install.mjs --apply --link          # 强制 link:（开发检出）
node bin/install.mjs --apply --source-dir D:\pkg\dsh-agent-log
```

`--apply` 是**幂等**的：配置已经是目标状态时不会重复写、也不会产生多余备份。
`--rollback` 取**最早**的那份备份，即插件安装前的状态。

### 装完**不需要**重启

profile 组合里挂着 `@deepseek-ai/dsh-hmr`，启用普通插件会**新增 Loader 条目**，
于是安装完成后几秒内就被热挂载（实测：安装完成 07:24:35 UTC，07:24:40 的工具列表里
就出现了 `work_report`）。

| 部分 | 生效方式 |
| --- | --- |
| 宿主侧（`work_report` 工具、HTTP 路由） | 安装时 HMR 自动挂载 |
| 客户端侧（右侧边栏面板） | 同上走 HMR；没出现就刷新页面（F5） |
| 兜底 | 重启 DSH 一定生效 |

**但改代码之后是另一回事：宿主模块不会热重载。** Node 的 ESM 模块一旦加载就缓存住，
而 HMR 只处理 Loader 条目的增删。这会造成最难查的状态：**客户端是新的，宿主是旧的** ——
真实症状是面板「工具 / 命令 / 文件」三个页签恒为空，而「总览」和「失败」正常。

| 改了什么 | 生效方式 |
| --- | --- |
| `client.js`（面板） | 刷新页面（F5）通常即可 |
| `index.js` / `core/*.mjs`（宿主） | **必须重启 DSH** |

插件会自己检测并报出来（启动与每次请求对照磁盘 mtime），
在日志、工具输出、路由 payload 的 `diagnostics.freshness`、以及**面板顶部黄色横幅**里显示。

---

## 开发环境准备

新克隆的仓库**没有** `node_modules`，而 `test/offline-check.mjs` 需要用 DSH 自己的
`assertSupportedJsonSchema` 校验手写 schema（那是"schema 合法 ⇒ 插件能注册"的唯一真凭据）。
先跑一次：

```bash
npm run dev:setup     # 自动探测 DSH 运行时，建立 node_modules/@deepseek-ai 链接
```

探测顺序：`--from` / `$DSH_RUNTIME_NODE_MODULES` → `$DSH_HOME/runner` → `$DSH_HOME` →
各 profile 的 `node_modules`。一个都找不到时它会打印问过的每个位置并退出 1。

**这个链接只给测试用**；插件运行时不需要它。

---

## 测试

```bash
npm run verify          # 全部离线验收（逐个跑完再汇总）
DSH_REQUIRE_VALIDATOR=1 npm run verify   # 发布前：缺校验器/主题包就判失败，不允许跳过
```

`verify` 走 `test/run-all.mjs`：**逐个跑完再汇总**，不用 `a && b && c` 串联。
串联的后果是第一个失败文件一挂后面全都不跑，而命令只显示「失败」——覆盖被静默截断。

| 测试 | 覆盖 | 规模 |
| --- | --- | --- |
| `offline-check.mjs` | 工具定义 + DSH 真实 schema 校验器 + execute 通路 + 数据一致性 | 26 项（缺校验器时跳过 2 项） |
| `host-apply-check.mjs` | 宿主 `apply()`：工具注册、路由契约、可选依赖缺失、handler 真跑、**重复注册守卫** | 30 项 |
| `client-check.mjs` | 客户端：ModuleLoader 契约、tab 注册、组件构造、主题 token 存在性 | 38 项（缺主题包时跳过 1 项） |
| `panel-data-check.mjs` | 面板各页签的数据通路 + 布局/下载护栏 | 53–54 项（有一条是数据相关的） |
| `keys-check.mjs` | 7 个页签全渲染，逐查兄弟节点 key 唯一性 | 9 项 |
| `install-check.mjs` | 安装/回滚端到端（沙箱里真跑 `--apply` + `--rollback`）+ **不改 pnpm 配置** + **备份落在 profile 里** | 51 项 |
| `lifecycle-guard-check.mjs` | **安装链路护栏**：无生命周期钩子、守卫生效、无写死路径、不猜 profile | 26 项 |
| `regression-fixes.mjs` | 历次缺陷的回归：陈旧模块自检、参数校验、会话身份、`out` 基准、HTML 文档、测试栏三态、**时间戳口径**、**明细上限** | 141 项 |
| `regression-round2.mjs` | 第二轮用户侧评审的回归：**默认 home 兜底**、**表格列数一致**、**完成率单一口径**、**逐轮明细封顶**、**周报截断说明** | 26 项 |
| `regression-round3.mjs` | 第三轮畸形输入排查的回归：**分帧魔数误切**、`todos` 形态、**`deliverables.files` 不可迭代**、元信息归一、`usage` 数值污染、`turn` 非整数、规模悬崖、NUL/半截 ESC | 39 项 |
| `property-check.mjs` | **属性测试**：3 种子 × 250 条随机污染流的不变量 + 幂等/重算 + 30 组读帧往返 | 3 组（覆盖 750 条流） |
| `panel-vs-report-check.mjs` | **跨面一致性**：面板总览逐行 vs markdown，15 项/会话 + 刷新失败不清屏 | 12 项 + 全量会话 |
| `token-guard-check.mjs` | 反向验证 token 校验逻辑本身能抓到坏 token | 1 项（缺主题包时跳过） |
| `robustness-check.mjs` | **边写边读**：任意位置截断、退化输入、目录边界 | 20 项 |
| `postinstall-smoke.mjs` | **装后冒烟**：从 profile 解析、宿主/客户端入口能加载、门禁通过 | 27 项 |
| `accuracy-audit.mjs` | **逐会话对照 DSH 权威投影缓存** | 全部会话 |
| `usage-semantics-check.mjs` | Token 累加口径判定（逐条累加 vs 取最大） | 全部会话 |
| `step-semantics-check.mjs` | 步数口径判定（`step/start` vs `step/end`） | 全部会话 |

### 「跳过」是一种独立结果

零依赖仓库在新克隆上**必然**缺 DSH 的校验器与主题包。早先这类情况直接判失败，
于是 `npm run verify` 在干净克隆上必红一项，而红的原因跟代码质量毫无关系。
现在它们是 `⏭ 跳过`：`通过 N · 失败 0 · 跳过 K`，退出码 0。
发布前用 `DSH_REQUIRE_VALIDATOR=1` 把跳过重新变成失败。

### 语义正确性测试

`accuracy-audit` / `usage-semantics-check` / `step-semantics-check` 回答的不是
"代码能跑吗"，而是"**数字是对的吗**"：它们逐会话对照 DSH 权威的投影缓存。

它们用 `test/_live.mjs` 判定"活跃会话"：**只把 `DSH_SESSION_ID` 当活跃会话是错的** ——
并发子代理会话的投影缓存还没写进去，会被判「非活跃必须完全一致」而必红，
且失败集合每轮都在变。现在按日志 mtime 判定活跃，并**对任何会话都硬性要求「不许比权威少」**
（"我比权威多"在活跃会话上是允许的竞态）。

### 测试不许写死机器路径

`test/_home.mjs` 提供 DSH home 与运行时包文件的定位（`$DSH_HOME` → `$DSH_PROFILE_DIR/../..` → `~/.dsh`）。
`lifecycle-guard-check.mjs` 会扫描全部 `bin/*.mjs` 与 `test/*.mjs`，
禁止把 `C:\...` 这类绝对路径当默认值或当路径基址 —— 这条护栏是补上来的：
早先 8 个文件各自写着 `process.env.DSH_HOME || 'E:\\tools\\dsh'`，作者机器成了所有机器的默认值。

### 第二轮评审：为什么护栏全绿还是漏了两个高危

这一轮的两个高危都不是"代码写错了"，而是**验证方式本身有盲区**。记在这里，因为它们比 bug 本身更容易复发：

**1）同一类错误有两种形态，护栏只覆盖了其中一种。**
上面那条护栏抓的是「**写死了**机器路径」。但同一个错误还有另一种形态 ——
「**缺少兜底**」：`index.js` 的 `detectHome()` 一个写死路径都没有（所以护栏满意），
它只是**没有** `~/.dsh` 那一级。而 `bin/` 与 `test/` 下的 6 处同胞实现全都有。
结果：桌面版靠启动器 `set DSH_HOME=...` 幸免，`dsh web` 在默认安装的机器上整个插件不可用。
**教训：护栏要断言"该有的都在"，而不只是"不该有的都没有"。** 现在由
`regression-round2.mjs` 第 1 节真的把 `DSH_*` 清空、把 home 指到临时目录来验。

**2）测试只断言"字段在不在"，不断言"两个面说的是不是同一件事"。**
「轮次完成率」面板与 markdown 各除一遍、分母还不同（100% vs 50%）；
「测试」那一行两个面都只写三态里的两态（9 次测试显示成「通过 4 / 失败 1」）。
**同一个事实被算了/渲染了多次，而没有任何一条断言去比对它们。**
修法不是"记得同步改两处"，而是让它只有一个出处：完成率在 `collect.mjs` 的 `finalize()`
里算一次存进 `totals.completionRate`，面板与渲染器都只读它。
`panel-vs-report-check.mjs` 则把这类接缝**变成常驻断言**（15 项/会话逐字比对）。

**3）数据依赖的断言会在别人机器上、或者同一台机器的另一个时刻变红。**
`regression-fixes.mjs` 数命令表行数时用的正则，把「五、测试」表的行也数了进去
（两张表的行形状一模一样），而样本会话是按 mtime 动态挑的 ——
同一份代码同一台机器，20 分钟内先红（rows=83）后绿（rows=80）。
**教训：凡是"数某种行/某种元素"的断言，必须先把范围限定到那一段里**，
否则它会随数据漂移。新测试一律优先用**合成夹具**（`regression-round2.mjs` 的 `synthRecord`），
只在"必须证明真实数据也干净"时才扫真实会话，且扫描只用来加强、不用来定成败。

**4）断言必须经过变异验证。** 一个"永远绿"的测试和没有测试是一样的。
本轮 6 处修复都用脚本逐个改回旧行为、确认新断言真的会红
（`_probe/mutation-check.mjs` 的做法：复制到临时目录 → 改回缺陷 → 跑测试 → 必须红）。
这条不是空话：第一遍变异就有 **1/8 逃逸** —— `maxTotalTokens` 退回 `?? 0` 时测试仍然绿，
因为 `Math.max` 会把 `'9'` 这种字符串**强转**成数字，我原来的样本恰好是能转的那种。
换成 `'abc'` 与对象之后才抓住。**样本要挑"最坏"的那个值，不是"典型"的那个。**

### 第三轮：造畸形输入，而不是继续读代码

前两轮都是"读代码找错"，各自都有漏网。第三轮换成**主动造畸形输入去撞**，
一下撞出 6 个高危 —— 说明"读"和"撞"覆盖的是不同的空间：

- **读代码**擅长发现"逻辑写错了"；**造输入**擅长发现"没人想过这种输入"。
  本轮最典型的三个：`t.todos` 是**字符串**（字符串也有 `.length`，`?.length` 守卫形同虚设）、
  `usage` 字段是字符串（`+=` 变成字符串拼接，**不报错**，报告印出 `00[object Object]`）、
  `Math.max(0, ...turns.map(...))` 在十万轮级别爆栈（参数个数有实现上限）。
- **"不报错"比"报错"危险得多。** 上面第二条不会抛异常、不会告警，
  用户看到的是一个"看起来像数字"的东西。凡是把外部数据加进汇总的地方，
  都必须显式 `Number.isFinite(Number(v))` 兜底，不能靠 `?? 0`（`??` 只挡 null/undefined）。
- **分帧那条是"机制成立、真实数据未命中"。** zstd 对不可压缩内容用 raw block **原样存储**，
  所以明文里的 `28 B5 2F FD` 会出现在压缩流内部，被魔数扫描当成新帧起点 ——
  真帧被切成两段、两段都解不出、**整帧事件消失**（实测 18 条→0 条，
  结论从「任务完成」翻转成「还没有任务轮次」）。本机 55 份真实日志 0/55 命中，
  所以它从来不会在开发时暴露。修法不是"把 damaged 写进报告"（那是治症状），
  而是**解不开就并上下一帧再试**：先试最近的魔数边界，失败就往后并。
  正常路径开销不变，误切时能把整帧救回来。
- **凡是"少算了"，报告必须说出来。** 帧损坏现在挂在**正文开头**（不是页脚一行小字）——
  读者先看结论，走不到页脚。面板与 HTML 同样有横幅。

### 第四轮：属性测试（让生成器去找，而不是我去想）

第三轮是"我手工造畸形输入"，仍然受限于**我能想到什么**。第四轮换成属性测试：
带种子的随机生成器往每个字段里塞 `null/数字/字符串/数组/对象`，
用**不变量**（交叉求和、三态自洽、输出卫生、幂等、读帧往返）判定，而不是预期输出。

第一条跑出来就抓到手工三轮都没碰到的东西：

- **`for (const f of d.files ?? [])` 会抛 `number 3.14 is not iterable`。**
  `??` 只挡 `null`/`undefined`，**数字/对象不可迭代**。800 条随机流里 **103 条**走到这里，
  也就是说一条畸形的 `deliverables/presented` 事件就能让整次 `work_report` 失败。
  同一形状的还有 `todos?.length`（字符串也有 length，见第三轮）——
  **`?.` / `??` 不是类型守卫**，这是本项目反复踩的同一个坑，第几次了。
- **元信息直接渲染原始值**：`session.id` / `cwd` / `title` / `permissions.*` /
  `approval.toolName` / 失败条目的 `file` 非字符串时，报告里就是 `[object Object]`。
  这些都在"采集时归一"比"渲染时兜底"更省事。

一条重要的**测试设计**教训：生成器的取值表里**不能**放 `'NaN'` / `'Infinity'` /
`'[object Object]'` 这些**字符串** —— 它们正是"输出卫生"要抓的 token，
而作为字符串数据出现是完全合法的（用户内容里就可能写）。放进去会让断言变成假阳性，
把真问题淹掉。第一版就是这么写的，去掉之后才看清真正的 49 处。

多试种子很值：6 个种子里 5 个干净，第 6 个（seed=1）才撞出审批记录里的 `toolName`。
现在固化为 3 个种子 × 250 条，确定性可复现（不像按 mtime 挑样本那样会漂移）。

---

## 组合验证与加载验证

`desktop` profile 由 Electron 应用独占管理，`dsh --profile desktop --dump-config`
会被直接拒绝（`error: profile "desktop" is managed exclusively by the Electron application`），
所以没法直接 dump 真实 profile 的组合结果。

`npm run compose`（`bin/verify-compose.mjs`）的办法是造一个**临时 profile**：
复制真实 profile 的配置文件，`node_modules` 用 **junction 复用**（不复制，秒级完成），
再用 app 自带的 dsh CLI dump 它。确认 `cordis.patch.yml` 合法、bundle 被识别、
插件确实进了组合树。脚本最后会删掉临时 profile，并检查源 profile 的 `node_modules`
未被 junction 清理误伤（**必须先删 junction 再删目录，顺序反了会连带删掉目标内容**）。

`npm run loaded` 直接从会话日志读最近一次 `request/header` 的工具列表来判定是否已加载：

```
$ npm run loaded
  ✓ 工具列表里出现了 `work_report` —— 插件已加载
```

> 为什么不用 HTTP 探路由：DSH 的 web server 对**所有**未认证请求返回 403
> （连 `/` 和随机路径都是 403），外部探测无法区分「路由不存在」与「被拒绝」。

---

## ⚠️ 绝不要把安装器挂成生命周期钩子

**这是本项目发生过的最严重的一次事故，写在这里防止回退。**

曾经的 `package.json` 里有：

```jsonc
"install": "node bin/install.mjs --apply"   // ❌ 永远不要再加回来
```

`install` 是 pnpm/npm 的**生命周期钩子**，不是普通脚本。后果是一条完整的故障链：

1. **pnpm 11 会拦下它**（`ERR_PNPM_IGNORED_BUILDS`）→ 整个 `dsh plugin add` 以退出码 1 结束。
   而 DSH 只在 `exitCode === 0` 时才把新 bundle 写进 `dsh.profile.bundles`
   （`@deepseek-ai/dsh-plugin-manager` 的 `reconcile()`）—— 于是**包下载并落盘了，
   但插件没有被启用**，用户重启后什么都没看到，只看到一句 `plugin command failed`。
2. **用户按提示授权构建脚本之后更糟**：脚本会在**用户机器上**执行 `--apply`，
   而它当时的目标默认值是写死的 `E:\tools\dsh` + `desktop`。
   - 在别的机器上 = 那个目录不存在 → 预检失败 → 退出码 1 → pnpm 报 `ELIFECYCLE`
     → **整个安装失败**；
   - 在有那个目录的机器上 = 它去改**那个** profile，跟用户在装哪个 profile 毫无关系。
     实测：往一次性 profile 里装插件，它把作者**正在使用的** desktop profile 的依赖
     从 `link:` 改指到了那个临时目录，还往 profile 的 `pnpm-workspace.yaml` 里塞了
     一行 `allowBuilds: … set this to true or false` 占位。
3. 起因只是想让 pnpm 11 的 `strictDepBuilds` 门禁不报错 —— 安装器当时会往用户 profile
   写 `strictDepBuilds: false`。**拿用户的一道供应链门禁去绕开自己的缺陷，代价完全不对等。**

现在的状态：

- `package.json` **没有** `install`/`postinstall`/`prepare` 钩子，自安装入口是 `npm run apply`；
- `bin/install.mjs` 入口处有守卫：`npm_lifecycle_event` ∈ install 系列 **且** cwd 在
  `node_modules` 里 → 打印说明并**退出 0**（非 0 会连累整个安装）；
- `bin/install.mjs` 不再修改 profile 的 pnpm 配置；pnpm 若因构建脚本非 0 退出，
  只打印可操作的提示（`pnpm approve-builds` / `allowBuilds`），由用户决定；
- `test/lifecycle-guard-check.mjs` 把这些逐条钉死（26 项）。

---

## 发布

### 进 GitHub / 社区插件市场

收录靠 GitHub topic **`dsh-plugin`**：市场 CI 定期扫描该 topic，命中即自动收录
（其它建议 topic：`dsh`、`deepseek-harness`、`cordis-plugin`）。

自查（第三方检查器，非本项目依赖）：

```bash
git clone --depth 1 https://github.com/AphyTOT/dsh-plugin-preflight /tmp/pf
node /tmp/pf/bin/preflight.js --dir . --strict     # 期望：No findings
```

### 安装命令写在哪

市场会读 README，并从里面提取 `dsh plugin add` 后面的那一段作为安装 spec
（DSH 插件管理器的对话框也这么告诉用户："包名就是 README 里 `dsh plugin add` 后面的那一段"）。
所以 README 里那条命令必须**和仓库地址一致**（`repository` / `homepage` / `bugs` 三处也要一致）。
本仓库现在的写法是 `github:Neo65536-engineer/dsh-agent-log`
（带 `github:` 前缀：DSH 在 pnpm 因构建脚本失败时会依据这个前缀打印 `allowBuilds` 提示）。

### 版本号必须 bump

市场靠版本号判断"有没有更新"。**改代码就要 bump `package.json` 的 `version`**，
否则市场永远不显示「更新」。当前版本见 `package.json`。

### 打包 tarball

```bash
npm run pack:check     # 先看 tarball 里到底装了什么（不落盘）
pnpm pack              # 产出 dsh-agent-log-<version>.tgz
```

### 发布到 npm registry 前必须做的两件事

1. **`package.json` 里的 `"private": true` 要删掉**，否则 `npm publish` 直接拒绝。
   （走 GitHub + 市场这条路**不需要**动它。）
2. **registry 与登录态**：默认 `.npmrc` 可能指向只读镜像，需要先切 registry 并 `npm login`。

> pnpm 11 起默认 `minimumReleaseAge: 1440`（新发布的包要满 1 天才允许被解析）。
> 自己发完想立刻在别的机器上装，需要在那台机器上设 `minimumReleaseAge: 0`，
> 或把包名加进 `minimumReleaseAgeExclude`。

---

## 踩过的坑（已修，勿回退）

1. **`type` 不能是数组。** DSH 的 JSON Schema 子集只接受单个标量 type。
   `type: ['string','null']` 会被 `assertSupportedJsonSchema` 拒绝 → 插件注册失败。
   可空字段应省略 `type`（注释型 schema）。
2. **JSON 格式不能附加说明文字。** 早期版本在 JSON 输出后面拼诊断脚注，导致调用方 `JSON.parse` 失败。
3. **一个会话目录里可能有多份日志，必须按格式版本取最高的。**
   DSH 升级格式时保留旧文件，同目录会并存。按 `readdir` 顺序取第一个会读到旧的不完整文件 ——
   **静默少算**。实测某会话因此只读出 1/7 的轮次、39/146 的步数。
   现在按 `.vN` 取最高版本（无 `.vN` 视为 v0）。
4. **步数口径 = 已关闭的步（`step/end`），不是 `step/start`。**
   DSH 对每个进入的步在 `finally` 里恰好追加一条 `step/end`。用 `step/start` 会多算当前正在跑的那一步。
5. **`cacheReadTokens` 是逐条增量，必须相加，不能取最大值。**
   实测逐条累加在 42/42 个会话上与 DSH 权威总量完全一致，取 max 则 0/42 命中。
   （对照：`totalTokens` 确实是累计上下文规模，那个才该取 max。）
6. **`webServer.register` 的路由契约是 `{ kind, path, handler }`**，不是 `{ method, path, handler }`。
   `kind` 取 `'exact'` 或 `'prefix'`。写错不会抛错，是**静默不匹配**。
7. **主题 token 名必须核对，不能凭印象写。** 最初按猜测写了 7 个**不存在**的 token。
   token 写错不会崩，但整个面板会静默退化成"没有样式"。
   `test/client-check.mjs` 会逐个 token 对照主题包校验。
8. **Windows 上无法用 `execFileSync` 调用 pnpm。**
   pnpm 是 `.cmd` 垫片：`execFileSync('pnpm')` → `ENOENT`；
   `execFileSync('pnpm.cmd')` → `EINVAL`（Node 出于安全禁止无 shell 执行 `.cmd`）。
   必须走 `execSync`（带 shell）。这个坑会让安装器报出误导性的「找不到 pnpm」。
9. **`--rollback` 必须取最早的备份。** 取最新会指到"上一次 `--apply` 之前"，
   而那时插件可能已经装好了 —— 回滚完插件还在配置里。配套修法：`--apply` 幂等时**不产生备份**。
10. **测试绝不能与真实安装共用备份目录。**
    这个缺陷真的发生过：跑一次 `install-check` 就把真实安装的备份删了，导致 `--rollback` 失效。
    现在备份默认跟着 profile 走，测试仍可显式 `--backup-dir` 指到自己的沙箱。
11. **宿主模块改完不会热重载**（见上面单列一节）。症状是「面板除了总览全是空白」。
12. **相对 `out` 不能按宿主进程 cwd 解析。** 宿主 cwd 是 Electron 安装目录，
    按它解析会把报告写进应用目录，而报告头却写着会话的工作目录。必须按 `record.cwd` 解析。
13. **面板必须绑定它自己所属的会话。** 路由在缺 `sessionId` 时退回「最近被改动的会话」，
    并发会话一写日志就会把面板抢走。
14. **`process.env.DSH_SESSION_ID` 在宿主进程里是空的。** 它由 `dsh-shell-env`
    **按每次模型 shell 调用**构造给子进程，从不写宿主 `process.env`。
    正解：`exec.agent.session.header.id`；拿不到时**不要静默回退到「最近被改动的会话」**。
15. **测试自身的三个坑（都真的红过）：**
    - 断言不能依赖"最新会话恰好有失败"——那是数据依赖，换一天就红；
    - 不能用 `a && b && c` 串联——第一个文件一挂，后面全部不跑而命令只说"失败"；
    - "活跃会话"不能只认 `DSH_SESSION_ID`——并发子代理会话会被判"非活跃必须完全一致"而必红。
16. **预览文本必须剥掉 ANSI 颜色码。** 否则报告里只剩 `[38;2;140;140;140m` 这种垃圾；
    更糟的是截断会把一条序列**从中间切断**，留下半截 `[38;2;` 永久驻留。
    修法是在源头 `firstLines` 里剥（CSI + OSC 两类）。
17. **"直接跑测试脚本"必须算跑过测试。** 早先只认 `node --test`，而本插件自己的入口是
    `node test/run-all.mjs` —— 于是报告对着自己的测试套件报「测试执行 0」。这是**硬性事实错误**。
18. **`pnpm install` 的非 0 退出不一定代表安装失败**（`ERR_PNPM_IGNORED_BUILDS`）。
    现在不再靠改用户配置去规避，而是打印可操作的提示。
19. **失败路径里的回滚逻辑自己会炸。** `pnpm install` 失败时无条件 `readdirSync(backupDir)`，
    但在"配置已是目标状态"（幂等、未建备份）的分支里 `backupDir` 是 `null` ——
    回滚自身抛错，把真正的 pnpm 报错盖掉。现在按 `backupDir` 是否存在分流。
20. **健壮性测试的基线必须冻结成快照。** `listSessions` 报的 `bytes` 是列目录那一刻的 stat，
    而日志正在被实时追加；测试又去重读原文件，于是"字节数"和"实际读到的字节"不是同一份数据。
    实测这个文件在 0.3 秒内长了 7 万字节，导致断言随机变红。
21. **时间戳口径必须统一。** 表头「生成时间」曾用 `toISOString()`（UTC、且不标时区），
    而命令表用 `getHours()`（本地），同一份报告里差 8 小时；HTML 文档又是第三种。
    现在全部走 `core/time.mjs`：面向人的时间一律本地，精确到秒就带 `(UTC±HH:MM)` 标注。
22. **报告必须封顶。** 报告是要进模型上下文的：1 轮 43 条命令就有约 10KB，
    几百轮的会话会到几十上百 KB。现在明细表默认上限 80 行，超了**明确写出总条数与恢复办法**；
    `totals` 与 `record` 仍是全量（面板与 `format: "json"` 不受影响）。
    HTML 文档是从这份 markdown 渲染的，所以它**也是截断后**的版本 —— 提示语里不能把它说成"完整明细"。
23. **双份加载的兜底应该在插件侧，不在文档里。** 同一个插件被两条路各装一次，
    唯一会**直接崩掉应用**的动作是向 webServer 重复注册同一条路由。
    早先只靠在 README 里叮嘱用户"二选一"——那是把崩溃风险交给用户去记。
    现在按 **webServer 实例**（WeakMap）记账，第二次不再注册并留下日志。
24. **测试用的假 ctx 必须忠实于真实语义。** 早先 `get('webServer')` 每次返回一个新的对象字面量，
    而真实 Host 里服务是**单例** —— 于是"按实例记账"的重复注册守卫在测试里永远不触发，
    等于没测。改成按 ctx 缓存服务实例后，护栏才真的成立。
25. **测试不许写死机器路径。** 早先 8 个文件各自 `process.env.DSH_HOME || 'E:\\tools\\dsh'`，
    作者机器成了所有机器的默认值。现在统一走 `test/_home.mjs`，并由护栏测试把关。
26. **「跳过」必须与「失败」分开。** 零依赖仓库在干净克隆上必然缺 DSH 的校验器/主题包；
    把它们判成失败，会让新克隆第一步就红，而红的原因与代码质量无关。

> ⚠️ **不要用 PowerShell 的 `Get-Content -Raw` / `Set-Content` 改这些源文件。**
> 默认编码不是 UTF-8，会把中文和模板字符串写坏（`Set-Content -Encoding utf8` 还会写 BOM，
> 让 `JSON.parse` 直接失败）。改文件请用带 UTF-8 语义的工具。

---

## 已知的、非缺陷的行为

- **当前活跃会话的数字可能略领先于投影缓存。** 报告先读日志再读缓存，会话在这两次读之间
  又追加了事件。允许"我比权威多"，不允许"我比权威少"。
- **活跃会话的步数可能比权威多 1**，因为那一步正在跑、还没写 `step/end`。
- **读到残缺的最后一帧是常态**（日志被边写边读）。读者会跳过它并把数量记在
  `diagnostics.damagedFrames`，不影响之前所有完整帧。
- **`panel-data-check` 的断言数会在 53/54 之间浮动**：其中一条需要"另找一个确有失败的会话"，
  找不到时会打印一行说明并跳过，而不是判失败。
