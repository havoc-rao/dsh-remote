import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSshCarrier } from '../lib/ssh-carrier.js'
import { createCarrierPoolCache } from '../lib/ssh-carrier-cache.js'
function setup(t, factory) {
  const dispose = registerSshCarrier({ id: 'cache-fixture', acquire() {}, targetIdentity: c => c.target })
  t.after(dispose)
  const cache = createCarrierPoolCache({ createPool: factory })
  t.after(() => cache.close())
  const machine = { id: 'm1', connector: { kind: 'cache-fixture', target: 'b' }, username: 'remote', expectedHostFingerprint: 'pin' }
  return { cache, machine }
}
function pool() { return { closes: 0, carrierClosed: false, close() { this.closes++; this.carrierClosed = true } } }

test('concurrent same-machine acquisition shares one pool, different ids isolated', async t => {
  let creates = 0
  const { cache, machine } = setup(t, async () => { creates++; return pool() })
  const [a, b] = await Promise.all([cache.get(machine), cache.get(machine)])
  assert.equal(a, b)
  assert.equal(creates, 1)
  const other = await cache.get({ ...machine, id: 'm2' })
  assert.notEqual(a, other)
  await cache.invalidate(machine.id)
  assert.equal(a.closes, 1)
  assert.equal(other.closes, 0)
})

test('credentials/endpoint change invalidates old pool; failed acquire not cached', async t => {
  let creates = 0
  const { cache, machine } = setup(t, async () => { creates++; if (creates === 1) throw new Error('fixture failure'); return pool() })
  await assert.rejects(cache.get(machine), /fixture failure/)
  const a = await cache.get(machine)
  const b = await cache.get({ ...machine, privateKeyPath: '/new/key' })
  assert.notEqual(a, b)
  assert.equal(a.closes, 1)
  b.carrierClosed = true
  assert.notEqual(await cache.get({ ...machine, privateKeyPath: '/new/key' }), b)
})

test('timeout configuration changes replace cached pool rather than retaining stale limits', async t => {
  const { cache, machine } = setup(t, async () => pool())
  const original = await cache.get(machine, { commandTimeoutMs: 15000, transferTimeoutMs: 20000 })
  const updated = await cache.get(machine, { commandTimeoutMs: 15000, transferTimeoutMs: 180000 })
  assert.notEqual(original, updated)
  assert.equal(original.closes, 1)
  assert.equal(await cache.get(machine, { commandTimeoutMs: 15000, transferTimeoutMs: 180000 }), updated)
})

test('pending acquire uses immutable record snapshot', async t => {
  let received
  const { cache, machine } = setup(t, async m => { received = m; return pool() })
  const pending = cache.get(machine)
  machine.username = 'changed-user'
  machine.connector.target = 'changed-target'
  await pending
  assert.equal(received.username, 'remote')
  assert.equal(received.connector.target, 'b')
})

test('concurrent revision replacement shares one new acquisition', async t => {
  let creates = 0
  const { cache, machine } = setup(t, async () => { creates++; return pool() })
  const original = await cache.get(machine)
  const updated = { ...machine, privateKeyPath: '/next/key' }
  const [a, b] = await Promise.all([cache.get(updated), cache.get(updated)])
  assert.equal(a, b)
  assert.equal(original.closes, 1)
  assert.equal(creates, 2)
})

test('invalidate during asynchronous acquisition closes late pool and blocks reuse', async t => {
  let finish
  const delayed = new Promise(resolve => { finish = resolve })
  const { cache, machine } = setup(t, () => delayed)
  const pending = cache.get(machine)
  const checked = assert.rejects(pending, /invalidated/)
  await Promise.resolve()
  const closing = cache.invalidate(machine.id)
  const late = pool()
  finish(late)
  await checked
  await closing
  assert.equal(late.closes, 1)
  await cache.close()
  await assert.rejects(cache.get(machine), /disposed/)
})
