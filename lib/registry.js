// Machine-registry pure logic for dsh-remote.
//
// Issue #13: a SAVED machine is only a standby connection — it must never
// silently become the "active remote context" of every session. The registry
// therefore keeps `currentId` as an EXPLICIT user choice:
//   • loadMachines never falls back to the first saved machine,
//   • a stale currentId (machine deleted meanwhile) resolves to null,
//   • add/update never auto-activate; only an explicit "set current" does,
//   • deleting the current machine leaves NO current (no auto-promotion).
//
// Per-workspace isolation: the ACTIVE remote context is a property of the
// local workspace (session cwd), not of the whole app. machines.json therefore
// also carries `workspaces`: { "<abs workspace dir>": { machineId, workspace,
// explicitNone } }. A saved machine stays a standby everywhere; only an entry
// in `workspaces[<cwd>]` (or a session whose cwd sits inside one of that
// machine's mirrors) makes it active FOR THAT WORKSPACE. A plain local project
// workspace never inherits another project's machine or remote path.
// Keeping this logic in one module makes the guarantee unit-testable and
// shared between the HTTP routes and the tools (rw_connect).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/** A persisted per-workspace selection entry (all fields optional, normalized). */
function normalizeSel(v) {
  if (!v || typeof v !== 'object') return null
  const machineId = v.machineId ? String(v.machineId) : ''
  const workspace = typeof v.workspace === 'string' ? v.workspace : ''
  const explicitNone = !!v.explicitNone
  // A fully-empty entry carries no information — drop it.
  if (!machineId && !workspace && !explicitNone) return null
  return { machineId, workspace, explicitNone }
}

/** Load { list, currentId, explicitNone, workspaces } from the registry file. */
export function loadMachines(file) {
  const empty = { list: [], currentId: null, explicitNone: false, workspaces: {} }
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(j.list)) {
      const list = j.list
      // Explicit choice only — no fallback to the first machine, no activation
      // of a stale/deleted id (issue #13).
      const currentId = j.currentId && list.some((m) => m.id === j.currentId) ? j.currentId : null
      // A persisted `currentId: null` is a deliberate "active remote = none"
      // (the user cleared the current machine). It must survive restarts so a
      // config-level default host cannot silently reactivate a context the user
      // explicitly turned off. `explicitNone` is true when the file carries an
      // explicit null (vs. a fresh file where currentId is simply absent).
      const explicitNone = Object.prototype.hasOwnProperty.call(j, 'currentId') && j.currentId == null
      // Per-workspace selections (keys = absolute local workspace dirs). Entries
      // referencing machines deleted from the list are dropped on load (a stale
      // selection must never re-activate a ghost machine).
      const workspaces = {}
      if (j && typeof j.workspaces === 'object' && !Array.isArray(j.workspaces)) {
        for (const [k, v] of Object.entries(j.workspaces)) {
          if (typeof k !== 'string' || !k) continue
          const sel = normalizeSel(v)
          if (!sel) continue
          if (sel.machineId && !list.some((m) => m.id === sel.machineId)) {
            // Stale machine id → keep an explicit-none if that is what the user
            // chose, otherwise drop the entry entirely.
            if (sel.explicitNone) workspaces[k] = { machineId: '', workspace: '', explicitNone: true }
            continue
          }
          workspaces[k] = sel
        }
      }
      return { list, currentId, explicitNone, workspaces }
    }
  } catch {}
  return empty
}

/** Persist { list, currentId } and optionally the per-workspace selections.
 *  `currentId` may be null → active remote = none.
 *  Pass `keepCurrentKey: false` (add/update a machine without touching the
 *  current selection) to PRESERVE whatever `currentId` the file already holds
 *  — so merely saving a machine never flips a fresh registry into "explicit
 *  none", nor clears an explicit choice. When no previous file exists the
 *  `currentId` key is omitted entirely (fresh registry = "no choice yet").
 *  `workspaces` (5th arg, optional) is the full per-workspace selection map to
 *  persist; when omitted the map already stored in the file is preserved. */
export function saveMachines(file, list, currentId, keepCurrentKey = true, workspaces) {
  try { mkdirSync(path.dirname(file), { recursive: true }) } catch {}
  let stored = currentId
  let hasStored = keepCurrentKey
  let storedWorkspaces
  if (!keepCurrentKey || workspaces === undefined) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      if (prev) {
        if (!keepCurrentKey && Object.prototype.hasOwnProperty.call(prev, 'currentId')) {
          stored = prev.currentId
          hasStored = true
        }
        if (workspaces === undefined && prev && typeof prev.workspaces === 'object') {
          storedWorkspaces = prev.workspaces
        }
      }
    } catch { /* no previous file → omit the key */ }
  }
  const payload = { list }
  if (hasStored) payload.currentId = stored
  const ws = workspaces !== undefined ? workspaces : storedWorkspaces
  if (ws && typeof ws === 'object' && Object.keys(ws).length) payload.workspaces = ws
  writeFileSync(file, JSON.stringify(payload, null, 2))
}

/** Strip secrets before sending a machine to the client. */
export function sanitizeMachine(m) {
  if (!m) return m
  const { password, proxy, ...rest } = m
  const out = { ...rest, passwordSet: !!(m.password && m.password.length) }
  if (proxy) out.proxy = { ...proxy, password: proxy.password ? '' : undefined, passwordSet: !!(proxy.password && proxy.password.length) }
  return out
}

/** Apply a machine's fields onto the live config object (pool + tools read it). */
export function applyMachine(config, m) {
  if (!m) return
  config.host = m.host
  config.port = Number(m.port) || 22
  config.username = m.username || ''
  config.password = m.password || ''
  config.privateKeyPath = m.privateKeyPath || ''
  config.passphrase = m.passphrase || ''
  config.workspace = m.workspace || (config.workspace || '')
  if (m.hostKeyMode) config.hostKeyMode = m.hostKeyMode
  if (typeof m.useAgent === 'boolean') config.useAgent = m.useAgent
  if (typeof m.keyboardInteractive === 'boolean') config.keyboardInteractive = m.keyboardInteractive
  config.proxy = m.proxy && m.proxy.host ? m.proxy : undefined
}

/** Mint a fresh machine id. */
export function machineId() {
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}
