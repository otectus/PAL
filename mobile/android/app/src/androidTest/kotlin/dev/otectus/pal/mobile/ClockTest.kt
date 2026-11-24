package dev.otectus.pal.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import dev.otectus.pal.mobile.data.ClientTime
import dev.otectus.pal.mobile.data.ClockReading
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.OfflineKind
import dev.otectus.pal.mobile.protocol.ElapsedResult
import dev.otectus.pal.mobile.protocol.Session
import dev.otectus.pal.mobile.protocol.TimeSnapshot
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** M12/M14: what the phone's clock shows for a live, old or unavailable desktop reading, and how a zone is chosen. */
class ClockTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val resources get() = compose.activity.resources
    private val at = java.time.Instant.parse("2026-11-21T16:30:00Z").toEpochMilli()
    private val session = Session(id = "s", provider = "ollama", title = "Clock", status = "idle", configRevision = "3")
    private val online = ConnectionState.Online("Desktop", setOf("time.now", "time.elapsed", "sessions.timeZone"), Long.MAX_VALUE, setOf(ClientTime.FEATURE))
    private val settings = buildJsonObject { put("time", buildJsonObject { put("clockFormat", "24h") }) }
    private fun sample(source: String = "broker-system", zone: String = "America/New_York", status: String = "normal") =
        TimeSnapshot(sampledAtMs = at, timeZone = zone, zoneSource = source, clockStatus = status)
    private fun show(reading: ClockReading?, state: MobileState = MobileState(connection = online, settings = settings), session: Session = this.session, tick: Long = 10_000,
        isOnline: Boolean = true, shared: Boolean = true, phoneMs: Long = at, elapsed: Map<String, ElapsedResult> = emptyMap(), choose: (() -> Unit)? = {}) {
        compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
            ClockContent(state, session, reading, elapsed, tick, isOnline, shared, false, choose, {}, phoneMs, ZoneId.of("Asia/Kathmandu"))
        } } } }
        compose.waitForIdle()
    }

    @Test fun aLiveReadingIsTheDesktopsInstantInThisPhonesZone() {
        show(ClockReading(sample(), 10_000, 0))
        compose.onNodeWithText(resources.getString(R.string.clock_source)).assertIsDisplayed()
        // One instant: 11:30 in New York is 22:15 here, and the zone is said to be this phone's.
        compose.onNodeWithText(resources.getString(R.string.clock_zone_phone, "Asia/Kathmandu (UTC+05:45)")).assertExists()
        compose.onNodeWithContentDescription("22:15", substring = true).assertExists()
        assertEquals(0, compose.onAllNodesWithText(resources.getString(R.string.clock_phone, "", "").substringBefore(":"), substring = true).fetchSemanticsNodes().size)
    }
    @Test fun aConversationZoneWinsAndCanBeCleared() {
        show(ClockReading(sample("conversation", "Asia/Tokyo"), 10_000, 0), session = session.copy(timeZone = "Asia/Tokyo"))
        compose.onNodeWithText(resources.getString(R.string.clock_zone_conversation, "Asia/Tokyo (UTC+09:00)")).assertExists()
        compose.onNodeWithContentDescription("01:30", substring = true).assertExists()
        compose.onNodeWithText(resources.getString(R.string.clock_zone_use_default)).performScrollTo().assertIsDisplayed()
    }
    @Test fun anOldOrOfflineReadingIsNeverShownAsNow() {
        show(ClockReading(sample(), 10_000, 0), tick = 10_001 + ClockReading.MAX_AGE_MS)
        compose.onNodeWithText("Last desktop time check", substring = true).assertExists()
        compose.onNodeWithText("This phone’s clock", substring = true).assertExists()
        show(ClockReading(sample(), 10_000, 0), state = MobileState(connection = ConnectionState.Offline("Desktop unreachable", null, OfflineKind.Unreachable), settings = settings), isOnline = false)
        compose.onNodeWithText("Last desktop time check", substring = true).assertExists()
    }
    @Test fun anOlderDesktopLeavesThisPhonesClockLabelledAsSuch() {
        show(null, state = MobileState(connection = online.copy(features = emptySet()), settings = settings), shared = false, choose = null)
        compose.onNodeWithText(resources.getString(R.string.clock_update_desktop)).assertExists()
        compose.onNodeWithText("This phone’s clock", substring = true).assertExists()
        assertEquals(0, compose.onAllNodesWithText(resources.getString(R.string.clock_zone_heading)).fetchSemanticsNodes().size)
    }
    @Test fun aWrongPhoneClockAndAClockJumpAreSaid() {
        show(ClockReading(sample(status = "discontinuity-observed"), 10_000, 0), phoneMs = at + 10 * 60_000)
        compose.onNodeWithText(resources.getString(R.string.clock_jumped)).assertExists()
        compose.onNodeWithText(resources.getString(R.string.clock_phone_ahead, resources.getQuantityString(R.plurals.clock_minutes, 10, 10))).assertExists()
    }
    @Test fun unknownTimesAreNotNumbers() {
        val known = ElapsedResult(status = "available", durationMs = 45 * 60_000)
        show(ClockReading(sample(), 10_000, 0), elapsed = mapOf("session_created" to known, "previous_user_message" to ElapsedResult(status = "unknown", reason = "anchor_unavailable"),
            "previous_assistant_reply" to ElapsedResult(status = "inconsistent", reason = "clock_moved_backward")))
        compose.onNodeWithText(resources.getString(R.string.clock_about_ago, resources.getQuantityString(R.plurals.clock_minutes, 45, 45))).assertExists()
        compose.onNodeWithText(resources.getString(R.string.clock_not_recorded)).assertExists()
        compose.onNodeWithText(resources.getString(R.string.clock_inconsistent)).assertExists()
        assertEquals("2 hours 5 minutes", clockDuration(compose.activity.createConfigurationContext(android.content.res.Configuration(resources.configuration).apply { setLocale(Locale.ENGLISH) }).resources, 125 * 60_000L))
        assertEquals("3 days 1 hour", clockDuration(compose.activity.createConfigurationContext(android.content.res.Configuration(resources.configuration).apply { setLocale(Locale.ENGLISH) }).resources, 73 * 3_600_000L))
    }
    @Test fun aZoneIsFoundAndChosenByName() {
        var chosen by mutableStateOf<String?>(null)
        compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { ZonePickerDialog("Asia/Tokyo", {}, "Europe/Paris") { chosen = it } } } }
        compose.onNodeWithText(resources.getString(R.string.clock_zone_this_phone, "Europe/Paris")).assertIsDisplayed()
        compose.onNodeWithText(resources.getString(R.string.clock_zone_search)).performTextInput("kathmandu")
        compose.onNodeWithText("Asia/Kathmandu").performClick()
        compose.waitForIdle()
        assertEquals("Asia/Kathmandu", chosen)
    }
}
