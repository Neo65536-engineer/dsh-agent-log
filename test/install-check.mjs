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
  writeFileSync(join(PROFILE_DIR, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  return { HOME, PROFILE_DIR, PROFILE_PKG: join(PROFILE_DIR, 'package.json') }
}

// 备份目录必须指到沙箱里。
// 默认的 .install-backups 是**真实安装**用的；测试清理时会把它一并删掉，
// 导致真实的 --rollback 失效。（这个缺陷真的发生过。）
const SANDBOX_BACKUPS = join(sandbox, 'backups')

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

// pnpm 11 门禁：strictDepBuilds 必须被写进 profile 的 pnpm 配置，否则 install 非 0 退出
console.log('\n=== 2c. pnpm 11 的 strictDepBuilds 门禁已被处理 ===')
const wsText = readFileSync(join(A.PROFILE_DIR, 'pnpm-workspace.yaml'), 'utf8')
check('pnpm-workspace.yaml 里有 strictDepBuilds: false', /^\s*strictDepBuilds\s*:\s*false\s*$/m.test(wsText), wsText)
check('原有 pnpm 配置未被破坏（nodeLinker/autoInstallPeers 仍在）',
  /nodeLinker:\s*hoisted/.test(wsText) && /autoInstallPeers:\s*false/.test(wsText))

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
const badHome = join(sandbox, 'no-such-home')
const bad = runInstaller(['--home', badHome, '--profile', 'nope'])
check('profile 不存在时预检失败（非 0）', bad.code !== 0, `code=${bad.code}`)
check('给出可读原因', /profile 目录不存在|profile .* 不存在/.test(bad.stdout),
  String(bad.stdout).slice(-300))

const rbNone = runInstaller(['--home', join(sandbox, 'empty-home'), '--profile', 'x', '--rollback'])
check('没有备份时回滚安全失败', rbNone.code !== 0 || /没有找到任何备份/.test(rbNone.stdout),
  `code=${rbNone.code}`)

// ---------------------------------------------------------------- 清理
rmSync(sandbox, { recursive: true, force: true })
check('沙箱已清理', !existsSync(sandbox))
check('真实备份目录未被测试触碰', existsSync(join(PLUGIN_DIR, '.install-backups')))

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
