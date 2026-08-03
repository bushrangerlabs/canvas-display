/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: contracts/device/v1/control-message.schema.json
 * Regenerate with: npm run contracts:generate:ts
 */

/**
 * Canvas Core to Canvas Edge control-plane message contract.
 */
export type DeviceV1ControlMessage =
  | EdgeHello
  | CoreWelcome
  | EdgeHeartbeat
  | CoreHeartbeat
  | StreamAck
  | StreamReset
  | StateDesired
  | StateReported
  | DiagnosticsEchoCommandIssue
  | CommandReceived
  | CommandCompleted
  | CommandRejected
  | CommandFailed
  | CommandCancelled
  | CommandUnknownOutcome
  | ProtocolError;
export type Uuid = string;
export type Timestamp = string;
export type Sha256Digest = string;

export interface EdgeHello {
  type: 'edge.hello';
  message_id: Uuid;
  sent_at: Timestamp;
  protocol: ProtocolRange;
  agent: AgentInfo;
  resume: ResumeCursor;
  capabilities: EdgeCapabilities;
  /**
   * Optional, NON-AUTHORITATIVE device identifier supplied for bootstrap/diagnostics only (plan doc §12.4). In the production protocol Core derives device identity from the authenticated mTLS connection and MUST treat any payload `device_id` as untrusted; it is ignored for authorization. The bootstrap Device Gateway may record it as a convenience key when no stronger identity exists yet.
   */
  device_id?: string;
  /**
   * P-003 enrollment gate: optional stable Edge installation identifier. When open pairing is OFF, Core's gateway matches this against the paired `device_credentials` registry to authorize the hello without requiring the full credential block be re-presented on every reconnect.
   */
  installation_id?: string;
  /**
   * P-003 enrollment gate: optional SHA-256 hex of the device's raw 32-byte Ed25519 public key (matches `EdgeIdentity::public_key_fingerprint()`). Core recomputes this from the enrolled public key and never trusts it as a self-reported claim; presenting it here lets the gateway match the hello to a paired registry row by fingerprint.
   */
  public_key_fingerprint?: string;
  /**
   * Optional one-time invitation token (P-003 bootstrap). If present and valid, the bootstrap Device Gateway may mark the device paired/known. A plain hello (no token) continues to work exactly as before when open pairing is ON.
   */
  invitation_token?: string;
  credential?: DeviceCredentialEnvelope;
  [k: string]: unknown | undefined;
}
export interface ProtocolRange {
  minimum: number;
  maximum: number;
  [k: string]: unknown | undefined;
}
export interface AgentInfo {
  version: string;
  platform: 'linux';
  architecture: 'amd64' | 'arm64';
  [k: string]: unknown | undefined;
}
export interface ResumeCursor {
  core_stream_epoch?: Uuid;
  edge_stream_epoch?: Uuid;
  last_core_sequence?: number;
  last_edge_sequence_acked?: number;
  [k: string]: unknown | undefined;
}
export interface EdgeCapabilities {
  renderer: string[];
  media: string[];
  voice: string[];
  hardware: string[];
  [k: string]: unknown | undefined;
}
/**
 * P-003 enrollment gate: optional Phase 0 signed credential issued by Core's enrollment endpoint. When open pairing is OFF, the gateway verifies the Core signature over the canonical credential JSON and matches it to the paired registry. Present on every reconnect after a successful enrollment so the device does not need to re-enroll.
 */
export interface DeviceCredentialEnvelope {
  credential: DeviceCredential;
  /**
   * Base64 Ed25519 signature over the canonical (sorted-key) JSON of the embedded `credential` object, produced by Core's enrollment signing key.
   */
  signature: string;
  /**
   * Base64 raw 32-byte Ed25519 public key that produced `signature`. Optional on the wire (Core has its own record of the signing key); included so the Edge can log/verify it without a separate channel.
   */
  signer_public_key?: string;
}
export interface DeviceCredential {
  format: 'canvas-phase0-device-credential-v1';
  serial: number;
  device_id: string;
  installation_id: string;
  public_key_fingerprint: string;
  issued_at_unix_ms: number;
  expires_at_unix_ms: number;
  issuer_id: string;
  security_epoch: number;
}
export interface CoreWelcome {
  type: 'core.welcome';
  message_id: Uuid;
  sent_at: Timestamp;
  protocol: 1;
  session_id: Uuid;
  heartbeat_seconds: number;
  core_time: Timestamp;
  resume: {
    accepted: boolean;
    core_stream_epoch: Uuid;
    edge_stream_epoch: Uuid;
    next_core_sequence: number;
    [k: string]: unknown | undefined;
  };
  desired_revision: number;
  [k: string]: unknown | undefined;
}
export interface EdgeHeartbeat {
  type: 'edge.heartbeat';
  protocol: 1;
  sent_at: Timestamp;
  stream_epoch: Uuid;
  last_received_sequence: number;
  [k: string]: unknown | undefined;
}
export interface CoreHeartbeat {
  type: 'core.heartbeat';
  protocol: 1;
  sent_at: Timestamp;
  stream_epoch: Uuid;
  last_received_sequence: number;
  [k: string]: unknown | undefined;
}
export interface StreamAck {
  type: 'stream.ack';
  protocol: 1;
  sent_at: Timestamp;
  stream_epoch: Uuid;
  acknowledged_sequence: number;
  [k: string]: unknown | undefined;
}
export interface StreamReset {
  type: 'stream.reset';
  protocol: 1;
  message_id: Uuid;
  sent_at: Timestamp;
  previous_stream_epoch: Uuid;
  new_stream_epoch: Uuid;
  reason: 'history_truncated' | 'restore' | 'cursor_invalid' | 'operator_reset';
  desired_revision: number;
  [k: string]: unknown | undefined;
}
export interface StateDesired {
  type: 'state.desired';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id?: Uuid;
  payload: {
    authority_epoch: Uuid;
    revision: number;
    desired_digest: Sha256Digest;
    state: DesiredState;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface DesiredState {
  scene?: {
    revision_id: string;
    /**
     * Optional inline page document for renderers that do not share Core storage.
     */
    page?: {
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  display?: {
    power?: 'on' | 'off';
    brightness?: number;
    [k: string]: unknown | undefined;
  };
  audio?: {
    volume?: number;
    [k: string]: unknown | undefined;
  };
  voice?: {
    enabled?: boolean;
    wake_word?: string;
    [k: string]: unknown | undefined;
  };
  update?: {
    channel?: string;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface StateReported {
  type: 'state.reported';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id?: Uuid;
  payload: {
    authority_epoch: Uuid;
    desired_revision: number;
    processed_desired_revision: number;
    applied_revision: number;
    reported_revision: number;
    status: 'pending' | 'applied' | 'partially_applied' | 'diverged' | 'failed';
    state: ReportedState;
    application: {
      [k: string]: DomainApplication | undefined;
    };
    divergences: Divergence[];
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface ReportedState {
  scene?: {
    revision_id?: string;
    status?: 'staging' | 'active' | 'failed' | 'rolled_back';
    [k: string]: unknown | undefined;
  };
  display?: {
    power?: 'on' | 'off';
    brightness?: number;
    [k: string]: unknown | undefined;
  };
  connectivity?: {
    core?: 'online' | 'degraded' | 'offline';
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface DomainApplication {
  desired_revision: number;
  status: 'pending' | 'applied' | 'diverged' | 'failed' | 'unsupported';
  reason?: string;
  [k: string]: unknown | undefined;
}
export interface Divergence {
  path: string;
  desired: unknown;
  actual: unknown;
  reason: string;
  [k: string]: unknown | undefined;
}
export interface DiagnosticsEchoCommandIssue {
  type: 'command.issue';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  expires_at: Timestamp;
  correlation_id: Uuid;
  payload: {
    command_id: Uuid;
    idempotency_key: string;
    request_digest: Sha256Digest;
    kind: 'diagnostics.echo';
    execution_class: 'replay_safe';
    parameters: {
      message: string;
    };
    created_at: Timestamp;
    not_before: Timestamp;
    max_clock_uncertainty_ms: number;
  };
  [k: string]: unknown | undefined;
}
export interface CommandReceived {
  type: 'command.received';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id: Uuid;
  payload: CommandReceiptPayload & {
    duplicate: boolean;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface CommandReceiptPayload {
  command_id: Uuid;
  idempotency_key: string;
  request_digest: Sha256Digest;
  [k: string]: unknown | undefined;
}
export interface CommandCompleted {
  type: 'command.completed';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id: Uuid;
  payload: CommandReceiptPayload & {
    replayed: boolean;
    result: {
      echoed: string;
      [k: string]: unknown | undefined;
    };
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface CommandRejected {
  type: 'command.rejected';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id: Uuid;
  payload: CommandReceiptPayload & {
    code: 'idempotency_conflict' | 'expired' | 'clock_untrusted' | 'unsupported' | 'precondition_failed';
    message: string;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface CommandFailed {
  type: 'command.failed';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id: Uuid;
  payload: CommandReceiptPayload & {
    code: string;
    message: string;
    retryable: boolean;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface CommandCancelled {
  type: 'command.cancelled';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id: Uuid;
  payload: CommandReceiptPayload;
  [k: string]: unknown | undefined;
}
export interface CommandUnknownOutcome {
  type: 'command.unknown_outcome';
  protocol: 1;
  payload_version: 1;
  message_id: Uuid;
  stream_epoch: Uuid;
  sequence: number;
  sent_at: Timestamp;
  correlation_id: Uuid;
  payload: CommandReceiptPayload & {
    message: string;
    [k: string]: unknown | undefined;
  };
  [k: string]: unknown | undefined;
}
export interface ProtocolError {
  type: 'protocol.error';
  protocol: 1;
  message_id: Uuid;
  sent_at: Timestamp;
  correlation_id?: Uuid;
  code:
    | 'invalid_message'
    | 'unsupported_protocol'
    | 'unknown_message'
    | 'idempotency_conflict'
    | 'stale_revision'
    | 'clock_untrusted'
    | 'stream_reset_required';
  message: string;
  [k: string]: unknown | undefined;
}
