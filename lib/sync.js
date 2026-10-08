// dsh-remote — three-way conflict-aware mirror sync (remote ⇄ local mirror).
//
// Why three-way: plain rsync-style pull/push silently clobbers whichever side
// changed while the other side was edited. We keep a per-mirror snapshot of the
// last-synced remote state (`.dsh-remote-sync-state.json`: relPath →
// {mtime,size}) and compare remote (R), local (L) and last-synced (S):
//
//   R==S && L==S          → unchanged, skip
//   R!=S && L==S          → remote changed → pull it (or push when pushing)
//   R==S && L!=S          → local changed, remote untouched
//                            • pull (rw_sync): would clobber local edit → conflict
//                            • push (rw_push): normal upload
//   R!=S && L!=S && R==L  → both changed to the same bytes → skip
//   R!=S && L!=S && R!=L  → BOTH changed differently → conflict (never clobber)
//
// `force: true` downgrades every conflict to a plain overwrite (rsync behavior).
// `dryRun: true` computes the full plan without writing anything.
// After a successful pull the local mtime is aligned to the remote mtime, and
// after a successful push the local mtime is aligned to the remote mtime the
// server assigned — so the invariant L==R==S holds and the next run is cheap.
import { readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync, utimesSync, renameSync } from 'node:fs'
import path from 'node:path'
import { joinRemotePath, relPathUnder } from './paths.js'
import { atomicRemoteWrite } from './atomic-remote-write.js'

const remoteAbsent = (error) => error?.code === 2 || error?.code === 'ENOENT'
const cancelledError = (error) => !error?.outcomeUnknown && (error?.code === 'CANCELLED' || error?.code === 'ABORT_ERR' || error?.name === 'AbortError')

// Once observed, cancellation stays latched even if the callback later resets.
function cancellation(shouldCancel, stats) {
  let cancelled = false
  return (force = false) => {
    if (force || (!cancelled && shouldCancel())) cancelled = true
    if (cancelled && stats) stats.cancelled = true
    return cancelled
  }
}
const cancelledFile = () => ({ status: 'skipped', skipped: true, reason: 'cancelled', cancelled: true })
const saveError = (error) => ({ error: String(error?.message || error), outcomeUnknown: error?.outcomeUnknown === true })

async function atomicPush(sftp, rp, data, remote, shouldCancel) {
  // Capture values, not an SFTP attrs object that a caller/server may mutate.
  const expected = remote ? { size: remote.size, mtime: remote.mtime } : null
  await atomicRemoteWrite(sftp, rp, { data, expected, shouldCancel })
  if (shouldCancel()) return null // Already committed; do not start postcommit IO.
  try { return await sftp.stat(rp) } catch (error) {
    // Commit succeeded, but we cannot safely advance the mirror snapshot.
    throw Object.assign(new Error(`Remote save committed but stat failed: ${error?.message || error}`), { outcomeUnknown: true, cause: error })
  }
}

function mapLimit(items, limit, fn, shouldCancel = () => false) {
  const limitN = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  const worker = async () => {
    while (next < items.length && !shouldCancel()) {
      const i = next++
      try { await fn(items[i], i) } catch { /* per-item errors are the fn's concern */ }
    }
  }
  const workers = []
  for (let w = 0; w < limitN; w++) workers.push(worker())
  return Promise.all(workers)
}

const keyOf = (size, mtime) => `${size}:${Math.floor(mtime || 0)}`
const localKey = (st) => (st ? keyOf(st.size, st.mtimeMs / 1000) : null)
const remoteKey = (st) => (st ? keyOf(st.size, st.mtime) : null)

/** Recursively pull remote → local mirror (three-way, ignore-aware).
 * shouldCancel defaults to () => false. Cancellation is cooperative and latched:
 * no new IO starts after it is observed; in-flight IO is not aborted. Tree calls
 * return partial progress with stats.cancelled=true, retaining old state for
 * skipped files (and completed writes whose mtime alignment was cancelled). */
export async function syncTree(sftp, remoteDir, localDir, opts = {}) {
  const {
    maxDepth = 8,
    maxFiles = 2000,
    maxFileBytes = 0,
    isIgnored = () => false,
    dryRun = false,
    force = false,
    state = {},
    shouldCancel = () => false,
  } = opts
  const stats = { files: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, conflicts: [], staleRemote: 0, touched: [], truncated: false }
  const nextState = { ...state }
  const cancel = cancellation(shouldCancel, stats)

  const walk = async (rDir, lDir, depth) => {
    if (cancel()) return
    const entries = await sftp.readdir(rDir).then((l) => l || [], () => [])
    if (cancel()) return
    // Directories first (sequential, depth-bounded) so every file has a home.
    for (const e of entries) {
      if (cancel()) return
      const name = String(e.filename)
      if (name === '.' || name === '..') continue
      const isDir = !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory())
      if (!isDir) continue
      if (depth <= 0 || stats.files >= maxFiles) {
        stats.truncated = true
        continue
      }
      const rp = joinRemotePath(rDir, name)
      const lp = path.join(lDir, name)
      const rel = relPathUnder(remoteDir, rp) || name
      if (isIgnored(rel, true)) continue
      if (cancel()) return
      if (!existsSync(lp)) {
        if (cancel()) return
        mkdirSync(lp, { recursive: true })
      }
      if (cancel()) return
      await walk(rp, lp, depth - 1)
      if (cancel()) return
      stats.dirs++
      if (stats.files >= maxFiles) break
    }
    if (stats.files >= maxFiles) { stats.truncated = true; return }

    if (cancel()) return
    const files = entries.filter(
      (e) => !(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()) &&
        String(e.filename) !== '.' && String(e.filename) !== '..',
    )
    await mapLimit(files, 4, async (e) => {
      if (cancel()) return
      if (stats.files >= maxFiles) { stats.truncated = true; return }
      const name = String(e.filename)
      const rp = joinRemotePath(rDir, name)
      const lp = path.join(lDir, name)
      const rel = relPathUnder(remoteDir, rp) || name
      if (isIgnored(rel, false)) return
      let r
      if (cancel()) return
      try { r = await sftp.stat(rp) } catch { cancel(); return }
      if (cancel()) return
      if (maxFileBytes > 0 && r.size > maxFileBytes) { stats.skippedLarge++; return }
      const rk = remoteKey(r)
      const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
      let lk = null
      if (cancel()) return
      if (existsSync(lp)) {
        if (cancel()) return
        try { lk = localKey(statSync(lp)) } catch { lk = null }
      }
      if (sk && rk === sk && lk && lk === sk) { stats.skippedUnchanged++; return }
      if (!force && sk && rk !== sk && lk && lk !== sk && rk !== lk) {
        stats.conflicts.push({ path: rp, reason: 'both-modified（远端与本地都改过，跳过不覆盖）' })
        return
      }
      if (!force && sk && rk === sk && lk && lk !== sk) {
        // Pull would clobber a local edit; the remote never changed.
        stats.conflicts.push({ path: rp, reason: 'local-modified（本地改过而远端未变；如需覆盖请用 force / rw_push）' })
        return
      }
      if (cancel()) return
      if (dryRun) {
        stats.files++
        stats.touched.push(rp)
        nextState[rel] = { size: r.size, mtime: r.mtime }
        return
      }
      try {
        if (cancel()) return
        const buf = await sftp.readFile(rp)
        if (cancel()) return
        writeFileSync(lp, buf)
        const stopped = cancel()
        if (!stopped) try { utimesSync(lp, new Date(r.mtime * 1000), new Date(r.mtime * 1000)) } catch {}
        stats.files++
        stats.touched.push(rp)
        if (stopped) return
        nextState[rel] = { size: r.size, mtime: r.mtime }
      } catch { cancel(); /* skip unreadable */ }
    }, cancel)
  }

  await walk(remoteDir, localDir, maxDepth)
  if (stats.files >= maxFiles) stats.truncated = true
  // Informational: remote entries in the snapshot that no longer exist remotely.
  for (const rel of Object.keys(state)) {
    if (state[rel] && !nextState[rel]) stats.staleRemote++
  }
  return { stats, nextState }
}

/** Recursively push local mirror → remote (three-way, ignore-aware). */
export async function pushTree(sftp, localDir, remoteDir, opts = {}) {
  const {
    atomicWrites = false,
    maxFiles = 2000,
    maxFileBytes = 0,
    isIgnored = () => false,
    dryRun = false,
    force = false,
    state = {},
    shouldCancel = () => false,
  } = opts
  const stats = { files: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, conflicts: [], staleLocal: 0, pushed: [], truncated: false }
  const nextState = { ...state }
  const cancel = cancellation(shouldCancel, stats)

  const walk = async (lDir, rDir) => {
    if (cancel()) return
    const entries = readdirSync(lDir, { withFileTypes: true }).filter(
      (e) => e.name !== '.dsh-remote-meta.json' && e.name !== '.dsh-remote-sync-state.json',
    )
    for (const e of entries) {
      if (cancel()) return
      if (!e.isDirectory()) continue
      if (stats.files >= maxFiles) break
      const rp = joinRemotePath(rDir, e.name)
      const rel = relPathUnder(remoteDir, rp) || e.name
      if (isIgnored(rel, true)) continue
      if (cancel()) return
      try { await sftp.mkdir(rp) } catch { /* already exists */ }
      if (cancel()) return
      stats.dirs++
      await walk(path.join(lDir, e.name), rp)
      if (stats.files >= maxFiles) break
    }
    if (stats.files >= maxFiles) { stats.truncated = true; return }

    if (cancel()) return
    const files = entries.filter((e) => !e.isDirectory())
    await mapLimit(files, 4, async (e) => {
      if (cancel()) return
      if (stats.files >= maxFiles) { stats.truncated = true; return }
      const lp = path.join(lDir, e.name)
      const rp = joinRemotePath(rDir, e.name)
      const rel = relPathUnder(remoteDir, rp) || e.name
      if (isIgnored(rel, false)) return
      let l
      if (cancel()) return
      try { l = statSync(lp) } catch { cancel(); return }
      if (maxFileBytes > 0 && l.size > maxFileBytes) { stats.skippedLarge++; return }
      const lk = localKey(l)
      let r = null
      if (cancel()) return
      try { r = await sftp.stat(rp) } catch (error) {
        if (cancel()) return
        if (atomicWrites && !remoteAbsent(error)) {
          stats.conflicts.push({ path: rp, reason: 'save-failed', ...saveError(error) })
          return
        }
        // Legacy direct writes retain their historical absent-on-error behavior.
      }
      if (cancel()) return
      if (atomicWrites && r) r = { size: r.size, mtime: r.mtime }
      const rk = remoteKey(r)
      const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
      if (r && sk && lk === sk && rk === sk) { stats.skippedUnchanged++; return }
      if (r && !force && sk && rk !== sk && lk !== sk && rk !== lk) {
        stats.conflicts.push({ path: rp, reason: 'both-modified（远端与本地都改过，跳过不覆盖）' })
        return
      }
      if (r && !force && sk && rk !== sk && lk === sk) {
        stats.conflicts.push({ path: rp, reason: 'remote-modified（远端改过而本地未变；如需覆盖请用 force / 先 rw_sync）' })
        return
      }
      if (r && !force && sk && rk === sk && lk && lk !== sk) {
        // Normal case: local edited since sync, remote untouched → push.
      }
      if (cancel()) return
      if (dryRun) {
        stats.files++
        stats.pushed.push(rp)
        return
      }
      try {
        if (cancel()) return
        const buf = readFileSync(lp)
        if (cancel()) return
        let r2 = null
        if (atomicWrites) r2 = await atomicPush(sftp, rp, buf, r, cancel)
        else {
          if (cancel()) return
          await sftp.writeFile(rp, buf)
          if (!cancel()) try { r2 = await sftp.stat(rp) } catch {}
        }
        // A completed write is real progress even if cancellation arrived
        // during it; without postcommit metadata, leave its snapshot unchanged.
        if (cancel()) { stats.files++; stats.pushed.push(rp); return }
        // Align local mtime to whatever the remote server assigned, so the
        // L==R==S invariant holds for the next run.
        const rmt = r2 ? r2.mtime : Math.floor(Date.now() / 1000)
        const stopped = cancel()
        if (!stopped) try { utimesSync(lp, new Date(rmt * 1000), new Date(rmt * 1000)) } catch {}
        stats.files++
        stats.pushed.push(rp)
        if (stopped) return
        nextState[rel] = { size: l.size, mtime: rmt }
      } catch (error) {
        if (cancelledError(error)) { cancel(true); return }
        if (cancel() && !error?.outcomeUnknown) return
        if (atomicWrites) stats.conflicts.push({ path: rp, reason: 'save-failed', ...saveError(error) })
        // Legacy direct writes continue to skip unwritable files quietly.
      }
    }, cancel)
  }

  await walk(localDir, remoteDir)
  if (stats.files >= maxFiles) stats.truncated = true
  for (const rel of Object.keys(state)) {
    if (state[rel] && !nextState[rel]) stats.staleLocal++
  }
  return { stats, nextState }
}

/** Load the sync-state snapshot from a mirror dir (or {}). */
export function loadSyncState(localDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(localDir, '.dsh-remote-sync-state.json'), 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {}
  return {}
}

/** Persist the snapshot (atomic-ish: tmp + rename). */
export function saveSyncState(localDir, state) {
  try {
    mkdirSync(localDir, { recursive: true })
    const tmp = path.join(localDir, '.dsh-remote-sync-state.json.tmp')
    writeFileSync(tmp, JSON.stringify(state, null, 1))
    renameSync(tmp, path.join(localDir, '.dsh-remote-sync-state.json'))
  } catch { /* best effort */ }
}

/** Push ONE local mirror file back to the remote (used by auto-push).
 * Same three-way guard as pushTree: never clobbers a remote change. Returns
 * { status: 'pushed'|'unchanged'|'conflict'|'skipped'|'missing' } and the
 * updated state delta ({rel: {size, mtime}} when pushed).
 * Precommit cancellation returns skipped/reason=cancelled, without state. If a
 * write already committed, returns pushed/cancelled=true without state instead
 * of claiming it was skipped. Rename outcomeUnknown failures remain failures. */
export async function pushOneFile(sftp, localDir, remoteDir, rel, opts = {}) {
  const { atomicWrites = false, maxFileBytes = 0, isIgnored = () => false, force = false, state = {}, shouldCancel = () => false } = opts
  const cancel = cancellation(shouldCancel)
  if (cancel()) return cancelledFile()
  if (isIgnored(rel, false)) return { status: 'skipped' }
  const lp = path.join(localDir, rel.replace(/\//g, path.sep))
  const rp = joinRemotePath(remoteDir, rel)
  let l
  if (cancel()) return cancelledFile()
  try { l = statSync(lp) } catch { return { status: 'missing' } }
  if (maxFileBytes > 0 && l.size > maxFileBytes) return { status: 'skipped' }
  const lk = localKey(l)
  let r = null
  if (cancel()) return cancelledFile()
  try { r = await sftp.stat(rp) } catch (error) {
    if (cancel()) return cancelledFile()
    if (atomicWrites && !remoteAbsent(error)) return { status: 'skipped', skipped: true, ...saveError(error) }
  }
  if (cancel()) return cancelledFile()
  if (atomicWrites && r) r = { size: r.size, mtime: r.mtime }
  const rk = remoteKey(r)
  const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
  if (r && sk && lk === sk && rk === sk) return { status: 'unchanged' }
  if (r && !force && sk && rk !== sk && lk !== sk && rk !== lk) {
    return { status: 'conflict', reason: 'both-modified' }
  }
  if (r && !force && sk && rk !== sk && lk === sk) {
    return { status: 'conflict', reason: 'remote-modified' }
  }
  try {
    let r2 = null
    if (cancel()) return cancelledFile()
    const buf = readFileSync(lp)
    if (cancel()) return cancelledFile()
    if (atomicWrites) r2 = await atomicPush(sftp, rp, buf, r, cancel)
    else {
      if (cancel()) return cancelledFile()
      await sftp.writeFile(rp, buf)
      if (!cancel()) try { r2 = await sftp.stat(rp) } catch {}
    }
    if (cancel()) return { status: 'pushed', cancelled: true } // Commit completed; no snapshot available.
    const rmt = r2 ? r2.mtime : Math.floor(Date.now() / 1000)
    if (cancel()) return { status: 'pushed', cancelled: true }
    try { utimesSync(lp, new Date(rmt * 1000), new Date(rmt * 1000)) } catch {}
    return { status: 'pushed', state: { [rel]: { size: l.size, mtime: rmt } } }
  } catch (e) {
    if (cancelledError(e) || (cancel() && !e?.outcomeUnknown)) return cancelledFile()
    if (atomicWrites) return { status: 'skipped', skipped: true, ...saveError(e) }
    return { status: 'skipped', error: String((e && e.message) || e) }
  }
}
