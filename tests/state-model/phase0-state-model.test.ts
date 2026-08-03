import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTHORITY_MODES,
  AuthorityFence,
  CoreDesiredAuthority,
  EdgeStateReplica,
  ModelInvariantError,
  STATE_DOMAINS,
  absent,
  desired,
  parseAuthorityMode,
  type ApplicationAcceptance,
  type EdgeObservationSource,
  type EffectiveTarget,
  type JsonValue,
  type ReportedDomainSnapshot,
  type ReportedSnapshot,
  type StateDomain,
} from './phase0-state-model.js';

const OLD_EPOCH = 'authority-epoch-old';
const NEW_EPOCH = 'authority-epoch-new';

function expectCoreTarget(
  edge: EdgeStateReplica,
  domain: StateDomain,
  atMs: number,
): Extract<EffectiveTarget, { authority: 'core' }> {
  const target = edge.effectiveTarget(domain, atMs);
  assert.equal(target.authority, 'core', JSON.stringify(target));
  if (target.authority !== 'core') {
    throw new Error(`expected a Core target for ${domain}`);
  }
  return target;
}

function reportApplied(
  edge: EdgeStateReplica,
  domain: StateDomain,
  actualState: JsonValue,
  atMs: number,
  source: EdgeObservationSource = 'agent',
): ApplicationAcceptance {
  const target = expectCoreTarget(edge, domain, atMs);
  return edge.reportApplication({
    authorityEpoch: target.authorityEpoch,
    domain,
    desiredRevision: target.revision,
    desiredDigest: target.digest,
    source,
    outcome: { status: 'applied', actualState },
  }, atMs);
}

function domainSnapshot(report: ReportedSnapshot, domain: StateDomain): ReportedDomainSnapshot {
  const found = report.domains.find((candidate) => candidate.domain === domain);
  assert(found, `missing reported domain ${domain}`);
  return found;
}

test('Core keeps one active epoch and strictly monotonic revisions within it', () => {
  const core = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: { display: { power: 'on' } },
  });

  const revisionTwo = core.publishPatch(2, {
    display: desired({ power: 'on', brightness: 80 }),
  });
  assert.equal(revisionTwo.authorityEpoch, OLD_EPOCH);
  assert.equal(revisionTwo.baseRevision, 1);
  assert.throws(
    () => core.publishPatch(2, { display: desired({ power: 'off' }) }),
    ModelInvariantError,
  );
  assert.throws(
    () => core.publishPatch(1, { display: desired({ power: 'off' }) }),
    ModelInvariantError,
  );

  const cutover = core.cutover({
    authorityEpoch: NEW_EPOCH,
    revision: 1,
    desired: { display: { power: 'off' } },
  });
  assert.equal(cutover.snapshotKind, 'full');
  assert.equal(cutover.authorityEpoch, NEW_EPOCH);
  assert.equal(cutover.revision, 1);
  assert.throws(
    () => core.cutover({ authorityEpoch: OLD_EPOCH, revision: 1 }),
    ModelInvariantError,
  );
});

test('cutover requires a new full snapshot and delayed old epochs stay fenced', () => {
  const oldCore = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: {
      scene: { sceneRevision: 'lobby-v1' },
      display: { power: 'on' },
    },
  });
  const oldBootstrap = oldCore.currentFullSnapshot();
  const edge = new EdgeStateReplica(oldBootstrap, 0);
  assert.deepEqual(
    reportApplied(edge, 'scene', { sceneRevision: 'lobby-v1' }, 5, 'renderer'),
    { accepted: true, status: 'recorded' },
  );

  const delayedOldRevision = oldCore.publishPatch(2, {
    scene: desired({ sceneRevision: 'lobby-v2-from-retired-authority' }),
  });

  const newCore = new CoreDesiredAuthority({
    authorityEpoch: NEW_EPOCH,
    revision: 1,
    desired: {
      scene: { sceneRevision: 'welcome-v1' },
      display: { power: 'on' },
    },
  });
  const partialNewRevision = newCore.publishPatch(2, {
    display: desired({ power: 'off' }),
  });

  const fence = new AuthorityFence('legacy');
  fence.enterShadow();
  const partialAttempt = fence.cutoverToCore(edge, partialNewRevision, 20);
  assert.deepEqual(partialAttempt, {
    cutover: false,
    mode: 'shadow',
    code: 'cutover_requires_full_snapshot',
  });
  assert.equal(fence.mode, 'shadow');

  const fullNewSnapshot = newCore.currentFullSnapshot();
  const cutover = fence.cutoverToCore(edge, fullNewSnapshot, 21);
  assert.equal(cutover.cutover, true, JSON.stringify(cutover));
  assert.equal(fence.mode, 'core');

  const delayed = edge.acceptDesired(delayedOldRevision, 22);
  assert.equal(delayed.accepted, false);
  if (!delayed.accepted) {
    assert.equal(delayed.code, 'stale_authority_epoch');
  }

  const report = edge.reportedSnapshot(22);
  assert.equal(report.authority.epoch, NEW_EPOCH);
  assert.equal(report.authority.acceptedRevision, 2);
  assert.deepEqual(report.authority.retiredEpochs, [OLD_EPOCH]);

  const scene = domainSnapshot(report, 'scene');
  assert.equal(scene.desired.status, 'desired');
  assert.equal(scene.desired.revision, 2);
  assert.deepEqual(scene.desired.state, { sceneRevision: 'welcome-v1' });
  assert.equal(scene.application.status, 'pending');
  assert.equal(scene.application.lastAppliedRevision, null);
  assert.deepEqual(scene.observed, {
    status: 'observed',
    state: { sceneRevision: 'lobby-v1' },
    digest: scene.observed.digest,
    observedAtMs: 5,
    source: 'renderer',
  });

  const audio = domainSnapshot(report, 'audio');
  assert.equal(audio.desired.status, 'absent');
  assert.equal(audio.application.status, 'not_requested');
});

test('Edge rejects stale revisions and same-revision content with a different digest', () => {
  const base = {
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: { display: { power: 'on', brightness: 80 } },
  } as const;
  const canonicalCore = new CoreDesiredAuthority(base);
  const forkedCore = new CoreDesiredAuthority(base);
  const bootstrap = canonicalCore.currentFullSnapshot();
  const edge = new EdgeStateReplica(bootstrap, 0);

  const canonicalRevisionTwo = canonicalCore.publishPatch(2, {
    display: desired({ power: 'on', brightness: 60 }),
  });
  const conflictingRevisionTwo = forkedCore.publishPatch(2, {
    display: desired({ power: 'on', brightness: 20 }),
  });
  assert.notEqual(canonicalRevisionTwo.digest, conflictingRevisionTwo.digest);

  const accepted = edge.acceptDesired(canonicalRevisionTwo, 10);
  assert.equal(accepted.accepted, true, JSON.stringify(accepted));

  const conflict = edge.acceptDesired(conflictingRevisionTwo, 11);
  assert.equal(conflict.accepted, false);
  if (!conflict.accepted) {
    assert.equal(conflict.code, 'revision_digest_conflict');
  }

  const stale = edge.acceptDesired(bootstrap, 12);
  assert.equal(stale.accepted, false);
  if (!stale.accepted) {
    assert.equal(stale.code, 'stale_revision');
  }

  const duplicate = edge.acceptDesired(canonicalRevisionTwo, 13);
  assert.equal(duplicate.accepted, true);
  if (duplicate.accepted) {
    assert.equal(duplicate.status, 'duplicate');
  }

  const report = edge.reportedSnapshot(13);
  const display = domainSnapshot(report, 'display');
  assert.equal(display.desired.status, 'desired');
  assert.deepEqual(display.desired.state, { brightness: 60, power: 'on' });
  assert.equal(display.desired.revision, 2);
});

test('partial desired state preserves omitted domains and reports independent outcomes', () => {
  const core = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: {
      scene: { sceneRevision: 'dashboard-v1' },
      display: { power: 'on', brightness: 90 },
      audio: { muted: false, volume: 30 },
    },
  });
  const edge = new EdgeStateReplica(core.currentFullSnapshot(), 0);

  assert.deepEqual(
    reportApplied(edge, 'scene', { sceneRevision: 'dashboard-v1' }, 10, 'renderer'),
    { accepted: true, status: 'recorded' },
  );

  const displayTarget = expectCoreTarget(edge, 'display', 11);
  assert.deepEqual(edge.reportApplication({
    authorityEpoch: displayTarget.authorityEpoch,
    domain: 'display',
    desiredRevision: displayTarget.revision,
    desiredDigest: displayTarget.digest,
    source: 'hardware_adapter',
    outcome: {
      status: 'diverged',
      actualState: { power: 'on', brightness: 70 },
      reason: {
        code: 'constraint_clamped',
        constraint: 'hardware_brightness_max',
        requested: 90,
        actual: 70,
      },
    },
  }, 11), { accepted: true, status: 'recorded' });

  const audioTarget = expectCoreTarget(edge, 'audio', 12);
  assert.deepEqual(edge.reportApplication({
    authorityEpoch: audioTarget.authorityEpoch,
    domain: 'audio',
    desiredRevision: audioTarget.revision,
    desiredDigest: audioTarget.digest,
    source: 'media_adapter',
    outcome: {
      status: 'failed',
      actualState: { muted: true, volume: 0 },
      reason: {
        code: 'dependency_unavailable',
        dependency: 'alsa-default-sink',
        retryable: true,
      },
    },
  }, 12), { accepted: true, status: 'recorded' });

  const sceneOnlyRevision = core.publishPatch(2, {
    scene: desired({ sceneRevision: 'dashboard-v2' }),
  });
  assert.equal(edge.acceptDesired(sceneOnlyRevision, 20).accepted, true);

  const report = edge.reportedSnapshot(20);
  const scene = domainSnapshot(report, 'scene');
  const display = domainSnapshot(report, 'display');
  const audio = domainSnapshot(report, 'audio');
  const update = domainSnapshot(report, 'update');

  assert.equal(scene.desired.revision, 2);
  assert.deepEqual(scene.desired.state, { sceneRevision: 'dashboard-v2' });
  assert.equal(scene.application.status, 'pending');
  assert.equal(scene.application.lastAppliedRevision, 1);

  assert.equal(display.desired.revision, 1);
  assert.equal(display.application.status, 'diverged');
  assert.deepEqual(display.application.reason, {
    code: 'constraint_clamped',
    constraint: 'hardware_brightness_max',
    requested: 90,
    actual: 70,
  });
  assert.deepEqual(display.observed.state, { brightness: 70, power: 'on' });

  assert.equal(audio.desired.revision, 1);
  assert.equal(audio.application.status, 'failed');
  assert.deepEqual(audio.application.reason, {
    code: 'dependency_unavailable',
    dependency: 'alsa-default-sink',
    retryable: true,
  });
  assert.deepEqual(audio.observed.state, { muted: true, volume: 0 });

  assert.equal(update.desired.status, 'absent');
  assert.equal(update.application.status, 'not_requested');
});

test('an active lease owns allowed actual state, then Core regains precedence at expiry', () => {
  const core = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: { display: { power: 'on', brightness: 80 } },
  });
  const edge = new EdgeStateReplica(core.currentFullSnapshot(), 0);
  const coreDisplayTarget = expectCoreTarget(edge, 'display', 5);
  assert.equal(
    reportApplied(edge, 'display', { power: 'on', brightness: 80 }, 5, 'hardware_adapter').accepted,
    true,
  );

  const activated = edge.activateLocalOverride({
    leaseId: 'physical-display-off',
    source: 'physical_control',
    startsAtMs: 10,
    expiresAtMs: 20,
    allowedDomains: ['display'],
    actualState: { display: { power: 'off', brightness: 0 } },
  }, 10);
  assert.deepEqual(activated, {
    accepted: true,
    status: 'activated',
    activeLeaseId: 'physical-display-off',
    supersededLeaseId: null,
  });

  const activeTarget = edge.effectiveTarget('display', 15);
  assert.equal(activeTarget.authority, 'local_override');
  if (activeTarget.authority === 'local_override') {
    assert.deepEqual(activeTarget.state, { brightness: 0, power: 'off' });
    assert.equal(activeTarget.source, 'physical_control');
  }

  const blockedCoreApply = edge.reportApplication({
    authorityEpoch: coreDisplayTarget.authorityEpoch,
    domain: 'display',
    desiredRevision: coreDisplayTarget.revision,
    desiredDigest: coreDisplayTarget.digest,
    source: 'hardware_adapter',
    outcome: { status: 'applied', actualState: coreDisplayTarget.state },
  }, 15);
  assert.deepEqual(blockedCoreApply, { accepted: false, code: 'local_override_active' });

  let report = edge.reportedSnapshot(15);
  let display = domainSnapshot(report, 'display');
  assert.equal(display.application.status, 'overridden');
  assert.equal(display.application.reason?.code, 'local_override_active');
  assert.deepEqual(display.observed.state, { brightness: 0, power: 'off' });
  assert.equal(report.localOverrides.leases[0]?.status, 'active');

  const expiryTarget = edge.effectiveTarget('display', 20);
  assert.equal(expiryTarget.authority, 'core');
  report = edge.reportedSnapshot(20);
  display = domainSnapshot(report, 'display');
  assert.equal(display.application.status, 'pending');
  assert.equal(display.application.lastAppliedRevision, 1);
  assert.deepEqual(display.observed.state, { brightness: 0, power: 'off' });
  assert.deepEqual(report.localOverrides.leases[0], {
    leaseId: 'physical-display-off',
    source: 'physical_control',
    startsAtMs: 10,
    expiresAtMs: 20,
    allowedDomains: ['display'],
    actualState: { display: { brightness: 0, power: 'off' } },
    status: 'expired',
    endedAtMs: 20,
    supersededByLeaseId: null,
  });

  assert.deepEqual(
    reportApplied(edge, 'display', { power: 'on', brightness: 80 }, 21, 'hardware_adapter'),
    { accepted: true, status: 'recorded' },
  );
  display = domainSnapshot(edge.reportedSnapshot(21), 'display');
  assert.equal(display.application.status, 'applied');
  assert.deepEqual(display.observed.state, { brightness: 80, power: 'on' });
});

test('a newer lease supersedes the active lease and the old lease never resumes', () => {
  const core = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: {
      display: { power: 'on' },
      audio: { muted: false, volume: 20 },
    },
  });
  const edge = new EdgeStateReplica(core.currentFullSnapshot(), 0);

  assert.equal(edge.activateLocalOverride({
    leaseId: 'safety-display-off',
    source: 'safety_policy',
    startsAtMs: 10,
    expiresAtMs: 100,
    allowedDomains: ['display'],
    actualState: { display: { power: 'off' } },
  }, 10).accepted, true);

  const superseded = edge.activateLocalOverride({
    leaseId: 'local-audio-mute',
    source: 'local_admin',
    startsAtMs: 20,
    expiresAtMs: 60,
    allowedDomains: ['audio'],
    actualState: { audio: { muted: true, volume: 0 } },
  }, 20);
  assert.deepEqual(superseded, {
    accepted: true,
    status: 'superseded',
    activeLeaseId: 'local-audio-mute',
    supersededLeaseId: 'safety-display-off',
  });

  const staleReplacement = edge.activateLocalOverride({
    leaseId: 'late-delivery-of-older-lease',
    source: 'local_admin',
    startsAtMs: 15,
    expiresAtMs: 80,
    allowedDomains: ['display'],
    actualState: { display: { power: 'off' } },
  }, 25);
  assert.deepEqual(staleReplacement, { accepted: false, code: 'lease_not_newer' });

  assert.equal(edge.effectiveTarget('display', 25).authority, 'core');
  assert.equal(edge.effectiveTarget('audio', 25).authority, 'local_override');

  let report = edge.reportedSnapshot(25);
  assert.deepEqual(report.localOverrides.leases.map((lease) => ({
    id: lease.leaseId,
    status: lease.status,
    supersededBy: lease.supersededByLeaseId,
  })), [
    {
      id: 'safety-display-off',
      status: 'superseded',
      supersededBy: 'local-audio-mute',
    },
    {
      id: 'local-audio-mute',
      status: 'active',
      supersededBy: null,
    },
  ]);
  assert.equal(domainSnapshot(report, 'display').application.status, 'pending');
  assert.equal(domainSnapshot(report, 'audio').application.status, 'overridden');

  assert.equal(edge.effectiveTarget('audio', 60).authority, 'core');
  assert.equal(edge.effectiveTarget('display', 60).authority, 'core');
  report = edge.reportedSnapshot(60);
  assert.equal(report.localOverrides.activeLeaseId, null);
  assert.deepEqual(report.localOverrides.leases.map((lease) => lease.status), [
    'superseded',
    'expired',
  ]);
});

test('rollback_pending has no writable side and no authority mode permits dual writes', () => {
  assert.throws(() => parseAuthorityMode('dual_write'), ModelInvariantError);

  for (const mode of AUTHORITY_MODES) {
    const candidate = new AuthorityFence(mode);
    const writableCount = [candidate.checkWrite('legacy'), candidate.checkWrite('core')]
      .filter((decision) => decision.allowed)
      .length;
    assert.ok(writableCount <= 1, `${mode} exposed more than one writable side`);
    assert.equal(candidate.snapshot().dualWrite, false);
  }

  const oldCore = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: { scene: { sceneRevision: 'old-v1' } },
  });
  const edge = new EdgeStateReplica(oldCore.currentFullSnapshot(), 0);
  const newCore = new CoreDesiredAuthority({
    authorityEpoch: NEW_EPOCH,
    revision: 1,
    desired: { scene: { sceneRevision: 'new-v1' } },
  });
  const fence = new AuthorityFence('legacy');
  fence.enterShadow();
  assert.equal(fence.cutoverToCore(edge, newCore.currentFullSnapshot(), 10).cutover, true);

  let legacyWrites = 0;
  let coreWrites = 0;
  assert.deepEqual(fence.attemptWrite('legacy', () => {
    legacyWrites += 1;
    return 'legacy-write';
  }), {
    written: false,
    mode: 'core',
    side: 'legacy',
    code: 'side_not_authoritative',
  });
  assert.deepEqual(fence.attemptWrite('core', () => {
    coreWrites += 1;
    return 'core-write';
  }), {
    written: true,
    mode: 'core',
    side: 'core',
    value: 'core-write',
  });

  fence.enterRollbackPending();
  assert.deepEqual(fence.snapshot(), {
    mode: 'rollback_pending',
    writableSide: null,
    legacyWritable: false,
    coreWritable: false,
    dualWrite: false,
  });

  for (const side of ['legacy', 'core'] as const) {
    const result = fence.attemptWrite(side, () => {
      if (side === 'legacy') {
        legacyWrites += 1;
      } else {
        coreWrites += 1;
      }
      return 'must-not-run';
    });
    assert.deepEqual(result, {
      written: false,
      mode: 'rollback_pending',
      side,
      code: 'rollback_pending',
    });
  }

  assert.equal(legacyWrites, 0);
  assert.equal(coreWrites, 1);
});

test('reported snapshots are deterministic across input key and operation ordering', () => {
  const coreA = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: {
      scene: { zIndex: 3, layout: { rows: 2, columns: 4 } },
      display: { power: 'on', brightness: 80 },
      audio: { volume: 25, muted: false },
    },
  });
  const coreB = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: {
      audio: { muted: false, volume: 25 },
      display: { brightness: 80, power: 'on' },
      scene: { layout: { columns: 4, rows: 2 }, zIndex: 3 },
    },
  });
  assert.equal(coreA.currentFullSnapshot().digest, coreB.currentFullSnapshot().digest);

  const edgeA = new EdgeStateReplica(coreA.currentFullSnapshot(), 0);
  const edgeB = new EdgeStateReplica(coreB.currentFullSnapshot(), 0);

  assert.equal(reportApplied(
    edgeA,
    'scene',
    { layout: { columns: 4, rows: 2 }, zIndex: 3 },
    5,
    'renderer',
  ).accepted, true);
  assert.equal(reportApplied(
    edgeA,
    'display',
    { brightness: 80, power: 'on' },
    5,
    'hardware_adapter',
  ).accepted, true);

  assert.equal(reportApplied(
    edgeB,
    'display',
    { power: 'on', brightness: 80 },
    5,
    'hardware_adapter',
  ).accepted, true);
  assert.equal(reportApplied(
    edgeB,
    'scene',
    { zIndex: 3, layout: { rows: 2, columns: 4 } },
    5,
    'renderer',
  ).accepted, true);

  assert.equal(edgeA.activateLocalOverride({
    leaseId: 'deterministic-lease',
    source: 'local_admin',
    startsAtMs: 10,
    expiresAtMs: 30,
    allowedDomains: ['audio', 'display'],
    actualState: {
      audio: { muted: true, volume: 0 },
      display: { power: 'off', brightness: 0 },
    },
  }, 10).accepted, true);
  assert.equal(edgeB.activateLocalOverride({
    leaseId: 'deterministic-lease',
    source: 'local_admin',
    startsAtMs: 10,
    expiresAtMs: 30,
    allowedDomains: ['display', 'audio'],
    actualState: {
      display: { brightness: 0, power: 'off' },
      audio: { volume: 0, muted: true },
    },
  }, 10).accepted, true);

  const reportA = edgeA.reportedSnapshot(20);
  const reportB = edgeB.reportedSnapshot(20);
  assert.deepEqual(reportA, reportB);
  assert.equal(JSON.stringify(reportA), JSON.stringify(reportB));
  assert.deepEqual(edgeA.reportedSnapshot(20), reportA);
  assert.deepEqual(reportA.domains.map((entry) => entry.domain), STATE_DOMAINS);
  assert.deepEqual(reportA.localOverrides.leases[0]?.allowedDomains, ['display', 'audio']);
  assert.match(reportA.reportDigest, /^sha256:[a-f0-9]{64}$/);
});

test('a partial update can explicitly remove Core desire for one domain', () => {
  const core = new CoreDesiredAuthority({
    authorityEpoch: OLD_EPOCH,
    revision: 1,
    desired: { media: { sessionId: 'radio-1', state: 'playing' } },
  });
  const edge = new EdgeStateReplica(core.currentFullSnapshot(), 0);
  const clearMedia = core.publishPatch(2, { media: absent() });

  assert.equal(edge.acceptDesired(clearMedia, 10).accepted, true);
  const media = domainSnapshot(edge.reportedSnapshot(10), 'media');
  assert.equal(media.desired.status, 'absent');
  assert.equal(media.desired.revision, 2);
  assert.equal(media.application.status, 'not_requested');
});
