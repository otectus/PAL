package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.TimeSnapshot
import java.time.ZoneId
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientTimeTest {
    private fun sample(source: String, zone: String = "America/New_York", at: Long = 1_000_000_000_000) =
        TimeSnapshot(sampledAtMs = at, timeZone = zone, zoneSource = source)

    @Test fun messageContextCarriesAZoneAndNeverAClock() {
        val context = checkNotNull(ClientTime.context("America/New_York", "en-US"))
        assertEquals(mapOf("timeZone" to JsonPrimitive("America/New_York"), "locale" to JsonPrimitive("en-US")), context.toMap())
        assertEquals(setOf("timeZone"), ClientTime.context("Asia/Kathmandu", " ")?.keys)
        // Shapes the desktop would refuse are not sent at all.
        listOf(null, "", " ", "x".repeat(129), "America/New York\u0000", "5:00", "<zone>").forEach { assertNull(it, ClientTime.context(it, "en")) }
        assertEquals(setOf("timeZone"), ClientTime.context("UTC", "x".repeat(65))?.keys)
        assertTrue(ClientTime.current().orEmpty().keys.all { it == "timeZone" || it == "locale" })
    }

    @Test fun aConversationOrFixedZoneComesBeforeThisPhones() {
        assertEquals(ZoneId.of("Asia/Tokyo") to ClientTime.ZoneOwner.Conversation, ClientTime.zoneFor(sample("conversation", "Asia/Tokyo"), "Europe/Paris"))
        assertEquals(ZoneId.of("Asia/Tokyo") to ClientTime.ZoneOwner.Fixed, ClientTime.zoneFor(sample("fixed-preference", "Asia/Tokyo"), "Europe/Paris"))
        assertEquals(ZoneId.of("Europe/Paris") to ClientTime.ZoneOwner.Phone, ClientTime.zoneFor(sample("broker-system"), "Europe/Paris"))
        assertEquals(ZoneId.of("Europe/Paris") to ClientTime.ZoneOwner.Phone, ClientTime.zoneFor(sample("utc-fallback", "UTC"), "Europe/Paris"))
        // A phone zone this phone cannot use leaves the desktop's, and neither usable leaves UTC, said plainly.
        assertEquals(ZoneId.of("America/New_York") to ClientTime.ZoneOwner.Desktop, ClientTime.zoneFor(sample("broker-system"), "Not/AZone"))
        assertEquals(ZoneId.of("UTC") to ClientTime.ZoneOwner.Utc, ClientTime.zoneFor(sample("broker-system", "Also/Unknown"), "Not/AZone"))
    }

    @Test fun aReadingIsProjectedOnTheIntervalClockAndExpires() {
        val reading = ClockReading(sample("broker-system", at = 5_000_000), receivedAtElapsedMs = 100_000, roundTripMs = 400)
        assertEquals(5_000_200, reading.instantAt(100_000))
        assertEquals(5_060_200, reading.instantAt(160_000))
        assertTrue(reading.currentAt(100_000 + ClockReading.MAX_AGE_MS, online = true))
        assertFalse(reading.currentAt(100_001 + ClockReading.MAX_AGE_MS, online = true))
        assertFalse(reading.currentAt(100_000, online = false))
        // A reboot restarts elapsedRealtime; an anchor from before it is never shown as current.
        assertFalse(reading.currentAt(50, online = true))
        assertEquals(0, ClockReading(sample("broker-system", at = 0), 10, -5).instantAt(10))
    }

    @Test fun aWrongPhoneClockIsReportedAndChangesNothing() {
        val reading = ClockReading(sample("broker-system", at = 5_000_000), receivedAtElapsedMs = 100_000, roundTripMs = 200)
        assertEquals(600_000L, reading.differenceAt(100_000, 5_600_100))
        assertEquals(-600_000L, reading.differenceAt(100_000, 4_400_100))
        assertNull(reading.differenceAt(100_000, 5_059_000))
        assertEquals(5_000_100, reading.instantAt(100_000))
    }

    @Test fun zonesAreFoundByAnyOfTheirWords() {
        val zones = ClientTime.choices(setOf("America/New_York", "Asia/Tokyo", "Etc/GMT+5", "EST", "SystemV/PST8", "America/North_Dakota/Beulah"))
        assertEquals(listOf("UTC", "America/New_York", "America/North_Dakota/Beulah", "Asia/Tokyo"), zones)
        assertEquals(listOf("America/New_York"), ClientTime.search("new york", zones))
        assertEquals(listOf("America/New_York"), ClientTime.search("America/New_York", zones))
        assertEquals(listOf("Asia/Tokyo"), ClientTime.search(" TOKYO  asia ", zones))
        assertEquals(zones, ClientTime.search("", zones))
        assertTrue(ClientTime.search("nowhere", zones).isEmpty())
    }
}
