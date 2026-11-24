package dev.otectus.pal.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.input.key.*
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.otectus.pal.mobile.data.SessionScrollPosition
import dev.otectus.pal.mobile.protocol.Agent
import dev.otectus.pal.mobile.protocol.Message
import dev.otectus.pal.mobile.protocol.isConversationMessage
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.delay

internal object ConversationTokens {
    val messageGap = 22.dp
    val transcriptVerticalPadding = 18.dp
    val activityHeight = 640.dp
    val headerMinHeight = 240.dp
    val portraitMinHeight = 300.dp
}

internal fun restoredScrollIndex(position: SessionScrollPosition?, messages: List<Message>, hasOlder: Boolean): Int {
    if (position == null || position.following) return 0
    val conversation = messages.filter(Message::isConversationMessage)
    val anchored = position.anchorMessageId?.let { id -> conversation.indexOfFirst { it.id == id }.takeIf { it >= 0 } }
    val raw = anchored?.plus(if (hasOlder) 1 else 0) ?: position.itemIndex
    return raw.coerceIn(0, conversation.size + if (hasOlder) 1 else 0)
}

internal fun newConversationMessageCount(messages: List<Message>, seenTailId: String?): Int {
    if (seenTailId == null) return 0
    val seen = messages.indexOfLast { it.id == seenTailId }
    return if (seen < 0) 0 else (messages.lastIndex - seen).coerceAtLeast(0)
}

@Composable
internal fun ConversationTimeline(
    messages: List<Message>, busy: Boolean, status: String,
    modifier: Modifier = Modifier, hasOlder: Boolean = false, loadingOlder: Boolean = false,
    onLoadOlder: () -> Unit = {}, statusText: String? = null,
    sessionId: String = "", restoredPosition: SessionScrollPosition? = null,
    onPositionChanged: (SessionScrollPosition) -> Unit = {},
    messageContent: @Composable (Message) -> Unit,
) {
    val conversation = remember(messages) { messages.filter(Message::isConversationMessage) }
    val tail = conversation.lastOrNull()
    val list = rememberSaveable(sessionId, saver = LazyListState.Saver) {
        LazyListState(restoredScrollIndex(restoredPosition, conversation, hasOlder), restoredPosition?.offset?.coerceAtLeast(0) ?: 0)
    }
    var follow by rememberSaveable(sessionId) { mutableStateOf(restoredPosition?.following ?: true) }
    var seenTailId by remember(sessionId) { mutableStateOf(tail?.id) }
    var seenRevision by remember(sessionId) { mutableStateOf(tail?.revision) }
    var tailHeight by remember { mutableIntStateOf(0) }
    var statusHeight by remember { mutableIntStateOf(0) }
    // Only user scrolling changes follow mode; a new streaming row may briefly
    // make canScrollForward true before the automatic scroll catches up.
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to list.canScrollForward }.distinctUntilChanged().collect { (scrolling, more) ->
            if (scrolling) follow = !more
        }
    }
    val viewportHeight by remember(list) { derivedStateOf { list.layoutInfo.viewportSize.height } }
    LaunchedEffect(tail?.id, tail?.revision, busy, status, statusText, follow, viewportHeight, hasOlder, tailHeight, statusHeight) {
        if (follow) {
            val expectedItems = conversation.size + (if (hasOlder) 1 else 0) + (if (conversation.isEmpty()) 1 else 0) + 1
            snapshotFlow { list.layoutInfo.totalItemsCount == expectedItems && !list.isScrollInProgress }.first { it }
            // Anchor the next layout at the bottom. Starting a scroll mutation here makes
            // isScrollInProgress treat the transcript's own correction as reader input.
            list.requestScrollToItem(expectedItems - 1, statusHeight)
            seenTailId = tail?.id
            seenRevision = tail?.revision
        }
    }
    val conversationIds = remember(conversation) { conversation.mapTo(HashSet(), Message::id) }
    val currentConversationIds by rememberUpdatedState(conversationIds)
    val currentPositionChanged by rememberUpdatedState(onPositionChanged)
    LaunchedEffect(sessionId, list) {
        snapshotFlow {
            if (list.isScrollInProgress) null else Triple(list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset, follow)
        }.distinctUntilChanged().collectLatest { position ->
            if (position == null || sessionId.isBlank()) return@collectLatest
            delay(250)
            val visibleKey = list.layoutInfo.visibleItemsInfo.firstOrNull()?.key as? String
            currentPositionChanged(SessionScrollPosition(
                sessionId = sessionId,
                anchorMessageId = visibleKey?.takeIf(currentConversationIds::contains),
                itemIndex = position.first,
                offset = position.second,
                following = position.third,
            ))
        }
    }
    var completionMessage by remember(sessionId) { mutableIntStateOf(0) }
    var previousBusy by remember(sessionId) { mutableStateOf(busy) }
    var stoppingObserved by remember(sessionId) { mutableStateOf(busy && status == "stopping") }
    LaunchedEffect(busy, status) {
        val wasBusy = previousBusy
        previousBusy = busy
        if (!wasBusy && busy) stoppingObserved = status == "stopping"
        else if (busy && status == "stopping") stoppingObserved = true
        if (wasBusy && !busy) {
            completionMessage = when {
                status == "error" || status == "failed" -> R.string.transcript_failed
                stoppingObserved -> R.string.transcript_stopped
                status == "interrupted" || status == "disconnected" -> R.string.transcript_interrupted
                else -> R.string.transcript_complete
            }
            stoppingObserved = false
        } else if (busy) {
            // A new turn supersedes any completion that is still being announced.
            completionMessage = 0
        }
    }
    // Expiry is keyed only to the announcement. An idle status refinement must not
    // cancel this delay and leave the previous completion visible indefinitely.
    LaunchedEffect(completionMessage) {
        if (completionMessage != 0) {
            delay(3_000)
            completionMessage = 0
        }
    }
    val completionText = if (completionMessage == 0) null else stringResource(completionMessage)
    // Count only rows appended after the last-seen tail. Loading older history prepends rows and
    // must not be announced as a new reply.
    val newMessages = newConversationMessageCount(conversation, seenTailId)
    Box(modifier.fillMaxWidth()) {
        LazyColumn(Modifier.fillMaxSize().testTag("conversationTimeline"), state = list,
            contentPadding = PaddingValues(horizontal = PALLayout.gutter, vertical = ConversationTokens.transcriptVerticalPadding),
            verticalArrangement = Arrangement.spacedBy(ConversationTokens.messageGap)) {
            if (hasOlder) item(key = "history", contentType = "history") { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                OutlinedButton({ follow = false; onLoadOlder() }, enabled = !loadingOlder,
                    modifier = Modifier.widthIn(max = PALLayout.readingWidth).fillMaxWidth().heightIn(min = PALLayout.target)) {
                    Text(stringResource(if (loadingOlder) R.string.transcript_loading_earlier else R.string.transcript_load_earlier))
                }
            } }
            if (conversation.isEmpty()) item(key = "empty", contentType = "empty") {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Column(Modifier.widthIn(max = PALLayout.readingWidth).fillMaxWidth().padding(vertical = PALLayout.spacious),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                        Text(stringResource(R.string.transcript_empty_title), modifier = Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall)
                        Text(stringResource(R.string.transcript_empty_body), color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            keyedItems(conversation, { it.id }, { it.kind.ifBlank { "message" } }) { message ->
                val measureTail = if (message.id == tail?.id) Modifier.onSizeChanged { tailHeight = it.height } else Modifier
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Box(measureTail.widthIn(max = PALLayout.readingWidth).fillMaxWidth()) { messageContent(message) }
                }
            }
            item(key = "status", contentType = "status") {
                Box(Modifier.fillMaxWidth().onSizeChanged { statusHeight = it.height }.testTag("conversationStatus")) {
                    // "Your input" only when a request is on screen (the caller passes it as statusText).
                    val displayedStatus = statusText ?: when (status) {
                        "waiting" -> stringResource(R.string.transcript_waiting)
                        "starting" -> stringResource(R.string.transcript_starting)
                        "stopping" -> stringResource(R.string.transcript_stopping)
                        else -> stringResource(R.string.transcript_working)
                    }
                    if (busy) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Row(Modifier.widthIn(max = PALLayout.readingWidth).fillMaxWidth().padding(vertical = PALLayout.tight).semantics {
                            liveRegion = LiveRegionMode.Polite
                            stateDescription = displayedStatus
                        }, verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                            if (status == "waiting") Icon(Icons.Default.Info, null, Modifier.size(PALLayout.iconMedium))
                            else CircularProgressIndicator(Modifier.size(PALLayout.iconSmall), strokeWidth = PALLayout.focusStroke)
                            Text(displayedStatus, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    else if (completionText != null) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                        Icon(Icons.Default.Info, null, Modifier.size(PALLayout.iconSmall), tint = MaterialTheme.colorScheme.primary)
                        Text(completionText, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                    }
                    else Spacer(Modifier.height(PALLayout.hairline))
                }
            }
        }
        // This node remains composed even when the lazy status row is far outside the viewport,
        // so assistive technology receives the one completion change while reading older turns.
        if (completionText != null) Spacer(Modifier.size(PALLayout.hairline).align(Alignment.BottomStart)
            .testTag("conversationCompletionAnnouncement").semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = completionText
            })
        if (!follow) FilledTonalButton(onClick = { follow = true }, modifier = Modifier.align(Alignment.BottomCenter).padding(PALLayout.groupGap).testTag("latestMessages").semantics {
            liveRegion = LiveRegionMode.Polite
        },
            elevation = ButtonDefaults.filledTonalButtonElevation(defaultElevation = PALLayout.tight)) {
            Text((when {
                newMessages > 0 -> pluralStringResource(R.plurals.transcript_new_messages, newMessages, newMessages)
                tail != null && tail.id == seenTailId && tail.revision != seenRevision -> stringResource(R.string.transcript_updated)
                else -> stringResource(R.string.transcript_latest)
            }) + " ↓")
        }
    }
}

/** A keyboard-aware message composer with stable 48dp actions and room for attachment affordances. */
@Composable
internal fun ConversationComposer(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    canSend: Boolean,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
    leadingContent: (@Composable () -> Unit)? = null,
    sendFromKeyboard: Boolean = false,
    onStop: (() -> Unit)? = null,
    stopping: Boolean = false,
    sending: Boolean = false,
    retrySend: Boolean = false,
    queue: Boolean = false,
) {
    val progress = if (onStop != null) stopping else sending
    val actionLabel = stringResource(when {
        stopping && onStop != null -> R.string.transcript_stopping
        onStop != null -> R.string.transcript_stop_response
        sending -> R.string.conversation_sending
        retrySend -> R.string.transcript_retry_send
        queue -> R.string.transcript_queue_action
        else -> R.string.transcript_send
    })
    Surface(modifier = modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Row(Modifier.widthIn(max = PALLayout.readingWidth).fillMaxWidth().padding(horizontal = PALLayout.groupGap, vertical = PALLayout.small),
                horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    minLines = 1,
                    maxLines = 8,
                    shape = MaterialTheme.shapes.extraLarge,
                    leadingIcon = leadingContent,
                    keyboardOptions = KeyboardOptions(imeAction = if (sendFromKeyboard) ImeAction.Send else ImeAction.Default),
                    keyboardActions = KeyboardActions(onSend = { if (canSend) onSend() }),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                        disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    ),
                    modifier = Modifier.weight(1f).onPreviewKeyEvent { event ->
                        if (event.isCtrlPressed && event.key == Key.Enter) {
                            if (event.type == KeyEventType.KeyDown && event.nativeKeyEvent.repeatCount == 0 && canSend) onSend()
                            true
                        } else false
                    }.semantics { contentDescription = placeholder }.testTag("messageComposer"),
                )
                FilledIconButton(onClick = onStop ?: onSend, enabled = !progress && (onStop != null || canSend),
                    colors = if (onStop == null) IconButtonDefaults.filledIconButtonColors()
                        else IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.errorContainer,
                            contentColor = MaterialTheme.colorScheme.onErrorContainer),
                    modifier = Modifier.padding(bottom = PALLayout.tight).size(PALLayout.target).semantics {
                        contentDescription = actionLabel
                    }) {
                    when {
                        progress -> CircularProgressIndicator(Modifier.size(PALLayout.iconMedium), strokeWidth = PALLayout.focusStroke)
                        onStop != null -> Icon(painterResource(R.drawable.ic_stop), null)
                        retrySend -> Icon(Icons.Default.Refresh, null)
                        else -> Icon(Icons.AutoMirrored.Filled.Send, null)
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ActivityPanel(
    items: List<Message>, loading: Boolean, error: String?, onRefresh: () -> Unit,
    onDismiss: () -> Unit, agents: List<Agent> = emptyList(),
    canOpenAgent: (Agent) -> Boolean = { false }, onOpenAgent: (Agent) -> Unit = {},
    hasOlder: Boolean = false, loadingOlder: Boolean = false, onLoadOlder: () -> Unit = {},
    itemContent: @Composable (Message) -> Unit,
) {
    val activity = items.filterNot(Message::isConversationMessage).sortedByDescending(Message::time)
    ModalBottomSheet(onDismiss, modifier = Modifier.testTag("activityPanel"), sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(Modifier.fillMaxWidth().padding(horizontal = PALLayout.inset, vertical = PALLayout.tight), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.conversation_activity), Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall)
            }
            TextButton(onRefresh, enabled = !loading, modifier = Modifier.heightIn(min = PALLayout.target)) {
                Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(PALLayout.tight)); Text(stringResource(R.string.action_refresh))
            }
            TextButton(onDismiss, modifier = Modifier.heightIn(min = PALLayout.target)) {
                Icon(Icons.Default.Close, null); Spacer(Modifier.width(PALLayout.tight)); Text(stringResource(R.string.action_close))
            }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = PALLayout.inset)) }
        if (activity.isEmpty() && agents.isEmpty() && !loading && error == null) Text(stringResource(R.string.conversation_no_activity), modifier = Modifier.padding(PALLayout.inset))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = ConversationTokens.activityHeight).consumeExpandedSheetEdgeScroll(), contentPadding = PaddingValues(horizontal = PALLayout.gutter, vertical = PALLayout.groupGap)) {
            if (agents.isNotEmpty()) {
                item { Text(pluralStringResource(R.plurals.conversation_subagents, agents.size, agents.size), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(vertical = PALLayout.small)) }
                keyedItems(agents, { "agent-${it.id}" }) { agent -> AgentActivityRow(agent, canOpenAgent(agent), onOpenAgent) }
                if (activity.isNotEmpty()) item { HorizontalDivider(Modifier.padding(vertical = PALLayout.small)); Text(stringResource(R.string.conversation_tool_activity), style = MaterialTheme.typography.titleSmall) }
            }
            keyedItems(activity, { it.id }) { itemContent(it) }
            // Older records stay on the desktop until asked for; the list says so instead of ending.
            if (hasOlder) item(key = "olderActivity") { OutlinedButton(onLoadOlder, enabled = !loadingOlder, modifier = Modifier.fillMaxWidth().padding(vertical = PALLayout.small).testTag("olderActivity")) { Text(stringResource(if (loadingOlder) R.string.conversation_loading_older_activity else R.string.conversation_load_older_activity)) } }
        }
        Spacer(Modifier.height(PALLayout.sectionGap))
    }
}

@Composable
private fun AgentActivityRow(agent: Agent, canOpen: Boolean, onOpen: (Agent) -> Unit) {
    var expanded by rememberSaveable(agent.id) { mutableStateOf(false) }
    Surface(
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().padding(vertical = PALLayout.tight),
    ) {
        Column(Modifier.fillMaxWidth().padding(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded }.heightIn(min = PALLayout.target),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(agent.name.ifBlank { agent.id }, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(agentStatusLabel(agent.status), color = when {
                    agent.status == "failed" -> MaterialTheme.colorScheme.error
                    agent.isActive() -> MaterialTheme.colorScheme.primary
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }, style = MaterialTheme.typography.labelMedium)
                Text(if (expanded) "▴" else "▾")
            }
            if (expanded) {
                agent.task?.takeIf(String::isNotBlank)?.let { Text(it) }
                agent.detail?.takeIf(String::isNotBlank)?.let {
                    Text(it, color = if (agent.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                agent.parentId?.let { Text(stringResource(R.string.conversation_agent_parent, it.take(8)), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (canOpen) TextButton({ onOpen(agent) }, modifier = Modifier.align(Alignment.End)) { Text(stringResource(R.string.conversation_open_conversation)) }
            }
        }
    }
}

/**
 * The sources a reply drew on, from its metadata, so each is reachable even when the text names none.
 * Only http(s) addresses open, on tap; anything else is listed without a link.
 */
@Composable
internal fun MessageSources(sources: List<kotlinx.serialization.json.JsonObject>, onOpen: (String) -> Unit) {
    val entries = sources.mapNotNull { source ->
        val url = (source["url"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf(String::isNotBlank) ?: return@mapNotNull null
        ((source["title"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf(String::isNotBlank) ?: url) to url
    }.distinctBy { it.second }
    if (entries.isEmpty()) return
    Column(Modifier.padding(top = PALLayout.small).testTag("messageSources")) {
        Text(stringResource(R.string.transcript_sources), modifier = Modifier.semantics { heading() },
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        entries.forEach { (title, url) ->
            val safe = safeLink(url)
            val openDescription = stringResource(R.string.transcript_open_source, title)
            if (safe != null) TextButton({ onOpen(safe) }, contentPadding = PaddingValues(horizontal = PALLayout.none, vertical = PALLayout.tight),
                modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target).semantics { contentDescription = openDescription }) {
                Text("$title · ${java.net.URI(safe).host}", modifier = Modifier.fillMaxWidth(), maxLines = 2,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
            } else Text(stringResource(R.string.transcript_unavailable_source, title), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
