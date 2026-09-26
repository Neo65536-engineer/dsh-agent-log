#!/usr/bin/env node
/**
 * 第三轮（畸形输入 / 边界鲁棒性排查）修掉的缺陷的回归测试。
 *
 * 这一轮的发现方式和前两轮不同：不是"读代码找错"，而是**造畸形输入**去撞。
 * 所以这里的断言也以合成为主 —— 每条都对应一个实测能触发的输入。
 *
 *   1. 分帧魔数误切：压缩流内部出现 `28 B5 2F FD` → 真帧被切成两段 → 两段都解不出
 *      → 整帧事件消失（实测 18 条变 0 条），报告结论从「完成」翻转成「还没有任务轮次」
 *   2. `t.todos` 形态异常（字符串 / 含 null）→ `renderReport` 抛异常 → 整个工具调用失败
 *   3. `usage` 字段是字符串/对象 → `+=` 变成字符串拼接 → 报告印出 `00[object Object]`（不报错）
 *   4. `turn` 非整数 → 排序比较得 NaN → 报告出现「### 轮次 undefined」
 *   5. `Math.max(0, ...turns.map(...))` → 12.5 万轮就 RangeError（参数上限）
 *   6. NUL / 半截 ESC 漏进 HTML 文档
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { readSessionLog, stripAnsi, firstLines } from '../core/session-log.mjs'
import { collectWorkRecord } from '../core/collect.mjs'
import { renderReport } from '../core/render.mjs'
import { markdownToHtml } from '../core/html.mjs'

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

const T0 = 1790000000000
let seq = 0
const ev = (type, time, data) => ({ type, seq: seq++, time, data })
const session = () => ({ type: 'session', seq: 0, time: T0, id: 'session-synth', cwd: 'C:\\work' })

const mk = (events) => { seq = 1; return collectWorkRecord([session(), ...events]) }
const safe = (fn) => { try { return { value: fn(), err: null } } catch (e) { return { value: null, err: e } } }

// ================================================================ 1. 分帧魔数误切
console.log('=== 1. 压缩流内部出现魔数时，不能把整帧丢掉 ===')
{
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const lines = []
  for (let i = 0; i < 9; i++) lines.push(JSON.stringify({ type: 'x', seq: i, time: T0 + i, data: { i } }))
  // 不可压缩内容会被 zstd 用 raw block **原样存储**，于是明文里的魔数字节会进压缩流
  const noise = Buffer.from(Array.from({ length: 1500 }, (_, i) => (i * 37 + 11) % 256))
  const payload = Buffer.concat([
    Buffer.from(lines.join('\n') + '\n', 'utf8'), MAGIC, noise, Buffer.from('\n' + lines.join('\n') + '\n', 'utf8'),
  ])
  const compressed = zstdCompressSync(payload)

  // 先确认这次真的在压缩流内部造出了魔数 —— 否则这条断言是空的
  let hits = 0
  let i = compressed.indexOf(MAGIC, 1)
  while (i !== -1) { hits++; i = compressed.indexOf(MAGIC, i + 1) }
  check('已造出「压缩流内部含魔数」的样本', hits > 0, `hits=${hits}（没造出来就无法验证）`)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-round3-'))
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, compressed)
  const r = readSessionLog(file)
  rmSync(dir, { recursive: true, force: true })

  check('误切不再导致数据丢失（18 条事件要全在）', r.events.length === 18, `events=${r.events.length} frames=${r.frames}`)
  check('也不该再报「帧损坏」', r.damaged.length === 0, JSON.stringify(r.damaged))
  check('事件内容完整（seq 0..8 出现两次）',
    r.events.filter((e) => e.type === 'x').length === 18,
    String(r.events.length))
}

// ================================================================ 2. todos 形态
console.log('\n=== 2. todo/write 形态异常时，报告不能整份渲染失败 ===')
{
  for (const [label, todos] of [['字符串', 'not-an-array'], ['含 null 元素', [null]], ['数字', 42], ['对象', {}]]) {
    const rec = mk([
      ev('turn/start', T0 + 1, { turn: 1 }),
      ev('todo/write', T0 + 2, { turn: 1, todos }),
      ev('turn/end', T0 + 3, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const r = safe(() => renderReport(rec))
    check(`todos 是${label}时不抛异常`, r.err === null, String(r.err?.message ?? ''))
  }
  // 正常形态仍要渲染出来
  const ok = mk([
    ev('turn/start', T0 + 1, { turn: 1 }),
    ev('todo/write', T0 + 2, { turn: 1, todos: [{ status: 'completed' }, { status: 'pending' }] }),
    ev('turn/end', T0 + 3, { turn: 1, reason: { kind: 'completed' } }),
  ])
  check('正常 todos 仍渲染「1/2 完成」', renderReport(ok).includes('待办清单：1/2 完成'))
}

// ================================================================ 2b. 其他"非数组外部字段"
console.log('\n=== 2b. 外部字段非数组/非字符串时也不能崩或漏出垃圾 ===')
{
  // `d.files ?? []` 挡不住数字 —— `for...of` 不可迭代直接抛。
  // 这是属性测试（随机污染流）撞出来的：800 条里 103 条走到这里。
  for (const [label, files] of [['数字', 3.14], ['对象', { a: 1 }], ['字符串', 'x'], ['含 null 元素', [null]]]) {
    // collect 也要包在 safe 里：否则守卫失效时是整个测试进程崩掉，
    // 报出来是一段栈而不是一条能读的失败断言
    const collected = safe(() => mk([
      ev('turn/start', T0 + 1, { turn: 1 }),
      ev('deliverables/presented', T0 + 2, { turn: 1, files }),
      ev('turn/end', T0 + 3, { turn: 1, reason: { kind: 'completed' } }),
    ]))
    check(`deliverables.files 是${label}时 collect 不抛异常`, collected.err === null, String(collected.err?.message ?? ''))
    if (!collected.value) continue
    const r = safe(() => renderReport(collected.value))
    check(`deliverables.files 是${label}时渲染不抛异常`, r.err === null, String(r.err?.message ?? ''))
  }

  // 元信息（会话 id / 工作目录 / 标题 / 权限档位 / 审批工具名）非字符串时会印出 [object Object]
  const rec = collectWorkRecord([
    { type: 'session', seq: 0, time: T0, id: { o: 1 }, cwd: [1], agentPreset: 3 },
    ev('session/title', T0 + 1, { title: { t: 1 } }),
    ev('sandbox/mode', T0 + 2, { mode: { m: 1 } }),
    ev('turn/start', T0 + 3, { turn: 1 }),
    ev('approval/asked', T0 + 4, { turn: 1, toolName: { n: 1 }, callId: 'x', reason: {} }),
    ev('tool/call', T0 + 5, { turn: 1, name: 'read', callId: 'r1', arguments: JSON.stringify({ file_path: { p: 1 } }) }),
    ev('tool/result', T0 + 6, { turn: 1, message: { source: { callId: 'r1' }, content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] } }),
    ev('turn/end', T0 + 7, { turn: 1, reason: { kind: 'completed' } }),
  ])
  const md = renderReport(rec)
  check('元信息非字符串时不出现 [object Object]', !md.includes('[object Object]'),
    (md.split('\n').find((l) => l.includes('[object Object]')) ?? '(无)').slice(0, 110))
  check('审批工具名有可读占位', /权限询问：[^\n]*\(object\)|权限询问：[^\n]*未知/.test(md),
    (md.match(/权限询问[^\n]*/) ?? ['(无)'])[0].slice(0, 110))
  check('失败条目的文件字段不出现 [object Object]', !/- \*\*`read`\*\*[^\n]*\[object Object\]/.test(md),
    (md.match(/- \*\*`read`\*\*[^\n]*/) ?? ['(无)'])[0].slice(0, 110))
}

// ================================================================ 3. 数值污染
console.log('\n=== 3. usage 字段被污染时，不能静默输出垃圾数字 ===')
{
  const rec = mk([
    ev('turn/start', T0 + 1, { turn: 1 }),
    ev('assistant/message', T0 + 2, { turn: 1, usage: { inputTokens: '100', outputTokens: 50, totalTokens: '9' } }),
    ev('turn/end', T0 + 3, { turn: 1, reason: { kind: 'completed' } }),
  ])
  check('字符串 usage 被当作数字（不是字符串拼接）',
    rec.totals.inputTokens === 100 && typeof rec.totals.inputTokens === 'number',
    `inputTokens=${JSON.stringify(rec.totals.inputTokens)} (${typeof rec.totals.inputTokens})`)

  const rec2 = mk([
    ev('turn/start', T0 + 1, { turn: 1 }),
    ev('assistant/message', T0 + 2, { turn: 1, usage: { inputTokens: 100, outputTokens: 1 } }),
    ev('assistant/message', T0 + 3, { turn: 1, usage: { inputTokens: {}, outputTokens: ['7'] } }),
    ev('turn/end', T0 + 4, { turn: 1, reason: { kind: 'completed' } }),
  ])
  check('后续轮次被污染也不会把全局变成字符串',
    typeof rec2.totals.inputTokens === 'number' && rec2.totals.inputTokens === 100,
    `inputTokens=${JSON.stringify(rec2.totals.inputTokens)}`)
  const md = renderReport(rec2)
  check('报告里不出现 [object Object]', !md.includes('[object Object]'))
  check('报告里 Token 行仍是纯数字', /\| 输入 Token（未缓存） \| 100 \|/.test(md),
    (md.match(/\| 输入 Token（未缓存） \|[^\n]*/) ?? ['(无)'])[0])
  check('上下文压力峰值不是 NaN', !/上下文压力峰值 \| NaN/.test(md))

  // 峰值走的是 Math.max：它会**强转** `'9'` 这种字符串数字，所以只测字符串抓不到
  // 「`?? 0` 不够用」这件事。要喂真正转不成数字的值（`'abc'` / 对象）才会变 NaN。
  const rec3 = mk([
    ev('turn/start', T0 + 1, { turn: 1 }),
    ev('assistant/message', T0 + 2, { turn: 1, usage: { inputTokens: 1, totalTokens: 'abc' } }),
    ev('assistant/message', T0 + 3, { turn: 1, usage: { totalTokens: {} } }),
    ev('turn/end', T0 + 4, { turn: 1, reason: { kind: 'completed' } }),
  ])
  const md3 = renderReport(rec3)
  check('上下文压力峰值在无法转成数字的污染下仍是有限数字',
    /上下文压力峰值 \| [\d,]+ \|/.test(md3),
    (md3.match(/上下文压力峰值 \| [^|]*/) ?? ['(无)'])[0])
}

// ================================================================ 4. turn 非整数
console.log('\n=== 4. turn 非整数时编号与排序要可信 ===')
{
  const rec = mk([
    ev('turn/start', T0 + 1, {}),                                   // 缺 turn
    ev('tool/call', T0 + 2, { turn: undefined, name: 'pwsh', callId: 'a', arguments: '{"command":"echo hi"}' }),
    ev('turn/start', T0 + 3, { turn: 2 }),
    ev('turn/end', T0 + 4, { turn: 2, reason: { kind: 'completed' } }),
  ])
  const turns = rec.turns.map((t) => t.turn)
  check('缺 turn 的轮次归一到 null（不是 undefined）', turns.includes(null), JSON.stringify(turns))
  check('轮次顺序可信（null 排最后）', turns[turns.length - 1] === null, JSON.stringify(turns))
  const md = renderReport(rec)
  check('报告里不出现「轮次 undefined」', !md.includes('轮次 undefined'), (md.match(/### 轮次[^\n]*/g) ?? []).join(' | '))
  check('缺号轮次渲染成「轮次 ?」', md.includes('### 轮次 ?'))
}

// ================================================================ 5. 规模悬崖
console.log('\n=== 5. 超长会话不能爆栈 ===')
{
  const N = 150000
  const rec = {
    cwd: 'C:\\w', sessionId: 's', title: 't', permissions: {}, scope: null,
    turns: Array.from({ length: N }, (_, i) => ({
      turn: i + 1, usage: { maxTotalTokens: 1 }, toolCalls: [], filesRead: [], filesWritten: [],
      filesEdited: [], commands: [], tests: [], failures: [], suspects: [], approvals: [], deliverables: [], steps: 0,
    })),
    totals: {
      turns: N, steps: 0, toolCalls: 0, failures: 0, suspects: 0, commands: 0, tests: 0, testsPassed: 0,
      testsFailed: 0, testsUnknown: 0, filesRead: 0, filesWritten: 0, filesEdited: 0, uniqueFilesTouched: 0,
      retries: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, durationMs: 0,
      completed: N, aborted: 0, interrupted: 0, toolDetail: [], fileDetail: [], allCommands: [], allTests: [],
      completionRate: 100, endedTurns: N, finished: true,
    },
  }
  const r = safe(() => renderReport(rec))
  check(`renderReport 在 ${N} 轮下不抛栈溢出`, r.err === null, String(r.err?.message ?? ''))
}

// ================================================================ 6. 控制字符
console.log('\n=== 6. NUL / 半截 ESC 不能漏进 HTML ===')
{
  // 注意职责划分：`markdownToHtml`/`esc()` 只保证**不出现控制字符**（NUL/ESC），
  // 剥 ANSI 是采集层（stripAnsi/firstLines）的活儿。所以这里分两层验，
  // 不要指望渲染器去"清理"内容 —— 它会把 `[31m` 当普通文本留下（那是正确的，它只是文本）。
  const md = '# 标题\n\n| a | b |\n| --- | --- |\n| \u0000x | \u001b[31mred\u001b[0m |\n\n半截：\u001b[38;2;140;140\n'
  const doc = markdownToHtml(md)
  check('HTML 里没有裸 NUL', !doc.includes('\u0000'))
  check('HTML 里没有裸 ESC', !doc.includes('\u001b'))
  check('正常内容没被误删', doc.includes('red'))

  // 采集层：真实报告管线里不能残留 ANSI
  const rec = mk([
    ev('turn/start', T0 + 1, { turn: 1 }),
    ev('tool/call', T0 + 2, { turn: 1, name: 'pwsh', callId: 'a', arguments: JSON.stringify({ command: '\u001b[31mnpm test\u001b[0m' }) }),
    ev('tool/result', T0 + 3, { turn: 1, message: { source: { callId: 'a' }, content: [{ type: 'text', text: '\u001b[31mfail\u001b[0m\n\u001b[38;2;140;140' }] } }),
    ev('turn/end', T0 + 4, { turn: 1, reason: { kind: 'completed' } }),
  ])
  const rep = renderReport(rec)
  check('报告 markdown 里没有 ESC', !rep.includes('\u001b'))
  check('报告 HTML 里也没有 ESC', !markdownToHtml(rep).includes('\u001b'))
  check('命令里的完整 ANSI 已被剥掉（只剩 npm test）',
    rep.includes('npm test') && !rep.includes('[31m'), (rep.match(/\| 1 \|[^\n]*/) ?? ['(无命令行)'])[0].slice(0, 120))
  check('stripAnsi 处理半截序列', !stripAnsi('a\u001b[38;2;140;140b').includes('\u001b'))
  check('firstLines 也不残留 ESC', !String(firstLines('x\u001b[38;2;1;2', 1)).includes('\u001b'))
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
