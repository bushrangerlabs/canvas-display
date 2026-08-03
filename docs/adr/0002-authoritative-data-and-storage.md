# ADR 0002: Authoritative data and storage

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: P-001, P-007, O-013

## Context

Current server instances own independent SQLite databases. A fleet control plane needs concurrent transactions, durable journals, backup/restore, and unambiguous authority.

## Decision

- PostgreSQL is Canvas Core's authoritative relational database.
- Edge uses a separate local SQLite database only for operational cache, command receipts, outbox, known-good content, schedules, and update state.
- Never share one SQLite file between containers or devices.
- Start Core assets in content-addressed local-volume storage. Introduce S3/MinIO only when measured scale or multi-host requirements justify it.
- Publish scene revisions only after every referenced object exists and verifies by hash.
- Select one canonical legacy database for import; do not blindly merge every device database.
- Use explicit authority modes and epochs. There is no dual-write authority mode.

## Consequences

- PostgreSQL becomes a required Core dependency and operational responsibility.
- Edge SQLite is not a replica of the full Core database.
- Backups must cover PostgreSQL, objects, PKI continuity material, encryption configuration, and restore ordering.
- Rollback after authority cutover requires reconciliation; it cannot simply make stale SQLite writable again.

## Validation gates

- Transactional outbox/inbox behavior survives process restart.
- Database and object restore rejects published scenes with missing assets.
- Cutover, rollback reconciliation, and a second cutover are idempotent.
- Corrupt Edge SQLite or content enters visible safe recovery without replacing known-good content.
