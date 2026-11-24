package dev.otectus.pal.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.ProviderOptionField
import dev.otectus.pal.mobile.protocol.ModelOption
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** A provider's models as one list, the account a setup or specialist runs on, and options another control changes. */
class ModelChoicesTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val resources get() = compose.activity.resources
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun show(content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Column(Modifier.verticalScroll(rememberScrollState())) { content() } } } }; compose.waitForIdle() }
    private fun count(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().size
    private val models = List(45) { index -> ModelOption("maker/model-$index", "Model $index", "Described", capabilities = if (index % 2 == 0) listOf("local-tools") else listOf("no-local-tools"), detail = if (index == 0) "" else "${index}K context", free = index == 7, expires = if (index == 44) "2027-01-31" else null) }

    @Test fun aLongListIsSearchedNarrowedAndDrawnInParts() {
        var chosen by mutableStateOf("maker/model-44")
        show { ModelChoices(models, chosen, true) { chosen = it.id } }
        // The chosen model is first, with what its provider says about its end; the rest waits to be asked for.
        compose.onNodeWithText("Model 44").performScrollTo().assertIsSelected(); compose.onNodeWithText(resources.getString(R.string.models_ends, "2027-01-31")).assertExists()
        compose.onNodeWithText("Described").assertExists(); assertEquals(0, count("Model 43"))
        compose.onNodeWithText(resources.getQuantityString(R.plurals.models_more, 15, 15)).performScrollTo().performClick(); compose.onNodeWithText("Model 43").assertExists()
        val search = compose.onNode(hasSetTextAction() and hasText(resources.getQuantityString(R.plurals.models_find, 45, 45)))
        search.performScrollTo().performTextInput("model 7"); compose.waitForIdle(); compose.onNodeWithText("Model 7").performScrollTo().performClick(); assertEquals("maker/model-7", chosen)
        search.performScrollTo().performTextClearance(); search.performTextInput("nothing such"); compose.onNodeWithText(resources.getString(R.string.models_none)).assertExists(); search.performTextClearance()
        compose.onNodeWithText(resources.getString(R.string.models_tools)).performScrollTo().performClick(); compose.waitForIdle(); assertEquals(0, count("Model 1")); compose.onNodeWithText("Model 2").assertExists()
        compose.onNodeWithText(resources.getString(R.string.models_free)).performScrollTo().performClick(); compose.onNodeWithText(resources.getString(R.string.models_none)).assertExists()
    }

    @Test fun aShortListIsShownAsItIs() {
        show { ModelChoices(models.take(3), "maker/model-1", true) { } }
        compose.onNodeWithText("Model 1").assertIsSelected(); assertEquals(0, compose.onAllNodesWithText(resources.getQuantityString(R.plurals.models_find, 3, 3)).fetchSemanticsNodes().size); assertEquals(0, count(resources.getString(R.string.models_tools)))
    }

    @Test fun anAccountBelongsToItsProviderAndAMissingOneStaysChosen() {
        val state = MobileState(providers = json("""{"openai":{"connections":[{"id":"1","name":"Work"},{"id":"2","name":"Home"}]},"codex":{}}"""))
        var account by mutableStateOf("Gone"); var provider by mutableStateOf("openai")
        show { AccountChoice(state, provider, account, byName = true) { account = it } }
        compose.onNodeWithText(resources.getString(R.string.extras_account_missing, "Gone")).assertIsSelected()
        compose.onNodeWithText("Home").performClick(); assertEquals("Home", account); compose.onNodeWithText("Home").assertIsSelected(); assertEquals(0, count(resources.getString(R.string.extras_account_missing, "Gone")))
        compose.onNodeWithText(resources.getString(R.string.extras_account_default)).performClick(); assertEquals("", account)
        compose.runOnIdle { provider = "codex" }; compose.waitForIdle(); assertEquals(0, count("Work")); assertEquals(0, count(resources.getString(R.string.extras_account_default)))
    }

    @Test fun anOptionChangedElsewhereIsShownAndWhatIsTypedIsKept() {
        val fields = listOf(ProviderOptionField("preferredProviders", "Preferred upstream providers", type = "string-list"), ProviderOptionField("reasoningEffort", "Reasoning effort"))
        var options by mutableStateOf(JsonObject(emptyMap()))
        show { ProviderOptions(fields, options, hidden = setOf("reasoningEffort")) { options = it } }
        assertEquals(0, count("Reasoning effort"))
        val field = compose.onNode(hasSetTextAction() and hasText("Preferred upstream providers"))
        field.performTextInput("azure, "); compose.waitForIdle(); compose.onNode(hasSetTextAction() and hasText("azure, ", substring = true)).assertExists()
        compose.runOnIdle { options = json("""{"preferredProviders":["azure","anthropic"]}""") }; compose.waitForIdle(); compose.onNode(hasSetTextAction() and hasText("azure, anthropic", substring = true)).assertExists()
        compose.runOnIdle { options = JsonObject(emptyMap()) }; compose.waitForIdle(); assertEquals(0, compose.onAllNodesWithText("azure", substring = true).fetchSemanticsNodes().size)
        // What was saved stays visible even where the screen shows it another way.
        compose.runOnIdle { options = json("""{"reasoningEffort":"high"}""") }; compose.waitForIdle(); assertTrue(count("Reasoning effort") > 0)
    }
}
