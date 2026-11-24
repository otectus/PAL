package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.ModelOption
import dev.otectus.pal.mobile.protocol.Session
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** MOB-003 and MOB-004: one tools rule for creating and editing, typed model IDs, and edits that keep options. */
class ConversationOptionsTest {
    private val api = ProviderTraits("OpenAI API", kind = "api", modelRequired = true, customModel = true, tools = "cere", toolCalling = "yes")
    private val compatibleOff = api.copy(label = "Workstation", toolCalling = "no")
    private val ollama = ProviderTraits("Ollama", kind = "local", modelRequired = true, tools = "cere", toolCalling = "per-model")
    private val codex = ProviderTraits("Codex", tools = "native", toolCalling = "native")
    private val plain = ModelOption("model")
    private val tooled = ModelOption("tooled", capabilities = listOf("tools"))
    private fun session(provider: String, tools: Boolean, available: Boolean? = null, reason: String? = null, model: String = "model") =
        Session(id = "s", provider = provider, title = "t", status = "idle", model = model, tools = tools, toolsAvailable = available, toolsUnavailableReason = reason, configRevision = "3", routeRevision = if (provider == "compatible") "connection:c:1" else null)

    @Test fun ollamaNeedsAModelThatAdvertisesTools() {
        assertFalse(ToolPolicy.availability(ollama, plain).available); assertTrue(ToolPolicy.availability(ollama, tooled).available)
        assertFalse(ToolPolicy.availability(ollama, null).available)
    }

    @Test fun apiToolsFollowTheRouteNotAnOllamaCapabilityList() {
        // An API catalog states no capabilities; that is not "tools unavailable".
        assertTrue(ToolPolicy.availability(api, plain).available)
        assertTrue(ToolPolicy.availability(api, null).available)
        val declaredOff = ToolPolicy.availability(compatibleOff, plain)
        assertFalse(declaredOff.available); assertEquals(ToolPolicy.NOT_DECLARED, declaredOff.reason)
        // A conversation's own route outranks the provider's default route.
        assertFalse(ToolPolicy.availability(api, plain, session("compatible", false, available = false, reason = "Not declared here"), sessionReports = true).available)
        assertEquals("Not declared here", ToolPolicy.availability(api, plain, session("compatible", false, available = false, reason = "Not declared here"), sessionReports = true).reason)
        assertTrue(ToolPolicy.availability(compatibleOff, plain, session("compatible", true, available = true), sessionReports = true).available)
        // An older desktop says nothing: the switch is offered and the desktop decides.
        assertTrue(ToolPolicy.availability(api.copy(toolCalling = null), plain).available)
        assertFalse(ToolPolicy.availability(codex, plain).applies)
    }

    @Test fun typedModelIdsFollowTheDesktopsRule() {
        assertNull(ModelIds.error("  my-model  ")); assertNull(ModelIds.error("x".repeat(512)))
        assertNotNull(ModelIds.error("")); assertNotNull(ModelIds.error("   ")); assertNotNull(ModelIds.error("x".repeat(513)))
        assertNotNull(ModelIds.error("bad\u0007id")); assertNotNull(ModelIds.error("tab\there"))
    }

    @Test fun aModelOnlyChangeLeavesToolsAndEffortOutWhenTheDesktopKeepsThem() {
        for (tools in listOf(true, false)) {
            val current = session("anthropic", tools, available = true)
            val draft = ConfigurationDraft("another-model", "", tools)
            assertTrue(draft.changes(current))
            val partial = draft.params(current, "3", partial = true, routeRevision = true)
            assertEquals("another-model", partial["model"]!!.jsonPrimitive.content); assertFalse("tools" in partial); assertFalse("effort" in partial)
            assertEquals("3", partial["expectedConfigRevision"]!!.jsonPrimitive.content)
            // An older desktop needs every option: the session's own value is sent, never a default.
            val full = draft.params(current, "3", partial = false, routeRevision = false)
            assertEquals(tools, full["tools"]!!.jsonPrimitive.booleanOrNull)
        }
        val toggled = ConfigurationDraft("model", "", false).params(session("openai", true, available = true), "3", partial = true, routeRevision = false)
        assertEquals(false, toggled["tools"]!!.jsonPrimitive.booleanOrNull)
        val compatible = ConfigurationDraft("typed", "", false).params(session("compatible", false, available = false), "3", partial = true, routeRevision = true)
        assertEquals("connection:c:1", compatible["expectedRouteRevision"]!!.jsonPrimitive.content)
        assertFalse(ConfigurationDraft.of(session("openai", true)).changes(session("openai", true)))
    }

    @Test fun anOlderDesktopCannotSayAnApiConversationsToolsSoTheModelIsNotChangedFromThePhone() {
        assertNotNull(ConfigurationDraft.blockedReason(api, toolsState = false))
        assertNull(ConfigurationDraft.blockedReason(api, toolsState = true))
        assertNull(ConfigurationDraft.blockedReason(ollama, toolsState = false))
    }

    @Test fun changingProviderAccountIsExplicitlyReviewed() {
        val current = session("openai", false).copy(connectionId = "personal")
        val draft = ConfigurationDraft("model", "", false, connectionId = "work")
        val params = draft.params(current, "3", partial = true, routeRevision = true)
        assertEquals("work", params["connectionId"]!!.jsonPrimitive.content)
        assertEquals(true, params["destinationReviewed"]!!.jsonPrimitive.booleanOrNull)
    }

    @Test fun onlyAChosenAccountMovesAConversation() {
        // The desktop moves a conversation to a named account, never back to having none, so nothing chosen changes nothing.
        val named = session("openai", false).copy(connectionId = "personal")
        for (chosen in listOf(null, "", "personal")) {
            val draft = ConfigurationDraft("model", "", false, connectionId = chosen)
            assertFalse(draft.changes(named)); assertFalse("connectionId" in draft.params(named, "3", partial = true, routeRevision = true))
        }
        assertTrue(ConfigurationDraft("model", "", false, connectionId = "work").changes(session("openai", false)))
    }

    @Test fun modelsComeFromTheConversationUntilAnotherAccountIsChosen() {
        val unnamed = session("openai", false); val named = unnamed.copy(connectionId = "personal")
        assertNull(ConfigurationDraft.catalogAccount("", unnamed)); assertNull(ConfigurationDraft.catalogAccount("", named)); assertNull(ConfigurationDraft.catalogAccount("personal", named))
        assertEquals("work", ConfigurationDraft.catalogAccount("work", named)); assertEquals("work", ConfigurationDraft.catalogAccount("work", unnamed))
    }

    @Test fun whatACatalogRulesOutForAModelComesBeforeItsRoute() {
        val without = ModelOption("small", capabilities = listOf("no-local-tools"))
        assertFalse(ToolPolicy.availability(api, without).available); assertNotNull(ToolPolicy.availability(api, without).reason)
        // The open conversation's own model may take tools; the one being chosen decides.
        assertFalse(ToolPolicy.availability(api, without, session("openai", true, available = true), sessionReports = true).available)
        assertTrue(ToolPolicy.availability(api, plain, session("openai", true, available = true), sessionReports = true).available)
    }

    private val catalog = listOf(
        ModelOption("anthropic/claude", "Claude", capabilities = listOf("images", "local-tools", "reasoning")),
        ModelOption("small/plain:free", "Plain", capabilities = listOf("no-local-tools", "no-images"), free = true),
        ModelOption("google/gemini", "Gemini", capabilities = listOf("images", "local-tools", "no-local-tools")),
        ModelOption("ollama-made", "Made here", capabilities = listOf("tools", "vision")),
    )

    @Test fun aLongListIsSearchedByEveryWordAndNarrowedByWhatTellsModelsApart() {
        assertEquals(listOf("tools", "images", "reasoning", "free"), ModelSearch.offered(catalog))
        assertEquals(emptyList<String>(), ModelSearch.offered(listOf(tooled, tooled.copy(id = "other"))))
        fun ids(query: String = "", only: Set<String> = emptySet(), chosen: String = "") = ModelSearch.find(catalog, query, only, chosen).map { it.id }
        assertEquals(listOf("google/gemini"), ids(" GEMINI  google ")); assertEquals(emptyList<String>(), ids("gemini claude"))
        assertEquals(listOf("anthropic/claude", "ollama-made"), ids(only = setOf("tools"))); assertEquals(listOf("anthropic/claude"), ids(only = setOf("tools", "reasoning"))); assertEquals(listOf("small/plain:free"), ids(only = setOf("free")))
        // What is chosen comes first until something narrows the list; nothing is listed twice.
        assertEquals(listOf("ollama-made", "anthropic/claude", "small/plain:free", "google/gemini"), ids(chosen = "ollama-made")); assertEquals(catalog.map { it.id }, ids(chosen = "typed by hand")); assertEquals(listOf("anthropic/claude"), ids("claude", chosen = "ollama-made"))
    }
}
