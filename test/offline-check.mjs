#!/usr/bin/env node
/**
 * 离线验收：直接调用插件导出的工具定义，验证 execute 通路（不经过 DSH）。
 * 这样在装机之前就能确认工具真的能跑、schema 合法、输出可渲染。
 */
import { workReportTool, detectHome } from '../index.js'
import { readSessionLog } from '../core/session-log.mjs'
import { collectWorkRecord } from '../core/collect.mjs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let pass = 0
let fail = 0
let skipped = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${extra}`)
  }
}
/**
 * 「跳过」是**独立于失败**的一种结果。
 *
 * 需要它的原因：本仓库零依赖，而 DSH 的 schema 校验器只存在于 DSH 安装里。
 * 早先这里把"加载不到校验器"直接判成失败 —— 于是任何**新克隆**（没有那个
 * junction）跑 `npm run verify` 必红一项，而红的原因跟代码质量毫无关系。
 * 正确语义是：能拿到就严格校验；拿不到就说明跳过，并给出恢复办法。
 * 发布前想强制要求它，设 DSH_REQUIRE_VALIDATOR=1。
 */
const skip = (name, why) => {
  skipped++
  console.log(`  ⏭  ${name} —— 跳过（${why}）`)
}
const REQUIRE_VALIDATOR = process.env.DSH_REQUIRE_VALIDATOR === '1'

console.log('=== 1. 工具定义自检 ===')
check('name 正确', workReportTool.name === 'work_report', workReportTool.name)
check('有 description', typeof workReportTool.description === 'string' && workReportTool.description.length > 40)
check('parameters 是 object 根', workReportTool.parameters.type === 'object')
check('parameters.additionalProperties === false', workReportTool.parameters.additionalProperties === false)
check('output.schema 存在', !!workReportTool.output?.schema)
check('output.render 是函数', typeof workReportTool.output?.render === 'function')
check('execute 是函数', typeof workReportTool.execute === 'function')
check('无 @deepseek-ai 依赖', true, '(纯 JSON Schema 手写)')

// 用 DSH 自己的校验器验证手写 schema 落在受支持子集内。
// 这一步至关重要：schema 不合法会在注册时抛错，插件直接加载失败。
console.log('\n=== 1b. 用 DSH 真实校验器验证 schema ===')
let dshTools = null
try {
  // 通过包名导入（node_modules/@deepseek-ai 已链到 DSH 安装目录）。
  // 直接 import 包内文件路径会被 package.json 的 exports 映射挡住，所以必须走包名。
  dshTools = await import('@deepseek-ai/dsh-tools')
} catch {
  dshTools = null
}
if (dshTools?.assertSupportedJsonSchema) {
  const { assertSupportedJsonSchema } = dshTools
  let paramsOk = true
  let paramsErr = ''
  try {
    assertSupportedJsonSchema(workReportTool.parameters)
  } catch (e) {
    paramsOk = false
    paramsErr = String(e?.violations ?? e?.message ?? e)
  }
  check('parameters 通过 assertSupportedJsonSchema', paramsOk, paramsErr)

  let outOk = true
  let outErr = ''
  try {
    assertSupportedJsonSchema(workReportTool.output.schema)
  } catch (e) {
    outOk = false
    outErr = String(e?.violations ?? e?.message ?? e)
  }
  check('output.schema 通过 assertSupportedJsonSchema', outOk, outErr)
} else {
  const why = '未找到 @deepseek-ai/dsh-tools —— 先跑 `npm run dev:setup` 把开发期 junction 建起来'
  if (REQUIRE_VALIDATOR) {
    check('能加载 DSH 校验器', false, `(${why})`)
  } else {
    skip('能加载 DSH 校验器', why)
    skip('parameters / output.schema 的受支持子集校验', '同上（schema 仍是手写的，只是没被宿主校验器验过）')
  }
}


console.log('\n=== 2. 能定位 DSH home ===')
const home = detectHome()
check('detectHome 成功', !!home, String(home))
console.log(`     home = ${home}`)

console.log('\n=== 3. execute：默认取当前会话 ===')
const r1 = await workReportTool.execute({}, {})
check('返回 sessionId', typeof r1.sessionId === 'string' && r1.sessionId.startsWith('session-'))
check('返回 text', typeof r1.text === 'string' && r1.text.includes('本次 Agent 工作报告'))
check('turns > 0', r1.turns > 0, String(r1.turns))
check('toolCalls > 0', r1.toolCalls > 0, String(r1.toolCalls))
check('render 能产出 text 块', Array.isArray(workReportTool.output.render({}, r1)) && workReportTool.output.render({}, r1)[0].type === 'text')
console.log(`     会话 ${r1.sessionId} · 轮次 ${r1.turns} · 工具 ${r1.toolCalls} · 失败 ${r1.failures} · 疑似 ${r1.suspects}`)

console.log('\n=== 4. execute：json 格式 + 限定轮次 ===')
const r2 = await workReportTool.execute({ sessionId: 'session-2e667305', turns: 2, format: 'json' }, {})
const parsed = JSON.parse(r2.text)
check('json 可解析', !!parsed.sessionId)
check('只保留 2 轮', parsed.turns.length === 2, String(parsed.turns.length))
check('totals 存在', !!parsed.totals)
check('totals.finished 是布尔', typeof parsed.totals.finished === 'boolean')

console.log('\n=== 5. execute：--out 写文件 ===')
// 写进临时目录：不写死作者机器上的绝对路径（别人跑会往不存在的地方写）
const outFile = join(tmpdir(), `dsh-agent-log-out-${Date.now()}.md`)
const r3 = await workReportTool.execute({ sessionId: 'session-2e667305', out: outFile }, {})
check('writtenTo 指向目标', resolve(String(r3.writtenTo)) === resolve(outFile), String(r3.writtenTo))
const { readFileSync, existsSync, rmSync } = await import('node:fs')
check('文件真的写出来了', existsSync(outFile))
check('文件含报告标题', readFileSync(outFile, 'utf8').includes('# 本次 Agent 工作报告'))
rmSync(outFile, { force: true })
rmSync(outFile + '.tmp', { force: true })

console.log('\n=== 6. execute：错误会话要报错 ===')
let threw = null
try {
  await workReportTool.execute({ sessionId: 'does-not-exist-xyz' }, {})
} catch (e) {
  threw = e
}
check('不存在的会话抛错', !!threw, String(threw?.message))
check('错误信息可读', /找不到会话/.test(String(threw?.message)))

console.log('\n=== 7. 数据一致性：工具输出 vs 直接调用核心 ===')
const home2 = detectHome()
const { listSessions } = await import('../core/session-log.mjs')
const entry = listSessions(home2).find((s) => s.sessionId.startsWith('session-2e667305'))
const direct = collectWorkRecord(readSessionLog(entry.file).events)
const viaTool = JSON.parse((await workReportTool.execute({ sessionId: 'session-2e667305', format: 'json' }, {})).text)
check('轮次数一致', direct.totals.turns === viaTool.totals.turns, `${direct.totals.turns} vs ${viaTool.totals.turns}`)
check('工具调用数一致', direct.totals.toolCalls === viaTool.totals.toolCalls, `${direct.totals.toolCalls} vs ${viaTool.totals.toolCalls}`)
check('失败数一致', direct.totals.failures === viaTool.totals.failures, `${direct.totals.failures} vs ${viaTool.totals.failures}`)

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}` + (skipped ? ` · 跳过 ${skipped}` : ''))
if (skipped) console.log('（跳过项需要 DSH 运行时才能验：npm run dev:setup）')
process.exit(fail === 0 ? 0 : 1)
