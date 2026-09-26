package com.bushrangerlabs.canvas_display_edge.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Microphone capture via [AudioRecord] — the Android-native replacement for the Linux
 * sidecar's `parec`/`arecord` subprocess (see `server/src/voice/mic.ts`).
 *
 * Always delivers exactly 1280-sample (80ms @ 16kHz mono) PCM16 chunks, matching
 * openWakeWord's expected chunk size so [AudioFeatures]'s streaming buffer math
 * (which assumes one 80ms chunk per call) holds without remainder handling.
 */
class MicCapture(private val context: Context, private val onChunk: (ShortArray) -> Unit) {
    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHUNK_SAMPLES = 1280 // 80ms @ 16kHz — openWakeWord's expected step size
    }

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    private val running = AtomicBoolean(false)

    val hasPermission: Boolean
        get() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun start() {
        if (running.get()) return
        if (!hasPermission) throw SecurityException("RECORD_AUDIO permission not granted")

        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) throw IllegalStateException("Device does not support 16kHz mono PCM16 capture")
        val bufferSize = maxOf(minBuf, CHUNK_SAMPLES * 2 * 4) // a few chunks of headroom

        val audioRecord = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize,
        )
        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
            audioRecord.release()
            throw IllegalStateException("AudioRecord failed to initialize")
        }

        record = audioRecord
        running.set(true)
        audioRecord.startRecording()

        thread = Thread({
            val chunk = ShortArray(CHUNK_SAMPLES)
            var filled = 0
            while (running.get()) {
                val read = audioRecord.read(chunk, filled, CHUNK_SAMPLES - filled)
                if (read < 0) break // AudioRecord error code (negative)
                filled += read
                if (filled >= CHUNK_SAMPLES) {
                    onChunk(chunk.copyOf(CHUNK_SAMPLES))
                    filled = 0
                }
            }
        }, "canvas-mic-capture").apply { start() }
    }

    fun stop() {
        running.set(false)
        thread?.join(500)
        thread = null
        record?.let {
            try { it.stop() } catch (_: Exception) { /* already stopped */ }
            it.release()
        }
        record = null
    }

    val isRunning: Boolean get() = running.get()
}
