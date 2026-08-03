import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { EdgeSimulator } from '../../edge/simulator/src/edge-simulator.js';
import type {
  DeviceV1ControlMessage,
  EdgeHello,
  StateDesired,
  StreamAck,
  StreamReset,
} from '../../packages/protocol-ts/src/generated/device-v1.js';
import { getDeviceV1Validator } from '../../scripts/contracts.js';
import { CoreGatewayHarness } from '../conformance/core-gateway-harness.js';

const FLEET_SIZE = 128;
const STALE_RESET_INTERVAL = 8;
const FIXED_TIME = '2026-07-18T10:00:00.000Z';
const SHARED_IDEMPOTENCY_KEY = 'phase0-fleet-shared-replay-safe-key';
const DIGEST_CHARACTERS = '0123456789abcdef';

type DeviceValidator = Awaited<ReturnType<typeof getDeviceV1Validator>>;
type MessageType = DeviceV1ControlMessage['type'];
type MessageOfType<T extends MessageType> = Extract<DeviceV1ControlMessage, { type: T }>;
type SequencedMessage = Extract<DeviceV1ControlMessage, { sequence: number }>;
type Architecture = EdgeHello['agent']['architecture'];
type Direction = 'core-to-edge' | 'edge-to-core';
type DesiredVariant = 'desired' | 'stale' | 'after-reset';

interface DeviceSpec {
  index: number;
  deviceId: string;
  architecture: Architecture;
  staleAndReset: boolean;
}

interface TranscriptEntry {
  direction: Direction;
  phase: string;
  ordinal: number;
  message: DeviceV1ControlMessage;
}

interface CoreCursorSegment {
  streamEpoch: string;
  sequences: number[];
}

interface DeviceSemanticRun {
  spec: DeviceSpec;
  transcript: TranscriptEntry[];
  reconnectResume: EdgeHello['resume'];
  coreCursorSegments: CoreCursorSegment[];
  edgeCursor: number[];
  finalSnapshot: EdgeSimulator['snapshot'];
  command: {
    idempotencyKey: string;
    echo: string;
    firstDeliveryWasDuplicate: boolean;
    replayWasMarkedReplayed: boolean;
  };
  reportedSceneIds: string[];
}

interface DeviceRun {
  simulator: EdgeSimulator;
  gateway: CoreGatewayHarness;
  semantic: DeviceSemanticRun;
}

class OneShotBarrier {
  private arrivalCount = 0;
  private readonly released: Promise<void>;
  private release!: () => void;

  constructor(private readonly parties: number) {
    assert(parties > 0);
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  wait(): Promise<void> {
    this.arrivalCount += 1;
    assert(
      this.arrivalCount <= this.parties,
      `barrier received ${this.arrivalCount} arrivals for ${this.parties} parties`,
    );
    if (this.arrivalCount === this.parties) this.release();
    return this.released;
  }

  get arrivals(): number {
    return this.arrivalCount;
  }
}

interface FleetGates {
  handshake: OneShotBarrier;
  initialDesired: OneShotBarrier;
  initialCommand: OneShotBarrier;
  preDisconnectAck: OneShotBarrier;
  resumed: OneShotBarrier;
  replayedCommand: OneShotBarrier;
  postResumeConvergence: OneShotBarrier;
}

class MessageRecorder {
  readonly entries: TranscriptEntry[] = [];

  constructor(
    private readonly deviceId: string,
    private readonly validate: DeviceValidator,
  ) {}

  record(
    direction: Direction,
    phase: string,
    message: DeviceV1ControlMessage,
    ordinal = 0,
  ): void {
    const valid = this.validate(message);
    const validationErrors = valid ? '' : `: ${JSON.stringify(this.validate.errors)}`;
    assert.equal(
      valid,
      true,
      `${this.deviceId} ${phase} ${direction} ${message.type} failed schema validation${validationErrors}`,
    );
    this.entries.push({
      direction,
      phase,
      ordinal,
      message: structuredClone(message),
    });
  }

  recordResponses(phase: string, messages: DeviceV1ControlMessage[]): void {
    messages.forEach((message, ordinal) => {
      this.record('edge-to-core', `${phase}.response`, message, ordinal);
    });
  }
}

function makeFleetGates(): FleetGates {
  return {
    handshake: new OneShotBarrier(FLEET_SIZE),
    initialDesired: new OneShotBarrier(FLEET_SIZE),
    initialCommand: new OneShotBarrier(FLEET_SIZE),
    preDisconnectAck: new OneShotBarrier(FLEET_SIZE),
    resumed: new OneShotBarrier(FLEET_SIZE),
    replayedCommand: new OneShotBarrier(FLEET_SIZE),
    postResumeConvergence: new OneShotBarrier(FLEET_SIZE),
  };
}

function makeDeviceSpecs(): DeviceSpec[] {
  return Array.from({ length: FLEET_SIZE }, (_, index) => ({
    index,
    deviceId: `linux-edge-${String(index).padStart(3, '0')}`,
    architecture: index < FLEET_SIZE / 2 ? 'amd64' : 'arm64',
    staleAndReset: index % STALE_RESET_INTERVAL === 0,
  }));
}

function digestCharacter(seed: number): string {
  return DIGEST_CHARACTERS[seed % DIGEST_CHARACTERS.length]!;
}

function sceneId(spec: DeviceSpec, revision: number, variant: DesiredVariant): string {
  return `${spec.deviceId}/scene/${variant}/revision-${revision}`;
}

function desiredFor(
  gateway: CoreGatewayHarness,
  spec: DeviceSpec,
  revision: number,
  variant: DesiredVariant = 'desired',
): StateDesired {
  const variantOffset = variant === 'desired' ? 0 : variant === 'stale' ? 5 : 10;
  const generated = gateway.desiredState(
    revision,
    digestCharacter(spec.index + revision + variantOffset),
  );

  return {
    ...generated,
    payload: {
      ...generated.payload,
      state: {
        scene: { revision_id: sceneId(spec, revision, variant) },
        display: {
          power: 'on',
          brightness: 20 + ((spec.index + revision) % 81),
        },
      },
    },
  };
}

function streamResetFor(spec: DeviceSpec, previousStreamEpoch: string): StreamReset {
  const suffix = String(spec.index + 1).padStart(12, '0');
  return {
    type: 'stream.reset',
    protocol: 1,
    message_id: `0190f800-0000-7000-8000-${suffix}`,
    sent_at: FIXED_TIME,
    previous_stream_epoch: previousStreamEpoch,
    new_stream_epoch: `0190f801-0000-7000-8000-${suffix}`,
    reason: 'history_truncated',
    desired_revision: 3,
  };
}

function deliverToEdge(
  edge: EdgeSimulator,
  recorder: MessageRecorder,
  phase: string,
  message: DeviceV1ControlMessage,
): DeviceV1ControlMessage[] {
  recorder.record('core-to-edge', phase, message);
  const responses = edge.handleCoreMessage(structuredClone(message));
  recorder.recordResponses(phase, responses);
  return responses;
}

function assertMessageTypes(
  messages: DeviceV1ControlMessage[],
  expected: readonly MessageType[],
  context: string,
): void {
  assert.deepEqual(
    messages.map((message) => message.type),
    expected,
    context,
  );
}

function expectMessage<T extends MessageType>(
  messages: DeviceV1ControlMessage[],
  index: number,
  expectedType: T,
  context: string,
): MessageOfType<T> {
  const message = messages[index];
  assert(message, `${context}: missing message at index ${index}`);
  assert.equal(message.type, expectedType, `${context}: unexpected message at index ${index}`);
  return message as MessageOfType<T>;
}

function assertAckFor(
  messages: DeviceV1ControlMessage[],
  index: number,
  input: { sequence: number; stream_epoch: string },
  context: string,
): StreamAck {
  const ack = expectMessage(messages, index, 'stream.ack', context);
  assert.equal(ack.stream_epoch, input.stream_epoch, `${context}: ACK stream epoch`);
  assert.equal(ack.acknowledged_sequence, input.sequence, `${context}: ACK sequence`);
  return ack;
}

function isSequencedMessage(message: DeviceV1ControlMessage): message is SequencedMessage {
  return 'sequence' in message;
}

function edgeSequences(entries: readonly TranscriptEntry[]): number[] {
  const sequences: number[] = [];
  for (const entry of entries) {
    if (entry.direction === 'edge-to-core' && isSequencedMessage(entry.message)) {
      sequences.push(entry.message.sequence);
    }
  }
  return sequences;
}

function assertContiguous(sequences: readonly number[], expectedLast: number, context: string): void {
  assert.deepEqual(
    sequences,
    Array.from({ length: expectedLast }, (_, index) => index + 1),
    `${context}: cursor must be contiguous from 1 through ${expectedLast}`,
  );
}

async function runDevice(
  spec: DeviceSpec,
  validate: DeviceValidator,
  gates: FleetGates,
): Promise<DeviceRun> {
  const now = () => FIXED_TIME;
  const gateway = new CoreGatewayHarness(now);
  const edge = new EdgeSimulator({
    architecture: spec.architecture,
    agentVersion: `phase0-fleet/${spec.deviceId}`,
    now,
  });
  const recorder = new MessageRecorder(spec.deviceId, validate);
  const primaryCoreSequences: number[] = [];
  const resetCoreSequences: number[] = [];
  const reportedSceneIds: string[] = [];
  let resetCoreStreamEpoch: string | undefined;

  const hello = edge.createHello();
  recorder.record('edge-to-core', 'connect.hello', hello);
  assert.equal(hello.agent.platform, 'linux', `${spec.deviceId}: platform`);
  assert.equal(hello.agent.architecture, spec.architecture, `${spec.deviceId}: architecture`);
  assert.equal(hello.agent.version, `phase0-fleet/${spec.deviceId}`, `${spec.deviceId}: identity sentinel`);

  const welcome = gateway.acceptHello(structuredClone(hello));
  assert.equal(welcome.resume.accepted, true, `${spec.deviceId}: initial resume`);
  assert.equal(welcome.resume.next_core_sequence, 1, `${spec.deviceId}: initial Core cursor`);
  assert.deepEqual(
    deliverToEdge(edge, recorder, 'connect.welcome', welcome),
    [],
    `${spec.deviceId}: welcome should not emit a response`,
  );
  await gates.handshake.wait();

  const desiredOne = desiredFor(gateway, spec, 1);
  primaryCoreSequences.push(desiredOne.sequence);
  const desiredOneOutput = deliverToEdge(edge, recorder, 'desired.initial', desiredOne);
  assertMessageTypes(
    desiredOneOutput,
    ['stream.ack', 'state.reported'],
    `${spec.deviceId}: initial desired output`,
  );
  assertAckFor(desiredOneOutput, 0, desiredOne, `${spec.deviceId}: initial desired`);
  const desiredOneReport = expectMessage(
    desiredOneOutput,
    1,
    'state.reported',
    `${spec.deviceId}: initial desired report`,
  );
  assert.equal(desiredOneReport.payload.status, 'applied', `${spec.deviceId}: initial convergence status`);
  assert.equal(desiredOneReport.payload.applied_revision, 1, `${spec.deviceId}: initial applied revision`);
  assert.equal(
    desiredOneReport.payload.state.scene?.revision_id,
    sceneId(spec, 1, 'desired'),
    `${spec.deviceId}: initial state isolation`,
  );
  reportedSceneIds.push(desiredOneReport.payload.state.scene?.revision_id ?? '');

  const duplicateDesiredOutput = deliverToEdge(
    edge,
    recorder,
    'desired.duplicate-delivery',
    structuredClone(desiredOne),
  );
  assertMessageTypes(
    duplicateDesiredOutput,
    ['stream.ack'],
    `${spec.deviceId}: duplicate desired output`,
  );
  assertAckFor(duplicateDesiredOutput, 0, desiredOne, `${spec.deviceId}: duplicate desired`);
  assert.equal(edge.snapshot.desiredApplyCount, 1, `${spec.deviceId}: desired state applied once`);
  assert.equal(edge.snapshot.lastCoreSequence, 1, `${spec.deviceId}: duplicate did not advance Core cursor`);
  await gates.initialDesired.wait();

  const echo = `echo:${spec.deviceId}`;
  const command = gateway.echoCommand({
    idempotencyKey: SHARED_IDEMPOTENCY_KEY,
    message: echo,
  });
  primaryCoreSequences.push(command.sequence);
  assert.equal(command.payload.execution_class, 'replay_safe', `${spec.deviceId}: command class`);
  const commandOutput = deliverToEdge(edge, recorder, 'command.initial', command);
  assertMessageTypes(
    commandOutput,
    ['stream.ack', 'command.received', 'command.completed'],
    `${spec.deviceId}: initial command output`,
  );
  assertAckFor(commandOutput, 0, command, `${spec.deviceId}: initial command`);
  const firstReceipt = expectMessage(
    commandOutput,
    1,
    'command.received',
    `${spec.deviceId}: initial command receipt`,
  );
  const firstCompletion = expectMessage(
    commandOutput,
    2,
    'command.completed',
    `${spec.deviceId}: initial command completion`,
  );
  assert.equal(firstReceipt.payload.duplicate, false, `${spec.deviceId}: first receipt is not duplicate`);
  assert.equal(firstCompletion.payload.replayed, false, `${spec.deviceId}: first completion is not replayed`);
  assert.equal(firstCompletion.payload.result.echoed, echo, `${spec.deviceId}: own command result`);
  assert.equal(edge.snapshot.echoExecutionCount, 1, `${spec.deviceId}: one command execution`);
  await gates.initialCommand.wait();

  const preDisconnectEdgeCursor = edgeSequences(recorder.entries);
  assertContiguous(preDisconnectEdgeCursor, 3, `${spec.deviceId}: pre-disconnect Edge cursor`);
  const preDisconnectAck = gateway.acknowledgeEdge(3);
  assert.deepEqual(
    deliverToEdge(edge, recorder, 'ack.pre-disconnect', preDisconnectAck),
    [],
    `${spec.deviceId}: Edge ACK handling`,
  );
  assert.equal(edge.snapshot.lastEdgeSequenceAcked, 3, `${spec.deviceId}: persisted Edge ACK cursor`);
  await gates.preDisconnectAck.wait();

  const beforeReconnectSnapshot = edge.snapshot;
  const reconnectHello = edge.createHello();
  recorder.record('edge-to-core', 'reconnect.hello', reconnectHello);
  assert.equal(reconnectHello.resume.last_core_sequence, 2, `${spec.deviceId}: resume Core cursor`);
  assert.equal(reconnectHello.resume.last_edge_sequence_acked, 3, `${spec.deviceId}: resume Edge ACK cursor`);
  assert.equal(
    reconnectHello.resume.core_stream_epoch,
    gateway.coreStreamEpoch,
    `${spec.deviceId}: resume Core epoch`,
  );
  assert.equal(
    reconnectHello.resume.edge_stream_epoch,
    gateway.edgeStreamEpoch,
    `${spec.deviceId}: resume Edge epoch`,
  );

  const reconnectWelcome = gateway.acceptHello(structuredClone(reconnectHello));
  assert.equal(reconnectWelcome.resume.accepted, true, `${spec.deviceId}: reconnect resume accepted`);
  assert.equal(reconnectWelcome.resume.next_core_sequence, 3, `${spec.deviceId}: reconnect next Core cursor`);
  assert.deepEqual(
    deliverToEdge(edge, recorder, 'reconnect.welcome', reconnectWelcome),
    [],
    `${spec.deviceId}: reconnect welcome response`,
  );
  assert.deepEqual(edge.snapshot, beforeReconnectSnapshot, `${spec.deviceId}: reconnect retained isolated state`);
  await gates.resumed.wait();

  const replayOutput = deliverToEdge(
    edge,
    recorder,
    'command.duplicate-after-reconnect',
    structuredClone(command),
  );
  assertMessageTypes(
    replayOutput,
    ['stream.ack', 'command.received', 'command.completed'],
    `${spec.deviceId}: replay output`,
  );
  assertAckFor(replayOutput, 0, command, `${spec.deviceId}: replayed command`);
  const replayReceipt = expectMessage(
    replayOutput,
    1,
    'command.received',
    `${spec.deviceId}: replay receipt`,
  );
  const replayCompletion = expectMessage(
    replayOutput,
    2,
    'command.completed',
    `${spec.deviceId}: replay completion`,
  );
  assert.equal(replayReceipt.payload.duplicate, true, `${spec.deviceId}: duplicate receipt marker`);
  assert.equal(replayCompletion.payload.replayed, true, `${spec.deviceId}: replay completion marker`);
  assert.equal(replayCompletion.payload.result.echoed, echo, `${spec.deviceId}: replayed own result`);
  assert.equal(edge.snapshot.echoExecutionCount, 1, `${spec.deviceId}: replay did not execute twice`);
  assert.equal(edge.snapshot.lastCoreSequence, 2, `${spec.deviceId}: replay did not advance Core cursor`);
  assertContiguous(edgeSequences(recorder.entries), 5, `${spec.deviceId}: post-replay Edge cursor`);

  const replayAck = gateway.acknowledgeEdge(5);
  assert.deepEqual(
    deliverToEdge(edge, recorder, 'ack.replayed-command', replayAck),
    [],
    `${spec.deviceId}: replay ACK handling`,
  );
  assert.equal(edge.snapshot.lastEdgeSequenceAcked, 5, `${spec.deviceId}: replay ACK cursor`);
  await gates.replayedCommand.wait();

  const desiredTwo = desiredFor(gateway, spec, 2);
  primaryCoreSequences.push(desiredTwo.sequence);
  const desiredTwoOutput = deliverToEdge(edge, recorder, 'desired.post-resume', desiredTwo);
  assertMessageTypes(
    desiredTwoOutput,
    ['stream.ack', 'state.reported'],
    `${spec.deviceId}: post-resume desired output`,
  );
  assertAckFor(desiredTwoOutput, 0, desiredTwo, `${spec.deviceId}: post-resume desired`);
  const desiredTwoReport = expectMessage(
    desiredTwoOutput,
    1,
    'state.reported',
    `${spec.deviceId}: post-resume desired report`,
  );
  assert.equal(desiredTwoReport.payload.applied_revision, 2, `${spec.deviceId}: post-resume convergence`);
  assert.equal(
    desiredTwoReport.payload.state.scene?.revision_id,
    sceneId(spec, 2, 'desired'),
    `${spec.deviceId}: post-resume state isolation`,
  );
  reportedSceneIds.push(desiredTwoReport.payload.state.scene?.revision_id ?? '');
  assert.equal(edge.snapshot.desiredApplyCount, 2, `${spec.deviceId}: two desired revisions applied`);
  assertContiguous(edgeSequences(recorder.entries), 6, `${spec.deviceId}: converged Edge cursor`);

  const convergenceAck = gateway.acknowledgeEdge(6);
  assert.deepEqual(
    deliverToEdge(edge, recorder, 'ack.post-resume-convergence', convergenceAck),
    [],
    `${spec.deviceId}: convergence ACK handling`,
  );
  assert.equal(edge.snapshot.lastEdgeSequenceAcked, 6, `${spec.deviceId}: convergence ACK cursor`);
  await gates.postResumeConvergence.wait();

  if (spec.staleAndReset) {
    const staleDesired = desiredFor(gateway, spec, 1, 'stale');
    primaryCoreSequences.push(staleDesired.sequence);
    const staleOutput = deliverToEdge(edge, recorder, 'desired.controlled-stale', staleDesired);
    assertMessageTypes(
      staleOutput,
      ['stream.ack', 'protocol.error'],
      `${spec.deviceId}: stale desired output`,
    );
    assertAckFor(staleOutput, 0, staleDesired, `${spec.deviceId}: stale desired`);
    const staleError = expectMessage(
      staleOutput,
      1,
      'protocol.error',
      `${spec.deviceId}: stale desired error`,
    );
    assert.equal(staleError.code, 'stale_revision', `${spec.deviceId}: stale desired rejection`);
    assert.equal(staleError.correlation_id, staleDesired.message_id, `${spec.deviceId}: stale correlation`);
    assert.equal(edge.snapshot.appliedDesiredRevision, 2, `${spec.deviceId}: stale state not applied`);
    assert.equal(edge.snapshot.desiredApplyCount, 2, `${spec.deviceId}: stale state did not increment apply count`);

    const reset = streamResetFor(spec, gateway.coreStreamEpoch);
    resetCoreStreamEpoch = reset.new_stream_epoch;
    assert.deepEqual(
      deliverToEdge(edge, recorder, 'stream.controlled-reset', reset),
      [],
      `${spec.deviceId}: reset response`,
    );
    assert.equal(edge.snapshot.lastCoreSequence, 0, `${spec.deviceId}: reset restarted Core cursor`);

    const generatedAfterReset = desiredFor(gateway, spec, 3, 'after-reset');
    const afterResetDesired: StateDesired = {
      ...generatedAfterReset,
      stream_epoch: reset.new_stream_epoch,
      sequence: 1,
    };
    resetCoreSequences.push(afterResetDesired.sequence);
    const afterResetOutput = deliverToEdge(
      edge,
      recorder,
      'desired.after-controlled-reset',
      afterResetDesired,
    );
    assertMessageTypes(
      afterResetOutput,
      ['stream.ack', 'state.reported'],
      `${spec.deviceId}: post-reset desired output`,
    );
    assertAckFor(afterResetOutput, 0, afterResetDesired, `${spec.deviceId}: post-reset desired`);
    const afterResetReport = expectMessage(
      afterResetOutput,
      1,
      'state.reported',
      `${spec.deviceId}: post-reset desired report`,
    );
    assert.equal(afterResetReport.payload.applied_revision, 3, `${spec.deviceId}: post-reset convergence`);
    assert.equal(
      afterResetReport.payload.state.scene?.revision_id,
      sceneId(spec, 3, 'after-reset'),
      `${spec.deviceId}: post-reset state isolation`,
    );
    reportedSceneIds.push(afterResetReport.payload.state.scene?.revision_id ?? '');

    const resetConvergenceAck = gateway.acknowledgeEdge(7);
    assert.deepEqual(
      deliverToEdge(edge, recorder, 'ack.after-controlled-reset', resetConvergenceAck),
      [],
      `${spec.deviceId}: reset convergence ACK handling`,
    );
    assert.equal(edge.snapshot.lastEdgeSequenceAcked, 7, `${spec.deviceId}: reset convergence ACK cursor`);
  }

  const expectedLastEdgeSequence = spec.staleAndReset ? 7 : 6;
  const finalEdgeCursor = edgeSequences(recorder.entries);
  assertContiguous(finalEdgeCursor, expectedLastEdgeSequence, `${spec.deviceId}: final Edge cursor`);
  assertContiguous(
    primaryCoreSequences,
    spec.staleAndReset ? 4 : 3,
    `${spec.deviceId}: primary Core cursor`,
  );
  if (spec.staleAndReset) {
    assertContiguous(resetCoreSequences, 1, `${spec.deviceId}: reset Core cursor`);
  } else {
    assert.deepEqual(resetCoreSequences, [], `${spec.deviceId}: no unexpected reset cursor`);
  }

  const finalSnapshot = edge.snapshot;
  assert.equal(finalSnapshot.echoExecutionCount, 1, `${spec.deviceId}: final command execution count`);
  assert.equal(
    finalSnapshot.desiredApplyCount,
    spec.staleAndReset ? 3 : 2,
    `${spec.deviceId}: final desired apply count`,
  );
  assert.equal(
    finalSnapshot.appliedDesiredRevision,
    spec.staleAndReset ? 3 : 2,
    `${spec.deviceId}: final applied revision`,
  );
  assert.equal(
    finalSnapshot.processedDesiredRevision,
    spec.staleAndReset ? 3 : 2,
    `${spec.deviceId}: final processed revision`,
  );
  assert.equal(
    finalSnapshot.lastCoreSequence,
    spec.staleAndReset ? 1 : 3,
    `${spec.deviceId}: final Core cursor`,
  );
  assert.equal(
    finalSnapshot.lastEdgeSequenceAcked,
    expectedLastEdgeSequence,
    `${spec.deviceId}: final acknowledged Edge cursor`,
  );
  assert.equal(
    finalSnapshot.nextEdgeSequence,
    expectedLastEdgeSequence + 1,
    `${spec.deviceId}: next Edge cursor`,
  );

  const coreCursorSegments: CoreCursorSegment[] = [
    {
      streamEpoch: gateway.coreStreamEpoch,
      sequences: [...primaryCoreSequences],
    },
  ];
  if (resetCoreStreamEpoch) {
    coreCursorSegments.push({
      streamEpoch: resetCoreStreamEpoch,
      sequences: [...resetCoreSequences],
    });
  }

  return {
    simulator: edge,
    gateway,
    semantic: {
      spec: { ...spec },
      transcript: recorder.entries,
      reconnectResume: structuredClone(reconnectHello.resume),
      coreCursorSegments,
      edgeCursor: finalEdgeCursor,
      finalSnapshot,
      command: {
        idempotencyKey: command.payload.idempotency_key,
        echo,
        firstDeliveryWasDuplicate: firstReceipt.payload.duplicate,
        replayWasMarkedReplayed: replayCompletion.payload.replayed,
      },
      reportedSceneIds,
    },
  };
}

function assertFleetIsolation(runs: readonly DeviceRun[]): void {
  assert(FLEET_SIZE >= 100, 'Phase 0 fleet must contain at least 100 Edges');
  assert.equal(runs.length, FLEET_SIZE, 'all fleet sessions completed');
  assert.equal(
    new Set(runs.map((run) => run.simulator)).size,
    FLEET_SIZE,
    'every device has an independent Edge simulator instance',
  );
  assert.equal(
    new Set(runs.map((run) => run.gateway)).size,
    FLEET_SIZE,
    'every device has an independent Core gateway cursor',
  );
  assert.equal(
    new Set(runs.map((run) => run.semantic.transcript)).size,
    FLEET_SIZE,
    'every device owns an independent transcript',
  );

  const architectureCounts: Record<Architecture, number> = { amd64: 0, arm64: 0 };
  const resetArchitectureCounts: Record<Architecture, number> = { amd64: 0, arm64: 0 };
  for (const run of runs) {
    architectureCounts[run.semantic.spec.architecture] += 1;
    if (run.semantic.spec.staleAndReset) {
      resetArchitectureCounts[run.semantic.spec.architecture] += 1;
    }
  }
  assert.deepEqual(architectureCounts, { amd64: 64, arm64: 64 }, 'fleet architecture split');
  assert.deepEqual(resetArchitectureCounts, { amd64: 8, arm64: 8 }, 'controlled reset architecture split');

  const idempotencyKeys = new Set(runs.map((run) => run.semantic.command.idempotencyKey));
  assert.deepEqual(
    [...idempotencyKeys],
    [SHARED_IDEMPOTENCY_KEY],
    'the same logical idempotency key is intentionally isolated per device',
  );
  assert.equal(
    runs.reduce((total, run) => total + run.semantic.finalSnapshot.echoExecutionCount, 0),
    FLEET_SIZE,
    'the shared logical key executes exactly once on every isolated Edge',
  );

  const echoes = runs.map((run) => run.semantic.command.echo);
  assert.equal(new Set(echoes).size, FLEET_SIZE, 'each Edge retained its own command result');
  runs.forEach((run) => {
    assert.equal(
      run.semantic.command.echo,
      `echo:${run.semantic.spec.deviceId}`,
      `${run.semantic.spec.deviceId}: no cross-device command result`,
    );
  });

  const reportedSceneIds = runs.flatMap((run) => run.semantic.reportedSceneIds);
  const expectedReportedStates = FLEET_SIZE * 2 + FLEET_SIZE / STALE_RESET_INTERVAL;
  assert.equal(reportedSceneIds.length, expectedReportedStates, 'all expected converged states were reported');
  assert.equal(
    new Set(reportedSceneIds).size,
    expectedReportedStates,
    'reported desired state never leaked between devices',
  );
}

async function runFleet(validate: DeviceValidator): Promise<DeviceRun[]> {
  const gates = makeFleetGates();
  const runs = await Promise.all(
    makeDeviceSpecs().map((spec) => runDevice(spec, validate, gates)),
  );

  for (const [phase, gate] of Object.entries(gates)) {
    assert.equal(gate.arrivals, FLEET_SIZE, `${phase}: all fleet sessions reached the concurrent phase gate`);
  }
  assertFleetIsolation(runs);
  return runs;
}

function semanticFingerprint(runs: readonly DeviceSemanticRun[]): string {
  return createHash('sha256').update(JSON.stringify(runs)).digest('hex');
}

test('Phase 0 semantic fleet remains isolated and deterministic under concurrent delivery', async (t) => {
  const validate = await getDeviceV1Validator();

  const firstStarted = performance.now();
  const first = await runFleet(validate);
  const firstElapsedMs = performance.now() - firstStarted;

  const secondStarted = performance.now();
  const second = await runFleet(validate);
  const secondElapsedMs = performance.now() - secondStarted;

  const firstSemanticRun = first.map((run) => run.semantic);
  const secondSemanticRun = second.map((run) => run.semantic);
  assert.deepEqual(
    secondSemanticRun,
    firstSemanticRun,
    'identical fleet inputs must produce byte-for-byte-equivalent semantic transcripts and cursors',
  );

  const firstFingerprint = semanticFingerprint(firstSemanticRun);
  const secondFingerprint = semanticFingerprint(secondSemanticRun);
  assert.equal(secondFingerprint, firstFingerprint, 'semantic transcript fingerprint must repeat');

  t.diagnostic(`fleet_run_1_elapsed_ms=${firstElapsedMs.toFixed(3)} (diagnostic only)`);
  t.diagnostic(`fleet_run_2_elapsed_ms=${secondElapsedMs.toFixed(3)} (diagnostic only)`);
  t.diagnostic(`fleet_semantic_transcript_sha256=${firstFingerprint}`);
});
