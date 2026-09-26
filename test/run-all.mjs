#!/usr/bin/env node
/**
 * 跑完**所有**测试文件并汇总。
 *
 * 为什么不是 `a && b && c`：那样第一个失败文件一挂，后面全部不跑，
 * 而命令只显示"失败"——覆盖被静默截断，比单个断言失败更危险（实测踩过：
 * panel-data-check 一红，后面 8 个文件一个都没执行）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'run-all.mjs')
  .sort()

const rows = []
for (const f of files) {
  const t0 = Date.now()
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [join(here, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    code = e.status ?? -1
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }
  const ms = Date.now() - t0
  const m = out.match(/通过\s*(\d+)\s*·\s*失败\s*(\d+)/g)
  const summary = m ? m[m.length - 1] : null
  const fails = [...out.matchAll(/❌\s*(.+)/g)].map((x) => x[1].trim())
  rows.push({ file: f, code, ms, summary, fails })
  console.log(`${code === 0 ? '✅' : '❌'} ${f.padEnd(30)} ${String((ms / 1000).toFixed(1)).padStart(6)}s  ${summary ?? (code === 0 ? 'ok' : '失败')}`)
  for (const x of fails.slice(0, 6)) console.log(`      ❌ ${x}`)
}

const bad = rows.filter((r) => r.code !== 0)
console.log('\n' + '─'.repeat(58))
console.log(`共 ${rows.length} 个测试文件 · 通过 ${rows.length - bad.length} · 失败 ${bad.length}`)
if (bad.length) {
  console.log('失败文件：' + bad.map((b) => b.file).join('、'))
  process.exit(1)
}
