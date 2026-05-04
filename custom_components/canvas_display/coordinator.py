"""DataUpdateCoordinator for Canvas Display — fetches settings and pages."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

SCAN_INTERVAL = timedelta(seconds=30)


class CanvasDisplayCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls the Canvas Display server for settings and pages."""

    def __init__(self, hass: HomeAssistant, api_url: str) -> None:
        self.api_url = api_url.rstrip("/")
        self._session: aiohttp.ClientSession | None = None
        super().__init__(
            hass,
            _LOGGER,
            name="Canvas Display",
            update_interval=SCAN_INTERVAL,
        )

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch settings and pages from the Canvas Display API."""
        session = self._get_session()
        try:
            async with session.get(
                f"{self.api_url}/health",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                online = resp.status == 200

            async with session.get(
                f"{self.api_url}/api/settings",
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    raise UpdateFailed(f"Settings API returned {resp.status}")
                settings: dict = await resp.json()

            async with session.get(
                f"{self.api_url}/api/pages",
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    raise UpdateFailed(f"Pages API returned {resp.status}")
                pages: list[dict] = await resp.json()

        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Cannot connect to Canvas Display at {self.api_url}: {err}") from err

        return {
            "online": online,
            "settings": settings,
            "pages": {p["id"]: p for p in pages},
            "page_names": {p["name"]: p["id"] for p in pages},
        }

    async def async_push_page(self, page_id: str) -> None:
        """POST /api/pages/{id}/push — activates page on the kiosk."""
        session = self._get_session()
        async with session.post(
            f"{self.api_url}/api/pages/{page_id}/push",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status not in (200, 204):
                raise Exception(f"Failed to push page: HTTP {resp.status}")

    async def async_shutdown(self) -> None:
        """Close the aiohttp session on unload."""
        if self._session and not self._session.closed:
            await self._session.close()
