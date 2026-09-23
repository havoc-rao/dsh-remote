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

function loadClient() {
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
      // /dsh-remote/status: non-empty mirror root → provider registers.
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
  const terminalProvider = { registered: null }
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