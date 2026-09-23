// Step2（ADR-0002）传输分派单测：未安装 provider 的非 ssh 传输 fail-safe 拒绝，
// 已注册 provider 的 connect 失败被包装为 transport "X": connect failed
// （Step5c 接线语义），内建 ssh provider 注册后 transport='ssh' 行为与旧路径一致。
//
// 端到端走真实 apply()（沿用 session-routing.test.js 的可观察失败模式：
// 连接目标为不可达地址，断言错误命中“尝试连接的 host”，而非 provider 层报错），
// 因此能证明“没有静默回退 SSH”，也证明 ssh 分支仍走 SshPool 旧路径。
// 风格对齐仓库 test/（node:test，顶层 test()）。运行：node --test test/provider-routing.test.mjs
// 3.1 节 style: machinePoolOf 的 ssh 分支必须与接入 Provider 层之前逐字节等价。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { providerForMachine, providerIds, providerOf, registerProvider } from '../lib/provider.js'

/** Isolated DSH_HOME: one saved machine + one mirror owning it (mirror layout
 *  follows mirrorEntries(): root/<host>-<user>-<port>/<base>/.dsh-remote-meta.json). */
function makeHome(machine) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-provider-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: [machine] }))
  const dir = path.join(root, `${machine.host}-${machine.username || 'root'}-${Number(machine.port) || 22}`, 'mirror')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({
    host: machine.host, port: Number(machine.port) || 22, username: machine.username || 'root',
    remotePath: '/data/mirror',
  }))
  return { home, cwd: dir }
}

/** Minimal ctx: apply() needs effect/get/tools/systemPrompt (webServer/commands optional). */
function makeCtx() {
  const tools = new Map()
  return {
    ctx: {
      effect: () => {},
      get: () => undefined,
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
  }
}

/** A tool-execution context carrying one session's cwd, as the agent loop passes. */
const execFor = (cwd) => ({ agent: { session: { header: { cwd } } } })

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 5000, connectTimeoutMs: 2000,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

/** Load apply() with DSH_HOME pointed at an isolated home (cache-busted like
 *  session-routing.test.js; relative imports share the provider.js singleton,
 *  which is exactly what the ssh-registration idempotency guard exercises). */
async function loadPlugin(home) {
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?route=${Math.random()}`)
  return mod
}

const sshMachine = (over = {}) => ({
  id: 'm-ssh', name: 'sshbox', host: '127.0.0.1', port: 1, username: 'lucas', password: 'pw', ...over,
})

/** Run a rw_* tool in a mirror-owned session; stringified error or null. */
async function runTool(tools, name, args, cwd) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} must be registered`)
  return tool.execute(args, execFor(cwd)).then(() => null, (e) => String(e.message))
}

test('① machinePoolOf: transport=vscode-tunnel 未注册 → 明确拒绝，不静默回退 SSH', async () => {
  const machine = sshMachine({ id: 'm-tunnel', name: 'tunnel', host: '127.0.0.99', port: 1, transport: 'vscode-tunnel' })
  const { home, cwd } = makeHome(machine)
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx()
    await apply(ctx, { ...CONFIG })

    const err = await runTool(tools, 'rw_exec', { command: 'hostname' }, cwd)
    assert.ok(err, 'a non-ssh transport with no provider must be refused, not succeed')
    assert.match(err, /transport "vscode-tunnel": provider not installed/, `got: ${err}`)
    // 拒绝必须发生在任何 SSH 连接尝试之前。
    assert.ok(!/ECONNREFUSED|ETIMEDOUT|handshake|127\.0\.0\.1/.test(err), `must not touch SSH at all: ${err}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('② machinePoolOf: provider 已注册但 connect 失败 → 包装为 transport "X": connect failed（非“未安装”，不连 SSH）', async () => {
  const dispose = registerProvider({
    id: 'vt-registered',
    label: 'VSCode Tunnel',
    // Step5c 起接线真实调用 connect；这里模拟接入层建连失败（非网络类原始错误，
    // 应原样透传为 connect failed 的原因；网络类 → friendlyMessage 的断言见
    // provider-wiring.test.mjs ⑦）。
    connect: async () => { throw new Error('tunnel gateway refused bearer token') },
  })
  try {
    assert.ok(providerIds().includes('vt-registered'), 'scenario precondition: provider installed')
    const machine = sshMachine({ id: 'm-vt', name: 'vt', host: '127.0.0.1', port: 1, transport: 'vt-registered' })
    const { home, cwd } = makeHome(machine)
    try {
      const { apply } = await loadPlugin(home)
      const { ctx, tools } = makeCtx()
      await apply(ctx, { ...CONFIG })

      const err = await runTool(tools, 'rw_exec', { command: 'hostname' }, cwd)
      assert.ok(err, 'a registered provider whose connect fails must be refused')
      assert.match(err, /transport "vt-registered": connect failed: tunnel gateway refused bearer token/, `got: ${err}`)
      assert.ok(!err.includes('provider not installed'), 'the provider IS installed — must say connect failed, not installation')
      assert.ok(!/ECONNREFUSED|ETIMEDOUT|127\.0\.0\.1/.test(err), `must not fall back to SSH: ${err}`)
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  } finally {
    dispose()
  }
})

test('③ apply() 注册内建 ssh provider，且重复 apply()（多实例/热重载）不抛 already-registered', async () => {
  const machine = sshMachine()
  const { home, cwd } = makeHome(machine)
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx()
    await apply(ctx, { ...CONFIG })

    const def = providerOf('ssh')
    assert.ok(def, 'built-in ssh provider must be registered after apply()')
    assert.equal(def.id, 'ssh')
    assert.equal(def.apiVersion, 1)
    assert.equal(def.label, 'SSH')
    assert.equal(typeof def.connect, 'function')
    assert.equal(providerForMachine(machine).transport, 'ssh')
    assert.equal(providerForMachine(machine).def.id, 'ssh')

    // 第二次 apply()（同一 provider.js 单例）不得因“already registered”崩掉。
    const second = makeCtx()
    await apply({ ...ctx, tools: second.ctx.tools }, { ...CONFIG })
    assert.ok(providerOf('ssh'), 'registrations stays in place after re-apply')
    // cwd 只是占位（本测试不触发连接）；重新 apply 后注册表状态不变即可。
    assert.ok(cwd)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('④ transport=ssh 与无 transport（缺省 ssh）走同一条 SshPool 旧路径', async () => {
  const run = async (machine) => {
    const { home, cwd } = makeHome(machine)
    try {
      const { apply } = await loadPlugin(home)
      const { ctx, tools } = makeCtx()
      await apply(ctx, { ...CONFIG })
      const err = await runTool(tools, 'rw_exec', { command: 'hostname' }, cwd)
      assert.ok(err, 'unreachable host must surface an error, not a silent success')
      // SSH 路径：错误必须命中“尝试连接的 host”（SshPool 建连失败命名目标），
      // 而非 provider 层报错（not installed / fs/exec wiring / 空 exec 句柄）。
      assert.match(err, /ECONNREFUSED/, `must be a real SSH connect failure, got: ${err}`)
      assert.match(err, /127\.0\.0\.1/, `must name the SSH target host, got: ${err}`)
      return err
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  }

  const explicit = await run(sshMachine({ transport: 'ssh' }))
  const defaulted = await run(sshMachine({ id: 'm-plain' }))
  // 显式 transport:'ssh' 与缺省记录的表现完全一致 —— 与接入 Provider 层之前等价。
  assert.equal(explicit, defaulted, 'explicit ssh transport must behave byte-identically to a legacy record without transport')
})