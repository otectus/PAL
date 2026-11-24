package dev.otectus.pal.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.otectus.pal.mobile.protocol.SessionTask
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** A conversation's task and decisions about remembered things: what is shown, and exactly what a tap asks for. */
class MemoryTaskTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun text(id: Int, vararg args: Any) = compose.activity.getString(id, *args)
    private fun show(content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Surface { Column(Modifier.verticalScroll(rememberScrollState())) { content() } } } } }; compose.waitForIdle() }
    private fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject

    @Test fun aTaskIsChosenAndLeft() {
        val asked = mutableListOf<String?>(); val tasks = listOf(json("""{"id":"t1","text":"Fix the importer"}"""), json("""{"id":"t2","text":"Write the notes"}"""))
        show { TaskChoice(null, tasks, null) { asked += it } }
        compose.onNodeWithText(text(R.string.extras_task_none)).assertIsDisplayed(); assertEquals(0, compose.onAllNodesWithText(text(R.string.extras_task_stop)).fetchSemanticsNodes().size)
        compose.onNodeWithText(text(R.string.extras_task_choose)).performClick(); compose.onNodeWithText("Write the notes").performClick(); compose.waitForIdle()
        assertEquals(listOf<String?>("t2"), asked)
        show { TaskChoice(SessionTask("t2", "Write the notes"), tasks, null) { asked += it } }
        compose.onNodeWithText("Write the notes").assertIsDisplayed(); compose.onNodeWithText(text(R.string.extras_task_stop)).performClick()
        assertEquals(listOf("t2", null), asked)
        show { TaskChoice(null, emptyList(), "The desktop could not read this project’s tasks.") { asked += it } }
        compose.onNodeWithText("The desktop could not read this project’s tasks.").assertIsDisplayed(); assertEquals(0, compose.onAllNodesWithText(text(R.string.extras_task_choose)).fetchSemanticsNodes().size)
    }

    @Test fun aDecisionNamesTheOtherThingAndOnlyOneThatHoldsCanBeUndone() {
        val undone = mutableListOf<String?>()
        val rows = listOf(
            json("""{"id":"d1","revision":3,"decision":"same","reverted":false,"witness":"They are one project","left":{"id":"e1","name":"PAL"},"right":{"id":"e2","name":"pal-desktop"}}"""),
            json("""{"id":"d2","revision":1,"decision":"not_same","reverted":false,"witness":"","left":{"id":"e3","name":"Palette"},"right":{"id":"e1","name":"PAL"}}"""),
            json("""{"id":"d3","revision":2,"decision":"possible","reverted":true,"left":{"id":"e1","name":"PAL"},"right":{"id":"e4","name":"Friend"}}"""),
        )
        show { IdentityRows(rows, "e1", true) { undone += it.str("id") } }
        compose.onNodeWithText(text(R.string.memory_identity_same, "pal-desktop")).assertIsDisplayed(); compose.onNodeWithText("They are one project").assertIsDisplayed()
        compose.onNodeWithText(text(R.string.memory_identity_different, "Palette")).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.memory_identity_undone, text(R.string.memory_identity_possible, "Friend"))).assertIsDisplayed()
        assertEquals(2, compose.onAllNodesWithText(text(R.string.memory_identity_undo)).fetchSemanticsNodes().size)
        compose.onAllNodesWithText(text(R.string.memory_identity_undo))[1].performClick(); assertEquals(listOf<String?>("d2"), undone)
        show { IdentityRows(rows, "e1", false) { undone += it.str("id") } }
        assertEquals(0, compose.onAllNodesWithText(text(R.string.memory_identity_undo)).fetchSemanticsNodes().size)
        show { IdentityRows(emptyList(), "e1", true) {} }
        assertEquals(0, compose.onAllNodesWithText(text(R.string.memory_identity_decisions)).fetchSemanticsNodes().size)
    }
}
