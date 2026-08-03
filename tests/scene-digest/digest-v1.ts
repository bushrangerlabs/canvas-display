import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export type SceneDigestErrorCode =
  | 'invalid_json'
  | 'duplicate_key'
  | 'invalid_unicode'
  | 'invalid_number'
  | 'invalid_manifest'
  | 'missing_digest'
  | 'invalid_digest'
  | 'digest_mismatch';

export class SceneDigestError extends Error {
  readonly code: SceneDigestErrorCode;

  constructor(code: SceneDigestErrorCode, message: string) {
    super(message);
    this.name = 'SceneDigestError';
    this.code = code;
  }
}

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type RawJson = string | Uint8Array;

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function decodeRawJson(rawJson: RawJson): string {
  if (typeof rawJson === 'string') {
    return rawJson;
  }

  try {
    return UTF8_DECODER.decode(rawJson);
  } catch {
    throw new SceneDigestError('invalid_unicode', 'Scene manifest JSON must be valid UTF-8.');
  }
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SceneDigestError('invalid_unicode', 'Scene manifest strings cannot contain unpaired UTF-16 surrogates.');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new SceneDigestError('invalid_unicode', 'Scene manifest strings cannot contain unpaired UTF-16 surrogates.');
    }
  }
}

class StrictJsonParser {
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): JsonValue {
    this.#skipWhitespace();
    if (this.#index === this.#source.length) {
      this.#fail('invalid_json', 'Scene manifest JSON cannot be empty');
    }

    const value = this.#parseValue();
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      this.#fail('invalid_json', 'Unexpected data after the top-level JSON value');
    }
    return value;
  }

  #parseValue(): JsonValue {
    const token = this.#source[this.#index];
    switch (token) {
      case '{':
        return this.#parseObject();
      case '[':
        return this.#parseArray();
      case '"':
        return this.#parseString();
      case 't':
        return this.#parseLiteral('true', true);
      case 'f':
        return this.#parseLiteral('false', false);
      case 'n':
        return this.#parseLiteral('null', null);
      default:
        if (token === '-' || (token >= '0' && token <= '9')) {
          return this.#parseNumber();
        }
        this.#fail('invalid_json', 'Expected a JSON value');
    }
  }

  #parseObject(): JsonObject {
    this.#index += 1;
    this.#skipWhitespace();

    const object = Object.create(null) as JsonObject;
    const keys = new Set<string>();
    if (this.#consume('}')) {
      return object;
    }

    while (true) {
      if (this.#source[this.#index] !== '"') {
        this.#fail('invalid_json', 'Expected an object member name');
      }
      const key = this.#parseString();
      if (keys.has(key)) {
        this.#fail('duplicate_key', `Duplicate object member name ${JSON.stringify(key)}`);
      }
      keys.add(key);

      this.#skipWhitespace();
      if (!this.#consume(':')) {
        this.#fail('invalid_json', 'Expected a colon after an object member name');
      }
      this.#skipWhitespace();
      object[key] = this.#parseValue();
      this.#skipWhitespace();

      if (this.#consume('}')) {
        return object;
      }
      if (!this.#consume(',')) {
        this.#fail('invalid_json', 'Expected a comma or closing brace in an object');
      }
      this.#skipWhitespace();
    }
  }

  #parseArray(): JsonValue[] {
    this.#index += 1;
    this.#skipWhitespace();

    const array: JsonValue[] = [];
    if (this.#consume(']')) {
      return array;
    }

    while (true) {
      array.push(this.#parseValue());
      this.#skipWhitespace();
      if (this.#consume(']')) {
        return array;
      }
      if (!this.#consume(',')) {
        this.#fail('invalid_json', 'Expected a comma or closing bracket in an array');
      }
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#index;
    this.#index += 1;

    while (this.#index < this.#source.length) {
      const codeUnit = this.#source.charCodeAt(this.#index);
      if (codeUnit === 0x22) {
        this.#index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.#source.slice(start, this.#index));
        } catch {
          this.#fail('invalid_json', 'Invalid JSON string');
        }
        if (typeof value !== 'string') {
          this.#fail('invalid_json', 'Invalid JSON string');
        }
        assertValidUnicode(value);
        return value;
      }

      if (codeUnit < 0x20) {
        this.#fail('invalid_json', 'Unescaped control character in a JSON string');
      }

      if (codeUnit === 0x5c) {
        const escape = this.#source[this.#index + 1];
        if (escape === 'u') {
          const hex = this.#source.slice(this.#index + 2, this.#index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.#fail('invalid_json', 'Invalid Unicode escape in a JSON string');
          }
          this.#index += 6;
          continue;
        }
        if (escape === '"' || escape === '\\' || escape === '/' || escape === 'b' || escape === 'f' || escape === 'n' || escape === 'r' || escape === 't') {
          this.#index += 2;
          continue;
        }
        this.#fail('invalid_json', 'Invalid escape in a JSON string');
      }

      this.#index += 1;
    }

    this.#fail('invalid_json', 'Unterminated JSON string');
  }

  #parseNumber(): number {
    const start = this.#index;
    if (this.#source[this.#index] === '-') {
      this.#index += 1;
    }

    if (this.#source[this.#index] === '0') {
      this.#index += 1;
    } else if (this.#isDigitOneToNine(this.#source[this.#index])) {
      this.#index += 1;
      while (this.#isDigit(this.#source[this.#index])) {
        this.#index += 1;
      }
    } else {
      this.#fail('invalid_json', 'Invalid JSON number');
    }

    let integerSyntax = true;
    if (this.#source[this.#index] === '.') {
      integerSyntax = false;
      this.#index += 1;
      if (!this.#isDigit(this.#source[this.#index])) {
        this.#fail('invalid_json', 'Invalid JSON number fraction');
      }
      while (this.#isDigit(this.#source[this.#index])) {
        this.#index += 1;
      }
    }

    if (this.#source[this.#index] === 'e' || this.#source[this.#index] === 'E') {
      integerSyntax = false;
      this.#index += 1;
      if (this.#source[this.#index] === '+' || this.#source[this.#index] === '-') {
        this.#index += 1;
      }
      if (!this.#isDigit(this.#source[this.#index])) {
        this.#fail('invalid_json', 'Invalid JSON number exponent');
      }
      while (this.#isDigit(this.#source[this.#index])) {
        this.#index += 1;
      }
    }

    const token = this.#source.slice(start, this.#index);
    const value = Number(token);
    if (!integerSyntax || !Number.isSafeInteger(value)) {
      this.#fail('invalid_number', `Scene manifest number ${token} is not a safe integer`);
    }
    return value;
  }

  #parseLiteral<T extends JsonPrimitive>(token: string, value: T): T {
    if (!this.#source.startsWith(token, this.#index)) {
      this.#fail('invalid_json', `Invalid JSON token; expected ${token}`);
    }
    this.#index += token.length;
    return value;
  }

  #skipWhitespace(): void {
    while (
      this.#source[this.#index] === ' ' ||
      this.#source[this.#index] === '\n' ||
      this.#source[this.#index] === '\r' ||
      this.#source[this.#index] === '\t'
    ) {
      this.#index += 1;
    }
  }

  #consume(token: string): boolean {
    if (this.#source[this.#index] !== token) {
      return false;
    }
    this.#index += 1;
    return true;
  }

  #isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '0' && value <= '9';
  }

  #isDigitOneToNine(value: string | undefined): boolean {
    return value !== undefined && value >= '1' && value <= '9';
  }

  #fail(code: SceneDigestErrorCode, message: string): never {
    throw new SceneDigestError(code, `${message} at character ${this.#index}.`);
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateBoundedInteger(
  object: JsonObject,
  field: string,
  path: string,
  minimum: number,
  maximum: number,
): void {
  const value = object[field];
  if (typeof value === 'number' && (value < minimum || value > maximum)) {
    throw new SceneDigestError(
      'invalid_number',
      `${path} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function validateSceneNumericBounds(manifest: JsonObject): void {
  validateBoundedInteger(manifest, 'schema_version', 'schema_version', 1, 1);
  validateBoundedInteger(manifest, 'revision_number', 'revision_number', 1, MAX_SAFE_INTEGER);

  const canvas = manifest.canvas;
  if (isJsonObject(canvas)) {
    validateBoundedInteger(canvas, 'width', 'canvas.width', 1, 16_384);
    validateBoundedInteger(canvas, 'height', 'canvas.height', 1, 16_384);
  }

  const document = manifest.document;
  if (isJsonObject(document)) {
    validateBoundedInteger(document, 'size', 'document.size', 1, 268_435_456);
  }

  if (Array.isArray(manifest.assets)) {
    manifest.assets.forEach((asset, index) => {
      if (isJsonObject(asset)) {
        validateBoundedInteger(asset, 'size', `assets[${index}].size`, 1, 268_435_456);
      }
    });
  }

  const offline = manifest.offline;
  if (isJsonObject(offline)) {
    validateBoundedInteger(offline, 'max_stale_seconds', 'offline.max_stale_seconds', 0, 31_536_000);
  }
}

export function parseSafeIntegerIJson(rawJson: RawJson): JsonValue {
  return new StrictJsonParser(decodeRawJson(rawJson)).parse();
}

function parseSceneManifest(rawJson: RawJson): JsonObject {
  const value = parseSafeIntegerIJson(rawJson);
  if (!isJsonObject(value)) {
    throw new SceneDigestError('invalid_manifest', 'A Scene Manifest v1 value must be a JSON object.');
  }
  validateSceneNumericBounds(value);
  return value;
}

export function canonicalizeSafeIntegerJsonValue(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new SceneDigestError('invalid_number', 'Scene Manifest v1 canonicalization only supports safe integers.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeSafeIntegerJsonValue(item)).join(',')}]`;
  }

  const members = Object.keys(value)
    .sort()
    .map((key) => `${canonicalizeSafeIntegerJsonValue(key)}:${canonicalizeSafeIntegerJsonValue(value[key])}`);
  return `{${members.join(',')}}`;
}

function canonicalizeParsedManifest(manifest: JsonObject): string {
  const members = Object.keys(manifest)
    .filter((key) => key !== 'manifest_digest')
    .sort()
    .map((key) => `${canonicalizeSafeIntegerJsonValue(key)}:${canonicalizeSafeIntegerJsonValue(manifest[key])}`);
  return `{${members.join(',')}}`;
}

function digestParsedManifest(manifest: JsonObject): string {
  const canonical = canonicalizeParsedManifest(manifest);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Canonicalizes the Scene Manifest v1 digest payload. This intentionally supports
 * the schema's safe-integer subset of RFC 8785 rather than general JCS numbers.
 */
export function canonicalizeSceneManifestV1(rawJson: RawJson): string {
  return canonicalizeParsedManifest(parseSceneManifest(rawJson));
}

export function computeSceneManifestDigestV1(rawJson: RawJson): string {
  return digestParsedManifest(parseSceneManifest(rawJson));
}

/** Strictly parses and verifies a raw Scene Manifest v1 JSON payload. */
export function verifySceneManifestDigestV1(rawJson: RawJson): JsonObject {
  const manifest = parseSceneManifest(rawJson);
  const suppliedDigest = manifest.manifest_digest;
  if (suppliedDigest === undefined) {
    throw new SceneDigestError('missing_digest', 'Scene manifest is missing top-level manifest_digest.');
  }
  if (typeof suppliedDigest !== 'string' || !SHA256_DIGEST_PATTERN.test(suppliedDigest)) {
    throw new SceneDigestError(
      'invalid_digest',
      'Scene manifest_digest must use lowercase sha256:<64 lowercase hex characters>.',
    );
  }

  const computedDigest = digestParsedManifest(manifest);
  if (suppliedDigest !== computedDigest) {
    throw new SceneDigestError(
      'digest_mismatch',
      `Scene manifest digest mismatch: supplied ${suppliedDigest}, computed ${computedDigest}.`,
    );
  }
  return manifest;
}
