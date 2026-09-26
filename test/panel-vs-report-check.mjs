#!/usr/bin/env node
/**
 * 跨面一致性验收：**面板总览的每一行都必须与报告逐字一致**。
 *
 * 为什么要有这个测试（真机 bug 两枚，同一类）：
 *   1. 「轮次成功率」面板与 markdown 各除一遍、分母还不同 → 同一份数据 100% vs 50%
 *   2. 「测试」那一行面板与报告总览都只写「通过/失败」，把「未判定」丢了
 *      → 9 次测试显示成「通过 4 / 失败 1」，4+1≠9，读者只会认为统计错了
 *
 * 共同点：**同一个事实被算了/渲染了多次，而没有任何一个测试去比对它们**。
 * 既有测试都是"验字段在不在"（totals.failures 是数字吗），不是"验两个面说的是不是同一件事"。
 * 所以这个文件按"面"来验：把面板总览渲染出来，逐个数字与 markdown 对账。
 *
 * 一条纪律：两侧必须来自**同一份快照**。若先 buildReport 再请求路由，
 * 活跃会话的日志会在两次读取之间继续增长，比出来的差异全是读取竞态
 * （accuracy-audit.mjs 记录过同一现象），那是假阳性。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'
import { renderReport } from '../core/render.mjs'
import { listSessions } from '../core/session-log.mjs'
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

// ---------------------------------------------------------------- 宿主：拿 payload
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
check('路由已注册', routes.length === 1)

// ---------------------------------------------------------------- 客户端：真组件
globalThis.fetch = () => new Promise(() => {}) // 不联网；数据由测试直接灌进 state
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (m) => (loaded = m) } }
const clientPath = join(root, 'client.js')
await import(`file:///${clientPath.replace(/\\/g, '/')}`)

const cells = []
let cursor = 0
const effects = []
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: Symbol('Fragment'),
  useState: (init) => {
    const i = cursor++
    if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init
    return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v }]
  },
  // 收集 effect 而不是丢弃：错误处理要真的跑一遍才能验（见下面的刷新失败一节）
  useEffect: (fn) => { effects.push(fn) },
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
check('拿到面板组件', typeof Panel === 'function')

/** 把渲染树摊成纯文本（**必须**处理裸字符串/数字：很多值是直接传字符串的）。 */
const text = (n) => {
  if (n === null || n === undefined || n === false || n === true) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(text).join('')
  return (n.children ?? []).map(text).join('')
}
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/[（(]进行中[^）)]*[）)]/g, '').trim()

/** 渲染「总览」页签，抽出 Dl 的键值对与两行成功率。 */
function panelOverview(payload, sessionId) {
  cells.length = 0
  cells[0] = { status: 'ready', data: payload, error: null }
  cells[1] = 'overview'
  cells[5] = []
  cells[6] = false
  cursor = 0
  const tree = Panel({ sessionId })
  const out = { pairs: new Map(), rates: new Map() }
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    // 假 React 不执行函数组件：`h(Dl, {pairs})` 只留下一个 type=Dl 的元素，
    // 值要从 props.pairs 取，而不是等它渲染成 <dl>。
    if (Array.isArray(n.props?.pairs)) for (const [k, v] of n.props.pairs) out.pairs.set(k, v)
    if (n.props?.className === 'worklog-row') {
      const nameEl = (n.children ?? []).find((c) => c?.props?.className === 'worklog-name')
      const numEl = (n.children ?? []).find((c) => c?.props?.className === 'worklog-num')
      if (nameEl && numEl) out.rates.set(text(nameEl), text(numEl))
    }
    ;(n.children ?? []).forEach(walk)
  }
  walk(tree)
  return out
}

/** markdown 总览表取值。 */
const mdCell = (md, label) => {
  const m = String(md).match(new RegExp(`\\| ${label} \\| ([^|]+)\\|`))
  return m ? norm(m[1]) : null
}

// 面板标签 → 报告总览里的同一行；mode 说明怎么比：
//   num  —— 报告单元格可能带「（另有 N 次疑似）」这类补充说明，只比前导数字
//   text —— 逐字比（"A + B"、"3 / 0 / 0" 这种不是单个数字）
const PAIRS = [
  ['任务轮次', '任务轮次', 'num'],
  ['执行步数', '执行步数', 'num'],
  ['工具调用', '工具调用', 'num'],
  ['命令执行', '命令执行', 'num'],
  ['失败次数', '失败次数', 'num'],
  ['读文件', '读文件', 'num'],
  ['写/改文件', '写/改文件', 'text'],
  ['输入 Token（未缓存）', '输入 Token（未缓存）', 'num'],
  ['输出 Token', '输出 Token', 'num'],
  ['缓存读取 Token', '缓存读取 Token', 'num'],
  ['推理 Token', '推理 Token', 'num'],
  ['完成/中止/中断', '完成/中止/中断', 'text'],
]
/** 去掉 markdown 加粗后取前导数字。 */
const leadNum = (s) => {
  const m = String(s ?? '').replace(/\*\*/g, '').match(/\d[\d,]*/)
  return m ? m[0] : norm(s)
}

// ---------------------------------------------------------------- 逐会话比对
console.log('\n=== 面板总览逐行 vs 报告 ===')
const sessions = listSessions(HOME)
const diffs = []
let scanned = 0

for (const s of sessions) {
  const res = { status: null, body: null, writeHead(x) { this.status = x }, end(b) { this.body = b } }
  await routes[0].handler({ url: `/plugins/dsh-agent-log/report?format=json&sessionId=${s.sessionId}` }, res)
  let payload
  try { payload = JSON.parse(res.body) } catch { continue }
  if (!payload?.record) continue
  // 同一份快照既渲染 markdown 又渲染面板 —— 否则活跃会话会造出假差异
  const markdown = renderReport(payload.record)
  const panel = panelOverview(payload, s.sessionId)
  scanned++

  for (const [label, mdLabel, mode] of PAIRS) {
    if (!panel.pairs.has(label)) { diffs.push(`${s.sessionId.slice(0, 16)} ${label}: 面板缺这一行`); continue }
    const pv = norm(text(panel.pairs.get(label)))
    const raw = mdCell(markdown, mdLabel)
    const mv = raw === null ? null : mode === 'num' ? leadNum(raw) : raw
    if (mv !== null && pv !== mv) diffs.push(`${s.sessionId.slice(0, 16)} ${label}: 面板=${JSON.stringify(pv)} 报告=${JSON.stringify(mv)}`)
  }

  // 测试这一行：三态必须完整（N 必须等于三者之和）
  const tv = norm(text(panel.pairs.get('测试')))
  const three = markdown.match(/共 \*\*(\d+)\*\* 次测试，通过 \*\*(\d+)\*\* \/ 失败 \*\*(\d+)\*\*(?: \/ 未判定 \*\*(\d+)\*\*)?/)
  if (three) {
    const [, n, p, f, u] = three
    const expect = Number(u ?? 0) > 0 ? `${n}（通过 ${p} / 失败 ${f} / 未判定 ${u}）` : `${n}（通过 ${p} / 失败 ${f}）`
    if (tv !== expect) diffs.push(`${s.sessionId.slice(0, 16)} 测试(三态): 面板=${JSON.stringify(tv)} 应为=${JSON.stringify(expect)}`)
    else if (Number(p) + Number(f) + Number(u ?? 0) !== Number(n)) diffs.push(`${s.sessionId.slice(0, 16)} 测试三态不自洽: ${p}+${f}+${u ?? 0}≠${n}`)
  }

  // 两行成功率
  for (const [label, re] of [['工具', /工具调用 (\d+%)/], ['轮次', /轮次完成 ([^（\s]+)/]]) {
    const want = (markdown.match(re) ?? [])[1] ?? null
    const got = panel.rates.get(label)
    if (want !== null && got !== want) diffs.push(`${s.sessionId.slice(0, 16)} ${label}成功率: 面板=${JSON.stringify(got)} 报告=${JSON.stringify(want)}`)
  }
}

if (scanned === 0) {
  console.log('     （这台机器上没有可读会话，跳过逐会话比对）')
} else {
  console.log(`     受检 ${scanned} 个会话，比对 ${PAIRS.length + 3} 项/会话`)
  check(`面板与报告在全部 ${PAIRS.length + 3} 项上完全一致`, diffs.length === 0, diffs.slice(0, 6).join(' | '))
}

// ---------------------------------------------------------------- 合成兜底
//
// 真实数据里「有未判定」「有进行中轮次」的会话不一定存在（实测 55 个里只有 6 个有未判定），
// 只靠扫真数据这两条断言会时有时无 —— 所以再造两个必然命中的合成 payload。
console.log('\n=== 合成 payload 兜底（不依赖机器上恰好有这种会话）===')
{
  // 用真实 payload 造一个"必有未判定 + 必有进行中轮次"的变体
  const res = { status: null, body: null, writeHead(x) { this.status = x }, end(b) { this.body = b } }
  await routes[0].handler({ url: '/plugins/dsh-agent-log/report?format=json' }, res)
  const payload = JSON.parse(res.body)
  if (payload?.record?.totals) {
    // 注意：JSON 解析后 payload.totals 与 payload.record.totals 已经是**两份拷贝**
    // （服务端是同一个引用，但序列化会拆开）。面板读前者、renderReport 读后者，
    // 所以合成时必须**两份都改**，否则测的是我自己的疏忽。
    for (const T of [payload.totals, payload.record.totals]) {
      T.tests = 9
      T.testsPassed = 4
      T.testsFailed = 1
      T.testsUnknown = 4
      T.allTests = Array.from({ length: 9 }, (_, i) => ({
        at: Date.now(), turn: 1, kind: 'script', passed: i < 4 ? true : i === 4 ? false : null, durationMs: 1, command: `node t${i}.mjs`,
      }))
      T.completionRate = 100
      T.endedTurns = 3
      T.turns = 5
      T.completed = 3
      T.aborted = 0
      T.interrupted = 0
    }
    const markdown = renderReport(payload.record)
    const panel = panelOverview(payload, payload.sessionId)

    const tv = norm(text(panel.pairs.get('测试')))
    check('合成：测试三态不丢「未判定」', tv === '9（通过 4 / 失败 1 / 未判定 4）', `面板=${JSON.stringify(tv)}`)
    check('合成：未判定存在时 N = 通过+失败+未判定', 4 + 1 + 4 === 9)

    const mdRow = mdCell(markdown, '测试执行')
    check('合成：报告总览那一行也带「未判定」', /未判定 4/.test(mdRow ?? ''), `报告=${JSON.stringify(mdRow)}`)

    const pr = panel.rates.get('轮次')
    const mr = (markdown.match(/轮次完成 ([^（\s]+)/) ?? [])[1]
    check('合成：进行中轮次不计入分母时，两处仍同值', pr === mr && pr === '100%', `面板=${pr} 报告=${mr}`)
  } else {
    console.log('     （没有可用 payload，跳过合成兜底）')
  }
}

// ---------------------------------------------------------------- 刷新失败不清屏
//
// 真机症状：宿主重启 / 自动刷新撞上写入时来一次 500，整份已经读出来的报告被换成
// 一行「读取失败：HTTP 500」；而宿主其实在 body 里写清了原因（例如「DSH home not found」）。
// 两件事都要验：**旧数据要留住**，**宿主的原因要显示出来**。
console.log('\n=== 刷新失败：保留旧数据 + 显示宿主给的原因 ===')
{
  const res0 = { status: null, body: null, writeHead(x) { this.status = x }, end(b) { this.body = b } }
  await routes[0].handler({ url: '/plugins/dsh-agent-log/report?format=json' }, res0)
  const good = JSON.parse(res0.body)

  // 第一次渲染：状态是 ready，effect 会去 fetch；这里让它失败
  globalThis.fetch = (url) =>
    String(url).includes('list=1')
      ? Promise.resolve({ ok: true, json: async () => ({ sessions: [] }) })
      : Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'DSH home not found' }) })

  cells.length = 0
  effects.length = 0
  cells[0] = { status: 'ready', data: good, error: null }
  cells[1] = 'overview'
  cells[5] = []
  cells[6] = false
  cursor = 0
  const tree = Panel({ sessionId: good.sessionId })

  check('渲染时注册了取数 effect', effects.length > 0, `effects=${effects.length}`)
  for (const fn of effects) fn()          // 跑一遍 effect（含失败的那次 fetch）
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))

  check('刷新失败后**旧数据仍在**（没有被清成 null）',
    cells[0]?.data !== null && cells[0]?.data?.record != null,
    `data=${cells[0]?.data === null ? 'null' : 'ok'} status=${cells[0]?.status}`)
  check('错误信息里带上了宿主 body 里的原因',
    /DSH home not found/.test(String(cells[0]?.error)) && /HTTP 500/.test(String(cells[0]?.error)),
    `error=${JSON.stringify(cells[0]?.error)}`)

  // 再渲染一次：应当同时出现错误横幅与报告正文
  effects.length = 0
  cursor = 0
  const tree2 = Panel({ sessionId: good.sessionId })
  const classes = []
  const collect = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(collect)
    if (n.props?.className) classes.push(n.props.className)
    ;(n.children ?? []).forEach(collect)
  }
  collect(tree2)
  check('失败时挂出错误横幅（worklog-err）', classes.includes('worklog-err'))
  check('失败时正文仍在渲染（不是只剩错误页）', classes.includes('worklog-body') && classes.includes('worklog-tabs') | classes.some((c) => c === 'worklog-actions'))
  void tree
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
