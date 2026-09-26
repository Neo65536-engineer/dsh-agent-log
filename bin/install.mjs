#!/usr/bin/env node
/**
 * dsh-agent-log 安装器 / 回滚器 —— **只在本机、由人显式调用**。
 *
 * 设计原则：**默认只做只读预检，绝不动配置。** 必须显式加 --apply 才写入。
 *
 *   node bin/install.mjs                      只做预检（安全，随时可跑）
 *   node bin/install.mjs --apply              备份 → 改 profile → pnpm install
 *   node bin/install.mjs --rollback           从**最早**一次备份恢复
 *   node bin/install.mjs --home <dir>         指定 DSH home（默认 $DSH_HOME → ~/.dsh）
 *   node bin/install.mjs --profile <name>     指定 profile（默认自动推断，见「定位」一节）
 *   node bin/install.mjs --apply --file       强制 file: 协议（下载来的包）
 *   node bin/install.mjs --apply --link       强制 link: 协议（开发检出）
 *   node bin/install.mjs --source-dir <dir>   插件源目录（默认 = 本文件所在目录的上一级）
 *
 * ⚠️ **绝不要把本脚本挂到 package.json 的 `scripts.install` 上。**
 *    那是 pnpm/npm 的**生命周期钩子**：任何人把本插件当依赖安装时，它都会在
 *    **对方机器上**自动执行，而它要写的是"本机的某个 profile"。
 *    实测踩过：从 GitHub 安装本插件时，这个钩子把作者机器上正在使用的 desktop
 *    profile 的依赖改指到了一个临时目录 —— 用户完全不知情，而且他自己的目标 profile
 *    根本没被装上。（另一个后果：脚本一旦非 0 退出，pnpm 会以 ELIFECYCLE 让整个安装失败。）
 *    入口处现在有守卫：一旦发现自己是被包管理器当生命周期脚本拉起来的，直接退出 0。
 *
 * 不传 --link/--file 时自动判定：有 test/ 或 .git 视为开发检出（link:），
 * 否则视为分发包（file:）。
 *
 * 装完**不需要**重启 DSH：profile 组合里挂着 HMR，安装会新增 Loader 条目并被热挂载
 * （客户端面板若没出现，刷新一次页面即可）。改**代码**之后才需要重启 —— 宿主模块
 * 不会被 HMR 重新 import。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-agent-log'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}

// ---------------------------------------------------------------- 生命周期守卫
//
// 被 pnpm/npm 当**依赖的生命周期脚本**拉起来时立刻退出：那种上下文里我们既不知道
// 用户想装哪个 profile，也绝不该动任何配置。（见文件头那段说明。）
const LIFECYCLE_EVENTS = ['preinstall', 'install', 'postinstall', 'prepare']
const lifecycleEvent = process.env.npm_lifecycle_event ?? ''
const underNodeModules = /[\\/]node_modules[\\/]/.test(process.cwd())
if (
  LIFECYCLE_EVENTS.includes(lifecycleEvent) &&
  underNodeModules &&
  !argv.includes('--i-am-a-dependency-hook')
) {
  console.error(
    `dsh-agent-log: 本脚本被包管理器当作依赖的生命周期脚本执行（npm_lifecycle_event=${lifecycleEvent}，` +
      `cwd=${process.cwd()}）—— 已跳过安装，没有修改任何配置。\n` +
      `  要安装本插件，请在目标机器上显式运行：node bin/install.mjs --apply`,
  )
  process.exit(0)
}

/**
 * 插件目录 = 本文件所在目录的上一级。
 *
 * 可用 `--source-dir` 覆盖：这样可以把**已经解压好的下载包**装进 profile，
 * 而不必 cd 进去再跑 —— 也让测试能在沙箱里指向一个拷贝出来的包。
 */
const PLUGIN_DIR = resolve(val('--source-dir', join(here, '..')))

const APPLY = has('--apply')
const ROLLBACK = has('--rollback')

/**
 * 依赖来源协议：`link:` 还是 `file:`。
 *
 * 两者的差别不是风格问题，而是**"这份插件是不是一个开发检出"**：
 *   - `link:<dir>` 让 profile 直接解析到插件目录本身 —— 改一行代码立刻生效，
 *     这是开发期想要的；但如果插件目录被删/被挪，连 `pnpm install` 都会直接失败。
 *   - `file:<dir>` 让 pnpm 把插件**复制**进 profile 的 node_modules ——
 *     这正是"下载了一个包"的形态（tarball 解压出来、没有 git、没有测试）。
 *
 * 为什么必须自动分辨：早先这里**硬编码 link:**，于是「下载安装」这条路径
 * 在一个拷贝出来的包上会指向一个不存在的开发目录；而对自己的开发检出用 file:
 * 又会把"改代码即生效"静默换掉（要重新 install 才生效）。
 *
 * 判定依据取 `test/` 与 `.git`：两者只存在于开发检出，而 npm 包发布时会依赖
 * `files` 白名单天然排除它们 —— 用"发布产物一定没有的东西"当信号最稳。
 * 也可以显式覆盖：`--link` / `--file`。
 */
const DEV_MARKERS = ['test', 'test/run-all.mjs']
const isDevCheckout =
  DEV_MARKERS.every((rel) => existsSync(join(PLUGIN_DIR, rel))) || existsSync(join(PLUGIN_DIR, '.git'))

const MODE = has('--file') ? 'file' : has('--link') ? 'link' : isDevCheckout ? 'link' : 'file'

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
}

let problems = 0
let warnings = 0
const fail = (msg, hint) => {
  problems++
  console.log(`  ${c.bad('✗')} ${msg}`)
  if (hint) console.log(`      ${c.dim('→ ' + hint)}`)
}
const warn = (msg, hint) => {
  warnings++
  console.log(`  ${c.warn('!')} ${msg}`)
  if (hint) console.log(`      ${c.dim('→ ' + hint)}`)
}
const ok = (msg) => console.log(`  ${c.ok('✓')} ${msg}`)

// ------------------------------------------------------------------ 定位
//
// **这里不允许出现任何机器写死的路径。**
// 早先的默认值是 `DSH_HOME || 'E:\\tools\\dsh'` 与 `DSH_PROFILE || 'desktop'` ——
// 作者的机器成了所有机器的默认值：在别的机器上它要么写进一个不存在的目录
// （预检失败 → 安装失败），要么写进一个与用户实际在跑的无关 profile。
//
// 现在的规则与 DSH 自身一致：显式参数 → $DSH_HOME → $DSH_PROFILE_DIR/../.. → ~/.dsh，
// 并且必须真的是一个 DSH home（含 profiles/ 或 sessions/）。推断不出来就报错，绝不猜。
function resolveHome(explicit) {
  // 显式 --home 不许静默降级：打错一个字（D:\typo）时，回落到别的 home 会**改错 profile**，
  // 而用户看到的是"预检通过"。回退只对隐式候选有意义 —— 这条规则 bin/worklog.mjs 早就有了。
  if (explicit) {
    const dir = resolve(explicit)
    if (existsSync(join(dir, 'profiles')) || existsSync(join(dir, 'sessions'))) return { dir, from: '--home' }
    fail(
      `--home 指向的目录不像 DSH home：${dir}`,
      '既没有 profiles/ 也没有 sessions/。请检查路径（这里不会替你回落到别的 home，那会改错 profile）',
    )
    return null
  }
  const cands = []
  if (process.env.DSH_HOME?.trim()) cands.push({ dir: process.env.DSH_HOME.trim(), from: '$DSH_HOME' })
  if (process.env.DSH_PROFILE_DIR?.trim()) {
    cands.push({ dir: resolve(process.env.DSH_PROFILE_DIR.trim(), '..', '..'), from: '$DSH_PROFILE_DIR/../..' })
  }
  cands.push({ dir: join(homedir(), '.dsh'), from: '~/.dsh' })
  for (const cand of cands) {
    const dir = resolve(cand.dir)
    if (existsSync(join(dir, 'profiles')) || existsSync(join(dir, 'sessions'))) return { dir, from: cand.from }
  }
  return null
}

/** 列出真正像一个 profile 的目录（有 package.json）。 */
function listProfiles(home) {
  const root = join(home, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => {
    try {
      return statSync(join(root, name)).isDirectory() && existsSync(join(root, name, 'package.json'))
    } catch {
      return false
    }
  })
}

/**
 * profile 推断顺序：显式 → $DSH_PROFILE → 已装着本插件的那个 → 唯一的那个 → desktop。
 * 一个都不成立时返回 name: null，由预检列出候选 —— 绝不替用户猜一个。
 */
function resolveProfile(home, explicit) {
  if (explicit) return { name: explicit, from: '--profile' }
  if (process.env.DSH_PROFILE?.trim()) return { name: process.env.DSH_PROFILE.trim(), from: '$DSH_PROFILE' }
  const names = listProfiles(home)
  const installed = names.filter((name) => {
    try {
      return readFileSync(join(home, 'profiles', name, 'package.json'), 'utf8').includes(`"${PKG_NAME}"`)
    } catch {
      return false
    }
  })
  if (installed.length === 1) return { name: installed[0], from: '已装着本插件的那个 profile' }
  if (names.length === 1) return { name: names[0], from: '唯一的 profile' }
  if (names.includes('desktop')) return { name: 'desktop', from: '存在 desktop profile' }
  return { name: null, from: null, candidates: names }
}

// --home 可指向一个沙箱目录，用于在不碰真实环境的前提下演练安装/回滚。
const HOME_RES = resolveHome(val('--home', null))
// 显式 --home 不合格时**直接退出**：继续走下去会用同一个错路径（下面原来还有一处
// `?? val('--home')` 兜底），而预检照样显示"通过"，用户复制回显命令加 --apply 就写错了地方。
if (val('--home', null) && !HOME_RES) process.exit(2)
const DSH_HOME = HOME_RES?.dir ?? resolve(process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh'))
const PROFILE_RES = resolveProfile(DSH_HOME, val('--profile', null))
const PROFILE = PROFILE_RES.name
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE ?? '.unresolved-profile')
const PROFILE_PKG = join(PROFILE_DIR, 'package.json')

/**
 * 备份目录**跟随 profile**，不跟随插件目录。
 *
 * 早先默认放在插件目录下（`.install-backups`），带来两个真实问题：
 *   1. `file:` 安装时插件目录位于 `<profile>/node_modules/dsh-agent-log`，
 *      下一次 `pnpm install` 就可能把整个 node_modules 重建 —— 备份（唯一的
 *      回滚点）跟着一起消失；
 *   2. 备份天然属于"它改过的那个 profile"，放在插件目录下就变成了跨 profile 共享，
 *      于是"跑一次测试把真实安装的备份删了"这种事才可能发生（实测踩过）。
 * 放进 profile 目录后两者一一对应。测试仍可用 --backup-dir 指到自己的沙箱。
 */
const BACKUP_ROOT = val('--backup-dir', join(PROFILE_DIR, '.dsh-agent-log-backups'))

console.log(c.b('dsh-agent-log 安装器'))
console.log(`  插件目录 : ${PLUGIN_DIR}`)
console.log(
  `  DSH home : ${DSH_HOME}` +
    (HOME_RES ? c.dim(`（来自 ${HOME_RES.from}）`) : c.warn('（没找到，请用 --home 指定）')),
)
console.log(
  `  profile  : ${PROFILE ?? c.bad('(未确定)')}  (${PROFILE_DIR})` +
    (PROFILE_RES.from ? c.dim(`（来自 ${PROFILE_RES.from}）`) : ''),
)
console.log(`  模式     : ${ROLLBACK ? c.warn('回滚') : APPLY ? c.warn('写入') : c.ok('只读预检')}`)
console.log(
  `  依赖协议 : ${c.b(MODE + ':')} ${
    MODE === 'link'
      ? '解析到插件目录本身（开发检出：改代码立即生效）'
      : '复制进 profile 的 node_modules（分发包：源目录可以删）'
  }`,
)
console.log('')

// ------------------------------------------------------------------ 回滚
if (ROLLBACK) {
  const backupRoot = BACKUP_ROOT
  if (!existsSync(backupRoot)) {
    console.log(c.bad('没有找到任何备份目录：' + backupRoot))
    process.exit(2)
  }
  // 取**最早**的那份：那是插件安装之前的状态。
  // （取最新的会指到"上一次 --apply 之前"，而那时插件可能已经装好了，
  //  结果是回滚完插件还在配置里——实测踩过。）
  const dirs = readdirSync(backupRoot).filter((d) => statSync(join(backupRoot, d)).isDirectory()).sort()
  if (!dirs.length) {
    console.log(c.bad('备份目录为空，没有可回滚的状态'))
    process.exit(2)
  }
  const oldest = join(backupRoot, dirs[0])
  console.log(`回滚到插件安装前的状态: ${c.b(oldest)}`)
  if (dirs.length > 1) {
    console.log(c.dim(`（共 ${dirs.length} 份备份，取最早的一份；其余忽略）`))
  }

  let restored = 0
  for (const f of readdirSync(oldest)) {
    if (f === 'target.json') continue
    const dst = join(PROFILE_DIR, f)
    copyFileSync(join(oldest, f), dst)
    console.log(`  ${c.ok('恢复')} ${f}`)
    restored++
  }
  if (!restored) {
    console.log(c.bad('这份备份里没有可恢复的文件'))
    process.exit(2)
  }

  // 回滚完把备份清掉：状态已经还原，留着只会让下一次回滚指错目标。
  rmSync(backupRoot, { recursive: true, force: true })
  console.log(c.dim('已清理备份目录（状态已还原）'))
  console.log('')
  console.log(c.ok('已回滚。刷新一次页面即可（改动 profile 组合会走 HMR）。'))
  process.exit(0)
}

// ------------------------------------------------------------------ 预检
console.log(c.b('一、插件本体自检'))

/**
 * 运行时必需文件 —— **两种协议一视同仁**。
 *
 * 早先这里分两档：`file:` 只查 `package.json`，理由是"pnpm 会按 files 白名单复制，
 * 源目录无需完整"。**那个理由是错的**：`files` 决定的是"装什么"，
 * 它**不会**把源目录里缺失的文件补出来 —— pnpm 复制的是源目录里实际存在的东西，
 * 而装好后的 `node_modules/<pkg>` 是唯一的运行时来源。于是缺 `index.js` 的源目录能一路
 * 走到"已就位"，DSH 启动时 `resolveBundleDir` 找不到 `./cordis.patch.yml`，
 * 这个 bundle 被**静默跳过** —— 正是本项目最忌讳的"装上了、没报错、就是不工作"。
 *
 * 清单本身也漏过一项：`core/period.mjs`（`bin/worklog.mjs` 顶层就 import 它，
 * 缺了它离线 CLI 直接 `ERR_MODULE_NOT_FOUND`，而预检会说"通过"）。
 */
const REQUIRED = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'core/session-log.mjs',
  'core/collect.mjs',
  'core/render.mjs',
  'core/html.mjs',
  'core/period.mjs',
  'core/time.mjs',
]

for (const rel of REQUIRED) {
  if (existsSync(join(PLUGIN_DIR, rel))) ok(`${rel}`)
  else fail(`缺少 ${rel}`, '装好后这是唯一的运行时来源，缺文件不会在安装时暴露，只会在运行时静默失效')
}

let manifest = null
try {
  manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  ok(`package.json 可解析 · name=${manifest.name} v${manifest.version}`)
} catch (e) {
  fail('package.json 无法解析', e.message)
}

if (manifest) {
  if (manifest.name !== PKG_NAME) fail(`包名不是 ${PKG_NAME}（是 ${manifest.name}）`)
  else ok(`包名正确`)

  const patch = manifest.dsh?.bundle?.patch
  if (!patch) fail('dsh.bundle.patch 未声明')
  else if (!existsSync(join(PLUGIN_DIR, patch))) {
    // file: 协议下 patch 缺失会在安装时被 pnpm 按 files 白名单处理，
    // 这里只对 link:（直接解析本目录）判失败。
    if (MODE === 'link') fail(`patch 文件不存在: ${patch}`)
    else warn(`源目录里没有 ${patch}（file: 协议按 files 白名单复制，通常无碍）`)
  } else ok(`bundle patch 存在: ${patch}`)

  if (manifest.dsh?.client?.platform !== 'web') warn('dsh.client.platform 不是 web，侧边栏面板不会加载')
  else ok('dsh.client.platform = web')

  if (!manifest.exports?.['./client']) fail('exports 缺少 "./client"')
  else ok('exports 含 ./client')

  // 运行时依赖应为 0（插件刻意零依赖）
  const deps = Object.keys(manifest.dependencies ?? {})
  if (deps.length) warn(`声明了运行时依赖 ${deps.join(', ')}（本插件设计为零依赖，可能无法解析）`)
  else ok('零运行时依赖（link 安装不需要 node_modules）')
}

// cordis.patch.yml 的 id/name 必须和包名一致
try {
  const patchText = readFileSync(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8')
  if (patchText.includes(PKG_NAME)) ok('cordis.patch.yml 引用了正确的包名')
  else fail('cordis.patch.yml 里没有出现 ' + PKG_NAME)
} catch { /* 上面已报 */ }

console.log('')
console.log(c.b('二、目标 profile 自检'))

if (PROFILE === null) {
  // 推断不出来就说清楚有哪些候选，而不是替用户挑一个（早先这里写死 desktop）。
  const cands = PROFILE_RES.candidates ?? []
  fail(
    '无法确定要安装到哪个 profile',
    cands.length
      ? `候选：${cands.join('、')} —— 用 --profile <名字> 指定`
      : `在 ${join(DSH_HOME, 'profiles')} 下没找到任何 profile，用 --home / --profile 指定`,
  )
} else if (!existsSync(PROFILE_DIR)) {
  fail(
    `profile 目录不存在: ${PROFILE_DIR}`,
    `可用的 profile: ${existsSync(join(DSH_HOME, 'profiles')) ? readdirSync(join(DSH_HOME, 'profiles')).join(', ') : '(无)'}`,
  )
} else {
  ok(`profile 目录存在`)
}

let profilePkg = null
if (existsSync(PROFILE_PKG)) {
  try {
    profilePkg = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'))
    ok(`profile package.json 可解析`)
  } catch (e) {
    fail('profile package.json 无法解析', e.message)
  }
} else {
  fail(`profile package.json 不存在: ${PROFILE_PKG}`)
}

if (profilePkg) {
  const alreadyDep = !!profilePkg.dependencies?.[PKG_NAME]
  const alreadyBundle = (profilePkg.dsh?.profile?.bundles ?? []).includes(PKG_NAME)
  if (alreadyDep && alreadyBundle) warn('看起来已经装过了（依赖与 bundles 都有了）', '重复执行 --apply 是安全的（幂等）')
  else if (alreadyDep || alreadyBundle) warn(`安装状态不一致：dep=${alreadyDep} bundle=${alreadyBundle}`, '--apply 会补齐缺失的一半')
  else ok('尚未安装（依赖与 bundles 都没有）')

  const bundles = profilePkg.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) fail('profile 的 dsh.profile.bundles 不是数组')
  else ok(`当前 bundles 共 ${bundles.length} 个`)
}

console.log('')
console.log(c.b('三、工具链自检'))

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 20) ok(`node ${process.versions.node}`)
else fail(`node ${process.versions.node} 过低（需 ≥20）`)

// pnpm 版本必须和 profile 的 .modules.yaml 记录一致，否则 pnpm 会拒绝操作
/**
 * 在 Windows 上调用 pnpm 有个坑：pnpm 是 .cmd 垫片。
 *   execFileSync('pnpm', ...)    → ENOENT（Windows 不会自动补 .cmd）
 *   execFileSync('pnpm.cmd', ...)→ EINVAL（Node ≥18.20/20.12 出于安全禁止无 shell 执行 .cmd）
 * 所以这里统一用 execSync（走 shell），并且**命令字符串是常量**、不含任何用户输入，
 * 因此不存在参数转义问题。（execFileSync + shell:true 会触发 DEP0190 警告。）
 */
function runPnpm(args, cwd) {
  return execSync(`pnpm ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let pnpmVersion = null
try {
  pnpmVersion = runPnpm('--version').trim()
  ok(`pnpm ${pnpmVersion}`)
} catch (e) {
  fail('找不到 pnpm 或无法执行', `在 PATH 上需要 pnpm；底层错误: ${String(e.message).split('\n')[0]}`)
}

const modulesYaml = join(PROFILE_DIR, 'node_modules', '.modules.yaml')
if (existsSync(modulesYaml)) {
  const text = readFileSync(modulesYaml, 'utf8')
  const m = text.match(/"packageManager"\s*:\s*"pnpm@([^"]+)"/)
  const recorded = m?.[1]
  if (recorded && pnpmVersion) {
    if (recorded === pnpmVersion) ok(`pnpm 版本与 profile 记录一致（${recorded}）`)
    else fail(
      `pnpm 版本不匹配：当前 ${pnpmVersion}，profile 由 pnpm@${recorded} 安装`,
      `先执行 npm i -g pnpm@${recorded}，否则 pnpm 会报 ERR_PNPM_* 各种错`,
    )
  }
  const store = text.match(/"storeDir"\s*:\s*"([^"]+)"/)?.[1]
  if (store) ok(`store 目录: ${store}`)
} else {
  warn('profile 没有 node_modules/.modules.yaml（可能是全新 profile）')
}

const lock = join(PROFILE_DIR, 'pnpm-lock.yaml')
if (existsSync(lock)) ok('pnpm-lock.yaml 存在（回滚时会一起备份）')
else warn('profile 没有 pnpm-lock.yaml')

console.log('')
console.log(c.b('四、数据源自检'))
const sessionsDir = join(DSH_HOME, 'sessions')
if (existsSync(sessionsDir)) {
  let n = 0
  for (const ws of readdirSync(sessionsDir)) {
    const wd = join(sessionsDir, ws)
    if (!statSync(wd).isDirectory()) continue
    n += readdirSync(wd).length
  }
  ok(`sessions 目录可读，共 ${n} 个会话目录`)
} else {
  warn(`sessions 目录不存在: ${sessionsDir}`)
}
if (existsSync(join(DSH_HOME, 'storages', 'session_projcache'))) ok('session_projcache 可读')
else warn('session_projcache 不存在（Token 权威值将不可用，不影响主要功能）')

// ------------------------------------------------------------------ 结论
console.log('')
console.log('─'.repeat(56))
if (problems) {
  console.log(c.bad(`预检发现 ${problems} 个阻塞问题`) + (warnings ? `，另有 ${warnings} 个警告` : ''))
  console.log('请先解决后再执行 --apply。')
  process.exit(1)
}
console.log(c.ok(`预检通过`) + (warnings ? c.warn(`（${warnings} 个警告，不阻塞）`) : ''))

if (!APPLY) {
  console.log('')
  console.log(c.b('这是只读预检，没有修改任何文件。'))
  console.log('确认无误后执行：')
  // 把推断出来的定位原样回显，用户复制即用 —— 不依赖任何默认值。
  const echo = `node bin/install.mjs --apply --home "${DSH_HOME}"${PROFILE ? ` --profile ${PROFILE}` : ''}`
  console.log(`  ${c.b(echo)}`)
  console.log('')
  console.log(c.warn('注意：安装完不需要重启（HMR 会热挂载）；改代码之后才需要重启。'))
  process.exit(0)
}

// ------------------------------------------------------------------ 写入
console.log('')
console.log(c.b('五、开始安装'))

// 依赖：用正斜杠的绝对路径（Windows 的反斜杠在 pnpm 的 spec 里是转义符）。
// 协议由 MODE 决定：link: = 直接解析到插件目录；file: = 复制进 profile。
const sourcePath = PLUGIN_DIR.replace(/\\/g, '/')
const depSpec = `${MODE}:${sourcePath}`
const next = JSON.parse(JSON.stringify(profilePkg))
next.dependencies = next.dependencies ?? {}
next.dependencies[PKG_NAME] = depSpec
next.dsh = next.dsh ?? {}
next.dsh.profile = next.dsh.profile ?? {}
next.dsh.profile.bundles = next.dsh.profile.bundles ?? []
if (!next.dsh.profile.bundles.includes(PKG_NAME)) next.dsh.profile.bundles.push(PKG_NAME)

// 幂等的关键：**只有在真的要改动时才备份**。
// 否则重复 --apply 会新增一份"已安装"状态的备份，把 --rollback 指到错误的目标
// （实测：回滚后插件依然在配置里）。
const desired = JSON.stringify(next, null, 2) + '\n'
const current = JSON.stringify(profilePkg, null, 2) + '\n'
const needsChange = desired !== current

/**
 * 这里**故意不再**去改 profile 的 pnpm 配置。
 *
 * 早先为了让 `pnpm install` 不在 pnpm 11 的 `strictDepBuilds` 门禁上非 0 退出，
 * 安装器会往用户的 `pnpm-workspace.yaml` 里追加一行 `strictDepBuilds: false`。
 * 那个门禁之所以会被触发，真正原因是**本插件自己带了一个 `install` 生命周期脚本**
 * （已删除，见 package.json 与文件头）—— 为了绕开自己的缺陷，却把用户 profile 上
 * 一道供应链门禁给全局关掉了，代价完全不对等。
 *
 * 现在改成：什么都不动；万一 pnpm 仍然因构建脚本非 0 退出，就把原因和动作明确打出来
 * （见下面的失败分支），由用户决定要不要授权。
 */

let backupDir = null
if (!needsChange) {
  console.log(`  ${c.ok('配置已经是目标状态，无需改动')}（幂等，未创建备份）`)
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  backupDir = join(BACKUP_ROOT, stamp)
  mkdirSync(backupDir, { recursive: true })
  // pnpm-lock.yaml 与 pnpm-workspace.yaml 都要备份：pnpm 自己会写它们
  // （例如把未授权的构建脚本记进 allowBuilds），所以它们确实可能被这次安装改动。
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const src = join(PROFILE_DIR, f)
    if (existsSync(src)) {
      copyFileSync(src, join(backupDir, f))
      console.log(`  ${c.ok('备份')} ${f} → ${backupDir}`)
    }
  }
  // 记下这次改的是哪个 profile，回滚时才能还原到对的地方
  writeFileSync(
    join(backupDir, 'target.json'),
    JSON.stringify({ profile: PROFILE, profileDir: PROFILE_DIR, dshHome: DSH_HOME, at: new Date().toISOString() }, null, 2),
    'utf8',
  )

  writeFileSync(PROFILE_PKG, desired, 'utf8')
  console.log(`  ${c.ok('写入')} dependency ${PKG_NAME} = ${depSpec}`)
  console.log(`  ${c.ok('写入')} bundles 追加 ${PKG_NAME}`)
}

console.log('')
console.log(`  执行 pnpm install（在 ${PROFILE_DIR}）...`)
try {
  const out = runPnpm('install', PROFILE_DIR)
  console.log('  ' + c.ok('pnpm install 成功'))
  if (out.trim()) console.log(c.dim(out.trim().split('\n').slice(-6).join('\n')))
} catch (e) {
  const raw = String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.message ?? '')
  console.log('  ' + c.bad('pnpm install 失败'))
  console.log(c.dim(raw.slice(-1500)))
  console.log('')
  /**
   * 构建脚本门禁要给**可操作的**提示，而不是让用户对着 ERR_PNPM_IGNORED_BUILDS 猜。
   * 注意：这里只打印，**不替用户改 profile 的 pnpm 配置**（见上面那段说明）。
   */
  if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/.test(raw)) {
    console.log(c.warn('原因：pnpm 拦下了某个依赖的构建脚本（与"插件装不上"无关）。'))
    console.log(c.dim('  → 本插件自身没有构建脚本，被拦下的是 profile 里的其它依赖。'))
    console.log(c.dim('  → 要在 profile 目录里运行 `pnpm approve-builds` 选择允许哪些；'))
    console.log(c.dim('     或把 pnpm 打印出来的键写进 profile 的 pnpm-workspace.yaml（allowBuilds）。'))
    console.log(c.dim('  → 不处理也不影响本插件：上面的依赖与 bundles 已经写好了。'))
    console.log('')
  }
  // 只有真的改动过配置才有备份可回滚。
  // 早先这里无条件 `readdirSync(backupDir)`：在"配置已是目标状态"（幂等、未建备份）
  // 的分支里 backupDir 是 null，安装失败时回滚逻辑自己抛错，
  // 把真正的 pnpm 报错盖掉 —— 用户看到的是一个莫名其妙的类型错误。
  if (backupDir) {
    console.log(c.warn('自动回滚配置...'))
    for (const f of readdirSync(backupDir)) {
      if (f === 'target.json') continue
      copyFileSync(join(backupDir, f), join(PROFILE_DIR, f))
      console.log(`  恢复 ${f}`)
    }
    console.log(c.ok('已回滚到安装前状态。'))
  } else {
    console.log(c.warn('本次没有改动配置（无需回滚）。'))
  }
  process.exit(1)
}

// ------------------------------------------------------------------ 装后确认
//
// 配置写对了不等于"装上了"：DSH 的 loader 是按 **包名** 从 profile 的
// node_modules 里解析的。只要这一步解析不到，插件在重启后就是静默不加载
// ——没有报错、没有面板、没有工具，最难查的一类失败。
// 所以这里显式确认包名可达，不可达就判失败（而不是打印"安装完成"）。
console.log('')
const installedPkg = join(PROFILE_DIR, 'node_modules', PKG_NAME, 'package.json')
if (existsSync(installedPkg)) {
  let v = '?'
  try {
    v = JSON.parse(readFileSync(installedPkg, 'utf8')).version ?? '?'
  } catch { /* 版本读不出不影响"可达"这个结论 */ }
  console.log(`  ${c.ok('已就位')} ${PROFILE_DIR}\\node_modules\\${PKG_NAME}（v${v}）`)
} else {
  console.log(`  ${c.bad('包名在 profile 里解析不到')}: ${installedPkg}`)
  console.log(c.dim('  DSH 的 loader 按包名解析，这一步失败 = 重启后插件不会加载。'))
  console.log(c.dim(`  检查 profile 的 node_modules 是否有 ${PKG_NAME}，或改用 --link/--file 换一种协议重试。`))
  process.exit(1)
}

console.log('')
console.log('─'.repeat(56))
console.log(c.ok('安装完成。'))
console.log('')
console.log(c.b('下一步：等几秒，然后刷新页面'))
console.log('  装了插件会新增 Loader 条目，HMR 会把它热挂载（实测约 5 秒），**不需要重启**：')
console.log('    1. 对话里可以让模型调用 work_report 工具')
console.log('    2. 右侧边栏「+」里会出现「Agent 工作报告」页签（没出现就刷新一次页面）')
console.log('  只有在你**改了插件代码**之后才需要重启 DSH —— 宿主模块不会被热重载。')
console.log('')
console.log('  回滚命令：')
console.log(`    ${c.b(`node bin/install.mjs --rollback --home "${DSH_HOME}"${PROFILE ? ` --profile ${PROFILE}` : ''}`)}`)
if (backupDir) console.log(`    ${c.dim('（备份在 ' + backupDir + '）')}`)
else console.log(`    ${c.dim('（本次未产生备份——配置本来就已经是目标状态）')}`)
