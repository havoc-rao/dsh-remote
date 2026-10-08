// Stable carrier-only pool cache. No TTL teardown: live PTYs retain their pool
// until explicit machine update/delete/unload or carrier invalidation.
import { createCarrierSshPool } from './ssh-carrier-pool.js'
import { sshConnectorTargetIdentity } from './ssh-carrier.js'

export function createCarrierPoolCache({ createPool = createCarrierSshPool } = {}) {
  const entries = new Map()
  let disposed = false
  const revisionOf = (machine, config) => JSON.stringify([
    sshConnectorTargetIdentity(machine.connector), machine.connector,
    machine.username, machine.privateKeyPath || '', machine.passphrase || '',
    machine.password || '', !!machine.useAgent, !!machine.keyboardInteractive,
    machine.expectedHostFingerprint,
    config.connectTimeoutMs, config.commandTimeoutMs, config.transferTimeoutMs,
    config.maxOutputChars, config.env,
  ])
  async function get(machine, config, options = {}) {
    if (disposed) throw new Error('ssh carrier cache disposed')
    // Caller-owned records may be edited while acquisition is pending. Snapshot
    // the validated JSON-shaped connector and auth before scheduling work.
    machine = { ...machine, connector: JSON.parse(JSON.stringify(machine.connector)) }
    config = { ...config, ...(config?.env ? { env: { ...config.env } } : {}) }
    const revision = revisionOf(machine, config)
    let entry = entries.get(machine.id)
    if (entry && (entry.revision !== revision || entry.pool?.carrierClosed)) {
      await invalidate(machine.id)
      // Another caller may have installed a replacement while cleanup awaited.
      // Re-read via get rather than overwrite that caller's live acquisition.
      return get(machine, config, options)
    }
    if (!entry) {
      const controller = new AbortController()
      entry = { revision, live: true, controller, ready: null, pool: null }
      const current = entry
      entries.set(machine.id, current)
      current.ready = Promise.resolve().then(() => createPool(machine, config, { ...options, signal: controller.signal })).then(async pool => {
        if (!current.live || disposed || entries.get(machine.id) !== current) {
          await pool.close()
          throw new Error('ssh carrier cache acquisition invalidated')
        }
        current.pool = pool
        return pool
      }).catch(err => {
        if (entries.get(machine.id) === current) entries.delete(machine.id)
        throw err
      })
    }
    return entry.ready
  }
  async function invalidate(machineId) {
    const entry = entries.get(machineId)
    if (!entry) return
    entries.delete(machineId)
    entry.live = false
    entry.controller.abort()
    await entry.ready.then(pool => pool.close(), () => {})
  }
  async function close() {
    disposed = true
    await Promise.all([...entries.keys()].map(invalidate))
  }
  const peek = id => entries.get(id)?.pool || null
  return { get, invalidate, close, peek }
}
