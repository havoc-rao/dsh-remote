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
  let header = ''
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    index += 1
    if (token === '') continue
    // The `-b` branch header (first field in -z framing): `## main`,
    // `## main...origin/main [ahead 1, behind 2]`, `## HEAD (no branch)`,
    // `## No commits yet on main` / `## Initial commit on main`.
    if (token.startsWith('## ')) {
      header = token.slice(3)
      branch = parseBranchHeader(header)
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
  return { branch, header, entries }
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
 * Parse `git log --topo-order --decorate=short --pretty=format:
 * %H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D` rows (the graph flavor — the format
 * the git panel pages with; the `log` op's fixed-roots pagination reuses
 * it verbatim). Field order: full hash, parents (%P — FULL parent hashes,
 * space separated, first-parent first), subject, author, ISO author date,
 * decorations (`--decorate=short` %D text — e.g. `HEAD -> main,
 * origin/main` in the GitLogEntry.refs form; '' when no refs point at the
 * row). A root commit has an empty parent field → `parents: []`.
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

/**
 * Parse the porcelain `-b` header BODY (the text after `## `) into the
 * workspace-marker sync state: branch name + configured upstream +
 * ahead/behind counts (and the `[gone]` marker for a configured upstream
 * whose tracking ref no longer exists locally). Bodies (git 2.x):
 *
 *   `main`                              → { branch: 'main', ahead: 0, behind: 0 }
 *   `main...origin/main`                → + upstream: 'origin/main'
 *   `main...origin/main [ahead 1]`      → + ahead: 1
 *   `main...origin/main [behind 2]`     → + behind: 2
 *   `main...origin/main [ahead 1, behind 2]`
 *   `main...origin/main [gone]`         → + gone: true
 *   `HEAD (no branch)`                  → { branch: 'HEAD' } (detached)
 *   `No commits yet on dev` / `Initial commit on dev` → unborn → branch 'dev'
 *
 * Refnames cannot contain `..` (git check-ref-format), so the first `...`
 * is always the branch/upstream separator. Always returns numeric `ahead` /
 * `behind` (0 when absent) so the marker shape stays uniform.
 */
export function parseHeaderSync(body) {
  const s = String(body)
  const unborn = s.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/)
  if (unborn) return { branch: unborn[1].trim(), ahead: 0, behind: 0 }
  if (s === 'HEAD (no branch)') return { branch: 'HEAD', ahead: 0, behind: 0 }
  let rest = s
  let ahead = 0
  let behind = 0
  let gone = false
  const bracket = rest.match(/\s*\[([^\]]*)\]$/)
  if (bracket) {
    rest = rest.slice(0, rest.length - bracket[0].length)
    const inner = bracket[1]
    if (inner === 'gone') {
      gone = true
    } else {
      const a = /ahead\s+(\d+)/.exec(inner)
      const b = /behind\s+(\d+)/.exec(inner)
      if (a) ahead = Number(a[1])
      if (b) behind = Number(b[1])
    }
  }
  const idx = rest.indexOf('...')
  const branch = (idx >= 0 ? rest.slice(0, idx) : rest).trim()
  const upstream = idx >= 0 ? rest.slice(idx + 3).trim() : ''
  const out = { branch, ahead, behind }
  if (upstream !== '') out.upstream = upstream
  if (gone) out.gone = true
  return out
}

/**
 * Build the workspace git-marker JSON served by /dsh-remote/git-workspace
 * from one parsed porcelain status (parseStatusV1) + the repo top level:
 * branch (or detached short sha, resolved by the caller) + dirty/staged
 * counts + upstream sync state. Returns null when the status is not a repo
 * snapshot (no `-b` branch header — the marker for "not a repository" is
 * built by the caller from this shape: `{ isRepo: false }`).
 */
export function buildWorkspaceMarker(status, root) {
  if (!status || typeof status.branch !== 'string' || status.branch === '') return null
  const sync = parseHeaderSync(status.header || '')
  const entries = Array.isArray(status.entries) ? status.entries : []
  let staged = 0
  for (const e of entries) {
    const x = e && e.xy && e.xy[0]
    // Porcelain XY: the first column is the index (staged) state — ' ' when
    // untouched, '?' for untracked rows (both columns '?'), anything else
    // (M/A/D/R/C…) is a staged change.
    if (x !== undefined && x !== ' ' && x !== '?') staged += 1
  }
  const marker = {
    isRepo: true,
    branch: sync.branch || status.branch || 'HEAD',
    dirty: entries.length,
    staged,
    ahead: sync.ahead,
    behind: sync.behind,
    root,
  }
  if (sync.upstream !== undefined) marker.upstream = sync.upstream
  if (sync.gone === true) marker.gone = true
  return marker
}

// ── Fixed-roots + cursor log pagination (the `log` op) ─────────────────────
// Mirrors the host sidebar's git.log fixed-roots mode: `roots: []` pins the
// server's own HEAD tip, later pages ride an OPAQUE cursor (never parsed by
// clients) bound to its snapshot's session + repository + pinned roots +
// next offset. Cursors here are STATELESS base64url JSON: a malformed or
// foreign token decodes to a binding mismatch and the caller discards it,
// re-anchoring on the server's own tips — never reusing another snapshot's
// offset (never paging repo B at repo A's cursor position).

/** A pinned log root must be a full object id — ref names / revision syntax
 *  (`HEAD~2`, `:path`, …) are rejected before ever reaching `git log`. */
export function isLogRootHash(candidate) {
  return typeof candidate === 'string' && /^[0-9a-f]{40}$/.test(candidate)
}

/** Wire-shape guard for the fixed-roots `log` op (host git.log parity):
 *  each field is validated ONLY when present — the anchor page legitimately
 *  sends `roots` with NO cursor (`roots: []` = pin the server's own HEAD
 *  tip), and a cursor ride sends ONLY the cursor with roots absent.
 *  Rejecting the absent twin would kill both fixed-roots paths. Returns an
 *  error message, or null when the shape is usable. */
export function logPagingGuard(roots, cursor) {
  if (roots !== undefined && (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string'))) {
    return 'git log roots must be an array of commit hashes'
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor === '')) {
    return 'git log cursor must be a non-empty string'
  }
  return null
}

/** base64url (RFC 4648 §5, no padding) — pure JS over a byte array, no
 *  Buffer/TextEncoder dependency at call sites (Node and browser alike). */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
export function base64urlEncode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64URL[b0 >> 2]
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)]
    if (i + 1 < bytes.length) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)]
    if (i + 2 < bytes.length) out += B64URL[b2 & 63]
  }
  return out
}

/** Decode base64url back to a Uint8Array; null when the text is not valid
 *  base64url of this shape (empty, bad length, foreign characters). */
export function base64urlDecode(text) {
  if (typeof text !== 'string' || text === '' || text.length % 4 === 1) return null
  if (/[^A-Za-z0-9_-]/.test(text)) return null
  const bytes = []
  for (let i = 0; i < text.length; i += 4) {
    const chunk = text.slice(i, i + 4)
    let acc = 0
    for (let j = 0; j < 4; j++) {
      const c = j < chunk.length ? chunk[j] : 'A'
      const v = B64URL.indexOf(c)
      if (v < 0) return null
      acc = (acc << 6) | v
    }
    bytes.push((acc >> 16) & 255)
    if (chunk.length >= 3) bytes.push((acc >> 8) & 255)
    if (chunk.length === 4) bytes.push(acc & 255)
  }
  return new Uint8Array(bytes)
}

/** Encode one opaque log-page cursor (stateless): the snapshot's session +
 *  repository binding, its pinned (verified) roots and the NEXT page offset.
 *  The token is opaque TO CLIENTS; the server re-validates every field on
 *  use, so a forged or foreign token is discarded and re-anchored. */
export function encodeLogCursor(state) {
  const body = {
    v: 1,
    s: String((state && state.sessionId) || ''),
    r: String((state && state.repoKey) || ''),
    t: Array.isArray(state && state.roots) ? [...state.roots] : [],
    o: Number.isInteger(state && state.offset) && state.offset >= 0 ? state.offset : 0,
  }
  return base64urlEncode([...new TextEncoder().encode(JSON.stringify(body))])
}

/** Decode + STRUCTURALLY validate a cursor token: null when it is not a
 *  well-formed token of this shape (callers then discard it and re-anchor on
 *  the server's own tips). The session/repository BINDING and the roots'
 *  hash verification still happen caller-side against the live repo. */
export function decodeLogCursor(token) {
  let raw = null
  try {
    const bytes = base64urlDecode(String(token))
    if (bytes === null) return null
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!raw || raw.v !== 1 || typeof raw.s !== 'string' || raw.s === ''
    || typeof raw.r !== 'string' || raw.r === ''
    || !Number.isInteger(raw.o) || raw.o < 0
    || !Array.isArray(raw.t) || !raw.t.every(isLogRootHash)) {
    return null
  }
  return { sessionId: raw.s, repoKey: raw.r, roots: raw.t, offset: raw.o }
}

/** Whether a `git show <rev>:<path>` path is safe to splice into the
 *  revision-tree syntax: non-empty, repository-relative, no absolute prefix,
 *  no backslash separators and no `..` escape segments (the rev:path form
 *  addresses blobs INSIDE the revision tree — never host paths). */
export function isSafeGitShowPath(path) {
  if (typeof path !== 'string' || path === '') return false
  if (path.includes('\\')) return false
  if (path.startsWith('/')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '..')
}

/** Assemble one fixed-roots page from the parsed rows: hasMore = the page
 *  is FULL (the host's rule — the next batch is known to exist), and the
 *  next-page cursor is carried ONLY when hasMore (a short page ends the
 *  log). `nextCursor` is the pre-encoded token for offset + count. */
export function buildLogPage(entries, count, nextCursor) {
  const hasMore = entries.length === count
  return hasMore
    ? { entries, cursor: nextCursor, hasMore }
    : { entries, hasMore }
}