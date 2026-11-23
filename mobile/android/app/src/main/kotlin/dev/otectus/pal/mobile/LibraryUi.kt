package dev.otectus.pal.mobile

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import android.text.format.DateUtils
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.OfflineKind
import dev.otectus.pal.mobile.protocol.Session

@Composable
internal fun PageTitle(text: String, modifier: Modifier = Modifier) {
    val type = MaterialTheme.typography
    Text(text, modifier.semantics { heading() }, style = if (LocalDensity.current.fontScale >= 1.6f) type.headlineSmall else type.headlineLarge)
}

@Composable
internal fun LibraryConversation(session: Session, status: String, open: () -> Unit, handoff: (() -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    Surface(onClick = open, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
        color = colors.surface) {
        Row(Modifier.padding(start = PALLayout.gutter, end = PALLayout.small, top = PALLayout.gutter, bottom = PALLayout.gutter),
            horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                val provider = session.provider.replaceFirstChar(Char::uppercase)
                Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    val project = session.folderName?.takeIf(String::isNotBlank) ?: session.project?.substringAfterLast('/')?.takeIf(String::isNotBlank)
                    Text(project?.let { stringResource(R.string.library_project_provider, it, provider) } ?: provider,
                        style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
                        modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (session.updated > 0) Text(
                        DateUtils.formatDateTime(LocalContext.current, session.updated, if (DateUtils.isToday(session.updated))
                            DateUtils.FORMAT_SHOW_TIME else DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH),
                        style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                }
                val indicators = listOfNotNull(
                    stringResource(R.string.session_pinned).takeIf { session.pinned },
                    stringResource(R.string.session_unread).takeIf { session.unread },
                    status.takeIf { session.status != "idle" || status != stringResource(R.string.state_idle) },
                )
                if (indicators.isNotEmpty()) Text(indicators.joinToString("  ·  "), style = MaterialTheme.typography.labelMedium,
                    color = if (session.status == "waiting") colors.tertiary else colors.primary)
                session.model?.takeIf(String::isNotBlank)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (handoff != null) IconButton(handoff) {
                Icon(Icons.Default.Share, stringResource(R.string.hand_off_session, session.title), Modifier.size(PALLayout.iconMedium), tint = colors.onSurfaceVariant)
            }
        }
    }
}

internal enum class SettingsGroup(val title: Int, val hint: Int?, val icon: ImageVector) {
    Connection(R.string.connection_settings, null, Icons.Default.Refresh),
    Phone(R.string.appearance_alerts, R.string.appearance_hint, Icons.Default.Notifications),
    Assistant(R.string.assistant_memory, R.string.assistant_hint, Icons.Default.Star),
    Access(R.string.desktop_access, R.string.access_hint, Icons.Default.Lock),
    Owner(R.string.owner_settings, R.string.owner_hint, Icons.Default.Home),
    Pairing(R.string.pairing_maintenance, R.string.maintenance_hint, Icons.Default.Settings),
}

@Composable
internal fun SettingsIndex(state: MobileState, select: (SettingsGroup) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val groups = SettingsGroup.entries.filter { group ->
        group != SettingsGroup.Assistant || listOf("settings.get", "memory.list", "memory.retrieve").any(state::supports)
    }
    LazyColumn(contentPadding = PaddingValues(PALLayout.gutter)) {
        item { PageTitle(stringResource(R.string.nav_settings), Modifier.padding(bottom = PALLayout.gutter)) }
        items(groups.size, key = { groups[it].name }) { index ->
            val group = groups[index]
            val connection = group == SettingsGroup.Connection
            Surface(onClick = { select(group) },
                shape = if (connection) MaterialTheme.shapes.large else androidx.compose.ui.graphics.RectangleShape,
                color = if (connection) colors.secondaryContainer else colors.background) {
                Row(Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap, vertical = PALLayout.gutter),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.gutter)) {
                    if (connection) Icon(painterResource(R.drawable.ic_desktop), null)
                    else Icon(group.icon, null, tint = colors.onSurfaceVariant)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                        Text(stringResource(group.title), style = MaterialTheme.typography.titleMedium)
                        Text(group.hint?.let { stringResource(it) } ?: listOfNotNull(connectionTitle(state), state.desktop?.desktopName).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = if (connection) colors.onSecondaryContainer else colors.onSurfaceVariant)
                    }
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(PALLayout.iconMedium))
                }
            }
            if (!connection && index < groups.lastIndex) HorizontalDivider(Modifier.padding(start = PALLayout.headerHeight), color = sectionDivider)
        }
    }
}
