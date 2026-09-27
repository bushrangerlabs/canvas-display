package com.bushrangerlabs.canvas_display_edge.dlna

/**
 * Minimal XML helpers for the DLNA/UPnP renderer.
 *
 * UPnP control requests are small, well-formed documents, so a dependency-free
 * regex reader is sufficient and keeps the app free of an XML stack.
 */
object DlnaXml {

    /** Escape a value for inclusion in an XML text node or attribute. */
    fun escape(value: String?): String = (value ?: "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&apos;")

    /** Decode the five predefined XML entities plus numeric character references. */
    fun unescape(value: String): String {
        val numeric = Regex("&#x([0-9a-fA-F]+);|&#(\\d+);")
        val decoded = numeric.replace(value) { match ->
            val code = match.groups[1]?.value?.toIntOrNull(16)
                ?: match.groups[2]?.value?.toIntOrNull(10)
            if (code == null || code < 0 || code > 0x10FFFF) "" else String(Character.toChars(code))
        }
        return decoded
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    }

    private val REGEX_META = Regex("[.*+?^\${'$'}{}()|\\[\\]\\\\]")

    private fun escapeRegex(value: String): String = REGEX_META.replace(value, "\\\\${'$'}0")

    private fun stripCdata(value: String): String {
        val match = Regex("^\\s*<!\\[CDATA\\[([\\s\\S]*?)]]>\\s*$").find(value)
        return match?.groupValues?.get(1) ?: value
    }

    /** Read the text content of the first `<name>` element in [xml]. */
    fun readElement(xml: String, name: String): String? {
        val pattern = Regex(
            "<${escapeRegex(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegex(name)}>",
            RegexOption.IGNORE_CASE,
        )
        val match = pattern.find(xml) ?: return null
        return unescape(stripCdata(match.groupValues[1])).trim()
    }

    /** Read an attribute from the first `<name ...>` element in [xml]. */
    fun readAttribute(xml: String, name: String, attribute: String): String? {
        val element = Regex("<${escapeRegex(name)}(\\s[^>]*?)/?>", RegexOption.IGNORE_CASE).find(xml)
            ?: return null
        val attr = Regex("${escapeRegex(attribute)}\\s*=\\s*\"([^\"]*)\"", RegexOption.IGNORE_CASE)
            .find(element.groupValues[1]) ?: return null
        return unescape(attr.groupValues[1]).trim()
    }

    // ─── DIDL-Lite ────────────────────────────────────────────────────────────

    data class DidlMetadata(
        val title: String? = null,
        val artist: String? = null,
        val album: String? = null,
        val artworkUrl: String? = null,
        val upnpClass: String? = null,
        val mimeType: String? = null,
        val durationSeconds: Double? = null,
    )

    /**
     * Parse a DIDL-Lite document (as carried in `CurrentURIMetaData`). Returns an
     * empty result for empty or unparseable input — metadata is always optional.
     */
    fun parseDidlLite(xml: String?): DidlMetadata {
        val text = xml?.trim().orEmpty()
        if (text.isEmpty()) return DidlMetadata()

        val protocolInfo = readAttribute(text, "res", "protocolInfo")
        val mime = protocolInfo?.split(":")?.getOrNull(2)?.trim()?.takeIf { it.isNotEmpty() && it != "*" }

        return DidlMetadata(
            title = readElement(text, "dc:title") ?: readElement(text, "title"),
            artist = readElement(text, "upnp:artist")
                ?: readElement(text, "upnp:albumArtist")
                ?: readElement(text, "dc:creator"),
            album = readElement(text, "upnp:album"),
            artworkUrl = readElement(text, "upnp:albumArtURI"),
            upnpClass = readElement(text, "upnp:class"),
            mimeType = mime,
            durationSeconds = parseUpnpDuration(readAttribute(text, "res", "duration")),
        )
    }

    /** Parse a UPnP `H:MM:SS[.fraction]` duration into seconds. */
    fun parseUpnpDuration(value: String?): Double? {
        val trimmed = value?.trim() ?: return null
        val match = Regex("^(\\d+):(\\d{1,2}):(\\d{1,2})(?:\\.(\\d+))?$").find(trimmed) ?: return null
        val hours = match.groupValues[1].toIntOrNull() ?: return null
        val minutes = match.groupValues[2].toIntOrNull() ?: return null
        val seconds = match.groupValues[3].toIntOrNull() ?: return null
        val fraction = match.groupValues[4].takeIf { it.isNotEmpty() }?.let { "0.$it".toDouble() } ?: 0.0
        return hours * 3600 + minutes * 60 + seconds + fraction
    }

    /** Format seconds as a UPnP `H:MM:SS` duration. */
    fun formatUpnpDuration(totalSeconds: Double): String {
        val safe = if (totalSeconds.isFinite() && totalSeconds > 0) totalSeconds.toLong() else 0L
        val hours = safe / 3600
        val minutes = (safe % 3600) / 60
        val seconds = safe % 60
        return "%d:%02d:%02d".format(hours, minutes, seconds)
    }

    // ─── SOAP ─────────────────────────────────────────────────────────────────

    data class SoapAction(val service: String, val action: String)

    /**
     * Parse a `SOAPACTION` header value such as
     * `"urn:schemas-upnp-org:service:AVTransport:1#Play"`.
     */
    fun parseSoapActionHeader(header: String?): SoapAction? {
        val cleaned = header?.trim()?.trim('"') ?: return null
        val hash = cleaned.lastIndexOf('#')
        if (hash < 0) return null
        val service = cleaned.substring(0, hash)
        val action = cleaned.substring(hash + 1)
        if (service.isEmpty() || action.isEmpty()) return null
        return SoapAction(service, action)
    }

    /** Build a SOAP envelope wrapping the action response [innerXml]. */
    fun buildSoapEnvelope(serviceType: String, action: String, innerXml: String): String =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
            "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body>" +
            "<u:${action}Response xmlns:u=\"$serviceType\">" +
            innerXml +
            "</u:${action}Response>" +
            "</s:Body>" +
            "</s:Envelope>"

    /** Build a SOAP fault envelope. */
    fun buildSoapFault(errorCode: Int, description: String): String =
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" " +
            "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
            "<s:Body>" +
            "<s:Fault>" +
            "<faultcode>s:Client</faultcode>" +
            "<faultstring>UPnPError</faultstring>" +
            "<detail>" +
            "<UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\">" +
            "<errorCode>$errorCode</errorCode>" +
            "<errorDescription>${escape(description)}</errorDescription>" +
            "</UPnPError>" +
            "</detail>" +
            "</s:Fault>" +
            "</s:Body>" +
            "</s:Envelope>"
}
