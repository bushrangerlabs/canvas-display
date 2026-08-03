# Canvas Edge Agent — systemd packaging (Phase 1 development artifact)

This directory contains the systemd unit for `canvas-edge-agentd`, the Rust daemon built from
`edge/agentd` (library: `edge/agent`, crate name `canvas-edge-agent`).

**Status:** development artifact for Phase 1 of
`docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md`. It has been written to the sandbox posture described
in `docs/PHASE_0_LOCAL_IPC_SPEC.md`, but as of this writing it has **not** been installed or
started on any real target device (Pi or PC). Do not install this on a device running a
production `canvas-display-server` without checking with the project owner first — the two
services are independent and installing this one does not touch the existing server, but any
change to a live device should still be deliberate.

## What this unit does today

`canvas-edge-agentd` in its current Phase 1 slice is intentionally network-free *toward Core*:
it opens a durable SQLite-backed store at `$CANVAS_EDGE_AGENT_DATA_DIR/agent.sqlite3`, runs a
startup crash-recovery pass (any `non_repeatable` command left `running` from a previous run is
marked `unknown_outcome`, never silently retried), logs a short summary plus a local diagnostics
summary (uptime, recovery count, epoch state, version/arch -- see `canvas_edge_agent::diagnostics`,
re-logged periodically), opens a local Unix-domain-socket IPC broker at
`$CANVAS_EDGE_IPC_SOCKET` (default `/run/canvas-edge/agent.sock`, see
`docs/PHASE_0_LOCAL_IPC_SPEC.md`) that authenticates local renderer/updater peers via real
`SO_PEERCRED` and dispatches a small allowlisted method set, and then idles until it receives a
termination signal. There is no Core connection and no pairing yet -- those are separate, later
Phase 1 checklist items.

## Manual install steps (development/test machines only)

These steps assume you have already built a release binary for the target's architecture (never
cross-compile — build `amd64` on an `amd64` host and `arm64` on an `arm64` host, per project
rules).

```sh
# 1. Build (on a matching-architecture host)
cargo build --release --manifest-path edge/Cargo.toml -p canvas-edge-agentd

# 2. Create the dedicated, non-root service user (no login shell, no home directory needed —
#    StateDirectory= in the unit creates and owns /var/lib/canvas-edge-agent for us).
sudo useradd --system --no-create-home --shell /usr/sbin/nologin canvas-edge-agent

# 3. Install the binary
sudo install -m 0755 edge/target/release/canvas-edge-agentd /usr/bin/canvas-edge-agentd

# 4. Install and enable the unit
sudo install -m 0644 packaging/systemd/canvas-edge-agent.service /etc/systemd/system/canvas-edge-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now canvas-edge-agent.service

# 5. Check it came up cleanly
sudo systemctl status canvas-edge-agent.service
sudo journalctl -u canvas-edge-agent.service -n 50 --no-pager
```

Expected journal output on a clean first start looks like:

```
[canvas-edge-agentd] opening durable storage at /var/lib/canvas-edge-agent/agent.sqlite3
[canvas-edge-agentd] startup recovery: no non-repeatable commands were left running
[canvas-edge-agentd] epochs: core_stream=1 edge_stream=1 authority=1 restore_generation=0
[canvas-edge-agentd] diagnostics: canvas-edge-agent v0.0.0 (x86_64), uptime=0s
[canvas-edge-agentd] diagnostics: startup recovery marked 0 non-repeatable command(s) unknown_outcome
[canvas-edge-agentd] diagnostics: epochs: core_stream=1 edge_stream=1 authority=1 restore_generation=0
[canvas-edge-agentd] diagnostics: generated_at=1730000000 (unix seconds)
[canvas-edge-agentd] ready (idle loop; no networking in this development slice)
```

The `diagnostics: ...` lines (see `canvas_edge_agent::diagnostics::DiagnosticsSummary`) are logged
once at startup and then re-logged every 5 minutes for the life of the process, as a best-effort
heartbeat for anyone tailing the journal live. Architecture (`x86_64`/`aarch64`) is included so
logs pulled from a mixed PC/Pi fleet are unambiguous about which build produced them.

### Local diagnostics vs. the (not-yet-built) renderer recovery screen

The architecture plan's Phase 1 checklist bundles "safe recovery screen" together with "local
diagnostics." Only the latter is implemented so far, entirely inside this Rust workspace (see
`edge/agent/src/diagnostics/mod.rs`). The renderer-side "safe recovery screen" itself is out of
scope here -- it is a `browser/linux` (Tauri/TypeScript) concern -- but the intended integration
path, so it doesn't need to be re-derived later, is: once `edge/agent/src/ipc/broker.rs` gains a
`diagnostics.summary` method on the renderer method allowlist (not added by this pass), the
renderer can call it at its own startup to decide whether to show a "recovered from a bad
shutdown" banner, based on whether `recovered_unknown_outcome_count > 0` in the returned summary.

## Uninstall

```sh
sudo systemctl disable --now canvas-edge-agent.service
sudo rm /etc/systemd/system/canvas-edge-agent.service
sudo systemctl daemon-reload
sudo rm /usr/bin/canvas-edge-agentd
# /var/lib/canvas-edge-agent (the durable database) and the canvas-edge-agent user are left in
# place intentionally, since removing them destroys state; delete them by hand if you're sure.
```

## What's deliberately deferred (do not assume these work yet)

- The local IPC broker (`edge/agent/src/ipc/`, real Unix-socket/`SO_PEERCRED` transport per
  `docs/PHASE_0_LOCAL_IPC_SPEC.md`) is implemented, unit-tested as library code, AND now wired
  into `canvas-edge-agentd`'s `main()` via `edge/agentd/src/ipc.rs` -- the daemon this unit runs
  opens a real `UnixListener` at `/run/canvas-edge/agent.sock` and serves the allowlisted
  renderer/updater method set from its own dedicated OS thread. The wired-up `ActionExecutor`
  (`DaemonActionHandler`) logs the display actions (`display.screen_off`/`screen_on`/
  `set_brightness`) and returns the real `agent.app_version`; real hardware control from the Rust
  daemon is a separate, later Phase 1 checklist item (the existing Tauri renderer still calls
  those Tauri commands directly today). The end-to-end IPC path is proven in
  `edge/agentd/tests/ipc_wiring_v1.rs`.
- No Core pairing/connection/heartbeat/resume protocol.
- No renderer or updater processes/units are defined here yet; this unit only covers the Agent
  itself.
- `RestrictAddressFamilies=AF_UNIX` allows only Unix-domain sockets. The IPC broker now opens a
  real `AF_UNIX` socket, so this is the correct narrow allowlist (flipped from `none` in the same
  change that wired the broker into `main()`). Do NOT widen this to `AF_UNSPEC`/`AF_INET`
  wholesale when Core networking eventually lands; add `AF_INET`/`AF_INET6` as its own narrow
  addition at that time instead.

### IPC socket path and permissions

The daemon binds `/run/canvas-edge/agent.sock` by default (overridable via
`CANVAS_EDGE_IPC_SOCKET`). The daemon itself:

- creates `/run/canvas-edge` with mode `0700` if it does not exist (so a manual, non-systemd run
  still works);
- unlinks any stale socket file before binding;
- sets the socket file itself to mode `0600` after bind.

Under systemd, `RuntimeDirectory=canvas-edge` (mode `0750`, owned by the `canvas-edge-agent`
service user) creates `/run/canvas-edge` before the daemon starts, so the daemon's own
`create_dir_all` is a no-op in that case. Packaging/installation is still expected to:

- provision the dedicated, distinct service users for the renderer and updater processes (the
  Agent's `CANVAS_EDGE_RENDERER_UID` / `CANVAS_EDGE_UPDATER_UID` environment variables must point
  at those uids for `SO_PEERCRED` authentication to authenticate them as the right role -- the
  daemon's default of its own uid is a dev/test fallback only, NOT a production posture);
- ensure the renderer/updater service users can reach the socket (e.g. by sharing the
  `canvas-edge` group, or by placing the socket in a directory those users can access) -- the
  exact mechanism is a packaging-time decision per `docs/PHASE_0_LOCAL_IPC_SPEC.md`'s "Sandbox
  posture" section.
- This has only been build/`cargo test`-verified on development machines, never installed via
  these exact steps on real Pi/PC hardware. Treat the steps above as reviewed-but-unverified until
  someone runs them for real and the architecture plan's Phase 1 progress notes are updated to
  say so.

## Related unit: the Edge Updater

`canvas-edge-updaterd` (a separate process/package/systemd unit, per the privilege-boundary design
in `docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.4) has its own packaging doc:
`README-updater.md` in this directory.
