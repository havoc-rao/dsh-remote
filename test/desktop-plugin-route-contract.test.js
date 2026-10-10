import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { registerHttpTransports } from '../lib/http-transport.js'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const apiPath = vm.runInNewContext(client.match(/function apiPath\(path\) \{[\s\S]*?\n    \}/)[0] + '; apiPath', {
  window: { location: { protocol: 'dsh-app:' } },
})

// Contract excerpt verified against actual Desktop apps/desktop/src/web-document.ts
// forwardWebRequest (77–88): preserve pathname/search, reject foreign Origin,
// replace renderer-supplied Cookie with the host-issued authentication cookie.
async function desktopForward(request, host, cookie, fetchHost) {
  const source = new URL(request.url)
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://app') return new Response(null, { status: 403 })
  const target = new URL(host)
  target.pathname = source.pathname
  target.search = source.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', cookie)
  return fetchHost(target, { method: request.method, headers, body: request.body, signal: request.signal })
}

test('Desktop preserved pathname reaches the real registered Web route and its authentication fence', async () => {
  const registrations = new Map()
  let dispatches = 0, forwarded = 0
  const pending = new Map()
  const connection = { requestRejection: req => req.headers.cookie === 'host-auth-cookie' ? undefined : 401 }
  registerHttpTransports({ inject(names, fn) { pending.set(names[0], fn) }, get: () => connection }, [{
    kind: 'exact', path: '/dsh-remote/contract', handler(req, res) {
      dispatches++; assert.equal(req.url, '/dsh-remote/contract?q=1')
      res.end(JSON.stringify({ ok: true }))
    },
  }])
  pending.get('webServer')({ get: () => ({ register(route) { registrations.set(route.path, route); return () => {} } }), effect(fn) { fn() } })
  const fetchHost = async (url, init) => {
    forwarded++
    const route = registrations.get(url.pathname)
    if (!route) return new Response(null, { status: 404 })
    let status = 200, body
    await route.handler({ method: init.method, url: url.pathname + url.search, headers: Object.fromEntries(init.headers) }, {
      writeHead(code) { status = code }, end(value) { body = value },
    })
    return new Response(body, { status })
  }
  const request = path => new Request('dsh-app://app' + path, { method: 'POST', body: '{}', headers: { origin: 'dsh-app://app', cookie: 'untrusted-renderer-cookie' } })
  const response = await desktopForward(request(apiPath('/dsh-remote/contract?q=1')), 'http://127.0.0.1:1234', 'host-auth-cookie', fetchHost)
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true })
  assert.equal(dispatches, 1); assert.equal(forwarded, 1)
  assert.equal((await desktopForward(request('/api/dsh-remote/contract?q=1'), 'http://127.0.0.1:1234', 'host-auth-cookie', fetchHost)).status, 404)
  assert.equal(dispatches, 1, 'no /api alias and no write replay')
  assert.equal((await desktopForward(request(apiPath('/dsh-remote/contract?q=1')), 'http://127.0.0.1:1234', 'wrong-cookie', fetchHost)).status, 401)
  const foreign = new Request('dsh-app://app/dsh-remote/contract?q=1', { headers: { origin: 'https://foreign.example' } })
  assert.equal((await desktopForward(foreign, 'http://127.0.0.1:1234', 'host-auth-cookie', fetchHost)).status, 403)
  assert.equal(forwarded, 3, 'foreign origins never reach host')
  assert.equal(dispatches, 1)
})
