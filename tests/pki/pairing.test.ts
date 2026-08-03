import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHASE0_CREDENTIAL_FORMAT,
  CoreEndpointIdentity,
  PkiHarnessError,
  credentialBindingDigest,
  importEd25519PublicKey,
} from './crypto-model.js';
import { EdgeInstallation } from './pki-state-machine.js';
import { MINUTE_MS, createPkiFixture } from './test-fixture.js';

function assertPkiError(action: () => unknown, expectedCode: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof PkiHarnessError && error.code === expectedCode,
    `expected PkiHarnessError(${expectedCode})`,
  );
}

function corruptSignature(signature: string): string {
  return `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
}

test('Edge authenticates the pinned Core before generating a key or releasing enrollment data', () => {
  const fixture = createPkiFixture('pinned-core');
  const bootstrap = fixture.core.createPairingInvitation({
    scope: { siteId: 'site-main', groupId: 'lobby' },
    ttlMs: 5 * MINUTE_MS,
  });
  const edge = new EdgeInstallation({
    installationId: 'installation-pinned',
    runtimeInstanceId: 'runtime-pinned',
    now: fixture.clock.now,
  });
  const rogueEndpoint = new CoreEndpointIdentity(fixture.endpoint.endpoint);

  assertPkiError(
    () => edge.prepareEnrollment(bootstrap, rogueEndpoint.presentedIdentity),
    'core_trust_pin_mismatch',
  );
  assert.deepEqual(edge.inspect(), {
    installationId: 'installation-pinned',
    runtimeInstanceId: 'runtime-pinned',
    state: 'unpaired',
    hasLocalPrivateKey: false,
    publicKeyFingerprint: null,
    deviceId: null,
    serial: null,
    generation: null,
  });

  const request = edge.prepareEnrollment(bootstrap, fixture.endpoint.presentedIdentity);
  assert.equal(edge.inspect().state, 'enrollment_pending');
  assert.equal(edge.inspect().hasLocalPrivateKey, true);
  assert.equal(request.keyAlgorithm, 'Ed25519');
  assert.equal(importEd25519PublicKey(request.publicKeySpki).asymmetricKeyType, 'ed25519');
  assert.equal('privateKey' in request, false);
  assert.equal(Buffer.from(bootstrap.invitationSecret, 'base64url').length >= 16, true);
  assert.equal(bootstrap.invitationEntropyBits >= 128, true);

  const persistedState = JSON.stringify(fixture.core.inspect());
  assert.equal(persistedState.includes(bootstrap.invitationSecret), false);
  assert.match(String(fixture.core.inspect().invitations[0]?.secretHash), /^sha256:[0-9a-f]{64}$/);
});

test('signed challenge and Ed25519 proof bind issuance to installation, key, and one invitation', () => {
  const fixture = createPkiFixture('proof-binding');
  const bootstrap = fixture.core.createPairingInvitation({
    scope: { siteId: 'site-main', groupId: 'gallery' },
    ttlMs: 5 * MINUTE_MS,
  });
  const edge = new EdgeInstallation({
    installationId: 'installation-proof',
    runtimeInstanceId: 'runtime-proof',
    now: fixture.clock.now,
  });
  const request = edge.prepareEnrollment(bootstrap, fixture.endpoint.presentedIdentity);
  const challenge = fixture.core.startEnrollment(request);

  const alteredChallenge = {
    ...challenge,
    payload: {
      ...challenge.payload,
      nonce: `${challenge.payload.nonce}-altered`,
    },
  };
  assertPkiError(
    () => edge.answerEnrollmentChallenge(alteredChallenge),
    'core_challenge_signature_invalid',
  );

  const proof = edge.answerEnrollmentChallenge(challenge);
  const invalidProof = {
    ...proof,
    edgeSignature: corruptSignature(proof.edgeSignature),
  };
  assertPkiError(() => fixture.core.completeEnrollment(invalidProof), 'proof_invalid');

  const bundle = fixture.core.completeEnrollment(proof);
  edge.acceptEnrollment(bundle);
  const payload = bundle.credential.payload;

  assert.equal(payload.format, PHASE0_CREDENTIAL_FORMAT);
  assert.equal(payload.installationId, edge.installationId);
  assert.equal(payload.publicKeySpki, request.publicKeySpki);
  assert.equal(payload.generation, 1);
  assert.equal(payload.previousSerial, null);
  assert.equal(
    payload.bindingDigest,
    credentialBindingDigest({
      deviceId: payload.deviceId,
      installationId: payload.installationId,
      publicKeyFingerprint: payload.publicKeyFingerprint,
      securityEpoch: payload.securityEpoch,
      generation: payload.generation,
    }),
  );
  assert.equal(JSON.stringify(bundle).includes('BEGIN CERTIFICATE'), false);
  assert.equal(JSON.stringify(bundle).includes('PRIVATE KEY'), false);

  assertPkiError(() => fixture.core.completeEnrollment(proof), 'challenge_used');

  const replayingEdge = new EdgeInstallation({
    installationId: 'installation-replay',
    runtimeInstanceId: 'runtime-replay',
    now: fixture.clock.now,
  });
  const replayRequest = replayingEdge.prepareEnrollment(
    bootstrap,
    fixture.endpoint.presentedIdentity,
  );
  assertPkiError(() => fixture.core.startEnrollment(replayRequest), 'invitation_consumed');

  const tamperedBundle = {
    ...bundle,
    credential: {
      ...bundle.credential,
      payload: {
        ...bundle.credential.payload,
        installationId: 'attacker-installation',
      },
    },
  };
  assertPkiError(
    () =>
      fixture.core.startConnection(tamperedBundle, {
        connectionId: 'tampered-credential',
        observedInstallationInstanceId: 'attacker-runtime',
      }),
    'credential_binding_invalid',
  );
});

test('concurrent invitation consumption has exactly one transactional winner', async () => {
  const fixture = createPkiFixture('invitation-race');
  const bootstrap = fixture.core.createPairingInvitation({
    scope: { siteId: 'site-race', groupId: 'race-group' },
    ttlMs: 5 * MINUTE_MS,
  });

  const contenders = Array.from({ length: 32 }, (_, index) => {
    const edge = new EdgeInstallation({
      installationId: `race-installation-${String(index).padStart(2, '0')}`,
      runtimeInstanceId: `race-runtime-${String(index).padStart(2, '0')}`,
      now: fixture.clock.now,
    });
    const request = edge.prepareEnrollment(bootstrap, fixture.endpoint.presentedIdentity);
    const challenge = fixture.core.startEnrollment(request);
    return { edge, proof: edge.answerEnrollmentChallenge(challenge) };
  });

  const results = await Promise.allSettled(
    contenders.map(({ edge, proof }) =>
      Promise.resolve().then(() => {
        const bundle = fixture.core.completeEnrollment(proof);
        edge.acceptEnrollment(bundle);
        return bundle.credential.payload.deviceId;
      }),
    ),
  );

  const winners = results.filter(
    (result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled',
  );
  const losers = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 31);
  assert.equal(
    losers.every(
      ({ reason }) => reason instanceof PkiHarnessError && reason.code === 'challenge_invalidated',
    ),
    true,
  );

  const state = fixture.core.inspect();
  assert.equal(state.devices.length, 1);
  assert.equal(state.credentials.length, 1);
  assert.equal(state.invitations.length, 1);
  assert.equal(state.invitations[0]?.status, 'consumed');
  assert.equal(state.invitations[0]?.consumedByDeviceId, winners[0]?.value);
});

test('expired, wrong-scope, and malformed invitations fail closed without issuance', () => {
  const fixture = createPkiFixture('invitation-rejections');
  const expiredBootstrap = fixture.core.createPairingInvitation({
    scope: { siteId: 'site-main', groupId: 'short-lived' },
    ttlMs: MINUTE_MS,
  });
  const expiredEdge = new EdgeInstallation({
    installationId: 'installation-expired',
    runtimeInstanceId: 'runtime-expired',
    now: fixture.clock.now,
  });
  const expiredRequest = expiredEdge.prepareEnrollment(
    expiredBootstrap,
    fixture.endpoint.presentedIdentity,
  );
  fixture.clock.advance(MINUTE_MS);
  assertPkiError(() => fixture.core.startEnrollment(expiredRequest), 'invitation_expired');

  const scopedBootstrap = fixture.core.createPairingInvitation({
    scope: { siteId: 'site-main', groupId: 'north-wing' },
    ttlMs: 5 * MINUTE_MS,
  });
  const scopedEdge = new EdgeInstallation({
    installationId: 'installation-scope',
    runtimeInstanceId: 'runtime-scope',
    now: fixture.clock.now,
  });
  const scopedRequest = scopedEdge.prepareEnrollment(
    scopedBootstrap,
    fixture.endpoint.presentedIdentity,
  );
  assertPkiError(
    () =>
      fixture.core.startEnrollment({
        ...scopedRequest,
        scope: { siteId: 'site-main', groupId: 'south-wing' },
      }),
    'invitation_scope_mismatch',
  );
  assertPkiError(
    () => fixture.core.startEnrollment({ ...scopedRequest, invitationSecret: 'too-short' }),
    'invitation_malformed',
  );

  assert.equal(fixture.core.inspect().devices.length, 0);
  assert.equal(fixture.core.inspect().credentials.length, 0);
});
