export interface ProtocolRange {
  minimum: number;
  maximum: number;
}

export interface ProtocolPeer {
  supported: ProtocolRange;
  downgradeFloor: number;
  capabilities: readonly string[];
}

export interface EpochState {
  coreStreamEpoch: string;
  edgeStreamEpoch: string;
  authorityEpoch: string;
}

export interface NegotiationRequest {
  core: ProtocolPeer;
  edge: ProtocolPeer;
  persistedDeviceDowngradeFloor: number;
  requiredCapabilities?: readonly string[];
  currentEpochs: EpochState;
  resume?: EpochState;
}

export type RefusalCode =
  | 'malformed_core_range'
  | 'malformed_edge_range'
  | 'malformed_downgrade_floor'
  | 'malformed_capabilities'
  | 'malformed_epoch_state'
  | 'no_protocol_overlap'
  | 'downgrade_below_floor'
  | 'missing_required_capability';

export interface NegotiationRefusal {
  accepted: false;
  code: RefusalCode;
  detail: string;
}

export type ResumeDecision =
  | {
      accepted: true;
      reason: 'epochs_match';
      action: 'resume';
      mismatches: readonly [];
    }
  | {
      accepted: false;
      reason: 'fresh_session' | 'epoch_mismatch';
      action: 'full_resync';
      mismatches: readonly (keyof EpochState)[];
    };

export interface NegotiationAgreement {
  accepted: true;
  protocolVersion: number;
  effectiveDowngradeFloor: number;
  enabledCapabilities: readonly string[];
  resume: ResumeDecision;
}

export type NegotiationResult = NegotiationAgreement | NegotiationRefusal;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isVersion(value: number): boolean {
  // Zero is accepted by this test-only model so a synthetic previous version can
  // exercise N/N-1 negotiation. Device Protocol v1's production schema starts at 1.
  return Number.isSafeInteger(value) && value >= 0;
}

function isRangeValid(range: ProtocolRange): boolean {
  return isVersion(range.minimum) && isVersion(range.maximum) && range.minimum <= range.maximum;
}

function isCapabilityListValid(capabilities: readonly string[]): boolean {
  if (!Array.isArray(capabilities)) {
    return false;
  }

  const unique = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || capability.length === 0 || capability.trim() !== capability) {
      return false;
    }
    unique.add(capability);
  }

  return unique.size === capabilities.length;
}

function isEpochStateValid(epochs: EpochState): boolean {
  return (
    UUID_PATTERN.test(epochs.coreStreamEpoch) &&
    UUID_PATTERN.test(epochs.edgeStreamEpoch) &&
    UUID_PATTERN.test(epochs.authorityEpoch)
  );
}

function refuse(code: RefusalCode, detail: string): NegotiationRefusal {
  return { accepted: false, code, detail };
}

function decideResume(current: EpochState, resume: EpochState | undefined): ResumeDecision {
  if (resume === undefined) {
    return {
      accepted: false,
      reason: 'fresh_session',
      action: 'full_resync',
      mismatches: [],
    };
  }

  const mismatches = (Object.keys(current) as (keyof EpochState)[]).filter(
    (field) => current[field] !== resume[field],
  );

  if (mismatches.length === 0) {
    return {
      accepted: true,
      reason: 'epochs_match',
      action: 'resume',
      mismatches: [],
    };
  }

  return {
    accepted: false,
    reason: 'epoch_mismatch',
    action: 'full_resync',
    mismatches,
  };
}

/**
 * Executable model of the Phase 0 compatibility decision. It is deliberately
 * isolated under tests and is not a production protocol implementation.
 */
export function negotiate(request: NegotiationRequest): NegotiationResult {
  if (!isRangeValid(request.core.supported)) {
    return refuse('malformed_core_range', 'Core protocol range must be an ordered pair of non-negative integers.');
  }

  if (!isRangeValid(request.edge.supported)) {
    return refuse('malformed_edge_range', 'Edge protocol range must be an ordered pair of non-negative integers.');
  }

  const floors = [
    request.core.downgradeFloor,
    request.edge.downgradeFloor,
    request.persistedDeviceDowngradeFloor,
  ];
  if (!floors.every(isVersion)) {
    return refuse('malformed_downgrade_floor', 'Every downgrade floor must be a non-negative integer.');
  }

  const requiredCapabilities = request.requiredCapabilities ?? [];
  if (
    !isCapabilityListValid(request.core.capabilities) ||
    !isCapabilityListValid(request.edge.capabilities) ||
    !isCapabilityListValid(requiredCapabilities)
  ) {
    return refuse('malformed_capabilities', 'Capabilities must be unique, non-empty, trimmed strings.');
  }

  if (!isEpochStateValid(request.currentEpochs) || (request.resume !== undefined && !isEpochStateValid(request.resume))) {
    return refuse('malformed_epoch_state', 'Stream and authority epochs must be UUIDs.');
  }

  const overlapMinimum = Math.max(request.core.supported.minimum, request.edge.supported.minimum);
  const overlapMaximum = Math.min(request.core.supported.maximum, request.edge.supported.maximum);
  if (overlapMinimum > overlapMaximum) {
    return refuse('no_protocol_overlap', 'Core and Edge have no mutually supported protocol version.');
  }

  const effectiveDowngradeFloor = Math.max(...floors);
  if (overlapMaximum < effectiveDowngradeFloor) {
    return refuse(
      'downgrade_below_floor',
      `Highest mutually supported version ${overlapMaximum} is below downgrade floor ${effectiveDowngradeFloor}.`,
    );
  }

  const coreCapabilities = new Set(request.core.capabilities);
  const enabledCapabilities = [...new Set(request.edge.capabilities)]
    .filter((capability) => coreCapabilities.has(capability))
    .sort();
  const enabledCapabilitySet = new Set(enabledCapabilities);
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !enabledCapabilitySet.has(capability),
  );
  if (missingCapabilities.length > 0) {
    return refuse(
      'missing_required_capability',
      `Required capabilities are unavailable: ${missingCapabilities.join(', ')}.`,
    );
  }

  return {
    accepted: true,
    // Ranges are inclusive and contiguous; choosing the upper bound prevents a
    // silent downgrade when both peers support the current version.
    protocolVersion: overlapMaximum,
    effectiveDowngradeFloor,
    enabledCapabilities,
    resume: decideResume(request.currentEpochs, request.resume),
  };
}
