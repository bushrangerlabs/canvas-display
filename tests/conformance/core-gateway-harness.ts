import { computeCommandRequestDigestFromParts } from '../command-catalog/request-digest-v1.js';
import type {
  CoreWelcome,
  DiagnosticsEchoCommandIssue,
  EdgeHello,
  StateDesired,
  StreamAck,
} from '../../packages/protocol-ts/src/index.js';

const CORE_STREAM_EPOCH = '0190efff-0000-7000-8000-000000000010';
const EDGE_STREAM_EPOCH = '0190efff-0000-7000-8000-000000000011';
const AUTHORITY_EPOCH = '0190efff-0000-7000-8000-000000000001';

export class CoreGatewayHarness {
  private nextCoreSequence = 1;
  private idCounter = 500;

  constructor(private readonly now: () => string = () => '2026-07-18T10:00:00.000Z') {}

  get coreStreamEpoch(): string {
    return CORE_STREAM_EPOCH;
  }

  get edgeStreamEpoch(): string {
    return EDGE_STREAM_EPOCH;
  }

  acceptHello(hello: EdgeHello): CoreWelcome {
    if (hello.protocol.minimum > 1 || hello.protocol.maximum < 1) {
      throw new Error('Edge and Core have no mutually supported protocol version.');
    }

    const resumeAccepted =
      hello.resume.core_stream_epoch === CORE_STREAM_EPOCH &&
      hello.resume.edge_stream_epoch === EDGE_STREAM_EPOCH &&
      (hello.resume.last_core_sequence ?? 0) <= this.nextCoreSequence - 1;

    return {
      type: 'core.welcome',
      message_id: this.nextId(),
      sent_at: this.now(),
      protocol: 1,
      session_id: this.nextId(),
      heartbeat_seconds: 20,
      core_time: this.now(),
      resume: {
        accepted: resumeAccepted,
        core_stream_epoch: CORE_STREAM_EPOCH,
        edge_stream_epoch: EDGE_STREAM_EPOCH,
        next_core_sequence: this.nextCoreSequence,
      },
      desired_revision: 1,
    };
  }

  desiredState(revision = 1, digestCharacter = 'a'): StateDesired {
    return {
      type: 'state.desired',
      protocol: 1,
      payload_version: 1,
      message_id: this.nextId(),
      stream_epoch: CORE_STREAM_EPOCH,
      sequence: this.takeCoreSequence(),
      sent_at: this.now(),
      payload: {
        authority_epoch: AUTHORITY_EPOCH,
        revision,
        desired_digest: `sha256:${digestCharacter.repeat(64)}`,
        state: {
          scene: { revision_id: `scene_rev_${revision}` },
          display: { power: 'on', brightness: 70 },
        },
      },
    };
  }

  echoCommand(options: {
    idempotencyKey?: string;
    message?: string;
  } = {}): DiagnosticsEchoCommandIssue {
    const message = options.message ?? 'hello edge';
    const requestDigest = computeCommandRequestDigestFromParts({
      kind: 'diagnostics.echo',
      semanticVersion: 1,
      parameters: { message },
    });

    return {
      type: 'command.issue',
      protocol: 1,
      payload_version: 1,
      message_id: this.nextId(),
      stream_epoch: CORE_STREAM_EPOCH,
      sequence: this.takeCoreSequence(),
      sent_at: this.now(),
      expires_at: '2026-07-18T10:05:00.000Z',
      correlation_id: this.nextId(),
      payload: {
        command_id: this.nextId(),
        idempotency_key: options.idempotencyKey ?? 'diagnostics-echo-1',
        request_digest: requestDigest,
        kind: 'diagnostics.echo',
        execution_class: 'replay_safe',
        parameters: { message },
        created_at: '2026-07-18T09:59:59.000Z',
        not_before: '2026-07-18T10:00:00.000Z',
        max_clock_uncertainty_ms: 1000,
      },
    };
  }

  acknowledgeEdge(sequence: number): StreamAck {
    return {
      type: 'stream.ack',
      protocol: 1,
      sent_at: this.now(),
      stream_epoch: EDGE_STREAM_EPOCH,
      acknowledged_sequence: sequence,
    };
  }

  private takeCoreSequence(): number {
    const sequence = this.nextCoreSequence;
    this.nextCoreSequence += 1;
    return sequence;
  }

  private nextId(): string {
    const suffix = String(this.idCounter).padStart(12, '0');
    this.idCounter += 1;
    return `0190f200-0000-7000-8000-${suffix}`;
  }
}
