// Public SSH carrier registry. Carriers provide reachability, never SSH auth.
const carriers = new Map()
const ID = /^[a-z][a-z0-9_-]*$/u

export function registerSshCarrier(def) {
  if (!def || !ID.test(def.id || '') || typeof def.acquire !== 'function') throw new Error('ssh carrier: valid id and acquire required')
  if (def.apiVersion !== undefined && def.apiVersion !== 1) throw new Error('ssh carrier: unsupported apiVersion')
  if (carriers.has(def.id)) throw new Error('ssh carrier already registered: ' + def.id)
  const entry = { ...def, apiVersion: 1 }
  carriers.set(def.id, entry)
  return () => { if (carriers.get(def.id) === entry) carriers.delete(def.id) }
}

export function sshCarrierIds() { return [...carriers.keys()] }
export function sshCarrierOf(id) { return carriers.get(id) }

// Stable descriptor identity comes from the registered carrier's pure function,
// never from a user-supplied identity or runtime localhost endpoint.
export function sshConnectorTargetIdentity(connector) {
  const def = carriers.get(connector && connector.kind)
  if (!def || typeof def.targetIdentity !== 'function') throw new Error('ssh carrier canonical target identity unavailable')
  const identity = def.targetIdentity(connector)
  if (typeof identity !== 'string' || !identity.trim() || identity.length > 4096) throw new Error('ssh carrier invalid canonical target identity')
  return identity
}

export function validateSshConnector(machine) {
  const connector = machine && machine.connector
  if (!connector || typeof connector !== 'object' || !ID.test(connector.kind || '')) throw new Error('ssh connector kind required')
  if (!machine.id) throw new Error('ssh carrier requires stable machine id')
  if (machine.transport && machine.transport !== 'ssh') throw new Error('ssh carrier requires ssh transport')
  if (machine.useSshConfig || (machine.proxy && machine.proxy.host)) throw new Error('ssh carrier cannot combine with SSH config/proxy')
  const def = carriers.get(connector.kind)
  if (!def) throw new Error('ssh carrier not installed: ' + connector.kind)
  if (typeof def.validateConnector === 'function') def.validateConnector(connector)
  return def
}

export async function acquireSshCarrier(machine, { signal } = {}) {
  const def = validateSshConnector(machine)
  if (signal && signal.aborted) throw new Error('ssh carrier acquire aborted')
  const lease = await def.acquire({ machineId: machine.id, connector: { ...machine.connector }, signal })
  let valid = false
  try {
    // Adapter getters can throw when a lease dies just after acquire resolves.
    // Validation must still release that lease rather than leaking its refs.
    valid = !!(lease && (lease.dialHost === '127.0.0.1' || lease.dialHost === '::1') &&
      Number.isInteger(lease.dialPort) && lease.dialPort > 0 && lease.dialPort <= 65535 &&
      typeof lease.targetIdentity === 'string' && lease.targetIdentity.trim().length > 0 &&
      typeof lease.generation === 'string' && lease.generation.trim().length > 0 &&
      lease.closed && typeof lease.closed.then === 'function' && typeof lease.release === 'function')
  } catch { /* stale lease is an invalid acquisition, never a direct fallback */ }
  if (!valid || (signal && signal.aborted)) {
    if (lease && typeof lease.release === 'function') await lease.release()
    throw new Error(valid ? 'ssh carrier acquire aborted' : 'ssh carrier returned invalid lease')
  }
  return lease
}
