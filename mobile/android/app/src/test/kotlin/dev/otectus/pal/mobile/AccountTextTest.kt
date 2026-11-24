package dev.otectus.pal.mobile

import java.time.LocalDate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class AccountTextTest {
    private fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject
    private val planning = json("""{"id":"a","title":"Planning","allDay":false,"start":{"dateTime":"2026-05-04T10:00:00","timeZone":"Europe/Berlin"},"end":{"dateTime":"2026-05-04T11:00:00","timeZone":"Europe/Berlin"}}""")
    private val night = json("""{"id":"b","title":"Night train","allDay":false,"start":{"dateTime":"2026-05-04T22:00:00","timeZone":"Europe/Berlin"},"end":{"dateTime":"2026-05-05T00:00:00","timeZone":"Europe/Berlin"}}""")
    private val trip = json("""{"id":"c","title":"Trip","allDay":true,"start":{"date":"2026-05-05"},"end":{"date":"2026-05-07"}}""")

    @Test fun eventsAreShownOnTheDaysTheyTouch() {
        val days = AccountText.byDay(listOf(planning, night, trip), LocalDate.parse("2026-05-03"), 7)
        assertEquals(listOf("2026-05-04", "2026-05-05", "2026-05-06"), days.map { it.first.toString() })
        assertEquals(listOf("a", "b"), days[0].second.map { it.str("id") }); assertEquals(listOf("c"), days[1].second.map { it.str("id") })
    }
    @Test fun aTimeNamesAnotherZoneAndADayThatContinues() {
        val day = LocalDate.parse("2026-05-04")
        assertEquals("10:00–11:00", AccountText.time(planning, day, "Europe/Berlin", "All day")); assertEquals("10:00–11:00 Berlin", AccountText.time(planning, day, "America/New_York", "All day"))
        assertEquals("22:00–…", AccountText.time(night, day, "Europe/Berlin", "All day")); assertEquals("All day", AccountText.time(trip, LocalDate.parse("2026-05-05"), "Europe/Berlin", "All day"))
    }
    @Test fun aReplyKeepsItsConversationAndQuotesABoundedPart() {
        val message = json("""{"id":"m","threadId":"t","from":{"email":"anna@example.test","name":"Anna"},"subject":"Plan","text":"${(1..200).joinToString("\\n") { "line $it" }}"}""")
        val reply = AccountText.reply(message, "Anna wrote:")
        assertEquals("Re: Plan", reply.str("subject")); assertEquals("anna@example.test", (reply["to"] as kotlinx.serialization.json.JsonArray)[0].let { (it as kotlinx.serialization.json.JsonPrimitive).content })
        assertEquals("t", reply.obj("reply")?.str("threadId")); assertEquals("m", reply.obj("reply")?.str("messageId"))
        assertTrue(reply.str("text")!!.startsWith("\n\nAnna wrote:\n> line 1\n")); assertFalse(reply.str("text")!!.contains("line 81"))
        assertEquals("RE: x", AccountText.reply(json("""{"subject":"RE: x","text":""}"""), "").str("subject"))
        assertEquals(listOf("a@x.test", "b@x.test"), AccountText.emails(" a@x.test, b@x.test;\n"))
    }
    @Test fun aDraftSaysWhereItStands() {
        assertEquals(R.string.account_write_assistant, AccountText.state(json("""{"state":"draft","origin":"assistant"}"""))); assertEquals(R.string.account_write_unknown, AccountText.state(json("""{"state":"unknown"}""")))
        assertTrue(AccountText.open(json("""{"state":"unknown"}"""))); assertFalse(AccountText.open(json("""{"state":"sent"}""")))
    }
    @Test fun aRoutineGoesOnlyToWhatWasNamed() {
        assertEquals(json("""{"accountId":"a","target":{"kind":"mail","to":["me@x.test"]}}"""), routineDelivery("a", "mail", "me@x.test")); assertEquals(json("""{"accountId":"a","target":{"kind":"github","repo":"o/r","number":12}}"""), routineDelivery("a", "github", " o/r #12 "))
        assertNull(routineDelivery("a", "mail", "  ")); assertNull(routineDelivery("a", "mail", (1..6).joinToString(",") { "p$it@x.test" })); assertNull(routineDelivery("a", "github", "o/r")); assertNull(routineDelivery("a", "github", "o/r #0x1"))
    }
}
