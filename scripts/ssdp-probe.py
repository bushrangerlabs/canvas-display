#!/usr/bin/env python3
"""Send an SSDP M-SEARCH and print every response (DLNA discovery smoke test)."""
import socket
import sys

GROUP = "239.255.255.250"
PORT = 1900
ST = sys.argv[1] if len(sys.argv) > 1 else "urn:schemas-upnp-org:device:MediaRenderer:1"

message = "\r\n".join([
    "M-SEARCH * HTTP/1.1",
    f"HOST: {GROUP}:{PORT}",
    'MAN: "ssdp:discover"',
    "MX: 2",
    f"ST: {ST}",
    "",
    "",
]).encode()

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
sock.settimeout(4)
sock.sendto(message, (GROUP, PORT))

seen = set()
while True:
    try:
        data, addr = sock.recvfrom(4096)
    except socket.timeout:
        break
    text = data.decode(errors="replace")
    key = (addr[0], text)
    if key in seen:
        continue
    seen.add(key)
    location = ""
    for line in text.split("\r\n"):
        if line.lower().startswith("location:"):
            location = line.split(":", 1)[1].strip()
    print(f"{addr[0]}:{addr[1]}  ST={ST}  LOCATION={location}")

if not seen:
    print("no responses")
