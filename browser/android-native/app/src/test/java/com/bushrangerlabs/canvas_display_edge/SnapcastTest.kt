package com.bushrangerlabs.canvas_display_edge

import com.bushrangerlabs.canvas_display_edge.snapcast.SnapJson
import com.bushrangerlabs.canvas_display_edge.snapcast.SnapcastClockSync
import com.bushrangerlabs.canvas_display_edge.snapcast.SnapcastProtocol
import com.bushrangerlabs.canvas_display_edge.snapcast.SnapcastSync
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the Snapcast protocol codec (pure JVM). */
class SnapcastTest {

    // ─── Flat JSON ────────────────────────────────────────────────────────────

    @Test fun parsesFlatJsonObject() {
        val parsed = SnapJson.parseObject("""{"bufferMs":1000,"latency":0,"muted":false,"volume":25}""")
        assertEquals(1000.0, parsed["bufferMs"])
        assertEquals(0.0, parsed["latency"])
        assertEquals(false, parsed["muted"])
        assertEquals(25.0, parsed["volume"])
    }

    @Test fun parsesStringsAndEscapes() {
        val parsed = SnapJson.parseObject("""{"Arch":"x86_64","OS":"Debian GNU/Linux 12 (bookworm)","Name":"a\"b"}""")
        assertEquals("x86_64", parsed["Arch"])
        assertEquals("Debian GNU/Linux 12 (bookworm)", parsed["OS"])
        assertEquals("a\"b", parsed["Name"])
    }

    @Test fun writesFlatJsonObject() {
        val json = SnapJson.writeObject(linkedMapOf("volume" to 25, "muted" to false, "name" to "x"))
        assertEquals("""{"volume":25,"muted":false,"name":"x"}""", json)
    }

    @Test fun jsonRoundTrip() {
        val original = linkedMapOf<String, Any?>("a" to 1, "b" to "two", "c" to true)
        val parsed = SnapJson.parseObject(SnapJson.writeObject(original))
        assertEquals(1.0, parsed["a"])
        assertEquals("two", parsed["b"])
        assertEquals(true, parsed["c"])
    }

    // ─── Wire format ──────────────────────────────────────────────────────────

    @Test fun headerIsLittleEndian26Bytes() {
        val encoded = SnapcastProtocol.encode(
            type = SnapcastProtocol.TYPE_HELLO,
            payload = ByteArray(0),
            id = 2,
            sent = SnapcastProtocol.Clock(1_041_422, 764_404),
        )
        assertEquals(SnapcastProtocol.HEADER_SIZE, encoded.size)
        val buffer = ByteBuffer.wrap(encoded).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(SnapcastProtocol.TYPE_HELLO, buffer.short.toInt())
        assertEquals(2, buffer.short.toInt())
        assertEquals(0, buffer.short.toInt())
        assertEquals(1_041_422, buffer.int)
        assertEquals(764_404, buffer.int)
        buffer.int // received.sec
        buffer.int // received.usec
        assertEquals(0, buffer.int) // size
    }

    @Test fun messageRoundTripThroughStream() {
        val payload = SnapcastProtocol.jsonPayload(linkedMapOf("volume" to 25, "muted" to false))
        val encoded = SnapcastProtocol.encode(
            type = SnapcastProtocol.TYPE_CLIENT_INFO,
            payload = payload,
            id = 7,
            sent = SnapcastProtocol.Clock(10, 20),
            received = SnapcastProtocol.Clock(30, 40),
        )
        val decoded = SnapcastProtocol.read(ByteArrayInputStream(encoded))
        assertNotNull(decoded)
        assertEquals(SnapcastProtocol.TYPE_CLIENT_INFO, decoded!!.type)
        assertEquals(7, decoded.id)
        assertEquals(10, decoded.sentSec)
        assertEquals(20, decoded.sentUsec)
        assertEquals(30, decoded.receivedSec)
        assertEquals(40, decoded.receivedUsec)
        assertArrayEquals(payload, decoded.payload)
    }

    @Test fun readReturnsNullAtEndOfStream() {
        assertNull(SnapcastProtocol.read(ByteArrayInputStream(ByteArray(0))))
    }

    @Test fun helloUsesSnapcastFieldNames() {
        val encoded = SnapcastProtocol.encodeHello(
            mac = "02:00:00:00:00:01",
            hostName = "canvas",
            version = "0.34.0",
            clientName = "Snapclient",
            os = "Android",
            arch = "aarch64",
            instance = 1,
            id = "canvas",
            sent = SnapcastProtocol.Clock(0, 0),
        )
        val message = SnapcastProtocol.read(ByteArrayInputStream(encoded))!!
        val json = SnapcastProtocol.parseJson(message.payload)
        assertEquals("02:00:00:00:00:01", json["MAC"])
        assertEquals("canvas", json["HostName"])
        assertEquals("Snapclient", json["ClientName"])
        assertEquals("Android", json["OS"])
        assertEquals("aarch64", json["Arch"])
        assertEquals(1.0, json["Instance"])
        assertEquals(2.0, json["SnapStreamProtocolVersion"])
    }

    @Test fun parsesCodecHeader() {
        val codecName = "flac".toByteArray()
        val data = byteArrayOf(0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22)
        val payload = ByteBuffer.allocate(4 + codecName.size + 4 + data.size).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(codecName.size).put(codecName)
            .putInt(data.size).put(data)
            .array()
        val header = SnapcastProtocol.parseCodecHeader(payload)
        assertNotNull(header)
        assertEquals("flac", header!!.codec)
        assertArrayEquals(data, header.data)
    }

    @Test fun parsesWireChunk() {
        val data = byteArrayOf(1, 2, 3, 4, 5)
        // WireChunk payload: int32 sec, int32 usec, uint32 dataLen, data.
        val payload = ByteBuffer.allocate(4 + 4 + 4 + data.size).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(1234)
            .putInt(567_890)
            .putInt(data.size).put(data)
            .array()
        val chunk = SnapcastProtocol.parseWireChunk(payload)
        assertNotNull(chunk)
        assertEquals(1234L * 1_000_000L + 567_890L, chunk!!.timestamp)
        assertArrayEquals(data, chunk.data)
    }

    @Test fun rejectsTruncatedPayloads() {
        assertNull(SnapcastProtocol.parseCodecHeader(byteArrayOf(1, 2)))
        assertNull(SnapcastProtocol.parseWireChunk(byteArrayOf(1, 2, 3)))
    }

    @Test fun timeMessageIsEightByteLatency() {
        val encoded = SnapcastProtocol.encodeTime(
            SnapcastProtocol.Clock(0, 0),
            SnapcastProtocol.Clock(100, 200),
        )
        val message = SnapcastProtocol.read(ByteArrayInputStream(encoded))!!
        assertEquals(SnapcastProtocol.TYPE_TIME, message.type)
        assertEquals(8, message.payload.size)
        assertEquals(100, message.sentSec)
        assertEquals(200, message.sentUsec)
    }

    // ─── Clock sync ───────────────────────────────────────────────────────────

    @Test fun clockSyncComputesOffset() {
        val sync = SnapcastClockSync()
        // Server clock is 5_000_000us ahead; 1_000us each way.
        val t1 = 1_000_000L
        val t2 = t1 + 1_000 + 5_000_000
        val t3 = t2 + 500
        val t4 = t1 + 2_000
        sync.record(t1, t2, t3, t4)
        assertTrue(sync.hasSync())
        val offset = sync.medianOffsetMicros()
        // ((t2-t1) + (t3-t4)) / 2 = ((5_001_000) + (5_000_500 - 2_000 + 1_000_000 - 1_000_000)) ...
        assertTrue("offset should be close to 5s, was $offset", offset in 5_000_000..5_001_000)
    }

    @Test fun clockSyncPrefersLowestRoundTrip() {
        val sync = SnapcastClockSync()
        // Huge round trip with a wild offset estimate.
        sync.record(t1 = 0, t2 = 1_000_000, t3 = 1_000_000, t4 = 10_000_000)
        // Tight round trip: 5ms each way, server clock equal to the client's.
        sync.record(t1 = 0, t2 = 5_000, t3 = 5_000, t4 = 10_000)
        assertEquals(0L, sync.offsetMicros)
    }

    @Test fun clockSyncIgnoresNegativeRoundTrip() {
        val sync = SnapcastClockSync()
        sync.record(t1 = 0, t2 = 0, t3 = 0, t4 = -5)
        assertTrue(!sync.hasSync())
    }

    // ─── Playback scheduling ──────────────────────────────────────────────────

    @Test fun playAtAddsServerBuffer() {
        assertEquals(1_500_000L, SnapcastSync.playAt(500_000L, bufferMs = 1000))
        assertEquals(500_000L, SnapcastSync.playAt(500_000L, bufferMs = 0))
    }

    @Test fun ageIsZeroWhenExactlyOnTime() {
        // Chunk captured at 1_000_000, buffer 1000ms -> play at 2_000_000.
        val playAt = SnapcastSync.playAt(1_000_000L, bufferMs = 1000)
        assertEquals(0L, SnapcastSync.age(serverNowMicros = 2_000_000L, playAtServerMicros = playAt, dacTimeMicros = 0))
    }

    @Test fun ageAccountsForOutputBufferDelay() {
        val playAt = SnapcastSync.playAt(1_000_000L, bufferMs = 1000)
        // 50ms of audio already queued in the output buffer means we are effectively 50ms late.
        assertEquals(50_000L, SnapcastSync.age(2_000_000L, playAt, dacTimeMicros = 50_000))
    }

    @Test fun decidePlaysWaitsOrDrops() {
        assertEquals(SnapcastSync.Decision.PLAY, SnapcastSync.decide(0))
        assertEquals(SnapcastSync.Decision.PLAY, SnapcastSync.decide(50_000))
        assertEquals(SnapcastSync.Decision.WAIT, SnapcastSync.decide(-100_000))
        assertEquals(SnapcastSync.Decision.DROP, SnapcastSync.decide(500_000))
    }

    @Test fun waitMillisIsBounded() {
        assertEquals(100L, SnapcastSync.waitMillis(-100_000))
        assertEquals(1L, SnapcastSync.waitMillis(-100))
        assertEquals(200L, SnapcastSync.waitMillis(-5_000_000))
    }

    @Test fun dacTimeFromBufferedFrames() {
        // 48000 frames queued at 48kHz = 1 second.
        assertEquals(1_000_000L, SnapcastSync.dacTimeMicros(framesWritten = 48_000, playbackHeadFrames = 0, sampleRate = 48_000))
        // Nothing queued -> no delay.
        assertEquals(0L, SnapcastSync.dacTimeMicros(framesWritten = 48_000, playbackHeadFrames = 48_000, sampleRate = 48_000))
        // Head ahead of written (should not happen) clamps to zero.
        assertEquals(0L, SnapcastSync.dacTimeMicros(framesWritten = 10, playbackHeadFrames = 99, sampleRate = 48_000))
    }
}
