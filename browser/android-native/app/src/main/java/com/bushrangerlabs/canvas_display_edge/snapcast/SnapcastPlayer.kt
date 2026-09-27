package com.bushrangerlabs.canvas_display_edge.snapcast

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Plays a Snapcast stream.
 *
 * FLAC (snapserver's default codec) is decoded with Android's platform FLAC
 * decoder; `pcm` streams are written straight to [AudioTrack]. Decoded PCM is
 * queued and written on a dedicated thread so the socket reader is never
 * blocked by audio output.
 */
class SnapcastPlayer(
    private val onStatus: (String) -> Unit = {},
) : SnapcastClient.SnapcastSink {

    private val queue = ArrayBlockingQueue<ByteArray>(256)
    private var writer: Thread? = null
    private var track: AudioTrack? = null
    private var codec: MediaCodec? = null
    private var sampleRate = 48_000
    private var channels = 2
    private var bitsPerSample = 16
    private var isPcm = false
    private var flacHeader: ByteArray? = null

    @Volatile private var running = false
    @Volatile private var volume = 1.0f
    private var chunkCount = 0

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
    }

    fun setVolume(percent: Int) {
        volume = (percent.coerceIn(0, 100)) / 100f
        runCatching { track?.setVolume(volume) }
    }

    // ─── SnapcastSink ─────────────────────────────────────────────────────────

    override fun onCodecHeader(codec: String, data: ByteArray) {
        onStatus("snapcast codec: $codec (${data.size} byte header)")
        isPcm = codec.equals("pcm", ignoreCase = true)
        if (isPcm) {
            parsePcmFormat(data)?.let { (rate, bits, ch) ->
                sampleRate = rate
                bitsPerSample = bits
                channels = ch
            }
        } else {
            flacHeader = data
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
        if (isPcm) {
            // Offer rather than block: drop audio instead of stalling the socket.
            queue.offer(data)
            return
        }
        decodeFlac(data)
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
            onStatus("snapcast FLAC decoder unavailable: ${it.message}")
            codec = null
        }
    }

    private fun decodeFlac(frame: ByteArray) {
        val decoder = codec ?: return
        runCatching {
            val inputIndex = decoder.dequeueInputBuffer(10_000)
            if (inputIndex >= 0) {
                val buffer = decoder.getInputBuffer(inputIndex) ?: return@runCatching
                buffer.clear()
                buffer.put(frame)
                decoder.queueInputBuffer(inputIndex, 0, frame.size, 0, 0)
            }
            drainDecoder(decoder)
        }.onFailure { onStatus("snapcast FLAC decode failed: ${it.message}") }
    }

    private fun drainDecoder(decoder: MediaCodec) {
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
                queue.offer(pcm)
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
                .setBufferSizeInBytes(maxOf(minBuffer * 4, 64 * 1024))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            created.setVolume(volume)
            created.play()
            track = created
        }.onFailure { onStatus("snapcast AudioTrack unavailable: ${it.message}") }
    }

    private fun writeLoop() {
        while (running) {
            val chunk = try {
                queue.poll(500, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                return
            } ?: continue
            val output = track ?: continue
            runCatching { output.write(chunk, 0, chunk.size) }
        }
    }
}
