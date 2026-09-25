// TerminalManager unit tests: fake pool (openPty → fake channel) + fake
// WebSocket, so the host-side protocol (init/title frames, input routing,
// resize/close/park semantics, grace, respawn, quota, immediate-exit poison)
// is verified without a real SSH host. The ssh2 option shapes are pinned to
// the installed ssh2 source in lib/index.js's openPty (verified against
// client.js reqPty/exec/shell).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { TerminalManager } from '../lib/terminal.js'

const tick = () => new Promise((r) => setImmediate(r))

/** Fake ssh2 channel: records writes/windows/signals; data fed by test. */
class FakeChannel extends EventEmitter {
  constructor() {
    super()
    this.writes = []
    this.windows = []
    this.signals = []
    this.paused = false
    this.closed = false
  }
  write(d) { this.writes.push(typeof d === 'string' ? d : d.toString('utf8')); return true }
  setWindow(rows, cols) { this.windows.push([rows, cols]) }
  signal(name) { this.signals.push(name) }
  pause() { this.paused = true }
  resume() { this.paused = false }
  close() { this.closed = true; this.emit('close') }
  emitData(text) { this.emit('data', Buffer.from(text)) }
}

/** Fake pool: openPty resolves with a fresh FakeChannel; spawns counted. */
function makePool({ platform = 'posix', gitBashPath = '', failSpawns = 0 } = {}) {
  let spawnCount = 0
  const channels = []
  const pool = {
    config: { host: 'example.com', port: 22, username: 'dev', workspace: '/srv/app' },
    platform,
    gitBashPath,
    openPty: async () => {
      spawnCount += 1
      if (failSpawns > 0 && spawnCount <= failSpawns) throw new Error('spawn failed')
      const ch = new FakeChannel()
      channels.push(ch)
      return { channel: ch, end: () => { ch.closed = true; if (!ch.listenerCount('close')) ch.emit('close') } }
    },
  }
  return { pool, channels, spawnCount: () => spawnCount }
}

/** Fake WS: Node-ws style (message/close events, readyState, send/close). */
class FakeWs extends EventEmitter {
  constructor() {
    super()
    this.frames = []
    this.readyState = 1 // OPEN
    this.closed = null // [code, reason] of manager-initiated close
    this.bufferedAmount = 0
  }
  send(d) { this.frames.push(d) }
  close(code, reason) {
    if (this.closed) return
    this.closed = [code || 1000, reason || '']
    this.readyState = 3 // CLOSED
    this.emit('close', { code: code || 1000, reason: reason || '' })
  }
  framesOf(type) {
    return this.frames
      .map((f) => { try { return JSON.parse(f) } catch { return null } })
      .filter((f) => f && f.type === type)
  }
  raw() { return this.frames.filter((f) => { try { JSON.parse(f); return false } catch { return true } }) }
}

const makeManager = (overrides = {}) => {
  const fs = makePool(overrides.pool || {})
  const commands = []
  const tm = new TerminalManager({
    pool: fs.pool,
    config: { terminalMaxSessions: 8, terminalReconnectGraceMs: 30, ...overrides.config },
    onCommand: (line) => commands.push(line),
  })
  return { tm, fs, commands }
}

test('attach spawns a shell and sends the init frame', async () => {
  const { tm, fs } = makeManager()
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1', cwd: '/srv/app', cols: 100, rows: 40 })
  await tick()
  assert.equal(fs.spawnCount(), 1)
  const init = ws.framesOf('init')[0]
  assert.ok(init, 'init frame sent')
  assert.equal(init.sid.length > 0, true)
  assert.equal(init.cwd, '/srv/app')
  assert.equal(init.machine, 'dev@example.com:22')
  assert.equal(init.cols, 100)
  assert.equal(init.rows, 40)
  // the starting cwd line is written by the pool's openPty (fake) — no channel writes yet
  assert.equal(fs.channels[0].writes.length, 0)
  tm.closeAll()
})

test('input before init is queued, then flushed; output streams out', async () => {
  const { tm, fs } = makeManager()
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1', cwd: '/w' })
  ws.emit('message', 'echo hi\n') // before the shell is up
  await tick()
  assert.equal(fs.channels[0].writes.filter((w) => w === 'echo hi\n').length, 1)
  fs.channels[0].emitData('hi\n$ ')
  assert.ok(ws.frames.includes('hi\n$ '), 'output forwarded raw')
  tm.closeAll()
})

test('title frames + audit fire per submitted command line', async () => {
  const { tm, commands } = makeManager()
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1', cwd: '/w' })
  await tick()
  ws.emit('message', 'ls -la\n')
  await tick()
  const titles = ws.framesOf('title')
  assert.equal(titles.length, 1)
  assert.equal(titles[0].title, 'ls')
  assert.equal(titles[0].command, 'ls -la')
  assert.deepEqual(commands, ['ls -la'])
  tm.closeAll()
})

test('resize / signal / close frames route to the channel', async () => {
  const { tm, fs } = makeManager()
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1' })
  await tick()
  const ch = fs.channels[0]
  ws.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 50 }))
  assert.deepEqual(ch.windows.at(-1), [50, 120])
  ws.emit('message', JSON.stringify({ type: 'signal', name: 'INT' }))
  assert.deepEqual(ch.signals, ['INT'])
  ws.emit('message', JSON.stringify({ type: 'close' }))
  assert.equal(tm.sessions.size, 0, 'close frame kills + removes the session')
  tm.closeAll()
})

test('park keeps the session alive after the socket drops; bare drop gets grace', async () => {
  const { tm } = makeManager({ config: { terminalReconnectGraceMs: 25 } })
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1' })
  await tick()
  ws.emit('message', JSON.stringify({ type: 'park' }))
  ws.close(1000) // bare socket drop (simulated by test)
  assert.equal(tm.sessions.size, 1, 'parked session survives')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(tm.sessions.size, 1, 'parked session survives grace window too')
  tm.closeAll()

  const m2 = makeManager({ config: { terminalReconnectGraceMs: 20 } })
  const ws2 = new FakeWs()
  m2.tm.attach(ws2, { resume: 'k2' })
  await tick()
  ws2.close(1000) // bare drop without park
  assert.equal(m2.tm.sessions.size, 1)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(m2.tm.sessions.size, 0, 'unparked session is killed after grace')
  m2.tm.closeAll()
})

test('reattach (resume) replays the transcript tail and reuses the shell', async () => {
  const { tm, fs } = makeManager()
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1' })
  await tick()
  fs.channels[0].emitData('hello from before')
  ws.close(1000) // bare drop → grace
  await tick()

  const ws2 = new FakeWs()
  tm.attach(ws2, { resume: 'k1' })
  await tick()
  assert.equal(fs.spawnCount(), 1, 'same shell, no respawn')
  assert.ok(ws2.frames.includes('hello from before'), 'transcript replayed')
  assert.equal(ws2.framesOf('init').length, 1)
  tm.closeAll()
})

test('shell exit with an attached socket respawns automatically', async () => {
  const { tm, fs } = makeManager()
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1' })
  await tick()
  fs.channels[0].emit('close') // shell exited (long-lived enough → not immediate)
  await tick()
  assert.equal(fs.spawnCount(), 2, 'auto respawn')
  tm.closeAll()
})

test('immediate-exit loop poisons the session; reattach is refused with 1011', async () => {
  const { tm, fs } = makeManager()
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1' })
  await tick()
  // exit immediately after spawn → recentExits; twice → session dead
  fs.channels[0].emit('close')
  await tick()
  assert.equal(fs.spawnCount(), 2)
  fs.channels[1].emit('close')
  await tick()
  assert.equal(fs.spawnCount(), 3)
  fs.channels[2].emit('close')
  await tick()
  assert.ok(ws.closed, 'ws closed by the poison path')
  assert.equal(ws.closed[0], 1011)
  assert.match(String(ws.closed[1]), /exits repeatedly/)

  const ws2 = new FakeWs()
  tm.attach(ws2, { resume: 'k1' }) // dead session → fresh one, new spawn
  await tick()
  assert.equal(tm.sessions.size, 1)
  tm.closeAll()
})

test('session quota refuses with 1011', async () => {
  const { tm } = makeManager({ config: { terminalMaxSessions: 1 } })
  const ws1 = new FakeWs()
  tm.attach(ws1, { resume: 'a' })
  await tick()
  const ws2 = new FakeWs()
  tm.attach(ws2, { resume: 'b' })
  assert.ok(ws2.closed)
  assert.equal(ws2.closed[0], 1011)
  assert.match(String(ws2.closed[1]), /too many/)
  tm.closeAll()
})

test('repeated spawn failure refuses the attach', async () => {
  const { tm } = makeManager({ pool: { failSpawns: 1 } })
  const ws = new FakeWs()
  tm.attach(ws, { resume: 'k1' })
  await tick()
  assert.ok(ws.closed)
  assert.equal(ws.closed[0], 1011)
  tm.closeAll()
})

test('closeAll tears every session down', async () => {
  const { tm } = makeManager()
  const a = new FakeWs()
  const b = new FakeWs()
  tm.attach(a, { resume: 'a' })
  tm.attach(b, { resume: 'b' })
  await tick()
  assert.equal(tm.sessions.size, 2)
  tm.closeAll()
  assert.equal(tm.sessions.size, 0)
})