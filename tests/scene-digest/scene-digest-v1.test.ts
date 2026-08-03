import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  canonicalizeSceneManifestV1,
  computeSceneManifestDigestV1,
  SceneDigestError,
  type SceneDigestErrorCode,
  verifySceneManifestDigestV1,
} from './digest-v1.js';

interface DigestVector {
  name: string;
  file: string;
  expected_digest: string;
  expected_canonical?: string;
  expected_error?: SceneDigestErrorCode;
}

interface InvalidVector {
  name: string;
  file: string;
  expected_error: SceneDigestErrorCode;
}

interface SharedVectors {
  schema_version: 1;
  valid: DigestVector[];
  mismatch: DigestVector[];
  invalid: InvalidVector[];
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDirectory = join(repositoryRoot, 'contracts/scene/v1/fixtures/canonicalization');
const basicScenePath = join(repositoryRoot, 'contracts/scene/v1/fixtures/valid/basic-scene.json');
const basicDigest = 'sha256:b55c6f69f62c6116bfb9e70fc13304162ef8aca655fa94bbfe88fb13527bd390';
const vectors = JSON.parse(readFileSync(join(fixtureDirectory, 'vectors.json'), 'utf8')) as SharedVectors;

function readVector(file: string): Buffer {
  return readFileSync(join(fixtureDirectory, file));
}

function assertDigestError(action: () => unknown, expectedCode: SceneDigestErrorCode, context: string): void {
  assert.throws(action, (error: unknown) => {
    assert(error instanceof SceneDigestError, `${context}: expected SceneDigestError`);
    assert.equal(error.code, expectedCode, context);
    return true;
  });
}

test('existing valid basic-scene manifest has its frozen canonical digest', () => {
  const raw = readFileSync(basicScenePath);
  assert.equal(computeSceneManifestDigestV1(raw), basicDigest);
  const verified = verifySceneManifestDigestV1(raw);
  assert.equal(verified.manifest_digest, basicDigest);
});

test('shared valid vectors canonicalize and verify identically', () => {
  for (const vector of vectors.valid) {
    const raw = readVector(vector.file);
    assert.equal(computeSceneManifestDigestV1(raw), vector.expected_digest, vector.name);
    assert.equal(verifySceneManifestDigestV1(raw).manifest_digest, vector.expected_digest, vector.name);
    if (vector.expected_canonical !== undefined) {
      assert.equal(canonicalizeSceneManifestV1(raw), vector.expected_canonical, vector.name);
    }
  }

  const reordered = vectors.valid.find((vector) => vector.name === 'key-order-and-whitespace-invariance');
  assert(reordered);
  assert.equal(
    canonicalizeSceneManifestV1(readVector(reordered.file)),
    canonicalizeSceneManifestV1(readFileSync(basicScenePath)),
  );

  const unicode = vectors.valid.find((vector) => vector.name === 'unicode-string-handling');
  assert(unicode);
  const unicodeCanonical = canonicalizeSceneManifestV1(readVector(unicode.file));
  assert(unicodeCanonical.includes('夜空 🌌 — café'));
  assert(unicodeCanonical.includes('line\\ncontrol:\\u000f'));
});

test('array reordering and field mutation change the digest and reject stale embedded digests', () => {
  for (const vector of vectors.mismatch) {
    const raw = readVector(vector.file);
    assert.equal(computeSceneManifestDigestV1(raw), vector.expected_digest, vector.name);
    assert.notEqual(vector.expected_digest, basicDigest, vector.name);
    assertDigestError(
      () => verifySceneManifestDigestV1(raw),
      vector.expected_error ?? 'digest_mismatch',
      vector.name,
    );
  }
});

test('shared invalid raw inputs are rejected before digest comparison', () => {
  for (const vector of vectors.invalid) {
    assertDigestError(
      () => computeSceneManifestDigestV1(readVector(vector.file)),
      vector.expected_error,
      vector.name,
    );
  }
});

test('strict parsing rejects invalid UTF-8 and duplicate names after escape decoding', () => {
  assertDigestError(
    () => computeSceneManifestDigestV1(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])),
    'invalid_unicode',
    'invalid UTF-8',
  );
  assertDigestError(
    () => computeSceneManifestDigestV1('{"manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","a":1,"\\u0061":2}'),
    'duplicate_key',
    'escape-equivalent duplicate key',
  );
});

test('verification requires the lowercase sha256 digest encoding', () => {
  const uppercaseDigest = readFileSync(basicScenePath, 'utf8').replace(basicDigest, basicDigest.toUpperCase());
  assertDigestError(
    () => verifySceneManifestDigestV1(uppercaseDigest),
    'invalid_digest',
    'uppercase digest encoding',
  );
});

test('object keys use RFC 8785 UTF-16 code-unit ordering', () => {
  const raw = String.raw`{"manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","\uE000":1,"\uD83D\uDE00":2}`;
  assert.equal(canonicalizeSceneManifestV1(raw), '{"😀":2,"":1}');
});
