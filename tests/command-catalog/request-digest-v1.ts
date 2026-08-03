import { createHash } from 'node:crypto';
import {
  canonicalizeSafeIntegerJsonValue,
  parseSafeIntegerIJson,
  SceneDigestError,
  type JsonObject,
  type JsonValue,
  type RawJson,
} from '../scene-digest/digest-v1.js';

export type CommandRequestDigestErrorCode =
  | 'invalid_json'
  | 'duplicate_key'
  | 'invalid_unicode'
  | 'invalid_number'
  | 'invalid_request';

export class CommandRequestDigestError extends Error {
  constructor(
    readonly code: CommandRequestDigestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CommandRequestDigestError';
  }
}

export interface CommandRequestDigestInput extends JsonObject {
  kind: string;
  semantic_version: number;
  parameters: JsonObject;
  preconditions: JsonObject;
}

const REQUIRED_FIELDS = ['kind', 'parameters', 'preconditions', 'semantic_version'] as const;
const KIND_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRequest(rawJson: RawJson): CommandRequestDigestInput {
  let parsed: JsonValue;
  try {
    parsed = parseSafeIntegerIJson(rawJson);
  } catch (error) {
    if (error instanceof SceneDigestError) {
      const code = error.code === 'invalid_manifest' || error.code === 'missing_digest' || error.code === 'invalid_digest' || error.code === 'digest_mismatch'
        ? 'invalid_request'
        : error.code;
      throw new CommandRequestDigestError(code, error.message);
    }
    throw error;
  }

  if (!isJsonObject(parsed)) {
    throw new CommandRequestDigestError('invalid_request', 'Command request digest input must be an object.');
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== REQUIRED_FIELDS.length || keys.some((key, index) => key !== REQUIRED_FIELDS[index])) {
    throw new CommandRequestDigestError(
      'invalid_request',
      `Command request digest input must contain exactly: ${REQUIRED_FIELDS.join(', ')}.`,
    );
  }

  if (typeof parsed.kind !== 'string' || !KIND_PATTERN.test(parsed.kind)) {
    throw new CommandRequestDigestError('invalid_request', 'Command kind must be a lowercase namespaced token.');
  }
  if (!Number.isSafeInteger(parsed.semantic_version) || Number(parsed.semantic_version) < 1) {
    throw new CommandRequestDigestError('invalid_request', 'semantic_version must be a positive safe integer.');
  }
  if (!isJsonObject(parsed.parameters) || !isJsonObject(parsed.preconditions)) {
    throw new CommandRequestDigestError('invalid_request', 'parameters and preconditions must be JSON objects.');
  }

  return parsed as CommandRequestDigestInput;
}

export function canonicalizeCommandRequestV1(rawJson: RawJson): string {
  return canonicalizeSafeIntegerJsonValue(parseRequest(rawJson));
}

export function computeCommandRequestDigestV1(rawJson: RawJson): string {
  return `sha256:${createHash('sha256').update(canonicalizeCommandRequestV1(rawJson), 'utf8').digest('hex')}`;
}

export function computeCommandRequestDigestFromParts(input: {
  kind: string;
  semanticVersion: number;
  parameters: JsonObject;
  preconditions?: JsonObject;
}): string {
  const request: CommandRequestDigestInput = {
    kind: input.kind,
    semantic_version: input.semanticVersion,
    parameters: input.parameters,
    preconditions: input.preconditions ?? {},
  };
  return computeCommandRequestDigestV1(JSON.stringify(request));
}
