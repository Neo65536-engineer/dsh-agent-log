/**
 * 把会话事件流折叠成「工作记录」模型。
 *
 * 覆盖用户要的 8 个维度：
 *   任务 → 用了哪些工具 → 读了哪些文件 → 改了哪些文件 → 跑了哪些命令
 *        → 测试是否通过 → 失败过几次 → 用了多少 Token → 最终有没有完成
 *
 * 只读已提交事件，不改日志。所有字段都能回溯到具体 seq。
 */
import { evType, evData, messageText, toolOutcome, firstLines } from './session-log.mjs'

/** 工具名 → 归类。未列出的走 other。 */
const FILE_READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep'])
const FILE_WRITE_TOOLS = new Set(['write'])
const FILE_EDIT_TOOLS = new Set(['edit'])
const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/**
 * 真正的「跑测试」命令。必须是测试运行器被调用，不能只是命令里出现 test 字样
 * （否则 `$env:PATH = ...` 之类会被误判）。
 *
 * 分成两类是因为"误报"会直接误导用户：
 *   - STRONG：带包装器的明确调用（npm/pnpm/yarn/bun、npx、node --test、pytest、go test…）；
 *   - BARE：光秃秃的运行器名（vitest/jest/mocha/playwright test）——
 *     只有出现在**语句开头**或**由包装器引入**时才算，
 *     否则 `grep vitest package.json`、`Select-String jest` 会被当成"跑过测试"。
 * 两类都会再排除**引号里**的匹配（`echo "npm test"` 只是在打印字符串）。
 */
const TEST_HINTS_STRONG = new RegExp(
  [
    // 加上 verify：很多项目（含本插件自己）把测试套件挂在 `npm run verify` 上
    /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest|check|lint|verify)\b/,
    /\bnpx\s+(?:vitest|jest|mocha|playwright)\b/,
    /\bnode\s+--test\b/,
    // 直接跑测试脚本：`node test/run-all.mjs`、`node tests/all.js`、`node src/x.test.mjs`。
    // 为什么必须算：本插件自己的测试入口就是 `node test/run-all.mjs`，
    // 早先只有 `node --test` 才算，于是「测试是否通过」这一项对着自己的测试套件报 0 ——
    // 报告中「测试执行 0」是硬性事实错误，比漏统计更糟。
    // 只认**测试目录/测试命名**，避免把任意 `node build.mjs` 误算成跑测试。
    /\bnode\s+(?:[\w.@~-]+[\\/])*(?:tests?|__tests__|spec)[\\/][\w.@~-]+\.(?:mjs|cjs|js|ts|mts|cts)\b/,
    /\bnode\s+(?:[\w.@~-]+[\\/])*[\w.@~-]+\.(?:test|spec)\.(?:mjs|cjs|js|ts|mts|cts)\b/,
    /\bpytest\b/,
    /\bpython\s+-m\s+(?:pytest|unittest)\b/,
    /\bgo\s+test\b/,
    /\bcargo\s+test\b/,
    /\bdotnet\s+test\b/,
    /\bgradle\w*\s+test\b/,
    /\bmvn\s+.*\btest\b/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
)

const TEST_HINTS_BARE = /\b(?:vitest|jest|mocha|playwright\s+test)\b/gi

/** 裸运行器名前面允许出现的东西：语句边界，或把命令交给它的包装器。 */
const BARE_CONTEXT_BEFORE = /(?:^|[\n;|&(]|npx|pnpm\s+exec|npm\s+exec|yarn|bunx|--|-c|-Command|--command)\s*$/i

/** 引号区间（简化实现：不处理嵌套与转义花活，够用且不会误伤）。 */
function quotedRanges(cmd) {
  const ranges = []
  let q = null
  let start = 0
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === q) {
        ranges.push([start, i])
        q = null
      }
    } else if (ch === '"' || ch === "'" || ch === '`') {
      q = ch
      start = i
    }
  }
  if (q) ranges.push([start, cmd.length])
  return ranges
}

const insideAny = (ranges, idx) => ranges.some(([a, b]) => idx > a && idx < b)

/**
 * 匹配虽然在引号里，但引号是「把整条命令交给子 shell」的形式
 * （`bash -c "npm test"` / `pwsh -Command "npm test"`）——这种要算真实调用。
 */
function quotedButWrapped(ranges, idx, s) {
  const r = ranges.find(([a, b]) => idx > a && idx < b)
  if (!r) return false
  const before = s.slice(Math.max(0, r[0] - 24), r[0])
  return /(?:^|[\s;&|])(?:-c|-Command|--command)\s*$/i.test(before)
}

/** 该位置应被忽略吗（引号里的字符串，且不是交给子 shell 的那种）。 */
const shouldIgnoreMatch = (ranges, idx, s) => insideAny(ranges, idx) && !quotedButWrapped(ranges, idx, s)

/**
 * 命令里所有"真实调用测试运行器"的匹配（含结束位置）。
 * 排除：引号里的字符串、以及没有语句上下文的裸运行器名。
 */
export function realTestMatches(cmd) {
  const s = String(cmd ?? '')
  const ranges = quotedRanges(s)
  const out = []
  const strong = new RegExp(TEST_HINTS_STRONG.source, 'gi')
  for (let m; (m = strong.exec(s)) !== null; ) {
    if (shouldIgnoreMatch(ranges, m.index, s)) continue
    out.push({ index: m.index, end: m.index + m[0].length, text: m[0] })
  }
  for (let m; (m = TEST_HINTS_BARE.exec(s)) !== null; ) {
    const idx = m.index
    if (shouldIgnoreMatch(ranges, idx, s)) continue
    const before = s.slice(0, idx)
    if (!BARE_CONTEXT_BEFORE.test(before)) continue // 例如 `grep vitest pkg.json`
    out.push({ index: idx, end: idx + m[0].length, text: m[0] })
  }
  return out.sort((a, b) => a.index - b.index)
}

export function hasRealTestInvocation(cmd) {
  return realTestMatches(cmd).length > 0
}

/**
 * Windows 上 `... | Select-Object -First N` 会因为上游拿到 broken pipe 而使
 * 整条管道以非 0 退出——**这不是任务失败**。这类退出码要降级为「疑似」，
 * 否则报告会被大量假阳性淹没。
 */
const PIPE_TRUNCATION = /\|\s*Select-Object\s+-(?:First|Last)\b|\|\s*head\b|\|\s*Select\s+-First\b/i

function safeJson(s) {
  if (s == null) return {}
  if (typeof s === 'object') return s
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/**
 * @param {Array} events   会话事件数组（readSessionLog 的产物）
 * @returns 工作记录模型
 */
export function collectWorkRecord(events) {
  const sessionMeta = events.find((e) => evType(e) === 'session') ?? {}
  const record = {
    // 这几项会**原样**进报告表头（`| 会话 | … |`、`| 工作目录 | … |`）。
    // 非字符串时不归一就会印出 `[object Object]` —— 与工具名/路径同一类。
    sessionId: label(sessionMeta.id, null),
    cwd: label(sessionMeta.cwd, null),
    agentPreset: label(sessionMeta.agentPreset, null),
    createdAt: sessionMeta.createdAt ?? null,
    title: null,
    permissions: {},
    turns: [],
    orphans: { toolCalls: 0 },
  }

  /** callId → 已收集的调用，便于配对结果 */
  const pending = new Map()
  let currentTurn = null

  const ensureTurn = (n, at) => {
    // 轮次号必须是整数。`turn` 缺失时会造出 `turn: undefined` 的轮次，而
    // `record.turns.sort((a,b) => a.turn - b.turn)` 的比较会得到 NaN ——
    // 排序不可信，报告里还会出现「### 轮次 undefined」。归一到 null 并排到最后。
    const turn = Number.isInteger(n) ? n : null
    let t = record.turns.find((x) => x.turn === turn)
    if (!t) {
      t = {
        turn,
        startedAt: at ?? null,
        endedAt: null,
        durationMs: null,
        prompt: null,
        reason: null,
        steps: 0,
        // step/start 数（含正在跑的那一步）；steps 只数已关闭的步
        stepsStarted: 0,
        toolCalls: [],
        filesRead: [],
        filesWritten: [],
        filesEdited: [],
        // 带时间戳的文件操作流水（面板按时间展示）
        fileEvents: [],
        commands: [],
        tests: [],
        failures: [],
        suspects: [],
        approvals: [],
        deliverables: [],
        todos: null,
        usage: null,
        retries: 0,
      }
      record.turns.push(t)
      // `turn` 可能是 null（日志里缺 turn 号）：排到最后，且不让比较变成 NaN
      record.turns.sort(
        (a, b) => (a.turn ?? Number.MAX_SAFE_INTEGER) - (b.turn ?? Number.MAX_SAFE_INTEGER),
      )
    }
    return t
  }

  for (const e of events) {
    const t = evType(e)
    const d = evData(e)
    switch (t) {
      case 'session/title':
        // 标题会进报告首行的引用块，非字符串会印成 `[object Object]`
        if (d.title != null) record.title = label(d.title)
        break

      case 'permission/preset':
        record.permissions.preset = label(d.preset, null)
        break
      case 'sandbox/mode':
        record.permissions.sandbox = label(d.mode, null)
        break
      case 'approval/policy':
        record.permissions.approval = label(d.policy, null)
        break

      case 'user/message': {
        // 只有真实用户输入才算任务；工具结果等走 source.kind
        if (d.source?.kind !== 'user') break
        const turn = currentTurn ?? (record.turns.length + 1)
        const tt = ensureTurn(turn, e.time)
        if (!tt.prompt) tt.prompt = messageText(d)
        break
      }

      case 'turn/start': {
        currentTurn = Number.isInteger(d.turn) ? d.turn : null
        const tt = ensureTurn(d.turn, e.time)
        tt.startedAt = tt.startedAt ?? e.time
        break
      }

      case 'turn/end': {
        const tt = ensureTurn(d.turn, e.time)
        tt.endedAt = e.time
        tt.reason = d.reason ?? null
        if (tt.startedAt) tt.durationMs = tt.endedAt - tt.startedAt
        currentTurn = null
        break
      }

      case 'step/start': {
        const tt = ensureTurn(d.turn)
        tt.stepsStarted += 1
        break
      }

      // 步数口径与 DSH 自己的 sessionStats 对齐：只数**已关闭**的步。
      // DSH 对每个进入的步在 finally 里恰好追加一条 step/end，所以完成、失败、
      // 取消、max-tokens 的步都落地；崩溃打断的步在会话重载时由恢复逻辑补写。
      // 用 step/start 会多算当前正在跑的那一步（实测活跃会话差 1）。
      case 'step/end': {
        const tt = ensureTurn(d.turn)
        tt.steps += 1
        break
      }

      case 'assistant/message': {
        const tt = ensureTurn(d.turn)
        if (d.usage) {
          tt.usage = mergeUsage(tt.usage, d.usage)
        }
        break
      }

      case 'llm/retry': {
        const tt = ensureTurn(d.turn)
        tt.retries += 1
        break
      }

      case 'tool/call': {
        const tt = ensureTurn(d.turn)
        const args = safeJson(d.arguments)
        const call = {
          // 名字非字符串时报告里会出现 `undefined` / `[object Object]`（工具直方图与表格）。
          name: label(d.name),
          callId: d.callId,
          seq: e.seq,
          at: e.time,
          args,
          ok: null,
          error: null,
          resultAt: null,
          durationMs: null,
        }
        tt.toolCalls.push(call)
        pending.set(d.callId, call)
        classifyCall(tt, call, args)
        break
      }

      case 'tool/result': {
        const callId = d.message?.source?.callId
        const call = callId ? pending.get(callId) : null
        const outcome = toolOutcome(e, { command: call?.args?.command })
        const tt = call ? ensureTurn(d.turn) : null
        if (call) {
          call.ok = outcome.ok
          call.error = outcome.ok ? null : outcome
          call.resultAt = e.time
          if (call.at) call.durationMs = e.time - call.at
          call.resultPreview = firstLines(messageText(d.message), 2)
          attachOutcome(tt, call, outcome, messageText(d.message))
          pending.delete(callId)
        } else {
          record.orphans.toolCalls += 1
        }
        break
      }

      case 'approval/asked': {
        const tt = ensureTurn(d.turn ?? currentTurn ?? record.turns.length)
        // toolName 会印在报告的「权限询问：`x`→?...」与逐轮明细里，非字符串会漏出 [object Object]
        tt.approvals.push({ toolName: label(d.toolName, '(未知工具)'), callId: d.callId, reason: label(d.reason, ''), outcome: null })
        break
      }
      case 'approval/decided': {
        for (const x of record.turns) {
          const a = x.approvals.find((y) => y.id === d.id || (!y.outcome && y.callId === d.callId))
          if (a) {
            a.outcome = d.outcome
            break
          }
        }
        // id 索引兜底
        if (d.id) {
          for (const x of record.turns) for (const a of x.approvals) if (!a.outcome && a.approvalId === d.id) a.outcome = d.outcome
        }
        break
      }

      case 'deliverables/presented': {
        const tt = ensureTurn(d.turn ?? currentTurn ?? record.turns.length)
        // `d.files ?? []` **挡不住**非数组：数字/对象不可迭代，`for...of` 会直接抛
        // `number 3 is not iterable`，一次畸形事件就让整次 work_report 失败。
        // 这与 todo/write 是同一类缺陷（`?.length` / `??` 都只挡 null/undefined）。
        // 属性测试（随机污染流）800 条里撞出 103 条走到这里，所以不是理论问题。
        for (const f of Array.isArray(d.files) ? d.files : []) {
          if (!f || typeof f !== 'object') continue
          tt.deliverables.push({
            path: f.path == null ? '' : label(f.path, ''),
            description: f.description == null ? '' : label(f.description, ''),
          })
        }
        break
      }

      case 'todo/write': {
        const tt = ensureTurn(d.turn ?? currentTurn ?? record.turns.length)
        tt.todos = d.todos ?? null
        break
      }

      default:
        break
    }
  }

  return finalize(record)
}

/**
 * 数值兜底。
 *
 * 为什么必须有（实测真机缺陷）：`usage` 字段一旦是**字符串**或对象，
 * 下面的 `+=` 就变成**字符串拼接**，而且**不报错** —— 报告里直接印出
 *   | 输入 Token（未缓存） | 00[object Object] |
 * 用户看到的是一个"数字"，实际是垃圾。这是最难察觉的一类错误：不崩、不警告、数字错。
 * 只要任意**后续**一条 usage 被污染，整份报告的该字段就一起变成字符串。
 */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * 名字/路径兜底：非字符串时报告里会出现 `undefined` / `[object Object]`。
 * 返回一个可读的占位而不是让它原样漏进表格。
 */
const label = (v, fallback = '(未知)') => {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return v == null ? fallback : `(${typeof v})`
}

function mergeUsage(acc, u) {
  const out = acc ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    // totalTokens 是**累计上下文规模**（每条都是当时的上下文大小），不是增量，
    // 所以峰值取 max 才是"上下文压力峰值"。已用 42 个会话对照权威值确认：
    // 权威 tokenUsage.totals 里根本没有 totalTokens 键，它只是逐条上下文快照。
    maxTotalTokens: 0,
    reports: 0,
  }
  // 这四个都是**逐条增量**，必须相加。
  // 实测判定（test/usage-semantics-check.mjs）：cacheReadTokens 逐条累加在
  // 42/42 个会话上与 DSH 权威总量完全一致，取 max 则 0/42 命中。
  out.inputTokens += num(u.inputTokens)
  out.outputTokens += num(u.outputTokens)
  out.cacheReadTokens += num(u.cacheReadTokens)
  out.cacheWriteTokens += num(u.cacheWriteTokens)
  out.reasoningTokens += num(u.reasoningTokens)
  out.reports += 1
  out.maxTotalTokens = Math.max(out.maxTotalTokens, num(u.totalTokens))
  return out
}

/**
 * 只有字符串/有限数字才当成命令行处理。
 *
 * 为什么不能直接 `String(args.command)`：那个真值判断会放行任意对象，
 * 而 `String()` 对 null-prototype 对象会**抛错**（`Cannot convert object to primitive value`），
 * 一次畸形事件就能让整次 `work_report` 调用失败；数组/对象则会被 `String()` 成
 * `"npm,test"` / `"[object Object]"` 混进报告。日志里的 `arguments` 经过 JSON.parse，
 * 正常不可能是这些形态，所以这里是**防御性**的 —— 但成本是一行，收益是工具不会整体挂掉。
 */
const isCommandLike = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

function classifyCall(turn, call, args) {
  // 路径非字符串时（日志被写坏、字段改名）会给报告塞进 `[object Object]`，归一到可读占位
  const rawPath = args.file_path ?? args.path
  const p = rawPath == null ? null : label(rawPath)
  // 所有条目都带 `at`（事件时间戳），面板要按时间展示
  if (FILE_READ_TOOLS.has(call.name) && p) {
    if (!turn.filesRead.includes(p)) turn.filesRead.push(p)
    turn.fileEvents.push({ path: p, op: 'read', tool: call.name, at: call.at, callId: call.callId })
  } else if (FILE_WRITE_TOOLS.has(call.name) && p) {
    if (!turn.filesWritten.includes(p)) turn.filesWritten.push(p)
    turn.fileEvents.push({ path: p, op: 'write', tool: call.name, at: call.at, callId: call.callId })
  } else if (FILE_EDIT_TOOLS.has(call.name) && p) {
    if (!turn.filesEdited.includes(p)) turn.filesEdited.push(p)
    turn.fileEvents.push({ path: p, op: 'edit', tool: call.name, at: call.at, callId: call.callId })
  } else if (SHELL_TOOLS.has(call.name) && isCommandLike(args.command)) {
    const cmd = String(args.command)
    turn.commands.push({
      command: cmd,
      description: args.description ?? '',
      callId: call.callId,
      at: call.at,
      ok: null,
      durationMs: null,
    })
    if (hasRealTestInvocation(cmd)) {
      turn.tests.push({ command: cmd, kind: guessTestKind(cmd), passed: null, callId: call.callId, at: call.at })
    }
  }
}

function guessTestKind(cmd) {
  if (/\bpwsh\b|\bPowerShell\b/i.test(cmd)) return 'shell'
  if (/\bnode\b.*--test|\.mjs\b/i.test(cmd)) return 'script'
  if (/\bvitest|jest|mocha\b/i.test(cmd)) return 'unit'
  if (/\bpytest\b/i.test(cmd)) return 'python'
  if (/\bgo test\b/i.test(cmd)) return 'go'
  if (/\bcargo test\b/i.test(cmd)) return 'rust'
  if (/\bdotnet test\b/i.test(cmd)) return 'dotnet'
  return 'other'
}

/**
 * 测试输出里是否有"失败"标记。
 *
 * 为什么需要它：`passed` 不能只看**整次 shell 调用的退出码**。实测踩过两种被掩盖的情况：
 *   1. 多行脚本 —— 退出码取**最后一句**：
 *        node --test demo-failing.test.mjs   # 真的失败
 *        "exit=$LASTEXITCODE"                # 最后一句是 echo → 整次调用 exit 0
 *   2. 管道 —— PowerShell 里管道的退出码来自**末端命令**，不是测试运行器：
 *        npm run verify 2>&1 | Select-Object -Last 20   # 套件红了，退出码却是 0
 * 测试运行器自己会把结论写在输出里，那个信号比退出码可靠。
 */
const TEST_FAIL_PATTERNS = [
  /^#\s*fail\s+[1-9]\d*/im, // node:test 的 TAP 汇总
  /^not ok\s+\d+/im, // TAP
  /^\s*FAILED\b/im, // pytest / python unittest（FAILED (failures=1)）
  /\bTests?:\s*[1-9]\d*\s+failed\b/i, // jest（注意：`0 failed` 不算失败）
  /\bTest Files?\s+[1-9]\d*\s+failed\b/i, // vitest
  /\b[1-9]\d*\s+(?:tests?|cases?|specs?)\s+failed\b/i, // 通用汇总
  /\b[1-9]\d*\s+failed\b/i, // mocha / vitest / cargo 尾行
  /\b[1-9]\d*\s+failing\b/i, // mocha
  /\bERR_ASSERTION\b|\bAssertionError\b/, // 断言失败（Node / Python / Java）
  /^---\s+FAIL\b/m, // go test
  /test result:\s*FAILED/i, // cargo test
  /\bBUILD FAILED\b/i, // gradle / maven
  /通过\s*\d+\s*·\s*失败\s*[1-9]\d*/, // 本插件 run-all.mjs 的汇总行
]

/** 正向证据：测试运行器给出的"通过"汇总（只有在没有失败标记时才采信）。 */
const TEST_PASS_PATTERNS = [
  /^#\s*fail\s+0\b/im, // node:test：fail 0
  /\bTests?:\s*\d+\s+passed\b/i, // jest
  /\bTest Files?\s+\d+\s+passed\b/i, // vitest
  /test result:\s*ok\b/i, // cargo test
  /\bBUILD SUCCESSFUL\b/i, // gradle
  /^[ \t]*OK[ \t]*$/im, // python unittest（必须独立成行，避免 OKAY 之类误判）
  /\bAll tests? passed\b/i,
  /\b\d+\s+passing\b/i, // mocha
  /通过\s*\d+\s*·\s*失败\s*0/, // 本插件 run-all.mjs
]

export function testOutputLooksFailed(text) {
  const t = String(text ?? '')
  return TEST_FAIL_PATTERNS.some((re) => re.test(t))
}

export function testOutputLooksPassed(text) {
  const t = String(text ?? '')
  return TEST_PASS_PATTERNS.some((re) => re.test(t))
}

/**
 * 整次 shell 调用的退出码，能不能归因到「测试运行器」？
 *
 * 不能的情况：测试命令被**管道**接到别的程序（退出码来自末端）、
 * 或者测试命令后面还有别的语句（退出码来自最后一句）。
 */
export function exitCodeIsAttributable(command) {
  const cmd = String(command ?? '')
  const matches = realTestMatches(cmd)
  if (!matches.length) return { ok: false, reason: 'no-test-runner' }
  const last = matches[matches.length - 1]
  const tail = cmd.slice(last.end)
  if (/\|/.test(tail)) return { ok: false, reason: 'piped' }
  // 尾部还有实义语句（去掉收尾的引号/括号/空白后仍非空）
  const rest = tail.replace(/[\s;'"`)\]}]+$/g, '')
  if (/[;\n]/.test(tail) && rest.trim() !== '') return { ok: false, reason: 'following-statements' }
  return { ok: true, reason: 'last' }
}

/**
 * 判定一次测试运行的结果。**三态**：true 通过 / false 未通过 / null 未判定。
 *
 * 宁可说「未判定」也不谎报「通过」——发布给用户的插件不能靠用户自觉
 * （"记得把测试命令放最后一句"）来保证数字正确。
 */
export function classifyTestOutcome({ command, resultText, callOk }) {
  if (testOutputLooksFailed(resultText)) return { passed: false, basis: 'output-fail' }
  if (testOutputLooksPassed(resultText)) return { passed: true, basis: 'output-pass' }
  const attr = exitCodeIsAttributable(command)
  if (attr.ok) return { passed: callOk === true, basis: 'exit-code' }
  return {
    passed: null,
    basis: 'unknown',
    note:
      attr.reason === 'piped'
        ? '未判定：命令被管道接到了别的程序上（管道退出码来自末端，不是测试运行器的），输出里也没有测试汇总。'
        : '未判定：测试命令后面还有别的语句（整次调用的退出码取最后一句），输出里也没有测试汇总。',
  }
}

/** 把多行命令压成一行，便于在表格/面板里辨认到底跑的是什么（原来只显示第一行）。 */
export function flattenCommand(cmd, width = 120) {
  const s = String(cmd ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ; ')
  return s.length > width ? `${s.slice(0, width)}…` : s
}

function attachOutcome(turn, call, outcome, resultText) {
  if (SHELL_TOOLS.has(call.name)) {
    const c = turn.commands.find((x) => x.callId === call.callId)
    if (c) {
      c.ok = outcome.ok
      c.durationMs = call.durationMs ?? null
    }
  }
  const t = turn.tests.find((x) => x.callId === call.callId)
  if (t) {
    // 三态判定：输出里的汇总 > 退出码（仅当退出码能归因到测试运行器时）。
    // 两者都不可信就说「未判定」，绝不谎报「通过」。
    const verdict = classifyTestOutcome({
      command: call.args?.command,
      resultText,
      callOk: outcome.ok,
    })
    t.passed = verdict.passed
    t.basis = verdict.basis
    if (verdict.note) t.note = verdict.note
    t.durationMs = call.durationMs ?? null
  }
  if (!outcome.ok) {
    const entry = {
      tool: call.name,
      callId: call.callId,
      kind: outcome.kind,
      suspect: outcome.suspect === true,
      message: outcome.message,
      seq: call.seq,
      at: call.at,
      durationMs: call.durationMs ?? null,
      command: call.args?.command ? firstLines(call.args.command, 1, 120) : undefined,
      file: call.args?.file_path != null ? label(call.args.file_path, '') : (call.args?.path != null ? label(call.args.path, '') : undefined),
    }
    if (outcome.suspect) turn.suspects.push(entry)
    else turn.failures.push(entry)
  }
}

/**
 * 重新汇总一份记录（只依赖 record.turns）。
 *
 * 用途：工具参数 `turns: N` 把明细截成最近 N 轮之后，**总览也必须跟着重算**——
 * 否则用户看到的是"明细只有 3 轮、总览却是全部 27 轮"，这是实打实的误导。
 */
export function rescoreRecord(record) {
  return finalize(record)
}

function finalize(record) {
  const totals = {
    turns: record.turns.length,
    steps: 0,
    toolCalls: 0,
    failures: 0,
    suspects: 0,
    commands: 0,
    tests: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsUnknown: 0,
    filesRead: 0,
    filesWritten: 0,
    filesEdited: 0,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    approvalsAsked: 0,
    approvalsDenied: 0,
    durationMs: 0,
    completed: 0,
    aborted: 0,
    interrupted: 0,
  }
  const allRead = new Set()
  const allWritten = new Set()
  const allEdited = new Set()
  const toolHistogram = new Map()
  // 按工具聚合：次数、首末时间、累计耗时、失败次数
  const toolStats = new Map()
  // 按文件聚合：操作集合、首末时间、涉及轮次
  const fileStats = new Map()
  // 所有命令扁平化（供「命令」独立视图）
  const allCommands = []
  // 所有测试扁平化
  const allTests = []

  for (const t of record.turns) {
    totals.steps += t.steps
    totals.toolCalls += t.toolCalls.length
    totals.failures += t.failures.length
    totals.suspects += t.suspects.length
    totals.commands += t.commands.length
    totals.tests += t.tests.length
    totals.testsPassed += t.tests.filter((x) => x.passed === true).length
    totals.testsFailed += t.tests.filter((x) => x.passed === false).length
    totals.testsUnknown += t.tests.filter((x) => x.passed == null).length
    totals.retries += t.retries
    totals.approvalsAsked += t.approvals.length
    totals.approvalsDenied += t.approvals.filter((a) => a.outcome && a.outcome !== 'allowed-once').length
    if (t.durationMs) totals.durationMs += t.durationMs
    if (t.usage) {
      totals.inputTokens += t.usage.inputTokens
      totals.outputTokens += t.usage.outputTokens
      totals.cacheReadTokens += t.usage.cacheReadTokens
      totals.reasoningTokens += t.usage.reasoningTokens
    }
    const kind = t.reason?.kind
    if (kind === 'completed') totals.completed += 1
    else if (kind === 'aborted') totals.aborted += 1
    else if (kind === 'interrupted') totals.interrupted += 1
    for (const f of t.filesRead) allRead.add(f)
    for (const f of t.filesWritten) allWritten.add(f)
    for (const f of t.filesEdited) allEdited.add(f)

    // ---- 工具聚合
    for (const c of t.toolCalls) {
      toolHistogram.set(c.name, (toolHistogram.get(c.name) ?? 0) + 1)
      const s = toolStats.get(c.name) ?? {
        name: c.name, count: 0, failures: 0, totalMs: 0,
        firstAt: null, lastAt: null, turns: new Set(),
      }
      s.count += 1
      if (c.ok === false) s.failures += 1
      if (typeof c.durationMs === 'number') s.totalMs += c.durationMs
      if (typeof c.at === 'number') {
        if (s.firstAt === null || c.at < s.firstAt) s.firstAt = c.at
        if (s.lastAt === null || c.at > s.lastAt) s.lastAt = c.at
      }
      s.turns.add(t.turn)
      toolStats.set(c.name, s)
    }

    // ---- 文件聚合
    for (const fe of t.fileEvents ?? []) {
      const s = fileStats.get(fe.path) ?? { path: fe.path, ops: new Set(), firstAt: null, lastAt: null, count: 0, turns: new Set() }
      s.ops.add(fe.op)
      s.count += 1
      if (typeof fe.at === 'number') {
        if (s.firstAt === null || fe.at < s.firstAt) s.firstAt = fe.at
        if (s.lastAt === null || fe.at > s.lastAt) s.lastAt = fe.at
      }
      s.turns.add(t.turn)
      fileStats.set(fe.path, s)
    }

    // ---- 命令 / 测试扁平化
    for (const c of t.commands) allCommands.push({ turn: t.turn, ...c })
    for (const x of t.tests) allTests.push({ turn: t.turn, ...x })
  }

  record.totals = {
    ...totals,
    filesRead: allRead.size,
    filesWritten: allWritten.size,
    filesEdited: allEdited.size,
    uniqueFilesTouched: new Set([...allRead, ...allWritten, ...allEdited]).size,
    toolHistogram: [...toolHistogram.entries()].sort((a, b) => b[1] - a[1]),
    // 详细工具视图：次数 / 失败 / 累计耗时 / 首末时间 / 涉及轮次
    toolDetail: [...toolStats.values()]
      .map((s) => ({ ...s, turns: [...s.turns].sort((a, b) => a - b) }))
      .sort((a, b) => b.count - a.count),
    // 详细文件视图：完整路径 / 操作 / 首末时间 / 次数 / 涉及轮次
    fileDetail: [...fileStats.values()]
      .map((s) => ({ ...s, ops: [...s.ops], turns: [...s.turns].sort((a, b) => a - b) }))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
    // 独立视图：命令 / 测试（扁平、带时间）
    allCommands: allCommands.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    allTests: allTests.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)),
    allFilesRead: [...allRead],
    allFilesWritten: [...allWritten],
    allFilesEdited: [...allEdited],

    // ---- 轮次完成率：**唯一的算法出口**
    //
    // 这里算一次、存进 totals，面板与 markdown/HTML 都只读这个数，不允许各自再除一遍。
    // 为什么（实测真机 bug）：两边分母曾经不同 —— 面板用「已收尾轮次」、报告用「全部轮次」，
    // 同一份数据在面板显示 100%、在下载的报告里显示 50%（54 个会话里 4 个对不上）。
    // 同一个数字有两个渲染面就有两个解释，这是**结构问题**，靠"记得同步改两处"是治不住的。
    //
    // 分母取「已收尾的轮次」：进行中的那一轮还没有结论，把它算成没完成会凭空拉低完成率。
    endedTurns: totals.completed + totals.aborted + totals.interrupted,
    /** 0-100 的整数；一轮都没收尾时为 null（渲染成「—」，而不是谎报 0%）。 */
    completionRate:
      totals.completed + totals.aborted + totals.interrupted > 0
        ? Math.round((totals.completed / (totals.completed + totals.aborted + totals.interrupted)) * 100)
        : null,

    // 完成度：所有轮次都以 completed 收尾才算完成
    finished: totals.turns > 0 && totals.completed === totals.turns,
  }
  return record
}
