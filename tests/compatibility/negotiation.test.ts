import assert from 'node:assert/strict';
import test from 'node:test';
import {
  negotiate,
  type EpochState,
  type NegotiationAgreement,
  type NegotiationRequest,
  type NegotiationResult,
  type ProtocolRange,
} from './negotiation-model.js';

const CURRENT_V1 = 1;
// Test fixture only. There is no Device Protocol v0 production contract.
const SYNTHETIC_PREVIOUS_V0 = 0;
const BASELINE_CAPABILITY = 'control.baseline-v1';

const LIVE_EPOCHS: EpochState = {
  coreStreamEpoch: '0190efff-0000-7000-8000-000000000010',
  edgeStreamEpoch: '0190efff-0000-7000-8000-000000000011',
  authorityEpoch: '0190efff-0000-7000-8000-000000000001',
};

const RESTORED_EPOCHS: EpochState = {
  coreStreamEpoch: '0190efff-0000-7000-8000-000000000020',
  edgeStreamEpoch: '0190efff-0000-7000-8000-000000000021',
  authorityEpoch: '0190efff-0000-7000-8000-000000000002',
};

interface RequestOptions {
  coreSupported?: ProtocolRange;
  edgeSupported?: ProtocolRange;
  coreFloor?: number;
  edgeFloor?: number;
  persistedFloor?: number;
  coreCapabilities?: readonly string[];
  edgeCapabilities?: readonly string[];
  requiredCapabilities?: readonly string[];
  currentEpochs?: EpochState;
  resume?: EpochState;
}

function request(options: RequestOptions = {}): NegotiationRequest {
  return {
    core: {
      supported: options.coreSupported ?? { minimum: CURRENT_V1, maximum: CURRENT_V1 },
      downgradeFloor: options.coreFloor ?? CURRENT_V1,
      capabilities: options.coreCapabilities ?? [BASELINE_CAPABILITY],
    },
    edge: {
      supported: options.edgeSupported ?? { minimum: CURRENT_V1, maximum: CURRENT_V1 },
      downgradeFloor: options.edgeFloor ?? CURRENT_V1,
      capabilities: options.edgeCapabilities ?? [BASELINE_CAPABILITY],
    },
    persistedDeviceDowngradeFloor: options.persistedFloor ?? CURRENT_V1,
    requiredCapabilities: options.requiredCapabilities ?? [BASELINE_CAPABILITY],
    currentEpochs: options.currentEpochs ?? LIVE_EPOCHS,
    resume: options.resume,
  };
}

function expectAgreement(result: NegotiationResult): asserts result is NegotiationAgreement {
  assert.equal(result.accepted, true, JSON.stringify(result));
}

test('current-current negotiates v1 and resumes only matching epochs', () => {
  const result = negotiate(request({ resume: LIVE_EPOCHS }));

  expectAgreement(result);
  assert.equal(result.protocolVersion, CURRENT_V1);
  assert.deepEqual(result.enabledCapabilities, [BASELINE_CAPABILITY]);
  assert.deepEqual(result.resume, {
    accepted: true,
    reason: 'epochs_match',
    action: 'resume',
    mismatches: [],
  });
});

test('current-previous rolling negotiation selects the synthetic previous fixture in either order', async (t) => {
  const rollingRange = { minimum: SYNTHETIC_PREVIOUS_V0, maximum: CURRENT_V1 };
  const previousOnly = { minimum: SYNTHETIC_PREVIOUS_V0, maximum: SYNTHETIC_PREVIOUS_V0 };

  await t.test('current Core with previous Edge', () => {
    const result = negotiate(request({
      coreSupported: rollingRange,
      edgeSupported: previousOnly,
      coreFloor: SYNTHETIC_PREVIOUS_V0,
      edgeFloor: SYNTHETIC_PREVIOUS_V0,
      persistedFloor: SYNTHETIC_PREVIOUS_V0,
    }));

    expectAgreement(result);
    assert.equal(result.protocolVersion, SYNTHETIC_PREVIOUS_V0);
  });

  await t.test('previous Core with current Edge', () => {
    const result = negotiate(request({
      coreSupported: previousOnly,
      edgeSupported: rollingRange,
      coreFloor: SYNTHETIC_PREVIOUS_V0,
      edgeFloor: SYNTHETIC_PREVIOUS_V0,
      persistedFloor: SYNTHETIC_PREVIOUS_V0,
    }));

    expectAgreement(result);
    assert.equal(result.protocolVersion, SYNTHETIC_PREVIOUS_V0);
  });
});

test('no overlap is refused instead of falling back to another endpoint or contract', () => {
  const result = negotiate(request({
    coreSupported: { minimum: 1, maximum: 1 },
    edgeSupported: { minimum: 2, maximum: 2 },
    edgeFloor: 2,
  }));

  assert.deepEqual(result, {
    accepted: false,
    code: 'no_protocol_overlap',
    detail: 'Core and Edge have no mutually supported protocol version.',
  });
});

test('a malformed range is refused before overlap is calculated', () => {
  const result = negotiate(request({
    edgeSupported: { minimum: 2, maximum: 1 },
  }));

  assert.equal(result.accepted, false);
  if (!result.accepted) {
    assert.equal(result.code, 'malformed_edge_range');
  }
});

test('a mutually supported version below the persisted downgrade floor is refused', () => {
  const result = negotiate(request({
    coreSupported: { minimum: SYNTHETIC_PREVIOUS_V0, maximum: CURRENT_V1 },
    edgeSupported: { minimum: SYNTHETIC_PREVIOUS_V0, maximum: SYNTHETIC_PREVIOUS_V0 },
    coreFloor: SYNTHETIC_PREVIOUS_V0,
    edgeFloor: SYNTHETIC_PREVIOUS_V0,
    persistedFloor: CURRENT_V1,
  }));

  assert.equal(result.accepted, false);
  if (!result.accepted) {
    assert.equal(result.code, 'downgrade_below_floor');
  }
});

test('restore epoch mismatch accepts v1 but refuses resume and requires full resync', () => {
  const result = negotiate(request({
    currentEpochs: RESTORED_EPOCHS,
    resume: LIVE_EPOCHS,
  }));

  expectAgreement(result);
  assert.equal(result.protocolVersion, CURRENT_V1);
  assert.deepEqual(result.resume, {
    accepted: false,
    reason: 'epoch_mismatch',
    action: 'full_resync',
    mismatches: ['coreStreamEpoch', 'edgeStreamEpoch', 'authorityEpoch'],
  });
});

test('capabilities are an intersection and optional absence does not refuse the session', () => {
  const optionalCapability = 'media.youtube-iframe-v1';
  const result = negotiate(request({
    coreCapabilities: [BASELINE_CAPABILITY, optionalCapability],
    edgeCapabilities: [BASELINE_CAPABILITY],
  }));

  expectAgreement(result);
  assert.deepEqual(result.enabledCapabilities, [BASELINE_CAPABILITY]);
});

test('absence of a required baseline capability refuses the session', () => {
  const result = negotiate(request({
    edgeCapabilities: [],
  }));

  assert.equal(result.accepted, false);
  if (!result.accepted) {
    assert.equal(result.code, 'missing_required_capability');
  }
});
