import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export const PHASE0_CREDENTIAL_FORMAT = 'canvas-phase0-signed-device-credential-v1' as const;
export const PHASE0_CREDENTIAL_BUNDLE_FORMAT = 'canvas-phase0-signed-device-credential-bundle-v1' as const;
export const PHASE0_ISSUER_REQUEST_FORMAT = 'canvas-phase0-issuer-request-v1' as const;
export const PHASE0_ISSUER_AUTHORIZATION_FORMAT = 'canvas-phase0-root-authorized-issuer-v1' as const;
export const PHASE0_PAIRING_BOOTSTRAP_FORMAT = 'canvas-phase0-pairing-bootstrap-v1' as const;
export const PHASE0_RECOVERY_GRANT_FORMAT = 'canvas-phase0-owner-recovery-grant-v1' as const;
export const PHASE0_CORE_CHALLENGE_FORMAT = 'canvas-phase0-core-challenge-v1' as const;

export type EntropySource = (length: number, label: string) => Buffer;

export interface KeyPairMaterial {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicKeySpki: string;
}

export interface PresentedCoreIdentity {
  readonly endpoint: string;
  readonly publicKeySpki: string;
}

export interface PairingScope {
  readonly siteId: string;
  readonly groupId: string | null;
}

export interface PairingBootstrap {
  readonly format: typeof PHASE0_PAIRING_BOOTSTRAP_FORMAT;
  readonly endpoint: string;
  readonly coreSpkiPin: string;
  readonly invitationSecret: string;
  readonly invitationEntropyBits: number;
  readonly scope: PairingScope;
  readonly expiresAtMs: number;
  readonly securityEpoch: number;
}

export interface OwnerAuthorizedRecoveryGrant {
  readonly format: typeof PHASE0_RECOVERY_GRANT_FORMAT;
  readonly endpoint: string;
  readonly coreSpkiPin: string;
  readonly recoverySecret: string;
  readonly recoveryEntropyBits: number;
  readonly deviceId: string;
  readonly installationId: string;
  readonly preserveDeviceId: boolean;
  readonly expiresAtMs: number;
  readonly securityEpoch: number;
}

export interface IssuerSigningRequest {
  readonly format: typeof PHASE0_ISSUER_REQUEST_FORMAT;
  readonly issuerId: string;
  readonly issuerPublicKeySpki: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
}

export interface IssuerAuthorizationPayload {
  readonly format: typeof PHASE0_ISSUER_AUTHORIZATION_FORMAT;
  readonly rootKeyId: string;
  readonly issuerId: string;
  readonly issuerPublicKeySpki: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly requestDigest: string;
}

export interface SignedIssuerAuthorization {
  readonly payload: IssuerAuthorizationPayload;
  readonly rootSignature: string;
}

export interface Phase0CredentialPayload {
  readonly format: typeof PHASE0_CREDENTIAL_FORMAT;
  readonly serial: string;
  readonly deviceId: string;
  readonly installationId: string;
  readonly keyAlgorithm: 'Ed25519';
  readonly publicKeySpki: string;
  readonly publicKeyFingerprint: string;
  readonly bindingDigest: string;
  readonly issuerId: string;
  readonly issuerAuthorizationDigest: string;
  readonly securityEpoch: number;
  readonly generation: number;
  readonly previousSerial: string | null;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface Phase0SignedCredential {
  readonly payload: Phase0CredentialPayload;
  readonly issuerSignature: string;
}

export interface IssuedCredentialBundle {
  readonly format: typeof PHASE0_CREDENTIAL_BUNDLE_FORMAT;
  readonly rootPublicKeySpki: string;
  readonly issuerAuthorization: SignedIssuerAuthorization;
  readonly credential: Phase0SignedCredential;
}

export interface SignedCoreChallenge<TPayload extends object> {
  readonly payload: TPayload;
  readonly coreSignature: string;
}

export class PkiHarnessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PkiHarnessError';
  }
}

export function defaultEntropy(length: number): Buffer {
  return randomBytes(length);
}

/** Test-only deterministic entropy. Never use this source for production secrets or keys. */
export function createDeterministicTestEntropy(seed: string): EntropySource {
  let counter = 0;

  return (length: number, label: string): Buffer => {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new PkiHarnessError('invalid_entropy_length', 'Entropy length must be a positive safe integer.');
    }

    const chunks: Buffer[] = [];
    let collected = 0;
    while (collected < length) {
      const chunk = createHash('sha256')
        .update('canvas-phase0-deterministic-test-entropy\0')
        .update(seed)
        .update('\0')
        .update(label)
        .update('\0')
        .update(String(counter))
        .digest();
      counter += 1;
      chunks.push(chunk);
      collected += chunk.length;
    }

    return Buffer.concat(chunks).subarray(0, length);
  };
}

export function generateEd25519KeyPair(): KeyPairMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    publicKeySpki: exportPublicKeySpki(publicKey),
  };
}

export function exportPublicKeySpki(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(der).toString('base64url');
}

export function importEd25519PublicKey(publicKeySpki: string): KeyObject {
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new PkiHarnessError('invalid_public_key', 'The supplied public key is not valid SPKI DER.');
  }

  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new PkiHarnessError('invalid_key_algorithm', 'Phase 0 device and issuer keys must be Ed25519.');
  }

  return publicKey;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PkiHarnessError('non_canonical_value', 'Canonical values cannot contain non-finite numbers.');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const item = record[key];
        if (item === undefined) {
          throw new PkiHarnessError('non_canonical_value', 'Canonical values cannot contain undefined.');
        }
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      });
    return `{${entries.join(',')}}`;
  }

  throw new PkiHarnessError('non_canonical_value', `Unsupported canonical value type: ${typeof value}.`);
}

export function domainBytes(domain: string, payload: unknown): Buffer {
  return Buffer.from(`${domain}\0${canonicalJson(payload)}`, 'utf8');
}

export function digestObject(domain: string, payload: unknown): string {
  return `sha256:${createHash('sha256').update(domainBytes(domain, payload)).digest('hex')}`;
}

export function publicKeyFingerprint(publicKeySpki: string): string {
  const publicKey = importEd25519PublicKey(publicKeySpki);
  return `sha256:${createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex')}`;
}

export function signPayload(privateKey: KeyObject, domain: string, payload: unknown): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new PkiHarnessError('invalid_key_algorithm', 'Signing key must be Ed25519.');
  }
  return cryptoSign(null, domainBytes(domain, payload), privateKey).toString('base64url');
}

export function verifyPayload(
  publicKeySpki: string,
  domain: string,
  payload: unknown,
  signature: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      domainBytes(domain, payload),
      importEd25519PublicKey(publicKeySpki),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function canonicalEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new PkiHarnessError('invalid_core_endpoint', 'Core pairing endpoint must be an absolute URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new PkiHarnessError('invalid_core_endpoint', 'Core pairing endpoint must use HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PkiHarnessError(
      'invalid_core_endpoint',
      'Core pairing endpoint cannot contain user information, a query string, or a fragment.',
    );
  }

  return parsed.href;
}

export class CoreEndpointIdentity {
  readonly endpoint: string;
  readonly publicKeySpki: string;
  readonly spkiPin: string;
  readonly #privateKey: KeyObject;

  constructor(endpoint: string) {
    this.endpoint = canonicalEndpoint(endpoint);
    const keyPair = generateEd25519KeyPair();
    this.#privateKey = keyPair.privateKey;
    this.publicKeySpki = keyPair.publicKeySpki;
    this.spkiPin = publicKeyFingerprint(this.publicKeySpki);
  }

  get presentedIdentity(): PresentedCoreIdentity {
    return {
      endpoint: this.endpoint,
      publicKeySpki: this.publicKeySpki,
    };
  }

  signChallenge<TPayload extends object>(payload: TPayload): SignedCoreChallenge<TPayload> {
    return {
      payload: structuredClone(payload),
      coreSignature: signPayload(this.#privateKey, 'canvas-phase0-core-challenge-signature-v1', payload),
    };
  }
}

export function verifyCoreChallenge<TPayload extends object>(
  identity: PresentedCoreIdentity,
  challenge: SignedCoreChallenge<TPayload>,
): boolean {
  return (
    challenge.payload !== null &&
    verifyPayload(
      identity.publicKeySpki,
      'canvas-phase0-core-challenge-signature-v1',
      challenge.payload,
      challenge.coreSignature,
    )
  );
}

export class OfflineRootAuthority {
  readonly publicKeySpki: string;
  readonly keyId: string;
  readonly #privateKey: KeyObject;

  constructor() {
    const keyPair = generateEd25519KeyPair();
    this.#privateKey = keyPair.privateKey;
    this.publicKeySpki = keyPair.publicKeySpki;
    this.keyId = publicKeyFingerprint(this.publicKeySpki);
  }

  authorizeIssuer(request: IssuerSigningRequest): SignedIssuerAuthorization {
    if (request.format !== PHASE0_ISSUER_REQUEST_FORMAT) {
      throw new PkiHarnessError('invalid_issuer_request', 'Issuer request format is not supported.');
    }
    if (!request.issuerId) {
      throw new PkiHarnessError('invalid_issuer_request', 'Issuer ID is required.');
    }
    importEd25519PublicKey(request.issuerPublicKeySpki);
    if (request.validUntilMs <= request.validFromMs) {
      throw new PkiHarnessError('invalid_issuer_request', 'Issuer validity interval is empty.');
    }

    const payload: IssuerAuthorizationPayload = {
      format: PHASE0_ISSUER_AUTHORIZATION_FORMAT,
      rootKeyId: this.keyId,
      issuerId: request.issuerId,
      issuerPublicKeySpki: request.issuerPublicKeySpki,
      validFromMs: request.validFromMs,
      validUntilMs: request.validUntilMs,
      requestDigest: digestObject('canvas-phase0-issuer-request-digest-v1', request),
    };

    return {
      payload,
      rootSignature: signPayload(
        this.#privateKey,
        'canvas-phase0-root-issuer-authorization-signature-v1',
        payload,
      ),
    };
  }
}

export function assertIssuerAuthorization(
  rootPublicKeySpki: string,
  authorization: SignedIssuerAuthorization,
): void {
  const rootKeyId = publicKeyFingerprint(rootPublicKeySpki);
  if (authorization.payload.format !== PHASE0_ISSUER_AUTHORIZATION_FORMAT) {
    throw new PkiHarnessError('issuer_chain_invalid', 'Issuer authorization format is not supported.');
  }
  if (!safeStringEqual(authorization.payload.rootKeyId, rootKeyId)) {
    throw new PkiHarnessError('issuer_chain_invalid', 'Issuer authorization is bound to another root.');
  }
  importEd25519PublicKey(authorization.payload.issuerPublicKeySpki);
  if (
    !verifyPayload(
      rootPublicKeySpki,
      'canvas-phase0-root-issuer-authorization-signature-v1',
      authorization.payload,
      authorization.rootSignature,
    )
  ) {
    throw new PkiHarnessError('issuer_chain_invalid', 'Offline-root issuer authorization signature is invalid.');
  }
}

export function credentialBindingDigest(input: {
  deviceId: string;
  installationId: string;
  publicKeyFingerprint: string;
  securityEpoch: number;
  generation: number;
}): string {
  return digestObject('canvas-phase0-device-credential-binding-v1', input);
}

export function assertCredentialBundleCryptography(
  bundle: IssuedCredentialBundle,
  expectedRootPublicKeySpki?: string,
): void {
  if (bundle.format !== PHASE0_CREDENTIAL_BUNDLE_FORMAT) {
    throw new PkiHarnessError('credential_format_invalid', 'Credential bundle format is not supported.');
  }
  if (
    expectedRootPublicKeySpki !== undefined &&
    !safeStringEqual(bundle.rootPublicKeySpki, expectedRootPublicKeySpki)
  ) {
    throw new PkiHarnessError('issuer_chain_invalid', 'Credential bundle uses an unexpected device-PKI root.');
  }

  assertIssuerAuthorization(bundle.rootPublicKeySpki, bundle.issuerAuthorization);

  const { payload } = bundle.credential;
  if (payload.format !== PHASE0_CREDENTIAL_FORMAT || payload.keyAlgorithm !== 'Ed25519') {
    throw new PkiHarnessError('credential_format_invalid', 'Credential payload format or key algorithm is invalid.');
  }
  if (payload.issuerId !== bundle.issuerAuthorization.payload.issuerId) {
    throw new PkiHarnessError('issuer_chain_invalid', 'Credential issuer does not match the authorized issuer.');
  }
  if (
    payload.issuerAuthorizationDigest !==
    digestObject('canvas-phase0-issuer-authorization-digest-v1', bundle.issuerAuthorization)
  ) {
    throw new PkiHarnessError('issuer_chain_invalid', 'Credential issuer authorization digest does not match.');
  }
  if (payload.publicKeyFingerprint !== publicKeyFingerprint(payload.publicKeySpki)) {
    throw new PkiHarnessError('credential_binding_invalid', 'Credential public-key fingerprint does not match.');
  }
  if (
    payload.bindingDigest !==
    credentialBindingDigest({
      deviceId: payload.deviceId,
      installationId: payload.installationId,
      publicKeyFingerprint: payload.publicKeyFingerprint,
      securityEpoch: payload.securityEpoch,
      generation: payload.generation,
    })
  ) {
    throw new PkiHarnessError('credential_binding_invalid', 'Credential installation/key binding is invalid.');
  }
  if (
    !verifyPayload(
      bundle.issuerAuthorization.payload.issuerPublicKeySpki,
      'canvas-phase0-device-credential-signature-v1',
      payload,
      bundle.credential.issuerSignature,
    )
  ) {
    throw new PkiHarnessError('credential_signature_invalid', 'Device credential issuer signature is invalid.');
  }
}

export function clonePlain<T>(value: T): T {
  return structuredClone(value);
}
