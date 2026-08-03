import assert from 'node:assert/strict';
import test from 'node:test';
import { commandRequestDigest } from '../src/gateway.js';

test('diagnostics.echo request digest matches the frozen cross-language fixture', () => {
  assert.equal(
    commandRequestDigest('diagnostics.echo', 1, { message: 'hello edge' }),
    'sha256:14936abe504f227d7748780024d679125eadb53c069397bcd5f61fca698c1c4f',
  );
});

