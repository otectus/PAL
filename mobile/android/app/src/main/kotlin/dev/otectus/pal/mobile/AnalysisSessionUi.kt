@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A Python namespace on the desktop that stays between cells, inside Code Lab's isolation, until it is stopped. */
@Composable
internal fun AnalysisSessionSheet(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, notebook: (JsonObject) -> Unit, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope(); val strings = LocalResources.current
    var status by remember(sessionId) { mutableStateOf<JsonObject?>(null) }
    var last by remember(sessionId) { mutableStateOf<JsonObject?>(null) }
    var files by remember(sessionId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var running by rememberSaveable(sessionId) { mutableStateOf<String?>(null) }
    var busy by remember(sessionId) { mutableStateOf(false) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    fun call(work: suspend () -> Unit) = scope.launch { busy = true; error = null; try { work() } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } finally { busy = false } }
    suspend fun refresh() { status = repository.read("workbench.codelab.session", buildJsonObject { put("sessionId", sessionId) }) as JsonObject }
    LaunchedEffect(sessionId) { call { refresh(); running = running ?: status?.obj("session")?.str("runningOperationId")?.ifBlank { null } }; runCatching { files = (repository.read("workbench.artifacts.list", buildJsonObject { put("sessionId", sessionId); put("limit", 60) }) as JsonObject).list("artifacts") } }
    LaunchedEffect(running) {
        val id = running ?: return@LaunchedEffect
        while (isActive) {
            val now = ownerCall { repository.read("workbench.operations.get", buildJsonObject { put("sessionId", sessionId); put("id", id) }) as JsonObject }.getOrElse { error = it.message; break }
            last = now
            if (now.str("state") !in setOf("queued", "running", "cancel_requested")) break
            delay(700)
        }
        running = null; ownerCall { refresh() }
    }
    AncillarySheetScaffold(stringResource(R.string.lab_session), stringResource(R.string.lab_session_hint), busy || running != null, dismiss) {
        AnalysisSessionContent(status, last, files, busy, running != null, error,
            start = { call { status = signed(activity, repository, "workbench.codelab.sessionStart", buildJsonObject { put("sessionId", sessionId) }, strings.getString(R.string.lab_session_start)) as JsonObject } },
            run = { code, file -> call { last = null; running = (signed(activity, repository, "workbench.codelab.sessionRun", buildJsonObject { put("sessionId", sessionId); put("code", code); file?.let { put("inputs", JsonArray(listOf(buildJsonObject { put("artifactId", it) }))) } }, strings.getString(R.string.lab_session_run)) as JsonObject).str("operationId") } },
            act = { action -> call {
                val params = buildJsonObject { put("sessionId", sessionId) }
                status = (if (action == "sessionRestart") signed(activity, repository, "workbench.codelab.$action", params, strings.getString(R.string.lab_session_restart)) else repository.mutate("workbench.codelab.$action", params)) as JsonObject
                if (action != "sessionInterrupt") last = null
            } },
            notebook = { call { notebook(repository.read("workbench.codelab.sessionNotebook", buildJsonObject { put("sessionId", sessionId) }) as JsonObject) } })
    }
}

@Composable
internal fun ColumnScope.AnalysisSessionContent(status: JsonObject?, last: JsonObject?, files: List<JsonObject>, busy: Boolean, running: Boolean, error: String?, start: () -> Unit, run: (String, String?) -> Unit, act: (String) -> Unit, notebook: () -> Unit) {
    val session = status?.obj("session")
    error?.let { AncillaryFeedback(it, error = true) }
    if (status?.isTrue("available") == false) { Text(stringResource(R.string.lab_session_off)); return }
    if (session == null) {
        status?.obj("ended")?.str("reason")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Button(start, enabled = status != null && !busy, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.lab_session_start)) }
        return
    }
    val cells = session.list("cells").size
    Text(pluralStringResource(R.plurals.lab_session_cells, cells, cells) + " · " + stringResource(if (running) R.string.lab_session_busy else R.string.lab_session_ready), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall)
    if ((session.int("sinceClear") ?: 0) > 0) Text(stringResource(R.string.lab_session_depends), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
    var code by rememberSaveable { mutableStateOf("") }
    var file by rememberSaveable { mutableStateOf<String?>(null) }
    var choosing by remember { mutableStateOf(false) }
    OutlinedTextField(code, { code = it.take(65_536) }, Modifier.fillMaxWidth().heightIn(min = PALLayout.shortField), label = { Text(stringResource(R.string.lab_session_code)) }, textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
    if (files.isNotEmpty()) Box {
        TextButton({ choosing = true }) { Text(files.firstOrNull { (it.str("id") ?: it.str("artifactId")) == file }?.str("name")?.let { stringResource(R.string.lab_session_adds, it) } ?: stringResource(R.string.lab_session_add_file), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        DropdownMenu(choosing, { choosing = false }) {
            DropdownMenuItem({ Text(stringResource(R.string.lab_session_no_file)) }, { choosing = false; file = null })
            files.take(30).forEach { item -> DropdownMenuItem({ Text(item.str("name").orEmpty()) }, { choosing = false; file = item.str("id") ?: item.str("artifactId") }) }
        }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        if (running) Button({ act("sessionInterrupt") }) { Text(stringResource(R.string.lab_session_stop_cell)) }
        else Button({ run(code, file); file = null }, enabled = code.isNotBlank() && !busy) { Text(stringResource(R.string.lab_session_run)) }
        OutlinedButton(notebook, enabled = !running && !busy && session.list("cells").any { it.str("state") == "completed" }) { Text(stringResource(R.string.lab_session_notebook)) }
    }
    last?.let { value -> AncillarySection(when (value.str("state")) { "completed" -> stringResource(R.string.lab_session_finished); "failed" -> stringResource(R.string.lab_session_failed); "running", "queued" -> stringResource(R.string.lab_session_busy); else -> stringResource(R.string.lab_session_stopped) }) {
        val details = value.obj("details")
        val output = listOfNotNull(details?.str("stdout")?.takeLast(12_000), details?.str("stderr")?.takeLast(6_000)).joinToString("\n").trim()
        if (output.isNotEmpty()) SelectionContainer { Text(output, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)) }
        details?.str("outputNote")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
        if (value.list("results").isNotEmpty()) Text(pluralStringResource(R.plurals.lab_session_files, value.list("results").size, value.list("results").size), style = MaterialTheme.typography.bodySmall)
    } }
    Text(stringResource(R.string.lab_session_variables), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
    val variables = session.list("variables")
    if (variables.isEmpty()) Text(stringResource(R.string.lab_session_no_variables), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    variables.take(60).forEach { item -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalAlignment = Alignment.CenterVertically) {
        Text(item.str("name").orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(listOf(item.str("type").orEmpty(), item.str("detail").orEmpty()).filter { it.isNotBlank() }.joinToString(" · "), Modifier.weight(1.4f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
    } }
    var confirming by remember { mutableStateOf<String?>(null) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        OutlinedButton({ confirming = "sessionClear" }, enabled = !running && !busy) { Text(stringResource(R.string.lab_session_clear)) }
        OutlinedButton({ confirming = "sessionRestart" }, enabled = !busy) { Text(stringResource(R.string.lab_session_restart)) }
        OutlinedButton({ confirming = "sessionStop" }, enabled = !busy) { Text(stringResource(R.string.lab_session_stop)) }
    }
    confirming?.let { action -> AlertDialog({ confirming = null }, title = { Text(stringResource(when (action) { "sessionClear" -> R.string.lab_session_clear; "sessionRestart" -> R.string.lab_session_restart; else -> R.string.lab_session_stop })) },
        text = { Text(stringResource(if (action == "sessionClear") R.string.lab_session_clear_body else R.string.lab_session_lost)) },
        confirmButton = { TextButton({ confirming = null; act(action) }) { Text(stringResource(R.string.lab_session_confirm)) } }, dismissButton = { TextButton({ confirming = null }) { Text(stringResource(R.string.action_cancel)) } }) }
}
