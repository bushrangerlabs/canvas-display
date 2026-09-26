package com.bushrangerlabs.canvas_display_edge.voice

import android.content.Context
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import org.tensorflow.lite.Interpreter

/**
 * On-device wake-word detector — Kotlin port of openWakeWord's `Model.predict` for a
 * single wake-word classifier (github.com/dscripka/openWakeWord, `openwakeword/model.py`).
 * Feed it 80ms PCM16 chunks via [feed]; it calls [onDetected] once when the score crosses
 * [threshold], with the same 5-frame warmup suppression the Python implementation uses to
 * avoid startup false positives.
 */
class WakeWordDetector(
    context: Context,
    modelAssetPath: String,
    private val threshold: Float = 0.5f,
    private val onScore: (Float) -> Unit = {},
    private val onDetected: () -> Unit = {},
) {
    private val features = AudioFeatures(context)
    private val classifier: Interpreter
    private val inputFrames: Int

    init {
        val afd = context.assets.openFd(modelAssetPath)
        val model = FileInputStream(afd.fileDescriptor).channel.map(
            FileChannel.MapMode.READ_ONLY, afd.startOffset, afd.declaredLength,
        )
        classifier = Interpreter(model)
        inputFrames = classifier.getInputTensor(0).shape()[1] // e.g. 16 embedding frames of context
    }

    private var framesSeen = 0
    private var lastDetectedFramesSeen = -1000

    @Synchronized
    fun feed(chunk: ShortArray, suppressDetection: Boolean = false) {
        features.process(chunk)
        val window = features.getFeatures(inputFrames) ?: return
        framesSeen++

        val input = FloatArray(inputFrames * 96)
        for (f in 0 until inputFrames) for (d in 0 until 96) input[f * 96 + d] = window[f][d]
        val inputBuffer = ByteBuffer.allocateDirect(input.size * 4).order(ByteOrder.nativeOrder())
        input.forEach { inputBuffer.putFloat(it) }
        inputBuffer.rewind()
        val outputBuffer = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder())
        classifier.run(inputBuffer, outputBuffer)
        outputBuffer.rewind()
        var score = outputBuffer.float

        // openWakeWord zeroes predictions for the first 5 frames after (re)init to avoid
        // startup transients scoring artificially high (see Model.predict in model.py).
        if (framesSeen <= 5) score = 0f

        onScore(score)
        if (!suppressDetection && score >= threshold && framesSeen - lastDetectedFramesSeen > 1) {
            lastDetectedFramesSeen = framesSeen
            onDetected()
        }
    }

    @Synchronized
    fun reset() {
        features.reset()
        framesSeen = 0
        lastDetectedFramesSeen = -1000
    }

    @Synchronized
    fun close() {
        features.close()
        classifier.close()
    }
}
