import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import * as fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { loadMachines } from '../lib/registry.js'
import { apply } from '../lib/index.js'

const host = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function fixture(t) {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'dsh-isolation-'))
  const prior = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; fs.rmSync(home, { recursive: true, force: true }) })
  const root = path.join(home, 'remote-workspaces')
  fs.mkdirSync(root)
  return { home, root }
}

function mirrorCode(root) {
  const start = host.indexOf('function mirrorRootFor(')
  const end = host.indexOf('/** Recursive directory copy', start)
  const ctx = vm.createContext({ ...fs, path, _loadMachines: loadMachines, remoteWorkspacesRoot: () => root,
    remotePathBase: path.posix.basename, normalizeRemotePath: (p) => p, shortHash: () => 'hash' })
  vm.runInContext(host.slice(start, end), ctx)
  return ctx
}

test('mirror origin preserves SSH username/port and only valid project directories match', (t) => {
  const { root } = fixture(t)
  const ctx = mirrorCode(root)
  const dir = ctx.ensureMirror('/srv/project', { host: 'host-a', username: 'alice', port: 2202 })
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '.dsh-remote-meta.json')))
  assert.equal(meta.username, 'alice')
  assert.equal(meta.port, 2202)
  assert.equal(ctx.mirrorMatchOf(path.join(dir, 'src')).host, 'host-a')
  for (const local of [root, path.dirname(dir), dir + '-other', '/local/project']) assert.equal(ctx.mirrorMatchOf(local), null)
  fs.writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host: 'a', username: 2202, port: 'alice', remotePath: '/srv/project' }))
  assert.equal(ctx.mirrorMatchOf(dir), null)
  fs.writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: [{ id: 'a', host: 'a', username: 'alice', port: 2202 }] }))
  assert.equal(ctx.mirrorMatchOf(dir).username, 'alice')
  assert.equal(ctx.mirrorMatchOf(dir).port, 2202)
  // Compatibility is read-only: preserve the user's existing mirror data.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.dsh-remote-meta.json'))).username, 2202)
})

test('client selects current session, not first list entry; terminal gate enables remote mirrors', () => {
  const scopeStart = client.indexOf('    function scopeCwdGuess()')
  const scopeEnd = client.indexOf('\n    // ── Settings', scopeStart)
  const gateStart = client.indexOf('    function sessionIsRemote(cwd)')
  const gateEnd = client.indexOf('\n    function fetchRemoteStatus', gateStart)
  const list = { current: 'local', order: ['remote', 'local'], byId: { remote: { cwd: '/mirrors/a/project' }, local: { cwd: '/local/project' } } }
  const ctx = vm.createContext({ SESSIONS: { list: { getSnapshot: () => list } }, MIRROR_DIRS: ['/mirrors/a/project'] })
  vm.runInContext(client.slice(scopeStart, scopeEnd) + client.slice(gateStart, gateEnd), ctx)
  assert.equal(ctx.scopeCwdGuess(), '/local/project')
  delete list.current
  assert.equal(ctx.scopeCwdGuess(), '')
  const available = client.match(/available: (\(_ctx, scope\) => [^\n]+),/)[1]
  const gate = vm.runInContext(available, ctx)
  assert.equal(gate(null, { cwd: '/mirrors/a/project/src' }), true)
  for (const cwd of ['/local/project', '/mirrors', '/mirrors/a', '/mirrors/a/project-other', undefined]) assert.equal(gate(null, { cwd }), false)
})

test('status and mirror resolution agree for local, live remote, historical and unknown sessions', async (t) => {
  const { home, root } = fixture(t)
  const mirror = mirrorCode(root).ensureMirror('/srv/project', { host: 'host-a', username: 'alice', port: 2202 })
  fs.writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: [{ id: 'a', host: 'host-a', username: 'alice', port: 2202 }], workspaces: {} }))
  const dir = path.join(home, 'sessions', 'project', 'history')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify({ cwd: mirror }) + '\n')
  const routes = new Map()
  const sessions = { get: (id) => id === 'remote' ? { header: { cwd: mirror } } : id === 'local' ? { header: { cwd: '/local/project' } } : null, list: () => [{ header: { cwd: mirror } }] }
  await apply({ effect: () => {}, get: (name) => name === 'sessions' ? sessions : name === 'webServer' ? { register: (r) => { routes.set(r.path, r.handler); return () => {} } } : undefined, tools: { register: () => {} }, systemPrompt: { section: () => {} } }, {})
  async function get(url) {
    let result
    const res = { setHeader: () => {}, writeHead: () => {}, end: (body) => { result = JSON.parse(body) } }
    await routes.get(url.split('?')[0])({ method: 'GET', url }, res)
    return result
  }
  for (const id of ['local', 'remote', 'history', 'missing']) {
    const status = await get('/dsh-remote/status?sessionId=' + id)
    const resolved = await get('/dsh-remote/resolve-mirror?sessionId=' + id)
    assert.equal(status.sessionMode, resolved.mode)
    assert.equal(status.sessionRemotePath, resolved.remotePath)
    assert.equal(status.currentId, ['remote', 'history'].includes(id) ? 'a' : null)
  }
  const local = await get('/dsh-remote/status?cwd=/local/project')
  assert.equal(local.sessionMode, 'local')
  assert.equal(local.host, '')
  assert.deepEqual(local.mirrorDirs, [mirror])
})

test('creating a mirror binds the new workspace, leaving the source workspace untouched', async (t) => {
  const { root } = fixture(t)
  const mirrors = mirrorCode(root)
  const machine = { id: 'b', host: 'host-b', username: 'bob', port: 2222 }
  const persisted = []
  const start = host.indexOf("      path: '/dsh-remote/mirror',")
  const end = host.indexOf('\n    {', start)
  const context = vm.createContext({
    normalizeRemotePath: (p) => p, readBody: async () => JSON.stringify({ path: '/srv/b', machine: 'b', workspace: '/local/a' }),
    ctxForCwd: () => ({}), machineIndex: () => 0, machines: [machine],
    machinePoolOf: async () => ({}), isRemoteDirOn: async () => true,
    ensureMirror: mirrors.ensureMirror, persistWorkspace: (p, cwd) => persisted.push(cwd), startAutoPush: () => {}, status: () => ({}),
    sendJson: (_res, code, body) => ({ code, body }),
  })
  const route = vm.runInContext('({' + host.slice(start, end).trim().replace(/,$/, '') + ')', context)
  const res = await route.handler({ method: 'POST' }, {})
  assert.equal(res.code, 200)
  assert.deepEqual(persisted, [res.body.localMirror])
  assert.notEqual(res.body.localMirror, '/local/a')
  assert.equal(mirrors.mirrorMatchOf(res.body.localMirror).username, 'bob')
})

test('terminal handshake derives its target from the workspace and refuses mismatched origins', () => {
  const start = host.indexOf("            const sessionCwd = sessionCwdOf(q.get('sessionId'))")
  const end = host.indexOf('            terminals.attach(ws, params)', start)
  const owners = {
    '/mirror/a': { source: 'mirror', mirrorDir: '/mirror/a', machineId: 'a', workspace: '/srv/a' },
    '/mirror/b': { source: 'mirror', mirrorDir: '/mirror/b', machineId: 'b', workspace: '/srv/b' },
    '/local': { source: 'selection', machineId: 'b', workspace: '/srv/b' },
  }
  function resolve(workspace, machine, sessionId = '') {
    const params = { machine, cwd: '/untrusted-cwd', resume: 'same-tab' }
    const ctx = vm.createContext({ path, params, q: new URLSearchParams({ workspace, sessionId }), sessionCwdOf: (id) => id === 'a' ? '/mirror/a' : '', ctxForCwd: (cwd) => owners[cwd] || {} })
    vm.runInContext(host.slice(start, end), ctx)
    return params
  }
  const a = resolve('/mirror/a', 'a', 'a')
  const b = resolve('/mirror/b', 'b')
  assert.equal(a.cwd, '/srv/a')
  assert.equal(b.cwd, '/srv/b')
  assert.notEqual(a.resume, b.resume)
  assert.throws(() => resolve('/local', 'b'), /requires a valid remote mirror/)
  assert.throws(() => resolve('/mirror/a', 'b'), /machine does not match/)
  assert.throws(() => resolve('/mirror/b', 'b', 'a'), /workspace does not match session/)
  assert.throws(() => resolve('', ''), /requires a valid remote mirror/)
})
