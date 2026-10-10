import { acquireSshCarrier } from './ssh-carrier.js'
import { SshPool } from './pool.js'

// A carrier pool owns one reachability lease until close. All channels created
// by this pool (including independent PTYs) die before that lease is released.
export async function createCarrierSshPool(machine, config, { knownHostsFile, credentialResolver, signal, Pool = SshPool, _probeDiagnostic, _clientFactory, _reusedGeneration } = {}) {
  const report = (event, data) => { try { _probeDiagnostic?.(event, data) } catch {} }
  if (typeof machine.expectedHostFingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(machine.expectedHostFingerprint)) throw new Error('ssh carrier requires independently confirmed SHA256 host fingerprint')
  report('carrier.acquire.start', { phase: 'carrier.acquire' })
  const lease = await acquireSshCarrier(machine, { signal })
  let pool
  let targetIdentity, generation
  try {
    targetIdentity = lease.targetIdentity
    generation = lease.generation
    report('carrier.acquire.complete', { host: lease.dialHost, port: lease.dialPort, generation,
      reusedGeneration: _reusedGeneration !== undefined ? generation === _reusedGeneration : undefined })
    pool = new Pool({
      ...config,
      host: lease.dialHost,
      port: lease.dialPort,
      username: machine.username,
      privateKeyPath: machine.privateKeyPath || '',
      passphrase: machine.passphrase || '',
      password: '',
      useAgent: !!machine.useAgent,
      keyboardInteractive: !!machine.keyboardInteractive,
      proxy: undefined,
      hostKeyMode: 'verify',
      hostKeyIdentity: JSON.stringify(['ssh-carrier', machine.id, targetIdentity]),
      expectedHostFingerprint: machine.expectedHostFingerprint,
    }, { knownHostsFile, _probeDiagnostic, _clientFactory })
  } catch (err) {
    await lease.release()
    throw err
  }
  pool.passwordResolver = credentialResolver || (() => Promise.resolve(machine.password || ''))
  const originalClose = pool.close.bind(pool)
  let released = false
  let releasePromise
  pool.carrier = Object.freeze({ targetIdentity, generation })
  Object.defineProperty(pool, 'carrierClosed', { get: () => released })
  pool.close = () => {
    if (released) return releasePromise
    released = true
    signal?.removeEventListener('abort', onAbort)
    // Cleanup must release reachability even if an injected pool throws.
    let closeError, closeResult
    try { closeResult = originalClose() } catch (err) { closeError = err }
    releasePromise = Promise.resolve(closeResult).catch(err => { closeError = err })
      .then(() => lease.release()).then(() => { if (closeError) throw closeError })
    // Most legacy pool callers close synchronously. Do not leave a rejection
    // unobserved; explicit callers may still await and see this promise reject.
    releasePromise.catch(() => {})
    return releasePromise
  }
  const onAbort = () => { pool.close().catch(() => {}) }
  const originalConnect = pool.connect.bind(pool)
  pool.connect = () => released ? Promise.reject(new Error('ssh carrier lease closed')) : originalConnect()
  Promise.resolve(lease.closed).then(() => pool.close(), () => pool.close()).catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal && signal.aborted) {
    await pool.close()
    throw new Error('ssh carrier acquire aborted')
  }
  return pool
}
