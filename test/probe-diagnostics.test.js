import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createProbeDiagnostics, createProbeDiagnosticsRoute, classifyProbeError } from '../lib/probe-diagnostics.js'
import { SshPool } from '../lib/pool.js'
import { readFileSync } from 'node:fs'
import { registerSshCarrier, sshConnectorTargetIdentity } from '../lib/ssh-carrier.js'
import { normalizeCarrierMachine } from '../lib/ssh-carrier-record.js'
import { createCarrierSshPool } from '../lib/ssh-carrier-pool.js'

function call(route, query = '', method = 'GET') {
  const res = { headers: {}, setHeader(k,v) { this.headers[k] = v }, end(text) { this.data = JSON.parse(text) } }
  return route.handler({ method, url: '/dsh-remote/probe-diagnostics' + query }, res).then(() => res)
}
test('API is authenticated, GET-only, no-store and rejects unknown/duplicate/invalid queries', async () => {
  const store = createProbeDiagnostics()
  const route = createProbeDiagnosticsRoute(store, () => ({ requestRejection: () => undefined }))
  const good = await call(route)
  assert.equal(good.statusCode, 200); assert.equal(good.headers['Cache-Control'], 'no-store')
  for (const q of ['?limit=0','?limit=201','?limit=1.2','?after=-1','?after=9007199254740992','?machineId=bad/id','?machineId=','?unknown=x','?limit=1&limit=2']) {
    assert.equal((await call(route,q)).statusCode,400,q)
  }
  assert.equal((await call(route,'','POST')).statusCode,405)
  assert.equal((await call(createProbeDiagnosticsRoute(store, () => undefined))).statusCode,503)
  assert.equal((await call(createProbeDiagnosticsRoute(store, () => ({ requestRejection: () => 401 })))).statusCode,401)
})
test('bounded event/probe retention, strict seq pagination, filters, detached output and disposal', () => {
  const store = createProbeDiagnostics({ maxEvents: 4, maxProbes: 2 })
  const a = store.begin('a'); a.record('exec.start', { phase: 'exec' })
  const b = store.begin('b'); b.record('exec.complete')
  const page = store.list({ limit: 2 })
  assert.equal(page.events.length,2); assert.equal(page.hasMore,true)
  assert.ok(store.list({ after: page.nextAfter }).events.every(e=>e.seq>page.nextAfter))
  const c = store.begin('c'); c.record('probe.success')
  assert.equal(store.list().retainedProbes,2)
  assert.equal(store.list({ machineId:'a' }).events.length,0)
  assert.ok(store.list().events.length<=4)
  assert.equal(store.list({ after:1 }).truncated,true)
  const copy=store.list(); copy.events[0].event='modified'
  assert.notEqual(store.list().events[0].event,'modified')
  store.clear(); assert.equal(store.list().events.length,0)
  c.record('exec.start'); assert.equal(store.list().events.length,0)
  store.dispose(); store.begin('a').record('exec.start'); assert.equal(store.list().events.length,0)
})
test('secret injection/unknown errors never leak; timeout is not an authentication conclusion', () => {
  const store=createProbeDiagnostics(); const p=store.begin('saved')
  p.record('ssh.handshake.complete',{ phase:'ssh.handshake', banner:'SECRET', password:'SECRET', algorithms:{ key:'SECRET' }, generation:'SECRET', protocol:'SSH-SECRET', host:'/secret', port:1 })
  p.record('unknown-secret-event',{ token:'SECRET' })
  p.failure(new Error('SECRET token/password/private-key'))
  const wire=JSON.stringify(store.list())
  assert.ok(!wire.includes('SECRET')); assert.equal(store.list().events.at(-1).code,'UNKNOWN_ERROR')
  assert.equal(classifyProbeError(new Error('Timed out while waiting for handshake')), 'TIMEOUT')
  assert.notEqual(classifyProbeError(new Error('Timed out while waiting for handshake')), 'AUTHENTICATION_FAILED')
})
class FakeClient extends EventEmitter {
  constructor(timeout=false) { super(); this.timeout=timeout; this.ended=false }
  connect(opts) {
    this.options=opts
    queueMicrotask(() => {
      opts.debug?.("Remote ident: 'SSH-2.0-SECRET-banner'")
      if(this.timeout) this.emit('error',new Error('Timed out while waiting for handshake SECRET'))
      else { this.emit('handshake',{ password:'SECRET', banner:'SECRET' }); this.emit('ready') }
    })
  }
  end() { this.ended=true }
}
test('real SshPool/fakeClient identifies handshake completion separately from authentication ready', async () => {
  const store=createProbeDiagnostics(); const p=store.begin('saved'); const client=new FakeClient()
  const pool=new SshPool({ host:'127.0.0.1', port:22 }, { _clientFactory:()=>client, _probeDiagnostic:p.record })
  pool._buildConnectOpts=async()=>({}) // no credentials/key/agent access in the fixture
  await pool.connect(); pool.close()
  const events=store.list().events.map(e=>e.event)
  assert.deepEqual(events,['probe.start','ssh.identification','ssh.handshake.complete','ssh.ready'])
  assert.ok(!JSON.stringify(store.list()).includes('SECRET'))
  const throwing=new SshPool({}, { _clientFactory:()=>new FakeClient(), _probeDiagnostic:()=>{throw Error('sink')} })
  throwing._buildConnectOpts=async()=>({})
  await throwing.connect(); throwing.close()
})
test('real SshPool handshake timeout records last phase, never emits ready, and cleanup is explicit', async () => {
  const store=createProbeDiagnostics(); const p=store.begin('saved'); const client=new FakeClient(true)
  const pool=new SshPool({}, { _clientFactory:()=>client, _probeDiagnostic:p.record })
  pool._buildConnectOpts=async()=>({})
  await assert.rejects(pool.connect(), /Timed out/)
  p.failure(new Error('Timed out while waiting for handshake SECRET'))
  pool.close()
  assert.equal(client.ended,true,'finally cleanup closes the pre-ready probe Client too')
  const events=store.list().events
  assert.equal(events.at(-1).code,'TIMEOUT')
  assert.equal(events.at(-1).phase,'ssh.identification')
  assert.ok(!events.some(e=>e.event==='ssh.ready'))
  assert.ok(!JSON.stringify(events).includes('SECRET'))
})

for (const timeout of [false, true]) {
  test(`real handler + carrier pool + SshPool/fakeClient timeline (${timeout ? 'handshake timeout' : 'success'})`, async t => {
    const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const route = source.indexOf("path: '/dsh-remote/test-connect'")
    const begin = source.indexOf("        if (req.method !== 'POST')", route)
    const end = source.indexOf('\n      },\n    },\n    {', begin)
    const factory = new Function('d', `const { machines, config, parseJsonObject, readBody, sendJson, machineId,
      normalizeCarrierMachine, createCarrierSshPool, knownHostsFile, machinePassword, sshConnectorTargetIdentity,
      friendlyMessage, SshPool, probeDiagnostics, carrierPools } = d; return async(req,res)=>{${source.slice(begin,end)}}`)
    let releases=0
    const unregister = registerSshCarrier({ id:'diagnostic-fixture',
      validateConnector() {}, sanitizeConnector: c=>({kind:c.kind}), targetIdentity:()=> 'test-target',
      acquire: async()=>({dialHost:'127.0.0.1',dialPort:1234,targetIdentity:'test-target',
        generation:'11111111-1111-1111-1111-111111111111',closed:new Promise(()=>{}),release(){releases++}}) })
    t.after(unregister)
    const saved=normalizeCarrierMachine({id:'diag-saved',username:'test-user',useAgent:true,
      expectedHostFingerprint:'SHA256:'+Buffer.alloc(32,1).toString('base64').replace(/=+$/,''), connector:{kind:'diagnostic-fixture'}})
    const store=createProbeDiagnostics(), client=new FakeClient(timeout)
    class ProbePool extends SshPool {
      _buildConnectOpts(){return Promise.resolve({})}
      async exec(command){assert.equal(command,'true');return {code:0}}
    }
    const handler=factory({machines:[saved],config:{experimentalSshCarrier:true},parseJsonObject:JSON.parse,
      readBody:async()=>JSON.stringify({id:saved.id}),sendJson:(_,status,data)=>({status,data}), machineId:()=> 'new-id',
      normalizeCarrierMachine,createCarrierSshPool:(m,c,o)=>createCarrierSshPool(m,c,{...o,Pool:ProbePool,_clientFactory:()=>client}),
      knownHostsFile:undefined,machinePassword:async()=>'',sshConnectorTargetIdentity,friendlyMessage:e=>e.message,
      SshPool,probeDiagnostics:store,carrierPools:{peek:()=>undefined}})
    const result=await handler({method:'POST'}, {})
    assert.equal(result.data.ok,!timeout)
    const timeline=store.list().events
    assert.equal(result.data.probeId,timeline[0].probeId)
    assert.deepEqual(timeline.map(e=>e.event), timeout
      ? ['probe.start','carrier.acquire.start','carrier.acquire.complete','pool.connect.start','ssh.identification','probe.failure','pool.close.start','pool.close.complete']
      : ['probe.start','carrier.acquire.start','carrier.acquire.complete','pool.connect.start','ssh.identification','ssh.handshake.complete','ssh.ready','exec.start','exec.complete','probe.success','pool.close.start','pool.close.complete'])
    if(timeout){const failure=timeline.find(e=>e.event==='probe.failure');assert.equal(failure.code,'TIMEOUT');assert.equal(failure.phase,'ssh.identification')}
    assert.equal(releases,1);assert.equal(client.ended,true)
    assert.ok(!JSON.stringify(store.list()).includes('SECRET'))
  })
}
