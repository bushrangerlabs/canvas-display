// Canvas Core — standalone LLM function-calling + latency evaluation harness.
//
// Runs a fixed corpus of voice-turn prompts against candidate llama.cpp servers
// (OpenAI-compatible /v1/chat/completions) and scores each model on:
//   - tool-call accuracy (correct tool + arguments per prompt)
//   - latency (llama.cpp reports prompt_ms + predicted_ms in `timings`)
//   - "no-tool" discipline (does it NOT call a tool when it shouldn't)
//
// This lives OUTSIDE core and never touches it — it talks directly to the model
// servers so we can A/B models before wiring a winner into the core config.
//
// Usage:  node tools/eval/run.mjs [labelFilter]
//
// Model list and corpus come from ./models.json and ./corpus.json.

import { readFileSync } from 'node:fs';

const MODELS = JSON.parse(readFileSync(new URL('./models.json', import.meta.url), 'utf8'));
const CORPUS = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));

// ── Tool surface (OpenAI function schema) ────────────────────────────────────
// Representative of core's tool registry + MCP servers (ha, media, DAB/SDR, web).
const TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the web for current, factual, or news information.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'wikipedia_lookup', description: 'Look up an encyclopedic topic on Wikipedia.', parameters: { type: 'object', properties: { topic: { type: 'string', description: 'Topic to look up' } }, required: ['topic'] } } },
  { type: 'function', function: { name: 'ha_call_service', description: 'Call a Home Assistant service to control a device (turn lights/switches/doors on-off, set climate, etc).', parameters: { type: 'object', properties: { domain: { type: 'string', description: 'entity domain, e.g. light, switch, lock, climate' }, service: { type: 'string', description: 'service name, e.g. turn_on, turn_off, lock, set_temperature' }, entity_id: { type: 'string', description: 'optional specific entity id' }, service_data: { type: 'object', description: 'optional service data payload' } }, required: ['domain', 'service'] } } },
  { type: 'function', function: { name: 'ha_get_state', description: 'Read the current state/status of a Home Assistant entity.', parameters: { type: 'object', properties: { entity_id: { type: 'string', description: 'entity id to query' } }, required: ['entity_id'] } } },
  { type: 'function', function: { name: 'media_play', description: 'Play media: a YouTube video, a song, or a radio stream.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'what to play' }, source: { type: 'string', description: 'source: youtube, radio, music, etc.' }, media_kind: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'media_control', description: 'Control playback: pause, resume, stop, or next track.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume', 'stop', 'next'] }, source: { type: 'string' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'dab_play_station', description: 'Tune a DAB+ digital radio station using the SDR dongle.', parameters: { type: 'object', properties: { station: { type: 'string', description: 'station name or frequency' } }, required: ['station'] } } },
  { type: 'function', function: { name: 'set_timer', description: 'Start a countdown timer.', parameters: { type: 'object', properties: { duration_minutes: { type: 'number' }, label: { type: 'string' } }, required: ['duration_minutes'] } } },
  { type: 'function', function: { name: 'scene_activate', description: 'Activate a named Home Assistant scene.', parameters: { type: 'object', properties: { scene: { type: 'string' } }, required: ['scene'] } } },
];

const SYSTEM = 'You are a smart-home, media, and radio assistant. Use the provided tools whenever one matches the request. Prefer a tool call over answering from memory when current or factual information is needed. If no provided tool matches the request, answer directly in plain text.';

// ── xLAM JSON-in-content tool-call parser (mirror of core's parseContentAsToolCalls) ──
function parseContentAsToolCalls(content) {
  const trimmed = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const calls = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return null;
    const name = entry.name;
    let args = entry.arguments;
    if (typeof name !== 'string' || !name) return null;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
    if (args == null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) return null;
    calls.push({ name, arguments: args });
  }
  return calls;
}

// Extract tool calls from a chat.completion response (OpenAI tool_calls OR xLAM content).
function extractToolCalls(message) {
  const messageT = message ?? {};
  if (Array.isArray(messageT.tool_calls) && messageT.tool_calls.length > 0) {
    return messageT.tool_calls.map((tc) => ({
      name: tc.function?.name ?? '',
      arguments: (() => { try { return JSON.parse(tc.function?.arguments ?? '{}'); } catch { return {}; } })(),
    }));
  }
  if (typeof messageT.content === 'string' && messageT.content.trim()) {
    return parseContentAsToolCalls(messageT.content) ?? [];
  }
  return [];
}

// ── Argument matching ─────────────────────────────────────────────────────────
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function argMatches(args, key, expected) {
  const actual = getPath(args, key);
  if (actual === undefined || actual === null) return false;
  if (expected === '*') return true; // presence-only check
  if (typeof expected === 'string' && expected.startsWith('~')) {
    return String(actual).toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (typeof expected === 'number') return Number(actual) === expected;
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

// ── One prompt against one model ──────────────────────────────────────────────
async function runCase(model, testCase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const started = Date.now();
  try {
    const body = {
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: testCase.prompt }],
      tools: TOOLS,
      max_tokens: 512,
      temperature: 0,
    };
    if (model.model) body.model = model.model;

    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: `HTTP ${res.status}: ${text.slice(0, 120)}`, latencyMs: Date.now() - started };
    }
    const json = await res.json();
    const message = json.choices?.[0]?.message;
    const calls = extractToolCalls(message);
    const content = typeof message?.content === 'string' ? message.content : '';

    // Latency: prefer llama.cpp's reported timings, else wall-clock.
    const t = json.timings ?? {};
    const latencyMs = (t.prompt_ms != null || t.predicted_ms != null)
      ? Math.round((t.prompt_ms ?? 0) + (t.predicted_ms ?? 0))
      : (Date.now() - started);
    const tokPerSec = t.predicted_per_second != null ? t.predicted_per_second : null;

    // Score
    const expectTool = testCase.expectTool;
    let toolMatch = false;
    let argsOk = false;
    if (expectTool == null) {
      // Expected NO tool call.
      toolMatch = calls.length === 0;
      argsOk = calls.length === 0;
    } else {
      const hit = calls.find((c) => c.name.toLowerCase() === expectTool.toLowerCase());
      toolMatch = Boolean(hit);
      argsOk = toolMatch && Object.entries(testCase.expectArgs ?? {}).every(([k, v]) => argMatches(hit.arguments, k, v));
    }
    const pass = toolMatch && argsOk;

    return {
      pass,
      toolMatch,
      argsOk,
      emitted: calls.map((c) => c.name).join(',') || (content ? '(text)' : '(none)'),
      latencyMs,
      tokPerSec,
      content: content.slice(0, 120),
    };
  } catch (err) {
    return { error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ── Run everything ────────────────────────────────────────────────────────────
async function main() {
  const filter = process.argv[2];
  const models = filter ? MODELS.filter((m) => m.label.includes(filter)) : MODELS;
  const categories = [...new Set(CORPUS.map((c) => c.category))];

  console.log(`Eval: ${CORPUS.length} prompts x ${models.length} model(s)\n`);

  const results = [];
  for (const model of models) {
    const perCategory = Object.fromEntries(categories.map((cat) => ({ cat, pass: 0, total: 0, ms: [], tok: [] })).map((r) => [r.cat, r]));
    let errors = 0;

    for (const testCase of CORPUS) {
      const r = await runCase(model, testCase);
      process.stdout.write('.');
      if (r.error) { errors++; continue; }
      const bucket = perCategory[testCase.category];
      bucket.total++;
      if (r.pass) bucket.pass++;
      if (r.latencyMs != null) bucket.ms.push(r.latencyMs);
      if (r.tokPerSec != null) bucket.tok.push(r.tokPerSec);
      results.push({ label: model.label, id: testCase.id, category: testCase.category, r });
    }
    console.log(`\n\n=== ${model.label} ===`);
    let grandPass = 0, grandTotal = 0; const allMs = [];
    for (const cat of categories) {
      const b = perCategory[cat];
      const avg = b.ms.length ? Math.round(b.ms.reduce((a, x) => a + x, 0) / b.ms.length) : null;
      const tps = b.tok.length ? (b.tok.reduce((a, x) => a + x, 0) / b.tok.length).toFixed(1) : '—';
      console.log(`  ${cat.padEnd(14)} ${String(b.pass).padStart(2)}/${String(b.total).padStart(2)}  avg ${avg ?? '—'}ms  ${tps} tok/s`);
      grandPass += b.pass; grandTotal += b.total; allMs.push(...b.ms);
    }
    const gavg = allMs.length ? Math.round(allMs.reduce((a, x) => a + x, 0) / allMs.length) : null;
    console.log(`  ${'TOTAL'.padEnd(14)} ${String(grandPass).padStart(2)}/${String(grandTotal).padStart(2)}  avg ${gavg ?? '—'}ms  errors ${errors}`);
  }

  // Per-case detail (compact) — helpful for spotting WHERE a model differs.
  console.log('\n\n=== Per-case detail ===');
  for (const { label, id, category, r } of results) {
    if (r.error) { console.log(`  [${label}] ${id}: ERROR ${r.error}`); continue; }
    console.log(`  [${label}] ${id.padEnd(14)} ${r.pass ? 'PASS' : 'FAIL'}  → ${r.emitted}  ${r.latencyMs}ms`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });