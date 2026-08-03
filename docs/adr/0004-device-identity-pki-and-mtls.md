# ADR 0004: Device identity, PKI, pairing, and mTLS

- Status: Accepted
- Date: 2026-07-18
- Decision IDs: P-003, P-012, P-013

## Context

The legacy socket accepts a caller-selected `device_id`. A central fleet gateway cannot trust LAN location, query parameters, headers supplied by clients, or JSON identity claims.

## Decision

- Every Edge generates an Ed25519 private key locally and enrolls with a proof-of-possession CSR.
- Pairing uses an authenticated Core bootstrap plus a short-lived, one-use, hashed invitation.
- Canvas manages a private device PKI with an offline root and protected online issuing intermediate.
- The certificate binds the immutable device ID. Core derives identity from the authenticated connection.
- A dedicated device hostname terminates mTLS at the reverse proxy.
- The proxy strips client identity headers, validates the certificate chain, and forwards verified certificate information only over a protected internal channel.
- The internal Gateway is not exposed and independently checks certificate serial, device status, revocation, and clone/concurrent use.
- Rotation, long-offline expiry recovery, active-session revocation, issuer rotation, and disaster restore are explicit PKI procedures.

## Consequences

- Each device can be revoked independently without distributing HA or admin credentials.
- Pairing must authenticate Core as well as Edge; a short code alone is insufficient when server trust is not already established.
- PKI backup and monotonic revocation recovery become production responsibilities.

## Validation gates

- Concurrent invitation consumption succeeds once.
- Rogue bootstrap, cloned certificate, expired certificate, rotation, targeted revocation, active disconnect, and restore scenarios fail safely.
- Renderer/WebViews cannot read the Edge private key.
- No payload `device_id` can change the authenticated principal.
