# SSH probe diagnostics (owner development API)

This is an authenticated, read-only view of recent **test-connect** probes, not general SSH logging. No request starts SSH, CLI, retries or extra diagnostics. Records are process-memory only and are cleared on plugin disposal/restart.

## Request

`GET /dsh-remote/probe-diagnostics?machineId=<saved-id>&after=<sequence>&limit=<count>`

Use the current host's authenticated session. The endpoint uses the same `connection.requestRejection` authority as the host routes and additionally fails closed with 503 `AUTH_UNAVAILABLE` if that authority is unavailable. It sends `Cache-Control: no-store`. POST/other methods return 405. Unknown/duplicate query keys and invalid numbers/IDs return 400 `INVALID_QUERY`.

All parameters are optional:

- `machineId`: exact machine identity, `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. Saved-only probes include it. Unsaved draft probes are discoverable unfiltered by their probeId.
- `after`: exclusive sequence cursor; default 0, integer 0 through Number.MAX_SAFE_INTEGER.
- `limit`: 1–200, default 50.

## Response

```json
{
  "ok": true,
  "events": [{
    "seq": 1,
    "probeId": "generated-uuid",
    "event": "probe.start",
    "machineId": "saved-id",
    "at": 1791620000000,
    "elapsedMs": 0,
    "phase": "validation"
  }],
  "latestSeq": 1,
  "oldestSeq": 1,
  "nextAfter": 1,
  "hasMore": false,
  "truncated": false,
  "retention": { "maxEvents": 200, "maxProbes": 20 },
  "retainedProbes": 1
}
```

Events are ascending by sequence. Repeat original filters with `after=nextAfter` while `hasMore`. `latestSeq` is the global high-water mark; `oldestSeq` is the earliest retained event (null when empty). `truncated` flags a nonzero cursor older than available retention; gaps can also reflect machine filtering/probe eviction, so do not assume complete history. Retention is bounded by both 200 events and 20 most recently started probes. There is no persistence or public mutation/clear endpoint.

The existing POST `/dsh-remote/test-connect` response adds `probeId`, preserving its previous ok/error/result fields. Use that ID to correlate all events of one probe in an unfiltered or machine-filtered page.

## Timeline and safe fields

- `probe.start`
- `carrier.acquire.start` / `carrier.acquire.complete` (carrier probes only)
- `pool.connect.start`
- `ssh.identification`
- `ssh.handshake.complete` (key exchange finished, **not authentication ready**)
- `ssh.ready` (authentication ready)
- `exec.start` / `exec.complete` (`true` probe only, no arbitrary command output)
- `probe.success` or `probe.failure`
- `pool.close.start` / `pool.close.complete` or `pool.close.failure`

Carrier completion may include validated loopback `endpoint:{host,port}`, UUID `generation` and `reusedGeneration`. Reuse is confirmed against an existing owner cached pool generation when available; otherwise it means that generation was previously observed in retained diagnostics, not proof of a currently active business lease.

Identification may include only protocol `2.0` or `1.99`. No server software name, header/banner, handshake object, algorithm object, raw ssh2 debug text, username, password, passphrase, private key/path, token, agent/socket environment or remote command output is stored. ssh2 1.17 exposes `handshake` and `ready` separately, but no public remote-header event. The probe's internal debug callback recognizes only the fixed `Remote ident:` milestone, optionally extracts the protocol enum, and immediately discards the raw string. It never forwards raw debug to the sink.

Failure includes the last `phase` and safe `code`: `TIMEOUT`, `AUTHENTICATION_FAILED`, `HOST_KEY_REJECTED`, `CONNECTION_REFUSED`, `CONNECTION_CLOSED`, `TARGET_BUSY`, `INVALID_REQUEST`, or `UNKNOWN_ERROR`. Unknown upstream errors never appear verbatim in this API. A `TIMEOUT` before `ssh.ready` is **not evidence of a public-key problem**. No diagnosis of the user's actual fault is possible without its actual correlated trace.

Diagnostic sinks are best-effort and cannot break the SSH operation. Probe finally cleanup releases only the probe carrier reference, and also closes a failed/pre-ready probe Client. Business pools, timeout values and retry/replay policy are unchanged.

## Validation

Tests use real probe route source, carrier pool wrapper and SshPool with a fake ssh2 Client; no CLI or remote/user credential I/O. Production failure reproduction, deployment and GUI restart are separate authorized operations.
