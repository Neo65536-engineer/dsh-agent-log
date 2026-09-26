#!/usr/bin/env node
/**
 * 属性测试：随机事件流 + 随机类型污染 + 读帧往返。
 *
 * 与前几轮的区别（这是第四种找 bug 的方式）：
 *   · 读代码      —— 擅长发现"逻辑写错了"
 *   · 用户侧使用  —— 擅长发现"换台机器/换个用法就坏"
 *   · 手工造畸形输入 —— 擅长发现"没人想过这种输入"
 *   · **属性测试**  —— 由生成器去找"我根本想不出来的组合"，用**不变量**而不是预期输出来判定
 *
 * 它当场就抓到了手工想不到的东西：`for (const f of d.files ?? [])` ——
 * `??` 只挡 null/undefined，数字/对象**不可迭代**，一次畸形 `deliverables/presented`
 * 就让整次 `work_report` 抛错（800 条随机流里 103 条走到这里）。
 *
 * 断言的三类不变量：
 *   A. 交叉求和：totals 必须等于逐轮求和（"总览与明细对不上"的通用探测器）
 *   B. 三态/完成率自洽
 *   C. 输出卫生：报告里不出现 undefined / NaN / Infinity / [object Object]（用户内容区除外）
 *   D. 读帧往返：随机多帧文件（含内部魔数）必须原样读回
 *
 * 确定性：全部用固定种子，同一份代码每次跑结果一致（不像按 mtime 挑样本那种会漂移）。
 */
import { zstdCompressSync } from 'node:zlib'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectWorkRecord, rescoreRecord } from '../core/collect.mjs'
import { renderReport } from '../core/render.mjs'
import { markdownToHtml } from '../core/html.mjs'
import { readSessionLog } from '../core/session-log.mjs'

let pass = 0
let fail = 0
const problems = []
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}
const note = (m) => { problems.push(m) }

// ---------------------------------------------------------------- 生成器
/**
 * 「合法但类型不对」的值。
 * **不要**放 'NaN' / 'Infinity' / '[object Object]' 这些**字符串** ——
 * 它们正是输出卫生要抓的 token，作为字符串数据出现是合法的（用户内容里就可能写），
 * 放进来会把断言变成假阳性。这里只放不与待检 token 重名的字符串。
 */
const JUNK = [
  null, 0, -1, 1, 3.14, '', 'x', '0', '100', 'abc', true, false,
  [], [1, 2], [null], {}, { a: 1 }, 2 ** 53, -0,
]

const TOOLS = ['read', 'write', 'edit', 'pwsh', 'glob']
const PATHS = ['C:\\w\\a.js', '/tmp/x']
const CMDS = ['npm run verify', 'Get-ChildItem | Select-Object Name', 'node test/x.mjs', 'git status --short']

function makeGen(seed) {
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
  const chance = (p) => rnd() < p
  const junk = () => pick(JUNK)
  const maybeJunk = (v) => (chance(0.15) ? junk() : v)

  function gen() {
    const T0 = 1790000000000
    const events = [{ type: 'session', seq: 0, time: T0, id: maybeJunk('session-prop'), cwd: maybeJunk('C:\\w') }]
    let seq = 1
    for (let t = 1, turns = int(1, 5); t <= turns; t++) {
      const base = T0 + t * 60000
      const turnNo = chance(0.12) ? junk() : t
      events.push({ type: 'turn/start', seq: seq++, time: base, data: { turn: turnNo } })
      if (chance(0.8)) {
        events.push({ type: 'user/message', seq: seq++, time: base + 1, data: { turn: turnNo, source: { kind: 'user' }, content: maybeJunk(`任务 ${t}`) } })
      }
      for (let i = 0, n = int(0, 5); i < n; i++) {
        const callId = chance(0.1) ? junk() : `c${t}-${i}`
        const name = chance(0.12) ? junk() : pick(TOOLS)
        const k = int(0, 2)
        const args = k === 0 ? { command: chance(0.3) ? junk() : pick(CMDS) }
          : k === 1 ? { file_path: chance(0.3) ? junk() : pick(PATHS) }
          : { command: pick(CMDS), description: junk() }
        const argsRaw = chance(0.1) ? pick(['{bad json', '', null, 42, [], {}]) : JSON.stringify(args)
        events.push({ type: 'tool/call', seq: seq++, time: base + 100 + i, data: { turn: turnNo, name, callId, arguments: argsRaw } })
        if (chance(0.9)) {
          const text = chance(0.25) ? junk() : pick(['ok', 'boom\n[exit code: 1]', '通过 1 · 失败 0', '\u001b[31mred'])
          events.push({
            type: 'tool/result', seq: seq++, time: base + 102 + i,
            data: {
              turn: turnNo,
              error: chance(0.1) ? { code: 'E_X', message: chance(0.3) ? junk() : 'bad' } : undefined,
              message: chance(0.1) ? junk() : { source: { callId }, content: chance(0.15) ? junk() : [{ type: 'text', text }] },
            },
          })
        }
      }
      if (chance(0.7)) {
        const u = { inputTokens: maybeJunk(int(0, 900)), outputTokens: maybeJunk(int(0, 90)), cacheReadTokens: maybeJunk(int(0, 9000)), reasoningTokens: maybeJunk(5), totalTokens: maybeJunk(int(0, 6000)) }
        events.push({ type: 'assistant/message', seq: seq++, time: base + 300, data: { turn: turnNo, usage: chance(0.1) ? junk() : u } })
      }
      if (chance(0.25)) {
        events.push({ type: 'todo/write', seq: seq++, time: base + 400, data: { turn: turnNo, todos: chance(0.35) ? junk() : [{ status: 'completed' }, junk()] } })
      }
      if (chance(0.2)) {
        events.push({ type: 'approval/asked', seq: seq++, time: base + 450, data: { turn: turnNo, toolName: maybeJunk('pwsh'), callId: maybeJunk('c1'), reason: junk() } })
      }
      if (chance(0.15)) {
        events.push({ type: 'deliverables/presented', seq: seq++, time: base + 460, data: { turn: turnNo, files: chance(0.4) ? junk() : [{ path: maybeJunk('C:\\w\\out.md'), description: junk() }] } })
      }
      if (chance(0.85)) {
        events.push({ type: 'turn/end', seq: seq++, time: base + 5000, data: { turn: turnNo, reason: chance(0.15) ? junk() : { kind: pick(['completed', 'completed', 'aborted', 'interrupted']) } } })
      }
    }
    return events
  }
  return { gen, rnd, pick, int, chance }
}

// 结构性位置才查这些 token：任务/说明/命令/输出是用户内容，天然可能包含这些字面量
const contentLine = /^\*\*任务\*\*|说明：|输出：|命令：|^- \*\*`/

const SEEDS = [1, 42, 20260926]
const RUNS_PER_SEED = 250

console.log('=== A. 随机污染流：不抛异常、不变量成立、输出卫生 ===')
let streams = 0
for (const seed of SEEDS) {
  const { gen } = makeGen(seed)
  for (let run = 0; run < RUNS_PER_SEED; run++) {
    let rec
    try { rec = collectWorkRecord(gen()) } catch (e) { note(`seed${seed}#${run} collect 抛错：${e.message}`); continue }
    let md
    try { md = renderReport(rec) } catch (e) { note(`seed${seed}#${run} renderReport 抛错：${e.message}`); continue }
    let html
    try { html = markdownToHtml(md) } catch (e) { note(`seed${seed}#${run} markdownToHtml 抛错：${e.message}`); continue }
    streams++

    const T = rec.totals
    for (const k of ['turns', 'toolCalls', 'failures', 'suspects', 'commands', 'tests', 'testsPassed', 'testsFailed', 'testsUnknown', 'steps', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'retries', 'endedTurns']) {
      if (typeof T[k] !== 'number' || !Number.isFinite(T[k])) note(`seed${seed}#${run} totals.${k}=${JSON.stringify(T[k])}（${typeof T[k]}）`)
    }
    const sum = (f) => rec.turns.reduce((a, t) => a + f(t), 0)
    if (T.toolCalls !== sum((t) => t.toolCalls.length)) note(`seed${seed}#${run} toolCalls 交叉求和不符`)
    if (T.failures !== sum((t) => t.failures.length)) note(`seed${seed}#${run} failures 交叉求和不符`)
    if (T.commands !== sum((t) => t.commands.length)) note(`seed${seed}#${run} commands 交叉求和不符`)
    if (T.tests !== sum((t) => t.tests.length)) note(`seed${seed}#${run} tests 交叉求和不符`)
    if (T.steps !== sum((t) => t.steps)) note(`seed${seed}#${run} steps 交叉求和不符`)
    if (T.testsPassed + T.testsFailed + T.testsUnknown !== T.tests) note(`seed${seed}#${run} 三态不自洽`)
    const ended = T.completed + T.aborted + T.interrupted
    if (T.endedTurns !== ended) note(`seed${seed}#${run} endedTurns 不符`)
    if (T.completionRate !== (ended > 0 ? Math.round((T.completed / ended) * 100) : null)) note(`seed${seed}#${run} completionRate 不符`)

    for (const tok of ['undefined', 'NaN', '[object Object]', 'Infinity']) {
      const hit = md.split('\n').find((l) => l.includes(tok) && !contentLine.test(l))
      if (hit) note(`seed${seed}#${run} 报告含 ${tok}：${hit.slice(0, 90)}`)
    }
    if (html.includes('\u0000') || html.includes('\u001b')) note(`seed${seed}#${run} HTML 含控制字符`)
  }
}
check(`A. ${SEEDS.length} 个种子 × ${RUNS_PER_SEED} 条污染流（成功渲染 ${streams} 条）`,
  problems.length === 0, problems.slice(0, 5).join(' | '))

console.log('\n=== B. 幂等 / 重算不漏不重 ===')
{
  const { gen } = makeGen(99)
  let bad = 0
  for (let i = 0; i < 60; i++) {
    const events = gen()
    const a = collectWorkRecord(events)
    const b = collectWorkRecord(events)
    if (JSON.stringify(a.totals) !== JSON.stringify(b.totals)) bad++
    const rescored = rescoreRecord(JSON.parse(JSON.stringify(a))).totals
    if (JSON.stringify(rescored) !== JSON.stringify(a.totals)) bad++
    // 截断最近 N 轮后重算，必须等于"只喂这些轮次"
    if (a.turns.length > 1) {
      const n = 1 + (i % a.turns.length)
      const slice = a.turns.slice(-n)
      const viaSlice = rescoreRecord({ ...JSON.parse(JSON.stringify(a)), turns: slice }).totals
      if (viaSlice.turns !== n) bad++
      if (viaSlice.toolCalls !== slice.reduce((x, t) => x + t.toolCalls.length, 0)) bad++
    }
  }
  check('B. 60 组：二次 collect 一致、rescoreRecord 不改变总量、截断重算正确', bad === 0, `${bad} 处`)
}

console.log('\n=== C. 读帧往返：随机多帧文件必须原样读回 ===')
{
  const { rnd, int, chance } = makeGen(2024)
  let bad = 0
  let magicFrames = 0
  let magicRounds = 0
  for (let round = 0; round < 30; round++) {
    const frames = []
    const expect = []
    const nFrames = int(1, 12)
    let roundHasMagic = false
    for (let f = 0; f < nFrames; f++) {
      const lines = []
      for (let i = 0, n = int(1, 8); i < n; i++) {
        const obj = { type: 'x', seq: expect.length, time: 1790000000000 + expect.length }
        lines.push(JSON.stringify(obj))
        expect.push(obj)
      }
      let payload = Buffer.from(lines.join('\n') + '\n', 'utf8')
      // 三成概率往明文里塞魔数：压缩成 raw block 后它会出现在压缩流内部，
      // 这正是"魔数误切"的触发条件（见 regression-round3）
      if (chance(0.3)) {
        magicFrames++
        roundHasMagic = true
        const noise = Buffer.from(Array.from({ length: int(50, 900) }, () => Math.floor(rnd() * 256)))
        payload = Buffer.concat([payload, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), noise])
      }
      frames.push(zstdCompressSync(payload))
    }
    if (roundHasMagic) magicRounds++
    const dir = mkdtempSync(join(tmpdir(), 'dsh-prop-'))
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.concat(frames))
    let r
    try { r = readSessionLog(file) } catch (e) { bad++; note(`往返#${round} 抛错 ${e.message}`); rmSync(dir, { recursive: true, force: true }); continue }
    rmSync(dir, { recursive: true, force: true })
    const got = r.events.filter((e) => e.type === 'x')
    if (got.length !== expect.length) bad++
    else if (JSON.stringify(got.map((e) => e.seq)) !== JSON.stringify(expect.map((e) => e.seq))) bad++
  }
  check(`C. 30 组随机多帧文件全部原样读回（${magicRounds} 组含内部魔数，共 ${magicFrames} 帧）`, bad === 0, `${bad} 组失败`)
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
if (problems.length) {
  console.log(`\n问题摘录（最多 8 条）：`)
  for (const p of problems.slice(0, 8)) console.log(`  · ${p}`)
}
process.exit(fail === 0 ? 0 : 1)
