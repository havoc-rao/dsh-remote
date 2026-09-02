#!/usr/bin/env node
// dsh-remote — 本地 build + 就地更新产物 CLI（link 部署下的 dsh 动态更新开发环）
//
// 背景：本机产品 profile 把 dsh-remote 声明为 link:/…/dsh-remote，运行中的
// dsh 从 $DSH_HOME/profiles/<p>/node_modules/dsh-remote 读取插件代码。当该
// 安装是「物化拷贝」而非 symlink 时，源码改动不会自动到达运行实例。本 CLI
// 负责把本地 build 产物就地同步进去，让运行中的 dsh 动态吃到新代码：
//
//   ① 本地 build —— lib/*.js 逐个 node --check + check.mjs 框架闸门；
//      --instrument 时用 dsh-code-finder 生成「元素级注入」client.js
//      （产出在 dev-harness/dcf/，仓库 lib/ 永不落注入）。
//   ② 就地更新产物 —— 把 lib/、package.json、cordis.patch.yml、LICENSE
//      同步进每个发现的安装目录（$DSH_HOME/profiles/*/node_modules/dsh-remote
//      与本仓库 dev-harness 沙箱），带 inode 守卫：
//         · symlink 安装 = 已直连源码，自动跳过（天然动态）
//         · 目标与源码同 inode（硬链接拷贝，旧 dev-run 沙箱）→ 拒绝覆写
//   ③ 影响 dsh 动态更新 —— 同步后浏览器半刷新页面即生效（client 每次请求
//      从磁盘读取）；宿主半由 cordis-plugin-hmr 自动热重载（未启用则重启
//      dsh web）。等效命令：dsh update --profile <name> —— package.json 的
//      "build" 脚本就是本 CLI，dsh update 会在 link 检出目录就地跑它。
//
// 用法：
//   node scripts/build.mjs                 # build + 就地更新所有安装
//   node scripts/build.mjs --profile web   # 只更新指定 profile 的安装
//   node scripts/build.mjs --target <dir>  # 额外指定一个安装目录（可重复）
//   node scripts/build.mjs --dry-run       # 只预览，不写任何文件
//   node scripts/build.mjs --no-sync       # 只 build，不同步
//   node scripts/build.mjs --instrument    # 同步注入版 client.js（dcf 可用时）
//   node scripts/build.mjs --help
//
// 退出码：0=成功；1=build 闸门失败或同步出错；2=用法错误。

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VERSION = String(PKG.version || '0.0.0')
const DEV_ROOT = path.join(ROOT, 'dev-harness')
const DCF_OUT = path.join(DEV_ROOT, 'dcf')
const DCF_FLAG = 'data-locatorjs'

// ── 参数 ────────────────────────────────────────────────────────────────────
const opts = { profile: null, targets: [], dryRun: false, sync: true, instrument: false }
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(`dsh-remote build CLI v${VERSION} — 本地 build + 就地更新产物（影响 dsh 动态更新）`)
    console.log('用法：node scripts/build.mjs [--profile <name>] [--target <dir>] [--instrument] [--dry-run] [--no-sync] [--help]')
    process.exit(0)
  } else if (arg === '--dry-run') opts.dryRun = true
  else if (arg === '--no-sync') opts.sync = false
  else if (arg === '--instrument') opts.instrument = true
  else if (arg === '--profile') { opts.profile = process.argv[process.argv.indexOf(arg) + 1]; if (!opts.profile) { console.error('❌ --profile 需要一个 profile 名'); process.exit(2) } }
  else if (arg === '--target') { const t = process.argv[process.argv.indexOf(arg) + 1]; if (!t) { console.error('❌ --target 需要一个目录'); process.exit(2) }; opts.targets.push(path.resolve(t)) }
  else { console.error(`⚠️  忽略未知参数: ${arg}`) }
}

const log = (msg) => console.log(msg)
const fail = (msg) => { console.error(msg); process.exit(1) }

// ── ① 本地 build ─────────────────────────────────────────────────────────────
function buildGate() {
  const files = readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  let bad = 0
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, 'lib', f)], { stdio: 'pipe' })
    } catch {
      bad++
      console.error(`  ✗ lib/${f} 语法检查失败`)
    }
  }
  if (bad) fail(`❌ 本地 build 失败：${bad} 个文件语法错误`)
  log(`  ✓ lib/*.js 语法检查通过（${files.length} 个文件）`)
  try {
    execFileSync(process.execPath, ['check.mjs'], { cwd: ROOT, stdio: 'inherit' })
  } catch {
    fail('❌ check.mjs 框架闸门未通过 — 发布约定：先修到全绿再同步')
  }
  log('  ✓ check.mjs 框架闸门通过')
}

// dsh-code-finder 元素级注入（dev 语义：点击页面元素跳转仓库源码行号）。
// 与 dev-run.sh 同一套逻辑：仓库 lib/ 永不落注入；失败静默降级为原名 client.js。
function instrumentClient() {
  if (!opts.instrument) return null
  const dcfBin = path.join(ROOT, 'node_modules', '.bin', 'dcf')
  if (!existsSync(dcfBin)) {
    log('  ⚠  --instrument：未找到 node_modules/.bin/dcf（未安装 dsh-code-finder），用原名 client.js')
    return null
  }
  try {
    mkdirSync(DEV_ROOT, { recursive: true })
    execFileSync(dcfBin, ['instrument', 'lib', '--write', '--out', DCF_OUT], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: 'pipe',
    })
    const out = path.join(DCF_OUT, 'lib', 'client.js')
    if (!existsSync(out) || !readFileSync(out, 'utf8').includes(DCF_FLAG)) throw new Error('产物缺少 data-locatorjs')
    log(`  ✓ dsh-code-finder：注入版 client.js 已生成（${DCF_OUT}/lib/client.js）`)
    return out
  } catch (e) {
    log(`  ⚠  --instrument：dcf 注入未产生（${String((e && e.message) || e)}），用原名 client.js`)
    return null
  }
}

// ── ② 就地更新产物 ───────────────────────────────────────────────────────────
// 发现安装目录：$DSH_HOME/profiles/*/node_modules/dsh-remote + 沙箱同名位置，
// 外加 /private/tmp 下的 dsh-* 开发实例（如 dsh-verify：仓库内临时验证实例，
// 常见于「cwd=仓库 启动 dsh web --profile web」的开发形态），同样逐个就地更新。
function findInstalls() {
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  if (!homes.includes(path.join(os.homedir(), '.dsh'))) homes.push(path.join(os.homedir(), '.dsh'))
  const sandbox = path.join(ROOT, 'dev-harness', 'harness')
  if (existsSync(sandbox)) homes.push(sandbox)
  // /private/tmp/dsh-*：验证实例的隔离 DSH_HOME（如 dsh-verify）。
  try {
    for (const name of readdirSync('/private/tmp')) {
      if (name.startsWith('dsh-')) homes.push(path.join('/private/tmp', name))
    }
  } catch { /* /private/tmp 不可读时忽略 */ }
  const out = []
  for (const home of homes) {
    const profiles = path.join(home, 'profiles')
    if (!existsSync(profiles)) continue
    for (const name of readdirSync(profiles)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const install = path.join(profiles, name, 'node_modules', 'dsh-remote')
      if (!existsSync(install)) continue
      out.push({ profile: name, install })
    }
  }
  for (const t of opts.targets) out.push({ profile: '(--target)', install: t })
  return out
}

const SRC_ITEMS = ['lib', 'package.json', 'cordis.patch.yml', 'LICENSE']

function syncInstall(entry, instrumented) {
  const { install } = entry
  const label = entry.profile === '(--target)' ? install : `${entry.profile} → ${install}`
  const verb = opts.dryRun ? '将更新' : '已就地更新'
  try {
    if (lstatSync(install).isSymbolicLink()) {
      log(`  · ${label}\n      ↳ symlink 直连源码，本就动态，跳过`)
      return 'live'
    }
    const srcPkg = path.join(ROOT, 'package.json')
    const dstPkg = path.join(install, 'package.json')
    if (existsSync(dstPkg) && statSync(srcPkg, { bigint: true }).ino === statSync(dstPkg, { bigint: true }).ino) {
      console.error(`  ✗ ${label}: 与源码同 inode（硬链接拷入），拒绝覆写以防写穿产品/源文件`)
      return 'refused'
    }
    if (opts.dryRun) {
      if (existsSync(dstPkg)) {
        const oldVer = (() => { try { return JSON.parse(readFileSync(dstPkg, 'utf8')).version || '?' } catch { return '?' } })()
        log(`  · ${label}\n      ↳ ${verb}：${oldVer} → ${VERSION}（lib/ + package.json + cordis.patch.yml + LICENSE）${instrumented ? '，注入版 client.js' : ''}`)
      } else {
        log(`  · ${label}\n      ↳ ${verb}：全新安装（${VERSION}）`)
      }
      return 'ok'
    }
    // 物化拷贝：先 unlink 再写，绝不通过硬链接就地覆写（dev-run.sh 同款教训）。
    for (const item of SRC_ITEMS) rmSync(path.join(install, item), { recursive: true, force: true })
    cpSync(path.join(ROOT, 'lib'), path.join(install, 'lib'), { recursive: true })
    for (const item of ['package.json', 'cordis.patch.yml', 'LICENSE']) {
      cpSync(path.join(ROOT, item), path.join(install, item))
    }
    if (instrumented) cpSync(instrumented, path.join(install, 'lib', 'client.js'))
    // 守卫复查：写完后目标不得与源码同 inode。
    if (statSync(srcPkg, { bigint: true }).ino === statSync(dstPkg, { bigint: true }).ino) {
      console.error(`  ✗ ${label}: 同步后仍与源码同 inode（守卫失败），中止`)
      return 'refused'
    }
    const n = readdirSync(path.join(install, 'lib')).length
    const hasNew = readFileSync(path.join(install, 'lib', 'client.js'), 'utf8').includes('drp-ovl')
    log(`  · ${label}\n      ↳ ${verb}：v${VERSION}（lib/ ${n} 个文件 + 清单 + 补丁）${instrumented ? '，注入版 client.js' : ''}${hasNew ? '；client.js 已含 DSH 风格 dialog' : ''}`)
    return 'ok'
  } catch (e) {
    console.error(`  ✗ ${label}: 同步失败 — ${String((e && e.message) || e)}`)
    return 'failed'
  }
}

// ── ③ 影响 dsh 动态更新：只做提示（文件已就位，机制在运行中的 dsh 一侧）────
function updateHints() {
  log('')
  log('③ dsh 动态更新')
  log('   · 浏览器半：刷新页面即刻生效（client 每次请求从磁盘读取）')
  log('   · 宿主半：cordis-plugin-hmr 监测到文件变化会自动热重载；未启用则重启 dsh web')
  log('   · 等效命令：dsh update --profile <name>（package.json 已声明 "build"=本 CLI）')
}

// ── main ─────────────────────────────────────────────────────────────────────
log(`dsh-remote build CLI v${VERSION}`)
log('')
log('① 本地 build')
buildGate()
const instrumented = instrumentClient()

if (opts.sync) {
  log('')
  log('② 就地更新产物')
  const installs = findInstalls()
  if (!installs.length) {
    log('  ℹ️  未发现 dsh-remote 安装目录（$DSH_HOME/profiles/*/node_modules/dsh-remote）— 无产物可更新')
  } else {
    let refused = 0
    let failed = 0
    for (const entry of installs) {
      if (opts.profile && entry.profile !== opts.profile && entry.profile !== '(--target)') continue
      const r = syncInstall(entry, instrumented)
      if (r === 'refused') refused++
      if (r === 'failed') failed++
      log('')
    }
    if (refused || failed) {
      fail(`❌ 就地更新产物未全部完成（拒绝 ${refused}，失败 ${failed}）— 见上方详情`)
    }
  }
  updateHints()
} else {
  log('')
  log('ℹ️  --no-sync：跳过就地更新，仅完成本地 build')
}

log('')
log('✅ build 完成。')