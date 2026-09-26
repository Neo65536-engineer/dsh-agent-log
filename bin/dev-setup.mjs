#!/usr/bin/env node
/**
 * 开发环境 bootstrap：把插件目录的 `node_modules/@deepseek-ai` 链到**真实的 DSH 运行时**。
 *
 * 为什么需要它：`test/offline-check.mjs` 用 DSH 自己的 `assertSupportedJsonSchema`
 * 校验手写 schema —— 那是"schema 合法 ⇒ 插件能注册"的唯一真凭据，不能随便删。
 * 但这份校验器只存在于 DSH 安装里，本仓库零依赖（连 devDependencies 都不声明），
 * 于是**新克隆下来的人**根本没有这个目录，`npm run verify` 必红一项。
 * 早先这件事只写在文档里（"开发期挂一个 junction"），而没有任何脚本去做它 ——
 * 结果就是"clone 下来第一步就失败"。
 *
 *   node bin/dev-setup.mjs                    自动探测并建立链接
 *   node bin/dev-setup.mjs --from <dir>       指定某个 node_modules/@deepseek-ai
 *   node bin/dev-setup.mjs --dry-run          只看会链到哪里，不动文件
 *
 * 链接只是**开发期**为了让测试能调到宿主的校验器；插件运行时完全不需要它。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = resolve(fileURLToPath(import.meta.url), '..', '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}
const DRY = has('--dry-run')

/** DSH home：$DSH_HOME → ~/.dsh（与 DSH 自身的规则一致）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** 一个候选目录必须真的含 dsh-tools 才算数。 */
const looksLikeRuntime = (dir) => existsSync(join(dir, 'dsh-tools', 'package.json'))

function candidates() {
  const out = []
  const explicit = val('--from', null) ?? process.env.DSH_RUNTIME_NODE_MODULES ?? null
  if (explicit) out.push({ dir: explicit, from: '--from / $DSH_RUNTIME_NODE_MODULES' })

  const home = dshHome()
  out.push({ dir: join(home, 'runner', 'node_modules', '@deepseek-ai'), from: '$DSH_HOME/runner' })
  out.push({ dir: join(home, 'node_modules', '@deepseek-ai'), from: '$DSH_HOME' })

  // 各 profile 的 node_modules（hoisted 时 @deepseek-ai 会在这里）
  const profilesRoot = join(home, 'profiles')
  if (existsSync(profilesRoot)) {
    for (const name of readdirSync(profilesRoot)) {
      try {
        if (!statSync(join(profilesRoot, name)).isDirectory()) continue
      } catch {
        continue
      }
      out.push({ dir: join(profilesRoot, name, 'node_modules', '@deepseek-ai'), from: `profile ${name}` })
    }
  }
  return out
}

const linkDir = join(here, 'node_modules')
const linkPath = join(linkDir, '@deepseek-ai')

console.log('dsh-agent-log 开发环境 bootstrap')
console.log(`  插件目录 : ${here}`)
console.log(`  目标链接 : ${linkPath}`)
console.log('')

// 已经链好就直接通过 —— 重复执行必须安全。
if (existsSync(linkPath)) {
  if (looksLikeRuntime(linkPath)) {
    console.log('✓ node_modules/@deepseek-ai 已存在且含 dsh-tools，无需处理。')
    console.log('  现在可以跑：npm run verify')
    process.exit(0)
  }
  console.log('! node_modules/@deepseek-ai 已存在，但里面没有 dsh-tools。')
  console.log('  它可能是上一次指向别处的残留；先删掉再重跑本脚本：')
  console.log(`    ${linkPath}`)
  process.exit(1)
}

const found = candidates().find((c) => looksLikeRuntime(c.dir))
if (!found) {
  console.log('✗ 没找到任何含 @deepseek-ai/dsh-tools 的 DSH 运行时目录。问过这些地方：')
  for (const c of candidates()) console.log(`    [${c.from}] ${c.dir}`)
  console.log('')
  console.log('  用 --from 直接指过去，例如：')
  console.log('    node bin/dev-setup.mjs --from "<DSH 安装目录>/node_modules/@deepseek-ai"')
  console.log('')
  console.log('  注意：这不影响插件本身 —— 只有这个校验器相关的断言会被跳过。')
  process.exit(1)
}

console.log(`找到运行时：${found.dir}`)
console.log(`        来自：${found.from}`)
if (DRY) {
  console.log('')
  console.log('（--dry-run：没有创建任何东西）')
  process.exit(0)
}

mkdirSync(linkDir, { recursive: true })
try {
  // junction 在 Windows 上不需要管理员权限，且能跨盘。
  symlinkSync(found.dir, linkPath, 'junction')
} catch (e) {
  rmSync(linkPath, { recursive: true, force: true })
  try {
    symlinkSync(found.dir, linkPath, 'dir')
  } catch (e2) {
    console.log(`✗ 创建链接失败：${e2.message}`)
    console.log('  可手动创建目录符号链接，或把 DSH 的 @deepseek-ai 目录复制过来。')
    process.exit(1)
  }
}

console.log('')
console.log('✓ 已建立链接。现在可以跑：npm run verify')
console.log('  （这个链接只给测试用；插件运行时不需要它。）')
