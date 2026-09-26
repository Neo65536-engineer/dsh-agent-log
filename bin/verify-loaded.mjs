#!/usr/bin/env node
/**
 * 加载验证：确认插件是否真的被 DSH 加载了。
 *
 * 为什么用日志而不是 HTTP：DSH 的 web server 对所有未认证请求返回 403
 * （连 `/` 都是 403），所以从外部探测路由行不通。
 *
 * 可靠信号：插件注册的 `work_report` 工具会进入**发给模型的工具列表**，
 * 而每次请求都会把它写进会话日志的 `request/header` 事件。
 * 因此读一下最近的 request/header，看工具列表里有没有 work_report 即可。
 *
 *   node bin/verify-loaded.mjs            查当前会话
 *   node bin/verify-loaded.mjs --session <id>
 *   node bin/verify-loaded.mjs --all      查所有会话里最新的一次请求
 *
 * 退出码：0 = 已加载；1 = 未加载；2 = 无法判断
 */
import { listSessions, readSessionLog, readProjectionCache } from '../core/session-log.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}

const HOME = process.env.DSH_HOME || 'E:\\tools\\dsh'
const TOOL = 'work_report'
const PLUGIN = 'dsh-agent-log'

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s, h) => {
  console.log(`  \x1b[31m✗\x1b[0m ${s}`)
  if (h) console.log(`      \x1b[2m→ ${h}\x1b[0m`)
}
const dim = (s) => console.log(`  \x1b[2m${s}\x1b[0m`)

console.log(`DSH home : ${HOME}`)
console.log(`查工具   : ${TOOL}`)
console.log('')

const sessions = listSessions(HOME)
if (!sessions.length) {
  bad('找不到任何会话')
  process.exit(2)
}

// 选定目标会话
let targets
if (has('--all')) {
  targets = sessions.slice(0, 10)
} else {
  const wanted = val('--session', process.env.DSH_SESSION_ID)
  const found = sessions.find((s) => s.sessionId === wanted || s.sessionId.includes(wanted))
  if (!found) {
    bad(`找不到会话 ${wanted}`)
    process.exit(2)
  }
  targets = [found]
}

let verdict = 'not-loaded'
let evidence = null

for (const entry of targets) {
  let events
  try {
    events = readSessionLog(entry.file).events
  } catch {
    continue
  }

  // 取最后一次 request/header —— 它代表最近一次真正发给模型的请求
  const headers = events.filter((e) => e.type === 'request/header')
  if (!headers.length) continue
  const last = headers[headers.length - 1]
  const tools = (last.data?.header?.tools ?? []).map((t) => t?.name).filter(Boolean)

  const cache = readProjectionCache(HOME, entry.sessionId)
  const title = cache?.record?.rows?.title?.val ?? ''
  const at = new Date(last.time ?? 0).toISOString().replace('T', ' ').slice(0, 19)

  console.log(`会话 ${entry.sessionId}`)
  if (title) dim(`标题: ${title}`)
  dim(`最后一次请求: ${at} · seq ${last.seq} · 工具 ${tools.length} 个`)

  const hit = tools.includes(TOOL)
  if (hit) {
    ok(`工具列表里出现了 \`${TOOL}\` —— 插件已加载`)
    verdict = 'loaded'
    evidence = { sessionId: entry.sessionId, seq: last.seq, at, toolCount: tools.length }
  } else {
    bad(`工具列表里没有 \`${TOOL}\` —— 插件未加载`)
    dim(`实际工具: ${tools.slice(0, 14).join(', ')}${tools.length > 14 ? ' …' : ''}`)
  }

  // 附加信号：系统提示里有没有提到本插件
  const sys = events.filter((e) => e.type === 'system/message').slice(-1)[0]
  const sysText = JSON.stringify(sys?.data ?? '')
  if (sysText.includes(PLUGIN)) dim('系统提示里出现了插件名（弱信号）')

  console.log('')
}

console.log('─'.repeat(52))
if (verdict === 'loaded') {
  console.log('\x1b[32m插件已加载\x1b[0m')
  console.log(`  证据: 会话 ${evidence.sessionId.slice(0, 24)} 的 request/header（seq ${evidence.seq}）`)
  console.log(`        工具列表含 ${TOOL}，共 ${evidence.toolCount} 个工具`)
  console.log('')
  console.log('  接下来可以试：')
  console.log('    对话里说「复盘一下这次任务」 → 模型应调用 work_report')
  console.log('    右侧边栏「+」→ 应有「Agent 工作报告」页签')
  process.exit(0)
}
console.log('\x1b[31m插件未加载\x1b[0m')
console.log('  可能原因：')
console.log('    1. DSH 还没重启（改了 profile 必须重启才生效）')
console.log('    2. 重启了但插件加载失败 —— 去看 DSH 日志或侧边栏的插件状态')
console.log('    3. profile 改动被覆盖 —— 跑 npm run preflight 重新确认')
process.exit(1)
