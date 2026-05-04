"""Sensor entities for Canvas Display — server status."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import CanvasDisplayCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: CanvasDisplayCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([ServerStatusSensor(coordinator, entry.entry_id)])


class ServerStatusSensor(CoordinatorEntity[CanvasDisplayCoordinator], SensorEntity):
    """Sensor showing whether the Canvas Display server is online."""

    _attr_has_entity_name = True
    _attr_name = "Server Status"
    _attr_icon = "mdi:server"

    def __init__(self, coordinator: CanvasDisplayCoordinator, entry_id: str) -> None:
        super().__init__(coordinator)
        self._entry_id = entry_id
        self._attr_unique_id = f"canvas_display_{entry_id}_server_status"

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
    def native_value(self) -> str:
        return "online" if self.coordinator.data.get("online", False) else "offline"
