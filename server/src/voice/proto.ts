/**
 * Minimal hand-written protobuf encoder/decoder for the ESPHome Voice
 * Assistant protocol. Covers only the messages we actually use — avoids
 * adding protobufjs as a dependency that complicates pkg bundling.
 *
 * Wire types:
 *   0 = varint (bool, uint32, int32, enum)
 *   2 = length-delimited (string, bytes, embedded message, repeated)
 *   5 = 32-bit (fixed32)
 *
 * Field tag = (field_number << 3) | wire_type
 */

// ── Varint helpers ─────────────────────────────────────────────────────────

export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0; // treat as unsigned 32-bit
  while (v > 127) {
    bytes.push((v & 0x7f) | 0x80);
    v = v >>> 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

/** Returns [value, bytesConsumed] */
export function decodeVarint(buf: Buffer, offset = 0): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift >= 32) throw new Error('varint too long');
  }
  return [result >>> 0, i - offset];
}

// ── Low-level field encoder ────────────────────────────────────────────────

function fieldTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

export function encodeVarintField(fieldNumber: number, value: number): Buffer {
  if (value === 0) return Buffer.alloc(0); // default value — omit
  return Buffer.concat([fieldTag(fieldNumber, 0), encodeVarint(value)]);
}

export function encodeBoolField(fieldNumber: number, value: boolean): Buffer {
  if (!value) return Buffer.alloc(0);
  return Buffer.concat([fieldTag(fieldNumber, 0), Buffer.from([1])]);
}

export function encodeStringField(fieldNumber: number, value: string): Buffer {
  if (!value) return Buffer.alloc(0);
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([fieldTag(fieldNumber, 2), encodeVarint(encoded.length), encoded]);
}

export function encodeBytesField(fieldNumber: number, value: Buffer): Buffer {
  if (!value || value.length === 0) return Buffer.alloc(0);
  return Buffer.concat([fieldTag(fieldNumber, 2), encodeVarint(value.length), value]);
}

export function encodeEmbeddedMessage(fieldNumber: number, msg: Buffer): Buffer {
  if (!msg || msg.length === 0) return Buffer.alloc(0);
  return Buffer.concat([fieldTag(fieldNumber, 2), encodeVarint(msg.length), msg]);
}

// ── Low-level field decoder ────────────────────────────────────────────────

export interface RawField {
  fieldNumber: number;
  wireType: number;
  /** For wire type 0 (varint) */
  varintValue?: number;
  /** For wire type 2 (length-delimited) */
  bytesValue?: Buffer;
  /** For wire type 5 (32-bit) */
  fixed32Value?: number;
}

export function decodeFields(buf: Buffer): RawField[] {
  const fields: RawField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const [tag, tagLen] = decodeVarint(buf, offset);
    offset += tagLen;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    if (wireType === 0) {
      const [value, vLen] = decodeVarint(buf, offset);
      offset += vLen;
      fields.push({ fieldNumber, wireType, varintValue: value });
    } else if (wireType === 2) {
      const [len, lLen] = decodeVarint(buf, offset);
      offset += lLen;
      const bytesValue = buf.slice(offset, offset + len);
      offset += len;
      fields.push({ fieldNumber, wireType, bytesValue });
    } else if (wireType === 5) {
      const fixed32Value = buf.readUInt32LE(offset);
      offset += 4;
      fields.push({ fieldNumber, wireType, fixed32Value });
    } else {
      throw new Error(`Unsupported wire type ${wireType} at offset ${offset}`);
    }
  }
  return fields;
}

function getString(fields: RawField[], fieldNumber: number): string {
  const f = fields.find(f => f.fieldNumber === fieldNumber && f.wireType === 2);
  return f?.bytesValue ? f.bytesValue.toString('utf8') : '';
}

function getUint32(fields: RawField[], fieldNumber: number): number {
  const f = fields.find(f => f.fieldNumber === fieldNumber && f.wireType === 0);
  return f?.varintValue ?? 0;
}

function getBool(fields: RawField[], fieldNumber: number): boolean {
  const f = fields.find(f => f.fieldNumber === fieldNumber && f.wireType === 0);
  return (f?.varintValue ?? 0) !== 0;
}

function getBytes(fields: RawField[], fieldNumber: number): Buffer {
  const f = fields.find(f => f.fieldNumber === fieldNumber && f.wireType === 2);
  return f?.bytesValue ?? Buffer.alloc(0);
}

// ── Message type IDs ───────────────────────────────────────────────────────

export const MSG = {
  HELLO_REQUEST: 1,
  HELLO_RESPONSE: 2,
  DISCONNECT_REQUEST: 5,
  DISCONNECT_RESPONSE: 6,
  PING_REQUEST: 7,
  PING_RESPONSE: 8,
  DEVICE_INFO_REQUEST: 9,
  DEVICE_INFO_RESPONSE: 10,
  LIST_ENTITIES_REQUEST: 11,
  LIST_ENTITIES_DONE_RESPONSE: 19,
  SUBSCRIBE_STATES_REQUEST: 20,
  SUBSCRIBE_VOICE_ASSISTANT_REQUEST: 89,
  VOICE_ASSISTANT_REQUEST: 90,
  VOICE_ASSISTANT_RESPONSE: 91,
  VOICE_ASSISTANT_EVENT_RESPONSE: 92,
  VOICE_ASSISTANT_AUDIO: 106,
  VOICE_ASSISTANT_TIMER_EVENT_RESPONSE: 115,
  VOICE_ASSISTANT_ANNOUNCE_REQUEST: 119,
  VOICE_ASSISTANT_ANNOUNCE_FINISHED: 120,
  VOICE_ASSISTANT_CONFIGURATION_REQUEST: 121,
  VOICE_ASSISTANT_CONFIGURATION_RESPONSE: 122,
} as const;

// ── Voice assistant feature flags ──────────────────────────────────────────

export const VA_FEATURE = {
  SUPPORTS_WAKE_WORD: 1 << 0,            // = 1
  SUPPORTS_START_CONVERSATION: 1 << 1,   // = 2
  SUPPORTS_ANNOUNCE: 1 << 2,             // = 4
} as const;

export const VA_SUBSCRIBE_FLAG = {
  API_AUDIO: 1,  // audio over the API TCP connection instead of UDP
} as const;

export const VA_REQUEST_FLAG = {
  USE_VAD: 1,       // HA handles voice activity detection
  USE_WAKE_WORD: 2, // HA handles wake word detection
} as const;

export const VA_EVENT = {
  ERROR: 0,
  RUN_START: 1,
  RUN_END: 2,
  STT_START: 3,
  STT_END: 4,
  INTENT_START: 5,
  INTENT_END: 6,
  TTS_START: 7,
  TTS_END: 8,
  WAKE_WORD_START: 9,
  WAKE_WORD_END: 10,
  STT_VAD_START: 11,
  STT_VAD_END: 12,
  TTS_STREAM_START: 98,
  TTS_STREAM_END: 99,
  INTENT_PROGRESS: 100,
} as const;

// ── Decoded message types ──────────────────────────────────────────────────

export interface HelloRequest {
  clientInfo: string;
  apiVersionMajor: number;
  apiVersionMinor: number;
}

export interface SubscribeVoiceAssistantRequest {
  subscribe: boolean;
  flags: number; // VA_SUBSCRIBE_FLAG bitmask
}

export interface VoiceAssistantResponse {
  port: number;
  error: boolean;
}

export interface VoiceAssistantEventData {
  name: string;
  value: string;
}

export interface VoiceAssistantEvent {
  eventType: number; // VA_EVENT
  data: VoiceAssistantEventData[];
}

export interface VoiceAssistantAudio {
  data: Buffer;
  end: boolean;
}

export interface VoiceAssistantAnnounceRequest {
  mediaId: string;
  text: string;
  preannounceMediaId: string;
  startConversation: boolean;
}

// ── Decoders ──────────────────────────────────────────────────────────────

export function decodeHelloRequest(buf: Buffer): HelloRequest {
  const fields = decodeFields(buf);
  return {
    clientInfo: getString(fields, 1),
    apiVersionMajor: getUint32(fields, 2),
    apiVersionMinor: getUint32(fields, 3),
  };
}

export function decodeSubscribeVoiceAssistantRequest(buf: Buffer): SubscribeVoiceAssistantRequest {
  const fields = decodeFields(buf);
  return {
    subscribe: getBool(fields, 1),
    flags: getUint32(fields, 2),
  };
}

export function decodeVoiceAssistantResponse(buf: Buffer): VoiceAssistantResponse {
  const fields = decodeFields(buf);
  return {
    port: getUint32(fields, 1),
    error: getBool(fields, 2),
  };
}

export function decodeVoiceAssistantEvent(buf: Buffer): VoiceAssistantEvent {
  const fields = decodeFields(buf);
  const data: VoiceAssistantEventData[] = [];
  for (const f of fields.filter(f => f.fieldNumber === 2 && f.wireType === 2)) {
    if (f.bytesValue) {
      const innerFields = decodeFields(f.bytesValue);
      data.push({
        name: getString(innerFields, 1),
        value: getString(innerFields, 2),
      });
    }
  }
  return {
    eventType: getUint32(fields, 1),
    data,
  };
}

export function decodeVoiceAssistantAudio(buf: Buffer): VoiceAssistantAudio {
  const fields = decodeFields(buf);
  return {
    data: getBytes(fields, 1),
    end: getBool(fields, 2),
  };
}

export function decodeVoiceAssistantAnnounceRequest(buf: Buffer): VoiceAssistantAnnounceRequest {
  const fields = decodeFields(buf);
  return {
    mediaId: getString(fields, 1),
    text: getString(fields, 2),
    preannounceMediaId: getString(fields, 3),
    startConversation: getBool(fields, 4),
  };
}

// ── Encoders ───────────────────────────────────────────────────────────────

export function encodeHelloResponse(serverInfo: string, name: string): Buffer {
  return Buffer.concat([
    encodeVarintField(1, 1),  // api_version_major = 1
    encodeVarintField(2, 10), // api_version_minor = 10
    encodeStringField(3, serverInfo),
    encodeStringField(4, name),
  ]);
}

export function encodeDeviceInfoResponse(opts: {
  name: string;
  macAddress: string;
  friendlyName: string;
  voiceAssistantFeatureFlags: number;
}): Buffer {
  return Buffer.concat([
    encodeStringField(2, opts.name),
    encodeStringField(3, opts.macAddress),
    encodeStringField(4, '2024.11.0'),     // esphome_version — any recent value
    encodeStringField(6, 'Canvas Display'), // model
    encodeStringField(12, 'BushrangerLabs'), // manufacturer
    encodeStringField(13, opts.friendlyName),
    encodeVarintField(17, opts.voiceAssistantFeatureFlags),
  ]);
}

/** Empty message (ListEntitiesDoneResponse, PingResponse, DisconnectResponse) */
export function encodeEmpty(): Buffer {
  return Buffer.alloc(0);
}

export function encodeVoiceAssistantRequest(opts: {
  start: boolean;
  conversationId?: string;
  flags: number; // VA_REQUEST_FLAG bitmask
}): Buffer {
  return Buffer.concat([
    encodeBoolField(1, opts.start),
    encodeStringField(2, opts.conversationId ?? ''),
    encodeVarintField(3, opts.flags),
  ]);
}

export function encodeVoiceAssistantAudio(data: Buffer, end = false): Buffer {
  return Buffer.concat([
    encodeBytesField(1, data),
    encodeBoolField(2, end),
  ]);
}

export function encodeVoiceAssistantAnnounceFinished(success: boolean): Buffer {
  return Buffer.concat([encodeBoolField(1, success)]);
}

export function encodeVoiceAssistantConfigurationResponse(opts: {
  availableWakeWords: Array<{ id: string; wakeWord: string; trainedLanguages: string[] }>;
  activeWakeWords: string[];
  maxActiveWakeWords: number;
}): Buffer {
  const parts: Buffer[] = [];

  for (const ww of opts.availableWakeWords) {
    const wwMsg = Buffer.concat([
      encodeStringField(1, ww.id),
      encodeStringField(2, ww.wakeWord),
      ...ww.trainedLanguages.map(lang => encodeStringField(3, lang)),
    ]);
    parts.push(encodeEmbeddedMessage(1, wwMsg));
  }

  for (const active of opts.activeWakeWords) {
    parts.push(encodeStringField(2, active));
  }

  parts.push(encodeVarintField(3, opts.maxActiveWakeWords));
  return Buffer.concat(parts);
}
