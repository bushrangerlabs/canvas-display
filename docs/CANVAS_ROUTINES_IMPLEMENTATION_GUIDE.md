# Canvas Routines implementation guide

Last reviewed: 2026-08-02

## Purpose

This is the implementation playbook for reusable Canvas routines, AI-assisted routine creation,
and automatic selection between a Canvas-owned routine and a Home Assistant automation. Follow
the phases in order. A later phase must not bypass the validation, permission, confirmation, or
audit boundaries established by an earlier phase.

The user-facing name is **Canvas Routine**. Internally, a routine is a versioned, structured plan.
It is not arbitrary shell, Python, JavaScript, YAML, or SQL.

## Non-negotiable rules

1. The AI may propose and revise drafts; it does not directly enable generated mutations.
2. Enabled revisions are immutable. Every edit creates a new draft revision.
3. Routine execution uses registered typed tools and the same policy checks as ordinary voice,
   admin, MQTT, and MCP requests.
4. Core validates all tool names, schemas, entity IDs, Canvas targets, permissions, limits, and
   confirmation requirements after AI planning and immediately before execution.
5. Locks, alarms, doors, purchases, external messages, destructive actions, and future code
   execution retain their elevated confirmation policy.
6. Home Assistant remains authoritative for HA entities, devices, areas, scripts, scenes, and
   automations. Core stores a synchronized catalogue, not a competing source of truth.
7. Generated raw HA YAML must never be applied directly. Use a validated neutral plan and a
   supported HA API/adaptor.
8. No routine may access Core credentials, Docker, the host filesystem, unrestricted networking,
   raw SQL, or arbitrary processes.
9. Every live execution has an origin, correlation ID, resolved revision, inputs, step results,
   duration, and final status in the audit history.
10. Dry runs must be visibly marked and must not invoke mutating tools.

## Ownership decision

The AI returns a recommendation plus reasons and required capabilities. Core then applies hard
rules and may override an invalid recommendation.

| Requirement | Owner |
| --- | --- |
| Only HA entities, state/event triggers, schedules, scenes, or services | Home Assistant |
| Must continue while Canvas Core is offline | Home Assistant |
| Uses Canvas pages, panels, scenes, device audio, TTS, or display media | Canvas Core |
| Uses AI reasoning, camera vision, non-HA MCP, or multiple external systems | Canvas Core |
| Needs a response on the Pi that originated the request | Canvas Core |
| Safety-critical local control | Home Assistant, with HA safety configuration |
| Mixes HA and Canvas actions | Canvas Core orchestrates typed HA calls |
| Requirements are ambiguous or ownership changes safety/reliability | Clarification required |

The classifier output is:

```json
{
  "owner": "home_assistant | canvas_core | hybrid | clarification_required",
  "reasons": ["string"],
  "requiredCapabilities": ["string"],
  "offlineRequired": false,
  "needsAiAtRuntime": false,
  "risk": "read_only | normal_mutation | elevated"
}
```

Core must reject a pure HA owner when a plan contains a Canvas-only action. For a hybrid plan,
prefer Core orchestration unless offline execution is explicitly required. An offline hybrid may
use a narrow HA automation that emits an event to Core, but the HA-only portion must remain useful
and safe when Core is absent.

## Canonical routine shape

Use one versioned JSON schema under `contracts/`. Generate TypeScript and Rust types through the
existing contract generation workflow.

```json
{
  "schemaVersion": 1,
  "name": "Movie night",
  "description": "Prepare the lounge and open media selection",
  "owner": "canvas_core",
  "triggers": [],
  "inputs": {},
  "steps": [],
  "result": {},
  "limits": {
    "timeoutMs": 30000,
    "maxSteps": 30,
    "maxRoutineDepth": 3
  }
}
```

Each step has a stable ID, kind, typed configuration, optional condition, timeout, failure policy,
and optional compensation. Initial step kinds are `tool`, `condition`, `delay`, `routine`, and
`result`. Parallel groups, bounded loops, AI reasoning, and sandboxed code are later extensions.

## Phase 1 — schema, storage, and lifecycle

1. Add the routine contract and positive/negative fixtures.
2. Add database tables for routines, immutable revisions, active revision, triggers, permissions,
   executions, and step results.
3. Store creation source (`user`, `ai_prompt`, or `learned_suggestion`) and AI/provider provenance.
4. Implement draft, validate, publish/enable, disable, clone, revise, and archive operations.
5. Prevent enabling when validation errors exist.
6. Keep activation atomic: an enabled routine always points to one complete immutable revision.
7. Add repository tests for revision ordering, concurrent updates, rollback, and deletion rules.

Exit criteria: a versioned routine can be created, validated, enabled, revised, rolled back, and
listed without executing any action.

## Phase 2 — deterministic execution engine

1. Resolve the enabled revision and bind validated inputs.
2. Execute sequential typed tools through `ToolRegistry`; do not call provider implementations
   directly.
3. Re-run role, permission, confirmation, and argument-schema checks for every step.
4. Implement conditions, delays, stop-on-error/continue policies, cancellation, and result output.
5. Enforce timeout, maximum steps, nesting depth, recursion detection, and concurrency limits.
6. Record execution and step audit rows without secrets, raw audio, or unrestricted camera data.
7. Implement dry-run mode using simulated tool results and current cached HA/Canvas catalogues.
8. Mark unknown outcomes separately from failures when a remote mutation times out.

Initial tools must cover HA services and `script.*`, Canvas page/scene/panel control, media
control, TTS on the origin/selected device, and calling another routine.

Exit criteria: an administrator can dry-run and manually run a routine; failures are bounded and
fully visible; existing confirmation rules cannot be bypassed.

## Phase 3 — management UI

Add **Settings → Routines** with:

1. Searchable routine list showing draft/enabled/disabled/error state and owner.
2. A visual `Trigger → Conditions → Actions → Result` builder.
3. Selectors backed by Core's cached HA areas/devices/entities and Canvas devices/pages/scenes.
4. Permission summary showing readable and mutable targets, external access, and confirmations.
5. Simulation with selectable origin device, time, and substituted entity states.
6. One-step live testing and confirmed full live testing.
7. Revision comparison, publish/enable, rollback, duplicate, and archive controls.
8. Execution history with correlation ID, step timing, skips, failures, and unknown outcomes.

Exit criteria: a non-technical user can build, understand, test, approve, and diagnose a routine
without editing JSON.

## Phase 4 — triggers and matching

Implement triggers in this order:

1. Manual and Canvas button.
2. Explicit voice phrases and aliases.
3. Schedule.
4. MQTT with action ID, expiry, and duplicate protection.
5. HA state/event change.
6. Authenticated webhook.

The voice router checks exact enabled routine phrases before general AI planning. Semantic matching
may be added with thresholds, ambiguity detection, and clarification. It must not silently select
between two similarly ranked mutating routines.

Exit criteria: every trigger reaches the same execution engine and produces the same policy and
audit behavior.

## Phase 5 — AI-assisted creation and owner selection

Current implementation: Core exposes schema-constrained read-only planning and disabled-draft
creation through both admin APIs and the typed tool registry. The Settings UI shows the recommended
owner, reasons, risk, permissions, target-resolution problems, and expected behavior before a draft
is created. Core independently checks cached HA entity IDs and recalculates ownership instead of
trusting model output. HA-owned and hybrid plans remain review-only because the current HA connection
does not expose a supported safe editable-automation-draft API. Activation always remains a separate
explicit user action. AI edits now use the selected routine as their base, preserve unrelated behavior,
show a proposed change summary, and save as a new immutable draft revision. Richer interactive
clarification now lets the user bind ambiguous or unresolved names to an exact cached HA entity and
regenerates the validated plan with that binding. A supported HA automation-draft handoff remains
to be completed when the connected HA API can provide it safely.

1. Add a read-only planning tool that returns the neutral routine plan and ownership classification.
2. Add `routine.create_draft`; it accepts only schema-valid structured data.
3. Add an HA automation draft adaptor using supported HA APIs. If the installed HA version cannot
   create a safe editable draft through a supported API, stop and explain the limitation.
4. Resolve friendly names to exact cached IDs and show unresolved/ambiguous targets to the user.
5. Run ownership policy, capability validation, risk classification, and dry-run planning.
6. Display owner, reasons, trigger, actions, permissions, unresolved items, and expected behavior.
7. Require user approval before enabling any generated mutation.
8. AI edits create a new draft revision and visually highlight the changes.

Supported prompts include “create a good-night routine”, “make this happen every weekday”, “add
the driveway light”, and “make a routine from what I just asked”.

Exit criteria: prompts create understandable drafts in the correct system; neither Canvas nor HA
automations become active without the required approval.

## Phase 6 — repeated-request compilation

Current implementation: learning modes `off`, `suggest`, and `automatic_drafts` are configurable in
Settings → Routines. Core records only normalized successful tool plans, removes secret/credential
fields and long values, excludes elevated actions and failed/confirmation/ambiguous requests, and
promotes an identical plan after three successes. Suggest mode exposes dismissible candidates;
automatic mode creates a disabled Canvas-owned draft for safe Canvas plans. HA-only observations stay
as suggestions. Suggested plans can be converted to disabled drafts; after explicit review and enable,
exact voice phrases take the existing routine fast path without AI planning. Every hit revalidates the
enabled revision, registered tools, role permissions, parameters, confirmation policy, and cached HA
targets, records latency/hit counts, and falls back to ordinary planning if preflight fails.

Add user-selectable learning modes: `off`, `suggest` (default), and `automatic_drafts`.

1. Record normalized successful tool plans, excluding sensitive argument values.
2. Suggest compilation only after the same stable plan succeeds at least three times.
3. Require stable tool order and targets; reject failures, corrections, ambiguity, and elevated-risk
   actions from automatic learning initially.
4. Save trigger phrases/semantic signature, exact targets, required permissions, origin-device
   behavior, expected response, catalogue references, provenance, and success statistics.
5. Before fast execution, confirm the routine is enabled, targets still exist, permissions still
   hold, and the match is unambiguous.
6. Fall back to ordinary AI planning when any fast-path validation fails.
7. Improvements create draft revisions and never broaden permissions silently.

Exit criteria: repeated requests measurably avoid AI planning latency while producing the same
validated actions and confirmations.

## Phase 7 — advanced processing

Only begin after the deterministic engine has production acceptance:

1. Schema-constrained AI reasoning steps with explicit inputs, outputs, allowed tools, timeout,
   provider policy, and fallback.
2. Parallel groups with defined cancellation and partial-failure semantics.
3. Bounded loops over validated collections.
4. Compensation actions where the underlying operation supports safe reversal.
5. A separately deployed sandbox runner for advanced code steps and pre-run script injection.

The sandbox receives JSON and returns JSON. It has no Core secrets, Docker socket, host mounts,
unrestricted network, or direct HA credentials. Tool calls return through an authenticated,
allowlisted RPC boundary and remain subject to Core policy. Enforce CPU, memory, wall-time, output,
and tool-call limits.

## Required API surface

Names may be refined, but capability boundaries must remain explicit:

- `GET/POST /api/admin/routines`
- `GET/PUT /api/admin/routines/:id`
- `POST /api/admin/routines/:id/revisions`
- `POST /api/admin/routines/:id/validate`
- `POST /api/admin/routines/:id/simulate`
- `POST /api/admin/routines/:id/enable`
- `POST /api/admin/routines/:id/disable`
- `POST /api/admin/routines/:id/run`
- `GET /api/admin/routines/:id/executions`
- `POST /api/admin/routines/plan-from-prompt`
- `POST /api/admin/automation-drafts/home-assistant`

State-changing admin routes require session CSRF or the explicitly scoped automation credential.
Execution endpoints must accept an idempotency/action ID.

## Test checklist

- Contract fixtures reject unknown steps, excess limits, malformed conditions, and untyped args.
- AI text cannot bypass schema, policy, target, role, or confirmation checks.
- Dry run causes zero external mutations.
- Duplicate MQTT/webhook/action IDs execute once.
- Timeout distinguishes known failure from unknown mutation outcome.
- Cancellation stops future steps and records completed effects.
- Recursive and mutually recursive routines are blocked.
- Disabled, archived, stale, or superseded revisions cannot run accidentally.
- Exact voice matching wins; ambiguous semantic matching asks for clarification.
- Origin-device TTS/media returns to the Pi that initiated the request.
- HA-only plans are rejected if they contain Canvas actions.
- Canvas plans remain valid when the HA catalogue is temporarily offline, but stale-target policy is
  visible and enforced.
- Generated HA automation drafts round-trip through the supported HA API without raw YAML injection.
- Audit/log output redacts credentials, private transcript content according to privacy settings,
  raw audio, and camera bytes.
- Power loss during revision activation or execution does not corrupt the active definition.

## Release acceptance

The feature is complete only when:

1. Contract, Core, web, and integration suites pass.
2. A Pi-originated voice phrase runs the correct routine and returns TTS to that Pi.
3. HA-only, Canvas-only, hybrid, offline-required, ambiguous, and elevated-risk examples select the
   expected owner and confirmation behavior.
4. An AI-generated draft can be reviewed, simulated, enabled, revised, and rolled back.
5. A repeated request uses the compiled fast path and demonstrably reduces latency.
6. Restart and database restore preserve active revisions and audit history.
7. No generated routine can invoke an unregistered tool or gain broader permissions through edits.

## Implementation order checklist

- [x] Phase 1: schema, storage, lifecycle
- [x] Phase 2: deterministic engine and simulation
- [x] Phase 3: visual management UI
- [x] Phase 4: triggers and voice matching
- [x] Phase 5: AI draft creation and ownership selection
- [x] Phase 6: repeated-request compilation
- [ ] Phase 7: sandboxed advanced processing
- [x] Documentation, threat-model, operations, backup, and functional/hardware release acceptance updated
