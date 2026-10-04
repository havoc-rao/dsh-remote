// Explicitly managed, workspace-owned PTYs. Independent of the legacy terminal.
// Routes authorize/canonicalize owner; this manager only compares that identity.
// All wire frames are JSON. Uplink: input/resize; close/park only detach.
import { randomUUID } from 'node:crypto'

const OUTPUT_LIMIT = 48 * 1024
const REPLAY_LIMIT = 32 * 1024
const INPUT_LIMIT = 64 * 1024
const WS_LIMIT = 512 * 1024
const failure = (code, message) => Object.assign(new Error(message), { code })
const limit = (value, fallback, min = 1) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback
}
const dimension = (value, fallback, min, max) =>
  Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback

// Keep a byte-bounded UTF-8 tail without introducing a broken leading codepoint.
function tail(text, bytes) {
  const buf = Buffer.from(text)
  if (buf.length <= bytes) return text
  let start = buf.length - bytes
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}
function identity(owner) {
  if (!owner || ['machineId', 'workspace', 'key'].some(k => typeof owner[k] !== 'string' || !owner[k])) {
    throw failure('FORBIDDEN', 'terminal owner is not authorized')
  }
  const result = { machineId: owner.machineId, workspace: owner.workspace, key: owner.key }
  if (typeof owner.isCurrent === 'function') {
    Object.defineProperty(result, 'isCurrent', { value: () => owner.isCurrent() })
  }
  if (!isCurrent(result)) throw failure('FORBIDDEN', 'Remote terminal access denied')
  return result
}
function isCurrent(owner) {
  try { return !owner.isCurrent || owner.isCurrent() === true } catch { return false }
}
function same(a, b) {
  return a.key === b.key && a.machineId === b.machineId && a.workspace === b.workspace
}

export class ManagedTerminalManager {
  /** getPool(machineId) must resolve the authorized machine's pool.
   * config: terminalMaxSessions (default 8), managedTerminalMaxExited (default 64).
   * onCommand(line, info) is optional; errors from pools/hooks never reach clients.
   */
  constructor({ getPool, config = {}, onCommand = null }) {
    this.getPool = getPool
    this.config = config
    this.onCommand = onCommand
    this.terminals = new Map()
    this.closed = false
  }

  async create(owner, sessionId, title = 'Remote terminal') {
    owner = identity(owner)
    if (this.closed) throw failure('CLOSED', 'terminal manager is closed')
    // Reserve synchronously BEFORE any await: spawning counts against the quota.
    const active = [...this.terminals.values()].filter(t => !t.exited).length
    if (active >= limit(this.config.terminalMaxSessions, 8)) {
      throw failure('QUOTA', 'too many managed terminals')
    }
    const t = {
      terminalId: `remote-managed:${randomUUID()}`,
      title: String(title || 'Remote terminal').slice(0, 120),
      cwd: owner.workspace, createdBySessionId: sessionId,
      createdAt: Date.now(), exited: false, owner,
      channel: null, end: null, views: new Map(), transcript: '', cmdBuf: '',
      cols: 80, rows: 24, decoder: null, unwire: null,
    }
    this.terminals.set(t.terminalId, t)
    try {
      const pool = await this.getPool(owner.machineId)
      if (this.closed || !this.terminals.has(t.terminalId)) throw failure('CLOSED', 'terminal manager is closed')
      if (!isCurrent(owner)) throw failure('FORBIDDEN', 'Remote terminal access denied')
      const { channel, end } = await pool.openPty({ cwd: t.cwd, cols: t.cols, rows: t.rows, term: 'xterm-256color' })
      if (this.closed || !this.terminals.has(t.terminalId)) {
        try { end() } catch {}
        throw failure('CLOSED', 'terminal manager is closed')
      }
      t.channel = channel
      t.end = end
      if (!isCurrent(owner)) throw failure('FORBIDDEN', 'Remote terminal access denied')
      try { t.decoder = new TextDecoder(pool.platform === 'windows' && !pool.gitBashPath ? 'gbk' : 'utf-8') }
      catch { t.decoder = new TextDecoder('utf-8') }
      this._wire(t)
      return this._info(t)
    } catch {
      const stopped = this.closed || !this.terminals.has(t.terminalId)
      this.terminals.delete(t.terminalId)
      this._release(t)
      if (!isCurrent(owner)) {
        for (const ws of [...t.views.keys()]) this._forbid(t, ws)
        throw failure('FORBIDDEN', 'Remote terminal access denied')
      }
      this._closeViews(t, 'missing')
      // Do not forward pool/SSH exceptions: they can contain credentials.
      throw failure(stopped ? 'CLOSED' : 'SPAWN_FAILED', stopped ? 'terminal manager is closed' : 'remote terminal could not be started')
    }
  }

  list(owner) {
    owner = identity(owner)
    return { terminals: [...this.terminals.values()].filter(t => same(t.owner, owner)).map(t => this._info(t)) }
  }

  terminate(owner, id) {
    const t = this._lookup(owner, id)
    this.terminals.delete(id)
    this._closeViews(t, 'terminated')
    this._release(t)
  }

  attach(ws, owner, id, { cols, rows } = {}) {
    let t
    try { t = this._lookup(owner, id) }
    catch (err) {
      if (err.code === 'MISSING') {
        try { ws.send(JSON.stringify({ type: 'closed', reason: 'missing' })); ws.close(1000) } catch {}
      }
      throw err
    }
    if (t.views.has(ws)) return this._info(t)
    const detach = () => this._detach(t, ws)
    const onError = () => this._detach(t, ws, true)
    const onMessage = (data) => this._message(t, ws, data)
    t.views.set(ws, { onMessage, detach, onError, isCurrent: () => isCurrent(owner) })
    ws.on('message', onMessage)
    ws.on('close', detach)
    ws.on('error', onError)
    this._resize(t, cols, rows)
    this._send(t, ws, { type: 'init', ...this._info(t), cols: t.cols, rows: t.rows })
    if (t.transcript) this._send(t, ws, { type: 'output', data: tail(t.transcript, REPLAY_LIMIT) })
    this._send(t, ws, { type: 'title', title: t.title, cwd: t.cwd })
    if (t.exited) {
      this._send(t, ws, { type: 'closed', reason: 'exited' })
      this._detach(t, ws, true)
    }
    return this._info(t)
  }

  closeAll() {
    this.closed = true
    const terminals = [...this.terminals.values()]
    this.terminals.clear()
    for (const t of terminals) {
      this._closeViews(t, 'missing')
      this._release(t)
    }
  }

  _lookup(owner, id) {
    owner = identity(owner)
    const t = this.terminals.get(id)
    if (!t) throw failure('MISSING', 'managed terminal does not exist')
    if (!same(t.owner, owner)) throw failure('FORBIDDEN', 'terminal belongs to another workspace or machine')
    return t
  }

  _info(t) {
    return { terminalId: t.terminalId, title: t.title, cwd: t.cwd,
      createdBySessionId: t.createdBySessionId, createdAt: t.createdAt, exited: t.exited }
  }

  _wire(t) {
    const channel = t.channel
    const onData = data => {
      if (t.exited || !this.terminals.has(t.terminalId)) return
      let text
      try { text = typeof data === 'string' ? data : t.decoder.decode(data, { stream: true }) }
      catch { return }
      this._output(t, text)
    }
    const onExit = () => {
      if (t.exited || !this.terminals.has(t.terminalId)) return
      t.exited = true
      try { this._output(t, t.decoder.decode()) } catch {}
      this._closeViews(t, 'exited')
      this._release(t)
      t.cmdBuf = ''
      // Retain only a bounded number of tombstones, excluding active/spawning.
      const exited = [...this.terminals.values()].filter(item => item.exited)
      const max = limit(this.config.managedTerminalMaxExited, 64, 0)
      for (const old of exited.slice(0, Math.max(0, exited.length - max))) this.terminals.delete(old.terminalId)
    }
    channel.on('data', onData)
    channel.on('close', onExit)
    channel.on('error', onExit)
    t.unwire = () => {
      channel.removeListener('data', onData)
      channel.removeListener('close', onExit)
      channel.removeListener('error', onExit)
      // A late SSH error after end() must not become an uncaught exception.
      channel.on('error', () => {})
    }
  }

  _release(t) {
    const end = t.end
    t.end = null
    if (t.unwire) { t.unwire(); t.unwire = null }
    t.channel = null
    t.decoder = null
    if (end) { try { end() } catch {} }
  }

  _output(t, text) {
    if (!text) return
    // Bound retained output even when one channel chunk is enormous.
    t.transcript = tail(t.transcript + tail(text, OUTPUT_LIMIT), OUTPUT_LIMIT)
    // Bound each live data frame too. Never pause a PTY for one slow view.
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 8192, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      this._broadcast(t, { type: 'output', data: text.slice(start, end) })
      start = end
    }
  }

  _send(t, ws, frame) {
    if (!t.views.has(ws)) return
    if (!t.views.get(ws).isCurrent()) return this._forbid(t, ws)
    if (ws.readyState !== 1 || ws.bufferedAmount > WS_LIMIT) return this._detach(t, ws, true)
    try {
      ws.send(JSON.stringify(frame))
      if (ws.bufferedAmount > WS_LIMIT) this._detach(t, ws, true)
    } catch { this._detach(t, ws, true) }
  }
  _broadcast(t, frame) { for (const ws of [...t.views.keys()]) this._send(t, ws, frame) }
  _closeViews(t, reason) {
    this._broadcast(t, { type: 'closed', reason })
    for (const ws of [...t.views.keys()]) this._detach(t, ws, true)
  }
  _forbid(t, ws) {
    // Fatal, not missing: a rebound session must never trigger recreate/restart.
    if (ws.readyState === 1 && ws.bufferedAmount <= WS_LIMIT) {
      try { ws.send(JSON.stringify({ type: 'fatal', code: 'FORBIDDEN', message: 'Remote terminal access denied' })) } catch {}
    }
    this._detach(t, ws, true)
  }
  _detach(t, ws, close = false) {
    const handlers = t.views.get(ws)
    if (!handlers) return
    t.views.delete(ws)
    ws.removeListener('message', handlers.onMessage)
    ws.removeListener('close', handlers.detach)
    ws.removeListener('error', handlers.onError)
    // ws may report an asynchronous error after close.
    ws.on('error', () => {})
    if (close) { try { ws.close(1000) } catch {} }
  }
  _resize(t, cols, rows) {
    if (t.exited) return
    t.cols = dimension(cols, t.cols, 2, 500)
    t.rows = dimension(rows, t.rows, 1, 300)
    if (t.channel?.setWindow) { try { t.channel.setWindow(t.rows, t.cols, 0, 0) } catch {} }
  }
  _message(t, ws, data) {
    if (!t.views.has(ws)) return
    if (!t.views.get(ws).isCurrent()) return this._forbid(t, ws)
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength
    // JSON envelope overhead is bounded separately from the 64 KiB input payload.
    if (!Number.isFinite(size) || size > INPUT_LIMIT + 1024) return this._detach(t, ws, true)
    let frame
    try { frame = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')) } catch { return }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'close' || frame.type === 'park') return this._detach(t, ws, true)
    if (frame.type === 'resize') return this._resize(t, frame.cols, frame.rows)
    if (frame.type !== 'input' || typeof frame.data !== 'string' || t.exited) return
    if (Buffer.byteLength(frame.data) > INPUT_LIMIT) return this._detach(t, ws, true)
    if (!t.channel) return
    try { t.channel.write(frame.data) } catch { return }
    t.cmdBuf = (t.cmdBuf + frame.data).slice(-4096)
    const lines = t.cmdBuf.split(/[\r\n]/)
    t.cmdBuf = lines.pop()
    for (const line of lines) {
      const command = line.trim()
      if (!command || /^\x1b/.test(command)) continue
      t.title = command.split(/\s+/)[0].slice(0, 60)
      this._broadcast(t, { type: 'title', title: t.title, cwd: t.cwd })
      if (this.onCommand) { try { this.onCommand(command.slice(0, 400), this._info(t)) } catch {} }
    }
  }
}
