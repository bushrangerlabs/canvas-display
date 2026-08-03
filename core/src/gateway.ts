import type { FastifyInstance } from 'fastify';
import type { CoreConfig } from './config.js';
import { getPool } from './db.js';
import { recordDeviceHello } from './devices.js';
import { reportState, type ReportedStatus } from './state.js';
import {
  findCredentialByFingerprint,
  verifyDeviceCredential,
  type EnrollmentSigner,
} from './enrollment.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthorityMode } from './devices.js';

/**
 * Device Gateway (protocol v1, plan doc §12). This is the single WSS endpoint every
 * Edge device connects to (D-009: Core is the only hub). For Phase 2 bootstrap this
 * accepts the `hello` message, records the device in PostgreSQL, and echoes a `welcome`
 * plus a periodic `heartbeat`. Full command/state/ACK handling lands in later Phase 2
 * checklist items; the wire contract is already frozen in `contracts/device/v1`.
 *
 * Security note: production terminates mTLS at the reverse proxy (P-013) and forwards
 * verified identity; this bootstrap accepts any connection so we can develop against a
 * real Edge Agent, and must NOT be exposed to untrusted networks as-is.
 */

interface HelloMessage {
  type: 'edge.hello';
  message_id?: string;
  /** Optional, NON-AUTHORITATIVE bootstrap/diagnostics identity (plan doc §12.4). Core derives
   * the real device identity from the authenticated mTLS connection in production and ignores this
   * for authorization; the bootstrap gateway records it only as a convenience key. */
  device_id?: string;
  agent?: { version?: string; platform?: string; architecture?: string };
  protocol?: { minimum?: number; maximum?: number };
  resume?: {
    core_stream_epoch?: string;
    edge_stream_epoch?: string;
    last_core_sequence?: number;
    last_edge_sequence_acked?: number;
  };
  capabilities?: {
    renderer?: string[];
    media?: string[];
    voice?: string[];
    hardware?: string[];
  };
  /** Phase 2 pairing scaffold (P-003 bootstrap): an optional one-time invitation token.
   * If present and valid, the device is marked paired/known. Plain hello (no token)
   * continues to work exactly as before — the proven Edge↔Core link is unchanged. */
  invitation_token?: string;
  /** P-003 enrollment gate: an enrolled device may present its Phase 0 signed credential so
   * Core can match it to the registry even when open pairing is disabled. */
  credential?: {
    credential: {
      format: 'canvas-phase0-device-credential-v1';
      serial: number;
      device_id: string;
      installation_id: string;
      public_key_fingerprint: string;
      issued_at_unix_ms: number;
      expires_at_unix_ms: number;
      issuer_id: string;
      security_epoch: number;
    };
    signature: string; // base64 Ed25519 signature over canonical credential JSON
  };
  /** P-003 enrollment gate: an enrolled device may present its public-key fingerprint (the
   * SHA-256 hex of its raw Ed25519 public key) so Core can match it to the registry. */
  public_key_fingerprint?: string;
  /** P-003 enrollment gate: an enrolled device may present its installation ID. */
  installation_id?: string;
  /** Phase 2 state-ownership scaffold: an optional initial reported-state payload the
   * device may attach to its hello (e.g. its current display/connectivity status).
   * Recording it is ADDITIVE — the existing open hello path is unchanged and a hello
   * without this field works exactly as before. The contract's canonical reported-state
   * message is `state.reported`; this inline field is a bootstrap convenience only. */
  reported_state?: {
    domain?: string;
    state?: unknown;
    status?: ReportedStatus;
  };
}

interface WelcomeMessage {
  type: 'core.welcome';
  message_id: string;
  sent_at: string;
  protocol: number;
  session_id: string;
  heartbeat_seconds: number;
  core_time: string;
  resume: {
    accepted: boolean;
    core_stream_epoch: string;
    edge_stream_epoch: string;
    next_core_sequence: number;
  };
  desired_revision: number;
}

export interface CoreHeartbeatMessage {
  type: 'core.heartbeat';
  protocol: 1;
  sent_at: string;
  stream_epoch: string;
  last_received_sequence: number;
}

interface GatewayConnection {
  ws: WebSocket;
  coreStreamEpoch: string;
  authorityEpoch: string;
  nextCoreSequence: number;
}

export interface CommandResult {
  type: 'command.completed' | 'command.rejected' | 'command.failed';
  payload: Record<string, unknown>;
}

export interface StateResult {
  type: 'state.reported';
  payload: Record<string, unknown>;
}

interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function commandRequestDigest(
  kind: string,
  semanticVersion: number,
  parameters: Record<string, unknown>,
): string {
  // The frozen digest profile canonicalizes object keys lexicographically. These four fields and
  // diagnostics.echo's bounded string parameter have no nested unordered objects, so constructing
  // them in canonical key order is byte-identical to canvas.command.request/v1.
  const canonical = JSON.stringify({
    kind,
    parameters,
    preconditions: {},
    semantic_version: semanticVersion,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class GatewayController {
  private readonly connections = new Map<string, GatewayConnection>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pendingState = new Map<
    string,
    {
      resolve: (result: StateResult) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  attach(deviceId: string, connection: GatewayConnection): void {
    this.connections.set(deviceId, connection);
  }

  detach(deviceId: string, ws: WebSocket): void {
    if (this.connections.get(deviceId)?.ws === ws) this.connections.delete(deviceId);
  }

  connectedDeviceIds(): string[] {
    return [...this.connections.keys()];
  }

  observe(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const envelope = message as { type?: unknown; payload?: unknown; correlation_id?: unknown };
    if (
      envelope.type === 'state.reported' &&
      typeof envelope.correlation_id === 'string' &&
      envelope.payload &&
      typeof envelope.payload === 'object'
    ) {
      const waiting = this.pendingState.get(envelope.correlation_id);
      if (!waiting) return false;
      clearTimeout(waiting.timer);
      this.pendingState.delete(envelope.correlation_id);
      waiting.resolve({ type: 'state.reported', payload: envelope.payload as Record<string, unknown> });
      return true;
    }
    if (!['command.completed', 'command.rejected', 'command.failed'].includes(String(envelope.type))) {
      return false;
    }
    if (!envelope.payload || typeof envelope.payload !== 'object') return false;
    const payload = envelope.payload as Record<string, unknown>;
    const commandId = payload.command_id;
    if (typeof commandId !== 'string') return false;
    const waiting = this.pending.get(commandId);
    if (!waiting) return false;
    clearTimeout(waiting.timer);
    this.pending.delete(commandId);
    waiting.resolve({
      type: envelope.type as CommandResult['type'],
      payload,
    });
    return true;
  }

  issueDiagnosticsEcho(deviceId: string, message: string, timeoutMs = 10_000): Promise<CommandResult> {
    if (message.length < 1 || message.length > 256) {
      return Promise.reject(new Error('diagnostics echo message must contain 1-256 characters'));
    }
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
      return Promise.reject(new Error(`device ${deviceId} is not connected`));
    }

    const now = new Date();
    const commandId = randomUUID();
    const idempotencyKey = `diagnostics-echo-${commandId}`;
    const parameters = { message };
    const envelope = {
      type: 'command.issue',
      protocol: 1,
      payload_version: 1,
      message_id: randomUUID(),
      stream_epoch: connection.coreStreamEpoch,
      sequence: connection.nextCoreSequence++,
      sent_at: now.toISOString(),
      expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
      correlation_id: randomUUID(),
      payload: {
        command_id: commandId,
        idempotency_key: idempotencyKey,
        request_digest: commandRequestDigest('diagnostics.echo', 1, parameters),
        kind: 'diagnostics.echo',
        execution_class: 'replay_safe',
        parameters,
        created_at: now.toISOString(),
        not_before: new Date(now.getTime() - 5_000).toISOString(),
        max_clock_uncertainty_ms: 5_000,
      },
    };

    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error(`device ${deviceId} did not complete command within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(commandId, { resolve, reject, timer });
      connection.ws.send(JSON.stringify(envelope), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(commandId);
        reject(error);
      });
    });
  }

  /// Send an arbitrary command to a connected Edge device through the protocol v1 gateway.
  /// This is the authoritative path for Core→Edge commands (replaces the legacy /ws broadcast).
  /// Returns a Promise that resolves when the command completes or times out.
  issueCommand(
    deviceId: string,
    kind: string,
    parameters: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<CommandResult> {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
      return Promise.reject(new Error(`device ${deviceId} is not connected via gateway`));
    }

    const now = new Date();
    const commandId = randomUUID();
    const executionClass = kind.startsWith('renderer.') ? 'volatile' : 'replay_safe';
    const envelope = {
      type: 'command.issue',
      protocol: 1,
      payload_version: 1,
      message_id: randomUUID(),
      stream_epoch: connection.coreStreamEpoch,
      sequence: connection.nextCoreSequence++,
      sent_at: now.toISOString(),
      expires_at: new Date(now.getTime() + timeoutMs).toISOString(),
      correlation_id: randomUUID(),
      payload: {
        command_id: commandId,
        idempotency_key: `${kind}-${commandId}`,
        request_digest: commandRequestDigest(kind, 1, parameters),
        kind,
        execution_class: executionClass,
        parameters,
        created_at: now.toISOString(),
        not_before: new Date(now.getTime() - 5_000).toISOString(),
        max_clock_uncertainty_ms: 5_000,
      },
    };

    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error(`device ${deviceId} command ${kind} did not complete within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(commandId, { resolve, reject, timer });
      connection.ws.send(JSON.stringify(envelope), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(commandId);
        reject(error);
      });
    });
  }

  /// Fire-and-forget: send a raw JSON message to a connected device without waiting for a response.
  /// Used for commands that the Edge Agent doesn't yet have a protocol v1 handler for.
  sendRaw(deviceId: string, message: Record<string, unknown>): void {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
      throw new Error(`device ${deviceId} is not connected via gateway`);
    }
    connection.ws.send(JSON.stringify(message));
  }

  issueDisplayState(
    deviceId: string,
    revision: number,
    display: { power?: 'on' | 'off'; brightness?: number },
    timeoutMs = 10_000,
  ): Promise<StateResult> {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
      return Promise.reject(new Error(`device ${deviceId} is not connected`));
    }
    const messageId = randomUUID();
    const state = { display };
    const envelope = {
      type: 'state.desired',
      protocol: 1,
      payload_version: 1,
      message_id: messageId,
      stream_epoch: connection.coreStreamEpoch,
      sequence: connection.nextCoreSequence++,
      sent_at: new Date().toISOString(),
      payload: {
        authority_epoch: connection.authorityEpoch,
        revision,
        desired_digest: `sha256:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`,
        state,
      },
    };

    return new Promise<StateResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingState.delete(messageId);
        reject(new Error(`device ${deviceId} did not report state within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingState.set(messageId, { resolve, reject, timer });
      connection.ws.send(JSON.stringify(envelope), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingState.delete(messageId);
        reject(error);
      });
    });
  }

  issueAudioState(
    deviceId: string,
    revision: number,
    audio: { volume: number },
    timeoutMs = 10_000,
  ): Promise<StateResult> {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
      return Promise.reject(new Error(`device ${deviceId} is not connected`));
    }
    const messageId = randomUUID();
    const state = { audio };
    const envelope = {
      type: 'state.desired',
      protocol: 1,
      payload_version: 1,
      message_id: messageId,
      stream_epoch: connection.coreStreamEpoch,
      sequence: connection.nextCoreSequence++,
      sent_at: new Date().toISOString(),
      payload: {
        authority_epoch: connection.authorityEpoch,
        revision,
        desired_digest: `sha256:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`,
        state,
      },
    };
    return new Promise<StateResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingState.delete(messageId);
        reject(new Error(`device ${deviceId} did not report audio state within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingState.set(messageId, { resolve, reject, timer });
      connection.ws.send(JSON.stringify(envelope), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingState.delete(messageId);
        reject(error);
      });
    });
  }

  issueSceneState(
    deviceId: string,
    revision: number,
    revisionId: string,
    page?: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<StateResult> {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
      return Promise.reject(new Error(`device ${deviceId} is not connected`));
    }
    const messageId = randomUUID();
    const state = { scene: { revision_id: revisionId, ...(page ? { page } : {}) } };
    const envelope = {
      type: 'state.desired',
      protocol: 1,
      payload_version: 1,
      message_id: messageId,
      stream_epoch: connection.coreStreamEpoch,
      sequence: connection.nextCoreSequence++,
      sent_at: new Date().toISOString(),
      payload: {
        authority_epoch: connection.authorityEpoch,
        revision,
        desired_digest: `sha256:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`,
        state,
      },
    };

    return new Promise<StateResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingState.delete(messageId);
        reject(new Error(`device ${deviceId} did not report scene state within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingState.set(messageId, { resolve, reject, timer });
      connection.ws.send(JSON.stringify(envelope), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingState.delete(messageId);
        reject(error);
      });
    });
  }
}

/** Build the frozen Device Protocol v1 Core heartbeat envelope. */
export function createCoreHeartbeat(
  streamEpoch: string,
  lastReceivedSequence: number,
  now: Date = new Date(),
): CoreHeartbeatMessage {
  return {
    type: 'core.heartbeat',
    protocol: 1,
    sent_at: now.toISOString(),
    stream_epoch: streamEpoch,
    last_received_sequence: lastReceivedSequence,
  };
}

function isHello(msg: unknown): msg is HelloMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'edge.hello'
  );
}

/**
 * Phase 8 authority mode check: if a device is in `core` mode, the gateway must
 * reject messages that lack the current authority_epoch (legacy-format messages).
 * Devices in `shadow`/`legacy` mode are unchanged.
 */
interface AuthEnforcementResult {
  allowed: boolean;
  reason?: string;
  mode?: string;
  expectedEpoch?: string;
}

async function enforceAuthorityMode(
  pool: import('pg').Pool,
  deviceId: string,
  message: unknown,
): Promise<AuthEnforcementResult> {
  // Fetch the device's current authority mode and epoch
  const res = await pool.query(
    'SELECT authority_mode, authority_epoch FROM devices WHERE id = $1',
    [deviceId],
  );
  if (res.rowCount === 0 || !res.rows[0]) {
    return { allowed: false, reason: 'unknown_device' };
  }
  const mode = res.rows[0].authority_mode as AuthorityMode;
  const expectedEpoch = res.rows[0].authority_epoch as string;

  // Devices in non-core mode are not enforcement targets
  if (mode !== 'core') {
    return { allowed: true };
  }

  const msg = message as Record<string, unknown>;
  const messageType = typeof msg?.type === 'string' ? msg.type : '';

  // State ownership messages carry their epoch inside the canonical payload.
  if (messageType === 'state.reported') {
    const payload =
      msg.payload && typeof msg.payload === 'object'
        ? (msg.payload as Record<string, unknown>)
        : undefined;
    const msgEpoch = payload?.authority_epoch;

    if (!msgEpoch || typeof msgEpoch !== 'string') {
      return {
        allowed: false,
        reason: 'missing_authority_epoch',
        mode,
        expectedEpoch,
      };
    }

    if (msgEpoch !== expectedEpoch) {
      return {
        allowed: false,
        reason: 'stale_authority_epoch',
        mode,
        expectedEpoch,
      };
    }

    return { allowed: true };
  }

  // Heartbeats, stream acknowledgements, and command results are protocol
  // plumbing rather than competing state-authority writes.
  const epochlessProtocolMessages = new Set([
    'stream.ack',
    'edge.heartbeat',
    'command.received',
    'command.completed',
    'command.rejected',
    'command.failed',
    'command.cancelled',
    'command.unknown_outcome',
    'protocol.error',
  ]);
  return epochlessProtocolMessages.has(messageType)
    ? { allowed: true }
    : { allowed: false, reason: 'missing_authority_epoch', mode, expectedEpoch };
}

export function registerGateway(
  fastify: FastifyInstance,
  config: CoreConfig,
  signer?: EnrollmentSigner,
): GatewayController {
  const wss = new WebSocketServer({ noServer: true });
  const controller = new GatewayController();

  fastify.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '', 'http://localhost');
    if (url.pathname !== config.gatewayPath) {
      return; // Not our path — let other handlers (legacy WS, voice) handle it
    }
    console.log('[core][gateway] upgrade request received, path:', url.pathname);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, request) => {
    console.log('[core][gateway] new WebSocket connection established');
    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    const legacyDeviceId = `legacy-${createHash('sha256').update(remoteAddress).digest('hex').slice(0, 32)}`;
    const sessionId = randomUUID();
    // The device's recorded identity. `device_id` from `edge.hello` is NON-AUTHORITATIVE (plan
    // doc §12.4); it is only a bootstrap/diagnostics hint. Until a hello arrives we fall back to
    // the connection's session id so the device is still recorded if it never sends one.
    let deviceId: string = sessionId;
    let coreStreamEpoch: string | null = null;
    let lastReceivedEdgeSequence = 0;

    const heartbeat = setInterval(() => {
      // Heartbeats are valid only after welcome establishes the stream epoch.
      if (ws.readyState === ws.OPEN && coreStreamEpoch) {
        ws.send(JSON.stringify(createCoreHeartbeat(coreStreamEpoch, lastReceivedEdgeSequence)));
      }
    }, 30_000);

    ws.on('message', async (raw) => {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: 'error', code: 'invalid_json' }));
          return;
        }
        console.log('[core][gateway] message received:', gatewayMessageType(parsed));

        if (isHello(parsed)) {
          // P-003 device-identity gate.
          //
          // When open pairing is ON (dev default), any hello is accepted exactly as before so the
          // proven Rust agent keeps connecting. When open pairing is OFF, the gateway FAILS CLOSED:
          // a hello is only accepted if it presents a valid enrolled credential OR matches a paired
          // registry entry (by public-key fingerprint or installation id). An unpaired hello is
          // rejected with a clear error so the device knows it must enroll first.
          //
          // The `device_id` from the hello is NON-AUTHORITATIVE (plan doc §12.4); the real device
          // identity is the enrolled credential / registry match. We still record `device_id` as a
          // convenience key when present.
          const gate = await authorizeHello(getPool(config), signer, config, parsed);
          if (!gate.allowed) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: 'unauthorized',
                reason: gate.reason,
                detail: 'device not enrolled; complete /api/pairing/begin then /api/pairing/complete',
              }),
            );
            console.warn(`[core][gateway] rejected unpaired hello: ${gate.reason}`);
            return;
          }
        // If the gate resolved a registry device id (enrolled device), prefer it as the recorded
        // identity so the device maps to its enrolled row rather than the non-authoritative hint.
        // When open pairing is ON, the credential is not verified but we still extract the
        // credential's device_id for logging/attach purposes.
        const credentialId = parsed.credential?.credential?.device_id;
        const helloId = parsed.device_id;
        const installId = parsed.installation_id;
        deviceId = gate.deviceId && gate.deviceId.length > 0
          ? gate.deviceId
          : (credentialId && credentialId.length > 0
              ? credentialId
              : (helloId && helloId.length > 0
                  ? helloId
                  : (installId && installId.length > 0 ? installId : legacyDeviceId)));

        // If the hello carries a credential with a public-key fingerprint, resolve the canonical
        // Core registry device ID from the devices table. This ensures the gateway uses the
        // enrolled device ID even when the hello's device_id hint differs.
        if (parsed.credential?.credential?.public_key_fingerprint) {
          const credRes = await getPool(config).query<{ id: string }>(
            'SELECT id FROM devices WHERE cert_fingerprint = $1 AND revoked_at IS NULL',
            [parsed.credential.credential.public_key_fingerprint],
          );
          if (credRes.rows[0]?.id) {
            deviceId = credRes.rows[0].id;
          }
        }

        const name = parsed.device_id ?? parsed.agent?.version ?? deviceId;
        const protocolVersion = String(parsed.protocol?.maximum ?? 1);
        const capabilities = [
          ...(parsed.capabilities?.renderer ?? []),
          ...(parsed.capabilities?.media ?? []),
          ...(parsed.capabilities?.voice ?? []),
          ...(parsed.capabilities?.hardware ?? []),
        ];

        // Phase 2 pairing scaffold: if the hello carries a valid, unused invitation
        // token, bind the device to it (mark paired). Plain hello (no token) is
        // recorded exactly as before — the existing open path is preserved.
        const invitationToken = typeof parsed.invitation_token === 'string' ? parsed.invitation_token : undefined;
        await recordDeviceHello(getPool(config), {
          deviceId,
          name,
          architecture: parsed.agent?.architecture ?? 'unknown',
          protocolVersion,
          capabilities,
          invitationToken,
        });

        // Phase 2 state-ownership scaffold: if the hello carries an optional inline
        // reported_state, record it. This is ADDITIVE — it never blocks or alters the
        // existing hello/welcome flow, and a hello without the field is unaffected.
        // The canonical reported-state path (contract `state.reported`) lands in a
        // later Phase 2 item; this keeps the open bootstrap path working in the meantime.
        const rs = parsed.reported_state;
        if (rs && typeof rs.domain === 'string' && rs.domain.length > 0 && rs.state !== undefined) {
          await reportState(getPool(config), deviceId, rs.domain, rs.state, rs.status ?? 'applied').catch(
            (err) => console.error('[core][gateway] reported_state recording failed:', err.message),
          );
        }

        // Reply with a protocol-v1 `core.welcome` (contracts/device/v1). The bootstrap gateway
        // accepts the hello without PKI, so it fabricates the resume epochs/sequences locally.
        coreStreamEpoch = randomUUID();
        const welcome: WelcomeMessage = {
          type: 'core.welcome',
          message_id: randomUUID(),
          sent_at: new Date().toISOString(),
          protocol: 1,
          session_id: sessionId,
          heartbeat_seconds: 30,
          core_time: new Date().toISOString(),
          resume: {
            accepted: true,
            core_stream_epoch: coreStreamEpoch,
            edge_stream_epoch: randomUUID(),
            next_core_sequence: 1,
          },
          desired_revision: 0,
        };
        ws.send(JSON.stringify(welcome));

        // After recording the device hello, re-resolve the device ID from the authoritative
        // credential. The Edge Agent's hello carries `device_id: "pi5-living-room"` but the
        // enrolled credential has the canonical Core registry device ID. Use that instead.
        const credDeviceId = (parsed as any).credential?.credential?.device_id;
        console.log('[core][gateway] credential device_id:', credDeviceId, 'current deviceId:', deviceId);
        if (credDeviceId) {
          const ghostId = deviceId;
          deviceId = credDeviceId;
          // Clean up the ghost row created by the initial recordDeviceHello call
          if (ghostId !== deviceId) {
            getPool(config).query('DELETE FROM devices WHERE id = $1', [ghostId]).catch(() => {});
          }
        }

        const authorityResult = await getPool(config).query<{
          authority_mode: AuthorityMode;
          authority_epoch: string;
        }>(
          `SELECT authority_mode, authority_epoch FROM devices WHERE id = $1`,
          [deviceId],
        );
        const authority = authorityResult.rows[0];
        controller.attach(deviceId, {
          ws,
          coreStreamEpoch,
          authorityEpoch:
            authority?.authority_mode === 'core'
              ? authority.authority_epoch
              : randomUUID(),
          nextCoreSequence: welcome.resume.next_core_sequence,
        });
        console.log(`[core][gateway] device connected: ${deviceId} (session ${sessionId})`);
        return;
      }

      const sequence = (parsed as { sequence?: unknown }).sequence;
      if (typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0) {
        lastReceivedEdgeSequence = Math.max(lastReceivedEdgeSequence, sequence);
      }

      // --- Phase 8: authority mode enforcement ----------------------------------
      // If this device is in 'core' mode, reject legacy-format messages. A legacy
      // message is one that does not carry the current authority epoch or uses an
      // obsolete envelope format (e.g. lacks `protocol` or `stream_epoch`).
      const authEnforcement = await enforceAuthorityMode(getPool(config), deviceId, parsed);
      if (!authEnforcement.allowed) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'authority_epoch_mismatch',
          reason: authEnforcement.reason,
          detail: `Device is in ${authEnforcement.mode} mode; expected authority_epoch ${authEnforcement.expectedEpoch}`,
        }));
        console.warn(`[core][gateway] rejected message from ${deviceId}: ${authEnforcement.reason}`);
        return;
      }

      await getPool(config).query(
        `UPDATE devices
         SET status = 'connected', last_seen = now()
         WHERE id = $1 AND revoked_at IS NULL`,
        [deviceId],
      );

      if (controller.observe(parsed)) return;

      // Echo unknown messages as an ack placeholder for now.
      ws.send(JSON.stringify({ type: 'ack', sessionId, echo: parsed }));
    } catch (err) {
      console.error('[core][gateway] unhandled error in message handler:', err);
    }
    });

    ws.on('close', async () => {
      clearInterval(heartbeat);
      if (deviceId) {
        controller.detach(deviceId, ws);
        const pool = getPool(config);
        await pool
          .query(
            `UPDATE devices SET status = 'disconnected', last_seen = now() WHERE id = $1`,
            [deviceId],
          )
          .catch((err) =>
            console.error('[core][gateway] disconnect update failed:', err.message),
          );
        console.log(`[core][gateway] device disconnected: ${deviceId}`);
      }
    });
  });

  console.log(`[core][gateway] listening on ${config.gatewayPath}`);
  return controller;
}

/** Safe operational label: never formats protocol payloads, credentials, state, or command data. */
export function gatewayMessageType(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown';
  const type = (value as {type?: unknown}).type;
  return typeof type === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(type) ? type : 'unknown';
}

/**
 * P-003 device-identity gate decision for an incoming `edge.hello`.
 *
 * - Open pairing ON (dev default): always allowed; the recorded identity falls back to the
 *   non-authoritative `device_id` hint. A warning is logged once per process if open pairing is on.
 * - Open pairing OFF (production): allowed ONLY if the hello presents a valid enrolled credential
 *   (Core signature verifies) OR matches a paired registry entry by public-key fingerprint or
 *   installation id. Otherwise rejected (fail-closed).
 */
let warnedOpenPairing = false;
async function authorizeHello(
  pool: import('pg').Pool,
  signer: EnrollmentSigner | undefined,
  config: CoreConfig,
  msg: HelloMessage,
): Promise<{ allowed: boolean; reason?: string; deviceId?: string }> {
  if (config.allowOpenPairing) {
    if (!warnedOpenPairing) {
      warnedOpenPairing = true;
      console.warn(
        '[core][gateway] WARNING: CANVAS_CORE_ALLOW_OPEN_PAIRING is true — the gateway accepts ' +
        'unenrolled hellos. PRODUCTION MUST set CANVAS_CORE_ALLOW_OPEN_PAIRING=false and rely on ' +
        'the P-003 enrollment gate (see docs/PHASE_0_PKI_BOOTSTRAP_SPEC.md).',
      );
    }
    return { allowed: true };
  }

  // Fail-closed path: require a verifiable enrolled identity.
  // (a) presented credential whose Core signature verifies
  if (signer && msg.credential && msg.credential.credential && msg.credential.signature) {
    const verified = verifyDeviceCredential(signer, msg.credential, config.securityEpoch ?? 1);
    if (verified.ok && verified.deviceId) {
      const rec = await findCredentialByFingerprint(pool, verified.fingerprint!);
      if (rec && !rec.revoked_at) {
        return { allowed: true, deviceId: verified.deviceId };
      }
    }
    return { allowed: false, reason: 'invalid_or_revoked_credential' };
  }

  // (b) registry match by public-key fingerprint or installation id
  const fingerprint = msg.public_key_fingerprint;
  const installationId = msg.installation_id;
  if (fingerprint && fingerprint.length > 0) {
    const rec = await findCredentialByFingerprint(pool, fingerprint);
    if (rec && !rec.revoked_at && rec.credential_json.security_epoch === (config.securityEpoch ?? 1)) {
      return { allowed: true, deviceId: rec.device_id };
    }
    return { allowed: false, reason: 'unknown_public_key_fingerprint' };
  }
  if (installationId && installationId.length > 0) {
    const res = await pool.query(
      'SELECT device_id, revoked_at, credential_json FROM device_credentials WHERE installation_id = $1 LIMIT 1',
      [installationId],
    );
    const row = res.rows[0];
    if (row && !row.revoked_at && row.credential_json?.security_epoch === (config.securityEpoch ?? 1)) {
      return { allowed: true, deviceId: row.device_id };
    }
    return { allowed: false, reason: 'unknown_installation_id' };
  }

  return { allowed: false, reason: 'not_enrolled' };
}
