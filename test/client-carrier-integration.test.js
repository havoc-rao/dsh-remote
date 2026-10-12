// Integration test for the RemoteSettings machine form SLOTS.
//
// dsh-remote owns only the slot owner (declaration + dispatch + the generic
// submit/probe/mirror pipeline). The Dev Tunnel (carrier) FIELDS, channel-mode
// buttons and their field-level validation live in dsh-devtunnel-ssh and are
// exercised by that repository's own tests; here a STUB occupant registers into
// both slots, publishes a draft through `carrier.publish` and exposes the few
// controls needed to drive the owner's generic pipeline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const fp = 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')
const machine = { id: 'carrier-1', name: 'Dev host', transport: 'ssh', username: 'dev', useAgent: true, privateKeyPath: '', expectedHostFingerprint: fp, connector: { kind: 'devtunnel', mode: 'external', tunnelId: 'abc123', remotePort: 22, endpoint: { host: '127.0.0.1', port: 2222 } } }
const supported = { sshCarrierCapabilities: { workspaceSupported: true, carrierIds: ['devtunnel'] } }
const managedSupported = { sshCarrierCapabilities: { ...supported.sshCarrierCapabilities, devTunnelManaged: true } }
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

// Body shape published by the occupant (the frozen draft contract). The stub
// owns every devtunnel interpretation: the owner must not need any of it. The
// transport key stays the literal 'ssh' (persisted carrier machines remain
// ordinary SSH); the slot entryKey is what carries 'devtunnel-ssh'.
function stubBody(form) {
  const mode = form.carrierMode || 'external'
  return {
    transport: 'ssh', name: String(form.name || '').trim(), username: String(form.username || '').trim(),
    connector: { kind: 'devtunnel', mode, tunnelId: String(form.tunnelId || '').trim(), remotePort: Number(form.remotePort),
      ...(mode === 'external' ? { endpoint: { host: form.localHost || '127.0.0.1', port: Number(form.localPort) } } : {}) },
    hostKeyMode: 'verify', expectedHostFingerprint: String(form.expectedHostFingerprint || '').trim(),
    useAgent: !!form.useAgent, privateKeyPath: String(form.privateKeyPath || '').trim(),
  }
}

/** Depth-first element walker used by the placement assertions (harness-local). */
function nodesOf(node) {
  const out = []
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(walk); return } out.push(n); walk(n.children) }
  walk(node)
  return out
}

function harness(status = supported, cwd = '/local/source', savedMachine = machine, opts = {}) {
  let plugin, page, tree = null, extras = [], stubOption = null, stubPanel = null, slotCalls = []
  let capturedFields = null, latestFields = null, captureFields = false
  let pageRenders = 0, forcePublish = false, publishes = 0
  const effects = [], requests = [], sections = [], confirmations = [], answers = [], registrations = new Map()
  // Real hook state, keyed by COMPONENT INSTANCE (React's fiber): the page and each
  // slot entry keep independent state slots, so an entry rendering first cannot
  // shift the page's hook order. Setters/handlers/effects close over their instance.
  const instances = new Map()
  let key = null
  function instance() { let i = instances.get(key); if (!i) { i = { cursor: 0, states: [], refs: [] }; instances.set(key, i) } return i }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children, key: key }),
    Fragment: 'Fragment',
    useState(initial) { const inst = instance(); const i = inst.cursor++; if (!(i in inst.states)) inst.states[i] = typeof initial === 'function' ? initial() : initial; return [inst.states[i], (v) => { inst.states[i] = typeof v === 'function' ? v(inst.states[i]) : v }] },
    useEffect(fn) { const instKey = key; effects.push(() => withKey(instKey, fn)) },
    useMemo: (fn) => fn(), useCallback: (fn) => fn,
    useRef(initial) { const inst = instance(); const i = inst.cursor++; if (!(i in inst.refs)) inst.refs[i] = { current: initial }; return inst.refs[i] },
  }
  function withKey(instKey, fn) { const prev = key; key = instKey; try { return fn() } finally { key = prev } }
  function render(type, props, instKey) { const inst = instances.get(instKey) || { cursor: 0, states: [], refs: [] }; const prev = key; key = instKey; inst.cursor = 0; instances.set(instKey, inst); try { return type(props) } finally { key = prev } }
  // ── stub occupant: the sibling plugin's browser half, reduced to the slot
  // contract (publish a draft + two minimal controls). Its fields component is the
  // page's OWN SshMachineFields source, so patch/setChecked wiring is exercised.
  const fieldsModule = (() => {
    const mod = source.indexOf('    function SshMachineFields(')
    const end = source.indexOf('    function ', mod + 10)
    const ctx = {
      React, tr: (k) => 'T:' + k, T: new Proxy({}, { get: () => '#000' }), MONO_FS: 'mono', row: () => null,
      // Module-scope helpers SshMachineFields uses in the bundle.
      formText: (patch) => (ev) => patch({ [ev.target.dataset.k]: ev.target.value }),
      formCheck: (setChecked) => (ev) => setChecked(ev.target.dataset.k, ev.target.checked),
    }
    return vm.runInNewContext(source.slice(mod, end) + '\nSshMachineFields', ctx)
  })()
  function StubTransportOption(p) {
    stubOption = p
    return React.createElement('button', { type: 'button', className: 'rws-btn' + (p.transport === 'devtunnel-ssh' ? ' on' : ''), disabled: !!p.locked, onClick: () => p.onSelect('devtunnel-ssh') }, 'Dev Tunnel SSH')
  }
  function StubFields(p) {
    const f = p.form, c = p.carrier
    latestFields = p
    if (captureFields) { capturedFields = p; captureFields = false }
    const body = stubBody(f)
    // Normal passes always publish; a manual pass counts itself so the test can tell
    // the forced publish apart from the page's own occupant renders.
    if (forcePublish) { publishes++; forcePublish = false }
    c.publish({ valid: true, body, mode: body.connector.mode, tunnelId: body.connector.tunnelId })
    return React.createElement('div', { 'data-stub': p.transport },
      React.createElement('input', { key: 'stub-clp', value: f.localPort, onChange: (e) => p.patch({ localPort: e.target.value }) }),
      React.createElement('button', { type: 'button', className: 'rws-btn' + (body.connector.mode === 'managed' ? ' on' : ''), onClick: () => p.patch({ carrierMode: body.connector.mode === 'managed' ? 'external' : 'managed' }) }, body.connector.mode === 'managed' ? 'T:settings.carrierManaged' : 'T:settings.carrierExternal'),
      React.createElement('input', { key: 'stub-cmd', value: c.mirrorPath, onChange: (e) => c.setMirrorPath(e.target.value) }),
      React.createElement('button', { type: 'button', onClick: c.createMirror, disabled: !f.id || c.dirty || !String(c.mirrorPath || '').trim() }, 'T:settings.carrierCreateMirror'),
      React.createElement('code', null, c.localMirror || ''),
      fieldsModule({ form: f, patch: p.patch, setChecked: p.setChecked, advOpen: p.advOpen, setAdvOpen: p.setAdvOpen, ssh: p.ssh, carrier: c }))
  }
  // The occupant's third entry: an opaque full-width box that must receive the
  // owner's live registry/scope state and render between the two cards.
  function StubPanel(p) {
    stubPanel = p
    return React.createElement('section', { 'data-panel': 'devtunnel-ssh' },
      React.createElement('span', null, 'T:settings.panelStub'),
      React.createElement('code', { 'data-panel-machines': String((p.machines || []).length) }, 'machines:' + String((p.machines || []).length)))
  }
  const services = {
    locale: { register() {}, bind: () => (k) => 'T:' + k },
    slots: {
      // Declaration-waiting semantics: the owner declares `settings.section` with
      // its children synchronously, so injecting the section runs immediately and
      // both child keys become declared before the occupant injects them.
      inject: (name, fn) => { fn(); return () => {} },
      register: (d, render) => {
        if (d.name === 'settings.section') {
          for (const child of Object.keys(d.children || {})) registrations.set(child, { meta: d.children[child] })
          sections.push({ d, render })
        } else if (d.key) {
          registrations.set(d.name + ':key:' + d.key, { d, render })
        } else {
          registrations.set(d.name + ':id:' + d.id, { d, render })
        }
        return () => {}
      },
      get: () => [],
    },
    sessions: { list: { getSnapshot: () => ({ current: 's', byId: { s: { cwd } } }), subscribe: () => () => {} } },
  }
  vm.runInNewContext(source, {
    window: { location: { protocol: 'https:' }, confirm: msg => { confirmations.push(msg); return answers.length ? answers.shift() : true }, localStorage: { getItem: () => null }, __ModuleLoader__: { load: (m) => { plugin = m.factory(() => React) } } },
    document: { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } }, navigator: { languages: ['en'] },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console,
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined
      requests.push({ url, body })
      let data = { ok: true }
      if (url.startsWith('/dsh-remote/machines')) data = savedMachine === null ? { machines: [] } : body ? { ok: true, machine: { ...savedMachine, ...body, id: savedMachine.id } } : { machines: [savedMachine] }
      if (url.startsWith('/dsh-remote/status')) data = status
      if (url === '/dsh-remote/mirror') data = { ok: true, localMirror: '/local/mirror/carrier-1' }
      return { ok: true, json: async () => data }
    },
  })
  const ctx = { get: (n) => services[n], effect: (fn) => fn(), inject: (names, cb) => { if (names.every((n) => services[n])) cb(ctx) }, on() {}, logger: { warn() {} } }
  plugin.apply(ctx)
  // The sibling plugin's browser half: inject + register its slot entries (the
  // declaration was committed synchronously by the owner's entry).
  services.slots.inject('settings.remote.machine.transport.option', () =>
    services.slots.register({ name: 'settings.remote.machine.transport.option', id: 'devtunnel-ssh', order: 10 }, StubTransportOption))
  services.slots.inject('settings.remote.machine.transport.fields', () =>
    services.slots.register({ name: 'settings.remote.machine.transport.fields', key: 'devtunnel-ssh' }, StubFields))
  const OPT = 'settings.remote.machine.transport.option'
  const FLD = 'settings.remote.machine.transport.fields'
  const PNLP = 'settings.remote.machine.transport.panel'
  if (opts.panel !== false) {
    services.slots.inject(PNLP, () =>
      services.slots.register({ name: PNLP, id: 'devtunnel-ssh', order: 10 }, StubPanel))
  }
  // The page's renderSlot face: option/panel are lists (every entry), fields is keyed
  // by `entryKey`. Collect this pass's dispatch; entries render below as their own
  // component instances (the page tree keeps a placeholder).
  const renderSlot = (key_, owner, opts_) => {
    const before = slotCalls.length
    if (key_ === OPT) {
      for (const id of ['ssh', 'devtunnel-ssh']) {
        const e = registrations.get(OPT + ':id:' + id)
        if (e) slotCalls.push({ e, owner, inst: OPT + ':' + id })
      }
    } else if (key_ === 'settings.remote.machine.transport.panel') {
      const e = registrations.get(PNLP + ':id:devtunnel-ssh')
      if (e) slotCalls.push({ e, owner, inst: PNLP + ':id:devtunnel-ssh' })
    } else {
      const e = registrations.get(FLD + ':key:' + opts_.entryKey)
      if (e) slotCalls.push({ e, owner, inst: FLD + ':' + opts_.entryKey })
    }
    // Exactly like the real renderer: nothing registered for this key (or no
    // renderer installed) renders as empty, never as a placeholder node.
    if (slotCalls.length === before) return null
    return { type: 'span', props: { 'data-slot': key_ }, children: [], key: 'slot:' + key_ }
  }
  page = sections.find((s) => s.d.id === 'dsh-remote').render({ renderSlot })
  // Minimal reconciler for the element trees this harness builds. Nested component
  // types re-enter with their own instance key (the page's are function-valued
  // children, e.g. the SSH fields module of the stub occupant).
  function resolve(node) {
    if (Array.isArray(node)) return node.flatMap(resolve)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return resolve(node.type(node.props))
    return { ...node, children: (node.children || []).flatMap(resolve) }
  }
  function renderAll() {
    pageRenders++
    const calls = slotCalls = []
    tree = resolve(render(page.type, page.props, 'page'))
    extras = []
    for (const c of calls) {
      const el = render(c.e.render, c.owner, c.inst)
      extras.push(resolve(el))
    }
    return tree
  }
  const nodes = (node, out = []) => { if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach((n) => nodes(n, out)); return out } out.push(node); nodes(node.children, out); return out }
  const text = (n) => typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join(' ') : n && typeof n === 'object' ? text(n.children) : ''
  const allNodes = () => extras.flatMap((e) => nodes(e)).concat(nodes(tree))
  renderAll()
  const initialEffects = effects.splice(0)
  return {
    requests, confirmations, answers,
    get optionProps() { return stubOption },
    get panelProps() { return stubPanel },
    // Slot entries render outside the page tree; report their relative order so a
    // test can assert the panel sits between the two cards.
    entryOrder() { return extras.map((e) => (nodes(e).find((n) => n.props && n.props['data-panel']) || {}).props ? 'panel' : null).filter(Boolean) },
    capture() { captureFields = true; renderAll(); return { fields: capturedFields } },
    children() { return sections.find((s) => s.d.id === 'dsh-remote').d.children },
    renders: () => pageRenders,
    // Manual publish: the next fields render calls publish once (no-op if the draft is unchanged).
    publish() { forcePublish = true; publishes = 0; renderAll(); return { publishes, renders: pageRenders } },
    async mount() { initialEffects.forEach((fn) => fn()); await tick(); renderAll(); renderAll(); renderAll(); return tree },
    // Two passes: the occupant publishes during its render, so the page's action
    // gating (read before the slots in the same pass) settles on the next one.
    render() { renderAll(); renderAll(); return tree },
    text: () => [text(tree)].concat(extras.map(text)).filter((s) => s !== '').join(' '),
    button(label) { const n = allNodes().find((n) => n.type === 'button' && text(n) === (label.startsWith('settings.') ? 'T:' + label : label)); assert.ok(n, label); return n },
    field(key_) { const row = allNodes().find((n) => n.props.key === key_); assert.ok(row, key_); return nodes(row).find((n) => n.type === 'input') },
    select(transport) { assert.ok(stubOption, 'transport option slot rendered'); stubOption.onSelect(transport); return renderAll() },
    // Drive the owner's setChecked through the SAME props the occupant receives.
    get fields() { return { props: latestFields, patch: (partial) => latestFields.patch(partial), check: (key, checked) => latestFields.setChecked(key, checked) } },
  }
}

test('slots: SSH entry renders the type button and the declared slot seats', async () => {
  const h = harness(); await h.mount()
  assert.equal(h.optionProps.transport, 'ssh')
  assert.equal(h.optionProps.locked, false)
  assert.equal(h.button('SSH').props.disabled, false)
  assert.equal(h.button('Dev Tunnel SSH').props.disabled, false)
  assert.equal(h.optionProps.status.sshCarrierCapabilities.workspaceSupported, true, 'owner publishes its scope status into the option slot')
  // SSH fields still render through the owner's own fields entry.
  assert.ok(h.field('h'))
  assert.ok(h.field('u'))
  assert.ok(h.field('w'))
  // The entry declares exactly the three slot children the contract freezes.
  const children = h.children()
  assert.deepEqual(Object.keys(children).sort(), [
    'settings.remote.machine.transport.fields',
    'settings.remote.machine.transport.option',
    'settings.remote.machine.transport.panel',
  ].sort())
  assert.equal(children['settings.remote.machine.transport.option'].kind, 'list')
  assert.equal(children['settings.remote.machine.transport.option'].scope, 'root')
  assert.equal(children['settings.remote.machine.transport.fields'].kind, 'keyed')
  assert.equal(children['settings.remote.machine.transport.fields'].scope, 'root')
  assert.equal(children['settings.remote.machine.transport.panel'].kind, 'list')
  assert.equal(children['settings.remote.machine.transport.panel'].scope, 'root')
})

test('panel slot: occupant receives the live registry/scope state and dispatches service and diagnostic sections independently', async () => {
  const h = harness(); await h.mount()
  const p = h.panelProps
  assert.ok(p, 'the panel slot dispatched to the registered occupant entry')
  assert.deepEqual(Object.keys(p).sort(), ['busy', 'currentId', 'machines', 'scopeDir', 'status', 'tunnel', 'section'].sort())
  assert.equal(p.status.sshCarrierCapabilities.workspaceSupported, true, 'live scope status')
  assert.equal(p.machines.length, 1)
  assert.equal(p.machines[0].id, 'carrier-1')
  assert.equal(p.currentId, '')
  assert.equal(p.scopeDir, '/local/source')
  assert.equal(p.busy, false)
  // Contract v3: the global settings state machine rides the same owner props,
  // so the occupant renders the settings card instead of the owner page.
  assert.equal(typeof p.tunnel, 'object', 'owner publishes useTunnelSettings through the panel props')
  assert.equal(typeof p.tunnel.saveTunnelSettings, 'function')
  assert.equal(typeof p.tunnel.preflightTunnel, 'function')
  assert.equal(p.section, 'services')
  assert.deepEqual(h.entryOrder(), ['panel'])
  let page = h.render()
  assert.equal(nodesOf(page).find(n => n.props['data-testid'] === 'remote-machine-editor').props.hidden, true)
  let machinePanel = nodesOf(page).find(n => n.props.id === 'remote-panel-machines')
  assert.equal(machinePanel.props.hidden, false)
  const children = machinePanel.children.flat().filter(Boolean)
  const editorIndex = children.findIndex(n => n.props && n.props['data-testid'] === 'remote-machine-editor')
  const panelIndex = children.findIndex(n => n.props && n.props['data-slot'] === 'settings.remote.machine.transport.panel')
  assert.ok(editorIndex >= 0 && panelIndex === editorIndex + 1, 'Dev Tunnel sits immediately below the editor box')
  h.button('settings.tabDiagnostics').props.onClick(); page = h.render()
  assert.equal(h.panelProps.section, 'diagnostics')
  assert.equal(nodesOf(page).find(n => n.props.id === 'remote-panel-machines').props.hidden, true)
  assert.equal(nodesOf(page).find(n => n.props.id === 'remote-panel-diagnostics').props.hidden, false)
  h.button('settings.tabMachines').props.onClick(); h.render()
  h.button('settings.addMachine').props.onClick(); page = h.render()
  assert.equal(nodesOf(page).find(n => n.props['data-testid'] === 'remote-machine-editor').props.hidden, false)
  const editCard = nodesOf(page).find(n => n.props.className === 'rws-card' && nodesOf(n).some(x => x.children && x.children[0] === 'T:settings.transportLabel'))
  assert.ok(editCard)
})

test('panel slot: an absent occupant leaves machines usable', async () => {
  const h = harness(supported, '/local/source', machine, { panel: false }); await h.mount()
  assert.equal(h.panelProps, null)
  assert.doesNotMatch(h.text(), /panelStub/)
  assert.ok(h.button('settings.addMachine'))
  assert.ok(h.button('settings.edit'))
})

test('gating: the carrier shape is decided by form.transport, never by body.transport', async () => {
  // Regression (composition test in the sibling repo): the draft body is the
  // machine POST shape, whose transport is the literal 'ssh', while the UI
  // transport key is 'devtunnel-ssh'. Comparing the two made carrierReady
  // permanently false, so a perfectly valid draft could never be saved.
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  assert.equal(h.optionProps.transport, 'devtunnel-ssh', 'UI transport key')
  // The owner published the draft at body.transport === 'ssh' (machine POST shape)
  // and commits it cleanly against the saved machine snapshot, whose own
  // reconstruction also carries transport:'ssh'; carrierBodyKey strips it on both
  // sides. A reintroduced body.transport === form.transport comparison would leave
  // both buttons disabled.
  assert.equal(h.button('settings.save').props.disabled, false, 'valid draft in carrier form must enable save')
  assert.equal(h.button('settings.testConn').props.disabled, false, 'and the clean draft may probe')
})

test('slots: a saved carrier machine rehydrates the occupant draft and the list row uses the connector address', async () => {
  const h = harness(); await h.mount()
  assert.match(h.text(), /abc123 · 127\.0\.0\.1:2222/)
  assert.doesNotMatch(h.text(), /dev@undefined/)
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  assert.equal(h.field('stub-clp').props.value, '2222', 'owner hands the saved connector values to the occupant through the draft')
  assert.equal(h.button('settings.save').props.disabled, false)
  assert.equal(h.button('settings.testConn').props.disabled, false, 'saved, unchanged draft may probe')
  assert.doesNotMatch(h.text(), /settings\.password|settings\.useSshConfig|settings\.hostKeyMode|settings\.proxyHost/)
})

test('pipeline: a saved carrier probe sends exactly { id } so the host reuses that machine lease', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  h.button('settings.testConn').props.onClick(); await tick(); h.render()
  const probe = h.requests.find((r) => r.url === '/dsh-remote/test-connect')
  assert.ok(probe)
  // Stable identity only: no draft body, so the host resolves the saved record and
  // acquires the SAME machineId lease (no temporary id -> no second CLI/BUSY).
  assert.deepEqual(probe.body, { id: machine.id })
})


test('pipeline: a new carrier probe still posts the published draft with no id', async () => {
  const h = harness(supported, '/local/source', null); await h.mount()
  h.select('devtunnel-ssh')
  // A brand-new machine is probed from its unsaved draft: fill the occupant's
  // required fields through the owner patch, then probe.
  h.fields.patch({ username: 'dev', tunnelId: 'abc123', expectedHostFingerprint: fp })
  h.render()
  assert.equal(h.button('settings.testConn').props.disabled, false, 'a valid unsaved draft may probe')
  h.button('settings.testConn').props.onClick(); await tick(); h.render()
  const probe = h.requests.find((r) => r.url === '/dsh-remote/test-connect')
  assert.ok(probe); assert.equal(probe.body.id, undefined)
  assert.equal(probe.body.transport, 'ssh')
  assert.deepEqual(probe.body.connector, { kind: 'devtunnel', mode: 'external', tunnelId: 'abc123', remotePort: 22, endpoint: { host: '127.0.0.1', port: 2222 } })
  assert.deepEqual(Object.keys(probe.body).sort(), ['connector','expectedHostFingerprint','hostKeyMode','name','privateKeyPath','transport','useAgent','username'].sort())
})

test('pipeline: a dirty saved machine probe is blocked before any request (no silent old-config probe)', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  h.field('stub-clp').props.onChange({ target: { value: '3333' } }); h.render(); h.render()
  assert.equal(h.button('settings.testConn').props.disabled, true)
  h.button('settings.testConn').props.onClick(); await tick(); h.render()
  assert.equal(h.requests.filter((r) => r.url === '/dsh-remote/test-connect').length, 0)
})

test('pipeline: dirty saved draft cannot probe; save confirms, posts body+action+id and the clean draft may probe again', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  h.field('stub-clp').props.onChange({ target: { value: '3333' } }); h.render(); h.render()
  assert.equal(h.button('settings.testConn').props.disabled, true, 'a dirty draft must not probe the stale saved endpoint')
  assert.equal(h.button('settings.save').props.disabled, false)
  h.button('settings.save').props.onClick(); await tick(); h.render(); h.render()
  const saved = h.requests.find((r) => r.url === '/dsh-remote/machines' && r.body)
  assert.equal(saved.body.transport, 'ssh'); assert.equal(saved.body.connector.endpoint.port, 3333)
  assert.equal(saved.body.id, machine.id); assert.equal(saved.body.action, 'update')
  assert.deepEqual(h.confirmations, ['T:settings.carrierUpdateConfirm'], 'editing a saved machine keeps the disconnect confirmation')
  assert.equal(h.button('settings.testConn').props.disabled, false, 'after save the rehydrated draft is clean again')
  assert.equal(h.requests.filter((r) => r.url === '/dsh-remote/test-connect').length, 0)
})

test('pipeline: declining the update confirmation posts nothing', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  h.field('stub-clp').props.onChange({ target: { value: '4444' } }); h.render(); h.render()
  h.answers.push(false)
  h.button('settings.save').props.onClick(); await tick(); h.render()
  assert.equal(h.requests.filter((r) => r.url === '/dsh-remote/machines' && r.body).length, 0)
  assert.deepEqual(h.confirmations, ['T:settings.carrierUpdateConfirm'])
})

test('pipeline: the dirty gate compares canonical JSON, so key order is not a contract', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  assert.equal(h.button('settings.carrierCreateMirror').props.disabled, true, 'no mirror path yet')
  h.field('stub-cmd').props.onChange({ target: { value: '/remote/project' } }); h.render(); h.render()
  // The clean gate can only pass because the owner compares recursively SORTED
  // keys: the occupant publishes one insertion order while machineCarrierBody
  // builds the machine's own. This pins the canonical-JSON half of the contract.
  const a = JSON.stringify(machine.connector)
  const b = JSON.stringify({ endpoint: { port: 2222, host: '127.0.0.1' }, remotePort: 22, tunnelId: 'abc123', mode: 'external', kind: 'devtunnel' })
  assert.notEqual(a, b, 'the two builds really do differ in key order')
  assert.equal(h.button('settings.carrierCreateMirror').props.disabled, false, 'reordered keys must not read as dirty')
  assert.equal(h.button('settings.save').props.disabled, false)
})

test('pipeline: managed draft omits endpoint and probes the published body', async () => {
  const h = harness(managedSupported); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  h.button('T:settings.carrierExternal').props.onClick(); h.render(); h.render()
  assert.equal(h.button('settings.save').props.disabled, false)
  h.button('settings.save').props.onClick(); await tick(); h.render(); h.render()
  const saved = h.requests.find((r) => r.url === '/dsh-remote/machines' && r.body)
  assert.deepEqual(saved.body.connector, { kind: 'devtunnel', mode: 'managed', tunnelId: 'abc123', remotePort: 22 })
  h.button('settings.testConn').props.onClick(); await tick(); h.render()
  assert.deepEqual(h.requests.find((r) => r.url === '/dsh-remote/test-connect').body, { id: machine.id })
})

test('pipeline: mirror requires saved scope, clean draft and non-empty path, then posts the mirror request', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  assert.equal(h.button('settings.carrierCreateMirror').props.disabled, true, 'no mirror path yet')
  h.field('stub-cmd').props.onChange({ target: { value: '/remote/project' } }); h.render(); h.render()
  assert.equal(h.button('settings.carrierCreateMirror').props.disabled, false)
  h.button('settings.carrierCreateMirror').props.onClick(); await tick(); h.render()
  assert.deepEqual(h.requests.find((r) => r.url === '/dsh-remote/mirror').body, { machine: machine.id, path: '/remote/project', workspace: '/local/source' })
  assert.match(h.text(), /\/local\/mirror\/carrier-1/)
  h.field('stub-clp').props.onChange({ target: { value: '9999' } }); h.render(); h.render()
  assert.equal(h.button('settings.carrierCreateMirror').props.disabled, true, 'dirty draft blocks the mirror')
})


test('contract: patch/setChecked clear the previous probe feedback (tst/msg/err/localMirror)', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render(); h.render()
  h.button('settings.testConn').props.onClick(); await tick(); h.render(); h.render()
  assert.match(h.text(), /settings\.testOk/, 'probe succeeded and owns the last feedback')
  // The occupant edits a field through the owner patch (no page setter available).
  h.field('stub-clp').props.onChange({ target: { value: '3333' } }); h.render(); h.render()
  assert.match(h.text(), /settings\.testConn/)
  assert.doesNotMatch(h.text(), /settings\.testOk/, 'patch must reset the stale probe state')
  // setChecked goes through the same door: re-probe to leave feedback, then toggle a
  // form boolean through the owner's setChecked and require the feedback to clear.
  h.field('stub-clp').props.onChange({ target: { value: '2222' } }); h.render(); h.render()
  h.button('settings.testConn').props.onClick(); await tick(); h.render(); h.render()
  assert.match(h.text(), /settings\.testOk/, 'second probe leaves feedback again')
  h.fields.check('useAgent', false); h.render(); h.render()
  assert.doesNotMatch(h.text(), /settings\.testOk/, 'setChecked must clear the stale probe state too')
  // A failed probe leaves err; the next edit must clear it (settings.carrierSaveFirst path).
  h.field('stub-clp').props.onChange({ target: { value: '2222' } }); h.render(); h.render()
  h.button('settings.save').props.onClick(); await tick(); h.render(); h.render()
  h.field('stub-clp').props.onChange({ target: { value: '5555' } }); h.render(); h.render()
  h.button('settings.testConn').props.onClick(); await tick(); h.render()
  assert.match(h.text(), /settings\.carrierSaveFirst/, 'dirty draft probe is refused with the save-first error')
  h.field('stub-clp').props.onChange({ target: { value: '2222' } }); h.render(); h.render()
  assert.doesNotMatch(h.text(), /settings\.carrierSaveFirst/, 'patch clears the refused-probe error too')
})

test('contract: carrier.publish is idempotent (equal canonical draft never setState)', async () => {
  const h = harness(); await h.mount()
  h.button('settings.edit').props.onClick(); h.render()
  // Warm the owner: the first publish after startEdit legitimately lands.
  h.publish()
  // One manual pass = one forced publish + its own page render. An EQUAL canonical
  // draft must not add any further page render (that is the render loop the owner
  // is required to break); a changed draft does add one (positive control below).
  const base1 = h.renders()
  const first = h.publish()
  assert.equal(first.publishes, 1, 'the manual pass really did call publish')
  assert.equal(h.renders() - base1, 1, 'equal canonical draft must not setState (only the forced render)')
  const base2 = h.renders()
  const second = h.publish()
  assert.equal(second.publishes, 1)
  assert.equal(h.renders() - base2, 1, 'still idempotent on the next equal publish')
  // Positive control: a CHANGED draft does reach the owner. The observable proof is
  // the action gating: a now-dirty draft can no longer probe (draft.key !== saved).
  h.field('stub-clp').props.onChange({ target: { value: '4444' } })
  h.publish() // the owner update lands during this pass, so gate on the next one
  h.render()
  assert.equal(h.button('settings.testConn').props.disabled, true, 'a changed draft must update the owner state')
})

test('pipeline: unsupported workspace capability still gates useNow and posts nothing for the draft', async () => {
  const h = harness({ sshCarrierCapabilities: { workspaceSupported: false, carrierIds: [] } }); await h.mount()
  assert.equal(h.button('settings.setCurrent').props.disabled, true)
  assert.equal(h.button('SSH').props.disabled, false)
  h.select('devtunnel-ssh')
  h.button('settings.save').props.onClick(); await tick(); h.render()
  assert.equal(h.requests.filter((r) => r.url === '/dsh-remote/machines' && r.body).length, 0)
})

// Field-level assertions (ctid/crp/cfp/clp disabled+values, channel-mode buttons,
// managed omitting endpoint, fingerprint/port validation, devTunnelFormValid /
// devTunnelFormBody unit cases) intentionally live with the occupant now; see
// dsh-devtunnel-ssh's own client/slot tests.
