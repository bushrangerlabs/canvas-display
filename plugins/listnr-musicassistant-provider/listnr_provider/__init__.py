"""LiSTNR Music Provider for Music Assistant."""

from __future__ import annotations

from typing import TYPE_CHECKING

from music_assistant_models.config_entries import ConfigEntry, ConfigValueType
from music_assistant_models.enums import ConfigEntryType, ProviderFeature

from .constants import (
    CONF_CLIENT_ID,
    CONF_CLIENT_SECRET,
    CONF_SCOPE,
    CONF_SUBJECT,
    CONF_TOKEN_ENDPOINT,
    CONF_VALIDATE_TOKEN_ON_START,
)
from .provider import ListnrProvider

if TYPE_CHECKING:
    from music_assistant_models.config_entries import ProviderConfig
    from music_assistant_models.provider import ProviderManifest

    from music_assistant import MusicAssistant
    from music_assistant.models import ProviderInstanceType

SUPPORTED_FEATURES = {
    ProviderFeature.BROWSE,
    ProviderFeature.SEARCH,
    ProviderFeature.LIBRARY_RADIOS,
}


async def setup(
    mass: MusicAssistant, manifest: ProviderManifest, config: ProviderConfig
) -> ProviderInstanceType:
    """Initialize provider instance."""
    return ListnrProvider(mass, manifest, config, SUPPORTED_FEATURES)


async def get_config_entries(
    mass: MusicAssistant,  # noqa: ARG001
    instance_id: str | None = None,  # noqa: ARG001
    action: str | None = None,  # noqa: ARG001
    values: dict[str, ConfigValueType] | None = None,
) -> tuple[ConfigEntry, ...]:
    """Return Config entries to set up this provider."""
    values = values or {}
    return (
        ConfigEntry(
            key=CONF_CLIENT_ID,
            label="Client ID",
            type=ConfigEntryType.STRING,
            required=False,
            value=values.get(CONF_CLIENT_ID),
            advanced=True,
        ),
        ConfigEntry(
            key=CONF_CLIENT_SECRET,
            label="Client Secret",
            type=ConfigEntryType.SECURE_STRING,
            required=False,
            value=values.get(CONF_CLIENT_SECRET),
            advanced=True,
        ),
        ConfigEntry(
            key=CONF_SUBJECT,
            label="Token Subject",
            type=ConfigEntryType.STRING,
            required=False,
            value=values.get(CONF_SUBJECT),
            advanced=True,
        ),
        ConfigEntry(
            key=CONF_SCOPE,
            label="Token Scope",
            type=ConfigEntryType.STRING,
            required=False,
            default_value="",
            value=values.get(CONF_SCOPE),
            advanced=True,
        ),
        ConfigEntry(
            key=CONF_TOKEN_ENDPOINT,
            label="Token Endpoint",
            type=ConfigEntryType.STRING,
            required=False,
            default_value="https://token-provider.api.listnr.com/v1/issue-token",
            value=values.get(CONF_TOKEN_ENDPOINT),
            advanced=True,
        ),
        ConfigEntry(
            key=CONF_VALIDATE_TOKEN_ON_START,
            label="Validate Token On Start",
            type=ConfigEntryType.BOOLEAN,
            required=False,
            default_value=False,
            value=values.get(CONF_VALIDATE_TOKEN_ON_START),
            advanced=True,
        ),
    )
