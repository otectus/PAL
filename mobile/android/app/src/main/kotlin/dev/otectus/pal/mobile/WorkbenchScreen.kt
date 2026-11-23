@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.ui.res.stringResource
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

/**
 * The Workbench on the phone (PAL Everywhere §8): the same Files, reviewed Changes, Library and Runs the desktop's
 * Workbench shows for a conversation, plus Terminal. Everything runs on the desktop: the phone shows desktop paths,
 * sends edits through the same change engine and moves bytes as verified transfers. A phone with limited access,
 * or a desktop without these features, gets a literal explanation instead of controls.
 */
private enum class WorkTab(val label: Int) { Files(R.string.work_tab_files), Changes(R.string.work_tab_changes), Library(R.string.work_tab_library), Runs(R.string.work_tab_runs), Research(R.string.work_tab_research), Canvas(R.string.work_tab_canvas), Notes(R.string.work_tab_notes), Terminal(R.string.work_tab_terminal) }

@Composable
internal fun WorkScreen(repository: PALRepository, state: MobileState, activity: FragmentActivity, preferredSessionId: String?, openOwnerSection: (String, String?) -> Unit) {
    // Keep navigation and each pane's saveable state mounted while a signed action briefly re-authenticates.
    // Otherwise starting a terminal can recreate Work at the default Files tab before the action result arrives.
    var tab by rememberSaveable { mutableStateOf(WorkTab.Files.name) }
    val tabStates = rememberSaveableStateHolder()
    val terminalRetention = remember { TerminalRetention() }
    val current = WorkTab.entries.find { it.name == tab } ?: WorkTab.Files
    val conversations = state.sessions.filter { !it.archived }
    var sessionId by rememberSaveable { mutableStateOf(preferredSessionId ?: conversations.firstOrNull()?.id.orEmpty()) }
    LaunchedEffect(preferredSessionId) { if (preferredSessionId != null) sessionId = preferredSessionId }
    val online = state.connection is ConnectionState.Online
    if (!online) return RecoveryPage(state, repository::retry)
    if (!state.has("owner.policy.v1")) return WorkNotice(stringResource(R.string.work_update_pal_on_your_desktop), stringResource(R.string.work_this_desktop_does_not_offer_the_workbench_to))
    if (!state.owner) {
        val role = (state.connection as? ConnectionState.Online)?.role
        return if (role == "observer") WorkNotice(stringResource(R.string.work_observer_read_only), stringResource(R.string.work_this_phone_can_read_its_allowed_conversations_and))
        else WorkNotice(stringResource(R.string.computer_limited_access), stringResource(R.string.work_this_phone_can_use_only_the_projects_and))
    }
    val session = state.sessions.firstOrNull { it.id == sessionId }
    Column(Modifier.fillMaxSize()) {
        PrimaryScrollableTabRow(selectedTabIndex = current.ordinal, edgePadding = PALLayout.small) {
            WorkTab.entries.forEach { item -> Tab(current == item, { tab = item.name }, text = { Text(stringResource(item.label)) }) }
        }
        if (current != WorkTab.Terminal) Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { ConversationPicker(state, sessionId) { sessionId = it } }
            if (session != null) ConversationActions(repository, activity, session,
                openSetup = { openOwnerSection("Working setups", session.id) }, select = { sessionId = it })
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                current == WorkTab.Terminal -> tabStates.SaveableStateProvider("terminal:${session?.project.orEmpty()}") { TerminalScreen(repository, state, activity, session?.project, terminalRetention) }
                session == null -> WorkNotice(stringResource(R.string.computer_choose_a_conversation), stringResource(R.string.work_files_changes_the_library_and_runs_belong_to))
                else -> tabStates.SaveableStateProvider(if (current == WorkTab.Notes) "notes:${session?.project.orEmpty()}" else "$sessionId:${current.name}") {
                    when (current) {
                        WorkTab.Files -> FilesTab(repository, state, activity, sessionId)
                        WorkTab.Changes -> ChangesTab(repository, state, activity, sessionId)
                        WorkTab.Library -> LibraryTab(repository, state, activity, sessionId)
                        WorkTab.Runs -> RunsTab(repository, state, activity, sessionId)
                        WorkTab.Research -> ResearchTab(repository, state, activity, sessionId) { openOwnerSection("Desktop settings", sessionId) }
                        WorkTab.Canvas -> CanvasTab(repository, state, activity, sessionId)
                        WorkTab.Notes -> NotesTab(repository, state, sessionId)
                        WorkTab.Terminal -> Unit
                    }
                }
            }
        }
    }
}

@Composable
internal fun WorkNotice(title: String, detail: String) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(PALLayout.sectionGap),
        verticalArrangement = Arrangement.spacedBy(PALLayout.small, Alignment.CenterVertically)) {
        Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
        Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ConversationPicker(state: MobileState, sessionId: String, select: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val session = state.sessions.firstOrNull { it.id == sessionId }
    Box(Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap, vertical = PALLayout.small)) {
        OutlinedButton({ open = true }, Modifier.fillMaxWidth()) {
            Text(session?.let { "${it.title} · ${it.project.orEmpty().substringAfterLast('/')}" } ?: stringResource(R.string.computer_choose_a_conversation), Modifier.weight(1f), maxLines = 1)
            Icon(Icons.Default.ArrowDropDown, null)
        }
        DropdownMenu(open, { open = false }) {
            state.sessions.filter { !it.archived }.take(60).forEach { item ->
                DropdownMenuItem(text = { Text("${item.title} · ${item.project.orEmpty().substringAfterLast('/')}", maxLines = 1) }, onClick = { open = false; select(item.id) })
            }
        }
    }
}

/** What the conversation's model may use: the same switches as the desktop Workbench, changed with a signed action. */
@Composable
private fun ModelFamilies(repository: PALRepository, activity: FragmentActivity, session: dev.otectus.pal.mobile.protocol.Session) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var families by remember(session.id) { mutableStateOf<Set<String>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var expanded by rememberSaveable(session.id) { mutableStateOf(true) }
    var confirmHost by remember { mutableStateOf(false) }
    var hostAutomatic by remember { mutableStateOf<Boolean?>(null) }
    var hostRuleLoading by remember { mutableStateOf(false) }
    var configRevision by remember(session.id) { mutableStateOf(session.configRevision) }
    var loadAttempt by remember(session.id) { mutableIntStateOf(0) }
    LaunchedEffect(session.id, session.configRevision, loadAttempt) {
        error = null
        runCatching { repository.request("sessions.get", buildJsonObject { put("sessionId", session.id) }) as JsonObject }
            .onSuccess { dto ->
                families = (dto["capabilities"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }?.toSet() ?: emptySet()
                configRevision = dto.str("configRevision") ?: session.configRevision
                error = null
            }
            .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it else error = it.message ?: strings.getString(R.string.model_access_failed) }
    }
    val current = families
    if (current == null) {
        if (error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        else {
            AncillaryFeedback(error.orEmpty(), error = true)
            TextButton({ loadAttempt++ }) { Text(stringResource(R.string.action_retry)) }
        }
        return
    }
    fun update(family: String, label: String) = scope.launch {
        val next = if (family in current) current - family else current + family
        runCatching { signed(activity, repository, "owner.sessions.capabilities", buildJsonObject {
            put("sessionId", session.id); put("expectedConfigRevision", configRevision)
            put("capabilities", buildJsonObject { listOf("files", "images", "analysis", "host").forEach { put(it, it in next) } })
        }, if (family in current) strings.getString(R.string.work_stop_offering, label) else strings.getString(R.string.work_offer_to_the_model, label)) }.onSuccess { result ->
            families = next
            (result as? JsonObject)?.str("configRevision")?.let { configRevision = it }
            error = null
        }.onFailure { error = it.message }
    }
    fun reviewHost() {
        confirmHost = true
        hostAutomatic = null
        hostRuleLoading = true
        scope.launch {
            runCatching { repository.request("owner.permissions.get", buildJsonObject { put("sessionId", session.id) }) as JsonObject }
                .onSuccess { hostAutomatic = it.list("effective").firstOrNull()?.isTrue("cli") }
                .onFailure { error = it.message }
            hostRuleLoading = false
        }
    }
    Column(Modifier.padding(horizontal = PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
        OutlinedButton({ expanded = !expanded }, Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.work_model_access_on, current.size), Modifier.weight(1f))
            Icon(if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown, null)
        }
        if (expanded) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.Center) {
        listOf("files" to stringResource(R.string.work_option_files), "images" to stringResource(R.string.work_option_images), "analysis" to stringResource(R.string.work_option_analysis), "host" to strings.getString(R.string.work_host_commands)).forEach { (family, label) ->
                FilterChip(family in current, { if (family == "host" && family !in current) reviewHost() else update(family, label) }, { Text(label) })
            }
        }
        if ("host" in current) Text(stringResource(R.string.work_host_commands_run_as_your_desktop_account_with), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
    if (confirmHost) AlertDialog(
        onDismissRequest = { confirmHost = false },
        title = { Text(stringResource(R.string.work_run_commands_as_your_desktop_account)) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(stringResource(R.string.work_this_lets_the_model_in_run_commands_with, session.title))
            Text(when { hostRuleLoading -> stringResource(R.string.work_checking_this_conversations_approval_rule); hostAutomatic == true -> stringResource(R.string.work_current_rule_commands_may_run_automatically_under_this); hostAutomatic == false -> stringResource(R.string.work_current_rule_each_command_asks_before_it_runs); else -> stringResource(R.string.work_the_current_approval_rule_could_not_be_read) }, fontWeight = FontWeight.SemiBold)
        } },
        confirmButton = { Button({ confirmHost = false; update("host", strings.getString(R.string.work_host_commands)) }, enabled = !hostRuleLoading) { Text(stringResource(R.string.work_turn_on_host_commands)) } },
        dismissButton = { TextButton({ confirmHost = false }) { Text(stringResource(R.string.action_cancel)) } },
    )
}

/** Export (share as Markdown), branch and delete: the desktop's conversation actions, for this conversation. */
@Composable
private fun ConversationActions(repository: PALRepository, activity: FragmentActivity, session: dev.otectus.pal.mobile.protocol.Session, openSetup: () -> Unit, select: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    var modelAccess by rememberSaveable(session.id) { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    if (modelAccess) AncillarySheetScaffold(stringResource(R.string.work_model_access), session.title, busy = false, onDismiss = { modelAccess = false }) {
        ModelFamilies(repository, activity, session)
    }
    var error by remember { mutableStateOf<String?>(null) }
    Box {
        IconButton({ open = true }) { Icon(Icons.Default.MoreVert, stringResource(R.string.conversation_actions)) }
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem(text = { Text(stringResource(R.string.work_apply_working_setup)) }, onClick = { open = false; openSetup() })
            if (session.provider in setOf("ollama", "openai", "anthropic", "google", "compatible"))
                DropdownMenuItem(text = { Text(stringResource(R.string.work_model_access)) }, onClick = { open = false; modelAccess = true })
            DropdownMenuItem(text = { Text(stringResource(R.string.work_share_as_markdown)) }, onClick = { open = false; scope.launch {
                runCatching { repository.request("owner.sessions.export", buildJsonObject { put("sessionId", session.id) }) as JsonObject }.onSuccess { exported ->
                    val intent = android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/markdown").putExtra(android.content.Intent.EXTRA_TEXT, exported.str("text").orEmpty()).putExtra(android.content.Intent.EXTRA_SUBJECT, exported.str("filename") ?: session.title)
                    context.startActivity(android.content.Intent.createChooser(intent, strings.getString(R.string.work_share_conversation)))
                }.onFailure { error = it.message }
            } })
            DropdownMenuItem(text = { Text(stringResource(R.string.work_branch_with_its_last_messages)) }, onClick = { open = false; scope.launch {
                runCatching {
                    val preview = repository.request("sessions.handoffPreview", buildJsonObject { put("sessionId", session.id) }) as JsonObject
                    signed(activity, repository, "owner.sessions.branch", buildJsonObject { put("sessionId", session.id); put("text", preview.str("draft").orEmpty().ifBlank { strings.getString(R.string.work_continue_from, session.title) }) }, strings.getString(R.string.work_branch, session.title)) as JsonObject
                }.onSuccess { branch -> branch.str("id")?.let(select) }.onFailure { error = it.message }
            } })
            DropdownMenuItem(text = { Text(stringResource(R.string.work_delete_conversation)) }, onClick = { open = false; confirmDelete = true })
        }
    }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    if (confirmDelete) AlertDialog({ confirmDelete = false }, title = { Text(stringResource(R.string.computer_delete_2, session.title)) }, text = { Text(stringResource(R.string.work_the_conversation_its_files_in_pal_and_its)) },
        confirmButton = { Button({ confirmDelete = false; scope.launch { runCatching { signed(activity, repository, "owner.sessions.delete", buildJsonObject { put("sessionId", session.id); put("expectedRevision", session.revision) }, strings.getString(R.string.work_delete, session.title)) }.onFailure { error = it.message } } }) { Text(stringResource(R.string.action_delete)) } },
        dismissButton = { TextButton({ confirmDelete = false }) { Text(stringResource(R.string.work_keep_it)) } })
}

@Composable
private fun Status(error: String?, info: String?) {
    error?.let { Text(it, Modifier.padding(horizontal = PALLayout.groupGap), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    info?.let { Text(it, Modifier.padding(horizontal = PALLayout.groupGap), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
}

// ── Files ────────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun FilesTab(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var roots by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var grants by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var rootId by rememberSaveable { mutableStateOf("") }
    var path by rememberSaveable { mutableStateOf("") }
    var entries by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var openFile by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var matches by remember { mutableStateOf<List<JsonObject>?>(null) }
    var choosing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    fun loadRoots() = scope.launch {
        runCatching { repository.read("workbench.roots", buildJsonObject { put("sessionId", sessionId) }) as JsonObject }
            .onSuccess { value -> roots = value.list("roots"); grants = value.list("grants"); if (roots.none { it.str("id") == rootId }) { rootId = roots.firstOrNull()?.str("id").orEmpty(); path = "" } }
            .onFailure { error = it.message }
    }
    fun loadDirectory() = scope.launch {
        if (rootId.isEmpty()) { entries = emptyList(); return@launch }
        loading = true; error = null
        runCatching { repository.read("workbench.files.list", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("path", path); put("limit", 300) }) as JsonObject }
            .onSuccess { entries = it.list("entries") }.onFailure { error = it.message }
        loading = false
    }
    LaunchedEffect(sessionId) { loadRoots() }
    LaunchedEffect(rootId, path) { loadDirectory() }
    val root = roots.firstOrNull { it.str("id") == rootId }
    openFile?.let { file -> return FileView(repository, activity, sessionId, rootId, root, file) { openFile = null; loadDirectory() } }
    if (choosing) return FolderChooser(repository, state.sessions.firstOrNull { it.id == sessionId }?.project, { choosing = false }) { chosen, write ->
        choosing = false
        scope.launch {
            runCatching { signed(activity, repository, "workbench.addRoot", buildJsonObject { put("sessionId", sessionId); put("path", chosen); put("policy", buildJsonObject { put("write", write) }) }, strings.getString(R.string.work_use_in_this_conversation, chosen)) }
                .onSuccess { loadRoots() }.onFailure { error = it.message }
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = PALLayout.sectionGap)) {
        item {
            FlowRow(Modifier.padding(horizontal = PALLayout.groupGap), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                roots.forEach { item -> FilterChip(item.str("id") == rootId, { rootId = item.str("id").orEmpty(); path = ""; matches = null }, { Text(item.str("name") ?: stringResource(R.string.work_folder)) }) }
                AssistChip({ choosing = true }, { Text(stringResource(R.string.work_add_a_folder)) }, leadingIcon = { Icon(Icons.Default.Add, null) })
            }
        }
        if (roots.isEmpty()) item { Text(stringResource(R.string.work_no_folders_yet_add_a_folder_from_this), Modifier.padding(PALLayout.groupGap), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (root != null) {
            item {
                FolderPermissions(repository, activity, sessionId, root, grants.firstOrNull { it.str("rootId") == root.str("id") }) { loadRoots() }
                Text(listOf(root.str("path").orEmpty(), path).filter { it.isNotEmpty() }.joinToString("/") + stringResource(R.string.work_on, state.desktop?.desktopName ?: strings.getString(R.string.desktop_the_desktop)) +
                    (if (root.obj("policy")?.isTrue("write") == true) stringResource(R.string.work_editable) else stringResource(R.string.work_read_only)),
                    Modifier.padding(horizontal = PALLayout.groupGap), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(Modifier.padding(horizontal = PALLayout.groupGap), verticalAlignment = Alignment.CenterVertically) {
                    if (path.isNotEmpty()) TextButton({ path = path.substringBeforeLast('/', "") }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, null); Text(stringResource(R.string.work_up)) }
                    OutlinedTextField(query, { query = it }, Modifier.weight(1f), singleLine = true, placeholder = { Text(stringResource(R.string.work_search_in_this_folder)) }, trailingIcon = {
                        IconButton({ scope.launch {
                            if (query.isBlank()) { matches = null; return@launch }
                            runCatching { repository.read("workbench.files.search", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("path", path); put("query", query) }) as JsonObject }
                                .onSuccess { matches = it.list("matches") }.onFailure { error = it.message }
                        } }) { Icon(Icons.Default.Search, stringResource(R.string.action_search)) }
                    })
                }
            }
        }
        item { if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap)); Status(error, null) }
        val found = matches
        if (found != null) {
            item { Text(stringResource(R.string.work_match, found.size, if (found.size == 1) "" else "es"), Modifier.padding(PALLayout.groupGap), style = MaterialTheme.typography.titleSmall) }
            items(found) { match ->
                ListItem(headlineContent = { Text(match.str("path").orEmpty(), maxLines = 1) }, supportingContent = { Text("${match.int("line") ?: ""}: ${match.str("text").orEmpty().trim()}", fontFamily = FontFamily.Monospace, maxLines = 2) },
                    modifier = Modifier.clickable { openFile = match.str("path") })
            }
        } else items(entries, key = { it.str("path").orEmpty() }) { entry ->
            val folder = entry.str("type") == "directory"
            ListItem(headlineContent = { Text(entry.str("name").orEmpty()) },
                supportingContent = { Text(if (folder) stringResource(R.string.work_folder) else byteSize(entry.num("size")) + if (entry.isTrue("credential")) stringResource(R.string.work_may_hold_credentials) else "") },
                leadingContent = { Icon(if (folder) Icons.AutoMirrored.Filled.List else Icons.Default.Create, null) },
                modifier = Modifier.clickable { val target = entry.str("path").orEmpty(); if (folder) path = target else openFile = target })
        }
    }
}

/** A folder's permissions (edit, run commands) and a time-limited edit permission for the model, as on the desktop. */
@Composable
private fun FolderPermissions(repository: PALRepository, activity: FragmentActivity, sessionId: String, root: JsonObject, grant: JsonObject?, reload: () -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    val policy = root.obj("policy"); val rootId = root.str("id").orEmpty()
    var error by remember { mutableStateOf<String?>(null) }
    fun update(key: String, value: Boolean) = scope.launch {
        runCatching { signed(activity, repository, "workbench.updateRoot", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("expectedRevision", (root["revision"] as? JsonPrimitive)?.content ?: "0"); put("policy", buildJsonObject { put(key, value) }) }, strings.getString(R.string.work_change_s_permissions, root.str("name"))) }
            .onSuccess { error = null; reload() }.onFailure { error = it.message }
    }
    FlowRow(Modifier.padding(horizontal = PALLayout.groupGap), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        FilterChip(policy?.isTrue("write") == true, { update("write", policy?.isTrue("write") != true) }, { Text(stringResource(R.string.work_create_and_edit)) })
        FilterChip(policy?.isTrue("execute") == true, { update("execute", policy?.isTrue("execute") != true) }, { Text(stringResource(R.string.work_run_commands)) })
        if (policy?.isTrue("write") == true && grant == null) AssistChip({ scope.launch {
            runCatching { signed(activity, repository, "workbench.grantEdits", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("minutes", 30) }, strings.getString(R.string.work_let_the_model_edit_for_30_minutes, root.str("name"))) }
                .onSuccess { error = null; reload() }.onFailure { error = it.message }
        } }, { Text(stringResource(R.string.work_allow_model_edits_30_min)) })
    }
    if (grant != null) {
        val expiry = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(grant.num("expires") ?: 0))
        Row(Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.work_model_can_edit_until, expiry), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
            TextButton({ scope.launch {
                runCatching { repository.mutate("workbench.revokeGrant", buildJsonObject { put("sessionId", sessionId); put("id", grant.str("id").orEmpty()) }) }
                    .onSuccess { error = null; reload() }.onFailure { error = it.message }
            } }) { Text(stringResource(R.string.work_end_now)) }
        }
    }
    error?.let { Text(it, Modifier.padding(horizontal = PALLayout.groupGap), style = MaterialTheme.typography.bodySmall) }
}

/** A desktop folder picker for the owner: names only, never contents; choosing is the owner's act. */
@Composable
private fun FolderChooser(repository: PALRepository, start: String?, dismiss: () -> Unit, choose: (String, Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var listing by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var write by remember { mutableStateOf(true) }
    fun go(target: String?) = scope.launch {
        runCatching { repository.read("workbench.browse", buildJsonObject { target?.let { put("path", it) } }) as JsonObject }.onSuccess { listing = it; error = null }.onFailure { error = it.message }
    }
    LaunchedEffect(Unit) { go(start) }
    Column(Modifier.fillMaxSize().padding(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(dismiss) { Icon(Icons.Default.Close, stringResource(R.string.action_cancel)) }
            Text(stringResource(R.string.work_choose_a_folder_on_the_desktop), style = MaterialTheme.typography.titleMedium)
        }
        val current = listing
        Text(current?.str("path") ?: stringResource(R.string.transcript_loading_full_message), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        Status(error, null)
        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalAlignment = Alignment.CenterVertically) {
            current?.str("parent")?.let { parent -> OutlinedButton({ go(parent) }) { Text(stringResource(R.string.work_up)) } }
            OutlinedButton({ go(current?.str("home")) }) { Text(stringResource(R.string.work_home)) }
            Checkbox(write, { write = it }); Text(stringResource(R.string.work_allow_edits))
        }
        Button({ current?.str("path")?.let { choose(it, write) } }, enabled = current != null) { Text(stringResource(R.string.work_use_this_folder)) }
        LazyColumn(Modifier.weight(1f)) {
            items(current?.list("items").orEmpty().filter { it.str("kind") == "folder" }, key = { it.str("path").orEmpty() }) { item ->
                ListItem(headlineContent = { Text(item.str("name").orEmpty()) }, leadingContent = { Icon(Icons.AutoMirrored.Filled.List, null) }, modifier = Modifier.clickable { go(item.str("path")) })
            }
        }
    }
}

/** A file from the desktop: line numbers, search, and an editor that saves through the change engine. */
@Composable
private fun FileView(repository: PALRepository, activity: FragmentActivity, sessionId: String, rootId: String, root: JsonObject?, file: String, close: () -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf<JsonObject?>(null) }
    var editing by remember { mutableStateOf(false) }
    var draft by rememberSaveable(file) { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var find by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var translating by remember { mutableStateOf(false) }
    var table by remember { mutableStateOf<JsonObject?>(null) }
    var language by rememberSaveable { mutableStateOf("") }
    var glossary by rememberSaveable { mutableStateOf("") }
    fun load() = scope.launch {
        error = null
        // The whole text when it fits one change (256 KiB); otherwise the first 300 lines, read only.
        runCatching { repository.read("workbench.files.text", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("path", file) }) as JsonObject }
            .recoverCatching { repository.read("workbench.files.read", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("path", file); put("lineCount", 300) }) as JsonObject }
            .onSuccess { text = it; if (!editing) draft = it.str("text").orEmpty() }.onFailure { error = it.message }
    }
    LaunchedEffect(file) { load() }
    val editable = root?.obj("policy")?.isTrue("write") == true && text?.str("text") != null && text?.isTrue("truncated") != true && text?.num("totalLines") == null
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = PALLayout.tight), verticalAlignment = Alignment.CenterVertically) {
            IconButton(close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.work_back_to_the_folder)) }
            Text(file.substringAfterLast('/'), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 1)
            if (editable && !editing) TextButton({ editing = true; draft = text?.str("text").orEmpty() }) { Text(stringResource(R.string.action_edit)) }
            if (text?.str("text") != null && !editing) TextButton({ translating = true }) { Text(stringResource(R.string.work_translate)) }
            if (Regex("\\.(csv|tsv)$", RegexOption.IGNORE_CASE).containsMatchIn(file)) TextButton({ scope.launch {
                runCatching { repository.read("owner.tables.preview", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("path", file) }) as JsonObject }.onSuccess { table = it }.onFailure { error = it.message }
            } }) { Text(stringResource(R.string.work_columns)) }
        }
        // §15.2: what a table holds before it is analyzed: columns, types, missing values, problems.
        table?.let { preview -> AlertDialog({ table = null }, title = { Text(stringResource(R.string.work_rows, preview.num("rows") ?: 0)) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                preview.list("columns").forEach { column -> Text("${column.str("name")} · ${column.str("type")}" + (column.num("missing")?.takeIf { it > 0 }?.let { " · " + strings.getString(R.string.column_missing, it) } ?: "") + (column.str("example")?.let { " · " + strings.getString(R.string.column_example, it) } ?: ""), style = MaterialTheme.typography.bodySmall) }
                (preview["problems"] as? JsonArray)?.forEach { Text(it.jsonPrimitive.content, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            }
        }, confirmButton = { TextButton({ table = null }) { Text(stringResource(R.string.action_close)) } }) }
        // §16.3: the translation is a new linked file in this conversation's Library; this file is not changed.
        if (translating) AlertDialog({ translating = false }, title = { Text(stringResource(R.string.work_translate_2, file.substringAfterLast('/'))) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedTextField(language, { language = it.take(40) }, singleLine = true, label = { Text(stringResource(R.string.work_into_for_example_german)) })
                OutlinedTextField(glossary, { glossary = it }, minLines = 2, label = { Text(stringResource(R.string.work_glossary_term_translation_one_per_line_optional)) })
                Text(stringResource(R.string.work_the_translation_is_saved_as_a_new_file), style = MaterialTheme.typography.bodySmall)
            }
        }, confirmButton = { Button({ translating = false; scope.launch {
            info = strings.getString(R.string.work_translating_on_the_desktop)
            val pairs = glossary.lines().mapNotNull { line -> line.split('=', limit = 2).takeIf { it.size == 2 && it[0].isNotBlank() }?.let { buildJsonObject { put("source", it[0].trim()); put("target", it[1].trim()) } } }
            runCatching { repository.mutate("owner.translate", buildJsonObject { put("sessionId", sessionId); put("targetLanguage", language.trim()); put("input", buildJsonObject { put("kind", "file"); put("rootId", rootId); put("path", file) }); if (pairs.isNotEmpty()) put("glossary", JsonArray(pairs)) }, strings.getString(R.string.work_translate_2, file)) as JsonObject }
                .onSuccess { result -> info = result.str("summary"); if (result.str("status") != "completed") { error = result.str("summary"); info = null } }.onFailure { error = it.message; info = null }
        } }, enabled = language.isNotBlank()) { Text(stringResource(R.string.work_translate)) } }, dismissButton = { TextButton({ translating = false }) { Text(stringResource(R.string.action_cancel)) } })
        Text("${root?.str("path").orEmpty()}/$file", Modifier.padding(horizontal = PALLayout.groupGap), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Status(error, info)
        if (editing) {
            OutlinedTextField(draft, { draft = it }, Modifier.weight(1f).fillMaxWidth().padding(PALLayout.small), textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
            Row(Modifier.padding(PALLayout.small), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedButton({ editing = false; draft = text?.str("text").orEmpty() }) { Text(stringResource(R.string.desktop_discard)) }
                Button({
                    val version = text?.str("version") ?: return@Button
                    saving = true; error = null
                    scope.launch {
                        // The owner's own edit, checked against the version shown: a newer desktop change is never overwritten.
                        runCatching { signed(activity, repository, "workbench.changes.propose", buildJsonObject {
                            put("sessionId", sessionId); put("apply", true); put("reason", "Edited on the phone")
                            put("operations", buildJsonArray { add(buildJsonObject { put("kind", "patch_text"); put("rootId", rootId); put("path", file); put("baseVersion", version); put("content", draft) }) })
                        }, strings.getString(R.string.work_save_2, file.substringAfterLast('/'))) as JsonObject }
                            .onSuccess { value -> val applied = value.obj("applied"); info = if (applied?.str("status") == "applied" || applied?.str("state") == "applied" || applied != null) strings.getString(R.string.work_saved_on_the_desktop) else strings.getString(R.string.work_proposed_for_review); editing = false; load() }
                            .onFailure { error = it.message + strings.getString(R.string.work_reload_to_see_the_desktops_current_version_your) }
                        saving = false
                    }
                }, enabled = !saving) { Text(if (saving) stringResource(R.string.computer_saving) else stringResource(R.string.action_save)) }
            }
        } else {
            OutlinedTextField(find, { find = it }, Modifier.fillMaxWidth().padding(horizontal = PALLayout.small), singleLine = true, placeholder = { Text(stringResource(R.string.work_find_in_this_file)) })
            val lines = text?.str("text")?.split('\n') ?: emptyList()
            val first = (text?.num("startLine") ?: 1).toInt().coerceAtLeast(1)
            if (text?.isTrue("binary") == true) Text(text?.str("note").orEmpty(), Modifier.padding(PALLayout.groupGap))
            SelectionContainer(Modifier.weight(1f)) {
                LazyColumn(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
                    itemsIndexed(lines) { index, line ->
                        val hit = find.isNotBlank() && line.contains(find, ignoreCase = true)
                        Text(buildAnnotatedString {
                            withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("%5d  ".format(first + index)) }
                            if (hit) withStyle(SpanStyle(background = MaterialTheme.colorScheme.tertiaryContainer)) { append(line) } else append(line)
                        }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, softWrap = false)
                    }
                }
            }
            if (text?.isTrue("truncated") == true) Text(stringResource(R.string.work_showing_the_first_lines_larger_files_open_read, lines.size), Modifier.padding(PALLayout.small), style = MaterialTheme.typography.bodySmall)
        }
    }
}

// ── Changes ──────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun ChangesTab(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var sets by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var review by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    fun load() = scope.launch { runCatching { repository.read("workbench.changes.list", buildJsonObject { put("sessionId", sessionId) }) }.onSuccess { sets = it.objects() }.onFailure { error = it.message } }
    fun open(id: String) = scope.launch { runCatching { repository.read("workbench.changes.review", buildJsonObject { put("sessionId", sessionId); put("changeSetId", id) }) as JsonObject }.onSuccess { review = it }.onFailure { error = it.message } }
    LaunchedEffect(sessionId) { load() }
    LaunchedEffect(state.cursor) { load() }
    BackHandler(enabled = review != null) { review = null; load() }
    val current = review
    if (current != null) {
        val id = current.str("id").orEmpty(); val status = current.str("status").orEmpty()
        Column(Modifier.fillMaxSize()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton({ review = null; load() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.work_back_to_changes)) }
                Text(current.str("reason") ?: stringResource(R.string.work_proposed_changes), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 2)
            }
            Status(error, info)
            if (current.isTrue("complete").not()) Text(current.str("incompleteReason") ?: stringResource(R.string.work_this_review_is_incomplete_applying_is_not_offered), Modifier.padding(horizontal = PALLayout.groupGap), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            current.str("blockedBecause")?.let { Text(it, Modifier.padding(horizontal = PALLayout.groupGap), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                items(current.list("operations")) { op ->
                    Surface(border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant), shape = MaterialTheme.shapes.small) {
                        Column(Modifier.padding(PALLayout.small).fillMaxWidth()) {
                            Text("${op.str("label") ?: op.str("kind")} · ${op.str("path") ?: op.str("to").orEmpty()}", fontWeight = FontWeight.SemiBold)
                            op.obj("outcome")?.str("state")?.let { Text(stringResource(R.string.work_outcome, it), style = MaterialTheme.typography.bodySmall) }
                            op.obj("review")?.list("notes")?.let { } // notes are strings; shown below
                            (op.obj("review")?.get("notes") as? JsonArray)?.forEach { note -> Text(note.jsonPrimitive.contentOrNull.orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            op.obj("review")?.str("diff")?.takeIf { it.isNotBlank() }?.let { diff ->
                                SelectionContainer {
                                    Column(Modifier.horizontalScroll(rememberScrollState())) {
                                        diff.lines().take(800).forEach { line ->
                                            val colour = when { line.startsWith("+") && !line.startsWith("+++") -> MaterialTheme.colorScheme.primary; line.startsWith("-") && !line.startsWith("---") -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.onSurface }
                                            Text(line, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = colour, softWrap = false)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Row(Modifier.padding(PALLayout.groupGap), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                if (status == "pending") {
                    Button({ busy = true; scope.launch {
                        runCatching { signed(activity, repository, "workbench.changes.apply", buildJsonObject { put("sessionId", sessionId); put("changeSetId", id); put("digest", current.str("digest").orEmpty()) }, strings.getString(R.string.work_apply_these_changes_on_the_desktop)) }
                            .onSuccess { info = strings.getString(R.string.work_applied_per_file_outcomes_are_shown_above); open(id) }.onFailure { error = it.message }
                        busy = false } }, enabled = !busy && current.isTrue("approvable")) { Text(stringResource(R.string.computer_apply_2)) }
                    OutlinedButton({ scope.launch { runCatching { repository.mutate("workbench.changes.decline", buildJsonObject { put("sessionId", sessionId); put("changeSetId", id) }) }.onSuccess { review = null; load() }.onFailure { error = it.message } } }, enabled = !busy) { Text(stringResource(R.string.work_decline)) }
                }
                if (status == "applied" || status == "partial") OutlinedButton({ busy = true; scope.launch {
                    runCatching { signed(activity, repository, "workbench.changes.undo", buildJsonObject { put("sessionId", sessionId); put("changeSetId", id) }, strings.getString(R.string.work_undo_these_changes)) }
                        .onSuccess { info = strings.getString(R.string.work_undo_proposed_as_a_new_change_review_it) ; review = null; load() }.onFailure { error = it.message }
                    busy = false } }, enabled = !busy) { Text(stringResource(R.string.annotation_undo)) }
            }
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        item { Status(error, null) }
        if (sets.isEmpty()) item { Text(stringResource(R.string.work_no_proposed_changes_in_this_conversation), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(sets, key = { it.str("id").orEmpty() }) { set ->
            ListItem(headlineContent = { Text(set.str("reason") ?: stringResource(R.string.work_proposed_changes), maxLines = 2) },
                supportingContent = { Text("${set.str("status").orEmpty()} · ${set.list("operations").size.takeIf { it > 0 } ?: set.int("operationCount") ?: ""} · ${set.str("origin").orEmpty()}" + if (set.isTrue("pendingApproval")) stringResource(R.string.work_waiting_for_your_answer) else "") },
                modifier = Modifier.clickable { open(set.str("id").orEmpty()) })
        }
    }
}

// ── Library (artifacts) ──────────────────────────────────────────────────────────────────────────

@Composable
private fun LibraryTab(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var items by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var thumbs by remember { mutableStateOf<Map<String, android.graphics.Bitmap>>(emptyMap()) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    var preview by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    var annotating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var progress by remember { mutableStateOf<Float?>(null) }
    var pendingSave by remember { mutableStateOf<Pair<String, ByteArray>?>(null) }
    fun load() = scope.launch {
        runCatching { repository.read("workbench.artifacts.list", buildJsonObject { put("sessionId", sessionId); put("limit", 60) }) }
            .onSuccess { value -> items = (value as? JsonObject)?.list("artifacts") ?: value.objects() }.onFailure { error = it.message }
    }
    LaunchedEffect(sessionId) { load() }
    LaunchedEffect(items) {
        for (item in items.filter { it.obj("latest")?.str("kind") in setOf("image", "plot") }.take(24)) {
            val id = item.str("id") ?: item.str("artifactId") ?: continue
            if (thumbs.containsKey(id)) continue
            runCatching { repository.read("workbench.artifacts.thumbnail", buildJsonObject { put("sessionId", sessionId); put("artifactId", id); put("size", 192) }) as JsonObject }.getOrNull()?.str("data")?.let { data ->
                val image = withContext(Dispatchers.Default) {
                    val bytes = Base64.decode(data.substringAfter("base64,"), Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
                image?.let { bitmap -> thumbs = thumbs + (id to bitmap) }
            }
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri: Uri? ->
        val pending = pendingSave; pendingSave = null
        if (uri != null && pending != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(pending.second) } ?: error(strings.getString(R.string.work_could_not_open_the_chosen_file)) } }
                .onSuccess { info = strings.getString(R.string.work_saved_to_this_phone, pending.first) }.onFailure { error = it.message }
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        if (uri != null) scope.launch {
            error = null; progress = 0f
            try {
                val (name, bytes) = withContext(Dispatchers.IO) {
                    val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: strings.getString(R.string.work_phone_file)
                    name to (context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error(strings.getString(R.string.work_could_not_read_that_file)))
                }
                require(bytes.size <= 100 * 1024 * 1024) { strings.getString(R.string.work_send_files_up_to_100_mb) }
                val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                uploadToDesktop(activity, repository, sessionId, name, mime, bytes) { done, total -> progress = done.toFloat() / total.coerceAtLeast(1) }
                info = strings.getString(R.string.work_is_now_in_this_conversations_library_on_the, name); load()
            } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Throwable) { error = failure.message }
            progress = null
        }
    }
    BackHandler(enabled = selected != null) {
        if (annotating) annotating = false else { selected = null; preview = null }
    }
    val current = selected
    if (current != null) {
        val id = current.str("id") ?: current.str("artifactId").orEmpty(); val latest = current.obj("latest")
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton({ selected = null; preview = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.work_back_to_the_library)) }
                Text(current.str("name") ?: latest?.str("name").orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 2)
            }
            Text("${latest?.str("mime").orEmpty()} · ${byteSize(latest?.num("bytes"))} · ${latest?.str("source").orEmpty()}", style = MaterialTheme.typography.bodySmall)
            Status(error, info)
            progress?.let { LinearProgressIndicator({ it }, Modifier.fillMaxWidth()) }
            val dims = latest?.obj("image")
            if (annotating) preview?.let { shown -> AnnotateImage(shown, dims?.int("width") ?: shown.width, dims?.int("height") ?: shown.height, { annotating = false }) { png ->
                annotating = false
                scope.launch {
                    val inline = "data:image/png;base64," + android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP)
                    runCatching {
                        if (inline.length <= 900_000) signed(activity, repository, "workbench.images.saveEdit", buildJsonObject { put("sessionId", sessionId); put("artifactId", id); latest?.str("versionId")?.let { put("versionId", it) }; put("layer", inline) }, strings.getString(R.string.work_save_your_drawing_as_a_new_version))
                        else {
                            val uploaded = uploadToDesktop(activity, repository, sessionId, "layer.png", "image/png", png, purpose = "layer")
                            signed(activity, repository, "workbench.images.saveEdit", buildJsonObject { put("sessionId", sessionId); put("artifactId", id); latest?.str("versionId")?.let { put("versionId", it) }; put("layerTransferId", uploaded.str("transferId").orEmpty()) }, strings.getString(R.string.work_save_your_drawing_as_a_new_version))
                        }
                    }.onSuccess { info = strings.getString(R.string.work_saved_as_a_new_version_the_earlier_one); preview = null; load() }.onFailure { error = it.message }
                }
            } }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                if (latest?.str("kind") == "image" && preview != null && dims != null) OutlinedButton({ annotating = true }) { Text(stringResource(R.string.work_draw_on_it)) }
                if (latest?.str("kind") in setOf("image", "plot")) OutlinedButton({ scope.launch {
                    runCatching {
                        val (_, bytes) = downloadArtifact(strings, repository, sessionId, id, null, "preview")
                        withContext(Dispatchers.Default) { decodeForDisplay(bytes, 2048) } ?: error(strings.getString(R.string.library_preview_unavailable))
                    }.onSuccess { image -> if (selected === current) preview = image }.onFailure { if (selected === current) error = it.message }
                } }) { Text(stringResource(R.string.work_show_preview)) }
                Button({ progress = 0f; scope.launch {
                    runCatching { downloadArtifact(strings, repository, sessionId, id, null, "original") { done, total -> progress = done.toFloat() / total.coerceAtLeast(1) } }
                        .onSuccess { (meta, bytes) -> pendingSave = (meta.str("name") ?: "download") to bytes; save.launch(meta.str("name") ?: "download") }.onFailure { error = it.message }
                    progress = null } }) { Text(stringResource(R.string.work_download_original)) }
                OutlinedButton({ scope.launch { runCatching { repository.mutate("workbench.artifacts.useInDraft", buildJsonObject { put("sessionId", sessionId); put("artifactId", id) }) }.onSuccess { info = strings.getString(R.string.work_added_to_the_conversations_desktop_draft) }.onFailure { error = it.message } } }) { Text(stringResource(R.string.work_use_in_draft)) }
                OutlinedButton({ scope.launch { runCatching { repository.mutate("workbench.artifacts.update", buildJsonObject { put("sessionId", sessionId); put("artifactId", id); put("pinned", !current.isTrue("pinned")) }) }.onSuccess { info = if (current.isTrue("pinned")) strings.getString(R.string.work_unpinned) else strings.getString(R.string.session_pinned); load() }.onFailure { error = it.message } } }) { Text(if (current.isTrue("pinned")) stringResource(R.string.work_unpin) else stringResource(R.string.work_pin)) }
            }
            preview?.let { Image(it.asImageBitmap(), stringResource(R.string.work_preview), Modifier.fillMaxWidth().heightIn(max = PALLayout.desktopPreviewHeight)) }
            Text(stringResource(R.string.work_downloads_are_verified_against_the_desktops_copy_before), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                Button({ pick.launch("*/*") }, enabled = progress == null) { Icon(Icons.Default.Add, null); Text(stringResource(R.string.work_send_a_file_from_this_phone)) }
            }
            progress?.let { LinearProgressIndicator({ it }, Modifier.fillMaxWidth().padding(top = PALLayout.small)) }
            Status(error, info)
        }
        if (items.isEmpty()) item { Text(stringResource(R.string.work_nothing_in_this_conversations_library_yet), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(items, key = { it.str("id") ?: it.str("artifactId").orEmpty() }) { item ->
            val id = item.str("id") ?: item.str("artifactId").orEmpty(); val latest = item.obj("latest")
            ListItem(headlineContent = { Text(item.str("name") ?: latest?.str("name").orEmpty(), maxLines = 1) },
                supportingContent = { Text("${latest?.str("kind").orEmpty()} · ${byteSize(latest?.num("bytes"))}" + if (item.isTrue("pinned")) stringResource(R.string.work_pinned) else "") },
                leadingContent = { Box(Modifier.size(PALLayout.target), contentAlignment = Alignment.Center) { thumbs[id]?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize()) } ?: Icon(Icons.Default.Star, null) } },
                modifier = Modifier.clickable { selected = item; preview = null; error = null; info = null })
        }
    }
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────

@Composable
private fun RunsTab(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var runs by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var code by rememberSaveable(sessionId) { mutableStateOf("") }
    var prompt by rememberSaveable(sessionId) { mutableStateOf("") }
    var connections by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var connectionId by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    var confirmBilling by remember { mutableStateOf<String?>(null) }
    fun load() = scope.launch { runCatching { repository.read("workbench.operations.list", buildJsonObject { put("sessionId", sessionId); put("limit", 40) }) }.onSuccess { runs = it.objects() }.onFailure { error = it.message } }
    LaunchedEffect(sessionId) {
        load()
        runCatching { repository.read("workbench.images.connections", buildJsonObject {}) as JsonObject }.onSuccess { value -> connections = value.list("connections").filter { it.isTrue("enabled") }; if (connectionId.isEmpty()) connectionId = connections.firstOrNull()?.str("id").orEmpty() }
    }
    LaunchedEffect(state.cursor) { load() }
    fun generate(acknowledge: Boolean) = scope.launch {
        error = null
        runCatching { signed(activity, repository, "workbench.images.generate", buildJsonObject {
            put("sessionId", sessionId); put("connectionId", connectionId); put("request", buildJsonObject { put("prompt", prompt); put("count", 1) }); if (acknowledge) put("acknowledgeBilling", true)
        }, strings.getString(R.string.work_generate_an_image_on_the_desktop)) }
            .onSuccess { info = strings.getString(R.string.work_started_on_the_desktop_its_result_appears_in); load() }
            .onFailure { failure -> if ((failure.message ?: "").contains("bill", ignoreCase = true) && !acknowledge) confirmBilling = failure.message else error = failure.message }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        item { Status(error, info) }
        item {
            Text(stringResource(R.string.work_analysis_code_lab), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
            OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth().heightIn(min = PALLayout.codeEditorHeight), textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                placeholder = { Text(stringResource(R.string.work_python_3_run_in_the_desktops_isolated_code)) })
            Button({ scope.launch {
                runCatching { signed(activity, repository, "workbench.codelab.run", buildJsonObject { put("sessionId", sessionId); put("code", code); put("purpose", "Run from PAL Mobile") }, strings.getString(R.string.work_run_this_code_in_code_lab)) }
                    .onSuccess { info = strings.getString(R.string.work_running_in_code_lab_on_the_desktop); load() }.onFailure { error = it.message }
            } }, enabled = code.isNotBlank()) { Icon(Icons.Default.PlayArrow, null); Text(stringResource(R.string.desktop_run)) }
        }
        if (connections.isNotEmpty()) item {
            Text(stringResource(R.string.work_create_an_image), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { connections.forEach { c -> FilterChip(c.str("id") == connectionId, { connectionId = c.str("id").orEmpty() }, { Text(c.str("name") ?: stringResource(R.string.work_image_connection)) }) } }
            OutlinedTextField(prompt, { prompt = it }, Modifier.fillMaxWidth(), placeholder = { Text(stringResource(R.string.work_describe_the_image)) })
            Button({ generate(false) }, enabled = prompt.isNotBlank() && connectionId.isNotEmpty()) { Text(stringResource(R.string.work_generate)) }
        }
        item { Text(stringResource(R.string.work_runs_in_this_conversation), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall) }
        if (runs.isEmpty()) item { Text(stringResource(R.string.work_no_runs_yet), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(runs, key = { it.str("operationId") ?: it.str("id").orEmpty() }) { run ->
            val id = run.str("operationId") ?: run.str("id").orEmpty(); val state = run.str("state").orEmpty()
            ListItem(headlineContent = { Text(run.str("label") ?: run.str("kind").orEmpty(), maxLines = 2) },
                supportingContent = { Text(runState(state) + (run.str("message")?.let { " · $it" } ?: "")) },
                trailingContent = {
                    if (state in setOf("running", "queued", "dispatching", "awaiting_approval")) TextButton({ scope.launch { runCatching { repository.mutate("workbench.operations.cancel", buildJsonObject { put("sessionId", sessionId); put("operationId", id) }) }.onSuccess { load() }.onFailure { error = it.message } } }) { Text(stringResource(R.string.action_cancel)) }
                })
        }
    }
    confirmBilling?.let { message ->
        AlertDialog({ confirmBilling = null }, title = { Text(stringResource(R.string.work_this_image_service_may_bill_you)) }, text = { Text(message) },
            confirmButton = { Button({ confirmBilling = null; generate(true) }) { Text(stringResource(R.string.work_continue)) } }, dismissButton = { TextButton({ confirmBilling = null }) { Text(stringResource(R.string.action_cancel)) } })
    }
}

// ── Research ─────────────────────────────────────────────────────────────────────────────────────

/** Full-access Research uses the desktop's canonical run and report objects; the phone never keeps a second copy. */
@Composable
private fun ResearchTab(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, openSearchSettings: () -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var question by rememberSaveable(sessionId) { mutableStateOf("") }
    var preset by rememberSaveable(sessionId) { mutableStateOf("quick") }
    var mode by rememberSaveable(sessionId) { mutableStateOf("answer") }
    var researchScope by rememberSaveable(sessionId) { mutableStateOf("web") }
    var recency by rememberSaveable(sessionId) { mutableStateOf("") }
    var sites by rememberSaveable(sessionId) { mutableStateOf("") }
    var siteMode by rememberSaveable(sessionId) { mutableStateOf("prefer") }
    var urls by rememberSaveable(sessionId) { mutableStateOf("") }
    var output by rememberSaveable(sessionId) { mutableStateOf("brief") }
    var minutes by rememberSaveable(sessionId) { mutableStateOf("5") }
    var sourceLimit by rememberSaveable(sessionId) { mutableStateOf("12") }
    var callLimit by rememberSaveable(sessionId) { mutableStateOf("6") }
    var criteria by rememberSaveable(sessionId) { mutableStateOf("") }
    var showOptions by rememberSaveable(sessionId) { mutableStateOf(false) }
    var availableSources by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selectedSources by remember(sessionId) { mutableStateOf<Set<String>>(emptySet()) }
    var plan by remember(sessionId) { mutableStateOf<List<String>>(emptyList()) }
    var requestId by rememberSaveable(sessionId, question) { mutableStateOf(java.util.UUID.randomUUID().toString()) }
    var runs by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    var report by remember { mutableStateOf<String?>(null) }
    var expandedPassage by remember { mutableStateOf<JsonObject?>(null) }
    var focus by rememberSaveable { mutableStateOf("") }
    var answer by remember { mutableStateOf<String?>(null) }
    var note by rememberSaveable { mutableStateOf("") }
    var info by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var webSearch by remember { mutableStateOf<Boolean?>(null) }
    val working = setOf("planning", "searching", "reading", "synthesizing", "refreshing")
    fun load() = scope.launch {
        runCatching { repository.request("owner.research.list", buildJsonObject { put("sessionId", sessionId); put("project", true) }) }
            .onSuccess { value -> runs = (value as? JsonObject)?.list("runs") ?: value.objects() }.onFailure { error = it.message }
        selectedId?.let { id -> runCatching { repository.request("owner.research.get", buildJsonObject { put("id", id) }) as JsonObject }
            .onSuccess { selected = it }.onFailure { error = it.message } }
    }
    fun open(id: String) {
        selectedId = id; report = null; answer = null; expandedPassage = null
        scope.launch { runCatching { repository.request("owner.research.get", buildJsonObject { put("id", id) }) as JsonObject }
            .onSuccess { selected = it; error = null }.onFailure { error = it.message } }
    }
    LaunchedEffect(sessionId) {
        selectedId = null; selected = null; report = null
        load()
        runCatching { repository.request("owner.research.sources", buildJsonObject { put("sessionId", sessionId) }) }
            .onSuccess { value -> availableSources = (value as? JsonObject)?.list("sources") ?: value.objects() }.onFailure { error = it.message }
        runCatching { repository.request("owner.settings.get", buildJsonObject {}) as JsonObject }
            .onSuccess { webSearch = it.obj("settings")?.obj("webSearch")?.isTrue("enabled") }
    }
    LaunchedEffect(runs.any { it.str("state") in working }) {
        while (runs.any { it.str("state") in working }) { kotlinx.coroutines.delay(2000); load() }
    }
    fun preparePlan() = scope.launch {
        runCatching { signed(activity, repository, "owner.research.plan", buildJsonObject { put("sessionId", sessionId); put("question", question.trim()); put("mode", mode) }, strings.getString(R.string.work_prepare_a_research_plan)) as JsonObject }
            .onSuccess { result -> plan = (result["plan"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList(); info = strings.getString(R.string.work_review_the_plan_sources_and_limits_before_starting); error = null }
            .onFailure { error = it.message }
    }
    fun start() = scope.launch {
        val siteList = sites.lines().map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(5)
        val seedUrls = urls.lines().map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(12)
        val criteriaList = criteria.lines().map { it.trim() }.filter { it.isNotEmpty() }.take(12)
        runCatching { signed(activity, repository, "owner.research.start", buildJsonObject {
            put("sessionId", sessionId); put("question", question.trim()); put("preset", preset); put("mode", mode); put("scope", researchScope)
            put("sourceIds", buildJsonArray { selectedSources.forEach { add(it) } }); put("requestId", requestId)
            if (plan.isNotEmpty()) put("plan", buildJsonArray { plan.forEach { add(it) } })
            if (siteList.isNotEmpty()) { put("sites", buildJsonArray { siteList.forEach { add(it) } }); put("siteMode", siteMode) }
            if (seedUrls.isNotEmpty()) put("urls", buildJsonArray { seedUrls.forEach { add(it) } })
            if (recency.isNotEmpty()) put("recency", recency)
            put("output", output)
            minutes.toIntOrNull()?.let { put("minutes", it.coerceIn(1, 60)) }; sourceLimit.toIntOrNull()?.let { put("sources", it.coerceIn(1, 60)) }
            callLimit.toIntOrNull()?.let { put("calls", it.coerceIn(2, 20)) }; if (criteriaList.isNotEmpty()) put("criteria", buildJsonArray { criteriaList.forEach { add(it) } })
        }, strings.getString(R.string.work_start_this_research_run)) as JsonObject }
            .onSuccess { run -> run.str("id")?.let(::open); requestId = java.util.UUID.randomUUID().toString(); info = strings.getString(R.string.work_research_started_on_the_desktop); error = null; load() }
            .onFailure { error = it.message }
    }
    fun runAction(method: String, title: String, signedAction: Boolean = false, params: JsonObjectBuilder.() -> Unit = {}) = scope.launch {
        val id = selected?.str("id") ?: return@launch
        val payload = buildJsonObject { put("id", id); params() }
        runCatching { if (signedAction) signed(activity, repository, method, payload, title) else repository.mutate(method, payload) }
            .onSuccess { info = title; error = null; load() }.onFailure { error = it.message }
    }
    val detail = selected
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        item {
            Text(stringResource(R.string.work_choose_exactly_where_pal_may_look_web_searches), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(when (webSearch) { true -> stringResource(R.string.work_web_search_is_available); false -> stringResource(R.string.work_web_search_is_off_on_this_computer); null -> stringResource(R.string.work_checking_web_search) }, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = if (webSearch == false) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                if (webSearch == false) TextButton(openSearchSettings) { Text(stringResource(R.string.work_enable)) }
            }
            OutlinedTextField(question, { question = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.work_what_should_pal_research)) }, minLines = 2)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                listOf("answer" to strings.getString(R.string.mobile_answer), "compare" to strings.getString(R.string.work_compare), "check" to "Fact-check", "literature" to strings.getString(R.string.work_literature)).forEach { (value, label) -> FilterChip(mode == value, { mode = value }, { Text(label) }) }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                listOf("web" to strings.getString(R.string.work_web), "project" to strings.getString(R.string.sheet_project), "both" to strings.getString(R.string.work_both)).forEach { (value, label) -> FilterChip(researchScope == value, { researchScope = value }, { Text(label) }) }
                FilterChip(preset == "quick", { preset = "quick"; minutes = "5"; sourceLimit = "12" }, { Text(stringResource(R.string.work_quick)) })
                FilterChip(preset == "thorough", { preset = "thorough"; minutes = "20"; sourceLimit = "40" }, { Text(stringResource(R.string.work_thorough)) })
            }
            if (researchScope != "web" && availableSources.isEmpty()) Text(stringResource(R.string.work_no_project_sources_are_available_for_this_conversation), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (researchScope != "web") FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                availableSources.forEach { source -> val id = source.str("id").orEmpty(); FilterChip(id in selectedSources, { selectedSources = if (id in selectedSources) selectedSources - id else selectedSources + id }, { Text(source.str("title") ?: source.str("kind") ?: id) }) }
            }
            TextButton({ showOptions = !showOptions }) { Text(if (showOptions) stringResource(R.string.work_hide_research_options) else stringResource(R.string.work_plan_and_options)) }
            if (showOptions) {
                OutlinedTextField(sites, { sites = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.work_site_domains_up_to_5_one_per_line)) }, minLines = 2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("prefer" to strings.getString(R.string.work_prefer_these_sites), "only" to strings.getString(R.string.work_only_these_sites)).forEach { (value, label) -> FilterChip(siteMode == value, { siteMode = value }, { Text(label) }) } }
                OutlinedTextField(urls, { urls = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.work_public_pages_to_read_first_up_to_12)) }, minLines = 2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("" to strings.getString(R.string.work_any_time), "day" to stringResource(R.string.work_option_day), "week" to stringResource(R.string.work_option_week), "month" to stringResource(R.string.work_option_month), "year" to stringResource(R.string.work_option_year)).forEach { (value, label) -> FilterChip(recency == value, { recency = value }, { Text(label) }) } }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("brief" to strings.getString(R.string.work_brief), "timeline" to strings.getString(R.string.work_timeline), "matrix" to strings.getString(R.string.work_matrix)).forEach { (value, label) -> FilterChip(output == value, { output = value }, { Text(label) }) } }
                if (mode == "literature" && researchScope != "project") Text(stringResource(R.string.work_literature_research_also_checks_crossref_when_your_site), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    OutlinedTextField(minutes, { minutes = it.filter(Char::isDigit).take(2) }, Modifier.weight(1f), label = { Text(stringResource(R.string.desktop_minutes)) }, singleLine = true)
                    OutlinedTextField(sourceLimit, { sourceLimit = it.filter(Char::isDigit).take(2) }, Modifier.weight(1f), label = { Text(stringResource(R.string.transcript_sources)) }, singleLine = true)
                    OutlinedTextField(callLimit, { callLimit = it.filter(Char::isDigit).take(2) }, Modifier.weight(1f), label = { Text(stringResource(R.string.work_calls)) }, singleLine = true)
                }
                OutlinedTextField(criteria, { criteria = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.work_success_criteria_one_per_line)) }, minLines = 2)
            }
            if (plan.isNotEmpty()) {
                Text(stringResource(R.string.work_plan), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(plan.joinToString("\n"), { text -> plan = text.lines().map { it.trim() }.filter { it.isNotEmpty() }.take(12) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.work_plan_steps_one_per_line)) }, minLines = 3)
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedButton({ preparePlan() }, enabled = question.trim().length >= 5) { Text(if (plan.isEmpty()) stringResource(R.string.work_prepare_plan) else stringResource(R.string.work_replan)) }
                Button({ start() }, enabled = question.trim().length >= 5 && (researchScope == "project" || webSearch != false) && (researchScope == "web" || selectedSources.isNotEmpty())) { Text(stringResource(R.string.work_start_research)) }
            }
            Status(error, info)
        }
        items(runs.take(10), key = { it.str("id").orEmpty() }) { run ->
            ListItem(headlineContent = { Text(run.str("title") ?: run.str("question").orEmpty(), maxLines = 2) }, supportingContent = { Text(researchState(run.str("state")) + (run.str("summary")?.let { " · $it" } ?: "")) },
                modifier = Modifier.clickable { run.str("id")?.let(::open) }, trailingContent = { if (run.isTrue("pinned")) Icon(Icons.Default.Star, stringResource(R.string.session_pinned)) })
        }
        if (detail != null) {
            item {
                Text(detail.str("title") ?: detail.str("question").orEmpty(), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                val stateName = detail.str("state")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    if (stateName in working) OutlinedButton({ runAction("owner.research.pause", strings.getString(R.string.work_research_paused)) }) { Text(stringResource(R.string.work_pause)) }
                    if (stateName in working || stateName == "paused") OutlinedButton({ runAction("owner.research.stop", strings.getString(R.string.work_research_finished_with_the_evidence_collected)) }) { Text(stringResource(R.string.work_finish)) }
                    if (stateName == "paused" || stateName == "stopped" || stateName == "partial") OutlinedButton({ runAction("owner.research.continue", strings.getString(R.string.work_continue_research), true) { if (focus.isNotBlank()) put("focus", focus.trim()) } }) { Text(stringResource(R.string.work_continue)) }
                    if (stateName !in working && stateName != "paused") OutlinedButton({ runAction("owner.research.refresh", strings.getString(R.string.work_refresh_research), true) }) { Text(stringResource(R.string.action_refresh)) }
                    if (detail.list("evidence").isNotEmpty() && stateName !in working) OutlinedButton({ runAction("owner.research.resynthesize", strings.getString(R.string.work_rewrite_report), true) }) { Text(stringResource(R.string.work_rewrite)) }
                }
                detail.str("note")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                detail.int("monitorDays")?.takeIf { it > 0 }?.let { Text(stringResource(R.string.work_monitoring_every_days_was_authorized_on_the_desktop, it), style = MaterialTheme.typography.bodySmall) }
                if (detail.isTrue("stale")) Text(stringResource(R.string.work_some_evidence_is_stale_refresh_re_checks_it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                val runPlan = (detail["plan"] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
                if (runPlan.isNotEmpty()) Text(runPlan.mapIndexed { i, step -> "${i + 1}. $step" }.joinToString("\n"), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(focus, { focus = it }, Modifier.fillMaxWidth(), label = { Text(if (stateName in working) stringResource(R.string.work_steer_this_run) else stringResource(R.string.work_follow_up_question_or_focus)) }, minLines = 2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    if (stateName in working) Button({ runAction("owner.research.steer", strings.getString(R.string.work_research_direction_updated), true) { put("focus", focus.trim()) } }, enabled = focus.isNotBlank()) { Text(stringResource(R.string.work_steer)) }
                    else Button({ val q = focus.trim(); scope.launch { runCatching { signed(activity, repository, "owner.research.ask", buildJsonObject { put("id", detail.str("id").orEmpty()); put("question", q) }, strings.getString(R.string.work_ask_this_report_a_follow_up)) as JsonObject }
                        .onSuccess { answer = it.str("answer"); error = null }.onFailure { error = it.message } } }, enabled = focus.isNotBlank()) { Text(stringResource(R.string.work_ask_report)) }
                    OutlinedButton({ runAction("owner.research.update", if (detail.isTrue("pinned")) strings.getString(R.string.work_report_unpinned) else strings.getString(R.string.work_report_pinned)) { put("pinned", !detail.isTrue("pinned")) } }) { Text(if (detail.isTrue("pinned")) stringResource(R.string.work_unpin) else stringResource(R.string.work_pin)) }
                    if (detail.int("monitorDays")?.let { it > 0 } == true) OutlinedButton({ runAction("owner.research.update", strings.getString(R.string.work_monitoring_turned_off)) { put("monitorDays", 0) } }) { Text(stringResource(R.string.work_stop_monitoring)) }
                    OutlinedButton({ runAction("owner.research.update", if (detail.isTrue("archived")) strings.getString(R.string.work_report_restored) else strings.getString(R.string.work_report_archived)) { put("archived", !detail.isTrue("archived")) } }) { Text(if (detail.isTrue("archived")) stringResource(R.string.work_restore) else stringResource(R.string.work_archive)) }
                }
                answer?.let { SelectionContainer { Text(it) } }
                OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.work_note_on_this_research)) }, minLines = 2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    OutlinedButton({ runAction("owner.research.note", strings.getString(R.string.work_note_saved)) { put("text", note.trim()) } }, enabled = note.isNotBlank()) { Text(stringResource(R.string.work_save_note)) }
                    listOf("markdown", "csv", "bibtex", "json").forEach { format -> TextButton({ runAction("owner.research.export", strings.getString(R.string.work_added_to_this_conversations_library, format.uppercase())) { put("format", format) } }) { Text(format.uppercase()) } }
                }
                val changes = (detail["changes"] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
                if (changes.isNotEmpty()) Text(stringResource(R.string.work_since_the_last_version, changes.joinToString(" · ")), style = MaterialTheme.typography.bodySmall)
            }
            researchResultItems(detail, report, expandedPassage, working,
                onOpenReport = { versionId -> scope.launch {
                    runCatching { repository.request("owner.research.readReport", buildJsonObject { put("id", detail.str("id").orEmpty()); versionId?.let { put("versionId", it) } }) as JsonObject }
                        .onSuccess { report = it.str("text"); error = null }.onFailure { error = it.message }
                } },
                onPassage = { passageId ->
                    if (passageId == null) expandedPassage = null else scope.launch {
                        runCatching { repository.request("owner.research.passage", buildJsonObject {
                            put("id", detail.str("id").orEmpty()); put("passageId", passageId)
                            detail.obj("report")?.str("versionId")?.let { put("versionId", it) }
                        }) as JsonObject }.onSuccess { expandedPassage = it; error = null }.onFailure { error = it.message }
                    }
                },
                onExclude = { evidenceId -> runAction("owner.research.exclude", strings.getString(R.string.work_source_excluded)) { put("evidenceId", evidenceId) } })
        }
    }
}

/** Completed-report navigation is isolated from transport so it can be exercised with fixture DTOs on an emulator. */
internal fun LazyListScope.researchResultItems(
    detail: JsonObject,
    report: String?,
    expandedPassage: JsonObject?,
    working: Set<String>,
    onOpenReport: (String?) -> Unit,
    onPassage: (String?) -> Unit,
    onExclude: (String) -> Unit,
) {
    if (detail["reportText"] != null || detail.obj("report") != null) item(key = "research-report-actions") {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Button({ onOpenReport(null) }) { Text(stringResource(R.string.open_research_report)) }
            detail.list("revisions").forEachIndexed { index, revision ->
                TextButton({ onOpenReport(revision.str("versionId")) }) { Text(stringResource(R.string.report_revision, index + 1)) }
            }
        }
    }
    items(detail.list("findings"), key = { "f" + (it.str("id") ?: it.str("text")) }) { finding ->
        val citations = (finding["citations"] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
        ListItem(headlineContent = { Text(finding.str("text").orEmpty()) }, supportingContent = { Text(listOfNotNull(finding.str("status"), citations.takeIf { it.isNotEmpty() }?.joinToString(" · ")).joinToString(" · ")) },
            modifier = Modifier.clickable { onPassage(citations.firstOrNull()) })
    }
    items(detail.list("evidence"), key = { "e" + it.str("id") }) { evidence ->
        val status = evidence.str("status")
        Column {
            ListItem(headlineContent = { Text(stringResource(if (status == "excluded") R.string.excluded_evidence else R.string.normal_evidence, evidence.str("id").orEmpty(), evidence.str("title") ?: evidence.str("url").orEmpty()), maxLines = 2) },
                supportingContent = { Text(listOfNotNull(evidence.str("kind"), evidence.str("location"), evidence.str("retrievedAt"), if (evidence.isTrue("stale")) stringResource(R.string.stale_source) else null).joinToString(" · "), maxLines = 2) },
                trailingContent = { if (status != "excluded" && detail.str("state") !in working) TextButton({ onExclude(evidence.str("id").orEmpty()) }) { Text(stringResource(R.string.exclude_research_source)) } })
            evidence.list("passages").forEach { passage ->
                val passageId = passage.str("id").orEmpty()
                TextButton({ onPassage(if (expandedPassage?.str("id") == passageId) null else passageId) }) { Text("[$passageId] ${passage.str("location").orEmpty()}", maxLines = 1) }
                if (expandedPassage?.str("id") == passageId) SelectionContainer { Text(expandedPassage.str("text").orEmpty(), Modifier.padding(horizontal = PALLayout.groupGap), style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
    report?.let { text -> item(key = "research-report-text") { SelectionContainer { MarkdownText(text) } } }
}
// ── Canvas ───────────────────────────────────────────────────────────────────────────────────────

/** The desktop's isolated preview of a page, seen as frames; taps and typing go to the page, never anything else. */
@Composable
private fun CanvasTab(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var roots by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var rootId by rememberSaveable { mutableStateOf("") }
    var path by rememberSaveable { mutableStateOf("index.html") }
    var pages by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var choosingFolder by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<JsonObject?>(null) }
    var frame by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    var consoleLines by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var annotations by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var annotate by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Pair<Float, Float>?>(null) }
    var note by remember { mutableStateOf("") }
    var typing by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }
    val id = preview?.str("id")
    suspend fun refresh() {
        val current = id ?: return
        runCatching { repository.request("canvas.frame", buildJsonObject { put("sessionId", sessionId); put("id", current) }) as JsonObject }.onSuccess { value ->
            frame = withContext(Dispatchers.Default) {
                val bytes = Base64.decode(value.str("data").orEmpty().substringAfter("base64,"), Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }
        }.onFailure { error = it.message; if (it.message?.contains("closed") == true) preview = null }
        runCatching { repository.request("canvas.console", buildJsonObject { put("sessionId", sessionId); put("id", current) }) }.onSuccess { consoleLines = it.objects().takeLast(6) }
        runCatching { repository.request("canvas.annotations", buildJsonObject { put("sessionId", sessionId); put("id", current) }) }.onSuccess { annotations = it.objects() }
    }
    fun input(params: JsonObjectBuilder.() -> Unit) = scope.launch { runCatching { repository.request("canvas.input", buildJsonObject { put("sessionId", sessionId); put("id", id.orEmpty()); params() }) }.onFailure { error = it.message }; refresh() }
    LaunchedEffect(sessionId) {
        runCatching { repository.request("workbench.roots", buildJsonObject { put("sessionId", sessionId) }) as JsonObject }.onSuccess { roots = it.list("roots"); if (rootId.isEmpty()) rootId = roots.firstOrNull()?.str("id").orEmpty() }
        runCatching { repository.request("canvas.list", buildJsonObject { put("sessionId", sessionId) }) }.onSuccess { preview = it.objects().firstOrNull() }
    }
    LaunchedEffect(rootId) {
        if (rootId.isEmpty()) { pages = emptyList(); return@LaunchedEffect }
        val found = mutableListOf<JsonObject>()
        for (pattern in listOf("*.html", "*.htm", "*.svg")) runCatching { repository.request("workbench.files.find", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("path", ""); put("pattern", pattern) }) as JsonObject }
            .onSuccess { found += it.list("matches") }
        pages = found.distinctBy { it.str("path") }.sortedBy { it.str("path") }
    }
    LaunchedEffect(id) { while (id != null) { refresh(); kotlinx.coroutines.delay(1500) } }
    if (choosingFolder) return FolderChooser(repository, state.sessions.firstOrNull { it.id == sessionId }?.project, { choosingFolder = false }) { chosen, _ ->
        choosingFolder = false
        scope.launch {
            runCatching { signed(activity, repository, "workbench.addRoot", buildJsonObject { put("sessionId", sessionId); put("path", chosen); put("policy", buildJsonObject { put("write", false) }) }, strings.getString(R.string.work_use_in_this_conversation, chosen)) as JsonObject }
                .onSuccess { added -> roots = roots + added; rootId = added.str("id").orEmpty(); error = null }.onFailure { error = it.message }
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                roots.forEach { root -> FilterChip(root.str("id") == rootId, { rootId = root.str("id").orEmpty() }, { Text(root.str("name").orEmpty()) }) }
                AssistChip({ choosingFolder = true }, { Text(if (roots.isEmpty()) stringResource(R.string.work_choose_a_conversation_folder) else stringResource(R.string.work_add_a_folder)) }, leadingIcon = { Icon(Icons.Default.Add, null) })
            }
            if (pages.isNotEmpty()) {
                var pageMenu by remember { mutableStateOf(false) }
                Box {
                    OutlinedButton({ pageMenu = true }) { Text(stringResource(R.string.work_choose_html_or_svg)) }
                    DropdownMenu(pageMenu, { pageMenu = false }) { pages.forEach { page -> DropdownMenuItem({ Text(page.str("path").orEmpty()) }, { path = page.str("path").orEmpty(); pageMenu = false }) } }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedTextField(path, { path = it }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.work_page)) })
                Button({ scope.launch {
                    runCatching { signed(activity, repository, "canvas.open", buildJsonObject { put("sessionId", sessionId); put("rootId", rootId); put("path", path.trim()); put("width", 390); put("height", 844); put("mobile", true) }, strings.getString(R.string.work_preview_2, path)) as JsonObject }
                        .onSuccess { preview = it; error = null }.onFailure { error = it.message }
                } }, enabled = rootId.isNotEmpty() && path.isNotBlank()) { Text(stringResource(R.string.work_preview)) }
            }
            Status(error, info ?: preview?.let { strings.getString(R.string.work_snapshot_no_network, it.str("path"), it.str("revision"), it.int("width"), it.int("height")) })
        }
        if (id != null) {
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    listOf(Triple(strings.getString(R.string.work_phone), 390, 844), Triple(strings.getString(R.string.work_tablet), 820, 1180), Triple(stringResource(R.string.work_option_desktop), 1280, 800)).forEach { (label, w, h) ->
                        AssistChip({ scope.launch { runCatching { repository.mutate("canvas.resize", buildJsonObject { put("sessionId", sessionId); put("id", id); put("width", w); put("height", h); put("mobile", w < 1000) }) as JsonObject }.onSuccess { preview = it; refresh() } } }, { Text(label) })
                    }
                    FilterChip(annotate, { annotate = !annotate }, { Text(if (annotate) stringResource(R.string.work_tap_an_element) else stringResource(R.string.work_annotate)) })
                    if (annotate) AssistChip({ pending = .5f to .5f }, { Text(stringResource(R.string.work_pin_at_center)) })
                    AssistChip({ scope.launch { runCatching { repository.mutate("canvas.reload", buildJsonObject { put("sessionId", sessionId); put("id", id) }) as JsonObject }.onSuccess { preview = it; refresh() }.onFailure { error = it.message } } }, { Text(stringResource(R.string.work_reload)) })
                    AssistChip({ scope.launch { runCatching { repository.mutate("canvas.close", buildJsonObject { put("sessionId", sessionId); put("id", id) }) }; preview = null; frame = null } }, { Text(stringResource(R.string.action_close)) })
                }
            }
            item {
                frame?.let { bitmap ->
                    var size by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
                    Image(bitmap.asImageBitmap(), stringResource(R.string.work_preview_of, preview?.str("path").orEmpty()), Modifier.fillMaxWidth().onSizeChanged { size = it }.pointerInput(annotate, id) {
                        detectTapGestures { offset ->
                            val x = offset.x / size.width.coerceAtLeast(1); val y = offset.y / size.height.coerceAtLeast(1)
                            if (annotate) pending = x to y else input { put("kind", "click"); put("x", x.toDouble()); put("y", y.toDouble()) }
                        }
                    })
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    OutlinedTextField(typing, { typing = it }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.work_type_into_the_page)) })
                    TextButton({ val text = typing; typing = ""; input { put("kind", "type"); put("text", text) } }) { Text(stringResource(R.string.viewer_type)) }
                    TextButton({ input { put("kind", "key"); put("key", "Enter") } }) { Text(stringResource(R.string.viewer_enter)) }
                }
                consoleLines.forEach { line -> Text("${line.str("level")}: ${line.str("text")}", fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
            }
            if (annotations.isNotEmpty()) item {
                Text(stringResource(R.string.work_saved_notes), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
                annotations.forEach { annotation ->
                    val box = annotation.obj("box")
                    Text(stringResource(if (annotation.isTrue("current")) R.string.current_snapshot else R.string.previous_snapshot, annotation.str("note").orEmpty(), annotation.str("selector").orEmpty()), style = MaterialTheme.typography.bodySmall)
                    if (box != null) Text(stringResource(R.string.work_at, box.int("x") ?: box.num("x") ?: 0, box.int("y") ?: box.num("y") ?: 0), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
    pending?.let { location ->
        val (x, y) = location
        AlertDialog({ pending = null; note = "" }, title = { Text(stringResource(R.string.work_note_for_this_element)) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedTextField(note, { note = it }, label = { Text(stringResource(R.string.work_what_should_change_here)) })
                Text(stringResource(R.string.work_pin_position_across_down, (x * 100).toInt(), (y * 100).toInt()), style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    TextButton({ pending = (x - .05f).coerceAtLeast(0f) to y }) { Text(stringResource(R.string.work_move_left)) }
                    TextButton({ pending = (x + .05f).coerceAtMost(1f) to y }) { Text(stringResource(R.string.work_move_right)) }
                    TextButton({ pending = x to (y - .05f).coerceAtLeast(0f) }) { Text(stringResource(R.string.work_move_up)) }
                    TextButton({ pending = x to (y + .05f).coerceAtMost(1f) }) { Text(stringResource(R.string.work_move_down)) }
                }
            }
        },
            confirmButton = { Button({ val text = note; scope.launch {
                runCatching { repository.mutate("canvas.annotate", buildJsonObject { put("sessionId", sessionId); put("id", id.orEmpty()); put("x", x.toDouble()); put("y", y.toDouble()); put("note", text) }) as JsonObject }
                    .onSuccess { saved -> error = null; info = strings.getString(R.string.work_saved_note_at_across_down, (x * 100).toInt(), (y * 100).toInt()); annotations = annotations + saved; pending = null; note = "" }
                    .onFailure { error = it.message }
            } }, enabled = note.isNotBlank()) { Text(stringResource(R.string.work_pin_note)) } },
            dismissButton = { TextButton({ pending = null; note = "" }) { Text(stringResource(R.string.action_cancel)) } },
        )
    }
}

// ── Notes ────────────────────────────────────────────────────────────────────────────────────────

/** The project's scratchpad (conflict-aware, never overwritten silently) and the Daybook index. */
@Composable
private fun NotesTab(repository: PALRepository, state: MobileState, sessionId: String) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    val project = state.sessions.firstOrNull { it.id == sessionId }?.project.orEmpty()
    var text by rememberSaveable(project) { mutableStateOf("") }
    var saved by rememberSaveable(project) { mutableStateOf("") }
    var revision by rememberSaveable(project) { mutableStateOf("0") }
    var conflictText by rememberSaveable(project) { mutableStateOf<String?>(null) }
    var conflictRevision by rememberSaveable(project) { mutableStateOf<String?>(null) }
    var initialized by rememberSaveable(project) { mutableStateOf(false) }
    var editedBeforeLoad by rememberSaveable(project) { mutableStateOf(false) }
    var mountedReady by remember(project) { mutableStateOf(false) }
    var saving by remember(project) { mutableStateOf(false) }
    var refreshKey by remember(project) { mutableIntStateOf(0) }
    var day by remember { mutableStateOf(java.time.LocalDate.now()) }
    var items by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    suspend fun save() {
        if (!mountedReady || saving || text == saved || project.isEmpty() || conflictRevision != null) return
        saving = true
        try {
            while (mountedReady && conflictRevision == null && text != saved) {
                val draft = text
                val expectedRevision = revision
                val result = runCatching { repository.mutate("owner.notebook.save", buildJsonObject { put("project", project); put("text", draft); put("expectedRevision", expectedRevision) }) as JsonObject }
                result.onSuccess { value -> revision = value.str("revision") ?: revision; saved = draft; error = null }
                    .onFailure { failure ->
                        error = failure.message
                        if ((failure as? dev.otectus.pal.mobile.data.RemoteRequestException)?.code == "REVISION_CONFLICT") runCatching { repository.request("owner.notebook.scratchpad", buildJsonObject { put("project", project) }) as JsonObject }
                            .onSuccess { remote -> conflictText = remote.str("text").orEmpty(); conflictRevision = remote.str("revision") ?: revision; error = null }
                        return
                    }
            }
        } finally { saving = false }
    }
    LaunchedEffect(project, refreshKey) {
        if (project.isEmpty()) return@LaunchedEffect
        mountedReady = false
        runCatching { repository.request("owner.notebook.scratchpad", buildJsonObject { put("project", project) }) as JsonObject }.onSuccess { remote ->
            val remoteText = remote.str("text").orEmpty()
            val remoteRevision = remote.str("revision") ?: "0"
            when {
                !initialized && !editedBeforeLoad -> { text = remoteText; saved = remoteText; revision = remoteRevision }
                !initialized && text == remoteText -> { saved = remoteText; revision = remoteRevision }
                !initialized -> { saved = remoteText; revision = remoteRevision; conflictText = remoteText; conflictRevision = remoteRevision }
                remoteRevision == revision -> Unit
                text == saved || text == remoteText -> { text = remoteText; saved = remoteText; revision = remoteRevision; conflictText = null; conflictRevision = null }
                else -> { conflictText = remoteText; conflictRevision = remoteRevision }
            }
            initialized = true
            mountedReady = true
            error = null
        }.onFailure { error = it.message }
    }
    LaunchedEffect(text, mountedReady, conflictRevision) { if (mountedReady && conflictRevision == null) { kotlinx.coroutines.delay(1500); scope.launch { save() } } }
    LaunchedEffect(day) { runCatching { repository.request("owner.notebook.day", buildJsonObject { put("date", day.toString()); put("offsetMinutes", -java.time.ZoneId.systemDefault().rules.getOffset(java.time.Instant.now()).totalSeconds / 60) }) as JsonObject }.onSuccess { items = it.list("items") } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        item {
            Text(stringResource(R.string.work_scratchpad, project.substringAfterLast('/')), style = MaterialTheme.typography.titleSmall)
            OutlinedTextField(text, { text = it; if (!mountedReady) editedBeforeLoad = true }, Modifier.fillMaxWidth().heightIn(min = PALLayout.notesEditorHeight), placeholder = { Text(stringResource(R.string.work_quick_notes_for_this_project_nothing_reaches_a)) })
            Text(when { !mountedReady -> stringResource(R.string.work_checking_the_desktop_version); conflictRevision != null -> stringResource(R.string.work_choose_which_version_to_save); saving || text != saved -> stringResource(R.string.computer_saving); else -> stringResource(R.string.work_saved_on_the_desktop_revision, revision) }, style = MaterialTheme.typography.bodySmall, color = if (conflictRevision != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            conflictRevision?.let { remoteRevision ->
                val remoteText = conflictText.orEmpty()
                Text(stringResource(R.string.work_changed_on_another_device_autosave_is_paused_your), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                Text(stringResource(R.string.work_other_version), style = MaterialTheme.typography.labelLarge)
                SelectionContainer {
                    Text(remoteText.ifEmpty { strings.getString(R.string.work_the_other_version_is_empty) }, Modifier.fillMaxWidth().heightIn(max = PALLayout.comparisonHeight).verticalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    TextButton({ revision = remoteRevision; saved = remoteText; conflictRevision = null; conflictText = null; scope.launch { save() } }) { Text(stringResource(R.string.mobile_keep_mine)) }
                    TextButton({ revision = remoteRevision; text = remoteText; saved = remoteText; conflictRevision = null; conflictText = null; error = null }) { Text(stringResource(R.string.work_use_theirs)) }
                    TextButton({ revision = remoteRevision; saved = remoteText; text = listOf(remoteText, text).filter { it.isNotEmpty() }.joinToString("\n\n"); conflictRevision = null; conflictText = null; scope.launch { save() } }) { Text(stringResource(R.string.work_combine)) }
                }
            }
            Status(error.takeIf { conflictRevision == null }, null)
            if (error != null && conflictRevision == null) TextButton({ error = null; if (mountedReady) scope.launch { save() } else refreshKey++ }) { Text(stringResource(R.string.action_retry)) }
        }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.work_daybook, day), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                TextButton({ day = day.minusDays(1) }) { Text(stringResource(R.string.work_earlier)) }; TextButton({ day = day.plusDays(1) }) { Text(stringResource(R.string.work_later)) }
            }
        }
        items(items) { entry -> Text("${java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(entry.num("time") ?: 0))} · ${entry.str("kind")} · ${entry.str("title")}", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun researchState(state: String?) = when (state) {
    "planning" -> stringResource(R.string.status_planning)
    "searching" -> stringResource(R.string.status_searching)
    "reading" -> stringResource(R.string.status_reading_sources)
    "synthesizing" -> stringResource(R.string.status_writing_the_report)
    "refreshing" -> stringResource(R.string.status_refreshing_evidence)
    "completed" -> stringResource(R.string.status_complete)
    "partial" -> stringResource(R.string.status_partial_report)
    "paused" -> stringResource(R.string.status_paused)
    "stopped" -> stringResource(R.string.status_stopped)
    "failed" -> stringResource(R.string.status_failed)
    else -> state.orEmpty()
}
@Composable private fun MarkdownText(text: String) { Text(text, style = MaterialTheme.typography.bodyMedium) }

@Composable
private fun runState(state: String) = when (state) {
    "prepared" -> stringResource(R.string.status_prepared)
    "awaiting_approval" -> stringResource(R.string.status_waiting_for_your_approval)
    "queued" -> stringResource(R.string.status_queued)
    "dispatching" -> stringResource(R.string.status_sending)
    "running" -> stringResource(R.string.status_running)
    "cancel_requested" -> stringResource(R.string.status_cancelling)
    "completed" -> stringResource(R.string.status_complete)
    "failed" -> stringResource(R.string.status_failed)
    "cancelled" -> stringResource(R.string.status_cancelled)
    "declined" -> stringResource(R.string.status_declined)
    "expired" -> stringResource(R.string.status_expired)
    "interrupted" -> stringResource(R.string.status_interrupted)
    "unknown" -> stringResource(R.string.status_outcome_unknown)
    else -> state.orEmpty()
}
