package com.bushrangerlabs.canvas_display_edge.snapcast

/**
 * Minimal flat-JSON reader/writer for the Snapcast control protocol.
 *
 * Snapcast's control messages are flat objects of strings, numbers, booleans
 * and nulls, so a dependency-free parser keeps this package testable on the JVM
 * (`org.json` is an Android stub in unit tests).
 */
object SnapJson {

    /** Parse a flat JSON object into a map. Nested objects/arrays are skipped. */
    fun parseObject(json: String): Map<String, Any?> {
        val out = mutableMapOf<String, Any?>()
        var index = json.indexOf('{')
        if (index < 0) return out
        index += 1
        val length = json.length

        while (index < length) {
            index = skipWhitespace(json, index)
            if (index >= length || json[index] == '}') break
            if (json[index] == ',') { index += 1; continue }
            if (json[index] != '"') break

            val keyEnd = findStringEnd(json, index)
            if (keyEnd < 0) break
            val key = unescape(json.substring(index + 1, keyEnd))
            index = skipWhitespace(json, keyEnd + 1)
            if (index >= length || json[index] != ':') break
            index = skipWhitespace(json, index + 1)
            if (index >= length) break

            when (json[index]) {
                '"' -> {
                    val valueEnd = findStringEnd(json, index)
                    if (valueEnd < 0) break
                    out[key] = unescape(json.substring(index + 1, valueEnd))
                    index = valueEnd + 1
                }
                '{', '[' -> {
                    index = skipComposite(json, index)
                }
                else -> {
                    var end = index
                    while (end < length && json[end] != ',' && json[end] != '}') end++
                    val token = json.substring(index, end).trim()
                    out[key] = when (token) {
                        "true" -> true
                        "false" -> false
                        "null" -> null
                        else -> token.toDoubleOrNull() ?: token
                    }
                    index = end
                }
            }
        }
        return out
    }

    /** Serialize a flat map to JSON. Numbers are written without a trailing `.0`. */
    fun writeObject(values: Map<String, Any?>): String =
        values.entries.joinToString(",", "{", "}") { (key, value) ->
            "\"${escape(key)}\":${writeValue(value)}"
        }

    private fun writeValue(value: Any?): String = when (value) {
        null -> "null"
        is Boolean -> value.toString()
        is Int, is Long -> value.toString()
        is Double -> if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()
        is Number -> value.toString()
        else -> "\"${escape(value.toString())}\""
    }

    private fun skipWhitespace(json: String, from: Int): Int {
        var index = from
        while (index < json.length && json[index].isWhitespace()) index++
        return index
    }

    private fun findStringEnd(json: String, start: Int): Int {
        var index = start + 1
        while (index < json.length) {
            when (json[index]) {
                '\\' -> index += 2
                '"' -> return index
                else -> index++
            }
        }
        return -1
    }

    private fun skipComposite(json: String, start: Int): Int {
        var depth = 0
        var index = start
        var inString = false
        while (index < json.length) {
            val c = json[index]
            when {
                inString -> {
                    if (c == '\\') index++
                    else if (c == '"') inString = false
                }
                c == '"' -> inString = true
                c == '{' || c == '[' -> depth++
                c == '}' || c == ']' -> {
                    depth--
                    if (depth == 0) return index + 1
                }
            }
            index++
        }
        return index
    }

    private fun escape(value: String): String = buildString {
        value.forEach { c ->
            when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
            }
        }
    }

    private fun unescape(value: String): String {
        if (!value.contains('\\')) return value
        val out = StringBuilder(value.length)
        var index = 0
        while (index < value.length) {
            val c = value[index]
            if (c != '\\' || index + 1 >= value.length) {
                out.append(c)
                index++
                continue
            }
            when (val next = value[index + 1]) {
                '"' -> { out.append('"'); index += 2 }
                '\\' -> { out.append('\\'); index += 2 }
                '/' -> { out.append('/'); index += 2 }
                'b' -> { out.append('\b'); index += 2 }
                'f' -> { out.append('\u000C'); index += 2 }
                'n' -> { out.append('\n'); index += 2 }
                'r' -> { out.append('\r'); index += 2 }
                't' -> { out.append('\t'); index += 2 }
                'u' -> {
                    val hex = value.substring(index + 2, minOf(index + 6, value.length))
                    val code = hex.toIntOrNull(16)
                    if (code != null) out.append(code.toChar())
                    index += 6
                }
                else -> { out.append(next); index += 2 }
            }
        }
        return out.toString()
    }
}
