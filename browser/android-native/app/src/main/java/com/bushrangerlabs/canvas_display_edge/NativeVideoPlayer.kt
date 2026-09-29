package com.bushrangerlabs.canvas_display_edge

import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.Button
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter

/** Full-screen native IPTV/video player kept alive for fast channel changes. */
class NativeVideoPlayer(
    private val container: FrameLayout,
    private val onUserExit: () -> Unit = {},
) {
    private val player = ExoPlayer.Builder(container.context).build()
    private val playerView = PlayerView(container.context).apply {
        setBackgroundColor(Color.BLACK)
        useController = true
        this.player = this@NativeVideoPlayer.player
        visibility = View.GONE
    }
    private val message = TextView(container.context).apply {
        setTextColor(Color.WHITE)
        textSize = 18f
        gravity = Gravity.CENTER
        setBackgroundColor(Color.argb(150, 0, 0, 0))
        visibility = View.GONE
    }
    private val exitButton = Button(container.context).apply {
        text = "✕  Exit"
        textSize = 18f
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.argb(190, 20, 20, 20))
        setPadding(28, 14, 28, 14)
        visibility = View.GONE
        setOnClickListener {
            stop()
            onUserExit()
        }
    }
    var active: Boolean = false
        private set
    private var currentItem: MediaItem? = null
    private var consecutiveOpenFailures = 0

    init {
        container.addView(playerView, FrameLayout.LayoutParams(-1, -1))
        container.addView(message, FrameLayout.LayoutParams(-1, -2).apply { gravity = Gravity.TOP })
        container.addView(exitButton, FrameLayout.LayoutParams(-2, -2).apply {
            gravity = Gravity.TOP or Gravity.END
            setMargins(0, 20, 20, 0)
        })
        AudioSinkArbiter.registerReleaser(AudioSinkArbiter.Owner.VIDEO) { stop() }
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                android.util.Log.d("CanvasVideo", "playback state=$state active=$active")
                when (state) {
                    Player.STATE_BUFFERING -> {
                        showMessage("Buffering…")
                        container.postDelayed({
                            if (active && player.playbackState == Player.STATE_BUFFERING && consecutiveOpenFailures < 2) {
                                consecutiveOpenFailures += 1
                                returnToLive()
                            }
                        }, 8_000)
                    }
                    Player.STATE_READY -> {
                        consecutiveOpenFailures = 0
                        message.visibility = View.GONE
                    }
                    Player.STATE_ENDED -> stop()
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                android.util.Log.w("CanvasVideo", "playback failed: ${error.errorCodeName}: ${error.message}")
                if (active && error.errorCode == PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE) {
                    // Dispatcharr exposes a rolling live fMP4 window. After a
                    // pause its old byte position can expire; resume at live.
                    currentItem?.let {
                        showMessage("Returning to live…")
                        player.setMediaItem(it)
                        player.prepare()
                        player.playWhenReady = true
                        return
                    }
                }
                if (active &&
                    error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED &&
                    consecutiveOpenFailures < 2
                ) {
                    // A live fMP4 connection can begin between fragments while
                    // Dispatcharr is rolling the stream. Reopen at the next
                    // live boundary instead of leaving a black error screen.
                    consecutiveOpenFailures += 1
                    showMessage("Waiting for live video…")
                    container.postDelayed({ if (active) returnToLive() }, 500)
                    return
                }
                showMessage("Video playback failed\n${error.errorCodeName}")
            }
        })
    }

    fun play(url: String, title: String) {
        AudioSinkArbiter.acquire(AudioSinkArbiter.Owner.VIDEO)
        active = true
        playerView.visibility = View.VISIBLE
        playerView.bringToFront()
        message.bringToFront()
        exitButton.visibility = View.VISIBLE
        exitButton.bringToFront()
        showMessage(if (title.isBlank()) "Buffering…" else "$title\nBuffering…")
        currentItem = MediaItem.fromUri(url)
        consecutiveOpenFailures = 0
        player.setMediaItem(currentItem!!)
        player.prepare()
        player.playWhenReady = true
    }

    fun control(action: String, value: Double?): Boolean {
        if (!active) return false
        when (action) {
            "pause" -> {
                player.pause()
                // A live Dispatcharr response has no useful seekable history.
                // Stop loading it so Core can close the upstream immediately;
                // resume opens the current live edge again.
                player.stop()
            }
            "resume" -> returnToLive()
            "stop" -> stop()
            "volume" -> player.volume = ((value ?: 100.0) / 100.0).toFloat().coerceIn(0f, 1f)
            "mute" -> player.volume = if ((value ?: 1.0) != 0.0) 0f else 1f
            else -> return false
        }
        return true
    }

    fun stop() {
        if (!active) return
        active = false
        player.stop()
        player.clearMediaItems()
        currentItem = null
        consecutiveOpenFailures = 0
        playerView.visibility = View.GONE
        message.visibility = View.GONE
        exitButton.visibility = View.GONE
        AudioSinkArbiter.release(AudioSinkArbiter.Owner.VIDEO)
    }

    fun release() {
        stop()
        player.release()
        container.removeView(playerView)
        container.removeView(message)
        container.removeView(exitButton)
    }

    private fun showMessage(text: String) {
        message.text = text
        message.visibility = View.VISIBLE
    }

    private fun returnToLive() {
        currentItem?.let {
            showMessage("Returning to live…")
            player.setMediaItem(it)
            player.prepare()
            player.playWhenReady = true
        }
    }
}
