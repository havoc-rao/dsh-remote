# Git workspace marker machine contract

Producer: `GET /dsh-remote/git-workspace` in dsh-remote. This projection is
owned by dsh-remote, not by an SSH carrier plugin. A schema3 SSH carrier mirror
still uses this route; a carrier provides reachability/lease only. Mirror meta
schemaVersion 3 and the machine projection version below are independent.

## Response and machine projection v2

Successful response envelopes and Git state remain unchanged. Passive probe
unavailability adds an optional `probe` envelope (see below):

```ts
{ ok: true, marker: null | {
  machine: null | {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    schemaVersion: 2;
    transport: string;
    displayName: string;
    carrierKind?: string;
    endpoint?: { host: string; port: number; username: string };
  };
  mirrorDir: string | null;
  remotePath: string;
  root: string;
  isRepo: boolean;
  at: number;
  // Repo snapshots also carry existing branch/detached, dirty, staged,
  // ahead, behind and optional upstream/gone fields.
} }
```

`machine.id` is the saved registry machine identity, not a dial target. It is
non-empty for a saved owner; the legacy empty string remains permitted for
records lacking an id. `name` retains the configured name. `transport` defaults
to `ssh` only for legacy direct SSH records. `displayName` is producer-computed:
trimmed non-empty name → id → direct SSH configured host/alias → transport.
Consumers should use it for the machine label.

`endpoint` is optional and emitted **only** for direct SSH with a non-empty
configured host. Its host may be an SSH-config alias rather than a resolved
hostname. It is descriptive, not permission or connection configuration.
For SSH with a connector, `carrierKind` contains the connector kind when
available, `endpoint` is absent, `host` is the explicit empty string, and
`port` is the legacy compatibility default 22. The latter is **not** the SSH
port in the tunnel descriptor or an ephemeral local listening port.
Connector records, target descriptors, runtime lease identity/generation,
dialHost/dialPort and credentials are never projected.

Other transports (e.g. vscode-tunnel) have no endpoint/carrierKind. Their
pre-existing host/port/username values are retained for backwards compatibility
(including historical placeholders); none is a usable address. New consumers
must never interpret those legacy fields as an endpoint. This is deliberately
less disruptive than normalizing all previously shipped non-SSH fields.

### Serialized examples

Direct SSH:

```json
{"id":"direct","name":"Direct SSH","host":"example.org","port":2202,"username":"alice","schemaVersion":2,"transport":"ssh","displayName":"Direct SSH","endpoint":{"host":"example.org","port":2202,"username":"alice"}}
```

SSH carrier (the persisted record has no top-level host or port):

```json
{"id":"carrier","name":"Carrier SSH","host":"","port":22,"username":"alice","schemaVersion":2,"transport":"ssh","displayName":"Carrier SSH","carrierKind":"devtunnel"}
```

## Compatibility and rendering

- v2 is additive. `id/name/host/port/username` remain present with their old
  primitive types, including **host:string after JSON serialization**. Direct
  SSH legacy field values/defaults are unchanged. Old structural consumers
  accepting additional keys no longer reject hostless carrier markers. Exact
  key validators must allow these additive fields.
- Old consumers should render a configured name/id when host is empty, not an
  address like `alice@:22`. Empty host is intentional, not a missing field.
  Consumers using this Git display payload for connection routing are unsupported.
- New consumers validate schemaVersion 2 and the common fields; optional
  endpoint/carrierKind are checked only when present. Render displayName first;
  if endpoint exists, optionally show its SSH address. Otherwise display the
  transport (and carrierKind when present), never synthesize a localhost address.
  Compare saved machines by id, never by compatibility host/port/username.
  No consumer needs connectorTargetIdentity to display or route this marker;
  strict mirror ownership remains producer-owned and canonical-target checked.
- Old responses without schemaVersion remain legacy: validate the old fields,
  use name/id/host fallback, do not invent transport/carrierKind/endpoint or infer
  a carrier from a missing host. Previously broken hostless legacy payloads
  remain invalid; roll out the producer fix rather than concealing them.
  Unknown explicit versions should be handled as unsupported, not silently
  parsed as v2. A future incompatible projection requires a new version.
- Repo and nonRepo markers share **the same machine projection**. NonRepo
  means `isRepo:false`, not marker:null or machine:null. Existing marker:null
  semantics apply only to non-mirror/orphaned local paths; a path routed through
  the unsaved shared pool may legitimately have machine:null as before.
- Successful markers retain the existing 5-second per-machine/path TTL cache.
  This projection does not replace or weaken schema3 mirror ownership checks
  or use lease endpoints as stable identity.

## Passive probe unavailability

The marker route is a background decoration, not a connect/start command. It
only uses an existing dsh-remote-owned ready SSH connection with known platform.
It never acquires a carrier lease, starts a managed channel, establishes a new
SSH connection, runs platform detection, or reconnects/replays an SSH command.
Explicit user operations still own their existing connection/recovery lifecycle.
Non-SSH provider handles are conservatively unavailable because the current
public provider contract does not guarantee passive/no-replay execution; no
provider-specific/private status API is used. This is an intentional boundary:
those transports need a public passive probe capability before decorations can
query them without risking connection side effects.

Expected unavailable states return HTTP 200:

```ts
{
  ok: true;
  marker: null;
  probe: {
    state: 'unavailable';
    reason: 'connection_unavailable' | 'connection_not_ready' |
            'connection_offline' | 'probe_timeout';
    retryAfterMs: number; // integer, 1..30000
  };
}
```

Reasons are stable and sanitized: no endpoint, lease, connector, credentials or
raw exception text. `connection_unavailable` means no existing pool;
`connection_not_ready` means no ready SSH client/known platform, a closed lease,
or expected auth/trust prerequisites; `connection_offline` covers recognized
network/channel failures; `probe_timeout` covers recognized timeouts.
`marker:null` **with probe** means unknown remote Git state, never local/nonRepo.
Legacy null **without probe** continues to mean a non-mirror/orphan local path.
Only an actual successful repo probe or recognized Git nonRepo exit produces
`isRepo:false`. Unknown exceptions (including TypeError/ReferenceError) remain
HTTP 500 with the existing diagnostic/error response; they are not cached.

The backend negative cache is machine-scoped, at most 128 entries, for 30 seconds.
All paths on that machine share the pause; returned remaining retryAfterMs is
positive and bounded. Each request passively observes the current SSH client:
a new ready client object clears the pause early (e.g. after an explicit remote
operation reconnects). Expiry permits another passive check, not connection
acquisition. `refresh=1` bypasses positive marker TTL only, not this pause.
No timers, keepalive or Dev Tunnel private APIs are involved. The dsh-remote
browser consumer honors retryAfterMs capped to 30 seconds and renders no chip;
its own cached pause may delay visibility after recovery up to that bound.
Other consumers should retain remote identity and not fall back to local Git.

## Validation scope and deployment

`test/git-workspace-machine.test.js` executes the current production route
handler with isolated pool/Git doubles and a JSON.stringify/JSON.parse boundary.
The carrier fixture comes from the actual normalizer. It covers direct/carrier
repo and nonRepo responses, caching, other transports, ephemeral endpoint
exclusion, orphan handling and whitelist projection. This is not a live
personal devtunnel or authenticated product HTTP test. Product profile version
and authenticated raw response must be checked after an explicitly authorized
deployment/restart; source regressions passing do not establish live recovery.
