@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.graphics.createBitmap
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * What a phone with full access can do with one kept file, several of them, a folder or a command, beyond opening it:
 * the same desktop services as the Workbench, through the same signed actions. Originals are never overwritten.
 */
internal enum class ArtifactTool(val label: Int) {
    Read(R.string.tools_read), Table(R.string.tools_table), Translate(R.string.tools_translate), Details(R.string.tools_details), Ocr(R.string.tools_ocr), Ask(R.string.tools_ask),
    Edit(R.string.tools_edit_title), Transform(R.string.tools_transform), Mask(R.string.tools_mask), Folder(R.string.tools_folder), Collection(R.string.tools_collection), Document(R.string.docs_export_menu), Media(R.string.media_open), Skill(R.string.extras_skill_import), Remove(R.string.tools_remove),
}
private val operations = mapOf(
    ArtifactTool.Read to "workbench.artifacts.extract", ArtifactTool.Table to "owner.tables.preview", ArtifactTool.Translate to "owner.translate", ArtifactTool.Details to "workbench.images.inspect",
    ArtifactTool.Ocr to "workbench.images.ocr", ArtifactTool.Ask to "workbench.images.analyze", ArtifactTool.Edit to "workbench.images.generate", ArtifactTool.Transform to "workbench.images.transform", ArtifactTool.Mask to "workbench.images.mask",
    ArtifactTool.Document to "workbench.documents.render", ArtifactTool.Media to "workbench.recordings.open",
    ArtifactTool.Folder to "workbench.artifacts.export", ArtifactTool.Collection to "owner.collections.addArtifact", ArtifactTool.Skill to "owner.skills.importArtifact", ArtifactTool.Remove to "workbench.artifacts.remove",
)
/** The actions that apply to this file and that the desktop offers. */
internal fun artifactTools(state: MobileState, name: String, mime: String, kind: String): List<ArtifactTool> {
    val image = kind == "image" || kind == "plot" || mime.startsWith("image/")
    val recording = mime.startsWith("audio/") || mime.startsWith("video/")
    val table = Regex("\\.(csv|tsv)$", RegexOption.IGNORE_CASE).containsMatchIn(name) || mime.contains("csv") || mime.contains("tab-separated")
    val textual = mime.startsWith("text/") || Regex("json|markdown|xml|vtt|subrip").containsMatchIn(mime)
    return ArtifactTool.entries.filter { tool ->
        state.supports(operations.getValue(tool)) && when (tool) {
            ArtifactTool.Read -> !image && !recording && mime != "application/octet-stream"
            ArtifactTool.Table -> table
            ArtifactTool.Translate, ArtifactTool.Collection -> textual
            ArtifactTool.Document -> textual && !Regex("html|xml|json").containsMatchIn(mime)
            ArtifactTool.Media -> recording || Regex("vtt|subrip").containsMatchIn(mime)
            ArtifactTool.Details, ArtifactTool.Ocr, ArtifactTool.Ask, ArtifactTool.Edit, ArtifactTool.Transform, ArtifactTool.Mask -> image
            ArtifactTool.Skill -> mime == "application/zip" || name.endsWith(".zip", ignoreCase = true)
            ArtifactTool.Folder, ArtifactTool.Remove -> true
        }
    }
}

/** A command line as typed, split into a program and arguments exactly as the desktop's Runs pane splits it (qml/CommandLine.js). */
internal object CommandLine {
    data class Parsed(val argv: List<String>, val openQuote: Boolean = false, val operator: String? = null)
    private val operators = setOf("|", "||", "&", "&&", ";", ">", ">>", "<", "2>", "2>&1")
    fun split(text: String): Parsed {
        val words = mutableListOf<String>(); val word = StringBuilder(); var started = false; var quote: Char? = null; var index = 0
        while (index < text.length) {
            val c = text[index]
            when {
                quote != null -> when {
                    c == quote -> quote = null
                    c == '\\' && quote == '"' && index + 1 < text.length && text[index + 1] in "\"\\" -> word.append(text[++index])
                    else -> word.append(c)
                }
                c == '\'' || c == '"' -> { quote = c; started = true }
                c == '\\' && index + 1 < text.length -> { word.append(text[++index]); started = true }
                c.isWhitespace() -> { if (started) words += word.toString(); word.clear(); started = false }
                else -> { word.append(c); started = true }
            }
            index++
        }
        if (quote != null) return Parsed(emptyList(), openQuote = true)
        if (started) words += word.toString()
        val bare = text.replace(Regex("\\\\."), "x").replace(Regex("'[^']*'|\"[^\"]*\""), "x").split(Regex("\\s+"))
        return Parsed(words, operator = bare.firstOrNull { it in operators })
    }
}

/** One modal with a scrolling body; its actions stay below the keyboard-safe area. */
@Composable
internal fun ToolDialog(title: String, dismiss: () -> Unit, confirm: (@Composable () -> Unit)? = null, busy: Boolean = false, error: String? = null, content: @Composable ColumnScope.() -> Unit) {
    AlertDialog({ if (!busy) dismiss() }, title = { Text(title, maxLines = 3, overflow = TextOverflow.Ellipsis) }, text = {
        Column(Modifier.heightIn(max = PALLayout.dialogBodyHeight).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            content()
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        }
    }, confirmButton = { confirm?.invoke() ?: TextButton(dismiss) { Text(stringResource(R.string.action_close)) } },
        dismissButton = confirm?.let { { TextButton(dismiss, enabled = !busy) { Text(stringResource(R.string.action_cancel)) } } })
}
@Composable
internal fun ToolCheck(label: String, checked: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target).toggleable(checked, role = Role.Switch, onValueChange = change), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f)); Switch(checked, null)
    }
}
private class ToolRun(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    /** One desktop call at a time; its failure is shown in the dialog that made it. */
    fun start(work: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch { try { work() } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } finally { busy = false } }
    }
}
@Composable private fun rememberToolRun(): ToolRun { val scope = rememberCoroutineScope(); return remember { ToolRun(scope) } }
private fun ref(sessionId: String, artifactId: String, versionId: String?, extra: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
    put("sessionId", sessionId); put("artifactId", artifactId); versionId?.let { put("versionId", it) }; extra()
}

/** The actions for one library file, and the dialogs they open. */
@Composable
internal fun ArtifactToolsRow(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, artifact: JsonObject, preview: Bitmap?,
    info: (String) -> Unit, reload: () -> Unit, removed: () -> Unit) {
    val id = artifact.str("id") ?: artifact.str("artifactId").orEmpty()
    val latest = artifact.obj("latest")
    val name = artifact.str("name") ?: latest?.str("name").orEmpty()
    val tools = artifactTools(state, name, latest?.str("mime").orEmpty(), latest?.str("kind").orEmpty())
    var tool by remember(id) { mutableStateOf<ArtifactTool?>(null) }
    // A mask painted here belongs to this exact version and is offered to the next edit of it.
    var mask by remember(id, latest?.str("versionId")) { mutableStateOf<Pair<String, String>?>(null) }
    if (tools.isEmpty()) return
    Text(stringResource(R.string.tools_more), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        tools.filter { it != ArtifactTool.Mask || preview != null }.forEach { item -> AssistChip({ tool = item }, { Text(stringResource(item.label)) }) }
    }
    tool?.let { chosen ->
        if (chosen == ArtifactTool.Media) RecordingScreen(repository, state, activity, sessionId, OpenRecording(id, latest?.str("versionId"), null)) { tool = null; reload() }
        else if (chosen == ArtifactTool.Document) DocumentDialog(repository, activity, sessionId, DocumentSource.Kept(id, latest?.str("versionId"), name)) { tool = null; reload() }
        else if (chosen == ArtifactTool.Edit) ImageMaker(repository, activity, sessionId, latest?.str("versionId")?.let { Triple(id, it, name) }, mask, { tool = null }) { message -> tool = null; mask = null; info(message) }
        else ArtifactToolDialog(chosen, repository, activity, sessionId, id, latest?.str("versionId"), name, latest, preview, { tool = null },
            { message -> tool = null; info(message); reload() }, { message -> tool = null; info(message); removed() },
            { maskId, maskVersion -> mask = maskId to maskVersion; tool = ArtifactTool.Edit.takeIf { it in tools } })
    }
}

@Composable
internal fun ArtifactToolDialog(tool: ArtifactTool, repository: PALRepository, activity: FragmentActivity, sessionId: String, artifactId: String, versionId: String?, name: String, version: JsonObject?,
    preview: Bitmap?, dismiss: () -> Unit, done: (String) -> Unit, removed: (String) -> Unit, editWithMask: (String, String) -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    when (tool) {
        ArtifactTool.Read -> ReadDialog(repository, activity, sessionId, artifactId, versionId, name, version?.str("mime") == "application/pdf", dismiss)
        ArtifactTool.Table -> {
            var table by remember { mutableStateOf<JsonObject?>(null) }
            LaunchedEffect(Unit) { run.start { table = repository.read("owner.tables.preview", ref(sessionId, artifactId, versionId)) as JsonObject } }
            ToolDialog(name, dismiss, busy = run.busy, error = run.error) { table?.let { TableContent(it) } }
        }
        ArtifactTool.Translate -> {
            var language by rememberSaveable { mutableStateOf("") }
            var glossary by rememberSaveable { mutableStateOf("") }
            ToolDialog(stringResource(R.string.tools_translate_title, name), dismiss, busy = run.busy, error = run.error, confirm = {
                Button({ run.start {
                    val pairs = glossary.lines().mapNotNull { line -> line.split('=', limit = 2).takeIf { it.size == 2 && it[0].isNotBlank() }?.let { buildJsonObject { put("source", it[0].trim()); put("target", it[1].trim()) } } }
                    val result = repository.mutate("owner.translate", buildJsonObject {
                        put("sessionId", sessionId); put("targetLanguage", language.trim()); if (pairs.isNotEmpty()) put("glossary", JsonArray(pairs))
                        put("input", buildJsonObject { put("kind", "artifact"); put("artifactId", artifactId); versionId?.let { put("versionId", it) } })
                    }) as JsonObject
                    check(result.str("status") == "completed") { result.str("summary").orEmpty() }
                    done(result.str("summary").orEmpty())
                } }, enabled = !run.busy && language.trim().length >= 2) { Text(stringResource(R.string.tools_translate)) }
            }) {
                Text(stringResource(R.string.tools_translate_hint), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(language, { language = it.take(40) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.tools_language)) })
                OutlinedTextField(glossary, { glossary = it.take(4000) }, Modifier.fillMaxWidth(), minLines = 2, label = { Text(stringResource(R.string.tools_glossary)) })
            }
        }
        ArtifactTool.Details -> {
            var value by remember { mutableStateOf<JsonObject?>(null) }
            LaunchedEffect(Unit) { run.start { value = repository.read("workbench.images.inspect", ref(sessionId, artifactId, versionId)) as JsonObject } }
            ToolDialog(name, dismiss, busy = run.busy, error = run.error) { value?.let { ImageDetails(it) } }
        }
        ArtifactTool.Ocr -> {
            var lines by remember { mutableStateOf<List<String>?>(null) }
            LaunchedEffect(Unit) { run.start { lines = (repository.read("workbench.images.ocr", ref(sessionId, artifactId, versionId)) as JsonObject).list("lines").mapNotNull { it.str("text") } } }
            ToolDialog(stringResource(R.string.tools_ocr), dismiss, busy = run.busy, error = run.error) {
                lines?.let { found -> if (found.isEmpty()) Text(stringResource(R.string.tools_ocr_empty)) else { SelectionContainer { Text(found.joinToString("\n")) }; TextActions(found.joinToString("\n")) } }
            }
        }
        ArtifactTool.Ask -> {
            var question by rememberSaveable { mutableStateOf("") }
            var answer by remember { mutableStateOf<String?>(null) }
            ToolDialog(stringResource(R.string.tools_ask_title), dismiss, busy = run.busy, error = run.error, confirm = {
                Button({ run.start {
                    answer = (signed(activity, repository, "workbench.images.analyze", ref(sessionId, artifactId, versionId) { put("question", question.trim().ifEmpty { strings.getString(R.string.tools_ask_default) }) }, strings.getString(R.string.tools_ask_action)) as JsonObject).str("answer")
                } }, enabled = !run.busy) { Text(stringResource(R.string.tools_ask_button)) }
            }) {
                Text(stringResource(R.string.tools_ask_hint), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(question, { question = it.take(2000) }, Modifier.fillMaxWidth(), minLines = 2, label = { Text(stringResource(R.string.tools_ask_question)) }, placeholder = { Text(stringResource(R.string.tools_ask_default)) })
                answer?.let { SelectionContainer { Text(it) }; TextActions(it) }
            }
        }
        ArtifactTool.Transform -> TransformDialog(version?.obj("image"), run, dismiss) { steps ->
            run.start {
                signed(activity, repository, "workbench.images.transform", ref(sessionId, artifactId, versionId) { put("steps", steps) }, strings.getString(R.string.tools_transform_action))
                done(strings.getString(R.string.tools_transform_done))
            }
        }
        ArtifactTool.Mask -> {
            val size = version?.obj("image")
            if (preview != null) PaintMask(preview, size?.int("width") ?: preview.width, size?.int("height") ?: preview.height, run.busy, run.error, dismiss) { png -> run.start {
                val inline = "data:image/png;base64," + android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP)
                val transfer = if (inline.length <= 900_000) null else uploadToDesktop(activity, repository, sessionId, "mask.png", "image/png", png, purpose = "layer").str("transferId")
                val mask = signed(activity, repository, "workbench.images.mask", ref(sessionId, artifactId, versionId) { if (transfer == null) put("mask", inline) else put("maskTransferId", transfer) }, strings.getString(R.string.tools_mask_action)) as JsonObject
                done(strings.getString(R.string.tools_mask_done))
                editWithMask(mask.str("artifactId").orEmpty(), mask.str("versionId").orEmpty())
            } }
        }
        ArtifactTool.Folder -> {
            var roots by remember { mutableStateOf<List<JsonObject>?>(null) }
            var rootId by rememberSaveable { mutableStateOf("") }
            var path by rememberSaveable { mutableStateOf(name) }
            LaunchedEffect(Unit) { run.start {
                roots = (repository.read("workbench.roots", buildJsonObject { put("sessionId", sessionId) }) as JsonObject).list("roots").filter { it.obj("policy")?.isTrue("write") == true && it.str("status") != "missing" }
                if (rootId.isEmpty()) rootId = roots.orEmpty().firstOrNull()?.str("id").orEmpty()
            } }
            ToolDialog(stringResource(R.string.tools_folder_title, name), dismiss, busy = run.busy, error = run.error, confirm = {
                Button({ run.start {
                    signed(activity, repository, "workbench.artifacts.export", buildJsonObject { put("sessionId", sessionId); put("artifactId", artifactId); put("versionId", versionId.orEmpty()); put("rootId", rootId); put("path", path.trim()) }, strings.getString(R.string.tools_folder_action))
                    done(strings.getString(R.string.tools_folder_done))
                } }, enabled = !run.busy && rootId.isNotEmpty() && path.isNotBlank() && versionId != null) { Text(stringResource(R.string.tools_review_change)) }
            }) {
                Text(stringResource(R.string.tools_folder_hint), style = MaterialTheme.typography.bodySmall)
                if (roots?.isEmpty() == true) Text(stringResource(R.string.tools_folder_none), color = MaterialTheme.colorScheme.tertiary)
                roots.orEmpty().forEach { root -> Choice(root.str("name").orEmpty(), root.str("id") == rootId) { rootId = root.str("id").orEmpty() } }
                if (!roots.isNullOrEmpty()) OutlinedTextField(path, { path = it.take(1024) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.tools_folder_path)) })
            }
        }
        ArtifactTool.Collection -> {
            var collections by remember { mutableStateOf<List<JsonObject>?>(null) }
            var chosen by rememberSaveable { mutableStateOf("") }
            LaunchedEffect(Unit) { run.start { val value = repository.request("owner.collections.list", buildJsonObject {}); collections = (value as? JsonObject)?.list("collections") ?: value.objects() } }
            ToolDialog(stringResource(R.string.tools_collection_title), dismiss, busy = run.busy, error = run.error, confirm = {
                val target = collections.orEmpty().firstOrNull { it.str("id") == chosen }
                Button({ run.start {
                    val label = target?.str("name").orEmpty()
                    signed(activity, repository, "owner.collections.addArtifact", ref(sessionId, artifactId, versionId) { put("id", chosen) }, strings.getString(R.string.tools_collection_action, label))
                    done(strings.getString(R.string.tools_collection_done, label))
                } }, enabled = !run.busy && target != null) { Text(stringResource(R.string.tools_collection)) }
            }) {
                Text(stringResource(R.string.tools_collection_hint), style = MaterialTheme.typography.bodySmall)
                if (collections?.isEmpty() == true) Text(stringResource(R.string.tools_collection_none))
                collections.orEmpty().forEach { item -> Choice(item.str("name").orEmpty(), item.str("id") == chosen) { chosen = item.str("id").orEmpty() } }
            }
        }
        ArtifactTool.Skill -> ToolDialog(stringResource(R.string.extras_skill_import), dismiss, busy = run.busy, error = run.error, confirm = {
            Button({ run.start {
                signed(activity, repository, "owner.skills.importArtifact", ref(sessionId, artifactId, versionId), strings.getString(R.string.extras_skill_import_action))
                done(strings.getString(R.string.extras_skill_imported))
            } }, enabled = !run.busy) { Text(stringResource(R.string.computer_import)) }
        }) { Text(stringResource(R.string.extras_skill_import_hint)) }
        ArtifactTool.Edit, ArtifactTool.Document, ArtifactTool.Media -> Unit
        ArtifactTool.Remove -> ToolDialog(stringResource(R.string.tools_remove_title), dismiss, busy = run.busy, error = run.error, confirm = {
            Button({ run.start {
                signed(activity, repository, "workbench.artifacts.remove", buildJsonObject { put("sessionId", sessionId); put("artifactId", artifactId) }, strings.getString(R.string.tools_remove_action))
                removed(strings.getString(R.string.tools_removed))
            } }, enabled = !run.busy) { Text(stringResource(R.string.action_remove)) }
        }) { Text(stringResource(R.string.tools_remove_body, name)) }
    }
}
@Composable
internal fun Choice(label: String, selected: Boolean, choose: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target).selectable(selected, role = Role.RadioButton, onClick = choose), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, null); Spacer(Modifier.width(PALLayout.small)); Text(label, Modifier.weight(1f))
    }
}
/** Copy and share text the desktop read; nothing is kept on the phone. */
@Composable
private fun TextActions(text: String) {
    val context = LocalContext.current
    val label = stringResource(R.string.tools_copy)
    var refused by remember(text) { mutableStateOf(false) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        TextButton({ refused = !copyText(context, label, text) }) { Text(label) }
        TextButton({ refused = !context.open(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text.take(100_000)), null)) }) { Text(stringResource(R.string.tools_share_text)) }
    }
    if (refused) Text(stringResource(R.string.copy_refused), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
}
@Composable
private fun ReadDialog(repository: PALRepository, activity: FragmentActivity, sessionId: String, artifactId: String, versionId: String?, name: String, pages: Boolean, dismiss: () -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    var value by remember { mutableStateOf<JsonObject?>(null) }
    var from by rememberSaveable { mutableStateOf("") }
    var to by rememberSaveable { mutableStateOf("") }
    fun read() = run.start {
        value = signed(activity, repository, "workbench.artifacts.extract", ref(sessionId, artifactId, versionId) {
            if (from.isNotBlank() || to.isNotBlank()) put("options", buildJsonObject { from.toIntOrNull()?.let { put("fromPage", it) }; to.toIntOrNull()?.let { put("toPage", it) } })
        }, strings.getString(R.string.tools_read)) as JsonObject
    }
    LaunchedEffect(Unit) { read() }
    ToolDialog(stringResource(R.string.tools_read_title, name), dismiss, busy = run.busy, error = run.error) {
        if (run.busy && value == null) Text(stringResource(R.string.tools_reading))
        value?.let { ExtractedText(it) }
        if (pages) {
            Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedTextField(from, { from = it.filter(Char::isDigit).take(5) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.tools_from_page)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                OutlinedTextField(to, { to = it.filter(Char::isDigit).take(5) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.tools_to_page)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            }
            TextButton({ read() }, enabled = !run.busy && (from.isNotBlank() || to.isNotBlank())) { Text(stringResource(R.string.tools_read_pages)) }
        }
    }
}
@Composable
internal fun ColumnScope.ExtractedText(value: JsonObject) {
    Text(stringResource(when (value.str("status")) { "complete" -> R.string.tools_read_complete; "partial" -> R.string.tools_read_partial; else -> R.string.tools_read_empty }), style = MaterialTheme.typography.bodySmall)
    value.strings("warnings").forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
    val units = value.list("units")
    SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) { units.forEach { unit ->
        unit.obj("locator")?.takeIf { it.isNotEmpty() }?.let { locator -> Text(locator.entries.joinToString { "${it.key} ${(it.value as? JsonPrimitive)?.contentOrNull.orEmpty()}" }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
        Text(unit.str("text").orEmpty(), style = MaterialTheme.typography.bodySmall)
    } } }
    if (units.isNotEmpty()) TextActions(units.joinToString("\n\n") { it.str("text").orEmpty() })
}
@Composable
internal fun ColumnScope.TableContent(table: JsonObject) {
    val strings = LocalResources.current
    val columns = table.list("columns")
    Text(stringResource(R.string.tools_table_shape, table.int("rows") ?: 0, columns.size), fontWeight = FontWeight.SemiBold)
    table.strings("problems").forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
    columns.forEach { column ->
        Text(strings.getString(R.string.tools_table_column, column.str("name").orEmpty(), column.str("type").orEmpty(), column.int("distinct") ?: 0) + (column.int("missing")?.takeIf { it > 0 }?.let { " · " + strings.getString(R.string.tools_table_missing, it) } ?: ""), style = MaterialTheme.typography.bodySmall)
    }
    (table["sample"] as? JsonArray)?.takeIf { it.isNotEmpty() }?.let { rows ->
        SelectionContainer { Text(rows.joinToString("\n") { row -> (row as? JsonArray).orEmpty().joinToString("   ") { (it as? JsonPrimitive)?.contentOrNull.orEmpty() } }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
    }
}
@Composable
internal fun ColumnScope.ImageDetails(value: JsonObject) {
    val strings = LocalResources.current
    val made = value.obj("provenance")
    listOfNotNull(
        R.string.tools_detail_size to strings.getString(R.string.tools_detail_size_value, value.int("width") ?: 0, value.int("height") ?: 0),
        value.str("format")?.let { R.string.tools_detail_format to it.uppercase() },
        value.str("space")?.let { R.string.tools_detail_space to it },
        R.string.tools_detail_alpha to when { !value.isTrue("alpha") -> strings.getString(R.string.tools_detail_alpha_none); value.str("opaquePercent") != null -> strings.getString(R.string.tools_detail_alpha_percent, value.str("opaquePercent")); else -> strings.getString(R.string.tools_detail_alpha_yes) },
        value.int("frames")?.let { R.string.tools_detail_frames to it.toString() },
        listOfNotNull(made?.str("kind"), made?.str("connection") ?: made?.str("backend"), made?.str("model")).takeIf { it.isNotEmpty() }?.let { R.string.tools_detail_origin to it.joinToString(" · ") },
        made?.str("prompt")?.let { R.string.tools_detail_prompt to it },
    ).forEach { (label, text) -> Column { Text(stringResource(label), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(text) } }
    value.str("note")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
}
/** One exact change at a time, described by the desktop's own transform steps. */
@Composable
private fun TransformDialog(size: JsonObject?, run: ToolRun, dismiss: () -> Unit, apply: (JsonArray) -> Unit) {
    var kind by rememberSaveable { mutableStateOf("rotate90") }
    val fullWidth = size?.int("width") ?: 0; val fullHeight = size?.int("height") ?: 0
    var width by rememberSaveable { mutableStateOf(fullWidth.takeIf { it > 0 }?.toString().orEmpty()) }
    var height by rememberSaveable { mutableStateOf(fullHeight.takeIf { it > 0 }?.toString().orEmpty()) }
    var left by rememberSaveable { mutableStateOf("0") }
    var top by rememberSaveable { mutableStateOf("0") }
    var format by rememberSaveable { mutableStateOf("png") }
    fun number(text: String) = text.toIntOrNull()
    val step = when (kind) {
        "rotate90" -> buildJsonObject { put("op", "rotate"); put("degrees", 90) }
        "rotate270" -> buildJsonObject { put("op", "rotate"); put("degrees", 270) }
        "rotate180" -> buildJsonObject { put("op", "rotate"); put("degrees", 180) }
        "flipH" -> buildJsonObject { put("op", "flip"); put("axis", "horizontal") }
        "flipV" -> buildJsonObject { put("op", "flip"); put("axis", "vertical") }
        "resize" -> if ((number(width) ?: 0) > 0 && (number(height) ?: 0) > 0) buildJsonObject { put("op", "resize"); put("width", number(width)); put("height", number(height)); put("fit", "inside") } else null
        "crop" -> if ((number(width) ?: 0) > 0 && (number(height) ?: 0) > 0 && number(left) != null && number(top) != null) buildJsonObject { put("op", "crop"); put("left", number(left)); put("top", number(top)); put("width", number(width)); put("height", number(height)) } else null
        else -> buildJsonObject { put("op", "format"); put("format", format) }
    }
    ToolDialog(stringResource(R.string.tools_transform_title), dismiss, busy = run.busy, error = run.error, confirm = {
        Button({ step?.let { apply(JsonArray(listOf(it))) } }, enabled = !run.busy && step != null) { Text(stringResource(R.string.computer_apply_2)) }
    }) {
        Text(stringResource(R.string.tools_transform_hint), style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            listOf("rotate90" to R.string.tools_turn_right, "rotate270" to R.string.tools_turn_left, "rotate180" to R.string.tools_turn_over, "flipH" to R.string.tools_flip_horizontal, "flipV" to R.string.tools_flip_vertical,
                "resize" to R.string.tools_resize, "crop" to R.string.tools_crop, "format" to R.string.tools_convert).forEach { (id, label) -> FilterChip(kind == id, { kind = id }, { Text(stringResource(label)) }) }
        }
        @Composable fun NumberField(label: Int, value: String, change: (String) -> Unit, modifier: Modifier) =
            OutlinedTextField(value, { change(it.filter(Char::isDigit).take(5)) }, modifier, singleLine = true, label = { Text(stringResource(label)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        if (kind == "crop") Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { NumberField(R.string.tools_left, left, { left = it }, Modifier.weight(1f)); NumberField(R.string.tools_top, top, { top = it }, Modifier.weight(1f)) }
        if (kind == "crop" || kind == "resize") Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { NumberField(R.string.tools_width, width, { width = it }, Modifier.weight(1f)); NumberField(R.string.tools_height, height, { height = it }, Modifier.weight(1f)) }
        if (kind == "format") Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("png", "jpeg", "webp").forEach { id -> FilterChip(format == id, { format = id }, { Text(id.uppercase()) }) } }
    }
}

private data class MaskStroke(val erase: Boolean, val width: Float, val points: List<Offset>)
/**
 * Painting the area to change (PAL Everywhere §15.1): strokes over the preview in image coordinates, saved at the original's
 * exact pixel size as alpha, which is what the desktop's mask check reads. The mask belongs to this exact version.
 */
@Composable
internal fun PaintMask(preview: Bitmap, width: Int, height: Int, busy: Boolean, error: String?, dismiss: () -> Unit, save: (ByteArray) -> Unit) {
    val strings = LocalResources.current
    var strokes by remember { mutableStateOf(listOf<MaskStroke>()) }
    var current by remember { mutableStateOf<MaskStroke?>(null) }
    var erase by remember { mutableStateOf(false) }
    var brush by remember { mutableFloatStateOf(.06f) }
    var tooLarge by remember { mutableStateOf(false) }
    var frame by remember { mutableStateOf(Offset.Zero to Size.Zero) }
    val image = remember(preview) { preview.asImageBitmap() }
    val paint = MaterialTheme.colorScheme.primary
    fun inImage(point: Offset): Offset { val (origin, size) = frame; return Offset(((point.x - origin.x) / size.width.coerceAtLeast(1f)).coerceIn(0f, 1f), ((point.y - origin.y) / size.height.coerceAtLeast(1f)).coerceIn(0f, 1f)) }
    Dialog({ if (!busy) dismiss() }, DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                Text(stringResource(R.string.tools_mask_title), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                Canvas(Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = strings.getString(R.string.tools_mask_canvas) }.pointerInput(Unit) {
                    detectDragGestures(onDragStart = { start -> current = MaskStroke(erase, brush, listOf(inImage(start))) }, onDragEnd = { current?.let { strokes = strokes + it }; current = null }, onDragCancel = { current = null },
                        onDrag = { change, _ -> current = current?.let { it.copy(points = it.points + inImage(change.position)) } })
                }) {
                    val scale = minOf(size.width / image.width, size.height / image.height)
                    val shown = Size(image.width * scale, image.height * scale)
                    val origin = Offset((size.width - shown.width) / 2, (size.height - shown.height) / 2)
                    frame = origin to shown
                    drawImage(image, dstOffset = IntOffset(origin.x.toInt(), origin.y.toInt()), dstSize = IntSize(shown.width.toInt(), shown.height.toInt()))
                    for (stroke in strokes + listOfNotNull(current)) {
                        val path = androidx.compose.ui.graphics.Path()
                        stroke.points.forEachIndexed { index, point -> val x = origin.x + point.x * shown.width; val y = origin.y + point.y * shown.height; if (index == 0) { path.moveTo(x, y); path.lineTo(x + .1f, y) } else path.lineTo(x, y) }
                        drawPath(path, if (stroke.erase) androidx.compose.ui.graphics.Color.Black.copy(alpha = .5f) else paint.copy(alpha = .45f), style = Stroke(width = stroke.width * shown.width, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    }
                }
                Text(stringResource(R.string.tools_brush), style = MaterialTheme.typography.labelMedium)
                Slider(brush, { brush = it }, valueRange = .01f..(.2f), modifier = Modifier.semantics { contentDescription = strings.getString(R.string.tools_brush) })
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    FilterChip(erase, { erase = !erase }, { Text(stringResource(R.string.tools_mask_erase)) })
                    TextButton({ strokes = strokes.dropLast(1) }, enabled = strokes.isNotEmpty()) { Text(stringResource(R.string.annotation_undo)) }
                    TextButton({ strokes = emptyList() }, enabled = strokes.isNotEmpty()) { Text(stringResource(R.string.tools_mask_clear)) }
                }
                (error ?: if (tooLarge) stringResource(R.string.picture_too_large) else null)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.small, Alignment.End)) {
                    TextButton(dismiss, enabled = !busy) { Text(stringResource(R.string.action_cancel)) }
                    Button({
                        tooLarge = false
                        // The mask has the original's own size, which a very large picture leaves no memory for.
                        try { save(renderMask(strokes.map { Triple(it.erase, it.width, it.points.map { p -> p.x to p.y }) }, width, height)) } catch (_: OutOfMemoryError) { tooLarge = true } catch (_: IllegalArgumentException) { tooLarge = true }
                    }, enabled = !busy && strokes.any { !it.erase }) { Text(stringResource(R.string.tools_mask_save)) }
                }
            }
        }
    }
}
/** The painted area as alpha at the original's size: opaque where painted, transparent everywhere else. */
internal fun renderMask(strokes: List<Triple<Boolean, Float, List<Pair<Float, Float>>>>, width: Int, height: Int): ByteArray {
    val layer = createBitmap(width, height)
    val canvas = android.graphics.Canvas(layer)
    for ((erase, brush, points) in strokes) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = android.graphics.Color.WHITE; strokeWidth = brush * width
            if (erase) blendMode = android.graphics.BlendMode.CLEAR
        }
        val path = Path()
        points.forEachIndexed { index, (x, y) -> if (index == 0) { path.moveTo(x * width, y * height); path.lineTo(x * width + .1f, y * height) } else path.lineTo(x * width, y * height) }
        canvas.drawPath(path, paint)
    }
    val out = ByteArrayOutputStream(); layer.compress(Bitmap.CompressFormat.PNG, 100, out); layer.recycle()
    return out.toByteArray()
}

/**
 * A new image, or an edit of one exact version, through the desktop's image services. What the chosen service offers
 * comes from the desktop; Check settings says what it would adjust before anything is sent or billed.
 */
@Composable
internal fun ImageMaker(repository: PALRepository, activity: FragmentActivity, sessionId: String, target: Triple<String, String, String>?, mask: Pair<String, String>?, dismiss: () -> Unit, started: (String) -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var connectionId by rememberSaveable { mutableStateOf("") }
    var summary by remember { mutableStateOf<JsonObject?>(null) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var count by rememberSaveable { mutableIntStateOf(1) }
    var size by rememberSaveable { mutableStateOf("") }
    var ratio by rememberSaveable { mutableStateOf("") }
    var quality by rememberSaveable { mutableStateOf("") }
    var checked by remember { mutableStateOf<String?>(null) }
    var billing by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { run.start {
        connections = (repository.read("workbench.images.connections", buildJsonObject {}) as JsonObject).list("connections").filter { it.isTrue("enabled") }
        if (connectionId.isEmpty()) connectionId = connections.firstOrNull()?.str("id").orEmpty()
    } }
    LaunchedEffect(connectionId) {
        summary = null; checked = null
        if (connectionId.isNotEmpty()) try { summary = (repository.read("workbench.images.capabilities", buildJsonObject { put("connectionId", connectionId) }) as JsonObject).obj("summary") }
        catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { run.error = failure.message }
    }
    fun request() = buildJsonObject {
        put("operation", if (target == null) "generate" else if (mask == null) "edit" else "masked-edit"); put("prompt", prompt.trim()); put("count", count)
        if (size.isNotEmpty()) put("size", size); if (ratio.isNotEmpty()) put("aspectRatio", ratio); if (quality.isNotEmpty()) put("quality", quality)
        put("references", JsonArray(listOfNotNull(target?.let { (id, version, _) -> buildJsonObject { put("artifactId", id); put("versionId", version); put("role", "target") } })))
        mask?.let { (id, version) -> put("mask", buildJsonObject { put("artifactId", id); put("versionId", version) }); put("protectOutside", true) }
    }
    fun send(acknowledge: Boolean) = run.start {
        try {
            signed(activity, repository, "workbench.images.generate", buildJsonObject { put("sessionId", sessionId); put("connectionId", connectionId); put("request", request()); if (acknowledge) put("acknowledgeBilling", true) }, strings.getString(R.string.work_generate_an_image_on_the_desktop))
            started(strings.getString(R.string.work_started_on_the_desktop_its_result_appears_in))
        } catch (failure: IllegalStateException) { if (!acknowledge && failure.message.orEmpty().contains("bill", ignoreCase = true)) billing = failure.message else throw failure }
    }
    ToolDialog(target?.let { stringResource(R.string.tools_target, it.third) } ?: stringResource(R.string.work_create_an_image), dismiss, busy = run.busy, error = run.error, confirm = {
        Button({ send(false) }, enabled = !run.busy && prompt.isNotBlank() && connectionId.isNotEmpty()) { Text(stringResource(R.string.work_generate)) }
    }) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { connections.forEach { c -> FilterChip(c.str("id") == connectionId, { connectionId = c.str("id").orEmpty() }, { Text(c.str("name").orEmpty()) }) } }
        OutlinedTextField(prompt, { prompt = it.take(8000); checked = null }, Modifier.fillMaxWidth(), minLines = 3, label = { Text(stringResource(if (target == null) R.string.work_describe_the_image else R.string.tools_edit_prompt)) })
        if (mask != null) Text(stringResource(R.string.tools_edit_masked), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        fun options(key: String) = (summary?.get(key) as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        @Composable fun Options(values: List<String>, chosen: String, choose: (String) -> Unit) { if (values.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { values.take(12).forEach { value -> FilterChip(chosen == value, { choose(if (chosen == value) "" else value); checked = null }, { Text(value) }) } } }
        Options((1..(summary?.int("maxCount") ?: 1).coerceIn(1, 4)).map(Int::toString), count.toString()) { count = it.toIntOrNull() ?: 1 }
        Options(options("sizes"), size) { size = it }
        Options(options("aspectRatios"), ratio) { ratio = it }
        Options(options("qualities"), quality) { quality = it }
        summary?.str("processes")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        TextButton({ run.start {
            val result = repository.read("workbench.images.preview", buildJsonObject { put("sessionId", sessionId); put("connectionId", connectionId); put("request", request()) }) as JsonObject
            val adjustments = (result["adjustments"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            checked = listOfNotNull(if (adjustments.isEmpty()) strings.getString(R.string.tools_preview_ok) else strings.getString(R.string.tools_preview_adjusted, adjustments.joinToString("; ")),
                result.obj("estimate")?.let { strings.getString(R.string.tools_preview_estimate, it.str("currency").orEmpty(), it.str("total").orEmpty()) }).joinToString("\n")
        } }, enabled = !run.busy && prompt.isNotBlank() && connectionId.isNotEmpty()) { Text(stringResource(R.string.tools_preview_request)) }
        checked?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
    billing?.let { message -> ToolDialog(stringResource(R.string.work_this_image_service_may_bill_you), { billing = null }, confirm = { Button({ billing = null; send(true) }) { Text(stringResource(R.string.work_continue)) } }) { Text(message) } }
}

// ── Several files ────────────────────────────────────────────────────────────────────────────────

/** A ZIP, a contact sheet or one change applied to each of the selected files. */
@Composable
internal fun SelectionTools(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, chosen: List<JsonObject>, info: (String) -> Unit, fail: (String?) -> Unit, finished: () -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    var zip by rememberSaveable { mutableStateOf(false) }
    var batch by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("bundle") }
    val refs = chosen.mapNotNull { item -> val version = item.obj("latest")?.str("versionId") ?: item.str("latestVersionId"); val id = item.str("id") ?: item.str("artifactId"); if (id != null && version != null) id to version else null }
    val images = chosen.filter { it.obj("latest")?.str("kind") in setOf("image", "plot") }
    fun items(list: List<Pair<String, String>>) = JsonArray(list.map { (id, version) -> buildJsonObject { put("artifactId", id); put("versionId", version) } })
    LaunchedEffect(run.error) { run.error?.let(fail) }
    Text(pluralStringResource(R.plurals.tools_selected, chosen.size, chosen.size), style = MaterialTheme.typography.titleSmall)
    if (run.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        if (state.supports("workbench.artifacts.bundle")) OutlinedButton({ zip = true }, enabled = !run.busy && refs.isNotEmpty() && refs.size <= 50) { Text(stringResource(R.string.tools_zip)) }
        if (state.supports("workbench.images.contactSheet")) OutlinedButton({ run.start {
            check(images.size in 1..16) { strings.getString(R.string.tools_sheet_limit) }
            val ids = images.mapNotNull { it.str("id") ?: it.str("artifactId") }.toSet()
            signed(activity, repository, "workbench.images.contactSheet", buildJsonObject { put("sessionId", sessionId); put("items", items(refs.filter { it.first in ids })) }, strings.getString(R.string.tools_sheet_action))
            info(strings.getString(R.string.tools_sheet_done)); finished()
        } }, enabled = !run.busy && images.isNotEmpty()) { Text(stringResource(R.string.tools_sheet)) }
        if (state.supports("workbench.images.transform")) OutlinedButton({ batch = true }, enabled = !run.busy && images.isNotEmpty()) { Text(stringResource(R.string.tools_batch)) }
        TextButton(finished, enabled = !run.busy) { Text(stringResource(R.string.tools_select_done)) }
    }
    if (zip) ToolDialog(stringResource(R.string.tools_zip_title), { zip = false }, busy = run.busy, error = run.error, confirm = {
        Button({ run.start {
            val made = signed(activity, repository, "workbench.artifacts.bundle", buildJsonObject { put("sessionId", sessionId); put("name", name.trim()); put("items", items(refs)) }, strings.getString(R.string.tools_zip_action)) as JsonObject
            zip = false; info(strings.getString(R.string.tools_zip_done, made.str("name") ?: name.trim())); finished()
        } }, enabled = !run.busy && name.isNotBlank()) { Text(stringResource(R.string.tools_zip_title)) }
    }) {
        Text(stringResource(R.string.tools_zip_hint), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(name, { name = it.take(100) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.tools_zip_name)) })
    }
    if (batch) {
        var longest by rememberSaveable { mutableStateOf("1600") }
        var format by rememberSaveable { mutableStateOf("") }
        ToolDialog(stringResource(R.string.tools_batch_title), { batch = false }, busy = run.busy, error = run.error, confirm = {
            Button({ run.start {
                val edge = longest.toIntOrNull()
                val steps = JsonArray(listOfNotNull(
                    edge?.takeIf { it > 0 }?.let { buildJsonObject { put("op", "resize"); put("width", it); put("height", it); put("fit", "inside") } },
                    format.takeIf(String::isNotEmpty)?.let { buildJsonObject { put("op", "format"); put("format", it) } },
                ))
                var changed = 0; var problems = 0
                // Each image is its own signed change, so one that cannot be changed leaves the others done.
                for ((id, version) in refs.filter { (id, _) -> images.any { (it.str("id") ?: it.str("artifactId")) == id } }) {
                    try { signed(activity, repository, "workbench.images.transform", ref(sessionId, id, version) { put("steps", steps) }, strings.getString(R.string.tools_transform_action)); changed++ }
                    catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { problems++ }
                }
                batch = false
                info(strings.getQuantityString(R.plurals.tools_batch_done, changed, changed) + if (problems > 0) " " + strings.getQuantityString(R.plurals.tools_batch_failed, problems, problems) else ""); finished()
            } }, enabled = !run.busy && ((longest.toIntOrNull() ?: 0) in 1..8192 || format.isNotEmpty())) { Text(stringResource(R.string.computer_apply_2)) }
        }) {
            Text(stringResource(R.string.tools_batch_hint), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(longest, { longest = it.filter(Char::isDigit).take(4) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.tools_batch_width)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("png", "jpeg", "webp").forEach { id -> FilterChip(format == id, { format = if (format == id) "" else id }, { Text(id.uppercase()) }) } }
        }
    }
}
/** A blank image to draw on. */
@Composable
internal fun BlankCanvas(repository: PALRepository, activity: FragmentActivity, sessionId: String, dismiss: () -> Unit, done: (String) -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    ToolDialog(stringResource(R.string.tools_sketch), dismiss, busy = run.busy, error = run.error) {
        listOf(Triple(R.string.tools_sketch_square, 1024, 1024), Triple(R.string.tools_sketch_landscape, 1200, 628), Triple(R.string.tools_sketch_portrait, 1080, 1920)).forEach { (label, width, height) ->
            OutlinedButton({ run.start {
                signed(activity, repository, "workbench.images.sketch", buildJsonObject { put("sessionId", sessionId); put("width", width); put("height", height) }, strings.getString(R.string.tools_sketch_action))
                done(strings.getString(R.string.tools_sketch_done))
            } }, Modifier.fillMaxWidth(), enabled = !run.busy) { Text(stringResource(label)) }
        }
    }
}

// ── Runs, folders, changes and the shelf ─────────────────────────────────────────────────────────

/** One program in a folder that allows commands; the desktop isolates it and records its output and changed files. */
@Composable
internal fun RunCommand(repository: PALRepository, activity: FragmentActivity, sessionId: String, dismiss: () -> Unit, started: (String) -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    var roots by remember { mutableStateOf<List<JsonObject>?>(null) }
    var rootId by rememberSaveable { mutableStateOf("") }
    var text by rememberSaveable { mutableStateOf("") }
    var folder by rememberSaveable { mutableStateOf("") }
    var minutes by rememberSaveable { mutableStateOf("5") }
    var network by rememberSaveable { mutableStateOf(false) }
    val parsed = remember(text) { CommandLine.split(text) }
    LaunchedEffect(Unit) { run.start {
        roots = (repository.read("workbench.roots", buildJsonObject { put("sessionId", sessionId) }) as JsonObject).list("roots").filter { it.obj("policy")?.isTrue("execute") == true }
        if (rootId.isEmpty()) rootId = roots.orEmpty().firstOrNull()?.str("id").orEmpty()
    } }
    val problem = when { parsed.openQuote -> stringResource(R.string.tools_command_quote); parsed.operator != null -> stringResource(R.string.tools_command_operator, parsed.operator); parsed.argv.size > 64 -> stringResource(R.string.tools_command_many); else -> null }
    ToolDialog(stringResource(R.string.tools_command), dismiss, busy = run.busy, error = run.error ?: problem, confirm = {
        Button({ run.start {
            signed(activity, repository, "workbench.commands.run", buildJsonObject {
                put("sessionId", sessionId); put("rootId", rootId); put("argv", JsonArray(parsed.argv.map(::JsonPrimitive))); if (folder.isNotBlank()) put("cwd", folder.trim())
                put("network", network); put("timeoutSeconds", (minutes.toIntOrNull() ?: 5).coerceIn(1, 60) * 60)
            }, strings.getString(R.string.tools_command_action))
            started(strings.getString(R.string.tools_command_started))
        } }, enabled = !run.busy && rootId.isNotEmpty() && parsed.argv.isNotEmpty() && problem == null) { Text(stringResource(R.string.tools_command_run)) }
    }) {
        Text(stringResource(R.string.tools_command_hint), style = MaterialTheme.typography.bodySmall)
        if (roots?.isEmpty() == true) Text(stringResource(R.string.tools_command_none), color = MaterialTheme.colorScheme.tertiary)
        roots.orEmpty().forEach { root -> Choice(root.str("name").orEmpty(), root.str("id") == rootId) { rootId = root.str("id").orEmpty() } }
        OutlinedTextField(text, { text = it.take(8192) }, Modifier.fillMaxWidth(), textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), label = { Text(stringResource(R.string.tools_command_text)) })
        OutlinedTextField(folder, { folder = it.take(1024) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.tools_command_subfolder)) })
        OutlinedTextField(minutes, { minutes = it.filter(Char::isDigit).take(2) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.tools_command_minutes)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        ToolCheck(stringResource(R.string.tools_command_network), network) { network = it }
    }
}
/** A finished image request sent again as a new one; an unknown outcome is confirmed first because it may have been billed. */
@Composable
internal fun RetryRun(repository: PALRepository, activity: FragmentActivity, sessionId: String, operationId: String, unknown: Boolean, failed: (String?) -> Unit, done: () -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    var confirm by remember { mutableStateOf(false) }
    fun send(confirmed: Boolean) = run.start {
        signed(activity, repository, "workbench.operations.retry", buildJsonObject { put("sessionId", sessionId); put("operationId", operationId); if (confirmed) put("confirmed", true) }, strings.getString(R.string.tools_retry_action))
        done()
    }
    LaunchedEffect(run.error) { run.error?.let(failed) }
    TextButton({ if (unknown) confirm = true else send(false) }, enabled = !run.busy) { Text(stringResource(R.string.tools_retry)) }
    if (confirm) ToolDialog(stringResource(R.string.tools_retry_title), { confirm = false }, confirm = { Button({ confirm = false; send(true) }) { Text(stringResource(R.string.tools_retry)) } }) { Text(stringResource(R.string.tools_retry_body)) }
}
/** What PAL moved to its trash for this conversation. */
@Composable
internal fun TrashList(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, changed: (String?) -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    var items by remember(sessionId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var purge by remember { mutableStateOf<JsonObject?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    if (!state.supports("workbench.changes.trash")) return
    LaunchedEffect(sessionId, refresh, state.cursor) {
        try { items = repository.read("workbench.changes.trash", buildJsonObject { put("sessionId", sessionId) }).objects().filter { it.str("state") != "restored" } }
        catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { items = emptyList() }
    }
    if (items.isEmpty()) return
    AncillarySection(stringResource(R.string.tools_trash), stringResource(R.string.tools_trash_hint)) {
        run.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        items.forEach { item ->
            Text(item.str("path").orEmpty(), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                TextButton({ run.start {
                    val set = signed(activity, repository, "workbench.changes.undo", buildJsonObject { put("sessionId", sessionId); put("changeSetId", item.str("changeSetId").orEmpty()) }, strings.getString(R.string.tools_restore_action)) as? JsonObject
                    refresh++; changed(set?.str("id"))
                } }, enabled = !run.busy) { Text(stringResource(R.string.tools_restore)) }
                if (state.supports("workbench.changes.purge")) TextButton({ purge = item }, enabled = !run.busy) { Text(stringResource(R.string.tools_purge), color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    purge?.let { item -> ToolDialog(stringResource(R.string.tools_purge_title), { purge = null }, busy = run.busy, error = run.error, confirm = {
        Button({ run.start {
            signed(activity, repository, "workbench.changes.purge", buildJsonObject { put("sessionId", sessionId); put("trashId", item.str("id").orEmpty()); put("confirmed", true) }, strings.getString(R.string.tools_purge_action))
            purge = null; refresh++
        } }, enabled = !run.busy) { Text(stringResource(R.string.tools_purge)) }
    }) { Text(stringResource(R.string.tools_purge_body, item.str("path").orEmpty())) } }
}
/** The project shelf: things that keep their own storage and authority, listed in one place. */
@Composable
internal fun ShelfTab(repository: PALRepository, state: MobileState, sessionId: String, openConversation: (String) -> Unit) {
    val strings = LocalResources.current
    val run = rememberToolRun()
    var shelf by remember(sessionId) { mutableStateOf<JsonObject?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(sessionId, state.cursor) { run.start { shelf = repository.read("workbench.shelf", buildJsonObject { put("sessionId", sessionId) }) as JsonObject } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
        item { ShelfContent(shelf, { id -> run.start { repository.mutate("workbench.artifacts.useInDraft", buildJsonObject { put("sessionId", sessionId); put("artifactId", id) }); info = strings.getString(R.string.work_added_to_the_conversations_desktop_draft) } }, openConversation) }
        info?.let { item { AncillaryFeedback(it) } }
        run.error?.let { item { AncillaryFeedback(it, error = true) } }
    }
}
@Composable
internal fun ShelfContent(shelf: JsonObject?, use: (String) -> Unit, openConversation: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
        Text(stringResource(R.string.tools_shelf_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (shelf == null) { LinearProgressIndicator(Modifier.fillMaxWidth()); return@Column }
        @Composable fun Group(title: Int, rows: List<JsonObject>, row: @Composable (JsonObject) -> Unit) = AncillarySection(stringResource(title)) {
            if (rows.isEmpty()) Text(stringResource(R.string.tools_shelf_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            rows.forEach { row(it) }
        }
        Group(R.string.tools_shelf_files, shelf.list("artifacts")) { item -> Row(verticalAlignment = Alignment.CenterVertically) { Text(item.str("name").orEmpty(), Modifier.weight(1f)); TextButton({ use(item.str("id").orEmpty()) }) { Text(stringResource(R.string.tools_shelf_use)) } } }
        Group(R.string.tools_shelf_collections, shelf.list("collections")) { Text(it.str("name").orEmpty()) }
        val capsule = shelf.obj("capsule")
        AncillarySection(stringResource(R.string.tools_shelf_capsule)) {
            fun texts(key: String) = (capsule?.get(key) as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            val lines = listOfNotNull(capsule?.str("goal")?.takeIf(String::isNotBlank)?.let { stringResource(R.string.tools_shelf_goal, it) }) + texts("decisions").map { stringResource(R.string.tools_shelf_decision, it) } +
                texts("constraints").map { stringResource(R.string.tools_shelf_constraint, it) } + capsule?.list("tasks").orEmpty().map { stringResource(R.string.tools_shelf_task, it.str("text").orEmpty()) }
            if (lines.isEmpty()) Text(stringResource(R.string.tools_shelf_empty), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            lines.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
        Group(R.string.tools_shelf_conversations, shelf.list("conversations")) { item -> Row(verticalAlignment = Alignment.CenterVertically) { Text(item.str("title").orEmpty(), Modifier.weight(1f)); TextButton({ openConversation(item.str("id").orEmpty()) }) { Text(stringResource(R.string.tools_shelf_open)) } } }
        Group(R.string.tools_shelf_recipes, shelf.list("recipes")) { Text(it.str("name").orEmpty()) }
    }
}
