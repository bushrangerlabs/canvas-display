package com.bushrangerlabs.canvas_display_edge.dlna

import java.util.UUID

/**
 * DLNA MediaRenderer state machine.
 *
 * Owns the AVTransport / RenderingControl / ConnectionManager state and maps
 * UPnP actions onto a small playback adapter. The adapter is injected so the
 * renderer stays testable and the app can wire audio to MediaPlayer and video
 * to the WebView overlay.
 */
class DlnaRenderer(
    private val adapter: DlnaPlaybackAdapter,
    private val eventSender: ((DlnaSubscriber, String) -> Unit)? = null,
) {

    enum class TransportState(val wire: String) {
        STOPPED("STOPPED"),
        PLAYING("PLAYING"),
        PAUSED_PLAYBACK("PAUSED_PLAYBACK"),
        TRANSITIONING("TRANSITIONING"),
        NO_MEDIA_PRESENT("NO_MEDIA_PRESENT"),
    }

    /** A UPnP action error carrying the standard error code + description. */
    class UpnpError(val code: Int, val description: String) : Exception(description)

    data class State(
        val transportState: TransportState,
        val uri: String,
        val title: String,
        val artist: String?,
        val album: String?,
        val artworkUrl: String?,
        val isVideo: Boolean,
        val durationSeconds: Double,
        val positionSeconds: Double,
    )

    private var transportState = TransportState.NO_MEDIA_PRESENT
    private var currentUri = ""
    private var currentUriMetadata = ""
    private var nextUri = ""
    private var nextUriMetadata = ""
    private var metadata = DlnaXml.DidlMetadata()
    private var durationSeconds = 0.0
    private var positionSeconds = 0.0
    private var positionUpdatedAt = System.currentTimeMillis()
    private var playMode = "NORMAL"
    private var isVideo = false
    private val subscribers = mutableMapOf<String, DlnaSubscriber>()

    // ─── Introspection ────────────────────────────────────────────────────────

    @Synchronized
    fun state(): State = State(
        transportState = transportState,
        uri = currentUri,
        title = metadata.title.orEmpty(),
        artist = metadata.artist,
        album = metadata.album,
        artworkUrl = metadata.artworkUrl,
        isVideo = isVideo,
        durationSeconds = durationSeconds,
        positionSeconds = position(),
    )

    private fun position(): Double {
        if (transportState != TransportState.PLAYING) return positionSeconds
        val elapsed = (System.currentTimeMillis() - positionUpdatedAt) / 1000.0
        val value = positionSeconds + elapsed.coerceAtLeast(0.0)
        return if (durationSeconds > 0) minOf(value, durationSeconds) else value
    }

    private fun freezePosition() {
        positionSeconds = position()
        positionUpdatedAt = System.currentTimeMillis()
    }

    // ─── Action dispatch ──────────────────────────────────────────────────────

    @Synchronized
    fun handleAction(serviceType: String, action: String, args: Map<String, String>): String =
        when (serviceType) {
            DlnaDescriptions.AV_TRANSPORT_TYPE -> handleAvTransport(action, args)
            DlnaDescriptions.RENDERING_CONTROL_TYPE -> handleRenderingControl(action, args)
            DlnaDescriptions.CONNECTION_MANAGER_TYPE -> handleConnectionManager(action, args)
            else -> throw UpnpError(401, "Invalid Action")
        }

    private fun handleAvTransport(action: String, args: Map<String, String>): String = when (action) {
        "SetAVTransportURI" -> {
            setAvTransportUri(args["CurrentURI"].orEmpty(), args["CurrentURIMetaData"].orEmpty())
            ""
        }
        "SetNextAVTransportURI" -> {
            nextUri = args["NextURI"].orEmpty()
            nextUriMetadata = args["NextURIMetaData"].orEmpty()
            ""
        }
        "GetMediaInfo" ->
            "<NrTracks>${if (currentUri.isNotEmpty()) 1 else 0}</NrTracks>" +
                "<MediaDuration>${DlnaXml.formatUpnpDuration(durationSeconds)}</MediaDuration>" +
                "<CurrentURI>${DlnaXml.escape(currentUri)}</CurrentURI>" +
                "<CurrentURIMetaData>${DlnaXml.escape(currentUriMetadata)}</CurrentURIMetaData>" +
                "<NextURI>${DlnaXml.escape(nextUri)}</NextURI>" +
                "<NextURIMetaData>${DlnaXml.escape(nextUriMetadata)}</NextURIMetaData>" +
                "<PlayMedium>NETWORK</PlayMedium>" +
                "<RecordMedium>NOT_IMPLEMENTED</RecordMedium>" +
                "<WriteStatus>NOT_IMPLEMENTED</WriteStatus>"
        "GetTransportInfo" ->
            "<CurrentTransportState>${transportState.wire}</CurrentTransportState>" +
                "<CurrentTransportStatus>OK</CurrentTransportStatus>" +
                "<CurrentSpeed>1</CurrentSpeed>"
        "GetPositionInfo" -> {
            val pos = position()
            "<Track>1</Track>" +
                "<TrackDuration>${DlnaXml.formatUpnpDuration(durationSeconds)}</TrackDuration>" +
                "<TrackMetaData>${DlnaXml.escape(currentUriMetadata)}</TrackMetaData>" +
                "<TrackURI>${DlnaXml.escape(currentUri)}</TrackURI>" +
                "<RelTime>${DlnaXml.formatUpnpDuration(pos)}</RelTime>" +
                "<AbsTime>${DlnaXml.formatUpnpDuration(pos)}</AbsTime>" +
                "<RelCount>2147483647</RelCount>" +
                "<AbsCount>2147483647</AbsCount>"
        }
        "GetDeviceCapabilities" ->
            "<PlayMedia>NETWORK,NONE</PlayMedia>" +
                "<RecMedia>NOT_IMPLEMENTED</RecMedia>" +
                "<RecQualityModes>NOT_IMPLEMENTED</RecQualityModes>"
        "GetTransportSettings" -> "<PlayMode>$playMode</PlayMode><RecQualityMode>NOT_IMPLEMENTED</RecQualityMode>"
        "Stop" -> { stop(); "" }
        "Play" -> { play(); "" }
        "Pause" -> { pause(); "" }
        "Seek" -> { seek(args["Unit"] ?: "REL_TIME", args["Target"].orEmpty()); "" }
        // No queue: accept the action without changing playback.
        "Next", "Previous" -> ""
        "SetPlayMode" -> { playMode = args["NewPlayMode"]?.takeIf { it.isNotEmpty() } ?: "NORMAL"; "" }
        "GetCurrentTransportActions" -> "<Actions>${currentActions()}</Actions>"
        else -> throw UpnpError(401, "Invalid Action")
    }

    private fun currentActions(): String = when (transportState) {
        TransportState.PLAYING -> "Stop,Pause,Seek,Play"
        TransportState.PAUSED_PLAYBACK -> "Stop,Play,Seek"
        TransportState.STOPPED -> "Play,Seek"
        else -> "Play"
    }

    private fun handleRenderingControl(action: String, args: Map<String, String>): String = when (action) {
        "ListPresets" -> "<CurrentPresetNameList>FactoryDefaults</CurrentPresetNameList>"
        "SelectPreset" -> ""
        "GetVolume" -> "<CurrentVolume>${adapter.getVolume().coerceIn(0, 100)}</CurrentVolume>"
        "SetVolume" -> {
            val desired = args["DesiredVolume"]?.toDoubleOrNull() ?: throw UpnpError(402, "Invalid Args")
            adapter.setVolume(desired.coerceIn(0.0, 100.0).toInt())
            emitChange(DlnaDescriptions.RENDERING_CONTROL_TYPE)
            ""
        }
        "GetMute" -> "<CurrentMute>${if (adapter.getMuted()) 1 else 0}</CurrentMute>"
        "SetMute" -> {
            val desired = args["DesiredMute"].orEmpty().lowercase()
            adapter.setMute(desired == "1" || desired == "true" || desired == "yes")
            emitChange(DlnaDescriptions.RENDERING_CONTROL_TYPE)
            ""
        }
        else -> throw UpnpError(401, "Invalid Action")
    }

    private fun handleConnectionManager(action: String, args: Map<String, String>): String = when (action) {
        "GetProtocolInfo" -> "<Source></Source><Sink>${DlnaXml.escape(DlnaDescriptions.SINK_PROTOCOL_INFO)}</Sink>"
        "GetCurrentConnectionIDs" -> "<ConnectionIDs>0</ConnectionIDs>"
        "GetCurrentConnectionInfo" -> {
            val mime = metadata.mimeType
            "<RcsID>0</RcsID>" +
                "<AVTransportID>0</AVTransportID>" +
                "<ProtocolInfo>${DlnaXml.escape(if (mime != null) "http-get:*:$mime:*" else "")}</ProtocolInfo>" +
                "<PeerConnectionManager></PeerConnectionManager>" +
                "<PeerConnectionID>-1</PeerConnectionID>" +
                "<Direction>Input</Direction>" +
                "<Status>OK</Status>"
        }
        else -> throw UpnpError(401, "Invalid Action")
    }

    // ─── Transport operations ─────────────────────────────────────────────────

    private fun setAvTransportUri(uri: String, metadataXml: String) {
        currentUri = uri
        currentUriMetadata = metadataXml
        metadata = DlnaXml.parseDidlLite(metadataXml)
        durationSeconds = metadata.durationSeconds ?: 0.0
        positionSeconds = 0.0
        positionUpdatedAt = System.currentTimeMillis()
        isVideo = detectVideo(uri, metadata)
        transportState = if (uri.isNotEmpty()) TransportState.STOPPED else TransportState.NO_MEDIA_PRESENT
        emitChange(DlnaDescriptions.AV_TRANSPORT_TYPE)
    }

    private fun detectVideo(uri: String, metadata: DlnaXml.DidlMetadata): Boolean {
        val mime = metadata.mimeType?.lowercase().orEmpty()
        if (mime.startsWith("video/")) return true
        if (mime.startsWith("audio/")) return false
        val upnpClass = metadata.upnpClass.orEmpty()
        if (upnpClass.contains("videoItem")) return true
        if (upnpClass.contains("audioItem")) return false
        if (VIDEO_EXTENSIONS.containsMatchIn(uri)) return true
        if (AUDIO_EXTENSIONS.containsMatchIn(uri)) return false
        return false
    }

    private fun play() {
        if (currentUri.isEmpty()) throw UpnpError(701, "Transition not available")

        if (transportState == TransportState.PAUSED_PLAYBACK) {
            if (isVideo) adapter.playVideo(currentUri, metadata.title) else adapter.resumeAudio()
        } else {
            if (isVideo) adapter.playVideo(currentUri, metadata.title)
            else adapter.playAudio(currentUri, metadata.title, adapter.getVolume())
        }

        transportState = TransportState.PLAYING
        positionUpdatedAt = System.currentTimeMillis()
        emitChange(DlnaDescriptions.AV_TRANSPORT_TYPE)
    }

    private fun pause() {
        if (transportState != TransportState.PLAYING) throw UpnpError(701, "Transition not available")
        freezePosition()
        if (isVideo) adapter.stopVideo() else adapter.pauseAudio()
        transportState = TransportState.PAUSED_PLAYBACK
        emitChange(DlnaDescriptions.AV_TRANSPORT_TYPE)
    }

    private fun stop() {
        if (isVideo) adapter.stopVideo() else adapter.stopAudio()
        positionSeconds = 0.0
        positionUpdatedAt = System.currentTimeMillis()
        transportState = if (currentUri.isNotEmpty()) TransportState.STOPPED else TransportState.NO_MEDIA_PRESENT
        emitChange(DlnaDescriptions.AV_TRANSPORT_TYPE)
    }

    private fun seek(unit: String, target: String) {
        if (currentUri.isEmpty()) throw UpnpError(701, "Transition not available")
        if (unit != "REL_TIME") throw UpnpError(710, "Seek mode not supported")
        val seconds = DlnaXml.parseUpnpDuration(target) ?: throw UpnpError(711, "Illegal seek target")
        positionSeconds = seconds
        positionUpdatedAt = System.currentTimeMillis()
        if (!isVideo) adapter.seekAudio(seconds)
        emitChange(DlnaDescriptions.AV_TRANSPORT_TYPE)
    }

    // ─── GENA eventing ────────────────────────────────────────────────────────

    @Synchronized
    fun subscribe(service: String, callbackUrl: String, timeoutSeconds: Int): DlnaSubscriber {
        val subscriber = DlnaSubscriber(
            sid = "uuid:${UUID.randomUUID()}",
            service = service,
            callbackUrl = callbackUrl,
            expiresAt = System.currentTimeMillis() + maxOf(30, timeoutSeconds) * 1000L,
        )
        subscribers[subscriber.sid] = subscriber
        return subscriber
    }

    @Synchronized
    fun renew(sid: String, timeoutSeconds: Int): DlnaSubscriber? {
        val subscriber = subscribers[sid] ?: return null
        subscriber.expiresAt = System.currentTimeMillis() + maxOf(30, timeoutSeconds) * 1000L
        return subscriber
    }

    @Synchronized
    fun unsubscribe(sid: String): Boolean = subscribers.remove(sid) != null

    @Synchronized
    fun pruneSubscribers() {
        val now = System.currentTimeMillis()
        subscribers.entries.removeAll { it.value.expiresAt <= now }
    }

    /** Send the current state to a subscriber (the initial event after SUBSCRIBE). */
    fun sendInitialEvent(subscriber: DlnaSubscriber) = dispatchEvent(subscriber)

    private fun emitChange(serviceType: String) {
        pruneSubscribers()
        subscribers.values.filter { it.service == serviceType }.forEach { dispatchEvent(it) }
    }

    private fun dispatchEvent(subscriber: DlnaSubscriber) {
        val sender = eventSender ?: return
        val body = if (subscriber.service == DlnaDescriptions.RENDERING_CONTROL_TYPE) {
            renderingControlEvent()
        } else {
            avTransportEvent()
        }
        sender(subscriber, body)
    }

    private fun avTransportEvent(): String {
        val pos = position()
        val inner =
            "<TransportState val=\"${transportState.wire}\"/>" +
                "<TransportStatus val=\"OK\"/>" +
                "<CurrentPlayMode val=\"$playMode\"/>" +
                "<CurrentTrack val=\"1\"/>" +
                "<CurrentTrackDuration val=\"${DlnaXml.formatUpnpDuration(durationSeconds)}\"/>" +
                "<CurrentTrackURI val=\"${DlnaXml.escape(currentUri)}\"/>" +
                "<CurrentTrackMetaData val=\"${DlnaXml.escape(currentUriMetadata)}\"/>" +
                "<AVTransportURI val=\"${DlnaXml.escape(currentUri)}\"/>" +
                "<AVTransportURIMetaData val=\"${DlnaXml.escape(currentUriMetadata)}\"/>" +
                "<RelativeTimePosition val=\"${DlnaXml.formatUpnpDuration(pos)}\"/>" +
                "<AbsoluteTimePosition val=\"${DlnaXml.formatUpnpDuration(pos)}\"/>" +
                "<CurrentTransportActions val=\"${currentActions()}\"/>"
        return wrapLastChange("urn:schemas-upnp-org:metadata-1-0/AVT/", inner)
    }

    private fun renderingControlEvent(): String {
        val inner =
            "<Volume channel=\"Master\" val=\"${adapter.getVolume().coerceIn(0, 100)}\"/>" +
                "<Mute channel=\"Master\" val=\"${if (adapter.getMuted()) 1 else 0}\"/>"
        return wrapLastChange("urn:schemas-upnp-org:metadata-1-0/RCS/", inner)
    }

    private fun wrapLastChange(namespace: String, inner: String): String {
        val event = "<Event xmlns=\"$namespace\"><InstanceID val=\"0\">$inner</InstanceID></Event>"
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<e:propertyset xmlns:e=\"urn:schemas-upnp-org:event-1-0\">" +
            "<e:property><LastChange>${DlnaXml.escape(event)}</LastChange></e:property>" +
            "</e:propertyset>"
    }

    private companion object {
        val VIDEO_EXTENSIONS = Regex("\\.(mp4|m4v|mkv|webm|mov|avi|mpe?g|ts|m3u8|mpd|ogv)(\\?|$)", RegexOption.IGNORE_CASE)
        val AUDIO_EXTENSIONS = Regex("\\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|mp2|m3u)(\\?|$)", RegexOption.IGNORE_CASE)
    }
}

/** A GENA event subscriber. */
class DlnaSubscriber(
    val sid: String,
    val service: String,
    val callbackUrl: String,
    var expiresAt: Long,
    var seq: Int = 0,
)

/** Playback surface the renderer drives. Implemented by the Android app. */
interface DlnaPlaybackAdapter {
    fun playAudio(url: String, title: String?, volume: Int)
    fun pauseAudio()
    fun resumeAudio()
    fun stopAudio()
    fun seekAudio(seconds: Double)
    fun setVolume(level: Int)
    fun setMute(muted: Boolean)
    fun getVolume(): Int
    fun getMuted(): Boolean
    fun playVideo(url: String, title: String?)
    fun stopVideo()
}
