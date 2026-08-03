# Canvas Routines operations and release acceptance

Last reviewed: 2026-08-02

This runbook is the release gate for Canvas Routines. Phase 7 must not be enabled until the
deterministic routine system has passed this runbook on the supported Pi hardware.

## Automated baseline

Run from the repository root:

```bash
bash scripts/acceptance-routines.sh
bash scripts/acceptance-routines.sh --live-host user@core-host
bash scripts/acceptance-routines.sh --live-host user@core-host --restart-check
bash scripts/acceptance-routines.sh --live-host user@core-host --restore-check
bash scripts/acceptance-routines.sh --live-host user@core-host \
  --hardware-report canvas-pi-acceptance-DEVICE-TIMESTAMP.json --hardware-device DEVICE_ID
```

The live check is read-only. It verifies Core health, a connected Edge Agent, a connected kiosk,
and absence of recent routine startup/migration errors. Record the commit, Core image digest, Pi
model, OS, kiosk version, Edge version, start/end time, and command output with the release evidence.
The restart option snapshots authoritative row counts, restarts only the Core application container,
checks the snapshot again, and waits for both Edge Agent and kiosk reconnection. It does not restart
PostgreSQL or create test routines in the live database. Device credential/invitation counts are
included, and a one-way enrollment-seed fingerprint must remain non-empty and unchanged; the seed is
never printed or written to evidence.
The restore option creates a uniquely named temporary database, takes a fresh custom-format dump,
restores with ownership removed, compares authoritative table counts, verifies routine foreign-key
references, seeds a complete synthetic routine/revision/execution/step/learning history inside the
temporary database, backs that up into a second temporary restore, and compares its content digest
and active-revision linkage. It also archives a synthetic content-addressed object between two
disposable Docker volumes and verifies restored size and SHA-256. All temporary databases, dumps,
and volumes are removed through a cleanup trap. Identity/enrollment continuity remains separate.
Credential and invitation rows plus credential-to-device references are included in the database
restore check. Protected enrollment-seed custody and stale-restore security-epoch fencing still need
their dedicated disaster-recovery drill.

`CANVAS_CORE_SECURITY_EPOCH` is the independently retained, monotonic credential generation. Keep
it with protected recovery metadata, separate from the PostgreSQL backup. A normal restore uses the
same value. If the restored database may predate a revocation or consumed invitation, increment the
external value before Core starts, keep open pairing disabled, and re-enrol every approved Edge.
Core rejects signed credentials and compatibility registry matches whose embedded epoch differs.
Never decrease the epoch or copy an older value out of a database backup.

## Hardware matrix

Open **Devices**, select the Pi, then use the **Acceptance** tab to run the device-scoped audio
checks and export a timestamped `canvas-pi-hardware-acceptance-v1` JSON report. The administrator
browser only initiates Edge actions and downloads the report: microphone capture, cue playback,
speaker output, and TTS must all occur on the selected Pi. The export deliberately excludes audio
samples, uploaded cue contents, credentials, and secrets. Attach the exported report to the release
evidence, but do not treat an unobserved API success as a hardware pass.
The acceptance command rejects incomplete, failed, duplicate, wrong-schema, future-dated, or older
than 24-hour reports. It also requires a positive wake-word detection and non-empty microphone,
speaker, and wake-model inventories. Use the validator's optional `--device` argument when validating
a report separately and an exact device ID is required.
With `--live-host`, the release command additionally requires that exact report device to be paired,
connected, unrevoked, and visible in recent Edge Agent and kiosk connection logs.

For each supported Pi/display/audio combination, prove all of the following:

- Manual, Canvas button, exact voice, schedule, MQTT, HA transition, and authenticated webhook
  triggers reach the same execution engine and durable history.
- A Pi voice phrase runs the intended routine and response TTS returns only to that Pi.
- Two enabled routines with the same normalized phrase execute neither and ask for clarification.
- Wake, successful-intent, and no-intent cues follow device settings and never overlap response TTS.
- An enabled learned routine records a fast-path hit and latency; removing its HA target or tool
  causes preflight failure and ordinary-planning fallback without executing the stale plan.
- Confirmation-required tools pause, expire safely, and execute once only after approval.
- MQTT expiry/action-ID and execution idempotency prevent duplicate actions.
- Core restart preserves enabled revisions, learning statistics, execution history, and schedules.

## Ownership cases

Record one reviewed prompt for each result: Canvas-only, HA-only, hybrid, offline-required,
ambiguous target, and elevated risk. Confirm that generated output is always a disabled draft.
HA/hybrid plans must remain review-only while the HA connection lacks a supported editable draft
API. No test may modify HA YAML or configuration storage directly.

## Backup and restore drill

Back up PostgreSQL using the deployment's protected database identity and encrypted backup
destination. The backup must include at least:

- `routines`, `routine_revisions`, `routine_executions`, and `routine_step_results`;
- `routine_plan_learning`, settings, device identity/authority tables, and HA catalogue tables;
- the enrollment seed/issuer continuity material under its separate custody procedure;
- referenced assets and deployment configuration at a consistent point in time.

Restore into an isolated clean-room database, never over the live database. Start a disposable Core
against it and verify routine/revision/execution counts and active revision IDs against the source
inventory. Run simulation on every enabled routine. Missing tools, entities, assets, or identity
continuity must fail closed. Follow the security-epoch fencing procedure for any restore whose
credential/revocation history may be stale. Record elapsed restore time against RPO 15 minutes and
RTO 60 minutes; do not claim the gate passed from backup creation alone.

## Failure and rollback

The automated Core suite includes a clean-room drill that enables a known-good revision, records a
successful execution, enables a deliberately failing second revision, records its bounded failure,
disables the routine, reactivates revision 1, and proves both successful recovery and preservation
of all execution/revision history. Repeat the operational steps below for any real incident; the
fixture proves mechanics but does not replace incident review.

On unexpected actions, ambiguity, repeated execution, audit gaps, or stale-target execution:

1. Disable the affected routine or set learning mode to `off`.
2. Preserve Core/Edge logs and execution IDs; do not delete history.
3. Stop external triggers if duplicate delivery continues.
4. Roll back to the last accepted immutable revision.
5. Re-run simulation and the relevant hardware case before re-enabling.

## Release evidence

The gate passes only when automated checks, every supported hardware row, restart, clean-room
restore, security review, and failure rollback have named evidence and an approver. A healthy API or
passing unit suite alone is insufficient.
