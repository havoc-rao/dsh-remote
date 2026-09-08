import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findMirrorsForRemotePath, pickMirrorForRemotePath, normalizeRoutePath } from '../lib/route-machine.js'

/** Build a fake <mirrorRoot>/<tag>/<base>/.dsh-remote-meta.json tree. */
function makeMirrorRoot(specs) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-route-machine-'))
  for (const s of specs) {
    const dir = path.join(root, s.tag, s.base)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({
      host: s.host, port: s.port, username: s.username ?? 'root', remotePath: s.remotePath,
    }))
  }
  return root
}

test('normalizeRoutePath collapses slashes and trims the trailing separator', () => {
  assert.equal(normalizeRoutePath('/a/b/'), '/a/b')
  assert.equal(normalizeRoutePath('C:\\Users\\dev\\'), 'C:/Users/dev')
  assert.equal(normalizeRoutePath('//a//b///'), '/a/b')
  assert.equal(normalizeRoutePath(''), '/')
  assert.equal(normalizeRoutePath('/'), '/')
})

test('findMirrorsForRemotePath: equal and child paths match; strangers do not', () => {
  const root = makeMirrorRoot([
    { tag: 'h5-root-36000', base: 'luban', host: 'h5', port: 36000, remotePath: '/data/workspace/luban-grafana' },
    { tag: 'h17-root-36000', base: 'wxa', host: 'h17', port: 36000, remotePath: '/data/workspace/wxa-agent-dashboard' },
  ])
  try {
    assert.equal(findMirrorsForRemotePath(root, '/data/workspace/luban-grafana').length, 1)
    const child = findMirrorsForRemotePath(root, '/data/workspace/luban-grafana/api/cli.js')
    assert.equal(child.length, 1)
    assert.equal(child[0].host, 'h5')
    assert.equal(child[0].tag, 'h5-root-36000')
    assert.equal(findMirrorsForRemotePath(root, '/data/workspace/other').length, 0)
    assert.equal(findMirrorsForRemotePath(root, '/').length, 0)
    assert.equal(findMirrorsForRemotePath(root, '/data').length, 0) // cover requires full remotePath prefix
    assert.equal(findMirrorsForRemotePath('/nonexistent-root', '/data/workspace/luban-grafana').length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pickMirrorForRemotePath prefers the CURRENT machine mirror over a saved one', () => {
  const root = makeMirrorRoot([
    { tag: 'h17-root-36000', base: 'wxa', host: 'h17', port: 36000, username: 'root', remotePath: '/data/workspace/wxa-agent-dashboard' },
    { tag: 'h5-root-36000', base: 'wxa', host: 'h5', port: 36000, username: 'root', remotePath: '/data/workspace/wxa-agent-dashboard' },
  ])
  try {
    const cur = { host: 'h17', port: 36000, username: 'root' }
    const picked = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', cur)
    assert.equal(picked.host, 'h17')
    // Without a current machine, a "saved" (connectable) machine wins.
    const savedFirst = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', null, (h) => h === 'h5')
    assert.equal(savedFirst.host, 'h5')
    // Otherwise the first match wins.
    const first = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', null)
    assert.ok(first.host === 'h17' || first.host === 'h5')
    assert.equal(pickMirrorForRemotePath(root, '/elsewhere', cur), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real mirror registry on this machine resolves the known remotes', () => {
  // The user's actual data (skipped when the workspace machine has none).
  const root = path.join(os.homedir(), '.dsh', 'remote-workspaces')
  if (!existsSync(path.join(root, 'machines.json')) && !existsSync(root)) return
  const luban = pickMirrorForRemotePath(root, '/data/workspace/luban-grafana', null)
  const wxa = pickMirrorForRemotePath(root, '/data/workspace/wxa-agent-dashboard', null)
  if (!luban && !wxa) return // mirrors absent on this machine — nothing to assert
  if (luban) assert.equal(luban.remotePath, '/data/workspace/luban-grafana')
  if (wxa) assert.equal(wxa.remotePath, '/data/workspace/wxa-agent-dashboard')
})