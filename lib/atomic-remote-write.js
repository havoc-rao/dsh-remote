import { randomBytes, createHash } from 'node:crypto'
import { stat as localStat } from 'node:fs/promises'

const failure = (code, message) => Object.assign(new Error(message), { code })
const missing = (error) => error?.code === 'ENOENT' || error?.code === 2
const hash = (data) => createHash('sha256').update(data).digest('hex')

async function snapshot(sftp, target) {
  let attrs
  try { attrs = await sftp.lstat(target) } catch (error) {
    if (missing(error)) return null
    throw error
  }
  const type = typeof attrs.mode === 'number' ? attrs.mode & 0o170000 : 0
  if (attrs.isSymbolicLink?.() || type === 0o120000) {
    throw failure('REMOTE_SYMLINK', 'Refusing to replace a remote symlink')
  }
  if (attrs.isDirectory?.() || (type && type !== 0o100000)) {
    throw failure('REMOTE_NOT_FILE', 'Remote target is not a regular file')
  }
  return { mtime: attrs.mtime, size: attrs.size, mode: attrs.mode }
}

function matches(actual, expected) {
  if (actual === null || expected === null) return actual === expected
  return actual.mtime === expected.mtime && actual.size === expected.size
}

async function checkSnapshot(sftp, target, actual, expected, phase) {
  if (!matches(actual, expected) || (expected?.sha256 !== undefined &&
      hash(await sftp.readFile(target)) !== expected.sha256)) {
    throw failure('REMOTE_WRITE_CONFLICT', `Remote file changed ${phase}`)
  }
}

/**
 * Stage a complete file on the same remote filesystem, then commit only with
 * OpenSSH posix-rename (sftp.atomicRename). All SFTP methods are promise based.
 * expected: undefined captures this call's initial {mtime,size}; null requires
 * absence; {mtime,size,sha256?} checks that snapshot at start and precommit.
 * Optional sha256 is the hex SHA256 of the original raw target bytes.
 * Returns {size}; it never retries a failed write or commit.
 *
 * Caveats: the final lstat + rename is NOT an atomic compare-and-swap. Another
 * writer can race that gap, and equal size/mtime (often second precision) can
 * hide changes. Rename guarantees atomic visibility, not crash durability;
 * ownership, ACLs and xattrs are not preserved. Buffer/string writes are read
 * back and SHA256 checked; uploads verify size only, so callers must keep the
 * local source stable. Failed cleanup may leave an orphan sibling temp. A
 * timed-out/disconnected rename carries outcomeUnknown=true: do not replay it.
 * Temp names use 128-bit randomness; writeFileExclusive is preferred when
 * available. fastPut cannot enforce exclusive creation. The parent directory
 * must be trusted (a malicious peer can tamper with staging paths). New files
 * are chmod 0600 before commit; staging defaults still depend on server umask.
 */
export async function atomicRemoteWrite(sftp, target, { data, localPath, expected, shouldCancel = () => false } = {}) {
  const checkCancelled = () => { if (shouldCancel()) throw failure('CANCELLED', 'Remote write cancelled before commit') }
  checkCancelled()
  if (typeof target !== 'string' || !target || /[\\/]$/.test(target)) {
    throw new TypeError('A remote file target is required')
  }
  const uploading = localPath !== undefined
  if (uploading === (data !== undefined)) {
    throw new TypeError('Supply exactly one of data or localPath')
  }
  for (const method of ['atomicRename', 'lstat', 'stat', 'unlink', 'chmod', uploading ? 'fastPut' : (typeof sftp?.writeFileExclusive === 'function' ? 'writeFileExclusive' : 'writeFile'), ...(!uploading || expected?.sha256 !== undefined ? ['readFile'] : [])]) {
    if (typeof sftp?.[method] !== 'function') {
      throw failure('ATOMIC_WRITE_UNSUPPORTED', `Atomic remote write requires sftp.${method}; no unsafe fallback is available`)
    }
  }
  if (expected !== undefined && expected !== null &&
      (typeof expected !== 'object' || !Number.isFinite(expected.mtime) || !Number.isFinite(expected.size))) {
    throw new TypeError('expected must be null or a {mtime,size} snapshot')
  }
  if (expected?.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new TypeError('expected.sha256 must be a lowercase SHA256 hex digest')
  }
  const initial = await snapshot(sftp, target)
  const guard = expected === undefined ? initial : expected
  await checkSnapshot(sftp, target, initial, guard, 'before staging')
  let bytes
  let size
  let sourceSnapshot
  if (uploading) {
    const attrs = await localStat(localPath)
    sourceSnapshot = { size: attrs.size, mtimeMs: attrs.mtimeMs, ctimeMs: attrs.ctimeMs, ino: attrs.ino, dev: attrs.dev }
    if (!attrs.isFile()) throw new TypeError('Local upload source must be a regular file')
    size = attrs.size
  } else {
    if (typeof data !== 'string' && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
      throw new TypeError('data must be a string, Buffer or Uint8Array')
    }
    // Copy caller-owned bytes so mutations while awaiting cannot alter the hash.
    bytes = Buffer.from(data)
    size = bytes.length
  }
  const temp = `${target}.dsh-write-${randomBytes(16).toString('hex')}.tmp`
  try {
    checkCancelled()
    if (uploading) await sftp.fastPut(localPath, temp)
    else if (typeof sftp.writeFileExclusive === 'function') await sftp.writeFileExclusive(temp, bytes)
    else await sftp.writeFile(temp, bytes)
    checkCancelled()
    if (uploading) {
      const current = await localStat(localPath)
      if (!current.isFile() || Object.entries(sourceSnapshot).some(([key, value]) => current[key] !== value)) {
        throw failure('LOCAL_UPLOAD_CHANGED', 'Local upload source changed during staging; reread and retry')
      }
    }
    const staged = await sftp.stat(temp)
    if (staged.size !== size) throw failure('REMOTE_WRITE_VERIFY_FAILED', 'Staged remote file size mismatch')
    if (!uploading && hash(await sftp.readFile(temp)) !== hash(bytes)) {
      throw failure('REMOTE_WRITE_VERIFY_FAILED', 'Staged remote file content mismatch')
    }
    await sftp.chmod(temp, initial && typeof initial.mode === 'number' ? initial.mode & 0o7777 : 0o600)
    await checkSnapshot(sftp, target, await snapshot(sftp, target), guard, 'before commit')
    checkCancelled()
    try { await sftp.atomicRename(temp, target) } catch (error) {
      // The timeout wrapper cannot know whether the server already committed.
      if (/timed?\s*out|timeout|channel closed|disconnect|connection|socket|EOF/i.test(error?.message || '') ||
          ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTCONN'].includes(error?.code)) {
        error.outcomeUnknown = true
      }
      throw error
    }
    return { size }
  } catch (error) {
    try { await sftp.unlink(temp) } catch (cleanupError) {
      // Preserve the primary error, including outcomeUnknown, for safe callers.
      if (error && typeof error === 'object') error.cleanupError = cleanupError
    }
    throw error
  }
}
