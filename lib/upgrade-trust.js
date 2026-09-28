// dsh-remote — browser-trust fence for the terminal WS upgrade
// (/dsh-remote/ws/terminal).
//
// Decides whether one upgrade request may reach the terminal handler.
// Mirrors the harness's own browser-trust model (the /api gateway and
// dsh-better-sidebar's fences): the Host header must name the loopback
// authority OR an authority the web runtime declares trusted — the same
// `webRuntime.trustedHosts` list the harness derives (LAN IP literals
// sampled at boot plus `--trusted-host` entries) — and any attached browser
// markers (sec-fetch-site / Origin) must be same-origin.
//
// History: the fence used to be loopback-only by design (DSH web binds
// localhost). That posture is wrong the moment a deployment is served on a
// trusted non-loopback authority (corporate gateway / forwarded host):
// every other surface keeps working (the plugin's REST routes are not
// Host-fenced and the /api gateway already trusts the authority), while the
// terminal socket is destroyed before any HTTP response — the browser only
// ever sees "WebSocket connection to 'ws://<host>/dsh-remote/ws/terminal'
// failed:", with no status code to explain it. Trusting exactly what the
// web runtime trusts keeps the DNS-rebinding defense (Host is the one
// header rebinding cannot forge) without re-litigating the deployment's
// authority list.

/** Host-header shape: optional bracketed IPv6 (literal may contain ':'),
 *  plain host, optional port. Unbracketed IPv6 and anything carrying path /
 *  userinfo / stray characters never parse — the wire form for v6 loopback
 *  is always bracketed. */
const AUTHORITY_RE = /^(\[[^\]]*\]|[^:\]]+)(?::(\d+))?$/u

/** Loopback hostnames the socket is unconditionally allowed on. */
function isLoopbackWsName(name) {
  return name === 'localhost' || name === '::1' || /^127\./.test(name)
}

/** Strip IPv6 brackets from a parsed hostname. */
function bareName(hostname) {
  return hostname.replace(/^\[|\]$/g, '')
}

/** Whether the Host authority matches a `trustedHosts` entry, mirroring the
 *  harness semantics: an entry with an explicit port matches that exact
 *  authority; a port-less entry matches the hostname on any port (the shape
 *  the CLI derives for IP-literal LAN serving, where the bound port may be
 *  OS-assigned). Entries that do not parse as bare authorities never grant. */
function isTrustedWsAuthority(host, name, port, trustedHosts) {
  if (!Array.isArray(trustedHosts) || !trustedHosts.length) return false
  const hostLower = host.toLowerCase()
  return trustedHosts.some((entry) => {
    if (typeof entry !== 'string' || !entry) return false
    const entryLower = entry.toLowerCase()
    const em = entryLower.match(AUTHORITY_RE)
    if (!em) return false
    if (em[2] === undefined) return bareName(em[1]).toLowerCase() === name // any port
    return !!port && hostLower === entryLower // exact host:port authority
  })
}

/** Decide whether one /dsh-remote/ws/terminal upgrade may proceed.
 *  @param req - node HTTP request facts (headers).
 *  @param trustedHosts - non-loopback authorities this deployment serves
 *    (webRuntime.trustedHosts): exact `host:port`, or port-less `host`
 *    matching any port. []/absent → loopback-only (the historical default).
 *  @returns true when the Host is ours (loopback or trusted) and any
 *    attached browser markers are same-origin. */
export function trustedWsUpgrade(req, trustedHosts) {
  const host = String((req.headers && req.headers.host) || '')
  const m = host.match(AUTHORITY_RE)
  if (!m) return false
  const name = bareName(m[1]).toLowerCase()
  const port = m[2]
  if (!isLoopbackWsName(name) && !isTrustedWsAuthority(host, name, port, trustedHosts)) {
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined || origin === 'null') return true
  try {
    const o = new URL(origin)
    const oHost = o.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return oHost === name || (!/^127\./.test(name) && (oHost === 'localhost' || oHost === '::1'))
  } catch {
    return false
  }
}