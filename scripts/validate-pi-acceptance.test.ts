import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePiAcceptanceReport } from './validate-pi-acceptance.js';

const now = new Date('2026-08-02T02:00:00.000Z');
const ids = ['inventory', 'speaker', 'microphone', 'wakeword', 'wake_cue', 'good_cue', 'bad_cue', 'full_voice', 'silent_voice'];
const validReport = () => ({
  schema: 'canvas-pi-hardware-acceptance-v1',
  exportedAt: '2026-08-02T01:31:00.000Z',
  device: { id: 'pi-1', name: 'Kitchen display' },
  results: ids.map(id => ({
    id, status: 'passed', finishedAt: '2026-08-02T01:30:00.000Z',
    apiResult: id === 'inventory' ? { microphones: 1, speakers: 1, wakeWords: 2 }
      : id === 'wakeword' ? { detected: true } : {},
  })),
});

test('accepts a fresh complete report for the expected device', () => {
  assert.deepEqual(validatePiAcceptanceReport(validReport(), { expectedDevice: 'pi-1', now }), []);
});

test('rejects failed, missing, duplicate, stale, and wrong-device evidence', () => {
  const report = validReport();
  report.exportedAt = '2026-07-30T01:31:00.000Z';
  report.device.id = 'pi-2';
  report.results[3].status = 'failed';
  report.results[3].apiResult = { detected: false };
  report.results.splice(7, 1);
  report.results.push({ ...report.results[0] });
  const errors = validatePiAcceptanceReport(report, { expectedDevice: 'pi-1', now });
  assert.ok(errors.includes('report belongs to a different device'));
  assert.ok(errors.includes('report is older than 24 hours'));
  assert.ok(errors.includes('results contain duplicate case IDs'));
  assert.ok(errors.includes('wakeword is not passed'));
  assert.ok(errors.includes('wakeword API evidence does not show detection'));
  assert.ok(errors.includes('missing required case: full_voice'));
});
