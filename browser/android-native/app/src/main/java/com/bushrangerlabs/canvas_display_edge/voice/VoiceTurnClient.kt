package com.bushrangerlabs.canvas_display_edge.voice

import android.content.Context
import android.util.Base64
import android.util.Log
import com.bushrangerlabs.canvas_display_edge.CoreTls
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Result of a voice turn: what was heard, what Core replied, and the TTS audio (if any). */
data class VoiceTurnResult(val transcript: String, val reply: String, val receivedAudio: Boolean)

/**
 * Streams a captured utterance to Canvas Core. Core returns NDJSON events so synthesized
 * PCM chunks can start playback before the complete reply has been generated.
 */
class VoiceTurnClient(context: Context, private val coreUrl: String, private val token: String) {
    private companion object {
        const val TAG = "CanvasVoice"
    }

    private val http = CoreTls.client()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .build()

    fun streamTurn(
        wavBytes: ByteArray,
        deviceId: String,
        turnId: String,
        onAudioChunk: (ByteArray) -> Unit,
    ): VoiceTurnResult {
        val requestStartedAt = System.currentTimeMillis()
        Log.i(TAG, "Voice HTTP request started: wavBytes=${wavBytes.size}")
        val body = JSONObject()
            .put("audioBase64", Base64.encodeToString(wavBytes, Base64.NO_WRAP))
            .put("deviceId", deviceId)
            .put("turnId", turnId)
            .toString()
            .toRequestBody("application/json".toMediaType())

        val request = Request.Builder()
            .url("${coreUrl.trimEnd('/')}/api/edge/voice/turn-stream")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        http.newCall(request).execute().use { response ->
            Log.i(TAG, "Voice HTTP response headers received: status=${response.code} elapsedMs=${System.currentTimeMillis() - requestStartedAt}")
            if (!response.isSuccessful) {
                error("Core voice stream failed: HTTP ${response.code} ${response.body?.string().orEmpty()}")
            }
            var transcript = ""
            var reply = ""
            var receivedAudio = false
            var audioEvents = 0
            var lastAudioAt = 0L
            response.body?.charStream()?.buffered()?.useLines { lines ->
                lines.forEach { line ->
                    if (line.isBlank()) return@forEach
                    val event = JSONObject(line)
                    when (event.optString("type")) {
                        "transcript" -> transcript = event.optString("transcript")
                        "audio" -> {
                            val encoded = event.optString("audioBase64")
                            if (encoded.isNotBlank()) {
                                onAudioChunk(Base64.decode(encoded, Base64.NO_WRAP))
                                receivedAudio = true
                                audioEvents++
                                lastAudioAt = System.currentTimeMillis()
                            }
                        }
                        "meta" -> {
                            transcript = event.optString("transcript", transcript)
                            reply = event.optString("reply", reply)
                        }
                        "error" -> error(event.optString("error", "Core voice stream failed"))
                    }
                }
            } ?: error("Core voice stream had no response body")
            Log.i(TAG, "Voice HTTP stream ended: elapsedMs=${System.currentTimeMillis() - requestStartedAt} audioEvents=$audioEvents lastAudioAgeMs=${if (lastAudioAt > 0) System.currentTimeMillis() - lastAudioAt else -1L}")
            return VoiceTurnResult(
                transcript = transcript,
                reply = reply,
                receivedAudio = receivedAudio,
            )
        }
    }
}
