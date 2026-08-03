import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeviceV1ControlMessage, DiagnosticsEchoCommandIssue } from '../../packages/protocol-ts/src/index.js';
import { EdgeSimulator } from '../../edge/simulator/src/edge-simulator.js';
import { getDeviceV1Validator } from '../../scripts/contracts.js';
import { CoreGatewayHarness } from './core-gateway-harness.js';

async function assertSchemaValid(messages: DeviceV1ControlMessage[]): Promise<void> {
  const validate = await getDeviceV1Validator();
  for (const message of messages) {
    assert.equal(
      validate(message),
      true,
      `${message.type} failed schema validation: ${JSON.stringify(validate.errors)}`,
    );
  }
}

test('device v1 vertical slice resumes, converges state, and deduplicates replay-safe commands', async () => {
  const core = new CoreGatewayHarness();
  const edge = new EdgeSimulator({ architecture: 'arm64' });

  const hello = edge.createHello();
  await assertSchemaValid([hello]);
  const welcome = core.acceptHello(hello);
  await assertSchemaValid([welcome]);
  assert.deepEqual(edge.handleCoreMessage(welcome), []);

  const desired = core.desiredState();
  const desiredOutput = edge.handleCoreMessage(desired);
  await assertSchemaValid(desiredOutput);
  assert.deepEqual(desiredOutput.map((message) => message.type), ['stream.ack', 'state.reported']);
  assert.equal(edge.snapshot.appliedDesiredRevision, 1);
  assert.equal(edge.snapshot.desiredApplyCount, 1);

  const duplicateDesiredOutput = edge.handleCoreMessage(structuredClone(desired));
  await assertSchemaValid(duplicateDesiredOutput);
  assert.deepEqual(duplicateDesiredOutput.map((message) => message.type), ['stream.ack']);
  assert.equal(edge.snapshot.desiredApplyCount, 1);

  const command = core.echoCommand();
  const commandOutput = edge.handleCoreMessage(command);
  await assertSchemaValid(commandOutput);
  assert.deepEqual(commandOutput.map((message) => message.type), [
    'stream.ack',
    'command.received',
    'command.completed',
  ]);
  assert.equal(edge.snapshot.echoExecutionCount, 1);

  const replayOutput = edge.handleCoreMessage(structuredClone(command));
  await assertSchemaValid(replayOutput);
  assert.deepEqual(replayOutput.map((message) => message.type), [
    'stream.ack',
    'command.received',
    'command.completed',
  ]);
  const replayedCompletion = replayOutput.find((message) => message.type === 'command.completed');
  assert(replayedCompletion?.type === 'command.completed');
  assert.equal(replayedCompletion.payload.replayed, true);
  assert.equal(edge.snapshot.echoExecutionCount, 1);

  const conflict = core.echoCommand({ message: 'hello edge changed' });
  const conflictOutput = edge.handleCoreMessage(conflict);
  await assertSchemaValid(conflictOutput);
  assert.deepEqual(conflictOutput.map((message) => message.type), ['stream.ack', 'command.rejected']);
  const rejection = conflictOutput.find((message) => message.type === 'command.rejected');
  assert(rejection?.type === 'command.rejected');
  assert.equal(rejection.payload.code, 'idempotency_conflict');
  assert.equal(edge.snapshot.echoExecutionCount, 1);

  const durableEdgeMessages = [...desiredOutput, ...commandOutput, ...replayOutput, ...conflictOutput]
    .filter((message): message is Exclude<DeviceV1ControlMessage, { type: 'stream.ack' }> => message.type !== 'stream.ack')
    .filter((message) => 'sequence' in message);
  const highestEdgeSequence = Math.max(...durableEdgeMessages.map((message) => Number(message.sequence)));
  edge.handleCoreMessage(core.acknowledgeEdge(highestEdgeSequence));

  const reconnectHello = edge.createHello();
  await assertSchemaValid([reconnectHello]);
  assert.equal(reconnectHello.resume.last_core_sequence, conflict.sequence);
  assert.equal(reconnectHello.resume.last_edge_sequence_acked, highestEdgeSequence);

  const reconnectWelcome = core.acceptHello(reconnectHello);
  await assertSchemaValid([reconnectWelcome]);
  assert.equal(reconnectWelcome.resume.accepted, true);
  assert.deepEqual(edge.handleCoreMessage(reconnectWelcome), []);
});

test('idempotency conflict uses a new transport sequence and the same logical key', () => {
  const core = new CoreGatewayHarness();
  const first = core.echoCommand();
  const conflict = core.echoCommand({ message: 'hello edge changed' });

  assert.equal(first.payload.idempotency_key, conflict.payload.idempotency_key);
  assert.notEqual(first.payload.request_digest, conflict.payload.request_digest);
  assert.equal(conflict.sequence, first.sequence + 1);
  assert((conflict satisfies DiagnosticsEchoCommandIssue));
});
