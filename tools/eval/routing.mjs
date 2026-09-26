// Canvas Core — deterministic routing coverage measurement (Phase 2).
//
// For each corpus prompt, run core's pure deterministic regex router
// (`routeIntent`) and measure whether it catches the prompt WITHOUT an LLM
// (~0ms), or falls through to the LLM classifier / conversation model.
//
// This reads a pure compiled function from core (never edits it) and requires
// no network or model server. Note: core also has a SECOND deterministic layer
// (the Hassil grammar via `parseHaIntent` → `handleDirectHaCommand`) which this
// script does not exercise, so real deterministic coverage is HIGHER than the
// numbers printed here.
//
// Usage: node tools/eval/routing.mjs

import { readFileSync } from 'node:fs';
import { routeIntent } from '../../core/dist/intent-router.js';

const CORPUS = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));

// Mirror of IntentRouter.route()'s "which fallthrough path" heuristics.
const QUESTION_RE = /^\s*(?:who|what|when|where|why|which|explain(?:ing)?|tell\s+me|how\s+(?:does|do|is|are|can|would|could|should))\b/i;
const ACTION_HINT_RE = /\b(?:play|watch|listen|show|display|navigate|open|pause|resume|stop|skip|volume|channel)\b/i;

const categories = [...new Set(CORPUS.map((c) => c.category))];
const perCategory = Object.fromEntries(categories.map((cat) => [cat, { caught: 0, total: 0 }]));
let caught = 0, missed = 0;

console.log('Prompt                         → deterministic router\n');
for (const c of CORPUS) {
  const t0 = Date.now();
  const r = routeIntent(c.prompt);
  const ms = Date.now() - t0;
  perCategory[c.category].total++;

  let bucket;
  if (r.intent !== 'unknown' && r.intent !== 'error') {
    bucket = `CAUGHT       intent=${r.intent} (${r.tool_calls.length} tool calls)`;
    caught++;
    perCategory[c.category].caught++;
  } else if (QUESTION_RE.test(c.prompt) && !ACTION_HINT_RE.test(c.prompt)) {
    bucket = 'MISS → conversation (plain question)';
    missed++;
  } else if (ACTION_HINT_RE.test(c.prompt)) {
    bucket = 'MISS → LLM classifier (ambiguous action)';
    missed++;
  } else {
    bucket = 'MISS → conversation (unknown)';
    missed++;
  }
  console.log(`  ${c.prompt.padEnd(44)} ${bucket}`);
}

console.log('\n=== Coverage by category (deterministic regex only) ===');
for (const cat of categories) {
  const b = perCategory[cat];
  console.log(`  ${cat.padEnd(14)} ${String(b.caught).padStart(2)}/${String(b.total).padStart(2)}`);
}
const pct = Math.round((caught / CORPUS.length) * 100);
console.log(`\n  TOTAL: ${caught}/${CORPUS.length} caught deterministically (${pct}%) — ${missed} need an LLM.`);
console.log('  (Adds the Hassil HA-grammar layer on top, so true coverage is higher.)');