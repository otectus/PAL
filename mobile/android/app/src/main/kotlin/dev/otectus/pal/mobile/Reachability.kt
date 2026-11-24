package dev.otectus.pal.mobile

import android.content.Context
import android.content.pm.PackageManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.core.content.ContextCompat
import dev.otectus.pal.mobile.data.Endpoints
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.WakeState
import dev.otectus.pal.mobile.data.WakeStatus
import java.net.InetAddress
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** What an announcement must say to be this phone's desktop: its ID, the protocol this app speaks and a local address. */
internal fun announcedEndpoint(desktopId: String, type: String, attributes: Map<String, ByteArray?>, address: InetAddress?, port: Int): String? {
    if (!type.trim('.').startsWith("_pal._tcp") || port !in 1024..65535 || address == null || !Endpoints.local(address)) return null
    if (attributes["id"]?.decodeToString() != desktopId || attributes["v"]?.decodeToString() != "1") return null
    return Endpoints.endpoint(address.hostAddress ?: return null, port)
}

/** Looks for this desktop's announcement while the screen that asked is open. */
internal class DesktopSearch(private val context: Context) {
    fun find(desktopId: String): Flow<String> = callbackFlow {
        val manager = context.getSystemService(NsdManager::class.java) ?: run { close(IllegalStateException("No network search")); return@callbackFlow }
        val resolving = java.util.ArrayDeque<NsdServiceInfo>(); var busy = false
        @Suppress("DEPRECATION")
        fun next() {
            synchronized(resolving) { if (busy) return; busy = resolving.isNotEmpty() }
            val service = synchronized(resolving) { resolving.poll() } ?: return
            runCatching { manager.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, code: Int) { synchronized(resolving) { busy = false }; next() }
                override fun onServiceResolved(info: NsdServiceInfo) {
                    val address = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses.firstOrNull(Endpoints::local) else info.host
                    announcedEndpoint(desktopId, info.serviceType.orEmpty(), info.attributes, address, info.port)?.let { trySendBlocking(it) }
                    synchronized(resolving) { busy = false }; next()
                }
            }) }.onFailure { close(IllegalStateException("Search failed")) }
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(type: String, code: Int) { close(IllegalStateException("Search failed")) }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
            override fun onDiscoveryStarted(type: String) {}
            override fun onDiscoveryStopped(type: String) {}
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onServiceFound(info: NsdServiceInfo) { synchronized(resolving) { if (resolving.size < 16) resolving.add(info) }; next() }
        }
        manager.discoverServices("_pal._tcp", NsdManager.PROTOCOL_DNS_SD, listener)
        awaitClose { runCatching { manager.stopServiceDiscovery(listener) } }
    }
}

/** Settings › Connection: the desktop's address found again, and only after it proves it holds the pinned key. */
@Composable
internal fun FindDesktop(repository: PALRepository, state: MobileState, search: (Context, String) -> Flow<String> = { context, id -> DesktopSearch(context).find(id) },
    accept: suspend (String) -> Boolean = repository::acceptFoundEndpoint) {
    val context = LocalContext.current; val strings = LocalResources.current; val scope = rememberCoroutineScope()
    val desktop = state.desktop ?: return
    var searching by remember { mutableStateOf(false) }
    var found by remember { mutableStateOf(emptyList<String>()) }
    var checking by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) { found = emptyList(); message = null; searching = true } else message = strings.getString(R.string.find_permission) }
    LaunchedEffect(searching) {
        if (!searching) return@LaunchedEffect
        try {
            // A search is short, and ends when this screen does.
            withTimeoutOrNull(SEARCH_MS) { search(context, desktop.desktopId).collect { endpoint -> if (endpoint !in found) found = found + endpoint } }
            if (found.isEmpty()) message = strings.getString(R.string.find_none)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { message = strings.getString(R.string.find_unavailable) }
        finally { searching = false }
    }
    Text(stringResource(R.string.find_detail), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        OutlinedButton({
            if (searching) searching = false
            else if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(context, "android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) permission.launch("android.permission.ACCESS_LOCAL_NETWORK")
            else { found = emptyList(); message = null; searching = true }
        }, Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(if (searching) R.string.find_stop else R.string.find_start)) }
        if (searching) { CircularProgressIndicator(Modifier.size(PALLayout.iconSmall), strokeWidth = PALLayout.focusStroke); Text(stringResource(R.string.find_searching), style = MaterialTheme.typography.bodySmall) }
    }
    val known = Endpoints.all(desktop)
    found.forEach { endpoint ->
        val address = Endpoints.host(endpoint)
        if (endpoint in known) Text(stringResource(R.string.find_known, address), style = MaterialTheme.typography.bodyMedium)
        else OutlinedButton({
            checking = endpoint; message = null
            scope.launch {
                try {
                    message = if (known.size >= Endpoints.MAX) strings.getString(R.string.find_full)
                    else strings.getString(if (accept(endpoint)) R.string.find_added else R.string.find_mismatch, address)
                } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { message = failure.message } finally { checking = null }
            }
        }, Modifier.heightIn(min = PALLayout.target), enabled = checking == null) { Text(stringResource(R.string.find_use, address)) }
    }
    if (checking != null) Text(stringResource(R.string.find_checking), style = MaterialTheme.typography.bodySmall)
    message?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall) }
    if (desktop.foundEndpoints.isNotEmpty()) {
        Text(stringResource(R.string.find_added_heading), style = MaterialTheme.typography.labelLarge)
        desktop.foundEndpoints.forEach { endpoint ->
            val remove = stringResource(R.string.find_remove_description, Endpoints.host(endpoint))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(Endpoints.host(endpoint), Modifier.weight(1f))
                TextButton({ scope.launch { ownerCall { repository.removeFoundEndpoint(endpoint) }.onFailure { message = it.message } } }, Modifier.heightIn(min = PALLayout.target).semantics { contentDescription = remove }) { Text(stringResource(R.string.find_remove)) }
            }
        }
    }
}
private const val SEARCH_MS = 15_000L

/** Settings › Phone: optional wake-ups through a push app the person chooses. */
@Composable
internal fun WakeUpSettings(repository: PALRepository, state: MobileState, apps: (Context) -> List<PushApp> = WakeUps::apps) {
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    fun run(work: suspend () -> Unit) { busy = true; problem = null; scope.launch { try { work() } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { problem = failure.message } finally { busy = false } } }
    Text(stringResource(R.string.wake_detail), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    val wake = state.wake
    // Where an earlier answer stands is asked again while this screen is open: the desktop's owner may just have allowed it.
    LaunchedEffect(wake?.token, wake?.delivered, wake?.status) { while (wake?.delivered == true && wake.status == WakeStatus.Waiting) { delay(3_000); ownerCall { repository.deliverWake() }.onFailure { problem = it.message } } }
    if (wake != null) {
        val name = remember(wake.distributor) { WakeUps.label(context, wake.distributor) }
        Text(wakeText(wake, name), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium,
            color = if (wake.status == WakeStatus.Refused || wake.status == WakeStatus.Failing) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurface)
        Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            if (wake.status == WakeStatus.Refused || wake.status == WakeStatus.Registering) OutlinedButton({ run { WakeUps.start(context, repository, PushApp(wake.distributor, name)) } }, Modifier.heightIn(min = PALLayout.target), enabled = !busy && state.supports("wake.register")) { Text(stringResource(R.string.wake_retry)) }
            OutlinedButton({ run { WakeUps.stop(context, repository) } }, Modifier.heightIn(min = PALLayout.target), enabled = !busy) { Text(stringResource(R.string.wake_stop)) }
        }
    } else {
        val online = state.connection is dev.otectus.pal.mobile.data.ConnectionState.Online
        val choices = remember { apps(context) }
        when {
            choices.isEmpty() -> Text(stringResource(R.string.wake_no_app), style = MaterialTheme.typography.bodyMedium)
            online && !state.supports("wake.register") -> Text(stringResource(R.string.wake_unsupported), style = MaterialTheme.typography.bodyMedium)
            else -> {
                choices.forEach { app -> OutlinedButton({ run { WakeUps.start(context, repository, app) } }, Modifier.heightIn(min = PALLayout.target), enabled = !busy && online) { Text(stringResource(R.string.wake_use, app.label)) } }
                if (!online) Text(stringResource(R.string.wake_offline), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

@Composable
private fun wakeText(wake: WakeState, app: String): String = when (wake.status) {
    WakeStatus.Registering -> wake.problem ?: stringResource(R.string.wake_registering, app)
    WakeStatus.Waiting -> stringResource(R.string.wake_waiting, wake.host ?: app)
    WakeStatus.On -> stringResource(R.string.wake_on, wake.host?.let { "$app ($it)" } ?: app)
    WakeStatus.Failing -> stringResource(R.string.wake_failing, wake.problem.orEmpty())
    WakeStatus.Refused -> stringResource(R.string.wake_refused, wake.problem ?: stringResource(R.string.wake_refused_detail))
}
