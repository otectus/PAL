package dev.otectus.pal.mobile

import android.Manifest
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.Message
import dev.otectus.pal.mobile.protocol.Project
import dev.otectus.pal.mobile.protocol.Session
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/** Voice lives in its own window, and the conversation shows of it only what is on or went wrong. */
class VoiceSettingsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val repository: PALRepository get() = (compose.activity.application as PALApp).repository
    private fun text(id: Int, vararg args: Any) = compose.activity.getString(id, *args)
    private fun count(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().size
    private fun shows(label: Int) = count(hasText(text(label))) > 0
    private fun toggle(label: Int) = compose.onNode(hasText(text(label)) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
    private var shown = 0
    private fun show(content: @Composable () -> Unit) {
        val turn = ++shown
        compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Surface(Modifier.fillMaxSize()) { key(turn) { content() } } } } }
        compose.waitForIdle()
    }
    private val operations = setOf("owner.voice.status", "owner.voice.transcribe", "owner.realtime.start", "sessions.send")
    private val online = ConnectionState.Online("Studio desktop", operations, Long.MAX_VALUE, setOf("realtime.audio.v1"), role = "owner")
    private val session = Session("s", "openai", "Plans", status = "idle", mode = "managed", model = "gpt-realtime", canSend = true, draftIncluded = true, draftAttachmentCount = 0, projectId = "p")
    private val providers = Json.parseToJsonElement("""{"openai":{"traits":{"label":"OpenAI API","kind":"api","operations":["chat","realtime"]}},"claude":{"traits":{"label":"Claude Code","kind":"cli"}}}""").jsonObject
    private fun state(connection: ConnectionState = online, session: Session = this.session) = MobileState(restoreReady = true, connection = connection, sessions = listOf(session), providers = providers,
        messages = listOf(Message("m", "s", role = "assistant", text = "Here is the plan.", revision = "1")), projects = listOf(Project("p", "Project", "/home/me/project")))
    private fun openMenu() { compose.onNode(hasContentDescription(text(R.string.chat_options))).performClick(); compose.waitForIdle() }
    private fun openVoice() { openMenu(); compose.onNodeWithText(text(R.string.voice_settings)).performClick(); compose.waitForIdle() }
    private fun close() { compose.onNodeWithText(text(R.string.action_close)).performClick(); compose.waitForIdle() }
    private val controls = listOf(R.string.voice_talk, R.string.voice_live, R.string.voice_live_tools, R.string.voice_read_replies)

    @Before fun microphone() { InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(compose.activity.packageName, Manifest.permission.RECORD_AUDIO) }

    @Test fun everyVoiceControlIsInTheWindowAndNoneInTheConversation() {
        show { ChatScreen(repository, state(), session, compose.activity, {}, {}, {}) }
        controls.forEach { assertEquals(text(it), false, shows(it)) }
        compose.onNodeWithTag("voiceStrip").assertDoesNotExist()
        openVoice()
        controls.forEach { compose.onNodeWithText(text(it)).assertIsDisplayed() }
        toggle(R.string.voice_live_tools).performClick(); toggle(R.string.voice_read_replies).performClick(); compose.waitForIdle()
        close()
        controls.forEach { assertEquals(text(it), false, shows(it)) }
        openVoice()
        toggle(R.string.voice_live_tools).assertIsOn(); toggle(R.string.voice_read_replies).assertIsOn()
    }

    @Test fun aDroppedConnectionKeepsTheVoiceSettings() {
        var connection by mutableStateOf<ConnectionState>(online)
        show { ChatScreen(repository, state(connection), session, compose.activity, {}, {}, {}) }
        openVoice(); toggle(R.string.voice_read_replies).performClick(); compose.waitForIdle()
        compose.runOnIdle { connection = ConnectionState.Connecting }; compose.waitForIdle()
        // The window stays; what needs the desktop waits for it and says why.
        compose.onNodeWithText(text(R.string.voice_talk)).assertIsNotEnabled(); assertEquals(false, shows(R.string.voice_live))
        toggle(R.string.voice_read_replies).assertIsOn()
        close()
        openMenu(); assertEquals(false, shows(R.string.voice_settings))
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK); compose.waitForIdle()
        compose.runOnIdle { connection = online }; compose.waitForIdle()
        openVoice(); toggle(R.string.voice_read_replies).assertIsOn(); toggle(R.string.voice_live_tools).assertIsOff()
    }

    @Test fun phonesAndConversationsWithoutVoiceDoNotOfferIt() {
        show { ChatScreen(repository, state(online.copy(role = "limited")), session, compose.activity, {}, {}, {}) }
        openMenu(); assertEquals(false, shows(R.string.voice_settings))
        val linked = session.copy(mode = "linked")
        show { ChatScreen(repository, state(session = linked), linked, compose.activity, {}, {}, {}) }
        openMenu(); assertEquals(false, shows(R.string.voice_settings))
    }

    @Test fun liveVoiceIsLeftOutWhereItCannotStart() {
        var current by mutableStateOf(session.copy(provider = "claude", model = "opus"))
        show { ChatScreen(repository, state(session = current), current, compose.activity, {}, {}, {}) }
        openVoice()
        listOf(R.string.voice_talk, R.string.voice_read_replies).forEach { compose.onNodeWithText(text(it)).assertIsDisplayed() }
        listOf(R.string.voice_live, R.string.voice_live_tools).forEach { assertEquals(text(it), false, shows(it)) }
        // The conversation moves to a provider that has it, and back.
        compose.runOnIdle { current = session }; compose.waitForIdle()
        controls.forEach { compose.onNodeWithText(text(it)).assertIsDisplayed() }
        compose.runOnIdle { current = session.copy(provider = "claude", model = "opus") }; compose.waitForIdle()
        listOf(R.string.voice_live, R.string.voice_live_tools).forEach { assertEquals(text(it), false, shows(it)) }
    }

    @Test fun aNoteIsShownAndEndedWithTheWindowClosed() {
        lateinit var voice: Voice
        var opened = 0
        show { Column { voice = rememberVoice(repository, compose.activity, session, emptyList(), false) {}; Text("Conversation"); VoiceStrip(voice) { opened++ } } }
        compose.onNodeWithTag("voiceStrip").assertDoesNotExist()
        compose.runOnUiThread { voice.talk() }; compose.waitForIdle()
        compose.onNodeWithText(text(R.string.voice_microphone_on)).assertIsDisplayed(); compose.onNodeWithText("0:00").assertIsDisplayed()
        compose.mainClock.autoAdvance = false; Thread.sleep(2_200); compose.mainClock.advanceTimeBy(2_200); compose.mainClock.autoAdvance = true
        compose.waitUntil(5_000) { count(hasText("0:02")) + count(hasText("0:03")) > 0 }
        compose.onNode(hasContentDescription(text(R.string.voice_discard_the_recording))).performClick(); compose.waitForIdle()
        compose.onNodeWithTag("voiceStrip").assertDoesNotExist()
        // Leaving the app ends a recording, and says so on return until it is dismissed.
        compose.runOnUiThread { voice.talk() }; compose.waitForIdle()
        assertEquals(VoiceNote.Recording, voice.note)
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED); compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        assertEquals(VoiceNote.Idle, voice.note)
        compose.onNodeWithText(text(R.string.voice_recording_ended_when_pal_left_the_screen)).assertIsDisplayed()
        compose.onNode(hasContentDescription(text(R.string.conversation_dismiss_error))).performClick(); compose.waitForIdle()
        compose.onNodeWithTag("voiceStrip").assertDoesNotExist(); assertNull(voice.error); assertEquals(0, opened)
    }

    @Test fun leavingTheConversationEndsItsRecording() {
        lateinit var voice: Voice
        var open by mutableStateOf(true)
        show { if (open) voice = rememberVoice(repository, compose.activity, session, emptyList(), false) {} else Text("Conversations") }
        compose.runOnUiThread { voice.talk() }; compose.waitForIdle()
        assertEquals(VoiceNote.Recording, voice.note)
        compose.runOnIdle { open = false }; compose.waitForIdle()
        // A second recording can start at once, so the first one no longer holds the microphone or its file.
        val next = VoiceRecorder(compose.activity)
        compose.runOnUiThread { next.start {}; next.cancel() }
    }
}
