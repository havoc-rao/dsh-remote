import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function makeRemoteTransport(')
const end = source.indexOf('    // ── better-sidebar registration', start)
assert.ok(start > 0 && end > start)

async function openTerminal(origin, streamBaseUrl) {
  const sockets = []
  const failures = []
  const endpoints = []
  const scope = { sessionId: 'session-test', cwd: '/mirror/中文 workspace' }
  const remotePath = '/data/workspace/中文 project'
  class Socket {
    static OPEN = 1
    constructor(url) { this.url = url; sockets.push(this) }
    close() {}
  }
  const make = vm.runInNewContext(source.slice(start, end) + '\nmakeRemoteTransport', {
    URL, URLSearchParams,
    location: { origin },
    ...(streamBaseUrl === undefined ? {} : { __DSH_TRANSPORT__: { streamBaseUrl } }),
    WebSocket: Socket,
    fetchRemoteStatus: async () => ({ sessionMode: 'remote', currentId: 'machine-test', sessionRemotePath: remotePath }),
    tr: (key) => key,
  })
  const transport = make({ scope, tab: { id: 'terminal:test' } })
  transport.open({
    term: { cols: 120, rows: 36 },
    onEndpoint: (url) => endpoints.push(url),
    onFatal: (error) => failures.push(error),
  })
  await new Promise((resolve) => setImmediate(resolve))
  return { sockets, failures, endpoints, scope, remotePath }
}

for (const [label, origin, base, expected] of [
  ['plain Web', 'http://127.0.0.1:19387', undefined, 'ws://127.0.0.1:19387'],
  ['HTTPS Web', 'https://harness.example', undefined, 'wss://harness.example'],
  ['Desktop physical host', 'dsh-app://app', 'http://127.0.0.1:43123', 'ws://127.0.0.1:43123'],
  ['Desktop secure host', 'dsh-app://app', 'https://harness.example:8443', 'wss://harness.example:8443'],
  ['secure WS base', 'dsh-app://app', 'wss://harness.example', 'wss://harness.example'],
]) {
  test(`remote terminal opens against ${label} and preserves scoped handshake`, async () => {
    const { sockets, failures, endpoints, scope, remotePath } = await openTerminal(origin, base)
    assert.deepEqual(failures, [])
    assert.equal(sockets.length, 1)
    assert.equal(endpoints[0], sockets[0].url)
    const url = new URL(sockets[0].url)
    assert.equal(url.origin, expected)
    assert.equal(url.pathname, '/dsh-remote/ws/terminal')
    assert.equal(url.searchParams.get('workspace'), scope.cwd)
    assert.equal(url.searchParams.get('sessionId'), scope.sessionId)
    assert.equal(url.searchParams.get('machine'), 'machine-test')
    assert.equal(url.searchParams.get('cwd'), remotePath)
    assert.equal(url.searchParams.get('cols'), '120')
    assert.equal(url.searchParams.get('rows'), '36')
    assert.equal(url.searchParams.get('term'), 'xterm-256color')
    assert.deepEqual(JSON.parse(url.searchParams.get('resume')), ['term', scope.sessionId, scope.cwd, 'machine-test', remotePath, 'terminal:test'])
  })
}

test('Desktop without a stream hook reports configuration failure instead of dialing ws://app', async () => {
  const { sockets, failures, endpoints } = await openTerminal('dsh-app://app')
  assert.equal(sockets.length, 0)
  assert.deepEqual(endpoints, [])
  assert.equal(failures.length, 1)
  assert.match(failures[0], /streamBaseUrl is unavailable/)
})
