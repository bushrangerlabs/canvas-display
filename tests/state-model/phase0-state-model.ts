import { createHash } from 'node:crypto';

export const STATE_DOMAINS = [
  'scene',
  'display',
  'audio',
  'media',
  'voice',
  'schedule',
  'update',
] as const;

export type StateDomain = (typeof STATE_DOMAINS)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class ModelInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelInvariantError';
  }
}

function normalizeJson(value: unknown, path = '$', seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ModelInvariantError(`${path} must contain only finite numbers`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== 'object') {
    throw new ModelInvariantError(`${path} is not JSON data`);
  }

  if (seen.has(value)) {
    throw new ModelInvariantError(`${path} contains a cycle`);
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`, seen));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ModelInvariantError(`${path} must be a plain JSON object`);
    }

    const normalized: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJson(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        seen,
      );
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function digestUnknown(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function digestJson(value: JsonValue): string {
  return digestUnknown(value);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ModelInvariantError(`${field} must be non-empty`);
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ModelInvariantError('revision must be a positive safe integer');
  }
}

function assertTimestamp(timestampMs: number, field = 'timestampMs'): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new ModelInvariantError(`${field} must be a non-negative safe integer`);
  }
}

const DOMAIN_SET = new Set<string>(STATE_DOMAINS);
const DOMAIN_INDEX = new Map<string, number>(
  STATE_DOMAINS.map((domain, index) => [domain, index]),
);

function assertDomainKeys(value: object): void {
  for (const key of Object.keys(value)) {
    if (!DOMAIN_SET.has(key)) {
      throw new ModelInvariantError(`unknown state domain: ${key}`);
    }
  }
}

function mapDomains<T>(mapper: (domain: StateDomain) => T): Record<StateDomain, T> {
  return Object.fromEntries(
    STATE_DOMAINS.map((domain) => [domain, mapper(domain)]),
  ) as Record<StateDomain, T>;
}

export interface DesiredValue {
  readonly status: 'desired';
  readonly state: JsonValue;
}

export interface DesiredAbsent {
  readonly status: 'absent';
}

export type DomainDesiredDirective = DesiredValue | DesiredAbsent;
export type DesiredPatchChanges = Partial<Record<StateDomain, DomainDesiredDirective>>;
export type InitialDesiredState = Partial<Record<StateDomain, JsonValue>>;
export type MaterializedDesiredState = Record<StateDomain, DomainDesiredDirective>;

export function desired(state: JsonValue): DesiredValue {
  return { status: 'desired', state: normalizeJson(state) };
}

export function absent(): DesiredAbsent {
  return { status: 'absent' };
}

function normalizeDirective(value: unknown): DomainDesiredDirective {
  if (typeof value !== 'object' || value === null) {
    throw new ModelInvariantError('desired domain directive must be an object');
  }

  const status = (value as { status?: unknown }).status;
  if (status === 'absent') {
    return absent();
  }
  if (status === 'desired' && Object.prototype.hasOwnProperty.call(value, 'state')) {
    return desired((value as { state: JsonValue }).state);
  }

  throw new ModelInvariantError('desired domain directive must be desired or absent');
}

function cloneDirective(value: DomainDesiredDirective): DomainDesiredDirective {
  return value.status === 'absent' ? absent() : desired(value.state);
}

function materializeInitial(input: InitialDesiredState = {}): MaterializedDesiredState {
  assertDomainKeys(input);
  return mapDomains((domain) => (
    Object.prototype.hasOwnProperty.call(input, domain)
      ? desired(input[domain] as JsonValue)
      : absent()
  ));
}

function normalizeMaterialized(input: MaterializedDesiredState): MaterializedDesiredState {
  assertDomainKeys(input);
  for (const domain of STATE_DOMAINS) {
    if (!Object.prototype.hasOwnProperty.call(input, domain)) {
      throw new ModelInvariantError(`full snapshot is missing domain: ${domain}`);
    }
  }
  return mapDomains((domain) => normalizeDirective(input[domain]));
}

function normalizePatch(input: DesiredPatchChanges): DesiredPatchChanges {
  assertDomainKeys(input);
  if (Object.keys(input).length === 0) {
    throw new ModelInvariantError('partial desired update must contain at least one domain');
  }

  const normalized: DesiredPatchChanges = {};
  for (const domain of STATE_DOMAINS) {
    if (Object.prototype.hasOwnProperty.call(input, domain)) {
      normalized[domain] = normalizeDirective(input[domain]);
    }
  }
  return normalized;
}

function applyPatch(
  current: MaterializedDesiredState,
  changes: DesiredPatchChanges,
): MaterializedDesiredState {
  const normalizedChanges = normalizePatch(changes);
  return mapDomains((domain) => (
    normalizedChanges[domain] === undefined
      ? cloneDirective(current[domain])
      : cloneDirective(normalizedChanges[domain])
  ));
}

export function digestDesiredState(state: MaterializedDesiredState): string {
  const normalized = normalizeMaterialized(state);
  return digestUnknown(STATE_DOMAINS.map((domain) => {
    const directive = normalized[domain];
    return directive.status === 'absent'
      ? { domain, status: directive.status }
      : { domain, status: directive.status, state: directive.state };
  }));
}

interface DesiredMessageBase {
  readonly type: 'state.desired';
  readonly authorityEpoch: string;
  readonly revision: number;
  readonly digest: string;
}

export interface FullDesiredSnapshot extends DesiredMessageBase {
  readonly snapshotKind: 'full';
  readonly baseRevision: null;
  readonly baseDigest: null;
  readonly domains: MaterializedDesiredState;
}

export interface PartialDesiredUpdate extends DesiredMessageBase {
  readonly snapshotKind: 'partial';
  readonly baseRevision: number;
  readonly baseDigest: string;
  readonly domains: DesiredPatchChanges;
}

export type DesiredMessage = FullDesiredSnapshot | PartialDesiredUpdate;

function fullMessage(
  authorityEpoch: string,
  revision: number,
  state: MaterializedDesiredState,
): FullDesiredSnapshot {
  const domains = normalizeMaterialized(state);
  return {
    type: 'state.desired',
    authorityEpoch,
    revision,
    digest: digestDesiredState(domains),
    snapshotKind: 'full',
    baseRevision: null,
    baseDigest: null,
    domains,
  };
}

export interface CoreDesiredAuthorityOptions {
  readonly authorityEpoch: string;
  readonly revision: number;
  readonly desired?: InitialDesiredState;
}

/**
 * Pure Core-side publisher. It holds exactly one active authority epoch and one
 * materialized desired state. Revisions are strictly monotonic within an epoch.
 */
export class CoreDesiredAuthority {
  private authorityEpoch: string;
  private revision: number;
  private digest: string;
  private materialized: MaterializedDesiredState;
  private readonly usedEpochs = new Set<string>();

  constructor(options: CoreDesiredAuthorityOptions) {
    assertNonEmpty(options.authorityEpoch, 'authorityEpoch');
    assertRevision(options.revision);

    this.authorityEpoch = options.authorityEpoch;
    this.revision = options.revision;
    this.materialized = materializeInitial(options.desired);
    this.digest = digestDesiredState(this.materialized);
    this.usedEpochs.add(options.authorityEpoch);
  }

  currentFullSnapshot(): FullDesiredSnapshot {
    return structuredClone(fullMessage(this.authorityEpoch, this.revision, this.materialized));
  }

  publishPatch(revision: number, changes: DesiredPatchChanges): PartialDesiredUpdate {
    assertRevision(revision);
    if (revision <= this.revision) {
      throw new ModelInvariantError(
        `Core revision ${revision} is not greater than current revision ${this.revision}`,
      );
    }

    const normalizedChanges = normalizePatch(changes);
    const previousRevision = this.revision;
    const previousDigest = this.digest;
    const next = applyPatch(this.materialized, normalizedChanges);
    const nextDigest = digestDesiredState(next);

    this.revision = revision;
    this.digest = nextDigest;
    this.materialized = next;

    return structuredClone({
      type: 'state.desired',
      authorityEpoch: this.authorityEpoch,
      revision,
      digest: nextDigest,
      snapshotKind: 'partial',
      baseRevision: previousRevision,
      baseDigest: previousDigest,
      domains: normalizedChanges,
    });
  }

  publishFull(revision: number, desiredState: InitialDesiredState): FullDesiredSnapshot {
    assertRevision(revision);
    if (revision <= this.revision) {
      throw new ModelInvariantError(
        `Core revision ${revision} is not greater than current revision ${this.revision}`,
      );
    }

    this.revision = revision;
    this.materialized = materializeInitial(desiredState);
    this.digest = digestDesiredState(this.materialized);
    return this.currentFullSnapshot();
  }

  cutover(options: CoreDesiredAuthorityOptions): FullDesiredSnapshot {
    assertNonEmpty(options.authorityEpoch, 'authorityEpoch');
    assertRevision(options.revision);
    if (this.usedEpochs.has(options.authorityEpoch)) {
      throw new ModelInvariantError(`authority epoch has already been used: ${options.authorityEpoch}`);
    }

    this.usedEpochs.add(options.authorityEpoch);
    this.authorityEpoch = options.authorityEpoch;
    this.revision = options.revision;
    this.materialized = materializeInitial(options.desired);
    this.digest = digestDesiredState(this.materialized);
    return this.currentFullSnapshot();
  }
}

export type DivergenceReason =
  | {
      readonly code: 'constraint_clamped';
      readonly constraint: string;
      readonly requested: JsonValue;
      readonly actual: JsonValue;
    }
  | {
      readonly code: 'unsupported';
      readonly capability: string;
    }
  | {
      readonly code: 'observed_state_mismatch';
      readonly expectedDigest: string;
      readonly actualDigest: string;
    };

export type ApplicationFailureReason =
  | {
      readonly code: 'dependency_unavailable';
      readonly dependency: string;
      readonly retryable: boolean;
    }
  | {
      readonly code: 'adapter_error';
      readonly adapter: string;
      readonly retryable: boolean;
      readonly detail: string;
    };

export type LocalOverrideSource = 'physical_control' | 'local_admin' | 'safety_policy';

export interface LocalOverrideReason {
  readonly code: 'local_override_active';
  readonly leaseId: string;
  readonly source: LocalOverrideSource;
  readonly expiresAtMs: number;
}

export type DomainApplicationReason =
  | DivergenceReason
  | ApplicationFailureReason
  | LocalOverrideReason;

interface ApplicationStatusBase {
  readonly targetRevision: number | null;
  readonly targetDigest: string | null;
  readonly lastAppliedRevision: number | null;
  readonly lastAppliedDigest: string | null;
  readonly evaluatedAtMs: number | null;
}

export type DomainApplicationReport =
  | (ApplicationStatusBase & { readonly status: 'not_requested'; readonly reason: null })
  | (ApplicationStatusBase & { readonly status: 'pending'; readonly reason: null })
  | (ApplicationStatusBase & { readonly status: 'applied'; readonly reason: null })
  | (ApplicationStatusBase & { readonly status: 'diverged'; readonly reason: DivergenceReason })
  | (ApplicationStatusBase & { readonly status: 'failed'; readonly reason: ApplicationFailureReason })
  | (ApplicationStatusBase & { readonly status: 'overridden'; readonly reason: LocalOverrideReason });

export type DomainDesiredReport =
  | {
      readonly status: 'desired';
      readonly revision: number;
      readonly digest: string;
      readonly state: JsonValue;
      readonly acceptedAtMs: number;
    }
  | {
      readonly status: 'absent';
      readonly revision: number;
      readonly digest: null;
      readonly state: null;
      readonly acceptedAtMs: number;
    };

export type DomainObservedReport =
  | {
      readonly status: 'unknown';
      readonly state: null;
      readonly digest: null;
      readonly observedAtMs: null;
      readonly source: null;
    }
  | {
      readonly status: 'observed';
      readonly state: JsonValue;
      readonly digest: string;
      readonly observedAtMs: number;
      readonly source: EdgeObservationSource | 'local_override';
    };

interface DomainRuntimeState {
  desired: DomainDesiredReport;
  application: DomainApplicationReport;
  observed: DomainObservedReport;
}

export type EdgeObservationSource =
  | 'agent'
  | 'renderer'
  | 'hardware_adapter'
  | 'media_adapter'
  | 'voice_adapter'
  | 'update_adapter';

export type EdgeApplicationOutcome =
  | {
      readonly status: 'applied';
      readonly actualState: JsonValue;
    }
  | {
      readonly status: 'diverged';
      readonly actualState: JsonValue;
      readonly reason: DivergenceReason;
    }
  | {
      readonly status: 'failed';
      readonly actualState?: JsonValue;
      readonly reason: ApplicationFailureReason;
    };

export interface EdgeApplicationInput {
  readonly authorityEpoch: string;
  readonly domain: StateDomain;
  readonly desiredRevision: number;
  readonly desiredDigest: string;
  readonly source: EdgeObservationSource;
  readonly outcome: EdgeApplicationOutcome;
}

export interface EdgeObservationInput {
  readonly domain: StateDomain;
  readonly source: EdgeObservationSource;
  readonly actualState: JsonValue;
}

export interface LocalOverrideLease {
  readonly leaseId: string;
  readonly source: LocalOverrideSource;
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  readonly allowedDomains: readonly StateDomain[];
  readonly actualState: Partial<Record<StateDomain, JsonValue>>;
}

export interface ReportedLocalOverrideLease extends LocalOverrideLease {
  readonly status: 'active' | 'expired' | 'superseded';
  readonly endedAtMs: number | null;
  readonly supersededByLeaseId: string | null;
}

interface MutableLocalOverrideLease {
  leaseId: string;
  source: LocalOverrideSource;
  startsAtMs: number;
  expiresAtMs: number;
  allowedDomains: StateDomain[];
  actualState: Partial<Record<StateDomain, JsonValue>>;
  status: 'active' | 'expired' | 'superseded';
  endedAtMs: number | null;
  supersededByLeaseId: string | null;
}

export type DesiredAcceptanceCode =
  | 'stale_authority_epoch'
  | 'unexpected_authority_epoch'
  | 'stale_revision'
  | 'revision_digest_conflict'
  | 'base_revision_conflict'
  | 'base_digest_conflict'
  | 'invalid_state_digest'
  | 'cutover_requires_full_snapshot'
  | 'cutover_epoch_not_new';

export type DesiredAcceptance =
  | {
      readonly accepted: true;
      readonly status: 'accepted' | 'duplicate' | 'cutover';
      readonly authorityEpoch: string;
      readonly revision: number;
      readonly digest: string;
    }
  | {
      readonly accepted: false;
      readonly code: DesiredAcceptanceCode;
      readonly activeAuthorityEpoch: string;
      readonly activeRevision: number;
      readonly incomingAuthorityEpoch: string;
      readonly incomingRevision: number;
    };

export type ApplicationAcceptanceCode =
  | 'stale_authority_epoch'
  | 'unexpected_authority_epoch'
  | 'domain_not_desired'
  | 'stale_desired_revision'
  | 'future_desired_revision'
  | 'desired_digest_conflict'
  | 'local_override_active'
  | 'applied_state_mismatch'
  | 'divergence_not_observed';

export type ApplicationAcceptance =
  | { readonly accepted: true; readonly status: 'recorded' }
  | { readonly accepted: false; readonly code: ApplicationAcceptanceCode };

export type LocalOverrideAcceptance =
  | {
      readonly accepted: true;
      readonly status: 'activated' | 'superseded';
      readonly activeLeaseId: string;
      readonly supersededLeaseId: string | null;
    }
  | {
      readonly accepted: false;
      readonly code: 'duplicate_lease' | 'lease_not_started' | 'lease_expired' | 'lease_not_newer';
    };

export type EffectiveTarget =
  | {
      readonly authority: 'core';
      readonly domain: StateDomain;
      readonly authorityEpoch: string;
      readonly revision: number;
      readonly digest: string;
      readonly state: JsonValue;
    }
  | {
      readonly authority: 'local_override';
      readonly domain: StateDomain;
      readonly leaseId: string;
      readonly source: LocalOverrideSource;
      readonly startsAtMs: number;
      readonly expiresAtMs: number;
      readonly digest: string;
      readonly state: JsonValue;
    }
  | {
      readonly authority: 'none';
      readonly domain: StateDomain;
    };

export interface ReportedDomainSnapshot {
  readonly domain: StateDomain;
  readonly desired: DomainDesiredReport;
  readonly application: DomainApplicationReport;
  readonly observed: DomainObservedReport;
}

export interface ReportedSnapshotBody {
  readonly schema: 'phase0-state-convergence/v1';
  readonly reportedAtMs: number;
  readonly authority: {
    readonly epoch: string;
    readonly acceptedRevision: number;
    readonly desiredDigest: string;
    readonly acceptedAtMs: number;
    readonly retiredEpochs: readonly string[];
  };
  readonly domains: readonly ReportedDomainSnapshot[];
  readonly localOverrides: {
    readonly activeLeaseId: string | null;
    readonly leases: readonly ReportedLocalOverrideLease[];
  };
}

export interface ReportedSnapshot extends ReportedSnapshotBody {
  readonly reportDigest: string;
}

function desiredReport(
  directive: DomainDesiredDirective,
  revision: number,
  acceptedAtMs: number,
): DomainDesiredReport {
  if (directive.status === 'absent') {
    return {
      status: 'absent',
      revision,
      digest: null,
      state: null,
      acceptedAtMs,
    };
  }

  const state = normalizeJson(directive.state);
  return {
    status: 'desired',
    revision,
    digest: digestUnknown(state),
    state,
    acceptedAtMs,
  };
}

function previousApplication(application: DomainApplicationReport): {
  lastAppliedRevision: number | null;
  lastAppliedDigest: string | null;
} {
  return {
    lastAppliedRevision: application.lastAppliedRevision,
    lastAppliedDigest: application.lastAppliedDigest,
  };
}

function baselineApplication(
  desiredState: DomainDesiredReport,
  previous: { lastAppliedRevision: number | null; lastAppliedDigest: string | null },
): DomainApplicationReport {
  if (desiredState.status === 'absent') {
    return {
      status: 'not_requested',
      targetRevision: null,
      targetDigest: null,
      ...previous,
      evaluatedAtMs: null,
      reason: null,
    };
  }

  return {
    status: 'pending',
    targetRevision: desiredState.revision,
    targetDigest: desiredState.digest,
    ...previous,
    evaluatedAtMs: null,
    reason: null,
  };
}

function overriddenApplication(
  desiredState: DomainDesiredReport,
  previous: { lastAppliedRevision: number | null; lastAppliedDigest: string | null },
  lease: MutableLocalOverrideLease,
  evaluatedAtMs: number,
): DomainApplicationReport {
  return {
    status: 'overridden',
    targetRevision: desiredState.status === 'desired' ? desiredState.revision : null,
    targetDigest: desiredState.status === 'desired' ? desiredState.digest : null,
    ...previous,
    evaluatedAtMs,
    reason: {
      code: 'local_override_active',
      leaseId: lease.leaseId,
      source: lease.source,
      expiresAtMs: lease.expiresAtMs,
    },
  };
}

function unknownObservation(): DomainObservedReport {
  return {
    status: 'unknown',
    state: null,
    digest: null,
    observedAtMs: null,
    source: null,
  };
}

function observedState(
  state: JsonValue,
  observedAtMs: number,
  source: EdgeObservationSource | 'local_override',
): Extract<DomainObservedReport, { status: 'observed' }> {
  const normalized = normalizeJson(state);
  return {
    status: 'observed',
    state: normalized,
    digest: digestUnknown(normalized),
    observedAtMs,
    source,
  };
}

function normalizeDivergenceReason(reason: DivergenceReason): DivergenceReason {
  switch (reason.code) {
    case 'constraint_clamped':
      assertNonEmpty(reason.constraint, 'constraint');
      return {
        code: reason.code,
        constraint: reason.constraint,
        requested: normalizeJson(reason.requested),
        actual: normalizeJson(reason.actual),
      };
    case 'unsupported':
      assertNonEmpty(reason.capability, 'capability');
      return { code: reason.code, capability: reason.capability };
    case 'observed_state_mismatch':
      assertNonEmpty(reason.expectedDigest, 'expectedDigest');
      assertNonEmpty(reason.actualDigest, 'actualDigest');
      return {
        code: reason.code,
        expectedDigest: reason.expectedDigest,
        actualDigest: reason.actualDigest,
      };
  }
}

function normalizeFailureReason(reason: ApplicationFailureReason): ApplicationFailureReason {
  switch (reason.code) {
    case 'dependency_unavailable':
      assertNonEmpty(reason.dependency, 'dependency');
      return {
        code: reason.code,
        dependency: reason.dependency,
        retryable: reason.retryable,
      };
    case 'adapter_error':
      assertNonEmpty(reason.adapter, 'adapter');
      assertNonEmpty(reason.detail, 'detail');
      return {
        code: reason.code,
        adapter: reason.adapter,
        retryable: reason.retryable,
        detail: reason.detail,
      };
  }
}

function normalizeLease(lease: LocalOverrideLease): MutableLocalOverrideLease {
  assertNonEmpty(lease.leaseId, 'leaseId');
  assertTimestamp(lease.startsAtMs, 'startsAtMs');
  assertTimestamp(lease.expiresAtMs, 'expiresAtMs');
  if (lease.expiresAtMs <= lease.startsAtMs) {
    throw new ModelInvariantError('lease expiry must be after its start');
  }
  if (lease.allowedDomains.length === 0) {
    throw new ModelInvariantError('lease must allow at least one domain');
  }

  const uniqueDomains = new Set<StateDomain>();
  for (const domain of lease.allowedDomains) {
    if (!DOMAIN_SET.has(domain)) {
      throw new ModelInvariantError(`unknown state domain: ${domain}`);
    }
    if (uniqueDomains.has(domain)) {
      throw new ModelInvariantError(`lease repeats allowed domain: ${domain}`);
    }
    uniqueDomains.add(domain);
  }

  assertDomainKeys(lease.actualState);
  const actualKeys = Object.keys(lease.actualState);
  if (actualKeys.length !== uniqueDomains.size) {
    throw new ModelInvariantError('lease actual state must contain exactly its allowed domains');
  }

  const allowedDomains = [...uniqueDomains].sort(
    (left, right) => (DOMAIN_INDEX.get(left) ?? 0) - (DOMAIN_INDEX.get(right) ?? 0),
  );
  const actualState: Partial<Record<StateDomain, JsonValue>> = {};
  for (const domain of allowedDomains) {
    if (!Object.prototype.hasOwnProperty.call(lease.actualState, domain)) {
      throw new ModelInvariantError(`lease is missing actual state for domain: ${domain}`);
    }
    actualState[domain] = normalizeJson(lease.actualState[domain]);
  }

  return {
    leaseId: lease.leaseId,
    source: lease.source,
    startsAtMs: lease.startsAtMs,
    expiresAtMs: lease.expiresAtMs,
    allowedDomains,
    actualState,
    status: 'active',
    endedAtMs: null,
    supersededByLeaseId: null,
  };
}

/**
 * Pure Edge reducer. Desired acceptance and application/observation reporting
 * are deliberately separate so Core intent can never manufacture Edge truth.
 */
export class EdgeStateReplica {
  private logicalTimeMs: number;
  private authorityEpoch: string;
  private acceptedRevision: number;
  private acceptedDigest: string;
  private acceptedAtMs: number;
  private readonly retiredEpochs = new Set<string>();
  private readonly domains: Record<StateDomain, DomainRuntimeState>;
  private readonly leases: MutableLocalOverrideLease[] = [];
  private activeLeaseId: string | null = null;

  constructor(snapshot: FullDesiredSnapshot, acceptedAtMs = 0) {
    assertTimestamp(acceptedAtMs, 'acceptedAtMs');
    assertNonEmpty(snapshot.authorityEpoch, 'authorityEpoch');
    assertRevision(snapshot.revision);

    const materialized = normalizeMaterialized(snapshot.domains);
    const computedDigest = digestDesiredState(materialized);
    if (computedDigest !== snapshot.digest) {
      throw new ModelInvariantError('bootstrap full snapshot has an invalid desired digest');
    }

    this.logicalTimeMs = acceptedAtMs;
    this.authorityEpoch = snapshot.authorityEpoch;
    this.acceptedRevision = snapshot.revision;
    this.acceptedDigest = computedDigest;
    this.acceptedAtMs = acceptedAtMs;
    this.domains = mapDomains((domain) => {
      const domainDesired = desiredReport(materialized[domain], snapshot.revision, acceptedAtMs);
      return {
        desired: domainDesired,
        application: baselineApplication(domainDesired, {
          lastAppliedRevision: null,
          lastAppliedDigest: null,
        }),
        observed: unknownObservation(),
      };
    });
  }

  private rejectDesired(message: DesiredMessage, code: DesiredAcceptanceCode): DesiredAcceptance {
    return {
      accepted: false,
      code,
      activeAuthorityEpoch: this.authorityEpoch,
      activeRevision: this.acceptedRevision,
      incomingAuthorityEpoch: message.authorityEpoch,
      incomingRevision: message.revision,
    };
  }

  private activeLease(): MutableLocalOverrideLease | null {
    if (this.activeLeaseId === null) {
      return null;
    }
    const lease = this.leases.find((candidate) => candidate.leaseId === this.activeLeaseId);
    if (lease === undefined || lease.status !== 'active') {
      throw new ModelInvariantError('active lease index is inconsistent');
    }
    return lease;
  }

  private releaseLeaseApplications(leaseId: string): void {
    for (const domain of STATE_DOMAINS) {
      const state = this.domains[domain];
      if (state.application.status !== 'overridden' || state.application.reason.leaseId !== leaseId) {
        continue;
      }
      state.application = baselineApplication(
        state.desired,
        previousApplication(state.application),
      );
    }
  }

  private advanceTime(timestampMs: number): void {
    assertTimestamp(timestampMs);
    if (timestampMs < this.logicalTimeMs) {
      throw new ModelInvariantError(
        `model time cannot move backward from ${this.logicalTimeMs} to ${timestampMs}`,
      );
    }
    this.logicalTimeMs = timestampMs;

    const lease = this.activeLease();
    if (lease !== null && timestampMs >= lease.expiresAtMs) {
      lease.status = 'expired';
      lease.endedAtMs = lease.expiresAtMs;
      this.activeLeaseId = null;
      this.releaseLeaseApplications(lease.leaseId);
    }
  }

  private currentMaterialized(): MaterializedDesiredState {
    return mapDomains((domain) => {
      const current = this.domains[domain].desired;
      return current.status === 'absent' ? absent() : desired(current.state);
    });
  }

  private setDesiredDomain(
    domain: StateDomain,
    directive: DomainDesiredDirective,
    revision: number,
    acceptedAtMs: number,
    resetApplicationHistory: boolean,
  ): void {
    const state = this.domains[domain];
    const nextDesired = desiredReport(directive, revision, acceptedAtMs);
    const previous = resetApplicationHistory
      ? { lastAppliedRevision: null, lastAppliedDigest: null }
      : previousApplication(state.application);
    const lease = this.activeLease();

    state.desired = nextDesired;
    state.application = lease !== null && lease.allowedDomains.includes(domain)
      ? overriddenApplication(nextDesired, previous, lease, acceptedAtMs)
      : baselineApplication(nextDesired, previous);
  }

  acceptDesired(message: DesiredMessage, acceptedAtMs: number): DesiredAcceptance {
    this.advanceTime(acceptedAtMs);
    assertNonEmpty(message.authorityEpoch, 'authorityEpoch');
    assertRevision(message.revision);

    if (this.retiredEpochs.has(message.authorityEpoch)) {
      return this.rejectDesired(message, 'stale_authority_epoch');
    }
    if (message.authorityEpoch !== this.authorityEpoch) {
      return this.rejectDesired(message, 'unexpected_authority_epoch');
    }
    if (message.revision < this.acceptedRevision) {
      return this.rejectDesired(message, 'stale_revision');
    }
    if (message.revision === this.acceptedRevision) {
      if (message.digest !== this.acceptedDigest) {
        return this.rejectDesired(message, 'revision_digest_conflict');
      }
      return {
        accepted: true,
        status: 'duplicate',
        authorityEpoch: this.authorityEpoch,
        revision: this.acceptedRevision,
        digest: this.acceptedDigest,
      };
    }

    let materialized: MaterializedDesiredState;
    let changedDomains: readonly StateDomain[];
    if (message.snapshotKind === 'full') {
      materialized = normalizeMaterialized(message.domains);
      changedDomains = STATE_DOMAINS;
    } else {
      if (message.baseRevision !== this.acceptedRevision) {
        return this.rejectDesired(message, 'base_revision_conflict');
      }
      if (message.baseDigest !== this.acceptedDigest) {
        return this.rejectDesired(message, 'base_digest_conflict');
      }
      const normalizedPatch = normalizePatch(message.domains);
      materialized = applyPatch(this.currentMaterialized(), normalizedPatch);
      changedDomains = STATE_DOMAINS.filter((domain) => normalizedPatch[domain] !== undefined);
    }

    const computedDigest = digestDesiredState(materialized);
    if (computedDigest !== message.digest) {
      return this.rejectDesired(message, 'invalid_state_digest');
    }

    this.acceptedRevision = message.revision;
    this.acceptedDigest = computedDigest;
    this.acceptedAtMs = acceptedAtMs;
    for (const domain of changedDomains) {
      this.setDesiredDomain(domain, materialized[domain], message.revision, acceptedAtMs, false);
    }

    return {
      accepted: true,
      status: 'accepted',
      authorityEpoch: this.authorityEpoch,
      revision: this.acceptedRevision,
      digest: this.acceptedDigest,
    };
  }

  acceptAuthorityCutover(message: DesiredMessage, acceptedAtMs: number): DesiredAcceptance {
    this.advanceTime(acceptedAtMs);
    assertNonEmpty(message.authorityEpoch, 'authorityEpoch');
    assertRevision(message.revision);

    if (message.snapshotKind !== 'full') {
      return this.rejectDesired(message, 'cutover_requires_full_snapshot');
    }
    if (message.authorityEpoch === this.authorityEpoch) {
      return this.rejectDesired(message, 'cutover_epoch_not_new');
    }
    if (this.retiredEpochs.has(message.authorityEpoch)) {
      return this.rejectDesired(message, 'stale_authority_epoch');
    }

    const materialized = normalizeMaterialized(message.domains);
    const computedDigest = digestDesiredState(materialized);
    if (computedDigest !== message.digest) {
      return this.rejectDesired(message, 'invalid_state_digest');
    }

    this.retiredEpochs.add(this.authorityEpoch);
    this.authorityEpoch = message.authorityEpoch;
    this.acceptedRevision = message.revision;
    this.acceptedDigest = computedDigest;
    this.acceptedAtMs = acceptedAtMs;
    for (const domain of STATE_DOMAINS) {
      this.setDesiredDomain(domain, materialized[domain], message.revision, acceptedAtMs, true);
    }

    return {
      accepted: true,
      status: 'cutover',
      authorityEpoch: this.authorityEpoch,
      revision: this.acceptedRevision,
      digest: this.acceptedDigest,
    };
  }

  reportApplication(input: EdgeApplicationInput, observedAtMs: number): ApplicationAcceptance {
    this.advanceTime(observedAtMs);

    if (this.retiredEpochs.has(input.authorityEpoch)) {
      return { accepted: false, code: 'stale_authority_epoch' };
    }
    if (input.authorityEpoch !== this.authorityEpoch) {
      return { accepted: false, code: 'unexpected_authority_epoch' };
    }

    const state = this.domains[input.domain];
    if (state.desired.status !== 'desired') {
      return { accepted: false, code: 'domain_not_desired' };
    }
    if (input.desiredRevision < state.desired.revision) {
      return { accepted: false, code: 'stale_desired_revision' };
    }
    if (input.desiredRevision > state.desired.revision) {
      return { accepted: false, code: 'future_desired_revision' };
    }
    if (input.desiredDigest !== state.desired.digest) {
      return { accepted: false, code: 'desired_digest_conflict' };
    }

    const lease = this.activeLease();
    if (lease !== null && lease.allowedDomains.includes(input.domain)) {
      return { accepted: false, code: 'local_override_active' };
    }

    const previous = previousApplication(state.application);
    switch (input.outcome.status) {
      case 'applied': {
        const actual = normalizeJson(input.outcome.actualState);
        const actualDigest = digestUnknown(actual);
        if (actualDigest !== state.desired.digest) {
          return { accepted: false, code: 'applied_state_mismatch' };
        }
        state.observed = observedState(actual, observedAtMs, input.source);
        state.application = {
          status: 'applied',
          targetRevision: state.desired.revision,
          targetDigest: state.desired.digest,
          lastAppliedRevision: state.desired.revision,
          lastAppliedDigest: state.desired.digest,
          evaluatedAtMs: observedAtMs,
          reason: null,
        };
        break;
      }
      case 'diverged': {
        const actual = normalizeJson(input.outcome.actualState);
        const actualDigest = digestUnknown(actual);
        if (actualDigest === state.desired.digest) {
          return { accepted: false, code: 'divergence_not_observed' };
        }
        state.observed = observedState(actual, observedAtMs, input.source);
        state.application = {
          status: 'diverged',
          targetRevision: state.desired.revision,
          targetDigest: state.desired.digest,
          ...previous,
          evaluatedAtMs: observedAtMs,
          reason: normalizeDivergenceReason(input.outcome.reason),
        };
        break;
      }
      case 'failed': {
        if (input.outcome.actualState !== undefined) {
          state.observed = observedState(input.outcome.actualState, observedAtMs, input.source);
        }
        state.application = {
          status: 'failed',
          targetRevision: state.desired.revision,
          targetDigest: state.desired.digest,
          ...previous,
          evaluatedAtMs: observedAtMs,
          reason: normalizeFailureReason(input.outcome.reason),
        };
        break;
      }
    }

    return { accepted: true, status: 'recorded' };
  }

  recordObservation(input: EdgeObservationInput, observedAtMs: number): void {
    this.advanceTime(observedAtMs);
    const state = this.domains[input.domain];
    state.observed = observedState(input.actualState, observedAtMs, input.source);

    if (
      state.desired.status === 'desired'
      && state.application.status === 'applied'
      && state.observed.digest !== state.desired.digest
    ) {
      state.application = {
        status: 'diverged',
        targetRevision: state.desired.revision,
        targetDigest: state.desired.digest,
        ...previousApplication(state.application),
        evaluatedAtMs: observedAtMs,
        reason: {
          code: 'observed_state_mismatch',
          expectedDigest: state.desired.digest,
          actualDigest: state.observed.digest,
        },
      };
    }
  }

  activateLocalOverride(
    input: LocalOverrideLease,
    activatedAtMs: number,
  ): LocalOverrideAcceptance {
    this.advanceTime(activatedAtMs);
    const lease = normalizeLease(input);

    if (this.leases.some((candidate) => candidate.leaseId === lease.leaseId)) {
      return { accepted: false, code: 'duplicate_lease' };
    }
    if (lease.startsAtMs > activatedAtMs) {
      return { accepted: false, code: 'lease_not_started' };
    }
    if (lease.expiresAtMs <= activatedAtMs) {
      return { accepted: false, code: 'lease_expired' };
    }

    const previousLease = this.activeLease();
    if (previousLease !== null && lease.startsAtMs <= previousLease.startsAtMs) {
      return { accepted: false, code: 'lease_not_newer' };
    }

    let supersededLeaseId: string | null = null;
    if (previousLease !== null) {
      supersededLeaseId = previousLease.leaseId;
      previousLease.status = 'superseded';
      previousLease.endedAtMs = activatedAtMs;
      previousLease.supersededByLeaseId = lease.leaseId;
      this.activeLeaseId = null;
      this.releaseLeaseApplications(previousLease.leaseId);
    }

    this.leases.push(lease);
    this.activeLeaseId = lease.leaseId;
    for (const domain of lease.allowedDomains) {
      const state = this.domains[domain];
      state.application = overriddenApplication(
        state.desired,
        previousApplication(state.application),
        lease,
        activatedAtMs,
      );
      state.observed = observedState(
        lease.actualState[domain] as JsonValue,
        activatedAtMs,
        'local_override',
      );
    }

    return {
      accepted: true,
      status: supersededLeaseId === null ? 'activated' : 'superseded',
      activeLeaseId: lease.leaseId,
      supersededLeaseId,
    };
  }

  effectiveTarget(domain: StateDomain, atMs: number): EffectiveTarget {
    this.advanceTime(atMs);
    const lease = this.activeLease();
    if (lease !== null && lease.allowedDomains.includes(domain)) {
      const state = normalizeJson(lease.actualState[domain]);
      return {
        authority: 'local_override',
        domain,
        leaseId: lease.leaseId,
        source: lease.source,
        startsAtMs: lease.startsAtMs,
        expiresAtMs: lease.expiresAtMs,
        digest: digestUnknown(state),
        state,
      };
    }

    const desiredState = this.domains[domain].desired;
    if (desiredState.status === 'desired') {
      return {
        authority: 'core',
        domain,
        authorityEpoch: this.authorityEpoch,
        revision: desiredState.revision,
        digest: desiredState.digest,
        state: structuredClone(desiredState.state),
      };
    }

    return { authority: 'none', domain };
  }

  reportedSnapshot(reportedAtMs: number): ReportedSnapshot {
    this.advanceTime(reportedAtMs);
    const leases = [...this.leases]
      .sort((left, right) => (
        left.startsAtMs - right.startsAtMs || left.leaseId.localeCompare(right.leaseId)
      ))
      .map((lease): ReportedLocalOverrideLease => structuredClone(lease));

    const body: ReportedSnapshotBody = {
      schema: 'phase0-state-convergence/v1',
      reportedAtMs,
      authority: {
        epoch: this.authorityEpoch,
        acceptedRevision: this.acceptedRevision,
        desiredDigest: this.acceptedDigest,
        acceptedAtMs: this.acceptedAtMs,
        retiredEpochs: [...this.retiredEpochs].sort(),
      },
      domains: STATE_DOMAINS.map((domain) => ({
        domain,
        desired: structuredClone(this.domains[domain].desired),
        application: structuredClone(this.domains[domain].application),
        observed: structuredClone(this.domains[domain].observed),
      })),
      localOverrides: {
        activeLeaseId: this.activeLeaseId,
        leases,
      },
    };

    const normalizedBody = normalizeJson(body) as unknown as ReportedSnapshotBody;
    return {
      ...normalizedBody,
      reportDigest: digestUnknown(normalizedBody),
    };
  }
}

export const AUTHORITY_MODES = ['legacy', 'shadow', 'core', 'rollback_pending'] as const;
export type AuthorityMode = (typeof AUTHORITY_MODES)[number];
export type AuthoritySide = 'legacy' | 'core';

export function parseAuthorityMode(value: string): AuthorityMode {
  if ((AUTHORITY_MODES as readonly string[]).includes(value)) {
    return value as AuthorityMode;
  }
  throw new ModelInvariantError(`unsupported authority mode: ${value}`);
}

export function writableAuthority(mode: AuthorityMode): AuthoritySide | null {
  switch (mode) {
    case 'legacy':
    case 'shadow':
      return 'legacy';
    case 'core':
      return 'core';
    case 'rollback_pending':
      return null;
  }
}

export type WriteDecision =
  | { readonly allowed: true; readonly mode: AuthorityMode; readonly side: AuthoritySide }
  | {
      readonly allowed: false;
      readonly mode: AuthorityMode;
      readonly side: AuthoritySide;
      readonly code: 'side_not_authoritative' | 'rollback_pending';
    };

export type FencedWriteResult<T> =
  | {
      readonly written: true;
      readonly mode: AuthorityMode;
      readonly side: AuthoritySide;
      readonly value: T;
    }
  | {
      readonly written: false;
      readonly mode: AuthorityMode;
      readonly side: AuthoritySide;
      readonly code: 'side_not_authoritative' | 'rollback_pending';
    };

export type AuthorityCutoverResult =
  | {
      readonly cutover: true;
      readonly mode: 'core';
      readonly edgeResult: Extract<DesiredAcceptance, { accepted: true }>;
    }
  | {
      readonly cutover: false;
      readonly mode: AuthorityMode;
      readonly code:
        | 'cutover_requires_shadow'
        | 'cutover_requires_full_snapshot'
        | 'edge_rejected';
      readonly edgeResult?: Extract<DesiredAcceptance, { accepted: false }>;
    };

/**
 * Synchronous migration fence. There is intentionally no dual-write state and
 * rollback_pending has no transition back to a writable side in this model.
 */
export class AuthorityFence {
  private modeValue: AuthorityMode;

  constructor(initialMode: AuthorityMode = 'legacy') {
    this.modeValue = parseAuthorityMode(initialMode);
  }

  get mode(): AuthorityMode {
    return this.modeValue;
  }

  checkWrite(side: AuthoritySide): WriteDecision {
    const writable = writableAuthority(this.modeValue);
    if (writable === side) {
      return { allowed: true, mode: this.modeValue, side };
    }
    return {
      allowed: false,
      mode: this.modeValue,
      side,
      code: this.modeValue === 'rollback_pending'
        ? 'rollback_pending'
        : 'side_not_authoritative',
    };
  }

  attemptWrite<T>(side: AuthoritySide, operation: () => T): FencedWriteResult<T> {
    const decision = this.checkWrite(side);
    if (!decision.allowed) {
      return {
        written: false,
        mode: decision.mode,
        side: decision.side,
        code: decision.code,
      };
    }
    return {
      written: true,
      mode: decision.mode,
      side: decision.side,
      value: operation(),
    };
  }

  enterShadow(): void {
    if (this.modeValue !== 'legacy') {
      throw new ModelInvariantError(`cannot enter shadow from ${this.modeValue}`);
    }
    this.modeValue = 'shadow';
  }

  cutoverToCore(
    edge: EdgeStateReplica,
    snapshot: DesiredMessage,
    acceptedAtMs: number,
  ): AuthorityCutoverResult {
    if (this.modeValue !== 'shadow') {
      return {
        cutover: false,
        mode: this.modeValue,
        code: 'cutover_requires_shadow',
      };
    }
    if (snapshot.snapshotKind !== 'full') {
      return {
        cutover: false,
        mode: this.modeValue,
        code: 'cutover_requires_full_snapshot',
      };
    }

    const edgeResult = edge.acceptAuthorityCutover(snapshot, acceptedAtMs);
    if (!edgeResult.accepted) {
      return {
        cutover: false,
        mode: this.modeValue,
        code: 'edge_rejected',
        edgeResult,
      };
    }

    this.modeValue = 'core';
    return { cutover: true, mode: 'core', edgeResult };
  }

  enterRollbackPending(): void {
    if (this.modeValue !== 'core') {
      throw new ModelInvariantError(`cannot enter rollback_pending from ${this.modeValue}`);
    }
    this.modeValue = 'rollback_pending';
  }

  snapshot(): {
    readonly mode: AuthorityMode;
    readonly writableSide: AuthoritySide | null;
    readonly legacyWritable: boolean;
    readonly coreWritable: boolean;
    readonly dualWrite: false;
  } {
    const writableSide = writableAuthority(this.modeValue);
    return {
      mode: this.modeValue,
      writableSide,
      legacyWritable: writableSide === 'legacy',
      coreWritable: writableSide === 'core',
      dualWrite: false,
    };
  }
}
