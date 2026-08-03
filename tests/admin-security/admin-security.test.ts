import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdminSecurityError,
  AdminSecurityModel,
  IngressBudget,
  type AdminRequest,
  type ConfirmationAction,
  type SessionCapability,
} from './admin-security-model.js';

const ORIGIN = 'https://admin.canvas.example';
const OWNER_PASSWORD = 'Correct-Horse-Battery-77!';

class Clock {
  value = 1_750_000_000_000;
  readonly now = (): number => this.value;
  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof AdminSecurityError && error.code === code,
    `expected AdminSecurityError(${code})`,
  );
}

function claimLocalOwner(model: AdminSecurityModel): SessionCapability {
  const bootstrap = model.createOwnerBootstrap({ mode: 'local_only', ttlMs: 60_000 });
  return model.claimOwner({
    bootstrapId: bootstrap.bootstrapId,
    source: 'loopback',
    sourceKey: 'local-console',
    username: 'owner',
    password: OWNER_PASSWORD,
  });
}

function mutationRequest(
  session: SessionCapability,
  overrides: Partial<AdminRequest> = {},
): AdminRequest {
  return {
    sessionToken: session.token,
    method: 'POST',
    origin: ORIGIN,
    csrfCookie: session.csrfToken,
    csrfHeader: session.csrfToken,
    operation: 'display.operate',
    targets: { siteIds: ['site-a'], deviceIds: ['device-a'] },
    arguments: {},
    ...overrides,
  };
}

test('local owner bootstrap rejects a remote first visitor and disables itself after one owner', () => {
  const model = new AdminSecurityModel({ adminOrigin: ORIGIN });
  const bootstrap = model.createOwnerBootstrap({ mode: 'local_only', ttlMs: 60_000 });

  expectCode(() => model.claimOwner({
    bootstrapId: bootstrap.bootstrapId,
    source: 'remote',
    sourceKey: 'remote-address',
    username: 'attacker',
    password: 'Attacker-Long-Password-99!',
  }), 'owner_claim_local_only');

  const session = model.claimOwner({
    bootstrapId: bootstrap.bootstrapId,
    source: 'console',
    sourceKey: 'physical-console',
    username: 'owner',
    password: OWNER_PASSWORD,
  });
  assert.notEqual(session.token, session.sessionId);
  expectCode(
    () => model.createOwnerBootstrap({ mode: 'remote_secret', ttlMs: 60_000 }),
    'owner_bootstrap_disabled',
  );

  const persisted = JSON.stringify(model.inspect());
  assert.equal(persisted.includes(OWNER_PASSWORD), false);
  assert.equal(persisted.includes(session.token), false);
  assert.equal(persisted.includes(session.csrfToken), false);
  assert.match(persisted, /sha256:[0-9a-f]{64}/);
});

test('remote owner secret is 256-bit, hash-only, expiring, rate-limited, and has one race winner', async () => {
  const clock = new Clock();
  const model = new AdminSecurityModel({ adminOrigin: ORIGIN, now: clock.now });
  const bootstrap = model.createOwnerBootstrap({ mode: 'remote_secret', ttlMs: 60_000 });
  assert(bootstrap.secret);
  assert.equal(Buffer.from(bootstrap.secret, 'base64url').length, 32);
  assert.equal(bootstrap.entropyBits, 256);
  assert.equal(JSON.stringify(model.inspect()).includes(bootstrap.secret), false);

  const contenders = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
    Promise.resolve().then(() => model.claimOwner({
      bootstrapId: bootstrap.bootstrapId,
      source: 'remote',
      sourceKey: `source-${index}`,
      secret: bootstrap.secret!,
      username: `owner-${index}`,
      password: `Long-Owner-Phrase-${index}-Safe!`,
    })),
  ));
  assert.equal(contenders.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(contenders.filter((result) => result.status === 'rejected').length, 15);

  const expiredModel = new AdminSecurityModel({ adminOrigin: ORIGIN, now: clock.now });
  const expired = expiredModel.createOwnerBootstrap({ mode: 'remote_secret', ttlMs: 1_000 });
  clock.advance(1_000);
  expectCode(() => expiredModel.claimOwner({
    bootstrapId: expired.bootstrapId,
    source: 'remote',
    sourceKey: 'expired-source',
    secret: expired.secret!,
    username: 'owner',
    password: OWNER_PASSWORD,
  }), 'owner_bootstrap_expired');

  const limitedModel = new AdminSecurityModel({ adminOrigin: ORIGIN });
  const limited = limitedModel.createOwnerBootstrap({ mode: 'remote_secret', ttlMs: 60_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expectCode(() => limitedModel.claimOwner({
      bootstrapId: limited.bootstrapId,
      source: 'remote',
      sourceKey: 'one-source',
      secret: 'wrong-secret',
      username: 'owner',
      password: OWNER_PASSWORD,
    }), 'owner_bootstrap_invalid');
  }
  expectCode(() => limitedModel.claimOwner({
    bootstrapId: limited.bootstrapId,
    source: 'remote',
    sourceKey: 'one-source',
    secret: limited.secret!,
    username: 'owner',
    password: OWNER_PASSWORD,
  }), 'owner_claim_rate_limited');
});

test('login rotates away from a presented session id and hash-only sessions revoke on logout', () => {
  const model = new AdminSecurityModel({ adminOrigin: ORIGIN });
  const initial = claimLocalOwner(model);
  const login = model.login('owner', OWNER_PASSWORD, 'attacker-fixed-session');
  assert.notEqual(login.sessionId, 'attacker-fixed-session');
  assert.notEqual(login.sessionId, initial.sessionId);
  assert.notEqual(login.token, initial.token);

  assert.equal(model.authorize({
    sessionToken: login.token,
    method: 'GET',
    operation: 'status.read',
    targets: { siteIds: [], deviceIds: [] },
  }).role, 'owner');
  model.logout(login.token);
  expectCode(() => model.authorize({
    sessionToken: login.token,
    method: 'GET',
    operation: 'status.read',
    targets: { siteIds: [], deviceIds: [] },
  }), 'session_invalid');
});

test('RBAC and expanded target scopes deny viewer mutation and cross-site/device IDOR', () => {
  const model = new AdminSecurityModel({ adminOrigin: ORIGIN });
  const owner = claimLocalOwner(model);
  model.provisionUser(owner.token, {
    username: 'viewer-a',
    password: 'Viewer-Strong-Phrase-88!',
    role: 'viewer',
    scope: { sites: ['site-a'], devices: ['device-a'] },
  });
  model.provisionUser(owner.token, {
    username: 'operator-a',
    password: 'Operator-Strong-Phrase-88!',
    role: 'operator',
    scope: { sites: ['site-a'], devices: ['device-a'] },
  });
  model.provisionUser(owner.token, {
    username: 'admin-a',
    password: 'Administrator-Strong-Phrase-88!',
    role: 'admin',
    scope: { sites: ['site-a'], devices: ['device-a'] },
  });

  const viewer = model.login('viewer-a', 'Viewer-Strong-Phrase-88!');
  assert.equal(model.authorize({
    sessionToken: viewer.token,
    method: 'GET',
    operation: 'scene.read',
    targets: { siteIds: ['site-a'], deviceIds: ['device-a'] },
  }).role, 'viewer');
  expectCode(() => model.authorize(mutationRequest(viewer)), 'forbidden');

  const operator = model.login('operator-a', 'Operator-Strong-Phrase-88!');
  assert.equal(model.authorize(mutationRequest(operator)).role, 'operator');
  expectCode(() => model.authorize(mutationRequest(operator, {
    targets: { siteIds: ['site-a', 'site-b'], deviceIds: ['device-a'] },
  })), 'scope_forbidden');
  expectCode(() => model.authorize(mutationRequest(operator, {
    targets: { siteIds: ['site-a'], deviceIds: ['device-a', 'device-b'] },
  })), 'scope_forbidden');

  const admin = model.login('admin-a', 'Administrator-Strong-Phrase-88!');
  assert.equal(model.authorize(mutationRequest(admin, { operation: 'scene.manage' })).role, 'admin');
  expectCode(() => model.authorize(mutationRequest(admin, { operation: 'pki.manage' })), 'forbidden');
});

test('cookie-authenticated mutations require exact origin and matching stored CSRF proof', () => {
  const model = new AdminSecurityModel({ adminOrigin: ORIGIN });
  const owner = claimLocalOwner(model);

  expectCode(() => model.authorize(mutationRequest(owner, { origin: 'https://evil.example' })), 'origin_rejected');
  expectCode(() => model.authorize(mutationRequest(owner, { csrfHeader: 'forged' })), 'csrf_rejected');
  expectCode(() => model.authorize(mutationRequest(owner, { csrfCookie: undefined })), 'csrf_rejected');
  assert.equal(model.authorize(mutationRequest(owner)).role, 'owner');
});

test('sensitive confirmation is step-up, session, action-digest, expiry, and one-use bound', () => {
  const clock = new Clock();
  const model = new AdminSecurityModel({ adminOrigin: ORIGIN, now: clock.now });
  const owner = claimLocalOwner(model);
  const action: ConfirmationAction = {
    operation: 'pki.manage',
    targets: { siteIds: ['site-a'], deviceIds: ['device-a'] },
    arguments: { operation: 'revoke', reason: 'device reported lost' },
  };

  expectCode(() => model.createConfirmation(owner.token, action), 'step_up_required');
  model.stepUp(owner.token, OWNER_PASSWORD);
  const confirmation = model.createConfirmation(owner.token, action);

  const exact = mutationRequest(owner, {
    operation: action.operation,
    targets: action.targets,
    arguments: action.arguments,
    confirmationToken: confirmation.token,
  });
  expectCode(() => model.authorize({
    ...exact,
    arguments: { operation: 'revoke', reason: 'different target semantics' },
  }), 'confirmation_rejected');
  assert.equal(model.authorize(exact).role, 'owner');
  expectCode(() => model.authorize(exact), 'confirmation_rejected');

  const expiring = model.createConfirmation(owner.token, action);
  clock.advance(2 * 60_000);
  expectCode(() => model.authorize({ ...exact, confirmationToken: expiring.token }), 'confirmation_rejected');
});

test('scoped service identity is operation- and target-bound and cannot receive owner-sensitive scope', () => {
  const model = new AdminSecurityModel({ adminOrigin: ORIGIN });
  const owner = claimLocalOwner(model);
  const token = model.issueServiceIdentity(owner.token, {
    serviceId: 'automation-display-a',
    operations: ['status.read', 'display.operate'],
    scope: { sites: ['site-a'], devices: ['device-a'] },
  });

  assert.deepEqual(model.authorizeService({
    token,
    operation: 'display.operate',
    targets: { siteIds: ['site-a'], deviceIds: ['device-a'] },
  }), { principal: 'automation-display-a', role: 'service' });
  expectCode(() => model.authorizeService({
    token,
    operation: 'scene.manage',
    targets: { siteIds: ['site-a'], deviceIds: ['device-a'] },
  }), 'forbidden');
  expectCode(() => model.authorizeService({
    token,
    operation: 'display.operate',
    targets: { siteIds: ['site-b'], deviceIds: ['device-a'] },
  }), 'scope_forbidden');
  expectCode(() => model.issueServiceIdentity(owner.token, {
    serviceId: 'forbidden-pki-service',
    operations: ['pki.manage'],
    scope: { sites: '*', devices: '*' },
  }), 'service_scope_forbidden');
});

test('idle and absolute session expiry fail closed', () => {
  const idleClock = new Clock();
  const idleModel = new AdminSecurityModel({ adminOrigin: ORIGIN, now: idleClock.now });
  const idle = claimLocalOwner(idleModel);
  idleClock.advance(30 * 60_000);
  expectCode(() => idleModel.authorize({
    sessionToken: idle.token,
    method: 'GET',
    operation: 'status.read',
    targets: { siteIds: [], deviceIds: [] },
  }), 'session_invalid');

  const absoluteClock = new Clock();
  const absoluteModel = new AdminSecurityModel({ adminOrigin: ORIGIN, now: absoluteClock.now });
  const absolute = claimLocalOwner(absoluteModel);
  for (let interval = 1; interval < 24; interval += 1) {
    absoluteClock.advance(20 * 60_000);
    absoluteModel.authorize({
      sessionToken: absolute.token,
      method: 'GET',
      operation: 'status.read',
      targets: { siteIds: [], deviceIds: [] },
    });
  }
  absoluteClock.advance(20 * 60_000);
  expectCode(() => absoluteModel.authorize({
    sessionToken: absolute.token,
    method: 'GET',
    operation: 'status.read',
    targets: { siteIds: [], deviceIds: [] },
  }), 'session_invalid');
});

test('admin request flood cannot consume the reserved device-gateway admission budget', () => {
  const budget = new IngressBudget(10, 5);
  const adminAccepted = Array.from({ length: 100 }, () => budget.accept('admin')).filter(Boolean).length;
  assert.equal(adminAccepted, 10);
  assert.deepEqual(budget.snapshot(), { adminRemaining: 0, deviceRemaining: 5 });

  const deviceAccepted = Array.from({ length: 5 }, () => budget.accept('device')).filter(Boolean).length;
  assert.equal(deviceAccepted, 5);
  assert.equal(budget.accept('device'), false);
});
