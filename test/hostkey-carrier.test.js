import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHostKeyGuard, hostKeyId, isHostKeyKnown, keyFingerprint, makeKeyBlob } from '../lib/hostkey.js'

const key = makeKeyBlob('ssh-ed25519', 7)
const fingerprint = createHash('sha256').update(key).digest('base64')
const pin = `SHA256:${fingerprint}`
const carrier = { host: '127.0.0.1', port: 31001, hostKeyIdentity: 'carrier:stable-machine', expectedHostFingerprint: pin }

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hostkey-carrier-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'known_hosts.json')
}

test('exported fingerprint helper hashes the actual raw Buffer bytes', () => {
  assert.ok(Buffer.isBuffer(key))
  assert.equal(keyFingerprint(key), fingerprint)
})

test('exported logical identity stays unchanged across endpoint and port changes', () => {
  assert.equal(hostKeyId(carrier), 'carrier:stable-machine')
  assert.equal(hostKeyId({ ...carrier, host: 'localhost', port: 41002 }), hostKeyId(carrier))
  assert.equal(hostKeyId({ host: 'direct.example', port: 22 }), 'direct.example:22')
})

for (const mode of ['off', 'accept-new', 'verify']) {
  test(`carrier pin strictly verifies raw Buffer in ${mode} without creating trust files`, (t) => {
    const file = fixture(t)
    for (const expectedHostFingerprint of [pin, pin.replace(/=$/, '')]) {
      const guard = createHostKeyGuard({ ...carrier, hostKeyMode: mode, expectedHostFingerprint }, file)
      assert.equal(guard.verifier(key), true)
      assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 8)), false)
      assert.match(guard.lastError, /carrier:stable-machine.*does not match pinned/)
      assert.equal(guard.verifier(undefined), false)
      assert.match(guard.lastError, /missing or invalid/)
      assert.equal(existsSync(file), false)
    }
  })

  test(`carrier missing or malformed pins reject in ${mode} without mutating existing trust`, (t) => {
    const file = fixture(t)
    const original = JSON.stringify({ '127.0.0.1:31001': { fingerprint }, 'carrier:stable-machine': { fingerprint } }, null, 4)
    writeFileSync(file, original)
    const malformedPins = [undefined, null, '', fingerprint, 'SHA256:invalid', `SHA256:${fingerprint}\n`, `sha256:${fingerprint}`, `SHA256:${'A'.repeat(42)}`, `SHA256:${'A'.repeat(43)}==`, `SHA256:${'A'.repeat(42)}B`, 42]
    for (const expectedHostFingerprint of malformedPins) {
      const guard = createHostKeyGuard({ ...carrier, hostKeyMode: mode, expectedHostFingerprint }, file)
      assert.equal(guard.verifier(key), false, String(expectedHostFingerprint))
      assert.match(guard.lastError, /requires a valid expectedHostFingerprint/)
      assert.equal(readFileSync(file, 'utf8'), original)
    }
    const guard = createHostKeyGuard({ ...carrier, hostKeyMode: mode }, file)
    assert.equal(guard.verifier(key), true)
    assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 8)), false)
    assert.equal(readFileSync(file, 'utf8'), original)
  })
}

test('known-host lookup and explicit forget use logical identity while preserving legacy entries', (t) => {
  const file = fixture(t)
  const legacyId = '127.0.0.1:31001'
  const entries = { [carrier.hostKeyIdentity]: { fingerprint }, [legacyId]: { fingerprint }, 'other:22': { fingerprint: 'other' } }
  writeFileSync(file, JSON.stringify(entries))
  const moved = { ...carrier, port: 41002 }
  const guard = createHostKeyGuard(moved, file)
  assert.deepEqual(guard.knownHosts(), entries)
  assert.equal(isHostKeyKnown(file, moved.host, moved.port, moved.hostKeyIdentity), true)
  assert.equal(isHostKeyKnown(file, carrier.host, carrier.port), true)
  assert.equal(isHostKeyKnown(file, moved.host, moved.port), false)
  guard.forgetHost()
  assert.deepEqual(guard.knownHosts(), { [legacyId]: entries[legacyId], 'other:22': entries['other:22'] })
  assert.equal(isHostKeyKnown(file, moved.host, moved.port, moved.hostKeyIdentity), false)
  createHostKeyGuard({ host: carrier.host, port: carrier.port }, file).forgetHost()
  assert.deepEqual(guard.knownHosts(), { 'other:22': entries['other:22'] })
})

test('direct SSH retains off, accept-new, verify and changed-key behavior; pin alone does not enable carrier mode', (t) => {
  const file = fixture(t)
  const direct = { host: 'direct.example', port: 22, expectedHostFingerprint: 'malformed' }
  assert.equal(createHostKeyGuard({ ...direct, hostKeyMode: 'off' }, file).verifier(undefined), true)
  assert.equal(existsSync(file), false)
  assert.equal(createHostKeyGuard({ ...direct, hostKeyMode: 'verify' }, file).verifier(key), false)
  assert.equal(existsSync(file), false)
  assert.equal(createHostKeyGuard(direct, file).verifier(key), true)
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored['direct.example:22'].fingerprint, fingerprint)
  assert.equal(stored['direct.example:22'].algo, 'ssh-ed25519')
  assert.equal(createHostKeyGuard({ ...direct, hostKeyMode: 'verify' }, file).verifier(key), true)
  const original = readFileSync(file, 'utf8')
  const guard = createHostKeyGuard(direct, file)
  assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 8)), false)
  assert.match(guard.lastError, /CHANGED/)
  assert.equal(readFileSync(file, 'utf8'), original)
})
