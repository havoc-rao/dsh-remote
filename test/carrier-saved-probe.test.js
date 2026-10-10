// Execute the real test-connect handler with the real carrier/pool wrapper.
// SSH and process I/O are injected test doubles: no network, CLI or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { registerSshCarrier } from '../lib/ssh-carrier.js'
import { normalizeCarrierMachine } from '../lib/ssh-carrier-record.js'
import { createCarrierSshPool } from '../lib/ssh-carrier-pool.js'
import { sshConnectorTargetIdentity } from '../lib/ssh-carrier.js'
import { createProbeDiagnostics } from '../lib/probe-diagnostics.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const route = source.indexOf("path: '/dsh-remote/test-connect'")
const begin = source.indexOf("        if (req.method !== 'POST')", route)
const end = source.indexOf('\n      },\n    },\n    {', begin)
assert.ok(begin > route && end > begin)
const handlerFactory = new Function('deps', `
  const { machines, config, parseJsonObject, readBody, sendJson, machineId,
    normalizeCarrierMachine, createCarrierSshPool, knownHostsFile, machinePassword,
    sshConnectorTargetIdentity, friendlyMessage, SshPool, probeDiagnostics, carrierPools } = deps;
  return async (req, res) => { ${source.slice(begin, end)} };
`)
const pin = 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')
const carrierUrl = new URL('../../dsh-devtunnel-ssh/lib/carrier.js', import.meta.url)
const supervisorUrl = new URL('../../dsh-devtunnel-ssh/lib/managed-supervisor.js', import.meta.url)

async function fixture(t) {
  const { createCarrier } = await import(carrierUrl)
  const { createManagedStarter } = await import(supervisorUrl)
  const state = { starts: 0, closes: 0, temporaryIds: 0, pools: [], passwordReads: 0 }
  const starter = createManagedStarter({ executable: '/test-only/devtunnel', start: async () => {
    state.starts++
    let resolve
    const closed = new Promise(r => { resolve = r })
    return { endpoint: { host: '127.0.0.1', port: 32123 }, closed,
      close() { state.closes++; resolve({ reason: 'CONNECT_CLOSED' }) } }
  } })
  const carrier = createCarrier({ startManaged: starter })
  const unregister = registerSshCarrier(carrier)
  t.after(async () => { await carrier.dispose(); unregister() })
  const saved = normalizeCarrierMachine({ id: 'saved-carrier', name: 'Saved', username: 'dev',
    useAgent: true, expectedHostFingerprint: pin,
    connector: { kind: 'devtunnel', mode: 'managed', tunnelId: 'abc123', remotePort: 22 } })
  const machines = [saved]
  class Pool {
    constructor(config) { this.config = config; this.client = null; this.closed = false; this.commands = []; state.pools.push(this) }
    async connect() { assert.equal(this.closed, false); this.client ||= {}; return this.client }
    async exec(command) { await this.connect(); this.commands.push(command); return { stdout: '', code: 0 } }
    close() { this.closed = true; this.client = null }
  }
  const createPool = (record, config, options) => createCarrierSshPool(record, config, { ...options, Pool })
  const probeDiagnostics = createProbeDiagnostics()
  const handler = handlerFactory({ machines, probeDiagnostics, carrierPools: { peek: () => state.pools.find(p => !p.closed) }, config: { experimentalSshCarrier: true },
    parseJsonObject: JSON.parse, readBody: async req => JSON.stringify(req.body),
    sendJson: (_, status, data) => ({ status, data }), machineId: () => 'temporary-' + (++state.temporaryIds),
    normalizeCarrierMachine, createCarrierSshPool: createPool, knownHostsFile: undefined,
    machinePassword: async () => { state.passwordReads++; return '' }, sshConnectorTargetIdentity,
    friendlyMessage: err => err.message,
    SshPool: class { constructor() { throw new Error('unexpected direct SSH fallback') } },
  })
  return { state, saved, machines, carrier, createPool, diagnostics: probeDiagnostics, probe: body => handler({ method: 'POST', body }, {}) }
}
const options = { skip: !existsSync(carrierUrl) || !existsSync(supervisorUrl) }

test('saved-only probe resolves full saved pin/target/auth without mutating the record', options, async t => {
  const f = await fixture(t)
  const before = JSON.stringify(f.saved)
  const result = await f.probe({ id: f.saved.id })
  assert.equal(result.status, 200); assert.equal(result.data.ok, true)
  assert.equal(result.data.machineId, f.saved.id)
  assert.equal(f.state.temporaryIds, 0)
  const pool = f.state.pools[0]
  assert.equal(pool.config.username, 'dev')
  assert.equal(pool.config.expectedHostFingerprint, pin)
  assert.equal(pool.config.hostKeyMode, 'verify')
  assert.equal(pool.config.useAgent, true)
  assert.ok(pool.config.hostKeyIdentity.includes(f.saved.id))
  assert.deepEqual(pool.commands, ['true'])
  assert.equal(pool.closed, true, 'finally closes the isolated probe SSH pool')
  assert.equal(JSON.stringify(f.saved), before, 'no normalization or probe result writes back to saved record')
  assert.equal(f.state.starts, 1); assert.equal(f.state.closes, 1)
})

test('business lease + saved probe share one CLI but isolated SSH pools; last business release closes once', options, async t => {
  const f = await fixture(t)
  const business = await f.createPool(f.saved, {}, {})
  t.after(() => business.close())
  await business.connect()
  const client = business.client
  const result = await f.probe({ id: f.saved.id })
  assert.equal(result.data.ok, true)
  const timeline = f.diagnostics.list().events
  assert.deepEqual(timeline.map(e => e.event), ['probe.start', 'carrier.acquire.start', 'carrier.acquire.complete',
    'pool.connect.start', 'exec.start', 'exec.complete', 'probe.success', 'pool.close.start', 'pool.close.complete'])
  assert.equal(timeline[2].reusedGeneration, true)
  assert.equal(new Set(timeline.map(e => e.probeId)).size, 1)
  assert.equal(result.data.probeId, timeline[0].probeId)
  assert.equal(f.state.starts, 1, 'probe acquires the same saved machineId, no second CLI')
  assert.equal(f.state.closes, 0, 'probe release does not close the business lease')
  assert.equal(f.state.pools.length, 2)
  assert.notEqual(f.state.pools[0], f.state.pools[1], 'probe never shares the business SSH pool')
  assert.equal(f.state.pools[1].closed, true)
  assert.equal(business.carrierClosed, false)
  assert.equal(business.client, client)
  await business.exec('business-after-probe')
  assert.deepEqual(business.commands, ['business-after-probe'], 'probe true is not run/replayed on business SSH')
  const other = { ...f.saved, id: 'different-machine' }
  f.machines.push(other)
  const busy = await f.probe({ id: other.id })
  assert.equal(busy.data.ok, false)
  assert.match(busy.data.error, /CONNECT_TARGET_BUSY/)
  assert.equal(f.state.starts, 1, 'different machine same target is not allowed to share')
  await business.close(); await business.close()
  assert.equal(f.state.closes, 1)
})

test('failed probe releases only its own reference, leaving the business pool live', options, async t => {
  const f = await fixture(t)
  const business = await f.createPool(f.saved, {}, {})
  t.after(() => business.close())
  await business.connect()
  const client = business.client
  const original = f.state.pools[0].constructor.prototype.exec
  f.state.pools[0].constructor.prototype.exec = async function (command) {
    if (command === 'true') throw new Error('probe-only failure')
    return original.call(this, command)
  }
  const result = await f.probe({ id: f.saved.id })
  assert.equal(result.data.ok, false)
  assert.match(result.data.error, /probe-only failure/)
  assert.equal(f.state.pools[1].closed, true)
  assert.equal(f.state.starts, 1); assert.equal(f.state.closes, 0)
  assert.equal(business.client, client)
  assert.equal(business.carrierClosed, false)
  await business.exec('business-after-failed-probe')
  await business.close()
  assert.equal(f.state.closes, 1)
})

test('unknown ids and id-plus-draft (including unchanged fields) are rejected before acquire', options, async t => {
  const f = await fixture(t)
  const before = JSON.stringify(f.saved)
  for (const body of [{ id: 'missing' }, { id: '' }, { id: null },
    { id: f.saved.id, username: 'attacker' }, { id: f.saved.id, useAgent: false },
    { id: f.saved.id, expectedHostFingerprint: pin },
    { id: f.saved.id, connector: f.saved.connector },
    { ...f.saved }, { id: f.saved.id, password: 'not-allowed' }]) {
    const result = await f.probe(body)
    assert.equal(result.data.ok, false, JSON.stringify(body))
    assert.match(result.data.error, /machine not found|requires id only/)
  }
  assert.equal(f.state.starts, 0); assert.equal(f.state.pools.length, 0)
  assert.equal(JSON.stringify(f.saved), before)
})

test('new carrier probe uses temporary identity; invalid pin/auth never silently borrows saved config', options, async t => {
  const f = await fixture(t)
  const { id, ...draft } = f.saved
  for (const changed of [{ expectedHostFingerprint: '' }, { username: '' }, { password: 'x' }]) {
    const result = await f.probe({ ...draft, ...changed })
    assert.equal(result.data.ok, false)
  }
  assert.equal(f.state.starts, 0)
  const result = await f.probe(draft)
  assert.equal(result.data.ok, true)
  assert.equal(result.data.machineId, null)
  assert.ok(!f.state.pools[0].config.hostKeyIdentity.includes(f.saved.id))
  assert.equal(f.state.starts, 1); assert.equal(f.state.closes, 1)
})
