@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.fragment.app.FragmentActivity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ConfigurationDraft
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.ModelIds
import dev.otectus.pal.mobile.data.ToolAvailability
import dev.otectus.pal.mobile.data.ToolPolicy
import dev.otectus.pal.mobile.data.traits
import dev.otectus.pal.mobile.protocol.Agent
import dev.otectus.pal.mobile.protocol.ConversationBehavior
import dev.otectus.pal.mobile.protocol.ModelOption
import dev.otectus.pal.mobile.protocol.Session
import dev.otectus.pal.mobile.protocol.WireCodec
import kotlinx.coroutines.CancellationException
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
    var toolsNotice by remember(session.id) { mutableStateOf<String?>(null) }
    var baseline by rememberSaveable(session.id) { mutableStateOf(session.configRevision) }
    var refresh by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    val traits = state.traits(session.provider)
    // A desktop that reports the stored tools choice also keeps options a change leaves out (sessions.toolsState).
    val toolsState = state.has("sessions.toolsState")
    val blocked = ConfigurationDraft.blockedReason(traits, toolsState)
    val canConfigure = session.canConfigure && state.supports("sessions.configure")
    val idle = session.status !in setOf("starting", "working", "waiting", "stopping") && session.agents.none(Agent::isActive)
    val conflict = baseline != session.configRevision
    LaunchedEffect(session.id, refresh, canConfigure) {
        if (canConfigure && blocked == null) {
            loading = true; error = null
            try { val catalog = repository.modelCatalog(session.provider, sessionId = session.id); models = catalog.models; unlisted = catalog.unlisted }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { loading = false }
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
    val draft = ConfigurationDraft(model, effort, tools)
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
                    scope.launch { try { repository.selectSession(session.id); close() } finally { submitting = false } }
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
            if (state.supports("sessions.organize")) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedButton({ organize(pinned = !session.pinned) }, enabled = !submitting, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(if (session.pinned) R.string.conversation_unpin else R.string.conversation_pin)) }
                OutlinedButton({ organize(archived = !session.archived) }, enabled = !submitting, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(if (session.archived) R.string.conversation_unarchive else R.string.conversation_archive)) }
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
                else if (!loading && error != null && typed) Text(stringResource(R.string.conversation_models_unavailable), style = MaterialTheme.typography.bodySmall)
                else if (!loading && models.isEmpty() && error == null) Text(stringResource(if (typed) R.string.conversation_no_models_listed else R.string.conversation_no_models_loaded))
                // The current model stays chosen even when a refreshed list leaves it out.
                session.model?.takeIf { it.isNotBlank() && !loading && models.isNotEmpty() && models.none { option -> option.id == it } }?.let {
                    Text(stringResource(R.string.conversation_current_model_missing, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                models.forEach { option -> Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target)
                    .selectable(selected = model.trim() == option.id, enabled = !submitting && !loading, role = Role.RadioButton) { chooseModel(option) }
                    .padding(vertical = PALLayout.tight), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(model.trim() == option.id, null, enabled = !submitting && !loading)
                    Column(Modifier.weight(1f)) { Text(option.displayName); if (option.description.isNotBlank()) Text(option.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                } }
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
                    TextButton({ model = session.model.orEmpty(); effort = session.effort.orEmpty(); tools = session.tools; toolsNotice = null; baseline = session.configRevision; refresh++ }) { Text(stringResource(R.string.conversation_reload_settings)) }
                }
                }
            } else Text(session.toolsUnavailableReason?.takeIf { !session.canSend } ?: stringResource(R.string.conversation_model_changes_unavailable))
            val attachmentCount = session.draftAttachmentCount ?: 0
            if (attachmentCount > 0) Text(pluralStringResource(R.plurals.conversation_draft_attachments, attachmentCount, attachmentCount,
                stringResource(if (state.draftEditable(session)) R.string.conversation_review_attachments_here else R.string.conversation_review_attachments_pc)))
            if (state.supports("sessions.behavior")) ConversationStyle(repository, session.id)
            if (state.supports("workflows.status")) ConversationWork(repository, state, session.id)
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
            Text(stringResource(R.string.conversation_posture, posture.label) + if (posture.pinned) stringResource(R.string.conversation_posture_pinned) else "", style = MaterialTheme.typography.bodySmall)
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
private fun ConversationWork(repository: PALRepository, state: MobileState, sessionId: String) {
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
            runCatching { repository.read("workflows.status", buildJsonObject { put("sessionId", sessionId) }).jsonObject }
                .onSuccess { value = it; error = null }.onFailure { if (it is CancellationException) throw it; error = it.message }
            loading = false
        }
    }
    AncillarySection(stringResource(R.string.conversation_results_schedules), stringResource(R.string.conversation_results_hint)) {
        TextButton({ if (open) refresh++ else open = true }, enabled = !loading, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(if (open) R.string.conversation_refresh else R.string.conversation_show)) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (open) {
            error?.let { AncillaryFeedback(it, error = true) }
            val results = value?.get("results")?.jsonArray.orEmpty(); val schedules = value?.get("schedules")?.jsonArray.orEmpty()
            if (!loading && value != null && results.isEmpty() && schedules.isEmpty()) Text(stringResource(R.string.conversation_no_results), style = MaterialTheme.typography.bodySmall)
            results.map(JsonElement::jsonObject).forEach { result ->
                val provider = result["providerOutcome"]?.jsonPrimitive?.contentOrNull.orEmpty(); val verification = result["verification"]?.jsonPrimitive?.contentOrNull.orEmpty()
                val gate = stringResource(when (result["gate"]?.jsonPrimitive?.contentOrNull) {
                    "passed" -> R.string.conversation_gate_passed
                    "failed" -> R.string.conversation_gate_failed
                    "incomplete" -> R.string.conversation_gate_incomplete
                    else -> R.string.conversation_gate_none
                })
                Text(stringResource(R.string.conversation_result_summary, provider, verification.replace('-', ' '), gate), style = MaterialTheme.typography.bodySmall)
                if (result["editedSinceCheck"]?.jsonPrimitive?.booleanOrNull == true) Text(stringResource(R.string.conversation_files_changed), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
                result["uncertainty"]?.jsonPrimitive?.contentOrNull?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            val time = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
            schedules.map(JsonElement::jsonObject).forEach { schedule ->
                val enabled = schedule["enabled"]?.jsonPrimitive?.booleanOrNull == true
                val next = schedule["next"]?.jsonPrimitive?.longOrNull
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    Text(schedule["label"]?.jsonPrimitive?.contentOrNull.orEmpty())
                    Text(if (!enabled) stringResource(R.string.conversation_schedule_paused) else if (next != null) stringResource(R.string.conversation_schedule_next, time.format(java.util.Date(next))) else stringResource(R.string.conversation_schedule_on), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (enabled && state.supports("workflows.pauseSchedule")) TextButton({ scheduleToPause = schedule }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.conversation_pause_schedule)) }
                }
            }
        }
    }
    scheduleToPause?.let { schedule ->
        val label = schedule["label"]?.jsonPrimitive?.contentOrNull ?: stringResource(R.string.conversation_this_schedule)
        AlertDialog(
            onDismissRequest = { scheduleToPause = null },
            title = { Text(stringResource(R.string.conversation_pause_schedule_question)) },
            text = { Text(stringResource(R.string.conversation_pause_schedule_body, label)) },
            confirmButton = { Button({
                scheduleToPause = null; loading = true
                scope.launch {
                    runCatching { repository.mutate("workflows.pauseSchedule", buildJsonObject { put("sessionId", sessionId); put("scheduleId", schedule.getValue("id").jsonPrimitive.content); put("expectedRevision", schedule.getValue("revision").jsonPrimitive.content) }) }
                        .onSuccess { refresh++ }.onFailure { if (it is CancellationException) throw it; error = it.message; loading = false }
                }
            }) { Text(stringResource(R.string.conversation_pause)) } },
            dismissButton = { TextButton({ scheduleToPause = null }) { Text(stringResource(R.string.conversation_keep_running)) } },
        )
    }
}
