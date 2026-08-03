from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Station:
    key: str
    name: str
    callsign: str
    aliases: tuple[str, ...]


STATIONS: tuple[Station, ...] = (
    Station("triple_m_sydney", "Triple M Sydney", "2mmm", ("triple m sydney", "mmm sydney", "2mmm")),
    Station("triple_m_melbourne", "Triple M Melbourne", "3mmm", ("triple m melbourne", "mmm melbourne", "triple m", "3mmm")),
    Station("triple_m_brisbane", "Triple M Brisbane", "4mmm", ("triple m brisbane", "mmm brisbane", "4mmm")),
    Station("triple_m_adelaide", "Triple M Adelaide", "5ddd", ("triple m adelaide", "mmm adelaide", "5ddd")),
    Station("triple_m_perth", "Triple M Perth", "6ppp", ("triple m perth", "mmm perth", "6ppp")),
    Station("fox_melbourne", "FOX Melbourne", "2fox", ("fox fm", "fox melbourne", "fox", "2fox")),
    Station("today_fm_sydney", "2Day FM Sydney", "2day", ("2day fm", "today fm", "today fm sydney", "2day", "hit sydney")),
    Station("b105_brisbane", "B105 Brisbane", "4bbb", ("b105", "b105 brisbane", "4bbb", "hit brisbane")),
    Station("safm_adelaide", "SAFM Adelaide", "5saf", ("safm", "safm adelaide", "5saf", "hit adelaide")),
    Station("mix_945_perth", "Mix 94.5 Perth", "6mix", ("mix 94 5", "mix 94.5", "mix perth", "6mix", "hit perth")),
    Station("sen_melbourne", "SEN Melbourne", "1116sen", ("sen", "sen melbourne", "s e n", "1116sen")),
    Station("sen_sydney", "SEN Sydney", "1170sen", ("sen sydney", "1170 sen", "1170sen")),
    Station("sen_adelaide", "SEN Adelaide", "1629sen", ("sen adelaide", "1629 sen", "1629sen")),
    Station("sen_brisbane", "SEN Brisbane", "693sen", ("sen brisbane", "693 sen", "693sen")),
    Station("sen_perth", "SEN Perth", "657sen", ("sen perth", "657 sen", "657sen")),
)


def _normalize(value: str) -> str:
    return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in value).split())


def find_station(query: str) -> Station | None:
    needle = _normalize(query)
    if not needle:
        return None

    for station in STATIONS:
        if needle == station.callsign.lower() or needle == _normalize(station.name):
            return station
        if any(needle == _normalize(alias) for alias in station.aliases):
            return station

    # Fuzzy contains fallback.
    for station in STATIONS:
        if needle in _normalize(station.name):
            return station
        if any(needle in _normalize(alias) for alias in station.aliases):
            return station

    return None
