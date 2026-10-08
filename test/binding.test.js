// Session → remote-binding resolution (issue #25).
//
// The bug: SSH connection and remote workspace were process-global, so two
// sessions working on DIFFERENT machines took the connection from each other
// and commands landed on the wrong host — silently, because the connection
// itself was healthy.
//
// The fix these tests pin: a session's remote target comes from its own
// workspace mirror's `.dsh-remote-meta.json`, so it never depends on which
// machine happens to be active, and two machines never share a pool key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveMirror, poolKey } from '../lib/binding.js'
import { machineForMirror } from '../lib/route-machine.js'
import { registerSshCarrier } from '../lib/ssh-carrier.js'

const root = () => mkdtempSync(path.join(tmpdir(), 'dsh-remote-bind-'))

/** Create a mirror dir with its origin meta, as ensureMirror() does. */
function mirror(rootDir, { host, port = 22, username, remotePath, base }) {
  const tag = [host, username, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  const dir = path.join(rootDir, tag, base)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host, port, username, remotePath }))
  return dir
}

test('resolveMirror: a session cwd resolves to ITS OWN mirror machine, not a shared one', () => {
  const d = root()
  const linux = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })
  const win = mirror(d, { host: '10.0.0.2', username: 'Administrator', remotePath: 'C:\\work\\tool', base: 'tool' })

  const a = resolveMirror(linux, d)
  const b = resolveMirror(win, d)

  assert.equal(a.machine.host, '10.0.0.1')
  assert.equal(a.remotePath, '/home/lucas/proj')
  assert.equal(b.machine.host, '10.0.0.2')
  assert.equal(b.remotePath, 'C:\\work\\tool')
  // The two sessions must not be able to reach each other's connection.
  assert.notEqual(poolKey(a.machine), poolKey(b.machine))
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: a path NESTED inside a mirror resolves to that mirror', () => {
  const d = root()
  const m = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })
  const nested = path.join(m, 'src', 'deep')
  mkdirSync(nested, { recursive: true })

  const r = resolveMirror(nested, d)
  assert.equal(r.mirrorDir, m)
  assert.equal(r.remotePath, '/home/lucas/proj')
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: two mirrors of the same remote basename stay distinct', () => {
  const d = root()
  // mirrorDirFor() disambiguates a basename collision with a short hash, so the
  // registry holds `<host-tag>/<base>` and `<host-tag>/<base>-<hash>` side by
  // side. Each must resolve to its OWN remote path.
  const first = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/a/proj', base: 'proj' })
  const second = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/b/proj', base: 'proj-1a2b3c' })

  assert.equal(resolveMirror(first, d).remotePath, '/home/lucas/a/proj')
  assert.equal(resolveMirror(second, d).remotePath, '/home/lucas/b/proj')
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: a sibling whose name PREFIXES a mirror is not treated as inside it', () => {
  const d = root()
  mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })
  // `proj-2` shares the `proj` string prefix but is a different workspace.
  const sibling = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj-2', base: 'proj-2' })

  assert.equal(resolveMirror(sibling, d).remotePath, '/home/lucas/proj-2')
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: a LOCAL (non-mirror) cwd yields no binding — callers must refuse, not guess', () => {
  const d = root()
  mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })

  const r = resolveMirror('/root/some/local/project', d)
  assert.equal(r.machine, null)
  assert.equal(r.remotePath, '')
  assert.equal(r.mirrorDir, null)
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: unparsable or host-less meta is skipped rather than guessed at', () => {
  const d = root()
  const broken = path.join(d, 'host-user-22', 'broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(path.join(broken, '.dsh-remote-meta.json'), '{ not json')
  const hostless = path.join(d, 'host-user-22', 'hostless')
  mkdirSync(hostless, { recursive: true })
  writeFileSync(path.join(hostless, '.dsh-remote-meta.json'), JSON.stringify({ remotePath: '/tmp/x' }))

  assert.equal(resolveMirror(broken, d).machine, null)
  assert.equal(resolveMirror(hostless, d).machine, null)
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: missing registry root / empty path are handled without throwing', () => {
  assert.deepEqual(resolveMirror('', '/nonexistent'), { mirrorDir: null, remotePath: '', machine: null })
  assert.deepEqual(resolveMirror('/x', '/nonexistent-root-xyz'), { mirrorDir: null, remotePath: '', machine: null })
})

test('poolKey: same machine shares one key; any identity field change splits it', () => {
  const base = { host: 'h', port: 22, username: 'u' }
  assert.equal(poolKey(base), poolKey({ ...base }))
  assert.equal(poolKey(base), 'u@h:22')
  // Sessions on the same host but a different user or port are different
  // logins, so they must not share a connection.
  assert.notEqual(poolKey(base), poolKey({ ...base, username: 'other' }))
  assert.notEqual(poolKey(base), poolKey({ ...base, port: 2222 }))
  assert.notEqual(poolKey(base), poolKey({ ...base, host: 'other' }))
})

test('poolKey: a missing port defaults to 22 so both spellings share one pool', () => {
  assert.equal(poolKey({ host: 'h', username: 'u' }), 'u@h:22')
  assert.equal(poolKey({ host: 'h', username: 'u', port: '22' }), 'u@h:22')
})

test('resolveMirror: a v2 (vscode-tunnel) meta mirror resolves to a machine carrying the transport identity', () => {
  const d = root()
  // v2 mirror exactly as ensureMirror writes it for tunnel machines.
  const tdir = path.join(d, 'tunnel-m9', 'proj')
  mkdirSync(tdir, { recursive: true })
  writeFileSync(path.join(tdir, '.dsh-remote-meta.json'), JSON.stringify({
    schemaVersion: 2, transport: 'vscode-tunnel', machineId: 'm9', remoteIdentity: 'rmt-9',
    host: '127.0.0.1', port: 0, username: '', remotePath: '/srv/t/proj', createdAt: new Date(0).toISOString(),
  }))

  const a = resolveMirror(tdir, d)
  assert.equal(a.remotePath, '/srv/t/proj')
  assert.equal(a.mirrorDir, tdir)
  assert.equal(a.machine.host, '127.0.0.1')
  assert.equal(a.machine.port, 0, 'port is the RAW placeholder value, never re-normalized to 22')
  assert.equal(a.machine.username, '')
  assert.equal(a.machine.transport, 'vscode-tunnel')
  assert.equal(a.machine.machineId, 'm9')
  assert.equal(a.machine.remoteIdentity, 'rmt-9')
  // v1-shaped consumers keep working on the same host surface (poolKey only
  // needs host/port/username and stays stable for the ssh key space).
  assert.equal(poolKey(a.machine), '@127.0.0.1:22')
  rmSync(d, { recursive: true, force: true })
})

test('schema3 descriptor identity survives hostless mirrors and ignores transient endpoint', (t) => {
  const d = root()
  t.after(() => rmSync(d, { recursive: true, force: true }))
  t.after(registerSshCarrier({
    id: 'binding-fixture',
    acquire() { throw new Error('binding must not acquire a carrier') },
    targetIdentity(connector) {
      if (!connector.config || connector.config.target !== 'one') throw new Error('invalid target')
      return 'canonical-descriptor-one'
    },
  }))
  const dir = path.join(d, 'ssh-carrier-one', 'proj')
  mkdirSync(dir, { recursive: true })
  const meta = { schemaVersion: 3, transport: 'ssh', machineId: 'one', connectorTargetIdentity: 'canonical-descriptor-one', remotePath: '/proj' }
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify(meta))
  const resolved = resolveMirror(dir, d)
  assert.equal(resolved.mirrorDir, dir)
  assert.equal(resolved.machine.schemaVersion, 3)
  assert.equal(resolved.machine.machineId, 'one')
  assert.equal(resolved.machine.connectorTargetIdentity, meta.connectorTargetIdentity)
  const saved = { id: 'one', transport: 'ssh', connector: { kind: 'binding-fixture', config: { target: 'one' }, targetIdentity: 'forged-lease-identity' } }
  assert.equal(machineForMirror(resolved.machine, [saved]).record, saved)
  for (const connector of [
    { kind: 'unregistered', targetIdentity: meta.connectorTargetIdentity },
    { kind: 'binding-fixture', targetIdentity: meta.connectorTargetIdentity },
    { kind: 'binding-fixture', config: { target: 'other' }, targetIdentity: meta.connectorTargetIdentity },
  ]) assert.equal(machineForMirror(resolved.machine, [{ ...saved, connector }]), null)
  assert.equal(poolKey(resolved.machine), poolKey({ ...resolved.machine, host: '127.0.0.1', port: 43210 }))
  assert.notEqual(poolKey(resolved.machine), poolKey({ ...resolved.machine, machineId: 'two' }))
  assert.notEqual(poolKey(resolved.machine), poolKey({ ...resolved.machine, connectorTargetIdentity: 'other-descriptor' }))
})

test('malformed strict mirror stays remote-owned and cannot fall back to a direct triple', (t) => {
  const d = root()
  t.after(() => rmSync(d, { recursive: true, force: true }))
  const dir = path.join(d, 'strict-broken', 'proj')
  mkdirSync(dir, { recursive: true })
  for (const bad of [
    { schemaVersion: 3, transport: 'ssh' },
    { schemaVersion: 3, transport: 'ssh', machineId: 42, connectorTargetIdentity: 'target' },
    { schemaVersion: '3', transport: 'ssh', machineId: 'one', connectorTargetIdentity: 'target' },
    { connectorTargetIdentity: 'target' },
    { schemaVersion: 4, transport: 'ssh', machineId: 'one', connectorTargetIdentity: 'target' },
  ]) {
    writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host: 'localhost', port: 22, username: 'root', remotePath: '/proj', ...bad }))
    const resolved = resolveMirror(dir, d)
    assert.equal(resolved.mirrorDir, dir)
    assert.equal(resolved.remotePath, '/proj')
    assert.equal(machineForMirror(resolved.machine, [{ id: 'direct', host: 'localhost', port: 22, username: 'root' }]), null)
    assert.throws(() => poolKey(resolved.machine), /invalid strict/)
  }
})

test('resolveMirror: v1 metas resolve to the legacy machine shape — no transport/machineId keys', () => {
  const d = root()
  const m = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })
  const r = resolveMirror(m, d)
  assert.deepEqual(Object.keys(r.machine).sort(), ['host', 'port', 'username'])
  assert.ok(!('transport' in r.machine), 'v1 machine carries no transport key')
  assert.ok(!('machineId' in r.machine))
  assert.ok(!('remoteIdentity' in r.machine))
  rmSync(d, { recursive: true, force: true })
})
