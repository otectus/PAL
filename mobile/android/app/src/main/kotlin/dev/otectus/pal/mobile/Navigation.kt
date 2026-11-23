package dev.otectus.pal.mobile

import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import dev.otectus.pal.mobile.data.ConnectionState

internal enum class Destination(val label: Int) {
    Sessions(R.string.nav_chats), Inbox(R.string.nav_inbox), Work(R.string.nav_work), Desktop(R.string.nav_desktop), Settings(R.string.nav_settings)
}

@Composable
private fun needsLargeTypePhoneLayout(): Boolean = with(LocalDensity.current) {
    fontScale >= 1.6f && LocalWindowInfo.current.containerSize.width < PALLayout.largeTextPhoneWidth.roundToPx()
}

@Composable
private fun DestinationIcon(item: Destination, count: Int, description: String?) {
    when (item) {
        Destination.Sessions -> Icon(painterResource(R.drawable.ic_chat), description)
        Destination.Desktop -> Icon(painterResource(R.drawable.ic_desktop), description)
        Destination.Settings -> Icon(Icons.Default.Settings, description)
        Destination.Work -> Icon(Icons.Default.Build, description)
        Destination.Inbox -> BadgedBox(badge = {
            if (count > 0) Badge(containerColor = MaterialTheme.colorScheme.tertiaryContainer, contentColor = MaterialTheme.colorScheme.onTertiaryContainer) {
                Text(if (count > 99) stringResource(R.string.nav_99) else count.toString(), Modifier.clearAndSetSemantics {})
            }
        }) { Icon(Icons.Default.Notifications, description) }
    }
}

@Composable
internal fun PALNavigation(destination: Destination, count: Int, rail: Boolean, select: (Destination) -> Unit, compactRail: Boolean = false) {
    val inboxStatus = if (count > 0) pluralStringResource(R.plurals.waiting_requests, count, count) else ""
    // At large type a phone-width row cannot fit four translated destination names.
    // One labelled selector keeps the full names and request count within thumb reach.
    if (!rail && needsLargeTypePhoneLayout()) {
        var expanded by remember { mutableStateOf(false) }
        val switchLabel = stringResource(R.string.switch_section)
        Box(Modifier.fillMaxWidth()) {
            Surface({ expanded = true }, color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth().semantics { onClick(switchLabel, action = null) }) {
                Row(Modifier.heightIn(min = PALLayout.primaryHeight).padding(horizontal = PALLayout.gutter), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
                    DestinationIcon(destination, count, null)
                    Text(stringResource(destination.label), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    Icon(Icons.Default.ArrowDropDown, null)
                }
            }
            DropdownMenu(expanded, { expanded = false }) {
                Destination.entries.forEach { item ->
                    DropdownMenuItem(text = { Text(stringResource(item.label)) }, onClick = { expanded = false; select(item) },
                        leadingIcon = { DestinationIcon(item, count, null) },
                        trailingIcon = if (destination == item) { { Icon(Icons.Default.Check, null) } } else null,
                        modifier = Modifier.semantics {
                            selected = destination == item
                            if (item == Destination.Inbox && count > 0) stateDescription = inboxStatus
                        })
                }
            }
        }
        return
    }
    val showLabels = !rail || !compactRail
    if (rail) NavigationRail(windowInsets = WindowInsets(0), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Destination.entries.forEach { item ->
                val name = stringResource(item.label)
                val modifier = if (item == Destination.Inbox && count > 0) Modifier.semantics { stateDescription = inboxStatus; liveRegion = LiveRegionMode.Polite } else Modifier
                NavigationRailItem(selected = destination == item, onClick = { select(item) }, modifier = modifier,
                    icon = { DestinationIcon(item, count, name.takeUnless { showLabels }) },
                    label = if (showLabels) { { Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis) } } else null)
            }
        }
    }
    else Row(Modifier.fillMaxWidth().padding(vertical = PALLayout.tight), verticalAlignment = Alignment.CenterVertically) {
        // NavigationBarItem uses RowScope to share the available width.
        Destination.entries.forEach { item ->
            val name = stringResource(item.label)
            NavigationBarItem(selected = destination == item, onClick = { select(item) },
                icon = { DestinationIcon(item, count, name.takeUnless { showLabels }) },
                label = if (showLabels) { { Text(name, maxLines = 2, overflow = TextOverflow.Ellipsis) } } else null,
                modifier = if (item == Destination.Inbox && count > 0) Modifier.semantics { stateDescription = inboxStatus; liveRegion = LiveRegionMode.Polite } else Modifier)
        }
    }
}

@Composable
private fun installedMobileVersion(): String {
    val context = LocalContext.current
    return remember(context.packageName) { installedAppIdentity(context).versionName }
}

@Composable
internal fun CompanionHeader(connection: ConnectionState, connectionText: String,
    onConnection: () -> Unit, onRetry: () -> Unit) {
    val online = connection is ConnectionState.Online
    val retry = connectionPresentation(connection, previouslySynced = false).retry
    val statusColor by androidx.compose.animation.animateColorAsState(
        if (online) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.tertiaryContainer,
        animationSpec = PALMotion.feedback, label = "connection")
    val label = stringResource(if (retry) R.string.retry_connection else R.string.connection_details)
    val version = installedMobileVersion()
    if (needsLargeTypePhoneLayout()) {
        Surface(if (retry) onRetry else onConnection, color = MaterialTheme.colorScheme.surface,
            modifier = Modifier.fillMaxWidth().semantics { onClick(label, action = null) }) {
            Column(Modifier.padding(horizontal = PALLayout.gutter, vertical = PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
                    Image(painterResource(R.drawable.pal_face_icon), null, Modifier.size(PALLayout.portrait))
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.pal_name), style = MaterialTheme.typography.titleMedium)
                        Text(version, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Icon(if (retry) Icons.Default.Refresh else Icons.Default.Info, null)
                }
                Text(connectionText, Modifier.padding(start = PALLayout.primaryHeight).semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        return
    }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.headerHeight).padding(start = PALLayout.gutter, end = PALLayout.groupGap),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Image(painterResource(R.drawable.pal_face_icon), null, Modifier.size(PALLayout.portrait))
            Column(Modifier.weight(1f).padding(vertical = PALLayout.tight)) {
                Text(stringResource(R.string.pal_name), style = MaterialTheme.typography.titleLarge)
                Text(version, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Surface(onClick = if (retry) onRetry else onConnection, shape = MaterialTheme.shapes.medium,
                color = statusColor,
                modifier = Modifier.widthIn(max = PALLayout.statusWidth).heightIn(min = PALLayout.target).semantics { liveRegion = LiveRegionMode.Polite; onClick(label, action = null) }) {
                Row(Modifier.padding(horizontal = PALLayout.groupGap, vertical = PALLayout.tight), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                    if (connection == ConnectionState.Connecting || connection == ConnectionState.Authenticating)
                        CircularProgressIndicator(Modifier.size(PALLayout.iconSmall), strokeWidth = PALLayout.focusStroke)
                    else Icon(if (online) Icons.Default.Check else Icons.Default.Refresh, null, Modifier.size(PALLayout.iconSmall))
                    Text(connectionText, style = MaterialTheme.typography.labelMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
