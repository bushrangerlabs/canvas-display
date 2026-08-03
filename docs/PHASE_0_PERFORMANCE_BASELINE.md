# Phase 0 — PC/Pi Resource and Latency Baseline

- Status: Recorded evidence (not a substitute for the automated test suite)
- Date: 2026-07-18/19
- Reviewed: 2026-07-31; historical snapshot, not a current release claim
- Related: Current release gates are in `docs/ROADMAP.md`

## Purpose

Phase 0 requires a first, reproducible resource/latency baseline for both supported release
architectures before Phase 1 implementation work assumes any particular headroom. This is a
lightweight, credential-free, dev-only snapshot — not a load test, not CI-gated, and not a
performance SLA. It answers "what do we currently know," not "what must Phase 1/2 guarantee."

## Method

Standard Linux tools already present on both machines (`nproc`, `lscpu`, `free`, `df`, `dd`,
`ping`) plus the Content Bridge manual verification harness described in
`docs/PHASE_0_CONTENT_BRIDGE_MANUAL_VERIFICATION.md` (which now also records a
`_t_seconds_since_load` timestamp per player event). No credentials, HA tokens, or production
data were touched. Disk tests wrote and immediately deleted a 256 MiB temp file with
`conv=fdatasync` to force an actual device flush; an early Pi run was accidentally measuring
`/tmp`, which is `tmpfs` (RAM-backed) there — this was caught and corrected to measure the real
root filesystem instead (see caveat below).

## Results

### `amd64` — local dev workstation

| Metric | Value |
|---|---|
| CPU | AMD Ryzen 9 9900X, 12 cores / 24 threads, up to 5.66 GHz |
| Memory | 60 GiB total (44 GiB in use by the broader dev environment at capture time; not an idle baseline) |
| Disk | NVMe (`/dev/nvme0n1p2`, ext4), 1.8 TB, 29% used |
| Disk write throughput | 1.7 GB/s (256 MiB, `fdatasync`, real ext4 path, not `tmpfs`) |
| Network RTT to `www.youtube.com` | min/avg/max 2.2/2.7/3.0 ms (5 pings, 0% loss) |
| Content Bridge: page load → `ready` | ~1.8 s |
| Content Bridge: `ready` → `playing` (incl. one `autoplay_blocked` retry) | ~2.4 s |
| Content Bridge: page load → `playing` (total) | ~4.2 s |

**Caveat:** this is a high-end multi-purpose development workstation, not necessarily
representative of a minimal target kiosk PC. Treat these numbers as an upper-bound/best-case
reference, not a minimum-spec baseline. Memory "used" reflects the whole dev environment (editors,
language servers, etc.) running concurrently, not an idle Canvas Display process footprint.

### `arm64` — Raspberry Pi 5 (`192.168.1.216`), labeled `trixie-dev`

| Metric | Value |
|---|---|
| CPU | Cortex-A76, 4 cores, up to 2.4 GHz |
| Memory | 4.0 GiB total, 733 MiB used, 3.2 GiB available at capture time |
| Disk | `/dev/mmcblk0p2` (SD/eMMC, ext4), 117 GB, 18% used |
| Disk write throughput | 38.6 MB/s (256 MiB, `fdatasync`, real ext4 root, **not** `/tmp`) |
| Network RTT to `www.youtube.com` | min/avg/max 1.9/3.3/6.0 ms (5 pings, 0% loss) |
| Content Bridge: page load → `ready` | ~1.3 s |
| Content Bridge: `ready` → `playing` (incl. one `autoplay_blocked` retry) | ~3.6 s |
| Content Bridge: page load → `playing` (total) | ~5.6 s |

**Caveat:** `/tmp` on this Pi is `tmpfs` (RAM-backed) — an initial disk-throughput measurement
against `/tmp` produced a misleading ~3.2 GB/s figure before this was caught and corrected to
measure the real SD/eMMC-backed root filesystem instead. Any future automated baseline tooling
must explicitly target a real, non-`tmpfs` path. This machine is Debian 13 "Trixie" (`trixie-dev`),
not the Bookworm release target — glibc 2.41 vs. the ≤2.36 release gate — so these numbers are
dev-representative but not release-gate-representative hardware.

## Voice/media latency (already-observed production evidence, not synthetic)

Real Canvas Display server logs already captured during earlier Hermes voice-turn testing on this
same Pi (see session history / `tests/regression/hermes-voice-media` sanitized corpus) show, for a
representative successful turn:

| Stage | Observed duration |
|---|---|
| Wyoming ASR (Whisper) transcript | ~5.1 s |
| Hermes assist query → structured response | ~10.4 s |
| Wyoming TTS (Piper) synthesis | <0.1 s |

These are unchanged legacy-path timings included here only as existing context; they were not
re-measured as part of this baseline pass and should not be conflated with the new Content Bridge
timings above, which are a different code path (the Phase 0 prototype, not the current production
Hermes media flow).

## Interpretation

- Both architectures reach genuine YouTube `playing` state within single-digit seconds of page
  load through the Content Bridge prototype design; the Pi is meaningfully slower (~5.6 s vs.
  ~4.2 s total) but not by an order of magnitude, and both are dominated by the same two stages
  (IFrame API/player bootstrap, then autoplay-retry-to-playing), not by loopback-server overhead.
  This is directionally reassuring for Phase 1 latency budgeting but is a single-sample
  measurement — not a distribution, not under load, and not with concurrent Canvas Display
  workload (voice, WebSocket sync, etc.) competing for the same CPU/network.
- Pi disk throughput (SD/eMMC, ~38.6 MB/s) is roughly 45x slower than the dev workstation's NVMe.
  Any Phase 1/2 durability design (WAL, scene staging, snapshotting) must be validated against
  this real, much slower disk class, not just the dev machine.
- Pi memory headroom (4 GiB total, ~3.2 GiB available at idle-ish capture time) is comparatively
  tight; Phase 1/2 should track actual Canvas Display server + Agent + WebKitGTK renderer RSS on
  this class of hardware once a real daemon exists, since 4 GiB leaves much less margin than the
  dev workstation's 60 GiB.

## Outstanding

- This is a single-sample snapshot per metric per machine, not a distribution; no percentile,
  variance, or sustained-load data exists yet.
- No measurement was taken under realistic concurrent load (WebSocket fan-out, voice pipeline,
  scene sync, and media playback simultaneously) — that is a Phase 1/2 concern once real daemons
  exist to load-test.
- No genuine Bookworm `arm64` hardware baseline exists yet (only Trixie-dev).
