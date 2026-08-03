# Phase 0 Core admin security specification

## Status and scope

**Reference baseline; reviewed 2026-07-31.** The Core Admin API and authenticated web UI now
exist. This document records the security invariants exercised by `tests/admin-security/`;
current source and tests determine the implemented route set.

Active targets remain Linux `amd64` and `arm64`; admin browsers are platform-independent. Android remains frozen.

## Initial owner bootstrap

Core starts with no owner, no default password, and no reusable production bootstrap secret. Deployment explicitly selects one mode:

1. **Local-only:** claim is available only through the Core host console or a loopback-bound endpoint reached locally.
2. **Authenticated remote transfer:** an operator obtains a random 256-bit, short-lived, one-use secret through a separately authenticated out-of-band channel. The first web visitor does not receive it.

The Core stores only a domain-separated hash plus non-secret ID, mode, expiry, attempt state, and consumed status. A short display code may only be a rate-limited representation of high-entropy material; it is not server identity.

Owner creation and secret consumption occur in one transaction. Exactly one concurrent request wins. After an owner exists, every initial-claim record is consumed/disabled and the endpoint cannot create another owner. Expired, malformed, wrong-source, wrong-secret, exhausted-rate, and replayed claims fail closed and are audited without logging the supplied secret or password.

The executable model uses process-local serialization. Production requires PostgreSQL uniqueness/locking and reverse-proxy tests for remote-first-visitor, concurrency, source policy, body/rate limits, and endpoint disablement.

## Passwords and sessions

The model uses Node's built-in `scrypt` only to prove that plaintext passwords are not retained and that login/step-up compare a verifier. **Production should use a reviewed password library and a current Argon2id profile** with per-user salts, resource parameters stored beside the verifier, upgrade-on-login, breached/common-password controls, and bounded anti-DoS policy. No default or deployment-shared password is permitted.

A successful login always creates a new random session ID/token and ignores any caller-presented session identifier, preventing fixation. Core stores only token hashes. Recommended web delivery is an `HttpOnly`, `Secure`, host-only cookie with an explicit suitable `SameSite` policy and narrow path; raw session tokens do not enter local storage, URLs, logs, or ordinary API responses.

Sessions have idle and absolute expiry, rotate at login and privilege changes, and are revocable at logout, password/security change, role change, or incident response. Session lookup, expiry, revocation, and principal loading occur before authorization. Failed origin/CSRF/authorization attempts do not extend idle life.

## Origin and CSRF

The admin UI has one configured canonical HTTPS origin. Cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests require:

- an exact allowed `Origin` policy (with narrowly documented non-browser exceptions);
- a CSRF value presented through the approved cookie/header mechanism;
- equality between the presented values; and
- a hash match with the server-side session record.

Wildcard CORS is prohibited on privileged admin APIs. CORS is not authentication. State changes are never performed through `GET` or cross-origin form-compatible endpoints.

Production must test browser redirects, missing/`null` origins where relevant, preflight behavior, subdomain confusion, same-site sibling attacks, login CSRF, WebSocket origin, and reverse-proxy host/origin reconstruction.

## Roles and object scope

Authorization is server-side and deny-by-default after authentication. The baseline roles are:

- `viewer`: explicitly authorized reads;
- `operator`: day-to-day display/media/scene activation within assigned targets;
- `admin`: scene/device configuration and ordinary administration within scope;
- `owner`: installation security, users, integrations, PKI, and other explicitly owner-only operations.

A role grants operation class, not global object access. Core expands groups to immutable concrete targets, then verifies every site/device/object against the principal's scope. A mixed authorized/unauthorized expansion fails or is explicitly partitioned by API contract; it never silently controls the extra target.

Scoped service identities receive exact operation and target sets, random hash-only tokens, expiry/rotation/revocation in production, and no implied human role. The model refuses owner-sensitive PKI/integration/security scopes for service identities.

## Step-up and confirmation

PKI, integration-secret, security-policy, credential, and similarly sensitive mutations require a fresh password/WebAuthn-style step-up according to production policy. Step-up alone is not confirmation.

Confirmation is a random, short-lived, one-use capability bound to:

- authenticated session and effective principal;
- exact operation and semantic version;
- all expanded targets;
- normalized arguments/action digest;
- issuance and expiry; and
- applicable policy context.

Changing target, arguments, operation, or session invalidates confirmation. Replays fail. Confirmation is consumed transactionally with the authorized journal mutation, not when a malformed request merely presents the token. Voice proximity or a device certificate never substitutes for an authenticated human confirmation.

## Availability separation

Admin and device ingress use separate reverse-proxy routes, authentication, body/rate limits, and resource budgets. The model proves only that exhausting an admin admission pool cannot consume a reserved Device Gateway pool. Production must load-test login/API/upload/report abuse while at least 100 authenticated Edges maintain heartbeat, command delivery, and durable persistence.

## Executable evidence

`tests/admin-security/admin-security.test.ts` covers:

- remote-first-visitor rejection in local mode;
- 256-bit secret hygiene, expiry, rate limiting, and a 16-way one-winner claim race;
- session fixation prevention, hash-only storage, logout/replay, and idle/absolute expiry;
- role matrix and post-expansion site/device IDOR denial;
- exact origin and CSRF failure modes;
- step-up plus mutation/replay/expiry-safe confirmation;
- scoped service identity denial; and
- reserved device-ingress capacity under admin flood.

Run with `npm run test:admin-security` or the complete `npm run test:contracts` gate.

## Production gates still open

- Real owner/session/RBAC PostgreSQL tables and migrations.
- Argon2id/WebAuthn/MFA selection and secure recovery codes.
- Fastify hooks, cookie/CORS/CSRF implementation, proxy headers, TLS, and browser tests.
- Complete route/tool authorization matrix and audit journal.
- API/service-token expiry, rotation, revocation, and secret-store integration.
- Rate limiting across replicas and abusive/distributed sources.
- Email/identity-provider adapters, if later enabled.
- Clean owner recovery and break-glass operations with independent audit.

No current legacy route becomes safe merely because this specification exists; containment and phased replacement remain mandatory.
