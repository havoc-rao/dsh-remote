import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { gitWorkspaceMachine } from '../lib/git-workspace-machine.js'
import { createGitWorkspaceProbeCache, gitProbeErrorReason } from '../lib/git-workspace-probe.js'
import { buildWorkspaceMarker, parseStatusV1 } from '../lib/git-parse.js'
import { registerSshCarrier } from '../lib/ssh-carrier.js'
import { normalizeCarrierMachine } from '../lib/ssh-carrier-record.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const start = source.indexOf("path: '/dsh-remote/git-workspace',")
const bodyStart = source.indexOf('handler: async (req, res) => {', start)
const end = source.indexOf('\n      },\n    },', bodyStart)
assert.ok(start > 0 && end > bodyStart)
const handlerText = source.slice(bodyStart + 'handler: '.length, end) + '\n}'

function route(machine, { repo = true, local = false, owner = true, offline = false, error = null } = {}) {
  const calls = []
  const cache = new Map()
  const pool = { machineId: machine?.id, client: offline ? null : {}, platform: 'posix' }
  const logs = []
  const context = {
    gitWorkspacePoolOf: () => pool, gitWorkspaceProbeCache: createGitWorkspaceProbeCache(), gitProbeErrorReason,
    TypeError, ReferenceError, SyntaxError,
    URL, console: { error: (...args) => logs.push(args) }, Date, gitWorkspaceMachine, buildWorkspaceMarker, parseStatusV1,
    machines: [machine], normalizeRemotePath: p => p,
    mirrorMatchOf: () => ({ remotePath: '/srv/project', mirrorDir: '/mirror/project' }),
    machineForMirror: () => owner ? { record: machine } : null,
    machineIndex: id => id === machine?.id ? 0 : -1,
    machinePoolOf: async () => { assert.fail('passive marker must not acquire/connect a machine') },
    routePoolOf: async () => ({ pool }),
    gitMachineTag: m => m?.id || 'shared', gitPathId: p => p,
    gitWorkspaceCache: cache, GIT_WORKSPACE_MARKER_TTL_MS: 5000, GIT_WORKSPACE_MARKER_MAX: 128,
    isGitInfraError: () => false,
    classifyError: () => ({ category: 'other' }),
    gitRun: async (rp, dir, args, options) => {
      assert.equal(options.passive, true, 'every marker command must disable SSH recovery/replay')
      assert.equal(rp, pool)
      calls.push({ dir, args })
      if (error) throw error
      return { code: repo ? 0 : 128, stderr: repo ? '' : 'fatal: not a git repository', stdout: args[0] === 'rev-parse' ? (repo ? '/srv/project\n' : '') : '## main...origin/main [ahead 1]\0 M changed.txt\0' }
    },
    // Exercise the actual wire boundary: undefined cannot survive this round trip.
    sendJson: (_res, status, payload) => ({ status, data: JSON.parse(JSON.stringify(payload)) }),
  }
  const handler = vm.runInNewContext('(' + handlerText + ')', context)
  const url = local ? '/dsh-remote/git-workspace?local=/mirror/project' : '/dsh-remote/git-workspace?path=/srv/project&machine=' + machine.id
  return { request: () => handler({ method: 'GET', url }, {}), calls, pool, logs }
}

const direct = { id: 'direct', name: 'Direct SSH', host: 'example.org', port: 2202, username: 'alice', password: 'DO_NOT_LEAK' }
const carrierRaw = { id: 'carrier', name: 'Carrier SSH', transport: 'ssh', username: 'alice', connector: { kind: 'fixture-marker', target: 'stable-target' }, expectedHostFingerprint: 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '') }

test('real route serialized repo/nonRepo marker preserves direct SSH and normalized carrier identities', async t => {
  const dispose = registerSshCarrier({ id: 'fixture-marker', acquire() {}, sanitizeConnector: c => ({ kind: c.kind, target: c.target }), targetIdentity: c => c.target })
  t.after(dispose)
  const carrier = normalizeCarrierMachine(carrierRaw)
  assert.equal(Object.hasOwn(carrier, 'host'), false, 'regression fixture must have the actual missing-host shape')
  for (const machine of [direct, carrier]) for (const repo of [true, false]) for (const local of [true, false]) {
    const r = route(machine, { repo, local })
    const first = await r.request()
    assert.equal(first.status, 200)
    const marker = first.data.marker
    assert.equal(marker.isRepo, repo)
    assert.equal(marker.machine.id, machine.id)
    assert.equal(typeof marker.machine.host, 'string', 'legacy consumer shape guard')
    assert.equal(marker.machine.schemaVersion, 2)
    assert.equal(marker.machine.displayName, machine.name)
    assert.equal(marker.machine.transport, 'ssh')
    if (machine === direct) {
      assert.deepEqual(marker.machine.endpoint, { host: 'example.org', port: 2202, username: 'alice' })
      assert.equal(marker.machine.carrierKind, undefined)
    } else {
      assert.equal(marker.machine.host, '')
      assert.equal(marker.machine.port, 22)
      assert.equal(marker.machine.carrierKind, 'fixture-marker')
      assert.equal(marker.machine.endpoint, undefined)
    }
    for (const forbidden of ['password', 'connector', 'expectedHostFingerprint', 'dialHost', 'dialPort', 'generation', 'target']) assert.equal(Object.hasOwn(marker.machine, forbidden), false)
    const count = r.calls.length
    assert.deepEqual(await r.request(), first, 'cached response uses the same valid JSON contract')
    assert.equal(r.calls.length, count)
  }
})

test('non-SSH keeps legacy fields but never advertises placeholder as endpoint', async () => {
  const machine = { id: 'tunnel', transport: 'vscode-tunnel', host: '127.0.0.1', port: 0, username: '', tunnel: { secret: 'DO_NOT_LEAK' } }
  const r = await route(machine).request()
  assert.deepEqual(r.data.marker.machine, { id: 'tunnel', name: '', host: '127.0.0.1', port: 22, username: 'root', schemaVersion: 2, transport: 'vscode-tunnel', displayName: 'tunnel' })
})

test('carrier projection ignores injected transient host/port and allows unnamed stable machine', () => {
  const out = gitWorkspaceMachine({ ...carrierRaw, name: '', host: '127.0.0.1', port: 54321, password: 'secret' })
  assert.equal(out.host, '')
  assert.equal(out.port, 22)
  assert.equal(out.displayName, 'carrier')
  assert.equal(out.endpoint, undefined)
  assert.equal(gitWorkspaceMachine(null), null)
  assert.equal(gitWorkspaceMachine({ host: 'ssh-alias', useSshConfig: true }).displayName, 'ssh-alias')
})

test('offline carrier marker stays silent and ready connection bypasses pause', async () => {
  const r = route(carrierRaw, { local: true, offline: true })
  for (let i = 0; i < 3; i++) {
    const out = await r.request()
    assert.equal(out.status, 200)
    assert.equal(out.data.marker, null)
    assert.equal(out.data.probe.state, 'unavailable')
    assert.ok(out.data.probe.retryAfterMs > 0 && out.data.probe.retryAfterMs <= 30000)
  }
  assert.equal(r.calls.length, 0)
  assert.equal(r.logs.length, 0)
  r.pool.client = {}
  assert.equal((await r.request()).data.marker.isRepo, true)
})

test('transport errors pause without logging; unknown programming errors remain 500', async () => {
  const offline = route(direct, { error: Object.assign(new Error('private endpoint ECONNRESET'), { code: 'ECONNRESET' }) })
  const first = await offline.request()
  assert.equal(first.status, 200)
  assert.equal(first.data.probe.reason, 'connection_offline')
  assert.equal(JSON.stringify(first).includes('private endpoint'), false)
  await offline.request()
  assert.equal(offline.calls.length, 1)
  assert.equal(offline.logs.length, 0)
  const bug = route(direct, { error: new TypeError('timeout variable is broken') })
  assert.equal((await bug.request()).status, 500)
  assert.equal(bug.logs.length, 1)
})

test('negative cache expires, stays bounded and invalidates on client change', () => {
  let now = 0
  const cache = createGitWorkspaceProbeCache({ now: () => now, max: 2 })
  cache.set('a', null, 'connection_unavailable')
  cache.set('b', null, 'connection_unavailable')
  cache.set('c', null, 'connection_unavailable')
  assert.equal(cache.get('a', null), null)
  assert.equal(cache.get('b', {}), null)
  now = 30000
  assert.equal(cache.get('c', null), null)
})

test('orphaned local mirror retains marker:null semantics and performs no git calls', async () => {
  const r = route(direct, { local: true, owner: false })
  assert.deepEqual(await r.request(), { status: 200, data: { ok: true, marker: null } })
  assert.equal(r.calls.length, 0)
})
