@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.traits
import dev.otectus.pal.mobile.protocol.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/*
 * Settings › This computer and the conversation sheet: the owner operations that had no screen. Each shows what it
 * changes on the desktop before a signed action; secrets go out once and never come back.
 */

/** Project folders: a name, a favorite and what new conversations start with. */
@Composable
internal fun ProjectsSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = LocalResources.current
    val scope = rememberOwnerScope()
    var projects by remember { mutableStateOf<List<JsonObject>?>(null) }
    var editing by remember { mutableStateOf<JsonObject?>(null) }
    fun load() = scope.launch { ownerCall { repository.request("owner.projects.list", buildJsonObject {}) as JsonObject }.onSuccess { projects = it.list("projects") }.onFailure { failure(it.message.orEmpty()) } }
    LaunchedEffect(Unit) { load() }
    Text(stringResource(R.string.extras_projects_hint), style = MaterialTheme.typography.bodySmall)
    if (projects?.isEmpty() == true) Text(stringResource(R.string.extras_projects_none))
    projects.orEmpty().forEach { project ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(project.str("name").orEmpty() + if (project.isTrue("favorite")) " ★" else "")
                Text(project.str("cwd").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val count = project.int("sessions") ?: 0
                Text(pluralStringResource(R.plurals.extras_project_sessions, count, count), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton({ editing = project }) { Text(stringResource(R.string.extras_project_edit)) }
        }
    }
    editing?.let { project -> ProjectEditor(state, project, { editing = null }) { saved ->
        editing = null
        scope.launch {
            ownerCall { signed(activity, repository, "owner.projects.save", saved, strings.getString(R.string.extras_project_action, saved.str("name"))) }
                .onSuccess { feedback(strings.getString(R.string.extras_project_saved)); load() }.onFailure { failure(it.message.orEmpty()) }
        }
    } }
}
@Composable
internal fun ProjectEditor(state: MobileState, project: JsonObject, dismiss: () -> Unit, save: (JsonObject) -> Unit) {
    val defaults = project.obj("defaults")
    var name by rememberSaveable { mutableStateOf(project.str("name").orEmpty()) }
    var favorite by rememberSaveable { mutableStateOf(project.isTrue("favorite")) }
    var provider by rememberSaveable { mutableStateOf(defaults?.str("provider") ?: "codex") }
    var model by rememberSaveable { mutableStateOf(defaults?.str("model").orEmpty()) }
    var effort by rememberSaveable { mutableStateOf(defaults?.str("effort").orEmpty()) }
    var tools by rememberSaveable { mutableStateOf(defaults?.isTrue("tools") == true) }
    var trusted by rememberSaveable { mutableStateOf(defaults?.isTrue("trusted") == true) }
    var temporary by rememberSaveable { mutableStateOf(defaults?.isTrue("temporary") == true) }
    val kind = state.traits(provider).kind
    val managed = kind != "cli"
    val valid = name.isNotBlank() && (kind != "api" || model.isNotBlank())
    ToolDialog(project.str("name").orEmpty(), dismiss, confirm = {
        Button({ save(buildJsonObject {
            put("cwd", project.str("cwd").orEmpty()); put("name", name.trim()); put("favorite", favorite); put("expectedRevision", project.str("revision") ?: "0")
            put("defaults", buildJsonObject {
                put("provider", provider); put("model", model.trim()); put("effort", if (managed) "" else effort.trim())
                put("tools", managed && tools && !temporary); put("trusted", trusted); put("temporary", temporary)
            })
        }) }, enabled = valid) { Text(stringResource(R.string.extras_project_save)) }
    }) {
        OutlinedTextField(name, { name = it.take(100) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_project_name)) })
        ToolCheck(stringResource(R.string.extras_project_favorite), favorite) { favorite = it }
        Text(stringResource(R.string.extras_project_provider), style = MaterialTheme.typography.labelMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { (state.providers.keys + provider).distinct().forEach { id -> FilterChip(provider == id, { provider = id; model = ""; effort = "" }, { Text(state.traits(id).label) }) } }
        OutlinedTextField(model, { model = it.take(512) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_project_model)) })
        if (!managed) OutlinedTextField(effort, { effort = it.take(32) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_project_effort)) })
        if (managed && !temporary) ToolCheck(stringResource(R.string.extras_project_tools), tools) { tools = it }
        ToolCheck(stringResource(R.string.extras_project_trusted), trusted) { trusted = it }
        ToolCheck(stringResource(R.string.extras_project_temporary), temporary) { temporary = it }
    }
}

/** This conversation's folder, and the folders themselves. */
@Composable
internal fun ConversationFolder(repository: PALRepository, state: MobileState, session: Session, feedback: (String) -> Unit, failure: (String?) -> Unit) {
    val strings = LocalResources.current
    val scope = rememberCoroutineScope()
    var folders by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var managing by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var renaming by remember { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    if (!state.supports("owner.folders.list") || !state.supports("owner.sessions.setFolder")) return
    fun work(block: suspend () -> Unit) { if (!busy) { busy = true; scope.launch { try { block() } catch (cancelled: CancellationException) { throw cancelled } catch (error: Exception) { failure(error.message) } finally { busy = false } } } }
    suspend fun load() { folders = repository.request("owner.folders.list", buildJsonObject {}).objects() }
    LaunchedEffect(session.id) { try { load() } catch (cancelled: CancellationException) { throw cancelled } catch (error: Exception) { failure(error.message) } }
    fun move(id: String?) = work {
        repository.mutate("owner.sessions.setFolder", buildJsonObject { put("sessionId", session.id); put("folderId", id?.let(::JsonPrimitive) ?: JsonNull); put("expectedRevision", session.revision) })
        repository.selectSession(session.id); feedback(strings.getString(R.string.extras_folder_moved))
    }
    AncillarySection(stringResource(R.string.extras_folder), stringResource(R.string.extras_folder_hint)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            FilterChip(session.folderName.isNullOrBlank(), { move(null) }, { Text(stringResource(R.string.extras_folder_none)) }, enabled = !busy)
            folders.forEach { folder -> FilterChip(folder.str("name") == session.folderName, { move(folder.str("id")) }, { Text(folder.str("name").orEmpty()) }, enabled = !busy) }
        }
        TextButton({ managing = !managing }) { Text(stringResource(R.string.extras_folder_manage)) }
        if (managing) {
            folders.forEach { folder -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(folder.str("name").orEmpty(), Modifier.weight(1f))
                TextButton({ renaming = folder }, enabled = !busy) { Text(stringResource(R.string.extras_folder_rename)) }
                ConfirmRemoval(stringResource(R.string.action_delete), folder.str("name").orEmpty(), stringResource(R.string.extras_folder_delete_body), !busy) { work {
                    repository.mutate("owner.folders.delete", buildJsonObject { put("id", folder.str("id").orEmpty()); put("expectedRevision", folder.str("revision") ?: "0") }); load()
                } }
            } }
            OutlinedTextField(name, { name = it.take(80) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_folder_new)) })
            TextButton({ val wanted = name.trim(); work { repository.mutate("owner.folders.save", buildJsonObject { put("name", wanted) }); name = ""; load() } }, enabled = !busy && name.isNotBlank()) { Text(stringResource(R.string.computer_add)) }
        }
    }
    renaming?.let { folder ->
        var next by rememberSaveable(folder.str("id")) { mutableStateOf(folder.str("name").orEmpty()) }
        ToolDialog(stringResource(R.string.extras_folder_rename), { renaming = null }, busy = busy, confirm = {
            Button({ work { repository.mutate("owner.folders.save", buildJsonObject { put("id", folder.str("id").orEmpty()); put("name", next.trim()); put("expectedRevision", folder.str("revision") ?: "0") }); renaming = null; load(); repository.selectSession(session.id) } }, enabled = !busy && next.isNotBlank()) { Text(stringResource(R.string.action_save)) }
        }) { OutlinedTextField(next, { next = it.take(80) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_folder)) }) }
    }
}

/** One reviewed result checked with a saved script of its project; the exact command is shown before it runs. */
@Composable
internal fun VerifyResult(repository: PALRepository, activity: FragmentActivity, sessionId: String, project: String?, resultId: String, done: () -> Unit, failure: (String?) -> Unit) {
    val strings = LocalResources.current
    val scope = rememberCoroutineScope()
    var open by rememberSaveable(resultId) { mutableStateOf(false) }
    var scripts by remember { mutableStateOf<List<JsonObject>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    TextButton({ open = true }, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.extras_verify)) }
    if (!open) return
    LaunchedEffect(Unit) {
        try { scripts = (repository.request("owner.settings.get", buildJsonObject {}) as JsonObject).obj("settings")?.list("scripts").orEmpty().filter { project == null || it.str("cwd") == project } }
        catch (cancelled: CancellationException) { throw cancelled } catch (failed: Exception) { error = failed.message }
    }
    ToolDialog(stringResource(R.string.extras_verify), { open = false }, busy = busy, error = error) {
        Text(stringResource(R.string.extras_verify_hint), style = MaterialTheme.typography.bodySmall)
        if (scripts?.isEmpty() == true) Text(stringResource(R.string.extras_verify_none))
        scripts.orEmpty().forEach { script ->
            Text(script.str("name").orEmpty(), style = MaterialTheme.typography.titleSmall)
            Text((listOf(script.str("executable").orEmpty()) + script.strings("args")).joinToString(" ") + "\n" + script.str("cwd").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            Button({ busy = true; error = null; scope.launch {
                try {
                    signed(activity, repository, "owner.results.verify", buildJsonObject { put("sessionId", sessionId); put("resultId", resultId); put("scriptId", script.str("id").orEmpty()); put("expectedScript", script); put("reviewed", true) }, strings.getString(R.string.extras_verify_action, script.str("name")))
                    open = false; done()
                } catch (cancelled: CancellationException) { throw cancelled } catch (failed: Exception) { error = failed.message; failure(failed.message) } finally { busy = false }
            } }, enabled = !busy) { Text(stringResource(R.string.extras_verify_run)) }
        }
    }
}

/** A setup of one's own: a model, what it may use, and standing instructions. Built-ins are saved as copies. */
@Composable
internal fun SetupEditor(state: MobileState, setup: JsonObject, dismiss: () -> Unit, save: (JsonObject) -> Unit) {
    val copy = setup.isTrue("builtin")
    var name by rememberSaveable { mutableStateOf(setup.str("name").orEmpty() + if (copy) " (copy)" else "") }
    var description by rememberSaveable { mutableStateOf(setup.str("description").orEmpty()) }
    var provider by rememberSaveable { mutableStateOf(setup.str("provider").orEmpty()) }
    var account by rememberSaveable { mutableStateOf(setup.str("connection").orEmpty()) }
    var model by rememberSaveable { mutableStateOf(setup.str("model").orEmpty()) }
    var instructions by rememberSaveable { mutableStateOf(setup.str("instructions").orEmpty()) }
    var families by rememberSaveable { mutableStateOf(listOf("files", "images", "analysis", "host").filter { setup.obj("families")?.isTrue(it) == true }) }
    ToolDialog(if (name.isBlank()) stringResource(R.string.extras_setup_new) else name, dismiss, confirm = {
        Button({ save(buildJsonObject {
            // Everything this editor does not show is kept as it was.
            setup.forEach { (key, value) -> if (key !in setOf("id", "revision", "builtin", "name", "description", "provider", "connection", "model", "instructions", "families")) put(key, value) }
            if (!copy) setup.str("id")?.let { put("id", it) }
            put("name", name.trim()); put("description", description.trim())
            if (provider.isNotEmpty()) put("provider", provider); if (account.isNotEmpty()) put("connection", account); if (model.isNotBlank()) put("model", model.trim()); if (instructions.isNotBlank()) put("instructions", instructions.trim())
            put("families", buildJsonObject { families.forEach { put(it, true) } })
        }) }, enabled = name.isNotBlank()) { Text(stringResource(R.string.extras_setup_save)) }
    }) {
        OutlinedTextField(name, { name = it.take(80) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_setup_name)) })
        OutlinedTextField(description, { description = it.take(400) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.extras_setup_description)) })
        Text(stringResource(R.string.extras_setup_provider), style = MaterialTheme.typography.labelMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            FilterChip(provider.isEmpty(), { provider = ""; account = "" }, { Text(stringResource(R.string.extras_setup_any)) })
            state.providers.keys.forEach { id -> FilterChip(provider == id, { if (provider != id) { provider = id; account = "" } }, { Text(state.traits(id).label) }) }
        }
        AccountChoice(state, provider, account, byName = true) { account = it }
        OutlinedTextField(model, { model = it.take(512) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_setup_model)) })
        Text(stringResource(R.string.extras_setup_families), style = MaterialTheme.typography.labelMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            listOf("files" to R.string.work_option_files, "images" to R.string.work_option_images, "analysis" to R.string.work_option_analysis, "host" to R.string.work_host_commands).forEach { (id, label) ->
                FilterChip(id in families, { families = if (id in families) families - id else families + id }, { Text(stringResource(label)) })
            }
        }
        if ("host" in families) Text(stringResource(R.string.work_host_commands_run_as_your_desktop_account_with), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        OutlinedTextField(instructions, { instructions = it.take(8000) }, Modifier.fillMaxWidth(), minLines = 3, label = { Text(stringResource(R.string.extras_setup_instructions)) })
    }
}

/** Which saved account of a provider; what was saved stays chosen even when it is no longer there. */
@Composable
internal fun AccountChoice(state: MobileState, provider: String, account: String, byName: Boolean, choose: (String) -> Unit) {
    val rows = (state.providers[provider] as? JsonObject)?.list("connections").orEmpty().map { (if (byName) it.str("name") else it.str("id")).orEmpty() to it.str("name").orEmpty() }
    if (provider.isEmpty() || rows.isEmpty() && account.isEmpty()) return
    Text(stringResource(R.string.extras_account), style = MaterialTheme.typography.labelMedium)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        FilterChip(account.isEmpty(), { choose("") }, { Text(stringResource(R.string.extras_account_default)) })
        rows.forEach { (key, name) -> FilterChip(account == key, { choose(key) }, { Text(name) }) }
        if (account.isNotEmpty() && rows.none { it.first == account }) FilterChip(true, { choose("") }, { Text(if (byName) stringResource(R.string.extras_account_missing, account) else stringResource(R.string.extras_account_gone)) })
    }
}

/** A tool server's secrets (write-only) and what it offers besides tools. */
@Composable
internal fun ToolServerDetails(repository: PALRepository, activity: FragmentActivity, server: JsonObject, feedback: (String) -> Unit, failure: (String) -> Unit, reload: () -> Unit) {
    val strings = LocalResources.current
    val scope = rememberOwnerScope()
    val id = server.str("id").orEmpty(); val name = server.str("name").orEmpty()
    var open by rememberSaveable(id) { mutableStateOf(false) }
    var prompts by remember(id) { mutableStateOf<List<JsonObject>?>(null) }
    var resources by remember(id) { mutableStateOf<List<JsonObject>?>(null) }
    TextButton({ open = !open }) { Text(stringResource(R.string.extras_server_details)) }
    if (!open) return
    Column(Modifier.fillMaxWidth().padding(start = PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        server.list("secrets").forEach { secret ->
            SecretField(secret.str("name").orEmpty(), secret.isTrue("set")) { value -> scope.launch {
                ownerCall { signed(activity, repository, "owner.extensions.secret", buildJsonObject { put("id", id); put("name", secret.str("name").orEmpty()); put("value", value?.let(::JsonPrimitive) ?: JsonNull) }, strings.getString(R.string.extras_secret_action, secret.str("name"), name)) }
                    .onSuccess { feedback(strings.getString(R.string.extras_secret_saved)); reload() }.onFailure { failure(it.message.orEmpty()) }
            } }
        }
        val offers = server.obj("offers")
        if (offers?.isTrue("prompts") == true) Offered(stringResource(R.string.extras_prompts), prompts) { scope.launch { ownerCall { val value = repository.request("owner.extensions.prompts", buildJsonObject { put("id", id) }); (value as? JsonObject)?.list("prompts") ?: value.objects() }.onSuccess { prompts = it }.onFailure { failure(it.message.orEmpty()) } } }
        if (offers?.isTrue("resources") == true) Offered(stringResource(R.string.extras_resources), resources) { scope.launch { ownerCall { val value = repository.request("owner.extensions.resources", buildJsonObject { put("id", id) }); (value as? JsonObject)?.list("resources") ?: value.objects() }.onSuccess { resources = it }.onFailure { failure(it.message.orEmpty()) } } }
    }
}
@Composable
private fun Offered(title: String, rows: List<JsonObject>?, load: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) { Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall); TextButton(load) { Text(stringResource(R.string.extras_load)) } }
    if (rows?.isEmpty() == true) Text(stringResource(R.string.extras_none_offered), style = MaterialTheme.typography.bodySmall)
    rows.orEmpty().take(60).forEach { row -> Text(listOfNotNull(row.str("title") ?: row.str("name"), row.str("uri"), row.str("description")).joinToString(" · "), style = MaterialTheme.typography.bodySmall, maxLines = 4, overflow = TextOverflow.Ellipsis) }
}
/** A secret can be replaced or cleared; what is stored is never shown. */
@Composable
internal fun SecretField(name: String, set: Boolean, save: (String?) -> Unit) {
    var value by remember(name) { mutableStateOf("") }
    Text(stringResource(if (set) R.string.extras_secret_set else R.string.extras_secret_missing, name), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
    OutlinedTextField(value, { value = it.take(8192) }, Modifier.fillMaxWidth(), singleLine = true, visualTransformation = PasswordVisualTransformation(), label = { Text(stringResource(R.string.extras_secret_value, name)) }, supportingText = { Text(stringResource(R.string.extras_secret_write_only)) })
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        TextButton({ save(value); value = "" }, enabled = value.isNotBlank()) { Text(stringResource(R.string.extras_secret_save)) }
        if (set) TextButton({ save(null) }) { Text(stringResource(R.string.extras_secret_clear)) }
    }
}
/** Credentials of custom tools that use one. The tools themselves are edited on the desktop. */
@Composable
internal fun CustomToolCredentials(repository: PALRepository, activity: FragmentActivity, feedback: (String) -> Unit, failure: (String) -> Unit) {
    val strings = LocalResources.current
    val scope = rememberOwnerScope()
    var tools by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    fun load() = scope.launch { ownerCall { repository.request("owner.settings.get", buildJsonObject {}) as JsonObject }.onSuccess { value -> tools = value.list("customToolCredentials") }.onFailure { failure(it.message.orEmpty()) } }
    LaunchedEffect(Unit) { load() }
    if (tools.isEmpty()) return
    Text(stringResource(R.string.extras_custom_tools), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
    tools.forEach { tool ->
        val name = tool.str("name").orEmpty()
        SecretField(name, tool.isTrue("credentialSet")) { value -> scope.launch {
            ownerCall { signed(activity, repository, "owner.customTools.credential", buildJsonObject { put("id", tool.str("id").orEmpty()); put("value", value?.let(::JsonPrimitive) ?: JsonNull) }, strings.getString(R.string.extras_custom_action, name)) }
                .onSuccess { feedback(strings.getString(R.string.extras_custom_saved)); load() }.onFailure { failure(it.message.orEmpty()) }
        } }
    }
}
/** Standing desktop grants, each with the folder and time it covers. */
@Composable
internal fun StandingGrants(repository: PALRepository, inspect: JsonObject?, feedback: (String) -> Unit, failure: (String) -> Unit, reload: () -> Unit) {
    val strings = LocalResources.current
    val scope = rememberOwnerScope()
    val grants = inspect?.list("grants") ?: return
    Text(stringResource(R.string.extras_grants), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
    if (grants.isEmpty()) Text(stringResource(R.string.extras_grants_none), style = MaterialTheme.typography.bodySmall)
    grants.forEach { grant -> Row(verticalAlignment = Alignment.CenterVertically) {
        val until = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(grant.num("expires") ?: 0))
        Text(stringResource(R.string.extras_grant_row, grant.str("category").orEmpty(), grant.str("cwd").orEmpty(), until), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        TextButton({ scope.launch { ownerCall { repository.mutate("owner.permissions.revokeGrant", buildJsonObject { put("category", grant.str("category").orEmpty()); put("cwd", grant.str("cwd").orEmpty()) }) }.onSuccess { feedback(strings.getString(R.string.extras_grant_revoked)); reload() }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.extras_grant_revoke)) }
    } }
}
/** The models one saved account lists now. */
@Composable
internal fun ConnectionModels(repository: PALRepository, connectionId: String, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var models by remember(connectionId) { mutableStateOf<List<JsonObject>?>(null) }
    TextButton({ scope.launch { ownerCall { (repository.request("owner.connections.models", buildJsonObject { put("id", connectionId) }) as JsonObject).list("models") }.onSuccess { models = it }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.extras_models_list)) }
    models?.let { rows ->
        Text(if (rows.isEmpty()) stringResource(R.string.extras_models_none) else pluralStringResource(R.plurals.extras_models_count, rows.size, rows.size), style = MaterialTheme.typography.labelMedium)
        rows.take(40).forEach { Text(it.str("displayName") ?: it.str("id").orEmpty(), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
    }
}
/** One short request through the LiteLLM bridge, so a deployment can be checked without starting a conversation. */
@Composable
internal fun BridgeTest(repository: PALRepository, state: MobileState, activity: FragmentActivity, connection: JsonObject, dismiss: () -> Unit) {
    val strings = LocalResources.current
    val scope = rememberCoroutineScope()
    var model by rememberSaveable { mutableStateOf("") }
    var text by rememberSaveable { mutableStateOf(strings.getString(R.string.extras_bridge_default)) }
    var result by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val session = state.sessions.firstOrNull { it.id == state.selectedSessionId }
    val project = session?.let { current -> state.projects.firstOrNull { it.id == current.projectId } }
    fun send(embed: Boolean) {
        val current = session ?: return
        busy = true; error = null; result = null
        scope.launch {
            try {
                val reply = signed(activity, repository, if (embed) "owner.providerBridge.embeddings" else "owner.providerBridge.chat", buildJsonObject {
                    put("sessionId", current.id); put("expectedSessionRevision", current.configRevision); put("expectedProjectRevision", project?.revision ?: "0")
                    put("connectionId", connection.str("id").orEmpty()); put("connectionRevision", connection.int("revision") ?: 1); put("model", model.trim())
                    if (embed) put("input", JsonArray(listOf(JsonPrimitive(text)))) else put("messages", JsonArray(listOf(buildJsonObject { put("role", "user"); put("content", text) })))
                }, strings.getString(R.string.extras_bridge_action, connection.str("name").orEmpty())) as JsonObject
                result = reply.int("dimension")?.let { strings.getString(R.string.extras_bridge_vector, it) } ?: reply.str("text") ?: reply.toString().take(2000)
            } catch (cancelled: CancellationException) { throw cancelled } catch (failed: Exception) { error = failed.message } finally { busy = false }
        }
    }
    ToolDialog(stringResource(R.string.extras_bridge_title, connection.str("name").orEmpty()), dismiss, busy = busy, error = error) {
        Text(stringResource(R.string.extras_bridge_hint), style = MaterialTheme.typography.bodySmall)
        if (session == null) Text(stringResource(R.string.extras_bridge_conversation), color = MaterialTheme.colorScheme.tertiary)
        OutlinedTextField(model, { model = it.take(512) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_bridge_model)) })
        OutlinedTextField(text, { text = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.extras_bridge_text)) })
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Button({ send(false) }, enabled = !busy && session != null && model.isNotBlank() && text.isNotBlank()) { Text(stringResource(R.string.extras_bridge_chat)) }
            OutlinedButton({ send(true) }, enabled = !busy && session != null && model.isNotBlank() && text.isNotBlank()) { Text(stringResource(R.string.extras_bridge_embed)) }
        }
        result?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
    }
}
/** Which engine reads replies aloud on the desktop, with the voices a hosted one offers. */
@Composable
internal fun DesktopVoice(repository: PALRepository, values: JsonObject, patch: (String, JsonObjectBuilder.() -> Unit) -> Unit, failure: (String) -> Unit) {
    val strings = LocalResources.current
    val scope = rememberOwnerScope()
    val engine = values.str("ttsProvider") ?: "local"
    val hosted = values.obj("hostedVoice")
    var voices by remember(engine) { mutableStateOf<List<JsonObject>?>(null) }
    var region by rememberSaveable(engine) { mutableStateOf(hosted?.str("region").orEmpty()) }
    var language by rememberSaveable(engine) { mutableStateOf(hosted?.str("language").orEmpty()) }
    val title = strings.getString(R.string.extras_voice)
    Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.labelLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        listOf("local" to strings.getString(R.string.extras_voice_local), "elevenlabs" to "ElevenLabs", "indextts" to "IndexTTS", "openai" to "OpenAI", "google" to "Gemini", "google_cloud" to "Google Cloud", "azure_speech" to "Azure Speech", "xai" to "Grok").forEach { (id, label) ->
            FilterChip(engine == id, { patch(title) { put("ttsProvider", id) } }, { Text(label) })
        }
    }
    if (engine == "google_cloud" || engine == "azure_speech") {
        if (engine == "azure_speech") OutlinedTextField(region, { region = it.trim().take(64) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_voice_region)) })
        OutlinedTextField(language, { language = it.trim().take(32) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.extras_voice_language)) })
        fun settings(voice: String? = null) = buildJsonObject {
            hosted?.forEach { (key, value) -> if (key !in setOf("region", "language", "voice")) put(key, value) }
            if (region.isNotBlank()) put("region", region); if (language.isNotBlank()) put("language", language); (voice ?: hosted?.str("voice"))?.let { put("voice", it) }
        }
        TextButton({ scope.launch { ownerCall { val value = repository.request("owner.voice.hostedVoices", buildJsonObject { put("provider", engine); put("settings", settings()) }); (value as? JsonObject)?.list("voices") ?: value.objects() }.onSuccess { voices = it }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.extras_voice_browse)) }
        if (voices?.isEmpty() == true) Text(stringResource(R.string.extras_voice_none))
        voices.orEmpty().filter { language.isBlank() || it.toString().contains(language, ignoreCase = true) }.take(30).forEach { voice ->
            val id = voice.str("id") ?: voice.str("name").orEmpty()
            TextButton({ patch(title) { put("hostedVoice", settings(id)) } }) { Text(stringResource(R.string.extras_voice_use, voice.str("label") ?: voice.str("name") ?: id)) }
        }
    }
}
/** Work running on the desktop in the background, with a way to stop each. */
@Composable
internal fun RunningJobs(repository: PALRepository, state: MobileState, failure: (String) -> Unit) {
    val scope = rememberOwnerScope()
    var jobs by remember { mutableStateOf<List<JsonObject>?>(null) }
    if (!state.supports("owner.jobs.list")) return
    LaunchedEffect(Unit) { while (true) {
        try { jobs = (repository.request("owner.jobs.list", buildJsonObject {}) as JsonObject).list("jobs") } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { jobs = null }
        delay(5_000)
    } }
    val rows = jobs ?: return
    Text(stringResource(R.string.extras_jobs), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
    if (rows.isEmpty()) Text(stringResource(R.string.extras_jobs_none), style = MaterialTheme.typography.bodySmall)
    rows.forEach { job -> Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(job.str("label").orEmpty())
            job.obj("progress")?.let { progress -> val total = progress.num("total") ?: 0; if (total > 0) LinearProgressIndicator({ (progress.num("done") ?: 0).toFloat() / total }, Modifier.fillMaxWidth()) }
        }
        TextButton({ scope.launch { ownerCall { repository.mutate("owner.jobs.cancel", buildJsonObject { put("id", job.str("id").orEmpty()) }) }.onSuccess { jobs = rows - job }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.extras_job_stop)) }
    } }
}
/** The models installed on the desktop's Ollama, with the download in progress. */
@Composable
internal fun LocalModelRows(repository: PALRepository, activity: FragmentActivity, value: JsonObject?, feedback: (String) -> Unit, failure: (String) -> Unit, reload: () -> Unit) {
    val strings = LocalResources.current
    val scope = rememberOwnerScope()
    value?.obj("pull")?.takeIf { !it.isTrue("done") }?.let { pull ->
        val total = pull.num("total") ?: 0
        Text(stringResource(R.string.extras_pull_progress, pull.str("model").orEmpty(), pull.str("status").orEmpty()))
        if (total > 0) LinearProgressIndicator({ (pull.num("completed") ?: 0).toFloat() / total }, Modifier.fillMaxWidth()) else LinearProgressIndicator(Modifier.fillMaxWidth())
        TextButton({ scope.launch { ownerCall { repository.mutate("owner.models.cancelPull", buildJsonObject {}) }.onSuccess { feedback(strings.getString(R.string.extras_pull_stopped)); reload() }.onFailure { failure(it.message.orEmpty()) } } }) { Text(stringResource(R.string.extras_pull_cancel)) }
        LaunchedEffect(pull.toString()) { delay(2_000); reload() }
    }
    value?.obj("space")?.let { ModelSpace(it) }
    value?.list("models").orEmpty().forEach { model ->
        val name = model.str("name") ?: model.str("model").orEmpty()
        val blocking = (model["inUse"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(name + " · " + byteSize(model.num("size")) + if (model.isTrue("loaded")) stringResource(R.string.computer_loaded) else "", style = MaterialTheme.typography.bodySmall)
                if (blocking.isNotEmpty()) Text(stringResource(R.string.extras_model_in_use, blocking.joinToString(" ")), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!model.isTrue("remote")) ConfirmRemoval(stringResource(R.string.action_delete), name, stringResource(R.string.extras_model_delete_body), blocking.isEmpty()) { scope.launch {
                ownerCall { signed(activity, repository, "owner.models.delete", buildJsonObject { put("model", name); put("confirmed", true) }, strings.getString(R.string.extras_model_delete_action, name)) }
                    .onSuccess { feedback(strings.getString(R.string.extras_model_deleted, name)); reload() }.onFailure { failure(it.message.orEmpty()) }
            } }
        }
    }
}

/** Free space where the desktop keeps its models: a warning only, a download is never refused for it. */
@Composable
internal fun ModelSpace(space: JsonObject) {
    val low = space.str("state") == "low"
    Text(when (space.str("state")) { "low" -> stringResource(R.string.extras_space_low, byteSize(space.num("free"))); "ok" -> stringResource(R.string.extras_space_free, byteSize(space.num("free"))); else -> stringResource(R.string.extras_space_unknown) },
        style = MaterialTheme.typography.bodySmall, color = if (low) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** What a question would find in a collection, where and why. No model is asked. */
@Composable
internal fun CollectionTrial(repository: PALRepository, id: String, name: String, dismiss: () -> Unit) {
    val scope = rememberOwnerScope()
    var question by rememberSaveable { mutableStateOf("") }
    var answer by remember { mutableStateOf<JsonObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ToolDialog(stringResource(R.string.kb_try), dismiss, { TextButton({ scope.launch { busy = true; error = null; ownerCall { repository.read("owner.collections.search", buildJsonObject { put("id", id); put("query", question.trim()) }) as JsonObject }.onSuccess { answer = it }.onFailure { error = it.message }; busy = false } }, enabled = !busy && question.trim().length > 1) { Text(stringResource(R.string.kb_search)) } }, busy, error) {
        Text(name, style = MaterialTheme.typography.titleSmall)
        Text(stringResource(R.string.kb_try_hint), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(question, { question = it.take(1000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.kb_question)) })
        answer?.let { TrialResults(it) }
    }
}
@Composable
internal fun ColumnScope.TrialResults(answer: JsonObject) {
    val results = answer.list("results")
    Text(if (results.isEmpty()) stringResource(R.string.kb_nothing) else stringResource(R.string.kb_found, results.size, answer.int("candidates") ?: 0, answer.str("mode").orEmpty()), style = MaterialTheme.typography.bodySmall)
    results.forEach { row -> AncillarySection(row.str("source").orEmpty() + row.str("location").orEmpty().let { if (it.isBlank()) "" else " · $it" }) {
        Text(row.str("excerpt").orEmpty(), style = MaterialTheme.typography.bodySmall, maxLines = 8, overflow = TextOverflow.Ellipsis)
        if (row.isTrue("weak")) Text(stringResource(R.string.kb_weak), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        row.str("conflict")?.takeIf { it.isNotBlank() }?.let { Text(stringResource(R.string.kb_conflict, it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
        if (row.isTrue("stale")) Text(stringResource(R.string.kb_stale), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
    } }
}

/** The project task a conversation works on. Its memories come first here; the project still sees them all. */
@Composable
internal fun ConversationTask(repository: PALRepository, state: MobileState, activity: FragmentActivity, session: Session) {
    if (!state.supports("owner.sessions.tasks") || session.mode != "managed") return
    val scope = rememberOwnerScope(); val strings = androidx.compose.ui.platform.LocalResources.current
    var tasks by remember(session.id) { mutableStateOf<List<JsonObject>?>(null) }
    var error by remember(session.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(session.id) { ownerCall { repository.read("owner.sessions.tasks", buildJsonObject { put("sessionId", session.id) }) as JsonObject }.onSuccess { tasks = it.list("tasks") }.onFailure { error = it.message } }
    if (tasks.isNullOrEmpty() && session.task == null && error == null) return
    fun workOn(id: String?) = scope.launch {
        ownerCall { signed(activity, repository, "owner.sessions.workOn", buildJsonObject { put("sessionId", session.id); put("taskId", id?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull) }, strings.getString(R.string.extras_task)) }.onSuccess { error = null }.onFailure { error = it.message }
    }
    TaskChoice(session.task, tasks.orEmpty(), error) { workOn(it) }
}

@Composable
internal fun TaskChoice(current: dev.otectus.pal.mobile.protocol.SessionTask?, tasks: List<JsonObject>, error: String?, workOn: (String?) -> Unit) {
    var choosing by remember { mutableStateOf(false) }
    AncillarySection(stringResource(R.string.extras_task), stringResource(R.string.extras_task_hint)) {
        error?.let { AncillaryFeedback(it, error = true) }
        Text(current?.text ?: stringResource(R.string.extras_task_none))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            if (tasks.isNotEmpty()) Box {
                OutlinedButton({ choosing = true }) { Text(stringResource(R.string.extras_task_choose)) }
                DropdownMenu(choosing, { choosing = false }) { tasks.forEach { task -> DropdownMenuItem({ Text(task.str("text").orEmpty(), maxLines = 2, overflow = TextOverflow.Ellipsis) }, { choosing = false; workOn(task.str("id")) }) } }
            }
            if (current != null) TextButton({ workOn(null) }) { Text(stringResource(R.string.extras_task_stop)) }
        }
    }
}

/** What was worked on in the desktop's approved folders, while its owner keeps it, and erasing it. */
@Composable
internal fun WorkspaceHistorySection(repository: PALRepository, state: MobileState, activity: FragmentActivity, saved: (String) -> Unit, failed: (String) -> Unit) {
    if (!state.supports("owner.workspace.history")) { Text(stringResource(R.string.history_update)); return }
    val scope = rememberOwnerScope(); val strings = androidx.compose.ui.platform.LocalResources.current
    var info by remember { mutableStateOf<JsonObject?>(null) }; var project by remember { mutableStateOf<String?>(null) }; var revision by remember { mutableIntStateOf(0) }
    LaunchedEffect(project, revision) { ownerCall { repository.read("owner.workspace.history", buildJsonObject { put("limit", 200); project?.let { put("project", it) } }) as JsonObject }.onSuccess { info = it }.onFailure { failed(it.message.orEmpty()) } }
    WorkspaceHistoryList(info, project, { project = it }) {
        scope.launch { ownerCall { signed(activity, repository, "owner.workspace.historyErase", buildJsonObject { project?.let { put("project", it) } ?: put("all", true) }, strings.getString(R.string.history_erase_action)) as JsonObject }
            .onSuccess { saved(strings.getQuantityString(R.plurals.history_erased, (it.num("removed") ?: 0).toInt(), (it.num("removed") ?: 0).toInt())); revision++ }.onFailure { failed(it.message.orEmpty()) } }
    }
}
@Composable
internal fun WorkspaceHistoryList(info: JsonObject?, project: String?, choose: (String?) -> Unit, erase: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    if (info == null) { LinearProgressIndicator(Modifier.fillMaxWidth()); return }
    val records = (info.num("records") ?: 0).toInt(); val folders = info.strings("folders")
    Text(if (info.isTrue("enabled")) pluralStringResource(R.plurals.history_kept, (info.num("days") ?: 7).toInt(), (info.num("days") ?: 7).toInt()) else stringResource(R.string.history_off), color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (folders.size > 1) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        FilterChip(project == null, { choose(null) }, { Text(stringResource(R.string.history_every_folder)) })
        folders.forEach { path -> FilterChip(project == path, { choose(path) }, { Text(path.substringAfterLast('/')) }) }
    }
    if (records == 0) Text(stringResource(R.string.history_none))
    val zone = java.time.ZoneId.systemDefault(); var last = ""
    info.list("items").forEach { row ->
        val at = java.time.Instant.ofEpochMilli(row.num("at") ?: 0).atZone(zone); val day = at.format(java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.FULL))
        if (day != last) { last = day; Text(day, Modifier.padding(top = PALLayout.small).semantics { heading() }, style = MaterialTheme.typography.titleSmall) }
        val place = row.str("item")?.takeIf { it.isNotEmpty() } ?: row.str("project").orEmpty().substringAfterLast('/')
        val count = (row.num("count") ?: 0).toInt(); val seconds = (row.num("seconds") ?: 0).toInt(); val broken = (row.num("failed") ?: 0).toInt()
        Text(when (row.str("kind")) { "command" -> stringResource(R.string.history_commands_in, place); "focus" -> stringResource(R.string.history_worked_in, place); else -> place }, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(listOfNotNull(at.format(java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT)), if (count > 0) pluralStringResource(when (row.str("kind")) { "document" -> R.plurals.history_saves; "command" -> R.plurals.history_commands; else -> R.plurals.history_changes }, count, count) else null, if (broken > 0) pluralStringResource(R.plurals.history_failed, broken, broken) else null, if (seconds >= 60) stringResource(R.string.history_minutes, seconds / 60) else null).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (records > 0) TextButton({ confirm = true }) { Text(stringResource(if (project == null) R.string.history_erase_all else R.string.history_erase_folder), color = MaterialTheme.colorScheme.error) }
    if (confirm) AlertDialog({ confirm = false }, title = { Text(stringResource(if (project == null) R.string.history_erase_all else R.string.history_erase_folder)) }, text = { Text(stringResource(R.string.history_erase_body)) },
        confirmButton = { TextButton({ confirm = false; erase() }) { Text(stringResource(R.string.history_erase), color = MaterialTheme.colorScheme.error) } }, dismissButton = { TextButton({ confirm = false }) { Text(stringResource(R.string.action_cancel)) } })
}
