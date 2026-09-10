// dsh-remote — pure git porcelain parsers (no fs, no ssh).
// Split out of lib/index.js so they are unit-testable without loading the
// plugin, in the same spirit as rw_*'s parse helpers (lib/paths.js etc.).
//
// Every function here parses the OUTPUT OF REMOTE `git` commands run by the
// host half's /dsh-remote/git route (the remote git data source behind the
// better-sidebar 'gitSource' slot). The formats are the machine-readable
// ones `git` guarantees under `--porcelain` / `--pretty=format:%x1f…` —
// parsing never depends on locale or color config (commands run with
// `-c color.ui=false --no-pager`).

/**
 * One parsed `git status --porcelain=v1` entry.
 * `path` is REPOSITORY-ROOT-relative (commands run with `-C <root>`);
 * `xy` is the two-letter index/worktree status ('M ', ' M', 'A ', '??', …).
 */
export function parseStatusV1(output) {
  const tokens = output.split('\0')
  const entries = []
  let branch = ''
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    index += 1
    if (token === '') continue
    // The `-b` branch header (first field in -z framing): `## main`,
    // `## main...origin/main [ahead 1, behind 2]`, `## HEAD (no branch)`,
    // `## No commits yet on main` / `## Initial commit on main`.
    if (token.startsWith('## ')) {
      branch = parseBranchHeader(token.slice(3))
      continue
    }
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    // Rename/copy entries carry the ORIGIN path as the next NUL field; the
    // new path (the file as it exists now) is the display path.
    if ((xy[0] === 'R' || xy[0] === 'C') && index < tokens.length && tokens[index] !== '') {
      index += 1
    }
  }
  return { branch, entries }
}

/**
 * The branch name out of a porcelain `-b` header body (the text after
 * `## `): the part before the `...upstream` marker, with the special
 * no-branch and unborn-branch spellings normalized to what the host
 * surfaces (`HEAD` for detached, the would-be name for unborn).
 */
export function parseBranchHeader(body) {
  const s = String(body)
  const unborn = s.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/)
  if (unborn) return unborn[1].trim()
  if (s === 'HEAD (no branch)') return 'HEAD'
  const upstream = s.indexOf('...')
  const name = upstream >= 0 ? s.slice(0, upstream) : s
  return name.trim()
}

/**
 * One raw `git worktree list --porcelain` record. Prunable checkouts are
 * administrative leftovers of vanished directories and must not become
 * command targets; locked ones remain usable.
 */
export function parseWorktreeList(output) {
  const rows = []
  let path
  let branch = 'HEAD'
  let locked = false
  let prunable = false
  const flush = () => {
    if (path !== undefined) rows.push({ path, branch, locked, prunable })
    path = undefined
    branch = 'HEAD'
    locked = false
    prunable = false
  }
  // Production uses newline framing (`git worktree list --porcelain`; -z is
  // accepted for tests/fixtures — paths with embedded newlines are the only
  // lossy case and are pathological).
  const sep = output.includes('\0') ? '\0' : '\n'
  const framed = output.endsWith(sep) ? output : output + sep
  for (const line of framed.split(sep)) {
    if (line === '') {
      flush()
    } else if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'locked' || line.startsWith('locked ') || line.startsWith('locked:')) {
      locked = true
    } else if (line === 'prunable' || line.startsWith('prunable ') || line.startsWith('prunable:')) {
      prunable = true
    }
    // HEAD <sha> / detached lines carry no state we surface.
  }
  return rows
}

/**
 * Parse `git log --topo-order --decorate=full --pretty=format:
 * %H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D` rows (the graph flavor — the format
 * the git panel pages with). Field order: full hash, parents (%P — FULL
 * parent hashes, space separated, first-parent first), subject, author,
 * ISO author date, decorations (`--decorate=full` %D RAW text; '' when no
 * refs point at the row). A root commit has an empty parent field →
 * `parents: []`.
 */
export function parseLogGraphLines(output) {
  const rows = []
  for (const rawLine of String(output).split('\n')) {
    // Windows git may CRLF the pretty lines; strip the trailing \r so the
    // LAST field (refs) never carries it.
    const line = rawLine.replace(/\r$/, '')
    if (line === '') continue
    const [hashFull, parentsRaw, subject, author, date, refs] = line.split('\x1f')
    if (hashFull === undefined || parentsRaw === undefined || subject === undefined) continue
    const parents = parentsRaw === '' ? [] : parentsRaw.split(' ').filter((h) => h !== '')
    rows.push({
      hash: hashFull.slice(0, 7),
      hashFull,
      subject,
      author: author || '',
      date: date || '',
      refs: refs || '',
      parents,
    })
  }
  return rows
}

/**
 * Parse `git for-each-ref --format=%(refname:short)%00%(objectname)
 * refs/heads` lines into [shortName, fullHash] pairs. The NUL separator
 * keeps branch names with '%00'-free arbitrary bytes lossless.
 */
export function parseForEachRefPairs(output) {
  const pairs = []
  for (const line of String(output).split('\n')) {
    const clean = line.replace(/\r$/, '')
    if (clean === '') continue
    const idx = clean.indexOf('\0')
    if (idx < 0) continue
    const name = clean.slice(0, idx)
    const hash = clean.slice(idx + 1)
    if (name !== '' && hash !== '') pairs.push([name, hash])
  }
  return pairs
}

/**
 * Parse `git rev-list --left-right --count HEAD...<ref>` output — the
 * left/right commit counts (ahead/behind), tab- or space-separated, e.g.
 * `3\t1` or `0 0`. Returns [left, right]; any unparseable output degrades
 * to [0, 0] (a caller that got here has already validated the command
 * exit).
 */
export function parseLeftRightCount(output) {
  const m = String(output).trim().match(/^(-?\d+)[\t ]+(-?\d+)/)
  if (!m) return [0, 0]
  return [Number(m[1]), Number(m[2])]
}

/** Number of non-empty `git status --porcelain` rows (a per-worktree dirty count). */
export function countStatusLines(output) {
  let n = 0
  for (const line of String(output).split('\n')) {
    if (line.trim() !== '') n += 1
  }
  return n
}