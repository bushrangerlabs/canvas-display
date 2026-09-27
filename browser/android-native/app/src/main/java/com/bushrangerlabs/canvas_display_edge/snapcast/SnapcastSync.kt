package com.bushrangerlabs.canvas_display_edge.snapcast

import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Snapcast playback scheduling and drift correction (mirrors `client/stream.cpp`).
 *
 * ## Scheduling
 *
 * ```
 * age = (serverNow - chunkStart) - bufferMs + dacTime
 * ```
 *
 * `chunkStart` is the chunk's playout time on the server clock, so a chunk
 * should be *heard* at `chunkStart + bufferMs`. `dacTime` is how long audio
 * written now will sit in the output buffer before it is played.
 *
 * - `age == 0` → play now
 * - `age  < 0` → too early, wait (snapclient plays silence in the meantime)
 * - `age  > 0` → too old, drop
 *
 * ## Soft correction
 *
 * Once the coarse rule has settled, small residual drift is corrected by
 * dropping or duplicating a single frame every few thousand frames, which is
 * inaudible. Snapclient derives a "real sample rate" slightly off nominal and
 * converts it into a correction period:
 *
 * ```
 * rate  = 1 ∓ min((|shortMedian| / 100) * 0.00005, 0.0005)
 * r     = 1 / rate
 * after = round(r / (r - 1))      // frames between single-frame corrections
 * ```
 *
 * A positive period means "drop a frame every N frames" (we are late and need
 * to speed up); a negative period means "duplicate a frame every N frames".
 */
object SnapcastSync {

    /** Drop a chunk more than this far past its play time. */
    const val LATE_DROP_MICROS = 200_000L

    /** Wait (rather than write) when more than this early. */
    const val EARLY_WAIT_MICROS = 2_000L

    /** Snapclient's `kCorrectionBegin`: below this the drift is left alone. */
    const val CORRECTION_BEGIN_MICROS = 100L

    /** Hard cap on the rate adjustment (0.05%). */
    const val MAX_RATE_DELTA = 0.0005

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
    fun waitMillis(ageMicros: Long): Long = ((-ageMicros) / 1000L).coerceIn(1L, 10L)

    /**
     * How long audio written now will sit in the output buffer before playing.
     * `framesWritten - playbackHead` is the number of frames still queued.
     */
    fun dacTimeMicros(framesWritten: Long, playbackHeadFrames: Long, sampleRate: Int): Long {
        if (sampleRate <= 0) return 0
        val buffered = (framesWritten - playbackHeadFrames).coerceAtLeast(0L)
        return buffered * 1_000_000L / sampleRate
    }

    /**
     * Frames between single-frame corrections. Positive = drop a frame (we are
     * late and must speed up); negative = duplicate a frame (we are early);
     * 0 = no correction needed.
     *
     * Mirrors snapclient's `Stream::setRealSampleRate` gating: correction only
     * starts once the short and mini medians agree with the instantaneous age.
     */
    fun correctAfterXFrames(
        shortMedianMicros: Long,
        miniMedianMicros: Long,
        ageMicros: Long,
    ): Int {
        val late = shortMedianMicros > CORRECTION_BEGIN_MICROS &&
            miniMedianMicros > 50_000 &&
            ageMicros > 50_000
        val early = shortMedianMicros < -CORRECTION_BEGIN_MICROS &&
            miniMedianMicros < -50_000 &&
            ageMicros < -50_000
        if (!late && !early) return 0

        val magnitude = (abs(shortMedianMicros) / 100.0) * 0.00005
        val delta = min(magnitude, MAX_RATE_DELTA)
        val rate = if (late) 1.0 - delta else 1.0 + delta
        val r = 1.0 / rate
        val denominator = r - 1.0
        if (abs(denominator) < 1e-12) return 0
        return (r / denominator).roundToInt()
    }

    /**
     * Accumulate played frames and return how many frames this buffer should
     * gain (negative) or lose (positive), plus the remaining frame counter.
     */
    fun framesCorrection(playedFrames: Long, correctAfterXFrames: Int, frames: Int): Pair<Int, Long> {
        if (correctAfterXFrames == 0) return 0 to playedFrames
        val period = abs(correctAfterXFrames).toLong()
        var played = playedFrames + frames
        if (played < period) return 0 to played
        val correction = (played / correctAfterXFrames).toInt()
        played %= period
        return correction to played
    }

    /**
     * Apply [framesCorrection] to a PCM buffer by dropping (positive) or
     * duplicating (negative) frames, spread evenly so the artefact is inaudible.
     * Returns the input unchanged when no correction is needed.
     */
    fun applyFrameCorrection(pcm: ByteArray, frameSize: Int, framesCorrection: Int): ByteArray {
        if (framesCorrection == 0 || frameSize <= 0) return pcm
        val frames = pcm.size / frameSize
        if (frames <= 0) return pcm

        // Never correct more frames than the buffer holds.
        val correction = framesCorrection.coerceIn(-frames + 1, frames - 1)
        if (correction == 0) return pcm

        val outFrames = frames - correction
        if (outFrames <= 0) return pcm
        val out = ByteArray(outFrames * frameSize)

        // Walk the output, picking a source frame per output frame. Dropping
        // (correction > 0) skips source frames; duplicating (correction < 0)
        // repeats them. The step spreads the correction across the buffer.
        for (index in 0 until outFrames) {
            val offset = if (correction > 0) {
                // Skip `correction` frames evenly across the buffer.
                (index.toLong() * correction / outFrames).toInt()
            } else {
                // Repeat `-correction` frames evenly across the buffer.
                -(index.toLong() * -correction / outFrames).toInt()
            }
            val from = (index + offset).coerceIn(0, frames - 1)
            System.arraycopy(pcm, from * frameSize, out, index * frameSize, frameSize)
        }
        return out
    }
}

/**
 * Fixed-size ring of recent samples with a median query, mirroring snapclient's
 * `Buffer`/`MiniBuffer`/`ShortBuffer` statistics.
 */
class MedianWindow(private val capacity: Int) {

    private val values = LongArray(capacity)
    private var count = 0
    private var next = 0

    fun add(value: Long) {
        values[next] = value
        next = (next + 1) % capacity
        if (count < capacity) count += 1
    }

    fun isFull(): Boolean = count == capacity

    fun clear() {
        count = 0
        next = 0
    }

    fun size(): Int = count

    fun median(): Long {
        if (count == 0) return 0
        val sorted = LongArray(count) { values[it] }
        sorted.sort()
        return sorted[count / 2]
    }
}
