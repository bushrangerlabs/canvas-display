package com.bushrangerlabs.canvas_display_edge.snapcast

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTimestamp
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Plays a Snapcast stream with server-clock scheduling.
 *
 * Snapclient's sync rule (client/stream.cpp) is:
 *
 * ```
 * age = (serverNow - chunkStart) - bufferMs + dacTime
 *   age == 0 -> play now
 *   age  < 0 -> too early, wait (play silence in the meantime)
 *   age  > 0 -> too old, drop
 * ```
 *
 * `chunkStart` is the chunk's capture time on the server clock, so a chunk
 * should be *heard* at `chunkStart + bufferMs`. `dacTime` is how long the audio
 * we are about to write will sit in the output buffer before it is played.
 *
 * FLAC (snapserver's default codec) is decoded with Android's platform FLAC
 * decoder; `pcm` streams are written straight to [AudioTrack].
 */
class SnapcastPlayer(
    private val onStatus: (String) -> Unit = {},
    /** Server clock minus client clock, in microseconds. */
    private val clockOffsetMicros: () -> Long = { 0L },
    /** End-to-end buffer reported by the server, in milliseconds. */
    private val bufferMs: () -> Int = { 1000 },
) : SnapcastClient.SnapcastSink {

    private data class PcmItem(val playAtServerMicros: Long, val data: ByteArray)

    private val queue = ArrayBlockingQueue<PcmItem>(256)
    private var writer: Thread? = null
    private var track: AudioTrack? = null
    private var codec: MediaCodec? = null
    private var sampleRate = 48_000
    private var channels = 2
    private var bitsPerSample = 16
    private var isPcm = false

    @Volatile private var running = false
    @Volatile private var volume = 1.0f
    private var chunkCount = 0
    private var framesWritten = 0L
    private var droppedChunks = 0
    private var correctedFrames = 0L
    private var playedFrames = 0L
    private var correctAfterXFrames = 0
    private var lastStatsAt = 0L
    // Snapclient keeps three windows of recent scheduling errors and only starts
    // correcting once the short and mini medians agree with the instantaneous age.
    private val longAges = MedianWindow(500)
    private val shortAges = MedianWindow(100)
    private val miniAges = MedianWindow(20)
    // True scheduling error (serverNow - playAt, without the output-buffer term).
    // This is the number that actually says whether we are in sync.
    private val lateness = MedianWindow(200)

    fun start() {
        if (running) return
        running = true
        writer = thread(name = "snapcast-player", isDaemon = true) { writeLoop() }
    }

    fun stop() {
        running = false
        writer?.interrupt()
        writer = null
        queue.clear()
        runCatching { codec?.stop() }
        runCatching { codec?.release() }
        codec = null
        runCatching { track?.stop() }
        runCatching { track?.release() }
        track = null
        framesWritten = 0
        correctedFrames = 0
        playedFrames = 0
        correctAfterXFrames = 0
        longAges.clear()
        shortAges.clear()
        miniAges.clear()
        lateness.clear()
    }

    fun setVolume(percent: Int) {
        volume = percent.coerceIn(0, 100) / 100f
        runCatching { track?.setVolume(volume) }
    }

    /** Median scheduling error in microseconds (positive = late). */
    fun medianAgeMicros(): Long = longAges.median()

    // ─── SnapcastSink ─────────────────────────────────────────────────────────

    override fun onCodecHeader(codec: String, data: ByteArray) {
        onStatus("codec: $codec (${data.size} byte header)")
        isPcm = codec.equals("pcm", ignoreCase = true)
        if (isPcm) {
            parsePcmFormat(data)?.let { (rate, bits, ch) ->
                sampleRate = rate
                bitsPerSample = bits
                channels = ch
            }
        } else {
            configureFlacDecoder(data)
        }
        ensureTrack()
    }

    override fun onChunk(timestampMicros: Long, data: ByteArray) {
        if (!running || data.isEmpty()) return
        if (chunkCount < 3) {
            chunkCount += 1
            onStatus("chunk #$chunkCount ts=$timestampMicros ${data.size}B")
        }
        val playAt = timestampMicros + bufferMs().toLong() * 1000L
        if (isPcm) {
            queue.offer(PcmItem(playAt, data))
            return
        }
        decodeFlac(data, playAt)
    }

    override fun onStopped() {
        queue.clear()
    }

    // ─── FLAC ─────────────────────────────────────────────────────────────────

    private fun configureFlacDecoder(header: ByteArray) {
        runCatching {
            val decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_FLAC)
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_FLAC, sampleRate, channels)
            format.setByteBuffer("csd-0", ByteBuffer.wrap(header))
            decoder.configure(format, null, null, 0)
            decoder.start()
            codec = decoder
        }.onFailure {
            onStatus("FLAC decoder unavailable: ${it.message}")
            codec = null
        }
    }

    private fun decodeFlac(frame: ByteArray, playAt: Long) {
        val decoder = codec ?: return
        runCatching {
            val inputIndex = decoder.dequeueInputBuffer(10_000)
            if (inputIndex >= 0) {
                val buffer = decoder.getInputBuffer(inputIndex) ?: return@runCatching
                buffer.clear()
                buffer.put(frame)
                decoder.queueInputBuffer(inputIndex, 0, frame.size, 0, 0)
            }
            drainDecoder(decoder, playAt)
        }.onFailure { onStatus("FLAC decode failed: ${it.message}") }
    }

    private fun drainDecoder(decoder: MediaCodec, playAt: Long) {
        val info = MediaCodec.BufferInfo()
        while (true) {
            val outputIndex = decoder.dequeueOutputBuffer(info, 0)
            if (outputIndex < 0) return
            if (info.size > 0) {
                val buffer = decoder.getOutputBuffer(outputIndex) ?: continue
                val pcm = ByteArray(info.size)
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                buffer.get(pcm)
                queue.offer(PcmItem(playAt, pcm))
            }
            decoder.releaseOutputBuffer(outputIndex, false)
        }
    }

    // ─── PCM ──────────────────────────────────────────────────────────────────

    /** CodecHeader data for `pcm` is the sample format string `rate:bits:channels`. */
    private fun parsePcmFormat(data: ByteArray): Triple<Int, Int, Int>? {
        val text = String(data, Charsets.US_ASCII).trim().trimEnd('\u0000')
        val parts = text.split(":")
        if (parts.size < 3) return null
        val rate = parts[0].toIntOrNull() ?: return null
        val bits = parts[1].toIntOrNull() ?: return null
        val ch = parts[2].toIntOrNull() ?: return null
        return Triple(rate, bits, ch)
    }

    // ─── Output ───────────────────────────────────────────────────────────────

    private fun ensureTrack() {
        if (track != null) return
        runCatching {
            val channelMask = if (channels >= 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
            val encoding = if (bitsPerSample == 8) AudioFormat.ENCODING_PCM_8BIT else AudioFormat.ENCODING_PCM_16BIT
            val minBuffer = AudioTrack.getMinBufferSize(sampleRate, channelMask, encoding)
            val created = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(encoding)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setBufferSizeInBytes(minBuffer.coerceAtLeast(16 * 1024))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            created.setVolume(volume)
            created.play()
            track = created
        }.onFailure { onStatus("AudioTrack unavailable: ${it.message}") }
    }

    private fun frameSize(): Int = (bitsPerSample / 8) * channels

    /**
     * How long audio written now will sit in the output buffer before playing.
     *
     * Prefers [AudioTrack.getTimestamp], which reports the frame position and
     * the clock time at which that frame was presented — the accurate way to
     * know the output latency. Falls back to the (lagging) playback head.
     */
    private fun dacTimeMicros(): Long {
        val output = track ?: return 0
        val timestamp = AudioTimestamp()
        if (runCatching { output.getTimestamp(timestamp) }.getOrDefault(false)) {
            val framesSince = framesWritten - timestamp.framePosition
            val nanosSince = System.nanoTime() - timestamp.nanoTime
            return framesSince * 1_000_000L / sampleRate - nanosSince / 1000L
        }
        val head = runCatching { output.playbackHeadPosition.toLong() }.getOrDefault(0L)
        return SnapcastSync.dacTimeMicros(framesWritten, head, sampleRate)
    }

    private fun writeLoop() {
        while (running) {
            val item = try {
                queue.poll(200, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                return
            } ?: continue

            val output = track ?: continue
            val frameSize = frameSize().coerceAtLeast(1)
            val frames = item.data.size / frameSize

            // Snapclient's sync rule: age = serverNow - playAt + dacTime.
            // Retry the SAME item while it is too early — re-queueing it would
            // push it behind later chunks and scramble the audio order.
            var age: Long
            var dropped = false
            while (true) {
                val serverNow = nowMicros() + clockOffsetMicros()
                lateness.add(serverNow - item.playAtServerMicros)
                age = SnapcastSync.age(serverNow, item.playAtServerMicros, dacTimeMicros())
                when (SnapcastSync.decide(age)) {
                    SnapcastSync.Decision.DROP -> {
                        droppedChunks += 1
                        dropped = true
                        break
                    }
                    SnapcastSync.Decision.WAIT -> {
                        try {
                            Thread.sleep(SnapcastSync.waitMillis(age))
                        } catch (_: InterruptedException) {
                            return
                        }
                        continue
                    }
                    SnapcastSync.Decision.PLAY -> break
                }
            }
            if (dropped) continue

            // Soft correction: nudge the playback rate by dropping/duplicating a
            // single frame every few thousand frames once the drift is stable.
            longAges.add(age)
            shortAges.add(age)
            miniAges.add(age)
            if (shortAges.isFull()) {
                correctAfterXFrames = SnapcastSync.correctAfterXFrames(
                    shortMedianMicros = shortAges.median(),
                    miniMedianMicros = miniAges.median(),
                    ageMicros = age,
                )
            }
            val (correction, remaining) = SnapcastSync.framesCorrection(playedFrames, correctAfterXFrames, frames)
            playedFrames = remaining
            val payload = if (correction != 0) {
                correctedFrames += correction
                SnapcastSync.applyFrameCorrection(item.data, frameSize, correction)
            } else {
                item.data
            }

            runCatching { output.write(payload, 0, payload.size) }
            framesWritten += payload.size / frameSize
            recordStats()
        }
    }

    private fun recordStats() {
        val now = System.currentTimeMillis()
        if (now - lastStatsAt < 10_000) return
        lastStatsAt = now
        val rate = if (correctAfterXFrames == 0) "off" else "1/$correctAfterXFrames"
        onStatus(
            "sync: lateness=${lateness.median() / 1000}ms age=${longAges.median() / 1000}ms " +
                "short=${shortAges.median() / 1000}ms dropped=$droppedChunks corrected=$correctedFrames " +
                "rate=$rate buffered=${dacTimeMicros() / 1000}ms offset=${clockOffsetMicros() / 1000}ms",
        )
    }

    private fun nowMicros(): Long = System.nanoTime() / 1000
}
