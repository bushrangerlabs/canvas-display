# Canvas Edge Updater — systemd packaging (Phase 1 development artifact)

This directory contains the systemd unit for `canvas-edge-updaterd`, the Rust daemon built from
`edge/updaterd` (library: `edge/updater`, crate name `canvas-edge-updater`). It is a separate
process, package, and systemd unit from `canvas-edge-agentd` (see `README.md` in this directory)
by design — per `docs/adr/0008-deployment-updates-and-platforms.md` and
`docs/CANVAS_CORE_EDGE_ARCHITECTURE_PLAN.md` section 21.4, the updater must be able to recover the
Agent even when the Agent itself cannot start, so it must not share the Agent's process or failure
modes.

**Status:** development artifact, installed and enabled on the ARM64 Debian 13 Trixie development
Pi on 2026-07-26. Its hardened idle-mode unit and durable journals have been validated there. This
is not Bookworm release evidence and no production release feed or trust root is configured.

## What this unit does today

`canvas-edge-updaterd` in its current Phase 1 slice is intentionally network-free: it opens a
durable SQLite-backed `InstallJournal` at `$CANVAS_EDGE_UPDATER_DATA_DIR/updater.sqlite3` (see
`canvas_edge_updater::journal`), runs a startup crash-recovery pass (`recover_on_startup`), and
acts on (or clearly logs the honest limitation of acting on) the recommendation:

- `RecoveryAction::Nothing` — logs and continues.
- `RecoveryAction::ResumeInstall` — logs that a resume is recommended, but does **not**
  automatically resume: the journal schema does not durably record where an in-progress
  candidate's artifact came from, so there is nothing to resume from without an operator
  supplying that information again.
- `RecoveryAction::RollForward` — logs the recommendation; a later successful health cycle or
  crash-loop decision must resolve it.
- `RecoveryAction::RollBack` — calls `perform_rollback`, atomically swaps the tracked live binary
  to the known-good slot artifact, and preserves the replaced binary as `.previous`.

It also runs a real end-to-end rollout (`canvas_edge_updater::rollout::perform_rollout`: verify
manifest → evaluate anti-downgrade/compatibility → stage → "download" (local-file copy) → hash
verify → install → health-check → commit-or-leave-for-recovery) whenever
`CANVAS_EDGE_UPDATER_DEMO_ROLLOUT=1` is set, using a self-contained in-process demo helper
(`canvas_edge_updater::rollout::run_demo_rollout`) described below. Otherwise it idles until it
receives a termination signal.

Expected journal output on a clean first start looks like:

```
[canvas-edge-updaterd] opening durable install journal at /var/lib/canvas-edge-updater/updater.sqlite3
[canvas-edge-updaterd] startup recovery recommendation: Nothing
[canvas-edge-updaterd] recovery: nothing to do
[canvas-edge-updaterd] slots: active=None candidate=None
[canvas-edge-updaterd] no release trust root configured (CANVAS_EDGE_RELEASE_TRUST_ROOT_HEX unset); manifest verification is not available in this development slice
[canvas-edge-updaterd] ready (idle loop; no networking or real install logic in this development slice)
```

### Release trust root (optional, unused today beyond loading)

Set `CANVAS_EDGE_RELEASE_TRUST_ROOT_HEX` to a 64-character lowercase-hex-encoded Ed25519 public
key to have the daemon load it at startup via `canvas_edge_updater::manifest::ReleaseTrustRoot`.
This is not yet used to verify any real manifest — there is no networked release feed to fetch one
from yet — it only proves the wiring between `edge/updaterd` and `edge/updater`'s manifest module
works. A missing or malformed value is logged but never fatal.

### Demo rollout trigger (manual testing only)

Set `CANVAS_EDGE_UPDATER_DEMO_ROLLOUT=1` to run one self-contained, in-process demonstration
rollout after the startup recovery pass. This generates an ephemeral Ed25519 signing key (trusting
only itself — **this is never how a real release is signed**, see ADR 0008), signs a synthetic
demo manifest with it, writes a small demo artifact under
`$CANVAS_EDGE_UPDATER_DATA_DIR/demo-candidate-artifact.bin`, and runs a real
`canvas_edge_updater::rollout::perform_rollout` call against the real journal — proving the full
verify → evaluate → stage → "download"/hash-check → install → health-check → commit wiring
compiles and works end-to-end from this binary. Running it repeatedly always looks like a normal
forward upgrade (each run's `security_counter` is one greater than whatever is currently
installed), alternating between slots `a` and `b`. See
`canvas_edge_updater::rollout::run_demo_rollout`'s doc comment for exactly what this does and does
not prove. Never set this in production.

## Manual install steps (development/test machines only)

These steps assume you have already built a release binary for the target's architecture (never
cross-compile — build `amd64` on an `amd64` host and `arm64` on an `arm64` host, per project
rules).

```sh
# 1. Build (on a matching-architecture host)
cargo build --release --manifest-path edge/Cargo.toml -p canvas-edge-updaterd

# 2. Create the dedicated, non-root service user, distinct from canvas-edge-agent's own user.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin canvas-edge-updater

# 3. Install the binary
sudo install -m 0755 edge/target/release/canvas-edge-updaterd /usr/bin/canvas-edge-updaterd

# 4. Install and enable the unit
sudo install -m 0644 packaging/systemd/canvas-edge-updater.service /etc/systemd/system/canvas-edge-updater.service
sudo systemctl daemon-reload
sudo systemctl enable --now canvas-edge-updater.service

# 5. Check it came up cleanly
sudo systemctl status canvas-edge-updater.service
sudo journalctl -u canvas-edge-updater.service -n 50 --no-pager
```

## Uninstall

```sh
sudo systemctl disable --now canvas-edge-updater.service
sudo rm /etc/systemd/system/canvas-edge-updater.service
sudo systemctl daemon-reload
sudo rm /usr/bin/canvas-edge-updaterd
# /var/lib/canvas-edge-updater (the durable install journal) and the canvas-edge-updater user are
# left in place intentionally, since removing them destroys state; delete them by hand if you're
# sure.
```

## What's deliberately deferred (do not assume these work yet)

- **No daemon release-feed orchestration.** The updater library has a real HTTP/TLS streaming
  fetch path with bounded retries and SHA-256 verification, but `canvas-edge-updaterd` has no Core
  release-feed connection and therefore never requests a candidate in normal idle operation.
- **No automatic resumption of an in-progress install.** The journal schema does not durably
  record where a staged/installing candidate's artifact came from (no source path/URL column), so
  `RecoveryAction::ResumeInstall` is logged clearly but not acted on automatically -- see
  `edge/updaterd/src/main.rs`'s `handle_recovery_action`. This is a real, honest gap, not a
  simplification.
- **No automatic service restart after a binary swap.** Rollback file replacement is implemented,
  but the hardened non-root unit cannot restart the Agent itself. Operational orchestration and
  the narrow privilege mechanism remain undecided.
- **No in-process updater re-exec or self-health gate.** Self-upgrade uses an independent journal
  and atomically replaces the updater binary, but the new executable takes effect only on the next
  systemd start.
- **The demo rollout trigger (`CANVAS_EDGE_UPDATER_DEMO_ROLLOUT=1`) is not a real update
  mechanism.** It generates a fresh, self-trusting Ed25519 key in-process purely to exercise
  `perform_rollout`'s wiring end-to-end; it proves nothing about real release signing,
  distribution, or trust-root provisioning. See `canvas_edge_updater::rollout::run_demo_rollout`'s
  doc comment.
- **Artifact hash-mismatch handling is intentionally minimal.** If a "downloaded" (copied)
  artifact's bytes don't hash to the manifest's `artifact_sha256`, `perform_rollout` returns an
  error and leaves the slot in `Installing` status in the journal (there is no public journal API
  to mark a slot `Failed` directly without going through `recover_on_startup`'s own policy). On
  the next daemon start this surfaces as `RecoveryAction::ResumeInstall` for that slot. See
  `edge/updater/src/rollout.rs`'s module docs for the full reasoning and what a future task should
  reconsider here.
- **Post-commit crash-loop recovery is not handled.** The crash-loop policy
  (`canvas_edge_updater::journal::recovery::MAX_BOOT_ATTEMPTS_BEFORE_ROLLBACK`) only governs a
  candidate slot before it is ever committed known-good. A slot that starts crash-looping *after*
  `commit_known_good` already flipped it to active is a distinct, harder problem not addressed
  here.
- **Sandbox posture will need loosening, not just review, once real install logic lands** — see
  the comments directly in `canvas-edge-updater.service` above `ProtectSystem`/
  `CapabilityBoundingSet` and `RestrictAddressFamilies`.
- The idle service and journals have been installed/restarted on the ARM64 Trixie development Pi.
  Bookworm, real signed-feed rollout, forced crash recovery, and production PC evidence remain.

## Relationship to `canvas-edge-agent.service`

These are two independent units with two independent service users, data directories, and
databases. The updater library has a role-scoped Unix-socket client for
`updater.agent_version`, and the Agent broker authenticates that role with `SO_PEERCRED`; normal
idle daemon startup does not yet invoke the client or consume a release feed.
