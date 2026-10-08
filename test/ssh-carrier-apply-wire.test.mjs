// Real apply() -> workspace routing -> carrier cache -> ssh2 wire -> rw_exec.
// Only loopback is used. Host keys exist only in memory; no user SSH config,
// keys, agent, keychain, tokens or external hosts are consulted. CRUD and the
// test-connect route deliberately reject passwords: this isolated test-only
// registry seed exercises the runtime normalizer, NOT supported onboarding.
// No SFTP fixture: this suite proves exec routing/lifetime, not filesystem I/O.
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { registerSshCarrier, sshConnectorTargetIdentity } from '../lib/ssh-carrier.js'
import { normalizeCarrierMachine } from '../lib/ssh-carrier-record.js'

const PASSWORD = 'local-test-only'
const KIND = 'apply-wire-fixture'
const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 2000, connectTimeoutMs: 1500,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'verify',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
  experimentalSshCarrier: true,
}
const execFor = cwd => ({ agent: { session: { header: { cwd } } } })
const tick = () => new Promise(resolve => setImmediate(resolve))

// Model Cordis effect SETUP, not a list of callbacks to invoke at unload.
function makeCtx() {
  const tools = new Map()
  const disposers = []
  return {
    ctx: {
      effect(setup) {
        const dispose = setup()
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
      inject(names, callback) { if (names.every(name => this.get(name))) callback(this) },
      get: () => undefined,
      tools: { register: tool => tools.set(tool.name, tool) },
      systemPrompt: { section: () => {} },
    },
    tools,
    async dispose() {
      for (const dispose of disposers.splice(0).reverse()) await dispose()
      // routePools starts async carrier-cache cleanup from a synchronous disposer.
      await tick()
    },
  }
}

async function fixture(run) {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-carrier-apply-wire-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const key = ssh2.utils.parseKey(privateKey)
  assert.ok(!(key instanceof Error))
  const pin = 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')
  const state = { connections: 0, authenticated: 0, commands: [], leases: [], clients: new Set() }
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    const connection = ++state.connections
    state.clients.add(client)
    client.on('error', () => {}) // pin rejection is an expected failed handshake.
    client.on('close', () => state.clients.delete(client))
    client.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === 'fixture' && auth.password === PASSWORD) auth.accept()
      else auth.reject(['password'])
    })
    client.on('ready', () => {
      state.authenticated++
      client.on('session', accept => {
        const session = accept()
        session.on('exec', (accept, reject, info) => {
          state.commands.push({ connection, command: info.command })
          if (info.command.includes('fixture-reject')) return reject()
          const channel = accept()
          channel.on('error', () => {})
          if (info.command === 'cmd /c ver') {
            channel.stderr.write('cmd: not found\n')
            channel.exit(127)
            channel.end()
          } else if (info.command === 'uname -s') {
            channel.write('Linux\n')
            channel.exit(0)
            channel.end()
          } else {
            channel.write(`remote-wire-marker:${connection}:${info.command}\n`)
            channel.exit(0)
            channel.end()
          }
        })
      })
    })
  })
  // ssh2 emits its public connection only after protocol setup. Track raw
  // fixture sockets too so failed pin handshakes cannot keep teardown alive.
  const sockets = new Set()
  server._srv.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  let unregister = () => {}
  const contexts = []
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    const canonical = connector => {
      assert.equal(connector.kind, KIND)
      assert.equal(connector.config?.target, 'loopback-only')
      return 'fixture-descriptor:loopback-only'
    }
    unregister = registerSshCarrier({
      id: KIND,
      targetIdentity: canonical,
      validateConnector: canonical,
      sanitizeConnector(connector) {
        canonical(connector)
        return { kind: KIND, config: { target: 'loopback-only' } }
      },
      async acquire({ machineId, connector }) {
        canonical(connector)
        const lease = { machineId, releases: 0 }
        state.leases.push(lease)
        return {
          dialHost: '127.0.0.1', dialPort: port,
          targetIdentity: 'fixture-runtime-target', generation: 'fixture-generation',
          closed: new Promise(() => {}),
          release() { lease.releases++ },
        }
      },
    })
    const cwds = {}
    const machines = ['wire-a', 'wire-b', 'wire-bad-pin'].map(id => {
      const record = normalizeCarrierMachine({
        id, name: id, transport: 'ssh', connector: { kind: KIND, config: { target: 'loopback-only' } },
        username: 'fixture', password: PASSWORD, privateKeyPath: '', passphrase: '',
        useAgent: false, keyboardInteractive: false, workspace: `/srv/${id}`,
        expectedHostFingerprint: id === 'wire-bad-pin'
          ? 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, '') : pin,
      })
      const cwd = path.join(root, 'ssh-carrier-' + id, 'mirror')
      mkdirSync(cwd, { recursive: true })
      writeFileSync(path.join(cwd, '.dsh-remote-meta.json'), JSON.stringify({
        schemaVersion: 3, transport: 'ssh', machineId: id,
        connectorTargetIdentity: sshConnectorTargetIdentity(record.connector),
        remotePath: record.workspace,
        // A tempting direct fallback is reachable and would be observable.
        host: '127.0.0.1', port, username: 'fixture',
      }))
      cwds[id] = cwd
      return { ...record, host: '127.0.0.1', port, credentialBackend: 'plain' }
    })
    // EXPLICIT TEST-ONLY password seed, validated above. Do not copy this into
    // CRUD onboarding: it intentionally bypasses its unsupported-password gate.
    writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'wire-b' }))
    process.env.DSH_HOME = home
    const { apply } = await import(`../lib/index.js?carrierApplyWire=${encodeURIComponent(home)}`)
    const start = async overrides => {
      const context = makeCtx()
      contexts.push(context)
      await apply(context.ctx, { ...CONFIG, ...overrides })
      assert.ok(context.tools.has('rw_exec'))
      assert.equal(state.connections, 0, 'apply must not eagerly connect')
      return context
    }
    await run({ state, cwds, home, start, unregister })
  } finally {
    for (const context of contexts.reverse()) await context.dispose()
    unregister()
    for (const client of state.clients) client.end()
    for (const socket of sockets) socket.destroy()
    if (server._srv.listening) await new Promise(resolve => server.close(resolve))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    // Absolute mkdtemp-created fixture only; never the real user DSH_HOME.
    assert.ok(path.isAbsolute(home) && path.basename(home).startsWith('dsh-carrier-apply-wire-'))
    rmSync(home, { recursive: true, force: true })
  }
}

const options = { timeout: 15000 }

test('real apply rw_exec routes two machine IDs to isolated pools on one carrier endpoint and releases on disposal', options, async () => {
  await fixture(async ({ state, cwds, start }) => {
    const context = await start()
    const exec = context.tools.get('rw_exec')
    const results = []
    for (const id of ['wire-a', 'wire-b', 'wire-a', 'wire-b']) {
      const result = await exec.execute({ command: 'fixture-marker' }, execFor(cwds[id]))
      assert.match(result.text, new RegExp(`remote-wire-marker:\\d+:cd '/srv/${id}' && fixture-marker`))
      results.push(Number(result.text.match(/remote-wire-marker:(\d+):/)[1]))
    }
    assert.equal(results[0], results[2], 'same machine reuses its live SSH client')
    assert.equal(results[1], results[3])
    assert.notEqual(results[0], results[1], 'different stable IDs cannot share a pool even at the same endpoint')
    assert.equal(state.connections, 2)
    assert.equal(state.authenticated, 2)
    assert.deepEqual(state.leases.map(lease => lease.machineId), ['wire-a', 'wire-b'])
    assert.equal(state.commands.filter(entry => entry.command === 'cmd /c ver').length, 2)
    assert.equal(state.commands.filter(entry => entry.command === 'uname -s').length, 2)
    await assert.rejects(exec.execute({ command: 'fixture-reject' }, execFor(cwds['wire-a'])), /ssh exec failed|Unable to exec|request failed/i)
    assert.equal(state.connections, 2, 'channel refusal must not fall back to direct SSH')
    await context.dispose()
    assert.deepEqual(state.leases.map(lease => lease.releases), [1, 1])
    await context.dispose()
    assert.deepEqual(state.leases.map(lease => lease.releases), [1, 1], 'disposal is idempotent')
  })
})

test('real apply strict wrong host pin rejects before password authentication or command execution', options, async () => {
  await fixture(async ({ state, cwds, start }) => {
    const context = await start()
    await assert.rejects(context.tools.get('rw_exec').execute({ command: 'fixture-marker' }, execFor(cwds['wire-bad-pin'])), /fingerprint|host key/i)
    assert.equal(state.connections, 3, 'rw_exec pre-detect, exec detect and exec each enforce the same pin')
    assert.equal(state.authenticated, 0)
    assert.deepEqual(state.commands, [])
    assert.equal(state.leases.length, 1, 'failed handshakes still belong to one cached carrier pool')
    await context.dispose()
    assert.equal(state.leases[0].releases, 1)
  })
})

test('real apply local/missing execution context and disabled carrier opt-in refuse without dialing', options, async () => {
  await fixture(async ({ state, cwds, home, start }) => {
    const context = await start({ experimentalSshCarrier: false })
    const exec = context.tools.get('rw_exec')
    await assert.rejects(exec.execute({ command: 'fixture-marker' }, execFor(home)), /no remote host active in THIS workspace/)
    await assert.rejects(exec.execute({ command: 'fixture-marker' }, {}), /no remote host active in THIS workspace/)
    await assert.rejects(exec.execute({ command: 'fixture-marker' }, execFor(cwds['wire-a'])), /experimental opt-in/)
    assert.equal(state.connections, 0)
    assert.equal(state.leases.length, 0)
  })
})

test('real apply missing carrier fails closed despite reachable direct fallback metadata', options, async () => {
  await fixture(async ({ state, cwds, start, unregister }) => {
    const context = await start()
    unregister()
    // Canonical schema3 ownership becomes unavailable with its provider;
    // therefore refusal can happen before machinePoolOf, at context resolution.
    await assert.rejects(context.tools.get('rw_exec').execute({ command: 'fixture-marker' }, execFor(cwds['wire-a'])), /no remote host active in THIS workspace/)
    assert.equal(state.connections, 0, 'no direct SSH fallback to the fixture server')
    assert.equal(state.authenticated, 0)
    assert.equal(state.leases.length, 0)
  })
})
