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
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.ModelCatalog
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.ModelOption
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

/** The drop-down of a model field: asked for when it is opened, narrowed by typing, and never in the way of an ID of one's own. */
class ModelFieldTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val resources get() = compose.activity.resources
    private fun show(content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Column(Modifier.verticalScroll(rememberScrollState())) { content() } } } }; compose.waitForIdle() }
    private fun count(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().size
    private val field get() = compose.onNode(hasSetTextAction() and hasText("Model"))
    private val models = List(45) { index -> ModelOption("maker/model-$index", "Model $index", detail = "${index}K context", expires = if (index == 7) "2027-01-31" else null) }

    @Test fun theListIsAskedForWhenItIsOpenedAndAChoiceClosesIt() {
        var chosen by mutableStateOf("maker/model-44"); var asked = 0
        val source = ModelSource("one") { asked++; ModelCatalog(models) }
        show { ModelField(chosen, { chosen = it }, "Model", source, none = "Any model") }
        assertEquals("nothing is asked before it is opened", 0, asked)
        field.performClick(); compose.waitForIdle(); assertEquals(1, asked)
        // The model in use is first, and does not narrow the list to itself.
        compose.onNodeWithText("Model 44").assertExists(); compose.onNodeWithText("Model 0").assertExists(); assertEquals(0, count("Model 43"))
        compose.onNodeWithText(resources.getQuantityString(R.plurals.models_more, 15, 15)).performScrollTo().performClick(); compose.onNodeWithText("Model 43").assertExists()
        compose.onNodeWithText("Model 7").performScrollTo().performClick(); compose.waitForIdle()
        assertEquals("maker/model-7", chosen); assertEquals(0, count("Model 0")); field.assertTextContains("maker/model-7")
        compose.onNodeWithText(resources.getString(R.string.models_ends, "2027-01-31")).assertExists()
        // Opened again it is the list it already has; Refresh asks once more.
        field.performClick(); compose.waitForIdle(); assertEquals(1, asked)
        compose.onNodeWithText(resources.getString(R.string.models_refresh)).performScrollTo().performClick(); compose.waitForIdle(); assertEquals(2, asked)
        compose.onNodeWithText("Any model").performScrollTo().performClick(); compose.waitForIdle(); assertEquals("", chosen)
    }

    @Test fun typingNarrowsTheListAndAnIdItLacksIsKept() {
        var chosen by mutableStateOf("")
        show { ModelField(chosen, { chosen = it }, "Model", ModelSource("one") { ModelCatalog(models) }) }
        field.performTextReplacement("model 12"); compose.waitForIdle()
        compose.onNodeWithText("Model 12").assertExists(); assertEquals(0, count("Model 1"))
        field.performTextReplacement("my/own-model"); compose.waitForIdle()
        compose.onNodeWithText(resources.getString(R.string.models_typed)).assertExists(); assertEquals("my/own-model", chosen)
    }

    @Test fun aListThatCannotBeLoadedSaysSoAndLeavesTheFieldTyped() {
        var chosen by mutableStateOf(""); var fails by mutableStateOf(true); val gate = CompletableDeferred<Unit>()
        show { ModelField(chosen, { chosen = it }, "Model", ModelSource("one") { if (fails) throw IllegalStateException("The desktop is asleep"); gate.await(); ModelCatalog(models.take(2), problem = "Only what PAL names") }) }
        field.performClick(); compose.waitForIdle(); compose.onNodeWithText("The desktop is asleep").assertExists()
        field.assertIsEnabled().performTextReplacement("typed"); assertEquals("typed", chosen); field.performTextReplacement(""); compose.waitForIdle()
        fails = false; compose.onNodeWithText(resources.getString(R.string.models_refresh)).performClick(); compose.waitForIdle()
        compose.onNodeWithText(resources.getString(R.string.models_loading)).assertExists(); assertEquals(0, count("The desktop is asleep"))
        gate.complete(Unit); compose.waitUntil(5_000) { count("Model 1") == 1 }; compose.onNodeWithText("Only what PAL names").assertExists()
    }

    @Test fun anotherProvidersListReplacesTheOneBefore() {
        var provider by mutableStateOf("one"); val asked = mutableListOf<String>()
        show { ModelField("", {}, "Model", provider.let { id -> ModelSource(id) { asked += id; ModelCatalog(listOf(ModelOption("$id-model", "Model of $id"))) } }) }
        field.performClick(); compose.waitForIdle(); compose.onNodeWithText("Model of one").assertExists()
        provider = "two"; compose.waitForIdle(); assertEquals(0, count("Model of one"))
        field.performClick(); compose.waitForIdle(); if (asked.size < 2) { field.performClick(); compose.waitForIdle() }
        compose.onNodeWithText("Model of two").assertExists(); assertEquals(listOf("one", "two"), asked)
    }

    @Test fun onlyAListTheDesktopOffersIsAskedFor() {
        val repository: PALRepository = (compose.activity.application as PALApp).repository
        val providers = Json.parseToJsonElement("""{"openai":{},"ollama":{}}""").jsonObject
        fun state(features: Set<String>, operations: Set<String> = setOf("providers.models")) = MobileState(providers = providers, connection = ConnectionState.Online("Desk", operations, Long.MAX_VALUE, features))
        assertNotNull(modelSource(repository, state(emptySet()), "openai")); assertNull(modelSource(repository, state(emptySet(), emptySet()), "openai"))
        assertNull("an older desktop lists models for conversations only", modelSource(repository, state(setOf("models.listing")), "openai", "speech.transcribe"))
        assertNotNull(modelSource(repository, state(setOf("models.listing", "models.uses")), "openai", "speech.transcribe"))
        assertNull(modelSource(repository, state(setOf("models.uses")), "google_cloud", "speech.transcribe")); assertNull(modelSource(null, state(emptySet()), "openai"))
        assertEquals(listOf("openai", "ollama"), modelSource(repository, state(emptySet()), listOf("openai", "ollama", "openai", "unknown"))?.key)
    }
}
