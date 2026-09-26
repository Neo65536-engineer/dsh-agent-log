/**
 * 把《本次 Agent 工作报告》的 Markdown 变成一份**可下载、可打印**的自包含 HTML 文档。
 *
 * 为什么在宿主侧做而不是前端做：
 *   - 报告的结构（表格 / 标题 / 引用）是宿主生成的，转换规则放一起才不会两边漂移；
 *   - 前端只负责"点一下拿到文档"，不引入任何 markdown 依赖。
 *
 * 覆盖的语法就是 render.mjs 实际会产出的那些：标题、表格、无序列表、引用、
 * 粗体、行内代码、分隔线、段落。故意不做通用 markdown —— 不支持的语法会原样保留，
 * 由 test/regression-fixes.mjs 断言"没有漏网的 ## / | 行"来兜住。
 */

import { stamp } from './time.mjs'

const esc = (s) =>
  String(s)
    // C0 控制字符（保留 \t \n \r）：会话日志里可能有 NUL / 半截 ESC，
    // 它们不影响 HTML 结构（< > 已转义，不会被当成标签），但裸 NUL 会破坏
    // 某些查看器与打印链路，ESC 则让源码看起来像乱码。不是在防注入 —— 防注入靠下面两条。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** 行内：先转义，再套用 **粗体** 与 `代码`。 */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l)
const isTableSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l)

/**
 * 把一行表格拆成单元格。
 *
 * 必须按**未转义**的 `|` 切分：render.mjs 的 `cell()` 会把单元格内容里的 `|`
 * 写成 `\|`（命令里的管道是常态）。早先这里无条件 `.split('|')`，
 * 于是一条带管道的命令会被拆成两格，渲染出 `<td>` 比 `<th>` 多的坏行。
 * 实测 40 个会话 428 行受影响。
 */
const cells = (l) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

/** Markdown → HTML 片段。 */
export function markdownToHtml(md) {
  const lines = String(md ?? '').split(/\r?\n/)
  const out = []
  let i = 0
  let listOpen = false
  let quoteOpen = false
  let para = []

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`)
      para = []
    }
  }
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>')
      listOpen = false
    }
  }
  const closeQuote = () => {
    if (quoteOpen) {
      out.push('</blockquote>')
      quoteOpen = false
    }
  }
  const closeAll = () => {
    flushPara()
    closeList()
    closeQuote()
  }

  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      closeAll()
      const body = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // 跳过结束围栏
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    // 表格（必须紧邻一行分隔行）
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeAll()
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>')
      for (const r of rows) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
      out.push('</tbody></table>')
      continue
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      closeAll()
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`)
      i++
      continue
    }

    // 分隔线（注意表格分隔行已在上面处理）
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeAll()
      out.push('<hr>')
      i++
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      closeList()
      if (!quoteOpen) {
        out.push('<blockquote>')
        quoteOpen = true
      }
      out.push(`<p>${inline(line.replace(/^\s*>\s?/, ''))}</p>`)
      i++
      continue
    }
    closeQuote()

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara()
      if (!listOpen) {
        out.push('<ul>')
        listOpen = true
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      i++
      continue
    }
    closeList()

    // 空行 = 段落结束
    if (!line.trim()) {
      flushPara()
      i++
      continue
    }

    para.push(line)
    i++
  }
  closeAll()
  return out.join('\n')
}

const DOC_CSS = `
:root{color-scheme:light dark;}
*{box-sizing:border-box;}
body{margin:0;padding:32px 20px 64px;background:#f6f6f7;color:#1f2328;
  font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;}
main{max-width:920px;margin:0 auto;background:#fff;border:1px solid #e3e5e8;border-radius:10px;
  padding:28px 32px;box-shadow:0 1px 3px rgba(0,0,0,.05);}
h1{font-size:24px;margin:0 0 6px;}
h2{font-size:18px;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid #e3e5e8;}
h3{font-size:15px;margin:18px 0 6px;}
p{margin:8px 0;}
hr{border:none;border-top:1px solid #e3e5e8;margin:20px 0;}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.92em;
  background:#f1f2f4;border-radius:3px;padding:1px 4px;}
pre{background:#f1f2f4;border-radius:6px;padding:10px;overflow:auto;}
pre code{background:none;padding:0;}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:.94em;}
th,td{border:1px solid #e3e5e8;padding:5px 8px;text-align:left;vertical-align:top;}
th{background:#f6f6f7;font-weight:600;}
blockquote{margin:10px 0;padding:2px 12px;border-left:3px solid #d0d3d8;color:#57606a;}
ul{margin:8px 0;padding-left:22px;}
li{margin:3px 0;}
footer{max-width:920px;margin:14px auto 0;color:#57606a;font-size:12px;text-align:center;}
@media (prefers-color-scheme:dark){
  body{background:#14171a;color:#e6e8ea;}
  main{background:#1c2024;border-color:#2c3238;box-shadow:none;}
  h2{border-color:#2c3238;}
  th,td{border-color:#2c3238;}
  th{background:#22272c;}
  code,pre{background:#22272c;}
  blockquote{border-color:#3a4148;color:#9aa4ae;}
  footer{color:#9aa4ae;}
  hr{border-color:#2c3238;}
}
@media print{
  body{background:#fff;padding:0;}
  main{border:none;box-shadow:none;max-width:none;padding:0;}
  h2{page-break-after:avoid;}
  table,pre,blockquote{page-break-inside:avoid;}
}
.wl-stale{background:#fff8e1;border:1px solid #f0c36d;border-radius:6px;
  padding:10px 12px;margin:0 0 18px;color:#6b4b00;font-size:.95em;}
.wl-stale strong{color:#8a5a00;}
@media (prefers-color-scheme:dark){
  .wl-stale{background:#3a2f12;border-color:#6b5518;color:#f0d9a0;}
  .wl-stale strong{color:#ffd479;}
}
@media print{
  .wl-stale{background:#fff;border:1px dashed #8a5a00;color:#000;}
}
`

/** 自包含 HTML 文档（内联样式，无外部依赖，可直接打开或打印成 PDF）。 */
export function reportDocument(markdown, meta = {}) {
  const title = '本次 Agent 工作报告'
  const sid = meta.sessionId ?? ''
  const gen = stamp(meta.generatedAt ?? Date.now())

  /**
   * 陈旧模块横幅。
   *
   * 为什么必须有：宿主内存里的插件模块**不会**因为磁盘文件被编辑而重新 import。
   * 早先这条警告只加在 markdown 文本里，而 HTML 与 JSON 两条路径完全没有提示 ——
   * 实测踩过：改了包名后生成 HTML 报告，页脚仍是旧名，而文档里没有任何说明，
   * 看报告的人无从判断"这份报告是新代码还是旧代码产出的"。
   */
  const staleHtml = meta.stale
    ? `<aside class="wl-stale"><strong>⚠️ 宿主加载的是旧版插件模块</strong>（加载于 ${esc(stamp(meta.loadedAt ?? Date.now()))}），` +
      `磁盘上有更新的文件：${esc((meta.newer ?? []).join('、') || '（未列出）')}。` +
      `本报告的数字与文案可能与你当前的源码不符 —— <strong>请重启 DSH</strong> 后再生成。</aside>\n`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}${sid ? ` · ${esc(sid)}` : ''}</title>
<style>${DOC_CSS}</style>
</head>
<body>
<main>
${staleHtml}${markdownToHtml(markdown)}
</main>
<footer>本报告由 dsh-agent-log 从 DSH 会话日志（只读）自动生成 · 生成时间 ${esc(gen)}${sid ? ` · 会话 ${esc(sid)}` : ''}</footer>
</body>
</html>
`
}
