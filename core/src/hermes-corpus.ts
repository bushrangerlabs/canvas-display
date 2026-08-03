/**
 * Hermes corpus loader — loads the 16 approved Hermes test cases from
 * `tests/hermes/` (plan doc §15.6, Phase 6).
 *
 * Each test case captures a real or representative voice transcript, the
 * expected intent, expected tool calls, safety constraints, and clarification
 * expectations. This corpus is the ground truth for shadow-mode comparison
 * between Hermes and Canvas Intelligence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolCallExpectation {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface SafetyConstraints {
  /** True when the operation must NOT mutate state. */
  no_mutations: boolean;
  /** Entity ID glob patterns allowed (e.g. ["light.*", "switch.*"]). */
  entity_allowlist: string[];
  /** Maximum allowed intensity percentage (null = no limit). */
  max_intensity: number | null;
  /** Whether user confirmation is required before execution. */
  require_confirmation?: boolean;
  /** Allowed temperature range [min, max] for climate operations. */
  temperature_range?: [number, number];
}

export interface CorpusCase {
  id: string;
  transcript: string;
  expected_intent: string;
  expected_tool_calls: ToolCallExpectation[];
  safety_constraints: SafetyConstraints;
  expects_clarification: boolean;
  expected_entities: string[];
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * @returns The absolute path to the `tests/hermes/` directory.
 *          Resolved relative to the project root (two levels up from `core/src/`).
 */
function hermesCorpusDir(): string {
  const configuredPath = process.env.CANVAS_CORE_HERMES_CORPUS_PATH;
  if (configuredPath) return resolve(configuredPath);

  const dir = dirname(fileURLToPath(import.meta.url));
  // In dev: core/src/ -> core/ -> project root
  return resolve(dir, '../../tests/hermes');
}

/**
 * Load all Hermes corpus test cases from the `tests/hermes/` directory.
 *
 * @param corpusPath - Optional explicit path to the corpus directory.
 *                     Defaults to `tests/hermes/` relative to project root.
 * @returns An array of parsed `CorpusCase` objects.
 * @throws If the directory does not exist or contains invalid JSON files.
 */
export function loadCorpus(corpusPath?: string): CorpusCase[] {
  const dir = corpusPath ?? hermesCorpusDir();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`Hermes corpus directory not found: ${dir}`);
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (jsonFiles.length === 0) {
    throw new Error(`No JSON files found in Hermes corpus directory: ${dir}`);
  }

  const cases: CorpusCase[] = [];
  for (const file of jsonFiles) {
    const raw = readFileSync(resolve(dir, file), 'utf-8');
    try {
      const parsed = JSON.parse(raw) as CorpusCase & { id?: string; transcript?: string };
      // Validate required fields
      if (!parsed.id || !parsed.transcript) {
        throw new Error(`Missing required field 'id' or 'transcript' in ${file}`);
      }
      if (!parsed.expected_intent) {
        throw new Error(`Missing required field 'expected_intent' in ${file}`);
      }
      if (!Array.isArray(parsed.expected_tool_calls)) {
        throw new Error(`Missing or invalid 'expected_tool_calls' in ${file}`);
      }
      if (!parsed.safety_constraints) {
        throw new Error(`Missing required field 'safety_constraints' in ${file}`);
      }
      cases.push(parsed as CorpusCase);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse corpus file ${file}: ${message}`);
    }
  }

  return cases;
}

/**
 * Load a single Hermes corpus test case by ID.
 *
 * @param id - The case ID (e.g. "001-turn-on-light").
 * @param corpusPath - Optional explicit path to the corpus directory.
 * @returns The matching `CorpusCase`, or `undefined` if not found.
 */
export function loadCorpusCase(id: string, corpusPath?: string): CorpusCase | undefined {
  return loadCorpus(corpusPath).find((c) => c.id === id);
}
