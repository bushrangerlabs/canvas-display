package com.bushrangerlabs.canvas_display_edge

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build

class CoreDiscovery(context: Context) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var listener: NsdManager.DiscoveryListener? = null
    private val fallbackHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var fallback: Runnable? = null

    fun discover(onFound: (coreUrl: String, homeAssistantUrl: String?) -> Unit, onError: (String) -> Unit) {
        // Docker bridge networking can hide mDNS multicast from the LAN. Keep
        // discovery first, then use the configured deployment's LAN endpoint so
        // a first-run Edge is still zero-input on this network.
        fallback = Runnable { onFound("https://192.168.1.108:3100", null) }
        fallbackHandler.postDelayed(fallback!!, 8_000)
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = onError("mDNS discovery failed: $errorCode")
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (serviceInfo.serviceType != "_canvas-core._tcp.") return
                nsd.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = onError("Core resolve failed: $errorCode")
                    override fun onServiceResolved(info: NsdServiceInfo) {
                        val host = info.host.hostAddress ?: return
                        val https = info.attributes["https"]?.toString() == "true"
                        val scheme = if (https) "https" else "http"
                        val ha = info.attributes["ha_url"]?.toString()?.takeIf { it.isNotBlank() }
                        stop()
                        onFound("$scheme://$host:${info.port}", ha)
                    }
                })
            }
        }
        listener = discovery
        nsd.discoverServices("_canvas-core._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery)
    }

    fun stop() {
        fallback?.let { fallbackHandler.removeCallbacks(it) }
        fallback = null
        listener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        listener = null
    }
}
