package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** Owner-only xAI persistent collection controls. Every cloud/storage change remains a reviewed signed action. */
@Composable
internal fun XaiCollectionsDialog(activity: FragmentActivity, repository: PALRepository, sessionId: String, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var collections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var files by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selected by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var maxResults by rememberSaveable { mutableStateOf("10") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    fun load() = scope.launch {
        runCatching { repository.request("owner.xaiCollections.list", buildJsonObject { put("sessionId", sessionId) }) }
            .onSuccess { collections = (it as? JsonObject)?.list("collections") ?: it.objects(); if (selected.isBlank()) selected = collections.firstOrNull()?.str("id").orEmpty() }
            .onFailure { message = it.message }
        runCatching { repository.request("owner.originalFiles.list", buildJsonObject { put("sessionId", sessionId) }) }
            .onSuccess { files = (it as? JsonObject)?.list("files") ?: it.objects() }.onFailure { message = it.message }
    }
    LaunchedEffect(sessionId) { load() }
    fun signedAction(method: String, params: JsonObject, reason: String, success: String) {
        if (busy) return
        busy = true; message = null
        scope.launch { runCatching { signed(activity, repository, method, params, reason) }
            .onSuccess { message = success; load() }.onFailure { message = it.message }; busy = false }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) dismiss() },
        title = { Text("xAI document collections") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text("Collections persist in the selected named xAI account. PAL requires its separate Management key and asks before cloud storage changes.", style = MaterialTheme.typography.bodySmall)
            collections.forEach { row ->
                val id = row.str("id").orEmpty()
                Surface(shape = MaterialTheme.shapes.small, tonalElevation = if (selected == id) PALLayout.hairline else 0.dp) {
                    Column(Modifier.fillMaxWidth().padding(PALLayout.small)) {
                        FilterChip(selected == id, { selected = id }, { Text("${row.str("name")} · ${row.num("documentsCount") ?: 0} PDF(s)") })
                        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                            TextButton({ signedAction("owner.xaiCollections.attach", buildJsonObject { put("sessionId", sessionId); put("collectionId", id); put("maxResults", maxResults.toIntOrNull()?.coerceIn(1, 50) ?: 10); put("acknowledgeSearch", true) }, "Let this conversation search ${row.str("name")}", "Collection attached") }, enabled = !busy) { Text("Attach") }
                            TextButton({ scope.launch { runCatching { repository.mutate("owner.xaiCollections.detach", buildJsonObject { put("sessionId", sessionId); put("collectionId", id) }) }.onSuccess { message = "Collection detached"; load() }.onFailure { message = it.message } } }, enabled = !busy) { Text("Detach") }
                            TextButton({ signedAction("owner.xaiCollections.delete", buildJsonObject { put("sessionId", sessionId); put("collectionId", id); put("acknowledgeDeletion", true) }, "Permanently delete ${row.str("name")} from xAI", "Collection deleted") }, enabled = !busy) { Text("Delete") }
                        }
                    }
                }
            }
            OutlinedTextField(maxResults, { maxResults = it.filter(Char::isDigit).take(2) }, Modifier.fillMaxWidth(), label = { Text("Maximum search results (1–50)") }, singleLine = true)
            if (selected.isNotBlank() && files.isNotEmpty()) {
                Text("Uploaded original PDFs", style = MaterialTheme.typography.labelLarge)
                files.filter { it.str("provider") == "xai" && it.str("state") == "ready" }.forEach { file ->
                    Row(Modifier.fillMaxWidth()) {
                        Text(file.str("name").orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        TextButton({ signedAction("owner.xaiCollections.addDocument", buildJsonObject { put("sessionId", sessionId); put("collectionId", selected); put("originalFileId", file.str("id")); put("acknowledgeCloudStorage", true) }, "Persist this uploaded PDF in the selected xAI collection", "PDF added") }, enabled = !busy) { Text("Add") }
                        TextButton({ signedAction("owner.xaiCollections.removeDocument", buildJsonObject { put("sessionId", sessionId); put("collectionId", selected); put("originalFileId", file.str("id")); put("acknowledgeRemoval", true) }, "Remove this PDF from the selected xAI collection", "PDF removed") }, enabled = !busy) { Text("Remove") }
                    }
                }
            }
            HorizontalDivider()
            Text("Create collection", style = MaterialTheme.typography.labelLarge)
            OutlinedTextField(name, { name = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
            OutlinedTextField(description, { description = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text("Description (optional)") }, minLines = 2)
            Button({ signedAction("owner.xaiCollections.create", buildJsonObject { put("sessionId", sessionId); put("name", name.trim()); if (description.isNotBlank()) put("description", description.trim()); put("acknowledgeCloudStorage", true) }, "Create a persistent xAI collection named ${name.trim()}", "Collection created") }, enabled = name.isNotBlank() && !busy) { Text("Create") }
            message?.let { Text(it, color = if (it.contains("failed", true) || it.contains("error", true)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
        } },
        confirmButton = { TextButton(dismiss, enabled = !busy) { Text("Done") } },
    )
}
