import net from 'net';

export interface WyomingTarget {
  host: string;
  port: number;
}

export interface WyomingVoiceOption {
  id: string;
  label: string;
}

export interface WyomingEvent {
  type: string;
  data: Record<string, unknown>;
  payload?: Buffer;
}

interface EventCondition {
  types: string[];
}

function parseJsonObject<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
}

export function isWyomingUrl(rawUrl: string | undefined): boolean {
  const value = (rawUrl ?? '').trim().toLowerCase();
  return value.startsWith('wyoming://') || value.startsWith('tcp://');
}

export function parseWyomingTarget(rawUrl: string): WyomingTarget {
  const value = rawUrl.trim();
  if (!value) throw new Error('Wyoming target URL is empty');

  // Explicit Wyoming/TCP scheme
  if (value.startsWith('wyoming://') || value.startsWith('tcp://')) {
    const u = new URL(value);
    if (!u.hostname || !u.port) {
      throw new Error(`Invalid Wyoming target: ${value}`);
    }
    return { host: u.hostname, port: Number(u.port) };
  }

  // HTTP URL can be used as a convenience for host:port extraction.
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const u = new URL(value);
    if (!u.hostname || !u.port) {
      throw new Error(`Invalid HTTP-style Wyoming target: ${value}`);
    }
    return { host: u.hostname, port: Number(u.port) };
  }

  // host:port shorthand
  const [host, portRaw] = value.split(':');
  const port = Number(portRaw);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`Invalid Wyoming target format: ${value}`);
  }
  return { host, port };
}

export function extractPcmFromWav(buffer: Buffer): Buffer {
  if (buffer.length < 44) return buffer;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return buffer;
  }

  // Find data chunk in a minimal RIFF parser.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkLen = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLen;

    if (chunkId === 'data' && chunkEnd <= buffer.length) {
      return buffer.slice(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkLen % 2); // account for RIFF word alignment
  }

  return buffer;
}

export function pcmToWav(pcm: Buffer, rate: number, width: number, channels: number): Buffer {
  const bitsPerSample = width * 8;
  const blockAlign = channels * width;
  const byteRate = rate * blockAlign;
  const dataSize = pcm.length;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); // PCM fmt chunk len
  wav.writeUInt16LE(1, 20); // PCM format
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, 44);

  return wav;
}

function encodeEvent(event: WyomingEvent): Buffer {
  const header: Record<string, unknown> = {
    type: event.type,
  };

  if (event.data && Object.keys(event.data).length > 0) {
    header.data = event.data;
  }

  if (event.payload && event.payload.length > 0) {
    header.payload_length = event.payload.length;
  }

  const headerBuf = Buffer.from(`${JSON.stringify(header)}\n`, 'utf-8');
  if (!event.payload || event.payload.length === 0) {
    return headerBuf;
  }

  return Buffer.concat([headerBuf, event.payload]);
}

function decodeEvents(buffer: Buffer): { events: WyomingEvent[]; rest: Buffer } {
  const events: WyomingEvent[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset); // \n
    if (newline === -1) break;

    const headerRaw = buffer.slice(offset, newline).toString('utf-8').trim();
    const header = parseJsonObject<Record<string, unknown>>(headerRaw);
    if (!header || typeof header.type !== 'string') {
      break;
    }

    const dataLength = Number(header.data_length ?? 0);
    const payloadLength = Number(header.payload_length ?? 0);
    const total = (newline + 1 - offset) + dataLength + payloadLength;
    if (offset + total > buffer.length) {
      break;
    }

    const dataStart = newline + 1;
    const dataEnd = dataStart + dataLength;
    const payloadEnd = dataEnd + payloadLength;

    let data = (header.data && typeof header.data === 'object')
      ? { ...(header.data as Record<string, unknown>) }
      : {};

    if (dataLength > 0) {
      const dataRaw = buffer.slice(dataStart, dataEnd).toString('utf-8');
      const extra = parseJsonObject<Record<string, unknown>>(dataRaw);
      if (extra) {
        data = { ...data, ...extra };
      }
    }

    const payload = payloadLength > 0 ? buffer.slice(dataEnd, payloadEnd) : undefined;
    events.push({
      type: header.type,
      data,
      payload,
    });

    offset += total;
  }

  return { events, rest: buffer.slice(offset) };
}

async function connect(target: WyomingTarget, timeoutMs: number): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Wyoming connection timeout after ${timeoutMs}ms (${target.host}:${target.port})`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });

    socket.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function sendEventsAndWait(
  target: WyomingTarget,
  toSend: WyomingEvent[],
  condition: EventCondition,
  timeoutMs = 15_000,
): Promise<WyomingEvent[]> {
  const socket = await connect(target, timeoutMs);
  let readBuffer = Buffer.alloc(0);

  return await new Promise<WyomingEvent[]>((resolve, reject) => {
    const received: WyomingEvent[] = [];

    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      try {
        socket.end();
      } catch {
        // ignore
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for Wyoming response (${condition.types.join(', ')}) from ${target.host}:${target.port}`));
    }, timeoutMs);

    socket.on('data', (chunk) => {
      readBuffer = Buffer.concat([readBuffer, chunk]);
      const decoded = decodeEvents(readBuffer);
      readBuffer = Buffer.from(decoded.rest);
      for (const event of decoded.events) {
        received.push(event);
        if (condition.types.includes(event.type)) {
          cleanup();
          resolve(received);
          return;
        }
      }
    });

    socket.on('error', (err) => {
      cleanup();
      reject(err);
    });

    socket.on('close', () => {
      if (received.length > 0) {
        cleanup();
        resolve(received);
        return;
      }
      cleanup();
      reject(new Error(`Wyoming socket closed before response from ${target.host}:${target.port}`));
    });

    for (const event of toSend) {
      socket.write(encodeEvent(event));
    }
  });
}

export async function transcribeWithWyoming(
  target: WyomingTarget,
  pcmAudio: Buffer,
  language?: string,
): Promise<{ text: string; events: WyomingEvent[] }> {
  const events = await sendEventsAndWait(
    target,
    [
      { type: 'transcribe', data: language ? { language } : {} },
      { type: 'audio-start', data: { rate: 16000, width: 2, channels: 1 } },
      { type: 'audio-chunk', data: { rate: 16000, width: 2, channels: 1 }, payload: pcmAudio },
      { type: 'audio-stop', data: {} },
    ],
    { types: ['transcript', 'error'] },
    20_000,
  );

  const transcript = events.find((e) => e.type === 'transcript');
  if (!transcript) {
    throw new Error(`Wyoming ASR did not return transcript (${target.host}:${target.port})`);
  }

  return {
    text: String(transcript.data.text ?? ''),
    events,
  };
}

export async function synthesizeWithWyoming(
  target: WyomingTarget,
  text: string,
  voiceName?: string,
): Promise<{ audio: Buffer; contentType: string; events: WyomingEvent[] }> {
  const synthData: Record<string, unknown> = { text };
  if (voiceName) {
    synthData.voice = { name: voiceName };
  }

  const events = await sendEventsAndWait(
    target,
    [{ type: 'synthesize', data: synthData }],
    { types: ['audio-stop', 'error'] },
    20_000,
  );

  const audioStart = events.find((e) => e.type === 'audio-start');
  const chunks = events.filter((e) => e.type === 'audio-chunk' && e.payload && e.payload.length > 0);
  if (!audioStart || chunks.length === 0) {
    throw new Error(`Wyoming TTS did not return audio (${target.host}:${target.port})`);
  }

  const rate = Number(audioStart.data.rate ?? 22050);
  const width = Number(audioStart.data.width ?? 2);
  const channels = Number(audioStart.data.channels ?? 1);
  const pcm = Buffer.concat(chunks.map((c) => c.payload as Buffer));
  const wav = pcmToWav(pcm, rate, width, channels);

  return {
    audio: wav,
    contentType: 'audio/wav',
    events,
  };
}

function addVoiceOption(out: Map<string, WyomingVoiceOption>, entry: unknown): void {
  if (!entry || typeof entry !== 'object') return;
  const record = entry as Record<string, unknown>;
  const id = typeof record.name === 'string'
    ? record.name
    : (typeof record.id === 'string' ? record.id : '');
  if (!id) return;

  const language = typeof record.language === 'string'
    ? record.language
    : (typeof record.locale === 'string' ? record.locale : '');
  const speaker = typeof record.speaker === 'string' ? record.speaker : '';

  const labelParts = [id];
  if (language) labelParts.push(language);
  if (speaker) labelParts.push(speaker);
  out.set(id, { id, label: labelParts.join(' - ') });
}

function collectVoices(node: unknown, out: Map<string, WyomingVoiceOption>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectVoices(item, out);
    return;
  }

  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;

  if (Array.isArray(record.voices)) {
    for (const voice of record.voices) addVoiceOption(out, voice);
  }

  if (Array.isArray(record.tts)) {
    for (const ttsNode of record.tts) collectVoices(ttsNode, out);
  }

  if (Array.isArray(record.models)) {
    for (const model of record.models) collectVoices(model, out);
  }
}

export async function listWyomingVoices(target: WyomingTarget): Promise<WyomingVoiceOption[]> {
  const events = await sendEventsAndWait(
    target,
    [{ type: 'describe', data: {} }],
    { types: ['info', 'error'] },
    6_000,
  );

  const infoEvent = events.find((event) => event.type === 'info');
  if (!infoEvent) return [];

  const voices = new Map<string, WyomingVoiceOption>();
  collectVoices(infoEvent.data, voices);
  return Array.from(voices.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export function formatWyomingTarget(target: WyomingTarget): string {
  return `${target.host}:${target.port}`;
}

export function buildAudioFormatsForLog(pcmAudio: Buffer): Record<string, unknown> {
  return {
    bytes: pcmAudio.length,
    rate: 16000,
    width: 2,
    channels: 1,
  };
}
