/**
 * Baseline tuning (2026-10-06): the previous weighted sum over channels
 * 0,1,3,4,7 (centre 2x) summed mics at different positions without delay
 * compensation, creating comb-filter notches in the consonant range —
 * "Big Ben" transcribed as "big bed"/"big bend". Use the centre mic (ch7)
 * alone; gate/AGC unchanged. Revisit with a real beamformer later.
 */
export class RemoteMicDsp {
  private noiseRms = 0;
  private agcGain = 1;

  process(frame: Buffer): Buffer {
    if (frame.length !== 5120) throw new Error('Expected 320 samples of eight-channel PCM16');
    const beam = new Float32Array(320);
    let squares = 0;
    for (let i = 0; i < 320; i++) {
      const sample = (ch: number) => frame.readInt16LE((i * 8 + ch) * 2);
      const value = Math.fround(sample(7));
      beam[i] = value;
      squares += Math.fround(value * value);
    }
    // NumPy's mean and sqrt operate on float32 in the original implementation.
    const rms = Math.fround(Math.sqrt(Math.fround(squares / 320))) + 1e-9;
    this.noiseRms = rms < this.noiseRms
      ? 0.9 * this.noiseRms + 0.1 * rms
      : 0.999 * this.noiseRms + 0.001 * rms;
    const gate = Math.max(0, Math.min(1, (rms - 1.5 * this.noiseRms) / (4 * this.noiseRms + 1e-9)));
    if (rms > 1e-6) {
      this.agcGain += 0.05 * (2400 / rms - this.agcGain);
      this.agcGain = Math.max(0.1, Math.min(8, this.agcGain));
    }
    const out = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) {
      const value = Math.fround(Math.fround(beam[i] * Math.fround(gate)) * Math.fround(this.agcGain));
      out.writeInt16LE(Math.trunc(Math.max(-32768, Math.min(32767, value))), i * 2);
    }
    return out;
  }
}

export function pcmStats(pcm: Buffer): { rms: number; clipped: number } {
  let squares = 0;
  let clipped = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const value = pcm.readInt16LE(i);
    squares += value * value;
    if (value === -32768 || value === 32767) clipped++;
  }
  return { rms: Math.round(Math.sqrt(squares / Math.max(1, pcm.length / 2))), clipped };
}
