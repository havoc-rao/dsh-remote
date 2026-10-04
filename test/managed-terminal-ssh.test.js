import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import ssh2 from 'ssh2'
import { SshPool } from '../lib/pool.js'
import { ManagedTerminalManager } from '../lib/managed-terminal.js'

// Only the WebSocket boundary is a double: SSH authentication, exec detection,
// PTY requests, shell I/O, window changes and connection teardown use ssh2 wire.
class View extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  frames = []
  send(data) { this.frames.push(JSON.parse(data)); this.emit('change') }
  close() { this.readyState = 3; this.emit('close') }
  input(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))) }
  output() { return this.frames.filter(frame => frame.type === 'output').map(frame => frame.data).join('') }
}

function waitFor(emitter, predicate, description) {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); emitter.removeListener('change', check) }
    const check = () => { if (predicate()) { cleanup(); resolve() } }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${description}`)) }, 3000)
    emitter.on('change', check)
    check()
  })
}

async function localSsh(t) {
  // Fresh host key stays in memory. No ssh config, user keys, agent, keychain,
  // host files, DSH_HOME, environment overrides or external hosts are involved.
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const events = new EventEmitter()
  const connections = []
  const shells = []
  const commands = []
  const errors = []
  const server = new ssh2.Server({ hostKeys: [privateKey] }, connection => {
    const record = { connection, closed: false }
    connections.push(record)
    connection.on('error', error => { errors.push(error); events.emit('change') })
    connection.on('close', () => { record.closed = true; events.emit('change') })
    connection.on('authentication', context => {
      if (context.method === 'password' && context.username === 'managed-terminal-test' && context.password === 'local-test-only') context.accept()
      else context.reject()
    })
    connection.on('ready', () => {
      connection.on('session', accept => {
        const session = accept()
        let pty = null
        const windows = []
        session.on('pty', (acceptPty, rejectPty, info) => { pty = info; acceptPty() })
        session.on('window-change', (acceptWindow, rejectWindow, info) => {
          windows.push(info)
          if (acceptWindow) acceptWindow()
          events.emit('change')
        })
        session.on('exec', (acceptExec, rejectExec, info) => {
          commands.push(info.command)
          const channel = acceptExec()
          // These are SshPool._detect()'s real probes, not shell execution.
          if (info.command === 'cmd /c ver') {
            channel.stderr.write('cmd: command not found\n')
            channel.exit(127)
          } else if (info.command === 'uname -s') {
            channel.write('Linux\n')
            channel.exit(0)
          } else {
            channel.stderr.write('unsupported test command\n')
            channel.exit(127)
          }
          channel.end()
          events.emit('change')
        })
        session.on('shell', acceptShell => {
          const channel = acceptShell()
          const shell = { channel, connection: record, pty, windows, input: '', closed: false }
          shells.push(shell)
          channel.on('data', data => { shell.input += data.toString(); events.emit('change') })
          channel.on('error', error => { errors.push(error); events.emit('change') })
          channel.on('close', () => { shell.closed = true; events.emit('change') })
          events.emit('change')
        })
      })
    })
  })
  server.on('error', error => { errors.push(error); events.emit('change') })
  t.after(async () => {
    for (const { connection } of connections) connection.end()
    await new Promise(resolve => server.close(resolve))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const pool = new SshPool({
    host: '127.0.0.1', port: server.address().port,
    username: 'managed-terminal-test', password: 'local-test-only',
    privateKeyPath: '', useAgent: false, keyboardInteractive: false,
    hostKeyMode: 'accept-new', connectTimeoutMs: 3000,
    commandTimeoutMs: 3000, maxOutputChars: 8192,
  }) // No knownHostsFile: real host-key verifier, but no filesystem reads/writes.
  t.after(() => pool.close())
  return { pool, events, connections, shells, commands, errors }
}

test('real SshPool PTYs share owner across sessions, retain detached shells and release dedicated SSH on terminate', { timeout: 15000 }, async t => {
  const fixture = await localSsh(t)
  const { pool, events, connections, shells, commands, errors } = fixture
  const ownerA = { machineId: 'local-test-machine', workspace: '/test/workspace with space', key: 'local-test-machine:/test/workspace with space' }
  const ownerB = { ...ownerA } // Same canonical owner, independent session context.
  const resolved = []
  const manager = new ManagedTerminalManager({ getPool: async machineId => {
    resolved.push(machineId)
    assert.equal(machineId, ownerA.machineId)
    return pool
  } })
  t.after(() => manager.closeAll())

  const first = await manager.create(ownerA, 'session-a', 'First')
  const second = await manager.create(ownerB, 'session-b', 'Second')
  assert.deepEqual(resolved, [ownerA.machineId, ownerA.machineId])
  assert.deepEqual(commands, ['cmd /c ver', 'uname -s'])
  assert.equal(pool.platform, 'posix')
  assert.equal(connections.length, 3) // One detection pool + two dedicated PTYs.
  assert.equal(shells.length, 2)
  assert.notEqual(shells[0].connection, shells[1].connection)
  assert.deepEqual(manager.list(ownerA), manager.list(ownerB))
  assert.deepEqual(manager.list(ownerB).terminals.map(info => info.createdBySessionId), ['session-a', 'session-b'])
  assert.ok(manager.list(ownerB).terminals.every(info => !info.exited))
  for (const shell of shells) {
    assert.equal(shell.pty.term, 'xterm-256color')
    assert.equal(shell.pty.cols, 80)
    assert.equal(shell.pty.rows, 24)
    await waitFor(events, () => shell.input.includes("cd '/test/workspace with space'\r"), 'quoted initial cwd over SSH')
  }

  const a = new View(), b = new View()
  manager.attach(a, ownerA, first.terminalId, { cols: 111, rows: 37 })
  manager.attach(b, ownerB, first.terminalId)
  assert.equal(a.frames[0].terminalId, b.frames[0].terminalId)
  await waitFor(events, () => shells[0].windows.some(info => info.cols === 111 && info.rows === 37), 'PTY resize over SSH')
  a.input({ type: 'input', data: 'from-session-a\r' })
  b.input({ type: 'input', data: 'from-session-b\r' })
  await waitFor(events, () => shells[0].input.includes('from-session-a\rfrom-session-b\r'), 'input from both views')
  shells[0].channel.write('shared wire output\n')
  await Promise.all([a, b].map(view => waitFor(view, () => view.output().includes('shared wire output\n'), 'broadcast output')))
  assert.equal(a.output(), b.output())

  a.input({ type: 'park' })
  b.close() // Bare WebSocket disconnect also detaches, rather than ending SSH.
  const closed = new View()
  manager.attach(closed, ownerB, first.terminalId)
  closed.input({ type: 'close' })
  assert.equal(manager.terminals.get(first.terminalId).views.size, 0)
  assert.equal(shells[0].closed, false)
  assert.equal(shells[0].connection.closed, false)
  assert.ok(manager.list(ownerB).terminals.every(info => !info.exited))
  shells[0].channel.write('output while all views detached\n')
  const terminal = manager.terminals.get(first.terminalId)
  // Use the real channel's data event as a barrier: _wire was registered first.
  await waitForChannelOutput(terminal.channel, () => terminal.transcript.includes('output while all views detached\n'))
  const resumed = new View()
  manager.attach(resumed, ownerB, first.terminalId)
  assert.ok(resumed.output().includes('shared wire output\noutput while all views detached\n'))
  assert.equal(connections.length, 3)
  assert.equal(shells.length, 2) // Reattach did not call openPty again.

  // openPty promises a dedicated client, immune to pooled reconnect/close.
  pool.invalidate()
  await waitFor(events, () => connections[0].closed, 'pooled SSH teardown')
  resumed.input({ type: 'input', data: 'after-pool-invalidate\r' })
  await waitFor(events, () => shells[0].input.includes('after-pool-invalidate\r'), 'dedicated PTY survives pool invalidation')
  shells[0].channel.write('still live\n')
  await waitFor(resumed, () => resumed.output().includes('still live\n'), 'output after pool invalidation')

  manager.terminate(ownerB, first.terminalId) // The other session may terminate it.
  assert.deepEqual(resumed.frames.at(-1), { type: 'closed', reason: 'terminated' })
  assert.equal(resumed.readyState, 3)
  await waitFor(events, () => shells[0].closed && shells[0].connection.closed, 'terminated PTY channel AND dedicated SSH release')
  assert.equal(shells[1].connection.closed, false)
  assert.deepEqual(manager.list(ownerA).terminals.map(info => info.terminalId), [second.terminalId])
  const remaining = new View()
  manager.attach(remaining, ownerA, second.terminalId)
  remaining.input({ type: 'input', data: 'second-terminal-still-live\r' })
  await waitFor(events, () => shells[1].input.includes('second-terminal-still-live\r'), 'other dedicated SSH remains usable')
  manager.terminate(ownerA, second.terminalId)
  await waitFor(events, () => shells[1].closed && shells[1].connection.closed, 'second dedicated SSH release')
  assert.deepEqual(manager.list(ownerB), { terminals: [] })
  assert.ok(connections.every(record => record.closed))
  assert.deepEqual(errors, [])
})

function waitForChannelOutput(channel, predicate) {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); channel.removeListener('data', check) }
    const check = () => { if (predicate()) { cleanup(); resolve() } }
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for detached transcript')) }, 3000)
    channel.on('data', check)
    check()
  })
}
