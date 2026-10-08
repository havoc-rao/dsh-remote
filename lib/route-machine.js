// Route one REMOTE path to the machine whose mirror owns it.
//
// Why this exists: the sidebar's remote file tree / file tab serve REMOTE
// paths that may belong to a machine OTHER than the one the plugin's shared
// SSH pool currently serves (saved machines are "standby" for tools, but
// any saved machine's mirror can be a session's workspace — the session
// cwd sits under <mirrorRoot>/<host>-<user>-<port>/<base>). Listing such a
// path through the shared pool hits the WRONG host: an existing-but-empty
// or missing directory there resolves to `{ items: [] }` (HTTP 200, no
// error) — which the host FileTree renders as "loading flash, then no rows,
// no error row" (entries.length === 0 → nothing). The route layer uses this
// module to resolve the owning machine and bind a dedicated per-machine
// connection instead.
//
// Resolution is the mirror-registry walk (same shape as the host half's
// resolve-mirror), but matched on the REMOTE path (meta.remotePath covers
// the target: equal or a child). Machine preference, in order:
//   1. the CURRENT machine's own mirror (byte-identical to the legacy
//      shared-pool behavior for the machine the pool already serves);
//   2. a mirror whose machine is SAVED in the registry (connectable);
//   3. the first match (best effort).
// No match → the caller falls back to the shared pool (legacy behavior).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { sshConnectorTargetIdentity } from './ssh-carrier.js'

// Schema 3 target identity is a persisted canonical descriptor identity, NOT a
// transient carrier lease/CLI identity. The save gate must establish provenance.
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0
export const isStrictSshMirror = (m) => !!m && (Number(m.schemaVersion) >= 3 || Object.prototype.hasOwnProperty.call(m, 'connectorTargetIdentity'))
export function strictSshMirrorIdentity(m) {
  if (!isStrictSshMirror(m) || m.schemaVersion !== 3 || m.transport !== 'ssh'
    || !nonempty(m.machineId) || !nonempty(m.connectorTargetIdentity)) return null
  return { machineId: m.machineId, connectorTargetIdentity: m.connectorTargetIdentity }
}
const directSsh = (m) => !!m && (!m.transport || m.transport === 'ssh') && !Object.prototype.hasOwnProperty.call(m, 'connector')
const carrierIdentity = (m) => {
  if (!m || (m.transport && m.transport !== 'ssh') || !nonempty(m.id)) return null
  try {
    return { machineId: m.id, connectorTargetIdentity: sshConnectorTargetIdentity(m.connector) }
  } catch { return null }
}

/** Canonical remote path for comparison: forward slashes, collapsed doubles,
 *  no trailing separator ('/' stays '/'). */
export function normalizeRoutePath(p) {
  const t = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
  return t === '' ? '/' : t
}

/** Every mirror whose remotePath covers `target` (equal or a child). Walks
 *  <mirrorRoot>/<host>-<user>-<port>/<base>/.dsh-remote-meta.json — the
 *  same layout resolve-mirror reads. Empty when the path matches no mirror
 *  (or the mirror root is unreadable). */
export function findMirrorsForRemotePath(mirrorRoot, target) {
  const canon = normalizeRoutePath(target)
  if (!canon || canon === '/' || !mirrorRoot || !existsSync(mirrorRoot)) return []
  const out = []
  for (const hostDir of readdirSync(mirrorRoot)) {
    const hostPath = path.join(mirrorRoot, hostDir)
    if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
    for (const mirrorDir of readdirSync(hostPath)) {
      const metaPath = path.join(hostPath, mirrorDir, '.dsh-remote-meta.json')
      if (!existsSync(metaPath)) continue
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        const rp = normalizeRoutePath(meta.remotePath || '')
        if (rp && rp !== '/' && (canon === rp || canon.startsWith(rp + '/'))) {
          const entry = {
            host: String(meta.host || ''),
            port: Number(meta.port) || 22,
            username: String(meta.username || 'root'),
            remotePath: rp,
            mirrorDir: path.join(hostPath, mirrorDir),
            tag: hostDir,
          }
          // Mirror meta v2 (transport !== 'ssh'): carry the transport identity
          // through so callers can route by the STABLE machine id instead of
          // the placeholder host/port/username (which all tunnel machines
          // share — see machineForMirror). Fields are passed through only when
          // the meta carries them; plain v1 metas keep the legacy v1 shape.
          if (typeof meta.transport === 'string' && meta.transport) entry.transport = meta.transport
          if (typeof meta.machineId === 'string' && meta.machineId) entry.machineId = meta.machineId
          if (meta.remoteIdentity !== undefined) entry.remoteIdentity = meta.remoteIdentity
          // Preserve even malformed strict markers: dropping them would turn an
          // invalid carrier origin into a legacy direct-SSH lookup.
          if (isStrictSshMirror(meta)) {
            entry.schemaVersion = meta.schemaVersion
            entry.transport = meta.transport
            entry.machineId = meta.machineId
            entry.connectorTargetIdentity = meta.connectorTargetIdentity
          }
          out.push(entry)
        }
      } catch { /* skip unparsable meta */ }
    }
  }
  return out
}

/** Pick THE mirror a route should serve (see the header for the preference
 *  order). `currentMachine` — { host, port, username } of the shared pool's
 *  machine — wins; `isSaved` (mirrorEntry) → boolean lets the caller prefer
 *  connectable machines. Null when nothing covers the path. */
export function pickMirrorForRemotePath(mirrorRoot, target, currentMachine, isSaved) {
  const all = findMirrorsForRemotePath(mirrorRoot, target)
  if (!all.length) return null
  if (currentMachine) {
    const currentStrict = strictSshMirrorIdentity(currentMachine) || carrierIdentity(currentMachine)
    const own = all.find((m) => {
      if (isStrictSshMirror(m)) {
        const strict = strictSshMirrorIdentity(m)
        return !!(strict && currentStrict && strict.machineId === currentStrict.machineId
          && strict.connectorTargetIdentity === currentStrict.connectorTargetIdentity)
      }
      if (isStrictSshMirror(currentMachine) || Object.prototype.hasOwnProperty.call(currentMachine, 'connector')) return false
      return !!currentMachine.host && String(m.host) === String(currentMachine.host)
        && Number(m.port) === Number(currentMachine.port)
        && String(m.username || 'root') === String(currentMachine.username || 'root')
    })
    if (own) return own
  }
  if (typeof isSaved === 'function') {
    // The callback receives the FULL mirror entry (v2 entries carry
    // transport/machineId; v1 entries the legacy ssh triple) so it can decide
    // "saved" per transport — a vscode-tunnel mirror is saved iff its machine
    // id exists in the registry, never by its placeholder host/port/username.
    const saved = all.find((m) => isSaved(m))
    if (saved) return saved
  }
  return all[0]
}

/**
 * Mirror origin → the machine record to connect to. The single resolution
 * entry point for mirror routing (routePoolOf / poolForMachine / reconnect /
 * git-workspace): it is what keeps a v2 (transport + machineId) mirror from
 * ever being washed into an SSH-shaped record.
 *
 * Returns `{ record, transport, machineId }` or `null`:
 *   record    — a SAVED registry machine. v2: found by stable machine id AND
 *               transport match. v1: found by the legacy host/port/username
 *               lookup (machineByTarget semantics); `null` when unsaved, so
 *               an SSH mirror whose owner was deleted keeps its historical
 *               "not saved" / ad-hoc fallback behavior at the call site.
 *   transport — 'ssh' for v1 origins; the meta transport ('vscode-tunnel', …)
 *               for v2 origins.
 *   machineId — the v2 machine id (`null` for v1).
 *
 * v2: `meta.transport` set and !== 'ssh'. Keyed by machineId ONLY — never by
 * host/port/username (every tunnel machine records the same placeholder
 * 127.0.0.1/0/''). Missing record → `null`: the caller MUST refuse; a
 * fabricated ad-hoc SSH record would bind the mirror to the wrong machine.
 * v3: exact schemaVersion 3 + transport 'ssh' + machineId + persisted canonical
 * connectorTargetIdentity. Requires a saved carrier record whose registered
 * carrier's canonical targetIdentity matches; connector-supplied
 * targetIdentity is never trusted as the descriptor identity.
 * Runtime lease targetIdentity is separate and must not replace the descriptor.
 * Malformed strict intent returns null, never an ad-hoc direct SSH record.
 * v1: no transport, or 'ssh'. The host/port/username triple resolves only direct
 * SSH records (no connector property), never carrier or non-SSH lookalikes.
 *
 * @param {{host: string, port: number, username: string, transport?: string, machineId?: string}} meta
 *        a findMirrorsForRemotePath / mirrorEntries entry, or a resolveMirror `machine`.
 * @param {Array<{id: string, transport?: string, host: string, port: number, username: string}>} registry
 *        the saved-machine registry.
 */
export function machineForMirror(meta, registry) {
  const reg = Array.isArray(registry) ? registry : []
  if (isStrictSshMirror(meta)) {
    const identity = strictSshMirrorIdentity(meta)
    if (!identity) return null
    const record = reg.find((m) => {
      const saved = carrierIdentity(m)
      return saved && saved.machineId === identity.machineId
        && saved.connectorTargetIdentity === identity.connectorTargetIdentity
    }) || null
    if (!record) return null
    return { record, transport: 'ssh', machineId: identity.machineId, connectorTargetIdentity: identity.connectorTargetIdentity }
  }
  const t = meta && meta.transport
  const transport = t && String(t) !== 'ssh' ? String(t) : 'ssh'
  if (transport === 'ssh') {
    const record = reg.find((m) =>
      directSsh(m) && String(m.host) === String(meta && meta.host)
      && Number(m.port) === Number(meta && meta.port)
      && String(m.username || 'root') === String((meta && meta.username) || 'root')) || null
    return { record, transport: 'ssh', machineId: null }
  }
  const machineId = String((meta && meta.machineId) || '')
  if (!machineId) return null
  const record = reg.find((m) => String(m.id) === machineId && String(m.transport || 'ssh') === transport) || null
  if (!record) return null
  return { record, transport, machineId }
}