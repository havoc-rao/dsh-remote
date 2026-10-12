// Passive decoration probes never establish reachability or replay SSH work.
import { classifyError } from './errors.js'

export const GIT_PROBE_RETRY_MS = 30000
export function gitProbeUnavailable(reason, retryAfterMs = GIT_PROBE_RETRY_MS) {
  return { ok: true, marker: null, probe: { state: 'unavailable', reason, retryAfterMs: Math.max(1, Math.min(GIT_PROBE_RETRY_MS, retryAfterMs)) } }
}

export function gitProbeErrorReason(err) {
  // Programming errors are never normalized, even when their text mentions a timeout.
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError) return null
  const code = err?.code
  if (['ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'connection_offline'
  const category = classifyError(err).category
  if (['network', 'timeout'].includes(category)) return category === 'timeout' ? 'probe_timeout' : 'connection_offline'
  if (['auth', 'credentials', 'hostkey'].includes(category)) return 'connection_not_ready'
  if (/^ssh (?:exec failed|stream error|carrier lease closed)|connection (?:closed|lost)|not connected|channel open failure|session termination/i.test(String(err?.message || ''))) return 'connection_offline'
  return null
}

export function createGitWorkspaceProbeCache({ now = Date.now, max = 128 } = {}) {
  const entries = new Map()
  return {
    get(key, token) {
      const hit = entries.get(key)
      if (!hit) return null
      if (hit.token !== token || hit.until <= now()) { entries.delete(key); return null }
      return gitProbeUnavailable(hit.reason, hit.until - now())
    },
    set(key, token, reason) {
      if (entries.size >= max && !entries.has(key)) entries.delete(entries.keys().next().value)
      entries.set(key, { token, reason, until: now() + GIT_PROBE_RETRY_MS })
      return gitProbeUnavailable(reason)
    },
  }
}
