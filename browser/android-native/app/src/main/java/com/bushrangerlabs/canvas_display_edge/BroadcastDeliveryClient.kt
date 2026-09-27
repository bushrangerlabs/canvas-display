package com.bushrangerlabs.canvas_display_edge

import android.content.Context
import android.util.Base64
import com.bushrangerlabs.canvas_display_edge.dlna.AndroidDlnaAdapter
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Durable Core broadcast consumer with local receipt deduplication. */
class BroadcastDeliveryClient(
    context: Context,
    private val config: EdgeConfig,
    private val deviceId: String,
    private val adapter: AndroidDlnaAdapter,
    private val showAlert: (JSONObject, (Throwable?) -> Unit) -> Unit,
) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("broadcast-deliveries", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val busy = AtomicBoolean(false)
    @Volatile private var running = false

    fun start() {
        if (running) return
        running = true
        executor.scheduleWithFixedDelay({ poll() }, 0, 2, TimeUnit.SECONDS)
    }

    fun stop() {
        running = false
        executor.shutdownNow()
    }

    private fun poll() {
        if (!running || config.edgeVoiceToken.isBlank() || !busy.compareAndSet(false, true)) return
        var deliveryId: String? = null
        try {
            val request = Request.Builder()
                .url("${config.coreUrl.trimEnd('/')}/api/edge/deliveries/next?deviceId=${java.net.URLEncoder.encode(deviceId, "UTF-8")}")
                .header("Authorization", "Bearer ${config.edgeVoiceToken}")
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) { busy.set(false); return }
                val json = JSONObject(response.body?.string().orEmpty())
                if (json.optBoolean("empty", false)) { busy.set(false); return }
                deliveryId = json.getString("deliveryId")
                if (prefs.getBoolean(deliveryId, false)) {
                    ack(deliveryId, "completed", null)
                    busy.set(false)
                    return
                }
                when (json.getString("kind")) {
                    "alert" -> {
                        ack(deliveryId, "started", null)
                        showAlert(json.optJSONObject("payload") ?: JSONObject()) { finish(json, it) }
                    }
                    else -> playAudio(json)
                }
            }
        } catch (error: Throwable) {
            deliveryId?.let { runCatching { ack(it, "failed", error.message) } }
            busy.set(false)
            android.util.Log.w("CanvasBroadcast", "delivery poll failed: ${error.message}")
        }
    }

    private fun playAudio(json: JSONObject) {
        val encoded = json.optString("audioBase64")
        if (encoded.isBlank()) throw IllegalArgumentException("delivery contains no audio")
        val decoded = Base64.decode(encoded, Base64.DEFAULT)
        val mime = json.optString("mimeType", "audio/wav")
        val bytes = if (mime.contains("wav") && !decoded.copyOfRange(0, minOf(4, decoded.size)).contentEquals("RIFF".toByteArray())) {
            pcm16ToWav(decoded, 22_050)
        } else decoded
        val file = File(appContext.cacheDir, "broadcast-${json.getString("deliveryId")}.audio")
        file.writeBytes(bytes)
        adapter.playAudioObserved(
            file.absolutePath,
            json.optString("title", "Broadcast"),
            100,
            { executor.execute { runCatching { ack(json.getString("deliveryId"), "started", null) } } },
            { error -> file.delete(); finish(json, error) },
        )
    }

    private fun finish(json: JSONObject, error: Throwable?) {
        executor.execute {
            val id = json.getString("deliveryId")
            try {
                if (error == null) {
                    prefs.edit().putBoolean(id, true).apply()
                    ack(id, "completed", null)
                } else ack(id, "failed", error.message)
            } catch (ackError: Throwable) {
                android.util.Log.w("CanvasBroadcast", "delivery acknowledgement failed: ${ackError.message}")
            } finally {
                busy.set(false)
            }
        }
    }

    private fun ack(id: String, state: String, error: String?) {
        val body = JSONObject().put("deviceId", deviceId).put("state", state)
        if (!error.isNullOrBlank()) body.put("error", error.take(500))
        val request = Request.Builder()
            .url("${config.coreUrl.trimEnd('/')}/api/edge/deliveries/$id/ack")
            .header("Authorization", "Bearer ${config.edgeVoiceToken}")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { if (!it.isSuccessful && it.code != 404) error("HTTP ${it.code}") }
    }

    private fun pcm16ToWav(pcm: ByteArray, sampleRate: Int): ByteArray {
        val result = ByteBuffer.allocate(44 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
        result.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVE".toByteArray())
        result.put("fmt ".toByteArray()).putInt(16).putShort(1.toShort()).putShort(1.toShort())
        result.putInt(sampleRate).putInt(sampleRate * 2).putShort(2.toShort()).putShort(16.toShort())
        result.put("data".toByteArray()).putInt(pcm.size).put(pcm)
        return result.array()
    }
}
