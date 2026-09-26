package com.bushrangerlabs.canvas_display_edge

import android.util.Log
import android.content.Context
import com.bushrangerlabs.canvas_display_edge.voice.DeviceActionHandler
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit.MILLISECONDS

private const val EDGE_APP_VERSION = "0.3.1"

class CoreEdgeClient(
    private val appContext: Context,
    private val config: EdgeConfig,
    private val identity: EdgeIdentity,
    private val credential: JSONObject?,
    private val onScene: (JSONObject, (Boolean, String?) -> Unit) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onVoiceConfigChanged: () -> Unit,
    private val onMediaUrl: (String, String) -> Boolean,
    private val onMediaControl: (String) -> Boolean,
    private val onOpenPage: (String, Long) -> Unit,
    private val onAppControl: (String) -> Unit,
) {
    private val http = CoreTls.client()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private var socket: WebSocket? = null
    private var coreEpoch = ""
    private var edgeEpoch = UUID.randomUUID().toString()
    private var edgeSequence = 0L
    private var lastCoreSequence = 0L
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private var heartbeat: ScheduledFuture<*>? = null

    fun connect() {
        val wsUrl = config.coreUrl.replaceFirst("^http".toRegex(), "ws") + "/gateway/v1"
        onStatus("connecting: $wsUrl")
        socket = http.newWebSocket(
            Request.Builder().url(wsUrl).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                    onStatus("connected")
                    registerDevice()
                    webSocket.send(hello().toString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(JSONObject(text))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    heartbeat?.cancel(false)
                    onStatus("disconnected: $code $reason")
                    onStatus("closing: $code $reason")
                    webSocket.close(1000, null)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                    heartbeat?.cancel(false)
                    onStatus("disconnected: ${t.message ?: "WebSocket failure"}")
                    Log.e("CanvasEdge", "Core WebSocket failure", t)
                    scheduler.schedule({ connect() }, 2, TimeUnit.SECONDS)
                }
            },
        )
    }

    fun close() {
        heartbeat?.cancel(false)
        scheduler.shutdownNow()
        socket?.close(1000, "app stopped")
        socket = null
    }

    private fun hello(): JSONObject = JSONObject()
        .put("type", "edge.hello")
        .put("message_id", UUID.randomUUID().toString())
        .put("device_id", identity.installationId)
        .put("agent", JSONObject().put("version", EDGE_APP_VERSION).put("platform", "android").put("architecture", "arm64"))
        .put("protocol", JSONObject().put("minimum", 1).put("maximum", 1))
        .put("capabilities", JSONObject()
            .put("renderer", org.json.JSONArray()
                .put("webview").put("multi_panel").put("panel_geometry")
                .put("floating_panel").put("offline_page_cache"))
            .put("media", org.json.JSONArray()
                .put("url_playback").put("pause").put("resume").put("stop").put("next"))
            .put("voice", org.json.JSONArray()
                .put("wake_word").put("streaming_turn").put("interrupt_reply").put("audio_diagnostics"))
            .put("hardware", org.json.JSONArray()
                .put("display").put("app_lifecycle").put("boot_autostart")))
        .put("installation_id", identity.installationId)
        .put("public_key_fingerprint", identity.fingerprint)
        .put("credential", credential ?: JSONObject.NULL)

    private fun handleMessage(message: JSONObject) {
        when (message.optString("type")) {
            "core.welcome" -> {
                val resume = message.optJSONObject("resume")
                coreEpoch = resume?.optString("core_stream_epoch", coreEpoch).orEmpty()
                edgeEpoch = resume?.optString("edge_stream_epoch", edgeEpoch).orEmpty()
                val seconds = message.optLong("heartbeat_seconds", 20L).coerceAtLeast(5L)
                heartbeat?.cancel(false)
                heartbeat = scheduler.scheduleAtFixedRate({ sendHeartbeat() }, seconds, seconds, TimeUnit.SECONDS)
                onStatus("online")
            }
            "core.heartbeat" -> lastCoreSequence = message.optLong("last_received_sequence", lastCoreSequence)
            "state.desired" -> {
                val payload = message.optJSONObject("payload") ?: return
                val state = payload.optJSONObject("state") ?: return
                sendStreamAck(message)
                val scene = state.optJSONObject("scene")
                if (scene == null) {
                    sendStateReport(
                        message,
                        payload,
                        state,
                        false,
                        "unsupported desired-state domain: ${state.keys().asSequence().joinToString(",")}",
                    )
                } else {
                    onScene(scene) { rendered, error ->
                        sendStateReport(message, payload, state, rendered, error)
                    }
                }
            }
            "device.action" -> handleDeviceAction(message)
            else -> Log.d("CanvasEdge", "Core message: $message")
        }
    }

    /** Runs a Core-requested audio action (list devices / test mic / test speaker) off the
     * WebSocket read thread and replies with device.action_result, since these block briefly
     * (mic capture, tone playback) and must not stall message handling. */
    private fun handleDeviceAction(message: JSONObject) {
        val requestId = message.optString("request_id")
        val action = message.optString("action")
        val payload = message.optJSONObject("payload") ?: JSONObject()
        if (requestId.isBlank()) return
        Thread({
            val result = when (action) {
                "voice.reload_config" -> {
                    onVoiceConfigChanged()
                    JSONObject().put("ok", true)
                }
                "media.play" -> {
                    val url = payload.optString("url")
                    val source = payload.optString("source", "direct_audio")
                    if (url.isBlank()) JSONObject().put("ok", false).put("error", "missing_url")
                    else {
                        val applied = onMediaUrl(url, source)
                        JSONObject().put("ok", applied).put("media_url", url)
                            .apply { if (!applied) put("error", "media_target_unavailable") }
                    }
                }
                "media.control" -> {
                    val control = payload.optString("action")
                    val supported = control in setOf("pause", "resume", "stop", "next")
                    val applied = supported && onMediaControl(control)
                    JSONObject().put("ok", applied).put("action", control)
                        .apply { if (!supported) put("error", "unsupported_action") else if (!applied) put("error", "media_target_unavailable") }
                }
                "navigate.home" -> {
                    val applied = onMediaControl("stop")
                    JSONObject().put("ok", applied)
                }
                "navigate.search" -> {
                    val url = payload.optString("url")
                    val revertAfterMs = payload.optLong("revert_after_ms", 0L)
                    if (url.isBlank()) JSONObject().put("ok", false).put("error", "missing_url")
                    else {
                        onOpenPage(url, revertAfterMs)
                        JSONObject().put("ok", true).put("url", url)
                    }
                }
                "app.hide", "app.show", "app.restart" -> {
                    // Acknowledge first, then run the lifecycle change on the main thread
                    // (finishing/relaunching an Activity must not happen on this worker).
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ onAppControl(action) }, 50)
                    JSONObject().put("ok", true).put("action", action)
                }
                else -> DeviceActionHandler.handle(appContext, action, payload)
            }
            socket?.send(
                JSONObject()
                    .put("type", "device.action_result")
                    .put("request_id", requestId)
                    .put("payload", result)
                    .toString(),
            )
        }, "canvas-device-action").start()
    }

    private fun sendHeartbeat() {
        socket?.send(
            JSONObject()
                .put("type", "edge.heartbeat")
                .put("protocol", 1)
                .put("sent_at", java.time.Instant.now().toString())
                .put("stream_epoch", edgeEpoch)
                .put("last_received_sequence", lastCoreSequence)
                .toString(),
        )
    }

    private fun sendStreamAck(message: JSONObject) {
        val sequence = message.optLong("sequence", 0L)
        val now = java.time.Instant.now().toString()
        socket?.send(
            JSONObject()
                .put("type", "stream.ack")
                .put("protocol", 1)
                .put("sent_at", now)
                .put("stream_epoch", coreEpoch)
                .put("acknowledged_sequence", sequence)
                .toString(),
        )
    }

    private fun sendStateReport(
        message: JSONObject,
        payload: JSONObject,
        state: JSONObject,
        rendered: Boolean,
        error: String?,
    ) {
        val revision = payload.optLong("revision", 0L)
        val now = java.time.Instant.now().toString()
        edgeSequence += 1
        val application = JSONObject()
        if (state.has("scene")) {
            application.put("scene", JSONObject()
                .put("desired_revision", revision)
                .put("status", if (rendered) "applied" else "failed")
                .put("phase", if (rendered) "rendered" else "failed")
                .apply { if (!error.isNullOrBlank()) put("reason", error) })
        }
        val reportedState = JSONObject().put("connectivity", JSONObject().put("core", "online"))
        if (state.has("scene")) {
            reportedState.put("scene", JSONObject()
                .put("revision_id", state.optJSONObject("scene")?.optString("revision_id"))
                .put("status", if (rendered) "active" else "failed"))
        }
        socket?.send(
            JSONObject()
                .put("type", "state.reported")
                .put("protocol", 1)
                .put("payload_version", 1)
                .put("message_id", UUID.randomUUID().toString())
                .put("correlation_id", message.optString("message_id"))
                .put("sent_at", now)
                .put("stream_epoch", edgeEpoch)
                .put("sequence", edgeSequence)
                .put("payload", JSONObject()
                    .put("application", application)
                    .put("applied_revision", revision)
                    .put("desired_revision", revision)
                    .put("processed_desired_revision", revision)
                    .put("reported_revision", revision)
                    .put("authority_epoch", payload.optString("authority_epoch"))
                    .put("divergences", org.json.JSONArray())
                    .put("state", reportedState)
                    .put("status", if (rendered) "applied" else "failed"))
                .toString(),
        )
    }

    private fun registerDevice() {
        Thread {
            runCatching {
                val body = JSONObject()
                    .put("id", identity.installationId)
                    .put("name", config.deviceName)
                    .put("platform", "android")
                    .put("app_version", EDGE_APP_VERSION)
                    .put("screen_width", 1280)
                    .put("screen_height", 800)
                val request = okhttp3.Request.Builder()
                    .url("${config.coreUrl.trimEnd('/')}/api/devices/register")
                    .post(body.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) error("registration HTTP ${response.code}")
                }
            }.onFailure { Log.w("CanvasEdge", "Core registry registration failed", it) }
        }.start()
    }
}
