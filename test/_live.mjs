#!/usr/bin/env node
/**
 * 判断一个会话是否"可能正在被写入"。
 *
 * 为什么需要这个：三个语义测试（accuracy／usage／step）原来只把 `DSH_SESSION_ID`
 * 那一个会话当成活跃的，其余一律要求与投影缓存**完全相等**。
 * 但同一时刻可能有多个活跃会话 —— 尤其是**子代理会话**和另一个窗口。
 * 新会话的投影缓存还没写进去，于是被判"非活跃必须完全一致" → 必红；
 * 而且失败集合每一轮都在变（缓存一追平就自愈）。这是测试的缺陷，不是插件的。
 *
 * 放宽后的规则：
 *   - 调用方自己的会话，或日志在窗口期内被写过的会话 → 视为**活跃**，允许"我比权威多"；
 *   - 无论活跃与否，**"我比权威少"永远是硬失败** —— 那才指向真正的漏读 bug。
 */
export const LIVE_WINDOW_MS = 180000

export function isLiveSession(entry, now = Date.now(), windowMs = LIVE_WINDOW_MS) {
  if (!entry) return false
  if (entry.sessionId === process.env.DSH_SESSION_ID) return true
  return now - entry.mtimeMs < windowMs
}

/**
 * 把差异分成「硬失败」与「活跃会话竞态偏差」两类。
 * @param {Array<{sessionId:string, live?:boolean, mine:number, auth:number}>} diffs
 */
export function splitDiffs(diffs) {
  const hard = []
  const drift = []
  for (const d of diffs) {
    // 少读永远是 bug：漏了事件，与活跃与否无关
    if (d.mine < d.auth) hard.push({ ...d, kind: '少读（漏了事件）' })
    else if (d.live) drift.push(d)
    else hard.push({ ...d, kind: '非活跃会话必须与权威一致' })
  }
  return { hard, drift }
}
