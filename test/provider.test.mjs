// provider.js 注册层契约单测（Step2，ADR-0002）
// 纯 fake provider：无网络、无 ssh2、与 localhost 无关。运行：node --test test/provider.test.mjs
// 风格对齐仓库 test/（node:test + node:assert/strict，顶层 test()）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerProvider,
  providerIds,
  providerOf,
  providerForMachine,
  validateMachineRecord,
  sanitizeMachineRecord,
  connectMachine,
} from '../lib/provider.js'

function fakeDef(id, overrides = {}) {
  return {
    id,
    connect: async () => ({ identity: id, close: async () => {} }),
    ...overrides,
  }
}

test('registerProvider: 注册成功，disposer 注销后 providerIds 相应变化', (t) => {
  const def = fakeDef('fake-ssh')
  const dispose = registerProvider(def)
  t.after(dispose)
  assert.ok(providerIds().includes('fake-ssh'))
  const got = providerOf('fake-ssh')
  assert.equal(got.id, 'fake-ssh')
  assert.equal(got.apiVersion, 1)
  assert.equal(typeof got.connect, 'function')
  dispose()
  assert.ok(!providerIds().includes('fake-ssh'))
  assert.equal(providerOf('fake-ssh'), undefined)
})

test('registerProvider: 非法 id（大写/点号/空/空格）抛错', () => {
  for (const bad of ['SSH', 'ssh.host', '', 'ssh host', 'SSH-Tunnel']) {
    assert.throws(() => registerProvider({ id: bad, connect: async () => {} }), /provider: invalid id/, `id=${JSON.stringify(bad)}`)
  }
  // 缺 id 与缺 connect 同样拒绝
  assert.throws(() => registerProvider({ connect: async () => {} }), /provider: invalid id/)
  assert.throws(() => registerProvider({ id: 'no-connect' }), /connect\(\) required/)
  assert.throws(() => registerProvider(null), /definition object required/)
})

test('registerProvider: 重复注册同 id 抛错', (t) => {
  const dispose = registerProvider(fakeDef('dup'))
  t.after(dispose)
  assert.throws(() => registerProvider(fakeDef('dup')), /already registered/)
})

test('registerProvider: apiVersion 缺省为 1，传入则保留', (t) => {
  const dispose = registerProvider(fakeDef('ver'))
  t.after(dispose)
  assert.equal(providerOf('ver').apiVersion, 1)
  const dispose2 = registerProvider(fakeDef('ver2', { apiVersion: 2 }))
  t.after(dispose2)
  assert.equal(providerOf('ver2').apiVersion, 2)
})

test('providerForMachine: 无 transport 缺省 ssh，未注册 transport 返回 def undefined 不抛', () => {
  assert.equal(providerForMachine({}).transport, 'ssh')
  assert.equal(providerForMachine({ transport: 'ssh' }).transport, 'ssh')
  assert.equal(providerForMachine(null).transport, 'ssh')
  const r = providerForMachine({ transport: 'vscode-tunnel' })
  assert.equal(r.transport, 'vscode-tunnel')
  assert.equal(r.def, undefined)
})

test('providerForMachine: 已注册 transport 正确分派到 def', (t) => {
  const def = fakeDef('vscode-tunnel')
  const dispose = registerProvider(def)
  t.after(dispose)
  const r = providerForMachine({ transport: 'vscode-tunnel' })
  assert.equal(r.transport, 'vscode-tunnel')
  assert.equal(r.def.id, 'vscode-tunnel')
  assert.equal(r.def, providerOf('vscode-tunnel'))
})

test('validateMachineRecord: 未注册 transport 抛错；非法记录抛错', () => {
  assert.throws(() => validateMachineRecord({ transport: 'ghost' }), /transport "ghost": provider not installed/)
  assert.throws(() => validateMachineRecord(null), /machine record required/)
  assert.throws(() => validateMachineRecord(undefined), /machine record required/)
})

test('validateMachineRecord: 已注册 provider 的 validateMachine 异常透传；正常通过', (t) => {
  const boom = new Error('machine record invalid: no host')
  const dispose = registerProvider(fakeDef('strict', {
    validateMachine(m) { if (!m.host) throw boom },
  }))
  t.after(dispose)
  assert.throws(() => validateMachineRecord({ transport: 'strict' }), (e) => e === boom)
  const ok = { transport: 'strict', host: 'example.com' }
  assert.equal(validateMachineRecord(ok), ok)
})

test('validateMachineRecord: 无 validateMachine 的 provider 直接通过', (t) => {
  const dispose = registerProvider(fakeDef('lax'))
  t.after(dispose)
  assert.equal(validateMachineRecord({ transport: 'lax', foo: 1 }).transport, 'lax')
})

test('sanitizeMachineRecord: password/credentialRef/tunnel.secret 剥除并置 *Set 布尔', () => {
  const input = {
    transport: 'ssh',
    host: 'h',
    password: 'sekrit',
    credentialRef: 'keychain:foo',
    tunnel: { url: 'http://127.0.0.1:1234', secret: 'tok' },
  }
  const out = sanitizeMachineRecord(input)
  assert.equal(out.password, '')
  assert.equal(out.passwordSet, true)
  assert.equal(out.credentialRef, '')
  assert.equal(out.credentialSet, true)
  assert.equal(out.tunnel.secret, '')
  assert.equal(out.tunnel.secretSet, true)
  assert.equal(out.tunnel.url, 'http://127.0.0.1:1234')
  // 原对象与嵌套 tunnel 不被就地改写（返回新对象）
  assert.notEqual(out, input)
  assert.notEqual(out.tunnel, input.tunnel)
  assert.equal(input.password, 'sekrit')
  assert.equal(input.credentialRef, 'keychain:foo')
  assert.equal(input.tunnel.secret, 'tok')
})

test('sanitizeMachineRecord: 空/缺失敏感字段不置标志', () => {
  const out = sanitizeMachineRecord({ transport: 'ssh', password: '', credentialRef: undefined })
  assert.ok(!('passwordSet' in out))
  assert.ok(!('credentialSet' in out))
})

test('sanitizeMachineRecord: provider 自定义 sanitizeMachine 白名单生效，统一剥除仍执行', (t) => {
  const dispose = registerProvider(fakeDef('vt', {
    sanitizeMachine(m) {
      const { secret, ...rest } = m
      return { ...rest, hostname: m.hostname || 'n/a' }
    },
  }))
  t.after(dispose)
  const out = sanitizeMachineRecord({ transport: 'vt', hostname: 'h', secret: 'tok', password: 'pwd' })
  assert.ok(!('secret' in out), '白名单已剔除 secret')
  assert.equal(out.hostname, 'h')
  assert.equal(out.password, '')
  assert.equal(out.passwordSet, true)
})

test('connectMachine: 透传 machine/credentialResolver/signal，返回连接句柄', async (t) => {
  const ac = new AbortController()
  const handle = { identity: 'vt', close: async () => {} }
  const connect = async (args) => {
    assert.equal(args.machine.transport, 'vt')
    assert.equal(args.signal, ac.signal)
    assert.equal(typeof args.credentialResolver, 'function')
    const cred = await args.credentialResolver()
    assert.equal(cred, 'token-1')
    return handle
  }
  const dispose = registerProvider(fakeDef('vt', { connect }))
  t.after(dispose)
  const out = await connectMachine({ transport: 'vt' }, {
    credentialResolver: async () => 'token-1',
    signal: ac.signal,
  })
  assert.equal(out, handle)
})

test('connectMachine: 未提供 opts 时 credentialResolver/signal 为 undefined', async (t) => {
  const seen = []
  const dispose = registerProvider(fakeDef('plain', {
    connect: async (args) => { seen.push(args); return { close: async () => {} } },
  }))
  t.after(dispose)
  await connectMachine({ transport: 'plain' })
  assert.equal(seen[0].credentialResolver, undefined)
  assert.equal(seen[0].signal, undefined)
})

test('connectMachine: 未注册 transport 拒绝', async () => {
  await assert.rejects(connectMachine({ transport: 'ghost' }), /provider not installed/)
})

test('remoteFS 鸭子形状: fs 句柄含 readdir/stat/readFile/writeFile/mkdir 函数', async (t) => {
  const fs = {
    readdir: async () => [],
    stat: async () => ({}),
    readFile: async () => Buffer.alloc(0),
    writeFile: async () => {},
    mkdir: async () => {},
  }
  const dispose = registerProvider(fakeDef('duck', {
    connect: async () => ({ identity: 'duck', fs, close: async () => {} }),
  }))
  t.after(dispose)
  const h = await connectMachine({ transport: 'duck' })
  assert.equal(h.identity, 'duck')
  for (const k of ['readdir', 'stat', 'readFile', 'writeFile', 'mkdir']) {
    assert.equal(typeof h.fs[k], 'function', `fs.${k} 应为函数`)
  }
})