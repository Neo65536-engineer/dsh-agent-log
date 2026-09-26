#!/usr/bin/env node
/**
 * 宿主侧 apply() 通路验收。
 *
 * 之前的 offline-check 只测了工具定义本身，没测 apply() —— 而装机真正跑的是 apply()。
 * 这里用假 ctx 模拟 cordis 的组合过程，验证：
 *   1. apply 不抛错
 *   2. 工具被注册，且 schema 合法
 *   3. 路由以正确的契约注册（{kind,path,handler}，不是 {method,...}）
 *   4. 可选依赖 webServer 缺失时，插件仍激活（工具照常注册），不整插件不加载
 *   5. 路由 handler 真的能返回数据
 */
import { apply as applyPlugin, workReportTool } from '../index.js'

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

/** 造一个最小的假 cordis ctx。services 决定哪些可选依赖"存在"。 */
function makeCtx({ services = ['tools', 'webServer'] } = {}) {
  const state = { tools: [], routes: [], effects: [], injects: [] }
  const ctx = {
    logger: { info: () => {} },
    get(name) {
      if (!services.includes(name)) return undefined
      if (name === 'tools') {
        return {
          register(def) {
            state.tools.push(def)
            return () => {}
          },
        }
      }
      if (name === 'webServer') {
        return {
          register(route) {
            state.routes.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn, label) {
      state.effects.push(label ?? '(no-label)')
      return fn()
    },
    inject(deps, cb) {
      state.injects.push(deps)
      // cordis 的语义：依赖齐全才执行回调
      if (deps.every((d) => services.includes(d))) return cb(ctx)
      return undefined
    },
  }
  return { ctx, state }
}

// ---------------------------------------------------------------- 1. 全依赖
console.log('=== 1. 依赖齐全时 ===')
const a = makeCtx()
let err = null
try {
  applyPlugin(a.ctx)
} catch (e) {
  err = e
}
check('apply 未抛错', err === null, String(err?.message))
check('注册了 1 个工具', a.state.tools.length === 1, String(a.state.tools.length))
check('工具名正确', a.state.tools[0]?.name === 'work_report', String(a.state.tools[0]?.name))
check('声明了 webServer 为可选依赖', JSON.stringify(a.state.injects) === '[["webServer"]]', JSON.stringify(a.state.injects))
check('注册了 1 条路由', a.state.routes.length === 1, String(a.state.routes.length))

const route = a.state.routes[0]
check('路由用 kind 而不是 method', route?.kind !== undefined && route?.method === undefined,
  `keys=${Object.keys(route ?? {}).join(',')}`)
check("路由 kind 是 'prefix'", route?.kind === 'prefix', String(route?.kind))
check('路由 path 正确', route?.path === '/plugins/dsh-agent-worklog/report', String(route?.path))
check('路由有 handler', typeof route?.handler === 'function')
check('用了 ctx.effect 管理生命周期', a.state.effects.length >= 2, a.state.effects.join(' | '))

// ---------------------------------------------------------------- 2. 无 webServer
console.log('\n=== 2. 没有 webServer 时（headless 场景）===')
const b = makeCtx({ services: ['tools'] })
let err2 = null
try {
  applyPlugin(b.ctx)
} catch (e) {
  err2 = e
}
check('apply 未抛错', err2 === null, String(err2?.message))
check('工具仍然注册（插件没被整体禁用）', b.state.tools.length === 1, String(b.state.tools.length))
check('没有注册路由', b.state.routes.length === 0, String(b.state.routes.length))

// ---------------------------------------------------------------- 3. handler 真跑
console.log('\n=== 3. 路由 handler 真的能返回数据 ===')
const { ctx: c } = makeCtx()
applyPlugin(c)
const handler = a.state.routes[0].handler

/** 假的 res：收集 writeHead / end */
function makeRes() {
  const out = { status: null, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = body
    },
  }
}

const res1 = makeRes()
await handler({ url: '/plugins/dsh-agent-worklog/report?format=json' }, res1)
check('返回 200', res1.out.status === 200, String(res1.out.status))
check('content-type 是 json', /application\/json/.test(res1.out.headers?.['content-type'] ?? ''))
let parsed = null
try {
  parsed = JSON.parse(res1.out.body)
} catch { /* 下面 check 会报 */ }
check('响应是合法 JSON', parsed !== null)
check('含 sessionId', typeof parsed?.sessionId === 'string', String(parsed?.sessionId))
check('含 totals', !!parsed?.totals)
check('totals 有工具直方图', Array.isArray(parsed?.totals?.toolHistogram))
check('含 diagnostics', !!parsed?.diagnostics)

const res2 = makeRes()
await handler({ url: '/plugins/dsh-agent-worklog/report?format=markdown' }, res2)
check('markdown 格式返回 200', res2.out.status === 200, String(res2.out.status))
check('markdown content-type 正确', /text\/markdown/.test(res2.out.headers?.['content-type'] ?? ''))
check('markdown 正文含报告标题', String(res2.out.body).includes('# 本次 Agent 工作报告'))

const res3 = makeRes()
await handler({ url: '/plugins/dsh-agent-worklog/report?format=json&sessionId=nope-xyz' }, res3)
check('未知会话返回 500 而不是崩溃', res3.out.status === 500, String(res3.out.status))
check('错误信息可读', /找不到会话/.test(String(res3.out.body)))

// ---------------------------------------------------------------- 4. 重复注册防护
console.log('\n=== 4. 二次 apply（幂等/共存）===')
const d = makeCtx()
let err3 = null
try {
  applyPlugin(d.ctx)
  applyPlugin(d.ctx)
} catch (e) {
  err3 = e
}
check('连续 apply 两次未抛错', err3 === null, String(err3?.message))
check('工具被注册两次（交由注册表去重/报错）', d.state.tools.length === 2, String(d.state.tools.length))

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
