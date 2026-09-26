#!/usr/bin/env node
/**
 * 反向验证：token 校验逻辑必须能抓到"不存在"的 token。
 * 不碰真实 client.js —— 只把校验逻辑喂进一个含坏 token 的样本。
 */
import { readFileSync } from 'node:fs'

// 核对真正在运行的 DSH 的主题包（这台机器上有两个运行时，先找 Desktop app）
const THEME_CANDIDATES = [
  'E:/tools/dsh-desktop/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  'E:/tools/dsh/runner/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
]
let themeSrc = null
for (const p of THEME_CANDIDATES) {
  try {
    themeSrc = readFileSync(p, 'utf8')
    break
  } catch { /* 试下一个 */ }
}
if (!themeSrc) {
  console.log('❌ 找不到任何主题包')
  process.exit(1)
}
const real = new Set(themeSrc.match(/--dsw-[a-z0-9-]+/g) ?? [])

// 样本：一个好 token + 一个我最初写错、实际不存在的 token
const sample = [
  'const CSS = `',
  '  color: var(--dsw-alias-label-primary);',
  '  background: var(--dsw-alias-text-primary);', // 不存在
  '  /* 注释里的示意写法 --dsw-alias-* 不该被算进来 */',
  '`',
].join('\n')

const code = sample
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

const used = [...new Set(code.match(/--dsw-[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [])]
const missing = used.filter((t) => !real.has(t))

console.log('样本用到的 token :', used.join(', '))
console.log('判定为不存在     :', missing.join(', ') || '(无)')

const ok = missing.length === 1 && missing[0] === '--dsw-alias-text-primary'
console.log(ok ? '✅ 校验逻辑能抓到坏 token，且注释里的通配写法未误报' : '❌ 校验逻辑失效')
process.exit(ok ? 0 : 1)
