from __future__ import annotations

import socket
import urllib.request
from urllib.parse import urlparse

# Preferred hosts observed in existing Canvas runtime.
LISTNR_HOSTS: tuple[str, ...] = (
    "sa47.scastream.com.au",
    "sa46.scastream.com.au",
)


def _host_resolves(host: str) -> bool:
    try:
        socket.getaddrinfo(host, 443)
        return True
    except OSError:
        return False


def _url_host_resolves(url: str) -> bool:
    host = urlparse(url).hostname or ""
    return bool(host) and _host_resolves(host)


def _extract_signed_url(playlist_text: str) -> str | None:
    for line in playlist_text.splitlines():
        candidate = line.strip()
        if candidate and not candidate.startswith("#"):
            return candidate
    return None


def _signed_url_reachable(base_playlist_url: str, timeout: float = 6.0) -> bool:
    """Return True when playlist and its signed URL are both fetchable."""
    try:
        with urllib.request.urlopen(base_playlist_url, timeout=timeout) as response:
            if response.status != 200:
                return False
            playlist = response.read().decode("utf-8", "ignore")
    except Exception:  # noqa: BLE001
        return False

    signed_url = _extract_signed_url(playlist)
    if not signed_url:
        return False

    try:
        with urllib.request.urlopen(signed_url, timeout=timeout) as response:
            return response.status == 200
    except Exception:  # noqa: BLE001
        return False


def stream_candidates(callsign: str) -> list[str]:
    callsign = callsign.strip().lower()
    if not callsign:
        return []

    out: list[str] = []
    for bitrate in (128, 32):
        for host in LISTNR_HOSTS:
            out.append(f"https://{host}/live/{callsign}_{bitrate}.stream/playlist.m3u8")
    return out


def resolve_stream_url(callsign: str) -> str | None:
    for candidate in stream_candidates(callsign):
        if _url_host_resolves(candidate) and _signed_url_reachable(candidate):
            return candidate
    return None
