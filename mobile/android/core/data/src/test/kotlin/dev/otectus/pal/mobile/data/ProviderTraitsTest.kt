package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.Session
import dev.otectus.pal.mobile.protocol.WireCodec
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderTraitsTest {
    @Test fun controlsComeFromTheDesktopsDescriptionWithTheOldAssumptionsAsFallback() {
        val providers = WireCodec.json.parseToJsonElement("""{"openai":{"remoteExecution":true,"connections":[{"id":"work","name":"Work","variant":"standard","keySet":true,"endpoint":{"baseUrl":"https://api.example/v1"}}],"traits":{"label":"OpenAI API","kind":"api","modelRequired":true,"tools":"cere","webSearch":true,"billed":true,"remoteNote":"May be billed","optionsSchema":[{"key":"reasoning","label":"Reasoning","type":"enum","choices":[{"id":"high","label":"High"}]}],"future":1}},"codex":{"remoteExecution":true}}""").jsonObject
        val state = MobileState(providers = providers)
        val api = state.traits("openai")
        assertEquals("OpenAI API", api.label); assertTrue(api.palTools); assertTrue(api.billed); assertTrue(api.webSearch)
        // An older desktop sends no description: the phone keeps what it assumed before.
        val codex = state.traits("codex")
        assertFalse(codex.palTools); assertTrue(codex.effort)
        assertTrue(state.traits("ollama").queue)
        assertEquals("Unknown", state.traits("unknown").label)
        assertEquals("reasoning", api.optionsSchema.single().key)
        assertEquals("Work", state.providerConnections("openai").single().name)
        assertTrue(state.providerConnections("openai").single().keySet)
        // MOB-003/004: typed model IDs and the route's tools rule come from the desktop too; an older one sends neither.
        val described = MobileState(providers = WireCodec.json.parseToJsonElement("""{"compatible":{"traits":{"label":"Workstation","kind":"api","modelRequired":true,"customModel":true,"tools":"cere","toolCalling":"no"}}}""").jsonObject)
        assertTrue(described.traits("compatible").customModel); assertEquals("no", described.traits("compatible").toolCalling)
        assertFalse(api.customModel); assertEquals(null, api.toolCalling)
    }

    @Test fun providerVariantsAndAzureConnectionMetadataUseTheRegistryPacketShape() {
        val providers = WireCodec.json.parseToJsonElement("""{"azure_openai":{"traits":{"label":"Azure OpenAI","kind":"api","variants":[{"id":"v1","label":"v1","auth":["api-key","entra"]}]},"connections":[{"id":"00000000-0000-4000-8000-000000000001","name":"East US","revision":4,"variant":"v1","auth":"entra","deployment":"chat-prod","apiVersion":"2026-01-01","region":"eastus","underlyingModel":"gpt-5.2","keySet":true}]}}""").jsonObject
        val state = MobileState(providers = providers)
        assertEquals(listOf("api-key", "entra"), state.traits("azure_openai").variants.single().auth)
        val connection = state.providerConnections("azure_openai").single()
        assertEquals("entra", connection.auth); assertEquals("chat-prod", connection.deployment)
        assertEquals("eastus", connection.region); assertEquals("gpt-5.2", connection.underlyingModel)
    }

    @Test fun aProviderThatRunsOnlyThroughAnAccountStartsWithOne() {
        val account = """"connections":[{"id":"work","name":"Work"},{"id":"home","name":"Home"}]"""
        val state = MobileState(providers = WireCodec.json.parseToJsonElement("""{
          "both":{"remoteExecution":true,"defaultRemoteExecution":true,$account},
          "named":{"remoteExecution":true,"defaultRemoteExecution":false,$account},
          "neither":{"remoteExecution":false,"defaultRemoteExecution":false},
          "older":{"remoteExecution":true,$account},
          "olderOff":{"remoteExecution":false}}""").jsonObject)
        assertEquals(listOf("both", "older"), state.providers.keys.filter(state::runsWithoutAccount))
        assertEquals(mapOf("both" to "", "named" to "work", "neither" to "", "older" to "", "olderOff" to "", "unknown" to ""),
            (state.providers.keys + "unknown").associateWith(state::startingAccount))
    }

    @Test fun liveVoiceIsOfferedOnlyWhereTheDesktopStartsIt() {
        val online = ConnectionState.Online("Studio", setOf("owner.realtime.start"), Long.MAX_VALUE, setOf(RealtimeAudioFrame.FEATURE))
        val state = MobileState(connection = online, providers = WireCodec.json.parseToJsonElement("""{
          "openai":{"traits":{"label":"OpenAI API","kind":"api","operations":["chat","structured","realtime"]}},
          "azure_openai":{"traits":{"label":"Azure OpenAI","kind":"api","operations":["chat","realtime"]},"connections":[{"id":"east","name":"East","variant":"v1"},{"id":"old","name":"Old","variant":"legacy"}]},
          "anthropic":{"traits":{"label":"Claude API","kind":"api","operations":["chat","structured","search"]}},
          "claude":{"traits":{"label":"Claude Code","kind":"cli"}},"codex":{"remoteExecution":true},"ollama":{"traits":null}}""").jsonObject)
        fun offered(provider: String, model: String? = "model", account: String? = null, from: MobileState = state) =
            from.offersLiveVoice(Session("s", provider, "Plans", status = "idle", model = model, connectionId = account))
        assertEquals(listOf("openai", "azure_openai"), (state.providers.keys + "unknown").filter { offered(it) })
        // Azure's legacy API has none, whatever the provider's other accounts can do.
        assertTrue(offered("azure_openai", account = "east")); assertFalse(offered("azure_openai", account = "old"))
        assertFalse(offered("openai", model = null)); assertFalse(offered("openai", model = " "))
        // A desktop without live voice, a phone it is not granted to, and no connection.
        listOf(online.copy(features = emptySet()), online.copy(operations = emptySet()), ConnectionState.Connecting).forEach { assertFalse(offered("openai", from = state.copy(connection = it))) }
    }
}
