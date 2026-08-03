import type { KeyObject } from 'node:crypto';
import {
  PHASE0_CORE_CHALLENGE_FORMAT,
  PHASE0_CREDENTIAL_BUNDLE_FORMAT,
  PHASE0_ISSUER_REQUEST_FORMAT,
  PHASE0_PAIRING_BOOTSTRAP_FORMAT,
  PHASE0_RECOVERY_GRANT_FORMAT,
  CoreEndpointIdentity,
  PkiHarnessError,
  assertCredentialBundleCryptography,
  assertIssuerAuthorization,
  canonicalEndpoint,
  canonicalJson,
  clonePlain,
  credentialBindingDigest,
  defaultEntropy,
  digestObject,
  generateEd25519KeyPair,
  importEd25519PublicKey,
  publicKeyFingerprint,
  safeStringEqual,
  signPayload,
  verifyCoreChallenge,
  verifyPayload,
  type EntropySource,
  type IssuedCredentialBundle,
  type IssuerSigningRequest,
  type KeyPairMaterial,
  type OwnerAuthorizedRecoveryGrant,
  type PairingBootstrap,
  type PairingScope,
  type Phase0CredentialPayload,
  type PresentedCoreIdentity,
  type SignedCoreChallenge,
  type SignedIssuerAuthorization,
} from './crypto-model.js';

const ENROLLMENT_REQUEST_FORMAT = 'canvas-phase0-enrollment-request-v1' as const;
const ENROLLMENT_PROOF_FORMAT = 'canvas-phase0-enrollment-pop-v1' as const;
const CONNECTION_PROOF_FORMAT = 'canvas-phase0-connection-pop-v1' as const;
const ROTATION_REQUEST_FORMAT = 'canvas-phase0-key-rotation-request-v1' as const;
const ROTATION_PROOF_FORMAT = 'canvas-phase0-key-rotation-pop-v1' as const;
const RECOVERY_REQUEST_FORMAT = 'canvas-phase0-credential-recovery-request-v1' as const;
const RECOVERY_PROOF_FORMAT = 'canvas-phase0-credential-recovery-pop-v1' as const;
const DEFAULT_CHALLENGE_TTL_MS = 60_000;
const DEFAULT_CREDENTIAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_INVITATION_BYTES = 32;
const DEFAULT_RECOVERY_GRANT_BYTES = 32;
const MINIMUM_SECRET_BYTES = 16;
const MAX_RECOVERY_GRANT_TTL_MS = 15 * 60_000;

export interface EnrollmentRequest {
  readonly format: typeof ENROLLMENT_REQUEST_FORMAT;
  readonly endpoint: string;
  readonly invitationSecret: string;
  readonly scope: PairingScope;
  readonly installationId: string;
  readonly keyAlgorithm: 'Ed25519';
  readonly publicKeySpki: string;
}

export interface EnrollmentChallengePayload {
  readonly format: typeof PHASE0_CORE_CHALLENGE_FORMAT;
  readonly purpose: 'enrollment';
  readonly challengeId: string;
  readonly endpoint: string;
  readonly nonce: string;
  readonly invitationHash: string;
  readonly installationId: string;
  readonly publicKeySpki: string;
  readonly publicKeyFingerprint: string;
  readonly scope: PairingScope;
  readonly securityEpoch: number;
  readonly expiresAtMs: number;
}

export type EnrollmentChallenge = SignedCoreChallenge<EnrollmentChallengePayload>;

export interface EnrollmentProofPayload {
  readonly format: typeof ENROLLMENT_PROOF_FORMAT;
  readonly challengeId: string;
  readonly challengeDigest: string;
  readonly installationId: string;
  readonly publicKeyFingerprint: string;
  readonly securityEpoch: number;
}

export interface EnrollmentProof {
  readonly challenge: EnrollmentChallenge;
  readonly payload: EnrollmentProofPayload;
  readonly edgeSignature: string;
}

export interface ConnectionChallengePayload {
  readonly format: typeof PHASE0_CORE_CHALLENGE_FORMAT;
  readonly purpose: 'connection';
  readonly challengeId: string;
  readonly endpoint: string;
  readonly nonce: string;
  readonly connectionId: string;
  readonly observedInstallationInstanceId: string;
  readonly serial: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly credentialDigest: string;
  readonly securityEpoch: number;
  readonly expiresAtMs: number;
}

export type ConnectionChallenge = SignedCoreChallenge<ConnectionChallengePayload>;

export interface ConnectionProofPayload {
  readonly format: typeof CONNECTION_PROOF_FORMAT;
  readonly challengeId: string;
  readonly challengeDigest: string;
  readonly serial: string;
  readonly connectionId: string;
  readonly observedInstallationInstanceId: string;
  readonly securityEpoch: number;
}

export interface ConnectionProof {
  readonly challenge: ConnectionChallenge;
  readonly payload: ConnectionProofPayload;
  readonly edgeSignature: string;
}

export interface KeyRotationRequest {
  readonly format: typeof ROTATION_REQUEST_FORMAT;
  readonly installationId: string;
  readonly currentSerial: string;
  readonly newKeyAlgorithm: 'Ed25519';
  readonly newPublicKeySpki: string;
}

export interface KeyRotationChallengePayload {
  readonly format: typeof PHASE0_CORE_CHALLENGE_FORMAT;
  readonly purpose: 'key_rotation';
  readonly challengeId: string;
  readonly endpoint: string;
  readonly nonce: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly currentSerial: string;
  readonly currentPublicKeyFingerprint: string;
  readonly newPublicKeySpki: string;
  readonly newPublicKeyFingerprint: string;
  readonly securityEpoch: number;
  readonly expiresAtMs: number;
}

export type KeyRotationChallenge = SignedCoreChallenge<KeyRotationChallengePayload>;

export interface KeyRotationProofPayload {
  readonly format: typeof ROTATION_PROOF_FORMAT;
  readonly challengeId: string;
  readonly challengeDigest: string;
  readonly sessionId: string;
  readonly currentSerial: string;
  readonly newPublicKeyFingerprint: string;
  readonly securityEpoch: number;
}

export interface KeyRotationProof {
  readonly challenge: KeyRotationChallenge;
  readonly payload: KeyRotationProofPayload;
  readonly currentKeyAuthorizationSignature: string;
  readonly newKeyProofSignature: string;
}

export interface OwnerRecoveryAuthorization {
  readonly principalId: string;
  readonly role: 'owner';
  readonly stepUpVerified: true;
  readonly authorizationId: string;
}

export interface CredentialRecoveryRequest {
  readonly format: typeof RECOVERY_REQUEST_FORMAT;
  readonly endpoint: string;
  readonly recoverySecret: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly preserveDeviceId: boolean;
  readonly newKeyAlgorithm: 'Ed25519';
  readonly newPublicKeySpki: string;
}

export interface CredentialRecoveryChallengePayload {
  readonly format: typeof PHASE0_CORE_CHALLENGE_FORMAT;
  readonly purpose: 'credential_recovery';
  readonly challengeId: string;
  readonly endpoint: string;
  readonly nonce: string;
  readonly recoveryGrantHash: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly preserveDeviceId: boolean;
  readonly currentSerial: string;
  readonly nextGeneration: number;
  readonly newPublicKeySpki: string;
  readonly newPublicKeyFingerprint: string;
  readonly securityEpoch: number;
  readonly expiresAtMs: number;
}

export type CredentialRecoveryChallenge = SignedCoreChallenge<CredentialRecoveryChallengePayload>;

export interface CredentialRecoveryProofPayload {
  readonly format: typeof RECOVERY_PROOF_FORMAT;
  readonly challengeId: string;
  readonly challengeDigest: string;
  readonly recoveryGrantHash: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly preserveDeviceId: boolean;
  readonly currentSerial: string;
  readonly nextGeneration: number;
  readonly newPublicKeyFingerprint: string;
  readonly securityEpoch: number;
}

export interface CredentialRecoveryProof {
  readonly challenge: CredentialRecoveryChallenge;
  readonly payload: CredentialRecoveryProofPayload;
  readonly newKeyProofSignature: string;
}

export interface SecurityFenceSnapshot {
  readonly sequence: number;
  readonly securityEpoch: number;
}

export class MonotonicSecurityFence {
  #sequence: number;
  #securityEpoch: number;

  constructor(initial: Partial<SecurityFenceSnapshot> = {}) {
    this.#sequence = initial.sequence ?? 0;
    this.#securityEpoch = initial.securityEpoch ?? 1;
    if (!Number.isSafeInteger(this.#sequence) || this.#sequence < 0) {
      throw new PkiHarnessError('invalid_security_fence', 'Security fence sequence must be non-negative.');
    }
    if (!Number.isSafeInteger(this.#securityEpoch) || this.#securityEpoch < 1) {
      throw new PkiHarnessError('invalid_security_fence', 'Security epoch must be at least one.');
    }
  }

  get snapshot(): SecurityFenceSnapshot {
    return {
      sequence: this.#sequence,
      securityEpoch: this.#securityEpoch,
    };
  }

  recordMutation(): SecurityFenceSnapshot {
    this.#sequence += 1;
    return this.snapshot;
  }

  reconcileDatabase(checkpointSequence: number, databaseSecurityEpoch: number): {
    readonly stale: boolean;
    readonly snapshot: SecurityFenceSnapshot;
  } {
    if (checkpointSequence > this.#sequence || databaseSecurityEpoch > this.#securityEpoch) {
      throw new PkiHarnessError(
        'security_fence_inconsistent',
        'Database security state is ahead of the independently durable monotonic fence.',
      );
    }

    if (checkpointSequence === this.#sequence && databaseSecurityEpoch === this.#securityEpoch) {
      return { stale: false, snapshot: this.snapshot };
    }

    this.#securityEpoch = Math.max(this.#securityEpoch, databaseSecurityEpoch) + 1;
    this.#sequence += 1;
    return { stale: true, snapshot: this.snapshot };
  }
}

type InvitationStatus = 'unused' | 'consumed' | 'fenced';
type RecoveryGrantStatus = 'unused' | 'consumed' | 'fenced';
type DeviceStatus = 'active' | 'revoked' | 'quarantined' | 'recovery_required';
type CredentialStatus = 'active' | 'superseded' | 'revoked' | 'quarantined' | 'fenced';
type IssuerState = 'active' | 'overlap' | 'retired';
type ChallengeState = 'pending' | 'used' | 'invalidated';

interface InvitationRecord {
  invitationId: string;
  secretHash: string;
  entropyBits: number;
  scope: PairingScope;
  createdAtMs: number;
  expiresAtMs: number;
  securityEpoch: number;
  status: InvitationStatus;
  consumedAtMs: number | null;
  consumedByDeviceId: string | null;
}

interface RecoveryGrantRecord {
  recoveryGrantId: string;
  secretHash: string;
  entropyBits: number;
  deviceId: string;
  installationId: string;
  preserveDeviceId: boolean;
  ownerPrincipalId: string;
  ownerAuthorizationId: string;
  createdAtMs: number;
  expiresAtMs: number;
  securityEpoch: number;
  status: RecoveryGrantStatus;
  consumedAtMs: number | null;
  consumedBySerial: string | null;
}

interface DeviceRecord {
  deviceId: string;
  installationId: string;
  status: DeviceStatus;
  currentSerial: string;
  credentialSerials: string[];
  generation: number;
}

interface CredentialRecord {
  bundle: IssuedCredentialBundle;
  bundleDigest: string;
  status: CredentialStatus;
}

interface RevocationRecord {
  serial: string;
  deviceId: string;
  reason: string;
  revokedAtMs: number;
  securityEpoch: number;
}

interface IssuerRecord {
  request: IssuerSigningRequest;
  authorization: SignedIssuerAuthorization;
  privateKey: KeyObject;
  state: IssuerState;
  overlapAcceptedUntilMs: number | null;
}

interface AuditEvent {
  eventId: string;
  type: string;
  occurredAtMs: number;
  securityEpoch: number;
  fenceSequence: number;
  details: Record<string, unknown>;
}

interface CoreDatabase {
  securityEpoch: number;
  fenceSequence: number;
  recoveryPending: boolean;
  currentIssuerId: string | null;
  invitations: Map<string, InvitationRecord>;
  recoveryGrants: Map<string, RecoveryGrantRecord>;
  devices: Map<string, DeviceRecord>;
  credentials: Map<string, CredentialRecord>;
  revocations: Map<string, RevocationRecord>;
  issuers: Map<string, IssuerRecord>;
  audit: AuditEvent[];
}

interface PendingIssuer {
  request: IssuerSigningRequest;
  privateKey: KeyObject;
}

interface StoredChallenge<TChallenge> {
  challenge: TChallenge;
  state: ChallengeState;
}

interface SessionRecord {
  sessionId: string;
  connectionId: string;
  observedInstallationInstanceId: string;
  serial: string;
  deviceId: string;
  installationId: string;
  connectedAtMs: number;
}

export interface CoreDatabaseBackup {
  readonly kind: 'canvas-phase0-pki-database-backup';
  readonly createdAtMs: number;
  readonly fenceSequence: number;
  readonly securityEpoch: number;
}

const databaseBackupStates = new WeakMap<object, CoreDatabase>();

function copyDatabase(source: CoreDatabase): CoreDatabase {
  return {
    securityEpoch: source.securityEpoch,
    fenceSequence: source.fenceSequence,
    recoveryPending: source.recoveryPending,
    currentIssuerId: source.currentIssuerId,
    invitations: new Map(
      [...source.invitations].map(([key, value]) => [key, clonePlain(value)]),
    ),
    recoveryGrants: new Map(
      [...source.recoveryGrants].map(([key, value]) => [key, clonePlain(value)]),
    ),
    devices: new Map([...source.devices].map(([key, value]) => [key, clonePlain(value)])),
    credentials: new Map(
      [...source.credentials].map(([key, value]) => [key, clonePlain(value)]),
    ),
    revocations: new Map(
      [...source.revocations].map(([key, value]) => [key, clonePlain(value)]),
    ),
    issuers: new Map(
      [...source.issuers].map(([key, value]) => [
        key,
        {
          request: clonePlain(value.request),
          authorization: clonePlain(value.authorization),
          privateKey: value.privateKey,
          state: value.state,
          overlapAcceptedUntilMs: value.overlapAcceptedUntilMs,
        },
      ]),
    ),
    audit: clonePlain(source.audit),
  };
}

function normalizeScope(scope: PairingScope): PairingScope {
  const siteId = scope.siteId.trim();
  const groupId = scope.groupId?.trim() || null;
  if (!siteId) {
    throw new PkiHarnessError('invalid_pairing_scope', 'Pairing scope requires a site ID.');
  }
  return { siteId, groupId };
}

function scopesEqual(left: PairingScope, right: PairingScope): boolean {
  return left.siteId === right.siteId && left.groupId === right.groupId;
}

function highEntropySecretBytes(secret: string, kind: 'invitation' | 'recovery_grant'): Buffer {
  const errorCode = kind === 'invitation' ? 'invitation_malformed' : 'recovery_grant_malformed';
  const label = kind === 'invitation' ? 'Invitation' : 'Recovery grant';
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new PkiHarnessError(errorCode, `${label} is not canonical base64url.`);
  }
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.toString('base64url') !== secret || decoded.length < MINIMUM_SECRET_BYTES) {
    throw new PkiHarnessError(errorCode, `${label} must contain at least 128 bits.`);
  }
  return decoded;
}

function invitationBytes(secret: string): Buffer {
  return highEntropySecretBytes(secret, 'invitation');
}

function invitationHash(secret: string): string {
  const bytes = invitationBytes(secret);
  return digestObject('canvas-phase0-pairing-invitation-secret-v1', bytes.toString('base64url'));
}

function recoveryGrantHash(secret: string): string {
  const bytes = highEntropySecretBytes(secret, 'recovery_grant');
  return digestObject('canvas-phase0-owner-recovery-grant-secret-v1', bytes.toString('base64url'));
}

function challengeDigest(challenge: SignedCoreChallenge<object>): string {
  return digestObject('canvas-phase0-signed-core-challenge-digest-v1', challenge);
}

function credentialBundleDigest(bundle: IssuedCredentialBundle): string {
  return digestObject('canvas-phase0-device-credential-bundle-digest-v1', bundle);
}

function expectedEnrollmentProof(challenge: EnrollmentChallenge): EnrollmentProofPayload {
  return {
    format: ENROLLMENT_PROOF_FORMAT,
    challengeId: challenge.payload.challengeId,
    challengeDigest: challengeDigest(challenge),
    installationId: challenge.payload.installationId,
    publicKeyFingerprint: challenge.payload.publicKeyFingerprint,
    securityEpoch: challenge.payload.securityEpoch,
  };
}

function expectedConnectionProof(challenge: ConnectionChallenge): ConnectionProofPayload {
  return {
    format: CONNECTION_PROOF_FORMAT,
    challengeId: challenge.payload.challengeId,
    challengeDigest: challengeDigest(challenge),
    serial: challenge.payload.serial,
    connectionId: challenge.payload.connectionId,
    observedInstallationInstanceId: challenge.payload.observedInstallationInstanceId,
    securityEpoch: challenge.payload.securityEpoch,
  };
}

function expectedRotationProof(challenge: KeyRotationChallenge): KeyRotationProofPayload {
  return {
    format: ROTATION_PROOF_FORMAT,
    challengeId: challenge.payload.challengeId,
    challengeDigest: challengeDigest(challenge),
    sessionId: challenge.payload.sessionId,
    currentSerial: challenge.payload.currentSerial,
    newPublicKeyFingerprint: challenge.payload.newPublicKeyFingerprint,
    securityEpoch: challenge.payload.securityEpoch,
  };
}

function expectedRecoveryProof(challenge: CredentialRecoveryChallenge): CredentialRecoveryProofPayload {
  return {
    format: RECOVERY_PROOF_FORMAT,
    challengeId: challenge.payload.challengeId,
    challengeDigest: challengeDigest(challenge),
    recoveryGrantHash: challenge.payload.recoveryGrantHash,
    deviceId: challenge.payload.deviceId,
    installationId: challenge.payload.installationId,
    preserveDeviceId: challenge.payload.preserveDeviceId,
    currentSerial: challenge.payload.currentSerial,
    nextGeneration: challenge.payload.nextGeneration,
    newPublicKeyFingerprint: challenge.payload.newPublicKeyFingerprint,
    securityEpoch: challenge.payload.securityEpoch,
  };
}

function plainEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface Phase0PkiCoreOptions {
  readonly endpointIdentity: CoreEndpointIdentity;
  readonly rootPublicKeySpki: string;
  readonly securityFence: MonotonicSecurityFence;
  readonly now?: () => number;
  readonly entropy?: EntropySource;
  readonly invitationBytes?: number;
  readonly recoveryGrantBytes?: number;
  readonly challengeTtlMs?: number;
  readonly credentialLifetimeMs?: number;
}

export class Phase0PkiCore {
  readonly endpointIdentity: CoreEndpointIdentity;
  readonly rootPublicKeySpki: string;
  readonly securityFence: MonotonicSecurityFence;

  readonly #now: () => number;
  readonly #entropy: EntropySource;
  readonly #invitationBytes: number;
  readonly #recoveryGrantBytes: number;
  readonly #challengeTtlMs: number;
  readonly #credentialLifetimeMs: number;

  #database: CoreDatabase;
  #pendingIssuers = new Map<string, PendingIssuer>();
  #enrollmentChallenges = new Map<string, StoredChallenge<EnrollmentChallenge>>();
  #connectionChallenges = new Map<string, StoredChallenge<ConnectionChallenge>>();
  #rotationChallenges = new Map<string, StoredChallenge<KeyRotationChallenge>>();
  #recoveryChallenges = new Map<string, StoredChallenge<CredentialRecoveryChallenge>>();
  #sessions = new Map<string, SessionRecord>();

  constructor(options: Phase0PkiCoreOptions) {
    this.endpointIdentity = options.endpointIdentity;
    this.rootPublicKeySpki = options.rootPublicKeySpki;
    importEd25519PublicKey(this.rootPublicKeySpki);
    this.securityFence = options.securityFence;
    this.#now = options.now ?? Date.now;
    this.#entropy = options.entropy ?? ((length) => defaultEntropy(length));
    this.#invitationBytes = options.invitationBytes ?? DEFAULT_INVITATION_BYTES;
    this.#recoveryGrantBytes = options.recoveryGrantBytes ?? DEFAULT_RECOVERY_GRANT_BYTES;
    this.#challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.#credentialLifetimeMs = options.credentialLifetimeMs ?? DEFAULT_CREDENTIAL_LIFETIME_MS;

    if (!Number.isSafeInteger(this.#invitationBytes) || this.#invitationBytes < MINIMUM_SECRET_BYTES) {
      throw new PkiHarnessError(
        'invitation_entropy_too_small',
        'Pairing invitations must contain at least 128 bits of entropy.',
      );
    }
    if (
      !Number.isSafeInteger(this.#recoveryGrantBytes) ||
      this.#recoveryGrantBytes < MINIMUM_SECRET_BYTES
    ) {
      throw new PkiHarnessError(
        'recovery_grant_entropy_too_small',
        'Owner recovery grants must contain at least 128 bits of entropy.',
      );
    }
    if (this.#challengeTtlMs <= 0 || this.#credentialLifetimeMs <= 0) {
      throw new PkiHarnessError('invalid_lifetime', 'Challenge and credential lifetimes must be positive.');
    }

    const fence = this.securityFence.snapshot;
    this.#database = {
      securityEpoch: fence.securityEpoch,
      fenceSequence: fence.sequence,
      recoveryPending: false,
      currentIssuerId: null,
      invitations: new Map(),
      recoveryGrants: new Map(),
      devices: new Map(),
      credentials: new Map(),
      revocations: new Map(),
      issuers: new Map(),
      audit: [],
    };
  }

  createIssuerSigningRequest(options: {
    issuerId: string;
    validForMs: number;
  }): IssuerSigningRequest {
    const issuerId = options.issuerId.trim();
    if (!issuerId || options.validForMs <= 0) {
      throw new PkiHarnessError('invalid_issuer_request', 'Issuer ID and positive validity are required.');
    }
    if (this.#database.issuers.has(issuerId) || this.#pendingIssuers.has(issuerId)) {
      throw new PkiHarnessError('issuer_id_conflict', 'Issuer ID is already known.');
    }

    const keyPair = generateEd25519KeyPair();
    const request: IssuerSigningRequest = {
      format: PHASE0_ISSUER_REQUEST_FORMAT,
      issuerId,
      issuerPublicKeySpki: keyPair.publicKeySpki,
      validFromMs: this.#now(),
      validUntilMs: this.#now() + options.validForMs,
    };
    this.#pendingIssuers.set(issuerId, { request, privateKey: keyPair.privateKey });
    return clonePlain(request);
  }

  activateIssuer(
    authorization: SignedIssuerAuthorization,
    options: { overlapMs?: number } = {},
  ): void {
    assertIssuerAuthorization(this.rootPublicKeySpki, authorization);
    const pending = this.#pendingIssuers.get(authorization.payload.issuerId);
    if (!pending) {
      throw new PkiHarnessError(
        'issuer_private_key_unavailable',
        'Core has no protected pending private key for this root authorization.',
      );
    }
    const request = pending.request;
    if (
      authorization.payload.issuerPublicKeySpki !== request.issuerPublicKeySpki ||
      authorization.payload.validFromMs !== request.validFromMs ||
      authorization.payload.validUntilMs !== request.validUntilMs ||
      authorization.payload.requestDigest !==
        digestObject('canvas-phase0-issuer-request-digest-v1', request)
    ) {
      throw new PkiHarnessError('issuer_request_mismatch', 'Root authorization does not match the pending issuer.');
    }
    const now = this.#now();
    if (now < request.validFromMs || now >= request.validUntilMs) {
      throw new PkiHarnessError('issuer_not_valid', 'Issuer authorization is not currently valid.');
    }

    const overlapMs = options.overlapMs ?? 0;
    if (!Number.isSafeInteger(overlapMs) || overlapMs < 0) {
      throw new PkiHarnessError('invalid_issuer_overlap', 'Issuer overlap must be non-negative.');
    }

    const previousIssuerId = this.#database.currentIssuerId;
    this.#securityMutation(
      'issuer_activated',
      {
        issuerId: request.issuerId,
        previousIssuerId,
        overlapMs,
      },
      () => {
        if (previousIssuerId) {
          const previous = this.#database.issuers.get(previousIssuerId);
          if (!previous) {
            throw new PkiHarnessError('issuer_registry_inconsistent', 'Current issuer record is missing.');
          }
          if (overlapMs === 0) {
            previous.state = 'retired';
            previous.overlapAcceptedUntilMs = now;
          } else {
            previous.state = 'overlap';
            previous.overlapAcceptedUntilMs = Math.min(
              now + overlapMs,
              previous.authorization.payload.validUntilMs,
            );
          }
        }

        this.#database.issuers.set(request.issuerId, {
          request: clonePlain(request),
          authorization: clonePlain(authorization),
          privateKey: pending.privateKey,
          state: 'active',
          overlapAcceptedUntilMs: null,
        });
        this.#database.currentIssuerId = request.issuerId;
        this.#database.recoveryPending = false;
      },
    );
    this.#pendingIssuers.delete(request.issuerId);
    this.enforceTimePolicies();
  }

  createPairingInvitation(options: {
    scope: PairingScope;
    ttlMs: number;
  }): PairingBootstrap {
    this.#assertIssuanceAvailable();
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new PkiHarnessError('invalid_invitation_ttl', 'Invitation TTL must be positive.');
    }

    const scope = normalizeScope(options.scope);
    const secretBytes = this.#takeEntropy(this.#invitationBytes, 'pairing-invitation');
    const secret = secretBytes.toString('base64url');
    const secretHash = invitationHash(secret);
    if (this.#database.invitations.has(secretHash)) {
      throw new PkiHarnessError('entropy_collision', 'Invitation entropy collided with an existing record.');
    }

    const now = this.#now();
    const record: InvitationRecord = {
      invitationId: `inv-${secretHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      secretHash,
      entropyBits: secretBytes.length * 8,
      scope,
      createdAtMs: now,
      expiresAtMs: now + options.ttlMs,
      securityEpoch: this.#database.securityEpoch,
      status: 'unused',
      consumedAtMs: null,
      consumedByDeviceId: null,
    };

    this.#securityMutation(
      'pairing_invitation_created',
      {
        invitationId: record.invitationId,
        scope,
        expiresAtMs: record.expiresAtMs,
        entropyBits: record.entropyBits,
      },
      () => {
        this.#database.invitations.set(secretHash, record);
      },
    );

    return {
      format: PHASE0_PAIRING_BOOTSTRAP_FORMAT,
      endpoint: this.endpointIdentity.endpoint,
      coreSpkiPin: this.endpointIdentity.spkiPin,
      invitationSecret: secret,
      invitationEntropyBits: record.entropyBits,
      scope: clonePlain(scope),
      expiresAtMs: record.expiresAtMs,
      securityEpoch: record.securityEpoch,
    };
  }

  createOwnerAuthorizedRecoveryGrant(options: {
    authorization: OwnerRecoveryAuthorization;
    deviceId: string;
    installationId: string;
    preserveDeviceId: boolean;
    ttlMs: number;
  }): OwnerAuthorizedRecoveryGrant {
    this.#assertIssuanceAvailable();
    const authorization = options.authorization as OwnerRecoveryAuthorization & {
      role?: string;
      stepUpVerified?: boolean;
    };
    if (
      authorization.role !== 'owner' ||
      authorization.stepUpVerified !== true ||
      !authorization.principalId?.trim() ||
      !authorization.authorizationId?.trim()
    ) {
      throw new PkiHarnessError(
        'owner_authorization_required',
        'Credential recovery requires an authenticated, step-up-verified owner authorization.',
      );
    }
    if (
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs <= 0 ||
      options.ttlMs > MAX_RECOVERY_GRANT_TTL_MS
    ) {
      throw new PkiHarnessError(
        'invalid_recovery_grant_ttl',
        `Recovery grant TTL must be between 1 and ${MAX_RECOVERY_GRANT_TTL_MS} milliseconds.`,
      );
    }
    if (options.preserveDeviceId !== true) {
      throw new PkiHarnessError(
        'device_id_preservation_not_authorized',
        'Identity-preserving recovery requires explicit preserveDeviceId authorization.',
      );
    }

    const device = this.#database.devices.get(options.deviceId);
    if (!device) {
      throw new PkiHarnessError('device_unknown', 'Recovery target device is not registered.');
    }
    if (device.installationId !== options.installationId) {
      throw new PkiHarnessError(
        'recovery_grant_target_mismatch',
        'Owner recovery grant target does not match the device installation binding.',
      );
    }
    if (device.status === 'revoked' || device.status === 'quarantined') {
      throw new PkiHarnessError(
        'device_not_recoverable',
        `Device in ${device.status} state requires a separate owner release decision.`,
      );
    }

    const secretBytes = this.#takeEntropy(this.#recoveryGrantBytes, 'owner-recovery-grant');
    const recoverySecret = secretBytes.toString('base64url');
    const secretHash = recoveryGrantHash(recoverySecret);
    if (this.#database.recoveryGrants.has(secretHash)) {
      throw new PkiHarnessError('entropy_collision', 'Recovery grant entropy collided with an existing record.');
    }
    const now = this.#now();
    const record: RecoveryGrantRecord = {
      recoveryGrantId: `recovery-${secretHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
      secretHash,
      entropyBits: secretBytes.length * 8,
      deviceId: device.deviceId,
      installationId: device.installationId,
      preserveDeviceId: true,
      ownerPrincipalId: authorization.principalId,
      ownerAuthorizationId: authorization.authorizationId,
      createdAtMs: now,
      expiresAtMs: now + options.ttlMs,
      securityEpoch: this.#database.securityEpoch,
      status: 'unused',
      consumedAtMs: null,
      consumedBySerial: null,
    };

    this.#securityMutation(
      'owner_recovery_grant_created',
      {
        recoveryGrantId: record.recoveryGrantId,
        deviceId: record.deviceId,
        installationId: record.installationId,
        preserveDeviceId: record.preserveDeviceId,
        ownerPrincipalId: record.ownerPrincipalId,
        ownerAuthorizationId: record.ownerAuthorizationId,
        expiresAtMs: record.expiresAtMs,
        entropyBits: record.entropyBits,
      },
      () => {
        this.#database.recoveryGrants.set(secretHash, record);
      },
    );

    return {
      format: PHASE0_RECOVERY_GRANT_FORMAT,
      endpoint: this.endpointIdentity.endpoint,
      coreSpkiPin: this.endpointIdentity.spkiPin,
      recoverySecret,
      recoveryEntropyBits: record.entropyBits,
      deviceId: record.deviceId,
      installationId: record.installationId,
      preserveDeviceId: record.preserveDeviceId,
      expiresAtMs: record.expiresAtMs,
      securityEpoch: record.securityEpoch,
    };
  }

  startEnrollment(request: EnrollmentRequest): EnrollmentChallenge {
    if (request.format !== ENROLLMENT_REQUEST_FORMAT) {
      throw new PkiHarnessError('enrollment_request_invalid', 'Enrollment request format is not supported.');
    }
    if (canonicalEndpoint(request.endpoint) !== this.endpointIdentity.endpoint) {
      throw new PkiHarnessError('core_endpoint_mismatch', 'Enrollment request targets another Core endpoint.');
    }
    if (request.keyAlgorithm !== 'Ed25519') {
      throw new PkiHarnessError('invalid_key_algorithm', 'Enrollment key must be Ed25519.');
    }
    importEd25519PublicKey(request.publicKeySpki);
    if (!request.installationId.trim()) {
      throw new PkiHarnessError('installation_id_invalid', 'Installation ID is required.');
    }

    let secretHash: string;
    try {
      secretHash = invitationHash(request.invitationSecret);
    } catch (error) {
      this.#audit('pairing_invitation_rejected', { reason: 'invitation_malformed' });
      throw error;
    }

    const invitation = this.#database.invitations.get(secretHash);
    if (!invitation) {
      this.#audit('pairing_invitation_rejected', { reason: 'invitation_invalid' });
      throw new PkiHarnessError('invitation_invalid', 'Pairing invitation is not recognized.');
    }
    this.#assertInvitationUsable(invitation, request.scope);

    const publicKeyFingerprintValue = publicKeyFingerprint(request.publicKeySpki);
    const challengeId = this.#randomId('enroll-challenge', 'enrollment-challenge-id');
    const challenge = this.endpointIdentity.signChallenge<EnrollmentChallengePayload>({
      format: PHASE0_CORE_CHALLENGE_FORMAT,
      purpose: 'enrollment',
      challengeId,
      endpoint: this.endpointIdentity.endpoint,
      nonce: this.#takeEntropy(32, 'enrollment-challenge-nonce').toString('base64url'),
      invitationHash: invitation.secretHash,
      installationId: request.installationId,
      publicKeySpki: request.publicKeySpki,
      publicKeyFingerprint: publicKeyFingerprintValue,
      scope: clonePlain(invitation.scope),
      securityEpoch: this.#database.securityEpoch,
      expiresAtMs: Math.min(invitation.expiresAtMs, this.#now() + this.#challengeTtlMs),
    });
    this.#enrollmentChallenges.set(challengeId, { challenge, state: 'pending' });
    return clonePlain(challenge);
  }

  completeEnrollment(proof: EnrollmentProof): IssuedCredentialBundle {
    const challengeId = proof.challenge.payload.challengeId;
    const stored = this.#enrollmentChallenges.get(challengeId);
    if (!stored) {
      throw new PkiHarnessError('challenge_unknown', 'Enrollment challenge is not known.');
    }
    if (stored.state === 'used') {
      throw new PkiHarnessError('challenge_used', 'Enrollment challenge has already been used.');
    }
    if (stored.state === 'invalidated') {
      throw new PkiHarnessError('challenge_invalidated', 'Enrollment challenge was invalidated by another winner.');
    }
    if (!plainEqual(proof.challenge, stored.challenge)) {
      throw new PkiHarnessError('challenge_mismatch', 'Enrollment proof changed the issued challenge.');
    }
    if (!verifyCoreChallenge(this.endpointIdentity.presentedIdentity, proof.challenge)) {
      throw new PkiHarnessError('core_challenge_signature_invalid', 'Core challenge signature is invalid.');
    }
    if (this.#now() >= proof.challenge.payload.expiresAtMs) {
      throw new PkiHarnessError('challenge_expired', 'Enrollment challenge has expired.');
    }
    if (proof.challenge.payload.securityEpoch !== this.#database.securityEpoch) {
      throw new PkiHarnessError('challenge_security_epoch_stale', 'Enrollment challenge is from a stale security epoch.');
    }

    const invitation = this.#database.invitations.get(proof.challenge.payload.invitationHash);
    if (!invitation) {
      throw new PkiHarnessError('invitation_invalid', 'Enrollment invitation record is missing.');
    }
    this.#assertInvitationUsable(invitation, proof.challenge.payload.scope);

    const expectedProof = expectedEnrollmentProof(proof.challenge);
    if (!plainEqual(proof.payload, expectedProof)) {
      throw new PkiHarnessError('proof_context_mismatch', 'Enrollment proof context is not challenge-bound.');
    }
    if (
      !verifyPayload(
        proof.challenge.payload.publicKeySpki,
        'canvas-phase0-enrollment-pop-signature-v1',
        proof.payload,
        proof.edgeSignature,
      )
    ) {
      this.#audit('enrollment_proof_rejected', {
        invitationId: invitation.invitationId,
        reason: 'proof_invalid',
      });
      throw new PkiHarnessError('proof_invalid', 'Enrollment proof is not signed by the requested device key.');
    }

    for (const device of this.#database.devices.values()) {
      if (device.installationId === proof.challenge.payload.installationId) {
        throw new PkiHarnessError(
          'duplicate_installation_requires_admin_repair',
          'Installation is already bound to a device; silent duplicate enrollment is forbidden.',
        );
      }
    }

    const deviceId = `device-${digestObject(
      'canvas-phase0-device-id-assignment-v1',
      {
        invitationHash: invitation.secretHash,
        installationId: proof.challenge.payload.installationId,
      },
    ).slice('sha256:'.length, 'sha256:'.length + 24)}`;
    if (this.#database.devices.has(deviceId)) {
      throw new PkiHarnessError('device_id_conflict', 'Derived immutable device ID already exists.');
    }

    const bundle = this.#issueCredential({
      deviceId,
      installationId: proof.challenge.payload.installationId,
      publicKeySpki: proof.challenge.payload.publicKeySpki,
      generation: 1,
      previousSerial: null,
    });

    this.#securityMutation(
      'enrollment_completed',
      {
        invitationId: invitation.invitationId,
        deviceId,
        serial: bundle.credential.payload.serial,
        installationId: proof.challenge.payload.installationId,
        publicKeyFingerprint: bundle.credential.payload.publicKeyFingerprint,
      },
      () => {
        invitation.status = 'consumed';
        invitation.consumedAtMs = this.#now();
        invitation.consumedByDeviceId = deviceId;
        stored.state = 'used';
        for (const candidate of this.#enrollmentChallenges.values()) {
          if (
            candidate !== stored &&
            candidate.state === 'pending' &&
            candidate.challenge.payload.invitationHash === invitation.secretHash
          ) {
            candidate.state = 'invalidated';
          }
        }

        const serial = bundle.credential.payload.serial;
        this.#database.devices.set(deviceId, {
          deviceId,
          installationId: proof.challenge.payload.installationId,
          status: 'active',
          currentSerial: serial,
          credentialSerials: [serial],
          generation: 1,
        });
        this.#database.credentials.set(serial, {
          bundle: clonePlain(bundle),
          bundleDigest: credentialBundleDigest(bundle),
          status: 'active',
        });
      },
    );

    return clonePlain(bundle);
  }

  startCredentialRecovery(request: CredentialRecoveryRequest): CredentialRecoveryChallenge {
    if (request.format !== RECOVERY_REQUEST_FORMAT || request.newKeyAlgorithm !== 'Ed25519') {
      throw new PkiHarnessError('recovery_request_invalid', 'Credential recovery request format is invalid.');
    }
    if (canonicalEndpoint(request.endpoint) !== this.endpointIdentity.endpoint) {
      throw new PkiHarnessError('core_endpoint_mismatch', 'Recovery request targets another Core endpoint.');
    }
    importEd25519PublicKey(request.newPublicKeySpki);

    let secretHash: string;
    try {
      secretHash = recoveryGrantHash(request.recoverySecret);
    } catch (error) {
      this.#audit('owner_recovery_grant_rejected', { reason: 'recovery_grant_malformed' });
      throw error;
    }
    const grant = this.#database.recoveryGrants.get(secretHash);
    if (!grant) {
      this.#audit('owner_recovery_grant_rejected', { reason: 'recovery_grant_invalid' });
      throw new PkiHarnessError('recovery_grant_invalid', 'Owner recovery grant is not recognized.');
    }
    const device = this.#assertRecoveryGrantUsable(grant, request);
    this.#assertRecoveryKeyIsNew(request.newPublicKeySpki, device);

    const challengeId = this.#randomId('recovery-challenge', 'recovery-challenge-id');
    const challenge = this.endpointIdentity.signChallenge<CredentialRecoveryChallengePayload>({
      format: PHASE0_CORE_CHALLENGE_FORMAT,
      purpose: 'credential_recovery',
      challengeId,
      endpoint: this.endpointIdentity.endpoint,
      nonce: this.#takeEntropy(32, 'recovery-challenge-nonce').toString('base64url'),
      recoveryGrantHash: grant.secretHash,
      deviceId: grant.deviceId,
      installationId: grant.installationId,
      preserveDeviceId: grant.preserveDeviceId,
      currentSerial: device.currentSerial,
      nextGeneration: device.generation + 1,
      newPublicKeySpki: request.newPublicKeySpki,
      newPublicKeyFingerprint: publicKeyFingerprint(request.newPublicKeySpki),
      securityEpoch: this.#database.securityEpoch,
      expiresAtMs: Math.min(grant.expiresAtMs, this.#now() + this.#challengeTtlMs),
    });
    this.#recoveryChallenges.set(challengeId, { challenge, state: 'pending' });
    return clonePlain(challenge);
  }

  completeCredentialRecovery(proof: CredentialRecoveryProof): IssuedCredentialBundle {
    const stored = this.#recoveryChallenges.get(proof.challenge.payload.challengeId);
    if (!stored) {
      throw new PkiHarnessError('challenge_unknown', 'Credential recovery challenge is not known.');
    }
    if (stored.state === 'used') {
      throw new PkiHarnessError('challenge_used', 'Credential recovery challenge has already been used.');
    }
    if (stored.state === 'invalidated') {
      throw new PkiHarnessError(
        'challenge_invalidated',
        'Credential recovery challenge was invalidated by another winner.',
      );
    }
    if (!plainEqual(proof.challenge, stored.challenge)) {
      throw new PkiHarnessError('challenge_mismatch', 'Recovery proof changed the issued challenge.');
    }
    if (!verifyCoreChallenge(this.endpointIdentity.presentedIdentity, proof.challenge)) {
      throw new PkiHarnessError('core_challenge_signature_invalid', 'Core recovery challenge signature is invalid.');
    }
    if (this.#now() >= proof.challenge.payload.expiresAtMs) {
      throw new PkiHarnessError('challenge_expired', 'Credential recovery challenge has expired.');
    }
    if (proof.challenge.payload.securityEpoch !== this.#database.securityEpoch) {
      throw new PkiHarnessError(
        'challenge_security_epoch_stale',
        'Credential recovery challenge is from a stale security epoch.',
      );
    }

    const grant = this.#database.recoveryGrants.get(proof.challenge.payload.recoveryGrantHash);
    if (!grant) {
      throw new PkiHarnessError('recovery_grant_invalid', 'Credential recovery grant record is missing.');
    }
    const device = this.#assertRecoveryGrantUsable(grant, proof.challenge.payload);
    if (grant.preserveDeviceId !== true || proof.challenge.payload.preserveDeviceId !== true) {
      throw new PkiHarnessError(
        'device_id_preservation_not_authorized',
        'Recovery challenge does not explicitly authorize preserving the device ID.',
      );
    }
    if (
      device.currentSerial !== proof.challenge.payload.currentSerial ||
      device.generation + 1 !== proof.challenge.payload.nextGeneration
    ) {
      throw new PkiHarnessError(
        'recovery_target_changed',
        'Device credential state changed after the recovery challenge was issued.',
      );
    }
    this.#assertRecoveryKeyIsNew(proof.challenge.payload.newPublicKeySpki, device);

    const expectedProof = expectedRecoveryProof(proof.challenge);
    if (!plainEqual(proof.payload, expectedProof)) {
      throw new PkiHarnessError('proof_context_mismatch', 'Recovery proof context is not challenge-bound.');
    }
    if (
      !verifyPayload(
        proof.challenge.payload.newPublicKeySpki,
        'canvas-phase0-credential-recovery-new-key-pop-v1',
        proof.payload,
        proof.newKeyProofSignature,
      )
    ) {
      throw new PkiHarnessError(
        'recovery_new_key_proof_invalid',
        'Replacement key proof of possession is invalid.',
      );
    }

    const bundle = this.#issueCredential({
      deviceId: device.deviceId,
      installationId: device.installationId,
      publicKeySpki: proof.challenge.payload.newPublicKeySpki,
      generation: proof.challenge.payload.nextGeneration,
      previousSerial: proof.challenge.payload.currentSerial,
    });

    this.#securityMutation(
      'owner_credential_recovery_completed',
      {
        recoveryGrantId: grant.recoveryGrantId,
        ownerPrincipalId: grant.ownerPrincipalId,
        ownerAuthorizationId: grant.ownerAuthorizationId,
        deviceId: device.deviceId,
        installationId: device.installationId,
        previousSerial: device.currentSerial,
        newSerial: bundle.credential.payload.serial,
        generation: bundle.credential.payload.generation,
      },
      () => {
        grant.status = 'consumed';
        grant.consumedAtMs = this.#now();
        grant.consumedBySerial = bundle.credential.payload.serial;
        stored.state = 'used';
        for (const candidate of this.#recoveryChallenges.values()) {
          if (
            candidate !== stored &&
            candidate.state === 'pending' &&
            candidate.challenge.payload.recoveryGrantHash === grant.secretHash
          ) {
            candidate.state = 'invalidated';
          }
        }

        for (const serial of device.credentialSerials) {
          const credential = this.#database.credentials.get(serial);
          if (credential) {
            credential.status = 'fenced';
          }
          this.#database.revocations.set(serial, {
            serial,
            deviceId: device.deviceId,
            reason: 'owner_credential_recovery',
            revokedAtMs: this.#now(),
            securityEpoch: this.#database.securityEpoch,
          });
        }

        const newSerial = bundle.credential.payload.serial;
        this.#database.credentials.set(newSerial, {
          bundle: clonePlain(bundle),
          bundleDigest: credentialBundleDigest(bundle),
          status: 'active',
        });
        device.currentSerial = newSerial;
        device.credentialSerials.push(newSerial);
        device.generation = bundle.credential.payload.generation;
        device.status = 'active';
        this.#closeSessionsForDevice(device.deviceId, 'owner_credential_recovery');
      },
    );

    return clonePlain(bundle);
  }

  startConnection(
    bundle: IssuedCredentialBundle,
    options: {
      connectionId: string;
      observedInstallationInstanceId: string;
    },
  ): ConnectionChallenge {
    const validated = this.#validateCredential(bundle);
    if (!options.connectionId.trim() || !options.observedInstallationInstanceId.trim()) {
      throw new PkiHarnessError('connection_context_invalid', 'Connection and observed instance IDs are required.');
    }

    const challengeId = this.#randomId('connect-challenge', 'connection-challenge-id');
    const challenge = this.endpointIdentity.signChallenge<ConnectionChallengePayload>({
      format: PHASE0_CORE_CHALLENGE_FORMAT,
      purpose: 'connection',
      challengeId,
      endpoint: this.endpointIdentity.endpoint,
      nonce: this.#takeEntropy(32, 'connection-challenge-nonce').toString('base64url'),
      connectionId: options.connectionId,
      observedInstallationInstanceId: options.observedInstallationInstanceId,
      serial: bundle.credential.payload.serial,
      deviceId: validated.device.deviceId,
      installationId: validated.device.installationId,
      credentialDigest: credentialBundleDigest(bundle),
      securityEpoch: this.#database.securityEpoch,
      expiresAtMs: this.#now() + this.#challengeTtlMs,
    });
    this.#connectionChallenges.set(challengeId, { challenge, state: 'pending' });
    return clonePlain(challenge);
  }

  finishConnection(proof: ConnectionProof): {
    readonly sessionId: string;
    readonly deviceId: string;
    readonly serial: string;
  } {
    const stored = this.#connectionChallenges.get(proof.challenge.payload.challengeId);
    if (!stored || stored.state !== 'pending') {
      throw new PkiHarnessError('challenge_unavailable', 'Connection challenge is unknown or no longer pending.');
    }
    if (!plainEqual(proof.challenge, stored.challenge)) {
      throw new PkiHarnessError('challenge_mismatch', 'Connection proof changed the issued challenge.');
    }
    if (!verifyCoreChallenge(this.endpointIdentity.presentedIdentity, proof.challenge)) {
      throw new PkiHarnessError('core_challenge_signature_invalid', 'Core connection challenge signature is invalid.');
    }
    if (this.#now() >= proof.challenge.payload.expiresAtMs) {
      throw new PkiHarnessError('challenge_expired', 'Connection challenge has expired.');
    }

    const credentialRecord = this.#database.credentials.get(proof.challenge.payload.serial);
    if (!credentialRecord) {
      throw new PkiHarnessError('credential_unknown', 'Credential serial is not in the registry.');
    }
    const validated = this.#validateCredential(credentialRecord.bundle);
    if (proof.challenge.payload.credentialDigest !== credentialRecord.bundleDigest) {
      throw new PkiHarnessError('credential_registry_mismatch', 'Connection challenge credential digest changed.');
    }

    const expectedProof = expectedConnectionProof(proof.challenge);
    if (!plainEqual(proof.payload, expectedProof)) {
      throw new PkiHarnessError('proof_context_mismatch', 'Connection proof context is not challenge-bound.');
    }
    if (
      !verifyPayload(
        credentialRecord.bundle.credential.payload.publicKeySpki,
        'canvas-phase0-connection-pop-signature-v1',
        proof.payload,
        proof.edgeSignature,
      )
    ) {
      throw new PkiHarnessError('proof_invalid', 'Connection proof is not signed by the credential key.');
    }

    stored.state = 'used';
    const concurrent = [...this.#sessions.values()].filter(
      (session) => session.serial === proof.challenge.payload.serial,
    );
    const conflicting = concurrent.find(
      (session) =>
        session.observedInstallationInstanceId !==
        proof.challenge.payload.observedInstallationInstanceId,
    );
    if (conflicting) {
      this.#securityMutation(
        'credential_clone_quarantined',
        {
          deviceId: validated.device.deviceId,
          serial: proof.challenge.payload.serial,
          existingObservedInstanceId: conflicting.observedInstallationInstanceId,
          newObservedInstanceId: proof.challenge.payload.observedInstallationInstanceId,
        },
        () => {
          validated.device.status = 'quarantined';
          credentialRecord.status = 'quarantined';
          this.#closeSessionsForDevice(validated.device.deviceId, 'clone_quarantine');
        },
      );
      throw new PkiHarnessError(
        'clone_detected_quarantined',
        'Concurrent credential use from different observed installations quarantined the device.',
      );
    }

    for (const session of concurrent) {
      this.#sessions.delete(session.sessionId);
      this.#audit('device_session_replaced', {
        deviceId: session.deviceId,
        serial: session.serial,
        sessionId: session.sessionId,
      });
    }

    const sessionId = this.#randomId('session', 'device-session-id');
    this.#sessions.set(sessionId, {
      sessionId,
      connectionId: proof.challenge.payload.connectionId,
      observedInstallationInstanceId: proof.challenge.payload.observedInstallationInstanceId,
      serial: proof.challenge.payload.serial,
      deviceId: validated.device.deviceId,
      installationId: validated.device.installationId,
      connectedAtMs: this.#now(),
    });
    this.#audit('device_session_opened', {
      sessionId,
      deviceId: validated.device.deviceId,
      serial: proof.challenge.payload.serial,
    });

    return {
      sessionId,
      deviceId: validated.device.deviceId,
      serial: proof.challenge.payload.serial,
    };
  }

  startKeyRotation(sessionId: string, request: KeyRotationRequest): KeyRotationChallenge {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new PkiHarnessError('authenticated_session_required', 'Key rotation requires an active session.');
    }
    if (request.format !== ROTATION_REQUEST_FORMAT || request.newKeyAlgorithm !== 'Ed25519') {
      throw new PkiHarnessError('rotation_request_invalid', 'Key rotation request format is invalid.');
    }
    if (
      request.installationId !== session.installationId ||
      request.currentSerial !== session.serial
    ) {
      throw new PkiHarnessError('rotation_session_mismatch', 'Rotation request is not bound to this session.');
    }
    const currentRecord = this.#database.credentials.get(session.serial);
    if (!currentRecord) {
      throw new PkiHarnessError('credential_unknown', 'Current credential record is missing.');
    }
    const validated = this.#validateCredential(currentRecord.bundle);
    if (validated.device.currentSerial !== session.serial) {
      throw new PkiHarnessError('rotation_not_current', 'Only the current device key may authorize rotation.');
    }
    importEd25519PublicKey(request.newPublicKeySpki);
    const newFingerprint = publicKeyFingerprint(request.newPublicKeySpki);
    if (newFingerprint === currentRecord.bundle.credential.payload.publicKeyFingerprint) {
      throw new PkiHarnessError('rotation_key_unchanged', 'Rotation requires a newly generated key.');
    }
    for (const credential of this.#database.credentials.values()) {
      if (credential.bundle.credential.payload.publicKeyFingerprint === newFingerprint) {
        throw new PkiHarnessError('rotation_key_reused', 'New key is already bound to a credential.');
      }
    }

    const challengeId = this.#randomId('rotate-challenge', 'rotation-challenge-id');
    const challenge = this.endpointIdentity.signChallenge<KeyRotationChallengePayload>({
      format: PHASE0_CORE_CHALLENGE_FORMAT,
      purpose: 'key_rotation',
      challengeId,
      endpoint: this.endpointIdentity.endpoint,
      nonce: this.#takeEntropy(32, 'rotation-challenge-nonce').toString('base64url'),
      sessionId,
      deviceId: session.deviceId,
      installationId: session.installationId,
      currentSerial: session.serial,
      currentPublicKeyFingerprint: currentRecord.bundle.credential.payload.publicKeyFingerprint,
      newPublicKeySpki: request.newPublicKeySpki,
      newPublicKeyFingerprint: newFingerprint,
      securityEpoch: this.#database.securityEpoch,
      expiresAtMs: this.#now() + this.#challengeTtlMs,
    });
    this.#rotationChallenges.set(challengeId, { challenge, state: 'pending' });
    return clonePlain(challenge);
  }

  completeKeyRotation(proof: KeyRotationProof): IssuedCredentialBundle {
    const stored = this.#rotationChallenges.get(proof.challenge.payload.challengeId);
    if (!stored || stored.state !== 'pending') {
      throw new PkiHarnessError('challenge_unavailable', 'Key rotation challenge is unavailable.');
    }
    if (!plainEqual(proof.challenge, stored.challenge)) {
      throw new PkiHarnessError('challenge_mismatch', 'Rotation proof changed the issued challenge.');
    }
    if (!verifyCoreChallenge(this.endpointIdentity.presentedIdentity, proof.challenge)) {
      throw new PkiHarnessError('core_challenge_signature_invalid', 'Core rotation challenge signature is invalid.');
    }
    if (this.#now() >= proof.challenge.payload.expiresAtMs) {
      throw new PkiHarnessError('challenge_expired', 'Key rotation challenge has expired.');
    }

    const session = this.#sessions.get(proof.challenge.payload.sessionId);
    if (!session || session.serial !== proof.challenge.payload.currentSerial) {
      throw new PkiHarnessError('authenticated_session_required', 'Rotation session ended or changed.');
    }
    const currentRecord = this.#database.credentials.get(session.serial);
    if (!currentRecord) {
      throw new PkiHarnessError('credential_unknown', 'Current credential record is missing.');
    }
    const validated = this.#validateCredential(currentRecord.bundle);
    const expectedProof = expectedRotationProof(proof.challenge);
    if (!plainEqual(proof.payload, expectedProof)) {
      throw new PkiHarnessError('proof_context_mismatch', 'Rotation proof context is not challenge-bound.');
    }
    if (
      !verifyPayload(
        currentRecord.bundle.credential.payload.publicKeySpki,
        'canvas-phase0-key-rotation-current-authorization-v1',
        proof.payload,
        proof.currentKeyAuthorizationSignature,
      )
    ) {
      throw new PkiHarnessError('rotation_authorization_invalid', 'Current key did not authorize rotation.');
    }
    if (
      !verifyPayload(
        proof.challenge.payload.newPublicKeySpki,
        'canvas-phase0-key-rotation-new-key-pop-v1',
        proof.payload,
        proof.newKeyProofSignature,
      )
    ) {
      throw new PkiHarnessError('rotation_new_key_proof_invalid', 'New key proof of possession is invalid.');
    }

    const bundle = this.#issueCredential({
      deviceId: validated.device.deviceId,
      installationId: validated.device.installationId,
      publicKeySpki: proof.challenge.payload.newPublicKeySpki,
      generation: validated.device.generation + 1,
      previousSerial: session.serial,
    });

    this.#securityMutation(
      'device_key_rotated',
      {
        deviceId: validated.device.deviceId,
        previousSerial: session.serial,
        newSerial: bundle.credential.payload.serial,
        generation: bundle.credential.payload.generation,
      },
      () => {
        stored.state = 'used';
        currentRecord.status = 'superseded';
        this.#database.revocations.set(session.serial, {
          serial: session.serial,
          deviceId: validated.device.deviceId,
          reason: 'key_rotated',
          revokedAtMs: this.#now(),
          securityEpoch: this.#database.securityEpoch,
        });
        const newSerial = bundle.credential.payload.serial;
        this.#database.credentials.set(newSerial, {
          bundle: clonePlain(bundle),
          bundleDigest: credentialBundleDigest(bundle),
          status: 'active',
        });
        validated.device.currentSerial = newSerial;
        validated.device.credentialSerials.push(newSerial);
        validated.device.generation = bundle.credential.payload.generation;
        this.#closeSessionsForDevice(validated.device.deviceId, 'key_rotated');
      },
    );

    return clonePlain(bundle);
  }

  revokeDevice(deviceId: string, reason: string): void {
    const device = this.#database.devices.get(deviceId);
    if (!device) {
      throw new PkiHarnessError('device_unknown', 'Cannot revoke an unknown device.');
    }
    if (device.status === 'revoked') {
      return;
    }
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new PkiHarnessError('revocation_reason_required', 'Revocation requires an operator reason.');
    }

    this.#securityMutation(
      'device_revoked',
      { deviceId, reason: normalizedReason },
      () => {
        device.status = 'revoked';
        for (const serial of device.credentialSerials) {
          const credential = this.#database.credentials.get(serial);
          if (credential) {
            credential.status = 'revoked';
          }
          this.#database.revocations.set(serial, {
            serial,
            deviceId,
            reason: normalizedReason,
            revokedAtMs: this.#now(),
            securityEpoch: this.#database.securityEpoch,
          });
        }
        this.#closeSessionsForDevice(deviceId, 'targeted_revocation');
      },
    );
  }

  disconnectSession(sessionId: string, reason = 'client_disconnect'): void {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.#sessions.delete(sessionId);
    this.#audit('device_session_closed', {
      sessionId,
      deviceId: session.deviceId,
      serial: session.serial,
      reason,
    });
  }

  isSessionActive(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  enforceTimePolicies(): void {
    for (const session of [...this.#sessions.values()]) {
      const credential = this.#database.credentials.get(session.serial);
      if (!credential) {
        this.#sessions.delete(session.sessionId);
        continue;
      }
      try {
        this.#validateCredential(credential.bundle);
      } catch (error) {
        const code = error instanceof PkiHarnessError ? error.code : 'credential_invalid';
        this.#sessions.delete(session.sessionId);
        this.#audit('device_session_closed', {
          sessionId: session.sessionId,
          deviceId: session.deviceId,
          serial: session.serial,
          reason: code,
        });
      }
    }
  }

  createDatabaseBackup(): CoreDatabaseBackup {
    const backup: CoreDatabaseBackup = Object.freeze({
      kind: 'canvas-phase0-pki-database-backup',
      createdAtMs: this.#now(),
      fenceSequence: this.#database.fenceSequence,
      securityEpoch: this.#database.securityEpoch,
    });
    databaseBackupStates.set(backup, copyDatabase(this.#database));
    return backup;
  }

  restoreDatabase(backup: CoreDatabaseBackup): { readonly stale: boolean; readonly securityEpoch: number } {
    const backupState = databaseBackupStates.get(backup);
    if (!backupState || backup.kind !== 'canvas-phase0-pki-database-backup') {
      throw new PkiHarnessError('backup_invalid', 'Backup was not created by this Phase 0 harness.');
    }

    this.#database = copyDatabase(backupState);
    this.#pendingIssuers.clear();
    this.#enrollmentChallenges.clear();
    this.#connectionChallenges.clear();
    this.#rotationChallenges.clear();
    this.#recoveryChallenges.clear();
    this.#sessions.clear();

    const reconciliation = this.securityFence.reconcileDatabase(
      this.#database.fenceSequence,
      this.#database.securityEpoch,
    );
    if (reconciliation.stale) {
      this.#database.securityEpoch = reconciliation.snapshot.securityEpoch;
      this.#database.fenceSequence = reconciliation.snapshot.sequence;
      this.#database.recoveryPending = true;
      this.#database.currentIssuerId = null;

      for (const invitation of this.#database.invitations.values()) {
        invitation.status = 'fenced';
      }
      for (const recoveryGrant of this.#database.recoveryGrants.values()) {
        recoveryGrant.status = 'fenced';
      }
      for (const credential of this.#database.credentials.values()) {
        credential.status = 'fenced';
      }
      for (const device of this.#database.devices.values()) {
        device.status = 'recovery_required';
      }
      for (const issuer of this.#database.issuers.values()) {
        issuer.state = 'retired';
        issuer.overlapAcceptedUntilMs = this.#now();
      }

      this.#audit('stale_database_restore_fenced', {
        backupFenceSequence: backup.fenceSequence,
        backupSecurityEpoch: backup.securityEpoch,
        newSecurityEpoch: reconciliation.snapshot.securityEpoch,
        issuerRotationRequired: true,
      });
    } else {
      this.#audit('database_restore_completed', {
        backupFenceSequence: backup.fenceSequence,
        securityEpoch: backup.securityEpoch,
      });
    }

    return {
      stale: reconciliation.stale,
      securityEpoch: this.#database.securityEpoch,
    };
  }

  inspect(): {
    readonly securityEpoch: number;
    readonly fenceSequence: number;
    readonly recoveryPending: boolean;
    readonly currentIssuerId: string | null;
    readonly invitations: ReadonlyArray<Record<string, unknown>>;
    readonly recoveryGrants: ReadonlyArray<Record<string, unknown>>;
    readonly devices: ReadonlyArray<Record<string, unknown>>;
    readonly credentials: ReadonlyArray<Record<string, unknown>>;
    readonly issuers: ReadonlyArray<Record<string, unknown>>;
    readonly sessions: ReadonlyArray<Record<string, unknown>>;
    readonly audit: ReadonlyArray<AuditEvent>;
  } {
    return {
      securityEpoch: this.#database.securityEpoch,
      fenceSequence: this.#database.fenceSequence,
      recoveryPending: this.#database.recoveryPending,
      currentIssuerId: this.#database.currentIssuerId,
      invitations: [...this.#database.invitations.values()]
        .map((record) => ({
          invitationId: record.invitationId,
          secretHash: record.secretHash,
          entropyBits: record.entropyBits,
          scope: clonePlain(record.scope),
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
          securityEpoch: record.securityEpoch,
          status: record.status,
          consumedAtMs: record.consumedAtMs,
          consumedByDeviceId: record.consumedByDeviceId,
        }))
        .sort((left, right) => String(left.invitationId).localeCompare(String(right.invitationId))),
      recoveryGrants: [...this.#database.recoveryGrants.values()]
        .map((record) => ({
          recoveryGrantId: record.recoveryGrantId,
          secretHash: record.secretHash,
          entropyBits: record.entropyBits,
          deviceId: record.deviceId,
          installationId: record.installationId,
          preserveDeviceId: record.preserveDeviceId,
          ownerPrincipalId: record.ownerPrincipalId,
          ownerAuthorizationId: record.ownerAuthorizationId,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
          securityEpoch: record.securityEpoch,
          status: record.status,
          consumedAtMs: record.consumedAtMs,
          consumedBySerial: record.consumedBySerial,
        }))
        .sort((left, right) =>
          String(left.recoveryGrantId).localeCompare(String(right.recoveryGrantId)),
        ),
      devices: [...this.#database.devices.values()]
        .map((record) => ({
          deviceId: record.deviceId,
          installationId: record.installationId,
          status: record.status,
          currentSerial: record.currentSerial,
          credentialSerials: [...record.credentialSerials],
          generation: record.generation,
        }))
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
      credentials: [...this.#database.credentials.values()]
        .map((record) => ({
          serial: record.bundle.credential.payload.serial,
          deviceId: record.bundle.credential.payload.deviceId,
          installationId: record.bundle.credential.payload.installationId,
          publicKeyFingerprint: record.bundle.credential.payload.publicKeyFingerprint,
          issuerId: record.bundle.credential.payload.issuerId,
          securityEpoch: record.bundle.credential.payload.securityEpoch,
          generation: record.bundle.credential.payload.generation,
          previousSerial: record.bundle.credential.payload.previousSerial,
          status: record.status,
        }))
        .sort((left, right) => left.serial.localeCompare(right.serial)),
      issuers: [...this.#database.issuers.values()]
        .map((record) => ({
          issuerId: record.request.issuerId,
          state: record.state,
          validFromMs: record.request.validFromMs,
          validUntilMs: record.request.validUntilMs,
          overlapAcceptedUntilMs: record.overlapAcceptedUntilMs,
          publicKeyFingerprint: publicKeyFingerprint(record.request.issuerPublicKeySpki),
        }))
        .sort((left, right) => left.issuerId.localeCompare(right.issuerId)),
      sessions: [...this.#sessions.values()]
        .map((record) => ({ ...record }))
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
      audit: clonePlain(this.#database.audit),
    };
  }

  #assertInvitationUsable(invitation: InvitationRecord, requestScope: PairingScope): void {
    if (invitation.status === 'consumed') {
      throw new PkiHarnessError('invitation_consumed', 'Pairing invitation has already been consumed.');
    }
    if (invitation.status === 'fenced') {
      throw new PkiHarnessError('invitation_fenced', 'Pairing invitation was invalidated by restore fencing.');
    }
    if (invitation.securityEpoch !== this.#database.securityEpoch) {
      throw new PkiHarnessError('invitation_security_epoch_stale', 'Pairing invitation is from a stale epoch.');
    }
    if (this.#now() >= invitation.expiresAtMs) {
      throw new PkiHarnessError('invitation_expired', 'Pairing invitation has expired.');
    }
    if (!scopesEqual(invitation.scope, normalizeScope(requestScope))) {
      throw new PkiHarnessError('invitation_scope_mismatch', 'Pairing invitation scope does not match.');
    }
  }

  #assertRecoveryGrantUsable(
    grant: RecoveryGrantRecord,
    target: {
      readonly deviceId: string;
      readonly installationId: string;
      readonly preserveDeviceId: boolean;
    },
  ): DeviceRecord {
    if (grant.status === 'consumed') {
      throw new PkiHarnessError('recovery_grant_consumed', 'Owner recovery grant has already been consumed.');
    }
    if (grant.status === 'fenced') {
      throw new PkiHarnessError('recovery_grant_fenced', 'Owner recovery grant was invalidated by restore fencing.');
    }
    if (grant.securityEpoch !== this.#database.securityEpoch) {
      throw new PkiHarnessError(
        'recovery_grant_security_epoch_stale',
        'Owner recovery grant is from a stale security epoch.',
      );
    }
    if (this.#now() >= grant.expiresAtMs) {
      throw new PkiHarnessError('recovery_grant_expired', 'Owner recovery grant has expired.');
    }
    if (
      target.deviceId !== grant.deviceId ||
      target.installationId !== grant.installationId ||
      target.preserveDeviceId !== grant.preserveDeviceId
    ) {
      throw new PkiHarnessError(
        'recovery_grant_target_mismatch',
        'Owner recovery grant is bound to another device, installation, or preservation decision.',
      );
    }
    if (grant.preserveDeviceId !== true) {
      throw new PkiHarnessError(
        'device_id_preservation_not_authorized',
        'Owner recovery grant does not authorize preserving the device ID.',
      );
    }

    const device = this.#database.devices.get(grant.deviceId);
    if (!device || device.installationId !== grant.installationId) {
      throw new PkiHarnessError(
        'recovery_grant_target_mismatch',
        'Recovery grant no longer matches the registered device installation.',
      );
    }
    if (device.status === 'revoked' || device.status === 'quarantined') {
      throw new PkiHarnessError(
        'device_not_recoverable',
        `Device in ${device.status} state requires a separate owner release decision.`,
      );
    }
    return device;
  }

  #assertRecoveryKeyIsNew(publicKeySpki: string, device: DeviceRecord): void {
    const fingerprint = publicKeyFingerprint(publicKeySpki);
    for (const serial of device.credentialSerials) {
      const prior = this.#database.credentials.get(serial);
      if (prior?.bundle.credential.payload.publicKeyFingerprint === fingerprint) {
        throw new PkiHarnessError(
          'recovery_key_reused',
          'Credential recovery requires a newly generated Ed25519 key.',
        );
      }
    }
  }

  #assertIssuanceAvailable(): IssuerRecord {
    if (this.#database.recoveryPending) {
      throw new PkiHarnessError(
        'issuer_recovery_required',
        'Stale restore requires a new root-authorized issuer before pairing can resume.',
      );
    }
    const issuerId = this.#database.currentIssuerId;
    const issuer = issuerId ? this.#database.issuers.get(issuerId) : undefined;
    if (!issuer || issuer.state !== 'active') {
      throw new PkiHarnessError('issuer_unavailable', 'No active online device issuer is available.');
    }
    const now = this.#now();
    if (now < issuer.authorization.payload.validFromMs || now >= issuer.authorization.payload.validUntilMs) {
      throw new PkiHarnessError('issuer_not_valid', 'Active issuer is outside its validity interval.');
    }
    return issuer;
  }

  #issueCredential(input: {
    deviceId: string;
    installationId: string;
    publicKeySpki: string;
    generation: number;
    previousSerial: string | null;
  }): IssuedCredentialBundle {
    const issuer = this.#assertIssuanceAvailable();
    const now = this.#now();
    const serial = this.#randomId('serial', 'credential-serial');
    if (this.#database.credentials.has(serial)) {
      throw new PkiHarnessError('entropy_collision', 'Credential serial collided with an existing record.');
    }
    const keyFingerprint = publicKeyFingerprint(input.publicKeySpki);
    const expiresAtMs = Math.min(
      now + this.#credentialLifetimeMs,
      issuer.authorization.payload.validUntilMs,
    );
    if (expiresAtMs <= now) {
      throw new PkiHarnessError('issuer_not_valid', 'Issuer cannot mint a credential with positive validity.');
    }

    const payload: Phase0CredentialPayload = {
      format: 'canvas-phase0-signed-device-credential-v1',
      serial,
      deviceId: input.deviceId,
      installationId: input.installationId,
      keyAlgorithm: 'Ed25519',
      publicKeySpki: input.publicKeySpki,
      publicKeyFingerprint: keyFingerprint,
      bindingDigest: credentialBindingDigest({
        deviceId: input.deviceId,
        installationId: input.installationId,
        publicKeyFingerprint: keyFingerprint,
        securityEpoch: this.#database.securityEpoch,
        generation: input.generation,
      }),
      issuerId: issuer.request.issuerId,
      issuerAuthorizationDigest: digestObject(
        'canvas-phase0-issuer-authorization-digest-v1',
        issuer.authorization,
      ),
      securityEpoch: this.#database.securityEpoch,
      generation: input.generation,
      previousSerial: input.previousSerial,
      issuedAtMs: now,
      expiresAtMs,
    };

    return {
      format: PHASE0_CREDENTIAL_BUNDLE_FORMAT,
      rootPublicKeySpki: this.rootPublicKeySpki,
      issuerAuthorization: clonePlain(issuer.authorization),
      credential: {
        payload,
        issuerSignature: signPayload(
          issuer.privateKey,
          'canvas-phase0-device-credential-signature-v1',
          payload,
        ),
      },
    };
  }

  #validateCredential(bundle: IssuedCredentialBundle): {
    credential: CredentialRecord;
    device: DeviceRecord;
    issuer: IssuerRecord;
  } {
    assertCredentialBundleCryptography(bundle, this.rootPublicKeySpki);
    const payload = bundle.credential.payload;
    if (payload.securityEpoch !== this.#database.securityEpoch) {
      throw new PkiHarnessError(
        'credential_security_epoch_fenced',
        'Credential belongs to an older security epoch.',
      );
    }
    const now = this.#now();
    if (now < payload.issuedAtMs || now >= payload.expiresAtMs) {
      throw new PkiHarnessError('credential_expired', 'Credential is outside its validity interval.');
    }

    const issuer = this.#database.issuers.get(payload.issuerId);
    if (!issuer) {
      throw new PkiHarnessError('issuer_not_trusted', 'Credential issuer is not registered.');
    }
    if (!plainEqual(bundle.issuerAuthorization, issuer.authorization)) {
      throw new PkiHarnessError('issuer_chain_invalid', 'Credential carries unexpected issuer authorization.');
    }
    if (
      now < issuer.authorization.payload.validFromMs ||
      now >= issuer.authorization.payload.validUntilMs
    ) {
      throw new PkiHarnessError('issuer_not_trusted', 'Credential issuer authorization has expired.');
    }
    const issuerAccepted =
      issuer.state === 'active' ||
      (issuer.state === 'overlap' &&
        issuer.overlapAcceptedUntilMs !== null &&
        now <= issuer.overlapAcceptedUntilMs);
    if (!issuerAccepted) {
      throw new PkiHarnessError('issuer_not_trusted', 'Credential issuer is outside the configured overlap.');
    }

    const credential = this.#database.credentials.get(payload.serial);
    if (!credential) {
      throw new PkiHarnessError('credential_unknown', 'Credential serial is not in the registry.');
    }
    if (
      credential.bundleDigest !== credentialBundleDigest(bundle) ||
      !plainEqual(credential.bundle, bundle)
    ) {
      throw new PkiHarnessError('credential_registry_mismatch', 'Credential differs from its registry record.');
    }
    const device = this.#database.devices.get(payload.deviceId);
    if (!device) {
      throw new PkiHarnessError('device_unknown', 'Credential device is not in the registry.');
    }
    if (
      device.installationId !== payload.installationId ||
      !device.credentialSerials.includes(payload.serial)
    ) {
      throw new PkiHarnessError('credential_binding_invalid', 'Credential does not match registry binding.');
    }
    if (device.status !== 'active') {
      throw new PkiHarnessError(`device_${device.status}`, `Device is ${device.status}.`);
    }
    if (this.#database.revocations.has(payload.serial) || credential.status !== 'active') {
      throw new PkiHarnessError('credential_revoked', 'Credential is revoked or superseded.');
    }

    return { credential, device, issuer };
  }

  #securityMutation(
    type: string,
    details: Record<string, unknown>,
    mutate: () => void,
  ): void {
    const fence = this.securityFence.recordMutation();
    mutate();
    this.#database.securityEpoch = fence.securityEpoch;
    this.#database.fenceSequence = fence.sequence;
    this.#audit(type, details);
  }

  #audit(type: string, details: Record<string, unknown>): void {
    const eventId = this.#randomId('audit', 'audit-event-id');
    this.#database.audit.push({
      eventId,
      type,
      occurredAtMs: this.#now(),
      securityEpoch: this.#database.securityEpoch,
      fenceSequence: this.#database.fenceSequence,
      details: clonePlain(details),
    });
  }

  #closeSessionsForDevice(deviceId: string, reason: string): void {
    for (const session of [...this.#sessions.values()]) {
      if (session.deviceId === deviceId) {
        this.#sessions.delete(session.sessionId);
        this.#audit('device_session_closed', {
          sessionId: session.sessionId,
          deviceId,
          serial: session.serial,
          reason,
        });
      }
    }
  }

  #takeEntropy(length: number, label: string): Buffer {
    const value = this.#entropy(length, label);
    if (!Buffer.isBuffer(value) || value.length !== length) {
      throw new PkiHarnessError('entropy_source_invalid', 'Entropy source returned the wrong byte length.');
    }
    return Buffer.from(value);
  }

  #randomId(prefix: string, label: string): string {
    return `${prefix}-${this.#takeEntropy(16, label).toString('base64url')}`;
  }
}

export interface EdgeInstallationOptions {
  readonly installationId: string;
  readonly runtimeInstanceId: string;
  readonly now?: () => number;
}

interface PendingEnrollment {
  bootstrap: PairingBootstrap;
  coreIdentity: PresentedCoreIdentity;
  keyPair: KeyPairMaterial;
}

interface PendingRotation {
  request: KeyRotationRequest;
  keyPair: KeyPairMaterial;
}

interface PendingRecovery {
  grant: OwnerAuthorizedRecoveryGrant;
  coreIdentity: PresentedCoreIdentity;
  keyPair: KeyPairMaterial;
  challenge: CredentialRecoveryChallenge | null;
}

export class EdgeInstallation {
  readonly installationId: string;
  readonly runtimeInstanceId: string;
  readonly #now: () => number;

  #pendingEnrollment: PendingEnrollment | null = null;
  #pendingRotation: PendingRotation | null = null;
  #pendingRecovery: PendingRecovery | null = null;
  #currentKeyPair: KeyPairMaterial | null = null;
  #credentialBundle: IssuedCredentialBundle | null = null;
  #trustedCoreIdentity: PresentedCoreIdentity | null = null;
  #trustedRootPublicKeySpki: string | null = null;

  constructor(options: EdgeInstallationOptions) {
    this.installationId = options.installationId.trim();
    this.runtimeInstanceId = options.runtimeInstanceId.trim();
    this.#now = options.now ?? Date.now;
    if (!this.installationId || !this.runtimeInstanceId) {
      throw new PkiHarnessError('installation_id_invalid', 'Installation and runtime instance IDs are required.');
    }
  }

  prepareEnrollment(
    bootstrap: PairingBootstrap,
    presentedCoreIdentity: PresentedCoreIdentity,
  ): EnrollmentRequest {
    if (this.#currentKeyPair || this.#pendingEnrollment || this.#pendingRecovery) {
      throw new PkiHarnessError('edge_already_initialized', 'Edge already has identity material or pending enrollment.');
    }
    if (bootstrap.format !== PHASE0_PAIRING_BOOTSTRAP_FORMAT) {
      throw new PkiHarnessError('bootstrap_format_invalid', 'Pairing bootstrap format is not supported.');
    }

    const bootstrapEndpoint = canonicalEndpoint(bootstrap.endpoint);
    const presentedEndpoint = canonicalEndpoint(presentedCoreIdentity.endpoint);
    if (bootstrapEndpoint !== presentedEndpoint) {
      throw new PkiHarnessError('core_endpoint_mismatch', 'Presented Core endpoint differs from trusted bootstrap.');
    }
    const presentedPin = publicKeyFingerprint(presentedCoreIdentity.publicKeySpki);
    if (!safeStringEqual(bootstrap.coreSpkiPin, presentedPin)) {
      throw new PkiHarnessError('core_trust_pin_mismatch', 'Presented Core SPKI does not match the bootstrap pin.');
    }
    invitationBytes(bootstrap.invitationSecret);
    if (bootstrap.invitationEntropyBits < 128) {
      throw new PkiHarnessError('invitation_entropy_too_small', 'Bootstrap invitation claims less than 128 bits.');
    }
    if (this.#now() >= bootstrap.expiresAtMs) {
      throw new PkiHarnessError('invitation_expired', 'Pairing bootstrap invitation has expired.');
    }
    const scope = normalizeScope(bootstrap.scope);

    // Trust is checked before this local private key is generated or the invitation is returned for transport.
    const keyPair = generateEd25519KeyPair();
    this.#pendingEnrollment = {
      bootstrap: clonePlain({ ...bootstrap, scope }),
      coreIdentity: clonePlain(presentedCoreIdentity),
      keyPair,
    };

    return {
      format: ENROLLMENT_REQUEST_FORMAT,
      endpoint: bootstrapEndpoint,
      invitationSecret: bootstrap.invitationSecret,
      scope,
      installationId: this.installationId,
      keyAlgorithm: 'Ed25519',
      publicKeySpki: keyPair.publicKeySpki,
    };
  }

  answerEnrollmentChallenge(challenge: EnrollmentChallenge): EnrollmentProof {
    const pending = this.#pendingEnrollment;
    if (!pending) {
      throw new PkiHarnessError('enrollment_not_pending', 'Edge has no pending enrollment key.');
    }
    this.#assertTrustedCoreChallenge(challenge, pending.coreIdentity);
    if (
      challenge.payload.purpose !== 'enrollment' ||
      challenge.payload.installationId !== this.installationId ||
      challenge.payload.publicKeySpki !== pending.keyPair.publicKeySpki ||
      challenge.payload.invitationHash !== invitationHash(pending.bootstrap.invitationSecret) ||
      challenge.payload.securityEpoch !== pending.bootstrap.securityEpoch ||
      !scopesEqual(challenge.payload.scope, pending.bootstrap.scope)
    ) {
      throw new PkiHarnessError('challenge_context_mismatch', 'Enrollment challenge does not match local bootstrap state.');
    }

    const payload = expectedEnrollmentProof(challenge);
    return {
      challenge: clonePlain(challenge),
      payload,
      edgeSignature: signPayload(
        pending.keyPair.privateKey,
        'canvas-phase0-enrollment-pop-signature-v1',
        payload,
      ),
    };
  }

  acceptEnrollment(bundle: IssuedCredentialBundle): void {
    const pending = this.#pendingEnrollment;
    if (!pending) {
      throw new PkiHarnessError('enrollment_not_pending', 'Edge has no pending enrollment to complete.');
    }
    assertCredentialBundleCryptography(bundle);
    const payload = bundle.credential.payload;
    if (
      payload.installationId !== this.installationId ||
      payload.publicKeySpki !== pending.keyPair.publicKeySpki ||
      payload.generation !== 1 ||
      payload.previousSerial !== null ||
      payload.securityEpoch !== pending.bootstrap.securityEpoch
    ) {
      throw new PkiHarnessError('credential_binding_invalid', 'Issued credential does not match local enrollment key/context.');
    }

    this.#currentKeyPair = pending.keyPair;
    this.#credentialBundle = clonePlain(bundle);
    this.#trustedCoreIdentity = clonePlain(pending.coreIdentity);
    this.#trustedRootPublicKeySpki = bundle.rootPublicKeySpki;
    this.#pendingEnrollment = null;
  }

  prepareCredentialRecovery(
    grant: OwnerAuthorizedRecoveryGrant,
    presentedCoreIdentity: PresentedCoreIdentity,
  ): CredentialRecoveryRequest {
    if (this.#pendingEnrollment || this.#pendingRotation || this.#pendingRecovery) {
      throw new PkiHarnessError(
        'recovery_already_pending',
        'Edge has another enrollment, rotation, or recovery transition pending.',
      );
    }
    if (grant.format !== PHASE0_RECOVERY_GRANT_FORMAT) {
      throw new PkiHarnessError('recovery_grant_format_invalid', 'Recovery grant format is not supported.');
    }

    const grantEndpoint = canonicalEndpoint(grant.endpoint);
    const presentedEndpoint = canonicalEndpoint(presentedCoreIdentity.endpoint);
    if (grantEndpoint !== presentedEndpoint) {
      throw new PkiHarnessError('core_endpoint_mismatch', 'Presented Core endpoint differs from recovery grant.');
    }
    const presentedPin = publicKeyFingerprint(presentedCoreIdentity.publicKeySpki);
    if (!safeStringEqual(grant.coreSpkiPin, presentedPin)) {
      throw new PkiHarnessError('core_trust_pin_mismatch', 'Presented Core SPKI does not match recovery grant pin.');
    }
    highEntropySecretBytes(grant.recoverySecret, 'recovery_grant');
    if (grant.recoveryEntropyBits < 128) {
      throw new PkiHarnessError(
        'recovery_grant_entropy_too_small',
        'Recovery grant claims less than 128 bits of entropy.',
      );
    }
    if (this.#now() >= grant.expiresAtMs) {
      throw new PkiHarnessError('recovery_grant_expired', 'Owner recovery grant has expired.');
    }
    if (
      !grant.deviceId.trim() ||
      grant.installationId !== this.installationId ||
      grant.preserveDeviceId !== true
    ) {
      throw new PkiHarnessError(
        'recovery_grant_target_mismatch',
        'Recovery grant does not explicitly preserve this device/installation identity.',
      );
    }

    // Core trust and grant bounds are checked before generating the replacement private key.
    const keyPair = generateEd25519KeyPair();
    if (
      this.#currentKeyPair &&
      publicKeyFingerprint(this.#currentKeyPair.publicKeySpki) === publicKeyFingerprint(keyPair.publicKeySpki)
    ) {
      throw new PkiHarnessError('recovery_key_reused', 'Credential recovery generated the current key again.');
    }
    this.#pendingRecovery = {
      grant: clonePlain(grant),
      coreIdentity: clonePlain(presentedCoreIdentity),
      keyPair,
      challenge: null,
    };

    return {
      format: RECOVERY_REQUEST_FORMAT,
      endpoint: grantEndpoint,
      recoverySecret: grant.recoverySecret,
      deviceId: grant.deviceId,
      installationId: this.installationId,
      preserveDeviceId: grant.preserveDeviceId,
      newKeyAlgorithm: 'Ed25519',
      newPublicKeySpki: keyPair.publicKeySpki,
    };
  }

  answerCredentialRecoveryChallenge(
    challenge: CredentialRecoveryChallenge,
  ): CredentialRecoveryProof {
    const pending = this.#pendingRecovery;
    if (!pending) {
      throw new PkiHarnessError('recovery_not_pending', 'Edge has no pending credential recovery key.');
    }
    this.#assertTrustedCoreChallenge(challenge, pending.coreIdentity);
    if (
      challenge.payload.purpose !== 'credential_recovery' ||
      challenge.payload.recoveryGrantHash !== recoveryGrantHash(pending.grant.recoverySecret) ||
      challenge.payload.deviceId !== pending.grant.deviceId ||
      challenge.payload.installationId !== this.installationId ||
      challenge.payload.preserveDeviceId !== true ||
      challenge.payload.newPublicKeySpki !== pending.keyPair.publicKeySpki ||
      challenge.payload.newPublicKeyFingerprint !== publicKeyFingerprint(pending.keyPair.publicKeySpki) ||
      challenge.payload.securityEpoch !== pending.grant.securityEpoch
    ) {
      throw new PkiHarnessError('challenge_context_mismatch', 'Recovery challenge does not match local grant/key state.');
    }

    const payload = expectedRecoveryProof(challenge);
    pending.challenge = clonePlain(challenge);
    return {
      challenge: clonePlain(challenge),
      payload,
      newKeyProofSignature: signPayload(
        pending.keyPair.privateKey,
        'canvas-phase0-credential-recovery-new-key-pop-v1',
        payload,
      ),
    };
  }

  acceptCredentialRecovery(bundle: IssuedCredentialBundle): void {
    const pending = this.#pendingRecovery;
    if (!pending?.challenge) {
      throw new PkiHarnessError('recovery_not_pending', 'Edge has no completed recovery challenge.');
    }
    assertCredentialBundleCryptography(
      bundle,
      this.#trustedRootPublicKeySpki ?? bundle.rootPublicKeySpki,
    );
    const payload = bundle.credential.payload;
    if (
      payload.deviceId !== pending.grant.deviceId ||
      payload.installationId !== this.installationId ||
      payload.publicKeySpki !== pending.keyPair.publicKeySpki ||
      payload.previousSerial !== pending.challenge.payload.currentSerial ||
      payload.generation !== pending.challenge.payload.nextGeneration ||
      payload.securityEpoch !== pending.grant.securityEpoch ||
      pending.grant.preserveDeviceId !== true
    ) {
      throw new PkiHarnessError('credential_binding_invalid', 'Recovered credential does not match the owner grant transition.');
    }

    this.#currentKeyPair = pending.keyPair;
    this.#credentialBundle = clonePlain(bundle);
    this.#trustedCoreIdentity = clonePlain(pending.coreIdentity);
    this.#trustedRootPublicKeySpki = bundle.rootPublicKeySpki;
    this.#pendingRecovery = null;
  }

  answerConnectionChallenge(challenge: ConnectionChallenge): ConnectionProof {
    const keyPair = this.#requireCurrentKey();
    const bundle = this.credentialBundle;
    const coreIdentity = this.#requireTrustedCore();
    this.#assertTrustedCoreChallenge(challenge, coreIdentity);
    if (
      challenge.payload.purpose !== 'connection' ||
      challenge.payload.serial !== bundle.credential.payload.serial ||
      challenge.payload.deviceId !== bundle.credential.payload.deviceId ||
      challenge.payload.installationId !== this.installationId ||
      challenge.payload.observedInstallationInstanceId !== this.runtimeInstanceId ||
      challenge.payload.credentialDigest !== credentialBundleDigest(bundle) ||
      challenge.payload.securityEpoch !== bundle.credential.payload.securityEpoch
    ) {
      throw new PkiHarnessError('challenge_context_mismatch', 'Connection challenge does not match local credential.');
    }

    const payload = expectedConnectionProof(challenge);
    return {
      challenge: clonePlain(challenge),
      payload,
      edgeSignature: signPayload(
        keyPair.privateKey,
        'canvas-phase0-connection-pop-signature-v1',
        payload,
      ),
    };
  }

  prepareKeyRotation(): KeyRotationRequest {
    const bundle = this.credentialBundle;
    if (this.#pendingRotation || this.#pendingRecovery) {
      throw new PkiHarnessError('rotation_already_pending', 'A local key rotation or recovery is already pending.');
    }
    const keyPair = generateEd25519KeyPair();
    const request: KeyRotationRequest = {
      format: ROTATION_REQUEST_FORMAT,
      installationId: this.installationId,
      currentSerial: bundle.credential.payload.serial,
      newKeyAlgorithm: 'Ed25519',
      newPublicKeySpki: keyPair.publicKeySpki,
    };
    this.#pendingRotation = { request, keyPair };
    return clonePlain(request);
  }

  answerKeyRotationChallenge(challenge: KeyRotationChallenge): KeyRotationProof {
    const pending = this.#pendingRotation;
    const currentKey = this.#requireCurrentKey();
    const currentBundle = this.credentialBundle;
    if (!pending) {
      throw new PkiHarnessError('rotation_not_pending', 'Edge has no pending new key.');
    }
    this.#assertTrustedCoreChallenge(challenge, this.#requireTrustedCore());
    if (
      challenge.payload.purpose !== 'key_rotation' ||
      challenge.payload.installationId !== this.installationId ||
      challenge.payload.deviceId !== currentBundle.credential.payload.deviceId ||
      challenge.payload.currentSerial !== currentBundle.credential.payload.serial ||
      challenge.payload.currentPublicKeyFingerprint !==
        currentBundle.credential.payload.publicKeyFingerprint ||
      challenge.payload.newPublicKeySpki !== pending.keyPair.publicKeySpki ||
      challenge.payload.newPublicKeyFingerprint !== publicKeyFingerprint(pending.keyPair.publicKeySpki) ||
      challenge.payload.securityEpoch !== currentBundle.credential.payload.securityEpoch
    ) {
      throw new PkiHarnessError('challenge_context_mismatch', 'Rotation challenge does not match local keys/session.');
    }

    const payload = expectedRotationProof(challenge);
    return {
      challenge: clonePlain(challenge),
      payload,
      currentKeyAuthorizationSignature: signPayload(
        currentKey.privateKey,
        'canvas-phase0-key-rotation-current-authorization-v1',
        payload,
      ),
      newKeyProofSignature: signPayload(
        pending.keyPair.privateKey,
        'canvas-phase0-key-rotation-new-key-pop-v1',
        payload,
      ),
    };
  }

  acceptKeyRotation(bundle: IssuedCredentialBundle): void {
    const pending = this.#pendingRotation;
    const currentBundle = this.credentialBundle;
    if (!pending || !this.#trustedRootPublicKeySpki) {
      throw new PkiHarnessError('rotation_not_pending', 'Edge has no pending key rotation.');
    }
    assertCredentialBundleCryptography(bundle, this.#trustedRootPublicKeySpki);
    const payload = bundle.credential.payload;
    if (
      payload.deviceId !== currentBundle.credential.payload.deviceId ||
      payload.installationId !== this.installationId ||
      payload.publicKeySpki !== pending.keyPair.publicKeySpki ||
      payload.previousSerial !== currentBundle.credential.payload.serial ||
      payload.generation !== currentBundle.credential.payload.generation + 1 ||
      payload.securityEpoch !== currentBundle.credential.payload.securityEpoch
    ) {
      throw new PkiHarnessError('credential_binding_invalid', 'Rotated credential does not match local transition.');
    }

    this.#currentKeyPair = pending.keyPair;
    this.#credentialBundle = clonePlain(bundle);
    this.#pendingRotation = null;
  }

  get credentialBundle(): IssuedCredentialBundle {
    if (!this.#credentialBundle) {
      throw new PkiHarnessError('edge_not_enrolled', 'Edge has no device credential.');
    }
    return clonePlain(this.#credentialBundle);
  }

  /** Explicit adversarial helper: simulates theft of both the software key and its public credential. */
  simulateStolenCredentialCloneForTest(newRuntimeInstanceId: string): EdgeInstallation {
    const currentKey = this.#requireCurrentKey();
    const clone = new EdgeInstallation({
      installationId: this.installationId,
      runtimeInstanceId: newRuntimeInstanceId,
      now: this.#now,
    });
    clone.#currentKeyPair = currentKey;
    clone.#credentialBundle = this.credentialBundle;
    clone.#trustedCoreIdentity = clonePlain(this.#requireTrustedCore());
    clone.#trustedRootPublicKeySpki = this.#trustedRootPublicKeySpki;
    return clone;
  }

  inspect(): {
    readonly installationId: string;
    readonly runtimeInstanceId: string;
    readonly state:
      | 'unpaired'
      | 'enrollment_pending'
      | 'paired'
      | 'rotation_pending'
      | 'recovery_pending';
    readonly hasLocalPrivateKey: boolean;
    readonly publicKeyFingerprint: string | null;
    readonly deviceId: string | null;
    readonly serial: string | null;
    readonly generation: number | null;
  } {
    const keyPair =
      this.#pendingRecovery?.keyPair ??
      this.#pendingRotation?.keyPair ??
      this.#currentKeyPair ??
      this.#pendingEnrollment?.keyPair;
    const state = this.#pendingRecovery
      ? 'recovery_pending'
      : this.#pendingRotation
        ? 'rotation_pending'
        : this.#credentialBundle
          ? 'paired'
          : this.#pendingEnrollment
            ? 'enrollment_pending'
            : 'unpaired';
    return {
      installationId: this.installationId,
      runtimeInstanceId: this.runtimeInstanceId,
      state,
      hasLocalPrivateKey: keyPair !== undefined && keyPair !== null,
      publicKeyFingerprint: keyPair ? publicKeyFingerprint(keyPair.publicKeySpki) : null,
      deviceId: this.#credentialBundle?.credential.payload.deviceId ?? null,
      serial: this.#credentialBundle?.credential.payload.serial ?? null,
      generation: this.#credentialBundle?.credential.payload.generation ?? null,
    };
  }

  #assertTrustedCoreChallenge<TPayload extends { endpoint: string; expiresAtMs: number }>(
    challenge: SignedCoreChallenge<TPayload>,
    identity: PresentedCoreIdentity,
  ): void {
    if (canonicalEndpoint(challenge.payload.endpoint) !== canonicalEndpoint(identity.endpoint)) {
      throw new PkiHarnessError('core_endpoint_mismatch', 'Core challenge endpoint differs from pinned endpoint.');
    }
    if (!verifyCoreChallenge(identity, challenge)) {
      throw new PkiHarnessError('core_challenge_signature_invalid', 'Core challenge signature is invalid.');
    }
    if (this.#now() >= challenge.payload.expiresAtMs) {
      throw new PkiHarnessError('challenge_expired', 'Core challenge has expired.');
    }
  }

  #requireCurrentKey(): KeyPairMaterial {
    if (!this.#currentKeyPair) {
      throw new PkiHarnessError('edge_not_enrolled', 'Edge has no current device key.');
    }
    return this.#currentKeyPair;
  }

  #requireTrustedCore(): PresentedCoreIdentity {
    if (!this.#trustedCoreIdentity) {
      throw new PkiHarnessError('core_not_trusted', 'Edge has no pinned Core identity.');
    }
    return this.#trustedCoreIdentity;
  }
}
