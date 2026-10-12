// The global Dev Tunnel settings state machine (useTunnelSettings: host CLI
// path / managed authorization / resident channel / preflight) stays owned by
// dsh-remote. Since contract v3 the settings CARD is rendered by the panel
// occupant through the `tunnel` owner props instead of on this page, so this
// file drives the owner state machine through a stub panel that consumes those
// props exactly like the occupant, while the DSH-remote page only declares the
// slot. This file asserts the machine behaviour AND the owner props the page
// publishes into the transport option/panel slots.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const OPT = 'settings.remote.machine.transport.option'
const FLD = 'settings.remote.machine.transport.fields'
const PNLP = 'settings.remote.machine.transport.panel'

function harness(options = {}) {
  let plugin, page, tree, cursor = 0
  let snapshot = { ok: true, available: true, settings: { cliExecutable: options.auto ? '' : '/opt/devtunnel', managedEnabled: false, residentTunnelId: String(options.residentId || ''), residentRemotePort: options.residentPort || 0, residentMode: options.residentMode || 'off' }, cli: { status: options.notFound ? 'not-found' : 'found', source: options.auto ? 'path' : 'override', resolvedExecutable: options.notFound ? '' : '/opt/devtunnel' }, revision: 7, source: 'config', activeManaged: options.active || 0 }
  let channelsResident = Object.assign({ enabled: false, mode: 'off' }, options.channels)
  const refs = [], effects = [], requests = [], confirmations = [], answers = [], sections = [], registrations = new Map(), slotKeys = [], trCalls = []
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
    locale: { register() {}, bind: () => (k, params) => { trCalls.push({ k, params }); return 'T:' + k } },
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
        else {
          snapshot = { ...snapshot, settings: { cliExecutable: body.cliExecutable, managedEnabled: body.managedEnabled, residentTunnelId: body.residentTunnelId || '', residentRemotePort: body.residentRemotePort || 0, residentMode: body.residentMode || 'off' }, cli: { status: options.notFound ? 'not-found' : 'found', source: body.cliExecutable ? 'override' : 'path', resolvedExecutable: options.notFound ? '' : (body.cliExecutable || '/opt/devtunnel') }, revision: snapshot.revision + 1, source: 'settings', activeManaged: 0 }
          if (body.residentMode === 'immediate' && body.residentTunnelId) channelsResident = { enabled: true, mode: 'immediate', tunnelId: body.residentTunnelId, remotePort: body.residentRemotePort, state: 'starting', generation: 1, users: 0, blocked: null, exhausted: false, lastCode: null }
          data = snapshot
        }
      }
      if (url === '/dsh-devtunnel-ssh/channels') data = { ok: true, revision: 7, enabled: true, activeManaged: 0, channels: [], supervisor: [], resident: channelsResident, recent: [] }
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
  // Contract v3: the global Dev Tunnel settings CARD moved to the panel slot —
  // the owner publishes useTunnelSettings through the `tunnel` owner props and
  // the occupant renders it. This stub consumes those props like the occupant
  // (same field keys), so the tests keep driving the owner state machine.
  let panelProps = null
  // Inline builder, not a component wrapper: the page tree is consumed both
  // resolved and unresolved by this harness, so tunnel-* nodes must exist
  // directly under the slot mount point.
  const panelBody = (p) => {
    panelProps = p
    const t = p.tunnel || {}
    const d = t.tunnelDraft || {}
    const disabled = !!t.tunnelBusy || !t.tunnelReady
    const patch = (next) => { if (t.setTunnelDraft) t.setTunnelDraft(next); if (t.setTunnelProbe) t.setTunnelProbe(null); if (t.setTunnelMsg) t.setTunnelMsg('') }
    const field = (key, ctrl) => React.createElement('div', { key: 'tunnel-' + key }, ctrl)
    const probeBlocked = disabled || !!t.tunnelDirty || !(t.tunnelSettings && t.tunnelSettings.cli && t.tunnelSettings.cli.status === 'found')
    return React.createElement('div', null,
      field('cli', React.createElement('input', { className: 'rws-input', value: d.cliExecutable || '', placeholder: 'T:settings.tunnelCliPlaceholder', disabled, 'aria-label': 'T:settings.tunnelCli', onChange: e => patch({ ...d, cliExecutable: e.target.value }) })),
      field('enabled', React.createElement('input', { type: 'checkbox', checked: !!d.managedEnabled, disabled, 'aria-label': 'T:settings.tunnelEnabled', onChange: e => patch({ ...d, managedEnabled: e.target.checked }) })),
      field('resident-mode', React.createElement('select', { className: 'rws-input', value: d.residentMode || 'off', disabled, 'aria-label': 'T:settings.tunnelResidentMode', onChange: e => { const residentMode = e.target.value; patch({ ...d, residentMode, ...(residentMode === 'off' ? { residentTunnelId: '', residentRemotePort: 0 } : {}) }) } },
        React.createElement('option', { value: 'off' }, 'T:settings.tunnelResidentOff'),
        React.createElement('option', { value: 'immediate' }, 'T:settings.tunnelResidentImmediate'),
        React.createElement('option', { value: 'lazy' }, 'T:settings.tunnelResidentLazy'))),
      field('resident-id', React.createElement('input', { className: 'rws-input', value: d.residentTunnelId || '', disabled: disabled || d.residentMode === 'off', 'aria-label': 'T:settings.tunnelResidentId', onChange: e => patch({ ...d, residentTunnelId: e.target.value }) })),
      field('resident-port', React.createElement('input', { className: 'rws-input', type: 'number', value: d.residentRemotePort || '', disabled: disabled || d.residentMode === 'off', 'aria-label': 'T:settings.tunnelResidentPort', onChange: e => { const n = Number(e.target.value); patch({ ...d, residentRemotePort: e.target.value === '' ? 0 : (Number.isFinite(n) && n > 0 ? n : 0) }) } })),
      t.tunnelReady ? React.createElement('div', { key: 'tunnel-meta' }, 'T:settings.tunnelMeta') : null,
      t.tunnelReady ? React.createElement('div', { key: 'tunnel-resolved' },
        React.createElement('span', null, 'T:settings.tunnelResolved'),
        React.createElement('code', { 'data-testid': 'devtunnel-resolved-executable' }, (t.tunnelSettings && t.tunnelSettings.cli && t.tunnelSettings.cli.resolvedExecutable) || '—')) : null,
      t.tunnelReady && t.tunnelSettings.cli.status === 'not-found' ? React.createElement('div', { key: 'tunnel-notfound', role: 'status' }, 'T:settings.tunnelNotFound') : null,
      t.tunnelDirty ? React.createElement('div', { key: 'tunnel-dirty' }, 'T:' + (t.tunnelValid ? 'settings.tunnelDirty' : 'settings.tunnelInvalid')) : null,
      React.createElement('div', { key: 'tunnel-actions' },
        React.createElement('button', { type: 'button', disabled: disabled || !t.tunnelDirty || !t.tunnelValid, onClick: () => t.saveTunnelSettings && t.saveTunnelSettings() }, 'T:settings.tunnelSave'),
        React.createElement('button', { type: 'button', disabled: t.tunnelBusy, onClick: () => t.refreshTunnelSettings && t.refreshTunnelSettings() }, 'T:settings.tunnelRefresh'),
        React.createElement('button', { type: 'button', disabled: probeBlocked, onClick: () => t.preflightTunnel && t.preflightTunnel(false) }, 'T:settings.tunnelProbe'),
        React.createElement('button', { type: 'button', disabled: probeBlocked, onClick: () => t.preflightTunnel && t.preflightTunnel(true) }, 'T:settings.tunnelLoginProbe')),
      t.tunnelErr ? React.createElement('div', { role: 'alert' }, t.tunnelErr) : null,
      t.tunnelProbe ? React.createElement('pre', null, JSON.stringify(t.tunnelProbe, null, 2)) : null,
    )
  }
  // The page dispatches option (list: both entries) and fields (keyed by entryKey);
  // the panel list is consumed by the stub above (contract v3 rendering owner).
  const renderSlot = (key, owner, opts) => {
    slotKeys.push(key)
    if (key === OPT) {
      // Exercise the page's real dispatch (owner props included); the entry body
      // needs no hooks, so rendering it inside the page pass is safe here.
      const e = registrations.get(OPT)
      if (e) resolveEntry(e.render, owner)
      return null
    }
    if (key === PNLP) return panelBody(owner)
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
    requests, confirmations, answers, options, slotKeys, trCalls, get optionProps() { return optionProps }, get panelProps() { return panelProps },
    render() { tree = resolve(render()); return tree },
    text: () => text(tree),
    async mount() { initialEffects.forEach(fn => fn()); await tick(); tree = resolve(render()); render(); return tree },
    button(key) { const n = nodes(tree).find(n => n.type === 'button' && text(n) === 'T:settings.' + key); assert.ok(n, key); return n },
    field(key) { const row = nodes(tree).find(n => n.props.key === 'tunnel-' + key); return nodes(row).find(n => n.type === 'input' || n.type === 'select') },
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
  assert.deepEqual(settingsPosts(h)[0].body, { cliExecutable: '/opt/devtunnel', managedEnabled: true, residentTunnelId: '', residentRemotePort: 0, residentMode: 'off', confirmed: true, disconnectActive: false, revision: 7 })
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
  assert.deepEqual(settingsPosts(h)[0].body, { cliExecutable: '', managedEnabled: true, residentTunnelId: '', residentRemotePort: 0, residentMode: 'off', confirmed: true, disconnectActive: false, revision: 7 })
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
    ['GET', '/dsh-devtunnel-ssh/settings'], ['GET', '/dsh-devtunnel-ssh/channels'], ['POST', '/dsh-devtunnel-ssh/settings'], ['GET', '/dsh-devtunnel-ssh/channels'], ['POST', '/dsh-devtunnel-ssh/preflight'],
  ])
  const failed = harness({ protocol: 'dsh-app:', conflict: 'SETTINGS_REVISION_CONFLICT' }); await failed.mount()
  failed.edit('enabled', true); await failed.click('tunnelSave')
  assert.equal(settingsPosts(failed).length, 1)
  assert.ok(failed.requests.every(r => !r.url.startsWith('/api/')))
})

test('resident: off disables id/port; immediate start confirms and posts exactly 8 keys', async () => {
  const h = harness(); await h.mount()
  assert.equal(h.field('resident-mode').props.value, 'off')
  assert.equal(h.field('resident-id').props.disabled, true); assert.equal(h.field('resident-port').props.disabled, true)
  h.edit('resident-mode', 'immediate')
  assert.equal(h.field('resident-id').props.disabled, false); assert.equal(h.field('resident-port').props.disabled, false)
  assert.equal(h.button('tunnelSave').props.disabled, true, 'immediate requires a valid id and port')
  h.edit('resident-id', 'my-tunnel.jpe1'); h.edit('resident-port', 22)
  assert.equal(h.button('tunnelSave').props.disabled, false)
  await h.click('tunnelSave')
  assert.deepEqual(settingsPosts(h)[0].body, { cliExecutable: '/opt/devtunnel', managedEnabled: false, residentTunnelId: 'my-tunnel.jpe1', residentRemotePort: 22, residentMode: 'immediate', confirmed: true, disconnectActive: false, revision: 7 })
  assert.ok(h.confirmations.includes('T:settings.tunnelResidentStartConfirm'))
  assert.equal(h.field('resident-mode').props.value, 'immediate')
  assert.equal(h.field('resident-id').props.value, 'my-tunnel.jpe1')
})

test('resident: invalid tunnel id or port blocks save; switching to off resets the inputs', async () => {
  const h = harness(); await h.mount()
  h.edit('resident-mode', 'lazy')
  h.edit('resident-id', 'UPPER-Case!'); h.edit('resident-port', 22)
  assert.equal(h.button('tunnelSave').props.disabled, true)
  await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 0)
  h.edit('resident-id', 'ok-tunnel.sub'); h.edit('resident-port', 0)
  assert.equal(h.button('tunnelSave').props.disabled, true, 'lazy with port 0 is invalid')
  h.edit('resident-port', 65535); h.edit('resident-port', 65536)
  assert.equal(h.button('tunnelSave').props.disabled, true, 'port 65536 out of range')
  h.edit('resident-port', 22); h.edit('enabled', true); h.edit('resident-mode', 'off')
  assert.equal(h.field('resident-id').props.disabled, true)
  assert.equal(h.field('resident-id').props.value, '')
  assert.equal(h.button('tunnelSave').props.disabled, false, 'enabled toggle keeps the card dirty once off')
})

test('resident: changing mode while active requires explicit disconnect', async () => {
  const h = harness({ residentId: 'my-tunnel.jpe1', residentPort: 22, residentMode: 'immediate', channels: { enabled: true, mode: 'immediate', tunnelId: 'my-tunnel.jpe1', remotePort: 22, state: 'ready', generation: 4, users: 2, blocked: null, exhausted: false, lastCode: null } })
  await h.mount()
  h.edit('resident-mode', 'lazy')
  h.answers.push(false); await h.click('tunnelSave'); assert.equal(settingsPosts(h).length, 0)
  h.answers.push(true, true); await h.click('tunnelSave')
  assert.equal(settingsPosts(h)[0].body.disconnectActive, true)
  assert.equal(settingsPosts(h)[0].body.residentMode, 'lazy')
  assert.ok(h.confirmations.includes('T:settings.tunnelResidentDisconnectConfirm'))
})

test('resident: off normalizes leftover draft values to empty id and port 0 on save', async () => {
  const h = harness(); await h.mount()
  // 真实 UI 下 off 输入被禁用；这里模拟残留 draft 直接漂移（回归归一化）。
  h.edit('resident-id', 'leftover.jpe1'); h.edit('resident-port', 22)
  h.edit('enabled', true); await h.click('tunnelSave')
  assert.deepEqual(settingsPosts(h)[0].body, { cliExecutable: '/opt/devtunnel', managedEnabled: true, residentTunnelId: '', residentRemotePort: 0, residentMode: 'off', confirmed: true, disconnectActive: false, revision: 7 })
  assert.ok(!h.confirmations.includes('T:settings.tunnelResidentStartConfirm'))
  assert.ok(h.confirmations.includes('T:settings.tunnelConfirm'))
})
