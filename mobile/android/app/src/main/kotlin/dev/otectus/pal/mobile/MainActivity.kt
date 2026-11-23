package dev.otectus.pal.mobile

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricPrompt
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import dev.otectus.pal.mobile.data.*
import dev.otectus.pal.mobile.protocol.*
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

open class MainActivity : FragmentActivity() {
    private val repository get() = (application as PALApp).repository
    private val launch = mutableStateOf<LaunchRequest?>(null)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A share or notification tap is handled once. After rotation or process death it
        // is replayed only if it had not been handled yet.
        if (savedInstanceState?.getBoolean(LAUNCH_HANDLED) != true) launch.value = launchRequest(intent)
        setContent {
            PALTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Box(Modifier.fillMaxSize().safeDrawingPadding()) {
                        PALRoot(repository, this@MainActivity, launch.value) { launch.value = null }
                    }
                }
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); launch.value = launchRequest(intent) }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); outState.putBoolean(LAUNCH_HANDLED, launch.value == null) }
    override fun onStart() { super.onStart(); repository.setVisible(true) }
    override fun onStop() { repository.setVisible(false); super.onStop() }

    private fun launchRequest(intent: Intent?): LaunchRequest? = when (intent?.action) {
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> sharedImages(intent).takeIf { it.isNotEmpty() }?.let { LaunchRequest.Share(it) }
        ACTION_REVIEW -> intent.getStringExtra(EXTRA_APPROVAL_ID)?.let { LaunchRequest.Review(it) }
        ACTION_OPEN_SESSION -> intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf(String::isNotBlank)?.let { LaunchRequest.OpenSession(it) }
        ACTION_OPEN_DESKTOP -> LaunchRequest.OpenDesktop
        Intent.ACTION_VIEW -> intent.data?.takeIf { it.scheme == "dev.otectus.cere.mobile" && it.path == "/oauth-callback" }
            ?.let { LaunchRequest.SignIn(it.getQueryParameter("state").orEmpty(), it.getQueryParameter("code"), it.getQueryParameter("error")) }
        else -> null
    }
    @Suppress("DEPRECATION")
    private fun sharedImages(intent: Intent): List<Uri> {
        if (intent.type?.startsWith("image/") != true) return emptyList()
        val uris: List<Uri> = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
        } else listOfNotNull(if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        // Only content another app shares is imported, never a file path.
        return uris.filter { it.scheme == ContentResolver.SCHEME_CONTENT }.take(4)
    }

    companion object {
        const val ACTION_REVIEW = "dev.otectus.pal.mobile.REVIEW"
        const val ACTION_OPEN_SESSION = "dev.otectus.pal.mobile.OPEN_SESSION"
        const val ACTION_OPEN_DESKTOP = "dev.otectus.pal.mobile.OPEN_DESKTOP"
        const val EXTRA_APPROVAL_ID = "approvalId"
        const val EXTRA_SESSION_ID = "sessionId"
        private const val LAUNCH_HANDLED = "launchHandled"
    }
}

/** What the activity was opened for: shared images or a notification tap. */
internal sealed interface LaunchRequest {
    data class Share(val uris: List<Uri>) : LaunchRequest
    data class Review(val approvalId: String) : LaunchRequest
    data class OpenSession(val sessionId: String) : LaunchRequest
    data object OpenDesktop : LaunchRequest
    /** A tool server sign-in returning to the phone that started it; the desktop exchanges the code. */
    data class SignIn(val state: String, val code: String?, val error: String?) : LaunchRequest
}

private fun startMonitoring(context: Context) { ContextCompat.startForegroundService(context, Intent(context, MonitoringService::class.java)) }
private fun openNotificationSettings(context: Context) { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }

@Composable
private fun PALRoot(repository: PALRepository, activity: FragmentActivity, launch: LaunchRequest?, consumeLaunch: () -> Unit) {
    val state by repository.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.restoreReady, state.desktop?.deviceId, state.stagedPairing?.desktop?.deviceId) {
        if (state.restoreReady && state.desktop != null && state.stagedPairing == null && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) repository.connectWhileOpen()
    }
    when {
        !state.restoreReady && state.connection !is ConnectionState.Blocked -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(PALLayout.gutter)) {
                CircularProgressIndicator()
                Text(stringResource(R.string.restore_loading), style = MaterialTheme.typography.bodyMedium)
            }
        }
        state.stagedPairing != null -> PairingScreen(repository, state, activity, state.desktop)
        state.desktop == null && state.connection is ConnectionState.Blocked -> UnreadableCacheScreen(repository, activity, state.connection as ConnectionState.Blocked)
        state.desktop == null -> PairingScreen(repository, state, activity)
        state.connection is ConnectionState.Blocked -> BlockedScreen(repository, state, activity, state.connection as ConnectionState.Blocked)
        else -> AppShell(repository, state, activity, launch, consumeLaunch)
    }
}

/** A connection that stopped retrying. Only a broken pairing offers re-pairing, and replacement keeps drafts. */
/** The private cache could not be read: locked (retry after unlock), or damaged or keyless (remove and pair again). */
@Composable
internal fun UnreadableCacheScreen(repository: PALRepository, activity: FragmentActivity, blocked: ConnectionState.Blocked) {
    var confirm by rememberSaveable { mutableStateOf(false) }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = PALLayout.formWidth).fillMaxWidth().verticalScroll(rememberScrollState()).padding(PALLayout.gutter),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(PALLayout.gutter),
        ) {
            Surface(shape = MaterialTheme.shapes.large, color = if (blocked.repair) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(Icons.Default.Lock, null, tint = if (blocked.repair) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(PALLayout.inset).size(PALLayout.portraitCompact))
            }
            Text(if (blocked.repair) stringResource(R.string.mobile_private_data_cant_be_read) else stringResource(R.string.mobile_unlock_private_cache), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            Text(
                if (blocked.repair) stringResource(R.string.mobile_pal_stopped_before_opening_anything_private_on_this) else stringResource(R.string.mobile_unlock_this_phone_then_ask_pal_to_open),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            SecureStatusPanel(if (blocked.repair) stringResource(R.string.mobile_encrypted_cache_unavailable) else stringResource(R.string.mobile_phone_is_still_locked), blocked.reason, tone = if (blocked.repair) SecureTone.Danger else SecureTone.Attention)
            if (blocked.repair) {
                Text(stringResource(R.string.mobile_removing_the_unreadable_cache_is_the_only_recovery), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button({ confirm = true }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target), colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.mobile_remove_and_pair_again)) }
            } else {
                Button(repository::retry, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.action_retry)) }
            }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text(stringResource(R.string.mobile_remove_unreadable_data)) },
        text = { Text(stringResource(R.string.mobile_pal_mobile_cannot_read_its_private_data_on)) },
        confirmButton = { Button({ confirm = false; activity.lifecycleScope.launch { runCatching { repository.discardUnreadableCache() } } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.action_remove)) } },
        dismissButton = { TextButton({ confirm = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable
internal fun BlockedScreen(repository: PALRepository, state: MobileState, activity: FragmentActivity, blocked: ConnectionState.Blocked) {
    val scope = rememberCoroutineScope()
    var replacing by rememberSaveable { mutableStateOf(false) }
    var confirmForget by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val desktop = state.desktop
    if (replacing && desktop != null) { PairingScreen(repository, state, activity, desktop) { replacing = false }; return }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = PALLayout.formWidth).fillMaxWidth().verticalScroll(rememberScrollState()).padding(PALLayout.gutter),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(PALLayout.gutter),
        ) {
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(Icons.Default.Lock, null, tint = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(PALLayout.inset).size(PALLayout.portraitCompact))
            }
            Text(if (blocked.repair) stringResource(R.string.mobile_pairing_needs_attention) else stringResource(R.string.mobile_cant_connect_to_the_desktop), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
            SecureStatusPanel(if (blocked.repair) stringResource(R.string.mobile_secure_connection_needs_repair) else stringResource(R.string.mobile_desktop_unavailable), blocked.reason, tone = SecureTone.Attention)
            Button(repository::retry, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.action_retry)) }
            if (blocked.repair) {
                if (state.pendingCommands.isNotEmpty()) {
                    OutlinedPanel(stringResource(R.string.mobile_check_before_repairing)) {
                        Text(stringResource(R.string.mobile_these_desktop_actions_were_never_confirmed_check_them), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        state.pendingCommands.forEach { Text("• ${CommandOutcomes.describe(it)}", style = MaterialTheme.typography.bodySmall) }
                        OutlinedButton({ scope.launch { runCatching { repository.releaseForRepair() }.onFailure { error = it.message } } }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_ive_checked_them_on_the_pc)) }
                    }
                }
                Text(stringResource(R.string.mobile_replacing_keeps_this_phones_encrypted_conversations_drafts_and), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton({ replacing = true }, enabled = desktop != null && repository.replacementBlocker() == null, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_replace_pairing_keeps_drafts)) }
                TextButton({ confirmForget = true }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.mobile_remove_phone_pairing_and_pair_again)) }
            } else Text(stringResource(R.string.mobile_check_the_desktop_and_try_again_your_conversations), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            error?.let { SecureStatusPanel(stringResource(R.string.mobile_repair_couldnt_continue), it, tone = SecureTone.Danger) }
        }
    }
    if (confirmForget) AlertDialog(onDismissRequest = { confirmForget = false }, title = { Text(stringResource(R.string.mobile_remove_this_pairing)) },
        text = { Text(stringResource(R.string.mobile_this_erases_this_phones_encrypted_conversations_drafts_images)) },
        confirmButton = { Button({ confirmForget = false; activity.lifecycleScope.launch { repository.forget() } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.action_remove)) } },
        dismissButton = { TextButton({ confirmForget = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable
private fun PairingScreen(
    repository: PALRepository,
    state: MobileState,
    activity: FragmentActivity,
    replacing: PairedDesktop? = null,
    onCancel: (() -> Unit)? = null,
) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var raw by rememberSaveable { mutableStateOf("") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var scan by rememberSaveable { mutableStateOf(false) }
    var enteringOffer by rememberSaveable { mutableStateOf(false) }
    var showResponseText by rememberSaveable { mutableStateOf(false) }
    var showManual by rememberSaveable { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var savePrompt by remember { mutableStateOf<CompletedPairing?>(null) }
    val result = state.stagedPairing
    var unstaged by remember { mutableStateOf<CompletedPairing?>(null) }
    var deviceName by rememberSaveable { mutableStateOf(Build.MODEL.take(48).ifBlank { strings.getString(R.string.generic_android_phone) }) }
    val returning by repository.pairingReturn.collectAsStateWithLifecycle()
    BackHandler(enabled = scan) { scan = false }
    BackHandler(enabled = !scan && (enteringOffer && result == null || onCancel != null)) {
        if (enteringOffer && result == null) enteringOffer = false else onCancel?.invoke()
    }
    LaunchedEffect(state.restoreReady, state.desktop?.deviceId, result?.desktop?.deviceId, unstaged?.desktop?.deviceId) {
        // What to keep is read from the repository when pruning runs, not from this frame: a pairing
        // that was just staged is there before this screen's collected state shows it, and clearing
        // `unstaged` in between must not delete its brand-new keys.
        val keep = unstaged?.desktop
        withContext(Dispatchers.IO) { val now = repository.state.value; repository.pairingManager().pruneUncommitted(now.restoreReady, now.desktop, now.stagedPairing?.desktop, keep) }
    }
    fun finishPairing(completed: CompletedPairing) { scope.launch { runCatching { repository.completePairing(completed); startMonitoring(activity); onCancel?.invoke() }.onFailure { error = it.message } } }
    // Alerts and (Android 17) local-network access are asked for before the phone first contacts the
    // PC, so approvals can reach a locked phone and the answer can travel. Declining alerts doesn't stop pairing.
    var afterPermissions by remember { mutableStateOf<(() -> Unit)?>(null) }
    val localNetworkPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val next = afterPermissions; afterPermissions = null
        if (granted) next?.invoke() else error = strings.getString(R.string.mobile_local_network_permission_is_required_to_connect_to)
    }
    fun withLocalNetwork(then: () -> Unit) {
        if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(activity, "android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) { afterPermissions = then; localNetworkPermission.launch("android.permission.ACCESS_LOCAL_NETWORK") }
        else then()
    }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> val next = afterPermissions; afterPermissions = null; next?.let(::withLocalNetwork) }
    fun withPermissions(then: () -> Unit) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) { afterPermissions = then; notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }
        else withLocalNetwork(then)
    }
    val networkReturn = result?.responseReturn == "network"
    fun sendAnswer(completed: CompletedPairing) = withPermissions { repository.startPairingReturn(completed) }
    fun stagePairing(completed: CompletedPairing) { scope.launch {
        unstaged = completed
        runCatching { repository.stagePairing(completed) }
            .onSuccess { unstaged = null; if (completed.responseReturn == "network") sendAnswer(completed) }
            .onFailure { error = strings.getString(R.string.mobile_could_not_seal_the_pairing_response_unlock_the, it.message) }
    } }
    // After a restart with an answer staged, delivery resumes where the permissions already allow it.
    LaunchedEffect(result?.desktop?.deviceId) {
        val staged = result ?: return@LaunchedEffect
        val allowed = Build.VERSION.SDK_INT < 37 || ContextCompat.checkSelfPermission(activity, "android.permission.ACCESS_LOCAL_NETWORK") == PackageManager.PERMISSION_GRANTED
        if (staged.responseReturn == "network" && allowed) repository.startPairingReturn(staged)
    }
    // The desktop confirmed this answer: save the pairing and connect.
    LaunchedEffect(returning, result?.desktop?.deviceId) { if (returning == PairingReturnState.Confirmed) result?.let(::finishPairing) }
    // The manual route: the desktop is asked first, so a pairing it never confirmed is not kept.
    fun desktopConfirmed(completed: CompletedPairing) { checking = true; error = null; scope.launch {
        try {
            when (val reply = repository.checkPairingConfirmed(completed)) {
                PairingReply.Confirmed -> withPermissions { finishPairing(completed) }
                PairingReply.Received -> error = strings.getString(R.string.mobile_your_pc_has_this_answer_check_that_it)
                is PairingReply.Closed -> error = if (reply.reason == "refused") strings.getString(R.string.mobile_your_pc_hasnt_confirmed_this_pairing_yet_paste) else reply.message
                null -> savePrompt = completed
            }
        } finally { checking = false }
    } }
    val clipboard = LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)

    fun prepare(value: String) {
        var created: PendingPairing? = null
        runCatching {
            replacing?.let { repository.replacementBlocker()?.let(::error) }
            val offer = repository.pairingManager().parseAndVerify(value.trim())
            val pending = repository.pairingManager().prepare(offer, deviceName.trim(), replacing)
            created = pending
            if (pending.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) {
                val completed = repository.pairingManager().completeWithoutAuthentication(pending)
                created = null
                stagePairing(completed)
                return@runCatching
            }
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(auth: BiometricPrompt.AuthenticationResult) {
                    runCatching {
                        val signature = auth.cryptoObject?.signature ?: error(strings.getString(R.string.mobile_authentication_signature_unavailable))
                        signature.update(pending.transcript)
                        repository.pairingManager().complete(pending, signature.sign())
                    }.onSuccess { completed -> created = null; stagePairing(completed) }.onFailure { repository.pairingManager().cancel(pending); created = null; error = it.message }
                }
                override fun onAuthenticationError(code: Int, message: CharSequence) { repository.pairingManager().cancel(pending); created = null; error = message.toString() }
            })
            prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle(strings.getString(R.string.mobile_create_pal_action_key))
                .setSubtitle(strings.getString(R.string.mobile_this_key_will_protect_approvals_and_sensitive_changes))
                .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build(), BiometricPrompt.CryptoObject(pending.actionSignature))
        }.onFailure { created?.let(repository.pairingManager()::cancel); created = null; error = it.message }
    }

    if (scan) {
        ScannerScreen(onResult = { scan = false; raw = it; prepare(it) }, onBack = { scan = false }, onEnterOffer = { scan = false; enteringOffer = true })
        return
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = PALLayout.formWidth).fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = PALLayout.inset, vertical = PALLayout.sectionGap),
            verticalArrangement = Arrangement.spacedBy(PALLayout.gutter),
        ) {
            if (onCancel != null) TextButton(onCancel) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                Text(stringResource(R.string.go_back))
            }
            Column(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.extraLarge)
                .background(PALBrand.surface)
                .padding(PALLayout.sectionGap), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    Text(stringResource(when {
                        result != null -> R.string.compare_words
                        replacing != null -> R.string.update_connection
                        else -> R.string.connect_to_pal
                    }), style = MaterialTheme.typography.headlineLarge, color = PALBrand.onSurface,
                        modifier = Modifier.weight(1f).semantics { heading() })
                    if (result == null) Image(painterResource(R.drawable.pal_welcome), stringResource(R.string.pal_name),
                        Modifier.size(PALLayout.brandMark))
                }
                Text(stringResource(when {
                    result != null -> R.string.verify_pc_steps
                    replacing != null -> R.string.replace_pc_steps
                    else -> R.string.pair_pc_steps
                }), style = MaterialTheme.typography.bodyLarge, color = PALBrand.onSurface)
            }
            if (result == null) {
                replacing?.let { Text(stringResource(R.string.mobile_paired_desktop, it.desktopName), style = MaterialTheme.typography.titleSmall) }
                repository.replacementBlocker()?.let { SecureStatusPanel(stringResource(R.string.mobile_finish_before_replacing), it, tone = SecureTone.Attention) }
                val canPair = unstaged == null && (replacing == null || repository.replacementBlocker() == null)
                OutlinedTextField(deviceName, { deviceName = it.take(48) }, label = { Text(stringResource(R.string.phone_name)) },
                    supportingText = { Text(stringResource(R.string.phone_name_hint)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Button({ scan = true }, enabled = canPair, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.primaryHeight)) {
                    Icon(painterResource(R.drawable.ic_scan), null)
                    Spacer(Modifier.width(PALLayout.small))
                    Text(stringResource(R.string.scan_pairing))
                }
                if (!enteringOffer) OutlinedButton({ enteringOffer = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.paste_instead))
                } else {
                    val verify = remember { BringIntoViewRequester() }
                    var editingOffer by remember { mutableStateOf(false) }
                    val imeHeight = WindowInsets.ime.getBottom(LocalDensity.current)
                    LaunchedEffect(editingOffer, imeHeight) {
                        if (editingOffer && imeHeight > 0) verify.bringIntoView()
                    }
                    Column(Modifier.fillMaxWidth().bringIntoViewRequester(verify),
                        verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                        OutlinedTextField(raw, { raw = it }, label = { Text(stringResource(R.string.pair_offer)) },
                            minLines = 2, maxLines = 3, modifier = Modifier.fillMaxWidth().onFocusChanged { editingOffer = it.isFocused })
                        OutlinedButton({ prepare(raw) }, enabled = raw.isNotBlank() && canPair, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.verify_offer))
                        }
                    }
                }
            }
            error?.let { SecureStatusPanel(stringResource(R.string.mobile_pairing_couldnt_continue), it, tone = SecureTone.Danger) }
            unstaged?.let { completed ->
                Button(onClick = { stagePairing(completed) }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_retry_secure_staging)) }
                TextButton(onClick = { repository.pairingManager().delete(completed.desktop); unstaged = null; error = null }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_cancel_unstaged_pairing)) }
            }
            result?.let { completed ->
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.primaryContainer, border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.primary.copy(alpha = .45f)), modifier = Modifier.fillMaxWidth()) {
                    SelectionContainer { Text(completed.sas, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onPrimaryContainer, textAlign = TextAlign.Center, modifier = Modifier.padding(PALLayout.inset).fillMaxWidth()) }
                }
                Text(when (completed.accessRole) {
                    "owner" -> stringResource(R.string.mobile_full_access_this_phone_will_control_pal_as)
                    "observer" -> stringResource(R.string.mobile_observer_this_phone_will_read_its_projects_conversations)
                    else -> stringResource(R.string.mobile_limited_access_only_the_projects_and_actions_chosen)
                }, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(if (completed.desktop.actionAuthentication == ActionAuthentication.TRUSTED_DEVICE) stringResource(R.string.mobile_this_trusted_phone_pairing_signs_reviewed_actions_without) else stringResource(R.string.mobile_this_pairing_requires_phone_authentication_for_sensitive_actions),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                // Network return: the answer goes to the PC by itself and the phone finishes when the PC confirms.
                val ended = returning as? PairingReturnState.Ended
                if (networkReturn) {
                    val (line, problem) = when (val now = returning) {
                        PairingReturnState.Idle -> stringResource(R.string.pairing_return_ready) to false
                        PairingReturnState.Sending -> stringResource(R.string.pairing_return_sending) to false
                        PairingReturnState.Waiting -> stringResource(R.string.pairing_return_waiting) to false
                        is PairingReturnState.Retrying -> stringResource(R.string.pairing_return_retrying, now.reason) to true
                        PairingReturnState.Confirmed -> stringResource(R.string.pairing_return_confirmed) to false
                        is PairingReturnState.Ended -> now.message to true
                        is PairingReturnState.Unreachable -> stringResource(R.string.pairing_return_unreachable, now.reason) to true
                    }
                    if (returning == PairingReturnState.Sending) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (problem) SecureStatusPanel(stringResource(R.string.mobile_check_the_connection), line, tone = SecureTone.Attention)
                    else Text(line, color = MaterialTheme.colorScheme.onSurface)
                    if (returning == PairingReturnState.Idle) OutlinedButton({ sendAnswer(completed) }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_send_the_answer_to_the_pc)) }
                }
                val manual = !networkReturn || showManual || returning is PairingReturnState.Unreachable
                if (networkReturn && !manual && ended == null) TextButton({ showManual = true }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_send_the_answer_another_way)) }
                if (manual && ended == null) {
                    HorizontalDivider()
                    Text(stringResource(R.string.mobile_get_this_public_signed_answer_to_the_pc))
                    PairingQrCode(completed.responseUri, Modifier.align(Alignment.CenterHorizontally))
                    TextButton({ showResponseText = !showResponseText }) {
                        Text(stringResource(if (showResponseText) R.string.hide_signed_text else R.string.show_signed_text))
                    }
                    if (showResponseText) SelectionContainer { Text(completed.responseUri, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                        Button(onClick = { clipboard.setPrimaryClip(android.content.ClipData.newPlainText(strings.getString(R.string.mobile_pal_pairing_response), completed.responseUri)) }) { Icon(painterResource(R.drawable.ic_copy), null); Spacer(Modifier.width(PALLayout.small)); Text(stringResource(R.string.mobile_copy_response)) }
                        OutlinedButton(onClick = {
                            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, completed.responseUri).putExtra(Intent.EXTRA_SUBJECT, strings.getString(R.string.mobile_pal_pairing_response))
                            runCatching { activity.startActivity(Intent.createChooser(send, strings.getString(R.string.mobile_send_the_pairing_response_to_your_pc))) }.onFailure { error = strings.getString(R.string.mobile_no_app_can_share_text_on_this_phone) }
                        }) { Icon(Icons.Default.Share, null); Spacer(Modifier.width(PALLayout.small)); Text(stringResource(R.string.mobile_share_response)) }
                    }
                    // Checked with the PC before the pairing is saved.
                    Button(onClick = { desktopConfirmed(completed) }, enabled = !checking, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.primaryHeight)) { Text(if (checking) stringResource(R.string.mobile_checking_with_the_pc) else stringResource(R.string.mobile_i_confirmed_on_the_pc)) }
                }
                TextButton(onClick = { scope.launch { runCatching { repository.cancelStagedPairing() }.onFailure { error = it.message } }; showManual = false }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(if (ended != null) stringResource(R.string.mobile_start_over) else stringResource(R.string.mobile_cancel_pairing)) }
            }
        }
        }
    }
    savePrompt?.let { completed -> AlertDialog(onDismissRequest = { savePrompt = null }, title = { Text(stringResource(R.string.mobile_save_this_pairing)) },
        text = { Text(stringResource(R.string.mobile_pal_couldnt_ask_your_pc_whether_it_confirmed)) },
        confirmButton = { Button({ savePrompt = null; withPermissions { finishPairing(completed) } }) { Text(stringResource(R.string.mobile_save_pairing)) } },
        dismissButton = { TextButton({ savePrompt = null }) { Text(stringResource(R.string.mobile_not_yet)) } }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppShell(repository: PALRepository, state: MobileState, activity: FragmentActivity, launch: LaunchRequest?, consumeLaunch: () -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var destinationName by rememberSaveable { mutableStateOf(Destination.Sessions.name) }
    val destination = Destination.entries.find { it.name == destinationName } ?: Destination.Sessions
    var selectedSession by rememberSaveable { mutableStateOf(state.selectedSessionId) }
    var settingsGroup by rememberSaveable { mutableStateOf<SettingsGroup?>(null) }
    var returnFromInbox by rememberSaveable { mutableStateOf<String?>(null) }
    var highlightedApproval by rememberSaveable { mutableStateOf<String?>(null) }
    // The conversation the Work tab opens on: the one last open, so Files and Runs follow the chat.
    var workSession by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(selectedSession) { if (selectedSession != null) workSession = selectedSession }
    var ownerInitialSection by rememberSaveable { mutableStateOf<String?>(null) }
    var ownerInitialSession by rememberSaveable { mutableStateOf<String?>(null) }
    var oauthTargetId by rememberSaveable { mutableStateOf<String?>(null) }
    var oauthResult by rememberSaveable { mutableStateOf<String?>(null) }
    // Shared image URIs, one per line, until the person picks a conversation for them.
    var pendingShare by rememberSaveable { mutableStateOf("") }
    fun open(id: String?) { selectedSession = id; scope.launch { repository.selectSession(id) } }
    LaunchedEffect(state.selectedSessionId, state.sessions) { if (selectedSession != null && state.sessions.none { it.id == selectedSession }) selectedSession = null }
    LaunchedEffect(launch) {
        when (launch) {
            null -> return@LaunchedEffect
            is LaunchRequest.Share -> pendingShare = launch.uris.joinToString("\n")
            is LaunchRequest.Review -> { open(null); destinationName = Destination.Inbox.name; highlightedApproval = launch.approvalId }
            is LaunchRequest.OpenSession -> if (state.sessions.any { it.id == launch.sessionId }) open(launch.sessionId) else { open(null); destinationName = Destination.Sessions.name }
            LaunchRequest.OpenDesktop -> { open(null); destinationName = Destination.Desktop.name }
            is LaunchRequest.SignIn -> {
                open(null)
                destinationName = Destination.Settings.name
                settingsGroup = SettingsGroup.Owner
                ownerInitialSection = "Tool servers"
                val result = runCatching { repository.mutate("owner.extensions.oauthComplete", buildJsonObject { put("state", launch.state); launch.code?.let { put("code", it) }; launch.error?.let { put("error", it) } }, strings.getString(R.string.mobile_finish_signing_in)) as JsonObject }
                result.onSuccess { completed ->
                    oauthTargetId = completed.str("serverId") ?: oauthTargetId
                    oauthResult = strings.getString(R.string.mobile_signed_in_to_its_tokens_stay_on_the, completed.str("server") ?: strings.getString(R.string.mobile_the_tool_server))
                }.onFailure { failure -> oauthResult = strings.getString(R.string.mobile_couldnt_finish_sign_in, failure.message ?: strings.getString(R.string.mobile_start_it_again)) }
            }
        }
        consumeLaunch()
    }
    fun selectTab(item: Destination) {
        returnFromInbox = null
        highlightedApproval = null
        settingsGroup = null
        ownerInitialSection = null
        ownerInitialSession = null
        oauthResult = null
        destinationName = item.name
        open(null)
    }
    fun back() {
        if (selectedSession != null) open(null)
        else if (destination == Destination.Settings && settingsGroup != null) settingsGroup = null
        else {
            val previous = returnFromInbox
            selectTab(Destination.Sessions)
            if (previous != null && state.sessions.any { it.id == previous }) open(previous)
        }
    }
    BackHandler(enabled = selectedSession != null || destination != Destination.Sessions, onBack = ::back)
    val connection = state.connection
    val connectionText = connectionTitle(state)
    val selected = state.sessions.find { it.id == selectedSession }
    val pages = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val landscape = maxWidth >= PALLayout.landscapeWidth && maxWidth > maxHeight
        val rail = selectedSession == null && (maxWidth >= PALLayout.railWidth || landscape)
        val useBars = maxHeight >= PALLayout.minimalChromeHeight
        val compactRail = maxHeight < PALLayout.compactHeight
        val keyboardOpen = WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current) > 0
        Row(Modifier.fillMaxSize()) {
            if (rail) PALNavigation(destination, state.approvals.size, true, ::selectTab, compactRail = compactRail)
            Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                if (useBars && selectedSession == null) {
                    CompanionHeader(connection, connectionText,
                        onConnection = { selectTab(Destination.Settings); settingsGroup = SettingsGroup.Connection }, onRetry = repository::retry)
                    HorizontalDivider(color = sectionDivider)
                }
                Box(Modifier.weight(1f).widthIn(max = PALLayout.readingWidth).fillMaxWidth()) {
                    if (selectedSession != null) key(selectedSession) {
                        ChatScreen(repository, state, selected, activity, ::back, {
                            returnFromInbox = selectedSession
                            open(null)
                            destinationName = Destination.Inbox.name
                        }) { id -> open(id) }
                    } else pages.SaveableStateProvider(destination.name) {
                        when (destination) {
                            Destination.Sessions -> SessionsScreen(repository, state, { open(it) }, activity)
                            Destination.Inbox -> InboxScreen(repository, state, activity, highlightedApproval)
                            Destination.Work -> WorkScreen(repository, state, activity, workSession) { section, sessionId ->
                                ownerInitialSection = section
                                ownerInitialSession = sessionId
                                destinationName = Destination.Settings.name
                                settingsGroup = SettingsGroup.Owner
                                open(null)
                            }
                            Destination.Desktop -> DesktopScreen(repository, state, activity)
                            Destination.Settings -> SettingsScreen(repository, state, activity, settingsGroup,
                                ownerInitialSection, ownerInitialSession, oauthTargetId, oauthResult,
                                onOAuthStarted = { oauthTargetId = it; oauthResult = null }) { settingsGroup = it }
                        }
                    }
                }
                if (selectedSession == null && !rail && (useBars || !keyboardOpen)) {
                    HorizontalDivider(color = sectionDivider)
                    Surface(color = MaterialTheme.colorScheme.surface) {
                        PALNavigation(destination, state.approvals.size, false, ::selectTab)
                    }
                }
            }
        }
    }
    if (pendingShare.isNotBlank()) ShareTargetDialog(repository, state, pendingShare.split('\n').map(Uri::parse), { pendingShare = "" }) { id -> pendingShare = ""; destinationName = Destination.Sessions.name; open(id) }
}

/** Shared images go into a conversation the person picks; failures are shown, never dropped. */
@Composable
private fun ShareTargetDialog(repository: PALRepository, state: MobileState, uris: List<Uri>, dismiss: () -> Unit, opened: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var importing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var partial by remember { mutableStateOf<String?>(null) }
    val targets = state.sessions.filter { !it.archived && it.mode == "managed" && (query.isBlank() || it.title.contains(query, true) || it.project.orEmpty().contains(query, true)) }
        .sortedByDescending(Session::updated).take(50)
    fun importInto(session: Session) {
        importing = true; error = null
        scope.launch {
            val failures = mutableListOf<String>(); var added = 0
            for (uri in uris) {
                try { repository.importImage(session.id, uri); added++ }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { failures += failure.message ?: strings.getString(R.string.mobile_an_image_could_not_be_added) }
            }
            importing = false
            if (failures.isEmpty()) opened(session.id)
            else { error = if (added > 0) strings.getString(R.string.transfer_images_error, added, uris.size, failures.distinct().joinToString(" ")) else failures.distinct().joinToString(" "); if (added > 0) partial = session.id }
        }
    }
    AlertDialog(onDismissRequest = { if (!importing) dismiss() }, title = { Text(if (uris.size == 1) stringResource(R.string.mobile_add_the_image_to_a_conversation) else stringResource(R.string.mobile_add_images_to_a_conversation, uris.size)) }, text = {
        Column(Modifier.heightIn(max = PALLayout.dialogBodyHeight), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(stringResource(R.string.mobile_pal_keeps_a_private_copy_on_this_phone), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.sessions.size > 6) OutlinedTextField(query, { query = it.take(200) }, placeholder = { Text(stringResource(R.string.search_conversations)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (targets.isEmpty()) Text(stringResource(R.string.mobile_no_conversation_can_take_images_right_now_create))
            LazyColumn(Modifier.weight(1f, fill = false)) { items(targets, key = { it.id }) { session ->
                ListItem(headlineContent = { Text(session.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(listOfNotNull(session.provider.replaceFirstChar(Char::uppercase), session.project?.substringAfterLast('/')).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.clickable(enabled = !importing && partial == null) { importInto(session) })
            } }
            if (importing) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { partial?.let { id -> Button({ opened(id) }) { Text(stringResource(R.string.mobile_open_conversation)) } } }, dismissButton = { TextButton(dismiss, enabled = !importing) { Text(if (partial != null) stringResource(R.string.action_close) else stringResource(R.string.action_cancel)) } })
}

@Composable
private fun SessionsScreen(repository: PALRepository, state: MobileState, select: (String) -> Unit, activity: FragmentActivity) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    var query by rememberSaveable { mutableStateOf("") }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var creating by rememberSaveable { mutableStateOf(false) }
    var showHistory by rememberSaveable { mutableStateOf(false) }; var transferSourceId by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    var searching by remember { mutableStateOf(false) }
    var searchError by remember { mutableStateOf<String?>(null) }
    var retrySearch by remember { mutableIntStateOf(0) }
    var loadingMore by remember { mutableStateOf(false) }
    // The phone keeps recent conversations; the desktop searches every conversation in scope.
    LaunchedEffect(query, state.connection is ConnectionState.Online, retrySearch) {
        searchError = null
        val text = query.trim()
        if (text.length < 2 || !state.supports("sessions.list")) return@LaunchedEffect
        delay(350); searching = true
        try { repository.searchSessions(text) } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { searchError = failure.localizedMessage ?: strings.getString(R.string.mobile_desktop_search_failed) } finally { searching = false }
    }
    val transferSource = state.sessions.firstOrNull { it.id == transferSourceId }
    val sessions = remember(state.sessions, query, showArchived) { state.sessions.filter { it.archived == showArchived && (query.isBlank() || listOf(it.title, it.project.orEmpty(), it.provider, it.folderName.orEmpty()).any { value -> value.contains(query.trim(), true) }) }.sortedWith(compareBy<Session> { it.status != "waiting" }.thenByDescending { it.pinned }.thenByDescending { it.updated }) }
    val loadedIds = remember(state.sessions) { state.sessions.mapTo(HashSet(), Session::id) }
    val search = state.search?.takeIf { query.trim().length >= 2 && it.query == query.trim() }
    val unloadedMatches = search?.remaining(loadedIds) ?: 0
    val requestCounts = remember(state.approvals) { state.approvals.groupingBy(Approval::sessionId).eachCount() }
    val canImport = state.supports("sessions.history") && state.supports("sessions.import")
    val canHandoff = state.supports("sessions.handoffPreview") && state.supports("sessions.handoffCreate")
    Box(Modifier.fillMaxSize()) {
        LazyColumn(contentPadding = PaddingValues(start = PALLayout.gutter, end = PALLayout.gutter, top = PALLayout.inset, bottom = PALLayout.fabClearance),
            verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    PageTitle(stringResource(R.string.conversations_heading), Modifier.weight(1f))
                    if (canImport) {
                        var menu by remember { mutableStateOf(false) }
                        Box {
                            IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, stringResource(R.string.conversation_actions)) }
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem({ Text(stringResource(R.string.import_history)) }, { menu = false; showHistory = true })
                            }
                        }
                    }
                }
            }
            item {
                OutlinedTextField(query, { query = it.take(200) }, leadingIcon = { Icon(Icons.Default.Search, null) },
                    trailingIcon = {
                        if (searching) CircularProgressIndicator(Modifier.size(PALLayout.iconMedium), strokeWidth = PALLayout.focusStroke)
                        else if (query.isNotEmpty()) IconButton({ query = "" }) { Icon(Icons.Default.Close, stringResource(R.string.clear_search)) }
                    }, placeholder = { Text(stringResource(R.string.search_conversations), maxLines = 1, overflow = TextOverflow.Ellipsis) }, singleLine = true,
                    shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth())
            }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    FilterChip(!showArchived, { showArchived = false }, { Text(stringResource(R.string.active_chats)) })
                    FilterChip(showArchived, { showArchived = true }, { Text(stringResource(R.string.archived_chats)) })
                }
            }
            searchError?.let { item {
                Text(it, color = MaterialTheme.colorScheme.error)
                if (query.trim().length >= 2) TextButton({ retrySearch++ }) { Text(stringResource(R.string.mobile_retry_search)) }
            } }
            if (unloadedMatches > 0 || query.isBlank() && state.sessionsNotLoaded > 0) item {
                val moreSearchResults = search != null && unloadedMatches > 0
                val detail = if (search != null && moreSearchResults)
                    strings.getQuantityString(if (search.truncated) R.plurals.library_matches_limited else R.plurals.library_matches, search.total, search.total, unloadedMatches)
                else strings.getQuantityString(R.plurals.library_more, state.sessionsNotLoaded, state.sessionsNotLoaded)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    Text(detail, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton({
                        loadingMore = true
                        scope.launch {
                            try { if (moreSearchResults) repository.loadMoreSearchResults() else repository.loadMoreSessions() }
                            catch (cancelled: CancellationException) { throw cancelled }
                            catch (failure: Exception) { searchError = failure.message }
                            finally { loadingMore = false }
                        }
                    }, enabled = !loadingMore && state.connection is ConnectionState.Online) {
                        Text(stringResource(if (loadingMore) R.string.loading_more else R.string.load_more))
                    }
                }
            }
            if (sessions.isEmpty() && !searching) item {
                EmptyState(Icons.Default.Search, stringResource(when {
                    query.isNotBlank() -> R.string.empty_search
                    showArchived -> R.string.empty_archive
                    state.connection is ConnectionState.Online -> R.string.empty_library
                    else -> R.string.empty_cache
                }), stringResource(when {
                    state.connection !is ConnectionState.Online && query.isNotBlank() -> R.string.search_offline
                    query.isNotBlank() -> R.string.search_again
                    showArchived -> R.string.empty_archive_hint
                    state.connection is ConnectionState.Online -> R.string.empty_library_hint
                    else -> R.string.empty_cache_hint
                }))
            }
            items(sessions, key = { it.id }, contentType = { "conversation" }) { session ->
                LibraryConversation(session, sessionDisplayStatus(session, requestCounts[session.id] ?: 0),
                    { select(session.id) }, if (canHandoff) { { transferSourceId = session.id } } else null)
            }
        }
        if (state.supports("sessions.create")) {
            val createLabel = stringResource(R.string.new_chat)
            val placement = Modifier.align(Alignment.BottomEnd).padding(PALLayout.gutter)
            if (androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.6f) {
                FloatingActionButton({ creating = true }, modifier = placement, containerColor = MaterialTheme.colorScheme.primary) {
                    Icon(Icons.Default.Add, createLabel)
                }
            } else ExtendedFloatingActionButton(
                onClick = { creating = true }, icon = { Icon(Icons.Default.Add, null) }, text = { Text(createLabel) },
                modifier = placement.semantics { contentDescription = createLabel },
                containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary)
        }
    }
    if (creating) CreateSessionSheet(repository, state, activity, { creating = false }) { id -> creating = false; select(id) }
    if (showHistory) SessionTransferSheet(repository, state, activity, null, { showHistory = false }, { id -> showHistory = false; select(id) })
    transferSource?.let { source -> SessionTransferSheet(repository, state, activity, source, { transferSourceId = null }, { id -> transferSourceId = null; select(id) }) }
}

@Composable
private fun CreateSessionSheet(repository: PALRepository, state: MobileState, activity: FragmentActivity, close: () -> Unit, created: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var title by rememberSaveable { mutableStateOf("") }
    // Keep an authorized provider selectable when discovery failed, so Refresh
    // can recover it without restarting either app.
    val supportedProviders = state.providers.filterValues { it.jsonObject["remoteExecution"]?.jsonPrimitive?.booleanOrNull == true }
    var provider by rememberSaveable { mutableStateOf(supportedProviders.keys.firstOrNull().orEmpty()) }
    var project by rememberSaveable { mutableStateOf(state.projects.firstOrNull()?.id.orEmpty()) }
    var models by remember { mutableStateOf<List<ModelOption>>(emptyList()) }
    var unlisted by remember { mutableStateOf(false) }
    var model by rememberSaveable(provider) { mutableStateOf("") }
    var effort by rememberSaveable(provider) { mutableStateOf("") }
    var tools by rememberSaveable(provider) { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(supportedProviders.keys) { if (provider !in supportedProviders) provider = supportedProviders.keys.firstOrNull().orEmpty() }
    LaunchedEffect(state.projects) { if (state.projects.none { it.id == project }) project = state.projects.firstOrNull()?.id.orEmpty() }
    LaunchedEffect(provider, refresh) {
        models = emptyList(); unlisted = false; error = null
        if (provider.isNotBlank()) {
            loading = true
            try {
                val catalog = repository.modelCatalog(provider); models = catalog.models; unlisted = catalog.unlisted
                val defaultModel = if (provider == "ollama") state.settings["defaultModel"]?.jsonPrimitive?.contentOrNull else null
                val selected = models.firstOrNull { it.id == model.trim() }
                if (model.isBlank() || selected == null && !state.traits(provider).customModel) {
                    val preferred = models.firstOrNull { it.id == defaultModel } ?: models.firstOrNull { it.isDefault } ?: models.firstOrNull()
                    model = preferred?.id.orEmpty()
                    effort = preferred?.defaultEffort.orEmpty()
                    if (!ToolPolicy.availability(state.traits(provider), preferred).available) tools = false
                } else if (selected != null && selected.efforts.none { it.id == effort }) {
                    effort = selected.defaultEffort.orEmpty()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message }
            finally { loading = false }
        }
    }
    val providerTraits = state.traits(provider)
    val selectedModel = models.firstOrNull { it.id == model.trim() }
    val selectedProject = state.projects.firstOrNull { it.id == project }
    // MOB-004: a typed model ID where the provider takes one; Ollama still needs a model it lists.
    val typed = providerTraits.customModel
    val modelError = if (typed && selectedModel == null) ModelIds.error(model) else null
    // MOB-003: the same tools rule as Conversation settings.
    val tooling = ToolPolicy.availability(providerTraits, selectedModel)
    fun chooseModel(option: ModelOption) { model = option.id; effort = option.defaultEffort; if (!ToolPolicy.availability(providerTraits, option).available) tools = false }
    fun submit() {
        submitting = true; error = null
        scope.launch {
            try {
                val params = buildJsonObject { put("provider", provider); put("projectId", project); if (title.isNotBlank()) put("title", title); put("model", model.trim()); if (effort.isNotBlank()) put("effort", effort); put("tools", tools && tooling.available) }
                val action = repository.prepareAction("sessions.create", params, label = title.ifBlank { null })
                authenticate(activity, strings.getString(R.string.mobile_create_conversation, state.traits(provider).label), action, repository, { result ->
                    scope.launch { try { created(repository.openCreatedSession(result)) } catch (failure: Exception) { error = failure.message; submitting = false } }
                }, { error = it; submitting = false })
            } catch (failure: Exception) { error = failure.message; submitting = false }
        }
    }
    AncillarySheetScaffold(title = stringResource(R.string.mobile_new_conversation), busy = submitting, onDismiss = close, action = {
        Button(::submit, enabled = (selectedModel != null || typed && modelError == null) && selectedProject != null &&
            !loading && !submitting && state.supports("sessions.create"), modifier = Modifier.fillMaxWidth()) {
            Text(if (submitting) stringResource(R.string.mobile_creating) else stringResource(R.string.mobile_create_conversation_2))
        }
    }) {
        OutlinedTextField(title, { title = it.take(100) }, label = { Text(stringResource(R.string.mobile_title_optional)) }, enabled = !submitting, singleLine = true, modifier = Modifier.fillMaxWidth())
        AncillarySection(stringResource(R.string.mobile_provider)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { supportedProviders.keys.forEach { id ->
                FilterChip(provider == id, { provider = id }, { Text(state.traits(id).label) }, enabled = !submitting)
            } }
            // What the desktop says about running this provider from a phone (billing, restrictions).
            if (provider.isNotBlank()) state.traits(provider).remoteNote.takeIf(String::isNotBlank)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = if (state.traits(provider).billed) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val unavailable = state.providers.filterKeys { it !in supportedProviders }
            var showUnavailable by rememberSaveable { mutableStateOf(false) }
            if (unavailable.isNotEmpty()) TextButton({ showUnavailable = !showUnavailable }) {
                Text(if (showUnavailable) stringResource(R.string.mobile_hide_unavailable_providers) else stringResource(R.string.mobile_unavailable_providers, unavailable.size))
            }
            if (showUnavailable) unavailable.forEach { (id, value) ->
                Text("${state.traits(id).label} · ${value.jsonObject["remoteUnavailableReason"]?.jsonPrimitive?.contentOrNull ?: stringResource(R.string.enable_provider_access)}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        AncillarySection(stringResource(R.string.mobile_desktop_project)) {
            if (state.projects.isEmpty()) Text(stringResource(R.string.mobile_grant_this_phone_a_project_in_desktop_remote), color = MaterialTheme.colorScheme.error)
            state.projects.forEach { option -> FilterChip(project == option.id, { project = option.id }, { Column {
                Text(option.name); Text(option.path ?: stringResource(R.string.desktop_path_unavailable), style = MaterialTheme.typography.labelSmall)
            } }, enabled = !submitting) }
        }
        AncillarySection(stringResource(R.string.mobile_model)) {
            if (provider == "ollama") Text(stringResource(R.string.mobile_ollama, state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: strings.getString(R.string.mobile_host_unavailable)),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                TextButton({ refresh++ }, enabled = provider.isNotBlank() && !loading && !submitting && state.supports("providers.models")) { Text(stringResource(R.string.mobile_refresh_models)) }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            // An endpoint without a model list is not a failure; neither is a failed refresh where an ID can be typed.
            else if (unlisted) Text(stringResource(R.string.mobile_this_endpoint_doesnt_list_its_models_enter_the), style = MaterialTheme.typography.bodySmall)
            else if (error != null && typed) Text(stringResource(R.string.mobile_the_model_list_could_not_be_loaded_you), style = MaterialTheme.typography.bodySmall)
            else if (models.isEmpty() && provider.isNotBlank()) Text(if (typed) stringResource(R.string.mobile_no_models_listed_enter_the_model_id_below) else stringResource(R.string.mobile_no_models_loaded_check_the_provider_on_your), style = MaterialTheme.typography.bodySmall)
            models.forEach { option -> Row(Modifier.fillMaxWidth().selectable(selected = model.trim() == option.id, enabled = !submitting, role = Role.RadioButton, onClick = { chooseModel(option) }).heightIn(min = PALLayout.target), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(model.trim() == option.id, null, enabled = !submitting)
                Spacer(Modifier.width(PALLayout.groupGap))
                Column { Text(option.displayName); if (option.description.isNotBlank()) Text(option.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } }
            if (typed && provider.isNotBlank()) OutlinedTextField(model, { value -> model = value.take(ModelIds.MAX_LENGTH + 64); effort = ""; if (!ToolPolicy.availability(providerTraits, models.firstOrNull { it.id == value.trim() }).available) tools = false },
                label = { Text(stringResource(R.string.mobile_model_id)) }, singleLine = true, enabled = !submitting, isError = modelError != null && model.isNotEmpty(),
                supportingText = { Text(modelError?.takeIf { model.isNotEmpty() } ?: stringResource(R.string.mobile_choose_one_above_or_type_the_id_as)) }, modifier = Modifier.fillMaxWidth())
            selectedModel?.efforts?.takeIf { it.isNotEmpty() }?.let { efforts ->
                Text(stringResource(R.string.mobile_effort), fontWeight = FontWeight.Medium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { efforts.forEach { option -> FilterChip(effort == option.id, { effort = option.id }, { Text(option.displayName) }, enabled = !submitting) } }
            }
            // PAL's desktop tools, for providers whose conversation PAL runs: per model for Ollama, per route for APIs.
            if (tooling.applies) ListItem(headlineContent = { Text(stringResource(R.string.mobile_desktop_tools)) }, supportingContent = {
                Text(if (tooling.available) stringResource(R.string.mobile_use_ordinary_desktop_permission_checks) else stringResource(R.string.mobile_conversation_only, tooling.reason.orEmpty()))
            }, trailingContent = { Switch(tools, { tools = it }, enabled = !submitting && tooling.available) })
        }
        error?.let { SecureStatusPanel(stringResource(R.string.mobile_conversation_setup), it, tone = SecureTone.Danger) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatScreen(repository: PALRepository, state: MobileState, session: Session?, activity: FragmentActivity, goBack: () -> Unit, openInbox: () -> Unit, selectSession: (String) -> Unit) {
    if (session == null) return EmptyState(Icons.Default.Warning, stringResource(R.string.conversation_session_unavailable), stringResource(R.string.conversation_session_unavailable_body))
    val context = LocalContext.current
    val strings = androidx.compose.ui.platform.LocalResources.current
    val scope = rememberCoroutineScope(); val storedDraft = state.draft(session); var draft by rememberSaveable(session.id) { mutableStateOf(storedDraft.text) }; var activityOpen by rememberSaveable(session.id) { mutableStateOf(false) }; var error by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var activityLoading by remember(session.id) { mutableStateOf(false) }; var activityError by remember(session.id) { mutableStateOf<String?>(null) }; var activityOlderLoading by remember(session.id) { mutableStateOf(false) }; var activityRefresh by remember(session.id) { mutableIntStateOf(0) }
    var reviewOpen by rememberSaveable(session.id) { mutableStateOf(false) }; var sending by remember(session.id) { mutableStateOf(false) }; var loadingOlder by remember(session.id) { mutableStateOf(false) }
    var attachmentReviewId by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var desktopReviewId by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var pinnedOpen by rememberSaveable(session.id) { mutableStateOf(false) }
    var portraitSheet by remember { mutableStateOf<PortraitSheet?>(null) }
    LaunchedEffect(state.connection is ConnectionState.Online) {
        if (state.connection is ConnectionState.Online && state.supports("desktop.portrait")) portraitSheet = runCatching { repository.portrait() }.getOrNull() ?: portraitSheet
    }
    var desktopRemoveId by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    var showConversationSettings by rememberSaveable(session.id) { mutableStateOf(false) }
    var webSearch by rememberSaveable(session.id) { mutableStateOf(false) }
    var attachMenu by remember { mutableStateOf(false) }
    // A full-size capture's private file, kept across the camera app and process death until imported.
    var cameraFile by rememberSaveable(session.id) { mutableStateOf<String?>(null) }
    val canSearchWeb = state.canSearchWeb(session)
    LaunchedEffect(canSearchWeb) { if (!canSearchWeb) webSearch = false }
    val now = repository.desktopTime()
    val attachments = state.attachments.filter { it.sessionId == session.id }
    val activeAgents = session.agents.filter(Agent::isActive)
    val waitingApprovals = state.approvals.filter { it.sessionId == session.id || session.id in it.parentSessionIds || activeAgents.any { agent -> agent.id == it.sessionId } }
    val busy = session.status in setOf("starting", "working", "waiting", "stopping") || waitingApprovals.any { it.sessionId == session.id }
    val attachmentsReady = attachments.all { it.reviewedAt != null && it.readyAt(now) }
    // A desktop draft's attachments are part of the draft: shown, reviewable and sent with it, never queued.
    val desktopAttachments = session.draftAttachments
    val draftEditable = state.draftEditable(session)
    val canCompose = draftEditable && session.canSend && session.mode == "managed" && session.draftIncluded && (!busy || session.canQueue && session.status != "stopping" && desktopAttachments.isEmpty()) && !sending && attachmentsReady &&
        (desktopAttachments.isEmpty() || state.supports("attachments.commit")) && state.supports("sessions.send") && state.pendingCommands.none { it.sessionId == session.id && it.method == "sessions.send" }
    val canAttach = state.supports("attachments.begin") && attachments.size + desktopAttachments.count { it.kind == "image" } < 4 && session.mode == "managed"
    fun imported(uri: android.net.Uri?) { if (uri != null) scope.launch { runCatching { repository.importImage(session.id, uri) }.onSuccess { attachmentReviewId = it.id }.onFailure { error = it.message } } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia(), ::imported)
    val files = rememberLauncherForActivityResult(ActivityResultContracts.GetContent(), ::imported)
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val path = cameraFile ?: return@rememberLauncherForActivityResult
        cameraFile = null
        scope.launch {
            val file = File(path)
            try { if (saved) attachmentReviewId = repository.importImage(session.id, FileProvider.getUriForFile(context, "${context.packageName}.camera", file)).id }
            catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message }
            finally { withContext(NonCancellable + Dispatchers.IO) { file.delete() } }
        }
    }
    fun launchCamera() { scope.launch {
        val file = try { withContext(Dispatchers.IO) {
            // A capture left behind by an interrupted import is removed before the next one.
            val directory = File(context.cacheDir, "camera").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
            File.createTempFile("capture-", ".jpg", directory)
        } } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = strings.getString(R.string.conversation_camera_prepare_failed, failure.message); return@launch }
        cameraFile = file.path
        try { camera.launch(FileProvider.getUriForFile(context, "${context.packageName}.camera", file)) }
        catch (_: ActivityNotFoundException) { cameraFile = null; file.delete(); error = strings.getString(R.string.conversation_camera_unavailable) }
        catch (_: SecurityException) { cameraFile = null; file.delete(); error = strings.getString(R.string.conversation_camera_permission_off) }
    } }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera() else error = strings.getString(R.string.conversation_camera_permission_denied)
    }
    fun takePhoto() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera()
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }
    val uploading = remember(session.id) { mutableStateMapOf<String, Int>() }
    fun uploadFailed(id: String, reason: String?) {
        uploading.remove(id)
        error = reason ?: strings.getString(R.string.conversation_image_upload_failed)
    }
    fun finishUpload(local: LocalAttachment, initial: JsonObject?) {
        uploading[local.id] = R.string.image_transferring
        scope.launch {
            runCatching {
                val uploaded = repository.uploadAttachment(local.id, initial)
                val attachmentId = uploaded.getValue("attachmentId").jsonPrimitive.content
                uploading[local.id] = R.string.image_finishing
                val commit = repository.prepareAction("attachments.commit", buildJsonObject { put("attachmentId", attachmentId) }, label = local.displayName)
                authenticate(activity, strings.getString(R.string.conversation_finish_image_upload), commit, repository, { ready ->
                    repository.attachmentCommitted(local.id, ready.jsonObject)
                    uploading.remove(local.id)
                }, { uploadFailed(local.id, it) })
            }.onFailure { uploadFailed(local.id, it.message) }
        }
    }
    fun upload(local: LocalAttachment) {
        if (local.id in uploading) return
        val resumable = local.remoteAttachmentId != null && local.remoteStatus != "ready" && (local.remoteExpiresAt ?: Long.MAX_VALUE) > now
        if (resumable) { finishUpload(local, null); return }
        uploading[local.id] = R.string.image_preparing
        scope.launch {
            runCatching {
                val begin = repository.prepareAction("attachments.begin", buildJsonObject {
                    put("sessionId", session.id); put("size", local.size); put("mime", local.mime); put("sha256", local.sha256)
                }, label = local.displayName)
                authenticate(activity, strings.getString(R.string.conversation_upload_image, local.displayName), begin, repository, { value -> finishUpload(local, value.jsonObject) },
                    { uploadFailed(local.id, it) })
            }.onFailure { uploadFailed(local.id, it.message) }
        }
    }
    // Removing always works on the phone; the desktop is asked to discard its copy when it still has one.
    fun remove(local: LocalAttachment) { scope.launch { runCatching { repository.discardAttachment(local.id) }.onFailure { error = it.message } } }
    // MOB-005: Files, Images and Analysis pause under phone control. The person confirms exactly
    // which before this phone takes the conversation over; the desktop refuses anything else.
    var takeoverOpen by rememberSaveable(session.id) { mutableStateOf(false) }
    var acknowledged by remember(session.id, session.workbenchFamilies) { mutableStateOf<List<String>?>(null) }
    val takeoverNeeded = session.workbenchTakeover == "acknowledge" && state.has("workbench.takeover")
    var failedSend by rememberSaveable(session.id) { mutableStateOf(false) }
    fun send() {
        if (takeoverNeeded && acknowledged == null) { takeoverOpen = true; return }
        val sentText = draft; val sentAttachments = attachments.map { it.id }.toSet(); val searchThisTurn = webSearch; val families = acknowledged
        if (sending || !canCompose || draft.isBlank() || storedDraft.conflict) return
        sending = true; failedSend = false; error = null
        scope.launch {
            val action = try { repository.prepareSend(session.id, sentText, webSearch = searchThisTurn, workbenchAcknowledged = families) } catch (cancelled: CancellationException) { sending = false; throw cancelled } catch (failure: Exception) {
                sending = false; failedSend = failure !is CommandPendingException; error = failure.message
                if ((failure as? RemoteRequestException)?.code == "REVISION_CONFLICT") repository.selectSession(session.id)
                return@launch
            }
            repository.launchSend(action, session.id, sentText, sentAttachments) { result ->
                sending = false
                // Like the desktop, web search applies to one accepted message only.
                result.onSuccess { webSearch = false }.onFailure { failure ->
                    failedSend = failure !is CommandPendingException
                    error = failure.message
                    if ((failure as? RemoteRequestException)?.code == "REVISION_CONFLICT") scope.launch { repository.selectSession(session.id) }
                }
            }
        }
    }
    var loadAttempt by remember(session.id) { mutableIntStateOf(0) }
    var loadingHistory by remember(session.id) { mutableStateOf(false) }
    var historyError by remember(session.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(session.id, state.connection is ConnectionState.Online, loadAttempt) {
        if (state.connection !is ConnectionState.Online) return@LaunchedEffect
        loadingHistory = true
        historyError = null
        try { repository.loadMessages(session.id) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { historyError = failure.message ?: strings.getString(R.string.conversation_history_load_failed) }
        finally { loadingHistory = false }
    }
    // A reply that finishes while this conversation is on screen has been read, as on the desktop.
    LaunchedEffect(session.id, session.unread) { if (session.unread) repository.markRead(session.id) }
    LaunchedEffect(storedDraft.text, storedDraft.dirty, storedDraft.conflict) { if (!storedDraft.dirty && draft != storedDraft.text) draft = storedDraft.text }
    LaunchedEffect(activityOpen, activityRefresh, session.id, state.connection is ConnectionState.Online) {
        if (activityOpen && state.supports("activity.list")) {
            activityLoading = true; activityError = null
            try { repository.loadActivity(session.id) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { activityError = failure.message }
            finally { activityLoading = false }
        }
    }
    val canAutosave = !sending && draftEditable && session.draftIncluded && session.mode == "managed" &&
        state.supports("drafts.put") && storedDraft.dirty && !storedDraft.conflict
    LaunchedEffect(session.id, canAutosave, storedDraft.text, storedDraft.remoteRevision) {
        if (canAutosave) {
            delay(700)
            repository.autosaveDraft(session.id)
        }
    }
    val messages = remember(state.messages, session.id) { state.messages.filter { it.sessionId == session.id }.sortedBy { it.time } }
    val activityItems = remember(messages) { messages.filterNot(Message::isConversationMessage) }
    val unknownSend = state.pendingCommands.firstOrNull { it.sessionId == session.id && it.method == "sessions.send" && it.status == "unknown" }
    val stopPending = state.pendingCommands.any { it.sessionId == session.id && it.method == "sessions.stop" }
    var stoppingLocally by remember(session.id) { mutableStateOf(false) }
    val canStop = busy && state.supports("sessions.stop")
    val primarySending = sending || state.pendingCommands.any { it.sessionId == session.id && it.method == "sessions.send" && it.status != "unknown" }
    val stop: () -> Unit = {
        if (canStop && !stoppingLocally && !stopPending && session.status != "stopping") {
            stoppingLocally = true
            scope.launch {
                try { repository.mutate("sessions.stop", buildJsonObject { put("sessionId", session.id) }, session.title) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { error = failure.message }
                finally { stoppingLocally = false }
            }
        }
    }
    var reviewingOutcome by remember(session.id) { mutableStateOf(false) }
    val sendHint = when {
        session.mode == "linked" -> stringResource(R.string.conversation_linked_hint)
        state.connection !is ConnectionState.Online -> null
        !session.canSend -> stringResource(R.string.conversation_sending_unavailable)
        !session.draftIncluded -> stringResource(R.string.conversation_loading_draft)
        session.draftAttachmentCount == null -> stringResource(R.string.conversation_restart_for_attachments)
        !draftEditable -> pluralStringResource(R.plurals.conversation_desktop_draft_locked, session.draftAttachmentCount ?: 0, session.draftAttachmentCount ?: 0)
        desktopAttachments.isNotEmpty() && !state.supports("attachments.commit") -> stringResource(R.string.conversation_attachment_permission_needed)
        storedDraft.conflict -> stringResource(R.string.conversation_resolve_draft_conflict)
        sending -> stringResource(R.string.conversation_sending)
        !attachmentsReady -> stringResource(R.string.conversation_finish_images)
        state.pendingCommands.any { it.sessionId == session.id && it.method == "sessions.send" } -> stringResource(R.string.conversation_checking_send)
        busy && session.canQueue && desktopAttachments.isNotEmpty() -> stringResource(R.string.conversation_queue_no_attachments)
        session.queuedCount > 0 -> pluralStringResource(R.plurals.conversation_messages_queued, session.queuedCount, session.queuedCount)
        busy && session.canQueue -> stringResource(R.string.conversation_queue_hint)
        // Busy and not queueable from here: say why, and what can be done instead.
        busy && session.canSend && session.status != "stopping" -> if (session.provider == "ollama") stringResource(R.string.conversation_desktop_turn_hint)
            else stringResource(R.string.conversation_provider_busy_hint, session.provider.replaceFirstChar(Char::uppercase))
        else -> null
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val room = maxHeight
        Column(Modifier.fillMaxSize()) {
            val portraitShown by UiPreferences.portrait(context).collectAsState()
            val portraitState = PortraitState.resolve(state.connection is ConnectionState.Online, session.status, session.activity, waitingApprovals.size,
                state.permissions["paused"]?.jsonPrimitive?.booleanOrNull == true)
            if (room >= ConversationTokens.headerMinHeight) Surface(color = MaterialTheme.colorScheme.surface) {
                Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.headerHeight).padding(end = PALLayout.tight),
                    verticalAlignment = Alignment.CenterVertically) {
                    IconButton(goBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.go_back)) }
                    if (portraitShown && room >= ConversationTokens.portraitMinHeight) portraitSheet?.let {
                        StatusPortrait(it, portraitState, size = PALLayout.portraitCompact)
                        Spacer(Modifier.width(PALLayout.small))
                    }
                    Column(Modifier.weight(1f).padding(vertical = PALLayout.tight)) {
                        Text(session.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.semantics { heading() })
                        val online = state.connection is ConnectionState.Online
                        Text(listOfNotNull(if (online) sessionDisplayStatus(session, waitingApprovals.size) else connectionTitle(state),
                            session.model?.takeIf(String::isNotBlank) ?: state.traits(session.provider).label).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (online) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.tertiary,
                            style = MaterialTheme.typography.labelMedium)
                    }
                    var options by remember { mutableStateOf(false) }
                    Box {
                        IconButton({ options = true }) { Icon(Icons.Default.MoreVert, stringResource(R.string.chat_options)) }
                        DropdownMenu(options, { options = false }) {
                            DropdownMenuItem({ Text(stringResource(R.string.chat_settings)) },
                                { options = false; showConversationSettings = true }, leadingIcon = { Icon(Icons.Default.Settings, null) })
                            if (state.supports("activity.list") || activityItems.isNotEmpty() || session.agents.isNotEmpty())
                                DropdownMenuItem({ Text(stringResource(R.string.activity_label)) }, { options = false; activityOpen = true },
                                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.List, null) })
                            if (state.supports("messages.bookmarks")) DropdownMenuItem({ Text(stringResource(R.string.pinned_replies)) },
                                { options = false; pinnedOpen = true }, leadingIcon = { Icon(Icons.Default.Star, null) })
                            DropdownMenuItem({ Text(stringResource(R.string.nav_inbox)) }, { options = false; openInbox() },
                                leadingIcon = { Icon(Icons.Default.Notifications, null) })
                            if (canSearchWeb) DropdownMenuItem({ Text(stringResource(R.string.conversation_web_search)) }, { options = false; webSearch = !webSearch },
                                enabled = !sending && (!busy || session.canQueue), trailingIcon = { Checkbox(webSearch, null) })
                        }
                    }
                }
            }
            key(session.id) {
                if (messages.isEmpty() && loadingHistory) Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                } else if (messages.isEmpty() && historyError != null) Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(PALLayout.gutter)) {
                    SecureStatusPanel(stringResource(R.string.conversation_history_unavailable), historyError.orEmpty(), tone = SecureTone.Attention)
                    TextButton({ loadAttempt++ }, enabled = state.connection is ConnectionState.Online) { Text(stringResource(R.string.conversation_retry_history)) }
                } else ConversationTimeline(messages, busy, session.status, Modifier.weight(1f), state.messagesBefore[session.id] != null, loadingOlder, {
                    loadingOlder = true
                    scope.launch { try { repository.loadOlderMessages(session.id) } catch (failure: Exception) { error = failure.message } finally { loadingOlder = false } }
                }, statusText = when {
                    waitingApprovals.isNotEmpty() -> if (waitingApprovals.size == 1) stringResource(R.string.conversation_input_needed, waitingApprovals.first().title) else pluralStringResource(R.plurals.conversation_requests_needed, waitingApprovals.size, waitingApprovals.size)
                    // Waiting on something this phone cannot answer or see: say where it is.
                    session.status == "waiting" && !state.supports("approvals.answer") -> stringResource(R.string.conversation_waiting_desktop_only)
                    activeAgents.isNotEmpty() -> pluralStringResource(R.plurals.conversation_agents_working, activeAgents.size, activeAgents.size)
                    // What the turn is doing, in the desktop's words; unknown activities keep the general line.
                    session.status == "starting" || session.status == "working" -> activityLabel(session.activity)
                    else -> null
                }, sessionId = session.id, restoredPosition = state.scrollPositions[session.id],
                    onPositionChanged = repository::recordScrollPosition) { message -> MessageBubble(repository, state, message) }
            }
            // Controls under the conversation scroll on their own and never take more than about
            // half the space, so large text and the keyboard leave the message field usable.
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, tonalElevation = PALLayout.hairline) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(Modifier.widthIn(max = PALLayout.readingWidth).fillMaxWidth().heightIn(max = room * 0.38f)
                .verticalScroll(rememberScrollState()).padding(top = PALLayout.tight)) {
                if (messages.isNotEmpty() && historyError != null) TextButton({ loadAttempt++ }, enabled = state.connection is ConnectionState.Online) {
                    Text(stringResource(R.string.conversation_refresh_failed))
                }
                session.error?.let { Text(it, color = MaterialTheme.colorScheme.error, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = PALLayout.gutter)) }
                if (storedDraft.conflict) Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap),
                    shape = MaterialTheme.shapes.medium,
                ) {
                    Column(Modifier.padding(PALLayout.groupGap)) {
                        Text(stringResource(R.string.conversation_draft_changed), fontWeight = FontWeight.SemiBold)
                        Text(stringResource(R.string.conversation_draft_preserved))
                        FlowRow {
                            TextButton({ scope.launch { repository.reloadRemoteDraft(session.id, storedDraft.remoteRevision) } }) { Text(stringResource(R.string.conversation_reload_desktop)) }
                            TextButton({ scope.launch { repository.keepLocalDraft(session.id, storedDraft.remoteRevision) } }) { Text(stringResource(R.string.conversation_keep_phone_edit)) }
                        }
                    }
                }
                if (waitingApprovals.isNotEmpty()) {
                    TextButton({ activityOpen = false; reviewOpen = true }, modifier = Modifier.fillMaxWidth()) { Text(if (waitingApprovals.size > 1) stringResource(R.string.review_other_requests, waitingApprovals.first().title, waitingApprovals.size - 1) else stringResource(R.string.review_one_request, waitingApprovals.first().title), maxLines = 2, overflow = TextOverflow.Ellipsis) }
                }
                session.workbenchNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary, modifier = Modifier.padding(horizontal = PALLayout.gutter, vertical = PALLayout.tight)) }
                if (failedSend && unknownSend == null) Text(stringResource(R.string.transcript_send_failed),
                    Modifier.padding(horizontal = PALLayout.groupGap).semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                (error ?: state.lastError)?.let { Row(Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    IconButton({ error = null; scope.launch { repository.dismissError() } }) { Icon(Icons.Default.Close, stringResource(R.string.conversation_dismiss_error)) }
                } }
                if (busy) FlowRow(Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    TextButton({ activityOpen = true }, enabled = state.supports("activity.list") || activityItems.isNotEmpty() || session.agents.isNotEmpty()) {
                        Icon(Icons.AutoMirrored.Filled.List, null)
                        Text(stringResource(R.string.activity_label))
                    }
                    if (canStop && session.canQueue && draft.isNotBlank()) {
                        TextButton(::send, enabled = canCompose && !storedDraft.conflict) {
                            Text(stringResource(R.string.transcript_queue_action))
                        }
                    }
                }
                if (state.connection !is ConnectionState.Online) ConnectionRecovery(state, repository::retry)
                if (webSearch) Text(stringResource(R.string.conversation_web_search_disclosure), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary, modifier = Modifier.padding(horizontal = PALLayout.gutter))
                if (attachments.isNotEmpty()) LazyRow(contentPadding = PaddingValues(horizontal = PALLayout.groupGap), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { items(attachments, key = { it.id }) { attachment ->
                    LocalAttachmentCard(
                        attachment = attachment, now = now, stage = uploading[attachment.id],
                        canUpload = state.supports("attachments.begin") && state.supports("attachments.commit"),
                        onReview = { attachmentReviewId = attachment.id }, onUpload = { upload(attachment) }, onRemove = { remove(attachment) },
                    )
                } }
                if (desktopAttachments.isNotEmpty() && draftEditable) {
                    Text(stringResource(R.string.conversation_desktop_draft_label), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = PALLayout.gutter, vertical = PALLayout.tight))
                    LazyRow(contentPadding = PaddingValues(horizontal = PALLayout.groupGap), horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { items(desktopAttachments, key = { it.id }) { attachment ->
                        DesktopAttachmentCard(
                            attachment = attachment, canRemove = !sending && !storedDraft.conflict && state.supports("drafts.put"),
                            onReview = { desktopReviewId = attachment.id }, onRemove = { desktopRemoveId = attachment.id },
                        )
                    } }
                }
                sendHint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = PALLayout.gutter).semantics { liveRegion = LiveRegionMode.Polite }) }
                // F11: a linked conversation continues in its terminal on the desktop; this brings that window forward there.
                if (session.mode == "linked" && state.supports("sessions.focusTerminal")) OutlinedButton({
                    signedReview(activity, repository, "sessions.focusTerminal", buildJsonObject { put("sessionId", session.id) }, strings.getString(R.string.conversation_focus_terminal_review), { error = null }, { error = it }, label = session.title)
                }, modifier = Modifier.padding(horizontal = PALLayout.groupGap)) { Text(stringResource(R.string.conversation_open_desktop)) }
                if (unknownSend != null) TextButton({ reviewingOutcome = true }, modifier = Modifier.padding(horizontal = PALLayout.small)) { Text(stringResource(R.string.conversation_review_uncertain_send)) }
            } }
            }
            if (state.owner && session.mode == "managed") VoiceBar(repository, session.id, state.messages.filter { it.sessionId == session.id }, busy) { spoken ->
                val next = (if (draft.isBlank()) "" else draft.trimEnd() + " ") + spoken
                if (next.length <= 100_000) { draft = next; repository.editDraft(session.id, next) }
            }
            ConversationComposer(
                sendFromKeyboard = remember(context) { UiPreferences.sendFromKeyboard(context) },
                value = draft,
                onValueChange = { if (it.length <= 100_000) { failedSend = false; draft = it; repository.editDraft(session.id, it) } },
                enabled = session.mode == "managed" && session.draftIncluded && draftEditable && !sending,
                placeholder = stringResource(if (busy && session.canQueue) R.string.queue_message else R.string.compose_message, state.assistantName),
                canSend = draft.isNotBlank() && canCompose && !storedDraft.conflict,
                onSend = ::send,
                onStop = if (canStop) stop else null,
                stopping = stoppingLocally || stopPending || session.status == "stopping",
                sending = primarySending,
                retrySend = failedSend && unknownSend == null,
                queue = busy && session.canQueue,
                modifier = Modifier.heightIn(max = (room * 0.32f).coerceAtLeast(PALLayout.shortField)),
                leadingContent = if (canAttach) { {
                    Box {
                        IconButton({ attachMenu = true }, modifier = Modifier.size(PALLayout.target)) { Icon(Icons.Default.Add, stringResource(R.string.attach_image)) }
                        DropdownMenu(attachMenu, { attachMenu = false }) {
                            DropdownMenuItem({ Text(stringResource(R.string.photo_library)) }, { attachMenu = false; picker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
                            DropdownMenuItem({ Text(stringResource(R.string.screenshot_file)) }, { attachMenu = false; files.launch("image/*") })
                            DropdownMenuItem({ Text(stringResource(R.string.camera)) }, { attachMenu = false; takePhoto() })
                        }
                    }
                } } else null,
            )
        }
    }
    if (showConversationSettings) ConversationSettingsSheet(repository, state, session, activity) { showConversationSettings = false }
    if (pinnedOpen) PinnedReplies(repository, state, session.id) { pinnedOpen = false }
    if (takeoverOpen) AlertDialog(onDismissRequest = { takeoverOpen = false }, title = { Text(stringResource(R.string.conversation_continue_phone)) },
        text = { Text(stringResource(R.string.conversation_workbench_takeover_body, session.workbenchNote ?: stringResource(R.string.conversation_workbench_takeover_default))) },
        confirmButton = { Button({ takeoverOpen = false; acknowledged = session.workbenchFamilies; send() }) { Text(stringResource(R.string.conversation_continue_without_tools)) } },
        dismissButton = { TextButton({ takeoverOpen = false }) { Text(stringResource(R.string.conversation_keep_desktop)) } })
    if (activityOpen) ActivityPanel(activityItems, activityLoading, activityError, { activityRefresh++ }, { activityOpen = false },
        agents = session.agents, canOpenAgent = { agent -> state.sessions.any { it.id == agent.id } },
        onOpenAgent = { agent -> activityOpen = false; selectSession(agent.id) },
        hasOlder = state.activityBefore[session.id] != null, loadingOlder = activityOlderLoading,
        onLoadOlder = { activityOlderLoading = true; scope.launch { try { repository.loadOlderActivity(session.id) } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { activityError = failure.message } finally { activityOlderLoading = false } } }) { item -> ActivityRow(repository, state, item) }
    if (reviewingOutcome && unknownSend != null) AlertDialog(onDismissRequest = { reviewingOutcome = false }, title = { Text(stringResource(R.string.conversation_check_previous_send)) },
        text = { Text(stringResource(R.string.conversation_uncertain_send_body)) },
        confirmButton = { TextButton({ scope.launch { repository.acknowledgeUnknownCommand(unknownSend.commandId); reviewingOutcome = false; error = null } }) { Text(stringResource(R.string.conversation_reviewed_pc)) } },
        dismissButton = { TextButton({ reviewingOutcome = false }) { Text(stringResource(R.string.conversation_keep_waiting)) } })
    if (reviewOpen) ModalBottomSheet({ reviewOpen = false }) {
        Text(stringResource(R.string.conversation_requests_title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(PALLayout.inset))
        LazyColumn(Modifier.heightIn(max = PALLayout.sheetBodyHeight), contentPadding = PaddingValues(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
            items(waitingApprovals, key = { it.id }) { ApprovalCard(repository, state, activity, it) }
            if (waitingApprovals.isEmpty()) item { Text(stringResource(R.string.conversation_requests_answered)) }
        }
    }
    desktopAttachments.firstOrNull { it.id == desktopReviewId }?.let { attachment ->
        DesktopAttachmentDialog(repository, state, session.id, attachment, onRemove = { desktopReviewId = null; desktopRemoveId = attachment.id }, onDismiss = { desktopReviewId = null })
    }
    desktopAttachments.firstOrNull { it.id == desktopRemoveId }?.let { attachment ->
        AlertDialog(onDismissRequest = { desktopRemoveId = null }, title = { Text(stringResource(R.string.conversation_remove_attachment_question, attachment.name)) },
            text = { Text(stringResource(R.string.conversation_remove_attachment_body)) },
            confirmButton = { TextButton({ desktopRemoveId = null; scope.launch { runCatching { repository.removeDesktopAttachment(session.id, attachment.id) }.onFailure { failure ->
                error = failure.message; if ((failure as? RemoteRequestException)?.code == "REVISION_CONFLICT") repository.selectSession(session.id) } } },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.action_remove)) } },
            dismissButton = { TextButton({ desktopRemoveId = null }) { Text(stringResource(R.string.conversation_keep)) } })
    }
    val reviewingAttachment = attachments.firstOrNull { it.id == attachmentReviewId }
    if (reviewingAttachment != null) AttachmentReviewDialog(repository, reviewingAttachment,
        onKeep = { scope.launch { repository.markAttachmentReviewed(reviewingAttachment.id); attachmentReviewId = null } },
        onRemove = { scope.launch { repository.removeAttachment(reviewingAttachment.id); attachmentReviewId = null } },
        onDismiss = { attachmentReviewId = null })
}

/** Decodes an image for display with its longer side at most [maxSide] pixels. */
internal fun decodeForDisplay(bytes: ByteArray, maxSide: Int): android.graphics.Bitmap? {
    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
}

@Composable
private fun AttachmentReviewDialog(repository: PALRepository, attachment: LocalAttachment, onKeep: () -> Unit, onRemove: () -> Unit, onDismiss: () -> Unit) {
    val decodeFailure = stringResource(R.string.conversation_private_image_decode_failed)
    var previewAttempt by remember(attachment.id) { mutableIntStateOf(0) }
    var bitmap by remember(attachment.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(attachment.id, previewAttempt) {
        error = null
        try {
            val bytes = repository.attachmentPreview(attachment.id)
            bitmap = withContext(Dispatchers.Default) { decodeForDisplay(bytes, 2048) } ?: error(decodeFailure)
        } catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(stringResource(R.string.conversation_review_image)) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(stringResource(R.string.conversation_private_image_disclosure), color = MaterialTheme.colorScheme.onSurfaceVariant)
            ReviewImage(bitmap, stringResource(R.string.conversation_selected_image), error == null,
                attachment.width.toFloat() / attachment.height.coerceAtLeast(1))
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
                TextButton({ previewAttempt++ }) { Text(stringResource(R.string.photo_preview_retry)) }
            }
            Text(stringResource(R.string.image_dimensions_size, attachment.width, attachment.height, attachment.size / 1024), style = MaterialTheme.typography.bodySmall)
        }
    }, confirmButton = { Button(onKeep, enabled = bitmap != null, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.conversation_keep_for_message)) } }, dismissButton = {
        FlowRow { TextButton(onDismiss, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.conversation_review_later)) }; TextButton(onRemove,
            modifier = Modifier.heightIn(min = PALLayout.target), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.action_remove)) } }
    })
}

/** W10: what a desktop draft attachment contains, as the desktop will send it. */
@Composable
private fun DesktopAttachmentDialog(repository: PALRepository, state: MobileState, sessionId: String, attachment: DraftAttachment, onRemove: () -> Unit, onDismiss: () -> Unit) {
    val decodeFailure = stringResource(R.string.conversation_preview_decode_failed)
    val previewable = attachment.kind != "image" || state.supports("attachments.read")
    var previewAttempt by remember(attachment.id) { mutableIntStateOf(0) }
    var bitmap by remember(attachment.id) { mutableStateOf<android.graphics.Bitmap?>(null) }
    var text by remember(attachment.id) { mutableStateOf<DesktopAttachmentPreview.Text?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(attachment.id, previewable, previewAttempt) {
        error = null
        if (!previewable) return@LaunchedEffect
        try {
            when (val preview = repository.desktopAttachmentPreview(sessionId, attachment.id)) {
                is DesktopAttachmentPreview.Image -> bitmap = withContext(Dispatchers.Default) { decodeForDisplay(preview.preview.bytes, 2048) } ?: error(decodeFailure)
                is DesktopAttachmentPreview.Text -> text = preview
            }
        } catch (cancelled: CancellationException) { throw cancelled } catch (_: StaleResultException) {} catch (failure: Exception) { error = failure.message }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(attachment.name, maxLines = 2, overflow = TextOverflow.Ellipsis) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(stringResource(R.string.conversation_desktop_attachment_disclosure), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (previewable && attachment.kind == "image") ReviewImage(bitmap, stringResource(R.string.conversation_attachment_preview, attachment.name), error == null)
            text?.let { preview ->
                SelectionContainer { Text(preview.text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                if (preview.truncated) Text(stringResource(R.string.conversation_preview_truncated), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
            }
            if (!previewable) Text(stringResource(R.string.conversation_preview_permission_needed), style = MaterialTheme.typography.bodySmall)
            else if (attachment.kind != "image" && text == null && error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
                TextButton({ previewAttempt++ }) { Text(stringResource(R.string.photo_preview_retry)) }
            }
            Text(stringResource(if (attachment.kind == "image") R.string.conversation_image_size else R.string.conversation_text_file_size, attachment.size / 1024), style = MaterialTheme.typography.bodySmall)
        }
    }, confirmButton = { Button(onDismiss, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.action_done)) } }, dismissButton = {
        TextButton(onRemove, enabled = state.supports("drafts.put"), modifier = Modifier.heightIn(min = PALLayout.target),
            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.conversation_remove_from_draft)) }
    })
}

@Composable internal fun ActivityRow(repository: PALRepository, state: MobileState, item: Message) {
    val clipboard = LocalContext.current.getSystemService(android.content.ClipboardManager::class.java)
    val scope = rememberCoroutineScope()
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    var content by remember(item.id, item.revision) { mutableStateOf(item.text) }
    var loading by remember(item.id) { mutableStateOf(false) }
    var error by remember(item.id) { mutableStateOf<String?>(null) }
    val clipboardLabel = stringResource(R.string.conversation_pal_activity)
    val providerActivity = stringResource(R.string.conversation_provider_activity)
    Surface(Modifier.fillMaxWidth().padding(vertical = PALLayout.small), color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.medium, border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant)) { Column(Modifier.padding(PALLayout.gutter)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(item.text.lineSequence().firstOrNull()?.take(90).orEmpty().ifBlank { providerActivity }, fontWeight = FontWeight.SemiBold,
                maxLines = 2, modifier = Modifier.weight(1f))
            IconButton({ clipboard.setPrimaryClip(android.content.ClipData.newPlainText(clipboardLabel, content)) }, Modifier.size(PALLayout.target)) { Icon(painterResource(R.drawable.ic_copy), stringResource(if (item.contentTruncated && content == item.text) R.string.conversation_copy_activity_preview else R.string.conversation_copy_activity)) }
        }
        if (expanded) SelectionContainer { Text(content, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.horizontalScroll(rememberScrollState())) }
        TextButton({ expanded = !expanded }) { Text(stringResource(if (expanded) R.string.conversation_collapse else R.string.conversation_show_details)) }
        if (expanded && item.contentTruncated && content == item.text) OutlinedButton({ scope.launch {
            loading = true
            try { content = repository.fullMessage(item) } catch (failure: Exception) { error = failure.message } finally { loading = false }
        } }, enabled = !loading && state.supports("sessions.messagePart")) { Text(stringResource(if (loading) R.string.transcript_loading_full_message else R.string.conversation_load_full_output)) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    } }
}

/**
 * MOB-005: a Workbench result (proposed changes, files or images, an image or analysis run) is
 * reviewed on the desktop. The phone shows what it is and where to see it, never a partial preview.
 */
@Composable internal fun DesktopResultCard(message: Message) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row(Modifier.padding(PALLayout.groupGap), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Info, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.padding(start = PALLayout.groupGap)) {
                Text(message.desktopOnly?.label ?: stringResource(R.string.result_desktop), fontWeight = FontWeight.SemiBold)
                Text(stringResource(R.string.result_desktop_detail), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * MOB-008: which desktop build this phone is (or was last) signed in to, the protocol they agreed,
 * this app's own build, and when it last synchronized. The summary can be copied for support; it
 * names no keys, tokens, offers, addresses, IDs or conversation content.
 */
@Composable
private fun ConnectionDetails(repository: PALRepository, state: MobileState) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val context = LocalContext.current
    val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
    var copied by remember { mutableStateOf(false) }
    val app = remember(context) { installedAppIdentity(context) }
    val online = state.connection as? ConnectionState.Online
    val time = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
    OutlinedPanel(stringResource(R.string.connection_details)) {
        (state.connection as? ConnectionState.Offline)?.let { Text(it.reason, style = MaterialTheme.typography.bodySmall) }
        val build = state.desktopBuild
        val desktopBuild = when {
            build == null -> strings.getString(R.string.mobile_desktop_build_unknown)
            online != null -> strings.getString(R.string.mobile_desktop_build, ConnectionDiagnostics.buildText(build))
            else -> strings.getString(R.string.mobile_desktop_build_last_seen, ConnectionDiagnostics.buildText(build), time.format(java.util.Date(build.seenAt)))
        }
        val usable = state.providers.count { (_, value) -> (value as? JsonObject)?.get("remoteExecution")?.jsonPrimitive?.booleanOrNull == true }
        Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                Text(if (online != null) stringResource(R.string.mobile_connected) else stringResource(R.string.mobile_last_known_connection), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = if (online != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary)
                SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    Text(stringResource(R.string.mobile_pal_mobile_channel, app.versionName, app.versionCode, app.channel), style = MaterialTheme.typography.bodySmall)
                    Text(desktopBuild, style = MaterialTheme.typography.bodySmall)
                    Text(if (online == null) stringResource(R.string.mobile_protocol, ConnectionDiagnostics.protocolText(build)) else stringResource(R.string.features_and_ops, stringResource(R.string.mobile_protocol, ConnectionDiagnostics.protocolText(build)), online.features.size, online.operations.size), style = MaterialTheme.typography.bodySmall)
                    Text(stringResource(R.string.mobile_providers_usable_from_this_phone_of, usable, state.providers.size), style = MaterialTheme.typography.bodySmall)
                    Text(stringResource(R.string.mobile_last_synchronized, repository.lastSynchronizedAt()?.let { time.format(java.util.Date(it)) } ?: "never"), style = MaterialTheme.typography.bodySmall)
                } }
            }
        }
        Text(stringResource(R.string.mobile_this_summary_excludes_keys_tokens_network_addresses_device), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedButton({ clipboard.setPrimaryClip(android.content.ClipData.newPlainText(strings.getString(R.string.mobile_pal_connection_details), ConnectionDiagnostics.summary(app, state, repository.lastSynchronizedAt()))); copied = true }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) {
            Icon(painterResource(R.drawable.ic_copy), null); Spacer(Modifier.width(PALLayout.small)); Text(if (copied) stringResource(R.string.mobile_copied) else stringResource(R.string.mobile_copy_diagnostic_summary))
        }
    }
}

/** F77: the desktop's memory health in plain words; details stay in desktop Health. */
@Composable
private fun MemoryHealthLine(health: JsonObject) {
    val enabled = health["enabled"]?.jsonPrimitive?.booleanOrNull == true
    val extraction = health["extraction"]?.jsonPrimitive?.contentOrNull == "failing"
    val embeddings = health["embedding"]?.jsonPrimitive?.contentOrNull == "failing"
    val degraded = health["degraded"]?.jsonPrimitive?.booleanOrNull == true ||
        health["projections"]?.jsonArray.orEmpty().any { (it as? JsonObject)?.str("status") == "degraded" }
    val label = when {
        !enabled -> R.string.mobile_memory_is_off_or_paused_on_the_desktop
        extraction && embeddings -> R.string.memory_extraction_embeddings_failed
        extraction -> R.string.memory_extraction_failed
        embeddings -> R.string.memory_embeddings_failed
        degraded -> R.string.memory_degraded
        else -> R.string.mobile_memory_is_working
    }
    Text(stringResource(label), style = MaterialTheme.typography.bodySmall,
        color = if (enabled && (extraction || embeddings || degraded)) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** W11: the conversation's pinned replies, the same ones the desktop lists as bookmarks. */
@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun PinnedReplies(repository: PALRepository, state: MobileState, sessionId: String, onDismiss: () -> Unit) {
    var items by remember(sessionId) { mutableStateOf<List<Message>?>(null) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(sessionId, refresh) {
        error = null
        try { items = repository.pinnedReplies(sessionId) }
        catch (cancelled: CancellationException) { throw cancelled } catch (_: StaleResultException) {} catch (failure: Exception) { error = failure.message }
    }
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(Modifier.fillMaxWidth().padding(horizontal = PALLayout.inset), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.pinned_replies), style = MaterialTheme.typography.headlineSmall)
                Text(stringResource(R.string.mobile_shared_with_desktop_bookmarks), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onDismiss, Modifier.size(PALLayout.target)) { Icon(Icons.Default.Close, stringResource(R.string.mobile_close_pinned_replies)) }
        }
        LazyColumn(Modifier.heightIn(max = PALLayout.sheetBodyHeight).consumeExpandedSheetEdgeScroll(), contentPadding = PaddingValues(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            when {
                error != null -> item { Text(error!!, color = MaterialTheme.colorScheme.error) }
                items == null -> item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                items!!.isEmpty() -> item { Text(stringResource(R.string.mobile_no_pinned_replies_yet_pin_a_reply_with)) }
                else -> items(items!!, key = { it.id }) { message -> MessageBubble(repository, state, message.copy(bookmarked = true)) }
            }
            item { TextButton({ refresh++ }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Icon(Icons.Default.Refresh, null); Spacer(Modifier.width(PALLayout.small)); Text(stringResource(R.string.action_refresh)) } }
        }
    }
}

@Composable
internal fun InboxScreen(repository: PALRepository, state: MobileState, activity: FragmentActivity, highlighted: String? = null) {
    val gone = highlighted != null && state.approvals.none { it.id == highlighted }
    if (state.approvals.isEmpty() && state.connection !is ConnectionState.Online) return RecoveryPage(state, repository::retry)
    if (state.approvals.isEmpty()) return EmptyState(Icons.Default.Check, stringResource(R.string.mobile_inbox_clear),
        stringResource(if (gone) R.string.mobile_the_request_you_opened_was_already_answered_or else R.string.mobile_requests_that_need_your_review_appear_here))
    val list = rememberLazyListState()
    // A notification tap scrolls to its request.
    LaunchedEffect(highlighted, state.approvals.map(Approval::id)) {
        val index = state.approvals.indexOfFirst { it.id == highlighted }
        if (index >= 0) list.animateScrollToItem(index)
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = PALLayout.readingWidth).fillMaxWidth()) {
            Column(Modifier.padding(horizontal = PALLayout.gutter, vertical = PALLayout.groupGap), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                PageTitle(stringResource(R.string.nav_inbox))
                Text(pluralStringResource(R.plurals.waiting_requests, state.approvals.size, state.approvals.size), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            LazyColumn(state = list, modifier = Modifier.weight(1f), contentPadding = PaddingValues(start = PALLayout.gutter, end = PALLayout.gutter, bottom = PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
                items(state.approvals, key = { it.id }) { approval -> ApprovalCard(repository, state, activity, approval, highlighted = approval.id == highlighted) }
                if (gone) item { Text(stringResource(R.string.mobile_the_request_you_opened_was_already_answered_or), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@Composable
private fun ApprovalCard(repository: PALRepository, state: MobileState, activity: FragmentActivity, approval: Approval, highlighted: Boolean = false) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope(); var error by remember(approval.id, approval.revision, approval.digest) { mutableStateOf<String?>(null) }; var expanded by remember(approval.id) { mutableStateOf(true) }; var preview by remember(approval.id, approval.revision, approval.digest) { mutableStateOf<ApprovalPreview?>(null) }; var previewLoading by remember(approval.id, approval.revision, approval.digest) { mutableStateOf(false) }
    var validationAttempted by remember(approval.id, approval.revision, approval.digest) { mutableStateOf(false) }
    val drafts by repository.questionDrafts.collectAsStateWithLifecycle()
    val mutations by repository.approvalMutations.collectAsStateWithLifecycle()
    val uriHandler = LocalUriHandler.current
    val answers = drafts[approval.id].orEmpty()
    val questionIds = approval.questions.mapTo(mutableSetOf(), ApprovalQuestion::id); val fieldIds = approval.fields.keys
    fun schema(id: String) = approval.fields[id] as? JsonObject
    fun supported(value: JsonObject?): Boolean {
        if (value == null) return true
        val type = value["type"]?.jsonPrimitive?.contentOrNull
        if (type == "array") {
            val items = value["items"] as? JsonObject ?: return false
            return items["type"]?.jsonPrimitive?.contentOrNull == "string" &&
                items["enum"] is JsonArray && items["enum"]!!.jsonArray.all { it is JsonPrimitive }
        }
        if (type !in setOf("string","boolean","number","integer")) return false
        return value["enum"]?.let { it is JsonArray && it.all { option -> option is JsonPrimitive } } != false &&
            value["oneOf"]?.let { it is JsonArray && it.all { option -> option is JsonObject && option["const"] is JsonPrimitive } } != false
    }
    fun validField(id: String): Boolean {
        val values = answers[id].orEmpty()
        val field = schema(id)
        if (!supported(field)) return false
        val type = field?.get("type")?.jsonPrimitive?.contentOrNull
        if (type == "array") {
            val allowed = (field?.get("items") as? JsonObject)?.get("enum")?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
            val minimum = field?.get("minItems")?.jsonPrimitive?.intOrNull ?: 1
            val maximum = field?.get("maxItems")?.jsonPrimitive?.intOrNull ?: Int.MAX_VALUE
            return values.size in minimum..maximum && values.distinct().size == values.size && values.all { it in allowed }
        }
        val answer = values.firstOrNull()?.trim().orEmpty()
        if (answer.isBlank()) return false
        if (type == "boolean" && answer !in setOf("true","false")) return false
        if (type in setOf("number","integer")) { val number = answer.toDoubleOrNull() ?: return false; if (type == "integer" && number % 1.0 != 0.0) return false; field?.get("minimum")?.jsonPrimitive?.doubleOrNull?.let { if (number < it) return false }; field?.get("maximum")?.jsonPrimitive?.doubleOrNull?.let { if (number > it) return false } }
        field?.get("enum")?.jsonArray?.let { if (answer !in it.map { option -> option.jsonPrimitive.content }) return false }
        field?.get("oneOf")?.jsonArray?.let { if (answer !in it.mapNotNull { option -> option.jsonObject["const"]?.jsonPrimitive?.contentOrNull }) return false }
        return true
    }
    val unsupported = approval.fields.values.any { !supported(it as? JsonObject) }
    val answersComplete = approval.questions.all { questionError(it, answers[it.id].orEmpty()) == null } && fieldIds.all(::validField)
    // Only an answer in flight for this exact request blocks it; an uncertain answer to an
    // earlier request, or to another request in the same conversation, does not.
    val uncertain = state.pendingCommands.any {
        it.method == "approvals.answer" && it.approvalId == approval.id && it.approvalDigest == approval.digest && it.status == "unknown"
    }
    val pending = uncertain || approval.id in mutations || CommandOutcomes.answering(state.pendingCommands, approval.id, approval.digest)
    var bitmap by remember(approval.id, approval.revision, approval.digest) { mutableStateOf<android.graphics.Bitmap?>(null) }
    val isQuestion = approval.kind == "question" || approval.questions.isNotEmpty()
    Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.large,
        border = if (highlighted) BorderStroke(PALLayout.focusStroke, MaterialTheme.colorScheme.primary) else null) { Column(Modifier.padding(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
        Row(verticalAlignment = Alignment.Top) {
            Surface(shape = MaterialTheme.shapes.medium, color = if (isQuestion) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.tertiaryContainer) {
                Icon(if (isQuestion) Icons.Default.Info else Icons.Default.Warning, null, tint = if (isQuestion) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(PALLayout.small).size(PALLayout.icon))
            }
            Spacer(Modifier.width(PALLayout.groupGap))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
                Text(if (isQuestion) stringResource(R.string.approval_question) else stringResource(R.string.approval_permission, approval.kind), style = MaterialTheme.typography.labelMedium, color = if (isQuestion) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.SemiBold)
                Text(approval.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
            // Where the request comes from: the conversation, the agent inside it, and the conversation that delegated it.
                Text(approvalOrigin(state, approval), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        val project = state.sessions.firstOrNull { it.id == approval.sessionId }?.project
        if (!project.isNullOrBlank()) {
            Text(stringResource(R.string.request_project), style = MaterialTheme.typography.labelLarge)
            SelectionContainer { Text(project, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace) }
        }
        approval.detail?.let {
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.animateContentSize(PALMotion.disclosure)) {
                    val label = stringResource(if (expanded) R.string.approval_target_hide else R.string.approval_target_show)
                    Row(Modifier.fillMaxWidth().clickable(onClickLabel = label) { expanded = !expanded }
                        .heightIn(min = PALLayout.target).padding(horizontal = PALLayout.groupGap),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text(stringResource(R.string.approval_target), Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                        Icon(if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown, null)
                    }
                    if (expanded) SelectionContainer { Text(it, fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(start = PALLayout.groupGap, end = PALLayout.groupGap, bottom = PALLayout.groupGap)) }
                }
            }
        }
        approval.url?.let { url ->
            Text(stringResource(R.string.approval_destination), style = MaterialTheme.typography.labelLarge)
            SelectionContainer { Text(url, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace) }
            OutlinedButton({ runCatching { uriHandler.openUri(url) }.onFailure { error = it.message ?: strings.getString(R.string.mobile_could_not_open_the_link) } }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) {
                Text(stringResource(R.string.mobile_open_link))
            }
            Text(stringResource(R.string.mobile_complete_the_requested_step_in_your_browser_then), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (approval.kind == "image") {
            val image = bitmap
            if (image != null) {
                Image(image.asImageBitmap(), stringResource(R.string.mobile_exact_capture_proposed_for_sharing), Modifier.fillMaxWidth()
                    .heightIn(max = PALLayout.previewHeight).clip(MaterialTheme.shapes.medium), contentScale = ContentScale.Fit)
                Text(stringResource(R.string.mobile_verified_capture), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
            } else if (state.supports("approvals.preview") && state.supports("attachments.read")) OutlinedButton({
                scope.launch {
                    previewLoading = true; error = null
                    try {
                        val fetched = repository.approvalPreview(approval)
                        val decoded = withContext(Dispatchers.Default) { decodeForDisplay(fetched.bytes, 2048) }
                        if (decoded == null) error = strings.getString(R.string.mobile_the_capture_could_not_be_displayed_try_again)
                        else { bitmap = decoded; preview = fetched }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (failure: Exception) { error = failure.message }
                    finally { previewLoading = false }
                }
            }, enabled = !previewLoading, modifier = Modifier.fillMaxWidth()) {
                Text(if (previewLoading) stringResource(R.string.mobile_loading_preview) else stringResource(R.string.mobile_review_exact_capture))
            } else SecureStatusPanel(stringResource(R.string.mobile_review_on_your_desktop), stringResource(R.string.mobile_this_phone_does_not_have_access_to_the), tone = SecureTone.Attention)
        }
        approval.questions.forEachIndexed { index, question ->
            QuestionField(question, index, approval.questions.size, answers[question.id].orEmpty(),
                if (validationAttempted) questionError(question, answers[question.id].orEmpty())?.let { stringResource(it) } else null) {
                repository.setQuestionAnswer(approval.id, question.id, it)
            }
        }
        approval.fields.filterKeys { it !in questionIds }.forEach { (id, value) ->
            ApprovalField(id, (value as? JsonObject)?.get("title")?.jsonPrimitive?.contentOrNull ?: id, value as? JsonObject, answers[id].orEmpty(),
                if (validationAttempted && !validField(id)) strings.getString(R.string.mobile_enter_a_valid_answer) else null) {
                repository.setQuestionAnswer(approval.id, id, it)
            }
        }
        if (unsupported) SecureStatusPanel(stringResource(R.string.mobile_continue_on_the_desktop), stringResource(R.string.mobile_this_form_contains_an_unsupported_field_you_can), tone = SecureTone.Attention)
        if (!approval.canAnswer && approval.choices.any { it !in setOf("deny","cancel") }) SecureStatusPanel(stringResource(R.string.mobile_desktop_review_required), stringResource(R.string.mobile_positive_answers_are_blocked_by_the_current_provider), tone = SecureTone.Attention)
        if (state.connection !is ConnectionState.Online) ConnectionRecovery(state, repository::retry)
        else if (!state.supports("approvals.answer")) SecureStatusPanel(stringResource(R.string.mobile_read_only_access), stringResource(R.string.mobile_this_device_can_review_this_request_but_cannot), tone = SecureTone.Attention)
        if (pending) SecureStatusPanel(if (uncertain) stringResource(R.string.mobile_answer_unconfirmed) else stringResource(R.string.mobile_submitting_response),
            stringResource(if (uncertain) R.string.pending_answer_hint else R.string.submitting_answer_hint), tone = SecureTone.Info)
        else Text(stringResource(R.string.pending_request_hint), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        // Actions wrap instead of squeezing their labels at large text sizes.
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(PALLayout.gutter)) { approval.choices.forEach { choice ->
            val deny = choice == "deny" || choice == "cancel"
            val label = when (choice) {
                "deny" -> stringResource(R.string.notice_deny)
                "cancel" -> stringResource(R.string.action_cancel)
                "allow" -> stringResource(when {
                    approval.kind == "image" -> R.string.allow_image
                    approval.url != null -> R.string.mobile_ive_completed_it
                    else -> R.string.mobile_allow
                })
                "answer" -> stringResource(R.string.mobile_send_answers)
                else -> choice.replaceFirstChar(Char::uppercase)
            }
            if (deny) OutlinedButton({
                if (!repository.beginApprovalMutation(approval)) return@OutlinedButton
                scope.launch { try { repository.mutate("approvals.answer", approvalParams(approval, choice, emptyMap()), approval.title) } catch (failure: Exception) { error = failure.message } finally { repository.endApprovalMutation(approval) } }
            }, enabled = state.supports("approvals.answer") && !pending, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(label) }
            else Button({
                validationAttempted = true
                if (!answersComplete || !repository.beginApprovalMutation(approval)) return@Button
                scope.launch {
                    runCatching { repository.prepareAction("approvals.answer", approvalParams(approval, choice, answers, preview?.imageDigest), label = approval.title) }
                        .onSuccess { action ->
                            runCatching { authenticate(activity, strings.getString(R.string.authenticate_answer, label, approval.title), action, repository,
                                { repository.endApprovalMutation(approval) },
                                { error = it; repository.endApprovalMutation(approval) }) }
                                .onFailure { error = it.message; repository.endApprovalMutation(approval) }
                        }
                        .onFailure { error = it.message; repository.endApprovalMutation(approval) }
                }
            }, enabled = approval.canAnswer && !unsupported && state.supports("approvals.answer") && !pending && (approval.kind != "image" || preview != null), modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(label) }
        } }
        if (validationAttempted && !answersComplete) Text(stringResource(R.string.mobile_answer_each_required_question_before_sending), color = MaterialTheme.colorScheme.error)
        error?.let { SecureStatusPanel(stringResource(R.string.mobile_request_needs_attention), it, tone = SecureTone.Danger) }
    } }
}

@Composable
private fun QuestionField(question: ApprovalQuestion, index: Int, count: Int, answers: List<String>, error: String?, update: (List<String>) -> Unit) {
    val other = questionOtherValue(question, answers)
    OutlinedPanel(stringResource(R.string.mobile_question_of, index + 1, count, stringResource(if (question.required) R.string.question_required else R.string.question_optional))) {
        question.header?.let { Text(it, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold) }
        Text(question.question, style = MaterialTheme.typography.bodyLarge, fontWeight = if (question.header == null) FontWeight.Medium else FontWeight.Normal)
        question.options.forEach { option ->
            val selected = option.label in answers
            FilterChip(selected, { update(selectQuestionOption(question, answers, option.label, !selected)) }, {
                Column { Text(option.label); option.description?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target))
        }
        if (question.options.isEmpty() || question.allowOther) OutlinedTextField(
            other,
            { update(updateQuestionOther(question, answers, it)) },
            label = { Text(if (question.options.isEmpty()) stringResource(R.string.mobile_answer) else stringResource(R.string.mobile_other_answer)) },
            minLines = if (question.isSecret) 1 else 2,
            maxLines = if (question.isSecret) 1 else 6,
            singleLine = question.isSecret,
            visualTransformation = if (question.isSecret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = if (question.isSecret) KeyboardType.Password else KeyboardType.Text),
            isError = error != null,
            supportingText = { error?.let { Text(it) } },
            modifier = Modifier.fillMaxWidth(),
        )
        else error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable private fun ApprovalField(id: String, label: String, schema: JsonObject?, answers: List<String>, error: String?, update: (List<String>) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val type = schema?.get("type")?.jsonPrimitive?.contentOrNull ?: "string"
    val options = when {
        type == "array" -> (schema?.get("items") as? JsonObject)?.get("enum")?.jsonArray?.map { ApprovalOption(it.jsonPrimitive.content) }.orEmpty()
        schema?.get("enum") is JsonArray -> schema["enum"]!!.jsonArray.map { ApprovalOption(it.jsonPrimitive.content) }
        schema?.get("oneOf") is JsonArray -> schema["oneOf"]!!.jsonArray.mapNotNull { option -> (option as? JsonObject)?.get("const")?.jsonPrimitive?.contentOrNull?.let { ApprovalOption(it, option["title"]?.jsonPrimitive?.contentOrNull) } }
        type == "boolean" -> listOf(ApprovalOption("true", strings.getString(R.string.mobile_yes)), ApprovalOption("false", strings.getString(R.string.mobile_no)))
        else -> emptyList()
    }
    Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        Text(label, fontWeight = FontWeight.Medium)
        if (options.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { options.forEach { option ->
                val selected = option.label in answers
                FilterChip(selected, { update(if (type == "array") { if (selected) answers - option.label else (answers + option.label).distinct() } else listOf(option.label)) }, { Text(option.description ?: option.label) })
            } }
            if (type == "array") Text(listOfNotNull(
                schema?.get("minItems")?.jsonPrimitive?.contentOrNull?.let { strings.getString(R.string.mobile_choose_at_least, it) },
                schema?.get("maxItems")?.jsonPrimitive?.contentOrNull?.let { strings.getString(R.string.mobile_choose_at_most, it) },
                error,
            ).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = if (error == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
            else error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        } else if (type in setOf("string","number","integer")) {
            OutlinedTextField(answers.firstOrNull().orEmpty(), { update(listOf(it)) }, minLines = if (type == "string") 2 else 1, isError = error != null, keyboardOptions = KeyboardOptions(keyboardType = if (type == "number" || type == "integer") KeyboardType.Decimal else KeyboardType.Text), supportingText = { val bounds = listOfNotNull(schema?.get("minimum")?.jsonPrimitive?.contentOrNull?.let { strings.getString(R.string.mobile_min, it) }, schema?.get("maximum")?.jsonPrimitive?.contentOrNull?.let { strings.getString(R.string.mobile_max, it) }).joinToString(" · "); Text(listOfNotNull(bounds.takeIf(String::isNotBlank), error).joinToString(" · ")) }, modifier = Modifier.fillMaxWidth())
        } else Text(stringResource(R.string.mobile_unsupported_field_type, type), color = MaterialTheme.colorScheme.error)
    }
}

private fun approvalParams(value: Approval, choice: String, answers: Map<String, List<String>>, imageDigest: String? = null) = buildJsonObject { put("approvalId", value.id); put("revision", value.revision); put("digest", value.digest); put("choice", choice); put("answers", buildJsonObject { answers.mapValues { (_, values) -> values.filter(String::isNotBlank) }.filterValues(List<String>::isNotEmpty).forEach { (id, values) -> put(id, buildJsonObject { put("answers", buildJsonArray { values.forEach(::add) }) }) } }); imageDigest?.let { put("imageDigest", it) } }

@Composable private fun OutlinedPanel(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun MemoryScreen(repository: PALRepository, state: MobileState, activity: FragmentActivity) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val readable = state.supports("memory.list") || state.supports("memory.retrieve")
    if (!readable) return EmptyState(Icons.Default.Lock, stringResource(R.string.mobile_memory_is_not_granted), stringResource(R.string.mobile_enable_scoped_memory_access_from_desktop_settings))
    // Memory belongs to a conversation's project on its memory server, whichever provider it uses; the
    // desktop refuses a conversation whose memory server is not granted to this phone.
    val scope = rememberCoroutineScope(); val sessions = state.sessions.filter { it.mode != "linked" }
    var sessionId by rememberSaveable { mutableStateOf(sessions.firstOrNull()?.id.orEmpty()) }; var kind by rememberSaveable { mutableStateOf("saved") }
    var filter by rememberSaveable { mutableStateOf("") }; var query by rememberSaveable { mutableStateOf("") }; var offset by rememberSaveable { mutableIntStateOf(0) }
    var result by remember { mutableStateOf<JsonObject?>(null) }; var loading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var adding by rememberSaveable { mutableStateOf(false) }
    var managedRecord by remember { mutableStateOf<JsonObject?>(null) }; var managing by remember { mutableStateOf(false) }; var clearProject by rememberSaveable { mutableStateOf(false) }
    val sessionIds = sessions.map(Session::id)
    fun clearVisibleMemory() { result = null; managedRecord = null; managing = false; clearProject = false; adding = false; error = null; offset = 0 }
    LaunchedEffect(state.cacheEpoch) { clearVisibleMemory(); filter = ""; query = "" }
    LaunchedEffect(sessionIds) { if (sessionId !in sessionIds) { clearVisibleMemory(); filter = ""; query = ""; sessionId = sessionIds.firstOrNull().orEmpty() } }
    LaunchedEffect(sessionId) { result = null; managedRecord = null; managing = false; clearProject = false; adding = false; error = null }
    // A result is shown only for the conversation and view it was asked for, and never after the
    // desktop's memory changed meanwhile (read() refuses it): erased text cannot come back.
    fun list() { if (sessionId.isBlank() || !state.supports("memory.list")) return; val asked = Triple(sessionId, kind, offset); scope.launch { loading = true; error = null; runCatching { repository.read("memory.list", buildJsonObject { put("sessionId", asked.first); put("kind", asked.second); put("offset", asked.third); put("filter", filter.trim()) }).jsonObject }.onSuccess { if (Triple(sessionId, kind, offset) == asked) result = it }.onFailure { error = it.message }; loading = false } }
    fun retrieve() { if (sessionId.isBlank() || query.isBlank() || !state.supports("memory.retrieve")) return; val asked = sessionId; scope.launch { loading = true; error = null; runCatching { repository.read("memory.retrieve", buildJsonObject { put("sessionId", asked); put("query", query.trim()) }).jsonObject }.onSuccess { if (sessionId == asked) result = it }.onFailure { error = it.message }; loading = false } }
    LaunchedEffect(sessionId, kind, offset, state.cacheEpoch) { if (sessionId.isNotBlank() && state.supports("memory.list")) list() }
    // F77: memory health without endpoints or error text; degraded memory never blocks chat.
    var health by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(sessionId, state.cacheEpoch) { health = if (sessionId.isNotBlank() && state.supports("memory.health")) runCatching { repository.read("memory.health", buildJsonObject { put("sessionId", sessionId) }).jsonObject }.getOrNull() else null }
    val rows = result?.get("rows")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }; val total = result?.get("total")?.jsonPrimitive?.intOrNull ?: rows.size
    LazyColumn(contentPadding = PaddingValues(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
        item { PageTitle(stringResource(R.string.mobile_project_memory)); Text(stringResource(R.string.mobile_review_memory_within_the_selected_conversations_approved_project), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        health?.let { value -> item { MemoryHealthLine(value) } }
        if (sessions.isEmpty()) item { OutlinedPanel(stringResource(R.string.mobile_no_conversations)) { Text(stringResource(R.string.mobile_create_or_open_a_conversation_in_an_approved), color = MaterialTheme.colorScheme.onSurfaceVariant) } }
        else item { Text(stringResource(R.string.mobile_session), fontWeight = FontWeight.Medium); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { sessions.forEach { session -> val project = state.projects.firstOrNull { it.id == session.projectId }; FilterChip(sessionId == session.id, { sessionId = session.id; offset = 0 }, { Column { Text(session.title); Text(project?.name ?: session.project.orEmpty(), style = MaterialTheme.typography.labelSmall) } }) } }; sessions.firstOrNull { it.id == sessionId }?.let { session -> val project = state.projects.firstOrNull { it.id == session.projectId }; OutlinedPanel(project?.name ?: stringResource(R.string.mobile_approved_project)) { SelectionContainer { Text(project?.path ?: session.project ?: stringResource(R.string.desktop_path_unavailable), style = MaterialTheme.typography.bodySmall) }; Text(stringResource(R.string.mobile_ollama, session.ollamaHost.ifBlank { state.settings["ollamaHost"]?.jsonPrimitive?.contentOrNull ?: strings.getString(R.string.mobile_host_unavailable) }), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } }
        if (state.supports("memory.list")) item { Text(stringResource(R.string.mobile_browse), style = MaterialTheme.typography.titleMedium); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { listOf("saved" to strings.getString(R.string.mobile_saved), "conversation" to stringResource(R.string.current_conversation), "assertions" to strings.getString(R.string.mobile_assertions), "episodes" to strings.getString(R.string.mobile_episodes), "entities" to strings.getString(R.string.mobile_entities)).forEach { (id,label) -> FilterChip(kind == id, { kind = id; offset = 0 }, { Text(label) }) } }; Row(verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(filter, { filter = it }, placeholder = { Text(stringResource(R.string.mobile_find_text_in_memory)) }, singleLine = true, modifier = Modifier.weight(1f)); Spacer(Modifier.width(PALLayout.small)); OutlinedButton({ offset = 0; list() }, enabled = !loading) { Text(stringResource(R.string.mobile_find)) } } }
        if (state.supports("memory.retrieve")) item { Text(stringResource(R.string.mobile_recall), style = MaterialTheme.typography.titleMedium); Row(verticalAlignment = Alignment.CenterVertically) { OutlinedTextField(query, { query = it.take(1000) }, placeholder = { Text(stringResource(R.string.mobile_ask_what_pal_remembers)) }, singleLine = true, modifier = Modifier.weight(1f)); Spacer(Modifier.width(PALLayout.small)); OutlinedButton(::retrieve, enabled = query.isNotBlank() && !loading) { Text(stringResource(R.string.mobile_recall)) } } }
        if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        items(rows, key = { it["id"]?.jsonPrimitive?.contentOrNull ?: it.toString() }) { row ->
            MemoryRow(row, if (state.supports("memory.forgetPreview") || state.supports("memory.timeline")) ({ managedRecord = row; managing = true }) else null)
        }
        if (!loading && result != null && rows.isEmpty()) item { Text(stringResource(R.string.mobile_no_matching_memory_records), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        result?.takeIf { "rows" !in it }?.let { value -> item { StructuredObject(value) } }
        if (result?.containsKey("rows") == true) item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) { OutlinedButton({ offset = (offset - 25).coerceAtLeast(0) }, enabled = offset > 0 && !loading) { Text(stringResource(R.string.mobile_previous)) }; Text(stringResource(R.string.mobile_total, total), color = MaterialTheme.colorScheme.onSurfaceVariant); OutlinedButton({ offset += 25 }, enabled = offset + 25 < total && !loading) { Text(stringResource(R.string.mobile_next)) } } }
        if (state.supports("memory.save") && sessions.isNotEmpty()) item { Button({ adding = true }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Default.Add, null); Spacer(Modifier.width(PALLayout.small)); Text(stringResource(R.string.mobile_remember_a_fact)) } }
        // Forgetting is two steps: gone from recall at once, physically removed later. Receipts keep both visible.
        if (state.erasures.isNotEmpty()) item { OutlinedPanel(stringResource(R.string.mobile_forget_receipts)) {
            state.erasures.forEach { receipt -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(receipt.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(when { receipt.purgeComplete -> stringResource(R.string.mobile_hidden_from_recall_physically_removed); receipt.checkedAt != null -> stringResource(R.string.mobile_hidden_from_recall_physical_removal, receipt.state?.lowercase() ?: strings.getString(R.string.mobile_in_progress)); else -> stringResource(R.string.mobile_hidden_from_recall_physical_removal_not_checked_yet) },
                        style = MaterialTheme.typography.bodySmall, color = if (receipt.purgeComplete) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!receipt.purgeComplete && state.supports("memory.erasureStatus")) TextButton({ scope.launch { runCatching { repository.checkErasure(receipt.jobId) }.onFailure { error = it.message } } }) { Text(stringResource(R.string.mobile_check)) }
                else TextButton({ scope.launch { repository.dismissErasure(receipt.jobId) } }) { Text(stringResource(R.string.mobile_dismiss)) }
            } }
        } }
        if (state.supports("memory.forgetPreview") && state.supports("memory.clear") && sessions.isNotEmpty()) item { OutlinedButton({ clearProject = true }, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error), modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.mobile_clear_this_projects_memory)) } }
    }
    if (adding) { var text by rememberSaveable { mutableStateOf("") }; var saveError by remember { mutableStateOf<String?>(null) }; AlertDialog(onDismissRequest = { adding = false }, title = { Text(stringResource(R.string.mobile_remember_a_fact)) }, text = { Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) { OutlinedTextField(text, { text = it.take(MEMORY_FACT_LIMIT) }, minLines = 5, label = { Text(stringResource(R.string.mobile_fact)) }, modifier = Modifier.fillMaxWidth()); Text(stringResource(R.string.mobile_characters, text.length, MEMORY_FACT_LIMIT), color = MaterialTheme.colorScheme.onSurfaceVariant); saveError?.let { Text(it, color = MaterialTheme.colorScheme.error) } } }, confirmButton = { Button({ scope.launch { runCatching { val action = repository.prepareAction("memory.save", buildJsonObject { put("sessionId", sessionId); put("text", text.trim()) }); authenticate(activity, strings.getString(R.string.mobile_save_this_memory), action, repository, { adding = false; offset = 0; list() }, { saveError = it }) }.onFailure { saveError = it.message } } }, enabled = text.isNotBlank()) { Text(stringResource(R.string.mobile_review_save)) } }, dismissButton = { TextButton({ adding = false }) { Text(stringResource(R.string.action_cancel)) } }) }
    if (managing) managedRecord?.let { record -> MemoryRecordSheet(repository, state, activity, sessionId, record, { managing = false; managedRecord = null }, { list() }, kind, rows) }
    if (clearProject) MemoryRecordSheet(repository, state, activity, sessionId, null, { clearProject = false }, { list() })
}

@Composable
private fun SettingsScreen(
    repository: PALRepository, state: MobileState, activity: FragmentActivity, group: SettingsGroup?,
    ownerInitialSection: String?, ownerInitialSession: String?, oauthTargetId: String?, oauthResult: String?,
    onOAuthStarted: (String) -> Unit, selectGroup: (SettingsGroup?) -> Unit,
) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val context = LocalContext.current; val scope = rememberCoroutineScope(); var confirmForget by rememberSaveable { mutableStateOf(false) }; var showMemory by rememberSaveable { mutableStateOf(false) }; var replacePairing by rememberSaveable { mutableStateOf(false) }
    var remoteSettings by remember { mutableStateOf(state.settings) }; var personality by rememberSaveable { mutableStateOf("") }; var defaultModel by rememberSaveable { mutableStateOf("") }; var searchProvider by rememberSaveable { mutableStateOf("auto") }; var settingsDirty by rememberSaveable { mutableStateOf(false) }; var settingsConflict by rememberSaveable { mutableStateOf(false) }; var baselineRevision by rememberSaveable { mutableStateOf("0") }; var loading by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var feedback by remember { mutableStateOf<String?>(null) }
    var alertsOn by remember { mutableStateOf(PALNotifications.requestAlertsEnabled(context)) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) alertsOn = PALNotifications.requestAlertsEnabled(context) }
        lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
    }
    val permissions = state.permissions; val paused = permissions["paused"]?.jsonPrimitive?.booleanOrNull == true; val categories = permissions["categories"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }; val caps = permissions["caps"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
    fun applySettings(value: JsonObject) { remoteSettings = value; personality = value["personality"]?.jsonPrimitive?.contentOrNull.orEmpty(); defaultModel = value["defaultModel"]?.jsonPrimitive?.contentOrNull.orEmpty(); searchProvider = value["webSearch"]?.jsonObject?.get("provider")?.jsonPrimitive?.contentOrNull ?: "auto"; baselineRevision = value["revision"]?.jsonPrimitive?.contentOrNull ?: "0"; settingsDirty = false; settingsConflict = false }
    fun receiveSettings(value: JsonObject) { val revision = value["revision"]?.jsonPrimitive?.contentOrNull ?: "0"; if (settingsDirty && revision != baselineRevision) { remoteSettings = value; settingsConflict = true } else if (!settingsDirty) applySettings(value) }
    LaunchedEffect(state.settings, state.connection is ConnectionState.Online, group == SettingsGroup.Assistant) { if (group == SettingsGroup.Assistant && state.supports("settings.get")) { loading = true; runCatching { repository.read("settings.get", buildJsonObject {}).jsonObject }.onSuccess(::receiveSettings).onFailure { error = it.message }; loading = false } else receiveSettings(state.settings) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        alertsOn = PALNotifications.requestAlertsEnabled(context)
        if (!granted && Build.VERSION.SDK_INT >= 33 && !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) feedback = strings.getString(R.string.mobile_android_didnt_ask_again_turn_on_notifications_for)
    }
    val localNetworkPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) startMonitoring(context) else error = strings.getString(R.string.mobile_local_network_permission_is_required_to_monitor_the) }
    fun requestAlerts() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else openNotificationSettings(context)
    }
    val settingsPages = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    BackHandler(enabled = showMemory) { showMemory = false }
    if (replacePairing) {
        val desktop = state.desktop
        if (desktop != null) PairingScreen(repository, state, activity, desktop) { replacePairing = false }
        return
    }
    if (showMemory) { Column(Modifier.fillMaxSize()) { Row(Modifier.padding(horizontal = PALLayout.small), verticalAlignment = Alignment.CenterVertically) { IconButton({ showMemory = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.mobile_back_to_settings)) }; Text(stringResource(R.string.nav_settings), style = MaterialTheme.typography.titleMedium) }; MemoryScreen(repository, state, activity) }; return }
    if (group == null) {
        settingsPages.SaveableStateProvider("index") { SettingsIndex(state, selectGroup) }
        return
    }
    settingsPages.SaveableStateProvider(group.name) {
        val groupState = rememberLazyListState()
        Box(Modifier.fillMaxSize()) {
          LazyColumn(state = groupState, contentPadding = PaddingValues(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
            item {
                TextButton({ selectGroup(null) }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, null)
                    Text(stringResource(R.string.nav_settings))
                }
                PageTitle(stringResource(group.title))
            }
            if (loading && group == SettingsGroup.Assistant) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (group != SettingsGroup.Owner) feedback?.let { item { SecureStatusPanel(stringResource(R.string.mobile_updated), it, tone = SecureTone.Success) } }
            if (group != SettingsGroup.Owner) error?.let { item { SecureStatusPanel(stringResource(R.string.mobile_couldnt_finish), it, tone = SecureTone.Danger) } }
            if (group in setOf(SettingsGroup.Access, SettingsGroup.Assistant) && state.connection !is ConnectionState.Online)
                item { ConnectionRecovery(state, repository::retry) }
            when (group) {
                SettingsGroup.Access -> {
                    item { OutlinedPanel(if (paused) stringResource(R.string.mobile_actions_paused) else stringResource(R.string.mobile_access, permissions["profile"]?.jsonPrimitive?.contentOrNull ?: stringResource(R.string.scoped_access))) { Text(if (paused) stringResource(R.string.mobile_the_desktop_is_currently_blocking_remote_actions) else stringResource(R.string.mobile_this_phone_can_use_only_the_capabilities_negotiated), color = if (paused) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant); if (categories.isNotEmpty()) Text(stringResource(R.string.mobile_categories, categories.joinToString()), style = MaterialTheme.typography.bodySmall); if (caps.isNotEmpty()) Text(stringResource(R.string.mobile_capabilities, caps.joinToString()), style = MaterialTheme.typography.bodySmall); if (!paused && state.supports("permissions.pause")) OutlinedButton({ scope.launch { runCatching { repository.mutate("permissions.pause", buildJsonObject {}) }.onSuccess { feedback = strings.getString(R.string.mobile_desktop_actions_paused) }.onFailure { error = it.message } } }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.mobile_pause_desktop_actions)) } } }
                    if (state.supports("permissions.reduce") && state.supports("devices.self")) item {
                        PermissionReductionPanel(repository, state, { feedback = it }, { error = it })
                    }
                }
                SettingsGroup.Owner -> ownerSettings(repository, state, activity, { feedback = it; error = null }, { error = it; feedback = null },
                    initialToolServerId = oauthTargetId, toolServerResult = oauthResult, onOAuthStarted = onOAuthStarted,
                    initialSessionId = ownerInitialSession, initialSection = ownerInitialSection)
                SettingsGroup.Assistant -> {
                    if (state.supports("settings.get")) item { OutlinedPanel(stringResource(R.string.mobile_defaults)) { if (settingsConflict) { Text(stringResource(R.string.mobile_desktop_settings_changed_while_you_were_editing_your), color = MaterialTheme.colorScheme.tertiary); FlowRow { TextButton({ applySettings(remoteSettings) }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_reload_desktop)) }; TextButton({ baselineRevision = remoteSettings["revision"]?.jsonPrimitive?.contentOrNull ?: baselineRevision; settingsConflict = false }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_keep_mine)) } } }; OutlinedTextField(personality, { personality = it.take(8000); settingsDirty = true }, label = { Text(stringResource(R.string.mobile_personality)) }, minLines = 3, modifier = Modifier.fillMaxWidth(), supportingText = { Text(stringResource(R.string.mobile_applies_to_every_conversation_unless_a_project_or)) }); if (!remoteSettings["ollamaHost"]?.jsonPrimitive?.contentOrNull.isNullOrBlank()) OutlinedTextField(defaultModel, { defaultModel = it.take(512); settingsDirty = true }, label = { Text(stringResource(R.string.mobile_default_ollama_model)) }, singleLine = true, modifier = Modifier.fillMaxWidth()); Text(stringResource(R.string.mobile_web_search_provider), style = MaterialTheme.typography.labelLarge); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) { listOf("auto","duckduckgo","brave","mojeek","searxng").forEach { provider -> FilterChip(searchProvider == provider, { searchProvider = provider; settingsDirty = true }, { Text(provider) }, modifier = Modifier.heightIn(min = PALLayout.target)) } }; if (state.supports("settings.patch")) Button({ scope.launch { runCatching { val action = repository.prepareAction("settings.patch", assistantSettingsPatch(remoteSettings, baselineRevision, personality, defaultModel, searchProvider)); authenticate(activity, strings.getString(R.string.mobile_update_assistant_settings), action, repository, { value -> applySettings(value.jsonObject); feedback = strings.getString(R.string.mobile_settings_updated) }, { error = it }) }.onFailure { error = it.message } } }, enabled = !loading && !settingsConflict && settingsDirty, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_review_save)) } else Text(stringResource(R.string.mobile_this_device_has_read_only_settings_access), color = MaterialTheme.colorScheme.onSurfaceVariant) } }
                    if (state.supports("memory.list") || state.supports("memory.retrieve")) item { OutlinedPanel(stringResource(R.string.mobile_project_memory)) { Text(stringResource(R.string.mobile_browse_saved_facts_conversation_passages_assertions_episodes_and), color = MaterialTheme.colorScheme.onSurfaceVariant); OutlinedButton({ showMemory = true }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Icon(Icons.Default.Star, null); Spacer(Modifier.width(PALLayout.small)); Text(stringResource(R.string.mobile_open_memory)) } } }
                }
                SettingsGroup.Phone -> {
                    item { OutlinedPanel(stringResource(R.string.conversation_preferences)) {
                        val portraitShown by UiPreferences.portrait(context).collectAsState()
                        Row(Modifier.toggleable(portraitShown, role = Role.Switch) { UiPreferences.setPortrait(context, it) },
                            verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) { Text(stringResource(R.string.mobile_show_the_assistants_portrait)); Text(stringResource(R.string.mobile_show_the_desktop_portrait_alongside_the_conversation_status), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            Switch(portraitShown, null)
                        }
                        HorizontalDivider()
                        var keyboardSend by remember { mutableStateOf(UiPreferences.sendFromKeyboard(context)) }
                        Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target).toggleable(keyboardSend, role = Role.Switch) {
                            keyboardSend = it
                            UiPreferences.setSendFromKeyboard(context, it)
                        }, verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(R.string.keyboard_send))
                                Text(stringResource(R.string.keyboard_send_detail), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Switch(keyboardSend, null)
                        }
                    } }
                    item { OutlinedPanel(stringResource(R.string.mobile_background_connection)) { ListItem(headlineContent = { Text(stringResource(R.string.mobile_monitor_in_the_background)) }, supportingContent = { Text(stringResource(R.string.mobile_keeps_a_private_notification_and_the_desktop_connection)) }, trailingContent = { Switch(state.monitoring, { enabled -> if (enabled) { if (Build.VERSION.SDK_INT >= 33 && !NotificationManagerCompat.from(context).areNotificationsEnabled()) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS); if (Build.VERSION.SDK_INT >= 37 && ContextCompat.checkSelfPermission(context, "android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) localNetworkPermission.launch("android.permission.ACCESS_LOCAL_NETWORK") else startMonitoring(context) } else context.stopService(Intent(context, MonitoringService::class.java)) }) }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f))) } }
                    item { OutlinedPanel(stringResource(R.string.mobile_request_notifications)) { ListItem(headlineContent = { Text(stringResource(R.string.mobile_request_alerts)) }, supportingContent = { Text(when {
                        !alertsOn -> stringResource(R.string.mobile_off_approval_and_question_requests_arrive_silently_allow)
                        !state.monitoring -> stringResource(R.string.mobile_on_while_background_monitoring_is_on)
                        else -> stringResource(R.string.mobile_on_lock_screen_alerts_hide_request_details)
                    }, color = if (alertsOn) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error) }, trailingContent = { if (!alertsOn) TextButton(::requestAlerts, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_allow)) } }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f)))
                        HorizontalDivider()
                        ListItem(headlineContent = { Text(stringResource(R.string.mobile_notification_settings)) }, supportingContent = { Text(stringResource(R.string.mobile_choose_how_requests_replies_problems_and_timers_alert)) }, modifier = Modifier.clickable { openNotificationSettings(context) }.heightIn(min = PALLayout.primaryHeight), colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f)))
                    } }
                }
                SettingsGroup.Connection -> {
                    item { OutlinedPanel(stringResource(R.string.mobile_desktop_connection)) {
                        val online = state.connection as? ConnectionState.Online
                        if (online != null) Text(stringResource(R.string.mobile_connected_to, online.desktopName), color = MaterialTheme.colorScheme.primary)
                        else ConnectionRecovery(state, repository::retry)
                    } }
                    item { ConnectionDetails(repository, state) }
                    // Actions whose outcome the desktop never confirmed. Nothing here is sent again.
                    if (state.pendingCommands.isNotEmpty()) item { OutlinedPanel(stringResource(R.string.mobile_unconfirmed_desktop_actions)) {
                        Text(stringResource(R.string.mobile_pal_couldnt_confirm_these_with_the_desktop_check), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        state.pendingCommands.forEach { command -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(CommandOutcomes.describe(command), maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(if (command.status == "unknown") stringResource(R.string.mobile_outcome_unknown_check_it_on_the_pc) else stringResource(R.string.mobile_checking_with_the_desktop), style = MaterialTheme.typography.bodySmall, color = if (command.status == "unknown") MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (command.status == "unknown") TextButton({ scope.launch { runCatching { repository.acknowledgeUnknownCommand(command.commandId) }.onFailure { error = it.message } } }, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_checked)) }
                        } }
                    } }

                }
                SettingsGroup.Pairing -> {
                    item { MobileMaintenanceSection() }
                    item { OutlinedPanel(stringResource(R.string.desktop_paired_desktop)) { ListItem(headlineContent = { Text(state.desktop?.desktopName.orEmpty()) }, supportingContent = { Text(stringResource(R.string.mobile_device_pinned_tls_identity, state.desktop?.deviceId.orEmpty().take(8))) }, leadingContent = { Icon(Icons.Default.Home, null) }, colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f))) } }
                    item { OutlinedButton({ replacePairing = true }, enabled = repository.replacementBlocker() == null, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_replace_pairing_from_this_desktop)) } }
                    repository.replacementBlocker()?.let { blocker -> item { Text(blocker, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) } }
                    item { OutlinedButton({ confirmForget = true }, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.mobile_forget_this_desktop)) } }
                }
            }
          }
          if (group == SettingsGroup.Owner) (error ?: feedback)?.let { message ->
              Snackbar(
                  modifier = Modifier.align(Alignment.BottomCenter).padding(PALLayout.gutter),
                  action = { TextButton({ error = null; feedback = null }) { Text(stringResource(R.string.mobile_dismiss)) } },
                  containerColor = if (error != null) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.inverseSurface,
                  contentColor = if (error != null) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.inverseOnSurface,
              ) { Text(message, maxLines = 3, overflow = TextOverflow.Ellipsis) }
          }
        }
    }
    if (confirmForget) AlertDialog(onDismissRequest = { confirmForget = false }, title = { Text(stringResource(R.string.mobile_forget_desktop)) }, text = { Text(stringResource(R.string.mobile_this_removes_the_encrypted_cache_drafts_and_both)) }, confirmButton = { Button({ confirmForget = false; activity.lifecycleScope.launch { repository.forget() } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.mobile_forget)) } }, dismissButton = { TextButton({ confirmForget = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable
private fun PermissionReductionPanel(repository: PALRepository, state: MobileState, onFeedback: (String) -> Unit, onError: (String?) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val scope = rememberCoroutineScope()
    var device by remember { mutableStateOf<JsonObject?>(null) }
    var selectedCaps by remember { mutableStateOf(setOf<String>()) }
    var selectedCategories by remember { mutableStateOf(setOf<String>()) }
    var selectedScripts by remember { mutableStateOf(setOf<String>()) }
    var selectedProjects by remember { mutableStateOf(setOf<String>()) }
    var selectedHosts by remember { mutableStateOf(setOf<String>()) }
    var review by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    val pending = state.pendingCommands.any { it.method == "permissions.reduce" }
    val scopeVersion = device?.get("scopeVersion")?.jsonPrimitive?.contentOrNull
    fun strings(key: String) = device?.get(key)?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
    val caps = strings("caps"); val categories = strings("categories"); val scripts = strings("scriptIds"); val hosts = strings("ollamaHosts")
    val projects = device?.get("projects")?.jsonArray.orEmpty().mapNotNull { it as? JsonObject }
    LaunchedEffect(state.connection is ConnectionState.Online, pending) {
        if (!state.supports("devices.self")) return@LaunchedEffect
        loading = true
        runCatching { repository.read("devices.self", buildJsonObject {}).jsonObject }
            .onSuccess { value ->
                device = value
                selectedCaps = value["caps"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
                selectedCategories = value["categories"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
                selectedScripts = value["scriptIds"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
                selectedProjects = value["projects"]?.jsonArray.orEmpty().mapNotNull { it.jsonObject["id"]?.jsonPrimitive?.contentOrNull }.toSet()
                selectedHosts = value["ollamaHosts"]?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }.toSet()
            }.onFailure { onError(it.message) }
        loading = false
    }
    val removedCaps = caps.filterNot { it in selectedCaps }; val removedCategories = categories.filterNot { it in selectedCategories }
    val removedScripts = scripts.filterNot { it in selectedScripts }; val removedHosts = hosts.filterNot { it in selectedHosts }
    val removedProjects = projects.filter { it["id"]?.jsonPrimitive?.contentOrNull !in selectedProjects }
    val changed = removedCaps.isNotEmpty() || removedCategories.isNotEmpty() || removedScripts.isNotEmpty() || removedProjects.isNotEmpty() || removedHosts.isNotEmpty()
    val removedCount = removedCaps.size + removedCategories.size + removedScripts.size + removedProjects.size + removedHosts.size
    OutlinedPanel(stringResource(R.string.mobile_reduce_this_phones_access)) {
        Text(stringResource(R.string.mobile_turn_off_grants_this_phone_should_no_longer), color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        fun toggle(value: String, values: Set<String>, update: (Set<String>) -> Unit) = update(if (value in values) values - value else values + value)
        if (projects.isNotEmpty()) { Text(stringResource(R.string.mobile_projects), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) { projects.forEach { project -> val id = project["id"]?.jsonPrimitive?.contentOrNull ?: return@forEach; val name = project["name"]?.jsonPrimitive?.contentOrNull ?: project["path"]?.jsonPrimitive?.contentOrNull ?: id; FilterChip(id in selectedProjects, { toggle(id, selectedProjects) { selectedProjects = it } }, { Text(name) }, enabled = !pending, modifier = Modifier.heightIn(min = PALLayout.target)) } } }
        if (categories.isNotEmpty()) { Text(stringResource(R.string.mobile_action_categories), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) { categories.forEach { value -> FilterChip(value in selectedCategories, { toggle(value, selectedCategories) { selectedCategories = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = PALLayout.target)) } } }
        if (caps.isNotEmpty()) { Text(stringResource(R.string.mobile_capabilities_2), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) { caps.forEach { value -> FilterChip(value in selectedCaps, { toggle(value, selectedCaps) { selectedCaps = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = PALLayout.target)) } } }
        if (scripts.isNotEmpty()) { Text(stringResource(R.string.mobile_scripts), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) { scripts.forEach { value -> FilterChip(value in selectedScripts, { toggle(value, selectedScripts) { selectedScripts = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = PALLayout.target)) } } }
        if (hosts.isNotEmpty()) { Text(stringResource(R.string.mobile_ollama_hosts), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold); FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small), verticalArrangement = Arrangement.spacedBy(PALLayout.tight)) { hosts.forEach { value -> FilterChip(value in selectedHosts, { toggle(value, selectedHosts) { selectedHosts = it } }, { Text(value) }, enabled = !pending, modifier = Modifier.heightIn(min = PALLayout.target)) } } }
        if (changed) SecureStatusPanel(androidx.compose.ui.res.pluralStringResource(R.plurals.access_removed, removedCount, removedCount), stringResource(R.string.mobile_review_the_exact_list_before_reconnecting_with_reduced), tone = SecureTone.Attention)
        if (pending) SecureStatusPanel(stringResource(R.string.mobile_reduction_pending), stringResource(R.string.mobile_waiting_for_the_desktop_to_confirm_the_access), tone = SecureTone.Attention)
        Button({ review = true }, enabled = changed && scopeVersion != null && !pending && !loading, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Text(stringResource(R.string.mobile_review_reduced_access)) }
    }
    if (review && scopeVersion != null) AlertDialog(onDismissRequest = { review = false }, title = { Text(stringResource(R.string.mobile_remove_these_grants)) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(stringResource(R.string.mobile_this_only_removes_access_active_remote_work_is))
            removedProjects.forEach { Text(stringResource(R.string.mobile_project, it["name"]?.jsonPrimitive?.contentOrNull ?: it["path"]?.jsonPrimitive?.contentOrNull ?: it["id"]?.jsonPrimitive?.contentOrNull.orEmpty())) }
            removedCategories.forEach { Text(stringResource(R.string.mobile_category, it)) }; removedCaps.forEach { Text(stringResource(R.string.mobile_capability, it)) }
            removedScripts.forEach { Text(stringResource(R.string.mobile_script, it)) }; removedHosts.forEach { Text(stringResource(R.string.mobile_ollama_host, it)) }
        }
    }, confirmButton = { Button({
        review = false
        val params = buildJsonObject {
            put("expectedScopeVersion", scopeVersion)
            put("caps", JsonArray(selectedCaps.sorted().map(::JsonPrimitive)))
            put("categories", JsonArray(selectedCategories.sorted().map(::JsonPrimitive)))
            put("scriptIds", JsonArray(selectedScripts.sorted().map(::JsonPrimitive)))
            put("projectIds", JsonArray(selectedProjects.sorted().map(::JsonPrimitive)))
            put("ollamaHosts", JsonArray(selectedHosts.sorted().map(::JsonPrimitive)))
        }
        scope.launch { runCatching { repository.mutate("permissions.reduce", params) }
            .onSuccess { onFeedback(strings.getString(R.string.mobile_access_reduced_reconnecting_with_the_new_grants)) }
            .onFailure { failure -> if (failure is CommandPendingException) onFeedback(strings.getString(R.string.mobile_access_reduction_is_pending_desktop_reconciliation)) else onError(failure.message) } }
    }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) { Text(stringResource(R.string.mobile_reduce_access_reconnect)) } }, dismissButton = { TextButton({ review = false }) { Text(stringResource(R.string.action_cancel)) } })
}

@Composable private fun MemoryRow(row: JsonObject, manage: (() -> Unit)? = null) { OutlinedPanel(row["text"]?.jsonPrimitive?.contentOrNull ?: row["name"]?.jsonPrimitive?.contentOrNull ?: stringResource(R.string.mobile_memory_record)) { val detail = listOfNotNull(row["kind"]?.jsonPrimitive?.contentOrNull, row["status"]?.jsonPrimitive?.contentOrNull, row["state"]?.jsonPrimitive?.contentOrNull, row["updated"]?.jsonPrimitive?.contentOrNull).joinToString(" · "); if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant); val remaining = JsonObject(row.filterKeys { it !in setOf("id","text","name","kind","status","state","updated","revision") }); if (remaining.isNotEmpty()) StructuredObject(remaining); manage?.let { OutlinedButton(it) { Text(stringResource(R.string.mobile_inspect_or_forget)) } } } }

@Composable internal fun StructuredObject(value: JsonObject) {
    Column(verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        value.forEach { (key, item) ->
            Column {
                Text(key.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer { Text(if (item is JsonPrimitive) item.content else item.toString(), style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}

@Composable internal fun EmptyState(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, detail: String) = EmptyState(androidx.compose.ui.graphics.vector.rememberVectorPainter(icon), title, detail)
@Composable private fun EmptyState(icon: androidx.compose.ui.graphics.painter.Painter, title: String, detail: String) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // A library empty state is itself a lazy-list item and has no upper height constraint.
        val scroll = if (constraints.hasBoundedHeight) Modifier.verticalScroll(rememberScrollState()) else Modifier
        Column(scroll.widthIn(max = PALLayout.noticeWidth).padding(PALLayout.sectionGap), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.secondaryContainer) {
                Icon(icon, null, Modifier.padding(PALLayout.gutter).size(PALLayout.icon), tint = MaterialTheme.colorScheme.onSecondaryContainer)
            }
            Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

@Composable private fun Markdown(value: String) = PALMarkdown(value)

/** "Conversation · agent Scout · delegated from Parent", from the scoped session list and the request's opaque agent reference. */
internal data class RequestOrigin(val conversation: String?, val agent: String?, val parent: String?)

internal fun requestOrigin(state: MobileState, approval: Approval): RequestOrigin {
    val session = state.sessions.firstOrNull { it.id == approval.sessionId }
    val agent = approval.agentId?.let { id -> session?.agents?.firstOrNull { it.id == id } }
    val parent = approval.parentSessionIds.firstNotNullOfOrNull { id -> state.sessions.firstOrNull { it.id == id } }
    return RequestOrigin(session?.title, agent?.name, parent?.title)
}

@Composable
internal fun approvalOrigin(state: MobileState, approval: Approval): String {
    val (title, agent, parent) = requestOrigin(state, approval)
    val session = title ?: stringResource(R.string.missing_conversation)
    return when {
        agent != null && parent != null -> stringResource(R.string.origin_agent_parent, session, agent, parent)
        agent != null -> stringResource(R.string.origin_agent, session, agent)
        parent != null -> stringResource(R.string.origin_parent, session, parent)
        else -> session
    }
}
