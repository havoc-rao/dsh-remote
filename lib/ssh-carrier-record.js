// Pure, fail-closed persistence gate. Not enabled in ordinary CRUD until all
// routing/mirror/terminal paths consume this stable model.
import { sshCarrierOf, sshConnectorTargetIdentity, validateSshConnector } from './ssh-carrier.js'

// Inspect descriptors before reading values: a getter is executable input, not
// a persistence record. Provider validation still owns connector field schemas.
function assertPlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`ssh carrier plain ${label} object required`)
  if (Reflect.ownKeys(value).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
  })) throw new Error(`ssh carrier ${label} accessors not allowed`)
}

function sanitizeConnector(connector) {
  assertPlainRecord(connector, 'connector')
  const def = sshCarrierOf(connector.kind)
  if (!def || typeof def.sanitizeConnector !== 'function') throw new Error('ssh carrier persistence sanitizer unavailable')
  const sanitized = def.sanitizeConnector(connector)
  assertPlainRecord(sanitized, 'sanitized connector')
  if (sanitized.kind !== connector.kind) throw new Error('ssh carrier invalid sanitized connector')
  return sanitized
}

export function normalizeCarrierMachine(input, previous = null) {
  assertPlainRecord(input, 'machine')
  if (previous !== null) assertPlainRecord(previous, 'previous machine')
  const has = key => Object.prototype.hasOwnProperty.call(input, key)
  if (has('transport') && input.transport !== 'ssh') throw new Error('ssh carrier requires ssh transport')
  if (previous && !Object.prototype.hasOwnProperty.call(previous, 'connector')) throw new Error('cannot convert direct SSH machine into carrier in place')
  if (has('connector') && (!input.connector || typeof input.connector !== 'object')) throw new Error('cannot downgrade carrier to direct SSH')
  const id = has('id') ? input.id : previous?.id
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('ssh carrier stable machine id required')
  if (previous && id !== previous.id) throw new Error('ssh carrier machine id cannot change')
  const connector = has('connector') ? input.connector : previous?.connector
  const sanitized = sanitizeConnector(connector)
  const targetIdentity = sshConnectorTargetIdentity(sanitized)
  if (previous) {
    assertPlainRecord(previous.connector, 'previous connector')
    if (sshConnectorTargetIdentity(previous.connector) !== targetIdentity) throw new Error('ssh carrier target cannot change in place; add a new machine')
  }
  const pick = (key, fallback = '') => has(key) ? input[key] : previous?.[key] ?? fallback
  const text = key => {
    const value = pick(key)
    if (typeof value !== 'string') throw new Error(`ssh carrier ${key} must be a string`)
    return value
  }
  const flag = key => {
    const value = pick(key, false)
    if (typeof value !== 'boolean') throw new Error(`ssh carrier ${key} must be a boolean`)
    return value
  }
  const record = {
    id, name: text('name').trim() || id, transport: 'ssh',
    connector: sanitized,
    username: text('username').trim(),
    privateKeyPath: text('privateKeyPath').trim(),
    passphrase: text('passphrase'),
    password: text('password'),
    useAgent: flag('useAgent'),
    keyboardInteractive: flag('keyboardInteractive'),
    workspace: text('workspace').trim(),
    hostKeyMode: 'verify', expectedHostFingerprint: text('expectedHostFingerprint').trim(),
  }
  if (!record.username) throw new Error('ssh carrier username required')
  const fp = record.expectedHostFingerprint
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(fp) || Buffer.from(fp.slice(7), 'base64').toString('base64').replace(/=+$/, '') !== fp.slice(7).replace(/=+$/, '')) throw new Error('ssh carrier confirmed SHA256 fingerprint required')
  if (previous && previous.expectedHostFingerprint !== fp) throw new Error('ssh carrier fingerprint cannot change in place; explicit re-trust required')
  validateSshConnector({ ...record, useSshConfig: pick('useSshConfig', false), proxy: pick('proxy', undefined) })
  return record
}

// Browser projection is a separate boundary, never the internal auth-bearing
// record. In particular do not spread the raw machine or connector here.
export function sanitizeCarrierMachine(machine) {
  const record = normalizeCarrierMachine(machine)
  return {
    id: record.id, name: record.name, transport: record.transport,
    connector: record.connector,
    username: record.username, privateKeyPath: record.privateKeyPath,
    useAgent: record.useAgent, keyboardInteractive: record.keyboardInteractive,
    workspace: record.workspace, hostKeyMode: record.hostKeyMode,
    expectedHostFingerprint: record.expectedHostFingerprint,
    passwordSet: record.password.length > 0,
    passphraseSet: record.passphrase.length > 0,
  }
}
