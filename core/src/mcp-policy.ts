import type { ToolDefinition } from './tool-registry.js';

const MUTATING_WORDS = new Set([
  'add', 'bulk', 'call', 'control', 'create', 'delete', 'import', 'manage',
  'publish', 'reload', 'remove', 'report', 'restart', 'set', 'start', 'stop', 'trigger',
  'update', 'write',
]);

const COMMON_WORDS = new Set(['a', 'an', 'and', 'for', 'from', 'get', 'in', 'of', 'on', 'the', 'to', 'tool', 'with']);

export function mcpToolRequiresConfirmation(name: string): boolean {
  const leaf = name.split('.').at(-1) ?? name;
  return leaf.split(/[_-]+/).some(part => MUTATING_WORDS.has(part.toLowerCase()));
}

export function mcpCallRequiresConfirmation(name: string, params: Record<string, unknown>): boolean {
  const leaf = name.split('.').at(-1) ?? name;
  if (leaf === 'ha_call_service') {
    const domain = String(params.domain ?? '').toLowerCase();
    const service = String(params.service ?? '').toLowerCase();
    const safeDomains = new Set(['light', 'switch', 'fan', 'input_boolean']);
    const safeServices = new Set(['turn_on', 'turn_off', 'toggle']);
    if (safeDomains.has(domain) && safeServices.has(service) && !params.ws_command) return false;
  }
  return mcpToolRequiresConfirmation(name);
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1 && !COMMON_WORDS.has(word)));
}

/** Return a small, relevant tool surface instead of sending every schema to the LLM. */
export function selectToolsForRequest(tools: ToolDefinition[], request: string, limit = 20): ToolDefinition[] {
  const queryWords = words(request);
  const scored = tools.map(tool => {
    const haystack = words(`${tool.name} ${tool.description}`);
    let score = 0;
    for (const word of queryWords) {
      if (haystack.has(word)) score += word.length >= 5 ? 4 : 2;
      else if (tool.name.toLowerCase().includes(word)) score += 1;
    }
    if (tool.name.startsWith('mcp.afl-mcp.') && queryWords.has('afl')) score += 20;
    if (tool.name.startsWith('mcp.ha-mcp.') && ['home', 'light', 'switch', 'automation', 'entity', 'device'].some(word => queryWords.has(word))) score += 12;
    if (tool.name.startsWith('mcp.au-weather.') && ['weather', 'forecast', 'temperature', 'rain', 'wind', 'uv', 'bom'].some(word => queryWords.has(word))) score += 24;
    if (tool.name.startsWith('mcp.bowling.') && ['bowling', 'bowl', 'lane', 'pin', 'strike', 'spare', 'score'].some(word => queryWords.has(word))) score += 20;
    return { tool, score };
  });
  const relevant = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.tool);
  return relevant;
}

export function confirmationDigest(tool: string, params: Record<string, unknown>): string {
  return `confirm:${tool}:${JSON.stringify(params)}`;
}
