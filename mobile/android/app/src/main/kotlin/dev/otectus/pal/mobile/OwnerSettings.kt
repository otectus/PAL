@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.ui.res.stringResource
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
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.traits
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * Settings → This computer (PAL Everywhere §6, §8.4): what a phone with full access manages on the desktop.
 * Each section names where its change happens ("on this computer"); every change is a typed, signed action, and
 * keys travel once over the pinned connection and never come back. A phone with limited access sees what it is.
 */
private data class OwnerSection(val route: String, val title: Int)

private val ownerGroups = linkedMapOf(
    R.string.owner_section_access_and_permissions to listOf(
        OwnerSection("Access and working profile", R.string.owner_section_access_and_working_profile),
        OwnerSection("Paired devices", R.string.owner_section_paired_devices),
        OwnerSection("Power session", R.string.owner_section_power_session),
    ),
    R.string.owner_section_connections_and_spending to listOf(
        OwnerSection("Keys and connections", R.string.owner_section_keys_and_connections),
        OwnerSection("Accounts", R.string.owner_section_accounts),
        OwnerSection("Tool servers", R.string.owner_section_tool_servers),
        OwnerSection("Usage and budget", R.string.owner_section_usage_and_budget),
    ),
    R.string.owner_section_projects_and_automation to listOf(
        OwnerSection("Projects", R.string.owner_section_projects),
        OwnerSection("Working setups", R.string.owner_section_working_setups),
        OwnerSection("Specialists", R.string.owner_section_specialists),
        OwnerSection("Routines", R.string.owner_section_routines),
        OwnerSection("Skills", R.string.owner_section_skills),
        OwnerSection("Knowledge collections", R.string.owner_section_knowledge_collections),
        OwnerSection("Saved scripts", R.string.owner_section_saved_scripts),
        OwnerSection("Workspace history", R.string.owner_section_workspace_history),
    ),
    R.string.owner_section_desktop_and_maintenance to listOf(
        OwnerSection("Desktop settings", R.string.owner_section_desktop_settings),
        OwnerSection("Local models", R.string.owner_section_local_models),
        OwnerSection("Health and backups", R.string.owner_section_health_and_backups),
    ),
)

internal fun androidx.compose.foundation.lazy.LazyListScope.ownerSettings(
    repository: PALRepository, state: MobileState, activity: FragmentActivity,
    feedback: (String) -> Unit, failure: (String) -> Unit,
    initialToolServerId: String? = null, toolServerResult: String? = null, onOAuthStarted: (String) -> Unit = {},
    initialSessionId: String? = null, initialSection: String? = null, initialProvider: String? = null, loadRemote: Boolean = true,
) {
    item(key = "owner-settings-" + state.desktop?.deviceId.orEmpty()) {
        val strings = androidx.compose.ui.platform.LocalResources.current
        var destination by rememberSaveable { mutableStateOf<String?>(null) }
        var query by rememberSaveable { mutableStateOf("") }
        val sections = rememberSaveableStateHolder()
        LaunchedEffect(initialToolServerId, toolServerResult, initialSection) {
            if (initialSection != null && ownerGroups.values.any { group -> group.any { it.route == initialSection } }) destination = initialSection
            else if (toolServerResult != null) destination = "Tool servers"
        }
        val selected = if (state.owner) destination else "Access and working profile"
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            if (selected == null) {
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.find_setting)) })
                val matches = ownerGroups.mapValues { (group, names) ->
                    names.filter { strings.getString(it.title).contains(query.trim(), true) || strings.getString(group).contains(query.trim(), true) }
                }.filterValues { it.isNotEmpty() }
                if (matches.isEmpty()) Text(stringResource(R.string.settings_no_matches))
                matches.forEach { (group, names) ->
                    Text(stringResource(group), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                    Surface(shape = MaterialTheme.shapes.medium, border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant)) {
                        Column {
                            names.forEach { name ->
                                TextButton({ destination = name.route }, Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) {
                                    Text(stringResource(name.title), Modifier.weight(1f))
                                    if (name.route == "Access and working profile") Text(stringResource(R.string.computer_full_access), style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                }
            } else sections.SaveableStateProvider(selected) {
                var notice by rememberSaveable { mutableStateOf<String?>(null) }
                var problem by rememberSaveable { mutableStateOf(false) }
                val saved: (String) -> Unit = { problem = false; notice = it; feedback(it) }
                val failed: (String) -> Unit = { problem = true; notice = it.ifBlank { strings.getString(R.string.settings_failed) }; failure(notice.orEmpty()) }
                if (state.owner) {
                    BackHandler { destination = null }
                    TextButton({ destination = null }) { Text(stringResource(R.string.settings_all_computer)) }
                    val headingAnchor = remember { BringIntoViewRequester() }
                    Text(ownerGroups.values.flatten().firstOrNull { it.route == selected }?.let { stringResource(it.title) }.orEmpty(), Modifier.bringIntoViewRequester(headingAnchor).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
                    LaunchedEffect(selected) { headingAnchor.bringIntoView() }
                }
                val activeRequests = remember { mutableIntStateOf(0) }
                Box(Modifier.fillMaxWidth().height(PALLayout.tight)) {
                    if (activeRequests.intValue > 0) LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                CompositionLocalProvider(LocalOwnerRequests provides activeRequests) {
                    when (selected) {
                        "Access and working profile" -> AccessPanel(repository, state, activity, (state.connection as? ConnectionState.Online)?.access, saved, failed)
                        "Paired devices" -> DevicesSection(repository, state, activity, saved, failed)
                        "Power session" -> PowerSection(repository, state, activity, saved, failed)
                        "Keys and connections" -> KeysSection(repository, state, activity, saved, failed, initialProvider, loadRemote)
                        "Desktop settings" -> DesktopSettingsSection(repository, activity, saved, failed)
                        "Usage and budget" -> UsageSection(repository, activity, saved, failed)
                        "Skills" -> SkillsSection(repository, activity, saved, failed)
                        "Knowledge collections" -> CollectionsSection(repository, state, activity, saved, failed, initialSessionId)
                        "Saved scripts" -> { ScriptsSection(repository, activity, saved, failed); if (state.supports("owner.customTools.credential")) CustomToolCredentials(repository, activity, saved, failed) }
                        "Tool servers" -> ToolServersSection(repository, activity, saved, failed, initialToolServerId, toolServerResult, onOAuthStarted)
                        "Workspace history" -> WorkspaceHistorySection(repository, state, activity, saved, failed)
                        "Accounts" -> AccountsSection(repository, state, activity, saved, failed)
                        "Projects" -> ProjectsSection(repository, state, activity, saved, failed)
                        "Working setups" -> SetupsSection(repository, state, activity, saved, failed, initialSessionId)
                        "Specialists" -> SpecialistsSection(repository, state, activity, saved, failed)
                        "Routines" -> SchedulesSection(repository, state, activity, saved, failed)
                        "Local models" -> ModelsSection(repository, activity, saved, failed)
                        "Health and backups" -> { RunningJobs(repository, state, failed); HealthSection(repository, activity, saved, failed) }
                    }
                }
                notice?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color = if (problem) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) }
            }
        }
    }
}

/**
 * The requests a section of This computer counts to show its progress. The same actions also work where nothing counts
 * them, such as Conversation settings and New chat, so being without one is not an error.
 */
internal val LocalOwnerRequests = staticCompositionLocalOf<MutableIntState?> { null }

internal class OwnerActionScope(private val scope: CoroutineScope, private val requests: MutableIntState? = null) {
    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch {
        requests?.let { it.intValue++ }
        try { block() } finally { requests?.let { it.intValue-- } }
    }
}

@Composable
internal fun rememberOwnerScope(): OwnerActionScope {
    val scope = rememberCoroutineScope()
    val requests = LocalOwnerRequests.current
    return remember(scope, requests) { OwnerActionScope(scope, requests) }
}

internal inline fun <T> ownerCall(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Exception) {
    Result.failure(error)
}

@Composable
internal fun LabeledCheck(label: String, checked: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target).toggleable(value = checked, role = Role.Checkbox, onValueChange = change),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
        Checkbox(checked, null)
        Text(label, Modifier.weight(1f))
    }
}

@Composable
internal fun ConfirmRemoval(label: String, name: String, effect: String, enabled: Boolean = true, remove: () -> Unit) {
    var open by rememberSaveable(name) { mutableStateOf(false) }
    TextButton({ open = true }, enabled = enabled) { Text("$label…") }
    if (open) AlertDialog({ open = false }, title = { Text("$label $name?") }, text = { Text(effect) },
        confirmButton = { Button({ open = false; remove() }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(label) } },
        dismissButton = { TextButton({ open = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable
private fun TargetConversation(state: MobileState, id: String?, select: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    var expanded by remember { mutableStateOf(false) }
    val target = state.sessions.find { it.id == id }
    Box {
        OutlinedButton({ expanded = true }, enabled = state.sessions.isNotEmpty()) {
            Text(target?.let { strings.getString(R.string.computer_conversation_4) + it.title } ?: if (state.sessions.isEmpty()) stringResource(R.string.computer_no_conversations_available) else stringResource(R.string.computer_choose_a_conversation))
        }
        DropdownMenu(expanded, { expanded = false }) {
            state.sessions.forEach { session -> DropdownMenuItem(text = { Text(session.title + session.project?.let { " · $it" }.orEmpty()) },
                onClick = { select(session.id); expanded = false }) }
        }
    }
}

private val profiles = listOf("desktop" to R.string.profile_desktop, "review" to R.string.profile_review, "automatic" to R.string.profile_automatic)

@Composable
private fun AccessPanel(repository: PALRepository, state: MobileState, activity: FragmentActivity, access: JsonObject?, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var info by remember(state.connection is ConnectionState.Online, state.owner) { mutableStateOf<JsonObject?>(null) }
    var confirmLimit by remember { mutableStateOf(false) }
    LaunchedEffect(state.owner, state.connection is ConnectionState.Online) {
        if (state.supports("owner.access")) ownerCall { repository.request("owner.access", buildJsonObject {}) as JsonObject }.onSuccess { info = it }
    }
    if (state.connection !is ConnectionState.Online) {
        val offline = state.connection as? ConnectionState.Offline
        val title = when (state.connection) {
            ConnectionState.Connecting, ConnectionState.Authenticating -> strings.getString(R.string.computer_checking_desktop_access)
            is ConnectionState.Blocked -> strings.getString(R.string.computer_desktop_connection_needs_attention)
            else -> strings.getString(R.string.computer_desktop_offline)
        }
        Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
        val lastRole = when (state.permissions.str("role")) { "owner" -> strings.getString(R.string.full_access); "limited" -> strings.getString(R.string.limited_access); "observer" -> strings.getString(R.string.computer_observer); else -> null }
        lastRole?.let { role ->
            val time = offline?.lastVerifiedAt?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) }
            Text(stringResource(R.string.computer_last_known_access, role) + time?.let { " · $it" }.orEmpty())
        }
        Text(stringResource(R.string.computer_reconnect_to_verify_this_phones_current_access_and))
        return
    }
    val effective = info?.obj("access") ?: access
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(when { state.owner -> stringResource(R.string.computer_full_access); (state.connection as? ConnectionState.Online)?.role == "observer" -> stringResource(R.string.computer_observer); else -> stringResource(R.string.computer_limited_access) }, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            Text(effective?.str("summary") ?: if (state.has("owner.policy.v1")) stringResource(R.string.computer_granted_projects_and_actions) else stringResource(R.string.computer_this_desktop_does_not_support_device_roles_yet))
            (effective?.get("reasons") as? JsonArray)?.mapNotNull { it as? JsonObject }?.forEach { reason -> Text("· " + reason.str("detail").orEmpty(), style = MaterialTheme.typography.bodySmall) }
            if (state.owner) {
                Text(stringResource(R.string.computer_what_pal_does_by_itself_for_this_phones), style = MaterialTheme.typography.labelLarge)
                val current = info?.str("workingProfile") ?: effective?.str("profileId") ?: "desktop"
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    profiles.forEach { (id, labelId) ->
                        val label = stringResource(labelId)
                        FilterChip(current == id, { if (current != id) scope.launch {
                            ownerCall { signed(activity, repository, "owner.profile.set", buildJsonObject { put("profile", id); put("expectedProfileRevision", info?.str("profileRevision") ?: "0") }, strings.getString(R.string.computer_change_working_profile_to, label)) as JsonObject }
                                .onSuccess { result -> feedback(strings.getString(R.string.computer_working_profile, label)); info = info?.let { JsonObject(it + ("workingProfile" to JsonPrimitive(id)) + ("profileRevision" to (result["profileRevision"] ?: JsonPrimitive("0"))) + ("access" to (result["access"] ?: JsonNull))) } }
                                .onFailure { failure(it.message ?: strings.getString(R.string.computer_could_not_change_the_profile)) }
                        } }, { Text(label) })
                    }
                }
                Text(when (current) { "review" -> stringResource(R.string.computer_provider_commands_edits_and_desktop_actions_wait_for); "automatic" -> stringResource(R.string.computer_enabled_tools_and_provider_commands_run_without_asking); else -> stringResource(R.string.computer_the_same_automatic_approval_switches_as_the_desktop) }, style = MaterialTheme.typography.bodySmall)
                OutlinedButton({ confirmLimit = true }) { Text(stringResource(R.string.computer_switch_this_phone_to_limited_access)) }
            }
        }
    }
    if (confirmLimit) AlertDialog({ confirmLimit = false }, title = { Text(stringResource(R.string.computer_limit_this_phone)) },
        text = { Text(stringResource(R.string.computer_this_phone_keeps_chat_in_its_projects_files)) },
        confirmButton = { Button({ confirmLimit = false; scope.launch {
            ownerCall { repository.mutate("devices.setSelfRole", buildJsonObject { put("role", "limited"); put("expectedScopeVersion", info?.obj("device")?.str("scopeVersion") ?: "0") }) }
                .onSuccess { feedback(strings.getString(R.string.computer_this_phone_now_has_limited_access)) }.onFailure { failure(it.message ?: strings.getString(R.string.computer_could_not_change_access)) }
        } }) { Text(stringResource(R.string.computer_limit_access)) } }, dismissButton = { TextButton({ confirmLimit = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable
private fun DevicesSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var devices by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    fun load() = scope.launch { ownerCall { repository.request("owner.devices.list", buildJsonObject {}) }.onSuccess { devices = it.objects() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    devices.forEach { device ->
        val role = device.str("role")
        Column {
            Text(device.str("name").orEmpty() + if (device.isTrue("self")) stringResource(R.string.computer_this_phone) else "", style = MaterialTheme.typography.titleSmall)
            Text(listOfNotNull(if (device.str("surface") == "browser") strings.getString(R.string.extras_browser) else null, when (role) { "owner" -> strings.getString(R.string.full_access); "observer" -> strings.getString(R.string.computer_observer); else -> strings.getString(R.string.limited_access) }, if (device.str("lifetime") == "until-revoked") strings.getString(R.string.computer_until_revoked) else strings.getString(R.string.access_expires), if (device.str("surface") == "browser") null else if (device.str("actionAuthentication") == "trusted-device") strings.getString(R.string.computer_trusted_phone) else strings.getString(R.string.computer_fingerprint_or_pin)).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            if (!device.isTrue("self")) Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                if (role == "owner" || role == "limited") TextButton({ scope.launch {
                    ownerCall { signed(activity, repository, "owner.devices.setRole", buildJsonObject { put("deviceId", device.str("id").orEmpty()); put("role", if (role == "owner") "limited" else "observer"); put("expectedScopeVersion", device.str("scopeVersion") ?: "0") }, strings.getString(R.string.computer_reduce_s_access, device.str("name"))) }
                        .onSuccess { feedback(strings.getString(R.string.computer_reduced_s_access, device.str("name"))); load() }.onFailure { failure(it.message ?: "") }
                } }) { Text(if (role == "owner") stringResource(R.string.computer_limit) else stringResource(R.string.computer_make_observer)) }
                ConfirmRemoval(stringResource(R.string.computer_revoke_access_for), device.str("name").orEmpty(), stringResource(R.string.computer_this_disconnects_the_phone_pair_it_again_on)) { scope.launch {
                    ownerCall { signed(activity, repository, "owner.devices.revoke", buildJsonObject { put("deviceId", device.str("id").orEmpty()) }, strings.getString(R.string.computer_revoke, device.str("name"))) }
                        .onSuccess { feedback(strings.getString(R.string.computer_revoked, device.str("name"))); load() }.onFailure { failure(it.message ?: "") }
                } }
            }
        }
    }
    Text(stringResource(R.string.computer_giving_another_phone_full_access_and_pairing_new), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun PowerSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var inspect by remember { mutableStateOf<JsonObject?>(null) }
    var sessionId by rememberSaveable { mutableStateOf(state.selectedSessionId ?: state.sessions.firstOrNull()?.id.orEmpty()) }
    var minutes by rememberSaveable { mutableStateOf("30") }
    var cli by remember { mutableStateOf(true) }; var computer by remember { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.permissions.get", buildJsonObject {}) as JsonObject }.onSuccess { inspect = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    Text(stringResource(R.string.computer_a_time_limited_lease_on_one_conversation_provider), style = MaterialTheme.typography.bodySmall)
    StandingGrants(repository, inspect, feedback, failure) { load() }
    inspect?.list("power").orEmpty().filter { it.str("state") == "active" }.forEach { lease ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.computer_active_until, java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(lease.num("expiresAt") ?: 0))), Modifier.weight(1f))
            TextButton({ scope.launch { ownerCall { repository.mutate("owner.power.end", buildJsonObject { put("id", lease.str("id").orEmpty()) }) }.onSuccess { feedback(strings.getString(R.string.computer_power_session_ended)); load() }.onFailure { failure(it.message ?: "") } } }) { Text(stringResource(R.string.computer_end)) }
        }
    }
    var open by remember { mutableStateOf(false) }
    Box { OutlinedButton({ open = true }) { Text(state.sessions.firstOrNull { it.id == sessionId }?.title ?: stringResource(R.string.computer_choose_a_conversation)) }
        DropdownMenu(open, { open = false }) { state.sessions.forEach { s -> DropdownMenuItem(text = { Text(s.title) }, onClick = { sessionId = s.id; open = false }) } } }
    val reason = inspect?.list("effective")?.firstOrNull { it.str("sessionId") == sessionId }?.str("powerUnavailableReason")
    reason?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    Column(verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
        OutlinedTextField(minutes, { minutes = it.filter(Char::isDigit).take(3) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.computer_duration_in_minutes_1480)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true)
        LabeledCheck(stringResource(R.string.computer_provider_commands_run_without_asking), cli) { cli = it }
        LabeledCheck(stringResource(R.string.computer_desktop_actions_control_permitted_apps_and_devices_without), computer) { computer = it }
    }
    val duration = minutes.toIntOrNull()
    val targetTitle = state.sessions.find { it.id == sessionId }?.title
    if (targetTitle != null && duration != null && duration in 1..480 && (cli || computer)) {
        val allowed = listOfNotNull(strings.getString(R.string.computer_provider_commands).takeIf { cli }, strings.getString(R.string.computer_desktop_actions).takeIf { computer }).joinToString(" and ")
        Text(stringResource(R.string.computer_allow_in_for_minutes_you_can_end_the, allowed, targetTitle, duration), style = MaterialTheme.typography.bodyMedium)
    }
    Button({ scope.launch {
        ownerCall { signed(activity, repository, "owner.power.start", buildJsonObject { put("sessionIds", buildJsonArray { add(sessionId) }); put("minutes", (minutes.toIntOrNull() ?: 30).coerceIn(1, 480)); put("cli", cli); put("computer", computer) }, strings.getString(R.string.computer_start_a_power_session)) }
            .onSuccess { feedback(strings.getString(R.string.computer_power_session_started)); load() }.onFailure { failure(it.message ?: "") }
    } }, enabled = sessionId.isNotEmpty() && minutes.toIntOrNull() in 1..480 && (cli || computer) && reason.isNullOrBlank()) { Text(stringResource(R.string.computer_start_power_session)) }
}

@Composable
private fun KeysSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit, initialProvider: String? = null, loadRemote: Boolean = true) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var settings by remember { mutableStateOf<JsonObject?>(null) }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var provider by rememberSaveable { mutableStateOf(initialProvider ?: "openai") }
    var key by remember { mutableStateOf("") }
    var editing by remember { mutableStateOf<JsonObject?>(null) }
    var accountProvider by rememberSaveable { mutableStateOf(initialProvider ?: "openai") }
    var accountName by rememberSaveable { mutableStateOf("") }
    var endpoint by rememberSaveable { mutableStateOf("") }
    var compatibleNeedsKey by rememberSaveable { mutableStateOf(false) }
    var authHeader by rememberSaveable { mutableStateOf("") }
    var variant by rememberSaveable(accountProvider) { mutableStateOf("") }
    var auth by rememberSaveable(accountProvider, variant) { mutableStateOf("") }
    var deployment by rememberSaveable { mutableStateOf("") }
    var apiVersion by rememberSaveable { mutableStateOf("") }
    var region by rememberSaveable { mutableStateOf("") }
    var underlyingModel by rememberSaveable { mutableStateOf("") }
    var accountKey by remember { mutableStateOf("") }
    var managementKey by remember { mutableStateOf("") }
    var organization by rememberSaveable { mutableStateOf("") }
    var project by rememberSaveable { mutableStateOf("") }
    var declaredTools by rememberSaveable { mutableStateOf(false) }
    var declaredImages by rememberSaveable { mutableStateOf(false) }
    var declaredStreaming by rememberSaveable { mutableStateOf(true) }
    var declaredUsage by rememberSaveable { mutableStateOf(false) }
    var declaredContext by rememberSaveable { mutableStateOf("") }
    var declaredOutput by rememberSaveable { mutableStateOf("") }
    var removing by remember { mutableStateOf<JsonObject?>(null) }
    var checking by remember { mutableStateOf<JsonObject?>(null) }
    var bridgeStatus by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    fun load() = scope.launch {
        ownerCall { repository.request("owner.settings.get", buildJsonObject {}) as JsonObject }.onSuccess { settings = it }.onFailure { failure(it.message ?: "") }
        ownerCall { repository.request("owner.connections.list", buildJsonObject {}) }.onSuccess { value ->
            connections = when (value) { is JsonArray -> value.mapNotNull { it as? JsonObject }; is JsonObject -> value.list("connections"); else -> emptyList() }
        }
    }
    LaunchedEffect(Unit) { if (loadRemote) load() }
    val labels = linkedMapOf<String, String>().apply {
        state.providers.keys.forEach { id -> if (state.traits(id).kind == "api") put(id, state.traits(id).label) }
        put("ollama_cloud", "Ollama Cloud"); put("xai_management", "xAI Management"); put("voyage", "Voyage AI"); put("jev", "Jev"); put("azure_speech", "Azure Speech"); put("google_search", "Google Search"); put("elevenlabs", strings.getString(R.string.computer_elevenlabs_voice))
    }
    val accountLabels = linkedMapOf<String, String>().apply {
        state.providers.keys.forEach { id -> if (state.traits(id).kind == "api") put(id, state.traits(id).label) }
        if ("ollama" in state.providers) put("ollama", state.traits("ollama").label)
    }
    LaunchedEffect(labels.keys) { if (provider !in labels) provider = labels.keys.firstOrNull().orEmpty() }
    LaunchedEffect(accountLabels.keys) { if (accountProvider !in accountLabels) accountProvider = accountLabels.keys.firstOrNull().orEmpty() }
    settings?.obj("credentials")?.let { credentials ->
        labels.forEach { (id, label) -> credentials.obj(id)?.let { status -> Text("$label · " + when (status.str("source")) { "saved" -> stringResource(R.string.computer_key_saved); "environment" -> stringResource(R.string.computer_from_the_environment); else -> stringResource(R.string.computer_no_key) }, style = MaterialTheme.typography.bodySmall) } }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { labels.forEach { (id, label) -> FilterChip(provider == id, { provider = id }, { Text(label) }) } }
    OutlinedTextField(key, { key = it.trim() }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.computer_new_key_for, labels[provider] ?: provider)) }, visualTransformation = PasswordVisualTransformation(), singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
    Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        Button({ val secret = key; key = ""; scope.launch {
            // The key crosses the pinned connection once; only whether one is configured comes back.
            ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", provider); put("key", secret) }, strings.getString(R.string.computer_save_the_key_on_the_desktop, labels[provider])) }
                .onSuccess { feedback(strings.getString(R.string.computer_key_saved_on_the_desktop, labels[provider])); load() }.onFailure { failure(it.message ?: "") }
        } }, enabled = key.isNotEmpty()) { Text(stringResource(R.string.computer_save_key)) }
        OutlinedButton({ scope.launch {
            ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", provider); put("key", JsonNull) }, strings.getString(R.string.computer_remove_the_key, labels[provider])) }
                .onSuccess { feedback(strings.getString(R.string.computer_key_removed, labels[provider])); load() }.onFailure { failure(it.message ?: "") }
        } }) { Text(stringResource(R.string.computer_remove_key)) }
    }
    Text(stringResource(R.string.computer_saved_connections), style = MaterialTheme.typography.labelLarge)
    connections.forEach { row ->
        val address = row.obj("endpoint")?.str("baseUrl") ?: row.str("host").orEmpty()
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(listOf(row.str("name"), accountLabels[row.str("kind")] ?: row.str("kind"), row.str("variant"), address, if (row.isTrue("keySet")) "credential set" else null).filterNot { it.isNullOrBlank() }.joinToString(" · "), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                TextButton({
                    editing = row; accountProvider = row.str("kind").orEmpty(); accountName = row.str("name").orEmpty(); endpoint = address
                    variant = row.str("variant").orEmpty(); auth = row.str("auth").orEmpty(); deployment = row.str("deployment").orEmpty()
                    apiVersion = row.str("apiVersion").orEmpty(); region = row.str("region").orEmpty(); underlyingModel = row.str("underlyingModel").orEmpty()
                    compatibleNeedsKey = row.obj("endpoint")?.isTrue("requiresKey") == true; authHeader = row.obj("endpoint")?.str("authHeader").orEmpty()
                    accountKey = ""; managementKey = ""; organization = row.str("organization").orEmpty(); project = row.str("project").orEmpty()
                    row.obj("endpoint").let { declared -> declaredTools = declared?.isTrue("tools") == true; declaredImages = declared?.isTrue("images") == true; declaredStreaming = declared?.get("streaming")?.let { (it as? JsonPrimitive)?.booleanOrNull } != false; declaredUsage = declared?.isTrue("usage") == true
                        declaredContext = declared?.int("contextLength")?.takeIf { it > 0 }?.toString().orEmpty(); declaredOutput = declared?.int("maxOutputTokens")?.takeIf { it > 0 }?.toString().orEmpty() }
                }) { Text("Edit") }
                TextButton({ removing = row }) { Text(stringResource(R.string.care_remove)) }
            }
            row.str("id")?.let { ConnectionModels(repository, it, failure) }
            if (state.supports("owner.connections.check")) TextButton({ checking = row }) { Text(stringResource(R.string.care_check)) }
            if (row.str("kind") == "litellm" && row.str("variant") == "bridge") Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalAlignment = Alignment.CenterVertically) {
                if (state.supports("owner.providerBridge.chat")) { var testing by rememberSaveable(row.str("id")) { mutableStateOf(false) }; TextButton({ testing = true }) { Text(stringResource(R.string.extras_bridge_test)) }; if (testing) BridgeTest(repository, state, activity, row) { testing = false } }
                TextButton({ scope.launch { ownerCall { repository.request("owner.providerBridge.status", buildJsonObject { put("connectionId", row.str("id")) }) as JsonObject }.onSuccess { result -> bridgeStatus = bridgeStatus + (row.str("id").orEmpty() to if (result.isTrue("running")) "Running · ${result.str("version") ?: "LiteLLM"}" else result.str("error").orEmpty().ifBlank { "Unavailable" }) }.onFailure { failure(it.message.orEmpty()) } } }) { Text("Start / test bridge") }
                TextButton({ scope.launch { ownerCall { repository.mutate("owner.providerBridge.stop", buildJsonObject { put("connectionId", row.str("id")) }) }.onSuccess { bridgeStatus = bridgeStatus + (row.str("id").orEmpty() to "Stopped") }.onFailure { failure(it.message.orEmpty()) } } }) { Text("Stop") }
                bridgeStatus[row.str("id")].takeIf { !it.isNullOrBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
    checking?.let { row -> ConnectionCheckDialog(repository, activity, row.str("id"), row.str("kind").orEmpty(), row.str("name").orEmpty()) { checking = null } }
    removing?.let { row -> if (state.supports("owner.connections.uses")) ConnectionRemoveDialog(repository, activity, row.str("id").orEmpty(), row.str("name").orEmpty(), { load() }) { removing = null }
        else ToolDialog(stringResource(R.string.care_remove_title, row.str("name").orEmpty()), { removing = null }, confirm = { Button({ removing = null; scope.launch { ownerCall { signed(activity, repository, "owner.connections.remove", buildJsonObject { put("id", row.str("id")) }, strings.getString(R.string.care_remove_action, row.str("name").orEmpty())) }.onSuccess { load() }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.care_remove)) } }) {} }
    Text(if (editing == null) "Add a named provider account" else "Edit named provider account", style = MaterialTheme.typography.labelLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { accountLabels.forEach { (id, label) ->
        FilterChip(accountProvider == id, { if (editing == null) { accountProvider = id; variant = ""; auth = "" } }, { Text(label) }, enabled = editing == null)
    } }
    OutlinedTextField(accountName, { accountName = it.take(60) }, Modifier.fillMaxWidth(), label = { Text("Account name") }, singleLine = true)
    state.traits(accountProvider).variants.takeIf { it.isNotEmpty() }?.let { variants ->
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { variants.forEach { option ->
            FilterChip(variant == option.id, { variant = option.id }, { Text(option.label) })
        } }
    }
    val authMethods = state.traits(accountProvider).variants.firstOrNull { it.id == variant }?.auth?.takeIf { it.isNotEmpty() } ?: state.traits(accountProvider).auth
    authMethods.takeIf { it.isNotEmpty() && (accountProvider == "azure_openai" || accountProvider == "google" && variant == "vertex") }?.let { methods ->
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { methods.forEach { method ->
            FilterChip(auth == method, { auth = method }, { Text(method.replace('-', ' ').replaceFirstChar(Char::uppercase)) })
        } }
    }
    OutlinedTextField(endpoint, { endpoint = it.take(2048) }, Modifier.fillMaxWidth(), label = { Text(if (accountProvider == "ollama") "Ollama host" else "Custom endpoint (optional)") }, singleLine = true)
    if (accountProvider == "compatible") {
        Row(Modifier.fillMaxWidth().toggleable(compatibleNeedsKey, onValueChange = { compatibleNeedsKey = it }, role = Role.Checkbox), verticalAlignment = Alignment.CenterVertically) { Checkbox(compatibleNeedsKey, null); Text("This endpoint needs an API key") }
        if (compatibleNeedsKey) {
            OutlinedTextField(authHeader, { authHeader = it.take(128) }, Modifier.fillMaxWidth(), label = { Text("Custom key header (blank uses Authorization: Bearer)") }, singleLine = true)
            if (editing != null && authHeader.trim() != editing?.obj("endpoint")?.str("authHeader").orEmpty()) Text("Changing the header invalidates the saved credential. Re-enter the key below.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        }
    }
    if (accountProvider == "compatible") {
        Text(stringResource(R.string.care_declared), style = MaterialTheme.typography.labelLarge)
        ToolCheck(stringResource(R.string.care_tools), declaredTools) { declaredTools = it }
        ToolCheck(stringResource(R.string.care_images), declaredImages) { declaredImages = it }
        ToolCheck(stringResource(R.string.care_streaming), declaredStreaming) { declaredStreaming = it }
        ToolCheck(stringResource(R.string.care_usage), declaredUsage) { declaredUsage = it }
        OutlinedTextField(declaredContext, { declaredContext = it.filter(Char::isDigit).take(8) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.care_context)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(declaredOutput, { declaredOutput = it.filter(Char::isDigit).take(7) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.care_output)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
    }
    if (accountProvider == "openai") {
        OutlinedTextField(organization, { organization = it.trim().take(72) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.care_organization)) }, singleLine = true)
        OutlinedTextField(project, { project = it.trim().take(72) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.care_project)) }, singleLine = true)
    }
    if (accountProvider == "azure_openai") {
        OutlinedTextField(deployment, { deployment = it.take(128) }, Modifier.fillMaxWidth(), label = { Text("Azure deployment name (required)") }, singleLine = true)
        ModelField(underlyingModel, { underlyingModel = it }, stringResource(R.string.care_underlying_model), modelSource(repository, state, "openai"), maximum = 128)
        OutlinedTextField(region, { region = it.take(128) }, Modifier.fillMaxWidth(), label = { Text("Azure region (optional)") }, singleLine = true)
        OutlinedTextField(apiVersion, { apiVersion = it.take(128) }, Modifier.fillMaxWidth(), label = { Text("Azure API version (optional)") }, singleLine = true)
    }
    if (accountProvider != "ollama") OutlinedTextField(accountKey, { accountKey = it.trim() }, Modifier.fillMaxWidth(), label = { Text(if (editing?.isTrue("keySet") == true) "Replacement credential (leave empty to keep)" else "Credential for this account") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
    if (accountProvider == "xai") OutlinedTextField(managementKey, { managementKey = it.trim() }, Modifier.fillMaxWidth(), label = { Text("Separate xAI Management API key") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
    Button({ scope.launch {
        val params = buildJsonObject {
            editing?.let { put("id", it.str("id")); put("expectedRevision", it.num("revision") ?: 0) } ?: put("kind", accountProvider)
            put("name", accountName.trim()); if (variant.isNotBlank()) put("variant", variant)
            if (auth.isNotBlank() && (accountProvider == "azure_openai" || accountProvider == "google" && variant == "vertex")) put("auth", auth)
            if (accountProvider == "ollama") put("host", endpoint.trim()) else put("endpoint", buildJsonObject { if (endpoint.isNotBlank()) put("baseUrl", endpoint.trim()); if (accountProvider == "compatible") { put("requiresKey", compatibleNeedsKey); put("authHeader", if (compatibleNeedsKey) authHeader.trim() else ""); put("tools", declaredTools); put("images", declaredImages); put("streaming", declaredStreaming); put("usage", declaredUsage); put("contextLength", declaredContext.toIntOrNull() ?: 0); put("maxOutputTokens", declaredOutput.toIntOrNull() ?: 0) } })
            if (accountProvider == "openai") { put("organization", organization); put("project", project) }
            if (accountProvider == "azure_openai") { put("deployment", deployment.trim()); if (apiVersion.isNotBlank()) put("apiVersion", apiVersion.trim()); if (region.isNotBlank()) put("region", region.trim()); if (underlyingModel.isNotBlank()) put("underlyingModel", underlyingModel.trim()) }
        }
        ownerCall { signed(activity, repository, "owner.connections.save", params, (if (editing == null) "Add " else "Edit ") + accountName.trim()) as JsonObject }.onSuccess { saved ->
            val id = saved.str("id").orEmpty()
            if (accountKey.isNotBlank()) ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", accountProvider); put("connectionId", id); put("key", accountKey) }, "Replace the credential for ${accountName.trim()}") }.onFailure { failure(it.message.orEmpty()) }
            if (accountProvider == "xai" && managementKey.isNotBlank()) ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", "xai_management"); put("connectionId", id); put("key", managementKey) }, "Save the separate xAI Management key for ${accountName.trim()}") }.onFailure { failure(it.message.orEmpty()) }
            editing = null; accountName = ""; endpoint = ""; compatibleNeedsKey = false; authHeader = ""; organization = ""; project = ""; declaredTools = false; declaredImages = false; declaredStreaming = true; declaredUsage = false; declaredContext = ""; declaredOutput = ""; deployment = ""; apiVersion = ""; region = ""; underlyingModel = ""; accountKey = ""; managementKey = ""; load(); feedback("Provider account saved on the desktop")
        }.onFailure { failure(it.message.orEmpty()) }
    } }, enabled = accountName.isNotBlank() && accountProvider.isNotBlank() && (accountProvider != "ollama" || endpoint.isNotBlank()) && (accountProvider != "azure_openai" || deployment.isNotBlank())) { Text(if (editing == null) "Add account" else "Save account") }
    editing?.let { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            if (accountProvider != "ollama") OutlinedButton({ scope.launch { ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", accountProvider); put("connectionId", row.str("id")); put("key", JsonNull) }, "Clear the credential for ${row.str("name")}") }.onSuccess { feedback("Named credential cleared"); load() }.onFailure { failure(it.message.orEmpty()) } } }) { Text("Clear credential") }
            if (accountProvider == "xai") OutlinedButton({ scope.launch { ownerCall { signed(activity, repository, "owner.credentials.set", buildJsonObject { put("provider", "xai_management"); put("connectionId", row.str("id")); put("key", JsonNull) }, "Clear the xAI Management key for ${row.str("name")}") }.onSuccess { feedback("xAI Management credential cleared") }.onFailure { failure(it.message.orEmpty()) } } }) { Text("Clear Management key") }
            TextButton({ editing = null; accountName = ""; endpoint = ""; compatibleNeedsKey = false; authHeader = ""; accountKey = ""; managementKey = "" }) { Text("Cancel") }
        }
    }
}

@Composable
private fun DesktopSettingsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var settings by remember { mutableStateOf<JsonObject?>(null) }
    fun load() = scope.launch { ownerCall { repository.request("owner.settings.get", buildJsonObject {}) as JsonObject }.onSuccess { settings = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    val values = settings?.obj("settings") ?: return Text(stringResource(R.string.transcript_loading_full_message))
    fun patch(family: String, title: String, change: JsonObjectBuilder.() -> Unit) = scope.launch {
        ownerCall { signed(activity, repository, "owner.settings.patch", buildJsonObject { put("expectedRevision", settings?.str("revision") ?: "0"); put("family", family); put("values", buildJsonObject(change)) }, title) as JsonObject }
            .onSuccess { result -> feedback(strings.getString(R.string.computer_saved_on_the_desktop, title)); settings = JsonObject(settings.orEmpty() + ("settings" to (result["settings"] ?: JsonNull)) + ("revision" to (result["revision"] ?: JsonNull))) }
            .onFailure { failure((it.message ?: "") + strings.getString(R.string.computer_reload_and_try_again_if_the_desktop_changed)) }
    }
    @Composable fun toggle(label: String, checked: Boolean, family: String, reviewEnable: Boolean = false, change: JsonObjectBuilder.(Boolean) -> Unit) {
        var confirm by rememberSaveable(label) { mutableStateOf(false) }
        Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target).toggleable(checked, role = Role.Switch) { value ->
            if (reviewEnable && value) confirm = true else patch(family, label) { change(value) }
        }, verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(checked, null) }
        if (confirm) AlertDialog({ confirm = false }, title = { Text(stringResource(R.string.computer_allow) + label.lowercase() + "?") },
            text = { Text(stringResource(R.string.computer_this_changes_the_desktop_default_for_all_conversations)) },
            confirmButton = { Button({ confirm = false; patch(family, label) { change(true) } }) { Text(stringResource(R.string.computer_allow_without_asking)) } },
            dismissButton = { TextButton({ confirm = false }) { Text(stringResource(R.string.computer_keep_review_on)) } })
    }
    var name by remember(values) { mutableStateOf(values.str("assistantName").orEmpty()) }
    OutlinedTextField(name, { name = it.take(40) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.computer_assistant_name)) }, singleLine = true)
    TextButton({ patch("companion", strings.getString(R.string.computer_assistant_name)) { put("assistantName", name) } }, enabled = name.isNotBlank() && name != values.str("assistantName")) { Text(stringResource(R.string.computer_save_name)) }
    toggle(strings.getString(R.string.computer_speak_replies_on_the_desktop), values.isTrue("speechEnabled"), "voice") { put("speechEnabled", it) }
    DesktopVoice(repository, values, { title, change -> patch("voice", title, change) }, failure)
    values.obj("speechCache")?.let { kept -> toggle(strings.getString(R.string.extras_keep_spoken_audio), kept.isTrue("enabled"), "voice") { put("speechCache", buildJsonObject { put("enabled", it) }) } }
    toggle(strings.getString(R.string.computer_quiet_desktop_companion), values.isTrue("quiet"), "appearance") { put("quiet", it) }
    toggle(strings.getString(R.string.computer_reduced_motion), values.isTrue("reducedMotion"), "appearance") { put("reducedMotion", it) }
    val web = values.obj("webSearch"); toggle(strings.getString(R.string.computer_web_search), web?.isTrue("enabled") == true, "search") { put("webSearch", JsonObject(web.orEmpty() + ("enabled" to JsonPrimitive(it)))) }
    val memory = values.obj("memory"); toggle(strings.getString(R.string.mobile_project_memory), memory?.isTrue("enabled") == true, "memory") { put("memory", JsonObject(memory.orEmpty() + ("enabled" to JsonPrimitive(it)))) }
    values.obj("time")?.let { time -> OwnerTimeSettings(time, { label, checked, change -> toggle(label, checked, "time") { on -> put("time", buildJsonObject { change(on) }) } }) { title, change ->
        patch("time", title) { put("time", buildJsonObject(change)) }
    } }
    Text(stringResource(R.string.computer_automatic_approval_all_conversations), style = MaterialTheme.typography.labelLarge)
    toggle(strings.getString(R.string.computer_provider_commands_without_asking), values.isTrue("bypassCliPermissions"), "permissions", reviewEnable = true) { put("bypassCliPermissions", it) }
    toggle(strings.getString(R.string.computer_desktop_actions_without_asking), values.isTrue("bypassComputerPermissions"), "permissions", reviewEnable = true) { put("bypassComputerPermissions", it) }
    toggle(strings.getString(R.string.computer_pause_pals_desktop_actions), values.isTrue("paused"), "permissions") { put("paused", it) }
}

/** Time awareness (feature time.context.v1): the same choices as Settings › Application on the desktop. */
@Composable
private fun OwnerTimeSettings(time: JsonObject, toggle: @Composable (String, Boolean, JsonObjectBuilder.(Boolean) -> Unit) -> Unit, patch: (String, JsonObjectBuilder.() -> Unit) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current
    var choosing by rememberSaveable { mutableStateOf(false) }
    val on = (time["enabled"] as? JsonPrimitive)?.booleanOrNull != false
    val fixed = time.str("zoneMode") == "fixed"
    val zone = time.str("fixedZone")
    Text(stringResource(R.string.clock_settings_heading), Modifier.semantics { heading() }, style = MaterialTheme.typography.labelLarge)
    toggle(strings.getString(R.string.clock_settings_enabled), on) { put("enabled", it) }
    Text(stringResource(R.string.clock_settings_enabled_detail), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    toggle(strings.getString(R.string.clock_settings_elapsed), (time["conversationTiming"] as? JsonPrimitive)?.booleanOrNull != false) { put("conversationTiming", it) }
    Text(stringResource(R.string.clock_settings_zone), style = MaterialTheme.typography.bodyMedium)
    val zoneTitle = strings.getString(R.string.clock_settings_zone)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        FilterChip(!fixed, { if (fixed) patch(zoneTitle) { put("zoneMode", "automatic") } }, { Text(stringResource(R.string.clock_settings_automatic)) })
        FilterChip(fixed, { if (!fixed) { if (zone != null) patch(zoneTitle) { put("zoneMode", "fixed") } else choosing = true } }, { Text(stringResource(R.string.clock_settings_fixed)) })
    }
    if (fixed) TextButton({ choosing = true }, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.clock_settings_fixed_value, zone.orEmpty())) }
    Text(stringResource(R.string.clock_settings_display), style = MaterialTheme.typography.bodyMedium)
    val displayTitle = strings.getString(R.string.clock_settings_display)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        listOf("system" to R.string.clock_settings_display_system, "12h" to R.string.clock_settings_display_12, "24h" to R.string.clock_settings_display_24).forEach { (id, label) ->
            FilterChip((time.str("clockFormat") ?: "system") == id, { patch(displayTitle) { put("clockFormat", id) } }, { Text(stringResource(label)) })
        }
    }
    if (choosing) ZonePickerDialog(zone, { choosing = false }) { chosen -> choosing = false; patch(zoneTitle) { put("zoneMode", "fixed"); put("fixedZone", chosen) } }
}

/** The same ledger the desktop shows: exact counts only where providers reported them; costs only from entered prices. */
@Composable
private fun UsageSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var days by rememberSaveable { mutableStateOf(30) }
    var summary by remember { mutableStateOf<JsonObject?>(null) }
    var limit by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var remove by rememberSaveable { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.usage.summary", buildJsonObject { put("days", days) }) as JsonObject }.onSuccess { value -> summary = value; limit = value.obj("policy")?.get("monthlyLimit")?.let { (it as? JsonPrimitive)?.contentOrNull }.orEmpty().takeIf { it != "null" }.orEmpty() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(days) { load() }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf(7, 30, 90).forEach { d -> FilterChip(days == d, { days = d }, { Text(stringResource(R.string.computer_days, d)) }) } }
    val value = summary ?: return Text(stringResource(R.string.transcript_loading_full_message))
    val totals = value.obj("totals"); val currency = value.str("currency").orEmpty()
    Text(stringResource(R.string.computer_requests_in_out_tokens_reported, totals?.num("calls") ?: 0, totals?.num("inputTokens") ?: 0, totals?.num("outputTokens") ?: 0) + ((totals?.num("images") ?: 0).takeIf { it > 0 }?.let { " · " + strings.getQuantityString(R.plurals.usage_image_count, it.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), it) } ?: ""))
    Text(strings.getString(R.string.computer_priced_cost_2f_s, (totals?.get("cost") as? JsonPrimitive)?.doubleOrNull ?: 0.0, currency) + ((totals?.num("unpriced") ?: 0).takeIf { it > 0 }?.let { " · " + strings.getString(R.string.unpriced_usage, it) } ?: ""), style = MaterialTheme.typography.bodySmall)
    Text(stringResource(R.string.computer_reported_estimated_unknown_subscription, totals?.num("reported") ?: 0, totals?.num("estimated") ?: 0, totals?.num("unknown") ?: 0, totals?.num("subscription") ?: 0), style = MaterialTheme.typography.bodySmall)
    value.strings("warnings").forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    value.list("byProvider").take(8).forEach { row -> Text("${row.str("key")} · ${row.num("calls")} · " + if ((row.num("priced") ?: 0) > 0) "%.2f %s".format((row["cost"] as? JsonPrimitive)?.doubleOrNull ?: 0.0, currency) else stringResource(R.string.computer_unpriced), style = MaterialTheme.typography.bodySmall) }
    val savedLimit = value.obj("policy")?.str("monthlyLimit")
    val decimal = limit.trim().takeIf { it.matches(Regex("""(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)""")) }?.toBigDecimalOrNull()
    val valid = decimal != null && decimal <= java.math.BigDecimal("10000000") && decimal.compareTo(java.math.BigDecimal.valueOf(decimal.toDouble())) == 0
    Text(savedLimit?.let { strings.getString(R.string.computer_current_monthly_limit, it, currency) } ?: stringResource(R.string.computer_no_monthly_limit_set))
    OutlinedTextField(limit, { limit = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.computer_monthly_limit, currency)) },
        singleLine = true, isError = limit.isNotBlank() && !valid, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        supportingText = { if (limit.isNotBlank() && !valid) Text(stringResource(R.string.computer_enter_a_number_between_0_and_10_000)) })
    fun save(amount: Double?) {
        if (saving) return
        saving = true
        scope.launch {
            try {
                ownerCall { signed(activity, repository, "owner.usage.setPolicy", buildJsonObject {
                    put("expectedRevision", value.obj("policy")?.str("revision") ?: "0")
                    put("monthlyLimit", amount?.let { JsonPrimitive(it) } ?: JsonNull)
                }, if (amount == null) strings.getString(R.string.computer_remove_the_monthly_limit_2) else strings.getString(R.string.computer_set_the_monthly_limit_to, limit, currency)) }
                    .onSuccess { feedback(if (amount == null) strings.getString(R.string.computer_monthly_limit_removed) else strings.getString(R.string.computer_monthly_limit_saved)); load() }
                    .onFailure { failure(it.message.orEmpty()) }
            } finally { saving = false }
        }
    }
    Button({ decimal?.let { save(it.toDouble()) } }, enabled = valid && !saving) { Text(if (saving) stringResource(R.string.computer_saving) else stringResource(R.string.computer_save_limit)) }
    if (savedLimit != null) TextButton({ remove = true }, enabled = !saving) { Text(stringResource(R.string.computer_remove_limit)) }
    if (remove) AlertDialog({ remove = false }, title = { Text(stringResource(R.string.computer_remove_the_monthly_limit)) },
        text = { Text(stringResource(R.string.computer_pal_will_stop_enforcing_your_monthly_limit_on, savedLimit.orEmpty(), currency)) },
        confirmButton = { Button({ remove = false; save(null) }) { Text(stringResource(R.string.computer_remove_limit_2)) } },
        dismissButton = { TextButton({ remove = false }) { Text(stringResource(R.string.computer_keep_limit)) } })
    Text(stringResource(R.string.computer_pal_stops_paid_api_requests_at_this_limit), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Skills: import (repository or desktop path), review once, enable; importing runs nothing. */
@Composable
private fun SkillsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var listing by remember { mutableStateOf<JsonObject?>(null) }
    var source by remember { mutableStateOf("") }
    var review by remember { mutableStateOf<JsonObject?>(null) }
    var automatic by remember { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.skills.list", buildJsonObject {}) as JsonObject }.onSuccess { listing = it }.onFailure { failure(it.message ?: "") } }
    fun open(id: String) = scope.launch { ownerCall { repository.request("owner.skills.review", buildJsonObject { put("versionId", id) }) as JsonObject }.onSuccess { review = it; automatic = it.obj("version")?.str("invocation") == "automatic" }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    Text(stringResource(R.string.computer_reusable_instructions_a_model_loads_when_a_task), style = MaterialTheme.typography.bodySmall)
    listing?.list("versions").orEmpty().filter { it.str("status") != "superseded" }.forEach { version ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(version.str("name").orEmpty())
                Text(when (version.str("status")) { "review" -> stringResource(R.string.computer_waiting_for_your_review); "enabled" -> if (version.str("invocation") == "automatic") stringResource(R.string.computer_on_offered_automatically) else stringResource(R.string.computer_on_when_you_name_it); else -> stringResource(R.string.computer_off) }, style = MaterialTheme.typography.bodySmall)
            }
            TextButton({ open(version.str("id").orEmpty()) }) { Text(if (version.str("status") == "review") stringResource(R.string.transcript_review_attachment) else stringResource(R.string.computer_details)) }
        }
    }
    OutlinedTextField(source, { source = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_https_repository_or_a_folder_or_zip_on)) })
    Button({ scope.launch {
        val location = source.trim()
        val repositoryImport = location.startsWith("https://")
        ownerCall { signed(activity, repository, if (repositoryImport) "owner.skills.importRepository" else "owner.skills.importPath", buildJsonObject { if (repositoryImport) put("url", location) else put("path", location) }, strings.getString(R.string.computer_import_a_skill)) as JsonObject }
            .onSuccess { version -> source = ""; load(); version.str("id")?.let { open(it) } }.onFailure { failure(it.message ?: "") }
    } }, enabled = source.trim().startsWith("https://") || source.trim().startsWith("/")) { Text(stringResource(R.string.computer_import)) }
    review?.let { value ->
        val version = value.obj("version")
        AlertDialog({ review = null }, title = { Text(version?.str("name").orEmpty()) }, text = {
            Column(Modifier.heightIn(max = PALLayout.previewHeight).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                Text("${version?.obj("source")?.str("kind")} · ${version?.obj("source")?.str("uri").orEmpty()} ${version?.obj("source")?.str("revision")?.take(12).orEmpty()}", style = MaterialTheme.typography.bodySmall)
                Text(stringResource(R.string.computer_scope) + (version?.str("project") ?: stringResource(R.string.computer_all_projects)))
                Text(stringResource(R.string.computer_files_in_this_version), style = MaterialTheme.typography.titleSmall)
                version?.list("files").orEmpty().forEach { file ->
                    Text(file.str("path").orEmpty() + " · " + byteSize(file.num("bytes")) + if (file.isTrue("executable")) stringResource(R.string.computer_executable) else "",
                        style = MaterialTheme.typography.bodySmall)
                }
                if ((value["executables"] as? JsonArray)?.isNotEmpty() == true) Text(stringResource(R.string.computer_executable_files_can_run_through_command_tools_under), color = MaterialTheme.colorScheme.error)
                value.obj("changes")?.let { changes ->
                    if (changes.isTrue("instructionsChanged")) Text(stringResource(R.string.computer_standing_instructions_changed))
                    for (kind in listOf("added", "removed", "changed")) {
                        val paths = changes[kind] as? JsonArray ?: continue
                        if (paths.isNotEmpty()) Text(kind.replaceFirstChar { it.uppercase() } + " · " + paths.texts().joinToString())
                    }
                }
                Text(stringResource(R.string.computer_complete_instructions), style = MaterialTheme.typography.titleSmall)
                SelectionContainer { Column { value.str("instructions").orEmpty().chunked(2400).forEach { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } } }
                if (version?.str("status") != "enabled") LabeledCheck(stringResource(R.string.computer_offer_automatically_when_a_task_fits), automatic) { automatic = it }
            }
        }, confirmButton = {
            if (version?.str("status") != "enabled") Button({ scope.launch {
                ownerCall { signed(activity, repository, "owner.skills.enable", buildJsonObject { put("versionId", version?.str("id").orEmpty()); put("invocation", if (automatic) "automatic" else "explicit"); put("expectedRevision", value.str("revision") ?: "0") }, strings.getString(R.string.computer_enable, version?.str("name"))) }
                    .onSuccess { feedback(strings.getString(R.string.computer_is_on, version?.str("name"))); review = null; load() }.onFailure { failure(it.message ?: "") }
            } }) { Text(stringResource(R.string.computer_enable_this_version)) }
            else TextButton({ scope.launch { ownerCall { repository.mutate("owner.skills.disable", buildJsonObject { put("versionId", version.str("id").orEmpty()) }) }.onSuccess { review = null; load() }.onFailure { failure(it.message ?: "") } } }) { Text(stringResource(R.string.computer_turn_off)) }
        }, dismissButton = { FlowRow {
            if (version?.str("skillId") != null) ConfirmRemoval(stringResource(R.string.extras_skill_remove), version.str("name").orEmpty(), stringResource(R.string.extras_skill_remove_body)) { scope.launch {
                ownerCall { signed(activity, repository, "owner.skills.remove", buildJsonObject { put("skillId", version.str("skillId").orEmpty()) }, strings.getString(R.string.extras_skill_remove)) }
                    .onSuccess { feedback(strings.getString(R.string.extras_skill_removed)); review = null; load() }.onFailure { failure(it.message.orEmpty()) }
            } }
            TextButton({ review = null }) { Text(stringResource(R.string.action_close)) }
        } })
    }
}

/** Collections: create, add a desktop file or folder, use it everywhere or in a conversation's project, index, delete. */
@Composable
private fun CollectionsSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit, initialSessionId: String?) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var target by rememberSaveable { mutableStateOf(initialSessionId?.takeIf { id -> state.sessions.any { it.id == id } } ?: state.selectedSessionId ?: state.sessions.maxByOrNull { it.updated }?.id) }
    TargetConversation(state, target) { target = it }
    var collections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var deleting by remember { mutableStateOf<JsonObject?>(null) }
    var trying by remember { mutableStateOf<JsonObject?>(null) }
    trying?.let { collection -> CollectionTrial(repository, collection.str("id").orEmpty(), collection.str("name").orEmpty()) { trying = null } }
    var name by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("") }
    fun load() = scope.launch { ownerCall { repository.request("owner.collections.list", buildJsonObject {}) }.onSuccess { value -> collections = (value as? JsonObject)?.list("collections") ?: value.objects() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    collections.forEach { collection ->
        val id = collection.str("id").orEmpty()
        val revision = collection.str("revision") ?: "0"
        Text(stringResource(R.string.computer_sources, collection.str("name").orEmpty(), collection.list("sources").size) + (collection.str("state")?.let { " · $it" } ?: ""), style = MaterialTheme.typography.titleSmall)
        collection.list("sources").take(20).forEach { item -> Row(verticalAlignment = Alignment.CenterVertically) {
            val path = item.str("path").orEmpty()
            Text(path, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            if (path.startsWith("/")) ConfirmRemoval(stringResource(R.string.action_remove), path.substringAfterLast('/'), stringResource(R.string.extras_source_remove_body)) { scope.launch {
                ownerCall { signed(activity, repository, "owner.collections.removeSource", buildJsonObject { put("id", id); put("expectedRevision", revision); put("path", path) }, strings.getString(R.string.computer_remove, path)) }
                    .onSuccess { feedback(strings.getString(R.string.extras_source_removed)); load() }.onFailure { failure(it.message.orEmpty()) }
            } }
        } }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.addSource", buildJsonObject { put("id", id); put("expectedRevision", revision); put("path", source.trim()) }, strings.getString(R.string.computer_add_to, source.trim(), collection.str("name"))) }.onSuccess { source = ""; feedback(strings.getString(R.string.computer_source_added)); load() }.onFailure { failure(it.message ?: "") } } }, enabled = source.trim().startsWith("/")) { Text(stringResource(R.string.computer_add_source)) }
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.index", buildJsonObject { put("id", id) }, strings.getString(R.string.computer_index_2, collection.str("name"))) }.onSuccess { feedback(strings.getString(R.string.computer_indexing_on_the_desktop)) }.onFailure { failure(it.message ?: "") } } }) { Text(stringResource(R.string.computer_index)) }
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.bind", buildJsonObject { put("id", id); put("target", "global"); put("bound", true) }, strings.getString(R.string.computer_use_everywhere_2, collection.str("name"))) }.onSuccess { feedback(strings.getString(R.string.computer_used_in_every_conversation)) }.onFailure { failure(it.message ?: "") } } }) { Text(stringResource(R.string.computer_use_everywhere)) }
            target?.takeIf { id -> state.sessions.any { it.id == id } }?.let { sessionId -> TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.bind", buildJsonObject { put("id", id); put("target", "project"); put("sessionId", sessionId); put("bound", true) }, strings.getString(R.string.computer_use_in_this_project, collection.str("name"))) }.onSuccess { feedback(strings.getString(R.string.computer_used_in_this_project)) }.onFailure { failure(it.message ?: "") } } }) { Text(stringResource(R.string.computer_use_in_selected_conversations_project)) } }
            TextButton({ scope.launch { ownerCall { repository.mutate("owner.collections.cancel", buildJsonObject {}) }.onSuccess { feedback(strings.getString(R.string.extras_index_stopped)); load() }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.extras_index_stop)) }
            if (state.supports("owner.collections.search")) TextButton({ trying = collection }) { Text(stringResource(R.string.kb_try)) }
            if (state.supports("owner.collections.update")) {
                FilterChip(collection.isTrue("code"), { scope.launch { ownerCall { signed(activity, repository, "owner.collections.update", buildJsonObject { put("id", id); put("expectedRevision", revision); put("code", !collection.isTrue("code")) }, strings.getString(R.string.kb_code)) }.onSuccess { load() }.onFailure { failure(it.message.orEmpty()) } } }, { Text(stringResource(R.string.kb_code)) })
                TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.index", buildJsonObject { put("id", id); put("rebuild", true) }, strings.getString(R.string.kb_rebuild)) }.onSuccess { load() }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.kb_rebuild)) }
            }
            TextButton({ deleting = collection }) { Text(stringResource(R.string.computer_delete)) }
            // §11.1: a web page read once and kept as a dated snapshot; watched folders update after changes settle.
            TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.addUrl", buildJsonObject { put("id", id); put("url", source.trim()) }, strings.getString(R.string.computer_add_the_page_to, source.trim(), collection.str("name"))) }.onSuccess { source = ""; feedback(strings.getString(R.string.computer_page_added_index_the_collection_to_use_it)); load() }.onFailure { failure(it.message ?: "") } } }, enabled = source.trim().startsWith("http")) { Text(stringResource(R.string.computer_add_as_web_page)) }
            FilterChip(collection.isTrue("watch"), { scope.launch { ownerCall { repository.mutate("owner.collections.setWatch", buildJsonObject { put("id", id); put("watch", !collection.isTrue("watch")) }, strings.getString(R.string.computer_watch_folders)) }.onSuccess { load() }.onFailure { failure(it.message ?: "") } } }, { Text(if (collection.list("sources").none { it.str("kind") == "folder" } && !collection.isTrue("watch")) stringResource(R.string.computer_add_a_folder_to_watch) else stringResource(R.string.computer_watch_folders)) }, enabled = collection.isTrue("watch") || collection.list("sources").any { it.str("kind") == "folder" })
        }
    }
    deleting?.let { selected ->
        val nameToDelete = selected.str("name").orEmpty()
        AlertDialog({ deleting = null }, title = { Text(stringResource(R.string.computer_delete_2, nameToDelete)) },
            text = { Text(stringResource(R.string.computer_remove_this_collection_its_index_and_its) + selected.list("sources").size + stringResource(R.string.computer_source_references_your_original_files_stay_on_the)) },
            confirmButton = { Button({ deleting = null; scope.launch {
                ownerCall { signed(activity, repository, "owner.collections.delete", buildJsonObject {
                    put("id", selected.str("id").orEmpty()); put("expectedRevision", selected.str("revision") ?: "0"); put("confirmed", true)
                }, strings.getString(R.string.computer_delete_and_its_index, nameToDelete)) }.onSuccess { feedback(strings.getString(R.string.computer_deleted, nameToDelete)); load() }.onFailure { failure(it.message.orEmpty()) }
            } }) { Text(stringResource(R.string.computer_delete_collection)) } }, dismissButton = { TextButton({ deleting = null }) { Text(stringResource(R.string.action_cancel)) } })
    }
    OutlinedTextField(source, { source = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_desktop_file_or_folder_absolute_path_or_a)) })
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        OutlinedTextField(name, { name = it.take(100) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.computer_new_collection)) })
        Button({ scope.launch { ownerCall { signed(activity, repository, "owner.collections.create", buildJsonObject { put("name", name.trim()) }, strings.getString(R.string.computer_create_the_collection, name.trim())) }.onSuccess { name = ""; load() }.onFailure { failure(it.message ?: "") } } }, enabled = name.isNotBlank()) { Text(stringResource(R.string.computer_create)) }
    }
    Text(stringResource(R.string.computer_pal_never_indexes_your_whole_home_folder_add), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * Tool servers (PAL Everywhere §14): sign in to a server at an address from this phone (the browser returns to the app,
 * the desktop exchanges the code and keeps the tokens), import another app's configuration for review, and settle
 * requests whose answer was lost.
 */
@Composable
private fun ToolServersSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit,
    initialToolServerId: String?, toolServerResult: String?, onOAuthStarted: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

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
    if (servers.isEmpty()) Text(stringResource(R.string.computer_no_tool_servers_on_the_desktop), style = MaterialTheme.typography.bodySmall)
    servers.sortedByDescending { it.str("id") == resultServer }.forEach { server ->
        val id = server.str("id").orEmpty(); val name = server.str("name").orEmpty(); val oauth = server.obj("oauth")
        Text("$name · ${server.str("state")}" + (server.str("url")?.let { " · $it" } ?: "") + (if (oauth?.isTrue("signedIn") == true) stringResource(R.string.computer_signed_in) else ""), style = MaterialTheme.typography.bodyMedium)
        if (id == resultServer && resultText != null) Text(resultText.orEmpty(), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.titleSmall)
        server.str("error")?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            if (server.str("transport") == "http" && oauth?.isTrue("signedIn") != true) TextButton({ scope.launch {
                ownerCall { signed(activity, repository, "owner.extensions.oauthStart", buildJsonObject { put("id", id) }, strings.getString(R.string.computer_sign_in_to_from_this_phone, name)) as JsonObject }
                    .onSuccess { started -> onOAuthStarted(id); if (started.str("authorizationUrl")?.let { context.open(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(it))) } != true) failure(strings.getString(R.string.open_refused)) }
                    .onFailure { failure(it.message ?: "") }
            } }, enabled = server.isTrue("enabled")) { Text(if (id == resultServer && resultText != null) stringResource(R.string.computer_sign_in_again) else stringResource(R.string.computer_sign_in)) }
            if (oauth?.isTrue("signedIn") == true) TextButton({ scope.launch { ownerCall { signed(activity, repository, "owner.extensions.oauthSignOut", buildJsonObject { put("id", id) }, strings.getString(R.string.computer_sign_out_of, name)) }.onSuccess { resultServer = id; resultText = strings.getString(R.string.computer_signed_out_of, name); load() }.onFailure { failure(it.message ?: "") } } }) { Text(stringResource(R.string.computer_sign_out)) }
            TextButton({ scope.launch { ownerCall { repository.mutate("owner.extensions.restart", buildJsonObject { put("id", id) }, strings.getString(R.string.computer_start_2, name)) }.onSuccess { load() }.onFailure { failure(it.message ?: ""); load() } } }, enabled = server.isTrue("enabled")) { Text(if (server.str("state") == "ready") stringResource(R.string.computer_restart) else stringResource(R.string.action_start)) }
        }
        ToolServerDetails(repository, activity, server, feedback, failure) { load() }
    }
    if (writes.isNotEmpty()) {
        Text(stringResource(R.string.computer_requests_to_check), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.computer_their_answer_was_lost_so_pal_does_not), style = MaterialTheme.typography.bodySmall)
        var reviewing by remember { mutableStateOf<JsonObject?>(null) }
        writes.forEach { write ->
            val at = write.num("at")?.let { java.time.Instant.ofEpochMilli(it).toString() }.orEmpty()
            Text(write.str("server").orEmpty() + " · " + (write.str("intent") ?: write.str("tool")).orEmpty())
            Text((write.str("conversationTitle") ?: write.str("sessionId")).orEmpty() + " · " + at, style = MaterialTheme.typography.bodySmall)
            TextButton({ reviewing = write }) { Text(stringResource(R.string.computer_check_request) + write.str("id").orEmpty().take(8)) }
        }
        reviewing?.let { write ->
            AlertDialog({ reviewing = null }, title = { Text(stringResource(R.string.computer_check_the_change_in) + write.str("server").orEmpty()) }, text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    Text((write.str("intent") ?: write.str("tool")).orEmpty())
                    Text(stringResource(R.string.computer_conversation) + (write.str("conversationTitle") ?: write.str("sessionId")).orEmpty())
                    write.num("at")?.let { Text(stringResource(R.string.computer_time) + java.time.Instant.ofEpochMilli(it)) }
                    SelectionContainer { Text(stringResource(R.string.computer_pal_request) + write.str("id").orEmpty()) }
                    write.str("result")?.let { SelectionContainer { Text(stringResource(R.string.computer_service_reference, it)) } }
                    Text(stringResource(R.string.computer_record_the_result_after_checking_the_service_either))
                    for ((outcome, label) in listOf("done" to strings.getString(R.string.computer_it_took_effect), "not-done" to strings.getString(R.string.computer_it_did_not_take_effect))) {
                        OutlinedButton({ scope.launch {
                            ownerCall { signed(activity, repository, "owner.extensions.resolveWrite", buildJsonObject {
                                put("id", write.str("id").orEmpty()); put("outcome", outcome)
                            }, strings.getString(R.string.computer_record_the_checked_outcome, label)) }.onSuccess { reviewing = null; feedback(strings.getString(R.string.computer_outcome_recorded)); load() }.onFailure { failure(it.message.orEmpty()) }
                        } }) { Text(label) }
                    }
                }
            }, confirmButton = { TextButton({ reviewing = null }) { Text(stringResource(R.string.computer_leave_unresolved)) } })
        }
    }
    Text(stringResource(R.string.computer_import_from_another_app), style = MaterialTheme.typography.titleSmall)
    if (preview == null) {
        OutlinedTextField(importText, { importText = it }, Modifier.fillMaxWidth(), minLines = 3, maxLines = 8, label = { Text(stringResource(R.string.computer_paste_an_mcp_configuration_json)) })
        TextButton({ scope.launch { ownerCall { repository.request("owner.extensions.importPreview", buildJsonObject { put("text", importText) }) as JsonObject }.onSuccess { preview = it; chosen = it.list("servers").filter { server -> server.str("problem") == null }.mapNotNull { server -> server.str("name") }.toSet() }.onFailure { failure(it.message ?: "") } } }, enabled = importText.length > 1) { Text(stringResource(R.string.transcript_review_attachment)) }
    } else preview?.let { reviewed ->
        reviewed.list("servers").forEach { server ->
            val name = server.str("name").orEmpty()
            val problem = server.str("problem")
            if (problem == null) LabeledCheck(name, name in chosen) { chosen = if (it) chosen + name else chosen - name }
            else Text("$name · $problem", color = MaterialTheme.colorScheme.error)
            server.str("url")?.let { Text(stringResource(R.string.computer_address, it)) }
            server.str("network")?.let { Text(stringResource(R.string.computer_network) + if (it == "local") stringResource(R.string.computer_this_computer_or_local_network) else stringResource(R.string.computer_internet)) }
            server.str("command")?.let { Text(stringResource(R.string.computer_program, it), fontFamily = FontFamily.Monospace) }
            (server["args"] as? JsonArray)?.let { Text(stringResource(R.string.computer_arguments) + if (it.isEmpty()) stringResource(R.string.computer_none) else it.toString(), fontFamily = FontFamily.Monospace) }
            server.str("cwd")?.let { Text(stringResource(R.string.computer_working_folder, it)) }
            server.list("secrets").forEach { Text(stringResource(R.string.computer_credential) + it.str("name").orEmpty() + if (it.str("value") == "missing") stringResource(R.string.computer_set_later) else stringResource(R.string.computer_value_imported)) }
            server.strings("warnings").forEach { Text(it, color = MaterialTheme.colorScheme.error) }
            HorizontalDivider()
        }
        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            TextButton({ preview = null }) { Text(stringResource(R.string.go_back)) }
            Button({ scope.launch { ownerCall { signed(activity, repository, "owner.extensions.importApply", buildJsonObject { put("token", reviewed.str("token").orEmpty()); put("names", JsonArray(chosen.map { JsonPrimitive(it) })) }, strings.getQuantityString(R.plurals.server_count_action, chosen.size, chosen.size)) }.onSuccess { preview = null; importText = ""; feedback(strings.getString(R.string.computer_added_turned_off_review_each_one_before_turning)); load() }.onFailure { failure(it.message ?: "") } } }, enabled = chosen.isNotEmpty()) { Text(stringResource(R.string.computer_add_turned_off)) }
        }
    }
}

/** Working setups (§12.3): apply one to the open conversation after seeing its changes, or start a conversation with it. */
@Composable
private fun SetupsSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit, initialSessionId: String?) {
    val strings = androidx.compose.ui.platform.LocalResources.current

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
    var setupsRevision by remember { mutableStateOf("0") }
    var editing by remember { mutableStateOf<JsonObject?>(null) }
    fun load() = scope.launch { ownerCall { repository.request("owner.setups.list", buildJsonObject {}) as JsonObject }.onSuccess { setups = it.list("setups"); setupsRevision = it.str("revision") ?: "0"; supportsStartRevision = it.isTrue("supportsStartRevision") }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    editing?.let { setup -> SetupEditor(state, setup, repository, { editing = null }) { value ->
        editing = null
        scope.launch { ownerCall { signed(activity, repository, "owner.setups.save", buildJsonObject { put("setup", value); put("expectedRevision", setupsRevision) }, strings.getString(R.string.extras_setup_action, value.str("name").orEmpty())) }
            .onSuccess { feedback(strings.getString(R.string.extras_setup_saved)); load() }.onFailure { failure(it.message.orEmpty()) } }
    } }
    TextButton({ editing = buildJsonObject { put("name", ""); put("description", "") } }) { Text(stringResource(R.string.extras_setup_new)) }
    fun startConversation(setup: JsonObject) {
        val name = setup.str("name").orEmpty()
        val host = setup.obj("families")?.isTrue("host") == true
        if (host && !supportsStartRevision) {
            failure(strings.getString(R.string.computer_update_pal_on_the_desktop_to_start_this))
            return
        }
        scope.launch {
            ownerCall { signed(activity, repository, "owner.setups.start", buildJsonObject {
                put("setupId", setup.str("id").orEmpty()); put("cwd", folder.trim())
                if (supportsStartRevision) put("expectedSetupRevision", setup.str("revision").orEmpty())
                if (model.isNotBlank()) put("model", model.trim())
            }, strings.getString(R.string.computer_start_a_conversation_with_in, name, folder.trim())) as JsonObject }
                .onSuccess { started ->
                    val missing = started.strings("unresolved").joinToString(" ")
                    feedback(strings.getString(R.string.computer_started_with, name) + if (missing.isNotEmpty()) strings.getString(R.string.computer_missing, missing) else "")
                    started.obj("session")?.str("id")?.let { target = it; repository.selectSession(it) }
                }.onFailure { failure(it.message.orEmpty()) }
        }
    }
    setups.forEach { setup ->
        val id = setup.str("id").orEmpty(); val name = setup.str("name").orEmpty()
        Text(name + if (setup.isTrue("builtin")) stringResource(R.string.computer_example) else "", style = MaterialTheme.typography.bodyMedium)
        setup.str("description")?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            target?.takeIf { id -> state.sessions.any { it.id == id } }?.let { sessionId -> TextButton({ scope.launch {
                ownerCall { repository.request("owner.setups.preview", buildJsonObject { put("setupId", id); put("sessionId", sessionId) }) as JsonObject }.onSuccess { previewTarget = state.sessions.firstOrNull { row -> row.id == sessionId }?.title ?: sessionId; preview = it }.onFailure { failure(it.message ?: "") }
            } }) { Text(stringResource(R.string.computer_preview_for_selected_conversation)) } }
            TextButton({
                if (setup.obj("families")?.isTrue("host") == true) startReview = setup else startConversation(setup)
            }, enabled = folder.trim().startsWith("/")) { Text(stringResource(R.string.transcript_empty_title)) }
            TextButton({ editing = setup }) { Text(stringResource(if (setup.isTrue("builtin")) R.string.extras_setup_copy else R.string.extras_setup_edit)) }
            if (!setup.isTrue("builtin")) ConfirmRemoval(stringResource(R.string.action_delete), name, stringResource(R.string.extras_setup_delete_body)) { scope.launch {
                ownerCall { signed(activity, repository, "owner.setups.delete", buildJsonObject { put("id", id) }, strings.getString(R.string.computer_delete_2, name)) }.onSuccess { feedback(strings.getString(R.string.extras_setup_deleted)); load() }.onFailure { failure(it.message.orEmpty()) }
            } }
        }
    }
    OutlinedTextField(folder, { folder = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_project_folder_for_new_conversations)) })
    // The desktop starts a setup that names no provider on Ollama.
    val unnamed = setups.filter { it.str("model").isNullOrBlank() }.map { it.str("provider") ?: "ollama" }
    ModelField(model, { model = it }, stringResource(R.string.computer_model_when_the_setup_names_none_optional), modelSource(repository, state, unnamed), none = stringResource(R.string.sheet_provider_default_model))
    startReview?.let { setup ->
        AlertDialog({ startReview = null }, title = { Text(stringResource(R.string.computer_start_with_host_commands)) },
            text = { Text("“" + setup.str("name").orEmpty() + stringResource(R.string.computer_will_open_a_new_conversation_in) + folder.trim() +
                stringResource(R.string.computer_its_model_can_run_commands_as_your_desktop)) },
            confirmButton = { Button({ startReview = null; startConversation(setup) }) { Text(stringResource(R.string.computer_start_with_host_commands_2)) } },
            dismissButton = { TextButton({ startReview = null }) { Text(stringResource(R.string.action_cancel)) } })
    }
    preview?.let { reviewed ->
        AlertDialog({ preview = null }, title = { Text(stringResource(R.string.computer_apply, reviewed.obj("setup")?.str("name").orEmpty())) }, text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                Text(stringResource(R.string.computer_conversation_2, previewTarget))
                val changes = reviewed.list("changes")
                if (changes.isEmpty()) Text(stringResource(R.string.computer_nothing_would_change))
                changes.forEach { change ->
                    if (change.str("kind") == "instructions") {
                        var full by remember(reviewed) { mutableStateOf(false) }
                        Text(stringResource(R.string.computer_standing_instructions_will_change))
                        TextButton({ full = !full }) { Text(if (full) stringResource(R.string.computer_hide_full_change) else stringResource(R.string.computer_read_full_change)) }
                        if (full) {
                            Text(stringResource(R.string.computer_current_instructions)); Text(change.str("from").orEmpty())
                            Text(stringResource(R.string.computer_proposed_instructions)); Text(change.str("to").orEmpty())
                        }
                    } else Text("${change.str("label")}: " + (change.str("from")?.let { "$it → " } ?: "") + change.str("to").orEmpty(), style = MaterialTheme.typography.bodySmall)
                }
                reviewed.strings("unresolved").forEach { Text(stringResource(R.string.computer_missing_2) + it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                reviewed.strings("notes").forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }, confirmButton = { Button({ scope.launch {
            ownerCall { signed(activity, repository, "owner.setups.apply", buildJsonObject { put("token", reviewed.str("token").orEmpty()) }, strings.getString(R.string.computer_apply_to_this_conversation, reviewed.obj("setup")?.str("name"))) }
                .onSuccess { preview = null; feedback(strings.getString(R.string.computer_applied)) }.onFailure { failure(it.message ?: ""); preview = null }
        } }, enabled = reviewed.list("changes").isNotEmpty()) { Text(stringResource(R.string.computer_apply_2)) } }, dismissButton = { TextButton({ preview = null }) { Text(stringResource(R.string.action_cancel)) } })
    }
}

/** Specialists (§17.2): what a conversation can ask, how many run at once, and custom ones with their own model. */
@Composable
private fun SpecialistsSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var data by remember { mutableStateOf<JsonObject?>(null) }
    var name by remember { mutableStateOf("") }; var role by remember { mutableStateOf("code_review") }; var model by remember { mutableStateOf("") }
    var provider by remember { mutableStateOf("") }; var account by remember { mutableStateOf("") }
    // What it runs on: a visual critic always runs on the vision helper, and an unnamed one on the helper model.
    fun runsOn(item: JsonObject): String { val id = item.str("provider") ?: return item.str("model")?.let { " · $it" }.orEmpty(); val named = item.str("connectionId")?.let { key -> (state.providers[id] as? JsonObject)?.list("connections")?.firstOrNull { it.str("id") == key }?.str("name") ?: strings.getString(R.string.extras_account_gone) }; return listOfNotNull(state.traits(id).label, item.str("model"), named).joinToString(" · ", " · ") }
    fun load() = scope.launch { ownerCall { repository.request("owner.specialists.list", buildJsonObject {}) as JsonObject }.onSuccess { data = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    val roles = data?.obj("roles")
    data?.list("specialists")?.forEach { item ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("${item.str("name")} · ${roles?.str(item.str("role").orEmpty()) ?: item.str("role")}" + runsOn(item), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            if (!item.isTrue("builtin")) ConfirmRemoval(stringResource(R.string.action_delete), item.str("name").orEmpty(), stringResource(R.string.computer_this_specialist_will_no_longer_be_available_to)) { scope.launch { ownerCall { signed(activity, repository, "owner.specialists.delete", buildJsonObject { put("id", item.str("id").orEmpty()) }, strings.getString(R.string.computer_delete_the_specialist, item.str("name"))) }.onSuccess { load() }.onFailure { failure(it.message ?: "") } } }
        }
    }
    Text(stringResource(R.string.computer_at_most_this_many_run_at_once_in), style = MaterialTheme.typography.bodySmall)
    Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        (1..4).forEach { count -> FilterChip(data?.int("concurrency") == count, { scope.launch { ownerCall { signed(activity, repository, "owner.specialists.setConcurrency", buildJsonObject { put("concurrency", count) }, strings.getQuantityString(R.plurals.specialist_limit, count, count)) }.onSuccess { load() }.onFailure { failure(it.message ?: "") } } }, { Text("$count") }) }
    }
    OutlinedTextField(name, { name = it.take(60) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_new_specialist_name)) })
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { roles?.keys?.forEach { id -> FilterChip(role == id, { role = id }, { Text(roles.str(id).orEmpty()) }) } }
    if (role != "visual_review") {
        Text(stringResource(R.string.extras_specialist_runs), style = MaterialTheme.typography.labelMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            FilterChip(provider.isEmpty(), { provider = ""; account = ""; model = "" }, { Text(stringResource(R.string.extras_specialist_helper)) })
            state.providers.keys.filter { state.traits(it).kind.let { kind -> kind == "api" || kind == "local" } }.forEach { id -> FilterChip(provider == id, { if (provider != id) { provider = id; account = "" } }, { Text(state.traits(id).label) }) }
        }
        AccountChoice(state, provider, account, byName = false) { account = it }
        if (provider.isNotEmpty()) ModelField(model, { model = it.trim() }, stringResource(R.string.care_model), modelSource(repository, state, provider, connectionId = account))
    }
    Button({ scope.launch {
        ownerCall { signed(activity, repository, "owner.specialists.save", buildJsonObject { put("specialist", buildJsonObject { put("name", name.trim()); put("role", role); if (provider.isNotEmpty() && role != "visual_review") { put("provider", provider); put("model", model); if (account.isNotEmpty()) put("connectionId", account) } }) }, strings.getString(R.string.computer_add_the_specialist, name.trim())) }
            .onSuccess { name = ""; model = ""; provider = ""; account = ""; load() }.onFailure { failure(it.message ?: "") }
    } }, enabled = name.isNotBlank() && (provider.isEmpty() || role == "visual_review" || model.isNotBlank())) { Text(stringResource(R.string.computer_add)) }
    Text(stringResource(R.string.computer_specialists_have_no_tools_and_change_nothing_a), style = MaterialTheme.typography.bodySmall)
}

/** Saved scripts: the commands PAL may run, edited as the desktop edits them (settings family "scripts"). */
@Composable
private fun ScriptsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

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
            Column(Modifier.weight(1f)) { Text(script.str("name").orEmpty()); Text("${script.str("executable")} ${script.strings("args").joinToString(" ")} · ${script.str("cwd")}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
            ConfirmRemoval(stringResource(R.string.action_remove), script.str("name").orEmpty(), stringResource(R.string.computer_this_removes_the_saved_script_from_pal_on)) { save(scripts.filter { it.str("id") != script.str("id") }, strings.getString(R.string.computer_remove, script.str("name"))) }
        }
    }
    OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_name)) })
    OutlinedTextField(executable, { executable = it.trim() }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_executable_absolute_path_on_the_desktop)) })
    OutlinedTextField(args, { args = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_arguments_json_array)) })
    OutlinedTextField(cwd, { cwd = it.trim() }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_working_folder_absolute_path)) })
    Button({
        val parsed = ownerCall { Json.parseToJsonElement(args) as JsonArray }.getOrNull()
        if (parsed == null) { failure(strings.getString(R.string.computer_arguments_must_be_a_json_array_of_strings)); return@Button }
        save(scripts + buildJsonObject { put("id", java.util.UUID.randomUUID().toString()); put("name", name.trim()); put("executable", executable); put("args", parsed); put("cwd", cwd); put("timeout", 60_000) }, strings.getString(R.string.computer_add_the_saved_script, name.trim()))
    }, enabled = name.isNotBlank() && executable.startsWith("/") && cwd.startsWith("/")) { Text(stringResource(R.string.computer_add_script)) }
    Text(stringResource(R.string.computer_saved_scripts_run_as_your_desktop_account_when), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * Routines (PAL Everywhere §17.1): the desktop's schedules, created here from a reviewed recipe exactly as on the
 * desktop. The phone that signs a routine's creation is recorded as its authorizer; removing that phone pauses it
 * unless the desktop takes the authorization over ("Authorize on the desktop").
 */
@Composable
private fun SchedulesSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var schedules by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var creating by remember { mutableStateOf(false) }
    fun load() = scope.launch { ownerCall { repository.request("owner.schedules.list", buildJsonObject {}) }.onSuccess { schedules = it.objects() }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    if (schedules.isEmpty()) Text(stringResource(R.string.computer_no_routines_yet), style = MaterialTheme.typography.bodySmall)
    schedules.forEach { schedule ->
        val id = schedule.str("id").orEmpty()
        val label = schedule.str("label").orEmpty()
        val whenObj = schedule.obj("when")
        val by = schedule.obj("authorizedBy")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label)
                val timing = if (whenObj?.str("kind") == "folder") strings.getString(R.string.computer_when_files_change_in, whenObj.str("path")) + (if (schedule.obj("pending") != null) strings.getString(R.string.computer_changes_waiting) else "")
                    else schedule.num("next")?.let { strings.getString(R.string.next_schedule, java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(it))) } ?: strings.getString(R.string.computer_no_next_run)
                Text((if (schedule.isTrue("enabled")) timing else stringResource(R.string.computer_paused)) + (schedule.obj("lastRun")?.let { " · " + strings.getString(R.string.last_schedule, it.str("outcome").orEmpty()) + (it.str("reason")?.let { reason -> " ($reason)" } ?: "") } ?: "") +
                    (if (by?.str("kind") == "device") stringResource(R.string.computer_authorized_from, by.str("name").orEmpty()) else stringResource(R.string.computer_authorized_on_the_desktop)), style = MaterialTheme.typography.bodySmall)
            }
            Switch(schedule.isTrue("enabled"), { enabled -> scope.launch {
                ownerCall { signed(activity, repository, "owner.schedules.setEnabled", buildJsonObject { put("id", id); put("enabled", enabled) }, if (enabled) strings.getString(R.string.computer_resume, label) else strings.getString(R.string.computer_pause, label)) }
                    .onSuccess { load() }.onFailure { failure(it.message ?: "") }
            } })
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            var adopting by rememberSaveable(id) { mutableStateOf(false) }
            if (by?.str("kind") == "device" && schedule.str("pausedFor") == null) TextButton({ adopting = true }) { Text(stringResource(R.string.computer_transfer_authorization)) }
            if (adopting) AlertDialog({ adopting = false }, title = { Text(stringResource(R.string.computer_transfer_to_the_desktop, label)) },
                text = { Text(stringResource(R.string.computer_the_desktop_will_authorize_this_routine_it_can) + (by?.str("name") ?: stringResource(R.string.computer_the_authorizing_phone)) + stringResource(R.string.computer_loses_access_you_can_pause_or_delete_the)) },
                confirmButton = { Button({ adopting = false; scope.launch {
                    ownerCall { signed(activity, repository, "owner.schedules.adopt", buildJsonObject { put("id", id) }, strings.getString(R.string.computer_make_the_desktop_the_authorizer_of, label)) }
                        .onSuccess { feedback(strings.getString(R.string.computer_authorized_on_the_desktop_2)); load() }.onFailure { failure(it.message.orEmpty()) }
                } }) { Text(stringResource(R.string.computer_transfer_authorization_2)) } }, dismissButton = { TextButton({ adopting = false }) { Text(stringResource(R.string.action_cancel)) } })
            ConfirmRemoval(stringResource(R.string.action_delete), label, stringResource(R.string.computer_this_routine_will_no_longer_run_its_previous)) { scope.launch {
                ownerCall { signed(activity, repository, "owner.schedules.delete", buildJsonObject { put("id", id) }, strings.getString(R.string.computer_delete_the_routine, label)) }.onSuccess { load() }.onFailure { failure(it.message ?: "") }
            } }
        }
    }
    if (!creating) TextButton({ creating = true }) { Text(stringResource(R.string.computer_new_routine)) }
    else RoutineCreator(repository, state, activity, { creating = false; load() }, feedback, failure)
}

/** Recipe → inputs → reviewed prompt → when it runs. Nothing runs now; the reviewed preview becomes the routine. */
@Composable
private fun RoutineCreator(repository: PALRepository, state: MobileState, activity: FragmentActivity, done: () -> Unit, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

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
        TextButton({ sessionsOpen = true }) { Text(stringResource(R.string.computer_conversation_3) + (state.sessions.firstOrNull { it.id == sessionId }?.title ?: stringResource(R.string.computer_choose))) }
        DropdownMenu(sessionsOpen, { sessionsOpen = false }) { state.sessions.forEach { session -> DropdownMenuItem(text = { Text(session.title) }, onClick = { sessionId = session.id; preview = null; sessionsOpen = false }) } }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        recipes.forEach { item -> FilterChip(recipe?.str("id") == item.str("id"), { recipe = item; values.clear(); preview = null; if (label.isBlank()) label = item.str("name").orEmpty() }, { Text(item.str("name").orEmpty()) }) }
    }
    recipe?.let { chosen ->
        chosen.str("description")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        chosen.list("inputs").forEach { input -> RecipeInputField(repository, sessionId, input, values[input.str("name").orEmpty()]) { value -> preview = null; if (value == null) values.remove(input.str("name").orEmpty()) else values[input.str("name").orEmpty()] = value } }
        Button({ scope.launch {
            ownerCall { repository.request("owner.recipes.prepare", buildJsonObject { put("sessionId", sessionId.orEmpty()); put("recipeId", chosen.str("id").orEmpty()); put("inputs", JsonObject(values.toMap())) }) as JsonObject }
                .onSuccess { preview = it }.onFailure { failure(it.message ?: "") }
        } }, enabled = sessionId != null) { Text(stringResource(R.string.computer_review_the_prompt)) }
    }
    preview?.let { reviewed ->
        Text(stringResource(R.string.computer_the_exact_prompt_each_run_sends), style = MaterialTheme.typography.labelMedium)
        var expanded by remember(reviewed) { mutableStateOf(false) }
        Text(reviewed.str("prompt").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
            maxLines = if (expanded) Int.MAX_VALUE else 14, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        TextButton({ expanded = !expanded }) { Text(if (expanded) stringResource(R.string.computer_collapse_prompt) else stringResource(R.string.computer_read_full_prompt)) }
        if (state.supports("owner.recipes.createDraft")) TextButton({ scope.launch {
            ownerCall { signed(activity, repository, "owner.recipes.createDraft", buildJsonObject { put("previewToken", reviewed.str("token").orEmpty()); put("reviewed", true) }, strings.getString(R.string.extras_recipe_draft_action)) as JsonObject }
                .onSuccess { made -> feedback(strings.getString(R.string.extras_recipe_drafted)); made.obj("session")?.str("id")?.let { repository.selectSession(it) }; done() }.onFailure { failure(it.message.orEmpty()) }
        } }) { Text(stringResource(R.string.extras_recipe_draft)) }
        OutlinedTextField(label, { label = it.take(80) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_routine_name)) })
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            listOf("daily" to strings.getString(R.string.computer_every_day), "weekdays" to strings.getString(R.string.computer_weekdays), "weekly" to strings.getString(R.string.computer_chosen_days), "once" to strings.getString(R.string.computer_once), "folder" to strings.getString(R.string.computer_when_files_change)).forEach { (id, text) -> FilterChip(kind == id, { kind = id }, { Text(text) }) }
        }
        if (kind == "folder") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                roots.forEach { path -> FilterChip(folder == path, { folder = path }, { Text(path) }) }
            }
            OutlinedTextField(folder, { folder = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_project_folder_to_watch_absolute_path)) })
            OutlinedTextField(quiet, { quiet = it.filter(Char::isDigit).take(4) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_seconds_of_quiet_before_it_runs_53_600)) })
            Text(stringResource(R.string.computer_it_runs_once_after_the_folder_settles_with), style = MaterialTheme.typography.bodySmall)
        } else {
            OutlinedTextField(time, { time = it.take(5) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_time_hh_mm_desktop_time_zone)) })
            if (kind == "weekly") FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.tight)) { listOf(strings.getString(R.string.computer_sun), strings.getString(R.string.computer_mon), strings.getString(R.string.computer_tue), strings.getString(R.string.computer_wed), strings.getString(R.string.computer_thu), strings.getString(R.string.computer_fri), strings.getString(R.string.computer_sat)).forEachIndexed { index, day -> FilterChip(index in days, { days = if (index in days) days - index else days + index }, { Text(day) }) } }
            if (kind == "once") OutlinedTextField(date, { date = it.take(10) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.computer_date_yyyy_mm_dd)) })
            LabeledCheck(stringResource(R.string.computer_if_the_desktop_was_off_at_that_time), catchUp) { catchUp = it }
        }
        if (kind == "folder" && folder.isNotBlank()) Text(stringResource(R.string.computer_watch) + folder.trim() + stringResource(R.string.computer_after) + quiet + stringResource(R.string.computer_seconds_without_a_change))
        val delivery = remember { mutableStateOf<JsonObject?>(null) }
        if (state.supports("owner.accounts.list")) RoutineDelivery(repository) { delivery.value = it }
        LabeledCheck(stringResource(R.string.computer_it_may_run_while_i_am_away_permission), unattended) { unattended = it }
        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            TextButton(done) { Text(stringResource(R.string.action_cancel)) }
            Button({ scope.launch {
                val whenValue = buildJsonObject {
                    put("kind", kind)
                    if (kind == "folder") { put("path", folder.trim()); put("quietSeconds", quiet.toIntOrNull() ?: 30) } else put("time", time)
                    if (kind == "weekly") put("days", JsonArray(days.sorted().map { JsonPrimitive(it) }))
                    if (kind == "once") put("date", date)
                }
                ownerCall { signed(activity, repository, "owner.schedules.create", buildJsonObject { put("label", label.trim()); put("when", whenValue); put("previewToken", reviewed.str("token").orEmpty()); put("unattended", true); if (catchUp && kind != "folder") put("missed", "once"); delivery.value?.let { put("delivery", it) } }, strings.getString(R.string.computer_schedule_to_run_while_you_are_away, label.trim())) }
                    .onSuccess { feedback(strings.getString(R.string.computer_routine_saved_its_results_go_to_the_inbox)); done() }.onFailure { failure(it.message ?: "") }
            } }, enabled = unattended && label.isNotBlank() && (kind != "folder" || (folder.trim().startsWith("/") && quiet.toIntOrNull() in 5..3600))) { Text(stringResource(R.string.computer_save_routine)) }
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
                OutlinedTextField(query, { query = it }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.computer_find_a, type)) })
                TextButton({ scope.launch { ownerCall { repository.request("workbench.references.search", buildJsonObject { put("sessionId", sessionId.orEmpty()); put("query", query) }) }.onSuccess { result -> candidates = ((result as? JsonObject)?.list("candidates") ?: result.objects()).filter { it.str("kind") == type } } } }, enabled = sessionId != null) { Text(stringResource(R.string.mobile_find)) }
            }
            candidates.take(8).forEach { candidate -> TextButton({ set(candidate.obj("ref")); candidates = emptyList() }) { Text("${candidate.str("label")} · ${candidate.str("detail").orEmpty()}", maxLines = 1) } }
        }
    }
}

@Composable
private fun ModelsSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberOwnerScope()
    var models by remember { mutableStateOf<JsonElement?>(null) }
    var pull by remember { mutableStateOf("") }
    fun load() = scope.launch { ownerCall { repository.request("owner.models.local", buildJsonObject {}) }.onSuccess { models = it }.onFailure { failure(it.message ?: "") } }
    LaunchedEffect(Unit) { load() }
    LocalModelRows(repository, activity, models as? JsonObject ?: buildJsonObject { put("models", models ?: JsonArray(emptyList())) }, feedback, failure) { load() }
    OutlinedTextField(pull, { pull = it.trim() }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.computer_download_a_model_ollama_name)) }, singleLine = true)
    Button({ scope.launch { ownerCall { signed(activity, repository, "owner.models.pull", buildJsonObject { put("model", pull) }, strings.getString(R.string.computer_download_on_the_desktop, pull)) }.onSuccess { feedback(strings.getString(R.string.computer_downloading_on_the_desktop, pull)); load() }.onFailure { failure(it.message ?: "") } } }, enabled = pull.isNotBlank()) { Text(stringResource(R.string.computer_download)) }
}

@Composable
private fun HealthSection(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

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
        Text(stringResource(R.string.computer_pal) + report.obj("build")?.str("version").orEmpty() + stringResource(R.string.computer_linux_node) + report.str("node").orEmpty(), style = MaterialTheme.typography.titleSmall)
        report.obj("sessions")?.let { Text(stringResource(R.string.computer_conversations_saved_active, it.num("count") ?: 0, it.num("active") ?: 0)) }
        for (id in listOf("memory", "speech")) report.obj(id)?.let { part ->
            Text(id.replaceFirstChar { it.uppercase() } + " · " + if (part.isTrue("enabled")) part.str("state").orEmpty() else stringResource(R.string.computer_off))
        }
        report.list("providers").forEach { provider ->
            Text(provider.str("id").orEmpty() + " · " + if (provider.isTrue("available")) stringResource(R.string.computer_available) else stringResource(R.string.computer_unavailable))
            if (provider.str("problem") != null) Text(provider.str("repair").orEmpty(), style = MaterialTheme.typography.bodySmall)
        }
        val missing = report.list("dependencies").filter { !it.isTrue("available") }
        if (missing.isNotEmpty()) {
            Text(stringResource(R.string.computer_features_needing_a_desktop_program), style = MaterialTheme.typography.titleSmall)
            missing.forEach { Text(it.str("feature").orEmpty() + stringResource(R.string.computer_install) + it.str("name").orEmpty(), style = MaterialTheme.typography.bodySmall) }
        }
    }
    backup?.let { status ->
        Text(stringResource(R.string.computer_backups), style = MaterialTheme.typography.titleSmall)
        Text(if (status.isTrue("pending")) stringResource(R.string.computer_a_restore_is_pending_on_the_desktop) else stringResource(R.string.computer_backups_available_on_this_computer))
        val last = status.num("lastBackupAt")
        Text(stringResource(R.string.computer_last_successful_backup) + (last?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) }
            ?: if ("lastBackupAt" in status) stringResource(R.string.computer_none_recorded) else stringResource(R.string.computer_unavailable_from_this_desktop_version)))
        status.str("activationWarning")?.takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text(stringResource(R.string.computer_this_backup_includes_desktop_preferences_and_folders_it), style = MaterialTheme.typography.bodySmall)
    }
    OutlinedButton({ backingUp = true; scope.launch { try {
        ownerCall { signed(activity, repository, "owner.backup.create", buildJsonObject {}, strings.getString(R.string.computer_back_up_pal_on_the_desktop)) }
            .onSuccess { feedback(strings.getString(R.string.computer_backup_completed_on_the_desktop)); refresh() }.onFailure { failure(it.message.orEmpty()) }
    } finally { backingUp = false } } }, enabled = backup != null && !backingUp) { Text(if (backingUp) stringResource(R.string.computer_backing_up) else stringResource(R.string.computer_back_up_now)) }
    TextButton({ scope.launch { refresh() } }, enabled = !loading) { Text(stringResource(R.string.computer_refresh_status)) }
    TextButton({ technical = !technical }) { Text(if (technical) stringResource(R.string.computer_hide_technical_details) else stringResource(R.string.computer_show_technical_details)) }
    if (technical) {
        val details = buildJsonObject { health?.let { put("health", it) }; backup?.let { put("backup", it) } }.toString()
        val context = androidx.compose.ui.platform.LocalContext.current
        TextButton({ if (copyText(context, strings.getString(R.string.computer_copy_technical_details), details)) feedback(strings.getString(R.string.computer_technical_details_copied)) else failure(strings.getString(R.string.copy_refused)) }) { Text(stringResource(R.string.computer_copy_technical_details)) }
        SelectionContainer { Text(details, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
    }
}

private fun JsonObject?.orEmpty(): Map<String, JsonElement> = this ?: emptyMap()
