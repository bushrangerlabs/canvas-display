import assert from 'node:assert/strict';
import test from 'node:test';
import { PkiHarnessError } from './crypto-model.js';
import {
  HOUR_MS,
  activateIssuer,
  connectEdge,
  createPkiFixture,
  pairEdge,
} from './test-fixture.js';

function assertPkiError(action: () => unknown, expectedCode: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof PkiHarnessError && error.code === expectedCode,
    `expected PkiHarnessError(${expectedCode})`,
  );
}

test('concurrent cloned-credential use quarantines the device and closes the original session', () => {
  const fixture = createPkiFixture('clone-quarantine');
  const original = pairEdge(fixture, {
    installationId: 'installation-clone-target',
    runtimeInstanceId: 'runtime-original',
  });
  const originalSession = connectEdge(fixture, original, {
    connectionId: 'connection-original',
  });
  const stolenClone = original.simulateStolenCredentialCloneForTest('runtime-stolen-clone');

  const cloneChallenge = fixture.core.startConnection(stolenClone.credentialBundle, {
    connectionId: 'connection-clone',
    observedInstallationInstanceId: stolenClone.runtimeInstanceId,
  });
  const cloneProof = stolenClone.answerConnectionChallenge(cloneChallenge);
  assertPkiError(
    () => fixture.core.finishConnection(cloneProof),
    'clone_detected_quarantined',
  );

  assert.equal(fixture.core.isSessionActive(originalSession), false);
  const state = fixture.core.inspect();
  assert.equal(state.sessions.length, 0);
  assert.equal(state.devices[0]?.status, 'quarantined');
  assert.equal(state.credentials[0]?.status, 'quarantined');
  assert.equal(
    state.audit.some((event) => event.type === 'credential_clone_quarantined'),
    true,
  );
  assertPkiError(
    () =>
      fixture.core.startConnection(original.credentialBundle, {
        connectionId: 'connection-after-quarantine',
        observedInstallationInstanceId: original.runtimeInstanceId,
      }),
    'device_quarantined',
  );
});

test('authenticated key rotation requires old-key authorization and new-key proof of possession', () => {
  const fixture = createPkiFixture('device-key-rotation');
  const edge = pairEdge(fixture, {
    installationId: 'installation-rotate',
    runtimeInstanceId: 'runtime-rotate',
  });
  const oldBundle = edge.credentialBundle;
  const oldKeyClone = edge.simulateStolenCredentialCloneForTest('runtime-old-key-copy');
  const sessionId = connectEdge(fixture, edge, { connectionId: 'connection-before-rotation' });

  const request = edge.prepareKeyRotation();
  const challenge = fixture.core.startKeyRotation(sessionId, request);
  const proof = edge.answerKeyRotationChallenge(challenge);
  const rotatedBundle = fixture.core.completeKeyRotation(proof);
  edge.acceptKeyRotation(rotatedBundle);

  assert.equal(fixture.core.isSessionActive(sessionId), false);
  assert.equal(rotatedBundle.credential.payload.deviceId, oldBundle.credential.payload.deviceId);
  assert.equal(
    rotatedBundle.credential.payload.installationId,
    oldBundle.credential.payload.installationId,
  );
  assert.equal(rotatedBundle.credential.payload.generation, 2);
  assert.equal(
    rotatedBundle.credential.payload.previousSerial,
    oldBundle.credential.payload.serial,
  );
  assert.notEqual(
    rotatedBundle.credential.payload.publicKeyFingerprint,
    oldBundle.credential.payload.publicKeyFingerprint,
  );
  assert.equal(edge.inspect().generation, 2);

  assertPkiError(
    () =>
      fixture.core.startConnection(oldKeyClone.credentialBundle, {
        connectionId: 'connection-with-superseded-key',
        observedInstallationInstanceId: oldKeyClone.runtimeInstanceId,
      }),
    'credential_revoked',
  );
  const rotatedSession = connectEdge(fixture, edge, {
    connectionId: 'connection-after-rotation',
  });
  assert.equal(fixture.core.isSessionActive(rotatedSession), true);
});

test('targeted revocation disconnects and blocks only the selected device', () => {
  const fixture = createPkiFixture('targeted-revocation');
  const edgeA = pairEdge(fixture, {
    installationId: 'installation-revoke-a',
    runtimeInstanceId: 'runtime-revoke-a',
  });
  const edgeB = pairEdge(fixture, {
    installationId: 'installation-revoke-b',
    runtimeInstanceId: 'runtime-revoke-b',
  });
  const sessionA = connectEdge(fixture, edgeA, { connectionId: 'connection-revoke-a' });
  const sessionB = connectEdge(fixture, edgeB, { connectionId: 'connection-revoke-b' });

  fixture.core.revokeDevice(edgeA.credentialBundle.credential.payload.deviceId, 'device reported lost');

  assert.equal(fixture.core.isSessionActive(sessionA), false);
  assert.equal(fixture.core.isSessionActive(sessionB), true);
  assertPkiError(
    () =>
      fixture.core.startConnection(edgeA.credentialBundle, {
        connectionId: 'connection-revoked-retry',
        observedInstallationInstanceId: edgeA.runtimeInstanceId,
      }),
    'device_revoked',
  );

  const state = fixture.core.inspect();
  const deviceA = state.devices.find(
    (device) => device.deviceId === edgeA.credentialBundle.credential.payload.deviceId,
  );
  const deviceB = state.devices.find(
    (device) => device.deviceId === edgeB.credentialBundle.credential.payload.deviceId,
  );
  assert.equal(deviceA?.status, 'revoked');
  assert.equal(deviceB?.status, 'active');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0]?.deviceId, deviceB?.deviceId);
});

test('issuer rotation accepts old and new credentials only during the declared overlap', () => {
  const fixture = createPkiFixture('issuer-overlap');
  const oldIssuerEdge = pairEdge(fixture, {
    installationId: 'installation-old-issuer',
    runtimeInstanceId: 'runtime-old-issuer',
  });
  assert.equal(oldIssuerEdge.credentialBundle.credential.payload.issuerId, 'issuer-1');

  activateIssuer(fixture, 'issuer-2', HOUR_MS);
  const oldIssuerSession = connectEdge(fixture, oldIssuerEdge, {
    connectionId: 'connection-old-during-overlap',
  });
  const newIssuerEdge = pairEdge(fixture, {
    installationId: 'installation-new-issuer',
    runtimeInstanceId: 'runtime-new-issuer',
  });
  assert.equal(newIssuerEdge.credentialBundle.credential.payload.issuerId, 'issuer-2');
  const newIssuerSession = connectEdge(fixture, newIssuerEdge, {
    connectionId: 'connection-new-issuer',
  });

  const overlapping = fixture.core.inspect().issuers;
  assert.equal(overlapping.find((issuer) => issuer.issuerId === 'issuer-1')?.state, 'overlap');
  assert.equal(overlapping.find((issuer) => issuer.issuerId === 'issuer-2')?.state, 'active');

  fixture.clock.advance(HOUR_MS + 1);
  fixture.core.enforceTimePolicies();
  assert.equal(fixture.core.isSessionActive(oldIssuerSession), false);
  assert.equal(fixture.core.isSessionActive(newIssuerSession), true);
  assertPkiError(
    () =>
      fixture.core.startConnection(oldIssuerEdge.credentialBundle, {
        connectionId: 'connection-old-after-overlap',
        observedInstallationInstanceId: oldIssuerEdge.runtimeInstanceId,
      }),
    'issuer_not_trusted',
  );

  const acceptedNewChallenge = fixture.core.startConnection(newIssuerEdge.credentialBundle, {
    connectionId: 'connection-new-after-overlap',
    observedInstallationInstanceId: newIssuerEdge.runtimeInstanceId,
  });
  assert.equal(acceptedNewChallenge.payload.serial, newIssuerEdge.credentialBundle.credential.payload.serial);
});
