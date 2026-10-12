import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Execute the production component, not a copied implementation. Include its
// preceding module helper without depending on its private name.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function RemoteExplorerTab(props)')
const end = source.indexOf('      const onCtx =', start)
assert.ok(start >= 0 && end > start, 'production explorer extraction boundaries')
const helpers = source.lastIndexOf('\n    function ', start - 2)
const component = source.slice(helpers + 1, end) + '\nreturn {loadDir, refreshStatus, reconnect, doFs, data, root, status, err}\n}\nRemoteExplorerTab'
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
const plain = (v) => JSON.parse(JSON.stringify(v))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// One React fiber: state setters schedule a render, callbacks obey dependencies,
// passive effects run after commit and clean up on dependency changes/unmount.
function hookRunner() {
  const slots = []
  let cursor = 0, dirty = true, mounted = true, renderFn, props, output
  const effects = []
  const React = {
    useState(initial) {
      const i = cursor++
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[i].value, (next) => {
        if (!mounted) return
        const value = typeof next === 'function' ? next(slots[i].value) : next
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true }
      }]
    },
    useRef(initial) { const i = cursor++; if (!slots[i]) slots[i] = { current: initial }; return slots[i] },
    useCallback(fn, deps) {
      const i = cursor++
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) slots[i] = { deps, fn }
      return slots[i].fn
    },
    useEffect(fn, deps) {
      const i = cursor++
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) {
        const previous = slots[i]
        slots[i] = { deps, cleanup: previous && previous.cleanup }
        effects.push(() => {
          if (slots[i].cleanup) slots[i].cleanup()
          slots[i].cleanup = fn()
        })
      }
    },
  }
  function flush() {
    let passes = 0
    while (mounted && (dirty || effects.length)) {
      assert.ok(++passes < 100, 'hook renders must converge')
      if (dirty) { dirty = false; cursor = 0; output = renderFn(props) }
      effects.splice(0).forEach((run) => run())
    }
    return output
  }
  return { React, mount(fn, p) { renderFn = fn; props = p; return flush() }, update(p) { props = p; dirty = true; return flush() }, flush,
    get value() { return output }, unmount() { mounted = false; slots.forEach((slot) => { if (typeof slot.cleanup === 'function') slot.cleanup() }); effects.length = 0 } }
}

function workspaceStore(items = []) {
  let snapshot = { phase: 'ready', state: 'idle', items }
  const listeners = new Set()
  return { list: { getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } },
    emit(next) { snapshot = next; [...listeners].forEach((fn) => fn()) }, ready(next) { this.emit({ phase: 'ready', state: 'idle', items: next }) },
    get subscriptions() { return listeners.size } }
}
const workspace = (id = 'wa', path = '/local/a', sessionIds = ['a']) => ({ workspaceId: id, path, sessionIds })
function context(initial) {
  let service = initial
  const fibers = new Set()
  function activate(fiber) {
    if (!service || fiber.disposed) return
    const cleanups = []
    fiber.callback({ get: () => service, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) } })
    fiber.cleanups.push(...cleanups)
  }
  return { get: (name) => name === 'workspaces' ? service : undefined,
    inject(names, callback) {
      assert.deepEqual(Array.from(names), ['workspaces'])
      const fiber = { callback, cleanups: [], disposed: false, dispose() { this.disposed = true; this.cleanups.splice(0).forEach((fn) => fn()); fibers.delete(this) } }
      fibers.add(fiber); activate(fiber); return fiber
    },
    install(next) { fibers.forEach((fiber) => fiber.cleanups.splice(0).forEach((fn) => fn())); service = next; fibers.forEach(activate) },
    get injections() { return fibers.size } }
}
function harness({ items = [workspace()], registered = true, scope = { sessionId: 'a', cwd: '/local/a' }, expanded = [] } = {}) {
  const runner = hookRunner(), store = workspaceStore(items), ctx = context(registered ? store : undefined), requests = []
  const request = (kind, args) => { const d = deferred(); const call = { kind, args, ...d }; requests.push(call); return d.promise }
  const env = { React: runner.React, console: { error() {} }, ensureChromeCss() {}, ensureDshCss() {}, DRX_CSS: '',
    tr: (key, args) => key + (args ? ':' + args.msg : ''),
    api: (...args) => request(args[1].includes('resolve-mirror') ? 'resolve' : 'fs', args),
    apiRaw: (...args) => request('reconnect', args), resolveSessionRemote: (...args) => request('resolve', args),
    fetchRemoteStatus: (...args) => request('status', args), listRemoteDir: (...args) => request('ls', args),
    sortRemoteEntries: (items) => items.slice(), withSessionBody: (body, sessionId) => ({ ...body, sessionId }),
  }
  const fn = vm.runInNewContext(component, env)
  let props = { ctx, scope, expanded, onToggleDir() {}, visible: false }
  runner.mount(fn, props)
  return { runner, store, ctx, requests,
    get value() { return runner.value },
    update(patch) { props = { ...props, ...patch }; runner.update(props) },
    calls(kind) { return requests.filter((r) => r.kind === kind) },
    next(kind) { const call = requests.find((r) => r.kind === kind && !r.settled); assert.ok(call, 'pending ' + kind + ' request'); call.settled = true; return call },
    async tick() { for (let i = 0; i < 25; i++) { await Promise.resolve(); runner.flush() } },
    async boot(remote = '/remote/shared') {
      this.next('resolve').resolve({ remotePath: remote }); await this.tick()
      this.next('status').resolve({ connected: true, host: 'host-a' }); await this.tick()
      this.next('ls').resolve({ items: [{ name: 'initial', type: 'file' }] }); await this.tick()
    },
    remove() { store.ready([]); runner.flush() },
  }
}
function empty(h) { assert.equal(h.value.root, ''); assert.deepEqual(plain(h.value.data), {}); assert.equal(h.value.status, null); assert.equal(h.value.err, '') }

test('hook runner rerenders state, memoizes callbacks and cleans effects', () => {
  const h = hookRunner(), events = []
  let set
  function C({ dep }) { const [n, update] = h.React.useState(0); set = update; const ref = h.React.useRef({}); const cb = h.React.useCallback(() => dep, [dep]); h.React.useEffect(() => { events.push(dep); return () => events.push('cleanup:' + dep) }, [dep]); return { n, cb, ref } }
  const first = h.mount(C, { dep: 'a' }); set((n) => n + 1); const second = h.flush()
  assert.equal(second.n, 1); assert.equal(first.cb, second.cb); assert.equal(first.ref, second.ref)
  h.update({ dep: 'b' }); h.unmount(); assert.deepEqual(events, ['a', 'cleanup:a', 'b', 'cleanup:b'])
})

for (const stage of ['resolve', 'status', 'root']) for (const reject of [false, true]) test('removal fences pending ' + stage + ' ' + (reject ? 'failure' : 'success'), async () => {
  const h = harness()
  if (stage !== 'resolve') { h.next('resolve').resolve({ remotePath: '/remote/shared' }); await h.tick() }
  if (stage === 'root') { h.next('status').resolve({ connected: true }); await h.tick() }
  const pending = h.next(stage === 'root' ? 'ls' : stage), count = h.requests.length
  h.remove(); empty(h)
  if (reject) pending.reject(new Error('late ' + stage))
  else pending.resolve(stage === 'resolve' ? { remotePath: '/remote/shared' } : stage === 'status' ? { connected: true } : { items: [{ name: 'late' }] })
  await h.tick(); empty(h); assert.equal(h.requests.length, count, 'late completion must not start another request')
})

for (const reject of [false, true]) test('removed child late ' + (reject ? 'failure' : 'success') + ' cannot restore tree', async () => {
  const h = harness(); await h.boot(); h.value.loadDir('/remote/shared/child'); const pending = h.next('ls')
  h.remove(); reject ? pending.reject(new Error('late child failure')) : pending.resolve({ items: [{ name: 'late-child' }] })
  await h.tick(); empty(h)
})

for (const cwd of ['/local/b', '/local/a']) test('same remote root, different session and cwd ' + cwd + ' fences old request and resets cache', async () => {
  const h = harness({ items: [workspace(), workspace('wb', '/local/b', ['b'])] }); await h.boot()
  h.value.loadDir('/remote/shared/child'); const old = h.next('ls')
  h.update({ scope: { sessionId: 'b', cwd } }); await h.boot()
  old.resolve({ items: [{ name: 'from-a' }] }); await h.tick()
  assert.equal(h.value.root, '/remote/shared'); assert.equal(h.value.data['/remote/shared/child'], undefined)
  assert.equal(h.calls('ls').at(-1).args[1], 'b')
})

test('visible, expanded and refresh cannot revive a removed activation', async () => {
  const h = harness(); await h.boot(); h.remove(); const count = h.requests.length
  h.update({ visible: true, expanded: ['/remote/shared/child'] }); h.value.refreshStatus(); h.value.loadDir('/remote/shared/new'); h.value.reconnect(); await h.tick()
  empty(h); assert.equal(h.requests.length, count)
})

test('initial absence is not removal; hot service registration then disappearance is', async () => {
  const h = harness({ registered: false, items: [] }); await h.boot()
  h.ctx.install(h.store); h.store.ready([]); h.runner.flush(); assert.equal(h.value.root, '/remote/shared')
  h.store.ready([workspace()]); h.remove(); empty(h)
})

test('initial registered empty list allows reopening and A to B to A creates fresh activation', async () => {
  const h = harness({ items: [] }); await h.boot(); assert.equal(h.value.root, '/remote/shared')
  h.store.ready([workspace()]); h.remove(); empty(h)
  h.update({ scope: { sessionId: 'b', cwd: '/local/b' } }); await h.boot('/remote/b')
  h.update({ scope: { sessionId: 'a', cwd: '/local/a' } }); await h.boot('/remote/shared')
  assert.equal(h.value.root, '/remote/shared')
})

test('loading, pending, error and missing snapshots do not imply removal', async () => {
  const h = harness(); await h.boot()
  for (const snapshot of [undefined, { phase: 'pending', items: [] }, { phase: 'ready', state: 'loading', items: [] }, { phase: 'ready', state: 'error', items: [] }, { phase: 'error', items: [] }, { phase: 'ready' }]) {
    h.store.emit(snapshot); h.runner.flush(); assert.equal(h.value.root, '/remote/shared')
  }
  h.remove(); empty(h)
})

test('sessionIds match and workspaceId identity detect replacement at the same path', async () => {
  const h = harness({ items: [workspace('wa', '/other/path', ['a'])] }); await h.boot()
  h.store.ready([workspace('replacement', '/local/a', ['a'])]); h.runner.flush(); empty(h)
})

test('path match works without session membership', async () => {
  const h = harness({ items: [workspace('wa', '/local/a', ['other'])] }); await h.boot(); h.remove(); empty(h)
})

test('unmount clears store and injection subscriptions and fences pending completion', async () => {
  const h = harness(); assert.equal(h.store.subscriptions, 1)
  const pending = h.next('resolve'); h.runner.unmount()
  assert.equal(h.store.subscriptions, 0); assert.equal(h.ctx.injections, 0)
  pending.resolve({ remotePath: '/remote/shared' }); await h.tick(); assert.equal(h.calls('status').length, 0)
  h.store.ready([]); assert.equal(h.store.subscriptions, 0)
})

for (const kind of ['reconnect', 'fs']) for (const reject of [false, true]) test(kind + ' late ' + (reject ? 'failure' : 'success') + ' is fenced after removal', async () => {
  const h = harness(); await h.boot()
  if (kind === 'reconnect') h.value.reconnect()
  else h.value.doFs('remove', { path: '/remote/shared/file' }, true)
  const pending = h.next(kind), count = h.requests.length
  h.remove(); reject ? pending.reject(new Error('late ' + kind)) : pending.resolve(kind === 'reconnect' ? { status: 200, data: {} } : {})
  await h.tick(); empty(h); assert.equal(h.requests.length, count)
})

for (const kind of ['reconnect', 'fs']) for (const reject of [false, true]) test(kind + ' late ' + (reject ? 'failure' : 'success') + ' cannot mutate another activation', async () => {
  const h = harness({ items: [workspace(), workspace('wb', '/local/b', ['b'])] }); await h.boot()
  if (kind === 'reconnect') h.value.reconnect()
  else h.value.doFs('remove', { path: '/remote/shared/file' }, true)
  const pending = h.next(kind)
  h.update({ scope: { sessionId: 'b', cwd: '/local/b' } }); await h.boot('/remote/b')
  const before = plain({ root: h.value.root, data: h.value.data, status: h.value.status, err: h.value.err }), count = h.requests.length
  reject ? pending.reject(new Error('late ' + kind)) : pending.resolve(kind === 'reconnect' ? { status: 200, data: {} } : {})
  await h.tick()
  assert.deepEqual(plain({ root: h.value.root, data: h.value.data, status: h.value.status, err: h.value.err }), before)
  assert.equal(h.requests.length, count)
})

test('concurrent refreshStatus shares its promise and waits for root and expanded listings', async () => {
  const child = '/remote/shared/child', h = harness({ expanded: [child] })
  const first = h.value.refreshStatus(), second = h.value.refreshStatus()
  assert.ok(first && typeof first.then === 'function', 'refresh exposes a completion promise')
  assert.equal(first, second)
  assert.equal(h.calls('resolve').length, 1)
  let settled = false
  first.then(() => { settled = true })
  h.next('resolve').resolve({ remotePath: '/remote/shared' }); await h.tick()
  assert.equal(settled, false); assert.equal(h.calls('status').length, 1)
  h.next('status').resolve({ connected: true }); await h.tick()
  assert.equal(settled, false)
  const root = h.calls('ls').find((call) => call.args[0] === '/remote/shared' && !call.settled)
  assert.ok(root); root.settled = true; root.resolve({ items: [] }); await h.tick()
  assert.equal(settled, false, 'expanded child must keep refresh pending after root finishes')
  const listing = h.calls('ls').find((call) => call.args[0] === child && !call.settled)
  assert.ok(listing); listing.settled = true; listing.resolve({ items: [{ name: 'child-file' }] }); await h.tick()
  await first
  assert.equal(settled, true)
  assert.equal(h.value.data[child].entries[0].name, 'child-file')
})

test('loadDir is idempotent for inflight and already loaded levels', async () => {
  const h = harness(); await h.boot()
  const child = '/remote/shared/child', count = h.calls('ls').length
  h.value.loadDir(child); h.value.loadDir(child); h.runner.flush(); h.value.loadDir(child)
  assert.equal(h.calls('ls').length, count + 1)
  h.next('ls').resolve({ items: [{ name: 'once' }] }); await h.tick()
  h.value.loadDir(child); h.update({ expanded: [child] }); await h.tick()
  assert.equal(h.calls('ls').length, count + 1)
  assert.equal(h.value.data[child].entries[0].name, 'once')
})

test('successful fs refreshParent performs a real fresh root listing', async () => {
  const h = harness(); await h.boot()
  const count = h.calls('ls').length
  h.value.doFs('remove', { path: '/remote/shared/file' }, true)
  h.next('fs').resolve({}); await h.tick()
  assert.equal(h.calls('ls').length, count + 1, 'a loading cache entry must not suppress the actual root fetch')
  assert.equal(h.calls('ls').at(-1).args[0], '/remote/shared')
  h.next('ls').resolve({ items: [{ name: 'fresh-root' }] }); await h.tick()
  assert.equal(h.value.data['/remote/shared'].entries[0].name, 'fresh-root')
})

test('cwd-only scope change with the same session replaces activation and fences old listing', async () => {
  const h = harness(); await h.boot()
  h.value.loadDir('/remote/shared/old-child'); const old = h.next('ls')
  h.update({ scope: { sessionId: 'a', cwd: '/local/new' } }); await h.boot('/remote/new')
  old.resolve({ items: [{ name: 'old-cwd-file' }] }); await h.tick()
  assert.equal(h.value.root, '/remote/new')
  assert.equal(h.value.data['/remote/shared/old-child'], undefined)
  assert.ok(h.calls('resolve').at(-1).args[1].includes(encodeURIComponent('/local/new')))
  assert.equal(h.calls('ls').at(-1).args[1], 'a')
})

test('unmount after removal does not poison a fresh mount for the old session', async () => {
  const old = harness(); await old.boot(); old.remove(); old.runner.unmount()
  assert.equal(old.store.subscriptions, 0); assert.equal(old.ctx.injections, 0)
  const fresh = harness({ items: [] }); await fresh.boot()
  assert.equal(fresh.value.root, '/remote/shared')
  assert.equal(fresh.value.data['/remote/shared'].entries[0].name, 'initial')
  fresh.runner.unmount(); assert.equal(fresh.store.subscriptions, 0)
})
