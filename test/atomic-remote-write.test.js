import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicRemoteWrite } from '../lib/atomic-remote-write.js'

const target = '/remote/document.txt'
const err = (code, message = String(code)) => Object.assign(new Error(message), { code })
function fake({ exists = true, mode = 0o100640 } = {}) {
  const files = new Map(exists ? [[target, { data: Buffer.from('original'), mtime: 42, mode }]] : [])
  const calls = []
  const attrs = (p) => {
    const f = files.get(p)
    if (!f) throw err(2, 'No such file')
    return { size: f.data.length, mtime: f.mtime, mode: f.mode }
  }
  const sftp = {
    lstat: async (p) => { calls.push(['lstat', p]); return attrs(p) },
    stat: async (p) => { calls.push(['stat', p]); return attrs(p) },
    writeFile: async (p, data) => { calls.push(['writeFile', p]); files.set(p, { data: Buffer.from(data), mtime: 43, mode: 0o100600 }) },
    readFile: async (p) => { calls.push(['readFile', p]); return files.get(p).data },
    fastPut: async (lp, p) => { calls.push(['fastPut', lp, p]); files.set(p, { data: await readFile(lp), mtime: 43, mode: 0o100600 }) },
    chmod: async (p, permissions) => { calls.push(['chmod', p, permissions]); files.get(p).mode = 0o100000 | permissions },
    unlink: async (p) => { calls.push(['unlink', p]); files.delete(p) },
    atomicRename: async (p, dest) => { calls.push(['atomicRename', p, dest]); files.set(dest, files.get(p)); files.delete(p) },
    rename: async () => { assert.fail('Unsafe ordinary rename must never be called') },
  }
  return { files, calls, sftp }
}
const contents = (f) => f.files.get(target).data.toString()
const renames = (f) => f.calls.filter(([op]) => op === 'atomicRename')

test('success stages random sibling, verifies data, preserves permissions and commits once', async () => {
  const f = fake()
  assert.deepEqual(await atomicRemoteWrite(f.sftp, target, { data: 'replacement' }), { size: 11 })
  assert.equal(contents(f), 'replacement')
  assert.equal(f.files.get(target).mode, 0o100640)
  assert.equal(f.files.size, 1)
  assert.equal(renames(f).length, 1)
  const temp = renames(f)[0][1]
  assert.match(temp, /^\/remote\/document\.txt\.dsh-write-[a-f0-9]{32}\.tmp$/)
  assert.ok(f.calls.find(([op]) => op === 'readFile'))
  assert.deepEqual(f.calls.filter(([op]) => op === 'chmod')[0], ['chmod', temp, 0o640])
  assert.equal(f.calls.filter(([op]) => op === 'lstat').length, 2)
})

test('cancel before staging performs no IO', async () => {
  const f = fake()
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new', shouldCancel: () => true }), { code: 'CANCELLED' })
  assert.deepEqual(f.calls, [])
})

test('cancel during staging preserves destination and cleans temp', async () => {
  const f = fake()
  let cancelled = false
  const write = f.sftp.writeFile
  f.sftp.writeFile = async (...args) => { await write(...args); cancelled = true }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new', shouldCancel: () => cancelled }), { code: 'CANCELLED' })
  assert.equal(contents(f), 'original')
  assert.equal(renames(f).length, 0)
  assert.equal(f.files.size, 1)
})

test('incomplete rejected staging write cannot replace original', async () => {
  const f = fake()
  const writeError = err('EIO', 'Write interrupted')
  f.sftp.writeFile = async (p) => { f.files.set(p, { data: Buffer.from('partial') }); throw writeError }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new data' }), (e) => e === writeError)
  assert.equal(contents(f), 'original')
  assert.equal(f.files.size, 1)
  assert.equal(renames(f).length, 0)
})

test('unsupported atomic rename fails before staging, never falls back', async () => {
  const f = fake()
  delete f.sftp.atomicRename
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), { code: 'ATOMIC_WRITE_UNSUPPORTED' })
  assert.deepEqual(f.calls, [])
  assert.equal(contents(f), 'original')
})

test('permission preservation requires chmod and chmod errors abort commit', async () => {
  const f = fake()
  delete f.sftp.chmod
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), { code: 'ATOMIC_WRITE_UNSUPPORTED' })
  assert.equal(f.files.size, 1)
  f.sftp.chmod = async () => { throw err('EPERM') }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), { code: 'EPERM' })
  assert.equal(contents(f), 'original')
  assert.equal(f.files.size, 1)
  assert.equal(renames(f).length, 0)
})

test('expected mismatch rejects before staging', async () => {
  const f = fake()
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new', expected: { size: 8, mtime: 41 } }), { code: 'REMOTE_WRITE_CONFLICT' })
  assert.equal(f.calls.length, 1)
  assert.equal(contents(f), 'original')
})

for (const explicit of [false, true]) {
  test(`precommit conflict preserves other writer (${explicit ? 'explicit' : 'own'} snapshot)`, async () => {
    const f = fake()
    const write = f.sftp.writeFile
    f.sftp.writeFile = async (...args) => {
      await write(...args)
      f.files.set(target, { data: Buffer.from('concurrent'), mtime: 44, mode: 0o100644 })
    }
    await assert.rejects(atomicRemoteWrite(f.sftp, target, {
      data: 'new', ...(explicit ? { expected: { size: 8, mtime: 42 } } : {}),
    }), { code: 'REMOTE_WRITE_CONFLICT' })
    assert.equal(contents(f), 'concurrent')
    assert.equal(f.files.size, 1)
    assert.equal(renames(f).length, 0)
  })
}

test('symlink rejected at start and when substituted before commit', async () => {
  const f = fake({ mode: 0o120777 })
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), { code: 'REMOTE_SYMLINK' })
  assert.equal(f.calls.length, 1)
  f.files.get(target).mode = 0o100640
  f.sftp.chmod = async () => { f.files.get(target).mode = 0o120777 }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), { code: 'REMOTE_SYMLINK' })
  assert.equal(contents(f), 'original')
  assert.equal(f.files.size, 1)
  assert.equal(renames(f).length, 0)
})

test('same-length corrupted buffer fails readback verification', async () => {
  const f = fake()
  f.sftp.readFile = async () => Buffer.from('bad')
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: Buffer.from('new') }), { code: 'REMOTE_WRITE_VERIFY_FAILED' })
  assert.equal(contents(f), 'original')
  assert.equal(renames(f).length, 0)
  assert.equal(f.files.size, 1)
})

test('upload size mismatch preserves original; success uses local,remote order', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-atomic-write-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.txt')
  await writeFile(source, 'upload')
  const f = fake()
  const put = f.sftp.fastPut
  f.sftp.fastPut = async (lp, p) => { await put(lp, p); f.files.get(p).data = Buffer.from('short') }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { localPath: source }), { code: 'REMOTE_WRITE_VERIFY_FAILED' })
  assert.equal(contents(f), 'original')
  assert.equal(f.files.size, 1)
  assert.equal(renames(f).length, 0)
  f.sftp.fastPut = put
  await atomicRemoteWrite(f.sftp, target, { localPath: source })
  assert.equal(contents(f), 'upload')
  assert.equal(f.calls.find(([op]) => op === 'fastPut')[1], source)
  assert.equal(f.files.get(target).mode, 0o100640)
})

test('source mutation during upload aborts before remote commit', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-atomic-source-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.bin')
  await writeFile(source, 'upload')
  const f = fake()
  const put = f.sftp.fastPut
  f.sftp.fastPut = async (lp, p) => { await put(lp, p); await writeFile(lp, 'changed-size') }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { localPath: source }), { code: 'LOCAL_UPLOAD_CHANGED' })
  assert.equal(contents(f), 'original')
  assert.equal(renames(f).length, 0)
  assert.equal(f.files.size, 1)
})

test('cleanup failure retains primary error and original', async () => {
  const f = fake()
  const writeError = err('EIO')
  const cleanupError = err('EPERM')
  f.sftp.writeFile = async (p) => { f.files.set(p, { data: Buffer.from('partial') }); throw writeError }
  f.sftp.unlink = async () => { throw cleanupError }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), (e) => e === writeError && e.cleanupError === cleanupError)
  assert.equal(contents(f), 'original')
  assert.equal(renames(f).length, 0)
  assert.equal(f.files.size, 2, 'orphan temp is explicit best-effort cleanup limitation')
})

test('rename timeout labels unknown outcome, even if server committed', async () => {
  const f = fake()
  const rename = f.sftp.atomicRename
  f.sftp.atomicRename = async (...args) => { await rename(...args); throw err('ETIMEDOUT', 'sftp operation timed out') }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), (e) => e.outcomeUnknown === true)
  assert.equal(contents(f), 'new', 'timeout is not evidence of rollback')
  assert.equal(renames(f).length, 1, 'commit is never replayed')
})

test('only ENOENT and numeric SFTP code 2 mean absent', async () => {
  for (const code of [2, 'ENOENT']) {
    const f = fake({ exists: false })
    const lstat = f.sftp.lstat
    f.sftp.lstat = async (p) => { try { return await lstat(p) } catch { throw err(code) } }
    await atomicRemoteWrite(f.sftp, target, { data: 'created', expected: null })
    assert.equal(contents(f), 'created')
    assert.equal(f.files.get(target).mode, 0o100600, 'new file permissions are private')
  }
  for (const code of ['EACCES', '2', 4]) {
    const f = fake()
    f.sftp.lstat = async () => { throw err(code) }
    await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new' }), (e) => e.code === code)
    assert.equal(contents(f), 'original')
    assert.equal(renames(f).length, 0)
  }
})

test('optional original hash catches same-size same-mtime edits at both checks', async () => {
  const digest = createHash('sha256').update('original').digest('hex')
  const expected = { size: 8, mtime: 42, sha256: digest }
  const f = fake()
  f.files.get(target).data = Buffer.from('modified')
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new', expected }), { code: 'REMOTE_WRITE_CONFLICT' })
  assert.equal(f.calls.some(([op]) => op === 'writeFile'), false)
  f.files.get(target).data = Buffer.from('original')
  const write = f.sftp.writeFile
  f.sftp.writeFile = async (...args) => { await write(...args); f.files.get(target).data = Buffer.from('modified') }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new', expected }), { code: 'REMOTE_WRITE_CONFLICT' })
  assert.equal(contents(f), 'modified')
  assert.equal(renames(f).length, 0)
  assert.equal(f.files.size, 1)
})

test('exclusive staging is preferred when exposed by pool', async () => {
  const f = fake()
  f.sftp.writeFileExclusive = f.sftp.writeFile
  f.sftp.writeFile = async () => { assert.fail('Nonexclusive writer must not be used') }
  await atomicRemoteWrite(f.sftp, target, { data: 'new' })
  assert.equal(contents(f), 'new')
})

test('absent target appearing during staging is a conflict', async () => {
  const f = fake({ exists: false })
  const write = f.sftp.writeFile
  f.sftp.writeFile = async (...args) => { await write(...args); f.files.set(target, { data: Buffer.from('other'), mtime: 45, mode: 0o100600 }) }
  await assert.rejects(atomicRemoteWrite(f.sftp, target, { data: 'new', expected: null }), { code: 'REMOTE_WRITE_CONFLICT' })
  assert.equal(contents(f), 'other')
  assert.equal(f.files.size, 1)
})
