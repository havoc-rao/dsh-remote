import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ManagedTerminalManager } from '../lib/managed-terminal.js'

class Channel extends EventEmitter {
  writes = []
  windows = []
  signals = []
  pauses = 0
  write(data) { this.writes.push(data) }
  setWindow(...args) { this.windows.push(args) }
  signal(name) { this.signals.push(name) }
  pause() { this.pauses++ }
  output(data) { this.emit('data', Buffer.from(data)) }
}
class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  frames = []
  closes = []
  send(data) { this.frames.push(JSON.parse(data)) }
  close(...args) { this.closes.push(args); this.readyState = 3; this.emit('close') }
  input(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))) }
  outputs() { return this.frames.filter(f => f.type === 'output').map(f => f.data).join('') }
}
const owner = { machineId: 'machine-a', workspace: '/canonical/root', key: 'machine-a:/canonical/root' }
function setup(config = {}, onCommand = null) {
  const spawns = []
  const resolved = []
  const pool = {
    config: { host: 'not-disclosed', username: 'secret-user', password: 'secret-password' },
    async openPty(options) {
      const channel = new Channel()
      const spawn = { options, channel, ended: 0 }
      spawns.push(spawn)
      return { channel, end() { spawn.ended++; channel.emit('close') } }
    },
  }
  const manager = new ManagedTerminalManager({ config, onCommand, getPool: async id => { resolved.push(id); return pool } })
  return { manager, pool, spawns, resolved }
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('create eagerly spawns in canonical cwd, metadata copies and sessions share owner', async () => {
  const { manager, spawns, resolved } = setup()
  const a = await manager.create(owner, 'session-1', 'A')
  const b = await manager.create({ ...owner }, 'session-2', 'B')
  assert.match(a.terminalId, /^remote-managed:[0-9a-f-]{36}$/)
  assert.deepEqual(Object.keys(a).sort(), ['terminalId', 'title', 'cwd', 'createdBySessionId', 'createdAt', 'exited'].sort())
  assert.equal(a.createdBySessionId, 'session-1')
  assert.equal(a.cwd, owner.workspace)
  assert.equal(a.title, 'A')
  assert.equal(a.exited, false)
  assert.equal(typeof a.createdAt, 'number')
  assert.deepEqual(resolved, ['machine-a', 'machine-a'])
  assert.deepEqual(spawns[0].options, { cwd: owner.workspace, cols: 80, rows: 24, term: 'xterm-256color' })
  a.title = 'mutated'
  assert.deepEqual(manager.list(owner).terminals.map(t => t.title), ['A', 'B'])
  manager.terminate({ ...owner }, b.terminalId)
  assert.equal(spawns[1].ended, 1)
  manager.closeAll()
})

test('machine, canonical workspace and owner key must ALL match; unknown id is MISSING', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 'session-1')
  for (const other of [
    { ...owner, key: 'forged' },
    { ...owner, machineId: 'machine-b' },
    { ...owner, workspace: '/canonical/other' },
  ]) {
    assert.deepEqual(manager.list(other), { terminals: [] })
    const ws = new Socket()
    assert.throws(() => manager.attach(ws, other, info.terminalId), { code: 'FORBIDDEN' })
    assert.throws(() => manager.terminate(other, info.terminalId), { code: 'FORBIDDEN' })
    assert.deepEqual(ws.frames, [])
    assert.equal(spawns[0].ended, 0)
  }
  assert.throws(() => manager.list({}), { code: 'FORBIDDEN' })
  const missing = new Socket()
  assert.throws(() => manager.attach(missing, owner, 'unknown'), { code: 'MISSING' })
  assert.deepEqual(missing.frames, [{ type: 'closed', reason: 'missing' }])
  assert.throws(() => manager.terminate(owner, 'unknown'), { code: 'MISSING' })
  manager.closeAll()
})

test('multi-view broadcast, JSON output ambiguity, input/resize, title and audit', async () => {
  const commands = []
  const { manager, spawns } = setup({}, (...args) => commands.push(args))
  const info = await manager.create(owner, 's')
  const a = new Socket(), b = new Socket()
  manager.attach(a, owner, info.terminalId, { cols: 100, rows: 30 })
  manager.attach(b, owner, info.terminalId)
  assert.equal(a.frames[0].type, 'init')
  assert.equal(a.frames[0].terminalId, info.terminalId)
  assert.equal(a.frames[0].cwd, owner.workspace)
  const channel = spawns[0].channel
  channel.output('{"type":"closed","reason":"exited"}')
  assert.deepEqual(a.frames.at(-1), { type: 'output', data: '{"type":"closed","reason":"exited"}' })
  assert.equal(a.outputs(), b.outputs())
  a.input({ type: 'input', data: 'pwd\r' })
  b.input({ type: 'input', data: 'echo hello\n' })
  assert.deepEqual(channel.writes, ['pwd\r', 'echo hello\n'])
  assert.deepEqual(commands.map(c => c[0]), ['pwd', 'echo hello'])
  assert.equal(commands[0][1].terminalId, info.terminalId)
  assert.equal(a.frames.at(-1).type, 'title')
  assert.equal(b.frames.at(-1).title, 'echo')
  a.input({ type: 'resize', cols: 900, rows: -100 })
  assert.deepEqual(channel.windows.at(-1), [1, 500, 0, 0])
  a.input({ type: 'signal', name: 'KILL' })
  a.emit('message', 'raw input is not accepted')
  a.input({ type: 'output', data: 'ignored' })
  assert.deepEqual(channel.signals, [])
  assert.equal(channel.writes.length, 2)
  manager.closeAll()
})

test('close, park and bare disconnect detach only; reattach never respawns', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 's')
  for (const type of ['close', 'park', 'disconnect']) {
    const ws = new Socket()
    manager.attach(ws, owner, info.terminalId)
    if (type === 'disconnect') ws.close()
    else ws.input({ type })
    ws.input({ type: 'input', data: 'ignored' })
    assert.equal(spawns[0].ended, 0)
    assert.equal(ws.listenerCount('message'), 0)
  }
  assert.deepEqual(spawns[0].channel.writes, [])
  const a = new Socket(), b = new Socket()
  manager.attach(a, owner, info.terminalId)
  manager.attach(b, owner, info.terminalId)
  manager.terminate(owner, info.terminalId)
  assert.deepEqual(a.frames.at(-1), { type: 'closed', reason: 'terminated' })
  assert.deepEqual(b.frames.at(-1), { type: 'closed', reason: 'terminated' })
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].ended, 1)
  assert.deepEqual(manager.list(owner), { terminals: [] })
  manager.closeAll()
  assert.equal(spawns[0].ended, 1)
})

test('natural exit retains metadata/replay, sends closed exited and never respawns', async () => {
  const { manager, spawns } = setup({ terminalMaxSessions: 1 })
  const info = await manager.create(owner, 's')
  const a = new Socket(), b = new Socket()
  manager.attach(a, owner, info.terminalId)
  manager.attach(b, owner, info.terminalId)
  spawns[0].channel.output('goodbye')
  spawns[0].channel.emit('close')
  for (const ws of [a, b]) assert.deepEqual(ws.frames.at(-1), { type: 'closed', reason: 'exited' })
  assert.equal(manager.list(owner).terminals[0].exited, true)
  const reattach = new Socket()
  manager.attach(reattach, owner, info.terminalId)
  assert.equal(reattach.frames[0].exited, true)
  assert.equal(reattach.outputs(), 'goodbye')
  assert.deepEqual(reattach.frames.at(-1), { type: 'closed', reason: 'exited' })
  reattach.input({ type: 'input', data: 'no-respawn' })
  assert.equal(spawns.length, 1)
  await manager.create(owner, 'another-session') // Exited does not consume active quota.
  assert.equal(spawns.length, 2)
  manager.closeAll()
})

test('slow or failing websocket is disconnected without pausing PTY or other views', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 's')
  const slow = new Socket(), healthy = new Socket(), broken = new Socket()
  for (const ws of [slow, healthy, broken]) manager.attach(ws, owner, info.terminalId)
  slow.bufferedAmount = 512 * 1024 + 1
  broken.send = () => { throw new Error('do not expose credentials') }
  spawns[0].channel.output('first')
  assert.equal(slow.readyState, 3)
  assert.equal(broken.readyState, 3)
  assert.equal(healthy.outputs(), 'first')
  assert.equal(spawns[0].channel.pauses, 0)
  assert.equal(spawns[0].ended, 0)
  healthy.input({ type: 'input', data: 'ok' })
  assert.deepEqual(spawns[0].channel.writes, ['ok'])
  const afterSend = new Socket()
  manager.attach(afterSend, owner, info.terminalId)
  afterSend.send = function (data) { this.frames.push(JSON.parse(data)); this.bufferedAmount = 512 * 1024 + 1 }
  spawns[0].channel.output('second')
  assert.equal(afterSend.readyState, 3)
  assert.equal(healthy.outputs(), 'firstsecond')
  manager.closeAll()
})

test('input limit counts UTF-8 bytes; oversized frame detaches only offending view', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 's')
  const a = new Socket(), b = new Socket()
  manager.attach(a, owner, info.terminalId)
  manager.attach(b, owner, info.terminalId)
  a.input({ type: 'input', data: 'a'.repeat(64 * 1024) })
  assert.equal(spawns[0].channel.writes[0].length, 64 * 1024)
  a.input({ type: 'input', data: '€'.repeat(22000) })
  assert.equal(a.readyState, 3)
  assert.equal(b.readyState, 1)
  assert.equal(spawns[0].ended, 0)
  b.input({ type: 'input', data: 'b'.repeat(100000) })
  assert.equal(b.readyState, 3)
  assert.equal(spawns[0].channel.writes.length, 1)
  manager.closeAll()
})

test('transcript/replay byte bounds, huge single output, UTF-8 streaming and independent replay', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 's')
  const channel = spawns[0].channel
  channel.output('€'.repeat(50000))
  const a = new Socket(), b = new Socket()
  manager.attach(a, owner, info.terminalId)
  manager.attach(b, owner, info.terminalId)
  assert.equal(a.outputs(), b.outputs())
  assert.ok(Buffer.byteLength(a.outputs()) <= 32 * 1024)
  assert.ok(!a.outputs().includes('\ufffd'))
  assert.ok(Buffer.byteLength(manager.terminals.get(info.terminalId).transcript) <= 48 * 1024)
  const utf = Buffer.from('😀')
  channel.emit('data', utf.subarray(0, 2))
  channel.emit('data', utf.subarray(2))
  assert.ok(a.outputs().endsWith('😀'))
  assert.ok(b.outputs().endsWith('😀'))
  manager.closeAll()
})

test('concurrent spawn reservations enforce quota and sanitized failures free the slot', async () => {
  const pending = deferred()
  const { manager, pool, spawns } = setup({ terminalMaxSessions: 1 })
  const openPty = pool.openPty
  pool.openPty = () => pending.promise
  const first = manager.create(owner, 's')
  await assert.rejects(manager.create(owner, 's2'), { code: 'QUOTA' })
  assert.equal(manager.list(owner).terminals.length, 1)
  pending.reject(new Error('ssh://user:password@private-host privateKey=secret'))
  await assert.rejects(first, error => error.code === 'SPAWN_FAILED' && !/password|private-host|secret/.test(error.message))
  assert.deepEqual(manager.list(owner), { terminals: [] })
  pool.openPty = openPty
  await manager.create(owner, 's3')
  assert.equal(spawns.length, 1)
  manager.closeAll()
})

test('pool resolution failure sanitized and quota reservation cleaned', async () => {
  const manager = new ManagedTerminalManager({ getPool: async () => { throw new Error('password=secret') } })
  await assert.rejects(manager.create(owner, 's'), { code: 'SPAWN_FAILED', message: 'remote terminal could not be started' })
  assert.deepEqual(manager.list(owner), { terminals: [] })
})

test('closeAll during pending openPty releases late connection exactly once', async () => {
  const pending = deferred(), entered = deferred()
  const channel = new Channel()
  let ended = 0
  const manager = new ManagedTerminalManager({ getPool: async () => ({
    openPty() { entered.resolve(); return pending.promise },
  }) })
  const creating = manager.create(owner, 's')
  await entered.promise
  const id = manager.list(owner).terminals[0].terminalId
  const ws = new Socket()
  manager.attach(ws, owner, id)
  manager.closeAll()
  manager.closeAll()
  assert.deepEqual(ws.frames.at(-1), { type: 'closed', reason: 'missing' })
  pending.resolve({ channel, end() { ended++; channel.emit('close') } })
  await assert.rejects(creating, { code: 'CLOSED' })
  assert.equal(ended, 1)
  assert.deepEqual(manager.list(owner), { terminals: [] })
  await assert.rejects(manager.create(owner, 's'), { code: 'CLOSED' })
})

test('closeAll during pending getPool never opens a shell afterward', async () => {
  const pending = deferred()
  let spawned = 0
  const manager = new ManagedTerminalManager({ getPool: () => pending.promise })
  const creating = manager.create(owner, 's')
  manager.closeAll()
  pending.resolve({ openPty() { spawned++; throw new Error('unexpected') } })
  await assert.rejects(creating, { code: 'CLOSED' })
  assert.equal(spawned, 0)
})

test('exited metadata retention is bounded and eviction makes terminal MISSING', async () => {
  const { manager, spawns } = setup({ terminalMaxSessions: 1, managedTerminalMaxExited: 2 })
  const ids = []
  for (let i = 0; i < 5; i++) {
    ids.push((await manager.create(owner, `s${i}`)).terminalId)
    spawns[i].channel.emit('close')
  }
  assert.deepEqual(manager.list(owner).terminals.map(t => t.terminalId), ids.slice(-2))
  assert.throws(() => manager.terminate(owner, ids[0]), { code: 'MISSING' })
  assert.ok(manager.list(owner).terminals.every(t => t.exited))
  manager.closeAll()
})

function guardedOwner(check) {
  return Object.defineProperty({ ...owner }, 'isCurrent', { value: check })
}

test('rebound view receives fatal, not output/missing; other views and PTY survive', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 's')
  let current = true
  const stale = new Socket(), healthy = new Socket()
  manager.attach(stale, guardedOwner(() => current), info.terminalId)
  manager.attach(healthy, owner, info.terminalId)
  current = false
  spawns[0].channel.output('private output after rebound')
  assert.equal(stale.outputs(), '')
  assert.deepEqual(stale.frames.at(-1), { type: 'fatal', code: 'FORBIDDEN', message: 'Remote terminal access denied' })
  assert.equal(stale.readyState, 3)
  assert.ok(!stale.frames.some(f => f.type === 'closed'))
  assert.equal(healthy.outputs(), 'private output after rebound')
  assert.equal(spawns[0].ended, 0)
  healthy.input({ type: 'input', data: 'allowed' })
  assert.deepEqual(spawns[0].channel.writes, ['allowed'])
  manager.closeAll()
})

test('rebound input and resize are blocked and throwing guard fails closed', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 's')
  for (const type of ['input', 'resize']) {
    let current = true
    const ws = new Socket()
    manager.attach(ws, guardedOwner(() => { if (!current) throw new Error('private'); return true }), info.terminalId)
    const windows = spawns[0].channel.windows.length
    current = false
    ws.input({ type, data: 'forbidden', cols: 123, rows: 45 })
    assert.equal(spawns[0].channel.windows.length, windows)
    assert.deepEqual(spawns[0].channel.writes, [])
    assert.deepEqual(ws.frames.at(-1), { type: 'fatal', code: 'FORBIDDEN', message: 'Remote terminal access denied' })
    assert.equal(ws.readyState, 3)
  }
  assert.equal(spawns[0].ended, 0)
  assert.throws(() => manager.attach(new Socket(), guardedOwner(() => false), info.terminalId), { code: 'FORBIDDEN' })
  manager.closeAll()
})

test('create rechecks nonenumerable owner guard after openPty and releases forbidden shell', async () => {
  const pending = deferred(), entered = deferred()
  let current = true, ended = 0
  const channel = new Channel()
  const manager = new ManagedTerminalManager({ getPool: async () => ({
    openPty() { entered.resolve(); return pending.promise },
  }) })
  const creating = manager.create(guardedOwner(() => current), 's')
  await entered.promise
  current = false
  pending.resolve({ channel, end() { ended++; channel.emit('close') } })
  await assert.rejects(creating, { code: 'FORBIDDEN', message: 'Remote terminal access denied' })
  assert.equal(ended, 1)
  assert.deepEqual(manager.list(owner), { terminals: [] })
  manager.closeAll()
})

test('channel error never exposes raw SSH exception and releases PTY', async () => {
  const { manager, spawns } = setup()
  const info = await manager.create(owner, 's')
  const ws = new Socket()
  manager.attach(ws, owner, info.terminalId)
  spawns[0].channel.emit('error', new Error('password=private-secret'))
  assert.deepEqual(ws.frames.at(-1), { type: 'closed', reason: 'exited' })
  assert.ok(!JSON.stringify(ws.frames).includes('private-secret'))
  assert.equal(spawns[0].ended, 1)
  // Late error after end is harmless.
  spawns[0].channel.emit('error', new Error('late'))
  manager.closeAll()
})
