// machines add/update 路由 transport 字段单测（Step2，vscode-tunnel 录入路径）。
// 端到端走真实 apply()（沿用 provider-routing.test.mjs 的隔离 DSH_HOME + 假 ctx 登录
// /dsh-remote/machines 路由），断言路由响应与落盘 machines.json；sanitizeMachineRecord
// 剥密行为直接函数单测。无网络、无 ssh2 真实连接。运行：node --test test/machines-transport.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { sanitizeMachineRecord } from '../lib/provider.js'
import { saveSecret, getSecret, deleteSecret, platformBackend } from '../lib/credential.js'
import { registerProvider } from '../lib/provider.js'
import { findMirrorsForRemotePath, machineForMirror } from '../lib/route-machine.js'

/** Isolated DSH_HOME（machines.json 落在 <home>/remote-workspaces/ 下）。 */
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-machines-transport-'))
  mkdirSync(path.join(home, 'remote-workspaces'), { recursive: true })
  const prior = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

/** 加载 apply()（query 参数破 import 缓存，保证每个 home 全新加载）。 */
async function loadPlugin(home) {
  process.env.DSH_HOME = home
  return import(`../lib/index.js?machines-transport=${Math.random()}`)
}

/** 假 ctx：注册全部路由到 Map；其余服务容忍缺位。 */
function makeCtx() {
  const routes = new Map()
  const ctx = {
    effect: () => {},
    get: (name) => (name === 'webServer'
      ? { register: (r) => { routes.set(r.path, r.handler); return () => {} } }
      : undefined),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 5000, connectTimeoutMs: 2000,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

/** 驱动路由：body === null 视为 GET。返回 { status, body }。`url` 默认
 *  /dsh-remote/machines，可传查询串（GET 路由用）。 */
async function callRoute(route, body, method = 'POST', url = '/dsh-remote/machines') {
  // 假 req 必须同时满足两个面：路由按 req.method/req.url 分派，readBody 按 req.on 读流。
  const req = body === null
    ? { method, url, on: () => {} }
    : Object.assign(Readable.from([JSON.stringify(body)]), { method, url })
  let out = null
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (s) => { out = JSON.parse(s) },
  }
  await route(req, res)
  return { status: res.statusCode, body: out }
}

const machinesRoute = (routes) => routes.get('/dsh-remote/machines')
const persisted = (home) => JSON.parse(readFileSync(path.join(home, 'remote-workspaces', 'machines.json'), 'utf8'))

test('① 缺省 transport 保存 → 记录与旧 SSH 完全同形（含 password 原样落盘、无 transport 键）', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)
  assert.ok(route, 'machines route registered')

  const r = await callRoute(route, { action: 'add', name: 'box', host: 'h1', port: 2222, username: 'alice', password: 'pw1', workspace: '/srv/a' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const m = r.body.machine
  assert.equal(m.host, 'h1')
  assert.equal(m.port, 2222)
  assert.equal(m.username, 'alice')
  assert.equal(m.name, 'box')
  assert.equal(m.workspace, '/srv/a')
  assert.equal(m.credentialBackend, 'plain')
  assert.equal(m.passwordSet, true, 'sanitized response marks password set')
  assert.ok(!('password' in m), 'sanitized response has no password key')
  assert.ok(!('transport' in m), 'default transport is NOT persisted as a field — record shape identical to legacy SSH')

  // 落盘形状与旧 SSH 完全一致：password 明文存在（plain 后端），无 transport/tunnel 键。
  const onDisk = persisted(home).list[0]
  assert.equal(onDisk.password, 'pw1')
  assert.equal(onDisk.port, 2222)
  assert.ok(!('transport' in onDisk))
  assert.ok(!('tunnel' in onDisk))

  // 显式 transport:'ssh' 与缺省逐字节同形（两者都不落 transport）。
  const r2 = await callRoute(route, { action: 'add', name: 'box2', host: 'h2', port: 22, username: 'root', transport: 'ssh' })
  assert.equal(r2.status, 200)
  assert.equal(r2.body.machine.host, 'h2')
  assert.ok(!('transport' in r2.body.machine))
  const onDisk2 = persisted(home).list.find((x) => x.host === 'h2')
  assert.ok(!('transport' in onDisk2))
})

test('② transport=vscode-tunnel 保存成功 → transport/tunnel.tunnelId 落盘，host=127.0.0.1，username=""，port=0，无 password 字段', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)

  const r = await callRoute(route, { action: 'add', name: 'my-tunnel', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tun-abc-123', cluster: 'us', remoteIdentity: 'dev-box' }, workspace: '/srv/t' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const m = r.body.machine
  assert.equal(m.transport, 'vscode-tunnel')
  assert.equal(m.tunnel.tunnelId, 'tun-abc-123')
  assert.equal(m.tunnel.cluster, 'us')
  assert.equal(m.tunnel.remoteIdentity, 'dev-box')
  assert.equal(m.host, '127.0.0.1')
  assert.equal(m.username, '')
  assert.equal(m.port, 0)
  assert.equal(m.workspace, '/srv/t')
  assert.equal(m.credentialBackend, 'plain')
  assert.ok(!('password' in m), 'tunnel record carries no password key')
  assert.equal(m.passwordSet, false, 'legacy flag present but false — nothing set')

  const onDisk = persisted(home).list[0]
  assert.equal(onDisk.transport, 'vscode-tunnel')
  assert.deepEqual(onDisk.tunnel, { tunnelId: 'tun-abc-123', cluster: 'us', remoteIdentity: 'dev-box' })
  assert.equal(onDisk.host, '127.0.0.1')
  assert.equal(onDisk.username, '')
  assert.equal(onDisk.port, 0)
  assert.ok(!('password' in onDisk), 'persisted tunnel record has no password')
  assert.ok(!('credentialRef' in onDisk))

  // GET /machines 下发同样不泄露（同一 sanitize 路径）。
  const g = await callRoute(route, null, 'GET')
  assert.equal(g.status, 200)
  const gm = g.body.machines[0]
  assert.equal(gm.transport, 'vscode-tunnel')
  assert.equal(gm.tunnel.tunnelId, 'tun-abc-123')
  assert.ok(!('password' in gm) && !('credentialRef' in gm))

  // 必填校验：缺 name / 缺 tunnelId → 400。
  const noName = await callRoute(route, { action: 'add', transport: 'vscode-tunnel', tunnel: { tunnelId: 'x' } })
  assert.equal(noName.status, 400)
  assert.match(noName.body.error, /name required/)
  const noTid = await callRoute(route, { action: 'add', name: 't', transport: 'vscode-tunnel', tunnel: {} })
  assert.equal(noTid.status, 400)
  assert.match(noTid.body.error, /tunnel\.tunnelId required/)
  const noTid2 = await callRoute(route, { action: 'add', name: 't', transport: 'vscode-tunnel' })
  assert.equal(noTid2.status, 400)
  assert.match(noTid2.body.error, /tunnel\.tunnelId required/)
})

test('③ tunnel 机器误传 SSH 字段（host/port/username/password/proxy 等）→ 忽略不落盘，绝不混存', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)

  const r = await callRoute(route, {
    action: 'add', name: 't', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-1' },
    host: 'evil.example', port: 2222, username: 'mallory', password: 'hunter2',
    privateKeyPath: '/home/m/.ssh/id', passphrase: 'pp', hostKeyMode: 'verify',
    useAgent: true, keyboardInteractive: true,
    proxy: { host: 'jump.example', port: 22, username: 'j', password: 'jump-pw' },
  })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const m = r.body.machine
  assert.equal(m.host, '127.0.0.1', 'placeholder host, SSH host ignored')
  assert.equal(m.username, '')
  assert.equal(m.port, 0)
  assert.ok(!('password' in m))
  assert.ok(!('privateKeyPath' in m))
  assert.ok(!('passphrase' in m))
  assert.ok(!('proxy' in m))
  assert.ok(!('hostKeyMode' in m))

  const onDisk = persisted(home).list[0]
  assert.equal(onDisk.host, '127.0.0.1')
  assert.ok(!('password' in onDisk))
  assert.ok(!('proxy' in onDisk))
  assert.ok(!('privateKeyPath' in onDisk))
  assert.ok(!('hostKeyMode' in onDisk))
  assert.equal(Object.keys(onDisk).sort().join(','),
    'credentialBackend,host,id,lastConnectedAt,latencyMs,name,port,recentWorkspaces,transport,tunnel,username,workspace',
    'exact persisted key set — no SSH-only key can sneak in')
})

test('④ 未知 transport → 400（错误信息明确）', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)

  for (const bad of ['rdp', 'telnet', 'VSCode-Tunnel', 5]) {
    const r = await callRoute(route, { action: 'add', name: 'x', host: 'h', transport: bad })
    assert.equal(r.status, 400, `transport=${JSON.stringify(bad)}`)
    assert.match(String(r.body.error), /unsupported transport/, `transport=${JSON.stringify(bad)}`)
  }
  // 400 不落任何记录（尚无成功保存 → GET 列表为空）。
  const g = await callRoute(route, null, 'GET')
  assert.equal(g.status, 200)
  assert.equal(g.body.machines.length, 0)
})

test('⑤ update 时变更 transport → 400；同 transport update 正常', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)

  const tunnel = await callRoute(route, { action: 'add', name: 't1', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-1' } })
  assert.equal(tunnel.status, 200)
  const tid = tunnel.body.machine.id

  // 隧道 → SSH：400。
  const toSsh = await callRoute(route, { action: 'update', id: tid, transport: 'ssh', host: 'h1' })
  assert.equal(toSsh.status, 400)
  assert.match(toSsh.body.error, /transport cannot change/)

  const ssh = await callRoute(route, { action: 'add', name: 's1', host: 'h1' })
  assert.equal(ssh.status, 200)
  const sid = ssh.body.machine.id

  // SSH → 隧道：400。
  const toTunnel = await callRoute(route, { action: 'update', id: sid, transport: 'vscode-tunnel', tunnel: { tunnelId: 'x' } })
  assert.equal(toTunnel.status, 400)
  assert.match(toTunnel.body.error, /transport cannot change/)

  // 同 transport 的 update 正常（隧道改名/换 tunnelId；SSH 改名）。
  const upT = await callRoute(route, { action: 'update', id: tid, name: 't1-renamed', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-2', cluster: 'eu' } })
  assert.equal(upT.status, 200, JSON.stringify(upT.body))
  assert.equal(upT.body.machine.name, 't1-renamed')
  assert.equal(upT.body.machine.tunnel.tunnelId, 'tid-2')
  assert.equal(upT.body.machine.tunnel.cluster, 'eu')
  // update 未带 tunnel → 回退已存值。
  const upT2 = await callRoute(route, { action: 'update', id: tid, name: 't1-again', transport: 'vscode-tunnel' })
  assert.equal(upT2.status, 200)
  assert.equal(upT2.body.machine.tunnel.tunnelId, 'tid-2')

  const upS = await callRoute(route, { action: 'update', id: sid, name: 's1-renamed', host: 'h1' })
  assert.equal(upS.status, 200)
  assert.equal(upS.body.machine.name, 's1-renamed')
  assert.equal(upS.body.machine.host, 'h1')
})

test('⑥ 删除隧道机器 → 正常，不留孤儿记录', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)

  const a = await callRoute(route, { action: 'add', name: 'keep', host: 'h1' })
  const b = await callRoute(route, { action: 'add', name: 'gone', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-x' } })
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  const bid = b.body.machine.id

  const d = await callRoute(route, { action: 'delete', id: bid })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  assert.ok(!d.body.machines.some((m) => m.id === bid), 'response list no longer contains the tunnel machine')
  assert.ok(d.body.machines.some((m) => m.id === a.body.machine.id), 'SSH machine untouched')
  assert.equal(persisted(home).list.length, 1, 'registry on disk keeps exactly the remaining machine')

  const g = await callRoute(route, null, 'GET')
  assert.equal(g.body.machines.length, 1)
  assert.equal(g.body.machines[0].id, a.body.machine.id)
})

test('⑦ sanitizeMachineRecord 对含 tunnel.secret/credentialRef 的隧道记录剥离（不下发任何秘密）', () => {
  const dirty = {
    id: 'm-x', name: 't', transport: 'vscode-tunnel', host: '127.0.0.1', username: '', port: 0,
    tunnel: { tunnelId: 'tid-secret-1', secret: 'the-secret-token', remoteIdentity: 'box' },
    credentialRef: 'keychain-ref-xyz', password: 'a-password',
  }
  const clean = sanitizeMachineRecord(dirty)
  assert.equal(clean.transport, 'vscode-tunnel')
  assert.equal(clean.tunnel.tunnelId, 'tid-secret-1')
  assert.equal(clean.tunnel.secret, '', 'tunnel.secret blanked')
  assert.equal(clean.tunnel.secretSet, true, 'secret presence flagged')
  assert.equal(clean.tunnel.remoteIdentity, 'box', 'non-secret tunnel fields pass through')
  assert.equal(clean.credentialRef, '', 'credentialRef blanked')
  assert.equal(clean.credentialSet, true)
  assert.equal(clean.password, '')
  assert.equal(clean.passwordSet, true)
  // 原记录不被改写（sanitize 返回新对象）。
  assert.equal(dirty.tunnel.secret, 'the-secret-token')
})
test('⑧ 非法 tunnel.secret 格式 → 400 且不落盘', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)

  // 非空非法值逐一 POST add：'' 视为"未提供秘密"（正常 add 语义，非 400）。
  const badSecrets = ['', 'zz', 'a'.repeat(63), 'A'.repeat(64)].filter((s) => s !== '')
  for (const bad of badSecrets) {
    const r = await callRoute(route, { action: 'add', name: 't-bad', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-s', secret: bad } })
    assert.equal(r.status, 400, `secret ${JSON.stringify(bad.slice(0, 4))}… should be rejected`)
    assert.ok(String(r.body.error).includes('64-hex'), `error mentions 64-hex, got: ${JSON.stringify(r.body.error)}`)
  }

  const g = await callRoute(route, null, 'GET')
  assert.equal(g.body.machines.length, 0, 'none of the 400-adds persisted a machine')
})

test('⑨ 合法 secret → 经 OS 凭据库落盘、不下发、删除清理', async (t) => {
  const home = fixture(t)
  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)
  const secretsDir = path.join(home, 'remote-workspaces', '.secrets')

  const probeId = 'm-probe-del'
  const probeSecret = 'p'.repeat(64)
  let machineId = null
  t.after(async () => {
    // 兜底清理（探测 id + 机器 id），防测试失败残留。
    await deleteSecret(probeId, secretsDir).catch(() => {})
    if (machineId) await deleteSecret(machineId, secretsDir).catch(() => {})
  })

  // 先探测后端可用性：save/get/delete 往返取不回 → 环境无可用凭据后端（如沙箱拒绝
  // security/secret-tool），跳过 Keychain 落盘断言。
  const probeSaved = await saveSecret(probeId, probeSecret, secretsDir)
  const probeGot = probeSaved.ok ? await getSecret(probeId, secretsDir) : null
  await deleteSecret(probeId, secretsDir).catch(() => {})
  if (!probeSaved.ok || probeGot !== probeSecret) {
    t.skip('OS 凭据后端不可用，跳过 Keychain 落盘断言')
    return
  }

  const secretA = 'a'.repeat(64)
  const a = await callRoute(route, { action: 'add', name: 't-sec', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-sec-1', secret: secretA } })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  machineId = a.body.machine.id
  assert.equal(a.body.machine.tunnel.secretSet, true, 'secretSet flagged in response')
  assert.ok(!('secret' in a.body.machine.tunnel), 'response tunnel carries no secret key')
  assert.equal(a.body.machine.credentialBackend, platformBackend(), 'credentialBackend is the real OS backend')

  // 落盘 machines.json：隧道记录无 'secret' 键（明文绝不离盘）。
  const onDisk = persisted(home).list.find((m) => m.id === machineId)
  assert.ok(onDisk, 'machine on disk')
  assert.ok(!('secret' in onDisk.tunnel), 'persisted tunnel record has no secret key')
  assert.equal(onDisk.tunnel.secretSet, true)

  // 取用侧语义：credentialBackend!=='plain' → getSecret 成立（machinePassword 走同一条路）。
  assert.equal(await getSecret(machineId, secretsDir), secretA, 'secret retrievable via getSecret')

  // update 不带 secret（仅改名）→ secretSet 沿用。
  const up1 = await callRoute(route, { action: 'update', id: machineId, name: 't-sec-renamed', transport: 'vscode-tunnel' })
  assert.equal(up1.status, 200, JSON.stringify(up1.body))
  assert.equal(up1.body.machine.tunnel.secretSet, true, 'secretSet kept on update without secret')

  // update 带新 secret → 覆盖。
  const secretB = 'b'.repeat(64)
  const up2 = await callRoute(route, { action: 'update', id: machineId, name: 't-sec-renamed', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-sec-1', secret: secretB } })
  assert.equal(up2.status, 200, JSON.stringify(up2.body))
  assert.equal(await getSecret(machineId, secretsDir), secretB, 'secret overwritten')

  // delete → 清理。
  const d = await callRoute(route, { action: 'delete', id: machineId })
  assert.equal(d.status, 200, JSON.stringify(d.body))
  assert.equal(await getSecret(machineId, secretsDir), null, 'secret purged after machine delete')
})

test('⑩ 端到端：vscode-tunnel 机器 → /dsh-remote/mirror 落 meta v2（tunnel-<machineId> 键、无 SSH 归一化痕迹）；机器删除后路由严格拒绝、绝不借占位三元组猜他机', async (t) => {
  const home = fixture(t)
  const root = path.join(home, 'remote-workspaces')
  const remoteRoot = path.join(home, 'remote-root', 'e2e-proj')
  mkdirSync(remoteRoot, { recursive: true })

  // ── inline 极简假 Worker（node:http）：/v1/pair + /v1/info + /v1/fs/stat，其余 501 ──
  const workerHits = []
  const worker = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0]
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (url === '/v1/pair' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        workerHits.push({ url, body: JSON.parse(body || '{}') })
        send(200, { ok: true, token: 'tok-e2e-' + Math.random().toString(16).slice(2) })
      })
      return
    }
    if (url === '/v1/info' && req.method === 'GET') {
      workerHits.push({ url })
      send(200, {
        protocolVersion: 1, instanceId: 'inst-e2e',
        remoteIdentity: { machineId: 'rmt-e2e' },
        roots: [remoteRoot], platform: 'darwin',
      })
      return
    }
    if (url === '/v1/fs/stat' && req.method === 'POST') {
      workerHits.push({ url })
      send(200, { ok: true, stat: { type: 'directory', size: 0, mtime: 0 } })
      return
    }
    res.writeHead(501)
    res.end()
  })
  const workerPort = await new Promise((resolve) => worker.listen(0, '127.0.0.1', () => resolve(worker.address().port)))

  // ── fake vscode-tunnel provider：真实走假 Worker 握手（pair 换 token → info）──
  // 端口经测试闭包获得：machines 路由按既有契约（②/③）把 tunnel 记录 port 恒落 0，
  // 真实 provider 的本地端口由 vscode 扩展带外下发 —— 此处以闭包等价模拟。
  const providerState = { connectCount: 0, machines: [], credentials: [] }
  const disposeProvider = registerProvider({
    id: 'vscode-tunnel',
    label: 'VSCode Tunnel (fake worker)',
    connect: async (args) => {
      providerState.connectCount += 1
      providerState.machines.push(args.machine)
      const cred = typeof args.credentialResolver === 'function' ? await args.credentialResolver() : ''
      providerState.credentials.push(cred)
      // 握手：配对秘密 → token → info（roots/platform）。
      const pair = await fetch(`http://127.0.0.1:${workerPort}/v1/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: cred }),
      })
      if (!pair.ok) throw new Error('pair failed: HTTP ' + pair.status)
      const { token } = await pair.json()
      const info = await (
        await fetch(`http://127.0.0.1:${workerPort}/v1/info`, { headers: { authorization: 'Bearer ' + token } })
      ).json()
      await fetch(`http://127.0.0.1:${workerPort}/v1/fs/stat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/' }),
      })
      return {
        identity: { machineId: args.machine.id, transport: 'vscode-tunnel' },
        capabilities: { fs: true, exec: true, pty: true },
        status: () => ({ connected: true }),
        platform: info.platform || 'unknown',
        client: null, fs: null, jobs: null,
        invalidate: () => {},
        detect: async () => {},
        sftp: async () => ({
          stat: async () => ({ isDirectory: () => true, type: 'directory' }),
          readdir: async () => [],
          readFile: async () => Buffer.alloc(0),
          writeFile: async () => {}, mkdir: async () => {},
          unlink: async () => {}, rename: async () => {}, rmdir: async () => {},
          fastGet: async () => {}, fastPut: async () => {},
        }),
        exec: async (command) => ({ code: 0, stdout: 'ok', stderr: '' }),
        close: () => {},
      }
    },
  })

  const extraIds = []
  t.after(async () => {
    disposeProvider()
    await new Promise((resolve) => { try { worker.close(resolve) } catch { resolve() } })
    for (const id of extraIds) await deleteSecret(id, path.join(root, '.secrets')).catch(() => {})
  })

  // 凭据后端可用性探测（与 ⑨ 同策略）：saveSecret 不可用 → 整用例 t.skip。
  const probeId = 'm-e2e-probe'
  const probeSecret = 'e'.repeat(64)
  const secretsDir = path.join(root, '.secrets')
  const probeSaved = await saveSecret(probeId, probeSecret, secretsDir)
  const probeGot = probeSaved.ok ? await getSecret(probeId, secretsDir) : null
  await deleteSecret(probeId, secretsDir).catch(() => {})
  if (!probeSaved.ok || probeGot !== probeSecret) {
    t.skip('OS 凭据后端不可用，跳过端到端 mirror 路由测试（与 ⑨ 同策略）')
    return
  }

  const { apply } = await loadPlugin(home)
  const { ctx, routes } = makeCtx()
  await apply(ctx, { ...CONFIG })
  const route = machinesRoute(routes)
  const mirrorRoute = routes.get('/dsh-remote/mirror')
  const gitWsRoute = routes.get('/dsh-remote/git-workspace')
  assert.ok(route && mirrorRoute && gitWsRoute, 'routes registered')

  const secret = 'c'.repeat(64)
  const add = await callRoute(route, {
    action: 'add', name: 'e2e-mac', transport: 'vscode-tunnel',
    tunnel: { tunnelId: 'tid-e2e', secret }, workspace: remoteRoot,
  })
  assert.equal(add.status, 200, JSON.stringify(add.body))
  const machineId1 = add.body.machine.id
  extraIds.push(machineId1)
  assert.equal(add.body.machine.port, 0, '路由契约：tunnel 记录 port 恒为 0')

  // ── /dsh-remote/mirror：选隧道机器建镜像 ──
  const mirrorRes = await callRoute(mirrorRoute, { path: remoteRoot, machine: machineId1 })
  assert.equal(mirrorRes.status, 200, JSON.stringify(mirrorRes.body))
  const localMirror = mirrorRes.body.localMirror
  assert.equal(localMirror, path.join(root, 'tunnel-' + machineId1, 'e2e-proj'),
    'localMirror 落在 <root>/tunnel-<machineId>/<base> 下: ' + localMirror)
  assert.ok(!localMirror.includes('127.0.0.1'), '镜像路径无 SSH 归一化键')

  // 交叉断言：旧的「选隧道机器却生成 127.0.0.1-root-22 键」场景不复现。
  const placeholders = readdirSync(root).filter((n) => /^127\.0\.0\.1/.test(n))
  assert.deepEqual(placeholders, [], '未创建任何 127.0.0.1-*-* 空壳键目录')
  assert.ok(readdirSync(root).includes('tunnel-' + machineId1), '镜像根为 tunnel-<machineId>')

  // 落盘 .dsh-remote-meta.json 为 v2：transport/machineId/schemaVersion 正确、无 SSH 归一化痕迹。
  const meta = JSON.parse(readFileSync(path.join(localMirror, '.dsh-remote-meta.json'), 'utf8'))
  assert.equal(meta.schemaVersion, 2)
  assert.equal(meta.transport, 'vscode-tunnel')
  assert.equal(meta.machineId, machineId1)
  assert.equal(meta.port, 0, 'meta.port = 原始 0（不是 22）')
  assert.equal(meta.username, '', 'meta.username = 原始 ""（不是 root）')
  assert.equal(meta.host, '127.0.0.1')
  assert.equal(meta.remotePath, remoteRoot)
  assert.equal(typeof meta.createdAt, 'string')
  assert.ok(!('remoteIdentity' in meta), '未提供 remoteIdentity 时 v2 meta 不落该键')

  // provider 真实建连 + credentialResolver 从 Keychain 取到 64-hex 配对秘密。
  assert.equal(providerState.connectCount, 1, 'mirror 路由经 provider 建连恰好一次')
  assert.equal(providerState.machines[0].id, machineId1, 'provider 拿到的是被选中的机器记录')
  assert.equal(providerState.credentials[0], secret, 'credentialResolver 链路取到 Keychain 里的 64-hex 秘密')
  const pairBody = workerHits.find((h) => h.url === '/v1/pair')
  assert.ok(pairBody, '假 Worker 收到 pair 握手')
  assert.equal(pairBody.body.secret, secret, '握手秘密与 Keychain 一致')

  // 该镜像可经 route-machine 解析回该机器记录。
  const entries = findMirrorsForRemotePath(root, remoteRoot)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].transport, 'vscode-tunnel')
  assert.equal(entries[0].machineId, machineId1)
  const resolved = machineForMirror(entries[0], [add.body.machine])
  assert.equal(resolved.record.id, machineId1, 'machineForMirror 把 v2 镜像解析回原机器记录')

  // ── 机器删除后：路由严格降级为「无标记」，绝不借占位 host/port/user 三元组猜其他隧道机器 ──
  // 第二台隧道机器与 m1 共享完全相同的占位三元组 —— 旧 machineByTarget 式宽松
  // 查找会命中它；machineForMirror 按 machineId 判定必须拒绝（v2 占位三元组
  // 相同是常态，孤儿镜像绝不能被洗成另一台隧道机器的 SSH 形记录）。
  const add2 = await callRoute(route, {
    action: 'add', name: 'e2e-mac-2', transport: 'vscode-tunnel', tunnel: { tunnelId: 'tid-e2e-2' },
  })
  assert.equal(add2.status, 200, JSON.stringify(add2.body))
  const machineId2 = add2.body.machine.id
  extraIds.push(machineId2)
  const del = await callRoute(route, { action: 'delete', id: machineId1 })
  assert.equal(del.status, 200, JSON.stringify(del.body))
  assert.equal(providerState.connectCount, 1, '删除本身不触发建连')

  // ?local=（git-workspace local 分支，mirrorMatchOf → machineForMirror）→ 200
  // marker:null：机器删除后镜像成为孤儿（mirror 目录按设计保留在磁盘），
  // marker 降级为「无」——与「非镜像本地路径」同语义，绝不报错。消费者
  // （dsh-remote 自身与 dsh-enhanced-workspace 的浏览器半）探测所有工作区
  // 与 session cwd，残留 cwd 落在孤儿镜像内时必须静默。
  const g1 = await callRoute(gitWsRoute, null, 'GET', '/dsh-remote/git-workspace?local=' + encodeURIComponent(localMirror))
  assert.equal(g1.status, 200, JSON.stringify(g1.body))
  assert.equal(g1.body.ok, true, JSON.stringify(g1.body))
  assert.equal(g1.body.marker, null, JSON.stringify(g1.body))

  // ?path=（routePoolOf）→ 500 cannot serve … not saved（沿用响亮失败语义）。
  const g2 = await callRoute(gitWsRoute, null, 'GET', '/dsh-remote/git-workspace?path=' + encodeURIComponent(remoteRoot))
  assert.equal(g2.status, 500, JSON.stringify(g2.body))
  assert.match(g2.body.error, /cannot serve .*owning machine vscode-tunnel:.* is not saved in the dsh-remote machine registry/)

  // 拒绝发生在任何 provider 建连之前 —— 没有为幽灵机编造 SSH/ad-hoc 连接。
  assert.equal(providerState.connectCount, 1, '幽灵拒绝路径不得触发任何新 connect')
})
