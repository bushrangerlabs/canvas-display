import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoreOutboxModel,
  EdgeDurableStore,
  EdgeRuntime,
  ExternalEffectProbe,
  InjectedCrash,
  type CommandIssueMessage,
  type CommandReceipt,
  type DesiredStateMessage,
  type ExecutionClass,
  type FaultPoint,
} from './durability-model.js';

const CORE_EPOCH_1 = 'core-stream-epoch-1';
const CORE_EPOCH_2 = 'core-stream-epoch-2';
const EDGE_EPOCH_1 = 'edge-stream-epoch-1';
const AUTHORITY_EPOCH_1 = 'authority-epoch-1';
const AUTHORITY_EPOCH_2 = 'authority-epoch-2';

function makeStore(outboxCapacity = 64): EdgeDurableStore {
  return new EdgeDurableStore({
    coreStreamEpoch: CORE_EPOCH_1,
    edgeStreamEpoch: EDGE_EPOCH_1,
    authorityEpoch: AUTHORITY_EPOCH_1,
    outboxCapacity,
  });
}

function desiredMessage(
  sequence: number,
  options: {
    messageId?: string;
    streamEpoch?: string;
    authorityEpoch?: string;
    revision?: number;
    value?: string;
  } = {},
): DesiredStateMessage {
  return {
    type: 'state.desired',
    messageId: options.messageId ?? `desired-message-${sequence}`,
    streamEpoch: options.streamEpoch ?? CORE_EPOCH_1,
    sequence,
    authorityEpoch: options.authorityEpoch ?? AUTHORITY_EPOCH_1,
    revision: options.revision ?? sequence,
    value: options.value ?? `desired-value-${sequence}`,
  };
}

function commandMessage(
  sequence: number,
  executionClass: ExecutionClass,
  options: {
    messageId?: string;
    commandId?: string;
    streamEpoch?: string;
    authorityEpoch?: string;
  } = {},
): CommandIssueMessage {
  const commandId = options.commandId ?? `command-${sequence}`;
  return {
    type: 'command.issue',
    messageId: options.messageId ?? `command-message-${sequence}`,
    streamEpoch: options.streamEpoch ?? CORE_EPOCH_1,
    sequence,
    authorityEpoch: options.authorityEpoch ?? AUTHORITY_EPOCH_1,
    commandId,
    idempotencyKey: `idempotency-${commandId}`,
    requestDigest: `digest-${commandId}`,
    executionClass,
  };
}

function receipt(store: EdgeDurableStore, commandId: string): CommandReceipt {
  const found = store.snapshot().commandReceipts.find((candidate) => candidate.commandId === commandId);
  assert(found, `missing receipt for ${commandId}`);
  return found;
}

function expectCrash(point: FaultPoint, action: () => void): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof InjectedCrash);
    assert.equal(error.point, point);
    return true;
  });
}

test('replaceable state is coalesced before sequencing and assigned sequences stay immutable', () => {
  const core = new CoreOutboxModel(CORE_EPOCH_1);

  core.stageReplaceable('desired:edge-1', {
    type: 'state.desired',
    messageId: 'desired-revision-1',
    value: 'revision-1',
  });
  core.stageReplaceable('desired:edge-1', {
    type: 'state.desired',
    messageId: 'desired-revision-2',
    value: 'revision-2',
  });

  assert.equal(core.snapshot().pending.length, 1);
  const firstFlush = core.sequencePending();
  assert.deepEqual(firstFlush.map(({ messageId, sequence }) => ({ messageId, sequence })), [
    { messageId: 'desired-revision-2', sequence: 1 },
  ]);

  core.stageRequired({
    type: 'command.issue',
    messageId: 'required-command',
    value: 'do-not-coalesce',
  });
  core.stageReplaceable('telemetry:temperature', {
    type: 'telemetry.sample',
    messageId: 'temperature-1',
    value: '20',
  });
  core.stageReplaceable('telemetry:temperature', {
    type: 'telemetry.sample',
    messageId: 'temperature-2',
    value: '21',
  });

  const secondFlush = core.sequencePending();
  assert.deepEqual(secondFlush.map(({ messageId, sequence }) => ({ messageId, sequence })), [
    { messageId: 'required-command', sequence: 2 },
    { messageId: 'temperature-2', sequence: 3 },
  ]);

  core.stageReplaceable('desired:edge-1', {
    type: 'state.desired',
    messageId: 'desired-revision-3',
    value: 'revision-3',
  });
  core.sequencePending();

  const snapshot = core.snapshot();
  assert.deepEqual(snapshot.sequenced.map((message) => message.sequence), [1, 2, 3, 4]);
  assert.equal(snapshot.sequenced[0]?.messageId, 'desired-revision-2');
  assert.equal(snapshot.sequenced[3]?.messageId, 'desired-revision-3');
});

test('Core-to-Edge ACK is emitted only after inbox bookkeeping and cursor commit', () => {
  const store = makeStore();
  const effects = new ExternalEffectProbe();
  const message = desiredMessage(1);

  const beforeCommit = new EdgeRuntime(store, effects);
  expectCrash('before_inbox_commit', () => beforeCommit.receive(message, 'before_inbox_commit'));
  assert.equal(store.snapshot().lastCoreSequence, 0);
  assert.equal(store.snapshot().inbox.length, 0);
  assert.equal(beforeCommit.sentAcks.length, 0);

  const afterCommit = new EdgeRuntime(store, effects);
  expectCrash(
    'after_inbox_commit_before_ack',
    () => afterCommit.receive(message, 'after_inbox_commit_before_ack'),
  );
  assert.equal(store.snapshot().lastCoreSequence, 1);
  assert.equal(store.snapshot().inbox.length, 1);
  assert.deepEqual(store.snapshot().desiredState, { revision: 1, value: 'desired-value-1' });
  assert.equal(afterCommit.sentAcks.length, 0);

  const recovered = new EdgeRuntime(store, effects);
  const replay = recovered.receive(message);
  assert.equal(replay.status, 'duplicate_transport');
  assert.deepEqual(replay.ack, {
    streamEpoch: CORE_EPOCH_1,
    acknowledgedSequence: 1,
  });
  assert.equal(store.snapshot().inbox.length, 1);
  assert.equal(store.snapshot().lastCoreSequence, 1);

  const gap = recovered.receive(desiredMessage(3));
  assert.equal(gap.status, 'gap');
  assert.equal(gap.expectedSequence, 2);
  assert.equal(gap.ack, null);
  assert.equal(store.snapshot().lastCoreSequence, 1);
});

test('a replay-safe command with a committed result does not execute twice across crash and replay', () => {
  const store = makeStore();
  const effects = new ExternalEffectProbe();
  const command = commandMessage(1, 'replay_safe', { commandId: 'replay-safe-1' });
  const edge = new EdgeRuntime(store, effects);

  const received = edge.receive(command);
  assert.equal(received.receiptState, 'received');
  assert.equal(receipt(store, command.commandId).state, 'received');

  expectCrash(
    'after_result_commit_before_publish',
    () => edge.runCommand(command.commandId, 'after_result_commit_before_publish'),
  );
  assert.equal(receipt(store, command.commandId).state, 'completed');
  assert.equal(receipt(store, command.commandId).executionAttempts, 1);
  assert.equal(effects.count(command.commandId), 1);
  assert(edge.pendingOutbox().some((record) => record.kind === 'command.completed'));

  const recovered = new EdgeRuntime(store, effects);
  assert.equal(recovered.receive(command).status, 'duplicate_transport');

  const resequencedReplay: CommandIssueMessage = {
    ...command,
    messageId: 'replay-safe-message-resequenced',
    sequence: 2,
  };
  const replayReceipt = recovered.receive(resequencedReplay);
  assert.equal(replayReceipt.status, 'committed');
  assert.equal(replayReceipt.commandWasDuplicate, true);
  assert.equal(replayReceipt.receiptState, 'completed');

  const replayedRun = recovered.runCommand(command.commandId);
  assert.equal(replayedRun.replayed, true);
  assert.equal(replayedRun.receipt.state, 'completed');
  assert.equal(effects.count(command.commandId), 1);
  assert.equal(receipt(store, command.commandId).executionAttempts, 1);
  assert(recovered.pendingOutbox().some(
    (record) => record.kind === 'command.completed' && record.replayed,
  ));
});

test('non-repeatable recovery is conservative at every persisted side-effect boundary', async (t) => {
  const scenarios: readonly {
    fault: FaultPoint;
    stateAtCrash: CommandReceipt['state'];
    effectsAtCrash: number;
    stateAfterRecovery: CommandReceipt['state'];
    effectsAfterRecovery: number;
  }[] = [
    {
      fault: 'after_accept_commit_before_running',
      stateAtCrash: 'accepted',
      effectsAtCrash: 0,
      stateAfterRecovery: 'completed',
      effectsAfterRecovery: 1,
    },
    {
      fault: 'after_running_commit_before_effect',
      stateAtCrash: 'running',
      effectsAtCrash: 0,
      stateAfterRecovery: 'unknown_outcome',
      effectsAfterRecovery: 0,
    },
    {
      fault: 'after_external_effect_before_result_commit',
      stateAtCrash: 'running',
      effectsAtCrash: 1,
      stateAfterRecovery: 'unknown_outcome',
      effectsAfterRecovery: 1,
    },
    {
      fault: 'after_result_commit_before_publish',
      stateAtCrash: 'completed',
      effectsAtCrash: 1,
      stateAfterRecovery: 'completed',
      effectsAfterRecovery: 1,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.fault, () => {
      const store = makeStore();
      const effects = new ExternalEffectProbe();
      const command = commandMessage(1, 'non_repeatable', { commandId: `nr-${scenario.fault}` });
      const edge = new EdgeRuntime(store, effects);

      edge.receive(command);
      expectCrash(scenario.fault, () => edge.runCommand(command.commandId, scenario.fault));
      assert.equal(receipt(store, command.commandId).state, scenario.stateAtCrash);
      assert.equal(effects.count(command.commandId), scenario.effectsAtCrash);

      const recovered = new EdgeRuntime(store, effects);
      recovered.recoverCommands();
      const recoveredReceipt = receipt(store, command.commandId);
      assert.equal(recoveredReceipt.state, scenario.stateAfterRecovery);
      assert.equal(effects.count(command.commandId), scenario.effectsAfterRecovery);

      if (scenario.stateAfterRecovery === 'unknown_outcome') {
        assert.equal(
          recoveredReceipt.uncertainty,
          'process_crashed_after_execution_may_have_started',
        );
        assert(recovered.pendingOutbox().some(
          (record) => record.kind === 'command.unknown_outcome' && record.ref === command.commandId,
        ));
        const terminalReplay = recovered.runCommand(command.commandId);
        assert.equal(terminalReplay.replayed, true);
        assert.equal(effects.count(command.commandId), scenario.effectsAfterRecovery);
      }
    });
  }
});

test('Edge outbox records and its ACK cursor survive restart until ACK commit', () => {
  const store = makeStore(8);
  const effects = new ExternalEffectProbe();
  const edge = new EdgeRuntime(store, effects);

  assert.deepEqual(edge.queueEdgeEvent({
    kind: 'command.completed',
    eventClass: 'command_result',
    ref: 'command-1',
  }), { status: 'queued', sequence: 1 });
  assert.deepEqual(edge.queueEdgeEvent({
    kind: 'security.audit',
    eventClass: 'security_result',
    ref: 'security-1',
  }), { status: 'queued', sequence: 2 });

  const restarted = new EdgeRuntime(store, effects);
  assert.deepEqual(restarted.pendingOutbox().map((record) => record.sequence), [1, 2]);

  expectCrash(
    'before_outbox_ack_commit',
    () => restarted.acknowledgeOutbox(EDGE_EPOCH_1, 1, 'before_outbox_ack_commit'),
  );
  assert.equal(store.snapshot().lastEdgeAckedSequence, 0);
  assert.deepEqual(restarted.pendingOutbox().map((record) => record.sequence), [1, 2]);

  expectCrash(
    'after_outbox_ack_commit',
    () => restarted.acknowledgeOutbox(EDGE_EPOCH_1, 1, 'after_outbox_ack_commit'),
  );
  assert.equal(store.snapshot().lastEdgeAckedSequence, 1);
  assert.deepEqual(store.snapshot().outbox.map((record) => record.sequence), [2]);

  const recovered = new EdgeRuntime(store, effects);
  const staleAck = recovered.acknowledgeOutbox('stale-edge-stream-epoch', 2);
  assert.equal(staleAck.status, 'stale_stream_epoch');
  assert.equal(store.snapshot().lastEdgeAckedSequence, 1);
  assert.deepEqual(recovered.pendingOutbox().map((record) => record.sequence), [2]);

  assert.equal(recovered.acknowledgeOutbox(EDGE_EPOCH_1, 2).status, 'committed');
  assert.equal(store.snapshot().lastEdgeAckedSequence, 2);
  assert.equal(recovered.pendingOutbox().length, 0);
});

test('restore/reset stream and authority epochs fence stale messages', () => {
  const store = makeStore();
  const effects = new ExternalEffectProbe();
  const edge = new EdgeRuntime(store, effects);

  assert.equal(edge.receive(desiredMessage(1, { revision: 7, value: 'before-restore' })).status, 'committed');
  edge.applyRestoreReset({
    reason: 'restore',
    previousCoreStreamEpoch: CORE_EPOCH_1,
    newCoreStreamEpoch: CORE_EPOCH_2,
    newAuthorityEpoch: AUTHORITY_EPOCH_2,
  });

  const resetState = store.snapshot();
  assert.equal(resetState.restoreGeneration, 1);
  assert.equal(resetState.lastCoreSequence, 0);
  assert.equal(resetState.desiredState, null);

  const recovered = new EdgeRuntime(store, effects);
  const staleStream = recovered.receive(desiredMessage(2, {
    messageId: 'stale-stream-message',
    streamEpoch: CORE_EPOCH_1,
    authorityEpoch: AUTHORITY_EPOCH_1,
    revision: 8,
  }));
  assert.equal(staleStream.status, 'stale_stream_epoch');

  const staleAuthority = recovered.receive(desiredMessage(1, {
    messageId: 'stale-authority-message',
    streamEpoch: CORE_EPOCH_2,
    authorityEpoch: AUTHORITY_EPOCH_1,
    revision: 8,
  }));
  assert.equal(staleAuthority.status, 'stale_authority_epoch');

  assert.equal(store.snapshot().lastCoreSequence, 0);
  assert.equal(store.snapshot().desiredState, null);
  assert.equal(recovered.sentAcks.length, 0);

  const fresh = recovered.receive(desiredMessage(1, {
    messageId: 'fresh-after-restore',
    streamEpoch: CORE_EPOCH_2,
    authorityEpoch: AUTHORITY_EPOCH_2,
    revision: 1,
    value: 'fresh-snapshot',
  }));
  assert.equal(fresh.status, 'committed');
  assert.deepEqual(fresh.ack, {
    streamEpoch: CORE_EPOCH_2,
    acknowledgedSequence: 1,
  });
  assert.equal(store.snapshot().lastCoreSequence, 1);
  assert.deepEqual(store.snapshot().desiredState, { revision: 1, value: 'fresh-snapshot' });
});

test('capacity pressure sheds telemetry before command and security results', () => {
  const store = makeStore(3);
  const edge = new EdgeRuntime(store, new ExternalEffectProbe());

  for (let index = 1; index <= 3; index += 1) {
    assert.deepEqual(edge.queueEdgeEvent({
      kind: 'telemetry.sample',
      eventClass: 'telemetry',
      ref: `telemetry-${index}`,
    }), { status: 'queued', sequence: index });
  }

  assert.deepEqual(edge.queueEdgeEvent({
    kind: 'command.completed',
    eventClass: 'command_result',
    ref: 'command-result-1',
  }), { status: 'queued', sequence: 4 });
  assert.deepEqual(edge.queueEdgeEvent({
    kind: 'security.audit',
    eventClass: 'security_result',
    ref: 'security-result-1',
  }), { status: 'queued', sequence: 5 });

  let snapshot = store.snapshot();
  assert.deepEqual(snapshot.outbox.map((record) => record.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(snapshot.outbox.map((record) => record.eventClass), [
    'tombstone',
    'tombstone',
    'telemetry',
    'command_result',
    'security_result',
  ]);
  assert.deepEqual(snapshot.outbox.slice(0, 2).map((record) => record.originalKind), [
    'telemetry.sample',
    'telemetry.sample',
  ]);
  assert.equal(edge.usedOutboxCapacity(), 3);
  assert.equal(snapshot.telemetryTombstonedAfterSequence, 2);

  assert.deepEqual(edge.queueEdgeEvent({
    kind: 'telemetry.sample',
    eventClass: 'telemetry',
    ref: 'telemetry-never-sequenced',
  }), { status: 'shed_before_sequence', sequence: null });
  assert.equal(store.snapshot().nextEdgeSequence, 6);

  assert.deepEqual(edge.queueEdgeEvent({
    kind: 'command.failed',
    eventClass: 'command_result',
    ref: 'command-result-2',
  }), { status: 'queued', sequence: 6 });
  assert.deepEqual(edge.queueEdgeEvent({
    kind: 'security.audit',
    eventClass: 'security_result',
    ref: 'security-result-2',
  }), { status: 'storage_degraded', sequence: null });

  snapshot = store.snapshot();
  assert.equal(snapshot.storageDegraded, true);
  assert.equal(snapshot.telemetryShedBeforeSequence, 1);
  assert.equal(snapshot.telemetryTombstonedAfterSequence, 3);
  assert.equal(snapshot.nextEdgeSequence, 7);
  assert.equal(edge.usedOutboxCapacity(), 3);
  assert.deepEqual(snapshot.outbox.map((record) => record.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(
    snapshot.outbox
      .filter((record) => record.eventClass === 'command_result' || record.eventClass === 'security_result')
      .map((record) => record.ref),
    ['command-result-1', 'security-result-1', 'command-result-2'],
  );
});
