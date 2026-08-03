#!/usr/bin/env python3
"""Bowling MCP server — live data scraped directly from ComputerScore.

All data is fetched live from livescores.computerscore.com.au on every tool
call. No database, no caching, no stale-data logic.

Tools:
  - health: Check web connectivity to ComputerScore
  - get_standings: Team standings for MPL or TDW
  - get_fixtures: Upcoming/recent fixtures with match details
  - get_schedule: Raw schedule data with lane assignments
  - get_team_info: Team roster and player stats
  - get_recent_results: Completed match results
"""
from __future__ import annotations

import logging
import os
import re
from datetime import date, datetime, time, timezone
from typing import Any, Optional

import httpx
from bs4 import BeautifulSoup
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

WEB_URL_MPL = "https://livescores.computerscore.com.au/standings.php?centre=108&results=mpl/standing.htm"
WEB_URL_TDW = "https://livescores.computerscore.com.au/standings.php?centre=108&results=tdw/standing.htm"
WEB_TIMEOUT = float(os.getenv("BOWLING_WEB_TIMEOUT", "30"))

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO")),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("mcp.bowling")

mcp = FastMCP("bowling")

# ---------------------------------------------------------------------------
# Web Scraping
# ---------------------------------------------------------------------------

def _fetch_web(url: str) -> Optional[str]:
    """Fetch a webpage, return HTML or None on failure."""
    try:
        with httpx.Client(
            headers={"User-Agent": "BowlingMCP/1.0 (hermes-agent)"},
            timeout=WEB_TIMEOUT,
            follow_redirects=True,
        ) as client:
            resp = client.get(url)
            if resp.status_code == 200:
                return resp.text
            logger.warning(f"Web fetch {url}: HTTP {resp.status_code}")
            return None
    except Exception as e:
        logger.error(f"Web fetch error {url}: {e}")
        return None


def _parse_standings(html: str, league: str = "mpl") -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table")
    if not table:
        return []

    rows = []
    for row in table.find_all("tr")[2:]:  # Skip header rows
        cells = row.find_all(["th", "td"])
        if len(cells) < 3:
            continue
        rank_text = cells[0].get_text(strip=True)
        rank = int(rank_text) if rank_text.isdigit() else 0
        team_link = cells[1].find("a")
        team_name = team_link.get_text(strip=True) if team_link else cells[1].get_text(strip=True)
        if not team_name:
            continue

        entry: dict[str, Any] = {"rank": rank, "team_name": team_name}
        vals = [c.get_text(strip=True) for c in cells[2:]]

        if league == "tdw":
            keys = ["match_points", "week14_points", "w_hcp", "hsg", "hss", "hhg", "hhs"]
            entry.update(dict(zip(keys, vals)))
        else:
            keys = ["match_points_won", "match_points_lost", "w_hcp", "scratch",
                    "total_pinfall", "hcp_pinfall", "hsg", "hss", "hhg", "hhs"]
            entry.update(dict(zip(keys, vals)))

        rows.append(entry)
    return rows


def _parse_schedule(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    schedule_table = None
    for tbl in soup.find_all("table"):
        first_cell = tbl.find(["th", "td"])
        if first_cell and "Schedule" in first_cell.get_text():
            schedule_table = tbl
            break
    if not schedule_table:
        return []

    rows = []
    for tr in schedule_table.find_all("tr")[1:]:
        cells = tr.find_all("td")
        if not cells:
            continue
        label = cells[0].get_text(strip=True)
        slots = [c.get_text(strip=True) for c in cells[1:] if c.get_text(strip=True)]
        if label and slots:
            rows.append({"match_label": label, "slots": slots})
    return rows


def _parse_team_info(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    tables = soup.find_all("table")
    results: list[dict] = []
    current_team: Optional[dict] = None

    if len(tables) > 3:
        for row in tables[3].find_all("tr"):
            for cell in row.find_all(["td", "th"]):
                text = cell.get_text(strip=True)
                m = re.match(r"^(\d{3})\s+(.+)$", text)
                if not m:
                    continue
                team_m = re.match(r"^(\d)\s+(.+)$", text)
                if team_m and len(team_m.group(2)) > 5:
                    current_team = {"team_no": int(team_m.group(1)), "team_name": team_m.group(2)}
                    results.append(current_team)
                elif current_team:
                    stat_cells = []
                    for c in cell.find_all_next(["td", "th"])[:10]:
                        ct = c.get_text(strip=True)
                        if ct and ct.isdigit():
                            stat_cells.append(ct)
                        else:
                            break
                    results.append({
                        **current_team,
                        "player_no": m.group(1),
                        "player_name": m.group(2),
                        "stats": dict(zip(
                            ["pts", "gme", "pins", "ave", "hcp", "hsg", "hss", "hhg"],
                            stat_cells[:8] + [""] * (8 - len(stat_cells)),
                        )),
                    })
    return results


def _scrape(league: str) -> dict[str, Any]:
    """Fetch + parse all data for a league. Returns ok dict or error dict."""
    url = WEB_URL_MPL if league == "mpl" else WEB_URL_TDW
    logger.info(f"Scraping {league} from {url}")
    html = _fetch_web(url)
    if not html:
        return {"ok": False, "error": f"Failed to fetch {url}"}
    return {
        "ok": True,
        "league": league,
        "source": "web",
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "standings": _parse_standings(html, league),
        "schedule": _parse_schedule(html),
        "teams": _parse_team_info(html),
    }


def _parse_match_label(label: str) -> tuple[Optional[date], Optional[time]]:
    """Parse '6/07/2026 7:05 PM (P)' -> (date, time)."""
    if not label:
        return None, None
    cleaned = re.sub(r"\s*\([Pp]\)\s*$", "", label).strip()
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)", cleaned, re.I)
    if m:
        day, month, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hour, minute = int(m.group(4)), int(m.group(5))
        if m.group(6).upper() == "PM" and hour != 12:
            hour += 12
        elif m.group(6).upper() == "AM" and hour == 12:
            hour = 0
        try:
            return date(year, month, day), time(hour, minute)
        except ValueError:
            pass
    m2 = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", cleaned)
    if m2:
        try:
            return date(int(m2.group(3)), int(m2.group(2)), int(m2.group(1))), None
        except ValueError:
            pass
    return None, None


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------

@mcp.tool()
def health() -> dict[str, Any]:
    """Check live web connectivity to ComputerScore for MPL and TDW."""
    results: dict[str, Any] = {"source": "web"}
    for league, url in [("mpl", WEB_URL_MPL), ("tdw", WEB_URL_TDW)]:
        try:
            with httpx.Client(timeout=10, follow_redirects=True) as client:
                resp = client.get(url)
            results[league] = {"ok": resp.status_code == 200, "status_code": resp.status_code}
        except Exception as e:
            results[league] = {"ok": False, "error": str(e)}
    results["healthy"] = all(v.get("ok") for v in results.values() if isinstance(v, dict))
    return results


@mcp.tool()
def get_standings(league: str = "mpl", limit: int = 20) -> dict[str, Any]:
    """Get live team standings for a bowling league.

    Args:
        league: "mpl" (Premier League, Monday) or "tdw" (Top Dogs Wednesday)
        limit: Maximum number of teams to return
    """
    league = league.lower().strip()
    if league not in ("mpl", "tdw"):
        return {"ok": False, "error": "Unknown league. Use 'mpl' or 'tdw'."}
    data = _scrape(league)
    if not data["ok"]:
        return data
    standings = data["standings"][:limit]
    return {
        "ok": True, "league": league, "source": "web",
        "scraped_at": data["scraped_at"],
        "count": len(standings), "standings": standings,
    }


@mcp.tool()
def get_fixtures(league: str = "mpl", limit: int = 20) -> dict[str, Any]:
    """Get upcoming and recent bowling fixtures.

    Args:
        league: "mpl" or "tdw"
        limit: Maximum fixtures to return
    """
    league = league.lower().strip()
    if league not in ("mpl", "tdw"):
        return {"ok": False, "error": "Unknown league. Use 'mpl' or 'tdw'."}
    data = _scrape(league)
    if not data["ok"]:
        return data

    fixtures = []
    for sched in data["schedule"]:
        match_date, match_time = _parse_match_label(sched["match_label"])
        fixtures.append({
            "match_date": match_date.isoformat() if match_date else None,
            "match_time": match_time.strftime("%H:%M") if match_time else None,
            "match_label": sched["match_label"],
            "slots": sched["slots"],
            "match_status": "completed" if (match_date and match_date < date.today()) else "scheduled",
        })

    return {
        "ok": True, "league": league, "source": "web",
        "scraped_at": data["scraped_at"],
        "count": len(fixtures), "fixtures": fixtures[:limit],
    }


@mcp.tool()
def get_schedule(league: str = "mpl") -> dict[str, Any]:
    """Get the full bowling schedule with lane slot assignments.

    Args:
        league: "mpl" or "tdw"
    """
    league = league.lower().strip()
    if league not in ("mpl", "tdw"):
        return {"ok": False, "error": "Unknown league. Use 'mpl' or 'tdw'."}
    data = _scrape(league)
    if not data["ok"]:
        return data
    return {
        "ok": True, "league": league, "source": "web",
        "scraped_at": data["scraped_at"],
        "count": len(data["schedule"]), "schedule": data["schedule"],
    }


@mcp.tool()
def get_team_info(league: str = "mpl") -> dict[str, Any]:
    """Get team rosters and player statistics.

    Args:
        league: "mpl" or "tdw"
    """
    league = league.lower().strip()
    if league not in ("mpl", "tdw"):
        return {"ok": False, "error": "Unknown league. Use 'mpl' or 'tdw'."}
    data = _scrape(league)
    if not data["ok"]:
        return data
    return {
        "ok": True, "league": league, "source": "web",
        "scraped_at": data["scraped_at"],
        "standings": data["standings"],
        "teams": data["teams"],
    }


@mcp.tool()
def get_recent_results(league: str = "mpl", limit: int = 10) -> dict[str, Any]:
    """Get recently completed bowling match results.

    Args:
        league: "mpl" or "tdw"
        limit: Maximum results to return
    """
    league = league.lower().strip()
    if league not in ("mpl", "tdw"):
        return {"ok": False, "error": "Unknown league. Use 'mpl' or 'tdw'."}
    data = _scrape(league)
    if not data["ok"]:
        return data

    completed = []
    for sched in data["schedule"]:
        match_date, match_time = _parse_match_label(sched["match_label"])
        if match_date and match_date < date.today():
            completed.append({
                "match_date": match_date.isoformat(),
                "match_time": match_time.strftime("%H:%M") if match_time else None,
                "match_label": sched["match_label"],
                "slots": sched["slots"],
                "match_status": "completed",
            })

    return {
        "ok": True, "league": league, "source": "web",
        "scraped_at": data["scraped_at"],
        "count": len(completed), "results": completed[:limit],
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
