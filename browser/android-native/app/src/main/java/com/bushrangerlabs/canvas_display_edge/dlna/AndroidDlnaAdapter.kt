package com.bushrangerlabs.canvas_display_edge.dlna

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer

/**
 * Audio sink arbiter.
 *
 * The device has a single audio output. Several subsystems can want it at once —
 * DLNA pushes, direct/broadcast audio, the voice pipeline's TTS, and (once
 * implemented) the Snapcast client. Without arbitration they all hold audio
 * streams simultaneously and the result is overlapping audio.
 *
 * The arbiter tracks which subsystem currently owns the sink and releases the
 * previous owner before a new one starts. Releasers are injected so this object
 * has no dependency on the players themselves.
 */
object AudioSinkArbiter {

    enum class Owner { IDLE, MEDIA, SNAPCAST }

    private val releasers = mutableMapOf<Owner, () -> Unit>()

    @Volatile private var current: Owner = Owner.IDLE

    /**
     * Invoked when the sink becomes idle (the last owner released it).
     *
     * Used to resume background playback that was suspended when something else
     * took the sink — e.g. Snapcast resuming after a DLNA push finishes.
     */
    @Volatile var onIdle: (() -> Unit)? = null

    fun registerReleaser(owner: Owner, release: () -> Unit) {
        synchronized(releasers) { releasers[owner] = release }
    }

    fun currentOwner(): Owner = current

    /**
     * Take ownership of the audio sink, releasing whichever subsystem held it
     * before. Releasing the incoming owner is skipped (it is about to play).
     */
    @Synchronized
    fun acquire(owner: Owner) {
        val previous = current
        current = owner
        if (previous == owner || previous == Owner.IDLE) return
        val release = synchronized(releasers) { releasers[previous] } ?: return
        runCatching { release() }.onFailure { DlnaLog.warn("arbiter release $previous failed: ${it.message}") }
    }

    /** Release the sink, but only if [owner] still holds it. */
    @Synchronized
    fun release(owner: Owner) {
        if (current != owner) return
        current = Owner.IDLE
        // Notify outside the lock: the listener may acquire the sink again.
        val listener = onIdle
        if (listener != null) {
            runCatching { listener() }.onFailure { DlnaLog.warn("arbiter idle listener failed: ${it.message}") }
        }
    }

    /** Test helper — reset the arbiter to a clean state. */
    fun reset() {
        synchronized(releasers) { releasers.clear() }
        onIdle = null
        current = Owner.IDLE
    }
}

/**
 * [DlnaPlaybackAdapter] backed by Android's [MediaPlayer] for audio and the
 * WebView overlay for video.
 *
 * Audio and video are routed the same way as the Linux sidecar: audio plays
 * through a native player with no window, video opens the floating WebView.
 */
class AndroidDlnaAdapter(
    private val context: Context,
    private val onPlayVideo: (url: String, title: String?) -> Unit,
    private val onStopVideo: () -> Unit,
) : DlnaPlaybackAdapter {

    private var player: MediaPlayer? = null
    private var volume = 75
    private var muted = false
    private var currentUrl: String? = null

    init {
        // When Snapcast (or anything else) takes the sink, stop our playback.
        AudioSinkArbiter.registerReleaser(AudioSinkArbiter.Owner.MEDIA) { stopAudio() }
    }

    @Synchronized
    override fun playAudio(url: String, title: String?, volume: Int) {
        playAudioObserved(url, title, volume, {}, {})
    }

    /** Play a finite announcement and report actual MediaPlayer lifecycle events. */
    @Synchronized
    fun playAudioObserved(
        url: String,
        title: String?,
        volume: Int,
        onStarted: () -> Unit,
        onFinished: (Throwable?) -> Unit,
    ) {
        AudioSinkArbiter.acquire(AudioSinkArbiter.Owner.MEDIA)
        releasePlayer()
        this.volume = volume.coerceIn(0, 100)
        currentUrl = url
        runCatching {
            val created = MediaPlayer()
            created.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            created.setDataSource(url)
            created.setOnPreparedListener { mp ->
                mp.setVolume(effectiveVolume(), effectiveVolume())
                mp.start()
                onStarted()
            }
            created.setOnCompletionListener { mp ->
                if (player === mp) player = null
                mp.release()
                AudioSinkArbiter.release(AudioSinkArbiter.Owner.MEDIA)
                onFinished(null)
            }
            created.setOnErrorListener { mp, what, extra ->
                if (player === mp) player = null
                mp.release()
                AudioSinkArbiter.release(AudioSinkArbiter.Owner.MEDIA)
                onFinished(IllegalStateException("MediaPlayer error $what/$extra"))
                true
            }
            created.prepareAsync()
            player = created
        }.onFailure {
            AudioSinkArbiter.release(AudioSinkArbiter.Owner.MEDIA)
            DlnaLog.warn("dlna audio playback failed: ${it.message}")
            onFinished(it)
        }
    }

    @Synchronized
    override fun pauseAudio() {
        runCatching { player?.takeIf { it.isPlaying }?.pause() }
    }

    @Synchronized
    override fun resumeAudio() {
        runCatching { player?.takeIf { !it.isPlaying }?.start() }
    }

    @Synchronized
    override fun stopAudio() {
        releasePlayer()
        AudioSinkArbiter.release(AudioSinkArbiter.Owner.MEDIA)
    }

    @Synchronized
    override fun seekAudio(seconds: Double) {
        runCatching { player?.seekTo((seconds * 1000).toInt()) }
    }

    @Synchronized
    override fun setVolume(level: Int) {
        volume = level.coerceIn(0, 100)
        runCatching { player?.setVolume(effectiveVolume(), effectiveVolume()) }
    }

    @Synchronized
    override fun setMute(muted: Boolean) {
        this.muted = muted
        runCatching { player?.setVolume(effectiveVolume(), effectiveVolume()) }
    }

    override fun getVolume(): Int = volume

    override fun getMuted(): Boolean = muted

    override fun playVideo(url: String, title: String?) {
        AudioSinkArbiter.acquire(AudioSinkArbiter.Owner.MEDIA)
        onPlayVideo(url, title)
    }

    override fun stopVideo() {
        onStopVideo()
        AudioSinkArbiter.release(AudioSinkArbiter.Owner.MEDIA)
    }

    /** Current playback URL, or null when idle. */
    @Synchronized
    fun playingUrl(): String? = currentUrl?.takeIf { player != null }

    private fun effectiveVolume(): Float = if (muted) 0f else volume / 100f

    private fun releasePlayer() {
        val existing = player ?: return
        player = null
        currentUrl = null
        runCatching { existing.stop() }
        runCatching { existing.release() }
    }
}
