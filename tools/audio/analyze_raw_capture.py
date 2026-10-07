#!/usr/bin/env python3
"""Offline report for the opt-in interleaved 8-channel endpoint WAV.

Usage: python3 tools/audio/analyze_raw_capture.py capture.wav [--start SEC --end SEC]
Requires numpy. Band powers are diagnostic summaries, not calibrated frequency response.
"""
import argparse
import json
import wave
from pathlib import Path

import numpy as np

LABELS = [
    'D0 L mic0', 'D0 R mic1', 'D1 L mic2', 'D1 R mic3',
    'D2 L mic4', 'D2 R mic5', 'D3 L unused', 'D3 R centre mic',
]
BANDS = [(0, 70), (70, 300), (300, 1000), (1000, 3000), (3000, 8000)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('wav', type=Path)
    parser.add_argument('--start', type=float, default=0.0, help='analysis start time in seconds')
    parser.add_argument('--end', type=float, help='analysis end time in seconds')
    args = parser.parse_args()

    with wave.open(str(args.wav), 'rb') as wav:
        channels, rate, width, frames = wav.getnchannels(), wav.getframerate(), wav.getsampwidth(), wav.getnframes()
        if channels != 8 or rate != 16000 or width != 2:
            raise SystemExit(f'expected 8ch 16kHz PCM16; got channels={channels} rate={rate} width={width}')
        start = max(0, int(args.start * rate))
        end = min(frames, int(args.end * rate)) if args.end is not None else frames
        wav.setpos(start)
        raw = wav.readframes(max(0, end - start))
    samples = np.frombuffer(raw, dtype='<i2').reshape(-1, 8).astype(np.float64)
    if len(samples) == 0:
        raise SystemExit('empty selected time range')

    centred = samples - samples.mean(axis=0, keepdims=True)
    rms = np.sqrt(np.mean(centred ** 2, axis=0))
    peak = np.max(np.abs(samples), axis=0)
    dc = samples.mean(axis=0)
    clipped = np.sum((samples <= -32768) | (samples >= 32767), axis=0)
    nonzero = rms[rms > 0]
    median_rms = float(np.median(nonzero)) if len(nonzero) else 0.0
    relative_gain_db = [float(20 * np.log10(v / median_rms)) if v > 0 and median_rms else None for v in rms]
    corr = np.corrcoef(centred, rowvar=False)
    corr = np.nan_to_num(corr, nan=0.0).round(4)

    nfft = min(4096, 2 ** int(np.floor(np.log2(max(32, len(samples))))))
    window = np.hanning(nfft)
    powers = np.zeros((8, len(BANDS)), dtype=np.float64)
    blocks = 0
    for offset in range(0, len(samples) - nfft + 1, nfft // 2):
        block = samples[offset:offset + nfft]
        spectrum = np.fft.rfft((block - block.mean(axis=0)) * window[:, None], axis=0)
        power = np.abs(spectrum) ** 2
        freq = np.fft.rfftfreq(nfft, 1 / rate)
        for idx, (lo, hi) in enumerate(BANDS):
            mask = (freq >= lo) & (freq < hi)
            powers[:, idx] += power[mask].sum(axis=0)
        blocks += 1
    band_total = np.maximum(powers.sum(axis=1, keepdims=True), 1e-12)
    band_percent = (100 * powers / band_total).round(2)

    report = {
        'source': str(args.wav), 'startSeconds': args.start, 'endSeconds': end / rate,
        'durationSeconds': len(samples) / rate, 'sampleRateHz': rate, 'frames': len(samples),
        'channels': [
            {'index': i, 'label': LABELS[i], 'rms': round(float(rms[i]), 2),
             'peak': int(peak[i]), 'dcOffset': round(float(dc[i]), 2),
             'relativeGainDbVsMedianRms': relative_gain_db[i], 'clippedSamples': int(clipped[i]),
             'bandEnergyPercent': {f'{lo}-{hi}Hz': float(band_percent[i, j]) for j, (lo, hi) in enumerate(BANDS)}}
            for i in range(8)
        ],
        'correlationMatrix': corr.tolist(),
        'spectralBlocks': blocks,
        'caveat': 'Band energy is descriptive only. Frequency response needs a calibrated acoustic/electrical stimulus and known geometry.',
    }
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
