package dev.otectus.pal.mobile

import android.app.BroadcastOptions
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import dev.otectus.pal.mobile.data.DesktopNotice
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.WakeState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** A push app on this phone (a UnifiedPush distributor). */
internal class PushApp(val packageName: String, val label: String)

/**
 * Optional wake-ups through a push app the person chooses (UnifiedPush). A push message carries no request, answer or
 * text: it only tells this phone to connect, where sign-in, scope and review are what they always are.
 */
internal object WakeUps {
    const val REGISTER = "org.unifiedpush.android.distributor.REGISTER"
    const val UNREGISTER = "org.unifiedpush.android.distributor.UNREGISTER"
    const val MESSAGE_ACK = "org.unifiedpush.android.distributor.MESSAGE_ACK"
    const val NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT"
    const val REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED"
    const val MESSAGE = "org.unifiedpush.android.connector.MESSAGE"
    const val UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED"
    const val TEMP_UNAVAILABLE = "org.unifiedpush.android.connector.TEMP_UNAVAILABLE"

    fun apps(context: Context): List<PushApp> = context.packageManager.queryBroadcastReceivers(Intent(REGISTER), 0)
        .mapNotNull { it.activityInfo?.packageName }.distinct().filter { it != context.packageName }
        .map { name -> PushApp(name, runCatching { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(name, 0)).toString() }.getOrDefault(name)) }
        .sortedBy { it.label.lowercase() }
    fun label(context: Context, packageName: String) = apps(context).firstOrNull { it.packageName == packageName }?.label ?: packageName

    /** Turns wake-ups on through [app]: new keys, then a request to it for an address. */
    suspend fun start(context: Context, repository: PALRepository, app: PushApp) {
        stop(context, repository)
        val sender = repository.wakeSenderKey()
        register(context, repository.beginWake(app.packageName), sender)
    }
    suspend fun stop(context: Context, repository: PALRepository) { repository.stopWake()?.let { wake -> send(context, wake.distributor, Intent(UNREGISTER).putExtra("token", wake.token)) } }
    fun register(context: Context, wake: WakeState, senderKey: String?) = send(context, wake.distributor, Intent(REGISTER).putExtra("token", wake.token)
        .putExtra("message", context.getString(R.string.wake_registration)).apply { if (senderKey != null) putExtra("vapid", senderKey) })
    fun acknowledge(context: Context, distributor: String, token: String, id: String?) { if (!id.isNullOrEmpty() && id.length <= 100) send(context, distributor, Intent(MESSAGE_ACK).putExtra("token", token).putExtra("id", id)) }

    /** The push app learns which app asks through Android: the shared identity, or before Android 14 a marked intent. */
    private fun send(context: Context, distributor: String, intent: Intent) {
        intent.setPackage(distributor).addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
        if (Build.VERSION.SDK_INT >= 34) context.sendBroadcast(intent, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
        else context.sendBroadcast(intent.putExtra("pi", PendingIntent.getBroadcast(context, 0, Intent().setPackage("org.unifiedpush.dummy_app"), PendingIntent.FLAG_IMMUTABLE)))
    }

    /** Shows what a wake-up found, exactly as monitoring would. */
    fun announce(context: Context, news: PALRepository.WakeNews) {
        val manager = context.getSystemService(NotificationManager::class.java)
        news.approvals.forEach { manager.notify(PALNotifications.approvalId(it.id), PALNotifications.approval(context, it)) }
        news.finished.forEach { session ->
            val kind = when (session.status) { "error" -> "error"; "interrupted" -> "interrupted"; "idle" -> "complete"; else -> return@forEach }
            PALNotifications.notice(context, DesktopNotice(kind, session.id, session.title))?.let { (id, notification) -> manager.notify(id, notification) }
        }
    }
}

/**
 * Where the chosen push app answers. Any app can send here, so a message counts only with this phone's registration
 * token, and a hint only when it opens with this phone's keys.
 */
class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val extras: Bundle = intent.extras ?: return
        val token = runCatching { extras.getString("token") }.getOrNull()?.takeIf { it.length in 1..100 } ?: return
        val app = context.applicationContext as PALApp; val repository = app.repository
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try { withTimeoutOrNull(LIMIT_MS) { handle(app, repository, intent.action, extras, token) } }
            catch (_: Exception) { }
            finally { pending.finish() }
        }
    }

    private suspend fun handle(app: PALApp, repository: PALRepository, action: String?, extras: Bundle, token: String) {
        val known = repository.wakeRegistration()?.takeIf { it.token == token } ?: return
        when (action) {
            WakeUps.NEW_ENDPOINT -> {
                WakeUps.acknowledge(app, known.distributor, token, extras.getString("id"))
                extras.getString("endpoint")?.let { repository.wakeEndpoint(token, it) }
            }
            WakeUps.MESSAGE -> {
                WakeUps.acknowledge(app, known.distributor, token, extras.getString("id"))
                val message = extras.getByteArray("bytesMessage") ?: return
                if (!repository.acceptWakeHint(token, message)) return
                repository.wake()?.let { news -> PALNotifications.ensureChannels(app); WakeUps.announce(app, news) }
            }
            WakeUps.REGISTRATION_FAILED -> if (known.endpoint == null) repository.wakeProblem(token, app.getString(when (extras.getString("reason")) {
                "NETWORK" -> R.string.wake_failed_network
                "ACTION_REQUIRED" -> R.string.wake_failed_action
                "VAPID_REQUIRED" -> R.string.wake_failed_key
                else -> R.string.wake_failed
            }))
            WakeUps.UNREGISTERED -> repository.wakeProblem(token, app.getString(R.string.wake_ended))
            WakeUps.TEMP_UNAVAILABLE -> repository.wakeProblem(token, app.getString(R.string.wake_unavailable), refused = false)
        }
    }

    private companion object { const val LIMIT_MS = 9_500L }
}

/** A push app binds to this for a few seconds so Android lets PAL connect; it offers nothing to call. */
class WakeForegroundService : Service() {
    private val binder = Binder()
    override fun onBind(intent: Intent?): IBinder = binder
}
