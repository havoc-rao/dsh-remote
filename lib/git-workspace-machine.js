// Producer-owned JSON projection for GET /dsh-remote/git-workspace.
// This is display/registry identity, NEVER connection configuration. In
// particular a carrier's transient localhost lease must not escape here.
const text = value => typeof value === 'string' ? value : ''

export function gitWorkspaceMachine(machine) {
  if (!machine) return null
  const transport = text(machine.transport) || 'ssh'
  const carrier = transport === 'ssh' && Object.prototype.hasOwnProperty.call(machine, 'connector')
  const id = text(machine.id)
  const name = text(machine.name)
  const host = carrier ? '' : text(machine.host)
  const port = carrier ? 22 : Number(machine.port) || 22
  const username = text(machine.username) || 'root'
  const out = {
    id, name, host, port, username,
    schemaVersion: 2,
    transport,
    displayName: name.trim() || id || (transport === 'ssh' ? host : '') || transport,
  }
  if (carrier) {
    const kind = text(machine.connector?.kind)
    if (kind) out.carrierKind = kind
  } else if (transport === 'ssh' && host) {
    // Configured target/SSH-config alias, not necessarily a resolved hostname.
    out.endpoint = { host, port, username }
  }
  return out
}
