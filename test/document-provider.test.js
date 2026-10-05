import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createFsRoutes } from '../lib/routes-fs.js'
import { MemFs, makeSftp, seed } from './helpers.js'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const seam = source.slice(source.indexOf('    function registerRemoteDocumentProvider('), source.indexOf('    function readRemoteFile('))
function load(fetch) {
  const context = { fetch, apiPath: p => p, remoteDocumentScope: scope => scope, sessionIsRemote: cwd => cwd === '/mirror', SIDEBAR_FILE_ID: 'dsh-remote:file' }
  vm.createContext(context)
  vm.runInContext(seam, context)
  return context
}

test('document provider pins reads/writes to session mirror and preserves exact text', async () => {
  const requests = []
  const client = load(async (url, options) => {
    requests.push([url, JSON.parse(options.body), options.signal])
    return { ok: true, status: 200, json: async () => ({ ok: true, content: 'a\r\n', size: 3, mtime: 1 }) }
  })
  let provider
  const off = () => {}
  assert.equal(client.registerRemoteDocumentProvider({ registerDocumentProvider(p) { provider = p; return off } }), off)
  assert.equal(provider.match('sid', '/mirror'), true)
  assert.equal(provider.match('sid', '/local'), false)
  const document = provider.createSource('sid', '/mirror')
  const signal = new AbortController().signal
  const read = await document.readText({}, '/proj/a.txt', { signal })
  assert.equal(read.content, 'a\r\n')
  assert.equal(read.writable, true)
  await document.writeText({}, '/proj/a.txt', 'new', { expectedContent: read.content })
  assert.equal(requests[0][1].local, '/mirror')
  assert.equal(requests[0][1].sessionId, 'sid')
  assert.equal(requests[0][1].preserveText, true)
  assert.equal(requests[0][2], signal)
  assert.equal(requests[1][1].expectedContent, 'a\r\n')
  assert.equal(requests[1][1].sessionId, 'sid')
})

test('provider errors do not fall back and writes report ambiguous transport outcome', async () => {
  const client = load(async () => { throw new Error('connection dropped') })
  let provider
  client.registerRemoteDocumentProvider({ registerDocumentProvider(p) { provider = p } })
  const doc = provider.createSource('sid', '/mirror')
  await assert.rejects(doc.readText({}, '/a'), { code: 'unavailable' })
  await assert.rejects(doc.writeText({}, '/a', 'x', { expectedContent: 'a' }), { code: 'write-outcome-unknown' })
})

test('file activation: handled suppresses legacy tab, decline keeps remote tab, rejection propagates', async () => {
  const client = load(() => {})
  const tabs = []
  const bs = { openTab: (...args) => tabs.push(args), dispatchFileActivation: async get => { assert.equal(get().scope.sessionId, 'sid'); return true } }
  await client.openRemoteFile(bs, '/a', { sessionId: 'sid', cwd: '/mirror' })
  assert.equal(tabs.length, 0)
  bs.dispatchFileActivation = async () => false
  await client.openRemoteFile(bs, '/a', { sessionId: 'sid', cwd: '/mirror' })
  assert.equal(tabs[0][0].type, 'dsh-remote:file')
  bs.dispatchFileActivation = async () => { throw new Error('veto') }
  await assert.rejects(client.openRemoteFile(bs, '/a', { sessionId: 'sid', cwd: '/mirror' }), /veto/)
  assert.equal(tabs.length, 1)
})

function server() {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'a\r\n' })
  const routes = createFsRoutes({
    config: { encoding: 'utf-8' }, readBody: async req => JSON.stringify(req.body),
    sendJson: (res, status, data) => Object.assign(res, { status, data }),
    resolveRequestBinding: async () => ({ pool: { sftp: async () => makeSftp(fs) } }),
    decodeBuf: b => b.toString('utf8'), encodeText: s => Buffer.from(s), audit: () => {},
  })
  return { fs, async call(route, body) {
    const res = {}
    await routes.find(r => r.path === '/dsh-remote/' + route).handler({ method: 'POST', url: '/dsh-remote/' + route, body }, res)
    return res
  } }
}

test('read preserves CRLF for strict baselines; conditional save rejects changed/deleted file', async () => {
  const s = server()
  const body = { path: '/proj/a.txt', sessionId: 'sid' }
  const read = await s.call('read', { ...body, preserveText: true })
  assert.equal(read.data.content, 'a\r\n')
  const conflict = await s.call('write', { ...body, content: 'bad', expectedContent: 'a\n' })
  assert.equal(conflict.status, 409)
  assert.equal(s.fs.readFileSync(body.path).toString(), 'a\r\n')
  const saved = await s.call('write', { ...body, content: 'new', expectedContent: read.data.content })
  assert.equal(saved.status, 200)
  assert.equal(s.fs.readFileSync(body.path).toString(), 'new')
  s.fs.root.delete(body.path)
  const deleted = await s.call('write', { ...body, content: 'new', expectedContent: 'new' })
  assert.equal(deleted.status, 409)
  assert.equal(s.fs.existsSync(body.path), false)
})
