"""Canvas Display — Home Assistant integration."""
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import CONF_API_URL, DOMAIN
from .coordinator import CanvasDisplayCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SELECT, Platform.SENSOR]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Canvas Display from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    api_url = entry.data.get(CONF_API_URL) or entry.options.get(CONF_API_URL)
    coordinator = CanvasDisplayCoordinator(hass, api_url)
    await coordinator.async_config_entry_first_refresh()

    hass.data[DOMAIN][entry.entry_id] = {"coordinator": coordinator}
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    entry_data = hass.data[DOMAIN].get(entry.entry_id, {})
    coordinator: CanvasDisplayCoordinator | None = entry_data.get("coordinator")

    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if coordinator:
        await coordinator.async_shutdown()

    hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok
