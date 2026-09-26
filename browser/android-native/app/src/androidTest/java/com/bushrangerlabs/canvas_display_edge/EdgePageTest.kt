package com.bushrangerlabs.canvas_display_edge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgePageTest {
    @Test fun parsesEveryPanelAndPreservesGeometryOrderVisibilityAndOpacity() {
        val page = JSONObject()
            .put("id", "dashboard")
            .put("panels", JSONArray()
                .put(panel("top", "https://example.test/top", 50.0, 0.0, 50.0, 25.0, 20, true, 0.4))
                .put(panel("back", "https://example.test/back", 0.0, 0.0, 50.0, 100.0, 1, false, 1.0)))
            .put("floating_config", JSONObject().put("x", 5).put("y", 10).put("w", 90).put("h", 70))
        val parsed = EdgePage.fromScene(JSONObject().put("revision_id", "r1").put("page", page), "https://core.test")

        assertEquals("dashboard", parsed.id)
        assertEquals(listOf("back", "top"), parsed.panels.map { it.id })
        assertFalse(parsed.panels[0].visible)
        assertEquals(50.0, parsed.panels[1].x, 0.0)
        assertEquals(25.0, parsed.panels[1].height, 0.0)
        assertEquals(0.4f, parsed.panels[1].opacity, 0f)
        assertEquals(90.0, parsed.floating!!.width, 0.0)
    }

    @Test fun resolvesScenePanelsAgainstCoreAndClampsUnsafeGeometry() {
        val scenePanel = JSONObject()
            .put("id", "scene")
            .put("content_type", "scene")
            .put("scene_id", "scene id")
            .put("x", -5)
            .put("y", 200)
            .put("w", 150)
            .put("h", 0)
        val parsed = EdgePage.fromScene(
            JSONObject().put("page", JSONObject().put("panels", JSONArray().put(scenePanel))),
            "https://core.test/",
        )

        assertEquals("https://core.test/display/scenes/scene%20id", parsed.panels.single().url)
        assertEquals(0.0, parsed.panels.single().x, 0.0)
        assertEquals(100.0, parsed.panels.single().y, 0.0)
        assertEquals(100.0, parsed.panels.single().width, 0.0)
    }

    @Test fun rejectsPagesWithoutRenderablePanels() {
        val error = assertThrows(IllegalArgumentException::class.java) {
            EdgePage.fromScene(
                JSONObject().put("page", JSONObject().put("panels", JSONArray().put(JSONObject().put("id", "empty")))),
                "https://core.test",
            )
        }
        assertTrue(error.message!!.contains("renderable"))
    }

    @Test fun storedPageRoundTripsThroughTheSameParser() {
        val source = JSONObject().put("id", "cached").put(
            "panels",
            JSONArray().put(panel("one", "https://example.test", 0.0, 0.0, 100.0, 100.0, 0, true, 1.0)),
        )
        val parsed = EdgePage.fromStored(JSONObject(source.toString()), "https://core.test")
        assertEquals("cached", parsed.id)
        assertEquals("one", parsed.panels.single().id)
    }

    private fun panel(
        id: String,
        url: String,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        z: Int,
        visible: Boolean,
        opacity: Double,
    ) = JSONObject()
        .put("id", id)
        .put("url", url)
        .put("x", x)
        .put("y", y)
        .put("w", width)
        .put("h", height)
        .put("z_index", z)
        .put("visible", visible)
        .put("opacity", opacity)
}
