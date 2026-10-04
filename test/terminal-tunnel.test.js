// Terminal tunnel 契约测试（lib/client.js 的 dsh-remote.terminalTunnel 服务）。
// dsh-remote 负责终端 UI 交互链路；外部插件（dsh-remote-workbench）经该服务
// 注册其 remote-term 对接实现。本测试在 VM 中加载 client 并走真实 apply()：
// 验证服务暴露、注册/注销、match 委托、transport 委托与回落路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SERVICE = 'dsh-remote.terminalTunnel'

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

function loadClient(statusFetch) {
  let plugin
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-remote')
          plugin = factory((name) => {
            assert.equal(name, 'react', 'bundle requires only its declared React external')
            return { createElement: (type, props, ...children) => ({ type, props, children }) }
          })
        },
      },
    },
    navigator: { languages: ['en'] },
    console,
    // Same approach as client-lifecycle.test.js: timers never fire; the
    // mirror-root probe must resolve on the FIRST fetch so the terminal
    // provider registers without the backoff retry path.
    setTimeout: () => 0,
    fetch: async (url) => {
      const path = String(url).split('?')[0]
      if (path === '/dsh-remote/slot-config') {
        return { ok: true, json: async () => ({ sidebarDirectoryFlowSlot: '' }) }
      }
      if (statusFetch) return statusFetch(url)
      return { ok: true, json: async () => ({ mirrorRoot: '/mirror', mirrorDirs: ['/mirror'] }) }
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'classic module loader receives the plugin')
  return plugin
}

function createHost() {
  const seats = [
    'settings.section',
    'conversation.hero.workspace.directoryFlow',
    'sidebar.workspaces.directoryFlow',
  ]
  const slotsAvailable = dependencies(seats.map((name) => [name, true]))
  const services = dependencies()
  const registrations = new Map()
  const terminalProvider = { registered: null, revisions: 0 }
  const cleanups = []
  const provided = []
  function scope() {
    const local = []
    return {
      get(name) { return services.values.get(name) },
      provide(name, value) {
        provided.push(name)
        services.set(name, value)
      },
      effect(callback) {
        const cleanup = callback()
        if (typeof cleanup === 'function') local.push(cleanup)
        return cleanup
      },
      inject(names, callback) {
        const dispose = services.inject(names, () => {
          const inner = scope()
          inner.effect(() => callback(inner))
          return () => inner.dispose()
        })
        local.push(dispose)
        return dispose
      },
      own(cleanup) { local.push(cleanup); return cleanup },
      dispose() {
        for (const cleanup of local.splice(0).reverse()) cleanup()
      },
    }
  }
  const ctx = scope()
  ctx.own(() => { for (const c of cleanups.splice(0).reverse()) c() })
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
    register(namespace, dictionary) { return () => {} },
    bind(namespace) { return (key) => key },
  })
  // 最小 better-sidebar：只开放 registerTab + registerTerminalProvider
  // （features 为空 → 文件树/git 集成全部按能力探测跳过）。
  const bs = {
    features: [],
    registerTab(tab) {
      assert.ok(!registrations.has('tab:' + tab.id), 'sidebar tab registers once')
      registrations.set('tab:' + tab.id, tab)
      return () => registrations.delete('tab:' + tab.id)
    },
    registerTerminalProvider(provider) {
      assert.equal(terminalProvider.registered, null, 'terminal provider registers once per lifetime')
      terminalProvider.registered = provider
      terminalProvider.revisions += 1
      return () => { if (terminalProvider.registered === provider) terminalProvider.registered = null }
    },
  }
  services.set('betterSidebar', bs)
  return { ctx, services, terminalProvider, provided }
}

async function settle() {
  // Flush the async fetch → mirror-root → provider-registration chain.
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
}

test('apply provides the terminalTunnel service (fail-safe)', async () => {
  const plugin = loadClient()
  const { ctx, provided } = createHost()
  await plugin.apply(ctx)
  await settle()
  assert.ok(provided.includes(SERVICE), 'service is provided on the client ctx')
  const svc = ctx.get(SERVICE)
  assert.ok(svc, 'service readable via ctx.get')
  assert.equal(svc.version, 1)
  assert.equal(typeof svc.registerTunnel, 'function')
  assert.equal(typeof svc.unregisterTunnel, 'function')
  assert.equal(typeof svc.tunnelIds, 'function')
  assert.equal(typeof svc.resolveTunnel, 'function')
})

test('registerTunnel validates id, rejects duplicates, disposer unregisters', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const svc = ctx.get(SERVICE)
  assert.ok(svc)
  assert.throws(() => svc.registerTunnel(null), /definition object required/)
  assert.throws(() => svc.registerTunnel({ match: () => true, createTransport: () => null }), /invalid id/)
  assert.throws(() => svc.registerTunnel({ id: 'Bad ID', match: () => true, createTransport: () => null }), /invalid id/)
  assert.throws(() => svc.registerTunnel({ id: 'wb', match: () => true }), /createTransport\(\) required/)
  assert.throws(() => svc.registerTunnel({ id: 'wb', createTransport: () => null }), /match\(\) required/)
  for (const bad of [null, true, {}, 'source']) {
    assert.throws(() => svc.registerTunnel({ id: 'wb', match: () => true, createTransport: () => null, createWorkspaceSource: bad }), /createWorkspaceSource\(\) must be a function/)
  }
  const disposer = svc.registerTunnel({ id: 'wb:t', match: () => true, createTransport: () => null })
  assert.throws(() => svc.registerTunnel({ id: 'wb:t', match: () => true, createTransport: () => null }), /already registered/)
  assert.ok(svc.tunnelIds().includes('wb:t'))
  assert.ok(terminalProvider.registered, 'provider is registered (mirror root present)')
  disposer()
  assert.ok(!svc.tunnelIds().includes('wb:t'))
  assert.equal(svc.resolveTunnel({ sessionId: 's', cwd: '/mirror' }), null)
})

test('tunnel match drives takeover; agent/gb tabs are never taken over', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const svc = ctx.get(SERVICE)
  const provider = terminalProvider.registered
  assert.ok(provider, 'terminal provider registered')
  assert.equal(provider.id, 'dsh-remote:term')

  // 无 tunnel：回落镜像规则（/mirror 下 remote，/local 下本地）。
  assert.equal(provider.match('s1', '/mirror/sub', 'term'), true)
  assert.equal(provider.match('s1', '/local/x', 'term'), false)
  assert.equal(provider.match('s1', undefined, 'agent:42'), false)
  assert.equal(provider.match('s1', '/mirror', 'gb:1'), false)

  // tunnel 注册且命中：远端判定交给 tunnel（即使 cwd 不在镜像内）。
  const matches = []
  const transports = []
  svc.registerTunnel({
    id: 'dsh-remote-workbench:tunnel',
    match: (sessionId, cwd, tabId) => {
      matches.push([sessionId, cwd, tabId])
      return cwd === '/wbfs'
    },
    createTransport: (sessionId, cwd, tabId) => {
      transports.push([sessionId, cwd, tabId])
      return { via: 'tunnel', open: async () => {}, close() {}, dispose() {}, input() {}, resize() {}, park() {}, retry() {} }
    },
  })
  assert.equal(provider.match('s2', '/wbfs', 'term'), true)
  assert.deepEqual(matches.at(-1), ['s2', '/wbfs', 'term'])
  // 未命中 tunnel → 回落镜像规则。
  assert.equal(provider.match('s2', '/local/x', 'term'), false)
  // agent/gb 在任何情况下都不接管。
  assert.equal(provider.match('s2', '/wbfs', 'agent:9'), false)
  assert.equal(provider.match('s2', '/wbfs', 'gb:2'), false)

  // createTransport 委托给 tunnel。
  const transport = provider.createTransport('s2', '/wbfs', 'term')
  assert.equal(transport.via, 'tunnel')
  assert.deepEqual(transports.at(-1), ['s2', '/wbfs', 'term'])
})

test('tunnel missing/absent createTransport falls back to own transport', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const svc = ctx.get(SERVICE)
  const provider = terminalProvider.registered

  // 无 tunnel 时：返回本插件自有 RemoteTerminalTransport（transport 词汇：
  // open() 返回 { input, resize, close, park, dispose, retry? }）。
  const own = provider.createTransport('s1', '/mirror', 'term')
  assert.equal(typeof own.open, 'function', 'own transport has open()')

  // tunnel 命中但 createTransport 返回 null → 回落自有 transport。
  svc.registerTunnel({
    id: 'wb:null',
    match: () => true,
    createTransport: () => null,
  })
  const fallback = provider.createTransport('s3', '/anywhere', 'term')
  assert.equal(typeof fallback.open, 'function')
})

test('throwing tunnel match is a non-match (no crash, fallback intact)', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const svc = ctx.get(SERVICE)
  const provider = terminalProvider.registered
  svc.registerTunnel({
    id: 'wb:boom',
    match: () => { throw new Error('boom') },
    createTransport: () => { throw new Error('never called') },
  })
  assert.doesNotThrow(() => provider.match('s9', '/mirror', 'term'))
  // 抛错的 match 按未命中处理 → 回落镜像规则。
  assert.equal(provider.match('s9', '/mirror', 'term'), true)
  assert.equal(provider.match('s9', '/local', 'term'), false)
  // createTransport 同样回落（match 抛错 → 不会调用 tunnel 的 createTransport）。
  const t = provider.createTransport('s9', '/mirror', 'term')
  assert.equal(typeof t.open, 'function')
})

test('unregisterTunnel removes a tunnel immediately', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const svc = ctx.get(SERVICE)
  const provider = terminalProvider.registered
  svc.registerTunnel({ id: 'wb:u', match: () => true, createTransport: () => ({ via: 'tunnel', open: async () => {} }) })
  assert.equal(provider.createTransport('s', '/wbfs', 'term').via, 'tunnel')
  svc.unregisterTunnel('wb:u')
  assert.ok(!svc.tunnelIds().includes('wb:u'))
  // 回落：unregister 后 cwd 不在镜像 → 本地。
  assert.equal(provider.match('s', '/wbfs', 'term'), false)
  const t = provider.createTransport('s', '/wbfs', 'term')
  assert.notEqual(t.via, 'tunnel')
})

test('workspace source is forwarded synchronously with original scope and opaque terminal ids', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const calls = []
  const managed = {
    create: async (title) => ({ terminalId: 'wb/opaque-id', title, cwd: '/wbfs', createdBySessionId: 's', createdAt: 1, exited: false }),
    list: async () => ({ terminals: [] }),
    terminate: async () => {},
    createTransport: () => ({ open() {} }),
  }
  ctx.get(SERVICE).registerTunnel({
    id: 'wb:managed', match: () => true, createTransport: () => null,
    createWorkspaceSource: (sid, cwd) => { calls.push([sid, cwd]); return managed },
  })
  const provider = terminalProvider.registered
  assert.equal(typeof provider.createWorkspaceSource('s', '/wbfs').createTransport, 'function')
  assert.equal(typeof provider.createWorkspaceSource('', '').list, 'function')
  assert.equal(typeof provider.createWorkspaceSource(undefined, undefined).list, 'function')
  assert.deepEqual(calls, [['s', '/wbfs'], ['', ''], [undefined, undefined]])
  assert.equal((await managed.create('Title')).terminalId, 'wb/opaque-id')
  ctx.dispose()
  assert.equal(terminalProvider.registered, null)
})

test('workspace source resolves the same management probe as sidebar provider matching', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const probes = []
  const managed = { list() {}, create() {}, terminate() {}, createTransport() {} }
  ctx.get(SERVICE).registerTunnel({
    id: 'wb:management-only',
    match: (sid, cwd, tabId) => {
      probes.push([sid, cwd, tabId])
      return tabId === 'terminal:workspace-management'
    },
    createTransport: () => null,
    createWorkspaceSource: () => managed,
  })
  const provider = terminalProvider.registered
  assert.equal(provider.match('s', '/outside-mirror', 'terminal:workspace-management'), true)
  assert.equal(typeof provider.createWorkspaceSource('s', '/outside-mirror').list, 'function')
  assert.deepEqual(probes, [
    ['s', '/outside-mirror', 'terminal:workspace-management'],
    ['s', '/outside-mirror', 'terminal:workspace-management'],
  ])
  ctx.dispose()
})

test('missing managed capability never substitutes legacy or local mirror management', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const provider = terminalProvider.registered
  assert.equal(provider.match('s', '/mirror'), true)
  const svc = ctx.get(SERVICE)
  const off = svc.registerTunnel({ id: 'wb:legacy', match: () => true, createTransport: () => { throw new Error('must not create legacy PTY') } })
  assert.equal(provider.createWorkspaceSource('s', '/wbfs'), undefined)
  off()
  const offMissing = svc.registerTunnel({ id: 'wb:empty', match: () => true, createTransport: () => null, createWorkspaceSource: () => undefined })
  assert.equal(provider.createWorkspaceSource('s', '/mirror'), undefined)
  offMissing()
  svc.registerTunnel({ id: 'wb:error', match: () => true, createTransport: () => null, createWorkspaceSource: () => { throw new Error('backend unavailable') } })
  assert.throws(() => provider.createWorkspaceSource('s', '/wbfs'), /backend unavailable/)
})

test('provider exists before mirror status settles; late tunnels and unloading tick registry', async () => {
  const plugin = loadClient(() => new Promise(() => {}))
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  const provider = terminalProvider.registered
  assert.ok(provider, 'does not wait for mirror discovery')
  const svc = ctx.get(SERVICE)
  const managed = { create() {}, list() {}, terminate() {}, createTransport() {} }
  const startRevision = terminalProvider.revisions
  const off = svc.registerTunnel({ id: 'wb:late', match: (sid) => sid === 'bound', createTransport: () => null, createWorkspaceSource: () => managed })
  assert.equal(provider.match('bound', '/not-a-mirror'), true)
  assert.equal(typeof provider.createWorkspaceSource('bound', '/not-a-mirror').list, 'function')
  assert.ok(terminalProvider.revisions > startRevision)
  off()
  // Do not select a native source here: this test exercises tunnel re-registration.
  assert.equal(provider.match('bound', '/not-a-mirror'), false)
  const afterOff = terminalProvider.revisions
  svc.registerTunnel({ id: 'wb:late', match: () => true, createTransport: () => null, createWorkspaceSource: () => managed })
  off() // stale disposer must not unregister the replacement
  assert.equal(typeof provider.createWorkspaceSource('bound', '/not-a-mirror').list, 'function')
  svc.unregisterTunnel('wb:late')
  assert.ok(terminalProvider.revisions > afterOff)
  // Do not select a native source here: this test exercises tunnel re-registration.
  ctx.dispose()
  const disposedRevision = terminalProvider.revisions
  svc.registerTunnel({ id: 'wb:disposed', match: () => true, createTransport: () => null })
  assert.equal(terminalProvider.registered, null)
  assert.equal(terminalProvider.revisions, disposedRevision, 'unloaded provider no longer listens')
})

test('transient status failure preserves validated mirror routing; confirmed empty status clears it', async () => {
  let status = 'known'
  const plugin = loadClient(async () => {
    if (status === 'failure') throw new Error('temporary status outage')
    return { ok: true, json: async () => status === 'known'
      ? ({ mirrorRoot: '/mirror', mirrorDirs: ['/mirror'] })
      : ({ mirrorRoot: '', mirrorDirs: [] }) }
  })
  const { ctx, services, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  const bs = services.values.get('betterSidebar')
  assert.equal(terminalProvider.registered.match('s', '/mirror'), true)
  status = 'failure'
  services.remove('betterSidebar')
  services.set('betterSidebar', bs)
  await settle()
  assert.equal(terminalProvider.registered.match('s', '/mirror'), true, 'known remote does not become local on fetch failure')
  assert.equal(typeof terminalProvider.registered.createWorkspaceSource('s', '/mirror').list, 'function')
  status = 'empty'
  services.remove('betterSidebar')
  services.set('betterSidebar', bs)
  await settle()
  assert.equal(terminalProvider.registered.match('s', '/mirror'), false, 'successful empty response clears obsolete mirror')
  ctx.dispose()
})

test('native source is synchronous without binding and stable across tunnel hotload', async () => {
  const plugin = loadClient()
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx); await settle()
  const provider = terminalProvider.registered
  const native = provider.createWorkspaceSource('native-session', '/mirror')
  assert.equal(typeof native.create, 'function')
  const off = ctx.get(SERVICE).registerTunnel({ id: 'wb:new', match: () => true, createTransport: () => null,
    createWorkspaceSource: () => { throw new Error('must not migrate native backend') } })
  assert.equal(provider.createWorkspaceSource('native-session', '/mirror'), native)
  off()
  assert.equal(provider.createWorkspaceSource('native-session', '/mirror'), native)
  ctx.dispose()
})

test('tunnel source routes saved native ids to native namespace without invoking workbench', async () => {
  const plugin = loadClient()
  const {ctx,terminalProvider}=createHost(); await plugin.apply(ctx); await settle()
  const seen=[]
  ctx.get(SERVICE).registerTunnel({id:'wb:routing',match:()=>true,createTransport:()=>null,createWorkspaceSource:()=>({
    create() {}, list() {}, terminate: id=>seen.push(id), createTransport:id=>({kind:'workbench',id}),
  })})
  const source=terminalProvider.registered.createWorkspaceSource('s','/mirror')
  assert.equal(source.createTransport('remote-managed:saved').kind,'dsh-remote-managed')
  assert.equal(source.createTransport('wb-opaque').kind,'workbench')
  source.terminate('wb-opaque'); assert.deepEqual(seen,['wb-opaque'])
  ctx.dispose()
})

test('empty mirror status still allows a tunnel remote workspace to match', async () => {
  const plugin = loadClient(async () => ({ ok: true, json: async () => ({ mirrorRoot: '', mirrorDirs: [] }) }))
  const { ctx, terminalProvider } = createHost()
  await plugin.apply(ctx)
  await settle()
  assert.ok(terminalProvider.registered)
  ctx.get(SERVICE).registerTunnel({ id: 'wb:empty-root', match: () => true, createTransport: () => ({ kind: 'workbench' }) })
  assert.equal(terminalProvider.registered.match('bound', '/remote'), true)
  ctx.dispose()
})