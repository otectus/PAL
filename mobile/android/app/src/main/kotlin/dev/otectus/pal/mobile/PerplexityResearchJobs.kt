package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.clickable
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Durable Perplexity Agent jobs bound to the selected saved owner conversation and named account. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PerplexityResearchJobs(
    activity: FragmentActivity,
    repository: PALRepository,
    state: MobileState,
    sessionId: String,
) {
    val session = state.sessions.firstOrNull { it.id == sessionId }
    if (!state.owner || session?.provider != "perplexity" || !state.supports("owner.research.provider.start")) return

    val scope = rememberCoroutineScope()
    var prompt by rememberSaveable(sessionId) { mutableStateOf("") }
    var effort by rememberSaveable(sessionId) { mutableStateOf("medium") }
    var requestId by rememberSaveable(sessionId, prompt, effort) { mutableStateOf(UUID.randomUUID().toString()) }
    var jobs by remember(sessionId) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selectedId by rememberSaveable(sessionId) { mutableStateOf("") }
    var selected by remember(sessionId) { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    val activeStates = setOf("queued", "in_progress", "cancelling")
    val uriHandler = LocalUriHandler.current; val openRefused = stringResource(R.string.open_refused)

    suspend fun load(preserveFailure: Boolean = false) {
        runCatching {
            repository.request("owner.research.provider.list", buildJsonObject { put("sessionId", sessionId) })
        }.onSuccess { value ->
            jobs = (value as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
            val next = jobs.firstOrNull { it.str("id") == selectedId } ?: jobs.firstOrNull()
            selectedId = next?.str("id").orEmpty()
            selected = next
            if (!preserveFailure) failure = null
        }.onFailure { failure = it.message }
    }

    fun poll(job: JsonObject? = selected) {
        val target = job ?: return
        val id = target.str("id") ?: return
        if (busy || target.str("remoteId").isNullOrBlank()) return
        busy = true
        scope.launch {
            runCatching {
                repository.mutate("owner.research.provider.poll", buildJsonObject { put("sessionId", sessionId); put("id", id) }) as JsonObject
            }.onSuccess { result -> selected = result; selectedId = id; failure = null; load() }
                .onFailure { failure = it.message; load(preserveFailure = true) }
            busy = false
        }
    }

    LaunchedEffect(sessionId, state.cacheEpoch) { load() }
    LaunchedEffect(sessionId, state.cacheEpoch, selectedId, selected?.str("status")) {
        while (selected?.str("status") in activeStates) {
            delay(2_500)
            if (!busy) poll()
        }
    }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text("Perplexity Agent jobs", style = MaterialTheme.typography.titleMedium)
            Text("Durable background research keeps its provider handle if you leave this screen. Results, citations, and generated files return to this conversation.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(prompt, { prompt = it.take(8000); message = null }, Modifier.fillMaxWidth(), label = { Text("Agent research prompt") }, minLines = 2)
            Text("Effort preset", style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.tight), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                listOf("fast", "low", "medium", "high", "xhigh", "ultra").forEach { value ->
                    FilterChip(effort == value, { effort = value; message = null }, { Text(if (value == "xhigh") "Extra high" else value.replaceFirstChar(Char::uppercase)) })
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                Button({
                    busy = true; failure = null; message = null
                    scope.launch {
                        runCatching {
                            signed(activity, repository, "owner.research.provider.start", buildJsonObject {
                                put("sessionId", sessionId); put("requestId", requestId); put("prompt", prompt.trim()); put("effort", effort)
                            }, "Start durable Perplexity Agent research") as JsonObject
                        }.onSuccess { result ->
                            selected = result; selectedId = result.str("id").orEmpty(); requestId = UUID.randomUUID().toString()
                            message = "Background Agent research started."; load()
                        }.onFailure {
                            failure = "${it.message.orEmpty()} The same request ID is retained; reload or retry to reconcile the durable start without submitting a duplicate."
                            load(preserveFailure = true)
                        }
                        busy = false
                    }
                }, enabled = !busy && prompt.isNotBlank()) { Text(if (busy) "Working…" else "Start background job") }
                OutlinedButton({ scope.launch { load() } }, enabled = !busy) { Text("Reload") }
            }
            failure?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            message?.let { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall) }
            HorizontalDivider()
            if (jobs.isEmpty()) Text("No Perplexity Agent jobs for this conversation.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            jobs.forEach { job ->
                val id = job.str("id").orEmpty()
                FilterChip(selectedId == id, { selectedId = id; selected = job; failure = null }, {
                    Text("${providerJobStatus(job.str("status"))} · ${job.str("prompt").orEmpty()}", maxLines = 2)
                })
            }
            selected?.let { job ->
                HorizontalDivider()
                val status = job.str("status")
                Text("${providerJobStatus(status)}${job.str("effort")?.let { " · $it" }.orEmpty()}", style = MaterialTheme.typography.titleSmall)
                if (status == "unknown-outcome") Text("PAL saved this request before sending it but did not receive a provider handle. Reload or retry the unchanged prompt to reconcile it; PAL will not submit that request ID twice.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                job.str("error")?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (status in activeStates) LinearProgressIndicator(Modifier.fillMaxWidth())
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    OutlinedButton({ poll(job) }, enabled = !busy && !job.str("remoteId").isNullOrBlank() && status != "cancelling") { Text("Poll now") }
                    if (status in activeStates) TextButton({
                        if (busy || status == "cancelling") return@TextButton
                        selected = JsonObject(job + ("status" to kotlinx.serialization.json.JsonPrimitive("cancelling")))
                        busy = true; failure = null
                        scope.launch {
                            runCatching {
                                signed(activity, repository, "owner.research.provider.cancel", buildJsonObject { put("sessionId", sessionId); put("id", job.str("id").orEmpty()) }, "Cancel this Perplexity Agent job") as JsonObject
                            }.onSuccess { result -> selected = result; message = "Cancellation requested."; load() }
                                .onFailure { failure = it.message; load(preserveFailure = true) }
                            busy = false
                        }
                    }, enabled = !busy && status != "cancelling") { Text(if (status == "cancelling") "Cancelling…" else "Cancel") }
                }
                job.str("text")?.takeIf { it.isNotBlank() }?.let { Text(it) }
                val sources = job.list("sources")
                if (sources.isNotEmpty()) {
                    Text("Citations", style = MaterialTheme.typography.labelLarge)
                    sources.forEachIndexed { index, source ->
                        val url = source.str("url").orEmpty()
                        Text("[${index + 1}] ${source.str("title") ?: url.ifBlank { "Source" }}\n$url", Modifier.clickable(enabled = url.startsWith("https://") || url.startsWith("http://")) { if (!uriHandler.open(url)) failure = openRefused }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
                val files = job.list("files").mapNotNull { it.str("name") }
                if (files.isNotEmpty()) Text("Attached output files: ${files.joinToString()}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                job.strings("recoveryNotes").forEach { note -> Text(note, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

private fun providerJobStatus(value: String?) = when (value) {
    "queued" -> "Queued"
    "in_progress" -> "Running"
    "cancelling" -> "Cancelling…"
    "completed" -> "Complete"
    "incomplete" -> "Incomplete"
    "failed" -> "Failed"
    "cancelled" -> "Cancelled"
    "unknown-outcome" -> "Outcome uncertain"
    else -> value ?: "Unknown"
}
