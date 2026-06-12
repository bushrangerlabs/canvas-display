package app.tauri.multiwebview

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// ─── Argument data classes ────────────────────────────────────────────────────

@InvokeArg
class CreatePanelArgs {
    @JvmField var label: String = ""
    @JvmField var url: String = ""
    @JvmField var x: Int = 0
    @JvmField var y: Int = 0
    @JvmField var width: Int = 1024
    @JvmField var height: Int = 768
    @JvmField var visible: Boolean = true
    @JvmField var title: String = ""
    @JvmField var ingressSession: String? = null
    @JvmField var initScript: String? = null
}

@InvokeArg
class LabelArgs {
    @JvmField var label: String = ""
}

@InvokeArg
class NavigateArgs {
    @JvmField var label: String = ""
    @JvmField var url: String = ""
}

@InvokeArg
class BrightnessArgs {
    @JvmField var brightness: Double = 1.0
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

@TauriPlugin
class MultiWebViewPlugin(private val activity: android.app.Activity) : Plugin(activity) {

    /** Map of label → WebView for all managed panel webviews. */
    private val panels = mutableMapOf<String, WebView>()

    /**
     * Create a new WebView panel positioned absolutely on the DecorView.
     * If a panel with the same label already exists, navigates it to the new URL.
     */
    @SuppressLint("SetJavaScriptEnabled")
    @Command
    fun createPanelWebview(invoke: Invoke) {
        val args = invoke.parseArgs(CreatePanelArgs::class.java)
        activity.runOnUiThread {
            // Reuse existing panel: just navigate to new URL.
            val existing = panels[args.label]
            if (existing != null) {
                existing.loadUrl(args.url)
                invoke.resolve()
                return@runOnUiThread
            }

            val webView = WebView(activity)
            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                mediaPlaybackRequiresUserGesture = false
            }
            webView.setBackgroundColor(Color.BLACK)

            val initScript = args.initScript
            if (initScript != null &&
                WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            ) {
                WebViewCompat.addDocumentStartJavaScript(webView, initScript, setOf("*"))
            }

            webView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?, request: WebResourceRequest?
                ) = false

                override fun onPageStarted(
                    view: WebView?, url: String?, favicon: Bitmap?
                ) {
                    super.onPageStarted(view, url, favicon)
                    // Fallback injection for older WebView versions.
                    if (initScript != null &&
                        !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
                    ) {
                        view?.evaluateJavascript(initScript, null)
                    }
                }
            }

            val params = FrameLayout.LayoutParams(args.width, args.height).apply {
                leftMargin = args.x
                topMargin = args.y
            }
            webView.visibility = if (args.visible) View.VISIBLE else View.GONE

            panels[args.label] = webView
            (activity.window.decorView as ViewGroup).addView(webView, params)
            webView.loadUrl(args.url)
            invoke.resolve()
        }
    }

    /** Navigate an existing panel webview to a new URL. */
    @Command
    fun navigateWebview(invoke: Invoke) {
        val args = invoke.parseArgs(NavigateArgs::class.java)
        if (args.label.isEmpty()) { invoke.reject("label required"); return }
        if (args.url.isEmpty()) { invoke.reject("url required"); return }
        activity.runOnUiThread {
            panels[args.label]?.loadUrl(args.url)
            invoke.resolve()
        }
    }

    /** Remove and destroy a panel webview. */
    @Command
    fun closeWebview(invoke: Invoke) {
        val args = invoke.parseArgs(LabelArgs::class.java)
        if (args.label.isEmpty()) { invoke.reject("label required"); return }
        activity.runOnUiThread {
            val wv = panels.remove(args.label)
            if (wv != null) {
                (activity.window.decorView as ViewGroup).removeView(wv)
                wv.destroy()
            }
            invoke.resolve()
        }
    }

    /** Hide a panel webview (View.GONE). */
    @Command
    fun hideWebview(invoke: Invoke) {
        val args = invoke.parseArgs(LabelArgs::class.java)
        if (args.label.isEmpty()) { invoke.reject("label required"); return }
        activity.runOnUiThread {
            panels[args.label]?.visibility = View.GONE
            invoke.resolve()
        }
    }

    /** Show a hidden panel webview (View.VISIBLE). */
    @Command
    fun showWebview(invoke: Invoke) {
        val args = invoke.parseArgs(LabelArgs::class.java)
        if (args.label.isEmpty()) { invoke.reject("label required"); return }
        activity.runOnUiThread {
            panels[args.label]?.visibility = View.VISIBLE
            invoke.resolve()
        }
    }

    /** Return all known panel labels. */
    @Command
    fun getAllWebviewLabels(invoke: Invoke) {
        val arr = JSArray()
        panels.keys.forEach { arr.put(it) }
        val result = JSObject()
        result.put("labels", arr)
        invoke.resolve(result)
    }

    /** Dim screen to near-off and clear KEEP_SCREEN_ON. */
    @Command
    fun screenOff(invoke: Invoke) {
        activity.runOnUiThread {
            val lp = activity.window.attributes
            lp.screenBrightness = 0.01f
            activity.window.attributes = lp
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }

    /** Restore screen brightness and set KEEP_SCREEN_ON. */
    @Command
    fun screenOn(invoke: Invoke) {
        activity.runOnUiThread {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val lp = activity.window.attributes
            lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            activity.window.attributes = lp
            invoke.resolve()
        }
    }

    /** Set screen brightness (0.0–1.0). */
    @Command
    fun setBrightness(invoke: Invoke) {
        val args = invoke.parseArgs(BrightnessArgs::class.java)
        activity.runOnUiThread {
            val lp = activity.window.attributes
            lp.screenBrightness = args.brightness.toFloat().coerceIn(0.01f, 1.0f)
            activity.window.attributes = lp
            invoke.resolve()
        }
    }

    /** Prevent the screen from sleeping. */
    @Command
    fun keepScreenOn(invoke: Invoke) {
        activity.runOnUiThread {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            invoke.resolve()
        }
    }
}
