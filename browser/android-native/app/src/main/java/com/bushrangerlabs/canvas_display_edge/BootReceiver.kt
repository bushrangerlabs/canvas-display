package com.bushrangerlabs.canvas_display_edge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the foreground kiosk service on device boot so the Canvas Edge display
 *  (and its Core connection) comes up without any user interaction. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val service =
                Intent(context, KioskService::class.java).setAction(KioskService.ACTION_BOOT)
            try {
                context.startForegroundService(service)
            } catch (error: Throwable) {
                android.util.Log.w("CanvasEdge", "Boot FGS start failed: ${error.message}")
            }
        }
    }
}