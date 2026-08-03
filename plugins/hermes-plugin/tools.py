"""Hermes tool handlers for Canvas Display plugin.

Each handler returns a JSON string and accepts (args, **kwargs).
"""

from __future__ import annotations

import json
import os
import re
from html import unescape
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote_plus, urljoin, urlparse
from urllib.request import Request, urlopen

CANVAS_API_URL = os.environ.get("CANVAS_API_URL", "http://127.0.0.1:3100").rstrip("/")


def _json(payload: dict) -> str:
    return json.dumps(payload)


def _looks_like_web_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    except Exception:
        return False


def _normalize_url(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        return ""
    if re.match(r"^https?://", trimmed, flags=re.IGNORECASE):
        return trimmed
    return f"https://{trimmed}"


def _read_text(url: str) -> str:
    req = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) CanvasDisplay-HermesPlugin/1.0",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urlopen(req, timeout=10) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _resolve_web_query_to_url(query: str) -> str:
    trimmed = query.strip()
    if not trimmed:
        return ""

    endpoints = [
        f"https://duckduckgo.com/html/?q={quote_plus(trimmed)}",
        f"https://lite.duckduckgo.com/lite/?q={quote_plus(trimmed)}",
    ]

    link_pattern = re.compile(r'href="([^"]*(?:uddg=|https?://)[^"]+)"', re.IGNORECASE)

    for endpoint in endpoints:
        try:
            html = _read_text(endpoint)
        except Exception:
            continue

        for match in link_pattern.finditer(html):
            href = unescape(match.group(1) or "")
            if not href:
                continue

            if "uddg=" in href:
                try:
                    parsed_href = urlparse(urljoin(endpoint, href))
                    uddg_values = parse_qs(parsed_href.query).get("uddg")
                    if uddg_values:
                        uddg = uddg_values[0]
                        if _looks_like_web_url(uddg):
                            return uddg
                except Exception:
                    pass

            if _looks_like_web_url(href):
                return href

    return f"https://duckduckgo.com/?q={quote_plus(trimmed)}"


def _call_canvas(path: str, body: dict) -> dict:
    url = f"{CANVAS_API_URL}{path}"
    data = json.dumps(body).encode("utf-8")
    req = Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")

    try:
        with urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else {}
    except HTTPError as err:
        raw = err.read().decode("utf-8", errors="replace") if err.fp else ""
        raise RuntimeError(f"Canvas API {path} failed ({err.code}): {raw}") from err
    except URLError as err:
        raise RuntimeError(f"Canvas API {path} request failed: {err.reason}") from err


def web_search_to_url(args: dict, **kwargs) -> str:
    try:
        query = str(args.get("query", "")).strip()
        if not query:
            return _json({"error": "query is required"})
        url = _resolve_web_query_to_url(query)
        return _json({"query": query, "url": url})
    except Exception as exc:
        return _json({"error": str(exc)})


def youtube_search_to_url(args: dict, **kwargs) -> str:
    try:
        query = str(args.get("query", "")).strip()
        if not query:
            return _json({"error": "query is required"})
        url = f"https://www.youtube.com/results?search_query={quote_plus(query)}"
        return _json({"query": query, "url": url})
    except Exception as exc:
        return _json({"error": str(exc)})


def canvas_set_page(args: dict, **kwargs) -> str:
    try:
        page_id = str(args.get("page_id", "")).strip()
        page = str(args.get("page", "")).strip()
        if not page_id and not page:
            return _json({"error": "page_id or page is required"})

        payload = {}
        if page_id:
            payload["page_id"] = page_id
        if page:
            payload["page"] = page

        result = _call_canvas("/api/commands/page", payload)
        return _json(result)
    except Exception as exc:
        return _json({"error": str(exc)})


def canvas_navigate_panel(args: dict, **kwargs) -> str:
    try:
        panel_id = str(args.get("panel_id", "")).strip()
        panel = str(args.get("panel", "")).strip()
        page_id = str(args.get("page_id", "")).strip()
        page = str(args.get("page", "")).strip()
        raw_url = str(args.get("url", "")).strip()
        if not raw_url:
            return _json({"error": "url is required"})

        url = _normalize_url(raw_url)
        payload = {"url": url}
        if panel_id:
            payload["panel_id"] = panel_id
        if panel:
            payload["panel"] = panel
        if page_id:
            payload["page_id"] = page_id
        if page:
            payload["page"] = page

        result = _call_canvas("/api/commands/navigate", payload)
        result["url"] = url
        return _json(result)
    except Exception as exc:
        return _json({"error": str(exc)})


def canvas_media_play(args: dict, **kwargs) -> str:
    try:
        source = str(args.get("source", "")).strip()
        if not source:
            return _json({"error": "source is required"})

        url = str(args.get("url", "")).strip()
        if not url:
            return _json({"error": "url is required"})

        title = str(args.get("title", "")).strip()
        panel_id = str(args.get("panel_id", "")).strip()
        volume = args.get("volume", None)

        payload = {
            "source": source,
            "url": url,
        }
        if title:
            payload["title"] = title
        if panel_id:
            payload["panel_id"] = panel_id
        if volume is not None:
            payload["volume"] = volume

        result = _call_canvas("/api/media/play", payload)
        return _json(result)
    except Exception as exc:
        return _json({"error": str(exc)})


def canvas_media_control(args: dict, **kwargs) -> str:
    try:
        source = str(args.get("source", "")).strip()
        if not source:
            return _json({"error": "source is required"})

        action = str(args.get("action", "")).strip()
        if not action:
            return _json({"error": "action is required"})

        payload = {
            "source": source,
            "action": action,
        }

        if "level" in args:
            payload["level"] = args.get("level")
        if "muted" in args:
            payload["muted"] = args.get("muted")

        result = _call_canvas("/api/media/control", payload)
        return _json(result)
    except Exception as exc:
        return _json({"error": str(exc)})
