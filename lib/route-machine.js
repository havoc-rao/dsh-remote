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
          out.push({
            host: String(meta.host || ''),
            port: Number(meta.port) || 22,
            username: String(meta.username || 'root'),
            remotePath: rp,
            mirrorDir: path.join(hostPath, mirrorDir),
            tag: hostDir,
          })
        }
      } catch { /* skip unparsable meta */ }
    }
  }
  return out
}

/** Pick THE mirror a route should serve (see the header for the preference
 *  order). `currentMachine` — { host, port, username } of the shared pool's
 *  machine — wins; `isSaved` (host, port, username) → boolean lets the
 *  caller prefer connectable machines. Null when nothing covers the path. */
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
    const saved = all.find((m) => isSaved(m.host, m.port, m.username))
    if (saved) return saved
  }
  return all[0]
}