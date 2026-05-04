"""
Canvas UI Platform — Companion HA Integration

Registers a native HA panel (embed_iframe=False) so the platform SPA runs
inside Home Assistant's own document context. This gives Lovelace card widgets
direct access to window.hass and the customElements registry.

Also sets up device/entity integration when a platform API URL is configured.
"""
import logging
import os
import time

from homeassistant.components import panel_custom
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType

from .const import CONF_API_URL, DOMAIN
from .coordinator import CanvasUIPlatformCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SELECT, Platform.TEXT]

_PANEL_REGISTERED = False
_STATIC_REGISTERED = False


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Set up Canvas UI Platform companion integration."""
    _LOGGER.info("Canvas UI Platform companion integration starting up")
    hass.data.setdefault(DOMAIN, {})
    await _register_static_files(hass)
    await _register_panel(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up from a config entry (UI-configured)."""
    hass.data.setdefault(DOMAIN, {})

    await _register_static_files(hass)
    await _register_panel(hass)

    api_url = entry.data.get(CONF_API_URL) or entry.options.get(CONF_API_URL)
    if api_url:
        coordinator = CanvasUIPlatformCoordinator(hass, api_url)
        await coordinator.async_config_entry_first_refresh()
        hass.data[DOMAIN][entry.entry_id] = {"coordinator": coordinator}
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    else:
        hass.data[DOMAIN][entry.entry_id] = {}

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload entry when options change."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    entry_data = hass.data[DOMAIN].get(entry.entry_id, {})
    coordinator: CanvasUIPlatformCoordinator | None = entry_data.get("coordinator")

    unload_ok = True
    if coordinator:
        unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
        await coordinator.async_shutdown()

    hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def _register_static_files(hass: HomeAssistant) -> None:
    """Serve the panel JS from this component directory."""
    global _STATIC_REGISTERED
    if _STATIC_REGISTERED:
        return
    _STATIC_REGISTERED = True

    component_path = os.path.dirname(__file__)

    try:
        from homeassistant.components.http import StaticPathConfig
        await hass.http.async_register_static_paths([
            StaticPathConfig(
                "/canvas-ui-platform-static",
                component_path,
                cache_headers=False,
            )
        ])
        _LOGGER.info("Canvas UI Platform static files registered at /canvas-ui-platform-static")
    except (ImportError, AttributeError):
        hass.http.register_static_path(
            "/canvas-ui-platform-static",
            component_path,
            cache_headers=False,
        )
        _LOGGER.info("Canvas UI Platform static files registered (legacy)")


async def _register_panel(hass: HomeAssistant) -> None:
    """Register the Canvas UI Platform sidebar panel."""
    global _PANEL_REGISTERED
    if _PANEL_REGISTERED:
        return
    _PANEL_REGISTERED = True

    ts = int(time.time())
    module_url = f"/canvas-ui-platform-static/canvas-ui-platform-panel.js?v={ts}"

    try:
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path="canvas-ui-platform",
            webcomponent_name="canvas-ui-platform-panel",
            sidebar_title="Canvas UI Platform",
            sidebar_icon="mdi:monitor-dashboard",
            module_url=module_url,
            # embed_iframe=False is critical — the panel element runs in HA's
            # own document so the SPA gets native window.hass and customElements
            embed_iframe=False,
            require_admin=False,
        )
        _LOGGER.info("Canvas UI Platform panel registered (embed_iframe=False)")
    except Exception as e:
        _LOGGER.warning("Canvas UI Platform panel registration: %s", e)
