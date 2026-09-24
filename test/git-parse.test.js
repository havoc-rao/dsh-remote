// lib/git-parse.js unit tests: the porcelain parsers behind the remote git
// data source (/dsh-remote/git route). Fixtures are REAL `git` output shapes
// (verified against git 2.x locally) so a parser drift vs git's own formats
// fails here, not on an actual remote host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatusV1, parseBranchHeader, parseWorktreeList, parseLogGraphLines,
  parseForEachRefPairs, parseLeftRightCount, countStatusLines,
  parseHeaderSync, buildWorkspaceMarker,
  isLogRootHash, logPagingGuard, base64urlEncode, base64urlDecode, encodeLogCursor, decodeLogCursor,
  isSafeGitShowPath, buildLogPage,
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

test('parseLogGraphLines: rows with full hashes, parents, short decorations', () => {
  // `--decorate=short` %D text: `HEAD -> main, origin/main` (the
  // GitLogEntry.refs field form — the sidebar classifies the short names).
  const out = [
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b1\u001fa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\u001fsubject one\u001fAuthor One\u001f2026-09-10 10:00:00 +0800\u001fHEAD -> main, origin/main',
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
    refs: 'HEAD -> main, origin/main',
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

test('parseStatusV1: raw -b header body is captured for the marker builders', () => {
  const { header, branch } = parseStatusV1('## main...origin/main [ahead 12]\0 M lib/client.js\0')
  assert.equal(branch, 'main')
  assert.equal(header, 'main...origin/main [ahead 12]')
  assert.equal(parseStatusV1('## HEAD (no branch)\0').header, 'HEAD (no branch)')
  assert.equal(parseStatusV1('\0 M a\0').header, '')
})

test('parseHeaderSync: REAL fixture — ahead-only header from a live repo', () => {
  // Captured verbatim from `git status --porcelain=v1 -b` on this repo:
  // 12 local commits ahead of origin/main, working tree modified.
  assert.deepEqual(parseHeaderSync('main...origin/main [ahead 12]'), {
    branch: 'main', upstream: 'origin/main', ahead: 12, behind: 0,
  })
})

test('parseHeaderSync: every porcelain -b body shape', () => {
  assert.deepEqual(parseHeaderSync('main'), { branch: 'main', ahead: 0, behind: 0 })
  assert.deepEqual(parseHeaderSync('feat/x...origin/feat/x'), {
    branch: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 0,
  })
  assert.deepEqual(parseHeaderSync('main...origin/main [behind 2]'), {
    branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2,
  })
  assert.deepEqual(parseHeaderSync('main...origin/main [ahead 1, behind 2]'), {
    branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2,
  })
  // Upstream configured but its tracking ref no longer exists locally.
  assert.deepEqual(parseHeaderSync('feat/gone...origin/feat/gone [gone]'), {
    branch: 'feat/gone', upstream: 'origin/feat/gone', ahead: 0, behind: 0, gone: true,
  })
  // Detached HEAD and unborn branches keep the established spellings.
  assert.deepEqual(parseHeaderSync('HEAD (no branch)'), { branch: 'HEAD', ahead: 0, behind: 0 })
  assert.deepEqual(parseHeaderSync('No commits yet on dev'), { branch: 'dev', ahead: 0, behind: 0 })
  assert.deepEqual(parseHeaderSync('Initial commit on feat/x'), { branch: 'feat/x', ahead: 0, behind: 0 })
})

test('buildWorkspaceMarker: REAL status snapshot → marker shape', () => {
  // The actual `-z -b` output of this repo right now (see the fixture note
  // above): 3 modified tracked files, all unstaged, 12 ahead.
  const { header, entries } = parseStatusV1(
    '## main...origin/main [ahead 12]\0 M lib/client.js\0 M lib/git-parse.js\0 M lib/index.js\0',
  )
  const marker = buildWorkspaceMarker({ header, entries, branch: 'main' }, '/repo')
  assert.deepEqual(marker, {
    isRepo: true,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 12,
    behind: 0,
    dirty: 3,
    staged: 0,
    root: '/repo',
  })
})

test('buildWorkspaceMarker: staged/untracked split and detached/unborn pass-through', () => {
  const status = parseStatusV1('## feat/x\0M  staged.txt\0 M unstaged.txt\0?? new.txt\0A  added.txt\0 D deleted.txt\0')
  const marker = buildWorkspaceMarker(status, '/r')
  assert.equal(marker.dirty, 5)
  // Index column: 'M ', 'A ' are staged; ' M' and ' D' not; '??' never.
  assert.equal(marker.staged, 2)
  assert.equal(marker.branch, 'feat/x')
  assert.equal(marker.upstream, undefined)
  const unborn = buildWorkspaceMarker(parseStatusV1('## No commits yet on dev\0'), '/r')
  assert.equal(unborn.branch, 'dev')
  assert.equal(unborn.dirty, 0)
  const detached = buildWorkspaceMarker(parseStatusV1('## HEAD (no branch)\0'), '/r')
  assert.equal(detached.branch, 'HEAD')
  // No -b header (unparseable/empty output) → not a repo snapshot.
  assert.equal(buildWorkspaceMarker(parseStatusV1(''), '/r'), null)
})

test('countStatusLines: non-empty porcelain rows only', () => {
  assert.equal(countStatusLines(' M a.txt\n?? b\n\n'), 2)
  assert.equal(countStatusLines(''), 0)
})

// ── Fixed-roots + cursor log pagination helpers (the `log` op) ─────────────

test('isLogRootHash: full lowercase object ids only', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(isLogRootHash(hash), true)
  assert.equal(isLogRootHash(hash.toUpperCase()), false, 'case must match git object-id form')
  assert.equal(isLogRootHash('HEAD'), false, 'ref names are refused before reaching git')
  assert.equal(isLogRootHash('HEAD~2'), false, 'revision syntax is refused')
  assert.equal(isLogRootHash(hash.slice(0, 7)), false, 'short hashes are not pins')
  assert.equal(isLogRootHash(hash + '0'), false, '41 chars')
  assert.equal(isLogRootHash('zz3456789abcdef0123456789abcdef01234567'), false, 'non-hex')
  assert.equal(isLogRootHash(123), false, 'non-string')
  assert.equal(isLogRootHash(undefined), false)
})

test('base64url: RFC 4648 §5 round trip (no padding), invalid input → null', () => {
  // "f" → 0x66 → 'Zg'; 'fo' → 'Zm8'; 'foo' → 'Zm9v'; 'foob' → 'Zm9vYg=='-less.
  assert.equal(base64urlEncode([0x66]), 'Zg')
  assert.equal(base64urlEncode([0x66, 0x6f]), 'Zm8')
  assert.equal(base64urlEncode([0x66, 0x6f, 0x6f]), 'Zm9v')
  assert.deepEqual([...base64urlDecode('Zg')], [0x66])
  assert.deepEqual([...base64urlDecode('Zm8')], [0x66, 0x6f])
  assert.deepEqual([...base64urlDecode('Zm9v')], [0x66, 0x6f, 0x6f])
  // url-safe alphabet + every byte value round trip.
  const bytes = Array.from({ length: 256 }, (_, i) => i)
  assert.deepEqual([...base64urlDecode(base64urlEncode(bytes))], bytes)
  assert.equal(base64urlDecode(''), null)
  assert.equal(base64urlDecode('a'), null, 'length % 4 === 1 is invalid')
  assert.equal(base64urlDecode('Zg+='), null, 'standard alphabet/padding is foreign')
  assert.equal(base64urlDecode('Z g'), null)
  assert.equal(base64urlDecode(42), null, 'non-string')
})

test('encodeLogCursor/decodeLogCursor: opaque round trip with binding fields', () => {
  const state = {
    sessionId: 'ses-1',
    repoKey: '/srv/repo',
    roots: ['0123456789abcdef0123456789abcdef01234567', 'fedcba9876543210fedcba9876543210fedcba98'],
    offset: 60,
  }
  const token = encodeLogCursor(state)
  assert.equal(typeof token, 'string')
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'base64url alphabet only (opaque to clients)')
  assert.equal(token.includes('ses-1'), false, 'never leaks plaintext fields')
  assert.equal(token.includes('/srv'), false)
  assert.deepEqual(decodeLogCursor(token), state)
  // Non-ASCII session ids survive the UTF-8 round trip.
  const cn = encodeLogCursor({ sessionId: '会话-1', repoKey: '/仓库', roots: [], offset: 0 })
  assert.deepEqual(decodeLogCursor(cn), { sessionId: '会话-1', repoKey: '/仓库', roots: [], offset: 0 })
})

test('decodeLogCursor: structurally invalid / forged tokens → null (caller re-anchors)', () => {
  const good = encodeLogCursor({ sessionId: 's', repoKey: '/r', roots: ['0123456789abcdef0123456789abcdef01234567'], offset: 30 })
  assert.notEqual(decodeLogCursor(good), null)
  assert.equal(decodeLogCursor(''), null)
  assert.equal(decodeLogCursor('not-base64!'), null)
  assert.equal(decodeLogCursor('AAAA'), null, 'not JSON')
  assert.equal(decodeLogCursor(undefined), null)
  assert.equal(decodeLogCursor(null), null)
  // Wrong/unknown shape versions are refused (schema drift never parses).
  const foreign = { v: 2, s: 's', r: '/r', t: [], o: 0 }
  assert.equal(decodeLogCursor(base64urlEncode([...new TextEncoder().encode(JSON.stringify(foreign))])), null)
  // Every field is struct-checked: missing session/repo, bad roots (ref
  // names, short hashes, non-strings), negative / fractional / NaN offset.
  const cases = [
    { v: 1, r: '/r', t: [], o: 0 },
    { v: 1, s: 's', t: [], o: 0 },
    { v: 1, s: '', r: '/r', t: [], o: 0 },
    { v: 1, s: 's', r: '', t: [], o: 0 },
    { v: 1, s: 's', r: '/r', o: 0 },
    { v: 1, s: 's', r: '/r', t: 'nope', o: 0 },
    { v: 1, s: 's', r: '/r', t: ['HEAD'], o: 0 },
    { v: 1, s: 's', r: '/r', t: ['abc'], o: 0 },
    { v: 1, s: 's', r: '/r', t: [123], o: 0 },
    { v: 1, s: 's', r: '/r', t: [], o: -1 },
    { v: 1, s: 's', r: '/r', t: [], o: 1.5 },
    { v: 1, s: 's', r: '/r', t: [], o: '30' },
  ]
  for (const bad of cases) {
    assert.equal(decodeLogCursor(base64urlEncode([...new TextEncoder().encode(JSON.stringify(bad))])), null,
      JSON.stringify(bad))
  }
})

test('isSafeGitShowPath: repository-relative blob paths only', () => {
  assert.equal(isSafeGitShowPath('src/a.ts'), true)
  assert.equal(isSafeGitShowPath('a/b/c.txt'), true)
  assert.equal(isSafeGitShowPath('.hidden'), true)
  assert.equal(isSafeGitShowPath('a/./b'), true, 'dot segments are harmless')
  assert.equal(isSafeGitShowPath(''), false)
  assert.equal(isSafeGitShowPath(undefined), false)
  assert.equal(isSafeGitShowPath('/etc/passwd'), false, 'absolute')
  assert.equal(isSafeGitShowPath('../outside'), false)
  assert.equal(isSafeGitShowPath('a/../b'), false, '.. escape mid-path')
  assert.equal(isSafeGitShowPath('a/..'), false)
  assert.equal(isSafeGitShowPath('..'), false)
  assert.equal(isSafeGitShowPath('..\\outside'), false)
  assert.equal(isSafeGitShowPath('a\\b'), false, 'backslash separators')
  assert.equal(isSafeGitShowPath('a//b'), false, 'empty segments')
})

test('buildLogPage: hasMore = page full; cursor only then (host rule)', () => {
  const full = Array.from({ length: 30 }, (_, i) => ({ hash: String(i) }))
  const page = buildLogPage(full, 30, 'cursor-60')
  assert.equal(page.hasMore, true)
  assert.equal(page.cursor, 'cursor-60')
  assert.equal(page.entries.length, 30)
  const short = buildLogPage(full.slice(0, 17), 30, 'cursor-60')
  assert.equal(short.hasMore, false, 'a short page ends the log')
  assert.equal('cursor' in short, false, 'no next cursor without hasMore')
  assert.equal(buildLogPage([], 30, 'x').hasMore, false)
})

test('logPagingGuard: absent twins are valid — anchor page and cursor ride (regression: every anchors request was rejected)', () => {
  // The anchor page sends roots WITH NO cursor (roots: [] = pin the
  // server's own HEAD tip) — the field validation must only fire on a
  // PRESENT field, else every first page fails with
  // "git log cursor must be a non-empty string" (observed in the field:
  // the remote panel's history stayed empty after the fix deployed).
  assert.equal(logPagingGuard([], undefined), null, 'anchor page: roots [] + no cursor')
  assert.equal(logPagingGuard(['a'.repeat(40)], undefined), null, 'anchor page: explicit verified roots + no cursor')
  // A cursor ride sends ONLY the cursor; roots is absent.
  assert.equal(logPagingGuard(undefined, 'eyJ2IjoxfQ'), null, 'cursor ride: no roots')
  // Legacy slide: neither field present.
  assert.equal(logPagingGuard(undefined, undefined), null, 'legacy slide: neither field')
  // Malformed PRESENT fields still fail.
  assert.match(logPagingGuard('main', undefined), /roots must be an array/)
  assert.match(logPagingGuard([42], undefined), /roots must be an array/)
  assert.match(logPagingGuard([], ''), /cursor must be a non-empty string/)
  assert.match(logPagingGuard([], 5), /cursor must be a non-empty string/)
})