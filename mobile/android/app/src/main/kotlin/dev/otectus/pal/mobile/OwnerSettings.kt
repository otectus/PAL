@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.BorderStroke
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * Settings → This computer (PAL Everywhere §6, §8.4): what a phone with full access manages on the desktop.
 * Each section names where its change happens ("on this computer"); every change is a typed, signed action, and
 * keys travel once over the pinned connection and never come back. A phone with limited access sees what it is.
 */
private val ownerGroups = linkedMapOf(
    "Access and permissions" to listOf("Access and working profile", "Paired devices", "Power session"),
    "Connections and spending" to listOf("Keys and connections", "Tool servers", "Usage and budget"),
    "Projects and automation" to listOf("Working setups", "Specialists", "Routines", "Skills", "Knowledge collections", "Saved scripts"),
    "Desktop and maintenance" to listOf("Desktop settings", "Local models", "Health and backups"),
)

internal fun androidx.compose.foundation.lazy.LazyListScope.ownerSettings(
    repository: PALRepository, state: MobileState, activity: FragmentActivity,
    feedback: (String) -> Unit, failure: (String) -> Unit,
    initialToolServerId: String? = null, toolServerResult: String? = null, onOAuthStarted: (String) -> Unit = {},
    initialSessionId: String? = null, initialSection: String? = null,
) {
    item(key = "owner-settings-" + state.desktop?.deviceId.orEmpty()) {
        var destination by rememberSaveable { mutableStateOf<String?>(null) }
        var query by rememberSaveable { mutableStateOf("") }
        val sections = rememberSaveableStateHolder()
        LaunchedEffect(initialToolServerId, toolServerResult, initialSection) {
            if (initialSection != null && ownerGroups.values.any { initialSection in it }) destination = initialSection
            else if (toolServerResult != null) destination = "Tool servers"
        }
        val selected = if (state.owner) destination else "Access and working profile"
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (selected == null) {
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Find a setting") })
                val matches = ownerGroups.mapValues { (group, names) ->
                    names.filter { it.contains(query.trim(), true) || group.contains(query.trim(), true) }
                }.filterValues { it.isNotEmpty() }
                if (matches.isEmpty()) Text("No settings match this search.")
                matches.forEach { (group, names) ->
                    Text(group, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                    Surface(shape = MaterialTheme.shapes.medium, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
                        Column {
                            names.forEach { name ->
                                TextButton({ destination = name }, Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                                    Text(name, Modifier.weight(1f))
                                    if (name == "Access and working profile") Text("Full access", style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                }
            } else sections.SaveableStateProvider(selected) {
                var notice by rememberSaveable { mutableStateOf<String?>(null) }
                var problem by rememberSaveable { mutableStateOf(false) }
                val saved: (String) -> Unit = { problem = false; notice = it; feedback(it) }
                val failed: (String) -> Unit = { problem = true; notice = it.ifBlank { "The desktop could not finish this request. Try again." }; failure(notice.orEmpty()) }
                if (state.owner) {
                    BackHandler { destination = null }
                    TextButton({ destination = null }) { Text("All computer settings") }
                    val headingAnchor = remember { BringIntoViewRequester() }
                    Text(selected, Modifier.bringIntoViewRequester(headingAnchor).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
                    LaunchedEffect(selected) { headingAnchor.bringIntoView() }
                }
                val activeRequests = remember { mutableIntStateOf(0) }
                Box(Modifier.fillMaxWidth().height(4.dp)) {
                    if (activeRequests.intValue > 0) LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                CompositionLocalProvider(LocalOwnerRequests provides activeRequests) {
                    when (selected) {
                        "Access and working profile" -> AccessPanel(repository, state, activity, (state.connection as? ConnectionState.Online)?.access, saved, failed)
                        "Paired devices" -> DevicesSection(repository, state, activity, saved, failed)
                        "Power session" -> PowerSection(repository, state, activity, saved, failed)
                        "Keys and connections" -> KeysSection(repository, activity, saved, failed)
                        "Desktop settings" -> DesktopSettingsSection(repository, activity, saved, failed)
                        "Usage and budget" -> UsageSection(repository, activity, saved, failed)
                        "Skills" -> SkillsSection(repository, activity, saved, failed)
                        "Knowledge collections" -> CollectionsSection(repository, state, activity, saved, failed, initialSessionId)
                        "Saved scripts" -> ScriptsSection(repository, activity, saved, failed)
                        "Tool servers" -> ToolServersSection(repository, activity, saved, failed, initialToolServerId, toolServerResult, onOAuthStarted)
                        "Working setups" -> SetupsSection(repository, state, activity, saved, failed, initialSessionId)
                        "Specialists" -> SpecialistsSection(repository, activity, saved, failed)
                        "Routines" -> SchedulesSection(repository, state, activity, saved, failed)
                        "Local models" -> ModelsSection(repository, activity, saved, failed)
                        "Health and backups" -> HealthSection(repository, activity, saved, failed)
                    }
                }
                notice?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color = if (problem) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) }
            }
        }
    }
}

private val LocalOwnerRequests = staticCompositionLocalOf<MutableIntState> { error("Owner settings scope is missing") }

private class OwnerActionScope(private val scope: CoroutineScope, private val requests: MutableIntState) {
    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch {
        requests.intValue++
        try { block() } finally { requests.intValue-- }
    }
}

@Composable
private fun rememberOwnerScope(): OwnerActionScope {
    val scope = rememberCoroutineScope()
    val requests = LocalOwnerRequests.current
    return remember(scope, requests) { OwnerActionScope(scope, requests) }
}

private inline fun <T> ownerCall(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Exception) {
    Result.failure(error)
}

@Composable
private fun LabeledCheck(label: String, checked: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(value = checked, role = Role.Checkbox, onValueChange = change),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Checkbox(checked, null)
        Text(label, Modifier.weight(1f))
    }
}

@Composable
private fun ConfirmRemoval(label: String, name: String, effect: String, enabled: Boolean = true, remove: () -> Unit) {
    var open by rememberSaveable(name) { mutableStateOf(false) }
    TextButton({ open = true }, enabled = enabled) { Text("$label…") }
    if (open) AlertDialog({ open = false }, title = { Text("$label $name?") }, text = { Text(effect) },
        confirmButton = { Button({ open = false; remove() }) { Text(label) } },
        dismissButton = { TextButton({ open = false }) { Text("Cancel") } })
}

@Composable
private fun TargetConversation(state: MobileState, id: String?, select: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val target = state.sessions.find { it.id == id }
    Box {
        OutlinedButton({ expanded = true }, enabled = state.sessions.isNotEmpty()) {
            Text(target?.let { "Conversation · " + it.title } ?: if (state.sessions.isEmpty()) "No conversations available" else "Choose a conversation")
        }
        DropdownMenu(expanded, { expanded = false }) {
            state.sessions.forEach { session -> DropdownMenuItem(text = { Text(session.title + session.project?.let { " · $it" }.orEmpty()) },
                onClick = { select(session.id); expanded = false }) }
        }
    }
}

private val profiles = listOf("desktop" to "Use my desktop choices", "review" to "Review changes", "automatic" to "Work automatically")

@Composable
private fun AccessPanel(repository: PALRepository, state: MobileState, activity: FragmentActivity, access: JsonObject?, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var info by remember(state.connection is ConnectionState.Online, state.owner) { mutableStateOf<JsonObject?>(null) }
    var confirmLimit by remember { mutableStateOf(false) }
    LaunchedEffect(state.owner, state.connection is ConnectionState.Online) {
        if (state.supports("owner.access")) ownerCall { repository.request("owner.access", buildJsonObject {}) as JsonObject }.onSuccess { info = it }
    }
    if (state.connection !is ConnectionState.Online) {
        val offline = state.connection as? ConnectionState.Offline
        val title = when (state.connection) {
            ConnectionState.Connecting, ConnectionState.Authenticating -> "Checking desktop access…"
            is ConnectionState.Blocked -> "Desktop connection needs attention"
            else -> "Desktop offline"
        }
        Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
        val lastRole = when (state.permissions.str("role")) { "owner" -> "Full access"; "limited" -> "Limited access"; "observer" -> "Observer"; else -> null }
        lastRole?.let { role ->
            val time = offline?.lastVerifiedAt?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) }
            Text("Last known access · $role" + time?.let { " · $it" }.orEmpty())
        }
        Text("Reconnect to verify this phone’s current access and working profile.")
        return
    }
    val effective = info?.obj("access") ?: access
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(when { state.owner -> "Full access"; (state.connection as? ConnectionState.Online)?.role == "observer" -> "Observer"; else -> "Limited access" }, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            Text(effective?.str("summary") ?: if (state.has("owner.policy.v1")) "Granted projects and actions" else "This desktop does not support device roles yet; update PAL on the computer for full access.")
            (effective?.get("reasons") as? JsonArray)?.mapNotNull { it as? JsonObject }?.forEach { reason -> Text("· " + reason.str("detail").orEmpty(), style = MaterialTheme.typography.bodySmall) }
            if (state.owner) {
                Text("What PAL does by itself for this phone's conversations", style = MaterialTheme.typography.labelLarge)
                val current = info?.str("workingProfile") ?: effective?.str("profileId") ?: "desktop"
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    profiles.forEach { (id, label) ->
                        FilterChip(current == id, { if (current != id) scope.launch {
                            ownerCall { signed(activity, repository, "owner.profile.set", buildJsonObject { put("profile", id); put("expectedProfileRevision", info?.str("profileRevision") ?: "0") }, "Change working profile to $label") as JsonObject }
                                .onSuccess { result -> feedback("Working profile: $label"); info = info?.let { JsonObject(it + ("workingProfile" to JsonPrimitive(id)) + ("profileRevision" to (result["profileRevision"] ?: JsonPrimitive("0"))) + ("access" to (result["access"] ?: JsonNull))) } }
                                .onFailure { failure(it.message ?: "Could not change the profile") }
                        } }, { Text(label) })
                    }
                }
                Text(when (current) { "review" -> "Provider commands, edits and desktop actions wait for your review."; "automatic" -> "Enabled tools and provider commands run without asking. Spending limits, questions and operating-system prompts still apply."; else -> "The same automatic-approval switches as the desktop." }, style = MaterialTheme.typography.bodySmall)
                OutlinedButton({ confirmLimit = true }) { Text("Switch this phone to limited access") }
            }
        }
    }
    if (confirmLimit) AlertDialog({ confirmLimit = false }, title = { Text("Limit this phone?") },
        text = { Text("This phone keeps chat in its projects. Files, terminals, power sessions and settings stay on the desktop until you give full access again there.") },
        confirmButton = { Button({ confirmLimit = false; scope.launch {
            ownerCall { repository.mutate("devices.setSelfRole", buildJsonObject { put("role", "limited"); put("expectedScopeVersion", info?.obj("device")?.str("scopeVersion") ?: "0") }) }
                .onSuccess { feedback("This phone now has limited access") }.onFailure { failure(it.message ?: "Could not change access") }
        } }) { Text("Limit access") } }, dismissButton = { TextButton({ confirmLimit = false }) { Text("Cancel") } })
}

@Composable
private fun DevicesSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var devices by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    fun load() = scope.launch { ownerCall { repository.request("owner.devices.list", buildJsonObject {}) }.onSuccess { devices = it.objects() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    devices.forEach { device ->
        val role = device.str("role")
        Column {
            Text(device.str("name").orEmpty() + if (device.isTrue("self")) " (this phone)" else "", style = MaterialTheme.typography.titleSmall)
            Text(listOf(when (role) { "owner" -> "Full access"; "observer" -> "Observer"; else -> "Limited access" }, if (device.str("lifetime") == "until-revoked") "until revoked" else "expires", if (device.str("actionAuthentication") == "trusted-device") "trusted phone" else "fingerprint or PIN").joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            if (!device.isTrue("self")) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (role == "owner" || role == "limited") TextButton({ scope.launch {
                    ownerCall { signed(activity, repository, "owner.devices.setRole", buildJsonObject { put("deviceId", device.str("id").orEmpty()); put("role", if (role == "owner") "limited" else "observer"); put("expectedScopeVersion", device.str("scopeVersion") ?: "0") }, "Reduce ${device.str("name")}'s access") }
                        .onSuccess { feedback("Reduced ${device.str("name")}'s access"); load() }.onFailure { failure(it.message ?: "") }
                } }) { Text(if (role == "owner") "Limit" else "Make observer") }
                ConfirmRemoval("Revoke access for", device.str("name").orEmpty(), "This disconnects the phone. Pair it again on the desktop to restore access.") { scope.launch {
                    ownerCall { signed(activity, repository, "owner.devices.revoke", buildJsonObject { put("deviceId", device.str("id").orEmpty()) }, "Revoke ${device.str("name")}") }
                        .onSuccess { feedback("Revoked ${device.str("name")}"); load() }.onFailure { failure(it.message ?: "") }
                } }
            }
        }
    }
    Text("Giving another phone full access, and pairing new phones, happen on the desktop.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun PowerSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var inspect by remember { mutableStateOf<JsonObject?>(null) }
    var sessionId by rememberSaveable { mutableStateOf(state.selectedSessionId ?: state.sessions.firstOrNull()?.id.orEmpty()) }
    var minutes by rememberSaveable { mutableStateOf("30") }
    var cli by remember { mutableStateOf(true) }; var computer by remember { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.permissions.get", buildJsonObject {}) as JsonObject }.onSuccess { inspect = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    Text("A time-limited lease on one conversation: provider commands and desktop actions it requests run without asking until the lease ends. It mirrors the desktop's power mode.", style = MaterialTheme.typography.bodySmall)
    inspect?.list("power").orEmpty().filter { it.str("state") == "active" }.forEach { lease ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Active until ${java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(lease.num("expiresAt") ?: 0))}", Modifier.weight(1f))
            TextButton({ scope.launch { ownerCall { repository.mutate("owner.power.end", buildJsonObject { put("id", lease.str("id").orEmpty()) }) }.onSuccess { feedback("Power session ended"); load() }.onFailure { failure(it.message ?: "") } } }) { Text("End") }
        }
    }
    var open by remember { mutableStateOf(false) }
    Box { OutlinedButton({ open = true }) { Text(state.sessions.firstOrNull { it.id == sessionId }?.title ?: "Choose a conversation") }
        DropdownMenu(open, { open = false }) { state.sessions.forEach { s -> DropdownMenuItem(text = { Text(s.title) }, onClick = { sessionId = s.id; open = false }) } } }
    val reason = inspect?.list("effective")?.firstOrNull { it.str("sessionId") == sessionId }?.str("powerUnavailableReason")
    reason?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedTextField(minutes, { minutes = it.filter(Char::isDigit).take(3) }, Modifier.fillMaxWidth(), label = { Text("Duration in minutes (1–480)") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)
        LabeledCheck("Provider commands · run without asking", cli) { cli = it }
        LabeledCheck("Desktop actions · control permitted apps and devices without asking", computer) { computer = it }
    }
    val duration = minutes.toIntOrNull()
    val targetTitle = state.sessions.find { it.id == sessionId }?.title
    if (targetTitle != null && duration in 1..480 && (cli || computer)) {
        val allowed = listOfNotNull("provider commands".takeIf { cli }, "desktop actions".takeIf { computer }).joinToString(" and ")
        Text("Allow $allowed in “$targetTitle” for $duration minutes. You can end the session early.", style = MaterialTheme.typography.bodyMedium)
    }
    Button({ scope.launch {
        ownerCall { signed(activity, repository, "owner.power.start", buildJsonObject { put("sessionIds", buildJsonArray { add(sessionId) }); put("minutes", (minutes.toIntOrNull() ?: 30).coerceIn(1, 480)); put("cli", cli); put("computer", computer) }, "Start a power session") }
            .onSuccess { feedback("Power session started"); load() }.onFailure { failure(it.message ?: "") }
    } }, enabled = sessionId.isNotEmpty() && minutes.toIntOrNull() in 1..480 && (cli || computer) && reason.isNullOrBlank()) { Text("Start power session") }
}

@Composable
private fun KeysSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var settings by remember { mutableStateOf<JsonObject?>(null) }
    var connections by remember { mutableStateOf<JsonObject?>(null) }
    var provider by rememberSaveable { mutableStateOf("openai") }
    var key by remember { mutableStateOf("") }
    fun load() = scope.launch {
        ownerCall { repository.request("owner.settings.get", buildJsonObject {}) as JsonObject }.onSuccess { settings = it }.onFailure { failure(it.message ?: "") }
        ownerCall { repository.request("owner.connections.list", buildJsonObject {}) as JsonObject }.onSuccess { connections = it }
    }
    LaunchedEffect(Unit) { load() }
    val labels = mapOf("openai" to "OpenAI API", "anthropic" to "Claude API", "google" to "Google AI API", "compatible" to "Compatible endpoint", "elevenlabs" to "ElevenLabs voice")
    settings?.obj("credentials")?.let { credentials ->
        labels.forEach { (id, label) -> credentials.obj(id)?.let { status -> Text("$label · " + when (status.str("source")) { "saved" -> "key saved"; "environment" -> "from the environment"; else -> "no key" }, style = MaterialTheme.typography.bodySmall) } }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { labels.forEach { (id, label) -> FilterChip(provider == id, { provider = id }, { Text(label) }) } }
    OutlinedTextField(key, { key = it.trim() }, Modifier.fillMaxWidth(), label = { Text("New key for ${labels[provider]}") }, visualTransformation = PasswordVisualTransformation(), singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button({ val secret = key; key = ""; scope.launch {
            // The key crosses the pinned connection once; only whether one is configured comes back.
            ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", provider); put("key", secret) }, "Save the ${labels[provider]} key on the desktop") }
                .onSuccess { feedback("${labels[provider]} key saved on the desktop"); load() }.onFailure { failure(it.message ?: "") }
        } }, enabled = key.isNotEmpty()) { Text("Save key") }
        OutlinedButton({ scope.launch {
            ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", provider); put("key", JsonNull) }, "Remove the ${labels[provider]} key") }
                .onSuccess { feedback("${labels[provider]} key removed"); load() }.onFailure { failure(it.message ?: "") }
        } }) { Text("Remove key") }
    }
    connections?.list("connections")?.let { rows ->
        Text("Saved connections", style = MaterialTheme.typography.labelLarge)
        rows.forEach { row -> Text("${row.str("name")} · ${row.str("kind")} · " + (row.obj("compatible")?.str("baseUrl") ?: row.obj("ollama")?.str("host") ?: ""), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
    }
}

@Composable
private fun DesktopSettingsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var settings by remember { mutableStateOf<JsonObject?>(null) }
    fun load() = scope.launch { ownerCall { repository.request("owner.settings.get", buildJsonObject {}) as JsonObject }.onSuccess { settings = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    val values = settings?.obj("settings") ?: return Text("Loading…")
    fun patch(family: String, title: String, change: JsonObjectBuilder.() -> Unit) = scope.launch {
        ownerCall { signed(activity, repository, "owner.settings.patch", buildJsonObject { put("expectedRevision", settings?.str("revision") ?: "0"); put("family", family); put("values", buildJsonObject(change)) }, title) as JsonObject }
            .onSuccess { result -> feedback("$title · saved on the desktop"); settings = JsonObject(settings.orEmpty() + ("settings" to (result["settings"] ?: JsonNull)) + ("revision" to (result["revision"] ?: JsonNull))) }
            .onFailure { failure((it.message ?: "") + " Reload and try again if the desktop changed.") }
    }
    @Composable fun toggle(label: String, checked: Boolean, family: String, reviewEnable: Boolean = false, change: JsonObjectBuilder.(Boolean) -> Unit) {
        var confirm by rememberSaveable(label) { mutableStateOf(false) }
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(checked, role = Role.Switch) { value ->
            if (reviewEnable && value) confirm = true else patch(family, label) { change(value) }
        }, verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(checked, null) }
        if (confirm) AlertDialog({ confirm = false }, title = { Text("Allow " + label.lowercase() + "?") },
            text = { Text("This changes the desktop default for all conversations that follow desktop choices. You can turn it off here.") },
            confirmButton = { Button({ confirm = false; patch(family, label) { change(true) } }) { Text("Allow without asking") } },
            dismissButton = { TextButton({ confirm = false }) { Text("Keep review on") } })
    }
    var name by remember(values) { mutableStateOf(values.str("assistantName").orEmpty()) }
    OutlinedTextField(name, { name = it.take(40) }, Modifier.fillMaxWidth(), label = { Text("Assistant name") }, singleLine = true)
    TextButton({ patch("companion", "Assistant name") { put("assistantName", name) } }, enabled = name.isNotBlank() && name != values.str("assistantName")) { Text("Save name") }
    toggle("Speak replies on the desktop", values.isTrue("speechEnabled"), "voice") { put("speechEnabled", it) }
    toggle("Quiet desktop companion", values.isTrue("quiet"), "appearance") { put("quiet", it) }
    toggle("Reduced motion", values.isTrue("reducedMotion"), "appearance") { put("reducedMotion", it) }
    val web = values.obj("webSearch"); toggle("Web search", web?.isTrue("enabled") == true, "search") { put("webSearch", JsonObject(web.orEmpty() + ("enabled" to JsonPrimitive(it)))) }
    val memory = values.obj("memory"); toggle("Project memory", memory?.isTrue("enabled") == true, "memory") { put("memory", JsonObject(memory.orEmpty() + ("enabled" to JsonPrimitive(it)))) }
    Text("Automatic approval (all conversations)", style = MaterialTheme.typography.labelLarge)
    toggle("Provider commands without asking", values.isTrue("bypassCliPermissions"), "permissions", reviewEnable = true) { put("bypassCliPermissions", it) }
    toggle("Desktop actions without asking", values.isTrue("bypassComputerPermissions"), "permissions", reviewEnable = true) { put("bypassComputerPermissions", it) }
    toggle("Pause PAL's desktop actions", values.isTrue("paused"), "permissions") { put("paused", it) }
}

/** The same ledger the desktop shows: exact counts only where providers reported them; costs only from entered prices. */
@Composable
private fun UsageSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var days by rememberSaveable { mutableStateOf(30) }
    var summary by remember { mutableStateOf<JsonObject?>(null) }
    var limit by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var remove by rememberSaveable { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.usage.summary", buildJsonObject { put("days", days) }) as JsonObject }.onSuccess { value -> summary = value; limit = value.obj("policy")?.get("monthlyLimit")?.let { (it as? JsonPrimitive)?.contentOrNull }.orEmpty().takeIf { it != "null" }.orEmpty() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(days) { load() }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf(7, 30, 90).forEach { d -> FilterChip(days == d, { days = d }, { Text("$d days") }) } }
    val value = summary ?: return Text("Loading…")
    val totals = value.obj("totals"); val currency = value.str("currency").orEmpty()
    Text("${totals?.num("calls") ?: 0} requests · ${totals?.num("inputTokens") ?: 0} in / ${totals?.num("outputTokens") ?: 0} out tokens reported" + ((totals?.num("images") ?: 0).takeIf { it > 0 }?.let { " · $it images" } ?: ""))
    Text("Priced cost: %.2f %s".format((totals?.get("cost") as? JsonPrimitive)?.doubleOrNull ?: 0.0, currency) + ((totals?.num("unpriced") ?: 0).takeIf { it > 0 }?.let { " (+$it unpriced)" } ?: ""), style = MaterialTheme.typography.bodySmall)
    Text("Reported ${totals?.num("reported") ?: 0} · estimated ${totals?.num("estimated") ?: 0} · unknown ${totals?.num("unknown") ?: 0} · subscription ${totals?.num("subscription") ?: 0}", style = MaterialTheme.typography.bodySmall)
    (value["warnings"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.contentOrNull.orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    value.list("byProvider").take(8).forEach { row -> Text("${row.str("key")} · ${row.num("calls")} · " + if ((row.num("priced") ?: 0) > 0) "%.2f %s".format((row["cost"] as? JsonPrimitive)?.doubleOrNull ?: 0.0, currency) else "unpriced", style = MaterialTheme.typography.bodySmall) }
    val savedLimit = value.obj("policy")?.str("monthlyLimit")
    val decimal = limit.trim().takeIf { it.matches(Regex("""(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)""")) }?.toBigDecimalOrNull()
    val valid = decimal != null && decimal <= java.math.BigDecimal("10000000") && decimal.compareTo(java.math.BigDecimal.valueOf(decimal.toDouble())) == 0
    Text(savedLimit?.let { "Current monthly limit · $it $currency" } ?: "No monthly limit set")
    OutlinedTextField(limit, { limit = it }, Modifier.fillMaxWidth(), label = { Text("Monthly limit ($currency)") },
        singleLine = true, isError = limit.isNotBlank() && !valid, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        supportingText = { if (limit.isNotBlank() && !valid) Text("Enter a number between 0 and 10,000,000.") })
    fun save(amount: Double?) {
        if (saving) return
        saving = true
        scope.launch {
            try {
                ownerCall { signed(activity, repository, "owner.usage.setPolicy", buildJsonObject {
                    put("expectedRevision", value.obj("policy")?.str("revision") ?: "0")
                    put("monthlyLimit", amount?.let { JsonPrimitive(it) } ?: JsonNull)
                }, if (amount == null) "Remove the monthly limit" else "Set the monthly limit to $limit $currency") }
                    .onSuccess { feedback(if (amount == null) "Monthly limit removed" else "Monthly limit saved"); load() }
                    .onFailure { failure(it.message.orEmpty()) }
            } finally { saving = false }
        }
    }
    Button({ decimal?.let { save(it.toDouble()) } }, enabled = valid && !saving) { Text(if (saving) "Saving…" else "Save limit") }
    if (savedLimit != null) TextButton({ remove = true }, enabled = !saving) { Text("Remove limit…") }
    if (remove) AlertDialog({ remove = false }, title = { Text("Remove the monthly limit?") },
        text = { Text("PAL will stop enforcing your $savedLimit $currency monthly limit on paid requests.") },
        confirmButton = { Button({ remove = false; save(null) }) { Text("Remove limit") } },
        dismissButton = { TextButton({ remove = false }) { Text("Keep limit") } })
    Text("PAL stops paid API requests at this limit; it is not a provider billing cap.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Skills: import (repository or desktop path), review once, enable; importing runs nothing. */
@Composable
private fun SkillsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var listing by remember { mutableStateOf<JsonObject?>(null) }
    var source by remember { mutableStateOf("") }
    var review by remember { mutableStateOf<JsonObject?>(null) }
    var automatic by remember { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.skills.list", buildJsonObject {}) as JsonObject }.onSuccess { listing = it }.onFailure { failure(it.message ?: "") } }
    fun open(id: String) = scope.launch { ownerCall { repository.request("owner.skills.review", buildJsonObject { put("versionId", id) }) as JsonObject }.onSuccess { review = it; automatic = it.obj("version")?.str("invocation") == "automatic" }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    Text("Reusable instructions a model loads when a task fits. Importing runs nothing; each version is reviewed once.", style = MaterialTheme.typography.bodySmall)
    listing?.list("versions").orEmpty().filter { it.str("status") != "superseded" }.forEach { version ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(version.str("name").orEmpty())
                Text(when (version.str("status")) { "review" -> "Waiting for your review"; "enabled" -> if (version.str("invocation") == "automatic") "On · offered automatically" else "On · when you name it"; else -> "Off" }, style = MaterialTheme.typography.bodySmall)
            }
            TextButton({ open(version.str("id").orEmpty()) }) { Text(if (version.str("status") == "review") "Review" else "Details") }
        }
    }
    OutlinedTextField(source, { source = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("https:// repository, or a folder or ZIP on the desktop") })
    Button({ scope.launch {
        val location = source.trim()
        val repositoryImport = location.startsWith("https://")
        ownerCall { signed(activity, repository, if (repositoryImport) "owner.skills.importRepository" else "owner.skills.importPath", buildJsonObject { if (repositoryImport) put("url", location) else put("path", location) }, "Import a skill") as JsonObject }
            .onSuccess { version -> source = ""; load(); version.str("id")?.let { open(it) } }.onFailure { failure(it.message ?: "") }
    } }, enabled = source.trim().startsWith("https://") || source.trim().startsWith("/")) { Text("Import") }
    review?.let { value ->
        val version = value.obj("version")
        AlertDialog({ review = null }, title = { Text(version?.str("name").orEmpty()) }, text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("${version?.obj("source")?.str("kind")} · ${version?.obj("source")?.str("uri").orEmpty()} ${version?.obj("source")?.str("revision")?.take(12).orEmpty()}", style = MaterialTheme.typography.bodySmall)
                Text("Scope · " + (version?.str("project") ?: "All projects"))
                Text("Files in this version", style = MaterialTheme.typography.titleSmall)
                version?.list("files").orEmpty().forEach { file ->
                    Text(file.str("path").orEmpty() + " · " + byteSize(file.num("bytes")) + if (file.isTrue("executable")) " · executable" else "",
                        style = MaterialTheme.typography.bodySmall)
                }
                if ((value["executables"] as? JsonArray)?.isNotEmpty() == true) Text("Executable files can run through command tools under your working profile.", color = MaterialTheme.colorScheme.error)
                value.obj("changes")?.let { changes ->
                    if (changes.isTrue("instructionsChanged")) Text("Standing instructions changed")
                    for (kind in listOf("added", "removed", "changed")) {
                        val paths = changes[kind] as? JsonArray ?: continue
                        if (paths.isNotEmpty()) Text(kind.replaceFirstChar { it.uppercase() } + " · " + paths.joinToString { it.jsonPrimitive.content })
                    }
                }
                Text("Complete instructions", style = MaterialTheme.typography.titleSmall)
                SelectionContainer { Column { value.str("instructions").orEmpty().chunked(2400).forEach { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } } }
                if (version?.str("status") != "enabled") LabeledCheck("Offer automatically when a task fits", automatic) { automatic = it }
            }
        }, confirmButton = {
            if (version?.str("status") != "enabled") Button({ scope.launch {
                ownerCall { signed(activity, repository, "owner.skills.enable", buildJsonObject { put("versionId", version?.str("id").orEmpty()); put("invocation", if (automatic) "automatic" else "explicit"); put("expectedRevision", value.str("revision") ?: "0") }, "Enable ${version?.str("name")}") }
                    .onSuccess { feedback("${version?.str("name")} is on"); review = null; load() }.onFailure { failure(it.message ?: "") }
            } }) { Text("Enable this version") }
            else TextButton({ scope.launch { ownerCall { repository.mutate("owner.skills.disable", buildJsonObject { put("versionId", version.str("id").orEmpty()) }) }.onSuccess { review = null; load() }.onFailure { failure(it.message ?: "") } } }) { Text("Turn off") }
        }, dismissButton = { TextButton({ review = null }) { Text("Close") } })
    }
}

/** Collections: create, add a desktop file or folder, use it everywhere or in a conversation's project, index, delete. */
@Composable
private fun CollectionsSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit, initialSessionId: String?) {
    val scope = rememberOwnerScope()
    var target by rememberSaveable { mutableStateOf(initialSessionId?.takeIf { id -> state.sessions.any { it.id == id } } ?: state.selectedSessionId ?: state.sessions.maxByOrNull { it.updated }?.id) }
    TargetConversation(state, target) { target = it }
    var collections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var deleting by remember { mutableStateOf<JsonObject?>(null) }
    var name by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("") }
    fun load() = scope.launch { ownerCall { repository.request("owner.collections.list", buildJsonObject {}) }.onSuccess { value -> collections = (value as? JsonObject)?.list("collections") ?: value.objects() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    collections.forEach { collection ->
        val id = collection.str("id").orEmpty()
        val revision = collection.str("revision") ?: "0"
        Text("${collection.str("name")} · ${collection.list("sources").size} sources" + (collection.str("state")?.let { " · $it" } ?: ""), style = MaterialTheme.typography.titleSmall)
        collection.list("sources").take(6).forEach { Text(it.str("path").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.addSource", buildJsonObject { put("id", id); put("expectedRevision", revision); put("path", source.trim()) }, "Add ${source.trim()} to ${collection.str("name")}") }.onSuccess { source = ""; feedback("Source added"); load() }.onFailure { failure(it.message ?: "") } } }, enabled = source.trim().startsWith("/")) { Text("Add source") }
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.index", buildJsonObject { put("id", id) }, "Index ${collection.str("name")}") }.onSuccess { feedback("Indexing on the desktop") }.onFailure { failure(it.message ?: "") } } }) { Text("Index") }
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.bind", buildJsonObject { put("id", id); put("target", "global"); put("bound", true) }, "Use ${collection.str("name")} everywhere") }.onSuccess { feedback("Used in every conversation") }.onFailure { failure(it.message ?: "") } } }) { Text("Use everywhere") }
            target?.takeIf { id -> state.sessions.any { it.id == id } }?.let { sessionId -> TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.bind", buildJsonObject { put("id", id); put("target", "project"); put("sessionId", sessionId); put("bound", true) }, "Use ${collection.str("name")} in this project") }.onSuccess { feedback("Used in this project") }.onFailure { failure(it.message ?: "") } } }) { Text("Use in selected conversation’s project") } }
            TextButton({ deleting = collection }) { Text("Delete…") }
            // §11.1: a web page read once and kept as a dated snapshot; watched folders update after changes settle.
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.addUrl", buildJsonObject { put("id", id); put("url", source.trim()) }, "Add the page ${source.trim()} to ${collection.str("name")}") }.onSuccess { source = ""; feedback("Page added; index the collection to use it"); load() }.onFailure { failure(it.message ?: "") } } }, enabled = source.trim().startsWith("http")) { Text("Add as web page") }
            FilterChip(collection.isTrue("watch"), { scope.launch { ownerCall { repository.mutate("owner.collections.setWatch", buildJsonObject { put("id", id); put("watch", !collection.isTrue("watch")) }, "Watch folders") }.onSuccess { load() }.onFailure { failure(it.message ?: "") } } }, { Text(if (collection.list("sources").none { it.str("kind") == "folder" } && !collection.isTrue("watch")) "Add a folder to watch" else "Watch folders") }, enabled = collection.isTrue("watch") || collection.list("sources").any { it.str("kind") == "folder" })
        }
    }
    deleting?.let { selected ->
        val nameToDelete = selected.str("name").orEmpty()
        AlertDialog({ deleting = null }, title = { Text("Delete $nameToDelete?") },
            text = { Text("Remove this collection, its index and its " + selected.list("sources").size + " source references. Your original files stay on the computer.") },
            confirmButton = { Button({ deleting = null; scope.launch {
                ownerCall { signed(activity, repository, "owner.collections.delete", buildJsonObject {
                    put("id", selected.str("id").orEmpty()); put("expectedRevision", selected.str("revision") ?: "0"); put("confirmed", true)
                }, "Delete $nameToDelete and its index") }.onSuccess { feedback("Deleted $nameToDelete"); load() }.onFailure { failure(it.message.orEmpty()) }
            } }) { Text("Delete collection") } }, dismissButton = { TextButton({ deleting = null }) { Text("Cancel") } })
    }
    OutlinedTextField(source, { source = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Desktop file or folder (absolute path), or a web page address") })
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name, { name = it.take(100) }, Modifier.weight(1f), singleLine = true, label = { Text("New collection") })
        Button({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.create", buildJsonObject { put("name", name.trim()) }, "Create the collection ${name.trim()}") }.onSuccess { name = ""; load() }.onFailure { failure(it.message ?: "") } } }, enabled = name.isNotBlank()) { Text("Create") }
    }
    Text("PAL never indexes your whole home folder; add the files and folders a collection should cover.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * Tool servers (PAL Everywhere §14): sign in to a server at an address from this phone (the browser returns to the app,
 * the desktop exchanges the code and keeps the tokens), import another app's configuration for review, and settle
 * requests whose answer was lost.
 */
@Composable
private fun ToolServersSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit,
    initialToolServerId: String?, toolServerResult: String?, onOAuthStarted: (String) -> Unit) {
    val scope = rememberOwnerScope()
    val context = androidx.compose.ui.platform.LocalContext.current
    var servers by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var writes by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var importText by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf<JsonObject?>(null) }
    var chosen by remember { mutableStateOf(setOf<String>()) }
    fun load() = scope.launch {
        ownerCall { repository.request("owner.extensions.status", buildJsonObject {}) }.onSuccess { servers = it.objects() }.onFailure { failure(it.message ?: "") }
        ownerCall { repository.request("owner.extensions.writes", buildJsonObject {}) }.onSuccess { rows -> writes = rows.objects().filter { it.str("state") == "unknown" } }
    }
    LaunchedEffect(Unit) { load() }
    var resultText by rememberSaveable(initialToolServerId, toolServerResult) { mutableStateOf(toolServerResult) }
    var resultServer by rememberSaveable(initialToolServerId, toolServerResult) { mutableStateOf(initialToolServerId) }
    if (resultText != null && servers.none { it.str("id") == resultServer }) Text(resultText.orEmpty(), Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    if (servers.isEmpty()) Text("No tool servers on the desktop.", style = MaterialTheme.typography.bodySmall)
    servers.sortedByDescending { it.str("id") == resultServer }.forEach { server ->
        val id = server.str("id").orEmpty(); val name = server.str("name").orEmpty(); val oauth = server.obj("oauth")
        Text("$name · ${server.str("state")}" + (server.str("url")?.let { " · $it" } ?: "") + (if (oauth?.isTrue("signedIn") == true) " · signed in" else ""), style = MaterialTheme.typography.bodyMedium)
        if (id == resultServer && resultText != null) Text(resultText.orEmpty(), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.titleSmall)
        server.str("error")?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (server.str("transport") == "http" && oauth?.isTrue("signedIn") != true) TextButton({ scope.launch {
                ownerCall { signed(activity, repository, "owner.extensions.oauthStart", buildJsonObject { put("id", id) }, "Sign in to $name from this phone") as JsonObject }
                    .onSuccess { started -> onOAuthStarted(id); context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(started.str("authorizationUrl")))) }
                    .onFailure { failure(it.message ?: "") }
            } }, enabled = server.isTrue("enabled")) { Text(if (id == resultServer && resultText != null) "Sign in again" else "Sign in") }
            if (oauth?.isTrue("signedIn") == true) TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.extensions.oauthSignOut", buildJsonObject { put("id", id) }, "Sign out of $name") }.onSuccess { resultServer = id; resultText = "Signed out of $name"; load() }.onFailure { failure(it.message ?: "") } } }) { Text("Sign out") }
            TextButton({ scope.launch { ownerCall { repository.mutate("owner.extensions.restart", buildJsonObject { put("id", id) }, "Start $name") }.onSuccess { load() }.onFailure { failure(it.message ?: ""); load() } } }, enabled = server.isTrue("enabled")) { Text(if (server.str("state") == "ready") "Restart" else "Start") }
        }
    }
    if (writes.isNotEmpty()) {
        Text("Requests to check", style = MaterialTheme.typography.titleSmall)
        Text("Their answer was lost, so PAL does not know whether they took effect, and will not send the same request again until you say.", style = MaterialTheme.typography.bodySmall)
        var reviewing by remember { mutableStateOf<JsonObject?>(null) }
        writes.forEach { write ->
            val at = write.num("at")?.let { java.time.Instant.ofEpochMilli(it).toString() }.orEmpty()
            Text(write.str("server").orEmpty() + " · " + (write.str("intent") ?: write.str("tool")).orEmpty())
            Text((write.str("conversationTitle") ?: write.str("sessionId")).orEmpty() + " · " + at, style = MaterialTheme.typography.bodySmall)
            TextButton({ reviewing = write }) { Text("Check request " + write.str("id").orEmpty().take(8)) }
        }
        reviewing?.let { write ->
            AlertDialog({ reviewing = null }, title = { Text("Check the change in " + write.str("server").orEmpty()) }, text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text((write.str("intent") ?: write.str("tool")).orEmpty())
                    Text("Conversation · " + (write.str("conversationTitle") ?: write.str("sessionId")).orEmpty())
                    write.num("at")?.let { Text("Time · " + java.time.Instant.ofEpochMilli(it)) }
                    SelectionContainer { Text("PAL request · " + write.str("id").orEmpty()) }
                    write.str("result")?.let { SelectionContainer { Text("Service reference · $it") } }
                    Text("Record the result after checking the service. Either answer permits a future identical request. This action sends nothing to the service.")
                    for ((outcome, label) in listOf("done" to "It took effect", "not-done" to "It did not take effect")) {
                        OutlinedButton({ scope.launch {
                            ownerCall { signed(activity, repository, "owner.extensions.resolveWrite", buildJsonObject {
                                put("id", write.str("id").orEmpty()); put("outcome", outcome)
                            }, "Record the checked outcome: $label") }.onSuccess { reviewing = null; feedback("Outcome recorded"); load() }.onFailure { failure(it.message.orEmpty()) }
                        } }) { Text(label) }
                    }
                }
            }, confirmButton = { TextButton({ reviewing = null }) { Text("Leave unresolved") } })
        }
    }
    Text("Import from another app", style = MaterialTheme.typography.titleSmall)
    if (preview == null) {
        OutlinedTextField(importText, { importText = it }, Modifier.fillMaxWidth(), minLines = 3, maxLines = 8, label = { Text("Paste an MCP configuration (JSON)") })
        TextButton({ scope.launch { ownerCall { repository.request("owner.extensions.importPreview", buildJsonObject { put("text", importText) }) as JsonObject }.onSuccess { preview = it; chosen = it.list("servers").filter { server -> server.str("problem") == null }.mapNotNull { server -> server.str("name") }.toSet() }.onFailure { failure(it.message ?: "") } } }, enabled = importText.length > 1) { Text("Review") }
    } else preview?.let { reviewed ->
        reviewed.list("servers").forEach { server ->
            val name = server.str("name").orEmpty()
            val problem = server.str("problem")
            if (problem == null) LabeledCheck(name, name in chosen) { chosen = if (it) chosen + name else chosen - name }
            else Text("$name · $problem", color = MaterialTheme.colorScheme.error)
            server.str("url")?.let { Text("Address · $it") }
            server.str("network")?.let { Text("Network · " + if (it == "local") "This computer or local network" else "Internet") }
            server.str("command")?.let { Text("Program · $it", fontFamily = FontFamily.Monospace) }
            (server["args"] as? JsonArray)?.let { Text("Arguments · " + if (it.isEmpty()) "None" else it.toString(), fontFamily = FontFamily.Monospace) }
            server.str("cwd")?.let { Text("Working folder · $it") }
            server.list("secrets").forEach { Text("Credential · " + it.str("name").orEmpty() + if (it.str("value") == "missing") " (set later)" else " (value imported)") }
            (server["warnings"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content, color = MaterialTheme.colorScheme.error) }
            HorizontalDivider()
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton({ preview = null }) { Text("Back") }
            Button({ scope.launch { ownerCall { signed(activity, repository, "owner.extensions.importApply", buildJsonObject { put("token", reviewed.str("token").orEmpty()); put("names", JsonArray(chosen.map { JsonPrimitive(it) })) }, "Add ${chosen.size} tool servers to the desktop, turned off") }.onSuccess { preview = null; importText = ""; feedback("Added, turned off. Review each one before turning it on."); load() }.onFailure { failure(it.message ?: "") } } }, enabled = chosen.isNotEmpty()) { Text("Add, turned off") }
        }
    }
}

/** Working setups (§12.3): apply one to the open conversation after seeing its changes, or start a conversation with it. */
@Composable
private fun SetupsSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit, initialSessionId: String?) {
    val scope = rememberOwnerScope()
    var target by rememberSaveable { mutableStateOf(initialSessionId?.takeIf { id -> state.sessions.any { it.id == id } } ?: state.selectedSessionId ?: state.sessions.maxByOrNull { it.updated }?.id) }
    TargetConversation(state, target) { target = it }
    var setups by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var preview by remember { mutableStateOf<JsonObject?>(null) }
    var supportsStartRevision by remember { mutableStateOf(false) }
    var startReview by remember { mutableStateOf<JsonObject?>(null) }
    var previewTarget by remember { mutableStateOf("") }
    var folder by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { ownerCall { repository.request("owner.setups.list", buildJsonObject {}) as JsonObject }.onSuccess { setups = it.list("setups"); supportsStartRevision = it.isTrue("supportsStartRevision") }.onFailure { failure(it.message ?: "") } }
    fun startConversation(setup: JsonObject) {
        val name = setup.str("name").orEmpty()
        val host = setup.obj("families")?.isTrue("host") == true
        if (host && !supportsStartRevision) {
            failure("Update PAL on the desktop to start this setup with reviewed Host commands.")
            return
        }
        scope.launch {
            ownerCall { signed(activity, repository, "owner.setups.start", buildJsonObject {
                put("setupId", setup.str("id").orEmpty()); put("cwd", folder.trim())
                if (supportsStartRevision) put("expectedSetupRevision", setup.str("revision").orEmpty())
                if (model.isNotBlank()) put("model", model.trim())
            }, "Start a conversation with $name in ${folder.trim()}") as JsonObject }
                .onSuccess { started ->
                    val missing = (started["unresolved"] as? JsonArray).orEmpty().joinToString(" ") { it.jsonPrimitive.content }
                    feedback("Started with $name" + if (missing.isNotEmpty()) ". Missing: $missing" else "")
                    started.obj("session")?.str("id")?.let { target = it; repository.selectSession(it) }
                }.onFailure { failure(it.message.orEmpty()) }
        }
    }
    setups.forEach { setup ->
        val id = setup.str("id").orEmpty(); val name = setup.str("name").orEmpty()
        Text(name + if (setup.isTrue("builtin")) " · example" else "", style = MaterialTheme.typography.bodyMedium)
        setup.str("description")?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            target?.takeIf { id -> state.sessions.any { it.id == id } }?.let { sessionId -> TextButton({ scope.launch {
                ownerCall { repository.request("owner.setups.preview", buildJsonObject { put("setupId", id); put("sessionId", sessionId) }) as JsonObject }.onSuccess { previewTarget = state.sessions.firstOrNull { row -> row.id == sessionId }?.title ?: sessionId; preview = it }.onFailure { failure(it.message ?: "") }
            } }) { Text("Preview for selected conversation") } }
            TextButton({
                if (setup.obj("families")?.isTrue("host") == true) startReview = setup else startConversation(setup)
            }, enabled = folder.trim().startsWith("/")) { Text("Start a conversation") }
        }
    }
    OutlinedTextField(folder, { folder = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Project folder for new conversations") })
    OutlinedTextField(model, { model = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Model, when the setup names none (optional)") })
    startReview?.let { setup ->
        AlertDialog({ startReview = null }, title = { Text("Start with Host commands?") },
            text = { Text("“" + setup.str("name").orEmpty() + "” will open a new conversation in " + folder.trim() +
                ". Its model can run commands as your desktop account and access its files, keys and network. Your desktop command approval settings apply.") },
            confirmButton = { Button({ startReview = null; startConversation(setup) }) { Text("Start with Host commands") } },
            dismissButton = { TextButton({ startReview = null }) { Text("Cancel") } })
    }
    preview?.let { reviewed ->
        AlertDialog({ preview = null }, title = { Text("Apply ${reviewed.obj("setup")?.str("name")}") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Conversation · $previewTarget")
                val changes = reviewed.list("changes")
                if (changes.isEmpty()) Text("Nothing would change.")
                changes.forEach { change ->
                    if (change.str("kind") == "instructions") {
                        var full by remember(reviewed) { mutableStateOf(false) }
                        Text("Standing instructions will change")
                        TextButton({ full = !full }) { Text(if (full) "Hide full change" else "Read full change") }
                        if (full) {
                            Text("Current instructions"); Text(change.str("from").orEmpty())
                            Text("Proposed instructions"); Text(change.str("to").orEmpty())
                        }
                    } else Text("${change.str("label")}: " + (change.str("from")?.let { "$it → " } ?: "") + change.str("to").orEmpty(), style = MaterialTheme.typography.bodySmall)
                }
                (reviewed["unresolved"] as? JsonArray)?.forEach { Text("Missing: " + it.jsonPrimitive.content, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                (reviewed["notes"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content, style = MaterialTheme.typography.bodySmall) }
            }
        }, confirmButton = { Button({ scope.launch {
            ownerCall { signed(activity, repository, "owner.setups.apply", buildJsonObject { put("token", reviewed.str("token").orEmpty()) }, "Apply ${reviewed.obj("setup")?.str("name")} to this conversation") }
                .onSuccess { preview = null; feedback("Applied") }.onFailure { failure(it.message ?: ""); preview = null }
        } }, enabled = reviewed.list("changes").isNotEmpty()) { Text("Apply") } }, dismissButton = { TextButton({ preview = null }) { Text("Cancel") } })
    }
}

/** Specialists (§17.2): what a conversation can ask, how many run at once, and custom ones with their own model. */
@Composable
private fun SpecialistsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var name by remember { mutableStateOf("") }; var role by remember { mutableStateOf("code_review") }; var model by remember { mutableStateOf("") }
    fun load() = scope.launch { ownerCall { repository.request("owner.specialists.list", buildJsonObject {}) as JsonObject }.onSuccess { data = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    val roles = data?.obj("roles")
    data?.list("specialists")?.forEach { item ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${item.str("name")} · ${roles?.str(item.str("role").orEmpty()) ?: item.str("role")}" + (item.str("model")?.let { " · $it" } ?: ""), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            if (!item.isTrue("builtin")) ConfirmRemoval("Delete", item.str("name").orEmpty(), "This specialist will no longer be available to conversations.") { scope.launch { ownerCall { signed(activity, repository, "owner.specialists.delete", buildJsonObject { put("id", item.str("id").orEmpty()) }, "Delete the specialist ${item.str("name")}") }.onSuccess { load() }.onFailure { failure(it.message ?: "") } } }
        }
    }
    Text("At most this many run at once in a conversation:", style = MaterialTheme.typography.bodySmall)
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        (1..4).forEach { count -> FilterChip(data?.int("concurrency") == count, { scope.launch { ownerCall { signed(activity, repository, "owner.specialists.setConcurrency", buildJsonObject { put("concurrency", count) }, "Run up to $count specialists at once") }.onSuccess { load() }.onFailure { failure(it.message ?: "") } } }, { Text("$count") }) }
    }
    OutlinedTextField(name, { name = it.take(60) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("New specialist name") })
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { roles?.keys?.forEach { id -> FilterChip(role == id, { role = id }, { Text(roles.str(id).orEmpty()) }) } }
    OutlinedTextField(model, { model = it.trim() }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Ollama model (optional; otherwise the helper model)") })
    Button({ scope.launch {
        ownerCall { signed(activity, repository, "owner.specialists.save", buildJsonObject { put("specialist", buildJsonObject { put("name", name.trim()); put("role", role); if (model.isNotBlank() && role != "visual_review") { put("provider", "ollama"); put("model", model) } }) }, "Add the specialist ${name.trim()}") }
            .onSuccess { name = ""; model = ""; load() }.onFailure { failure(it.message ?: "") }
    } }, enabled = name.isNotBlank()) { Text("Add") }
    Text("Specialists have no tools and change nothing; a document editor's edits arrive as a change set to review. Their runs appear under Work › Runs.", style = MaterialTheme.typography.bodySmall)
}

/** Saved scripts: the commands PAL may run, edited as the desktop edits them (settings family "scripts"). */
@Composable
private fun ScriptsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var settings by remember { mutableStateOf<JsonObject?>(null) }
    var name by remember { mutableStateOf("") }; var executable by remember { mutableStateOf("") }; var args by remember { mutableStateOf("[]") }; var cwd by remember { mutableStateOf("") }
    fun load() = scope.launch { ownerCall { repository.request("owner.settings.get", buildJsonObject {}) as JsonObject }.onSuccess { settings = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    val scripts = (settings?.obj("settings")?.get("scripts") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
    fun save(next: List<JsonObject>, title: String) = scope.launch {
        ownerCall { signed(activity, repository, "owner.settings.patch", buildJsonObject { put("expectedRevision", settings?.str("revision") ?: "0"); put("family", "scripts"); put("values", buildJsonObject { put("scripts", JsonArray(next)) }) }, title) }
            .onSuccess { feedback(title); load() }.onFailure { failure(it.message ?: "") }
    }
    scripts.forEach { script ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text(script.str("name").orEmpty()); Text("${script.str("executable")} ${(script["args"] as? JsonArray).orEmpty().joinToString(" ") { it.jsonPrimitive.content }} · ${script.str("cwd")}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
            ConfirmRemoval("Remove", script.str("name").orEmpty(), "This removes the saved script from PAL on the desktop.") { save(scripts.filter { it.str("id") != script.str("id") }, "Remove ${script.str("name")}") }
        }
    }
    OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Name") })
    OutlinedTextField(executable, { executable = it.trim() }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Executable (absolute path on the desktop)") })
    OutlinedTextField(args, { args = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Arguments (JSON array)") })
    OutlinedTextField(cwd, { cwd = it.trim() }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Working folder (absolute path)") })
    Button({
        val parsed = ownerCall { Json.parseToJsonElement(args) as JsonArray }.getOrNull()
        if (parsed == null) { failure("Arguments must be a JSON array of strings"); return@Button }
        save(scripts + buildJsonObject { put("id", java.util.UUID.randomUUID().toString()); put("name", name.trim()); put("executable", executable); put("args", parsed); put("cwd", cwd); put("timeout", 60) }, "Add the saved script ${name.trim()}")
    }, enabled = name.isNotBlank() && executable.startsWith("/") && cwd.startsWith("/")) { Text("Add script") }
    Text("Saved scripts run as your desktop account when you or a conversation runs them; each run is reviewed unless your working profile allows it.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * Routines (PAL Everywhere §17.1): the desktop's schedules, created here from a reviewed recipe exactly as on the
 * desktop. The phone that signs a routine's creation is recorded as its authorizer; removing that phone pauses it
 * unless the desktop takes the authorization over ("Authorize on the desktop").
 */
@Composable
private fun SchedulesSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var schedules by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var creating by remember { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.schedules.list", buildJsonObject {}) }.onSuccess { schedules = it.objects() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    if (schedules.isEmpty()) Text("No routines yet.", style = MaterialTheme.typography.bodySmall)
    schedules.forEach { schedule ->
        val id = schedule.str("id").orEmpty()
        val label = schedule.str("label").orEmpty()
        val whenObj = schedule.obj("when")
        val by = schedule.obj("authorizedBy")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label)
                val timing = if (whenObj?.str("kind") == "folder") "When files change in ${whenObj.str("path")}" + (if (schedule.obj("pending") != null) " · changes waiting" else "")
                    else schedule.num("next")?.let { "Next: " + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(it)) } ?: "No next run"
                Text((if (schedule.isTrue("enabled")) timing else "Paused") + (schedule.obj("lastRun")?.let { " · last: ${it.str("outcome")}" + (it.str("reason")?.let { reason -> " ($reason)" } ?: "") } ?: "") +
                    (if (by?.str("kind") == "device") " · authorized from ${by.str("name")}" else " · authorized on the desktop"), style = MaterialTheme.typography.bodySmall)
            }
            Switch(schedule.isTrue("enabled"), { enabled -> scope.launch {
                ownerCall { signed(activity, repository, "owner.schedules.setEnabled", buildJsonObject { put("id", id); put("enabled", enabled) }, if (enabled) "Resume $label" else "Pause $label") }
                    .onSuccess { load() }.onFailure { failure(it.message ?: "") }
            } })
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            var adopting by rememberSaveable(id) { mutableStateOf(false) }
            if (by?.str("kind") == "device" && schedule.str("pausedFor") == null) TextButton({ adopting = true }) { Text("Transfer authorization…") }
            if (adopting) AlertDialog({ adopting = false }, title = { Text("Transfer $label to the desktop?") },
                text = { Text("The desktop will authorize this routine. It can keep running after " + (by?.str("name") ?: "the authorizing phone") + " loses access. You can pause or delete the routine here.") },
                confirmButton = { Button({ adopting = false; scope.launch {
                    ownerCall { signed(activity, repository, "owner.schedules.adopt", buildJsonObject { put("id", id) }, "Make the desktop the authorizer of $label") }
                        .onSuccess { feedback("Authorized on the desktop"); load() }.onFailure { failure(it.message.orEmpty()) }
                } }) { Text("Transfer authorization") } }, dismissButton = { TextButton({ adopting = false }) { Text("Cancel") } })
            ConfirmRemoval("Delete", label, "This routine will no longer run. Its previous results stay available.") { scope.launch {
                ownerCall { signed(activity, repository, "owner.schedules.delete", buildJsonObject { put("id", id) }, "Delete the routine $label") }.onSuccess { load() }.onFailure { failure(it.message ?: "") }
            } }
        }
    }
    if (!creating) TextButton({ creating = true }) { Text("New routine…") }
    else RoutineCreator(repository, state, activity, { creating = false; load() }, feedback, failure)
}

/** Recipe → inputs → reviewed prompt → when it runs. Nothing runs now; the reviewed preview becomes the routine. */
@Composable
private fun RoutineCreator(repository: PALRepository, state: MobileState, activity: FragmentActivity, done: () -> Unit, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var sessionId by remember { mutableStateOf(state.selectedSessionId ?: state.sessions.firstOrNull()?.id) }
    var recipes by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var recipe by remember { mutableStateOf<JsonObject?>(null) }
    val values = remember { mutableStateMapOf<String, JsonElement>() }
    var preview by remember { mutableStateOf<JsonObject?>(null) }
    var label by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("daily") }
    var time by remember { mutableStateOf("08:00") }
    var date by remember { mutableStateOf("") }
    var days by remember { mutableStateOf(setOf(1)) }
    var folder by remember { mutableStateOf("") }
    var quiet by remember { mutableStateOf("30") }
    var catchUp by remember { mutableStateOf(false) }
    var unattended by remember { mutableStateOf(false) }
    var roots by remember(sessionId) { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(sessionId, kind) {
        if (sessionId != null && kind == "folder") {
            val project = state.sessions.firstOrNull { it.id == sessionId }?.project
            roots = listOfNotNull(project)
            ownerCall { repository.request("workbench.roots", buildJsonObject { put("sessionId", sessionId) }) as JsonObject }
                .onSuccess { roots = (listOfNotNull(project) + it.list("roots").mapNotNull { root -> root.str("path") }).distinct() }
                .onFailure { failure(it.message.orEmpty()) }
        }
    }
    LaunchedEffect(Unit) { ownerCall { repository.request("owner.recipes.list", buildJsonObject {}) as JsonObject }.onSuccess { recipes = it.list("recipes") }.onFailure { failure(it.message ?: "") } }
    var sessionsOpen by remember { mutableStateOf(false) }
    Box {
        TextButton({ sessionsOpen = true }) { Text("Conversation: " + (state.sessions.firstOrNull { it.id == sessionId }?.title ?: "choose")) }
        DropdownMenu(sessionsOpen, { sessionsOpen = false }) { state.sessions.forEach { session -> DropdownMenuItem(text = { Text(session.title) }, onClick = { sessionId = session.id; preview = null; sessionsOpen = false }) } }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        recipes.forEach { item -> FilterChip(recipe?.str("id") == item.str("id"), { recipe = item; values.clear(); preview = null; if (label.isBlank()) label = item.str("name").orEmpty() }, { Text(item.str("name").orEmpty()) }) }
    }
    recipe?.let { chosen ->
        chosen.str("description")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        chosen.list("inputs").forEach { input -> RecipeInputField(repository, sessionId, input, values[input.str("name").orEmpty()]) { value -> preview = null; if (value == null) values.remove(input.str("name").orEmpty()) else values[input.str("name").orEmpty()] = value } }
        Button({ scope.launch {
            ownerCall { repository.request("owner.recipes.prepare", buildJsonObject { put("sessionId", sessionId.orEmpty()); put("recipeId", chosen.str("id").orEmpty()); put("inputs", JsonObject(values.toMap())) }) as JsonObject }
                .onSuccess { preview = it }.onFailure { failure(it.message ?: "") }
        } }, enabled = sessionId != null) { Text("Review the prompt") }
    }
    preview?.let { reviewed ->
        Text("The exact prompt each run sends:", style = MaterialTheme.typography.labelMedium)
        var expanded by remember(reviewed) { mutableStateOf(false) }
        Text(reviewed.str("prompt").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
            maxLines = if (expanded) Int.MAX_VALUE else 14, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        TextButton({ expanded = !expanded }) { Text(if (expanded) "Collapse prompt" else "Read full prompt") }
        OutlinedTextField(label, { label = it.take(80) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Routine name") })
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("daily" to "Every day", "weekdays" to "Weekdays", "weekly" to "Chosen days", "once" to "Once", "folder" to "When files change").forEach { (id, text) -> FilterChip(kind == id, { kind = id }, { Text(text) }) }
        }
        if (kind == "folder") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                roots.forEach { path -> FilterChip(folder == path, { folder = path }, { Text(path) }) }
            }
            OutlinedTextField(folder, { folder = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Project folder to watch (absolute path)") })
            OutlinedTextField(quiet, { quiet = it.filter(Char::isDigit).take(4) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Seconds of quiet before it runs (5–3,600)") })
            Text("It runs once after the folder settles, with the changed names. Only the conversation's project folder or its Workbench folders can be watched.", style = MaterialTheme.typography.bodySmall)
        } else {
            OutlinedTextField(time, { time = it.take(5) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Time (HH:MM, desktop time zone)") })
            if (kind == "weekly") FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) { listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat").forEachIndexed { index, day -> FilterChip(index in days, { days = if (index in days) days - index else days + index }, { Text(day) }) } }
            if (kind == "once") OutlinedTextField(date, { date = it.take(10) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Date (YYYY-MM-DD)") })
            LabeledCheck("If the desktop was off at that time, run once when it is back", catchUp) { catchUp = it }
        }
        if (kind == "folder" && folder.isNotBlank()) Text("Watch " + folder.trim() + " after " + quiet + " seconds without a change.")
        LabeledCheck("It may run while I am away. Permission questions wait for me.", unattended) { unattended = it }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(done) { Text("Cancel") }
            Button({ scope.launch {
                val whenValue = buildJsonObject {
                    put("kind", kind)
                    if (kind == "folder") { put("path", folder.trim()); put("quietSeconds", quiet.toIntOrNull() ?: 30) } else put("time", time)
                    if (kind == "weekly") put("days", JsonArray(days.sorted().map { JsonPrimitive(it) }))
                    if (kind == "once") put("date", date)
                }
                ownerCall { signed(activity, repository, "owner.schedules.create", buildJsonObject { put("label", label.trim()); put("when", whenValue); put("previewToken", reviewed.str("token").orEmpty()); put("unattended", true); if (catchUp && kind != "folder") put("missed", "once") }, "Schedule ${label.trim()} to run while you are away") }
                    .onSuccess { feedback("Routine saved. Its results go to the inbox; permission questions wait for you."); done() }.onFailure { failure(it.message ?: "") }
            } }, enabled = unattended && label.isNotBlank() && (kind != "folder" || (folder.trim().startsWith("/") && quiet.toIntOrNull() in 5..3600))) { Text("Save routine") }
        }
    }
}

/** One recipe input: text, number or a switch, or a file/folder/artifact/collection picked from the conversation's references. */
@Composable
private fun RecipeInputField(repository: PALRepository, sessionId: String?, input: JsonObject, value: JsonElement?, set: (JsonElement?) -> Unit) {
    val scope = rememberOwnerScope()
    val type = input.str("type").orEmpty()
    val title = input.str("label").orEmpty() + if (input.isTrue("required")) " *" else ""
    when (type) {
        "text" -> OutlinedTextField((value as? JsonPrimitive)?.contentOrNull ?: input.str("default").orEmpty(), { set(JsonPrimitive(it)) }, Modifier.fillMaxWidth(), label = { Text(title) })
        "number" -> OutlinedTextField((value as? JsonPrimitive)?.contentOrNull ?: input.str("default").orEmpty(), { text -> set(text.toDoubleOrNull()?.let { JsonPrimitive(it) }) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(title) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        "boolean" -> LabeledCheck(title, (value as? JsonPrimitive)?.booleanOrNull ?: input.isTrue("default")) { set(JsonPrimitive(it)) }
        else -> {
            var query by remember { mutableStateOf("") }
            var candidates by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
            Text(title + ((value as? JsonObject)?.str("label")?.let { " · $it" } ?: ""), style = MaterialTheme.typography.labelMedium)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(query, { query = it }, Modifier.weight(1f), singleLine = true, label = { Text("Find a $type") })
                TextButton({ scope.launch { ownerCall { repository.request("workbench.references.search", buildJsonObject { put("sessionId", sessionId.orEmpty()); put("query", query) }) }.onSuccess { result -> candidates = ((result as? JsonObject)?.list("candidates") ?: result.objects()).filter { it.str("kind") == type } } } }, enabled = sessionId != null) { Text("Find") }
            }
            candidates.take(8).forEach { candidate -> TextButton({ set(candidate.obj("ref")); candidates = emptyList() }) { Text("${candidate.str("label")} · ${candidate.str("detail").orEmpty()}", maxLines = 1) } }
        }
    }
}

@Composable
private fun ModelsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var models by remember { mutableStateOf<JsonElement?>(null) }
    var pull by remember { mutableStateOf("") }
    fun load() = scope.launch { ownerCall { repository.request("owner.models.local", buildJsonObject {}) }.onSuccess { models = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    val rows = (models as? JsonObject)?.list("models") ?: models.objects()
    rows.forEach { model -> Text("${model.str("name") ?: model.str("model")} · ${byteSize(model.num("size"))}" + if (model.isTrue("loaded")) " · loaded" else "", style = MaterialTheme.typography.bodySmall) }
    OutlinedTextField(pull, { pull = it.trim() }, Modifier.fillMaxWidth(), label = { Text("Download a model (Ollama name)") }, singleLine = true)
    Button({ scope.launch { ownerCall { signed(activity, repository, "owner.models.pull", buildJsonObject { put("model", pull) }, "Download $pull on the desktop") }.onSuccess { feedback("Downloading $pull on the desktop"); load() }.onFailure { failure(it.message ?: "") } } }, enabled = pull.isNotBlank()) { Text("Download") }
}

@Composable
private fun HealthSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var health by remember { mutableStateOf<JsonObject?>(null) }
    var backup by remember { mutableStateOf<JsonObject?>(null) }
    var loading by remember { mutableStateOf(false) }
    var backingUp by remember { mutableStateOf(false) }
    var technical by rememberSaveable { mutableStateOf(false) }
    suspend fun refresh() {
        loading = true
        try {
            ownerCall { repository.request("owner.health", buildJsonObject {}) as JsonObject }.onSuccess { health = it }.onFailure { failure(it.message.orEmpty()) }
            ownerCall { repository.request("owner.backup.status", buildJsonObject {}) as JsonObject }.onSuccess { backup = it }.onFailure { failure(it.message.orEmpty()) }
        } finally { loading = false }
    }
    LaunchedEffect(Unit) { refresh() }
    if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
    health?.let { report ->
        Text("PAL " + report.obj("build")?.str("version").orEmpty() + " · Linux · Node " + report.str("node").orEmpty(), style = MaterialTheme.typography.titleSmall)
        report.obj("sessions")?.let { Text("Conversations · ${it.num("count") ?: 0} saved, ${it.num("active") ?: 0} active") }
        for (id in listOf("memory", "speech")) report.obj(id)?.let { part ->
            Text(id.replaceFirstChar { it.uppercase() } + " · " + if (part.isTrue("enabled")) part.str("state").orEmpty() else "Off")
        }
        report.list("providers").forEach { provider ->
            Text(provider.str("id").orEmpty() + " · " + if (provider.isTrue("available")) "Available" else "Unavailable")
            if (provider.str("problem") != null) Text(provider.str("repair").orEmpty(), style = MaterialTheme.typography.bodySmall)
        }
        val missing = report.list("dependencies").filter { !it.isTrue("available") }
        if (missing.isNotEmpty()) {
            Text("Features needing a desktop program", style = MaterialTheme.typography.titleSmall)
            missing.forEach { Text(it.str("feature").orEmpty() + " · install " + it.str("name").orEmpty(), style = MaterialTheme.typography.bodySmall) }
        }
    }
    backup?.let { status ->
        Text("Backups", style = MaterialTheme.typography.titleSmall)
        Text(if (status.isTrue("pending")) "A restore is pending on the desktop" else "Backups available on this computer")
        val last = status.num("lastBackupAt")
        Text("Last successful backup · " + (last?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) }
            ?: if ("lastBackupAt" in status) "None recorded" else "Unavailable from this desktop version"))
        status.str("activationWarning")?.takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text("This backup includes desktop preferences and folders. It excludes conversations, credentials and device access.", style = MaterialTheme.typography.bodySmall)
    }
    OutlinedButton({ backingUp = true; scope.launch { try {
        ownerCall { signed(activity, repository, "owner.backup.create", buildJsonObject {}, "Back up PAL on the desktop") }
            .onSuccess { feedback("Backup completed on the desktop"); refresh() }.onFailure { failure(it.message.orEmpty()) }
    } finally { backingUp = false } } }, enabled = backup != null && !backingUp) { Text(if (backingUp) "Backing up…" else "Back up now") }
    TextButton({ scope.launch { refresh() } }, enabled = !loading) { Text("Refresh status") }
    TextButton({ technical = !technical }) { Text(if (technical) "Hide technical details" else "Show technical details") }
    if (technical) {
        val details = buildJsonObject { health?.let { put("health", it) }; backup?.let { put("backup", it) } }.toString()
        val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
        TextButton({ clipboard.setText(androidx.compose.ui.text.AnnotatedString(details)); feedback("Technical details copied") }) { Text("Copy technical details") }
        SelectionContainer { Text(details, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
    }
}

private fun JsonObject?.orEmpty(): Map<String, JsonElement> = this ?: emptyMap()
