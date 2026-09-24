// Real-git integration for the /dsh-remote/git `log` / `show` op command
// shapes (git must be installed; skipped when it is not). gitOpHandlers
// itself needs a remote route pool, so these tests pin the EXACT commands
// the ops build against a scratch repository: the --decorate=short pretty
// format (GitLogEntry.refs field form), fixed-roots paging over pinned tips
// (skip through a stable snapshot with the host's hasMore rule) and the
// `show <rev>:<path>` success/failure surfaces the op maps to null/string.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseLogGraphLines, buildLogPage } from '../lib/git-parse.js'

// The suite must never hang on an unavailable `git` binary: these tests are
// pure LOCAL scratch-repo integrations (no network / sshd), but when git
// itself is missing they skip with the reason instead of failing.
const GIT_SKIP = spawnSync('git', ['--version'], { encoding: 'utf8' }).error
  ? 'git is not installed on this machine'
  : false

const PRETTY = '--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D'

// A scratch repo with three commits on main (dates descending, so topo
// order == commit order) and a topic branch pointing at the second commit.
function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-git-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const base = ['git', '-c', 'user.name=Test', '-c', 'user.email=test@dsh', '-c', 'commit.gpgsign=false', '-C', dir]
  const run = (args) => {
    const r = spawnSync('git', [...base.slice(1), ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, args.join(' ') + ' failed: ' + r.stderr)
    return r
  }
  const commit = (file, message, date) => {
    writeFileSync(path.join(dir, file), message + '\n')
    run(['add', file])
    run(['commit', '--date=' + date, '-m', message])
  }
  run(['init', '-b', 'main', '-q'])
  commit('a.txt', 'c1', '2026-01-03T10:00:00+0800')
  commit('b.txt', 'c2', '2026-01-02T10:00:00+0800')
  commit('c.txt', 'c3', '2026-01-01T10:00:00+0800')
  run(['branch', 'topic', 'HEAD~1']) // points at c2
  return { dir, run }
}

test('the `log` legacy command shape parses to full GitLogEntry rows with short ref decorations', { skip: GIT_SKIP }, (t) => {
  const { dir, run } = makeRepo(t)
  // Same argv the logGraph/log legacy branch constructs.
  const res = run(['log', '-n', '30', '--skip', '0', '--topo-order', '--decorate=short', PRETTY])
  const rows = parseLogGraphLines(res.stdout)
  assert.equal(rows.length, 3)
  const [c3, c2, c1] = rows
  assert.equal(c3.subject, 'c3')
  assert.equal(c3.hash.length, 7)
  assert.equal(c3.hashFull.length, 40)
  assert.equal(c3.date, '2026-01-01 10:00:00 +0800')
  assert.equal(c3.refs, 'HEAD -> main', 'short decorations, not refs/heads/…')
  assert.deepEqual(c3.parents, [c2.hashFull])
  assert.deepEqual(c2.parents, [c1.hashFull])
  assert.deepEqual(c1.parents, [], 'root commit')
  assert.equal(c1.refs, '')
  assert.equal(c2.refs, 'topic', 'a branch pointing at an older commit decorates that row')
})

test('fixed-roots paging: pinned tips + skip page a stable snapshot with the host hasMore rule', { skip: GIT_SKIP }, (t) => {
  const { dir, run } = makeRepo(t)
  // roots: [] → the op pins the server's own HEAD^{commit} tip (rev-parse
  // --verify, exactly the resolvePinned command).
  const tip = String(run(['rev-parse', '--verify', 'HEAD^{commit}']).stdout).trim()
  assert.match(tip, /^[0-9a-f]{40}$/)
  const page1 = () => run(['log', '--topo-order', '-n', '2', '--skip', '0', '--decorate=short', PRETTY, tip, '--'])
  const p1 = parseLogGraphLines(page1().stdout)
  const built1 = buildLogPage(p1, 2, 'cursor-for-2')
  assert.equal(built1.hasMore, true, 'a full batch means more')
  assert.equal(p1[0].subject, 'c3')
  assert.equal(p1[1].subject, 'c2')
  // Next page at skip=2 (the value a cursor would carry): same snapshot,
  // continues without overlap.
  const p2 = parseLogGraphLines(run(['log', '--topo-order', '-n', '2', '--skip', '2', '--decorate=short', PRETTY, tip, '--']).stdout)
  const built2 = buildLogPage(p2, 2, 'cursor-for-4')
  assert.equal(built2.hasMore, false, 'a short final page ends the log (and carries no cursor)')
  assert.equal('cursor' in built2, false)
  assert.equal(p2.length, 1)
  assert.equal(p2[0].subject, 'c1')
  assert.equal(p2[0].parents.length, 0)
  const all = [...p1, ...p2]
  assert.equal(new Set(all.map((r) => r.hashFull)).size, 3, 'pages partition the snapshot without overlap')
})

test('fixed roots pin an explicit verified tip: paging a branch tip excludes newer main commits', { skip: GIT_SKIP }, (t) => {
  const { dir, run } = makeRepo(t)
  const tip = String(run(['rev-parse', '--verify', 'topic^{commit}']).stdout).trim()
  const rows = parseLogGraphLines(run(['log', '--topo-order', '-n', '30', '--skip', '0', '--decorate=short', PRETTY, tip, '--']).stdout)
  assert.deepEqual(rows.map((r) => r.subject), ['c2', 'c1'], 'the pinned snapshot ignores commits the tip cannot reach')
})

test('`show` command shape: content at rev:path, null-side on a missing path, index rev works', { skip: GIT_SKIP }, (t) => {
  const { dir, run } = makeRepo(t)
  const show = (rev, p) => spawnSync('git', ['-C', dir, 'show', '--no-ext-diff', '--no-color', '--format=', rev + ':' + p], { encoding: 'utf8' })
  const atHead = show('HEAD', 'a.txt')
  assert.equal(atHead.status, 0)
  assert.equal(atHead.stdout, 'c1\n')
  const missing = show('HEAD', 'nope.txt')
  assert.notEqual(missing.status, 0, 'a path absent from the rev fails non-zero → the op maps it to { content: null }')
  const index = show(':0', 'c.txt')
  assert.equal(index.status, 0, 'rev :0 (index) is part of the contract')
  assert.equal(index.stdout, 'c3\n')
  const firstParent = show('HEAD^', 'a.txt')
  assert.equal(firstParent.status, 0)
  assert.equal(firstParent.stdout, 'c1\n', 'rev syntax like hash^ works')
})