package com.bushrangerlabs.canvas_display_edge

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.bushrangerlabs.canvas_display_edge.dlna.AndroidDlnaAdapter
import com.bushrangerlabs.canvas_display_edge.dlna.DlnaHttpServer
import com.bushrangerlabs.canvas_display_edge.dlna.DlnaService
import com.bushrangerlabs.canvas_display_edge.snapcast.SnapcastService
import com.bushrangerlabs.canvas_display_edge.voice.VoicePipeline
import com.bushrangerlabs.canvas_display_edge.voice.VoiceConfig
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val RESTART_REQUEST_CODE = 0x0CA11
private const val RESTART_DELAY_MS = 800L

class MainActivity : AppCompatActivity() {
    private lateinit var config: EdgeConfig
    private lateinit var identity: EdgeIdentity
    private var voicePipeline: VoicePipeline? = null
    private var activeVoiceConfig: VoiceConfig? = null
    private var pendingVoiceConfig: VoiceConfig? = null
    private val recordAudioPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) pendingVoiceConfig?.let { startVoicePipeline(it) }
        else android.util.Log.w("CanvasEdge", "RECORD_AUDIO denied — voice pipeline disabled")
    }
    // SYSTEM_ALERT_WINDOW ("Display over other apps") is the BAL exemption that lets
    // KioskService raise MainActivity from the background on boot and on Core app.show.
    private val overlayPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (!Settings.canDrawOverlays(this)) {
            android.util.Log.w(
                "CanvasEdge",
                "SYSTEM_ALERT_WINDOW not granted — boot autostart and remote app.show may be blocked by BAL",
            )
        }
    }
    private var client: CoreEdgeClient? = null
    private var discovery: CoreDiscovery? = null
    private val discoveryFallbackHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var discoveryFallback: Runnable? = null
    private var status: TextView? = null
    private lateinit var rendererContainer: FrameLayout
    private lateinit var renderer: MultiPanelRenderer
    private lateinit var pageStore: EdgePageStore
    private var lastPage: EdgePage? = null
    private var directAudioPlayer: MediaPlayer? = null
    private var directAudioActive = false
    private var directAudioPaused = false
    private var directAudioVolume = 75
    private var audioOverlay: LinearLayout? = null
    private var audioOverlayTitle: TextView? = null
    private var dlnaService: DlnaService? = null
    private var dlnaAdapter: AndroidDlnaAdapter? = null
    private var snapcastService: SnapcastService? = null
    private var broadcastDeliveryClient: BroadcastDeliveryClient? = null
    private val revertHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var revertRunnable: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
        )
        window.setBackgroundDrawableResource(android.R.color.black)
        hideSystemBars()
        // Keep a foreground kiosk service alive so the process survives when the
        // activity is hidden to the background, and so Core can bring it forward.
        // Swallow failures: the display must still start even if the FGS cannot
        // (e.g. a background-start restriction), so this never crash-loops the app.
        startKioskService(null)
        ensureOverlayPermission()
        config = EdgeConfig(this)
        try {
            identity = EdgeIdentity()
            showInitialScreen()
        } catch (error: Throwable) {
            showFatalError(error)
        }
    }

    /** Requests the "Display over other apps" special access once. It is the BAL
     *  exemption that lets KioskService raise this activity from the background. */
    private fun ensureOverlayPermission() {
        if (Settings.canDrawOverlays(this)) return
        try {
            overlayPermission.launch(
                Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName"),
                ),
            )
        } catch (error: Throwable) {
            android.util.Log.w("CanvasEdge", "Overlay permission request failed: ${error.message}")
        }
    }

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun showFatalError(error: Throwable) {
        val message = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            setPadding(36, 36, 36, 36)
            text = "Canvas Edge startup failed\n\n${error.javaClass.simpleName}: ${error.message ?: "unknown error"}"
        }
        setContentView(message)
    }

    private fun showInitialScreen() {
        if (config.configured) {
            showRenderer()
        } else {
            showDiscovery()
        }
    }

    private fun showDiscovery() {
        val message = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = android.view.Gravity.CENTER
            text = "Canvas Edge Android\nDiscovering Canvas Core..."
            setBackgroundColor(Color.rgb(18, 18, 18))
        }
        setContentView(message)
        discoveryFallback?.let { discoveryFallbackHandler.removeCallbacks(it) }
        discoveryFallback = Runnable {
            if (!config.configured) {
                config.coreUrl = "https://192.168.1.108:3100"
                discovery?.stop()
                showRenderer()
            }
        }
        discoveryFallbackHandler.postDelayed(discoveryFallback!!, 3_000)
        discovery?.stop()
        discovery = CoreDiscovery(this)
        discovery?.discover(
            onFound = { coreUrl, homeAssistantUrl ->
                runOnUiThread {
                    config.coreUrl = coreUrl
                    if (!homeAssistantUrl.isNullOrBlank()) config.homeAssistantUrl = homeAssistantUrl
                    discovery?.stop()
                    discoveryFallback?.let { discoveryFallbackHandler.removeCallbacks(it) }
                    discoveryFallback = null
                    showRenderer()
                }
            },
            onError = { error -> runOnUiThread { message.text = "Canvas Edge Android\n$error\n\nWaiting for Core..." } },
        )
    }

    private fun showSetup() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 36, 48, 36)
            setBackgroundColor(Color.rgb(18, 18, 18))
        }
        fun field(hint: String, value: String): EditText = EditText(this).apply {
            this.hint = hint
            setText(value)
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
        }
        val title = TextView(this).apply { text = "Canvas Edge Android"; textSize = 24f; setTextColor(Color.WHITE) }
        val core = field("Core URL", config.coreUrl)
        val ha = field("Home Assistant URL", config.homeAssistantUrl)
        val token = field("Home Assistant token", config.homeAssistantToken)
        val invitation = field("Pairing invitation token", config.invitationToken)
        val name = field("Device name", config.deviceName)
        val snapcastHost = field("Snapcast server (blank = Core host)", config.snapcastHost)
        val snapcastPort = field("Snapcast port", config.snapcastPort.toString())
        val snapcastEnabled = android.widget.CheckBox(this).apply {
            text = "Join Snapcast (multi-room audio)"
            setTextColor(Color.WHITE)
            isChecked = config.snapcastEnabled
        }
        val save = Button(this).apply { text = "Connect" }
        status = TextView(this).apply { setTextColor(Color.LTGRAY) }
        save.setOnClickListener {
            config.coreUrl = core.text.toString()
            config.homeAssistantUrl = ha.text.toString()
            config.homeAssistantToken = token.text.toString()
            config.invitationToken = invitation.text.toString()
            config.deviceName = name.text.toString()
            config.snapcastHost = snapcastHost.text.toString()
            snapcastPort.text.toString().toIntOrNull()?.let { config.snapcastPort = it }
            config.snapcastEnabled = snapcastEnabled.isChecked
            showRenderer()
        }
        root.addView(title)
        listOf(name, core, ha, token, invitation, snapcastEnabled, snapcastHost, snapcastPort, save, status!!)
            .forEach { root.addView(it) }
        setContentView(root)
        root.requestFocus()
    }

    private fun showRenderer() {
        val root = FrameLayout(this)
        rendererContainer = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(rendererContainer, FrameLayout.LayoutParams(-1, -1))
        renderer = MultiPanelRenderer(rendererContainer) { clearRevertTimer() }
        startDlnaRenderer()
        pageStore = EdgePageStore(this)
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = android.view.Gravity.CENTER
            setPadding(28, 20, 28, 20)
            setBackgroundColor(Color.argb(210, 20, 20, 20))
            text = "Canvas Edge Android\nConnecting to Core..."
        }
        val statusParams = FrameLayout.LayoutParams(-2, -2)
        statusParams.gravity = android.view.Gravity.CENTER
        // Long-press the status overlay to reach the settings screen. It is the
        // only on-device entry point (the kiosk has no chrome), and it is
        // available while the display is connecting or showing an error.
        status?.setOnLongClickListener {
            showSetup()
            true
        }
        root.addView(status, statusParams)
        createAudioOverlay(root)
        setContentView(root)
        root.requestFocus()
        pageStore.load(config.coreUrl)?.let { cached ->
            lastPage = cached
            renderer.render(cached) { rendered, error ->
                runOnUiThread {
                    if (rendered) status?.visibility = View.GONE
                    else statusText("offline page failed: ${error ?: "unknown error"}")
                }
            }
        }
        client?.close()
        Thread {
            val credential = EnrollmentClient(this, config, identity).enrollIfNeeded()
            runOnUiThread {
                credential.onFailure { error -> statusText("enrollment error: ${error.message}") }
                client = CoreEdgeClient(
                    this,
                    config,
                    identity,
                    credential.getOrNull(),
                    { scene, complete -> renderScene(scene, complete) },
                    { text -> runOnUiThread { statusText(text) }; if (text == "online") refreshVoiceConfigAndMaybeStart() },
                    { refreshVoiceConfigAndMaybeStart() },
                    { url, source, title ->
                        if (source == "direct_audio") {
                            runOnUiThread { playDirectAudio(url, title) }
                            true
                        } else {
                            runOnUiThread { renderer.showFloating(url, fullscreen = true) }
                            true
                        }
                    },
                    { action, value -> controlMedia(action, value) },
                    { url, ms -> runOnUiThread { openSearchPage(url, ms) } },
                    { control -> runOnUiThread {
                        when (control) {
                            "app.hide" -> hideApp()
                            "app.show" -> showApp()
                            else -> restartApp()
                        }
                    } },
                )
                client?.connect()
            }
        }.start()
        refreshVoiceConfigAndMaybeStart()
    }

    /**
     * Expose this device as a UPnP/DLNA MediaRenderer so Home Assistant
     * (`dlna_dmr`) and Music Assistant can push audio and video to it.
     *
     * Audio plays through a native [MediaPlayer] (no window); video opens the
     * floating WebView with the renderer's own `/video` wrapper page.
     */
    private fun startDlnaRenderer() {
        if (dlnaService != null) return
        val adapter = AndroidDlnaAdapter(
            context = this,
            onPlayVideo = { url, title ->
                runOnUiThread {
                    val base = dlnaService?.baseUrl.orEmpty()
                    val target = if (base.isNotEmpty()) DlnaHttpServer.videoWrapperUrl(base, url, title) else url
                    renderer.showFloating(target, fullscreen = false)
                }
            },
            onStopVideo = { runOnUiThread { renderer.hideFloating() } },
        )
        dlnaAdapter = adapter
        val service = DlnaService(
            context = this,
            adapter = adapter,
            friendlyName = config.deviceName,
            modelNumber = "0.3.1",
        )
        dlnaService = service
        // Binding the SSDP socket can block briefly; keep it off the UI thread.
        Thread { service.start() }.start()
        startBroadcastDeliveries()
        startSnapcastClient()
    }

    private fun startBroadcastDeliveries() {
        if (broadcastDeliveryClient != null || config.edgeVoiceToken.isBlank()) return
        val adapter = dlnaAdapter ?: return
        broadcastDeliveryClient = BroadcastDeliveryClient(this, config, identity.installationId, adapter) { alert, complete ->
            runOnUiThread {
                try {
                    val title = alert.optString("title", "Alert")
                    val message = alert.optString("message", "")
                    status?.text = "$title\n$message"
                    status?.visibility = View.VISIBLE
                    val duration = alert.optLong("duration", 15).coerceAtLeast(1) * 1_000
                    status?.postDelayed({ status?.visibility = View.GONE; complete(null) }, duration)
                } catch (error: Throwable) {
                    complete(error)
                }
            }
        }.also { it.start() }
    }

    /**
     * Join the Snapcast server bundled with Music Assistant for multi-room
     * synchronised audio. The host defaults to the Core host (MA runs there).
     * The audio arbiter stops this client whenever local playback takes the sink.
     */
    private fun startSnapcastClient() {
        if (!config.snapcastEnabled) return
        if (snapcastService != null) return
        val host = config.resolvedSnapcastHost ?: return
        val service = SnapcastService(
            host = host,
            port = config.snapcastPort,
            clientId = identity.installationId,
            clientName = config.deviceName,
        )
        snapcastService = service
        Thread { service.start() }.start()
    }

    /**
     * Apply the Core-authoritative Snapcast settings and restart the client when
     * they change. Core is the source of truth (admin UI → `PUT /api/admin/devices/:id/audio`),
     * so the on-device fields are only a fallback for an unconfigured device.
     */
    private fun applySnapcastConfig(voiceConfig: VoiceConfig) {
        val changed = config.snapcastEnabled != voiceConfig.snapcastEnabled ||
            config.snapcastHost != voiceConfig.snapcastHost ||
            config.snapcastPort != voiceConfig.snapcastPort
        config.snapcastEnabled = voiceConfig.snapcastEnabled
        config.snapcastHost = voiceConfig.snapcastHost
        config.snapcastPort = voiceConfig.snapcastPort
        if (!changed) return
        android.util.Log.i("CanvasEdge", "Snapcast config from Core changed; restarting client")
        snapcastService?.stop()
        snapcastService = null
        if (config.snapcastEnabled) startSnapcastClient()
    }

    /** Fetches this device's voice settings from Core (admin-configured, never set
     * locally) and starts/stops the on-device wake-word pipeline to match. Called on
     * startup and again on every gateway reconnect so admin changes take effect without
     * an app restart. */
    private fun refreshVoiceConfigAndMaybeStart() {
        if (!config.configured) return
        Thread {
            runCatching { com.bushrangerlabs.canvas_display_edge.voice.VoiceConfigClient(this, config.coreUrl).fetch(identity.installationId) }
                .onSuccess { voiceConfig ->
                    config.voiceEnabled = voiceConfig.wakeEnabled
                    config.wakeWord = voiceConfig.wakeWord
                    config.wakeThreshold = voiceConfig.wakeThreshold
                    voiceConfig.edgeVoiceToken?.let { config.edgeVoiceToken = it }
                    runOnUiThread {
                        startBroadcastDeliveries()
                        applySnapcastConfig(voiceConfig)
                        maybeStartVoicePipeline(voiceConfig)
                    }
                }
                .onFailure { android.util.Log.w("CanvasVoice", "voice-config fetch failed: ${it.message}") }
        }.start()
    }

    /** Requests RECORD_AUDIO (if needed) and starts the on-device wake-word pipeline —
     * no-op unless voice is enabled and configured (settings come from Core, see
     * refreshVoiceConfigAndMaybeStart). */
    private fun maybeStartVoicePipeline(voiceConfig: com.bushrangerlabs.canvas_display_edge.voice.VoiceConfig? = null) {
        if (!config.voiceEnabled || config.edgeVoiceToken.isBlank() || !config.configured) {
            voicePipeline?.stop()
            voicePipeline = null
            activeVoiceConfig = null
            pendingVoiceConfig = null
            return
        }
        val resolvedConfig = (voiceConfig ?: pendingVoiceConfig) ?: return
        val effectiveConfig = resolvedConfig.copy(edgeVoiceToken = config.edgeVoiceToken)
        pendingVoiceConfig = effectiveConfig
        if (voicePipeline != null && activeVoiceConfig == effectiveConfig) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startVoicePipeline(effectiveConfig)
        } else {
            recordAudioPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startVoicePipeline(voiceConfig: VoiceConfig) {
        if (voicePipeline != null && activeVoiceConfig == voiceConfig) return
        voicePipeline?.stop()
        voicePipeline = VoicePipeline(
            context = this,
            coreUrl = config.coreUrl,
            edgeVoiceToken = config.edgeVoiceToken,
            deviceId = identity.installationId,
            wakeWordModelAsset = "openwakeword/${config.wakeWord}.tflite",
            wakeThreshold = config.wakeThreshold,
            wakeAckEnabled = voiceConfig.wakeAckEnabled,
            wakeAckSound = voiceConfig.wakeAckSound,
            goodIntentEnabled = voiceConfig.goodIntentEnabled,
            goodIntentSound = voiceConfig.goodIntentSound,
            noIntentEnabled = voiceConfig.noIntentEnabled,
            noIntentSound = voiceConfig.noIntentSound,
            onStatus = { text -> android.util.Log.i("CanvasVoice", text) },
        )
        runCatching { voicePipeline?.start() }
            .onSuccess { activeVoiceConfig = voiceConfig }
            .onFailure {
                voicePipeline = null
                activeVoiceConfig = null
                android.util.Log.e("CanvasVoice", "Failed to start voice pipeline", it)
            }
    }

    private fun renderScene(scene: org.json.JSONObject, complete: (Boolean, String?) -> Unit) {
        val page = runCatching { EdgePage.fromScene(scene, config.coreUrl, identity.installationId) }
            .getOrElse { error ->
                runOnUiThread { statusText("page rejected: ${error.message}") }
                complete(false, error.message)
                return
            }
        clearRevertTimer()
        runOnUiThread {
            renderer.render(page) { rendered, error ->
                if (rendered) {
                    lastPage = page
                    pageStore.save(page)
                    status?.visibility = View.GONE
                } else {
                    statusText("page failed: ${error ?: "unknown error"}")
                }
                complete(rendered, error)
            }
        }
    }

    /** Return the display to its assigned scene (e.g. closing an open media player). */
    private fun reloadScene() {
        lastPage?.let { page ->
            renderer.render(page) { rendered, error ->
                if (!rendered) statusText("page reload failed: ${error ?: "unknown error"}")
            }
        }
    }

    /** Open a transient page (e.g. Wikipedia / SearXNG search) and auto-revert to the
     *  home scene after [revertAfterMs] unless the screen is interacted with. */
    private fun openSearchPage(url: String, revertAfterMs: Long) {
        renderer.showFloating(rendererUrl(url), fullscreen = true)
        clearRevertTimer()
        if (revertAfterMs > 0) {
            val r = Runnable { renderer.hideFloating() }
            revertRunnable = r
            revertHandler.postDelayed(r, revertAfterMs)
        }
    }

    private fun clearRevertTimer() {
        revertRunnable?.let { revertHandler.removeCallbacks(it) }
        revertRunnable = null
    }

    private fun controlMedia(action: String, value: Double? = null): Boolean {
        val completed = CountDownLatch(1)
        var applied = false
        runOnUiThread {
            applied = if (directAudioActive) controlDirectAudio(action, value) else renderer.controlMedia(action, value)
            completed.countDown()
        }
        return completed.await(2, TimeUnit.SECONDS) && applied
    }

    /** Play a direct audio URL (e.g. a Core broadcast clip) through the device speaker.
     *  Unlike YouTube/WebView media, this uses a native [MediaPlayer] so a recorded
     *  announcement plays without opening a window. Routed through the DLNA adapter so
     *  it shares one audio sink with DLNA pushes (see [AudioSinkArbiter]). */
    private fun playDirectAudio(url: String, title: String = url) {
        directAudioActive = true
        directAudioPaused = false
        showAudioOverlay(title)
        val adapter = dlnaAdapter
        if (adapter != null) {
            adapter.playAudio(url, title, directAudioVolume)
            return
        }
        try {
            directAudioPlayer?.release()
        } catch (_: Throwable) {
            // Ignore a player that is already torn down.
        }
        directAudioPlayer = null
        try {
            val player = MediaPlayer()
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource(url)
            player.setOnPreparedListener { it.start() }
            player.setOnCompletionListener {
                it.release()
                if (directAudioPlayer === it) directAudioPlayer = null
            }
            player.setOnErrorListener { mp, _, _ ->
                mp.release()
                if (directAudioPlayer === mp) directAudioPlayer = null
                true
            }
            player.prepareAsync()
            directAudioPlayer = player
        } catch (error: Throwable) {
            android.util.Log.w("CanvasEdge", "direct audio playback failed: ${error.message}")
        }
    }

    private fun controlDirectAudio(action: String, value: Double?): Boolean {
        val adapter = dlnaAdapter
        when (action) {
            "pause" -> { adapter?.pauseAudio() ?: runCatching { directAudioPlayer?.pause() }; directAudioPaused = true }
            "resume" -> { adapter?.resumeAudio() ?: runCatching { directAudioPlayer?.start() }; directAudioPaused = false }
            "stop" -> {
                adapter?.stopAudio() ?: runCatching { directAudioPlayer?.stop(); directAudioPlayer?.release(); directAudioPlayer = null }
                directAudioActive = false
                directAudioPaused = false
                hideAudioOverlay()
            }
            "volume" -> {
                directAudioVolume = (value ?: directAudioVolume.toDouble()).toInt().coerceIn(0, 100)
                adapter?.setVolume(directAudioVolume) ?: directAudioPlayer?.setVolume(directAudioVolume / 100f, directAudioVolume / 100f)
            }
            "mute" -> adapter?.setMute((value ?: 1.0) != 0.0) ?: directAudioPlayer?.setVolume(0f, 0f)
            else -> return false
        }
        return true
    }

    private fun createAudioOverlay(root: FrameLayout) {
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(22, 14, 22, 14)
            setBackgroundColor(Color.argb(235, 18, 22, 31))
            visibility = View.GONE
        }
        val title = TextView(this).apply { setTextColor(Color.WHITE); textSize = 16f; maxLines = 2 }
        panel.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { action() } }
        panel.addView(button("−") { controlDirectAudio("volume", (directAudioVolume - 10).toDouble()) })
        panel.addView(button("▶/Ⅱ") { controlDirectAudio(if (directAudioPaused) "resume" else "pause", null) })
        panel.addView(button("+") { controlDirectAudio("volume", (directAudioVolume + 10).toDouble()) })
        panel.addView(button("■") { controlDirectAudio("stop", null) })
        val params = FrameLayout.LayoutParams(-1, -2).apply { gravity = android.view.Gravity.BOTTOM }
        root.addView(panel, params)
        audioOverlay = panel
        audioOverlayTitle = title
        // The bar is a bottom-gravity sibling of the renderer, so it would otherwise
        // overlap the scene. Re-inset the renderer whenever the bar's height changes
        // (e.g. a two-line title) so the scene always reflows above it.
        panel.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateRendererInsets() }
    }

    /** Keep the scene clear of the bottom audio bar by insetting the renderer container
     *  to the overlay's height while it is visible, and restoring it when hidden. */
    private fun updateRendererInsets() {
        val container = rendererContainer
        val overlay = audioOverlay
        val bottom = if (overlay != null && overlay.visibility == View.VISIBLE) overlay.height else 0
        val lp = container.layoutParams as? FrameLayout.LayoutParams ?: return
        if (lp.bottomMargin == bottom) return
        lp.bottomMargin = bottom
        container.layoutParams = lp
    }

    private fun showAudioOverlay(title: String) {
        audioOverlayTitle?.text = title
        audioOverlay?.visibility = View.VISIBLE
        audioOverlay?.bringToFront()
        updateRendererInsets()
    }

    private fun hideAudioOverlay() {
        audioOverlay?.visibility = View.GONE
        updateRendererInsets()
    }

    /** Remotely requested by Core (action=hide) — send the task to the background,
     *  revealing the Android home screen. The process (and its Core WebSocket) stay
     *  alive so Core can bring it back with `app.show` for instant resume. */
    private fun hideApp() {
        android.util.Log.i("CanvasEdge", "Remote app.hide requested by Core")
        moveTaskToBack(true)
    }

    /** Remotely requested by Core (action=show) — bring the activity back to the
     *  foreground via the running foreground KioskService (which is exempt from the
     *  background-activity-launch restrictions). The renderer content is preserved,
     *  so no re-render is needed for fast resume. */
    private fun showApp() {
        android.util.Log.i("CanvasEdge", "Remote app.show requested by Core")
        startKioskService(KioskService.ACTION_SHOW)
    }

    /** Best-effort foreground-service bootstrap. Never throws — a FGS failure must
     *  not take down the kiosk itself. */
    private fun startKioskService(action: String?) {
        try {
            startForegroundService(
                Intent(this, KioskService::class.java).apply { action?.let { setAction(it) } },
            )
        } catch (error: Throwable) {
            android.util.Log.w("CanvasEdge", "Failed to start KioskService: ${error.message}")
        }
    }

    /** Remotely requested by Core (action=restart) — schedule a clean relaunch of
     *  MainActivity in a fresh process, then tear the current process down. Starting a
     *  new Activity and then killing the process would also kill the new Activity
     *  (they share a process), so the relaunch is handed to AlarmManager, which
     *  survives this process exiting and fires the launch into a new process. */
    private fun restartApp() {
        android.util.Log.i("CanvasEdge", "Remote app.restart requested by Core")
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        val pending = PendingIntent.getActivity(
            this,
            RESTART_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
        )
        (getSystemService(Context.ALARM_SERVICE) as AlarmManager).setAndAllowWhileIdle(
            AlarmManager.RTC,
            System.currentTimeMillis() + RESTART_DELAY_MS,
            pending,
        )
        client?.close()
        finishAndRemoveTask()
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    private fun rendererUrl(url: String): String = url

    private fun statusText(text: String) {
        val statusView = status
        if (statusView != null && statusView.parent != null) {
            statusView.text = "Core: $text"
        }
        android.util.Log.i("CanvasEdge", "Core: $text")
    }

    override fun onDestroy() {
        broadcastDeliveryClient?.stop()
        broadcastDeliveryClient = null
        snapcastService?.stop()
        snapcastService = null
        dlnaService?.stop()
        dlnaService = null
        dlnaAdapter = null
        if (::renderer.isInitialized) renderer.destroyAll()
        voicePipeline?.stop()
        voicePipeline = null
        discoveryFallback?.let { discoveryFallbackHandler.removeCallbacks(it) }
        discovery?.stop()
        client?.close()
        super.onDestroy()
    }
}
