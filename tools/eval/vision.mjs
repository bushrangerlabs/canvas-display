// Canvas Core — vision model benchmark (Qwen3-VL-8B, the "camera description" model).
//
// Feeds a test image to the vision llama.cpp server's /v1/chat/completions using
// an image_url data URI, measures latency and reports the description. Run against
// the placement where vision lives on GPU0 alongside the router.
//
// Usage: node tools/eval/vision.mjs [imagePath]

import { readFileSync } from 'node:fs';

const VISION_URL = process.env.VISION_URL ?? 'http://192.168.1.108:8083/v1';
const MODEL = process.env.MODEL ?? '/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf';
const IMG = process.argv[2] ?? '/tmp/bus.jpg';

const b64 = readFileSync(IMG).toString('base64');

async function vision(prompt) {
  const started = Date.now();
  const res = await fetch(`${VISION_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ] }],
      max_tokens: 256,
      temperature: 0,
    }),
  });
  const ms = Date.now() - started;
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { error: `HTTP ${res.status}: ${t.slice(0, 200)}`, ms };
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? '(none)';
  const timings = json.timings ?? {};
  return { ms, content, tokPerSec: timings.predicted_per_second, predicted_ms: timings.predicted_ms };
}

console.log('=== Vision model (Qwen3-VL-8B) ===');
for (const prompt of [
  'Describe what is in this image in one sentence.',
  'How many people are visible in this image?',
  'List the vehicles you can see.',
]) {
  const r = await vision(prompt);
  console.log(`\nQ: ${prompt}`);
  console.log(`A: ${r.content}`);
  console.log(`   ${r.ms}ms${r.tokPerSec ? ` · ${r.tokPerSec} tok/s` : ''}${r.predicted_ms != null ? ` · decode ${r.predicted_ms}ms` : ''}${r.error ? ` · ERROR ${r.error}` : ''}`);
}