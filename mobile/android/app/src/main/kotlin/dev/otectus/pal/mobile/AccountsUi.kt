@file:OptIn(ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** What an account's events, mail and drafts say, worked out once for every screen. */
internal object AccountText {
    val services = listOf("calendar", "mail", "drive", "github")
    fun label(service: String) = when (service) { "calendar" -> R.string.account_calendar; "mail" -> R.string.account_mail; "drive" -> R.string.account_drive; else -> R.string.account_github }
    fun access(account: JsonObject, service: String) = account.obj("access")?.str(service)
    fun day(time: JsonObject?): String = (time?.str("date") ?: time?.str("dateTime")).orEmpty().take(10)
    fun clock(time: JsonObject?): String = time?.str("dateTime")?.drop(11)?.take(5).orEmpty()
    /** The last day of an all-day event, which ends the day before its end date. */
    fun lastDay(event: JsonObject): String = day(event.obj("end")).let { end -> if (event.isTrue("allDay")) runCatching { LocalDate.parse(end).minusDays(1).toString() }.getOrDefault(end) else end }
    /** Events by the days they touch; an all-day event ends the day before its end date. */
    fun byDay(events: List<JsonObject>, from: LocalDate, days: Int): List<Pair<LocalDate, List<JsonObject>>> = (0 until days).mapNotNull { offset ->
        val day = from.plusDays(offset.toLong()); val text = day.toString()
        val rows = events.filter { event ->
            val allDay = event.isTrue("allDay"); val start = day(event.obj("start")); val end = day(event.obj("end"))
            val last = lastDay(event)
            start <= text && last >= text && !(!allDay && start < text && end == text && clock(event.obj("end")) == "00:00")
        }
        if (rows.isEmpty()) null else day to rows
    }
    fun time(event: JsonObject, day: LocalDate, zone: String, allDay: String): String {
        if (event.isTrue("allDay")) return allDay
        val text = day.toString(); val start = if (day(event.obj("start")) == text) clock(event.obj("start")) else "…"; val end = if (day(event.obj("end")) == text) clock(event.obj("end")) else "…"
        val own = event.obj("start")?.str("timeZone")
        return "$start–$end" + if (own != null && own != zone) " " + own.substringAfterLast('/').replace('_', ' ') else ""
    }
    fun emails(text: String) = text.split(Regex("[,;\\s]+")).map(String::trim).filter(String::isNotEmpty)
    fun person(address: JsonObject?): String? = address?.str("name") ?: address?.str("email")
    /** A reply names the sender, keeps the subject and quotes a bounded part. */
    fun reply(message: JsonObject, wrote: String): JsonObject = buildJsonObject {
        put("to", JsonArray(listOfNotNull(message.obj("from")?.str("email")).map(::JsonPrimitive)))
        val subject = message.str("subject").orEmpty(); put("subject", if (subject.startsWith("re:", true)) subject else "Re: $subject")
        put("text", "\n\n$wrote\n" + message.str("text").orEmpty().lines().take(80).joinToString("\n") { "> $it" })
        put("reply", buildJsonObject { put("threadId", message.str("threadId").orEmpty()); put("messageId", message.str("id").orEmpty()) })
    }
    fun state(write: JsonObject) = when (write.str("state")) {
        "sent" -> if (write.str("origin") == "routine") R.string.account_write_routine else R.string.account_write_sent
        "sending" -> R.string.account_write_sending; "unknown" -> R.string.account_write_unknown; "failed" -> R.string.account_write_failed
        else -> if (write.str("origin") == "assistant") R.string.account_write_assistant else R.string.account_write_draft
    }
    fun open(write: JsonObject) = write.str("state") in setOf("draft", "failed", "unknown")
}

// ── Settings › This computer › Accounts ──────────────────────────────────────────────────────────

@Composable
internal fun AccountsSection(repository: PALRepository, state: MobileState, activity: FragmentActivity, saved: (String) -> Unit, failed: (String) -> Unit) {
    val scope = rememberOwnerScope(); val strings = LocalResources.current
    var info by remember { mutableStateOf<JsonObject?>(null) }
    var editing by remember { mutableStateOf<JsonObject?>(null) }
    var adding by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf<JsonObject?>(null) }
    var removing by remember { mutableStateOf<JsonObject?>(null) }
    suspend fun load() { ownerCall { repository.read("owner.accounts.list", buildJsonObject {}) as JsonObject }.onSuccess { info = it }.onFailure { failed(it.message.orEmpty()) } }
    LaunchedEffect(Unit) { load() }
    val accounts = info?.list("accounts").orEmpty(); val providers = info?.list("providers").orEmpty(); val flows = info?.list("flows").orEmpty()
    // While a code waits to be entered, its progress is asked for; the desktop talks to the service at the service's pace.
    val waiting = flows.any { it.str("state") == "waiting" }
    LaunchedEffect(waiting) { while (waiting) { delay(3_000); load() } }
    fun act(method: String, params: JsonObject, title: String, done: (JsonObject) -> Unit = {}) = scope.launch {
        ownerCall { signed(activity, repository, method, params, title) }.onSuccess { (it as? JsonObject)?.let(done); load() }.onFailure { failed(it.message.orEmpty()) }
    }
    Text(stringResource(R.string.account_intro), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (info != null && accounts.isEmpty()) Text(stringResource(R.string.account_none))
    accounts.forEach { account ->
        val id = account.str("id").orEmpty(); val label = account.str("label").orEmpty(); val provider = providers.firstOrNull { it.str("id") == account.str("provider") }
        AccountCard(account, provider, flows.firstOrNull { it.str("accountId") == id && it.str("state") in setOf("waiting", "failed") }, state.supports("owner.accounts.signIn"),
            signIn = { act("owner.accounts.signIn", buildJsonObject { put("id", id); put("method", "device") }, strings.getString(R.string.account_sign_in_action, label)) },
            useToken = { token = account }, edit = { editing = account },
            signOut = { act("owner.accounts.signOut", buildJsonObject { put("id", id) }, strings.getString(R.string.account_sign_out_action, label)) { saved(strings.getString(R.string.account_signed_out)) } },
            check = { scope.launch { ownerCall { repository.read("owner.accounts.test", buildJsonObject { put("id", id) }) as JsonObject }.onSuccess { saved(strings.getString(R.string.account_works, it.str("login").orEmpty())) }.onFailure { failed(it.message.orEmpty()) } } },
            remove = { removing = account },
            cancel = { flow -> scope.launch { ownerCall { repository.mutate("owner.accounts.cancel", buildJsonObject { put("id", flow) }) }; load() } })
        HorizontalDivider()
    }
    OutlinedButton({ adding = true }, Modifier.heightIn(min = PALLayout.target), enabled = providers.isNotEmpty()) { Text(stringResource(R.string.account_add)) }
    if (adding || editing != null) AccountEditor(editing, providers, state.projects.mapNotNull { it.path }, { adding = false; editing = null }) { params ->
        act("owner.accounts.save", params, strings.getString(R.string.account_save_action)) { adding = false; editing = null; saved(strings.getString(R.string.account_saved)) }
    }
    token?.let { account -> TokenDialog(account.str("label").orEmpty(), { token = null }) { value ->
        token = null
        act("owner.accounts.signIn", buildJsonObject { put("id", account.str("id").orEmpty()); put("method", "token"); put("token", value) }, strings.getString(R.string.account_sign_in_action, account.str("label").orEmpty())) { saved(strings.getString(R.string.account_signed_in_as, it.obj("account")?.str("login").orEmpty())) }
    } }
    removing?.let { account -> AlertDialog({ removing = null }, title = { Text(stringResource(R.string.account_remove_title, account.str("label").orEmpty())) }, text = { Text(stringResource(R.string.account_remove_body)) },
        confirmButton = { TextButton({ removing = null; act("owner.accounts.remove", buildJsonObject { put("id", account.str("id").orEmpty()) }, strings.getString(R.string.account_remove_title, account.str("label").orEmpty())) { saved(strings.getString(R.string.account_removed)) } }) { Text(stringResource(R.string.account_remove), color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ removing = null }) { Text(stringResource(R.string.action_cancel)) } }) }
}

@Composable
internal fun AccountCard(account: JsonObject, provider: JsonObject?, flow: JsonObject?, enabled: Boolean, signIn: () -> Unit, useToken: () -> Unit, edit: () -> Unit, signOut: () -> Unit, check: () -> Unit, remove: () -> Unit, cancel: (String) -> Unit) {
    val context = LocalContext.current; val uri = LocalUriHandler.current; val strings = LocalResources.current
    var refused by remember(account.str("id")) { mutableStateOf(false) }
    val state = account.str("state"); val methods = provider?.strings("methods").orEmpty()
    Text("${account.str("label").orEmpty()} · ${account.str("providerLabel").orEmpty()}", style = MaterialTheme.typography.titleSmall)
    Text(when (state) {
        "signed-in" -> stringResource(R.string.account_signed_in_as, account.str("login").orEmpty())
        "more" -> stringResource(R.string.account_more, account.str("login").orEmpty())
        "problem" -> account.str("problem").orEmpty()
        else -> stringResource(R.string.account_signed_out_state)
    }, color = when (state) { "signed-in" -> MaterialTheme.colorScheme.primary; "signed-out" -> MaterialTheme.colorScheme.onSurfaceVariant; else -> MaterialTheme.colorScheme.tertiary })
    val uses = AccountText.services.mapNotNull { service -> account.obj("services")?.str(service)?.let { stringResource(if (it == "write") R.string.account_use_write else R.string.account_use_read, stringResource(AccountText.label(service))) } }
    Text(uses.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(stringResource(when (account.str("ai")) { "read" -> R.string.account_ai_read; "write" -> R.string.account_ai_write; else -> R.string.account_ai_off }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (flow?.str("state") == "waiting") {
        val code = flow.str("userCode").orEmpty()
        if (code.isNotEmpty()) {
            Text(stringResource(R.string.account_enter_code, flow.str("address").orEmpty().removePrefix("https://")))
            val spoken = stringResource(R.string.account_code_spoken, code.toList().joinToString(" "))
            SelectionContainer { Text(code, Modifier.semantics { contentDescription = spoken }, style = MaterialTheme.typography.headlineMedium, fontFamily = FontFamily.Monospace) }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                Button({ refused = !uri.open(flow.str("complete") ?: flow.str("address")) }, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.account_open_page)) }
                OutlinedButton({ copyText(context, strings.getString(R.string.account_code), code) }, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.account_copy_code)) }
                TextButton({ cancel(flow.str("id").orEmpty()) }, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.action_cancel)) }
            }
        } else Text(stringResource(R.string.account_waiting_desktop))
        if (refused) Text(stringResource(R.string.open_refused), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        Text(stringResource(R.string.account_waiting), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall)
    } else flow?.str("message")?.let { Text(it, color = MaterialTheme.colorScheme.tertiary) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        if (flow?.str("state") != "waiting" && state != "signed-in") {
            if ("device" in methods) OutlinedButton(signIn, Modifier.heightIn(min = PALLayout.target), enabled = enabled && account.str("clientId").orEmpty().isNotEmpty()) { Text(stringResource(R.string.account_sign_in_code)) }
            if ("token" in methods) OutlinedButton(useToken, Modifier.heightIn(min = PALLayout.target), enabled = enabled) { Text(stringResource(R.string.account_use_token)) }
        }
        TextButton(edit, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.account_edit)) }
        if (state == "signed-in") TextButton(check, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.account_check)) }
        if (state != "signed-out") TextButton(signOut, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.account_sign_out)) }
        TextButton(remove, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.account_remove), color = MaterialTheme.colorScheme.error) }
    }
    if (state != "signed-in" && "device" !in methods && "token" !in methods) Text(stringResource(R.string.account_desktop_only, account.str("providerLabel").orEmpty()), style = MaterialTheme.typography.bodySmall)
    else if (state != "signed-in" && "token" !in methods && account.str("clientId").isNullOrEmpty()) Text(stringResource(R.string.account_needs_client), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun TokenDialog(label: String, dismiss: () -> Unit, use: (String) -> Unit) {
    var value by remember { mutableStateOf("") }
    ToolDialog(stringResource(R.string.account_token_title, label), dismiss, { TextButton({ use(value.trim()) }, enabled = value.trim().length >= 10) { Text(stringResource(R.string.account_sign_in)) } }) {
        Text(stringResource(R.string.account_token_detail), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(value, { value = it.take(500) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.account_token)) }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
    }
}

@Composable
internal fun AccountEditor(account: JsonObject?, providers: List<JsonObject>, projects: List<String>, dismiss: () -> Unit, save: (JsonObject) -> Unit) {
    var providerId by rememberSaveable { mutableStateOf(account?.str("provider") ?: providers.firstOrNull()?.str("id").orEmpty()) }
    val provider = providers.firstOrNull { it.str("id") == providerId }
    val services = provider?.strings("services").orEmpty()
    var label by rememberSaveable { mutableStateOf(account?.str("label").orEmpty()) }
    var client by rememberSaveable { mutableStateOf(account?.str("clientId").orEmpty()) }
    var secret by remember { mutableStateOf("") }
    var uses by remember(providerId) { mutableStateOf(services.associateWith { account?.obj("services")?.str(it) ?: if (account == null) "read" else "off" }) }
    var ai by rememberSaveable { mutableStateOf(account?.str("ai") ?: "off") }
    var cloud by rememberSaveable { mutableStateOf(account?.obj("destinations")?.isTrue("cloud") == true) }
    var remote by rememberSaveable { mutableStateOf(account?.obj("destinations")?.isTrue("remote") == true) }
    var chosen by remember { mutableStateOf((account?.get("projects") as? JsonArray)?.texts()) }
    ToolDialog(stringResource(if (account == null) R.string.account_add_title else R.string.account_edit_title), dismiss, {
        TextButton({ save(buildJsonObject {
            if (account != null) { put("id", account.str("id").orEmpty()); put("expectedRevision", account.str("revision").orEmpty()) } else put("provider", providerId)
            put("label", label.trim().ifEmpty { provider?.str("label").orEmpty() }); put("clientId", client.trim()); if (secret.isNotEmpty()) put("clientSecret", secret)
            put("services", buildJsonObject { uses.forEach { (service, use) -> put(service, use) } }); put("ai", ai)
            put("destinations", buildJsonObject { put("remote", remote || cloud); put("cloud", cloud) }); put("projects", chosen?.let { JsonArray(it.map(::JsonPrimitive)) } ?: JsonNull)
        }) }, enabled = providerId.isNotEmpty() && uses.values.any { it != "off" }) { Text(stringResource(R.string.account_save)) }
    }) {
        if (account == null) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { providers.forEach { item -> FilterChip(providerId == item.str("id"), { providerId = item.str("id").orEmpty() }, { Text(item.str("label").orEmpty()) }) } }
        OutlinedTextField(label, { label = it.take(60) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.account_name)) })
        services.forEach { service ->
            Text(stringResource(AccountText.label(service)), style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("off" to R.string.account_off, "read" to R.string.account_read, "write" to R.string.account_change).forEach { (value, text) -> FilterChip(uses[service] == value, { uses = uses + (service to value) }, { Text(stringResource(text)) }) } }
        }
        Text(stringResource(when (providerId) { "github" -> R.string.account_steps_github; "google" -> R.string.account_steps_google; else -> R.string.account_steps_microsoft }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(client, { client = it.take(300) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.account_client)) })
        if (providerId == "google") OutlinedTextField(secret, { secret = it.take(1000) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(if (account?.isTrue("secretSet") == true) R.string.account_secret_saved else R.string.account_secret)) }, visualTransformation = PasswordVisualTransformation())
        Text(stringResource(R.string.account_assistants), style = MaterialTheme.typography.labelLarge)
        listOf("off" to R.string.account_ai_off, "read" to R.string.account_ai_read, "write" to R.string.account_ai_write).forEach { (value, text) -> Choice(stringResource(text), ai == value) { ai = value } }
        if (ai != "off") {
            Choice(stringResource(R.string.account_models_local), !remote && !cloud) { remote = false; cloud = false }
            Choice(stringResource(R.string.account_models_remote), remote && !cloud) { remote = true; cloud = false }
            Choice(stringResource(R.string.account_models_cloud), cloud) { remote = true; cloud = true }
            ToolCheck(stringResource(R.string.account_every_project), chosen == null) { chosen = if (it) null else emptyList() }
            chosen?.let { list -> projects.forEach { path -> ToolCheck(path, path in list) { on -> chosen = if (on) list + path else list - path } } }
        }
    }
}

// ── Work › Accounts ──────────────────────────────────────────────────────────────────────────────

@Composable
internal fun AccountsTab(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, openSettings: () -> Unit) {
    if (!state.supports("owner.accounts.list")) return WorkNotice(stringResource(R.string.account_title), stringResource(R.string.account_update_desktop))
    val scope = rememberCoroutineScope(); val strings = LocalResources.current
    var accounts by remember { mutableStateOf<List<JsonObject>?>(null) }
    var service by rememberSaveable { mutableStateOf("calendar") }
    var chosen by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var review by remember { mutableStateOf<JsonObject?>(null) }
    var reviewError by remember { mutableStateOf<String?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    fun run(work: suspend () -> Unit) { scope.launch { busy = true; error = null; try { work() } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } finally { busy = false } } }
    suspend fun ask(method: String, params: JsonObjectBuilder.() -> Unit) = repository.read("owner.accounts.$method", buildJsonObject(params)) as JsonObject
    LaunchedEffect(revision) { ownerCall { ask("list") {} }.onSuccess { accounts = it.list("accounts") }.onFailure { error = it.message } }
    val usable = accounts.orEmpty().filter { AccountText.access(it, service) != null }
    val account = usable.firstOrNull { it.str("id") == chosen } ?: usable.firstOrNull(); val accountId = account?.str("id").orEmpty()
    val writable = account != null && AccountText.access(account, service) == "write"
    /** A write is a draft first: prepared, shown in full, and sent by its own button. */
    fun prepare(params: JsonObjectBuilder.() -> Unit, done: () -> Unit = {}) = run { review = signed(activity, repository, "owner.accounts.draft", buildJsonObject { put("sessionId", sessionId); params() }, strings.getString(R.string.account_draft_action)) as JsonObject; reviewError = null; done(); revision++ }
    fun keep(params: JsonObjectBuilder.() -> Unit) = run { val kept = signed(activity, repository, "owner.accounts.import", buildJsonObject { put("sessionId", sessionId); put("accountId", accountId); params() }, strings.getString(R.string.account_keep_action)) as JsonObject; notice = strings.getString(R.string.account_kept, kept.str("name").orEmpty()) }
    Column(Modifier.fillMaxSize()) {
        FlowRow(Modifier.padding(horizontal = PALLayout.groupGap), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            (AccountText.services + "outbox").forEach { item -> FilterChip(service == item, { service = item; error = null; notice = null }, { Text(stringResource(when (item) { "calendar" -> R.string.account_agenda; "outbox" -> R.string.account_drafts; else -> AccountText.label(item) })) }) }
            if (service != "outbox" && usable.size > 1) usable.forEach { item -> AssistChip({ chosen = item.str("id").orEmpty() }, { Text(item.str("label").orEmpty()) }, enabled = item.str("id") != accountId) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        Column(Modifier.padding(horizontal = PALLayout.groupGap)) {
            error?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error) }
            notice?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.primary) }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (service == "outbox") DraftsView(revision, { ask("outbox") {} }, review = { review = it; reviewError = null },
                check = { id -> run { signed(activity, repository, "owner.accounts.check", buildJsonObject { put("id", id) }, strings.getString(R.string.account_check_action)); revision++ } },
                discard = { id -> run { repository.mutate("owner.accounts.discard", buildJsonObject { put("id", id) }); revision++ } })
            else if (accounts == null) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { if (error == null) CircularProgressIndicator() }
            else if (account == null) Column(Modifier.padding(PALLayout.sectionGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) { Text(stringResource(R.string.account_connect_hint)); Button(openSettings, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.account_connect)) } }
            else key(accountId, service) { when (service) {
                "calendar" -> AgendaView(writable, revision, { from, to -> ask("agenda") { put("accountId", accountId); put("from", from); put("to", to) }.list("events") },
                    save = { event, value, done -> prepare({ put("accountId", accountId); put("event", value); if (event != null) { put("kind", "calendar.update"); put("calendarId", event.str("calendarId").orEmpty()); put("eventId", event.str("id").orEmpty()); put("revision", event.str("revision").orEmpty()) } else put("kind", "calendar.create") }, done) },
                    remove = { event -> prepare({ put("accountId", accountId); put("kind", "calendar.remove"); put("calendarId", event.str("calendarId").orEmpty()); put("eventId", event.str("id").orEmpty()); put("revision", event.str("revision").orEmpty()) }) })
                "mail" -> MailView(writable, { text -> ask("mailSearch") { put("accountId", accountId); put("query", text) }.list("threads") }, { id -> ask("mailThread") { put("accountId", accountId); put("threadId", id) }.list("messages") },
                    keepThread = { id -> keep { put("what", "mail"); put("threadId", id) } }, keepAttachment = { message, item -> keep { put("what", "attachment"); put("messageId", message); put("attachmentId", item.str("id").orEmpty()); put("name", item.str("name").orEmpty()) } },
                    save = { mail, done -> prepare({ put("accountId", accountId); put("kind", "mail.send"); put("mail", mail) }, done) })
                "drive" -> DriveView({ text -> ask("driveSearch") { put("accountId", accountId); put("query", text) }.list("items") }, { folder -> ask("driveList") { put("accountId", accountId); folder?.let { put("folderId", it) } }.list("items") }) { id -> keep { put("what", "drive"); put("fileId", id) } }
                else -> GitHubView(writable, { kind, text -> ask("githubSearch") { put("accountId", accountId); put("kind", kind); put("query", text) }.list("items") }, { what, item -> ask("githubRead") { put("accountId", accountId); put("what", what); put("repo", item.str("repo").orEmpty()); item.num("number")?.let { put("number", it) }; item.str("path")?.let { put("path", it) } } },
                    keep = { what, item -> keep { put("what", "github"); put("github", buildJsonObject { put("what", what); put("repo", item.str("repo").orEmpty()); item.num("number")?.let { put("number", it) }; item.str("path")?.let { put("path", it) } }) } },
                    save = { write, done -> prepare({ put("accountId", accountId); put("kind", "github"); put("write", write) }, done) })
            } }
        }
    }
    review?.let { write -> ReviewWrite(write, busy, reviewError, { review = null }) {
        scope.launch {
            busy = true; reviewError = null
            ownerCall { signed(activity, repository, "owner.accounts.commit", buildJsonObject { put("id", write.str("id").orEmpty()); put("digest", write.str("digest").orEmpty()) }, write.str("title").orEmpty()) as JsonObject }
                .onSuccess { if (it.str("state") == "sent") { review = null; notice = strings.getString(R.string.account_done, it.str("title").orEmpty()) } else { review = it; reviewError = it.str("error") }; revision++ }.onFailure { reviewError = it.message }
            busy = false
        }
    } }
}

/** Exactly what will be written, and the one button that writes it. */
@Composable
internal fun ReviewWrite(write: JsonObject, busy: Boolean, error: String?, keep: () -> Unit, send: () -> Unit) {
    AlertDialog({ if (!busy) keep() }, title = { Text(write.str("title").orEmpty()) }, text = {
        Column(Modifier.heightIn(max = PALLayout.dialogBodyHeight).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            SelectionContainer { Text(write.str("description").orEmpty()) }
            if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            (error ?: write.str("error"))?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = if (write.str("state") == "unknown") MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton(send, enabled = !busy && write.str("state") in setOf("draft", "failed")) { Text(stringResource(when { write.str("kind") == "calendar.remove" -> R.string.account_delete; write.str("service") == "mail" -> R.string.account_send; write.str("service") == "calendar" -> R.string.account_save; write.str("service") == "drive" -> R.string.account_upload; else -> R.string.account_post }), color = if (write.str("kind") == "calendar.remove") MaterialTheme.colorScheme.error else linkColor()) } },
        dismissButton = { TextButton(keep, enabled = !busy) { Text(stringResource(R.string.account_keep_draft)) } })
}
@Composable private fun linkColor() = MaterialTheme.colorScheme.primary

@Composable
private fun <T> rememberLoad(vararg keys: Any?, load: suspend () -> T): Pair<T?, String?> {
    var value by remember { mutableStateOf<T?>(null) }; var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(*keys) { try { value = load(); error = null } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } }
    return value to error
}
@Composable private fun Problem(text: String?) { text?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error) } }
@Composable private fun RowItem(title: String, detail: String, note: String? = null, strong: Boolean = false, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = PALLayout.target).padding(vertical = PALLayout.small)) {
        Text(title, fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        note?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis) }
    }
}
private val listPadding = PaddingValues(horizontal = PALLayout.groupGap, vertical = PALLayout.small)

@Composable
internal fun AgendaView(writable: Boolean, revision: Int, load: suspend (Long, Long) -> List<JsonObject>, save: (JsonObject?, JsonObject, () -> Unit) -> Unit, remove: (JsonObject) -> Unit, today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()) {
    var from by rememberSaveable(stateSaver = androidx.compose.runtime.saveable.Saver({ it.toString() }, { LocalDate.parse(it) })) { mutableStateOf(today) }
    var editing by remember { mutableStateOf<JsonObject?>(null) }; var creating by remember { mutableStateOf(false) }; var open by rememberSaveable { mutableStateOf("") }
    val days = 14
    val (events, error) = rememberLoad(from, revision) { load(from.atStartOfDay(zone).toInstant().toEpochMilli(), from.plusDays(days.toLong()).atStartOfDay(zone).toInstant().toEpochMilli()) }
    val uri = LocalUriHandler.current; val allDay = stringResource(R.string.account_all_day)
    val groups = remember(events, from) { AccountText.byDay(events.orEmpty(), from, days) }
    LazyColumn(contentPadding = listPadding) {
        item { FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            TextButton({ from = from.minusDays(days.toLong()) }) { Text(stringResource(R.string.account_earlier)) }
            TextButton({ from = today }, enabled = from != today) { Text(stringResource(R.string.account_today)) }
            TextButton({ from = from.plusDays(days.toLong()) }) { Text(stringResource(R.string.account_later)) }
            if (writable) Button({ creating = true }) { Text(stringResource(R.string.account_new_event)) }
        }; Problem(error); if (events != null && groups.isEmpty()) Text(pluralStringResource(R.plurals.account_nothing_days, days, days)) }
        groups.forEach { (day, rows) ->
            item(key = day.toString()) { Text((if (day == today) stringResource(R.string.account_today) + " · " else "") + day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.FULL)), Modifier.padding(top = PALLayout.small).semantics { heading() }, style = MaterialTheme.typography.titleSmall) }
            // One event can be in several calendars under the same ID.
            keyedItems(rows, { "$day ${it.str("calendarId")} ${it.str("id")}" }) { event ->
                val id = event.str("id").orEmpty(); val guests = event.list("attendees").size
                RowItem(AccountText.time(event, day, zone.id, allDay) + "  " + event.str("title").orEmpty(), listOfNotNull(event.str("location"), event.str("recurrence"), if (guests > 0) pluralStringResource(R.plurals.account_guests, guests, guests) else null).joinToString(" · "), if (open == id) event.str("notes") else null) { open = if (open == id) "" else id }
                if (open == id) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    if (writable && event.isTrue("canEdit")) { TextButton({ editing = event }) { Text(stringResource(R.string.account_change_event)) }; TextButton({ remove(event) }) { Text(stringResource(R.string.account_delete_event), color = MaterialTheme.colorScheme.error) } }
                    event.str("link")?.let { link -> TextButton({ uri.open(link) }) { Text(stringResource(R.string.account_open_service)) } }
                }
            }
        }
    }
    if (creating || editing != null) EventEditor(editing, from, zone, { creating = false; editing = null }) { value -> save(editing, value) { creating = false; editing = null } }
}

@Composable
internal fun EventEditor(event: JsonObject?, day: LocalDate, zone: ZoneId, dismiss: () -> Unit, save: (JsonObject) -> Unit) {
    var title by rememberSaveable { mutableStateOf(event?.str("title").orEmpty()) }
    var allDay by rememberSaveable { mutableStateOf(event?.isTrue("allDay") == true) }
    var startDay by rememberSaveable { mutableStateOf(event?.let { AccountText.day(it.obj("start")) } ?: day.toString()) }; var startTime by rememberSaveable { mutableStateOf(event?.let { AccountText.clock(it.obj("start")) }?.ifEmpty { null } ?: "09:00") }
    var endDay by rememberSaveable { mutableStateOf(event?.let(AccountText::lastDay) ?: day.toString()) }; var endTime by rememberSaveable { mutableStateOf(event?.let { AccountText.clock(it.obj("end")) }?.ifEmpty { null } ?: "10:00") }
    var place by rememberSaveable { mutableStateOf(event?.str("location").orEmpty()) }; var notes by rememberSaveable { mutableStateOf(event?.str("notes").orEmpty()) }
    var guests by rememberSaveable { mutableStateOf(event?.list("attendees").orEmpty().mapNotNull { it.str("email") }.joinToString(", ")) }; var repeat by rememberSaveable { mutableStateOf("") }
    val own = event?.obj("start")?.str("timeZone") ?: zone.id
    val valid = title.isNotBlank() && listOf(startDay, endDay).all { runCatching { LocalDate.parse(it) }.isSuccess } && (allDay || listOf(startTime, endTime).all { Regex("([01]\\d|2[0-3]):[0-5]\\d").matches(it) })
    ToolDialog(stringResource(if (event == null) R.string.account_new_event else R.string.account_change_event), dismiss, { TextButton({ save(buildJsonObject {
        put("title", title.trim())
        fun time(day: String, clock: String) = buildJsonObject { if (allDay) put("date", day) else { put("dateTime", "${day}T$clock"); put("timeZone", own) } }
        put("start", time(startDay, startTime)); put("end", time(if (allDay) LocalDate.parse(endDay).plusDays(1).toString() else endDay, endTime))
        if (place.isNotBlank()) put("location", place.trim()); if (notes.isNotBlank()) put("notes", notes); val people = AccountText.emails(guests); if (people.isNotEmpty()) put("attendees", JsonArray(people.map(::JsonPrimitive))); if (repeat.isNotEmpty()) put("recurrence", buildJsonObject { put("every", repeat) })
    }) }, enabled = valid) { Text(stringResource(R.string.account_review)) } }) {
        OutlinedTextField(title, { title = it.take(300) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.account_event_title)) })
        ToolCheck(stringResource(R.string.account_all_day), allDay) { allDay = it }
        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { OutlinedTextField(startDay, { startDay = it.take(10) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.account_starts)) }); if (!allDay) OutlinedTextField(startTime, { startTime = it.take(5) }, Modifier.weight(0.6f), singleLine = true, label = { Text(stringResource(R.string.account_time)) }) }
        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { OutlinedTextField(endDay, { endDay = it.take(10) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.account_ends)) }); if (!allDay) OutlinedTextField(endTime, { endTime = it.take(5) }, Modifier.weight(0.6f), singleLine = true, label = { Text(stringResource(R.string.account_time)) }) }
        if (!allDay) Text(stringResource(R.string.account_zone, own.replace('_', ' ')), style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("" to R.string.account_once, "day" to R.string.account_daily, "week" to R.string.account_weekly, "month" to R.string.account_monthly, "year" to R.string.account_yearly).forEach { (value, text) -> FilterChip(repeat == value, { repeat = value }, { Text(stringResource(text)) }) } }
        OutlinedTextField(place, { place = it.take(500) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.account_where)) })
        OutlinedTextField(guests, { guests = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.account_guests_field)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        OutlinedTextField(notes, { notes = it.take(8000) }, Modifier.fillMaxWidth(), minLines = 2, label = { Text(stringResource(R.string.account_notes)) })
    }
}

@Composable
internal fun MailView(writable: Boolean, search: suspend (String) -> List<JsonObject>, thread: suspend (String) -> List<JsonObject>, keepThread: (String) -> Unit, keepAttachment: (String, JsonObject) -> Unit, save: (JsonObject, () -> Unit) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }; var asked by rememberSaveable { mutableStateOf("") }; var open by rememberSaveable { mutableStateOf("") }
    var writing by remember { mutableStateOf<JsonObject?>(null) }
    val strings = LocalResources.current
    val (threads, error) = rememberLoad(asked) { search(asked) }
    val (messages, threadError) = rememberLoad(open) { if (open.isEmpty()) null else thread(open) }
    LazyColumn(contentPadding = listPadding) {
        if (open.isEmpty()) {
            item { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedTextField(query, { query = it.take(300) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.account_search_mail)) }); TextButton({ asked = query.trim() }) { Text(stringResource(R.string.account_search)) } }
                if (writable) OutlinedButton({ writing = buildJsonObject {} }) { Text(stringResource(R.string.account_write)) }; Problem(error); if (threads != null && threads.isEmpty()) Text(stringResource(R.string.account_no_mail)) }
            keyedItems(threads.orEmpty(), { it.str("id").orEmpty() }) { item -> RowItem(item.str("subject").orEmpty(), listOfNotNull(AccountText.person(item.obj("from")), item.num("date")?.let(::shortTime), if (item.isTrue("unread")) stringResource(R.string.account_unread) else null).joinToString(" · "), item.str("snippet"), item.isTrue("unread")) { open = item.str("threadId").orEmpty() } }
        } else {
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    TextButton({ open = "" }) { Text(stringResource(R.string.go_back)) }
                    TextButton({ keepThread(open) }) { Text(stringResource(R.string.account_use_here)) }
                    if (writable && !messages.isNullOrEmpty()) TextButton({ val last = messages.last(); writing = AccountText.reply(last, strings.getString(R.string.account_wrote, AccountText.person(last.obj("from")).orEmpty())) }) { Text(stringResource(R.string.account_reply)) }
                }
                Problem(threadError); Text(messages?.firstOrNull()?.str("subject").orEmpty(), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            }
            keyedItems(messages.orEmpty(), { it.str("id").orEmpty() }) { message -> Column(Modifier.padding(vertical = PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                Text(AccountText.person(message.obj("from")) ?: stringResource(R.string.account_unknown_sender), fontWeight = FontWeight.SemiBold)
                Text(listOfNotNull(message.num("date")?.let(::shortTime), stringResource(R.string.account_to, (message.list("to") + message.list("cc")).mapNotNull { it.str("email") }.joinToString(", "))).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer { Text(message.str("text").orEmpty() + if (message.isTrue("truncated")) "\n\n" + stringResource(R.string.account_shortened) else "") }
                message.list("attachments").forEach { item -> TextButton({ keepAttachment(message.str("id").orEmpty(), item) }) { Text(stringResource(R.string.account_attachment, item.str("name").orEmpty())) } }
                HorizontalDivider()
            } }
        }
    }
    writing?.let { mail -> MailEditor(mail, { writing = null }) { value -> save(value) { writing = null } } }
}
private fun shortTime(at: Long): String = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT))

@Composable
internal fun MailEditor(mail: JsonObject, dismiss: () -> Unit, save: (JsonObject) -> Unit) {
    fun list(name: String) = mail.strings(name).joinToString(", ")
    var to by rememberSaveable { mutableStateOf(list("to")) }; var cc by rememberSaveable { mutableStateOf(list("cc")) }; var subject by rememberSaveable { mutableStateOf(mail.str("subject").orEmpty()) }; var text by rememberSaveable { mutableStateOf(mail.str("text").orEmpty()) }
    ToolDialog(stringResource(if (mail.obj("reply") != null) R.string.account_reply else R.string.account_write), dismiss, { TextButton({ save(buildJsonObject {
        put("to", JsonArray(AccountText.emails(to).map(::JsonPrimitive))); put("cc", JsonArray(AccountText.emails(cc).map(::JsonPrimitive))); put("subject", subject.trim()); put("text", text); mail.obj("reply")?.let { put("reply", it) }
    }) }, enabled = text.isNotBlank() && AccountText.emails(to).isNotEmpty()) { Text(stringResource(R.string.account_review)) } }) {
        OutlinedTextField(to, { to = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.account_to_field)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        OutlinedTextField(cc, { cc = it.take(4000) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.account_cc_field)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        OutlinedTextField(subject, { subject = it.take(300) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.account_subject)) })
        OutlinedTextField(text, { text = it.take(100_000) }, Modifier.fillMaxWidth().heightIn(min = PALLayout.shortField), label = { Text(stringResource(R.string.account_message)) })
    }
}

@Composable
internal fun DriveView(search: suspend (String) -> List<JsonObject>, list: suspend (String?) -> List<JsonObject>, keep: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }; var asked by rememberSaveable { mutableStateOf("") }; var path by remember { mutableStateOf(emptyList<JsonObject>()) }; var open by rememberSaveable { mutableStateOf("") }
    val (found, error) = rememberLoad(asked, path) { if (asked.isNotEmpty()) search(asked) else list(path.lastOrNull()?.str("id")) }
    val uri = LocalUriHandler.current
    LazyColumn(contentPadding = listPadding) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { OutlinedTextField(query, { query = it.take(300) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.account_find_files)) }); TextButton({ asked = query.trim(); path = emptyList() }) { Text(stringResource(R.string.account_search)) } }
            if (path.isNotEmpty()) TextButton({ path = path.dropLast(1) }) { Text(stringResource(R.string.account_up, path.joinToString(" / ") { it.str("name").orEmpty() })) }
            Problem(error); if (found != null && found.isEmpty()) Text(stringResource(R.string.account_no_files))
        }
        keyedItems(found.orEmpty(), { it.str("id").orEmpty() }) { item ->
            val id = item.str("id").orEmpty()
            RowItem(item.str("name").orEmpty(), if (item.isTrue("folder")) stringResource(R.string.account_folder) else listOfNotNull(item.num("bytes")?.let { byteSize(it) }, item.num("modified")?.let(::shortTime)).joinToString(" · ")) { if (item.isTrue("folder")) { asked = ""; query = ""; path = path + item } else open = if (open == id) "" else id }
            if (open == id) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { TextButton({ keep(id) }) { Text(stringResource(R.string.account_use_here)) }; item.str("link")?.let { link -> TextButton({ uri.open(link) }) { Text(stringResource(R.string.account_open_service)) } } }
        }
    }
}

@Composable
internal fun GitHubView(writable: Boolean, search: suspend (String, String) -> List<JsonObject>, read: suspend (String, JsonObject) -> JsonObject, keep: (String, JsonObject) -> Unit, save: (JsonObject, () -> Unit) -> Unit) {
    var kind by rememberSaveable { mutableStateOf("issues") }; var query by rememberSaveable { mutableStateOf("") }; var asked by rememberSaveable { mutableStateOf("") }
    var open by remember { mutableStateOf<Pair<String, JsonObject>?>(null) }; var writing by remember { mutableStateOf<JsonObject?>(null) }
    val (found, error) = rememberLoad(kind, asked) { if (asked.isEmpty()) null else search(kind, asked) }
    val (item, itemError) = rememberLoad(open) { open?.let { read(it.first, it.second) } }
    val uri = LocalUriHandler.current
    LazyColumn(contentPadding = listPadding) {
        val current = open
        if (current == null) {
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("issues" to R.string.account_issues, "pulls" to R.string.account_pulls, "repositories" to R.string.account_repositories, "code" to R.string.account_code_search).forEach { (value, text) -> FilterChip(kind == value, { kind = value; asked = "" }, { Text(stringResource(text)) }) } }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { OutlinedTextField(query, { query = it.take(300) }, Modifier.weight(1f), singleLine = true, label = { Text(stringResource(R.string.account_search_github)) }); TextButton({ asked = query.trim() }, enabled = query.isNotBlank()) { Text(stringResource(R.string.account_search)) } }
                if (writable) OutlinedButton({ writing = buildJsonObject { put("kind", "issue.create") } }) { Text(stringResource(R.string.account_new_issue)) }
                Problem(error); if (found != null && found.isEmpty()) Text(stringResource(R.string.account_no_matches))
            }
            items(found.orEmpty()) { row -> RowItem(row.str("title") ?: row.str("path") ?: row.str("repo").orEmpty(), listOfNotNull(row.str("repo")?.let { repo -> row.num("number")?.let { "$repo #$it" } ?: repo }, row.str("state"), row.str("author")).joinToString(" · "), row.str("description")) { open = (if (row.num("number") != null) (if (kind == "pulls") "pull" else "issue") else if (row.str("path") != null) "file" else "repository") to row } }
        } else {
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    TextButton({ open = null }) { Text(stringResource(R.string.go_back)) }
                    if (current.first != "repository") TextButton({ keep(current.first, current.second) }) { Text(stringResource(R.string.account_use_here)) }
                    if (writable && item?.num("number") != null) TextButton({ writing = buildJsonObject { put("kind", "comment"); put("repo", item.str("repo").orEmpty()); put("number", item.num("number")) } }) { Text(stringResource(R.string.account_comment)) }
                    if (writable && current.first == "repository") TextButton({ writing = buildJsonObject { put("kind", "issue.create"); put("repo", current.second.str("repo").orEmpty()) } }) { Text(stringResource(R.string.account_new_issue)) }
                    item?.str("link")?.let { link -> TextButton({ uri.open(link) }) { Text(stringResource(R.string.account_open_service)) } }
                }
                Problem(itemError); if (item == null && itemError == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            if (item != null) {
                item { Text(item.str("title") ?: item.str("path") ?: item.str("repo").orEmpty(), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium); Text(listOfNotNull(item.str("repo"), item.num("number")?.let { "#$it" }, item.str("state"), item.str("author")).joinToString(" · "), style = MaterialTheme.typography.bodySmall); SelectionContainer { Text(item.str("body") ?: item.str("text") ?: item.str("description").orEmpty(), fontFamily = if (current.first == "file") FontFamily.Monospace else null) } }
                items(item.list("files")) { file -> Text("${file.str("path")} · +${file.num("additions") ?: 0} −${file.num("deletions") ?: 0}", fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodySmall); file.str("patch")?.let { SelectionContainer { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) } } }
                items(item.list("comments")) { comment -> Column(Modifier.padding(vertical = PALLayout.small)) { Text("${comment.str("author")} · ${comment.str("at")?.take(10)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant); SelectionContainer { Text(comment.str("body").orEmpty()) } } }
            }
        }
    }
    writing?.let { start -> GitHubEditor(start, { writing = null }) { value -> save(value) { writing = null } } }
}

@Composable
internal fun GitHubEditor(start: JsonObject, dismiss: () -> Unit, save: (JsonObject) -> Unit) {
    val comment = start.str("kind") == "comment"
    var repo by rememberSaveable { mutableStateOf(start.str("repo").orEmpty()) }; var title by rememberSaveable { mutableStateOf("") }; var body by rememberSaveable { mutableStateOf("") }
    ToolDialog(stringResource(if (comment) R.string.account_comment else R.string.account_new_issue), dismiss, { TextButton({ save(buildJsonObject { put("kind", start.str("kind").orEmpty()); put("repo", repo.trim()); start.num("number")?.let { put("number", it) }; if (!comment) put("title", title.trim()); put("body", body) }) }, enabled = repo.contains('/') && if (comment) body.isNotBlank() else title.isNotBlank()) { Text(stringResource(R.string.account_review)) } }) {
        OutlinedTextField(repo, { repo = it.take(140) }, Modifier.fillMaxWidth(), singleLine = true, readOnly = start.str("repo") != null, label = { Text(stringResource(R.string.account_repository)) })
        if (!comment) OutlinedTextField(title, { title = it.take(250) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.account_issue_title)) })
        OutlinedTextField(body, { body = it.take(60_000) }, Modifier.fillMaxWidth().heightIn(min = PALLayout.shortField), label = { Text(stringResource(R.string.account_text)) })
    }
}

@Composable
internal fun DraftsView(revision: Int, load: suspend () -> JsonObject, review: (JsonObject) -> Unit, check: (String) -> Unit, discard: (String) -> Unit) {
    val (value, error) = rememberLoad(revision) { load() }
    var open by rememberSaveable { mutableStateOf("") }; val uri = LocalUriHandler.current
    val writes = value?.list("writes").orEmpty().filter { it.str("state") != "discarded" }
    LazyColumn(contentPadding = listPadding) {
        item { Text(stringResource(R.string.account_drafts_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant); Problem(error); if (value != null && writes.isEmpty()) Text(stringResource(R.string.account_drafts_none)) }
        keyedItems(writes, { it.str("id").orEmpty() }) { write ->
            val id = write.str("id").orEmpty(); val state = write.str("state")
            RowItem(write.str("title").orEmpty(), listOfNotNull(stringResource(AccountText.state(write)), write.str("login"), write.num("updated")?.let(::shortTime)).joinToString(" · "), write.str("error"), AccountText.open(write)) { open = if (open == id) "" else id }
            if (open == id) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                if (state == "draft" || state == "failed") Button({ review(write) }) { Text(stringResource(R.string.account_review_send)) }
                if (state == "unknown") OutlinedButton({ check(id) }) { Text(stringResource(R.string.account_check_arrived)) }
                if (AccountText.open(write)) TextButton({ discard(id) }) { Text(stringResource(R.string.account_discard)) }
                write.obj("result")?.str("link")?.let { link -> TextButton({ uri.open(link) }) { Text(stringResource(R.string.account_open_service)) } }
            }
        }
    }
}

/** Where a routine's result goes besides its conversation: only an account that may write, and only what is named here. */
@Composable
internal fun RoutineDelivery(repository: PALRepository, changed: (JsonObject?) -> Unit) {
    var accounts by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    LaunchedEffect(Unit) { ownerCall { repository.read("owner.accounts.list", buildJsonObject {}) as JsonObject }.onSuccess { accounts = it.list("accounts") } }
    RoutineDeliveryForm(accounts, changed)
}
internal fun routineDelivery(accountId: String, kind: String, text: String): JsonObject? {
    val target = if (kind == "mail") AccountText.emails(text).takeIf { it.size in 1..5 }?.let { buildJsonObject { put("kind", "mail"); put("to", JsonArray(it.map(::JsonPrimitive))) } }
        else Regex("^\\s*([^\\s#]+/[^\\s#]+)\\s*#?\\s*(\\d+)\\s*$").matchEntire(text)?.let { match -> buildJsonObject { put("kind", "github"); put("repo", match.groupValues[1]); put("number", match.groupValues[2].toLongOrNull()) } }
    return target?.let { buildJsonObject { put("accountId", accountId); put("target", it) } }
}
@Composable
internal fun RoutineDeliveryForm(accounts: List<JsonObject>, changed: (JsonObject?) -> Unit) {
    val choices = accounts.flatMap { account -> listOfNotNull(("mail" to account).takeIf { AccountText.access(account, "mail") == "write" }, ("github" to account).takeIf { AccountText.access(account, "github") == "write" }) }
    if (choices.isEmpty()) return
    var chosen by rememberSaveable { mutableStateOf("") }; var text by rememberSaveable { mutableStateOf("") }
    Text(stringResource(R.string.account_result_to), style = MaterialTheme.typography.labelLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        FilterChip(chosen.isEmpty(), { chosen = ""; changed(null) }, { Text(stringResource(R.string.account_result_here)) })
        choices.forEach { (kind, account) -> val key = "$kind:${account.str("id")}"; FilterChip(chosen == key, { chosen = key; text = ""; changed(null) }, { Text(stringResource(if (kind == "mail") R.string.account_result_mail else R.string.account_result_issue, account.str("login").orEmpty())) }) }
    }
    if (chosen.isNotEmpty()) {
        val kind = chosen.substringBefore(':'); val id = chosen.substringAfter(':')
        OutlinedTextField(text, { text = it.take(600); changed(routineDelivery(id, kind, text)) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(if (kind == "mail") R.string.account_result_mail_to else R.string.account_result_issue_number)) })
        Text(stringResource(R.string.account_result_warning), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
    }
}
