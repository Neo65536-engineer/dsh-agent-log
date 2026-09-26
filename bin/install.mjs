#!/usr/bin/env node
/**
 * dsh-agent-worklog 安装器 / 回滚器。
 *
 * 设计原则：**默认只做只读预检，绝不动配置。** 必须显式加 --apply 才写入。
 *
 *   node bin/install.mjs                    只做预检（安全，随时可跑）
 *   node bin/install.mjs --apply            备份 → 改 profile → pnpm install
 *   node bin/install.mjs --rollback         从最近一次备份恢复
 *   node bin/install.mjs --profile web      指定 profile（默认取 DSH_PROFILE）
 *   node bin/install.mjs --apply --file     用 file: 协议安装（下载来的包用这个）
 *   node bin/install.mjs --apply --link     用 link: 协议安装（开发检出用这个）
 *   node bin/install.mjs --source-dir <dir> 插件源目录（默认 = 本文件所在目录的上一级）
 *
 * 不传 --link/--file 时自动判定：有 test/ 或 .git 视为开发检出（link:），
 * 否则视为分发包（file:）。
 *
 * 装完必须重启 DSH（当前会话会中断）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-agent-worklog'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d = null) => {
  const i = argv.indexOf(f)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
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

// 备份目录可覆盖。
// 默认放在插件目录下。**测试必须传 --backup-dir 指到自己的沙箱**，
// 否则测试清理时会连带删掉真实安装的备份，导致 --rollback 失效。
// （这个缺陷真的发生过：跑一次 install-check 就把真实备份删了。）
const BACKUP_ROOT = val('--backup-dir', join(PLUGIN_DIR, '.install-backups'))

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
// --home 可指向一个沙箱目录，用于在不碰真实环境的前提下演练安装/回滚。
const DSH_HOME = val('--home', process.env.DSH_HOME || 'E:\\tools\\dsh')
const PROFILE = val('--profile', process.env.DSH_PROFILE || 'desktop')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PROFILE_PKG = join(PROFILE_DIR, 'package.json')

console.log(c.b('dsh-agent-worklog 安装器'))
console.log(`  插件目录 : ${PLUGIN_DIR}`)
console.log(`  DSH home : ${DSH_HOME}`)
console.log(`  profile  : ${PROFILE}  (${PROFILE_DIR})`)
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
  console.log(c.ok('已回滚。需要重启 DSH 才生效。'))
  process.exit(0)
}

// ------------------------------------------------------------------ 预检
console.log(c.b('一、插件本体自检'))

/**
 * 必需文件分两档 —— 因为两种协议真正需要的东西不一样：
 *   - `file:` 只要 **package.json**。pnpm 会把 `files` 白名单里的内容复制进去；
 *     其余文件在源目录里存在与否，对安装结果没有影响（现实里"下载包"就常被清理过）。
 *   - `link:` 还要求 index.js / client.js / cordis.patch.yml / core/* 都在源目录里，
 *     因为 profile 是**直接解析到这个目录**的，缺一个就是运行时炸。
 *
 * 早先这里不分档，于是对一个缺文件的拷贝跑 `--apply --file` 会被预检拦住，
 * 而那个缺失跟这次安装是否成功毫无关系。
 */
const REQUIRED_ALWAYS = ['package.json']
const REQUIRED_FOR_LINK = ['index.js', 'client.js', 'cordis.patch.yml', 'core/session-log.mjs', 'core/collect.mjs', 'core/render.mjs']

for (const rel of REQUIRED_ALWAYS) {
  if (existsSync(join(PLUGIN_DIR, rel))) ok(`${rel}`)
  else fail(`缺少 ${rel}`)
}
if (MODE === 'link') {
  for (const rel of REQUIRED_FOR_LINK) {
    if (existsSync(join(PLUGIN_DIR, rel))) ok(`${rel}`)
    else fail(`缺少 ${rel}`, 'link: 协议下 profile 直接解析这个目录，缺文件会在运行时才炸')
  }
} else {
  const missing = REQUIRED_FOR_LINK.filter((rel) => !existsSync(join(PLUGIN_DIR, rel)))
  if (missing.length) {
    console.log(c.dim(`  · file: 协议：不检查 ${missing.join('、')}（安装时会按 files 白名单复制，源目录无需完整）`))
  }
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

if (!existsSync(PROFILE_DIR)) {
  fail(`profile 目录不存在: ${PROFILE_DIR}`, `可用的 profile: ${existsSync(join(DSH_HOME, 'profiles')) ? readdirSync(join(DSH_HOME, 'profiles')).join(', ') : '(无)'}`)
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
  console.log(`  ${c.b(`node bin/install.mjs --apply${PROFILE !== (process.env.DSH_PROFILE || 'desktop') ? ` --profile ${PROFILE}` : ''}`)}`)
  console.log('')
  console.log(c.warn('注意：安装后必须重启 DSH，当前会话会中断。'))
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
 * pnpm 11 把 `strictDepBuilds` 的默认值翻成了 `true`：只要有依赖带构建脚本而未被
 * 显式批准，`pnpm install` 就以**非 0 退出**（ERR_PNPM_IGNORED_BUILDS）。
 *
 * 这会把我们坑成"配置写对了、pnpm 却报失败 → 自动回滚"的假故障，
 * 而且报错内容（忽略构建脚本）跟"插件装不上"毫无关系，极难归因。
 *
 * 本插件零运行时依赖、自身也没有 postinstall，不需要批准任何构建；
 * 所以在 profile 的 pnpm 配置里显式关掉这个门禁。用**文本追加**而不是 YAML 序列化：
 * profile 的 pnpm-workspace.yaml 里有大段解释性注释，重新序列化会把它们全抹掉。
 * （取键名 `strictDepBuilds`：pnpm 11 的 `allowBuilds` 只是构建允许清单，
 *  这里要关的是"未批准就报错"这个行为本身。）
 */
const PNPM_WS = join(PROFILE_DIR, 'pnpm-workspace.yaml')
let patchedPnpmWs = false
if (existsSync(PNPM_WS)) {
  const txt = readFileSync(PNPM_WS, 'utf8')
  if (!/^\s*strictDepBuilds\s*:/m.test(txt)) {
    writeFileSync(
      PNPM_WS,
      txt.replace(/\s*$/, '') +
        '\n\n# 由 dsh-agent-worklog 安装器写入：pnpm 11 起 strictDepBuilds 默认 true，\n' +
        '# 只要有依赖带构建脚本就非 0 退出（ERR_PNPM_IGNORED_BUILDS），与安装成败无关。\n' +
        '# 本插件零运行时依赖、无 postinstall，无需批准构建。\n' +
        'strictDepBuilds: false\n',
      'utf8',
    )
    patchedPnpmWs = true
  }
}

let backupDir = null
if (!needsChange) {
  console.log(`  ${c.ok('配置已经是目标状态，无需改动')}（幂等，未创建备份）`)
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  backupDir = join(BACKUP_ROOT, stamp)
  mkdirSync(backupDir, { recursive: true })
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
  if (patchedPnpmWs) console.log(`  ${c.ok('写入')} pnpm-workspace.yaml 追加 strictDepBuilds: false`)
}

console.log('')
console.log(`  执行 pnpm install（在 ${PROFILE_DIR}）...`)
try {
  const out = runPnpm('install', PROFILE_DIR)
  console.log('  ' + c.ok('pnpm install 成功'))
  if (out.trim()) console.log(c.dim(out.trim().split('\n').slice(-6).join('\n')))
} catch (e) {
  console.log('  ' + c.bad('pnpm install 失败'))
  console.log(c.dim(String(e.stdout ?? e.message).slice(-1500)))
  console.log('')
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
console.log(c.b('下一步：重启 DSH'))
console.log('  重启后：')
console.log('    1. 对话里可以让模型调用 work_report 工具')
console.log('    2. 右侧边栏「+」里会出现「Agent 工作报告」页签')
console.log('')
console.log('  回滚命令：')
console.log(`    ${c.b('node bin/install.mjs --rollback')}`)
if (backupDir) console.log(`    ${c.dim('（备份在 ' + backupDir + '）')}`)
else console.log(`    ${c.dim('（本次未产生备份——配置本来就已经是目标状态）')}`)
