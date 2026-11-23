package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import dev.otectus.pal.mobile.data.SessionScrollPosition
import dev.otectus.pal.mobile.protocol.Message
import org.junit.Rule
import org.junit.Test

class ConversationTimelineRegressionTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun idleStatusRefinementDoesNotLeaveCompletionStale() {
        val busy = mutableStateOf(true)
        val status = mutableStateOf("working")
        compose.setContent {
            MaterialTheme {
                ConversationTimeline(listOf(message("answer")), busy.value, status.value) { Text(it.text) }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false

        compose.runOnIdle {
            busy.value = false
            status.value = "idle"
        }
        compose.mainClock.advanceTimeBy(64)
        compose.onNodeWithText("Response complete").assertExists()
        compose.mainClock.advanceTimeBy(1_000)
        compose.runOnIdle { status.value = "interrupted" }
        compose.mainClock.advanceTimeBy(2_100)
        compose.waitForIdle()

        compose.onNodeWithText("Response complete").assertDoesNotExist()
        compose.onNodeWithTag("conversationCompletionAnnouncement").assertDoesNotExist()
    }

    @Test
    fun completionAnnouncementExistsWhileReadingOlderMessages() {
        val busy = mutableStateOf(true)
        val messages = (1..80).map { message("message-$it", "Conversation line $it") }
        compose.setContent {
            MaterialTheme {
                ConversationTimeline(
                    messages = messages,
                    busy = busy.value,
                    status = if (busy.value) "working" else "idle",
                    modifier = Modifier.height(240.dp),
                    sessionId = "session-under-test",
                    restoredPosition = SessionScrollPosition(
                        sessionId = "session-under-test",
                        anchorMessageId = messages.first().id,
                        following = false,
                    ),
                    messageContent = { Text(it.text) },
                )
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false

        compose.runOnIdle { busy.value = false }
        compose.mainClock.advanceTimeBy(64)

        compose.onNodeWithTag("conversationCompletionAnnouncement")
            .assertContentDescriptionEquals("Response complete")
        // The visual footer is still virtualized; the always-composed semantics node carries the change.
        compose.onNodeWithText("Response complete").assertDoesNotExist()
    }

    @Test
    fun followedTimelineKeepsGrowingStatusInsideViewport() {
        val statusText = mutableStateOf("Working")
        val messages = (1..24).map { message("message-$it", "Conversation line $it") }
        compose.setContent {
            MaterialTheme {
                ConversationTimeline(
                    messages = messages,
                    busy = true,
                    status = "waiting",
                    statusText = statusText.value,
                    modifier = Modifier.height(240.dp),
                    messageContent = { Text(it.text) },
                )
            }
        }
        compose.waitForIdle()

        compose.runOnIdle {
            statusText.value = "Input needed\nReview the requested access\nChoose allow or deny\nThe turn is waiting"
        }
        compose.waitForIdle()

        val timelineBottom = compose.onNodeWithTag("conversationTimeline").fetchSemanticsNode().boundsInRoot.bottom
        val statusBottom = compose.onNodeWithTag("conversationStatus").fetchSemanticsNode().boundsInRoot.bottom
        check(statusBottom <= timelineBottom + 1f) {
            "Followed status ends below the viewport: status=$statusBottom timeline=$timelineBottom"
        }
        compose.onNodeWithTag("latestMessages").assertDoesNotExist()
    }

    @Test
    fun observedStoppingStateAnnouncesStopped() {
        val busy = mutableStateOf(true)
        val status = mutableStateOf("working")
        compose.setContent {
            MaterialTheme {
                ConversationTimeline(listOf(message("answer")), busy.value, status.value) { Text(it.text) }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false

        compose.runOnIdle { status.value = "stopping" }
        compose.mainClock.advanceTimeBy(64)
        compose.runOnIdle {
            status.value = "interrupted"
            busy.value = false
        }

        compose.mainClock.advanceTimeBy(64)
        compose.onNodeWithTag("conversationCompletionAnnouncement")
            .assertContentDescriptionEquals("Turn stopped")
    }

    @Test
    fun interruptedReplyWithoutObservedStopHasItsOwnAnnouncement() {
        val busy = mutableStateOf(true)
        compose.setContent {
            MaterialTheme {
                ConversationTimeline(listOf(message("answer")), busy.value,
                    if (busy.value) "working" else "interrupted") { Text(it.text) }
            }
        }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { busy.value = false }
        compose.mainClock.advanceTimeBy(64)
        compose.onNodeWithTag("conversationCompletionAnnouncement")
            .assertContentDescriptionEquals("Response interrupted")
    }

    private fun message(id: String, text: String = "A response") = Message(
        id = id,
        sessionId = "session-under-test",
        role = "assistant",
        kind = "text",
        text = text,
        revision = "1",
        time = id.hashCode().toLong(),
    )
}
