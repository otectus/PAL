package dev.otectus.pal.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.protocol.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** Monitoring needs Android's local network permission where Android has one; only the app's screens ask for it. */
internal fun mayMonitor(context: Context) = Build.VERSION.SDK_INT < 37 ||
    ContextCompat.checkSelfPermission(context, "android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED

/** What the tile and the widget may show: whether PAL is connected and how many requests wait. Never a title or text. */
internal data class GlanceState(val paired: Boolean, val ready: Boolean, val monitoring: Boolean, val online: Boolean, val connection: Int, val waiting: Int)
internal fun glance(state: MobileState) = GlanceState(
    paired = state.desktop != null, ready = state.restoreReady, monitoring = state.monitoring,
    online = state.connection is ConnectionState.Online, connection = connectionPresentation(state.connection, state.cursor != null).title,
    // A count from an earlier connection may no longer be true, so it is shown only while connected.
    waiting = if (state.connection is ConnectionState.Online) state.approvals.size else 0,
)

/** Quick Settings: turns monitoring on and off, and opens the Inbox on a long press. It answers nothing and runs nothing. */
class MonitoringTile : TileService() {
    private var scope: CoroutineScope? = null
    private val repository get() = (application as PALApp).repository

    override fun onStartListening() {
        scope?.cancel(); val listening = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate); scope = listening
        listening.launch { repository.state.map(::glance).distinctUntilChanged().collect(::show) }
    }
    override fun onStopListening() { scope?.cancel(); scope = null }
    override fun onDestroy() { scope?.cancel(); scope = null; super.onDestroy() }

    private fun show(state: GlanceState) {
        val tile = qsTile ?: return
        tile.label = getString(R.string.tile_monitoring)
        tile.state = if (!state.paired) Tile.STATE_UNAVAILABLE else if (state.monitoring) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        val text = when {
            !state.paired -> getString(R.string.tile_not_paired)
            !state.monitoring -> getString(R.string.tile_off)
            state.online && state.waiting > 0 -> resources.getQuantityString(R.plurals.glance_waiting, state.waiting, state.waiting)
            else -> getString(state.connection)
        }
        tile.subtitle = text; tile.stateDescription = text
        tile.updateTile()
    }

    override fun onClick() {
        val state = repository.state.value
        if (state.desktop == null) return open()
        if (state.monitoring) { runCatching { startService(Intent(this, MonitoringService::class.java).setAction(MonitoringService.ACTION_STOP)) }; return }
        if (!mayMonitor(this)) return open()
        // Android may refuse a start from here; the app then opens, where it is always allowed.
        runCatching { ContextCompat.startForegroundService(this, Intent(this, MonitoringService::class.java)) }.onFailure { open() }
    }
    @Suppress("DEPRECATION")
    private fun open() {
        val intent = Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_INBOX).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 7, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        else @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated") startActivityAndCollapse(intent)
    }
}

/** The home-screen widget: connection and a count, opening the Inbox. It is offered for the home screen only. */
class StatusWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val state = glance((context.applicationContext as PALApp).repository.state.value)
        ids.forEach { manager.updateAppWidget(it, views(context, state)) }
    }

    internal companion object {
        fun views(context: Context, state: GlanceState): RemoteViews = RemoteViews(context.packageName, R.layout.widget_status).apply {
            setTextViewText(R.id.widget_status, context.getString(when { !state.paired -> R.string.widget_not_paired; !state.ready -> R.string.widget_not_ready; else -> state.connection }))
            val count = when {
                !state.paired || !state.online -> context.getString(R.string.widget_open)
                state.waiting > 0 -> context.resources.getQuantityString(R.plurals.glance_waiting, state.waiting, state.waiting)
                else -> context.getString(R.string.widget_nothing_waiting)
            }
            setTextViewText(R.id.widget_count, count)
            setViewVisibility(R.id.widget_attention, if (state.online && state.waiting > 0) View.VISIBLE else View.GONE)
            setContentDescription(R.id.widget_root, context.getString(R.string.widget_description, context.getString(if (state.paired) state.connection else R.string.widget_not_paired), count))
            setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 8, Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_INBOX)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        }
        fun update(context: Context, state: GlanceState) {
            val manager = AppWidgetManager.getInstance(context) ?: return
            val ids = manager.getAppWidgetIds(ComponentName(context, StatusWidget::class.java))
            if (ids.isNotEmpty()) manager.updateAppWidget(ids, views(context, state))
        }
    }
}

/** A conversation's own home-screen shortcut, which the person asks for; its name is shown there because they chose it. */
internal object PhoneShortcuts {
    private const val PREFIX = "session:"
    fun supported(context: Context) = runCatching { ShortcutManagerCompat.isRequestPinShortcutSupported(context) }.getOrDefault(false)
    /** False when Android or the launcher refused. A conversation whose shortcut was retired with an earlier pairing is enabled again first. */
    fun pin(context: Context, session: Session): Boolean = runCatching {
        val label = session.title.trim().ifEmpty { context.getString(R.string.current_conversation) }
        val intent = Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_SESSION).putExtra(MainActivity.EXTRA_SESSION_ID, session.id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val shortcut = ShortcutInfoCompat.Builder(context, PREFIX + session.id).setShortLabel(label.take(24)).setLongLabel(label.take(60))
            .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_chat)).setIntent(intent).build()
        runCatching { ShortcutManagerCompat.enableShortcuts(context, listOf(shortcut)) }
        ShortcutManagerCompat.requestPinShortcut(context, shortcut, null)
    }.getOrDefault(false)
    /** The launcher's own menu: the Inbox and a new conversation, only while this phone is paired. */
    fun publish(context: Context, paired: Boolean) {
        if (!paired) { ShortcutManagerCompat.removeAllDynamicShortcuts(context); return }
        fun item(id: String, short: Int, long: Int, icon: Int, action: String) = ShortcutInfoCompat.Builder(context, id).setShortLabel(context.getString(short)).setLongLabel(context.getString(long))
            .setIcon(IconCompat.createWithResource(context, icon))
            .setIntent(Intent(context, MainActivity::class.java).setAction(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)).build()
        ShortcutManagerCompat.setDynamicShortcuts(context, listOf(
            item("inbox", R.string.shortcut_inbox, R.string.shortcut_inbox_long, R.drawable.ic_shortcut_inbox, MainActivity.ACTION_OPEN_INBOX),
            item("new", R.string.shortcut_new, R.string.shortcut_new_long, R.drawable.ic_shortcut_new, MainActivity.ACTION_NEW_SESSION),
        ))
    }
    /** When the desktop is forgotten, pinned conversations no longer open anything. */
    fun disableAll(context: Context) {
        val ids = ShortcutManagerCompat.getShortcuts(context, ShortcutManagerCompat.FLAG_MATCH_PINNED).map { it.id }.filter { it.startsWith(PREFIX) }
        if (ids.isNotEmpty()) ShortcutManagerCompat.disableShortcuts(context, ids, context.getString(R.string.shortcut_gone))
    }
}

/** Keeps the widget current while the app runs, and retires pinned conversations with the pairing. */
internal class GlanceUpdates(private val app: PALApp) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    fun start(): Job = scope.launch {
        var paired: Boolean? = null
        app.repository.state.map(::glance).distinctUntilChanged().collect { state ->
            runCatching { StatusWidget.update(app, state) }
            if (state.ready && paired != state.paired) {
                if (paired == true && !state.paired) runCatching { PhoneShortcuts.disableAll(app) }
                runCatching { PhoneShortcuts.publish(app, state.paired) }
                paired = state.paired
            }
        }
    }
}
