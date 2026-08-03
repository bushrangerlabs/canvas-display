/**
 * Shadow Mode Comparison Harness (plan doc §15.6, Phase 6).
 *
 * Runs both the Hermes agent and Canvas Intelligence side by side on the
 * same input, compares their outputs, and reports the results. This is the
 * gate that determines when Hermes can be disabled.
 *
 * Shadow mode has NO mutating credentials or execution route — it only
 * compares structured outcomes, safety, clarification, latency, and quality.
 */
import type { HermesClient, HermesQueryResponse } from './hermes-client.js';
import { loadCorpus, type CorpusCase, type SafetyConstraints } from './hermes-corpus.js';
import { routeIntent, type IntentResult } from './intent-router.js';
import { checkToolPolicyBatch, type ToolCall } from './tool-registry.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ShadowResult {
  /** The input transcript. */
  transcript: string;
  /** Result from Hermes (null if Hermes is unavailable or errored). */
  hermes_result: HermesQueryResponse | null;
  /** Result from Canvas Intelligence. */
  canvas_result: CanvasQueryResult;
  /** Latency in milliseconds for Hermes. */
  hermes_latency_ms: number | null;
  /** Latency in milliseconds for Canvas Intelligence. */
  canvas_latency_ms: number;
  /** Whether the result passed safety constraints. */
  safety_pass: boolean;
  /** Safety check details. */
  safety_detail?: string;
  /** Whether the two results are semantically equivalent. */
  matches: boolean;
  /** Whether clarification was needed. */
  clarification_needed: boolean;
  /** Any error that occurred. */
  error: string | null;
}

export interface CanvasQueryResult {
  intent: string;
  entities: string[];
  tool_calls: ToolCall[];
  clarification_needed: boolean;
  response: string;
  confidence: number;
}

export interface ShadowReport {
  total: number;
  hermes_pass: number;
  canvas_pass: number;
  safety_pass: number;
  average_latency: {
    hermes: number | null;
    canvas: number;
  };
  clarification_rate: number;
  match_rate: number;
  errors: number;
  details: ShadowResult[];
}

export interface ShadowModeRunnerOptions {
  /** Hermes client (null if Hermes is not configured — Canvas Intelligence replaces it). */
  hermesClient: HermesClient | null;
  /** Path to the Hermes corpus directory. Defaults to `tests/hermes/`. */
  corpusPath?: string;
}

// ── Comparison logic ─────────────────────────────────────────────────────────

/**
 * Compare two tool call arrays for semantic equivalence.
 * This is a best-effort comparison that checks tool names and key argument values.
 */
function toolCallsMatch(a: ToolCall[], b: ToolCall[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].tool !== b[i].tool) return false;
    // Compare key arguments
    const aKeys = Object.keys(a[i].arguments).sort();
    const bKeys = Object.keys(b[i].arguments).sort();
    if (JSON.stringify(aKeys) !== JSON.stringify(bKeys)) return false;
    for (const key of aKeys) {
      const aVal = JSON.stringify(a[i].arguments[key]);
      const bVal = JSON.stringify(b[i].arguments[key]);
      if (aVal !== bVal) return false;
    }
  }
  return true;
}

/**
 * Check if a Canvas result matches expected Hermes corpus expectations.
 */
function checkSafety(
  toolCalls: ToolCall[],
  constraints: SafetyConstraints,
): { passed: boolean; detail?: string } {
  // Check no_mutations constraint
  if (constraints.no_mutations && toolCalls.length > 0) {
    const policyResults = checkToolPolicyBatch(toolCalls, constraints);
    const failed = policyResults.find((r) => !r.passed);
    if (failed) {
      return { passed: false, detail: failed.reason };
    }
  }

  // Check entity allowlist
  if (constraints.entity_allowlist && constraints.entity_allowlist.length > 0) {
    for (const tc of toolCalls) {
      const entityId = (tc.arguments as Record<string, unknown>).entity_id as string | undefined;
      if (entityId) {
        const allowed = constraints.entity_allowlist.some((pattern) => {
          if (pattern.endsWith('.*')) {
            const domain = pattern.slice(0, -2);
            return entityId.startsWith(`${domain}.`);
          }
          return entityId === pattern;
        });
        if (!allowed) {
          return { passed: false, detail: `Entity '${entityId}' not in allowlist` };
        }
      }
    }
  }

  // Check max intensity
  if (constraints.max_intensity !== null && constraints.max_intensity !== undefined) {
    for (const tc of toolCalls) {
      const args = tc.arguments as Record<string, unknown>;
      const serviceData = args.service_data as Record<string, unknown> | undefined;
      const brightness = serviceData?.brightness_pct ?? args.brightness_pct;
      if (typeof brightness === 'number' && brightness > constraints.max_intensity) {
        return { passed: false, detail: `Brightness ${brightness}% exceeds max ${constraints.max_intensity}%` };
      }
    }
  }

  return { passed: true };
}

/**
 * Determine if two results are semantically equivalent for comparison purposes.
 */
function resultsMatch(
  hermes: HermesQueryResponse | null,
  canvas: CanvasQueryResult,
): boolean {
  if (!hermes) return false;

  // Compare intents
  if (hermes.intent !== canvas.intent) return false;

  // Compare clarification flags
  if (hermes.clarification_needed !== canvas.clarification_needed) return false;

  // Compare tool calls
  if (!toolCallsMatch(hermes.tool_calls, canvas.tool_calls)) return false;

  // Compare entities (order-independent)
  const hermesEntities = [...hermes.entities].sort();
  const canvasEntities = [...canvas.entities].sort();
  if (JSON.stringify(hermesEntities) !== JSON.stringify(canvasEntities)) return false;

  return true;
}

// ── Runner ───────────────────────────────────────────────────────────────────

export class ShadowModeRunner {
  private readonly hermesClient: HermesClient | null;
  private readonly corpusPath?: string;
  private lastReport: ShadowReport | null = null;

  constructor(opts: ShadowModeRunnerOptions) {
    this.hermesClient = opts.hermesClient;
    this.corpusPath = opts.corpusPath;
  }

  /**
   * Run a single transcript through shadow mode.
   *
   * @param transcript - The user's voice transcript.
   * @returns A `ShadowResult` comparing Hermes and Canvas Intelligence outputs.
   */
  async runSingle(transcript: string): Promise<ShadowResult> {
    // ── Run Canvas Intelligence ──────────────────────────────────────────────
    const canvasStart = performance.now();
    let canvasResult: CanvasQueryResult;
    try {
      const intent = routeIntent(transcript);
      canvasResult = {
        intent: intent.intent,
        entities: intent.entities.map((e) => e.id),
        tool_calls: intent.tool_calls,
        clarification_needed: intent.clarification_needed,
        response: intent.response,
        confidence: intent.confidence,
      };
    } catch (err) {
      return {
        transcript,
        hermes_result: null,
        canvas_result: {
          intent: 'error',
          entities: [],
          tool_calls: [],
          clarification_needed: true,
          response: 'Canvas Intelligence error',
          confidence: 0,
        },
        hermes_latency_ms: null,
        canvas_latency_ms: 0,
        safety_pass: false,
        safety_detail: 'Canvas Intelligence error',
        matches: false,
        clarification_needed: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const canvasLatency = Math.round(performance.now() - canvasStart);

    // ── Run Hermes (if available) ────────────────────────────────────────────
    let hermesResult: HermesQueryResponse | null = null;
    let hermesLatency: number | null = null;
    let error: string | null = null;

    if (this.hermesClient) {
      const hermesStart = performance.now();
      try {
        hermesResult = await this.hermesClient.sendQuery(transcript);
        hermesLatency = Math.round(performance.now() - hermesStart);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        hermesLatency = Math.round(performance.now() - hermesStart);
      }
    } else {
      // Hermes is being replaced by Canvas Intelligence — no error needed
    }

    // ── Compare ──────────────────────────────────────────────────────────────
    const matches = resultsMatch(hermesResult, canvasResult);
    const clarification_needed = canvasResult.clarification_needed;

    return {
      transcript,
      hermes_result: hermesResult,
      canvas_result: canvasResult,
      hermes_latency_ms: hermesLatency,
      canvas_latency_ms: canvasLatency,
      safety_pass: true, // Shadow mode is read-only; safety is checked at the corpus level
      matches,
      clarification_needed,
      error,
    };
  }

  /**
   * Run the full Hermes corpus through shadow mode.
   *
   * @param corpusPath - Optional explicit path to the corpus directory.
   *                     Defaults to `tests/hermes/`.
   * @returns A `ShadowReport` with summary statistics.
   */
  async runCorpus(corpusPath?: string): Promise<ShadowReport> {
    const path = corpusPath ?? this.corpusPath;
    const corpus = loadCorpus(path);

    const details: ShadowResult[] = [];
    let hermesPass = 0;
    let canvasPass = 0;
    let safetyPass = 0;
    let matchCount = 0;
    let clarificationCount = 0;
    let errorCount = 0;
    let totalHermesLatency = 0;
    let hermesCount = 0;
    let totalCanvasLatency = 0;

    for (const testCase of corpus) {
      const result = await this.runSingle(testCase.transcript);

      // Check if Hermes result matches expected corpus intent
      if (result.hermes_result && result.hermes_result.intent === testCase.expected_intent) {
        hermesPass++;
      }

      // Check if Canvas result matches expected corpus intent
      if (result.canvas_result.intent === testCase.expected_intent) {
        canvasPass++;
      }

      // Check safety constraints
      const safetyCheck = checkSafety(result.canvas_result.tool_calls, testCase.safety_constraints);
      if (safetyCheck.passed) {
        safetyPass++;
      }
      result.safety_pass = safetyCheck.passed;
      result.safety_detail = safetyCheck.detail;

      // Track matches
      if (result.matches) matchCount++;

      // Track clarification
      if (result.clarification_needed) clarificationCount++;

      // Track errors
      if (result.error) errorCount++;

      // Track latency
      if (result.hermes_latency_ms !== null) {
        totalHermesLatency += result.hermes_latency_ms;
        hermesCount++;
      }
      totalCanvasLatency += result.canvas_latency_ms;

      details.push(result);
    }

    const report: ShadowReport = {
      total: corpus.length,
      hermes_pass: hermesPass,
      canvas_pass: canvasPass,
      safety_pass: safetyPass,
      average_latency: {
        hermes: hermesCount > 0 ? Math.round(totalHermesLatency / hermesCount) : null,
        canvas: Math.round(totalCanvasLatency / corpus.length),
      },
      clarification_rate: Math.round((clarificationCount / corpus.length) * 100),
      match_rate: Math.round((matchCount / corpus.length) * 100),
      errors: errorCount,
      details,
    };

    this.lastReport = report;
    return report;
  }

  /**
   * Get the last generated shadow report.
   */
  getLastReport(): ShadowReport | null {
    return this.lastReport;
  }

  /**
   * Get the status of the shadow mode runner.
   */
  getStatus(): ShadowModeStatus {
    return {
      active: true,
      hermes_configured: this.hermesClient !== null,
      corpus_size: this.lastReport?.total ?? null,
      last_run: this.lastReport !== null,
    };
  }
}

export interface ShadowModeStatus {
  active: boolean;
  hermes_configured: boolean;
  corpus_size: number | null;
  last_run: boolean;
}