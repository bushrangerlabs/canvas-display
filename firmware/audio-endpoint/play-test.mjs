import net from 'net';

// Playback path test: connect as ROLE_PLAYBACK, send CONFIG + a 440 Hz tone,
// and watch the endpoint's serial status line for pws= (samples written) and
// pdma= (DMA words consumed) climbing.

const HOST = process.env.AE_HOST;
const PORT = 8090;
const TOKEN = process.env.AE_TOKEN;
const DEVICE = 'test-edge';
if (!HOST || !TOKEN) throw new Error("Set AE_HOST and AE_TOKEN locally before running this diagnostic.");

const MSG_HELLO = 1;
const MSG_CONFIG = 3;
const MSG_AUDIO = 4;

const RATE = 22050;
const DURATION_MS = 3000;

function frame(type, payload) {
  const total = payload.length + 1;
  const hdr = Buffer.alloc(3);
  hdr.writeUInt16LE(total, 0);
  hdr.writeUInt8(type, 2);
  return Buffer.concat([hdr, payload]);
}

function hello(role, token, deviceId) {
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

// 440 Hz sine, mono PCM16 @ RATE.
function makeTone(ms) {
  const samples = Math.floor((RATE * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(12000 * Math.sin((2 * Math.PI * 440 * i) / RATE));
    pcm.writeInt16LE(v, i * 2);
  }
  return pcm;
}

const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0);
let sentBytes = 0;
let acked = false;

sock.on('connect', () => {
  console.log('connected, sending HELLO (role=playback)');
  sock.write(hello(1, TOKEN, DEVICE));

  const rate = Buffer.alloc(6);
  rate.writeUInt32LE(RATE, 0);
  rate.writeUInt8(1, 4); // channels
  rate.writeUInt8(0, 5); // PCM16
  sock.write(frame(MSG_CONFIG, rate));
  console.log(`sent CONFIG rate=${RATE} ch=1 fmt=PCM16`);

  const tone = makeTone(DURATION_MS);
  console.log(`sending ${DURATION_MS} ms of 440 Hz tone (${tone.length} bytes)`);
  // Send in 20 ms chunks like a real stream.
  const chunk = 882; // 20 ms @ 22050 = 441 samples = 882 bytes
  let off = 0;
  const timer = setInterval(() => {
    if (off >= tone.length) {
      clearInterval(timer);
      console.log(`done — sent ${sentBytes} bytes`);
      setTimeout(() => process.exit(0), 500);
      return;
    }
    const end = Math.min(off + chunk, tone.length);
    const piece = tone.subarray(off, end);
    sock.write(frame(MSG_AUDIO, piece));
    sentBytes += piece.length;
    off = end;
  }, 20);
});

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 3) {
    const total = buf.readUInt16LE(0);
    if (buf.length < 2 + total) break;
    const type = buf.readUInt8(2);
    const payload = buf.subarray(3, 2 + total);
    buf = buf.subarray(2 + total);
    if (type === 2) {
      acked = true;
      console.log(`HELLO_ACK version=${payload.readUInt8(0)} status=${payload.readUInt8(1)}`);
    }
  }
});

sock.on('error', (e) => console.error('err', e.message));
sock.on('close', () => console.log('socket closed'));
setTimeout(() => {
  console.log(`timeout — acked=${acked} sentBytes=${sentBytes}`);
  process.exit(1);
}, 15000);