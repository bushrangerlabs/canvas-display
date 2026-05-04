"""Select entity — active page for the Canvas Display device."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import CanvasDisplayCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: CanvasDisplayCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([ActivePageSelect(coordinator, entry.entry_id)])


class ActivePageSelect(CoordinatorEntity[CanvasDisplayCoordinator], SelectEntity):
    """Select entity that controls which page is displayed."""

    _attr_has_entity_name = True
    _attr_name = "Active Page"
    _attr_icon = "mdi:monitor"

    def __init__(self, coordinator: CanvasDisplayCoordinator, entry_id: str) -> None:
        super().__init__(coordinator)
        self._entry_id = entry_id
        self._attr_unique_id = f"canvas_display_{entry_id}_active_page"

    @property
    def device_info(self) -> DeviceInfo:
        settings = self.coordinator.data.get("settings", {})
        device_name = settings.get("device_name", "Canvas Display")
        return DeviceInfo(
            identifiers={(DOMAIN, self._entry_id)},
            name=device_name,
            manufacturer="Canvas Display",
            model="Kiosk",
            configuration_url=self.coordinator.api_url,
        )

    @property
    def options(self) -> list[str]:
        return [p["name"] for p in self.coordinator.data.get("pages", {}).values()]

    @property
    def current_option(self) -> str | None:
        settings = self.coordinator.data.get("settings", {})
        active_page_id = settings.get("active_page_id")
        if not active_page_id:
            return None
        page = self.coordinator.data.get("pages", {}).get(active_page_id)
        return page["name"] if page else None

    @property
    def available(self) -> bool:
        return self.coordinator.data.get("online", False)

    async def async_select_option(self, option: str) -> None:
        """Switch to the selected page."""
        page_id = self.coordinator.data.get("page_names", {}).get(option)
        if page_id is None:
            _LOGGER.warning("Canvas Display: page '%s' not found", option)
            return
        await self.coordinator.async_push_page(page_id)
        await self.coordinator.async_request_refresh()
