import type { HomeAssistantClient } from './providers/ha.js';
import { controlEntity } from './facade.js';

export interface HaEntityCandidate {
  entityId: string;
  friendlyName?: string;
  domain: string;
  state: string;
  deviceName?: string;
  areaName?: string;
  aliases?: string[];
}

export interface DirectHaResult {
  handled: boolean;
  route: 'direct' | 'clarification';
  reply: string;
  selected?: string;
  requiresConfirmation?: boolean;
  affected?: string[];
  plan?: DirectHaPlan;
}

export interface DirectHaPlan {
  entityId: string;
  domain: string;
  service: string;
  data: Record<string, unknown>;
}

export interface IndexedVoiceCommand {
  entityId: string;
  domain: string;
  action: string;
  service?: string;
  priority: number;
  requiresConfirmation: boolean;
  friendlyName?: string;
  state: string;
}

type ParsedCommand = {
  action: 'on' | 'off' | 'toggle' | 'open' | 'close' | 'stop' | 'set_temperature' | 'status';
  target: string;
  domain?: string;
  temperature?: number;
};

const DOMAIN_WORDS: Record<string, string[]> = {
  light: ['light', 'lights', 'lamp', 'lamps'],
  switch: ['switch', 'switches', 'plug', 'plugs'],
  fan: ['fan', 'fans'],
  cover: ['blind', 'blinds', 'curtain', 'curtains', 'cover', 'covers', 'door', 'doors'],
  climate: ['thermostat', 'heating', 'heater', 'aircon', 'air conditioner', 'climate'],
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function inferredDomain(target: string): string | undefined {
  const text = normalize(target);
  return Object.entries(DOMAIN_WORDS).find(([, words]) => words.some(word => text.includes(word)))?.[0];
}

function parseCommand(transcript: string): ParsedCommand | null {
  const text = normalize(transcript);
  const temperature = text.match(/^(?:set|change) (?:the )?(.+?) (?:to|at) (\d{1,2}(?:\.\d+)?) ?(?:degrees?)?$/);
  if (temperature) return { action: 'set_temperature', target: temperature[1], domain: 'climate', temperature: Number(temperature[2]) };
  const action = text.match(/^(turn on|switch on|turn off|switch off|toggle|open|close|shut|stop) (?:the )?(.+)$/);
  if (action) {
    const verb = action[1];
    const normalizedAction = verb === 'turn on' || verb === 'switch on' ? 'on'
      : verb === 'turn off' || verb === 'switch off' ? 'off'
        : verb === 'shut' ? 'close' : verb as ParsedCommand['action'];
    return { action: normalizedAction, target: action[2], domain: inferredDomain(action[2]) };
  }
  const status = text.match(/^(?:what is|whats|is|are) (?:the )?(.+?)(?: status| on)?$/);
  return status ? { action: 'status', target: status[1], domain: inferredDomain(status[1]) } : null;
}

function scoreCandidate(command: ParsedCommand, candidate: HaEntityCandidate): number {
  if (command.domain && candidate.domain !== command.domain) return Number.NEGATIVE_INFINITY;
  const target = normalize(command.target);
  const friendlyName = normalize(candidate.friendlyName ?? '');
  const entityId = normalize(candidate.entityId);
  const aliases = (candidate.aliases ?? []).map(normalize);
  const contextualNames = [candidate.deviceName, candidate.areaName]
    .filter((value): value is string => Boolean(value)).map(normalize);
  let score = 0;
  if (friendlyName === target) score = 140;
  else if (aliases.includes(target)) score = 130;
  else if (entityId === target) score = 120;
  else if ([friendlyName, entityId, ...aliases].some(name => name && (name.includes(target) || target.includes(name)))) score = 90;
  else {
    const targetTerms = new Set(target.split(' '));
    const semanticTerms = [friendlyName, entityId, ...aliases].flatMap(name => name.split(' '));
    score = semanticTerms.filter(term => targetTerms.has(term)).length * 16;
    const contextTerms = contextualNames.flatMap(name => name.split(' '));
    score += contextTerms.filter(term => targetTerms.has(term)).length * 4;
  }
  return command.domain === candidate.domain ? score + 10 : score;
}

function describe(candidate: HaEntityCandidate): string {
  return candidate.friendlyName ?? candidate.entityId.replace(/^[^.]+\./, '').replace(/_/g, ' ');
}

function serviceFor(command: ParsedCommand, domain: string): { service: string; data: Record<string, unknown> } | null {
  if (command.action === 'status') return null;
  if (command.action === 'set_temperature') {
    return domain === 'climate' && Number.isFinite(command.temperature) && command.temperature! >= 10 && command.temperature! <= 30
      ? { service: 'set_temperature', data: { temperature: command.temperature } } : null;
  }
  if (['on', 'off'].includes(command.action) && domain === 'cover') {
    return { service: command.action === 'on' ? 'open_cover' : 'close_cover', data: {} };
  }
  if (['on', 'off', 'toggle'].includes(command.action) && ['light', 'switch', 'fan', 'input_boolean'].includes(domain)) {
    return { service: command.action === 'on' ? 'turn_on' : command.action === 'off' ? 'turn_off' : 'toggle', data: {} };
  }
  if (['open', 'close', 'stop'].includes(command.action) && domain === 'cover') {
    return { service: command.action === 'open' ? 'open_cover' : command.action === 'close' ? 'close_cover' : 'stop_cover', data: {} };
  }
  return null;
}

export async function handleDirectHaCommand(transcript: string, candidates: HaEntityCandidate[], haClient: HomeAssistantClient | null): Promise<DirectHaResult | null> {
  const command = parseCommand(transcript);
  if (!command) return null;
  const ranked = candidates.map(candidate => ({ candidate, score: scoreCandidate(command, candidate) }))
    .filter(item => item.score >= 24).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < 15) {
    return { handled: true, route: 'clarification', reply: `I found more than one match for ${command.target}. Please be more specific.` };
  }
  const entity = ranked[0].candidate;
  if (command.action === 'status') return { handled: true, route: 'direct', reply: `${describe(entity)} is ${entity.state}.`, selected: entity.entityId, affected: [entity.entityId] };
  const operation = serviceFor(command, entity.domain);
  if (!operation) return null;
  const plan: DirectHaPlan = { entityId: entity.entityId, domain: entity.domain, service: operation.service, data: operation.data };
  if (/\b(lock|garage|security|alarm)\b/i.test(`${entity.entityId} ${entity.friendlyName ?? ''}`)) {
    return { handled: true, route: 'clarification', selected: entity.entityId, requiresConfirmation: true, reply: `I need confirmation before changing ${describe(entity)}.`, plan };
  }
  const affected = await executeDirectHaPlan(plan, haClient);
  const verb = command.action === 'on' ? 'on' : command.action === 'off' ? 'off' : command.action === 'open' ? 'opening' : command.action === 'close' ? 'closing' : command.action === 'stop' ? 'stopped' : command.action === 'toggle' ? 'toggled' : `set to ${command.temperature} degrees`;
  return { handled: true, route: 'direct', selected: entity.entityId, reply: `${describe(entity)} ${verb}.`, affected: affected.map(item => item.entityId) };
}

export async function executeDirectHaPlan(plan: DirectHaPlan, haClient: HomeAssistantClient | null) {
  return controlEntity(haClient, plan.entityId, plan.domain, plan.service, plan.data);
}

export async function handleIndexedVoiceCommand(
  matches: IndexedVoiceCommand[],
  haClient: HomeAssistantClient | null,
): Promise<DirectHaResult | null> {
  if (matches.length === 0) return null;
  const bestPriority = Math.max(...matches.map(match => match.priority));
  const best = matches.filter(match => match.priority === bestPriority);
  const entityIds = new Set(best.map(match => match.entityId));
  if (entityIds.size !== 1) {
    return { handled: true, route: 'clarification', reply: 'I found more than one matching device. Please be more specific.' };
  }
  const match = best[0];
  const label = match.friendlyName ?? match.entityId.replace(/^[^.]+\./, '').replace(/_/g, ' ');
  if (match.action === 'status') {
    return { handled: true, route: 'direct', reply: `${label} is ${match.state}.`, affected: [match.entityId] };
  }
  const allowedServices: Record<string, Set<string>> = {
    light: new Set(['turn_on', 'turn_off', 'toggle']),
    switch: new Set(['turn_on', 'turn_off', 'toggle']),
    fan: new Set(['turn_on', 'turn_off', 'toggle']),
    input_boolean: new Set(['turn_on', 'turn_off', 'toggle']),
    cover: new Set(['open_cover', 'close_cover', 'stop_cover']),
  };
  if (!match.service) return null;
  const plan: DirectHaPlan = { entityId: match.entityId, domain: match.domain, service: match.service, data: {} };
  const serviceIsAllowlisted = allowedServices[match.domain]?.has(match.service) ?? false;
  if (!serviceIsAllowlisted || match.requiresConfirmation || /\b(lock|garage|security|alarm)\b/i.test(`${match.entityId} ${label}`)) {
    return { handled: true, route: 'clarification', requiresConfirmation: true, reply: `I need confirmation before changing ${label}.`, plan };
  }
  const affected = await executeDirectHaPlan(plan, haClient);
  return { handled: true, route: 'direct', reply: `${label} ${match.action.replace('_', ' ')}.`, affected: affected.map(entity => entity.entityId) };
}