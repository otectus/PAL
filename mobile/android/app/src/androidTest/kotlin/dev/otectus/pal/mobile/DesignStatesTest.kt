package dev.otectus.pal.mobile

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.OfflineKind
import dev.otectus.pal.mobile.data.PendingCommand
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.Approval
import dev.otectus.pal.mobile.protocol.ApprovalQuestion
import dev.otectus.pal.mobile.protocol.ApprovalOption
import dev.otectus.pal.mobile.protocol.Message
import dev.otectus.pal.mobile.protocol.Session
import java.io.File
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Isolated, opt-in screenshot fixtures. Presentation receives sample models directly. */
class DesignStatesTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun captureStates() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("palCapture") == "true")
        val output = File(compose.activity.getExternalFilesDir(null), "design-states").apply { mkdirs() }
        val repository = (compose.activity.application as PALApp).repository
        var scene by mutableStateOf("connecting")
        var dark by mutableStateOf(false)
        val scenes = listOf("connecting", "reconnecting", "signing-in", "disconnected", "unreachable",
            "repair", "locked", "unreadable", "approval", "empty", "streaming", "long-history", "activity", "activity-failed",
            "monitoring-off", "replacing", "request-link", "request-question", "request-submitting",
            "request-unconfirmed", "request-offline", "markdown", "owner-settings")
        compose.activity.runOnUiThread {
            compose.activity.setContent {
                val config = Configuration(LocalConfiguration.current)
                config.uiMode = config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv() or
                    (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
                CompositionLocalProvider(LocalConfiguration provides config) {
                    PALTheme {
                        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                            Box(Modifier.fillMaxSize().safeDrawingPadding().testTag("design-$scene-$dark")) {
                                key(scene, dark) { RenderScene(scene, repository) }
                            }
                        }
                    }
                }
            }
        }
        for (night in listOf(false, true)) for (name in scenes) {
            compose.runOnIdle {
                dark = night
                scene = name
                val bars = androidx.core.view.WindowCompat.getInsetsController(compose.activity.window, compose.activity.window.decorView)
                bars.isAppearanceLightStatusBars = !night
                bars.isAppearanceLightNavigationBars = !night
            }
            compose.waitForIdle()
            compose.onNodeWithTag("design-$name-$night").assertExists()
            // The window compositor presents after Compose becomes idle. Include modal windows.
            instrumentation.waitForIdleSync()
            android.os.SystemClock.sleep(400)
            val image = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
            File(output, "fixture-${if (night) "dark" else "light"}-$name.png").outputStream().use {
                check(image.compress(Bitmap.CompressFormat.PNG, 100, it))
            }
            image.recycle()
        }
    }

    @Composable private fun RenderScene(scene: String, repository: PALRepository) {
        val online = ConnectionState.Online("Studio desktop", setOf("approvals.answer"), Long.MAX_VALUE)
        val connection = when (scene) {
            "connecting", "reconnecting" -> ConnectionState.Connecting
            "signing-in" -> ConnectionState.Authenticating
            "disconnected" -> ConnectionState.Offline("Not connected", null, OfflineKind.NotConnected)
            "unreachable" -> ConnectionState.Offline("Desktop unreachable", null)
            "monitoring-off" -> ConnectionState.Offline("Monitoring is off", null, OfflineKind.MonitoringOff)
            "replacing" -> ConnectionState.Offline("Updating pairing", null, OfflineKind.PairingChange)
            "request-offline" -> ConnectionState.Offline("Desktop unreachable", null)
            "owner-settings" -> online.copy(role = "owner")
            "locked" -> ConnectionState.Blocked("Unlock your phone to read its encrypted cache.")
            "unreadable" -> ConnectionState.Blocked("This phone cannot open its encrypted cache.", repair = true)
            "repair" -> ConnectionState.Blocked("The desktop identity has changed.", repair = true)
            else -> online
        }
        val session = Session("example", "ollama", "Review the weekly notes", status = if (scene == "streaming") "working" else "idle", model = "Local model")
        val basicRequest = Approval("request", session.id, kind = "tool", title = "Read the project notes",
            detail = "notes/weekly-summary.md", choices = listOf("allow", "deny"), revision = "1", digest = "sample", canAnswer = true)
        val approval = when (scene) {
            "request-link" -> basicRequest.copy(title = "Confirm sign-in with the project service",
                url = "https://example.org/projects/weekly-notes/confirm", detail = null)
            "request-question" -> basicRequest.copy(kind = "question", title = "Choose the notes to review", detail = null,
                choices = listOf("answer", "cancel"), questions = listOf(ApprovalQuestion("scope", "Which notes should PAL read?",
                    options = listOf(ApprovalOption("Weekly summary"), ApprovalOption("Release notes")))))
            else -> basicRequest
        }
        val pending = when (scene) {
            "request-submitting" -> "pending"
            "request-unconfirmed" -> "unknown"
            else -> null
        }
        val state = MobileState(restoreReady = true, connection = connection, sessions = listOf(session),
            approvals = if (scene == "approval" || scene.startsWith("request-")) listOf(approval) else emptyList(),
            pendingCommands = pending?.let { listOf(PendingCommand("example", "approvals.answer", createdAt = 1,
                status = it, approvalId = approval.id, approvalDigest = approval.digest, sessionId = session.id)) }.orEmpty(),
            cursor = "1".takeIf { scene == "reconnecting" })
        when (scene) {
            "locked", "unreadable" -> UnreadableCacheScreen(repository, compose.activity, connection as ConnectionState.Blocked)
            "repair" -> BlockedScreen(repository, state, compose.activity, connection as ConnectionState.Blocked)
            "approval", "request-link", "request-question", "request-submitting", "request-unconfirmed", "request-offline" ->
                InboxScreen(repository, state, compose.activity)
            "monitoring-off", "replacing" -> RecoveryPage(state, repository::retry)
            "owner-settings" -> LazyColumn(contentPadding = PaddingValues(PALLayout.gutter)) {
                ownerSettings(repository, state, compose.activity, feedback = {}, failure = {})
            }
            "markdown" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(PALLayout.gutter)) {
                PALMarkdown(
                    "## Release notes\n\n> The desktop keeps the original conversation.\n\n" +
                    "1. Review the `weekly-summary.md` file.\n2. Copy the project path below.\n\n" +
                    "| Area | Result |\n|---|---|\n| Draft | Restored |\n| Connection | Synced |\n\n" +
                    "```text\nprojects/weekly-notes/archive/review/2026/weekly-summary-approved-for-publication.md\n```\n\n" +
                    "[View the project notes](https://example.org/notes) · ![Diagram](https://example.org/diagram.png)"
                )
            }
            "activity", "activity-failed" -> {
                val tool = Message("tool", session.id, role = "assistant", kind = "tool", text = "Read notes/weekly-summary.md", revision = "1")
                ActivityPanel(listOf(tool), false, if (scene == "activity-failed") "The desktop did not return older activity." else null,
                    onRefresh = {}, onDismiss = {}) { row -> ActivityRow(repository, state, row) }
            }
            "empty", "streaming", "long-history" -> {
                val rows = remember(scene) {
                    if (scene == "empty") emptyList() else buildList {
                        if (scene == "long-history") repeat(150) {
                            add(Message("earlier-$it", session.id, role = "assistant", text = "Project note ${it + 1}", revision = "1"))
                        }
                        add(Message("user", session.id, role = "user", text = "What changed in the project notes?", revision = "1"))
                        add(Message("reply", session.id, role = "assistant", revision = "2",
                            text = "## Weekly notes\n\nThe team reviewed the new reading layout and checked the following items.\n\n- Draft restoration\n- Image previews\n\n```text\nnotes/weekly-summary.md\n```"))
                    }
                }
                Column(Modifier.fillMaxSize()) {
                    ConversationTimeline(rows, scene == "streaming", session.status, Modifier.weight(1f)) { message ->
                        MessageBubble(repository, state, message)
                    }
                    ConversationComposer("", {}, "Message PAL", true, false, {})
                }
            }
            else -> Column {
                CompanionHeader(connection, connectionTitle(state), {}, {})
                SettingsIndex(state) {}
            }
        }
    }

}
