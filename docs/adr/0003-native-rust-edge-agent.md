# ADR 0003: Separate native Rust Edge Agent

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: P-002, O-015

## Context

The Tauri renderer currently owns the server socket and launches a full Node sidecar. Renderer reloads, WebView content, device credentials, durable command state, and privileged hardware operations should not share one trust/process boundary.

## Decision

- Implement Canvas Edge Agent as a separate Rust system service supervised by `systemd`.
- Keep Tauri as an unprivileged renderer connected through peer-authenticated, method-scoped local IPC.
- Keep device private keys, durable delivery, hardware policy, audio/media supervision, and renderer restart control in the Agent.
- Use a separately supervised narrow updater/helper for package installation and rollback.
- During Phase 0, `edge/agent` is a pure library/reducer and generated-protocol consumer. Do not alter Tauri packaging or launch behavior.
- Do not create a repository-root Cargo workspace. `edge/` is isolated from `browser/linux/src-tauri`.

## Consequences

- Rust adds implementation work but removes the final Edge dependency on Node and `better_sqlite3.node`.
- Renderer compromise does not automatically grant device identity or privileged operations.
- The Agent can remain connected and preserve state while Tauri restarts.
- Host root or unrestricted physical disk compromise is outside the initial software-only guarantee; TPM/secure-boot work may strengthen it later.

## Validation gates

- Generated Rust protocol types accept the same valid fixtures as TypeScript.
- Replay-safe duplicate commands execute once; digest conflicts fail closed.
- Phase 1 proves IPC peer credentials, method capabilities, restart recovery, and dedicated local storage before handling real hardware.
