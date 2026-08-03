export type ExecutionClass = 'replay_safe' | 'non_repeatable';

export type CommandReceiptState =
  | 'received'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown_outcome';

export type FaultPoint =
  | 'before_inbox_commit'
  | 'after_inbox_commit_before_ack'
  | 'after_accept_commit_before_running'
  | 'after_running_commit_before_effect'
  | 'after_external_effect_before_result_commit'
  | 'after_result_commit_before_publish'
  | 'before_outbox_ack_commit'
  | 'after_outbox_ack_commit';

export class InjectedCrash extends Error {
  readonly point: FaultPoint;

  constructor(point: FaultPoint) {
    super(`injected crash at ${point}`);
    this.name = 'InjectedCrash';
    this.point = point;
  }
}

export class ProtocolInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolInvariantError';
  }
}

export class OutboxCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxCapacityError';
  }
}

function crashIf(configured: FaultPoint | null, point: FaultPoint): void {
  if (configured === point) {
    throw new InjectedCrash(point);
  }
}

export interface CoreIntent {
  type: string;
  messageId: string;
  value: string;
}

interface PendingCoreIntent extends CoreIntent {
  coalesceKey: string | null;
}

export interface SequencedCoreIntent extends CoreIntent {
  streamEpoch: string;
  sequence: number;
}

export interface CoreOutboxSnapshot {
  streamEpoch: string;
  nextSequence: number;
  pending: readonly PendingCoreIntent[];
  sequenced: readonly SequencedCoreIntent[];
}

/**
 * Models the pre-sequence coalescing boundary. Replaceable intents can be
 * replaced only while pending; sequence assignment makes each record immutable.
 */
export class CoreOutboxModel {
  private state: {
    streamEpoch: string;
    nextSequence: number;
    pending: PendingCoreIntent[];
    sequenced: SequencedCoreIntent[];
  };

  constructor(streamEpoch: string) {
    this.state = {
      streamEpoch,
      nextSequence: 1,
      pending: [],
      sequenced: [],
    };
  }

  stageReplaceable(coalesceKey: string, intent: CoreIntent): void {
    const pending = this.state.pending.filter((candidate) => candidate.coalesceKey !== coalesceKey);
    pending.push({ ...intent, coalesceKey });
    this.state = { ...this.state, pending };
  }

  stageRequired(intent: CoreIntent): void {
    this.state = {
      ...this.state,
      pending: [...this.state.pending, { ...intent, coalesceKey: null }],
    };
  }

  sequencePending(): readonly SequencedCoreIntent[] {
    const firstSequence = this.state.nextSequence;
    const assigned = this.state.pending.map((intent, index): SequencedCoreIntent => ({
      type: intent.type,
      messageId: intent.messageId,
      value: intent.value,
      streamEpoch: this.state.streamEpoch,
      sequence: firstSequence + index,
    }));

    this.state = {
      ...this.state,
      nextSequence: firstSequence + assigned.length,
      pending: [],
      sequenced: [...this.state.sequenced, ...assigned],
    };

    return structuredClone(assigned);
  }

  snapshot(): CoreOutboxSnapshot {
    return structuredClone(this.state);
  }
}

interface CoreMessageBase {
  messageId: string;
  streamEpoch: string;
  sequence: number;
  authorityEpoch: string;
}

export interface DesiredStateMessage extends CoreMessageBase {
  type: 'state.desired';
  revision: number;
  value: string;
}

export interface CommandIssueMessage extends CoreMessageBase {
  type: 'command.issue';
  commandId: string;
  idempotencyKey: string;
  requestDigest: string;
  executionClass: ExecutionClass;
}

export type CoreToEdgeMessage = DesiredStateMessage | CommandIssueMessage;

export interface InboxRecord {
  messageId: string;
  type: CoreToEdgeMessage['type'];
  streamEpoch: string;
  sequence: number;
}

export interface CommandReceipt {
  commandId: string;
  idempotencyKey: string;
  requestDigest: string;
  executionClass: ExecutionClass;
  state: CommandReceiptState;
  executionAttempts: number;
  result: string | null;
  uncertainty: string | null;
}

export type OutboxEventClass = 'telemetry' | 'command_result' | 'security_result';
export type StoredOutboxClass = OutboxEventClass | 'tombstone';
export type OutboxRetention = 'policy_droppable' | 'until_ack';

export interface EdgeOutboxIntent {
  kind: string;
  eventClass: OutboxEventClass;
  ref: string;
  units?: number;
  replayed?: boolean;
}

export interface EdgeOutboxRecord {
  streamEpoch: string;
  sequence: number;
  kind: string;
  originalKind: string | null;
  eventClass: StoredOutboxClass;
  retention: OutboxRetention;
  ref: string;
  units: number;
  replayed: boolean;
}

export interface EdgeDurableState {
  coreStreamEpoch: string;
  edgeStreamEpoch: string;
  authorityEpoch: string;
  lastCoreSequence: number;
  lastEdgeAckedSequence: number;
  nextEdgeSequence: number;
  restoreGeneration: number;
  inbox: InboxRecord[];
  desiredState: { revision: number; value: string } | null;
  commandReceipts: CommandReceipt[];
  outbox: EdgeOutboxRecord[];
  outboxCapacity: number;
  telemetryShedBeforeSequence: number;
  telemetryTombstonedAfterSequence: number;
  storageDegraded: boolean;
}

export interface EdgeDurableStoreOptions {
  coreStreamEpoch: string;
  edgeStreamEpoch: string;
  authorityEpoch: string;
  outboxCapacity?: number;
}

/**
 * Copy-on-write transactions stand in for a durable database transaction.
 * Only the committed copy survives construction of a new EdgeRuntime.
 */
export class EdgeDurableStore {
  private state: EdgeDurableState;

  constructor(options: EdgeDurableStoreOptions) {
    const outboxCapacity = options.outboxCapacity ?? 64;
    if (!Number.isSafeInteger(outboxCapacity) || outboxCapacity < 1) {
      throw new RangeError('outboxCapacity must be a positive safe integer');
    }

    this.state = {
      coreStreamEpoch: options.coreStreamEpoch,
      edgeStreamEpoch: options.edgeStreamEpoch,
      authorityEpoch: options.authorityEpoch,
      lastCoreSequence: 0,
      lastEdgeAckedSequence: 0,
      nextEdgeSequence: 1,
      restoreGeneration: 0,
      inbox: [],
      desiredState: null,
      commandReceipts: [],
      outbox: [],
      outboxCapacity,
      telemetryShedBeforeSequence: 0,
      telemetryTombstonedAfterSequence: 0,
      storageDegraded: false,
    };
  }

  commit(mutator: (candidate: EdgeDurableState) => void): void {
    const candidate = structuredClone(this.state);
    mutator(candidate);
    this.state = candidate;
  }

  snapshot(): EdgeDurableState {
    return structuredClone(this.state);
  }
}

export interface ExternalEffectCall {
  commandId: string;
  idempotencyKey: string;
  ordinal: number;
}

/** Represents state outside the Edge transaction boundary. */
export class ExternalEffectProbe {
  private readonly recordedCalls: ExternalEffectCall[] = [];

  perform(commandId: string, idempotencyKey: string): string {
    const ordinal = this.recordedCalls.filter((call) => call.commandId === commandId).length + 1;
    this.recordedCalls.push({ commandId, idempotencyKey, ordinal });
    return `effect:${commandId}:${ordinal}`;
  }

  count(commandId: string): number {
    return this.recordedCalls.filter((call) => call.commandId === commandId).length;
  }

  calls(): readonly ExternalEffectCall[] {
    return structuredClone(this.recordedCalls);
  }
}

export interface QueueOutcome {
  status: 'queued' | 'shed_before_sequence' | 'storage_degraded';
  sequence: number | null;
}

function usedOutboxCapacity(state: EdgeDurableState): number {
  return state.outbox.reduce((sum, record) => sum + record.units, 0);
}

function enqueueOutbox(state: EdgeDurableState, intent: EdgeOutboxIntent): QueueOutcome {
  const units = intent.units ?? 1;
  if (!Number.isSafeInteger(units) || units < 1) {
    throw new RangeError('outbox event units must be a positive safe integer');
  }

  let used = usedOutboxCapacity(state);

  if (intent.eventClass === 'telemetry' && used + units > state.outboxCapacity) {
    state.telemetryShedBeforeSequence += 1;
    return { status: 'shed_before_sequence', sequence: null };
  }

  if (intent.eventClass !== 'telemetry') {
    for (const candidate of state.outbox) {
      if (used + units <= state.outboxCapacity) {
        break;
      }
      if (candidate.eventClass !== 'telemetry') {
        continue;
      }

      used -= candidate.units;
      candidate.originalKind = candidate.kind;
      candidate.kind = 'stream.tombstone';
      candidate.eventClass = 'tombstone';
      candidate.retention = 'until_ack';
      candidate.units = 0;
      candidate.replayed = false;
      state.telemetryTombstonedAfterSequence += 1;
    }
  }

  if (used + units > state.outboxCapacity) {
    state.storageDegraded = true;
    return { status: 'storage_degraded', sequence: null };
  }

  const sequence = state.nextEdgeSequence;
  state.nextEdgeSequence += 1;
  state.outbox.push({
    streamEpoch: state.edgeStreamEpoch,
    sequence,
    kind: intent.kind,
    originalKind: null,
    eventClass: intent.eventClass,
    retention: intent.eventClass === 'telemetry' ? 'policy_droppable' : 'until_ack',
    ref: intent.ref,
    units,
    replayed: intent.replayed ?? false,
  });

  return { status: 'queued', sequence };
}

function isTerminal(state: CommandReceiptState): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'cancelled'
    || state === 'unknown_outcome';
}

function receiptEventKind(state: CommandReceiptState): string {
  switch (state) {
    case 'received':
      return 'command.received';
    case 'accepted':
      return 'command.accepted';
    case 'running':
      return 'command.started';
    case 'completed':
      return 'command.completed';
    case 'failed':
      return 'command.failed';
    case 'cancelled':
      return 'command.cancelled';
    case 'unknown_outcome':
      return 'command.unknown_outcome';
  }
}

function queueReceiptState(
  state: EdgeDurableState,
  receipt: CommandReceipt,
  replayed: boolean,
): void {
  const outcome = enqueueOutbox(state, {
    kind: receiptEventKind(receipt.state),
    eventClass: 'command_result',
    ref: receipt.commandId,
    replayed,
  });

  if (outcome.status !== 'queued') {
    throw new OutboxCapacityError(`could not durably queue ${receiptEventKind(receipt.state)}`);
  }
}

function findReceipt(state: EdgeDurableState, commandId: string): CommandReceipt | undefined {
  return state.commandReceipts.find((receipt) => receipt.commandId === commandId);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface StreamAck {
  streamEpoch: string;
  acknowledgedSequence: number;
}

export interface ReceiveOutcome {
  status: 'committed' | 'duplicate_transport' | 'gap' | 'stale_stream_epoch' | 'stale_authority_epoch';
  expectedSequence: number;
  ack: StreamAck | null;
  receiptState: CommandReceiptState | null;
  commandWasDuplicate: boolean;
}

export interface CommandRunOutcome {
  receipt: CommandReceipt;
  replayed: boolean;
}

export interface RestoreReset {
  reason: 'restore' | 'history_truncated' | 'cursor_invalid' | 'operator_reset';
  previousCoreStreamEpoch: string;
  newCoreStreamEpoch: string;
  newAuthorityEpoch: string;
}

export interface OutboxAckOutcome {
  status: 'committed' | 'duplicate' | 'stale_stream_epoch';
  acknowledgedSequence: number;
}

export class EdgeRuntime {
  private readonly emittedAcks: StreamAck[] = [];

  constructor(
    readonly store: EdgeDurableStore,
    readonly effects: ExternalEffectProbe,
  ) {}

  get sentAcks(): readonly StreamAck[] {
    return structuredClone(this.emittedAcks);
  }

  receive(message: CoreToEdgeMessage, fault: FaultPoint | null = null): ReceiveOutcome {
    const before = this.store.snapshot();
    const expectedSequence = before.lastCoreSequence + 1;

    if (message.streamEpoch !== before.coreStreamEpoch) {
      return {
        status: 'stale_stream_epoch',
        expectedSequence,
        ack: null,
        receiptState: null,
        commandWasDuplicate: false,
      };
    }

    if (message.authorityEpoch !== before.authorityEpoch) {
      return {
        status: 'stale_authority_epoch',
        expectedSequence,
        ack: null,
        receiptState: null,
        commandWasDuplicate: false,
      };
    }

    if (message.sequence <= before.lastCoreSequence) {
      const committed = before.inbox.find((record) => (
        record.streamEpoch === message.streamEpoch && record.sequence === message.sequence
      ));
      if (committed?.messageId !== message.messageId || committed.type !== message.type) {
        throw new ProtocolInvariantError('a committed stream position was replayed with different content');
      }

      const ack = {
        streamEpoch: before.coreStreamEpoch,
        acknowledgedSequence: before.lastCoreSequence,
      };
      this.emittedAcks.push(ack);
      const receiptState = message.type === 'command.issue'
        ? findReceipt(before, message.commandId)?.state ?? null
        : null;
      return {
        status: 'duplicate_transport',
        expectedSequence,
        ack,
        receiptState,
        commandWasDuplicate: message.type === 'command.issue',
      };
    }

    if (message.sequence !== expectedSequence) {
      return {
        status: 'gap',
        expectedSequence,
        ack: null,
        receiptState: null,
        commandWasDuplicate: false,
      };
    }

    crashIf(fault, 'before_inbox_commit');

    let receiptState: CommandReceiptState | null = null;
    let commandWasDuplicate = false;

    this.store.commit((state) => {
      state.inbox.push({
        messageId: message.messageId,
        type: message.type,
        streamEpoch: message.streamEpoch,
        sequence: message.sequence,
      });

      if (message.type === 'state.desired') {
        if (state.desiredState === null || message.revision > state.desiredState.revision) {
          state.desiredState = { revision: message.revision, value: message.value };
        }
      } else {
        const byCommandId = findReceipt(state, message.commandId);
        const byIdempotencyKey = state.commandReceipts.find(
          (receipt) => receipt.idempotencyKey === message.idempotencyKey,
        );
        if (byCommandId !== undefined && byIdempotencyKey !== undefined && byCommandId !== byIdempotencyKey) {
          throw new ProtocolInvariantError('command ID and idempotency key identify different receipts');
        }

        const existing = byCommandId ?? byIdempotencyKey;
        if (existing !== undefined) {
          if (
            existing.commandId !== message.commandId
            || existing.idempotencyKey !== message.idempotencyKey
            || existing.requestDigest !== message.requestDigest
            || existing.executionClass !== message.executionClass
          ) {
            throw new ProtocolInvariantError('idempotency identity was reused with different command content');
          }
          commandWasDuplicate = true;
          receiptState = existing.state;
          queueReceiptState(state, existing, true);
        } else {
          const receipt: CommandReceipt = {
            commandId: message.commandId,
            idempotencyKey: message.idempotencyKey,
            requestDigest: message.requestDigest,
            executionClass: message.executionClass,
            state: 'received',
            executionAttempts: 0,
            result: null,
            uncertainty: null,
          };
          state.commandReceipts.push(receipt);
          receiptState = receipt.state;
          queueReceiptState(state, receipt, false);
        }
      }

      state.lastCoreSequence = message.sequence;
    });

    crashIf(fault, 'after_inbox_commit_before_ack');

    const ack: StreamAck = {
      streamEpoch: message.streamEpoch,
      acknowledgedSequence: message.sequence,
    };
    this.emittedAcks.push(ack);
    return {
      status: 'committed',
      expectedSequence,
      ack,
      receiptState,
      commandWasDuplicate,
    };
  }

  runCommand(commandId: string, fault: FaultPoint | null = null): CommandRunOutcome {
    let receipt = this.requireReceipt(commandId);
    if (isTerminal(receipt.state)) {
      return { receipt, replayed: true };
    }

    if (receipt.state === 'running' && receipt.executionClass === 'non_repeatable') {
      return this.markUnknownOutcome(commandId);
    }

    if (receipt.state === 'received') {
      this.store.commit((state) => {
        const candidate = this.requireReceiptFrom(state, commandId);
        candidate.state = 'accepted';
        queueReceiptState(state, candidate, false);
      });
      crashIf(fault, 'after_accept_commit_before_running');
      receipt = this.requireReceipt(commandId);
    }

    if (receipt.state === 'accepted') {
      this.store.commit((state) => {
        const candidate = this.requireReceiptFrom(state, commandId);
        candidate.state = 'running';
        candidate.executionAttempts += 1;
        queueReceiptState(state, candidate, false);
      });
    } else if (receipt.state === 'running' && receipt.executionClass === 'replay_safe') {
      this.store.commit((state) => {
        const candidate = this.requireReceiptFrom(state, commandId);
        candidate.executionAttempts += 1;
        queueReceiptState(state, candidate, true);
      });
    } else {
      throw new ProtocolInvariantError(`command ${commandId} cannot run from ${receipt.state}`);
    }

    crashIf(fault, 'after_running_commit_before_effect');

    receipt = this.requireReceipt(commandId);
    const effectResult = this.effects.perform(receipt.commandId, receipt.idempotencyKey);

    crashIf(fault, 'after_external_effect_before_result_commit');

    this.store.commit((state) => {
      const candidate = this.requireReceiptFrom(state, commandId);
      candidate.state = 'completed';
      candidate.result = effectResult;
      candidate.uncertainty = null;
      queueReceiptState(state, candidate, false);
    });

    crashIf(fault, 'after_result_commit_before_publish');

    return { receipt: this.requireReceipt(commandId), replayed: false };
  }

  recoverCommands(): readonly CommandRunOutcome[] {
    const commandIds = this.store.snapshot().commandReceipts
      .filter((receipt) => !isTerminal(receipt.state))
      .map((receipt) => receipt.commandId)
      .sort(compareIds);
    return commandIds.map((commandId) => this.runCommand(commandId));
  }

  queueEdgeEvent(intent: EdgeOutboxIntent): QueueOutcome {
    let outcome: QueueOutcome = { status: 'storage_degraded', sequence: null };
    this.store.commit((state) => {
      outcome = enqueueOutbox(state, intent);
    });
    return outcome;
  }

  pendingOutbox(): readonly EdgeOutboxRecord[] {
    return this.store.snapshot().outbox;
  }

  usedOutboxCapacity(): number {
    return usedOutboxCapacity(this.store.snapshot());
  }

  acknowledgeOutbox(
    streamEpoch: string,
    acknowledgedSequence: number,
    fault: FaultPoint | null = null,
  ): OutboxAckOutcome {
    const before = this.store.snapshot();
    if (streamEpoch !== before.edgeStreamEpoch) {
      return {
        status: 'stale_stream_epoch',
        acknowledgedSequence: before.lastEdgeAckedSequence,
      };
    }
    if (acknowledgedSequence <= before.lastEdgeAckedSequence) {
      return {
        status: 'duplicate',
        acknowledgedSequence: before.lastEdgeAckedSequence,
      };
    }
    if (acknowledgedSequence >= before.nextEdgeSequence) {
      throw new ProtocolInvariantError('outbox ACK exceeds the highest assigned sequence');
    }

    crashIf(fault, 'before_outbox_ack_commit');
    this.store.commit((state) => {
      state.lastEdgeAckedSequence = acknowledgedSequence;
      state.outbox = state.outbox.filter((record) => record.sequence > acknowledgedSequence);
    });
    crashIf(fault, 'after_outbox_ack_commit');

    return { status: 'committed', acknowledgedSequence };
  }

  applyRestoreReset(reset: RestoreReset): void {
    const before = this.store.snapshot();
    if (reset.previousCoreStreamEpoch !== before.coreStreamEpoch) {
      throw new ProtocolInvariantError('restore/reset previous stream epoch does not match durable state');
    }
    if (reset.newCoreStreamEpoch === reset.previousCoreStreamEpoch) {
      throw new ProtocolInvariantError('restore/reset must rotate the Core stream epoch');
    }

    this.store.commit((state) => {
      state.coreStreamEpoch = reset.newCoreStreamEpoch;
      state.authorityEpoch = reset.newAuthorityEpoch;
      state.lastCoreSequence = 0;
      state.desiredState = null;
      state.restoreGeneration += 1;
    });
  }

  private markUnknownOutcome(commandId: string): CommandRunOutcome {
    this.store.commit((state) => {
      const receipt = this.requireReceiptFrom(state, commandId);
      if (receipt.state !== 'running' || receipt.executionClass !== 'non_repeatable') {
        throw new ProtocolInvariantError(`command ${commandId} is not an uncertain non-repeatable operation`);
      }
      receipt.state = 'unknown_outcome';
      receipt.result = null;
      receipt.uncertainty = 'process_crashed_after_execution_may_have_started';
      queueReceiptState(state, receipt, false);
    });
    return { receipt: this.requireReceipt(commandId), replayed: false };
  }

  private requireReceipt(commandId: string): CommandReceipt {
    const receipt = findReceipt(this.store.snapshot(), commandId);
    if (receipt === undefined) {
      throw new ProtocolInvariantError(`unknown command ${commandId}`);
    }
    return receipt;
  }

  private requireReceiptFrom(state: EdgeDurableState, commandId: string): CommandReceipt {
    const receipt = findReceipt(state, commandId);
    if (receipt === undefined) {
      throw new ProtocolInvariantError(`unknown command ${commandId}`);
    }
    return receipt;
  }
}
