package com.bushrangerlabs.canvas_display_edge

import android.content.Context

class EdgeConfig(context: Context) {
    private val prefs = context.getSharedPreferences("edge-config", Context.MODE_PRIVATE)

    var coreUrl: String
        get() = prefs.getString("core_url", "") ?: ""
        set(value) = prefs.edit().putString("core_url", value.trim().trimEnd('/')).apply()

    var homeAssistantUrl: String
        get() = prefs.getString("ha_url", "") ?: ""
        set(value) = prefs.edit().putString("ha_url", value.trim().trimEnd('/')).apply()

    var homeAssistantToken: String
        get() = prefs.getString("ha_token", "") ?: ""
        set(value) = prefs.edit().putString("ha_token", value.trim()).apply()

    var deviceName: String
        get() = prefs.getString("device_name", "Android Edge") ?: "Android Edge"
        set(value) = prefs.edit().putString("device_name", value.trim()).apply()

    var invitationToken: String
        get() = prefs.getString("invitation_token", "") ?: ""
        set(value) = prefs.edit().putString("invitation_token", value.trim()).apply()

    var credentialJson: String
        get() = prefs.getString("credential_json", "") ?: ""
        set(value) = prefs.edit().putString("credential_json", value).apply()

    // ── Voice pipeline cache ───────────────────────────────────────────────────
    // These are NEVER user-editable on-device — all edge device settings are
    // configured via Core's admin UI (PUT /api/admin/devices/:id/voice) and fetched
    // by VoiceConfigClient. Persisted here only so the last-known config survives
    // an app restart while offline; always overwritten on the next successful fetch.
    var voiceEnabled: Boolean
        get() = prefs.getBoolean("voice_enabled", false)
        set(value) = prefs.edit().putBoolean("voice_enabled", value).apply()

    var edgeVoiceToken: String
        get() = prefs.getString("edge_voice_token", "") ?: ""
        set(value) = prefs.edit().putString("edge_voice_token", value.trim()).apply()

    var wakeWord: String
        get() = prefs.getString("wake_word", "hey_jarvis") ?: "hey_jarvis"
        set(value) = prefs.edit().putString("wake_word", value.trim()).apply()

    var wakeThreshold: Float
        get() = prefs.getFloat("wake_threshold", 0.5f)
        set(value) = prefs.edit().putFloat("wake_threshold", value.coerceIn(0f, 1f)).apply()

    // Core can provide scene URLs directly; HA credentials are optional for a
    // Core-native Edge and must not block zero-configuration startup.
    val configured: Boolean get() = coreUrl.isNotBlank()

    // ── Snapcast (multi-room synchronised audio) ───────────────────────────────
    // The snapserver bundled with Music Assistant runs on the Core host, so the
    // default host is derived from the Core URL when none is set explicitly.
    var snapcastHost: String
        get() = prefs.getString("snapcast_host", "") ?: ""
        set(value) = prefs.edit().putString("snapcast_host", value.trim()).apply()

    var snapcastPort: Int
        get() = prefs.getInt("snapcast_port", 1704)
        set(value) = prefs.edit().putInt("snapcast_port", value).apply()

    var snapcastEnabled: Boolean
        get() = prefs.getBoolean("snapcast_enabled", true)
        set(value) = prefs.edit().putBoolean("snapcast_enabled", value).apply()

    /** Host to connect the Snapcast client to, or null when it cannot be resolved. */
    val resolvedSnapcastHost: String?
        get() = snapcastHost.ifBlank {
            coreUrl.removePrefix("https://").removePrefix("http://").substringBefore('/').substringBefore(':')
        }.takeIf { it.isNotBlank() }
}
