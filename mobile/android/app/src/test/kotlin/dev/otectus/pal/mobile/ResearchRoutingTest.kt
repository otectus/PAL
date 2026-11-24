package dev.otectus.pal.mobile

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ResearchRoutingTest {
    @Test fun routesAcceptTheCanonicalArrayAndWrappedCompatibilityShape() {
        val route = buildJsonObject { put("provider", "compatible"); put("model", "research-1"); put("connectionId", "connection-a") }
        assertEquals(listOf(route), buildJsonArray { add(route) }.researchRoutes())
        assertEquals(listOf(route), buildJsonObject { put("routes", buildJsonArray { add(route) }) }.researchRoutes())
    }

    @Test fun routeIdentityIncludesProviderModelAndNamedConnection() {
        val first = buildJsonObject { put("provider", "compatible"); put("model", "research-1"); put("connectionId", "connection-a") }
        val second = buildJsonObject { put("provider", "compatible"); put("model", "research-1"); put("connectionId", "connection-b") }
        assertNotEquals(researchRouteKey(first), researchRouteKey(second))
    }

    @Test fun routeDescriptionPrefersTheAuthorizedLabel() {
        val labelled = buildJsonObject { put("provider", "ollama"); put("model", "qwen3"); put("label", "Local research") }
        val fallback = buildJsonObject { put("provider", "ollama"); put("model", "qwen3") }
        assertEquals("Local research", researchRouteDescription(labelled))
        assertEquals("ollama · qwen3", researchRouteDescription(fallback))
    }

    @Test fun anExplicitEmptyModelRequiresAValidManualModelButCliDoesNot() {
        val unlistedApi = buildJsonObject { put("provider", "compatible"); put("model", ""); put("label", "Endpoint · Enter model ID") }
        val cli = buildJsonObject { put("provider", "codex"); put("label", "Codex") }
        assertEquals(true, researchRouteNeedsModel(unlistedApi))
        assertEquals(false, researchRouteNeedsModel(cli))
        assertEquals(true, validResearchModel("  custom-model-1 "))
        assertEquals(false, validResearchModel("bad\nmodel"))
    }
}
