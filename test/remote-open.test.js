// Unit tests for the open-in-app remote workspace-target provider:
// local mirror cwd → remote folder → editor SSH argv, plus the refusal rules
// (never silently open the local mirror for a claimed remote workspace).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOpenArgs, createRemoteOpenProvider, expandPath, findOnPath,
  localUserName, probeRemoteEditors, remoteFolderFor, resolveEditorCommand, sshHostSpec,
  toEditorUriPath, REMOTE_OPEN_APPS,
} from '../lib/remote-open.js'

const VSCODE_DARWIN = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
const ZED_DARWIN = '/Applications/Zed.app/Contents/MacOS/cli'

const SSH_CONFIG = `
Host dev
  HostName 10.0.0.1
  User root
  Port 22

Host dev-alt
  HostName 10.0.0.1
  User root
  Port 36000

Host *
  User nobody
`

/** exists() stub: only these paths exist. */
const existsOnly = (...paths) => (p) => paths.includes(p)

/** A mirror lookup stub owning /mirror/root. */
const mirrorOf = (mirror) => (local) => {
  const m = String(local)
  return m === mirror.mirrorDir || m.startsWith(mirror.mirrorDir + '/') ? mirror : null
}

const MIRROR = { mirrorDir: '/mirror/root', host: '10.0.0.1', port: 22, username: 'root', remotePath: '/srv/app' }
const WIN_MIRROR = { mirrorDir: '/mirror/win', host: '10.0.0.9', port: 22, username: 'Havoc', remotePath: 'D:\\Code\\proj' }

const providerDeps = (over = {}) => ({
  mirrorMatchOf: mirrorOf(MIRROR),
  sessionCwdOf: () => '',
  sshConfigText: () => SSH_CONFIG,
  platform: 'darwin',
  env: { PATH: '' },
  home: '/Users/u',
  exists: existsOnly(VSCODE_DARWIN),
  spawnEditor: () => Promise.resolve(),
  localUser: 'havoc',
  watchMs: 5,
  ...over,
})

test('toEditorUriPath: POSIX, Windows drive and UNC remotes', () => {
  assert.equal(toEditorUriPath('/srv/app'), '/srv/app')
  assert.equal(toEditorUriPath('/srv/app/'), '/srv/app')
  assert.equal(toEditorUriPath('D:\\Code\\proj'), '/d:/Code/proj')
  assert.equal(toEditorUriPath('\\\\srv\\share\\proj'), '/srv/share/proj')
})

test('remoteFolderFor: mirror root, subdirectory and outside', () => {
  assert.equal(remoteFolderFor(MIRROR, '/mirror/root'), '/srv/app')
  assert.equal(remoteFolderFor(MIRROR, '/mirror/root/sub/deep'), '/srv/app/sub/deep')
  assert.equal(remoteFolderFor(MIRROR, '/elsewhere'), '')
  // A remote root must not be joined into '//sub'.
  assert.equal(remoteFolderFor({ ...MIRROR, remotePath: '/' }, '/mirror/root/sub'), '/sub')
  assert.equal(remoteFolderFor(WIN_MIRROR, '/mirror/win/sub'), '/d:/Code/proj/sub')
})

test('sshHostSpec: alias wins, then user@host, then inline port only where allowed', () => {
  const entries = [
    { host: 'dev', hostName: '10.0.0.1', user: 'root', port: 22 },
    { host: 'dev-alt', hostName: '10.0.0.1', user: 'root', port: 36000 },
  ]
  assert.equal(sshHostSpec({ host: '10.0.0.1', port: 22, username: 'root', entries, localUser: 'havoc' }), 'dev')
  assert.equal(sshHostSpec({ host: '10.0.0.1', port: 36000, username: 'root', entries, localUser: 'havoc' }), 'dev-alt')
  assert.equal(sshHostSpec({ host: '10.0.0.2', port: 22, username: 'root', entries: [], localUser: 'havoc' }), 'root@10.0.0.2')
  // Zed takes an inline port, so a port-36000 host with no alias is still addressable.
  assert.equal(
    sshHostSpec({ host: '10.0.0.2', port: 36000, username: 'root', entries: [], localUser: 'havoc', allowPort: true }),
    'root@10.0.0.2:36000',
  )
  // Everyone else must be refused with an actionable ssh-config hint.
  assert.throws(
    () => sshHostSpec({ host: '10.0.0.2', port: 36000, username: 'root', entries: [], localUser: 'havoc' }),
    /~\/\.ssh\/config alias/,
  )
})

test('buildOpenArgs: VS Code family --remote, Zed ssh:// URI', () => {
  assert.deepEqual(buildOpenArgs('vscode', 'dev', '/srv/app'), ['--remote', 'ssh-remote+dev', '/srv/app'])
  assert.deepEqual(buildOpenArgs('cursor', 'root@10.0.0.2', '/srv/app'), ['--remote', 'ssh-remote+root@10.0.0.2', '/srv/app'])
  assert.deepEqual(buildOpenArgs('zed', 'dev', '/srv/app'), ['ssh://dev/srv/app'])
  assert.throws(() => buildOpenArgs('finder', 'dev', '/srv/app'), /unsupported remote-open app/)
})

test('expandPath / findOnPath: ~, %VAR% and PATH lookup', () => {
  const env = { PATH: '/opt/bin', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
  assert.equal(expandPath('~/.local/bin/zed', { env, home: '/Users/u', platform: 'darwin' }), '/Users/u/.local/bin/zed')
  assert.equal(expandPath('%LOCALAPPDATA%\\Programs\\Zed\\zed.exe', { env, home: '/Users/u', platform: 'win32' }), 'C:\\Users\\u\\AppData\\Local\\Programs\\Zed\\zed.exe')
  assert.equal(findOnPath('code', { env: { PATH: '/opt/bin' }, platform: 'darwin', exists: existsOnly('/opt/bin/code') }), '/opt/bin/code')
  assert.equal(findOnPath('code', { env: { PATH: '/opt/bin' }, platform: 'darwin', exists: existsOnly('/opt/bin/code.exe') }), '')
})

test('resolveEditorCommand prefers install locations over PATH; probe follows menu order', () => {
  const deps = { platform: 'darwin', env: { PATH: '/usr/local/bin' }, home: '/Users/u' }
  assert.equal(resolveEditorCommand('vscode', { ...deps, exists: existsOnly(VSCODE_DARWIN, '/usr/local/bin/code') }), VSCODE_DARWIN)
  assert.equal(resolveEditorCommand('vscode', { ...deps, exists: existsOnly('/usr/local/bin/code') }), '/usr/local/bin/code')
  assert.equal(resolveEditorCommand('vscode', { ...deps, exists: () => false }), '')
  assert.equal(resolveEditorCommand('finder', { ...deps, exists: () => true }), '')

  const probed = probeRemoteEditors({ ...deps, exists: existsOnly(VSCODE_DARWIN, ZED_DARWIN) })
  assert.deepEqual(probed, ['vscode', 'zed'])
  assert.ok(REMOTE_OPEN_APPS.includes('vscode') && REMOTE_OPEN_APPS.includes('zed'))
})

test('provider.resolve claims a mirror cwd and reports the remote target', async () => {
  const provider = createRemoteOpenProvider(providerDeps())
  assert.equal(provider.id, 'dsh-remote')

  const target = await provider.resolve({ path: '/mirror/root' })
  assert.deepEqual(target, { provider: 'dsh-remote', label: 'root@10.0.0.1:/srv/app', apps: ['vscode'] })

  // A subdirectory of the same mirror opens that subdirectory, not the root.
  const sub = await provider.resolve({ path: '/mirror/root/sub' })
  assert.equal(sub.label, 'root@10.0.0.1:/srv/app/sub')

  // A plain local workspace is NOT claimed → the stock local button stays.
  assert.equal(await provider.resolve({ path: '/Users/u/local-project' }), null)

  // A session id must agree with the requested path.
  const withSession = createRemoteOpenProvider(providerDeps({ sessionCwdOf: (id) => (id === 's1' ? '/mirror/root/sub' : '') }))
  assert.equal((await withSession.resolve({ path: '/mirror/root/sub', sessionId: 's1' })).label, 'root@10.0.0.1:/srv/app/sub')
  assert.equal(await withSession.resolve({ path: '/mirror/root', sessionId: 's1' }), null)
  // `cwd` is accepted as an alias of `path` (session-only request included).
  assert.equal((await withSession.resolve({ cwd: '/mirror/root/sub' })).provider, 'dsh-remote')
  assert.equal((await withSession.resolve({ sessionId: 's1' })).label, 'root@10.0.0.1:/srv/app/sub')
})

test('provider.resolve does not claim when no remote-capable editor is installed', async () => {
  const provider = createRemoteOpenProvider(providerDeps({ exists: () => false }))
  assert.equal(await provider.resolve({ path: '/mirror/root' }), null)
})

test('provider.launch spawns the editor with the remote argv', async () => {
  const calls = []
  const provider = createRemoteOpenProvider(providerDeps({
    spawnEditor: (command, args, options) => { calls.push({ command, args, options }); return Promise.resolve() },
  }))
  await provider.launch({ app: 'vscode', path: '/mirror/root/sub' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, VSCODE_DARWIN)
  assert.deepEqual(calls[0].args, ['--remote', 'ssh-remote+dev', '/srv/app/sub'])

  // Zed on a non-default port takes the inline port (no alias in this config).
  const zedCalls = []
  const zed = createRemoteOpenProvider(providerDeps({
    mirrorMatchOf: mirrorOf({ ...MIRROR, port: 36000 }),
    sshConfigText: () => '',
    exists: existsOnly(ZED_DARWIN),
    spawnEditor: (command, args) => { zedCalls.push({ command, args }); return Promise.resolve() },
  }))
  await zed.launch({ app: 'zed', path: '/mirror/root' })
  assert.deepEqual(zedCalls[0].args, ['ssh://root@10.0.0.1:36000/srv/app'])
})

test('provider.launch refuses instead of degrading to the local mirror', async () => {
  const provider = createRemoteOpenProvider(providerDeps())
  // Not a mirror workspace at all.
  await assert.rejects(() => provider.launch({ app: 'vscode', path: '/Users/u/local' }), /not a remote mirror workspace/)
  // An app this host cannot drive remotely.
  await assert.rejects(() => provider.launch({ app: 'finder', path: '/mirror/root' }), /not available for remote open/)
  // A session/path mismatch (defense in depth).
  const strict = createRemoteOpenProvider(providerDeps({ sessionCwdOf: () => '/mirror/root/sub' }))
  await assert.rejects(() => strict.launch({ app: 'vscode', path: '/mirror/root', sessionId: 's1' }), /not this session's workspace/)
  // A non-default port with no ssh alias and no inline-port support.
  const ported = createRemoteOpenProvider(providerDeps({
    mirrorMatchOf: mirrorOf({ ...MIRROR, port: 36000 }),
    sshConfigText: () => '',
  }))
  await assert.rejects(() => ported.launch({ app: 'vscode', path: '/mirror/root' }), /~\/\.ssh\/config alias/)
})

test('provider.launch re-probes once when the verified CLI disappeared (ENOENT)', async () => {
  let present = true
  let attempts = 0
  const provider = createRemoteOpenProvider(providerDeps({
    exists: (p) => (p === VSCODE_DARWIN ? present : false),
    spawnEditor: () => {
      attempts += 1
      if (attempts === 1) {
        present = false
        const err = new Error('spawn ENOENT')
        err.code = 'ENOENT'
        return Promise.reject(err)
      }
      return Promise.resolve()
    },
  }))
  // First attempt fails ENOENT, the re-probe finds nothing → the second plan
  // throws the readable "not installed" error rather than a raw spawn failure.
  await assert.rejects(() => provider.launch({ app: 'vscode', path: '/mirror/root' }), /not installed/)
  assert.equal(attempts, 1)
})

test('localUserName falls back to the environment', () => {
  assert.equal(typeof localUserName(), 'string')
})
