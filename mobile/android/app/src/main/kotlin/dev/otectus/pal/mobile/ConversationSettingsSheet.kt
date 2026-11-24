@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.fragment.app.FragmentActivity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ConfigurationDraft
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.ModelIds
import dev.otectus.pal.mobile.data.ToolAvailability
import dev.otectus.pal.mobile.data.ToolPolicy
import dev.otectus.pal.mobile.data.providerConnections
import dev.otectus.pal.mobile.data.traits
import dev.otectus.pal.mobile.protocol.Agent
import dev.otectus.pal.mobile.protocol.ConversationBehavior
import dev.otectus.pal.mobile.protocol.ModelOption
import dev.otectus.pal.mobile.protocol.Session
import dev.otectus.pal.mobile.protocol.WireCodec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun ConversationSettingsSheet(repository: PALRepository, state: MobileState, session: Session,
    activity: FragmentActivity, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val strings = LocalResources.current
    var title by rememberSaveable(session.id) { mutableStateOf(session.title) }
    var models by remember(session.id) { mutableStateOf(emptyList<ModelOption>()) }
    var unlisted by remember(session.id) { mutableStateOf(false) }
    var model by rememberSaveable(session.id) { mutableStateOf(session.model.orEmpty()) }
    var effort by rememberSaveable(session.id) { mutableStateOf(session.effort.orEmpty()) }
    var tools by rememberSaveable(session.id) { mutableStateOf(session.tools) }
    var connectionId by rememberSaveable(session.id) { mutableStateOf(session.connectionId.orEmpty()) }
    var providerOptions by remember(session.id) { mutableStateOf(session.providerOptions) }
    var toolsNotice by remember(session.id) { mutableStateOf<String?>(null) }
    var baseline by rememberSaveable(session.id) { mutableStateOf(session.configRevision) }
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Why the models could not be listed, apart from what any other control here reports.
    var catalogError by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    val traits = state.traits(session.provider)
    val connections = state.providerConnections(session.provider)
    val selectedConnection = connections.firstOrNull { it.id == connectionId }
    // A desktop that reports the stored tools choice also keeps options a change leaves out (sessions.toolsState).
    val toolsState = state.has("sessions.toolsState")
    val blocked = ConfigurationDraft.blockedReason(traits, toolsState)
    val canConfigure = session.canConfigure && state.supports("sessions.configure")
    val idle = session.status !in setOf("starting", "working", "waiting", "stopping") && session.agents.none(Agent::isActive)
    val conflict = baseline != session.configRevision
    LaunchedEffect(session.id, refresh, canConfigure) {
        if (!canConfigure || blocked != null) loading = false
        else {
            loading = true; catalogError = null
            try { val catalog = repository.modelCatalog(session.provider, sessionId = session.id, connectionId = ConfigurationDraft.catalogAccount(connectionId, session)); models = catalog.models; unlisted = catalog.unlisted }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { catalogError = failure.message }
            // A request replaced by a newer one leaves the newer one's progress alone.
            finally { if (isActive) loading = false }
        }
    }
    fun run(method: String, params: JsonObject, done: String? = null, closeAfter: Boolean = true) {
        submitting = true; error = null; feedback = null
        scope.launch {
            try {
                repository.mutate(method, params, session.title)
                repository.selectSession(session.id)
                if (closeAfter) close() else feedback = done
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { submitting = false }
        }
    }
    fun organize(pinned: Boolean? = null, archived: Boolean? = null) = run("sessions.organize", buildJsonObject {
        put("sessionId", session.id); put("expectedRevision", session.revision)
        pinned?.let { put("pinned", it) }; archived?.let { put("archived", it) }
    })
    val selected = models.firstOrNull { it.id == model.trim() }
    // A typed ID is accepted where the provider takes one (MOB-004); the desktop checks it again.
    val typed = traits.customModel
    val modelError = if (typed && selected == null) ModelIds.error(model) else null
    fun availability(option: ModelOption?) = ToolPolicy.availability(traits, option, session, toolsState)
    val tooling = availability(selected)
    val draft = ConfigurationDraft(model, effort, tools, connectionId.takeIf(String::isNotEmpty), providerOptions)
    // A model change keeps the tools choice unless the new model or route cannot use it; then the change is said first.
    fun keepTools(next: ToolAvailability) { if (tools && !next.available) { tools = false; toolsNotice = strings.getString(R.string.conversation_tools_turn_off, next.reason) } else toolsNotice = null }
    fun chooseModel(option: ModelOption) { model = option.id; effort = option.defaultEffort; keepTools(availability(option)) }
    AncillarySheetScaffold(
        title = stringResource(R.string.conversation_settings),
        subtitle = listOfNotNull(traits.label, session.project).filter(String::isNotBlank).joinToString(" · "),
        busy = submitting,
        onDismiss = close,
        action = if (canConfigure && blocked == null) ({
            Button({
                submitting = true; error = null
                signedReview(activity, repository, "sessions.configure", draft.params(session, baseline, partial = toolsState, routeRevision = state.has("sessions.routeRevision")), strings.getString(R.string.conversation_change_model), {
                    scope.launch { try { repository.selectSession(session.id); close() } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } finally { submitting = false } }
                }, { error = it; submitting = false }, label = session.title)
            }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target),
                enabled = !submitting && !loading && !conflict && draft.changes(session) &&
                    (selected != null || typed && modelError == null) && (!tools || tooling.available)) { Text(stringResource(R.string.conversation_review_apply)) }
        }) else null,
    ) {
        AncillarySection(stringResource(R.string.conversation_section), stringResource(R.string.conversation_organize_hint)) {
            session.connectionName?.let { Text(stringResource(R.string.conversation_connection, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (state.supports("sessions.rename")) {
                OutlinedTextField(title, { title = it.take(100) }, label = { Text(stringResource(R.string.conversation_title)) }, enabled = !submitting, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton({ run("sessions.rename", buildJsonObject { put("sessionId", session.id); put("title", title.trim()); put("expectedRevision", session.revision) }) },
                    enabled = !submitting && title.isNotBlank() && title.trim() != session.title, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.conversation_rename)) }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                if (state.supports("sessions.organize")) {
                    OutlinedButton({ organize(pinned = !session.pinned) }, enabled = !submitting, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(if (session.pinned) R.string.conversation_unpin else R.string.conversation_pin)) }
                    OutlinedButton({ organize(archived = !session.archived) }, enabled = !submitting, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(if (session.archived) R.string.conversation_unarchive else R.string.conversation_archive)) }
                }
                if (PhoneShortcuts.supported(activity)) OutlinedButton({ if (!PhoneShortcuts.pin(activity, session)) error = strings.getString(R.string.shortcut_refused) }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.shortcut_add)) }
            }
        }
            if (canConfigure && connections.isNotEmpty()) AncillarySection("Provider account", "Changing accounts keeps readable history but resets provider-specific continuation state.") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    // The desktop moves a conversation to a named account and not back, so the default is offered only where it is in use.
                    if (session.connectionId.isNullOrEmpty()) FilterChip(connectionId.isEmpty(), { connectionId = ""; refresh++; providerOptions = session.providerOptions }, { Text("Default") }, enabled = !submitting)
                    connections.forEach { connection -> FilterChip(
                        selected = connectionId == connection.id,
                        onClick = { if (connectionId != connection.id) { connectionId = connection.id; refresh++; providerOptions = if (connection.id == session.connectionId) session.providerOptions else JsonObject(emptyMap()) } },
                        label = { Text(connection.name + (connection.variant?.let { " · $it" } ?: "")) },
                        enabled = !submitting,
                    ) }
                }
            }
            if (state.supports("sessions.disconnect") && session.mode == "managed") {
                AncillarySection(stringResource(R.string.conversation_provider_connection), stringResource(R.string.conversation_provider_connection_hint)) {
                Text(if (idle) stringResource(R.string.conversation_disconnect_idle, session.provider.replaceFirstChar(Char::uppercase))
                    else stringResource(R.string.conversation_disconnect_busy), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton({ run("sessions.disconnect", buildJsonObject { put("sessionId", session.id) }, strings.getString(R.string.conversation_provider_disconnected), closeAfter = false) },
                    enabled = !submitting && idle, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.conversation_disconnect_provider)) }
                }
            }
            if (canConfigure && blocked != null) AncillarySection(stringResource(R.string.conversation_model)) { Text(blocked, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            else if (canConfigure) {
                AncillarySection(stringResource(R.string.conversation_model_tools), stringResource(R.string.conversation_model_tools_hint)) {
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    TextButton({ refresh++ }, enabled = !loading && !submitting, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.conversation_refresh_models)) }
                }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                // An endpoint that lists no models is not a failure: its model ID is typed instead.
                if (!loading && unlisted) Text(stringResource(R.string.conversation_unlisted_models), style = MaterialTheme.typography.bodySmall)
                else if (!loading && catalogError != null && typed) Text(stringResource(R.string.conversation_models_unavailable), style = MaterialTheme.typography.bodySmall)
                else if (!loading && models.isEmpty() && catalogError == null) Text(stringResource(if (typed) R.string.conversation_no_models_listed else R.string.conversation_no_models_loaded))
                if (!loading) catalogError?.let { AncillaryFeedback(it, error = true) }
                // The current model stays chosen even when a refreshed list leaves it out.
                session.model?.takeIf { it.isNotBlank() && !loading && models.isNotEmpty() && models.none { option -> option.id == it } }?.let {
                    Text(stringResource(R.string.conversation_current_model_missing, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                ModelChoices(models, model.trim(), !submitting && !loading) { option -> chooseModel(option) }
                if (session.provider == "openrouter" && model.isNotBlank() && state.supports("owner.connections.modelEndpoints")) ModelUpstreams(repository, connectionId.takeIf(String::isNotEmpty), model.trim(), providerOptions, !submitting) { providerOptions = it }
                if (typed) OutlinedTextField(model, { value -> model = value.take(ModelIds.MAX_LENGTH + 64); effort = ""; keepTools(availability(models.firstOrNull { it.id == value.trim() })) },
                    label = { Text(stringResource(R.string.conversation_model_id)) }, singleLine = true, enabled = !submitting, isError = modelError != null && model.isNotEmpty(),
                    supportingText = { Text(modelError?.takeIf { model.isNotEmpty() } ?: stringResource(R.string.conversation_model_id_hint)) }, modifier = Modifier.fillMaxWidth().semantics { contentDescription = strings.getString(R.string.conversation_model_id) })
                selected?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                    Text(stringResource(R.string.conversation_reasoning_effort))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { efforts.forEach { option ->
                        FilterChip(effort == option.id, { effort = option.id }, { Text(option.displayName) }, enabled = !submitting)
                    } }
                }
                if (tooling.applies) ListItem(headlineContent = { Text(stringResource(R.string.conversation_desktop_tools)) },
                    supportingContent = { Text(tooling.reason ?: stringResource(R.string.conversation_desktop_permissions)) },
                    // Tools that are on can always be turned off; turning them on needs a route and model that allow it.
                    trailingContent = { Switch(tools, { tools = it; toolsNotice = null }, enabled = !submitting && (tooling.available || tools)) })
                toolsNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
                if (conflict) {
                    Text(stringResource(R.string.conversation_settings_changed), color = MaterialTheme.colorScheme.error)
                    TextButton({ model = session.model.orEmpty(); effort = session.effort.orEmpty(); tools = session.tools; connectionId = session.connectionId.orEmpty(); providerOptions = session.providerOptions; toolsNotice = null; baseline = session.configRevision; refresh++ }) { Text(stringResource(R.string.conversation_reload_settings)) }
                }
                }
                ProviderOptions(traits.optionsSchema, providerOptions, selectedConnection?.variant, !submitting, if (selected?.efforts.isNullOrEmpty()) emptySet() else setOf("reasoningEffort")) { providerOptions = it }
            } else Text(session.toolsUnavailableReason?.takeIf { !session.canSend } ?: stringResource(R.string.conversation_model_changes_unavailable))
            val attachmentCount = session.draftAttachmentCount ?: 0
            if (attachmentCount > 0) Text(pluralStringResource(R.plurals.conversation_draft_attachments, attachmentCount, attachmentCount,
                stringResource(if (state.draftEditable(session)) R.string.conversation_review_attachments_here else R.string.conversation_review_attachments_pc)))
            if (state.owner) ConversationFolder(repository, state, session, { feedback = it }, { error = it })
            if (state.owner) ConversationTask(repository, state, activity, session)
            if (state.owner) PinnedSources(repository, state, activity, session)
            if (state.supports("sessions.behavior")) ConversationStyle(repository, session.id)
            if (state.supports("workflows.status")) ConversationWork(repository, state, session.id, activity)
            if (submitting) LinearProgressIndicator(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
            feedback?.let { AncillaryFeedback(it) }
            error?.let { AncillaryFeedback(it, error = true) }
    }
}

/**
 * W11: which style the conversation's next turn uses and where it is set. Styles are chosen on the
 * desktop. MOB-002: the answer is decoded into a model whose profile and posture are nullable, so the
 * desktop's JSON nulls (no style set) render as "No style" instead of failing.
 */
@Composable
private fun ConversationStyle(repository: PALRepository, sessionId: String) {
    var value by remember(sessionId) { mutableStateOf<ConversationBehavior?>(null) }
    LaunchedEffect(sessionId) {
        try { value = WireCodec.json.decodeFromJsonElement(ConversationBehavior.serializer(), repository.read("sessions.behavior", buildJsonObject { put("sessionId", sessionId) })) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { value = null }
    }
    value?.let { ConversationStyleContent(it) }
}

@Composable
internal fun ConversationStyleContent(behavior: ConversationBehavior) {
    AncillarySection(stringResource(R.string.conversation_style), stringResource(R.string.conversation_style_hint)) {
        val where = stringResource(when (behavior.source) {
            "session" -> R.string.conversation_style_session
            "project" -> R.string.conversation_style_project
            else -> R.string.conversation_style_personality
        })
        val profile = behavior.profile?.label?.takeIf(String::isNotBlank)
        Text(if (profile != null) stringResource(R.string.conversation_style_value, profile, where) else stringResource(R.string.conversation_no_style, where))
        behavior.posture?.takeIf { it.label.isNotBlank() }?.let { posture ->
            Text(stringResource(if (posture.pinned) R.string.conversation_posture_pinned else R.string.conversation_posture, posture.label), style = MaterialTheme.typography.bodySmall)
        }
        if (behavior.standingInstructions) Text(stringResource(R.string.conversation_standing_instructions), style = MaterialTheme.typography.bodySmall)
        behavior.warnings.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
    }
}

/**
 * W11: the conversation's results, with the provider's report kept apart from what PAL itself
 * verified, and the schedules made from it. A schedule can be paused here; turning it on again is a
 * desktop review.
 */
@Composable
private fun ConversationWork(repository: PALRepository, state: MobileState, sessionId: String, activity: FragmentActivity) {
    val scope = rememberCoroutineScope()
    var value by remember(sessionId) { mutableStateOf<JsonObject?>(null) }
    var open by rememberSaveable(sessionId) { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var scheduleToPause by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(sessionId, open, refresh) {
        if (open) {
            loading = true
            ownerCall { repository.read("workflows.status", buildJsonObject { put("sessionId", sessionId) }) as JsonObject }.onSuccess { value = it; error = null }.onFailure { error = it.message }
            loading = false
        }
    }
    AncillarySection(stringResource(R.string.conversation_results_schedules), stringResource(R.string.conversation_results_hint)) {
        TextButton({ if (open) refresh++ else open = true }, enabled = !loading, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(if (open) R.string.action_refresh else R.string.conversation_show)) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (open) {
            error?.let { AncillaryFeedback(it, error = true) }
            value?.let { shown -> ConversationWorkRows(shown, { resultId ->
                if (state.owner && state.supports("owner.results.verify"))
                    VerifyResult(repository, activity, sessionId, state.sessions.firstOrNull { it.id == sessionId }?.project, resultId, { refresh++ }, { error = it })
            }, if (state.supports("workflows.pauseSchedule")) ({ scheduleToPause = it }) else null, loading) }
        }
    }
    scheduleToPause?.let { schedule ->
        val label = schedule.str("label") ?: stringResource(R.string.conversation_this_schedule)
        AlertDialog(
            onDismissRequest = { scheduleToPause = null },
            title = { Text(stringResource(R.string.conversation_pause_schedule_question)) },
            text = { Text(stringResource(R.string.conversation_pause_schedule_body, label)) },
            confirmButton = { Button({
                scheduleToPause = null; loading = true
                scope.launch {
                    ownerCall { repository.mutate("workflows.pauseSchedule", buildJsonObject { put("sessionId", sessionId); put("scheduleId", schedule.str("id").orEmpty()); put("expectedRevision", schedule.str("revision").orEmpty()) }) }
                        .onSuccess { refresh++ }.onFailure { error = it.message; loading = false }
                }
            }) { Text(stringResource(R.string.conversation_pause)) } },
            dismissButton = { TextButton({ scheduleToPause = null }) { Text(stringResource(R.string.conversation_keep_running)) } },
        )
    }
}

/** What the provider reported and what PAL checked, the latest first, then the schedules made from this conversation. */
@Composable
internal fun ConversationWorkRows(value: JsonObject, verify: @Composable (String) -> Unit, pause: ((JsonObject) -> Unit)?, loading: Boolean = false) {
    val results = value.list("results"); val schedules = value.list("schedules")
    if (!loading && results.isEmpty() && schedules.isEmpty()) Text(stringResource(R.string.conversation_no_results), style = MaterialTheme.typography.bodySmall)
    results.forEachIndexed { index, result ->
        val gate = stringResource(when (result.str("gate")) {
            "passed" -> R.string.conversation_gate_passed
            "failed" -> R.string.conversation_gate_failed
            "incomplete" -> R.string.conversation_gate_incomplete
            else -> R.string.conversation_gate_none
        })
        Text(stringResource(R.string.conversation_result_summary, result.str("providerOutcome").orEmpty(), result.str("verification").orEmpty().replace('-', ' '), gate), style = MaterialTheme.typography.bodySmall)
        if (result.isTrue("editedSinceCheck")) Text(stringResource(R.string.conversation_files_changed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        result.str("uncertainty")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        // Only the latest result can be checked; the desktop refuses an older one.
        if (index == 0) result.str("id")?.let { verify(it) }
    }
    val time = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
    schedules.forEach { schedule ->
        val enabled = schedule.isTrue("enabled"); val next = schedule.num("next")
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
            Text(schedule.str("label").orEmpty())
            Text(if (!enabled) stringResource(R.string.conversation_schedule_paused) else if (next != null) stringResource(R.string.conversation_schedule_next, time.format(java.util.Date(next))) else stringResource(R.string.conversation_schedule_on), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (enabled && pause != null) TextButton({ pause(schedule) }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.conversation_pause_schedule)) }
        }
    }
}
