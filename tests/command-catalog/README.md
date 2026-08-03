# Phase 0 command and capability catalog tests

This suite freezes the machine-readable Linux capability registry, the approved/planned Edge command catalog, and canonical logical request digests. It does not add planned commands to the active Device Protocol v1 schema; only `diagnostics.echo` remains an on-wire vertical slice.

A request digest is SHA-256 over RFC 8785/JCS canonical UTF-8 bytes for exactly:

```json
{
  "kind": "namespaced.kind",
  "semantic_version": 1,
  "parameters": {},
  "preconditions": {}
}
```

Transport IDs, stream sequence, timestamps, expiry, correlation, actor metadata, and retry count are deliberately excluded. Duplicate raw object keys, floats, unsafe integers, missing fields, and extra top-level fields fail closed. Array order is significant.

Run from the repository root:

```bash
npm run test:command-catalog
```
