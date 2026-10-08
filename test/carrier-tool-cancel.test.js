import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { registerSshCarrier } from '../lib/ssh-carrier.js'
import { SshPool } from '../lib/pool.js'

test('cancelled carrier write tools never stage or commit destination', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-tool-cancel-'))
  const priorHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome; rmSync(home, { recursive: true, force: true }) })
  const connector = { kind: 'tool-cancel-fixture' }
  t.after(registerSshCarrier({ id: connector.kind, validateConnector() {}, sanitizeConnector: c => c, targetIdentity: () => 'fixture-b', acquire: async () => ({ dialHost: '127.0.0.1', dialPort: 1, targetIdentity: 'fixture-b', generation: '1', closed: new Promise(() => {}), release() {} }) }))
  const cwd = path.join(home, 'remote-workspaces', 'fixture', 'project')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(path.join(home, 'remote-workspaces', 'machines.json'), JSON.stringify({ list: [{ id: 'b', transport: 'ssh', username: 'fixture', connector, expectedHostFingerprint: 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '') }] }))
  writeFileSync(path.join(cwd, '.dsh-remote-meta.json'), JSON.stringify({ schemaVersion: 3, transport: 'ssh', machineId: 'b', connectorTargetIdentity: 'fixture-b', remotePath: '/fixture' }))
  const input = path.join(home, 'input.bin'); writeFileSync(input, 'data')
  const tools = new Map()
  const disposers = []
  const { apply } = await import('../lib/index.js?cancel-tools=' + encodeURIComponent(home))
  await apply({ inject() {}, effect(setup, label) { if (label === 'dsh-remote.routePools') disposers.push(setup()) }, get() {}, tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} } }, { experimentalSshCarrier: true, updateMode: 'off', maxFileBytes: 100000 })
  t.after(() => { for (const dispose of disposers) dispose() })
  let writes = 0
  const original = SshPool.prototype.sftp
  SshPool.prototype.sftp = async () => ({ stat: async () => ({ size: 3, mtime: 1 }), readFile: async () => Buffer.from('old'), writeFile: async () => { writes++ }, fastPut: async () => { writes++ } })
  t.after(() => { SshPool.prototype.sftp = original })
  const controller = new AbortController(); controller.abort()
  const exec = { signal: controller.signal, agent: { session: { header: { cwd } } } }
  for (const [name, args] of [
    ['rw_write_file', { path: '/fixture/a', content: 'new' }],
    ['rw_edit', { path: '/fixture/a', old_string: 'old', new_string: 'new' }],
    ['rw_append', { path: '/fixture/a', content: 'tail' }],
    ['rw_upload', { path: '/fixture/a', localPath: input }],
  ]) await assert.rejects(tools.get(name).execute(args, exec), { code: 'CANCELLED' })
  assert.equal(writes, 0)
})
