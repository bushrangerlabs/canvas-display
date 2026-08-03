"""Canvas Display — Home Assistant integration."""
import logging

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import CONF_API_TOKEN, CONF_API_URL, DOMAIN
from .coordinator import CanvasDisplayCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SELECT, Platform.SENSOR]

SERVICE_SET_PAGE = "set_page"
SERVICE_NAVIGATE_PANEL = "navigate_panel"
SERVICE_RELOAD = "reload"
SERVICE_QUIT = "quit"
SERVICE_LOAD_DEVICE_PAGE = "load_device_page"
SERVICE_PAGE_BACK = "page_back"
SERVICE_LOAD_PANEL_URL = "load_panel_url"
SERVICE_LOAD_PANEL_SCENE = "load_panel_scene"
SERVICE_SET_PANEL_VISIBILITY = "set_panel_visibility"


def _get_coordinators(hass: HomeAssistant, device_name: str | None) -> list[CanvasDisplayCoordinator]:
    """Return coordinators matching device_name (or all if None/empty)."""
    entries = hass.data.get(DOMAIN, {})
    coordinators = [v["coordinator"] for v in entries.values() if "coordinator" in v]
    if not device_name:
        return coordinators
    name_lower = device_name.strip().lower()
    return [c for c in coordinators if (c.data or {}).get("settings", {}).get("device_name", "").lower() == name_lower]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {})

    async def handle_set_page(call: ServiceCall) -> None:
        page = call.data["page"]
        device_name = call.data.get("device_name")
        for coordinator in _get_coordinators(hass, device_name):
            try:
                await coordinator.async_set_page(page)
            except Exception as err:
                _LOGGER.error("set_page failed for %s: %s", coordinator.api_url, err)

    async def handle_navigate_panel(call: ServiceCall) -> None:
        panel = call.data["panel"]
        url = call.data["url"]
        page = call.data.get("page")
        device_name = call.data.get("device_name")
        for coordinator in _get_coordinators(hass, device_name):
            try:
                await coordinator.async_navigate_panel(panel, url, page)
            except Exception as err:
                _LOGGER.error("navigate_panel failed for %s: %s", coordinator.api_url, err)

    async def handle_reload(call: ServiceCall) -> None:
        device_name = call.data.get("device_name")
        for coordinator in _get_coordinators(hass, device_name):
            try:
                await coordinator.async_reload()
            except Exception as err:
                _LOGGER.error("reload failed for %s: %s", coordinator.api_url, err)

    async def handle_quit(call: ServiceCall) -> None:
        device_name = call.data.get("device_name")
        for coordinator in _get_coordinators(hass, device_name):
            try:
                await coordinator.async_quit()
            except Exception as err:
                _LOGGER.error("quit failed for %s: %s", coordinator.api_url, err)

    async def handle_load_device_page(call: ServiceCall) -> None:
        for coordinator in _get_coordinators(hass, call.data.get("device_name")):
            await coordinator.async_load_device_page(call.data["device_id"], call.data["page"])

    async def handle_page_back(call: ServiceCall) -> None:
        for coordinator in _get_coordinators(hass, call.data.get("device_name")):
            await coordinator.async_device_page_back(call.data["device_id"])

    async def handle_load_panel_url(call: ServiceCall) -> None:
        for coordinator in _get_coordinators(hass, call.data.get("device_name")):
            await coordinator.async_patch_device_panel(
                call.data["device_id"], call.data["panel"], content_type="url", url=call.data["url"]
            )

    async def handle_load_panel_scene(call: ServiceCall) -> None:
        for coordinator in _get_coordinators(hass, call.data.get("device_name")):
            await coordinator.async_patch_device_panel(
                call.data["device_id"], call.data["panel"], content_type="scene", scene_id=call.data["scene"]
            )

    async def handle_set_panel_visibility(call: ServiceCall) -> None:
        for coordinator in _get_coordinators(hass, call.data.get("device_name")):
            await coordinator.async_patch_device_panel(
                call.data["device_id"], call.data["panel"], visible=call.data["visible"]
            )

    hass.services.async_register(
        DOMAIN, SERVICE_SET_PAGE, handle_set_page,
        schema=vol.Schema({
            vol.Required("page"): cv.string,
            vol.Optional("device_name"): cv.string,
        }),
    )
    hass.services.async_register(
        DOMAIN, SERVICE_NAVIGATE_PANEL, handle_navigate_panel,
        schema=vol.Schema({
            vol.Required("panel"): cv.string,
            vol.Required("url"): cv.string,
            vol.Optional("page"): cv.string,
            vol.Optional("device_name"): cv.string,
        }),
    )
    hass.services.async_register(
        DOMAIN, SERVICE_RELOAD, handle_reload,
        schema=vol.Schema({vol.Optional("device_name"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN, SERVICE_QUIT, handle_quit,
        schema=vol.Schema({vol.Optional("device_name"): cv.string}),
    )
    target_schema = {
        vol.Required("device_id"): cv.string,
        vol.Optional("device_name"): cv.string,
    }
    hass.services.async_register(
        DOMAIN, SERVICE_LOAD_DEVICE_PAGE, handle_load_device_page,
        schema=vol.Schema({**target_schema, vol.Required("page"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN, SERVICE_PAGE_BACK, handle_page_back,
        schema=vol.Schema(target_schema),
    )
    hass.services.async_register(
        DOMAIN, SERVICE_LOAD_PANEL_URL, handle_load_panel_url,
        schema=vol.Schema({
            **target_schema, vol.Required("panel"): cv.string, vol.Required("url"): cv.url,
        }),
    )
    hass.services.async_register(
        DOMAIN, SERVICE_LOAD_PANEL_SCENE, handle_load_panel_scene,
        schema=vol.Schema({
            **target_schema, vol.Required("panel"): cv.string, vol.Required("scene"): cv.string,
        }),
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_PANEL_VISIBILITY, handle_set_panel_visibility,
        schema=vol.Schema({
            **target_schema, vol.Required("panel"): cv.string, vol.Required("visible"): cv.boolean,
        }),
    )

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Canvas Display from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    api_url = entry.data.get(CONF_API_URL) or entry.options.get(CONF_API_URL)
    api_token = entry.data.get(CONF_API_TOKEN) or entry.options.get(CONF_API_TOKEN, "")
    coordinator = CanvasDisplayCoordinator(hass, api_url, api_token)
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
