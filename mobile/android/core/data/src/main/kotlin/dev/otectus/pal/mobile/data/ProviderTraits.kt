package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.Session
import dev.otectus.pal.mobile.protocol.WireCodec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * W08: what the desktop says a provider supports (its snapshot's providers[id].traits), so controls
 * and explanations come from the broker instead of provider names. An older desktop sends none;
 * [legacy] then reproduces what this app assumed before.
 */
@Serializable
data class ProviderTraits(
    val label: String,
    val kind: String = "cli",
    val modelRequired: Boolean = false,
    /** A typed model ID is accepted (hosted APIs and compatible endpoints). */
    val customModel: Boolean = false,
    val effort: Boolean = false,
    val images: String = "no",
    val tools: String = "native",
    /** Whether PAL's tools can be on for a new conversation: "yes", "no", "per-model", "native"; null from an older desktop. */
    val toolCalling: String? = null,
    val webSearch: Boolean = false,
    val queue: Boolean = false,
    val configure: Boolean = false,
    val billed: Boolean = false,
    val remoteNote: String = "",
    /** Connection variants and typed per-session options come from the broker registry. */
    val variants: List<ProviderVariant> = emptyList(),
    val auth: List<String> = emptyList(),
    val optionsSchema: List<ProviderOptionField> = emptyList(),
    val capabilities: JsonObject = JsonObject(emptyMap()),
    /** What the registry says it does, such as "chat" or "realtime" (live voice); a CLI or Ollama declares none. */
    val operations: List<String> = emptyList(),
) {
    /** PAL runs this conversation and its desktop tools are an opt-in. */
    val palTools: Boolean get() = tools == "cere"

    companion object {
        fun legacy(provider: String) = when (provider) {
            "ollama" -> ProviderTraits("Ollama", kind = "local", modelRequired = true, images = "per-model", tools = "cere", webSearch = true, queue = true, configure = true)
            "codex" -> ProviderTraits("Codex", effort = true, images = "yes", configure = true)
            "claude" -> ProviderTraits("Claude Code", effort = true, images = "yes", configure = true)
            else -> ProviderTraits(provider.replaceFirstChar(Char::uppercase))
        }
    }
}

@Serializable
data class ProviderVariant(val id: String, val label: String = id, val description: String? = null, val auth: List<String> = emptyList())

@Serializable
data class ProviderOptionChoice(val id: String, val label: String = id, val description: String? = null)

@Serializable
data class ProviderOptionField(
    val key: String,
    val label: String = key,
    val description: String? = null,
    val type: String = "string",
    val default: JsonElement? = null,
    val required: Boolean = false,
    val choices: List<ProviderOptionChoice> = emptyList(),
    val min: Double? = null,
    val max: Double? = null,
    val integer: Boolean = false,
    val operations: List<String> = emptyList(),
    val variants: List<String> = emptyList(),
)

data class ProviderConnection(
    val id: String,
    val name: String,
    val revision: Int = 0,
    val variant: String? = null,
    val processing: String? = null,
    val endpoint: String? = null,
    val keySet: Boolean = false,
    val auth: String? = null,
    val deployment: String? = null,
    val apiVersion: String? = null,
    val region: String? = null,
    val underlyingModel: String? = null,
)

fun MobileState.traits(provider: String): ProviderTraits =
    (providers[provider] as? JsonObject)?.get("traits")?.let { runCatching { WireCodec.json.decodeFromJsonElement(ProviderTraits.serializer(), it) }.getOrNull() }
        ?: ProviderTraits.legacy(provider)

/** Only non-secret, currently authorized route summaries are present in a phone snapshot. */
fun MobileState.providerConnections(provider: String): List<ProviderConnection> =
    ((providers[provider] as? JsonObject)?.get("connections") as? JsonArray).orEmpty().mapNotNull { element ->
        val row = element as? JsonObject ?: return@mapNotNull null
        val id = row.text("id") ?: return@mapNotNull null
        ProviderConnection(
            id = id,
            name = row.text("name")?.takeIf(String::isNotBlank) ?: id,
            revision = row.text("revision")?.toIntOrNull() ?: 0,
            variant = row.text("variant"),
            processing = row.text("processing")
                ?: (row["task"] as? JsonObject)?.text("processing"),
            endpoint = (row["endpoint"] as? JsonObject)?.text("baseUrl"),
            keySet = row.text("keySet") == "true",
            auth = row.text("auth"),
            deployment = row.text("deployment"),
            apiVersion = row.text("apiVersion"),
            region = row.text("region"),
            underlyingModel = row.text("underlyingModel"),
        )
    }

/**
 * Whether [provider] runs here without naming an account. It may run only through a named one, and then whatever starts
 * there has to name it. A desktop that does not tell the two apart has only the one without a name.
 */
fun MobileState.runsWithoutAccount(provider: String): Boolean {
    val row = providers[provider] as? JsonObject ?: return false
    return (row.text("defaultRemoteExecution") ?: row.text("remoteExecution")) == "true"
}

/** The account a new conversation starts with: none where its provider runs without one. */
fun MobileState.startingAccount(provider: String): String =
    if (runsWithoutAccount(provider)) "" else providerConnections(provider).firstOrNull()?.id.orEmpty()

/**
 * Whether live voice can start in [session]. The desktop refuses a conversation whose provider does not declare it, and
 * one whose Azure account uses the legacy API, so neither is offered it.
 */
fun MobileState.offersLiveVoice(session: Session): Boolean =
    has(RealtimeAudioFrame.FEATURE) && supports("owner.realtime.start") && !session.model.isNullOrBlank() &&
        "realtime" in traits(session.provider).operations &&
        providerConnections(session.provider).none { it.id == session.connectionId && it.variant == "legacy" }

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
