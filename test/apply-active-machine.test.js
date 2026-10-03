// Regression: applyActiveMachine / clearActiveMachine must re-point the shared
// pool even though they read the new target OUT OF the config they just
// mutated. `new SshPool(config)` shares the LIVE config object with the plugin
// and lib/registry.js applyMachine mutates that object IN PLACE before
// pool.setTarget is called — so a config-vs-config diff is always EQUAL (the
// dead no-op check introduced by 5246082). Consequence: switching machines via
// POST /dsh-remote/current kept the OLD ssh2 client and stale platform cache
// and commands executed on the OLD host while the registry reported the NEW
// one (the wrong-host hazard of issue #25).
//
// The pool-level tests model that EXACT call shape: a config object shared with
// pool.config, mutated applyMachine-style BEFORE setTarget is called with
// values read from that same config, with the pre-mutation snapshot as the diff
// baseline (the fixed signature). The plugin-level tests pin the production
// wiring through POST /dsh-remote/current. Written FIRST and captured RED
// against the un-fixed code (strict TDD).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshPool } from '../lib/pool.js'
import { applyMachine } from '../lib/registry.js'

// ── pool-level: the real applyActiveMachine call shape ──────────────────────

const baseConfig = () => ({
  host: 'a.test', port: 22, username: 'dev', password: 'pw-a',
  privateKeyPath: '', passphrase: '', workspace: '/ws', shell: '',
  useAgent: false, keyboardInteractive: false, hostKeyMode: 'off',
  connectTimeoutMs: 500, commandTimeoutMs: 500,
})

const machineB = {
  host: 'b.test', port: 2222, username: 'root', password: 'pw-b',
  privateKeyPath: '', passphrase: '', workspace: '/ws-b',
  useAgent: false, keyboardInteractive: false, hostKeyMode: 'off',
}

// Mirror of the field set pool.setTarget diffs (kept in sync with lib/index.js).
const targetFields = (c) => ({
  host: c.host, port: c.port, username: c.username,
  password: c.password, privateKeyPath: c.privateKeyPath,
  passphrase: c.passphrase, workspace: c.workspace,
  useAgent: c.useAgent, keyboardInteractive: c.keyboardInteractive,
  proxy: c.proxy, hostKeyMode: c.hostKeyMode,
})

// Mirror of applyActiveMachine's production call shape (lib/index.js): take the
// diff baseline BEFORE applyMachine mutates the shared config, then call
// setTarget with values READ FROM THAT SAME config plus the snapshot.
function applyActiveMachineShape(pool, machine) {
  const config = pool.config
  const previous = targetFields(config)
  applyMachine(config, { ...machine })
  return pool.setTarget(targetFields(config), previous)
}

// Mirror of clearActiveMachine's production call shape (lib/index.js): zero the
// shared config FIRST (applyMachine keeps an empty workspace, so it cannot be
// used for a full reset), with the pre-zeroing snapshot as the diff baseline.
function clearActiveMachineShape(pool) {
  const config = pool.config
  const previous = targetFields(config)
  config.host = ''
  config.port = 22
  config.username = ''
  config.password = ''
  config.workspace = ''
  return pool.setTarget({ host: '', port: 22, username: '', workspace: '' }, previous)
}

function warmPool() {
  const config = baseConfig()
  const pool = new SshPool(config, { knownHostsFile: () => '' })
  const stats = { ended: 0 }
  // Simulate the state between picker keystrokes: connection live, platform
  // detected for the machine currently applied to the shared config.
  pool.client = { end() { stats.ended++ }, destroy() { stats.ended++ } }
  pool.platform = 'posix'
  pool.shellMode = 'native'
  pool.gitBashPath = ''
  return { pool, stats }
}

test('applyActiveMachine shape: switching machines closes the old connection + re-detects', () => {
  const { pool, stats } = warmPool()
  applyActiveMachineShape(pool, machineB)
  assert.equal(stats.ended, 1, 'a machine switch must close the OLD connection')
  assert.equal(pool.client, null, 'the stale client must not be reused')
  assert.equal(pool.platform, 'unknown', 'the new machine must be re-detected')
  assert.equal(pool.config.host, 'b.test', 'the shared config must carry the new identity')
  assert.equal(pool.config.port, 2222)
  assert.equal(pool.config.username, 'root')
})

test('applyActiveMachine shape: re-applying the SAME machine keeps the live connection', () => {
  const { pool, stats } = warmPool()
  // Same record values (what POST /current does on every picker keystroke).
  applyActiveMachineShape(pool, { ...baseConfig(), shell: undefined })
  assert.equal(stats.ended, 0, 'an identical target must NOT close the connection')
  assert.ok(pool.client, 'the client must stay cached')
  assert.equal(pool.platform, 'posix', 'the platform-detection cache must survive')
})

test('clearActiveMachine shape: "active remote = none" disconnects the shared pool', () => {
  const { pool, stats } = warmPool()
  clearActiveMachineShape(pool)
  assert.equal(stats.ended, 1, 'clearing the active machine must close the connection')
  assert.equal(pool.client, null)
  assert.equal(pool.config.host, '', 'the shared config must be zeroed')
})

// ── plugin-level: the production wiring through POST /dsh-remote/current ────

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-apply-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const machines = [
    { id: 'm-linux', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw-linux' },
    { id: 'm-win', name: 'winbox', host: '127.0.0.22', port: 1, username: 'Administrator', password: 'pw-win' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-win' }))
  return { home, machinesFile: path.join(root, 'machines.json') }
}

function makeCtx() {
  const routes = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadPlugin(home) {
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?apply=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes }
}

async function postCurrent(routes, id, workspace) {
  const route = routes.get('/dsh-remote/current')
  assert.ok(route, 'route /dsh-remote/current must be registered')
  const req = Readable.from([Buffer.from(JSON.stringify({ id, workspace }))])
  req.method = 'POST'
  req.url = '/dsh-remote/current'
  const res = {
    statusCode: 0,
    payload: '',
    setHeader() {},
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.payload) }
}


// The local fork owns a pool per machine. Selecting a machine changes only
// that workspace's binding; it must never retarget another session's pool.
test('workspace switches preserve other workspace bindings and do not retarget a shared pool', async () => {
  const { home, machinesFile } = makeHome()
  const original = SshPool.prototype.setTarget
  let retargets = 0
  SshPool.prototype.setTarget = function (...args) { retargets++; return original.apply(this, args) }
  try {
    const { routes } = await loadPlugin(home)
    const a = await postCurrent(routes, 'm-linux', '/local/a')
    assert.equal(a.status, 200)
    const b = await postCurrent(routes, 'm-win', '/local/b')
    assert.equal(b.status, 200)
    let saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
    assert.equal(saved.workspaces['/local/a'].machineId, 'm-linux')
    assert.equal(saved.workspaces['/local/b'].machineId, 'm-win')
    assert.equal((await postCurrent(routes, '', '/local/a')).status, 200)
    saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
    assert.equal(saved.workspaces['/local/a'].explicitNone, true)
    assert.equal(saved.workspaces['/local/b'].machineId, 'm-win')
    assert.equal(retargets, 0, 'selections must not retarget any existing machine pool')
  } finally {
    SshPool.prototype.setTarget = original
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('boot preserves workspace selections and repeating them does not rewrite the registry', async () => {
  const { home, machinesFile } = makeHome()
  const saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
  saved.workspaces = { '/local/a': { machineId: 'm-win', workspace: '', explicitNone: false } }
  writeFileSync(machinesFile, JSON.stringify(saved))
  try {
    const { routes } = await loadPlugin(home)
    rmSync(machinesFile)
    for (let i = 0; i < 3; i++) assert.equal((await postCurrent(routes, 'm-win', '/local/a')).status, 200)
    assert.equal(existsSync(machinesFile), false)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
