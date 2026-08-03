import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  DiagnosticsEchoCommandIssue,
  StateDesired,
  StreamReset,
} from '../../../packages/protocol-ts/src/index.js';
import { readJsonFixture } from '../../../scripts/contracts.js';
import { EdgeSimulator } from '../src/edge-simulator.js';

const baseDesired: StateDesired = {
  type: 'state.desired',
  protocol: 1,
  payload_version: 1,
  message_id: '0190f300-0000-7000-8000-000000000001',
  stream_epoch: '0190efff-0000-7000-8000-000000000010',
  sequence: 1,
  sent_at: '2026-07-18T10:00:00.000Z',
  payload: {
    authority_epoch: '0190efff-0000-7000-8000-000000000001',
    revision: 1,
    desired_digest: `sha256:${'a'.repeat(64)}`,
    state: { display: { power: 'on', brightness: 70 } },
  },
};

test('duplicate desired delivery is acknowledged without reapplying state', () => {
  const edge = new EdgeSimulator();
  const first = edge.handleCoreMessage(baseDesired);
  assert.deepEqual(first.map((message) => message.type), ['stream.ack', 'state.reported']);
  assert.equal(edge.snapshot.desiredApplyCount, 1);

  const duplicate = edge.handleCoreMessage(structuredClone(baseDesired));
  assert.deepEqual(duplicate.map((message) => message.type), ['stream.ack']);
  assert.equal(edge.snapshot.desiredApplyCount, 1);
});

test('a reused stream sequence with different content fails closed', () => {
  const edge = new EdgeSimulator();
  edge.handleCoreMessage(baseDesired);

  const changed = structuredClone(baseDesired);
  changed.payload.desired_digest = `sha256:${'d'.repeat(64)}`;
  const output = edge.handleCoreMessage(changed);

  assert.equal(output.length, 1);
  assert.equal(output[0]?.type, 'protocol.error');
  if (output[0]?.type === 'protocol.error') {
    assert.equal(output[0].code, 'stream_reset_required');
  }
  assert.equal(edge.snapshot.desiredApplyCount, 1);
});

test('stream reset establishes a new sequence epoch before newer desired state applies', () => {
  const edge = new EdgeSimulator();
  edge.handleCoreMessage(baseDesired);

  const reset: StreamReset = {
    type: 'stream.reset',
    protocol: 1,
    message_id: '0190f300-0000-7000-8000-000000000002',
    sent_at: '2026-07-18T10:00:01.000Z',
    previous_stream_epoch: baseDesired.stream_epoch,
    new_stream_epoch: '0190efff-0000-7000-8000-000000000012',
    reason: 'history_truncated',
    desired_revision: 2,
  };
  assert.deepEqual(edge.handleCoreMessage(reset), []);

  const next = structuredClone(baseDesired);
  next.message_id = '0190f300-0000-7000-8000-000000000003';
  next.stream_epoch = reset.new_stream_epoch;
  next.payload.revision = 2;
  next.payload.desired_digest = `sha256:${'d'.repeat(64)}`;
  const output = edge.handleCoreMessage(next);

  assert.deepEqual(output.map((message) => message.type), ['stream.ack', 'state.reported']);
  assert.equal(edge.snapshot.lastCoreSequence, 1);
  assert.equal(edge.snapshot.appliedDesiredRevision, 2);
  assert.equal(edge.snapshot.desiredApplyCount, 2);
});

test('a lower desired revision on a new sequence is acknowledged and rejected as stale', () => {
  const edge = new EdgeSimulator();
  const revisionTwo = structuredClone(baseDesired);
  revisionTwo.payload.revision = 2;
  edge.handleCoreMessage(revisionTwo);

  const stale = structuredClone(baseDesired);
  stale.message_id = '0190f300-0000-7000-8000-000000000004';
  stale.sequence = 2;
  const output = edge.handleCoreMessage(stale);

  assert.deepEqual(output.map((message) => message.type), ['stream.ack', 'protocol.error']);
  const error = output[1];
  assert(error?.type === 'protocol.error');
  assert.equal(error.code, 'stale_revision');
  assert.equal(edge.snapshot.appliedDesiredRevision, 2);
});

test('expired and untrusted-clock commands fail before execution', async () => {
  const command = await readJsonFixture<DiagnosticsEchoCommandIssue>(
    'contracts',
    'device',
    'v1',
    'fixtures',
    'valid',
    'command-issue.json',
  );
  command.sequence = 1;

  const expiredEdge = new EdgeSimulator({ now: () => '2026-07-18T10:06:00.000Z' });
  const expiredOutput = expiredEdge.handleCoreMessage(command);
  assert.deepEqual(expiredOutput.map((message) => message.type), ['stream.ack', 'command.rejected']);
  const expired = expiredOutput[1];
  assert(expired?.type === 'command.rejected');
  assert.equal(expired.payload.code, 'expired');
  assert.equal(expiredEdge.snapshot.echoExecutionCount, 0);

  const uncertainEdge = new EdgeSimulator({ clockUncertaintyMs: 2000 });
  const uncertainOutput = uncertainEdge.handleCoreMessage(command);
  assert.deepEqual(uncertainOutput.map((message) => message.type), ['stream.ack', 'command.rejected']);
  const uncertain = uncertainOutput[1];
  assert(uncertain?.type === 'command.rejected');
  assert.equal(uncertain.payload.code, 'clock_untrusted');
  assert.equal(uncertainEdge.snapshot.echoExecutionCount, 0);
});
