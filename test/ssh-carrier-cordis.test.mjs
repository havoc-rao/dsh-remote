// Framework integration, not a fake context or an SSH wire test.
// API contracts checked against installed @deepseek-ai/cordis README.md and
// src/{context,reflect,registry,fiber}.ts: provide owns services; plugin applies
// inject/Config; effect runs setup immediately and owns its returned disposer;
// awaiting a Fiber settles startup, and dispose() unloads its effects/children.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { registerSshCarrier, sshCarrierOf, sshConnectorTargetIdentity } from '../lib/ssh-carrier.js'
import { normalizeCarrierMachine } from '../lib/ssh-carrier-record.js'

const KIND = 'cordis-lifecycle-fixture'
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('installed Cordis applies dsh-remote without optional services and unloads a pending carrier cache acquisition', { timeout: 10000 }, async () => {
  const previousHome = process.env.DSH_HOME
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-carrier-cordis-'))
  const root = new Context()
  const tools = new Map()
  const sections = new Map()
  const events = []
  const acquiring = deferred()
  const acquired = deferred()
  const released = deferred()
  let releaseCount = 0
  let request
  let remoteFiber
  let carrierFiber
  let servicesFiber
  try {
    process.env.DSH_HOME = home
    // node --test disables telemetry in the product's existing guard. Empty
    // host + updateMode off + autoPush false prevent dialing/updating/watching.
    // No loader/profile, browser, web server, SSH server, or user credentials.
    servicesFiber = await root.plugin({
      name: 'cordis-fixture-services',
      apply(ctx) {
        ctx.provide('tools', {
          register(tool) {
            assert.ok(!tools.has(tool.name), `duplicate tool ${tool.name}`)
            tools.set(tool.name, tool)
          },
        })
        ctx.provide('systemPrompt', {
          section(section) { sections.set(section.name, section) },
        })
        ctx.effect(() => () => { tools.clear(); sections.clear() }, 'fixture.services')
      },
    })
    carrierFiber = await root.plugin({
      name: 'cordis-fixture-carrier',
      apply(ctx) {
        ctx.effect(() => {
          events.push('carrier setup')
          const canonical = connector => {
            assert.deepEqual(connector, { kind: KIND, config: { target: 'fixture-only' } })
            return 'cordis-fixture:stable-target'
          }
          const unregister = registerSshCarrier({
            id: KIND,
            targetIdentity: canonical,
            validateConnector: canonical,
            sanitizeConnector(connector) { canonical(connector); return connector },
            acquire(args) {
              request = args
              events.push('acquire')
              acquiring.resolve()
              // Keep acquisition pending until AFTER real Fiber disposal. This
              // populates the real apply-owned cache without any network dial.
              return acquired.promise
            },
          })
          return () => { events.push('carrier cleanup'); unregister() }
        }, 'fixture.carrier-registry')
      },
    })
    assert.deepEqual(events, ['carrier setup'], 'real effect setup runs at load, not unload')
    assert.ok(sshCarrierOf(KIND))
    assert.ok(carrierFiber.getEffects().some(effect => effect.label === 'fixture.carrier-registry'))

    const machine = normalizeCarrierMachine({
      id: 'cordis-fixture-machine', name: 'Cordis fixture', transport: 'ssh',
      connector: { kind: KIND, config: { target: 'fixture-only' } },
      username: 'fixture', workspace: '/fixture/project',
      privateKeyPath: '', password: '', passphrase: '',
      useAgent: false, keyboardInteractive: false,
      expectedHostFingerprint: 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, ''),
    })
    const workspaces = path.join(home, 'remote-workspaces')
    const cwd = path.join(workspaces, 'ssh-carrier-' + machine.id, 'mirror')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(path.join(workspaces, 'machines.json'), JSON.stringify({ list: [machine], currentId: machine.id }))
    writeFileSync(path.join(cwd, '.dsh-remote-meta.json'), JSON.stringify({
      schemaVersion: 3, transport: 'ssh', machineId: machine.id,
      connectorTargetIdentity: sshConnectorTargetIdentity(machine.connector),
      remotePath: machine.workspace,
    }))

    // Import after setting the sandbox home: index captures known-hosts paths
    // at module evaluation. Pass the actual module, including inject + Config.
    const remote = await import(`../lib/index.js?cordisFixture=${encodeURIComponent(home)}`)
    const loading = root.plugin(remote, {
      experimentalSshCarrier: true, host: '', updateMode: 'off',
      autoPush: false, auditLog: false, useAgent: false, keyboardInteractive: false,
    })
    // Public plugin API must wait for startup, not just return a pending fiber.
    remoteFiber = await loading
    assert.equal(Context.is(remoteFiber.ctx), true)
    assert.equal(remoteFiber.config.experimentalSshCarrier, true)
    assert.equal(remoteFiber.config.port, 22, 'actual Config schema supplies defaults')
    assert.equal(root.registry.has(remote), true)
    for (const name of ['webServer', 'http', 'commands', 'sessions', 'skills', 'openInApp', 'loader', 'directoryPicker']) {
      assert.equal(remoteFiber.ctx.get(name), undefined, `${name} is genuinely absent`)
      assert.throws(() => remoteFiber.ctx[name], /without inject/, 'DSH optional services must use get(), not property access')
    }
    for (const name of ['rw_info', 'rw_exec', 'rw_disconnect', 'rw_connect']) assert.ok(tools.has(name), name)
    const effects = remoteFiber.getEffects().map(effect => effect.label)
    assert.ok(effects.includes('dsh-remote.close'))
    assert.ok(effects.includes('dsh-remote.routePools'), 'real lifecycle owns carrier cache teardown')
    assert.ok(!effects.includes('dsh-remote.update-timer'))
    assert.deepEqual(events, ['carrier setup'], 'boot is lazy: no carrier acquisition')

    const prompt = sections.get('dsh-remote')
    assert.ok(prompt)
    assert.equal(prompt.text({}), '')
    assert.equal(prompt.text({ agent: { session: { header: { cwd: home } } } }), '')
    assert.match(prompt.text({ agent: { session: { header: { cwd } } } }), /Remote workspace/)
    assert.match((await tools.get('rw_info').execute({}, { agent: { session: { header: { cwd: home } } } })).text, /LOCAL workspace/)
    await assert.rejects(tools.get('rw_exec').execute({ command: 'never-run' }, {}), /no remote host active in THIS workspace/)
    assert.deepEqual(events, ['carrier setup'], 'local/missing context never acquires reachability')

    const info = tools.get('rw_info').execute({}, { agent: { session: { header: { cwd } } } })
    await acquiring.promise
    assert.equal(request.machineId, machine.id)
    assert.deepEqual(request.connector, machine.connector)
    assert.equal(request.signal.aborted, false)
    await remoteFiber.dispose()
    assert.equal(request.signal.aborted, true, 'real unload aborts the apply-owned cache entry')
    assert.equal(root.registry.has(remote), false)
    assert.deepEqual(remoteFiber.getEffects(), [])
    assert.ok(sshCarrierOf(KIND), 'remote unload must not remove another plugin registry entry')

    // Already-aborted acquisition releases before SshPool.connect(): no listener
    // or socket is needed, and port 1 is never contacted. Observe the release
    // explicitly because product closeRoutePools launches async cache cleanup.
    acquired.resolve({
      dialHost: '127.0.0.1', dialPort: 1,
      targetIdentity: 'cordis-fixture:runtime-target', generation: 'generation-1',
      closed: new Promise(() => {}),
      release() { releaseCount++; events.push('lease release'); released.resolve() },
    })
    await released.promise
    assert.match((await info).text, /Ping: FAILED/)
    assert.equal(releaseCount, 1, 'late lease is released rather than retained in unloaded cache')
    await remoteFiber.dispose()
    assert.equal(releaseCount, 1, 'real fiber disposal is idempotent')
    await carrierFiber.dispose()
    assert.equal(sshCarrierOf(KIND), undefined)
    await carrierFiber.dispose()
    assert.deepEqual(events, ['carrier setup', 'acquire', 'lease release', 'carrier cleanup'])
  } finally {
    // Abort before resolving even on assertion failures, so cleanup cannot dial.
    await remoteFiber?.dispose()
    acquired.resolve({
      dialHost: '127.0.0.1', dialPort: 1, targetIdentity: 'cleanup', generation: 'cleanup',
      closed: new Promise(() => {}), release() { released.resolve() },
    })
    await remoteFiber?.dispose()
    await carrierFiber?.dispose()
    await servicesFiber?.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    // Only the absolute, mkdtemp-owned fixture is removed; never product data.
    assert.ok(path.isAbsolute(home) && path.basename(home).startsWith('dsh-carrier-cordis-'))
    rmSync(home, { recursive: true, force: true })
  }
})
