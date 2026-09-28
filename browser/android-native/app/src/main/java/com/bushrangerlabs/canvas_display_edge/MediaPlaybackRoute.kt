package com.bushrangerlabs.canvas_display_edge

enum class MediaPlaybackRoute { DIRECT_AUDIO, NATIVE_VIDEO, WEB }

fun playbackRoute(source: String): MediaPlaybackRoute = when (source) {
    "direct_audio", "dab" -> MediaPlaybackRoute.DIRECT_AUDIO
    "dispatcharr" -> MediaPlaybackRoute.NATIVE_VIDEO
    else -> MediaPlaybackRoute.WEB
}
