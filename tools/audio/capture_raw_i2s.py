#!/usr/bin/env python3
"""Capture one complete raw-I2S diagnostic run from any Raspberry Pi Pico CDC port.

Usage: python3 tools/audio/capture_raw_i2s.py OUTPUT.txt [--timeout 45]
The destination is never overwritten. Incomplete serial data is retained as .partial.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import serial
from serial.tools import list_ports

from decode_raw_i2s import load_capture

PICO_USB_VID = 0x2E8A
DIAGNOSTIC_HEADER = b'AE_RAW_I2S_V1 '
CAPTURE_END = b'CAPTURE_END'


def normalize_serial_line(line: bytes) -> bytes:
    return line.rstrip(b'\r')


def pico_cdc_ports() -> list[str]:
    return sorted({port.device for port in list_ports.comports()
                   if port.vid == PICO_USB_VID and port.device.startswith('/dev/ttyACM')})


def capture(output: Path, timeout_seconds: float) -> str:
    if output.exists():
        raise FileExistsError(f'refusing to overwrite existing capture: {output}')
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + '.partial')
    if partial.exists():
        raise FileExistsError(f'refusing to overwrite incomplete capture: {partial}')

    deadline = time.monotonic() + timeout_seconds
    stream = None
    active_port = None
    line = bytearray()
    saw_header = False
    saw_complete = False
    saw_end = False
    try:
        with partial.open('xb') as capture_file:
            while time.monotonic() < deadline:
                if stream is None:
                    ports = pico_cdc_ports()
                    if len(ports) > 1:
                        raise RuntimeError(f'multiple Pico CDC devices found; refusing ambiguous capture: {ports}')
                    if not ports:
                        time.sleep(0.1)
                        continue
                    try:
                        stream = serial.Serial(ports[0], baudrate=115200, timeout=0.2,
                                               write_timeout=0.2, exclusive=True)
                        active_port = ports[0]
                        print(f'USB CDC selected: {active_port}', file=sys.stderr, flush=True)
                    except (serial.SerialException, OSError):
                        stream = None
                        time.sleep(0.1)
                        continue
                try:
                    chunk = stream.read(4096)
                except (serial.SerialException, OSError):
                    stream.close()
                    stream = None
                    active_port = None
                    line.clear()
                    continue
                if not chunk:
                    continue
                capture_file.write(chunk)
                for byte in chunk:
                    if byte == 0x0a:
                        current = normalize_serial_line(bytes(line))
                        line.clear()
                        if current.startswith(DIAGNOSTIC_HEADER):
                            saw_header = True
                        elif current.startswith(b'CAPTURE_COMPLETE '):
                            saw_complete = True
                        elif current == CAPTURE_END:
                            saw_end = True
                            break
                    else:
                        if len(line) < 4096:
                            line.append(byte)
                if saw_end:
                    capture_file.flush()
                    os.fsync(capture_file.fileno())
                    break
            if not saw_end:
                raise TimeoutError(f'timed out waiting for complete diagnostic stream; last port={active_port}')
    finally:
        if stream is not None:
            stream.close()

    if not (saw_header and saw_complete and saw_end):
        raise ValueError(f'incomplete diagnostic stream: header={saw_header}, complete={saw_complete}, end={saw_end}; retained {partial}')

    # Validate count/framing before publishing as a complete immutable capture.
    load_capture(partial)
    if active_port is None:
        raise RuntimeError('capture ended without an identified Pico CDC port')
    os.link(partial, output)
    partial.unlink()
    return active_port


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--timeout', type=float, default=45.0)
    args = parser.parse_args()
    try:
        port = capture(args.output, args.timeout)
    except (FileExistsError, OSError, RuntimeError, TimeoutError, ValueError,
            serial.SerialException) as exc:
        parser.exit(1, f'capture failed: {exc}\n')
    print(f'CAPTURE_VALID path={args.output} device={port}')


if __name__ == '__main__':
    main()
