package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.ModelCatalog
import dev.otectus.pal.mobile.data.ModelSearch
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.traits
import dev.otectus.pal.mobile.protocol.ModelOption

/** Where the models of a field come from: what they belong to, and how they are asked for. */
internal class ModelSource(val key: Any, val load: suspend () -> ModelCatalog)

/** The models a provider's account has for one use, asked through the desktop. Null when this desktop has no such list. */
internal fun modelSource(repository: PALRepository?, state: MobileState, provider: String, use: String = "chat", connectionId: String = "", task: String? = null): ModelSource? {
    if (repository == null || provider !in state.providers || !state.supports("providers.models") || use != "chat" && !state.has("models.uses")) return null
    return ModelSource(listOf(provider, use, connectionId, task)) { repository.modelsFor(provider, use, connectionId.takeIf(String::isNotBlank), task) }
}

/** The models of several providers as one list, each saying whose it is. */
internal fun modelSource(repository: PALRepository?, state: MobileState, providers: List<String>): ModelSource? {
    val sources = providers.distinct().mapNotNull { id -> modelSource(repository, state, id)?.let { id to it } }
    if (sources.size < 2) return sources.firstOrNull()?.second
    return ModelSource(sources.map { it.first }) {
        val found = sources.map { (id, source) -> id to ownerCall { source.load() } }
        ModelCatalog(found.flatMap { (id, result) -> result.getOrNull()?.models.orEmpty().map { it.copy(detail = listOf(state.traits(id).label, it.detail).filter(String::isNotBlank).joinToString(" · ")) } },
            problem = found.firstNotNullOfOrNull { (id, result) -> result.exceptionOrNull()?.let { "${state.traits(id).label}: ${it.message.orEmpty()}" } })
    }
}

private const val PAGE = 30

/**
 * A model chosen from a drop-down list, or typed: typing narrows the list, and an ID it does not have is used as it is.
 * The list is asked for when it is first opened, because asking can be a request to the provider.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ModelField(
    value: String, change: (String) -> Unit, label: String, source: ModelSource?, modifier: Modifier = Modifier,
    given: List<ModelOption> = emptyList(), none: String? = null, enabled: Boolean = true, isError: Boolean = false, supporting: String? = null, maximum: Int = 512,
) {
    val owner = source?.key
    var open by remember { mutableStateOf(false) }
    var typing by remember { mutableStateOf(false) }
    var asked by remember(owner) { mutableIntStateOf(0) }
    var catalog by remember(owner) { mutableStateOf<ModelCatalog?>(null) }
    var problem by remember(owner) { mutableStateOf<String?>(null) }
    var loading by remember(owner) { mutableStateOf(false) }
    LaunchedEffect(owner, asked) {
        if (asked == 0 || source == null) return@LaunchedEffect
        loading = true; problem = null
        ownerCall { source.load() }.onSuccess { catalog = it; problem = it.problem }.onFailure { problem = it.message }
        loading = false
    }
    val chosen = value.trim()
    val models = remember(catalog, given) { given + catalog?.models.orEmpty().filter { found -> given.none { it.id == found.id } } }
    val ends = models.firstOrNull { it.id == chosen }?.expires?.let { stringResource(R.string.models_ends, it) }
    val said: (@Composable () -> Unit)? = (supporting ?: ends)?.let { text -> { Text(text) } }
    // Without a list there is nothing to drop down, and the field is only typed.
    val listed = enabled && (source != null || given.isNotEmpty())
    // What is typed narrows the list; the model a field already had does not.
    val query = if (typing) chosen else ""
    val rows = remember(models, query, chosen) { ModelSearch.find(models, query, emptySet(), chosen) }
    var shown by remember(query, owner) { mutableIntStateOf(PAGE) }
    fun show(wanted: Boolean, narrowing: Boolean = false) { open = wanted && listed; typing = narrowing; if (open && asked == 0) asked = 1 }
    fun choose(id: String) { change(id); open = false; typing = false }
    ExposedDropdownMenuBox(open, { show(it) }, modifier.fillMaxWidth()) {
        OutlinedTextField(value, { change(it.take(maximum)); show(true, narrowing = true) }, Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryEditable, listed),
            enabled = enabled, singleLine = true, isError = isError, label = { Text(label) }, supportingText = said,
            trailingIcon = if (listed) { { ExposedDropdownMenuDefaults.TrailingIcon(open, Modifier.menuAnchor(ExposedDropdownMenuAnchorType.SecondaryEditable, true)) } } else null)
        // Low enough to fit beside the field while the keyboard is open, so that what is typed stays in sight.
        ExposedDropdownMenu(open && listed, { open = false }, Modifier.heightIn(max = LocalResources.current.displayMetrics.let { it.heightPixels / it.density * .25f }.dp)) {
            if (none != null) DropdownMenuItem({ Text(none) }, { choose("") }, trailingIcon = if (chosen.isEmpty()) { { Icon(Icons.Default.Check, null) } } else null, modifier = Modifier.semantics { selected = chosen.isEmpty() })
            rows.take(shown).forEach { row -> key(row.id) {
                val about = listOfNotNull(row.id.takeIf { it != row.displayName }, row.detail.ifBlank { row.description }.takeIf(String::isNotBlank)).joinToString(" · ")
                DropdownMenuItem({ Column(Modifier.padding(vertical = PALLayout.tight)) {
                    Text(row.displayName, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (about.isNotEmpty()) Text(about, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                } }, { choose(row.id) }, trailingIcon = if (row.id == chosen) { { Icon(Icons.Default.Check, null) } } else null, modifier = Modifier.semantics { selected = row.id == chosen })
            } }
            if (rows.size > shown) (rows.size - shown).let { rest -> DropdownMenuItem({ Text(pluralStringResource(R.plurals.models_more, rest, rest)) }, { shown += PAGE }) }
            val state = when {
                loading -> stringResource(R.string.models_loading)
                problem != null -> problem
                catalog == null && source != null -> null
                models.isEmpty() -> stringResource(if (catalog?.unlisted == true) R.string.models_unlisted else R.string.models_empty)
                rows.isEmpty() -> stringResource(R.string.models_typed)
                else -> null
            }
            state?.let { DropdownMenuItem({ Text(it, style = MaterialTheme.typography.bodySmall) }, {}, enabled = false) }
            if (source != null && asked > 0 && !loading) DropdownMenuItem({ Text(stringResource(R.string.models_refresh)) }, { asked++ }, leadingIcon = { Icon(Icons.Default.Refresh, null) })
        }
    }
}
