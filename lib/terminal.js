// dsh-remote — Remote interactive terminal (host half of the transport slot).
//
// Bridges a browser terminal view (DSH-better-sidebar's TerminalView via its
// transport slot, or any view speaking the same frame vocabulary) to an
// INTERACTIVE SHELL on the remote host. Each terminal session owns a DEDICATED
// SSH connection (SshPool.openPty — same credentials / host-key guard / proxy
// jump machinery as the pooled rw_* client, but NOT part of the pool, so a
// pool reconnect or rw_disconnect never kills open terminals).
//
// Wire protocol (host ⇄ browser over /dsh-remote/ws/terminal):
//   downlink  raw text frames (terminal output, UTF-8 / streaming-decoded)
//             {type:'init', sid, machine, cwd, cols, rows}  attach ack
//             {type:'title', title, command, cwd}           info-bar payload
//             {type:'exit', code}                           shell exited
//   uplink    raw text (input → pty), plus JSON control frames:
//             {type:'resize', cols, rows}
//             {type:'close'}      user closed the tab — kill the pty now
//             {type:'park'}       view hidden (session switch) — keep alive
//             {type:'signal', name}  e.g. INT / KILL (channel.signal)
//
// Lifecycle mirrors the local-pty host semantics the view expects:
//   - close frame → the pty is killed immediately;
//   - park frame  → the pty is kept alive indefinitely (no grace countdown);
//   - bare socket drop (page refresh / crash / re-render) → the reconnect
//     grace (config.terminalReconnectGraceMs, default 60s) keeps the shell
//     alive; a reattach replays the tail of the transcript and resumes live.
//   - when the remote shell exits and a socket is attached, a fresh shell is
//     spawned automatically (up to 3 exits within a session; immediate-exit
//     loops (>2 exits within 5s of spawn) mark the session dead and the next
//     attach is refused with a 1011 reason so the view never spins forever).
//
// The title mechanism mirrors the local host: each submitted command line is
// reflected as a {type:'title'} frame (info bar + tab title) and written to
// the command audit log through the injected onCommand callback.

import { randomUUID } from 'node:crypto'

/** Transcript-tail bytes kept per session for reattach replay. */
const TRANSCRIPT_LIMIT = 48 * 1024
/** Replay is further capped when a socket reattaches. */
const REPLAY_LIMIT = 32 * 1024
/** ws bufferedAmount high/low watermarks for channel backpressure. */
const WS_HIGH_WATER = 512 * 1024
const WS_LOW_WATER = 128 * 1024
/** A shell that exits within this many ms of spawn counts as "immediate". */
const IMMEDIATE_EXIT_MS = 5000
/** More than this many immediate exits marks the session dead. */
const IMMEDIATE_EXIT_LIMIT = 2

const CONTROL_TYPES = new Set(['resize', 'close', 'park', 'signal', 'resume'])

/** Sniff one bounded uplink frame (leading '{' + ≤512 B fast path, so high-
 *  volume terminal input never pays a JSON.parse per chunk). */
function parseControlFrame(data) {
  if (data.length > 512 || data.charCodeAt(0) !== 0x7b) return null // '{'
  try {
    const parsed = JSON.parse(data)
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.type !== 'string' || !CONTROL_TYPES.has(parsed.type)) return null
    return parsed
  } catch {
    return null
  }
}

/** The streaming text decoder for one pty channel: UTF-8 normally; on native
 *  Windows remotes (cmd.exe, no Git Bash) the default ANSI codepage is often
 *  GBK — TextDecoder('gbk') handles it when ICU is available, else UTF-8. */
function makeDecoder(windows) {
  if (!windows) return new TextDecoder('utf-8')
  try {
    return new TextDecoder('gbk')
  } catch {
    return new TextDecoder('utf-8')
  }
}

/** Control-frame serializer. */
const ctrl = (payload) => JSON.stringify(payload)

export class TerminalManager {
  /**
   * @param {object} opts
   * @param {import('./index.js').SshPool} opts.pool  default pool (its config
   *   holds the CURRENT target; openPty spawns dedicated connections for it)
   * @param {(machineId: string) => Promise<import('./index.js').SshPool>} [opts.getPool]
   *   per-machine pool resolver — a terminal whose WS handshake names a
   *   machine id (mirror owner / workspace selection) gets THAT machine's
   *   dedicated pool, so terminals never ride another workspace's machine
   *   (per-workspace isolation). Omit / null → every session uses `pool`.
   * @param {object} [opts.config]  { terminalMaxSessions, terminalReconnectGraceMs }
   * @param {(line: string) => void} [opts.onCommand]  audit hook (submitted command lines)
   */
  constructor({ pool, getPool = null, config = {}, onCommand = null }) {
    this.pool = pool
    this.getPool = getPool
    this.config = config
    this.onCommand = onCommand
    /** sid → session */
    this.sessions = new Map()
    /** resume key (machine@host + tab identity) → sid, for reattach. */
    this.resumeIndex = new Map()
    this.closed = false
  }

  // ── public surface ────────────────────────────────────────────────────────

  /** Attach (or lazily create) a terminal session for one upgraded socket.
   *  `params.machine` (optional) names the machine (registry id) this session
   *  belongs to — resolved through the per-machine pool resolver so a session
   *  opened from a mirror/workspace of machine A never rides machine B's
   *  connection (per-workspace isolation). */
  attach(ws, params) {
    const { sid, resume, cwd, cols, rows, term, machine } = params
    if (this.closed) return this.refuse(ws, 'plugin is shutting down')

    let session = null
    if (sid) session = this.sessions.get(sid)
    if (!session && resume) session = this.sessions.get(this.resumeIndex.get(resume) || '')
    if (session && ((session.machineId || '') !== (machine || '') || (session.scope || '') !== (params.scope || ''))) {
      return this.refuse(ws, 'terminal belongs to another workspace or machine')
    }
    if (session && session.dead) {
      // A previously poisoned session (immediate-exit loop) — start fresh.
      this.kill(session, { silent: true })
      session = null
    }
    if (!session) {
      if (this.sessions.size >= Math.max(1, Number(this.config.terminalMaxSessions) || 8)) {
        return this.refuse(ws, 'too many terminal sessions')
      }
      session = this._create({ resume: resume || null, cwd: cwd || '', machine: machine || '', cols, rows, term })
      session.scope = params.scope || ''
    }

    // One live socket per session: a racing second attach drops the old one.
    if (session.ws && session.ws !== ws) {
      try { session.ws.close(1000) } catch {}
    }
    session.ws = ws
    session.parked = false
    session.closedByFrame = false
    // init is per-attach: a reattach must re-send init + replay the
    // transcript. (The sendInit closure still compares session.ws against
    // ITS ws, so a racing second attach cannot double-send.)
    session.initSent = false
    this._clearGrace(session)

    ws.on('message', (data) => this._onMessage(session, data))
    ws.on('close', () => {
      if (session.ws !== ws) return
      session.ws = null
      this._onDetach(session)
    })
    ws.on('error', () => {
      try { ws.close() } catch {}
    })

    // Attach handshake: init frame + transcript replay + queued input. When a
    // shell is already running we do it synchronously; otherwise after the
    // (async) spawn resolves — input typed meanwhile is queued on the session.
    const sendInit = () => {
      if (session.ws !== ws || session.initSent) return
      try {
        ws.send(ctrl({
          type: 'init',
          sid: session.id,
          machine: this._machineLabel(session),
          cwd: session.cwd || this._sessionPool(session).config.workspace || '',
          cols: session.cols,
          rows: session.rows,
        }))
      } catch {}
      session.initSent = true
      this._replay(session, ws)
      this._flushPending(session, ws)
    }

    if (session.channel) {
      sendInit()
    } else {
      this.ensureShell(session).then(sendInit).catch((err) => {
        this.refuse(ws, this._shortReason(err))
      })
    }
    return session.id
  }

  /** The pool a session's pty runs on: per-machine when the session names a
   *  machine id (getPool resolver), else the default shared pool. */
  async _poolFor(session) {
    if (session.machineId && this.getPool) {
      const rp = await this.getPool(session.machineId)
      if (rp) return rp
    }
    return this.pool
  }

  /** The resolved pool of a running session (defaults to the shared pool). */
  _sessionPool(session) {
    return (session && session.pool) || this.pool
  }

  /** Ensure the session has a live pty channel (spawn on first use / respawn
   *  after an exit). Resolves when the channel is ready. */
  async ensureShell(session) {
    if (session.channel || session.spawning || session.dead || this.closed) return
    session.spawning = true
    session.spawnedAt = Date.now()
    try {
      const pool = await this._poolFor(session)
      session.pool = pool
      const { channel, end } = await pool.openPty({
        cols: session.cols,
        rows: session.rows,
        term: session.term,
        cwd: session.cwd || '',
      })
      if (session.dead || this.closed || session.reaped) {
        try { end() } catch {}
        return
      }
      session.channel = channel
      session.endPty = end
      session.spawns += 1
      session.spawning = false
      this._wireChannel(session)
    } catch (err) {
      session.spawning = false
      session.recentExits += 1
      if (session.recentExits >= IMMEDIATE_EXIT_LIMIT + 1) session.dead = true
      throw err
    }
  }

  /** Live summary for /dsh-remote/terminal/status. */
  list() {
    const rows = []
    for (const s of this.sessions.values()) {
      rows.push({
        machine: this._machineLabel(s),
        cwd: s.cwd || '',
        alive: !!s.channel,
        spawning: !!s.spawning,
        parked: !!s.parked,
        attached: !!s.ws,
        spawns: s.spawns,
        ageMs: Date.now() - s.createdAt,
      })
    }
    return rows
  }

  /** Kill every session (plugin teardown). */
  closeAll() {
    this.closed = true
    for (const s of [...this.sessions.values()]) this.kill(s, { silent: true })
  }

  // ── internals ─────────────────────────────────────────────────────────────

  _create({ resume, cwd, machine, cols, rows, term }) {
    const session = {
      id: randomUUID(),
      resumeKey: resume || null,
      cwd: cwd || '',
      machineId: machine || '',
      pool: null, // resolved lazily by ensureShell (per-machine or shared)
      cols: Math.max(2, Math.min(Number(cols) || 80, 500)),
      rows: Math.max(1, Math.min(Number(rows) || 24, 300)),
      term: String(term || 'xterm-256color'),
      machine: this.pool.config.host || '', // legacy label (real label = _machineLabel(session))
      channel: null,
      endPty: null,
      spawning: false,
      spawns: 0,
      recentExits: 0,
      dead: false,
      reaped: false,
      ws: null,
      parked: false,
      closedByFrame: false,
      initSent: false,
      paused: false,
      pauseTimer: null,
      graceTimer: null,
      decoder: null,
      transcript: [],
      transcriptLen: 0,
      pendingInput: [],
      cmdBuf: '',
      createdBy: resume || null,
      createdAt: Date.now(),
      spawnedAt: 0,
      lastActive: Date.now(),
    }
    this.sessions.set(session.id, session)
    if (resume) this.resumeIndex.set(resume, session.id)
    return session
  }

  _wireChannel(session) {
    const channel = session.channel
    session.decoder = makeDecoder(this._sessionPool(session).platform === 'windows' && !this._sessionPool(session).gitBashPath)
    channel.on('data', (buf) => {
      session.lastActive = Date.now()
      let text = ''
      try { text = session.decoder.decode(buf, { stream: true }) } catch { text = buf.toString('utf8') }
      this._pushTranscript(session, text)
      if (session.ws && session.ws.readyState === 1 /* OPEN */) {
        try { session.ws.send(text) } catch {}
        if (session.ws.bufferedAmount > WS_HIGH_WATER && !session.paused && typeof channel.pause === 'function') {
          session.paused = true
          try { channel.pause() } catch {}
          if (session.pauseTimer) clearInterval(session.pauseTimer)
          session.pauseTimer = setInterval(() => {
            if (!session.ws || session.ws.readyState !== 1) return
            if (session.ws.bufferedAmount < WS_LOW_WATER) {
              session.paused = false
              if (session.pauseTimer) { clearInterval(session.pauseTimer); session.pauseTimer = null }
              try { channel.resume() } catch {}
            }
          }, 250)
        }
      }
    })
    channel.on('error', () => {})
    channel.on('close', () => {
      session.channel = null
      if (session.endPty) { try { session.endPty() } catch {}; session.endPty = null }
      if (session.pauseTimer) { clearInterval(session.pauseTimer); session.pauseTimer = null }
      try {
        const tail = session.decoder.decode()
        if (tail) { this._pushTranscript(session, tail); this._bcast(session, tail) }
      } catch {}
      this._onShellExit(session)
    })
  }

  _onShellExit(session) {
    session.lastActive = Date.now()
    const wasImmediate = Date.now() - session.spawnedAt < IMMEDIATE_EXIT_MS
    if (wasImmediate) session.recentExits += 1
    if (session.recentExits > IMMEDIATE_EXIT_LIMIT) {
      // Immediate-exit loop (bad shell, broken git-bash path…) — poison the
      // session so the view's reconnect loop cannot spin forever.
      session.dead = true
      const reason = 'remote shell exits repeatedly'
      if (session.ws) {
        try { session.ws.close(1011, reason) } catch {}
        session.ws = null
      }
      this._scheduleReap(session, 5000)
      return
    }
    session.spawning = false
    if (session.ws && session.ws.readyState === 1) {
      // Auto-respawn, matching the local-pty host's behavior.
      this._note(session, 'shell exited — starting a new shell')
      this.ensureShell(session).catch((err) => {
        const reason = this._shortReason(err)
        if (session.ws) {
          try { session.ws.close(1011, reason) } catch {}
          session.ws = null
        }
        session.dead = true
        this._scheduleReap(session, 5000)
      })
    } else if (!session.parked) {
      // No socket attached: the session stays for the reconnect grace, and a
      // reattach respawns the shell.
      this._scheduleGrace(session)
    }
  }

  _onMessage(session, data) {
    session.lastActive = Date.now()
    const text = typeof data === 'string' ? data : data.toString('utf8')
    if (typeof data !== 'string' && data && typeof data.length === 'number') {
      // binay frames are input too (the browser side always sends strings)
    }
    const frame = parseControlFrame(text)
    if (frame) {
      switch (frame.type) {
        case 'resize': {
          const cols = Math.max(2, Math.min(Number(frame.cols) || session.cols, 500))
          const rows = Math.max(1, Math.min(Number(frame.rows) || session.rows, 300))
          session.cols = cols
          session.rows = rows
          if (session.channel && typeof session.channel.setWindow === 'function') {
            try { session.channel.setWindow(rows, cols, 0, 0) } catch {}
          }
          return
        }
        case 'close':
          session.closedByFrame = true
          this.kill(session)
          return
        case 'park':
          session.parked = true
          this._clearGrace(session)
          return
        case 'signal':
          if (session.channel && typeof session.channel.signal === 'function') {
            try { session.channel.signal(String(frame.name || 'INT')) } catch {}
          }
          return
        default:
          return
      }
    }
    // Raw input → the pty (queued until the shell is up).
    if (session.channel) {
      this._feed(session, text)
    } else {
      session.pendingInput.push(text)
      const cap = 64 * 1024
      let total = 0
      for (let i = session.pendingInput.length - 1; i >= 0; i--) {
        total += session.pendingInput[i].length
        if (total > cap) { session.pendingInput.splice(0, i + 1); break }
      }
      void this.ensureShell(session).catch(() => {})
    }
  }

  _feed(session, text) {
    if (!session.channel) return
    try { session.channel.write(text) } catch {}
    // Command tracking: each completed line updates the info-bar title and
    // the audit log (mirrors the local host's title frames).
    session.cmdBuf += text
    let idx
    while ((idx = session.cmdBuf.indexOf('\n')) !== -1) {
      const line = session.cmdBuf.slice(0, idx).replace(/\r$/, '')
      session.cmdBuf = session.cmdBuf.slice(idx + 1)
      const trimmed = line.trim()
      if (!trimmed || /^\x1b/.test(trimmed)) continue
      const title = trimmed.split(/\s+/)[0].slice(0, 60)
      this._bcast(session, ctrl({
        type: 'title',
        title,
        command: trimmed.slice(0, 200),
        cwd: session.cwd || this._sessionPool(session).config.workspace || '',
      }))
      if (this.onCommand) { try { this.onCommand(trimmed.slice(0, 400)) } catch {} }
    }
    // The buffer grows unbounded inside one long line — bound it.
    if (session.cmdBuf.length > 4096) session.cmdBuf = session.cmdBuf.slice(-4096)
  }

  _flushPending(session, ws) {
    if (!session.pendingInput.length) return
    const queue = session.pendingInput
    session.pendingInput = []
    for (const chunk of queue) this._feed(session, chunk)
  }

  _onDetach(session) {
    if (session.closedByFrame) return // killed already
    this._clearGrace(session)
    if (session.parked) return // keep the shell alive indefinitely
    this._scheduleGrace(session)
  }

  _scheduleGrace(session) {
    this._clearGrace(session)
    const grace = Number(this.config.terminalReconnectGraceMs) || 60000
    session.graceTimer = setTimeout(() => {
      if (!session.ws && !session.parked) this.kill(session, { silent: true })
    }, grace)
    if (typeof session.graceTimer.unref === 'function') session.graceTimer.unref()
  }

  _clearGrace(session) {
    if (session.graceTimer) { clearTimeout(session.graceTimer); session.graceTimer = null }
  }

  /** Remove the session from the registry shortly (fatal paths). */
  _scheduleReap(session, ms) {
    const timer = setTimeout(() => this.kill(session, { silent: true }), ms)
    if (typeof timer.unref === 'function') timer.unref()
  }

  kill(session, { silent = false } = {}) {
    if (!session || session.reaped) return
    session.reaped = true
    this._clearGrace(session)
    if (session.pauseTimer) { clearInterval(session.pauseTimer); session.pauseTimer = null }
    if (session.ws) {
      try { session.ws.close(1000) } catch {}
      session.ws = null
    }
    if (session.endPty) { try { session.endPty() } catch {} }
    session.channel = null
    session.endPty = null
    session.dead = true
    this.sessions.delete(session.id)
    if (session.resumeKey && this.resumeIndex.get(session.resumeKey) === session.id) {
      this.resumeIndex.delete(session.resumeKey)
    }
    if (!silent && session.machine) {
      try { this._note(session, 'session closed') } catch {}
    }
  }

  /** Signal a plain 1011 refusal (view shows the reason + a retry button). */
  refuse(ws, reason) {
    const safe = String(reason || 'terminal unavailable').slice(0, 110)
    try { ws.close(1011, safe) } catch {}
  }

  _pushTranscript(session, text) {
    if (!text) return
    session.transcript.push(text)
    session.transcriptLen += text.length
    while (session.transcriptLen > TRANSCRIPT_LIMIT && session.transcript.length > 1) {
      const dropped = session.transcript.shift()
      session.transcriptLen -= dropped.length
    }
    if (session.transcript.length === 1 && session.transcriptLen > TRANSCRIPT_LIMIT) {
      const s = session.transcript[0]
      const cut = s.length - TRANSCRIPT_LIMIT
      session.transcript[0] = s.slice(cut)
      session.transcriptLen = s.length - cut
    }
  }

  _replay(session, ws) {
    let tail = session.transcript.join('')
    if (tail.length > REPLAY_LIMIT) tail = tail.slice(-REPLAY_LIMIT)
    if (!tail) return
    try { ws.send(tail) } catch {}
  }

  _bcast(session, text) {
    if (session.ws && session.ws.readyState === 1) {
      try { session.ws.send(text) } catch {}
    }
  }

  _note(session, text) {
    this._bcast(session, `\r\n\x1b[2m${text}\x1b[0m\r\n`)
  }

  _machineLabel(session) {
    const c = this._sessionPool(session).config
    return `${c.username || '?'}@${c.host || '?'}:${c.port}`
  }

  _shortReason(err) {
    const msg = String((err && err.message) || err || 'terminal failed')
    return msg.replace(/\s+/g, ' ').slice(0, 110)
  }
}