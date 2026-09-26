#!/usr/bin/env node
/**
 * 客户端（浏览器侧）插件的离线验收。
 *
 * 无法在 Node 里真正渲染 React，但可以验证所有"装机前能确定"的部分：
 *   1. ModuleLoader 自注册契约（id 必须等于包名，factory 返回 {inject, apply}）
 *   2. 只 require 'react'，不碰任何 @deepseek-ai/* 客户端包（否则插槽会崩）
 *   3. tab 类型定义合法（id/kind/title 齐备，id 与注册 key 一致）
 *   4. slots.register 的目标与 key 正确
 *   5. 样式只用主题 token，无字面色值
 *   6. package.json 的 dsh.client 段与 exports 正确
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

// ---------------------------------------------------------------- 1. 拦截 ModuleLoader
let loaded = null
const required = []
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}

// 用一个假的 React 替身，确认组件树能被构造而不抛错
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
}

const clientPath = join(root, 'client.js')
const src = readFileSync(clientPath, 'utf8')

console.log('=== 1. ModuleLoader 自注册契约 ===')
// 用动态 import 真的执行一遍 client.js
await import(`file:///${clientPath.replace(/\\/g, '/')}`)
check('调用了 window.__ModuleLoader__.load', loaded !== null)
check('id 等于包名', loaded?.id === 'dsh-agent-log', String(loaded?.id))
check('提供了 factory', typeof loaded?.factory === 'function')

const mod = loaded.factory((name) => {
  required.push(name)
  if (name === 'react') return fakeReact
  throw new Error(`客户端刻意不应 require "${name}"`)
})
check('factory 返回 inject 数组', Array.isArray(mod?.inject))
check('factory 返回 apply 函数', typeof mod?.apply === 'function')
check('只 require 了 react', required.length === 1 && required[0] === 'react', required.join(','))
check(
  '源码不含 @deepseek-ai 客户端包 require',
  !/require\(\s*['"]@deepseek-ai\//.test(src),
)

// ---------------------------------------------------------------- 2. 模拟 apply
console.log('\n=== 2. 模拟挂载（拦截 ctx） ===')
const registered = { tabTypes: [], slots: [], effects: [] }
const fakeCtx = {
  effect(fn, label) {
    registered.effects.push(label ?? '(no label)')
    const dispose = fn()
    return dispose
  },
  slots: {
    inject(owner, cb) {
      registered.slots.push({ owner })
      return cb()
    },
    register(options, component) {
      registered.slots.push({ register: options, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(def) {
      registered.tabTypes.push(def)
      return () => {}
    },
  },
}

let applyErr = null
try {
  mod.apply(fakeCtx)
} catch (e) {
  applyErr = e
}
check('apply 未抛错', applyErr === null, String(applyErr?.message))

const tabType = registered.tabTypes[0]
check('注册了 1 个 tab 类型', registered.tabTypes.length === 1, String(registered.tabTypes.length))
check('tab 类型有 id', tabType?.id === 'dsh-agent-log', String(tabType?.id))
check('tab 类型有 kind', typeof tabType?.kind === 'string' && tabType.kind.length > 0, String(tabType?.kind))
check('title 是 thunk（函数）', typeof tabType?.title === 'function')
check('title() 返回非空字符串', typeof tabType?.title?.() === 'string' && tabType.title().length > 0)
check('guide 有 1 个入口', Array.isArray(tabType?.guide) && tabType.guide.length === 1)
check('guide 入口有 id（registry 按 id 查重，渲染当 key）',
  typeof tabType?.guide?.[0]?.id === 'string' && tabType.guide[0].id.length > 0,
  String(tabType?.guide?.[0]?.id))
check('guide 入口 id 在本次注册内唯一（运行时按此查重）',
  new Set((tabType?.guide ?? []).map((e) => e.id)).size === (tabType?.guide ?? []).length,
  JSON.stringify((tabType?.guide ?? []).map((e) => e.id)))
check('guide 入口 order 是数字', typeof tabType?.guide?.[0]?.order === 'number')
check('guide 入口 title 是 thunk', typeof tabType?.guide?.[0]?.title === 'function')
check(
  '页类型未声明 patterns（按 kind 打开）',
  tabType?.patterns === undefined,
)

const bodyReg = registered.slots.find((s) => s.register)
check('注册了正文插槽', !!bodyReg)
check(
  '正文插槽名正确',
  bodyReg?.register?.name === 'sidebar.right.pane.tab',
  String(bodyReg?.register?.name),
)
check(
  '正文注册 key 等于 tab 类型 id',
  bodyReg?.register?.key === tabType?.id,
  `${bodyReg?.register?.key} vs ${tabType?.id}`,
)
check('正文是组件（函数）', typeof bodyReg?.component === 'function')
check(
  '用了 slots.inject 包裹 owner key',
  registered.slots.some((s) => s.owner === 'sidebar.right.pane.tab'),
)

// ---------------------------------------------------------------- 3. 渲染出结构
console.log('\n=== 3. 组件能构造出元素树（假 React） ===')
let renderErr = null
let tree = null
try {
  tree = bodyReg.component({})
} catch (e) {
  renderErr = e
}
check('WorklogPanel({}) 未抛错', renderErr === null, String(renderErr?.message))
check('返回了元素', !!tree)
const flat = JSON.stringify(tree, (k, v) => (typeof v === 'symbol' ? String(v) : v))
check('初始渲染含「读取中」或加载态', /读取中|正在解析/.test(flat))

// ---------------------------------------------------------------- 4. 样式只用 token
console.log('\n=== 4. 样式只用主题 token ===')
const hexColors = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
check('无字面 hex 颜色', hexColors.length === 0, hexColors.join(','))
const rgbColors = src.match(/\brgba?\(/g) ?? []
check('无字面 rgb()/rgba() 颜色', rgbColors.length === 0, rgbColors.join(','))
check('使用了 --dsw-alias-* token', /--dsw-alias-/.test(src))
// 原先断言的是 `!/document\.body/`，本意是"别把面板 UI 挂进页面 DOM"。
// 现在「下载报告」需要临时创建一个 <a> 并 click —— 那是瞬时元素、点完立刻 remove，
// 与"往页面里塞自己的 UI"不是一回事。所以改成：document.body 只允许用于下载锚点，
// 且必须立刻移除；仍然禁止 innerHTML 之类的整块挂载。
const bodyAppends = [...src.matchAll(/document\.body\.appendChild\(([^)]*)\)/g)].map((m) => m[1].trim())
check(
  '不把 UI 挂到 document.body（仅允许下载用的瞬时 <a>）',
  bodyAppends.every((x) => x === 'a') && !/document\.body\.innerHTML/.test(src),
  bodyAppends.join(' | '),
)
check('下载锚点用完立刻移除', src.includes('a.remove()'))

// 4b. 逐个校验用到的 token 真的存在于主题包里。
// 这一项是补上来的：最初我按猜测写了 --dsw-alias-text-primary 等 7 个**不存在**的
// token——不会报错，但整个面板会静默退化成"没有样式"。必须机器把关。
//
// 注意：必须核对**真正在运行的那个 DSH 的主题包**。
// 这台机器上有两个运行时（Desktop app 与旧的 runner），版本不同，先找 app。
console.log('\n=== 4b. 用到的 --dsw-* token 是否真实存在 ===')
const THEME_CANDIDATES = [
  'E:/tools/dsh-desktop/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  'E:/tools/dsh/runner/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
]
let realTokens = null
let themeUsed = null
for (const p of THEME_CANDIDATES) {
  try {
    const themeSrc = readFileSync(p, 'utf8')
    realTokens = new Set(themeSrc.match(/--dsw-[a-z0-9-]+/g) ?? [])
    themeUsed = p
    break
  } catch { /* 试下一个 */ }
}
if (realTokens) {
  console.log(`     对照的主题包: ${themeUsed.includes('dsh-desktop') ? 'Desktop app 运行时' : 'runner（旧）'}`)
} else {
  check('能读到主题包', false, THEME_CANDIDATES.join(' | '))
}
if (realTokens) {
  // 先剥掉注释，否则文档里写的示意（例如「用 dsw 别名变量」旁边的 token 通配写法）
  // 会被当成真实用到的 token，产生假阳性。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/^[ \t]*\*.*$/gm, '')
  // 只认「以字母数字结尾」的完整 token。
  const TOKEN_RE = /--dsw-[a-z0-9]+(?:-[a-z0-9]+)*/g
  const used = [...new Set(code.match(TOKEN_RE) ?? [])]
  const missing = used.filter((t) => !realTokens.has(t))
  check(`用到的 ${used.length} 个 token 全部存在`, missing.length === 0,
    missing.length ? `不存在的 token: ${missing.join(', ')}` : '')
  if (used.length) console.log(`     已校验: ${used.join(' ')}`)
}

// ---------------------------------------------------------------- 5. 清单
console.log('\n=== 5. package.json 清单 ===')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('exports 有 ./client', pkg.exports?.['./client'] === './client.js', String(pkg.exports?.['./client']))
check('dsh.client.platform === web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('dsh.client.inject 指向 sidebar-right', (pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
check('dsh.bundle.patch 存在', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('files 含 client.js', (pkg.files ?? []).includes('client.js'))

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
