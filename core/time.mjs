/**
 * 时间戳格式化的**唯一出口**。
 *
 * 为什么必须收拢到一个模块：报告里混用 UTC 与本地时间会自相矛盾。
 * 实测踩过 —— 表头「生成时间」用 `toISOString()`（UTC，且不带时区标注），
 * 而同一份报告的命令表用 `getHours()`（本地），两者差 8 小时；
 * HTML 下载件又用 `toLocaleString()`（本地）。同一份报告内部、以及
 * markdown 与 HTML 之间都对不上，用户第一眼就会以为报告是错的。
 *
 * 现在的规则：
 *   - 面向人的时间**一律本地**；
 *   - 只要精确到秒，就必须带 `(UTC±HH:MM)` 标注，不允许出现"看不出时区的时间"。
 */
const p2 = (n) => String(n).padStart(2, '0')

/** 把一个时间值规整成 Date；无法解析时返回 null。 */
function toDate(t) {
  if (t instanceof Date) return Number.isNaN(t.getTime()) ? null : t
  if (typeof t === 'number') return Number.isNaN(t) ? null : new Date(t)
  if (typeof t === 'string') {
    const d = new Date(t)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/** 本地时区相对 UTC 的偏移，形如 `+08:00` / `-05:00`。 */
export function tzOffset(t = new Date()) {
  const d = toDate(t) ?? new Date()
  const min = -d.getTimezoneOffset()
  const sign = min >= 0 ? '+' : '-'
  const a = Math.abs(min)
  return `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`
}

/** 时间戳 → `HH:MM:SS`（本地）。用于表格里的短时间列。 */
export function hms(t) {
  const d = toDate(t)
  if (!d) return '—'
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/** 时间戳 → `MM-DD HH:MM`（本地）。用于轮次起止。 */
export function mdhm(t) {
  const d = toDate(t)
  if (!d) return '—'
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 时间戳 → `YYYY-MM-DD`（本地）。用于按天聚合与日期比较。 */
export function ymd(t) {
  const d = toDate(t)
  if (!d) return '—'
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * 完整时间戳 → `YYYY-MM-DD HH:MM:SS (UTC+08:00)`（本地）。
 * 面向人的"生成时间/加载时间"一律用它，不允许再出现裸 toISOString()。
 */
export function stamp(t = Date.now()) {
  const d = toDate(t)
  if (!d) return '—'
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} (UTC${tzOffset(d)})`
  )
}

/** 时间戳 → `YYYYMMDDTHHMM`（本地）。用于文件名，跟着用户时钟走。 */
export function fileStamp(t = Date.now()) {
  const d = toDate(t) ?? new Date()
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T` +
    `${p2(d.getHours())}${p2(d.getMinutes())}`
  )
}
