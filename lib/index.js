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
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, appendFileSync, watch, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'

import {
  shq, normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs,
  toShellPath, toDisplayPath, remotePathBase, truncate, shortHash,
} from './paths.js'
import { createHostKeyGuard, isHostKeyKnown as _isHostKeyKnown } from './hostkey.js'
import { compileIgnore, DEFAULT_IGNORE, DEFAULT_SEARCH_IGNORE } from './ignore.js'
import {
  parseStatusV1, parseWorktreeList, parseLogGraphLines, parseForEachRefPairs, parseLeftRightCount, countStatusLines,
  buildWorkspaceMarker,
  isLogRootHash, logPagingGuard, encodeLogCursor, decodeLogCursor, isSafeGitShowPath, buildLogPage,
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
import { ManagedTerminalManager } from './managed-terminal.js'
import { resolveManagedOwner, managedTerminalRoutes, attachManagedTerminal } from './managed-terminal-routes.js'
import { pickMirrorForRemotePath, machineForMirror } from './route-machine.js'
import { createRemoteOpenProvider } from './remote-open.js'
import { trustedWsUpgrade } from './upgrade-trust.js'
import { WebSocketServer } from 'ws'
import { WebAttach } from './web-attach.js'
import {
  buildProbeCommand, parseProbe, judgeProbe, buildInstallPlan,
  resolvePrefix, stepResult, DEFAULT_INSTALL_VERSION,
} from './web-deploy.js'
import { registerDeploySkill, buildInvestigatePrompt, SKILL_NAME } from './web-deploy-skill.js'
import { selfDir, diskVersion, LOADED_VERSION, gtVersion, fetchLatestVersion, applyUpdate, persistUpdateMode, readUpdateMode, reloadSelf, scheduleSelfReload, isInstalledCopy } from './update.js'
import { sendHeartbeat, pseudonym, heartbeatUrl, hasPersistedId, installIdPath } from './telemetry.js'
import { loadMachines as _loadMachines, saveMachines as _saveMachines, sanitizeMachine as _sanitizeMachine, applyMachine as _applyMachine, machineId as _machineId } from './registry.js'
import { registerHttpTransports, guardRoute } from './http-transport.js'
import { SshPool } from './pool.js'
import { createFsRoutes } from './routes-fs.js'
import { listDirStructured, removeRemoteTree } from './remote-fs.js'
import { connectMachine, providerForMachine, providerOf, registerProvider } from './provider.js'
// Provider 注册层：供外部传输插件（如 dsh-remote-vscode）注册与使用（ADR-0002）。
export { registerProvider, providerIds, providerOf, providerForMachine, validateMachineRecord, sanitizeMachineRecord, connectMachine } from './provider.js'

export const name = 'dsh-remote'

/** Update mode used when neither the persisted `update-mode` file nor the
 *  profile config supplies one.
 *
 *  Kept as one exported constant on purpose: the value appears in the schema
 *  default, in the `/update-check` response and in the auto-update gate, and
 *  three hard-coded copies drift (the first version of this change left two
 *  `|| 'manual'` fallbacks that quietly disagreed with the new schema default).
 *  Changing the default must change exactly one place. */
export const DEFAULT_UPDATE_MODE = 'auto'

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
  /** Cooperative budget (ms) for `rw_search`; also declared as the tool's
   *  `timeoutMs` so @deepseek-ai/dsh-tool-call-timeout-policy can end a call
   *  that overruns. The search itself stops at this budget and returns partial
   *  results (issue #44: an unbounded walk over a home directory could never be
   *  stopped and left the turn `running` forever). */
  searchTimeoutMs: z.number().step(1).min(1000).default(60000),
  /** Max files `rw_search` will stat/read before returning partial results. */
  searchMaxEntries: z.number().step(1).min(1).default(50000),
  /** Update mode: `auto` (default) checks on load and periodically, applies a
   * newer npm release automatically, then hot-swaps the host half (see
   * `updateAutoReload`); `manual` only checks when the user asks; `off` disables
   * version checks entirely. (schemastery 3.18 has no .enum — keep string and
   * validate in code.)
   *
   * `auto` became the default in 0.8.27. It could not have been a safe default
   * before 0.8.24: an update only replaced files on disk and needed a restart,
   * which left users running a new browser half against an old host half with no
   * visible signal. 0.8.24 added the hot swap (and `pendingReload` when it is
   * turned off), so an unattended update now actually takes effect. */
  updateMode: z.string().default(DEFAULT_UPDATE_MODE),
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
  /** Whether a landed update also hot-swaps the running host half (default
   *  true). With `false` an update only takes effect on the next process start
   *  and `/dsh-remote/update-check` reports `pendingReload: true` meanwhile. */
  updateAutoReload: z.boolean().default(true),
  /** First local port tried when attaching a remote DSH Web UI (issue #46).
   *  The listener is loopback-only; consecutive ports are tried when this one
   *  is taken. */
  webAttachPortStart: z.number().step(1).min(1).max(65535).default(3088),
  /** Remote command that starts a `dsh web` on the attached machine. Only needs
   *  changing when the remote's `dsh` is not on the SSH login PATH (e.g. a
   *  version installed into a private prefix). */
  webAttachCommand: z.string().default('dsh'),
  /** `DSH_HOME` to export on the remote when attaching. Empty reuses the
   *  remote user's own harness home; point it at a scratch directory to keep an
   *  attached instance out of the user's real sessions and settings. */
  webAttachDshHome: z.string().default(''),
  /** How long (seconds) to wait for a freshly started remote `dsh web` to print
   *  its startup token before giving up. */
  webAttachWaitSeconds: z.number().step(1).min(5).max(300).default(45),
  /** Where an automatic deployment installs dsh on the remote. Empty means
   *  `$HOME/.dsh-remote/dsh` (persistent, needs no write access to any system
   *  prefix, and never replaces a dsh the user already has). */
  webInstallPrefix: z.string().default(''),
  /** Version an automatic deployment installs. The default is the first release
   *  whose node-pty ships Linux prebuilds — older ones cannot boot `dsh web` on
   *  Linux at all. */
  webInstallVersion: z.string().default(DEFAULT_INSTALL_VERSION),
  /** npm registry to install from. Empty uses the remote's own npm config, which
   *  is what an internal mirror needs to stay in effect. */
  webInstallRegistry: z.string().default(''),
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

/** Stable mirror-root tag for a vscode-tunnel origin. Tunnel machines all
 *  record the SAME placeholder host/port/username (127.0.0.1 / 0 / ''), so a
 *  host-user-port key would collide every tunnel machine into one shell — and
 *  the port is a dynamic local forward, not a machine identity. Key by the
 *  STABLE machine id instead (sanitize like mirrorRootFor: anything outside
 *  [a-zA-Z0-9._-] becomes '_'; missing id → 'tunnel-unknown'). */
function tunnelMirrorTag(machineId) {
  const id = String(machineId || '').trim()
  return 'tunnel-' + (id ? id.replace(/[^a-zA-Z0-9._-]/g, '_') : 'unknown')
}

/** Local mirror dir for a specific remote path (idempotent → returns same dir).
 *  ctx = { host, username, port, transport?, machineId?, remoteIdentity? }.
 *  vscode-tunnel origins are keyed by `tunnel-<machineId>` (see
 *  tunnelMirrorTag) — the host/port/user triple is NEVER used for them; SSH
 *  origins keep the legacy `<host>-<user>-<port>` layout bit for bit. */
function mirrorDirFor(remotePath, { host, username: user, port, transport, machineId }) {
  const base = remotePathBase(remotePath)
  const root = transport === 'vscode-tunnel'
    ? path.join(remoteWorkspacesRoot(), tunnelMirrorTag(machineId))
    : mirrorRootFor(host, user, port)
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
*  ctx = { host, username, port, transport?, machineId?, remoteIdentity? }.
 *  SSH origins (no transport, or 'ssh') write the legacy v1 meta (with the
 *  `alias` recorded for issue #38 machines). vscode-tunnel origins write
 *  mirror meta v2: { schemaVersion: 2, transport, machineId, remoteIdentity?,
 *  host, port, username, remotePath, createdAt } — port/username are the RAW
 *  record values (0 / '' for the tunnel placeholder), never SSH-normalized. */
function ensureMirror(remotePath, ctx, extra = {}) {
  const { host, username: user, port, transport } = ctx || {}
  const dir = mirrorDirFor(remotePath, ctx)
  mkdirSync(dir, { recursive: true })
  const norm = normalizeRemotePath(remotePath)
  if (transport === 'vscode-tunnel') {
    const remoteIdentity = ctx.remoteIdentity
    writeFileSync(
      path.join(dir, '.dsh-remote-meta.json'),
      JSON.stringify({
        schemaVersion: 2,
        transport: 'vscode-tunnel',
        machineId: String(ctx.machineId || ''),
        ...(remoteIdentity ? { remoteIdentity } : {}),
        host,
        port,
        username: user,
        remotePath: norm,
        createdAt: new Date().toISOString(),
      }, null, 2),
    )
    return dir
  }
  const meta = { host, port, username: user, remotePath: norm, createdAt: new Date().toISOString() }
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
          // Mirror meta v2 (transport !== 'ssh'): the placeholder port is 0 —
          // skip the ssh 1..65535 validation for it; v1 validation unchanged.
          const transport = typeof meta.transport === 'string' && meta.transport && meta.transport !== 'ssh'
            ? meta.transport : undefined
          const port = Number(meta.port ?? 22)
          if (!transport && (!Number.isInteger(port) || port < 1 || port > 65535)) continue
          const entry = { mirrorDir, host: meta.host, port, username: meta.username || 'root', remotePath: meta.remotePath }
          // Transport identity rides along when the meta carries it (passthrough,
          // no defaults), so routePoolOf / git-workspace / reconnect can route
          // tunnel mirrors by stable machine id (machineForMirror).
          if (transport) {
            entry.transport = transport
            if (typeof meta.machineId === 'string' && meta.machineId) entry.machineId = meta.machineId
          }
          out.push(entry)
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
const saveMachines = (list, currentId, keepCurrentKey, workspaces) => _saveMachines(machinesFile(), list, currentId, keepCurrentKey, workspaces)
const sanitizeMachine = _sanitizeMachine
const applyMachine = _applyMachine
const machineId = _machineId

// ── host-key registry (TOFU) ──────────────────────────────────────────────
const KNOWN_HOSTS_FILE = 'known_hosts.json'
const knownHostsFile = () => path.join(remoteWorkspacesRoot(), KNOWN_HOSTS_FILE)
const isHostKeyKnown = (host, port) => _isHostKeyKnown(knownHostsFile(), host, port)

/** Live-read of the web runtime's trusted authorities for the terminal WS
 *  fence (`webRuntime.trustedHosts` — LAN IP literals sampled at boot plus
 *  `--trusted-host` entries; the SAME trust source the /api gateway and
 *  better-sidebar fences use). Read per request so the fence tracks the
 *  deployment's authority list like its peers; absent service (bare
 *  loaders / test harnesses) → [] keeps the loopback-only default. Each
 *  read is guarded independently: get() may throw for non-injected
 *  services, and the fallback must still be attempted. */
function runtimeTrustedHosts(inner, outer) {
  let w = null
  if (inner && typeof inner.get === 'function') {
    try { w = inner.get('webRuntime') } catch {}
  }
  if (!w && outer && typeof outer.get === 'function') {
    try { w = outer.get('webRuntime') } catch {}
  }
  return (w && Array.isArray(w.trustedHosts)) ? w.trustedHosts : []
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

  // ── 内建 SSH provider 注册（Step2，ADR-0002）──────────────────────────────
  // 只做元数据与契约声明：SSH 的实际连接/池化/exec/sftp 仍走下方既有
  // SshPool 路径（machinePoolOf 对 transport==='ssh' 不进入 provider 分派，
  // 见 B 段），本注册不得改变任何 SSH 运行行为。
  // 幂等：provider.js 注册表是模块级单例，而 apply() 在一个进程内可能被多次
  // 调用（热重载 / 测试多实例），重复注册会抛 'already registered' —— 已注册
  // 即跳过（声明内容一致，跳过无行为差异）。
  if (!providerOf('ssh')) {
    registerProvider({
      id: 'ssh',
      apiVersion: 1,
      label: 'SSH',
      validateMachine: (m) => {
        if (!m || !m.host) throw new Error('machine.host required for ssh')
      },
      sanitizeMachine: (m) => ({ ...m }), // 默认透传；密码类由 provider.js 统一剥除
      connect: async ({ machine }) => {
        // 惰性接入层句柄：不在此建连（connect 仅声明“接入层概念形状”）；真实
        // 连接与池化仍由 machinePoolOf/SshPool 机制负责。
        // 概念形状：{ identity, capabilities, status, fs, exec, jobs, close }
        //   fs  = 复用 pool.sftp()（鸭子类型满足 readdir/stat/readFile/writeFile/mkdir）
        //   exec = (command, opts) => pool.exec(command, opts)（SSH 路径完全保持原语义）
        //   close = () => pool.close()
        return {
          identity: { machineId: machine.id, transport: 'ssh' },
          capabilities: { fs: true, exec: true, pty: false /* v1 保持原路径，pty 由 terminal.js 处理 */ },
          status: () => ({ connected: false }),
          fs: null, exec: null, jobs: null,
          close: () => {},
        }
      },
    })
  }

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
      // 只走 ctx.get（铁律：属性形式在未声明 inject 时抛 without inject）。
      const loader = (ctx && typeof ctx.get === 'function' ? ctx.get('loader') : null) || null
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

  // ── 安装心跳（日活统计）─────────────────────────────────────────────────
  // 旁路：不 await、不阻塞加载、失败静默（见 lib/telemetry.js 的隐私与失败策略）。
  // 无配置开关（按作者要求默认开启）；上报的是本插件专属 HMAC 伪名，
  // 原始安装 id 与任何机器信息都不离开本机。
  void sendHeartbeat(dshBase(), LOADED_VERSION)

  // The update marker means "a newer version landed on disk but is not the code
  // running yet". Reaching apply() with a marker naming the version we just
  // loaded means the swap already happened (or this is a plain boot into the
  // updated files) → clear it, so the UI's "restart to finish" hint stays true.
  try {
    const marker = path.join(selfDir(), '.dsh-remote-updated')
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === LOADED_VERSION) rmSync(marker, { force: true })
  } catch {}

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
  /**
   * The `dsh` command to use for a machine's Web UI attach.
   *
   * Resolution order is deliberate: a PER-MACHINE value recorded by a completed
   * deployment wins, then the global config default. Without the per-machine
   * branch, deploying on one host would point every other host at a binary that
   * only exists on that one.
   *
   * @param {object} machine - a registry record (may be undefined).
   * @returns {string} the command to run on that machine.
   */
  const webAttachCommandFor = (machine) => {
    const perMachine = machine && typeof machine.webAttachCommand === 'string' ? machine.webAttachCommand.trim() : ''
    return perMachine || String(config.webAttachCommand || 'dsh')
  }

  /**
   * Record the dsh command a deployment produced, on that machine.
   *
   * Persisted through the same registry helper every other machine edit uses, so
   * the value survives a restart and appears in the settings UI like any other
   * field. `keepCurrentKey: false` preserves whichever machine is current —
   * deploying must never silently switch the user's active machine.
   *
   * @param {object} machine - the registry record to update.
   * @param {string} command - the working dsh command.
   */
  const persistWebAttachCommand = (machine, command) => {
    try {
      const i = machineIndex(machine.id)
      if (i < 0) return
      machines[i] = { ...machines[i], webAttachCommand: String(command || '') }
      saveMachines(machines, store.currentId, false, store.workspaces)
    } catch { /* a failed persist only costs a re-deploy next time */ }
  }


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
      // Strict origin resolution: v2 (transport) mirrors resolve by stable
      // machine id only — a loose host/port/user lookup would match ANY
      // tunnel machine (all share the placeholder 127.0.0.1/0/'' triple).
      const owner = machineForMirror(m, machines)
      const rec = owner ? owner.record : null
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
    // Provider 分派（Step2，ADR-0002）：transport 缺省 'ssh'（providerForMachine）。
    // 仅非 ssh 传输进入分派 —— ssh 分支（下方原有逻辑）与接入 Provider 层之前
    // 逐字节等价（git diff 可见）；非 ssh 且 provider 已注册则真实接线（Step5c），
    // 未注册仍显式拒绝，绝不静默回退 SSH。
    const { transport, def } = providerForMachine(m)
    if (transport !== 'ssh') {
      if (!def) throw new Error(`transport ${JSON.stringify(transport)}: provider not installed`)
      // Step5c：已注册非 ssh provider（vscode-tunnel 等）真实接线。
      // 连接键 'transport:machineId'（m.id，兜底 m.tunnel.remoteIdentity.machineId，
      // 兼容 remoteIdentity 是字符串的旧形态）：绝不用 host:port:user —— tunnel
      // 机器统一为 127.0.0.1:动态端口，会与 SSH 键相撞。
      // 缓存复用同一 routePools Map：键空间（transport:machineId vs host:port:user）
      // 不相交、互不干扰；TTL 沿用与 ssh 分支同构的"取用即查 30 分钟、过期
      // close+移除"机制（无独立清扫器，需等待下一次取用才回收——与 ssh 一致）；
      // 插件卸载的 closeRoutePools 因同 Map 而一并 close provider 句柄（值形状
      // 同为 { pool, at }，其 try/catch 对 handle.close() 幂等成立）。
      const rawMid = m.id || (m.tunnel && m.tunnel.remoteIdentity &&
        (typeof m.tunnel.remoteIdentity === 'object' ? m.tunnel.remoteIdentity.machineId : m.tunnel.remoteIdentity)) || ''
      const key = transport + ':' + rawMid
      let entry = routePools.get(key)
      if (entry && Date.now() - entry.at > 30 * 60 * 1000) {
        try { entry.pool.close() } catch {}
        routePools.delete(key)
        entry = undefined
      }
      if (!entry) {
        // 凭据惰性解析：keychain/明文密码 → tunnel.secret（一次性秘密，v1 实验回退）→ ''。
        const credentialResolver = async () => {
          const p = await machinePassword(m)
          return p || (m.tunnel && m.tunnel.secret) || ''
        }
        let handle
        try {
          // 走 provider.js 导出的 connectMachine 分发（与直调 def.connect 等价，
          // 且该层自带"未注册 → provider not installed"守卫）；选它让本处不耦合
          // def 的具体形状。signal 缺省（池层无中止源，与 ssh 分支一致）。
          handle = await connectMachine(m, { credentialResolver })
        } catch (err) {
          // 失败不落缓存（调用方下次会重试建连）；网络类错误经 errors.js 可读化。
          const raw = String((err && err.message) || err)
          const reason = classifyError(err).category === 'other' ? raw : friendlyMessage(err)
          throw new Error(`transport ${JSON.stringify(transport)}: connect failed: ${reason}`)
        }
        entry = { pool: handle, at: Date.now() }
        routePools.set(key, entry)
      }
      // 直接返回插件 connect 的结果（已带 SSH 兼容表面），不做二次包装。
      return entry.pool
    }
    if (!m || !m.host) throw new Error('no machine: call rw_connect or set a current machine for this workspace first')
    // ssh-config alias (issue #38): dial the RESOLVED identity while the
    // registry keeps the alias itself — the pool then follows ~/.ssh/config
    // edits for existing sessions instead of dialing the stale address.
    const eff = m && m.useSshConfig ? withSshConfig(m) : m
    const rec = eff || m
    const tag = rec.host + ':' + (Number(rec.port) || 22) + ':' + (rec.username || 'root')
    let entry = routePools.get(tag)
    if (entry && Date.now() - entry.at > 30 * 60 * 1000) {
      try { entry.pool.close() } catch {}
      routePools.delete(tag)
      entry = undefined
    }
    if (!entry) {
      const pw = await machinePassword(m)
      const routePool = new SshPool({
        host: rec.host,
        port: Number(rec.port) || 22,
        username: rec.username || 'root',
        password: pw || rec.password || '',
        privateKeyPath: rec.privateKeyPath || '',
        passphrase: rec.passphrase || '',
        useAgent: !!rec.useAgent,
        keyboardInteractive: !!rec.keyboardInteractive,
        hostKeyMode: rec.hostKeyMode || config.hostKeyMode,
        commandTimeoutMs: config.commandTimeoutMs,
        connectTimeoutMs: config.connectTimeoutMs,
        // Output-budget cap must ride every pool or `truncate(_, undefined)`
        // mangles every exec result (the git route depends on it).
        maxOutputChars: config.maxOutputChars,
        env: config.env,
        proxy: rec.proxy && rec.proxy.host ? rec.proxy : (config.proxy || undefined),
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

/** Session-bound adapter (per-session routing, issue #25): resolve the
   *  machine record for a mirror-recorded origin, then hand the caller the
   *  dedicated pool of THAT machine. Resolution goes through machineForMirror:
   *  non-ssh origins route by stable machine id and REFUSE (loudly) when the
   *  machine is not saved — an ad-hoc record fabricated from a tunnel
   *  machine's placeholder host/port/username would silently bind the mirror
   *  to a random tunnel machine. v1 (ssh) keeps the historical fallback to an
   *  ad-hoc record so a mirror whose owner was deleted still gets a pool
   *  pinned to its meta — keychain credentials are re-resolved lazily by the
   *  pool itself. */
  const poolForMachine = (target) => {
    const resolved = machineForMirror(target, machines)
    if (resolved && resolved.record) return machinePoolOf(resolved.record)
    if (resolved) {
      // v1: legacy ad-hoc fallback for a deleted owner — SSH shapes only.
      return machinePoolOf({ host: target.host, port: Number(target.port) || 22, username: target.username || 'root' })
    }
    throw new Error('cannot bind workspace: owning machine ' + String(target.transport || 'vscode-tunnel') + ':' + String(target.machineId || '?') + ' is not saved in the dsh-remote machine registry')
  }
  const routePoolOf = async (remotePath) => {
    // A remote path served by the UI belongs to the machine whose mirror owns
    // it (meta lookup). Preference order (route-machine.js): the pool of the
    // machine that owns the path, resolved from SAVED machines — there is no
    // global "current machine" to short-circuit through anymore.
    const mirror = pickMirrorForRemotePath(remoteWorkspacesRoot(), remotePath, null, (entry) => {
      const r = machineForMirror(entry, machines)
      return !!(r && r.record)
    })
    if (!mirror) return { pool, machine: null } // no mirror owns the path → shared pool (legacy)
    // Single resolution entry (route-machine.machineForMirror): v2 origins by
    // stable machine id, v1 by the legacy machineByTarget triple.
    const owner = machineForMirror(mirror, machines)
    const m = owner ? owner.record : null
    if (!m) {
      // Owning machine is NOT saved: reading the path through the shared
      // pool would silently hit the WRONG host (often an existing-but-empty
      // dir → `{items: []}` → the tree shows a blank). Fail loudly instead —
      // the client renders the error row with this exact reason. Non-ssh
      // origins name the transport:machineId key; v1 keeps the legacy
      // host:port wording.
      const who = mirror.transport && mirror.transport !== 'ssh'
        ? mirror.transport + ':' + (mirror.machineId || '?')
        : mirror.host + ':' + mirror.port
      const msg = 'cannot serve ' + normalizeRemotePath(remotePath || '') + ': owning machine ' + who + ' is not saved in the dsh-remote machine registry'
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
  const GIT_LOG_ROOT_LIMIT = 200 // host parity: max pinned log roots per snapshot
  const gitDiscoveryCache = new Map() // machineTag + '\0' + dir -> { at, value }
  // Workspace git marker cache (GET /dsh-remote/git-workspace): one remote
  // `git status --porcelain -b` per (machine, dir), TTL-cached so the
  // browser's per-row marker fetches never fan out into a connection storm.
  const GIT_WORKSPACE_MARKER_TTL_MS = 5000
  const GIT_WORKSPACE_MARKER_MAX = 128
  const gitWorkspaceCache = new Map() // machineTag + '\0' + remoteDir -> { at, marker }

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

  /** The machine tag for per-(machine, dir) caches. Non-ssh machines key by
   *  their stable id (all tunnel records share the placeholder host/port/user
   *  triple — an ssh-shaped tag would collide DIFFERENT tunnel machines into
   *  one cache bucket); v1/ssh keeps the legacy host:port:user tag. */
  const gitMachineTag = (machine) => machine
    ? (machine.transport && machine.transport !== 'ssh'
      ? machine.transport + ':' + String(machine.machineId || machine.id || '?')
      : String(machine.host) + ':' + String(Number(machine.port) || 22) + ':' + String(machine.username || 'root'))
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
          'log', '-n', String(count), '--skip', String(skip), '--topo-order', '--decorate=short',
          '--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D',
        ])
        return parseLogGraphLines(res.stdout)
      })
    }
    if (op === 'log') {
      // The host sidebar's git.log contract (v0.24.0+): plain skip/count
      // array mode when NEITHER roots nor cursor is given (legacy shape);
      // with `roots` ([] = pin the server's own HEAD tip, non-empty = every
      // hash re-verified 40-hex + rev-parse) or a previous page's `cursor`
      // the log switches to FIXED-ROOTS pagination: the revision set is
      // pinned on the first request and later pages ride opaque cursors, so
      // the rows cannot shift when new commits land between pages.
      const count = Number.isInteger(body.count) && body.count > 0 ? body.count : 30
      const skip = Number.isInteger(body.skip) && body.skip >= 0 ? body.skip : 0
      const roots = body.roots
      const cursor = body.cursor
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (roots === undefined && cursor === undefined) {
        return rootOf().then(async (root) => {
          const res = await gitRun(rp, root, [
            'log', '-n', String(count), '--skip', String(skip), '--topo-order', '--decorate=short',
            '--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D',
          ])
          return parseLogGraphLines(res.stdout)
        })
      }
      // Guardrails mirror the host route: shape-checked here, hash/state
      // verified against the live repo below. Each guard only fires when
      // the field is PRESENT — the anchor page legitimately sends
      // `roots: []` with NO cursor, and a cursor ride sends ONLY the
      // cursor (roots absent): rejecting the absent twin would kill both
      // fixed-roots paths (observed in the field: `git log cursor must be
      // a non-empty string` on every anchor request).
      const guard = logPagingGuard(roots, cursor)
      if (guard !== null) throw new Error(guard)
      return rootOf().then(async (root) => {
        const repoKey = gitPathId(root)
        // Re-resolve + verify pinned roots (same 40-hex + rev-parse checks
        // as the host): an EMPTY list pins the server's own HEAD tip — never
        // client-side heuristics. An unborn HEAD resolves to no roots.
        const resolvePinned = async (requested) => {
          if (!Array.isArray(requested) || requested.length === 0) {
            try {
              const head = String((await gitRun(rp, root, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout || '').trim()
              return head === '' ? [] : [head]
            } catch {
              return [] // unborn HEAD / empty repository → empty log
            }
          }
          if (requested.length > GIT_LOG_ROOT_LIMIT) {
            throw new Error('too many log roots (limit ' + GIT_LOG_ROOT_LIMIT + ')')
          }
          const resolved = []
          for (const candidate of requested) {
            if (!isLogRootHash(candidate)) throw new Error('invalid log root: ' + String(candidate))
            let hash = ''
            try {
              hash = String((await gitRun(rp, root, ['rev-parse', '--verify', candidate + '^{commit}'])).stdout || '').trim()
            } catch {
              throw new Error('unknown log root: ' + candidate)
            }
            if (!isLogRootHash(hash)) throw new Error('unknown log root: ' + candidate)
            if (!resolved.includes(hash)) resolved.push(hash)
          }
          return resolved.sort()
        }
        const fetchPage = async (pinned, offset) => {
          if (pinned.length === 0) return { entries: [], hasMore: false }
          const safeOffset = Math.max(0, Math.floor(offset))
          const res = await gitRun(rp, root, [
            'log', '--topo-order', '-n', String(count), '--skip', String(safeOffset), '--decorate=short',
            '--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%ai%x1f%D',
            ...pinned, '--',
          ])
          // hasMore = the page is FULL (host rule); the next-page cursor is
          // issued only then. The cursor token is opaque to clients and
          // bound to (session, repo, pinned roots, next offset).
          return buildLogPage(parseLogGraphLines(res.stdout), count,
            encodeLogCursor({ sessionId, repoKey, roots: pinned, offset: safeOffset + count }))
        }
        let pinned
        let offset = skip
        if (cursor !== undefined) {
          // Cursor ride: the token must belong to THIS session + repository
          // (never page repo B at repo A's cursor position) and its pinned
          // roots must still resolve — a malformed / foreign / stale cursor
          // is DISCARDED and re-anchored on the server's own tips (offset 0),
          // so a lost snapshot degrades to a fresh anchor page instead of
          // an error or a cross-repo read.
          const bound = decodeLogCursor(cursor)
          if (bound && bound.sessionId === sessionId && bound.repoKey === repoKey) {
            try {
              pinned = await resolvePinned(bound.roots)
              offset = bound.offset
            } catch { /* snapshot roots vanished — re-anchor below */ }
          }
          if (pinned === undefined) {
            pinned = await resolvePinned([])
            offset = 0
          }
        } else {
          pinned = await resolvePinned(roots)
        }
        return fetchPage(pinned, offset)
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
    if (op === 'show') {
      // `git show <rev>:<path>` — one file's content inside a revision tree
      // (rev may be `:0` = index stage): null when the rev has no such path
      // or the command fails (host parity — the pane folds null as "no such
      // side", never a hard error). `path` is repository-relative per the
      // rev:path syntax (the diff's a// b/ stripped form); absolute paths,
      // backslashes and `..` escapes are refused before reaching git.
      const rev = pathArg('rev')
      const p = pathArg('path')
      if (rev === undefined) throw new Error('git show requires a non-empty rev')
      if (p === undefined || !isSafeGitShowPath(p)) {
        throw new Error('git show path must be repository-relative (no absolute paths, no ".." segments)')
      }
      return rootOf().then(async (root) => {
        try {
          const res = await gitRun(rp, root, ['show', '--no-ext-diff', '--no-color', '--format=', rev + ':' + p], { outputChars: 4 * 1024 * 1024 })
          return { content: res.stdout }
        } catch {
          return { content: null }
        }
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
  // NOTE: this matcher is shared by mirror sync (rw_sync/rw_push) and search.
  // Do NOT add search-only cache excludes here: widening it would silently stop
  // syncing directories a user may rely on. Search uses searchIgnoreMatcher().
  const ignoreMatcher = () => {
    try {
      const fromFile = readFileSync(ignoreFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      return compileIgnore(DEFAULT_IGNORE.concat(fromFile))
    } catch {
      return compileIgnore(DEFAULT_IGNORE)
    }
  }
  /** Search-only matcher: same as ignoreMatcher() plus machine-local cache trees
   *  (`~/.npm`, `~/.cache`, …) that are huge, almost never what a human is
   *  looking for, and the main cause of the issue #44 hang. Mirror sync is
   *  deliberately unaffected. An explicit `path` still searches anywhere. */
  const searchIgnoreMatcher = () => {
    try {
      const fromFile = readFileSync(ignoreFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      return compileIgnore(DEFAULT_SEARCH_IGNORE.concat(fromFile))
    } catch {
      return compileIgnore(DEFAULT_SEARCH_IGNORE)
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
  const managedPoolOf = async (machineId) => {
    const i = machineIndex(String(machineId || ''))
    return i < 0 ? null : machinePoolOf(machines[i])
  }
  const managedTerminals = new ManagedTerminalManager({ getPool: managedPoolOf, config, onCommand: (line) => audit('terminal', line) })
  ctx.effect(() => () => managedTerminals.closeAll(), 'dsh-remote.managed-terminals')
  const managedOwnerOf = (sessionId) => resolveManagedOwner(sessionId, { sessionCwdOf, ctxForCwd, getPool: managedPoolOf })
  // ── remote DSH Web UI attach sessions (issue #46) ─────────────────────────
  // "Use this DSH as a CLIENT for a DSH on another machine". The remote never
  // opens an inbound port (DSH forbids `--host 0.0.0.0`); we SSH out, start or
  // reuse a loopback-bound `dsh web` there, and carry its socket back over our
  // own SSH connection to a loopback listener here. One session per machine —
  // attaching again to the same machine reuses the live tunnel instead of
  // starting a second remote server. Lifecycle is owned by the plugin fiber, so
  // unloading the plugin tears every tunnel down.
  const webAttaches = new Map() // machineId → WebAttach
  ctx.effect(() => () => {
    for (const attach of webAttaches.values()) { try { attach.close() } catch { /* already gone */ } }
    webAttaches.clear()
  }, 'dsh-remote.web-attach')

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
pool: ctx.machine ? await poolForMachine(ctx.machine) : pool,
          ws: ctx.workspace,
          host: ctx.host,
          username: ctx.username,
          port: ctx.port,
          alias: ctx.machine ? aliasOf(ctx.machine) : '',
          mirrorDir: ctx.mirrorDir || null,
          // Mirror meta v2 origins carry the transport identity through to the
          // tools, so rw_pick_workspace can recreate the SAME v2 mirror key
          // (tunnel-<machineId>) instead of washing it back into an ssh key.
          transport: ctx.machine && ctx.machine.transport,
          machineId: ctx.machine && ctx.machine.machineId,
          remoteIdentity: ctx.machine && ctx.machine.remoteIdentity,
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
            rec = { id: machineId(), name: host, ...recBase, useSshConfig }
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
        const reconnectKey = eff.host + ':' + effPort + ':' + effUser
        const previousPool = routePools.get(reconnectKey)
        if (previousPool) { previousPool.pool.close(); routePools.delete(reconnectKey) }
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
        const local = ensureMirror(p, {
          host: ctx.host, username: ctx.username, port: ctx.port,
          // v2 origins (ctxForCwd passthrough): keep the tunnel mirror keyed
          // by its stable machine id — passing host/port/user alone would
          // wash it into an ssh-shaped shell (127.0.0.1-root-22).
          transport: ctx.machine && ctx.machine.transport,
          machineId: ctx.machine && ctx.machine.machineId,
          remoteIdentity: ctx.machine && ctx.machine.remoteIdentity,
        }, { alias: ctx.machine ? aliasOf(ctx.machine) : '' })
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
        'Edit a remote text file by replacing literal text (read-modify-write with an mtime optimistic lock: aborts if the file changed on the remote between read and write). Path is absolute. Accepts the aliases old_string/new_string (and file_path for path), matching the host edit tool, so either spelling works.',
      parameters: {
        // `path`/`old`/`new` also accept the host edit tool's spellings
        // (file_path/old_string/new_string): models habitually use those, and a
        // schema-level `required` on only one spelling rejects the other before
        // execute() ever runs. So NONE of them is declared required here — the
        // resolver below enforces "path + old + new" and reports which spelling
        // to pass. Keep this in sync: adding `required: true` back to any of
        // these silently breaks its alias.
        path: { type: 'string', description: 'Absolute remote file path (alias: file_path)' },
        old: { type: 'string', description: 'Literal text to replace (must appear exactly once unless count is given). Alias: old_string' },
        new: { type: 'string', description: 'Replacement text; an empty string deletes the old text. Alias: new_string' },
        old_string: { type: 'string', description: 'Alias of old (same meaning)' },
        new_string: { type: 'string', description: 'Alias of new (same meaning)' },
        file_path: { type: 'string', description: 'Alias of path (same meaning)' },
        count: { type: 'integer', description: 'How many occurrences to replace (default: error if the text appears more than once)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
        const { ctx, pool } = await rwScopeOf(exec)
        // Presence must be checked on the RAW argument, not on the resolved
        // path: resolveRemoteArg falls back to the workspace root for an empty
        // string, so `!p` would never fire and a pathless rw_edit would silently
        // target the workspace root. (That is why `path` cannot simply lose its
        // schema `required` without this check replacing it.)
        const rawPath = args.path ?? args.file_path
        if (rawPath == null || String(rawPath).trim() === '') {
          throw new Error('rw_edit: a file path is required — pass path (alias: file_path)')
        }
        const p = resolveRemoteArg(ctx, rawPath)
        if (!p || p === '/') throw new Error('rw_edit: a file path is required — pass path (alias: file_path)')
        const oldRaw = args.old ?? args.old_string
        const newRaw = args.new ?? args.new_string
        if (oldRaw == null) throw new Error('rw_edit: old text is required — pass old (alias: old_string)')
        if (newRaw == null) throw new Error('rw_edit: replacement text is required — pass new (alias: new_string); use an empty string to delete the old text')
        const oldS = String(oldRaw)
        const newS = String(newRaw)
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
          else if (res.signal === 'ABORTED') text += '\n[cancelled — the remote command was stopped]'
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
        'Search remote files for a pattern. POSIX remotes try `rg` then `grep -R` first; Windows and fallbacks use a portable SFTP walk. Honors ignore rules. Returns matching file:line rows; output is capped. Search is bounded (maxEntries/maxDurationMs) and can be cancelled: on a very large tree it returns partial results marked TRUNCATED instead of running indefinitely.',
      // A cooperative budget for @deepseek-ai/dsh-tool-call-timeout-policy.
      // Only useful together with the cancellation support below: the policy can
      // only *ask* a tool to stop, so a tool that ignores exec.signal would keep
      // the caller waiting (issue #44).
      timeoutMs: config.searchTimeoutMs,
      parameters: {
        pattern: { type: 'string', required: true, description: 'Pattern to search for (extended regex)' },
        path: { type: 'string', description: 'Directory to search (default: current remote workspace)' },
        glob: { type: 'string', description: 'Only files whose NAME matches this glob, e.g. *.ts (optional)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default true)' },
        contextLines: { type: 'integer', description: 'Lines of context around each match (default 0)' },
        maxMatches: { type: 'integer', description: 'Max matches to return (default 500)' },
        maxEntries: { type: 'integer', description: 'Stop after scanning this many files (default 50000)' },
        maxDurationMs: { type: 'integer', description: 'Stop after this many ms and return partial results (default 60000)' },
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
        // Budgets. The SFTP walk had NO entry/duration cap before, so a search
        // over a home directory could run for hours while the turn stayed
        // `running` and cancel/steer did nothing (issue #44).
        const maxFiles = Math.min(Math.max(Number(args.maxEntries) || config.searchMaxEntries || 50000, 1), 500000)
        const maxDurationMs = Math.min(Math.max(Number(args.maxDurationMs) || config.searchTimeoutMs || 60000, 1000), 600000)
        const matcher = searchIgnoreMatcher()
        const { matches, scanned, truncated, cancelled } = await searchRemote(pool, dir, {
          pattern,
          regex,
          glob: args.glob,
          ignoreCase: args.ignoreCase !== false,
          contextLines: Math.min(Math.max(Number(args.contextLines) || 0, 0), 10),
          maxMatches,
          maxFiles,
          maxDurationMs,
          signal: exec.signal,
          maxScanBytes: Math.min(config.maxFileBytes || 1024 * 1024, 1024 * 1024),
          isIgnored: (name, isDir) => matcher(name, isDir),
          timeoutMs: Math.min(config.commandTimeoutMs, maxDurationMs),
        })
        const note = cancelled
          ? `, CANCELLED after ${scanned} files scanned`
          : truncated
            ? ', TRUNCATED'
            : ''
        if (!matches.length) {
          return { text: `no matches for /${pattern}/ in ${dir} (${scanned} files scanned${note})` }
        }
        let text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')
        text += `\n(${matches.length} match(es), ${scanned} files scanned${note})`
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
      name: 'rw_deploy_probe',
      description:
        'READ-ONLY health check of the remote machine\'s DSH install: platform/arch, node/npm, the existing dsh and its version, whether its native module can load (the usual reason `dsh web` will not start, e.g. a node-pty build with no Linux prebuild), whether it knows --no-open, proxy and npm registry settings, and whether a private install prefix is writable. Writes nothing on the remote. Use it before troubleshooting a failed remote DSH Web UI connection. For an automatic install into a private prefix, use the settings UI ("Deploy & verify") — this tool never installs.',
      parameters: {},
      output: textOut,
      async execute(_args, exec) {
        const { ctx: scope, pool: probePool } = await rwScopeOf(exec)
        const b = { ...scope, pool: probePool }
        const machine = scope.machine
        // Do NOT pre-resolve the prefix locally: `resolvePrefix({home:''})` falls
        // back to /tmp, which is not where an install would go. With no explicit
        // config the REMOTE resolves it from its own $HOME and reports back.
        const explicitPrefix = String(config.webInstallPrefix || '').trim()
        const installedCommand = String((machine && machine.webAttachCommand) || '').trim()
        const out = await b.pool.exec(
          buildProbeCommand({ prefix: explicitPrefix, installedCommand, defaultPrefixFor: explicitPrefix ? '' : 'home' }),
          { timeoutMs: 30000 },
        )
        const facts = parseProbe(out && out.stdout)
        const verdict = judgeProbe(facts, { installedCommand })
        // Rendered as a compact report: the model needs the FACTS and the
        // VERDICT, not a JSON blob it would have to re-interpret.
        const lines = [
          `remote: ${b.host}${b.username ? ' (' + b.username + ')' : ''}`,
          `verdict: ${verdict.severity}${verdict.ok ? ' (usable)' : ' (blocked)'}`,
          verdict.useCommand ? `dsh to use: ${verdict.useCommand}` : 'dsh to use: (none usable yet)',
          `can auto-install: ${verdict.canAutoInstall ? 'yes' : 'no'}`,
          '',
          'facts:',
          `  platform=${facts.platform || '?'} arch=${facts.arch || '?'} ${facts.windows ? '(windows)' : ''}`,
          `  node=${facts.node || '(none)'} ${facts.nodeVersion || ''}`,
          `  npm=${facts.npm || '(none)'}`,
          `  dsh=${facts.dsh || '(none)'} ${facts.dshVersion || ''}`,
          `  native-module (node-pty) prebuild: ${facts.ptyPrebuild || 'unknown'}`,
          `  knows --no-open: ${facts.noOpen || 'unknown'}`,
          facts.installed ? `  previously deployed command present: ${facts.installed} (pty=${facts.installedPty || '?'} web=${facts.installedWeb || '?'})` : '',
          `  git bash: ${facts.gitBash || '(none)'}${facts.windows && !facts.gitBash ? ' — required for a Windows remote' : ''}`,
          `  proxy: ${facts.proxyVar || '(none)'}  npm registry: ${facts.registry || '(default)'}`,
          `  install prefix ${facts.resolvedPrefix || explicitPrefix || '(unresolved)'} writable: ${facts.writable || 'unknown'}`,
          '',
          'findings:',
          ...verdict.findings.map((f) => `  [${f.severity}] ${f.summary}${f.detail ? ' — ' + f.detail : ''}${f.fix ? '\n        fix: ' + f.fix : ''}`),
        ].filter(Boolean)
        if (!verdict.ok) {
          lines.push('', 'This is read-only. To fix it, either use the settings UI card "Remote dsh health check & deploy" (it installs into a private prefix and verifies), or repair it yourself following the dsh-remote-deploy skill.')
        }
        return { text: lines.join('\n') }
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
    ...managedTerminalRoutes({ manager: managedTerminals, resolveOwner: managedOwnerOf, readBody, sendJson }),
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
          // Strict origin resolution (machineForMirror): the owner of a v2
          // (transport) mirror is found by stable machine id — a loose
          // host/port/user lookup could report ANOTHER tunnel machine as the
          // owner; v1 keeps the legacy triple lookup.
          const owner = m && m.host ? (machineForMirror(m, machines) || {}).record || null : null
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
            const mirror = pickMirrorForRemotePath(remoteWorkspacesRoot(), normalizeRemotePath(String(body.path)), null, (entry) => {
              const r = machineForMirror(entry, machines)
              return !!(r && r.record)
            })
            if (mirror) {
              const owner = machineForMirror(mirror, machines)
              // v2 origin: strict machine-id resolution (never the placeholder
              // host/port/user guess); v1 keeps the legacy machineByTarget.
              rec = owner ? owner.record : null
            }
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
      // Un-scoped listing routes by path owner (per-machine routing).
      routePoolForPath: (p) => routePoolOf(p),
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
      // Workspace-level git markers — the workspace-browser twin of
      // POST /dsh-remote/git (which serves the session surfaces: GitView /
      // explorer decorations / diff tabs). One compact marker per remote
      // WORKSPACE: branch (or detached short sha) + dirty/staged counts +
      // upstream ahead/behind — exactly the data a workspace row's git badge
      // needs. Workspaces are addressed the way DSH addresses them:
      //   ?local=<abs mirror path>   — the workspace's LOCAL path (mirror
      //                                meta → owner machine + remote dir);
      //   ?path=<abs remote dir>     — already-remote path, owning machine
      //     &machine=<saved machine id> — explicit machine (the settings /
      //                                picker list a machine's recent
      //                                workspaces — never the shared pool);
      //   ?refresh=1                 — bypass the 5s per-(machine, dir) cache.
      // Data = ONE remote `git status --porcelain=v1 -z -b` (+ one short-sha
      // read when detached), porcelain-parsed with lib/git-parse.js. A
      // non-repo workspace → `marker.isRepo:false` (never an error); a local
      // path that is not a mirror → `marker:null` — and so is a mirror whose
      // OWNING MACHINE is no longer in the machine registry (orphaned
      // mirror: the workspace/machine was deleted but the local mirror dir
      // survives by design; it has no reachable owner, hence no marker —
      // `marker:null`, never an error). Transport failures carry the
      // credential classification like every other route.
      kind: 'exact',
      path: '/dsh-remote/git-workspace',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          const local = q.get('local') ? decodeURIComponent(q.get('local')) : ''
          const pathParam = q.get('path') ? decodeURIComponent(q.get('path')) : ''
          const machineId = q.get('machine') ? decodeURIComponent(q.get('machine')) : ''
          const refresh = q.get('refresh') === '1' || q.get('refresh') === 'true'
          // Resolve (pool, machine record, remote dir) of the workspace.
          let rp
          let machine = null
          let remoteDir = ''
          let mirrorDir = null
          if (local) {
            const mirror = mirrorMatchOf(local)
            // A local path that no mirror owns is a plain LOCAL workspace —
            // no remote, no marker (the caller renders nothing).
            if (!mirror) return sendJson(res, 200, { ok: true, marker: null })
            // machineForMirror: v2 origins by stable machine id (strictly —
            // never the shared placeholder host/port/user), v1 by the legacy
            // machineByTarget triple.
            const owner = machineForMirror(mirror, machines)
            machine = owner ? owner.record : null
            if (!machine) {
              // Orphaned mirror: the owning machine was deleted (or never
              // saved) while the mirror dir stays on disk — mirrors are the
              // local working copy of the remote tree and deliberately
              // survive workspace/machine removal. Without a saved owner the
              // marker cannot be produced; degrade to `marker:null` (same as
              // a non-mirror path) instead of erroring — the browser probes
              // every workspace AND session cwd on mount/focus, and stale
              // session cwds inside deleted mirrors must stay silent.
              return sendJson(res, 200, { ok: true, marker: null })
            }
            rp = await machinePoolOf(machine)
            remoteDir = mirror.remotePath
            mirrorDir = mirror.mirrorDir
          } else {
            remoteDir = normalizeRemotePath(pathParam)
            if (!remoteDir || remoteDir === '/') {
              return sendJson(res, 400, { ok: false, error: 'local or path is required' })
            }
            if (machineId) {
              const i = machineIndex(String(machineId))
              if (i < 0) return sendJson(res, 400, { ok: false, error: 'machine not saved in the registry' })
              machine = machines[i]
              rp = await machinePoolOf(machine)
            } else {
              const routed = await routePoolOf(remoteDir)
              rp = routed.pool
              if (routed.machine) {
                const owner = machineForMirror(routed.machine, machines)
                machine = owner ? owner.record : null
              }
            }
          }
          const machineTag = gitMachineTag(machine)
          const cacheKey = machineTag + '\0' + gitPathId(remoteDir)
          if (!refresh) {
            const hit = gitWorkspaceCache.get(cacheKey)
            if (hit && Date.now() - hit.at < GIT_WORKSPACE_MARKER_TTL_MS) {
              return sendJson(res, 200, { ok: true, marker: hit.marker })
            }
            if (hit) gitWorkspaceCache.delete(cacheKey)
          } else {
            gitWorkspaceCache.delete(cacheKey)
          }
          const base = {
            machine: machine ? {
              id: machine.id || '', name: machine.name || '', host: machine.host,
              port: Number(machine.port) || 22, username: machine.username || 'root',
            } : null,
            mirrorDir,
            remotePath: remoteDir,
            root: '',
          }
          let marker = null
          // Repo probe: infra failures (ssh/transport/credentials) surface;
          // any other non-zero exit (not a git repository, git absent on the
          // host…) degrades to the isRepo:false marker — same rule as the
          // git route's status op.
          let root = ''
          try {
            const r = await gitRun(rp, remoteDir, ['rev-parse', '--show-toplevel'], { timeoutMs: 8000 })
            root = String(r.stdout || '').trim()
          } catch (err) {
            if (isGitInfraError(err)) throw err
          }
          if (!root) {
            marker = { ...base, isRepo: false, at: Date.now() }
          } else {
            const res2 = await gitRun(rp, root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], { outputChars: 1024 * 1024 })
            marker = buildWorkspaceMarker(parseStatusV1(res2.stdout), root)
            if (!marker) {
              // git status succeeded without a `-b` header — treat as no repo
              // state (belt-and-braces; the probe above already pinned root).
              marker = { ...base, isRepo: false, at: Date.now() }
            } else {
              marker = { ...base, ...marker, at: Date.now() }
              if (marker.branch === 'HEAD') {
                const short = await gitRun(rp, root, ['rev-parse', '--short', 'HEAD'], { allowFail: true })
                const sha = String(short.stdout || '').trim()
                if (sha) { marker.detached = sha; delete marker.branch }
              }
            }
          }
          if (gitWorkspaceCache.size >= GIT_WORKSPACE_MARKER_MAX) {
            const oldest = gitWorkspaceCache.keys().next().value
            if (oldest !== undefined) gitWorkspaceCache.delete(oldest)
          }
          gitWorkspaceCache.set(cacheKey, { at: marker.at, marker })
          return sendJson(res, 200, { ok: true, marker })
        } catch (err) {
          const msg = String((err && err.message) || err)
          console.error('[dsh-remote] git-workspace failed:', msg)
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
            ctx = {
              ...ctxForCwd(localWs),
              host: rec.host,
              // Tunnel records carry the RAW placeholder port 0 / username ''
              // (never the ssh normalization `||22` / `||'root'`) so the v2
              // mirror meta records them without ssh-shaped artifacts; ssh
              // records keep the legacy normalization byte for byte.
              port: rec.transport === 'vscode-tunnel' ? (rec.port == null ? 0 : Number(rec.port)) : Number(rec.port) || 22,
              username: rec.transport === 'vscode-tunnel' ? String(rec.username == null ? '' : rec.username) : rec.username || 'root',
              machineId: rec.id,
              machine: rec,
              // Meta v2 identity: keyed by stable machine id, never the
              // ssh-normalized host/port/user triple.
              transport: rec.transport || 'ssh',
              ...(rec.tunnel && rec.tunnel.remoteIdentity !== undefined ? { remoteIdentity: rec.tunnel.remoteIdentity } : {}),
            }
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
          if (payload.machineId || payload.machine) {
            const i = machineIndex(String(payload.machineId || payload.machine || ''))
            if (i < 0) return sendJson(res, 400, { ok: false, error: 'machine not saved in the registry' })
            const rec = machines[i]
            ctx = {
              ...ctxForCwd(localWs),
              host: rec.host,
              // Tunnel records carry the RAW placeholder port 0 / username ''
              // (never the ssh normalization `||22` / `||'root'`) so the v2
              // mirror meta records them without ssh-shaped artifacts; ssh
              // records keep the legacy normalization byte for byte.
              port: rec.transport === 'vscode-tunnel' ? (rec.port == null ? 0 : Number(rec.port)) : Number(rec.port) || 22,
              username: rec.transport === 'vscode-tunnel' ? String(rec.username == null ? '' : rec.username) : rec.username || 'root',
              machineId: rec.id,
              machine: rec,
              // Meta v2 identity: keyed by stable machine id, never the
              // ssh-normalized host/port/user triple.
              transport: rec.transport || 'ssh',
              ...(rec.tunnel && rec.tunnel.remoteIdentity !== undefined ? { remoteIdentity: rec.tunnel.remoteIdentity } : {}),
            }
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
              // ── transport 分发（Step2：machines 路由支持 vscode-tunnel 录入）──
              // 语义选择（保守）：
              //  • 缺省/空 transport（或显式 'ssh'）→ 走下方原有 SSH 录入路径，行为逐字节不变。
              //  • 显式 'vscode-tunnel' → 隧道机器：必填 name + tunnel.tunnelId；客户端误传的
              //    SSH 字段（host/port/username/password/...）一律忽略不落盘（比整体拒绝更简单，
              //    且对误传宽容），因此绝无"SSH 字段 + tunnel 字段混存"的可能——tunnel 记录根本
              //    不读取那些键。host 落占位 '127.0.0.1'（UI 按 username@host:port 渲染，
              //    client.js:962/1855，status 亦按 host 判断）；username 落 ''；port 落 0：
              //    已 grep 全部消费点，index.js 池化/路由/删除路径均 `Number(x)||22` 归一
              //    （1311/1322/1358/1512/2093/3395/3861/3896/4101），client.js:870 表单回填
              //    `String(m.port||22)` 同样兜底，port 0 无任何副作用。
              //  • 其他任意字符串 → 400。
              //  • update 不允许变更 transport（换传输必须删掉重建：字段形状与凭据语义完全
              //    不同，原地改写会留下幽灵字段/错误凭据），body.transport 与已存记录不一致即 400。
              const transport = String(body.transport || '').trim()
              if (transport && transport !== 'ssh' && transport !== 'vscode-tunnel') {
                return sendJson(res, 400, { ok: false, error: `unsupported transport: ${JSON.stringify(transport)} — supported: "ssh", "vscode-tunnel"` })
              }
              const isTunnel = transport === 'vscode-tunnel'
              const gateId = body.id || machineId()
              const gateIdx = machineIndex(gateId)
              const gatePrev = gateIdx >= 0 ? machines[gateIdx] : null
              if (gatePrev) {
                const prevTransport = gatePrev.transport === 'vscode-tunnel' ? 'vscode-tunnel' : 'ssh'
                if ((isTunnel ? 'vscode-tunnel' : 'ssh') !== prevTransport) {
                  return sendJson(res, 400, { ok: false, error: 'transport cannot change on update (vscode-tunnel ↔ ssh) — delete the machine and re-add it with the new transport' })
                }
              }
              if (isTunnel) {
                // ── 隧道机器记录 ──
                // 凭据 = 配对秘密（一次性 64-hex，B 端扩展生成）：只进 OS 凭据库
                // （credential.js：macOS Keychain / win DPAPI / linux secret-tool），
                // 记录里仅存 secretSet 布尔 + credentialBackend，secret 值绝不落盘
                // （计划 §7.2：registry 只存引用，Keychain 不可用不静默明文落盘）。
                // 删除机器时 deleteSecret 按 credentialBackend 清理（下方 delete 分支通用）。
                const t = body.tunnel && typeof body.tunnel === 'object' ? body.tunnel : {}
                const prevTunnel = gatePrev && gatePrev.tunnel && typeof gatePrev.tunnel === 'object' ? gatePrev.tunnel : {}
                const name = String(body.name || '').trim() || String(gatePrev && gatePrev.name || '').trim()
                // update 未带 tunnel 时回退已存值（对齐 SSH 分支"update 保留 prev 字段"语义）；
                // add 必须显式提供。
                const tunnelId = String(t.tunnelId || prevTunnel.tunnelId || '').trim()
                if (!name) return sendJson(res, 400, { ok: false, error: 'name required for vscode-tunnel machines' })
                if (!tunnelId) return sendJson(res, 400, { ok: false, error: 'tunnel.tunnelId required for vscode-tunnel machines' })
                // 配对秘密：仅接受 64-hex；更新时未带 → 沿用已存 secretSet（不强制重录）；
                // saveSecret 失败（OS 凭据库不可用）→ 拒绝保存，绝不回退明文。
                const secret = typeof t.secret === 'string' ? t.secret.trim() : ''
                if (secret && !/^[a-f0-9]{64}$/.test(secret)) {
                  return sendJson(res, 400, { ok: false, error: 'tunnel.secret 必须是 64-hex（B 端扩展生成的一次性配对秘密）' })
                }
                const secretWasSet = !!secret || !!prevTunnel.secretSet
                let credBackend = gatePrev && gatePrev.credentialBackend && gatePrev.credentialBackend !== 'plain'
                  ? gatePrev.credentialBackend : 'plain'
                if (secret) {
                  const saved = await saveSecret(gateId, secret, secretsDir())
                  if (!saved.ok) {
                    return sendJson(res, 400, { ok: false, error: `无法把配对秘密保存到系统凭据库（${saved.backend}）；凭据库不可用时不落盘明文，请修复后重试` })
                  }
                  credBackend = saved.backend
                }
                const rec = {
                  id: gateId,
                  name,
                  transport: 'vscode-tunnel',
                  tunnel: {
                    tunnelId,
                    cluster: typeof t.cluster === 'string' && t.cluster ? t.cluster : (prevTunnel.cluster || undefined),
                    remoteIdentity: typeof t.remoteIdentity === 'string' && t.remoteIdentity ? t.remoteIdentity : (prevTunnel.remoteIdentity || undefined),
                    ...(secretWasSet ? { secretSet: true } : {}),
                  },
                  workspace: String(body.workspace || '').trim(),
                  credentialBackend: credBackend,
                  host: '127.0.0.1',
                  username: '',
                  port: 0,
                  recentWorkspaces: gatePrev && gatePrev.recentWorkspaces ? gatePrev.recentWorkspaces : [],
                  lastConnectedAt: gatePrev && gatePrev.lastConnectedAt ? gatePrev.lastConnectedAt : null,
                  latencyMs: gatePrev && gatePrev.latencyMs ? gatePrev.latencyMs : null,
                }
                if (gateIdx >= 0) machines[gateIdx] = rec; else machines.push(rec)
                saveMachines(machines, store.currentId, false)
                return sendJson(res, 200, { ok: true, machine: sanitizeMachine(rec), machines: machines.map(sanitizeMachine), currentId: store.currentId })
              }
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
          const selected = wsSel(k)
          if (selected && !selected.machine && !selected.explicitNone && selected.machineId === id && selected.workspace === (machines[i].workspace || '')) {
            return sendJson(res, 200, { ok: true, ...status(k) })
          }
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
      path: '/dsh-remote/web-attach',
      // Issue #46: open/reuse/close a tunnel to a remote machine's DSH Web UI.
      // Actions: status (GET) | open | close. `open` either starts a remote
      // `dsh web` (default) or attaches to one the user already runs by passing
      // its `http://127.0.0.1:<port>/?token=…` URL.
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const q = new URL(req.url, 'http://localhost').searchParams
            const id = q.get('machineId') || ''
            const attach = id ? webAttaches.get(id) : undefined
            return sendJson(res, 200, {
              ok: true,
              attach: attach ? attach.describe() : null,
              attaches: [...webAttaches.values()].map((a) => a.describe()),
            })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          const body = parseJsonObject(await readBody(req))
          const action = String(body.action || '')
          const machineId = String(body.machineId || store.currentId || '').trim()
          if (!machineId) return sendJson(res, 400, { ok: false, error: '选择一台机器后再操作（missing machineId）' })

          // ── deploy: probe (read-only) and install (private prefix) ─────────
          // Issue #46 follow-up. Detection and installation are deterministic, so
          // they are code rather than a model call: fast, free, unit-testable.
          // The AI path (a built-in skill) is offered only when this cannot cope.
          if (action === 'probe' || action === 'install') {
            const machine = machines.find((m) => m.id === machineId)
            if (!machine) return sendJson(res, 404, { ok: false, error: `机器不存在：${machineId}` })
            const target = poolForMachine(identityOf(machine))
            // The command that deployment produced FOR THIS MACHINE wins over any
            // global default — otherwise a deployment on one host would be
            // forgotten on the very next probe.
            const installedCommand = String(machine.webAttachCommand || '').trim()
            const prefix = resolvePrefix({ home: '' }, { prefix: config.webInstallPrefix || '' })

            if (action === 'probe') {
              // Strictly read-only: this runs before the user has agreed to any
              // change, and may be run on a machine they are merely looking at.
              const out = await target.exec(buildProbeCommand({ prefix, installedCommand, defaultPrefixFor: config.webInstallPrefix ? '' : 'home' }), { timeoutMs: 30000 })
              const facts = parseProbe(out && out.stdout)
              const verdict = judgeProbe(facts, { installedCommand })
              // The prefix we judged writability against was a guess (empty
              // $HOME); now that the probe reported the real home, re-resolve so
              // the prefix shown matches what an install would actually use.
              const realPrefix = facts.resolvedPrefix || resolvePrefix(facts, { prefix: config.webInstallPrefix || '' })
              audit('web-deploy', `probe ${machine.host}: ${verdict.severity}`, verdict.ok ? 0 : 1, machine)
              return sendJson(res, 200, {
                ok: true,
                facts,
                verdict,
                prefix: realPrefix,
                command: webAttachCommandFor(machine),
                installVersion: config.webInstallVersion || DEFAULT_INSTALL_VERSION,
                registry: config.webInstallRegistry || '',
              })
            }

            // install
            if (body.confirm !== true) {
              return sendJson(res, 400, { ok: false, error: '安装需要在请求里显式 confirm: true' })
            }
            const pout = await target.exec(buildProbeCommand({ prefix, installedCommand, defaultPrefixFor: config.webInstallPrefix ? '' : 'home' }), { timeoutMs: 30000 })
            const facts = parseProbe(pout && pout.stdout)
            const verdict = judgeProbe(facts, { installedCommand })
            if (!verdict.canAutoInstall) {
              const why = verdict.findings.filter((x) => x.severity === 'blocker').map((x) => x.summary).join('；')
              audit('web-deploy', `install ${machine.host} refused: ${why}`, 1, machine)
              return sendJson(res, 400, { ok: false, error: `无法自动安装：${why || '远端缺少前提条件'}`, verdict })
            }
            const installPrefix = facts.resolvedPrefix || resolvePrefix(facts, { prefix: config.webInstallPrefix || '' })
            // A registry the user set explicitly wins; otherwise the remote's own
            // npm config is left alone, which is what an internal mirror needs.
            // `--registry` is only added when configured — overriding a working
            // corporate mirror with the public one would be a regression.
            const registry = String(body.registry || config.webInstallRegistry || '').trim()
            // Proxy comes from the remote's own environment; the operator may
            // override it per-install when the inherited one is wrong.
            const env = body.proxy && typeof body.proxy === 'object'
              ? Object.fromEntries(Object.entries(body.proxy).filter(([, v]) => typeof v === 'string'))
              : undefined
            const plan = buildInstallPlan({
              facts,
              prefix: installPrefix,
              version: String(body.version || config.webInstallVersion || DEFAULT_INSTALL_VERSION),
              registry,
              env,
            })
            const results = []
            for (const step of plan.steps) {
              let res2
              try {
                res2 = await target.exec(step.command, {
                  timeoutMs: step.timeoutMs || 120000,
                  // Per-step env exists for the proxy override (P4); pool.exec
                  // passes it through to the remote process.
                  ...(step.env ? { env: step.env } : {}),
                })
              } catch (err) {
                results.push({ id: step.id, title: step.title, ok: false, code: -1, output: String((err && err.message) || err) })
                break
              }
              const r = stepResult(step, res2)
              results.push(r)
              if (!r.ok) break
            }
            const ok = results.length === plan.steps.length && results.every((r) => r.ok)
            if (ok) {
              // Persist so the attach flow uses the working build from now on.
              persistWebAttachCommand(machine, plan.command)
              audit('web-deploy', `install ${machine.host} → ${plan.command}`, 0, machine)
              return sendJson(res, 200, { ok: true, steps: results, command: plan.command, prefix: installPrefix })
            }
            const failed = results.find((r) => !r.ok)
            audit('web-deploy', `install ${machine.host} failed at ${failed && failed.id}`, 1, machine)
            // A failure that looks like a network/registry problem gets the AI
            // escape hatch suggested, since that is precisely the long tail the
            // deterministic path cannot classify.
            const looksNetworky = /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|proxy|403|404/i.test(String(failed && failed.output))
            return sendJson(res, 500, {
              ok: false,
              error: `安装失败于「${failed ? failed.title : '未知步骤'}」`,
              steps: results,
              prefix: installPrefix,
              suggestInvestigate: true,
              ...(looksNetworky ? { hint: '看起来是网络或源的问题，可以让 AI 排查。' } : {}),
            })
          }

          if (action === 'open') {
            // Reuse a live tunnel for this machine: re-opening would start a
            // second remote DSH and leak the first one's process.
            const live = webAttaches.get(machineId)
            if (live && live.active) return sendJson(res, 200, { ok: true, attach: live.describe(), reused: true })
            // A tunnel that is no longer listening still owns sockets and a log
            // path; release it before this machine gets a fresh session. Its
            // remote process is left alone — stopping it stays an explicit act.
            if (live) { try { await live.close() } catch { /* already torn down */ } }
            const machine = machines.find((m) => m.id === machineId)
            if (!machine) return sendJson(res, 404, { ok: false, error: `机器不存在：${machineId}` })
            const attach = new WebAttach({
              localPortStart: config.webAttachPortStart,
            })
            try {
              await attach.open({
                pool: poolForMachine(identityOf(machine)),
                machineId,
                command: String(body.command || '').trim() || webAttachCommandFor(machine),
                profile: 'web',
                existingUrl: String(body.existingUrl || ''),
                dshHome: config.webAttachDshHome || '',
                waitSeconds: config.webAttachWaitSeconds,
              })
            } catch (err) {
              try { await attach.close() } catch { /* nothing was listening */ }
              const msg = String((err && err.message) || err)
              audit('web-attach', `open ${machine.host} failed: ${msg}`, 1, machine)
              return sendJson(res, 500, { ok: false, error: msg })
            }
            webAttaches.set(machineId, attach)
            audit('web-attach', `open ${machine.host} → 127.0.0.1:${attach.localPort}`, 0, machine)
            return sendJson(res, 200, { ok: true, attach: attach.describe() })
          }

          // ── investigate: hand the problem to an agent with the built-in skill ──
          // The AI escape hatch. Started ONLY when the user asks for it: it costs
          // a model call, so it is never automatic — the deterministic probe and
          // install are the default path.
          if (action === 'investigate') {
            const machine = machines.find((m) => m.id === machineId)
            if (!machine) return sendJson(res, 404, { ok: false, error: `机器不存在：${machineId}` })
            const controller = ctx.get('sessionController')
            if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
              return sendJson(res, 400, {
                ok: false,
                error: '当前组合没有会话服务（sessionController），无法让 AI 排查。'
                  + '请改用「部署并验证」，或把排查信息复制到对话里。',
              })
            }
            const sessionId = `dsh-remote-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            try {
              await controller.create({ sessionId, cwd: undefined })
            } catch (err) {
              // An id collision is the only tolerable failure here.
              if (!/conflict|exist/i.test(String((err && err.message) || err))) {
                return sendJson(res, 500, { ok: false, error: `创建排查会话失败：${String((err && err.message) || err)}` })
              }
            }
            const prompt = buildInvestigatePrompt({
              host: machine.host,
              user: machine.username,
              prefix: resolvePrefix({ home: '' }, { prefix: config.webInstallPrefix || '' }),
              findings: Array.isArray(body.findings) ? body.findings : [],
              facts: body.facts && typeof body.facts === 'object' ? body.facts : undefined,
              error: String(body.error || ''),
            })
            try {
              await controller.prompt({
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: prompt }],
              })
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: `提交排查任务失败：${String((err && err.message) || err)}` })
            }
            audit('web-deploy', `investigate ${machine.host} → session ${sessionId}`, 0, machine)
            return sendJson(res, 200, { ok: true, sessionId, skill: SKILL_NAME })
          }

          if (action === 'close') {
            const attach = webAttaches.get(machineId)
            if (!attach) return sendJson(res, 200, { ok: true, closed: false, error: '该机器没有活动的远程界面' })
            const stopRemote = body.stopRemote === true
            // `close()` refuses to signal anything without a recorded PID, so a
            // tunnel onto the user's own running instance stays hands-off.
            const exec = (cmd) => poolForMachine(identityOf(machines.find((m) => m.id === machineId) || {})).exec(cmd, { timeoutMs: 10000 })
            await attach.close({ stopRemote, exec })
            webAttaches.delete(machineId)
            audit('web-attach', `close ${attach.cleanUrl}${stopRemote ? ' (remote stopped)' : ''}`, 0)
            return sendJson(res, 200, { ok: true, closed: true, stoppedRemote: stopRemote && !!attach.remotePid })
          }

          return sendJson(res, 400, { ok: false, error: 'action must be open | close' })
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
          if (body.machineId || body.machine) {
            const i = machineIndex(String(body.machineId || body.machine || ''))
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
        // `loaded` is the code actually running; `disk` may already be newer.
        // They differ between an applied update and its hot swap (or a boot).
        const loaded = LOADED_VERSION
        const disk = diskVersion()
        // Three-layer precedence: the persisted `update-mode` override (settings
        // UI) beats the profile config, which beats DEFAULT_UPDATE_MODE. The
        // fallback must not hard-code a second default here, or this path would
        // silently disagree with the schema default.
        const rawMode = readUpdateMode() || config.updateMode || DEFAULT_UPDATE_MODE
        const base = {
          current: loaded,
          loaded,
          disk,
          pendingReload: gtVersion(disk, loaded),
          updateMode: ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : DEFAULT_UPDATE_MODE,
          updatedMarker: existsSync(path.join(selfDir(), '.dsh-remote-updated')),
          // Exposed so the settings page can explain why `auto` may not act:
          // a link:/dev install must not be overwritten by an npm publish.
          selfUpdateAllowed: isInstalledCopy(),
        }
        const probe = await fetchLatestVersion()
        // 即使查不到最新版，也把**本地状态**照常返回（ok:true），只把 registry
        // 的失败原因放在 registryError 里。
        //
        // 为什么：原先 registry 失败时整条响应 ok:false，客户端遇到 !ok 就只设错误
        // 文案、不 setUpd，于是面板永远停在「版本信息加载中…」——看起来像卡死，
        // 而实际上本地版本、更新模式、是否允许自更新都是已知的，完全可以展示。
        if (probe.error) {
          return sendJson(res, 200, { ok: true, ...base, latest: null, updateAvailable: false, registryError: probe.error, registryReason: probe.reason })
        }
        return sendJson(res, 200, {
          ok: true,
          ...base,
          latest: probe.version,
          updateAvailable: gtVersion(probe.version, loaded),
        })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          // Capture the outgoing version BEFORE the swap: reading it afterwards
          // reports the version we just installed, not the one we replaced.
          const from = diskVersion()
          const loaded = LOADED_VERSION
          const body = JSON.parse((await readBody(req)) || '{}')
          const target = String(body.version || '')
          if (!target) return sendJson(res, 400, { ok: false, error: 'version is required' })
          const result = await applyUpdate(target)
          const wantReload = body.reload !== false && config.updateAutoReload !== false
          // Answer first, then swap: the swap disposes the fiber serving this
          // very request, so nothing may touch the plugin after it.
          if (wantReload) scheduleSelfReload(ctx.get('loader'), 300)
          return sendJson(res, 200, {
            ok: true,
            from,
            loadedBefore: loaded,
            ...result,
            reloadScheduled: wantReload,
            // what the swap will land on, for a caller that wants to verify
            loadedAfterReload: wantReload ? result.to : loaded,
          })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-reload',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Hot-swap the host half to whatever is on disk now. Answers first (with
        // what was loaded and what it is about to become), then swaps.
        const loaded = LOADED_VERSION
        const disk = diskVersion()
        scheduleSelfReload(ctx.get('loader'), 300)
        return sendJson(res, 200, { ok: true, scheduled: true, loaded, disk, willReloadTo: disk })
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
]

  registerHttpTransports(ctx, routes)
  // Hosts without `ctx.inject` (bare loaders / test harnesses): register the
  // routes synchronously when webServer is already present. With inject the
  // reactive path above owns registration, so never double-register.
  if (typeof ctx.inject !== 'function') {
    const wsRoute = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
    if (wsRoute && typeof wsRoute.register === 'function') {
      const disposers = routes.map((r) => wsRoute.register(guardRoute(r, () => ctx.get('connection'))))
      ctx.effect(() => () => disposers.forEach((d) => d && d()), 'dsh-remote.routes')
    }
  }

  // ── open-in-app workspace-target provider (harness extension point) ───────
  // The session-header "open in app" button opens the session's cwd, which for
  // a remote workspace is a LOCAL mirror directory — so the stock button would
  // open the mirror. This provider claims mirror cwds and opens the REAL remote
  // directory through a local editor's SSH channel (lib/remote-open.js).
  // The service stays OPTIONAL and is read with ctx.get (never the property
  // form): a host without the extension point keeps the stock button, and a
  // plain local workspace is never claimed (resolve() returns null → stock
  // local behaviour).
  const registerRemoteOpen = (target) => {
    const openInApp = target.get('openInApp')
    if (!openInApp || typeof openInApp.registerProvider !== 'function') return
    const remoteOpenProvider = createRemoteOpenProvider({
      mirrorMatchOf,
      sessionCwdOf: (id) => sessionCwdOf(id),
    })
    target.effect(() => openInApp.registerProvider(remoteOpenProvider), 'dsh-remote.open-in-app')
  }
  // ctx.inject (when present) keeps this independent of plugin LOAD ORDER: the
  // callback runs now if open-in-app is already up, or when it comes up later.
  if (typeof ctx.inject === 'function') ctx.inject(['openInApp'], registerRemoteOpen)
  else registerRemoteOpen(ctx)

  // ── remote terminal WebSocket upgrade (/dsh-remote/ws/terminal) ───────────
  // One dedicated SSH connection per session (SshPool.openPty), so terminal
  // shells survive rw_exec pool reconnects. Frame protocol: see lib/terminal.js.
  // Registered reactively: webServer may arrive AFTER apply() runs (it is not
  // a hard dependency of the plugin — only the terminal surface needs it).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (inner) => {
      const webServer = inner.get('webServer')
      if (!webServer || typeof webServer.registerUpgrade !== 'function') return
      const managedWs = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
      inner.effect(() => () => managedWs.close(), 'dsh-remote.managed-ws-server')
      inner.effect(() => webServer.registerUpgrade({
        path: '/dsh-remote/ws/workspace-terminal',
        handler: (req, socket, head) => {
          if (!trustedWsUpgrade(req, runtimeTrustedHosts(inner, ctx))) { socket.destroy(); return }
          managedWs.handleUpgrade(req, socket, head, (ws) => {
            const q = new URL(req.url, 'http://localhost').searchParams
            void attachManagedTerminal(ws, q, { resolveOwner: managedOwnerOf, manager: managedTerminals })
          })
        },
      }), 'dsh-remote.managed-terminal-ws')
      const ttyWs = new WebSocketServer({ noServer: true })
      inner.effect(() => webServer.registerUpgrade({
        path: '/dsh-remote/ws/terminal',
        handler: (req, socket, head) => {
          // Browser-trust fence (see lib/upgrade-trust.js): loopback Host, or
          // an authority the web runtime declares trusted — the same list the
          // /api gateway and better-sidebar fences enforce per request. A
          // deployment served on a trusted non-loopback authority (corporate
          // gateway / forwarded host) must keep its terminal working: before
          // this, the socket was destroyed with no HTTP response and the
          // browser only saw "WebSocket connection ... failed:".
          if (!trustedWsUpgrade(req, runtimeTrustedHosts(inner, ctx))) {
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


  // ── built-in deployment skill (issue #46 P3) ──────────────────────────────
  // Registered at runtime so the plugin stays a single self-contained package
  // (no writable $DSH_HOME/skills, no collision with the user's own skills).
  // Optional: a composition without `ctx.skills` keeps the deterministic deploy
  // path and merely loses the AI fallback.
  if (typeof ctx.inject === 'function') ctx.inject(['skills'], (skillCtx) => {
    registerDeploySkill(skillCtx)
  })

  // ── auto-update: check on load + on an interval; apply silently ───────────
  // Failures are swallowed (never break the plugin). The persisted override
  // (settings UI) wins over the profile-config default, which wins over
  // DEFAULT_UPDATE_MODE — the single source of truth for the fallback.
  const rawMode = readUpdateMode() || config.updateMode || DEFAULT_UPDATE_MODE
  const effectiveUpdateMode = ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : DEFAULT_UPDATE_MODE
  if (effectiveUpdateMode === 'auto') {
    // 限流/网络失败后的退避：命中后跳过接下来若干轮检查，避免在被 npm 限流
    // （HTTP 429）时反复重试把配额烧得更久。指数增长，上限 24 轮（配合默认
    // 6h 间隔即最多约 6 天，足以让限流窗口滑过且不会永久停摆）。
    let backoffRounds = 0
    const checkAndApply = async () => {
      if (backoffRounds > 0) { backoffRounds -= 1; return }
      const probe = await fetchLatestVersion()
      if (probe.error) {
        // 限流与网络故障都要退避；成功一次即重置。
        backoffRounds = Math.min(backoffRounds === 0 ? 1 : backoffRounds * 2, 24)
        return
      }
      backoffRounds = 0
      const latest = probe.version
      // The version in flight is whichever of "already on disk" / "already
      // loaded" is newer. Pinning it once outside this closure (as v0.8.23 did)
      // made every later interval re-download and re-apply the same tarball,
      // because the pinned value never moves past the version it installed.
      const disk = diskVersion()
      const current = gtVersion(disk, LOADED_VERSION) ? disk : LOADED_VERSION
      if (!gtVersion(latest, current)) return
      try {
        await applyUpdate(latest)
      } catch {
        // 常见且预期的失败：link:/开发模式安装时 applyUpdate 会拒绝
        // （避免覆盖源码仓库）。这不是异常，静默即可——那类用户在自己的
        // 仓库里更新。
        return
      }
      // Landed: swap the running host half too, otherwise the code being served
      // and the code being run stay one version apart until the next boot.
      if (config.updateAutoReload !== false) scheduleSelfReload(ctx.get('loader'), 500)
    }
    void checkAndApply()
    const updateTimer = setInterval(checkAndApply, Math.max(config.updateCheckIntervalMs, 60000))
    if (typeof updateTimer.unref === 'function') updateTimer.unref()
    ctx.effect(() => () => clearInterval(updateTimer), 'dsh-remote.update-timer')
  }
}
