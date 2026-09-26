package com.bushrangerlabs.canvas_display_edge.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Handles `device.action` requests Core sends over the gateway-v1 WebSocket
 * (`CoreEdgeClient`) — the gateway-v1 equivalent of the legacy sidecar's local
 * "/api/audio" HTTP endpoints, since Android has no local server for Core to
 * call into directly. Every action runs synchronously and returns a plain
 * JSON result; callers should invoke this off the main thread.
 */
object DeviceActionHandler {
    private const val SAMPLE_RATE = 16_000

    fun handle(context: Context, action: String, payload: JSONObject): JSONObject = try {
        when (action) {
            "audio.list_devices" -> listDevices(context)
            "audio.test_mic" -> testMic(context, payload.optInt("duration_ms", 3000))
            "audio.test_speaker" -> testSpeaker(payload.optInt("volume", 90))
            "voice.test_wakeword" -> testWakeWord(context, payload)
            "voice.test_cue" -> testCue(payload)
            else -> JSONObject().put("ok", false).put("error", "unknown_action")
        }
    } catch (error: Exception) {
        JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName)
    }

    /** Real AudioDeviceInfo enumeration — the Android equivalent of Linux's `pactl list short sources/sinks`. */
    private fun listDevices(context: Context): JSONObject {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val microphones = JSONArray()
        for (info in audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
            microphones.put(JSONObject().put("id", info.id.toString()).put("label", deviceLabel(info)))
        }
        val speakers = JSONArray()
        for (info in audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            speakers.put(JSONObject().put("id", info.id.toString()).put("label", deviceLabel(info)))
        }
        return JSONObject().put("ok", true).put("microphones", microphones).put("speakers", speakers)
    }

    private fun deviceLabel(info: AudioDeviceInfo): String {
        val typeName = when (info.type) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in Microphone"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Built-in Speaker"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset"
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired Headphones"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth (Call)"
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth (Media)"
            AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "USB Audio"
            AudioDeviceInfo.TYPE_HDMI -> "HDMI"
            else -> "Audio Device"
        }
        val product = info.productName?.toString()?.takeIf { it.isNotBlank() && it != "?" }
        return if (product != null) "$typeName ($product)" else typeName
    }

    /** Captures a short clip, reports peak/RMS, and plays it back so the tester can hear it. */
    private fun testMic(context: Context, durationMs: Int): JSONObject {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return JSONObject().put("ok", false).put("error", "record_audio_permission_denied")
        }
        val clampedMs = durationMs.coerceIn(500, 5000)
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuf <= 0) return JSONObject().put("ok", false).put("error", "unsupported_capture_format")

        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 2,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return JSONObject().put("ok", false).put("error", "audio_record_init_failed")
        }

        val totalSamples = SAMPLE_RATE * clampedMs / 1000
        val pcm = ShortArray(totalSamples)
        record.startRecording()
        var read = 0
        while (read < totalSamples) {
            val n = record.read(pcm, read, totalSamples - read)
            if (n <= 0) break
            read += n
        }
        record.stop()
        record.release()

        var sumSquares = 0.0
        var peak = 0
        for (i in 0 until read) {
            val v = abs(pcm[i].toInt())
            peak = maxOf(peak, v)
            sumSquares += v.toDouble() * v
        }
        val rms = if (read > 0) sqrt(sumSquares / read) else 0.0

        playPcm(pcm.copyOf(read))

        return JSONObject()
            .put("ok", true)
            .put("duration_ms", clampedMs)
            .put("samples_captured", read)
            .put("peak", peak)
            .put("rms", rms.toInt())
    }

    private fun playPcm(pcm: ShortArray) {
        if (pcm.isEmpty()) return
        val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(minBuf, pcm.size * 2))
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(pcm, 0, pcm.size)
        track.play()
        // MODE_STATIC playback runs on its own; release once queued audio finishes.
        Thread {
            try { Thread.sleep((pcm.size * 1000L / SAMPLE_RATE) + 200) } catch (_: InterruptedException) { /* ignore */ }
            track.release()
        }.start()
    }

    /** Plays a short 440Hz test tone at the requested volume (0-100), the Android equivalent of `speaker-test`. */
    private fun testSpeaker(volume: Int): JSONObject {
        val durationMs = 700
        val toneFreqHz = 440.0
        val samples = ShortArray(SAMPLE_RATE * durationMs / 1000)
        for (i in samples.indices) {
            val t = i.toDouble() / SAMPLE_RATE
            samples[i] = (sin(2.0 * Math.PI * toneFreqHz * t) * Short.MAX_VALUE * 0.6).toInt().toShort()
        }
        val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(minBuf, samples.size * 2))
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.setVolume(volume.coerceIn(0, 100) / 100f)
        track.write(samples, 0, samples.size)
        track.play()
        Thread {
            try { Thread.sleep(durationMs + 200L) } catch (_: InterruptedException) { /* ignore */ }
            track.release()
        }.start()
        return JSONObject().put("ok", true).put("duration_ms", durationMs).put("frequency_hz", toneFreqHz)
    }

    private fun testWakeWord(context: Context, payload: JSONObject): JSONObject {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return JSONObject().put("ok", false).put("error", "record_audio_permission_denied")
        }
        val wakeWord = payload.optString("wake_word", "hey_jarvis")
        if (wakeWord !in setOf("hey_jarvis", "alexa", "hey_mycroft", "hey_rhasspy")) {
            return JSONObject().put("ok", false).put("error", "unknown_wake_word")
        }
        val threshold = payload.optDouble("wake_threshold", 0.5).toFloat().coerceIn(0.1f, 0.9f)
        val timeoutMs = payload.optLong("timeout_ms", 15_000L).coerceIn(2_000L, 30_000L)
        val detected = AtomicBoolean(false)
        val maxScore = AtomicReference(0f)
        val completed = CountDownLatch(1)
        val detector = WakeWordDetector(
            context = context,
            modelAssetPath = "openwakeword/$wakeWord.tflite",
            threshold = threshold,
            onScore = { score -> maxScore.updateAndGet { current -> maxOf(current, score) } },
            onDetected = {
                detected.set(true)
                completed.countDown()
            },
        )
        val capture = MicCapture(context) { chunk -> detector.feed(chunk) }
        try {
            capture.start()
            completed.await(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
            capture.stop()
            detector.close()
        }
        return JSONObject()
            .put("ok", true)
            .put("detected", detected.get())
            .put("wake_word", wakeWord)
            .put("wake_threshold", threshold)
            .put("max_score", maxScore.get())
            .put("timeout_ms", timeoutMs)
    }

    private fun testCue(payload: JSONObject): JSONObject {
        val sound = payload.optString("sound")
        val volume = payload.optInt("volume", 90).coerceIn(0, 100) / 100f
        val frequencies = when (sound) {
            "builtin:soft_chime" -> doubleArrayOf(523.25, 659.25, 783.99)
            "builtin:glass_ping" -> doubleArrayOf(1318.51, 1760.0)
            "builtin:ready_up" -> doubleArrayOf(660.0, 880.0)
            "builtin:digital_pop" -> doubleArrayOf(1046.5)
            "builtin:wood_tap" -> doubleArrayOf(220.0, 165.0)
            "builtin:confirm_tone" -> doubleArrayOf(880.0, 1174.66)
            else -> return JSONObject().put("ok", false).put("error", "unsupported_voice_cue")
        }
        val samplesPerTone = SAMPLE_RATE * 120 / 1000
        val samples = ShortArray(samplesPerTone * frequencies.size)
        frequencies.forEachIndexed { toneIndex, frequency ->
            for (sampleIndex in 0 until samplesPerTone) {
                val t = sampleIndex.toDouble() / SAMPLE_RATE
                val envelope = (1.0 - sampleIndex.toDouble() / samplesPerTone) * 0.55
                samples[toneIndex * samplesPerTone + sampleIndex] =
                    (sin(2.0 * Math.PI * frequency * t) * Short.MAX_VALUE * envelope).toInt().toShort()
            }
        }
        playSamples(samples, volume)
        return JSONObject().put("ok", true).put("sound", sound).put("duration_ms", samples.size * 1000 / SAMPLE_RATE)
    }

    private fun playSamples(samples: ShortArray, volume: Float) {
        val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(minBuf, samples.size * 2))
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.setVolume(volume)
        track.write(samples, 0, samples.size)
        track.play()
        Thread {
            try { Thread.sleep((samples.size * 1000L / SAMPLE_RATE) + 200) } catch (_: InterruptedException) { }
            track.release()
        }.start()
    }
}
