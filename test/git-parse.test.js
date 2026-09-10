// lib/git-parse.js unit tests: the porcelain parsers behind the remote git
// data source (/dsh-remote/git route). Fixtures are REAL `git` output shapes
// (verified against git 2.x locally) so a parser drift vs git's own formats
// fails here, not on an actual remote host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatusV1, parseBranchHeader, parseWorktreeList, parseLogGraphLines,
  parseForEachRefPairs, parseLeftRightCount, countStatusLines,
} from '../lib/git-parse.js'

test('parseStatusV1: plain branch + entries (porcelain v1 -z -b)', () => {
  const { branch, entries } = parseStatusV1('## main\0M  a.txt\0 M b.txt\0?? c.txt\0')
  assert.equal(branch, 'main')
  assert.deepEqual(entries, [
    { path: 'a.txt', xy: 'M ' },
    { path: 'b.txt', xy: ' M' },
    { path: 'c.txt', xy: '??' },
  ])
})

test('parseStatusV1: upstream + ahead/behind header is stripped from branch', () => {
  const { branch, entries } = parseStatusV1('## feature/x...origin/feature/x [ahead 1, behind 2]\0A  new.txt\0')
  assert.equal(branch, 'feature/x')
  assert.deepEqual(entries, [{ path: 'new.txt', xy: 'A ' }])
})

test('parseStatusV1: detached HEAD and unborn branch headers', () => {
  assert.equal(parseStatusV1('## HEAD (no branch)\0').branch, 'HEAD')
  assert.equal(parseStatusV1('## No commits yet on main\0').branch, 'main')
  assert.equal(parseStatusV1('## Initial commit on main\0').branch, 'main')
})

test('parseStatusV1: rename/copy entries collapse the origin-path field', () => {
  const { entries } = parseStatusV1('## main\0R  new.txt\0old.txt\0C  copied.txt\0src.txt\0')
  assert.deepEqual(entries, [
    { path: 'new.txt', xy: 'R ' },
    { path: 'copied.txt', xy: 'C ' },
  ])
})

test('parseStatusV1: empty output (clean tree) → no branch, no entries', () => {
  const { branch, entries } = parseStatusV1('')
  assert.equal(branch, '')
  assert.deepEqual(entries, [])
})

test('parseStatusV1: non-ASCII filenames pass through', () => {
  const { entries } = parseStatusV1('## main\0M  中文 文件.txt\0')
  assert.deepEqual(entries, [{ path: '中文 文件.txt', xy: 'M ' }])
})

test('parseBranchHeader: upstream marker and whitespace', () => {
  assert.equal(parseBranchHeader('main...origin/main [ahead 1]'), 'main')
  assert.equal(parseBranchHeader('  topic  '), 'topic')
  assert.equal(parseBranchHeader('HEAD (no branch)'), 'HEAD')
})

test('parseWorktreeList: main + linked checkout records', () => {
  const rows = parseWorktreeList([
    'worktree /srv/proj',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/main',
    '',
    'worktree /srv/proj-wt',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/feat/x',
    'locked reason: in use',
    '',
  ].join('\n'))
  assert.deepEqual(rows, [
    { path: '/srv/proj', branch: 'main', locked: false, prunable: false },
    { path: '/srv/proj-wt', branch: 'feat/x', locked: true, prunable: false },
  ])
})

test('parseWorktreeList: detached checkout reports HEAD; prunable flagged', () => {
  const rows = parseWorktreeList([
    'worktree /srv/proj',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'detached',
    '',
    'worktree /srv/gone',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/old',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n'))
  assert.deepEqual(rows, [
    { path: '/srv/proj', branch: 'HEAD', locked: false, prunable: false },
    { path: '/srv/gone', branch: 'old', locked: false, prunable: true },
  ])
})

test('parseWorktreeList: -z framing and Windows paths', () => {
  const rows = parseWorktreeList('worktree C:\\proj\0HEAD 0123456789abcdef0123456789abcdef01234567\0branch refs/heads/main\0\0')
  assert.deepEqual(rows, [{ path: 'C:\\proj', branch: 'main', locked: false, prunable: false }])
})

test('parseLogGraphLines: rows with full hashes, parents, raw full decorations', () => {
  const out = [
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b1\u001fa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\u001fsubject one\u001fAuthor One\u001f2026-09-10 10:00:00 +0800\u001fHEAD -> refs/heads/main, refs/remotes/origin/main',
    'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\u001f\u001froot commit\u001fAuthor Two\u001f2026-09-01 08:00:00 +0000\u001f',
    '',
  ].join('\n')
  const rows = parseLogGraphLines(out)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    hash: 'a1b2c3d',
    hashFull: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b1',
    subject: 'subject one',
    author: 'Author One',
    date: '2026-09-10 10:00:00 +0800',
    refs: 'HEAD -> refs/heads/main, refs/remotes/origin/main',
    parents: ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
  })
  assert.equal(rows[0].hash.length, 7)
  // Root commit: empty %P → parents [] and no refs.
  assert.deepEqual(rows[1].parents, [])
  assert.equal(rows[1].refs, '')
  assert.equal(rows[1].hashFull, 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')
})

test('parseLogGraphLines: merge commit parents keep %P order', () => {
  const rows = parseLogGraphLines('m1m2m3m4m5m6m7m8m9m0m1m2m3m4m5m6m7m8m9m0\u001fp1p2p3p4p5p6p7p8p9p0p1p2p3p4p5p6p7p8p9p0 p1p2p3p4p5p6p7p8p9p0p1p2p3p4p5p6p7p8p9q0\u001fmerge\u001fA\u001f2026-01-01 00:00:00 +0000\u001f')
  assert.deepEqual(rows[0].parents, [
    'p1p2p3p4p5p6p7p8p9p0p1p2p3p4p5p6p7p8p9p0',
    'p1p2p3p4p5p6p7p8p9p0p1p2p3p4p5p6p7p8p9q0',
  ])
})

test('parseForEachRefPairs: name/hash pairs', () => {
  const pairs = parseForEachRefPairs('main\u0000a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b1\nfeat/x\u0000b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n')
  assert.deepEqual(pairs, [
    ['main', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b1'],
    ['feat/x', 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
  ])
})

test('parseLeftRightCount: tab and space separators, garbage → 0/0', () => {
  assert.deepEqual(parseLeftRightCount('3\t1'), [3, 1])
  assert.deepEqual(parseLeftRightCount('0 0'), [0, 0])
  assert.deepEqual(parseLeftRightCount('\n12\t4\n'), [12, 4])
  assert.deepEqual(parseLeftRightCount(''), [0, 0])
  assert.deepEqual(parseLeftRightCount('fatal: not a revision'), [0, 0])
})

test('countStatusLines: non-empty porcelain rows only', () => {
  assert.equal(countStatusLines(' M a.txt\n?? b\n\n'), 2)
  assert.equal(countStatusLines(''), 0)
})