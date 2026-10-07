/**
 * Audio endpoint diagnostics — Core-side test tools for the Pico sound card.
 *
 * Core connects directly to the endpoint over TCP (same wire protocol as the
 * edge, see firmware protocol.h) so an admin can verify a Pico's mic and
 * speaker from the Core UI without involving an edge device:
 *
 *   - testMic:      connect as ROLE_MIC, read a few 8-channel frames, report
 *                   per-channel RMS so silent/dead mics are obvious.
 *   - testSpeaker:  connect as ROLE_PLAYBACK, send CONFIG + a short tone.
 *
 * Audio still flows directly between the endpoint and the assigned edge on the
 * LAN; these routes are purely diagnostic.
 */
import net from 'node:net';

const MSG_HELLO = 1;
const MSG_HELLO_ACK = 2;
const MSG_CONFIG = 3;
const MSG_AUDIO = 4;

const ROLE_MIC = 0;
const ROLE_PLAYBACK = 1;

const MIC_CHANNELS = 8;
const MIC_FRAME_SAMPLES = 320; // 20 ms @ 16 kHz
const MIC_FRAME_BYTES = MIC_FRAME_SAMPLES * MIC_CHANNELS * 2;

function frame(type: number, payload: Buffer): Buffer {
  const total = payload.length + 1;
  const hdr = Buffer.alloc(3);
  hdr.writeUInt16LE(total, 0);
  hdr.writeUInt8(type, 2);
  return Buffer.concat([hdr, payload]);
}

function hello(role: number, token: string, deviceId: string): Buffer {
  const t = Buffer.from(token, 'utf8');
  const d = Buffer.from(deviceId, 'utf8');
  const payload = Buffer.alloc(2 + t.length + 1 + d.length);
  payload.writeUInt8(role, 0);
  payload.writeUInt8(t.length, 1);
  t.copy(payload, 2);
  payload.writeUInt8(d.length, 2 + t.length);
  d.copy(payload, 3 + t.length);
  return frame(MSG_HELLO, payload);
}

/** Open a socket, authenticate, and wait for HELLO_ACK. Returns the socket plus
 * any bytes already received after the ACK (they may share a TCP segment). */
function connectAuthed(host: string, port: number, token: string, role: number): Promise<{ sock: net.Socket; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timed out waiting for HELLO_ACK'));
    }, 8000);
    let buf = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write(hello(role, token, 'core-test'));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 3) {
        const total = buf.readUInt16LE(0);
        if (buf.length < 2 + total) return;
        const type = buf.readUInt8(2);
        const payload = buf.subarray(3, 2 + total);
        buf = buf.subarray(2 + total);
        if (type === MSG_HELLO_ACK) {
          clearTimeout(timer);
          if (payload.length >= 2 && payload.readUInt8(1) !== 0) {
            sock.destroy();
            reject(new Error('endpoint rejected token'));
            return;
          }
          resolve({ sock, leftover: buf });
          return;
        }
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export interface MicTestResult {
  ok: boolean;
  frames: number;
  /** Per-channel RMS (0..7). Channel map: 0/1=D0, 2/3=D1, 4/5=D2, 6/7=D3
   * (ch 6 unused ~0, ch 7 = centre mic). */
  rms: number[];
  error?: string;
}

/** Read a few mic frames and report per-channel RMS. */
export async function testEndpointMic(host: string, port: number, token: string): Promise<MicTestResult> {
  const { sock, leftover } = await connectAuthed(host, port, token, ROLE_MIC);
  return new Promise<MicTestResult>((resolve) => {
    let buf = leftover;
    const frames: number[][] = [];
    const timer = setTimeout(() => finish(), 4000);
    const finish = () => {
      clearTimeout(timer);
      sock.destroy();
      if (frames.length === 0) {
        resolve({ ok: false, frames: 0, rms: [], error: 'no mic frames received' });
        return;
      }
      const rms = new Array<number>(MIC_CHANNELS).fill(0);
      for (const f of frames) {
        for (let c = 0; c < MIC_CHANNELS; c++) {
          let sum = 0;
          for (let s = 0; s < MIC_FRAME_SAMPLES; s++) {
            const v = f[s * MIC_CHANNELS + c];
            sum += v * v;
          }
          rms[c] += Math.sqrt(sum / MIC_FRAME_SAMPLES);
        }
      }
      resolve({ ok: true, frames: frames.length, rms: rms.map((x) => Math.round(x / frames.length)) });
    };
    const parse = () => {
      while (buf.length >= 3) {
        const total = buf.readUInt16LE(0);
        if (buf.length < 2 + total) return;
        const type = buf.readUInt8(2);
        const payload = buf.subarray(3, 2 + total);
        buf = buf.subarray(2 + total);
        if (type === MSG_AUDIO && payload.length >= 8 + MIC_FRAME_BYTES) {
          const pcm = payload.subarray(8, 8 + MIC_FRAME_BYTES);
          const frame = new Array<number>(MIC_FRAME_SAMPLES * MIC_CHANNELS);
          for (let i = 0; i < frame.length; i++) frame[i] = pcm.readInt16LE(i * 2);
          frames.push(frame);
          if (frames.length >= 3) finish();
        }
      }
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      parse();
    });
    sock.on('error', () => finish());
    sock.on('close', () => finish());
    parse(); // frames may already be in the leftover buffer
  });
}

export interface SpeakerTestResult {
  ok: boolean;
  bytesSent: number;
  error?: string;
}

/** Send a short 440 Hz tone to the endpoint's DAC. */
export async function testEndpointSpeaker(host: string, port: number, token: string): Promise<SpeakerTestResult> {
  const { sock } = await connectAuthed(host, port, token, ROLE_PLAYBACK);
  return new Promise<SpeakerTestResult>((resolve) => {
    const rate = 22050;
    const durationMs = 800;
    const samples = Math.floor((rate * durationMs) / 1000);
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      pcm.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
    }
    const cfg = Buffer.alloc(6);
    cfg.writeUInt32LE(rate, 0);
    cfg.writeUInt8(1, 4); // channels
    cfg.writeUInt8(0, 5); // PCM16
    sock.write(frame(MSG_CONFIG, cfg));
    // Send in 20 ms chunks like a real stream.
    const chunk = 882; // 20 ms @ 22050
    let off = 0;
    let sent = 0;
    const timer = setInterval(() => {
      if (off >= pcm.length) {
        clearInterval(timer);
        sock.destroy();
        resolve({ ok: true, bytesSent: sent });
        return;
      }
      const end = Math.min(off + chunk, pcm.length);
      const piece = pcm.subarray(off, end);
      sock.write(frame(MSG_AUDIO, piece));
      sent += piece.length;
      off = end;
    }, 20);
    sock.on('error', (err) => {
      clearInterval(timer);
      resolve({ ok: false, bytesSent: sent, error: err.message });
    });
    setTimeout(() => {
      clearInterval(timer);
      sock.destroy();
      resolve({ ok: true, bytesSent: sent });
    }, durationMs + 1500);
  });
}