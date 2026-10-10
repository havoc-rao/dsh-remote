// The global Dev Tunnel settings card (host CLI path / managed authorization /
// preflight) stays owned by dsh-remote and keeps working unchanged. The machine
// form's Dev Tunnel transport button/fields now come from the occupant plugin
// through the two RemoteSettings slots, so this file asserts the card AND the
// owner props the page publishes into the transport option slot.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const OPT = 'settings.remote.machine.transport.option'
const FLD = 'settings.remote.machine.transport.fields'

function harness(options = {}) {
  let plugin, page, tree, cursor = 0
  let snapshot = { ok: true, available: true, settings: { cliExecutable: options.auto ? '' : '/opt/devtunnel', managedEnabled: false }, cli: { status: options.notFound ? 'not-found' : 'found', source: options.auto ? 'path' : 'override', resolvedExecutable: options.notFound ? '' : '/opt/devtunnel' }, revision: 7, source: 'config', activeManaged: options.active || 0 }
  const refs = [], effects = [], requests = [], confirmations = [], answers = [], sections = [], registrations = new Map(), slotKeys = []
  const instances = new Map()
  let hooks = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'Fragment',
    useState(initial) { const i = hooks.cursor++; if (!(i in hooks.states)) hooks.states[i] = typeof initial === 'function' ? initial() : initial; return [hooks.states[i], v => { hooks.states[i] = typeof v === 'function' ? v(hooks.states[i]) : v }] },
    useRef(initial) { const i = hooks.cursor++; if (!(i in refs)) refs[i] = { current: initial }; return refs[i] },
    useEffect: fn => effects.push(fn), useMemo: fn => fn(), useCallback: fn => fn,
  }
  // The page's own hook order (only the page component is rendered here).
  const pageHooks = { cursor: 0, states: [] }
  function renderPage() { hooks = pageHooks; pageHooks.cursor = 0; return page.type(page.props) }
  const services = {
    locale: { register() {}, bind: () => (k) => 'T:' + k },
    slots: {
      // Declaration-waiting: the owner declares both child slots synchronously.
      inject: (name, fn) => { fn(); return () => {} },
      register: (d, render) => {
        if (d.name === 'settings.section') {
          for (const child of Object.keys(d.children || {})) registrations.set(child, { meta: d.children[child] })
          sections.push({ d, render })
        } else {
          registrations.set(d.name, { d, render })
        }
        return () => {}
      },
      get: () => [],
    },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
  }
  vm.runInNewContext(source, {
    window: { location: { protocol: options.protocol || 'https:' }, confirm: msg => { confirmations.push(msg); return answers.length ? answers.shift() : true }, localStorage: { getItem: () => null }, __ModuleLoader__: { load: m => { plugin = m.factory(() => React) } } },
    document: { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } }, navigator: { languages: ['en'] },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console,
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined
      requests.push({ url, body, method: opts.method })
      let status = 200, data = { ok: true }
      if (url === '/dsh-devtunnel-ssh/settings') {
        if (options.network) throw new Error('secret network exception body')
        if (options.missing) { status = options.missing; data = { code: options.code, error: 'secret raw response body', message: 'secret message' } }
        else if (options.unavailable) data = { ok: true, available: false }
        else if (options.shape) data = { ...snapshot, cli: options.shape }
        else if (!body) data = snapshot
        else if (options.conflict) { status = 409; data = { ok: false, code: options.conflict } }
        else { snapshot = { ...snapshot, settings: { cliExecutable: body.cliExecutable, managedEnabled: body.managedEnabled }, cli: { status: options.notFound ? 'not-found' : 'found', source: body.cliExecutable ? 'override' : 'path', resolvedExecutable: options.notFound ? '' : (body.cliExecutable || '/opt/devtunnel') }, revision: snapshot.revision + 1, source: 'settings', activeManaged: 0 }; data = snapshot }
      }
      if (url.startsWith('/dsh-remote/status')) data = { sshCarrierCapabilities: { workspaceSupported: true, carrierIds: ['devtunnel'], devTunnelManaged: snapshot.settings.managedEnabled } }
      if (url.startsWith('/dsh-remote/machines')) data = { machines: [] }
      if (url === '/dsh-devtunnel-ssh/preflight') data = { ok: true, version: 'mock-version', loggedIn: body.checkLogin }
      return { ok: true, status, json: async () => data }
    },
  })
  const ctx = { get: n => services[n], effect: fn => fn(), inject: (names, cb) => { if (names.every(n => services[n])) cb(ctx) }, on() {}, logger: { warn() {} } }
  plugin.apply(ctx)
  // The occupant's browser half only needs the two declared slots for the page to
  // dispatch; its option entry captures the owner props this file asserts.
  let optionProps = null
  services.slots.inject(OPT, () => services.slots.register({ name: OPT, id: 'devtunnel-ssh', order: 10 }, (p) => { optionProps = p; return React.createElement('button', { type: 'button' }, 'Dev Tunnel SSH') }))
  services.slots.inject(FLD, () => services.slots.register({ name: FLD, key: 'devtunnel-ssh' }, (p) => { p.carrier.publish(null); return React.createElement('div', null) }))
  // The page dispatches option (list: both entries) and fields (keyed by entryKey);
  // only the empty fields dispatch needs a real element here.
  const renderSlot = (key, owner, opts) => {
    slotKeys.push(key)
    if (key === OPT) {
      // Exercise the page's real dispatch (owner props included); the entry body
      // needs no hooks, so rendering it inside the page pass is safe here.
      const e = registrations.get(OPT)
      if (e) resolveEntry(e.render, owner)
      return null
    }
    // No occupant registers the panel slot in this file: its mount point must stay
    // empty (the other keys are the only ones this harness stubs).
    if (key !== FLD) return null
    const e = registrations.get(FLD)
    return e ? React.createElement(e.render, { key: 0, ...owner }) : null
  }
  page = sections.find(s => s.d.id === 'dsh-remote').render({ renderSlot })
  const nodes = (n, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) n.forEach(v => nodes(v, out)); else { out.push(n); nodes(n.children, out) } return out }
  const text = n => typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join(' ') : n && typeof n === 'object' ? text(n.children) : ''
  function render() { hooks = pageHooks; pageHooks.cursor = 0; tree = page.type(page.props); return tree }
  const resolve = (n) => { if (Array.isArray(n)) return n.flatMap(resolve); if (!n || typeof n !== 'object') return n; if (typeof n.type === 'function') return resolve(n.type(n.props)); return { ...n, children: (n.children || []).flatMap(resolve) } }
  const resolveEntry = (render, owner) => {
    const prev = hooks, prevCursor = prev && prev.cursor
    hooks = { cursor: 0, states: [] } // an isolated, hook-free realm for the entry
    try { return resolve(render(owner)) } finally { hooks = prev; if (prev) prev.cursor = prevCursor }
  }
  tree = render()
  const initialEffects = effects.splice(0)
  return {
    requests, confirmations, answers, options, slotKeys, get optionProps() { return optionProps },
    render() { tree = resolve(render()); return tree },
    text: () => text(tree),
    async mount() { initialEffects.forEach(fn => fn()); await tick(); tree = resolve(render()); render(); return tree },
    button(key) { const n = nodes(tree).find(n => n.type === 'button' && text(n) === 'T:settings.' + key); assert.ok(n, key); return n },
    field(key) { const row = nodes(tree).find(n => n.props.key === 'tunnel-' + key); return nodes(row).find(n => n.type === 'input') },
    edit(key, value) { this.field(key).props.onChange({ target: key === 'enabled' ? { checked: value } : { value } }); render() },
    async click(key) { await this.button(key).props.onClick(); await tick(); render() },
  }
}
const settingsPosts = h => h.requests.filter(r => r.url === '/dsh-devtunnel-ssh/settings' && r.body)
const probes = h => h.requests.filter(r => r.url === '/dsh-devtunnel-ssh/preflight')

test('global settings mount only reads; save confirms, uses strict revision body, refreshes capabilities, preflight uses saved host settings', async () => {
  const h = harness(); await h.mount()
  assert.equal(h.field('cli').props.value, '/opt/devtunnel')
  // The panel mount point is always rendered; with no occupant entry it yields no
  // node (nothing to register, no placeholder text).
  assert.ok(h.slotKeys.includes('settings.remote.machine.transport.panel'), 'page renders the panel mount point')
  assert.doesNotMatch(h.text(), /panelStub|devtunnel-ssh panel/)
  assert.equal(settingsPosts(h).length, 0); assert.equal(probes(h).length, 0); assert.equal(h.confirmations.length, 0)
  assert.equal(h.optionProps.status.sshCarrierCapabilities.devTunnelManaged, false, 'owner feeds the current scope status into the transport option slot')
  h.edit('enabled', true)
  assert.equal(h.button('tunnelProbe').props.disabled, true)
  await h.click('tunnelProbe'); assert.equal(probes(h).length, 0)
  const statusBefore = h.requests.filter(r => r.url.startsWith('/dsh-remote/status')).length
  await h.click('tunnelSave')
  assert.deepEqual(settingsPosts(h)[0].body, { cliExecutable: '/opt/devtunnel', managedEnabled: true, confirmed: true, disconnectActive: false, revision: 7 })
  assert.equal(h.confirmations[0], 'T:settings.tunnelConfirm')
  assert.ok(h.requests.filter(r => r.url.startsWith('/dsh-remote/status')).length > statusBefore)
  assert.equal(h.button('tunnelSave').props.disabled, true)
  assert.equal(h.optionProps.status.sshCarrierCapabilities.devTunnelManaged, true, 'saved authorization refreshed the capability the transport slot sees, even without a workspace')
  h.button('tunnelProbe').props.onClick(); await tick(); h.render()
  assert.deepEqual(probes(h)[0].body, { confirmed: true, checkLogin: false })
  assert.match(h.text(), /mock-version/)
  await h.click('tunnelLoginProbe'); assert.deepEqual(probes(h)[1].body, { confirmed: true, checkLogin: true })
  h.edit('cli', '/other/devtunnel'); assert.doesNotMatch(h.text(), /mock-version/)
  await h.click('tunnelSave'); assert.equal(settingsPosts(h)[1].body.revision, 8)
})

test('save authorization and active disconnection each require confirmation; probe cancellation does not run CLI', async () => {
  const h = harness({ active: 2 }); await h.mount(); h.edit('cli', '/new/devtunnel')
  h.answers.push(false); await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 0)
  h.answers.push(true, false); await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 0)
  h.answers.push(true, true); await h.click('tunnelSave'); assert.equal(settingsPosts(h)[0].body.disconnectActive, true)
  assert.ok(h.confirmations.includes('T:settings.tunnelDisconnectConfirm'))
  h.answers.push(false); await h.click('tunnelProbe'); assert.equal(probes(h).length, 0)
})

test('409 conflicts leave edits and revision intact, do not auto retry or refresh; manual refresh resets dirty state', async () => {
  for (const [code, message] of [['SETTINGS_REVISION_CONFLICT', 'tunnelConflict'], ['SETTINGS_ACTIVE_CONFIRM_REQUIRED', 'tunnelActiveConflict']]) {
    const h = harness({ conflict: code }); await h.mount(); h.edit('cli', '/new/devtunnel')
    const reads = h.requests.filter(r => r.url === '/dsh-devtunnel-ssh/settings' && !r.body).length
    await h.click('tunnelSave')
    assert.equal(settingsPosts(h).length, 1); assert.equal(settingsPosts(h)[0].body.revision, 7)
    assert.match(h.text(), new RegExp(message)); assert.equal(h.field('cli').props.value, '/new/devtunnel')
    assert.equal(h.requests.filter(r => r.url === '/dsh-devtunnel-ssh/settings' && !r.body).length, reads)
    h.answers.push(false); await h.click('tunnelRefresh'); assert.equal(h.field('cli').props.value, '/new/devtunnel')
    await h.click('tunnelRefresh'); assert.equal(h.field('cli').props.value, '/opt/devtunnel'); assert.equal(h.button('tunnelProbe').props.disabled, false)
  }
})

test('missing/unavailable plugin degrades gracefully, disables write/probe and allows manual recovery', async () => {
  for (const [opts, message] of [[{ missing: 404 }, 'tunnelRouteMissing'], [{ missing: 500 }, 'tunnelUnavailable'], [{ unavailable: true }, 'tunnelShape']]) {
    const h = harness(opts); await h.mount()
    assert.match(h.text(), new RegExp(message))
    for (const key of ['tunnelSave', 'tunnelProbe', 'tunnelLoginProbe']) assert.equal(h.button(key).props.disabled, true)
    assert.equal(h.field('cli').props.disabled, true); assert.equal(h.button('tunnelRefresh').props.disabled, false)
    assert.equal(settingsPosts(h).length, 0); assert.equal(probes(h).length, 0)
    opts.missing = false; opts.unavailable = false; await h.click('tunnelRefresh')
    assert.equal(h.field('cli').props.disabled, false)
  }
})

test('only POSIX absolute CLI paths can save; Windows and relative paths cannot save or issue requests', async () => {
  const h = harness(); await h.mount()
  for (const path of ['devtunnel', './devtunnel', 'C:\\Tools\\devtunnel.exe', 'C:/Tools/devtunnel.exe', '\\\\server\\share\\devtunnel.exe']) {
    h.edit('cli', path); assert.equal(h.button('tunnelSave').props.disabled, true, path)
    await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 0)
  }
  h.edit('cli', '/opt/new-devtunnel'); assert.equal(h.button('tunnelSave').props.disabled, false)
  await h.click('tunnelSave'); assert.equal(settingsPosts(h)[0].body.cliExecutable, '/opt/new-devtunnel')
  assert.equal(probes(h).length, 0)
})

test('CLI path length allows 4096 characters, rejects 4097 including trim-hidden excess', async () => {
  const h = harness(); await h.mount()
  h.edit('cli', '/' + 'a'.repeat(4095)); assert.equal(h.button('tunnelSave').props.disabled, false)
  await h.click('tunnelSave'); assert.equal(settingsPosts(h)[0].body.cliExecutable.length, 4096)
  for (const path of ['/' + 'a'.repeat(4096), ' ' + '/' + 'a'.repeat(4095)]) {
    h.edit('cli', path); assert.equal(h.button('tunnelSave').props.disabled, true)
    await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 1)
  }
})

test('CLI path rejects every C0/C1 control character, even at trimmed edges or in disabled empty paths', async () => {
  const h = harness(); await h.mount()
  const codes = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 0x7f + i)]
  for (const code of codes) {
    const control = String.fromCharCode(code)
    for (const path of ['/opt/' + control + 'devtunnel', control + '/opt/devtunnel', '/opt/devtunnel' + control, control]) {
      h.edit('cli', path); assert.equal(h.button('tunnelSave').props.disabled, true, 'U+' + code.toString(16))
      await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 0)
    }
  }
  h.edit('cli', ''); assert.equal(h.button('tunnelSave').props.disabled, false, 'empty path still allowed when managed is disabled')
  h.edit('enabled', true); assert.equal(h.button('tunnelSave').props.disabled, false, 'managed allows automatic host PATH lookup')
})


test('empty override uses automatic PATH, permits managed save, and found CLI permits confirmed preflight', async () => {
  const h = harness({ auto: true }); await h.mount()
  assert.equal(h.field('cli').props.value, '')
  assert.equal(h.field('cli').props.placeholder, 'T:settings.tunnelCliPlaceholder')
  assert.match(h.text(), /tunnelResolved/); assert.match(h.text(), /\/opt\/devtunnel/)
  assert.equal(h.button('tunnelProbe').props.disabled, false)
  await h.click('tunnelProbe'); assert.equal(probes(h).length, 1)
  h.edit('enabled', true)
  assert.equal(h.button('tunnelSave').props.disabled, false)
  await h.click('tunnelProbe'); assert.equal(probes(h).length, 1, 'dirty settings block probe')
  await h.click('tunnelSave')
  assert.deepEqual(settingsPosts(h)[0].body, { cliExecutable: '', managedEnabled: true, confirmed: true, disconnectActive: false, revision: 7 })
  assert.equal(h.button('tunnelProbe').props.disabled, false)
  await h.click('tunnelLoginProbe'); assert.equal(probes(h).length, 2)
})

test('PATH or override not found is a healthy settings API; saving remains possible but preflight is blocked', async () => {
  for (const auto of [true, false]) {
    const h = harness({ auto, notFound: true }); await h.mount()
    assert.match(h.text(), /tunnelNotFound/); assert.doesNotMatch(h.text(), /tunnelUnavailable/)
    assert.equal(h.field('cli').props.disabled, false)
    for (const key of ['tunnelProbe', 'tunnelLoginProbe']) { assert.equal(h.button(key).props.disabled, true); await h.click(key) }
    assert.equal(probes(h).length, 0)
    h.edit('enabled', true); assert.equal(h.button('tunnelSave').props.disabled, false)
    await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 1)
    assert.equal(h.button('tunnelProbe').props.disabled, true)
  }
})

test('settings read errors distinguish route, auth, service, network and contract; disclose only HTTP and safe codes', async () => {
  const cases = [
    [{ missing: 404, code: 'ROUTE_NOT_FOUND' }, 'tunnelRouteMissing'],
    [{ missing: 401, code: 'UNAUTHORIZED' }, 'tunnelAuth'],
    [{ missing: 403, code: 'FORBIDDEN' }, 'tunnelAuth'],
    [{ missing: 503, code: 'SETTINGS_CLEANUP_UNAVAILABLE' }, 'tunnelServiceUnavailable'],
    [{ missing: 503, code: 'secret code with spaces' }, 'tunnelServiceUnavailable'],
    [{ network: true }, 'tunnelNetwork'],
    [{ shape: {} }, 'tunnelShape'],
    [{ shape: { status: 'found', source: 'path', resolvedExecutable: '' } }, 'tunnelShape'],
    [{ shape: { status: 'found', source: 'invalid', resolvedExecutable: '/opt/devtunnel' } }, 'tunnelShape'],
  ]
  for (const [opts, message] of cases) {
    const h = harness(opts); await h.mount()
    assert.match(h.text(), new RegExp(message)); assert.doesNotMatch(h.text(), /secret|raw response|plugin disabled/)
    if (!opts.network) assert.match(h.text(), new RegExp('HTTP ' + (opts.missing || 200)))
    if (opts.code && /^[A-Z][A-Z0-9_]*$/.test(opts.code)) assert.ok(h.text().includes('[' + opts.code + ']'))
    assert.equal(h.button('tunnelProbe').props.disabled, true)
    opts.missing = false; opts.network = false; opts.shape = false
    await h.click('tunnelRefresh'); assert.equal(h.field('cli').props.disabled, false)
  }
})


test('Desktop settings GET/save/preflight use direct plugin routes, with no alternate-prefix write retries', async () => {
  const h = harness({ protocol: 'dsh-app:', auto: true }); await h.mount()
  assert.equal(h.field('cli').props.disabled, false)
  h.edit('enabled', true); await h.click('tunnelSave'); await h.click('tunnelProbe')
  assert.equal(settingsPosts(h).length, 1); assert.equal(probes(h).length, 1)
  assert.ok(h.requests.every(r => !r.url.startsWith('/api/')))
  assert.deepEqual(h.requests.filter(r => r.url.startsWith('/dsh-devtunnel-ssh/')).map(r => [r.method, r.url]), [
    ['GET', '/dsh-devtunnel-ssh/settings'], ['POST', '/dsh-devtunnel-ssh/settings'], ['POST', '/dsh-devtunnel-ssh/preflight'],
  ])
  const failed = harness({ protocol: 'dsh-app:', conflict: 'SETTINGS_REVISION_CONFLICT' }); await failed.mount()
  failed.edit('enabled', true); await failed.click('tunnelSave')
  assert.equal(settingsPosts(failed).length, 1)
  assert.ok(failed.requests.every(r => !r.url.startsWith('/api/')))
})
