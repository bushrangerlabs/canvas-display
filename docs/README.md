# Canvas Display documentation

Last reviewed: 2026-08-02

This directory documents the system implemented in this repository. Start with
[`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md), then use
[`CURRENT_STATUS.md`](./CURRENT_STATUS.md) and [`ROADMAP.md`](./ROADMAP.md) for delivery status
and remaining work.

## Living documents

| Document | Purpose |
| --- | --- |
| [`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md) | Current Core and Raspberry Pi architecture, ownership, network paths, and voice/audio flow |
| [`CURRENT_STATUS.md`](./CURRENT_STATUS.md) | Implemented, verified, partial, and compatibility status |
| [`ROADMAP.md`](./ROADMAP.md) | Prioritised work still to be completed |
| [`PAIRING_ENROLLMENT_CONTRACT.md`](./PAIRING_ENROLLMENT_CONTRACT.md) | Edge-to-Core enrollment contract |
| [`PAGE_PANEL_CONTROL_GUIDE.md`](./PAGE_PANEL_CONTROL_GUIDE.md) | Page, panel, and navigation control |
| [`CANVAS_ROUTINES_IMPLEMENTATION_GUIDE.md`](./CANVAS_ROUTINES_IMPLEMENTATION_GUIDE.md) | Step-by-step plan for routines, AI creation, ownership selection, safety, testing, and release |
| [`ROUTINES_OPERATIONS_ACCEPTANCE.md`](./ROUTINES_OPERATIONS_ACCEPTANCE.md) | Routine operations, Pi hardware acceptance, backup/restore drill, and release evidence |
| [`adr/README.md`](./adr/README.md) | Accepted architectural decisions |

## Normative technical references

The `PHASE_0_*_SPEC.md` files are retained because their protocol, security, state, and staging
rules are still useful. “Phase 0” describes when they were written, not the current release.
Runtime schemas under `contracts/` and code take precedence if a reference has drifted.

- [`PHASE_0_ADMIN_SECURITY_SPEC.md`](./PHASE_0_ADMIN_SECURITY_SPEC.md)
- [`PHASE_0_COMMAND_CAPABILITY_CATALOG.md`](./PHASE_0_COMMAND_CAPABILITY_CATALOG.md)
- [`PHASE_0_LOCAL_IPC_SPEC.md`](./PHASE_0_LOCAL_IPC_SPEC.md)
- [`PHASE_0_PKI_BOOTSTRAP_SPEC.md`](./PHASE_0_PKI_BOOTSTRAP_SPEC.md)
- [`PHASE_0_PROTOCOL_COMPATIBILITY.md`](./PHASE_0_PROTOCOL_COMPATIBILITY.md)
- [`PHASE_0_SCENE_STAGING_SPEC.md`](./PHASE_0_SCENE_STAGING_SPEC.md)
- [`PHASE_0_STATE_CONVERGENCE_SPEC.md`](./PHASE_0_STATE_CONVERGENCE_SPEC.md)
- [`PHASE_0_THREAT_MODEL.md`](./PHASE_0_THREAT_MODEL.md)
- [`PHASE_4_RAW_PANEL_DECISION.md`](./PHASE_4_RAW_PANEL_DECISION.md)

## Historical verification records

These are evidence snapshots, not statements of current production verification:

- [`PHASE_0_CONTENT_BRIDGE_MANUAL_VERIFICATION.md`](./PHASE_0_CONTENT_BRIDGE_MANUAL_VERIFICATION.md)
- [`PHASE_0_PERFORMANCE_BASELINE.md`](./PHASE_0_PERFORMANCE_BASELINE.md)

Superseded architecture plans, handoff notes, sidecar-removal audits, ownership inventories, and
cutover checklists were removed during the 2026-07-31 review. They remain available in Git
history. Their main invalid assumption was that the local Display server should disappear;
today it is an intentional Pi-side component of the product.

## Source-of-truth order

When documents disagree, use this order:

1. executable schemas in `contracts/`;
2. current source and tests;
3. accepted ADRs and normative specifications;
4. living overview documents;
5. historical verification records.
