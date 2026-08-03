from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncGenerator, Sequence

from music_assistant_models.enums import ContentType, MediaType, StreamType
from music_assistant_models.errors import MediaNotFoundError
from music_assistant_models.media_items import (
    AudioFormat,
    BrowseFolder,
    ItemMapping,
    ProviderMapping,
    Radio,
    SearchResults,
)
from music_assistant_models.streamdetails import MultiPartPath, StreamDetails

from music_assistant.models.music_provider import MusicProvider

from .constants import (
    CONF_CLIENT_ID,
    CONF_CLIENT_SECRET,
    CONF_SCOPE,
    CONF_SUBJECT,
    CONF_TOKEN_ENDPOINT,
    CONF_VALIDATE_TOKEN_ON_START,
)
from .catalog import STATIONS, Station
from .discovery import discover_stations
from .streams import resolve_stream_url, stream_candidates
from .token_provider import TokenResponse, issue_token


class ListnrProvider(MusicProvider):
    """LiSTNR radio provider implementation."""

    _station_cache_ttl_seconds = 6 * 60 * 60
    _token_response: TokenResponse | None = None
    _token_expires_at: float = 0
    _stations_cache: tuple[Station, ...] | None = None
    _stations_expires_at: float = 0
    _station_discovery_warning_logged: bool = False

    async def loaded_in_mass(self) -> None:
        """Optionally validate token config during provider startup."""
        should_validate = bool(self.config.get_value(CONF_VALIDATE_TOKEN_ON_START))
        if should_validate:
            if not self._has_credentials:
                self.logger.warning(
                    "Token validation enabled but credentials are incomplete; continuing with direct stream mode"
                )
            else:
                try:
                    await self._ensure_token(force_refresh=True)
                    self.logger.info("LiSTNR token validation succeeded")
                except Exception as err:  # noqa: BLE001
                    self.logger.warning("LiSTNR token validation failed: %s", err)

        # Warm the station cache at startup so browse/search can show newly added stations.
        await self._get_stations(force_refresh=True)

    @property
    def is_streaming_provider(self) -> bool:
        """Return True because this provider serves remote live streams."""
        return True

    async def search(
        self,
        search_query: str,
        media_types: list[MediaType],
        limit: int = 5,
    ) -> SearchResults:
        """Search station catalog by station name/aliases."""
        if MediaType.RADIO not in media_types:
            return SearchResults()

        needle = (search_query or "").strip()
        if not needle:
            return SearchResults(radio=[])

        stations = await self._get_stations()
        exact = self._find_station(needle, stations)
        if exact is not None:
            return SearchResults(radio=[self._to_radio(exact)])

        hits: list[Radio] = []
        query = needle.lower()
        for station in stations:
            haystack = " ".join((station.name, station.callsign, *station.aliases)).lower()
            if query in haystack:
                hits.append(self._to_radio(station))
                if len(hits) >= limit:
                    break

        return SearchResults(radio=hits)

    async def get_library_radios(self) -> AsyncGenerator[Radio]:
        """Expose LiSTNR stations as provider radios for discovery and play."""
        for station in await self._get_stations():
            yield self._to_radio(station)

    async def get_radio(self, prov_radio_id: str) -> Radio:
        """Return radio details by station key."""
        station = next((s for s in await self._get_stations() if s.key == prov_radio_id), None)
        if station is None:
            raise MediaNotFoundError(f"Unknown station: {prov_radio_id}")
        return self._to_radio(station)

    async def get_stream_details(self, item_id: str, media_type: MediaType) -> StreamDetails:
        """Resolve stream details for a LiSTNR station."""
        if media_type != MediaType.RADIO:
            raise MediaNotFoundError(f"Unsupported media type: {media_type}")

        station = next((s for s in await self._get_stations() if s.key == item_id), None)
        if station is None:
            raise MediaNotFoundError(f"Unknown station: {item_id}")

        candidates = stream_candidates(station.callsign)
        preferred = await asyncio.to_thread(resolve_stream_url, station.callsign)
        if preferred:
            candidates = [preferred, *(url for url in candidates if url != preferred)]

        if not candidates:
            raise MediaNotFoundError(f"No stream URL candidates for station: {station.name}")

        # Token acquisition is optional right now and acts as a preflight for future
        # authenticated stream paths. Playback continues with direct URLs if token
        # retrieval fails.
        if self._has_credentials:
            try:
                await self._ensure_token(force_refresh=False)
            except Exception as err:  # noqa: BLE001
                self.logger.debug("LiSTNR token fetch skipped for direct stream fallback: %s", err)

        return StreamDetails(
            provider=self.instance_id,
            item_id=item_id,
            audio_format=AudioFormat(content_type=ContentType.UNKNOWN),
            media_type=MediaType.RADIO,
            stream_type=StreamType.HTTP,
            path=[MultiPartPath(path=url) for url in candidates],
            can_seek=False,
            allow_seek=False,
            duration=0,
        )

    async def browse(self, path: str) -> Sequence[Radio | BrowseFolder | ItemMapping]:
        """Expose all stations under a flat browse path."""
        if path and path not in ("/", "root", "listnr"):
            return []
        return [self._to_radio(station) for station in await self._get_stations()]

    def _to_radio(self, station: Station) -> Radio:
        """Convert internal station metadata to Music Assistant Radio item."""
        candidates = stream_candidates(station.callsign)
        stream_preview = candidates[0] if candidates else None
        return Radio(
            item_id=station.key,
            provider=self.instance_id,
            name=station.name,
            provider_mappings={
                ProviderMapping(
                    item_id=station.key,
                    provider_domain=self.domain,
                    provider_instance=self.instance_id,
                    url=stream_preview,
                )
            },
        )

    @property
    def _has_credentials(self) -> bool:
        """Return True when provider config includes token provider credentials."""
        client_id = str(self.config.get_value(CONF_CLIENT_ID) or "").strip()
        client_secret = str(self.config.get_value(CONF_CLIENT_SECRET) or "").strip()
        subject = str(self.config.get_value(CONF_SUBJECT) or "").strip()
        return bool(client_id and client_secret and subject)

    async def _ensure_token(self, force_refresh: bool = False) -> TokenResponse:
        """Get a cached token or issue a fresh one via LiSTNR token provider."""
        now = time.time()
        if (
            not force_refresh
            and self._token_response is not None
            and now < self._token_expires_at
        ):
            return self._token_response

        client_id = str(self.config.get_value(CONF_CLIENT_ID) or "").strip()
        client_secret = str(self.config.get_value(CONF_CLIENT_SECRET) or "").strip()
        subject = str(self.config.get_value(CONF_SUBJECT) or "").strip()
        scope = str(self.config.get_value(CONF_SCOPE) or "").strip()
        endpoint = str(
            self.config.get_value(CONF_TOKEN_ENDPOINT)
            or "https://token-provider.api.listnr.com/v1/issue-token"
        ).strip()

        if not (client_id and client_secret and subject):
            raise ValueError("Missing LiSTNR token provider credentials")

        token = await asyncio.to_thread(
            issue_token,
            client_id=client_id,
            client_secret=client_secret,
            subject=subject,
            scope=scope,
            endpoint=endpoint,
        )
        self._token_response = token
        self._token_expires_at = now + max(30, token.expires_in - 60)
        return token

    async def _get_stations(self, force_refresh: bool = False) -> tuple[Station, ...]:
        """Return discovered station list with a static fallback on failure."""
        now = time.time()
        if (
            not force_refresh
            and self._stations_cache is not None
            and now < self._stations_expires_at
        ):
            return self._stations_cache

        fallback = self._stations_cache or STATIONS
        try:
            stations = await asyncio.to_thread(discover_stations, STATIONS)
            self._stations_cache = stations
            self._stations_expires_at = now + self._station_cache_ttl_seconds
            self._station_discovery_warning_logged = False
            self.logger.debug("LiSTNR station discovery loaded %d stations", len(stations))
            return stations
        except Exception as err:  # noqa: BLE001
            if not self._station_discovery_warning_logged:
                self.logger.warning(
                    "LiSTNR station discovery failed; using fallback catalog: %s", err
                )
                self._station_discovery_warning_logged = True

            self._stations_cache = fallback
            self._stations_expires_at = now + (15 * 60)
            return fallback

    @staticmethod
    def _normalize(value: str) -> str:
        return " ".join("".join(ch.lower() if ch.isalnum() else " " for ch in value).split())

    def _find_station(self, query: str, stations: Sequence[Station]) -> Station | None:
        needle = self._normalize(query)
        if not needle:
            return None

        for station in stations:
            if needle == station.callsign.lower() or needle == self._normalize(station.name):
                return station
            if any(needle == self._normalize(alias) for alias in station.aliases):
                return station

        for station in stations:
            if needle in self._normalize(station.name):
                return station
            if any(needle in self._normalize(alias) for alias in station.aliases):
                return station

        return None
