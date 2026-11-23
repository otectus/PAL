package dev.otectus.pal.mobile

import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.otectus.pal.mobile.data.LocalAttachment
import dev.otectus.pal.mobile.protocol.DraftAttachment

private object AttachmentTokens {
    val cardMinWidth = 216.dp
    val cardMaxWidth = 280.dp
}

@Composable
internal fun LocalAttachmentCard(
    attachment: LocalAttachment,
    now: Long,
    @StringRes stage: Int?,
    canUpload: Boolean,
    onReview: () -> Unit,
    onUpload: () -> Unit,
    onRemove: () -> Unit,
) {
    val discarded = attachment.remoteAttachmentId != null && (attachment.remoteExpiresAt ?: Long.MAX_VALUE) <= now
    AttachmentCard(
        name = attachment.displayName,
        detail = stringResource(R.string.transcript_image_details, attachment.width, attachment.height, attachment.size / 1024) +
            if (attachment.transformed) stringResource(R.string.transcript_image_optimized) else "",
        icon = { Icon(Icons.Default.Info, null, Modifier.size(PALLayout.icon)) },
    ) {
        if (!discarded && attachment.committedOffset > 0 && !attachment.readyAt(now) && attachment.size > 0) {
            val fraction = (attachment.committedOffset.toFloat() / attachment.size).coerceIn(0f, 1f)
            LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
            Text(stringResource(R.string.transcript_upload_percent, (fraction * 100).toInt()), style = MaterialTheme.typography.labelSmall)
        }
        if (discarded) Text(stringResource(R.string.transcript_upload_expired), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.tertiary)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            when {
                stage != null -> Text(stringResource(stage), Modifier.weight(1f).padding(horizontal = PALLayout.small),
                    style = MaterialTheme.typography.labelMedium)
                attachment.reviewedAt == null -> TextButton(onReview, Modifier.weight(1f)) { Text(stringResource(R.string.transcript_review_attachment)) }
                attachment.readyAt(now) -> Text(stringResource(R.string.transcript_attachment_ready), color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.weight(1f).padding(horizontal = PALLayout.groupGap))
                else -> TextButton(onUpload, Modifier.weight(1f), enabled = canUpload) {
                    Text(stringResource(if (attachment.committedOffset > 0 && !discarded && attachment.remoteStatus != "ready")
                        R.string.transcript_resume_upload else R.string.transcript_upload))
                }
            }
            IconButton(onRemove, enabled = stage == null, modifier = Modifier.size(PALLayout.target)) {
                Icon(Icons.Default.Delete, stringResource(R.string.transcript_remove_image))
            }
        }
    }
}

@Composable
internal fun DesktopAttachmentCard(
    attachment: DraftAttachment,
    canRemove: Boolean,
    onReview: () -> Unit,
    onRemove: () -> Unit,
) {
    AttachmentCard(
        name = attachment.name,
        detail = stringResource(if (attachment.kind == "image") R.string.transcript_desktop_image_details else R.string.transcript_desktop_file_details,
            attachment.size / 1024),
        icon = { Icon(Icons.Default.Info, null, Modifier.size(PALLayout.icon)) },
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onReview, Modifier.weight(1f)) { Text(stringResource(R.string.transcript_review_attachment)) }
            IconButton(onRemove, enabled = canRemove, modifier = Modifier.size(PALLayout.target)) {
                Icon(Icons.Default.Delete, stringResource(R.string.transcript_remove_desktop_attachment, attachment.name))
            }
        }
    }
}

@Composable
private fun AttachmentCard(
    name: String,
    detail: String,
    icon: @Composable () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant),
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(Modifier.widthIn(min = AttachmentTokens.cardMinWidth, max = AttachmentTokens.cardMaxWidth).padding(PALLayout.groupGap),
            verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                icon()
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            content()
        }
    }
}
