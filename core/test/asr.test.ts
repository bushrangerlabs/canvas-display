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

test('WhisperTranscription.setModel switches the model sent on the next request', async () => {
  const forms: FormData[] = [];
  const fetchImpl: FetchImpl = mockFetch((_url, init) => {
    forms.push(init?.body as FormData);
    return jsonResponse({ text: 'ok' });
  });
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  await asr.transcribe(Buffer.from('x'));
  asr.setModel('Systran/faster-whisper-small.en');
  await asr.transcribe(Buffer.from('x'));
  assert.equal(forms[0].get('model'), 'Systran/faster-whisper-base.en');
  assert.equal(forms[1].get('model'), 'Systran/faster-whisper-small.en');
  // Clearing reverts to the default model.
  asr.setModel(undefined);
  await asr.transcribe(Buffer.from('x'));
  assert.equal(forms[2].get('model'), 'Systran/faster-whisper-base.en');
});

test('WhisperTranscription.healthCheck reflects /health', async () => {
  const fetchImpl = mockFetch(() => new Response('OK', { status: 200 }));
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  const h = await asr.healthCheck();
  assert.equal(h.healthy, true);
  assert.equal(h.kind, 'WhisperTranscription');
});

test('WhisperTranscription.listModels returns sorted model ids from /v1/models', async () => {
  let capturedUrl = '';
  const fetchImpl: FetchImpl = mockFetch((url) => {
    capturedUrl = url;
    return jsonResponse({ object: 'list', data: [{ id: 'small.en' }, { id: 'Systran/faster-whisper-base.en' }] });
  });
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper/', fetchImpl });
  const models = await asr.listModels();
  assert.ok(capturedUrl.endsWith('/v1/models'), 'correct endpoint');
  assert.deepEqual(models, ['Systran/faster-whisper-base.en', 'small.en']);
});

test('WhisperTranscription.listModels throws on error status', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({ detail: 'nope' }, 500));
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  await assert.rejects(() => asr.listModels(), /ASR models 500/);
});

test('WhisperTranscription.downloadModel posts to the path form when supported', async () => {
  let capturedUrl = '';
  let capturedMethod = '';
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    capturedUrl = url;
    capturedMethod = init?.method ?? '';
    return new Response('', { status: 200 });
  });
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  await asr.downloadModel('Systran/faster-whisper-small.en');
  assert.equal(capturedMethod, 'POST');
  // HuggingFace-style ids keep their `/` separators in the path.
  assert.ok(capturedUrl.endsWith('/v1/models/Systran/faster-whisper-small.en'), capturedUrl);
});

test('WhisperTranscription.downloadModel falls back to the body form on 404', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: FetchImpl = mockFetch((url, init) => {
    calls.push({ url, method: init?.method ?? '', body: init?.body as string | undefined });
    return calls.length === 1 ? new Response('', { status: 404 }) : new Response('', { status: 200 });
  });
  const asr = new WhisperTranscription({ baseUrl: 'http://whisper', fetchImpl });
  await asr.downloadModel('small.en');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/v1/models/small.en'));
  assert.ok(calls[1].url.endsWith('/v1/models'));
  assert.equal(calls[1].body, JSON.stringify({ model: 'small.en' }));
});
