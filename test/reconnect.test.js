// Reconnect route (/dsh-remote/reconnect) + credential-classified listing
// errors. Boots the REAL host half (lib/index.js apply) against a TEMP
// DSH_HOME with stub ctx/webServer — no SSH, no network: every assertion
// exercises deterministic paths only:
//   R1 route registered under the /dsh-remote/ prefix
//   R2 GET → 405
//   R3 POST {} → 400 "no remote machine"
//   R4 POST unknown machineId → 404
//   R5 /ls on an unmapped path (shared pool, no credentials) →
//      500 { error: '…no credentials…', credential: true } — the exact
//      symptom the browser reconnect UX reacts to
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function boot() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reconnect-test-'))
  fs.mkdirSync(path.join(TMP, 'remote-workspaces'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'remote-workspaces', 'machines.json'), JSON.stringify({ machines: [], currentId: null }))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = TMP
  // DSH_HOME stays pointed at the fixture for the WHOLE test. Route handlers
  // read remoteWorkspacesRoot() LAZILY per request, so restoring the env right
  // after apply() would leak the user's REAL ~/.dsh mirror set into the later
  // assertions — making pass/fail depend on unrelated real-world data (and
  // loading real mirrors whose machines are not in the fixture registry).
  const restoreHome = () => { process.env.DSH_HOME = oldHome }
  const registered = []
  const disposers = []
  const webServer = {
    register: (r) => { registered.push(r); return () => {} },
    registerUpgrade: () => {},
    registerRoute: () => {},
  }
  const ctx = {
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    effect: (fn) => disposers.push(fn),
    get: (n) => (n === 'webServer' ? webServer : undefined),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  return {
    restoreHome,
    async ready() {
      const { apply } = await import(path.join(ROOT, 'lib/index.js'))
      await apply(ctx, {
        autoPush: false, updateMode: 'off', useAgent: false, hostKeyMode: 'accept-new',
        commandTimeoutMs: 20000, encoding: 'utf-8', maxFileBytes: 0, auditLog: false,
      })
      return { registered, disposers }
    },
  }
}

/** Drive a registered route handler with fake req/res. Resolves { status, body }. */
function call(handler, url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.url = url
    req.method = method
    if (body !== null) {
      setTimeout(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }, 0)
    } else {
      setTimeout(() => req.emit('end'), 0)
    }
    const res = new EventEmitter()
    res.statusCode = 0
    res.body = ''
    res.setHeader = () => {}
    res.end = (chunk) => { res.body += String(chunk); resolve(res) }
    handler(req, res).catch(reject)
  })
}

const parse = (r) => { try { return JSON.parse(r.body) } catch { return {} } }

test('reconnect route: registered, guards, and credential flags', async () => {
  const env = boot()
  try {
    const { registered, disposers } = await env.ready()
    const rc = registered.find((r) => r && r.path === '/dsh-remote/reconnect')
    assert.ok(rc, 'POST /dsh-remote/reconnect must be registered')
    assert.equal(rc.kind, 'exact')

    // R2: non-POST → 405
    const r2 = await call(rc.handler, '/dsh-remote/reconnect')
    assert.equal(r2.statusCode, 405)

    // R3: no target at all → 400 with the actionable message
    const r3 = await call(rc.handler, '/dsh-remote/reconnect', 'POST', {})
    assert.equal(r3.statusCode, 400)
    assert.match(String(parse(r3).error || ''), /no remote machine/)

    // R4: unknown machine id → 404
    const r4 = await call(rc.handler, '/dsh-remote/reconnect?machine=nope', 'POST', {})
    assert.equal(r4.statusCode, 404)
    assert.match(String(parse(r4).error || ''), /not saved/)

    // R5: listing through the credential-less shared pool fails with the
    // credential marker — the exact "browse failed: no credentials" symptom
    // the client reconnect buttons react to.
    const ls = registered.find((r) => r && r.path === '/dsh-remote/ls')
    assert.ok(ls, '/dsh-remote/ls must be registered')
    const r5 = await call(ls.handler, '/dsh-remote/ls?path=' + encodeURIComponent('/data/workspace/unknown-xyz'))
    assert.equal(r5.statusCode, 500)
    const j5 = parse(r5)
    assert.equal(j5.credential, true)
    assert.match(String(j5.error || ''), /no credentials/i)

    for (const d of disposers) { try { d() } catch {} }
  } finally {
    env.restoreHome()
  }
})