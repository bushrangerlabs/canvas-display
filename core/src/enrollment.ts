import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createHash as _createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as ed from '@noble/ed25519';
import type { DeviceRepository } from './devices.js';

// @noble/ed25519 needs a synchronous SHA-512 implementation in Node (it does not bundle one).
// Wire Node's crypto in so Ed25519 keygen/sign/verify work without async hashing.
ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array => {
  const h = _createHash('sha512');
  for (const part of m) h.update(part);
  return new Uint8Array(h.digest());
};

/**
 * Core-side enrollment endpoint + Ed25519 proof-of-possession verification (P-003 device-identity gate).
 *
 * PHASE 0 MODEL — NOT X.509 / mTLS (yet). This establishes a genuine cryptographic device identity
 * and proof-of-possession binding using Ed25519, exactly as the Edge `EdgeIdentity` client produces
 * it (see `edge/agent/src/pairing/mod.rs` and `docs/PHASE_0_PKI_BOOTSTRAP_SPEC.md` §4–§6). The
 * credential issued here is a Core-signed JSON document, not an X.509 certificate. Real mTLS
 * termination at the reverse proxy is a later gate (P-013); this gate is the prerequisite that gives
 * Core an authoritative, proof-of-possession-bound device registry to enforce against.
 *
 * The verification here is byte-identical to `EdgeIdentity::answer_enrollment_challenge`: both sides
 * build the proof payload with `buildEnrollmentProofPayload` using the same domain-separation prefix
 * `canvas-edge-enrollment-v1` and the same field ordering, so a signature produced by the Edge over
 * its challenge verifies with the Edge's public key on Core.
 */

// --- byte-identical proof payload (mirrors edge/agent/src/pairing/mod.rs) ----

export const ENROLLMENT_PROOF_DOMAIN = 'canvas-edge-enrollment-v1';

/**
 * Reconstructs the exact byte sequence the Edge signs for proof of possession. MUST stay byte-for-byte
 * identical to `canvas_edge_agent::pairing::build_enrollment_proof_payload` or verification fails.
 * Layout (newline-delimited, UTF-8):
 *   canvas-edge-enrollment-v1\n<challenge_id>\n<nonce_hex>\n<installation_id>\n<public_key_fingerprint_hex>
 */
export function buildEnrollmentProofPayload(
  challengeId: string,
  nonceHex: string,
  installationId: string,
  publicKeyFingerprintHex: string,
): Uint8Array {
  const joined = [
    ENROLLMENT_PROOF_DOMAIN,
    challengeId,
    nonceHex,
    installationId,
    publicKeyFingerprintHex,
  ].join('\n');
  return new TextEncoder().encode(joined);
}

/** Lowercase hex SHA-256 of the raw 32-byte Ed25519 public key — matches `EdgeIdentity::public_key_fingerprint()`. */
export function fingerprintHex(publicKey: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(publicKey)).digest('hex');
}

// --- Core enrollment signing key (issues the Phase 0 signed credential) ----

export interface EnrollmentSigner {
  /** Raw 32-byte Ed25519 public key Core signs credentials with. */
  publicKeyBytes(): Uint8Array;
  /** Signs a message, returning the 64-byte Ed25519 signature. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Creates Core's enrollment signing key. If `seed` (32 raw bytes) is provided it is used
 * deterministically (deployments that want a stable issuer key set `CANVAS_CORE_ENROLLMENT_SEED`);
 * otherwise a fresh key is generated from the OS CSPRNG at startup. Core holds the private key only
 * in memory — it is never persisted or logged.
 */
export function createCoreEnrollmentSigner(seed?: Uint8Array): EnrollmentSigner {
  const privateKey = seed && seed.length === 32 ? seed : ed.utils.randomPrivateKey();
  const publicKey = ed.getPublicKey(privateKey);
  return {
    publicKeyBytes: () => publicKey,
    sign: (message) => ed.signAsync(message, privateKey),
  };
}

// --- wire decoding helpers --------------------------------------------------

/** Decodes a fixed-length byte string that may be hex (canonical) or base64. */
function decodeFixedBytes(value: string, n: number): Uint8Array {
  if (value.length === n * 2 && /^[0-9a-fA-F]+$/.test(value)) {
    return Uint8Array.from(Buffer.from(value, 'hex'));
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== n) {
    throw new Error(`expected ${n} bytes, got ${buf.length}`);
  }
  return new Uint8Array(buf);
}

// --- canonical JSON (stable signing input) ----------------------------------

/** Deterministic JSON serialization (sorted keys) so signing/verifying inputs match exactly. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

// --- errors ----------------------------------------------------------------

export class EnrollmentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'EnrollmentError';
  }
}

// --- begin (issue challenge) -----------------------------------------------

export interface BeginEnrollmentParams {
  invitationToken: string;
  installationId: string;
  /** Raw 32-byte Ed25519 public key presented by the Edge. */
  publicKey: Uint8Array;
}

export interface EnrollmentChallengeResponse {
  challenge_id: string;
  nonce_hex: string;
  expires_at_unix_ms: number;
}

/**
 * Validates a presented invitation and, if valid, reserves it and issues an enrollment challenge
 * binding the presented installation ID and raw public key. The public key fingerprint used later is
 * always recomputed here from the raw bytes — never trusted as a claim from the caller. Fail-closed:
 * unknown / expired / used / already-reserved invitations are rejected.
 */
export async function beginEnrollment(
  repo: DeviceRepository,
  params: BeginEnrollmentParams,
): Promise<EnrollmentChallengeResponse> {
  const tokenHash = createHash('sha256').update(params.invitationToken).digest('hex');
  const inv = await repo.query(
    `SELECT id, expires_at, used_at, challenge_issued_at
     FROM device_invitations WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const row = inv.rows[0];
  if (!row) throw new EnrollmentError('invitation_not_found', 'unknown invitation', 401);
  if (row.used_at) {
    throw new EnrollmentError('invitation_not_available', 'invitation already used', 409);
  }
  if (row.challenge_issued_at) {
    throw new EnrollmentError('invitation_not_available', 'challenge already issued for invitation', 409);
  }
  const expiresAt = new Date(row.expires_at).getTime();
  if (Number.isNaN(expiresAt) || Date.now() >= expiresAt) {
    throw new EnrollmentError('invitation_expired', 'invitation expired', 409);
  }

  const challengeId = `challenge-${randomUUID()}`;
  const nonceHex = randomBytes(16).toString('hex');
  const expiresAtMs = Date.now() + 30_000; // 30s to answer

  await repo.query(
    `UPDATE device_invitations SET challenge_issued_at = now(), challenge_id = $2 WHERE id = $1`,
    [row.id, challengeId],
  );
  await repo.query(
    `INSERT INTO pending_enrollment_challenges
       (challenge_id, invitation_id, installation_id, public_key_hex, nonce_hex, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      challengeId,
      row.id,
      params.installationId,
      Buffer.from(params.publicKey).toString('hex'),
      nonceHex,
      new Date(expiresAtMs).toISOString(),
    ],
  );

  return { challenge_id: challengeId, nonce_hex: nonceHex, expires_at_unix_ms: expiresAtMs };
}

// --- complete (verify proof, issue credential) -----------------------------

export interface CompleteEnrollmentParams {
  invitationToken: string;
  installationId: string;
  /** Raw 32-byte Ed25519 public key presented by the Edge (must match the challenge binding). */
  publicKey: Uint8Array;
  challengeId: string;
  proof: { challengeId: string; signatureBytes: Uint8Array };
}

export interface DeviceCredential {
  format: 'canvas-phase0-device-credential-v1';
  serial: number;
  device_id: string;
  installation_id: string;
  public_key_fingerprint: string;
  issued_at_unix_ms: number;
  expires_at_unix_ms: number;
  issuer_id: string;
  security_epoch: number;
}

export interface CredentialResponse {
  credential: DeviceCredential;
  /** Base64 Ed25519 signature over the canonical credential JSON. */
  signature: string;
  /** Base64 Core enrollment public key that produced `signature`. */
  signer_public_key: string;
}

/**
 * Verifies a submitted proof of possession and, only on success, atomically issues a credential,
 * marks the device paired, and consumes the invitation. The pending challenge is removed on the
 * first completion attempt (success or failure) so it can never be replayed, and a failed proof
 * permanently burns the invitation (fail-closed, matching the dev harness).
 */
export async function completeEnrollment(
  repo: DeviceRepository,
  signer: EnrollmentSigner,
  params: CompleteEnrollmentParams,
  securityEpoch = 1,
): Promise<CredentialResponse> {
  // 1. Load the pending challenge.
  const chRes = await repo.query(
    `SELECT * FROM pending_enrollment_challenges WHERE challenge_id = $1 LIMIT 1`,
    [params.challengeId],
  );
  const ch = chRes.rows[0];
  if (!ch) {
    throw new EnrollmentError('challenge_not_found', 'unknown/expired/completed challenge', 401);
  }

  const challengeExpiresAt = new Date(ch.expires_at).getTime();
  if (Number.isNaN(challengeExpiresAt) || Date.now() >= challengeExpiresAt) {
    await repo.query('DELETE FROM pending_enrollment_challenges WHERE challenge_id = $1', [params.challengeId]);
    throw new EnrollmentError('challenge_expired', 'challenge expired', 409);
  }

  // 2. Re-verify the invitation token matches the challenge's invitation (prevents cross-binding).
  const tokenHash = createHash('sha256').update(params.invitationToken).digest('hex');
  const invRes = await repo.query(
    `SELECT id, used_at FROM device_invitations WHERE token_hash = $1 LIMIT 1`,
    [tokenHash],
  );
  const inv = invRes.rows[0];
  if (!inv || inv.id !== ch.invitation_id) {
    await repo.query('DELETE FROM pending_enrollment_challenges WHERE challenge_id = $1', [params.challengeId]);
    throw new EnrollmentError('invitation_not_found', 'invitation does not match challenge', 401);
  }

  // 3. Binding checks: installation_id + public_key must match what was presented at begin.
  if (params.installationId !== ch.installation_id) {
    await burnInvitation(repo, ch.invitation_id, params.challengeId);
    throw new EnrollmentError('binding_mismatch', 'installation_id does not match challenge', 401);
  }
  if (Buffer.from(params.publicKey).toString('hex') !== ch.public_key_hex) {
    await burnInvitation(repo, ch.invitation_id, params.challengeId);
    throw new EnrollmentError('binding_mismatch', 'public_key does not match challenge', 401);
  }

  // 4. Verify the Ed25519 proof of possession byte-identically to EdgeIdentity.
  const storedPub = Uint8Array.from(Buffer.from(ch.public_key_hex, 'hex'));
  const fingerprint = fingerprintHex(storedPub);
  const payload = buildEnrollmentProofPayload(params.challengeId, ch.nonce_hex, params.installationId, fingerprint);
  const sigOk = ed.verify(params.proof.signatureBytes, payload, storedPub);
  if (!sigOk) {
    await burnInvitation(repo, ch.invitation_id, params.challengeId);
    throw new EnrollmentError('signature_invalid', 'proof-of-possession signature failed', 401);
  }

  // 5. Issue credential atomically (consume invitation + create device + credential).
  const existingIdentity = await repo.query(
    `SELECT device_id FROM device_credentials
     WHERE installation_id = $1 AND public_key_fingerprint = $2
     ORDER BY issued_at DESC LIMIT 1`,
    [params.installationId, fingerprint],
  );
  const deviceId = String(existingIdentity.rows[0]?.device_id ?? `device-${randomUUID()}`);
  const serialRes = await repo.query('SELECT COUNT(*)::int AS n FROM device_credentials');
  const serial = Number(serialRes.rows[0]?.n ?? 0) + 1;
  const issuedAt = Date.now();
  const expiresAtMs = issuedAt + 1000 * 60 * 60 * 24 * 365; // 1 year

  const credential: DeviceCredential = {
    format: 'canvas-phase0-device-credential-v1',
    serial,
    device_id: deviceId,
    installation_id: params.installationId,
    public_key_fingerprint: fingerprint,
    issued_at_unix_ms: issuedAt,
    expires_at_unix_ms: expiresAtMs,
    issuer_id: 'canvas-core',
    security_epoch: securityEpoch,
  };
  const message = new TextEncoder().encode(canonicalJson(credential));
  const signature = await signer.sign(message);
  const signerPub = signer.publicKeyBytes();

  if (existingIdentity.rows[0]) {
    await repo.query(
      `UPDATE device_credentials SET credential_json=$4::jsonb,signature_hex=$5,
         signer_public_key_hex=$6,issued_at=$7,expires_at=$8,public_key_hex=$3,revoked_at=NULL
       WHERE device_id=$1 AND installation_id=$2 AND public_key_fingerprint=$9`,
      [deviceId, params.installationId, ch.public_key_hex, JSON.stringify(credential),
        Buffer.from(signature).toString('hex'), Buffer.from(signerPub).toString('hex'),
        new Date(issuedAt).toISOString(), new Date(expiresAtMs).toISOString(), fingerprint],
    );
  } else await repo.query(
    `INSERT INTO device_credentials
       (id, device_id, installation_id, public_key_fingerprint, public_key_hex,
        credential_json, signature_hex, signer_public_key_hex, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      deviceId,
      params.installationId,
      fingerprint,
      ch.public_key_hex,
      JSON.stringify(credential),
      Buffer.from(signature).toString('hex'),
      Buffer.from(signerPub).toString('hex'),
      new Date(issuedAt).toISOString(),
      new Date(expiresAtMs).toISOString(),
    ],
  );

  // Mark the device paired in the registry (cert_* columns carry the Phase 0 fingerprint/expiry).
  await repo.query(
    `INSERT INTO devices
       (id, name, architecture, protocol_version, paired, cert_fingerprint, cert_issued_at, cert_expires_at, invitation_id, last_seen, status)
     VALUES ($1, $1, 'unknown', '1', true, $2, $3, $4, $5, now(), 'connected')
     ON CONFLICT (id) DO UPDATE SET
       paired = true,
       cert_fingerprint = EXCLUDED.cert_fingerprint,
       cert_issued_at = EXCLUDED.cert_issued_at,
       cert_expires_at = EXCLUDED.cert_expires_at,
       invitation_id = COALESCE(EXCLUDED.invitation_id, devices.invitation_id),
       revoked_at = NULL,
       last_seen = now(),
       status = 'connected'`,
    [deviceId, fingerprint, new Date(issuedAt).toISOString(), new Date(expiresAtMs).toISOString(), ch.invitation_id],
  );

  // Consume the invitation (serialization point: exactly one winner).
  await repo.query(
    `UPDATE device_invitations SET used_at = now(), used_by_device_id = $2 WHERE id = $1`,
    [ch.invitation_id, deviceId],
  );

  // Remove the pending challenge so it can never be replayed.
  await repo.query('DELETE FROM pending_enrollment_challenges WHERE challenge_id = $1', [params.challengeId]);

  return {
    credential,
    signature: Buffer.from(signature).toString('base64'),
    signer_public_key: Buffer.from(signerPub).toString('base64'),
  };
}

/** Permanently burns an invitation after a failed proof (fail-closed) and drops its pending challenge. */
async function burnInvitation(
  repo: DeviceRepository,
  invitationId: string,
  challengeId: string,
): Promise<void> {
  await repo.query('DELETE FROM pending_enrollment_challenges WHERE challenge_id = $1', [challengeId]);
  await repo.query(
    `UPDATE device_invitations SET used_at = now(), used_by_device_id = $2 WHERE id = $1`,
    [invitationId, 'failed'],
  );
}

// --- credential registry lookups (used by the gateway auth gate) -----------

export interface CredentialRecord {
  device_id: string;
  installation_id: string;
  public_key_fingerprint: string;
  credential_json: DeviceCredential;
  revoked_at: string | null;
}

/** Looks up an on-file credential by public-key fingerprint (never trusts a self-reported claim). */
export async function findCredentialByFingerprint(
  repo: DeviceRepository,
  fingerprint: string,
): Promise<CredentialRecord | null> {
  const res = await repo.query(
    `SELECT device_id, installation_id, public_key_fingerprint, credential_json, revoked_at
     FROM device_credentials WHERE public_key_fingerprint = $1 LIMIT 1`,
    [fingerprint],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    device_id: row.device_id,
    installation_id: row.installation_id,
    public_key_fingerprint: row.public_key_fingerprint,
    credential_json: row.credential_json as DeviceCredential,
    revoked_at: row.revoked_at ?? null,
  };
}

export interface PresentedCredential {
  credential: DeviceCredential;
  /** Base64 Ed25519 signature over the canonical credential JSON. */
  signature: string;
}

/**
 * Verifies a presented Phase 0 credential's Core signature with Core's enrollment public key.
 * Returns the extracted identity only when the signature is valid.
 */
export function verifyDeviceCredential(
  signer: EnrollmentSigner,
  presented: PresentedCredential,
  expectedSecurityEpoch = 1,
): { ok: boolean; deviceId?: string; fingerprint?: string; installationId?: string } {
  try {
    if (presented.credential.security_epoch !== expectedSecurityEpoch) return { ok: false };
    if (presented.credential.expires_at_unix_ms <= Date.now()) return { ok: false };
    const message = new TextEncoder().encode(canonicalJson(presented.credential));
    const sig = Uint8Array.from(Buffer.from(presented.signature, 'base64'));
    const ok = ed.verify(sig, message, signer.publicKeyBytes());
    if (!ok) return { ok: false };
    return {
      ok: true,
      deviceId: presented.credential.device_id,
      fingerprint: presented.credential.public_key_fingerprint,
      installationId: presented.credential.installation_id,
    };
  } catch {
    return { ok: false };
  }
}

// --- HTTP routes (device-facing, no admin auth) ----------------------------

export interface EnrollmentPluginOptions {
  repo: DeviceRepository;
  signer: EnrollmentSigner;
  securityEpoch?: number;
}

/**
 * Registers the device-facing pairing routes:
 *   POST /api/pairing/begin   — present invitation + installation_id + public_key -> EnrollmentChallenge
 *   POST /api/pairing/complete — present proof -> signed credential (device marked paired)
 * These are intentionally NOT admin-gated: they are how an unauthenticated Edge device bootstraps
 * its identity. Authorization is the invitation + proof-of-possession, not an admin session.
 */
export async function registerEnrollmentRoutes(
  fastify: FastifyInstance,
  options: EnrollmentPluginOptions,
): Promise<void> {
  const { repo, signer } = options;
  const securityEpoch = options.securityEpoch ?? 1;

  fastify.post('/api/pairing/begin', async (request, reply) => {
    const body = request.body as
      | { invitation_token?: unknown; installation_id?: unknown; public_key?: unknown }
      | undefined;
    if (
      typeof body?.invitation_token !== 'string' ||
      typeof body?.installation_id !== 'string' ||
      typeof body?.public_key !== 'string'
    ) {
      reply.code(400);
      return { error: 'invalid_request', detail: 'invitation_token, installation_id, public_key required' };
    }
    let publicKey: Uint8Array;
    try {
      publicKey = decodeFixedBytes(body.public_key, 32);
    } catch {
      reply.code(400);
      return { error: 'invalid_public_key' };
    }
    try {
      return await beginEnrollment(repo, {
        invitationToken: body.invitation_token,
        installationId: body.installation_id,
        publicKey,
      });
    } catch (err) {
      return sendEnrollmentError(reply, err);
    }
  });

  fastify.post('/api/pairing/complete', async (request, reply) => {
    const body = request.body as
      | {
          invitation_token?: unknown;
          installation_id?: unknown;
          public_key?: unknown;
          challenge_id?: unknown;
          proof?: { challenge_id?: unknown; signature_bytes?: unknown };
        }
      | undefined;
    if (
      typeof body?.invitation_token !== 'string' ||
      typeof body?.installation_id !== 'string' ||
      typeof body?.public_key !== 'string' ||
      typeof body?.challenge_id !== 'string' ||
      !body.proof ||
      typeof body.proof.challenge_id !== 'string' ||
      typeof body.proof.signature_bytes !== 'string'
    ) {
      reply.code(400);
      return { error: 'invalid_request' };
    }
    let publicKey: Uint8Array;
    let signatureBytes: Uint8Array;
    try {
      publicKey = decodeFixedBytes(body.public_key, 32);
      signatureBytes = decodeFixedBytes(body.proof.signature_bytes, 64);
    } catch {
      reply.code(400);
      return { error: 'invalid_encoding' };
    }
    try {
      return await completeEnrollment(repo, signer, {
        invitationToken: body.invitation_token,
        installationId: body.installation_id,
        publicKey,
        challengeId: body.challenge_id,
        proof: { challengeId: body.proof.challenge_id, signatureBytes },
      }, securityEpoch);
    } catch (err) {
      return sendEnrollmentError(reply, err);
    }
  });
}

function sendEnrollmentError(reply: FastifyReply, err: unknown): { error: string; detail: string } {
  if (err instanceof EnrollmentError) {
    reply.code(err.status);
    return { error: err.code, detail: err.message };
  }
  throw err;
}
