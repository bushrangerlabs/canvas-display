import {
  CoreEndpointIdentity,
  OfflineRootAuthority,
  createDeterministicTestEntropy,
  type PairingBootstrap,
  type PairingScope,
} from './crypto-model.js';
import {
  EdgeInstallation,
  MonotonicSecurityFence,
  Phase0PkiCore,
} from './pki-state-machine.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export class MutableClock {
  #nowMs: number;

  constructor(initialMs = Date.parse('2026-07-18T10:00:00.000Z')) {
    this.#nowMs = initialMs;
  }

  readonly now = (): number => this.#nowMs;

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
  }
}

export interface PkiFixture {
  readonly clock: MutableClock;
  readonly root: OfflineRootAuthority;
  readonly endpoint: CoreEndpointIdentity;
  readonly fence: MonotonicSecurityFence;
  readonly core: Phase0PkiCore;
}

export function createPkiFixture(seed: string): PkiFixture {
  const clock = new MutableClock();
  const root = new OfflineRootAuthority();
  const endpoint = new CoreEndpointIdentity('https://core.example.test/device/v1/pair');
  const fence = new MonotonicSecurityFence();
  const core = new Phase0PkiCore({
    endpointIdentity: endpoint,
    rootPublicKeySpki: root.publicKeySpki,
    securityFence: fence,
    now: clock.now,
    entropy: createDeterministicTestEntropy(seed),
    credentialLifetimeMs: 14 * DAY_MS,
  });

  activateIssuer({ core, root }, 'issuer-1');
  return { clock, root, endpoint, fence, core };
}

export function activateIssuer(
  fixture: Pick<PkiFixture, 'core' | 'root'>,
  issuerId: string,
  overlapMs = 0,
): void {
  const request = fixture.core.createIssuerSigningRequest({
    issuerId,
    validForMs: 30 * DAY_MS,
  });
  const authorization = fixture.root.authorizeIssuer(request);
  fixture.core.activateIssuer(authorization, { overlapMs });
}

export function pairEdge(
  fixture: PkiFixture,
  options: {
    installationId: string;
    runtimeInstanceId?: string;
    scope?: PairingScope;
    bootstrap?: PairingBootstrap;
  },
): EdgeInstallation {
  const scope = options.scope ?? { siteId: 'site-main', groupId: 'displays' };
  const bootstrap =
    options.bootstrap ??
    fixture.core.createPairingInvitation({
      scope,
      ttlMs: 10 * MINUTE_MS,
    });
  const edge = new EdgeInstallation({
    installationId: options.installationId,
    runtimeInstanceId: options.runtimeInstanceId ?? `${options.installationId}-runtime`,
    now: fixture.clock.now,
  });
  const request = edge.prepareEnrollment(bootstrap, fixture.endpoint.presentedIdentity);
  const challenge = fixture.core.startEnrollment(request);
  const proof = edge.answerEnrollmentChallenge(challenge);
  const bundle = fixture.core.completeEnrollment(proof);
  edge.acceptEnrollment(bundle);
  return edge;
}

export function connectEdge(
  fixture: PkiFixture,
  edge: EdgeInstallation,
  options: {
    connectionId: string;
    observedInstallationInstanceId?: string;
  },
): string {
  const challenge = fixture.core.startConnection(edge.credentialBundle, {
    connectionId: options.connectionId,
    observedInstallationInstanceId:
      options.observedInstallationInstanceId ?? edge.runtimeInstanceId,
  });
  const proof = edge.answerConnectionChallenge(challenge);
  return fixture.core.finishConnection(proof).sessionId;
}
