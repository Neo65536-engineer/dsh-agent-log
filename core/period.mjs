/**
 * 日报 / 周报聚合：跨会话按时间范围汇总。
 *
 * 与单会话报告的区别：这里回答「这段时间我让 agent 干了什么」，
 * 而不是「这一次任务干了什么」。时间口径用会话事件的 time 字段（毫秒），
 * 因此同一天内的多段会话会被正确并入同一份日报。
 */
import { readSessionLog, listSessions, readProjectionCache } from './session-log.mjs'
import { collectWorkRecord } from './collect.mjs'

/** 把毫秒时间戳格式化成 YYYY-MM-DD（本地时区）。 */
export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 解析 --since / --until 这类输入。
 * 支持：YYYY-MM-DD、today、yesterday、7d / 30d（最近 N 天）、week（本周起）。
 */
export function parseWhen(input, now = Date.now()) {
  if (!input) return null
  const s = String(input).trim().toLowerCase()
  const DAY = 86400000
  if (s === 'today') return startOfDay(now)
  if (s === 'yesterday') return startOfDay(now - DAY)
  if (s === 'week') {
    const d = new Date(now)
    const dow = (d.getDay() + 6) % 7 // 周一为一周之始
    return startOfDay(now - dow * DAY)
  }
  const rel = s.match(/^(\d+)d$/)
  if (rel) return startOfDay(now - Number(rel[1]) * DAY)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 跨会话聚合。
 * @param {string} home  DSH home
 * @param {{since?: number, until?: number, onProgress?: Function}} opts
 */
export function aggregatePeriod(home, opts = {}) {
  const { since = 0, until = Number.POSITIVE_INFINITY, onProgress } = opts
  const sessions = listSessions(home)
  const days = new Map()      // dayKey -> 聚合桶
  const allSessions = []

  for (const entry of sessions) {
    // 先用文件 mtime 粗筛，避免解压无关会话
    if (entry.mtimeMs < since - 86400000 || entry.mtimeMs > until + 86400000) continue

    let events
    try {
      events = readSessionLog(entry.file).events
    } catch {
      continue
    }
    if (events.length === 0) continue

    // 用会话内事件时间进一步裁剪
    const inRange = events.filter((e) => typeof e.time === 'number' && e.time >= since && e.time <= until)
    if (inRange.length === 0) continue

    const record = collectWorkRecord(events)
    const cacheJson = readProjectionCache(home, entry.sessionId)
    const title = cacheJson?.record?.rows?.title?.val ?? record.title ?? null

    // 按天切分该会话的轮次
    const byDay = new Map()
    for (const t of record.turns) {
      const at = t.startedAt ?? inRange[0].time
      if (at < since || at > until) continue
      const k = dayKey(at)
      if (!byDay.has(k)) byDay.set(k, [])
      byDay.get(k).push(t)
    }

    for (const [k, turns] of byDay) {
      if (!days.has(k)) days.set(k, emptyBucket(k))
      const b = days.get(k)
      b.sessions.add(entry.sessionId)
      b.sessionTitles.set(entry.sessionId, title)
      for (const t of turns) {
        b.turns.push({ sessionId: entry.sessionId, sessionTitle: title, ...t })
        b.toolCalls += t.toolCalls.length
        b.failures += t.failures.length
        b.suspects += t.suspects.length
        b.commands += t.commands.length
        b.tests += t.tests.length
        b.testsPassed += t.tests.filter((x) => x.passed === true).length
        b.testsFailed += t.tests.filter((x) => x.passed === false).length
        b.steps += t.steps
        b.outputTokens += t.usage?.outputTokens ?? 0
        b.inputTokens += t.usage?.inputTokens ?? 0
        b.cacheReadTokens += t.usage?.cacheReadTokens ?? 0
        b.durationMs += t.durationMs ?? 0
        if (t.reason?.kind === 'completed') b.completed += 1
        else if (t.reason?.kind === 'aborted') b.aborted += 1
        else if (t.reason?.kind === 'interrupted') b.interrupted += 1
        for (const c of t.toolCalls) b.toolHistogram.set(c.name, (b.toolHistogram.get(c.name) ?? 0) + 1)
        for (const f of t.filesWritten) b.filesWritten.add(f)
        for (const f of t.filesEdited) b.filesEdited.add(f)
        for (const f of t.filesRead) b.filesRead.add(f)
      }
    }

    allSessions.push({
      sessionId: entry.sessionId,
      title,
      turns: record.turns.length,
      toolCalls: record.totals.toolCalls,
      failures: record.totals.failures,
      mtimeMs: entry.mtimeMs,
      firstEventMs: inRange[0]?.time ?? null,
      lastEventMs: inRange[inRange.length - 1]?.time ?? null,
    })
    onProgress?.(entry.sessionId)
  }

  return { days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)), sessions: allSessions }
}

function emptyBucket(day) {
  return {
    day,
    sessions: new Set(),
    sessionTitles: new Map(),
    turns: [],
    steps: 0,
    toolCalls: 0,
    failures: 0,
    suspects: 0,
    commands: 0,
    tests: 0,
    testsPassed: 0,
    testsFailed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
    completed: 0,
    aborted: 0,
    interrupted: 0,
    toolHistogram: new Map(),
    filesRead: new Set(),
    filesWritten: new Set(),
    filesEdited: new Set(),
  }
}

// ------------------------------------------------------------------ 渲染

const n = (x) => (x ?? 0).toLocaleString('en-US')
const ms = (v) => {
  if (!v) return '0s'
  const s = Math.round(v / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}
const shortPath = (p, root) => {
  if (!p) return ''
  let s = String(p)
  if (root && s.toLowerCase().startsWith(String(root).toLowerCase())) s = s.slice(String(root).length).replace(/^[\\/]+/, '')
  return s || '.'
}

/**
 * 被截断时必须写出来的那一行；没截断返回 null。
 *
 * 与 core/render.mjs 的 `capNote()` 同一原则：**列表被截断就必须说**。
 * 早先这一节的三处截断（工具 >20、产出文件 >60、每轮产出 >8）全是静默的，
 * 而单会话报告那边专门做了「只列前 N 条（共 M 条）」——
 * 实测本机 37 个工具里静默丢掉 17 个、1248 个文件里静默只列 60 个，
 * 读者会默认那张表是完整的。同一份插件里两套标准，比截断本身更糟。
 */
function capNote(total, shown, more = '') {
  if (total <= shown) return null
  return `> ⚠️ 明细过长，此处只列 ${more || '前'} **${shown}** 条（共 **${total}** 条）。`
}

/** 渲染日报 / 周报。granularity = 'daily' | 'weekly' | 'range' */
export function renderPeriod(agg, opts = {}) {
  const { label = '工作报告', root = null, since = null, until = null } = opts
  const L = []

  const totals = agg.days.reduce(
    (a, d) => {
      a.turns += d.turns.length
      a.steps += d.steps
      a.toolCalls += d.toolCalls
      a.failures += d.failures
      a.suspects += d.suspects
      a.commands += d.commands
      a.tests += d.tests
      a.testsPassed += d.testsPassed
      a.testsFailed += d.testsFailed
      a.outputTokens += d.outputTokens
      a.inputTokens += d.inputTokens
      a.cacheReadTokens += d.cacheReadTokens
      a.durationMs += d.durationMs
      a.completed += d.completed
      a.aborted += d.aborted
      a.interrupted += d.interrupted
      for (const [k, v] of d.toolHistogram) a.toolHistogram.set(k, (a.toolHistogram.get(k) ?? 0) + v)
      for (const s of d.sessions) a.sessions.add(s)
      for (const f of d.filesWritten) a.filesWritten.add(f)
      for (const f of d.filesEdited) a.filesEdited.add(f)
      for (const f of d.filesRead) a.filesRead.add(f)
      return a
    },
    {
      turns: 0, steps: 0, toolCalls: 0, failures: 0, suspects: 0, commands: 0,
      tests: 0, testsPassed: 0, testsFailed: 0, outputTokens: 0, inputTokens: 0,
      cacheReadTokens: 0,
      durationMs: 0, completed: 0, aborted: 0, interrupted: 0,
      toolHistogram: new Map(), sessions: new Set(),
      filesWritten: new Set(), filesEdited: new Set(), filesRead: new Set(),
    },
  )

  const rangeText =
    since && until
      ? `${dayKey(since)} ~ ${dayKey(Math.min(until, Date.now()))}`
      : agg.days.length
        ? `${agg.days[agg.days.length - 1].day} ~ ${agg.days[0].day}`
        : '(无数据)'

  L.push(`# ${label}`)
  L.push('')
  // 两个口径不同，必须分别说明，否则「6 个会话 / 8 个会话」会让人以为算错了：
  //   totals.sessions —— 在范围内**发起了任务轮次**的会话
  //   agg.sessions    —— 只要在范围内**有事件**的会话（含上一轮跨天续跑的）
  const withTasks = totals.sessions.size
  const touched = agg.sessions.length
  L.push(
    `> 统计范围：${rangeText} · ${withTasks} 个会话有任务` +
      (touched > withTasks ? `（另有 ${touched - withTasks} 个会话仅跨范围续跑）` : '') +
      ` · ${agg.days.length} 天有活动`,
  )
  L.push('')

  // ---- 汇总
  L.push(`## 一、这段时间总共做了什么`)
  L.push('')
  L.push(`| 指标 | 值 | 指标 | 值 |`)
  L.push(`| --- | --- | --- | --- |`)
  L.push(`| 任务轮次 | ${n(totals.turns)} | 执行步数 | ${n(totals.steps)} |`)
  L.push(`| 工具调用 | ${n(totals.toolCalls)} | 失败次数 | **${totals.failures}**（疑似 ${totals.suspects}） |`)
  L.push(`| 命令执行 | ${n(totals.commands)} | 测试执行 | ${totals.tests}（通过 ${totals.testsPassed} / 失败 ${totals.testsFailed}） |`)
  L.push(`| 读文件 | ${totals.filesRead.size} | 写/改文件 | ${totals.filesWritten.size} + ${totals.filesEdited.size} |`)
  L.push(`| 输入 Token（未缓存） | ${n(totals.inputTokens)} | 输出 Token | ${n(totals.outputTokens)} |`)
  L.push(`| 缓存读取 Token | ${n(totals.cacheReadTokens)} | 缓存读取占比 | ${totals.inputTokens + totals.cacheReadTokens > 0 ? Math.round((totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens)) * 100) : 0}% |`)
  L.push(`| 累计墙钟 | ${ms(totals.durationMs)} | 完成/中止/中断 | ${totals.completed} / ${totals.aborted} / ${totals.interrupted} |`)
  L.push('')

  // ---- 按天
  L.push(`## 二、按天分布`)
  L.push('')
  L.push(`| 日期 | 会话 | 轮次 | 工具调用 | 失败 | 命令 | 输出 Token | 墙钟 | 完成率 |`)
  L.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`)
  for (const d of agg.days) {
    const done = d.turns.length ? Math.round((d.completed / d.turns.length) * 100) : 0
    L.push(
      `| ${d.day} | ${d.sessions.size} | ${d.turns.length} | ${d.toolCalls} | ${d.failures} | ` +
        `${d.commands} | ${n(d.outputTokens)} | ${ms(d.durationMs)} | ${done}% |`,
    )
  }
  L.push('')

  // ---- 工具
  L.push(`## 三、工具使用分布`)
  L.push('')
  const hist = [...totals.toolHistogram.entries()].sort((a, b) => b[1] - a[1])
  L.push(`| 工具 | 调用次数 | 占比 |`)
  L.push(`| --- | --- | --- |`)
  const SHOWN_TOOLS = 20
  for (const [k, v] of hist.slice(0, SHOWN_TOOLS)) {
    L.push(`| \`${k}\` | ${v} | ${totals.toolCalls ? Math.round((v / totals.toolCalls) * 100) : 0}% |`)
  }
  const toolNote = capNote(hist.length, Math.min(hist.length, SHOWN_TOOLS), '前')
  if (toolNote) {
    L.push('')
    L.push(toolNote)
  }
  L.push('')

  // ---- 文件产出
  L.push(`## 四、这段时间的产出（被写入/修改的文件）`)
  L.push('')
  const produced = [
    ...totals.filesWritten,
    ...totals.filesEdited,
  ]
  const producedList = [...new Set(produced)]
  const SHOWN_FILES = 60
  if (producedList.length === 0) L.push('_没有文件产出。_')
  else for (const f of producedList.slice(0, SHOWN_FILES)) L.push(`- \`${shortPath(f, root)}\``)
  const fileNote = capNote(producedList.length, Math.min(producedList.length, SHOWN_FILES), '前')
  if (fileNote) {
    L.push('')
    L.push(fileNote)
  }
  L.push('')

  // ---- 逐日明细
  L.push(`## 五、逐日明细`)
  L.push('')
  for (const d of agg.days) {
    L.push(`### ${d.day}`)
    L.push('')
    for (const [sid, title] of d.sessionTitles) {
      L.push(`- 会话 \`${sid.slice(0, 24)}…\`${title ? ` — ${title}` : ''}`)
    }
    L.push('')
    for (const t of d.turns) {
      const mark = t.reason?.kind === 'completed' ? '✅' : t.reason?.kind === 'aborted' ? '⛔' : t.reason?.kind === 'interrupted' ? '⚠️' : '❔'
      const prompt = String(t.prompt ?? '').split('\n').map((x) => x.trim()).filter(Boolean)[0] ?? '(无)'
      L.push(`- ${mark} **${prompt.length > 70 ? `${prompt.slice(0, 70)}…` : prompt}**`)
      L.push(
        `  - 工具 ${t.toolCalls.length} · 失败 ${t.failures.length} · 命令 ${t.commands.length} · ` +
          `读/写/改 ${t.filesRead.length}/${t.filesWritten.length}/${t.filesEdited.length} · 输出 ${n(t.usage?.outputTokens)} tok · ${ms(t.durationMs)}`,
      )
      if (t.filesWritten.length || t.filesEdited.length) {
        const perTurn = [...new Set([...t.filesWritten, ...t.filesEdited])]
        const SHOWN_PER_TURN = 8
        for (const f of perTurn.slice(0, SHOWN_PER_TURN)) {
          L.push(`    - 产出 \`${shortPath(f, root)}\``)
        }
        // 每轮内部的截断也要说：否则「这一轮只改了 8 个文件」会被当成事实
        if (perTurn.length > SHOWN_PER_TURN) L.push(`    - …该轮共 ${perTurn.length} 个产出，此处只列前 ${SHOWN_PER_TURN} 个`)
      }
      const firstFail = t.failures[0]
      if (firstFail) L.push(`    - ⚠️ 首次失败：\`${firstFail.tool}\` ${firstFail.kind}${firstFail.command ? ` · ${firstFail.command.slice(0, 60)}` : ''}`)
    }
    L.push('')
  }

  // ---- 汇总经验
  L.push(`## 六、这段时间的经验`)
  L.push('')
  const top = hist[0]
  if (top) L.push(`- 主力工具是 \`${top[0]}\`（${top[1]} 次，占 ${Math.round((top[1] / totals.toolCalls) * 100)}%）。`)
  const failRate = totals.toolCalls ? ((totals.failures / totals.toolCalls) * 100).toFixed(1) : '0'
  L.push(`- 工具层成功率 ${(100 - Number(failRate)).toFixed(1)}%，共 ${totals.failures} 次失败。`)
  if (totals.interrupted + totals.aborted > 0) {
    L.push(`- 有 ${totals.interrupted + totals.aborted} 个轮次非正常收尾（中断/中止），这些轮次的工作不会进入后续上下文。`)
  }
  const busiest = [...agg.days].sort((a, b) => b.toolCalls - a.toolCalls)[0]
  if (busiest) L.push(`- 最忙的一天是 ${busiest.day}（${busiest.toolCalls} 次工具调用、${busiest.turns.length} 个任务）。`)
  L.push('')

  L.push(`---`)
  L.push('')
  L.push(`_本报告由 dsh-agent-log 从 DSH 会话日志（只读）聚合生成。_`)
  L.push('')
  return L.join('\n')
}
