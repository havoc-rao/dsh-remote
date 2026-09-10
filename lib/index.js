// dsh-remote — remote-work assistant for DeepSeek Harness.
//
// Host half. Turns "give me a remote host + login" into a usable REMOTE WORKSPACE:
//   • one persistent SSH/SFTP pool per configured remote (password OR private key,
//     SSH agent, keyboard-interactive, proxy jump),
//   • a "current remote workspace" — a remote directory the agent treats as the
//     active project root (user@host:/path) — injected into every system prompt,
//   • model tools `rw_*` (info/connect/workspace/list/read/write/edit/append/mkdir/
//     remove/move/stat/exec/search/download/upload/sync/push/forward/disconnect),
//   • JSON endpoints the client settings page + sidebar use over the harness
//     `webServer` (machines / ls / read / write / fs / forwards / task / audit /
//     ssh-config / local-pick / …),
//   • local mirror of the remote workspace (three-way conflict-aware SFTP sync),
//   • optional OS-keychain password storage, command audit log, TOFU host keys.
//
// The engine (path guard + shell quoting + ssh pool + exec) keeps the proven
// foundation; `ctx.fs` / the local workspace registry stay untouched — this is a
// REMOTE workspace presented as such to the model and UI.
//
// Plugin Config MUST be a schemastery schema (zod rejects the undefined row config).
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, appendFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'

import {
  shq, normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs,
  toShellPath, toDisplayPath, remotePathBase, truncate, shortHash,
} from './paths.js'
import { createHostKeyGuard, isHostKeyKnown as _isHostKeyKnown } from './hostkey.js'
import { compileIgnore, DEFAULT_IGNORE } from './ignore.js'
import {
  parseStatusV1, parseWorktreeList, parseLogGraphLines, parseForEachRefPairs, parseLeftRightCount, countStatusLines,
} from './git-parse.js'
import { classifyError, friendlyMessage } from './errors.js'
import { importableEntries, sshConfigPath, readSshConfigText, resolveMachineSshConfig } from './sshconfig.js'
import { createRemoteFileReference, installFileReferenceOverlay, DEFAULT_EXCLUDED_DIRECTORIES } from './file-reference.js'
import { saveSecret, getSecret, deleteSecret, platformBackend, persistPassword } from './credential.js'
import { syncTree, pushTree, loadSyncState, saveSyncState, pushOneFile } from './sync.js'
import { searchRemote } from './search.js'
import { resolveMirror, poolKey, lookupSessionCwd, encodeSegmentSafe, readSessionHeaderCwd, requestSessionHint } from './binding.js'
import { TaskManager } from './tasks.js'
import { ForwardManager } from './forwards.js'
import { TerminalManager } from './terminal.js'
import { pickMirrorForRemotePath } from './route-machine.js'

import { WebSocketServer } from 'ws'
import { selfDir, readVersion, gtVersion, fetchLatestVersion, applyUpdate, persistUpdateMode, readUpdateMode } from './update.js'
import { loadMachines as _loadMachines, saveMachines as _saveMachines, sanitizeMachine as _sanitizeMachine, applyMachine as _applyMachine, machineId as _machineId } from './registry.js'
import { registerHttpTransports } from './http-transport.js'
import { SshPool } from './pool.js'
import { createFsRoutes } from './routes-fs.js'
import { listDirStructured, removeRemoteTree } from './remote-fs.js'

export const name = 'dsh-remote'

// Web and Desktop share the SSH tools; each optional UI transport is attached
// reactively below, so service startup order does not drop the JSON routes.
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  /** Remote SSH host (empty → the plugin starts disconnected). */
  host: z.string().default(''),
  /** Remote SSH port (22 unless the machine uses a custom port). */
  port: z.number().step(1).min(1).max(65535).default(22),
  /** SSH login user. */
  username: z.string().default(''),
  /** Password login (only when the remote has no key. Override the fallback below). */
  password: z.string().default(''),
  /** Explicit SSH private-key path (optional; only used when supplied). Never auto-reads ~/.ssh. */
  privateKeyPath: z.string().default(''),
  /** Key passphrase when the key is encrypted. */
  passphrase: z.string().default(''),
  /** Initial remote workspace path (absolute dir the agent should treat as root). */
  workspace: z.string().default(''),
  /** Remote command terminal strategy. '' = auto-detect (Windows remotes look
   * for Git Bash and pipe every command through `bash -s`); 'git-bash' = prefer
   * Git Bash on Windows; 'native' = never wrap; any other value = explicit
   * bash.exe path (e.g. 'C:\\Program Files\\Git\\bin\\bash.exe'). Git Bash makes
   * a Windows remote behave like a POSIX host (/c/Users/... paths). */
  shell: z.string().default(''),
  /** Per-command timeout. */
  commandTimeoutMs: z.number().step(1).min(1000).default(20000),
  /** SSH connection establishment timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** Hard ceiling on collected remote output per call. */
  maxOutputChars: z.number().step(1).min(1024).default(200000),
  /** Skip mirroring files larger than this many bytes (0 = no cap). */
  maxFileBytes: z.number().step(1).min(0).default(52428800),
  /** Host-key policy: `accept-new` (default) records a host's key on first
   * connect and verifies it afterwards (mirrors ssh's StrictHostKeyChecking
   * accept-new); `verify` also rejects hosts never seen before; `off` skips
   * verification entirely (MITM-unsafe, not recommended). */
  hostKeyMode: z.string().default('accept-new'),
  /** Use the OpenSSH agent (SSH_AUTH_SOCK) when no password/key is configured. */
  useAgent: z.boolean().default(false),
  /** Allow keyboard-interactive auth (OTP/MFA chains) using the configured password. */
  keyboardInteractive: z.boolean().default(false),
  /** Max concurrent remote terminal sessions (browser terminals + agent). */
  terminalMaxSessions: z.number().step(1).min(1).max(64).default(8),
  /** How long an unattached remote terminal session survives before its
   * shell is killed (the view's reconnect grace; park frames keep sessions
   * alive indefinitely). */
  terminalReconnectGraceMs: z.number().step(1).min(5000).default(60000),
  /** Jump host / bastion: connect through this machine first. All fields have
   * defaults so this works on schemastery versions without `.optional()`; an
   * empty `host` means "no jump host". */
  proxy: z.object({
    host: z.string().default(''),
    port: z.number().step(1).min(1).max(65535).default(22),
    username: z.string().default(''),
    password: z.string().default(''),
    privateKeyPath: z.string().default(''),
  }),
  /** Auto-push edited mirror files back to the remote (watcher, debounced). Default off. */
  autoPush: z.boolean().default(false),
  /** Append executed commands to the audit log under the harness home. */
  auditLog: z.boolean().default(true),
  /** Text encoding for remote file reads/writes (utf-8 default; gbk etc.). */
  encoding: z.string().default('utf-8'),
  /** Remote `@` completion (issue #39). When on, a session whose workspace is a
   * dsh-remote mirror lists the REMOTE tree for `@` (over SFTP, bounded) instead
   * of the local mirror — which `ensureMirror()` leaves empty until a sync, so
   * `@` used to find nothing at all. Sessions on a local workspace are
   * untouched, and a host that cannot be reached falls back to the mirror. */
  fileReference: z.boolean().default(true),
  /** Max `@` candidates rendered for one query (mirrors the local provider). */
  fileReferenceMaxResults: z.number().step(1).min(1).default(20),
  /** Max entries retained in the remote `@` index of one workspace. */
  fileReferenceMaxEntries: z.number().step(1).min(1).default(3000),
  /** Directory basenames the remote `@` traversal skips. */
  fileReferenceExcludedDirectories: z.array(z.string()).default([...DEFAULT_EXCLUDED_DIRECTORIES]),
  /** Wall-clock budget (ms) for one remote `@` index pass; on expiry the
   *  partial index answers rather than making the caret wait. */
  fileReferenceTimeoutMs: z.number().step(1).min(200).default(4000),
  /** Update mode: `manual` (default) only checks when asked; `auto` checks on
   * load and periodically, applying a newer npm release automatically;
   * `off` disables version checks entirely. (schemastery 3.18 has no .enum —
   * keep string and validate in code.) */
  updateMode: z.string().default('manual'),
  /** How often (ms) auto mode checks the npm registry for a newer release. */
  updateCheckIntervalMs: z.number().step(1).min(60000).default(6 * 3600 * 1000),
  /** Sidebar directory-flow slot key for the remote workspace picker
   * (DirPicker). Empty (default) = auto: the official
   * `sidebar.workspaces.directoryFlow`, switching to dsh-enhanced-workspace's
   * own hole `enhanced-workspace.workspace.directoryFlow` when that plugin is
   * mounted in the same profile (its priority -1 shadow of `sidebar.workspaces`
   * leaves the official sub-slot registered-but-never-rendered). dsh-remote's
   * bundle patch fills this automatically via a `!!js` config expression over
   * the composed patch stack; a static profile-layer config overrides it (the
   * patch machinery replaces the whole config field, which naturally wins). */
  sidebarDirectoryFlowSlot: z.string().default(''),
})

export const SIDEBAR_DIRECTORY_FLOW_SLOT_OFFICIAL = 'sidebar.workspaces.directoryFlow'
export const SIDEBAR_DIRECTORY_FLOW_SLOT_ENHANCED = 'enhanced-workspace.workspace.directoryFlow'

// ── shell / path helpers (pure implementations in lib/paths.js) ───────────

/** Harness home: respect `DSH_HOME` when set (the desktop app sets it to its
 * own `userData/harness`), otherwise fall back to `~/.dsh`. */
function dshBase() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(homedir(), '.dsh')
}

/** Root holding every remote host's mirrors + the machine registry. */
function remoteWorkspacesRoot() {
  return path.join(dshBase(), 'remote-workspaces')
}

/** Local mirrors of one remote host. */
function mirrorRootFor(host, user, port) {
  const tag = [host, user, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(remoteWorkspacesRoot(), tag)
}

/** Local mirror dir for a specific remote path (idempotent → returns same dir). */
function mirrorDirFor(remotePath, { host, username: user, port }) {
  const base = remotePathBase(remotePath)
  const root = mirrorRootFor(host, user, port)
  const plain = path.join(root, base)
  const norm = normalizeRemotePath(remotePath)
  // A pre-existing mirror for this exact remote origin → reuse it (idempotent).
  try {
    const meta = JSON.parse(readFileSync(path.join(plain, '.dsh-remote-meta.json'), 'utf8'))
    if (meta.remotePath === norm) return plain
  } catch {
    /* no mirror yet → fall through */
  }
  if (!existsSync(plain)) return plain
  return path.join(root, base + '-' + shortHash(norm))
}

/** Create the local mirror dir + a meta file describing its remote origin.
 *  `extra.alias` records the ~/.ssh/config alias a machine was saved as (issue
 *  #38), so the mirror keeps resolving to its machine even if the alias's
 *  HostName/user/port change in that file afterwards. */
function ensureMirror(remotePath, { host, username: user, port }, extra = {}) {
  const dir = mirrorDirFor(remotePath, { host, username: user, port })
  mkdirSync(dir, { recursive: true })
  const meta = { host, port, username: user, remotePath: normalizeRemotePath(remotePath), createdAt: new Date().toISOString() }
  if (extra.alias) meta.alias = String(extra.alias)
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify(meta, null, 2))
  return dir
}

/** The mirror dir that OWNS a local path, plus the remote origin recorded in
 *  its .dsh-remote-meta.json. Per-workspace isolation anchor: a session whose
 *  cwd sits inside a mirror belongs to the machine written in that meta file —
 *  never to whatever machine another workspace picked last (issue #13). */
function mirrorEntries() {
  const root = remoteWorkspacesRoot()
  const out = []
  try {
    for (const hostDir of readdirSync(root)) {
      const hostPath = path.join(root, hostDir)
      if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
      for (const dir of readdirSync(hostPath)) {
        try {
          const mirrorDir = path.resolve(hostPath, dir)
          const meta = JSON.parse(readFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), 'utf8'))
          if (typeof meta.host !== 'string' || !meta.host || typeof meta.remotePath !== 'string' || !meta.remotePath) continue
          // Compatibility for mirrors written with swapped positional arguments.
          // Only recover an origin confirmed by the saved machine registry.
          if (typeof meta.username === 'number' && typeof meta.port === 'string') {
            const saved = _loadMachines(path.join(root, 'machines.json')).list
            if (!saved.some((m) => m.host === meta.host && Number(m.port || 22) === meta.username && (m.username || 'root') === meta.port)) continue
            const oldPort = meta.port
            meta.port = meta.username
            meta.username = oldPort
          }
          if (meta.username !== undefined && typeof meta.username !== 'string') continue
          const port = Number(meta.port ?? 22)
          if (!Number.isInteger(port) || port < 1 || port > 65535) continue
          out.push({ mirrorDir, host: meta.host, port, username: meta.username || 'root', remotePath: meta.remotePath })
        } catch { /* missing or invalid origin */ }
      }
    }
  } catch { /* registry absent or unreadable */ }
  return out
}

function mirrorMatchOf(local) {
  if (!local) return null
  const base = path.resolve(String(local))
  return mirrorEntries()
    .filter((m) => base === m.mirrorDir || base.startsWith(m.mirrorDir + path.sep))
    .sort((a, b) => b.mirrorDir.length - a.mirrorDir.length)[0] || null
}

/** Recursive directory copy (EXDEV fallback for migrateLegacyData). */
function copyDirSync(from, to) {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    if (e.isDirectory()) copyDirSync(s, d)
    else try { copyFileSync(s, d) } catch { /* skip unreadable */ }
  }
}

/** One-time migration of pre-0.6 data (~/.dsh/remote-workspaces) into DSH_HOME.
 * Only runs when the harness is on its DEFAULT home: an explicitly-set DSH_HOME
 * pointing elsewhere means ~/.dsh belongs to another installation — migrating
 * would RENAME that other installation's live data out from under it. */
function migrateLegacyData() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim() && path.resolve(String(env).trim()) !== path.join(homedir(), '.dsh')) return
  const legacy = path.join(homedir(), '.dsh', 'remote-workspaces')
  const target = remoteWorkspacesRoot()
  if (legacy === target || !existsSync(legacy) || existsSync(target)) return
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    try {
      renameSync(legacy, target)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      copyDirSync(legacy, target)
    }
  } catch {
    // Migration is best-effort: a fresh registry is created on next save.
  }
}

// ── persistent multi-machine registry ─────────────────────────────────────
// Pure registry logic lives in lib/registry.js (unit-tested): saved machines
// are STANDBY connections; only an explicit "set current" activates one.
// (issue #13 — Saved Connections != Active Remote Context)
const MACHINES_FILE = 'machines.json'
const machinesFile = () => path.join(remoteWorkspacesRoot(), MACHINES_FILE)
const secretsDir = () => path.join(remoteWorkspacesRoot(), '.secrets')
const forwardsFile = () => path.join(remoteWorkspacesRoot(), 'forwards.json')
const auditFile = () => path.join(remoteWorkspacesRoot(), 'audit.log')
const ignoreFile = () => path.join(remoteWorkspacesRoot(), '.dsh-remote-ignore')

const loadMachines = () => _loadMachines(machinesFile())
const saveMachines = (list, currentId, keepCurrentKey) => _saveMachines(machinesFile(), list, currentId, keepCurrentKey)
const sanitizeMachine = _sanitizeMachine
const applyMachine = _applyMachine
const machineId = _machineId

// ── host-key registry (TOFU) ──────────────────────────────────────────────
const KNOWN_HOSTS_FILE = 'known_hosts.json'
const knownHostsFile = () => path.join(remoteWorkspacesRoot(), KNOWN_HOSTS_FILE)
const isHostKeyKnown = (host, port) => _isHostKeyKnown(knownHostsFile(), host, port)

/** WS-upgrade trust fence for the terminal endpoint (same shape better-
 *  sidebar's routes use): the Host header must be a loopback authority,
 *  sec-fetch-site must not be cross-site, and an Origin header — when
 *  present — must point at the same hostname. Loopback-only by design (DSH
 *  web binds localhost); LAN deployments should proxy through the harness. */
function trustedWsUpgrade(req) {
  const host = String((req.headers && req.headers.host) || '')
  const m = host.match(/^\[?([^:\]]+)\]?(?::\d+)?$/)
  if (!m) return false
  const name = m[1].toLowerCase()
  if (!(name === 'localhost' || name === '::1' || /^127\./.test(name))) return false
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


// ── encoding helpers ───────────────────────────────────────────────────────

function decodeBuf(buf, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.decode(buf, e) : buf.toString('utf8')
}
function encodeText(s, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.encode(String(s), e) : Buffer.from(String(s), 'utf8')
}

// ── apply ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const pool = new SshPool(config, { knownHostsFile })
  ctx.effect(() => () => pool.close(), 'dsh-remote.close')

  // ── 侧栏 directory-flow 槽位 key：优先级链 ────────────────────────────────
  // ① 用户显式 config（profile 层 patch 写静态 config，applyEntryPatches 整字段
  //    替换，天然覆盖 dsh-remote 自带 patch 的表达式）> ② patch 表达式算出的
  //    config（cordis.patch.yml 的 !!js，见该文件注释）> ③ host 运行期兜底探测
  //    loader.entries()（防 patch stack 不可见的注入形态，如 HMR / 运行期注入）
  //    > ④ 官方默认 sidebar.workspaces.directoryFlow。
  // 最终值经 GET /dsh-remote/slot-config 下发给浏览器 half（DirPicker 侧栏注册）。
  const effectiveSlot = (() => {
    if (config.sidebarDirectoryFlowSlot && String(config.sidebarDirectoryFlowSlot).trim()) {
      return { slot: String(config.sidebarDirectoryFlowSlot).trim(), source: 'config' }
    }
    try {
      const loader = (ctx && (ctx.loader || (typeof ctx.get === 'function' ? ctx.get('loader') : null))) || null
      if (loader && typeof loader.entries === 'function') {
        for (const e of loader.entries()) {
          if (e && e.options && e.options.name === 'dsh-enhanced-workspace') {
            return { slot: SIDEBAR_DIRECTORY_FLOW_SLOT_ENHANCED, source: 'probe' }
          }
        }
      }
    } catch { /* loader service unavailable — fall through to the official default */ }
    return { slot: SIDEBAR_DIRECTORY_FLOW_SLOT_OFFICIAL, source: 'default' }
  })()

  migrateLegacyData()

  // ── machine registry (multi-host, PER-WORKSPACE active context) ──────────
  // The machine LIST is a global registry of saved machines (standby, issue
  // #13). The ACTIVE remote context, however, is a property of ONE local
  // workspace dir (a session's cwd) and never of the whole app:
  //   • a cwd inside a dsh-remote mirror → its owner machine (mirror meta);
  //   • a plain local cwd → ONLY the machine the user explicitly selected
  //     FOR THIS WORKSPACE (persisted in store.workspaces[cwd]) — never
  //     whatever machine some other project picked last.
  // There is intentionally NO app-wide "current machine" anymore: no global
  // auto-restore, no currentId-driven pool binding (the leak that made local
  // project workspaces connect to an unrelated remote project's workspace).
  const store = loadMachines()
  const machines = store.list
  const machineIndex = (id) => machines.findIndex((m) => m.id === id)

  // ── ssh-config aliases (issue #38) ────────────────────────────────────────
  //
  // A machine may be saved as an ALIAS (`useSshConfig: true`, `host` = the Host
  // line of ~/.ssh/config). The registry then holds NO HostName/user/port/key —
  // every connect resolves the alias against the config file as it is right now
  // (VSCode Remote-SSH behaviour). The text is memoised for a couple of seconds
  // so one request that resolves several machines reads the file once, while an
  // edit to ~/.ssh/config still lands almost immediately.
  let sshConfigCache = { text: '', at: 0 }
  const sshConfigText = () => {
    const now = Date.now()
    if (now - sshConfigCache.at > 2000) sshConfigCache = { text: readSshConfigText(), at: now }
    return sshConfigCache.text
  }

  /**
   * A machine's CONNECT identity: alias machines are resolved through
   * ~/.ssh/config; every other machine is returned untouched. The returned
   * record keeps the registry fields (id, password, credentialBackend, …) so
   * keychain lookups and the settings UI keep working.
   */
  const loggedSshWarnings = new Map()
  const withSshConfig = (m) => {
    // Short-circuit BEFORE reading ~/.ssh/config: a deployment with no alias
    // machine must never touch that file, and the 2s text memo must not be
    // primed by unrelated machines.
    if (!m || !m.useSshConfig) return m
    const resolved = resolveMachineSshConfig(m, { text: sshConfigText() })
    if (!resolved) return m
    // Warn once per distinct warning set: this runs on every tool call, and an
    // unmatched alias would otherwise fill the log with the same line.
    const signature = resolved.warnings.join(' | ')
    if (signature && loggedSshWarnings.get(resolved.alias) !== signature) {
      loggedSshWarnings.set(resolved.alias, signature)
      try {
        const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[dsh-remote] ssh-config alias "${resolved.alias}": ${resolved.warnings.join(' ')}`)
        }
      } catch { /* logging is best-effort */ }
    }
    return {
      ...m,
      sshAlias: resolved.alias,
      sshConfigMatched: resolved.matched,
      sshConfigWarnings: resolved.warnings,
      host: resolved.host,
      port: resolved.port,
      username: resolved.username || m.username,
      privateKeyPath: resolved.privateKeyPath || '',
      proxy: resolved.proxy,
    }
  }

  /** The alias a machine was saved as ('' for a machine with literal values). */
  const aliasOf = (m) => (m && m.sshAlias) || (m && m.useSshConfig ? String(m.host || '') : '')

  /** Machines as the settings UI sees them: secrets stripped, plus the
   *  ~/.ssh/config resolution of an alias machine so a row can show where the
   *  alias actually points without duplicating those values in the registry
   *  (issue #38). */
  const machinesForClient = () => machines.map((m) => ({
    ...sanitizeMachine(m),
    // Read ~/.ssh/config only when a machine actually uses an alias.
    sshConfigResolved: m.useSshConfig ? resolveMachineSshConfig(m, { text: sshConfigText() }) : null,
  }))

  const machineByTarget = (host, port, username) => machines.find((m) =>
    String(m.host) === String(host) && Number(m.port) === Number(port) && String(m.username || 'root') === String(username || 'root'))
  /** `workspaces` map (may be absent on files written by older versions). */
  if (!store.workspaces || typeof store.workspaces !== 'object') store.workspaces = {}

  /** Resolve a machine's effective password (keychain backend support). */
  const machinePassword = async (m) => {
    if (m && m.password) return m.password
    if (m && m.credentialBackend && m.credentialBackend !== 'plain') {
      const p = await getSecret(m.id, secretsDir())
      if (p) return p
    }
    return ''
  }

  /** Canonical key of a local workspace dir (the isolation unit). */
  const wsKeyOf = (cwd) => path.resolve(String(cwd || '')).replace(/[\\/]+$/, '') || ''

  // Per-workspace selection store: a runtime overlay (ephemeral rw_connect
  // save:false within one workspace) over the persisted `store.workspaces`
  // map. A selection is { machineId, workspace, explicitNone }.
  const wsEphemeral = new Map() // wsKey -> sel (NOT persisted)
  const wsSel = (cwd) => {
    const k = wsKeyOf(cwd)
    if (!k) return null
    const r = wsEphemeral.get(k)
    if (r) return r
    return store.workspaces[k] || null
  }
// ── per-machine SSH pools (session-bound) ─────────────────────────────────
  // The `pool` above stays the ACTIVE-machine pool: it backs the settings page,
  // the workspace picker routes, and `rw_connect`, whose semantics are "switch
  // the active machine". Session-bound tool calls must not go through it —
  // `setTarget()` rewrites the shared `config` identity and closes the live
  // connection, so two sessions on different machines would take the pool from
  // each other and commands would land on the wrong host (issue #25).
  //
  // Instead each machine gets its own pool, keyed by its stable identity. A
  // session resolves its machine from its own workspace mirror, so concurrent
  // sessions on different hosts never share a connection. Sessions on the SAME
  // machine still share one, preserving the single-connection + keepalive model.

  /** Deployment-varying tunables shared by every pool, owned by the live plugin
   *  Config so a settings change reaches existing pools. Identity, credential,
   *  and per-machine policy fields (`hostKeyMode`, `shell`, `proxy`) are
   *  deliberately excluded — those are pinned per pool from the machine record,
   *  and re-copying them from the shared config is exactly the bug this
   *  registry fixes. */
  const TUNABLE_KEYS = [
    'connectTimeoutMs', 'commandTimeoutMs', 'maxOutputChars', 'maxFileBytes', 'encoding',
  ]
  const syncTunables = (target) => {
    for (const k of TUNABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(config, k)) target[k] = config[k]
    }
    return target
  }

  const machinePools = new Map()
  ctx.effect(() => () => {
    for (const p of machinePools.values()) {
      try { p.close() } catch { /* a pool already torn down by its own error path */ }
    }
    machinePools.clear()
  }, 'dsh-remote.machine-pools')

  /** Registry record for a resolved mirror origin, so a session-bound pool gets
   *  the machine's real credentials (key path, passphrase, agent, proxy) rather
   *  than only the host/user/port the mirror meta records.
   *
   *  An EPHEMERAL connection (rw_connect save:false) is not in the registry but
   *  is still a legitimate credential source for a pool the same process later
   *  resolves for that identity: without it a mirror picked on a temporary
   *  connection would resolve to an empty-credential pool and fail to connect.
   *
   *  An ssh-config ALIAS machine (issue #38) is matched through its RESOLVED
   *  identity, and directly by the alias the mirror recorded — so a mirror keeps
   *  resolving to its machine even after a HostName/port change in ~/.ssh/config,
   *  which is the whole point of not copying those values into the registry. */
  const identityOf = (m) => {
    const r = withSshConfig(m)
    return { host: r.host, port: Number(r.port) || 22, username: r.username || '' }
  }
  const identityMatches = (m, { host, port, username }) => {
    if (!m) return false
    const id = identityOf(m)
    return id.host === host && id.port === Number(port) && id.username === (username || '')
  }
  const machineRecordFor = ({ host, port, username, alias }) =>
    (identityMatches(ephemeral, { host, port, username }) ? ephemeral : null)
    || (alias ? machines.find((m) => aliasOf(m) === alias) : null)
    || machines.find((m) => identityMatches(m, { host, port, username }))
    || null

  /**
   * Get (or lazily create) the dedicated pool for one remote identity.
   * @param {{host: string, port: number, username: string}} target - the mirror-recorded origin.
   * @returns {SshPool} the pool pinned to that identity; never the active-machine pool.
   */
  const poolForMachine = (target) => {
    const key = poolKey(target)
    // `rec` is the registry record (raw); `eff` is its CONNECT identity, with an
    // ssh-config alias resolved (issue #38). For an alias whose HostName/USER/port
    // changed since the mirror was created, the RESOLVED identity wins over the
    // mirror-recorded one — that is what makes an edit to ~/.ssh/config take
    // effect for an existing session instead of dialing the stale address.
    const rec = machineRecordFor(target)
    const eff = rec ? withSshConfig(rec) : null
    const host = (eff && eff.host) || target.host
    const port = Number((eff && eff.port) || target.port) || 22
    const username = (eff && eff.username) || target.username || 'root'
    const existing = machinePools.get(key)
    if (existing) {
      syncTunables(existing.config)
      // Re-point a live pool whose resolved identity moved (setTarget closes the
      // connection, so only do it when something actually changed).
      if (existing.config.host !== host || Number(existing.config.port) !== port || (existing.config.username || '') !== username) {
        existing.setTarget({ host, port, username })
      }
      // Re-read credentials and per-machine policy from the registry: editing a
      // machine in the settings page must reach a pool created earlier, and a
      // pool holding a stale password would keep failing to reconnect.
      if (eff) {
        existing.config.password = eff.password || ''
        existing.config.privateKeyPath = eff.privateKeyPath || ''
        existing.config.passphrase = eff.passphrase || ''
        existing.config.useAgent = !!eff.useAgent
        existing.config.keyboardInteractive = !!eff.keyboardInteractive
        existing.config.proxy = eff.proxy || undefined
        existing.config.hostKeyMode = eff.hostKeyMode || config.hostKeyMode
      }
      return existing
    }
    const poolConfig = syncTunables({
      ...config,
      host,
      port,
      username,
      password: (eff && eff.password) || '',
      privateKeyPath: (eff && eff.privateKeyPath) || '',
      passphrase: (eff && eff.passphrase) || '',
      useAgent: eff ? !!eff.useAgent : !!config.useAgent,
      keyboardInteractive: eff ? !!eff.keyboardInteractive : !!config.keyboardInteractive,
      proxy: (eff && eff.proxy) || undefined,
      hostKeyMode: (eff && eff.hostKeyMode) || config.hostKeyMode,
      // Identity-pinned pools never carry the shared active workspace: a
      // session passes its own mirror-resolved remote path explicitly.
      workspace: '',
    })
    const created = new SshPool(poolConfig, { knownHostsFile })
    // Keychain-backed passwords resolve against THIS pool's machine record.
    created.passwordResolver = async () => machinePassword(eff || { id: '', password: poolConfig.password })
    machinePools.set(key, created)
    return created
  }

  const wsSelSet = (cwd, sel, { persist = true } = {}) => {
    const k = wsKeyOf(cwd)
    if (!k) return
    if (persist) {
      wsEphemeral.delete(k)
      store.workspaces[k] = sel
      saveMachines(machines, store.currentId, true, store.workspaces)
    } else {
      wsEphemeral.set(k, sel)
    }
  }
  const wsSelClear = (cwd, { persist = true } = {}) => {
    const k = wsKeyOf(cwd)
    if (!k) return
    if (persist) {
      wsEphemeral.delete(k)
      if (store.workspaces[k]) {
        delete store.workspaces[k]
        saveMachines(machines, store.currentId, true, store.workspaces)
      }
    } else {
      wsEphemeral.delete(k)
    }
  }

/** The remote context ONE local workspace dir resolves to. Shapes:
   *   mode 'remote':  cwd sits inside a mirror → machine = mirror owner,
   *                   workspace = the mirror's remote path;
   *   mode 'local':   cwd has NO remote context (nothing selected for it);
   *   `selection`/`explicit-none` intermediate states are folded in via
   *   wsSel() when the cwd is not mirror-owned (used by tools/terminal only —
   *   the UI resolve-mirror contract stays strictly mirror-cwd based). */
  const ctxForCwd = (cwd) => {
    const k = wsKeyOf(cwd)
    const base = {
      cwd: k, mode: 'local', source: 'none',
      host: '', port: 0, username: '', workspace: '',
      machineId: '', machine: null, mirrorDir: '', explicitNone: false,
    }
    if (!k) return base
    const m = mirrorMatchOf(k)
    if (m) {
      const rec = machineByTarget(m.host, m.port, m.username)
      return {
        ...base,
        mode: 'remote', source: 'mirror', mirrorDir: m.mirrorDir,
        host: m.host, port: m.port, username: m.username,
        workspace: m.remotePath,
        machineId: rec ? rec.id : '', machine: rec || null,
      }
    }
    const sel = wsSel(k)
    if (sel && sel.machine) {
      // An EPHEMERAL (unsaved) machine rides along in the runtime selection —
      // it binds this workspace only and never touches the registry.
      return {
        ...base,
        mode: 'remote', source: 'ephemeral',
        host: sel.machine.host, port: Number(sel.machine.port) || 22, username: sel.machine.username || 'root',
        workspace: sel.workspace || sel.machine.workspace || '',
        machineId: sel.machine.id || '', machine: sel.machine,
      }
    }
    if (sel && sel.explicitNone) {
      // Explicit "this workspace has no remote" — saved machines AND the
      // profile-config default must both stay out (issue #13).
      return { ...base, explicitNone: true, source: 'explicit-none' }
    }
    if (sel && sel.machineId) {
      const i = machineIndex(sel.machineId)
      const rec = i >= 0 ? machines[i] : null
      if (rec) {
        return {
          ...base,
          mode: 'remote', source: 'selection',
          host: rec.host, port: Number(rec.port) || 22, username: rec.username || 'root',
          workspace: sel.workspace || rec.workspace || '',
          machineId: rec.id, machine: rec,
        }
      }
    }
    // Profile-config default machine (explicit operator/CLI config). Only when
    // the workspace has NO own selection; never a SAVED machine (those stay
    // standby). The desktop app leaves config.host empty, so local project
    // workspaces stay remote:none there — the isolation guarantee holds.
    if (config.host) {
      const rec = machineByTarget(config.host, config.port, config.username || 'root')
      return {
        ...base,
        mode: 'remote', source: 'config',
        host: String(config.host), port: Number(config.port) || 22, username: config.username || 'root',
        workspace: String(config.workspace || ''),
        machineId: rec ? rec.id : '',
        machine: rec || { id: machineId(), name: String(config.host), host: String(config.host), port: Number(config.port) || 22, username: config.username || 'root', password: config.password || '', privateKeyPath: config.privateKeyPath || '', passphrase: config.passphrase || '' },
      }
    }
    return base
  }

  /** Workspace of the caller of a tool / prompt hook ('' when unknown).
   *  Tools execute with an agent-scoped exec whose session carries the cwd —
   *  that cwd is the ONLY authority for per-workspace isolation. */
  const callerCwdOf = (exec) => {
    try {
      const s = exec && exec.agent && exec.agent.session
      if (s && s.header && s.header.cwd) return String(s.header.cwd)
    } catch { /* agent/session shape differs */ }
    return ''
  }

  /** Explicitly bind `machineId` ('' or null = clear) to ONE workspace dir.
   *  No global current exists; every activation is per workspace. */
  const setWorkspaceCurrent = async (cwd, machineId, workspace) => {
    const k = wsKeyOf(cwd)
    if (!k) throw new Error('setWorkspaceCurrent: no workspace dir given')
    if (!machineId) {
      // Explicit "this workspace has no remote" — saved machines stay in the
      // registry (issue #13) but nothing binds to this workspace.
      wsSelSet(k, { machineId: '', workspace: '', explicitNone: true })
      return
    }
    const i = machineIndex(machineId)
    if (i < 0) throw new Error('setWorkspaceCurrent: machine not found')
    wsSelSet(k, { machineId, workspace: workspace !== undefined ? String(workspace) : (machines[i].workspace || ''), explicitNone: false })
    return machines[i]
  }

  // Legacy aliases for the pre-isolation global activation, kept only until
  // every caller is migrated. They now mean "the profile-config host", never a
  // workspace selection / a stored currentId.
  let ephemeral = null // legacy: global ephemeral tool connection (unused by per-workspace flows)
  const profileMachine = () => {
    if (config.host) {
      const rec = machineByTarget(config.host, config.port, config.username || 'root')
      return rec || { id: machineId(), name: config.host, host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase }
    }
    return null
  }
  const activeMachine = profileMachine
  const currentMachine = profileMachine

  // The shared pool resolves keychain-stored passwords lazily for its own
  // profile-config target (if any). Per-workspace pools resolve their own.
  pool.passwordResolver = async () => machinePassword(profileMachine())


  // ── per-machine pools (listing routes + rw tools + terminals) ──────────
  // Dedicated SshPool per target machine ('host:port:user'), cached ~30min,
  // built from the SAVED machine's credentials (registry + keychain). Every
  // session-scoped remote operation resolves ITS machine first (mirror owner
  // or per-workspace selection) and uses the pool of THAT machine — nothing
  // ever retargets a pool that another workspace may be using.
  const routePools = new Map() // 'host:port:user' -> { pool, at }
  const closeRoutePools = () => {
    for (const { pool: rp } of routePools.values()) { try { rp.close() } catch {} }
    routePools.clear()
  }
  ctx.effect(() => closeRoutePools(), 'dsh-remote.routePools')

  /** A dedicated pool for a machine record (saved in the registry). */
  const machinePoolOf = async (m) => {
    if (!m || !m.host) throw new Error('no machine: call rw_connect or set a current machine for this workspace first')
    const tag = m.host + ':' + (Number(m.port) || 22) + ':' + (m.username || 'root')
    let entry = routePools.get(tag)
    if (entry && Date.now() - entry.at > 30 * 60 * 1000) {
      try { entry.pool.close() } catch {}
      routePools.delete(tag)
      entry = undefined
    }
    if (!entry) {
      const pw = await machinePassword(m)
      const routePool = new SshPool({
        host: m.host,
        port: Number(m.port) || 22,
        username: m.username || 'root',
        password: pw || m.password || '',
        privateKeyPath: m.privateKeyPath || '',
        passphrase: m.passphrase || '',
        useAgent: !!m.useAgent,
        keyboardInteractive: !!m.keyboardInteractive,
        hostKeyMode: m.hostKeyMode || config.hostKeyMode,
        commandTimeoutMs: config.commandTimeoutMs,
        // Output-budget cap must ride every pool or `truncate(_, undefined)`
        // mangles every exec result (the git route depends on it).
        maxOutputChars: config.maxOutputChars,
        env: config.env,
        proxy: m.proxy && m.proxy.host ? m.proxy : (config.proxy || undefined),
      })
      // Re-resolve keychain-stored credentials on EVERY connect attempt, not
      // just at pool creation: `password` above is a snapshot taken when the
      // pool was built, and if the OS keychain was briefly unavailable (locked
      // store, prompt timeout) that snapshot is empty — every later automatic
      // reconnect would otherwise fail with "no credentials" until the pool
      // cache (30 min) expired. The resolver re-asks the keychain lazily, so a
      // dropped SSH connection heals itself on the next operation.
      routePool.passwordResolver = () => machinePassword(m)
      entry = { pool: routePool, at: Date.now() }
      routePools.set(tag, entry)
    }
    return entry.pool
  }

  const routePoolOf = async (remotePath) => {
    // A remote path served by the UI belongs to the machine whose mirror owns
    // it (meta lookup). Preference order (route-machine.js): the pool of the
    // machine that owns the path, resolved from SAVED machines — there is no
    // global "current machine" to short-circuit through anymore.
    const mirror = pickMirrorForRemotePath(remoteWorkspacesRoot(), remotePath, null, (h, p, u) => !!machineByTarget(h, p, u))
    if (!mirror) return { pool, machine: null } // no mirror owns the path → shared pool (legacy)
    const m = machineByTarget(mirror.host, mirror.port, mirror.username)
    if (!m) {
      // Owning machine is NOT saved: reading the path through the shared
      // pool would silently hit the WRONG host (often an existing-but-empty
      // dir → `{items: []}` → the tree shows a blank). Fail loudly instead —
      // the client renders the error row with this exact reason.
      const msg = 'cannot serve ' + normalizeRemotePath(remotePath || '') + ': owning machine ' + mirror.host + ':' + mirror.port + ' is not saved in the dsh-remote machine registry'
      console.error('[dsh-remote] ' + msg)
      throw new Error(msg)
    }
    return { pool: await machinePoolOf(m), machine: mirror }
  }

  // ── remote git machinery (the better-sidebar 'gitSource' slot data plane) ─
  // Every git surface of a remote session (GitView panel, explorer git-status
  // decorations, diff tabs) is served by POST /dsh-remote/git: one remote
  // `git -C <dir> …` per data method, porcelain-parsed here with lib/git-parse.js
  // (pure functions, aligned with the rw_* parse style). Command shapes mirror
  // the host sidebar's own git.ts so clients see byte-identical results.
  // `dir` is a REMOTE absolute path, resolved client-side (linked-worktree
  // path → scope.repoRoot → mirror-mapped session cwd); the owning machine
  // comes from routePoolOf, so multi-machine pools stay isolated.
  const GIT_STATUS_LIMIT = 2000 // host parity: cap on shipped status rows
  const GIT_DISCOVERY_LIMIT = 200 // container-repo scan cap (host parity)
  const GIT_DISCOVERY_TIMEOUT_MS = 5000 // per-probe rev-parse budget
  const GIT_DISCOVERY_TTL_MS = 60000 // one container scan per minute per dir
  const GIT_FETCH_TIMEOUT_MS = 120000 // network fetch needs more than local commands
  const gitDiscoveryCache = new Map() // machineTag + '\0' + dir -> { at, value }

  /** Identity for comparing absolute remote paths (case-folded: git on
   *  Windows prints drive letters inconsistently; case-only collisions are
   *  pathological and cheap to merge). */
  const gitPathId = (p) => normalizeRemotePath(String(p || '')).replace(/[\\/]+$/, '').toLowerCase()

  /** Run one remote git command: `git --no-pager -c color.ui=false -C <dir> <args…>`.
   *  Every argument is shell-quoted (shq) — dirs/branches/messages/hashes are
   *  arbitrary bytes. Resolves the exec result; a non-zero exit rejects with
   *  git's stderr as the readable message (GIT_OPTIONAL_LOCKS=0 mirrors the
   *  host, so read paths never contend with optional locks). `allowFail`
   *  returns { code, stdout, stderr } instead of rejecting (callers that
   *  expect specific non-zero exits, e.g. container probing). */
  const gitRun = async (rp, dir, args, opts) => {
    const o = opts || {}
    const full = ['git', '--no-pager', '-c', 'color.ui=false', '-C', shq(normalizeRemotePath(String(dir || ''))), ...args.map(shq)]
    let res
    try {
      res = await rp.exec(full.join(' '), { timeoutMs: o.timeoutMs, outputChars: o.outputChars, env: { GIT_OPTIONAL_LOCKS: '0' } })
    } catch (err) {
      throw new Error('git ' + (args[0] || '') + ' failed: ' + ((err && err.message) || err))
    }
    if (res.signal === 'TIMEOUT') throw new Error('git ' + (args[0] || '') + ' timed out after ' + (o.timeoutMs || config.commandTimeoutMs) + 'ms')
    if (res.code !== 0) {
      if (o.allowFail) return res
      throw new Error(String(res.stderr || '').trim() || ('git ' + (args[0] || '') + ' exited with ' + res.code))
    }
    return res
  }

  /** Whether a git-run failure is transport-level (ssh/sftp) rather than a
   *  plain "not a git repository" style exit — transport failures must
   *  surface, repo-absence must degrade to the host's `isRepo:false` shape. */
  const isGitInfraError = (err) => classifyError(err, { host: null, port: null }).category !== 'other'

  /** Discover the repository roots directly under `dir` (a workspace container
   *  whose own path is not inside a repo) — the remote twin of the host
   *  sidebar's repoRoots() scan: SFTP-list the direct children (no dotdirs /
   *  node_modules, cap GIT_DISCOVERY_LIMIT), probe each with a bounded
   *  `rev-parse --show-toplevel` under bounded concurrency, dedupe by path
   *  identity. TTL-cached per (machine, dir) and in-flight calls share one
   *  scan — the GitView 2s poll must never fan out into a full re-scan. */
  const discoverGitRoots = async (rp, dir, machineTag) => {
    const key = machineTag + '\0' + normalizeRemotePath(dir)
    const hit = gitDiscoveryCache.get(key)
    if (hit && Date.now() - hit.at < GIT_DISCOVERY_TTL_MS) return hit.value
    if (hit) gitDiscoveryCache.delete(key)
    const promise = (async () => {
      const listing = await listDirStructured(normalizeRemotePath(dir), rp)
      const children = listing.items
        .filter((it) => it.type === 'dir' && !it.name.startsWith('.') && it.name !== 'node_modules')
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, GIT_DISCOVERY_LIMIT)
        .map((it) => joinRemotePath(listing.path, it.name))
      const roots = []
      const seen = new Set()
      let cursor = 0
      const worker = async () => {
        while (cursor < children.length) {
          const child = children[cursor]
          cursor += 1
          try {
            const r = await gitRun(rp, child, ['rev-parse', '--show-toplevel'], { timeoutMs: GIT_DISCOVERY_TIMEOUT_MS })
            const root = String(r.stdout || '').trim()
            if (root) {
              const id = gitPathId(root)
              if (!seen.has(id)) {
                seen.add(id)
                roots.push(root)
              }
            }
          } catch { /* ordinary child directory */ }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, children.length || 1) }, () => worker()))
      return roots
    })()
    gitDiscoveryCache.set(key, { at: Date.now(), value: promise })
    promise.catch(() => {
      // Failed scans must retry on the next call (transient SSH/listing).
      const entry = gitDiscoveryCache.get(key)
      if (entry && entry.value === promise) gitDiscoveryCache.delete(key)
    })
    return promise
  }

  /** The repository root that owns `dir`: `rev-parse --show-toplevel` first
   *  (exact when dir sits inside a worktree), else the first discovered
   *  container child root — or the identity match of `selected` when given
   *  (the choice the Git panel pinned via chooseRepo). Rejects with a
   *  readable 'not a git repository' error when nothing owns dir. */
  const gitRepoRootOf = async (rp, dir, selected, machineTag) => {
    try {
      const r = await gitRun(rp, dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 8000 })
      const root = String(r.stdout || '').trim()
      if (root) return root
    } catch (err) {
      if (isGitInfraError(err)) throw err
    }
    const roots = await discoverGitRoots(rp, dir, machineTag)
    if (selected) {
      const id = gitPathId(selected)
      const match = roots.find((root) => gitPathId(root) === id)
      if (match) return match
    }
    if (roots.length) return roots[0]
    throw new Error('not a git repository: ' + normalizeRemotePath(dir))
  }

  /** The machine tag for per-(machine, dir) caches. */
  const gitMachineTag = (machine) => machine
    ? String(machine.host) + ':' + String(Number(machine.port) || 22) + ':' + String(machine.username || 'root')
    : 'shared'

  /** One /dsh-remote/git op: shadows the host sidebar's git.* route shapes
   *  (byte-level return shapes — the client git source passes them through).
   *  `dir` is the client-resolved remote command dir; root-sensitive ops
   *  re-resolve the owning repo root (worktree → its own top level). */
  function gitOpHandlers(rp, dir, selected, machineTag, op, body) {
    const pathArg = (key) => {
      const v = body[key]
      return (v === undefined || v === null || v === '') ? undefined : String(v)
    }
    const rootOf = () => gitRepoRootOf(rp, dir, selected, machineTag)
    if (op === 'status') {
      return (async () => {
        let root = ''
        let repositories = []
        try {
          const r = await gitRun(rp, dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 8000 })
          root = String(r.stdout || '').trim()
        } catch (err) {
          if (isGitInfraError(err)) throw err
        }
        if (root) {
          repositories = [root]
        } else {
          repositories = await discoverGitRoots(rp, dir, machineTag)
          if (repositories.length === 0) return { isRepo: false, entries: [], repositories: [] }
          root = selected
            ? (repositories.find((r) => gitPathId(r) === gitPathId(selected)) || repositories[0])
            : repositories[0]
        }
        // `-b` gives the branch header as the first -z field ('## main…');
        // entries are repository-root-relative (commands run at the root).
        const res = await gitRun(rp, root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], { outputChars: 1024 * 1024 })
        const { branch, entries } = parseStatusV1(res.stdout)
        const truncated = entries.length > GIT_STATUS_LIMIT
        return {
          isRepo: true,
          branch: branch || 'HEAD',
          root,
          entries: truncated ? entries.slice(0, GIT_STATUS_LIMIT) : entries,
          truncated,
          repositories,
        }
      })()
    }
    if (op === 'worktrees') {
      return (async () => {
        let raw = ''
        try {
          const res = await gitRun(rp, dir, ['worktree', 'list', '--porcelain'], { timeoutMs: 8000 })
          raw = res.stdout
        } catch (err) {
          // A container cwd (no repo at dir) is a normal "no worktrees" —
          // the panel shows an empty selector, never an error row.
          if (isGitInfraError(err)) throw err
          return []
        }
        const records = parseWorktreeList(raw).filter((e) => !e.prunable)
        let currentRoot = ''
        try {
          const r = await gitRun(rp, dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 8000 })
          currentRoot = String(r.stdout || '').trim()
        } catch { /* no current checkout root → no row is marked current */ }
        const rows = await Promise.all(records.map(async (e) => ({
          path: e.path,
          branch: e.branch,
          current: !!(currentRoot && gitPathId(e.path) === gitPathId(currentRoot)),
          // Dirty count (staged + unstaged) drives the host's "dirty linked
          // checkout auto-select"; a failing/stale linked checkout counts 0
          // (targeted operations still fail loud on their own).
          changes: await gitRun(rp, e.path, ['status', '--porcelain'], { timeoutMs: 8000, outputChars: 1024 * 1024 })
            .then((r2) => countStatusLines(r2.stdout), () => 0),
        })))
        return rows.sort((a, b) => Number(b.current) - Number(a.current))
      })()
    }
    if (op === 'branch') {
      return rootOf().then(async (root) => {
        const [current, refs] = await Promise.all([
          gitRun(rp, root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }),
          gitRun(rp, root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
        ])
        const cur = String(current.stdout || '').trim() || 'HEAD'
        const names = String(refs.stdout || '').split('\n').filter((l) => l !== '')
        return { current: cur, names: names.includes(cur) ? names : [cur, ...names] }
      })
    }
    if (op === 'branchStatus') {
      return rootOf().then(async (root) => {
        const live = await gitRun(rp, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFail: true })
        let name = String(live.stdout || '').trim()
        if (name === '' || name === '@{upstream}') {
          const branch = await gitRun(rp, root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })
          const b = String(branch.stdout || '').trim()
          if (b !== '' && b !== 'HEAD') {
            const raw = await gitRun(rp, root, ['for-each-ref', '--format=%(upstream:short)', 'refs/heads/' + b], { allowFail: true })
            name = String(raw.stdout || '').trim()
          }
        }
        if (name === '') return { upstream: undefined, ahead: 0, behind: 0, gone: false }
        const counts = await gitRun(rp, root, ['rev-list', '--left-right', '--count', 'HEAD...' + name], { allowFail: true })
        if (counts.code !== 0) {
          // Upstream configured but its tracking ref is gone (deleted on the
          // remote / pruned / never fetched): the host calls this `gone`.
          return { upstream: name, ahead: 0, behind: 0, gone: true }
        }
        const [ahead, behind] = parseLeftRightCount(counts.stdout)
        return { upstream: name, ahead, behind, gone: false }
      })
    }
    if (op === 'branchTips') {
      return rootOf().then(async (root) => {
        const branches = Array.isArray(body.branches) ? body.branches.filter((b) => typeof b === 'string' && b !== '') : []
        if (branches.length === 0) return { tips: [] }
        const raw = await gitRun(rp, root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/heads'])
        const byName = new Map(parseForEachRefPairs(raw.stdout))
        const current = await gitRun(rp, root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })
        const cur = String(current.stdout || '').trim() || 'HEAD'
        const tips = []
        for (const name of branches) {
          const hash = byName.get(name)
          if (hash === undefined) continue // stale watch entry — silently dropped
          if (name === cur) {
            tips.push({ name, hash, ahead: 0, behind: 0 })
            continue
          }
          const ref = 'refs/heads/' + name
          const [ahead, behind] = await Promise.all([
            gitRun(rp, root, ['rev-list', '--count', 'HEAD..' + ref], { allowFail: true }).then((r) => Number((r.stdout || '').trim()) || 0, () => 0),
            gitRun(rp, root, ['rev-list', '--count', ref + '..HEAD'], { allowFail: true }).then((r) => Number((r.stdout || '').trim()) || 0, () => 0),
          ])
          tips.push({ name, hash, ahead, behind })
        }
        return { tips }
      })
    }
    if (op === 'logGraph') {
      const count = Number.isInteger(body.count) && body.count > 0 ? body.count : 30
      const skip = Number.isInteger(body.skip) && body.skip >= 0 ? body.skip : 0
      return rootOf().then(async (root) => {
        const res = await gitRun(rp, root, [
          'log', '-n', String(count), '--skip', String(skip), '--topo-order', '--decorate=full',
          '--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D',
        ])
        return parseLogGraphLines(res.stdout)
      })
    }
    if (op === 'diff') {
      return rootOf().then(async (root) => {
        const args = ['diff', '--no-ext-diff', '--no-color', '-U3']
        if (body.staged === true) args.push('--cached')
        const p = pathArg('path')
        if (p !== undefined) args.push('--', p)
        const res = await gitRun(rp, root, args, { outputChars: 4 * 1024 * 1024 })
        return { diff: res.stdout }
      })
    }
    if (op === 'commitDiff') {
      return rootOf().then(async (root) => {
        const res = await gitRun(rp, root, ['show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', String(body.hash || '')], { outputChars: 4 * 1024 * 1024 })
        return { diff: res.stdout }
      })
    }
    if (op === 'stage') {
      return rootOf().then(async (root) => {
        const p = pathArg('path')
        await gitRun(rp, root, p === undefined ? ['add', '-A'] : ['add', '-A', '--', p])
        audit('git', 'stage ' + dir, 0)
        return { ok: true }
      })
    }
    if (op === 'unstage') {
      return rootOf().then(async (root) => {
        const p = pathArg('path')
        await gitRun(rp, root, p === undefined ? ['reset', '-q'] : ['reset', '-q', '--', p])
        audit('git', 'unstage ' + dir, 0)
        return { ok: true }
      })
    }
    if (op === 'commit') {
      return rootOf().then(async (root) => {
        await gitRun(rp, root, ['commit', '-m', String(body.message || '')])
        audit('git', 'commit ' + dir, 0)
        return { ok: true }
      })
    }
    if (op === 'checkout') {
      return rootOf().then(async (root) => {
        await gitRun(rp, root, ['checkout', String(body.branch || '')])
        audit('git', 'checkout ' + dir + ' → ' + String(body.branch || ''), 0)
        return { ok: true }
      })
    }
    if (op === 'fetch') {
      return rootOf().then(async (root) => {
        const remotes = await gitRun(rp, root, ['remote'], { allowFail: true })
        const names = String(remotes.stdout || '').split('\n').filter((l) => l.trim() !== '')
        if (names.length === 0) {
          // The host surfaces its own copy for this wire code; the message
          // must carry 'no remote' for the panel's mapping.
          throw new Error('no remote configured for this repository — cannot fetch')
        }
        await gitRun(rp, root, body.prune === true ? ['fetch', '--prune'] : ['fetch'], { timeoutMs: GIT_FETCH_TIMEOUT_MS })
        audit('git', 'fetch ' + dir, 0)
        return { ok: true }
      })
    }
    if (op === 'discard') {
      return rootOf().then(async (root) => {
        const p = String(pathArg('path') || '')
        await gitRun(rp, root, ['checkout', '--', p])
        audit('git', 'discard ' + dir + ' ' + p, 0)
        return { ok: true }
      })
    }
    if (op === 'revert') {
      return rootOf().then(async (root) => {
        await gitRun(rp, root, ['revert', '--no-edit', String(body.hash || '')])
        audit('git', 'revert ' + dir + ' ' + String(body.hash || ''), 0)
        return { ok: true }
      })
    }
    if (op === 'cherryPick') {
      return rootOf().then(async (root) => {
        await gitRun(rp, root, ['cherry-pick', String(body.hash || '')])
        audit('git', 'cherry-pick ' + dir + ' ' + String(body.hash || ''), 0)
        return { ok: true }
      })
    }
    return Promise.reject(new Error('unknown git op: ' + op))
  }


  // If no workspace selection exists, adopt a CLI/profile-provided default as
  // the profile-level machine — UNLESS the user explicitly cleared the current
  // machine app-wide (currentId: null = "active remote = none", issue #13) or
  // the registry carries per-workspace choices (which always win over the
  // profile default for their own workspace). This only seeds the SHARED pool
  // for profile-config flows; it never activates any saved machine.
  {
    const cur = profileMachine()
    const registryExplicitNone = store.explicitNone
    if (cur && cur.host && !store.currentId && !registryExplicitNone) applyMachine(config, cur)
  }
  // NOTE: there is deliberately NO auto-restore of a "last active machine".
  // Pre-isolation that block re-bound the shared pool to store.currentId on
  // every boot — which made every local project workspace inherit the remote
  // project of whatever machine was last used anywhere (the bug this
  // refactor removes). Remote context now resolves per workspace on demand.

  /** Remember `p` as the remote workspace of one workspace dir.
   *  Updates the owning machine's own record (its remembered default path +
   *  recentWorkspaces) and — when `cwd` is known — the per-workspace
   *  selection. NEVER writes a global config.workspace: that was the other
   *  half of the cross-workspace leak. */
  const persistWorkspace = (p, cwd) => {
    const ctx = cwd ? ctxForCwd(cwd) : ctxForCwd(callerCwdOf(null))
    if (ctx && ctx.machine && ctx.machineId && machineIndex(ctx.machine.id) >= 0) {
      const rec = machines[machineIndex(ctx.machine.id)]
      rec.workspace = p
      rec.recentWorkspaces = [p, ...(rec.recentWorkspaces || []).filter((x) => x !== p)].slice(0, 8)
      saveMachines(machines, store.currentId, true, store.workspaces)
    }
    const k = wsKeyOf(cwd)
    if (k && ctx && ctx.machineId) {
      wsSelSet(k, { machineId: ctx.machineId, workspace: p, explicitNone: false })
    }
  }

  // ── audit log ─────────────────────────────────────────────────────────────
  // `machine` (optional) lets session-scoped ops record the machine they
  // actually ran on — not the profile config (which may be empty or belong to
  // a different workspace).
  const audit = (op, cmd, code, machine) => {
    if (!config.auditLog) return
    try {
      const who = machine && machine.host
        ? `${machine.username || '?'}@${machine.host}:${Number(machine.port) || 22}`
        : `${config.username || '?'}@${config.host || '?'}:${config.port}`
      const line = [new Date().toISOString(), who, op, code == null ? '-' : String(code), String(cmd || '').replace(/\s+/g, ' ').slice(0, 400)].join(' | ') + '\n'
      appendFileSync(auditFile(), line, 'utf8')
    } catch {}
  }
  const readAudit = (limit) => {
    try {
      const text = readFileSync(auditFile(), 'utf8')
      const lines = text.split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, Math.min(Number(limit) || 50, 500)))
    } catch {
      return []
    }
  }

  // ── ignore rules (defaults + user file) ───────────────────────────────────
  const ignoreMatcher = () => {
    try {
      const fromFile = readFileSync(ignoreFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      return compileIgnore(DEFAULT_IGNORE.concat(fromFile))
    } catch {
      return compileIgnore(DEFAULT_IGNORE)
    }
  }

  // ── task + forward managers ───────────────────────────────────────────────
  const tasks = new TaskManager()
  const forwards = new ForwardManager(pool, { file: forwardsFile() })
  pool.onReady = (client) => forwards.attach(client)
  pool.onCloseHook = () => forwards.detach()

  // ── remote terminal sessions (interactive shells over dedicated SSH) ─────
  // Each session owns its own connection (immune to pool reconnects); every
  // submitted command line lands in the audit log like rw_exec does.
  const terminals = new TerminalManager({
    pool,
    // Per-workspace isolation: a terminal session opened for a workspace
    // binds the MACHINE of that workspace (mirror owner / selection) through
    // its own dedicated pool — never the shared pool of some other project.
    getPool: async (machineId) => {
      const i = machineIndex(String(machineId || ''))
      if (i < 0) return null
      return machinePoolOf(machines[i])
    },
    config,
    onCommand: (line) => audit('terminal', line),
  })
  ctx.effect(() => () => terminals.closeAll(), 'dsh-remote.terminals')

  // ── auto-push watcher (config.autoPush, default off) ──────────────────────
  // Watches the local mirror; local edits are pushed back to the remote after a
  // 3s debounce, honoring ignore rules + the three-way conflict guard (a remote
  // change is never clobbered — it is recorded as a conflict in the audit log).
  const autoPushWatchers = new Map() // localDir → { watcher, pending:Set, timer }
  const flushAutoPush = async (localDir) => {
    const entry = autoPushWatchers.get(localDir)
    if (!entry || !entry.pending.size) return
    const rels = [...entry.pending]
    entry.pending.clear()
// Per-workspace auto-push: the watched dir IS a mirror — its remote origin
    // and owner come from the mirror meta, never from the profile config.
    const m = mirrorMatchOf(localDir)
    if (!m || !m.host) return
    const ws = m.remotePath
    if (!ws) return
    let sftp
    try {
      const owner = machineByTarget(m.host, m.port, m.username)
      if (!owner) return // owner not saved → cannot push (mirror-only)
      sftp = await (await machinePoolOf(owner)).sftp()
    } catch { return }
    const matcher = ignoreMatcher()
    const state = loadSyncState(localDir)
    const next = { ...state }
    if (rels.includes('*')) {
      const r = await pushTree(sftp, localDir, ws, { maxFiles: 2000, maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
      Object.assign(next, r.nextState)
      for (const c of r.stats.conflicts) audit('auto-push-conflict', `push ${c.path}`, 1, machine)
    } else {
      for (const rel of rels) {
        const r = await pushOneFile(sftp, localDir, ws, rel, { maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
        if (r.status === 'pushed' && r.state) Object.assign(next, r.state)
        else if (r.status === 'conflict') audit('auto-push-conflict', `push ${rel}`, 1, machine)
      }
    }
    saveSyncState(localDir, next)
  }
  const startAutoPush = (localDir) => {
    if (!config.autoPush || autoPushWatchers.has(localDir)) return
    const entry = { pending: new Set(), timer: null, watcher: null }
    const schedule = () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => flushAutoPush(localDir), 3000)
    }
    const onEvent = (eventType, filename) => {
      if (!filename) { entry.pending.add('*'); return schedule() }
      const rel = String(filename).replace(/\\/g, '/')
      if (rel === '.dsh-remote-meta.json' || rel === '.dsh-remote-sync-state.json' || rel.startsWith('.dsh-remote-sync-state.json.tmp')) return
      entry.pending.add(rel)
      schedule()
    }
    try {
      entry.watcher = watch(localDir, { recursive: true }, onEvent)
    } catch {
      try { entry.watcher = watch(localDir, onEvent) } catch { return }
    }
    autoPushWatchers.set(localDir, entry)
  }
  ctx.effect(() => () => {
    for (const e of autoPushWatchers.values()) {
      if (e.timer) clearTimeout(e.timer)
      try { e.watcher && e.watcher.close() } catch {}
    }
    autoPushWatchers.clear()
  }, 'dsh-remote.autopush')

  // Helpers shared by session-bound tools and the machine-scoped web routes take
  // the pool explicitly (`p`), defaulting to the active-machine pool so route
  // callers — which are machine-scoped by design — stay unchanged.
  const run = async (cmd, opts = {}, p = pool) => {
    const res = await p.exec(cmd, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {})
    const parts = []
    if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
    if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
    if (!parts.length) parts.push('(no output)')
    let text = parts.join('\n')
    if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${opts.timeoutMs ?? config.commandTimeoutMs}ms]`
    else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
    return text
  }

const isRemoteDir = async (p, sshPool = pool) => {
    const target = normalizeRemotePath(p)
    try {
      const sftp = await sshPool.sftp()
      const st = await sftp.stat(target)
      return !!(st && st.isDirectory && st.isDirectory())
    } catch {
      return false
    }
  }

  /** Directory check on ONE specific pool (workspace-scoped ops must stat via
   *  the workspace machine's own pool — never the shared pool of another). */
  const isRemoteDirOn = async (rp, p) => {
    const target = normalizeRemotePath(p)
    try {
      const sftp = await rp.sftp()
      const st = await sftp.stat(target)
      return !!(st && st.isDirectory && st.isDirectory())
    } catch {
      return false
    }
  }

// ── remote workspace state (per-workspace) ────────────────────────────────
  /** Profile-config default remote workspace. Session-scoped operations must
   *  NOT use this as their target — they resolve ctxForCwd(sessionCwd) and
   *  use ctx.workspace, so one project's pick can never leak into another. */
  const wsPath = () => (config.workspace || '').trim()
  /** Map a LOCAL path to { mirrorDir, remotePath } ('' when the path is not
   *  inside any dsh-remote mirror). The mirror-OWNER machine (host/port/user)
   *  lives in mirrorMatchOf — the per-workspace isolation anchor. */
  const resolveMirrorForLocal = (local) => {
    const m = mirrorMatchOf(local)
    return { mirrorDir: m ? m.mirrorDir : null, remotePath: m ? m.remotePath : '' }
  }
  if (config.autoPush && wsPath()) {
    startAutoPush(mirrorDirFor(wsPath(), config))
  }
  /** Resolve only the requested session, including historical session logs. */
  const sessionCwdOf = (sessionId) => {
    if (!sessionId) return ''
    try {
const sessions = ctx.get('sessions')
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
      if (session?.header?.cwd) return String(session.header.cwd)
    } catch { /* session not live */ }
    try {
      const root = path.join(dshBase(), 'sessions')
      for (const project of readdirSync(root)) {
        const dir = path.join(root, project, encodeSegmentSafe(sessionId))
        for (const name of ['session.jsonl.zstd', 'session.jsonl', 'session.jsonl.gz']) {
          const file = path.join(dir, name)
          if (!existsSync(file)) continue
          const cwd = readSessionHeaderCwd(file)
          if (cwd) return cwd
        }
      }
    } catch { /* no durable session */ }
    return ''
  }

  /** Whether the pool for a context's machine has a live client (no connect). */
  const ctxConnected = (ctx) => {
    if (!ctx || !ctx.host) return !!pool.client && !!config.host
    const entry = routePools.get(ctx.host + ':' + (Number(ctx.port) || 22) + ':' + (ctx.username || 'root'))
    return !!(entry && entry.pool && entry.pool.client)
  }

  /** Per-workspace status. `cwd` '' → profile-config view (no workspace
   *  context — settings/global callers). `sessionId` narrows sessionMode to
   *  THAT session's cwd. */
  const status = (cwd, sessionId) => {
    const globalView = !cwd && sessionId === undefined
    const ctx = cwd ? ctxForCwd(cwd) : ctxForCwd('')
    const remotePath = resolveMirrorForLocal(cwd || '').remotePath
    const workspace = ctx.workspace || (!cwd && sessionId === undefined ? wsPath() : '')
    const localMirror = ctx.mirrorDir || (workspace && ctx.host ? mirrorDirFor(workspace, ctx) : '')
    return {
      cwd: ctx.cwd || '',
      host: ctx.host || (globalView ? config.host || '' : ''),
      port: ctx.port || (globalView ? config.port || 22 : 0),
      username: ctx.username || (globalView ? config.username || '' : ''),
      connected: ctx.host ? ctxConnected(ctx) : globalView && !!pool.client,
      workspace: toDisplayPath(workspace, ctx.host ? 'unknown' : pool.platform),
      localMirror,
      // Publish validated mirror directories for the browser's synchronous gates.
      mirrorRoot: remoteWorkspacesRoot(),
      mirrorDirs: mirrorEntries().map((m) => m.mirrorDir),
      // Per-workspace active machine ('' = none for this workspace). No global
      // current exists anymore — a saved machine is a standby everywhere else.
      currentId: ctx.machineId || null,
      activeSource: ctx.mode === 'remote' ? 'machine' : (config.host && globalView ? 'config' : 'none'),
      contextSource: ctx.source || 'none',
      // Whether THIS session is in remote mode (cwd inside a mirror).
      // `local` means the plugin is present but no remote context is active.
      sessionMode: remotePath ? 'remote' : 'local',
      sessionRemotePath: remotePath,
      machines: machines.map(sanitizeMachine),
      hostKeyMode: config.hostKeyMode === 'verify' || config.hostKeyMode === 'off' ? config.hostKeyMode : 'accept-new',
      hostKeyKnown: ctx.host ? isHostKeyKnown(ctx.host, ctx.port) : (config.host ? isHostKeyKnown(config.host, config.port) : false),
      forwards: forwards.list(),
      auditEnabled: !!config.auditLog,
      backend: platformBackend(),
      platform: 'unknown', // resolved per pool; see poolForCtx
      shell: 'native',
      gitBash: '',
    }
  }

  const sessionsSvc = () => (ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null)

  /**
   * HTTP binding for sidebar file routes (createFsRoutes). A sessionId/local
   * hint is authoritative: a local (non-mirror) session is refused rather than
   * falling back to the active machine. Requests with no hint keep the
   * picker/settings shared pool.
   */
  const resolveRequestBinding = async (req, body = {}) => {
    // Workspace picker / settings: browse a SPECIFIC saved machine
    // (?machine=<registry id>) with its own dedicated pool — not the shared one.
    const qm = (req && req.url ? String(req.url) : '').match(/[?&]machine=([^&]+)/)
    if (qm) {
      const id = decodeURIComponent(qm[1])
      if (!id) return { pool, ws: '', host: '', username: '', port: 0, alias: '', mirrorDir: null, bound: false, local: false }
      const i = machineIndex(id)
      if (i < 0) {
        const err = new Error('machine ' + id + ' is not saved in the dsh-remote machine registry')
        err.httpStatus = 404
        throw err
      }
      const m = machines[i]
      return {
        pool: await machinePoolOf(m),
        ws: m.workspace || '',
        host: m.host,
        username: m.username || 'root',
        port: Number(m.port) || 22,
        alias: m.alias || '',
        mirrorDir: null,
        bound: false,
        local: false,
      }
    }
    const hint = requestSessionHint(req, body)
    let cwd = hint.local
    if (!cwd && hint.sessionId) cwd = lookupSessionCwd(hint.sessionId, { sessions: sessionsSvc(), dshHome: dshBase() })
    if (cwd) {
      const ctx = ctxForCwd(cwd)
      if (ctx.mode === 'remote' && ctx.host) {
        return {
          pool: ctx.machine ? poolForMachine(ctx.machine) : pool,
          ws: ctx.workspace,
          host: ctx.host,
          username: ctx.username,
          port: ctx.port,
          alias: ctx.machine ? aliasOf(ctx.machine) : '',
          mirrorDir: ctx.mirrorDir || null,
          bound: true,
          local: false,
        }
      }
      const err = new Error(
        'this session is LOCAL — its workspace is not a remote mirror, so there is no remote host to act on. '
        + 'Refusing rather than falling back to the active machine.',
      )
      err.httpStatus = 403
      throw err
    }
    return {
      pool,
      ws: wsPath(),
      host: config.host,
      username: config.username,
      port: config.port,
      mirrorDir: wsPath() ? mirrorDirFor(wsPath(), config) : null,
      bound: false,
      local: false,
    }
  }


  // ── remote `@` completion (issue #39) ─────────────────────────────────────
  //
  // `@` candidates come from `ctx.fileReferences`, whose only shipped provider
  // indexes the agent session's LOCAL cwd. A remote session's cwd is the (empty
  // until synced) mirror, so `@` listed nothing. The seam is a single-owner
  // service, so lib/file-reference.js WRAPS `fileReferences.list` and answers
  // remote-bound sessions from the remote host over SFTP.
  //
  // Everything below is glue: which remote root an agent is bound to, and how a
  // workspace-relative directory is listed over the machine's own pool.

  /** Join a workspace-relative directory onto a remote root, segment by
   *  segment, so the root's separator style is preserved on Windows hosts. */
  const joinRemoteRel = (base, rel) => {
    let out = base
    for (const segment of String(rel || '').split('/')) {
      if (!segment || segment === '.') continue
      out = joinRemotePath(out, segment)
    }
    return out
  }

  const fileReferenceLog = (msg) => {
    try {
      const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
      if (logger && typeof logger.warn === 'function') logger.warn('[dsh-remote] ' + msg)
    } catch { /* logging is best-effort */ }
  }

  /** Providers, one per (machine, remote root): the index cache is expensive to
   *  rebuild, so typing in the SAME workspace keeps reusing it. */
  const fileReferenceProviders = new Map()
  const FILE_REFERENCE_PROVIDER_CAP = 32

  /**
   * The remote discovery provider for one agent, or null when that agent is not
   * a remote session (or the feature is off) — in which case the original local
   * provider answers, unchanged.
   */
  const remoteFileReferenceFor = (agent) => {
    // `=== false` rather than falsy: a partially-specified config (a scripted
    // apply(), an older profile) must still get the remote listing, which is
    // what the schema default promises.
    if (config.fileReference === false) return null
    const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : ''
    if (!cwd) return null
    const m = mirrorMatchOf(String(cwd))
    if (!m || !m.remotePath) return null
    // The owner machine comes from the mirror meta via the registry; an
    // unsaved owner means no credential source → no remote listing.
    const machine = machineByTarget(m.host, m.port, m.username)
    if (!machine) return null
    const root = normalizeRemotePath(m.remotePath)
    const key = poolKey(machine) + '\u0000' + root
    const cached = fileReferenceProviders.get(key)
    if (cached) return cached
    const provider = createRemoteFileReference({
      root,
      // '' = the workspace root; every other value is a workspace-relative dir.
      listDir: async (rel) => {
        const p = poolForMachine(machine)
        const sftp = await p.sftp()
        const out = await listDirStructured(sftp, rel ? joinRemoteRel(root, rel) : root)
        return out.items.map((item) => ({
          name: item.name,
          kind: item.type === 'dir' ? 'directory' : 'file',
        }))
      },
      config: {
        root,
        maxResults: config.fileReferenceMaxResults,
        maxEntries: config.fileReferenceMaxEntries,
        excludedDirectories: config.fileReferenceExcludedDirectories,
        timeoutMs: config.fileReferenceTimeoutMs,
      },
      onError: (err) => fileReferenceLog(`@ listing failed for ${machine.host}:${root}: ${(err && err.message) || err}`),
    })
    if (fileReferenceProviders.size >= FILE_REFERENCE_PROVIDER_CAP) {
      const oldest = fileReferenceProviders.keys().next().value
      try { fileReferenceProviders.get(oldest)?.dispose() } catch { /* already disposed */ }
      fileReferenceProviders.delete(oldest)
    }
    fileReferenceProviders.set(key, provider)
    return provider
  }

  const fileReferenceOverlay = installFileReferenceOverlay(ctx, {
    resolve: remoteFileReferenceFor,
    onError: (err) => fileReferenceLog(`@ completion overlay: ${(err && err.message) || err}`),
  })
  ctx.effect(() => () => {
    try { fileReferenceOverlay?.dispose?.() } catch { /* already disposed */ }
    for (const provider of fileReferenceProviders.values()) {
      try { provider.dispose() } catch { /* already disposed */ }
    }
    fileReferenceProviders.clear()
  }, 'dsh-remote.file-reference')

  /**
   * Resolve a PATH ARGUMENT a tool received against the session's remote
   * workspace root when it is not already absolute (issue #39).
   *
   * An `@path` mention in a remote session is workspace-relative — the same
   * shape the local provider produces — so `rw_read_file("src/main.c")` must
   * mean `<remote workspace>/src/main.c`, not the filesystem root's `/src`.
   * Absolute POSIX (`/a/b`), Windows (`D:\a`, `/D:/a`) and UNC (`\\host\share`)
   * forms pass through normalizeRemotePath() unchanged, so behaviour for every
   * existing caller is preserved. `..` segments collapse inside the joined path
   * exactly as normalizeRemotePath() already did.
   *
   * @param {{ws: string}} b - the binding resolved for this call.
   * @param {unknown} raw - the raw argument value.
   * @returns {string} a normalized remote path.
   */
  const resolveRemoteArg = (b, raw) => {
    const s = String(raw ?? '').trim()
    const ws = (b && (b.ws || b.workspace)) || ''
    const absolute = s.startsWith('/') || s.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(s)
    if (absolute) return normalizeRemotePath(s)
    const rel = s.replace(/^\.\//, '').replace(/^[\\/]+/, '')
    if (!rel) return normalizeRemotePath(ws)
    return normalizeRemotePath(ws ? joinRemoteRel(ws, rel.replace(/\\/g, '/')) : rel)
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  /** Per-tool-call scope: the machine + dedicated pool of the CALLER's
   *  workspace (exec.agent.session.header.cwd). Per-workspace isolation — a
   *  tool call never inherits a machine another workspace picked (issue #13).
   *  Every rw_* body starts with `const { ctx, pool } = await rwScopeOf(exec)`,
   *  which shadows the outer shared pool for the duration of the call, so the
   *  body's `pool.*` calls hit the workspace's own machine pool. */
  const rwScopeOf = async (exec, { requireRemote = true } = {}) => {
    const ctx = ctxForCwd(callerCwdOf(exec))
    if (!ctx || ctx.mode !== 'remote' || !ctx.host) {
      if (!requireRemote) return { ctx, pool: null }
      throw new Error(
        'no remote host active in THIS workspace (remote context is per workspace — a saved machine only activates for the workspace that connects to it). ' +
        'Run rw_connect first, or set a current machine for this workspace in the dsh-remote settings page.'
      )
    }
    if (!ctx.machine) {
      throw new Error('remote machine ' + ctx.host + ':' + ctx.port + ' is not saved in the dsh-remote machine registry — save it first (rw_connect save:true)')
    }
    const pool = await machinePoolOf(ctx.machine)
    return { ctx, pool }
  }

  const textOut = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => [{ type: 'text', text: v.text }],
  }
  const okOut = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
    render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'ok' : 'failed') }],
  }

  const tools = [
    defineTool({
      name: 'rw_info',
      description:
        'Show the remote environment: host/user/port, connection health, current remote workspace path, active port forwards. Call this first to orient, or when an rw_* call fails to check connectivity. Note: remote context is session-scoped — a saved machine only becomes active when you explicitly rw_connect to it (issue #13).',
      parameters: {},
      output: textOut,
async execute(args, exec) {
        const cwd = callerCwdOf(exec)
        const ctx = ctxForCwd(cwd)
        const s = status(cwd || '')
        const shellLine = (rp) => (rp && rp.platform === 'windows')
          ? (rp.gitBash ? 'Git Bash (' + rp.gitBash + ')' : 'Windows (Git Bash not found — set config.shell to a bash.exe path)')
          : (rp && rp.platform === 'posix' ? 'native POSIX' : 'detecting…')
        const lines = []
        if (!ctx || ctx.mode !== 'remote' || !ctx.host) {
          // Local workspace: NEVER report another machine's remote (issue #13 +
          // per-workspace isolation). Tell the user how to bind THIS workspace.
          lines.push(
            `Workspace: ${cwd || '(unknown)'}`,
            'Remote context: none — this is a LOCAL workspace; no remote project is bound to it.',
            'To work on a remote host from here, run rw_connect (binds only THIS workspace) or open the dsh-remote settings page and set a current machine for this workspace.',
            `Session remote path: ${s.sessionRemotePath || '(none)'}`,
            `Active forwards: ${s.forwards.filter((f) => f.active).length} / ${s.forwards.length}`,
          )
          return { text: lines.join('\n') }
        }
        lines.push(
          `Remote host: ${ctx.username}@${ctx.host}:${ctx.port} (source: ${ctx.source})`,
          `Current remote workspace: ${ctx.workspace || '(none — run rw_pick_workspace to set one for this workspace)'}`,
          `Local mirror: ${ctx.mirrorDir || s.localMirror || '(none)'}`,
          `Session remote context: ${s.sessionRemotePath || ctx.workspace || '(none)'}`,
          `Active forwards: ${s.forwards.filter((f) => f.active).length} / ${s.forwards.length}`,
          '',
        )
        if (ctx.machine) {
          try {
            const rp = await machinePoolOf(ctx.machine)
            await rp.detect()
            lines.push(`Remote shell: ${shellLine(rp)}`)
            const res = await rp.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
            if (res.signal === 'TIMEOUT') lines.push('Ping: timeout')
            else if (res.code === 0) lines.push('Ping: OK — ' + res.stdout.replace(/\s+/g, ' ').trim())
            else lines.push('Ping: FAILED — ' + (res.stderr || res.stdout || `exit ${res.code}`).trim())
          } catch (err) {
lines.push('Ping: FAILED — ' + friendlyMessage(err, ctx))
          }
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_connect',
      description:
        'Connect SSH to a remote host for remote workspace work. Provide host (required), user, optional password or privateKeyPath/port. Defaults to saving the machine to the registry (save=false keeps it as a temporary connection). Once connected, call rw_pick_workspace to pick the workspace directory this session should work in. With useSshConfig=true, `host` is an ALIAS from ~/.ssh/config and every value (HostName/user/port/IdentityFile/ProxyJump) is read from that file at connect time.',
      parameters: {
        host: { type: 'string', required: true, description: 'Remote host IP or hostname (or a ~/.ssh/config alias with useSshConfig=true)' },
        username: { type: 'string', description: 'SSH user (default from config or root)' },
        port: { type: 'integer', description: 'SSH port (default 22)' },
        password: { type: 'string', description: 'SSH password (prefer SSH key when possible)' },
        privateKeyPath: { type: 'string', description: 'Absolute private-key path' },
        useSshConfig: { type: 'boolean', description: 'Treat `host` as a ~/.ssh/config Host alias; resolve host/user/port/key/proxy from that file (issue #38)' },
        save: { type: 'boolean', description: 'Save this machine to the registry and make it current (default true)' },
      },
      output: textOut,
      async execute(args, exec) {
        const host = String(args.host || '').trim()
        if (!host) throw new Error('rw_connect: host is required')
const cwd = callerCwdOf(exec)
        const k = wsKeyOf(cwd)
        if (!k) throw new Error('rw_connect: no session workspace to bind to (this tool must run inside a DSH session)')
        const useSshConfig = !!args.useSshConfig
        const user = args.username || config.username || 'root'
        const port = Number(args.port) || 22
        const recBase = {
          host,
          port,
          username: user,
          password: args.password !== undefined ? String(args.password) : '',
          privateKeyPath: args.privateKeyPath || '',
        }
let rec
        // An alias connection must dial the RESOLVED identity (~/.ssh/config),
        // while the registry keeps the alias itself (issue #38).
        const eff = useSshConfig ? withSshConfig(recBase) : recBase
        const effUser = eff.username || user
        const effPort = Number(eff.port) || port || 22
        if (args.save !== false) {
          // Upsert into the registry (stays a standby everywhere else —
          // issue #13) and bind THIS workspace to it. No app-wide current.
          const i = machines.findIndex((m) => m.host === recBase.host && m.username === recBase.username && Number(m.port) === recBase.port)
          if (i >= 0) {
machines[i] = {
              ...machines[i], ...recBase, useSshConfig,
              id: machines[i].id,
              password: recBase.password || machines[i].password || '',
              credentialBackend: machines[i].credentialBackend || 'plain',
            }
            rec = machines[i]
          } else {
            rec = { id: machineId(), name: host, ...recBase }
            machines.push(rec)
          }
          wsSelSet(k, { machineId: rec.id, workspace: rec.workspace || '', explicitNone: false })
        } else {
// Ephemeral: the machine record rides in the runtime selection only
          // (never persisted, never saved to the registry).
          rec = { id: machineId(), name: host, ...recBase, useSshConfig }
          wsEphemeral.set(k, { machineId: rec.id, machine: rec, workspace: '', explicitNone: false })
        }
        // Verify with the machine's OWN pool (never retargets another
        // workspace's connection). Force-fresh so updated creds are used.
        routePools.delete(rec.host + ':' + port + ':' + user)
        try {
          const rp = await machinePoolOf(rec)
          const res = await rp.exec('echo ok', { timeoutMs: 8000 })
          if (res.code !== 0 && !res.stdout) {
audit('connect', `connect ${effUser}@${eff.host}:${effPort}`, res.code, rec)
            return { text: 'connect failed: ' + (res.stderr || 'exit ' + res.code) }
          }
          audit('connect', `connect ${effUser}@${eff.host}:${effPort}`, 0, rec)
          const via = useSshConfig ? `\n(ssh-config alias "${host}" → ${effUser}@${eff.host}:${effPort}` + (eff.sshConfigWarnings && eff.sshConfigWarnings.length ? `; ${eff.sshConfigWarnings.join(' ')}` : '') + ')' : ''
          return {
            text:
              `Connected ${effUser}@${eff.host}:${effPort} — bound to THIS workspace (${cwd}); other workspaces are unaffected.${via}\n` +
              (rec.workspace ? `Remote workspace: ${rec.workspace}\n` : '') +
              'pick a workspace with rw_pick_workspace (path=<abs>) or run rw_info to inspect.',
          }
        } catch (err) {
          // Roll the selection back so a failed connect leaves no phantom binding.
          if (args.save !== false) wsSelSet(k, { machineId: '', workspace: '', explicitNone: true })
          else wsEphemeral.delete(k)
          throw new Error(friendlyMessage(err, { host, port }))
        }
      },
    }),

    defineTool({
      name: 'rw_pick_workspace',
      description:
        'Set the remote workspace directory this session should treat as its working root on the connected remote. Verifies it exists (a directory). Use rw_list_dir to browse first if unsure. Accepts POSIX (/home/dev/project) or Windows (C:\\Users\\dev\\project) paths.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path, e.g. /home/dev/code/project or C:\\Users\\dev\\project' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const cwd = callerCwdOf(exec)
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_pick_workspace: path must be an absolute directory')
        const ok = await isRemoteDirOn(pool, p)
        const shown = toDisplayPath(p, pool.platform)
        if (!ok) return { text: `not a directory (or missing) on ${shown}` }
        persistWorkspace(p, cwd)
const local = ensureMirror(p, ctx, { alias: ctx.machine ? aliasOf(ctx.machine) : '' })
        startAutoPush(local)
        return {
          text: `Remote workspace set to ${shown} on ${ctx.username}@${ctx.host} (bound to THIS workspace).\nLocal mirror (native workspace path): ${local}\n\nRun rw_sync to download its files into the local mirror.`,
        }
      },
    }),

    defineTool({
      name: 'rw_sync',
      description:
        'Download the current remote workspace into its local mirror directory over SFTP (bounded, three-way conflict-aware). Makes the remote files visible/editable locally so the DSH native workspace / fs tools can operate on them. Conflicts (both sides modified) are reported and never overwritten; use force=true to override.',
      parameters: {
        depth: { type: 'integer', description: 'Max directory depth to mirror (default 8)' },
        maxFiles: { type: 'integer', description: 'Max files to download (default 2000)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without downloading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = ctx.workspace
        if (!p) throw new Error('rw_sync: no remote workspace set in this workspace — call rw_pick_workspace first')
        const local = ctx.mirrorDir || mirrorDirFor(p, ctx)
        mkdirSync(local, { recursive: true })
        const depth = Math.min(Math.max(Number(args.depth) || 8, 1), 16)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 2000, 1), 20000)
        const isIgnored = ignoreMatcher()
        const body = { depth, maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runSync = async () => {
          let sftp
          try {
            sftp = await pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await syncTree(sftp, p, local, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD download' : 'Downloaded'} ${stats.files} file(s) from ${p} → ${local}.`
          if (stats.truncated || stats.files >= maxFiles) text += ` TRUNCATED (hit depth=${depth} or maxFiles=${maxFiles} cap; raise maxFiles/depth and re-run).`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleRemote) text += ` ${stats.staleRemote} remote entries gone (kept locally; use rw_push to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('sync', `sync ${p}`, runSync)
          return { text: `sync started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runSync()
      },
    }),

    defineTool({
      name: 'rw_push',
      description:
        'Upload the local mirror of the current remote workspace back to the remote host over SFTP (bounded, three-way conflict-aware). Use after editing files in the local mirror so the remote reflects your changes. Conflicts (both sides modified) are reported and never overwritten; use force=true to override.',
      parameters: {
        maxFiles: { type: 'integer', description: 'Max files to upload (default 2000)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without uploading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = ctx.workspace
        if (!p) throw new Error('rw_push: no remote workspace set in this workspace — call rw_pick_workspace first')
        const local = ctx.mirrorDir || mirrorDirFor(p, ctx)
        if (!existsSync(local)) throw new Error(`rw_push: local mirror does not exist — run rw_sync first (${local})`)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 2000, 1), 20000)
        const isIgnored = ignoreMatcher()
        const body = { maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runPush = async () => {
          let sftp
          try {
            sftp = await pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await pushTree(sftp, local, p, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD upload' : 'Uploaded'} ${stats.files} file(s) from ${local} → ${p}.`
          if (stats.truncated || stats.files >= maxFiles) text += ` TRUNCATED (hit maxFiles=${maxFiles} cap; raise maxFiles and re-run).`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleLocal) text += ` ${stats.staleLocal} local entries gone remotely (kept remotely; use rw_remove to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('push', `push ${p}`, runPush)
          return { text: `push started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runPush()
      },
    }),

    defineTool({
      name: 'rw_list_dir',
      description:
        'List a remote directory (or a single file) via SSH. Path is absolute; accepts Windows paths like C:\\Users\\dev\\project on Git Bash remotes. If omitted, lists the current remote workspace. Shows type, size, mtime.',
      parameters: {
        path: { type: 'string', description: 'Absolute remote path (default: current remote workspace)' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = args.path ? resolveRemoteArg(ctx, args.path) : (ctx.workspace || '')
        if (!p) throw new Error('rw_list_dir: no path and no remote workspace set in this workspace')
        let list
        try {
          const sftp = await pool.sftp()
          list = await sftp.readdir(p)
        } catch (err) {
          throw new Error('rw_list_dir: ' + ((err && err.message) || err))
        }
        const fmtMtime = (t) => {
          if (!t) return '?'
          const d = new Date(t * 1000)
          const pad = (n) => String(n).padStart(2, '0')
          return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
        }
        const lines = list
          .filter((e) => String(e.filename) !== '.' && String(e.filename) !== '..')
          .map((e) => {
            const a = e.attrs || {}
            const type = a.isDirectory && a.isDirectory() ? 'd' : (a.isSymbolicLink && a.isSymbolicLink() ? 'l' : '-')
            const size = typeof a.size === 'number' ? String(a.size) : '?'
            return `${type} ${size.padStart(10)} ${fmtMtime(a.mtime).padEnd(17)} ${String(e.filename)}`
          })
        return { text: lines.length ? lines.join('\n') : '(empty directory)' }
      },
    }),

    defineTool({
      name: 'rw_stat',
      description:
        'Show detailed stat of a remote file or directory: type, size, mtime, mode (SFTP attrs). Use to verify a remote path exists or to compare files.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p) throw new Error('rw_stat: path is required')
        const sftp = await pool.sftp()
        let st
        try {
          st = await sftp.stat(p)
        } catch (err) {
          throw new Error('rw_stat: not found or unreadable: ' + ((err && err.message) || err))
        }
        const type = st.isDirectory && st.isDirectory() ? 'directory' : (st.isSymbolicLink && st.isSymbolicLink() ? 'symlink' : 'file')
        const lines = [
          `path: ${p}`,
          `type: ${type}`,
          `size: ${st.size} bytes`,
          `mtime: ${new Date(st.mtime * 1000).toISOString()}`,
          `mode: ${typeof st.mode === 'number' ? st.mode.toString(8) : '?'}`,
        ]
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_read_file',
      description:
        'Read a text file on the remote host with line numbers. Supports paging with startLine/endLine and an encoding param (utf-8 default, gbk etc). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        startLine: { type: 'integer', description: '1-based first line (default 1)' },
        endLine: { type: 'integer', description: '1-based last line (inclusive)' },
        maxLines: { type: 'integer', description: 'Max lines (default 2000)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p) throw new Error('rw_read_file: path is required')
        const maxLines = Math.min(Math.max(Number(args.maxLines) || 2000, 1), 10000)
        let from = Math.max(Number(args.startLine) || 1, 1)
        let to = Number(args.endLine) || 0
        if (!to || to - from + 1 > maxLines) to = from + maxLines - 1
        const sftp = await pool.sftp()
        let st
        try { st = await sftp.stat(p) } catch (err) { throw new Error('rw_read_file: ' + ((err && err.message) || err)) }
        if (config.maxFileBytes > 0 && st.size > config.maxFileBytes) {
          throw new Error(`rw_read_file: file is ${st.size} bytes (over ${config.maxFileBytes} cap); use rw_download or rw_exec to read it`)
        }
        let buf
        try {
          buf = await sftp.readFile(p)
        } catch (err) {
          throw new Error('rw_read_file: ' + ((err && err.message) || err))
        }
        const content = decodeBuf(buf, args.encoding || config.encoding).replace(/\r\n/g, '\n')
        const allLines = content.split('\n')
        const page = allLines.slice(from - 1, to)
        const numbered = page.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n').replace(/\s+$/, '')
        let text = numbered === '' ? '(empty or out of range)' : numbered
        if (!args.endLine) text += '\n(shown up to ' + maxLines + ' lines; use startLine/endLine to page)'
        return { text }
      },
    }),

    defineTool({
      name: 'rw_write_file',
      description:
        'Write text to a file on the remote host (creating parent directories if needed). Path is absolute. Use this to create or overwrite a remote file directly, instead of round-tripping through a local mirror.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'File content to write (overwrites existing file)' },
        mkdir: { type: 'boolean', description: 'Create missing parent directories (default true)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p || p === '/') throw new Error('rw_write_file: a file path is required')
        const content = String(args.content == null ? '' : args.content)
        const sftp = await pool.sftp()
        if (args.mkdir !== false) await mkdirRemoteDirs(sftp, remoteDirname(p))
        const buf = encodeText(content, args.encoding || config.encoding)
        await sftp.writeFile(p, buf)
        const bytes = buf.byteLength
audit('write_file', `write ${p} (${bytes}B)`, 0, ctx)
        return { ok: true, bytes, text: `wrote ${bytes} bytes to ${p}` }
      },
    }),

    defineTool({
      name: 'rw_edit',
      description:
        'Edit a remote text file by replacing literal text (read-modify-write with an mtime optimistic lock: aborts if the file changed on the remote between read and write). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        old: { type: 'string', required: true, description: 'Literal text to replace (must appear exactly once unless count is given)' },
        new: { type: 'string', required: true, description: 'Replacement text' },
        count: { type: 'integer', description: 'How many occurrences to replace (default: error if the text appears more than once)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p || p === '/') throw new Error('rw_edit: a file path is required')
        const oldS = String(args.old ?? '')
        const newS = String(args.new ?? '')
        if (oldS === '') throw new Error('rw_edit: old text must not be empty')
        const sftp = await pool.sftp()
        const st0 = await sftp.stat(p)
        const buf = await sftp.readFile(p)
        const content = decodeBuf(buf, args.encoding || config.encoding)
        const count = args.count == null ? 0 : Math.max(Number(args.count) || 1, 1)
        const idxs = []
        let from = 0
        let hit
        while ((hit = content.indexOf(oldS, from)) !== -1) { idxs.push(hit); from = hit + oldS.length }
        if (!idxs.length) throw new Error(`rw_edit: old text not found in ${p}`)
        if (count === 0 && idxs.length > 1) {
          throw new Error(`rw_edit: "old" appears ${idxs.length} times in ${p} — pass count=<n> to pick how many to replace`)
        }
        const n = count === 0 ? 1 : Math.min(count, idxs.length)
        let out = content
        for (let i = n - 1; i >= 0; i--) {
          out = out.slice(0, idxs[i]) + newS + out.slice(idxs[i] + oldS.length)
        }
        // Optimistic lock: the remote must not have changed since we read it.
        const st1 = await sftp.stat(p)
        if (st1.size !== st0.size || st1.mtime !== st0.mtime) {
          throw new Error(`rw_edit: ${p} changed on the remote while editing (conflict) — re-read and retry`)
        }
        await sftp.writeFile(p, encodeText(out, args.encoding || config.encoding))
        audit('edit', `edit ${p} (${n} occurrence(s))`, 0, ctx)
        return { ok: true, bytes: Buffer.byteLength(out), text: `edited ${p}: replaced ${n} occurrence(s)` }
      },
    }),

    defineTool({
      name: 'rw_append',
      description:
        'Append text to a remote file (creates it when missing). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'Text to append' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p || p === '/') throw new Error('rw_append: a file path is required')
        const sftp = await pool.sftp()
        let existing = ''
        try { existing = decodeBuf(await sftp.readFile(p), args.encoding || config.encoding) } catch { /* new file */ }
        const content = existing + String(args.content ?? '')
        await sftp.writeFile(p, encodeText(content, args.encoding || config.encoding))
        const bytes = Buffer.byteLength(content)
        audit('append', `append ${p}`, 0, ctx)
        return { ok: true, bytes, text: `appended to ${p} (now ${bytes} bytes)` }
      },
    }),

    defineTool({
      name: 'rw_mkdir',
      description:
        'Create a remote directory (mkdir -p semantics, all levels). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p || p === '/') throw new Error('rw_mkdir: a directory path is required')
        const sftp = await pool.sftp()
        await mkdirRemoteDirs(sftp, p)
        audit('mkdir', `mkdir ${p}`, 0, ctx)
        return { text: `created ${p}` }
      },
    }),

    defineTool({
      name: 'rw_remove',
      description:
        'Delete a remote file (or an empty directory). recursive=true removes a directory tree (bounded). Path is absolute. This is destructive — the agent should confirm intent before calling.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path to delete' },
        recursive: { type: 'boolean', description: 'Recursively delete a directory (default false)' },
      },
      output: okOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p || p === '/') throw new Error('rw_remove: a path is required')
        const sftp = await pool.sftp()
        const st = await sftp.stat(p).catch(() => null)
        if (!st) return { ok: false, text: `not found: ${p}` }
        if (st.isDirectory && st.isDirectory()) {
          if (!args.recursive) throw new Error(`rw_remove: ${p} is a directory — pass recursive=true to delete its tree`)
          const removed = await removeRemoteTree(sftp, p)
          audit('remove', `remove -r ${p}`, 0, ctx)
          return { ok: true, text: `removed ${removed} entries under ${p}` }
        }
        await sftp.unlink(p)
        audit('remove', `remove ${p}`, 0, ctx)
        return { ok: true, text: `removed ${p}` }
      },
    }),

    defineTool({
      name: 'rw_move',
      description:
        'Rename or move a remote file/directory (SFTP rename, same filesystem). Paths are absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Current absolute remote path' },
        dest: { type: 'string', required: true, description: 'Destination absolute remote path' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        const d = resolveRemoteArg(ctx, args.dest)
        if (!p || !d || p === '/') throw new Error('rw_move: both path and dest are required')
        const sftp = await pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(d))
        await sftp.rename(p, d)
        audit('move', `move ${p} → ${d}`, 0, ctx)
        return { text: `moved ${p} → ${d}` }
      },
    }),

    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the remote host. Use for anything that is not reading a file (build, test, grep, etc). Output is capped. Runs in the current remote workspace by default; pass cwd to run elsewhere. pty=true helps interactive commands (sudo prompts, REPLs); env sets environment variables.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command (run on the remote host)' },
        cwd: { type: 'string', description: 'Working directory for the command (default: the current remote workspace)' },
        pty: { type: 'boolean', description: 'Allocate a pseudo-terminal (interactive commands, default false)' },
        env: { type: 'object', additionalProperties: true, description: 'Extra environment variables (string values)' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const cmd = String(args.command || '')
        if (!cmd) throw new Error('rw_exec: command is required')
        const ws = ctx.workspace
        const cwd = args.cwd ? resolveRemoteArg(ctx, args.cwd) : (ws || '')
        let full = cmd
        if (cwd) {
          // Detect before choosing the cwd form: a per-machine pool starts
          // undetected, and reading `platform` first would skip the Git Bash
          // mount-path rewrite on the first command sent to a Windows host.
          // detect() is cached and idempotent, so this costs one probe per pool.
          try { await pool.detect() } catch { /* probe failed → fall through to the POSIX form */ }
          if (pool.platform === 'windows' && pool.gitBashPath) {
            // Git Bash terminal: cd in the /c/Users/… mount form
            full = `cd ${shq(toShellPath(cwd))} && ${cmd}`
          } else if (!cwd.includes('\\')) {
            full = `cd ${shq(cwd)} && ${cmd}`
          }
        }
        try {
const res = await pool.exec(full, { timeoutMs: config.commandTimeoutMs, pty: !!args.pty, env: args.env })
          audit('exec', cmd, res.code, ctx)
          const parts = []
          if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
          if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
          if (!parts.length) parts.push('(no output)')
          let text = parts.join('\n')
          if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${config.commandTimeoutMs}ms]`
          else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
          return { text }
        } catch (err) {
throw new Error(friendlyMessage(err, { host: ctx.host, port: ctx.port }))
        }
      },
    }),

    defineTool({
      name: 'rw_search',
      description:
        'Search remote files for a pattern. POSIX remotes try `rg` then `grep -R` first; Windows and fallbacks use a portable SFTP walk. Honors ignore rules. Returns matching file:line rows; output is capped.',
      parameters: {
        pattern: { type: 'string', required: true, description: 'Pattern to search for (extended regex)' },
        path: { type: 'string', description: 'Directory to search (default: current remote workspace)' },
        glob: { type: 'string', description: 'Only files whose NAME matches this glob, e.g. *.ts (optional)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default true)' },
        contextLines: { type: 'integer', description: 'Lines of context around each match (default 0)' },
        maxMatches: { type: 'integer', description: 'Max matches to return (default 500)' },
      },
      output: textOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const pattern = String(args.pattern || '')
        if (!pattern) throw new Error('rw_search: pattern is required')
        const ws = ctx.workspace
        const dir = args.path ? resolveRemoteArg(ctx, args.path) : (ws || '')
        if (!dir) throw new Error('rw_search: no path and no remote workspace set in this workspace')
        let regex
        try {
          regex = new RegExp(pattern, args.ignoreCase === false ? '' : 'i')
        } catch (err) {
          throw new Error('rw_search: bad pattern: ' + ((err && err.message) || err))
        }
        const maxMatches = Math.min(Math.max(Number(args.maxMatches) || 500, 1), 2000)
        const matcher = ignoreMatcher()
        const { matches, scanned, truncated } = await searchRemote(pool, dir, {
          pattern,
          regex,
          glob: args.glob,
          ignoreCase: args.ignoreCase !== false,
          contextLines: Math.min(Math.max(Number(args.contextLines) || 0, 0), 10),
          maxMatches,
          maxScanBytes: Math.min(config.maxFileBytes || 1024 * 1024, 1024 * 1024),
          isIgnored: (name, isDir) => matcher(name, isDir),
          timeoutMs: config.commandTimeoutMs,
        })
        if (!matches.length) return { text: `no matches for /${pattern}/ in ${dir} (${scanned} files scanned)` }
        let text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')
        text += `\n(${matches.length} match(es), ${scanned} files scanned${truncated ? ', TRUNCATED' : ''})`
        return { text: truncate(text, config.maxOutputChars) }
      },
    }),

    defineTool({
      name: 'rw_download',
      description:
        'Download a single remote file over SFTP into the local mirror of the current workspace (or to an explicit local path). Use when you need the actual file content locally, not just its text. Streams to disk (fastGet).',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        localPath: { type: 'string', description: 'Local destination (default: the workspace mirror, preserving the relative path)' },
      },
      output: okOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const p = resolveRemoteArg(ctx, args.path)
        if (!p || p === '/') throw new Error('rw_download: a remote file path is required')
        const sftp = await pool.sftp()
        let local
        if (args.localPath) {
          local = path.resolve(String(args.localPath))
        } else {
const ws = ctx.workspace
          if (!ws) throw new Error('rw_download: no remote workspace set in this workspace — pass localPath explicitly')
          const base = ctx.mirrorDir || mirrorDirFor(ws, ctx)
          const rel = p.startsWith(ws) ? p.slice(ws.length).replace(/^\/+/, '') : p.slice(1)
          local = path.join(base, rel)
        }
        mkdirSync(path.dirname(local), { recursive: true })
        const st = await sftp.stat(p).catch(() => null)
        if (config.maxFileBytes > 0 && st && st.size > config.maxFileBytes) {
          throw new Error(`rw_download: file is ${st.size} bytes (over ${config.maxFileBytes} cap)`)
        }
        await sftp.fastGet(p, local)
        const bytes = existsSync(local) ? statSync(local).size : 0
        return { ok: true, bytes, text: `downloaded ${bytes} bytes from ${p} → ${local}` }
      },
    }),

    defineTool({
      name: 'rw_upload',
      description:
        'Upload a local file over SFTP to a path on the remote host (creating parent directories if needed). Use to push a local file directly, without a full rw_push of the whole mirror.',
      parameters: {
        localPath: { type: 'string', required: true, description: 'Absolute local file path' },
        path: { type: 'string', required: true, description: 'Absolute remote destination path' },
      },
      output: okOut,
      async execute(args, exec) {
const { ctx, pool } = await rwScopeOf(exec)
        const rp = resolveRemoteArg(ctx, args.path)
        const lp = String(args.localPath || '')
        if (!rp || rp === '/' || !lp) throw new Error('rw_upload: both localPath and a remote path are required')
        if (!existsSync(lp)) throw new Error(`rw_upload: local file not found: ${lp}`)
        const sftp = await pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(rp))
        const st = statSync(lp)
        await sftp.fastPut(lp, rp)
        audit('upload', `upload ${lp} → ${rp}`, 0, ctx)
        return { ok: true, bytes: st.size, text: `uploaded ${st.size} bytes from ${lp} → ${rp}` }
      },
    }),

    defineTool({
      name: 'rw_forward',
      description:
        'Manage SSH port forwards. Direction "local" listens on 127.0.0.1:<listenPort> on THIS machine and forwards connections through SSH to <targetHost>:<targetPort> on the remote. Direction "reverse" asks the REMOTE to listen on 127.0.0.1:<listenPort> and pipes connections back to <targetHost>:<targetPort> on this machine. Call with a listenPort to create+start; with remove=true to delete.',
      parameters: {
        listenPort: { type: 'integer', required: true, description: 'Port to listen on (local for direction=local, remote for direction=reverse)' },
        targetHost: { type: 'string', description: 'Forward target host (default 127.0.0.1)' },
        targetPort: { type: 'integer', description: 'Forward target port (default: same as listenPort)' },
        direction: { type: 'string', description: 'local (default) or reverse' },
        autoStart: { type: 'boolean', description: 'Restart this forward automatically on future connects (default false)' },
        remove: { type: 'boolean', description: 'Remove an existing forward by listenPort (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
        const { ctx } = await rwScopeOf(exec)
        const port = Number(args.listenPort)
        if (!port || port < 1 || port > 65535) throw new Error('rw_forward: a valid listenPort is required')
        const dir = args.direction === 'reverse' ? 'reverse' : 'local'
        const existing = forwards.list().find((f) => Number(f.listenPort) === port && f.direction === dir)
        if (args.remove) {
          if (!existing) return { text: `no forward on port ${port} to remove` }
          forwards.remove(existing.id)
          return { text: `removed ${existing.direction} forward on port ${port}` }
        }
        if (existing && existing.active) return { text: `already active: ${existing.direction} forward 127.0.0.1:${port} → ${existing.targetHost}:${existing.targetPort}` }
        const d = existing || forwards.define({
          direction: dir,
          listenPort: port,
          targetHost: args.targetHost || '127.0.0.1',
          targetPort: Number(args.targetPort) || port,
          autoStart: !!args.autoStart,
          machineId: ctx.machineId || '',
          workspace: ctx.cwd || '',
        })
        const r = await forwards.start(d)
        audit('forward', `${d.direction} forward ${port} → ${d.targetHost}:${d.targetPort}`, r.ok ? 0 : 1, ctx)
        if (!r.ok) throw new Error(r.error)
        return { text: `${d.direction} forward active: 127.0.0.1:${port} → ${d.targetHost}:${d.targetPort} (id=${d.id})` }
      },
    }),

    defineTool({
      name: 'rw_disconnect',
      description:
'Close the SSH connection bound to THIS workspace, releasing its pool (and stopping nothing global). Other workspaces keep their own connections. Useful to rotate connections or after a long idle.',
      parameters: {},
      output: okOut,
      async execute(args, exec) {
        const cwd = callerCwdOf(exec)
        const ctx = ctxForCwd(cwd)
        if (ctx && ctx.machineId) {
          // Drop the workspace's dedicated machine pool + runtime selection.
          const entry = routePools.get(ctx.host + ':' + (Number(ctx.port) || 22) + ':' + (ctx.username || 'root'))
          if (entry) { try { entry.pool.close() } catch {}; routePools.delete(ctx.host + ':' + (Number(ctx.port) || 22) + ':' + (ctx.username || 'root')) }
        }
        if (cwd) wsEphemeral.delete(wsKeyOf(cwd))
        return { ok: true, text: cwd ? `disconnected remote of workspace ${cwd} (other workspaces unaffected)` : 'disconnected (no workspace context)' }
      },
    }),
  ]

  for (const t of tools) {
    ctx.tools.register(t)
  }

  // ── system-prompt injection: session-aware remote workspace ──────────────
  // Issue #13: remote context must be SESSION-scoped, not machine-global.
  // The section text is evaluated per assembly with the current agent's
  // session; it is injected ONLY when that session's cwd actually maps to a
  // dsh-remote mirror (i.e. the user picked a remote workspace as the session
  // workspace). A plain local session gets no remote section — saved machines
  // never leak their workspace into an unrelated local session's prompt.
  // (resolveMirrorForLocal is defined above, next to wsPath.)
  ctx.systemPrompt.section({
    name: 'dsh-remote',
    order: 88,
    text: (promptContext) => {
      const agent = promptContext && promptContext.agent
      const session = agent && agent.session
      const cwd = session && session.header && session.header.cwd
      if (!cwd) return '' // no session cwd → nothing to map → stay quiet
const { remotePath, mirrorDir } = resolveMirrorForLocal(cwd)
      if (!remotePath) return '' // this session is NOT a remote session (issue #13)
      const m = mirrorMatchOf(cwd)
      const who = m ? `${m.username || 'root'}@${m.host}` : 'user@host'
      const fwd = forwards.list().filter((f) => f.active).map((f) => `${f.direction}:127.0.0.1:${f.listenPort}→${f.targetHost}:${f.targetPort}`)
      const shown = toDisplayPath(remotePath, 'posix')
      let extra = ''
      if (fwd.length) extra = `\nActive port forwards: ${fwd.join(', ')}`
      // Issue #39: `@` mentions are resolved from the REMOTE tree by
      // lib/file-reference.js, so the model must know they are remote-relative
      // and that the built-in read tool sees only the local mirror.
      return (
        '## Remote workspace\n' +
`Current remote workspace: ${who}:${shown} — the real project files live on this REMOTE host (bound to THIS workspace; other workspaces are unaffected).\n` +
        `Local mirror (session workspace, cached snapshot of the remote tree): ${mirrorDir || cwd}\n` +
        'PATH RULES — avoid wasted local lookups:\n' +
        `- Any absolute path the user mentions (e.g. /data/…, /home/…, /root/…, /c/…, C:\\…) is a REMOTE path: it exists on the host, not on this machine. NEVER open/glob/grep it with local file tools (read, glob, grep, bash ls/cat) — those attempts always fail and prove nothing.\n` +
        `- For remote paths, call the rw_* tools directly: rw_list_dir / rw_stat (list / existence), rw_read_file (read), rw_search (grep), rw_exec (shell), rw_write_file / rw_edit / rw_append (write), rw_sync / rw_push (mirror sync), rw_download / rw_upload (transfer).\n` +
        `- The mirror may be absent or stale: remote ${shown}/<x> maps to ${mirrorDir || cwd}/<x> locally only after a sync. Confirm on the host (rw_read_file / rw_stat) before concluding a file does not exist or reading authoritative content.\n` +
        'REFERENCES (@ protocol — spellings must match lib/client.js REF_REMOTE/REF_LOCAL):\n' +
        `- @remote:/path — a file on this session's remote host (e.g. @remote:${shown}/restart.sh). It exists ONLY on the host: read it via rw_read_file / rw_stat / rw_search / rw_exec, never with local tools.\n` +
        `- @local:/path — or an untagged path under the local mirror — a file on THIS machine: use native local tools (read / glob / grep).\n` +
        `- An untagged absolute path (e.g. /data/…, C:\\…) means REMOTE (see PATH RULES above).\n` +
        extra
      )
    },
  })

  // ── slash commands ─────────────────────────────────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: 'Show the current remote workspace / connection status, active forwards, and how to use remote tools.',
      handler: (invocation) => {
        // Slash commands run inside a session → per-workspace status, so a
        // local project never reports another project's remote (issue #13).
        const s = status(callerCwdOf(invocation))
        const fwd = s.forwards.filter((f) => f.active)
        const noneNote = (!s.host) ? '\n(This workspace has no remote binding — run rw_connect or set a current machine for it in the dsh-remote settings.)' : ''
        return {
          kind: 'success',
          text:
            `Remote host: ${s.username}@${s.host || '<none>'} (connected: ${s.connected}, source: ${s.activeSource})\n` +
            `Remote workspace: ${s.workspace || '(none)'}\n` +
            `Session mode: ${s.sessionMode}\n` +
            `Host key: ${s.hostKeyKnown ? 'trusted ✓' : 'not yet trusted'} (mode=${s.hostKeyMode})\n` +
            (s.hostKeyKnown ? `  — if the key changed / was mistrusted, run /remote-forget-key\n` : '') +
            (fwd.length ? `Active forwards:\n${fwd.map((f) => `  ${f.direction} 127.0.0.1:${f.listenPort} → ${f.targetHost}:${f.targetPort}`).join('\n')}\n` : '') +
            `\nUse tools: rw_list_dir / rw_read_file / rw_edit / rw_exec / rw_search / rw_forward.` +
            (s.workspace ? `\nCurrently working in ${s.workspace}.` : '') +
            noneNote,
        }
      },
    })
    commands.register({
      name: 'remote-forget-key',
      description: 'Drop the trusted host-key record for the current machine so the next connect re-records it.',
handler: (invocation) => {
        const s = status(callerCwdOf(invocation))
        const host = s.host || config.host || ''
        const port = s.port || config.port || 22
        // A one-off guard keyed to the ACTUAL machine of this workspace (not
        // the profile config, which may belong to a different workspace).
        createHostKeyGuard({ host, port, hostKeyMode: config.hostKeyMode }).forgetHost()
        return { kind: 'success', text: `forgot host key for ${host || '<none>'}:${port} — the next connect will re-record it.` }
      },
    })
    commands.register({
      name: 'remote-ignore',
      description: 'Show the mirror ignore rules file location and the current default patterns (gitignore syntax).',
      handler: () => {
        return {
          kind: 'success',
          text:
            `Ignore file: ${ignoreFile()}\n(defaults merged with the file; gitignore syntax, '#' comments)\n\nDefault patterns:\n${DEFAULT_IGNORE.map((p) => '  ' + p).join('\n')}`,
        }
      },
    })
  }

  // ── JSON endpoints for settings UI ─────────────────────────────────────────
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const MAX_BODY_BYTES = 1024 * 1024
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let total = 0
      req.on('data', (c) => {
        total += c.length
        if (total > MAX_BODY_BYTES) {
          req.removeAllListeners('data')
          resolve('{}')
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(chunks.join('')))
    })

  /** Parse a JSON *object* request body.
   *
   * Throws an Error carrying `httpStatus: 400` when the body is not valid JSON
   * or not an object, so a route can answer `400 + {ok:false, error}` instead of
   * rejecting the handler — a rejected handler makes dsh-host-webserver reply
   * with an empty 400 that carries neither Content-Type nor a reason, which is
   * exactly the "everything is just HTTP 400" symptom of issue #30. */
  const parseJsonObject = (raw) => {
    let parsed
    try {
      parsed = JSON.parse(raw || '{}')
    } catch (e) {
      const err = new Error(`请求体不是合法 JSON：${String((e && e.message) || e)}`)
      err.httpStatus = 400
      throw err
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('请求体必须是一个 JSON 对象')
      err.httpStatus = 400
      throw err
    }
    return parsed
  }

  // ── 本机目录选择器：DSH directoryPicker 服务优先，缺位/非原生则自持兜底 ──
  const PICK_TIMEOUT_MS = 120000
  const runPick = (bin, args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: PICK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code
          const msg = String(stderr || '')
          if (code === 1 && /(?:user canceled|-128)/i.test(msg)) return resolve({ cancelled: true })
          if (err.signal || err.killed) return reject(new Error('目录选择已超时，请重试或直接在输入框填本地路径'))
          if (code === 'ENOENT') return reject(Object.assign(new Error('未找到目录选择器程序 ' + bin), { code }))
          return reject(new Error((msg.trim() || (err && err.message) || '无法打开系统文件夹选择器').split('\n')[0]))
        }
        const p = String(stdout || '').replace(/[\r\n]+$/, '').trim()
        resolve(p === 'CANCELED' ? { cancelled: true } : (p ? { path: p } : { cancelled: true }))
      })
    })
  const pickLocalNative = async () => {
    const platform = process.platform
    if (platform === 'darwin') {
      return runPick('osascript', ['-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"', '-e', 'POSIX path of selectedFolder'])
    }
    if (platform === 'linux') {
      try {
        return await runPick('zenity', ['--file-selection', '--directory', '--title=Select Workspace Directory'])
      } catch (err) {
        if (err && err.code === 'ENOENT') return runPick('kdialog', ['--getexistingdirectory', '.', '--title', 'Select Workspace Directory'])
        throw err
      }
    }
    if (platform === 'win32') {
      const script =
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `$f = New-Object System.Windows.Forms.FolderBrowserDialog;` +
        `$f.Description = 'Select Workspace Directory';` +
        `if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { 'CANCELED' }`
      return runPick('powershell', ['-NoProfile', '-STA', '-Command', script])
    }
    throw new Error('当前系统不支持自动打开目录选择器，请在输入框直接填本地路径')
  }

  /** The ctx.directoryPicker capability object, or null when the service is
   * absent/unusable. Never throws — callers fall through to pickLocalNative. */
  const localPickCapability = async () => {
    const dp = (ctx && typeof ctx.get === 'function') ? (ctx.get('directoryPicker') || null) : null
    if (!dp || typeof dp.capability !== 'function') return null
    try {
      return await Promise.resolve(dp.capability())
    } catch {
      return null
    }
  }

  /** Windows has no single filesystem root — enumerate fixed/mapped drive
   * letters so the in-app browser can switch between them (the browse
   * backend's crumbs stop at the current drive's root). Empty on POSIX. */
  const listLocalDrives = () => {
    if (process.platform !== 'win32') return []
    const out = []
    for (let i = 67; i <= 90; i++) { // C..Z (A/B are legacy floppy — skip)
      const root = String.fromCharCode(i) + ':\\'
      try {
        statSync(root)
        out.push({ name: root.slice(0, -1), path: root })
      } catch {}
    }
    return out
  }

  // ── route helpers ─────────────────────────────────────────────────────────
  const routes = [
    {
      // 浏览器 half 装配期读取的配置端点：返回最终生效的侧栏 directory-flow
      // 槽位 key（DirPicker 侧栏注册用）。优先级链见 apply() 顶部：
      // 显式 config > patch 表达式 > loader.entries() 兜底探测 > 官方默认。
      // `source` 标注命中的优先级，供诊断（sync-profile.sh 的槽位回显也读这里）。
      kind: 'exact',
      path: '/dsh-remote/slot-config',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, sidebarDirectoryFlowSlot: effectiveSlot.slot, source: effectiveSlot.source })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/status',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
const cwdParam = q.get('cwd') ? decodeURIComponent(q.get('cwd')) : ''
          // Per-session remote context (issue #13 + per-workspace isolation):
          // a sessionId/cwd narrows the status to THAT workspace — the
          // workspace's machine/remote path, never an app-wide current.
          const cwd = sessionId ? (sessionCwdOf(sessionId) || cwdParam || '') : (cwdParam || '')
          return sendJson(res, 200, status(cwd, sessionId || undefined))
        }
        sendJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      // Map a LOCAL path (typically a session cwd that sits inside a remote
      // mirror dir) to the remote path it mirrors, by reading each mirror
      // dir's .dsh-remote-meta.json. NO machine-workspace fallback (issue #13):
      // a session whose cwd is not inside any mirror is a pure LOCAL session —
      // the sidebar must show "no remote workspace", never another machine's
      // remembered default.
      // Accepts either ?local=<abs path> or ?sessionId=<id> (resolved via
      // the host sessions service header.cwd).
      kind: 'exact',
      path: '/dsh-remote/resolve-mirror',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let local = q.get('local') ? decodeURIComponent(q.get('local')) : ''
          const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
          let resolvedVia = 'query'
          if (!local && sessionId) {
            local = sessionCwdOf(sessionId)
            resolvedVia = 'session'
          }
          // Issue #13 + per-workspace isolation: the owner is read from the
          // mirror's meta file. A non-mirror session is LOCAL — remotePath
          // stays empty and NO machine workspace is ever reported.
          const m = mirrorMatchOf(local)
          const remotePath = m ? m.remotePath : ''
          const owner = m && m.host ? machineByTarget(m.host, m.port, m.username) : null
          return sendJson(res, 200, {
            local, remotePath,
            mirrorDir: m ? m.mirrorDir : null,
            // Owning machine of the mirror (empty for non-mirror sessions).
            host: m ? m.host : '',
            port: m ? m.port : 0,
            username: m ? m.username : '',
            machineId: owner ? owner.id : '',
            // `fallback:true` now means "this session is NOT a remote session"
            // (used to mean "fell back to machine workspace").
            fallback: !remotePath,
            mode: remotePath ? 'remote' : 'local',
            resolvedVia,
          })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        // Issue #30: `payload` is declared OUTSIDE the try block on purpose.
        // A `const payload` inside `try` is scoped to that block, so the catch
        // below used to throw `ReferenceError: payload is not defined` BEFORE
        // it could send anything — the webserver then turned the rejected
        // handler into an empty HTTP 400 and the real reason never reached the
        // UI. Hoisting it (and defaulting to {}) makes the failure path total:
        // this handler now always answers with JSON.
        let payload = {}
        try {
          payload = parseJsonObject(await readBody(req))
          const host = String(payload.host || '').trim()
          if (!host) return sendJson(res, 400, { ok: false, error: 'host is required' })
          // Per-workspace isolation: bind the connection to ONE workspace
          // (payload.workspace or the first live session), never the shared
          // pool (that would retarget every workspace's remote context).
          const localWs = typeof payload.workspace === 'string' && payload.workspace.trim()
            ? payload.workspace.trim()
            : callerCwdOf(null)
          const k = wsKeyOf(localWs)
          if (!k) return sendJson(res, 400, { ok: false, error: 'no workspace context' })
          const rec = {
            id: machineId(),
            host,
            port: Number(payload.port) || 22,
            username: String(payload.username || 'root'),
            password: payload.password !== undefined && payload.password !== '' ? String(payload.password) : '',
            privateKeyPath: payload.privateKeyPath || '',
            workspace: payload.workspaceRemote || '',
          }
          wsEphemeral.set(k, { machineId: rec.id, machine: rec, workspace: rec.workspace, explicitNone: false })
          const rp = await machinePoolOf(rec)
          await rp.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
          return sendJson(res, 200, { ok: true, ...status(localWs) })
        } catch (err) {
          return sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: friendlyMessage(err, { host: payload && payload.host, port: payload && payload.port }) })
        }
      },
    },
    {
      // Force re-establishing the SSH connection for a machine (refresh
      // effect). The browser calls this when a browse/read failed with a stale
      // or credential-less pool (e.g. the connection dropped and the route
      // pool holds no usable credentials — "remote directory read failed:
      // browse failed: no credentials…"). The pool is torn down and REBUILT,
      // re-resolving keychain credentials, then a live exec verifies the
      // connection and `status` is returned so the caller can re-list.
      // Resolves the target machine from (priority order):
      //   ?machine=<id> / body.machineId → the saved machine;
      //   body.path                      → the mirror owner of that remote path;
      //   body.workspace (local cwd)     → the per-workspace selection
      //                                    (incl. ephemeral rw_connect ones);
      //   else                           → the profile-config default machine.
      kind: 'exact',
      path: '/dsh-remote/reconnect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        let body = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch { /* treat empty body as {} */ }
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          const machineIdParam = q.get('machine') ? decodeURIComponent(q.get('machine')) : ''
          const id = machineIdParam || String(body.machineId || '')
          let rec = null
          if (id) {
            const i = machineIndex(id)
            if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine ' + id + ' is not saved in the dsh-remote machine registry' })
            rec = machines[i]
          } else if (body.path) {
            const mirror = pickMirrorForRemotePath(remoteWorkspacesRoot(), normalizeRemotePath(String(body.path)), null, (h, p, u) => !!machineByTarget(h, p, u))
            if (mirror) rec = machineByTarget(mirror.host, mirror.port, mirror.username)
          }
          if (!rec && typeof body.workspace === 'string' && body.workspace.trim()) {
            const sel = wsSel(wsKeyOf(body.workspace))
            if (sel && sel.machine) rec = sel.machine
            else if (sel && sel.machineId) {
              const i = machineIndex(sel.machineId)
              if (i >= 0) rec = machines[i]
            }
          }
          if (!rec && config.host) rec = profileMachine()
          if (!rec) {
            return sendJson(res, 400, {
              ok: false, error: 'no remote machine to reconnect: pass machineId / path / workspace, or configure a default machine',
            })
          }
          // Tear down the cached pool (if any) so the fresh one re-resolves
          // credentials and re-detects the remote platform.
          const tag = rec.host + ':' + (Number(rec.port) || 22) + ':' + (rec.username || 'root')
          const entry = routePools.get(tag)
          if (entry) { try { entry.pool.close() } catch {}; routePools.delete(tag) }
          const rp = await machinePoolOf(rec)
          await rp.detect()
          const res2 = await rp.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
          if (res2.code !== 0 && !res2.stdout) {
            throw new Error('ssh exec failed: ' + (res2.stderr || 'exit ' + res2.code))
          }
          audit('reconnect', `reconnect ${rec.username || '?'}@${rec.host}:${rec.port}`, 0, rec)
          const cwd = typeof body.workspace === 'string' ? body.workspace : ''
          return sendJson(res, 200, { ok: true, machineId: rec.id, ...status(cwd || '') })
        } catch (err) {
          const msg = String((err && err.message) || err)
          console.error('[dsh-remote] reconnect failed:', msg)
          const cls = classifyError(err, { host: body && body.host, port: body && body.port })
          return sendJson(res, 500, {
            ok: false,
            credential: cls.category === 'credentials' || cls.category === 'auth',
            error: friendlyMessage(err, { host: body && body.host, port: body && body.port }),
          })
        }
      },
    },

    ...createFsRoutes({
      sendJson, readBody, resolveRequestBinding, decodeBuf, encodeText, audit, config, mirrorDirFor,
    }),

    {
      // The remote git data plane behind the better-sidebar 'gitSource' slot
      // (v0.23.0): every git surface of a remote session — GitView panel,
      // explorer git-status decorations, diff tabs — funnels here, one op per
      // host `git.*` route the source shadows. `dir` is a REMOTE absolute
      // path (the client resolves worktree → scope.repoRoot → mirror-mapped
      // session cwd), and the owning machine's route pool serves the commands
      // (routePoolOf — multi-machine isolation included). Results are the
      // same shapes the host sidebar returns, porcelain-parsed in
      // lib/git-parse.js.
      kind: 'exact',
      path: '/dsh-remote/git',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        let body = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch { /* empty body → unknown op */ }
        const op = String(body.op || '')
        try {
          const dir = normalizeRemotePath(String(body.dir || ''))
          if (!dir || dir === '/') return sendJson(res, 400, { ok: false, error: 'dir is required' })
          const { pool: rp, machine: routeMachine } = await routePoolOf(dir)
          const machineTag = gitMachineTag(routeMachine)
          const selected = typeof body.repoRoot === 'string' && body.repoRoot !== '' ? body.repoRoot : undefined
          const value = await gitOpHandlers(rp, dir, selected, machineTag, op, body)
          return sendJson(res, 200, value)
        } catch (err) {
          const msg = String((err && err.message) || err)
          console.error('[dsh-remote] git ' + op + ' failed (' + String(body.dir || '') + '):', msg)
          const cls = classifyError(err, { host: null, port: null })
          return sendJson(res, 500, { ok: false, error: msg, credential: cls.category === 'credentials' })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/workspace',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { error: 'path must be an absolute directory' })
// Per-workspace binding: the client sends its session workspace
          // (`payload.workspace`) and optionally the picked machine
          // (`payload.machine`, for the workspace picker); fall back to the
          // first live session cwd.
          const localWs = typeof payload.workspace === 'string' && payload.workspace.trim()
            ? payload.workspace.trim()
            : callerCwdOf(null)
          let ctx = ctxForCwd(localWs)
          if (payload.machine) {
            const i = machineIndex(String(payload.machine || ''))
            if (i < 0) return sendJson(res, 400, { ok: false, error: 'machine not saved in the registry' })
            const rec = machines[i]
            wsSelSet(wsKeyOf(localWs), { machineId: rec.id, workspace: rec.workspace || '', explicitNone: false })
            ctx = { ...ctxForCwd(localWs), host: rec.host, port: Number(rec.port) || 22, username: rec.username || 'root', machineId: rec.id, machine: rec }
          }
          if (!ctx || !ctx.host || !ctx.machine) {
            return sendJson(res, 400, { ok: false, error: 'no remote machine is bound to workspace ' + (localWs || '<unknown>') + ' — set a current machine for it first (settings) or rw_connect' })
          }
          const pool = await machinePoolOf(ctx.machine)
          let okDir
          try { okDir = await isRemoteDirOn(pool, p) } catch { okDir = false }
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory on ${ctx.host}: ${p}` })
          persistWorkspace(p, localWs)
                    const local = ensureMirror(p, ctx, { alias: ctx.machine ? (ctx.machine.useSshConfig ? ctx.machine.host : (ctx.machine.alias || '')) : '' })
                    startAutoPush(local)
                    return sendJson(res, 200, { ok: true, workspace: p, localMirror: local, ...status(localWs) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/mirror',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path must be an absolute directory' })
          const localWs = typeof payload.workspace === 'string' && payload.workspace.trim()
            ? payload.workspace.trim()
            : ''
          let ctx = ctxForCwd(localWs)
          if (payload.machine) {
            const i = machineIndex(String(payload.machine || ''))
            if (i < 0) return sendJson(res, 400, { ok: false, error: 'machine not saved in the registry' })
            const rec = machines[i]
            ctx = { ...ctxForCwd(localWs), host: rec.host, port: Number(rec.port) || 22, username: rec.username || 'root', machineId: rec.id, machine: rec }
          }
          if (!ctx || !ctx.host || !ctx.machine) {
            return sendJson(res, 400, { ok: false, error: 'no remote machine is bound to workspace ' + (localWs || '<unknown>') + ' — connect first' })
          }
          const pool = await machinePoolOf(ctx.machine)
          let okDir
          try { okDir = await isRemoteDirOn(pool, p) } catch { okDir = false }
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
const local = ensureMirror(p, ctx, { alias: ctx.machine ? (ctx.machine.useSshConfig ? ctx.machine.host : (ctx.machine.alias || '')) : '' })
          persistWorkspace(p, local)
          startAutoPush(local)
          return sendJson(res, 200, { ok: true, path: p, localMirror: local, ...status(local) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-pick',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          let outcome = null
          let via = 'service'
          const cap = await localPickCapability()
          if (cap && cap.kind === 'native' && typeof cap.pick === 'function') {
            try {
              const pickAbort = new AbortController()
              const p = await Promise.resolve(cap.pick(pickAbort.signal || null))
              pickAbort.abort()
              outcome = (typeof p === 'string' && p) ? { path: p } : { cancelled: true }
            } catch (err) {
              outcome = null
            }
          }
          // Prefer a REAL OS dialog over the browse backend: operators expect
          // an Explorer-style chooser, and the own spawn (PowerShell
          // FolderBrowserDialog / osascript / zenity-kdialog) works even where
          // the host mounted browse — DSH Desktop (Electron) deliberately
          // mounts browse on win32 because the native backend's koffi dialog
          // worker cannot run under Electron, but a plain child process can.
          if (!outcome) {
            via = 'own'
            try {
              outcome = await pickLocalNative()
            } catch (err) {
              // No usable OS dialog (headless host, missing chooser binary):
              // fall back to the host's browse capability — fs-only, works
              // display-less — served as an in-app browser by the client
              // (backed by /dsh-remote/local-list + /dsh-remote/local-mkdir).
              if (cap && cap.kind === 'browse' && typeof cap.list === 'function') {
                return sendJson(res, 200, { ok: true, kind: 'browse', via: 'browse' })
              }
              return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) + ' — 可直接在输入框填本地路径' })
            }
          }
          if (outcome.cancelled) return sendJson(res, 200, { ok: true, cancelled: true, via })
          return sendJson(res, 200, { ok: true, path: outcome.path, via })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.list !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法列出本机目录' })
          const m = (req.url || '').match(/path=([^&]*)/)
          const raw = m ? decodeURIComponent(m[1]) : ''
          // No path → the browse backend lists the host home directory.
          try {
            const out = await Promise.resolve(cap.list(raw ? raw : undefined))
            return sendJson(res, 200, { ok: true, ...out, drives: listLocalDrives() })
          } catch (listErr) {
            return sendJson(res, 400, { ok: false, error: String((listErr && listErr.message) || listErr), code: (listErr && listErr.code) || 'directory-unreadable' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-mkdir',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.createDirectory !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法新建文件夹' })
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = String(payload.path || '')
          const name = String(payload.name || '')
          if (!p.trim() || !name.trim()) return sendJson(res, 400, { ok: false, error: 'path and name required' })
          try {
            const created = await Promise.resolve(cap.createDirectory(p, name))
            return sendJson(res, 200, { ok: true, path: created })
          } catch (mkErr) {
            return sendJson(res, 400, { ok: false, error: String((mkErr && mkErr.message) || mkErr), code: (mkErr && mkErr.code) || 'directory-create-failed' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/machines',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { machines: machinesForClient(), currentId: store.currentId })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const action = body.action || 'add'
            let warning = ''
            let warningDetail = ''
            if (action === 'add' || action === 'update') {
              const host = String(body.host || '').trim()
              if (!host) return sendJson(res, 400, { ok: false, error: 'host required' })
              const id = body.id || machineId()
              const i = machineIndex(id)
              const prev = i >= 0 ? machines[i] : null
              const credBackend = body.credentialBackend === 'plain' ? 'plain'
                : (body.encryptPassword ? platformBackend() : (prev && prev.credentialBackend ? prev.credentialBackend : 'plain'))
              const rec = {
                id,
                name: String(body.name || '').trim() || host,
                host,
                // Issue #38: an ALIAS machine stores only the Host line of
                // ~/.ssh/config — HostName/user/port/key are resolved live at
                // every connect instead of being copied into the registry.
                useSshConfig: !!body.useSshConfig,
                port: Number(body.port) || 22,
                username: String(body.username || '').trim() || 'root',
                password: '',
                privateKeyPath: String(body.privateKeyPath || '').trim(),
                passphrase: body.passphrase || '',
                workspace: String(body.workspace || '').trim(),
                hostKeyMode: body.hostKeyMode || '',
                useAgent: !!body.useAgent,
                keyboardInteractive: !!body.keyboardInteractive,
                proxy: body.proxy && body.proxy.host ? {
                  host: String(body.proxy.host),
                  port: Number(body.proxy.port) || 22,
                  username: String(body.proxy.username || '').trim(),
                  password: String(body.proxy.password || ''),
                  privateKeyPath: String(body.proxy.privateKeyPath || '').trim(),
                } : undefined,
                credentialBackend: credBackend,
                recentWorkspaces: prev && prev.recentWorkspaces ? prev.recentWorkspaces : [],
                lastConnectedAt: prev && prev.lastConnectedAt ? prev.lastConnectedAt : null,
                latencyMs: prev && prev.latencyMs ? prev.latencyMs : null,
              }
              if (body.password) {
                // Issue #30: `saveSecret()` is best-effort — the old code threw
                // its result away and kept `password: ''`, so on Windows (DPAPI
                // missing the System.Security assembly) the machine was saved
                // WITHOUT any credential and every later connect failed with no
                // visible reason. Now a failed OS-store write falls back to
                // plaintext and is reported to the UI.
                const persisted = await persistPassword({
                  backend: credBackend,
                  machineId: id,
                  password: body.password,
                  secretsDir: secretsDir(),
                })
                rec.credentialBackend = persisted.credentialBackend
                rec.password = persisted.password
                if (persisted.warning) {
                  warning = persisted.warning
                  warningDetail = persisted.error
                }
              } else if (prev && prev.password) {
                rec.password = prev.password
              }
              if (i >= 0) machines[i] = rec; else machines.push(rec)
              // Issue #13: saving a machine must NOT make it the active
              // remote context. `currentId` stays untouched on add/update —
              // only an explicit "设为当前" (or rw_connect) activates one.
              // keepCurrentKey:false leaves the stored `currentId` byte-for-byte
              // alone, so a fresh registry stays "no choice yet" (not an
              // explicit none) and a previously-cleared registry stays cleared.
              saveMachines(machines, store.currentId, false)
              return sendJson(res, 200, {
                ok: true,
                machine: sanitizeMachine(rec),
                machines: machinesForClient(),
                currentId: store.currentId,
                ...(warning ? { warning, warningDetail } : {}),
              })
            }
            if (action === 'delete') {
              const i = machineIndex(String(body.id || ''))
              if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
              const m = machines[i]
              if (m.credentialBackend && m.credentialBackend !== 'plain') {
                await deleteSecret(m.id, secretsDir()).catch(() => {})
              }
              machines.splice(i, 1)
              // Per-workspace isolation: deleting a machine must also purge /
              // neutralize every per-workspace selection that referenced it —
              // a stale selection must never re-activate a ghost machine.
              let dropped = false
              for (const k of Object.keys(store.workspaces || {})) {
                const sel = store.workspaces[k]
                if (sel && sel.machineId === m.id) {
                  store.workspaces[k] = sel.explicitNone
                    ? { machineId: '', workspace: '', explicitNone: true }
                    : null
                  if (!store.workspaces[k]) delete store.workspaces[k]
                  dropped = true
                }
              }
for (const [k, sel] of wsEphemeral) {
                if (sel && sel.machineId === m.id) wsEphemeral.delete(k)
              }
              if (store.currentId === m.id) {
                // Legacy informational key only (never drives activation).
                store.currentId = null
              }
              saveMachines(machines, store.currentId, true, store.workspaces)
              // Drop any dedicated pool that may hold this machine's connection.
              const tag = m.host + ':' + (Number(m.port) || 22) + ':' + (m.username || 'root')
              const entry = routePools.get(tag)
              if (entry) { try { entry.pool.close() } catch {}; routePools.delete(tag) }
              return sendJson(res, 200, { ok: true, machines: machines.map(sanitizeMachine), currentId: store.currentId, purgedWorkspaces: dropped })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/test-connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Issue #30: `body` lives OUTSIDE the try — a try-scoped `const` is
        // invisible in catch, so the old catch threw `ReferenceError: body is
        // not defined` and the probe result never reached the UI (the webserver
        // answered with an empty 400 for every kind of failure). This route is a
        // probe: every outcome is a 200 carrying {ok:false, error}.
        let body = {}
        try {
          body = parseJsonObject(await readBody(req))
          // Issue #38: "test" on an ssh-config ALIAS resolves the alias first —
          // the form holds the alias name, not the host it points at.
          const aliasTarget = body.useSshConfig
            ? resolveMachineSshConfig({
                host: String(body.host || ''),
                port: Number(body.port) || 22,
                username: String(body.username || ''),
                privateKeyPath: String(body.privateKeyPath || ''),
                proxy: body.proxy,
                useSshConfig: true,
              }, { text: sshConfigText() })
            : null
          const probe = new SshPool({
            ...config,
            host: aliasTarget ? aliasTarget.host : String(body.host || config.host),
            port: aliasTarget ? aliasTarget.port : (Number(body.port) || config.port),
            username: aliasTarget ? aliasTarget.username : String(body.username || config.username),
            password: String(body.password || ''),
            privateKeyPath: aliasTarget ? aliasTarget.privateKeyPath : String(body.privateKeyPath || config.privateKeyPath),
            passphrase: String(body.passphrase || ''),
            proxy: aliasTarget && aliasTarget.proxy ? aliasTarget.proxy : (body.proxy && body.proxy.host ? {
              host: String(body.proxy.host),
              port: Number(body.proxy.port) || 22,
              username: String(body.proxy.username || ''),
              password: String(body.proxy.password || ''),
              privateKeyPath: String(body.proxy.privateKeyPath || ''),
            } : undefined),
            connectTimeoutMs: Math.min(Math.max(Number(body.connectTimeoutMs) || config.connectTimeoutMs, 2000), 30000),
            commandTimeoutMs: 10000,
          }, { knownHostsFile })
          const started = Date.now()
          await probe.connect()
          await probe.exec('true', { timeoutMs: 10000 })
          probe.close()
          const latencyMs = Date.now() - started
          // Alias-aware: the probe connects to the RESOLVED host, while the
          // registry stores the alias, so matching must go through the identity.
          const mi = machines.findIndex((m) => identityMatches(m, { host: probe.config.host, port: probe.config.port, username: probe.config.username }))
          if (mi >= 0) {
            machines[mi].lastConnectedAt = new Date().toISOString()
            machines[mi].latencyMs = latencyMs
            saveMachines(machines, store.currentId)
          }
          return sendJson(res, 200, {
            ok: true,
            host: probe.config.host,
            user: probe.config.username,
            latencyMs,
            lastConnectedAt: new Date().toISOString(),
            platform: probe.platform,
            shell: probe.shellMode,
            gitBash: probe.gitBashPath || '',
            // Issue #38: tell the settings page where an alias resolved to (and
            // anything the plugin could not honour, e.g. a multi-hop ProxyJump).
            alias: aliasTarget ? { name: aliasTarget.alias, host: aliasTarget.host, port: aliasTarget.port, user: aliasTarget.username, warnings: aliasTarget.warnings } : null,
          })
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: friendlyMessage(err, { host: body.host, port: body.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/current',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = String(body.id || '').trim()
          // Per-workspace isolation: "设为当前" binds a machine to ONE local
          // workspace dir (the settings page sends its session's workspace).
          // There is no app-wide current anymore.
          const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
          if (!workspace) {
            return sendJson(res, 400, { ok: false, error: 'workspace is required — the current machine is bound per workspace' })
          }
          const k = wsKeyOf(workspace)
          if (!id) {
            // Explicit "this workspace has no remote" — saved machines stay in
            // the registry (issue #13) but nothing binds to this workspace.
            wsSelSet(k, { machineId: '', workspace: '', explicitNone: true })
            return sendJson(res, 200, { ok: true, currentId: null, ...status(k) })
          }
          const i = machineIndex(id)
          if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
          wsSelSet(k, { machineId: id, workspace: machines[i].workspace || '', explicitNone: false })
          return sendJson(res, 200, { ok: true, ...status(k) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forget-key',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        createHostKeyGuard(config, knownHostsFile()).forgetHost()
        return sendJson(res, 200, { ok: true, ...status() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forwards',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { forwards: forwards.list() })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const action = String(body.action || '')
          if (action === 'define') {
            const d = forwards.define({
              direction: body.direction === 'reverse' ? 'reverse' : 'local',
              listenPort: Number(body.listenPort),
              targetHost: body.targetHost || '127.0.0.1',
              targetPort: Number(body.targetPort) || Number(body.listenPort),
              autoStart: !!body.autoStart,
              machineId: store.currentId,
            })
            return sendJson(res, 200, { ok: true, forward: d, forwards: forwards.list() })
          }
          if (action === 'start' || action === 'stop') {
            const d = forwards.list().find((f) => f.id === body.id)
            if (!d) return sendJson(res, 404, { ok: false, error: 'forward not found' })
            if (action === 'start') {
              const r = await forwards.start(d)
              if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
            } else {
              forwards.stop(d.id)
            }
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          if (action === 'remove') {
            forwards.remove(String(body.id || ''))
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown action' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/task',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const id = q.get('id') || ''
          const t = tasks.get(id)
          if (!t) return sendJson(res, 404, { ok: false, error: 'task not found' })
          return sendJson(res, 200, { ok: true, task: t })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const id = String(body.id || '')
            if (body.action === 'cancel') {
              const ok = tasks.cancel(id)
              return sendJson(res, 200, { ok, task: tasks.get(id) })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/tasks',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, tasks: tasks.list() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/audit',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const q = new URL(req.url, 'http://localhost').searchParams
        return sendJson(res, 200, { ok: true, auditEnabled: !!config.auditLog, file: auditFile(), lines: readAudit(q.get('limit')) })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ssh-config',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const text = readSshConfigText()
          return sendJson(res, 200, { ok: true, file: sshConfigPath(), present: !!text, entries: importableEntries(text) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/home',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          // Machine-scoped (picker may target a machine with no mirror yet).
          let rp = pool
          if (body.machine) {
            const i = machineIndex(String(body.machine || ''))
            if (i < 0) return sendJson(res, 200, { ok: true, home: null, error: 'machine not saved' })
            rp = await machinePoolOf(machines[i])
          }
          const out = await rp.exec('echo ~', { timeoutMs: Math.min(config.commandTimeoutMs, 5000) })
          const home = String(out.stdout || '').replace(/\s+/g, '').trim()
          if (!home) return sendJson(res, 200, { ok: true, home: null, hint: 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径' })
          return sendJson(res, 200, { ok: true, home })
        } catch (err) {
          return sendJson(res, 200, { ok: true, home: null, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-check',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const current = readVersion()
        const latest = await fetchLatestVersion()
        if (latest === null) return sendJson(res, 200, { ok: false, current, error: '无法连接 npm registry' })
        const rawMode = readUpdateMode() || config.updateMode || 'manual'
        return sendJson(res, 200, {
          ok: true,
          current,
          latest,
          updateAvailable: gtVersion(latest, current),
          updateMode: ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : 'manual',
          updatedMarker: existsSync(path.join(selfDir(), '.dsh-remote-updated')),
        })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const target = String(body.version || '')
          if (!target) return sendJson(res, 400, { ok: false, error: 'version is required' })
          const result = await applyUpdate(target)
          return sendJson(res, 200, { ok: true, from: readVersion(), ...result })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-mode',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const mode = String(body.mode || '')
          if (!['manual', 'auto', 'off'].includes(mode)) return sendJson(res, 400, { ok: false, error: 'mode must be manual | auto | off' })
          if (!persistUpdateMode(mode)) return sendJson(res, 500, { ok: false, error: 'cannot persist mode' })
          return sendJson(res, 200, { ok: true, mode })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  {
      kind: 'exact',
      path: '/dsh-remote/terminal/status',
      handler: (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const ws = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
        return sendJson(res, 200, {
          ok: true,
          enabled: !!(ws && typeof ws.registerUpgrade === 'function'),
          maxSessions: config.terminalMaxSessions,
          graceMs: config.terminalReconnectGraceMs,
          sessions: terminals.list(),
        })
      },
    },
  ]

  registerHttpTransports(ctx, routes)
  // Hosts without `ctx.inject` (bare loaders / test harnesses): register the
  // routes synchronously when webServer is already present. With inject the
  // reactive path above owns registration, so never double-register.
  if (typeof ctx.inject !== 'function') {
    const wsRoute = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
    if (wsRoute && typeof wsRoute.register === 'function') {
      const disposers = routes.map((r) => wsRoute.register(r))
      ctx.effect(() => () => disposers.forEach((d) => d && d()), 'dsh-remote.routes')
    }
  }

  // ── remote terminal WebSocket upgrade (/dsh-remote/ws/terminal) ───────────
  // One dedicated SSH connection per session (SshPool.openPty), so terminal
  // shells survive rw_exec pool reconnects. Frame protocol: see lib/terminal.js.
  // Registered reactively: webServer may arrive AFTER apply() runs (it is not
  // a hard dependency of the plugin — only the terminal surface needs it).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (inner) => {
      const webServer = inner.get('webServer')
      if (!webServer || typeof webServer.registerUpgrade !== 'function') return
      const ttyWs = new WebSocketServer({ noServer: true })
      inner.effect(() => webServer.registerUpgrade({
        path: '/dsh-remote/ws/terminal',
        handler: (req, socket, head) => {
          if (!trustedWsUpgrade(req)) {
            socket.destroy()
            return
          }
          ttyWs.handleUpgrade(req, socket, head, (ws) => {
            const q = new URL(req.url, 'http://localhost').searchParams
            const params = {
              sid: q.get('sid') || '',
              resume: q.get('resume') || '',
              // machine = the registry id of the workspace's machine (mirror
              // owner or per-workspace selection); '' = shared pool (legacy).
              machine: q.get('machine') || '',
              cwd: q.get('cwd') || '',
              cols: Number(q.get('cols')) || 80,
              rows: Number(q.get('rows')) || 24,
              term: q.get('term') || '',
            }
            try {
              // Workspace/session validation: the terminal opens only for a
              // session whose cwd is a validated MIRROR with a saved machine —
              // never for a local session or an arbitrary host selection.
              const sessionCwd = sessionCwdOf(q.get('sessionId'))
              const hint = q.get('workspace') || ''
              if (sessionCwd && hint && path.resolve(sessionCwd) !== path.resolve(hint)) throw new Error('terminal workspace does not match session')
              const local = sessionCwd || hint
              const owner = ctxForCwd(local)
              if (owner.source !== 'mirror' || !owner.machineId || !owner.workspace) {
                throw new Error('remote terminal requires a valid remote mirror workspace with a saved machine')
              }
              if (params.machine && params.machine !== owner.machineId) throw new Error('terminal machine does not match workspace')
              params.machine = owner.machineId
              params.cwd = owner.workspace
              params.scope = owner.mirrorDir
              params.resume = JSON.stringify([owner.mirrorDir, owner.machineId, params.resume])
              terminals.attach(ws, params)
            } catch (err) {
              terminals.refuse(ws, String((err && err.message) || err))
            }
          })
        },
      }), 'dsh-remote.terminal-ws')
    })
  }


  // ── auto-update: check on load + on an interval; apply silently ───────────
  // Failures are swallowed (never break the plugin). The persisted override
  // (settings UI) wins over the profile-config default.
  const rawMode = readUpdateMode() || config.updateMode || 'manual'
  const effectiveUpdateMode = ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : 'manual'
  if (effectiveUpdateMode === 'auto') {
    const currentVersion = readVersion()
    const checkAndApply = async () => {
      const latest = await fetchLatestVersion()
      if (latest && gtVersion(latest, currentVersion)) {
        try { await applyUpdate(latest) } catch {}
      }
    }
    void checkAndApply()
    const updateTimer = setInterval(checkAndApply, Math.max(config.updateCheckIntervalMs, 60000))
    if (typeof updateTimer.unref === 'function') updateTimer.unref()
    ctx.effect(() => () => clearInterval(updateTimer), 'dsh-remote.update-timer')
  }
}
