package com.bushrangerlabs.canvas_display_edge.dlna

/** Tracks play/pause intent while an asynchronous media source is preparing. */
internal class DeferredPlaybackState {
    private var prepared = false
    private var wantsPlayback = false

    fun loading() {
        prepared = false
        wantsPlayback = true
    }

    /** Returns true when the newly prepared player should start immediately. */
    fun prepared(): Boolean {
        prepared = true
        return wantsPlayback
    }

    /** Returns true when the player is prepared and can be paused now. */
    fun pause(): Boolean {
        wantsPlayback = false
        return prepared
    }

    /** Returns true when the player is prepared and can be started now. */
    fun resume(): Boolean {
        wantsPlayback = true
        return prepared
    }

    /** Resets the state and returns whether MediaPlayer had reached prepared. */
    fun stopped(): Boolean {
        val wasPrepared = prepared
        prepared = false
        wantsPlayback = false
        return wasPrepared
    }
}
