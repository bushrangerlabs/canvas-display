import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CommandRequestDigestError,
  canonicalizeCommandRequestV1,
  computeCommandRequestDigestV1,
} from './request-digest-v1.js';

interface DigestVector {
  name: string;
  file: string;
  expected_digest: string;
}

interface InvalidDigestVector {
  name: string;
  file: string;
  expected_error: string;
}

interface DigestVectors {
  schema_version: number;
  profile: string;
  valid: DigestVector[];
  invalid: InvalidDigestVector[];
}

interface CapabilityEntry {
  token: string;
  status: string;
  description: string;
}

interface CapabilityRegistry {
  schema_version: number;
  platform: string;
  architectures: string[];
  categories: Record<string, CapabilityEntry[]>;
}

interface CommandEntry {
  kind: string;
  semantic_version: number;
  wire_status: 'active_vertical_slice' | 'planned';
  execution_class: 'replay_safe' | 'state_reconcilable' | 'externally_idempotent' | 'non_repeatable';
  required_capability: { category: string; token: string } | null;
  parameter_contract: string;
  postcondition: string;
}

interface CommandCatalog {
  schema_version: number;
  digest_profile: string;
  digest_input_fields: string[];
  execution_classes: Record<string, string>;
  desired_state_not_commands: string[];
  commands: CommandEntry[];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vectorsDirectory = path.join(root, 'contracts/command/v1/fixtures/request-digest');
const vectors = JSON.parse(readFileSync(path.join(vectorsDirectory, 'vectors.json'), 'utf8')) as DigestVectors;
const capabilities = JSON.parse(
  readFileSync(path.join(root, 'contracts/device/v1/capability-registry.json'), 'utf8'),
) as CapabilityRegistry;
const catalog = JSON.parse(
  readFileSync(path.join(root, 'contracts/command/v1/command-catalog.json'), 'utf8'),
) as CommandCatalog;

function vectorBytes(file: string): Buffer {
  return readFileSync(path.join(vectorsDirectory, file));
}

function fixture(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8')) as Record<string, unknown>;
}

test('capability registry is Linux-only, architecture-complete, and token-unique', () => {
  assert.equal(capabilities.schema_version, 1);
  assert.equal(capabilities.platform, 'linux');
  assert.deepEqual(capabilities.architectures, ['amd64', 'arm64']);
  assert.deepEqual(Object.keys(capabilities.categories).sort(), ['hardware', 'media', 'renderer', 'voice']);

  const allowedStatuses = new Set(['phase0_contract', 'phase0_prototype', 'legacy_available', 'planned']);
  const qualified = new Set<string>();
  for (const [category, entries] of Object.entries(capabilities.categories)) {
    const categoryTokens = new Set<string>();
    for (const entry of entries) {
      assert.match(entry.token, /^[a-z][a-z0-9-]*(?:-v[1-9][0-9]*)?$/);
      assert(!categoryTokens.has(entry.token), `duplicate ${category}:${entry.token}`);
      assert(allowedStatuses.has(entry.status), `unknown status for ${category}:${entry.token}`);
      assert(entry.description.length > 0);
      categoryTokens.add(entry.token);
      qualified.add(`${category}:${entry.token}`);
    }
  }

  for (const command of catalog.commands) {
    if (command.required_capability) {
      const reference = `${command.required_capability.category}:${command.required_capability.token}`;
      assert(qualified.has(reference), `${command.kind} references unknown capability ${reference}`);
    }
  }
});

test('command catalog fixes execution classes without activating planned commands', () => {
  assert.equal(catalog.schema_version, 1);
  assert.equal(catalog.digest_profile, 'canvas.command.request/v1');
  assert.deepEqual(catalog.digest_input_fields, ['kind', 'semantic_version', 'parameters', 'preconditions']);

  const identities = new Set<string>();
  for (const command of catalog.commands) {
    const identity = `${command.kind}@${command.semantic_version}`;
    assert(!identities.has(identity), `duplicate command ${identity}`);
    identities.add(identity);
    assert(Object.hasOwn(catalog.execution_classes, command.execution_class));
    assert(command.parameter_contract.length > 0);
    assert(command.postcondition.length > 0);
  }

  const active = catalog.commands.filter((command) => command.wire_status === 'active_vertical_slice');
  assert.deepEqual(active.map((command) => command.kind), ['diagnostics.echo']);
  assert.equal(active[0]?.execution_class, 'replay_safe');
  assert.equal(catalog.commands.some((command) => command.execution_class === 'externally_idempotent'), false);
  assert(catalog.commands.some((command) => command.kind === 'system.reboot' && command.execution_class === 'non_repeatable'));
  assert(catalog.commands.some((command) => command.kind === 'media.session.play' && command.execution_class === 'state_reconcilable'));

  const commandKinds = new Set(catalog.commands.map((command) => command.kind));
  for (const desiredDomain of catalog.desired_state_not_commands) {
    assert(!commandKinds.has(desiredDomain), `${desiredDomain} must remain desired state`);
  }
});

test('shared request digest vectors are canonical and mutation-sensitive', () => {
  assert.equal(vectors.schema_version, 1);
  assert.equal(vectors.profile, 'canvas.command.request/v1');

  for (const vector of vectors.valid) {
    assert.equal(computeCommandRequestDigestV1(vectorBytes(vector.file)), vector.expected_digest, vector.name);
  }

  const baseline = vectors.valid.find((vector) => vector.name === 'diagnostics-echo');
  const reordered = vectors.valid.find((vector) => vector.name === 'key-order-and-whitespace-invariance');
  const arrayAB = vectors.valid.find((vector) => vector.name === 'array-order-a-b');
  const arrayBA = vectors.valid.find((vector) => vector.name === 'array-order-b-a');
  assert(baseline && reordered && arrayAB && arrayBA);
  assert.equal(baseline.expected_digest, reordered.expected_digest);
  assert.equal(
    canonicalizeCommandRequestV1(vectorBytes(baseline.file)),
    canonicalizeCommandRequestV1(vectorBytes(reordered.file)),
  );
  assert.notEqual(arrayAB.expected_digest, arrayBA.expected_digest);

  for (const vector of vectors.valid.filter((candidate) => candidate.name.endsWith('mutation'))) {
    assert.notEqual(vector.expected_digest, baseline.expected_digest, vector.name);
  }
});

test('invalid raw request digest inputs fail closed', () => {
  for (const vector of vectors.invalid) {
    assert.throws(
      () => computeCommandRequestDigestV1(vectorBytes(vector.file)),
      (error: unknown) => error instanceof CommandRequestDigestError && error.code === vector.expected_error,
      vector.name,
    );
  }
});

test('Device Protocol command lifecycle fixtures use canonical logical request digests', () => {
  const baselineDigest = vectors.valid.find((vector) => vector.name === 'diagnostics-echo')?.expected_digest;
  const conflictDigest = vectors.valid.find((vector) => vector.name === 'parameter-mutation')?.expected_digest;
  assert(baselineDigest && conflictDigest);

  const issue = fixture('contracts/device/v1/fixtures/valid/command-issue.json');
  const payload = issue.payload as Record<string, unknown>;
  assert.equal(payload.request_digest, baselineDigest);
  assert.equal(
    computeCommandRequestDigestV1(Buffer.from(JSON.stringify({
      kind: payload.kind,
      semantic_version: issue.payload_version,
      parameters: payload.parameters,
      preconditions: {},
    }))),
    baselineDigest,
  );

  for (const file of ['command-received.json', 'command-completed.json']) {
    const value = fixture(`contracts/device/v1/fixtures/valid/${file}`);
    assert.equal((value.payload as Record<string, unknown>).request_digest, baselineDigest, file);
  }
  const rejection = fixture('contracts/device/v1/fixtures/valid/command-rejected.json');
  assert.equal((rejection.payload as Record<string, unknown>).request_digest, conflictDigest);
});
