"""Media player entity for Canvas Display."""
from __future__ import annotations

from typing import Any

from homeassistant.components.media_player import MediaPlayerEntity
from homeassistant.components.media_player.const import (
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
)
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
    async_add_entities([CanvasDisplayMediaPlayer(coordinator, entry.entry_id)])


class CanvasDisplayMediaPlayer(CoordinatorEntity[CanvasDisplayCoordinator], MediaPlayerEntity):
    """Expose Canvas Display as a Home Assistant media_player target."""

    _attr_has_entity_name = True
    _attr_name = "Media"
    _attr_icon = "mdi:speaker-wireless"
    _attr_supported_features = (
        MediaPlayerEntityFeature.PLAY
        | MediaPlayerEntityFeature.PAUSE
        | MediaPlayerEntityFeature.STOP
        | MediaPlayerEntityFeature.NEXT_TRACK
        | MediaPlayerEntityFeature.PLAY_MEDIA
        | MediaPlayerEntityFeature.VOLUME_SET
        | MediaPlayerEntityFeature.VOLUME_MUTE
    )

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
        url = self.media_content_id or ""
        title = (self.media_title or "").lower()
        if "youtube.com" in url or "youtu.be" in url or "youtube" in title:
            return MediaType.VIDEO
        if "radio" in title or "stream" in title:
            return MediaType.MUSIC
        return MediaType.MUSIC

    @property
    def state(self) -> MediaPlayerState:
        raw_state = ((self.coordinator.data or {}).get("media", {}).get("state") or "idle").lower()
        if raw_state == "playing":
            return MediaPlayerState.PLAYING
        if raw_state == "paused":
            return MediaPlayerState.PAUSED
        return MediaPlayerState.IDLE

    async def async_media_play(self) -> None:
        await self.coordinator.async_media_control("resume", source=self._current_source())

    async def async_media_pause(self) -> None:
        await self.coordinator.async_media_control("pause", source=self._current_source())

    async def async_media_stop(self) -> None:
        source = self._current_source()
        await self.coordinator.async_media_control("stop", source=source)

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
        source = self._resolve_source(media_type, media_id)
        title = kwargs.get("title") or kwargs.get("media_title")
        extra = kwargs.get("extra") or {}
        if title is None and isinstance(extra, dict):
            title = extra.get("title")
        await self.coordinator.async_media_play(source=source, url=media_id, title=title)

    def _current_source(self) -> str:
        media_id = self.media_content_id or ""
        if "youtube.com" in media_id or "youtu.be" in media_id:
            return "youtube"
        return "direct_audio"

    def _resolve_source(self, media_type: MediaType | str, media_id: str) -> str:
        media_type_value = str(media_type).lower()
        lower_id = media_id.lower()
        if "youtube.com" in lower_id or "youtu.be" in lower_id:
            return "youtube"
        if media_type_value in {"channel", "radio", "tvshow", "station"}:
            return "radio_browser"
        if media_type_value in {
            "music",
            "album",
            "artist",
            "playlist",
            "track",
        }:
            return "music_assistant"
        if media_id.startswith("http://") or media_id.startswith("https://"):
            return "direct_audio"
        return "music_assistant"
