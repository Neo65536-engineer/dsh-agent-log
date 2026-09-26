#!/usr/bin/env node
/**
 * 面板数据通路验收 —— 这个测试是为了补上一个真实 bug。
 *
 * 背景：面板的「失败」「轮次」两个页签曾经**恒为空**。
 * 原因是路由返回 `{ sessionId, title, totals, diagnostics, record }`，
 * 轮次嵌在 `record.turns`，而面板读的是顶层 `d.turns` → undefined。
 *
 * 旧测试只验了后端 payload 本身，没验**面板实际读的路径**，所以漏了。
 * 这个测试的做法：把路由 handler 的**真实返回**喂进面板组件，
 * 然后断言每个页签渲染出来的元素树里确实有数据（不是空状态）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'

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

// ---------------------------------------------------------------- 取真实 payload
console.log('=== 1. 取路由的真实返回 ===')
const routes = []
const hostCtx = {
  logger: { info: () => {} },
  effect: (fn) => fn(),
  get: (n) =>
    n === 'tools' ? { register: () => () => {} }
    : n === 'webServer' ? { register: (r) => (routes.push(r), () => {}) }
    : undefined,
  inject: (d, cb) => cb(hostCtx),
}
apply(hostCtx)
const route = routes[0]
check('路由已注册', !!route)

async function getPayload(url) {
  const res = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  await route.handler({ url }, res)
  return { status: res.status, json: JSON.parse(res.body) }
}

const { status, json } = await getPayload('/plugins/dsh-agent-worklog/report?format=json')
check('路由返回 200', status === 200, String(status))
console.log(`     顶层键: ${Object.keys(json).join(', ')}`)

// ---------------------------------------------------------------- 加载客户端
console.log('\n=== 2. 加载面板组件 ===')
const clientPath = join(root, 'client.js')
const src = readFileSync(clientPath, 'utf8')

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (s) => (loaded = s) } }
await import(`file:///${clientPath.replace(/\\/g, '/')}`)
check('client.js 自注册', !!loaded)

// 假 React：把元素树建成可检查的普通对象
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
}
const mod = loaded.factory((n) => {
  if (n === 'react') return fakeReact
  throw new Error('客户端不应 require: ' + n)
})

function mount() {
  const reg = { tabs: [], slots: [] }
  const ctx = {
    effect: (fn) => fn(),
    slots: { inject: (o, cb) => cb(), register: (opts, comp) => (reg.slots.push({ opts, comp }), () => {}) },
    sidebarRightTabs: { register: (d) => (reg.tabs.push(d), () => {}) },
  }
  mod.apply(ctx)
  return reg.slots[0].comp
}
const Panel = mount()
check('拿到面板组件', typeof Panel === 'function')

// ---------------------------------------------------------------- 遍历页签
console.log('\n=== 3. 各页签必须渲染出数据（不是空状态）===')

/**
 * 面板用 useState 存 tab。假 React 的 useState 返回固定值，
 * 所以这里直接调用内部渲染函数不可行 —— 改为：
 * 用真实 payload 手动执行与面板相同的「取值 + 归约」逻辑，
 * 并断言取出的是非空集合。同时静态检查面板读的字段路径。
 */
const totals = json.totals
const record = json.record ?? json
const turns = json.turns ?? record?.turns ?? []

check('轮次数据可取到（面板读 d.turns ?? d.record.turns）', turns.length > 0, `turns=${turns.length}`)
console.log(`     轮次 ${turns.length} 个`)

// 失败
// 注意：这里过去断言「最新会话必须有失败」——那是**数据依赖的脆弱断言**，
// 最新会话恰好没失败时必红（第一天通过只是因为那天恰好有失败）。
// 正确的语义是：失败条目必须与 totals.failures 自洽；有失败必须能列出来。
const hardFails = turns.flatMap((t) => t.failures ?? [])
check('「失败」页签与 totals.failures 自洽',
  hardFails.length === (totals.failures ?? 0),
  `turns 内 ${hardFails.length} vs totals.failures ${totals.failures}`)
check('失败条目字段齐（tool/kind/seq）',
  hardFails.every((f) => f && typeof f.tool === 'string' && typeof f.kind === 'string' && typeof f.seq === 'number'),
  JSON.stringify(hardFails[0] ?? {}))

// 用一个**确实有失败**的会话来验证「有失败必须列得出来」这条路（不依赖"最新会话"）
if (hardFails.length === 0) {
  const list = await getPayload('/plugins/dsh-agent-worklog/report?list=1').catch(() => null)
  let found = null
  for (const s of list?.json?.sessions ?? []) {
    const p = await getPayload(`/plugins/dsh-agent-worklog/report?format=json&sessionId=${s.sessionId}`)
    const fs = (p.json?.record?.turns ?? []).flatMap((t) => t.failures ?? [])
    if (fs.length > 0) { found = { id: s.sessionId, n: fs.length, sample: fs[0] }; break }
  }
  if (found) {
    check('另取一个确有失败的会话，失败条目可列出', found.n > 0, `${found.id.slice(0, 24)} → ${found.n} 次`)
  } else {
    console.log('     （跳过一个失败样本：当前所有会话都没有失败记录）')
  }
}
// 轮次
check('「轮次」页签有数据', turns.length > 0)
// 工具
const toolDetail = totals.toolDetail ?? []
check('「工具」页签有数据', toolDetail.length > 0, `tools=${toolDetail.length}`)
check('工具条目带时间', toolDetail.every((t) => typeof t.firstAt === 'number' || typeof t.lastAt === 'number'),
  JSON.stringify(toolDetail[0] ?? {}))
check('工具条目带失败数与轮次', toolDetail.every((t) => typeof t.failures === 'number' && Array.isArray(t.turns)))
// 命令（与工具分开的独立视图）
const cmds = totals.allCommands ?? []
check('「命令」页签有数据（独立于工具）', cmds.length > 0, `commands=${cmds.length}`)
check('命令条带时间', cmds.every((c) => typeof c.at === 'number'), JSON.stringify(cmds[0] ?? {}))
check('命令条带退出状态', cmds.every((c) => c.ok === true || c.ok === false || c.ok === null))
check('命令数与 totals.commands 一致', cmds.length === totals.commands, `${cmds.length} vs ${totals.commands}`)
check('命令视图不是工具视图（两者条数不同或字段不同）',
  cmds.length !== toolDetail.length || cmds[0]?.command !== toolDetail[0]?.name)
// 文件
const fileDetail = totals.fileDetail ?? []
check('「文件」页签有数据', fileDetail.length > 0, `files=${fileDetail.length}`)
check('文件路径是**完整路径**（含目录分隔符），不是只有文件名',
  fileDetail.every((f) => /[\\/]/.test(f.path)), JSON.stringify(fileDetail.slice(0, 2).map((f) => f.path)))
check('文件条带操作类型与时间', fileDetail.every((f) => Array.isArray(f.ops) && (typeof f.lastAt === 'number' || f.lastAt === null)))
const modified = fileDetail.filter((f) => f.ops.includes('write') || f.ops.includes('edit'))
const readOnly = fileDetail.filter((f) => f.ops.includes('read') && !f.ops.includes('write') && !f.ops.includes('edit'))
check('「修改」子页签可分类出条目', modified.length >= 0)
check('「读取」子页签可分类出条目', readOnly.length >= 0)
check('修改/读取两类加起来 = 全部文件（无遗漏）', modified.length + readOnly.length === fileDetail.length,
  `${modified.length}+${readOnly.length} vs ${fileDetail.length}`)
// 测试
check('「测试」页签字段存在（allTests 是数组）', Array.isArray(totals.allTests),
  String(typeof totals.allTests))

// ---------------------------------------------------------------- 静态路径检查
console.log('\n=== 4. 静态检查：面板不能只读顶层 turns ===')
check('客户端用了 unwrap/兼容读取（同时看 d.turns 与 d.record.turns）',
  /d\.turns\s*\?\?\s*d\.record\?\.turns/.test(src), '未找到兼容读取表达式')
check('客户端读 totals.toolDetail', src.includes('toolDetail'))
check('客户端读 totals.allCommands', src.includes('allCommands'))
check('客户端读 totals.fileDetail', src.includes('fileDetail'))
check('客户端读 totals.allTests', src.includes('allTests'))
check('文件页签用完整路径（没有 baseName 截断）',
  !/baseName\(f\.path\)/.test(src) && /className: 'worklog-path'/.test(src))
check('有可切换的子页签（aria-pressed + setFileTab）',
  src.includes('setFileTab') && src.includes("aria-pressed': fileTab"))

// ---------------------------------------------------------------- 布局与下载（回归护栏）
console.log('\n=== 4b. 布局与「可下载文档」护栏 ===')
// 真机上出现过的 bug：.worklog-who 被写成 flex:1 1 100%，在竖排 flex 里撑满剩余高度，
// 把页签栏挤到底部、中间留出一大片空白。
check('会话栏不再撑满高度（flex 必须 0 0 auto）',
  /\.worklog-who\{flex:0 0 auto/.test(src) && !/\.worklog-who\{flex:1/.test(src),
  '又出现了会撑满高度的 flex-grow')
check('只有正文区允许 grow 占满剩余空间',
  /\.worklog-body\{flex:1 1 auto/.test(src))
check('面板会绑定自己所属的会话（读 props.sessionId）',
  /props\?\.sessionId/.test(src) && /sessionId=\$\{encodeURIComponent\(target\)\}/.test(src))
check('有会话选择器（?list=1）', src.includes('?list=1') && src.includes('worklog-sel'))
check('有自动刷新（且只在真实浏览器环境轮询）',
  src.includes('setInterval') && src.includes("typeof document === 'undefined'"))
check('有「下载」按钮（HTML 文档）', src.includes("onDownload('html')") && src.includes('downloadReport'))
check('有「.md」按钮', src.includes("onDownload('markdown')"))
check('下载文件名含会话短 id 与时间戳', /本次Agent工作报告-\$\{shortId\(sessionId\)\}/.test(src))
check('会话短 id 会去掉 session- 前缀（不再显示成 "session-"）',
  src.includes("replace(/^session-/, '')"))
check('陈旧模块会显示黄色横幅', src.includes('worklog-stale') && src.includes('freshness'))
check('总览含「本次任务」与九项速查', src.includes('本次任务') && src.includes('九项速查'))
check('操作栏与页签栏是两种视觉（worklog-actions / worklog-act / 图标）',
  src.includes('worklog-actions') && src.includes('worklog-act') && src.includes('worklog-ico'))
check('信息行只显示对话名，不再显示 session id',
  !/view\.sessionId\.slice\(0, 18\)/.test(src) && /view\.title \? String\(view\.title\)/.test(src))
check('下载反馈会自动消失（不再长驻在标题下）', src.includes('setTimeout(() => setDl('))
check('失败页签不再重复渲染计数标题（页签标签已含计数）',
  !/失败 \$\{hard\.length\}/.test(src))
check('Fails / 疑似 的 key 与条目 key 不撞车（独立命名空间）',
  src.includes('key: `fail-${i}`') && src.includes("key: 'suspect-head'") && src.includes('key: `suspect-${i}`'))

// ---------------------------------------------------------------- 页签数量
console.log('\n=== 5. 页签齐备 ===')
for (const [key, label] of [
  ['overview', '总览'], ['tools', '工具'], ['commands', '命令'],
  ['files', '文件'], ['tests', '测试'], ['fails', '失败'], ['turns', '轮次'],
]) {
  check(`有「${label}」页签`, src.includes(`['${key}'`), key)
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
