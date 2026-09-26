/**
 * dsh-agent-worklog —— 宿主侧插件。
 *
 * 只做三件事：
 *   1. 注册一个 agent 工具 `work_report`，让模型能按需生成《本次 Agent 工作报告》；
 *   2. 提供一个只读 HTTP 路由 /plugins/dsh-agent-worklog/report，供 Web 面板取数据；
 *   3. 不改任何会话数据 —— 只读会话日志。
 *
 * 刻意**不 import 任何 @deepseek-ai/* 包**：工具定义用原生 JSON Schema 手写，
 * 这样插件不需要自带 node_modules，也就不存在 link 插件的模块解析问题。
 */

import { existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSessionLog, listSessions, readProjectionCache } from './core/session-log.mjs'
import { collectWorkRecord, rescoreRecord } from './core/collect.mjs'
import { renderReport } from './core/render.mjs'
import { reportDocument } from './core/html.mjs'

export const name = 'dsh-agent-worklog'
export const inject = ['tools']

// ------------------------------------------------------- 陈旧模块自检（踩过的坑）
//
// Node 的 ESM 模块一旦 import 就缓存住；DSH 的 HMR 只在「启用插件 / 新增 Loader 条目」
// 时挂载，**不会因为模块文件被编辑而重新 import**。于是会出现最难查的一种状态：
// 宿主进程内存里是旧代码，而磁盘上是新代码——客户端（会被重新拉取）已经是新的，
// 两者对不上，表现为「面板除了总览全是空白」这类静默故障。
//
// 这里在每次请求时对照磁盘 mtime：只要有关键模块比本模块的加载时刻还新，就判定为陈旧，
// 并在工具输出 / 路由 payload / 日志里显式报出来，而不是让人去猜。
const LOADED_AT = Date.now()

const TRACKED_MODULES = [
  'index.js',
  'core/session-log.mjs',
  'core/collect.mjs',
  'core/render.mjs',
  'core/period.mjs',
]

let staleWarned = false

/** @returns {{stale:boolean, loadedAt:number, newer:Array<{file:string,mtime:number}>}} */
export function moduleFreshness() {
  const newer = []
  for (const rel of TRACKED_MODULES) {
    try {
      const file = fileURLToPath(new URL(rel, import.meta.url))
      const mtime = statSync(file).mtimeMs
      if (mtime > LOADED_AT) newer.push({ file: rel, mtime })
    } catch {
      /* 文件缺失不影响判定 */
    }
  }
  return { stale: newer.length > 0, loadedAt: LOADED_AT, newer }
}

function warnIfStale(log) {
  const f = moduleFreshness()
  if (!f.stale || staleWarned) return f
  staleWarned = true
  const list = f.newer.map((n) => `${n.file}(${new Date(n.mtime).toLocaleTimeString()})`).join('、')
  log?.(
    `⚠️ 宿主加载的是旧版插件模块（加载于 ${new Date(LOADED_AT).toLocaleTimeString()}），` +
      `磁盘上更新的文件：${list}。请重启 DSH 后再看报告，否则面板会出现「命令/文件/工具空白」这类不一致。`,
  )
  return f
}

/** 报告的「任务/结论」等位置需要显式说明会话是怎么选出来的。 */
function resolutionNote(resolvedBy, sessionId) {
  if (resolvedBy === 'explicit') return null
  if (resolvedBy === 'caller') return null
  return (
    `> ⚠️ 未指定会话，本次复盘的是**最近活跃**的会话 \`${sessionId}\`。` +
    `并发会话（子代理、另一个窗口）会改变这个选择，请显式传 \`sessionId\`。\n`
  )
}

/** 从工具执行上下文里取调用方会话 id（DSH 的 exec.agent）。 */
function sessionIdFromExec(exec) {
  return (
    exec?.agent?.session?.header?.id ??
    exec?.agent?.id ??
    exec?.session?.header?.id ??
    null
  )
}

/** 参数自校验：DSH 目前不会替我们拦 schema，所以这里必须自己拦。 */
function validateArgs(args) {
  const a = args ?? {}
  const allowed = new Set(['sessionId', 'turns', 'out', 'format'])
  for (const k of Object.keys(a)) {
    if (!allowed.has(k)) {
      throw new Error(`未知参数 ${JSON.stringify(k)}。支持的参数：sessionId、turns、out、format`)
    }
  }
  if (a.sessionId !== undefined && typeof a.sessionId !== 'string') {
    throw new Error(`sessionId 必须是字符串，收到 ${typeof a.sessionId}`)
  }
  if (a.turns !== undefined && !Number.isInteger(a.turns)) {
    throw new Error(`turns 必须是整数，收到 ${JSON.stringify(a.turns)}`)
  }
  if (a.out !== undefined && typeof a.out !== 'string') {
    throw new Error(`out 必须是字符串，收到 ${typeof a.out}`)
  }
  if (a.format !== undefined && !['markdown', 'json', 'html'].includes(a.format)) {
    throw new Error(`format 只支持 "markdown" / "json" / "html"，收到 ${JSON.stringify(a.format)}`)
  }
}

// ------------------------------------------------------------------ 定位 DSH home

function detectHome(explicit) {
  const cands = [
    explicit,
    process.env.DSH_HOME,
    process.env.DSH_PROFILE_DIR ? resolve(process.env.DSH_PROFILE_DIR, '..', '..') : null,
  ].filter(Boolean)
  for (const c of cands) if (existsSync(join(c, 'sessions'))) return c
  return null
}

// ------------------------------------------------------------------ 读取 + 缓存

/** 按 (file, size, mtime) 缓存解析结果，避免反复解压同一份大日志。 */
const cache = new Map()

function loadEvents(entry) {
  const key = `${entry.file}:${entry.bytes}:${entry.mtimeMs}`
  const hit = cache.get(key)
  if (hit) return hit
  const parsed = readSessionLog(entry.file)
  // 只保留最近 12 份，防止长会话累积占用
  if (cache.size > 12) cache.delete(cache.keys().next().value)
  cache.set(key, parsed)
  return parsed
}

function resolveSession(home, wanted) {
  const all = listSessions(home)
  if (all.length === 0) return { error: `在 ${home}\\sessions 下没有找到任何会话` }
  if (!wanted) return { entry: all[0], all, resolvedBy: 'newest' }
  const entry = all.find((s) => s.sessionId === wanted) ?? all.find((s) => s.sessionId.includes(wanted))
  if (!entry) return { error: `找不到会话 ${wanted}`, all }
  return { entry, all, resolvedBy: 'explicit' }
}

/** 面板的会话选择器用它列最近会话。 */
function recentSessions(home, limit = 30) {
  return listSessions(home)
    .slice(0, limit)
    .map((s) => ({
      sessionId: s.sessionId,
      workspace: s.workspace,
      mtimeMs: s.mtimeMs,
      bytes: s.bytes,
      title: readProjectionCache(home, s.sessionId)?.record?.rows?.title?.val ?? null,
    }))
}

function buildReport(home, wanted, limitTurns) {
  const r = resolveSession(home, wanted)
  if (r.error) throw new Error(r.error)
  const { events, frames, damaged } = loadEvents(r.entry)
  const record = collectWorkRecord(events)
  const cacheJson = readProjectionCache(home, r.entry.sessionId)

  // 投影缓存里的会话级 token 总量更权威（含被压缩掉的历史）
  const projTotals = cacheJson?.record?.rows?.tokenUsage?.val?.totals
  if (projTotals) record.sessionTokenTotals = projTotals
  const stats = cacheJson?.record?.rows?.sessionStats?.val
  if (stats) record.sessionStats = stats

  let scoped = record
  if (limitTurns > 0 && record.turns.length > limitTurns) {
    // 截断明细的同时**重算汇总**：否则会出现"明细只有 N 轮、总览却是全部轮次"，
    // 用户会以为整份报告统计的就是 N 轮 —— 这是实打实的误导。
    scoped = rescoreRecord({ ...record, turns: record.turns.slice(-limitTurns) })
    scoped.scope = { shown: limitTurns, total: record.turns.length }
  }

  return {
    sessionId: r.entry.sessionId,
    title: cacheJson?.record?.rows?.title?.val ?? record.title ?? null,
    markdown: renderReport(scoped),
    record: scoped,
    resolvedBy: r.resolvedBy,
    diagnostics: { frames, events: events.length, damagedFrames: damaged.length },
  }
}

// ------------------------------------------------------------------ 工具定义

const TOOL_NAME = 'work_report'

const TOOL = {
  name: TOOL_NAME,
  description: [
    '生成《本次 Agent 工作报告》——从 DSH 会话日志只读还原这次任务到底做了什么。',
    '报告包含：任务、用了哪些工具、读了/改了哪些文件、运行了哪些命令、测试是否通过、',
    '失败过几次及失败原因、消耗了多少 Token、最终有没有完成，并自动归纳可沉淀的经验。',
    '适用于任务复盘、写日报周报、排查某轮为什么失败、统计成本。',
  ].join(''),
  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '要复盘的会话 id（可只给前几位）。省略则复盘当前会话。',
      },
      turns: {
        type: 'integer',
        description: '只保留最近 N 轮，用于长会话聚焦。省略或 0 表示全部。',
      },
      out: {
        type: 'string',
        description: '把报告写入该路径（相对「会话的工作目录」解析）。省略则只在对话里返回。',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json', 'html'],
        description:
          '返回格式。markdown（默认）返回可读报告；json 返回结构化记录，便于二次处理；' +
          'html 返回自包含的可下载/可打印文档（配 out 写 .html 文件）。',
      },
    },
    required: [],
    additionalProperties: false,
  },
  output: {
    // 注意：DSH 的 JSON Schema 子集只接受**单个**标量 type（不接受 type: ['string','null']），
    // 可空字段要用省略 type 的注释型 schema，否则注册时会被 assertSupportedJsonSchema 拒绝。
    schema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        title: { description: '会话标题，可能为 null' },
        resolvedBy: { type: 'string', description: '会话是怎么选出来的：explicit / caller / newest' },
        turns: { type: 'integer' },
        toolCalls: { type: 'integer' },
        failures: { type: 'integer' },
        suspects: { type: 'integer' },
        testsRun: { type: 'integer' },
        outputTokens: { type: 'integer' },
        finished: { type: 'boolean' },
        writtenTo: { description: '报告落盘路径，未写文件时为 null' },
        text: { type: 'string', description: '报告正文（markdown / json / html 字符串）' },
      },
      required: ['sessionId', 'text'],
      additionalProperties: true,
    },
    render(_args, value) {
      return [{ type: 'text', text: value.text ?? '' }]
    },
  },
  async execute(args, exec) {
    const a = args ?? {}
    validateArgs(a)

    const home = detectHome()
    if (!home) throw new Error('找不到 DSH home（需要含 sessions/ 的目录，或设置 DSH_HOME 环境变量）')

    // 会话身份来源顺序：显式参数 → 调用方执行上下文（权威）→ 环境变量（仅兜底，宿主里通常为空）。
    // 注意：绝不把"最近被改动的会话"当成"当前会话"——并发会话会让它变成别人的会话。
    const callerId = sessionIdFromExec(exec)
    const wanted = a.sessionId || callerId || process.env.DSH_SESSION_ID || null

    const limit = Number.isInteger(a.turns) ? a.turns : 0
    const built = buildReport(home, wanted, limit)
    const T = built.record.totals

    const fresh = warnIfStale(ctxLog)
    const diagnostics = { ...built.diagnostics, resolvedBy: built.resolvedBy, sessionId: built.sessionId, freshness: fresh }

    const wantJson = a.format === 'json'
    const wantHtml = a.format === 'html'

    const text = wantJson
      ? JSON.stringify({ ...built.record, diagnostics }, null, 2)
      : wantHtml
        ? reportDocument(built.markdown, { sessionId: built.sessionId, generatedAt: Date.now() })
        : built.markdown +
        (resolutionNote(built.resolvedBy, built.sessionId) ?? '') +
        (fresh.stale
          ? `> ⚠️ 宿主加载的是旧版插件模块（${new Date(fresh.loadedAt).toLocaleString()}），` +
            `磁盘上有更新的文件：${fresh.newer.map((n) => n.file).join('、')}。**请重启 DSH**，否则数字可能与源码不符。\n`
          : '') +
        `\n> 解析自 ${built.diagnostics.frames} 个 zstd 帧 / ${built.diagnostics.events} 条事件` +
        (built.diagnostics.damagedFrames ? `（${built.diagnostics.damagedFrames} 帧损坏已跳过）` : '') +
        '\n'

    // 相对路径按「会话的工作目录」解析，而不是宿主进程的 cwd。
    // 宿主进程 cwd 是 Electron 安装目录，按它写会把报告丢进应用目录里（实测踩过）。
    let writtenTo = null
    if (a.out) {
      const sessionCwd = built.record.cwd
      const base = sessionCwd && existsSync(sessionCwd) ? sessionCwd : process.cwd()
      const target = isAbsolute(a.out) ? a.out : resolve(base, a.out)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text, 'utf8')
      writtenTo = target
    }

    return {
      sessionId: built.sessionId,
      title: built.title,
      resolvedBy: built.resolvedBy,
      turns: T.turns,
      toolCalls: T.toolCalls,
      failures: T.failures,
      suspects: T.suspects,
      testsRun: T.tests,
      outputTokens: T.outputTokens,
      finished: T.finished,
      writtenTo,
      // 只有 markdown 才追加「已写入」脚注：JSON 必须是纯 JSON，HTML 里加一行 markdown 会破坏文档。
      text: wantJson || wantHtml
        ? text
        : text + (writtenTo ? `\n> 报告已写入 \`${writtenTo}\`\n` : ''),
    }
  },
}

/** apply() 里注入的日志器；模块级 execute 需要它来报陈旧模块。 */
let ctxLog = null

// ------------------------------------------------------------------ 插件入口

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const log = (...a) => logger?.info?.('[dsh-agent-worklog]', ...a)
  ctxLog = (...a) => logger?.warn?.('[dsh-agent-worklog]', ...a)

  // 0) 启动即自检：宿主内存里的模块是否已经落后于磁盘（HMR 不会重载宿主模块）
  warnIfStale(ctxLog)

  // 1) 面向模型的复盘工具
  const tools = ctx.get?.('tools') ?? ctx.tools
  if (tools?.register) {
    ctx.effect(() => {
      const dispose = tools.register(TOOL)
      log('tool registered:', TOOL_NAME)
      return typeof dispose === 'function' ? dispose : undefined
    })
  }

  // 2) 只读 HTTP 路由，供 Web 面板 / 外部脚本取数据。
  //    用 ctx.inject 声明 webServer 是可选依赖：headless profile 没有它时，
  //    插件仍然激活（工具照常可用），只是不挂路由——而不是整个插件不加载。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (!webServer?.register) return
    const route = config.route ?? '/plugins/dsh-agent-worklog/report'
    webCtx.effect(
      () =>
        webServer.register({
          // 实测路由契约：{ kind: 'exact' | 'prefix', path, handler(req,res) }
          // 不是 { method, path, handler }——写错会静默不匹配。
          kind: 'prefix',
          path: route,
          handler: async (req, res) => {
            try {
              const home = detectHome()
              if (!home) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'DSH home not found' }))
                return
              }
              const url = new URL(req.url, 'http://localhost')

              // 会话选择器：面板用它列出最近会话（不指定会话时也能自己选）
              if (url.searchParams.get('list') !== null) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ sessions: recentSessions(home) }, null, 2))
                return
              }

              const sid = url.searchParams.get('sessionId') ?? undefined
              const turns = Number(url.searchParams.get('turns') ?? 0) || 0
              const format = url.searchParams.get('format') ?? 'json'
              const built = buildReport(home, sid, turns)
              const fresh = warnIfStale(ctxLog)

              const payload = {
                sessionId: built.sessionId,
                title: built.title,
                // 面板据此显示"当前展示的是哪个会话、是怎么选出来的"
                resolvedBy: built.resolvedBy,
                totals: built.record.totals,
                diagnostics: { ...built.diagnostics, resolvedBy: built.resolvedBy, freshness: fresh },
                record: built.record,
              }

              if (format === 'markdown') {
                res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
                res.end(
                  built.markdown +
                    (resolutionNote(built.resolvedBy, built.sessionId) ?? '') +
                    (fresh.stale
                      ? `> ⚠️ 宿主加载的是旧版插件模块，请重启 DSH。\n`
                      : ''),
                )
                return
              }
              if (format === 'html') {
                // 面板的「下载」按钮走这条路：自包含、可打印的文档
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
                res.end(reportDocument(built.markdown, { sessionId: built.sessionId, generatedAt: Date.now() }))
                return
              }
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(payload, null, 2))
            } catch (e) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: String(e?.message ?? e) }))
            }
          },
        }),
      'dsh-agent-worklog: report route',
    )
    log('http route registered:', route)
  })
}

/** 导出工具定义，便于离线测试（不影响 DSH 加载）。 */
export const workReportTool = TOOL
export { buildReport, detectHome, recentSessions, resolveSession, validateArgs, sessionIdFromExec, reportDocument }
