package com.bushrangerlabs.canvas_display_edge

import org.junit.Assert.assertEquals
import org.junit.Test

class MediaPlaybackRouteTest {
    @Test fun dispatcharrUsesNativeVideo() {
        assertEquals(MediaPlaybackRoute.NATIVE_VIDEO, playbackRoute("dispatcharr"))
    }

    @Test fun audioSourcesUseNativeAudio() {
        assertEquals(MediaPlaybackRoute.DIRECT_AUDIO, playbackRoute("direct_audio"))
        assertEquals(MediaPlaybackRoute.DIRECT_AUDIO, playbackRoute("dab"))
    }

    @Test fun webMediaRemainsInWebRenderer() {
        assertEquals(MediaPlaybackRoute.WEB, playbackRoute("youtube"))
    }
}
