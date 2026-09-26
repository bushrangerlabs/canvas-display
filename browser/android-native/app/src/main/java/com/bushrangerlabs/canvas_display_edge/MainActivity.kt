package com.bushrangerlabs.canvas_display_edge

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
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
        val save = Button(this).apply { text = "Connect" }
        status = TextView(this).apply { setTextColor(Color.LTGRAY) }
        save.setOnClickListener {
            config.coreUrl = core.text.toString()
            config.homeAssistantUrl = ha.text.toString()
            config.homeAssistantToken = token.text.toString()
            config.invitationToken = invitation.text.toString()
            config.deviceName = name.text.toString()
            showRenderer()
        }
        root.addView(title)
        listOf(name, core, ha, token, invitation, save, status!!).forEach { root.addView(it) }
        setContentView(root)
        root.requestFocus()
    }

    private fun showRenderer() {
        val root = FrameLayout(this)
        rendererContainer = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(rendererContainer, FrameLayout.LayoutParams(-1, -1))
        renderer = MultiPanelRenderer(rendererContainer) { clearRevertTimer() }
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
        root.addView(status, statusParams)
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
                    { url -> runOnUiThread { renderer.showFloating(url, fullscreen = true) }; true },
                    { action -> controlMedia(action) },
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
                    runOnUiThread { maybeStartVoicePipeline(voiceConfig) }
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
        val page = runCatching { EdgePage.fromScene(scene, config.coreUrl) }
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

    private fun controlMedia(action: String): Boolean {
        val completed = CountDownLatch(1)
        var applied = false
        runOnUiThread {
            applied = renderer.controlMedia(action)
            completed.countDown()
        }
        return completed.await(2, TimeUnit.SECONDS) && applied
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
        if (::renderer.isInitialized) renderer.destroyAll()
        voicePipeline?.stop()
        voicePipeline = null
        discoveryFallback?.let { discoveryFallbackHandler.removeCallbacks(it) }
        discovery?.stop()
        client?.close()
        super.onDestroy()
    }
}
