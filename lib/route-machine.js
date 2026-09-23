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
  if (currentMachine && currentMachine.host) {
    const own = all.find((m) =>
      String(m.host) === String(currentMachine.host)
      && Number(m.port) === Number(currentMachine.port)
      && String(m.username || 'root') === String(currentMachine.username || 'root'))
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
 * v1: no transport, or 'ssh'. The host/port/username triple is resolved
 * exactly like the legacy machineByTarget did.
 *
 * @param {{host: string, port: number, username: string, transport?: string, machineId?: string}} meta
 *        a findMirrorsForRemotePath / mirrorEntries entry, or a resolveMirror `machine`.
 * @param {Array<{id: string, transport?: string, host: string, port: number, username: string}>} registry
 *        the saved-machine registry.
 */
export function machineForMirror(meta, registry) {
  const reg = Array.isArray(registry) ? registry : []
  const t = meta && meta.transport
  const transport = t && String(t) !== 'ssh' ? String(t) : 'ssh'
  if (transport === 'ssh') {
    const record = reg.find((m) =>
      String(m.host) === String(meta && meta.host)
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