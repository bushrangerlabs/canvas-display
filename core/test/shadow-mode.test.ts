/**
 * Tests for the shadow mode comparison harness.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowModeRunner } from '../src/shadow-mode.js';
import { FakeHermesClient } from '../src/hermes-client.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = resolve(__dirname, '../../tests/hermes');

describe('ShadowModeRunner', () => {
  test('runCorpus processes all 16 test cases', async () => {
    const hermesClient = new FakeHermesClient({
      queryResponse: {
        intent: 'light_set',
        entities: ['light.kitchen'],
        tool_calls: [{ tool: 'ha.call_service', arguments: { domain: 'light', service: 'turn_on', service_data: { entity_id: 'light.kitchen' } } }],
        clarification_needed: false,
        response: 'Turning on the kitchen light.',
        confidence: 1.0,
      },
    });
    const runner = new ShadowModeRunner({ hermesClient, corpusPath: CORPUS_DIR });
    const report = await runner.runCorpus();

    assert.equal(report.total, 16);
    assert.ok(report.details.length === 16);
    assert.ok(typeof report.canvas_pass === 'number');
    assert.ok(typeof report.safety_pass === 'number');
    assert.ok(typeof report.match_rate === 'number');
    assert.ok(typeof report.clarification_rate === 'number');
    assert.ok(typeof report.average_latency.canvas === 'number');
  });

  test('runCorpus with no Hermes client skips Hermes comparison', async () => {
    const runner = new ShadowModeRunner({ hermesClient: null, corpusPath: CORPUS_DIR });
    const report = await runner.runCorpus();

    assert.equal(report.total, 16);
    assert.equal(report.hermes_pass, 0);
    assert.equal(report.average_latency.hermes, null);
    assert.equal(report.errors, 0);
    assert.ok(report.details.every((result) => result.error === null));
  });

  test('runSingle returns a valid ShadowResult', async () => {
    const hermesClient = new FakeHermesClient({
      queryResponse: {
        intent: 'light_set',
        entities: ['light.kitchen'],
        tool_calls: [{ tool: 'ha.call_service', arguments: { domain: 'light', service: 'turn_on', service_data: { entity_id: 'light.kitchen' } } }],
        clarification_needed: false,
        response: 'Turning on the kitchen light.',
        confidence: 1.0,
      },
    });
    const runner = new ShadowModeRunner({ hermesClient, corpusPath: CORPUS_DIR });
    const result = await runner.runSingle('turn on the kitchen light');

    assert.equal(result.transcript, 'turn on the kitchen light');
    assert.ok(result.canvas_result);
    assert.ok(result.hermes_result);
    assert.equal(typeof result.canvas_latency_ms, 'number');
    assert.equal(typeof result.hermes_latency_ms, 'number');
    assert.equal(typeof result.safety_pass, 'boolean');
    assert.equal(typeof result.matches, 'boolean');
    assert.equal(typeof result.clarification_needed, 'boolean');
  });

  test('runSingle with no Hermes client returns the Canvas-only result', async () => {
    const runner = new ShadowModeRunner({ hermesClient: null, corpusPath: CORPUS_DIR });
    const result = await runner.runSingle('test');
    assert.equal(result.error, null);
    assert.equal(result.hermes_result, null);
    assert.ok(result.canvas_result);
  });

  test('runSingle handles Hermes failure gracefully', async () => {
    const hermesClient = new FakeHermesClient({ shouldFail: true, failMessage: 'Hermes is down' });
    const runner = new ShadowModeRunner({ hermesClient, corpusPath: CORPUS_DIR });
    const result = await runner.runSingle('test');
    assert.ok(result.error);
    assert.equal(result.hermes_result, null);
    // Canvas result should still be valid
    assert.ok(result.canvas_result);
  });

  test('getStatus returns correct status', () => {
    const hermesClient = new FakeHermesClient();
    const runner = new ShadowModeRunner({ hermesClient, corpusPath: CORPUS_DIR });
    const status = runner.getStatus();
    assert.equal(status.active, true);
    assert.equal(status.hermes_configured, true);
    assert.equal(status.last_run, false);
  });

  test('getStatus with no Hermes client', () => {
    const runner = new ShadowModeRunner({ hermesClient: null, corpusPath: CORPUS_DIR });
    const status = runner.getStatus();
    assert.equal(status.hermes_configured, false);
  });

  test('getLastReport returns null before first run', () => {
    const runner = new ShadowModeRunner({ hermesClient: null, corpusPath: CORPUS_DIR });
    assert.equal(runner.getLastReport(), null);
  });

  test('getLastReport returns report after run', async () => {
    const runner = new ShadowModeRunner({ hermesClient: null, corpusPath: CORPUS_DIR });
    await runner.runCorpus();
    const report = runner.getLastReport();
    assert.ok(report);
    assert.equal(report?.total, 16);
  });

  test('safety_pass is checked against corpus constraints', async () => {
    const runner = new ShadowModeRunner({ hermesClient: null, corpusPath: CORPUS_DIR });
    const report = await runner.runCorpus();
    // All Canvas results should pass safety (the intent router respects constraints)
    assert.ok(report.safety_pass > 0);
  });
});
