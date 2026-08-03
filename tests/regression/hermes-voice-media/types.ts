export const CORPUS_SCHEMA_VERSION = 'canvas.hermes-voice-media.corpus/v1' as const;
export const OBSERVATION_SCHEMA_VERSION = 'canvas.hermes-voice-media.observations/v1' as const;

export type IntentName =
  | 'media.play.youtube'
  | 'media.search.youtube'
  | 'conversation.clarify'
  | 'conversation.cancel'
  | 'answer.general'
  | 'display.navigate'
  | 'home_assistant.control'
  | 'voice.asr_timeout';

export type ActionKind =
  | 'media.play'
  | 'media.search'
  | 'display.navigate'
  | 'home_assistant.call_service';

export type ActionDisposition = 'execute' | 'propose';
export type ObservationActionStatus = 'planned' | 'proposed' | 'issued';
export type SafetyDecision = 'allow' | 'require_confirmation' | 'no_action';
export type RiskLevel = 'none' | 'low' | 'high';
export type ResultState =
  | 'succeeded'
  | 'pending'
  | 'failed'
  | 'no_action'
  | 'clarification'
  | 'awaiting_confirmation'
  | 'recoverable_error';
export type TransportChannel = 'websocket' | 'http' | 'native';
export type TransportAttemptOutcome = 'succeeded' | 'failed' | 'timed_out';
export type TransportFallbackState = 'used' | 'not_used' | 'failed';

export interface TextStimulus {
  kind: 'text';
  utterance: string;
  context?: Record<string, unknown>;
}

export interface AudioStimulus {
  kind: 'audio';
  audio_fixture: string;
  context?: Record<string, unknown>;
}

export type RegressionStimulus = TextStimulus | AudioStimulus;

export type CanonicalTarget =
  | { kind: 'youtube_query'; value: string }
  | { kind: 'youtube_video'; value: string }
  | { kind: 'url'; value: string; panel?: string }
  | { kind: 'home_assistant_service'; entity_id: string; service: string }
  | { kind: 'unresolved'; value: string };

export interface ExpectedAction {
  kind: ActionKind;
  disposition: ActionDisposition;
  target: CanonicalTarget;
}

export interface ExpectedSafety {
  decision: SafetyDecision;
  risk: RiskLevel;
}

export interface ExpectedResult {
  state: ResultState;
  code?: string;
}

export interface ExpectedTransport {
  fallback: TransportFallbackState;
  selected?: TransportChannel;
}

export interface ExpectedOutcome {
  intent: IntentName;
  actions: ExpectedAction[];
  safety: ExpectedSafety;
  result: ExpectedResult;
  transport?: ExpectedTransport;
}

export interface RegressionCase {
  id: string;
  title: string;
  tags: string[];
  stimulus: RegressionStimulus;
  expected: ExpectedOutcome;
}

export interface RegressionCorpus {
  schema_version: typeof CORPUS_SCHEMA_VERSION;
  description: string;
  cases: RegressionCase[];
}

export interface ObservationAction {
  kind: ActionKind;
  status: ObservationActionStatus;
  correlation_id?: string;
  source?: string;
  target?: string;
  panel?: string;
  entity_id?: string;
  service?: string;
}

export interface ObservationEvent {
  kind:
    | 'edge.webview.opened'
    | 'edge.media.state'
    | 'edge.audio_focus'
    | 'navigation.result'
    | 'tool.result';
  correlation_id?: string;
  state?: string;
}

export interface TransportAttempt {
  channel: TransportChannel;
  outcome: TransportAttemptOutcome;
  failure_code?: string;
}

export interface TransportObservation {
  attempts: TransportAttempt[];
  selected?: TransportChannel;
}

export interface AsrObservation {
  status: 'ok' | 'timeout' | 'error';
  provider?: string;
}

export interface AdapterObservation {
  case_id: string;
  adapter: string;
  intent: IntentName;
  actions: ObservationAction[];
  safety: ExpectedSafety;
  events: ObservationEvent[];
  asr?: AsrObservation;
  transport?: TransportObservation;
}

export interface ObservationFixture {
  schema_version: typeof OBSERVATION_SCHEMA_VERSION;
  description: string;
  observations: AdapterObservation[];
}

export interface CanonicalOutcome {
  intent: IntentName;
  actions: ExpectedAction[];
  safety: ExpectedSafety;
  result: ExpectedResult;
  transport?: ExpectedTransport;
}
