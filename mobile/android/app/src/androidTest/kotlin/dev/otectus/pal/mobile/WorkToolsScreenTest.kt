package dev.otectus.pal.mobile

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.geometry.Offset
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The phone's Work tools and owner forms: what they show, what they send, and what they keep. */
class WorkToolsScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val resources get() = compose.activity.resources
    private fun show(content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Column(Modifier.verticalScroll(rememberScrollState())) { content() } } } }; compose.waitForIdle() }
    private fun dialog(content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { content() } } }; compose.waitForIdle() }
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test fun anEmptyExtractionIsNotPresentedAsADocumentThatSaysNothing() {
        show { Column { ExtractedText(json("""{"status":"empty","warnings":["No text was found on page 1; it is probably scanned."],"units":[]}""")) } }
        compose.onNodeWithText(resources.getString(R.string.tools_read_empty)).assertIsDisplayed()
        compose.onNodeWithText("No text was found on page 1; it is probably scanned.").assertIsDisplayed()
    }
    @Test fun aTableShowsItsShapeProblemsAndMissingValues() {
        show { Column { TableContent(json("""{"rows":3,"columns":[{"name":"total","type":"number","distinct":2,"missing":1}],"problems":["1 row has a different number of fields"],"sample":[["10.5"],[""]]}""")) } }
        compose.onNodeWithText(resources.getString(R.string.tools_table_shape, 3, 1)).assertIsDisplayed()
        compose.onNodeWithText("1 row has a different number of fields").assertIsDisplayed()
        compose.onNodeWithText(resources.getString(R.string.tools_table_missing, 1), substring = true).assertIsDisplayed()
    }
    @Test fun imageDetailsSayWhatIsKnownAndLeaveOutTheRest() {
        show { Column { ImageDetails(json("""{"width":320,"height":200,"format":"png","space":"srgb","alpha":true,"opaquePercent":62.5,"provenance":{"kind":"generation","model":"fixture"}}""")) } }
        compose.onNodeWithText(resources.getString(R.string.tools_detail_size_value, 320, 200)).assertIsDisplayed()
        compose.onNodeWithText(resources.getString(R.string.tools_detail_alpha_percent, "62.5")).assertIsDisplayed()
        compose.onNodeWithText("generation · fixture").assertIsDisplayed()
        compose.onNodeWithText(resources.getString(R.string.tools_detail_frames)).assertDoesNotExist()
    }
    @Test fun aPaintedMaskIsOpaqueOnlyWherePaintedAtTheOriginalsSize() {
        val bytes = renderMask(listOf(Triple(false, .2f, listOf(.1f to .5f, .4f to .5f)), Triple(true, .05f, listOf(.25f to .4f, .25f to .6f))), 200, 100)
        val mask = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        assertEquals(200 to 100, mask.width to mask.height)
        fun alpha(x: Int, y: Int) = mask.getPixel(x, y) ushr 24
        assertEquals(255, alpha(30, 50)); assertEquals(0, alpha(150, 50)); assertEquals("erased", 0, alpha(50, 50)); assertEquals(0, alpha(30, 5))
    }
    @Test fun aMaskCanBeSavedOnlyOnceSomethingIsPainted() {
        var saved: ByteArray? = null
        val image = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.GRAY) }
        dialog { PaintMask(image, 400, 300, false, null, {}) { saved = it } }
        compose.onNodeWithText(resources.getString(R.string.tools_mask_save)).assertIsNotEnabled()
        compose.onNodeWithContentDescription(resources.getString(R.string.tools_mask_canvas)).performTouchInput { swipe(Offset(width * .4f, height * .5f), Offset(width * .6f, height * .5f)) }
        compose.onNodeWithText(resources.getString(R.string.tools_mask_save)).assertIsEnabled().performClick()
        compose.waitForIdle()
        val decoded = BitmapFactory.decodeByteArray(assertBytes(saved), 0, saved!!.size)
        assertEquals(400 to 300, decoded.width to decoded.height)
    }
    private fun assertBytes(value: ByteArray?): ByteArray { assertNotNull(value); return value!! }

    @Test fun aSavedSetupKeepsWhatTheFormDoesNotShow() {
        var saved: JsonObject? = null
        val setup = json("""{"id":"s1","revision":"3","name":"Review","description":"","provider":"ollama","connection":"Workstation","families":{"files":true},"collections":["c1"],"skills":["k"],"style":"mentor"}""")
        dialog { SetupEditor(MobileState(providers = json("""{"ollama":{},"codex":{}}""")), setup, null, {}) { saved = it } }
        compose.onNodeWithText(resources.getString(R.string.extras_setup_model)).performScrollTo().performTextInput("fixture-chat")
        compose.onNodeWithText(resources.getString(R.string.extras_setup_save)).performClick(); compose.waitForIdle()
        val value = checkNotNull(saved)
        assertEquals("s1", value.getValue("id").jsonPrimitive.content); assertEquals("fixture-chat", value.getValue("model").jsonPrimitive.content)
        assertEquals("mentor", value.getValue("style").jsonPrimitive.content); assertTrue(value.containsKey("collections") && value.containsKey("skills"))
        // Its account is kept, and let go of with the provider it belongs to.
        assertEquals("Workstation", value.getValue("connection").jsonPrimitive.content)
        // The desktop's own record fields never go back as settings.
        assertNull(value["revision"]); assertNull(value["builtin"])
    }
    @Test fun aBuiltInSetupIsSavedAsACopy() {
        var saved: JsonObject? = null
        dialog { SetupEditor(MobileState(), json("""{"id":"builtin:x","builtin":true,"name":"Example","families":{}}"""), null, {}) { saved = it } }
        compose.onNodeWithText(resources.getString(R.string.extras_setup_save)).performClick(); compose.waitForIdle()
        assertNull(checkNotNull(saved)["id"]); assertEquals("Example (copy)", saved!!.getValue("name").jsonPrimitive.content)
    }
    @Test fun aProjectIsSavedAtTheRevisionShownAndAnApiProviderNeedsAModel() {
        var saved: JsonObject? = null
        val state = MobileState(providers = json("""{"openai":{"traits":{"label":"OpenAI API","kind":"api"}},"codex":{"traits":{"label":"Codex","kind":"cli"}}}"""))
        dialog { ProjectEditor(state, json("""{"cwd":"/work/desk","name":"Desk","revision":"4","favorite":false,"defaults":{"provider":"codex","model":"","effort":"high","tools":false,"trusted":true,"temporary":false}}"""), null, {}) { saved = it } }
        compose.onNodeWithText("OpenAI API").performScrollTo().performClick()
        compose.onNodeWithText(resources.getString(R.string.extras_project_save)).assertIsNotEnabled()
        compose.onNodeWithText(resources.getString(R.string.extras_project_model)).performScrollTo().performTextReplacement("fixture")
        compose.onNodeWithText(resources.getString(R.string.extras_project_save)).assertIsEnabled().performClick(); compose.waitForIdle()
        val value = checkNotNull(saved); val defaults = value.getValue("defaults").jsonObject
        assertEquals("4", value.getValue("expectedRevision").jsonPrimitive.content); assertEquals("openai", defaults.getValue("provider").jsonPrimitive.content)
        // Reasoning effort belongs to the CLI it was chosen for.
        assertEquals("", defaults.getValue("effort").jsonPrimitive.content)
    }
    @Test fun aSecretIsReplacedOrClearedAndNeverShown() {
        val sent = mutableListOf<String?>()
        show { SecretField("API_KEY", true) { sent += it } }
        compose.onNodeWithText(resources.getString(R.string.extras_secret_set, "API_KEY")).assertIsDisplayed()
        compose.onNodeWithText(resources.getString(R.string.extras_secret_save)).assertIsNotEnabled()
        compose.onNodeWithText(resources.getString(R.string.extras_secret_value, "API_KEY")).performTextInput("value-1")
        // What is drawn and what accessibility reads is masked; the typed value is in neither.
        val field = compose.onNodeWithText(resources.getString(R.string.extras_secret_value, "API_KEY")).fetchSemanticsNode().config
        assertEquals("\u2022".repeat(7), field[SemanticsProperties.EditableText].text)
        compose.onNodeWithText(resources.getString(R.string.extras_secret_save)).performClick()
        compose.onNodeWithText(resources.getString(R.string.extras_secret_clear)).performClick(); compose.waitForIdle()
        assertEquals(listOf("value-1", null), sent)
    }
    @Test fun theShelfListsWhatItHoldsAndOpensAConversation() {
        var opened = ""
        show { ShelfContent(json("""{"artifacts":[{"id":"a","name":"plan.md"}],"collections":[{"name":"Handbook"}],"capsule":{"goal":"Ship","decisions":["Use SQLite"],"constraints":[],"tasks":[{"text":"Write tests"}]},"conversations":[{"id":"c2","title":"Earlier"}],"recipes":[]}"""), {}) { opened = it } }
        compose.onNodeWithText(resources.getString(R.string.tools_shelf_goal, "Ship")).assertExists()
        compose.onNodeWithText(resources.getString(R.string.tools_shelf_decision, "Use SQLite")).assertExists()
        compose.onNodeWithText(resources.getString(R.string.tools_shelf_open)).performScrollTo().performClick(); compose.waitForIdle()
        assertEquals("c2", opened)
        assertFalse(opened.isBlank())
    }
    private val online = ConnectionState.Online("Desktop", emptySet(), 0)
    @Test fun noToolsAreOfferedByADesktopWithoutThem() { assertTrue(artifactTools(MobileState(connection = online), "a.png", "image/png", "image").isEmpty()) }
}
