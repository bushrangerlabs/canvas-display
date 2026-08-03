import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { ToolContext, ToolRegistry, ToolRole } from './tool-registry.js';
import type { RoutinePlanner } from './routine-planner.js';

const triggerSchema = z.object({ type: z.enum(['manual', 'voice', 'schedule', 'mqtt', 'ha_event', 'webhook', 'canvas_button']) }).passthrough();
const stepSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  kind: z.enum(['tool', 'condition', 'delay', 'routine', 'result']),
  config: z.record(z.unknown()),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  onFailure: z.enum(['stop', 'continue']).optional(),
}).strict();

export const routineDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  owner: z.enum(['canvas_core', 'home_assistant', 'hybrid', 'clarification_required']),
  triggers: z.array(triggerSchema).max(20),
  inputs: z.record(z.unknown()),
  steps: z.array(stepSchema).max(100),
  result: z.record(z.unknown()),
  limits: z.object({
    timeoutMs: z.number().int().min(100).max(300_000),
    maxSteps: z.number().int().min(1).max(100),
    maxRoutineDepth: z.number().int().min(1).max(5),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const [index, step] of value.steps.entries()) {
    if (ids.has(step.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'id'], message: 'step IDs must be unique' });
    ids.add(step.id);
    if (step.kind === 'tool' && typeof step.config.tool !== 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index, 'config', 'tool'], message: 'tool step requires a tool name' });
  }
  if (value.steps.length > value.limits.maxSteps) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'steps exceed limits.maxSteps' });
  if (value.owner === 'clarification_required' && value.steps.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: 'clarification-required drafts cannot contain executable steps' });
});

export type RoutineDefinition = z.infer<typeof routineDefinitionSchema>;
export type RoutineStatus = 'draft' | 'enabled' | 'disabled' | 'archived';

function validation(definition: unknown) {
  const parsed = routineDefinitionSchema.safeParse(definition);
  return parsed.success
    ? { valid: true as const, definition: parsed.data, errors: [] }
    : { valid: false as const, errors: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) };
}

export function validateRoutineDefinition(definition: unknown) { return validation(definition); }

async function tx<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export class RoutineRepository {
  constructor(readonly pool: Pool) {}

  async list() {
    const result = await this.pool.query(`SELECT r.*, ar.revision AS active_revision
      FROM routines r LEFT JOIN routine_revisions ar ON ar.id=r.active_revision_id
      ORDER BY r.name, r.created_at`);
    return result.rows;
  }

  async get(id: string) {
    const routine = await this.pool.query('SELECT * FROM routines WHERE id=$1', [id]);
    if (!routine.rows[0]) return null;
    const revisions = await this.pool.query('SELECT * FROM routine_revisions WHERE routine_id=$1 ORDER BY revision DESC', [id]);
    return { ...routine.rows[0], revisions: revisions.rows };
  }

  async create(definition: unknown, source = 'user') {
    const checked = validation(definition);
    if (!checked.valid) throw new RoutineError('routine_invalid', 400, checked.errors);
    return tx(this.pool, async client => {
      const id = randomUUID(); const revisionId = randomUUID();
      await client.query(`INSERT INTO routines (id,name,description,owner,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'draft',now(),now())`, [id, checked.definition.name, checked.definition.description ?? null, checked.definition.owner]);
      const result = await client.query(`INSERT INTO routine_revisions
        (id,routine_id,revision,definition,status,creation_source,validation_errors,created_at)
        VALUES ($1,$2,1,$3::jsonb,'draft',$4,'[]'::jsonb,now()) RETURNING *`,
        [revisionId, id, JSON.stringify(checked.definition), source]);
      return { id, status: 'draft', revision: result.rows[0] };
    });
  }

  async revise(id: string, definition: unknown, source = 'user') {
    const checked = validation(definition);
    if (!checked.valid) throw new RoutineError('routine_invalid', 400, checked.errors);
    return tx(this.pool, async client => {
      const exists = await client.query('SELECT id,status FROM routines WHERE id=$1 FOR UPDATE', [id]);
      if (!exists.rows[0]) throw new RoutineError('routine_not_found', 404);
      if (exists.rows[0].status === 'archived') throw new RoutineError('routine_archived', 409);
      const next = await client.query('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM routine_revisions WHERE routine_id=$1', [id]);
      const revision = Number(next.rows[0].revision); const revisionId = randomUUID();
      const inserted = await client.query(`INSERT INTO routine_revisions
        (id,routine_id,revision,definition,status,creation_source,validation_errors,created_at)
        VALUES ($1,$2,$3,$4::jsonb,'draft',$5,'[]'::jsonb,now()) RETURNING *`,
        [revisionId,id,revision,JSON.stringify(checked.definition),source]);
      await client.query('UPDATE routines SET name=$2,description=$3,owner=$4,updated_at=now() WHERE id=$1',
        [id,checked.definition.name,checked.definition.description ?? null,checked.definition.owner]);
      return inserted.rows[0];
    });
  }

  async enable(id: string, revision?: number) {
    return tx(this.pool, async client => {
      const selected = revision === undefined
        ? await client.query(`SELECT * FROM routine_revisions WHERE routine_id=$1
            ORDER BY revision DESC LIMIT 1`, [id])
        : await client.query('SELECT * FROM routine_revisions WHERE routine_id=$1 AND revision=$2::integer', [id, revision]);
      if (!selected.rows[0]) throw new RoutineError('routine_revision_not_found', 404);
      const checked = validation(selected.rows[0].definition);
      if (!checked.valid) throw new RoutineError('routine_invalid', 409, checked.errors);
      await client.query("UPDATE routine_revisions SET status='superseded' WHERE routine_id=$1 AND status='enabled'", [id]);
      await client.query("UPDATE routine_revisions SET status='enabled',enabled_at=now() WHERE id=$1", [selected.rows[0].id]);
      const result = await client.query("UPDATE routines SET active_revision_id=$2,status='enabled',updated_at=now() WHERE id=$1 AND status<>'archived' RETURNING *", [id,selected.rows[0].id]);
      if (!result.rows[0]) throw new RoutineError('routine_not_found_or_archived', 409);
      return { ...result.rows[0], active_revision: selected.rows[0].revision };
    });
  }

  async setStatus(id: string, status: 'disabled' | 'archived') {
    const result = await this.pool.query('UPDATE routines SET status=$2,updated_at=now() WHERE id=$1 RETURNING *', [id,status]);
    if (!result.rows[0]) throw new RoutineError('routine_not_found', 404);
    return result.rows[0];
  }

  async active(id: string) {
    const result = await this.pool.query(`SELECT r.id AS routine_id,r.status,rr.id AS revision_id,rr.revision,rr.definition
      FROM routines r JOIN routine_revisions rr ON rr.id=r.active_revision_id WHERE r.id=$1`, [id]);
    return result.rows[0] ?? null;
  }

  async latest(id: string) {
    const result = await this.pool.query(`SELECT r.id AS routine_id,r.status,rr.id AS revision_id,rr.revision,rr.definition
      FROM routines r JOIN routine_revisions rr ON rr.routine_id=r.id WHERE r.id=$1 ORDER BY rr.revision DESC LIMIT 1`, [id]);
    return result.rows[0] ?? null;
  }

  async execution(id: string) {
    const execution = await this.pool.query('SELECT * FROM routine_executions WHERE id=$1', [id]);
    if (!execution.rows[0]) return null;
    const steps = await this.pool.query('SELECT * FROM routine_step_results WHERE execution_id=$1 ORDER BY step_index', [id]);
    return { ...execution.rows[0], steps: steps.rows };
  }

  async executions(routineId: string) {
    return (await this.pool.query('SELECT * FROM routine_executions WHERE routine_id=$1 ORDER BY started_at DESC LIMIT 100', [routineId])).rows;
  }
}

interface RunOptions { inputs?: Record<string, unknown>; idempotencyKey?: string; origin?: string; originDeviceId?: string; principal?: string; role?: ToolRole; confirmed?: boolean; }

export class RoutineEngine {
  private readonly haLastStates=new Map<string,string>();
  constructor(private readonly repo: RoutineRepository, private readonly tools: ToolRegistry, private readonly baseContext: ToolContext) {}

  async simulate(routineId: string, role: ToolRole = 'admin') {
    const selected = await this.repo.latest(routineId);
    if (!selected) throw new RoutineError('routine_not_found',404);
    const definition = routineDefinitionSchema.parse(selected.definition);
    const steps = await Promise.all(definition.steps.map(async (step, index) => {
      if (step.kind !== 'tool') return { index, id: step.id, kind: step.kind, valid: true, mutates: false };
      const tool = String(step.config.tool); const args = asArgs(step.config.args);
      const checked = this.tools.validateToolCall(tool, args, role);
      const errors=[...checked.errors];
      if(tool.startsWith('ha.')&&typeof args.entity_id==='string'){
        const target=await this.repo.pool.query('SELECT 1 FROM ha_entities WHERE entity_id=$1',[args.entity_id]);
        if(!target.rowCount)errors.push(`entity_not_found: "${args.entity_id}"`);
      }
      return { index, id: step.id, kind: step.kind, tool, args, ...checked, errors, valid:errors.length===0, mutates: true };
    }));
    return {
      valid: steps.every(step => step.valid), routineId, revision: selected.revision,
      requiresConfirmation: steps.some(step => 'requiresConfirmation' in step && step.requiresConfirmation),
      permissions: steps.filter(step => 'tool' in step).map(step => ({ tool: step.tool, requiredRole: step.requiredRole, requiresConfirmation: step.requiresConfirmation })),
      steps,
    };
  }

  async run(routineId: string, options: RunOptions = {}) {
    const active = await this.requireActive(routineId);
    const simulation = await this.simulate(routineId, options.role ?? 'admin');
    if (!simulation.valid) throw new RoutineError('routine_tool_validation_failed', 409, simulation.steps);
    if (options.idempotencyKey) {
      const prior = await this.repo.pool.query('SELECT id FROM routine_executions WHERE idempotency_key=$1', [options.idempotencyKey]);
      if (prior.rows[0]) return this.repo.execution(prior.rows[0].id);
    }
    const executionId = randomUUID();
    const status = simulation.requiresConfirmation && !options.confirmed ? 'awaiting_confirmation' : 'running';
    await this.repo.pool.query(`INSERT INTO routine_executions
      (id,routine_id,revision_id,correlation_id,idempotency_key,origin,origin_device_id,principal,status,inputs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [executionId,routineId,active.revision_id,randomUUID(),options.idempotencyKey ?? null,
      options.origin ?? 'admin',options.originDeviceId ?? null,options.principal ?? 'admin',status,JSON.stringify(options.inputs ?? {})]);
    if (status === 'awaiting_confirmation') return { ...(await this.repo.execution(executionId)), requiresConfirmation: true };
    return this.execute(executionId, active.definition, options, [routineId], 0);
  }

  async confirm(executionId: string, options: Pick<RunOptions, 'principal'|'role'> = {}) {
    const row = await this.repo.pool.query(`SELECT e.*,rr.definition FROM routine_executions e
      JOIN routine_revisions rr ON rr.id=e.revision_id WHERE e.id=$1`, [executionId]);
    if (!row.rows[0]) throw new RoutineError('routine_execution_not_found', 404);
    if (row.rows[0].status !== 'awaiting_confirmation') throw new RoutineError('routine_execution_not_awaiting_confirmation', 409);
    await this.repo.pool.query("UPDATE routine_executions SET status='running',principal=$2 WHERE id=$1", [executionId,options.principal ?? row.rows[0].principal]);
    return this.execute(executionId,row.rows[0].definition,{ inputs: row.rows[0].inputs, originDeviceId: row.rows[0].origin_device_id, principal: options.principal, role: options.role, confirmed: true },[row.rows[0].routine_id],0);
  }

  async cancel(executionId: string) {
    const result = await this.repo.pool.query(`UPDATE routine_executions SET cancel_requested_at=now(),
      status=CASE WHEN status IN ('running','awaiting_confirmation') THEN 'cancelled' ELSE status END,
      finished_at=CASE WHEN status IN ('running','awaiting_confirmation') THEN now() ELSE finished_at END
      WHERE id=$1 RETURNING *`, [executionId]);
    if (!result.rows[0]) throw new RoutineError('routine_execution_not_found',404);
    return result.rows[0];
  }

  async invokeVoice(transcript: string, deviceId?: string) {
    const normalized=normalizePhrase(transcript);
    const result=await this.repo.pool.query(`SELECT r.id,r.name,rr.definition FROM routines r
      JOIN routine_revisions rr ON rr.id=r.active_revision_id WHERE r.status='enabled'`);
    const matches=result.rows.filter(row=>{
      const definition=routineDefinitionSchema.safeParse(row.definition);
      return definition.success && definition.data.triggers.some(trigger=>trigger.type==='voice'
        && Array.isArray(trigger.phrases) && trigger.phrases.some(phrase=>typeof phrase==='string'&&normalizePhrase(phrase)===normalized));
    });
    if(matches.length===0)return{matched:false};
    if(matches.length>1)return{matched:false,ambiguous:matches.map(row=>String(row.name))};
    const row=matches[0];
    const fastStarted=Date.now();
    let execution:unknown;
    try{execution=await this.run(String(row.id),{origin:'voice',originDeviceId:deviceId,principal:'voice_user',role:'voice',idempotencyKey:`voice:${deviceId??'unknown'}:${normalized}:${Math.floor(Date.now()/2000)}`});}
    catch(error){if(error instanceof RoutineError&&error.message==='routine_tool_validation_failed'){console.warn(`[core][routines] fast path preflight failed routine=${row.id}; falling back to ordinary planning`);return{matched:false};}throw error;}
    const fastMs=Date.now()-fastStarted;
    const learned=await this.repo.pool.query("UPDATE routine_plan_learning SET fast_path_hits=fast_path_hits+1,last_fast_path_ms=$2 WHERE routine_id=$1 RETURNING signature",[row.id,fastMs]).catch(()=>({rowCount:0,rows:[]}));
    if(learned.rowCount)console.log(`[core][routines] learned fast path routine=${row.id} latency=${fastMs}ms`);
    const definition=routineDefinitionSchema.parse(row.definition);
    const status=(execution as {status?:string}|null)?.status;
    const configured=definition.result.speech??definition.result.message;
    const reply=status==='awaiting_confirmation'?'This routine requires confirmation in Canvas Core.':status==='successful'?(typeof configured==='string'?configured:`${row.name} completed.`):`${row.name} did not complete successfully.`;
    return{matched:true,reply,result:execution};
  }

  async primeHaStates() {
    const rows=await this.repo.pool.query('SELECT entity_id,state FROM ha_entities');
    for(const row of rows.rows)this.haLastStates.set(String(row.entity_id),String(row.state));
  }

  async invokeHaState(entityId:string,state:string) {
    const previous=this.haLastStates.get(entityId);this.haLastStates.set(entityId,state);
    if(previous===undefined||previous===state)return[];
    const rows=await this.enabledDefinitions();const executions=[];
    for(const row of rows){const definition=routineDefinitionSchema.safeParse(row.definition);if(!definition.success)continue;
      const matched=definition.data.triggers.some(trigger=>trigger.type==='ha_event'&&trigger.entityId===entityId
        && (trigger.from===undefined||String(trigger.from)===previous)&&(trigger.to===undefined||String(trigger.to)===state));
      if(matched)executions.push(await this.run(String(row.id),{origin:'ha_event',principal:'home_assistant',role:'admin',inputs:{entityId,from:previous,to:state},idempotencyKey:`ha:${row.id}:${entityId}:${previous}:${state}:${Date.now()}`}));
    }return executions;
  }

  async dispatchSchedules(now=new Date()) {
    const rows=await this.enabledDefinitions();const executions=[];
    for(const row of rows){const definition=routineDefinitionSchema.safeParse(row.definition);if(!definition.success)continue;
      for(const trigger of definition.data.triggers){if(trigger.type!=='schedule')continue;const timezone=typeof trigger.timezone==='string'?trigger.timezone:'UTC';
        const local=dateParts(now,timezone);const time=typeof trigger.time==='string'?trigger.time:'';const days=Array.isArray(trigger.days)?trigger.days.map(Number):[];
        if(time!==`${String(local.hour).padStart(2,'0')}:${String(local.minute).padStart(2,'0')}`||(days.length&& !days.includes(local.weekday)))continue;
        executions.push(await this.run(String(row.id),{origin:'schedule',principal:'scheduler',role:'admin',idempotencyKey:`schedule:${row.id}:${timezone}:${local.date}:${time}`}));
      }
    }return executions;
  }

  private async enabledDefinitions(){return(await this.repo.pool.query(`SELECT r.id,r.name,rr.definition FROM routines r JOIN routine_revisions rr ON rr.id=r.active_revision_id WHERE r.status='enabled'`)).rows;}

  private async requireActive(id: string) {
    const active = await this.repo.active(id);
    if (!active || active.status !== 'enabled') throw new RoutineError('routine_not_enabled',409);
    return active;
  }

  private async execute(executionId: string, rawDefinition: unknown, options: RunOptions, stack: string[], depth: number): Promise<unknown> {
    const definition = routineDefinitionSchema.parse(rawDefinition);
    const started = Date.now(); let finalResult: unknown = definition.result;
    try {
      for (const [index, step] of definition.steps.entries()) {
        const cancelled = await this.repo.pool.query('SELECT cancel_requested_at,status FROM routine_executions WHERE id=$1', [executionId]);
        if (cancelled.rows[0]?.cancel_requested_at || cancelled.rows[0]?.status === 'cancelled') throw new Error('routine_cancelled');
        if (Date.now() - started > definition.limits.timeoutMs) throw new Error('routine_timeout');
        const stepStarted = Date.now(); const stepRowId = randomUUID();
        await this.repo.pool.query(`INSERT INTO routine_step_results
          (id,execution_id,step_id,step_index,kind,tool_name,status,input) VALUES ($1,$2,$3,$4,$5,$6,'running',$7::jsonb)`,
          [stepRowId,executionId,step.id,index,step.kind,step.kind === 'tool' ? String(step.config.tool) : null,JSON.stringify(step.config)]);
        try {
          let output: unknown;
          if (step.kind === 'tool') {
            output = await withTimeout(this.tools.executeTool(String(step.config.tool),asArgs(step.config.args),{
              ...this.baseContext, principal: options.principal ?? 'admin', role: options.role ?? 'admin', deviceId: options.originDeviceId,
            }),step.timeoutMs ?? definition.limits.timeoutMs);
            if (!(output as {ok?:boolean}).ok) throw new Error((output as {message?:string}).message ?? 'tool_failed');
          } else if (step.kind === 'delay') {
            const ms = Math.max(0,Math.min(Number(step.config.ms ?? 0),step.timeoutMs ?? definition.limits.timeoutMs));
            await new Promise(resolve => setTimeout(resolve,ms)); output={ waitedMs: ms };
          } else if (step.kind === 'condition') {
            const passed = compare(step.config.left, String(step.config.operator ?? 'equals'), step.config.right);
            output={ passed }; if (!passed) throw new Error('condition_not_met');
          } else if (step.kind === 'routine') {
            const childId=String(step.config.routineId ?? '');
            if (!childId || stack.includes(childId)) throw new Error('routine_recursion_detected');
            if (depth + 1 >= definition.limits.maxRoutineDepth) throw new Error('routine_depth_exceeded');
            const child=await this.requireActive(childId); output=await this.executeNested(child.definition,options,[...stack,childId],depth+1);
          } else { output=step.config; finalResult=step.config; }
          await this.finishStep(stepRowId,'successful',output,null,stepStarted);
        } catch (error) {
          await this.finishStep(stepRowId,'failed',null,error instanceof Error ? error.message : String(error),stepStarted);
          if (step.onFailure !== 'continue') throw error;
        }
      }
      await this.repo.pool.query("UPDATE routine_executions SET status='successful',result=$2::jsonb,finished_at=now() WHERE id=$1",[executionId,JSON.stringify(finalResult)]);
    } catch(error) {
      const message=error instanceof Error ? error.message : String(error);
      const status=message === 'routine_cancelled' ? 'cancelled' : message.includes('timeout') ? 'unknown_outcome' : 'failed';
      await this.repo.pool.query('UPDATE routine_executions SET status=$2,error=$3,finished_at=now() WHERE id=$1',[executionId,status,message]);
    }
    return this.repo.execution(executionId);
  }

  private async executeNested(raw: unknown, options: RunOptions, stack: string[], depth: number) {
    const definition=routineDefinitionSchema.parse(raw); const outputs=[];
    for (const step of definition.steps) {
      if (step.kind !== 'tool') throw new Error('nested_routine_supports_tool_steps_only');
      const output=await this.tools.executeTool(String(step.config.tool),asArgs(step.config.args),{...this.baseContext,principal:options.principal ?? 'admin',role:options.role ?? 'admin',deviceId:options.originDeviceId});
      if (!output.ok) throw new Error(output.message); outputs.push(output);
    }
    return { stack, depth, outputs };
  }

  private async finishStep(id:string,status:string,output:unknown,error:string|null,started:number) {
    await this.repo.pool.query(`UPDATE routine_step_results SET status=$2,output=$3::jsonb,error=$4,
      finished_at=now(),duration_ms=$5 WHERE id=$1`,[id,status,output === undefined ? null : JSON.stringify(output),error,Date.now()-started]);
  }
}

function asArgs(value: unknown): Record<string,unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
function normalizePhrase(value:string):string{return value.toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();}
function dateParts(date:Date,timeZone:string){const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(date);const get=(type:string)=>parts.find(p=>p.type===type)?.value??'';const weekdays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];return{date:`${get('year')}-${get('month')}-${get('day')}`,hour:Number(get('hour')),minute:Number(get('minute')),weekday:weekdays.indexOf(get('weekday'))};}
function compare(left:unknown,operator:string,right:unknown):boolean {
  if (operator === 'equals') return left === right; if (operator === 'not_equals') return left !== right;
  if (operator === 'greater_than') return Number(left)>Number(right); if (operator === 'less_than') return Number(left)<Number(right);
  if (operator === 'contains') return String(left).includes(String(right)); return false;
}
async function withTimeout<T>(promise:Promise<T>,ms:number):Promise<T> { let timer:ReturnType<typeof setTimeout>|undefined; try { return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('step_timeout')),ms);})]); } finally { if(timer) clearTimeout(timer); } }

class RoutineError extends Error {
  constructor(message: string, readonly statusCode: number, readonly details?: unknown) { super(message); }
}

type RequireAdmin = (opts?: { roles?: ('admin' | 'viewer')[]; csrf?: boolean }) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export async function registerRoutineRoutes(fastify: FastifyInstance, pool: Pool, requireAdmin: RequireAdmin, tools?: ToolRegistry, toolContext: ToolContext = {}, planner?: RoutinePlanner): Promise<RoutineEngine | null> {
  const repo = new RoutineRepository(pool);
  const engine = tools ? new RoutineEngine(repo,tools,toolContext) : null;
  const handle = (reply: FastifyReply, error: unknown) => {
    if (error instanceof RoutineError) return reply.code(error.statusCode).send({ error: error.message, details: error.details });
    throw error;
  };
  fastify.get('/api/admin/routines', { preHandler: requireAdmin({ roles: ['admin','viewer'], csrf: false }) }, async () => ({ routines: await repo.list() }));
  if (tools && planner) {
    tools.register({ name:'routine.plan',description:'Create a read-only, validated routine plan and recommend Canvas Core or Home Assistant ownership.',schema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']},requiredRole:'admin',requiresConfirmation:false,executor:async params=>{try{return{ok:true,message:'Routine plan created.',data:await planner.plan(String(params.prompt))};}catch(error){return{ok:false,message:error instanceof Error?error.message:String(error)};}} });
    tools.register({ name:'routine.create_draft',description:'Create a disabled Canvas routine draft from a complete schema-valid routine definition. This never enables the routine.',schema:{type:'object',properties:{definition:{type:'object'}},required:['definition']},requiredRole:'admin',requiresConfirmation:true,executor:async params=>{try{const created=await repo.create(params.definition,'ai_prompt');return{ok:true,message:'Routine draft created and left disabled.',data:created};}catch(error){return{ok:false,message:error instanceof Error?error.message:String(error)};}} });
  }
  fastify.post('/api/admin/routines/plan', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request,reply) => {
    if(!planner)return reply.code(503).send({error:'routine_planner_unavailable'});
    const body=request.body as {prompt?:unknown;routineId?:unknown;resolutions?:unknown}|undefined;
    const prompt=body?.prompt;
    if(typeof prompt!=='string'||!prompt.trim())return reply.code(400).send({error:'routine_prompt_required'});
    try{let base:RoutineDefinition|undefined;if(typeof body?.routineId==='string'){const current=await repo.latest(body.routineId);if(!current)return reply.code(404).send({error:'routine_not_found'});base=routineDefinitionSchema.parse(current.definition);}const resolutions=body?.resolutions&&typeof body.resolutions==='object'&&!Array.isArray(body.resolutions)?body.resolutions as Record<string,string>:{};return{ok:true,plan:await planner.plan(prompt,base,resolutions)};}catch(error){return reply.code(502).send({error:'routine_planning_failed',message:error instanceof Error?error.message:String(error)});}
  });
  fastify.post('/api/admin/routines/create-draft', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request,reply) => {
    const body=request.body as {definition?:unknown;routineId?:unknown}|undefined;
    const definition=body?.definition;
    const checked=validateRoutineDefinition(definition);
    if(!checked.valid)return reply.code(400).send({error:'routine_invalid',details:checked.errors});
    if(checked.definition.owner==='home_assistant'||checked.definition.owner==='hybrid')return reply.code(409).send({error:'ha_automation_draft_unsupported',message:'Core will not write Home Assistant automation YAML because this connection does not expose a supported safe editable-draft API.'});
    try{if(typeof body?.routineId==='string')return{ok:true,revision:await repo.revise(body.routineId,checked.definition,'ai_prompt'),routine:{id:body.routineId}};return{ok:true,routine:await repo.create(checked.definition,'ai_prompt')};}catch(error){return handle(reply,error);}
  });
  fastify.get('/api/admin/routines/:id', { preHandler: requireAdmin({ roles: ['admin','viewer'], csrf: false }) }, async (request, reply) => {
    const value = await repo.get((request.params as {id:string}).id); return value ? { routine: value } : reply.code(404).send({ error: 'routine_not_found' });
  });
  fastify.post('/api/admin/routines/validate', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async request => validateRoutineDefinition((request.body as {definition?:unknown})?.definition));
  fastify.post('/api/admin/routines', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    try { return { ok: true, routine: await repo.create((request.body as {definition?:unknown})?.definition, (request.body as {source?:string})?.source) }; } catch (e) { return handle(reply,e); }
  });
  fastify.post('/api/admin/routines/:id/revisions', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    try { return { ok: true, revision: await repo.revise((request.params as {id:string}).id,(request.body as {definition?:unknown})?.definition,(request.body as {source?:string})?.source) }; } catch(e) { return handle(reply,e); }
  });
  fastify.post('/api/admin/routines/:id/enable', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    try { return { ok: true, routine: await repo.enable((request.params as {id:string}).id,(request.body as {revision?:number})?.revision) }; } catch(e) { return handle(reply,e); }
  });
  for (const action of ['disable','archive'] as const) fastify.post(`/api/admin/routines/:id/${action}`, { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    try { return { ok: true, routine: await repo.setStatus((request.params as {id:string}).id,action === 'disable' ? 'disabled' : 'archived') }; } catch(e) { return handle(reply,e); }
  });
  fastify.post('/api/admin/routines/:id/simulate', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    if (!engine) return reply.code(503).send({ error: 'routine_engine_unavailable' });
    try { return { ok: true, simulation: await engine.simulate((request.params as {id:string}).id) }; } catch(e) { return handle(reply,e); }
  });
  fastify.post('/api/admin/routines/:id/run', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    if (!engine) return reply.code(503).send({ error: 'routine_engine_unavailable' });
    const body=(request.body ?? {}) as RunOptions;
    try { return { ok: true, execution: await engine.run((request.params as {id:string}).id,{...body,principal:'admin',role:'admin'}) }; } catch(e) { return handle(reply,e); }
  });
  fastify.post('/api/admin/routine-executions/:id/confirm', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    if (!engine) return reply.code(503).send({ error: 'routine_engine_unavailable' });
    try { return { ok: true, execution: await engine.confirm((request.params as {id:string}).id,{principal:'admin',role:'admin'}) }; } catch(e) { return handle(reply,e); }
  });
  fastify.post('/api/admin/routine-executions/:id/cancel', { preHandler: requireAdmin({ roles: ['admin'], csrf: true }) }, async (request, reply) => {
    if (!engine) return reply.code(503).send({ error: 'routine_engine_unavailable' });
    try { return { ok: true, execution: await engine.cancel((request.params as {id:string}).id) }; } catch(e) { return handle(reply,e); }
  });
  fastify.get('/api/admin/routines/:id/executions', { preHandler: requireAdmin({ roles: ['admin','viewer'], csrf: false }) }, async request => ({ executions: await repo.executions((request.params as {id:string}).id) }));
  fastify.get('/api/admin/routine-executions/:id', { preHandler: requireAdmin({ roles: ['admin','viewer'], csrf: false }) }, async (request,reply) => {
    const execution=await repo.execution((request.params as {id:string}).id); return execution ? {execution} : reply.code(404).send({error:'routine_execution_not_found'});
  });
  fastify.post('/api/routines/:id/trigger', { preHandler: requireAdmin({ roles: ['admin'] }) }, async (request,reply) => {
    if(!engine)return reply.code(503).send({error:'routine_engine_unavailable'});
    const body=(request.body??{}) as {originDeviceId?:string;actionId?:string};
    try{return{ok:true,execution:await engine.run((request.params as {id:string}).id,{origin:'canvas_button',originDeviceId:body.originDeviceId,principal:'admin',role:'admin',idempotencyKey:body.actionId})};}catch(e){return handle(reply,e);}
  });
  fastify.post('/api/admin/routines/:id/webhook', { preHandler: requireAdmin({ roles: ['admin'] }) }, async (request,reply) => {
    if(!engine)return reply.code(503).send({error:'routine_engine_unavailable'});
    const body=(request.body??{}) as {inputs?:Record<string,unknown>;actionId?:string;originDeviceId?:string};
    try{return{ok:true,execution:await engine.run((request.params as {id:string}).id,{...body,origin:'webhook',principal:'automation',role:'admin',idempotencyKey:body.actionId})};}catch(e){return handle(reply,e);}
  });
  return engine;
}
