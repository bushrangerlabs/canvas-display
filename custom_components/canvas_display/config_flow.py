"""Config flow for Canvas UI Platform companion integration."""
import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import config_validation as cv

from .const import CONF_API_URL, DEFAULT_API_URL, DOMAIN


class CanvasUIPlatformConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Config flow for Canvas UI Platform."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        errors: dict[str, str] = {}

        if user_input is not None:
            api_url = user_input[CONF_API_URL].rstrip("/")
            error = await _test_connection(api_url)
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title="Canvas UI Platform",
                    data={CONF_API_URL: api_url},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Required(CONF_API_URL, default=DEFAULT_API_URL): cv.string,
            }),
            errors=errors,
        )

    async def async_step_import(self, _):
        """Handle YAML import."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        return self.async_create_entry(
            title="Canvas UI Platform",
            data={CONF_API_URL: DEFAULT_API_URL},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return CanvasUIPlatformOptionsFlow(config_entry)


class CanvasUIPlatformOptionsFlow(config_entries.OptionsFlow):
    """Allow changing the API URL after setup."""

    async def async_step_init(self, user_input=None):
        errors: dict[str, str] = {}

        if user_input is not None:
            api_url = user_input[CONF_API_URL].rstrip("/")
            error = await _test_connection(api_url)
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(title="", data={CONF_API_URL: api_url})

        current_url = self.config_entry.data.get(CONF_API_URL, DEFAULT_API_URL)
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Required(CONF_API_URL, default=current_url): cv.string,
            }),
            errors=errors,
        )


async def _test_connection(api_url: str) -> str | None:
    """Return error key string if connection fails, None if OK."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{api_url}/api/devices",
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    return "cannot_connect"
    except aiohttp.ClientError:
        return "cannot_connect"
    return None
