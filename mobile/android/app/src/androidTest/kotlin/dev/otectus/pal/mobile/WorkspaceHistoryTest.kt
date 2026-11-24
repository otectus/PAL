package dev.otectus.pal.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Workspace history on the phone: it says what is kept and for how long, and erases only what was confirmed. */
class WorkspaceHistoryTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun text(id: Int, vararg args: Any) = compose.activity.getString(id, *args)
    private fun many(id: Int, count: Int) = compose.activity.resources.getQuantityString(id, count, count)
    private fun show(content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Surface { Column(Modifier.padding(PALLayout.gutter).verticalScroll(rememberScrollState())) { content() } } } } }; compose.waitForIdle() }
    private fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject
    private fun capture(name: String) { runCatching { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { shot -> File(compose.activity.getExternalFilesDir(null), "$name.png").outputStream().use { shot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } } } }
    private val kept = json("""{"enabled":true,"days":7,"folders":["/home/me/app","/home/me/site"],"records":3,"items":[
        {"id":"1","project":"/home/me/app","kind":"document","item":"src/main.ts","source":"editor","started":1795000000000,"at":1795000300000,"count":2,"seconds":0,"failed":0},
        {"id":"2","project":"/home/me/app","kind":"command","item":"","source":"fish","started":1795000000000,"at":1795000200000,"count":4,"seconds":340,"failed":1},
        {"id":"3","project":"/home/me/site","kind":"focus","item":"","source":"hyprland","started":1794910000000,"at":1794913600000,"count":0,"seconds":3600,"failed":0}]}""")

    @Test fun workIsListedByDayAndAFolderIsChosen() {
        val chosen = mutableListOf<String?>()
        show { WorkspaceHistoryList(kept, null, { chosen += it }) {} }
        compose.onNodeWithText(many(R.plurals.history_kept, 7)).assertIsDisplayed(); compose.onNodeWithText("src/main.ts").assertIsDisplayed(); compose.onNodeWithText(many(R.plurals.history_saves, 2), substring = true).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.history_commands_in, "app")).assertIsDisplayed(); compose.onNodeWithText(many(R.plurals.history_failed, 1), substring = true).assertIsDisplayed(); compose.onNodeWithText(text(R.string.history_minutes, 5), substring = true).assertIsDisplayed()
        compose.onNodeWithText(text(R.string.history_worked_in, "site")).performScrollTo().assertIsDisplayed(); compose.onNodeWithText(text(R.string.history_minutes, 60), substring = true).assertIsDisplayed(); capture("workspace-history")
        compose.onNode(hasText("site") and hasClickAction()).performScrollTo().performClick(); compose.onNode(hasText("app") and hasClickAction()).performClick(); compose.onNodeWithText(text(R.string.history_every_folder)).performClick()
        assertEquals(listOf("/home/me/site", "/home/me/app", null), chosen)
    }

    @Test fun freeSpaceForModelsIsAWarningOrPlainlyUnknown() {
        show { ModelSpace(json("""{"state":"low","free":2147483648}""")) }; compose.onNodeWithText(text(R.string.extras_space_low, android.text.format.Formatter.formatShortFileSize(compose.activity, 2147483648))).assertIsDisplayed()
        show { ModelSpace(json("""{"state":"ok","free":64424509440}""")) }; compose.onNodeWithText(text(R.string.extras_space_free, android.text.format.Formatter.formatShortFileSize(compose.activity, 64424509440))).assertIsDisplayed()
        show { ModelSpace(json("""{"state":"unknown"}""")) }; compose.onNodeWithText(text(R.string.extras_space_unknown)).assertIsDisplayed()
    }

    @Test fun erasingIsConfirmedAndSaysWhatItErases() {
        var erased = 0
        show { WorkspaceHistoryList(kept, "/home/me/app", {}) { erased++ } }
        assertEquals(0, compose.onAllNodesWithText(text(R.string.history_erase_all)).fetchSemanticsNodes().size)
        compose.onNodeWithText(text(R.string.history_erase_folder)).performScrollTo().performClick(); compose.onNodeWithText(text(R.string.history_erase_body)).assertIsDisplayed(); capture("workspace-history-erase")
        compose.onNodeWithText(text(R.string.action_cancel)).performClick(); compose.waitForIdle(); assertEquals(0, erased)
        compose.onNodeWithText(text(R.string.history_erase_folder)).performClick(); compose.onNodeWithText(text(R.string.history_erase)).performClick(); compose.waitForIdle(); assertEquals(1, erased)
        show { WorkspaceHistoryList(json("""{"enabled":false,"days":7,"folders":[],"records":0,"items":[]}"""), null, {}) { erased++ } }
        compose.onNodeWithText(text(R.string.history_off)).assertIsDisplayed(); compose.onNodeWithText(text(R.string.history_none)).assertIsDisplayed(); assertEquals(0, compose.onAllNodesWithText(text(R.string.history_erase_all)).fetchSemanticsNodes().size)
    }
}
