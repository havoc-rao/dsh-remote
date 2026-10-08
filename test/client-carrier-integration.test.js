import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const fp = 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')
const machine = { id: 'carrier-1', name: 'Dev host', transport: 'ssh', username: 'dev', useAgent: true, privateKeyPath: '', expectedHostFingerprint: fp, connector: { kind: 'devtunnel', mode: 'external', tunnelId: 'abc123', remotePort: 22, endpoint: { host: '127.0.0.1', port: 2222 } } }
const supported = { sshCarrierCapabilities: { workspaceSupported: true, carrierIds: ['devtunnel'] } }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function harness(status = supported, cwd = '/local/source') {
  let plugin, page, cursor = 0
  const states = [], effects = [], requests = [], sections = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'Fragment',
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }] },
    useEffect: (fn) => effects.push(fn), useRef: (v) => ({ current: v }), useMemo: (fn) => fn(), useCallback: (fn) => fn,
  }
  const services = {
    locale: { register() {}, bind: () => (k) => 'T:' + k },
    slots: { inject: (name, fn) => { if (name === 'settings.section') fn(); return () => {} }, register: (d, render) => { sections.push({ d, render }); return () => {} }, get: () => [] },
    sessions: { list: { getSnapshot: () => ({ current: 's', byId: { s: { cwd } } }), subscribe: () => () => {} } },
  }
  vm.runInNewContext(source, {
    window: { location: { protocol: 'https:' }, confirm: () => true, localStorage: { getItem: () => null }, __ModuleLoader__: { load: (m) => { plugin = m.factory(() => React) } } },
    document: { getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } }, navigator: { languages: ['en'] },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console,
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined
      requests.push({ url, body })
      let data = { ok: true }
      if (url === '/dsh-remote/machines') data = body ? { ok: true, machine: { ...machine, ...body, id: machine.id } } : { machines: [machine] }
      if (url.startsWith('/dsh-remote/status')) data = status
      if (url === '/dsh-remote/mirror') data = { ok: true, localMirror: '/local/mirror/carrier-1' }
      return { ok: true, json: async () => data }
    },
  })
  const ctx = { get: (n) => services[n], effect: (fn) => fn(), inject: (names, cb) => { if (names.every((n) => services[n])) cb(ctx) }, on() {}, logger: { warn() {} } }
  plugin.apply(ctx)
  page = sections.find((s) => s.d.id === 'dsh-remote').render()
  function render() { cursor = 0; return page.type(page.props) }
  let tree = render()
  const initialEffects = effects.splice(0)
  const nodes = (node, out = []) => { if (!node || typeof node !== 'object') return out; if (Array.isArray(node)) { node.forEach((n) => nodes(n, out)); return out } out.push(node); nodes(node.children, out); return out }
  const text = (n) => typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join(' ') : n && typeof n === 'object' ? text(n.children) : ''
  return {
    requests, async mount() { initialEffects.forEach((fn) => fn()); await tick(); tree = render(); return tree },
    render() { tree = render(); return tree }, text: () => text(tree),
    button(label) { const n = nodes(tree).find((n) => n.type === 'button' && text(n) === (label.startsWith('settings.') ? 'T:' + label : label)); assert.ok(n, label); return n },
    field(key) { const row = nodes(tree).find((n) => n.props.key === key); assert.ok(row, key); return nodes(row).find((n) => n.type === 'input') },
  }
}

test('real apply/settings render integrates carrier with list, locked identity, strict auth whitelist, fresh probe and mirror', async () => {
  const h = harness(); await h.mount()
  assert.match(h.text(), /abc123 · 127\.0\.0\.1:2222/)
  assert.doesNotMatch(h.text(), /dev@undefined/)
  h.button('settings.edit').props.onClick(); h.render()
  for (const key of ['ctid', 'crp', 'cfp']) assert.equal(h.field(key).props.disabled, true, key)
  assert.equal(h.field('clp').props.disabled, undefined)
  assert.equal(h.field('ca').props.checked, true)
  assert.doesNotMatch(h.text(), /settings\.password|settings\.useSshConfig|settings\.hostKeyMode|settings\.proxyHost/)
  h.button('settings.testConn').props.onClick(); await tick(); h.render()
  const probe = h.requests.find((r) => r.url === '/dsh-remote/test-connect')
  assert.ok(probe); assert.equal(probe.body.id, undefined); assert.deepEqual(probe.body.connector, machine.connector)
  assert.deepEqual(Object.keys(probe.body).sort(), ['connector','expectedHostFingerprint','hostKeyMode','name','privateKeyPath','transport','useAgent','username'].sort())
  h.field('clp').props.onChange({ target: { value: '3333' } }); h.render()
  h.button('settings.testOk').props.onClick(); await tick(); h.render()
  assert.equal(h.requests.filter((r) => r.url === '/dsh-remote/test-connect').length, 1, 'dirty saved machine cannot probe old saved endpoint')
  h.button('settings.save').props.onClick(); await tick(); h.render()
  const saved = h.requests.find((r) => r.url === '/dsh-remote/machines' && r.body)
  assert.equal(saved.body.transport, 'ssh'); assert.equal(saved.body.connector.endpoint.port, 3333)
  assert.equal(saved.body.id, machine.id); assert.equal(saved.body.action, 'update')
  h.field('cmd').props.onChange({ target: { value: '/remote/project' } }); h.render()
  assert.equal(h.button('settings.carrierCreateMirror').props.disabled, false)
  h.button('settings.carrierCreateMirror').props.onClick(); await tick(); h.render()
  assert.deepEqual(h.requests.find((r) => r.url === '/dsh-remote/mirror').body, { machine: machine.id, path: '/remote/project', workspace: '/local/source' })
  assert.match(h.text(), /\/local\/mirror\/carrier-1/); assert.match(h.text(), /settings.carrierMirrorHint/)
})

test('carrier validation rejects non-loopback endpoints, invalid ids, fingerprints and ports', () => {
  const start = source.indexOf('    function devTunnelFormBody(')
  const end = source.indexOf('    function carrierAddrText(', start)
  const context = vm.createContext({})
  vm.runInContext(source.slice(start, end), context)
  const valid = { name: 'dev', username: 'dev', tunnelId: 'abc123', remotePort: '22', localHost: '127.0.0.1', localPort: '2222', expectedHostFingerprint: fp, useAgent: true, privateKeyPath: '' }
  assert.equal(context.devTunnelFormValid(valid), true)
  assert.equal(context.devTunnelFormValid({ ...valid, localHost: '::1' }), true)
  for (const change of [{ localHost: 'localhost' }, { localHost: '10.0.0.1' }, { tunnelId: 'bad/id' }, { remotePort: '0' }, { localPort: '65536' }, { expectedHostFingerprint: '' }, { useAgent: false }]) assert.equal(context.devTunnelFormValid({ ...valid, ...change }), false, JSON.stringify(change))
  assert.equal(context.devTunnelFormValid({ ...valid, useAgent: false, privateKeyPath: '/keys/dev' }), true)
})

test('unavailable carrier disables the carrier entry and useNow while direct SSH stays available', async () => {
  for (const status of [null, { sshCarrierCapabilities: { workspaceSupported: false, carrierIds: ['devtunnel'] } }, { sshCarrierCapabilities: { workspaceSupported: true, carrierIds: [] } }]) {
    const h = harness(status); await h.mount()
    assert.equal(h.button('Dev Tunnel SSH').props.disabled, true)
    assert.equal(h.button('settings.setCurrent').props.disabled, true)
    assert.equal(h.button('SSH').props.disabled, false)
  }
})

test('new carrier defaults agent and requires strict fingerprint, ports and identity; no scope still loads capabilities', async () => {
  const h = harness(supported, ''); await h.mount()
  h.button('Dev Tunnel SSH').props.onClick(); h.render()
  assert.equal(h.field('ca').props.checked, true)
  assert.equal(h.button('settings.save').props.disabled, true)
  for (const [key, value] of [['ctid', 'abc123'], ['cfp', fp]]) { h.field(key).props.onChange({ target: { value } }); h.render() }
  assert.equal(h.button('settings.save').props.disabled, false)
  h.button('settings.testConn').props.onClick(); await tick(); h.render()
  assert.equal(h.requests.find((r) => r.url === '/dsh-remote/test-connect').body.id, undefined)
  assert.equal(h.button('settings.carrierCreateMirror').props.disabled, true)
  h.field('clp').props.onChange({ target: { value: '65536' } }); h.render()
  assert.equal(h.button('settings.save').props.disabled, true)
})
