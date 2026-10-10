// Probe-only, bounded, in-memory diagnostics. Never retain error/debug/banner objects.
import { randomUUID } from 'node:crypto'
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const EVENTS = new Set(['probe.start', 'carrier.acquire.start', 'carrier.acquire.complete',
  'pool.connect.start', 'ssh.identification', 'ssh.handshake.complete', 'ssh.ready',
  'exec.start', 'exec.complete', 'probe.success', 'probe.failure', 'pool.close.start', 'pool.close.complete', 'pool.close.failure'])
const PHASES = new Set(['validation', 'carrier.acquire', 'pool.connect', 'ssh.identification', 'ssh.handshake', 'ssh.ready', 'exec', 'pool.close'])
const CODES = new Set(['UNKNOWN_ERROR', 'TIMEOUT', 'AUTHENTICATION_FAILED', 'HOST_KEY_REJECTED', 'CONNECTION_REFUSED', 'CONNECTION_CLOSED', 'TARGET_BUSY', 'INVALID_REQUEST'])
export function classifyProbeError(error) {
  // Inspect internally; never return arbitrary messages or upstream codes.
  const message = typeof error?.message === 'string' ? error.message : ''
  if (/timed?\s*out|timeout/i.test(message)) return 'TIMEOUT'
  if (/authentication|all configured authentication methods failed/i.test(message)) return 'AUTHENTICATION_FAILED'
  if (/fingerprint|host key|hostkey/i.test(message)) return 'HOST_KEY_REJECTED'
  if (error?.code === 'ECONNREFUSED') return 'CONNECTION_REFUSED'
  if (/CONNECT_TARGET_BUSY/.test(message)) return 'TARGET_BUSY'
  if (/connection closed|lease closed/.test(message)) return 'CONNECTION_CLOSED'
  if (/machine not found|requires id only|plain.*object required|invalid JSON/.test(message)) return 'INVALID_REQUEST'
  return 'UNKNOWN_ERROR'
}
export function createProbeDiagnostics({ maxEvents = 200, maxProbes = 20, now = Date.now } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 200 || !Number.isInteger(maxProbes) || maxProbes < 1 || maxProbes > 20) throw new Error('invalid retention')
  let seq = 0, events = [], probes = [], disposed = false
  function begin(machineId) {
    const probeId = randomUUID(), started = now()
    let phase = 'validation'
    if (!disposed) {
      probes.push(probeId)
      while (probes.length > maxProbes) { const removed = probes.shift(); events = events.filter(e => e.probeId !== removed) }
    }
    function record(event, data = {}) {
      if (disposed || !probes.includes(probeId) || !EVENTS.has(event)) return
      const item = { seq: ++seq, probeId, event, at: now(), elapsedMs: Math.max(0, now() - started), phase }
      if (typeof machineId === 'string' && ID.test(machineId)) item.machineId = machineId
      if (PHASES.has(data.phase)) item.phase = phase = data.phase
      if (CODES.has(data.code)) item.code = data.code
      if (data.protocol === '2.0' || data.protocol === '1.99') item.protocol = data.protocol
      if (typeof data.generation === 'string' && /^[a-f0-9-]{36}$/i.test(data.generation)) {
        item.generation = data.generation
        item.reusedGeneration = events.some(e => e.event === 'carrier.acquire.complete' && e.generation === data.generation && e.probeId !== probeId)
        if (typeof data.reusedGeneration === 'boolean') item.reusedGeneration = data.reusedGeneration
      }
      if (['127.0.0.1', '::1'].includes(data.host) && Number.isInteger(data.port) && data.port > 0 && data.port <= 65535) item.endpoint = { host: data.host, port: data.port }
      events.push(item)
      while (events.length > maxEvents) events.shift()
    }
    record('probe.start')
    return { probeId, record, failure(error) { record('probe.failure', { code: classifyProbeError(error) }) } }
  }
  function list({ machineId, after = 0, limit = 50 } = {}) {
    const filtered = events.filter(e => e.seq > after && (!machineId || e.machineId === machineId))
    const items = filtered.slice(0, limit)
    return { ok: true, events: structuredClone(items), latestSeq: seq, oldestSeq: events[0]?.seq ?? null,
      nextAfter: items.at(-1)?.seq ?? after, hasMore: filtered.length > items.length,
      truncated: after > 0 && events.length > 0 && after < events[0].seq - 1,
      retention: { maxEvents, maxProbes }, retainedProbes: probes.length }
  }
  return { begin, list, clear() { events = []; probes = [] }, dispose() { disposed = true; events = []; probes = [] } }
}
export function createProbeDiagnosticsRoute(store, connectionOf) {
  return { kind: 'exact', path: '/dsh-remote/probe-diagnostics', handler: async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const reply = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) }
    const connection = connectionOf()
    if (typeof connection?.requestRejection !== 'function') return reply(503, { ok: false, code: 'AUTH_UNAVAILABLE' })
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) return reply(rejection, { ok: false, code: 'AUTH_REJECTED' })
    if (req.method !== 'GET') return reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
    try {
      const q = new URL(req.url, 'http://localhost').searchParams
      const seen = new Set()
      for (const [k] of q) { if (!['machineId', 'after', 'limit'].includes(k) || seen.has(k)) throw 0; seen.add(k) }
      const number = (k, fallback, min, max) => { if (!q.has(k)) return fallback; const value = q.get(k); if (!/^(0|[1-9][0-9]*)$/.test(value)) throw 0; const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw 0; return n }
      const machineId = q.get('machineId') ?? undefined
      if (machineId !== undefined && !ID.test(machineId)) throw 0
      return reply(200, store.list({ machineId, after: number('after', 0, 0, Number.MAX_SAFE_INTEGER), limit: number('limit', 50, 1, 200) }))
    } catch { return reply(400, { ok: false, code: 'INVALID_QUERY' }) }
  } }
}
