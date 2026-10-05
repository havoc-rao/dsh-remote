import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createFsRoutes } from '../lib/routes-fs.js'
import { MemFs, makeSftp, seed } from './helpers.js'

function harness() {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'from owning machine' })
  const calls = []
  const owner = { platform: 'posix', detect: async () => {}, sftp: async () => makeSftp(fs) }
  const routes = createFsRoutes({
    config: { encoding: 'utf-8' },
    sendJson: (res, status, data) => Object.assign(res, { status, data }),
    readBody: async (req) => JSON.stringify(req.body || {}),
    resolveRequestBinding: async (req, body) => {
      calls.push(['binding', req.url, body])
      if (body.sessionId === 'local') throw Object.assign(new Error('LOCAL session'), { httpStatus: 403 })
      return { pool: { sftp: async () => { throw new Error('explicit target') } } }
    },
    routePoolForPath: async (p) => {
      calls.push(['path', p])
      return { pool: owner, machine: { host: 'owner', port: 22, username: 'user' } }
    },
  })
  return {
    calls,
    async call(route, body = {}, query = '', method = 'POST') {
      const res = {}
      await routes.find((r) => r.path === '/dsh-remote/' + route).handler({ method, url: '/dsh-remote/' + route + query, body }, res)
      return res
    },
  }
}

test('unscoped listing and file read use the same owning-machine pool', async () => {
  const h = harness()
  const ls = await h.call('ls', {}, '?path=%2Fproj', 'GET')
  assert.equal(ls.status, 200)
  assert.equal(ls.data.items[0].name, 'a.txt')
  const read = await h.call('read', { path: '/proj/a.txt' })
  assert.equal(read.status, 200)
  assert.equal(read.data.content, 'from owning machine')
  assert.deepEqual(h.calls, [['path', '/proj'], ['path', '/proj/a.txt']])
})

test('GET file read also resolves the owning machine by path', async () => {
  const h = harness()
  const res = await h.call('read', {}, '?path=%2Fproj%2Fa.txt', 'GET')
  assert.equal(res.status, 200)
  assert.deepEqual(h.calls, [['path', '/proj/a.txt']])
})

for (const [name, body, query] of [
  ['body session', { sessionId: 'remote' }, ''],
  ['query session', {}, '?sessionId=remote'],
  ['local mirror', { local: '/mirror' }, ''],
  ['machine', {}, '?machine=other'],
]) {
  test(`${name} binding is authoritative; never falls back to path routing`, async () => {
    const h = harness()
    const res = await h.call('read', { path: '/proj/a.txt', ...body }, query)
    assert.equal(res.status, 500)
    assert.match(res.data.error, /explicit target/)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0][0], 'binding')
  })
}

test('LOCAL session refusal does not fall back to the owning path machine', async () => {
  const h = harness()
  const res = await h.call('read', { path: '/proj/a.txt', sessionId: 'local' })
  assert.equal(res.status, 403)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][0], 'binding')
})

test('file preview forwards its scoped session and reloads when it changes', () => {
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf-8')
  assert.match(client, /readRemoteFile\(path, 256 \* 1024, fileSessionId\)/)
  assert.match(client, /\}, \[path, fileSessionId\]\)/)
})
