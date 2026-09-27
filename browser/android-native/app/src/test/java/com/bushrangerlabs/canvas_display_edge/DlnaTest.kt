package com.bushrangerlabs.canvas_display_edge

import com.bushrangerlabs.canvas_display_edge.dlna.DlnaDescriptions
import com.bushrangerlabs.canvas_display_edge.dlna.DlnaHttpServer
import com.bushrangerlabs.canvas_display_edge.dlna.DlnaPlaybackAdapter
import com.bushrangerlabs.canvas_display_edge.dlna.DlnaRenderer
import com.bushrangerlabs.canvas_display_edge.dlna.DlnaXml
import java.net.HttpURLConnection
import java.net.URL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Android DLNA renderer (pure JVM — no Android APIs). */
class DlnaTest {

    // ─── XML helpers ──────────────────────────────────────────────────────────

    @Test fun escapeAndUnescapeRoundTrip() {
        val raw = "Tom & Jerry's <\"show\">"
        val escaped = DlnaXml.escape(raw)
        assertEquals("Tom &amp; Jerry&apos;s &lt;&quot;show&quot;&gt;", escaped)
        assertEquals(raw, DlnaXml.unescape(escaped))
    }

    @Test fun unescapeDecodesNumericReferences() {
        assertEquals("café 😀", DlnaXml.unescape("caf&#233; &#x1F600;"))
    }

    @Test fun readElementHandlesTextAndCdata() {
        assertEquals("Hello", DlnaXml.readElement("<dc:title>Hello</dc:title>", "dc:title"))
        assertEquals("A & B", DlnaXml.readElement("<dc:title><![CDATA[A & B]]></dc:title>", "dc:title"))
        assertNull(DlnaXml.readElement("<x/>", "dc:title"))
    }

    @Test fun durationRoundTrip() {
        assertEquals(225.0, DlnaXml.parseUpnpDuration("0:03:45")!!, 0.001)
        assertEquals(3600.5, DlnaXml.parseUpnpDuration("1:00:00.500")!!, 0.001)
        assertNull(DlnaXml.parseUpnpDuration("garbage"))
        assertEquals("0:03:45", DlnaXml.formatUpnpDuration(225.0))
        assertEquals("0:00:00", DlnaXml.formatUpnpDuration(-5.0))
    }

    @Test fun soapActionHeaderParsing() {
        val parsed = DlnaXml.parseSoapActionHeader("\"urn:schemas-upnp-org:service:AVTransport:1#Play\"")
        assertEquals("urn:schemas-upnp-org:service:AVTransport:1", parsed?.service)
        assertEquals("Play", parsed?.action)
        assertNull(DlnaXml.parseSoapActionHeader("nonsense"))
        assertNull(DlnaXml.parseSoapActionHeader(null))
    }

    // ─── DIDL-Lite ────────────────────────────────────────────────────────────

    @Test fun didlParsingExtractsMetadata() {
        val didl = "<DIDL-Lite><item>" +
            "<dc:title>Bohemian Rhapsody</dc:title>" +
            "<upnp:artist>Queen</upnp:artist>" +
            "<upnp:album>A Night at the Opera</upnp:album>" +
            "<upnp:albumArtURI>http://host/art.jpg</upnp:albumArtURI>" +
            "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
            "<res protocolInfo=\"http-get:*:audio/mpeg:DLNA.ORG_PN=MP3\" duration=\"0:05:55\">http://host/t.mp3</res>" +
            "</item></DIDL-Lite>"
        val meta = DlnaXml.parseDidlLite(didl)
        assertEquals("Bohemian Rhapsody", meta.title)
        assertEquals("Queen", meta.artist)
        assertEquals("A Night at the Opera", meta.album)
        assertEquals("http://host/art.jpg", meta.artworkUrl)
        assertEquals("audio/mpeg", meta.mimeType)
        assertEquals(355.0, meta.durationSeconds!!, 0.001)
    }

    @Test fun didlParsingOfEmptyInputIsEmpty() {
        assertEquals(null, DlnaXml.parseDidlLite("").title)
        assertEquals(null, DlnaXml.parseDidlLite(null).title)
    }

    // ─── Descriptions ─────────────────────────────────────────────────────────

    @Test fun deviceDescriptionAdvertisesAllServices() {
        val xml = DlnaDescriptions.deviceDescription(
            DlnaDescriptions.Config("abc-123", "Canvas Edge", "Canvas Display", "Canvas Display", "0.3.1"),
        )
        assertTrue(xml.contains("<deviceType>${DlnaDescriptions.MEDIA_RENDERER_TYPE}</deviceType>"))
        assertTrue(xml.contains("<UDN>uuid:abc-123</UDN>"))
        assertTrue(xml.contains(DlnaDescriptions.AV_TRANSPORT_TYPE))
        assertTrue(xml.contains(DlnaDescriptions.RENDERING_CONTROL_TYPE))
        assertTrue(xml.contains(DlnaDescriptions.CONNECTION_MANAGER_TYPE))
        assertTrue(xml.contains("<controlURL>/control/AVTransport</controlURL>"))
    }

    @Test fun serviceDescriptionsExistAndAreWellFormed() {
        for (path in listOf("/service/AVTransport.xml", "/service/RenderingControl.xml", "/service/ConnectionManager.xml")) {
            val scpd = DlnaDescriptions.serviceDescription(path)
            assertNotNull("missing SCPD for $path", scpd)
            assertTrue(scpd!!.contains("<scpd xmlns=\"urn:schemas-upnp-org:service-1-0\">"))
            assertTrue(scpd.contains("<actionList>"))
            assertTrue(scpd.contains("<serviceStateTable>"))
        }
        assertNull(DlnaDescriptions.serviceDescription("/service/Unknown.xml"))
    }

    // ─── Renderer ─────────────────────────────────────────────────────────────

    private class FakeAdapter : DlnaPlaybackAdapter {
        val played = mutableListOf<String>()
        val videos = mutableListOf<String>()
        var paused = 0
        var resumed = 0
        var stopped = 0
        val seeks = mutableListOf<Double>()
        var volumeLevel = 50
        var mutedState = false
        var videoStops = 0

        override fun playAudio(url: String, title: String?, volume: Int) { played.add(url) }
        override fun pauseAudio() { paused += 1 }
        override fun resumeAudio() { resumed += 1 }
        override fun stopAudio() { stopped += 1 }
        override fun seekAudio(seconds: Double) { seeks.add(seconds) }
        override fun setVolume(level: Int) { volumeLevel = level }
        override fun setMute(muted: Boolean) { mutedState = muted }
        override fun getVolume(): Int = volumeLevel
        override fun getMuted(): Boolean = mutedState
        override fun playVideo(url: String, title: String?) { videos.add(url) }
        override fun stopVideo() { videoStops += 1 }
    }

    private val audioDidl = "<DIDL-Lite><item><dc:title>Track</dc:title>" +
        "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
        "<res protocolInfo=\"http-get:*:audio/mpeg:*\" duration=\"0:02:00\">http://host/a.mp3</res>" +
        "</item></DIDL-Lite>"

    private val videoDidl = "<DIDL-Lite><item><dc:title>Clip</dc:title>" +
        "<upnp:class>object.item.videoItem</upnp:class>" +
        "<res protocolInfo=\"http-get:*:video/mp4:*\" duration=\"0:01:30\">http://host/v.mp4</res>" +
        "</item></DIDL-Lite>"

    @Test fun rendererStartsWithNoMedia() {
        val renderer = DlnaRenderer(FakeAdapter())
        val info = renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "GetTransportInfo", emptyMap())
        assertTrue(info.contains("<CurrentTransportState>NO_MEDIA_PRESENT</CurrentTransportState>"))
    }

    @Test fun audioPlaybackRoutesToAdapter() {
        val adapter = FakeAdapter()
        val renderer = DlnaRenderer(adapter)
        renderer.handleAction(
            DlnaDescriptions.AV_TRANSPORT_TYPE,
            "SetAVTransportURI",
            mapOf("CurrentURI" to "http://host/a.mp3", "CurrentURIMetaData" to audioDidl),
        )
        val mediaInfo = renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "GetMediaInfo", emptyMap())
        assertTrue(mediaInfo.contains("<CurrentURI>http://host/a.mp3</CurrentURI>"))
        assertTrue(mediaInfo.contains("<MediaDuration>0:02:00</MediaDuration>"))

        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Play", mapOf("Speed" to "1"))
        assertEquals(listOf("http://host/a.mp3"), adapter.played)
        assertTrue(adapter.videos.isEmpty())
    }

    @Test fun videoRoutesToOverlayNotAudio() {
        val adapter = FakeAdapter()
        val renderer = DlnaRenderer(adapter)
        renderer.handleAction(
            DlnaDescriptions.AV_TRANSPORT_TYPE,
            "SetAVTransportURI",
            mapOf("CurrentURI" to "http://host/v.mp4", "CurrentURIMetaData" to videoDidl),
        )
        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Play", mapOf("Speed" to "1"))
        assertEquals(listOf("http://host/v.mp4"), adapter.videos)
        assertTrue(adapter.played.isEmpty())

        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Stop", emptyMap())
        assertEquals(1, adapter.videoStops)
    }

    @Test fun pauseThenPlayResumes() {
        val adapter = FakeAdapter()
        val renderer = DlnaRenderer(adapter)
        renderer.handleAction(
            DlnaDescriptions.AV_TRANSPORT_TYPE,
            "SetAVTransportURI",
            mapOf("CurrentURI" to "http://host/a.mp3", "CurrentURIMetaData" to audioDidl),
        )
        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Play", mapOf("Speed" to "1"))
        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Pause", emptyMap())
        assertEquals(1, adapter.paused)
        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Play", mapOf("Speed" to "1"))
        assertEquals(1, adapter.resumed)
        assertEquals(1, adapter.played.size)
    }

    @Test fun playWithoutMediaFails() {
        val renderer = DlnaRenderer(FakeAdapter())
        val error = runCatching {
            renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Play", emptyMap())
        }.exceptionOrNull()
        assertTrue(error is DlnaRenderer.UpnpError)
        assertEquals(701, (error as DlnaRenderer.UpnpError).code)
    }

    @Test fun seekParsesRelTime() {
        val adapter = FakeAdapter()
        val renderer = DlnaRenderer(adapter)
        renderer.handleAction(
            DlnaDescriptions.AV_TRANSPORT_TYPE,
            "SetAVTransportURI",
            mapOf("CurrentURI" to "http://host/a.mp3", "CurrentURIMetaData" to audioDidl),
        )
        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Seek", mapOf("Unit" to "REL_TIME", "Target" to "0:00:30"))
        assertEquals(listOf(30.0), adapter.seeks)
        val position = renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "GetPositionInfo", emptyMap())
        assertTrue(position.contains("<RelTime>0:00:30</RelTime>"))
    }

    @Test fun renderingControlReachesAdapter() {
        val adapter = FakeAdapter()
        val renderer = DlnaRenderer(adapter)
        val initial = renderer.handleAction(DlnaDescriptions.RENDERING_CONTROL_TYPE, "GetVolume", mapOf("Channel" to "Master"))
        assertTrue(initial.contains("<CurrentVolume>50</CurrentVolume>"))
        renderer.handleAction(DlnaDescriptions.RENDERING_CONTROL_TYPE, "SetVolume", mapOf("Channel" to "Master", "DesiredVolume" to "80"))
        assertEquals(80, adapter.volumeLevel)
        renderer.handleAction(DlnaDescriptions.RENDERING_CONTROL_TYPE, "SetMute", mapOf("Channel" to "Master", "DesiredMute" to "1"))
        assertTrue(adapter.mutedState)
    }

    @Test fun connectionManagerAdvertisesAudioAndVideo() {
        val renderer = DlnaRenderer(FakeAdapter())
        val info = renderer.handleAction(DlnaDescriptions.CONNECTION_MANAGER_TYPE, "GetProtocolInfo", emptyMap())
        assertTrue(info.contains("audio/mpeg"))
        assertTrue(info.contains("video/mp4"))
    }

    @Test fun unknownActionFails() {
        val renderer = DlnaRenderer(FakeAdapter())
        val error = runCatching {
            renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Bogus", emptyMap())
        }.exceptionOrNull()
        assertEquals(401, (error as DlnaRenderer.UpnpError).code)
    }

    @Test fun subscribersReceiveLastChange() {
        val events = mutableListOf<String>()
        val renderer = DlnaRenderer(FakeAdapter()) { _, body -> events.add(body) }
        val subscriber = renderer.subscribe(DlnaDescriptions.AV_TRANSPORT_TYPE, "http://192.168.1.5:1234/notify", 1800)
        renderer.sendInitialEvent(subscriber)
        assertEquals(1, events.size)
        assertTrue(events[0].contains("<LastChange>"))
        assertTrue(events[0].contains("NO_MEDIA_PRESENT"))

        renderer.handleAction(
            DlnaDescriptions.AV_TRANSPORT_TYPE,
            "SetAVTransportURI",
            mapOf("CurrentURI" to "http://host/a.mp3", "CurrentURIMetaData" to audioDidl),
        )
        assertEquals(2, events.size)
        assertTrue(events[1].contains("STOPPED"))

        assertTrue(renderer.unsubscribe(subscriber.sid))
        renderer.handleAction(DlnaDescriptions.AV_TRANSPORT_TYPE, "Play", mapOf("Speed" to "1"))
        assertEquals(2, events.size)
    }

    // ─── HTTP surface ─────────────────────────────────────────────────────────

    private fun soapEnvelope(serviceType: String, action: String, args: Map<String, String>): String {
        val inner = args.entries.joinToString("") { "<${it.key}>${it.value}</${it.key}>" }
        return "<?xml version=\"1.0\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">" +
            "<s:Body><u:$action xmlns:u=\"$serviceType\">$inner</u:$action></s:Body>" +
            "</s:Envelope>"
    }

    private fun post(url: String, serviceType: String, action: String, args: Map<String, String>): Pair<Int, String> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 5_000
            readTimeout = 5_000
            setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"")
            setRequestProperty("SOAPACTION", "\"$serviceType#$action\"")
        }
        connection.outputStream.use { it.write(soapEnvelope(serviceType, action, args).toByteArray()) }
        val status = connection.responseCode
        val body = (if (status < 400) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use { it.readText() } ?: ""
        connection.disconnect()
        return status to body
    }

    private fun get(url: String): Pair<Int, String> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 5_000
            readTimeout = 5_000
        }
        val status = connection.responseCode
        val stream = if (status < 400) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
        connection.disconnect()
        return status to body
    }

    @Test fun httpSurfaceServesDescriptionsAndControl() {
        val adapter = FakeAdapter()
        val renderer = DlnaRenderer(adapter)
        val server = DlnaHttpServer(
            DlnaDescriptions.Config("test-uuid", "Canvas Edge (test)", "Canvas Display", "Canvas Display", "0.3.1"),
            renderer,
            0,
        )
        val base = server.start("127.0.0.1")
        try {
            val (descStatus, desc) = get("$base/description.xml")
            assertEquals(200, descStatus)
            assertTrue(desc.contains("MediaRenderer:1"))
            assertTrue(desc.contains("uuid:test-uuid"))

            val (scpdStatus, scpd) = get("$base/service/AVTransport.xml")
            assertEquals(200, scpdStatus)
            assertTrue(scpd.contains("<scpd"))

            val avt = DlnaDescriptions.AV_TRANSPORT_TYPE
            val (setStatus, _) = post("$base/control/AVTransport", avt, "SetAVTransportURI", mapOf(
                "InstanceID" to "0",
                "CurrentURI" to "http://host/a.mp3",
                "CurrentURIMetaData" to "",
            ))
            assertEquals(200, setStatus)
            val (playStatus, playBody) = post("$base/control/AVTransport", avt, "Play", mapOf("InstanceID" to "0", "Speed" to "1"))
            assertEquals(200, playStatus)
            assertTrue(playBody.contains("PlayResponse"))
            assertEquals(listOf("http://host/a.mp3"), adapter.played)

            val (healthStatus, health) = get("$base/health")
            assertEquals(200, healthStatus)
            assertTrue(health.contains("\"transportState\":\"PLAYING\""))

            val rcs = DlnaDescriptions.RENDERING_CONTROL_TYPE
            val (volStatus, _) = post("$base/control/RenderingControl", rcs, "SetVolume", mapOf(
                "InstanceID" to "0", "Channel" to "Master", "DesiredVolume" to "90",
            ))
            assertEquals(200, volStatus)
            assertEquals(90, adapter.volumeLevel)
        } finally {
            server.stop()
        }
    }

    @Test fun httpSurfaceRejectsUnknownPathsAndBadActions() {
        val renderer = DlnaRenderer(FakeAdapter())
        val server = DlnaHttpServer(
            DlnaDescriptions.Config("test-uuid", "Canvas Edge (test)", "Canvas Display", "Canvas Display", "0.3.1"),
            renderer,
            0,
        )
        val base = server.start("127.0.0.1")
        try {
            val (missing, _) = get("$base/control/Nope")
            assertEquals(404, missing)

            val (faultStatus, fault) = post(
                "$base/control/AVTransport",
                DlnaDescriptions.AV_TRANSPORT_TYPE,
                "Bogus",
                emptyMap(),
            )
            assertEquals(500, faultStatus)
            assertTrue(fault.contains("UPnPError"))
        } finally {
            server.stop()
        }
    }

    @Test fun videoWrapperUrlEncodesMediaUrl() {
        val url = DlnaHttpServer.videoWrapperUrl("http://192.168.1.50:49500", "http://host/a b.mp4", "My Clip")
        assertTrue(url.startsWith("http://192.168.1.50:49500/video?url="))
        assertTrue(url.contains("a+b.mp4") || url.contains("a%20b.mp4"))
        assertTrue(url.contains("title=My+Clip") || url.contains("title=My%20Clip"))
    }

    @Test fun arbiterReleasesPreviousOwner() {
        com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.reset()
        val released = mutableListOf<String>()
        com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.registerReleaser(
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.Owner.MEDIA,
        ) { released.add("media") }
        com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.registerReleaser(
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.Owner.SNAPCAST,
        ) { released.add("snapcast") }

        com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.acquire(
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.Owner.MEDIA,
        )
        com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.acquire(
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.Owner.SNAPCAST,
        )
        assertEquals(listOf("media"), released)
        assertEquals(
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.Owner.SNAPCAST,
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.currentOwner(),
        )
        com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.release(
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.Owner.MEDIA,
        )
        assertEquals(
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.Owner.SNAPCAST,
            com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.currentOwner(),
        )
        com.bushrangerlabs.canvas_display_edge.dlna.AudioSinkArbiter.reset()
    }

    @Test fun videoDetectionPrefersMimeOverExtension() {
        // An .mp4 URL declared as audio must play through the audio path.
        val renderer = DlnaRenderer(FakeAdapter())
        val audioMp4 = "<DIDL-Lite><item><dc:title>Song</dc:title>" +
            "<res protocolInfo=\"http-get:*:audio/mp4:*\">http://host/song.mp4</res></item></DIDL-Lite>"
        renderer.handleAction(
            DlnaDescriptions.AV_TRANSPORT_TYPE,
            "SetAVTransportURI",
            mapOf("CurrentURI" to "http://host/song.mp4", "CurrentURIMetaData" to audioMp4),
        )
        assertFalse(renderer.state().isVideo)
    }
}
