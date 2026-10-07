package com.bushrangerlabs.canvas_display_edge.voice

import android.util.Log
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Remote audio endpoint client — the Android side of the Pico mic+speaker.
 *
 * Implements the Canvas audio-endpoint wire protocol (see firmware protocol.h):
 *   [u16 payload_len LE][u8 type][payload ...]
 * Two TCP connections: mic (endpoint -> us, 8ch interleaved S16LE @ 16 kHz,
 * 20 ms frames) and playback (us -> endpoint, mono PCM16 at a negotiated rate).
 *
 * Presents the same surface as [MicCapture] (onChunk of 1280-sample mono PCM16
 * chunks) so [VoicePipeline] can use it as a drop-in mic source, plus [play]
 * for sending TTS PCM to the endpoint's DAC.
 *
 * Channel map (verified against the Sipeed R6+1 schematic):
 *   0/1 = D0 L/R (mic0/mic1), 2/3 = D1 (mic2/mic3), 4/5 = D2 (mic4/mic5),
 *   6/7 = D3 (unused / centre). Centre mic is ch 7; ch 6 reads ~0.
 * On this board mics 2 (ch2) and 5 (ch5) are silent, so the beamformer uses
 * the live channels 0, 1, 3, 4, 7.
 */
class RemoteAudioEndpoint(
    private val host: String,
    private val port: Int,
    private val token: String,
    private val deviceId: String,
    private val onChunk: (ShortArray) -> Unit,
) {
    companion object {
        private const val TAG = "CanvasAudioEndpoint"

        private const val MSG_HELLO = 1
        private const val MSG_HELLO_ACK = 2
        private const val MSG_CONFIG = 3
        private const val MSG_AUDIO = 4

        private const val ROLE_MIC = 0
        private const val ROLE_PLAYBACK = 1

        const val MIC_CHANNELS = 8
        const val MIC_SAMPLE_RATE = 16_000
        const val MIC_FRAME_SAMPLES = 320 // 20 ms
        const val MIC_FRAME_BYTES = MIC_FRAME_SAMPLES * MIC_CHANNELS * 2

        // Matches MicCapture.CHUNK_SAMPLES (80 ms @ 16 kHz) for the wake-word step.
        const val CHUNK_SAMPLES = 1280

        // Live channels for the sum beamformer (centre weighted 2x).
        private val LIVE_CHANNELS = intArrayOf(0, 1, 3, 4, 7)

        private const val RECONNECT_DELAY_MS = 2_000L
    }

    private val running = AtomicBoolean(false)
    private val micSocket = AtomicReference<Socket?>(null)
    private val playSocket = AtomicReference<Socket?>(null)
    private var micThread: Thread? = null
    private var reconnectThread: Thread? = null

    val isRunning: Boolean get() = running.get()

    fun start() {
        if (running.getAndSet(true)) return
        micThread = Thread({ micLoop() }, "canvas-ae-mic").apply { start() }
        reconnectThread = Thread({ reconnectLoop() }, "canvas-ae-reconnect").apply { start() }
    }

    fun stop() {
        running.set(false)
        closeSockets()
        micThread?.join(1_000)
        micThread = null
        reconnectThread?.join(1_000)
        reconnectThread = null
    }

    /** Send mono PCM16 to the endpoint for playback (TTS). */
    fun play(pcm: ShortArray, sampleRate: Int = 22_050) {
        val sock = playSocket.get() ?: return
        try {
            val out = DataOutputStream(sock.getOutputStream())
            sendConfig(out, sampleRate)
            val bytes = ByteArray(pcm.size * 2)
            for (i in pcm.indices) {
                bytes[i * 2] = (pcm[i].toInt() and 0xFF).toByte()
                bytes[i * 2 + 1] = ((pcm[i].toInt() shr 8) and 0xFF).toByte()
            }
            sendFrame(out, MSG_AUDIO, bytes)
        } catch (e: Exception) {
            Log.w(TAG, "play failed: ${e.message}")
            playSocket.set(null)
            try { sock.close() } catch (_: Exception) {}
        }
    }

    // ── Framing ───────────────────────────────────────────────────────────────

    private fun frame(type: Int, payload: ByteArray): ByteArray {
        val total = payload.size + 1
        val out = ByteArray(total + 2)
        out[0] = (total and 0xFF).toByte()
        out[1] = ((total shr 8) and 0xFF).toByte()
        out[2] = type.toByte()
        payload.copyInto(out, 3)
        return out
    }

    private fun hello(role: Int): ByteArray {
        val t = token.toByteArray(Charsets.UTF_8)
        val d = deviceId.toByteArray(Charsets.UTF_8)
        val payload = ByteArray(2 + t.size + 1 + d.size)
        payload[0] = role.toByte()
        payload[1] = t.size.toByte()
        t.copyInto(payload, 2)
        payload[2 + t.size] = d.size.toByte()
        d.copyInto(payload, 3 + t.size)
        return frame(MSG_HELLO, payload)
    }

    private fun sendConfig(out: DataOutputStream, rate: Int) {
        val cfg = ByteArray(6)
        cfg[0] = (rate and 0xFF).toByte()
        cfg[1] = ((rate shr 8) and 0xFF).toByte()
        cfg[2] = ((rate shr 16) and 0xFF).toByte()
        cfg[3] = ((rate shr 24) and 0xFF).toByte()
        cfg[4] = 1 // channels
        cfg[5] = 0 // PCM16
        sendFrame(out, MSG_CONFIG, cfg)
    }

    private fun sendFrame(out: DataOutputStream, type: Int, payload: ByteArray) {
        out.write(frame(type, payload))
        out.flush()
    }

    /** Connect + auth. Returns the socket, or null on failure. */
    private fun connect(role: Int): Socket? {
        return try {
            val sock = Socket()
            sock.tcpNoDelay = true
            sock.connect(InetSocketAddress(host, port), 5_000)
            sock.soTimeout = 5_000
            val out = DataOutputStream(sock.getOutputStream())
            out.write(hello(role))
            out.flush()
            val input = DataInputStream(sock.getInputStream())
            // Wait for HELLO_ACK.
            val header = ByteArray(3)
            var got = 0
            while (got < 3) {
                val n = input.read(header, got, 3 - got)
                if (n < 0) throw java.io.IOException("endpoint closed during HELLO")
                got += n
            }
            val total = (header[0].toInt() and 0xFF) or ((header[1].toInt() and 0xFF) shl 8)
            val payload = ByteArray(total - 1)
            input.readFully(payload)
            if (header[2].toInt() != MSG_HELLO_ACK) throw java.io.IOException("expected HELLO_ACK")
            if (payload.size >= 2 && payload[1].toInt() != 0) throw java.io.IOException("endpoint rejected token")
            sock
        } catch (e: Exception) {
            Log.w(TAG, "connect(role=$role) failed: ${e.message}")
            null
        }
    }

    // ── Mic loop ──────────────────────────────────────────────────────────────

    private fun micLoop() {
        val chunk = ShortArray(CHUNK_SAMPLES)
        var filled = 0
        while (running.get()) {
            val sock = micSocket.get()
            if (sock == null) {
                Thread.sleep(RECONNECT_DELAY_MS)
                continue
            }
            try {
                val input = DataInputStream(sock.getInputStream())
                // Read one framed message.
                val header = ByteArray(3)
                var got = 0
                while (got < 3) {
                    val n = input.read(header, got, 3 - got)
                    if (n < 0) throw java.io.IOException("mic connection closed")
                    got += n
                }
                val total = (header[0].toInt() and 0xFF) or ((header[1].toInt() and 0xFF) shl 8)
                val type = header[2].toInt()
                val payload = ByteArray(total - 1)
                input.readFully(payload)
                if (type != MSG_AUDIO || payload.size < 8 + MIC_FRAME_BYTES) continue
                val frame = payload.copyOfRange(8, 8 + MIC_FRAME_BYTES)
                val mono = downmix(frame)
                for (s in mono) {
                    chunk[filled] = s
                    filled++
                    if (filled >= CHUNK_SAMPLES) {
                        onChunk(chunk.copyOf(CHUNK_SAMPLES))
                        filled = 0
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "mic loop error: ${e.message}")
                micSocket.set(null)
                try { sock.close() } catch (_: Exception) {}
                Thread.sleep(RECONNECT_DELAY_MS)
            }
        }
    }

    /** Sum beamformer over the live channels (centre weighted 2x), scaled to avoid clipping. */
    private fun downmix(frame: ByteArray): ShortArray {
        val out = ShortArray(MIC_FRAME_SAMPLES)
        for (s in 0 until MIC_FRAME_SAMPLES) {
            var sum = 0
            for (ch in LIVE_CHANNELS) {
                val base = (s * MIC_CHANNELS + ch) * 2
                val v = ((frame[base].toInt() and 0xFF) or ((frame[base + 1].toInt() and 0xFF) shl 8)).toShort().toInt()
                sum += if (ch == 7) v * 2 else v
            }
            out[s] = (sum / (LIVE_CHANNELS.size + 1)).toShort()
        }
        return out
    }

    private fun reconnectLoop() {
        while (running.get()) {
            if (micSocket.get() == null) {
                connect(ROLE_MIC)?.let { micSocket.set(it) }
            }
            if (playSocket.get() == null) {
                connect(ROLE_PLAYBACK)?.let { playSocket.set(it) }
            }
            Thread.sleep(RECONNECT_DELAY_MS)
        }
    }

    private fun closeSockets() {
        micSocket.getAndSet(null)?.let { try { it.close() } catch (_: Exception) {} }
        playSocket.getAndSet(null)?.let { try { it.close() } catch (_: Exception) {} }
    }
}