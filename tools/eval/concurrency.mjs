// Canvas Core — concurrency test for the "everything hot" placement.
//
// Fires simultaneous requests across all three resident models — Hermes
// (conversation, GPU1), Qwen3-1.7B router (GPU0), and Qwen3-VL-8B vision
// (GPU0) — for several rounds, confirming they coexist without OOM or
// pathological slowdown.
//
// Usage: node tools/eval/concurrency.mjs [imagePath]

import { readFileSync } from 'node:fs';
const IMG = process.argv[2] ?? '/tmp/bus.jpg';
const b64 = readFileSync(IMG).toString('base64');

const TOOLS = [{ type: 'function', function: { name: 'ha_call_service', description: 'Call a Home Assistant service.', parameters: { type: 'object', properties: { domain: { type: 'string' }, service: { type: 'string' } }, required: ['domain', 'service'] } } }];

const TARGETS = [
  {
    label: 'hermes-conv',
    url: 'http://192.168.1.108:8087/v1',
    model: '/models/NousResearch_Hermes-4-14B-Q6_K.gguf',
    body: { messages: [{ role: 'user', content: 'turn on the kitchen light' }], tools: TOOLS, max_tokens: 256, temperature: 0 },
  },
  {
    label: 'router',
    url: 'http://192.168.1.108:8081/v1',
    model: '/models/Qwen3-1.7B-Q8_0.gguf',
    body: { messages: [{ role: 'user', content: 'turn on the kitchen light' }], max_tokens: 128, temperature: 0 },
  },
  {
    label: 'vision',
    url: 'http://192.168.1.108:8083/v1',
    model: '/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf',
    body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'describe in one short sentence' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }], max_tokens: 128, temperature: 0 },
  },
];

async function hit(t) {
  const start = Date.now();
  try {
    const res = await fetch(`${t.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: t.model, ...t.body }),
    });
    return { label: t.label, ok: res.ok, ms: Date.now() - start, status: res.status };
  } catch (e) {
    return { label: t.label, ok: false, ms: Date.now() - start, error: String(e.message) };
  }
}

console.log('=== Concurrency: all 3 resident models, simultaneously, 4 rounds ===');
for (let round = 1; round <= 4; round++) {
  const results = await Promise.all([hit(TARGETS[0]), hit(TARGETS[1]), hit(TARGETS[2])]);
  console.log(`Round ${round}: ` + results.map(r => `${r.label}: ${r.ok ? 'ok' : 'FAIL'} ${r.ms}ms${r.status && !r.ok ? ` (${r.status})` : ''}${r.error ? ` ${r.error}` : ''}`).join('  |  '));
}