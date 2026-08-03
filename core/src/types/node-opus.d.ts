declare module 'node-opus' {
  export class OpusEncoder {
    constructor(rate: number, channels: number);
    encode(buffer: Buffer): Buffer;
    decode(buffer: Buffer): Buffer;
    applyEncoderCTL(ctl: number, value: number): void;
    applyDecoderCTL(ctl: number, value: number): void;
    setBitrate(bitrate: number): void;
    getBitrate(): number;
  }
}