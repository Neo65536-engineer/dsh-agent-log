#!/usr/bin/env node
/**
 * 第二轮用户侧评审修掉的缺陷的回归测试。
 *
 * 每个断言都对应一个**实测发生过**的缺陷（括号里是当时的症状）：
 *   1. 宿主 `detectHome()` 少了 `~/.dsh` 兜底（默认安装的机器上整个插件不可用：
 *      工具抛「找不到 DSH home」、路由 500、面板空白）
 *   2. 表格单元格里的 `|` 没转义（命令带管道 → markdown 表格断列、HTML 里 <td> 比 <th> 多）
 *   3. 面板与 markdown/HTML 各除一遍完成率、分母还不同（同一份数据 100% vs 50%）
 *   4. 「七、逐轮明细」没受 DETAIL_LIMIT 约束（上限形同虚设，长会话照样几十上百 KB）
 *   5. 日报/周报的三处截断是静默的（37 个工具里静默丢掉 17 个）
 *   6. `regression-fixes` 的「命令明细行数」把测试表的行也数进去（同一份代码时红时绿）
 *
 * 为什么这一轮要单独成文件：上面 1、2、6 三条之所以能躲过此前所有测试，是因为
 * 测试**只在自己的机器上、只断言自己想到的字段**。所以这里刻意做了两类此前没有的验证：
 *   - 「换一台机器」（第 1 节真的把 DSH_* 清掉、把 home 指到临时目录）
 *   - 「断言输出的**形状**」而不只是字段（第 2 节的列数一致性）
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply, detectHome, buildReport } from '../index.js'
import { renderReport, DETAIL_LIMIT } from '../core/render.mjs'
import { markdownToHtml } from '../core/html.mjs'
import { collectWorkRecord } from '../core/collect.mjs'
import { renderPeriod } from '../core/period.mjs'
import { HOME } from './_home.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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

// ================================================================ 造合成记录
//
// 用**真事件流**喂 collectWorkRecord，而不是手搓一个 record 对象：
// 手搓的 record 一旦字段对不上渲染器，测的就是"我的假数据"而不是真实管线。
const T0 = 1790000000000
let seq = 0

function ev(type, time, data) {
  return { type, seq: seq++, time, data }
}

/**
 * @param {{turns?:number, commandsPerTurn?:number, command?:Function, testsPerTurn?:number,
 *          failEvery?:number, filesPerTurn?:number, unfinishedLast?:boolean}} o
 */
function synthRecord(o = {}) {
  const turns = o.turns ?? 1
  const commandsPerTurn = o.commandsPerTurn ?? 0
  const cmdOf = o.command ?? ((i) => `echo ${i}`)
  const testsPerTurn = o.testsPerTurn ?? 0
  const filesPerTurn = o.filesPerTurn ?? 0
  const failEvery = o.failEvery ?? 0
  const unfinishedLast = o.unfinishedLast === true

  seq = 0
  const events = [ev('session', T0, undefined)]
  events[0] = { type: 'session', seq: seq++, time: T0, id: 'session-synth', cwd: 'C:\\work' }

  for (let t = 1; t <= turns; t++) {
    const base = T0 + t * 60000
    events.push(ev('turn/start', base, { turn: t }))
    events.push(ev('user/message', base + 10, { turn: t, source: { kind: 'user' }, content: `任务 ${t}` }))

    for (let i = 0; i < commandsPerTurn; i++) {
      const callId = `c${t}-${i}`
      const command = cmdOf(i)
      events.push(ev('tool/call', base + 100 + i * 10, {
        turn: t, name: 'pwsh', callId, arguments: JSON.stringify({ command }),
      }))
      const bad = failEvery > 0 && i % failEvery === 0 && i > 0
      events.push(ev('tool/result', base + 105 + i * 10, {
        turn: t,
        message: { source: { callId }, content: [{ type: 'text', text: bad ? 'boom\n[exit code: 1]' : 'ok' }] },
      }))
    }

    for (let i = 0; i < testsPerTurn; i++) {
      const callId = `t${t}-${i}`
      events.push(ev('tool/call', base + 200 + i * 10, {
        turn: t, name: 'pwsh', callId, arguments: JSON.stringify({ command: `npm run verify # ${i}` }),
      }))
      events.push(ev('tool/result', base + 205 + i * 10, {
        turn: t, message: { source: { callId }, content: [{ type: 'text', text: '通过 3 · 失败 0' }] },
      }))
    }

    for (let i = 0; i < filesPerTurn; i++) {
      const callId = `f${t}-${i}`
      events.push(ev('tool/call', base + 300 + i * 10, {
        turn: t, name: 'read', callId, arguments: JSON.stringify({ file_path: `C:\\work\\f${t}-${i}.js` }),
      }))
      events.push(ev('tool/result', base + 305 + i * 10, {
        turn: t, message: { source: { callId }, content: [{ type: 'text', text: 'ok' }] },
      }))
    }

    // 最后一轮故意不写 turn/end：这才是"进行中"在日志里的真实形态。
    // 注意不能在 collectWorkRecord 之后再改 turns —— totals 是那一刻算好的，改了不会重算。
    if (!(unfinishedLast && t === turns)) {
      events.push(ev('turn/end', base + 5000, { turn: t, reason: { kind: 'completed' } }))
    }
  }
  return collectWorkRecord(events)
}

// 表格审计：按**未转义**的 `|` 切单元格（与 core/html.mjs 的 cells() 同一口径）
const splitCells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)

function mdTableBreaks(md) {
  const lines = String(md).split('\n')
  const bad = []
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue
    const nHead = splitCells(lines[i]).length
    let j = i + 2
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
      if (splitCells(lines[j]).length !== nHead) bad.push({ line: j + 1, nHead, n: splitCells(lines[j]).length })
      j++
    }
    i = j - 1
  }
  return bad
}

function htmlTableBreaks(doc) {
  const bad = []
  for (const t of String(doc).matchAll(/<table>[\s\S]*?<\/table>/g)) {
    const nth = (t[0].match(/<th>/g) ?? []).length
    for (const row of t[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const ntd = (row[1].match(/<td>/g) ?? []).length
      if (ntd !== nth && ntd > 0) bad.push({ nth, ntd })
    }
  }
  return bad
}

// ================================================================ 1. 默认 home
console.log('=== 1. 宿主必须能自己找到默认的 ~/.dsh（$DSH_HOME 未设时）===')
{
  const fakeUser = mkdtempSync(join(tmpdir(), 'dsh-round2-home-'))
  // 造一个"从没设过 DSH_HOME 的机器"：home 就是 ~/.dsh
  mkdirSync(join(fakeUser, '.dsh', 'sessions', '--C-work--', 'session-x'), { recursive: true })
  mkdirSync(join(fakeUser, '.dsh', 'profiles', 'web'), { recursive: true })

  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  }
  try {
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE_DIR
    process.env.USERPROFILE = fakeUser
    process.env.HOME = fakeUser

    const found = detectHome()
    check('$DSH_HOME 与 $DSH_PROFILE_DIR 都没有时，仍能找到 ~/.dsh',
      found === join(fakeUser, '.dsh'),
      `得到 ${JSON.stringify(found)}，期望 ${join(fakeUser, '.dsh')}`)

    // 反向：home 里没有 sessions/ 时不能瞎认（宁可返回 null 让调用方报错）
    const empty = mkdtempSync(join(tmpdir(), 'dsh-round2-empty-'))
    process.env.USERPROFILE = empty
    process.env.HOME = empty
    check('home 里没有 sessions/ 时返回 null（不猜）', detectHome() === null, String(detectHome()))
    rmSync(empty, { recursive: true, force: true })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(fakeUser, { recursive: true, force: true })
  }

  // 六处同胞实现必须口径一致（这次就是宿主这一处掉了队）
  const sibs = ['bin/worklog.mjs', 'bin/verify-loaded.mjs', 'bin/verify-compose.mjs', 'bin/install.mjs', 'bin/dev-setup.mjs']
  const missing = sibs.filter((f) => !/\.dsh/.test(readFileSync(join(root, f), 'utf8')))
  check('bin/ 下各脚本也都保留 ~/.dsh 兜底', missing.length === 0, `缺：${missing.join('、')}`)
}

// ================================================================ 2. 表格不断列
console.log('\n=== 2. 表格单元格里的 | 必须转义（markdown + HTML）===')
{
  // 2a 合成：命令 / 测试 / 文件名里都塞进管道
  const rec = synthRecord({
    turns: 2,
    commandsPerTurn: 3,
    command: (i) => `Get-ChildItem -Force | Select-Object Name | Format-Table -AutoSize  # ${i}`,
    testsPerTurn: 2,
    filesPerTurn: 2,
  })
  const md = renderReport(rec)
  check('带管道的命令在 markdown 里被转义成 \\|',
    md.includes('Select-Object Name \\| Format-Table'),
    (md.split('\n').find((l) => l.includes('Select-Object Name')) ?? '(没找到该行)').slice(0, 110))
  const badMd = mdTableBreaks(md)
  check('合成报告的每张表列数都一致', badMd.length === 0, JSON.stringify(badMd.slice(0, 3)))
  const badHtml = htmlTableBreaks(markdownToHtml(md))
  check('合成报告转成 HTML 后 <td> 数与 <th> 一致', badHtml.length === 0, JSON.stringify(badHtml.slice(0, 3)))

  // 2b 真数据全量扫描：这条才是真正能抓住回归的
  const { listSessions } = await import('../core/session-log.mjs')
  const sessions = listSessions(HOME).slice(0, 25)
  let mdBreaks = 0
  let htmlBreaks = 0
  let scanned = 0
  for (const s of sessions) {
    let built
    try { built = buildReport(HOME, s.sessionId, 0) } catch { continue }
    scanned++
    mdBreaks += mdTableBreaks(built.markdown).length
    htmlBreaks += htmlTableBreaks(markdownToHtml(built.markdown)).length
  }
  if (scanned === 0) {
    console.log('     （跳过一次真数据扫描：这台机器上没有可读会话）')
  } else {
    check(`真数据扫描 ${scanned} 个会话：markdown 无断列`, mdBreaks === 0, `断列 ${mdBreaks} 行`)
    check(`真数据扫描 ${scanned} 个会话：HTML 无 <td>/<th> 错配`, htmlBreaks === 0, `错配 ${htmlBreaks} 行`)
  }
}

// ================================================================ 3. 完成率一个口径
console.log('\n=== 3. 面板与 markdown/HTML 的「轮次完成率」必须是同一个数 ===')
{
  const routes = []
  const hostCtx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => fn(),
    get: (n) =>
      n === 'tools' ? { register: () => () => {} }
      : n === 'webServer' ? { register: (r) => (routes.push(r), () => {}) }
      : undefined,
    inject: (_d, cb) => cb(hostCtx),
  }
  apply(hostCtx)

  const res = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  await routes[0].handler({ url: '/plugins/dsh-agent-log/report?format=json' }, res)
  const data = JSON.parse(res.body)
  check('totals 里带上了唯一的算法出口 completionRate',
    'completionRate' in (data.totals ?? {}),
    `totals 键：${Object.keys(data.totals ?? {}).slice(-6).join(', ')}`)

  // 真组件 + 真 payload 渲染「总览」页签
  globalThis.fetch = () => new Promise(() => {})
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (m) => (loaded = m) } }
  const clientPath = join(root, 'client.js')
  await import(`file:///${clientPath.replace(/\\/g, '/')}`)

  const cells = []
  let cursor = 0
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: Symbol('Fragment'),
    useState: (init) => {
      const i = cursor++
      if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init
      return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v }]
    },
    useEffect: () => {},
  }
  const mod = loaded.factory((n) => {
    if (n === 'react') return fakeReact
    throw new Error('客户端不应 require: ' + n)
  })
  const reg = { slots: [], tabs: [] }
  mod.apply({
    effect: (fn) => fn(),
    slots: { inject: (o, cb) => cb(), register: (opts, comp) => (reg.slots.push({ opts, comp }), () => {}) },
    sidebarRightTabs: { register: (d) => (reg.tabs.push(d), () => {}) },
  })
  const Panel = reg.slots[0].comp

  /** 从渲染树里找「轮次」那一行的数值文本。 */
  function panelRateText(tree) {
    let out = null
    const walk = (n) => {
      if (!n || typeof n !== 'object' || out) return
      if (Array.isArray(n)) return n.forEach(walk)
      const cls = n.props?.className
      const kids = n.children ?? []
      if (cls === 'worklog-row') {
        const nameEl = kids.find((c) => c?.props?.className === 'worklog-name')
        const numEl = kids.find((c) => c?.props?.className === 'worklog-num')
        if (nameEl && numEl) {
          const label = (nameEl.children ?? []).flat(Infinity).filter((x) => typeof x === 'string').join('')
          if (label === '轮次') { out = (numEl.children ?? []).flat(Infinity).filter((x) => typeof x === 'string').join(''); return }
        }
      }
      kids.forEach(walk)
    }
    walk(tree)
    return out
  }

  /** markdown 里的完成率文本。 */
  const mdRateText = (md) => {
    const m = String(md).match(/\*\*成功率\*\*：工具调用 \S+ · 轮次完成 ([^（\s]+)/)
    return m ? m[1] : null
  }

  const { listSessions } = await import('../core/session-log.mjs')
  const sessions = listSessions(HOME).slice(0, 12)
  let compared = 0
  const mismatches = []
  for (const s of sessions) {
    let built
    try { built = buildReport(HOME, s.sessionId, 0) } catch { continue }
    const pRes = { status: null, body: null, writeHead(x) { this.status = x }, end(b) { this.body = b } }
    await routes[0].handler({ url: `/plugins/dsh-agent-log/report?format=json&sessionId=${s.sessionId}` }, pRes)
    const payload = JSON.parse(pRes.body)

    cells.length = 0
    cells[0] = { status: 'ready', data: payload, error: null }
    cells[1] = 'overview'
    cells[5] = []
    cells[6] = false
    cursor = 0
    const panel = panelRateText(Panel({ sessionId: s.sessionId }))
    const report = mdRateText(built.markdown)
    compared++
    if (panel !== report) mismatches.push({ sid: s.sessionId.slice(0, 16), panel, report })
  }
  if (compared === 0) {
    console.log('     （跳过一次真数据比对：这台机器上没有可读会话）')
  } else {
    check(`真数据比对 ${compared} 个会话：面板与报告的完成率完全一致`,
      mismatches.length === 0,
      JSON.stringify(mismatches.slice(0, 3)))
  }

  // 合成 payload 直接喂进面板：**不依赖机器上恰好有"未收尾轮次"的会话**。
  // 真实数据里 turns ≠ endedTurns 的比例不高（54 个里 4 个），只靠扫真数据这条断言会漏。
  {
    const rec = synthRecord({ turns: 4, unfinishedLast: true })
    cells.length = 0
    cells[0] = { status: 'ready', data: { totals: rec.totals, record: { turns: rec.turns } }, error: null }
    cells[1] = 'overview'
    cells[5] = []
    cells[6] = false
    cursor = 0
    const panel = panelRateText(Panel({ sessionId: 'session-synth' }))
    const report = mdRateText(renderReport(rec))
    check('合成 payload（4 轮里 1 轮进行中）：面板与报告仍是同一个数',
      panel === report && panel === `${rec.totals.completionRate}%`,
      `panel=${panel} report=${report} rate=${rec.totals.completionRate}%`)
  }

  // 合成场景：**有一轮没收尾**时，分母必须排除它（而不是一边 100%、一边 50%）
  {
    const rec = synthRecord({ turns: 3, unfinishedLast: true })
    const T = rec.totals
    check('合成：3 轮里 1 轮进行中时，turns=3 而 endedTurns=2',
      T.turns === 3 && T.endedTurns === 2,
      `turns=${T.turns} endedTurns=${T.endedTurns} completed=${T.completed}`)
    check('合成：completionRate 按已收尾轮次算（不是 2/3=67）',
      T.completionRate === Math.round((T.completed / T.endedTurns) * 100),
      `rate=${T.completionRate} completed=${T.completed} ended=${T.endedTurns}`)
    const md = renderReport(rec)
    check('合成：报告里的完成率与 completionRate 同值',
      md.includes(`轮次完成 ${T.completionRate}%`),
      (md.match(/\*\*成功率\*\*[^\n]*/) ?? ['(无)'])[0])
    check('合成：报告会说明分母排除了进行中的轮次',
      /另有 \d+ 轮进行中不计入/.test(md),
      (md.match(/另有[^\n]*/) ?? ['(无说明)'])[0])
  }
}

// ================================================================ 4. 逐轮明细封顶
console.log('\n=== 4. 「七、逐轮明细」必须受 DETAIL_LIMIT 约束并写明截断 ===')
{
  const rec = synthRecord({ turns: DETAIL_LIMIT + 40, commandsPerTurn: 1 })
  const md = renderReport(rec)
  const section = md.split('## 七、逐轮明细')[1]?.split('## 八、')[0] ?? ''
  const blocks = (section.match(/^### 轮次 /gm) ?? []).length
  check(`轮次块正好 ${DETAIL_LIMIT} 个（共 ${rec.totals.turns} 轮）`, blocks === DETAIL_LIMIT, `blocks=${blocks}`)
  check('截断时写明总条数与恢复办法',
    /明细过长/.test(section) && section.includes(`共 **${rec.totals.turns}**`),
    (section.match(/> ⚠️ 明细过长[^\n]*/) ?? ['(没有截断提示)'])[0])
  check('总览里的轮次数仍是全量', md.includes(`| 任务轮次 | ${rec.totals.turns} |`))

  const small = renderReport(synthRecord({ turns: 3 }))
  check('未超上限时不显示逐轮截断提示', !/明细过长/.test(small.split('## 七、')[1] ?? ''))
}

// ================================================================ 5. 周报截断要说明
console.log('\n=== 5. 日报/周报的截断必须写明（不能静默丢）===')
{
  const TOOLS = 37
  const FILES = 1248
  const bucket = {
    day: '2026-09-26',
    sessions: new Set(['s1', 's2']),
    sessionTitles: new Map([['s1', 't1']]),
    turns: [{ turn: 1, prompt: 'x', reason: { kind: 'completed' }, toolCalls: [], failures: [], commands: [], tests: [], filesRead: [], filesWritten: [], filesEdited: [], usage: {}, suspects: [] }],
    steps: 1, toolCalls: 10, failures: 0, suspects: 0, commands: 1, tests: 0,
    testsPassed: 0, testsFailed: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
    durationMs: 1, completed: 1, aborted: 0, interrupted: 0,
    toolHistogram: new Map(Array.from({ length: TOOLS }, (_, i) => [`tool${i}`, TOOLS - i])),
    filesRead: new Set(), filesWritten: new Set(Array.from({ length: FILES }, (_, i) => `C:\\w\\f${i}.js`)), filesEdited: new Set(),
  }
  const agg = { days: [bucket], sessions: [] }
  const md = renderPeriod(agg, { label: '测试周报', since: 0, until: Date.now() })
  const toolNote = md.match(/> ⚠️ 明细过长，此处只列 前 \*\*20\*\* 条（共 \*\*37\*\* 条）。/)
  check('工具表截断到 20 时写明共 37 个', !!toolNote, (md.match(/> ⚠️ 明细过长[^\n]*/) ?? ['(无)'])[0])
  const fileNote = md.match(/> ⚠️ 明细过长，此处只列 前 \*\*60\*\* 条（共 \*\*1248\*\* 条）。/)
  check('产出文件截断到 60 时写明共 1248 个', !!fileNote, (md.match(/共 \*\*1248\*\*/) ?? ['(无)'])[0])
  const lines = md.split('\n').filter((l) => l.startsWith('- `C:\\w\\f'))
  check('产出文件确实只渲染了 60 行', lines.length === 60, `lines=${lines.length}`)
}

// ================================================================ 6. 行数断言不受别的表影响
console.log('\n=== 6. 「命令明细行数」不能被「测试表」的行数带偏 ===')
{
  // 这正是 regression-fixes 那次时红时绿的根因：两个表的行形状一模一样。
  const seedCmd = { at: T0, turn: 1, ok: true, durationMs: 5, command: 'echo x' }
  const base = synthRecord({ turns: 1, commandsPerTurn: 1 })
  for (const nTests of [0, 1, 3, 5]) {
    const T = JSON.parse(JSON.stringify(base))
    T.totals.allCommands = Array.from({ length: 500 }, (_, i) => ({ ...seedCmd, command: `echo ${i}` }))
    T.totals.allTests = Array.from({ length: nTests }, (_, i) => ({ ...seedCmd, kind: 'script', passed: true, command: `node test/x${i}.mjs` }))
    const md = renderReport(T)
    const section = md.split('## 三、运行了哪些命令')[1]?.split('## 四、')[0] ?? ''
    const rows = (section.match(/^\| \d+ \| \d{2}:\d{2}:\d{2} \|/gm) ?? []).length
    check(`样本含 ${nTests} 条测试时，命令段仍是 ${DETAIL_LIMIT} 行`, rows === DETAIL_LIMIT, `rows=${rows}`)
  }
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
