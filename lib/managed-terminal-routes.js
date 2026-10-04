// Native managed terminals: authoritative session/mirror ownership only.
export const managedError = (code, message) => Object.assign(new Error(message), { code })

export async function resolveManagedOwner(sessionId, { sessionCwdOf, ctxForCwd, getPool }) {
  if (typeof sessionId !== 'string' || !sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) throw managedError('FORBIDDEN', 'A valid remote session is required')
  const local = sessionCwdOf(sessionId)
  if (!local) throw managedError('FORBIDDEN', 'Remote session is unavailable')
  const origin = ctxForCwd(local)
  if (origin.source !== 'mirror' || !origin.machineId || !origin.workspace) throw managedError('FORBIDDEN', 'Session has no authorized remote mirror')
  const pool = await getPool(origin.machineId)
  if (!pool) throw managedError('FORBIDDEN', 'Remote machine is unavailable')
  const sftp = await pool.sftp()
  const workspace = String(await sftp.realpath(origin.workspace))
  if (!workspace || workspace.includes('\0')) throw managedError('FORBIDDEN', 'Remote workspace is unavailable')
  // Awaited canonicalization must not commit after a session/mirror was rebound.
  const current = ctxForCwd(sessionCwdOf(sessionId))
  if (current.source !== 'mirror' || current.machineId !== origin.machineId || current.workspace !== origin.workspace) throw managedError('FORBIDDEN', 'Remote workspace changed')
  const owner = { machineId: origin.machineId, workspace, key: JSON.stringify([origin.machineId, workspace]) }
  // Recheck synchronous authoritative routing on every live WS input/output.
  // The remote canonical root was verified above; a changed mirror/selection
  // must detach before it can observe or write the previous workspace's PTY.
  Object.defineProperty(owner, 'isCurrent', { value: () => {
    const now = ctxForCwd(sessionCwdOf(sessionId))
    return now.source === 'mirror' && now.machineId === origin.machineId && now.workspace === origin.workspace
  } })
  return owner
}

export async function attachManagedTerminal(ws, query, { resolveOwner, manager }) {
  try {
    const owner = await resolveOwner(query.get('sessionId'))
    if (ws.readyState !== 1) return
    const id = query.get('terminalId')
    if (typeof id !== 'string' || !id.startsWith('remote-managed:')) throw managedError('FORBIDDEN', 'Wrong terminal backend')
    manager.attach(ws, owner, id, { cols: query.get('cols'), rows: query.get('rows') })
  } catch (error) {
    if (ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(error?.code === 'MISSING' ? { type: 'closed', reason: 'missing' }
        : { type: 'fatal', code: 'FORBIDDEN', message: 'Remote terminal access denied' }))
      ws.close(1000)
    } catch {}
  }
}

export function managedTerminalRoutes({ manager, resolveOwner, readBody, sendJson }) {
  return ['create', 'list', 'terminate'].map(operation => ({
    kind: 'exact', path: '/dsh-remote/workspace-terminals/' + operation,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw managedError('INVALID', 'Invalid request')
        const owner = await resolveOwner(body.sessionId)
        let result
        if (operation === 'create') {
          result = await manager.create(owner, body.sessionId, body.title)
          try {
            const current = await resolveOwner(body.sessionId)
            if (current.key !== owner.key) throw managedError('FORBIDDEN', 'Remote workspace changed')
          } catch (error) {
            // Rollback uses the captured trusted identity, not a now-revoked
            // live-view guard, solely to release the just-created PTY.
            manager.terminate({ machineId: owner.machineId, workspace: owner.workspace, key: owner.key }, result.terminalId)
            throw error
          }
        }
        else if (operation === 'list') result = manager.list(owner)
        else { manager.terminate(owner, body.terminalId); result = { ok: true } }
        return sendJson(res, 200, result)
      } catch (e) {
        const code = e?.code === 'MISSING' ? 'MISSING' : e?.code === 'FORBIDDEN' ? 'FORBIDDEN' : e?.code === 'QUOTA' ? 'QUOTA' : 'UNAVAILABLE'
        return sendJson(res, code === 'MISSING' ? 404 : code === 'FORBIDDEN' ? 403 : code === 'QUOTA' ? 429 : 400,
          { ok: false, code, error: code === 'FORBIDDEN' ? 'Remote terminal access denied' : code === 'MISSING' ? 'Remote terminal missing' : 'Remote terminal unavailable' })
      }
    },
  }))
}
