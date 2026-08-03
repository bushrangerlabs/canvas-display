import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentKeyStore,
  LocalIpcBroker,
  LocalIpcError,
  type PeerCredential,
} from './local-ipc-model.js';

const RENDERER_UID = 1500;
const UPDATER_UID = 1501;
const HOSTILE_UID = 1999;

function broker(): LocalIpcBroker {
  return new LocalIpcBroker({ rendererUid: RENDERER_UID, updaterUid: UPDATER_UID });
}

function credential(uid: number, pid = 100): PeerCredential {
  return { uid, gid: uid, pid };
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof LocalIpcError && error.code === code,
    `expected LocalIpcError(${code})`,
  );
}

test('wrong-peer: a uid that is neither the configured renderer nor updater is rejected outright', () => {
  const ipc = broker();
  expectCode(() => ipc.connect(credential(HOSTILE_UID)), 'wrong_peer');
});

test('a legitimate renderer peer can call its allowlisted methods', () => {
  const ipc = broker();
  const session = ipc.connect(credential(RENDERER_UID));
  const result = ipc.dispatch({ capabilityToken: session.capabilityToken, method: 'scene.activate' });
  assert.equal(result.ok, true);
});

test('a legitimate updater peer can call its allowlisted methods with a fresh nonce', () => {
  const ipc = broker();
  const session = ipc.connect(credential(UPDATER_UID));
  const result = ipc.dispatch({
    capabilityToken: session.capabilityToken,
    method: 'updater.install_package',
    nonce: 'nonce-1',
  });
  assert.equal(result.ok, true);
});

test('privileged-method: renderer capability cannot invoke an updater-only method', () => {
  const ipc = broker();
  const session = ipc.connect(credential(RENDERER_UID));
  expectCode(
    () => ipc.dispatch({ capabilityToken: session.capabilityToken, method: 'updater.install_package', nonce: 'x' }),
    'method_not_allowed',
  );
});

test('privileged-method: updater capability cannot invoke a renderer-only method', () => {
  const ipc = broker();
  const session = ipc.connect(credential(UPDATER_UID));
  expectCode(
    () => ipc.dispatch({ capabilityToken: session.capabilityToken, method: 'scene.activate' }),
    'method_not_allowed',
  );
});

test('privileged-method: updater methods require a nonce and reject nonce replay', () => {
  const ipc = broker();
  const session = ipc.connect(credential(UPDATER_UID));
  expectCode(
    () => ipc.dispatch({ capabilityToken: session.capabilityToken, method: 'updater.rollback' }),
    'nonce_required',
  );
  const ok = ipc.dispatch({ capabilityToken: session.capabilityToken, method: 'updater.rollback', nonce: 'reused' });
  assert.equal(ok.ok, true);
  expectCode(
    () =>
      ipc.dispatch({ capabilityToken: session.capabilityToken, method: 'updater.rollback', nonce: 'reused' }),
    'nonce_replayed',
  );
});

test('stale-capability: a renderer restart fences out the previous generation\'s token', () => {
  const ipc = broker();
  const firstGeneration = ipc.connect(credential(RENDERER_UID, 100));
  // Renderer crashes and a new process (new pid) reconnects.
  const secondGeneration = ipc.connect(credential(RENDERER_UID, 200));

  assert.equal(secondGeneration.generation, firstGeneration.generation + 1);

  // The old token is rejected even though it was never explicitly revoked by name.
  expectCode(
    () => ipc.dispatch({ capabilityToken: firstGeneration.capabilityToken, method: 'scene.activate' }),
    'stale_capability',
  );
  // The new token works fine.
  const ok = ipc.dispatch({ capabilityToken: secondGeneration.capabilityToken, method: 'scene.activate' });
  assert.equal(ok.ok, true);
});

test('stale-capability: an unknown/never-issued token is rejected the same way as a stale one', () => {
  const ipc = broker();
  ipc.connect(credential(RENDERER_UID));
  expectCode(
    () => ipc.dispatch({ capabilityToken: 'forged-token-never-issued', method: 'scene.activate' }),
    'stale_capability',
  );
});

test('hostile-WebView: a leaked, structurally valid renderer token cannot pivot to a privileged method', () => {
  // Models content running inside a renderer-hosted WebView (or any other code adjacent to the
  // renderer process) that has somehow obtained a copy of the renderer's own capability token —
  // for example through a compromised page trying to message out through the same channel the
  // legitimate renderer uses. Because method-scope enforcement never depends on "is this
  // otherwise a valid session," the exact same allowlist check that stops a legitimate renderer
  // mistake also stops this pivot attempt.
  const ipc = broker();
  const session = ipc.connect(credential(RENDERER_UID));
  const leakedToken = session.capabilityToken;

  expectCode(
    () => ipc.dispatch({ capabilityToken: leakedToken, method: 'updater.install_package', nonce: 'stolen' }),
    'method_not_allowed',
  );
});

test('hostile-WebView: WebView content cannot authenticate as the renderer peer directly', () => {
  // A WebView process (or any non-renderer process on the host) does not share the renderer's
  // configured uid, so it cannot even complete the peer-identity handshake, independent of any
  // token it might try to present.
  const ipc = broker();
  expectCode(() => ipc.connect(credential(HOSTILE_UID)), 'wrong_peer');
});

test('key-read: no IPC method name ever reaches the Agent key store', () => {
  const ipc = broker();
  const session = ipc.connect(credential(RENDERER_UID));

  const hostileMethodNames = [
    'agent.export_private_key',
    'agent.read_private_key',
    'debug.dump_key',
    'key.read',
    'agent.key',
  ];

  for (const method of hostileMethodNames) {
    expectCode(
      () => ipc.dispatch({ capabilityToken: session.capabilityToken, method }),
      'method_not_allowed',
    );
  }
});

test('key-read: the key store only ever returns opaque signatures, never key material, and is unreachable from dispatch', () => {
  const keyStore = new AgentKeyStore(0x42);
  const digest = new Uint8Array([1, 2, 3, 4]);
  const signature = keyStore.signDigest(digest);

  // The signature is derived from, but is not equal to, the digest or any fixed key byte pattern.
  assert.notDeepEqual(Array.from(signature), Array.from(digest));
  assert.equal(signature.length, digest.length);

  // LocalIpcBroker has no reference to any AgentKeyStore at all -- this is a structural
  // assertion that the broker's dispatch surface has no path to key material.
  const ipc = broker();
  assert.equal((ipc as unknown as { keyStore?: unknown }).keyStore, undefined);
});

test('renderer restart does not reset Agent-owned durable state', () => {
  const ipc = broker();
  const first = ipc.connect(credential(RENDERER_UID, 100));
  ipc.durableState.nextOutboxSequence();
  ipc.durableState.nextOutboxSequence();
  assert.equal(ipc.durableState.outboxSequence, 2);

  ipc.disconnect(first);
  // Renderer restarts (new pid, new generation).
  ipc.connect(credential(RENDERER_UID, 101));

  // Durable Agent state survived the renderer restart untouched.
  assert.equal(ipc.durableState.outboxSequence, 2);
  ipc.durableState.nextOutboxSequence();
  assert.equal(ipc.durableState.outboxSequence, 3);
});

test('renderer and updater generations are tracked independently', () => {
  const ipc = broker();
  const rendererSession = ipc.connect(credential(RENDERER_UID));
  const updaterSession = ipc.connect(credential(UPDATER_UID));

  assert.equal(rendererSession.generation, 1);
  assert.equal(updaterSession.generation, 1);

  // A second renderer connection does not disturb the updater's generation/capability.
  ipc.connect(credential(RENDERER_UID, 999));
  const stillOk = ipc.dispatch({
    capabilityToken: updaterSession.capabilityToken,
    method: 'updater.health_report',
    nonce: 'still-valid',
  });
  assert.equal(stillOk.ok, true);
});
