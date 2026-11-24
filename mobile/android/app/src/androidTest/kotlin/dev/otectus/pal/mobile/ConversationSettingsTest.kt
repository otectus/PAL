package dev.otectus.pal.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.ProviderTraits
import dev.otectus.pal.mobile.protocol.Agent
import dev.otectus.pal.mobile.protocol.Project
import dev.otectus.pal.mobile.protocol.Session
import dev.otectus.pal.mobile.protocol.SessionTask
import dev.otectus.pal.mobile.protocol.WireCodec
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/**
 * Conversation settings opens for every kind of conversation and every kind of phone. The sheet is the real one; the
 * desktop behind it is not there, so each section also shows how it fails: with words, never by ending the app.
 */
class ConversationSettingsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val repository: PALRepository get() = (compose.activity.application as PALApp).repository
    private fun text(id: Int, vararg args: Any) = compose.activity.getString(id, *args)
    private fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject
    private var shown = 0
    /** Each time from the start: nothing of the conversation shown before is kept. */
    private fun show(content: @Composable () -> Unit) {
        val turn = ++shown
        compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Surface { key(turn) { content() } } } } }
        compose.waitForIdle()
    }

    /** Every operation and feature this phone knows, so every section is asked to draw itself. */
    private val operations = setOf("sessions.configure", "sessions.rename", "sessions.organize", "sessions.disconnect", "sessions.behavior", "workflows.status",
        "workflows.pauseSchedule", "providers.models", "sessions.create", "owner.folders.list", "owner.sessions.setFolder", "owner.sessions.tasks", "owner.sessions.workOn",
        "owner.results.verify", "owner.connections.modelEndpoints", "workbench.references.pins", "workbench.references.search", "workbench.references.keep", "workbench.references.unkeep")
    private val features = setOf("sessions.toolsState", "sessions.routeRevision", "models.listing")
    private val providers = json("""{
      "codex":{"remoteExecution":true,"traits":{"label":"Codex","kind":"cli","effort":true,"configure":true,"images":"yes"}},
      "claude":{"remoteExecution":true,"traits":{"label":"Claude Code","kind":"cli","effort":true,"configure":true,"images":"yes"}},
      "ollama":{"remoteExecution":true,"traits":{"label":"Ollama","kind":"local","modelRequired":true,"tools":"cere","toolCalling":"per-model","configure":true}},
      "openrouter":{"remoteExecution":true,"connections":[{"id":"c1","name":"Work","variant":"chat","revision":3,"keySet":true}],
        "traits":{"label":"OpenRouter","kind":"api","modelRequired":true,"customModel":true,"tools":"cere","toolCalling":"yes","configure":true,"billed":true,
          "optionsSchema":[{"key":"preferredProviders","label":"Preferred upstream providers","type":"string-list"},
            {"key":"reasoningEffort","label":"Reasoning effort","type":"enum","choices":[{"id":"low"},{"id":"high"}]},
            {"key":"temperature","label":"Temperature","type":"number","min":0,"max":2},{"key":"allowFallbacks","label":"Allow fallbacks","type":"boolean","default":true}]}},
      "xai":{"remoteExecution":true,"connections":[{"id":"x1","name":"Grok"}],"traits":{"label":"Grok (xAI)","kind":"api","modelRequired":true,"customModel":true,"tools":"cere","toolCalling":"yes","configure":true}},
      "compatible":{"remoteExecution":true,"connections":[{"id":"lm","name":"Home server","endpoint":{"baseUrl":"https://lm.example"}}],
        "traits":{"label":"Compatible endpoint","kind":"api","modelRequired":true,"customModel":true,"tools":"cere","toolCalling":"no","configure":true}},
      "antigravity":{"remoteExecution":false,"remoteUnavailableReason":"Runs on the desktop."}
    }""")

    private fun session(provider: String, change: (Session) -> Session = { it }) = change(Session("s-$provider", provider, "A conversation about $provider", projectId = "p", project = "/home/me/project",
        status = "idle", model = "maker/model-1", mode = "managed", canSend = true, canConfigure = true, draftAttachmentCount = 0))
    private fun state(session: Session, role: String, offered: Set<String> = operations) = MobileState(restoreReady = true, sessions = listOf(session), selectedSessionId = session.id,
        connection = ConnectionState.Online("Studio desktop", offered, Long.MAX_VALUE, features, role = role), projects = listOf(Project("p", "Project", "/home/me/project")), providers = providers)
    private fun open(session: Session, state: MobileState) {
        show { ConversationSettingsSheet(repository, state, session, compose.activity) {} }
        compose.onNodeWithText(text(R.string.conversation_settings)).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.conversation_section)).assertIsDisplayed()
    }

    @Test fun aPhoneWithFullAccessOpensItForEveryProvider() {
        for (provider in providers.keys) {
            open(session(provider), state(session(provider), "owner"))
            compose.onNodeWithText(text(R.string.conversation_results_schedules)).performScrollTo().assertIsDisplayed()
        }
    }

    @Test fun aPhoneWithGrantedAccessOpensItForEveryProvider() {
        for (provider in providers.keys) for (role in listOf("limited", "observer")) {
            open(session(provider), state(session(provider), role))
            compose.onNodeWithText(text(R.string.conversation_results_schedules)).performScrollTo().assertIsDisplayed()
        }
    }

    @Test fun itOpensInEveryStateAConversationCanBeIn() {
        val changes = mapOf<String, (Session) -> Session>(
            "task" to { it.copy(task = SessionTask("t", "Fix the importer")) },
            "linked" to { it.copy(mode = "linked", canConfigure = false, canSend = false) },
            "no mode" to { it.copy(mode = null, canConfigure = false) },
            "no model" to { it.copy(model = null, effort = null) },
            "working" to { it.copy(status = "working", agents = listOf(Agent("a", "Scout", status = "working"))) },
            "archived" to { it.copy(archived = true, pinned = true, folderName = "Old", project = null, projectId = null) },
            "error" to { it.copy(status = "error", error = "Stopped", toolsAvailable = false, toolsUnavailableReason = "Not here", canSend = false) },
            "account" to { it.copy(connectionId = "c1", connectionName = "Work", routeRevision = "4", providerOptions = json("""{"preferredProviders":["azure","anthropic"],"temperature":0.4,"unknown":{"nested":[1,null]}}"""), effort = "high", tools = true) },
            "gone account" to { it.copy(connectionId = "gone", connectionName = "Removed") },
            "attachments" to { it.copy(draftAttachmentCount = 3) },
            "older desktop" to { it.copy(draftAttachmentCount = null, revision = "", configRevision = "") },
        )
        for (provider in listOf("codex", "ollama", "openrouter")) for ((name, change) in changes) {
            val session = session(provider, change)
            runCatching { open(session, state(session, "owner")) }.onFailure { throw AssertionError("$provider, $name", it) }
        }
    }

    @Test fun anOlderDesktopOffersLessAndOneThatOffersNothingStillOpens() {
        val session = session("openrouter")
        for (offered in operations) open(session, state(session, "owner", setOf(offered)))
        open(session, state(session, "owner", emptySet()))
        open(session, state(session, "owner").copy(connection = ConnectionState.Offline("Not connected", null)))
    }

    @Test fun aTaskThatCannotBeReadIsSaidAndNothingElseIsLost() {
        assumeTrue("A paired phone is answered by its own desktop", runBlocking { withTimeout(10_000) { repository.state.first { it.restoreReady } } }.desktop == null)
        val session = session("codex") { it.copy(task = SessionTask("t", "Fix the importer")) }
        open(session, state(session, "owner"))
        compose.onNodeWithText("Fix the importer").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText(text(R.string.extras_task_stop)).performScrollTo().assertIsDisplayed()
        // The phone is not signed in to a desktop, so the section shows that instead of its tasks.
        assertTrue(compose.onAllNodesWithText("The desktop isn't connected or doesn't offer this right now.").fetchSemanticsNodes().isNotEmpty())
    }

    @Test fun ownerActionsWorkOutsideThisComputer() {
        // New chat and Conversation settings both list who serves an OpenRouter model; neither is a page of Settings.
        show { Column(Modifier.verticalScroll(rememberScrollState())) { ModelUpstreams(repository, null, "maker/model-1", JsonObject(emptyMap()), true) {} } }
        compose.onNodeWithText(text(R.string.models_served)).assertIsDisplayed()
        var launched = false; var scope: OwnerActionScope? = null
        show { scope = rememberOwnerScope() }
        compose.runOnIdle { scope!!.launch { launched = true } }; compose.waitForIdle()
        assertTrue(launched)
    }

    @Test fun whatAnOlderOrNewerDesktopSendsIsReadOrLeftOut() {
        // Absent, null and wrongly shaped parts of an answer: the work section draws what it understands.
        for (value in listOf("""{}""", """{"results":null,"schedules":null}""", """{"results":{},"schedules":"none"}""", """{"results":[null,7,"x",{}],"schedules":[null,{"label":null,"enabled":"yes","next":"soon"}]}""",
            """{"results":[{"id":"r","providerOutcome":null,"verification":null,"gate":{},"uncertainty":[]}],"schedules":[]}"""))
            show { Column(Modifier.verticalScroll(rememberScrollState())) { ConversationWorkRows(json(value), {}, {}) } }
        show { Column(Modifier.verticalScroll(rememberScrollState())) { ConversationWorkRows(json("""{"results":[{"id":"r","providerOutcome":"completed","verification":"not-checked","gate":"passed","editedSinceCheck":true,"uncertainty":"Two files were skipped"}],
            "schedules":[{"id":"w","revision":"2","label":"Every morning","enabled":true,"next":1790000000000}]}"""), {}, {}) } }
        compose.onNodeWithText("Two files were skipped").assertIsDisplayed(); compose.onNodeWithText("Every morning").performScrollTo().assertIsDisplayed()
    }

    @Test fun aSessionWithNullsIsDecoded() {
        val value = WireCodec.json.decodeFromString(Session.serializer(), """{"id":"s","provider":"codex","title":"T","status":"idle","model":null,"effort":null,"task":null,"mode":"managed","connectionId":null,"error":null,"agents":[]}""")
        open(value, state(value, "owner"))
        assertEquals(ProviderTraits.legacy("codex").label, "Codex"); assertEquals(null, buildJsonObject { put("x", "y") }.obj("x"))
    }
}
