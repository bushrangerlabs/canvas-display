"""Config flow for Canvas Display integration."""
import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv

from .const import CONF_API_TOKEN, CONF_API_URL, DOMAIN


class CanvasDisplayConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Config flow for Canvas Display."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        errors: dict[str, str] = {}

        if user_input is not None:
            api_url = user_input[CONF_API_URL].rstrip("/")
            api_token = user_input.get(CONF_API_TOKEN, "")
            error = await _test_connection(api_url, api_token)
            if error:
                errors["base"] = error
            else:
                # Use device_name from server as the entry title
                title = await _get_device_name(api_url, api_token) or "Canvas Display"
                return self.async_create_entry(title=title, data={CONF_API_URL: api_url, CONF_API_TOKEN: api_token})

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Required(CONF_API_URL): cv.string,
                vol.Required(CONF_API_TOKEN): cv.string,
            }),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return CanvasDisplayOptionsFlow(config_entry)


class CanvasDisplayOptionsFlow(config_entries.OptionsFlow):
    """Allow changing the API URL after setup."""

    async def async_step_init(self, user_input=None):
        errors: dict[str, str] = {}

        if user_input is not None:
            api_url = user_input[CONF_API_URL].rstrip("/")
            api_token = user_input.get(CONF_API_TOKEN, "")
            error = await _test_connection(api_url, api_token)
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(title="", data={CONF_API_URL: api_url, CONF_API_TOKEN: api_token})

        current_url = self.config_entry.data.get(CONF_API_URL, "")
        current_token = self.config_entry.data.get(CONF_API_TOKEN, "")
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Required(CONF_API_URL, default=current_url): cv.string,
                vol.Required(CONF_API_TOKEN, default=current_token): cv.string,
            }),
            errors=errors,
        )


async def _test_connection(api_url: str, api_token: str) -> str | None:
    """Return error key if connection fails, None if OK."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{api_url}/api/admin/devices",
                headers={"Authorization": f"Bearer {api_token}"},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    return "cannot_connect"
    except aiohttp.ClientError:
        return "cannot_connect"
    return None


async def _get_device_name(api_url: str, api_token: str) -> str | None:
    """Fetch device_name from /api/settings to use as entry title."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{api_url}/api/settings",
                headers={"Authorization": f"Bearer {api_token}"},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("device_name")
    except Exception:
        pass
    return None
