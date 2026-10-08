import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSshCarrier, sshCarrierIds, acquireSshCarrier } from '../lib/ssh-carrier.js'
import { createCarrierSshPool } from '../lib/ssh-carrier-pool.js'

const pin = 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')
function fixture(id) {
  let stop
  let releases = 0
  let acquires = 0
  const closed = new Promise(resolve => { stop = resolve })
  const dispose = registerSshCarrier({ id, acquire: async () => {
    acquires++
    return { dialHost: '127.0.0.1', dialPort: 50736, targetIdentity: 'tunnel.remote:22', generation: 'g1', closed, release() { releases++ } }
  } })
  return { dispose, stop, get releases() { return releases }, get acquires() { return acquires }, machine: { id: 'm1', transport: 'ssh', connector: { kind: id }, username: 'remote', expectedHostFingerprint: pin } }
}
class FakePool {
  constructor(config) { this.config = config; this.closes = 0 }
  connect() { return Promise.resolve('client') }
  close() { this.closes++ }
}

test('carrier registry disposer cannot remove a replacement', () => {
  const f = fixture('registry-test')
  assert.ok(sshCarrierIds().includes('registry-test'))
  assert.throws(() => fixture('registry-test'), /already registered/)
  f.dispose()
  const g = fixture('registry-test')
  f.dispose()
  assert.ok(sshCarrierIds().includes('registry-test'))
  g.dispose()
})

test('unknown/invalid connector never acquires a direct endpoint', async () => {
  await assert.rejects(acquireSshCarrier({ id: 'm', connector: { kind: 'missing' } }), /not installed/)
  const f = fixture('validation-test')
  try {
    await assert.rejects(acquireSshCarrier({ ...f.machine, useSshConfig: true }), /cannot combine/)
    await assert.rejects(acquireSshCarrier({ ...f.machine, id: '' }), /stable machine/)
    assert.equal(f.acquires, 0)
  } finally { f.dispose() }
})

test('carrier acquisition rejects external endpoints and releases lease', async () => {
  let releases = 0
  const dispose = registerSshCarrier({ id: 'bad-endpoint', acquire: async () => ({ dialHost: 'example.com', release() { releases++ } }) })
  try {
    await assert.rejects(acquireSshCarrier({ id: 'm', connector: { kind: 'bad-endpoint' } }), /invalid lease/)
    assert.equal(releases, 1)
  } finally { dispose() }
})

test('carrier factory requires pin before CLI acquire', async () => {
  const f = fixture('pin-test')
  try {
    await assert.rejects(createCarrierSshPool({ ...f.machine, expectedHostFingerprint: '' }, {}, { Pool: FakePool }), /confirmed/)
    assert.equal(f.acquires, 0)
  } finally { f.dispose() }
})

test('factory pins stable identity and owns exactly one release', async () => {
  const f = fixture('pool-test')
  try {
    const pool = await createCarrierSshPool(f.machine, { hostKeyMode: 'off', proxy: { host: 'trap' } }, { Pool: FakePool })
    assert.equal(pool.config.port, 50736)
    assert.equal(pool.config.proxy, undefined)
    assert.equal(pool.config.hostKeyMode, 'verify')
    assert.equal(pool.config.expectedHostFingerprint, pin)
    assert.deepEqual(JSON.parse(pool.config.hostKeyIdentity), ['ssh-carrier', 'm1', 'tunnel.remote:22'])
    assert.equal(await pool.connect(), 'client')
    await pool.close()
    await pool.close()
    assert.equal(f.releases, 1)
    assert.equal(pool.closes, 1)
    await assert.rejects(pool.connect(), /lease closed/)
  } finally { f.dispose() }
})

test('stale adapter getter still releases failed acquisition', async () => {
  let releases = 0
  const dispose = registerSshCarrier({ id: 'stale-getter', acquire: async () => ({ get dialHost() { throw new Error('STALE_LEASE') }, release() { releases++ } }) })
  try {
    await assert.rejects(acquireSshCarrier({ id: 'm', connector: { kind: 'stale-getter' } }), /invalid lease/)
    assert.equal(releases, 1)
  } finally { dispose() }
})

test('abort after pool creation closes and releases once', async () => {
  const f = fixture('abort-pool')
  const controller = new AbortController()
  try {
    const pool = await createCarrierSshPool(f.machine, {}, { Pool: FakePool, signal: controller.signal })
    controller.abort()
    await pool.close()
    assert.equal(pool.closes, 1)
    assert.equal(f.releases, 1)
    await assert.rejects(pool.connect(), /lease closed/)
  } finally { f.dispose() }
})

test('throwing pool cleanup still releases reachability', async () => {
  const f = fixture('throwing-close')
  class ThrowPool extends FakePool { close() { throw new Error('close failed') } }
  try {
    const pool = await createCarrierSshPool(f.machine, {}, { Pool: ThrowPool })
    await assert.rejects(pool.close(), /close failed/)
    assert.equal(f.releases, 1)
    await assert.rejects(pool.connect(), /lease closed/)
  } finally { f.dispose() }
})

test('asynchronous SSH cleanup completes before carrier release', async () => {
  const f = fixture('async-close')
  let finish
  const closing = new Promise(resolve => { finish = resolve })
  class AsyncPool extends FakePool { close() { return closing } }
  try {
    const pool = await createCarrierSshPool(f.machine, {}, { Pool: AsyncPool })
    const cleanup = pool.close()
    await Promise.resolve()
    assert.equal(f.releases, 0)
    finish()
    await cleanup
    assert.equal(f.releases, 1)
  } finally { f.dispose() }
})

test('carrier invalidation closes pool and releases lease', async () => {
  const f = fixture('invalidation-test')
  try {
    const pool = await createCarrierSshPool(f.machine, {}, { Pool: FakePool })
    f.stop()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(pool.closes, 1)
    assert.equal(f.releases, 1)
    await assert.rejects(pool.connect(), /lease closed/)
  } finally { f.dispose() }
})
