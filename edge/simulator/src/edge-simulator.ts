import type {
  CommandCompleted,
  CommandReceived,
  CommandRejected,
  CoreWelcome,
  DeviceV1ControlMessage,
  DiagnosticsEchoCommandIssue,
  EdgeHello,
  ProtocolError,
  StateDesired,
  StateReported,
  StreamAck,
} from '../../../packages/protocol-ts/src/index.js';

export interface EdgeSimulatorOptions {
  agentVersion?: string;
  architecture?: 'amd64' | 'arm64';
  coreStreamEpoch?: string;
  edgeStreamEpoch?: string;
  clockUncertaintyMs?: number;
  now?: () => string;
}

interface StoredEchoResult {
  requestDigest: string;
  echoed: string;
}

interface SequenceDecision {
  duplicate: boolean;
  error?: ProtocolError;
}

const DEFAULT_CORE_STREAM_EPOCH = '0190efff-0000-7000-8000-000000000010';
const DEFAULT_EDGE_STREAM_EPOCH = '0190efff-0000-7000-8000-000000000011';

export class EdgeSimulator {
  private readonly agentVersion: string;
  private readonly architecture: 'amd64' | 'arm64';
  private readonly clockUncertaintyMs: number;
  private readonly now: () => string;
  private coreStreamEpoch: string;
  private edgeStreamEpoch: string;
  private lastCoreSequence = 0;
  private lastEdgeSequenceAcked = 0;
  private nextEdgeSequence = 1;
  private processedDesiredRevision = 0;
  private appliedDesiredRevision = 0;
  private reportedRevision = 0;
  private desiredDigest: string | undefined;
  private authorityEpoch: string | undefined;
  private desiredState: StateDesired['payload']['state'] = {};
  private readonly coreMessageBySequence = new Map<number, string>();
  private readonly echoResults = new Map<string, StoredEchoResult>();
  private idCounter = 100;
  private desiredApplyCount = 0;
  private echoExecutionCount = 0;

  constructor(options: EdgeSimulatorOptions = {}) {
    this.agentVersion = options.agentVersion ?? '0.3.0-phase0';
    this.architecture = options.architecture ?? 'amd64';
    this.coreStreamEpoch = options.coreStreamEpoch ?? DEFAULT_CORE_STREAM_EPOCH;
    this.edgeStreamEpoch = options.edgeStreamEpoch ?? DEFAULT_EDGE_STREAM_EPOCH;
    this.clockUncertaintyMs = options.clockUncertaintyMs ?? 0;
    this.now = options.now ?? (() => '2026-07-18T10:00:00.000Z');
  }

  get snapshot() {
    return {
      appliedDesiredRevision: this.appliedDesiredRevision,
      desiredApplyCount: this.desiredApplyCount,
      echoExecutionCount: this.echoExecutionCount,
      lastCoreSequence: this.lastCoreSequence,
      lastEdgeSequenceAcked: this.lastEdgeSequenceAcked,
      nextEdgeSequence: this.nextEdgeSequence,
      processedDesiredRevision: this.processedDesiredRevision,
    } as const;
  }

  createHello(): EdgeHello {
    return {
      type: 'edge.hello',
      message_id: this.nextId(),
      sent_at: this.now(),
      protocol: { minimum: 1, maximum: 1 },
      agent: {
        version: this.agentVersion,
        platform: 'linux',
        architecture: this.architecture,
      },
      resume: {
        core_stream_epoch: this.coreStreamEpoch,
        edge_stream_epoch: this.edgeStreamEpoch,
        last_core_sequence: this.lastCoreSequence,
        last_edge_sequence_acked: this.lastEdgeSequenceAcked,
      },
      capabilities: {
        renderer: ['canvas-scene-v1'],
        media: ['youtube-iframe', 'mpv'],
        voice: ['wakeword-local', 'opus-wss'],
        hardware: ['brightness', 'dpms'],
      },
    };
  }

  handleCoreMessage(message: DeviceV1ControlMessage): DeviceV1ControlMessage[] {
    switch (message.type) {
      case 'core.welcome':
        return this.handleWelcome(message);
      case 'core.heartbeat':
        return [];
      case 'stream.ack':
        this.handleStreamAck(message);
        return [];
      case 'stream.reset':
        if (message.previous_stream_epoch !== this.coreStreamEpoch) {
          return [this.protocolError('stream_reset_required', 'Stream reset did not match the active Core epoch.')];
        }
        this.coreStreamEpoch = message.new_stream_epoch;
        this.lastCoreSequence = 0;
        this.coreMessageBySequence.clear();
        return [];
      case 'state.desired':
        return this.handleDesired(message);
      case 'command.issue':
        return this.handleEchoCommand(message);
      default:
        return [this.protocolError('unknown_message', `Edge simulator cannot consume ${message.type}.`)];
    }
  }

  private handleWelcome(message: CoreWelcome): DeviceV1ControlMessage[] {
    if (message.protocol !== 1) {
      return [this.protocolError('unsupported_protocol', `Unsupported negotiated protocol ${message.protocol}.`)];
    }
    this.coreStreamEpoch = message.resume.core_stream_epoch;
    this.edgeStreamEpoch = message.resume.edge_stream_epoch;
    return [];
  }

  private handleStreamAck(message: StreamAck): void {
    if (message.stream_epoch !== this.edgeStreamEpoch) return;
    this.lastEdgeSequenceAcked = Math.max(this.lastEdgeSequenceAcked, message.acknowledged_sequence);
  }

  private handleDesired(message: StateDesired): DeviceV1ControlMessage[] {
    const sequence = this.observeCoreSequence(message);
    if (sequence.error) return [sequence.error];

    const ack = this.acknowledge(message.sequence);
    if (sequence.duplicate) return [ack];

    if (this.authorityEpoch && message.payload.authority_epoch !== this.authorityEpoch) {
      return [ack, this.protocolError('stream_reset_required', 'Authority epoch changed without an explicit resynchronization.', message.message_id)];
    }

    if (message.payload.revision < this.processedDesiredRevision) {
      return [ack, this.protocolError('stale_revision', 'Desired revision is older than the processed revision.', message.message_id)];
    }

    if (message.payload.revision === this.processedDesiredRevision) {
      if (message.payload.desired_digest !== this.desiredDigest) {
        return [ack, this.protocolError('stale_revision', 'The same desired revision was received with a different digest.', message.message_id)];
      }
      return [ack];
    }

    this.authorityEpoch = message.payload.authority_epoch;
    this.desiredDigest = message.payload.desired_digest;
    this.desiredState = structuredClone(message.payload.state);
    this.processedDesiredRevision = message.payload.revision;
    this.appliedDesiredRevision = message.payload.revision;
    this.desiredApplyCount += 1;
    this.reportedRevision += 1;

    return [ack, this.reportAppliedState(message)];
  }

  private handleEchoCommand(message: DiagnosticsEchoCommandIssue): DeviceV1ControlMessage[] {
    const sequence = this.observeCoreSequence(message);
    if (sequence.error) return [sequence.error];

    const ack = this.acknowledge(message.sequence);
    const existing = this.echoResults.get(message.payload.idempotency_key);

    if (existing && existing.requestDigest !== message.payload.request_digest) {
      return [
        ack,
        this.rejectCommand(
          message,
          'idempotency_conflict',
          'The idempotency key was already used with a different request digest.',
        ),
      ];
    }

    if (existing) {
      return [ack, this.commandReceived(message, true), this.commandCompleted(message, existing.echoed, true)];
    }

    if (this.clockUncertaintyMs > message.payload.max_clock_uncertainty_ms) {
      return [
        ack,
        this.rejectCommand(message, 'clock_untrusted', 'Edge clock uncertainty exceeds the command policy.'),
      ];
    }

    const now = Date.parse(this.now());
    if (now >= Date.parse(message.expires_at)) {
      return [ack, this.rejectCommand(message, 'expired', 'Command expired before execution.')];
    }
    if (now < Date.parse(message.payload.not_before)) {
      return [ack, this.rejectCommand(message, 'precondition_failed', 'Command is not eligible to run yet.')];
    }

    const echoed = message.payload.parameters.message;
    this.echoExecutionCount += 1;
    this.echoResults.set(message.payload.idempotency_key, {
      requestDigest: message.payload.request_digest,
      echoed,
    });

    return [ack, this.commandReceived(message, false), this.commandCompleted(message, echoed, false)];
  }

  private observeCoreSequence(message: StateDesired | DiagnosticsEchoCommandIssue): SequenceDecision {
    if (message.stream_epoch !== this.coreStreamEpoch) {
      return {
        duplicate: false,
        error: this.protocolError('stream_reset_required', 'Message uses an inactive Core stream epoch.', message.message_id),
      };
    }

    const serialized = JSON.stringify(message);
    const prior = this.coreMessageBySequence.get(message.sequence);
    if (prior !== undefined) {
      if (prior !== serialized) {
        return {
          duplicate: true,
          error: this.protocolError('stream_reset_required', 'A Core sequence was reused for different content.', message.message_id),
        };
      }
      return { duplicate: true };
    }

    if (message.sequence !== this.lastCoreSequence + 1) {
      return {
        duplicate: false,
        error: this.protocolError('stream_reset_required', 'Core stream sequence is not contiguous.', message.message_id),
      };
    }

    this.coreMessageBySequence.set(message.sequence, serialized);
    this.lastCoreSequence = message.sequence;
    return { duplicate: false };
  }

  private acknowledge(sequence: number): StreamAck {
    return {
      type: 'stream.ack',
      protocol: 1,
      sent_at: this.now(),
      stream_epoch: this.coreStreamEpoch,
      acknowledged_sequence: sequence,
    };
  }

  private reportAppliedState(message: StateDesired): StateReported {
    const application: StateReported['payload']['application'] = {};
    if (this.desiredState.scene) application.scene = { desired_revision: message.payload.revision, status: 'applied' };
    if (this.desiredState.display) application.display = { desired_revision: message.payload.revision, status: 'applied' };
    if (this.desiredState.audio) application.audio = { desired_revision: message.payload.revision, status: 'applied' };
    if (this.desiredState.voice) application.voice = { desired_revision: message.payload.revision, status: 'applied' };
    if (this.desiredState.update) application.update = { desired_revision: message.payload.revision, status: 'applied' };

    return {
      type: 'state.reported',
      protocol: 1,
      payload_version: 1,
      message_id: this.nextId(),
      stream_epoch: this.edgeStreamEpoch,
      sequence: this.takeEdgeSequence(),
      sent_at: this.now(),
      correlation_id: message.message_id,
      payload: {
        authority_epoch: message.payload.authority_epoch,
        desired_revision: message.payload.revision,
        processed_desired_revision: message.payload.revision,
        applied_revision: message.payload.revision,
        reported_revision: this.reportedRevision,
        status: 'applied',
        state: {
          scene: this.desiredState.scene ? { ...this.desiredState.scene, status: 'active' } : undefined,
          display: this.desiredState.display ? { ...this.desiredState.display } : undefined,
          connectivity: { core: 'online' },
        },
        application,
        divergences: [],
      },
    };
  }

  private commandReceived(message: DiagnosticsEchoCommandIssue, duplicate: boolean): CommandReceived {
    return {
      type: 'command.received',
      protocol: 1,
      payload_version: 1,
      message_id: this.nextId(),
      stream_epoch: this.edgeStreamEpoch,
      sequence: this.takeEdgeSequence(),
      sent_at: this.now(),
      correlation_id: message.correlation_id,
      payload: {
        command_id: message.payload.command_id,
        idempotency_key: message.payload.idempotency_key,
        request_digest: message.payload.request_digest,
        duplicate,
      },
    };
  }

  private commandCompleted(
    message: DiagnosticsEchoCommandIssue,
    echoed: string,
    replayed: boolean,
  ): CommandCompleted {
    return {
      type: 'command.completed',
      protocol: 1,
      payload_version: 1,
      message_id: this.nextId(),
      stream_epoch: this.edgeStreamEpoch,
      sequence: this.takeEdgeSequence(),
      sent_at: this.now(),
      correlation_id: message.correlation_id,
      payload: {
        command_id: message.payload.command_id,
        idempotency_key: message.payload.idempotency_key,
        request_digest: message.payload.request_digest,
        replayed,
        result: { echoed },
      },
    };
  }

  private rejectCommand(
    message: DiagnosticsEchoCommandIssue,
    code: CommandRejected['payload']['code'],
    rejectionMessage: string,
  ): CommandRejected {
    return {
      type: 'command.rejected',
      protocol: 1,
      payload_version: 1,
      message_id: this.nextId(),
      stream_epoch: this.edgeStreamEpoch,
      sequence: this.takeEdgeSequence(),
      sent_at: this.now(),
      correlation_id: message.correlation_id,
      payload: {
        command_id: message.payload.command_id,
        idempotency_key: message.payload.idempotency_key,
        request_digest: message.payload.request_digest,
        code,
        message: rejectionMessage,
      },
    };
  }

  private protocolError(code: ProtocolError['code'], message: string, correlationId?: string): ProtocolError {
    return {
      type: 'protocol.error',
      protocol: 1,
      message_id: this.nextId(),
      sent_at: this.now(),
      correlation_id: correlationId,
      code,
      message,
    };
  }

  private takeEdgeSequence(): number {
    const sequence = this.nextEdgeSequence;
    this.nextEdgeSequence += 1;
    return sequence;
  }

  private nextId(): string {
    const suffix = String(this.idCounter).padStart(12, '0');
    this.idCounter += 1;
    return `0190f100-0000-7000-8000-${suffix}`;
  }
}
