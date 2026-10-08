# SSH carrier experimental contract — 2026-10-07

Status: experimental building block, not end-to-end machine/UI support. Ordinary machine CRUD does not yet admit connectors. Do not insert connector machines directly into registry files or treat raw localhost records as stable remote identity.

## Prerequisites

Both control A and remote B need the official devtunnel CLI installed and explicitly logged in (GitHub supported). B also needs an authorized system sshd and independent host fingerprint verification. Plugin installation does not install CLI, log into GitHub, enable SSH, open firewall rules, or deploy remote services. Browser localhost is not necessarily DSH host localhost.

## Imports and registry

```js
import { registerSshCarrier } from 'dsh-remote/lib/ssh-carrier.js'
```

`registerSshCarrier({ id, apiVersion:1, validateConnector?, sanitizeConnector?, acquire })` returns an idempotent disposer. `connector.kind` selects the registration. V1 machine requires stable `id`, execution transport `ssh`, no SSH config alias/proxy mix. Optional sanitize hook is reserved; full registry/UI sanitization integration is not yet shipped.

`acquire({machineId,connector,signal})` returns:

```js
{
  dialHost: '127.0.0.1', // or literal ::1 only
  dialPort: 50736,      // actual CLI output, integer 1..65535
  targetIdentity: 'canonical-stable-target',
  generation: 'connection-generation',
  closed: Promise,      // settles on invalidation, must not reject unobserved
  release: async () => {}
}
```

No GitHub secrets, runtime endpoint or generation belong in persistent machine config. `targetIdentity` includes stable target descriptor, not dynamic local port. Provider must independently ensure current endpoint ownership and identity; loopback validation alone does not prove this.

## SSH factory

```js
import { createCarrierSshPool } from 'dsh-remote/lib/ssh-carrier-pool.js'
```

Accepts machine, SSH config, options `{knownHostsFile,credentialResolver,signal}`. `machine.expectedHostFingerprint` must be an independently confirmed SHA256 pin. Logical trust is `[ssh-carrier,machine.id,targetIdentity]`. Off/TOFU cannot bypass pin. Factory leases one reachability connection for its entire pool lifetime including dedicated PTYs; close destroys those channels before releasing reachability. Invalidation closes the factory pool; callers must create a new pool, never resurrect the old endpoint. It does not replay business requests or persist machine records.

Not yet a per-PTY lease implementation; whole-pool close intentionally ends all PTYs. Integration must not TTL-close a pool while a live terminal is intended to persist. Per-channel refs and integration lifecycle must be resolved before enabling ordinary UI routing.

## Validation performed

Combined trust/carrier/schema3/session-routing/terminal regressions: 84 pass (exit 0), including a real local ssh2 wire test for matching/mismatched pins and dedicated PTY teardown. Framework static gate and whitespace checks passed. Full suite reported 632 pass, 1 fail, 2 skipped: unrelated Python screenshot test lacked PIL. No live connection from this coding session; manual two-Mac evidence comes from user transcripts and must remain labeled as such. No product deployment.

## Continuation round 1 hardening

- Lease getter failure during acquisition now releases refs (adapter may expose stale getters).
- Abort after factory creation closes SSH and releases reachability; close exceptions do not leak leases.
- Ordinary CRUD/probe admission refusal has route-level regression coverage.
- Legacy host/port lookups and rw_connect upserts exclude connector/non-SSH records; missing named terminal owner now rejects rather than using the shared pool.
- Additional carrier/wire tests: 10 pass. Machine/route/terminal regression: 31 pass, 2 OS credential tests skipped; static gate clean.

## Continuation round 2 canonical identity and persistence

`sshConnectorTargetIdentity(connector)` delegates to registered `def.targetIdentity` (pure canonical descriptor function). Schema3 reader comparison no longer trusts caller-supplied `connector.targetIdentity`; missing/unregistered/invalid identity computation rejects.

Added internal `normalizeCarrierMachine` persistence gate (not public CRUD yet): strict pin, stable id, no in-place target/pin/transport replacement, carrier-specific sanitizer, credential preservation, excludes top-level runtime dial/generation. Credential handling and browser sanitization still required before route use.

Mirror writer supports explicit strict schema3 origin; its root derives from stable machine+descriptor and meta never writes localhost host/port. Existing v1/v2 remain unchanged. Routing writers/callers and complete lifecycle integration are still gated.

Verification: canonical/persistence/mirror regressions 35/35 pass; carrier/wire tests 14/14 pass; independent plugin source-combination suite reported 74/74 pass. No live personal Tunnel or product deployment.

## Continuation round 3 context writers and authentication projection

All three mirror creation callsites now use one `mirrorOriginOf` constructor; it uses registry `machine.id` and computed canonical target (also fixes old tunnel rw_pick_workspace id loss). mirrorEntries preserves hostless strict schema3 intent even when malformed; cwd context retains descriptor metadata. File-reference and auto-push owner lookup use machineForMirror rather than ambiguous triples; file-reference awaits the pool correctly.

Internal record module exports a whitelist browser sanitizer with passwordSet/passphraseSet and registered connector redaction. Plain/data-property boundaries and auth types reject coercion/accessors. Ordinary CRUD remains gated.

Tests: file-reference/workspace regressions 40 pass; provider/record regressions 18 pass. Full-suite investigation found nine Provider fixture failures relying on obsolete v1 localhost triples; corrected fixtures to v2 ownership and explicitly require missing stable owner id to reject. Both provider suites now pass 11/11. Screenshot PIL failure remains an environment limitation, not claimed passed.

## Continuation round 4 pool cache and probe lifecycle

Added internal carrier-only stable cache with concurrent acquire deduplication, immutable record snapshots, revision invalidation, carrierClosed detection, late-acquire cleanup, and explicit unload. No TTL forced shutdown for carrier pools, so a live PTY is not closed merely because the ordinary SSH route cache expires. Factory close still invalidates all pool-owned terminals before reachability release. Cache is not yet wired to ordinary routes.

Fresh ordinary SSH test-connect probes now close in finally even if connect/exec fails; route-level failure test verifies cleanup. Cache/race/probe tests: 7 pass, static/whitespace gates clean.

## Continuation round 5 explicit sandbox admission

`experimentalSshCarrier` Config flag defaults false. Explicit opt-in enables normalized connector CRUD and carrier-cache dial; normal/default profiles still reject. V1 onboarding rejects new password/passphrase storage and uses SSH agent/private-key configuration. Saved target/pin cannot change in place; update/delete invalidates owned pools. Hostless contexts are accepted by tool/mirror target checks without manufacturing localhost identity.

Route integration tests cover add/update/target-change refusal, save-without-activation, schema3 mirror creation through real apply and fixture SFTP, then delete. Ordinary test-connect still refuses connector probe until fresh connector probe is implemented. UI capability remains not ready, no deployment.

Validation: combined admission/provider/workspace/cache/record/wire tests 44 pass, 2 credential tests skipped; static/whitespace clean.

### Round 5 lifecycle correction

Real installed Cordis source (`runner.execute` then collect returned function) confirmed effect setup executes immediately. routePools effect corrected to return cleanup rather than invoke it at load. Provider unload fixture exercises that setup contract. Cross-workspace plugin apply fixture now does the same; all 79 plugin tests pass. Parent provider/admission regressions 18 pass, 2 credential skips. Extra carrier port forwards and per-workspace disconnect explicitly reject for now to avoid shared-machine teardown or unrelated global forwarding.

## Continuation round 6 fresh probes and terminal target guards

Explicit opt-in test-connect now uses a fresh pinned carrier factory (never config-host fallback/cache). Unknown saved id, missing pin, incompatible credentials fail before dial; finally releases on success and exec failure. Hostless request contexts route to their saved machine, refusing a missing mirror owner rather than shared SSH. Status/mirror display and Git cache keys use canonical identity.

Managed terminal ownership snapshots descriptor identity and validates it after awaits and every live access; target rebound under the same machine/workspace cannot resume a different target. Legacy ownership shape preserved. Targeted terminal suite 35 pass; fresh probe/admission tests 4 pass; combined route/workspace/wire suite 27 pass, 2 credential skips.

## Continuation round 7 real route wire and capability distinction

Added real loopback SSH Server + actual apply/rw_exec carrier route tests (ephemeral in-memory host key, isolated test-only credentials, no personal SSH state): 4 pass. Proves remote marker, two-ID pool isolation at same endpoint, same-ID reuse, strict mismatch before auth/exec, missing provider/disabled flag/no-context zero direct fallback and release at unload. SFTP and real agent onboarding are separately unverified.

GET status exposes `sshCarrierCapabilities` from each instance's explicit Config, including workspaceSupported/freshProbe and productionReady=false. Plugin strictly parses status instead of guessing from registry; 82 plugin tests pass. Carrier legacy terminal backend rejects in favor of managed workspace terminals with target guards. Additional forwards, per-workspace disconnect and remote DSH Web deploy explicitly unavailable for now.

Final current-tree parent full suite with bundled Python/Pillow PATH: 675 pass, 0 fail, 2 credential skips (677 total, exit 0). Earlier PIL failure was environment resolved without installing packages.

## Continuation round 8 actual framework boot and package

Real installed Cordis Context/plugin/effect/Fiber test verifies actual dsh-remote boot with optional services absent, no early acquisition, pending carrier acquire aborted on unload, exactly-once late release, and registry unload. One test pass, no fake context/effect, no browser/server/product profile.

Missing/invalid saved carrier serialization now degrades to a whitelist unavailable marker without raw connector/auth leak; default settings continue loading if plugin absent. Browser resolve-mirror preserves schema3 owner identity, not host requirement. Targeted checks pass.

Independent plugin actual experimental tarball produced in its own `.dsh/artifacts` (not installed): dsh-devtunnel-ssh 0.0.1-experimental, 14 files, SHA256 dacec4eb229eccd38d645548b2ca9e8ac8396ca4a23603df1b97f6ec83c51487. Includes help command and packaged MANUAL, no secrets/tests/archive. Plugin 82 pass. Managed automatic startup is not enabled from entry; initial deliverable is external/manual, explicit sandbox opt-in. Final parent full-suite rerun: 677 pass, 0 fail, 2 credential skips (679 total, exit 0).

## Continuation round 9 adversarial delivery audit

Independent read-only audit identified reconnect strict-orphan fallback, carrier reconnect cache refresh, and asynchronous close ordering. Fixed: strict orphan/malformed owner reconnect terminates, explicit carrier reconnect invalidates owned cache, factory awaits async close before releasing reachability even on failure. Presence-vs-truthiness gates hardened so null connector cannot downgrade/probe/deploy as direct SSH. Added regression tests (2 route guards and 10 carrier lifecycle tests pass); no remaining proven pin bypass/browser leak in scoped audit. Final audited all-suite rerun: 680 pass, 0 fail, 2 credential skips (682 total, exit 0).

## Remaining gates

See [integration audit](<ssh-carrier-integration-audit.md>): stable mirrors, machine CRUD, all dial entrypoints, lookup fences, probe cleanup, pool invalidation and terminal ownership must be complete before exposing connector machines to normal sessions. Registry/factory capability is not equivalent to that end-to-end capability.
