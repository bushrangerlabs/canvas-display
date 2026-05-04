"""Text entities — panel URL per device/page/panel slot."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.text import TextEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import CanvasUIPlatformCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: CanvasUIPlatformCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]

    entities: list[PanelUrlText] = []
    known_keys: set[str] = set()

    def _build_entities() -> list[PanelUrlText]:
        new = []
        for device in coordinator.data["devices"].values():
            for page in coordinator.data["pages"].values():
                for panel in page.get("panels", []):
                    key = f"{device['id']}_{panel['id']}"
                    if key not in known_keys:
                        known_keys.add(key)
                        new.append(PanelUrlText(coordinator, device["id"], page["id"], panel["id"]))
        return new

    entities.extend(_build_entities())
    async_add_entities(entities)

    @callback
    def _handle_coordinator_update() -> None:
        new = _build_entities()
        if new:
            async_add_entities(new)
            entities.extend(new)

    entry.async_on_unload(coordinator.async_add_listener(_handle_coordinator_update))


class PanelUrlText(CoordinatorEntity[CanvasUIPlatformCoordinator], TextEntity):
    """Text entity representing the live URL of one panel slot."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:web"
    _attr_native_max = 2048
    _attr_native_min = 0
    _attr_pattern = None

    def __init__(
        self,
        coordinator: CanvasUIPlatformCoordinator,
        device_id: str,
        page_id: str,
        panel_id: str,
    ) -> None:
        super().__init__(coordinator)
        self.device_id = device_id
        self.page_id = page_id
        self.panel_id = panel_id
        self._attr_unique_id = f"canvas_display_{device_id}_{page_id}_{panel_id}_url"
        self._live_url: str | None = None  # tracks last value set via HA (ephemeral)

    @property
    def _device(self) -> dict[str, Any]:
        return self.coordinator.data["devices"][self.device_id]

    @property
    def _page(self) -> dict[str, Any] | None:
        return self.coordinator.data["pages"].get(self.page_id)

    @property
    def _panel(self) -> dict[str, Any] | None:
        page = self._page
        if not page:
            return None
        return next((p for p in page.get("panels", []) if p["id"] == self.panel_id), None)

    @property
    def name(self) -> str:
        page = self._page
        panel = self._panel
        page_name = page["name"] if page else self.page_id
        panel_name = panel["name"] if panel else self.panel_id
        return f"{page_name} · {panel_name} URL"

    @property
    def device_info(self) -> DeviceInfo:
        d = self._device
        return DeviceInfo(
            identifiers={(DOMAIN, self.device_id)},
            name=d.get("name", self.device_id),
            manufacturer="Canvas UI Platform",
            model=d.get("platform", "kiosk"),
        )

    @property
    def native_value(self) -> str:
        # Prefer the last URL we pushed (ephemeral); fall back to stored panel URL
        if self._live_url is not None:
            return self._live_url
        panel = self._panel
        return (panel.get("url") or "") if panel else ""

    @property
    def available(self) -> bool:
        return (
            self.device_id in self.coordinator.data["devices"]
            and self._panel is not None
        )

    async def async_set_value(self, value: str) -> None:
        """Send a live navigate_panel command to the device."""
        await self.coordinator.async_navigate_panel(self.device_id, self.panel_id, value)
        self._live_url = value
        self.async_write_ha_state()
