import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveManagedOwner, managedTerminalRoutes, attachManagedTerminal } from '../lib/managed-terminal-routes.js'

function fixture() {
  const origins = { a: { source: 'mirror', machineId: 'm', workspace: '/link' }, b: { source: 'mirror', machineId: 'm', workspace: '/real' }, local: { source: 'none' } }
  const calls = []
  const deps = { sessionCwdOf: id => id in origins ? id : '', ctxForCwd: cwd => origins[cwd] || {},
    getPool: async machine => ({ sftp: async () => ({ realpath: async root => { calls.push([machine, root]); return '/real' } }) }) }
  return { origins, calls, deps }
}
test('only authoritative session roots are canonicalized and same workspace sessions share key', async () => {
  const { deps, calls } = fixture()
  assert.deepEqual(await resolveManagedOwner('a', deps), await resolveManagedOwner('b', deps))
  assert.deepEqual(calls, [['m', '/link'], ['m', '/real']])
  for (const id of ['missing', 'local', '../a', '', null]) await assert.rejects(resolveManagedOwner(id, deps), { code: 'FORBIDDEN' })
})
test('legacy owner keeps exact key and detaches when upgraded to strict routing', async () => {
  const { deps, origins } = fixture()
  const owner = await resolveManagedOwner('a', deps)
  assert.deepEqual(owner, { machineId: 'm', workspace: '/real', key: '["m","/real"]' })
  assert.equal(owner.isCurrent(), true)
  Object.assign(origins.a, { schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: 'descriptor-A' })
  assert.equal(owner.isCurrent(), false)
})
test('strict owner snapshots descriptor target, shares canonical key and ignores endpoints', async () => {
  const { deps, origins } = fixture()
  for (const id of ['a', 'b']) Object.assign(origins[id], { schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: 'descriptor-A', host: '127.0.0.1', port: id === 'a' ? 1001 : 1002 })
  const owner = await resolveManagedOwner('a', deps)
  assert.deepEqual(owner, { machineId: 'm', workspace: '/real', connectorTargetIdentity: 'descriptor-A', key: '["m","/real","descriptor-A"]' })
  assert.deepEqual(await resolveManagedOwner('b', deps), owner)
  origins.a.port = 1003
  assert.equal(owner.isCurrent(), true)
  origins.a.connectorTargetIdentity = 'descriptor-B'
  assert.equal(owner.isCurrent(), false)
  assert.equal(owner.connectorTargetIdentity, 'descriptor-A')
  assert.notEqual((await resolveManagedOwner('a', deps)).key, owner.key)
  origins.a.connectorTargetIdentity = 'descriptor-A'
  assert.equal(owner.isCurrent(), true)
  delete origins.a.schemaVersion
  assert.equal(owner.isCurrent(), false)
})
test('strict target rebound during canonicalization is denied even with same machine and workspace', async () => {
  const { deps, origins } = fixture()
  Object.assign(origins.a, { schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: 'descriptor-A' })
  deps.getPool = async () => ({ sftp: async () => ({ realpath: async () => {
    origins.a.connectorTargetIdentity = 'descriptor-B'
    return '/real'
  } }) })
  await assert.rejects(resolveManagedOwner('a', deps), { code: 'FORBIDDEN' })
})
test('malformed strict origins fail closed before connecting', async () => {
  const variants = [
    { schemaVersion: 3, transport: 'ssh' },
    { schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: '' },
    { schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: '   ' },
    { schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: {} },
    { schemaVersion: 3, transport: 'vscode-tunnel', connectorTargetIdentity: 'descriptor-A' },
    { schemaVersion: 4, transport: 'ssh', connectorTargetIdentity: 'descriptor-A' },
    { schemaVersion: '3', transport: 'ssh', connectorTargetIdentity: 'descriptor-A' },
    { connectorTargetIdentity: 'descriptor-A' },
  ]
  for (const variant of variants) {
    const { deps, origins } = fixture()
    Object.assign(origins.a, variant)
    deps.getPool = async () => { assert.fail('malformed strict origin must not connect') }
    await assert.rejects(resolveManagedOwner('a', deps), { code: 'FORBIDDEN' })
  }
})
test('strict target rebound while spawning rolls back captured target and denies result', async () => {
  const { deps, origins } = fixture(); const killed = []
  Object.assign(origins.a, { schemaVersion: 3, transport: 'ssh', connectorTargetIdentity: 'descriptor-A' })
  const routes = managedTerminalRoutes({ resolveOwner: id => resolveManagedOwner(id, deps), manager: {
    create: async () => { origins.a.connectorTargetIdentity = 'descriptor-B'; return { terminalId: 'remote-managed:new' } },
    terminate: (owner, id) => killed.push([owner, id]),
  }, readBody: async () => '{"sessionId":"a"}', sendJson: (res, status, body) => Object.assign(res, { status, body }) })
  const res = {}; await routes[0].handler({ method: 'POST' }, res)
  assert.equal(res.status, 403)
  assert.deepEqual(killed, [[{ machineId: 'm', workspace: '/real', key: '["m","/real","descriptor-A"]', connectorTargetIdentity: 'descriptor-A' }, 'remote-managed:new']])
})
test('awaited canonicalization cannot authorize rebound session', async () => {
  const { deps, origins } = fixture()
  deps.getPool = async () => ({ sftp: async () => ({ realpath: async () => { origins.a = { source: 'mirror', machineId: 'other', workspace: '/real' }; return '/real' } }) })
  await assert.rejects(resolveManagedOwner('a', deps), { code: 'FORBIDDEN' })
})
test('route rejects cwd-only requests and passes no client machine/root to manager', async () => {
  const { deps } = fixture(); const used = []
  const routes = managedTerminalRoutes({ resolveOwner: id => resolveManagedOwner(id, deps), manager: {
    create: async (...args) => { used.push(args); return { terminalId: 'remote-managed:1' } }, list: () => ({ terminals: [] }), terminate() {},
  }, readBody: async req => JSON.stringify(req.body), sendJson: (res, status, body) => Object.assign(res, { status, body }) })
  const res = {}; await routes[0].handler({ method: 'POST', body: { cwd: 'a', workspace: 'a' } }, res)
  assert.equal(res.status, 403); assert.equal(used.length, 0)
  await routes[0].handler({ method: 'POST', body: { sessionId: 'a', cwd: '/evil', machine: 'evil', title: 'T' } }, res)
  assert.equal(res.status, 200); assert.deepEqual(used[0], [{ machineId: 'm', workspace: '/real', key: '["m","/real"]' }, 'a', 'T'])
})
test('route error envelopes distinguish missing, forbidden and quota without secrets', async () => {
  for (const [code, status] of [['MISSING',404], ['FORBIDDEN',403], ['QUOTA',429], ['secret',400]]) {
    const routes = managedTerminalRoutes({ resolveOwner: async () => { throw Object.assign(new Error('PASSWORD-secret'), { code }) }, manager: {}, readBody: async () => '{"sessionId":"a"}', sendJson: (res,status,body) => Object.assign(res,{status,body}) })
    const res={}; await routes[1].handler({method:'POST'},res); assert.equal(res.status,status); assert.ok(!JSON.stringify(res).includes('PASSWORD'))
  }
})
test('WS authorization failures are fatal, missing is closed, browser cwd cannot authorize', async () => {
  for (const code of ['FORBIDDEN','MISSING']) {
    const frames=[]; const ws={readyState:1,send:s=>frames.push(JSON.parse(s)),close(){this.readyState=3}}
    await attachManagedTerminal(ws,new URLSearchParams({sessionId:'wrong',cwd:'/real',terminalId:'remote-managed:id'}),{resolveOwner:async()=>{throw Object.assign(new Error('secret'),{code})},manager:{}})
    assert.equal(frames[0].type,code==='MISSING'?'closed':'fatal'); assert.ok(!JSON.stringify(frames).includes('secret'))
  }
})
test('session rebound while spawning kills created PTY and denies result', async () => {
  let resolves=0;const killed=[]
  const routes=managedTerminalRoutes({resolveOwner:async()=>({key:++resolves===1?'old':'new'}), manager:{create:async()=>({terminalId:'remote-managed:new'}),terminate:(owner,id)=>killed.push([owner.key,id])},readBody:async()=>'{"sessionId":"a"}',sendJson:(res,status,body)=>Object.assign(res,{status,body})})
  const res={};await routes[0].handler({method:'POST'},res);assert.equal(res.status,403);assert.deepEqual(killed,[['old','remote-managed:new']])
})
