package com.bushrangerlabs.canvas_display_edge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * A minimal foreground service that keeps the Canvas Edge process at foreground
 * priority while [MainActivity] is hidden to the background (so the Core WebSocket
 * stays alive and "fast resume" works). It is also the component that can
 * legitimately bring the activity back to the foreground, because foreground
 * services are exempt from Android's background-activity-launch restrictions.
 *
 * Started on device boot ([BootReceiver]), on every activity launch ([MainActivity])
 * and whenever Core requests "show". It never hosts the WebSocket itself — that
 * stays in [MainActivity] — it only guarantees the process survives and can raise
 * the activity.
 */
class KioskService : Service() {

    companion object {
        const val ACTION_BOOT = "com.bushrangerlabs.canvas_display_edge.action.BOOT"
        const val ACTION_SHOW = "com.bushrangerlabs.canvas_display_edge.action.SHOW"
        private const val CHANNEL_ID = "canvas_edge_kiosk"
        private const val NOTIFICATION_ID = 1
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        // BOOT / SHOW / a sticky restart should all end with the kiosk activity on top.
        bringToFront()
        return START_STICKY
    }

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ requires an explicit foreground service type.
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun bringToFront() {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        startActivity(intent)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Canvas Edge kiosk",
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = "Keeps the Canvas Edge display ready"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Canvas Edge")
            .setContentText("Display ready")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }
}