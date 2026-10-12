import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('    function gitWorkspaceMarker(')
const end = source.indexOf('\n    function useGitWorkspaceMarker(', start)

test('browser marker consumer silently honors bounded unavailable retry hints', async () => {
  let now = 0, calls = 0
  const context = {
    URLSearchParams, Date: { now: () => now }, Promise, Number, Math,
    GIT_MARKER_TTL_MS: 5000, GIT_MARKER_MAX: 128, gitMarkerCache: new Map(),
    console: { warn() { assert.fail('expected unavailable must not warn') } },
    apiRaw: async () => { calls++; return { status: 200, data: { ok: true, marker: null, probe: { state: 'unavailable', reason: 'connection_unavailable', retryAfterMs: 30000 } } } },
  }
  const marker = vm.runInNewContext(source.slice(start, end) + '\ngitWorkspaceMarker', context)
  assert.equal(await marker('/mirror', '', ''), null)
  now = 6000
  assert.equal(await marker('/mirror', '', ''), null)
  assert.equal(calls, 1)
  now = 30001
  await marker('/mirror', '', '')
  assert.equal(calls, 2)
})
