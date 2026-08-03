# Canvas Edge protocol simulator

This is a deterministic, in-memory Phase 0 simulator for Device Protocol v1. It has no sockets, hardware access, credentials, SQLite database, or Tauri dependency.

It exists to prove protocol behavior before the production Rust Agent is connected to Canvas Core:

- hello/welcome and resume cursors
- stream epochs, contiguous sequences, ACKs, and reset errors
- desired-state deduplication
- reported-state convergence
- replay-safe command execution and stored-result replay
- idempotency-key/request-digest conflicts

The simulator is not a production Edge runtime. Phase 1 replaces its memory stores with durable Edge SQLite and authenticated WSS transport while retaining the same fixtures and conformance behavior.
