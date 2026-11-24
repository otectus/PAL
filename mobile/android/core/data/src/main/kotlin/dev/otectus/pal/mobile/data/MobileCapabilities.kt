package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.Session
import kotlinx.serialization.json.*

fun MobileState.canSearchWeb(session: Session): Boolean =
    traits(session.provider).webSearch && supports("sessions.send") &&
        ((settings["webSearch"] as? JsonObject)?.get("enabled") as? JsonPrimitive)?.booleanOrNull == true &&
        (permissions["caps"] as? JsonArray).orEmpty().any { (it as? JsonPrimitive)?.contentOrNull == "web" }

/** Omit settings outside the paired scope so an unrelated edit remains usable. */
fun assistantSettingsPatch(settings: JsonObject, revision: String, personality: String, defaultModel: String, searchProvider: String) = buildJsonObject {
    put("expectedRevision", revision)
    put("personality", personality)
    if (!(settings["ollamaHost"] as? JsonPrimitive)?.contentOrNull.isNullOrBlank()) put("defaultModel", defaultModel)
    put("searchProvider", searchProvider)
}
