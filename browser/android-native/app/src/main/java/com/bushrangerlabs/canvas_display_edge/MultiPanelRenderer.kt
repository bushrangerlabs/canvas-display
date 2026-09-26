package com.bushrangerlabs.canvas_display_edge

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

class MultiPanelRenderer(
    private val container: FrameLayout,
    private val onInteraction: () -> Unit,
) {
    private val panels = linkedMapOf<String, WebView>()
    private var floating: WebView? = null
    private var floatingConfig: EdgeFloatingConfig? = null
    private var generation = 0

    @SuppressLint("SetJavaScriptEnabled")
    private fun webView(): WebView = WebView(container.context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        setBackgroundColor(Color.BLACK)
        setOnTouchListener { _, _ -> onInteraction(); false }
    }

    fun render(page: EdgePage, onComplete: (Boolean, String?) -> Unit) {
        generation += 1
        val renderGeneration = generation
        destroyAll()
        floatingConfig = page.floating
        val visiblePanels = page.panels.count { it.visible }
        if (visiblePanels == 0) {
            onComplete(false, "page has no visible panels")
            return
        }
        val remaining = AtomicInteger(visiblePanels)
        val completed = AtomicBoolean(false)
        fun finish(ok: Boolean, error: String? = null) {
            if (renderGeneration != generation || !completed.compareAndSet(false, true)) return
            onComplete(ok, error)
        }
        fun panelFinished() {
            if (remaining.decrementAndGet() == 0) finish(true)
        }
        container.post {
            if (renderGeneration != generation) return@post
            val totalWidth = container.width.takeIf { it > 0 } ?: container.resources.displayMetrics.widthPixels
            val totalHeight = container.height.takeIf { it > 0 } ?: container.resources.displayMetrics.heightPixels
            page.panels.forEach { spec ->
                val view = webView()
                panels[spec.id] = view
                view.alpha = spec.opacity
                view.visibility = if (spec.visible) View.VISIBLE else View.GONE
                if (spec.visible) {
                    view.webViewClient = object : WebViewClient() {
                        private var terminal = false
                        override fun onPageFinished(view: WebView, url: String) {
                            if (terminal) return
                            terminal = true
                            panelFinished()
                        }

                        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                            if (!request.isForMainFrame || terminal) return
                            terminal = true
                            finish(false, "panel ${spec.id}: ${error.description}")
                        }
                    }
                }
                container.addView(view, layout(spec.x, spec.y, spec.width, spec.height, totalWidth, totalHeight))
                view.loadUrl(spec.url)
            }
        }
    }

    fun showFloating(url: String, fullscreen: Boolean = false): Boolean {
        if (url.isBlank()) return false
        floating?.let { container.removeView(it); it.destroy() }
        val view = webView()
        floating = view
        val config = floatingConfig
        val totalWidth = container.width.takeIf { it > 0 } ?: container.resources.displayMetrics.widthPixels
        val totalHeight = container.height.takeIf { it > 0 } ?: container.resources.displayMetrics.heightPixels
        val params = if (fullscreen) {
            layout(0.0, 0.0, 100.0, 100.0, totalWidth, totalHeight)
        } else {
            layout(config?.x ?: 10.0, config?.y ?: 10.0, config?.width ?: 80.0, config?.height ?: 80.0, totalWidth, totalHeight)
        }
        container.addView(view, params)
        view.loadUrl(url)
        return true
    }

    fun hideFloating(): Boolean {
        val view = floating ?: return false
        container.removeView(view)
        view.destroy()
        floating = null
        return true
    }

    fun controlMedia(action: String): Boolean {
        val target = floating ?: panels.values.lastOrNull() ?: return false
        val method = when (action) {
            "pause" -> "pause"
            "resume" -> "resume"
            "stop" -> "stop"
            "next" -> "next"
            else -> return false
        }
        val html5 = when (action) {
            "pause" -> "document.querySelectorAll('video,audio').forEach(function(m){m.pause()})"
            "resume" -> "document.querySelectorAll('video,audio').forEach(function(m){m.play().catch(function(){})})"
            "stop" -> "document.querySelectorAll('video,audio').forEach(function(m){m.pause();m.currentTime=0})"
            else -> ""
        }
        target.evaluateJavascript(
            "(function(){try{if(window.__canvasYouTubeControl&&window.__canvasYouTubeControl.$method){window.__canvasYouTubeControl.$method();return true;}$html5;return true}catch(e){return false}})()",
            null,
        )
        if (action == "stop") hideFloating()
        return true
    }

    fun destroyAll() {
        panels.values.forEach { container.removeView(it); it.destroy() }
        panels.clear()
        floating?.let { container.removeView(it); it.destroy() }
        floating = null
    }

    private fun layout(x: Double, y: Double, width: Double, height: Double, totalWidth: Int, totalHeight: Int) =
        FrameLayout.LayoutParams(
            (totalWidth * width / 100.0).roundToInt().coerceAtLeast(1),
            (totalHeight * height / 100.0).roundToInt().coerceAtLeast(1),
        ).apply {
            leftMargin = (totalWidth * x / 100.0).roundToInt()
            topMargin = (totalHeight * y / 100.0).roundToInt()
        }
}
