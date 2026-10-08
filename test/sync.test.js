import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, utimesSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncTree, pushTree, loadSyncState, saveSyncState, pushOneFile } from '../lib/sync.js'
import { MemFs, makeSftp, seed } from './helpers.js'

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-'))
}

const noIgnore = () => false

// Opt-in fixture only: legacy tests intentionally keep their old SFTP surface.
function makeAtomicSftp(fs) {
  const sftp = makeSftp(fs)
  const attrs = async (p) => {
    if (!fs.existsSync(p)) throw Object.assign(new Error(`No such file: ${p}`), { code: 2 })
    return { ...fs.statSync(p), mode: fs.root.get(p).mode ?? 0o100644 }
  }
  sftp.stat = attrs
  sftp.lstat = attrs
  sftp.chmod = async (p, mode) => {
    await attrs(p)
    fs.root.get(p).mode = 0o100000 | mode
  }
  sftp.atomicRename = async (a, b) => {
    await attrs(a)
    fs.root.set(b, fs.root.get(a))
    fs.root.delete(a)
  }
  return sftp
}

const pushModes = [
  ['pushTree', (sftp, local, opts) => pushTree(sftp, local, '/proj', opts)],
  ['pushOneFile', (sftp, local, opts) => pushOneFile(sftp, local, '/proj', 'a.txt', opts)],
]

function assertSaveFailed(result, mode, unknown = false) {
  if (mode === 'pushTree') {
    assert.equal(result.stats.files, 0)
    assert.deepEqual(result.stats.pushed, [])
    assert.equal(result.stats.conflicts.length, 1)
    assert.equal(result.stats.conflicts[0].reason, 'save-failed')
    assert.equal(result.stats.conflicts[0].outcomeUnknown, unknown)
    assert.ok(result.stats.conflicts[0].error)
  } else {
    assert.equal(result.status, 'skipped')
    assert.equal(result.skipped, true)
    assert.equal(result.outcomeUnknown, unknown)
    assert.ok(result.error)
    assert.equal(result.state, undefined)
  }
}

test('first sync downloads everything and writes a state snapshot', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/README.md': '# hi', 'proj/src/main.ts': 'export const a = 1', 'proj/src/deep/x.ts': 'x' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })
  assert.equal(r.stats.files, 3)
  assert.equal(r.stats.conflicts.length, 0)
  assert.equal(readFileSync(path.join(local, 'src', 'main.ts'), 'utf8'), 'export const a = 1')
  assert.equal(r.nextState['README.md'].size, 4)
  // Second run: everything unchanged → skipped.
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r.nextState })
  assert.equal(r2.stats.skippedUnchanged, 3)
  assert.equal(r2.stats.files, 0)
  rmSync(local, { recursive: true, force: true })
})

test('remote change is pulled; local-only change becomes a conflict', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'v1' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })
  assert.equal(r1.stats.files, 1)

  // Remote changed → pull it.
  fs.writeFileSync('/proj/a.txt', 'v2-remote')
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r1.nextState })
  assert.equal(r2.stats.files, 1)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'v2-remote')

  // Local changed after sync, remote untouched → conflict (would clobber local).
  writeFileSync(path.join(local, 'a.txt'), 'v3-local')
  const r3 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r2.nextState })
  assert.equal(r3.stats.files, 0)
  assert.equal(r3.stats.conflicts.length, 1)
  assert.match(r3.stats.conflicts[0].reason, /local-modified/)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'v3-local') // untouched
  // force=true downgrades the conflict to a plain download.
  const r4 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r2.nextState, force: true })
  assert.equal(r4.stats.files, 1)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'v2-remote')
  rmSync(local, { recursive: true, force: true })
})

test('both-modified is a hard conflict, never silently overwritten', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'base' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })
  // Both sides change.
  fs.writeFileSync('/proj/a.txt', 'remote-edit')
  writeFileSync(path.join(local, 'a.txt'), 'local-edit')
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r1.nextState })
  assert.equal(r2.stats.conflicts.length, 1)
  assert.match(r2.stats.conflicts[0].reason, /both-modified/)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'local-edit')
  rmSync(local, { recursive: true, force: true })
})

test('ignore rules keep node_modules out of the mirror', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/package.json': '{}', 'proj/node_modules/x/index.js': 'x' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const isIgnored = (rel) => rel === 'node_modules' || rel.startsWith('node_modules/')
  const r = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored, state: {} })
  assert.equal(r.stats.files, 1)
  assert.equal(existsSync(path.join(local, 'node_modules')), false)
  rmSync(local, { recursive: true, force: true })
})

test('dryRun writes nothing locally', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'v1' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {}, dryRun: true })
  assert.equal(r.stats.files, 1)
  assert.equal(existsSync(path.join(local, 'a.txt')), false)
  rmSync(local, { recursive: true, force: true })
})

test('push: local edit uploads; remote edit + local untouched is a conflict', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'base' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })

  // Local edit → push uploads it.
  writeFileSync(path.join(local, 'a.txt'), 'local-new')
  const p1 = await pushTree(sftp, local, '/proj', { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r1.nextState })
  assert.equal(p1.stats.files, 1)
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'local-new')
  // Remote mtime aligned → next pull skips.
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: p1.nextState })
  assert.equal(r2.stats.skippedUnchanged, 1)

  // Remote edit after push, local untouched → push conflict (would clobber).
  fs.writeFileSync('/proj/a.txt', 'remote-new')
  const p2 = await pushTree(sftp, local, '/proj', { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: p1.nextState })
  assert.equal(p2.stats.conflicts.length, 1)
  assert.match(p2.stats.conflicts[0].reason, /remote-modified/)
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'remote-new') // remote untouched
  rmSync(local, { recursive: true, force: true })
})

test('state file round-trips via load/save', async () => {
  const local = tmpDir()
  saveSyncState(local, { 'a.txt': { size: 3, mtime: 123 } })
  assert.deepEqual(loadSyncState(local), { 'a.txt': { size: 3, mtime: 123 } })
  rmSync(local, { recursive: true, force: true })
})

test('pushOneFile: pushes a local edit, never clobbers a remote change', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'base' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })

  // local edit → pushed
  writeFileSync(path.join(local, 'a.txt'), 'local-new')
  const p1 = await pushOneFile(sftp, local, '/proj', 'a.txt', { state: r1.nextState })
  assert.equal(p1.status, 'pushed')
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'local-new')

  // remote edit, local untouched → conflict, remote preserved
  fs.writeFileSync('/proj/a.txt', 'remote-new')
  const p2 = await pushOneFile(sftp, local, '/proj', 'a.txt', { state: p1.state })
  assert.equal(p2.status, 'conflict')
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'remote-new')
  rmSync(local, { recursive: true, force: true })
})

for (const [mode, push] of pushModes) {
  test(`${mode}: atomic opt-in stages new and existing files; legacy stays direct`, async (t) => {
    for (const exists of [false, true]) {
      const fs = new MemFs()
      seed(fs, exists ? { 'proj/a.txt': 'base' } : {})
      const sftp = makeAtomicSftp(fs)
      const local = tmpDir()
      t.after(() => rmSync(local, { recursive: true, force: true }))
      writeFileSync(path.join(local, 'a.txt'), 'local-new')
      const writes = []
      const write = sftp.writeFile
      sftp.writeFile = async (p, data) => { writes.push(p); return write(p, data) }
      const result = await push(sftp, local, { atomicWrites: true })
      assert.equal(mode === 'pushTree' ? result.stats.files : result.status, mode === 'pushTree' ? 1 : 'pushed')
      assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'local-new')
      assert.equal(writes.length, 1)
      assert.match(writes[0], /^\/proj\/a\.txt\.dsh-write-[a-f0-9]{32}\.tmp$/)
      assert.equal(fs.root.get('/proj/a.txt').mode, exists ? 0o100644 : 0o100600)
      assert.equal([...fs.root.keys()].some(p => p.includes('.dsh-write-')), false)
      writes.length = 0
      writeFileSync(path.join(local, 'a.txt'), 'legacy')
      await push(sftp, local, {})
      assert.deepEqual(writes, ['/proj/a.txt'])
    }
  })

  test(`${mode}: preserves three-way guard and dry-run does not stage`, async (t) => {
    const fs = new MemFs()
    seed(fs, { 'proj/a.txt': 'base' })
    const sftp = makeAtomicSftp(fs)
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    const initial = await syncTree(sftp, '/proj', local)
    fs.writeFileSync('/proj/a.txt', 'remote-new')
    const result = await push(sftp, local, { atomicWrites: true, state: initial.nextState })
    assert.match(mode === 'pushTree' ? result.stats.conflicts[0].reason : result.reason, /remote-modified/)
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'remote-new')
    if (mode === 'pushTree') {
      sftp.writeFile = async () => assert.fail('dry-run must not write')
      const dry = await push(sftp, local, { atomicWrites: true, force: true, dryRun: true })
      assert.equal(dry.stats.files, 1)
    }
  })

  test(`${mode}: captures preflight snapshot instead of recapturing after remote changes`, async (t) => {
    const fs = new MemFs()
    seed(fs, { 'proj/a.txt': 'base' })
    const sftp = makeAtomicSftp(fs)
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    writeFileSync(path.join(local, 'a.txt'), 'local-new')
    const stat = sftp.stat
    let first = true
    sftp.stat = async (p) => {
      const captured = await stat(p)
      if (p === '/proj/a.txt' && first) {
        first = false
        fs.writeFileSync(p, 'concurrent-remote')
      }
      return captured
    }
    sftp.writeFile = async () => assert.fail('snapshot mismatch must reject before staging')
    assertSaveFailed(await push(sftp, local, { atomicWrites: true, force: true }), mode)
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'concurrent-remote')
  })

  for (const exists of [false, true]) test(`${mode}: staged race cannot overwrite ${exists ? 'changed' : 'newly created'} target, even with force`, async (t) => {
    const fs = new MemFs()
    seed(fs, exists ? { 'proj/a.txt': 'base' } : {})
    const sftp = makeAtomicSftp(fs)
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    writeFileSync(path.join(local, 'a.txt'), 'local-new')
    const write = sftp.writeFile
    sftp.writeFile = async (p, data) => {
      await write(p, data)
      fs.writeFileSync('/proj/a.txt', 'concurrent-remote')
    }
    const result = await push(sftp, local, { atomicWrites: true, force: true })
    assertSaveFailed(result, mode)
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'concurrent-remote')
    assert.equal([...fs.root.keys()].some(p => p.includes('.dsh-write-')), false)
  })

  for (const phase of ['initial-stat', 'staging', 'rename', 'postcommit-stat']) test(`${mode}: ${phase} failure is not success and does not advance state`, async (t) => {
    const fs = new MemFs()
    seed(fs, { 'proj/a.txt': 'base' })
    const sftp = makeAtomicSftp(fs)
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    writeFileSync(path.join(local, 'a.txt'), 'local-new')
    const state = { 'a.txt': { size: 4, mtime: fs.statSync('/proj/a.txt').mtime } }
    const failure = Object.assign(new Error(phase === 'rename' ? 'connection reset' : 'permission denied'), { code: phase === 'rename' ? 'ECONNRESET' : 3 })
    let committed = false
    const stat = sftp.stat
    const rename = sftp.atomicRename
    sftp.stat = async (p) => {
      if ((phase === 'initial-stat' || (phase === 'postcommit-stat' && committed)) && p === '/proj/a.txt') throw failure
      return stat(p)
    }
    if (phase === 'staging') sftp.writeFile = async () => { throw failure }
    sftp.atomicRename = async (a, b) => {
      if (phase === 'rename') throw failure
      await rename(a, b)
      committed = true
    }
    const result = await push(sftp, local, { atomicWrites: true, state })
    assertSaveFailed(result, mode, phase === 'rename' || phase === 'postcommit-stat')
    if (mode === 'pushTree') assert.deepEqual(result.nextState, state)
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), committed ? 'local-new' : 'base')
  })

  test(`${mode}: ENOENT is absence but unsupported atomic capability fails closed`, async (t) => {
    const fs = new MemFs()
    const sftp = makeAtomicSftp(fs)
    const stat = sftp.stat
    sftp.stat = sftp.lstat = async (p) => {
      try { return await stat(p) } catch (error) { error.code = 'ENOENT'; throw error }
    }
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    writeFileSync(path.join(local, 'a.txt'), 'local-new')
    const result = await push(sftp, local, { atomicWrites: true })
    assert.equal(mode === 'pushTree' ? result.stats.files : result.status, mode === 'pushTree' ? 1 : 'pushed')
    delete sftp.atomicRename
    writeFileSync(path.join(local, 'a.txt'), 'next')
    assertSaveFailed(await push(sftp, local, { atomicWrites: true }), mode)
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'local-new')
  })
}

test('syncTree sets truncated when maxFiles is hit', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'a', 'proj/b.txt': 'b', 'proj/c.txt': 'c' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r = await syncTree(sftp, '/proj', local, { maxFiles: 1, maxFileBytes: 0, isIgnored: noIgnore, state: {} })
  assert.ok(r.stats.files >= 1)
  assert.equal(r.stats.truncated, true)
  rmSync(local, { recursive: true, force: true })
})


test('queued cancellation performs no IO and preserves snapshots', async () => {
  const calls = []
  const sftp = new Proxy({}, { get: (_, method) => async () => { calls.push(method); throw new Error('unexpected IO') } })
  const state = { 'a.txt': { size: 4, mtime: 123 } }
  const opts = { state, shouldCancel: () => true }
  // Nonexistent local dir proves pushTree does not start local readdir.
  for (const result of [await syncTree(sftp, '/proj', '/no-such-mirror', opts), await pushTree(sftp, '/no-such-mirror', '/proj', opts)]) {
    assert.equal(result.stats.cancelled, true)
    assert.equal(result.stats.files, 0)
    assert.equal(result.stats.dirs, 0)
    assert.equal(result.stats.truncated, false)
    assert.deepEqual(result.stats.conflicts, [])
    assert.deepEqual(result.nextState, state)
  }
  assert.deepEqual(await pushOneFile(sftp, '/no-such-mirror', '/proj', 'a.txt', opts), {
    status: 'skipped', skipped: true, reason: 'cancelled', cancelled: true,
  })
  assert.deepEqual(calls, [])
})

for (const [mode, push] of pushModes) {
  test(`${mode}: staging cancellation cleans temp and never commits or advances state`, async (t) => {
    const fs = new MemFs()
    seed(fs, { 'proj/a.txt': 'base' })
    const sftp = makeAtomicSftp(fs)
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    writeFileSync(path.join(local, 'a.txt'), 'local-new')
    const state = { 'a.txt': { size: 4, mtime: fs.statSync('/proj/a.txt').mtime } }
    const before = statSync(path.join(local, 'a.txt')).mtimeMs
    let cancelled = false
    const write = sftp.writeFile
    sftp.writeFile = async (p, data) => { await write(p, data); cancelled = true }
    let renames = 0
    sftp.atomicRename = async () => { renames++ }
    const result = await push(sftp, local, { atomicWrites: true, state, shouldCancel: () => cancelled })
    if (mode === 'pushTree') {
      assert.equal(result.stats.cancelled, true)
      assert.equal(result.stats.files, 0)
      assert.deepEqual(result.stats.pushed, [])
      assert.deepEqual(result.stats.conflicts, [])
      assert.deepEqual(result.nextState, state)
    } else {
      assert.equal(result.status, 'skipped')
      assert.equal(result.reason, 'cancelled')
      assert.equal(result.cancelled, true)
      assert.equal(result.state, undefined)
      assert.equal(result.error, undefined)
    }
    assert.equal(renames, 0)
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'base')
    assert.equal([...fs.root.keys()].some(p => p.includes('.dsh-write-')), false)
    assert.equal(statSync(path.join(local, 'a.txt')).mtimeMs, before)
  })

  test(`${mode}: cancellation after preflight stops direct write`, async (t) => {
    const fs = new MemFs()
    seed(fs, { 'proj/a.txt': 'base' })
    const sftp = makeSftp(fs)
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    writeFileSync(path.join(local, 'a.txt'), 'local-new')
    let cancelled = false
    const stat = sftp.stat
    sftp.stat = async p => { const attrs = await stat(p); cancelled = true; return attrs }
    let writes = 0
    sftp.writeFile = async () => { writes++ }
    const result = await push(sftp, local, { shouldCancel: () => cancelled })
    assert.equal(mode === 'pushTree' ? result.stats.cancelled : result.reason, mode === 'pushTree' ? true : 'cancelled')
    assert.equal(writes, 0)
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'base')
  })

  test(`${mode}: cancellation during completed direct write reports progress without snapshot`, async (t) => {
    const fs = new MemFs()
    seed(fs, { 'proj/a.txt': 'base' })
    const sftp = makeSftp(fs)
    const local = tmpDir()
    t.after(() => rmSync(local, { recursive: true, force: true }))
    writeFileSync(path.join(local, 'a.txt'), 'local-new')
    const before = statSync(path.join(local, 'a.txt')).mtimeMs
    let cancelled = false
    const write = sftp.writeFile
    sftp.writeFile = async (p, data) => { await write(p, data); cancelled = true }
    const stat = sftp.stat
    sftp.stat = async p => { assert.equal(cancelled, false, 'no postcommit IO after cancellation'); return stat(p) }
    const result = await push(sftp, local, { shouldCancel: () => cancelled })
    if (mode === 'pushTree') {
      assert.equal(result.stats.cancelled, true)
      assert.equal(result.stats.files, 1)
      assert.deepEqual(result.stats.pushed, ['/proj/a.txt'])
      assert.deepEqual(result.nextState, {})
    } else assert.deepEqual(result, { status: 'pushed', cancelled: true })
    assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'local-new')
    assert.equal(statSync(path.join(local, 'a.txt')).mtimeMs, before)
  })
}

test('sync cancellation during read stops local writes and later queued work', async (t) => {
  const fs = new MemFs()
  seed(fs, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`proj/${i}.txt`, 'remote'])))
  const sftp = makeSftp(fs)
  const local = tmpDir()
  t.after(() => rmSync(local, { recursive: true, force: true }))
  let cancelled = false
  const reads = []
  const stats = []
  const stat = sftp.stat
  sftp.stat = async p => { stats.push(p); return stat(p) }
  const read = sftp.readFile
  sftp.readFile = async p => { reads.push(p); const data = await read(p); cancelled = true; return data }
  const result = await syncTree(sftp, '/proj', local, { shouldCancel: () => cancelled })
  assert.equal(result.stats.cancelled, true)
  assert.equal(result.stats.files, 0)
  assert.deepEqual(result.stats.touched, [])
  assert.deepEqual(result.nextState, {})
  assert.ok(reads.length > 0 && reads.length <= 4)
  assert.ok(stats.length <= 4, 'later queued files never start IO')
  for (let i = 0; i < 10; i++) assert.equal(existsSync(path.join(local, `${i}.txt`)), false)
})
