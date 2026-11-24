@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale

/** What becomes a document: something written here, a reply, or a kept file. */
internal sealed interface DocumentSource {
    data object Blank : DocumentSource
    data class Reply(val markdown: String) : DocumentSource
    data class Kept(val artifactId: String, val versionId: String?, val name: String) : DocumentSource
}
internal fun documentsOffered(state: MobileState) = state.owner && state.supports("workbench.documents.render") && state.supports("workbench.documents.formats")
/** A phone in the United States or Canada prints on Letter. */
internal fun defaultPage(locale: Locale) = if (locale.country in setOf("US", "CA")) "Letter" else "A4"

/** Writes a document from a template, or exports a reply or a file as PDF, Word, a web page or Markdown. */
@Composable
internal fun DocumentDialog(repository: PALRepository, activity: FragmentActivity, sessionId: String, source: DocumentSource, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope(); val context = LocalContext.current; val strings = LocalResources.current
    var formats by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var templates by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var result by remember { mutableStateOf<JsonObject?>(null) }
    var kept by remember { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    LaunchedEffect(Unit) { ownerCall { repository.read("workbench.documents.formats", buildJsonObject {}) as JsonObject }.onSuccess { formats = it.list("formats"); templates = it.list("templates") }.onFailure { error = it.message } }
    fun run(work: suspend () -> Unit) = scope.launch { busy = true; error = null; notice = null; try { work() } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } finally { busy = false } }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri: Uri? ->
        val value = pending; pending = null
        if (uri != null && value != null) run { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(value.second) } ?: error(strings.getString(R.string.work_could_not_open_the_chosen_file)) }; notice = strings.getString(R.string.work_saved_to_this_phone, value.first) }
    }
    suspend fun fetch(): Pair<String, ByteArray> { val made = result ?: error(""); return made.str("name").orEmpty() to downloadArtifact(strings, repository, sessionId, made.str("artifactId").orEmpty(), made.str("versionId"), "original").second }
    val origin: JsonObjectBuilder.(String) -> Unit = { text -> when (source) {
        is DocumentSource.Kept -> { put("artifactId", source.artifactId); source.versionId?.let { put("versionId", it) } }
        is DocumentSource.Reply -> put("markdown", source.markdown)
        DocumentSource.Blank -> put("markdown", text)
    } }
    DocumentForm(source, formats, templates, result, busy, error, notice, dismiss,
        fill = { template, title, filled -> run { val value = repository.read("workbench.documents.fill", buildJsonObject { put("sessionId", sessionId); put("template", template); if (title.isNotBlank()) put("title", title) }) as JsonObject; filled(value.str("markdown").orEmpty(), value.str("title").orEmpty()) } },
        keep = { title, text -> run {
            kept = signed(activity, repository, "workbench.documents.save", buildJsonObject { put("sessionId", sessionId); put("title", title.ifBlank { strings.getString(R.string.docs_untitled) }); put("markdown", text); kept?.let { put("artifactId", it.str("artifactId")); put("versionId", it.str("versionId")) } }, strings.getString(R.string.docs_keep)) as JsonObject
            notice = strings.getString(R.string.docs_kept, kept?.str("name").orEmpty())
        } },
        make = { title, text, format, page -> run {
            result = signed(activity, repository, "workbench.documents.render", buildJsonObject { put("sessionId", sessionId); put("format", format); put("page", page); if (title.isNotBlank()) put("title", title); origin(text) }, strings.getString(R.string.docs_make)) as JsonObject
            notice = strings.getString(R.string.docs_made, result?.str("name").orEmpty())
        } },
        saveHere = { run { val made = fetch(); pending = made; save.launch(made.first) } },
        share = { run {
            val (name, bytes) = fetch()
            val uri = withContext(Dispatchers.IO) { sharedFile(context, name, "document", bytes) }
            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(result?.str("mime") ?: "application/octet-stream").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
        } })
}

@Composable
internal fun DocumentForm(source: DocumentSource, formats: List<JsonObject>, templates: List<JsonObject>, result: JsonObject?, busy: Boolean, error: String?, notice: String?, dismiss: () -> Unit,
    fill: (String, String, (String, String) -> Unit) -> Unit, keep: (String, String) -> Unit, make: (String, String, String, String) -> Unit, saveHere: () -> Unit, share: () -> Unit) {
    val writing = source == DocumentSource.Blank
    var title by rememberSaveable { mutableStateOf("") }
    var text by rememberSaveable { mutableStateOf("") }
    var page by rememberSaveable { mutableStateOf(defaultPage(Locale.getDefault())) }
    var format by rememberSaveable { mutableStateOf("") }
    var replacing by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(formats) { if (format.isBlank()) format = formats.firstOrNull { it.isTrue("available") }?.str("id").orEmpty() }
    val chosen = formats.firstOrNull { it.str("id") == format }
    fun apply(template: JsonObject) = fill(template.str("id").orEmpty(), title) { filled, suggested -> text = filled; if (title.isBlank()) title = suggested }
    ToolDialog(stringResource(if (writing) R.string.docs_write else R.string.docs_export), dismiss, { TextButton({ make(title.trim(), text, format, page) }, enabled = !busy && chosen?.isTrue("available") == true && (!writing || text.isNotBlank())) { Text(stringResource(R.string.docs_make)) } }, busy, error) {
        if (source is DocumentSource.Kept) Text(stringResource(R.string.docs_from, source.name), style = MaterialTheme.typography.bodySmall)
        if (!writing) Text(stringResource(R.string.docs_original_stays), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(title, { title = it.take(200) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(if (writing) R.string.docs_title else R.string.docs_title_optional)) })
        if (writing) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { templates.forEach { template -> AssistChip({ if (text.isBlank()) apply(template) else replacing = template }, { Text(template.str("name").orEmpty()) }, enabled = !busy) } }
            OutlinedTextField(text, { text = it.take(120_000) }, Modifier.fillMaxWidth().heightIn(min = PALLayout.shortField), label = { Text(stringResource(R.string.docs_markdown)) }, textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
            OutlinedButton({ keep(title.trim(), text) }, enabled = !busy && text.isNotBlank(), modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.docs_keep)) }
        }
        formats.forEach { item ->
            Choice(item.str("label").orEmpty(), format == item.str("id")) { format = item.str("id").orEmpty() }
            if (format == item.str("id") && !item.isTrue("available")) Text(item.str("reason").orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        if (format in setOf("pdf", "docx")) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("A4", "Letter").forEach { size -> FilterChip(page == size, { page = size }, { Text(size) }) } }
        notice?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall) }
        if (result != null) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            OutlinedButton(saveHere, enabled = !busy) { Text(stringResource(R.string.docs_save_here)) }
            OutlinedButton(share, enabled = !busy) { Text(stringResource(R.string.docs_share)) }
        }
    }
    replacing?.let { template -> AlertDialog({ replacing = null }, title = { Text(stringResource(R.string.docs_replace)) }, text = { Text(stringResource(R.string.docs_replace_body)) },
        confirmButton = { TextButton({ replacing = null; apply(template) }) { Text(stringResource(R.string.docs_replace_yes)) } }, dismissButton = { TextButton({ replacing = null }) { Text(stringResource(R.string.action_cancel)) } }) }
}
