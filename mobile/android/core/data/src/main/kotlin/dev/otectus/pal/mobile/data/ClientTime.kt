package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.TimeSnapshot
import java.time.ZoneId
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What this phone adds to the desktop's time awareness: the zone it is set to, sent with a message once the desktop
 * has said it understands it. The phone never sends what time it thinks it is, and nothing here uses its location.
 */
object ClientTime {
    const val FEATURE = "time.context.v1"

    /** The message context for [zone], or null when the desktop could not read it as a zone name. */
    fun context(zone: String?, locale: String? = null): JsonObject? {
        val name = zone?.trim()?.takeIf { it.length in 1..128 && it.matches(Regex("[A-Za-z][A-Za-z0-9_+\\-/]*")) } ?: return null
        return buildJsonObject {
            put("timeZone", name)
            locale?.trim()?.takeIf { it.length in 1..64 }?.let { put("locale", it) }
        }
    }
    /** Read afresh for every message, so a message sent after travelling names the new zone. */
    fun current(): JsonObject? = context(TimeZone.getDefault().id, Locale.getDefault().toLanguageTag())

    /** Zone names a person can choose, without the fixed-offset and legacy spellings. */
    fun choices(available: Set<String> = ZoneId.getAvailableZoneIds()): List<String> =
        listOf("UTC") + available.filter { "/" in it && !it.startsWith("Etc/") && !it.startsWith("SystemV/") && !it.startsWith("posix/") && !it.startsWith("right/") }.sorted()

    /** Every word of [query] must appear, so "new york" and "America/New_York" find the same zone. */
    fun search(query: String, zones: List<String>): List<String> {
        fun plain(value: String) = value.lowercase(Locale.ROOT).replace(Regex("[_/\\s]+"), " ").trim()
        val words = plain(query).split(" ").filter(String::isNotEmpty)
        return zones.filter { zone -> plain(zone).let { text -> words.all(text::contains) } }
    }

    /** Whose zone a reading is shown in. The desktop's clock is the time in every case. */
    enum class ZoneOwner { Conversation, Fixed, Phone, Desktop, Utc, Chosen }

    /** The zone the next message from this phone is told the time in: a conversation's or fixed zone first, then this phone's. */
    fun zoneFor(sample: TimeSnapshot, phoneZone: String = TimeZone.getDefault().id): Pair<ZoneId, ZoneOwner> {
        val told = runCatching { ZoneId.of(sample.timeZone) }.getOrNull()
        val phone = runCatching { ZoneId.of(phoneZone) }.getOrNull()
        return when (sample.zoneSource) {
            "conversation" -> told?.let { it to ZoneOwner.Conversation }
            "fixed-preference" -> told?.let { it to ZoneOwner.Fixed }
            "explicit-query" -> told?.let { it to ZoneOwner.Chosen }
            "utc-fallback" -> phone?.let { it to ZoneOwner.Phone }
            else -> phone?.let { it to ZoneOwner.Phone } ?: told?.let { it to ZoneOwner.Desktop }
        } ?: (ZoneId.of("UTC") to ZoneOwner.Utc)
    }
}

/**
 * A desktop clock reading placed on this phone's interval clock (elapsedRealtime, which counts through deep sleep), so it
 * can be shown between checks without using the phone's own idea of the time. It is a display estimate and it expires.
 */
data class ClockReading(val sample: TimeSnapshot, val receivedAtElapsedMs: Long, val roundTripMs: Long) {
    /** The desktop's time at [elapsedMs], allowing for half of the reply's journey. */
    fun instantAt(elapsedMs: Long): Long = sample.sampledAtMs + roundTripMs.coerceAtLeast(0) / 2 + (elapsedMs - receivedAtElapsedMs)
    /** Only a recent reading from a desktop that is still connected is shown as the current time. */
    fun currentAt(elapsedMs: Long, online: Boolean): Boolean = online && elapsedMs - receivedAtElapsedMs in 0..MAX_AGE_MS
    /** How far this phone's clock is from the desktop's, when the difference is more than the reading can be wrong by. */
    fun differenceAt(elapsedMs: Long, phoneMs: Long): Long? =
        (phoneMs - instantAt(elapsedMs)).takeIf { kotlin.math.abs(it) > NOTICEABLE_MS + roundTripMs.coerceAtLeast(0) }

    companion object {
        const val MAX_AGE_MS = 3 * 60_000L
        const val REFRESH_MS = 60_000L
        private const val NOTICEABLE_MS = 60_000L
    }
}
