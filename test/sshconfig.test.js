import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSshConfig, importableEntries, matchSshAlias } from '../lib/sshconfig.js'

const SAMPLE = `
# comment
Host build
  HostName 9.134.186.191
  User mmdev
  Port 36000
  IdentityFile ~/.ssh/build_key
  ProxyJump jump.example.com

Host prod-*
  HostName 10.0.0.1

Host deploy
  HostName 10.0.0.2
  User ops
`

test('parseSshConfig extracts blocks', () => {
  const entries = parseSshConfig(SAMPLE)
  assert.equal(entries.length, 3)
  const build = entries[0]
  assert.equal(build.host, 'build')
  assert.equal(build.hostName, '9.134.186.191')
  assert.equal(build.user, 'mmdev')
  assert.equal(build.port, 36000)
  assert.equal(build.identityFile, '~/.ssh/build_key')
  assert.equal(build.proxyJump, 'jump.example.com')
})

test('importableEntries skips wildcards and empty blocks', () => {
  const entries = importableEntries(SAMPLE)
  const names = entries.map((e) => e.host)
  assert.ok(names.includes('build'))
  assert.ok(names.includes('deploy'))
  assert.ok(!names.includes('prod-*'))
})

test('empty / missing text yields no entries', () => {
  assert.deepEqual(parseSshConfig(''), [])
  assert.deepEqual(importableEntries('# only a comment\n'), [])
})

test('matchSshAlias matches a machine on host + port + user', () => {
  const entries = parseSshConfig(SAMPLE)
  assert.equal(matchSshAlias(entries, { host: '9.134.186.191', port: 36000, username: 'mmdev', localUser: 'havoc' }), 'build')
  assert.equal(matchSshAlias(entries, { host: '10.0.0.2', port: 22, username: 'ops', localUser: 'havoc' }), 'deploy')
  // Port and user are part of the identity, not decoration.
  assert.equal(matchSshAlias(entries, { host: '9.134.186.191', port: 22, username: 'mmdev', localUser: 'havoc' }), '')
  assert.equal(matchSshAlias(entries, { host: '10.0.0.2', port: 22, username: 'root', localUser: 'havoc' }), '')
  // No HostName → the alias itself is what ssh resolves; only a real host match counts.
  assert.equal(matchSshAlias(entries, { host: 'build', port: 22, username: '', localUser: 'havoc' }), '')
})

test('matchSshAlias never asserts a wildcard alias, nor a user-less entry for another user', () => {
  // A `Host *` block names no single machine and must never be handed to an editor.
  assert.equal(matchSshAlias(parseSshConfig(SAMPLE), { host: '10.0.0.1', port: 22, username: 'root', localUser: 'havoc' }), '')
  const userless = parseSshConfig('Host box\n  HostName 10.0.0.9\n')
  // ssh would authenticate as the LOCAL user, so only a matching local user passes.
  assert.equal(matchSshAlias(userless, { host: '10.0.0.9', port: 22, username: 'root', localUser: 'havoc' }), '')
  assert.equal(matchSshAlias(userless, { host: '10.0.0.9', port: 22, username: 'havoc', localUser: 'havoc' }), 'box')
})
