// The better-sidebar 'gitSource' slot wiring, exercised against the REAL
// client bundle in a VM (same technique as client-lifecycle.test.js): the
// registered GitDataSource must shadow the host git.* surface — gitLog
// (fixed-roots + cursor pagination) and gitShow map to the /dsh-remote/git
// op wire with the host payload shapes (undefined fields NOT sent,
// sessionId riding for cursor binding), and host responses pass through
// verbatim. The git provider registers only once the mirror root is known
// (feature 'gitSource' + registerGitProvider present; tree/terminal blocks
// are method-gated and skipped by this double).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SETTINGS = 'settings.section'

// A dependency callback runs only when ALL its requested names exist
// (mirror of the client-lifecycle harness).
function dependencies(initial = []) {
  const values = new Map(initial)
  const watchers = new Set()
  function reconcile(watcher) {
    const ready = watcher.names.every((name) => values.has(name))
    if (watcher.active && !ready) {
      watcher.active = false
      watcher.cleanup?.()
    } else if (!watcher.active && ready) {
      watcher.active = true
      watcher.cleanup = watcher.callback()
    }
  }
  return {
    values,
    set(name, value) {
      values.set(name, value)
      for (const watcher of watchers) reconcile(watcher)
    },
    remove(name) {
      values.delete(name)
      for (const watcher of watchers) reconcile(watcher)
    },
    inject(names, callback) {
      const watcher = { names: Array.isArray(names) ? [...names] : [names], callback, active: false }
      watchers.add(watcher)
      reconcile(watcher)
      return () => {
        watchers.delete(watcher)
        if (watcher.active) {
          watcher.active = false
          watcher.cleanup?.()
        }
      }
    },
  }
}

function loadClient(gitResponses) {
  let plugin
  const requests = []
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-remote')
          plugin = factory((name) => {
            assert.equal(name, 'react', 'bundle requires only its declared React external')
            return React
          })
        },
      },
    },
    navigator: { languages: ['en'] },
    console,
    // The git provider registration polls /dsh-remote/status for a mirror
    // root; the stub answers immediately, so the backoff timer never fires.
    setTimeout: () => 0,
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (url === '/dsh-remote/status' || url.startsWith('/dsh-remote/status?')) {
        return { ok: true, json: async () => ({ mirrorRoot: '/abs/mirror', mirrorDirs: ['/abs/mirror/s1'] }) }
      }
      if (url.startsWith('/dsh-remote/resolve-mirror')) {
        return { ok: true, json: async () => ({ remotePath: '/srv/repo' }) }
      }
      if (url === '/dsh-remote/git') {
        // The exact object comes back through apiGit — pass-through asserts
        // compare identity.
        return { ok: true, json: async () => (gitResponses.length ? gitResponses.shift() : {}) }
      }
      return { ok: true, json: async () => ({}) }
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'classic module loader receives the plugin')
  return { plugin, requests }
}

function createHost() {
  const slotsAvailable = dependencies([[SETTINGS, true]])
  const services = dependencies()
  const registrations = new Map()
  const dictionaries = new Map()
  const injections = []
  function scope() {
    const cleanups = []
    return {
      get(name) { return services.values.get(name) },
      effect(callback) {
        const cleanup = callback()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      inject(names, callback) {
        injections.push([...names])
        const dispose = services.inject(names, () => {
          const inner = scope()
          inner.effect(() => callback(inner))
          return () => inner.dispose()
        })
        cleanups.push(dispose)
        return dispose
      },
      own(cleanup) { cleanups.push(cleanup); return cleanup },
      dispose() {
        for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      },
    }
  }
  const ctx = scope()
  services.set('slots', {
    inject(names, callback) { return ctx.own(slotsAvailable.inject(names, callback)) },
    register(meta, render) {
      assert.ok(slotsAvailable.values.has(meta.name), 'registration must wait for its seat')
      assert.ok(!registrations.has(meta.name), 'no duplicate remote contribution')
      const entry = { meta, render }
      registrations.set(meta.name, entry)
      return () => {
        if (registrations.get(meta.name) === entry) registrations.delete(meta.name)
      }
    },
  })
  services.set('locale', {
    register(namespace, dictionary) {
      dictionaries.set(namespace, dictionary)
      return () => dictionaries.delete(namespace)
    },
    bind(namespace) { return (key) => dictionaries.get(namespace)?.en[key] || key },
  })
  return { ctx, services, slotsAvailable, registrations, dictionaries, injections }
}

/** A gitSource-capable sidebar double (feature 'gitSource' + the provider
 *  registration face; tree/terminal faces absent → their blocks skip). */
function betterSidebar() {
  const providers = []
  const tabs = new Map()
  const subscribers = new Set()
  let sessionId = ''
  return {
    features: ['gitSource'],
    providers,
    registerGitProvider(descriptor) {
      providers.push(descriptor)
      return () => {
        const i = providers.indexOf(descriptor)
        if (i >= 0) providers.splice(i, 1)
      }
    },
    getGitProviders() { return providers },
    registerTab(tab) {
      assert.ok(!tabs.has(tab.id), 'sidebar tab registers once per lifetime')
      tabs.set(tab.id, tab)
      return () => tabs.delete(tab.id)
    },
    getSnapshot() { return { sessionId } },
    subscribeState(callback) { subscribers.add(callback); return () => subscribers.delete(callback) },
    emit(id) { sessionId = id; for (const callback of subscribers) callback() },
    openTab() { assert.fail('empty mirror response must not open a remote tab') },
  }
}

/** Wait for the git registration to land (fetchMirrorRoot → then chain). */
const settle = () => new Promise((resolve) => setImmediate(resolve))

async function withGitProvider(t, gitResponses) {
  const { plugin, requests } = loadClient(gitResponses)
  const host = createHost()
  t.after(() => host.ctx.dispose())
  await plugin.apply(host.ctx)
  const sidebar = betterSidebar()
  host.services.set('betterSidebar', sidebar)
  await settle()
  await settle()
  assert.equal(sidebar.providers.length, 1, 'one git provider registered once the mirror root is known')
  assert.equal(sidebar.providers[0].id, 'dsh-remote:git')
  return { host, sidebar, requests, scope: { sessionId: 's1', cwd: '/abs/mirror/s1' } }
}

const HASH40 = '0123456789abcdef0123456789abcdef01234567'

test('git-source provider matches mirror sessions only', async (t) => {
  const { sidebar } = await withGitProvider(t, [])
  const provider = sidebar.providers[0]
  assert.equal(typeof provider.match, 'function')
  assert.equal(typeof provider.createSource, 'function')
  assert.equal(provider.match('s1', '/abs/mirror/s1'), true, 'session cwd inside a mirror matches')
  assert.equal(provider.match('s1', '/abs/mirror/s1/project'), true, 'mirror subdirectories match')
  assert.equal(provider.match('s1', '/abs/mirror/other'), false, 'a sibling mirror does not match')
  assert.equal(provider.match('s1', '/local/project'), false, 'local sessions do not match')
  assert.equal(provider.match('s1', undefined), false)
})

test('created git source exposes gitLog + gitShow and keeps the legacy gitLogGraph', async (t) => {
  const { sidebar } = await withGitProvider(t, [])
  const source = sidebar.providers[0].createSource('s1', '/abs/mirror/s1')
  assert.ok(source, 'source factory must not refuse a matching session')
  assert.equal(typeof source.gitLog, 'function', 'host git.log contract (fixed-roots + cursor paging)')
  assert.equal(typeof source.gitShow, 'function', 'host git.show contract (rev:path content read)')
  assert.equal(typeof source.gitLogGraph, 'function', 'legacy graph surface stays for older sidebar builds')
  assert.equal(sidebar.providers[0].createSource('s1', '/abs/mirror/s1'), source, 'memoized per (sessionId, cwd)')
})

test('gitLog anchored page → `log` op wire (roots + session binding), response passes through verbatim', async (t) => {
  const page = { entries: [{ hash: 'abc1234', hashFull: HASH40, subject: 'x', author: 'a', date: 'd', refs: '', parents: [] }], hasMore: false }
  const { requests, scope, sidebar } = await withGitProvider(t, [page])
  const source = sidebar.providers[0].createSource('s1', '/abs/mirror/s1')
  const result = await source.gitLog(scope, 30, 0, undefined, { roots: [] })
  assert.equal(result, page, 'the host page object passes through unchanged')
  const call = requests.at(-1)
  assert.equal(call.url, '/dsh-remote/git')
  assert.equal(call.options.method, 'POST')
  assert.deepEqual(JSON.parse(call.options.body), {
    op: 'log',
    dir: '/srv/repo', // session cwd → resolved remote base (mirror mapping)
    count: 30,
    skip: 0,
    roots: [],
    sessionId: 's1',
  })
})

test('gitLog cursor page rides op log WITHOUT roots (cursor alone continues the snapshot)', async (t) => {
  const { requests, scope, sidebar } = await withGitProvider(t, [{}])
  const source = sidebar.providers[0].createSource('s1', '/abs/mirror/s1')
  await source.gitLog(scope, 30, 0, undefined, { cursor: 'opaque-token' })
  const body = JSON.parse(requests.at(-1).options.body)
  assert.equal(body.op, 'log')
  assert.equal(body.cursor, 'opaque-token')
  assert.equal('roots' in body, false, 'a cursor page must not re-send roots')
  assert.equal(body.sessionId, 's1')
})

test('gitLog without options is the legacy wire: no count/skip/roots/cursor fields sent', async (t) => {
  const { requests, scope, sidebar } = await withGitProvider(t, [])
  const source = sidebar.providers[0].createSource('s1', '/abs/mirror/s1')
  const result = await source.gitLog(scope, undefined, undefined, undefined, undefined)
  assert.deepEqual(result, {}, 'plain-array legacy response passes through')
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    op: 'log',
    dir: '/srv/repo',
    sessionId: 's1',
  }, 'undefined count/skip/roots/cursor are NOT sent (host wire shape)')
})

test('gitLog pinning explicit roots with a worktree dir override', async (t) => {
  const { requests, scope, sidebar } = await withGitProvider(t, [{}])
  const source = sidebar.providers[0].createSource('s1', '/abs/mirror/s1')
  const roots = [HASH40, 'fedcba9876543210fedcba9876543210fedcba98']
  await source.gitLog(scope, 5, 2, '/srv/linked', { roots })
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    op: 'log',
    dir: '/srv/linked', // the linked-checkout path wins over the session base
    count: 5,
    skip: 2,
    roots,
    sessionId: 's1',
  })
})

test('gitShow → `show` op wire with rev and path; null content passes through', async (t) => {
  const { requests, scope, sidebar } = await withGitProvider(t, [{ content: null }])
  const source = sidebar.providers[0].createSource('s1', '/abs/mirror/s1')
  const result = await source.gitShow(scope, ':0', 'src/panel/ts/App.tsx', undefined)
  assert.equal(result.content, null, 'a missing path side passes through as null')
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    op: 'show',
    dir: '/srv/repo',
    rev: ':0',
    path: 'src/panel/ts/App.tsx',
  })
})

test('plugin disposal unregisters the git provider and stops re-registration', async (t) => {
  const { host, sidebar } = await withGitProvider(t, [])
  assert.equal(sidebar.providers.length, 1)
  host.ctx.dispose()
  assert.equal(sidebar.providers.length, 0, 'the provider disposer runs with the plugin teardown')
})