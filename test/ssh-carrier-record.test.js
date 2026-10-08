import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSshCarrier, sshConnectorTargetIdentity } from '../lib/ssh-carrier.js'
import { normalizeCarrierMachine, sanitizeCarrierMachine } from '../lib/ssh-carrier-record.js'
const pin = 'SHA256:' + Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')
function fixture(t) {
  const normalize = c => {
    if (!c || c.kind !== 'record-fixture' || typeof c.tunnelId !== 'string' || Object.keys(c).some(k => !['kind', 'tunnelId', 'mode', 'endpoint'].includes(k))) throw new Error('invalid connector')
    return { kind: c.kind, tunnelId: c.tunnelId, mode: c.mode || 'external', ...(c.endpoint ? { endpoint: { ...c.endpoint } } : {}) }
  }
  const dispose = registerSshCarrier({ id: 'record-fixture', acquire() {}, sanitizeConnector: normalize, validateConnector: normalize, targetIdentity: c => JSON.stringify([normalize(c).kind, c.tunnelId, 22]) })
  t.after(dispose)
  return { id: 'mac-b', connector: { kind: 'record-fixture', tunnelId: 'one.jpe1', endpoint: { host: '127.0.0.1', port: 50736 } }, username: 'remote', expectedHostFingerprint: pin, useAgent: true }
}

test('record persistence strips runtime SSH endpoints and forces strict trust', t => {
  const input = fixture(t)
  const record = normalizeCarrierMachine({ ...input, host: 'trap', port: 22, hostKeyMode: 'off', generation: 'secret-runtime' })
  assert.equal(record.transport, 'ssh')
  assert.equal(record.hostKeyMode, 'verify')
  assert.equal(record.host, undefined)
  assert.equal(record.port, undefined)
  assert.equal(record.generation, undefined)
  assert.equal(record.expectedHostFingerprint, pin)
})

test('endpoint change preserves descriptor identity and SSH credentials', t => {
  const input = fixture(t)
  const previous = normalizeCarrierMachine({ ...input, privateKeyPath: '/fixture/key', password: 'internal-password', passphrase: 'internal-passphrase' })
  const next = normalizeCarrierMachine({ connector: { ...input.connector, endpoint: { host: '127.0.0.1', port: 64894 } } }, previous)
  assert.equal(sshConnectorTargetIdentity(previous.connector), sshConnectorTargetIdentity(next.connector))
  assert.equal(next.privateKeyPath, '/fixture/key')
  assert.equal(next.password, 'internal-password')
  assert.equal(next.passphrase, 'internal-passphrase')
  const renamed = normalizeCarrierMachine({ name: 'Renamed' }, previous)
  assert.equal(renamed.password, previous.password)
  assert.equal(renamed.passphrase, previous.passphrase)
  const cleared = normalizeCarrierMachine({ password: '', passphrase: '' }, previous)
  assert.equal(cleared.password, '')
  assert.equal(cleared.passphrase, '')
  assert.equal(next.id, 'mac-b')
})

test('target, trust and transport changes fail closed', t => {
  const input = fixture(t)
  const previous = normalizeCarrierMachine(input)
  assert.throws(() => normalizeCarrierMachine({ connector: { ...input.connector, tunnelId: 'other.jpe1' } }, previous), /target cannot change/)
  assert.throws(() => normalizeCarrierMachine({ expectedHostFingerprint: 'SHA256:' + Buffer.alloc(32).toString('base64') }, previous), /fingerprint cannot change/)
  assert.throws(() => normalizeCarrierMachine({ connector: null }, previous), /downgrade/)
  assert.throws(() => normalizeCarrierMachine(input, { id: 'mac-b', host: 'localhost' }), /convert direct/)
  assert.throws(() => normalizeCarrierMachine({ ...input, proxy: { host: 'trap' } }), /cannot combine/)
  assert.throws(() => normalizeCarrierMachine({ ...input, useSshConfig: true }), /cannot combine/)
  assert.throws(() => normalizeCarrierMachine({ ...input, transport: 'vscode-tunnel' }), /requires ssh transport/)
})

test('browser projection excludes credentials and raw connector secrets', t => {
  const input = fixture(t)
  const browser = sanitizeCarrierMachine({ ...input, password: 'password-secret', passphrase: 'passphrase-secret', credentialRef: 'credential-secret', token: 'machine-secret' })
  assert.equal(browser.passwordSet, true)
  assert.equal(browser.passphraseSet, true)
  assert.equal(browser.expectedHostFingerprint, pin)
  for (const field of ['password', 'passphrase', 'credentialRef', 'token']) assert.equal(Object.hasOwn(browser, field), false)
  const serialized = JSON.stringify(browser)
  for (const secret of ['password-secret', 'passphrase-secret', 'credential-secret', 'machine-secret']) assert.equal(serialized.includes(secret), false)
  const empty = sanitizeCarrierMachine(input)
  assert.equal(empty.passwordSet, false)
  assert.equal(empty.passphraseSet, false)

  let calls = 0
  t.after(registerSshCarrier({
    id: 'redacting-fixture', acquire() {},
    sanitizeConnector: c => { calls++; return { kind: c.kind, tunnelId: c.tunnelId } },
    validateConnector: c => assert.deepEqual(Object.keys(c).sort(), ['kind', 'tunnelId']),
    targetIdentity: c => c.tunnelId,
  }))
  const redacted = sanitizeCarrierMachine({ ...input, connector: { kind: 'redacting-fixture', tunnelId: 'safe-target', token: 'connector-secret', credentialRef: 'connector-credential-secret', password: 'connector-password-secret' } })
  assert.equal(calls, 1)
  assert.deepEqual(redacted.connector, { kind: 'redacting-fixture', tunnelId: 'safe-target' })
  assert.equal(JSON.stringify(redacted).includes('secret'), false)
})

test('auth values reject unknown types without invoking coercion', t => {
  const input = fixture(t)
  const previous = normalizeCarrierMachine(input)
  let coerced = false
  const object = { toString() { coerced = true; return 'secret' } }
  for (const field of ['username', 'privateKeyPath', 'password', 'passphrase']) {
    for (const value of [object, {}, [], 1, true, null, undefined]) {
      assert.throws(() => normalizeCarrierMachine({ ...input, [field]: value }), /must be a string/)
      assert.throws(() => normalizeCarrierMachine({ [field]: value }, previous), /must be a string/)
    }
  }
  for (const field of ['useAgent', 'keyboardInteractive']) {
    for (const value of [object, 'false', 1, null, undefined]) assert.throws(() => normalizeCarrierMachine({ ...input, [field]: value }), /must be a boolean/)
  }
  assert.equal(coerced, false)
})

test('machine and connector boundaries reject accessors and non-plain records', t => {
  const input = fixture(t)
  const previous = normalizeCarrierMachine(input)
  let reads = 0
  for (const operation of [normalizeCarrierMachine, sanitizeCarrierMachine]) {
    for (const machine of [Object.assign(Object.create({}), input), Object.assign(new Date(), input), []]) assert.throws(() => operation(machine), /plain machine/)
    for (const field of ['password', 'connector', 'ignored']) {
      const machine = { ...input }
      Object.defineProperty(machine, field, { get() { reads++; return 'trap' } })
      assert.throws(() => operation(machine), /accessors/)
    }
    const connector = { ...input.connector }
    Object.defineProperty(connector, 'kind', { get() { reads++; return 'record-fixture' } })
    assert.throws(() => operation({ ...input, connector }), /accessors/)
    assert.throws(() => operation({ ...input, connector: Object.assign(Object.create({}), input.connector) }), /plain connector/)
  }
  const unsafePrevious = { ...previous }
  Object.defineProperty(unsafePrevious, 'password', { get() { reads++; return 'trap' } })
  assert.throws(() => normalizeCarrierMachine({ name: 'next' }, unsafePrevious), /accessors/)
  assert.equal(reads, 0)
  assert.equal(normalizeCarrierMachine(Object.assign(Object.create(null), input)).id, input.id)
})

test('forged descriptor identity or secret connector fields are rejected', t => {
  const input = fixture(t)
  for (const field of ['targetIdentity', 'token', 'password', 'generation']) {
    assert.throws(() => normalizeCarrierMachine({ ...input, connector: { ...input.connector, [field]: 'trap' } }), /invalid connector/)
  }
  assert.throws(() => normalizeCarrierMachine({ ...input, expectedHostFingerprint: '' }), /fingerprint required/)
})
