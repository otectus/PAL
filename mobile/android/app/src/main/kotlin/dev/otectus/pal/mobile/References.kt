@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.traits
import dev.otectus.pal.mobile.protocol.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What the next message of each conversation refers to. It lives here until that message is accepted; the desktop
 * resolves and authorizes each one again when the message is sent.
 */
internal object ComposerReferences {
    data class Item(val label: String, val ref: JsonObject)
    const val LIMIT = 8
    private val items = mutableStateMapOf<String, List<Item>>()
    fun of(sessionId: String): List<Item> = items[sessionId].orEmpty()
    /** Null when it was added; otherwise the reason it was not. */
    fun add(sessionId: String, label: String, ref: JsonObject): Int? {
        val current = of(sessionId)
        if (current.any { it.ref == ref }) return null
        if (current.size >= LIMIT) return R.string.refs_full
        items[sessionId] = current + Item(label, ref)
        return null
    }
    fun remove(sessionId: String, item: Item) { items[sessionId] = of(sessionId) - item }
    /** After a message was accepted, only what it carried is gone. */
    fun sent(sessionId: String, carried: List<Item>) { items[sessionId] = of(sessionId) - carried.toSet() }
    fun clear() = items.clear()
}
/** Only conversations PAL itself composes take references: a command-line provider reads its own files. */
internal fun referencesOffered(state: MobileState, session: Session) =
    state.owner && session.mode == "managed" && state.traits(session.provider).kind in setOf("local", "api") && state.supports("workbench.references.search")

/** The references chosen for the next message, and what the desktop says they would add. */
@Composable
internal fun ReferenceChips(repository: PALRepository, state: MobileState, activity: FragmentActivity, session: Session, text: String, changed: (String?) -> Unit) {
    val items = ComposerReferences.of(session.id)
    if (items.isEmpty()) return
    val scope = rememberCoroutineScope(); val strings = LocalResources.current
    var preview by remember(session.id) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(session.id, items, text.isNotBlank()) {
        delay(350)
        if (state.supports("workbench.references.preview")) preview = runCatching { repository.read("workbench.references.preview", buildJsonObject { put("sessionId", session.id); put("references", JsonArray(items.map { it.ref })); put("text", text.take(2000)) }) as JsonObject }.getOrNull()
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = PALLayout.gutter)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            items.forEach { item ->
                val remove = stringResource(R.string.refs_remove, item.label); val keep = stringResource(R.string.refs_keep, item.label)
                InputChip(true, { ComposerReferences.remove(session.id, item) }, { Text("@" + item.label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingIcon = if (!state.supports("workbench.references.keep")) null else { { IconButton({ scope.launch {
                        ownerCall { signed(activity, repository, "workbench.references.keep", buildJsonObject { put("sessionId", session.id); put("ref", item.ref) }, strings.getString(R.string.refs_keep, item.label)) }
                            .onSuccess { ComposerReferences.remove(session.id, item); changed(strings.getString(R.string.refs_kept)) }.onFailure { changed(it.message) }
                    } }, Modifier.size(InputChipDefaults.IconSize + PALLayout.small)) { Icon(Icons.Default.Star, keep, Modifier.size(InputChipDefaults.IconSize)) } } },
                    trailingIcon = { Icon(Icons.Default.Close, remove, Modifier.size(InputChipDefaults.IconSize)) })
            }
        }
        preview?.let { value -> ReferencePreview(value) }
    }
}
@Composable
internal fun ReferencePreview(value: JsonObject) {
    val problem = value.str("problem").orEmpty()
    val text = if (value.isTrue("ok")) pluralStringResource(R.plurals.refs_adds, value.int("characters") ?: 0, value.int("characters") ?: 0) + (value["notes"] as? JsonArray).orEmpty().joinToString("") { note -> " " + ((note as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()) + "." }
        else stringResource(R.string.refs_cannot, problem)
    Text(text, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall, color = if (value.isTrue("ok")) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
}

/** Files, folders, collections, kept files and other conversations of the project, found on the desktop. */
@Composable
internal fun ReferenceChooser(repository: PALRepository, sessionId: String, title: String, dismiss: () -> Unit, choose: (JsonObject) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var candidates by remember { mutableStateOf<List<JsonObject>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query) {
        delay(200)
        ownerCall { repository.read("workbench.references.search", buildJsonObject { put("sessionId", sessionId); put("query", query) }) as JsonObject }.onSuccess { candidates = it.list("candidates"); error = null }.onFailure { error = it.message }
    }
    AncillarySheetScaffold(title, null, candidates == null && error == null, dismiss) {
        OutlinedTextField(query, { query = it.take(100) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.refs_find)) })
        error?.let { AncillaryFeedback(it, error = true) }
        if (candidates?.isEmpty() == true) Text(stringResource(R.string.refs_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        candidates.orEmpty().forEach { candidate -> ReferenceRow(candidate) { choose(candidate) } }
    }
}
@Composable
internal fun ReferenceRow(candidate: JsonObject, choose: () -> Unit) {
    Surface(onClick = choose, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(PALLayout.groupGap)) {
            Text(candidate.str("label").orEmpty(), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(candidate.str("detail").orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Sources the desktop reads again for every message of this conversation or project. */
@Composable
internal fun PinnedSources(repository: PALRepository, state: MobileState, activity: FragmentActivity, session: Session) {
    if (!state.supports("workbench.references.pins")) return
    val scope = rememberCoroutineScope(); val strings = LocalResources.current
    var value by remember(session.id) { mutableStateOf<JsonObject?>(null) }
    var error by remember(session.id) { mutableStateOf<String?>(null) }
    var adding by rememberSaveable(session.id) { mutableStateOf(false) }
    var candidate by remember(session.id) { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(session.id) { ownerCall { repository.read("workbench.references.pins", buildJsonObject { put("sessionId", session.id) }) as JsonObject }.onSuccess { value = it }.onFailure { error = it.message } }
    if (value?.isTrue("supported") != true && error == null) return
    AncillarySection(stringResource(R.string.refs_pinned), stringResource(R.string.refs_pinned_hint)) {
        error?.let { AncillaryFeedback(it, error = true) }
        PinRows(value?.list("pins").orEmpty()) { pin -> scope.launch {
            ownerCall { repository.mutate("workbench.references.unkeep", buildJsonObject { put("sessionId", session.id); put("id", pin.str("id")) }) as JsonObject }.onSuccess { value = it; error = null }.onFailure { error = it.message }
        } }
        OutlinedButton({ adding = true }, Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.refs_pin_add)) }
    }
    if (adding) ReferenceChooser(repository, session.id, stringResource(R.string.refs_pin_add), { adding = false }) { adding = false; candidate = it }
    candidate?.let { chosen ->
        // A folder belongs to one conversation, so only kept files, collections and conversations can serve the project.
        val shared = chosen.str("kind") !in setOf("file", "folder")
        fun keep(scopeName: String) { candidate = null; scope.launch {
            ownerCall { signed(activity, repository, "workbench.references.keep", buildJsonObject { put("sessionId", session.id); put("ref", chosen.obj("ref") ?: JsonObject(emptyMap())); put("scope", scopeName) }, strings.getString(R.string.refs_keep, chosen.str("label").orEmpty())) as JsonObject }
                .onSuccess { value = it; error = null }.onFailure { error = it.message }
        } }
        AlertDialog({ candidate = null }, title = { Text(chosen.str("label").orEmpty()) }, text = { Text(stringResource(R.string.refs_pin_where)) },
            confirmButton = { TextButton({ keep("session") }) { Text(stringResource(R.string.refs_pin_here)) } },
            dismissButton = { Row { if (shared) TextButton({ keep("project") }) { Text(stringResource(R.string.refs_pin_project)) }; TextButton({ candidate = null }) { Text(stringResource(R.string.action_cancel)) } } })
    }
}
@Composable
internal fun PinRows(pins: List<JsonObject>, remove: (JsonObject) -> Unit) {
    if (pins.isEmpty()) Text(stringResource(R.string.refs_pinned_none), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    pins.forEach { pin ->
        Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(pin.str("label").orEmpty(), maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (pin.str("scope") == "project") Text(stringResource(R.string.refs_pin_everywhere), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton({ remove(pin) }) { Text(stringResource(R.string.refs_unpin)) }
        }
    }
}
