"""Select entity — active page per Canvas UI Platform device."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.select import SelectEntity
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

    entities: list[DeviceActivePageSelect] = []
    for device in coordinator.data["devices"].values():
        entities.append(DeviceActivePageSelect(coordinator, device["id"]))

    async_add_entities(entities)

    @callback
    def _handle_coordinator_update() -> None:
        """Add entities for newly discovered devices."""
        known = {e.device_id for e in entities}
        new = []
        for device_id in coordinator.data["devices"]:
            if device_id not in known:
                e = DeviceActivePageSelect(coordinator, device_id)
                entities.append(e)
                new.append(e)
        if new:
            async_add_entities(new)

    entry.async_on_unload(coordinator.async_add_listener(_handle_coordinator_update))


def _slugify(name: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


class DeviceActivePageSelect(CoordinatorEntity[CanvasUIPlatformCoordinator], SelectEntity):
    """Select entity that controls which page is displayed on a device."""

    _attr_has_entity_name = True
    _attr_name = "Active Page"
    _attr_icon = "mdi:monitor"

    def __init__(self, coordinator: CanvasUIPlatformCoordinator, device_id: str) -> None:
        super().__init__(coordinator)
        self.device_id = device_id
        self._attr_unique_id = f"canvas_display_{device_id}_active_page"

    @property
    def _device(self) -> dict[str, Any]:
        return self.coordinator.data["devices"][self.device_id]

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
    def options(self) -> list[str]:
        return [p["name"] for p in self.coordinator.data["pages"].values()]

    @property
    def current_option(self) -> str | None:
        page_id = self._device.get("assigned_page_id")
        if not page_id:
            return None
        page = self.coordinator.data["pages"].get(page_id)
        return page["name"] if page else None

    @property
    def available(self) -> bool:
        return self.device_id in self.coordinator.data["devices"]

    async def async_select_option(self, option: str) -> None:
        """Switch the device to the selected page."""
        page = next(
            (p for p in self.coordinator.data["pages"].values() if p["name"] == option),
            None,
        )
        if page is None:
            _LOGGER.warning("Page '%s' not found", option)
            return
        await self.coordinator.async_set_device_page(self.device_id, page["id"])
        await self.coordinator.async_request_refresh()
