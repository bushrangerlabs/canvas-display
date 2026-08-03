import { createHash } from 'node:crypto';

export type RevisionLifecycle = 'staging' | 'ready' | 'known_good';

export interface SceneObjectDescriptor {
  path: string;
  sha256: string;
  byteSize: number;
}

export interface SceneManifest {
  sceneId: string;
  revisionId: string;
  entrypoint: string;
  objects: readonly SceneObjectDescriptor[];
}

export interface AuthenticatedManifestInput {
  /**
   * This flag is an input trust decision made by an authenticated acquisition
   * layer. The in-memory model deliberately does not implement signatures,
   * TLS, authorization, or replay protection.
   */
  authenticated: boolean;
}

export interface PersistedRevision {
  manifest: SceneManifest;
  manifestSha256: string;
  authenticated: true;
  lifecycle: RevisionLifecycle;
  createdOrder: number;
}

export interface SceneDatabaseState {
  revisions: Map<string, PersistedRevision>;
  currentRevisionId: string | null;
  previousRevisionId: string | null;
  nextRevisionOrder: number;
}

export interface SceneStoreOptions {
  /** Maximum distinct logical bytes reachable from all staging/ready revisions. */
  maxStagingBytes: number;
}

export interface RendererFile {
  path: string;
  sha256: string;
  byteSize: number;
  bytes: Uint8Array;
}

export interface RendererBundle {
  sceneId: string;
  revisionId: string;
  manifestSha256: string;
  entrypoint: string;
  files: readonly RendererFile[];
}

export type RendererPreloadDecision =
  | { ok: true }
  | { ok: false; reason: string };

export type RendererPreloader = (bundle: RendererBundle) => RendererPreloadDecision;

export type SceneActivationFault =
  | 'before_activation_commit'
  | 'after_activation_commit';

export class InjectedSceneStoreCrash extends Error {
  readonly point: SceneActivationFault;

  constructor(point: SceneActivationFault) {
    super(`injected scene-store crash at ${point}`);
    this.name = 'InjectedSceneStoreCrash';
    this.point = point;
  }
}

export class SceneStoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneStoreInvariantError';
  }
}

class ManifestValidationError extends Error {}
class StagingLimitError extends Error {}

export function utf8(value: string): Uint8Array {
  return Buffer.from(value, 'utf8');
}

export function sha256(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return createHash('sha256').update(bytes).digest('hex');
}

function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function checkedAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${name} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return result;
}

function validateLogicalPath(path: string, field: string): void {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new ManifestValidationError(`${field} must be a normalized relative path`);
  }
}

function normalizeManifest(input: SceneManifest): SceneManifest {
  if (typeof input.sceneId !== 'string' || input.sceneId.trim().length === 0) {
    throw new ManifestValidationError('sceneId must be a non-empty string');
  }
  if (typeof input.revisionId !== 'string' || input.revisionId.trim().length === 0) {
    throw new ManifestValidationError('revisionId must be a non-empty string');
  }
  if (typeof input.entrypoint !== 'string') {
    throw new ManifestValidationError('entrypoint must be a string');
  }
  validateLogicalPath(input.entrypoint, 'entrypoint');
  if (!Array.isArray(input.objects) || input.objects.length === 0) {
    throw new ManifestValidationError('manifest must contain at least one object');
  }

  const paths = new Set<string>();
  const sizesByDigest = new Map<string, number>();
  const objects = input.objects.map((descriptor, index): SceneObjectDescriptor => {
    if (typeof descriptor.path !== 'string') {
      throw new ManifestValidationError(`objects[${index}].path must be a string`);
    }
    validateLogicalPath(descriptor.path, `objects[${index}].path`);
    if (paths.has(descriptor.path)) {
      throw new ManifestValidationError(`duplicate object path: ${descriptor.path}`);
    }
    paths.add(descriptor.path);

    if (typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
      throw new ManifestValidationError(`objects[${index}].sha256 must be lowercase SHA-256 hex`);
    }
    assertSafeNonNegativeInteger(descriptor.byteSize, `objects[${index}].byteSize`);

    const priorSize = sizesByDigest.get(descriptor.sha256);
    if (priorSize !== undefined && priorSize !== descriptor.byteSize) {
      throw new ManifestValidationError(
        `digest ${descriptor.sha256} has conflicting declared sizes`,
      );
    }
    sizesByDigest.set(descriptor.sha256, descriptor.byteSize);

    return {
      path: descriptor.path,
      sha256: descriptor.sha256,
      byteSize: descriptor.byteSize,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  if (!paths.has(input.entrypoint)) {
    throw new ManifestValidationError('entrypoint must identify an object in the manifest');
  }

  return {
    sceneId: input.sceneId,
    revisionId: input.revisionId,
    entrypoint: input.entrypoint,
    objects,
  };
}

function digestManifest(manifest: SceneManifest): string {
  return sha256(JSON.stringify({
    sceneId: manifest.sceneId,
    revisionId: manifest.revisionId,
    entrypoint: manifest.entrypoint,
    objects: manifest.objects,
  }));
}

function isStaged(record: PersistedRevision): boolean {
  return record.lifecycle === 'staging' || record.lifecycle === 'ready';
}

function stagedLogicalBytes(state: SceneDatabaseState): number {
  const sizesByDigest = new Map<string, number>();

  for (const record of state.revisions.values()) {
    if (!isStaged(record)) {
      continue;
    }
    for (const descriptor of record.manifest.objects) {
      const priorSize = sizesByDigest.get(descriptor.sha256);
      if (priorSize !== undefined && priorSize !== descriptor.byteSize) {
        throw new SceneStoreInvariantError(
          `staged digest ${descriptor.sha256} has inconsistent sizes`,
        );
      }
      sizesByDigest.set(descriptor.sha256, descriptor.byteSize);
    }
  }

  let total = 0;
  for (const byteSize of sizesByDigest.values()) {
    total = checkedAdd(total, byteSize, 'staged logical bytes');
  }
  return total;
}

function assertKnownGoodPointer(
  state: SceneDatabaseState,
  revisionId: string | null,
  pointerName: string,
): void {
  if (revisionId === null) {
    return;
  }
  const revision = state.revisions.get(revisionId);
  if (revision === undefined || revision.lifecycle !== 'known_good' || !revision.authenticated) {
    throw new SceneStoreInvariantError(
      `${pointerName} must reference an authenticated known-good revision`,
    );
  }
}

function assertDatabaseInvariants(state: SceneDatabaseState): void {
  assertKnownGoodPointer(state, state.currentRevisionId, 'currentRevisionId');
  assertKnownGoodPointer(state, state.previousRevisionId, 'previousRevisionId');
  if (
    state.currentRevisionId !== null
    && state.currentRevisionId === state.previousRevisionId
  ) {
    throw new SceneStoreInvariantError('current and previous revisions must differ');
  }
}

/**
 * Copy-on-write metadata transactions stand in for a PostgreSQL transaction.
 * They do not model SQL, isolation levels, WAL, fsync, or cross-process locking.
 */
export class InMemorySceneDatabase {
  private state: SceneDatabaseState = {
    revisions: new Map(),
    currentRevisionId: null,
    previousRevisionId: null,
    nextRevisionOrder: 1,
  };

  transaction(mutator: (candidate: SceneDatabaseState) => void): void {
    const candidate = structuredClone(this.state);
    mutator(candidate);
    assertDatabaseInvariants(candidate);
    this.state = candidate;
  }

  snapshot(): SceneDatabaseState {
    return structuredClone(this.state);
  }
}

interface StoredObject {
  bytes: Uint8Array;
  lastAccess: number;
  generation: number;
}

export interface StoredObjectSnapshot {
  sha256: string;
  bytes: Uint8Array;
  byteSize: number;
  lastAccess: number;
  generation: number;
}

export type PutObjectResult =
  | {
    ok: true;
    status: 'stored' | 'deduplicated' | 'repaired';
    sha256: string;
    physicalBytesAdded: number;
  }
  | {
    ok: false;
    reason: 'size_mismatch';
    sha256: string;
    expectedByteSize: number;
    actualByteSize: number;
  }
  | {
    ok: false;
    reason: 'hash_mismatch';
    sha256: string;
    actualSha256: string;
  };

export interface GarbageCollectionResult {
  bytesBefore: number;
  bytesAfter: number;
  targetBytes: number;
  quotaSatisfied: boolean;
  removedSha256: readonly string[];
  protectedSha256: readonly string[];
}

/**
 * In-memory byte storage keyed by SHA-256. This is not a filesystem model: it
 * intentionally omits temp files, permissions, fsync, rename, and power loss.
 */
export class InMemoryContentAddressedObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  private accessClock = 0;
  private mutationGeneration = 0;

  private nextAccess(): number {
    this.accessClock += 1;
    return this.accessClock;
  }

  private nextGeneration(): number {
    this.mutationGeneration += 1;
    return this.mutationGeneration;
  }

  putVerified(expectedSha256: string, expectedByteSize: number, bytes: Uint8Array): PutObjectResult {
    const ownedBytes = copyBytes(bytes);
    if (ownedBytes.byteLength !== expectedByteSize) {
      return {
        ok: false,
        reason: 'size_mismatch',
        sha256: expectedSha256,
        expectedByteSize,
        actualByteSize: ownedBytes.byteLength,
      };
    }

    const actualSha256 = sha256(ownedBytes);
    if (actualSha256 !== expectedSha256) {
      return {
        ok: false,
        reason: 'hash_mismatch',
        sha256: expectedSha256,
        actualSha256,
      };
    }

    const existing = this.objects.get(expectedSha256);
    if (existing !== undefined) {
      const existingIsValid = existing.bytes.byteLength === expectedByteSize
        && sha256(existing.bytes) === expectedSha256;
      if (existingIsValid) {
        existing.lastAccess = this.nextAccess();
        return {
          ok: true,
          status: 'deduplicated',
          sha256: expectedSha256,
          physicalBytesAdded: 0,
        };
      }

      const oldByteSize = existing.bytes.byteLength;
      this.objects.set(expectedSha256, {
        bytes: ownedBytes,
        lastAccess: this.nextAccess(),
        generation: this.nextGeneration(),
      });
      return {
        ok: true,
        status: 'repaired',
        sha256: expectedSha256,
        physicalBytesAdded: expectedByteSize - oldByteSize,
      };
    }

    this.objects.set(expectedSha256, {
      bytes: ownedBytes,
      lastAccess: this.nextAccess(),
      generation: this.nextGeneration(),
    });
    return {
      ok: true,
      status: 'stored',
      sha256: expectedSha256,
      physicalBytesAdded: expectedByteSize,
    };
  }

  read(sha: string): StoredObjectSnapshot | null {
    const object = this.objects.get(sha);
    if (object === undefined) {
      return null;
    }
    object.lastAccess = this.nextAccess();
    return {
      sha256: sha,
      bytes: copyBytes(object.bytes),
      byteSize: object.bytes.byteLength,
      lastAccess: object.lastAccess,
      generation: object.generation,
    };
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  objectCount(): number {
    return this.objects.size;
  }

  totalBytes(): number {
    let total = 0;
    for (const object of this.objects.values()) {
      total = checkedAdd(total, object.bytes.byteLength, 'object store bytes');
    }
    return total;
  }

  metadata(): readonly Omit<StoredObjectSnapshot, 'bytes'>[] {
    return [...this.objects.entries()]
      .map(([objectSha256, object]) => ({
        sha256: objectSha256,
        byteSize: object.bytes.byteLength,
        lastAccess: object.lastAccess,
        generation: object.generation,
      }))
      .sort((left, right) => left.sha256.localeCompare(right.sha256));
  }

  /** Fault-injection hook representing bytes changed outside metadata control. */
  overwriteForFault(sha: string, bytes: Uint8Array): void {
    if (!this.objects.has(sha)) {
      throw new RangeError(`cannot corrupt missing object ${sha}`);
    }
    this.objects.set(sha, {
      bytes: copyBytes(bytes),
      lastAccess: this.nextAccess(),
      generation: this.nextGeneration(),
    });
  }

  /** Fault-injection hook representing an object missing while DB rows remain. */
  deleteForFault(sha: string): boolean {
    const deleted = this.objects.delete(sha);
    if (deleted) {
      this.nextGeneration();
    }
    return deleted;
  }

  collectGarbage(
    targetBytes: number,
    protectedObjects: ReadonlySet<string>,
  ): GarbageCollectionResult {
    assertSafeNonNegativeInteger(targetBytes, 'targetBytes');
    const bytesBefore = this.totalBytes();
    let bytesAfter = bytesBefore;
    const removedSha256: string[] = [];

    const candidates = [...this.objects.entries()]
      .filter(([objectSha256]) => !protectedObjects.has(objectSha256))
      .sort(([leftSha256, left], [rightSha256, right]) => (
        left.lastAccess - right.lastAccess || leftSha256.localeCompare(rightSha256)
      ));

    for (const [objectSha256, object] of candidates) {
      if (bytesAfter <= targetBytes) {
        break;
      }
      this.objects.delete(objectSha256);
      this.nextGeneration();
      bytesAfter -= object.bytes.byteLength;
      removedSha256.push(objectSha256);
    }

    return {
      bytesBefore,
      bytesAfter,
      targetBytes,
      quotaSatisfied: bytesAfter <= targetBytes,
      removedSha256,
      protectedSha256: [...protectedObjects].sort(),
    };
  }
}

export type ContentValidationFailure =
  | {
    ok: false;
    reason: 'revision_not_found';
    revisionId: string;
  }
  | {
    ok: false;
    reason: 'missing_object';
    revisionId: string;
    path: string;
    sha256: string;
  }
  | {
    ok: false;
    reason: 'size_mismatch';
    revisionId: string;
    path: string;
    sha256: string;
    expectedByteSize: number;
    actualByteSize: number;
  }
  | {
    ok: false;
    reason: 'hash_mismatch';
    revisionId: string;
    path: string;
    sha256: string;
    actualSha256: string;
  };

export type ContentValidationResult =
  | { ok: true; revisionId: string; manifestSha256: string }
  | ContentValidationFailure;

interface ValidatedRevision {
  ok: true;
  record: PersistedRevision;
  bundle: RendererBundle;
  objectGenerationToken: string;
}

type InternalValidationResult = ValidatedRevision | ContentValidationFailure;

export type ManifestAcquisitionResult =
  | {
    accepted: true;
    status: 'staged' | 'already_present';
    revisionId: string;
    manifestSha256: string;
    stagedLogicalBytes: number;
  }
  | {
    accepted: false;
    reason: 'untrusted_manifest' | 'invalid_manifest' | 'revision_conflict' | 'staging_limit_exceeded';
    revisionId: string;
    detail: string;
    stagedLogicalBytes: number;
  };

export type StageObjectResult =
  | PutObjectResult
  | {
    ok: false;
    reason: 'revision_not_found' | 'revision_not_staging' | 'object_not_in_manifest';
    revisionId: string;
    sha256: string;
  };

export type ReadyResult =
  | { ok: true; status: 'ready'; revisionId: string }
  | {
    ok: false;
    reason: 'revision_not_found' | 'revision_not_staging';
    revisionId: string;
  }
  | {
    ok: false;
    reason: 'content_invalid';
    revisionId: string;
    validation: ContentValidationFailure;
  };

export type PreloadResult =
  | { ok: true; revisionId: string }
  | {
    ok: false;
    reason: 'revision_not_found' | 'revision_not_ready';
    revisionId: string;
  }
  | {
    ok: false;
    reason: 'content_invalid';
    revisionId: string;
    validation: ContentValidationFailure;
  }
  | {
    ok: false;
    reason: 'renderer_preload_failed';
    revisionId: string;
    detail: string;
  };

export type ActivationResult =
  | {
    ok: true;
    status: 'activated';
    revisionId: string;
    previousRevisionId: string | null;
  }
  | {
    ok: false;
    reason: 'revision_not_found' | 'revision_not_ready' | 'renderer_not_preloaded' | 'renderer_preload_stale';
    revisionId: string;
  }
  | {
    ok: false;
    reason: 'content_invalid';
    revisionId: string;
    validation: ContentValidationFailure;
  };

export type RollbackResult =
  | {
    ok: true;
    status: 'rolled_back';
    revisionId: string;
    previousRevisionId: string;
  }
  | {
    ok: false;
    reason: 'no_previous_revision' | 'revision_not_known_good';
    revisionId: string | null;
  }
  | {
    ok: false;
    reason: 'content_invalid';
    revisionId: string;
    validation: ContentValidationFailure;
  }
  | {
    ok: false;
    reason: 'renderer_preload_failed';
    revisionId: string;
    detail: string;
  };

export type RestoreFailureReason =
  | 'pointer_unset'
  | 'revision_not_found'
  | 'revision_not_known_good'
  | 'missing_object'
  | 'size_mismatch'
  | 'hash_mismatch'
  | 'renderer_preload_failed';

export interface RestoreFailure {
  role: 'current' | 'previous';
  revisionId: string | null;
  reason: RestoreFailureReason;
  detail?: string;
  sha256?: string;
}

export type RestoreResult =
  | {
    ok: true;
    status: 'restored_current' | 'restored_previous';
    revisionId: string;
    failures: readonly RestoreFailure[];
  }
  | {
    ok: false;
    status: 'failed_closed';
    revisionId: null;
    failures: readonly RestoreFailure[];
  };

export interface SceneStoreSnapshot {
  database: SceneDatabaseState;
  activeRendererRevisionId: string | null;
  stagedLogicalBytes: number;
  preloadedRevisionIds: readonly string[];
}

function crashIf(
  configured: SceneActivationFault | null,
  point: SceneActivationFault,
): void {
  if (configured === point) {
    throw new InjectedSceneStoreCrash(point);
  }
}

function rendererFailureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executable Phase 0 state-machine model. Durable-looking state is held by the
 * two injected in-memory stores; renderer preload tokens and the visible
 * renderer revision are process-local and disappear when a new runtime is made.
 */
export class SceneStoreRuntime {
  private readonly successfulPreloads = new Map<string, string>();
  private activeRendererRevisionId: string | null = null;

  constructor(
    readonly database: InMemorySceneDatabase,
    readonly objects: InMemoryContentAddressedObjectStore,
    readonly options: SceneStoreOptions,
  ) {
    assertSafeNonNegativeInteger(options.maxStagingBytes, 'maxStagingBytes');
  }

  snapshot(): SceneStoreSnapshot {
    const database = this.database.snapshot();
    return {
      database,
      activeRendererRevisionId: this.activeRendererRevisionId,
      stagedLogicalBytes: stagedLogicalBytes(database),
      preloadedRevisionIds: [...this.successfulPreloads.keys()].sort(),
    };
  }

  acquireManifest(
    input: SceneManifest,
    trust: AuthenticatedManifestInput,
  ): ManifestAcquisitionResult {
    const currentStagedBytes = stagedLogicalBytes(this.database.snapshot());
    if (trust.authenticated !== true) {
      return {
        accepted: false,
        reason: 'untrusted_manifest',
        revisionId: input.revisionId,
        detail: 'authenticated acquisition trust flag was false',
        stagedLogicalBytes: currentStagedBytes,
      };
    }

    let manifest: SceneManifest;
    try {
      manifest = normalizeManifest(input);
    } catch (error) {
      return {
        accepted: false,
        reason: 'invalid_manifest',
        revisionId: input.revisionId,
        detail: rendererFailureDetail(error),
        stagedLogicalBytes: currentStagedBytes,
      };
    }

    const manifestSha256 = digestManifest(manifest);
    const existing = this.database.snapshot().revisions.get(manifest.revisionId);
    if (existing !== undefined) {
      if (existing.manifestSha256 !== manifestSha256) {
        return {
          accepted: false,
          reason: 'revision_conflict',
          revisionId: manifest.revisionId,
          detail: 'revisionId is already bound to a different authenticated manifest',
          stagedLogicalBytes: currentStagedBytes,
        };
      }
      return {
        accepted: true,
        status: 'already_present',
        revisionId: manifest.revisionId,
        manifestSha256,
        stagedLogicalBytes: currentStagedBytes,
      };
    }

    let resultingStagedBytes = currentStagedBytes;
    try {
      this.database.transaction((candidate) => {
        const createdOrder = candidate.nextRevisionOrder;
        candidate.nextRevisionOrder += 1;
        candidate.revisions.set(manifest.revisionId, {
          manifest,
          manifestSha256,
          authenticated: true,
          lifecycle: 'staging',
          createdOrder,
        });
        resultingStagedBytes = stagedLogicalBytes(candidate);
        if (resultingStagedBytes > this.options.maxStagingBytes) {
          throw new StagingLimitError(
            `staging requires ${resultingStagedBytes} bytes; limit is ${this.options.maxStagingBytes}`,
          );
        }
      });
    } catch (error) {
      if (!(error instanceof StagingLimitError)) {
        throw error;
      }
      return {
        accepted: false,
        reason: 'staging_limit_exceeded',
        revisionId: manifest.revisionId,
        detail: error.message,
        stagedLogicalBytes: currentStagedBytes,
      };
    }

    return {
      accepted: true,
      status: 'staged',
      revisionId: manifest.revisionId,
      manifestSha256,
      stagedLogicalBytes: resultingStagedBytes,
    };
  }

  abandonStage(revisionId: string): boolean {
    const record = this.database.snapshot().revisions.get(revisionId);
    if (record === undefined || !isStaged(record)) {
      return false;
    }
    this.database.transaction((candidate) => {
      candidate.revisions.delete(revisionId);
    });
    this.successfulPreloads.delete(revisionId);
    return true;
  }

  stageObject(revisionId: string, objectSha256: string, bytes: Uint8Array): StageObjectResult {
    const record = this.database.snapshot().revisions.get(revisionId);
    if (record === undefined) {
      return {
        ok: false,
        reason: 'revision_not_found',
        revisionId,
        sha256: objectSha256,
      };
    }
    if (record.lifecycle !== 'staging') {
      return {
        ok: false,
        reason: 'revision_not_staging',
        revisionId,
        sha256: objectSha256,
      };
    }

    const descriptor = record.manifest.objects.find(
      (candidate) => candidate.sha256 === objectSha256,
    );
    if (descriptor === undefined) {
      return {
        ok: false,
        reason: 'object_not_in_manifest',
        revisionId,
        sha256: objectSha256,
      };
    }

    return this.objects.putVerified(descriptor.sha256, descriptor.byteSize, bytes);
  }

  validateRevision(revisionId: string): ContentValidationResult {
    const validation = this.loadValidatedRevision(revisionId);
    if (!validation.ok) {
      return validation;
    }
    return {
      ok: true,
      revisionId,
      manifestSha256: validation.record.manifestSha256,
    };
  }

  markReady(revisionId: string): ReadyResult {
    const record = this.database.snapshot().revisions.get(revisionId);
    if (record === undefined) {
      return { ok: false, reason: 'revision_not_found', revisionId };
    }
    if (record.lifecycle !== 'staging') {
      return { ok: false, reason: 'revision_not_staging', revisionId };
    }

    const validation = this.loadValidatedRevision(revisionId);
    if (!validation.ok) {
      return {
        ok: false,
        reason: 'content_invalid',
        revisionId,
        validation,
      };
    }

    this.database.transaction((candidate) => {
      const candidateRecord = candidate.revisions.get(revisionId);
      if (candidateRecord === undefined || candidateRecord.lifecycle !== 'staging') {
        throw new SceneStoreInvariantError('revision changed while becoming ready');
      }
      candidateRecord.lifecycle = 'ready';
    });
    this.successfulPreloads.delete(revisionId);
    return { ok: true, status: 'ready', revisionId };
  }

  preloadRevision(revisionId: string, preloader: RendererPreloader): PreloadResult {
    const record = this.database.snapshot().revisions.get(revisionId);
    if (record === undefined) {
      return { ok: false, reason: 'revision_not_found', revisionId };
    }
    if (record.lifecycle !== 'ready') {
      return { ok: false, reason: 'revision_not_ready', revisionId };
    }

    const validation = this.loadValidatedRevision(revisionId);
    if (!validation.ok) {
      this.returnReadyRevisionToStaging(revisionId);
      this.successfulPreloads.delete(revisionId);
      return {
        ok: false,
        reason: 'content_invalid',
        revisionId,
        validation,
      };
    }

    const rendererResult = this.invokeRendererPreloader(validation.bundle, preloader);
    if (!rendererResult.ok) {
      this.successfulPreloads.delete(revisionId);
      return {
        ok: false,
        reason: 'renderer_preload_failed',
        revisionId,
        detail: rendererResult.detail,
      };
    }

    this.successfulPreloads.set(revisionId, validation.objectGenerationToken);
    return { ok: true, revisionId };
  }

  activate(
    revisionId: string,
    fault: SceneActivationFault | null = null,
  ): ActivationResult {
    const record = this.database.snapshot().revisions.get(revisionId);
    if (record === undefined) {
      return { ok: false, reason: 'revision_not_found', revisionId };
    }
    if (record.lifecycle !== 'ready') {
      return { ok: false, reason: 'revision_not_ready', revisionId };
    }

    const validation = this.loadValidatedRevision(revisionId);
    if (!validation.ok) {
      this.returnReadyRevisionToStaging(revisionId);
      this.successfulPreloads.delete(revisionId);
      return {
        ok: false,
        reason: 'content_invalid',
        revisionId,
        validation,
      };
    }

    const preloadToken = this.successfulPreloads.get(revisionId);
    if (preloadToken === undefined) {
      return { ok: false, reason: 'renderer_not_preloaded', revisionId };
    }
    if (preloadToken !== validation.objectGenerationToken) {
      this.successfulPreloads.delete(revisionId);
      return { ok: false, reason: 'renderer_preload_stale', revisionId };
    }

    crashIf(fault, 'before_activation_commit');

    let previousRevisionId: string | null = null;
    this.database.transaction((candidate) => {
      const candidateRecord = candidate.revisions.get(revisionId);
      if (candidateRecord === undefined || candidateRecord.lifecycle !== 'ready') {
        throw new SceneStoreInvariantError('revision changed during activation');
      }
      previousRevisionId = candidate.currentRevisionId;
      candidateRecord.lifecycle = 'known_good';
      candidate.previousRevisionId = previousRevisionId;
      candidate.currentRevisionId = revisionId;
    });

    this.successfulPreloads.delete(revisionId);
    this.activeRendererRevisionId = revisionId;
    crashIf(fault, 'after_activation_commit');

    return {
      ok: true,
      status: 'activated',
      revisionId,
      previousRevisionId,
    };
  }

  rollback(preloader: RendererPreloader): RollbackResult {
    const before = this.database.snapshot();
    const targetRevisionId = before.previousRevisionId;
    if (targetRevisionId === null) {
      return { ok: false, reason: 'no_previous_revision', revisionId: null };
    }

    const target = before.revisions.get(targetRevisionId);
    if (target === undefined || target.lifecycle !== 'known_good') {
      return {
        ok: false,
        reason: 'revision_not_known_good',
        revisionId: targetRevisionId,
      };
    }

    const validation = this.loadValidatedRevision(targetRevisionId);
    if (!validation.ok) {
      return {
        ok: false,
        reason: 'content_invalid',
        revisionId: targetRevisionId,
        validation,
      };
    }

    const rendererResult = this.invokeRendererPreloader(validation.bundle, preloader);
    if (!rendererResult.ok) {
      return {
        ok: false,
        reason: 'renderer_preload_failed',
        revisionId: targetRevisionId,
        detail: rendererResult.detail,
      };
    }

    const oldCurrentRevisionId = before.currentRevisionId;
    if (oldCurrentRevisionId === null) {
      throw new SceneStoreInvariantError('previous revision exists without a current revision');
    }

    this.database.transaction((candidate) => {
      if (
        candidate.currentRevisionId !== oldCurrentRevisionId
        || candidate.previousRevisionId !== targetRevisionId
      ) {
        throw new SceneStoreInvariantError('revision pointers changed during rollback');
      }
      candidate.currentRevisionId = targetRevisionId;
      candidate.previousRevisionId = oldCurrentRevisionId;
    });
    this.activeRendererRevisionId = targetRevisionId;

    return {
      ok: true,
      status: 'rolled_back',
      revisionId: targetRevisionId,
      previousRevisionId: oldCurrentRevisionId,
    };
  }

  restore(preloader: RendererPreloader): RestoreResult {
    this.successfulPreloads.clear();
    const before = this.database.snapshot();
    const failures: RestoreFailure[] = [];

    const currentAttempt = this.tryRestoreCandidate(
      'current',
      before.currentRevisionId,
      preloader,
    );
    if (currentAttempt.ok) {
      this.activeRendererRevisionId = currentAttempt.revisionId;
      return {
        ok: true,
        status: 'restored_current',
        revisionId: currentAttempt.revisionId,
        failures,
      };
    }
    failures.push(currentAttempt.failure);

    const previousAttempt = this.tryRestoreCandidate(
      'previous',
      before.previousRevisionId,
      preloader,
    );
    if (previousAttempt.ok) {
      this.database.transaction((candidate) => {
        if (
          candidate.currentRevisionId !== before.currentRevisionId
          || candidate.previousRevisionId !== before.previousRevisionId
        ) {
          throw new SceneStoreInvariantError('revision pointers changed during restore');
        }
        candidate.currentRevisionId = previousAttempt.revisionId;
        candidate.previousRevisionId = null;
      });
      this.activeRendererRevisionId = previousAttempt.revisionId;
      return {
        ok: true,
        status: 'restored_previous',
        revisionId: previousAttempt.revisionId,
        failures,
      };
    }
    failures.push(previousAttempt.failure);

    this.activeRendererRevisionId = null;
    return {
      ok: false,
      status: 'failed_closed',
      revisionId: null,
      failures,
    };
  }

  collectGarbage(targetBytes: number): GarbageCollectionResult {
    const state = this.database.snapshot();
    const protectedObjects = new Set<string>();

    for (const record of state.revisions.values()) {
      if (isStaged(record)) {
        for (const descriptor of record.manifest.objects) {
          protectedObjects.add(descriptor.sha256);
        }
      }
    }

    for (const revisionId of [state.currentRevisionId, state.previousRevisionId]) {
      if (revisionId === null) {
        continue;
      }
      const record = state.revisions.get(revisionId);
      if (record === undefined) {
        throw new SceneStoreInvariantError(`protected revision ${revisionId} is missing`);
      }
      for (const descriptor of record.manifest.objects) {
        protectedObjects.add(descriptor.sha256);
      }
    }

    return this.objects.collectGarbage(targetBytes, protectedObjects);
  }

  private loadValidatedRevision(revisionId: string): InternalValidationResult {
    const record = this.database.snapshot().revisions.get(revisionId);
    if (record === undefined) {
      return { ok: false, reason: 'revision_not_found', revisionId };
    }

    const loaded = new Map<string, StoredObjectSnapshot>();
    for (const descriptor of record.manifest.objects) {
      let object = loaded.get(descriptor.sha256);
      if (object === undefined) {
        object = this.objects.read(descriptor.sha256) ?? undefined;
        if (object === undefined) {
          return {
            ok: false,
            reason: 'missing_object',
            revisionId,
            path: descriptor.path,
            sha256: descriptor.sha256,
          };
        }
        loaded.set(descriptor.sha256, object);
      }

      if (object.byteSize !== descriptor.byteSize) {
        return {
          ok: false,
          reason: 'size_mismatch',
          revisionId,
          path: descriptor.path,
          sha256: descriptor.sha256,
          expectedByteSize: descriptor.byteSize,
          actualByteSize: object.byteSize,
        };
      }
      const actualSha256 = sha256(object.bytes);
      if (actualSha256 !== descriptor.sha256) {
        return {
          ok: false,
          reason: 'hash_mismatch',
          revisionId,
          path: descriptor.path,
          sha256: descriptor.sha256,
          actualSha256,
        };
      }
    }

    const objectGenerationToken = sha256(JSON.stringify({
      manifestSha256: record.manifestSha256,
      objects: [...loaded.entries()]
        .map(([objectSha256, object]) => ({
          sha256: objectSha256,
          byteSize: object.byteSize,
          generation: object.generation,
        }))
        .sort((left, right) => left.sha256.localeCompare(right.sha256)),
    }));

    return {
      ok: true,
      record,
      objectGenerationToken,
      bundle: {
        sceneId: record.manifest.sceneId,
        revisionId,
        manifestSha256: record.manifestSha256,
        entrypoint: record.manifest.entrypoint,
        files: record.manifest.objects.map((descriptor) => {
          const object = loaded.get(descriptor.sha256);
          if (object === undefined) {
            throw new SceneStoreInvariantError('validated object disappeared from the loaded set');
          }
          return {
            ...descriptor,
            bytes: copyBytes(object.bytes),
          };
        }),
      },
    };
  }

  private returnReadyRevisionToStaging(revisionId: string): void {
    this.database.transaction((candidate) => {
      const record = candidate.revisions.get(revisionId);
      if (record !== undefined && record.lifecycle === 'ready') {
        record.lifecycle = 'staging';
      }
    });
  }

  private invokeRendererPreloader(
    bundle: RendererBundle,
    preloader: RendererPreloader,
  ): { ok: true } | { ok: false; detail: string } {
    try {
      const decision = preloader(structuredClone(bundle));
      if (decision.ok) {
        return { ok: true };
      }
      return {
        ok: false,
        detail: decision.reason || 'renderer rejected the staged revision',
      };
    } catch (error) {
      return {
        ok: false,
        detail: rendererFailureDetail(error),
      };
    }
  }

  private tryRestoreCandidate(
    role: 'current' | 'previous',
    revisionId: string | null,
    preloader: RendererPreloader,
  ):
    | { ok: true; revisionId: string }
    | { ok: false; failure: RestoreFailure } {
    if (revisionId === null) {
      return {
        ok: false,
        failure: { role, revisionId, reason: 'pointer_unset' },
      };
    }

    const record = this.database.snapshot().revisions.get(revisionId);
    if (record === undefined) {
      return {
        ok: false,
        failure: { role, revisionId, reason: 'revision_not_found' },
      };
    }
    if (record.lifecycle !== 'known_good') {
      return {
        ok: false,
        failure: { role, revisionId, reason: 'revision_not_known_good' },
      };
    }

    const validation = this.loadValidatedRevision(revisionId);
    if (!validation.ok) {
      return {
        ok: false,
        failure: {
          role,
          revisionId,
          reason: validation.reason,
          sha256: 'sha256' in validation ? validation.sha256 : undefined,
        },
      };
    }

    const rendererResult = this.invokeRendererPreloader(validation.bundle, preloader);
    if (!rendererResult.ok) {
      return {
        ok: false,
        failure: {
          role,
          revisionId,
          reason: 'renderer_preload_failed',
          detail: rendererResult.detail,
        },
      };
    }

    return { ok: true, revisionId };
  }
}
