package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ProviderConnection
import dev.otectus.pal.mobile.data.providerConnections
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Explicit account/revision-bound non-chat inference over an immutable Library artifact. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ProviderInferenceDialog(
    activity: FragmentActivity, repository: PALRepository, state: MobileState, sessionId: String,
    artifact: kotlinx.serialization.json.JsonObject, version: kotlinx.serialization.json.JsonObject,
    dismiss: () -> Unit, complete: (String) -> Unit,
) {
    // The conversation can leave this phone's scope while the dialog is open.
    val session = state.sessions.firstOrNull { it.id == sessionId }
    if (session == null) { LaunchedEffect(Unit) { dismiss() }; return }
    val projectRevision = state.projects.firstOrNull { it.id == session.projectId }?.revision ?: "0"
    val hf = state.providerConnections("huggingface").filter { it.revision > 0 }
    val mistral = state.providerConnections("mistral").filter { it.revision > 0 }
    var mode by remember { mutableStateOf(if (version.str("mime") == "application/pdf" && mistral.isNotEmpty()) "ocr" else "hf") }
    var connection by remember(mode) { mutableStateOf((if (mode == "ocr") mistral else hf).firstOrNull()) }
    var model by remember(mode) { mutableStateOf(if (mode == "ocr") "mistral-ocr-latest" else "") }
    var task by remember { mutableStateOf("image-classification") }
    var pages by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun authority(target: ProviderConnection) = buildJsonObject {
        put("sessionId", sessionId); put("expectedSessionRevision", session.revision); put("expectedProjectRevision", projectRevision)
        put("connectionId", target.id); put("connectionRevision", target.revision)
    }
    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text("Provider analysis") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text("The selected immutable artifact is sent to the named provider account. The operation is bound to the conversation, project, account, and their displayed revisions.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                if (hf.isNotEmpty()) FilterChip(mode == "hf", { mode = "hf"; connection = hf.first(); model = "" }, { Text("Hugging Face") })
                if (version.str("mime") == "application/pdf" && mistral.isNotEmpty()) FilterChip(mode == "ocr", { mode = "ocr"; connection = mistral.first(); model = "mistral-ocr-latest" }, { Text("Mistral OCR") })
            }
            val choices = if (mode == "ocr") mistral else hf
            choices.forEach { route -> FilterChip(connection?.id == route.id, { connection = route }, { Text("${route.name} · revision ${route.revision}") }) }
            if (mode == "hf") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    listOf("image-classification", "object-detection", "image-segmentation", "audio-classification", "automatic-speech-recognition", "feature-extraction").forEach { id -> FilterChip(task == id, { task = id }, { Text(id.replace('-', ' ')) }) }
                }
            } else OutlinedTextField(pages, { pages = it.filter { c -> c.isDigit() || c == ',' || c == '-' }.take(4096) }, label = { Text("Pages (optional, such as 0-4,7)") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(model, { model = it.take(512) }, label = { Text("Provider model") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { Button({
        val route = connection ?: return@Button
        busy = true; error = null
        scope.launch {
            val base = authority(route)
            val params = buildJsonObject {
                base.forEach { (key, value) -> put(key, value) }
                if (mode == "ocr") {
                    put("source", buildJsonObject { put("artifactId", artifact.str("id") ?: artifact.str("artifactId").orEmpty()); version.str("versionId")?.let { put("versionId", it) } })
                    if (model.isNotBlank()) put("model", model.trim()); if (pages.isNotBlank()) put("pages", pages); put("tableFormat", "markdown"); put("includeImages", true)
                } else {
                    put("task", task); put("model", model.trim()); put("inputs", buildJsonObject { put("kind", "artifacts"); put("items", buildJsonArray { add(buildJsonObject { put("artifactId", artifact.str("id") ?: artifact.str("artifactId").orEmpty()); version.str("versionId")?.let { put("versionId", it) } }) }) })
                    if (task == "feature-extraction") { put("pooling", "mean"); put("normalize", true) }
                }
            }
            runCatching { signed(activity, repository, if (mode == "ocr") "owner.providerInference.mistralOcr" else "owner.providerInference.run", params, "Send this artifact to ${route.name} for provider analysis") }
                .onSuccess { complete("Provider analysis completed and its result was recorded in the conversation Library") }.onFailure { error = it.message }
            busy = false
        }
    }, enabled = !busy && connection != null && model.isNotBlank()) { Text(if (busy) "Running…" else "Review and run") } }, dismissButton = { TextButton(dismiss, enabled = !busy) { Text("Cancel") } })
}
