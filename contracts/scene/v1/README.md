# Canvas Scene Manifest v1

A scene manifest is an immutable, credential-free description of one published scene revision. Core authenticates acquisition; Edge stages and verifies every referenced object before activation.

## Frozen v1 rules

- The schema is strict: unknown fields are rejected. A new field requires a versioned contract change rather than an unreviewed extension that could carry credentials or change digest semantics.
- `document` is the primary scene JSON object and must be `scene.json` with media type `application/vnd.canvas.scene+json`.
- `assets` contains content hashes and metadata only. Download URLs are short-lived transport data and never part of the immutable manifest.
- Logical paths are canonical relative cache names. Empty, `.`, and `..` segments, absolute paths, backslashes, and duplicate paths across `document` and `assets` are invalid.
- Every object is limited to 268,435,456 bytes (256 MiB). The document plus all asset references are limited to 1,073,741,824 bytes (1 GiB), counted per reference with overflow-safe arithmetic.
- A repeated content hash must declare the same byte size everywhere in one manifest.
- Allowed origins are canonical HTTP(S) origins only: no path, query, fragment, or username/password userinfo.
- No API key, bearer token, Home Assistant credential, provider credential, or download authorization is permitted in a manifest.
- Edge verifies required capabilities, streamed object sizes and SHA-256 hashes, origin policy, and the complete staged set before atomic activation.
- The current and previous known-good revisions are protected from garbage collection.

## Manifest digest canonicalization

`manifest_digest` is encoded as lowercase `sha256:<64 lowercase hex characters>` and is calculated as follows:

1. Parse the manifest as I-JSON and reject duplicate object member names, invalid Unicode, non-integer numeric fields, and numbers outside the schema bounds.
2. Remove only the top-level `manifest_digest` member.
3. Serialize the remaining value with RFC 8785 JSON Canonicalization Scheme (JCS).
4. Hash the canonical UTF-8 bytes with SHA-256 and prepend `sha256:` to the lowercase hexadecimal digest.

Array order is digest-significant. Core producers must emit deterministic ordering for set-like arrays: capabilities and subscription fields lexically, assets by `logical_path`, entity subscriptions by `entity_id`, and allowed origins lexically. Edge verifies the received order and digest; it does not silently reorder a signed or authenticated manifest.

Shared fixtures under `fixtures/canonicalization/` now validate this policy byte-for-byte in Node and Rust, including duplicate-key rejection, UTF-16 key ordering, Unicode handling, array-order significance, mutations, and invalid numbers. The isolated `tests/scene-store/` model also verifies actual object byte sizes/hashes before readiness and atomic activation. Production filesystem, PostgreSQL, authenticated transport, and WebKit integration remain later gates.

## Fixture manifest

Each fixture entry has final contract validity in `valid`. `schema_valid` is optional and defaults to `valid`; it is set explicitly when a fixture is structurally valid JSON Schema but must fail a cross-field semantic rule such as duplicate paths or aggregate size.

## Validation

The root contract suite validates fixtures and generated TypeScript/Rust output:

```bash
npm run test:contracts
```
