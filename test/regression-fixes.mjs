#!/usr/bin/env node
/**
 * 针对本轮修掉的缺陷的回归测试。
 *
 * 每个断言都对应一个**实测发生过**的缺陷（括号里是当时的症状）：
 *   1. 陈旧模块自检缺失（宿主跑旧代码，面板三个页签恒为空，且无任何提示）
 *   2. 参数 schema 形同虚设（{format:"yaml"}、{foo:1} 静默照跑）
 *   3. 面板/工具拿不到"当前会话"（并发时复盘到别人的会话）
 *   4. 相对 out 解析到宿主进程 cwd（报告被写进 Electron 安装目录）
 *   5. 路由不告诉调用方"会话是怎么选出来的"
 *   6. 进行中/零轮会话文案自相矛盾（"0s 完成" vs "未收尾"）
 *   7. CLI：--home 静默失效、-h 不认、--until 非法退化成 1970、--json 吞掉 --out
 */
import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  apply,
  workReportTool,
  moduleFreshness,
  validateArgs,
  sessionIdFromExec,
  buildReport,
  recentSessions,
} from '../index.js'
import { renderReport } from '../core/render.mjs'
import { stripAnsi, firstLines } from '../core/session-log.mjs'
import { testOutputLooksFailed, testOutputLooksPassed, classifyTestOutcome, flattenCommand, hasRealTestInvocation } from '../core/collect.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const HOME = process.env.DSH_HOME || 'E:\\tools\\dsh'

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

// ---------------------------------------------------------------- 路由抓取
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
const route = routes[0]

async function getJson(url) {
  const res = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  await route.handler({ url }, res)
  return { status: res.status, json: JSON.parse(res.body) }
}

async function getRes(url) {
  const res = { status: null, ct: null, body: null,
    writeHead(s, h) { this.status = s; this.ct = h?.['content-type'] },
    end(b) { this.body = b } }
  await route.handler({ url }, res)
  return { status: res.status, ct: res.ct, body: res.body }
}

// 挑一个真实存在的小会话做被试
const list = await getJson('/plugins/dsh-agent-worklog/report?list=1')
const sample = (list.json.sessions ?? []).find((s) => s.bytes < 200000) ?? list.json.sessions?.[0]
if (!sample) {
  console.log('找不到任何会话，无法回归验证')
  process.exit(1)
}

// ---------------------------------------------------------------- 1. 陈旧模块自检
console.log('=== 1. 陈旧模块自检 ===')
const fresh = moduleFreshness()
check('moduleFreshness() 返回结构完整', typeof fresh.stale === 'boolean' && typeof fresh.loadedAt === 'number' && Array.isArray(fresh.newer),
  JSON.stringify(fresh))
check('刚加载时不应判为陈旧', fresh.stale === false, JSON.stringify(fresh.newer))
const r1 = await getJson(`/plugins/dsh-agent-worklog/report?format=json&sessionId=${sample.sessionId}`)
check('路由 payload 带 diagnostics.freshness', !!r1.json.diagnostics?.freshness,
  JSON.stringify(Object.keys(r1.json.diagnostics ?? {})))

// ---------------------------------------------------------------- 2. 参数校验
console.log('\n=== 2. 参数自校验（DSH 不替我们拦 schema）===')
const bad = [
  [{ format: 'yaml' }, 'enum'],
  [{ foo: 1 }, 'additionalProperties'],
  [{ turns: true }, 'type(boolean)'],
  [{ turns: 1.5 }, 'type(非整数)'],
  [{ sessionId: 123 }, 'type(number)'],
  [{ out: {} }, 'type(out)'],
]
for (const [arg, label] of bad) {
  let threw = null
  try { validateArgs(arg) } catch (e) { threw = e.message }
  check(`拒绝 ${JSON.stringify(arg)}（${label}）`, !!threw, threw ?? '未拦下')
}
for (const good of [{}, { turns: 0 }, { format: 'json' }, { sessionId: 'a' }, { out: 'x.md' }]) {
  let threw = null
  try { validateArgs(good) } catch (e) { threw = e.message }
  check(`接受 ${JSON.stringify(good)}`, !threw, threw ?? '')
}

// ---------------------------------------------------------------- 3. 会话身份
console.log('\n=== 3. 会话身份来源（面板 / 工具）===')
check('exec.agent.session.header.id 优先', sessionIdFromExec({ agent: { session: { header: { id: 'S-A' } } } }) === 'S-A')
check('exec.agent.id 兜底', sessionIdFromExec({ agent: { id: 'S-B' } }) === 'S-B')
check('无 exec 时返回 null（不要猜）', sessionIdFromExec(undefined) === null)
check('recentSessions() 可按 mtime 列出会话', (recentSessions(HOME, 5) ?? []).length > 0)

const explicit = await getJson(`/plugins/dsh-agent-worklog/report?format=json&sessionId=${sample.sessionId}`)
check('显式 sessionId → resolvedBy=explicit', explicit.json.resolvedBy === 'explicit', String(explicit.json.resolvedBy))
check('显式 sessionId 被正确采用', explicit.json.sessionId === sample.sessionId)
const fallback = await getJson('/plugins/dsh-agent-worklog/report?format=json')
check('未给 sessionId → resolvedBy=newest（并会被面板标注出来）', fallback.json.resolvedBy === 'newest', String(fallback.json.resolvedBy))
check('路由 ?list=1 返回会话列表', Array.isArray(list.json.sessions) && list.json.sessions.length > 0,
  String((list.json.sessions ?? []).length))

// ---------------------------------------------------------------- 3b. 可下载的报告文档
console.log('\n=== 3b. 可下载的《本次 Agent 工作报告》（面板「下载」走这条路）===')
const html = await getRes(`/plugins/dsh-agent-worklog/report?format=html&sessionId=${sample.sessionId}`)
check('format=html → 200 text/html', html.status === 200 && /text\/html/.test(String(html.ct)),
  `${html.status} ${html.ct}`)
check('是自包含文档（doctype + 内联样式，无外部依赖）',
  /^<!doctype html>/i.test(String(html.body).trim()) && html.body.includes('<style>'), '')
const bodyOnly = (String(html.body).split('<main>')[1] ?? '').split('</main>')[0]
check('标题已转成 <h1..h4>', /<h1>/.test(bodyOnly))
check('表格已转成 <table>', bodyOnly.includes('<table>'))
check('列表已转成 <ul><li>', bodyOnly.includes('<ul>') || !/^\s*[-*] /m.test(bodyOnly))
check('正文里没有漏网的行首 markdown 标记',
  !/^#{1,4} /m.test(bodyOnly) && !/^\|/m.test(bodyOnly) && !/^\s*[-*] /m.test(bodyOnly),
  '仍有未转换的 markdown 行')
check('HTML 已被转义（无裸 < 逃逸标签）', !/<(?!\/?(h[1-4]|p|table|thead|tbody|tr|th|td|ul|li|blockquote|code|pre|strong|hr|br)\b)[a-z]/i.test(bodyOnly))
const mdRes = await getRes(`/plugins/dsh-agent-worklog/report?format=markdown&sessionId=${sample.sessionId}`)
check('format=markdown 仍可用', mdRes.status === 200 && String(mdRes.body).includes('# 本次 Agent 工作报告'))
// 工具的 html 分支：写盘时必须是 HTML，且不能拼接 markdown 脚注
const htmlOutName = `__worklog-html-check-${Date.now()}.html`
const toolHtml = await workReportTool.execute(
  { sessionId: sample.sessionId, turns: 1, format: 'html', out: htmlOutName },
  { agent: { session: { header: { id: sample.sessionId } } } },
)
check('工具 format=html 输出 HTML 文档', /^<!doctype html>/i.test(String(toolHtml.text).trim()))
check('工具 format=html 不追加 markdown 脚注', !String(toolHtml.text).includes('报告已写入'))
if (toolHtml.writtenTo && existsSync(toolHtml.writtenTo)) unlinkSync(toolHtml.writtenTo)

// ---------------------------------------------------------------- 4. 相对 out 的基准
console.log('\n=== 4. 相对 out 按「会话工作目录」解析 ===')
const built = buildReport(HOME, sample.sessionId, 0)
const relName = `__worklog-out-check-${Date.now()}.md`
const outRes = await workReportTool.execute(
  { sessionId: sample.sessionId, turns: 1, out: relName },
  { agent: { session: { header: { id: sample.sessionId } } } },
)
const expected = resolve(built.record.cwd, relName)
check('writtenTo 落在会话工作目录下（不是宿主进程 cwd）', outRes.writtenTo === expected,
  `实际 ${outRes.writtenTo} / 期望 ${expected}`)
check('文件真的写出来了', !!outRes.writtenTo && existsSync(outRes.writtenTo))
check('返回的 sessionId 来自 exec 上下文', outRes.sessionId === sample.sessionId)
check('返回文本 ≠ 落盘文本（带落盘脚注）时仍包含写入路径', String(outRes.text).includes(relName))
if (outRes.writtenTo && existsSync(outRes.writtenTo)) unlinkSync(outRes.writtenTo)

// ---------------------------------------------------------------- 5. 文案
console.log('\n=== 5. 进行中 / 零轮会话的文案（用合成记录，不依赖当前是否有活跃会话）===')
const md = outRes.text
check('已结束的会话照常输出耗时', typeof md === 'string' && md.includes('总耗时'), '')

// 造一个「最后一轮还没结束」的记录：以前会渲染成"总耗时 0s / 完成 0/0/0"
const live = JSON.parse(JSON.stringify(built.record))
live.totals.finished = false
if (live.turns.length) live.turns[live.turns.length - 1].endedAt = null
const mdLive = renderReport(live)
check('进行中会话结论标注「进行中」', mdLive.includes('进行中'), mdLive.split('\n').find((l) => l.includes('结论')) ?? '')
check('进行中会话不再写「总耗时 0s |」', !/\| 总耗时（轮次墙钟） \| 0s \|/.test(mdLive))
check('进行中会话给出快照提示', mdLive.includes('仍在进行中'), '')

// 零轮会话：以前是「⚠️ 未收尾」+「总耗时 0s」+「本次执行没有明显异常」三者互相矛盾
const zero = JSON.parse(JSON.stringify(built.record))
zero.totals = { ...zero.totals, turns: 0, finished: false }
zero.turns = []
const mdZero = renderReport(zero)
check('零轮会话结论不说「未收尾」', !mdZero.includes('未收尾'), mdZero.split('\n').find((l) => l.includes('结论')) ?? '')
check('零轮会话结论说明「还没有任务轮次」', mdZero.includes('还没有任务轮次'))
check('零轮会话不再说「没有明显异常」', !mdZero.includes('没有明显异常'))

// ---------------------------------------------------------------- 6. CLI
console.log('\n=== 6. CLI 行为 ===')
const cli = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'bin', 'worklog.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? -1, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}
const c1 = cli(['--home', 'C:\\no\\such\\dir', '--list'])
check('--home 无效 → exit 2 且不静默回退', c1.code === 2 && c1.stdout.includes('没有 sessions'), `exit=${c1.code}`)
const c2 = cli(['-h'])
check('-h 显示帮助', c2.code === 0 && c2.stdout.includes('用法'), `exit=${c2.code}`)
const c3 = cli(['--period', '--since', '30d', '--until', 'bananas'])
check('--until 非法 → exit 2（不再退化成 1970）', c3.code === 2 && !c3.stdout.includes('1970'), `exit=${c3.code}`)
const c4 = cli(['--period', '--since', '7d', '--until', '2020-01-01'])
check('--until 早于 --since → exit 2（不再静默出空报告）', c4.code === 2 && c4.stdout.includes('早于'), `exit=${c4.code}`)
const jsonOut = join('E:\\tools\\work', '_plugin-test', `cli-json-${Date.now()}.json`)
const c5 = cli(['--latest', '--json', '--out', jsonOut])
check('--json + --out 同时给：文件被写出来（不再静默丢弃）', c5.code === 0 && existsSync(jsonOut), `exit=${c5.code}`)
if (existsSync(jsonOut)) unlinkSync(jsonOut)
const c6 = cli(['--list'])
check('--list 仍正常', c6.code === 0 && c6.stdout.includes('DSH home'), `exit=${c6.code}`)

// ---------------------------------------------------------------- 7. 「测试」栏的判定与显示
// 真机踩过：`node --test <失败用例>` 之后紧跟一句 echo，整次 shell 调用退出码变成 0，
// 于是失败被记成「✅ 通过」。现在同时看输出里的失败标记。
console.log('\n=== 7. 测试栏：通过/失败判定与命令显示 ===')
const failCases = [
  ['node:test TAP 汇总', '# tests 1\n# pass 0\n# fail 1\nnot ok 1 - x'],
  ['TAP not ok', 'TAP version 13\nnot ok 3 - 这条失败'],
  ['pytest', 'FAILED tests/test_a.py::test_x - AssertionError'],
  ['jest 汇总', 'Tests:       1 failed, 2 passed, 3 total'],
  ['vitest 文件汇总', ' Test Files  1 failed | 2 passed (3)'],
  ['通用汇总', '3 tests failed'],
  ['本插件 run-all 汇总行', '共 13 个测试文件 · 通过 12 · 失败 1'],
]
for (const [name, text] of failCases) {
  check(`识别失败标记：${name}`, testOutputLooksFailed(text) === true)
}
const passCases = [
  ['node:test 全通过', '# tests 5\n# pass 5\n# fail 0\nok 1 - a\nok 2 - b'],
  ['本插件全通过', '共 13 个测试文件 · 通过 13 · 失败 0'],
  ['无关输出', 'Get-ChildItem 列出 12 个文件'],
  ['空输出', ''],
]
for (const [name, text] of passCases) {
  check(`不误报：${name}`, testOutputLooksFailed(text) === false, String(text).slice(0, 40))
}
const flat = flattenCommand('cd E:\\a\n"=== 1) ==="\nnode --test x.test.mjs', 200)
check('多行命令压成一行（不再只显示第一行 cd …）',
  flat === 'cd E:\\a ; "=== 1) ===" ; node --test x.test.mjs', flat)
check('压行后仍按宽度截断', flattenCommand('x'.repeat(300), 50).length === 51)

// --- 三态判定：宁可说「未判定」，也不谎报「通过」
console.log('\n--- 三态判定（发布给用户，不能靠用户自觉）---')
const moreFail = [
  ['断言失败（Node）', 'code: \'ERR_ASSERTION\', actual: 2, expected: 3'],
  ['断言失败（Python）', 'AssertionError: 1 != 3'],
  ['go test', '--- FAIL: TestFoo (0.00s)'],
  ['cargo test', 'test result: FAILED. 3 passed; 1 failed'],
  ['gradle/maven', 'BUILD FAILED in 3s'],
  ['python unittest', 'FAILED (failures=1)'],
]
for (const [name, text] of moreFail) {
  check(`识别失败标记（新增）：${name}`, testOutputLooksFailed(text) === true, text)
}
const morePass = [
  ['jest 通过', 'Tests:       5 passed, 5 total'],
  ['vitest 通过', ' Test Files  3 passed (3)'],
  ['cargo 通过', 'test result: ok. 5 passed; 0 failed'],
  ['gradle 通过', 'BUILD SUCCESSFUL in 5s'],
  ['python OK', 'OK'],
  ['mocha', '  5 passing (12ms)'],
]
for (const [name, text] of morePass) {
  check(`识别通过汇总：${name}`, testOutputLooksPassed(text) === true, text)
  check(`通过汇总不会被当成失败：${name}`, testOutputLooksFailed(text) === false, text)
}
check('「0 failed」不会被当成失败（cargo 通过输出里就有它）',
  testOutputLooksFailed('test result: ok. 5 passed; 0 failed') === false)
check('「OK」只匹配独立行，不把 OKAY 误判为通过',
  testOutputLooksPassed('OK') === true && testOutputLooksPassed('BROKEN OKAY') === false)

const cls = (o) => classifyTestOutcome(o)
let r = cls({ command: 'npm test', resultText: '# fail 1', callOk: true })
check('输出有失败标记 → 未通过（即使退出码为 0）', r.passed === false && r.basis === 'output-fail', JSON.stringify(r))
r = cls({ command: 'npm test', resultText: '# fail 0\n# pass 5', callOk: false })
check('输出有通过汇总且无失败标记 → 通过（即使退出码非 0，如被 grep 改写过）',
  r.passed === true && r.basis === 'output-pass', JSON.stringify(r))
r = cls({ command: 'npm test', resultText: '', callOk: true })
check('测试是最后一句 + 退出码 0 → 通过（依据=退出码）', r.passed === true && r.basis === 'exit-code', JSON.stringify(r))
r = cls({ command: 'npm test', resultText: '', callOk: false })
check('测试是最后一句 + 退出码非 0 → 未通过', r.passed === false && r.basis === 'exit-code', JSON.stringify(r))

// 真机踩过的两种"退出码被掩盖"：管道 / 后面还有语句 —— 无法归因时必须说「未判定」
r = cls({ command: 'npm run verify 2>&1 | Select-Object -Last 20', resultText: '（输出被截断，无汇总）', callOk: true })
check('管道导致退出码不可归因 → 未判定（不谎报通过）', r.passed === null && r.basis === 'unknown', JSON.stringify(r))
check('未判定时给出可读原因（管道）', /管道/.test(r.note ?? ''), r.note ?? '')
r = cls({ command: 'cd x\nnode --test a.test.mjs\n"exit=$LASTEXITCODE"', resultText: '（无汇总）', callOk: true })
check('测试后面还有语句 → 未判定', r.passed === null && /后面还有别的语句/.test(r.note ?? ''), JSON.stringify(r))
r = cls({
  command: 'cd x\nnode --test demo-failing.test.mjs 2>&1 | Select-Object -Last 6\n"exit=$LASTEXITCODE"',
  resultText: "code: 'ERR_ASSERTION', actual: 2, expected: 3",
  callOk: true,
})
check('真机那个失败用例：管道 + 截断输出，靠断言标记仍判为未通过',
  r.passed === false && r.basis === 'output-fail', JSON.stringify(r))

// --- 误报防护：只是"提到"测试运行器的命令不能被算成跑过测试
console.log('\n--- 测试运行器的识别：不能把"提到"当成"跑过" ---')
const shouldDetect = [
  ['npm test', true],
  ['npm run verify 2>&1', true],
  ['cd x && npm run test:unit', true],
  ['node --test tests/a.test.mjs', true],
  ['pnpm exec vitest run', true],
  ['vitest run', true],
  ['cd repo && jest --ci', true],
  ['npx playwright test', true],
  ['pytest -q', true],
  ['bash -c "npm test"', true],
  // 直接跑测试脚本。本插件自己的入口就是这一条，早先它被算成"没跑测试"，
  // 报告于是对着自己的测试套件报「测试执行 0」——事实错误。
  ['node test/run-all.mjs', true],
  ['node test\\run-all.mjs', true],
  ['cd "E:\\tools\\work\\plugins\\dsh-agent-worklog"; node test/run-all.mjs 2>&1 | Out-String -Width 200', true],
  ['node tests/all.js', true],
  ['node src/foo.test.mjs', true],
]
for (const [cmd, want] of shouldDetect) {
  check(`识别为测试：${cmd}`, hasRealTestInvocation(cmd) === want)
}
const shouldIgnore = [
  ['echo "下一步：npm test"', '引号里只是字符串'],
  ['grep vitest package.json', '只是在搜索运行器名字'],
  ["Select-String -Path pkg.json -Pattern 'jest'", '只是搜索'],
  ['Get-Content package.json', '与测试无关'],
  // 不能因为"命令里出现了 test 目录字样"就算跑测试
  ['node build.mjs', '只是跑构建脚本'],
  ['node scripts/make-report.mjs', '只是跑普通脚本'],
  ['Get-ChildItem -Recurse test\\*.mjs', '只是在列测试文件'],
]
for (const [cmd, why] of shouldIgnore) {
  check(`不算测试（${why}）：${cmd}`, hasRealTestInvocation(cmd) === false)
}
check('只提到测试的运行器 → 分类为"无测试运行器"（不会给出假通过）',
  classifyTestOutcome({ command: 'echo "npm test"', resultText: '', callOk: true }).basis === 'unknown')

// --- 终端颜色码不能漏进报告（真机上失败命令的说明里出现过半截 `[38;2;`）
console.log('\n--- 预览文本必须剥掉 ANSI 颜色码 ---')
const colored = '\u001b[38;2;140;140;140mFullName   Length\u001b[0m'
check('stripAnsi 去掉 SGR 颜色码', stripAnsi(colored) === 'FullName   Length', JSON.stringify(stripAnsi(colored)))
check('firstLines 不再夹带 ESC', !firstLines(colored, 2).includes('\u001b'), JSON.stringify(firstLines(colored, 2)))
check('多行着色输出只留文字',
  firstLines('\u001b[1mdsh-agent-worklog 安装器\u001b[0m\n插件目录 : E:\\x', 2) === 'dsh-agent-worklog 安装器 | 插件目录 : E:\\x',
  JSON.stringify(firstLines('\u001b[1mdsh-agent-worklog 安装器\u001b[0m\n插件目录 : E:\\x', 2)))
check('按宽度截断也不会留下半截控制序列',
  !/\[\d/.test(firstLines('\u001b[38;2;140;140;140m' + 'x'.repeat(300), 1, 40)),
  JSON.stringify(firstLines('\u001b[38;2;140;140;140m' + 'x'.repeat(300), 1, 40)))
check('没有 ANSI 时原样返回', stripAnsi('普通文本') === '普通文本')

// --- turns：明细截断后，总览必须跟着重算
console.log('\n--- turns 参数：总览与明细必须一致 ---')
// 找一个真正的多轮会话（不能因为样本恰好只有 1 轮就跳过这项验证）
let multi = null
for (const s of (list.json.sessions ?? []).slice(0, 15)) {
  const p = buildReport(HOME, s.sessionId, 0)
  if (p.record.turns.length >= 3) { multi = p; break }
}
if (multi) {
  const sid = multi.sessionId
  const full = multi
  const one = buildReport(HOME, sid, 1)
  const lastTurn = full.record.turns[full.record.turns.length - 1]
  console.log(`     用多轮会话 ${sid.slice(0, 24)}（${full.record.turns.length} 轮）`)
  check('turns=1 时 totals.turns 收敛到 1（以前仍是全集）', one.record.totals.turns === 1,
    `totals.turns=${one.record.totals.turns}`)
  check('turns=1 时工具调用数按最后一轮重算',
    one.record.totals.toolCalls === lastTurn.toolCalls.length,
    `${one.record.totals.toolCalls} vs 末轮 ${lastTurn.toolCalls.length}（全集 ${full.record.totals.toolCalls}）`)
  check('turns=1 时命令数按最后一轮重算',
    one.record.totals.commands === lastTurn.commands.length,
    `${one.record.totals.commands} vs 末轮 ${lastTurn.commands.length}`)
  check('turns=1 时失败数按最后一轮重算',
    one.record.totals.failures === lastTurn.failures.length,
    `${one.record.totals.failures} vs 末轮 ${lastTurn.failures.length}`)
  check('记录带 scope（供面板/报告显式说明只统计了 N 轮）',
    one.record.scope?.shown === 1 && one.record.scope?.total === full.record.turns.length,
    JSON.stringify(one.record.scope))
  check('报告里明写"只统计最近 1 轮"', /只统计最近 1 轮/.test(one.markdown), '')
  check('未指定 turns 时不带 scope（不会误伤）', !full.record.scope, JSON.stringify(full.record.scope ?? null))
  // 全量报告仍然覆盖所有轮次
  check('不传 turns 时 totals.turns 仍是全集', full.record.totals.turns === full.record.turns.length)
} else {
  check('找到至少一个多轮会话用于验证 turns 语义', false, '当前机器上没有 ≥3 轮的会话')
}

check('构建产物里 tests 条目带 kind 与 passed 字段',
  (() => {
    const t = buildReport(HOME, sample.sessionId, 0).record.totals.allTests ?? []
    return t.every((x) => typeof x.kind === 'string' && (x.passed === true || x.passed === false || x.passed === null))
  })())

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
