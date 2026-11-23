package dev.otectus.pal.mobile

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.Citations
import dev.otectus.pal.mobile.protocol.Message
import dev.otectus.pal.mobile.protocol.isConversationMessage
import dev.otectus.pal.mobile.protocol.isDelegationUpdate
import dev.otectus.pal.mobile.protocol.isDesktopOnlyResult
import kotlinx.coroutines.launch

private enum class MessageTone { Assistant, User, Delegation, Queued, Cancelled }

private fun Message.tone(): MessageTone = when {
    isDelegationUpdate() -> MessageTone.Delegation
    kind == "queued" -> MessageTone.Queued
    kind == "queue-cancelled" -> MessageTone.Cancelled
    role == "user" -> MessageTone.User
    else -> MessageTone.Assistant
}

@Composable
internal fun MessageBubble(repository: PALRepository, state: MobileState, message: Message) {
    if (message.isDesktopOnlyResult()) {
        DesktopResultCard(message)
        return
    }
    val scope = rememberCoroutineScope()
    var content by remember(message.id, message.revision) { mutableStateOf(message.text) }
    var loading by remember(message.id, message.revision) { mutableStateOf(false) }
    var error by remember(message.id, message.revision) { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    val uriHandler = LocalUriHandler.current
    val tone = message.tone()
    val shown = remember(content, state.showMemoryCitations) { Citations.shown(content, state.showMemoryCitations) }
    val preview = message.contentTruncated && content == message.text
    val copyLabel = stringResource(if (preview) R.string.copy_preview else R.string.copy_message)
    val linkOpenError = stringResource(R.string.transcript_link_open_failed)
    val label = when (tone) {
        MessageTone.Assistant -> state.assistantName
        MessageTone.User -> stringResource(R.string.your_message)
        MessageTone.Delegation -> stringResource(R.string.delegation_update)
        MessageTone.Queued -> stringResource(R.string.transcript_queued_message)
        MessageTone.Cancelled -> stringResource(R.string.transcript_cancelled_message)
    }

    val body: @Composable ColumnScope.() -> Unit = {
        MessageHeader(
            label = label,
            copyLabel = copyLabel,
            bookmarked = message.bookmarked,
            bookmarkAvailable = state.supports("messages.bookmark") && message.isConversationMessage(),
            bookmarkedLabel = stringResource(R.string.session_pinned),
            onCopy = { clipboard.setPrimaryClip(ClipData.newPlainText(copyLabel, shown)) },
            onBookmark = {
                scope.launch {
                    runCatching { repository.setBookmark(message, !message.bookmarked) }
                        .onFailure { error = it.message }
                }
            },
        )
        PALMarkdown(shown)
        MessageSources(message.sources) { url ->
            runCatching { uriHandler.openUri(url) }.onFailure { error = linkOpenError }
        }
        if (preview) {
            Spacer(Modifier.height(PALLayout.small))
            val characters = (message.contentChars ?: 0).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            Text(pluralStringResource(R.plurals.transcript_preview, characters, characters),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.tertiary)
            OutlinedButton({
                scope.launch {
                    loading = true
                    error = null
                    runCatching { repository.fullMessage(message) }.onSuccess { content = it }.onFailure { error = it.message }
                    loading = false
                }
            }, enabled = !loading && state.supports("sessions.messagePart")) {
                Text(stringResource(if (loading) R.string.transcript_loading_full_message else R.string.transcript_load_full_message))
            }
        }
        error?.let {
            Text(stringResource(R.string.transcript_message_error, it), color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall)
        }
    }

    if (tone == MessageTone.Assistant) {
        Column(Modifier.fillMaxWidth().padding(horizontal = PALLayout.tight),
            verticalArrangement = Arrangement.spacedBy(PALLayout.small), content = body)
    } else {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = if (tone == MessageTone.User || tone == MessageTone.Queued) Arrangement.End else Arrangement.Start) {
            Surface(
                color = when (tone) {
                    MessageTone.User -> MaterialTheme.colorScheme.primaryContainer
                    MessageTone.Queued -> MaterialTheme.colorScheme.tertiaryContainer
                    MessageTone.Cancelled -> MaterialTheme.colorScheme.errorContainer
                    else -> MaterialTheme.colorScheme.secondaryContainer
                },
                contentColor = when (tone) {
                    MessageTone.User -> MaterialTheme.colorScheme.onPrimaryContainer
                    MessageTone.Queued -> MaterialTheme.colorScheme.onTertiaryContainer
                    MessageTone.Cancelled -> MaterialTheme.colorScheme.onErrorContainer
                    else -> MaterialTheme.colorScheme.onSecondaryContainer
                },
                shape = PALShape.userMessage,
                border = if (tone == MessageTone.Delegation) BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant) else null,
                modifier = Modifier.fillMaxWidth(0.9f),
            ) {
                Column(Modifier.padding(start = PALLayout.gutter, end = PALLayout.small, top = PALLayout.tight, bottom = PALLayout.gutter),
                    verticalArrangement = Arrangement.spacedBy(PALLayout.small), content = body)
            }
        }
    }
}

@Composable
private fun MessageHeader(
    label: String,
    copyLabel: String,
    bookmarked: Boolean,
    bookmarkAvailable: Boolean,
    bookmarkedLabel: String,
    onCopy: () -> Unit,
    onBookmark: () -> Unit,
) {
    var options by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
            color = LocalContentColor.current.copy(alpha = 0.82f), modifier = Modifier.weight(1f))
        if (bookmarked) Icon(Icons.Default.Star, bookmarkedLabel, Modifier.size(PALLayout.iconSmall), tint = MaterialTheme.colorScheme.primary)
        Box {
            IconButton({ options = true }, modifier = Modifier.size(PALLayout.target)) {
                Icon(Icons.Default.MoreVert, stringResource(R.string.message_actions), Modifier.size(PALLayout.icon))
            }
            DropdownMenu(options, { options = false }) {
                DropdownMenuItem({ Text(copyLabel) }, {
                    options = false
                    onCopy()
                }, leadingIcon = { Icon(painterResource(R.drawable.ic_copy), null) })
                if (bookmarkAvailable) DropdownMenuItem(
                    { Text(stringResource(if (bookmarked) R.string.unpin_reply else R.string.pin_reply)) },
                    { options = false; onBookmark() },
                    leadingIcon = { Icon(Icons.Default.Star, null) },
                )
            }
        }
    }
}
