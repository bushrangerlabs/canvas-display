import type { Pool } from 'pg';
import type { LlmProvider } from './providers/llm.js';
import type { ToolRegistry } from './tool-registry.js';
import { routineDefinitionSchema, validateRoutineDefinition, type RoutineDefinition } from './routines.js';

export interface RoutinePlan {
  prompt: string;
  definition: RoutineDefinition | null;
  owner: RoutineDefinition['owner'];
  reasons: string[];
  unresolved: string[];
  ambiguous: Array<{ value: string; candidates: string[] }>;
  permissions: string[];
  risk: 'low' | 'medium' | 'elevated';
  validation: ReturnType<typeof validateRoutineDefinition>;
  expectedBehavior: string;
  haDraft: { supported: false; reason: string } | null;
  changes: Array<{ path: string; before?: unknown; after?: unknown }>;
}

export class RoutinePlanner {
  constructor(private readonly pool: Pool, private readonly tools: ToolRegistry, private readonly llm: LlmProvider) {}

  async plan(prompt: string, baseDefinition?: RoutineDefinition, resolutions: Record<string,string> = {}): Promise<RoutinePlan> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error('routine_prompt_required');
    const entities = await this.entityCandidates(trimmed);
    const availableTools = this.tools.listTools('admin').filter(tool => !tool.name.startsWith('mcp.')).map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.schema,
    }));
    const raw = await this.llm.chat([
      { role: 'system', content: `Create a neutral Canvas routine draft from the request. Return one JSON object only, with no markdown. It must match this shape: {schemaVersion:1,name:string,description:string,owner:"canvas_core"|"home_assistant"|"hybrid"|"clarification_required",triggers:[{type:string,...}],inputs:{},steps:[{id:string,kind:"tool"|"condition"|"delay"|"routine"|"result",config:{...},onFailure?:"stop"|"continue"}],result:{speech?:string,message?:string},limits:{timeoutMs:number,maxSteps:number,maxRoutineDepth:number}}. Use only listed tool names and exact entity IDs. Never invent an entity ID. If existingDefinition is supplied, edit it narrowly according to the request, preserving unrelated behavior and stable step IDs. If a required target is missing or ambiguous, use owner clarification_required and no executable steps. Prefer home_assistant when all triggers and actions are HA-native and must run without Canvas. Prefer canvas_core for Canvas display/media/device actions. Use hybrid only when both are essential. The output is a disabled draft and must never imply it is enabled.` },
      { role: 'user', content: JSON.stringify({ request: trimmed, existingDefinition: baseDefinition, confirmedEntityResolutions: resolutions, availableTools, entityCandidates: entities }) },
    ]);
    const candidate = applyEntityResolutions(extractJson(raw), resolutions);
    const checked = validateRoutineDefinition(candidate);
    const definition = checked.valid ? checked.definition : null;
    const resolution = definition ? await this.resolveEntities(definition) : { unresolved: [], ambiguous: [] };
    const owner = definition ? classifyOwner(definition) : 'clarification_required';
    const normalizedDefinition = definition ? { ...definition, owner } : null;
    const permissions = normalizedDefinition?.steps.filter(step => step.kind === 'tool').map(step => String(step.config.tool)).filter((value,index,all)=>all.indexOf(value)===index) ?? [];
    const confirmation = permissions.some(name => this.tools.requiresConfirmation(name));
    const risk = confirmation || permissions.some(name => /lock|alarm|garage|delete|shell|script/i.test(name)) ? 'elevated' : permissions.length > 2 ? 'medium' : 'low';
    const reasons = ownerReasons(owner, normalizedDefinition);
    if (resolution.unresolved.length || resolution.ambiguous.length) reasons.push('One or more Home Assistant targets require clarification.');
    const finalOwner = resolution.unresolved.length || resolution.ambiguous.length ? 'clarification_required' : owner;
    const finalDefinition = normalizedDefinition ? {
      ...normalizedDefinition,
      owner: finalOwner,
      steps: finalOwner === 'clarification_required' ? [] : normalizedDefinition.steps,
    } : null;
    return {
      prompt: trimmed, definition: finalDefinition, owner: finalOwner, reasons,
      unresolved: resolution.unresolved, ambiguous: resolution.ambiguous, permissions, risk,
      validation: finalDefinition ? validateRoutineDefinition(finalDefinition) : checked,
      expectedBehavior: describe(finalDefinition),
      haDraft: finalOwner === 'home_assistant' || finalOwner === 'hybrid'
        ? { supported: false, reason: 'This Home Assistant connection does not expose a supported API for creating safe, editable automation drafts. The plan can be reviewed, but Core will not write directly to HA configuration.' }
        : null,
      changes: baseDefinition && finalDefinition ? diffDefinitions(baseDefinition, finalDefinition) : [],
    };
  }

  private async entityCandidates(prompt: string) {
    const rows = await this.pool.query('SELECT entity_id,friendly_name,domain,state FROM ha_entities');
    const terms = normalize(prompt).split(' ').filter(term => term.length > 2);
    return rows.rows.map(row => {
      const text = normalize(`${row.entity_id} ${row.friendly_name ?? ''}`);
      return { ...row, score: terms.reduce((score,term)=>score+(text.includes(term)?1:0),0) };
    }).filter(row => row.score > 0).sort((a,b)=>b.score-a.score).slice(0,40).map(({score:_,...row})=>row);
  }

  private async resolveEntities(definition: RoutineDefinition) {
    const ids = definition.steps.filter(step=>step.kind==='tool').map(step=>step.config.args).filter(value=>value&&typeof value==='object').map(value=>(value as Record<string,unknown>).entity_id).filter((value):value is string=>typeof value==='string');
    const unresolved:string[]=[];const ambiguous:Array<{value:string;candidates:string[]}>=[];
    for (const id of ids) {
      const exact=await this.pool.query('SELECT entity_id FROM ha_entities WHERE entity_id=$1',[id]);
      if(exact.rowCount)continue;
      const nearby=await this.pool.query('SELECT entity_id FROM ha_entities WHERE LOWER(COALESCE(friendly_name,\'\'))=LOWER($1) OR LOWER(entity_id)=LOWER($1) LIMIT 6',[id]);
      if(nearby.rowCount===1) ambiguous.push({value:id,candidates:[String(nearby.rows[0].entity_id)]});
      else if((nearby.rowCount??0)>1) ambiguous.push({value:id,candidates:nearby.rows.map(row=>String(row.entity_id))});
      else unresolved.push(id);
    }
    return { unresolved, ambiguous };
  }
}

function extractJson(raw:string):unknown { const text=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');const start=text.indexOf('{');const end=text.lastIndexOf('}');if(start<0||end<start)throw new Error('routine_planner_returned_no_json');return JSON.parse(text.slice(start,end+1)); }
function normalize(value:string){return value.toLowerCase().replace(/[^a-z0-9.]+/g,' ').trim();}
function classifyOwner(definition:RoutineDefinition):RoutineDefinition['owner'] { if(definition.owner==='clarification_required')return definition.owner;const tools=definition.steps.filter(step=>step.kind==='tool').map(step=>String(step.config.tool));const canvas=tools.some(tool=>/^(media|navigate|scene|brightness|query)\./.test(tool));const ha=tools.some(tool=>tool.startsWith('ha.'));if(canvas&&ha)return'hybrid';if(canvas)return'canvas_core';if(ha&&definition.triggers.every(trigger=>['manual','voice','schedule','ha_event'].includes(trigger.type)))return'home_assistant';return definition.owner; }
function ownerReasons(owner:RoutineDefinition['owner'],definition:RoutineDefinition|null){if(!definition)return['The proposed plan did not pass the routine schema.'];if(owner==='home_assistant')return['All proposed actions target Home Assistant and can remain useful when Canvas Core is offline.'];if(owner==='hybrid')return['The request combines Home Assistant actions with Canvas display, media, or device behavior.'];if(owner==='clarification_required')return['The request cannot be executed safely until its targets or behavior are clarified.'];return['The request depends on Canvas display, media, device, or orchestration capabilities.'];}
function describe(definition:RoutineDefinition|null){if(!definition)return'The prompt did not produce a valid executable draft.';const trigger=definition.triggers.map(value=>value.type).join(', ')||'manual';const actions=definition.steps.filter(step=>step.kind==='tool').map(step=>String(step.config.tool));return `When triggered by ${trigger}, run ${actions.length?actions.join(', '):'no actions'}. The draft remains disabled until explicitly enabled.`;}
function diffDefinitions(before:RoutineDefinition,after:RoutineDefinition){const changes:Array<{path:string;before?:unknown;after?:unknown}>=[];for(const key of ['name','description','owner','triggers','steps','result','limits'] as const){if(JSON.stringify(before[key])!==JSON.stringify(after[key]))changes.push({path:key,before:before[key],after:after[key]});}return changes;}
function applyEntityResolutions(value:unknown,resolutions:Record<string,string>):unknown { if(Array.isArray(value))return value.map(item=>applyEntityResolutions(item,resolutions));if(value&&typeof value==='object'){const output:Record<string,unknown>={};for(const [key,item] of Object.entries(value as Record<string,unknown>))output[key]=key==='entity_id'&&typeof item==='string'&&resolutions[item]?resolutions[item]:applyEntityResolutions(item,resolutions);return output;}return value; }
