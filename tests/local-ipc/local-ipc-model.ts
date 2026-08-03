/**
 * Phase 0 executable model for the Canvas Edge Agent <-> renderer/updater local IPC boundary
 * (threat-model item P0-04, ADR 0003).
 *
 * This is a deterministic, in-process software model. It intentionally does NOT open a real
 * Unix domain socket, does not call `getsockopt(SO_PEERCRED)`, and does not implement real
 * systemd sandboxing. Those are real-transport/OS integration concerns for Phase 1
 * implementation. What this model freezes and proves, in a way that is directly testable today,
 * is the *design contract* that the real implementation must satisfy:
 *
 * - Every connecting peer is identified by an out-of-band credential (the production
 *   equivalent of SO_PEERCRED uid/gid/pid), never by a self-reported role.
 * - Every method call is checked against a fixed, role-scoped allowlist, independent of whether
 *   the caller holds an otherwise-valid capability token (defense in depth against a hostile
 *   WebView or leaked token trying to pivot to a privileged method).
 * - Renderer capability tokens are bound to a monotonically increasing "generation" number that
 *   advances every time the renderer (re)connects (for example after a crash restart). Tokens
 *   from a stale generation are rejected even if they were never explicitly revoked.
 * - The Agent's device private key is never reachable through any IPC method, for any role.
 * - The privileged updater/helper channel is disjoint from the renderer channel and additionally
 *   requires a single-use nonce per request (replay protection), since its methods can install
 *   packages or trigger rollback (threat UPD-05).
 * - Agent-side durable state (for example an outbox sequence counter) survives renderer
 *   restarts; a renderer crash/reconnect must not require replaying or losing Agent state.
 */

export type PeerRole = 'renderer' | 'updater' | 'unknown';

export interface PeerCredential {
  /** Real transport equivalent: SO_PEERCRED uid. */
  uid: number;
  /** Real transport equivalent: SO_PEERCRED gid. */
  gid: number;
  /** Real transport equivalent: SO_PEERCRED pid. Used only for audit, never for trust. */
  pid: number;
}

export interface LocalIpcConfig {
  /** The single uid permitted to authenticate as the renderer peer. */
  rendererUid: number;
  /** The single uid permitted to authenticate as the privileged updater/helper peer. */
  updaterUid: number;
}

export type RendererMethod =
  | 'scene.activate'
  | 'media.session.control'
  | 'hardware.brightness.get'
  | 'hardware.brightness.set'
  | 'hardware.query_capabilities';

export type UpdaterMethod = 'updater.install_package' | 'updater.rollback' | 'updater.health_report';

const RENDERER_METHOD_ALLOWLIST: ReadonlySet<string> = new Set<RendererMethod>([
  'scene.activate',
  'media.session.control',
  'hardware.brightness.get',
  'hardware.brightness.set',
  'hardware.query_capabilities',
]);

const UPDATER_METHOD_ALLOWLIST: ReadonlySet<string> = new Set<UpdaterMethod>([
  'updater.install_package',
  'updater.rollback',
  'updater.health_report',
]);

export class LocalIpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'LocalIpcError';
  }
}

export interface AuthenticatedSession {
  readonly role: PeerRole;
  readonly generation: number;
  readonly capabilityToken: string;
}

interface DispatchRequest {
  capabilityToken: string;
  method: string;
  /** Required only for the updater channel; must be unique per accepted request. */
  nonce?: string;
  arguments?: Record<string, unknown>;
}

interface CapabilityRecord {
  role: PeerRole;
  generation: number;
  revoked: boolean;
}

/**
 * Models the Agent's device private key store. It deliberately exposes no method that returns
 * key bytes, and `signDigest` never leaks material — it returns only an opaque signature. There
 * is intentionally no code path from `LocalIpcBroker.dispatch` to this class at all; that absence
 * is itself part of what the tests assert.
 */
export class AgentKeyStore {
  readonly #keyMaterial: Uint8Array;
  constructor(seedByte: number) {
    this.#keyMaterial = new Uint8Array(32).fill(seedByte);
  }
  /** Returns an opaque signature over a caller-supplied digest; never the key itself. */
  signDigest(digest: Uint8Array): Uint8Array {
    const signature = new Uint8Array(digest.length);
    for (let i = 0; i < digest.length; i += 1) {
      signature[i] = (digest[i] ^ this.#keyMaterial[i % this.#keyMaterial.length]) & 0xff;
    }
    return signature;
  }
}

/**
 * A tiny stand-in for Agent-side durable state (outbox sequence, desired hardware state, ...)
 * that must survive renderer restarts. Production is real local SQLite; this model only proves
 * that the broker's renderer-restart handling never resets or discards it.
 */
export class DurableAgentState {
  #outboxSequence = 0;
  nextOutboxSequence(): number {
    this.#outboxSequence += 1;
    return this.#outboxSequence;
  }
  get outboxSequence(): number {
    return this.#outboxSequence;
  }
}

export class LocalIpcBroker {
  readonly #config: LocalIpcConfig;
  readonly #capabilities = new Map<string, CapabilityRecord>();
  readonly #usedNonces = new Set<string>();
  readonly #generationByRole = new Map<PeerRole, number>();
  readonly #tokenSource: () => string;
  readonly durableState = new DurableAgentState();

  constructor(config: LocalIpcConfig, tokenSource: () => string = defaultTokenSource) {
    this.#config = config;
    this.#tokenSource = tokenSource;
  }

  /** Identifies the connecting peer from its credential. Never trusts a self-reported role. */
  #identify(credential: PeerCredential): PeerRole {
    if (credential.uid === this.#config.rendererUid) return 'renderer';
    if (credential.uid === this.#config.updaterUid) return 'updater';
    return 'unknown';
  }

  /**
   * Called once per new transport connection (production: once per accepted Unix socket
   * connection, immediately after reading SO_PEERCRED). A renderer connection always starts a
   * new generation, immediately invalidating capability tokens from any prior generation — this
   * is what makes a stale token from a crashed/replaced renderer process useless, without
   * requiring an explicit revocation call.
   */
  connect(credential: PeerCredential): AuthenticatedSession {
    const role = this.#identify(credential);
    if (role === 'unknown') {
      throw new LocalIpcError('wrong_peer', `uid ${credential.uid} is not an authorized local IPC peer`);
    }

    const previousGeneration = this.#generationByRole.get(role) ?? 0;
    const generation = previousGeneration + 1;
    this.#generationByRole.set(role, generation);

    // Invalidate every previously issued capability for this role; only the newest generation
    // may act. This models "renderer restart fences out the old process's capability."
    for (const [token, record] of this.#capabilities) {
      if (record.role === role && record.generation < generation) {
        this.#capabilities.set(token, { ...record, revoked: true });
      }
    }

    const capabilityToken = this.#tokenSource();
    this.#capabilities.set(capabilityToken, { role, generation, revoked: false });

    return { role, generation, capabilityToken };
  }

  /** Explicit crash/disconnect notification; durable Agent state is untouched. */
  disconnect(_session: AuthenticatedSession): void {
    // Intentionally a no-op on durable state: Agent-owned durable state (outbox, hardware
    // desired state, etc.) must never be reset just because the renderer/updater disconnected.
  }

  /**
   * Dispatches one method call. Every check is independent of whether the token is otherwise
   * "valid" for its role — an in-scope role with an out-of-scope method is rejected the same way
   * a completely wrong peer would be, which is what makes this resistant to a hostile WebView (or
   * any other code running adjacent to the renderer) that manages to reuse a leaked, structurally
   * valid renderer capability token to try to reach a privileged method.
   */
  dispatch(request: DispatchRequest): { ok: true; result: string } {
    const record = this.#capabilities.get(request.capabilityToken);
    if (!record || record.revoked) {
      throw new LocalIpcError('stale_capability', 'capability token is unknown or superseded by a newer generation');
    }

    const allowlist = record.role === 'renderer' ? RENDERER_METHOD_ALLOWLIST : UPDATER_METHOD_ALLOWLIST;
    if (!allowlist.has(request.method)) {
      throw new LocalIpcError(
        'method_not_allowed',
        `method '${request.method}' is not in the ${record.role} allowlist`,
      );
    }

    if (record.role === 'updater') {
      if (!request.nonce) {
        throw new LocalIpcError('nonce_required', 'privileged updater methods require a single-use nonce');
      }
      if (this.#usedNonces.has(request.nonce)) {
        throw new LocalIpcError('nonce_replayed', 'this nonce has already been consumed');
      }
      this.#usedNonces.add(request.nonce);
    }

    return { ok: true, result: `${request.method}:accepted` };
  }
}

function defaultTokenSource(): string {
  return `cap_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}
