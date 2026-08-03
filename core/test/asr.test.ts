import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhisperTranscription } from '../src/providers/asr.js';
import { mockFetch, jsonResponse } from './helpers.js';
import type { FetchImpl } from '../src/providers/llm.js';

test('WhisperTranscription.transcribe posts audio and returns transcript text', async () => {
  let capturedUrl = '';
  let capturedForm: FormData | undefined;
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedForm = init?.body as FormData;
    return jsonResponse({ text: 'turn on the kitchen lights' });
  });
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  const out = await asr.transcribe(Buffer.from('RIFF....'), 'audio/wav');
  assert.equal(out, 'turn on the kitchen lights');
  assert.ok(capturedUrl.endsWith('/v1/audio/transcriptions'), 'correct endpoint');
  assert.ok(capturedForm instanceof FormData, 'sent multipart form');
  // The form must carry the file + model + response_format fields.
  assert.equal(capturedForm?.get('model'), 'Systran/faster-whisper-base.en');
  assert.equal(capturedForm?.get('response_format'), 'json');
  assert.ok(capturedForm?.has('file'));
});

test('WhisperTranscription throws on ASR error status', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({ detail: 'no model' }, 400));
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  await assert.rejects(() => asr.transcribe(Buffer.from('x')));
});

test('WhisperTranscription.healthCheck reflects /health', async () => {
  const fetchImpl = mockFetch(() => new Response('OK', { status: 200 }));
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  const h = await asr.healthCheck();
  assert.equal(h.healthy, true);
  assert.equal(h.kind, 'WhisperTranscription');
});
