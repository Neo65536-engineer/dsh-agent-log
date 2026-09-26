#!/usr/bin/env node
/** 验证假设：权威 steps = step/end 数（已关闭的步），而非 step/start 数。 */
import { listSessions, readSessionLog, readProjectionCache } from '../core/session-log.mjs'
import { isLiveSession, splitDiffs } from './_live.mjs'
import { HOME } from './_home.mjs'

let startEqEnd = 0
let startEqAuth = 0
let endEqAuth = 0
let n = 0
const diffs = []

for (const entry of listSessions(HOME)) {
  const cache = readProjectionCache(HOME, entry.sessionId)
  const auth = cache?.record?.rows?.sessionStats?.val?.steps
  if (auth == null) continue
  let events
  try {
    events = readSessionLog(entry.file).events
  } catch {
    continue
  }
  if (!events.length) continue
  const ends = events.filter((e) => e.type === 'step/end').length
  const starts = events.filter((e) => e.type === 'step/start').length
  n++
  if (starts === ends) startEqEnd++
  if (starts === auth) startEqAuth++
  if (ends === auth) endEqAuth++
  if (ends !== auth) {
    diffs.push({ sessionId: entry.sessionId, live: isLiveSession(entry), k: 'steps', mine: ends, auth, starts })
  }
}

console.log(`受检会话 ${n}`)
console.log(`  step/start === step/end  : ${startEqEnd}`)
console.log(`  step/start === 权威 steps: ${startEqAuth}`)
console.log(`  step/end   === 权威 steps: ${endEqAuth}   ← 采用的口径`)

// 活跃会话允许因读取竞态而领先（多读），但不允许少读。
const { hard: stillBad, drift } = splitDiffs(diffs)

if (drift.length) {
  console.log(`\n活跃会话竞态偏差（允许，${drift.length} 个）:`)
  for (const d of drift) console.log(`  ${d.sessionId.slice(0, 24)}  start=${d.starts} end=${d.mine} auth=${d.auth}`)
}

if (stillBad.length) {
  console.log('\n❌ step/end 与权威不符的会话:')
  for (const d of stillBad) console.log(`  ${d.sessionId.slice(0, 24)}  start=${d.starts} end=${d.mine} auth=${d.auth}  [${d.kind}]`)
  process.exit(1)
}
console.log('\n✅ 所有非活跃会话的步数与 DSH 权威值一致（口径 = 已关闭的步）')
process.exit(0)
