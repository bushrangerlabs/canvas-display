# Canvas Display architecture decision records

ADRs capture decisions that are expensive to reverse. They record the accepted rationale;
[`../CURRENT_ARCHITECTURE.md`](../CURRENT_ARCHITECTURE.md) describes the running system and
[`../ROADMAP.md`](../ROADMAP.md) is the current delivery tracker.

## Status meanings

- **Accepted** — approved baseline. Current implementation status is recorded separately.
- **Superseded** — replaced by a newer ADR; the replacement must link back.
- **Rejected** — considered but not selected.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-core-intelligence-edge-boundaries.md) | Core, Intelligence, and resilient Edge boundaries | Accepted |
| [0002](0002-authoritative-data-and-storage.md) | PostgreSQL Core, SQLite Edge, content-addressed assets | Accepted |
| [0003](0003-native-rust-edge-agent.md) | Separate native Rust Edge Agent | Accepted |
| [0004](0004-device-identity-pki-and-mtls.md) | Device identity, pairing, PKI, and mTLS termination | Accepted |
| [0005](0005-device-protocol-v1.md) | Versioned device protocol, state, delivery, and uncertainty | Accepted |
| [0006](0006-voice-and-intelligence-boundary.md) | Local wake/privacy and central Intelligence | Accepted |
| [0007](0007-media-and-content-bridge.md) | Official media integrations and loopback Content Bridge | Accepted |
| [0008](0008-deployment-updates-and-platforms.md) | Core deployment, signed Edge updates, and platform matrix | Accepted |

## Amendment rule

A Phase 0 prototype may reveal that an accepted detail is impractical. In that case, add a superseding ADR describing the evidence and migration impact before changing contracts or production behavior. Do not silently edit generated contracts or bypass a phase gate.
