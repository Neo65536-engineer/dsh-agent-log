#!/usr/bin/env node
/**
 * 报告数字准确性回归测试。
 *
 * 把「我从会话日志算出来的值」与「DSH 自己折叠出的权威值」逐会话对照。
 * 权威来源 = storages/session_projcache/sessions/<id>.json
 *
 * 判定规则：
 *   - 非活跃会话：轮次/步数/输入/输出/缓存读取 必须**完全相等**，否则失败。
 *   - 当前活跃会话（DSH_SESSION_ID）：允许极小偏差。原因是读取顺序竞态——
 *     先读日志再读投影缓存，会话在这两次读之间又追加了事件。
 *     这类偏差只允许"我比权威多"，不允许"我比权威少"（少说明漏读）。
 */
import { listSessions, readSessionLog, readProjectionCache } from '../core/session-log.mjs'
import { collectWorkRecord } from '../core/collect.mjs'
import { isLiveSession, splitDiffs } from './_live.mjs'
import { HOME } from './_home.mjs'

let checked = 0
let exact = 0
const allDiffs = []

for (const entry of listSessions(HOME)) {
  const cache = readProjectionCache(HOME, entry.sessionId)
  const rows = cache?.record?.rows
  if (!rows) continue

  let events
  try {
    events = readSessionLog(entry.file).events
  } catch {
    continue
  }
  if (events.length === 0) continue

  const T = collectWorkRecord(events).totals
  const auth = {
    turns: rows.sessionStats?.val?.turns,
    steps: rows.sessionStats?.val?.steps,
    input: rows.tokenUsage?.val?.totals?.uncachedInputTokens,
    output: rows.tokenUsage?.val?.totals?.outputTokens,
    cacheRead: rows.tokenUsage?.val?.totals?.cacheReadTokens,
  }
  const mine = {
    turns: T.turns,
    steps: T.steps,
    input: T.inputTokens,
    output: T.outputTokens,
    cacheRead: T.cacheReadTokens,
  }

  checked++
  const live = isLiveSession(entry)
  let entryDiffs = 0
  for (const k of Object.keys(auth)) {
    if (auth[k] == null) continue
    if (auth[k] !== mine[k]) {
      entryDiffs++
      allDiffs.push({ sessionId: entry.sessionId, k, mine: mine[k], auth: auth[k], live })
    }
  }
  if (entryDiffs === 0) exact++
}

const { hard: failures, drift: liveDrift } = splitDiffs(allDiffs)

console.log('=== 报告数字准确性对照 ===')
console.log(`受检会话          : ${checked}`)
console.log(`与权威值完全一致  : ${exact}`)
console.log(`活跃会话竞态偏差  : ${liveDrift.length}${liveDrift.length ? '（允许，见下）' : ''}`)
console.log(`失败              : ${new Set(failures.map((f) => f.sessionId)).size}`)

if (liveDrift.length) {
  console.log('\n活跃会话竞态偏差（读取顺序导致，非逻辑错误）:')
  for (const d of liveDrift) {
    console.log(`  ${d.sessionId.slice(0, 24)}  ${d.k}: 我 ${d.mine} > 权威 ${d.auth}`)
  }
}

if (failures.length) {
  console.log('\n❌ 失败明细:')
  for (const f of failures) {
    console.log(`  ${f.sessionId}  [${f.kind}]`)
    console.log(`    - ${f.k}: 我 ${f.mine} vs 权威 ${f.auth}`)
  }
  process.exit(1)
}

console.log('\n✅ 除活跃会话的读取竞态外，全部与 DSH 权威值一致')
process.exit(0)
