package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Reviewed two-step entry point for provider-billed video and music operations. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TimedMediaDialog(activity: FragmentActivity, repository: PALRepository, state: MobileState, sessionId: String, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var provider by remember { mutableStateOf("google") }
    var kind by remember { mutableStateOf("video.generate") }
    var model by remember { mutableStateOf("gemini-omni-1.2-flash") }
    var prompt by remember { mutableStateOf("") }
    var duration by remember { mutableStateOf("5") }
    var aspect by remember { mutableStateOf("16:9") }
    var resolution by remember { mutableStateOf("720p") }
    var artifacts by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var source by remember { mutableStateOf<JsonObject?>(null) }
    var prepared by remember { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val xaiEdit = provider == "xai" && source != null

    LaunchedEffect(sessionId) {
        runCatching { repository.read("workbench.artifacts.list", buildJsonObject {
            put("sessionId", sessionId); put("project", true); put("limit", 100)
        }).jsonObject.list("artifacts") }.onSuccess { artifacts = it }.onFailure { error = it.message }
    }

    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text("Generate timed media") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text("Prepare the operation, review its provider route, then confirm the potentially billed request. The result becomes an immutable conversation artifact.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                FilterChip(provider == "google", { provider = "google"; model = if (kind == "music.generate") "lyria-3.5" else "gemini-omni-1.2-flash"; prepared = null }, { Text("Google") })
                FilterChip(provider == "xai", { provider = "xai"; kind = "video.generate"; model = "grok-imagine-video"; prepared = null }, { Text("xAI") })
                FilterChip(provider == "edenai", { provider = "edenai"; kind = "video.generate"; source = null; model = "video/generation_async/bytedance"; prepared = null }, { Text("Eden AI") })
                FilterChip(kind == "video.generate", { kind = "video.generate"; model = when (provider) { "xai" -> "grok-imagine-video"; "edenai" -> "video/generation_async/bytedance"; else -> "gemini-omni-1.2-flash" }; prepared = null }, { Text("Video") })
                if (provider == "google") FilterChip(kind == "music.generate", { kind = "music.generate"; source = null; model = "lyria-3.5"; prepared = null }, { Text("Music") })
            }
            ModelField(model, { model = it; prepared = null }, stringResource(R.string.models_provider), modelSource(repository, state, provider, kind), maximum = 256)
            OutlinedTextField(prompt, { prompt = it.take(10_000); prepared = null }, label = { Text("Describe the result") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            if (provider != "edenai" && kind == "video.generate") {
                Text("Source Workbench version", style = MaterialTheme.typography.labelMedium)
                if (artifacts.isEmpty()) Text("Add an image or video to this conversation's Workbench to use it as a source.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    FilterChip(source == null, { source = null; prepared = null }, { Text("No source file") })
                    artifacts.forEach { artifact ->
                        val artifactId = artifact.str("id") ?: return@forEach
                        val versionId = artifact.str("latestVersionId") ?: return@forEach
                        FilterChip(source?.str("id") == artifactId && source?.str("latestVersionId") == versionId,
                            { source = artifact; prepared = null }, { Text(artifact.str("name") ?: artifactId) })
                    }
                }
            }
            if (!xaiEdit) Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedTextField(duration, { duration = it.filter(Char::isDigit).take(2); prepared = null }, label = { Text("Seconds") }, singleLine = true, modifier = Modifier.weight(1f))
                OutlinedTextField(aspect, { aspect = it.take(16); prepared = null }, label = { Text("Aspect") }, singleLine = true, modifier = Modifier.weight(1f))
                OutlinedTextField(resolution, { resolution = it.take(32); prepared = null }, label = { Text("Resolution") }, singleLine = true, modifier = Modifier.weight(1f))
            }
            if (prepared != null) Text("Ready to send through ${when (provider) { "google" -> "Google"; "xai" -> "xAI"; else -> "Eden AI" }}. This may use provider credits.", color = MaterialTheme.colorScheme.tertiary)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = {
        if (prepared == null) Button({
            busy = true; error = null
            scope.launch { runCatching { repository.mutate("owner.media.timed.prepare", buildJsonObject {
                put("sessionId", sessionId); put("provider", provider); put("model", model.trim()); put("kind", kind); put("prompt", prompt.trim())
                source?.let { artifact -> put("references", JsonArray(listOf(buildJsonObject { put("artifactId", artifact.str("id")); put("versionId", artifact.str("latestVersionId")) }))) }
                if (!xaiEdit) { put("duration", duration.toInt()); put("resolution", resolution.trim()); put("aspectRatio", aspect.trim()) }
            }) as JsonObject }.onSuccess { prepared = it }.onFailure { error = it.message }; busy = false }
        }, enabled = !busy && prompt.isNotBlank() && model.isNotBlank() && (xaiEdit || (duration.toIntOrNull() ?: 0) in 3..15)) { Text("Review operation") }
        else Button({
            val id = prepared?.str("id") ?: return@Button
            busy = true; error = null
            scope.launch { runCatching { signed(activity, repository, "owner.media.timed.start", buildJsonObject { put("sessionId", sessionId); put("id", id) }, "Confirm billed timed media generation") }
                .onSuccess { dismiss() }.onFailure { error = it.message }; busy = false }
        }, enabled = !busy) { Text("Confirm billed generation") }
    }, dismissButton = { TextButton(dismiss, enabled = !busy) { Text("Cancel") } })
}
