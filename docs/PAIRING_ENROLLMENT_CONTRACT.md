# P-003 Device Enrollment Contract (Edge ↔ Core)

**Status:** Implemented contract; reviewed 2026-07-31. The signed JSON credential described
below remains the application credential. TLS/mTLS deployment policy is installation-specific.

This document is the wire contract for the **device-facing** pairing handshake implemented in
`core/src/enrollment.ts`. It is what `canvas-edge-agentd` must send to Canvas Core to enroll a real
Ed25519 identity and receive a Phase 0 signed credential. The cryptographic binding (Ed25519
proof-of-possession) is genuine; the credential is a **signed JSON document, NOT an X.509
certificate**.

> **Phase 0 model.** This establishes the authoritative, proof-of-possession-bound device registry
> that the gateway enforces against. It is intentionally not X.509/mTLS yet (see
> `docs/PHASE_0_PKI_BOOTSTRAP_SPEC.md` §2). Do not treat the signed JSON credential as a TLS client
> cert — it is presented to the gateway as an identity claim that Core verifies against its registry.

---

## 0. Prerequisites

1. An admin creates a one-time invitation via
   `POST /api/admin/devices/invitations` (admin-authenticated, CSRF-protected). The response returns
   the plaintext `token` **exactly once**; only its SHA-256 hash is stored by Core.
2. The Edge agent generates a local Ed25519 keypair (`EdgeIdentity::generate(installation_id)`). The
   private key never leaves the agent.

---

## 1. `POST /api/pairing/begin`

Presents the invitation + installation ID + raw public key. Core validates the invitation
(hash/scope/expiry/unused) and issues an `EnrollmentChallenge`. The invitation is **reserved** at
this point (a second `begin` with the same token fails closed with `409`).

### Request

```json
{
  "invitation_token": "3f9c...64-hex-chars...",
  "installation_id": "installation-alpha",
  "public_key": "1f2b...32-bytes-hex (or base64)..."
}
```

- `invitation_token` — the plaintext one-time token from the admin bootstrap.
- `installation_id` — stable Edge installation identifier (free-form string).
- `public_key` — the **raw 32-byte** Ed25519 public key, hex (canonical) or base64.

### Response `200`

```json
{
  "challenge_id": "challenge-<uuid>",
  "nonce_hex": "<32-hex-char unpredictable nonce>",
  "expires_at_unix_ms": 1784440442000
}
```

- The challenge is valid for **30 seconds**. Answer before it expires.

### Fail-closed responses

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` / `invalid_public_key` | malformed body / key not 32 bytes |
| 401 | `invitation_not_found` | unknown token |
| 409 | `invitation_expired` | token past `expires_at` |
| 409 | `invitation_not_available` | token already reserved (challenge issued) or already used |

---

## 2. `POST /api/pairing/complete`

Presents the proof of possession. Core re-looks-up the invitation + pending challenge, verifies the
Ed25519 signature **byte-identically** to how `EdgeIdentity` produced it, then issues a signed
credential, marks the device `paired`, and consumes the invitation (atomic — exactly one winner).

### Request

```json
{
  "invitation_token": "3f9c...64-hex-chars...",
  "installation_id": "installation-alpha",
  "public_key": "1f2b...32-bytes-hex (or base64)...",
  "challenge_id": "challenge-<uuid>",
  "proof": {
    "challenge_id": "challenge-<uuid>",
    "signature_bytes": "<64-byte base64 Ed25519 signature>"
  }
}
```

- `proof.signature_bytes` — `EdgeIdentity::answer_enrollment_challenge(&challenge).signature_bytes`,
  base64-encoded (Core also accepts hex).

### Response `200`

```json
{
  "credential": {
    "format": "canvas-phase0-device-credential-v1",
    "serial": 1,
    "device_id": "device-<uuid>",
    "installation_id": "installation-alpha",
    "public_key_fingerprint": "<sha256-hex of raw public key>",
    "issued_at_unix_ms": 1784440442000,
    "expires_at_unix_ms": 1815976442000,
    "issuer_id": "canvas-core",
    "security_epoch": 1
  },
  "signature": "<base64 Ed25519 signature over canonical credential JSON>",
  "signer_public_key": "<base64 Core enrollment public key>"
}
```

- `credential.public_key_fingerprint` is the SHA-256 hex of the raw 32-byte public key — the same
  value `EdgeIdentity::public_key_fingerprint()` computes, so Core stores what the Edge would log.
- `signature` is Core's Ed25519 signature over the **canonical (sorted-key) JSON** of `credential`,
  verifiable with `signer_public_key`.

### Fail-closed responses

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` / `invalid_encoding` | malformed body / key or signature not 32/64 bytes |
| 401 | `challenge_not_found` | unknown/expired/already-completed challenge |
| 401 | `invitation_not_found` | token does not match the challenge's invitation |
| 401 | `binding_mismatch` | `installation_id` or `public_key` differs from the `begin` binding |
| 401 | `signature_invalid` | proof-of-possession signature failed verification (burns the invitation) |
| 409 | `challenge_expired` | challenge past `expires_at_unix_ms` |
| 409 | `invitation_not_available` | invitation already used |

> A failed `complete` **permanently burns** the invitation (fail-closed), matching the dev harness.
> Re-enroll with a fresh invitation.

---

## 3. How Core verifies the proof (byte-identical to `EdgeIdentity`)

Both sides build the signed payload with the same domain-separation prefix and field ordering:

```
canvas-edge-enrollment-v1\n<challenge_id>\n<nonce_hex>\n<installation_id>\n<public_key_fingerprint_hex>
```

- `public_key_fingerprint_hex` is the SHA-256 hex of the **raw 32-byte** public key, recomputed
  server-side from the presented `public_key` (never trusted as a self-reported claim).
- Core verifies with `ed25519.verify(signature, payload, presented_public_key)`.

This is locked by `edge/agent/tests/enrollment_payload_contract.rs` (Rust) and the happy-path test in
`core/test/enrollment.test.ts` (TypeScript). If either side changes the prefix or field order, the
handshake fails loudly.

---

## 4. Gateway auth gate (after enrollment)

`core/src/gateway.ts` accepts `edge.hello` under two modes:

- **Open pairing ON** (`CANVAS_CORE_ALLOW_OPEN_PAIRING=true`, the dev default): any hello is
  accepted exactly as before, so the proven Rust agent keeps connecting. Core logs a loud warning
  that production must set this `false`.
- **Open pairing OFF** (`CANVAS_CORE_ALLOW_OPEN_PAIRING=false`): the gateway **fails closed**. A
  hello is accepted only if it presents a valid enrolled identity, via either:
  - a `credential` block (Core signature verified with Core's enrollment key + registry match), or
  - a `public_key_fingerprint` or `installation_id` that matches a paired `device_credentials` row.

An unpaired hello is rejected with `{ "type": "error", "code": "unauthorized", "reason": "..." }`.

### Extended `edge.hello` (optional fields)

```json
{
  "type": "edge.hello",
  "device_id": "dev-hint",
  "installation_id": "installation-alpha",
  "public_key_fingerprint": "<sha256-hex>",
  "credential": {
    "credential": { "format": "canvas-phase0-device-credential-v1", "...": "..." },
    "signature": "<base64>"
  },
  "invitation_token": "optional-legacy-token"
}
```

`device_id` remains NON-AUTHORITATIVE; the enrolled credential / registry match is
the real device identity.

---

## 5. Daemon integration requirements

The first-boot enrollment and credential presentation path is implemented in `edge/agentd`.
The requirements remain here as the behavioral contract; rotation/revocation still needs the
production operations described in [`ROADMAP.md`](./ROADMAP.md).

1. On first boot (no enrolled credential cached locally), call `begin` then `complete` as above.
2. Persist the returned `credential` + `signature` + `signer_public_key` in the agent's secure local
   store (SQLite). Present them on every subsequent `edge.hello` (or rely on the registry match by
   `public_key_fingerprint`/`installation_id`).
3. If the gateway rejects with `unauthorized`, re-run the handshake with a fresh invitation.
4. Key rotation reuses the same proof-of-possession shape with the `canvas-edge-rotation-v1`
   prefix.
