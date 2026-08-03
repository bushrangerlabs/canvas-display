import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  evaluateCase,
  evaluateCorpus,
  normalizeYouTubeTarget,
  toShadowObservation,
} from './evaluator.js';
import {
  findCase,
  findObservation,
  fixturePaths,
  loadRegressionFixtures,
} from './fixtures.js';
import type { AdapterObservation, ObservationFixture } from './types.js';

const fixturesPromise = loadRegressionFixtures();

function failedReportMessage(report: ReturnType<typeof evaluateCase>): string {
  return JSON.stringify({
    differences: report.differences,
    violations: report.violations,
    actual: report.actual,
  }, null, 2);
}

test('sanitized reference observations satisfy the complete Phase 0 corpus', async (t) => {
  const { corpus, observations } = await fixturesPromise;
  const evaluation = evaluateCorpus(corpus, observations);

  assert.deepEqual(evaluation.missingObservationIds, []);
  assert.deepEqual(evaluation.extraObservationIds, []);
  assert.equal(evaluation.reports.length, corpus.cases.length);

  for (const report of evaluation.reports) {
    await t.test(report.caseId, () => {
      assert.equal(report.pass, true, failedReportMessage(report));
    });
  }

  assert.equal(evaluation.pass, true);
  assert.equal(evaluation.summary.passed, corpus.cases.length);
  assert.equal(evaluation.summary.failed, 0);
});

test('corpus covers the required Hermes, voice, HA, navigation, and media boundaries', async () => {
  const { corpus } = await fixturesPromise;
  const tags = new Set(corpus.cases.flatMap((regressionCase) => regressionCase.tags));
  const requiredTags = [
    'youtube-title',
    'youtube-url-malformed',
    'youtube-url-direct',
    'youtube-url-search',
    'youtube-url-embed',
    'clarification',
    'no-action',
    'navigation',
    'home-assistant-harmless',
    'home-assistant-sensitive',
    'confirmation',
    'asr-timeout',
    'hermes-transport-fallback',
    'edge-playing',
    'webview-not-playing',
  ];

  for (const tag of requiredTags) assert(tags.has(tag), `missing required corpus tag ${tag}`);
  assert(corpus.cases.some(
    (regressionCase) => regressionCase.stimulus.kind === 'text'
      && regressionCase.stimulus.utterance.includes('I Should Be So Lucky'),
  ));
});

test('YouTube target normalization preserves current direct, malformed, search, embed, and title behavior', () => {
  assert.deepEqual(
    normalizeYouTubeTarget('Play I Should Be So Lucky on YouTube'),
    { kind: 'youtube_query', value: 'I Should Be So Lucky' },
  );
  assert.deepEqual(
    normalizeYouTubeTarget('Radioactive'),
    { kind: 'youtube_query', value: 'Radioactive' },
  );
  assert.deepEqual(
    normalizeYouTubeTarget('https://youtu.be/qK6IGnNeHn4'),
    { kind: 'youtube_video', value: 'qK6IGnNeHn4' },
  );
  assert.deepEqual(
    normalizeYouTubeTarget('https://www.youtube.com/watch/qK6IGnNeHn4'),
    { kind: 'youtube_video', value: 'qK6IGnNeHn4' },
  );
  assert.deepEqual(
    normalizeYouTubeTarget('https://www.youtube.com/embed/qK6IGnNeHn4?autoplay=1'),
    { kind: 'youtube_video', value: 'qK6IGnNeHn4' },
  );
  assert.deepEqual(
    normalizeYouTubeTarget('https://www.youtube.com/results?search_query=I+Should+Be+So+Lucky'),
    { kind: 'youtube_query', value: 'I Should Be So Lucky' },
  );
  assert.deepEqual(
    normalizeYouTubeTarget('https://www.youtube.com/results?search_query=https%3A%2F%2Fwww..com%2Fresults%3Fsearch_query%3DI%2BShould%2BBe%2BSo%2BLucky'),
    { kind: 'youtube_query', value: 'I Should Be So Lucky' },
  );
});

test('opening a WebView or reaching player ready is not media success', async () => {
  const { corpus, observations } = await fixturesPromise;
  const pendingCase = findCase(corpus, 'youtube-webview-open-is-not-playing');
  const pendingObservation = findObservation(observations, pendingCase.id);
  const pendingReport = evaluateCase(pendingCase, pendingObservation);

  assert.equal(pendingReport.pass, true, failedReportMessage(pendingReport));
  assert.deepEqual(pendingReport.actual.result, { state: 'pending' });

  const successCase = findCase(corpus, 'youtube-title-i-should-be-so-lucky');
  const withoutPlaying = structuredClone(findObservation(observations, successCase.id));
  withoutPlaying.events = withoutPlaying.events.filter(
    (event) => !(event.kind === 'edge.media.state' && event.state === 'playing'),
  );
  const failedSuccessClaim = evaluateCase(successCase, withoutPlaying);

  assert.equal(failedSuccessClaim.pass, false);
  assert.deepEqual(failedSuccessClaim.actual.result, { state: 'pending' });
  assert(failedSuccessClaim.differences.some((difference) => difference.startsWith('result:')));
});

test('stale playing evidence with a different correlation id cannot complete playback', async () => {
  const { corpus, observations } = await fixturesPromise;
  const regressionCase = findCase(corpus, 'youtube-webview-open-is-not-playing');
  const observation = structuredClone(findObservation(observations, regressionCase.id));
  observation.events.push({
    kind: 'edge.media.state',
    correlation_id: 'stale-playback',
    state: 'playing',
  });

  const report = evaluateCase(regressionCase, observation);
  assert.equal(report.pass, true, failedReportMessage(report));
  assert.deepEqual(report.actual.result, { state: 'pending' });
});

test('sensitive HA actions fail closed when confirmation is bypassed', async () => {
  const { corpus, observations } = await fixturesPromise;
  const regressionCase = findCase(corpus, 'home-assistant-sensitive-unlock-confirmation');
  const observation = structuredClone(findObservation(observations, regressionCase.id));
  observation.safety = { decision: 'allow', risk: 'high' };
  observation.actions[0] = { ...observation.actions[0], status: 'issued' };
  observation.events.push({
    kind: 'tool.result',
    correlation_id: observation.actions[0]?.correlation_id,
    state: 'succeeded',
  });

  const report = evaluateCase(regressionCase, observation);
  assert.equal(report.pass, false);
  assert(report.violations.includes('high_risk_action_allowed'));
  assert.equal(report.dimensions.actions, false);
  assert.equal(report.dimensions.safety, false);
});

test('clarification and ASR timeout turns cannot smuggle actions', async () => {
  const { corpus, observations } = await fixturesPromise;

  const clarificationCase = findCase(corpus, 'clarification-ambiguous-website');
  const clarification = structuredClone(findObservation(observations, clarificationCase.id));
  clarification.actions.push({
    kind: 'display.navigate',
    status: 'issued',
    correlation_id: 'unexpected-navigation',
    target: 'https://example.com/',
  });
  const clarificationReport = evaluateCase(clarificationCase, clarification);
  assert.equal(clarificationReport.pass, false);
  assert(clarificationReport.violations.includes('no_action_decision_has_actions'));

  const timeoutCase = findCase(corpus, 'voice-asr-timeout');
  const timeout = structuredClone(findObservation(observations, timeoutCase.id));
  timeout.events = [];
  timeout.actions.push({
    kind: 'home_assistant.call_service',
    status: 'issued',
    correlation_id: 'unexpected-ha-action',
    entity_id: 'light.reading_lamp',
    service: 'turn_on',
  });
  const timeoutReport = evaluateCase(timeoutCase, timeout);
  assert.equal(timeoutReport.pass, false);
  assert(timeoutReport.violations.includes('asr_timeout_has_actions'));
  assert(timeoutReport.violations.includes('asr_timeout_did_not_restore_audio_focus'));
});

test('Hermes fallback requires a failed primary attempt followed by selected HTTP success', async () => {
  const { corpus, observations } = await fixturesPromise;
  const regressionCase = findCase(corpus, 'hermes-transport-websocket-http-fallback');
  const observation = structuredClone(findObservation(observations, regressionCase.id));
  observation.transport = {
    attempts: [{ channel: 'websocket', outcome: 'failed', failure_code: 'endpoint_not_available' }],
    selected: 'http',
  };

  const report = evaluateCase(regressionCase, observation);
  assert.equal(report.pass, false);
  assert(report.violations.includes('selected_transport_did_not_succeed'));
  assert.equal(report.dimensions.transport, false);
});

test('shadow mode compares structured parity while rejecting every side-effect route', async () => {
  const { corpus, observations } = await fixturesPromise;
  const shadowFixture: ObservationFixture = {
    ...observations,
    description: 'Derived no-side-effect shadow observations',
    observations: observations.observations.map(toShadowObservation),
  };
  const shadowEvaluation = evaluateCorpus(corpus, shadowFixture, { mode: 'shadow' });

  assert.equal(shadowEvaluation.pass, true, JSON.stringify(
    shadowEvaluation.reports.filter((report) => !report.pass),
    null,
    2,
  ));
  assert.equal(shadowEvaluation.summary.dimensions.intent.matched, corpus.cases.length);
  assert.equal(shadowEvaluation.summary.dimensions.actions.matched, corpus.cases.length);
  assert.equal(shadowEvaluation.summary.dimensions.safety.matched, corpus.cases.length);

  const navigationCase = findCase(corpus, 'navigation-explicit-url');
  const unsafeShadow = structuredClone(findObservation(observations, navigationCase.id));
  unsafeShadow.adapter = 'canvas-intelligence-shadow';
  const unsafeReport = evaluateCase(navigationCase, unsafeShadow, { mode: 'shadow' });
  assert.equal(unsafeReport.pass, false);
  assert(unsafeReport.violations.includes('shadow_action_was_issued'));
  assert(unsafeReport.violations.includes('shadow_observation_contains_side_effect'));
});

test('evaluation is deterministic and does not mutate adapter observations', async () => {
  const { corpus, observations } = await fixturesPromise;
  const before = structuredClone(observations);
  const first = evaluateCorpus(corpus, observations);
  const second = evaluateCorpus(corpus, observations);

  assert.deepEqual(first, second);
  assert.deepEqual(observations, before);
});

test('committed JSON fixtures contain no credential material or private host addresses', async () => {
  const texts = await Promise.all([
    readFile(fixturePaths.corpus, 'utf8'),
    readFile(fixturePaths.observations, 'utf8'),
  ]);
  const combined = texts.join('\n');

  const privateAddressPatterns = [
    /\b10(?:\.\d{1,3}){3}\b/,
    /\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/,
    /\b192\.168(?:\.\d{1,3}){2}\b/,
    /\b169\.254(?:\.\d{1,3}){2}\b/,
  ];
  for (const pattern of privateAddressPatterns) assert.doesNotMatch(combined, pattern);

  const credentialPatterns = [
    /\bBearer\s+[A-Za-z0-9._~-]+/i,
    /"(?:api_key|access_token|refresh_token|password|client_secret|authorization)"\s*:/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  for (const pattern of credentialPatterns) assert.doesNotMatch(combined, pattern);

  const parsed = texts.map((text) => JSON.parse(text) as unknown);
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      const url = new URL(value);
      assert.equal(url.username, '', `fixture URL contains userinfo: ${url.origin}`);
      assert.equal(url.password, '', `fixture URL contains userinfo: ${url.origin}`);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(visit);
    }
  };
  parsed.forEach(visit);
});

test('observation fixtures have one adapter-neutral observation per corpus case', async () => {
  const { corpus, observations } = await fixturesPromise;
  const byCase = new Map<string, AdapterObservation>();
  for (const observation of observations.observations) {
    assert.equal(byCase.has(observation.case_id), false, `duplicate observation ${observation.case_id}`);
    byCase.set(observation.case_id, observation);
  }
  assert.deepEqual(
    [...byCase.keys()].sort(),
    corpus.cases.map((regressionCase) => regressionCase.id).sort(),
  );
});
