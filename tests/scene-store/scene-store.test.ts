import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryContentAddressedObjectStore,
  InMemorySceneDatabase,
  InjectedSceneStoreCrash,
  SceneStoreRuntime,
  sha256,
  utf8,
  type RendererPreloader,
  type SceneActivationFault,
  type SceneManifest,
  type SceneObjectDescriptor,
} from './scene-store-model.js';

interface AssetFixture {
  path: string;
  bytes: Uint8Array;
  descriptor: SceneObjectDescriptor;
}

function asset(path: string, contents: string): AssetFixture {
  const bytes = utf8(contents);
  return {
    path,
    bytes,
    descriptor: {
      path,
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
    },
  };
}

function sceneManifest(
  revisionId: string,
  assets: readonly AssetFixture[],
  sceneId = 'lobby-scene',
): SceneManifest {
  const entrypoint = assets[0];
  if (entrypoint === undefined) {
    throw new RangeError('test manifest needs at least one asset');
  }
  return {
    sceneId,
    revisionId,
    entrypoint: entrypoint.path,
    objects: assets.map((fixture) => fixture.descriptor),
  };
}

function harness(maxStagingBytes = 1_024): {
  database: InMemorySceneDatabase;
  objects: InMemoryContentAddressedObjectStore;
  runtime: SceneStoreRuntime;
} {
  const database = new InMemorySceneDatabase();
  const objects = new InMemoryContentAddressedObjectStore();
  return {
    database,
    objects,
    runtime: new SceneStoreRuntime(database, objects, { maxStagingBytes }),
  };
}

const acceptRenderer: RendererPreloader = () => ({ ok: true });

function stageRevision(
  runtime: SceneStoreRuntime,
  manifest: SceneManifest,
  assets: readonly AssetFixture[],
): void {
  const acquisition = runtime.acquireManifest(manifest, { authenticated: true });
  assert(acquisition.accepted, JSON.stringify(acquisition));

  const stagedDigests = new Set<string>();
  for (const fixture of assets) {
    if (stagedDigests.has(fixture.descriptor.sha256)) {
      continue;
    }
    stagedDigests.add(fixture.descriptor.sha256);
    const stored = runtime.stageObject(
      manifest.revisionId,
      fixture.descriptor.sha256,
      fixture.bytes,
    );
    assert(stored.ok, JSON.stringify(stored));
  }

  const ready = runtime.markReady(manifest.revisionId);
  assert(ready.ok, JSON.stringify(ready));
}

function activateRevision(
  runtime: SceneStoreRuntime,
  manifest: SceneManifest,
  assets: readonly AssetFixture[],
): void {
  stageRevision(runtime, manifest, assets);
  const preload = runtime.preloadRevision(manifest.revisionId, acceptRenderer);
  assert(preload.ok, JSON.stringify(preload));
  const activation = runtime.activate(manifest.revisionId);
  assert(activation.ok, JSON.stringify(activation));
}

function expectCrash(point: SceneActivationFault, action: () => void): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof InjectedSceneStoreCrash);
    assert.equal(error.point, point);
    return true;
  });
}

function pointers(runtime: SceneStoreRuntime): {
  current: string | null;
  previous: string | null;
} {
  const state = runtime.snapshot().database;
  return {
    current: state.currentRevisionId,
    previous: state.previousRevisionId,
  };
}

test('authenticated manifest acquisition is explicit and aggregate staging is bounded', () => {
  const { runtime } = harness(8);
  const fiveBytes = asset('index.html', '12345');
  const sharedPlusThree = [
    asset('shared.html', '12345'),
    asset('extra.css', 'xyz'),
  ];
  const fourBytes = asset('index.html', 'four');

  const untrusted = runtime.acquireManifest(
    sceneManifest('untrusted-revision', [asset('index.html', 'far-too-large')]),
    { authenticated: false },
  );
  assert.equal(untrusted.accepted, false);
  if (!untrusted.accepted) {
    assert.equal(untrusted.reason, 'untrusted_manifest');
  }
  assert.equal(runtime.snapshot().database.revisions.has('untrusted-revision'), false);

  const first = runtime.acquireManifest(
    sceneManifest('bounded-a', [fiveBytes]),
    { authenticated: true },
  );
  assert(first.accepted, JSON.stringify(first));
  assert.equal(first.stagedLogicalBytes, 5);

  const shared = runtime.acquireManifest(
    sceneManifest('bounded-shared', sharedPlusThree),
    { authenticated: true },
  );
  assert(shared.accepted, JSON.stringify(shared));
  assert.equal(shared.stagedLogicalBytes, 8, 'shared SHA-256 content is reserved once');

  const overLimit = runtime.acquireManifest(
    sceneManifest('bounded-overflow', [fourBytes]),
    { authenticated: true },
  );
  assert.equal(overLimit.accepted, false);
  if (!overLimit.accepted) {
    assert.equal(overLimit.reason, 'staging_limit_exceeded');
    assert.equal(overLimit.stagedLogicalBytes, 8);
  }
  assert.equal(runtime.snapshot().database.revisions.has('bounded-overflow'), false);

  const unexpected = runtime.stageObject(
    'bounded-a',
    sha256(utf8('not-declared')),
    utf8('not-declared'),
  );
  assert.equal(unexpected.ok, false);
  if (!unexpected.ok) {
    assert.equal(unexpected.reason, 'object_not_in_manifest');
  }

  assert.equal(runtime.abandonStage('bounded-a'), true);
  assert.equal(runtime.abandonStage('bounded-shared'), true);
  assert.equal(runtime.snapshot().stagedLogicalBytes, 0);
});

test('incomplete, corrupt, untrusted, and renderer-rejected scenes never replace active', () => {
  const { runtime, objects } = harness();
  const baselineAsset = asset('index.html', 'base');
  activateRevision(
    runtime,
    sceneManifest('baseline', [baselineAsset]),
    [baselineAsset],
  );
  assert.deepEqual(pointers(runtime), { current: 'baseline', previous: null });

  const untrustedAsset = asset('index.html', 'nope');
  const untrusted = runtime.acquireManifest(
    sceneManifest('untrusted-candidate', [untrustedAsset]),
    { authenticated: false },
  );
  assert.equal(untrusted.accepted, false);
  assert.deepEqual(pointers(runtime), { current: 'baseline', previous: null });

  const incompleteAssets = [
    asset('index.html', 'html'),
    asset('app.js', 'javascript'),
  ];
  const incompleteManifest = sceneManifest('incomplete-candidate', incompleteAssets);
  const incompleteAcquisition = runtime.acquireManifest(
    incompleteManifest,
    { authenticated: true },
  );
  assert(incompleteAcquisition.accepted, JSON.stringify(incompleteAcquisition));
  const firstObject = incompleteAssets[0];
  assert(firstObject);
  const firstStored = runtime.stageObject(
    incompleteManifest.revisionId,
    firstObject.descriptor.sha256,
    firstObject.bytes,
  );
  assert(firstStored.ok, JSON.stringify(firstStored));

  const incompleteReady = runtime.markReady(incompleteManifest.revisionId);
  assert.equal(incompleteReady.ok, false);
  if (!incompleteReady.ok && incompleteReady.reason === 'content_invalid') {
    assert.equal(incompleteReady.validation.reason, 'missing_object');
  }
  assert.equal(
    runtime.snapshot().database.revisions.get(incompleteManifest.revisionId)?.lifecycle,
    'staging',
  );
  assert.equal(
    runtime.preloadRevision(incompleteManifest.revisionId, acceptRenderer).ok,
    false,
  );
  assert.equal(runtime.activate(incompleteManifest.revisionId).ok, false);
  assert.deepEqual(pointers(runtime), { current: 'baseline', previous: null });

  const expectedAsset = asset('index.html', 'good');
  const corruptManifest = sceneManifest('corrupt-candidate', [expectedAsset]);
  const corruptAcquisition = runtime.acquireManifest(
    corruptManifest,
    { authenticated: true },
  );
  assert(corruptAcquisition.accepted, JSON.stringify(corruptAcquisition));

  const wrongSize = runtime.stageObject(
    corruptManifest.revisionId,
    expectedAsset.descriptor.sha256,
    utf8('x'),
  );
  assert.equal(wrongSize.ok, false);
  if (!wrongSize.ok) {
    assert.equal(wrongSize.reason, 'size_mismatch');
  }
  assert.equal(objects.has(expectedAsset.descriptor.sha256), false);

  const wrongHash = runtime.stageObject(
    corruptManifest.revisionId,
    expectedAsset.descriptor.sha256,
    utf8('evil'),
  );
  assert.equal(wrongHash.ok, false);
  if (!wrongHash.ok) {
    assert.equal(wrongHash.reason, 'hash_mismatch');
  }
  assert.equal(objects.has(expectedAsset.descriptor.sha256), false);

  const validStore = runtime.stageObject(
    corruptManifest.revisionId,
    expectedAsset.descriptor.sha256,
    expectedAsset.bytes,
  );
  assert(validStore.ok, JSON.stringify(validStore));
  const corruptReady = runtime.markReady(corruptManifest.revisionId);
  assert(corruptReady.ok, JSON.stringify(corruptReady));

  objects.overwriteForFault(expectedAsset.descriptor.sha256, utf8('EVIL'));
  let corruptRendererCalls = 0;
  const corruptPreload = runtime.preloadRevision(corruptManifest.revisionId, () => {
    corruptRendererCalls += 1;
    return { ok: true };
  });
  assert.equal(corruptPreload.ok, false);
  if (!corruptPreload.ok && corruptPreload.reason === 'content_invalid') {
    assert.equal(corruptPreload.validation.reason, 'hash_mismatch');
  }
  assert.equal(corruptRendererCalls, 0, 'invalid bytes never reach the renderer');
  assert.equal(
    runtime.snapshot().database.revisions.get(corruptManifest.revisionId)?.lifecycle,
    'staging',
  );
  assert.deepEqual(pointers(runtime), { current: 'baseline', previous: null });

  const renderAsset = asset('index.html', 'renderable');
  const renderManifest = sceneManifest('renderer-rejected', [renderAsset]);
  stageRevision(runtime, renderManifest, [renderAsset]);
  const rejected = runtime.preloadRevision(renderManifest.revisionId, () => ({
    ok: false,
    reason: 'WebKit parse/load failure fixture',
  }));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason, 'renderer_preload_failed');
  }
  const rejectedActivation = runtime.activate(renderManifest.revisionId);
  assert.equal(rejectedActivation.ok, false);
  if (!rejectedActivation.ok) {
    assert.equal(rejectedActivation.reason, 'renderer_not_preloaded');
  }

  assert.deepEqual(pointers(runtime), { current: 'baseline', previous: null });
  assert.equal(runtime.snapshot().activeRendererRevisionId, 'baseline');
});

test('renderer preload is process-local and activation is atomic across crash boundaries', () => {
  const { database, objects, runtime } = harness();
  const revisionAAsset = asset('index.html', 'rev-a');
  const revisionBAsset = asset('index.html', 'rev-b');
  const revisionAManifest = sceneManifest('revision-a', [revisionAAsset]);
  const revisionBManifest = sceneManifest('revision-b', [revisionBAsset]);

  activateRevision(runtime, revisionAManifest, [revisionAAsset]);
  stageRevision(runtime, revisionBManifest, [revisionBAsset]);

  const seenBundles: string[] = [];
  const preloadB = runtime.preloadRevision(revisionBManifest.revisionId, (bundle) => {
    seenBundles.push(bundle.revisionId);
    assert.equal(bundle.entrypoint, 'index.html');
    assert.equal(bundle.files.length, 1);
    return { ok: true };
  });
  assert(preloadB.ok, JSON.stringify(preloadB));

  expectCrash(
    'before_activation_commit',
    () => runtime.activate(revisionBManifest.revisionId, 'before_activation_commit'),
  );
  assert.deepEqual(pointers(runtime), { current: 'revision-a', previous: null });
  assert.equal(runtime.snapshot().activeRendererRevisionId, 'revision-a');

  const afterBeforeCrash = new SceneStoreRuntime(database, objects, { maxStagingBytes: 1_024 });
  assert.equal(afterBeforeCrash.snapshot().activeRendererRevisionId, null);
  const noInheritedPreload = afterBeforeCrash.activate(revisionBManifest.revisionId);
  assert.equal(noInheritedPreload.ok, false);
  if (!noInheritedPreload.ok) {
    assert.equal(noInheritedPreload.reason, 'renderer_not_preloaded');
  }
  const restoredA = afterBeforeCrash.restore(acceptRenderer);
  assert(restoredA.ok, JSON.stringify(restoredA));
  assert.equal(restoredA.status, 'restored_current');
  assert.equal(restoredA.revisionId, 'revision-a');

  const secondPreloadB = afterBeforeCrash.preloadRevision(
    revisionBManifest.revisionId,
    acceptRenderer,
  );
  assert(secondPreloadB.ok, JSON.stringify(secondPreloadB));
  expectCrash(
    'after_activation_commit',
    () => afterBeforeCrash.activate(revisionBManifest.revisionId, 'after_activation_commit'),
  );
  assert.deepEqual(pointers(afterBeforeCrash), {
    current: 'revision-b',
    previous: 'revision-a',
  });

  const afterAfterCrash = new SceneStoreRuntime(database, objects, { maxStagingBytes: 1_024 });
  assert.equal(afterAfterCrash.snapshot().activeRendererRevisionId, null);
  const restoredB = afterAfterCrash.restore(acceptRenderer);
  assert(restoredB.ok, JSON.stringify(restoredB));
  assert.equal(restoredB.status, 'restored_current');
  assert.equal(restoredB.revisionId, 'revision-b');
  assert.equal(afterAfterCrash.snapshot().activeRendererRevisionId, 'revision-b');
  assert.deepEqual(pointers(afterAfterCrash), {
    current: 'revision-b',
    previous: 'revision-a',
  });
  assert.deepEqual(seenBundles, ['revision-b']);
});

test('activation rejects a successful preload if referenced object generations change', () => {
  const { runtime, objects } = harness();
  const baselineAsset = asset('index.html', 'base');
  const candidateAsset = asset('index.html', 'next');
  activateRevision(runtime, sceneManifest('base', [baselineAsset]), [baselineAsset]);

  const candidateManifest = sceneManifest('stale-preload', [candidateAsset]);
  stageRevision(runtime, candidateManifest, [candidateAsset]);
  const preload = runtime.preloadRevision(candidateManifest.revisionId, acceptRenderer);
  assert(preload.ok, JSON.stringify(preload));

  objects.overwriteForFault(candidateAsset.descriptor.sha256, candidateAsset.bytes);
  const activation = runtime.activate(candidateManifest.revisionId);
  assert.equal(activation.ok, false);
  if (!activation.ok) {
    assert.equal(activation.reason, 'renderer_preload_stale');
  }
  assert.deepEqual(pointers(runtime), { current: 'base', previous: null });
  assert.equal(runtime.snapshot().activeRendererRevisionId, 'base');
});

test('the previous known-good revision can be preloaded and atomically rolled back', () => {
  const { runtime } = harness();
  const revisionAAsset = asset('index.html', 'aaaa');
  const revisionBAsset = asset('index.html', 'bbbb');
  activateRevision(runtime, sceneManifest('rollback-a', [revisionAAsset]), [revisionAAsset]);
  activateRevision(runtime, sceneManifest('rollback-b', [revisionBAsset]), [revisionBAsset]);

  assert.deepEqual(pointers(runtime), {
    current: 'rollback-b',
    previous: 'rollback-a',
  });

  const rejected = runtime.rollback(() => ({
    ok: false,
    reason: 'rollback preload failed',
  }));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason, 'renderer_preload_failed');
  }
  assert.deepEqual(pointers(runtime), {
    current: 'rollback-b',
    previous: 'rollback-a',
  });
  assert.equal(runtime.snapshot().activeRendererRevisionId, 'rollback-b');

  const rolledBack = runtime.rollback((bundle) => {
    assert.equal(bundle.revisionId, 'rollback-a');
    return { ok: true };
  });
  assert(rolledBack.ok, JSON.stringify(rolledBack));
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.revisionId, 'rollback-a');
  assert.deepEqual(pointers(runtime), {
    current: 'rollback-a',
    previous: 'rollback-b',
  });
  assert.equal(runtime.snapshot().activeRendererRevisionId, 'rollback-a');
});

test('restore validates DB references against missing/corrupt object bytes and fails safe', async (t) => {
  await t.test('missing current object restores the valid previous revision', () => {
    const { database, objects, runtime } = harness();
    const previousAsset = asset('index.html', 'prev');
    const currentAsset = asset('index.html', 'curr');
    activateRevision(runtime, sceneManifest('restore-previous', [previousAsset]), [previousAsset]);
    activateRevision(runtime, sceneManifest('restore-current', [currentAsset]), [currentAsset]);

    assert.equal(objects.deleteForFault(currentAsset.descriptor.sha256), true);
    const restarted = new SceneStoreRuntime(database, objects, { maxStagingBytes: 1_024 });
    const rendererCalls: string[] = [];
    const restore = restarted.restore((bundle) => {
      rendererCalls.push(bundle.revisionId);
      return { ok: true };
    });

    assert(restore.ok, JSON.stringify(restore));
    assert.equal(restore.status, 'restored_previous');
    assert.equal(restore.revisionId, 'restore-previous');
    assert.equal(restore.failures[0]?.reason, 'missing_object');
    assert.deepEqual(rendererCalls, ['restore-previous']);
    assert.deepEqual(pointers(restarted), {
      current: 'restore-previous',
      previous: null,
    });
    assert.equal(restarted.snapshot().activeRendererRevisionId, 'restore-previous');
  });

  await t.test('corrupt current plus missing previous yields no renderer activation', () => {
    const { database, objects, runtime } = harness();
    const previousAsset = asset('index.html', '1111');
    const currentAsset = asset('index.html', '2222');
    activateRevision(runtime, sceneManifest('broken-previous', [previousAsset]), [previousAsset]);
    activateRevision(runtime, sceneManifest('broken-current', [currentAsset]), [currentAsset]);

    objects.overwriteForFault(currentAsset.descriptor.sha256, utf8('xxxx'));
    assert.equal(objects.deleteForFault(previousAsset.descriptor.sha256), true);

    const restarted = new SceneStoreRuntime(database, objects, { maxStagingBytes: 1_024 });
    let rendererCalls = 0;
    const restore = restarted.restore(() => {
      rendererCalls += 1;
      return { ok: true };
    });

    assert.equal(restore.ok, false);
    assert.equal(restore.status, 'failed_closed');
    assert.equal(restore.revisionId, null);
    assert.deepEqual(
      restore.failures.map(({ role, reason }) => ({ role, reason })),
      [
        { role: 'current', reason: 'hash_mismatch' },
        { role: 'previous', reason: 'missing_object' },
      ],
    );
    assert.equal(rendererCalls, 0, 'missing/corrupt bytes are rejected before renderer preload');
    assert.equal(restarted.snapshot().activeRendererRevisionId, null);
    assert.deepEqual(pointers(restarted), {
      current: 'broken-current',
      previous: 'broken-previous',
    });
  });
});

test('content-addressed storage deduplicates identical bytes across revisions', () => {
  const { runtime, objects } = harness();
  const firstAsset = asset('first/index.html', 'shared-content');
  const secondAsset = asset('second/alias.html', 'shared-content');
  const firstManifest = sceneManifest('dedupe-a', [firstAsset]);
  const secondManifest = sceneManifest('dedupe-b', [secondAsset]);

  const firstAcquisition = runtime.acquireManifest(firstManifest, { authenticated: true });
  assert(firstAcquisition.accepted, JSON.stringify(firstAcquisition));
  const firstPut = runtime.stageObject(
    firstManifest.revisionId,
    firstAsset.descriptor.sha256,
    firstAsset.bytes,
  );
  assert(firstPut.ok, JSON.stringify(firstPut));
  assert.equal(firstPut.status, 'stored');
  assert.equal(firstPut.physicalBytesAdded, firstAsset.bytes.byteLength);
  assert.equal(objects.objectCount(), 1);

  const secondAcquisition = runtime.acquireManifest(secondManifest, { authenticated: true });
  assert(secondAcquisition.accepted, JSON.stringify(secondAcquisition));
  const secondPut = runtime.stageObject(
    secondManifest.revisionId,
    secondAsset.descriptor.sha256,
    secondAsset.bytes,
  );
  assert(secondPut.ok, JSON.stringify(secondPut));
  assert.equal(secondPut.status, 'deduplicated');
  assert.equal(secondPut.physicalBytesAdded, 0);
  assert.equal(objects.objectCount(), 1);
  assert.equal(objects.totalBytes(), firstAsset.bytes.byteLength);

  assert(runtime.markReady(firstManifest.revisionId).ok);
  assert(runtime.preloadRevision(firstManifest.revisionId, acceptRenderer).ok);
  assert(runtime.activate(firstManifest.revisionId).ok);
  assert(runtime.markReady(secondManifest.revisionId).ok);
  assert(runtime.preloadRevision(secondManifest.revisionId, acceptRenderer).ok);
  assert(runtime.activate(secondManifest.revisionId).ok);

  assert.deepEqual(pointers(runtime), { current: 'dedupe-b', previous: 'dedupe-a' });
  assert.equal(objects.objectCount(), 1);
});

test('LRU GC removes only unreachable objects and preserves staged/current/previous revisions', () => {
  const { runtime, objects } = harness();
  const previousAsset = asset('index.html', 'p001');
  const currentAsset = asset('index.html', 'p002');
  activateRevision(runtime, sceneManifest('gc-previous', [previousAsset]), [previousAsset]);
  activateRevision(runtime, sceneManifest('gc-current', [currentAsset]), [currentAsset]);

  const oldOrphan = asset('index.html', 'o001');
  const oldOrphanManifest = sceneManifest('gc-old-orphan', [oldOrphan]);
  const oldAcquisition = runtime.acquireManifest(oldOrphanManifest, { authenticated: true });
  assert(oldAcquisition.accepted, JSON.stringify(oldAcquisition));
  const oldPut = runtime.stageObject(
    oldOrphanManifest.revisionId,
    oldOrphan.descriptor.sha256,
    oldOrphan.bytes,
  );
  assert(oldPut.ok, JSON.stringify(oldPut));
  assert.equal(runtime.abandonStage(oldOrphanManifest.revisionId), true);

  const newerOrphan = asset('index.html', 'o002');
  const newerOrphanManifest = sceneManifest('gc-newer-orphan', [newerOrphan]);
  const newerAcquisition = runtime.acquireManifest(
    newerOrphanManifest,
    { authenticated: true },
  );
  assert(newerAcquisition.accepted, JSON.stringify(newerAcquisition));
  const newerPut = runtime.stageObject(
    newerOrphanManifest.revisionId,
    newerOrphan.descriptor.sha256,
    newerOrphan.bytes,
  );
  assert(newerPut.ok, JSON.stringify(newerPut));
  assert.equal(runtime.abandonStage(newerOrphanManifest.revisionId), true);

  // Reuse the older object after the newer insert so true LRU order differs
  // from insertion order. The bytes remain physically deduplicated.
  const touchOld = asset('alias.html', 'o001');
  const touchManifest = sceneManifest('gc-touch-old', [touchOld]);
  const touchAcquisition = runtime.acquireManifest(touchManifest, { authenticated: true });
  assert(touchAcquisition.accepted, JSON.stringify(touchAcquisition));
  const touchPut = runtime.stageObject(
    touchManifest.revisionId,
    touchOld.descriptor.sha256,
    touchOld.bytes,
  );
  assert(touchPut.ok, JSON.stringify(touchPut));
  assert.equal(touchPut.status, 'deduplicated');
  assert.equal(runtime.abandonStage(touchManifest.revisionId), true);

  const stagedDownloaded = asset('index.html', 's001');
  const stagedMissing = asset('future.js', 's002');
  const stagedManifest = sceneManifest(
    'gc-incomplete-stage',
    [stagedDownloaded, stagedMissing],
  );
  const stagedAcquisition = runtime.acquireManifest(stagedManifest, { authenticated: true });
  assert(stagedAcquisition.accepted, JSON.stringify(stagedAcquisition));
  const stagedPut = runtime.stageObject(
    stagedManifest.revisionId,
    stagedDownloaded.descriptor.sha256,
    stagedDownloaded.bytes,
  );
  assert(stagedPut.ok, JSON.stringify(stagedPut));
  const notReady = runtime.markReady(stagedManifest.revisionId);
  assert.equal(notReady.ok, false);

  const readyAsset = asset('index.html', 'r001');
  const readyManifest = sceneManifest('gc-ready-stage', [readyAsset]);
  stageRevision(runtime, readyManifest, [readyAsset]);

  assert.deepEqual(pointers(runtime), {
    current: 'gc-current',
    previous: 'gc-previous',
  });
  assert.equal(objects.objectCount(), 6);
  assert.equal(objects.totalBytes(), 24);

  const protectedDigests = new Set([
    previousAsset.descriptor.sha256,
    currentAsset.descriptor.sha256,
    stagedDownloaded.descriptor.sha256,
    stagedMissing.descriptor.sha256,
    readyAsset.descriptor.sha256,
  ]);

  const firstGc = runtime.collectGarbage(20);
  assert.deepEqual(firstGc.removedSha256, [newerOrphan.descriptor.sha256]);
  assert.equal(firstGc.quotaSatisfied, true);
  assert.equal(objects.has(newerOrphan.descriptor.sha256), false);
  assert.equal(objects.has(oldOrphan.descriptor.sha256), true);
  assert.deepEqual(
    firstGc.removedSha256.filter((digest) => protectedDigests.has(digest)),
    [],
  );
  assert.equal(
    firstGc.protectedSha256.includes(stagedMissing.descriptor.sha256),
    true,
    'even not-yet-downloaded objects remain logically protected by a live stage',
  );

  const secondGc = runtime.collectGarbage(0);
  assert.deepEqual(secondGc.removedSha256, [oldOrphan.descriptor.sha256]);
  assert.equal(secondGc.quotaSatisfied, false, 'protected bytes may keep the store over target');
  assert.equal(secondGc.bytesAfter, 16);

  for (const fixture of [previousAsset, currentAsset, stagedDownloaded, readyAsset]) {
    assert.equal(
      objects.has(fixture.descriptor.sha256),
      true,
      `GC removed protected object for ${fixture.descriptor.sha256}`,
    );
  }
  assert.equal(objects.has(stagedMissing.descriptor.sha256), false);
  assert.equal(
    secondGc.removedSha256.some((digest) => protectedDigests.has(digest)),
    false,
  );
  assert.deepEqual(pointers(runtime), {
    current: 'gc-current',
    previous: 'gc-previous',
  });
  assert.equal(
    runtime.snapshot().database.revisions.get(stagedManifest.revisionId)?.lifecycle,
    'staging',
  );
  assert.equal(
    runtime.snapshot().database.revisions.get(readyManifest.revisionId)?.lifecycle,
    'ready',
  );
});