#!/usr/bin/env node
/**
 * 测试共用的「这台机器上的 DSH 在哪」。
 *
 * 为什么需要：早先每个测试文件各自写 `process.env.DSH_HOME || 'E:\\tools\\dsh'` ——
 * 作者机器上的路径成了**所有机器**的兜底默认值。平时 $DSH_HOME 都被设着，所以它不执行；
 * 一旦没设（别人的机器、CI、精简过的 shell），测试就会去读一个不存在的目录，
 * 报出来的错还跟测试本身无关。
 *
 * 这里的规则与 DSH 自身一致：`$DSH_HOME` → `$DSH_PROFILE_DIR/../..` → `~/.dsh`。
 * 本模块不写死任何绝对路径。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件根目录（test/ 的上一级）。 */
export const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 候选 DSH home，按优先级排列；去重后返回绝对路径。 */
export function dshHomeCandidates() {
  const out = []
  if (process.env.DSH_HOME?.trim()) out.push(process.env.DSH_HOME.trim())
  if (process.env.DSH_PROFILE_DIR?.trim()) out.push(resolve(process.env.DSH_PROFILE_DIR.trim(), '..', '..'))
  out.push(join(homedir(), '.dsh'))
  return [...new Set(out.map((p) => resolve(p)))]
}

/** 真的像一个 DSH home（含 sessions/）的第一个候选；找不到返回 null。 */
export function detectDshHome() {
  for (const dir of dshHomeCandidates()) {
    if (existsSync(join(dir, 'sessions'))) return dir
  }
  return null
}

/**
 * 测试要用的 DSH home。
 * 定位不到时返回首个候选（而不是抛错）—— 让断言给出可读的失败信息。
 */
export const HOME = detectDshHome() ?? dshHomeCandidates()[0]

/**
 * 在「开发期 junction → 各 DSH 运行时」里找某个 @deepseek-ai 包里的文件。
 *
 * 顺序很重要：`node_modules/@deepseek-ai` 是 `npm run dev:setup` 建的开发期链接，
 * 指向**真正在跑的那个运行时**；它优先于下面按路径猜出来的运行时。
 *
 * @param {string} rel 包内相对路径，例如 `dsh-client-ui-theme/lib/client.js`
 * @returns {string|null} 第一个真实存在的绝对路径
 */
export function runtimePackageFile(rel) {
  const cands = [join(ROOT, 'node_modules', '@deepseek-ai', rel)]
  for (const home of dshHomeCandidates()) {
    cands.push(join(home, 'runner', 'node_modules', '@deepseek-ai', rel))
    cands.push(join(home, 'node_modules', '@deepseek-ai', rel))
    const profiles = join(home, 'profiles')
    if (existsSync(profiles)) {
      for (const name of safeReaddir(profiles)) {
        cands.push(join(profiles, name, 'node_modules', '@deepseek-ai', rel))
      }
    }
  }
  for (const p of cands) {
    if (existsSync(p)) return p
  }
  return null
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
