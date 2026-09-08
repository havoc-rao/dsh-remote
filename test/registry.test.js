// Registry semantics for issue #13: "Saved Connections != Active Remote
// Context". A saved machine must never silently become the active remote
// context; `currentId` is an explicit user choice and nothing else.
// Per-workspace isolation: the ACTIVE context is stored per workspace dir in
// `workspaces`, never as one app-wide activation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadMachines, saveMachines, sanitizeMachine, applyMachine, machineId } from '../lib/registry.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'dsh-remote-reg-'))
const file = (dir) => path.join(dir, 'machines.json')
const machine = (id, host) => ({ id, name: host, host, port: 22, username: 'root', password: 'secret', workspace: '/home/root/proj', proxy: { host: 'jump', password: 'pp' } })

test('loadMachines: empty / missing file → { list: [], currentId: null, explicitNone: false, workspaces: {} }', () => {
  const d = tmp()
  assert.deepEqual(loadMachines(file(d)), { list: [], currentId: null, explicitNone: false, workspaces: {} })
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: currentId NEVER falls back to the first saved machine (issue #13)', () => {
  const d = tmp()
  // Old behavior: `currentId || list[0].id` made the first saved machine the
  // active remote context. Saving a machine must stay a pure standby.
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1'), machine('b', 'h2')] }))
  const { list, currentId, explicitNone } = loadMachines(file(d))
  assert.equal(list.length, 2)
  assert.equal(currentId, null)
  assert.equal(explicitNone, false) // no currentId key at all → not an explicit "none"
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: explicit currentId survives', () => {
  const d = tmp()
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1'), machine('b', 'h2')], currentId: 'b' }))
  assert.equal(loadMachines(file(d)).currentId, 'b')
  assert.equal(loadMachines(file(d)).explicitNone, false)
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: stale currentId (deleted machine) resolves to null — no auto-promotion of a sibling (issue #13)', () => {
  const d = tmp()
  writeFileSync(file(d), JSON.stringify({ list: [machine('b', 'h2')], currentId: 'a' }))
  const { list, currentId } = loadMachines(file(d))
  assert.equal(list.length, 1)
  assert.equal(currentId, null)
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: persisted currentId:null is an explicit "active remote = none" (issue #13)', () => {
  const d = tmp()
  // After the user clears the current machine the registry persists
  // `currentId: null`. On restart this MUST stay inert — a config-level default
  // host must not silently reactivate a context the user turned off.
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1')], currentId: null }))
  const { currentId, explicitNone } = loadMachines(file(d))
  assert.equal(currentId, null)
  assert.equal(explicitNone, true)
  rmSync(d, { recursive: true, force: true })
})

test('saveMachines(…, null) persists an explicit "active remote = none"', () => {
  const d = tmp()
  saveMachines(file(d), [machine('a', 'h1')], null)
  const j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal(j.currentId, null)
  assert.equal(j.list.length, 1)
  rmSync(d, { recursive: true, force: true })
})

test('saveMachines keepCurrentKey:false leaves currentId untouched (add/update must not flip explicitNone)', () => {
  const d = tmp()
  // Registry that has never had a currentId: adding a machine must NOT write
  // `currentId: null` (which would read back as an explicit "none" and block
  // the config-default bootstrap). The key simply stays absent.
  saveMachines(file(d), [machine('a', 'h1')], null, false)
  let j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal('currentId' in j, false)
  assert.equal(loadMachines(file(d)).explicitNone, false)
  // Registry where the user explicitly cleared current: adding another machine
  // must preserve the explicit-none state (still an explicit choice).
  saveMachines(file(d), [machine('a', 'h1')], null, true)
  saveMachines(file(d), [machine('a', 'h1'), machine('b', 'h2')], null, false)
  j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal(j.currentId, null)
  assert.equal(loadMachines(file(d)).explicitNone, true)
  rmSync(d, { recursive: true, force: true })
})

test('sanitizeMachine strips passwords but reports passwordSet', () => {
  const s = sanitizeMachine(machine('a', 'h1'))
  assert.equal(s.password, undefined)
  assert.equal(s.passwordSet, true)
  // proxy password is blanked ('' — matches the pre-existing sanitize contract)
  assert.equal(s.proxy.password, '')
  assert.equal(s.proxy.passwordSet, true)
  assert.equal(s.host, 'h1')
})

test('applyMachine overrides the live config fields', () => {
  const cfg = { host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false, proxy: undefined }
  applyMachine(cfg, machine('a', 'h1'))
  assert.equal(cfg.host, 'h1')
  assert.equal(cfg.username, 'root')
  assert.equal(cfg.workspace, '/home/root/proj')
  assert.equal(cfg.proxy.host, 'jump')
})

test('applyMachine keeps existing workspace when machine has none', () => {
  const cfg = { host: '', workspace: '/keep' }
  applyMachine(cfg, { host: 'h1', username: 'u', port: 22, password: '' })
  assert.equal(cfg.workspace, '/keep')
})

test('machineId mints unique ids', () => {
  const a = machineId()
  const b = machineId()
  assert.match(a, /^m-/)
  assert.notEqual(a, b)
})

// ── per-workspace selections (workspaces map) ────────────────────────────────

test('loadMachines: workspaces survive a round-trip (per-workspace isolation)', () => {
  const d = tmp()
  const f = file(d)
  saveMachines(f, [machine('a', 'h1'), machine('b', 'h2')], null, true, {
    '/Users/u/proj-local': { machineId: 'b', workspace: '/data/workspace/proj', explicitNone: false },
    '/Users/u/proj-off': { machineId: '', workspace: '', explicitNone: true },
  })
  const loaded = loadMachines(f)
  assert.deepEqual(loaded.workspaces, {
    '/Users/u/proj-local': { machineId: 'b', workspace: '/data/workspace/proj', explicitNone: false },
    '/Users/u/proj-off': { machineId: '', workspace: '', explicitNone: true },
  })
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: stale workspace machineId (deleted machine) never re-activates a ghost — entry dropped (explicit none kept)', () => {
  const d = tmp()
  const f = file(d)
  saveMachines(f, [machine('a', 'h1'), machine('ghost', 'h9')], null, true, {
    '/Users/u/proj-ghost': { machineId: 'ghost', workspace: '/data/x', explicitNone: false },
    '/Users/u/proj-still-off': { machineId: 'ghost', workspace: '', explicitNone: true },
    '/Users/u/proj-ok': { machineId: 'a', workspace: '/data/ok', explicitNone: false },
  })
  // Delete the ghost machine (regression target: deleting a machine must also
  // purge / neutralize every workspace selection pointing at it).
  const kept = loadMachines(f).list.filter((m) => m.id !== 'ghost')
  saveMachines(f, kept, null, false)
  const ws = loadMachines(f).workspaces
  assert.deepEqual(ws, {
    '/Users/u/proj-still-off': { machineId: '', workspace: '', explicitNone: true },
    '/Users/u/proj-ok': { machineId: 'a', workspace: '/data/ok', explicitNone: false },
  })
  rmSync(d, { recursive: true, force: true })
})

test('saveMachines without a workspaces arg preserves the stored map (machine add must not drop selections)', () => {
  const d = tmp()
  const f = file(d)
  saveMachines(f, [machine('a', 'h1')], null, true, { '/Users/u/proj-a': { machineId: 'a', workspace: '/data/a', explicitNone: false } })
  // Adding machine 'b' with keepCurrentKey:false and NO workspaces argument:
  // the map written earlier must survive byte-for-byte.
  saveMachines(f, [machine('a', 'h1'), machine('b', 'h2')], null, false)
  const loaded = loadMachines(f)
  assert.equal(loaded.list.length, 2)
  assert.deepEqual(loaded.workspaces, { '/Users/u/proj-a': { machineId: 'a', workspace: '/data/a', explicitNone: false } })
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: normalizes and drops empty workspace entries', () => {
  const d = tmp()
  const f = file(d)
  writeFileSync(f, JSON.stringify({ list: [machine('a', 'h1')], workspaces: { '/u/x': {}, '/u/y': null, '/u/z': { machineId: 'a', workspace: 42, explicitNone: false } } }))
  const loaded = loadMachines(f)
  assert.deepEqual(loaded.workspaces, { '/u/z': { machineId: 'a', workspace: '', explicitNone: false } })
  rmSync(d, { recursive: true, force: true })
})
