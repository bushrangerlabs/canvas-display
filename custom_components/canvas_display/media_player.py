"""Media player entities for Canvas Display.

Two modes:

* **Core mode** — the config entry points at Canvas Core. One ``media_player``
  entity is created per registered device (Linux kiosk + native Android), driven
  by Core's edge device API. This is the only supported way to expose the edges
  as media players: HA's MQTT integration has no ``media_player`` platform, so
  MQTT discovery can never create them.
* **Legacy mode** — the entry points at a single Display server; one entity is
  created for it (the original behaviour).
"""
from __future__ import annotations

import re
from typing import Any

from homeassistant.components.media_player import MediaPlayerEntity
from homeassistant.components.media_player.const import (
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import CanvasDisplayCoordinator

SUPPORTED_FEATURES = (
    MediaPlayerEntityFeature.PLAY
    | MediaPlayerEntityFeature.PAUSE
    | MediaPlayerEntityFeature.STOP
    | MediaPlayerEntityFeature.NEXT_TRACK
    | MediaPlayerEntityFeature.PREVIOUS_TRACK
    | MediaPlayerEntityFeature.PLAY_MEDIA
    | MediaPlayerEntityFeature.VOLUME_SET
    | MediaPlayerEntityFeature.VOLUME_MUTE
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: CanvasDisplayCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]

    if not coordinator.core_mode:
        async_add_entities([CanvasDisplayMediaPlayer(coordinator, entry.entry_id)])
        return

    known: set[str] = set()

    @callback
    def _add_new_devices() -> None:
        devices = (coordinator.data or {}).get("devices", {}) or {}
        new_ids = [device_id for device_id in devices if device_id not in known]
        if not new_ids:
            return
        known.update(new_ids)
        async_add_entities(
            CanvasDeviceMediaPlayer(coordinator, entry.entry_id, device_id)
            for device_id in new_ids
        )

    _add_new_devices()
    entry.async_on_unload(coordinator.async_add_listener(_add_new_devices))


def _state_from_raw(raw: str | None) -> MediaPlayerState:
    value = (raw or "idle").lower()
    if value == "playing":
        return MediaPlayerState.PLAYING
    if value == "paused":
        return MediaPlayerState.PAUSED
    return MediaPlayerState.IDLE


def _media_type_for(url: str | None, title: str | None) -> MediaType:
    haystack = f"{url or ''} {title or ''}".lower()
    if "youtube.com" in haystack or "youtu.be" in haystack:
        return MediaType.VIDEO
    return MediaType.MUSIC


class CanvasDeviceMediaPlayer(CoordinatorEntity[CanvasDisplayCoordinator], MediaPlayerEntity):
    """One Canvas device (kiosk or Android) exposed as a media_player."""

    _attr_has_entity_name = True
    _attr_icon = "mdi:speaker-wireless"
    _attr_supported_features = SUPPORTED_FEATURES

    def __init__(
        self,
        coordinator: CanvasDisplayCoordinator,
        entry_id: str,
        device_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._entry_id = entry_id
        self._device_id = device_id
        self._attr_unique_id = f"canvas_display_{entry_id}_{device_id}_media_player"
        # Predictable entity_id so Core can address this device's Music Assistant
        # player (MA's hass_players player id is the HA entity_id).
        self.entity_id = canvas_entity_id(device_id)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"canvas_device_id": self._device_id}

    @property
    def _device(self) -> dict[str, Any]:
        return ((self.coordinator.data or {}).get("devices", {}) or {}).get(self._device_id, {})

    @property
    def _media(self) -> dict[str, Any]:
        return self._device.get("media") or {}

    @property
    def name(self) -> str:
        return str(self._device.get("name") or self._device_id)

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=str(self._device.get("name") or self._device_id),
            manufacturer="Canvas Display",
            model=str(self._device.get("architecture") or "Edge"),
            configuration_url=self.coordinator.api_url,
        )

    @property
    def available(self) -> bool:
        return bool(self._device.get("online"))

    @property
    def state(self) -> MediaPlayerState:
        return _state_from_raw(self._media.get("state"))

    @property
    def volume_level(self) -> float | None:
        volume = self._media.get("volume")
        if volume is None:
            return None
        return max(0.0, min(float(volume), 1.0))

    @property
    def is_volume_muted(self) -> bool | None:
        return bool(self._media.get("muted", False))

    @property
    def media_title(self) -> str | None:
        title = (self._media.get("title") or "").strip()
        return title or None

    @property
    def media_content_id(self) -> str | None:
        url = (self._media.get("url") or "").strip()
        return url or None

    @property
    def media_content_type(self) -> MediaType:
        return _media_type_for(self.media_content_id, self.media_title)

    @property
    def media_image_url(self) -> str | None:
        artwork = (self._media.get("artwork") or "").strip()
        return artwork or None

    async def async_media_play(self) -> None:
        await self.coordinator.async_device_media_control(self._device_id, "resume", source=self._current_source())

    async def async_media_pause(self) -> None:
        await self.coordinator.async_device_media_control(self._device_id, "pause", source=self._current_source())

    async def async_media_stop(self) -> None:
        await self.coordinator.async_device_media_control(self._device_id, "stop", source=self._current_source())

    async def async_media_next_track(self) -> None:
        await self.coordinator.async_device_media_control(self._device_id, "next", source=self._current_source())

    async def async_media_previous_track(self) -> None:
        await self.coordinator.async_device_media_control(self._device_id, "previous", source=self._current_source())

    async def async_set_volume_level(self, volume: float) -> None:
        await self.coordinator.async_device_media_control(
            self._device_id, "volume", source=self._current_source(), level=round(max(0.0, min(volume, 1.0)) * 100)
        )

    async def async_mute_volume(self, mute: bool) -> None:
        await self.coordinator.async_device_media_control(
            self._device_id, "mute", source=self._current_source(), muted=mute
        )

    def _current_source(self) -> str:
        media_id = self.media_content_id or ""
        if "youtube.com" in media_id or "youtu.be" in media_id:
            return "youtube"
        return "direct_audio"

    async def async_play_media(
        self,
        media_type: MediaType | str,
        media_id: str,
        **kwargs: Any,
    ) -> None:
        source = _resolve_source(media_type, media_id)
        await self.coordinator.async_device_media_play(
            self._device_id, source=source, url=media_id, title=_title_from_kwargs(kwargs)
        )


def _slug(value: str) -> str:
    """HA entity_id slug: lowercase, non-alphanumerics become underscores."""
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def canvas_entity_id(device_id: str) -> str:
    """The predictable HA entity_id for a Canvas device.

    Music Assistant's ``hass_players`` provider uses the HA entity_id as its own
    player id, so Core can target the device's MA player with this value.
    """
    return f"media_player.canvas_{_slug(device_id)}"


def _title_from_kwargs(kwargs: dict[str, Any]) -> str | None:
    """Extract a display title from HA play_media kwargs.

    Music Assistant passes ``extra={'metadata': {'title': ..., 'artist': ...}}``.
    """
    title = kwargs.get("title") or kwargs.get("media_title")
    extra = kwargs.get("extra")
    if title is None and isinstance(extra, dict):
        title = extra.get("title")
        metadata = extra.get("metadata")
        if title is None and isinstance(metadata, dict):
            title = metadata.get("title")
            artist = metadata.get("artist")
            if title and artist:
                title = f"{artist} - {title}"
    return title or None


def _resolve_source(media_type: MediaType | str, media_id: str) -> str:
    """Map an HA play_media call to a Core media source.

    A URL is always played directly: Music Assistant's ``hass_players`` provider
    resolves the track itself and sends a stream URL with ``media_content_type``
    of ``music``, so the media type must not override a real URL.
    """
    lower_id = media_id.lower()
    if lower_id.startswith("http://") or lower_id.startswith("https://"):
        if "youtube.com" in lower_id or "youtu.be" in lower_id:
            return "youtube"
        return "direct_audio"
    media_type_value = str(media_type).lower()
    if media_type_value in {"channel", "radio", "tvshow", "station"}:
        return "radio_browser"
    return "music_assistant"


class CanvasDisplayMediaPlayer(CoordinatorEntity[CanvasDisplayCoordinator], MediaPlayerEntity):
    """Legacy single-device entity (entry points at one Display server)."""

    _attr_has_entity_name = True
    _attr_name = "Media"
    _attr_icon = "mdi:speaker-wireless"
    _attr_supported_features = SUPPORTED_FEATURES

    def __init__(self, coordinator: CanvasDisplayCoordinator, entry_id: str) -> None:
        super().__init__(coordinator)
        self._entry_id = entry_id
        self._attr_unique_id = f"canvas_display_{entry_id}_media_player"

    @property
    def device_info(self) -> DeviceInfo:
        settings = (self.coordinator.data or {}).get("settings", {})
        device_name = settings.get("device_name", "Canvas Display")
        return DeviceInfo(
            identifiers={(DOMAIN, self._entry_id)},
            name=device_name,
            manufacturer="Canvas Display",
            model="Kiosk",
            configuration_url=self.coordinator.api_url,
        )

    @property
    def available(self) -> bool:
        return (self.coordinator.data or {}).get("online", False)

    @property
    def volume_level(self) -> float | None:
        media = (self.coordinator.data or {}).get("media", {})
        volume = media.get("volume")
        if volume is None:
            return None
        return max(0.0, min(float(volume) / 100.0, 1.0))

    @property
    def is_volume_muted(self) -> bool | None:
        return bool((self.coordinator.data or {}).get("media", {}).get("muted", False))

    @property
    def media_title(self) -> str | None:
        title = ((self.coordinator.data or {}).get("media", {}).get("title") or "").strip()
        return title or None

    @property
    def media_content_id(self) -> str | None:
        url = ((self.coordinator.data or {}).get("media", {}).get("url") or "").strip()
        return url or None

    @property
    def media_content_type(self) -> MediaType:
        return _media_type_for(self.media_content_id, self.media_title)

    @property
    def state(self) -> MediaPlayerState:
        raw_state = ((self.coordinator.data or {}).get("media", {}).get("state") or "idle").lower()
        return _state_from_raw(raw_state)

    async def async_media_play(self) -> None:
        await self.coordinator.async_media_control("resume", source=self._current_source())

    async def async_media_pause(self) -> None:
        await self.coordinator.async_media_control("pause", source=self._current_source())

    async def async_media_stop(self) -> None:
        await self.coordinator.async_media_control("stop", source=self._current_source())

    async def async_media_next_track(self) -> None:
        await self.coordinator.async_media_control("next", source=self._current_source())

    async def async_set_volume_level(self, volume: float) -> None:
        await self.coordinator.async_media_control("volume", level=round(max(0.0, min(volume, 1.0)) * 100))

    async def async_mute_volume(self, mute: bool) -> None:
        await self.coordinator.async_media_control("mute", muted=mute)

    async def async_play_media(
        self,
        media_type: MediaType | str,
        media_id: str,
        **kwargs: Any,
    ) -> None:
        source = _resolve_source(media_type, media_id)
        await self.coordinator.async_media_play(source=source, url=media_id, title=_title_from_kwargs(kwargs))

    def _current_source(self) -> str:
        media_id = self.media_content_id or ""
        if "youtube.com" in media_id or "youtu.be" in media_id:
            return "youtube"
        return "direct_audio"
