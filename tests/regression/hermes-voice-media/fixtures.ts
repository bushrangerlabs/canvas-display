import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  type AdapterObservation,
  type ObservationFixture,
  type RegressionCase,
  type RegressionCorpus,
} from './types.js';

const FIXTURE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/hermes-voice-media',
);

export const fixturePaths = {
  corpus: resolve(FIXTURE_DIRECTORY, 'corpus.v1.json'),
  observations: resolve(FIXTURE_DIRECTORY, 'reference-observations.v1.json'),
} as const;

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function assertStringArray(value: unknown, path: string): void {
  for (const [index, item] of asArray(value, path).entries()) {
    asString(item, `${path}[${index}]`);
  }
}

function assertExpectedOutcome(value: unknown, path: string): void {
  const expected = asRecord(value, path);
  asString(expected.intent, `${path}.intent`);
  const actions = asArray(expected.actions, `${path}.actions`);
  for (const [index, actionValue] of actions.entries()) {
    const action = asRecord(actionValue, `${path}.actions[${index}]`);
    asString(action.kind, `${path}.actions[${index}].kind`);
    asString(action.disposition, `${path}.actions[${index}].disposition`);
    const target = asRecord(action.target, `${path}.actions[${index}].target`);
    asString(target.kind, `${path}.actions[${index}].target.kind`);
  }

  const safety = asRecord(expected.safety, `${path}.safety`);
  asString(safety.decision, `${path}.safety.decision`);
  asString(safety.risk, `${path}.safety.risk`);
  const result = asRecord(expected.result, `${path}.result`);
  asString(result.state, `${path}.result.state`);

  if (expected.transport !== undefined) {
    const transport = asRecord(expected.transport, `${path}.transport`);
    asString(transport.fallback, `${path}.transport.fallback`);
  }
}

function assertRegressionCase(value: unknown, index: number): void {
  const path = `corpus.cases[${index}]`;
  const item = asRecord(value, path);
  asString(item.id, `${path}.id`);
  asString(item.title, `${path}.title`);
  assertStringArray(item.tags, `${path}.tags`);
  const stimulus = asRecord(item.stimulus, `${path}.stimulus`);
  const kind = asString(stimulus.kind, `${path}.stimulus.kind`);
  if (kind === 'text') asString(stimulus.utterance, `${path}.stimulus.utterance`);
  if (kind === 'audio') asString(stimulus.audio_fixture, `${path}.stimulus.audio_fixture`);
  if (kind !== 'text' && kind !== 'audio') {
    throw new TypeError(`${path}.stimulus.kind must be text or audio`);
  }
  assertExpectedOutcome(item.expected, `${path}.expected`);
}

function assertObservation(value: unknown, index: number): void {
  const path = `observations.observations[${index}]`;
  const item = asRecord(value, path);
  asString(item.case_id, `${path}.case_id`);
  asString(item.adapter, `${path}.adapter`);
  asString(item.intent, `${path}.intent`);

  for (const [actionIndex, actionValue] of asArray(item.actions, `${path}.actions`).entries()) {
    const action = asRecord(actionValue, `${path}.actions[${actionIndex}]`);
    asString(action.kind, `${path}.actions[${actionIndex}].kind`);
    asString(action.status, `${path}.actions[${actionIndex}].status`);
  }

  const safety = asRecord(item.safety, `${path}.safety`);
  asString(safety.decision, `${path}.safety.decision`);
  asString(safety.risk, `${path}.safety.risk`);

  for (const [eventIndex, eventValue] of asArray(item.events, `${path}.events`).entries()) {
    const event = asRecord(eventValue, `${path}.events[${eventIndex}]`);
    asString(event.kind, `${path}.events[${eventIndex}].kind`);
  }

  if (item.asr !== undefined) {
    const asr = asRecord(item.asr, `${path}.asr`);
    asString(asr.status, `${path}.asr.status`);
  }

  if (item.transport !== undefined) {
    const transport = asRecord(item.transport, `${path}.transport`);
    for (const [attemptIndex, attemptValue] of asArray(transport.attempts, `${path}.transport.attempts`).entries()) {
      const attempt = asRecord(attemptValue, `${path}.transport.attempts[${attemptIndex}]`);
      asString(attempt.channel, `${path}.transport.attempts[${attemptIndex}].channel`);
      asString(attempt.outcome, `${path}.transport.attempts[${attemptIndex}].outcome`);
    }
  }
}

function assertUniqueIds(values: string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`${path} contains duplicate id ${value}`);
    seen.add(value);
  }
}

export function parseRegressionCorpus(value: unknown): RegressionCorpus {
  const root = asRecord(value, 'corpus');
  if (root.schema_version !== CORPUS_SCHEMA_VERSION) {
    throw new TypeError(`corpus.schema_version must be ${CORPUS_SCHEMA_VERSION}`);
  }
  asString(root.description, 'corpus.description');
  const cases = asArray(root.cases, 'corpus.cases');
  cases.forEach(assertRegressionCase);
  assertUniqueIds(
    cases.map((item, index) => asString(asRecord(item, `corpus.cases[${index}]`).id, `corpus.cases[${index}].id`)),
    'corpus.cases',
  );
  return root as unknown as RegressionCorpus;
}

export function parseObservationFixture(value: unknown): ObservationFixture {
  const root = asRecord(value, 'observations');
  if (root.schema_version !== OBSERVATION_SCHEMA_VERSION) {
    throw new TypeError(`observations.schema_version must be ${OBSERVATION_SCHEMA_VERSION}`);
  }
  asString(root.description, 'observations.description');
  const observations = asArray(root.observations, 'observations.observations');
  observations.forEach(assertObservation);
  assertUniqueIds(
    observations.map((item, index) => asString(
      asRecord(item, `observations.observations[${index}]`).case_id,
      `observations.observations[${index}].case_id`,
    )),
    'observations.observations',
  );
  return root as unknown as ObservationFixture;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function loadRegressionFixtures(): Promise<{
  corpus: RegressionCorpus;
  observations: ObservationFixture;
}> {
  const [corpus, observations] = await Promise.all([
    readJson(fixturePaths.corpus).then(parseRegressionCorpus),
    readJson(fixturePaths.observations).then(parseObservationFixture),
  ]);
  return { corpus, observations };
}

export function findCase(corpus: RegressionCorpus, id: string): RegressionCase {
  const item = corpus.cases.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown regression case: ${id}`);
  return item;
}

export function findObservation(fixture: ObservationFixture, id: string): AdapterObservation {
  const item = fixture.observations.find((candidate) => candidate.case_id === id);
  if (!item) throw new Error(`Unknown reference observation: ${id}`);
  return item;
}
