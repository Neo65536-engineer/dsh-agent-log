#!/usr/bin/env node
/**
 * 安装器 / 回滚器的端到端演练。
 *
 * 在一个**沙箱 DSH home** 上真的跑一遍 --apply 与 --rollback，
 * 确认配置被正确写入、备份可用、回滚能还原。全程不碰真实的 profiles/desktop。
 *
 * 这里跑**两种来源形态**，因为它们的失败方式完全不同：
 *   - §2 `file:` 协议：插件是「下载解压出来的一份包」——没有 test/、没有 .git。
 *     这是发布后的真实形态，也是**唯一**能验证"源目录可以删"的形态。
 *   - §5 `link:` 协议：插件是「开发检出」，改代码立即生效。
 * 早先安装器只支持 link:，于是"下载安装"这条路从来没被测过。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(here, '..')
const INSTALLER = join(PLUGIN_DIR, 'bin', 'install.mjs')

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

/** 跑安装器，返回 { code, stdout }（不抛错）。 */
function runInstaller(args) {
  try {
    const stdout = execFileSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout }
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-worklog-install-'))

/** 沙箱 profile 的初始 pnpm 配置；最后一个断言会要求它与安装后**逐字节一致**。 */
const WS_BEFORE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

const BEFORE = {
  name: 'dsh-profile-testprofile',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}

/** 造一个干净的沙箱 profile，返回它的路径。 */
function makeHome(tag) {
  const HOME = join(sandbox, tag, 'home')
  const PROFILE_DIR = join(HOME, 'profiles', 'testprofile')
  mkdirSync(PROFILE_DIR, { recursive: true })
  mkdirSync(join(HOME, 'sessions', '--X--'), { recursive: true })
  mkdirSync(join(HOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(join(PROFILE_DIR, 'package.json'), JSON.stringify(BEFORE, null, 2) + '\n', 'utf8')
  writeFileSync(join(PROFILE_DIR, 'pnpm-workspace.yaml'), WS_BEFORE, 'utf8')
  return { HOME, PROFILE_DIR, PROFILE_PKG: join(PROFILE_DIR, 'package.json') }
}

// 备份目录必须指到沙箱里。
// 默认的 .install-backups 是**真实安装**用的；测试清理时会把它一并删掉，
// 导致真实的 --rollback 失效。（这个缺陷真的发生过。）
const SANDBOX_BACKUPS = join(sandbox, 'backups')

// 真实备份目录的**测试前快照**：结尾用它证明"没被测试污染"（见文件末尾）。
// 允许它不存在 —— 幂等安装不建备份，刚装完的检出就是这样。
const realBackupBefore = existsSync(join(PLUGIN_DIR, '.install-backups'))
  ? readdirSync(join(PLUGIN_DIR, '.install-backups')).sort()
  : null

// ================================================================ 形态 A：分发包
// 把插件目录拷贝一份并**去掉 test/ 与 .git**，模拟"下载解压出来的包"。
const dl = join(sandbox, 'downloaded-pkg')
cpSync(PLUGIN_DIR, dl, {
  recursive: true,
  filter: (src) => !/[\\/](\.git|node_modules|\.install-backups|\.checks)([\\/]|$)/.test(src),
})
rmSync(join(dl, 'test'), { recursive: true, force: true })
const dlHasTests = existsSync(join(dl, 'test'))
check('已造出"下载包"形态（没有 test/）', !dlHasTests)

const A = makeHome('A')
const argsA = ['--home', A.HOME, '--profile', 'testprofile', '--source-dir', dl, '--backup-dir', SANDBOX_BACKUPS]

// ---------------------------------------------------------------- 1. 预检
console.log('=== 1. 只读预检不修改任何文件（在沙箱里）===')
const beforeText = readFileSync(A.PROFILE_PKG, 'utf8')
const pre = runInstaller(argsA)
check('预检退出码 0', pre.code === 0, `code=${pre.code}\n${String(pre.stdout).slice(-800)}`)
check('预检输出含「只读预检」', /只读预检/.test(pre.stdout))
check('自动判定为分发包 → 用 file: 协议', /依赖协议 : .*file:/.test(pre.stdout), String(pre.stdout).slice(0, 400))
check('package.json 未被修改', readFileSync(A.PROFILE_PKG, 'utf8') === beforeText)
check('未创建备份目录', !existsSync(SANDBOX_BACKUPS))

// ---------------------------------------------------------------- 2. 安装
console.log('\n=== 2. --apply 真的写入配置（file: 协议）===')
const applied = runInstaller([...argsA, '--apply'])
check('安装退出码 0', applied.code === 0, `code=${applied.code}\n${String(applied.stdout).slice(-900)}`)

const after = JSON.parse(readFileSync(A.PROFILE_PKG, 'utf8'))
check('dependencies 里有插件', typeof after.dependencies?.['dsh-agent-log'] === 'string',
  JSON.stringify(after.dependencies))
check('依赖用的是 file: 协议', String(after.dependencies?.['dsh-agent-log']).startsWith('file:'),
  String(after.dependencies?.['dsh-agent-log']))
check('路径用正斜杠', !String(after.dependencies?.['dsh-agent-log']).includes('\\\\'),
  String(after.dependencies?.['dsh-agent-log']))
check('bundles 里追加了插件', (after.dsh?.profile?.bundles ?? []).includes('dsh-agent-log'),
  JSON.stringify(after.dsh?.profile?.bundles))
check('原有 bundle 保留', (after.dsh?.profile?.bundles ?? []).includes('@deepseek-ai/dsh-base'))
check('原有字段保留（name/private）', after.name === BEFORE.name && after.private === true)

// 真正装上了吗 —— loader 按包名解析，这一步才是"装上"的定义
const installedPkg = join(A.PROFILE_DIR, 'node_modules', 'dsh-agent-log', 'package.json')
check('profile 里能按包名解析到插件', existsSync(installedPkg), installedPkg)
check('安装器自己报告了「已就位」', /已就位/.test(applied.stdout))
if (existsSync(installedPkg)) {
  const ip = JSON.parse(readFileSync(installedPkg, 'utf8'))
  check('装进去的是插件的 package.json', ip.name === 'dsh-agent-log', String(ip.name))
}

// 备份
check('创建了沙箱备份目录', existsSync(SANDBOX_BACKUPS))
check('真实备份目录未被触碰', !existsSync(join(PLUGIN_DIR, '.install-backups')) ||
  readdirSync(join(PLUGIN_DIR, '.install-backups')).every((d) => !d.includes('testprofile')))
const backups = existsSync(SANDBOX_BACKUPS) ? readdirSync(SANDBOX_BACKUPS) : []
check('备份里有 package.json', backups.length > 0 &&
  existsSync(join(SANDBOX_BACKUPS, backups[0], 'package.json')), JSON.stringify(backups))
const backupText = backups.length ? readFileSync(join(SANDBOX_BACKUPS, backups[0], 'package.json'), 'utf8') : ''
check('备份内容 = 安装前的原文', backupText === beforeText)

// ---------------------------------------------------------------- 2b. 源目录消失
console.log('\n=== 2b. 源目录被删掉后，插件依然可用（这是 file: 的意义）===')
const dlMoved = join(sandbox, 'downloaded-pkg-moved-away')
rmSync(dlMoved, { recursive: true, force: true })
// rename 而不是 copy：profile 里记的还是**旧路径**，所以这同时构造了
// 「配置指向一个已经不存在的目录」这个真实场景。
rmSync(dl, { recursive: true, force: true, maxRetries: 3 })
check('源目录已删除', !existsSync(dl))
check('profile 里的插件仍在', existsSync(installedPkg))
check('仍能跑离线 CLI（真正加载了包）', (() => {
  try {
    const out = execFileSync(process.execPath, [join(A.PROFILE_DIR, 'node_modules', 'dsh-agent-log', 'bin', 'worklog.mjs'), '--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: A.HOME },
    })
    return /worklog|报告|用法|usage/i.test(out)
  } catch (e) {
    // --help 可能以非 0 退出，只要有可读输出就算加载成功
    return /worklog|报告|用法|usage/i.test(String(e.stdout ?? '') + String(e.stderr ?? ''))
  }
})(), 'CLI 未能加载')

// ---------------------------------------------------------------- 2c. 不得改 pnpm 配置
//
// 早先为了让 pnpm 11 的 `strictDepBuilds` 门禁不把 `pnpm install` 弄成非 0 退出，
// 安装器会往 profile 的 pnpm-workspace.yaml 里追加 `strictDepBuilds: false`。
// 那个门禁之所以会被触发，真正原因是**本插件自己带了一个 install 生命周期脚本**；
// 为了绕开自己的缺陷，却把用户 profile 上的一道供应链门禁全局关掉，代价完全不对等。
// 缺陷已删（见 package.json），这个副作用也必须一起消失 —— 所以现在这里断言**没动过**。
console.log('\n=== 2c. 不得擅自修改 profile 的 pnpm 配置 ===')
const wsText = readFileSync(join(A.PROFILE_DIR, 'pnpm-workspace.yaml'), 'utf8')
check('pnpm-workspace.yaml 逐字节未被改动', wsText === WS_BEFORE, JSON.stringify(wsText))
check('没有写入 strictDepBuilds', !/strictDepBuilds/.test(wsText))
check('原有 pnpm 配置仍在（nodeLinker/autoInstallPeers）',
  /nodeLinker:\s*hoisted/.test(wsText) && /autoInstallPeers:\s*false/.test(wsText))

// ---------------------------------------------------------------- 2d. 备份目录位置
//
// 备份是**唯一的回滚点**，所以它不能放在会被 pnpm 重建的地方。
// 早先默认放在插件目录（`.install-backups`）：`file:` 安装时插件目录就在
// `<profile>/node_modules/` 里，下一次 `pnpm install` 就可能连备份一起重建掉。
// 现在默认放进 profile 目录，与"它改过的那个 profile"一一对应。
console.log('\n=== 2d. 备份目录默认落在 profile 里 ===')
const C = makeHome('C')
const appliedC = runInstaller(['--home', C.HOME, '--profile', 'testprofile', '--source-dir', PLUGIN_DIR, '--link', '--apply'])
check('安装退出码 0', appliedC.code === 0, `code=${appliedC.code}\n${String(appliedC.stdout).slice(-600)}`)
const cBackupRoot = join(C.PROFILE_DIR, '.dsh-agent-log-backups')
check('默认备份目录在 profile 内', existsSync(cBackupRoot), cBackupRoot)
const cBackups = existsSync(cBackupRoot) ? readdirSync(cBackupRoot) : []
check('备份里有 package.json（回滚要用）',
  cBackups.length > 0 && existsSync(join(cBackupRoot, cBackups[0], 'package.json')), JSON.stringify(cBackups))
check('备份里有 target.json（记着改的是哪个 profile）',
  cBackups.length > 0 && existsSync(join(cBackupRoot, cBackups[0], 'target.json')), JSON.stringify(cBackups))

// ---------------------------------------------------------------- 3. 幂等
console.log('\n=== 3. 重复 --apply 是幂等的 ===')
// 这次先重建源目录（内容与原来一致，路径也一致）→ 应当判定"无需改动"
cpSync(PLUGIN_DIR, dl, {
  recursive: true,
  filter: (src) => !/[\\/](\.git|node_modules|\.install-backups|\.checks)([\\/]|$)/.test(src),
})
rmSync(join(dl, 'test'), { recursive: true, force: true })
const argsA2 = ['--home', A.HOME, '--profile', 'testprofile', '--source-dir', dl, '--backup-dir', SANDBOX_BACKUPS]
const backupCountBefore = existsSync(SANDBOX_BACKUPS) ? readdirSync(SANDBOX_BACKUPS).length : 0
const again = runInstaller([...argsA2, '--apply'])
check('再次安装退出码 0', again.code === 0, `code=${again.code}\n${String(again.stdout).slice(-900)}`)
const after2 = JSON.parse(readFileSync(A.PROFILE_PKG, 'utf8'))
const depNow = String(after2.dependencies?.['dsh-agent-log'] ?? '')
check('依赖协议仍是 file:', depNow.startsWith('file:'), depNow)
check('bundles 里没有重复项',
  (after2.dsh?.profile?.bundles ?? []).filter((b) => b === 'dsh-agent-log').length === 1,
  JSON.stringify(after2.dsh?.profile?.bundles))
check('真的幂等：配置无变化、不新增备份',
  readdirSync(SANDBOX_BACKUPS).length === backupCountBefore && /无需改动|已经装过/.test(again.stdout),
  `备份 ${backupCountBefore} → ${readdirSync(SANDBOX_BACKUPS).length}\n${String(again.stdout).slice(-400)}`)

// ---------------------------------------------------------------- 4. 回滚
console.log('\n=== 4. --rollback 还原 ===')
const rb = runInstaller([...argsA, '--rollback'])
check('回滚退出码 0', rb.code === 0, `code=${rb.code}`)
const restored = readFileSync(A.PROFILE_PKG, 'utf8')
check('package.json 与安装前逐字节一致', restored === beforeText)
const restoredObj = JSON.parse(restored)
check('依赖已移除', !restoredObj.dependencies?.['dsh-agent-log'])
check('bundles 已还原', !(restoredObj.dsh?.profile?.bundles ?? []).includes('dsh-agent-log'))
check('回滚后清理了沙箱备份', !existsSync(SANDBOX_BACKUPS))

// ================================================================ 形态 B：开发检出（link:）
console.log('\n=== 5. 开发检出自动用 link: 协议 ===')
const B = makeHome('B')
const argsB = ['--home', B.HOME, '--profile', 'testprofile', '--source-dir', PLUGIN_DIR, '--backup-dir', join(sandbox, 'backupsB')]
const preB = runInstaller(argsB)
check('开发检出预检退出码 0', preB.code === 0, `code=${preB.code}`)
check('自动判定为开发检出 → 用 link: 协议', /依赖协议 : .*link:/.test(preB.stdout), String(preB.stdout).slice(0, 400))
const appliedB = runInstaller([...argsB, '--apply'])
check('link: 安装退出码 0', appliedB.code === 0, `code=${appliedB.code}\n${String(appliedB.stdout).slice(-800)}`)
const afterB = JSON.parse(readFileSync(B.PROFILE_PKG, 'utf8'))
check('依赖用的是 link: 协议', String(afterB.dependencies?.['dsh-agent-log']).startsWith('link:'),
  String(afterB.dependencies?.['dsh-agent-log']))
check('link: 也报告了「已就位」', /已就位/.test(appliedB.stdout))

// 显式 --file 覆盖自动判定
const appliedB2 = runInstaller([...argsB, '--apply', '--file'])
check('--file 能覆盖自动判定', appliedB2.code === 0, `code=${appliedB2.code}`)
check('覆盖后依赖变成 file:', String(JSON.parse(readFileSync(B.PROFILE_PKG, 'utf8')).dependencies?.['dsh-agent-log']).startsWith('file:'),
  String(JSON.parse(readFileSync(B.PROFILE_PKG, 'utf8')).dependencies?.['dsh-agent-log']))

// ---------------------------------------------------------------- 6. 异常路径
console.log('\n=== 6. 异常路径 ===')

// 6a 显式 --home 不合格：必须**直接失败且不回退**。
// 这条断言原来写的是「回退到真实 home 之后再报 profile 不存在」——那正是被修掉的行为：
// 用户打错一个字，安装器会去改**另一个** profile，而预检照样显示"通过"。
// 同一个缺陷也污染过本文件下面的回滚用例（`--home <沙箱>/empty-home` 其实不存在，
// 于是它静默回退到真实 $DSH_HOME 去跑 —— 测试自己都没意识到跑出了沙箱）。
const badHome = join(sandbox, 'no-such-home')
const bad = runInstaller(['--home', badHome, '--profile', 'nope'])
check('--home 不合格时预检失败（非 0）', bad.code !== 0, `code=${bad.code}`)
check('说明是 --home 的问题，并明确不会回退到别的 home',
  /--home 指向的目录不像 DSH home/.test(bad.stdout) && /不会替你回落/.test(bad.stdout),
  String(bad.stdout).slice(-300))
check('确实没有回退（输出里不该出现真实 home 的 profile 推断）',
  !/已装着本插件的那个 profile|唯一的 profile|来自 \$DSH_HOME/.test(bad.stdout),
  String(bad.stdout).slice(-300))

// 6b home 合格但 profile 不存在：预检失败并给出可读原因
const goodEmptyHome = join(sandbox, 'empty-home')
mkdirSync(join(goodEmptyHome, 'profiles'), { recursive: true })
const badProfile = runInstaller(['--home', goodEmptyHome, '--profile', 'nope'])
check('profile 不存在时预检失败（非 0）', badProfile.code !== 0, `code=${badProfile.code}`)
check('给出可读原因', /profile 目录不存在|profile .* 不存在/.test(badProfile.stdout),
  String(badProfile.stdout).slice(-300))

// 6c 源目录缺运行时文件：**两种协议都必须拦住**。
// 早先 file: 分支故意跳过这个检查，理由注释是「pnpm 会按 files 白名单复制，源目录无需完整」——
// 那个理由是错的：files 决定"装什么"，不会把源目录里缺失的文件补出来；装好后的
// node_modules/<pkg> 才是唯一运行时来源。于是缺 index.js 的包能一路走到「已就位」，
// 而 DSH 启动时静默跳过这个 bundle —— 正是本项目最忌讳的"装上了、没报错、就是不工作"。
// core/period.mjs 则是清单本身漏掉的一项（bin/worklog.mjs 顶层 import 它）。
const broken = join(sandbox, 'broken-pkg')
cpSync(dl, broken, { recursive: true })
rmSync(join(broken, 'index.js'))
rmSync(join(broken, 'core', 'period.mjs'))
const pkgBeforeBroken = readFileSync(A.PROFILE_PKG, 'utf8')
const brokenPre = runInstaller(['--home', A.HOME, '--profile', 'testprofile', '--source-dir', broken])
check('缺 index.js 时预检失败（file: 协议一样拦）', brokenPre.code !== 0, `code=${brokenPre.code}`)
check('点名缺了 index.js', /缺少 index\.js/.test(brokenPre.stdout), String(brokenPre.stdout).slice(-400))
check('也点名缺了 core/period.mjs', /缺少 core[\\/]period\.mjs/.test(brokenPre.stdout),
  String(brokenPre.stdout).slice(-400))
check('拦下之后 profile 配置一个字节都没动',
  readFileSync(A.PROFILE_PKG, 'utf8') === pkgBeforeBroken)

const rbNone = runInstaller(['--home', join(sandbox, 'empty-home'), '--profile', 'x', '--rollback'])
check('没有备份时回滚安全失败', rbNone.code !== 0 || /没有找到任何备份/.test(rbNone.stdout),
  `code=${rbNone.code}`)

// ---------------------------------------------------------------- 清理
rmSync(sandbox, { recursive: true, force: true })
check('沙箱已清理', !existsSync(sandbox))

/**
 * 真实备份目录的护栏：**本次测试没有添乱**。
 *
 * 早先这里断言的是"真实备份目录存在"——那是错的：
 * 安装器是幂等的，"配置已是目标状态"时**本来就不建备份**。
 * 一次刚装完（或从未装过）的检出跑这个测试就必红，而它红的原因跟测试质量毫无关系。
 * 实测踩过：目录改名后重跑，唯一变红的就是这一条。
 *
 * 正确语义是"没被测试污染"，所以比对测试**前后**的快照：
 * 条目没多也没少。这样无论备份目录存不存在都成立。
 */
const realBackupRoot = join(PLUGIN_DIR, '.install-backups')
const listReal = () => (existsSync(realBackupRoot) ? readdirSync(realBackupRoot).sort() : null)
const realAfter = listReal()
const sameAsBefore =
  realAfter === null
    ? realBackupBefore === null
    : realBackupBefore !== null && realAfter.join('|') === realBackupBefore.join('|')
check(
  `真实备份目录未被测试触碰${realAfter === null ? '（本机当前没有备份目录，记为未创建）' : ''}`,
  sameAsBefore,
  `before=${JSON.stringify(realBackupBefore)} after=${JSON.stringify(realAfter)}`,
)

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
