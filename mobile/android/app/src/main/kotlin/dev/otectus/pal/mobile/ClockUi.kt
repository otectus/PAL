package dev.otectus.pal.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Resources
import android.os.SystemClock
import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.otectus.pal.mobile.data.ClientTime
import dev.otectus.pal.mobile.data.ClockReading
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.ElapsedResult
import dev.otectus.pal.mobile.protocol.Session
import dev.otectus.pal.mobile.protocol.TimeSnapshot
import dev.otectus.pal.mobile.protocol.WireCodec
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** Time of day in [zone]; [format] is the owner's display choice ("12h", "24h"), otherwise this phone's own convention. */
internal fun clockTime(context: Context, instantMs: Long, zone: ZoneId, format: String?): String {
    val twentyFour = when (format) { "12h" -> false; "24h" -> true; else -> DateFormat.is24HourFormat(context) }
    val locale = context.resources.configuration.locales[0]
    return DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, if (twentyFour) "Hm" else "hma"), locale)
        .format(Instant.ofEpochMilli(instantMs).atZone(zone))
}
internal fun clockDate(context: Context, instantMs: Long, zone: ZoneId): String {
    val locale = context.resources.configuration.locales[0]
    return DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, "EEEEdMMMMy"), locale).format(Instant.ofEpochMilli(instantMs).atZone(zone))
}
/** "America/New_York (UTC−05:00)": the name in full with its offset at that moment, never an abbreviation. */
internal fun clockZone(instantMs: Long, zone: ZoneId): String {
    val seconds = zone.rules.getOffset(Instant.ofEpochMilli(instantMs)).totalSeconds
    return "%s (UTC%s%02d:%02d)".format(Locale.ROOT, zone.id, if (seconds < 0) "−" else "+", abs(seconds) / 3600, abs(seconds) / 60 % 60)
}
/** A length in words, to the minute. */
internal fun clockDuration(resources: Resources, ms: Long): String {
    val minutes = ms.coerceAtLeast(0) / 60_000
    val hours = minutes / 60
    val days = hours / 24
    fun minutes(value: Long) = resources.getQuantityString(R.plurals.clock_minutes, value.toInt(), value.toInt())
    fun hours(value: Long) = resources.getQuantityString(R.plurals.clock_hours, value.toInt(), value.toInt())
    fun join(first: String, second: String?) = if (second == null) first else resources.getString(R.string.clock_two_units, first, second)
    return when {
        minutes < 60 -> minutes(minutes)
        hours < 48 -> join(hours(hours), (minutes % 60).takeIf { it > 0 }?.let(::minutes))
        else -> join(resources.getQuantityString(R.plurals.clock_days, days.toInt(), days.toInt()), (hours % 24).takeIf { it > 0 }?.let(::hours))
    }
}
internal fun clockElapsed(resources: Resources, result: ElapsedResult?): String {
    val duration = result?.durationMs
    return when {
        result?.status == "inconsistent" -> resources.getString(R.string.clock_inconsistent)
        result?.status != "available" || duration == null -> resources.getString(R.string.clock_not_recorded)
        duration < 60_000 -> resources.getString(R.string.clock_moment_ago)
        else -> resources.getString(if (result.reason == "clock_jump_or_sleep_during_interval") R.string.clock_about_ago_jump else R.string.clock_about_ago, clockDuration(resources, duration))
    }
}
private fun zoneText(owner: ClientTime.ZoneOwner) = when (owner) {
    ClientTime.ZoneOwner.Conversation -> R.string.clock_zone_conversation
    ClientTime.ZoneOwner.Fixed -> R.string.clock_zone_fixed
    ClientTime.ZoneOwner.Phone -> R.string.clock_zone_phone
    ClientTime.ZoneOwner.Desktop -> R.string.clock_zone_desktop
    ClientTime.ZoneOwner.Utc -> R.string.clock_zone_utc
    ClientTime.ZoneOwner.Chosen -> R.string.clock_zone_chosen
}

/** Restarts [key] whenever this phone's time, date or zone is changed, so no display outlives what it was based on. */
@Composable
internal fun rememberClockChanges(): Int {
    val context = LocalContext.current
    var changes by remember { mutableIntStateOf(0) }
    DisposableEffect(context) {
        val receiver = object : BroadcastReceiver() { override fun onReceive(context: Context, intent: Intent) { changes++ } }
        ContextCompat.registerReceiver(context, receiver, IntentFilter().apply {
            addAction(Intent.ACTION_TIMEZONE_CHANGED); addAction(Intent.ACTION_TIME_CHANGED); addAction(Intent.ACTION_DATE_CHANGED)
        }, ContextCompat.RECEIVER_NOT_EXPORTED)
        onDispose { context.unregisterReceiver(receiver) }
    }
    return changes
}

/**
 * The desktop's clock for one conversation, and that conversation's own zone. The desktop's reading is shown between
 * checks on this phone's interval clock, expires, and is replaced when the app returns or a clock changes. A phone that
 * is offline, or an older desktop, shows this phone's clock and says so.
 */
@Composable
internal fun ClockSheet(repository: PALRepository, state: MobileState, session: Session, close: () -> Unit) {
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current
    val online = state.connection is ConnectionState.Online
    val shared = state.has(ClientTime.FEATURE) && state.supports("time.now")
    val changes = rememberClockChanges()
    var reading by remember(session.id) { mutableStateOf<ClockReading?>(null) }
    var elapsed by remember(session.id) { mutableStateOf(emptyMap<String, ElapsedResult>()) }
    var tick by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    var refresh by remember { mutableIntStateOf(0) }
    var choosing by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(changes) { reading = null }
    LaunchedEffect(lifecycle, session.id, shared, online, refresh, changes, session.timeZone) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (shared && online) {
                try {
                    val asked = SystemClock.elapsedRealtime()
                    val sample = WireCodec.json.decodeFromJsonElement(TimeSnapshot.serializer(), repository.read("time.now", buildJsonObject { put("sessionId", session.id) }))
                    val received = SystemClock.elapsedRealtime()
                    reading = ClockReading(sample, received, received - asked); tick = received; error = null
                    if (state.supports("time.elapsed")) elapsed = listOf("session_created", "previous_user_message", "previous_assistant_reply").associateWith { anchor ->
                        WireCodec.json.decodeFromJsonElement(ElapsedResult.serializer(), repository.read("time.elapsed", buildJsonObject { put("sessionId", session.id); put("anchor", anchor) }))
                    }
                } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message }
                delay(ClockReading.REFRESH_MS)
            }
        }
    }
    // The shown minute moves on by itself only while it can be seen.
    LaunchedEffect(lifecycle, reading) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                tick = SystemClock.elapsedRealtime()
                val shown = reading?.instantAt(tick) ?: System.currentTimeMillis()
                delay(60_000 - Math.floorMod(shown, 60_000L) + 100)
            }
        }
    }
    fun setZone(zone: String?) {
        busy = true; error = null; feedback = null
        scope.launch {
            try {
                repository.mutate("sessions.timeZone", buildJsonObject { put("sessionId", session.id); put("timeZone", zone?.let(::JsonPrimitive) ?: JsonNull); put("expectedConfigRevision", session.configRevision) }, session.title)
                repository.selectSession(session.id)
                feedback = zone?.let { resources.getString(R.string.clock_zone_set, it) } ?: resources.getString(R.string.clock_zone_cleared)
                refresh++
            } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } finally { busy = false }
        }
    }
    AncillarySheetScaffold(title = stringResource(R.string.clock_title), subtitle = session.title, busy = busy, onDismiss = close) {
        ClockContent(state, session, reading, elapsed, tick, online, shared, busy,
            choose = { choosing = true }.takeIf { state.supports("sessions.timeZone") }, useDefault = { setZone(null) })
        feedback?.let { AncillaryFeedback(it) }
        error?.let { AncillaryFeedback(it, error = true) }
    }
    if (choosing) ZonePickerDialog(session.timeZone, { choosing = false }) { zone -> choosing = false; setZone(zone) }
}

/** What the clock shows, apart from how it is fetched, so every state can be checked. */
@Composable
internal fun ColumnScope.ClockContent(state: MobileState, session: Session, reading: ClockReading?, elapsed: Map<String, ElapsedResult>, tick: Long,
    online: Boolean, shared: Boolean, busy: Boolean, choose: (() -> Unit)?, useDefault: () -> Unit, phoneMs: Long = System.currentTimeMillis(), phoneZone: ZoneId = ZoneId.systemDefault()) {
    val context = LocalContext.current
    val resources = LocalResources.current
    val format = state.settings.obj("time")?.str("clockFormat")
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    AncillarySection(stringResource(R.string.clock_source), stringResource(R.string.clock_source_detail).takeIf { shared }) {
        if (online && !shared) Text(stringResource(R.string.clock_update_desktop))
        val current = reading?.currentAt(tick, online) == true
        if (reading != null && current) {
            val instant = reading.instantAt(tick)
            val (zone, owner) = ClientTime.zoneFor(reading.sample, phoneZone.id)
            val time = clockTime(context, instant, zone, format); val date = clockDate(context, instant, zone)
            Column(Modifier.clearAndSetSemantics { contentDescription = "$time, $date, ${zone.id}" }) {
                Text(time, style = MaterialTheme.typography.headlineLarge)
                Text(date, style = MaterialTheme.typography.titleMedium)
            }
            Text(stringResource(zoneText(owner), clockZone(instant, zone)), style = MaterialTheme.typography.bodySmall, color = muted)
            when (reading.sample.clockStatus) {
                "discontinuity-observed" -> Text(stringResource(R.string.clock_jumped), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
                "unknown" -> Text(stringResource(R.string.clock_unusable), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            reading.differenceAt(tick, phoneMs)?.let { difference ->
                Text(stringResource(if (difference > 0) R.string.clock_phone_ahead else R.string.clock_phone_behind, clockDuration(resources, abs(difference))), style = MaterialTheme.typography.bodySmall, color = muted)
            }
        } else if (reading != null) {
            val (zone, _) = ClientTime.zoneFor(reading.sample, phoneZone.id)
            Text(stringResource(R.string.clock_last_check, clockTime(context, reading.sample.sampledAtMs, zone, format), clockDate(context, reading.sample.sampledAtMs, zone)), color = MaterialTheme.colorScheme.tertiary)
        } else if (online && shared) Text(stringResource(R.string.clock_reading), color = muted)
        if (!current) Text(stringResource(R.string.clock_phone, clockTime(context, phoneMs, phoneZone, format), clockDate(context, phoneMs, phoneZone)), color = muted)
    }
    if (shared) {
        AncillarySection(stringResource(R.string.clock_conversation), stringResource(R.string.clock_conversation_detail)) {
            listOf(R.string.clock_started to "session_created", R.string.clock_previous_message to "previous_user_message", R.string.clock_last_reply to "previous_assistant_reply").forEach { (label, anchor) ->
                Column { Text(stringResource(label), style = MaterialTheme.typography.bodySmall, color = muted); Text(clockElapsed(resources, elapsed[anchor])) }
            }
        }
        AncillarySection(stringResource(R.string.clock_zone_heading), stringResource(R.string.clock_zone_hint)) {
            Text(session.timeZone ?: stringResource(R.string.clock_zone_default))
            if (choose != null) {
                OutlinedButton(choose, Modifier.fillMaxWidth().heightIn(min = PALLayout.target), enabled = online && !busy) { Text(stringResource(R.string.clock_zone_choose)) }
                if (session.timeZone != null) TextButton(useDefault, Modifier.heightIn(min = PALLayout.target), enabled = online && !busy) { Text(stringResource(R.string.clock_zone_use_default)) }
            }
        }
    }
}

/** Every zone by name, with this phone's own first; each row shows its offset now. */
@Composable
internal fun ZonePickerDialog(selected: String?, dismiss: () -> Unit, phoneZone: String = TimeZone.getDefault().id, choose: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val zones = remember { ClientTime.choices() }
    val matches = remember(query) { ClientTime.search(query, zones) }
    val now = remember { System.currentTimeMillis() }
    AlertDialog(dismiss, title = { Text(stringResource(R.string.clock_zone_choose)) }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            OutlinedTextField(query, { query = it.take(128) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.clock_zone_search)) })
            if (query.isBlank() && phoneZone in zones) TextButton({ choose(phoneZone) }, Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.clock_zone_this_phone, phoneZone)) }
            if (matches.isEmpty()) Text(stringResource(R.string.clock_zone_none))
            LazyColumn(Modifier.heightIn(max = PALLayout.previewHeight)) {
                items(matches, key = { it }) { zone ->
                    val offset = remember(zone) { runCatching { ZoneId.of(zone).rules.getOffset(Instant.ofEpochMilli(now)) }.getOrDefault(ZoneOffset.UTC) }
                    ListItem(headlineContent = { Text(zone.replace('_', ' ')) }, trailingContent = { Text(if (offset == ZoneOffset.UTC) "UTC" else "UTC${offset.id.replace('-', '−')}", style = MaterialTheme.typography.labelMedium) },
                        modifier = Modifier.clickable(role = Role.Button) { choose(zone) },
                        colors = if (zone == selected) ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.secondaryContainer) else ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh))
                }
            }
        }
    }, confirmButton = { TextButton(dismiss) { Text(stringResource(R.string.clock_cancel)) } })
}
