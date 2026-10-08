// Authorized A experiment: isolated framework runtime, pinned external carrier,
// agent auth only; no product profile/browser replacement. Remote writes only
// with explicit DSH_EXPERIMENT_WRITE=1 in fresh dedicated temporary directories.
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { ManagedTerminalManager } from '../lib/managed-terminal.js'
const tunnelId = process.env.DSH_EXPERIMENT_TUNNEL
if (!tunnelId || !/^[a-z0-9][a-z0-9-]+\.[a-z0-9]+$/.test(tunnelId)) throw new Error('explicit DSH_EXPERIMENT_TUNNEL required')
const payloadBytes = Number(process.env.DSH_EXPERIMENT_BYTES || 65536)
if (!Number.isInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > 8388608) throw new Error('DSH_EXPERIMENT_BYTES must be 1..8388608')
const operationTimeout = 15000 // Transfers now use their separate bounded deadline.
const port = Number(process.env.DSH_EXPERIMENT_PORT)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('explicit DSH_EXPERIMENT_PORT required')
const home = mkdtempSync(path.resolve('.dsh/a-experiment-'))
process.env.DSH_HOME = home
process.env.DSH_REMOTE_HEARTBEAT_URL = 'https://127.0.0.1:9/heartbeat-disabled-in-tests'
const remote = await import('../lib/index.js')
const carrierApi = await import('../lib/ssh-carrier.js')
const plugin = await import('../../dsh-remote-vscode/packages/devtunnel-ssh/lib/index.js')
const tools = new Map(), routes = new Map(), commands = new Map()
let experimentCwd = ''
const root = new Context()
let services, carrier, runtime
const results = { home, port, tunnelId, stages: [], browserTested: false, productProfileChanged: false }
async function route(url, body) {
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), { method: body ? 'POST' : 'GET', url })
  let data, status
  await routes.get(url.split('?')[0])(req, { setHeader() {}, set statusCode(v) { status = v }, get statusCode() { return status }, end(s) { data = JSON.parse(s) } })
  return { status, data }
}
try {
  services = await root.plugin({ name: 'a-experiment-services', apply(ctx) {
    ctx.provide('tools', { register: t => tools.set(t.name, t) })
    ctx.provide('systemPrompt', { section() {} })
    ctx.provide('sessions', { get(id) { return id === 'a-experiment-session' && experimentCwd ? { header: { cwd: experimentCwd } } : null }, list() { return [] } })
    ctx.provide('commands', { register(c) { commands.set(c.name, c); return () => commands.delete(c.name) } })
    ctx.provide('webServer', { register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path) } })
  } })
  carrier = await root.plugin({ name: plugin.name, apply: ctx => plugin.applyWithLoader(ctx, async () => carrierApi) })
  runtime = await root.plugin(remote, { experimentalSshCarrier: true, host: '', updateMode: 'off', autoPush: false, auditLog: false, commandTimeoutMs: operationTimeout, connectTimeoutMs: 10000 })
  const added = await route('/dsh-remote/machines', { action: 'add', id: 'a-experiment-mac-b', name: 'B read-only experiment', username: 'havocrao', useAgent: true,
    expectedHostFingerprint: 'SHA256:MULbTDMznUed/g2TRjkEEKOIQUSQ/hCRGQ/saqn/wCQ',
    connector: { kind: 'devtunnel', mode: 'external', tunnelId, remotePort: 22, endpoint: { host: '127.0.0.1', port } } })
  if (added.status !== 200) throw new Error(added.data.error)
  results.stages.push({ stage: 'isolated-CRUD', ok: true })
  const probe = await route('/dsh-remote/test-connect', { id: 'a-experiment-mac-b' })
  results.stages.push({ stage: 'real-agent-pinned-probe', ...probe })
  if (!probe.data.ok) throw new Error(probe.data.error)
  // Local-only mirror fixture for invoking actual session-bound tools. Does not
  // synchronize or alter the remote home directory.
  const mirror = path.join(home, 'remote-workspaces', 'readonly-mirror', 'project')
  mkdirSync(mirror, { recursive: true })
  const target = carrierApi.sshConnectorTargetIdentity(added.data.machine.connector)
  writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({ schemaVersion: 3, transport: 'ssh', machineId: 'a-experiment-mac-b', connectorTargetIdentity: target, username: 'havocrao', remotePath: '/Users/havocrao' }))
  experimentCwd = mirror
  const exec = { agent: { session: { header: { cwd: mirror } } } }
  const output = await tools.get('rw_exec').execute({ command: 'hostname; whoami; uname -s; pwd' }, exec)
  results.stages.push({ stage: 'real-session-rw-exec', output })
  const listed = await tools.get('rw_list_dir').execute({ path: '/tmp' }, exec)
  results.stages.push({ stage: 'real-session-sftp-list', output: listed })
  if (process.env.DSH_EXPERIMENT_WRITE === '1') {
    // User-authorized extended experiment; only fresh dedicated temp paths.
    const createdDir = await tools.get('rw_exec').execute({ command: 'mktemp -d /tmp/dsh-a-functional.XXXXXX' }, exec)
    const remoteDir = createdDir.text.trim()
    if (!/^\/tmp\/dsh-a-functional\.[A-Za-z0-9]+$/.test(remoteDir)) throw new Error('unexpected remote test directory: ' + remoteDir)
    results.remoteTestDir = remoteDir
    const textPath = remoteDir + '/中文 编辑.txt'
    const written = await tools.get('rw_write_file').execute({ path: textPath, content: '实验起点\nline-two\n' }, exec)
    const edited = await tools.get('rw_edit').execute({ path: textPath, old_string: '实验起点', new_string: '编辑成功' }, exec)
    const read = await tools.get('rw_read_file').execute({ path: textPath }, exec)
    if (!read.text.includes('编辑成功')) throw new Error('text edit verification failed')
    results.stages.push({ stage: 'real-text-write-edit-read', written, edited, read })
    const appended = await tools.get('rw_append').execute({ path: textPath, content: '追加验证\n' }, exec)
    const afterAppend = await tools.get('rw_read_file').execute({ path: textPath }, exec)
    if (!afterAppend.text.includes('追加验证')) throw new Error('append verification failed')
    const conflict = await route('/dsh-remote/write?sessionId=a-experiment-session', { path: textPath, content: 'MUST_NOT_REPLACE', expectedContent: 'stale baseline' })
    if (conflict.status !== 409) throw new Error('stale baseline save was not rejected')
    const afterConflict = await tools.get('rw_read_file').execute({ path: textPath }, exec)
    if (afterConflict.text.includes('MUST_NOT_REPLACE') || !afterConflict.text.includes('追加验证')) throw new Error('conflict clobbered target')
    results.stages.push({ stage: 'real-append-and-conflict-preservation', appended, afterAppend, conflict, afterConflict })
    const payload = randomBytes(payloadBytes)
    const localInput = path.join(home, 'binary-64k.bin')
    const localOutput = path.join(home, 'binary-returned.bin')
    writeFileSync(localInput, payload)
    const remotePath = remoteDir + '/中文 二进制.bin'
    const start = Date.now()
    const uploaded = await tools.get('rw_upload').execute({ localPath: localInput, path: remotePath }, exec)
    const uploadMs = Date.now() - start
    const downloadStart = Date.now()
    const downloaded = await tools.get('rw_download').execute({ path: remotePath, localPath: localOutput }, exec)
    const returned = readFileSync(localOutput)
    const hash = bytes => createHash('sha256').update(bytes).digest('hex')
    if (!payload.equals(returned)) throw new Error('binary roundtrip mismatch')
    results.stages.push({ stage: 'real-binary-roundtrip', uploaded, downloaded, uploadMs, downloadMs: Date.now() - downloadStart, sha256: hash(payload), returnedSha256: hash(returned), bytes: returned.length })
    const mirrorReply = await route('/dsh-remote/mirror', { path: remoteDir, machine: 'a-experiment-mac-b', workspace: mirror })
    if (mirrorReply.status !== 200) throw new Error('test directory mirror bind failed')
    const syncCwd = mirrorReply.data.localMirror
    const syncExec = { agent: { session: { header: { cwd: syncCwd } } } }
    const synced = await tools.get('rw_sync').execute({ maxFiles: 10, depth: 1 }, syncExec)
    const localEdited = path.join(syncCwd, '中文 编辑.txt')
    const syncedText = readFileSync(localEdited, 'utf8')
    if (!syncedText.includes('追加验证')) throw new Error('sync text mismatch')
    writeFileSync(localEdited, syncedText + '镜像推送验证\n')
    const pushed = await tools.get('rw_push').execute({ maxFiles: 10 }, syncExec)
    const pushedRead = await tools.get('rw_read_file').execute({ path: textPath }, syncExec)
    if (!pushedRead.text.includes('镜像推送验证')) throw new Error('push readback failed')
    results.stages.push({ stage: 'real-mirror-sync-atomic-push-readback', synced, pushed, pushedRead })
  }
  const { createCarrierSshPool } = await import('../lib/ssh-carrier-pool.js')
  const machine = { ...added.data.machine, password: '', passphrase: '' }
  const terminalPool = await createCarrierSshPool(machine, { connectTimeoutMs: 10000, commandTimeoutMs: 15000, maxOutputChars: 12000 })
  try {
    const { channel, end } = await terminalPool.openPty({ rows: 30, cols: 100, cwd: '/Users/havocrao' })
    let transcript = ''
    const waitFor = async marker => {
      const deadline = Date.now() + 20000
      while (!transcript.includes(marker)) {
        if (Date.now() > deadline) throw new Error('PTY marker timeout: ' + marker)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    channel.on('data', data => { transcript += data.toString(); if (transcript.length > 20000) transcript = transcript.slice(-20000) })
    channel.on('error', () => {})
    channel.write("printf '\\n%s%s\\n' '__DSH_' 'BEGIN__'; hostname; whoami; tty; stty size; printf '%s%s\\n' '__DSH_' 'READY__'\r")
    await waitFor('__DSH_READY__')
    channel.setWindow(41, 132, 0, 0)
    channel.write("stty size; printf '%s%s\\n' '__DSH_' 'RESIZED__'\r")
    await waitFor('__DSH_RESIZED__')
    end()
    results.stages.push({ stage: 'real-carrier-pty-identity-resize', transcript })
  } finally { await terminalPool.close() }
  const dataPool = await createCarrierSshPool(machine, { connectTimeoutMs: 10000, commandTimeoutMs: 15000, maxOutputChars: 12000 })
  const manager = new ManagedTerminalManager({ getPool: async () => dataPool, config: {} })
  const owner = { machineId: machine.id, workspace: '/Users/havocrao', key: JSON.stringify([machine.id, '/Users/havocrao', target]) }
  class View extends EventEmitter {
    readyState = 1; bufferedAmount = 0; frames = []
    send(data) { this.frames.push(JSON.parse(data)) }
    close() { this.readyState = 3; this.emit('close') }
  }
  try {
    const info = await manager.create(owner, 'a-experiment-session', 'real managed data test')
    const view = new View()
    manager.attach(view, owner, info.terminalId, { rows: 32, cols: 104 })
    const output = () => view.frames.filter(f => f.type === 'output').map(f => f.data).join('')
    const awaitOutput = async marker => {
      const deadline = Date.now() + 20000
      while (!output().includes(marker)) {
        if (Date.now() > deadline) throw new Error('managed data marker timeout: ' + marker)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    view.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: "hostname; whoami; stty size; printf '%s%s\\n' '__MANAGED_' 'READY__'\r" })))
    await awaitOutput('__MANAGED_READY__')
    view.emit('message', Buffer.from(JSON.stringify({ type: 'resize', rows: 43, cols: 134 })))
    view.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: "stty size; printf '%s%s\\n' '__MANAGED_' 'RESIZED__'\r" })))
    await awaitOutput('__MANAGED_RESIZED__')
    const transcript = output()
    if (!transcript.includes('HAVOCRAO-MC1') || !transcript.includes('43 134')) throw new Error('managed identity/resize output missing')
    manager.terminate(owner, info.terminalId)
    if (manager.list(owner).terminals.length !== 0) throw new Error('managed termination retained live terminal')
    results.stages.push({ stage: 'real-managed-data-input-output-resize-terminate', transcript, browserWebSocket: false, websocketBoundary: 'in-process-view-adapter', frameTypes: [...new Set(view.frames.map(f => f.type))] })
  } finally { manager.closeAll(); await dataPool.close() }
  const created = await route('/dsh-remote/workspace-terminals/create', { sessionId: 'a-experiment-session', title: 'A live isolated experiment' })
  results.stages.push({ stage: 'real-managed-terminal-create', ...created })
  if (created.status !== 200) throw new Error(created.data.error || JSON.stringify(created.data))
  const terminalId = created.data.terminalId
  try {
    const listedTerminals = await route('/dsh-remote/workspace-terminals/list', { sessionId: 'a-experiment-session' })
    results.stages.push({ stage: 'real-managed-terminal-list', ...listedTerminals })
    if (listedTerminals.status !== 200) throw new Error('managed list failed')
  } finally {
    const terminated = await route('/dsh-remote/workspace-terminals/terminate', { sessionId: 'a-experiment-session', terminalId })
    results.stages.push({ stage: 'real-managed-terminal-terminate', ...terminated })
    if (terminated.status !== 200) throw new Error('managed terminate failed')
  }
  console.log(JSON.stringify(results, null, 2))
} catch (error) {
  results.error = String(error.message || error)
  console.log(JSON.stringify(results, null, 2))
  process.exitCode = 1
} finally {
  await runtime?.dispose()
  await carrier?.dispose()
  await services?.dispose()
  writeFileSync(path.join(home, 'readonly-results.json'), JSON.stringify(results, null, 2))
}
