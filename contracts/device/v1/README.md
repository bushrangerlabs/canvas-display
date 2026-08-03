# Canvas Device Protocol v1 contracts

This directory is the source of truth for the new authenticated Canvas Core ↔ Canvas Edge device protocol. It is intentionally separate from the legacy `/ws` protocol, whose existing `protocol_version: 1` field is decorative and does not identify this contract.

## Rules

- JSON Schema Draft 2020-12 is authoritative.
- Core derives device identity from the authenticated connection; payload identity is never authoritative.
- Durable messages carry a stream epoch and monotonic sequence.
- `stream.ack`, heartbeat, and handshake messages are not recursively acknowledged.
- Unknown optional envelope fields may be ignored. Versioned command payloads remain schema constrained.
- Fixtures are language-independent and must pass in TypeScript and Rust.
- Generated source is committed and CI rejects drift.

## Commands in the first vertical slice

Only `diagnostics.echo` is included initially. It is deliberately replay-safe and has no hardware or external side effect. The planned command boundary, fixed execution classes, capability references, and real canonical request-digest vectors are frozen separately in `contracts/command/v1/` and `docs/PHASE_0_COMMAND_CAPABILITY_CATALOG.md`; catalog presence does not make a planned command active. Additional wire kinds still require their own parameter/result schema, conformance fixtures, policy review, and Agent implementation.

## Commands

From the repository root:

```bash
npm run contracts:validate
npm run contracts:generate
npm run test:contracts
```
