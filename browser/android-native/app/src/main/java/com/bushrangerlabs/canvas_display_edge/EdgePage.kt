package com.bushrangerlabs.canvas_display_edge

import org.json.JSONObject
import java.net.URLEncoder

data class EdgePanel(
    val id: String,
    val name: String,
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val url: String,
    val zIndex: Int,
    val visible: Boolean,
    val opacity: Float,
)

data class EdgeFloatingConfig(
    val url: String?,
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
)

data class EdgePage(
    val id: String,
    val panels: List<EdgePanel>,
    val floating: EdgeFloatingConfig?,
    val source: JSONObject,
) {
    companion object {
        fun fromScene(scene: JSONObject, coreUrl: String, deviceId: String = ""): EdgePage {
            val page = scene.optJSONObject("page")
                ?: throw IllegalArgumentException("scene has no page")
            val panelsJson = page.optJSONArray("panels")
                ?: throw IllegalArgumentException("page has no panels")
            val panels = buildList {
                for (index in 0 until panelsJson.length()) {
                    val panel = panelsJson.optJSONObject(index) ?: continue
                    val id = panel.stringValue("id").ifBlank { "panel-$index" }
                    val contentType = panel.stringValue("content_type").ifBlank { "url" }
                    val url = when (contentType) {
                        "scene" -> panel.stringValue("url").ifBlank {
                            panel.stringValue("scene_url").ifBlank {
                                panel.stringValue("scene_id").let { sceneId ->
                                    if (sceneId.isBlank()) "" else {
                                        val base = "${coreUrl.trimEnd('/')}/display/scenes/${encodePathSegment(sceneId)}"
                                        // Tell the scene which display it runs on so media
                                        // widgets target this device for playback.
                                        if (deviceId.isBlank()) base
                                        else "$base?deviceId=${encodePathSegment(deviceId)}"
                                    }
                                }
                            }
                        }
                        else -> panel.stringValue("url")
                    }
                    if (url.isBlank()) continue
                    add(
                        EdgePanel(
                            id = id,
                            name = panel.stringValue("name").ifBlank { id },
                            x = panel.percent("x", 0.0),
                            y = panel.percent("y", 0.0),
                            width = panel.percent("w", 100.0),
                            height = panel.percent("h", 100.0),
                            url = url,
                            zIndex = panel.optInt("z_index", panel.optInt("position", index)),
                            visible = !panel.has("visible") || panel.optBoolean("visible", true),
                            opacity = panel.optDouble("opacity", 1.0).coerceIn(0.0, 1.0).toFloat(),
                        ),
                    )
                }
            }.sortedBy { it.zIndex }
            if (panels.isEmpty()) throw IllegalArgumentException("page has no renderable panels")
            val floatingJson = page.optJSONObject("floating_config")
            val floating = floatingJson?.let {
                EdgeFloatingConfig(
                    url = it.stringValue("url").ifBlank { null },
                    x = it.percent("x", 10.0),
                    y = it.percent("y", 10.0),
                    width = it.percent("w", 80.0),
                    height = it.percent("h", 80.0),
                )
            }
            return EdgePage(
                id = page.stringValue("id").ifBlank {
                    page.stringValue("page_id").ifBlank { scene.stringValue("revision_id") }
                },
                panels = panels,
                floating = floating,
                source = JSONObject(page.toString()),
            )
        }

        fun fromStored(page: JSONObject, coreUrl: String): EdgePage =
            fromScene(JSONObject().put("page", page), coreUrl)
    }
}

private fun encodePathSegment(value: String): String =
    URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

private fun JSONObject.stringValue(key: String): String {
    val value = opt(key)
    return if (value == null || value == JSONObject.NULL) "" else value.toString().takeUnless { it == "null" }.orEmpty()
}

private fun JSONObject.percent(key: String, fallback: Double): Double =
    optDouble(key, fallback).takeIf { it.isFinite() }?.coerceIn(0.0, 100.0) ?: fallback
