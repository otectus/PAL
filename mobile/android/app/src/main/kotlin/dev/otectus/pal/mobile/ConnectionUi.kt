package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.OfflineKind

internal enum class ConnectionPresentation(val title: Int, val hint: Int? = null, val retry: Boolean = false, val busy: Boolean = false) {
    Unpaired(R.string.connection_unpaired),
    Connecting(R.string.connection_connecting, R.string.contacting_desktop, busy = true),
    Reconnecting(R.string.connection_reconnecting, R.string.contacting_desktop, busy = true),
    Authenticating(R.string.connection_signing_in, R.string.verifying_phone, busy = true),
    Online(R.string.connection_online),
    Disconnected(R.string.connection_disconnected, R.string.connect_to_sync, retry = true),
    Unreachable(R.string.connection_offline, R.string.unreachable_hint, retry = true),
    MonitoringOff(R.string.connection_disconnected, R.string.monitoring_off_hint, retry = true),
    Replacing(R.string.update_connection, R.string.pairing_in_progress),
    Blocked(R.string.connection_action_needed),
}

internal fun connectionPresentation(connection: ConnectionState, previouslySynced: Boolean) = when (connection) {
    is ConnectionState.Online -> ConnectionPresentation.Online
    ConnectionState.Connecting -> if (previouslySynced) ConnectionPresentation.Reconnecting else ConnectionPresentation.Connecting
    ConnectionState.Authenticating -> ConnectionPresentation.Authenticating
    is ConnectionState.Blocked -> ConnectionPresentation.Blocked
    ConnectionState.Unpaired -> ConnectionPresentation.Unpaired
    is ConnectionState.Offline -> when (connection.kind) {
        OfflineKind.NotConnected -> ConnectionPresentation.Disconnected
        OfflineKind.Unreachable -> ConnectionPresentation.Unreachable
        OfflineKind.MonitoringOff -> ConnectionPresentation.MonitoringOff
        OfflineKind.PairingChange -> ConnectionPresentation.Replacing
    }
}

@Composable
internal fun connectionTitle(state: MobileState) = stringResource(connectionPresentation(state.connection, state.cursor != null).title)

@Composable
internal fun ConnectionRecovery(state: MobileState, onRetry: () -> Unit) {
    val presentation = connectionPresentation(state.connection, state.cursor != null)
    val hint = presentation.hint ?: return
    val colors = MaterialTheme.colorScheme
    Surface(shape = MaterialTheme.shapes.medium,
        color = if (presentation.busy) colors.surfaceContainer else colors.tertiaryContainer,
        modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = PALLayout.groupGap, vertical = PALLayout.small)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                if (presentation.busy) CircularProgressIndicator(Modifier.size(PALLayout.iconSmall), strokeWidth = PALLayout.focusStroke)
                Text(stringResource(presentation.title), style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
                if (presentation.retry) TextButton(onRetry) {
                    Icon(Icons.Default.Refresh, null, Modifier.size(PALLayout.iconSmall))
                    Spacer(Modifier.width(PALLayout.tight))
                    Text(stringResource(R.string.retry_connection))
                }
            }
            Text(stringResource(hint), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
internal fun RecoveryPage(state: MobileState, onRetry: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = PALLayout.noticeWidth).verticalScroll(rememberScrollState())
            .padding(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.gutter)) {
            PageTitle(stringResource(R.string.connection_recovery_title))
            ConnectionRecovery(state, onRetry)
        }
    }
}
