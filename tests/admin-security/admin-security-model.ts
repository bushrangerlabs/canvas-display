import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export type Role = 'viewer' | 'operator' | 'admin' | 'owner';
export type ClaimSource = 'loopback' | 'console' | 'remote';
export type AdminOperation =
  | 'status.read'
  | 'scene.read'
  | 'display.operate'
  | 'scene.manage'
  | 'device.manage'
  | 'support.read'
  | 'integration.manage'
  | 'pki.manage'
  | 'security.manage';

export interface ScopeInput {
  sites: '*' | readonly string[];
  devices: '*' | readonly string[];
}

export interface TargetScope {
  siteIds: readonly string[];
  deviceIds: readonly string[];
}

export interface SessionCapability {
  sessionId: string;
  token: string;
  csrfToken: string;
}

export interface OwnerBootstrap {
  bootstrapId: string;
  mode: 'local_only' | 'remote_secret';
  secret: string | null;
  entropyBits: number;
  expiresAtMs: number;
}

export interface ConfirmationAction {
  operation: AdminOperation;
  targets: TargetScope;
  arguments: JsonValue;
}

export interface ConfirmationCapability {
  token: string;
  actionDigest: string;
  expiresAtMs: number;
}

export interface AdminRequest {
  sessionToken: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  origin?: string;
  csrfCookie?: string;
  csrfHeader?: string;
  operation: AdminOperation;
  targets: TargetScope;
  arguments?: JsonValue;
  confirmationToken?: string;
}

export interface ServiceRequest {
  token: string;
  operation: AdminOperation;
  targets: TargetScope;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EntropySource = (length: number, label: string) => Buffer;

export class AdminSecurityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminSecurityError';
  }
}

const MIN_REMOTE_SECRET_BYTES = 32;
const OWNER_CLAIM_MAX_ATTEMPTS = 5;
const OWNER_BOOTSTRAP_MAX_TTL_MS = 15 * 60_000;
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60_000;
const STEP_UP_MS = 5 * 60_000;
const CONFIRMATION_MS = 2 * 60_000;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
const OPERATION_ROLE: Record<AdminOperation, Role> = {
  'status.read': 'viewer',
  'scene.read': 'viewer',
  'display.operate': 'operator',
  'scene.manage': 'admin',
  'device.manage': 'admin',
  'support.read': 'admin',
  'integration.manage': 'owner',
  'pki.manage': 'owner',
  'security.manage': 'owner',
};
const SENSITIVE_OPERATIONS = new Set<AdminOperation>([
  'integration.manage',
  'pki.manage',
  'security.manage',
]);

interface PasswordRecord {
  salt: string;
  verifier: string;
}

interface UserRecord {
  userId: string;
  username: string;
  role: Role;
  scope: NormalizedScope;
  password: PasswordRecord;
  disabled: boolean;
}

interface SessionRecord {
  sessionId: string;
  tokenHash: string;
  csrfHash: string;
  userId: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  absoluteExpiresAtMs: number;
  stepUpUntilMs: number;
  revoked: boolean;
}

interface OwnerBootstrapRecord {
  bootstrapId: string;
  mode: OwnerBootstrap['mode'];
  secretHash: string | null;
  entropyBits: number;
  expiresAtMs: number;
  consumed: boolean;
}

interface ConfirmationRecord {
  tokenHash: string;
  sessionId: string;
  actionDigest: string;
  expiresAtMs: number;
  used: boolean;
}

interface ServiceRecord {
  serviceId: string;
  tokenHash: string;
  operations: Set<AdminOperation>;
  scope: NormalizedScope;
  revoked: boolean;
}

interface NormalizedScope {
  sites: '*' | Set<string>;
  devices: '*' | Set<string>;
}

function defaultEntropy(length: number): Buffer {
  return randomBytes(length);
}

function digest(domain: string, value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(value).digest('hex')}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function normalizeScope(scope: ScopeInput): NormalizedScope {
  const normalize = (value: '*' | readonly string[], label: string): '*' | Set<string> => {
    if (value === '*') return '*';
    const entries = value.map((entry) => entry.trim());
    if (entries.some((entry) => !entry) || new Set(entries).size !== entries.length) {
      throw new AdminSecurityError('invalid_scope', `${label} must contain unique non-empty values.`);
    }
    return new Set(entries);
  };
  return { sites: normalize(scope.sites, 'sites'), devices: normalize(scope.devices, 'devices') };
}

function publicScope(scope: NormalizedScope): ScopeInput {
  return {
    sites: scope.sites === '*' ? '*' : [...scope.sites].sort(),
    devices: scope.devices === '*' ? '*' : [...scope.devices].sort(),
  };
}

function scopeAllows(scope: NormalizedScope, targets: TargetScope): boolean {
  const sites = scope.sites;
  const devices = scope.devices;
  const sitesAllowed = sites === '*' ? true : targets.siteIds.every((id) => sites.has(id));
  const devicesAllowed = devices === '*' ? true : targets.deviceIds.every((id) => devices.has(id));
  return sitesAllowed && devicesAllowed;
}

function normalizeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AdminSecurityError('invalid_action', 'Action values must be finite JSON.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJson(value[key] as JsonValue)]));
}

function actionDigest(action: ConfirmationAction): string {
  const normalized = {
    operation: action.operation,
    targets: {
      siteIds: [...action.targets.siteIds].sort(),
      deviceIds: [...action.targets.deviceIds].sort(),
    },
    arguments: normalizeJson(action.arguments),
  };
  return digest('canvas-admin-confirmation-action-v1', JSON.stringify(normalized));
}

function passwordRecord(password: string, salt: Buffer): PasswordRecord {
  return {
    salt: salt.toString('base64url'),
    verifier: scryptSync(password, salt, 32).toString('base64url'),
  };
}

function passwordMatches(password: string, record: PasswordRecord): boolean {
  const actual = scryptSync(password, Buffer.from(record.salt, 'base64url'), 32).toString('base64url');
  return safeEqual(actual, record.verifier);
}

function assertPassword(username: string, password: string): void {
  const normalized = password.toLowerCase();
  if (
    password.length < 12 ||
    normalized === 'password' ||
    normalized === 'admin' ||
    normalized.includes(username.toLowerCase())
  ) {
    throw new AdminSecurityError('weak_password', 'Owner/user password does not meet the model baseline.');
  }
}

export interface AdminSecurityModelOptions {
  adminOrigin: string;
  now?: () => number;
  entropy?: EntropySource;
}

export class AdminSecurityModel {
  readonly adminOrigin: string;
  readonly #now: () => number;
  readonly #entropy: EntropySource;
  readonly #bootstraps = new Map<string, OwnerBootstrapRecord>();
  readonly #users = new Map<string, UserRecord>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #confirmations = new Map<string, ConfirmationRecord>();
  readonly #services = new Map<string, ServiceRecord>();
  readonly #claimAttempts = new Map<string, number>();
  #ownerClaimed = false;
  #counter = 0;

  constructor(options: AdminSecurityModelOptions) {
    const parsed = new URL(options.adminOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== options.adminOrigin) {
      throw new AdminSecurityError('invalid_admin_origin', 'Admin origin must be an exact HTTPS origin.');
    }
    this.adminOrigin = options.adminOrigin;
    this.#now = options.now ?? Date.now;
    this.#entropy = options.entropy ?? ((length) => defaultEntropy(length));
  }

  createOwnerBootstrap(options: { mode: OwnerBootstrap['mode']; ttlMs: number }): OwnerBootstrap {
    if (this.#ownerClaimed) throw new AdminSecurityError('owner_bootstrap_disabled', 'Initial owner already exists.');
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > OWNER_BOOTSTRAP_MAX_TTL_MS) {
      throw new AdminSecurityError('invalid_bootstrap_ttl', 'Owner bootstrap TTL is outside the allowed range.');
    }

    const bootstrapId = this.#id('owner-bootstrap');
    const secretBytes = options.mode === 'remote_secret'
      ? this.#entropy(MIN_REMOTE_SECRET_BYTES, 'owner-bootstrap-secret')
      : null;
    if (secretBytes !== null && secretBytes.length < MIN_REMOTE_SECRET_BYTES) {
      throw new AdminSecurityError('bootstrap_entropy_too_small', 'Remote owner claim needs at least 256 bits.');
    }
    const secret = secretBytes?.toString('base64url') ?? null;
    const record: OwnerBootstrapRecord = {
      bootstrapId,
      mode: options.mode,
      secretHash: secret === null ? null : digest('canvas-owner-bootstrap-secret-v1', secret),
      entropyBits: secretBytes?.length ? secretBytes.length * 8 : 0,
      expiresAtMs: this.#now() + options.ttlMs,
      consumed: false,
    };
    this.#bootstraps.set(bootstrapId, record);
    return {
      bootstrapId,
      mode: record.mode,
      secret,
      entropyBits: record.entropyBits,
      expiresAtMs: record.expiresAtMs,
    };
  }

  claimOwner(options: {
    bootstrapId: string;
    source: ClaimSource;
    sourceKey: string;
    secret?: string;
    username: string;
    password: string;
  }): SessionCapability {
    if (this.#ownerClaimed) throw new AdminSecurityError('owner_bootstrap_disabled', 'Initial owner already exists.');
    this.#consumeClaimAttempt(options.sourceKey);
    const bootstrap = this.#bootstraps.get(options.bootstrapId);
    if (!bootstrap || bootstrap.consumed) return this.#claimFailure('owner_bootstrap_invalid');
    if (this.#now() >= bootstrap.expiresAtMs) return this.#claimFailure('owner_bootstrap_expired');

    if (bootstrap.mode === 'local_only') {
      if (options.source !== 'loopback' && options.source !== 'console') {
        return this.#claimFailure('owner_claim_local_only');
      }
    } else {
      if (options.source !== 'remote' || !options.secret) return this.#claimFailure('owner_bootstrap_invalid');
      const supplied = digest('canvas-owner-bootstrap-secret-v1', options.secret);
      if (!bootstrap.secretHash || !safeEqual(supplied, bootstrap.secretHash)) {
        return this.#claimFailure('owner_bootstrap_invalid');
      }
    }

    const username = options.username.trim();
    if (!username) throw new AdminSecurityError('invalid_username', 'Username is required.');
    assertPassword(username, options.password);

    const userId = this.#id('user');
    this.#users.set(userId, {
      userId,
      username,
      role: 'owner',
      scope: { sites: '*', devices: '*' },
      password: passwordRecord(options.password, this.#entropy(16, 'password-salt')),
      disabled: false,
    });
    bootstrap.consumed = true;
    this.#ownerClaimed = true;
    for (const candidate of this.#bootstraps.values()) candidate.consumed = true;
    return this.#issueSession(userId);
  }

  login(username: string, password: string, _presentedSessionId?: string): SessionCapability {
    const user = [...this.#users.values()].find((candidate) => candidate.username === username && !candidate.disabled);
    if (!user || !passwordMatches(password, user.password)) {
      throw new AdminSecurityError('authentication_failed', 'Username or password is invalid.');
    }
    return this.#issueSession(user.userId);
  }

  logout(sessionToken: string): void {
    this.#session(sessionToken, false).revoked = true;
  }

  stepUp(sessionToken: string, password: string): number {
    const session = this.#session(sessionToken);
    const user = this.#users.get(session.userId)!;
    if (!passwordMatches(password, user.password)) {
      throw new AdminSecurityError('step_up_failed', 'Step-up credential is invalid.');
    }
    session.stepUpUntilMs = this.#now() + STEP_UP_MS;
    return session.stepUpUntilMs;
  }

  provisionUser(
    ownerSessionToken: string,
    input: { username: string; password: string; role: Exclude<Role, 'owner'>; scope: ScopeInput },
  ): string {
    const owner = this.#userForSession(ownerSessionToken);
    if (owner.role !== 'owner') throw new AdminSecurityError('forbidden', 'Only the owner may provision users in this model.');
    const username = input.username.trim();
    if (!username || [...this.#users.values()].some((candidate) => candidate.username === username)) {
      throw new AdminSecurityError('invalid_username', 'Username is missing or already used.');
    }
    assertPassword(username, input.password);
    const userId = this.#id('user');
    this.#users.set(userId, {
      userId,
      username,
      role: input.role,
      scope: normalizeScope(input.scope),
      password: passwordRecord(input.password, this.#entropy(16, 'password-salt')),
      disabled: false,
    });
    return userId;
  }

  issueServiceIdentity(
    ownerSessionToken: string,
    input: { serviceId: string; operations: readonly AdminOperation[]; scope: ScopeInput },
  ): string {
    const owner = this.#userForSession(ownerSessionToken);
    if (owner.role !== 'owner') throw new AdminSecurityError('forbidden', 'Only the owner may issue service identities.');
    if (input.operations.some((operation) => SENSITIVE_OPERATIONS.has(operation))) {
      throw new AdminSecurityError('service_scope_forbidden', 'Service identities cannot receive owner-sensitive operations.');
    }
    const token = this.#secret(32, 'service-token');
    this.#services.set(input.serviceId, {
      serviceId: input.serviceId,
      tokenHash: digest('canvas-service-token-v1', token),
      operations: new Set(input.operations),
      scope: normalizeScope(input.scope),
      revoked: false,
    });
    return token;
  }

  createConfirmation(sessionToken: string, action: ConfirmationAction): ConfirmationCapability {
    const session = this.#session(sessionToken);
    if (session.stepUpUntilMs <= this.#now()) {
      throw new AdminSecurityError('step_up_required', 'A fresh step-up is required.');
    }
    if (!SENSITIVE_OPERATIONS.has(action.operation)) {
      throw new AdminSecurityError('confirmation_not_required', 'This operation does not use sensitive confirmation.');
    }
    const token = this.#secret(32, 'confirmation-token');
    const digestValue = actionDigest(action);
    const expiresAtMs = this.#now() + CONFIRMATION_MS;
    this.#confirmations.set(digest('canvas-confirmation-token-v1', token), {
      tokenHash: digest('canvas-confirmation-token-v1', token),
      sessionId: session.sessionId,
      actionDigest: digestValue,
      expiresAtMs,
      used: false,
    });
    return { token, actionDigest: digestValue, expiresAtMs };
  }

  authorize(request: AdminRequest): { principal: string; role: Role } {
    const session = this.#session(request.sessionToken, false);
    const user = this.#users.get(session.userId)!;
    if (UNSAFE_METHODS.has(request.method)) {
      if (request.origin !== this.adminOrigin) {
        throw new AdminSecurityError('origin_rejected', 'Mutation origin does not match the configured admin origin.');
      }
      if (
        !request.csrfCookie ||
        !request.csrfHeader ||
        !safeEqual(request.csrfCookie, request.csrfHeader) ||
        !safeEqual(digest('canvas-csrf-token-v1', request.csrfCookie), session.csrfHash)
      ) {
        throw new AdminSecurityError('csrf_rejected', 'Mutation CSRF proof is invalid.');
      }
    }
    if (ROLE_RANK[user.role] < ROLE_RANK[OPERATION_ROLE[request.operation]]) {
      throw new AdminSecurityError('forbidden', 'Role does not permit this operation.');
    }
    if (!scopeAllows(user.scope, request.targets)) {
      throw new AdminSecurityError('scope_forbidden', 'At least one expanded target is outside the principal scope.');
    }

    if (SENSITIVE_OPERATIONS.has(request.operation)) {
      if (session.stepUpUntilMs <= this.#now()) throw new AdminSecurityError('step_up_required', 'Step-up expired.');
      const token = request.confirmationToken;
      if (!token) throw new AdminSecurityError('confirmation_required', 'A bound confirmation is required.');
      const record = this.#confirmations.get(digest('canvas-confirmation-token-v1', token));
      const expectedDigest = actionDigest({
        operation: request.operation,
        targets: request.targets,
        arguments: request.arguments ?? {},
      });
      if (
        !record ||
        record.used ||
        record.sessionId !== session.sessionId ||
        this.#now() >= record.expiresAtMs ||
        !safeEqual(record.actionDigest, expectedDigest)
      ) {
        throw new AdminSecurityError('confirmation_rejected', 'Confirmation is expired, replayed, or bound to another action.');
      }
      record.used = true;
    }

    session.lastSeenAtMs = this.#now();
    return { principal: user.userId, role: user.role };
  }

  authorizeService(request: ServiceRequest): { principal: string; role: 'service' } {
    const tokenHash = digest('canvas-service-token-v1', request.token);
    const service = [...this.#services.values()].find(
      (candidate) => safeEqual(candidate.tokenHash, tokenHash),
    );
    if (!service || service.revoked) throw new AdminSecurityError('authentication_failed', 'Service token is invalid.');
    if (!service.operations.has(request.operation)) throw new AdminSecurityError('forbidden', 'Service operation is not allowed.');
    if (!scopeAllows(service.scope, request.targets)) throw new AdminSecurityError('scope_forbidden', 'Service target is out of scope.');
    return { principal: service.serviceId, role: 'service' };
  }

  inspect(): Record<string, unknown> {
    return {
      ownerClaimed: this.#ownerClaimed,
      bootstraps: [...this.#bootstraps.values()].map((record) => ({ ...record })),
      users: [...this.#users.values()].map((user) => ({
        userId: user.userId,
        username: user.username,
        role: user.role,
        scope: publicScope(user.scope),
        passwordSalt: user.password.salt,
        passwordVerifier: user.password.verifier,
        disabled: user.disabled,
      })),
      sessions: [...this.#sessions.values()].map((session) => ({ ...session })),
      services: [...this.#services.values()].map((service) => ({
        serviceId: service.serviceId,
        tokenHash: service.tokenHash,
        operations: [...service.operations].sort(),
        scope: publicScope(service.scope),
        revoked: service.revoked,
      })),
      confirmations: [...this.#confirmations.values()].map((record) => ({ ...record })),
    };
  }

  #consumeClaimAttempt(sourceKey: string): void {
    const attempts = this.#claimAttempts.get(sourceKey) ?? 0;
    if (attempts >= OWNER_CLAIM_MAX_ATTEMPTS) {
      throw new AdminSecurityError('owner_claim_rate_limited', 'Owner claim attempt budget is exhausted.');
    }
    this.#claimAttempts.set(sourceKey, attempts + 1);
  }

  #claimFailure(code: string): never {
    throw new AdminSecurityError(code, 'Owner claim failed.');
  }

  #issueSession(userId: string): SessionCapability {
    const now = this.#now();
    const sessionId = this.#id('session');
    const token = this.#secret(32, 'session-token');
    const csrfToken = this.#secret(32, 'csrf-token');
    this.#sessions.set(sessionId, {
      sessionId,
      tokenHash: digest('canvas-session-token-v1', token),
      csrfHash: digest('canvas-csrf-token-v1', csrfToken),
      userId,
      createdAtMs: now,
      lastSeenAtMs: now,
      absoluteExpiresAtMs: now + SESSION_ABSOLUTE_MS,
      stepUpUntilMs: 0,
      revoked: false,
    });
    return { sessionId, token, csrfToken };
  }

  #session(token: string, touch = true): SessionRecord {
    const tokenHash = digest('canvas-session-token-v1', token);
    const session = [...this.#sessions.values()].find((candidate) => safeEqual(candidate.tokenHash, tokenHash));
    const now = this.#now();
    if (
      !session ||
      session.revoked ||
      now >= session.absoluteExpiresAtMs ||
      now - session.lastSeenAtMs >= SESSION_IDLE_MS
    ) {
      throw new AdminSecurityError('session_invalid', 'Session is unknown, revoked, idle-expired, or absolute-expired.');
    }
    if (touch) session.lastSeenAtMs = now;
    return session;
  }

  #userForSession(token: string): UserRecord {
    const session = this.#session(token);
    const user = this.#users.get(session.userId);
    if (!user || user.disabled) throw new AdminSecurityError('session_invalid', 'Session user is unavailable.');
    return user;
  }

  #secret(length: number, label: string): string {
    const value = this.#entropy(length, label);
    if (value.length !== length) throw new AdminSecurityError('entropy_failure', 'Entropy source returned the wrong length.');
    return value.toString('base64url');
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}-${String(this.#counter).padStart(6, '0')}`;
  }
}

export class IngressBudget {
  #adminRemaining: number;
  #deviceRemaining: number;

  constructor(adminCapacity: number, deviceReservedCapacity: number) {
    this.#adminRemaining = adminCapacity;
    this.#deviceRemaining = deviceReservedCapacity;
  }

  accept(kind: 'admin' | 'device'): boolean {
    if (kind === 'admin') {
      if (this.#adminRemaining <= 0) return false;
      this.#adminRemaining -= 1;
      return true;
    }
    if (this.#deviceRemaining <= 0) return false;
    this.#deviceRemaining -= 1;
    return true;
  }

  snapshot(): { adminRemaining: number; deviceRemaining: number } {
    return { adminRemaining: this.#adminRemaining, deviceRemaining: this.#deviceRemaining };
  }
}
