@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.*
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.InputRecovery
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.TerminalFrames
import dev.otectus.pal.mobile.data.TerminalKeys
import dev.otectus.pal.mobile.data.TerminalLease
import dev.otectus.pal.mobile.data.TerminalRun
import dev.otectus.pal.mobile.data.TerminalScreen as Screen
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * Terminals on the desktop, from the phone (PAL Everywhere §7). The shell runs on the computer as the desktop
 * account; this screen watches its screen and, once it takes control, types into it. Typing is sent in order,
 * one frame at a time, bound to the control lease: after a lost acknowledgement the phone asks what the desktop
 * received instead of sending a line, Enter or Ctrl+C again. Leaving the screen only stops watching.
 */
internal class TerminalRetention {
    val terminalId = mutableStateOf("")
    val terminal = mutableStateOf<JsonObject?>(null)
    val screen = mutableStateOf<Screen?>(null)
    val leaseTerminalId = mutableStateOf("")
    val lease = mutableStateOf<TerminalLease?>(null)
    val lastSequence = mutableLongStateOf(0L)
    val error = mutableStateOf<String?>(null)
    val actionError = mutableStateOf<String?>(null)
    var actionGeneration = 0L
    var attachGeneration = 0L
}

@Composable
internal fun TerminalScreen(repository: PALRepository, state: MobileState, activity: FragmentActivity, defaultCwd: String?, retained: TerminalRetention) {
    val scope = rememberCoroutineScope()
    val online = state.connection is ConnectionState.Online
    var profiles by remember { mutableStateOf<JsonObject?>(null) }
    var terminals by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var terminalId by retained.terminalId
    var terminal by retained.terminal
    var screen by retained.screen
    var lease by retained.lease
    var lastSequence by retained.lastSequence
    var error by retained.error
    var actionError by retained.actionError
    var notice by remember { mutableStateOf<String?>(null) }
    var history by remember { mutableStateOf<String?>(null) }
    var confirmStop by remember { mutableStateOf(false) }
    var ctrl by remember { mutableStateOf(false) }
    var alt by remember { mutableStateOf(false) }
    var field by remember { mutableStateOf(TextFieldValue("")) }
    // The field may include IME preedit text. Only this baseline has already reached the terminal.
    var committedField by remember { mutableStateOf("") }
    var size by remember { mutableStateOf(0 to 0) }
    val pending = remember { mutableStateListOf<JsonObject>() }
    var sending by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val focus = remember { FocusRequester() }
    val measurer = rememberTextMeasurer()
    val style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 15.sp)
    val cell = remember(style) { measurer.measure("MMMMMMMMMM", style).size.let { (it.width / 10f) to it.height.toFloat() } }
    fun setLease(value: TerminalLease?) {
        lease = value
        retained.leaseTerminalId.value = if (value == null) "" else terminalId
        if (value == null) lastSequence = 0
    }
    fun setLastSequence(value: Long) { lastSequence = value }

    fun refreshList() = scope.launch {
        runCatching { repository.request("terminal.list", buildJsonObject {}) }.onSuccess { terminals = it.objects() }.onFailure { error = it.message }
    }
    fun attach(id: String) = scope.launch {
        if (id.isEmpty()) return@launch
        val generation = ++retained.attachGeneration
        runCatching { repository.request("terminal.attach", buildJsonObject { put("terminalId", id) }) as JsonObject }
            .onSuccess { value ->
                val apply = terminalId == id && retained.attachGeneration == generation
                if (apply) {
                    terminal = value.obj("terminal")
                    screen = value.obj("screen")?.let(TerminalFrames::snapshot)
                    if (lease != null && !terminalLeaseMatches(terminal, lease, state.desktop?.deviceId)) {
                        setLease(null)
                        pending.clear()
                        actionError = actionError ?: "Typing paused because control changed. Check who controls the terminal before continuing."
                    }
                    error = null
                }
            }
            .onFailure {
                val apply = terminalId == id && retained.attachGeneration == generation
                if (apply) error = it.message
            }
    }
    val controlling = terminalLeaseMatches(terminal, lease, state.desktop?.deviceId)
    val running = terminal?.str("state") in setOf("running", "starting")
    fun fit(): Pair<Int, Int> {
        val (width, height) = size
        return ((height / cell.second).toInt().coerceIn(8, 120)) to ((width / cell.first).toInt().coerceIn(20, 300))
    }
    fun flush() {
        if (sending || pending.isEmpty()) return
        if (lease == null) return
        sending = true
        scope.launch {
            try {
                while (pending.isNotEmpty()) {
                    val active = lease ?: break
                    val batch = pending.take(64).toList(); repeat(batch.size) { pending.removeAt(0) }
                    val sequence = lastSequence + 1
                    val params = buildJsonObject { put("terminalId", terminalId); put("leaseId", active.leaseId); put("epoch", active.epoch); put("sequence", sequence); put("events", JsonArray(batch)) }
                    var attempts = 0
                    while (true) {
                        val ok = runCatching { repository.request("terminal.input", params) }.isSuccess
                        if (ok) { setLastSequence(sequence); break }
                        // The acknowledgement is lost or refused: ask what the desktop accepted, never resend blindly.
                        val status = runCatching { repository.request("terminal.inputStatus", buildJsonObject { put("terminalId", terminalId); put("leaseId", active.leaseId); put("epoch", active.epoch) }) as JsonObject }.getOrNull()
                        val decision = status?.let { InputRecovery.decide(it, sequence) } ?: InputRecovery.Abandon("The desktop is unreachable. Check the screen when it reconnects; nothing was sent twice.")
                        when (decision) {
                            InputRecovery.Accepted -> { setLastSequence(sequence); break }
                            InputRecovery.Resend -> if (++attempts > 2) { pending.clear(); notice = "Typing could not be delivered. Check the screen."; return@launch }
                            is InputRecovery.Abandon -> { pending.clear(); setLease(null); notice = decision.reason; return@launch }
                        }
                    }
                }
            } finally { sending = false }
        }
    }
    fun send(event: JsonObject) { if (!controlling) { notice = "Take control to type here."; return }; pending += event; flush() }
    fun typed(text: String) {
        for (piece in text.split('\n').withIndex()) {
            if (piece.index > 0) send(TerminalKeys.key("enter"))
            val value = piece.value
            if (value.isEmpty()) continue
            if (ctrl || alt) {
                val mods = (if (ctrl) TerminalKeys.CTRL else 0) or (if (alt) TerminalKeys.ALT else 0)
                value.codePoints().forEach { send(TerminalKeys.char(Character.toLowerCase(it), mods)) }
                ctrl = false; alt = false
            } else send(TerminalKeys.text(value))
        }
    }
    fun reconcileField(visible: String, compositionStart: Int?) {
        val edit = terminalInputEdit(committedField, visible, compositionStart)
        repeat(edit.backspaces) { send(TerminalKeys.key("backspace")) }
        if (edit.appended.isNotEmpty()) typed(edit.appended)
        committedField = edit.committed
    }
    fun takeControl(after: () -> Unit = {}) {
        val current = terminal ?: return
        val targetId = terminalId
        val generation = ++retained.actionGeneration
        actionError = null
        val (rows, cols) = fit()
        signedReview(activity, repository, "terminal.acquireControl", buildJsonObject { put("terminalId", targetId); put("expectedControllerRevision", current.str("controllerRevision") ?: "0"); put("rows", rows); put("cols", cols) }, "Take control of the desktop terminal",
            success = success@{ result ->
                val apply = retained.actionGeneration == generation && terminalId == targetId
                if (!apply) return@success
                val value = result as JsonObject
                terminal = value.obj("terminal")
                setLease(TerminalLease.from(value.obj("lease"))); setLastSequence(lease?.lastSequence ?: 0)
                error = null; actionError = null; notice = null; runCatching(after)
            },
            failure = { message ->
                val apply = retained.actionGeneration == generation && terminalId == targetId
                if (apply) actionError = message.trimEnd('.', ' ') + ". Check who controls the terminal before trying again."
            })
    }
    fun create(shell: String) {
        val generation = ++retained.actionGeneration
        actionError = null
        val (rows, cols) = fit()
        signedReview(activity, repository, "terminal.create", buildJsonObject { put("shell", shell); defaultCwd?.let { put("cwd", it) }; put("rows", rows); put("cols", cols) }, "Start a terminal on the desktop",
            success = success@{ result ->
                val apply = retained.actionGeneration == generation
                if (!apply) return@success
                val value = result as JsonObject
                terminal = value.obj("terminal")
                terminalId = terminal?.str("id").orEmpty()
                screen = value.obj("screen")?.let(TerminalFrames::snapshot)
                setLease(TerminalLease.from(value.obj("lease"))); setLastSequence(lease?.lastSequence ?: 0)
                error = null; actionError = null; refreshList(); runCatching { focus.requestFocus() }
            },
            failure = { message ->
                val apply = retained.actionGeneration == generation
                if (apply) error = message
            })
    }
    LaunchedEffect(online) {
        if (!online) return@LaunchedEffect
        runCatching { repository.request("terminal.profiles", buildJsonObject {}) as JsonObject }.onSuccess { profiles = it }
        refreshList()
        // A reconnect: watch again and take the current screen; a lease survives only while the desktop still names it.
        if (terminalId.isNotEmpty()) attach(terminalId)
    }
    LaunchedEffect(terminalId) {
        history = null
        if (terminalId.isEmpty()) { setLease(null); screen = null }
        // Creation installs the terminal and its lease before selecting it. Do not immediately erase that lease.
        else if (terminal?.str("id") != terminalId) { if (retained.leaseTerminalId.value != terminalId) setLease(null); screen = null; attach(terminalId) }
    }
    LaunchedEffect(Unit) {
        repository.workEvents.collect { event ->
            val data = event.data
            when (event.name) {
                "terminal.screen" -> if (data.str("id") == terminalId) { val next = TerminalFrames.apply(screen, data); if (next == null) attach(terminalId) else screen = next }
                "terminal.state" -> {
                    val id = data.str("id").orEmpty()
                    terminals = (listOf(data) + terminals.filter { it.str("id") != id }).sortedByDescending { it.num("created") ?: 0 }
                    if (id == terminalId) {
                        terminal = data
                        val controller = data.obj("controller")
                        if (lease != null && !terminalLeaseMatches(data, lease, state.desktop?.deviceId)) {
                            val stillThisPhone = controller?.str("kind") == "device" && controller.str("deviceId") == state.desktop?.deviceId
                            if (!stillThisPhone) retained.actionGeneration++
                            setLease(null)
                            pending.clear()
                            if (stillThisPhone) actionError = actionError ?: "This phone's input lease is out of date. Tap Resume typing to try again."
                            else {
                                actionError = null
                                notice = "Control moved to ${if (controller?.str("kind") == "local") "the desktop" else "another device"}."
                            }
                        }
                    }
                }
                "terminal.removed" -> { terminals = terminals.filter { it.str("id") != data.str("id") }; if (data.str("id") == terminalId) { retained.actionGeneration++; retained.attachGeneration++; setLease(null); actionError = null; terminalId = ""; terminal = null; screen = null } }
            }
        }
    }
    // Rotation or a keyboard appearing: the controller resizes the desktop terminal to what fits.
    LaunchedEffect(size, controlling) {
        if (!controlling || !running) return@LaunchedEffect
        delay(250)
        val (rows, cols) = fit(); val active = lease ?: return@LaunchedEffect
        if (screen?.rows != rows || screen?.cols != cols) runCatching { repository.request("terminal.resize", buildJsonObject { put("terminalId", terminalId); put("leaseId", active.leaseId); put("rows", rows); put("cols", cols) }) }
    }

    if (!online) return WorkNotice("The desktop is not connected", "Terminals keep running on the desktop. Reconnect to watch or type in them again.")
    val current = terminal
    if (terminalId.isEmpty() || current == null) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text("Run commands on ${profiles?.str("host") ?: "the desktop"} as ${profiles?.str("account") ?: "your desktop account"}. Programs keep running when you leave this screen.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                profiles?.str("unavailableReason")?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    profiles?.list("shells").orEmpty().forEach { shell ->
                        Button({ create(shell.str("id").orEmpty()) }, enabled = profiles?.str("worker") == "available") { Icon(Icons.Default.Add, null); Text("New ${shell.str("label")}") }
                    }
                }
            }
            items(terminals, key = { it.str("id").orEmpty() }) { item ->
                ListItem(headlineContent = { Text(item.str("title").orEmpty()) }, supportingContent = { Text("${item.str("shell")} · ${item.str("cwd")} · ${terminalState(item.str("state"))}") },
                    modifier = Modifier.clickable { retained.actionGeneration++; retained.attachGeneration++; setLease(null); actionError = null; terminal = null; screen = null; terminalId = item.str("id").orEmpty() })
            }
        }
        return
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton({ val detached = terminalId; retained.actionGeneration++; retained.attachGeneration++; scope.launch { runCatching { repository.mutate("terminal.detach", buildJsonObject { put("terminalId", detached) }) } }; setLease(null); actionError = null; terminalId = ""; terminal = null; screen = null; refreshList() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "All terminals (this one keeps running)") }
            Column(Modifier.weight(1f)) {
                Text(current.str("title").orEmpty(), style = MaterialTheme.typography.titleSmall, maxLines = 1)
                Text("On ${current.str("host")} · ${current.str("shell")} · desktop account · ${terminalState(current.str("state"))}" + (current.obj("foreground")?.str("name")?.takeIf { it != current.str("shell") }?.let { " · running $it" } ?: ""),
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
            }
            IconButton({ scope.launch { runCatching { repository.request("terminal.history", buildJsonObject { put("terminalId", terminalId); put("limit", 1000) }) as JsonObject }.onSuccess { value ->
                history = (value["lines"] as? JsonArray).orEmpty().joinToString("\n") { Screen.plain(TerminalFrames.line(it.jsonArray)) } + "\n" + (screen?.text() ?: "")
            }.onFailure { error = it.message } } }) { Icon(Icons.Default.List, "History and copy") }
            if (running) IconButton({ confirmStop = true }) { Icon(Icons.Default.Close, "Stop terminal") }
        }
        (actionError ?: error ?: notice)?.let { Text(it, Modifier.padding(horizontal = 12.dp), color = if (actionError != null || error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
        current.str("note")?.let { Text(it, Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        current.obj("stopReport")?.let { report -> Text("Stopped ${report.int("signalled") ?: 0} processes" + ((report.int("remaining") ?: 0).takeIf { it > 0 }?.let { "; $it did not stop" } ?: "; none remain"), Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.bodySmall) }
        val colors = MaterialTheme.colorScheme
        Box(Modifier.weight(1f).fillMaxWidth().background(colors.surfaceContainerHighest).onSizeChanged { size = it.width to it.height }
            .focusRequester(focus).focusable()
            .onPreviewKeyEvent { event -> if (event.type != KeyEventType.KeyDown || !controlling) return@onPreviewKeyEvent false; hardwareKey(event)?.let { send(it); true } ?: false }
            .semantics { contentDescription = "Terminal screen: " + (screen?.text()?.takeLast(400) ?: "") }) {
            val rows = screen
            if (rows != null) Column(Modifier.horizontalScroll(rememberScrollState()).verticalScroll(rememberScrollState()).padding(4.dp)) {
                rows.lines.forEachIndexed { index, line -> Text(row(line, if (index == rows.cursorRow && rows.cursorVisible && running) rows.cursorCol else -1, colors.onSurface, colors.primary), style = style, softWrap = false, maxLines = 1) }
            }
        }
        if (running) {
            if (!controlling) Row(Modifier.padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                val controller = current.obj("controller")
                val thisPhone = controller?.str("kind") == "device" && controller.str("deviceId") == state.desktop?.deviceId
                Text(when { thisPhone -> "Your phone controls this terminal. Resume typing to reconnect the keyboard."; controller?.str("kind") == "local" -> "The desktop is typing in this terminal."; controller?.str("kind") == "device" -> "${controller.str("name") ?: "Another phone"} is typing in this terminal."; else -> "Watching." }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                Button({ takeControl { runCatching { focus.requestFocus() } } }) { Text(when { thisPhone -> "Resume typing"; controller != null -> "Take control"; else -> "Type here" }) }
            } else {
                Text("Your phone controls this terminal", Modifier.padding(horizontal = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
                Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    FilterChip(ctrl, { ctrl = !ctrl }, { Text("Ctrl") }); FilterChip(alt, { alt = !alt }, { Text("Alt") })
                    listOf("Esc" to "escape", "Tab" to "tab", "↑" to "up", "↓" to "down", "←" to "left", "→" to "right", "Home" to "home", "End" to "end", "PgUp" to "pageup", "PgDn" to "pagedown").forEach { (label, name) ->
                        AssistChip({ send(TerminalKeys.key(name, (if (ctrl) TerminalKeys.CTRL else 0) or (if (alt) TerminalKeys.ALT else 0))); ctrl = false; alt = false }, { Text(label) })
                    }
                    AssistChip({ scope.launch { runCatching { repository.mutate("terminal.interrupt", buildJsonObject { put("terminalId", terminalId) }) }.onFailure { error = it.message } } }, { Text("Ctrl+C") })
                    AssistChip({ clipboard.getText()?.text?.takeIf { it.isNotEmpty() }?.let { send(TerminalKeys.paste(it.take(65536))) } }, { Text("Paste") })
                }
                OutlinedTextField(field, { value ->
                    // Send committed prefix changes now, but keep the active IME preedit exclusively on the phone.
                    reconcileField(value.text, value.composition?.start)
                    if (value.composition == null && value.text.length > 200) {
                        field = TextFieldValue("")
                        committedField = ""
                    } else field = value
                }, Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), singleLine = true, placeholder = { Text("Type to the terminal") },
                    keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = {
                        // Some IMEs invoke Send while their last word is still preedit; commit it exactly once first.
                        reconcileField(field.text, null)
                        send(TerminalKeys.key("enter"))
                        field = TextFieldValue("")
                        committedField = ""
                    }))
            }
        }
    }
    history?.let { text ->
        ModalBottomSheet({ history = null }) {
            Column(Modifier.fillMaxWidth().padding(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("History", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    TextButton({ clipboard.setText(AnnotatedString(text)); history = null }) { Text("Copy all") }
                }
                Text("Select any part to copy it. Terminal output is not shared with a model unless you paste it yourself.", style = MaterialTheme.typography.bodySmall)
                SelectionContainer(Modifier.heightIn(max = 480.dp)) { Text(text, Modifier.verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()), style = style, softWrap = false) }
            }
        }
    }
    if (confirmStop) AlertDialog({ confirmStop = false }, title = { Text("Stop this terminal?") },
        text = { Text("Ends the shell and every program it started on the desktop" + (current.obj("foreground")?.str("name")?.takeIf { it != current.str("shell") }?.let { ", including $it" } ?: "") + ". To leave it running, go back instead.") },
        confirmButton = { Button({ confirmStop = false; val closing = terminalId; scope.launch { runCatching { repository.mutate("terminal.close", buildJsonObject { put("terminalId", closing) }) as JsonObject }.onSuccess { if (terminalId == closing) { terminal = it; setLease(null) } }.onFailure { if (terminalId == closing) error = it.message } } }) { Text("Stop terminal") } },
        dismissButton = { TextButton({ confirmStop = false }) { Text("Keep running") } })
}

internal data class TerminalInputEdit(val committed: String, val backspaces: Int, val appended: String)

private fun terminalLeaseMatches(terminal: JsonObject?, lease: TerminalLease?, deviceId: String?): Boolean {
    if (terminal == null || lease == null || deviceId.isNullOrEmpty()) return false
    val controller = terminal.obj("controller") ?: return false
    return controller.str("kind") == "device" &&
        controller.str("deviceId") == deviceId &&
        controller.int("epoch") == lease.epoch &&
        terminal.str("controllerRevision") == lease.controllerRevision
}

/** Reconciles the visible input buffer without treating the IME's active preedit range as terminal input. */
internal fun terminalInputEdit(baseline: String, visible: String, compositionStart: Int?): TerminalInputEdit {
    var boundary = compositionStart?.coerceIn(0, visible.length)
    if (boundary != null && boundary in 1 until visible.length && visible[boundary].isLowSurrogate() && visible[boundary - 1].isHighSurrogate()) boundary--
    val committed = if (boundary == null) visible else visible.substring(0, boundary)
    val baselinePoints = baseline.codePoints().toArray()
    val committedPoints = committed.codePoints().toArray()
    var shared = 0
    val limit = minOf(baselinePoints.size, committedPoints.size)
    while (shared < limit && baselinePoints[shared] == committedPoints[shared]) shared++
    val appended = java.lang.StringBuilder().apply {
        for (index in shared until committedPoints.size) appendCodePoint(committedPoints[index])
    }.toString()
    return TerminalInputEdit(committed, baselinePoints.size - shared, appended)
}


private fun terminalState(state: String?) = mapOf("starting" to "Starting", "running" to "Running", "stopping" to "Stopping", "exited" to "Ended", "interrupted" to "Interrupted by a desktop restart", "unknown" to "Outcome unknown")[state] ?: state.orEmpty()

private val ansi = listOf(0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666, 0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff)
/** The program's own colours: content, resolved from the 256-colour and true-colour values the desktop reports. */
private fun colour(value: Long, default: Color): Color = when {
    value < 0 -> default
    value >= 0x1000000 -> Color(0xff000000 or (value and 0xffffff))
    value < 16 -> Color(0xff000000 or ansi[value.toInt()].toLong())
    value < 232 -> { val v = (value - 16).toInt(); val level = { n: Int -> if (n == 0) 0 else 55 + n * 40 }; Color(level(v / 36), level((v / 6) % 6), level(v % 6)) }
    else -> { val grey = (8 + (value - 232) * 10).toInt(); Color(grey, grey, grey) }
}
private fun row(line: List<TerminalRun>, cursor: Int, foreground: Color, cursorColour: Color): AnnotatedString = buildAnnotatedString {
    var column = 0
    fun pad(to: Int) { while (column < to) { if (column == cursor) withStyle(SpanStyle(background = cursorColour)) { append(' ') } else append(' '); column++ } }
    for (run in line) {
        pad(run.col)
        val fg = colour(run.fg, foreground); val bg = colour(run.bg, Color.Transparent)
        val span = SpanStyle(color = if (run.concealed) Color.Transparent else if (run.reverse) (if (run.bg < 0) Color.Black else bg) else fg, background = if (run.reverse) fg else bg,
            fontWeight = if (run.bold) FontWeight.Bold else null, fontStyle = if (run.italic) FontStyle.Italic else null,
            textDecoration = listOfNotNull(if (run.underline) TextDecoration.Underline else null, if (run.strike) TextDecoration.LineThrough else null).takeIf { it.isNotEmpty() }?.let { TextDecoration.combine(it) })
        for (char in run.text) {
            withStyle(if (column == cursor) span.merge(SpanStyle(background = cursorColour)) else span) { append(char) }
            column++
        }
    }
    if (cursor >= column) pad(cursor + 1)
}
/** A hardware keyboard's keys, as the terminal names them. */
private fun hardwareKey(event: androidx.compose.ui.input.key.KeyEvent): JsonObject? {
    val mods = (if (event.isShiftPressed) TerminalKeys.SHIFT else 0) or (if (event.isAltPressed) TerminalKeys.ALT else 0) or (if (event.isCtrlPressed) TerminalKeys.CTRL else 0)
    val named = when (event.key) {
        Key.Enter, Key.NumPadEnter -> "enter"; Key.Tab -> "tab"; Key.Backspace -> "backspace"; Key.Escape -> "escape"
        Key.DirectionUp -> "up"; Key.DirectionDown -> "down"; Key.DirectionLeft -> "left"; Key.DirectionRight -> "right"
        Key.Insert -> "insert"; Key.Delete -> "delete"; Key.MoveHome -> "home"; Key.MoveEnd -> "end"; Key.PageUp -> "pageup"; Key.PageDown -> "pagedown"
        Key.F1 -> "f1"; Key.F2 -> "f2"; Key.F3 -> "f3"; Key.F4 -> "f4"; Key.F5 -> "f5"; Key.F6 -> "f6"; Key.F7 -> "f7"; Key.F8 -> "f8"; Key.F9 -> "f9"; Key.F10 -> "f10"; Key.F11 -> "f11"; Key.F12 -> "f12"
        else -> null
    }
    if (named != null) return TerminalKeys.key(named, mods)
    val codePoint = event.utf16CodePoint
    if (codePoint <= 0) return null
    return if (mods and (TerminalKeys.CTRL or TerminalKeys.ALT) != 0) TerminalKeys.char(Character.toLowerCase(codePoint), mods and (TerminalKeys.CTRL or TerminalKeys.ALT)) else TerminalKeys.text(String(Character.toChars(codePoint)))
}
