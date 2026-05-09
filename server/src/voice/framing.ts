/**
 * ESPHome plaintext API framing.
 *
 * Frame format (no encryption):
 *   [0x00]                   — plaintext marker
 *   [varint: protoByteLen]   — byte length of the proto payload
 *   [varint: msgType]        — message type ID
 *   [protoBytes...]          — protobuf-encoded payload
 *
 * Note: protoByteLen does NOT include the msgType varint itself.
 */

import { EventEmitter } from 'events';
import { encodeVarint, decodeVarint } from './proto.js';

export function encodeFrame(msgType: number, protoBytes: Buffer): Buffer {
  const msgTypeVarint = encodeVarint(msgType);
  const sizeVarint = encodeVarint(protoBytes.length);
  return Buffer.concat([
    Buffer.from([0x00]),
    sizeVarint,
    msgTypeVarint,
    protoBytes,
  ]);
}

type FrameMessage = { msgType: number; payload: Buffer };

/**
 * Streaming frame decoder. Feed raw TCP data via push(); emits 'message'
 * events as complete frames arrive.
 */
export class FrameDecoder extends EventEmitter {
  private buf = Buffer.alloc(0);

  push(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    this.drain();
  }

  private drain(): void {
    while (this.buf.length > 0) {
      // Need at least the 0x00 marker
      if (this.buf[0] !== 0x00) {
        // Not a plaintext frame — could be Noise handshake byte 0x01
        // ESPHome sends 0x01 as first byte when Noise is requested.
        // We don't support Noise, so drop this connection's buffer.
        this.emit('error', new Error(`Unexpected framing byte 0x${this.buf[0].toString(16)}`));
        this.buf = Buffer.alloc(0);
        return;
      }

      let offset = 1;

      // Decode protoByteLen
      if (offset >= this.buf.length) return; // need more data
      let protoByteLen: number;
      let varintLen: number;
      try {
        [protoByteLen, varintLen] = decodeVarint(this.buf, offset);
      } catch {
        return; // incomplete varint — wait for more data
      }
      offset += varintLen;

      // Decode msgType
      if (offset >= this.buf.length) return;
      let msgType: number;
      let msgTypeLen: number;
      try {
        [msgType, msgTypeLen] = decodeVarint(this.buf, offset);
      } catch {
        return;
      }
      offset += msgTypeLen;

      // Ensure full payload is available
      const totalNeeded = offset + protoByteLen;
      if (this.buf.length < totalNeeded) return;

      const payload = this.buf.slice(offset, totalNeeded);
      this.buf = this.buf.slice(totalNeeded);

      const msg: FrameMessage = { msgType, payload };
      this.emit('message', msg);
    }
  }
}

export type { FrameMessage };
