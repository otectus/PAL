@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/*
 * Looking after a saved account from the phone: what it can do, in stages, and what depends on it before it is removed.
 * The desktop does the work; trying a model may be billed and happens only when asked.
 */

private val connectionTests = listOf("reply" to R.string.care_test_reply, "streaming" to R.string.care_test_streaming, "tools" to R.string.care_test_tools, "images" to R.string.care_test_images, "structured" to R.string.care_test_structured)

/** One stage of a check: what was looked at, how it went, and what was found. */
@Composable
internal fun CheckStage(stage: JsonObject) {
    val state = stage.str("state")
    val said = stringResource(when (state) { "ok" -> R.string.care_state_ok; "failed" -> R.string.care_state_failed; else -> R.string.care_state_unknown })
    val label = stage.str("label").orEmpty(); val detail = stage.str("detail").orEmpty()
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "$label, $said. $detail" }) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Text("$said · $detail", style = MaterialTheme.typography.bodySmall, color = when (state) { "ok" -> MaterialTheme.colorScheme.primary; "failed" -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.tertiary })
    }
}
@Composable
internal fun ConnectionCheckDialog(repository: PALRepository, activity: FragmentActivity, connectionId: String?, provider: String, name: String, dismiss: () -> Unit) {
    val strings = LocalResources.current; val scope = rememberOwnerScope()
    var result by remember { mutableStateOf<JsonObject?>(null) }
    var model by rememberSaveable { mutableStateOf("") }
    var chosen by rememberSaveable(stateSaver = listSaver<Set<String>, String>({ it.toList() }, { it.toSet() })) { mutableStateOf(setOf("reply")) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun run(tests: List<String>) {
        busy = true; error = null
        scope.launch {
            ownerCall { signed(activity, repository, "owner.connections.check", buildJsonObject {
                if (connectionId != null) put("connectionId", connectionId) else put("provider", provider)
                if (tests.isNotEmpty()) { put("tests", JsonArray(tests.map(::JsonPrimitive))); put("model", model.trim()); put("paid", true) }
            }, if (tests.isEmpty()) strings.getString(R.string.care_check_action, name) else strings.getString(R.string.care_try_action, model.trim())) as JsonObject }
                .onSuccess { value -> result = value; value.list("models").singleOrNull()?.str("id")?.let { if (model.isBlank()) model = it } }.onFailure { error = it.message }
            busy = false
        }
    }
    LaunchedEffect(Unit) { run(emptyList()) }
    ToolDialog(stringResource(R.string.care_check_title, name), dismiss, busy = busy, error = error, confirm = {
        Button({ run(connectionTests.map { it.first }.filter { it in chosen }) }, enabled = !busy && model.isNotBlank() && chosen.isNotEmpty()) { Text(stringResource(R.string.care_try)) }
    }) {
        result?.list("stages").orEmpty().forEach { CheckStage(it) }
        Text(stringResource(R.string.care_try_heading), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
        val models = result?.list("models").orEmpty()
        if (models.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { models.take(12).forEach { row -> val id = row.str("id").orEmpty(); FilterChip(model == id, { model = id }, { Text(row.str("name") ?: id, maxLines = 1, overflow = TextOverflow.Ellipsis) }, enabled = !busy) } }
        OutlinedTextField(model, { model = it.take(512) }, Modifier.fillMaxWidth(), singleLine = true, enabled = !busy, label = { Text(stringResource(R.string.care_model)) }, textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { connectionTests.forEach { (id, label) -> FilterChip(id in chosen, { chosen = if (id in chosen) chosen - id else chosen + id }, { Text(stringResource(label)) }, enabled = !busy) } }
        Text(stringResource(if (provider == "ollama") R.string.care_loads else R.string.care_billed), style = MaterialTheme.typography.bodySmall)
    }
}

private fun kindLabel(kind: String?) = when (kind) {
    "conversation" -> R.string.care_kind_conversation; "schedule" -> R.string.care_kind_schedule; "helper", "vision" -> R.string.care_kind_helper; "images" -> R.string.care_kind_images
    "voice", "transcription" -> R.string.care_kind_voice; "extraction", "embedding", "memory-task" -> R.string.care_kind_memory; "setup" -> R.string.care_kind_setup; "specialist" -> R.string.care_kind_specialist; "research" -> R.string.care_kind_research
    else -> R.string.care_kind_other
}
/** What uses an account, with moving it to another one of the same provider; the account can go once nothing does. */
@Composable
internal fun ConnectionUsesList(uses: JsonObject, target: String?, choose: (String) -> Unit, reviewed: Boolean, review: (Boolean) -> Unit, problems: List<String>, busy: Boolean, move: () -> Unit) {
    val items = uses.list("uses"); val total = uses.int("total") ?: items.size; val targets = uses.list("targets"); val movable = items.count { it.isTrue("movable") }
    Text(if (total == 0) stringResource(R.string.care_unused) else pluralStringResource(R.plurals.care_used, total, total), style = MaterialTheme.typography.bodySmall)
    items.take(40).forEach { item ->
        Column(Modifier.fillMaxWidth()) {
            Text(listOfNotNull(stringResource(kindLabel(item.str("kind"))), item.str("label"), item.str("detail").takeIf { it != null && item.str("kind") == "conversation" }).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            item.str("where")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
        }
    }
    if (total > items.take(40).size) (total - items.take(40).size).let { Text(pluralStringResource(R.plurals.care_more, it, it), style = MaterialTheme.typography.bodySmall) }
    problems.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
    if (movable > 0 && targets.isEmpty()) Text(stringResource(R.string.care_no_target), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
    if (movable > 0 && targets.isNotEmpty()) {
        Text(stringResource(R.string.care_move_to), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { targets.forEach { row -> val id = row.str("id").orEmpty(); FilterChip(target == id, { choose(id) }, { Text(row.str("name").orEmpty()) }, enabled = !busy) } }
        Text(stringResource(R.string.care_move_hint), style = MaterialTheme.typography.bodySmall)
        ToolCheck(stringResource(R.string.care_reviewed), reviewed, review)
        OutlinedButton(move, enabled = !busy && reviewed && target != null) { Text(stringResource(R.string.care_move)) }
    }
}
@Composable
internal fun ConnectionRemoveDialog(repository: PALRepository, activity: FragmentActivity, connectionId: String, name: String, changed: () -> Unit, dismiss: () -> Unit) {
    val strings = LocalResources.current; val scope = rememberOwnerScope()
    var uses by remember { mutableStateOf<JsonObject?>(null) }
    var target by rememberSaveable { mutableStateOf<String?>(null) }
    var reviewed by rememberSaveable { mutableStateOf(false) }
    var problems by remember { mutableStateOf<List<String>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun load() { ownerCall { repository.request("owner.connections.uses", buildJsonObject { put("id", connectionId) }) as JsonObject }.onSuccess { uses = it; if (it.list("targets").none { row -> row.str("id") == target }) target = it.list("targets").firstOrNull()?.str("id") }.onFailure { error = it.message } }
    LaunchedEffect(connectionId) { load() }
    val unused = uses?.int("total") == 0
    ToolDialog(stringResource(R.string.care_remove_title, name), dismiss, busy = busy, error = error, confirm = {
        Button({ busy = true; error = null; scope.launch {
            ownerCall { signed(activity, repository, "owner.connections.remove", buildJsonObject { put("id", connectionId) }, strings.getString(R.string.care_remove_action, name)) }.onSuccess { changed(); dismiss() }.onFailure { error = it.message; load() }
            busy = false
        } }, enabled = !busy && unused) { Text(stringResource(R.string.care_remove)) }
    }) {
        uses?.let { listed -> ConnectionUsesList(listed, target, { target = it }, reviewed, { reviewed = it }, problems, busy) {
            val to = target ?: return@ConnectionUsesList
            busy = true; error = null; problems = emptyList()
            scope.launch {
                ownerCall { signed(activity, repository, "owner.connections.reassign", buildJsonObject { put("id", connectionId); put("to", to); put("reviewed", true) }, strings.getString(R.string.care_move_action, name, listed.list("targets").firstOrNull { it.str("id") == to }?.str("name").orEmpty())) as JsonObject }
                    .onSuccess { problems = (it["problems"] as? JsonArray).orEmpty().mapNotNull { row -> (row as? JsonPrimitive)?.contentOrNull }; reviewed = false; changed(); load() }.onFailure { error = it.message }
                busy = false
            }
        } }
    }
}
