#!/usr/bin/env node
/**
 * 反向验证：token 校验逻辑必须能抓到"不存在"的 token。
 * 不碰真实 client.js —— 只把校验逻辑喂进一个含坏 token 的样本。
 */
import { readFileSync } from 'node:fs'
import { runtimePackageFile } from './_home.mjs'

// 核对真正在运行的 DSH 的主题包。路径不再写死某台机器：
// 先看开发期 junction（`npm run dev:setup` 建的），再看各 DSH 运行时。
const themePath = runtimePackageFile('dsh-client-ui-theme/lib/client.js')
let themeSrc = null
if (themePath) {
  try {
    themeSrc = readFileSync(themePath, 'utf8')
  } catch {
    themeSrc = null
  }
}
if (!themeSrc) {
  /**
   * 找不到主题包就**跳过**，而不是判失败。
   *
   * 这个文件验的是"token 校验逻辑能抓到坏 token"，它需要一份**真实**的主题包
   * 当参照物。本仓库零依赖、新克隆没有那个 junction —— 那时判失败，红的原因
   * 跟校验逻辑毫无关系。发布前想强制要求它，设 DSH_REQUIRE_VALIDATOR=1。
   */
  if (process.env.DSH_REQUIRE_VALIDATOR === '1') {
    console.log('❌ 设了 DSH_REQUIRE_VALIDATOR=1，但找不到任何主题包')
    process.exit(1)
  }
  console.log('⏭  跳过：没找到 DSH 主题包（先跑 `npm run dev:setup`）')
  process.exit(0)
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
