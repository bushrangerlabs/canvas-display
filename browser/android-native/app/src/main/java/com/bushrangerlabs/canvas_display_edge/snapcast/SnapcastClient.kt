package com.bushrangerlabs.canvas_display_edge.snapcast

import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

/**
 * Snapcast client: connects to a snapserver, performs the handshake, keeps the
 * clock in sync and forwards audio chunks to a [SnapcastSink].
 *
 * The connection is TCP (snapserver's default `tcp://host:1704`); audio arrives
 * interleaved on the same socket as `CodecHeader` / `WireChunk` messages.
 */
class SnapcastClient(
    private val host: String,
    private val port: Int,
    private val clientId: String,
    private val clientName: String,
    private val sink: SnapcastSink,
    private val onStatus: (String) -> Unit = {},
) {

    /** Receives decoded-stream events from the client. */
    interface SnapcastSink {
        /** Called once per stream when the codec header arrives. */
        fun onCodecHeader(codec: String, data: ByteArray)
        /** Called for every audio chunk. [timestamp] is the server clock in microseconds. */
        fun onChunk(timestampMicros: Long, data: ByteArray)
        /** Called when the stream stops (disconnect / stop). */
        fun onStopped()
    }

    @Volatile private var running = false
    @Volatile private var socket: Socket? = null
    @Volatile private var output: OutputStream? = null
    private var readerThread: Thread? = null
    private var syncThread: Thread? = null
    private var messageId = 1

    val clockSync = SnapcastClockSync()

    /** Server settings reported by the last handshake. */
    @Volatile var serverBufferMs: Int = 1000
        private set
    @Volatile var serverVolume: Int = 100
        private set
    @Volatile var serverMuted: Boolean = false
        private set
    @Volatile var codec: String? = null
        private set

    fun start() {
        if (running) return
        running = true
        readerThread = thread(name = "snapcast-client", isDaemon = true) { runLoop() }
    }

    fun stop() {
        running = false
        syncThread?.interrupt()
        syncThread = null
        runCatching { socket?.close() }
        socket = null
        output = null
        sink.onStopped()
    }

    /** Ask the server to set this client's volume (0–100). */
    fun setVolume(percent: Int, muted: Boolean = false) {
        val stream = output ?: return
        val id = nextId()
        runCatching {
            stream.write(
                SnapcastProtocol.encodeSetVolume(
                    percent,
                    muted,
                    id,
                    SnapcastProtocol.Clock(nowSec(), nowUsec()),
                ),
            )
            stream.flush()
        }
    }

    private fun runLoop() {
        var backoffMs = 1000L
        while (running) {
            try {
                connectAndServe()
                backoffMs = 1000L
            } catch (error: Throwable) {
                if (!running) break
                onStatus("snapcast disconnected: ${error.message}")
            } finally {
                sink.onStopped()
                codec = null
                clockSync.reset()
                runCatching { socket?.close() }
                socket = null
                output = null
            }
            if (!running) break
            try {
                Thread.sleep(backoffMs)
            } catch (_: InterruptedException) {
                break
            }
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
    }

    private fun connectAndServe() {
        val connection = Socket()
        connection.tcpNoDelay = true
        connection.connect(InetSocketAddress(host, port), 10_000)
        socket = connection
        val stream = connection.getOutputStream()
        output = stream

        stream.write(
            SnapcastProtocol.encodeHello(
                mac = clientId,
                hostName = clientName,
                version = CLIENT_VERSION,
                clientName = "Snapclient",
                os = "Android",
                arch = "aarch64",
                instance = 1,
                id = clientId,
                sent = SnapcastProtocol.Clock(nowSec(), nowUsec()),
            ),
        )
        stream.flush()
        onStatus("snapcast connected to $host:$port")

        startSyncLoop()

        val input = BufferedInputStream(connection.getInputStream(), 64 * 1024)
        while (running) {
            val message = SnapcastProtocol.read(input) ?: break
            when (message.type) {
                SnapcastProtocol.TYPE_SERVER_SETTINGS -> {
                    val settings = SnapcastProtocol.parseJson(message.payload)
                    serverBufferMs = (settings["bufferMs"] as? Number)?.toInt() ?: 1000
                    serverVolume = (settings["volume"] as? Number)?.toInt() ?: 100
                    serverMuted = settings["muted"] as? Boolean ?: false
                }
                SnapcastProtocol.TYPE_CODEC_HEADER -> {
                    val header = SnapcastProtocol.parseCodecHeader(message.payload) ?: continue
                    codec = header.codec
                    sink.onCodecHeader(header.codec, header.data)
                }
                SnapcastProtocol.TYPE_WIRE_CHUNK -> {
                    val chunk = SnapcastProtocol.parseWireChunk(message.payload) ?: continue
                    sink.onChunk(chunk.timestamp, chunk.data)
                }
                SnapcastProtocol.TYPE_TIME -> {
                    // Server reply to our Time: header carries its receive/send clocks.
                    val t4 = nowMicros()
                    val t1 = pendingTimeSentMicros
                    if (t1 > 0) {
                        clockSync.record(
                            t1 = t1,
                            t2 = SnapcastProtocol.Clock(message.receivedSec, message.receivedUsec).micros(),
                            t3 = SnapcastProtocol.Clock(message.sentSec, message.sentUsec).micros(),
                            t4 = t4,
                        )
                        if (!loggedSync) {
                            loggedSync = true
                            onStatus("clock sync: offset=${clockSync.offsetMicros}us (server-client)")
                        }
                    }
                }
                SnapcastProtocol.TYPE_ERROR -> {
                    val error = SnapcastProtocol.parseJson(message.payload)
                    onStatus("snapcast server error: ${error["error"] ?: error}")
                }
            }
        }
    }

    @Volatile private var pendingTimeSentMicros = 0L
    @Volatile private var loggedSync = false

    private fun startSyncLoop() {
        syncThread?.interrupt()
        syncThread = thread(name = "snapcast-sync", isDaemon = true) {
            while (running) {
                val stream = output
                if (stream != null) {
                    val sent = SnapcastProtocol.Clock(nowSec(), nowUsec())
                    pendingTimeSentMicros = sent.micros()
                    runCatching {
                        stream.write(SnapcastProtocol.encodeTime(SnapcastProtocol.Clock(0, 0), sent))
                        stream.flush()
                    }
                }
                try {
                    Thread.sleep(1000)
                } catch (_: InterruptedException) {
                    return@thread
                }
            }
        }
    }

    private fun nextId(): Int {
        val id = messageId
        messageId = if (messageId >= 0xFFFF) 1 else messageId + 1
        return id
    }

    private fun nowMicros(): Long = System.nanoTime() / 1000

    // The header's sent/received clocks must use the SAME monotonic source as
    // nowMicros(), otherwise the NTP-style offset is computed across two
    // different epochs and comes out as garbage.
    private fun nowSec(): Int = (nowMicros() / 1_000_000L).toInt()

    private fun nowUsec(): Int = (nowMicros() % 1_000_000L).toInt()

    companion object {
        const val CLIENT_VERSION = "0.34.0"
        const val DEFAULT_PORT = 1704
    }
}
