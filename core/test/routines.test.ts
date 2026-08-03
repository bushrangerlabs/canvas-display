import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { RoutineEngine, RoutineRepository, validateRoutineDefinition } from '../src/routines.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { RoutinePlanner } from '../src/routine-planner.js';
import type { LlmProvider } from '../src/providers/llm.js';
import { RoutineLearningService } from '../src/routine-learning.js';
import type { Pool } from 'pg';

const validDefinition = () => ({
  schemaVersion: 1 as const,
  name: 'Movie night',
  description: 'Prepare the lounge',
  owner: 'canvas_core' as const,
  triggers: [{ type: 'voice', phrases: ['movie night'] }],
  inputs: {},
  steps: [{ id: 'lights', kind: 'tool', config: { tool: 'ha.entity.set', args: { entity_id: 'light.lounge' } } }],
  result: { speech: 'Movie night is ready' },
  limits: { timeoutMs: 30_000, maxSteps: 20, maxRoutineDepth: 3 },
});

async function repository(): Promise<RoutineRepository> {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  await pool.query(`CREATE TABLE routines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, owner TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', active_revision_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE routine_revisions (
    id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, definition JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    creation_source TEXT NOT NULL DEFAULT 'user', provider_provenance JSONB,
    validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled_at TIMESTAMPTZ, UNIQUE(routine_id,revision));
    CREATE TABLE routine_executions (
      id TEXT PRIMARY KEY,routine_id TEXT NOT NULL,revision_id TEXT NOT NULL,correlation_id TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,origin TEXT NOT NULL,origin_device_id TEXT,principal TEXT NOT NULL,status TEXT NOT NULL,
      dry_run BOOLEAN DEFAULT false,inputs JSONB DEFAULT '{}'::jsonb,result JSONB,error TEXT,started_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,cancel_requested_at TIMESTAMPTZ);
    CREATE TABLE routine_step_results (
      id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,step_id TEXT NOT NULL,step_index INTEGER NOT NULL,kind TEXT NOT NULL,
      tool_name TEXT,status TEXT NOT NULL,input JSONB,output JSONB,error TEXT,started_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,duration_ms INTEGER,UNIQUE(execution_id,step_index));
    CREATE TABLE ha_entities (entity_id TEXT PRIMARY KEY,friendly_name TEXT,domain TEXT,state TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE routine_plan_learning (signature TEXT PRIMARY KEY,normalized_phrase TEXT NOT NULL,plan JSONB NOT NULL,success_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'observed',routine_id TEXT,fast_path_hits INTEGER NOT NULL DEFAULT 0,last_fast_path_ms INTEGER,origin_devices JSONB NOT NULL DEFAULT '[]'::jsonb,first_seen_at TIMESTAMPTZ DEFAULT now(),last_seen_at TIMESTAMPTZ DEFAULT now());`);
  return new RoutineRepository(pool);
}

test('routine validation accepts a typed deterministic plan', () => {
  assert.equal(validateRoutineDefinition(validDefinition()).valid, true);
});

test('routine engine simulates and executes typed tools with durable step history', async () => {
  const repo = await repository(); const registry = new ToolRegistry(); let calls = 0;
  registry.register({ name: 'test.action', description: 'test', schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    requiredRole: 'admin', requiresConfirmation: false, executor: async params => { calls++; return { ok: true, message: String(params.value) }; } });
  const definition = validDefinition(); definition.steps = [{ id: 'action', kind: 'tool', config: { tool: 'test.action', args: { value: 'done' } } }];
  const created = await repo.create(definition); await repo.enable(created.id);
  const engine = new RoutineEngine(repo,registry,{});
  const simulation = await engine.simulate(created.id);
  assert.equal(simulation.valid,true); assert.equal(calls,0);
  const execution = await engine.run(created.id,{idempotencyKey:'once'} as never) as {status:string;steps:unknown[]};
  assert.equal(execution.status,'successful'); assert.equal(execution.steps.length,1); assert.equal(calls,1);
  await engine.run(created.id,{idempotencyKey:'once'} as never); assert.equal(calls,1);
});

test('routine engine pauses confirmation-required tools until confirmed', async () => {
  const repo = await repository(); const registry = new ToolRegistry(); let calls=0;
  registry.register({ name:'test.danger',description:'danger',schema:{type:'object',properties:{}},requiredRole:'admin',requiresConfirmation:true,
    executor:async()=>{calls++;return{ok:true,message:'ok'};} });
  const definition=validDefinition(); definition.steps=[{id:'danger',kind:'tool',config:{tool:'test.danger',args:{}}}];
  const created=await repo.create(definition); await repo.enable(created.id); const engine=new RoutineEngine(repo,registry,{});
  const pending=await engine.run(created.id) as {id:string;status:string};
  assert.equal(pending.status,'awaiting_confirmation'); assert.equal(calls,0);
  const completed=await engine.confirm(pending.id) as {status:string}; assert.equal(completed.status,'successful'); assert.equal(calls,1);
});

test('voice trigger matches normalized exact phrase and executes once', async () => {
  const repo=await repository();const registry=new ToolRegistry();let calls=0;
  registry.register({name:'test.voice',description:'voice',schema:{type:'object',properties:{}},requiredRole:'voice',requiresConfirmation:false,executor:async()=>{calls++;return{ok:true,message:'ok'};}});
  const definition=validDefinition();definition.triggers=[{type:'voice',phrases:['Movie Night!']}];definition.steps=[{id:'voice',kind:'tool',config:{tool:'test.voice',args:{}}}];definition.result={speech:'Enjoy the movie.'};
  const created=await repo.create(definition);await repo.enable(created.id);const engine=new RoutineEngine(repo,registry,{});
  const result=await engine.invokeVoice('  movie night  ','pi-1');
  assert.equal(result.matched,true);assert.equal(result.reply,'Enjoy the movie.');assert.equal(calls,1);
  assert.equal((await engine.invokeVoice('movie tomorrow')).matched,false);
});

test('voice trigger refuses ambiguous enabled routine phrases', async () => {
  const repo=await repository();const registry=new ToolRegistry();
  for(const name of ['First','Second']){const definition=validDefinition();definition.name=name;definition.triggers=[{type:'voice',phrases:['same phrase']}];definition.steps=[];const created=await repo.create(definition);await repo.enable(created.id);}
  const result=await new RoutineEngine(repo,registry,{}).invokeVoice('same phrase');
  assert.equal(result.matched,false);assert.deepEqual(result.ambiguous?.sort(),['First','Second']);
});

test('schedule trigger uses local weekday and executes only once per scheduled minute', async () => {
  const repo=await repository();const registry=new ToolRegistry();let calls=0;
  registry.register({name:'test.schedule',description:'schedule',schema:{type:'object',properties:{}},requiredRole:'admin',requiresConfirmation:false,executor:async()=>{calls++;return{ok:true,message:'ok'};}});
  const definition=validDefinition();definition.triggers=[{type:'schedule',time:'10:30',timezone:'Australia/Melbourne',days:[0]}];definition.steps=[{id:'schedule',kind:'tool',config:{tool:'test.schedule',args:{}}}];
  const created=await repo.create(definition);await repo.enable(created.id);const engine=new RoutineEngine(repo,registry,{});
  const instant=new Date('2026-08-02T00:30:15.000Z');
  await engine.dispatchSchedules(instant);await engine.dispatchSchedules(new Date('2026-08-02T00:30:45.000Z'));
  assert.equal(calls,1);
});

test('Home Assistant trigger ignores startup and duplicate states, then runs on a matching transition', async () => {
  const repo=await repository();const registry=new ToolRegistry();let calls=0;
  registry.register({name:'test.ha',description:'HA event',schema:{type:'object',properties:{}},requiredRole:'admin',requiresConfirmation:false,executor:async()=>{calls++;return{ok:true,message:'ok'};}});
  const definition=validDefinition();definition.triggers=[{type:'ha_event',entityId:'binary_sensor.door',from:'off',to:'on'}];definition.steps=[{id:'ha',kind:'tool',config:{tool:'test.ha',args:{}}}];
  const created=await repo.create(definition);await repo.enable(created.id);const engine=new RoutineEngine(repo,registry,{});
  await engine.invokeHaState('binary_sensor.door','off');
  await engine.invokeHaState('binary_sensor.door','on');
  await engine.invokeHaState('binary_sensor.door','on');
  assert.equal(calls,1);
});

test('AI routine planner validates targets and independently selects Home Assistant ownership', async () => {
  const repo=await repository();
  await repo.pool.query("INSERT INTO ha_entities(entity_id,friendly_name,domain,state) VALUES ('light.lounge','Lounge light','light','on')");
  const proposed={...validDefinition(),owner:'canvas_core' as const,triggers:[{type:'schedule',time:'23:00',timezone:'Australia/Melbourne'}],steps:[{id:'off',kind:'tool',config:{tool:'ha.toggle',args:{entity_id:'light.lounge',state:'off'}}}]};
  const llm={chat:async()=>JSON.stringify(proposed)} as unknown as LlmProvider;
  const plan=await new RoutinePlanner(repo.pool,new ToolRegistry(),llm).plan('Turn off the lounge light at 11 PM');
  assert.equal(plan.validation.valid,true);assert.equal(plan.owner,'home_assistant');assert.deepEqual(plan.unresolved,[]);assert.match(plan.expectedBehavior,/disabled/);
  assert.equal(plan.haDraft?.supported,false);
});

test('AI routine planner refuses an invented Home Assistant target', async () => {
  const repo=await repository();
  const proposed={...validDefinition(),steps:[{id:'off',kind:'tool',config:{tool:'ha.toggle',args:{entity_id:'light.invented',state:'off'}}}]};
  const llm={chat:async()=>JSON.stringify(proposed)} as unknown as LlmProvider;
  const plan=await new RoutinePlanner(repo.pool,new ToolRegistry(),llm).plan('Turn off my invented light');
  assert.equal(plan.owner,'clarification_required');assert.deepEqual(plan.unresolved,['light.invented']);assert.equal(plan.definition?.steps.length,0);
});

test('AI routine planner applies an explicit user entity clarification', async () => {
  const repo=await repository();await repo.pool.query("INSERT INTO ha_entities(entity_id,friendly_name,domain,state) VALUES ('light.real','Real light','light','off')");
  const proposed={...validDefinition(),steps:[{id:'on',kind:'tool',config:{tool:'ha.toggle',args:{entity_id:'the light',state:'on'}}}]};
  const llm={chat:async()=>JSON.stringify(proposed)} as unknown as LlmProvider;
  const plan=await new RoutinePlanner(repo.pool,new ToolRegistry(),llm).plan('Turn on the light',undefined,{'the light':'light.real'});
  assert.equal(plan.unresolved.length,0);assert.equal(plan.owner,'home_assistant');
  assert.equal((plan.definition?.steps[0].config.args as Record<string,unknown>).entity_id,'light.real');
});

test('AI routine planner reports narrow changes against an existing definition', async () => {
  const repo=await repository();await repo.pool.query("INSERT INTO ha_entities(entity_id,friendly_name,domain,state) VALUES ('light.lounge','Lounge light','light','on')");const before=validDefinition();before.owner='home_assistant';const after=structuredClone(before);after.description='Updated description';
  const llm={chat:async()=>JSON.stringify(after)} as unknown as LlmProvider;
  const plan=await new RoutinePlanner(repo.pool,new ToolRegistry(),llm).plan('Update the description',before);
  assert.deepEqual(plan.changes.map(change=>change.path),['description']);
});

test('repeated successful safe plans become suggestions after three uses and redact secrets', async () => {
  const repo=await repository();const learning=new RoutineLearningService(repo.pool);const calls=[{tool:'media.pause',args:{source:'youtube',token:'never-store'}}];
  await learning.record('Pause the video!',calls,'pi-1');await learning.record('pause the video',calls,'pi-1');const third=await learning.record('PAUSE the video',calls,'pi-1');
  assert.equal(third.status,'suggested');assert.equal(third.success_count,3);assert.equal(third.plan[0].args.token,undefined);
});

test('automatic learning creates a disabled Canvas draft but excludes elevated actions', async () => {
  const repo=await repository();const learning=new RoutineLearningService(repo.pool);await learning.setMode('automatic_drafts');const calls=[{tool:'media.pause',args:{source:'youtube'}}];
  await learning.record('pause playback',calls);await learning.record('pause playback',calls);const third=await learning.record('pause playback',calls);
  assert.equal(third.status,'drafted');assert.ok(third.routine_id);assert.equal((await repo.get(third.routine_id))?.status,'draft');
  assert.equal(await learning.record('unlock door',[{tool:'ha.lock',args:{entity_id:'lock.front'}}]),null);
});

test('a suggested learned Canvas plan can be compiled to a disabled draft', async () => {
  const repo=await repository();const learning=new RoutineLearningService(repo.pool);const calls=[{tool:'test.learned',args:{}}];
  await learning.record('pause it',calls);await learning.record('pause it',calls);const suggested=await learning.record('pause it',calls);const compiled=await learning.compile(suggested.signature);
  assert.equal(compiled.status,'drafted');assert.equal((await repo.get(compiled.routine_id))?.status,'draft');
  const registry=new ToolRegistry();registry.register({name:'test.learned',description:'learned',schema:{type:'object',properties:{}},requiredRole:'voice',requiresConfirmation:false,executor:async()=>({ok:true,message:'fast'})});await repo.enable(compiled.routine_id);const result=await new RoutineEngine(repo,registry,{}).invokeVoice('pause it','pi-1');assert.equal(result.matched,true);const tracked=(await learning.list()).find(row=>row.signature===suggested.signature);assert.equal(tracked.fast_path_hits,1);assert.equal(typeof tracked.last_fast_path_ms,'number');
});

test('routine simulation rejects a missing cached Home Assistant target', async () => {
  const repo=await repository();const registry=new ToolRegistry();const definition=validDefinition();definition.steps=[{id:'missing',kind:'tool',config:{tool:'ha.toggle',args:{entity_id:'light.missing',state:'off'}}}];const created=await repo.create(definition);
  const simulation=await new RoutineEngine(repo,registry,{}).simulate(created.id);
  assert.equal(simulation.valid,false);assert.match(JSON.stringify(simulation.steps),/entity_not_found/);
  await repo.enable(created.id);assert.equal((await new RoutineEngine(repo,registry,{}).invokeVoice('movie night')).matched,false);
});

test('routine validation rejects duplicate step IDs and excess maxSteps', () => {
  const definition = validDefinition();
  definition.limits.maxSteps = 1;
  definition.steps.push({ ...definition.steps[0] });
  const result = validateRoutineDefinition(definition);
  assert.equal(result.valid, false);
  assert.match(JSON.stringify(result.errors), /unique|exceed/);
});

test('clarification-required routine cannot contain executable steps', () => {
  const definition = { ...validDefinition(), owner: 'clarification_required' as const };
  assert.equal(validateRoutineDefinition(definition).valid, false);
});

test('routine lifecycle preserves immutable revisions and can activate an older revision', async () => {
  const repo = await repository();
  const created = await repo.create(validDefinition(), 'user');
  assert.equal(created.revision.revision, 1);
  const revised = validDefinition(); revised.name = 'Updated movie night';
  const second = await repo.revise(created.id, revised, 'ai_prompt');
  assert.equal(second.revision, 2);
  const enabled = await repo.enable(created.id, 1);
  assert.equal(enabled.status, 'enabled');
  assert.equal(enabled.active_revision, 1);
  const stored = await repo.get(created.id);
  assert.equal(stored?.revisions.length, 2);
  assert.equal(stored?.revisions[0].definition.name, 'Updated movie night');
  await repo.setStatus(created.id, 'disabled');
  assert.equal((await repo.get(created.id))?.status, 'disabled');
});

test('failed routine revision can be disabled and rolled back without losing execution history', async () => {
  const repo = await repository();
  const registry = new ToolRegistry();
  let successfulCalls = 0;
  registry.register({
    name: 'test.rollback.good', description: 'known-good action', schema: { type: 'object', properties: {} },
    requiredRole: 'admin', requiresConfirmation: false,
    executor: async () => { successfulCalls++; return { ok: true, message: 'known good' }; },
  });
  registry.register({
    name: 'test.rollback.bad', description: 'failing action', schema: { type: 'object', properties: {} },
    requiredRole: 'admin', requiresConfirmation: false,
    executor: async () => { throw new Error('synthetic revision failure'); },
  });

  const good = validDefinition();
  good.steps = [{ id: 'known_good', kind: 'tool', config: { tool: 'test.rollback.good', args: {} } }];
  const created = await repo.create(good, 'acceptance_fixture');
  await repo.enable(created.id, 1);
  const engine = new RoutineEngine(repo, registry, {});
  assert.equal((await engine.run(created.id, { idempotencyKey: 'rollback-before' } as never) as {status:string}).status, 'successful');

  const bad = structuredClone(good);
  bad.name = 'Broken revision';
  bad.steps = [{ id: 'broken', kind: 'tool', config: { tool: 'test.rollback.bad', args: {} } }];
  await repo.revise(created.id, bad, 'acceptance_fixture');
  await repo.enable(created.id, 2);
  const failed = await engine.run(created.id, { idempotencyKey: 'rollback-failure' } as never) as {status:string;error:string};
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /synthetic revision failure/);

  await repo.setStatus(created.id, 'disabled');
  const rolledBack = await repo.enable(created.id, 1);
  assert.equal(rolledBack.active_revision, 1);
  assert.equal((await engine.run(created.id, { idempotencyKey: 'rollback-after' } as never) as {status:string}).status, 'successful');

  const history = await repo.executions(created.id);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map(row => row.status).sort(), ['failed', 'successful', 'successful']);
  assert.equal(successfulCalls, 2);
  const stored = await repo.get(created.id);
  assert.equal(stored?.revisions.length, 2);
  assert.equal(stored?.active_revision_id, created.revision.id);
});
