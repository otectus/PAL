package dev.otectus.pal.mobile.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * Device roles (PAL Everywhere): after welcome, a client tells a desktop that supports roles which features it
 * understands. A phone the desktop gave full access acts as the owner only once its client declared
 * `owner.policy.v1`; the desktop answers with the role and the operations that role may call.
 */
object OwnerNegotiation {
    const val FEATURE = "owner.policy.v1"
    const val OWNER = "owner"
    /** What this client implements: owner policy, the remote Workbench, verified transfers, owner settings and terminals. */
    val CLIENT_FEATURES = listOf(FEATURE, "workbench.remote.v1", "artifacts.transfer.v1", "settings.owner.v1", "terminal.v1")
    data class Negotiated(val role: String, val operations: Set<String>, val access: JsonObject?)
    fun parse(result: JsonObject): Negotiated? {
        val operations = runCatching { result["operations"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }?.toSet() }.getOrNull() ?: return null
        val role = result["role"]?.jsonPrimitive?.contentOrNull?.takeIf { it in setOf("owner", "limited", "observer") } ?: return null
        return Negotiated(role, operations, result["access"] as? JsonObject)
    }
}
