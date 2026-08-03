import assert from 'node:assert/strict';
import test from 'node:test';
import { PkiHarnessError } from './crypto-model.js';
import {
  EdgeInstallation,
  type OwnerRecoveryAuthorization,
} from './pki-state-machine.js';
import {
  MINUTE_MS,
  activateIssuer,
  connectEdge,
  createPkiFixture,
  pairEdge,
} from './test-fixture.js';

const OWNER_AUTHORIZATION: OwnerRecoveryAuthorization = {
  principalId: 'owner-restore-test',
  role: 'owner',
  stepUpVerified: true,
  authorizationId: 'owner-restore-step-up',
};

function assertPkiError(action: () => unknown, expectedCode: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof PkiHarnessError && error.code === expectedCode,
    `expected PkiHarnessError(${expectedCode})`,
  );
}

test('stale database restore advances a durable epoch and fences resurrected invitations, recovery grants, and credentials', () => {
  const fixture = createPkiFixture('stale-restore-fence');
  const edgeA = pairEdge(fixture, {
    installationId: 'installation-before-backup',
    runtimeInstanceId: 'runtime-before-backup',
  });
  connectEdge(fixture, edgeA, { connectionId: 'connection-before-backup' });

  const invitationVisibleAsUnusedInBackup = fixture.core.createPairingInvitation({
    scope: { siteId: 'site-main', groupId: 'displays' },
    ttlMs: 10 * MINUTE_MS,
  });
  const recoveryGrantVisibleAsUnusedInBackup = fixture.core.createOwnerAuthorizedRecoveryGrant({
    authorization: OWNER_AUTHORIZATION,
    deviceId: edgeA.credentialBundle.credential.payload.deviceId,
    installationId: edgeA.credentialBundle.credential.payload.installationId,
    preserveDeviceId: true,
    ttlMs: 10 * MINUTE_MS,
  });
  const backup = fixture.core.createDatabaseBackup();
  const backedUpEpoch = backup.securityEpoch;

  const edgeB = pairEdge(fixture, {
    installationId: 'installation-consumed-after-backup',
    runtimeInstanceId: 'runtime-consumed-after-backup',
    bootstrap: invitationVisibleAsUnusedInBackup,
  });
  fixture.core.revokeDevice(
    edgeA.credentialBundle.credential.payload.deviceId,
    'revoked after backup',
  );
  const preRestoreFence = fixture.fence.snapshot;
  assert(preRestoreFence.sequence > backup.fenceSequence);

  const restore = fixture.core.restoreDatabase(backup);
  assert.equal(restore.stale, true);
  assert(restore.securityEpoch > backedUpEpoch);
  assert.equal(fixture.fence.snapshot.securityEpoch, restore.securityEpoch);

  const restoredState = fixture.core.inspect();
  assert.equal(restoredState.recoveryPending, true);
  assert.equal(restoredState.currentIssuerId, null);
  assert.equal(restoredState.sessions.length, 0);
  assert.equal(restoredState.invitations[0]?.status, 'fenced');
  assert.equal(restoredState.recoveryGrants[0]?.status, 'fenced');
  assert.equal(restoredState.credentials[0]?.status, 'fenced');
  assert.equal(restoredState.devices[0]?.status, 'recovery_required');
  assert.equal(
    restoredState.audit.some((event) => event.type === 'stale_database_restore_fenced'),
    true,
  );

  const replayingEdge = new EdgeInstallation({
    installationId: 'installation-restore-replay',
    runtimeInstanceId: 'runtime-restore-replay',
    now: fixture.clock.now,
  });
  const replayRequest = replayingEdge.prepareEnrollment(
    invitationVisibleAsUnusedInBackup,
    fixture.endpoint.presentedIdentity,
  );
  assertPkiError(() => fixture.core.startEnrollment(replayRequest), 'invitation_fenced');

  const recoveryReplayer = new EdgeInstallation({
    installationId: edgeA.credentialBundle.credential.payload.installationId,
    runtimeInstanceId: 'runtime-restore-recovery-replay',
    now: fixture.clock.now,
  });
  const recoveryReplayRequest = recoveryReplayer.prepareCredentialRecovery(
    recoveryGrantVisibleAsUnusedInBackup,
    fixture.endpoint.presentedIdentity,
  );
  assertPkiError(
    () => fixture.core.startCredentialRecovery(recoveryReplayRequest),
    'recovery_grant_fenced',
  );

  assertPkiError(
    () =>
      fixture.core.startConnection(edgeA.credentialBundle, {
        connectionId: 'connection-revocation-resurrection-attempt',
        observedInstallationInstanceId: edgeA.runtimeInstanceId,
      }),
    'credential_security_epoch_fenced',
  );
  assertPkiError(
    () =>
      fixture.core.startConnection(edgeB.credentialBundle, {
        connectionId: 'connection-post-backup-credential-attempt',
        observedInstallationInstanceId: edgeB.runtimeInstanceId,
      }),
    'credential_security_epoch_fenced',
  );
  assertPkiError(
    () =>
      fixture.core.createPairingInvitation({
        scope: { siteId: 'site-main', groupId: 'displays' },
        ttlMs: 10 * MINUTE_MS,
      }),
    'issuer_recovery_required',
  );

  activateIssuer(fixture, 'issuer-after-restore');
  const recoveredEdge = pairEdge(fixture, {
    installationId: 'installation-after-recovery',
    runtimeInstanceId: 'runtime-after-recovery',
  });
  assert.equal(
    recoveredEdge.credentialBundle.credential.payload.securityEpoch,
    restore.securityEpoch,
  );
  assert.equal(
    recoveredEdge.credentialBundle.credential.payload.issuerId,
    'issuer-after-restore',
  );
  const recoveredSession = connectEdge(fixture, recoveredEdge, {
    connectionId: 'connection-after-recovery',
  });
  assert.equal(fixture.core.isSessionActive(recoveredSession), true);

  const secondRestore = fixture.core.restoreDatabase(backup);
  assert.equal(secondRestore.stale, true);
  assert(secondRestore.securityEpoch > restore.securityEpoch);
  assertPkiError(
    () =>
      fixture.core.startConnection(recoveredEdge.credentialBundle, {
        connectionId: 'connection-fenced-by-second-restore',
        observedInstallationInstanceId: recoveredEdge.runtimeInstanceId,
      }),
    'credential_security_epoch_fenced',
  );
});
