#!/usr/bin/env python3
"""Probe a Snapcast server and print ServerSettings / CodecHeader.

Wire format (verified against snapserver 0.34.0 with tcpdump):
  header (26 bytes, LITTLE-endian):
    uint16 type, uint16 id, uint16 refersTo,
    int32 sent.sec, int32 sent.usec, int32 received.sec, int32 received.usec,
    uint32 size
  payload:
    uint32 json_length, json bytes

Usage: snapcast-probe.py [host] [port]
"""
import json
import socket
import struct
import sys
import time

host = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.108"
port = int(sys.argv[2]) if len(sys.argv) > 2 else 1704

K_CODEC_HEADER = 1
K_WIRE_CHUNK = 2
K_SERVER_SETTINGS = 3
K_TIME = 4
K_HELLO = 5
K_CLIENT_INFO = 7
K_ERROR = 8

TYPE_NAMES = {
    K_CODEC_HEADER: "CodecHeader",
    K_WIRE_CHUNK: "WireChunk",
    K_SERVER_SETTINGS: "ServerSettings",
    K_TIME: "Time",
    K_HELLO: "Hello",
    K_CLIENT_INFO: "ClientInfo",
    K_ERROR: "Error",
}

HEADER = "<HHHiiiiI"


def now_tv():
    t = time.time()
    return int(t), int((t % 1) * 1_000_000)


def build(msg_type, payload=b"", msg_id=0, refers_to=0):
    sec, usec = now_tv()
    return struct.pack(HEADER, msg_type, msg_id, refers_to, sec, usec, sec, usec, len(payload)) + payload


def json_payload(obj):
    body = json.dumps(obj, separators=(",", ":")).encode()
    return struct.pack("<I", len(body)) + body


def read_message(sock):
    header = b""
    while len(header) < 26:
        chunk = sock.recv(26 - len(header))
        if not chunk:
            return None
        header += chunk
    msg_type, msg_id, refers_to, sec, usec, rsec, rusec, size = struct.unpack(HEADER, header)
    payload = b""
    while len(payload) < size:
        chunk = sock.recv(size - len(payload))
        if not chunk:
            return None
        payload += chunk
    return msg_type, payload


sock = socket.create_connection((host, port), timeout=5)

hello = {
    "MAC": "02:00:00:00:00:01",
    "HostName": "canvas-probe",
    "Version": "0.34.0",
    "ClientName": "Snapclient",
    "OS": "Linux",
    "Arch": "x86_64",
    "Instance": 1,
    "ID": "canvas-probe",
    "SnapStreamProtocolVersion": 2,
}
sock.sendall(build(K_HELLO, json_payload(hello)))
print("-> Hello")

for _ in range(12):
    message = read_message(sock)
    if message is None:
        print("connection closed by server")
        break
    msg_type, payload = message
    name = TYPE_NAMES.get(msg_type, f"type={msg_type}")
    if msg_type == K_SERVER_SETTINGS:
        (length,) = struct.unpack("<I", payload[:4])
        print("<- ServerSettings:")
        print(json.dumps(json.loads(payload[4:4 + length]), indent=2)[:3000])
    elif msg_type == K_CODEC_HEADER:
        (codec_len,) = struct.unpack("<I", payload[:4])
        codec = payload[4:4 + codec_len].decode(errors="replace")
        rest = payload[4 + codec_len:]
        (data_len,) = struct.unpack("<I", rest[:4]) if len(rest) >= 4 else (0,)
        print(f"<- CodecHeader: codec={codec!r} payload={data_len} bytes first={rest[4:24].hex()}")
    elif msg_type == K_WIRE_CHUNK:
        (ts,) = struct.unpack("<Q", payload[:8]) if len(payload) >= 8 else (0,)
        print(f"<- WireChunk: timestamp={ts} payload={len(payload) - 8} bytes")
        break
    else:
        print(f"<- {name} ({len(payload)} bytes)")

sock.close()
