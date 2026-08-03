# Phase 0 local IPC model

This isolated Node 20 model freezes the Canvas Edge Agent's local IPC boundary against the Tauri
renderer and the privileged updater/helper process (threat-model item P0-04, ADR 0003). It does
not open a real Unix domain socket, call `SO_PEERCRED`, or implement real systemd sandboxing —
those are Phase 1 transport/OS integration work. It proves the design contract those integrations
must satisfy.

Coverage includes:

- peer identity is established only from an out-of-band credential (the modeled equivalent of
  `SO_PEERCRED` uid/gid/pid), never a self-reported role — an unrecognized uid is rejected before
  any capability is issued (`wrong_peer`);
- every method call is checked against a fixed, disjoint, role-scoped allowlist (renderer vs.
  updater), independent of whether the capability token is otherwise valid — this stops a
  compromised/hostile WebView (or any code adjacent to the renderer) from pivoting a leaked
  renderer token into a privileged updater method (`method_not_allowed`);
- renderer capability tokens are bound to a monotonically increasing connection "generation";
  a renderer crash/restart immediately fences out the previous generation's token, with no
  separate revocation call required (`stale_capability`);
- the privileged updater channel additionally requires a single-use nonce per request and
  rejects nonce replay;
- the Agent's device private key is never reachable through any IPC method for any role, and the
  key store itself only ever returns opaque signatures, never key bytes;
- Agent-owned durable state (modeled here as an outbox sequence counter) survives renderer
  restarts unchanged.

Run:

```bash
npm run test:local-ipc
```

See `docs/PHASE_0_LOCAL_IPC_SPEC.md` for the full design write-up, including the production
transport/sandboxing requirements this model defers.
