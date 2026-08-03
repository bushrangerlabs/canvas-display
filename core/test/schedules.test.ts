import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './db-helpers.js';
import { PgScheduleRepository } from '../src/schedules.js';
import {
  createSchedule,
  listSchedules,
  deleteSchedule,
  queryPendingOccurrences,
  dispatchOccurrence,
  markOccurrenceMissed,
  reconcileOfflineOccurrences,
  SchedulerService,
  getSchedule,
  triggerSchedule,
} from '../src/schedules.js';

// --- Unit tests ---------------------------------------------------------------

test('createSchedule creates a schedule and generates occurrences', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  const schedule = await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 60000).toISOString() }),
  });

  assert.ok(schedule.id);
  assert.equal(schedule.sceneId, 'scene-1');
  assert.equal(schedule.scheduleType, 'once');
  assert.equal(schedule.active, true);
  assert.equal(schedule.maxLatenessMs, 300000);
  assert.ok(schedule.createdAt);

  // Should have one pending occurrence.
  const pending = await queryPendingOccurrences(repo);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].scheduleId, schedule.id);
  assert.equal(pending[0].status, 'pending');
});

test('listSchedules returns all schedules', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 60000).toISOString() }),
  });
  await createSchedule(repo, {
    sceneId: 'scene-2',
    scheduleType: 'daily',
    configJson: JSON.stringify({ time: '08:00' }),
  });

  const schedules = await listSchedules(repo);
  assert.equal(schedules.length, 2);
});

test('deleteSchedule removes schedule and its occurrences', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  const schedule = await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 60000).toISOString() }),
  });

  const deleted = await deleteSchedule(repo, schedule.id);
  assert.equal(deleted, true);

  // Schedule should be gone.
  const found = await getSchedule(repo, schedule.id);
  assert.equal(found, null);

  // Occurrences should be gone too.
  const pending = await queryPendingOccurrences(repo);
  assert.equal(pending.length, 0);
});

test('queryPendingOccurrences only returns due pending occurrences', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  // Create a schedule with an occurrence in the past (should be due).
  const schedule = await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 60000).toISOString() }),
  });

  // Query pending — should include the past occurrence.
  const pending = await queryPendingOccurrences(repo);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].scheduleId, schedule.id);
  assert.equal(pending[0].status, 'pending');
});

test('dispatchOccurrence is idempotent (same durable_id never executes twice)', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  // Create a schedule.
  const schedule = await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 60000).toISOString() }),
  });

  const pending = await queryPendingOccurrences(repo);
  assert.equal(pending.length, 1);

  const occ = pending[0];

  // First dispatch should succeed.
  const result1 = await dispatchOccurrence(repo, occ.id, occ.durableId);
  assert.equal(result1, true);

  // Second dispatch with same id should fail (idempotent).
  const result2 = await dispatchOccurrence(repo, occ.id, occ.durableId);
  assert.equal(result2, false);

  // Verify status is 'dispatched'.
  const check = await repo.query(
    'SELECT status FROM schedule_occurrences WHERE id = $1',
    [occ.id],
  );
  assert.equal(check.rows[0].status, 'dispatched');
});

test('max-lateness marks missed occurrences', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  // Create a schedule with an occurrence far in the past and a small max_lateness.
  const schedule = await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 3600000).toISOString() }), // 1 hour ago
    maxLatenessMs: 60000, // only 1 minute allowed
  });

  // Run offline reconciliation.
  const result = await reconcileOfflineOccurrences(repo);
  assert.equal(result.missed, 1);
  assert.equal(result.dispatched, 0);

  // Verify the occurrence is marked as missed.
  const pending = await queryPendingOccurrences(repo);
  assert.equal(pending.length, 0);
  const check = await repo.query(
    'SELECT status FROM schedule_occurrences WHERE schedule_id = $1',
    [schedule.id],
  );
  assert.equal(check.rows[0].status, 'missed');
});

test('offline boot catches and dispatches occurrences within lateness window', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  // Create a schedule with an occurrence slightly in the past (within lateness).
  const schedule = await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 10000).toISOString() }), // 10s ago
    maxLatenessMs: 60000, // 1 minute allowed
  });

  // Run offline reconciliation.
  const result = await reconcileOfflineOccurrences(repo);
  assert.equal(result.dispatched, 1);
  assert.equal(result.missed, 0);

  // Verify the occurrence is dispatched.
  const check = await repo.query(
    'SELECT status FROM schedule_occurrences WHERE schedule_id = $1',
    [schedule.id],
  );
  assert.equal(check.rows[0].status, 'dispatched');
});

test('SchedulerService polls and dispatches pending occurrences', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  // Create a schedule with an occurrence in the past.
  await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() - 60000).toISOString() }),
  });

  // Create a custom dispatch handler that tracks calls.
  let dispatchedCount = 0;
  const service = new SchedulerService({
    repo,
    pollIntervalMs: 100,
    batchSize: 10,
    dispatchHandler: async () => {
      dispatchedCount++;
      return true;
    },
  });

  service.start();

  // Wait for the poll to run.
  await new Promise((resolve) => setTimeout(resolve, 200));

  service.stop();

  // Should have dispatched the occurrence.
  assert.equal(dispatchedCount, 1);

  // Verify it's marked dispatched.
  const pending = await queryPendingOccurrences(repo);
  assert.equal(pending.length, 0);
});

test('triggerSchedule creates a pending occurrence now', async () => {
  const { pool } = createTestDb();
  const repo = new PgScheduleRepository(pool);

  const schedule = await createSchedule(repo, {
    sceneId: 'scene-1',
    scheduleType: 'once',
    configJson: JSON.stringify({ time: new Date(Date.now() + 3600000).toISOString() }),
  });

  const occ = await triggerSchedule(repo, schedule.id);
  assert.ok(occ.id);
  assert.equal(occ.scheduleId, schedule.id);
  assert.equal(occ.status, 'pending');
  assert.ok(occ.durableId);
});