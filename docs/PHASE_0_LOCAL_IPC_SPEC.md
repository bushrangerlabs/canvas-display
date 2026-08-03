# Phase 0 local IPC specification

## Status and scope

**Normative reference; reviewed 2026-07-31.** This document defines the local IPC boundary
between the Canvas Edge
Agent (the trusted, privileged process holding the device identity and durable state) and its two
local peers — the unprivileged Tauri renderer, and a separately supervised, narrowly scoped
updater/helper process — exercised by `tests/local-ipc/`. It answers threat-model item P0-04 and
is the detailed design ADR 0003 defers to. The daemon now implements the Unix-socket transport,
peer credential checks, capability token, and method allowlist.

Active targets remain Linux `amd64` and `arm64`. Android remains frozen.

## Why this exists

ADR 0003 decided that the Agent, not Tauri/the renderer, owns the device private key, durable
command state, and hardware/media supervision, connected only through "peer-authenticated,
method-scoped local IPC." That sentence has real security weight — this document says exactly
what "peer-authenticated" and "method-scoped" must mean, and threat model item P0-04 requires
evidence (wrong-peer, stale-capability, hostile-WebView, key-read, and privileged-method tests)
before this is treated as closed.

## Transport (Phase 1 implementation requirement, not modeled here)

- A Unix domain socket at a fixed filesystem path (for example `/run/canvas-edge/agent.sock`),
  inside a directory owned by the Agent's service user with mode `0700`; the socket itself is
  mode `0600`.
- No TCP/loopback listener is used for this boundary. It is filesystem/credential-scoped, not
  network-scoped.
- Immediately after accepting a connection, the Agent reads the connecting process's credential
  (`SO_PEERCRED` on Linux: uid, gid, pid) before processing any application-level message. The
  peer never gets to self-report its role.
- Two disjoint dedicated service users are required: one for the renderer/Tauri process, one for
  the updater/helper process. The Agent's own configuration is the only place that maps a uid to a
  role; there is no code path where a peer can claim a role.

## Peer identity and role resolution

- A connecting uid that does not match the configured renderer uid or updater uid is rejected
  immediately (`wrong_peer`), before any capability token is issued. This is the first line of
  defense against any other local process — including a compromised WebView-adjacent process
  that is not literally the renderer — trying to reach the Agent directly.
- `pid` is recorded for audit only. It is never used for trust decisions, since pids are reused
  and easily spoofed in intent (a legitimate renderer restart also gets a new pid).

## Capability lifecycle and generation fencing

- Every successful peer connection starts a new **generation** for that role — a monotonically
  increasing counter, tracked independently per role (renderer generations and updater
  generations do not interact).
- On each new generation, the Agent issues a fresh, random capability token scoped to that
  generation and immediately marks every previously issued token for that role as revoked —
  without needing an explicit out-of-band revocation call. A renderer crash/restart therefore
  fences out the previous process's capability automatically (`stale_capability`), which matters
  because a crashed renderer process, or its socket file descriptor, could otherwise remain
  reachable by something else for a window of time.
- Capability tokens are opaque, random, and single-purpose; they are never derived from or
  reducible to any other secret (in particular, never the device private key).

## Method allowlists (defense in depth against a hostile WebView)

- The renderer and updater channels have completely disjoint method allowlists. There is no
  method that is valid for both roles.
- Renderer methods are a small, fixed set of current-behavior-equivalent actions: scene
  activation, media session control, and hardware brightness get/set/capability query. This list
  only grows through an explicit, reviewed change to the allowlist — never implicitly through
  capability scope alone.
- Updater methods (`updater.install_package`, `updater.rollback`, `updater.health_report`) are
  never reachable from a renderer-scoped capability token, even if that token is otherwise valid
  and unexpired. Method-scope enforcement is intentionally independent of "is this token valid" —
  it is a second, unconditional check. This is what stops a hostile WebView (or any other content
  that ends up adjacent to the renderer process and somehow obtains a copy of its capability
  token) from pivoting to a privileged operation: the check that would reject an attacker is the
  same check that would reject a legitimate renderer bug, so there is no special-cased trust to
  bypass.
- Updater methods additionally require a single-use nonce per request. A reused nonce is rejected
  outright (`nonce_replayed`), independent of an otherwise-valid capability token — this maps
  directly to threat UPD-05 (a compromised Agent/renderer must not be able to invoke arbitrary or
  replayed privileged updater operations).

## Key material isolation

- The Agent's device private key lives in a store with no method that returns key bytes under any
  role or method name. Signing operations return only an opaque signature over a caller-supplied
  digest.
- No renderer or updater method name is ever wired to key material, by construction: the
  dispatcher has no reference to the key store at all. This is checked directly in the executable
  model (a structural assertion, not just a behavioral one) and by attempting a set of
  plausible-sounding hostile method names (`agent.export_private_key`, `debug.dump_key`, etc.),
  all of which fail the same `method_not_allowed` check as any other out-of-scope method.

## Renderer restart behavior

- The Agent must remain connected to Core and continue owning durable state (outbox sequence,
  hardware desired state, pending commands) across a renderer crash or restart. A renderer
  restart is a routine, expected event — not a failure the Agent needs to recover from — and it
  must never cause loss or replay of Agent-owned state.
- After a restart, the renderer reconnects, authenticates via peer credential as before, and
  receives a fresh capability token bound to its new generation. It does not "resume" the
  previous generation's token.

## Privileged updater/helper boundary

- The updater/helper is a separate process from both the Agent and the renderer, supervised
  independently (see ADR 0003), so that it can recover the Agent even
  if the Agent itself fails to start.
- It reaches the Agent (or the Agent reaches it — the exact direction is a Phase 1 implementation
  detail) only through the disjoint updater method allowlist described above, never through the
  renderer's allowlist, and never with root-equivalent access implied merely by holding a valid
  capability token.

## Sandbox posture (Phase 1 implementation requirement, not modeled here)

Production Agent/renderer/updater processes must run under systemd hardening consistent with the
update/rollback design, at minimum:

- dedicated, non-root service users for the Agent, renderer, and updater, with no shared uid;
- `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true` (with narrow explicit
  exceptions for required paths only), and `PrivateTmp=true`;
- the socket directory and socket file are not world-readable/writable;
- the updater/helper is granted only the minimal privilege actually required for package
  install/rollback/reboot, not general root.

## Executable evidence

`tests/local-ipc/local-ipc.test.ts` covers:

- wrong-peer rejection for any uid that is not the configured renderer or updater;
- successful dispatch of allowlisted methods for both legitimate roles;
- privileged-method rejection in both directions (renderer cannot call updater methods and vice
  versa), including updater nonce requirement and nonce-replay rejection;
- stale-capability rejection after a renderer restart advances the generation, and for a
  never-issued/forged token;
- hostile-WebView-style pivot rejection using a structurally valid, leaked renderer token against
  an updater-only method, and direct wrong-uid connection rejection;
- key-read: every plausible hostile method name is rejected, the key store never returns key
  material, and the broker has no reference to any key store at all;
- Agent-owned durable state (modeled as an outbox sequence counter) survives a renderer restart
  unchanged.

Run with `npm run test:local-ipc` or the complete `npm run test:contracts` gate.

## Production gates still open

- Real dedicated service-user provisioning during packaging/installation.
- Complete every advertised renderer action with a real Edge handler or explicit unsupported
  capability response.
- Production updater feed, rollout, and independent supervision acceptance.
- Load/fuzz testing of the real socket transport (malformed frames, oversized payloads, slow-loris
  style connection abuse).

The kiosk's local Display server and `useServerSocket.ts` coexist with this boundary by design.
