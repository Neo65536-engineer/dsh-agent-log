#!/usr/bin/env node
/**
 * 守住安装链路上那几个**会伤到用户**的缺陷。
 *
 * 这一组断言对应一次真实事故：本插件曾在 package.json 里声明
 * `"install": "node bin/install.mjs --apply"` —— 那是 pnpm/npm 的**生命周期钩子**，
 * 于是任何人把本插件当依赖安装时，它都会在**对方机器上**自动执行，而脚本里的
 * 默认目标是写死的 `E:\tools\dsh` / `desktop`。实测后果有两个：
 *   1. 它把作者机器上正在使用的 desktop profile 的依赖改指到了一个临时目录，
 *      而用户真正想装的 profile 根本没装上；
 *   2. 脚本一旦非 0 退出，pnpm 会以 ELIFECYCLE 让**整个安装失败**。
 *
 * 而且这一切的起因只是为了让 pnpm 11 的 `strictDepBuilds` 门禁不报错 ——
 * 安装器当时还顺手往用户 profile 的 pnpm-workspace.yaml 里写了
 * `strictDepBuilds: false`，等于拿用户的一道供应链门禁去绕开自己的缺陷。
 *
 * 所以这里逐条钉死：
 *   A. package.json 不得有 install/preinstall/postinstall/prepare 钩子
 *   B. 被当生命周期脚本执行时必须立刻退出 0，且什么都不改
 *   C. 代码里不得把某台机器的绝对路径当默认值
 *   D. 推断不出 profile 时必须报错并给候选，绝不猜一个
 *   E. 安装器不得修改 profile 的 pnpm 配置
 */
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const INSTALLER = join(root, 'bin', 'install.mjs')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${extra}`)
  }
}

/**
 * 跑安装器；返回 { code, out }（不抛错）。
 * 用 spawnSync 而不是 execFileSync：成功路径也要拿到 stderr ——
 * 生命周期守卫的说明是写到 stderr 的，execFileSync 成功时只返回 stdout，
 * 那样"守卫有没有说话"就永远验不到。
 */
function runInstaller(args, { cwd = root, env = {} } = {}) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  })
  return { code: r.status ?? 1, out: String(r.stdout ?? '') + String(r.stderr ?? '') }
}

// ---------------------------------------------------------------- A. 生命周期钩子
console.log('=== A. package.json 不得挂生命周期钩子 ===')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  check(`scripts.${hook} 不存在`, pkg.scripts?.[hook] === undefined, String(pkg.scripts?.[hook]))
}
check('显式安装入口是 scripts.apply（不会自动触发）',
  typeof pkg.scripts?.apply === 'string' && /install\.mjs --apply/.test(pkg.scripts.apply),
  String(pkg.scripts?.apply))

// ---------------------------------------------------------------- B. 生命周期守卫
console.log('\n=== B. 被当生命周期脚本执行时必须立刻退出且不改任何东西 ===')
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-agent-log-lifecycle-'))
{
  // 造一个"从 node_modules 里被拉起来"的 cwd
  const depCwd = join(sandbox, 'node_modules', 'dsh-agent-log')
  mkdirSync(depCwd, { recursive: true })
  // 一个哨兵 home：如果守卫失效，安装器会往这里写东西
  const sentinelHome = join(sandbox, 'sentinel-home')
  mkdirSync(join(sentinelHome, 'profiles', 'desktop'), { recursive: true })
  const before = readdirSync(join(sentinelHome, 'profiles', 'desktop')).sort()

  const guarded = runInstaller(['--apply', '--home', sentinelHome, '--profile', 'desktop'], {
    cwd: depCwd,
    env: { npm_lifecycle_event: 'install' },
  })
  check('生命周期上下文下退出码为 0（绝不能非 0，否则 pnpm 报 ELIFECYCLE 让整个安装失败）',
    guarded.code === 0, `code=${guarded.code}\n${guarded.out.slice(-400)}`)
  check('打出了"已跳过安装"的说明（不是静默）', /已跳过安装/.test(guarded.out), guarded.out.slice(-200))
  check('没有创建 package.json（真的什么都没改）',
    !existsSync(join(sentinelHome, 'profiles', 'desktop', 'package.json')))
  check('哨兵 profile 目录没有被写入任何东西',
    readdirSync(join(sentinelHome, 'profiles', 'desktop')).sort().join('|') === before.join('|'))

  // 用户显式运行时不能被守卫误伤（npm_lifecycle_event 不是 install）
  const explicit = runInstaller(['--home', sentinelHome, '--profile', 'desktop'], {
    cwd: depCwd,
    env: { npm_lifecycle_event: 'run' },
  })
  check('用户显式运行时守卫不生效（照常做预检）', explicit.code !== 0 || /预检/.test(explicit.out),
    `code=${explicit.code}\n${explicit.out.slice(-300)}`)
}

// ---------------------------------------------------------------- C. 没有机器写死的默认值
console.log('\n=== C. 代码里不得把某台机器的绝对路径当默认值 ===')
{
  const files = ['bin/install.mjs', 'bin/worklog.mjs', 'bin/verify-loaded.mjs', 'bin/verify-compose.mjs', 'bin/dev-setup.mjs']
  const stripped = (rel) =>
    readFileSync(join(root, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
  for (const rel of files) {
    const code = stripped(rel)
    check(`${rel} 里没有绝对路径字面量`, !/[A-Za-z]:[\\/]{1,2}[A-Za-z]/.test(code),
      (code.match(/.{0,40}[A-Za-z]:[\\/]{1,2}[A-Za-z].{0,40}/) ?? [''])[0])
  }
  const installer = readFileSync(INSTALLER, 'utf8')
  check('没有 `DSH_HOME || <绝对路径>` 式默认值', !/process\.env\.DSH_HOME\s*\|\|\s*['"]/.test(installer))
  check("没有 `DSH_PROFILE || 'desktop'` 式默认值", !/process\.env\.DSH_PROFILE\s*\|\|\s*['"]/.test(installer))
  // 测试文件同样不许写死（早先 7 个测试文件都有 `|| 'E:\\tools\\dsh'`）
  const testFiles = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.mjs'))
  const offenders = testFiles.filter((f) => {
    const code = readFileSync(join(root, 'test', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    return (
      /process\.env\.DSH_(HOME|PROFILE_DIR)\s*\|\|\s*['"][A-Za-z]:/.test(code) ||
      // 只在"把它当路径基址用"时才算违规；测试数据里的字符串（如模拟命令行）不算
      /(join|resolve)\(\s*['"][A-Za-z]:[\\/]/.test(code)
    )
  })
  check('测试文件里也没有写死的 DSH home / 输出路径', offenders.length === 0, offenders.join(', '))
}

// ---------------------------------------------------------------- D. 推断不出就不猜
console.log('\n=== D. 推断不出 profile 时必须报错并给候选 ===')
{
  const home = join(sandbox, 'empty-home')
  mkdirSync(join(home, 'profiles'), { recursive: true })

  // 正例：环境里有 $DSH_PROFILE 时按它走，并且在输出里**说明来源**
  const fromEnv = runInstaller(['--home', home], { env: { DSH_PROFILE: 'desktop' } })
  check('$DSH_PROFILE 生效且标注来源', /来自 \$DSH_PROFILE/.test(fromEnv.out), fromEnv.out.slice(0, 400))

  // 反例：既没给 --profile，也没有 $DSH_PROFILE，profile 目录里也没有可用的 —— 必须报错
  const r = runInstaller(['--home', home], { env: { DSH_PROFILE: '', DSH_PROFILE_DIR: '' } })
  check('退出码非 0（不会随便挑一个 profile 装下去）', r.code !== 0, `code=${r.code}`)
  check('说明了"无法确定要安装到哪个 profile"', /无法确定要安装到哪个 profile/.test(r.out), r.out.slice(-400))
  check('给出了 --profile 的提示', /--profile/.test(r.out), r.out.slice(-400))
  check('没有把 desktop 当兜底默认值', !/profile\s*:\s*desktop/.test(r.out), r.out.slice(0, 400))
}

// ---------------------------------------------------------------- E. 不碰 profile 的 pnpm 配置
console.log('\n=== E. 不得修改 profile 的 pnpm 配置 ===')
{
  // 剥掉注释再断言：注释里正**记录**着这段被删掉的历史，不算违规代码。
  const installer = readFileSync(INSTALLER, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  check('不再写 strictDepBuilds', !/strictDepBuilds\s*:\s*false/.test(installer))
  check('不再向 pnpm-workspace.yaml 追加内容', !/writeFileSync\(\s*PNPM_WS/.test(installer))
  check('失败时会提示构建脚本门禁的处置办法（但不代劳）', /ERR_PNPM_IGNORED_BUILDS/.test(installer) && /approve-builds/.test(installer))
}

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
