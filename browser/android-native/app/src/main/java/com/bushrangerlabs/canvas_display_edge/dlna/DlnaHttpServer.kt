package com.bushrangerlabs.canvas_display_edge.dlna

import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import kotlin.concurrent.thread

/**
 * DLNA MediaRenderer HTTP control surface.
 *
 * Serves the UPnP device/service descriptions, handles SOAP control requests and
 * GENA event subscriptions, and drives the injected [DlnaRenderer]. Started from
 * the app's DLNA service.
 */
class DlnaHttpServer(
    private val config: DlnaDescriptions.Config,
    private val renderer: DlnaRenderer,
    private val port: Int,
) {

    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var running = false
    private var acceptThread: Thread? = null
    private var pruneThread: Thread? = null

    /** Absolute base URL, e.g. `http://192.168.1.50:49500`. */
    @Volatile var baseUrl: String = ""
        private set

    fun start(host: String): String {
        if (running) return baseUrl
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(port))
        serverSocket = socket
        running = true
        baseUrl = "http://$host:${socket.localPort}"

        acceptThread = thread(name = "dlna-http", isDaemon = true) {
            while (running) {
                val client = try {
                    socket.accept()
                } catch (error: Throwable) {
                    if (running) DlnaLog.warn("http accept failed: ${error.message}")
                    break
                }
                thread(name = "dlna-http-conn", isDaemon = true) {
                    runCatching { handle(client) }
                        .onFailure { DlnaLog.warn("http request failed: ${it.message}") }
                    runCatching { client.close() }
                }
            }
        }
        pruneThread = thread(name = "dlna-gena-prune", isDaemon = true) {
            while (running) {
                try {
                    Thread.sleep(60_000)
                } catch (_: InterruptedException) {
                    return@thread
                }
                renderer.pruneSubscribers()
            }
        }
        return baseUrl
    }

    fun stop() {
        running = false
        acceptThread?.interrupt()
        acceptThread = null
        pruneThread?.interrupt()
        pruneThread = null
        runCatching { serverSocket?.close() }
        serverSocket = null
    }

    // ─── Request handling ─────────────────────────────────────────────────────

    private fun handle(client: Socket) {
        client.soTimeout = 15_000
        val input = client.getInputStream()
        val output = BufferedOutputStream(client.getOutputStream())

        val requestLine = readLine(input) ?: return
        val parts = requestLine.split(" ")
        if (parts.size < 2) return
        val method = parts[0].uppercase()
        val target = parts[1]

        val headers = mutableMapOf<String, String>()
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }

        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        val body = if (contentLength > 0) readBody(input, contentLength) else ""

        val uri = runCatching { URI(target) }.getOrNull()
        val path = uri?.path ?: target.substringBefore('?')
        val query = parseQuery(uri?.rawQuery)

        when {
            (method == "GET" || method == "HEAD") && (path == "/description.xml" || path == "/rootDesc.xml") ->
                respond(output, 200, "text/xml; charset=\"utf-8\"", DlnaDescriptions.deviceDescription(config))

            (method == "GET" || method == "HEAD") && DlnaDescriptions.serviceDescription(path) != null ->
                respond(output, 200, "text/xml; charset=\"utf-8\"", DlnaDescriptions.serviceDescription(path)!!)

            (method == "GET" || method == "HEAD") && path == "/video" ->
                respond(output, 200, "text/html; charset=\"utf-8\"", buildVideoPage(query["url"].orEmpty(), query["title"].orEmpty()))

            (method == "GET" || method == "HEAD") && path == "/health" ->
                respond(output, 200, "application/json", healthJson())

            method == "POST" && CONTROL_PATHS.containsKey(path) ->
                handleControl(output, CONTROL_PATHS.getValue(path), headers["soapaction"], body)

            method == "SUBSCRIBE" && EVENT_PATHS.containsKey(path) ->
                handleSubscribe(output, EVENT_PATHS.getValue(path), headers)

            method == "UNSUBSCRIBE" && EVENT_PATHS.containsKey(path) ->
                handleUnsubscribe(output, headers["sid"].orEmpty())

            else -> respond(output, 404, "text/plain", "Not Found")
        }
        output.flush()
    }

    private fun handleControl(output: BufferedOutputStream, serviceType: String, soapAction: String?, body: String) {
        val action = DlnaXml.parseSoapActionHeader(soapAction)?.action
        if (action.isNullOrEmpty()) {
            respond(output, 500, "text/xml; charset=\"utf-8\"", DlnaXml.buildSoapFault(401, "Invalid Action"))
            return
        }
        val args = extractActionArgs(body, action)
        try {
            val inner = renderer.handleAction(serviceType, action, args)
            respond(output, 200, "text/xml; charset=\"utf-8\"", DlnaXml.buildSoapEnvelope(serviceType, action, inner))
        } catch (error: DlnaRenderer.UpnpError) {
            respond(output, 500, "text/xml; charset=\"utf-8\"", DlnaXml.buildSoapFault(error.code, error.description))
        } catch (error: Throwable) {
            DlnaLog.warn("control action $action failed: ${error.message}")
            respond(output, 500, "text/xml; charset=\"utf-8\"", DlnaXml.buildSoapFault(501, "Action Failed"))
        }
    }

    private fun handleSubscribe(output: BufferedOutputStream, serviceType: String, headers: Map<String, String>) {
        val timeout = parseTimeout(headers["timeout"].orEmpty())
        val sid = headers["sid"].orEmpty()

        if (sid.isNotEmpty()) {
            val renewed = renderer.renew(sid, timeout)
            if (renewed == null) {
                respond(output, 412, "text/plain", "")
                return
            }
            respond(output, 200, "text/plain", "", mapOf("SID" to renewed.sid, "TIMEOUT" to "Second-$timeout"))
            return
        }

        val callbackUrl = extractCallbackUrl(headers["callback"].orEmpty())
        if (callbackUrl == null) {
            respond(output, 400, "text/plain", "")
            return
        }
        val subscriber = renderer.subscribe(serviceType, callbackUrl, timeout)
        respond(output, 200, "text/plain", "", mapOf("SID" to subscriber.sid, "TIMEOUT" to "Second-$timeout"))
        renderer.sendInitialEvent(subscriber)
    }

    private fun handleUnsubscribe(output: BufferedOutputStream, sid: String) {
        renderer.unsubscribe(sid)
        respond(output, 200, "text/plain", "", mapOf("SID" to sid))
    }

    private fun healthJson(): String {
        val state = renderer.state()
        return buildString {
            append("{\"ok\":true")
            append(",\"transportState\":\"${state.transportState.wire}\"")
            append(",\"uri\":\"${jsonEscape(state.uri)}\"")
            append(",\"title\":\"${jsonEscape(state.title)}\"")
            append(",\"isVideo\":${state.isVideo}")
            append(",\"durationSeconds\":${state.durationSeconds}")
            append(",\"positionSeconds\":${state.positionSeconds}")
            append("}")
        }
    }

    // ─── GENA delivery ────────────────────────────────────────────────────────

    /** Send a GENA NOTIFY to a subscriber. Called by the renderer's event sender. */
    fun sendEvent(subscriber: DlnaSubscriber, body: String) {
        val target = runCatching { URI(subscriber.callbackUrl) }.getOrNull() ?: return
        if (!target.scheme.equals("http", ignoreCase = true) || target.host.isNullOrBlank()) return
        subscriber.seq += 1
        val payload = body.toByteArray()
        runCatching {
            val port = if (target.port > 0) target.port else 80
            val requestPath = target.rawPath?.ifBlank { "/" }.orEmpty() +
                target.rawQuery?.let { "?$it" }.orEmpty()
            Socket().use { socket ->
                socket.connect(InetSocketAddress(target.host, port), 5_000)
                socket.soTimeout = 5_000
                val headers = buildString {
                    append("NOTIFY $requestPath HTTP/1.1\r\n")
                    append("HOST: ${target.host}:$port\r\n")
                    append("CONTENT-TYPE: text/xml; charset=\"utf-8\"\r\n")
                    append("NT: upnp:event\r\nNTS: upnp:propchange\r\n")
                    append("SID: ${subscriber.sid}\r\nSEQ: ${subscriber.seq}\r\n")
                    append("CONTENT-LENGTH: ${payload.size}\r\nCONNECTION: close\r\n\r\n")
                }.toByteArray()
                socket.getOutputStream().use { output ->
                    output.write(headers)
                    output.write(payload)
                    output.flush()
                }
            }
        }.onFailure { DlnaLog.warn("gena notify failed: ${it.message}") }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private fun respond(
        output: BufferedOutputStream,
        status: Int,
        contentType: String,
        body: String,
        extraHeaders: Map<String, String> = emptyMap(),
    ) {
        val bytes = body.toByteArray()
        val reason = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            404 -> "Not Found"
            412 -> "Precondition Failed"
            else -> "Error"
        }
        val builder = StringBuilder()
        builder.append("HTTP/1.1 $status $reason\r\n")
        builder.append("Content-Type: $contentType\r\n")
        builder.append("Content-Length: ${bytes.size}\r\n")
        builder.append("Connection: close\r\n")
        extraHeaders.forEach { (key, value) -> builder.append("$key: $value\r\n") }
        builder.append("\r\n")
        output.write(builder.toString().toByteArray())
        output.write(bytes)
    }

    private fun readLine(input: InputStream): String? {
        val buffer = StringBuilder()
        while (true) {
            val next = input.read()
            if (next == -1) return if (buffer.isEmpty()) null else buffer.toString()
            if (next == '\n'.code) return buffer.toString().trimEnd('\r')
            buffer.append(next.toChar())
        }
    }

    private fun readBody(input: InputStream, length: Int): String {
        val bytes = ByteArray(length)
        var read = 0
        while (read < length) {
            val count = input.read(bytes, read, length - read)
            if (count <= 0) break
            read += count
        }
        return String(bytes, 0, read)
    }

    private fun parseQuery(raw: String?): Map<String, String> {
        if (raw.isNullOrEmpty()) return emptyMap()
        return raw.split("&").mapNotNull { pair ->
            val index = pair.indexOf('=')
            if (index < 0) null else decode(pair.substring(0, index)) to decode(pair.substring(index + 1))
        }.toMap()
    }

    private fun decode(value: String): String =
        runCatching { java.net.URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)

    private fun extractActionArgs(body: String, action: String): Map<String, String> {
        val block = Regex("<u:$action[^>]*>([\\s\\S]*?)</u:$action>", RegexOption.IGNORE_CASE).find(body)
        val scope = block?.groupValues?.get(1) ?: body
        val args = mutableMapOf<String, String>()
        Regex("<([A-Za-z0-9_]+)>([\\s\\S]*?)</\\1>").findAll(scope).forEach { match ->
            args[match.groupValues[1]] = DlnaXml.unescape(match.groupValues[2])
        }
        return args
    }

    private fun extractCallbackUrl(header: String): String? =
        Regex("<([^>]+)>").find(header)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }

    private fun parseTimeout(header: String): Int {
        Regex("Second-(\\d+)", RegexOption.IGNORE_CASE).find(header)?.let { return it.groupValues[1].toIntOrNull() ?: 1800 }
        return 1800
    }

    private fun jsonEscape(value: String): String =
        value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")

    private fun buildVideoPage(mediaUrl: String, title: String): String =
        "<!doctype html><html><head><meta charset=\"utf-8\">" +
            "<title>${DlnaXml.escape(title.ifEmpty { "Canvas Edge" })}</title>" +
            "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}" +
            "video{width:100%;height:100%;object-fit:contain;background:#000}</style>" +
            "</head><body>" +
            "<video src=\"${DlnaXml.escape(mediaUrl)}\" autoplay controls playsinline></video>" +
            "</body></html>"

    companion object {
        val CONTROL_PATHS = mapOf(
            "/control/AVTransport" to DlnaDescriptions.AV_TRANSPORT_TYPE,
            "/control/RenderingControl" to DlnaDescriptions.RENDERING_CONTROL_TYPE,
            "/control/ConnectionManager" to DlnaDescriptions.CONNECTION_MANAGER_TYPE,
        )
        val EVENT_PATHS = mapOf(
            "/event/AVTransport" to DlnaDescriptions.AV_TRANSPORT_TYPE,
            "/event/RenderingControl" to DlnaDescriptions.RENDERING_CONTROL_TYPE,
            "/event/ConnectionManager" to DlnaDescriptions.CONNECTION_MANAGER_TYPE,
        )

        /** URL of the HTML video wrapper the WebView overlay loads. */
        fun videoWrapperUrl(baseUrl: String, mediaUrl: String, title: String? = null): String {
            val encoded = java.net.URLEncoder.encode(mediaUrl, "UTF-8")
            val titlePart = title?.takeIf { it.isNotEmpty() }?.let { "&title=${java.net.URLEncoder.encode(it, "UTF-8")}" } ?: ""
            return "$baseUrl/video?url=$encoded$titlePart"
        }
    }
}
