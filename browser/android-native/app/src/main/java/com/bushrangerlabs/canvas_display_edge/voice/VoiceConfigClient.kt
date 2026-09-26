package com.bushrangerlabs.canvas_display_edge.voice

import android.content.Context
import com.bushrangerlabs.canvas_display_edge.CoreTls
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Voice settings for this device, as configured by an admin in Canvas Core. */
data class VoiceConfig(
    val wakeWord: String,
    val wakeThreshold: Float,
    val wakeEnabled: Boolean,
    val wakeAckEnabled: Boolean,
    val wakeAckSound: String,
    val goodIntentEnabled: Boolean,
    val goodIntentSound: String,
    val noIntentEnabled: Boolean,
    val noIntentSound: String,
    val edgeVoiceToken: String?,
)

/**
 * Fetches this device's voice settings from Canvas Core — wake word, threshold,
 * enabled/disabled, and the shared voice bridge token. All edge device settings are
 * configured via Core's admin UI (`PUT /api/admin/devices/:id/voice`); the device
 * never stores or exposes a local settings screen for these, it only reads them.
 */
class VoiceConfigClient(context: Context, private val coreUrl: String) {
    private val http = CoreTls.client()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    fun fetch(deviceId: String): VoiceConfig {
        val request = Request.Builder()
            .url("${coreUrl.trimEnd('/')}/api/devices/$deviceId/voice-config")
            .get()
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("Core voice-config fetch failed: HTTP ${response.code} $text")
            val json = JSONObject(text)
            return VoiceConfig(
                wakeWord = json.optString("wake_word", "hey_jarvis"),
                wakeThreshold = json.optDouble("wake_threshold", 0.5).toFloat(),
                wakeEnabled = json.optBoolean("wake_enabled", false),
                wakeAckEnabled = json.optBoolean("wake_ack_enabled", true),
                wakeAckSound = json.optString("wake_ack_sound", "builtin:ready_up"),
                goodIntentEnabled = json.optBoolean("good_intent_enabled", true),
                goodIntentSound = json.optString("good_intent_sound", "builtin:digital_pop"),
                noIntentEnabled = json.optBoolean("no_intent_enabled", true),
                noIntentSound = json.optString("no_intent_sound", "builtin:wood_tap"),
                edgeVoiceToken = json.optString("edge_voice_token", "").ifBlank { null },
            )
        }
    }
}
