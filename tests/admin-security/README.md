# Phase 0 Core admin security model

This isolated Node 20 model freezes owner bootstrap, session, authorization, CSRF/origin, confirmation, service identity, and ingress-budget invariants. It does not import or modify the current legacy server and is not an HTTP/authentication implementation.

Coverage includes:

- local console/loopback-only owner claim;
- optional 256-bit, expiring, one-use remote owner claim with hash-only persistence and attempt limits;
- exactly one concurrent initial-owner winner and permanent bootstrap disablement afterward;
- password verifier/session token modeling with fixation prevention, idle/absolute expiry, logout, and hash-only persistence;
- exact admin origin plus matching stored CSRF proof for cookie-authenticated mutations;
- deny-by-default `viewer`/`operator`/`admin`/`owner` role checks;
- site/device scope checks after target expansion;
- scoped service identities that cannot receive owner-sensitive operations;
- password step-up and short-lived, session/action-digest-bound one-use confirmation;
- a separate reserved Device Gateway admission budget that admin floods cannot consume.

Run:

```bash
npm run test:admin-security
```
