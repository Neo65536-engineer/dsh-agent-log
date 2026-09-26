#!/usr/bin/env node
/**
 * dsh-agent-log 离线 CLI —— 验证核心逻辑，不需要安装插件。
 *
 *   node bin/worklog.mjs --list                    列出所有会话
 *   node bin/worklog.mjs --latest                  最近一个会话的报告
 *   node bin/worklog.mjs <sessionId>               指定会话
 *   node bin/worklog.mjs <sessionId> --out r.md    写入文件
 *   node bin/worklog.mjs <sessionId> --json        输出 JSON 模型
 */
import { writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readSessionLog, listSessions, readProjectionCache, messageText } from '../core/session-log.mjs'
import { collectWorkRecord } from '../core/collect.mjs'
import { renderReport } from '../core/render.mjs'
import { aggregatePeriod, renderPeriod, parseWhen, dayKey } from '../core/period.mjs'
import { mdhm, ymd } from '../core/time.mjs'

/** 依次尝试：显式参数 → 环境变量 → 用户目录（与 DSH 自身一致：$DSH_HOME → ~/.dsh）。
 *  注意：显式给了 --home 就不能静默降级——否则用户查别的 profile 会拿到别处的数据还以为成功。
 *  这里**不允许**出现机器写死的路径：早先候选表里有一项是作者的 `E:\tools\dsh`，
 *  在别人的机器上它只会让报错更难懂。 */
function detectHome(explicit) {
  const ok = (c) => c && existsSync(join(c, 'sessions'))
  if (explicit) {
    if (!ok(explicit)) {
      console.error(`--home 指向的目录里没有 sessions/：${explicit}`)
      process.exit(2)
    }
    return explicit
  }
  const cands = [
    process.env.DSH_HOME,
    process.env.DSH_PROFILE_DIR ? resolve(process.env.DSH_PROFILE_DIR, '..', '..') : null,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : null,
    process.env.HOME ? join(process.env.HOME, '.dsh') : null,
  ].filter(Boolean)
  for (const c of cands) {
    if (ok(c)) return c
  }
  return null
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, def = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))

const home = detectHome(value('--home'))
if (!home) {
  console.error('找不到 DSH home（含 sessions/ 的目录）。请用 --home <path> 指定。')
  process.exit(2)
}

const sessions = listSessions(home)

if (flag('--help') || flag('-h') || argv.length === 0) {
  console.log(`dsh-agent-log —— 从 DSH 会话日志生成 Agent 工作报告

  DSH home : ${home}
  会话数   : ${sessions.length}

用法：
  node bin/worklog.mjs --list                  列出会话（最多最近 60 个）
  node bin/worklog.mjs --latest                最近会话的报告
  node bin/worklog.mjs <sessionId>             指定会话
  node bin/worklog.mjs <sessionId> --out r.md  写入文件
  node bin/worklog.mjs <sessionId> --json      输出 JSON 模型
  node bin/worklog.mjs <sessionId> --turns 3   明细只保留最近 N 轮（总览仍为全会话汇总）

  --home <path>                                指定 DSH home（含 sessions/ 的目录）
  -h / --help                                  本帮助

日报 / 周报（跨会话聚合）：
  node bin/worklog.mjs --period --since today        今天的日报
  node bin/worklog.mjs --period --since 7d           最近 7 天
  node bin/worklog.mjs --period --since week         本周
  node bin/worklog.mjs --period --since 2026-09-20 --until 2026-09-25
  node bin/worklog.mjs --period --since 30d --out 月报.md

  默认窗口是 7d；--until 非法或早于 --since 会报错退出（exit 2）。
`)
  process.exit(0)
}

// ---------------------------------------------------------------- 日报 / 周报
if (flag('--period')) {
  const since = parseWhen(value('--since', '7d'))
  if (since == null) {
    console.error('无法解析 --since，支持：today / yesterday / week / 7d / 30d / YYYY-MM-DD')
    process.exit(2)
  }
  const untilRaw = value('--until')
  let until = Date.now() + 86400000
  if (untilRaw) {
    const parsed = parseWhen(untilRaw)
    if (parsed == null) {
      // 之前这里 `?? 0` 会静默退化成 1970，和 --since 的处理完全不一致
      console.error('无法解析 --until，支持：today / yesterday / week / 7d / 30d / YYYY-MM-DD')
      process.exit(2)
    }
    until = parsed + 86400000 - 1
  }
  if (until < since) {
    console.error(`--until（${ymd(until)}）早于 --since（${ymd(since)}），范围为空。`)
    process.exit(2)
  }
  const days = Math.max(1, Math.round((until - since) / 86400000))
  const label = value('--title', days <= 2 ? 'Agent 日报' : days <= 8 ? 'Agent 周报' : 'Agent 阶段报告')

  const agg = aggregatePeriod(home, { since, until })
  const md = renderPeriod(agg, { label, root: value('--root'), since, until })
  const out = value('--out')
  if (out) {
    writeFileSync(out, md, 'utf8')
    console.log(`已写入 ${resolve(out)}`)
    console.log(`覆盖 ${agg.sessions.length} 个会话 · ${agg.days.length} 天有活动`)
  } else {
    console.log(md)
  }
  process.exit(0)
}

if (flag('--list')) {
  const LIMIT = 60
  console.log(`DSH home: ${home}   共 ${sessions.length} 个会话\n`)
  for (const s of sessions.slice(0, LIMIT)) {
    const cache = readProjectionCache(home, s.sessionId)
    const title = cache?.record?.rows?.title?.val ?? ''
    const at = mdhm(s.mtimeMs)
    console.log(`${at}  ${(s.bytes / 1024).toFixed(0).padStart(6)}KB  ${s.sessionId}`)
    if (title) console.log(`            ${title}`)
  }
  if (sessions.length > LIMIT) {
    console.log(`\n（仅显示最近 ${LIMIT} 个，共 ${sessions.length} 个；更早的会话请用 --period 聚合查看）`)
  }
  process.exit(0)
}

let target
if (flag('--latest')) {
  target = sessions[0]
} else {
  const id = positional[0]
  if (!id) {
    console.error('缺少 sessionId。用 --list 查看，或 --latest 取最近一个。')
    process.exit(2)
  }
  target = sessions.find((s) => s.sessionId === id || s.sessionId.includes(id))
  if (!target) {
    console.error(`找不到会话：${id}（用 --list 查看可用 id）`)
    process.exit(2)
  }
}

const { events, frames, damaged } = readSessionLog(target.file)
let record = collectWorkRecord(events)

const keepTurns = Number(value('--turns', '0')) || 0
if (keepTurns > 0) {
  const cut = record.turns.length - keepTurns
  record.turns = record.turns.slice(-keepTurns)
}

if (flag('--json')) {
  const text = JSON.stringify(record, null, 2) + '\n'
  // 之前 --json 会直接 return，把 --out 静默丢掉；两个都要就给两个都办。
  const out = value('--out')
  if (out) {
    writeFileSync(out, text, 'utf8')
    console.log(`已写入 ${resolve(out)}（JSON）`)
  }
  console.log(text)
  process.exit(0)
}

const md = renderReport(record)
const out = value('--out')
if (out) {
  writeFileSync(out, md, 'utf8')
  // 用 stdout 输出摘要行，避免 PowerShell 把 stderr 当 NativeCommandError
  console.log(`已写入 ${resolve(out)}`)
  console.log(`会话 ${target.sessionId} · ${frames} 帧 · ${events.length} 事件${damaged.length ? ` · ${damaged.length} 帧损坏` : ''}`)
  console.log(`轮次 ${record.totals.turns} · 工具调用 ${record.totals.toolCalls} · 失败 ${record.totals.failures} · 疑似 ${record.totals.suspects}`)
} else {
  console.log(md)
}
