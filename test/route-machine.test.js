import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findMirrorsForRemotePath, pickMirrorForRemotePath, normalizeRoutePath, machineForMirror } from '../lib/route-machine.js'
import { registerSshCarrier } from '../lib/ssh-carrier.js'

function registerFixtureCarrier(t) {
  t.after(registerSshCarrier({
    id: 'route-fixture',
    acquire() { throw new Error('routing must not acquire a carrier') },
    targetIdentity(connector) {
      if (!connector.config || typeof connector.config.target !== 'string' || !connector.config.target.trim()) throw new Error('invalid target')
      return connector.config.target
    },
  }))
}
const fixtureConnector = (target = 'canonical-target') => ({ kind: 'route-fixture', config: { target } })

/** Build a fake <mirrorRoot>/<tag>/<base>/.dsh-remote-meta.json tree. */
function makeMirrorRoot(specs) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-route-machine-'))
  for (const s of specs) {
    const dir = path.join(root, s.tag, s.base)
    mkdirSync(dir, { recursive: true })
    const meta = {
      host: s.host, port: s.port, username: s.username ?? 'root', remotePath: s.remotePath,
    }
    // Mirror meta v2 extras (carried through only when present).
    if (s.transport) meta.transport = s.transport
    if (s.machineId) meta.machineId = s.machineId
    if (s.remoteIdentity) meta.remoteIdentity = s.remoteIdentity
    if ('schemaVersion' in s) meta.schemaVersion = s.schemaVersion
    if ('connectorTargetIdentity' in s) meta.connectorTargetIdentity = s.connectorTargetIdentity
    writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify(meta))
  }
  return root
}

// Descriptor identities come from registered carrier code, never caller input
// or the transient CLI lease targetIdentity.
test('schema3 requires exact saved carrier descriptor and rejects direct lookalikes', (t) => {
  registerFixtureCarrier(t)
  const meta = { schemaVersion: 3, transport: 'ssh', machineId: 'carrier', connectorTargetIdentity: 'canonical-target', host: 'localhost', port: 22, username: 'root' }
  const carrier = { id: 'carrier', transport: 'ssh', connector: fixtureConnector(), host: 'localhost', port: 22, username: 'root' }
  const direct = { id: 'direct', host: 'localhost', port: 22, username: 'root' }
  assert.equal(machineForMirror(meta, [direct, carrier]).record, carrier)
  const forged = { ...carrier, connector: { ...fixtureConnector(), targetIdentity: 'runtime-lease-target' } }
  assert.equal(machineForMirror(meta, [forged]).record, forged, 'caller identity cannot override the canonical descriptor')
  for (const bad of [
    { ...carrier, id: 'other' },
    { ...carrier, connector: undefined },
    { ...carrier, connector: {} },
    { ...carrier, connector: [] },
    { ...carrier, connector: { kind: 'INVALID', targetIdentity: 'canonical-target' } },
    { ...carrier, connector: fixtureConnector('other-target') },
    { ...carrier, connector: { kind: 'unregistered', config: { target: 'canonical-target' }, targetIdentity: 'canonical-target' } },
    { ...carrier, connector: { kind: 'route-fixture', targetIdentity: 'canonical-target' } },
    { ...carrier, connector: fixtureConnector(' ') },
    { ...carrier, connector: fixtureConnector(42) },
    { ...carrier, connector: { ...fixtureConnector('other-target'), targetIdentity: 'canonical-target' } },
    { ...carrier, transport: 'vscode-tunnel' },
  ]) assert.equal(machineForMirror(meta, [direct, bad]), null)
  for (const bad of [
    { ...meta, machineId: '' }, { ...meta, machineId: 42 },
    { ...meta, connectorTargetIdentity: ' ' }, { ...meta, transport: undefined },
    { ...meta, schemaVersion: 4 }, { ...meta, schemaVersion: '3' },
  ]) assert.equal(machineForMirror(bad, [direct, carrier]), null)
  const legacy = { host: 'localhost', port: 22, username: 'root' }
  assert.equal(machineForMirror(legacy, [carrier, { ...direct, id: 'tunnel', transport: 'vscode-tunnel' }, direct]).record, direct)
  assert.equal(machineForMirror(legacy, [carrier, { ...direct, connector: null }]).record, null)
})

test('schema3 remote scan preserves strict markers and preference uses saved descriptor identity', (t) => {
  registerFixtureCarrier(t)
  const common = { base: 'proj', host: 'localhost', port: 22, username: 'root', remotePath: '/proj', schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: 'canonical-target' }
  const root = makeMirrorRoot([
    { ...common, tag: 'a', machineId: 'one' },
    { ...common, tag: 'b', machineId: 'two' },
    { ...common, tag: 'broken', machineId: 'broken', connectorTargetIdentity: null },
  ])
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scanned = findMirrorsForRemotePath(root, '/proj/child')
  assert.equal(scanned.length, 3)
  assert.equal(scanned[0].schemaVersion, 3)
  assert.equal(scanned[0].connectorTargetIdentity, 'canonical-target')
  assert.equal(machineForMirror(scanned.find(m => m.machineId === 'broken'), []), null)
  const current = { id: 'two', connector: fixtureConnector() }
  assert.equal(pickMirrorForRemotePath(root, '/proj', current).machineId, 'two')
  for (const connector of [
    { kind: 'unregistered', targetIdentity: 'canonical-target' },
    { kind: 'route-fixture', targetIdentity: 'canonical-target' },
    { ...fixtureConnector('other-target'), targetIdentity: 'canonical-target' },
  ]) assert.equal(pickMirrorForRemotePath(root, '/proj', { ...current, connector }, m => m.machineId === 'one').machineId, 'one', 'invalid/forged carrier cannot claim current-machine preference')
  // A triple lookalike cannot claim strict origins as its current-machine match.
  assert.equal(pickMirrorForRemotePath(root, '/proj', { host: 'localhost', port: 22, username: 'root' }, m => m.machineId === 'two').machineId, 'two')
})

test('schema3 fails closed when registered carriers lack a usable identity function', (t) => {
  const meta = { schemaVersion: 3, transport: 'ssh', machineId: 'carrier', connectorTargetIdentity: 'canonical-target' }
  for (const [kind, targetIdentity] of [
    ['route-no-identity', undefined], ['route-empty-identity', () => ' '],
    ['route-invalid-identity', () => 42], ['route-throwing-identity', () => { throw new Error('malformed config') }],
  ]) {
    t.after(registerSshCarrier({ id: kind, acquire() {}, targetIdentity }))
    assert.equal(machineForMirror(meta, [{ id: 'carrier', connector: { kind, targetIdentity: 'canonical-target' } }]), null)
  }
})

test('normalizeRoutePath collapses slashes and trims the trailing separator', () => {
  assert.equal(normalizeRoutePath('/a/b/'), '/a/b')
  assert.equal(normalizeRoutePath('C:\\Users\\dev\\'), 'C:/Users/dev')
  assert.equal(normalizeRoutePath('//a//b///'), '/a/b')
  assert.equal(normalizeRoutePath(''), '/')
  assert.equal(normalizeRoutePath('/'), '/')
})

test('findMirrorsForRemotePath: equal and child paths match; strangers do not', () => {
  const root = makeMirrorRoot([
    { tag: 'h5-root-36000', base: 'luban', host: 'h5', port: 36000, remotePath: '/data/workspace/luban-grafana' },
    { tag: 'h17-root-36000', base: 'wxa', host: 'h17', port: 36000, remotePath: '/data/workspace/wxa-agent-dashboard' },
  ])
  try {
    assert.equal(findMirrorsForRemotePath(root, '/data/workspace/luban-grafana').length, 1)
    const child = findMirrorsForRemotePath(root, '/data/workspace/luban-grafana/api/cli.js')
    assert.equal(child.length, 1)
    assert.equal(child[0].host, 'h5')
    assert.equal(child[0].tag, 'h5-root-36000')
    assert.equal(findMirrorsForRemotePath(root, '/data/workspace/other').length, 0)
    assert.equal(findMirrorsForRemotePath(root, '/').length, 0)
    assert.equal(findMirrorsForRemotePath(root, '/data').length, 0) // cover requires full remotePath prefix
    assert.equal(findMirrorsForRemotePath('/nonexistent-root', '/data/workspace/luban-grafana').length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pickMirrorForRemotePath prefers the CURRENT machine mirror over a saved one', () => {
  const root = makeMirrorRoot([
    { tag: 'h17-root-36000', base: 'wxa', host: 'h17', port: 36000, username: 'root', remotePath: '/data/workspace/wxa-agent-dashboard' },
    { tag: 'h5-root-36000', base: 'wxa', host: 'h5', port: 36000, username: 'root', remotePath: '/data/workspace/wxa-agent-dashboard' },
  ])
  try {
    const cur = { host: 'h17', port: 36000, username: 'root' }
    const picked = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', cur)
    assert.equal(picked.host, 'h17')
    // Without a current machine, a "saved" (connectable) machine wins. The
    // isSaved callback receives the FULL mirror entry (signature changed from
    // the old (host, port, username) triple).
    const savedFirst = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', null, (entry) => entry.host === 'h5')
    assert.equal(savedFirst.host, 'h5')
    // Otherwise the first match wins.
    const first = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', null)
    assert.ok(first.host === 'h17' || first.host === 'h5')
    assert.equal(pickMirrorForRemotePath(root, '/elsewhere', cur), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real mirror registry on this machine resolves the known remotes', () => {
  // The user's actual data (skipped when the workspace machine has none).
  const root = path.join(os.homedir(), '.dsh', 'remote-workspaces')
  if (!existsSync(path.join(root, 'machines.json')) && !existsSync(root)) return
  const luban = pickMirrorForRemotePath(root, '/data/workspace/luban-grafana', null)
  const wxa = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', null)
  if (!luban && !wxa) return // mirrors absent on this machine — nothing to assert
  if (luban) assert.equal(luban.remotePath, '/data/workspace/luban-grafana')
  if (wxa) assert.equal(wxa.remotePath, '/data/workspace/wxa-agent-dashboard')
})

test('findMirrorsForRemotePath: v2 (transport) metas pass transport/machineId/remoteIdentity through; v1 entries stay bare', () => {
  const root = makeMirrorRoot([
    { tag: 'tunnel-m9', base: 'proj', host: '127.0.0.1', port: 0, username: '', transport: 'vscode-tunnel', machineId: 'm9', remoteIdentity: 'rmt-9', remotePath: '/srv/t/proj' },
    { tag: 'h5-root-36000', base: 'luban', host: 'h5', port: 36000, remotePath: '/data/workspace/luban-grafana' },
  ])
  try {
    const tunnel = findMirrorsForRemotePath(root, '/srv/t/proj')
    assert.equal(tunnel.length, 1)
    assert.equal(tunnel[0].host, '127.0.0.1')
    assert.equal(tunnel[0].transport, 'vscode-tunnel')
    assert.equal(tunnel[0].machineId, 'm9')
    assert.equal(tunnel[0].remoteIdentity, 'rmt-9')
    assert.equal(tunnel[0].tag, 'tunnel-m9')
    // v1 entry shape is untouched (regression: no transport identity keys).
    const v1 = findMirrorsForRemotePath(root, '/data/workspace/luban-grafana')
    assert.equal(v1.length, 1)
    assert.deepEqual(Object.keys(v1[0]).sort(), ['host', 'mirrorDir', 'port', 'remotePath', 'tag', 'username'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pickMirrorForRemotePath: isSaved receives the FULL mirror entry (v2 saved ⇔ machineId + transport match)', () => {
  const root = makeMirrorRoot([
    { tag: 'tunnel-m9', base: 'wxa', host: '127.0.0.1', port: 0, username: '', transport: 'vscode-tunnel', machineId: 'm9', remotePath: '/srv/t/wxa' },
    { tag: 'tunnel-m2', base: 'wxa', host: '127.0.0.1', port: 0, username: '', transport: 'vscode-tunnel', machineId: 'm2', remotePath: '/srv/t/wxa' },
  ])
  try {
    const seen = []
    const picked = pickMirrorForRemotePath(root, '/srv/t/wxa', null, (entry) => {
      seen.push(entry)
      return entry.transport === 'vscode-tunnel' && entry.machineId === 'm2'
    })
    assert.equal(picked.machineId, 'm2')
    // isSaved receives the FULL entry (dir order is filesystem-dependent, so
    // only the winning call is guaranteed — it must carry the v2 identity).
    assert.ok(seen.length >= 1)
    assert.ok(seen.every((e) => e.transport === 'vscode-tunnel' && 'machineId' in e), 'every consulted entry is a full v2 entry')
    // A tunnel mirror whose machineId is NOT saved is not "saved" — the pick
    // falls back to the first match (legacy v1 behavior for no-saved-match).
    const fallback = pickMirrorForRemotePath(root, '/srv/t/wxa', null, (e) => e.machineId === 'ghost')
    assert.ok(fallback)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('machineForMirror: v2 resolves by stable machineId + transport; missing → null (never the placeholder-triple lookalike)', () => {
  const registry = [
    { id: 'm9', name: 'mac', transport: 'vscode-tunnel', host: '127.0.0.1', port: 0, username: '' },
    { id: 'm2', name: 'mac2', transport: 'vscode-tunnel', host: '127.0.0.1', port: 0, username: '' },
    { id: 'ssh1', name: 'box', host: 'h5', port: 36000, username: 'root' },
  ]
  // v2: exact id + transport → the record.
  const hit = machineForMirror({ host: '127.0.0.1', port: 0, username: '', transport: 'vscode-tunnel', machineId: 'm9' }, registry)
  assert.equal(hit.record.id, 'm9')
  assert.equal(hit.transport, 'vscode-tunnel')
  assert.equal(hit.machineId, 'm9')
  // v2: id NOT in the registry → null, even though another machine shares the
  // exact placeholder host/port/user triple (the ssh-guess trap).
  const ghost = machineForMirror({ host: '127.0.0.1', port: 0, username: 'root', transport: 'vscode-tunnel', machineId: 'm7' }, registry)
  assert.equal(ghost, null)
  // v2: id exists but transport differs → null.
  assert.equal(machineForMirror({ host: '127.0.0.1', port: 0, username: '', transport: 'vscode-tunnel', machineId: 'ssh1' }, registry), null)
  // v2: machineId missing entirely → null.
  assert.equal(machineForMirror({ host: '127.0.0.1', port: 0, username: '', transport: 'vscode-tunnel' }, registry), null)
  // v1: legacy host/port/username triple lookup (record or { record: null }).
  const v1 = machineForMirror({ host: 'h5', port: 36000, username: 'root' }, registry)
  assert.equal(v1.record.id, 'ssh1')
  assert.equal(v1.transport, 'ssh')
  assert.equal(v1.machineId, null)
  const v1miss = machineForMirror({ host: 'h5', port: 36000, username: 'nobody' }, registry)
  assert.equal(v1miss.record, null)
  assert.equal(v1miss.transport, 'ssh')
  // An explicit transport:'ssh' meta resolves exactly like a bare v1 meta.
  assert.equal(machineForMirror({ host: 'h5', port: 36000, username: 'root', transport: 'ssh' }, registry).record.id, 'ssh1')
  // Missing/absent registry is tolerated (empty lookup, no throw).
  assert.equal(machineForMirror({ host: 'h5', port: 36000, username: 'root' }, null).record, null)
  assert.equal(machineForMirror({ transport: 'vscode-tunnel', machineId: 'm9' }, undefined), null)
})