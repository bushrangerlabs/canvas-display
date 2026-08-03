from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import replace
from html import unescape

from .catalog import STATIONS, Station

_LISTNR_PLAY_URL = "https://play.listnr.com/"
_NEXT_DATA_PATTERN = re.compile(
    r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(?P<payload>.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def discover_stations(static_fallback: tuple[Station, ...] = STATIONS) -> tuple[Station, ...]:
    """Discover available LiSTNR stations from the play site payload."""
    html = _fetch_play_html(_LISTNR_PLAY_URL)
    payload = _extract_next_data(html)

    static_by_callsign = {station.callsign.lower(): station for station in static_fallback}
    static_by_lookup: dict[str, Station] = {}
    for station in static_fallback:
        static_by_lookup[_lookup_key(station.name)] = station
        for alias in station.aliases:
            static_by_lookup[_lookup_key(alias)] = station

    discovered: dict[str, Station] = {}

    for item in _iter_station_like_objects(payload):
        callsign = _normalize_callsign(item.get("callSign"))
        if not callsign:
            continue

        name = _normalize_text(item.get("name"))
        slug = _normalize_slug(item.get("slug"))
        static_match = (
            static_by_callsign.get(callsign)
            or (
                static_by_callsign.get(callsign.removesuffix("fm"))
                if callsign.endswith("fm")
                else None
            )
            or static_by_lookup.get(_lookup_key(name))
            or static_by_lookup.get(_lookup_key(slug.replace("-", " ")))
            or static_by_lookup.get(_lookup_key(slug))
        )
        if static_match is None:
            for candidate in static_fallback:
                if _looks_like_same_station(name, candidate.name) or _looks_like_same_station(
                    slug.replace("-", " "), candidate.name
                ):
                    static_match = candidate
                    break

        key = static_match.key if static_match else f"listnr_{callsign}"
        display_name = (static_match.name if static_match else "") or name or callsign.upper()
        stream_callsign = static_match.callsign if static_match else callsign

        aliases: set[str] = set(static_match.aliases if static_match else ())
        aliases.add(stream_callsign)
        aliases.add(display_name)
        aliases.add(callsign)
        aliases.add(name)
        if slug:
            aliases.add(slug)
            aliases.add(slug.replace("-", " "))

        station = Station(
            key=key,
            name=display_name,
            callsign=stream_callsign,
            aliases=tuple(sorted(alias for alias in aliases if alias.strip())),
        )

        existing = discovered.get(key)
        if existing is None:
            discovered[key] = station
            continue

        # Keep the best known display name while merging aliases from duplicates.
        merged_aliases = tuple(sorted(set(existing.aliases) | set(station.aliases)))
        preferred_name = existing.name or station.name
        if preferred_name.lower() == stream_callsign and station.name.lower() != stream_callsign:
            preferred_name = station.name
        discovered[key] = replace(existing, name=preferred_name, aliases=merged_aliases)

    for station in static_fallback:
        discovered.setdefault(station.key, station)

    if not discovered:
        raise ValueError("No LiSTNR stations with callSign found in play payload")

    return tuple(sorted(discovered.values(), key=lambda station: station.name.lower()))


def _fetch_play_html(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-AU,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    with urllib.request.urlopen(request, timeout=15.0) as response:
        if response.status != 200:
            raise ValueError(f"Unexpected HTTP {response.status} from {url}")
        return response.read().decode("utf-8", "ignore")


def _extract_next_data(html: str) -> object:
    match = _NEXT_DATA_PATTERN.search(html)
    if match is None:
        raise ValueError("Could not find __NEXT_DATA__ payload in play page")
    return json.loads(unescape(match.group("payload")))


def _iter_station_like_objects(payload: object):
    if isinstance(payload, dict):
        if {"id", "name", "slug"}.issubset(payload):
            yield payload
        for value in payload.values():
            yield from _iter_station_like_objects(value)
        return

    if isinstance(payload, list):
        for value in payload:
            yield from _iter_station_like_objects(value)


def _normalize_text(value: object) -> str:
    return str(value or "").strip()


def _normalize_callsign(value: object) -> str:
    return "".join(ch.lower() for ch in _normalize_text(value) if ch.isalnum())


def _normalize_slug(value: object) -> str:
    slug = _normalize_text(value).lower()
    return "-".join(part for part in slug.replace("_", "-").split("-") if part)


def _lookup_key(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


def _looks_like_same_station(left: str, right: str) -> bool:
    left_key = _lookup_key(left)
    right_key = _lookup_key(right)
    if not left_key or not right_key:
        return False
    if left_key == right_key:
        return True
    if len(left_key) >= 6 and left_key in right_key:
        return True
    if len(right_key) >= 6 and right_key in left_key:
        return True
    return False