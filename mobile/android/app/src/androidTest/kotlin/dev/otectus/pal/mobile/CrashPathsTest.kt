package dev.otectus.pal.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.Approval
import dev.otectus.pal.mobile.protocol.Message
import dev.otectus.pal.mobile.protocol.Project
import dev.otectus.pal.mobile.protocol.Session
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** What once ended the app, or left it covered by a window nobody could see, and now is said or left out. */
class CrashPathsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val repository: PALRepository get() = (compose.activity.application as PALApp).repository
    private fun text(id: Int, vararg args: Any) = compose.activity.getString(id, *args)
    private fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject
    private var shown = 0
    private fun show(content: @Composable () -> Unit) {
        val turn = ++shown
        compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Surface(Modifier.fillMaxSize()) { key(turn) { content() } } } } }
        compose.waitForIdle()
    }
    private val online = ConnectionState.Online("Studio desktop", setOf("messages.bookmarks", "approvals.answer"), Long.MAX_VALUE, role = "owner")

    @Test fun rowsThatShareAKeyAreBothShown() {
        // Two findings that say the same, one event in two calendars, a run listed twice, an approval repeated by a snapshot.
        val findings = json("""{"state":"completed","findings":[{"text":"Not found in the sources"},{"text":"Not found in the sources"},{}, {}],"evidence":[{"title":"One"},{"title":"Two"}]}""")
        show { LazyColumn(Modifier.fillMaxSize()) { researchResultItems(findings, null, null, emptySet(), {}, {}, {}) } }
        assertEquals(2, compose.onAllNodesWithText("Not found in the sources").fetchSemanticsNodes().size)
        show { LazyColumn(Modifier.fillMaxSize()) { researchTaskItems(listOf(json("""{"id":"r","title":"Same task"}"""), json("""{"id":"r","title":"Same task"}"""), json("{}")), { null }, {}) } }
        assertEquals(2, compose.onAllNodesWithText("Same task").fetchSemanticsNodes().size)
        val event = { calendar: String -> json("""{"id":"e","calendarId":"$calendar","title":"Planning","start":{"dateTime":"2026-05-04T10:00"},"end":{"dateTime":"2026-05-04T11:00"}}""") }
        show { AgendaView(true, 0, { _, _ -> listOf(event("mine"), event("team"), event("team")) }, { _, _, _ -> }, {}, LocalDate.parse("2026-05-04"), ZoneId.of("Europe/Berlin")) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("10:00–11:00  Planning").fetchSemanticsNodes().size == 3 }
        val approval = Approval("a", "s", kind = "tool", title = "Read the notes", choices = listOf("allow", "deny"), revision = "1", digest = "d", canAnswer = true)
        show { InboxScreen(repository, MobileState(restoreReady = true, connection = online, approvals = listOf(approval, approval)), compose.activity) }
        compose.onAllNodesWithText("Read the notes")[0].assertIsDisplayed()
        val message = Message("m", "s", role = "user", text = "Once more", revision = "1")
        show { ConversationTimeline(listOf(message, message), false, "idle") { Text(it.text) } }
        assertEquals(2, compose.onAllNodesWithText("Once more").fetchSemanticsNodes().size)
        assertEquals(listOf("a", "b", "a\u00001", "", "\u00001"), uniqueKeys(listOf("a", "b", "a", "", "")))
    }

    @Test fun anEventWithoutATimeOrAnEndIsShownAndEdited() {
        val events = listOf(json("""{"id":"1","title":"Short time","start":{"dateTime":"2026-05-04"},"end":{"dateTime":"2026-05-04T1"}}"""), json("""{"id":"2","title":"No end","allDay":true,"start":{"date":"2026-05-04"},"end":{"date":""},"canEdit":true}"""))
        show { AgendaView(true, 0, { _, _ -> events }, { _, _, _ -> }, {}, LocalDate.parse("2026-05-04"), ZoneId.of("Europe/Berlin")) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Short time", substring = true).fetchSemanticsNodes().isNotEmpty() }
        show { EventEditor(events[1], LocalDate.parse("2026-05-04"), ZoneId.of("Europe/Berlin"), {}, {}) }
        compose.onNodeWithText(text(R.string.account_change_event)).assertIsDisplayed()
        assertEquals("", AccountText.clock(events[0].obj("start"))); assertEquals("1", AccountText.clock(events[0].obj("end")))
    }

    @Test fun anApprovalFormWithATypeThisPhoneDoesNotDrawIsAnsweredOnTheDesktop() {
        val fields = json("""{"many":{"type":["string","null"],"title":"Either"},"shapes":{"type":{"a":1}},"list":{"type":"array","items":{"type":"string","enum":["a",{"b":1}]}},"title":{"type":"string","title":{"x":1}},"enum":{"type":"string","enum":{"a":1}},"range":{"type":"number","minimum":{},"maximum":[]},"null":null}""")
        val approval = Approval("a", "s", kind = "question", title = "A form from a tool server", choices = listOf("answer", "cancel"), fields = fields, revision = "1", digest = "d", canAnswer = true)
        show { InboxScreen(repository, MobileState(restoreReady = true, connection = online, approvals = listOf(approval)), compose.activity) }
        compose.onNodeWithText("A form from a tool server").assertIsDisplayed()
        compose.onNode(hasScrollAction()).performScrollToNode(hasText(text(R.string.mobile_continue_on_the_desktop)))
    }

    @Test fun settingsFromAnotherVersionAreReadOrLeftOut() {
        val odd = MobileState(restoreReady = true, connection = online, settings = json("""{"assistantName":{"a":1},"showMemoryCitations":[],"time":"none","webSearch":null,"ollamaHost":["x"]}"""),
            providers = json("""{"codex":null,"ollama":"yes","openrouter":{"remoteExecution":"true","connections":[{"id":{"x":1}},{"id":"c","name":["n"],"endpoint":"e","revision":{}}]},"xai":[]}"""), permissions = json("""{"paused":"no","categories":null,"caps":{"a":1},"profile":[]}"""))
        assertEquals("PAL", odd.assistantName); assertFalse(odd.showMemoryCitations)
        show { SettingsIndex(odd) {} }
        val session = Session("s", "openrouter", "Odd", status = "idle", mode = "managed", canConfigure = true)
        show { ConversationSettingsSheet(repository, odd.copy(sessions = listOf(session)), session, compose.activity) {} }
        compose.onNodeWithText(text(R.string.conversation_settings)).assertIsDisplayed()
        assertEquals(listOf("a"), json("""{"k":["a",null,{"b":1}]}""").strings("k")); assertTrue(json("""{"k":null}""").array("k").isEmpty()); assertNull(json("""{"k":{}}""").real("k"))
    }

    @Test fun aBusySheetStaysUntilItIsDone() {
        var busy by mutableStateOf(true); var dismissed = 0
        show { AncillarySheetScaffold("Working sheet", null, busy, { dismissed++ }) { repeat(3) { Text("Row $it", Modifier.fillMaxWidth().height(72.dp)) } } }
        compose.onNodeWithText("Working sheet").assertIsDisplayed()
        repeat(2) { compose.onNodeWithText("Working sheet").performTouchInput { swipeDown(startY = 0f, endY = 2_400f, durationMillis = 120) }; compose.waitForIdle() }
        // Neither gone nor hidden: hidden without being dismissed, it would lie invisibly over the app.
        assertEquals(0, dismissed); compose.onNodeWithText("Working sheet").assertIsDisplayed()
        compose.runOnIdle { busy = false }; compose.waitForIdle()
        compose.onNodeWithText("Row 1").assertIsDisplayed()
        compose.onNodeWithText(text(R.string.action_close)).performClick(); compose.waitForIdle()
        assertEquals(1, dismissed)
    }

    @Test fun leavingTheAppWithVeryLongTextOnScreenDoesNotEndIt() {
        show { var long by rememberSaveable { mutableStateOf("") }; Column { Text("${long.length}"); androidx.compose.material3.TextButton({ long = "x".repeat(700_000) }) { Text("Fill") } } }
        compose.onNodeWithText("Fill").performClick(); compose.waitForIdle(); compose.onNodeWithText("700000").assertIsDisplayed()
        // Stopping hands the saved state to Android in one transaction, which a state this large does not fit.
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        Thread.sleep(1_500)
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.onNodeWithText("700000").assertIsDisplayed()
        val small = Bundle().apply { putString("a", "b") }; val large = Bundle().apply { putString("a", "x".repeat(700_000)) }
        assertTrue(SavedState.fits(small)); assertFalse(SavedState.fits(large))
    }

    @Test fun whatIsTooLongToCopyOrShareIsSaidAndSharedAsAFile() {
        assertTrue(copyText(compose.activity, "Short", "text"))
        compose.runOnUiThread { assertFalse(copyText(compose.activity, "Long", "x".repeat(3_000_000))) }
        val short = conversationShare(compose.activity, "# Title", "Title.md"); assertEquals("# Title", short.getStringExtra(Intent.EXTRA_TEXT)); assertNull(short.clipData)
        val long = conversationShare(compose.activity, "y".repeat(1_500_000), "../A talk: with / odd? name"); assertNull(long.getStringExtra(Intent.EXTRA_TEXT))
        val file = File(compose.activity.cacheDir, "shared").listFiles()!!.single { it.name.endsWith(".md") && it.length() == 1_500_000L }; assertFalse(file.name.contains('/') || file.name.startsWith("."))
        assertEquals(1, long.clipData!!.itemCount)
        sweepShared(compose.activity, Long.MAX_VALUE); assertTrue(File(compose.activity.cacheDir, "shared").listFiles().isNullOrEmpty())
        assertFalse(compose.activity.open(Intent("dev.otectus.pal.NOTHING_TAKES_THIS")))
        assertNull(decodePicture("data:image/png;base64,***")); assertNull(decodePicture(null)); assertNull(decodePicture("not a picture"))
    }

    @Test fun aFailedListOfPinnedRepliesCanBeAskedForAgain() {
        assumeTrue("A paired phone is answered by its own desktop", runBlocking { withTimeout(10_000) { repository.state.first { it.restoreReady } } }.desktop == null)
        val session = Session("s", "codex", "Pinned", status = "idle", mode = "managed", canSend = true, draftAttachmentCount = 0, projectId = "p")
        val state = MobileState(restoreReady = true, connection = online, sessions = listOf(session), projects = listOf(Project("p", "Project", "/home/me/project")))
        show { ChatScreen(repository, state, session, compose.activity, {}, {}, {}) }
        compose.onNode(androidx.compose.ui.test.hasContentDescription(text(R.string.chat_options))).performClick(); compose.waitForIdle()
        compose.onNodeWithText(text(R.string.pinned_replies)).performClick()
        // This phone is not signed in, so the list fails; asking again clears the failure while its row is on screen.
        val failure = "The desktop isn't connected or doesn't offer this right now."
        compose.waitUntil(5_000) { compose.onAllNodesWithText(failure).fetchSemanticsNodes().isNotEmpty() }
        repeat(5) { compose.onNodeWithText(text(R.string.action_refresh)).performScrollTo().performClick(); compose.waitForIdle() }
        compose.waitUntil(5_000) { compose.onAllNodesWithText(failure).fetchSemanticsNodes().isNotEmpty() }
    }
}
