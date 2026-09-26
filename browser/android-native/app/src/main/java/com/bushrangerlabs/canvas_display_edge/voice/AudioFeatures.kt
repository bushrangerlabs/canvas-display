package com.bushrangerlabs.canvas_display_edge.voice

import android.content.Context
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import org.tensorflow.lite.Interpreter

/**
 * Streaming audio feature extractor — a Kotlin port of openWakeWord's `AudioFeatures`
 * class (github.com/dscripka/openWakeWord, `openwakeword/utils.py`), which computes
 * Google's `speech_embedding` features from raw 16kHz mono PCM16 audio via two chained
 * TFLite models (melspectrogram -> embedding). This is the same feature pipeline the
 * Linux sidecar's Python openWakeWord process runs (`server/src/voice/wakeword-local.ts`).
 *
 * Model files are binary ML assets and are bundled under `app/src/main/assets/openwakeword/`:
 *   melspectrogram.tflite, embedding_model.tflite, and one file per wake word
 *   (hey_jarvis.tflite, alexa.tflite, hey_mycroft.tflite, hey_rhasspy.tflite), sourced
 *   from the official openWakeWord v0.5.1 release
 *   (https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1). `EdgeConfig.wakeWord`
 *   (set via Core, see VoiceConfigClient) selects which `<wakeword>.tflite` file loads.
 */
class AudioFeatures(context: Context) {
    private val melspec = loadInterpreter(context, "openwakeword/melspectrogram.tflite")
    private val embedding = loadInterpreter(context, "openwakeword/embedding_model.tflite")

    // np.ones((76, 32)) initial state — see openwakeword/utils.py AudioFeatures.__init__
    private val melBuffer = ArrayDeque<FloatArray>().apply { repeat(WINDOW_SIZE) { addLast(FloatArray(32) { 1f }) } }
    private val featureBuffer = ArrayDeque<FloatArray>()
    private val rawBuffer = ArrayDeque<Short>()

    private var accumulatedSamples = 0

    private companion object {
        const val RAW_BUFFER_MAX = 16_000 * 10
        const val MEL_BUFFER_MAX = 10 * 97 // ~10s of mel frames
        const val FEATURE_BUFFER_MAX = 120 // ~10s of embeddings
        const val MEL_CONTEXT_SAMPLES = 160 * 3 // matches openWakeWord's streaming context padding
        const val WINDOW_SIZE = 76
        const val STEP_SIZE = 8

        fun loadInterpreter(context: Context, assetPath: String): Interpreter {
            val afd = context.assets.openFd(assetPath)
            val model = FileInputStream(afd.fileDescriptor).channel.map(
                FileChannel.MapMode.READ_ONLY, afd.startOffset, afd.declaredLength,
            )
            return Interpreter(model, Interpreter.Options().setUseXNNPACK(false))
        }
    }

    /** Feed exactly one 80ms (1280-sample) chunk of 16kHz mono PCM16 audio. */
    @Synchronized
    fun process(chunk: ShortArray) {
        require(chunk.size == MicCapture.CHUNK_SAMPLES) { "AudioFeatures expects 1280-sample chunks" }
        bufferRaw(chunk)
        accumulatedSamples += chunk.size

        if (accumulatedSamples >= MicCapture.CHUNK_SAMPLES && accumulatedSamples % MicCapture.CHUNK_SAMPLES == 0) {
            streamingMelspectrogram(accumulatedSamples)

            var i = accumulatedSamples / MicCapture.CHUNK_SAMPLES - 1
            while (i >= 0) {
                val offset = -STEP_SIZE * i
                val ndx = if (offset == 0) melBuffer.size else offset + melBuffer.size
                val start = ndx - WINDOW_SIZE
                if (start >= 0 && ndx <= melBuffer.size) {
                    val melList = melBuffer.toList()
                    val window = melList.subList(start, ndx)
                    if (window.size == WINDOW_SIZE) featureBuffer.addLast(runEmbedding(window))
                }
                i--
            }
            accumulatedSamples = 0
        }

        while (featureBuffer.size > FEATURE_BUFFER_MAX) featureBuffer.removeFirst()
    }

    /** Last [n] embedding frames (96-dim each), or null if not enough history yet. */
    @Synchronized
    fun getFeatures(n: Int): Array<FloatArray>? {
        if (featureBuffer.size < n) return null
        return featureBuffer.toList().takeLast(n).toTypedArray()
    }

    fun reset() {
        melBuffer.clear()
        repeat(WINDOW_SIZE) { melBuffer.addLast(FloatArray(32) { 1f }) }
        featureBuffer.clear()
        rawBuffer.clear()
        accumulatedSamples = 0
    }

    fun close() {
        melspec.close()
        embedding.close()
    }

    private fun bufferRaw(chunk: ShortArray) {
        for (s in chunk) {
            rawBuffer.addLast(s)
            if (rawBuffer.size > RAW_BUFFER_MAX) rawBuffer.removeFirst()
        }
    }

    private fun streamingMelspectrogram(nSamples: Int) {
        val needed = nSamples + MEL_CONTEXT_SAMPLES
        val available = rawBuffer.toList()
        val samples = if (available.size >= needed) available.takeLast(needed) else available
        val newFrames = runMelspec(samples)
        for (frame in newFrames) melBuffer.addLast(frame)
        while (melBuffer.size > MEL_BUFFER_MAX) melBuffer.removeFirst()
    }

    /** Runs the melspectrogram TFLite model on raw int16 samples (cast to float, no scaling —
     * matches openWakeWord: melspec_transform = x/10 + 2 applied to the model's raw output). */
    private fun runMelspec(samples: List<Short>): List<FloatArray> {
        val input = FloatArray(samples.size) { samples[it].toFloat() }
        val inputBuffer = ByteBuffer.allocateDirect(input.size * 4).order(ByteOrder.nativeOrder())
        input.forEach { inputBuffer.putFloat(it) }
        inputBuffer.rewind()

        melspec.resizeInput(0, intArrayOf(1, input.size))
        melspec.allocateTensors()
        val outShape = melspec.getOutputTensor(0).shape()
        val outCount = outShape.fold(1) { a, b -> a * b }
        val outputBuffer = ByteBuffer.allocateDirect(outCount * 4).order(ByteOrder.nativeOrder())
        melspec.run(inputBuffer, outputBuffer)
        outputBuffer.rewind()

        val flat = FloatArray(outCount)
        outputBuffer.asFloatBuffer().get(flat)
        // Last dimension is the 32 mel bins regardless of the model's exact output rank
        // (openWakeWord squeezes a (1,1,frames,32) or (1,frames,32) output down to (frames,32)).
        val frames = outCount / 32
        return (0 until frames).map { f ->
            FloatArray(32) { b -> flat[f * 32 + b] / 10f + 2f }
        }
    }

    private fun runEmbedding(window: List<FloatArray>): FloatArray {
        val input = FloatArray(WINDOW_SIZE * 32)
        for (f in 0 until WINDOW_SIZE) for (b in 0 until 32) input[f * 32 + b] = window[f][b]
        val inputBuffer = ByteBuffer.allocateDirect(input.size * 4).order(ByteOrder.nativeOrder())
        input.forEach { inputBuffer.putFloat(it) }
        inputBuffer.rewind()

        embedding.resizeInput(0, intArrayOf(1, WINDOW_SIZE, 32, 1))
        embedding.allocateTensors()
        val outShape = embedding.getOutputTensor(0).shape()
        val outCount = outShape.fold(1) { a, b -> a * b } // expected 96
        val outputBuffer = ByteBuffer.allocateDirect(outCount * 4).order(ByteOrder.nativeOrder())
        embedding.run(inputBuffer, outputBuffer)
        outputBuffer.rewind()
        val result = FloatArray(outCount)
        outputBuffer.asFloatBuffer().get(result)
        return result
    }
}
