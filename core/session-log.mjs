/**
 * DSH 会话日志读取器。
 *
 * 实测格式（DSH 0.1.5-rc.3，formatVersion 3）：
 *   sessions/<workspace-slug>/<sessionId>/session.v3.jsonl.zstd
 *   文件 = N 个**独立 zstd 帧**顺序拼接（不是单帧、也不是长度前缀容器）。
 *   Node 的 zstdDecompressSync 只解第一帧，因此必须按魔数 28 B5 2F FD 切帧。
 *   每帧解出 1..M 行 JSONL，事件信封 = { type, seq, time, data }。
 *
 * 另有 storages/session_projcache/sessions/<id>.json（已折叠的投影缓存），
 * 含 tokenUsage / sessionStats / turnOutline 等聚合值，可作为快速摘要来源。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 把一个多帧 zstd 文件解成事件数组。 */
export function readSessionLog(file) {
  const buf = readFileSync(file)
  const offsets = []
  let i = buf.indexOf(ZSTD_MAGIC, 0)
  while (i !== -1) {
    offsets.push(i)
    i = buf.indexOf(ZSTD_MAGIC, i + 1)
  }
  const events = []
  const damaged = []
  let k = 0
  while (k < offsets.length) {
    // 从这一帧的起点出发，先试**最近的**魔数边界；解不开就并上下一帧再试。
    //
    // 为什么要重试（实测真机缺陷）：zstd 对不可压缩内容用 raw block **原样存储**，
    // 所以"明文里恰好有 28 B5 2F FD"这几个字节会出现在**压缩流内部**，被上面的
    // 魔数扫描当成新帧起点 —— 真帧被切成两段，前半段 `unexpected end of file`、
    // 后半段 `Unsupported frame parameter`，**两段都解不出**。
    // 复现：一帧 18 条事件 → events=0、damaged=2；而整块解一次是好的（24 行）。
    // 后果不是"少几条"，而是报告结论从「任务完成」翻转成「还没有任务轮次」。
    //
    // 本机 55 份真实日志 0/55 命中，所以这是"机制成立、真实数据未命中"；
    // 但只要命中就是静默错到底，不能只靠运气。
    let text = null
    let next = -1
    for (let j = k + 1; j <= offsets.length; j++) {
      const end = j < offsets.length ? offsets[j] : undefined
      try {
        text = zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')
        next = j
        break
      } catch {
        /* 这个边界不对，并上下一帧再试 */
      }
    }
    if (text === null) {
      // 所有边界都解不开：这一帧真的坏了。记下来（调用方必须把它报给用户）。
      damaged.push({ frame: k, offset: offsets[k], error: 'no boundary decodes' })
      k += 1
      continue
    }
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        events.push(JSON.parse(s))
      } catch {
        /* 跨帧残行 / 非 JSON 行：跳过，不致命 */
      }
    }
    k = next
  }
  return { events, frames: offsets.length, damaged }
}

/** DSH home 下所有会话的索引：{ sessionId, workspace, file, bytes, mtimeMs }。 */
export function listSessions(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  const out = []
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    if (!statSync(wsDir).isDirectory()) continue
    for (const sessionId of readdirSync(wsDir)) {
      const dir = join(wsDir, sessionId)
      if (!statSync(dir).isDirectory()) continue
      const log = pickLogFile(dir)
      if (!log) continue
      const file = join(dir, log.name)
      const st = statSync(file)
      out.push({
        sessionId,
        workspace,
        file,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        formatVersion: log.version,
        // 同目录存在多份日志时，这里是全部候选（供诊断）
        allLogs: log.all,
      })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 在一个会话目录里挑出**当前生效**的日志文件。
 *
 * 实测：DSH 升级格式时会保留旧文件，同一目录可能同时存在
 *   session.jsonl.zstd      (format v0，旧，内容不完整)
 *   session.v3.jsonl.zstd   (format v3，当前)
 *   session.v4.jsonl.zstd   (format v4，当前)
 * 若按 readdir 顺序取第一个，会读到**旧的 v0 文件**——静默少算，
 * 实测某会话因此只读出 1/7 的轮次。
 * 因此必须按格式版本号取最高者（无 .vN 视为 v0）。
 */
function pickLogFile(dir) {
  const names = readdirSync(dir).filter((f) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(f))
  if (names.length === 0) return null
  const versionOf = (f) => {
    const m = f.match(/\.v(\d+)\./)
    return m ? Number(m[1]) : 0
  }
  const ranked = [...names].sort((a, b) => versionOf(b) - versionOf(a))
  return { name: ranked[0], version: versionOf(ranked[0]), all: names }
}

/** 读取投影缓存（存在则返回 JSON，否则 null）。 */
export function readProjectionCache(dshHome, sessionId) {
  const f = join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 小工具

export const evType = (e) => e?.type ?? ''
export const evData = (e) => e?.data ?? {}

/** 从 message.content 里抽取纯文本（兼容 tool-result / text / reasoning 块）。 */
export function messageText(message) {
  const parts = []
  const walk = (content) => {
    if (typeof content === 'string') {
      parts.push(content)
      return
    }
    if (Array.isArray(content)) {
      for (const c of content) walk(c)
      return
    }
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') parts.push(content.text)
      if (content.content) walk(content.content)
    }
  }
  walk(message?.content)
  return parts.join('\n')
}

/**
 * 判定一次工具结果是否失败。
 *
 * 权威信号是结果的 data.error（结构化、可靠）。
 * 命令类工具再从文本里读 `[exit code: N]` 兜底，但要小心两类假阳性：
 *   1. Windows 上 `| Select-Object -First N` 会因 broken pipe 让管道非 0 退出；
 *   2. 命令本身成功但 stderr 有噪音（PowerShell 把警告写到 stderr）。
 * 因此非 0 退出在「疑似管道截断」时降级为 suspect，不计入硬失败。
 *
 * @param {object} resultEvent tool/result 事件
 * @param {{command?: string}} [ctx] 对应 tool/call 的上下文
 */
export function toolOutcome(resultEvent, ctx = {}) {
  const err = evData(resultEvent).error
  const text = messageText(evData(resultEvent).message)

  if (err) {
    // ABORTED 多为超时/用户中断，属于真实失败但有独立语义
    return {
      ok: false,
      kind: err.code ?? err.name ?? 'error',
      message: err.message ?? err.name ?? String(err),
      suspect: false,
    }
  }

  const m = text.match(/\[exit code: (\d+)\]/)
  if (m && m[1] !== '0') {
    const cmd = String(ctx.command ?? '')
    const timedOut = /\[timed out after \d+ms\]/i.test(text)
    const truncation = /\|\s*Select-Object\s+-(?:First|Last)\b|\|\s*head\b/i.test(cmd)
    return {
      ok: false,
      kind: timedOut ? 'timeout' : `exit-${m[1]}`,
      message: firstLines(text, 3),
      // 管道截断导致的非 0 退出：标记为疑似，渲染时单列
      suspect: !timedOut && truncation,
      note: !timedOut && truncation ? '命令被 `Select-Object -First/Last` 截断，broken pipe 导致的非 0 退出，不一定是真失败' : undefined,
    }
  }
  return { ok: true, kind: 'ok', message: '' }
}

/**
 * 去掉终端颜色控制码。
 *
 * 为什么必须在源头做：这些预览会原样进入 markdown 报告和面板。
 * 实测踩过——命令失败时把**已经着色过的 stderr** 当预览写进报告：
 *   `... exit-1 ... [38;2;140;140;140mFullName   Length`
 * ESC 字符本身不可见，于是报告里只剩一串 `[38;2;...m` 垃圾；更糟的是
 * `firstLines` 按宽度截断，会把一条序列**从中间切断**，留下半截 `[38;2;`
 * 一直留在输出里。颜色码对人零信息量，直接剥掉。
 *
 * 覆盖 CSI（`ESC [ ... 最终字节`）与 OSC（`ESC ] ... BEL/ST`）两类就够——
 * 终端着色只用这两种。
 */
const ANSI_CSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
/**
 * 半截序列（`ESC[38;2;140;140` 后面没有终止字节）。
 *
 * 为什么会遇到：工具输出本身可能在转义序列中间被截断（进程被杀、输出被切）。
 * 上面两条只匹配**完整**序列，漏掉的半截会原样进报告 —— 人看到一串 `[38;2;140;140`，
 * 而 ESC 不可见，读起来像乱码。这里把残留的 ESC 连同它的参数一起清掉。
 */
const ANSI_LEFTOVER = /\u001b(?:\[[0-9;?]*[ -/]*)?/g

export function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_LEFTOVER, '')
}

export function firstLines(text, n = 2, width = 160) {
  return stripAnsi(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' | ')
    .slice(0, width)
}

export { join as pathJoin }
