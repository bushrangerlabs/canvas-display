package com.bushrangerlabs.canvas_display_edge.snapcast

import com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter
import com.bushrangerlabs.canvas_display_edge.dlna.DlnaLog

/**
 * Owns the Snapcast client + player for the Android edge app and integrates
 * them with the shared [AudioSinkArbiter].
 *
 * Snapcast is the multi-room synchronised path; a DLNA push (or any other
 * local playback) takes the audio sink and stops the Snapcast client, and
 * starting Snapcast again stops local playback.
 */
class SnapcastService(
    private val host: String,
    private val port: Int,
    private val clientId: String,
    private val clientName: String,
) {

    private val player = SnapcastPlayer { DlnaLog.info("snapcast: $it") }

    private val client = SnapcastClient(
        host = host,
        port = port,
        clientId = clientId,
        clientName = clientName,
        sink = player,
        onStatus = { DlnaLog.info("snapcast: $it") },
    )

    @Volatile var running = false
        private set

    /** Server-reported stream info, for diagnostics. */
    val codec: String? get() = client.codec
    val bufferMs: Int get() = client.serverBufferMs
    val clockOffsetMicros: Long get() = client.clockSync.offsetMicros

    init {
        // When another subsystem takes the sink, stop the Snapcast client.
        AudioSinkArbiter.registerReleaser(AudioSinkArbiter.Owner.SNAPCAST) { stop() }
    }

    fun start() {
        if (running) return
        running = true
        DlnaLog.info("snapcast: taking the audio sink")
        AudioSinkArbiter.acquire(AudioSinkArbiter.Owner.SNAPCAST)
        player.start()
        client.start()
        DlnaLog.info("snapcast client starting for $host:$port")
    }

    fun stop() {
        if (!running) return
        running = false
        DlnaLog.info("snapcast: releasing the audio sink")
        client.stop()
        player.stop()
        AudioSinkArbiter.release(AudioSinkArbiter.Owner.SNAPCAST)
    }

    /** Ask the server to set this client's volume (0–100). */
    fun setVolume(percent: Int, muted: Boolean = false) {
        player.setVolume(percent)
        client.setVolume(percent, muted)
    }
}
