# Canvas Skills guide

Last reviewed: 2026-08-02

## Purpose

Canvas Skill v1 gives Core reusable administrator-managed expertise similar to a Hermes agent
skill. A skill describes when it applies, instructions, examples, allowed typed tools, response
style, and an optional enabled Canvas Routine that performs actions.

A skill is not arbitrary JavaScript, Python, shell, SQL, or Home Assistant YAML. Advanced code
requires a future isolated sandbox with no Core secrets, host mounts, Docker socket, or unrestricted
network access.

## Definition

```json
{
  "schemaVersion": 1,
  "name": "Astronomy helper",
  "description": "Explains astronomy in plain language",
  "instructions": "Explain established astronomy and state uncertainty.",
  "invocation": {
    "phrases": ["explain the stars"],
    "keywords": ["astronomy", "explain"],
    "examples": ["Explain how a black hole forms"]
  },
  "allowedTools": [],
  "routineId": null,
  "responseStyle": "A concise spoken answer"
}
```

Exact phrases match after punctuation and whitespace normalization. Keyword matching requires at
least two configured keywords. Ambiguous enabled matches execute nothing and ask for clarification.

## Creation and activation

1. Open **Settings → Skills**.
2. Describe the capability and select **Plan**, or start a manual skill.
3. Review instructions, invocation data, permissions, and optional routine.
4. Save. This creates a disabled draft and immutable revision 1.
5. Select **Enable latest** after review. Later saves create draft revisions without changing the
   active revision until explicitly enabled.
6. Disable to remove the skill from routing, or archive it for retention.

AI planning receives registered tools and existing routine IDs. Core independently rejects invented
tools and missing routine IDs. The model cannot activate its own draft.

Core also registers typed `skill.plan` and confirmation-required `skill.create_draft` tools. This
allows an authorized AI workflow to design and save its own disabled skill proposal. There is
deliberately no AI-callable enable tool; activation remains an explicit administrator decision.

## Execution

- Prompt skills use the conversation provider with the enabled instructions and response style. If
  the skill declares `allowedTools`, Core exposes only those tools to the model, validates every
  requested tool against that allowlist, and executes at most three tool-call rounds through the
  ordinary Tool Registry policy. Tools requiring confirmation are not silently executed.
- Action skills reference a Canvas Routine. The routine engine revalidates roles, parameters,
  targets, confirmations, timeouts, and audit history on every run.
- Skills are checked before ordinary routines and general AI planning. Draft and disabled skills are
  never considered.
- Responses use the normal originating-device streaming TTS route.

## API

- `GET/POST /api/admin/skills`
- `GET /api/admin/skills/:id`
- `POST /api/admin/skills/plan`
- `POST /api/admin/skills/:id/revisions`
- `POST /api/admin/skills/:id/enable`
- `POST /api/admin/skills/:id/disable`
- `POST /api/admin/skills/:id/archive`

Reads require an authenticated viewer or administrator. Mutations require administrator role and
CSRF protection.

## Current boundary

Canvas Skill v1 supports prompt expertise and routine-backed actions. It does not yet provide ZIP
import/export, semantic embedding matching, a marketplace, signed third-party packages, per-skill
provider selection, or sandboxed code. Those extensions must retain the draft/review/activation and
typed-tool policy boundaries.

## Australian weather example

The current deployment includes an enabled **Explain Australian Weather Forecast** skill. It is
restricted to `mcp.au-weather.get_weather_for_location`, so current forecast questions use Bureau
of Meteorology data rather than model memory. The skill should pass a suburb, town, or postcode to
the tool and ask the user for a location when none was supplied.
