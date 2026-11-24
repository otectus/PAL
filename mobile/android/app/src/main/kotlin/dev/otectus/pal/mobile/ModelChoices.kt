@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import dev.otectus.pal.mobile.data.ModelSearch
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.ModelOption
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/*
 * A provider's models as one list. A long one can be searched and narrowed and is never drawn all at once; each model
 * says what its catalog states: how much it holds, what it costs and what it reads.
 */

private val traitLabels = mapOf("tools" to R.string.models_tools, "images" to R.string.models_images, "reasoning" to R.string.models_reasoning, "structured-output" to R.string.models_structured, "free" to R.string.models_free)
private const val PAGE = 30

@Composable
internal fun ModelChoices(models: List<ModelOption>, chosen: String, enabled: Boolean, choose: (ModelOption) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var only by rememberSaveable(stateSaver = listSaver<Set<String>, String>({ it.toList() }, { it.toSet() })) { mutableStateOf(emptySet()) }
    var shown by rememberSaveable { mutableIntStateOf(PAGE) }
    val long = models.size > ModelSearch.SHORT
    val offered = remember(models) { ModelSearch.offered(models) }
    val rows = remember(models, query, only, chosen, long) { if (long) ModelSearch.find(models, query, only.intersect(offered.toSet()), chosen) else models }
    LaunchedEffect(query, only) { shown = PAGE }
    if (long) {
        OutlinedTextField(query, { query = it.take(100) }, Modifier.fillMaxWidth(), enabled = enabled, singleLine = true, label = { Text(pluralStringResource(R.plurals.models_find, models.size, models.size)) })
        if (offered.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            offered.forEach { trait -> FilterChip(trait in only, { only = if (trait in only) only - trait else only + trait }, { Text(stringResource(traitLabels.getValue(trait))) }, enabled = enabled) }
        }
        if (rows.isEmpty()) Text(stringResource(R.string.models_none), style = MaterialTheme.typography.bodySmall)
    }
    rows.take(shown).forEach { option ->
        Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target).selectable(selected = chosen == option.id, enabled = enabled, role = Role.RadioButton) { choose(option) }.padding(vertical = PALLayout.tight), verticalAlignment = Alignment.CenterVertically) {
            RadioButton(chosen == option.id, null, enabled = enabled)
            Spacer(Modifier.width(PALLayout.groupGap))
            Column(Modifier.weight(1f)) {
                Text(option.displayName)
                val said = option.detail.ifBlank { option.description }
                if (said.isNotBlank()) Text(said, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (chosen == option.id) option.expires?.let { Text(stringResource(R.string.models_ends, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
            }
        }
    }
    if (rows.size > shown) (rows.size - shown).let { rest -> TextButton({ shown += PAGE }, Modifier.heightIn(min = PALLayout.target), enabled = enabled) { Text(pluralStringResource(R.plurals.models_more, rest, rest)) } }
}

/** Who serves one OpenRouter model, and which of them are asked first. The question is free and names only the model. */
@Composable
internal fun ModelUpstreams(repository: PALRepository, connectionId: String?, model: String, options: JsonObject, enabled: Boolean, change: (JsonObject) -> Unit) {
    val scope = rememberOwnerScope()
    var asked by rememberSaveable { mutableStateOf<String?>(null) }
    var served by remember { mutableStateOf<List<JsonObject>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val preferred = (options["preferredProviders"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()
    fun load(id: String) {
        busy = true; error = null; served = null
        scope.launch {
            ownerCall { (repository.request("owner.connections.modelEndpoints", buildJsonObject { connectionId?.let { put("connectionId", it) }; put("model", id) }) as JsonObject).list("endpoints") }
                .onSuccess { if (asked == id) served = it }.onFailure { if (asked == id) error = it.message }
            busy = false
        }
    }
    TextButton({ asked = model }, enabled = enabled && model.contains('/'), modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.models_served)) }
    asked?.let { id ->
        LaunchedEffect(id) { load(id) }
        ToolDialog(stringResource(R.string.models_served_title, id), { asked = null }, busy = busy, error = error) {
            if (!busy && served?.isEmpty() == true) Text(stringResource(R.string.models_served_none))
            served?.forEach { row -> Upstream(row, row.str("slug").orEmpty() in preferred, enabled) { slug ->
                val next = if (slug in preferred) preferred - slug else preferred + slug
                change(JsonObject(if (next.isEmpty()) options - "preferredProviders" else options + ("preferredProviders" to JsonArray(next.map(::JsonPrimitive)))))
            } }
            if (!served.isNullOrEmpty()) Text(stringResource(R.string.models_served_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Upstream(row: JsonObject, preferred: Boolean, enabled: Boolean, toggle: (String) -> Unit) {
    val strings = LocalResources.current
    val provider = row.str("provider").orEmpty(); val slug = row.str("slug").orEmpty(); val detail = row.str("detail").orEmpty()
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        Column(Modifier.weight(1f)) {
            Text(provider + if (slug.isNotEmpty()) " · $slug" else "")
            Text(if (row.isTrue("available")) detail else stringResource(R.string.models_unavailable, detail), style = MaterialTheme.typography.bodySmall,
                color = if (row.isTrue("available")) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.tertiary)
        }
        if (slug.isNotEmpty()) FilterChip(preferred, { toggle(slug) }, { Text(stringResource(if (preferred) R.string.models_preferred else R.string.models_prefer)) }, enabled = enabled,
            modifier = Modifier.semantics { contentDescription = strings.getString(R.string.models_prefer_one, provider) })
    }
}
