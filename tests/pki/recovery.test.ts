import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PkiHarnessError,
  publicKeyFingerprint,
  type IssuedCredentialBundle,
} from './crypto-model.js';
import {
  EdgeInstallation,
  type OwnerRecoveryAuthorization,
} from './pki-state-machine.js';
import {
  DAY_MS,
  MINUTE_MS,
  connectEdge,
  createPkiFixture,
  pairEdge,
} from './test-fixture.js';

const OWNER_AUTHORIZATION: OwnerRecoveryAuthorization = {
  principalId: 'owner-phase0-test',
  role: 'owner',
  stepUpVerified: true,
  authorizationId: 'owner-step-up-0001',
};

function assertPkiError(action: () => unknown, expectedCode: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof PkiHarnessError && error.code === expectedCode,
    `expected PkiHarnessError(${expectedCode})`,
  );
}

test('expired credential cannot connect or rotate, but owner grant recovers a lost key without affecting a peer', () => {
  const fixture = createPkiFixture('expired-lost-key-recovery');
  const expiredEdge = pairEdge(fixture, {
    installationId: 'installation-expired-recovery',
    runtimeInstanceId: 'runtime-expired-original',
  });
  const expiredBundle = expiredEdge.credentialBundle;
  const expiredSession = connectEdge(fixture, expiredEdge, {
    connectionId: 'connection-before-expiry',
  });

  fixture.clock.advance(13 * DAY_MS);
  const unaffectedEdge = pairEdge(fixture, {
    installationId: 'installation-unaffected-peer',
    runtimeInstanceId: 'runtime-unaffected-peer',
  });
  const unaffectedSession = connectEdge(fixture, unaffectedEdge, {
    connectionId: 'connection-unaffected-peer',
  });
  fixture.clock.advance(DAY_MS);

  assertPkiError(
    () =>
      fixture.core.startConnection(expiredBundle, {
        connectionId: 'connection-expired-retry',
        observedInstallationInstanceId: expiredEdge.runtimeInstanceId,
      }),
    'credential_expired',
  );
  const unauthorizedRotation = expiredEdge.prepareKeyRotation();
  assertPkiError(
    () => fixture.core.startKeyRotation(expiredSession, unauthorizedRotation),
    'credential_expired',
  );

  fixture.core.enforceTimePolicies();
  assert.equal(fixture.core.isSessionActive(expiredSession), false);
  assert.equal(fixture.core.isSessionActive(unaffectedSession), true);

  const recoveryGrant = fixture.core.createOwnerAuthorizedRecoveryGrant({
    authorization: OWNER_AUTHORIZATION,
    deviceId: expiredBundle.credential.payload.deviceId,
    installationId: expiredBundle.credential.payload.installationId,
    preserveDeviceId: true,
    ttlMs: 5 * MINUTE_MS,
  });
  const replacementEdge = new EdgeInstallation({
    installationId: expiredBundle.credential.payload.installationId,
    runtimeInstanceId: 'runtime-after-lost-key',
    now: fixture.clock.now,
  });
  assert.equal(replacementEdge.inspect().hasLocalPrivateKey, false);

  const recoveryRequest = replacementEdge.prepareCredentialRecovery(
    recoveryGrant,
    fixture.endpoint.presentedIdentity,
  );
  assert.notEqual(
    publicKeyFingerprint(recoveryRequest.newPublicKeySpki),
    expiredBundle.credential.payload.publicKeyFingerprint,
  );
  const challenge = fixture.core.startCredentialRecovery(recoveryRequest);
  const proof = replacementEdge.answerCredentialRecoveryChallenge(challenge);
  const recoveredBundle = fixture.core.completeCredentialRecovery(proof);
  replacementEdge.acceptCredentialRecovery(recoveredBundle);

  assert.equal(recoveredBundle.credential.payload.deviceId, expiredBundle.credential.payload.deviceId);
  assert.equal(
    recoveredBundle.credential.payload.installationId,
    expiredBundle.credential.payload.installationId,
  );
  assert.equal(recoveredBundle.credential.payload.generation, 2);
  assert.equal(
    recoveredBundle.credential.payload.previousSerial,
    expiredBundle.credential.payload.serial,
  );
  assert.equal(recoveryGrant.preserveDeviceId, true);

  const state = fixture.core.inspect();
  const targetCredentials = state.credentials.filter(
    (credential) => credential.deviceId === expiredBundle.credential.payload.deviceId,
  );
  assert.equal(targetCredentials.length, 2);
  assert.equal(
    targetCredentials.find((credential) => credential.serial === expiredBundle.credential.payload.serial)
      ?.status,
    'fenced',
  );
  assert.equal(
    targetCredentials.find(
      (credential) => credential.serial === recoveredBundle.credential.payload.serial,
    )?.status,
    'active',
  );
  assert.equal(fixture.core.isSessionActive(unaffectedSession), true);
  assert.equal(
    state.devices.find(
      (device) => device.deviceId === unaffectedEdge.credentialBundle.credential.payload.deviceId,
    )?.status,
    'active',
  );

  const recoveredSession = connectEdge(fixture, replacementEdge, {
    connectionId: 'connection-after-owner-recovery',
  });
  assert.equal(fixture.core.isSessionActive(recoveredSession), true);
  assert.equal(fixture.core.isSessionActive(unaffectedSession), true);
});

test('owner recovery grants are high-entropy, short-lived, hash-only, target-bound, and one-use', () => {
  const fixture = createPkiFixture('recovery-grant-controls');
  const edgeA = pairEdge(fixture, {
    installationId: 'installation-grant-a',
    runtimeInstanceId: 'runtime-grant-a',
  });
  const edgeB = pairEdge(fixture, {
    installationId: 'installation-grant-b',
    runtimeInstanceId: 'runtime-grant-b',
  });
  const payloadA = edgeA.credentialBundle.credential.payload;
  const payloadB = edgeB.credentialBundle.credential.payload;

  const invalidAuthorization = {
    ...OWNER_AUTHORIZATION,
    role: 'admin',
  } as unknown as OwnerRecoveryAuthorization;
  assertPkiError(
    () =>
      fixture.core.createOwnerAuthorizedRecoveryGrant({
        authorization: invalidAuthorization,
        deviceId: payloadA.deviceId,
        installationId: payloadA.installationId,
        preserveDeviceId: true,
        ttlMs: 5 * MINUTE_MS,
      }),
    'owner_authorization_required',
  );
  assertPkiError(
    () =>
      fixture.core.createOwnerAuthorizedRecoveryGrant({
        authorization: OWNER_AUTHORIZATION,
        deviceId: payloadA.deviceId,
        installationId: payloadA.installationId,
        preserveDeviceId: false,
        ttlMs: 5 * MINUTE_MS,
      }),
    'device_id_preservation_not_authorized',
  );
  assertPkiError(
    () =>
      fixture.core.createOwnerAuthorizedRecoveryGrant({
        authorization: OWNER_AUTHORIZATION,
        deviceId: payloadA.deviceId,
        installationId: payloadA.installationId,
        preserveDeviceId: true,
        ttlMs: 16 * MINUTE_MS,
      }),
    'invalid_recovery_grant_ttl',
  );

  const grantA = fixture.core.createOwnerAuthorizedRecoveryGrant({
    authorization: OWNER_AUTHORIZATION,
    deviceId: payloadA.deviceId,
    installationId: payloadA.installationId,
    preserveDeviceId: true,
    ttlMs: 5 * MINUTE_MS,
  });
  const grantB = fixture.core.createOwnerAuthorizedRecoveryGrant({
    authorization: {
      ...OWNER_AUTHORIZATION,
      authorizationId: 'owner-step-up-0002',
    },
    deviceId: payloadB.deviceId,
    installationId: payloadB.installationId,
    preserveDeviceId: true,
    ttlMs: MINUTE_MS,
  });
  assert.equal(Buffer.from(grantA.recoverySecret, 'base64url').length >= 16, true);
  assert.equal(grantA.recoveryEntropyBits >= 128, true);
  const persisted = JSON.stringify(fixture.core.inspect());
  assert.equal(persisted.includes(grantA.recoverySecret), false);
  assert.equal(persisted.includes(grantB.recoverySecret), false);
  assert.match(
    String(
      fixture.core.inspect().recoveryGrants.find(
        (grant) => grant.deviceId === payloadA.deviceId,
      )?.secretHash,
    ),
    /^sha256:[0-9a-f]{64}$/,
  );

  const recoveringA = new EdgeInstallation({
    installationId: payloadA.installationId,
    runtimeInstanceId: 'runtime-recovering-a',
    now: fixture.clock.now,
  });
  const requestA = recoveringA.prepareCredentialRecovery(
    grantA,
    fixture.endpoint.presentedIdentity,
  );
  assertPkiError(
    () =>
      fixture.core.startCredentialRecovery({
        ...requestA,
        deviceId: payloadB.deviceId,
      }),
    'recovery_grant_target_mismatch',
  );
  assertPkiError(
    () =>
      fixture.core.startCredentialRecovery({
        ...requestA,
        installationId: payloadB.installationId,
      }),
    'recovery_grant_target_mismatch',
  );
  assertPkiError(
    () =>
      fixture.core.startCredentialRecovery({
        ...requestA,
        recoverySecret: grantB.recoverySecret,
      }),
    'recovery_grant_target_mismatch',
  );

  const recoveringB = new EdgeInstallation({
    installationId: payloadB.installationId,
    runtimeInstanceId: 'runtime-recovering-b',
    now: fixture.clock.now,
  });
  const requestB = recoveringB.prepareCredentialRecovery(
    grantB,
    fixture.endpoint.presentedIdentity,
  );
  fixture.clock.advance(MINUTE_MS);
  assertPkiError(() => fixture.core.startCredentialRecovery(requestB), 'recovery_grant_expired');

  const challengeA = fixture.core.startCredentialRecovery(requestA);
  const proofA = recoveringA.answerCredentialRecoveryChallenge(challengeA);
  const recoveredA = fixture.core.completeCredentialRecovery(proofA);
  recoveringA.acceptCredentialRecovery(recoveredA);
  assert.equal(recoveredA.credential.payload.deviceId, payloadA.deviceId);

  assertPkiError(() => fixture.core.completeCredentialRecovery(proofA), 'challenge_used');
  const replayingA = new EdgeInstallation({
    installationId: payloadA.installationId,
    runtimeInstanceId: 'runtime-replaying-a',
    now: fixture.clock.now,
  });
  const replayRequest = replayingA.prepareCredentialRecovery(
    grantA,
    fixture.endpoint.presentedIdentity,
  );
  assertPkiError(
    () => fixture.core.startCredentialRecovery(replayRequest),
    'recovery_grant_consumed',
  );
});

test('concurrent lost-key recovery has one winner and fences every prior credential', async () => {
  const fixture = createPkiFixture('recovery-race');
  const original = pairEdge(fixture, {
    installationId: 'installation-recovery-race',
    runtimeInstanceId: 'runtime-recovery-race-original',
  });
  const generationOne = original.credentialBundle.credential.payload;
  const rotationSession = connectEdge(fixture, original, {
    connectionId: 'connection-recovery-race-pre-rotation',
  });
  const rotationRequest = original.prepareKeyRotation();
  const rotationChallenge = fixture.core.startKeyRotation(rotationSession, rotationRequest);
  const rotationProof = original.answerKeyRotationChallenge(rotationChallenge);
  const rotatedBundle = fixture.core.completeKeyRotation(rotationProof);
  original.acceptKeyRotation(rotatedBundle);
  const generationTwo = original.credentialBundle.credential.payload;
  const generationTwoSession = connectEdge(fixture, original, {
    connectionId: 'connection-recovery-race-generation-two',
  });

  const grant = fixture.core.createOwnerAuthorizedRecoveryGrant({
    authorization: OWNER_AUTHORIZATION,
    deviceId: generationTwo.deviceId,
    installationId: generationTwo.installationId,
    preserveDeviceId: true,
    ttlMs: 5 * MINUTE_MS,
  });

  const contenders = Array.from({ length: 16 }, (_, index) => {
    const edge = new EdgeInstallation({
      installationId: generationTwo.installationId,
      runtimeInstanceId: `runtime-recovery-race-${String(index).padStart(2, '0')}`,
      now: fixture.clock.now,
    });
    const request = edge.prepareCredentialRecovery(grant, fixture.endpoint.presentedIdentity);
    const challenge = fixture.core.startCredentialRecovery(request);
    return {
      edge,
      proof: edge.answerCredentialRecoveryChallenge(challenge),
    };
  });

  const results = await Promise.allSettled(
    contenders.map(({ edge, proof }) =>
      Promise.resolve().then(() => {
        const bundle = fixture.core.completeCredentialRecovery(proof);
        edge.acceptCredentialRecovery(bundle);
        return bundle;
      }),
    ),
  );
  const winners = results.filter(
    (result): result is PromiseFulfilledResult<IssuedCredentialBundle> =>
      result.status === 'fulfilled',
  );
  const losers = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 15);
  assert.equal(
    losers.every(
      ({ reason }) => reason instanceof PkiHarnessError && reason.code === 'challenge_invalidated',
    ),
    true,
  );

  const winningBundle = winners[0]?.value;
  assert(winningBundle);
  assert.equal(winningBundle.credential.payload.deviceId, generationTwo.deviceId);
  assert.equal(winningBundle.credential.payload.installationId, generationTwo.installationId);
  assert.equal(winningBundle.credential.payload.generation, 3);
  assert.equal(winningBundle.credential.payload.previousSerial, generationTwo.serial);

  const state = fixture.core.inspect();
  assert.equal(state.devices.length, 1);
  assert.equal(state.recoveryGrants[0]?.status, 'consumed');
  assert.equal(fixture.core.isSessionActive(generationTwoSession), false);
  const credentials = state.credentials.filter(
    (credential) => credential.deviceId === generationTwo.deviceId,
  );
  assert.equal(credentials.length, 3);
  assert.equal(
    credentials.find((credential) => credential.serial === generationOne.serial)?.status,
    'fenced',
  );
  assert.equal(
    credentials.find((credential) => credential.serial === generationTwo.serial)?.status,
    'fenced',
  );
  assert.equal(
    credentials.find(
      (credential) => credential.serial === winningBundle.credential.payload.serial,
    )?.status,
    'active',
  );
});
