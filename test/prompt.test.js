// System-prompt injection regression: a REMOTE session must tell the model
// that user-mentioned absolute paths (e.g. /data/workspace/…) are REMOTE
// paths, so it stops burning turns on local file lookups (read/glob/grep)
// that can never succeed locally.
//
// Observed failure mode (wxa-agent-dashboard case): session cwd was a
// dsh-remote mirror of root@host:/data/workspace/wxa-agent-dashboard, the
// user asked about /data/workspace/wxa-agent-dashboard/restart.sh, and the
// model first tried local file queries before going remote. The injected
// section must make the ownership rule explicit up front.
//
// Hermetic: real apply() against a throwaway DSH_HOME mirror; no SSH needed
// (the section text is evaluated with a fabricated promptContext).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ssh2 from 'ssh2'
import { apply } from '../lib/index.js'

// Keep apply()'s pool from touching the network (same trick as upload.test.js).
ssh2.Client.prototype.connect = function () {
  const self = this
  setImmediate(() => self.emit('ready'))
}
ssh2.Client.prototype.end = function () {}
ssh2.Client.prototype.sftp = function (cb) { setImmediate(() => cb(null, {})) }

/** Boot the real plugin against a throwaway DSH_HOME containing one remote
 *  mirror, and return the registered system-prompt section's text(). */
async function setup(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-prompt-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  const mirrorDir = path.join(home, 'remote-workspaces', 'any17.devcloud.woa.com-root-36000', 'wxa-agent-dashboard')
  mkdirSync(mirrorDir, { recursive: true })
  writeFileSync(
    path.join(mirrorDir, '.dsh-remote-meta.json'),
    JSON.stringify({
      host: 'any17.devcloud.woa.com', port: 36000, username: 'root',
      remotePath: '/data/workspace/wxa-agent-dashboard',
    }),
  )
  let sectionText = null
  await apply(
    {
      inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
      effect: () => {},
      get: () => undefined,
      systemPrompt: { section: (s) => { sectionText = s.text } },
      tools: { register: () => {} },
    },
    { updateMode: 'off', host: 'any17.devcloud.woa.com', port: 36000, username: 'root', commandTimeoutMs: 5000, connectTimeoutMs: 5000 },
  )
  assert.ok(sectionText, 'system prompt section was registered')
  return { sectionText, mirrorDir }
}

test('remote session: injection states the mirror mapping and orders rw_* over local tools', async (t) => {
  const { sectionText, mirrorDir } = await setup(t)
  const text = sectionText({ agent: { session: { header: { cwd: mirrorDir } } } })

  assert.ok(text, 'section text produced for a cwd inside the mirror')
  assert.match(text, /## Remote workspace/)
  // The mapping: remote root ↔ local mirror (format user@host:/path).
  assert.match(text, /root@any17\.devcloud\.woa\.com:\/data\/workspace\/wxa-agent-dashboard/)
  assert.ok(text.includes(mirrorDir), 'local mirror path is named')
  // The ownership rule that prevents local-first trial and error.
  assert.match(text, /REMOTE path/)
  assert.match(text, /Never.*local file tools|NEVER.*local/i)
  assert.match(text, /rw_read_file/)
  assert.match(text, /rw_stat/)
  assert.match(text, /on the host \(rw_read_file \/ rw_stat\)/i)
  // The @-reference protocol: @remote: → host (rw_* only), @local: → this
  // machine (native tools), untagged absolute path → remote.
  assert.match(text, /@remote:\/data\/workspace\/wxa-agent-dashboard\/restart\.sh/, 'protocol example names a remote ref')
  assert.match(text, /@remote:.+never with local tools|read it (only )?via rw_read_file/i)
  assert.match(text, /@local:/)
  assert.match(text, /untagged absolute path/i)
  // The old misleading sentence is gone.
  assert.ok(!/Treat this directory as the working root/.test(text), 'no "treat as working root" ambiguity')
})

test('local session: nothing injected (issue #13 — saved machines stay standby)', async (t) => {
  const { sectionText } = await setup(t)
  const localCwd = mkdtempSync(path.join(tmpdir(), 'dsh-prompt-local-'))
  t.after(() => rmSync(localCwd, { recursive: true, force: true }))
  const text = sectionText({ agent: { session: { header: { cwd: localCwd } } } })
  assert.equal(text, '', 'plain local session gets no remote section')
})

test('no session cwd: nothing injected', async (t) => {
  const { sectionText } = await setup(t)
  assert.equal(sectionText({ agent: { session: {} } }), '')
  assert.equal(sectionText({}), '')
})

test('active port forwards are appended', async (t) => {
  const { sectionText, mirrorDir } = await setup(t)
  const text = sectionText({ agent: { session: { header: { cwd: mirrorDir } } } })
  // No forwards configured in the test → the line must be absent, not crash.
  assert.ok(!/Active port forwards/.test(text), 'no forwards → no forwards line')
})