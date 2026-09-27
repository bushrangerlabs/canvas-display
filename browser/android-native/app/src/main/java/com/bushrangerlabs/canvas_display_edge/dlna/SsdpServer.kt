package com.bushrangerlabs.canvas_display_edge.dlna

import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.util.Collections
import kotlin.concurrent.thread

/**
 * SSDP (UPnP discovery) responder for the Canvas Edge DLNA renderer.
 *
 * Answers M-SEARCH probes and announces itself with NOTIFY alive/byebye so
 * Home Assistant's `dlna_dmr` integration (and Music Assistant's DLNA player
 * provider) can discover the device without manual configuration.
 */
class SsdpServer(
    private val uuid: String,
    private val interfaceAddress: String,
    private val location: String,
    private val server: String,
) {

    private data class Target(val nt: String, val usn: String)

    private val targets: List<Target> = run {
        val udn = "uuid:$uuid"
        listOf(
            Target("upnp:rootdevice", "$udn::upnp:rootdevice"),
            Target(udn, udn),
            Target(DlnaDescriptions.MEDIA_RENDERER_TYPE, "$udn::${DlnaDescriptions.MEDIA_RENDERER_TYPE}"),
            Target(DlnaDescriptions.AV_TRANSPORT_TYPE, "$udn::${DlnaDescriptions.AV_TRANSPORT_TYPE}"),
            Target(DlnaDescriptions.RENDERING_CONTROL_TYPE, "$udn::${DlnaDescriptions.RENDERING_CONTROL_TYPE}"),
            Target(DlnaDescriptions.CONNECTION_MANAGER_TYPE, "$udn::${DlnaDescriptions.CONNECTION_MANAGER_TYPE}"),
        )
    }

    @Volatile private var socket: MulticastSocket? = null
    @Volatile private var running = false
    private var announceThread: Thread? = null

    fun start() {
        if (running) return
        // Bind explicitly to the wildcard address. Android's MulticastSocket ends up
        // as a dual-stack socket (`[::]:1900`) which still receives the IPv4 SSDP
        // multicast group, so this is about being explicit rather than forcing AF_INET.
        val sock = MulticastSocket(null).apply {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getByName("0.0.0.0"), SSDP_PORT))
        }
        val group = InetAddress.getByName(SSDP_ADDRESS)
        val iface = NetworkInterface.getByInetAddress(InetAddress.getByName(interfaceAddress))
        if (iface != null) {
            sock.networkInterface = iface
            sock.joinGroup(InetSocketAddress(group, SSDP_PORT), iface)
        } else {
            sock.joinGroup(group)
        }
        socket = sock
        running = true
        DlnaLog.info("SSDP listening on ${sock.localSocketAddress} for $interfaceAddress")

        thread(name = "dlna-ssdp-rx", isDaemon = true) {
            val buffer = ByteArray(2048)
            while (running) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    sock.receive(packet)
                    handleMessage(String(packet.data, 0, packet.length), packet.address, packet.port)
                } catch (error: Throwable) {
                    if (running) DlnaLog.warn("ssdp receive failed: ${error.message}")
                }
            }
        }

        announce("ssdp:alive")
        announceThread = thread(name = "dlna-ssdp-announce", isDaemon = true) {
            while (running) {
                try {
                    Thread.sleep(ANNOUNCE_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    return@thread
                }
                if (running) announce("ssdp:alive")
            }
        }
    }

    fun stop() {
        if (!running) return
        announce("ssdp:byebye")
        running = false
        announceThread?.interrupt()
        announceThread = null
        runCatching { socket?.close() }
        socket = null
    }

    private fun handleMessage(message: String, address: InetAddress, port: Int) {
        val requestLine = message.lineSequence().firstOrNull().orEmpty()
        if (!requestLine.startsWith("M-SEARCH", ignoreCase = true)) return

        val headers = parseHeaders(message)
        val st = headers["st"]?.trim().orEmpty()
        val man = headers["man"]?.trim().orEmpty()
        if (man.isNotEmpty() && man != "\"ssdp:discover\"") return

        val matches = targets.filter { st == "ssdp:all" || st == it.nt }
        if (matches.isEmpty()) return

        val sock = socket ?: return
        for (target in matches) {
            val response = buildSearchResponse(target).toByteArray()
            runCatching { sock.send(DatagramPacket(response, response.size, address, port)) }
                .onFailure { DlnaLog.warn("ssdp response failed: ${it.message}") }
        }
    }

    private fun buildSearchResponse(target: Target): String = listOf(
        "HTTP/1.1 200 OK",
        "CACHE-CONTROL: max-age=$MAX_AGE_SECONDS",
        "DATE: ${java.time.ZonedDateTime.now(java.time.ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME)}",
        "EXT:",
        "LOCATION: $location",
        "SERVER: $server",
        "ST: ${target.nt}",
        "USN: ${target.usn}",
        "OPT: \"http://schemas.upnp.org/upnp/1/0/\"; ns=01",
        "01-NLS: 1",
        "BOOTID.UPNP.ORG: 1",
        "CONFIGID.UPNP.ORG: 1337",
        "",
        "",
    ).joinToString("\r\n")

    private fun announce(kind: String) {
        val sock = socket ?: return
        val group = InetAddress.getByName(SSDP_ADDRESS)
        for (target in targets) {
            val lines = if (kind == "ssdp:alive") {
                listOf(
                    "NOTIFY * HTTP/1.1",
                    "HOST: $SSDP_ADDRESS:$SSDP_PORT",
                    "CACHE-CONTROL: max-age=$MAX_AGE_SECONDS",
                    "LOCATION: $location",
                    "NT: ${target.nt}",
                    "NLS: 1",
                    "SERVER: $server",
                    "USN: ${target.usn}",
                    "BOOTID.UPNP.ORG: 1",
                    "CONFIGID.UPNP.ORG: 1337",
                    "",
                    "",
                )
            } else {
                listOf(
                    "NOTIFY * HTTP/1.1",
                    "HOST: $SSDP_ADDRESS:$SSDP_PORT",
                    "NT: ${target.nt}",
                    "NLS: 1",
                    "USN: ${target.usn}",
                    "BOOTID.UPNP.ORG: 1",
                    "CONFIGID.UPNP.ORG: 1337",
                    "",
                    "",
                )
            }
            val payload = lines.joinToString("\r\n").toByteArray()
            runCatching { sock.send(DatagramPacket(payload, payload.size, group, SSDP_PORT)) }
                .onFailure { DlnaLog.warn("ssdp announce failed: ${it.javaClass.simpleName}: ${it.message}") }
        }
    }

    private fun parseHeaders(message: String): Map<String, String> {
        val out = mutableMapOf<String, String>()
        message.split("\r\n").drop(1).forEach { line ->
            val colon = line.indexOf(':')
            if (colon > 0) out[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        return out
    }

    companion object {
        const val SSDP_ADDRESS = "239.255.255.250"
        const val SSDP_PORT = 1900
        private const val MAX_AGE_SECONDS = 1800
        private const val ANNOUNCE_INTERVAL_MS = 300_000L
    }
}

/** Network helpers shared by the DLNA stack. */
object DlnaNetwork {

    /** First non-loopback IPv4 address, or null when the device has no network. */
    fun localAddress(): String? {
        val interfaces = runCatching { NetworkInterface.getNetworkInterfaces() }.getOrNull() ?: return null
        for (iface in Collections.list(interfaces)) {
            if (!iface.isUp || iface.isLoopback) continue
            for (address in Collections.list(iface.inetAddresses)) {
                if (!address.isLoopbackAddress && address.address.size == 4) return address.hostAddress
            }
        }
        return null
    }
}

/** Tiny logging shim so the DLNA package has no hard Android dependency. */
object DlnaLog {
    var sink: (String) -> Unit = {}
    fun info(message: String) = sink(message)
    fun warn(message: String) = sink("WARN $message")
}
