package com.bushrangerlabs.canvas_display_edge.snapcast

import java.io.EOFException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Snapcast wire protocol (verified against snapserver 0.34.0).
 *
 * Every message is a 26-byte little-endian header followed by a payload:
 *
 * ```
 * uint16 type, uint16 id, uint16 refersTo,
 * int32  sent.sec, int32 sent.usec, int32 received.sec, int32 received.usec,
 * uint32 size            // payload byte count
 * ```
 *
 * The `sent`/`received` timestamps carry the clock used for time sync: the
 * client sends `Time` with its own clock in `sent`, the server replies with its
 * receive/send clocks in `received`/`sent`.
 */
object SnapcastProtocol {

    const val TYPE_CODEC_HEADER = 1
    const val TYPE_WIRE_CHUNK = 2
    const val TYPE_SERVER_SETTINGS = 3
    const val TYPE_TIME = 4
    const val TYPE_HELLO = 5
    const val TYPE_CLIENT_INFO = 7
    const val TYPE_ERROR = 8

    const val HEADER_SIZE = 26
    const val MAX_MESSAGE_SIZE = 1_000_000

    /** Protocol version this client speaks (snapcast `SnapStreamProtocolVersion`). */
    const val PROTOCOL_VERSION = 2

    data class Message(
        val type: Int,
        val id: Int,
        val refersTo: Int,
        val sentSec: Int,
        val sentUsec: Int,
        val receivedSec: Int,
        val receivedUsec: Int,
        val payload: ByteArray,
    ) {
        override fun equals(other: Any?): Boolean =
            other is Message && type == other.type && id == other.id && refersTo == other.refersTo &&
                sentSec == other.sentSec && sentUsec == other.sentUsec &&
                receivedSec == other.receivedSec && receivedUsec == other.receivedUsec &&
                payload.contentEquals(other.payload)

        override fun hashCode(): Int = payload.contentHashCode() * 31 + type
    }

    data class Clock(val sec: Int, val usec: Int) {
        /** Microseconds since an arbitrary epoch. */
        fun micros(): Long = sec.toLong() * 1_000_000L + usec
    }

    data class CodecHeader(val codec: String, val data: ByteArray) {
        override fun equals(other: Any?): Boolean =
            other is CodecHeader && codec == other.codec && data.contentEquals(other.data)

        override fun hashCode(): Int = codec.hashCode() * 31 + data.contentHashCode()
    }

    data class WireChunk(val timestamp: Long, val data: ByteArray) {
        override fun equals(other: Any?): Boolean =
            other is WireChunk && timestamp == other.timestamp && data.contentEquals(other.data)

        override fun hashCode(): Int = timestamp.hashCode() * 31 + data.contentHashCode()
    }

    // ─── Encoding ─────────────────────────────────────────────────────────────

    fun encode(
        type: Int,
        payload: ByteArray = ByteArray(0),
        id: Int = 0,
        refersTo: Int = 0,
        sent: Clock = Clock(0, 0),
        received: Clock = Clock(0, 0),
    ): ByteArray {
        val buffer = ByteBuffer.allocate(HEADER_SIZE + payload.size).order(ByteOrder.LITTLE_ENDIAN)
        buffer.putShort(type.toShort())
        buffer.putShort(id.toShort())
        buffer.putShort(refersTo.toShort())
        buffer.putInt(sent.sec)
        buffer.putInt(sent.usec)
        buffer.putInt(received.sec)
        buffer.putInt(received.usec)
        buffer.putInt(payload.size)
        buffer.put(payload)
        return buffer.array()
    }

    fun jsonPayload(values: Map<String, Any?>): ByteArray {
        val body = SnapJson.writeObject(values).toByteArray(Charsets.UTF_8)
        return ByteBuffer.allocate(4 + body.size).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(body.size)
            .put(body)
            .array()
    }

    fun encodeHello(
        mac: String,
        hostName: String,
        version: String,
        clientName: String,
        os: String,
        arch: String,
        instance: Int,
        id: String,
        sent: Clock,
    ): ByteArray = encode(
        TYPE_HELLO,
        jsonPayload(
            linkedMapOf(
                "MAC" to mac,
                "HostName" to hostName,
                "Version" to version,
                "ClientName" to clientName,
                "OS" to os,
                "Arch" to arch,
                "Instance" to instance,
                "ID" to id,
                "SnapStreamProtocolVersion" to PROTOCOL_VERSION,
            ),
        ),
        sent = sent,
    )

    fun encodeTime(latency: Clock, sent: Clock): ByteArray {
        val payload = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(latency.sec)
            .putInt(latency.usec)
            .array()
        return encode(TYPE_TIME, payload, sent = sent)
    }

    fun encodeSetVolume(percent: Int, muted: Boolean, id: Int, sent: Clock): ByteArray = encode(
        TYPE_CLIENT_INFO,
        jsonPayload(linkedMapOf("volume" to percent.coerceIn(0, 100), "muted" to muted)),
        id = id,
        sent = sent,
    )

    // ─── Decoding ─────────────────────────────────────────────────────────────

    /** Read one full message from [input]. Returns null at end of stream. */
    fun read(input: InputStream): Message? {
        val header = readFully(input, HEADER_SIZE) ?: return null
        val buffer = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
        val type = buffer.short.toInt() and 0xFFFF
        val id = buffer.short.toInt() and 0xFFFF
        val refersTo = buffer.short.toInt() and 0xFFFF
        val sentSec = buffer.int
        val sentUsec = buffer.int
        val receivedSec = buffer.int
        val receivedUsec = buffer.int
        val size = buffer.int
        if (size < 0 || size > MAX_MESSAGE_SIZE) {
            throw EOFException("snapcast message size out of range: $size")
        }
        val payload = if (size > 0) readFully(input, size) ?: throw EOFException("truncated snapcast payload") else ByteArray(0)
        return Message(type, id, refersTo, sentSec, sentUsec, receivedSec, receivedUsec, payload)
    }

    /** Parse a JSON message payload (`uint32 length` + JSON). */
    fun parseJson(payload: ByteArray): Map<String, Any?> {
        if (payload.size < 4) return emptyMap()
        val length = ByteBuffer.wrap(payload, 0, 4).order(ByteOrder.LITTLE_ENDIAN).int
        if (length < 0 || 4 + length > payload.size) return emptyMap()
        return SnapJson.parseObject(String(payload, 4, length, Charsets.UTF_8))
    }

    /** Parse a CodecHeader payload (`uint32 codecLen` + codec + `uint32 dataLen` + data). */
    fun parseCodecHeader(payload: ByteArray): CodecHeader? {
        if (payload.size < 8) return null
        val buffer = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN)
        val codecLength = buffer.int
        if (codecLength < 0 || 4 + codecLength + 4 > payload.size) return null
        val codec = String(payload, 4, codecLength, Charsets.UTF_8)
        val dataLength = ByteBuffer.wrap(payload, 4 + codecLength, 4).order(ByteOrder.LITTLE_ENDIAN).int
        val dataStart = 4 + codecLength + 4
        if (dataLength < 0 || dataStart + dataLength > payload.size) return null
        return CodecHeader(codec, payload.copyOfRange(dataStart, dataStart + dataLength))
    }

    /**
     * Parse a WireChunk payload: `int32 timestamp.sec` + `int32 timestamp.usec` +
     * `uint32 dataLen` + data. The timestamp is the chunk's playout time on the
     * server clock (snapcast `WireChunk::start()`).
     */
    fun parseWireChunk(payload: ByteArray): WireChunk? {
        if (payload.size < 12) return null
        val buffer = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN)
        val sec = buffer.int
        val usec = buffer.int
        val dataLength = buffer.int
        if (dataLength < 0 || 12 + dataLength > payload.size) return null
        return WireChunk(sec.toLong() * 1_000_000L + usec, payload.copyOfRange(12, 12 + dataLength))
    }

    private fun readFully(input: InputStream, count: Int): ByteArray? {
        val out = ByteArray(count)
        var read = 0
        while (read < count) {
            val n = input.read(out, read, count - read)
            if (n < 0) return if (read == 0) null else throw EOFException("truncated snapcast message")
            read += n
        }
        return out
    }
}

/**
 * NTP-style clock offset estimation between the client and the Snapcast server.
 *
 * The client sends `Time` with its clock in `sent`; the server replies with its
 * receive clock in `received` and its send clock in `sent`. With `t1`/`t4` the
 * client's send/receive times and `t2`/`t3` the server's, the offset is
 * `((t2 - t1) + (t3 - t4)) / 2` and the round trip is `(t4 - t1) - (t3 - t2)`.
 */
class SnapcastClockSync(private val maxSamples: Int = 20) {

    private val offsets = ArrayDeque<Long>()
    private var bestRoundTrip = Long.MAX_VALUE
    private var bestOffset = 0L

    /** Server clock minus client clock, in microseconds. */
    val offsetMicros: Long get() = bestOffset

    fun hasSync(): Boolean = offsets.isNotEmpty()

    fun record(t1: Long, t2: Long, t3: Long, t4: Long) {
        val roundTrip = (t4 - t1) - (t3 - t2)
        if (roundTrip < 0) return
        val offset = ((t2 - t1) + (t3 - t4)) / 2
        offsets.addLast(offset)
        while (offsets.size > maxSamples) offsets.removeFirst()
        // Prefer the sample with the smallest round trip: least network jitter.
        if (roundTrip <= bestRoundTrip) {
            bestRoundTrip = roundTrip
            bestOffset = offset
        }
    }

    /** Median of the recent offsets — more stable than a single sample. */
    fun medianOffsetMicros(): Long {
        if (offsets.isEmpty()) return bestOffset
        val sorted = offsets.sorted()
        return sorted[sorted.size / 2]
    }

    fun reset() {
        offsets.clear()
        bestRoundTrip = Long.MAX_VALUE
        bestOffset = 0L
    }
}
