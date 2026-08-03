import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  InMemoryRolloutRepository,
  RolloutStrategy,
  registerRolloutRoutes,
  type CreateRolloutBody,
  type RolloutPlan,
} from '../src/rollout-strategy.js';

const UPDATER_PASSPHRASE = 'test-updater-passphrase';

// Helper: build a minimal Fastify server with rollout routes and a fake auth.
async function buildRolloutServer() {
  const fastify = Fastify({ logger: false });
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  // Fake requireAdmin that passes through.
  function requireAdmin(
    _opts?: { roles?: string[]; csrf?: boolean },
  ): (req: any, reply: any) => Promise<void> {
    return async (_req: any, _reply: any) => {};
  }

  registerRolloutRoutes(fastify, { strategy, requireAdmin });

  // Health endpoint for convenience.
  fastify.get('/health', async () => ({ status: 'ok' }));

  await fastify.ready();
  return { fastify, strategy, repo };
}

// ---------------------------------------------------------------------------
// Unit tests for RolloutStrategy
// ---------------------------------------------------------------------------

test('createPlan creates a staged rollout with default percentages', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({
    strategy: 'staged',
    targetVersion: '0.1.30',
  });

  assert.ok(plan.id);
  assert.equal(plan.strategy, 'staged');
  assert.equal(plan.targetVersion, '0.1.30');
  assert.equal(plan.status, 'pending');
  assert.equal(plan.stages.length, 4);
  assert.equal(plan.stages[0].percentage, 10);
  assert.equal(plan.stages[1].percentage, 25);
  assert.equal(plan.stages[2].percentage, 50);
  assert.equal(plan.stages[3].percentage, 100);
  assert.equal(plan.currentStageIndex, -1);
});

test('createPlan creates a canary rollout with default stages', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({
    strategy: 'canary',
    targetVersion: '0.2.0',
    canaryDeviceIds: ['device-alpha', 'device-beta'],
  });

  assert.equal(plan.strategy, 'canary');
  assert.equal(plan.canaryDeviceIds.length, 2);
  assert.ok(plan.canaryDeviceIds.includes('device-alpha'));
  assert.equal(plan.stages.length, 5);
  assert.equal(plan.stages[0].label, 'canary');
});

test('createPlan creates a controlled rollout with approval stages', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({
    strategy: 'controlled',
    targetVersion: '0.3.0',
    approvalsRequired: 2,
  });

  assert.equal(plan.strategy, 'controlled');
  assert.equal(plan.approvalsRequired, 2);
  assert.equal(plan.stages.length, 4);
  for (const stage of plan.stages) {
    assert.equal(stage.requiresApproval, true);
  }
});

test('advance starts a pending rollout at stage 0', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  assert.equal(plan.status, 'pending');
  assert.equal(plan.currentStageIndex, -1);

  const advanced = await strategy.advance(plan.id);
  assert.equal(advanced.status, 'active');
  assert.equal(advanced.currentStageIndex, 0);
  assert.ok(advanced.stages[0].reached);
  assert.ok(advanced.stages[0].reachedAt !== null);
});

test('advance progresses through stages and completes', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({
    strategy: 'staged',
    targetVersion: '0.1.0',
    stagedPercentages: [10, 50, 100],
  });
  assert.equal(plan.stages.length, 3);

  // Stage 0
  let p = await strategy.advance(plan.id);
  assert.equal(p.currentStageIndex, 0);
  assert.equal(p.status, 'active');

  // Stage 1
  p = await strategy.advance(plan.id);
  assert.equal(p.currentStageIndex, 1);

  // Stage 2
  p = await strategy.advance(plan.id);
  assert.equal(p.currentStageIndex, 2);

  // Complete
  p = await strategy.advance(plan.id);
  assert.equal(p.status, 'completed');
  assert.equal(p.currentStageIndex, 2);
});

test('advance errors on rolled back or completed rollout', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.rollback(plan.id, 'testing');
  await assert.rejects(() => strategy.advance(plan.id), /rolled back/);

  const plan2 = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan2.id); // stage 0 (10%)
  await strategy.advance(plan2.id); // stage 1 (25%)
  await strategy.advance(plan2.id); // stage 2 (50%)
  await strategy.advance(plan2.id); // stage 3 (100%)
  await strategy.advance(plan2.id); // completed
  // Now it should be completed
  await assert.rejects(() => strategy.advance(plan2.id), /already completed/);
});

test('pause pauses an active rollout', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan.id);
  const paused = await strategy.pause(plan.id, 'testing pause');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reason, 'testing pause');
});

test('pause errors on pending or rolled back', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await assert.rejects(() => strategy.pause(plan.id, 'nope'), /has not started/);

  await strategy.rollback(plan.id, 'rb');
  await assert.rejects(() => strategy.pause(plan.id, 'nope'), /rolled back/);
});

test('advance un-pauses a paused rollout', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan.id);
  await strategy.pause(plan.id, 'pause for inspection');
  const resumed = await strategy.advance(plan.id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.currentStageIndex, 0);
});

test('rollback sets status to rolled_back', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan.id);
  const rb = await strategy.rollback(plan.id, 'found a bug');
  assert.equal(rb.status, 'rolled_back');
  assert.equal(rb.reason, 'found a bug');
  // Cannot rollback twice
  await assert.rejects(() => strategy.rollback(plan.id, 'again'), /already rolled back/);
});

test('canary targeting: eligible devices match', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({
    strategy: 'canary',
    targetVersion: '0.1.0',
    canaryDeviceIds: ['canary-1', 'canary-2'],
  });

  // Before advance, no devices are eligible.
  assert.equal(strategy.isDeviceEligible(plan, 'canary-1'), false);

  const advanced = await strategy.advance(plan.id);

  // Canary devices should be eligible.
  assert.equal(strategy.isDeviceEligible(advanced, 'canary-1'), true);
  assert.equal(strategy.isDeviceEligible(advanced, 'canary-2'), true);

  // Non-canary devices may be eligible via percentage (5% chance).
  // We can't assert deterministically, but we can verify the function doesn't throw.
  const eligible = strategy.isDeviceEligible(advanced, 'other-device');
  assert.equal(typeof eligible, 'boolean');
});

test('isDeviceEligible returns false for already failed devices', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0', stagedPercentages: [100] });
  await strategy.advance(plan.id);
  await strategy.recordDeviceFailed(plan.id, 'bad-device');
  const updatedPlan = await repo.findById(plan.id);
  assert.ok(updatedPlan);
  assert.equal(strategy.isDeviceEligible(updatedPlan, 'bad-device'), false);
  assert.equal(strategy.isDeviceEligible(updatedPlan, 'good-device'), true);
});

test('getStatus returns current stage info', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan.id);
  await strategy.recordDeviceUpdated(plan.id, 'dev-1');
  await strategy.recordDeviceUpdated(plan.id, 'dev-2');

  const status = await strategy.getStatus(plan.id);
  assert.equal(status.id, plan.id);
  assert.equal(status.status, 'active');
  assert.equal(status.updatedDeviceIds.length, 2);
  assert.ok(status.currentStage);
  assert.equal(status.currentStage.label, '10%');
});

test('updateHealthMetrics updates in place', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.updateHealthMetrics(plan.id, { devicesOnline: 42, errorRate: 0.01 });
  await strategy.advance(plan.id);
  await strategy.updateHealthMetrics(plan.id, { devicesOnTarget: 5 });

  const status = await strategy.getStatus(plan.id);
  assert.equal(status.healthMetrics.devicesOnline, 42);
  assert.equal(status.healthMetrics.errorRate, 0.01);
  assert.equal(status.healthMetrics.devicesOnTarget, 5);
});

test('controlled rollout requires approvals to advance', async () => {
  const repo = new InMemoryRolloutRepository();
  const strategy = new RolloutStrategy(repo);

  const plan = await strategy.createPlan({
    strategy: 'controlled',
    targetVersion: '0.1.0',
    approvalsRequired: 2,
  });

  // Start — this sets current stage and initialises approvalsRemaining=2.
  let p = await strategy.advance(plan.id);
  assert.equal(p.currentStageIndex, 0);
  assert.equal(p.approvalsRemaining, 2);

  // First approval decrements approvalsRemaining.
  p = await strategy.advance(plan.id);
  assert.equal(p.approvalsRemaining, 1);
  assert.equal(p.currentStageIndex, 0); // still on same stage

  // Second approval decrements to 0 but still on same stage.
  p = await strategy.advance(plan.id);
  assert.equal(p.approvalsRemaining, 0);
  assert.equal(p.currentStageIndex, 0);

  // Third approval: all approvals collected, marks stage approved, advances.
  p = await strategy.advance(plan.id);
  assert.equal(p.currentStageIndex, 1);
  assert.equal(p.approvalsRemaining, 2); // next stage approvals reset
  assert.ok(p.stages[0].approved);
  assert.equal(p.stages[1].approved, false);
});

// ---------------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------------

test('POST /api/admin/rollout/create returns 201 with plan id', async () => {
  const { fastify } = await buildRolloutServer();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/rollout/create',
    payload: { strategy: 'staged', targetVersion: '0.1.30' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.id);
  assert.equal(body.targetVersion, '0.1.30');
});

test('POST /api/admin/rollout/create validates required fields', async () => {
  const { fastify } = await buildRolloutServer();

  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/rollout/create',
    payload: { strategy: 'invalid' },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(res.json().error);
});

test('POST /api/admin/rollout/:id/advance progresses', async () => {
  const { fastify, strategy } = await buildRolloutServer();
  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/admin/rollout/${plan.id}/advance`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'active');
  assert.equal(body.currentStage, 0);
});

test('GET /api/admin/rollout/:id/status returns status', async () => {
  const { fastify, strategy } = await buildRolloutServer();
  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan.id);

  const res = await fastify.inject({
    method: 'GET',
    url: `/api/admin/rollout/${plan.id}/status`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, plan.id);
  assert.equal(body.status, 'active');
  assert.ok(body.stages);
});

test('POST /api/admin/rollout/:id/pause pauses rollout', async () => {
  const { fastify, strategy } = await buildRolloutServer();
  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan.id);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/admin/rollout/${plan.id}/pause`,
    payload: { reason: 'nightly maintenance' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'paused');
});

test('POST /api/admin/rollout/:id/rollback rolls back', async () => {
  const { fastify, strategy } = await buildRolloutServer();
  const plan = await strategy.createPlan({ strategy: 'staged', targetVersion: '0.1.0' });
  await strategy.advance(plan.id);

  const res = await fastify.inject({
    method: 'POST',
    url: `/api/admin/rollout/${plan.id}/rollback`,
    payload: { reason: 'critical bug found' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'rolled_back');
});

test('GET /api/admin/rollout/:id/status returns 404 for unknown id', async () => {
  const { fastify } = await buildRolloutServer();

  const res = await fastify.inject({
    method: 'GET',
    url: '/api/admin/rollout/nonexistent/status',
  });
  assert.equal(res.statusCode, 404);
});

test('health endpoint still works', async () => {
  const { fastify } = await buildRolloutServer();

  const res = await fastify.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});