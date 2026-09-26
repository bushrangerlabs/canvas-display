package com.bushrangerlabs.canvas_display_edge.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Orchestrates a full on-device voice turn: continuous mic capture -> local wake-word
 * detection -> utterance capture with a simple energy-based end-of-speech timeout ->
 * POST to Canvas Core -> play back the TTS reply.
 *
 * Kotlin/Android equivalent of the Linux sidecar's `server/src/voice/direct-wakeword.ts`
 * (mic.ts + wakeword-local.ts + Core HTTP turn), using [MicCapture]/[WakeWordDetector]
 * (AudioRecord + TFLite) instead of parec/arecord + Python openWakeWord, and
 * [MediaPlayer] instead of mpv for playback.
 */
class VoicePipeline(
    private val context: Context,
    private val coreUrl: String,
    edgeVoiceToken: String,
    private val deviceId: String,
    wakeWordModelAsset: String,
    wakeThreshold: Float,
    private val wakeAckEnabled: Boolean,
    private val wakeAckSound: String,
    private val goodIntentEnabled: Boolean,
    private val goodIntentSound: String,
    private val noIntentEnabled: Boolean,
    private val noIntentSound: String,
    private val onStatus: (String) -> Unit = {},
) {
    private companion object {
        // Matches direct-wakeword.ts's containsLikelySpeech() thresholds, adapted to
        // per-chunk RMS on 1280-sample (80ms) frames rather than a whole-utterance scan.
        const val SILENCE_RMS_THRESHOLD = 120.0
        const val MAX_SILENCE_CHUNKS = 12 // ~1s of trailing silence ends the utterance
        const val MAX_CAPTURE_CHUNKS = 125 // ~10s hard cap
        const val MIN_VOICED_CHUNKS = 3 // require a little real speech before sending a turn
        const val PIPER_SAMPLE_RATE = 22_050
        const val WAKE_ECHO_COOLDOWN_MS = 300L
        const val MAX_STREAM_WRITE_STALL_MS = 5_000L
        const val MAX_DRAIN_MS = 10_000L
        const val TURN_TIMEOUT_MS = 100_000L
        const val WRITE_RETRY_MS = 10L
        const val TAG = "CanvasVoice"
    }

    private val executor = Executors.newSingleThreadExecutor()
    private val playbackExecutor = Executors.newSingleThreadExecutor()
    private val watchdogExecutor = Executors.newSingleThreadScheduledExecutor()
    private val turnClient = VoiceTurnClient(context, coreUrl, edgeVoiceToken)
    private val audioManager by lazy { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    private var mediaDucked = false
    private var mic: MicCapture? = null
    private var mediaPlayer: MediaPlayer? = null
    private var streamingTrack: AudioTrack? = null
    @Volatile private var streamingQueue: LinkedBlockingQueue<ByteArray>? = null
    @Volatile private var streamingCompleteGeneration = -1L
    @Volatile private var drainingTrack: AudioTrack? = null
    private var turnStartedAtMs = 0L
    private var responseAudioStartedAtMs = 0L
    private var responseAudioLastChunkAtMs = 0L
    private val stopped = AtomicBoolean(false)
    private val resumingWakeWord = AtomicBoolean(false)
    private val turnGeneration = AtomicLong(0L)
    @Volatile private var turnWatchdog: ScheduledFuture<*>? = null
    @Volatile private var ignoreDetectionsUntilMs = 0L

    private enum class State { WAKE_WORD, CAPTURING, PROCESSING, PLAYING }
    @Volatile private var state = State.WAKE_WORD

    private val captureBuffer = ArrayList<Short>()
    private var silenceChunks = 0
    private var voicedChunks = 0

    private val wakeWordDetector = WakeWordDetector(
        context = context,
        modelAssetPath = wakeWordModelAsset,
        threshold = wakeThreshold,
        onDetected = { onWakeWordDetected() },
    )

    fun start() {
        if (mic?.isRunning == true) return
        stopped.set(false)
        resumingWakeWord.set(false)
        state = State.WAKE_WORD
        setMediaDucked(true)
        onStatus("listening for wake word")
        mic = MicCapture(context) { chunk -> onMicChunk(chunk) }.also { it.start() }
    }

    fun stop() {
        stopped.set(true)
        mic?.stop()
        mic = null
        wakeWordDetector.close()
        mediaPlayer?.release()
        mediaPlayer = null
        streamingTrack?.release()
        streamingTrack = null
        drainingTrack?.release()
        drainingTrack = null
        turnWatchdog?.cancel(true)
        executor.shutdownNow()
        playbackExecutor.shutdownNow()
        watchdogExecutor.shutdownNow()
    }

    private fun onMicChunk(chunk: ShortArray) {
        when (state) {
            State.WAKE_WORD -> wakeWordDetector.feed(chunk)
            State.CAPTURING -> onCaptureChunk(chunk)
            State.PROCESSING -> { /* mic still runs; chunks are dropped until back to wake-word state */ }
            State.PLAYING -> wakeWordDetector.feed(
                chunk,
                suppressDetection = SystemClock.elapsedRealtime() < ignoreDetectionsUntilMs,
            )
        }
    }

    private fun onWakeWordDetected() {
        if (stopped.get()) return
        setMediaDucked(false)
        if (state == State.PLAYING) {
            Log.i(TAG, "Wake word detected during playback; interrupting reply audio")
            // Invalidate callbacks from the interrupted HTTP stream immediately. The next
            // capture gets its own generation when it is submitted.
            turnGeneration.incrementAndGet()
            turnWatchdog?.cancel(false)
            turnWatchdog = null
            interruptReplyPlayback()
        } else if (state != State.WAKE_WORD) {
            return
        }
        Log.i(TAG, "Wake word detected — capturing utterance (state=$state)")
        if (wakeAckEnabled) playCue(wakeAckSound)
        state = State.CAPTURING
        captureBuffer.clear()
        silenceChunks = 0
        voicedChunks = 0
        ignoreDetectionsUntilMs = 0L
        onStatus("listening")
    }

    /** Duck the media stream while idle-listening so the wake-word isn't masked by
     *  on-device music (VOICE_RECOGNITION AEC has limits at full volume), then restore
     *  full volume when the wake-word fires so the reply plays clearly. */
    private fun setMediaDucked(ducked: Boolean) {
        if (mediaDucked == ducked) return
        mediaDucked = ducked
        try {
            val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val level = if (ducked) (max * 0.45f).toInt().coerceAtLeast(1) else max
            audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, level, 0)
        } catch (_: Exception) { /* volume control is best-effort */ }
    }

    private fun onCaptureChunk(chunk: ShortArray) {
        captureBuffer.addAll(chunk.toList())

        val rms = rms(chunk)
        if (rms >= SILENCE_RMS_THRESHOLD) {
            voicedChunks++
            silenceChunks = 0
        } else {
            silenceChunks++
        }

        // A false wake should recover after the normal silence window instead of waiting
        // for the ten-second capture cap.
        val endBySilence = silenceChunks >= MAX_SILENCE_CHUNKS
        val endByMaxLength = captureBuffer.size / MicCapture.CHUNK_SAMPLES >= MAX_CAPTURE_CHUNKS
        if (endBySilence || endByMaxLength) {
            finishCapture()
        }
    }

    private fun finishCapture() {
        if (stopped.get() || state != State.CAPTURING) return
        turnStartedAtMs = System.currentTimeMillis()
        state = State.PROCESSING
        onStatus("thinking")
        val pcm = captureBuffer.toShortArray()
        val capturedVoicedChunks = voicedChunks
        val capturedSilenceChunks = silenceChunks
        captureBuffer.clear()
        val generation = turnGeneration.incrementAndGet()
        turnWatchdog?.cancel(false)
        turnWatchdog = watchdogExecutor.schedule({
            if (!stopped.get() && turnGeneration.get() == generation &&
                (state == State.PROCESSING || state == State.PLAYING)
            ) {
                Log.w(TAG, "Voice turn watchdog expired; stopping playback and re-arming")
                interruptReplyPlayback()
                resumeWakeWord(generation)
            }
        }, TURN_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        Log.i(TAG, "Voice capture finished: samples=${pcm.size} durationMs=${pcm.size * 1000L / MicCapture.SAMPLE_RATE} voicedChunks=$capturedVoicedChunks silenceChunks=$capturedSilenceChunks")
        executor.execute {
            try {
                if (capturedVoicedChunks < MIN_VOICED_CHUNKS) {
                    Log.i(TAG, "No speech received after wake word")
                    if (noIntentEnabled) playCue(noIntentSound)
                    resumeWakeWord(generation)
                    return@execute
                }
                val wav = pcm16ToWav(pcm)
                var goodCuePlayed = false
                Log.i(TAG, "Sending voice turn to Core: wavBytes=${wav.size}")
                val result = turnClient.streamTurn(wav, deviceId, UUID.randomUUID().toString()) { audio ->
                    if (!goodCuePlayed && goodIntentEnabled) {
                        goodCuePlayed = true
                        playCue(goodIntentSound)
                    }
                    playStreamChunk(audio, generation)
                }
                if (turnGeneration.get() != generation) return@execute
                val turnElapsed = System.currentTimeMillis() - turnStartedAtMs
                Log.i(TAG, "Voice turn completed: elapsedMs=$turnElapsed receivedAudio=${result.receivedAudio} transcript='${result.transcript}' reply='${result.reply}'")
                onStatus(result.reply.ifEmpty { "done" })
                if (result.transcript.isBlank()) {
                    if (noIntentEnabled) playCue(noIntentSound)
                    if (result.receivedAudio) finishStreamPlayback(generation) else resumeWakeWord(generation)
                } else {
                    if (!goodCuePlayed && goodIntentEnabled) playCue(goodIntentSound)
                    if (result.receivedAudio) finishStreamPlayback(generation) else resumeWakeWord(generation)
                }
            } catch (error: Exception) {
                Log.e(TAG, "Voice turn failed", error)
                if (turnGeneration.get() == generation) {
                    onStatus("error: ${error.message}")
                    if (noIntentEnabled) playCue(noIntentSound)
                    interruptReplyPlayback()
                    resumeWakeWord(generation)
                }
            }
        }
    }

    private fun playReply(audioBytes: ByteArray) {
        if (stopped.get()) return
        try {
            val tmp = File.createTempFile("canvas-voice-reply", ".wav", context.cacheDir)
            FileOutputStream(tmp).use { it.write(pcm16ToWav(audioBytes, PIPER_SAMPLE_RATE)) }
            mediaPlayer?.release()
            val player = MediaPlayer()
            mediaPlayer = player
            player.apply {
                setDataSource(tmp.absolutePath)
                setOnCompletionListener {
                    tmp.delete()
                    if (mediaPlayer === player) resumeWakeWord()
                }
                setOnErrorListener { _, what, extra ->
                    Log.w(TAG, "TTS playback error what=$what extra=$extra")
                    tmp.delete()
                    if (mediaPlayer === player) resumeWakeWord()
                    true
                }
                prepare()
                start()
            }
            val durationMs = player.duration.toLong().coerceAtLeast(0L)
            Thread {
                try { Thread.sleep(durationMs + WAKE_ECHO_COOLDOWN_MS) } catch (_: InterruptedException) { }
                if (mediaPlayer === player && player.isPlaying) {
                    Log.w(TAG, "TTS completion callback timed out; resuming wake word")
                    player.stop()
                    tmp.delete()
                    resumeWakeWord()
                }
            }.start()
        } catch (error: Exception) {
            Log.e(TAG, "Failed to play TTS reply", error)
            resumeWakeWord()
        }
    }

    private fun resumeWakeWord(expectedGeneration: Long? = null) {
        if (stopped.get() || (expectedGeneration != null && turnGeneration.get() != expectedGeneration) ||
            !resumingWakeWord.compareAndSet(false, true)
        ) return
        turnWatchdog?.cancel(false)
        turnWatchdog = null
        val now = System.currentTimeMillis()
        val sinceTurnStart = if (turnStartedAtMs > 0) now - turnStartedAtMs else -1L
        val sinceAudio = if (responseAudioLastChunkAtMs > 0) now - responseAudioLastChunkAtMs else -1L
        wakeWordDetector.reset()
        state = State.WAKE_WORD
        setMediaDucked(true)
        onStatus("listening for wake word")
        Log.i(TAG, "Wake word re-armed: totalSinceTurnMs=$sinceTurnStart sinceLastAudioMs=$sinceAudio audioStartedAt=$responseAudioStartedAtMs lastAudioAt=$responseAudioLastChunkAtMs")
        turnStartedAtMs = 0L
        responseAudioStartedAtMs = 0L
        responseAudioLastChunkAtMs = 0L
        ignoreDetectionsUntilMs = 0L
        resumingWakeWord.set(false)
    }

    private fun interruptReplyPlayback() {
        mediaPlayer?.runCatching { stop() }
        mediaPlayer?.release()
        mediaPlayer = null
        streamingTrack?.runCatching { stop() }
        streamingTrack?.release()
        streamingTrack = null
        streamingQueue?.clear()
        streamingQueue = null
        streamingCompleteGeneration = -1L
        drainingTrack?.runCatching { stop() }
        drainingTrack?.release()
        drainingTrack = null
        ignoreDetectionsUntilMs = 0L
        responseAudioLastChunkAtMs = System.currentTimeMillis()
    }

    private fun playStreamChunk(pcm: ByteArray, generation: Long) {
        if (stopped.get() || pcm.isEmpty() || turnGeneration.get() != generation ||
            (state != State.PROCESSING && state != State.PLAYING)
        ) return
        val now = System.currentTimeMillis()
        if (responseAudioStartedAtMs == 0L) {
            responseAudioStartedAtMs = now
            Log.i(TAG, "First response audio received: msAfterTurnStart=${if (turnStartedAtMs > 0) now - turnStartedAtMs else -1L} bytes=${pcm.size}")
        }
        responseAudioLastChunkAtMs = now
        var track = streamingTrack
        if (track == null) {
            val minBuffer = AudioTrack.getMinBufferSize(PIPER_SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            track = AudioTrack.Builder()
                .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(PIPER_SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minBuffer * 4, pcm.size))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            streamingTrack = track
            val queue = LinkedBlockingQueue<ByteArray>()
            streamingQueue = queue
            streamingCompleteGeneration = -1L
            wakeWordDetector.reset()
            // Cover the first speaker samples before AudioTrack has a playback head from
            // which the queued tail can be measured.
            ignoreDetectionsUntilMs = SystemClock.elapsedRealtime() +
                (pcm.size / 2L) * 1_000L / PIPER_SAMPLE_RATE
            state = State.PLAYING
            onStatus("speaking")
            track.play()
            playbackExecutor.execute { runStreamPlayback(track, queue, generation) }
        }
        streamingQueue?.offer(pcm)
    }

    private fun finishStreamPlayback(generation: Long) {
        if (turnGeneration.get() != generation) return
        if (streamingTrack == null || streamingQueue == null) {
            Log.i(TAG, "No streaming track to drain; re-arming wake word immediately")
            resumeWakeWord(generation)
            return
        }
        streamingCompleteGeneration = generation
    }

    private fun runStreamPlayback(
        track: AudioTrack,
        queue: LinkedBlockingQueue<ByteArray>,
        generation: Long,
    ) {
        var framesWritten = 0L
        try {
            while (!stopped.get() && turnGeneration.get() == generation && streamingTrack === track) {
                val pcm = queue.poll(50L, TimeUnit.MILLISECONDS)
                if (pcm == null) {
                    if (streamingCompleteGeneration == generation && queue.isEmpty()) break
                    continue
                }
                var offset = 0
                var stalledAt = SystemClock.elapsedRealtime()
                while (offset < pcm.size) {
                    if (stopped.get() || turnGeneration.get() != generation || streamingTrack !== track) return
                    val written = track.write(pcm, offset, pcm.size - offset, AudioTrack.WRITE_NON_BLOCKING)
                    if (written < 0) error("AudioTrack write failed: $written")
                    if (written == 0) {
                        if (SystemClock.elapsedRealtime() - stalledAt >= MAX_STREAM_WRITE_STALL_MS) {
                            error("AudioTrack write made no progress for ${MAX_STREAM_WRITE_STALL_MS}ms")
                        }
                        Thread.sleep(WRITE_RETRY_MS)
                        continue
                    }
                    offset += written
                    framesWritten += written / 2L
                    stalledAt = SystemClock.elapsedRealtime()
                    updateDetectionSuppression(track, framesWritten)
                }
            }

            if (stopped.get() || turnGeneration.get() != generation || streamingTrack !== track) return
            streamingTrack = null
            streamingQueue = null
            drainingTrack = track
            drainStreamPlayback(track, framesWritten, generation)
        } catch (error: Exception) {
            if (!stopped.get() && turnGeneration.get() == generation) {
                Log.e(TAG, "Streaming playback failed", error)
                onStatus("error: ${error.message}")
                interruptReplyPlayback()
                resumeWakeWord(generation)
            }
        }
    }

    private fun drainStreamPlayback(track: AudioTrack, framesWritten: Long, generation: Long) {
        val initialRemaining = remainingFrames(track, framesWritten)
        val drainMs = initialRemaining * 1_000L / PIPER_SAMPLE_RATE
        val deadline = SystemClock.elapsedRealtime() + minOf(
            drainMs + MAX_DRAIN_MS,
            TURN_TIMEOUT_MS,
        )
        Log.i(TAG, "Draining response audio: writtenFrames=$framesWritten playedFrames=${track.playbackHeadPosition} remainingFrames=$initialRemaining drainMs=$drainMs")
        while (drainingTrack === track && turnGeneration.get() == generation &&
            remainingFrames(track, framesWritten) > 0L && SystemClock.elapsedRealtime() < deadline
        ) {
            updateDetectionSuppression(track, framesWritten, WAKE_ECHO_COOLDOWN_MS)
            Thread.sleep(WRITE_RETRY_MS)
        }
        if (drainingTrack !== track || turnGeneration.get() != generation || state != State.PLAYING) return

        // playbackHeadPosition can reach the final frame before the device/HAL has
        // rendered its buffered tail. Keep the track alive through that latency.
        ignoreDetectionsUntilMs = SystemClock.elapsedRealtime() + WAKE_ECHO_COOLDOWN_MS
        Thread.sleep(WAKE_ECHO_COOLDOWN_MS)
        if (drainingTrack !== track || turnGeneration.get() != generation || state != State.PLAYING) return
        try { track.stop() } catch (_: IllegalStateException) { }
        track.release()
        drainingTrack = null
        Log.i(TAG, "Response audio drain complete; re-arming wake word")
        resumeWakeWord(generation)
    }

    private fun remainingFrames(track: AudioTrack, framesWritten: Long): Long {
        val playedFrames = track.playbackHeadPosition.toLong() and 0xffffffffL
        return (framesWritten - playedFrames).coerceAtLeast(0L)
    }

    private fun updateDetectionSuppression(track: AudioTrack, framesWritten: Long, extraMs: Long = 0L) {
        val actualTailMs = remainingFrames(track, framesWritten) * 1_000L / PIPER_SAMPLE_RATE
        ignoreDetectionsUntilMs = SystemClock.elapsedRealtime() + actualTailMs + extraMs
    }

    private fun playCue(sound: String) {
        val frequencies = when (sound) {
            "builtin:soft_chime" -> doubleArrayOf(523.25, 659.25, 783.99)
            "builtin:glass_ping" -> doubleArrayOf(1318.51, 1760.0)
            "builtin:ready_up" -> doubleArrayOf(660.0, 880.0)
            "builtin:digital_pop" -> doubleArrayOf(1046.5)
            "builtin:wood_tap" -> doubleArrayOf(220.0, 165.0)
            "builtin:confirm_tone" -> doubleArrayOf(880.0, 1174.66)
            else -> return
        }
        val sampleRate = MicCapture.SAMPLE_RATE
        val samplesPerTone = sampleRate * 120 / 1000
        val samples = ShortArray(samplesPerTone * frequencies.size)
        frequencies.forEachIndexed { toneIndex, frequency ->
            for (sampleIndex in 0 until samplesPerTone) {
                val t = sampleIndex.toDouble() / sampleRate
                val envelope = (1.0 - sampleIndex.toDouble() / samplesPerTone) * 0.55
                samples[toneIndex * samplesPerTone + sampleIndex] =
                    (kotlin.math.sin(2.0 * Math.PI * frequency * t) * Short.MAX_VALUE * envelope).toInt().toShort()
            }
        }
        val minBuffer = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(minBuffer, samples.size * 2))
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(samples, 0, samples.size)
        track.play()
        Thread {
            try { Thread.sleep((samples.size * 1000L / sampleRate) + 100L) } catch (_: InterruptedException) { }
            track.release()
        }.start()
    }

    private fun rms(chunk: ShortArray): Double {
        var sumSquares = 0.0
        for (s in chunk) sumSquares += (abs(s.toInt())).toDouble().let { it * it }
        return sqrt(sumSquares / chunk.size)
    }

    private fun pcm16ToWav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val buffer = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put("RIFF".toByteArray())
        buffer.putInt(36 + pcm.size)
        buffer.put("WAVE".toByteArray())
        buffer.put("fmt ".toByteArray())
        buffer.putInt(16)
        buffer.putShort(1)
        buffer.putShort(1)
        buffer.putInt(sampleRate)
        buffer.putInt(sampleRate * 2)
        buffer.putShort(2)
        buffer.putShort(16)
        buffer.put("data".toByteArray())
        buffer.putInt(pcm.size)
        buffer.put(pcm)
        return buffer.array()
    }

    /** Wraps raw S16LE mono PCM in a WAV container — Kotlin port of direct-wakeword.ts's pcm16ToWav(). */
    private fun pcm16ToWav(pcm: ShortArray, sampleRate: Int = MicCapture.SAMPLE_RATE): ByteArray {
        val dataSize = pcm.size * 2
        val buffer = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put("RIFF".toByteArray())
        buffer.putInt(36 + dataSize)
        buffer.put("WAVE".toByteArray())
        buffer.put("fmt ".toByteArray())
        buffer.putInt(16)
        buffer.putShort(1) // PCM
        buffer.putShort(1) // mono
        buffer.putInt(sampleRate)
        buffer.putInt(sampleRate * 2) // byte rate
        buffer.putShort(2) // block align
        buffer.putShort(16) // bits per sample
        buffer.put("data".toByteArray())
        buffer.putInt(dataSize)
        for (s in pcm) buffer.putShort(s)
        return buffer.array()
    }
}
