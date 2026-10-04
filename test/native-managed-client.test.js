import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function load() {
  const sockets = [], requests = []
  class WS {
    constructor(url) { this.url=url; this.readyState=1; this.sent=[]; sockets.push(this) }
    send(s) { this.sent.push(JSON.parse(s)) }
    close() { this.readyState=3; this.onclose?.() }
    frame(frame) { this.onmessage?.({data: JSON.stringify(frame)}) }
  }
  const context = vm.createContext({ URL, URLSearchParams, location: {origin:'http://localhost'}, WebSocket: WS, apiPath: p=>p,
    fetch: async (path, opts) => { requests.push({path,...opts}); return {ok:true,json:async()=>({terminals:[]})} } })
  const begin=client.indexOf('    // Native managed lifetime'), end=client.indexOf('    // ── better-sidebar registration',begin)
  vm.runInContext(client.slice(begin,end)+'\nglobalThis.make = makeNativeWorkspaceSource',context)
  return { source: context.make('session-real'), sockets, requests }
}
test('native management sends session only and list propagates AbortSignal', async () => {
  const {source,requests}=load(); const signal=new AbortController().signal
  await source.create('T'); await source.list(signal); await source.terminate('remote-managed:id')
  assert.deepEqual(requests.map(r=>JSON.parse(r.body)), [{title:'T',sessionId:'session-real'},{sessionId:'session-real'},{terminalId:'remote-managed:id',sessionId:'session-real'}])
  assert.equal(requests[1].signal,signal)
})
test('existing id is attach-only, multiple views detach without terminate, closed is string contract', () => {
  const {source,sockets,requests}=load(); const outputs=[],closed=[],fatal=[]
  const transport=source.createTransport('remote-managed:id')
  const one=transport.open({onOutput:x=>outputs.push(x),onClosed:x=>closed.push(x),onFatal:x=>fatal.push(x)})
  const two=transport.open({onOutput:x=>outputs.push(x)})
  assert.equal(requests.length,0); assert.equal(new URL(sockets[0].url).searchParams.get('sessionId'),'session-real')
  sockets[0].frame({type:'output',data:'{"type":"exit"}'}); one.input('a'); one.resize(90,30)
  assert.equal(outputs[0],'{"type":"exit"}'); assert.deepEqual(sockets[0].sent,[{type:'input',data:'a'},{type:'resize',cols:90,rows:30}])
  sockets[0].frame({type:'closed',reason:'exited'}); assert.deepEqual(closed,['exited']); one.retry(); assert.equal(sockets.length,2)
  two.park(); two.close(); two.dispose(); assert.equal(requests.length,0)
})
test('permission denial is fatal, not missing, and cannot resume/restart via retry', () => {
  const {source,sockets}=load(); const closed=[],fatals=[]
  const handle=source.createTransport('remote-managed:id').open({onClosed:x=>closed.push(x),onFatal:x=>fatals.push(x)})
  sockets[0].frame({type:'fatal',message:'denied'}); handle.retry()
  assert.deepEqual(closed,[]); assert.deepEqual(fatals,['denied']); assert.equal(sockets.length,1)
})
test('network error releases socket and retry clears banner while stale callbacks are ignored', () => {
  const {source,sockets}=load(); const fatal=[],out=[]
  const handle=source.createTransport('remote-managed:id').open({onFatal:x=>fatal.push(x),onOutput:x=>out.push(x)})
  const old=sockets[0];old.onerror();assert.equal(old.readyState,3);handle.retry();assert.equal(sockets.length,2);assert.equal(fatal.at(-1),null)
  old.frame({type:'output',data:'stale'});sockets[1].frame({type:'output',data:'live'});assert.deepEqual(out,['live'])
  sockets[1].close();handle.retry();assert.equal(sockets.length,3);handle.dispose()
})
test('terminated is terminal closed reason and native rejects saved workbench namespace', async () => {
  const {source,sockets,requests}=load();const closed=[],fatal=[]
  const handle=source.createTransport('remote-managed:id').open({onClosed:x=>closed.push(x)})
  sockets[0].frame({type:'closed',reason:'terminated'});handle.retry();assert.deepEqual(closed,['terminated']);assert.equal(sockets.length,1)
  source.createTransport('term-workbench').open({onFatal:x=>fatal.push(x)});assert.equal(sockets.length,1);assert.equal(fatal.length,1)
  await assert.rejects(source.terminate('term-workbench'),/backend unavailable/);assert.equal(requests.length,0)
})
test('output has one sink even with both surface.write and onOutput', () => {
  const {source,sockets}=load();const writes=[],outputs=[]
  const handle=source.createTransport('remote-managed:id').open({term:{write:x=>writes.push(x)},onOutput:x=>outputs.push(x)})
  sockets[0].frame({type:'output',data:'once'});assert.deepEqual(outputs,['once']);assert.deepEqual(writes,[]);handle.dispose()
})
