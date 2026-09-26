#!/usr/bin/env node
/**
 * 组合验证：确认插件真的会被 DSH 加载。
 *
 * 问题：`desktop` profile 由 Electron 应用独占管理，
 * `dsh --profile desktop --dump-config` 会被直接拒绝：
 *   error: profile "desktop" is managed exclusively by the Electron application
 * 所以没法直接 dump 出真实 profile 的组合结果。
 *
 * 解法：造一个**临时 profile**——复制真实 profile 的配置文件，
 * node_modules 用 junction 复用（不复制），然后用 dsh CLI dump 它。
 * 组合出来的结果与真实 profile 等价，从而在不重启的前提下验证：
 * cordis.patch.yml 是否合法、bundle 是否被识别、插件是否真的进了组合树。
 *
 *   node bin/verify-compose.mjs              验证 desktop（默认）
 *   node bin/verify-compose.mjs --profile web
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(here, '..')
const PKG = 'dsh-agent-worklog'

const argv = process.argv.slice(2)
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}

const DSH_HOME = process.env.DSH_HOME || 'E:\\tools\\dsh'
const PROFILE = val('--profile', process.env.DSH_PROFILE || 'desktop')
const SRC = join(DSH_HOME, 'profiles', PROFILE)
const TMP_NAME = '_composeverify'
const TMP = join(DSH_HOME, 'profiles', TMP_NAME)

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const bad = (s, h) => {
  console.log(`  \x1b[31m✗\x1b[0m ${s}`)
  if (h) console.log(`      \x1b[2m→ ${h}\x1b[0m`)
}

let failed = false

// ---------------------------------------------------------------- 找 dsh CLI
function findDsh() {
  // 优先用 Electron 应用自带的 CLI（与真实运行时同版本）
  const generations = join(process.env.APPDATA || '', 'DSH Desktop', 'host-commands', 'desktop', 'generations')
  if (existsSync(generations)) {
    for (const g of readdirSync(generations)) {
      const c = join(generations, g, 'bin', 'dsh.cmd')
      if (existsSync(c)) return c
    }
  }
  try {
    return execSync('where dsh', { encoding: 'utf8' }).trim().split('\n')[0].trim()
  } catch {
    return null
  }
}

console.log(`插件      : ${PKG}`)
console.log(`源 profile: ${SRC}`)

const dsh = findDsh()
if (!dsh) {
  bad('找不到 dsh CLI')
  process.exit(2)
}
console.log(`dsh CLI   : ${dsh}`)

// ---------------------------------------------------------------- 造临时 profile
console.log('\n=== 1. 造临时 profile（node_modules 用 junction 复用）===')
if (!existsSync(SRC)) {
  bad(`源 profile 不存在: ${SRC}`)
  process.exit(2)
}
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const copied = []
for (const f of ['package.json', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
  if (existsSync(join(SRC, f))) {
    copyFileSync(join(SRC, f), join(TMP, f))
    copied.push(f)
  }
}
ok(`复制配置文件: ${copied.join(', ')}`)

const srcModules = join(SRC, 'node_modules')
if (!existsSync(srcModules)) {
  bad('源 profile 没有 node_modules')
  process.exit(2)
}
try {
  execSync(`cmd /c mklink /J "${join(TMP, 'node_modules')}" "${srcModules}"`, { stdio: 'ignore' })
  ok('node_modules 已 junction 复用（未复制）')
} catch (e) {
  bad('创建 junction 失败', String(e.message))
  process.exit(2)
}

// ---------------------------------------------------------------- dump
console.log('\n=== 2. 用 dsh CLI 组合这个 profile ===')
let out = ''
let code = 0
try {
  out = execSync(`"${dsh}" --profile ${TMP_NAME} --dump-config`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (e) {
  code = e.status ?? 1
  out = String(e.stdout ?? '') + String(e.stderr ?? '')
}
if (code === 0) ok(`组合成功（输出 ${out.split('\n').length} 行）`)
else bad(`组合失败（exit ${code}）`, out.split('\n').slice(-6).join('\n'))

// ---------------------------------------------------------------- 判定
console.log('\n=== 3. 插件是否进入组合树 ===')
const lines = out.split('\n')
const idx = lines.findIndex((l) => l.includes(`# == ${PKG}`))
if (idx === -1) {
  bad(`组合结果里没有 ${PKG}`, '说明 bundle 未被识别，或 cordis.patch.yml 有问题')
  failed = true
} else {
  ok(`找到了插件小节（line ${idx + 1}）`)
  const block = lines.slice(idx, idx + 5)
  block.forEach((l) => console.log(`      ${l}`))
  if (block.some((l) => l.includes(`- id: ${PKG}`))) ok('包含正确的 id 行')
  else {
    bad('缺少 id 行')
    failed = true
  }
  if (block.some((l) => l.includes(`name: ${PKG}`))) ok('包含正确的 name 行')
  else {
    bad('缺少 name 行')
    failed = true
  }
}

// 对照：已知能工作的插件也应出现（作为 sanity check）
console.log('\n=== 4. 对照（已知能工作的插件）===')
for (const known of ['dsh-inline-images', 'dsh-my-guardian']) {
  const has = out.includes(`# == ${known}`)
  if (has) ok(`${known} 也在组合树里（说明组合过程本身正常）`)
  else console.log(`  \x1b[2m·\x1b[0m ${known} 未出现（非本插件问题）`)
}

// 组合过程有无报错字样
console.log('\n=== 5. 组合输出里的错误迹象 ===')
const errLines = lines.filter((l) => /error|cannot find|failed to|throw/i.test(l)).slice(0, 8)
if (errLines.length === 0) ok('没有 error / cannot find 字样')
else {
  console.log(`  \x1b[33m!\x1b[0m 有 ${errLines.length} 行含错误关键词（需人工判断，可能是正常文本）：`)
  errLines.forEach((l) => console.log(`      ${l.trim().slice(0, 140)}`))
}

// ---------------------------------------------------------------- 清理
console.log('\n=== 6. 清理 ===')
try {
  // 先删 junction，再删目录（顺序反了会误删目标内容）
  const nm = join(TMP, 'node_modules')
  if (existsSync(nm)) rmSync(nm, { recursive: false, force: true })
  rmSync(TMP, { recursive: true, force: true })
  ok('临时 profile 已删除')
} catch (e) {
  bad('清理失败，请手动删 ' + TMP, String(e.message))
}
if (existsSync(join(SRC, 'node_modules'))) ok('源 profile 的 node_modules 完好（junction 未造成损坏）')
else {
  bad('源 profile 的 node_modules 不见了！')
  failed = true
}

console.log('\n' + '─'.repeat(52))
if (failed) {
  console.log('\x1b[31m组合验证失败\x1b[0m —— 重启后插件很可能不会加载')
  process.exit(1)
}
console.log('\x1b[32m组合验证通过\x1b[0m —— 插件已进入 DSH 的组合树，重启后应被加载')
process.exit(0)
