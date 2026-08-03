/**
 * Tests for the Hermes corpus loader.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus, loadCorpusCase } from '../src/hermes-corpus.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = resolve(__dirname, '../../tests/hermes');

describe('Hermes corpus loader', () => {
  test('uses CANVAS_CORE_HERMES_CORPUS_PATH when configured', () => {
    const previous = process.env.CANVAS_CORE_HERMES_CORPUS_PATH;
    process.env.CANVAS_CORE_HERMES_CORPUS_PATH = CORPUS_DIR;
    try {
      assert.equal(loadCorpus().length, 16);
    } finally {
      if (previous === undefined) delete process.env.CANVAS_CORE_HERMES_CORPUS_PATH;
      else process.env.CANVAS_CORE_HERMES_CORPUS_PATH = previous;
    }
  });

  test('loads all 16 test cases from the corpus directory', () => {
    const corpus = loadCorpus(CORPUS_DIR);
    assert.equal(corpus.length, 16);
  });

  test('each test case has required fields', () => {
    const corpus = loadCorpus(CORPUS_DIR);
    for (const c of corpus) {
      assert.ok(c.id, `Case missing id: ${JSON.stringify(c)}`);
      assert.ok(c.transcript, `Case ${c.id} missing transcript`);
      assert.ok(c.expected_intent, `Case ${c.id} missing expected_intent`);
      assert.ok(Array.isArray(c.expected_tool_calls), `Case ${c.id} missing expected_tool_calls`);
      assert.ok(c.safety_constraints, `Case ${c.id} missing safety_constraints`);
      assert.equal(typeof c.expects_clarification, 'boolean', `Case ${c.id} missing expects_clarification`);
      assert.ok(Array.isArray(c.expected_entities), `Case ${c.id} missing expected_entities`);
    }
  });

  test('loads cases in sorted order', () => {
    const corpus = loadCorpus(CORPUS_DIR);
    const ids = corpus.map((c) => c.id);
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);
  });

  test('loadCorpusCase returns a specific case by ID', () => {
    const c = loadCorpusCase('001-turn-on-light', CORPUS_DIR);
    assert.ok(c);
    assert.equal(c?.id, '001-turn-on-light');
    assert.equal(c?.transcript, 'turn on the kitchen light');
    assert.equal(c?.expected_intent, 'light_set');
  });

  test('loadCorpusCase returns undefined for unknown ID', () => {
    const c = loadCorpusCase('nonexistent', CORPUS_DIR);
    assert.equal(c, undefined);
  });

  test('throws for invalid JSON in corpus directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hermes-test-'));
    try {
      writeFileSync(join(tmpDir, 'bad.json'), '{invalid json}', 'utf-8');
      assert.throws(() => loadCorpus(tmpDir), /Failed to parse/);
    } finally {
      rmdirSync(tmpDir, { recursive: true });
    }
  });

  test('throws for empty corpus directory', () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'hermes-test-empty-'));
    try {
      assert.throws(() => loadCorpus(tmpDir2), /No JSON files found/);
    } finally {
      rmdirSync(tmpDir2, { recursive: true });
    }
  });

  test('throws for missing corpus directory', () => {
    assert.throws(() => loadCorpus('/nonexistent/path'), /Hermes corpus directory not found/);
  });

  test('safety_constraints are correctly parsed for each case', () => {
    const corpus = loadCorpus(CORPUS_DIR);
    for (const c of corpus) {
      assert.equal(typeof c.safety_constraints.no_mutations, 'boolean', `Case ${c.id} no_mutations`);
      assert.ok(Array.isArray(c.safety_constraints.entity_allowlist), `Case ${c.id} entity_allowlist`);
    }
  });
});
