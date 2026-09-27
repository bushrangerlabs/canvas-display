package com.bushrangerlabs.canvas_display_edge.snapcast

/**
 * Snapcast playback scheduling rule (mirrors `client/stream.cpp`).
 *
 * ```
 * age = (serverNow - chunkStart) - bufferMs + dacTime
 * ```
 *
 * `chunkStart` is the chunk's capture time on the server clock, so a chunk
 * should be *heard* at `chunkStart + bufferMs`. `dacTime` is how long audio
 * written now will sit in the output buffer before it is played.
 *
 * - `age == 0` → play now
 * - `age  < 0` → too early, wait (snapclient plays silence in the meantime)
 * - `age  > 0` → too old, drop
 */
object SnapcastSync {

    /** Drop a chunk more than this far past its play time. */
    const val LATE_DROP_MICROS = 200_000L

    /** Wait (rather than write) when more than this early. */
    const val EARLY_WAIT_MICROS = 20_000L

    enum class Decision { PLAY, WAIT, DROP }

    /** Scheduling error in microseconds; positive means we are late. */
    fun age(serverNowMicros: Long, playAtServerMicros: Long, dacTimeMicros: Long): Long =
        serverNowMicros - playAtServerMicros + dacTimeMicros

    /** Server-clock time at which a chunk captured at [chunkTimestampMicros] should be heard. */
    fun playAt(chunkTimestampMicros: Long, bufferMs: Int): Long =
        chunkTimestampMicros + bufferMs.toLong() * 1000L

    fun decide(ageMicros: Long): Decision = when {
        ageMicros > LATE_DROP_MICROS -> Decision.DROP
        ageMicros < -EARLY_WAIT_MICROS -> Decision.WAIT
        else -> Decision.PLAY
    }

    /** How long to wait before retrying a chunk that is too early (bounded, in ms). */
    fun waitMillis(ageMicros: Long): Long = ((-ageMicros) / 1000L).coerceIn(1L, 200L)

    /**
     * How long audio written now will sit in the output buffer before playing.
     * `framesWritten - playbackHead` is the number of frames still queued.
     */
    fun dacTimeMicros(framesWritten: Long, playbackHeadFrames: Long, sampleRate: Int): Long {
        if (sampleRate <= 0) return 0
        val buffered = (framesWritten - playbackHeadFrames).coerceAtLeast(0L)
        return buffered * 1_000_000L / sampleRate
    }
}
