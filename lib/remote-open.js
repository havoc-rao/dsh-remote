// dsh-remote — "open the REMOTE project in a local editor" adapter for the
// harness open-in-app workspace-target provider extension point.
//
// Why this exists: the session-header "open in app" button opens the SESSION'S
// cwd, and a remote workspace's cwd is a LOCAL mirror directory — so the stock
// button would open the mirror. This provider claims such a cwd and opens the
// REAL remote directory through the editor's own SSH channel:
//
//   VS Code family (Cursor / Code / Insiders / Windsurf)
//     <cli> --remote ssh-remote+<host> <remote folder>
//   Zed
//     <cli> ssh://<host><remote folder>
//
// The <host> token is an ~/.ssh/config alias whenever one matches the mirror's
// recorded origin — the only form that carries a non-default port, user, key
// and ProxyJump into the editor — `user@host` for a plain port-22 host, and
// `user@host:port` for Zed (the one CLI that takes an inline port).
//
// A claimed workspace that no editor can address is REFUSED with an actionable
// message; it is never downgraded to opening the local mirror (that would look
// like success while opening the wrong thing).
//
// Everything here is dependency-injected (fs / spawn / ssh config / mirror
// lookup) so the mapping and refusal rules are unit-testable without a real
// editor, ssh config, or mirror tree.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'

import { joinRemotePath, normalizeRemotePath, relPathUnder } from './paths.js'
import { matchSshAlias, parseSshConfig, readSshConfigText } from './sshconfig.js'

/** Provider id reported to the harness (and shown in its diagnostics). */
export const PROVIDER_ID = 'dsh-remote'

/**
 * Editor catalog ids this provider can drive over SSH, in menu order. All of
 * them exist in the harness's open-in-app catalog (icons + locale names) — an
 * id the catalog/dictionary cannot name would be dropped by the button.
 */
export const REMOTE_OPEN_APPS = ['cursor', 'vscode', 'vscodeinsiders', 'windsurf', 'zed']

/**
 * Per-editor CLI discovery and remote-open argv.
 *
 * `kind` selects the argv shape: `vscode` is the VS Code family (`--remote
 * ssh-remote+<host> <folder>`, the form documented in the VS Code CLI
 * reference), `zed` is Zed's `ssh://` URI. `paths` are the explicit
 * install locations to probe before falling back to a PATH lookup.
 */
export const EDITOR_ADAPTERS = {
  cursor: {
    kind: 'vscode',
    cli: ['cursor'],
    paths: {
      darwin: [
        '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
        '~/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      ],
      linux: ['/usr/bin/cursor', '/usr/local/bin/cursor', '/opt/Cursor/cursor', '/snap/bin/cursor', '~/.local/bin/cursor'],
      win32: [
        '%LOCALAPPDATA%\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd',
        '%LOCALAPPDATA%\\Programs\\Cursor\\resources\\app\\bin\\cursor.cmd',
      ],
    },
  },
  vscode: {
    kind: 'vscode',
    cli: ['code'],
    paths: {
      darwin: [
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
        '~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      ],
      linux: ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code', '/usr/share/code/bin/code'],
      win32: [
        '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd',
        '%ProgramFiles%\\Microsoft VS Code\\bin\\code.cmd',
      ],
    },
  },
  vscodeinsiders: {
    kind: 'vscode',
    cli: ['code-insiders'],
    paths: {
      darwin: [
        '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
        '~/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
      ],
      linux: ['/usr/bin/code-insiders', '/usr/local/bin/code-insiders', '/snap/bin/code-insiders'],
      win32: [
        '%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd',
        '%ProgramFiles%\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd',
      ],
    },
  },
  windsurf: {
    kind: 'vscode',
    cli: ['windsurf'],
    paths: {
      darwin: [
        '/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
        '~/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf',
      ],
      linux: ['/usr/bin/windsurf', '/usr/local/bin/windsurf', '~/.local/bin/windsurf'],
      win32: ['%LOCALAPPDATA%\\Programs\\Windsurf\\bin\\windsurf.cmd'],
    },
  },
  zed: {
    kind: 'zed',
    cli: ['zed'],
    paths: {
      darwin: [
        '/Applications/Zed.app/Contents/MacOS/cli',
        '/Applications/Zed Preview.app/Contents/MacOS/cli',
        '~/.local/bin/zed',
      ],
      linux: ['/usr/bin/zed', '/usr/local/bin/zed', '~/.local/bin/zed'],
      win32: ['%LOCALAPPDATA%\\Programs\\Zed\\zed.exe'],
    },
  },
}

/** Executable suffixes a Windows PATH lookup must try, in PATHEXT order. */
const WIN_EXEC_SUFFIXES = ['.cmd', '.exe', '.bat', '']

/** The local login user (ssh's default when a config entry sets no User line). */
export function localUserName() {
  try {
    return userInfo().username
  } catch {
    return process.env.USER || process.env.USERNAME || ''
  }
}

/** Expand `~`, `$VAR` and `%VAR%` in one candidate path. */
export function expandPath(candidate, { env = process.env, home = homedir(), platform = process.platform } = {}) {
  let out = String(candidate || '')
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = home + out.slice(1)
  out = out.replace(/%([^%]+)%/g, (m, name) => {
    const v = env[name] ?? env[String(name).toUpperCase()] ?? env[String(name).toLowerCase()]
    return v === undefined ? m : String(v)
  })
  if (platform !== 'win32') out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => (env[name] === undefined ? m : String(env[name])))
  return out
}

/** PATH lookup over the injected environment (no shell, no `which`). */
export function findOnPath(name, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  const suffixes = platform === 'win32' ? WIN_EXEC_SUFFIXES : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const full = path.join(dir, name + suffix)
      if (exists(full)) return full
    }
  }
  return ''
}

/**
 * Absolute path of one editor's CLI on this host, or '' when not installed.
 * Explicit install locations win over PATH so a stale PATH entry cannot
 * shadow the app the user actually runs.
 */
export function resolveEditorCommand(appId, { platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  const adapter = EDITOR_ADAPTERS[appId]
  if (!adapter) return ''
  for (const candidate of (adapter.paths && adapter.paths[platform]) || []) {
    const full = expandPath(candidate, { env, home, platform })
    if (full && exists(full)) return full
  }
  for (const name of adapter.cli || []) {
    const found = findOnPath(name, { env, platform, exists })
    if (found) return found
  }
  return ''
}

/** Remote-capable editors actually installed on this host, in menu order. */
export function probeRemoteEditors(deps = {}) {
  return REMOTE_OPEN_APPS.filter((appId) => resolveEditorCommand(appId, deps) !== '')
}

/**
 * The remote path in the POSIX-leaning form an editor URI expects:
 * POSIX paths unchanged, a Windows drive path as `/c:/Users/...` (the form
 * Remote-SSH addresses Windows targets with), a UNC share as `/server/share/...`.
 */
export function toEditorUriPath(remotePath) {
  const norm = normalizeRemotePath(remotePath)
  const drive = norm.match(/^([a-zA-Z]):(.*)$/s)
  if (drive) return '/' + drive[1].toLowerCase() + ':/' + drive[2].replace(/\\/g, '/').replace(/^\/+/, '')
  if (norm.startsWith('\\\\')) return '/' + norm.slice(2).replace(/\\/g, '/')
  return norm.replace(/\\/g, '/')
}

/**
 * The REMOTE folder a local path inside a mirror stands for ('' when the path
 * is not inside that mirror). A session rooted in a mirror SUBDIRECTORY must
 * open that subdirectory, not the mirror root.
 * @param {{mirrorDir: string, remotePath: string}} mirror - owning mirror record.
 * @param {string} localPath - absolute local path inside the mirror.
 * @returns {string} remote folder in editor-URI form, or '' when outside.
 */
export function remoteFolderFor(mirror, localPath) {
  if (!mirror || !mirror.mirrorDir || !mirror.remotePath) return ''
  const rel = relPathUnder(mirror.mirrorDir, localPath)
  if (rel === null || rel === undefined) return ''
  const base = toEditorUriPath(mirror.remotePath)
  if (!rel) return base
  // A remote ROOT ('/') must not be joined to '//sub'.
  const joined = base === '/' ? '/' + rel : joinRemotePath(base, rel)
  return joined.replace(/\\/g, '/')
}

/**
 * The `<host>` token to hand an editor, or a thrown error explaining what to
 * add to ~/.ssh/config when no addressable form exists.
 * @param {{host: string, port?: number, username?: string, entries?: Array<object>, localUser?: string, allowPort?: boolean}} input - machine origin + parsed config.
 * @returns {string} ssh config alias, `user@host`, or (when allowed) `user@host:port`.
 */
export function sshHostSpec(input) {
  const host = String(input.host || '')
  const port = Number(input.port) || 22
  const user = String(input.username || 'root')
  const alias = matchSshAlias(input.entries || [], {
    host, port, username: user, localUser: input.localUser,
  })
  if (alias) return alias
  if (port === 22) return `${user}@${host}`
  if (input.allowPort) return `${user}@${host}:${port}`
  throw new Error(
    `no ~/.ssh/config alias matches ${user}@${host}:${port}, and this editor cannot take a non-default port inline — `
    + `add a Host entry (Host ${host} / HostName ${host} / User ${user} / Port ${port}, plus IdentityFile if the host `
    + 'does not use a default key) and retry',
  )
}

/**
 * Remote-open argv for one editor.
 * @param {string} appId - catalog editor id.
 * @param {string} hostSpec - ssh alias / `user@host[:port]`.
 * @param {string} folder - remote folder in editor-URI form.
 * @returns {Array<string>} argv (never a shell string).
 */
export function buildOpenArgs(appId, hostSpec, folder) {
  const adapter = EDITOR_ADAPTERS[appId]
  if (!adapter) throw new Error(`unsupported remote-open app: ${appId}`)
  if (adapter.kind === 'zed') return [`ssh://${hostSpec}${folder}`]
  return ['--remote', `ssh-remote+${hostSpec}`, folder]
}

/**
 * Launch one editor detached from this process: no stdio pipe, unrefed, so it
 * outlives the harness. Launch success is decoupled from editor lifetime — the
 * watch window only catches launchers that fail immediately (a still-running
 * child when the window closes counts as launched).
 * @param {string} command - editor CLI path.
 * @param {Array<string>} args - argv.
 * @param {{watchMs?: number}} [options] - early-failure watch window.
 * @returns {Promise<void>} resolves once the launch counts as successful.
 */
export function spawnDetachedEditor(command, args, options = {}) {
  const watchMs = Number(options.watchMs) > 0 ? Number(options.watchMs) : 1500
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch (err) {
      reject(err)
      return
    }
    let settled = false
    const settle = (finish) => {
      if (settled) return
      settled = true
      clearTimeout(watch)
      if (typeof child.unref === 'function') child.unref()
      finish()
    }
    const watch = setTimeout(() => { settle(resolve) }, watchMs)
    child.on('error', (err) => { settle(() => { reject(err) }) })
    child.on('exit', (code, signal) => {
      if (code === 0) settle(resolve)
      else settle(() => { reject(new Error(`editor launcher exited with code ${code}, signal ${signal}`)) })
    })
  })
}

/**
 * Build the harness open-in-app workspace-target provider.
 *
 * Contract (host side of `dsh-host-open-in-app`'s extension point):
 *   resolve({ path, sessionId }) → { provider, label, apps } | null
 *   launch({ app, path, sessionId }) → Promise<void>
 * `null` means "not my workspace": a plain local directory keeps the stock
 * local behaviour. A CLAIMED workspace never falls back — resolve() only
 * claims when it can also launch, and launch() rejects loudly otherwise.
 *
 * @param {object} deps - injected capabilities.
 * @param {(local: string) => object|null} deps.mirrorMatchOf - local path → owning mirror record.
 * @param {(sessionId: string) => string} [deps.sessionCwdOf] - session id → its cwd (host truth).
 * @param {() => string} [deps.sshConfigText] - ~/.ssh/config text.
 * @param {string} [deps.platform] - platform override (tests).
 * @param {object} [deps.env] - environment for PATH/`%VAR%` expansion.
 * @param {string} [deps.home] - home dir for `~`.
 * @param {(p: string) => boolean} [deps.exists] - existence probe.
 * @param {(command: string, args: Array<string>, options: object) => Promise<void>} [deps.spawnEditor] - detached launcher.
 * @param {string} [deps.localUser] - local login user (ssh's default User).
 * @param {number} [deps.watchMs] - early-failure watch window.
 * @returns {{id: string, resolve: Function, launch: Function}} the provider.
 */
export function createRemoteOpenProvider(deps) {
  const {
    mirrorMatchOf,
    sessionCwdOf = () => '',
    sshConfigText = () => readSshConfigText(),
    platform = process.platform,
    env = process.env,
    home = homedir(),
    exists = existsSync,
    spawnEditor = spawnDetachedEditor,
    localUser = localUserName(),
    watchMs = 1500,
  } = deps || {}

  // Probed once per plugin life (like the harness catalog): editors do not
  // appear mid-session, and a missing CLI re-probes once on ENOENT.
  let probed = null
  const availableApps = () => (probed ??= probeRemoteEditors({ platform, env, home, exists }))
  const sshEntries = () => parseSshConfig(sshConfigText())

  /**
   * The local workspace a request names, plus the path that was asked for.
   * Accepts `path` (the agreed field) or `cwd` (defensive: the harness also
   * holds the session cwd under that name).
   */
  const requestOf = (input) => ({
    localPath: input.path !== undefined ? input.path : input.cwd,
    sessionId: input.sessionId,
  })

  /** The authoritative local workspace for a request; `error` on mismatch. */
  const localTargetOf = (localPath, sessionId) => {
    const given = localPath ? path.resolve(String(localPath)) : ''
    let fromSession = ''
    if (sessionId) {
      const cwd = sessionCwdOf(sessionId)
      if (cwd) fromSession = path.resolve(String(cwd))
    }
    if (given && fromSession && given !== fromSession) {
      return { error: 'requested path is not this session\'s workspace' }
    }
    const local = given || fromSession
    return local ? { local } : { error: 'no workspace path' }
  }

  const planOf = (appId, local) => {
    const mirror = mirrorMatchOf(local)
    if (!mirror) throw new Error('not a remote mirror workspace')
    const folder = remoteFolderFor(mirror, local)
    if (!folder) throw new Error('cannot map the local mirror path to its remote path')
    const command = resolveEditorCommand(appId, { platform, env, home, exists })
    if (!command) throw new Error(`${appId} is not installed (or its CLI is not on PATH)`)
    const spec = sshHostSpec({
      host: mirror.host,
      port: mirror.port,
      username: mirror.username,
      entries: sshEntries(),
      localUser,
      allowPort: EDITOR_ADAPTERS[appId] && EDITOR_ADAPTERS[appId].kind === 'zed',
    })
    return { mirror, folder, command, args: buildOpenArgs(appId, spec, folder) }
  }

  return {
    id: PROVIDER_ID,

    /** Claim a remote workspace, or null to leave it to the stock behaviour. */
    async resolve(request) {
      const { localPath, sessionId } = requestOf(request || {})
      const target = localTargetOf(localPath, sessionId)
      if (target.error) return null
      const mirror = mirrorMatchOf(target.local)
      if (!mirror) return null
      const apps = availableApps()
      // No remote-capable editor installed → do NOT claim: the stock button
      // still offers the sensible local action (open the mirror).
      if (apps.length === 0) return null
      const folder = remoteFolderFor(mirror, target.local)
      if (!folder) return null
      return {
        provider: PROVIDER_ID,
        label: `${mirror.username}@${mirror.host}:${folder}`,
        apps,
      }
    },

    /** Open one claimed remote workspace in a local editor over SSH. */
    async launch(request) {
      const input = request || {}
      const { localPath, sessionId } = requestOf(input)
      const target = localTargetOf(localPath, sessionId)
      if (target.error) throw new Error(`dsh-remote: ${target.error}`)
      if (!availableApps().includes(input.app)) {
        throw new Error(`dsh-remote: ${String(input.app)} is not available for remote open`)
      }
      let plan = planOf(input.app, target.local)
      try {
        await spawnEditor(plan.command, plan.args, { watchMs })
      } catch (err) {
        // A verified CLI can still be gone (uninstalled since the probe):
        // re-probe once, then retry with the fresh path.
        if (err && err.code === 'ENOENT') {
          probed = null
          plan = planOf(input.app, target.local)
          await spawnEditor(plan.command, plan.args, { watchMs })
        } else {
          throw err
        }
      }
    },
  }
}
