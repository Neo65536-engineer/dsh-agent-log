#!/usr/bin/env node
/**
 * 装后冒烟测试：模拟 DSH 从 profile 加载这个插件。
 *
 * 在 profile 目录下按包名导入（这正是 DSH 的解析路径），确认：
 *   1. 包名能解析到符号链接
 *   2. 宿主入口 index.js 能被 import，且导出 apply / name / inject
 *   3. apply() 用假 ctx 跑一遍不抛错，能注册出工具与路由
 *   4. cordis.patch.yml 是合法 YAML，且 id/name 与包名一致
 *   5. 客户端产物 client.js 存在且符合 ModuleLoader 契约
 *
 * 这些是「重启前能确定」的全部；真正的加载只有重启才知道。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

// profile 定位：显式 $DSH_PROFILE_DIR → $DSH_HOME/profiles/<profile> → ~/.dsh/profiles/desktop。
// 不写死任何一台机器的绝对路径。
const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ||
  (() => {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    return join(home, 'profiles', process.env.DSH_PROFILE?.trim() || 'desktop')
  })()
const PKG = 'dsh-agent-log'
console.log(`profile: ${PROFILE_DIR}\n`)

// ---------------------------------------------------------------- 1. 解析
console.log('=== 1. 从 profile 解析包名 ===')
const linkedDir = join(PROFILE_DIR, 'node_modules', PKG)
check('node_modules 里有该包', existsSync(linkedDir))
check('是符号链接/目录', existsSync(join(linkedDir, 'package.json')))

const linkedPkg = JSON.parse(readFileSync(join(linkedDir, 'package.json'), 'utf8'))
check('解析到正确的包', linkedPkg.name === PKG, linkedPkg.name)

// 用 import.meta.resolve 模拟 DSH 的解析
let resolved = null
try {
  resolved = import.meta.resolve(PKG, pathToFileURL(join(PROFILE_DIR, 'index.js')).href)
} catch (e) {
  resolved = `解析失败: ${e.message}`
}
console.log(`     resolve → ${resolved}`)

// ---------------------------------------------------------------- 2. 宿主入口
console.log('\n=== 2. 宿主入口 index.js ===')
// 直接按解析出来的真实路径导入（等价于 DSH 的加载）
const entryPath = join(linkedDir, 'index.js')
let mod = null
let importErr = null
try {
  mod = await import(pathToFileURL(entryPath).href)
} catch (e) {
  importErr = e
}
check('index.js 能被 import', importErr === null, String(importErr?.message))
check('导出 apply', typeof mod?.apply === 'function')
check('导出 inject 数组', Array.isArray(mod?.inject), JSON.stringify(mod?.inject))
check('name 正确', mod?.name === PKG, String(mod?.name))

// ---------------------------------------------------------------- 3. apply 冒烟
console.log('\n=== 3. apply() 冒烟（假 ctx） ===')
const registered = { tools: [], routes: [], effects: [] }
const fakeCtx = {
  logger: { info: () => {} },
  effect(fn, label) { registered.effects.push(label); return fn() },
  get(name) {
    if (name === 'tools') return { register: (d) => (registered.tools.push(d), () => {}) }
    if (name === 'webServer') return { register: (r) => (registered.routes.push(r), () => {}) }
    return undefined
  },
  inject(deps, cb) { return cb(fakeCtx) },
}
let applyErr = null
try {
  mod.apply(fakeCtx)
} catch (e) {
  applyErr = e
}
check('apply 未抛错', applyErr === null, String(applyErr?.message))
check('注册了 work_report 工具', registered.tools.length === 1 && registered.tools[0].name === 'work_report',
  JSON.stringify(registered.tools.map((t) => t.name)))
check('注册了 HTTP 路由', registered.routes.length === 1, String(registered.routes.length))
check('路由用 kind 而非 method', registered.routes[0]?.kind === 'prefix' && registered.routes[0]?.method === undefined,
  JSON.stringify(Object.keys(registered.routes[0] ?? {})))

// ---------------------------------------------------------------- 4. cordis patch
console.log('\n=== 4. cordis.patch.yml ===')
const patchPath = join(linkedDir, 'cordis.patch.yml')
check('patch 文件存在', existsSync(patchPath))
if (existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8')
  check('含 insert 块', /insert:/.test(text))
  check('引用正确包名', text.includes(PKG))
  // 结构极简，做个形状校验
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  check('形状正确（insert → id/name）',
    lines[0] === '- insert:' && lines[1] === '- id: dsh-agent-log' && lines[2] === `name: ${PKG}`,
    JSON.stringify(lines))
}

// ---------------------------------------------------------------- 5. 客户端产物
console.log('\n=== 5. 客户端产物 client.js ===')
const clientPath = join(linkedDir, 'client.js')
check('client.js 存在', existsSync(clientPath))
if (existsSync(clientPath)) {
  const src = readFileSync(clientPath, 'utf8')
  check('使用 __ModuleLoader__.load', /window\.__ModuleLoader__\.load\(/.test(src))
  check('id 等于包名', new RegExp(`id:\\s*'${PKG}'`).test(src))
  check('无 @deepseek-ai 运行时 import', !/require\(\s*['"]@deepseek-ai\//.test(src))

  // 实际执行一遍（拦截 ModuleLoader）
  let loadedSpec = null
  globalThis.window = { __ModuleLoader__: { load: (s) => (loadedSpec = s) } }
  let clientErr = null
  try {
    await import(pathToFileURL(clientPath).href)
  } catch (e) {
    clientErr = e
  }
  check('client.js 能执行并自注册', clientErr === null && loadedSpec !== null,
    clientErr ? String(clientErr.message) : 'loadedSpec=null')
  check('自注册 id 正确', loadedSpec?.id === PKG, String(loadedSpec?.id))
  if (loadedSpec) {
    const fakeReact = {
      createElement: (t, p, ...c) => ({ t, p, c }),
      Fragment: Symbol('F'),
      useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
      useEffect: () => {},
    }
    const cm = loadedSpec.factory((n) => {
      if (n === 'react') return fakeReact
      throw new Error('客户端不应 require: ' + n)
    })
    check('factory 返回 inject/apply', Array.isArray(cm?.inject) && typeof cm?.apply === 'function')
    const reg = { tabs: [], slots: [] }
    const cctx = {
      effect: (fn) => fn(),
      slots: { inject: (o, cb) => cb(), register: (opts) => (reg.slots.push(opts), () => {}) },
      sidebarRightTabs: { register: (d) => (reg.tabs.push(d), () => {}) },
    }
    let capplyErr = null
    try {
      cm.apply(cctx)
    } catch (e) {
      capplyErr = e
    }
    check('客户端 apply 未抛错', capplyErr === null, String(capplyErr?.message))
    check('注册了 tab 类型', reg.tabs.length === 1 && reg.tabs[0].kind === 'worklog',
      JSON.stringify(reg.tabs.map((t) => t.kind)))
    check('注册了正文插槽', reg.slots[0]?.name === 'sidebar.right.pane.tab' && reg.slots[0]?.key === PKG,
      JSON.stringify(reg.slots[0]))
  }
}

// ---------------------------------------------------------------- 6. 兼容性门禁
console.log('\n=== 6. DSH 版本兼容性门禁 ===')
// dsh-app-boot 的规则：没有 peerDependencies 字段 → 直接放行
const manifest = JSON.parse(readFileSync(join(linkedDir, 'package.json'), 'utf8'))
check('未声明 peerDependencies（门禁直接放行）', !Object.hasOwn(manifest, 'peerDependencies'),
  JSON.stringify(manifest.peerDependencies))
check('未声明 dependencies（零依赖）', !manifest.dependencies || Object.keys(manifest.dependencies).length === 0,
  JSON.stringify(manifest.dependencies))

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
