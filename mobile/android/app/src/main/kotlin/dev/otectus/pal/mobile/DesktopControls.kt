@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.graphics.asImageBitmap
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.protocol.Project
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.flag(key: String) = (this[key] as? JsonPrimitive)?.booleanOrNull == true

/**
 * Desktop controls for one approved project. Each list loads on its own, so a category
 * that is off on the desktop hides only its own section. Every action names the desktop
 * and project it runs on and is signed like any other desktop action.
 */
@Composable
internal fun DesktopScreen(repository: PALRepository, state: MobileState, activity: FragmentActivity) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    var refreshRequest by remember { mutableIntStateOf(0) }
    var projectId by rememberSaveable { mutableStateOf(state.projects.firstOrNull()?.id.orEmpty()) }
    var status by remember(projectId, state.cacheEpoch) { mutableStateOf<JsonObject?>(null) }
    var apps by remember(projectId, state.cacheEpoch) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var windows by remember(projectId, state.cacheEpoch) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var sectionErrors by remember(projectId, state.cacheEpoch) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var loading by remember { mutableStateOf(false) }
    var pendingAction by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var volume by remember(projectId, state.cacheEpoch) { mutableStateOf<Float?>(null) }
    var moving by remember(projectId, state.cacheEpoch) { mutableStateOf<JsonObject?>(null) }
    var reviewingScript by remember(projectId, state.cacheEpoch) { mutableStateOf<JsonObject?>(null) }
    var workspace by rememberSaveable { mutableStateOf("") }
    var timerMinutes by rememberSaveable { mutableStateOf("10") }
    var timerLabel by rememberSaveable { mutableStateOf("") }
    var filePath by rememberSaveable { mutableStateOf("") }
    var workspaceCard by remember(projectId, state.cacheEpoch) { mutableStateOf<JsonObject?>(null) }
    val project = state.projects.firstOrNull { it.id == projectId }
    val actions = status?.get("actions")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }
    val actionNames = actions.mapNotNull { it.text("name") }.toSet()
    val categories = actions.mapNotNull { it.text("category") }.toSet()

    fun refresh() { refreshRequest++ }
    suspend fun loadControls() {
        if (projectId.isBlank()) { loading = false; return }
        loading = true; error = null
        val errors = mutableMapOf<String, String>()
        suspend fun load(section: String, method: String, apply: (JsonElement) -> Unit) {
            try { apply(repository.read(method, buildJsonObject { put("projectId", projectId) })) }
            catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { errors[section] = failure.message ?: strings.getString(R.string.desktop_could_not_load) }
        }
        if (state.supports("desktop.status")) load("status", "desktop.status") { status = it.jsonObject; volume = null }
        if (state.supports("desktop.workspace")) load("workspace", "desktop.workspace") { workspaceCard = it.jsonObject }
        val loaded = status?.get("actions")?.jsonArray.orEmpty().mapNotNull { (it as? JsonObject)?.text("category") }.toSet()
        if ("apps" in loaded && state.supports("desktop.apps")) load("apps", "desktop.apps") { apps = it.jsonArray.mapNotNull { row -> row as? JsonObject } } else apps = emptyList()
        if ("windows" in loaded && state.supports("desktop.windows")) load("windows", "desktop.windows") { windows = it.jsonArray.mapNotNull { row -> row as? JsonObject } } else windows = emptyList()
        sectionErrors = errors
        loading = false
    }
    fun execute(name: String, args: JsonObject, label: String, definitionDigest: String? = null) {
        if (pendingAction != null) return
        feedback = null; error = null
        pendingAction = label
        val params = buildJsonObject { put("projectId", projectId); put("action", name); put("args", args); definitionDigest?.let { put("definitionDigest", it) } }
        val cue = project?.path ?: project?.name ?: strings.getString(R.string.desktop_approved_project)
        signedReview(activity, repository, "desktop.execute", params, "$label · $cue", {
            pendingAction = null; feedback = strings.getString(R.string.desktop_done, label); refresh()
        }, { pendingAction = null; error = it }, projectId, label)
    }

    val projectIds = state.projects.map(Project::id)
    LaunchedEffect(state.cacheEpoch, projectIds) {
        if (projectId !in projectIds) projectId = projectIds.firstOrNull().orEmpty()
    }
    LaunchedEffect(projectId, state.cacheEpoch, state.connection is ConnectionState.Online) {
        status = null; apps = emptyList(); windows = emptyList(); sectionErrors = emptyMap(); feedback = null; error = null
        if (filePath.isBlank() || state.projects.none { filePath.startsWith(it.path.orEmpty()) }) filePath = project?.path.orEmpty()
    }
    LaunchedEffect(projectId, state.cacheEpoch, state.connection, refreshRequest) {
        if (state.connection is ConnectionState.Online) loadControls() else loading = false
    }
    // A timer that fires leaves the list; refresh when the desktop announces it.
    LaunchedEffect(projectId) { repository.notices.collect { if (it.kind == "timer" && it.projectId == projectId) refresh() } }
    if (state.connection !is ConnectionState.Online) return RecoveryPage(state, repository::retry)
    if (!state.supports("desktop.status")) return EmptyState(Icons.Default.Lock, stringResource(R.string.desktop_desktop_controls_are_not_granted), stringResource(R.string.desktop_on_the_desktop_grant_this_phone_desktop_control))

    val filter = query.trim()
    fun matches(vararg values: String?) = filter.isBlank() || values.any { it.orEmpty().contains(filter, true) }
    val audio = status?.get("audio") as? JsonObject; val media = status?.get("media") as? JsonObject
    val timers = status?.get("timers")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }
    val scripts = status?.get("scripts")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }.filter { matches(it.text("name"), it.text("executable")) }
    val shownWindows = windows.filter { matches(it.text("title"), it.text("app")) }
    val shownApps = apps.filter { matches(it.text("name")) }
    val formatter = remember { DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()) }
    val canAct = pendingAction == null && !loading

    LazyColumn(contentPadding = PaddingValues(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
        item { FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small), itemVerticalAlignment = Alignment.CenterVertically) {
            PageTitle(stringResource(R.string.nav_desktop), Modifier.weight(1f))
            OutlinedButton(::refresh, enabled = !loading && pendingAction == null && state.connection is ConnectionState.Online,
                modifier = Modifier.heightIn(min = PALLayout.target)) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(PALLayout.small)); Text(if (loading) stringResource(R.string.desktop_loading) else stringResource(R.string.desktop_refresh)) }
        } }
        if (state.owner) item(key = "view-desktop") { ViewDesktopPanel(repository, state, activity) }
        item { FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) { state.projects.forEach { option -> FilterChip(projectId == option.id, { projectId = option.id }, { Column { Text(option.name); Text(option.path ?: stringResource(R.string.desktop_path_unavailable), style = MaterialTheme.typography.labelSmall) } }, enabled = canAct) } } }
        project?.let { selected -> item { Panel(stringResource(R.string.desktop_action_scope)) { Text(state.desktop?.desktopName ?: stringResource(R.string.desktop_paired_desktop), color = MaterialTheme.colorScheme.primary); SelectionContainer { Text(selected.path ?: stringResource(R.string.desktop_path_unavailable), style = MaterialTheme.typography.bodySmall) } } } }
        // F80: whether the desktop is working in this project now, from fresh observations only.
        workspaceCard?.let { card -> item { Panel(stringResource(R.string.desktop_desktop_workspace)) {
            val unknown = card["unknown"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull?.replace('_', ' ') }
            Text(when (card.text("state")) {
                "in-project" -> stringResource(R.string.desktop_working_in_this_project_now, card.text("relativePath") ?: ".") + if (card.flag("verifiedCheckout")) stringResource(R.string.desktop_verified_checkout) else ""
                "elsewhere" -> stringResource(R.string.desktop_working_outside_this_project_right_now)
                "unknown" -> stringResource(R.string.desktop_not_known_right_now) + if (unknown.isNotEmpty()) stringResource(R.string.desktop_no_fresh, unknown.joinToString(", ")) else "."
                else -> card.text("reason") ?: stringResource(R.string.desktop_workspace_awareness_is_unavailable_on_the_desktop)
            })
        } } }
        // W10: features that need a program the desktop does not have; chat is not affected.
        status?.get("missing")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }.takeIf { it.isNotEmpty() }?.let { missing -> item { Panel(stringResource(R.string.desktop_unavailable_on_the_desktop)) {
            missing.forEach { Text(stringResource(R.string.desktop_needs_installed_on_the_desktop, it.text("feature") ?: "", it.text("name") ?: strings.getString(R.string.desktop_a_program)), style = MaterialTheme.typography.bodySmall) }
        } } }
        item { OutlinedTextField(query, { query = it }, leadingIcon = { Icon(Icons.Default.Search, null) }, placeholder = { Text(stringResource(R.string.desktop_search_apps_windows_or_scripts)) }, singleLine = true, modifier = Modifier.fillMaxWidth()) }
        if (loading || pendingAction != null) item {
            Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(pendingAction?.let { strings.getString(R.string.desktop_waiting_to_complete, it) } ?: stringResource(R.string.desktop_refreshing_desktop_controls), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        feedback?.let { item { AncillaryFeedback(it) } }
        error?.let { item { AncillaryFeedback(it, error = true) } }
        sectionErrors["status"]?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        if (status != null && categories.isEmpty()) item { Text(stringResource(R.string.desktop_no_desktop_control_categories_are_enabled_for_this), color = MaterialTheme.colorScheme.onSurfaceVariant) }

        if (audio?.flag("available") == true) item { Panel(stringResource(R.string.desktop_sound)) {
            val level = volume ?: (audio.text("percent")?.toFloatOrNull() ?: 0f)
            Text(if (audio.flag("muted")) stringResource(R.string.media_muted_volume, level.toInt()) else stringResource(R.string.desktop_volume, level.toInt(), ""), color = MaterialTheme.colorScheme.primary)
            // The volume is sent once, when the finger lifts, as one signed action.
            Slider(level, { volume = it }, valueRange = 0f..100f, steps = 19, enabled = canAct && "audio.volume" in actionNames,
                onValueChangeFinished = { val percent = (volume ?: level).toInt(); execute("audio.volume", buildJsonObject { put("percent", percent) }, strings.getString(R.string.desktop_set_desktop_volume_to, percent)) })
            OutlinedButton({ execute("audio.mute", buildJsonObject {}, if (audio.flag("muted")) strings.getString(R.string.desktop_unmute_desktop_sound) else strings.getString(R.string.desktop_mute_desktop_sound)) }, enabled = canAct && "audio.mute" in actionNames) { Text(if (audio.flag("muted")) stringResource(R.string.desktop_unmute) else stringResource(R.string.desktop_mute)) }
        } }
        if (media?.flag("available") == true) item { Panel(stringResource(R.string.desktop_playback)) {
            Text(listOfNotNull(media.text("name"), media.text("status")).joinToString(" · "), color = MaterialTheme.colorScheme.primary)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                listOf(Triple("Previous", stringResource(R.string.mobile_previous), "canPrevious"), Triple("PlayPause", if (media.text("status") == "Playing") strings.getString(R.string.work_pause) else strings.getString(R.string.desktop_play), "canPlayPause"), Triple("Next", stringResource(R.string.mobile_next), "canNext"), Triple("Stop", stringResource(R.string.action_stop_media), "canStop")).forEach { (command, label, capability) ->
                    OutlinedButton({ execute("media.control", buildJsonObject { put("command", command); media.text("player")?.let { put("player", it) } }, strings.getString(R.string.desktop_on, label, media.text("name") ?: "the desktop player")) },
                        enabled = canAct && "media.control" in actionNames && media.flag(capability)) { Text(label) }
                }
            }
        } }

        if (status?.flag("capture") == true && state.supports("captures.start") && project != null) item { CapturePanel(repository, state, activity, project, canAct) }
        if ("timers" in categories) item { Panel(stringResource(R.string.desktop_timers)) {
            if (timers.isEmpty()) Text(stringResource(R.string.desktop_no_timers_set_from_this_phone_in_this), color = MaterialTheme.colorScheme.onSurfaceVariant)
            timers.forEach { timer -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                Text(timer.text("label") ?: stringResource(R.string.desktop_timer))
                Text(stringResource(R.string.desktop_due, timer.text("due")?.toLongOrNull()?.let { formatter.format(Instant.ofEpochMilli(it)) } ?: stringResource(R.string.timer_soon)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton({
                    val label = strings.getString(R.string.desktop_cancel_timer_2, timer.text("label") ?: "")
                    pendingAction = label; feedback = null; error = null
                    signedReview(activity, repository, "timers.cancel", buildJsonObject { put("projectId", projectId); put("timerId", timer.text("id").orEmpty()) }, label,
                        { pendingAction = null; feedback = strings.getString(R.string.desktop_timer_cancelled); refresh() }, { pendingAction = null; error = it }, projectId, timer.text("label"))
                }, enabled = canAct && state.supports("timers.cancel"), modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.desktop_cancel_timer)) }
            } }
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedTextField(timerMinutes, { timerMinutes = it.filter(Char::isDigit).take(5) }, label = { Text(stringResource(R.string.desktop_minutes)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.widthIn(min = PALLayout.codeEditorHeight, max = PALLayout.fieldWidth))
                OutlinedTextField(timerLabel, { timerLabel = it.take(200) }, label = { Text(stringResource(R.string.desktop_label)) }, singleLine = true, modifier = Modifier.widthIn(min = PALLayout.fieldWidth).weight(1f))
            }
            val minutes = timerMinutes.toIntOrNull()
            Button({ execute("timer.start", buildJsonObject { put("minutes", minutes ?: 0); put("label", timerLabel.ifBlank { strings.getString(R.string.desktop_timer) }) }, strings.getString(R.string.desktop_start_a_minute_desktop_timer, minutes)) }, enabled = canAct && "timer.start" in actionNames && minutes != null && minutes in 1..10080) { Text(stringResource(R.string.desktop_start_timer)) }
        } }

        if ("scripts" in categories) item { Panel(stringResource(R.string.desktop_saved_scripts)) {
            if (scripts.isEmpty()) Text(stringResource(R.string.desktop_no_saved_scripts_are_granted_to_this_phone), color = MaterialTheme.colorScheme.onSurfaceVariant)
            scripts.forEach { script -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                Text(script.text("name") ?: script.text("id") ?: stringResource(R.string.desktop_script), fontWeight = FontWeight.Medium)
                Text(script.text("executable").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton({ reviewingScript = script }, enabled = canAct && "script.run" in actionNames, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.desktop_review_run)) }
            } }
        } }

        if ("windows" in categories) {
            item { Text(stringResource(R.string.desktop_windows), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() }) }
            sectionErrors["windows"]?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            item { FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.small), itemVerticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(workspace, { workspace = it.filter(Char::isDigit).take(2) }, label = { Text(stringResource(R.string.desktop_workspace)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.widthIn(min = PALLayout.shortField, max = PALLayout.fieldWidth))
                val number = workspace.toIntOrNull()
                OutlinedButton({ execute("workspace.switch", buildJsonObject { put("workspace", number ?: 0) }, strings.getString(R.string.desktop_switch_to_workspace, number)) }, enabled = pendingAction == null && "workspace.switch" in actionNames && number != null && number in 1..99,
                    modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.desktop_switch_workspace)) }
            } }
            if (shownWindows.isEmpty() && sectionErrors["windows"] == null) item { Text(stringResource(R.string.desktop_no_windows_to_show), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(shownWindows.take(40)) { window -> Panel(window.text("title") ?: stringResource(R.string.desktop_untitled)) {
                Text(stringResource(R.string.desktop_workspace_2, window.text("app").orEmpty(), window.text("workspace").orEmpty()), color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    OutlinedButton({ execute("windows.focus", buildJsonObject { put("address", window.text("address").orEmpty()) }, strings.getString(R.string.desktop_focus_2, window.text("title") ?: "window")) }, enabled = canAct && "windows.focus" in actionNames) { Text(stringResource(R.string.desktop_focus)) }
                    OutlinedButton({ moving = window }, enabled = canAct && "windows.move" in actionNames) { Text(stringResource(R.string.desktop_move)) }
                }
            } }
        }

        if ("apps" in categories) {
            item { Text(stringResource(R.string.desktop_applications), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() }) }
            sectionErrors["apps"]?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            if (shownApps.isEmpty() && sectionErrors["apps"] == null) item { Text(stringResource(R.string.desktop_no_applications_to_show), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(shownApps.take(40)) { app -> Panel(app.text("name") ?: stringResource(R.string.desktop_application)) {
                OutlinedButton({ execute("apps.launch", buildJsonObject { put("desktopId", app.text("id").orEmpty()) }, strings.getString(R.string.desktop_open, app.text("name").orEmpty())) }, enabled = canAct && "apps.launch" in actionNames) { Text(stringResource(R.string.desktop_open_on_desktop)) }
            } }
        }

        if ("files" in categories) item { Panel(stringResource(R.string.desktop_open_a_file_or_folder)) {
            Text(stringResource(R.string.desktop_opens_on_the_desktop_in_its_default_app), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(filePath, { filePath = it.take(4096) }, label = { Text(stringResource(R.string.desktop_path_on_the_desktop)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            val inside = project?.path?.let { root -> filePath == root || filePath.startsWith("$root/") } == true
            Button({ execute("files.open", buildJsonObject { put("path", filePath.trim()) }, strings.getString(R.string.desktop_open, filePath.substringAfterLast('/'))) }, enabled = canAct && "files.open" in actionNames && inside) { Text(stringResource(R.string.desktop_open_on_desktop)) }
        } }
    }

    moving?.let { window ->
        var target by rememberSaveable(window.text("address")) { mutableStateOf("") }
        val number = target.toIntOrNull()
        AlertDialog(onDismissRequest = { moving = null }, title = { Text(stringResource(R.string.desktop_move_window)) }, text = { Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(window.text("title") ?: stringResource(R.string.desktop_untitled), fontWeight = FontWeight.Medium)
            Text(stringResource(R.string.desktop_currently_on_workspace_the_desktop_stays_on_its, window.text("workspace").orEmpty()), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(target, { target = it.filter(Char::isDigit).take(2) }, label = { Text(stringResource(R.string.desktop_destination_workspace_199)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        } }, confirmButton = { Button({ moving = null; execute("windows.move", buildJsonObject { put("address", window.text("address").orEmpty()); put("workspace", number ?: 0) }, strings.getString(R.string.desktop_move_to_workspace, window.text("title") ?: "window", number)) },
            enabled = number != null && number in 1..99, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.desktop_review_move)) } },
            dismissButton = { TextButton({ moving = null }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.desktop_keep_here)) } })
    }
    reviewingScript?.let { script ->
        AlertDialog(onDismissRequest = { reviewingScript = null }, title = { Text(stringResource(R.string.desktop_run_saved_script)) }, text = { Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(script.text("name") ?: stringResource(R.string.desktop_script), fontWeight = FontWeight.SemiBold)
            SelectionContainer { Text(listOf(script.text("executable").orEmpty(), *script["args"]?.jsonArray.orEmpty().map { (it as? JsonPrimitive)?.contentOrNull.orEmpty() }.toTypedArray()).joinToString(" "), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
            Text(stringResource(R.string.desktop_folder, script.text("cwd").orEmpty()), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.desktop_time_limit_s, (script.text("timeout")?.toLongOrNull() ?: 0) / 1000), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.desktop_runs_exactly_this_saved_definition_on_if_it, state.desktop?.desktopName ?: strings.getString(R.string.desktop_the_desktop)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } }, confirmButton = { Button({ reviewingScript = null; execute("script.run", buildJsonObject { put("id", script.text("id").orEmpty()) }, strings.getString(R.string.desktop_run_2, script.text("name") ?: "script"), script.text("definitionDigest")) },
            modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.desktop_run)) } },
            dismissButton = { TextButton({ reviewingScript = null }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.desktop_dont_run)) } })
    }
}

@Composable private fun Panel(title: String, content: @Composable ColumnScope.() -> Unit) {
    AncillarySection(title = title, content = content)
}

/**
 * W10: capture the desktop's focused display from the phone. The capture is an accepted job on the
 * desktop; with editing, Satty opens there and waits for whoever is at the desktop. The phone shows
 * the exact image it will share (a reduced copy bound to the original's digest), and nothing goes to
 * a conversation until it is attached here and sent from that conversation.
 */
@Composable
private fun CapturePanel(repository: PALRepository, state: MobileState, activity: FragmentActivity, project: Project, enabled: Boolean) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    val captures by repository.captures.collectAsState()
    val latest = captures.values.firstOrNull { it.text("projectId") == project.id }
    val captureId = latest?.text("captureId"); val captureState = latest?.text("state")
    var preview by remember(captureId) { mutableStateOf<dev.otectus.pal.mobile.data.ApprovalPreview?>(null) }
    var bitmap by remember(captureId) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }
    var target by rememberSaveable(captureId) { mutableStateOf<String?>(null) }
    val targets = state.sessions.filter { it.projectId == project.id && it.canSend && it.mode == "managed" }
    // Satty may stay open for minutes: the phone checks in while it waits, as well as hearing events.
    LaunchedEffect(captureId, captureState) {
        if (captureId != null && captureState in setOf("capturing", "editing")) { kotlinx.coroutines.delay(3_000); runCatching { repository.captureStatus(captureId) } }
        if (captureId != null && captureState == "ready" && preview == null && state.supports("captures.preview")) runCatching { repository.capturePreview(captureId) }
            .onSuccess { value -> preview = value; bitmap = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { decodeForDisplay(value.bytes, 2048) } }.onFailure { error = it.message }
    }
    fun start(edit: Boolean) { busy = true; error = null
        signedReview(activity, repository, "captures.start", buildJsonObject { put("projectId", project.id); put("edit", edit) }, if (edit) strings.getString(R.string.desktop_capture_and_edit_on_the_desktop) else strings.getString(R.string.desktop_capture_the_desktop_display),
            { result -> repository.captureStarted(result); busy = false }, { error = it; busy = false }, boundProjectId = project.id) }
    Panel(stringResource(R.string.desktop_screen_capture)) {
        Text(stringResource(R.string.desktop_captures_the_desktops_focused_display_nothing_is_shared), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Button({ start(false) }, enabled = enabled && !busy && captureState !in setOf("capturing", "editing")) { Text(stringResource(R.string.desktop_capture_now)) }
            OutlinedButton({ start(true) }, enabled = enabled && !busy && captureState !in setOf("capturing", "editing")) { Text(stringResource(R.string.desktop_capture_and_edit_on_the_desktop)) }
        }
        latest?.let { capture ->
            Text(when (captureState) {
                "capturing" -> stringResource(R.string.desktop_capturing); "editing" -> stringResource(R.string.desktop_waiting_for_the_capture_to_be_saved_in)
                "ready" -> stringResource(R.string.desktop_ready_to_review); "attached" -> stringResource(R.string.desktop_attached_to_a_conversation_draft_send_it_from)
                else -> capture.text("message") ?: (captureState ?: "")
            }, color = if (captureState in setOf("failed", "expired")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            bitmap?.let { androidx.compose.foundation.Image(it.asImageBitmap(), stringResource(R.string.desktop_the_exact_capture_that_will_be_attached), Modifier.fillMaxWidth().heightIn(max = PALLayout.desktopPreviewHeight)) }
            if (captureState == "ready" && preview != null && state.supports("captures.attach")) {
                Text(stringResource(R.string.desktop_attach_to), fontWeight = FontWeight.Medium)
                if (targets.isEmpty()) Text(stringResource(R.string.desktop_no_conversation_in_this_project_can_send_from), style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { targets.forEach { session -> FilterChip(target == session.id, { target = session.id }, { Text(session.title, maxLines = 1) }) } }
                Button({ val chosen = target ?: return@Button; val reviewed = preview ?: return@Button; busy = true; error = null
                    signedReview(activity, repository, "captures.attach", buildJsonObject { put("captureId", captureId!!); put("sessionId", chosen); put("imageDigest", reviewed.imageDigest) }, strings.getString(R.string.desktop_attach_this_capture),
                        { result -> scope.launch { runCatching { repository.adoptCapture(chosen, result.jsonObject, reviewed) }.onFailure { error = it.message }; captureId?.let { runCatching { repository.captureStatus(it) } }; busy = false } }, { error = it; busy = false }, boundProjectId = project.id)
                }, enabled = enabled && !busy && target != null) { Text(stringResource(R.string.desktop_review_attach)) }
            }
            if (captureId != null && captureState in setOf("capturing", "editing", "ready")) TextButton({ scope.launch { busy = true; runCatching { repository.discardCapture(captureId) }.onFailure { error = it.message }; busy = false } }, enabled = enabled && !busy) { Text(if (captureState == "ready") stringResource(R.string.desktop_discard) else stringResource(R.string.annotation_cancel)) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}
