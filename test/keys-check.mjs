#!/usr/bin/env node
/**
 * 面板渲染树自检：**兄弟节点的 key 必须唯一**。
 *
 * 为什么需要这个测试（真机 bug）：
 *   `Fails()` 里标题写的是 `key: 'h1'`，失败条目写的是 `key: \`h${i}\`` ——
 *   第 2 条失败正好也叫 'h1'，疑似标题 'h2' 又和第 3 条撞车。
 *   React 按 key 复用节点，撞车会留下**陈旧节点**，表现为：
 *   切到「总览」后，正文上方凭空多出两行「失败 8 · 疑似 2」，而且怎么刷新都在。
 *
 * 这个测试用真组件 + 真 payload 把 7 个页签都渲染一遍，逐个元素检查
 * 「数组子节点里的 key 是否唯一」，并把没 key 的列表子节点也报出来。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
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

// ---------------------------------------------------------------- 真 payload
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

async function payloadFor(sessionId) {
  const res = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  await routes[0].handler({ url: `/plugins/dsh-agent-log/report?format=json&sessionId=${sessionId}` }, res)
  return JSON.parse(res.body)
}

const listRes = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
await routes[0].handler({ url: '/plugins/dsh-agent-log/report?list=1' }, listRes)
const sessions = JSON.parse(listRes.body).sessions ?? []
// 优先挑「有失败且有疑似」的会话：最容易触发 key 撞车的那条路径
let data = null
let used = null
for (const s of sessions.slice(0, 12)) {
  const p = await payloadFor(s.sessionId)
  const t = p.totals ?? {}
  if (t.failures > 2 || t.suspects > 2) { data = p; used = s.sessionId; break }
}
if (!data) { data = await payloadFor(sessions[0].sessionId); used = sessions[0].sessionId }
console.log(`被试会话 ${used}`)
console.log(`  失败 ${data.totals.failures} · 疑似 ${data.totals.suspects} · 命令 ${data.totals.commands} · 文件 ${data.totals.uniqueFilesTouched}`)

// ---------------------------------------------------------------- 最小 React 替身（可切页签）
globalThis.fetch = () => new Promise(() => {}) // 不真的联网；数据由 driver 直接灌进 state
globalThis.window = { __ModuleLoader__: { load: (m) => (loaded = m) } }
let loaded = null
const clientPath = join(root, 'client.js')
await import(`file:///${clientPath.replace(/\\/g, '/')}`)

const cells = []
let cursor = 0
let dirty = false
const effects = []
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: Symbol('Fragment'),
  useState: (init) => {
    const i = cursor++
    if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init
    return [cells[i], (v) => { cells[i] = typeof v === 'function' ? v(cells[i]) : v; dirty = true }]
  },
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

// REACT 的 state 索引：0=state 1=tab 2=fileTab 3=nonce 4=pick 5=sessions 6=auto 7=dl
cells[0] = { status: 'ready', data, error: null }
cells[5] = sessions
cells[6] = false

function render(tab) {
  if (tab) cells[1] = tab
  cursor = 0
  effects.length = 0
  return Panel({ sessionId: used })
}

// ---------------------------------------------------------------- 遍历检查
const TABS = ['overview', 'tools', 'commands', 'files', 'tests', 'fails', 'turns']
let keyCount = 0
let dupCount = 0
let unkeyedLists = 0

function walk(node, path) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const c of node) walk(c, path)
    return
  }
  const kids = (node.children ?? []).filter((c) => c !== null && c !== undefined && c !== false)
  const elems = kids.filter((c) => typeof c === 'object')
  const seen = new Map()
  for (const c of elems) {
    const k = c?.props?.key
    if (k === undefined || k === null) continue
    keyCount++
    const key = String(k)
    if (seen.has(key)) {
      dupCount++
      console.log(`      ⚠️ 兄弟 key 重复: "${key}" @ ${path} <${String(node.type?.name ?? node.type)} class=${node.props?.className ?? '-'}>`)
    } else {
      seen.set(key, true)
    }
  }
  // 列表（>=2 个子元素）里混着没 key 的，React 会告警；这里只统计，不判失败
  if (elems.length >= 2 && elems.some((c) => c?.props?.key === undefined)) unkeyedLists++
  for (const c of elems) {
    walk(c, `${path}/${String(node.type?.name ?? node.type)}${node.props?.className ? '.' + node.props.className : ''}`)
  }
}

console.log('\n=== 7 个页签逐个渲染并检查 key 唯一性 ===')
for (const tab of TABS) {
  const before = dupCount
  const tree = render(tab)
  walk(tree, tab)
  check(`「${tab}」页签：兄弟 key 无重复`, dupCount === before, `新增重复 ${dupCount - before} 处`)
}

console.log(`\n共检查 ${keyCount} 个带 key 的兄弟节点；重复 ${dupCount} 处；含未加 key 的多子元素组 ${unkeyedLists} 处`)
check('整体没有重复 key', dupCount === 0)
check('每个页签都渲染出了元素树', keyCount > 200, `keyCount=${keyCount}`)

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
