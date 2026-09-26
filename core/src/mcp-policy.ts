import type { ToolDefinition } from './tool-registry.js';

const MUTATING_WORDS = new Set([
  'add', 'bulk', 'call', 'control', 'create', 'delete', 'import', 'manage',
  'publish', 'reload', 'remove', 'report', 'restart', 'set', 'start', 'stop', 'trigger',
  'update', 'write',
]);

const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'for', 'from', 'get', 'in', 'of', 'on', 'the', 'to', 'tool', 'with',
  // Ordinary English stopwords/pronouns/auxiliaries that appear constantly in
  // both user requests and tool descriptions. Without these, short generic
  // messages (e.g. "what time is it") spuriously match large numbers of
  // unrelated tools just because their descriptions also contain "is"/"it"/etc.,
  // which can balloon the selected tool schemas well past a small model's context.
  'is', 'it', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'what', 'when', 'where', 'who', 'whom', 'which', 'why', 'how',
  'i', 'me', 'my', 'you', 'your', 'we', 'us', 'our', 'they', 'them', 'their', 'he', 'him', 'his', 'she', 'her', 'it\'s',
  'this', 'that', 'these', 'those', 'there', 'here',
  'please', 'thanks', 'thank', 'ok', 'okay', 'yes', 'no', 'not', 'so', 'just', 'now', 'up', 'down', 'out', 'about', 'as', 'at', 'by', 'if', 'or', 'but',
]);

const GENERIC_ACTION_WORDS = new Set([
  'turn', 'switch', 'toggle', 'show', 'list', 'find', 'search', 'read', 'get', 'set', 'update',
  'create', 'delete', 'call', 'open', 'close', 'check', 'start', 'stop', 'run', 'use', 'tell',
  'report', 'control', 'launch', 'trigger', 'view', 'look', 'status', 'state', 'value',
]);

const DOMAIN_HINT_WORDS = new Set([
  'weather', 'forecast', 'temperature', 'rain', 'wind', 'humidity', 'fan', 'light', 'switch',
  'device', 'entity', 'scene', 'automation', 'camera', 'node', 'red', 'flow', 'team', 'score',
  'game', 'state', 'sensor', 'alarm', 'door', 'lock', 'media', 'music', 'speaker', 'tv',
]);

const EXTERNAL_LOOKUP_WORDS = new Set([
  'current', 'currently', 'today', 'latest', 'recent', 'news', 'search', 'lookup', 'look',
  'online', 'internet', 'source', 'sources', 'verify', 'check', 'price', 'weather', 'forecast',
  'score', 'live', 'real', 'now',
]);

const READ_QUERY_WORDS = new Set([
  'is', 'are', 'was', 'were', 'on', 'off', 'status', 'state', 'current', 'currently',
  'whether', 'what', 'how', 'value', 'temperature', 'level', 'brightness',
]);

// Keep the serialized function schemas small enough to leave room for the
// system prompt, conversation, tool results, and the model's response.
const MAX_TOOL_SCHEMA_CHARS = 6_000;

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

function signalWords(value: string): Set<string> {
  return new Set([...words(value)].filter(word => !GENERIC_ACTION_WORDS.has(word) && (word.length >= 3 || DOMAIN_HINT_WORDS.has(word))));
}

function isReadQuery(request: string): boolean {
  const requestWords = new Set(request.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return [...requestWords].some(word => READ_QUERY_WORDS.has(word))
    && !['turn', 'switch', 'toggle', 'set', 'change', 'create', 'delete', 'start', 'stop'].some(word => requestWords.has(word));
}

export function requiresExternalLookup(request: string): boolean {
  const requestWords = new Set(request.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return [...requestWords].some(word => EXTERNAL_LOOKUP_WORDS.has(word))
    || /\blook\s+up\b|\bfind\s+(?:online|on\s+the\s+web)\b/i.test(request);
}

/** Return a small, relevant tool surface instead of sending every schema to the LLM. */
export function selectToolsForRequest(tools: ToolDefinition[], request: string, limit = 4): ToolDefinition[] {
  const queryWords = signalWords(request);
  if (queryWords.size === 0) return [];
  const readQuery = isReadQuery(request);
  const externalLookup = requiresExternalLookup(request);

  const shortGenericPrompt = request.trim().split(/\s+/).length <= 5
    && ![...queryWords].some(word => DOMAIN_HINT_WORDS.has(word));
  if (shortGenericPrompt) return [];

  const scored = tools.map(tool => {
    const haystack = words(`${tool.name} ${tool.description}`);
    if (readQuery && mcpToolRequiresConfirmation(tool.name)) return { tool, score: -1 };
    let score = 0;
    for (const word of queryWords) {
      if (haystack.has(word)) score += word.length >= 5 ? 4 : 2;
      else if (tool.name.toLowerCase().includes(word)) score += 1;
    }
    if (tool.name.startsWith('mcp.afl-mcp.') && queryWords.has('afl')) score += 20;
    if (tool.name.startsWith('mcp.ha-mcp.') && ['home', 'light', 'switch', 'automation', 'entity', 'device'].some(word => queryWords.has(word))) score += 12;
    if (tool.name.startsWith('mcp.node-red') && ['node', 'red', 'nodered', 'flow', 'flows'].some(word => queryWords.has(word))) score += 15;
    if (tool.name.startsWith('mcp.au-weather.') && ['weather', 'forecast', 'temperature', 'rain', 'wind', 'uv', 'bom'].some(word => queryWords.has(word))) score += 24;
    if (tool.name.startsWith('mcp.bowling.') && ['bowling', 'bowl', 'lane', 'pin', 'strike', 'spare', 'score'].some(word => queryWords.has(word))) score += 20;
    if (tool.name.startsWith('navigate.') && ['home', 'menu', 'main', 'navigate', 'screen', 'weather', 'news', 'page'].some(word => queryWords.has(word))) score += 25;
    if (externalLookup && /web_search|wikipedia_lookup/i.test(tool.name)) {
      score += /wikipedia_lookup/i.test(tool.name) ? 30 : 18;
    }
    if (!externalLookup && /web_search|wikipedia_lookup/i.test(tool.name)) score = -1;
    return { tool, score };
  });
  const ranked = scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, 4));

  const relevant: ToolDefinition[] = [];
  let schemaChars = 0;
  for (const item of ranked) {
    const nextChars = JSON.stringify(item.tool.schema).length;
    if (schemaChars + nextChars > MAX_TOOL_SCHEMA_CHARS) continue;
    relevant.push(item.tool);
    schemaChars += nextChars;
  }
  return relevant;
}

/** Resolve model-friendly aliases such as `ha-get-state` to one canonical tool. */
export function resolveToolName(requestedName: string, tools: Array<Pick<ToolDefinition, 'name'>>): string | undefined {
  const exact = tools.find(tool => tool.name === requestedName);
  if (exact) return exact.name;

  const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const requested = normalize(requestedName);
  const matches = tools.filter(tool => {
    const leaf = tool.name.split('.').at(-1) ?? tool.name;
    return normalize(leaf) === requested || normalize(tool.name) === requested;
  });
  return matches.length === 1 ? matches[0].name : undefined;
}

/** Normalize common xLAM argument shapes before a call reaches an MCP server. */
export function normalizeToolArguments(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...params };
  const leaf = toolName.split('.').at(-1) ?? toolName;
  if (leaf === 'ha_call_service' && normalized.service_data && typeof normalized.service_data === 'object') {
    delete normalized.service_data;
    Object.assign(normalized, params.service_data as Record<string, unknown>);
  }
  if (typeof normalized.entity_id === 'string' && !normalized.entity_id.includes('.') && normalized.entity_id.toLowerCase() === 'sun') {
    normalized.entity_id = 'sun.sun';
  }
  return normalized;
}

export function confirmationDigest(tool: string, params: Record<string, unknown>): string {
  return `confirm:${tool}:${JSON.stringify(params)}`;
}
