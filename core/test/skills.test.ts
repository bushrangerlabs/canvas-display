import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { SkillService, skillDefinitionSchema } from '../src/skills.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function service() {
  const db=newDb();const adapter=db.adapters.createPg();const pool=new adapter.Pool() as unknown as Pool;
  await pool.query(`CREATE TABLE skills(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT,status TEXT NOT NULL DEFAULT 'draft',active_revision_id TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
  CREATE TABLE skill_revisions(id TEXT PRIMARY KEY,skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,revision INTEGER NOT NULL,definition JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'draft',creation_source TEXT NOT NULL DEFAULT 'user',validation_errors JSONB DEFAULT '[]'::jsonb,created_at TIMESTAMPTZ DEFAULT now(),enabled_at TIMESTAMPTZ,UNIQUE(skill_id,revision));
  CREATE TABLE routines(id TEXT PRIMARY KEY,name TEXT,description TEXT,status TEXT);`);
  const tools=new ToolRegistry();tools.register({name:'query.status',description:'status',schema:{type:'object'},requiredRole:'voice',requiresConfirmation:false,executor:async()=>({ok:true,message:'ok'})});
  const llm={name:'test',chat:async()=> 'A concise astronomy answer.',chatWithTools:async()=>({content:'',toolCalls:[]}),healthCheck:async()=>({name:'test',healthy:true})};
  return new SkillService(pool,tools,llm,()=>null);
}
const definition=()=>({schemaVersion:1 as const,name:'Astronomy helper',description:'Explains astronomy',instructions:'Explain astronomy accurately.',invocation:{phrases:['explain the stars'],keywords:['astronomy','explain'],examples:['Explain a black hole']},allowedTools:[],routineId:null,responseStyle:'Short'});

test('Canvas Skill v1 validates structured non-code definitions',()=>{assert.equal(skillDefinitionSchema.safeParse(definition()).success,true);assert.equal(skillDefinitionSchema.safeParse({...definition(),instructions:''}).success,false);});
test('AI/user skills remain drafts until separately enabled and use immutable revisions',async()=>{const svc=await service();const created=await svc.create(definition(),'ai_prompt');assert.equal(created.status,'draft');assert.equal((await svc.invokeVoice('explain the stars')).matched,false);await svc.revise(created.id,{...definition(),description:'Updated'});await svc.enable(created.id);const detail=await svc.get(created.id);assert.equal(detail?.status,'enabled');assert.equal(detail?.revisions.length,2);});
test('enabled prompt skill matches voice and returns its constrained answer',async()=>{const svc=await service();const created=await svc.create(definition());await svc.enable(created.id);const result=await svc.invokeVoice('Explain the stars');assert.equal(result.matched,true);assert.equal(result.reply,'A concise astronomy answer.');});
test('unknown allowed tools are rejected independently of AI output',async()=>{const svc=await service();await assert.rejects(()=>svc.create({...definition(),allowedTools:['shell.exec']}),/skill_invalid/);});
test('Core exposes AI planning and guarded disabled-draft creation tools',async()=>{const svc=await service();svc.registerTools();const registry=(svc as unknown as {tools:ToolRegistry}).tools;assert.ok(registry.getTool('skill.plan'));assert.equal(registry.requiresConfirmation('skill.create_draft'),true);assert.equal(registry.getTool('skill.enable'),undefined);});
