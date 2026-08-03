# ADR 0008: Deployment, updates, rollback, and platforms

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: D-003, P-008, P-009, P-010, O-007, O-008, O-016

> Current implementation note (2026-07-31): the Pi-local Display server is retained as a
> required rendering/audio/voice component. References below to “sidecar removal” describe the
> original direction and are superseded by `docs/CURRENT_ARCHITECTURE.md`.

## Context

Core will run on a powerful GPU host, while Edge packages must remain reliable on Linux PCs and Raspberry Pi. Native code cannot be safely cross-packaged, and a failed remote update must not require physical repair.

## Decision

- Initial Core deployment uses Docker Compose with reverse proxy, `canvas-core`, `canvas-worker`, PostgreSQL, asset volume, and separate Whisper/Piper/LLM containers.
- GPU/inference failures cannot own or restart the device Gateway or HA integration.
- Start with one Core instance and no Redis; retain transactional/outbox boundaries for future scale.
- Edge releases are signed architecture-specific `.deb` artifacts with an independently supervised updater, canary channels, local health gate, power-loss-safe journal, cached compatible rollback, and anti-downgrade policy.
- The updater uses a separate-package or two-slot self-update design so it can recover when the Agent fails.
- Build `amd64` on x86_64 and `arm64` natively on ARM64. Never cross-package native addons or binaries.
- Ubuntu 22.04 is the initial `amd64` build/runtime validation baseline.
- Production Raspberry Pi releases require real Bookworm runtime tests and glibc no newer than 2.36. Debian 13 Pi artifacts are `trixie-dev` only.
- Android remains frozen.

## Consequences

- Core containers and Edge packages have separate release lifecycles.
- Release signing keys are not stored in the running Core.
- Sidecar removal waits until update and rollback drills pass on both architectures.

## Validation gates

- Real PC and Bookworm Pi pass install, boot, renderer, media/audio, systemd, update, interruption, and rollback tests.
- Any critical canary failure pauses promotion.
- Current and previous protocol/data versions interoperate during rolling updates.
- Core images have immutable digests, SBOM/provenance, expand/contract migrations, and a tested rollback window.
