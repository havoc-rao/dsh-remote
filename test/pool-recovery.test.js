// Deterministic channel callback interleavings; no network or real credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SshPool } from '../lib/pool.js'
import { registerSshCarrier } from '../lib/ssh-carrier.js'
import { createCarrierSshPool } from '../lib/ssh-carrier-pool.js'

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const failure = () => new Error('Channel open failure: open failed')

function fixture(pool = new SshPool({ host: 'fixture.invalid', port: 22, username: 'fixture', commandTimeoutMs: 1000 })) {
  const callbacks = []
  const stats = { oldEnded: 0, freshEnded: 0, connects: 0, closed: 0 }
  const old = {
    end() { stats.oldEnded++ },
    sftp(cb) { callbacks.push(cb) },
    exec(cmd, opts, cb) { callbacks.push(cb) },
  }
  const fresh = {
    end() { stats.freshEnded++ },
    sftp(cb) { cb(null, new EventEmitter()) },
    exec(cmd, opts, cb) {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      cb(null, stream)
      queueMicrotask(() => stream.emit('close', 0))
    },
  }
  let ready
  pool.client = old
  pool.onCloseHook = () => { stats.closed++ }
  pool._doConnect = (epoch) => {
    stats.connects++
    return new Promise((resolve, reject) => {
      ready = () => {
        if (pool.epoch !== epoch) {
          fresh.end()
          reject(new Error('ssh target changed during connect'))
        } else {
          pool.client = fresh
          resolve(fresh)
        }
      }
    })
  }
  return { pool, callbacks, stats, fresh, ready: () => ready() }
}

for (const mode of ['sftp+sftp', 'exec+sftp', 'exec+exec']) {
  for (const late of [false, true]) {
    test(`${mode}: sibling failure ${late ? 'after' : 'before'} fresh ready cannot invalidate recovery`, async () => {
      const f = fixture()
      const requests = mode.split('+').map(kind => kind === 'sftp' ? f.pool.sftp() : f.pool._execRaw('true', {}))
      await tick()
      assert.equal(f.callbacks.length, 2)
      f.callbacks[0](failure())
      assert.equal(f.stats.connects, 1)
      if (late) { f.ready(); await tick() }
      f.callbacks[1](failure())
      assert.equal(f.stats.connects, 1)
      assert.equal(f.pool.epoch, 1)
      assert.equal(f.stats.oldEnded, 1)
      assert.equal(f.stats.closed, 1)
      if (!late) f.ready()
      await Promise.all(requests)
      assert.equal(f.pool.client, f.fresh)
      assert.equal(f.stats.freshEnded, 0)
      f.pool.close()
    })
  }
}

for (const kind of ['sftp', 'exec']) {
  for (const boundary of ['failure', 'success', 'ready']) {
    test(`${kind}: carrier lease closure fences ${boundary} callback using real SshPool`, async () => {
      const id = `recovery-${kind}-${boundary}`
      let stop, releases = 0
      const closed = new Promise(resolve => { stop = resolve })
      const dispose = registerSshCarrier({ id, acquire: async () => ({
        dialHost: '127.0.0.1', dialPort: 50736, targetIdentity: 'fixture:22',
        generation: 'g1', closed, release() { releases++ },
      }) })
      let pool
      try {
        pool = await createCarrierSshPool({
          id: 'fixture-machine', connector: { kind: id }, username: 'fixture',
          expectedHostFingerprint: 'SHA256:' + Buffer.alloc(32, 1).toString('base64').replace(/=+$/, ''),
        }, { commandTimeoutMs: 1000 })
        const f = fixture(pool)
        const rejected = assert.rejects(kind === 'sftp' ? pool.sftp() : pool._execRaw('true', {}), /ssh target changed during recovery/)
        await tick()
        let opens = 0, ended = 0
        if (boundary === 'ready') {
          f.fresh[kind] = () => { opens++ }
          f.callbacks[0](failure())
          // Queue the lease-close handler ahead of the retry continuation.
          stop()
          f.ready()
        } else {
          stop()
          await tick()
          f.callbacks[0](boundary === 'failure' ? failure() : null, {
            end() { ended++ }, close() { ended++ },
          })
        }
        await rejected
        assert.equal(pool.carrierClosed, true)
        assert.equal(opens, 0)
        if (boundary === 'success') assert.equal(ended, 1)
        if (boundary !== 'ready') assert.equal(f.stats.connects, 0)
        await pool.close()
        assert.equal(releases, 1)
      } finally {
        if (pool) await pool.close()
        dispose()
      }
    })
  }
}

const change = (f, action) => action === 'setTarget' ? f.pool.setTarget({ host: 'different.invalid' }) : f.pool[action]()
const request = (f, kind) => kind === 'sftp' ? f.pool.sftp() : f.pool._execRaw('true', {})

for (const action of ['close', 'invalidate', 'setTarget']) {
  for (const kind of ['sftp', 'exec']) {
    test(`${kind}: explicit ${action} fences a late old callback without reconnecting`, async () => {
      const f = fixture()
      const rejected = assert.rejects(request(f, kind), /ssh target changed during recovery/)
      await tick()
      change(f, action)
      f.callbacks[0](failure())
      await rejected
      assert.equal(f.stats.connects, 0)
      assert.equal(f.pool.client, null)
    })

    test(`${kind}: ${action} after ready but before retry continuation cannot open a channel`, async () => {
      const f = fixture()
      let opens = 0
      f.fresh[kind] = () => { opens++ }
      const rejected = assert.rejects(request(f, kind), /ssh target changed during recovery/)
      await tick()
      f.callbacks[0](failure())
      f.ready()
      change(f, action)
      await rejected
      assert.equal(opens, 0)
      assert.equal(f.stats.connects, 1)
    })

    test(`${kind}: ${action} before initial continuation cannot open a channel`, async () => {
      const f = fixture()
      const rejected = assert.rejects(request(f, kind), /ssh target changed during recovery/)
      change(f, action)
      await rejected
      assert.equal(f.callbacks.length, 0)
    })

    test(`${kind}: ${action} fences a successful late channel callback and closes it`, async () => {
      const f = fixture()
      const rejected = assert.rejects(request(f, kind), /ssh target changed during recovery/)
      await tick()
      change(f, action)
      let ended = 0
      const channel = { end() { ended++ }, close() { ended++ } }
      f.callbacks[0](null, channel)
      await rejected
      assert.equal(ended, 1)
      assert.equal(f.stats.connects, 0)
    })
  }

  test(`explicit ${action} during recovery still rejects pending ready`, async () => {
    const f = fixture()
    const rejected = assert.rejects(f.pool.sftp(), /ssh target changed during connect/)
    await tick()
    f.callbacks[0](failure())
    change(f, action)
    f.ready()
    await rejected
    assert.equal(f.pool.client, null)
    assert.equal(f.stats.connects, 1)
  })
}

for (const kind of ['sftp', 'exec']) {
  test(`${kind}: permission error does not reconnect`, async () => {
    const f = fixture()
    const rejected = assert.rejects(request(f, kind), /permission denied/)
    await tick()
    f.callbacks[0](new Error('permission denied'))
    await rejected
    assert.equal(f.stats.connects, 0)
    assert.equal(f.pool.epoch, 0)
    f.pool.close()
  })

  test(`${kind}: recovery retries at most once`, async () => {
    const f = fixture()
    f.fresh[kind] = kind === 'sftp' ? cb => cb(failure()) : (cmd, opts, cb) => cb(failure())
    const rejected = assert.rejects(request(f, kind), /open failed/)
    await tick()
    f.callbacks[0](failure())
    f.ready()
    await rejected
    assert.equal(f.stats.connects, 1)
    assert.equal(f.pool.epoch, 1)
    f.pool.close()
  })
}
