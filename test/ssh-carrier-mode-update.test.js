// Real sibling devtunnel descriptor/lease + parent record/cache/SshPool contracts.
// Never invokes devtunnel CLI, SSH connect, user profile or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { registerSshCarrier, sshConnectorTargetIdentity } from '../lib/ssh-carrier.js'
import { normalizeCarrierMachine, sanitizeCarrierMachine } from '../lib/ssh-carrier-record.js'
import { createCarrierPoolCache } from '../lib/ssh-carrier-cache.js'

const adapterUrl = new URL('../../dsh-devtunnel-ssh/lib/carrier.js', import.meta.url)
const pin = 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')

test('real machines save branch switches same trusted target, awaits actual SshPool/lease cleanup, never connects or replays', { skip: !existsSync(adapterUrl) }, async t => {
  const { createCarrier } = await import(adapterUrl)
  let starts = 0, stops = 0, persist = 0
  const carrier = createCarrier({ startManaged: async () => {
    starts++
    return { endpoint: { host: '127.0.0.1', port: 12345 }, closed: new Promise(() => {}), close() { stops++ } }
  } })
  const unregister = registerSshCarrier(carrier)
  t.after(async () => { unregister(); await carrier.dispose() })
  const cache = createCarrierPoolCache(); t.after(() => cache.close())
  const previous = normalizeCarrierMachine({ id: 'mode-machine', username: 'dev', useAgent: true, expectedHostFingerprint: pin,
    connector: { kind: 'devtunnel', mode: 'external', tunnelId: 'abc123', remotePort: 22, endpoint: { host: '127.0.0.1', port: 54432 } } })
  const original = await cache.get(previous, {})
  assert.equal(original.client, null)
  const machines = [previous]
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const begin = source.indexOf("              if (Object.prototype.hasOwnProperty.call(body, 'connector')")
  const end = source.indexOf('              if (gatePrev) {', begin)
  assert.ok(begin > 0 && end > begin)
  // Execute the unchanged product branch, not a restatement of its save logic.
  const save = new Function('body', 'gatePrev', 'carrierPools', 'machines', 'normalizeCarrierMachine', 'sanitizeMachine', 'saveMachines', `return (async () => {
    const config = { experimentalSshCarrier: true }, gateId = body.id, gateIdx = 0, isTunnel = false, store = { currentId: '' }, res = {};
    const sendJson = (_, status, data) => ({ status, data });
    ${source.slice(begin, end)}
  })()`)
  const body = { id: previous.id, connector: { kind: 'devtunnel', mode: 'managed', tunnelId: 'abc123', remotePort: 22 } }
  const saved = await save(body, machines[0], cache, machines, normalizeCarrierMachine, sanitizeCarrierMachine, () => {
    persist++; assert.equal(original.carrierClosed, true); assert.equal(cache.peek(previous.id), null)
  })
  assert.equal(saved.status, 200); assert.equal(persist, 1)
  assert.equal(saved.data.machine.id, previous.id); assert.equal(saved.data.machine.expectedHostFingerprint, pin)
  assert.equal(saved.data.machine.connector.endpoint, undefined)
  assert.equal(sshConnectorTargetIdentity(previous.connector), sshConnectorTargetIdentity(machines[0].connector))
  assert.equal(starts, 0, 'save must not start connect')
  await assert.rejects(original.connect(), /lease closed/)
  const managed = await cache.get(machines[0], {})
  assert.equal(starts, 1); assert.equal(managed.client, null)
  const next = await save({ id: previous.id, connector: previous.connector }, machines[0], cache, machines, normalizeCarrierMachine, sanitizeCarrierMachine, () => {
    persist++; assert.equal(managed.carrierClosed, true); assert.equal(stops, 1, 'owned managed process closed before persistence')
  })
  assert.equal(next.status, 200); assert.equal(persist, 2); assert.equal(starts, 1)
  await assert.rejects(managed.connect(), /lease closed/)
  const external = await cache.get(machines[0], {})
  assert.equal(external.config.port, 54432); assert.equal(starts, 1)
  for (const change of [
    { connector: { ...body.connector, tunnelId: 'other' } },
    { connector: { ...body.connector, remotePort: 23 } },
    { expectedHostFingerprint: 'SHA256:' + Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '') },
  ]) {
    const rejected = await save({ id: previous.id, ...change }, machines[0], cache, machines, normalizeCarrierMachine, sanitizeCarrierMachine, () => { throw new Error('must not persist') })
    assert.equal(rejected.status, 400); assert.equal(external.carrierClosed, false)
  }
})
