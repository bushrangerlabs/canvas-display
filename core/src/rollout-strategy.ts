/**
 * Phase 7 — Canary / Staged Rollout Strategy (plan doc §21.3, §25 Phase 7 checklist).
 *
 * Defines how updates are rolled out to Edge devices:
 * - `staged` — percentage-based rollout (e.g. 10% → 25% → 50% → 100%)
 * - `canary` — specific device IDs or groups get the update first
 * - `controlled` — manual approval between stages
 *
 * In-memory storage via `Map` for now, structured so a Postgres-backed repository can
 * replace it later (the schema mirrors a `rollout_plans` + `rollout_stages` table pair).
 */

import { randomUUID } from 'node:crypto';
import type { AdminRole } from './auth.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RolloutStrategyKind = 'staged' | 'canary' | 'controlled';

export interface RolloutStage {
  /** Human-readable label, e.g. "10%", "canary", "approval-1". */
  label: string;
  /** Percentage of eligible devices to target in this stage (0–100). */
  percentage: number;
  /** Whether this stage requires manual approval to proceed. */
  requiresApproval: boolean;
  /** Whether this stage has been approved (for controlled rollouts). */
  approved: boolean;
  /** Whether this stage has been reached and actioned. */
  reached: boolean;
  /** Timestamp when this stage was entered (millis since epoch). */
  reachedAt: number | null;
}

export type RolloutStatus = 'pending' | 'active' | 'paused' | 'rolled_back' | 'completed' | 'failed';

export interface RolloutPlan {
  /** Unique rollout plan identifier. */
  id: string;
  /** Rollout strategy kind. */
  strategy: RolloutStrategyKind;
  /** Target update version (e.g. "0.1.30"). */
  targetVersion: string;
  /** Ordered list of stages. */
  stages: RolloutStage[];
  /** Index into `stages` that is currently active (or -1 if none). */
  currentStageIndex: number;
  /** Overall rollout status. */
  status: RolloutStatus;
  /** Device IDs that have been updated so far. */
  updatedDeviceIds: string[];
  /** Device IDs where the update failed. */
  failedDeviceIds: string[];
  /** Optional canary device IDs (only for canary strategy). */
  canaryDeviceIds: string[];
  /** Number of approvals still required for the current controlled stage. */
  approvalsRemaining: number;
  /** Total approvals required per stage (for controlled). */
  approvalsRequired: number;
  /** Timestamp when the plan was created. */
  createdAt: number;
  /** Timestamp of last status change. */
  updatedAt: number;
  /** Health metrics snapshot at last check. */
  healthMetrics: {
    devicesOnline: number;
    devicesOffline: number;
    devicesOnTarget: number;
    errorRate: number;
  };
  /** Human-readable reason for the current status (e.g. pause/rollback reason). */
  reason: string;
}

export interface CreateRolloutBody {
  strategy: RolloutStrategyKind;
  targetVersion: string;
  /** For staged strategy: percentage thresholds, e.g. [10, 25, 50, 100]. */
  stagedPercentages?: number[];
  /** For canary strategy: device IDs that get the update first. */
  canaryDeviceIds?: string[];
  /** For controlled strategy: approvals required per stage (default 1). */
  approvalsRequired?: number;
}

export interface RolloutStatusResponse {
  id: string;
  strategy: RolloutStrategyKind;
  targetVersion: string;
  status: RolloutStatus;
  currentStage: RolloutStage | null;
  stages: RolloutStage[];
  updatedDeviceIds: string[];
  failedDeviceIds: string[];
  canaryDeviceIds: string[];
  approvalsRemaining: number;
  healthMetrics: RolloutPlan['healthMetrics'];
  reason: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// In-memory repository (swappable for PgRolloutRepository later)
// ---------------------------------------------------------------------------

export interface RolloutRepository {
  create(plan: RolloutPlan): Promise<RolloutPlan>;
  findById(id: string): Promise<RolloutPlan | null>;
  update(plan: RolloutPlan): Promise<void>;
  list(): Promise<RolloutPlan[]>;
}

export class InMemoryRolloutRepository implements RolloutRepository {
  private readonly plans = new Map<string, RolloutPlan>();

  async create(plan: RolloutPlan): Promise<RolloutPlan> {
    this.plans.set(plan.id, { ...plan });
    return plan;
  }

  async findById(id: string): Promise<RolloutPlan | null> {
    return this.plans.get(id) ?? null;
  }

  async update(plan: RolloutPlan): Promise<void> {
    this.plans.set(plan.id, { ...plan });
  }

  async list(): Promise<RolloutPlan[]> {
    return Array.from(this.plans.values());
  }
}

// ---------------------------------------------------------------------------
// RolloutStrategy — core logic
// ---------------------------------------------------------------------------

export class RolloutStrategy {
  constructor(private readonly repo: RolloutRepository) {}

  /**
   * Create a new rollout plan.
   */
  async createPlan(body: CreateRolloutBody): Promise<RolloutPlan> {
    const stages = this.buildStages(body);
    const now = Date.now();

    const plan: RolloutPlan = {
      id: randomUUID(),
      strategy: body.strategy,
      targetVersion: body.targetVersion,
      stages,
      currentStageIndex: -1,
      status: 'pending',
      updatedDeviceIds: [],
      failedDeviceIds: [],
      canaryDeviceIds: body.canaryDeviceIds ?? [],
      approvalsRemaining: 0,
      approvalsRequired: body.approvalsRequired ?? 1,
      createdAt: now,
      updatedAt: now,
      healthMetrics: {
        devicesOnline: 0,
        devicesOffline: 0,
        devicesOnTarget: 0,
        errorRate: 0,
      },
      reason: '',
    };

    await this.repo.create(plan);
    return plan;
  }

  /**
   * Advance to the next stage. For controlled rollouts, this counts as an approval
   * if the current stage requires it.
   */
  async advance(id: string): Promise<RolloutPlan> {
    const plan = await this.repo.findById(id);
    if (!plan) throw new Error(`rollout not found: ${id}`);
    if (plan.status === 'rolled_back') throw new Error('rollout is rolled back');
    if (plan.status === 'completed') throw new Error('rollout is already completed');

    const now = Date.now();

    // If the rollout is paused, un-pause and stay on the same stage.
    if (plan.status === 'paused') {
      plan.status = 'active';
      plan.updatedAt = now;
      plan.reason = '';
      await this.repo.update(plan);
      return plan;
    }

    // Controlled: requires approval before advancing.
    if (plan.strategy === 'controlled' && plan.currentStageIndex >= 0) {
      const current = plan.stages[plan.currentStageIndex];
      if (current && current.requiresApproval && !current.approved) {
        if (plan.approvalsRemaining > 0) {
          plan.approvalsRemaining--;
          plan.updatedAt = now;
          await this.repo.update(plan);
          return plan;
        }
        // All approvals collected; mark stage approved.
        current.approved = true;
        plan.updatedAt = now;
        plan.reason = '';
      }
    }

    // If we haven't started, start at stage 0.
    if (plan.currentStageIndex === -1) {
      plan.status = 'active';
      plan.currentStageIndex = 0;
    } else {
      // Move to next stage.
      const nextIndex = plan.currentStageIndex + 1;
      if (nextIndex >= plan.stages.length) {
        plan.status = 'completed';
        plan.updatedAt = now;
        await this.repo.update(plan);
        return plan;
      }
      plan.currentStageIndex = nextIndex;
    }

    const stage = plan.stages[plan.currentStageIndex];
    stage.reached = true;
    stage.reachedAt = now;

    // For controlled rollouts, set approvals required.
    if (plan.strategy === 'controlled' && stage.requiresApproval) {
      plan.approvalsRemaining = plan.approvalsRequired;
      stage.approved = false;
    } else {
      plan.approvalsRemaining = 0;
      stage.approved = true;
    }

    plan.updatedAt = now;
    plan.reason = '';
    await this.repo.update(plan);
    return plan;
  }

  /**
   * Pause a rollout. Requires a reason.
   */
  async pause(id: string, reason: string): Promise<RolloutPlan> {
    const plan = await this.repo.findById(id);
    if (!plan) throw new Error(`rollout not found: ${id}`);
    if (plan.status === 'rolled_back') throw new Error('rollout is already rolled back');
    if (plan.status === 'completed') throw new Error('rollout is already completed');
    if (plan.status === 'pending') throw new Error('rollout has not started');

    plan.status = 'paused';
    plan.reason = reason || 'paused by operator';
    plan.updatedAt = Date.now();
    await this.repo.update(plan);
    return plan;
  }

  /**
   * Rollback a rollout. All updated devices should be reverted.
   */
  async rollback(id: string, reason: string): Promise<RolloutPlan> {
    const plan = await this.repo.findById(id);
    if (!plan) throw new Error(`rollout not found: ${id}`);
    if (plan.status === 'rolled_back') throw new Error('rollout is already rolled back');

    plan.status = 'rolled_back';
    plan.reason = reason || 'rolled back by operator';
    plan.updatedAt = Date.now();
    await this.repo.update(plan);
    return plan;
  }

  /**
   * Get the status of a rollout.
   */
  async getStatus(id: string): Promise<RolloutStatusResponse> {
    const plan = await this.repo.findById(id);
    if (!plan) throw new Error(`rollout not found: ${id}`);
    return this.toStatusResponse(plan);
  }

  /**
   * Record that a device was successfully updated as part of this rollout.
   */
  async recordDeviceUpdated(id: string, deviceId: string): Promise<void> {
    const plan = await this.repo.findById(id);
    if (!plan) throw new Error(`rollout not found: ${id}`);
    if (!plan.updatedDeviceIds.includes(deviceId)) {
      plan.updatedDeviceIds.push(deviceId);
    }
    plan.updatedAt = Date.now();
    await this.repo.update(plan);
  }

  /**
   * Record that a device failed to update.
   */
  async recordDeviceFailed(id: string, deviceId: string): Promise<void> {
    const plan = await this.repo.findById(id);
    if (!plan) throw new Error(`rollout not found: ${id}`);
    if (!plan.failedDeviceIds.includes(deviceId)) {
      plan.failedDeviceIds.push(deviceId);
    }
    plan.updatedAt = Date.now();
    await this.repo.update(plan);
  }

  /**
   * Update health metrics for a rollout.
   */
  async updateHealthMetrics(
    id: string,
    metrics: Partial<RolloutPlan['healthMetrics']>,
  ): Promise<void> {
    const plan = await this.repo.findById(id);
    if (!plan) throw new Error(`rollout not found: ${id}`);
    Object.assign(plan.healthMetrics, metrics);
    plan.updatedAt = Date.now();
    await this.repo.update(plan);
  }

  /**
   * Determine if a given device is eligible for the current stage.
   * Uses a deterministic hash of (deviceId, rolloutId) for percentage-based targeting.
   */
  isDeviceEligible(plan: RolloutPlan, deviceId: string): boolean {
    if (plan.status !== 'active') return false;
    if (plan.currentStageIndex < 0) return false;
    if (plan.updatedDeviceIds.includes(deviceId)) return true; // already updated
    if (plan.failedDeviceIds.includes(deviceId)) return false;

    const stage = plan.stages[plan.currentStageIndex];
    if (!stage || !stage.reached) return false;

    // For canary rollouts, only specific devices are eligible.
    if (plan.strategy === 'canary') {
      if (plan.canaryDeviceIds.includes(deviceId)) return true;
      // For non-canary devices, fall through to percentage check.
    }

    // Deterministic percentage check: hash(deviceId + rolloutId) % 100 < percentage
    const hash = this.simpleHash(`${deviceId}:${plan.id}`);
    return (hash % 100) < stage.percentage;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildStages(body: CreateRolloutBody): RolloutStage[] {
    switch (body.strategy) {
      case 'staged': {
        const percentages = body.stagedPercentages ?? [10, 25, 50, 100];
        return percentages.map((pct) => ({
          label: `${pct}%`,
          percentage: pct,
          requiresApproval: false,
          approved: true,
          reached: false,
          reachedAt: null,
        }));
      }
      case 'canary': {
        const stages: RolloutStage[] = [
          {
            label: 'canary',
            percentage: 5,
            requiresApproval: false,
            approved: true,
            reached: false,
            reachedAt: null,
          },
          {
            label: '10%',
            percentage: 10,
            requiresApproval: false,
            approved: true,
            reached: false,
            reachedAt: null,
          },
          {
            label: '25%',
            percentage: 25,
            requiresApproval: false,
            approved: true,
            reached: false,
            reachedAt: null,
          },
          {
            label: '50%',
            percentage: 50,
            requiresApproval: false,
            approved: true,
            reached: false,
            reachedAt: null,
          },
          {
            label: '100%',
            percentage: 100,
            requiresApproval: false,
            approved: true,
            reached: false,
            reachedAt: null,
          },
        ];
        return stages;
      }
      case 'controlled': {
        const approvalsRequired = body.approvalsRequired ?? 1;
        return [
          {
            label: '10%',
            percentage: 10,
            requiresApproval: true,
            approved: false,
            reached: false,
            reachedAt: null,
          },
          {
            label: '25%',
            percentage: 25,
            requiresApproval: true,
            approved: false,
            reached: false,
            reachedAt: null,
          },
          {
            label: '50%',
            percentage: 50,
            requiresApproval: true,
            approved: false,
            reached: false,
            reachedAt: null,
          },
          {
            label: '100%',
            percentage: 100,
            requiresApproval: true,
            approved: false,
            reached: false,
            reachedAt: null,
          },
        ];
      }
      default: {
        throw new Error(`unknown strategy: ${body.strategy}`);
      }
    }
  }

  /** Simple non-cryptographic hash for deterministic device eligibility. */
  private simpleHash(input: string): number {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) + hash) + input.charCodeAt(i);
      hash = hash & 0x7fffffff; // keep positive
    }
    return hash;
  }

  private toStatusResponse(plan: RolloutPlan): RolloutStatusResponse {
    return {
      id: plan.id,
      strategy: plan.strategy,
      targetVersion: plan.targetVersion,
      status: plan.status,
      currentStage: plan.currentStageIndex >= 0 ? plan.stages[plan.currentStageIndex] : null,
      stages: plan.stages,
      updatedDeviceIds: plan.updatedDeviceIds,
      failedDeviceIds: plan.failedDeviceIds,
      canaryDeviceIds: plan.canaryDeviceIds,
      approvalsRemaining: plan.approvalsRemaining,
      healthMetrics: plan.healthMetrics,
      reason: plan.reason,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Fastify route registration
// ---------------------------------------------------------------------------

export function registerRolloutRoutes(
  fastify: FastifyInstance,
  opts: {
    strategy: RolloutStrategy;
    requireAdmin: (opts?: { roles?: AdminRole[]; csrf?: boolean }) => (req: any, reply: any) => Promise<void>;
  },
): void {
  const { strategy, requireAdmin } = opts;

  // POST /api/admin/rollout/create — create a rollout plan
  fastify.post(
    '/api/admin/rollout/create',
    { preHandler: requireAdmin({ roles: ['admin'] }) },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const { strategy: strat, targetVersion, stagedPercentages, canaryDeviceIds, approvalsRequired } = body ?? {};

      if (typeof strat !== 'string' || !['staged', 'canary', 'controlled'].includes(strat)) {
        reply.code(400);
        return { error: 'strategy must be "staged", "canary", or "controlled"' };
      }
      if (typeof targetVersion !== 'string' || targetVersion.length === 0) {
        reply.code(400);
        return { error: 'targetVersion is required' };
      }

      try {
        const plan = await strategy.createPlan({
          strategy: strat as any,
          targetVersion,
          stagedPercentages: Array.isArray(stagedPercentages) ? stagedPercentages.map(Number) : undefined,
          canaryDeviceIds: Array.isArray(canaryDeviceIds) ? canaryDeviceIds.map(String) : undefined,
          approvalsRequired: typeof approvalsRequired === 'number' ? approvalsRequired : undefined,
        });
        reply.code(201);
        return { ok: true, id: plan.id, targetVersion: plan.targetVersion, strategy: plan.strategy, stages: plan.stages.length };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  // POST /api/admin/rollout/:id/advance — advance to next stage
  fastify.post(
    '/api/admin/rollout/:id/advance',
    { preHandler: requireAdmin({ roles: ['admin'] }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const plan = await strategy.advance(id);
        return { ok: true, status: plan.status, currentStage: plan.currentStageIndex };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  // GET /api/admin/rollout/:id/status — get rollout status
  fastify.get(
    '/api/admin/rollout/:id/status',
    { preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await strategy.getStatus(id);
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    },
  );

  // POST /api/admin/rollout/:id/pause — pause a rollout
  fastify.post(
    '/api/admin/rollout/:id/pause',
    { preHandler: requireAdmin({ roles: ['admin'] }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { reason?: string } | undefined;
      try {
        const plan = await strategy.pause(id, body?.reason ?? '');
        return { ok: true, status: plan.status };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  // POST /api/admin/rollout/:id/rollback — rollback a rollout
  fastify.post(
    '/api/admin/rollout/:id/rollback',
    { preHandler: requireAdmin({ roles: ['admin'] }) },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { reason?: string } | undefined;
      try {
        const plan = await strategy.rollback(id, body?.reason ?? '');
        return { ok: true, status: plan.status };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );
}