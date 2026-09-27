package com.bushrangerlabs.canvas_display_edge.dlna

/**
 * UPnP device + service descriptions for the Canvas Edge DLNA renderer.
 *
 * Home Assistant's `dlna_dmr` integration discovers a renderer over SSDP and
 * then fetches this device description. It must advertise the three standard
 * MediaRenderer services with their SCPDs, otherwise HA refuses the device.
 */
object DlnaDescriptions {

    const val AV_TRANSPORT_TYPE = "urn:schemas-upnp-org:service:AVTransport:1"
    const val RENDERING_CONTROL_TYPE = "urn:schemas-upnp-org:service:RenderingControl:1"
    const val CONNECTION_MANAGER_TYPE = "urn:schemas-upnp-org:service:ConnectionManager:1"

    const val AV_TRANSPORT_ID = "urn:upnp-org:serviceId:AVTransport"
    const val RENDERING_CONTROL_ID = "urn:upnp-org:serviceId:RenderingControl"
    const val CONNECTION_MANAGER_ID = "urn:upnp-org:serviceId:ConnectionManager"

    const val MEDIA_RENDERER_TYPE = "urn:schemas-upnp-org:device:MediaRenderer:1"

    data class Config(
        val uuid: String,
        val friendlyName: String,
        val manufacturer: String,
        val modelName: String,
        val modelNumber: String,
    )

    private data class Service(
        val serviceType: String,
        val serviceId: String,
        val scpdPath: String,
        val controlPath: String,
        val eventPath: String,
    )

    private val SERVICES = listOf(
        Service(AV_TRANSPORT_TYPE, AV_TRANSPORT_ID, "/service/AVTransport.xml", "/control/AVTransport", "/event/AVTransport"),
        Service(RENDERING_CONTROL_TYPE, RENDERING_CONTROL_ID, "/service/RenderingControl.xml", "/control/RenderingControl", "/event/RenderingControl"),
        Service(CONNECTION_MANAGER_TYPE, CONNECTION_MANAGER_ID, "/service/ConnectionManager.xml", "/control/ConnectionManager", "/event/ConnectionManager"),
    )

    /** Build the root device description served at `/description.xml`. */
    fun deviceDescription(cfg: Config): String {
        val services = SERVICES.joinToString("") { service ->
            "<service>" +
                "<serviceType>${service.serviceType}</serviceType>" +
                "<serviceId>${service.serviceId}</serviceId>" +
                "<SCPDURL>${service.scpdPath}</SCPDURL>" +
                "<controlURL>${service.controlPath}</controlURL>" +
                "<eventSubURL>${service.eventPath}</eventSubURL>" +
                "</service>"
        }
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<root xmlns=\"urn:schemas-upnp-org:device-1-0\">" +
            "<specVersion><major>1</major><minor>0</minor></specVersion>" +
            "<device>" +
            "<deviceType>$MEDIA_RENDERER_TYPE</deviceType>" +
            "<friendlyName>${DlnaXml.escape(cfg.friendlyName)}</friendlyName>" +
            "<manufacturer>${DlnaXml.escape(cfg.manufacturer)}</manufacturer>" +
            "<manufacturerURL>https://github.com/canvas-display</manufacturerURL>" +
            "<modelDescription>Canvas Display DLNA media renderer</modelDescription>" +
            "<modelName>${DlnaXml.escape(cfg.modelName)}</modelName>" +
            "<modelNumber>${DlnaXml.escape(cfg.modelNumber)}</modelNumber>" +
            "<UDN>uuid:${DlnaXml.escape(cfg.uuid)}</UDN>" +
            "<dlna:X_DLNADOC xmlns:dlna=\"urn:schemas-dlna-org:device-1-0\">DMR-1.50</dlna:X_DLNADOC>" +
            "<serviceList>$services</serviceList>" +
            "</device>" +
            "</root>"
    }

    /** Return the SCPD document for a service path, or null when unknown. */
    fun serviceDescription(path: String): String? = when (path) {
        "/service/AVTransport.xml" -> avTransportScpd()
        "/service/RenderingControl.xml" -> renderingControlScpd()
        "/service/ConnectionManager.xml" -> connectionManagerScpd()
        else -> null
    }

    // ─── SCPD builders ────────────────────────────────────────────────────────

    private data class Arg(val name: String, val direction: String, val stateVariable: String)
    private data class Action(val name: String, val args: List<Arg> = emptyList())
    private data class Variable(
        val name: String,
        val dataType: String,
        val sendEvents: Boolean = false,
        val allowedValues: List<String>? = null,
        val defaultValue: String? = null,
    )

    private fun buildScpd(actions: List<Action>, variables: List<Variable>): String {
        val actionXml = actions.joinToString("") { action ->
            if (action.args.isEmpty()) {
                "<action><name>${action.name}</name></action>"
            } else {
                val args = action.args.joinToString("") {
                    "<argument><name>${it.name}</name><direction>${it.direction}</direction>" +
                        "<relatedStateVariable>${it.stateVariable}</relatedStateVariable></argument>"
                }
                "<action><name>${action.name}</name><argumentList>$args</argumentList></action>"
            }
        }
        val variableXml = variables.joinToString("") { variable ->
            val allowed = variable.allowedValues?.let { values ->
                "<allowedValueList>" + values.joinToString("") { "<allowedValue>${DlnaXml.escape(it)}</allowedValue>" } + "</allowedValueList>"
            } ?: ""
            val default = variable.defaultValue?.let { "<defaultValue>${DlnaXml.escape(it)}</defaultValue>" } ?: ""
            "<stateVariable sendEvents=\"${if (variable.sendEvents) "yes" else "no"}\">" +
                "<name>${variable.name}</name>" +
                "<dataType>${variable.dataType}</dataType>" +
                default + allowed +
                "</stateVariable>"
        }
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<scpd xmlns=\"urn:schemas-upnp-org:service-1-0\">" +
            "<specVersion><major>1</major><minor>0</minor></specVersion>" +
            "<actionList>$actionXml</actionList>" +
            "<serviceStateTable>$variableXml</serviceStateTable>" +
            "</scpd>"
    }

    private fun avTransportScpd(): String {
        val instance = Arg("InstanceID", "in", "A_ARG_TYPE_InstanceID")
        val actions = listOf(
            Action("SetAVTransportURI", listOf(instance, Arg("CurrentURI", "in", "AVTransportURI"), Arg("CurrentURIMetaData", "in", "AVTransportURIMetaData"))),
            Action("SetNextAVTransportURI", listOf(instance, Arg("NextURI", "in", "NextAVTransportURI"), Arg("NextURIMetaData", "in", "NextAVTransportURIMetaData"))),
            Action(
                "GetMediaInfo",
                listOf(
                    instance,
                    Arg("NrTracks", "out", "NumberOfTracks"),
                    Arg("MediaDuration", "out", "CurrentMediaDuration"),
                    Arg("CurrentURI", "out", "AVTransportURI"),
                    Arg("CurrentURIMetaData", "out", "AVTransportURIMetaData"),
                    Arg("NextURI", "out", "NextAVTransportURI"),
                    Arg("NextURIMetaData", "out", "NextAVTransportURIMetaData"),
                    Arg("PlayMedium", "out", "PlaybackStorageMedium"),
                    Arg("RecordMedium", "out", "RecordStorageMedium"),
                    Arg("WriteStatus", "out", "RecordMediumWriteStatus"),
                ),
            ),
            Action(
                "GetTransportInfo",
                listOf(instance, Arg("CurrentTransportState", "out", "TransportState"), Arg("CurrentTransportStatus", "out", "TransportStatus"), Arg("CurrentSpeed", "out", "TransportPlaySpeed")),
            ),
            Action(
                "GetPositionInfo",
                listOf(
                    instance,
                    Arg("Track", "out", "CurrentTrack"),
                    Arg("TrackDuration", "out", "CurrentTrackDuration"),
                    Arg("TrackMetaData", "out", "CurrentTrackMetaData"),
                    Arg("TrackURI", "out", "CurrentTrackURI"),
                    Arg("RelTime", "out", "RelativeTimePosition"),
                    Arg("AbsTime", "out", "AbsoluteTimePosition"),
                    Arg("RelCount", "out", "RelativeCounterPosition"),
                    Arg("AbsCount", "out", "AbsoluteCounterPosition"),
                ),
            ),
            Action(
                "GetDeviceCapabilities",
                listOf(instance, Arg("PlayMedia", "out", "PossiblePlaybackStorageMedia"), Arg("RecMedia", "out", "PossibleRecordStorageMedia"), Arg("RecQualityModes", "out", "PossibleRecordQualityModes")),
            ),
            Action("GetTransportSettings", listOf(instance, Arg("PlayMode", "out", "CurrentPlayMode"), Arg("RecQualityMode", "out", "CurrentRecordQualityMode"))),
            Action("Stop", listOf(instance)),
            Action("Play", listOf(instance, Arg("Speed", "in", "TransportPlaySpeed"))),
            Action("Pause", listOf(instance)),
            Action("Seek", listOf(instance, Arg("Unit", "in", "A_ARG_TYPE_SeekMode"), Arg("Target", "in", "A_ARG_TYPE_SeekTarget"))),
            Action("Next", listOf(instance)),
            Action("Previous", listOf(instance)),
            Action("SetPlayMode", listOf(instance, Arg("NewPlayMode", "in", "CurrentPlayMode"))),
            Action("GetCurrentTransportActions", listOf(instance, Arg("Actions", "out", "CurrentTransportActions"))),
        )
        val variables = listOf(
            Variable("A_ARG_TYPE_InstanceID", "ui4"),
            Variable("AVTransportURI", "string"),
            Variable("AVTransportURIMetaData", "string"),
            Variable("NextAVTransportURI", "string"),
            Variable("NextAVTransportURIMetaData", "string"),
            Variable("NumberOfTracks", "ui4"),
            Variable("CurrentMediaDuration", "string"),
            Variable("PlaybackStorageMedium", "string"),
            Variable("RecordStorageMedium", "string"),
            Variable("RecordMediumWriteStatus", "string"),
            Variable("TransportState", "string", true, listOf("STOPPED", "PLAYING", "PAUSED_PLAYBACK", "TRANSITIONING", "NO_MEDIA_PRESENT")),
            Variable("TransportStatus", "string", false, listOf("OK", "ERROR_OCCURRED")),
            Variable("TransportPlaySpeed", "string", false, listOf("1")),
            Variable("CurrentTrack", "ui4"),
            Variable("CurrentTrackDuration", "string"),
            Variable("CurrentTrackMetaData", "string"),
            Variable("CurrentTrackURI", "string"),
            Variable("RelativeTimePosition", "string"),
            Variable("AbsoluteTimePosition", "string"),
            Variable("RelativeCounterPosition", "i4"),
            Variable("AbsoluteCounterPosition", "i4"),
            Variable("PossiblePlaybackStorageMedia", "string"),
            Variable("PossibleRecordStorageMedia", "string"),
            Variable("PossibleRecordQualityModes", "string"),
            Variable("CurrentPlayMode", "string", false, listOf("NORMAL"), "NORMAL"),
            Variable("CurrentRecordQualityMode", "string"),
            Variable("A_ARG_TYPE_SeekMode", "string", false, listOf("REL_TIME", "TRACK_NR")),
            Variable("A_ARG_TYPE_SeekTarget", "string"),
            Variable("CurrentTransportActions", "string"),
            Variable("LastChange", "string", true),
        )
        return buildScpd(actions, variables)
    }

    private fun renderingControlScpd(): String {
        val instance = Arg("InstanceID", "in", "A_ARG_TYPE_InstanceID")
        val channel = Arg("Channel", "in", "A_ARG_TYPE_Channel")
        val actions = listOf(
            Action("ListPresets", listOf(instance, Arg("CurrentPresetNameList", "out", "PresetNameList"))),
            Action("SelectPreset", listOf(instance, Arg("PresetName", "in", "A_ARG_TYPE_PresetName"))),
            Action("GetVolume", listOf(instance, channel, Arg("CurrentVolume", "out", "Volume"))),
            Action("SetVolume", listOf(instance, channel, Arg("DesiredVolume", "in", "Volume"))),
            Action("GetMute", listOf(instance, channel, Arg("CurrentMute", "out", "Mute"))),
            Action("SetMute", listOf(instance, channel, Arg("DesiredMute", "in", "Mute"))),
        )
        val variables = listOf(
            Variable("A_ARG_TYPE_InstanceID", "ui4"),
            Variable("A_ARG_TYPE_Channel", "string", false, listOf("Master")),
            Variable("A_ARG_TYPE_PresetName", "string", false, listOf("FactoryDefaults")),
            Variable("PresetNameList", "string"),
            Variable("Volume", "ui2", true, null, "75"),
            Variable("Mute", "boolean", true, null, "0"),
            Variable("LastChange", "string", true),
        )
        return buildScpd(actions, variables)
    }

    private fun connectionManagerScpd(): String {
        val actions = listOf(
            Action("GetProtocolInfo", listOf(Arg("Source", "out", "SourceProtocolInfo"), Arg("Sink", "out", "SinkProtocolInfo"))),
            Action("GetCurrentConnectionIDs", listOf(Arg("ConnectionIDs", "out", "CurrentConnectionIDs"))),
            Action(
                "GetCurrentConnectionInfo",
                listOf(
                    Arg("ConnectionID", "in", "A_ARG_TYPE_ConnectionID"),
                    Arg("RcsID", "out", "A_ARG_TYPE_RcsID"),
                    Arg("AVTransportID", "out", "A_ARG_TYPE_AVTransportID"),
                    Arg("ProtocolInfo", "out", "A_ARG_TYPE_ProtocolInfo"),
                    Arg("PeerConnectionManager", "out", "A_ARG_TYPE_ConnectionManager"),
                    Arg("PeerConnectionID", "out", "A_ARG_TYPE_ConnectionID"),
                    Arg("Direction", "out", "A_ARG_TYPE_Direction"),
                    Arg("Status", "out", "A_ARG_TYPE_ConnectionStatus"),
                ),
            ),
        )
        val variables = listOf(
            Variable("SourceProtocolInfo", "string", true),
            Variable("SinkProtocolInfo", "string", true),
            Variable("CurrentConnectionIDs", "string", true),
            Variable("A_ARG_TYPE_ConnectionStatus", "string"),
            Variable("A_ARG_TYPE_ConnectionManager", "string"),
            Variable("A_ARG_TYPE_Direction", "string"),
            Variable("A_ARG_TYPE_ProtocolInfo", "string"),
            Variable("A_ARG_TYPE_ConnectionID", "i4"),
            Variable("A_ARG_TYPE_AVTransportID", "i4"),
            Variable("A_ARG_TYPE_RcsID", "i4"),
        )
        return buildScpd(actions, variables)
    }

    /**
     * The `Sink` protocol list advertised by ConnectionManager. Declaring both
     * audio and video MIME types is what lets a controller (Music Assistant, HA,
     * a phone's "cast" menu) push either kind of media at us.
     */
    val SINK_PROTOCOL_INFO: String = listOf(
        "http-get:*:audio/mpeg:*",
        "http-get:*:audio/mp4:*",
        "http-get:*:audio/aac:*",
        "http-get:*:audio/aacp:*",
        "http-get:*:audio/flac:*",
        "http-get:*:audio/ogg:*",
        "http-get:*:audio/wav:*",
        "http-get:*:audio/x-wav:*",
        "http-get:*:audio/L16:*",
        "http-get:*:audio/webm:*",
        "http-get:*:video/mp4:*",
        "http-get:*:video/webm:*",
        "http-get:*:video/mpeg:*",
        "http-get:*:video/x-matroska:*",
        "http-get:*:video/quicktime:*",
        "http-get:*:application/vnd.apple.mpegurl:*",
        "http-get:*:application/x-mpegURL:*",
        "http-get:*:application/octet-stream:*",
    ).joinToString(",")
}
