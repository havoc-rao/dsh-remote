// dsh-remote — terminal WS upgrade trust fence (lib/upgrade-trust.js).
//
// The fence decides whether a /dsh-remote/ws/terminal upgrade may proceed.
// Regression pin: a deployment served on a trusted NON-loopback authority
// (corporate gateway / forwarded host — the browser sees "ws://<host>/…")
// used to get its terminal socket destroyed with no HTTP response ("WebSocket
// connection … failed:") while every other surface kept working. The fence
// must accept exactly the web runtime's trustedHosts the way the /api
// gateway does, and keep the loopback-only default when none are declared.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trustedWsUpgrade } from '../lib/upgrade-trust.js'

const req = (headers) => ({ headers })

test('loopback authorities are accepted without any trusted list', () => {
  for (const host of ['localhost', 'localhost:19387', '127.0.0.1', '127.0.0.1:19387', '[::1]', '[::1]:8080']) {
    assert.equal(trustedWsUpgrade(req({ host }), []), true, `${host} is loopback`)
  }
  for (const host of ['localhost', '127.0.0.1:19387']) {
    assert.equal(trustedWsUpgrade(req({ host })), true, `${host} is loopback (no list arg at all)`)
  }
})

test('non-loopback authority is rejected without a trusted list — the reported regression', () => {
  // The user-visible symptom: browser console "WebSocket connection to
  // 'ws://app/dsh-remote/ws/terminal?...' failed:" — Host: app, no status.
  assert.equal(trustedWsUpgrade(req({ host: 'app' }), []), false)
  assert.equal(trustedWsUpgrade(req({ host: 'app:443' }), []), false)
  assert.equal(trustedWsUpgrade(req({ host: 'app' })), false)
})

test('non-loopback authority is accepted when the web runtime trusts the host', () => {
  assert.equal(trustedWsUpgrade(req({ host: 'app' }), ['app']), true)
  // port-less entry matches the hostname on any port (OS-assigned port shape)
  assert.equal(trustedWsUpgrade(req({ host: 'app:443' }), ['app']), true)
  assert.equal(trustedWsUpgrade(req({ host: 'APP:80' }), ['app']), true, 'case-insensitive')
})

test('exact host:port entries match only that authority', () => {
  const list = ['edge.internal:8443']
  assert.equal(trustedWsUpgrade(req({ host: 'edge.internal:8443' }), list), true)
  assert.equal(trustedWsUpgrade(req({ host: 'edge.internal:9090' }), list), false, 'different port refused')
  assert.equal(trustedWsUpgrade(req({ host: 'edge.internal' }), list), false, 'port-less Host not covered by host:port entry')
})

test('mixed lists follow each entry kind', () => {
  const list = ['lab.internal', 'edge.internal:8443']
  assert.equal(trustedWsUpgrade(req({ host: 'lab.internal:3080' }), list), true)
  assert.equal(trustedWsUpgrade(req({ host: 'edge.internal:8443' }), list), true)
  assert.equal(trustedWsUpgrade(req({ host: 'edge.internal' }), list), false)
  assert.equal(trustedWsUpgrade(req({ host: 'other.internal' }), list), false)
})

test('malformed hosts and non-bare entries are refused', () => {
  for (const host of ['', 'evil.com/path', 'user@host', 'host:port:80', 'host:']) {
    assert.equal(trustedWsUpgrade(req({ host }), ['host']), false, `Host ${JSON.stringify(host)} must not parse`)
  }
  // an entry that is not a bare authority never grants
  assert.equal(trustedWsUpgrade(req({ host: 'app' }), ['https://app']), false)
  assert.equal(trustedWsUpgrade(req({ host: 'app:80' }), ['app:080']), false, 'zero-padded port grants nothing')
  assert.equal(trustedWsUpgrade(req({ host: 'app' }), [42]), false, 'non-string entries ignored')
})

test('origin must point at the same host when present', () => {
  assert.equal(trustedWsUpgrade(req({ host: 'app', origin: 'http://app' }), ['app']), true)
  assert.equal(trustedWsUpgrade(req({ host: 'app:443', origin: 'https://app:443' }), ['app']), true)
  assert.equal(trustedWsUpgrade(req({ host: 'app', origin: 'https://evil.example' }), ['app']), false)
  assert.equal(trustedWsUpgrade(req({ host: 'app', origin: 'http://evil.example' }), ['app']), false)
  // same check on the loopback path
  assert.equal(trustedWsUpgrade(req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }), []), true)
  assert.equal(trustedWsUpgrade(req({ host: '127.0.0.1:19387', origin: 'http://evil.example' }), []), false)
  // unparsable origin is refused
  assert.equal(trustedWsUpgrade(req({ host: 'app', origin: 'not a url' }), ['app']), false)
})

test('an explicit cross-site sec-fetch-site marker is refused regardless of trust', () => {
  assert.equal(trustedWsUpgrade(req({ host: 'app', 'sec-fetch-site': 'cross-site' }), ['app']), false)
  assert.equal(trustedWsUpgrade(req({ host: '127.0.0.1', 'sec-fetch-site': 'cross-site' }), []), false)
  assert.equal(trustedWsUpgrade(req({ host: 'app', 'sec-fetch-site': 'same-origin' }), ['app']), true)
})

test('missing and null origins keep the historical allowances', () => {
  assert.equal(trustedWsUpgrade(req({ host: 'app' }), ['app']), true)
  assert.equal(trustedWsUpgrade(req({ host: 'app', origin: 'null' }), ['app']), true)
})