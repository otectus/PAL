package dev.otectus.pal.mobile

import android.app.*
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.IBinder
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.OfflineKind
import dev.otectus.pal.mobile.protocol.Approval
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class MonitoringService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val repository get() = (application as PALApp).repository
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { repository.networkAvailable() }
        override fun onLost(network: Network) { repository.networkLost(network) }
    }
    // Approval ID → digest already announced. A request alerts once; a changed request alerts again.
    private var announced = mapOf<String, String>()
    private var lastStatus: String? = null

    override fun onCreate() {
        super.onCreate()
        PALNotifications.ensureChannels(this)
        startForeground(PALNotifications.MONITORING_ID, PALNotifications.monitoring(this, getString(R.string.connection_connecting)))
        getSystemService(ConnectivityManager::class.java).requestNetwork(NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .build(), networkCallback)
        repository.startMonitoring()
        val manager = getSystemService(NotificationManager::class.java)
        scope.launch {
            repository.state.map { getString(connectionPresentation(it.connection, it.cursor != null).title) to it.approvals }.distinctUntilChanged().collect { (text, approvals) ->
                if (text != lastStatus) { lastStatus = text; manager.notify(PALNotifications.MONITORING_ID, PALNotifications.monitoring(this@MonitoringService, text)) }
                val current = approvals.associate { it.id to it.digest }
                announced.keys.filterNot(current::containsKey).forEach { manager.cancel(PALNotifications.approvalId(it)) }
                approvals.filter { announced[it.id] != it.digest }.forEach { manager.notify(PALNotifications.approvalId(it.id), PALNotifications.approval(this@MonitoringService, it)) }
                announced = current
            }
        }
        scope.launch {
            repository.notices.collect { notice ->
                if (notice.kind != "timer" && repository.isShowing(notice.sessionId)) return@collect
                PALNotifications.notice(this@MonitoringService, notice)?.let { (id, notification) -> manager.notify(id, notification) }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
        return START_STICKY
    }

    override fun onDestroy() {
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        scope.cancel()
        // Background monitoring ends; the app keeps its own connection while it is on screen.
        repository.backgroundMonitoringStopped()
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object { const val ACTION_STOP = "dev.otectus.pal.mobile.STOP_MONITORING" }
}

/** Denies from the notification. Bounded to the broadcast time budget; an unconfirmed deny says so. */
class DenyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val approvalId = intent.getStringExtra("approvalId") ?: return
        val pending = goAsync(); val repository = (context.applicationContext as PALApp).repository
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            var approval: Approval? = null
            try {
                approval = withTimeoutOrNull(4_000) { repository.state.first { state -> state.supports("approvals.answer") && state.approvals.any { it.id == approvalId } }.approvals.first { it.id == approvalId } }
                    ?: repository.state.value.approvals.firstOrNull { it.id == approvalId }
                val target = approval ?: return@launch
                if (!repository.state.value.supports("approvals.answer") || "deny" !in target.choices) { report(context, target, context.getString(R.string.monitor_deny_needs_the_desktop_connection)); return@launch }
                // A slow desktop still receives the answer; PAL reconciles its outcome after this returns.
                val outcome = withTimeoutOrNull(4_500) { runCatching { repository.mutate("approvals.answer", buildJsonObject {
                    put("approvalId", target.id); put("revision", target.revision); put("digest", target.digest); put("choice", "deny"); put("answers", buildJsonObject {})
                }) } }
                if (outcome == null || outcome.isFailure) report(context, target, context.getString(R.string.monitor_deny_not_confirmed_yet))
            } finally { pending.finish() }
        }
    }

    private fun report(context: Context, approval: Approval, problem: String) {
        runCatching { context.getSystemService(NotificationManager::class.java).notify(PALNotifications.approvalId(approval.id), PALNotifications.approval(context, approval, problem)) }
    }
}
