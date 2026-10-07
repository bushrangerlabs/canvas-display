#!/usr/bin/env python3
"""Decode one or more AE_RAW_I2S_V1 USB CDC captures without third-party packages.

Usage: python3 tools/audio/decode_raw_i2s.py capture-01.txt [capture-02.txt ...]
The capture file is the diagnostic's text output, including its header and CAPTURE_END.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics
from collections.abc import Iterable
from itertools import pairwise
from pathlib import Path

LANES = 4
OFFSETS = range(-2, 33)


def load_capture(path: Path) -> tuple[dict[str, str], list[int]]:
    lines = path.read_text(encoding='ascii', errors='strict').splitlines()
    header = next((line for line in lines if line.startswith('AE_RAW_I2S_V1 ')), None)
    if header is None:
        raise ValueError(f'{path}: missing AE_RAW_I2S_V1 header')
    metadata = dict(re.findall(r'(\w+)=([^ ]+)', header))
    start = next((i for i, line in enumerate(lines) if line.startswith('CAPTURE_COMPLETE ')), None)
    if start is None:
        raise ValueError(f'{path}: missing CAPTURE_COMPLETE')
    expected = int(dict(re.findall(r'(\w+)=([^ ]+)', lines[start])).get('observations', '0'))
    end = next((i for i in range(start + 1, len(lines)) if lines[i] == 'CAPTURE_END'), None)
    if end is None:
        raise ValueError(f'{path}: missing CAPTURE_END (capture may be incomplete)')
    words = [int(line, 16) for line in lines[start + 1:end] if re.fullmatch(r'[0-9a-fA-F]{8}', line)]
    if len(words) != expected:
        raise ValueError(f'{path}: expected {expected} words, found {len(words)}')
    return metadata, words


def decode_observations(words: Iterable[int]) -> tuple[list[list[int]], list[list[int]]]:
    high: list[list[int]] = [[] for _ in range(6)]
    low: list[list[int]] = [[] for _ in range(6)]
    for i, word in enumerate(words):
        state = (word >> 26) & 0x3f
        bank = high if i % 2 == 0 else low
        for pin in range(6):
            bank[pin].append((state >> pin) & 1)
    return high, low


def transitions(ws: list[int]) -> list[int]:
    return [i for i in range(1, len(ws)) if ws[i] != ws[i - 1]]


def signed24(bits: list[int]) -> int:
    value = 0
    for bit in bits:
        value = (value << 1) | bit
    return value - (1 << 24) if value & (1 << 23) else value


def sample_stats(samples: list[int], bit_width: int = 24) -> dict[str, float | int | None]:
    if not samples:
        return {'count': 0, 'dc': None, 'rms': None, 'peak': None,
                'negative_fraction': None, 'changing_bits': 0}
    dc = statistics.fmean(samples)
    rms = math.sqrt(statistics.fmean(v * v for v in samples))
    changed = 0
    for bit in range(bit_width):
        column = {(v & 0xffffff) >> bit & 1 for v in samples}
        changed += len(column) > 1
    return {'count': len(samples), 'dc': round(dc, 2), 'rms': round(rms, 2),
            'peak': max(abs(v) for v in samples),
            'negative_fraction': round(sum(v < 0 for v in samples) / len(samples), 4),
            'changing_bits': int(changed)}


def tone_fit(samples: list[int], sample_rate: float, tone_hz: float) -> dict[str, float | None]:
    if len(samples) < 8:
        return {'r_squared': None, 'fundamental_rms': None}
    mean = statistics.fmean(samples)
    centred = [sample - mean for sample in samples]
    angles = [2 * math.pi * tone_hz * i / sample_rate for i in range(len(samples))]
    sin_values = [math.sin(angle) for angle in angles]
    cos_values = [math.cos(angle) for angle in angles]
    ss = sum(v * v for v in sin_values)
    cc = sum(v * v for v in cos_values)
    sc = sum(a * b for a, b in zip(sin_values, cos_values))
    sy = sum(a * b for a, b in zip(sin_values, centred))
    cy = sum(a * b for a, b in zip(cos_values, centred))
    determinant = ss * cc - sc * sc
    if determinant <= 0:
        return {'r_squared': None, 'fundamental_rms': None}
    sin_gain = (sy * cc - cy * sc) / determinant
    cos_gain = (cy * ss - sy * sc) / determinant
    fitted = [sin_gain * a + cos_gain * b for a, b in zip(sin_values, cos_values)]
    total = sum(v * v for v in centred)
    residual = sum((y - fit) ** 2 for y, fit in zip(centred, fitted))
    r_squared = 1 - residual / total if total > 0 else None
    fundamental_rms = math.hypot(sin_gain, cos_gain) / math.sqrt(2)
    return {'r_squared': round(r_squared, 5) if r_squared is not None else None,
            'fundamental_rms': round(fundamental_rms, 2)}


def channel_metrics(high: list[list[int]], ws_edges: list[int]) -> list[dict]:
    report = []
    for offset in (-1, 0, 1):
        for lane in range(LANES):
            for ws_value in (0, 1):
                samples = []
                for edge in ws_edges:
                    start = edge + offset
                    if start >= 0 and start + 25 <= len(high[lane]) and high[4][start] == ws_value:
                        samples.append(signed24(high[lane][start + 1:start + 25]))
                report.append({'offset': offset, 'lane': lane, 'ws': ws_value,
                               **sample_stats(samples),
                               'tone_1khz_fit': tone_fit(samples, 16000.0, 1000.0),
                               'sample_preview': samples[:12]})
    return report


def candidate_report(high: list[list[int]], ws_edges: list[int]) -> list[dict]:
    report = []
    for offset in OFFSETS:
        slots = []
        pad_ones = 0
        pad_total = 0
        delay_ones = 0
        for edge in ws_edges:
            start = edge + offset
            if start < 0 or start + 32 > len(high[4]):
                continue
            slot = [high[lane][start:start + 32] for lane in range(5)]
            slots.append((high[4][start], slot))
            for lane in range(LANES):
                pad_ones += sum(slot[lane][25:32])
                pad_total += 7
                delay_ones += slot[lane][0]
        lane_stats = []
        for lane in range(LANES):
            samples = [signed24(slot[lane][1:25]) for _, slot in slots]
            lane_stats.append({**sample_stats(samples), 'sample_preview': samples[:8]})
        report.append({
            'ws_relative_offset_samples': offset,
            'complete_slots': len(slots),
            'padding_one_bits': pad_ones,
            'padding_bits_tested': pad_total,
            'padding_one_fraction': round(pad_ones / pad_total, 6) if pad_total else None,
            'delay_one_bits': delay_ones,
            'lanes_signed24': lane_stats,
        })
    return report


def signed16(bits: list[int]) -> int:
    value = 0
    for bit in bits:
        value = (value << 1) | bit
    return value - (1 << 16) if value & (1 << 15) else value


def production_pcm_preview(high: list[list[int]]) -> list[dict]:
    report = []
    for lane in range(LANES):
        for slot_offset in (0, 32):
            samples = []
            for frame_base in range(0, len(high[lane]) - slot_offset - 15, 64):
                start = frame_base + slot_offset
                samples.append(signed16(high[lane][start:start + 16]))
            report.append({'lane': lane, 'assumed_slot': 'first' if slot_offset == 0 else 'second',
                           **sample_stats(samples, 16), 'pcm16_preview': samples[:12]})
    return report


def production_window_phase(high_ws: list[int], ws_edges: list[int]) -> dict:
    """Model production's first 16 captured CK samples in each assumed 32-bit slot.

    For each production slot base (sample indices 0,32,64,...), report its distance
    from the preceding WS transition in CK sample positions. Under the standard
    I2S interpretation used by the decoder, distance 1 means sample bits start
    after the delay bit; distance 0 means extraction starts on the delay bit.
    """
    offsets = []
    edge_i = 0
    for base in range(0, len(high_ws) - 16, 32):
        while edge_i + 1 < len(ws_edges) and ws_edges[edge_i + 1] <= base:
            edge_i += 1
        if not ws_edges or ws_edges[edge_i] > base:
            continue
        offsets.append((base - ws_edges[edge_i]) % 32)
    unique = sorted(set(offsets))
    if unique == [1]:
        classification = 'A: production 16-bit window begins at sample bit 23 (exports bits 23..8), subject to the standard-I2S interpretation.'
    elif unique == [0]:
        classification = 'B: production 16-bit window begins at the delay bit (delay + sample bits 23..9), subject to the standard-I2S interpretation.'
    elif len(unique) == 1:
        classification = f'C: production window has another fixed WS-relative offset ({unique[0]} CK samples).'
    elif len(unique) > 1:
        classification = f'D: production-window phase varies within this capture ({unique}).'
    else:
        classification = 'Insufficient WS transitions to classify the production window.'
    return {'slot_window_offsets_ck': offsets, 'unique_offsets_ck': unique,
            'classification': classification,
            'note': 'This models a fresh production receiver start at this capture’s first high-phase observation; verify repeated captures before concluding boot-to-boot determinism.'}


def phase_edge_activity(high: list[list[int]], low: list[list[int]]) -> dict:
    counts = []
    pin_names = ['D0', 'D1', 'D2', 'D3', 'WS', 'CK']
    for pin, name in enumerate(pin_names):
        high_to_low = sum(a != b for a, b in zip(high[pin], low[pin]))
        low_to_next_high = sum(a != b for a, b in zip(low[pin], high[pin][1:]))
        counts.append({'pin': name, 'high_to_low_changes': high_to_low,
                       'low_to_next_high_changes': low_to_next_high})
    clock_high_mismatches = sum(bit != 1 for bit in high[5])
    clock_low_mismatches = sum(bit != 0 for bit in low[5])
    return {'per_pin': counts,
            'ck_phase_sample_mismatches': {'high_samples_not_high': clock_high_mismatches,
                                           'low_samples_not_low': clock_low_mismatches},
            'note': 'Each GPIO snapshot now includes observed CK. A DATA change between phase samples locates it to one CK half-cycle; sample timing is a few PIO instructions after the wait and does not measure setup/hold margin.'}


def continuity(high: list[list[int]], ws_edges: list[int]) -> list[dict]:
    output = []
    for offset in OFFSETS:
        for lane in range(LANES):
            for ws_value in (0, 1):
                samples = []
                for edge in ws_edges:
                    start = edge + offset
                    if start >= 0 and start + 25 <= len(high[lane]) and high[4][start] == ws_value:
                        samples.append(signed24(high[lane][start + 1:start + 25]))
                deltas = [abs(b - a) for a, b in pairwise(samples)]
                output.append({'offset': offset, 'lane': lane, 'ws': ws_value,
                               'sample_count': len(samples),
                               'mean_abs_delta': round(statistics.fmean(deltas), 2) if deltas else None,
                               'max_abs_delta': max(deltas) if deltas else None})
    return output


def analyze(path: Path) -> dict:
    metadata, words = load_capture(path)
    high, low = decode_observations(words)
    edges = transitions(high[4])
    return {
        'file': str(path),
        'metadata': metadata,
        'observation_count': len(words),
        'ck_periods_observed': len(high[4]),
        'ws_transition_count': len(edges),
        'first_ws_high_phase_bits': high[4][:128],
        'first_ws_low_phase_bits': low[4][:128],
        'ws_transition_indices_high_phase': edges,
        'high_phase_lane_bit_counts': [sum(high[lane]) for lane in range(LANES)],
        'high_low_phase_edge_activity': phase_edge_activity(high, low),
        'production_extraction_phase': production_window_phase(high[4], edges),
        'production_extraction_pcm16': production_pcm_preview(high),
        'candidate_alignments': candidate_report(high, edges),
        'candidate_sample_continuity': continuity(high, edges),
        'per_channel_alignment_metrics': channel_metrics(high, edges),
        'interpretation': {
            'gpio_field': 'Six-bit field at word bits 31..26: bit0 D0, bit1 D1, bit2 D2, bit3 D3, bit4 WS, bit5 CK.',
            'slot_hypothesis': 'WS transition observation is treated as slot bit 0 (the I2S delay bit); payload occupies slot bits 1..24; padding occupies bits 25..31.',
            'padding': 'Prefer offsets with seven zero padding bits per data lane and repeated WS-slot cadence; acoustic sample statistics alone do not prove alignment.',
            'clock_phase': 'Each observation index even is sampled after wait-for-CK-high; odd is sampled after wait-for-CK-low. The samples occur a few PIO instructions after the wait, near the start of each plateau, not exactly on the electrical edge.',
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('captures', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, help='write JSON report to this file')
    args = parser.parse_args()
    reports = [analyze(path) for path in args.captures]
    classifications = [r['production_extraction_phase']['unique_offsets_ck'] for r in reports]
    run_phases = {tuple(x) for x in classifications}
    all_offsets = sorted({offset for run in classifications for offset in run})
    if len(run_phases) > 1 or any(len(run) > 1 for run in classifications):
        overall = 'D: receiver/capture phase varies across observed slots or fresh starts.'
    elif all_offsets == [1]:
        overall = 'A: production extraction is sample bits 23..8 for the tested starts.'
    elif all_offsets == [0]:
        overall = 'B: production extraction includes the I2S delay bit and omits sample bit 8 for the tested starts.'
    elif len(all_offsets) == 1:
        overall = f'C: production extraction has another fixed offset ({all_offsets[0]} CK samples) for the tested starts.'
    else:
        overall = 'Insufficient WS transitions to classify.'
    summary = {
        'capture_count': len(reports),
        'production_alignment_classification': overall,
        'per_capture_unique_offsets_ck': classifications,
        'boot_to_boot_phase_changes_observed': len(run_phases) > 1,
        'captures': reports,
    }
    text = json.dumps(summary, indent=2)
    if args.output:
        args.output.write_text(text + '\n', encoding='utf-8')
    print(text)


if __name__ == '__main__':
    main()
