package com.bushrangerlabs.canvas_display_edge.dlna

import android.content.Context
import android.net.wifi.WifiManager
import java.util.UUID

/**
 * Owns the DLNA MediaRenderer stack for the Android edge app: the SSDP
 * responder, the HTTP control surface and the renderer state machine.
 *
 * Started by [com.bushrangerlabs.canvas_display_edge.MainActivity] once the
 * renderer is up, stopped when the activity is destroyed.
 */
class DlnaService(
    private val context: Context,
    private val adapter: DlnaPlaybackAdapter,
    private val friendlyName: String,
    private val modelNumber: String,
) {

    init {
        // Route DLNA diagnostics to logcat (the package itself has no Android deps).
        DlnaLog.sink = { android.util.Log.i("CanvasDlna", it) }
    }

    private var httpServer: DlnaHttpServer? = null
    private var ssdpServer: SsdpServer? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    /** The renderer, exposed so the app can report its state. */
    val renderer: DlnaRenderer = DlnaRenderer(adapter) { subscriber, body ->
        httpServer?.sendEvent(subscriber, body)
    }

    @Volatile var baseUrl: String = ""
        private set

    @Volatile var running: Boolean = false
        private set

    fun start(): Boolean {
        if (running) return true
        val host = DlnaNetwork.localAddress()
        if (host == null) {
            DlnaLog.warn("no non-loopback IPv4 address; DLNA renderer not started")
            return false
        }

        acquireMulticastLock()

        val config = DlnaDescriptions.Config(
            uuid = resolveUuid(),
            friendlyName = friendlyName,
            manufacturer = "Canvas Display",
            modelName = "Canvas Display",
            modelNumber = modelNumber,
        )

        val server = DlnaHttpServer(config, renderer, DLNA_PORT)
        val url = runCatching { server.start(host) }.getOrElse { error ->
            DlnaLog.warn("DLNA HTTP server failed to start: ${error.message}")
            releaseMulticastLock()
            return false
        }
        httpServer = server
        baseUrl = url

        val ssdp = SsdpServer(
            uuid = config.uuid,
            interfaceAddress = host,
            location = "$url/description.xml",
            server = "Android/14 UPnP/1.0 CanvasDisplay/$modelNumber",
        )
        runCatching { ssdp.start() }.onFailure { DlnaLog.warn("SSDP failed to start: ${it.message}") }
        ssdpServer = ssdp

        running = true
        DlnaLog.info("DLNA MediaRenderer \"$friendlyName\" on $url (uuid ${config.uuid})")
        return true
    }

    fun stop() {
        if (!running) return
        running = false
        runCatching { ssdpServer?.stop() }
        ssdpServer = null
        runCatching { httpServer?.stop() }
        httpServer = null
        baseUrl = ""
        releaseMulticastLock()
    }

    /** Stable per-device UUID: persisted in SharedPreferences, generated once. */
    private fun resolveUuid(): String {
        val prefs = context.getSharedPreferences("edge-config", Context.MODE_PRIVATE)
        prefs.getString("dlna_uuid", null)?.takeIf { it.isNotBlank() }?.let { return it }
        val generated = UUID.randomUUID().toString()
        prefs.edit().putString("dlna_uuid", generated).apply()
        return generated
    }

    /**
     * Android only delivers multicast to an app that holds a MulticastLock, so
     * without this the SSDP M-SEARCH responder never sees a probe.
     */
    private fun acquireMulticastLock() {
        if (multicastLock != null) return
        runCatching {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val lock = wifi?.createMulticastLock("canvas-dlna")?.apply {
                setReferenceCounted(false)
                acquire()
            }
            multicastLock = lock
        }.onFailure { DlnaLog.warn("multicast lock unavailable: ${it.message}") }
    }

    private fun releaseMulticastLock() {
        runCatching { multicastLock?.takeIf { it.isHeld }?.release() }
        multicastLock = null
    }

    companion object {
        /** Matches the Linux sidecar's default DLNA port. */
        const val DLNA_PORT = 49500
    }
}
