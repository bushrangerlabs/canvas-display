package com.bushrangerlabs.canvas_display_edge

import android.content.Context
import org.json.JSONObject

class EdgePageStore(context: Context) {
    private val prefs = context.getSharedPreferences("edge-page-cache", Context.MODE_PRIVATE)

    fun save(page: EdgePage) {
        prefs.edit()
            .putString("page_json", page.source.toString())
            .putString("page_id", page.id)
            .putLong("cached_at", System.currentTimeMillis())
            .apply()
    }

    fun load(coreUrl: String): EdgePage? {
        val raw = prefs.getString("page_json", null) ?: return null
        return runCatching { EdgePage.fromStored(JSONObject(raw), coreUrl) }.getOrNull()
    }
}
