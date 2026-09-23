// Step5c 单测：machinePoolOf 对已注册非 ssh provider（vscode-tunnel）的真实接线。
// 全部走真实 apply() + registerProvider 注入的 fake provider（不连网络、不碰 ssh2、
// 不触 OS keychain）：用 rw_exec / rw_search 工具驱动 machinePoolOf（工具 → bindingFor
// → poolForMachine → machinePoolOf → connectMachine → provider.connect），fake connect
// 记录调用/凭据，fake 句柄带 SSH 兼容表面（fs/exec/jobs/sftp/platform/client/invalidate/
// close/identity/capabilities/status，见委派任务书背景）。断言：句柄透传（identity
// 标记经真实工具栈到达输出）、credentialResolver 收到明文密码 或 tunnel.secret、
// 同 machineId 缓存命中（connect 只调一次）、未注册仍抛 provider not installed、
// TTL 过期 close 旧句柄并重建、插件卸载 close 句柄、建连失败不落缓存且网络类错误
// friendlyMessage 可读。运行：node --test test/provider-wiring.test.mjs
// 风格对齐仓库 test/（node:test + node:assert/strict，顶层 test()）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { registerProvider } from '../lib/provider.js'

/** 隔离 DSH_HOME：一台已存机器（machines.json）+ 归属它的 mirror。
 *  tunnel 机器用 43127 本地转发端口（task 背景允许的两种形态之一）：mirrorEntries
 *  要求 meta 端口 1..65535，且 bindingFor → machineByTarget 必须命中已存记录，
 *  机器记录的 transport 才会进 provider 分派。 */
function makeHome(machine) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-provider-wiring-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: [machine] }))
  const port = Number(machine.port) || 43127
  const dir = path.join(root, `${machine.host}-${machine.username || ''}-${port}`, 'mirror')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({
    host: machine.host, port, username: machine.username || '',
    remotePath: machine.workspace || '/srv/t',
  }))
  return { home, cwd: dir }
}

/** 假 ctx：effect 注册 disposer（可手动触发 → 模拟插件卸载），其余服务容忍缺位。 */
function makeCtx() {
  const tools = new Map()
  const disposers = []
  return {
    ctx: {
      effect: (fn) => { disposers.push(fn); return () => {} },
      get: () => undefined,
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
    disposers,
  }
}

/** 一个工具执行会话的 cwd（mirror 目录），如同 agent loop 传入。 */
const execFor = (cwd) => ({ agent: { session: { header: { cwd } } } })

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 5000, connectTimeoutMs: 2000,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

/** 加载 apply()（query 破 import 缓存；provider.js 单例共享——fake 注册对
 *  后续 apply 实例仍可见，与 ssh 幂等注册同一机制）。 */
async function loadPlugin(home) {
  process.env.DSH_HOME = home
  return import(`../lib/index.js?wiring=${Math.random()}`)
}

/** 跑一个 rw_* 工具：成功返回 { ok:true, result }，失败返回 { ok:false, error }。 */
async function runTool(tools, name, args, cwd) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} must be registered`)
  try {
    return { ok: true, result: await tool.execute(args, execFor(cwd)) }
  } catch (e) {
    return { ok: false, error: String(e.message) }
  }
}

/** tunnel 机器记录（machines 路由落盘形状的直写等价物）。 */
const tunnelMachine = (over = {}) => ({
  id: 'm-tun-1', name: 'tunnel', transport: 'vscode-tunnel',
  host: '127.0.0.1', port: 43127, username: '',
  credentialBackend: 'plain',
  tunnel: { tunnelId: 'tun-abc', remoteIdentity: { machineId: 'rmt-9' } },
  workspace: '/srv/t',
  ...over,
})

/** SSH 兼容表面句柄（task 背景形状）。exec 的 stdout 带 handle 自身的
 *  identity 标记——若 machinePoolOf 包装/替换句柄，标记无法经工具栈到达输出。 */
function fakeHandle(id, machine, credentials) {
  const h = {
    identity: {
      machineId: machine ? machine.id : undefined,
      transport: id,
      credential: credentials,
      passthrough: 'handle-marker-' + id,
    },
    capabilities: { fs: true, exec: true, pty: true },
    status: () => ({ connected: true }),
    platform: 'unknown',
    client: null,
    fs: null,
    jobs: null,
    invalidate: () => {},
    detect: async () => {},
    sftp: async () => ({
      readdir: async () => [],
      stat: async () => ({}),
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {}, mkdir: async () => {},
      unlink: async () => {}, rename: async () => {}, rmdir: async () => {},
      fastGet: async () => {}, fastPut: async () => {},
    }),
    exec: async (command) => ({
      code: 0,
      stdout: `fake-exec:${h.identity.passthrough}::${String(command)}`,
      stderr: '',
    }),
    close: () => {},
  }
  return h
}

/** 注入 fake provider，返回 { state, dispose }：connect 记录调用次数/收到的
 *  machine/凭据，返回句柄并包装 close 计入 state（供 close/过期断言）。 */
function fakeProvider({ id = 'vscode-tunnel', connect } = {}) {
  const state = {
    id,
    connectCount: 0,
    machines: [],
    credentials: [],
    handles: [],
    closed: [],
    closeCounts: new Map(),
  }
  const dispose = registerProvider({
    id,
    label: 'VSCode Tunnel (fake)',
    connect: async (args) => {
      state.connectCount += 1
      state.machines.push(args.machine)
      const credentials = typeof args.credentialResolver === 'function'
        ? await args.credentialResolver() : undefined
      state.credentials.push(credentials)
      const handle = connect
        ? await connect(args, credentials, state)
        : fakeHandle(id, args.machine, credentials)
      state.handles.push(handle)
      const origClose = handle && typeof handle.close === 'function' ? handle.close : null
      if (origClose) {
        handle.close = () => {
          state.closed.push(handle)
          state.closeCounts.set(handle, (state.closeCounts.get(handle) || 0) + 1)
          return origClose.call(handle)
        }
      }
      return handle
    },
  })
  return { state, dispose }
}

/** 卸载一个 fake provider（幂等）。 */
async function runWith(fake, fn) {
  try {
    return await fn(fake)
  } finally {
    fake.dispose()
  }
}

test('① 已注册 vscode-tunnel → machinePoolOf 返回 connect 的句柄（identity 透传、exec/sftp 兼容面可用，不连 SSH）', async () => {
  const fake = fakeProvider()
  const machine = tunnelMachine()
  const { home, cwd } = makeHome(machine)
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx()
    await apply(ctx, { ...CONFIG })
    assert.equal(fake.state.connectCount, 0, 'apply() 本身不得建连')

    // exec 路径：rw_exec → b.pool.exec —— 输出带句柄自身 identity 标记 =
    // 真正执行的是插件 connect 返回的那个句柄（透传，无二次包装）。
    const r1 = await runTool(tools, 'rw_exec', { command: 'echo hi' }, cwd)
    assert.ok(r1.ok, r1.error)
    assert.match(r1.result.text, /fake-exec:handle-marker-vscode-tunnel::/, 'exec 必须落在 fake 句柄上')
    assert.match(r1.result.text, /echo hi/, '命令原样到达句柄 exec')
    assert.ok(!/ECONNREFUSED|ETIMEDOUT|handshake/.test(r1.result.text), '不得触碰 SSH 连接栈')
    assert.equal(fake.state.connectCount, 1)
    assert.equal(fake.state.machines[0].transport, 'vscode-tunnel')
    assert.equal(fake.state.machines[0].id, 'm-tun-1')

    // sftp 路径：rw_search → b.pool.sftp() —— 兼容面（sftp() Promise 包装）直接可用。
    const r2 = await runTool(tools, 'rw_search', { pattern: 'zzz-no-such' }, cwd)
    assert.ok(r2.ok, r2.error)
    assert.match(r2.result.text, /no matches for \/zzz-no-such\//, '搜索通过 fake 句柄的 sftp 面完成')

    // 返回句柄形状 = 插件 connect 的结果（identity 字段原样保留，兼容方法齐全）。
    const h = fake.state.handles[0]
    assert.equal(h.identity.transport, 'vscode-tunnel')
    assert.equal(h.identity.machineId, 'm-tun-1')
    assert.equal(h.identity.passthrough, 'handle-marker-vscode-tunnel')
    for (const k of ['exec', 'jobs', 'sftp', 'invalidate', 'close', 'status', 'fs']) {
      assert.ok(k in h, `handle.${k} 必须存在`)
    }
    assert.equal(typeof h.sftp, 'function')
    assert.equal(typeof h.exec, 'function')
    assert.equal(h.platform, 'unknown')
    assert.equal(h.client, null)
  } finally {
    fake.dispose()
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('② credentialResolver 被调用：明文密码路径与 tunnel.secret 回退路径', async () => {
  // (a) 明文 password → resolver 返回密码。
  await runWith(fakeProvider(), async (fake) => {
    const machine = tunnelMachine({ password: 'pw-plain-1' })
    const { home, cwd } = makeHome(machine)
    try {
      const { apply } = await loadPlugin(home)
      const { ctx, tools } = makeCtx()
      await apply(ctx, { ...CONFIG })
      const r = await runTool(tools, 'rw_exec', { command: 'whoami' }, cwd)
      assert.ok(r.ok, r.error)
      assert.equal(fake.state.connectCount, 1)
      assert.equal(fake.state.credentials[0], 'pw-plain-1', 'resolver 必须取到 machines.json 明文密码')
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })

  // (b) 无密码 → machinePassword 返回 '' → 回退 tunnel.secret（一次性秘密）。
  await runWith(fakeProvider(), async (fake) => {
    const machine = tunnelMachine({
      id: 'm-tun-2',
      password: undefined,
      tunnel: { tunnelId: 'tun-2', secret: 'tok-77', remoteIdentity: { machineId: 'rmt-2' } },
    })
    const { home, cwd } = makeHome(machine)
    try {
      const { apply } = await loadPlugin(home)
      const { ctx, tools } = makeCtx()
      await apply(ctx, { ...CONFIG })
      const r = await runTool(tools, 'rw_exec', { command: 'whoami' }, cwd)
      assert.ok(r.ok, r.error)
      assert.equal(fake.state.connectCount, 1)
      assert.equal(fake.state.credentials[0], 'tok-77', 'resolver 必须回退到 tunnel.secret')
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })
})

test('③ 同 machineId 二次取用命中缓存（fake connect 只调一次；id 缺失时 remoteIdentity.machineId 兜底键）', async () => {
  // (a) 常规记录：m.id 作键。
  await runWith(fakeProvider(), async (fake) => {
    const machine = tunnelMachine()
    const { home, cwd } = makeHome(machine)
    try {
      const { apply } = await loadPlugin(home)
      const { ctx, tools } = makeCtx()
      await apply(ctx, { ...CONFIG })
      const r1 = await runTool(tools, 'rw_exec', { command: 'echo a' }, cwd)
      const r2 = await runTool(tools, 'rw_exec', { command: 'echo b' }, cwd)
      assert.ok(r1.ok, r1.error)
      assert.ok(r2.ok, r2.error)
      assert.equal(fake.state.connectCount, 1, '同 machineId 第二次取用必须命中缓存')
      assert.equal(fake.state.handles.length, 1)
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })

  // (b) 无 id 记录 → 键回落 m.tunnel.remoteIdentity.machineId（'vscode-tunnel:rmt-9'），
  //     同样两次取用只建连一次。
  await runWith(fakeProvider(), async (fake) => {
    const machine = tunnelMachine({ id: undefined })
    const { home, cwd } = makeHome(machine)
    try {
      const { apply } = await loadPlugin(home)
      const { ctx, tools } = makeCtx()
      await apply(ctx, { ...CONFIG })
      const r1 = await runTool(tools, 'rw_exec', { command: 'echo a' }, cwd)
      const r2 = await runTool(tools, 'rw_exec', { command: 'echo b' }, cwd)
      assert.ok(r1.ok, r1.error)
      assert.ok(r2.ok, r2.error)
      assert.equal(fake.state.connectCount, 1, 'remoteIdentity.machineId 兜底键也必须缓存命中')
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })
})

test('④ 未注册 transport 仍抛 provider not installed（回归，不连 SSH）', async () => {
  // 前置：全局 provider 单例中不得有 'vscode-tunnel'（其他用例都已在 finally dispose）。
  const machine = tunnelMachine()
  const { home, cwd } = makeHome(machine)
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx()
    await apply(ctx, { ...CONFIG })
    const r = await runTool(tools, 'rw_exec', { command: 'hostname' }, cwd)
    assert.ok(!r.ok, '未安装 provider 的 transport 必须被拒绝')
    assert.match(r.error, /transport "vscode-tunnel": provider not installed/)
    assert.ok(!/ECONNREFUSED|ETIMEDOUT|127\.0\.0\.1/.test(r.error), '拒绝必须发生在任何 SSH 尝试之前')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('⑤ TTL 30 分钟过期 → 旧句柄被 close 并移除，下次取用重建', async (t) => {
  const fake = fakeProvider()
  const machine = tunnelMachine()
  const { home, cwd } = makeHome(machine)
  try {
    let now = 1_750_000_000_000
    t.mock.method(Date, 'now', () => now)
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx()
    await apply(ctx, { ...CONFIG })

    const r1 = await runTool(tools, 'rw_exec', { command: 'echo one' }, cwd)
    assert.ok(r1.ok, r1.error)
    assert.equal(fake.state.connectCount, 1)
    const h1 = fake.state.handles[0]

    now += 31 * 60 * 1000 // 越过 30 分钟 TTL
    const r2 = await runTool(tools, 'rw_exec', { command: 'echo two' }, cwd)
    assert.ok(r2.ok, r2.error)
    assert.equal(fake.state.connectCount, 2, 'TTL 过期后必须重建连接')
    assert.ok(fake.state.closed.includes(h1), '过期句柄必须被 close')
    assert.equal(fake.state.closeCounts.get(h1), 1)
    assert.notEqual(fake.state.handles[1], h1)

    now += 1000 // 未过期
    const r3 = await runTool(tools, 'rw_exec', { command: 'echo three' }, cwd)
    assert.ok(r3.ok, r3.error)
    assert.equal(fake.state.connectCount, 2, '未过期再次取用必须命中缓存')
  } finally {
    fake.dispose()
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('⑥ 插件卸载（ctx effect disposer → closeRoutePools）连同 provider 句柄一并 close', async () => {
  const fake = fakeProvider()
  const machine = tunnelMachine()
  const { home, cwd } = makeHome(machine)
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools, disposers } = makeCtx()
    await apply(ctx, { ...CONFIG })

    const r1 = await runTool(tools, 'rw_exec', { command: 'echo one' }, cwd)
    assert.ok(r1.ok, r1.error)
    assert.equal(fake.state.connectCount, 1)
    const h1 = fake.state.handles[0]

    // 触发 apply() 注册的全部 effect disposer（真实 cordis 卸载插件时执行）。
    for (const d of disposers) { try { await d() } catch {} }
    assert.ok(fake.state.closed.includes(h1), 'routePools 卸载清理必须 close 已缓存 provider 句柄')
    assert.equal(fake.state.closeCounts.get(h1), 1)
  } finally {
    fake.dispose()
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('⑦ connect 失败 → 抛 transport "X": connect failed（网络类 friendlyMessage 可读），不落缓存（下次重试）', async () => {
  let attempt = 0
  await runWith(fakeProvider({
    connect: async (args) => {
      attempt += 1
      if (attempt === 1) throw new Error('ECONNREFUSED: tunnel gateway down')
      return fakeHandle(args.machine && (args.machine.transport || 'vscode-tunnel'), args.machine, 'retry')
    },
  }), async (fake) => {
    const machine = tunnelMachine()
    const { home, cwd } = makeHome(machine)
    try {
      const { apply } = await loadPlugin(home)
      const { ctx, tools } = makeCtx()
      await apply(ctx, { ...CONFIG })

      // 第一次：connect 抛 ECONNREFUSED（网络类）→ 错误经 errors.js 可读化。
      const r1 = await runTool(tools, 'rw_exec', { command: 'echo a' }, cwd)
      assert.ok(!r1.ok, 'connect 失败必须上抛')
      assert.match(r1.error, /^transport "vscode-tunnel": connect failed: 连接被拒绝/, `got: ${r1.error}`)
      assert.match(r1.error, /ECONNREFUSED: tunnel gateway down/, '原始原因应保留')
      assert.ok(!r1.error.includes('provider not installed'))
      assert.equal(fake.state.connectCount, 1)
      assert.equal(fake.state.handles.length, 0, '失败的句柄绝不落缓存')

      // 第二次：connect 成功 → 说明失败确实未落缓存（重试真实发生）。
      const r2 = await runTool(tools, 'rw_exec', { command: 'echo b' }, cwd)
      assert.ok(r2.ok, r2.error)
      assert.equal(fake.state.connectCount, 2, '失败不落缓存 → 第二次调用必须再次尝试 connect')
      assert.equal(attempt, 2)
    } finally {
      delete process.env.DSH_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })
})