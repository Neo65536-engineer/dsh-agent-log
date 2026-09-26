/**
 * 把工作记录模型渲染成可读的《本次 Agent 工作报告》（Markdown）。
 * 纯函数、无依赖，宿主、CLI、UI 共用。
 */
import { firstLines } from './session-log.mjs'
import { flattenCommand } from './collect.mjs'

const n = (x) => (x ?? 0).toLocaleString('en-US')
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')
const ms = (v) => {
  if (!v) return '0s'
  const s = Math.round(v / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}
const short = (p, cwd) => {
  if (!p) return ''
  let s = String(p)
  if (cwd && s.toLowerCase().startsWith(String(cwd).toLowerCase())) {
    s = s.slice(String(cwd).length).replace(/^[\\/]+/, '')
  }
  return s || '.'
}
/** 时间戳 → HH:MM:SS（本地） */
const hms = (t) => {
  if (typeof t !== 'number') return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 时间戳 → MM-DD HH:MM */
const mdhm = (t) => {
  if (typeof t !== 'number') return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const REASON_LABEL = {
  completed: '✅ 完成',
  aborted: '⛔ 中止',
  interrupted: '⚠️ 中断',
}

export function renderReport(record, opts = {}) {
  const { cwd } = record
  const T = record.totals
  const L = []
  const now = opts.now ? new Date(opts.now) : new Date()

  // 进行中 = 还有轮次没写 endedAt。报告是快照，不能把"还没结束"说成"0 秒完成"。
  const inProgress = record.turns.some((t) => !t.endedAt)
  const verdict = T.finished
    ? '✅ 任务全部完成'
    : T.turns === 0
      ? '⚠️ 还没有任务轮次'
      : inProgress
        ? '⏳ 进行中（本轮尚未结束）'
        : T.aborted + T.interrupted > 0
          ? '⚠️ 存在未完成的轮次'
          : '⚠️ 未收尾'

  L.push(`# 本次 Agent 工作报告`)
  L.push('')
  L.push(`> ${record.title ?? '(无标题)'}`)
  if (record.scope) {
    L.push('>')
    L.push(
      `> ⚠️ **本报告只统计最近 ${record.scope.shown} 轮**（会话共 ${record.scope.total} 轮）：` +
        `总览、工具、命令、文件、测试、失败全部按这 ${record.scope.shown} 轮重算。`,
    )
  }
  L.push('')
  L.push(`| | |`)
  L.push(`| --- | --- |`)
  L.push(`| 会话 | \`${record.sessionId}\` |`)
  L.push(`| 工作目录 | \`${cwd ?? '-'}\` |`)
  L.push(`| 生成时间 | ${now.toISOString().replace('T', ' ').slice(0, 19)} |`)
  L.push(`| 结论 | **${verdict}** |`)
  L.push(`| 权限档位 | sandbox=\`${record.permissions.sandbox ?? '-'}\` approval=\`${record.permissions.approval ?? '-'}\` |`)
  L.push('')

  // ---------------------------------------------------------- 一、总览
  L.push(`## 一、总览`)
  L.push('')
  L.push(`| 指标 | 值 | 指标 | 值 |`)
  L.push(`| --- | --- | --- | --- |`)
  L.push(`| 任务轮次 | ${T.turns} | 执行步数 | ${n(T.steps)} |`)
  L.push(`| 工具调用 | ${n(T.toolCalls)} | 失败次数 | **${T.failures}**（另有 ${T.suspects} 次疑似） |`)
  L.push(`| 命令执行 | ${n(T.commands)} | 测试执行 | ${T.tests}（通过 ${T.testsPassed} / 失败 ${T.testsFailed}） |`)
  L.push(`| 读文件 | ${T.filesRead} | 写/改文件 | ${T.filesWritten} + ${T.filesEdited} |`)
  L.push(`| 涉及文件总数 | ${T.uniqueFilesTouched} | 模型重试 | ${T.retries} |`)
  L.push(`| 输入 Token（未缓存） | ${n(T.inputTokens)} | 输出 Token | ${n(T.outputTokens)} |`)
  L.push(`| 缓存读取 Token | ${n(T.cacheReadTokens)} | 推理 Token | ${n(T.reasoningTokens)} |`)
  L.push(`| 缓存读取占比 | ${pct(T.cacheReadTokens, T.inputTokens + T.cacheReadTokens)} | 上下文压力峰值 | ${n(Math.max(0, ...record.turns.map((t) => t.usage?.maxTotalTokens ?? 0)))} |`)
  L.push(`| 权限询问 | ${T.approvalsAsked} | 被拒 | ${T.approvalsDenied} |`)
  L.push(`| 总耗时（轮次墙钟） | ${inProgress ? `${ms(T.durationMs)}（进行中，尚未收尾）` : ms(T.durationMs)} | 完成/中止/中断 | ${T.completed} / ${T.aborted} / ${T.interrupted}${inProgress ? '（进行中不计入）' : ''} |`)
  L.push('')

  L.push(`**成功率**：工具调用 ${pct(T.toolCalls - T.failures, T.toolCalls)} · 轮次完成 ${pct(T.completed, T.turns)}`)
  if (T.suspects > 0) {
    L.push('')
    L.push(
      `> 另有 **${T.suspects}** 次工具调用以非 0 退出但判为**疑似**：多为 Windows 上 ` +
        `\`… | Select-Object -First N\` 因 broken pipe 退出，或 stderr 有噪音，实际工作可能已成功。`,
    )
  }
  L.push('')

  // ---------------------------------------------------------- 二、工具使用
  L.push(`## 二、用了哪些工具`)
  L.push('')
  const toolDetail = T.toolDetail ?? []
  if (toolDetail.length === 0) {
    L.push('_没有工具调用记录。_')
  } else {
    L.push(`| 工具 | 调用次数 | 占比 | 失败 | 累计耗时 | 首次 | 末次 | 涉及轮次 |`)
    L.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`)
    for (const t of toolDetail) {
      L.push(
        `| \`${t.name}\` | ${t.count} | ${pct(t.count, T.toolCalls)} | ${t.failures} | ` +
          `${ms(t.totalMs)} | ${hms(t.firstAt)} | ${hms(t.lastAt)} | ${(t.turns ?? []).join(',') || '-'} |`,
      )
    }
  }
  L.push('')

  // ---------------------------------------------------------- 二之二、命令（独立于工具）
  L.push(`## 三、运行了哪些命令`)
  L.push('')
  L.push(`> 命令是**实际执行的命令行**，与上面的「工具」是两个维度：工具是 DSH 的能力（read/write/pwsh…），`)
  L.push(`> 命令是通过 \`pwsh\` 等工具真正跑起来的命令行。`)
  L.push('')
  const allCmds = T.allCommands ?? []
  if (allCmds.length === 0) {
    L.push('_没有命令执行记录。_')
  } else {
    const failedN = allCmds.filter((c) => c.ok === false).length
    L.push(`共 **${allCmds.length}** 条命令，其中失败 **${failedN}** 条。`)
    L.push('')
    L.push(`| # | 时间 | 轮次 | 结果 | 耗时 | 命令 |`)
    L.push(`| --- | --- | --- | --- | --- | --- |`)
    allCmds.forEach((c, i) => {
      const mark = c.ok === true ? '✅ 0' : c.ok === false ? '❌ 非 0' : '❔ 未知'
      L.push(
        `| ${i + 1} | ${hms(c.at)} | ${c.turn} | ${mark} | ${c.durationMs ? ms(c.durationMs) : '—'} | ` +
          `\`${firstLines(c.command, 1, 110)}\` |`,
      )
    })
  }
  L.push('')

  // ---------------------------------------------------------- 四、文件
  L.push(`## 四、读了哪些文件 / 改了哪些文件`)
  L.push('')
  const fileDetail = T.fileDetail ?? []
  const modifiedFiles = fileDetail.filter((f) => f.ops.includes('write') || f.ops.includes('edit'))
  const readFiles = fileDetail.filter(
    (f) => f.ops.includes('read') && !f.ops.includes('write') && !f.ops.includes('edit'),
  )
  const opLabel = (ops) => {
    if (ops.includes('write') && ops.includes('edit')) return '写+改'
    if (ops.includes('write')) return '写入'
    if (ops.includes('edit')) return '修改'
    return '读取'
  }

  L.push(`### 4.1 修改（${modifiedFiles.length}）`)
  L.push('')
  if (modifiedFiles.length === 0) L.push('_没有文件被修改。_')
  else {
    L.push(`| 文件（完整路径） | 方式 | 次数 | 末次时间 | 涉及轮次 |`)
    L.push(`| --- | --- | --- | --- | --- |`)
    for (const f of modifiedFiles) {
      L.push(
        `| \`${f.path}\` | ${opLabel(f.ops)} | ${f.count} | ${hms(f.lastAt)} | ${(f.turns ?? []).join(',') || '-'} |`,
      )
    }
  }
  L.push('')
  L.push(`### 4.2 读取（${readFiles.length}）`)
  L.push('')
  if (readFiles.length === 0) L.push('_没有只读的文件记录。_')
  else {
    L.push(`| 文件（完整路径） | 次数 | 末次时间 | 涉及轮次 |`)
    L.push(`| --- | --- | --- | --- |`)
    for (const f of readFiles) {
      L.push(`| \`${f.path}\` | ${f.count} | ${hms(f.lastAt)} | ${(f.turns ?? []).join(',') || '-'} |`)
    }
  }
  L.push('')

  // ---------------------------------------------------------- 五、测试
  L.push(`## 五、测试是否通过`)
  L.push('')
  const allTests = T.allTests ?? []
  if (allTests.length === 0) {
    L.push('_本次没有执行过测试。_')
    L.push('')
    L.push('> 判据：命令里调用了测试运行器 —— `npm/pnpm/yarn/bun` + `test|vitest|jest|check|lint|verify`、')
    L.push('> `node --test`、`vitest`、`jest`、`mocha`、`playwright test`、`pytest`、`go test`、`cargo test` 等。')
    L.push('> 普通的 `Get-ChildItem`、`pnpm install` 之类不算测试。')
  } else {
    const unknown = T.testsUnknown ?? allTests.filter((x) => x.passed == null).length
    L.push(
      `共 **${allTests.length}** 次测试，通过 **${T.testsPassed}** / 失败 **${T.testsFailed}**` +
        (unknown ? ` / 未判定 **${unknown}**` : '') +
        `。`,
    )
    L.push('')
    L.push(`| # | 时间 | 轮次 | 类型 | 结论 | 耗时 | 命令 |`)
    L.push(`| --- | --- | --- | --- | --- | --- | --- |`)
    allTests.forEach((x, i) => {
      const mark =
        x.passed === true ? '✅ 通过'
        : x.passed === false ? '❌ 未通过'
        : '❔ 未判定'
      L.push(
        `| ${i + 1} | ${hms(x.at)} | ${x.turn} | ${x.kind} | ${mark} | ` +
          `${x.durationMs ? ms(x.durationMs) : '—'} | \`${flattenCommand(x.command, 110)}\` |`,
      )
      if (x.note) L.push(`| | | | | | | ${x.note} |`)
    })
  }
  L.push('')

  // ---------------------------------------------------------- 六、失败
  L.push(`## 六、失败过几次 / 失败原因`)
  L.push('')
  if (T.failures === 0) {
    L.push('✅ 本次没有记录到工具层失败。')
  } else {
    L.push(`共 **${T.failures}** 次失败，分布在 ${record.turns.filter((t) => t.failures.length).length} 个轮次。`)
    L.push('')
    for (const t of record.turns) {
      if (!t.failures.length) continue
      L.push(`### 轮次 ${t.turn}（${t.failures.length} 次）`)
      L.push('')
      for (const f of t.failures) {
        L.push(
          `- **\`${f.tool}\`** · \`${f.kind}\` · ${hms(f.at)}` +
            `${f.durationMs ? ` · ${ms(f.durationMs)}` : ''}` +
            `${f.file ? ` · \`${f.file}\`` : ''}`,
        )
        if (f.command) L.push(`  - 命令：\`${f.command}\``)
        if (f.message) L.push(`  - 说明：${firstLines(f.message, 1, 200)}`)
        L.push(`  - 事件 seq：${f.seq}`)
      }
      L.push('')
    }
    L.push(`### 失败原因归类`)
    L.push('')
    const byKind = new Map()
    for (const t of record.turns) for (const f of t.failures) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
    L.push(`| 类型 | 次数 | 含义 |`)
    L.push(`| --- | --- | --- |`)
    const MEANING = {
      'exit-1': '命令以非 0 退出（Windows 下常见于被中断或真实失败，需看输出分辨）',
      timeout: '命令超时被杀（常见于交互式程序或网络等待）',
      ABORTED: '调用被中止（超时或用户中断）',
      FS_NOT_OBSERVED: '文件系统路径未在观察范围内（需先读后写）',
      TOOL_OUTCOME_UNKNOWN: '工具结果未知（进程异常结束，未能确认落盘）',
    }
    for (const [k, c] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
      L.push(`| \`${k}\` | ${c} | ${MEANING[k] ?? '—'} |`)
    }
    L.push('')
  }

  if (T.suspects > 0) {
    L.push(`### 疑似失败（${T.suspects} 次，未计入失败总数）`)
    L.push('')
    L.push(`这些调用以非 0 退出，但退出码很可能是管道/环境的副产物而非真实失败，故单列。`)
    L.push('')
    for (const t of record.turns) {
      for (const f of t.suspects) {
        L.push(`- 轮次 ${t.turn} · **\`${f.tool}\`** · \`${f.kind}\``)
        if (f.command) L.push(`  - 命令：\`${f.command}\``)
        if (f.message) L.push(`  - 输出：${firstLines(f.message, 1, 160)}`)
      }
    }
    L.push('')
  }

  // ---------------------------------------------------------- 六、逐轮明细
  L.push(`## 七、逐轮明细`)
  L.push('')
  for (const t of record.turns) {
    const u = t.usage
    L.push(`### 轮次 ${t.turn} · ${REASON_LABEL[t.reason?.kind] ?? '❔ 未收尾'}`)
    L.push('')
    L.push(`**任务**：${firstLines(t.prompt, 3, 400) || '_(无用户输入)_'}`)
    L.push('')
    L.push(`**时间**：${mdhm(t.startedAt)} → ${mdhm(t.endedAt)}（${ms(t.durationMs)}）`)
    L.push('')
    L.push(`| 步数 | 工具调用 | 失败/疑似 | 命令 | 测试 | 读/写/改 | 输出 Token |`)
    L.push(`| --- | --- | --- | --- | --- | --- | --- |`)
    L.push(
      `| ${t.steps} | ${t.toolCalls.length} | ${t.failures.length}/${t.suspects.length} | ${t.commands.length} | ` +
        `${t.tests.length} | ` +
        `${t.filesRead.length}/${t.filesWritten.length}/${t.filesEdited.length} | ${n(u?.outputTokens)} |`,
    )
    L.push('')
    if (t.toolCalls.length) {
      const hist = new Map()
      for (const c of t.toolCalls) hist.set(c.name, (hist.get(c.name) ?? 0) + 1)
      L.push(`工具：${[...hist.entries()].map(([k, v]) => `\`${k}\`×${v}`).join(' · ')}`)
      L.push('')
    }
    if (t.approvals.length) {
      L.push(`权限询问：${t.approvals.map((a) => `\`${a.toolName}\`→${a.outcome ?? '?'}`).join(' · ')}`)
      L.push('')
    }
    if (t.deliverables.length) {
      L.push(`交付物：`)
      for (const d of t.deliverables) L.push(`- \`${short(d.path, cwd)}\` — ${d.description ?? ''}`)
      L.push('')
    }
    if (t.todos?.length) {
      const done = t.todos.filter((x) => x.status === 'completed').length
      L.push(`待办清单：${done}/${t.todos.length} 完成`)
      L.push('')
    }
  }

  // ---------------------------------------------------------- 七、经验沉淀
  L.push(`## 八、可沉淀的经验（自动归纳）`)
  L.push('')
  L.push(...renderLessons(record, cwd))
  L.push('')

  L.push(`---`)
  L.push('')
  L.push(`_本报告由 dsh-agent-log 从 DSH 会话日志（只读）自动生成，未修改任何会话数据。_`)
  L.push('')

  return L.join('\n')
}

function renderLessons(record, cwd) {
  const out = []
  const T = record.totals

  // 1) 高频失败工具
  const failTools = new Map()
  for (const t of record.turns) for (const f of t.failures) failTools.set(f.tool, (failTools.get(f.tool) ?? 0) + 1)
  if (failTools.size) {
    const top = [...failTools.entries()].sort((a, b) => b[1] - a[1])[0]
    const rate = T.toolCalls ? Math.round((top[1] / T.toolCalls) * 100) : 0
    out.push(`- **最容易失败的工具是 \`${top[0]}\`**（${top[1]} 次）。下次同类任务可优先缩短单次调用、拆分步骤，或先小范围试跑。`)
  }

  // 2) 被拒的权限询问
  const denied = record.turns.flatMap((t) => t.approvals.filter((a) => a.outcome && a.outcome !== 'allowed-once'))
  if (denied.length) {
    out.push(`- **有 ${denied.length} 次权限询问未获一次性放行**（${[...new Set(denied.map((d) => d.toolName))].join(', ')}）。若这些操作本应常规执行，可调整权限档位减少往返。`)
  }

  // 3) 反复读取同一文件
  const readCount = new Map()
  for (const t of record.turns) for (const f of t.filesRead) readCount.set(f, (readCount.get(f) ?? 0) + 1)
  const repeats = [...readCount.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3)
  for (const [f, c] of repeats) {
    out.push(`- **\`${short(f, cwd)}\` 被重复读取 ${c} 次**，说明上下文里没留住它。可考虑把关键约定写入 AGENTS.md 或项目技能，减少反复回读。`)
  }

  // 4) 重试
  if (T.retries > 0) {
    out.push(`- **模型层发生 ${T.retries} 次重试**，通常是请求失败或输出异常。若集中在同一轮，检查该轮的输入是否过大或工具结果是否被截断。`)
  }

  // 5) 进行中 / 未完成轮次（两者必须分开：进行中不是"没收尾的失败"）
  const running = record.turns.filter((t) => !t.endedAt)
  if (running.length) {
    out.push(`- 报告生成时**第 ${running.map((t) => t.turn).join('、')} 轮仍在进行中**，所以总耗时、成功率都是当时的快照，会随对话继续变化。`)
  }
  const unfinished = record.turns.filter((t) => t.endedAt && t.reason?.kind !== 'completed')
  if (unfinished.length) {
    out.push(`- **${unfinished.length} 个轮次没有以「完成」收尾**（轮次 ${unfinished.map((t) => t.turn).join(', ')}）。中止/中断的轮次里未提交的工作不会进入模型上下文，下轮需要重新交代背景。`)
  }

  // 6) 空转信号：工具调用很多但没有文件产出
  if (T.toolCalls > 20 && T.filesWritten + T.filesEdited === 0) {
    out.push(`- **${T.toolCalls} 次工具调用但没有任何文件产出**，本次属于纯调研/分析型任务；若预期有产出，说明执行路径偏离了目标。`)
  }

  if (out.length === 0) {
    out.push(T.turns === 0
      ? '- 这个会话还没有发起过任务轮次，没有可归纳的执行经验。'
      : '- 本次执行没有明显异常，无需特别沉淀。')
  }
  return out
}
