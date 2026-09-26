#!/usr/bin/env node
/**
 * 健壮性验收：会话日志是**边写边读**的。
 *
 * DSH 在 agent 干活时持续往 session.v4.jsonl.zstd 追加 zstd 帧。插件按需读取，
 * 因此「最后一个帧是残缺的」是**常态而非边缘情况**。如果读者在这种情况下
 * 抛错或静默丢数据，任务进行中生成的报告就是错的。
 *
 * 验证：
 *   1. 在任意字节位置截断，readSessionLog 都不能抛错
 *   2. 截断点之前的完整帧必须全部读出（只允许丢最后那个残缺帧）
 *   3. 残缺帧要被计数上报，不能假装没发生
 *   4. 空文件 / 只有头帧 / 全垃圾 都要安全降级
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionLog, listSessions, readProjectionCache } from '../core/session-log.mjs'
import { collectWorkRecord } from '../core/collect.mjs'

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${extra}`)
  }
}

const HOME = process.env.DSH_HOME || 'E:\\tools\\dsh'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// 挑一个体量适中的真实会话
const target = listSessions(HOME).find((s) => s.bytes > 200_000 && s.bytes < 1_500_000)
if (!target) {
  console.error('找不到合适的测试会话')
  process.exit(2)
}
console.log(`基准会话: ${target.sessionId}`)
console.log(`文件大小: ${target.bytes} B（列目录时的快照）`)

/**
 * 基线必须**冻结成一份快照**再测。
 *
 * 为什么：`listSessions` 报的 bytes 是列目录那一刻的 stat，而日志正在被实时追加。
 * 先前这里紧跟着 `readFileSync(target.file)` 重读原文件，于是「bytes」和「实际读到的字节」
 * 根本不是同一份数据 —— 实测踩过：这个文件在 0.3 秒内长了 7 万字节，
 * 快照里那处「最后一帧」在读的时候已经不是最后一帧了，
 * §2 的三条断言（识别出 1 个损坏帧 / 完整帧数 = 魔数数 - 1）随机变红。
 *
 * 这不是读者（插件）的缺陷，是测试的取数方式在拿一个移动目标。
 * 冻结一次之后，后续所有截断、魔数计数都基于同一份字节，结论才是确定的。
 */
const original = readFileSync(target.file)
// 冻结的同时按同一份字节重新数一遍帧，避免再依赖 stat 的陈旧值
let frozenFrames = 0
for (let i = original.indexOf(MAGIC); i !== -1; i = original.indexOf(MAGIC, i + 1)) frozenFrames++
console.log(`冻结快照: ${original.length} B / ${frozenFrames} 个帧魔数`)

const full = readSessionLog(target.file)
console.log(`完整读取: ${full.events.length} 事件 / ${full.frames} 帧 / ${full.damaged.length} 损坏\n`)

const work = mkdtempSync(join(tmpdir(), 'dsh-worklog-robust-'))
const tmpFile = join(work, 'session.v4.jsonl.zstd')
// 目录级边界测试要用的「一份真实日志」，也从同一份冻结快照来 ——
// 直接 copyFileSync(target.file) 会复制到一个仍在增长的文件，同样是不确定的。
const frozenLog = join(work, 'frozen.v4.jsonl.zstd')
writeFileSync(frozenLog, original)

// ---------------------------------------------------------------- 1. 截断
console.log('=== 1. 在 40 个随机字节位置截断 ===')
let truncFailures = 0
let maxLost = 0
const samples = []
for (let i = 0; i < 40; i++) {
  // 覆盖文件前 60% 的随机位置，确保落点常常在帧中间
  const cut = Math.floor((i / 40) * original.length * 0.6) + 1
  writeFileSync(tmpFile, original.subarray(0, cut))

  let res
  try {
    res = readSessionLog(tmpFile)
  } catch (e) {
    truncFailures++
    samples.push({ cut, error: String(e.message) })
    continue
  }

  // 截断点之前有多少个完整帧魔数
  const before = original.subarray(0, cut)
  let framesBefore = 0
  let idx = before.indexOf(MAGIC, 0)
  while (idx !== -1) {
    framesBefore++
    idx = before.indexOf(MAGIC, idx + 1)
  }
  // 读者至少应读出 framesBefore - 1 帧（最后一帧可能被截断）
  const got = res.frames - res.damaged.length
  if (got < framesBefore - 1) {
    truncFailures++
    samples.push({ cut, framesBefore, got, damaged: res.damaged.length })
  }
  maxLost = Math.max(maxLost, framesBefore - got)
}

check('40 个截断点全部未抛错', truncFailures === 0,
  truncFailures ? `${truncFailures} 个失败: ${JSON.stringify(samples.slice(0, 3))}` : '')
check('最多只丢最后 1 个残缺帧', maxLost <= 1, `maxLost=${maxLost}`)

// ---------------------------------------------------------------- 2. 残缺帧上报
console.log('\n=== 2. 残缺帧必须被计数上报 ===')
// 在某个帧中间切断
const secondMagic = original.indexOf(MAGIC, 1)
const thirdMagic = original.indexOf(MAGIC, secondMagic + 1)
const cutMid = thirdMagic + Math.floor((original.indexOf(MAGIC, thirdMagic + 1) - thirdMagic) / 2)
writeFileSync(tmpFile, original.subarray(0, cutMid))
const mid = readSessionLog(tmpFile)
check('中途截断不抛错', true)
check('识别出 1 个损坏帧', mid.damaged.length === 1, `damaged=${mid.damaged.length}`)
check('损坏帧带 offset 与 error', mid.damaged[0]?.offset !== undefined && !!mid.damaged[0]?.error,
  JSON.stringify(mid.damaged[0] ?? {}))
check('完整帧数 = 魔数数 - 1', mid.frames - mid.damaged.length === 2,
  `frames=${mid.frames} damaged=${mid.damaged.length}`)

// 能正常折叠出记录
let rec = null
let recErr = null
try {
  rec = collectWorkRecord(mid.events)
} catch (e) {
  recErr = e
}
check('截断后仍能折叠出工作记录', recErr === null && rec !== null, String(recErr?.message))

// ---------------------------------------------------------------- 3. 退化输入
console.log('\n=== 3. 退化输入的安全降级 ===')
const cases = [
  ['空文件', Buffer.alloc(0)],
  ['只有 1 字节', Buffer.from([0x28])],
  ['只有魔数', MAGIC],
  ['纯垃圾字节', Buffer.from('this is not zstd at all, just text'.repeat(20))],
  ['魔数后跟垃圾', Buffer.concat([MAGIC, Buffer.from('garbagegarbagegarbage')])],
]
for (const [name, buf] of cases) {
  writeFileSync(tmpFile, buf)
  let r = null
  let e = null
  try {
    r = readSessionLog(tmpFile)
  } catch (err) {
    e = err
  }
  check(`${name} 不抛错且返回空事件`, e === null && r !== null && r.events.length === 0,
    e ? String(e.message) : `events=${r?.events.length}`)
}

// ---------------------------------------------------------------- 4. 目录级边界
console.log('\n=== 4. 目录级边界 ===')
const fakeHome = join(work, 'fakehome')
;['sessions/--X--/no-log-here', 'sessions/--X--/empty-dir', 'storages/session_projcache/sessions'].forEach((p) => {
  mkdirSync(join(fakeHome, p), { recursive: true })
})
const list = listSessions(fakeHome)
check('没有日志文件的会话目录被跳过', list.length === 0, `len=${list.length}`)
check('不存在的 DSH home 返回空数组', listSessions(join(work, 'nope')).length === 0)
check('不存在的会话投影缓存返回 null', readProjectionCache(fakeHome, 'nope') === null)

// 放一个真实文件进去，确认能被列出
copyFileSync(frozenLog, join(fakeHome, 'sessions/--X--/no-log-here', 'session.v4.jsonl.zstd'))
const list2 = listSessions(fakeHome)
check('放入日志后能被列出', list2.length === 1, `len=${list2.length}`)
check('列表带 formatVersion', list2[0]?.formatVersion === 4, String(list2[0]?.formatVersion))

// 多版本并存：应选最高版本
const d = join(fakeHome, 'sessions/--X--/multi')
mkdirSync(d, { recursive: true })
copyFileSync(frozenLog, join(d, 'session.jsonl.zstd'))
copyFileSync(frozenLog, join(d, 'session.v4.jsonl.zstd'))
const multi = listSessions(fakeHome).find((s) => s.sessionId === 'multi')
check('多版本并存时选 v4', multi?.formatVersion === 4, String(multi?.formatVersion))
check('保留了全部候选供诊断', Array.isArray(multi?.allLogs) && multi.allLogs.length === 2,
  JSON.stringify(multi?.allLogs))

// ---------------------------------------------------------------- 清理
rmSync(work, { recursive: true, force: true })
check('临时目录已清理', !existsSync(work))

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
