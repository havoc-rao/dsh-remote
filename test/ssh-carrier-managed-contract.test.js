import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSshCarrier, sshCarrierOf } from '../lib/ssh-carrier.js'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createCarrierPoolCache } from '../lib/ssh-carrier-cache.js'
import { createCarrierSshPool } from '../lib/ssh-carrier-pool.js'

const fp = 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')

test('actual capability expression uses public registry and exact booleans without acquire', () => {
  const source = readFileSync(new URL('../lib/ssh-carrier.js', import.meta.url), 'utf8')
  const expression = source.match(/devTunnelManaged: (.*),/)[1]
  let acquired = 0
  for (const capability of [true, false, undefined, 'true', 1, null]) {
    const dispose = registerSshCarrier({ id: 'devtunnel', acquire() { acquired++ }, capabilities: { managedConnect: capability, automaticLocalPort: true, reconnect: 'bounded-on-demand' } })
    try {
      for (const enabled of [true, false]) {
        const actual = vm.runInNewContext(expression, { enabled, sshCarrierOf })
        assert.equal(actual, enabled && capability === true)
        assert.equal(typeof actual, 'boolean')
      }
    } finally { dispose() }
  }
  assert.equal(vm.runInNewContext(expression, { enabled: true, sshCarrierOf }), false)
  assert.equal(acquired, 0)
})

test('closed managed lease never revives or replays SSH; next cache request acquires a new generation', async t => {
  let acquisitions = 0, releases = 0, sshConnects = 0
  const closeLease = []
  const dispose = registerSshCarrier({ id: 'managed-redial-fixture', targetIdentity: () => 'stable-target', acquire({ connector }) {
    assert.equal(connector.mode, 'managed'); assert.equal(connector.endpoint, undefined)
    const generation = String(++acquisitions)
    return { dialHost: '127.0.0.1', dialPort: 3000 + acquisitions, targetIdentity: 'stable-target', generation,
      closed: new Promise(resolve => { closeLease.push(resolve) }), release() { releases++ } }
  } }); t.after(dispose)
  class Pool { connect() { sshConnects++; return Promise.resolve() } close() {} }
  const cache = createCarrierPoolCache({ createPool: (m, c, opts) => createCarrierSshPool(m, c, { ...opts, Pool }) }); t.after(() => cache.close())
  const machine = { id: 'managed-m', transport: 'ssh', username: 'dev', useAgent: true, expectedHostFingerprint: fp,
    connector: { kind: 'managed-redial-fixture', mode: 'managed', tunnelId: 'abc123', remotePort: 22 } }
  const original = await cache.get(machine, {}); await original.connect()
  closeLease[0]()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(original.carrierClosed, true)
  await assert.rejects(original.connect(), /lease closed/)
  assert.equal(acquisitions, 1, 'no background acquisition after closed')
  assert.equal(sshConnects, 1, 'no replay')
  assert.equal(releases, 1)
  const [next, concurrent] = await Promise.all([cache.get(machine, {}), cache.get(machine, {})])
  assert.equal(next, concurrent); assert.notEqual(next, original)
  assert.equal(next.carrier.generation, '2'); assert.equal(acquisitions, 2)
  await next.connect(); assert.equal(sshConnects, 2)
  await cache.close(); assert.equal(releases, 2)
})
