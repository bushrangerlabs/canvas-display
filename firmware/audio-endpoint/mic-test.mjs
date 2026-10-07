import net from 'net';

const HOST = process.env.AE_HOST;
const PORT = 8090;
const TOKEN = process.env.AE_TOKEN;
const DEVICE = 'test-edge';
if (!HOST || !TOKEN) throw new Error("Set AE_HOST and AE_TOKEN locally before running this diagnostic.");

function frame(type, payload) {
  const total = payload.length + 1;
  const hdr = Buffer.alloc(3);
  hdr.writeUInt16LE(total, 0);
  hdr.writeUInt8(type, 2);
  return Buffer.concat([hdr, payload]);
}

const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0);
let frames = 0;

sock.on('connect', () => {
  const t = Buffer.from(TOKEN);
  const d = Buffer.from(DEVICE);
  const p = Buffer.alloc(2 + t.length + 1 + d.length);
  p.writeUInt8(0, 0); // role = mic
  p.writeUInt8(t.length, 1);
  t.copy(p, 2);
  p.writeUInt8(d.length, 2 + t.length);
  d.copy(p, 3 + t.length);
  sock.write(frame(1, p));
  console.log('connected, sent HELLO');
});

sock.on('data', (chunk) => {
  console.log('recv bytes', chunk.length);
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 3) {
    const total = buf.readUInt16LE(0);
    if (buf.length < 2 + total) break;
    const type = buf.readUInt8(2);
    const payload = buf.subarray(3, 2 + total);
    buf = buf.subarray(2 + total);
    if (frames < 3) console.log('msg type=', type, 'total=', total, 'payloadLen=', payload.length);
    if (type === 2) {
      console.log('HELLO_ACK status=', payload.readUInt8(1));
    } else if (type === 4) {
      frames++;
      if (frames <= 3) {
        const chans = 8;
        const samples = (payload.length - 8) / 2 / chans;
        const rms = new Array(chans).fill(0);
        for (let s = 0; s < samples; s++) {
          for (let c = 0; c < chans; c++) {
            const v = payload.readInt16LE(8 + (s * chans + c) * 2);
            rms[c] += v * v;
          }
        }
        const r = rms.map((x) => Math.round(Math.sqrt(x / samples)));
        console.log(`frame ${frames}: samples=${samples} rms=[${r.join(', ')}]`);
      }
    }
  }
});

sock.on('error', (e) => console.error('err', e.message));
sock.on('close', () => console.log('socket closed'));
sock.on('end', () => console.log('socket ended'));
setTimeout(() => { console.log('total frames received:', frames); process.exit(0); }, 4000);
