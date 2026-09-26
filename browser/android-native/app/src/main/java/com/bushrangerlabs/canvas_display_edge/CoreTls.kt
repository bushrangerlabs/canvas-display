package com.bushrangerlabs.canvas_display_edge

import okhttp3.OkHttpClient

object CoreTls {
    // Android's default trust manager applies network_security_config, just as WebView does.
    // Keep OkHttp's default hostname verifier; a trusted certificate still needs a matching SAN.
    fun client(): OkHttpClient.Builder = OkHttpClient.Builder()
}
