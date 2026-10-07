import tempfile
import unittest
from pathlib import Path

import capture_raw_i2s as collector
import decode_raw_i2s as decoder


class RawI2sDecoderTests(unittest.TestCase):
    def make_capture(self, observations=256):
        states = []
        high_ws = []
        for ck_index in range(observations // 2):
            ws = (ck_index // 32) & 1
            # Synthetic lane patterns with zero delay and padding. The 24-bit
            # values vary by slot so decode and sign handling are exercised.
            in_slot = ck_index % 32
            payload = ((ck_index // 32) * 0x10203) & 0xffffff
            if payload & 0x800000:
                payload ^= 0xffffff
            data = 0
            if 1 <= in_slot <= 24:
                data = (payload >> (24 - in_slot)) & 1
            state = (data << 0) | (data << 1) | (data << 2) | (data << 3) | (ws << 4)
            high_ws.append(ws)
            states.append((state | 0x20) << 26)
            states.append(state << 26)
        edges = decoder.transitions(high_ws)
        return states, edges

    def test_parser_reads_complete_capture(self):
        text = '\n'.join([
            'AE_RAW_I2S_V1 rate_hz=16000 bclk_hz=1024000 observations=2 bytes_per_observation=4',
            'CAPTURE_COMPLETE observations=2', '00000000', '00000000', 'CAPTURE_END',
        ])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'capture.txt'
            path.write_text(text)
            metadata, words = decoder.load_capture(path)
        self.assertEqual(metadata['rate_hz'], '16000')
        self.assertEqual(words, [0, 0])

    def test_parser_rejects_incomplete_capture(self):
        text = '\n'.join([
            'AE_RAW_I2S_V1 rate_hz=16000 observations=2',
            'CAPTURE_COMPLETE observations=2', '00000000', 'CAPTURE_END',
        ])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'partial.txt'
            path.write_text(text)
            with self.assertRaisesRegex(ValueError, 'expected 2 words, found 1'):
                decoder.load_capture(path)

    def test_cdc_line_terminator_is_normalized(self):
        self.assertEqual(collector.normalize_serial_line(b'CAPTURE_END\r'), b'CAPTURE_END')

    def test_observation_pin_order_and_phase(self):
        high, low = decoder.decode_observations([0xFC000000, 0x88000000])
        self.assertEqual([pin[0] for pin in high], [1, 1, 1, 1, 1, 1])
        self.assertEqual([pin[0] for pin in low], [0, 1, 0, 0, 0, 1])

    def test_production_phase_classifies_sample_bits_23_to_8(self):
        # First WS transition is at high-sample index 31; subsequent transitions
        # are every 32 samples. Production windows at 32,64,... begin one bit later.
        ws = [0] * 31 + [1] * 32 + [0] * 32 + [1] * 32
        edges = decoder.transitions(ws)
        result = decoder.production_window_phase(ws, edges)
        self.assertEqual(result['unique_offsets_ck'], [1])
        self.assertTrue(result['classification'].startswith('A:'))

    def test_all_candidate_offsets_are_reported(self):
        words, edges = self.make_capture()
        high, _ = decoder.decode_observations(words)
        candidates = decoder.candidate_report(high, edges)
        self.assertEqual([item['ws_relative_offset_samples'] for item in candidates], list(range(-2, 33)))
        self.assertIn('padding_one_bits', candidates[2])
        self.assertIn('sample_preview', candidates[2]['lanes_signed24'][0])


if __name__ == '__main__':
    unittest.main()
