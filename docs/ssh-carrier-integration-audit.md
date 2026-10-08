# SSH carrier integration audit

Read-only review performed 2026-10-07. Implementation files were not edited. This report is the sole new deliverable. Parent concurrently edited the carrier/trust extension, so line references below identify reviewed callsites and may shift; symbol names are the durable anchors.

## Shipping boundary

**First ship only the experimental SshPool factory/carrier + strict host-trust public contract. Do not expose carrier machine CRUD, UI, mirror creation or saved-workspace routing until the identity gates below pass.** An independent devtunnel plugin may acquire a carrier and reuse SSH/SFTP/PTY, but this does not establish complete dsh-remote registry integration.

Execution remains `transport: 'ssh'`. Connector/carrier registration is independent of the execution provider. Never register devtunnel as `vscode-tunnel` or silently downgrade a malformed/unavailable connector to direct SSH.

Suggested persisted descriptor (next phase): stable registry `id`, SSH auth fields, `connector: { kind, tunnelId, remotePort }`, mandatory expected SSH fingerprint. Endpoint, generation, leases and CLI secrets are runtime-only. Persisted target changes must invalidate trust/bindings or require explicit re-verification; changing a loopback port is not a target change.

## Gate 1 — experimental factory and strict trust

Both actual SSH dial paths need carrier coverage:

- [SshPool pooled connection](<../lib/pool.js#L102-L171>): `_doConnect`, new ssh2 Client, `_buildConnectOpts`, `client.connect`.
- [Dedicated PTY connection](<../lib/pool.js#L481-L539>): `openPty` creates another Client and calls `client.connect`; hooking only pooled connect is insufficient.
- Recursive proxy pools are constructed in [pooled proxy handling](<../lib/pool.js#L115-L138>) and [PTY proxy handling](<../lib/pool.js#L487-L514>). Reject connector plus proxy for V1, or explicitly strip carrier fields from bastion-owned configuration. Spreading carrier config into a proxy pool must not misroute the bastion.
- [Connect options](<../lib/pool.js#L180-L190>) must dial only the acquired endpoint, while host verification uses a stable logical identity and mandatory expected fingerprint. Unknown kind, absent resolver, malformed lease or cancelled acquisition must fail before any `Client.connect`.
- [Host-key logical identity and strict pin](<../lib/hostkey.js#L48-L105>) were observed while parent was implementing them. Missing/mismatched pin must fail even with direct-SSH `hostKeyMode: off` or `accept-new`.

Lifecycle contract:

1. Ordinary pooled SSH connection owns one carrier lease.
2. Each independent PTY owns its own lease. `openPty` initially calls `detect`, which can first connect the pooled client; tests must account for both acquisitions.
3. Release once on failed handshake, SSH close, explicit PTY end, cancellation, teardown and late acquisition result after cancellation.
4. Pool invalidation/reconnect must not release a live PTY's lease. Preserve existing terminal independence.
5. Carrier endpoint rotation must not replay exec, file writes or terminal input with unknown outcome.

[ForwardManager](<../lib/forwards.js#L117>) and [WebAttach](<../lib/web-attach.js#L275>) use `pool.connect`; central SshPool carrier acquisition protects them. The reverse-forward `net.connect` at [forwards:176](<../lib/forwards.js#L176>) is intentional traffic forwarding, not a machine dial fallback. URL parsing bases such as `http://localhost` are not network dials.

Tests required before experimental release: both dial entrypoints covered; connector unavailable means zero direct dial; concurrent acquire behavior; pooled close versus PTY independence; failure/close/end release exactly once; cancellation and late release; logical fingerprint stable across local endpoint swaps; old direct SSH remains unchanged. Real two-host SSH/SFTP/PTY proof is still required before claiming devtunnel support, per [development standards](<../scripts/dev-standards.md#L34>).

## Gate 2 — stable identity and mirror schema (before CRUD exposure)

Use a new strict mirror version, e.g. `schemaVersion: 3, transport: 'ssh', machineId, connectorTargetIdentity` or a canonical target revision/hash. Resolve these mirrors only by saved id plus execution transport and connector target identity. A missing id/record/connector or target mismatch must never degrade to legacy host/user/port lookup.

Keep legacy direct SSH v1 and vscode-tunnel v2 compatibility. A connector mirror does not need a fake localhost origin.

| Callsite | Current risk | Minimal next-phase change |
|---|---|---|
| [binding `resolveMirror`](<../lib/binding.js#L80-L100>) | Requires host and retains stable id only for non-SSH transport. | Recognize strict v3 independently of transport; preserve strict marker/id/target even when owner cannot resolve; avoid fake host requirement. |
| [binding `poolKey`](<../lib/binding.js#L114-L116>) | Always user@host:port. | Stable carrier id + target revision; legacy direct SSH key unchanged. |
| [remote-path mirror scan](<../lib/route-machine.js#L51-L66>) | Normalizes SSH user/port and passes transport fields without strict SSH meaning. | Pass validated v3 identity; never convert runtime endpoint to identity. |
| [mirror owner resolution](<../lib/route-machine.js#L128-L143>) | Every SSH origin resolves by triple. | Strict SSH carrier branch resolves id/target only. Legacy triple branch excludes connector and non-SSH registry records. |
| [mirror preference](<../lib/route-machine.js#L82-L87>) | Current-machine preference compares triples. | Compare strict identity for v3. |
| [mirror root and writer](<../lib/index.js#L268-L318>) | Stable root/v2 writer only for vscode-tunnel. | Stable carrier root such as ssh-carrier-id; v3 meta writer; do not persist endpoint. |
| [index mirror registry scan](<../lib/index.js#L337-L361>) | Host required; id carried only for non-SSH. | Accept validated v3 id identity independently of host/transport. |
| [workspace context](<../lib/index.js#L792-L813>) | Mirror context carries host/user/port, drops strict target descriptor. | Preserve strict origin throughout routing and writers. |

All mirror writers must use the same context descriptor: [rw_pick_workspace](<../lib/index.js#L2281-L2289>), [workspace route](<../lib/index.js#L3625-L3650>), [mirror route](<../lib/index.js#L3675-L3699>). `rw_pick_workspace` currently reads `ctx.machine.machineId`, but registry records use `id`; use `ctx.machineId` or `ctx.machine.id`. [Status local mirror computation](<../lib/index.js#L1855-L1856>) must receive the same stable identity.

## Gate 3 — registry, pools and all routing entrypoints

### Pool factory and cache ownership

[Persistent machine pools](<../lib/index.js#L923-L1017>) dispatch only non-SSH providers; SSH pools key by host:port:user. Route carrier machines to the experimental SshPool factory using stable logical identity, pin and lazy carrier resolver. Factor one cache-key helper used by creation, update, delete, reconnect and status. Keep direct SSH compatibility; distinguish carrier ids even if runtime endpoints are identical.

Validate registry target revision after awaited credential/acquisition work. Updating credentials or connector descriptor must evict the intended pool. Existing [delete cleanup](<../lib/index.js#L3999-L4002>) only looks up a triple and misses provider entries as well. A target change must not silently retarget an existing mirror or terminal.

[poolForMachine](<../lib/index.js#L1030-L1037>) currently fabricates a direct SSH record for an unresolved SSH mirror. Allow that only for genuine legacy direct-SSH v1; strict v3 must reject. [routePoolOf](<../lib/index.js#L1044-L1067>) currently returns the shared pool when no mirror matches; preserve legacy unscoped behavior only where intentional, never for a request that carries strict carrier ownership.

### CRUD and test-connect (do not expose yet)

[Machine admission](<../lib/index.js#L3812-L3893>) is hardcoded to SSH/vscode-tunnel. [SSH record reconstruction](<../lib/index.js#L3902-L3930>) drops connector, explicit SSH transport and expected fingerprint. Future integration needs a narrow normalizer/validator, explicit preservation on partial updates, and rejection of unknown kind, proxy/SSH-config combinations, malformed target and unsafe transport/connector transitions. Do not persist arbitrary nested client objects or endpoints. Saving must remain standby, not activate a workspace.

[Test-connect](<../lib/index.js#L4015-L4084>) directly constructs `new SshPool` and falls back to profile host/port while ignoring connector/transport. Future route must resolve explicit saved id, reject unknown id, merge only validated editable fields, and use the same connector-aware fresh factory. Resolve saved credentials when the form has no new password. Never let carrier testing use `body.host || config.host`. Put probe cleanup in `finally`; current cleanup is success-only. Update latency by stable id rather than endpoint matching.

### Hidden triple lookup/upsert entrypoints

Fence legacy triple matching to direct SSH records only (`transport` defaults to SSH, **no connector**):

- [machineByTarget](<../lib/index.js#L629-L630>).
- [identityMatches and machineRecordFor](<../lib/index.js#L745-L757>).
- [rw_connect upsert](<../lib/index.js#L2215-L2222>): it spreads a matching saved record, so a direct request to a placeholder triple can overwrite/bind a carrier record. Keep rw_connect direct-only unless explicitly extending its API to saved-id carrier resolution.
- [rw_connect reconnect key](<../lib/index.js#L2237-L2239>): use the central cache helper.
- [Auto-push owner lookup](<../lib/index.js#L1709-L1717>): replace triple lookup with strict mirror owner resolution.
- [Remote file-reference owner/cache](<../lib/index.js#L2014-L2027>): strict owner resolution and stable key required. Also `poolForMachine` returns a promise; `listDir` currently calls `p.sftp()` without awaiting it.

Non-dial identity consumers also need alignment: [Git machine cache key](<../lib/index.js#L1205-L1208>), [connected status](<../lib/index.js#L1842-L1845>), [known-host status](<../lib/index.js#L1879>) and [audit identity](<../lib/index.js#L1610-L1612>). Otherwise carrier operations can be correctly dialed yet status/trust/caches identify the wrong target.

## Gate 4 — terminal ownership and carrier lifecycle

The [legacy WS route](<../lib/index.js#L4677-L4689>) already requires a mirror-owned saved machine, overrides requested cwd with the canonical workspace, and scopes resume by mirror/id. Preserve those gates.

A hidden fallback remains: [index terminal getPool](<../lib/index.js#L1666-L1669>) returns null for deleted id, then [TerminalManager `_poolFor`](<../lib/terminal.js#L191-L197>) returns its shared default pool. For a named machine, missing resolver/record/pool must reject. Only intentionally unnamed legacy sessions may default.

Preserve [late PTY cleanup](<../lib/terminal.js#L219-L222>) and [idempotent kill](<../lib/terminal.js#L467-L483>). Legacy terminals support close-kill, park indefinitely, socket-drop grace, and automatic respawn; carrier integration must not accidentally change those semantics.

[ManagedTerminalManager](<../lib/managed-terminal.js#L75-L100>) checks current owner pre/post openPty and sanitizes errors. Keep this. Both terminal owner contracts currently focus on machine id/workspace. If connector target can change under the same id, add target revision to ownership checks or explicitly invalidate old terminals: automatic respawn must never move an old tab to a new target.

## Acceptance matrix for next continuation

1. **Mirror/schema:** v3 SSH carrier id/target survives every reader and all three writers; two ids with identical triples never collide; local-port rotation retains same mirror; missing/deleted/mismatched owner refuses with zero direct dial; unchanged v1/v2 fixtures.
2. **CRUD:** normalized descriptor and pin round-trip and sanitize; no endpoints/secrets; invalid connector and alias/proxy combos rejected before persistence; save does not activate; target changes cannot reuse old trust/mirrors unnoticed.
3. **Probe:** explicit id and descriptor reach fake carrier; profile localhost is a trap and never dialed; missing provider/invalid connector/unknown id make zero dial attempts; saved credential resolver works; success and exec-failure both close fresh probe.
4. **Lookup fence:** direct rw_connect cannot overwrite carrier/non-SSH records; auto-push, file references, Git and request-bound FS use strict owner; file-reference promise is awaited.
5. **Cache:** two carrier ids sharing endpoint have distinct pools; endpoint rotation does not alter logical identity; update/delete closes the correct pool without impacting another workspace.
6. **Terminal:** missing named pool never opens default PTY; pooled detection and independent PTY acquisitions have correct lease counts; pool close leaves PTY alive; explicit end/channel close releases once; teardown while acquisition pending releases late lease; target revision change blocks resume/respawn.
7. **Trust:** swapping local ports cannot swap logical fingerprints; invalid/missing/mismatched pin rejected even with permissive direct policy.
8. **Real integration:** two-host SSH/SFTP/PTY and outage/unload proof, not only mocks; no localhost fallback and no replay of unknown-outcome writes/commands.

Existing focused baseline executed:

```sh
node --test test/binding.test.js test/route-machine.test.js test/terminal.test.js test/managed-terminal.test.js
```

Result: **47 passed, 0 failed**. This proves only existing regression behavior, not the proposed carrier integration. Useful future fixtures include [machine transport tests](<../test/machines-transport.test.mjs>), [mirror machine identity tests](<../test/mirror-machine-identity.test.js>) and [managed SSH terminal tests](<../test/managed-terminal-ssh.test.js>).

No deployment, live SSH connection, product profile mutation or source edit was performed by this reviewer.
