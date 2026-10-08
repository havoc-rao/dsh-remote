import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash } from 'node:crypto'
import ssh2 from 'ssh2'
import { registerSshCarrier } from '../lib/ssh-carrier.js'
import { createCarrierSshPool } from '../lib/ssh-carrier-pool.js'

test('carrier factory verifies real SSH wire pin and closes dedicated PTY before release', { timeout: 10000 }, async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const key = ssh2.utils.parseKey(privateKey)
  const pin = 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')
  const clients = new Set()
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'fixture' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('pty', accept => accept())
      session.on('shell', accept => { const ch = accept(); ch.on('error', () => {}) })
    }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)) })
  let released = 0
  const dispose = registerSshCarrier({ id: 'wire-fixture', acquire: async () => ({ dialHost: '127.0.0.1', dialPort: server.address().port, targetIdentity: 'fixture-b', generation: 'g1', closed: new Promise(() => {}), release: () => { released++ } }) })
  t.after(dispose)
  const machine = { id: 'wire-b', connector: { kind: 'wire-fixture' }, username: 'fixture', password: 'fixture', expectedHostFingerprint: pin }
  const pool = await createCarrierSshPool(machine, { connectTimeoutMs: 2000 })
  t.after(() => pool.close())
  await pool.connect()
  pool.platform = 'posix' // No platform probe needed for this transport fixture.
  const terminal = await pool.openPty()
  assert.equal(pool._ptyClients.size, 1)
  await pool.close()
  assert.equal(pool._ptyClients.size, 0)
  assert.equal(released, 1)
  await assert.rejects(pool.connect(), /lease closed/)
  terminal.end()
  const wrong = await createCarrierSshPool({ ...machine, expectedHostFingerprint: 'SHA256:' + Buffer.alloc(32).toString('base64') }, { connectTimeoutMs: 2000 })
  t.after(() => wrong.close())
  await assert.rejects(wrong.connect(), /fingerprint|host key/i)
  await wrong.close()
  assert.equal(released, 2)
})
