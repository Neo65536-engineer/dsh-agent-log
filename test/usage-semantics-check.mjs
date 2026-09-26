#!/usr/bin/env node
/**
 * 判定 cacheReadTokens / totalTokens 的口径：逐条累加 vs 取最大值。
 * 用 DSH 权威的 sessionTokenTotals 来判别哪个解释对得上。
 */
import { listSessions, readSessionLog, readProjectionCache } from '../core/session-log.mjs'
import { isLiveSession, splitDiffs } from './_live.mjs'
import { HOME } from './_home.mjs'

let sumHits = 0
let maxHits = 0
let n = 0
const rows = []

for (const entry of listSessions(HOME)) {
  const cache = readProjectionCache(HOME, entry.sessionId)
  const auth = cache?.record?.rows?.tokenUsage?.val?.totals
  if (!auth?.cacheReadTokens) continue
  let events
  try {
    events = readSessionLog(entry.file).events
  } catch {
    continue
  }
  const usages = events.filter((e) => e.type === 'assistant/message' && e.data?.usage).map((e) => e.data.usage)
  if (!usages.length) continue

  const sumCR = usages.reduce((a, u) => a + (u.cacheReadTokens ?? 0), 0)
  const maxCR = Math.max(...usages.map((u) => u.cacheReadTokens ?? 0))
  const sumOut = usages.reduce((a, u) => a + (u.outputTokens ?? 0), 0)
  const maxOut = Math.max(...usages.map((u) => u.outputTokens ?? 0))
  n++
  const sumOK = sumCR === auth.cacheReadTokens
  const maxOK = maxCR === auth.cacheReadTokens
  if (sumOK) sumHits++
  if (maxOK) maxHits++
  rows.push({
    id: entry.sessionId.slice(0, 20),
    sessionId: entry.sessionId,
    live: isLiveSession(entry),
    auth: auth.cacheReadTokens,
    sum: sumCR,
    max: maxCR,
    verdict: sumOK ? 'SUM' : maxOK ? 'MAX' : 'NEITHER',
    outAuth: auth.outputTokens,
    outSum: sumOut,
    outMax: maxOut,
  })
}

console.log('=== cacheReadTokens 口径判定 ===\n')
console.log('session'.padEnd(22) + 'auth'.padStart(13) + 'sum'.padStart(13) + 'max'.padStart(13) + '  判定')
for (const r of rows) {
  console.log(r.id.padEnd(22) + String(r.auth).padStart(13) + String(r.sum).padStart(13) + String(r.max).padStart(13) + '  ' + r.verdict)
}
console.log(`\n受检 ${n} 个会话：逐条累加命中 ${sumHits} · 取最大命中 ${maxHits}`)

// 同时看 outputTokens（已知应为逐条累加）
const outSumHits = rows.filter((r) => r.outSum === r.outAuth).length
console.log(`outputTokens 逐条累加命中 ${outSumHits}/${rows.length}（对照项，应接近全中）`)

// cacheReadTokens 必须是"逐条累加"，不是"取最大"。这是曾经差点写错的地方：
// 一次实测 42/42 命中累加、0/42 命中取最大，是判定性的。
// 活跃会话（含并发子代理）允许因读取竞态而领先，但**不允许少算**。
const mismatches = rows
  .filter((r) => r.verdict !== 'SUM')
  .map((r) => ({ sessionId: r.sessionId, live: r.live, k: 'cacheReadTokens', mine: r.sum, auth: r.auth, max: r.max }))
const { hard, drift } = splitDiffs(mismatches)

const sumVerdict = rows.filter((r) => r.verdict === 'SUM').length
const maxVerdict = rows.filter((r) => r.verdict === 'MAX').length
console.log(`\n口径判定：SUM ${sumVerdict} · MAX ${maxVerdict} · 都不符 ${rows.length - sumVerdict - maxVerdict}`)
if (drift.length) {
  console.log(`活跃会话竞态偏差（允许，${drift.length} 个）：`)
  for (const d of drift) console.log(`   ${d.sessionId.slice(0, 24)}  auth=${d.auth} sum=${d.mine} max=${d.max}`)
}

if (sumVerdict === 0) {
  console.log('\n❌ 累加口径一个都没命中 —— 口径判定失败')
  process.exit(1)
}
if (hard.length) {
  console.log(`\n❌ 有 ${hard.length} 个非活跃会话的 cacheReadTokens 用累加对不上权威值`)
  for (const d of hard) console.log(`   ${d.sessionId.slice(0, 24)}  auth=${d.auth} sum=${d.mine} max=${d.max}  [${d.kind}]`)
  process.exit(1)
}
console.log('\n✅ cacheReadTokens 口径确认 = 逐条累加（与 DSH 权威总量一致；仅活跃会话允许领先）')
process.exit(0)
