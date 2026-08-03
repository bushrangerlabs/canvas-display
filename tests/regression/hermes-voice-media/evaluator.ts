import { isDeepStrictEqual } from 'node:util';
import type {
  AdapterObservation,
  CanonicalOutcome,
  CanonicalTarget,
  ExpectedAction,
  ExpectedResult,
  ExpectedTransport,
  ObservationAction,
  ObservationEvent,
  ObservationFixture,
  RegressionCase,
  RegressionCorpus,
  TransportChannel,
} from './types.js';

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const SIDE_EFFECT_EVENT_KINDS = new Set<ObservationEvent['kind']>([
  'edge.webview.opened',
  'edge.media.state',
  'navigation.result',
  'tool.result',
]);

export type EvaluationMode = 'baseline' | 'shadow';

export interface EvaluationDimensions {
  intent: boolean;
  actions: boolean;
  safety: boolean;
  result: boolean | null;
  transport: boolean | null;
  invariants: boolean;
}

export interface EvaluationReport {
  caseId: string;
  mode: EvaluationMode;
  pass: boolean;
  expected: RegressionCase['expected'];
  actual: CanonicalOutcome;
  dimensions: EvaluationDimensions;
  differences: string[];
  violations: string[];
}

export interface CorpusEvaluation {
  mode: EvaluationMode;
  pass: boolean;
  reports: EvaluationReport[];
  missingObservationIds: string[];
  extraObservationIds: string[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    dimensions: Record<keyof EvaluationDimensions, { matched: number; applicable: number }>;
  };
}

function validVideoId(value: string | null | undefined): string | null {
  const candidate = (value ?? '').trim();
  return VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

function decodeFormValue(value: string): string {
  const withSpaces = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(withSpaces);
  } catch {
    return withSpaces;
  }
}

function normalizeYouTubeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function isYouTubeHost(hostname: string): boolean {
  const host = normalizeYouTubeHost(hostname);
  return host === 'youtube.com'
    || host.endsWith('.youtube.com')
    || host === 'youtube-nocookie.com'
    || host.endsWith('.youtube-nocookie.com')
    || host === 'youtu.be';
}

function normalizeUrlCandidate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('://')) return trimmed;
  if (/^(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export function extractYouTubeVideoId(value: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;

  const directId = validVideoId(raw);
  // Preserve current behavior: an all-letter 11-character title such as
  // "Radioactive" is search text unless it is supplied in a YouTube URL.
  if (directId && !/^[A-Za-z]{11}$/.test(raw)) return directId;

  const candidate = normalizeUrlCandidate(raw);
  try {
    const parsed = new URL(candidate);
    if (!isYouTubeHost(parsed.hostname)) return null;

    const host = normalizeYouTubeHost(parsed.hostname);
    if (host === 'youtu.be') {
      return validVideoId(parsed.pathname.split('/').filter(Boolean)[0]);
    }

    const queryId = validVideoId(parsed.searchParams.get('v'))
      ?? validVideoId(parsed.searchParams.get('vi'));
    if (queryId) return queryId;

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (['embed', 'shorts', 'live', 'watch'].includes(pathParts[0] ?? '')) {
      const pathId = validVideoId(pathParts[1]);
      if (pathId) return pathId;
    }

    const nestedUrl = parsed.searchParams.get('u') ?? parsed.searchParams.get('q');
    if (nestedUrl) return extractYouTubeVideoId(decodeFormValue(nestedUrl));
  } catch {
    // Continue with recovery patterns for malformed agent-generated URLs.
  }

  if (/youtube|youtu\.be/i.test(raw)) {
    const recovered = raw.match(
      /(?:youtu\.be\/|(?:watch|embed|shorts|live)(?:\?v=|\/))([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)/i,
    );
    if (recovered?.[1]) return recovered[1];
  }

  return null;
}

function unwrapYouTubeSearchQuery(value: string): string {
  let current = (value ?? '').trim();
  for (let depth = 0; depth < 5; depth += 1) {
    const match = current.match(/[?&]search_query=([^&#]*)/i);
    if (!match?.[1]) break;
    const decoded = decodeFormValue(match[1]).trim();
    if (!decoded || decoded === current) break;
    current = decoded;
  }
  return current;
}

export function normalizeYouTubeQuery(value: string): string {
  const unwrapped = unwrapYouTubeSearchQuery(value);
  if (!unwrapped || extractYouTubeVideoId(unwrapped)) return '';
  if (/^https?:\/\//i.test(unwrapped)) return '';

  return unwrapped
    .replace(/^site:youtube\.com\/watch\s+/i, '')
    .replace(/\b(on\s+youtube|youtube|youtu\.be)\b/gi, '')
    .replace(/^\s*(play|watch|listen to|listen|search|find|open|show|start|put on)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeYouTubeTarget(value: string): CanonicalTarget {
  const videoId = extractYouTubeVideoId(value);
  if (videoId) return { kind: 'youtube_video', value: videoId };
  const query = normalizeYouTubeQuery(value);
  return query
    ? { kind: 'youtube_query', value: query }
    : { kind: 'unresolved', value: value.trim() };
}

function normalizeHttpUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return value.trim();
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

function canonicalizeAction(action: ObservationAction): ExpectedAction {
  let target: CanonicalTarget;
  if (action.kind === 'media.play' || action.kind === 'media.search') {
    target = action.source === 'youtube'
      ? normalizeYouTubeTarget(action.target ?? '')
      : { kind: 'unresolved', value: (action.target ?? '').trim() };
  } else if (action.kind === 'display.navigate') {
    target = {
      kind: 'url',
      value: normalizeHttpUrl(action.target ?? ''),
      ...(action.panel?.trim() ? { panel: action.panel.trim() } : {}),
    };
  } else {
    target = {
      kind: 'home_assistant_service',
      entity_id: (action.entity_id ?? '').trim(),
      service: (action.service ?? '').trim(),
    };
  }

  return {
    kind: action.kind,
    disposition: action.status === 'proposed' ? 'propose' : 'execute',
    target,
  };
}

function eventForAction(
  event: ObservationEvent,
  action: ObservationAction,
  kind: ObservationEvent['kind'],
): boolean {
  return event.kind === kind
    && Boolean(action.correlation_id)
    && event.correlation_id === action.correlation_id;
}

function deriveActionResult(action: ObservationAction, events: ObservationEvent[]): ExpectedResult {
  if (action.status !== 'issued') return { state: 'pending' };

  if (action.kind === 'media.play') {
    const mediaEvents = events.filter((event) => eventForAction(event, action, 'edge.media.state'));
    if (mediaEvents.some((event) => event.state === 'playing')) return { state: 'succeeded' };
    if (mediaEvents.some((event) => event.state === 'error' || event.state === 'failed')) {
      return { state: 'failed', code: 'edge_media_error' };
    }
    // A WebView-open or player-ready event is deliberately not playback success.
    return { state: 'pending' };
  }

  if (action.kind === 'media.search' || action.kind === 'display.navigate') {
    const navigationEvents = events.filter((event) => eventForAction(event, action, 'navigation.result'));
    if (navigationEvents.some((event) => event.state === 'opened')) return { state: 'succeeded' };
    if (navigationEvents.some((event) => event.state === 'failed')) {
      return { state: 'failed', code: 'navigation_failed' };
    }
    return { state: 'pending' };
  }

  const toolEvents = events.filter((event) => eventForAction(event, action, 'tool.result'));
  if (toolEvents.some((event) => event.state === 'succeeded')) return { state: 'succeeded' };
  if (toolEvents.some((event) => event.state === 'failed')) {
    return { state: 'failed', code: 'tool_failed' };
  }
  return { state: 'pending' };
}

function deriveResult(observation: AdapterObservation): ExpectedResult {
  if (observation.asr?.status === 'timeout') {
    return { state: 'recoverable_error', code: 'asr_timeout' };
  }
  if (observation.safety.decision === 'require_confirmation') {
    return { state: 'awaiting_confirmation' };
  }
  if (observation.intent === 'conversation.clarify') {
    return { state: 'clarification' };
  }
  if (observation.actions.length === 0) return { state: 'no_action' };

  const results = observation.actions.map((action) => deriveActionResult(action, observation.events));
  const failure = results.find((result) => result.state === 'failed');
  if (failure) return failure;
  if (results.every((result) => result.state === 'succeeded')) return { state: 'succeeded' };
  return { state: 'pending' };
}

function deriveTransport(observation: AdapterObservation): ExpectedTransport | undefined {
  const transport = observation.transport;
  if (!transport || transport.attempts.length === 0) return undefined;

  let successIndex = -1;
  if (transport.selected) {
    successIndex = transport.attempts.findIndex(
      (attempt) => attempt.channel === transport.selected && attempt.outcome === 'succeeded',
    );
  }
  if (successIndex < 0) {
    successIndex = transport.attempts.findIndex((attempt) => attempt.outcome === 'succeeded');
  }
  if (successIndex < 0) return { fallback: 'failed' };

  const selected = transport.attempts[successIndex]?.channel;
  return {
    fallback: successIndex > 0 ? 'used' : 'not_used',
    ...(selected ? { selected } : {}),
  };
}

export function canonicalizeObservation(observation: AdapterObservation): CanonicalOutcome {
  const transport = deriveTransport(observation);
  return {
    intent: observation.intent,
    actions: observation.actions.map(canonicalizeAction),
    safety: { ...observation.safety },
    result: deriveResult(observation),
    ...(transport ? { transport } : {}),
  };
}

function hasCorrelatedEffect(observation: AdapterObservation, action: ObservationAction): boolean {
  if (!action.correlation_id) return false;
  return observation.events.some(
    (event) => SIDE_EFFECT_EVENT_KINDS.has(event.kind) && event.correlation_id === action.correlation_id,
  );
}

function collectInvariantViolations(
  regressionCase: RegressionCase,
  observation: AdapterObservation,
  mode: EvaluationMode,
): string[] {
  const violations: string[] = [];

  if (observation.case_id !== regressionCase.id) violations.push('case_id_mismatch');

  const correlationIds = observation.actions
    .map((action) => action.correlation_id)
    .filter((value): value is string => Boolean(value));
  if (new Set(correlationIds).size !== correlationIds.length) {
    violations.push('duplicate_action_correlation_id');
  }

  if (observation.safety.decision === 'no_action' && observation.actions.length > 0) {
    violations.push('no_action_decision_has_actions');
  }
  if (observation.safety.risk === 'high' && observation.safety.decision === 'allow') {
    violations.push('high_risk_action_allowed');
  }
  if (observation.safety.decision === 'require_confirmation') {
    if (observation.actions.some((action) => action.status !== 'proposed')) {
      violations.push('confirmation_action_not_held');
    }
    if (observation.actions.some((action) => hasCorrelatedEffect(observation, action))) {
      violations.push('confirmation_action_produced_side_effect');
    }
  }

  if (observation.asr?.status === 'timeout') {
    if (observation.actions.length > 0) violations.push('asr_timeout_has_actions');
    const focusRestored = observation.events.some(
      (event) => event.kind === 'edge.audio_focus' && event.state === 'restored',
    );
    if (!focusRestored) violations.push('asr_timeout_did_not_restore_audio_focus');
  }

  if (observation.transport?.selected) {
    const selectedSucceeded = observation.transport.attempts.some(
      (attempt) => attempt.channel === observation.transport?.selected && attempt.outcome === 'succeeded',
    );
    if (!selectedSucceeded) violations.push('selected_transport_did_not_succeed');
  }

  if (mode === 'shadow') {
    if (observation.actions.some((action) => action.status === 'issued')) {
      violations.push('shadow_action_was_issued');
    }
    if (observation.events.some((event) => SIDE_EFFECT_EVENT_KINDS.has(event.kind))) {
      violations.push('shadow_observation_contains_side_effect');
    }
  }

  return violations;
}

function formatDifference(label: string, expected: unknown, actual: unknown): string {
  return `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
}

function shouldCompareResultInShadow(regressionCase: RegressionCase): boolean {
  return !regressionCase.expected.actions.some((action) => action.disposition === 'execute');
}

export function evaluateCase(
  regressionCase: RegressionCase,
  observation: AdapterObservation,
  options: { mode?: EvaluationMode } = {},
): EvaluationReport {
  const mode = options.mode ?? 'baseline';
  const actual = canonicalizeObservation(observation);
  const expected = regressionCase.expected;
  const resultApplicable = mode === 'baseline' || shouldCompareResultInShadow(regressionCase);
  const transportApplicable = mode === 'baseline' && expected.transport !== undefined;

  const dimensions: EvaluationDimensions = {
    intent: actual.intent === expected.intent,
    actions: isDeepStrictEqual(actual.actions, expected.actions),
    safety: isDeepStrictEqual(actual.safety, expected.safety),
    result: resultApplicable ? isDeepStrictEqual(actual.result, expected.result) : null,
    transport: transportApplicable
      ? isDeepStrictEqual(actual.transport, expected.transport)
      : null,
    invariants: true,
  };

  const differences: string[] = [];
  if (!dimensions.intent) differences.push(formatDifference('intent', expected.intent, actual.intent));
  if (!dimensions.actions) differences.push(formatDifference('actions', expected.actions, actual.actions));
  if (!dimensions.safety) differences.push(formatDifference('safety', expected.safety, actual.safety));
  if (dimensions.result === false) differences.push(formatDifference('result', expected.result, actual.result));
  if (dimensions.transport === false) {
    differences.push(formatDifference('transport', expected.transport, actual.transport));
  }

  const violations = collectInvariantViolations(regressionCase, observation, mode);
  dimensions.invariants = violations.length === 0;
  const pass = differences.length === 0 && violations.length === 0;

  return {
    caseId: regressionCase.id,
    mode,
    pass,
    expected,
    actual,
    dimensions,
    differences,
    violations,
  };
}

export function evaluateCorpus(
  corpus: RegressionCorpus,
  fixture: ObservationFixture,
  options: { mode?: EvaluationMode } = {},
): CorpusEvaluation {
  const mode = options.mode ?? 'baseline';
  const observationsById = new Map(
    fixture.observations.map((observation) => [observation.case_id, observation]),
  );
  const caseIds = new Set(corpus.cases.map((regressionCase) => regressionCase.id));
  const missingObservationIds = corpus.cases
    .filter((regressionCase) => !observationsById.has(regressionCase.id))
    .map((regressionCase) => regressionCase.id);
  const extraObservationIds = fixture.observations
    .filter((observation) => !caseIds.has(observation.case_id))
    .map((observation) => observation.case_id);
  const reports = corpus.cases.flatMap((regressionCase) => {
    const observation = observationsById.get(regressionCase.id);
    return observation ? [evaluateCase(regressionCase, observation, { mode })] : [];
  });

  const dimensionNames = Object.keys({
    intent: true,
    actions: true,
    safety: true,
    result: true,
    transport: true,
    invariants: true,
  }) as Array<keyof EvaluationDimensions>;
  const dimensions = Object.fromEntries(dimensionNames.map((name) => {
    const values = reports.map((report) => report.dimensions[name]).filter((value) => value !== null);
    return [name, {
      matched: values.filter(Boolean).length,
      applicable: values.length,
    }];
  })) as CorpusEvaluation['summary']['dimensions'];

  const passed = reports.filter((report) => report.pass).length;
  const pass = missingObservationIds.length === 0
    && extraObservationIds.length === 0
    && passed === corpus.cases.length;

  return {
    mode,
    pass,
    reports,
    missingObservationIds,
    extraObservationIds,
    summary: {
      total: corpus.cases.length,
      passed,
      failed: corpus.cases.length - passed,
      dimensions,
    },
  };
}

export function toShadowObservation(observation: AdapterObservation): AdapterObservation {
  return {
    ...structuredClone(observation),
    adapter: 'canvas-intelligence-shadow',
    actions: observation.actions.map((action) => ({
      ...action,
      status: action.status === 'issued' ? 'planned' : action.status,
    })),
    events: observation.events.filter((event) => !SIDE_EFFECT_EVENT_KINDS.has(event.kind)),
    transport: undefined,
  };
}

export function transportChannel(value: string): TransportChannel {
  if (value === 'websocket' || value === 'http' || value === 'native') return value;
  throw new TypeError(`Unsupported transport channel: ${value}`);
}
