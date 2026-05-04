"""DataUpdateCoordinator for Canvas UI Platform — fetches devices and pages."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

_LOGGER = logging.getLogger(__name__)

SCAN_INTERVAL = timedelta(seconds=30)


class CanvasUIPlatformCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls the Canvas UI Platform server for devices and pages."""

    def __init__(self, hass: HomeAssistant, api_url: str) -> None:
        self.api_url = api_url.rstrip("/")
        self._session: aiohttp.ClientSession | None = None
        super().__init__(
            hass,
            _LOGGER,
            name="Canvas UI Platform",
            update_interval=SCAN_INTERVAL,
        )

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch devices and pages from the platform API."""
        session = self._get_session()
        try:
            async with session.get(
                f"{self.api_url}/api/devices", timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status != 200:
                    raise UpdateFailed(f"Devices API returned {resp.status}")
                devices: list[dict] = await resp.json()

            async with session.get(
                f"{self.api_url}/api/pages", timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status != 200:
                    raise UpdateFailed(f"Pages API returned {resp.status}")
                pages: list[dict] = await resp.json()

        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Cannot connect to Canvas UI Platform at {self.api_url}: {err}") from err

        return {
            "devices": {d["id"]: d for d in devices},
            "pages": {p["id"]: p for p in pages},
        }

    async def async_set_device_page(self, device_id: str, page_id: str) -> None:
        """PATCH assigned_page_id on a device (server pushes load_page to kiosk)."""
        session = self._get_session()
        async with session.patch(
            f"{self.api_url}/api/devices/{device_id}",
            json={"assigned_page_id": page_id},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status not in (200, 204):
                raise Exception(f"Failed to set page: HTTP {resp.status}")

    async def async_navigate_panel(self, device_id: str, panel_id: str, url: str) -> None:
        """Send a navigate_panel command to a device (live, ephemeral)."""
        session = self._get_session()
        async with session.post(
            f"{self.api_url}/api/devices/{device_id}/command",
            json={"action": "navigate_panel", "payload": {"panel_id": panel_id, "url": url}},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status not in (200, 202):
                raise Exception(f"Failed to send navigate_panel: HTTP {resp.status}")

    async def async_shutdown(self) -> None:
        """Close the aiohttp session on unload."""
        if self._session and not self._session.closed:
            await self._session.close()
