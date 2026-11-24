package dev.otectus.pal.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Accounts on the phone: what is shown, exactly what is asked of the desktop, and that nothing is sent without a review. */
class AccountsScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun text(id: Int, vararg args: Any) = compose.activity.getString(id, *args)
    private fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject
    private fun show(scroll: Boolean = true, content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Surface { if (scroll) Column(Modifier.padding(PALLayout.gutter).verticalScroll(rememberScrollState())) { content() } else content() } } } }; compose.waitForIdle() }
    private fun capture(name: String) { runCatching { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { shot -> File(compose.activity.getExternalFilesDir(null), "$name.png").outputStream().use { shot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } } } }
    private val provider = json("""{"id":"github","label":"GitHub","services":["github"],"methods":["device","token"]}""")
    private val google = json("""{"id":"google","label":"Google","services":["calendar","mail","drive"],"methods":["browser"]}""")
    private fun account(state: String, extra: String = "") = json("""{"id":"a","provider":"github","providerLabel":"GitHub","label":"Work","clientId":"app","secretSet":false,"services":{"github":"write"},"access":{"github":"write"},"ai":"read","destinations":{"remote":false,"cloud":false},"projects":null,"revision":"3","state":"$state"$extra}""")
    private fun card(value: JsonObject, flow: JsonObject? = null, with: JsonObject = provider, act: (String) -> Unit = {}) = show { AccountCard(value, with, flow, true, { act("signIn") }, { act("token") }, { act("edit") }, { act("signOut") }, { act("check") }, { act("remove") }) { act("cancel $it") } }

    @Test fun aCodeIsShownToBeEnteredAtTheServiceAndNothingElseIsAskedFor() {
        val done = mutableListOf<String>()
        card(account("signed-out")) { done += it }
        compose.onNodeWithText(text(R.string.account_signed_out_state)).assertIsDisplayed(); compose.onNodeWithText(text(R.string.account_sign_in_code)).performClick(); compose.onNodeWithText(text(R.string.account_use_token)).performClick(); assertEquals(listOf("signIn", "token"), done)
        card(account("signed-out"), json("""{"id":"f","state":"waiting","kind":"device","userCode":"WDJB-MJHT","address":"https://github.com/login/device"}""")) { done += it }
        compose.onNodeWithText("WDJB-MJHT").assertIsDisplayed(); compose.onNodeWithText(text(R.string.account_enter_code, "github.com/login/device")).assertIsDisplayed(); compose.onNodeWithText(text(R.string.account_waiting)).assertIsDisplayed(); capture("account-code")
        assertEquals(0, compose.onAllNodesWithText(text(R.string.account_sign_in_code)).fetchSemanticsNodes().size)
        compose.onNodeWithText(text(R.string.action_cancel)).performClick(); assertEquals("cancel f", done.last())
        card(account("signed-in", ""","login":"octo"""")); compose.onNodeWithText(text(R.string.account_signed_in_as, "octo")).assertIsDisplayed(); compose.onNodeWithText(text(R.string.account_ai_read)).assertIsDisplayed(); compose.onNodeWithText(text(R.string.account_check)).assertIsDisplayed()
        card(account("signed-out"), null, google); compose.onNodeWithText(text(R.string.account_desktop_only, "GitHub")).performScrollTo().assertIsDisplayed()
    }

    @Test fun theEditorAsksForTheLeastAndSavesExactlyWhatWasChosen() {
        var saved: JsonObject? = null
        show(false) { AccountEditor(null, listOf(provider, google), listOf("/home/me/project"), {}) { saved = it } }
        compose.onNodeWithText("Google").performClick(); compose.waitForIdle()
        compose.onAllNodesWithText(text(R.string.account_change))[0].performScrollTo().performClick(); compose.onAllNodesWithText(text(R.string.account_off))[2].performScrollTo().performClick()
        compose.onNodeWithText(text(R.string.account_client)).performScrollTo().performTextInput("client-1"); compose.onNodeWithText(text(R.string.account_secret)).performScrollTo().performTextInput("shh")
        compose.onNodeWithText(text(R.string.account_ai_write)).performScrollTo().performClick(); compose.waitForIdle()
        compose.onNodeWithText(text(R.string.account_every_project)).performScrollTo().performClick(); compose.waitForIdle(); compose.onNodeWithText("/home/me/project").performScrollTo().performClick(); compose.waitForIdle()
        compose.onNodeWithText(text(R.string.account_save)).performClick(); compose.waitForIdle()
        val value = saved!!
        assertEquals("google", value.str("provider")); assertEquals("Google", value.str("label")); assertEquals("client-1", value.str("clientId")); assertEquals("shh", value.str("clientSecret"))
        assertEquals(json("""{"calendar":"write","mail":"read","drive":"off"}"""), value.obj("services")); assertEquals("write", value.str("ai")); assertEquals(json("""{"remote":false,"cloud":false}"""), value.obj("destinations")); assertEquals(JsonArray(listOf(JsonPrimitive("/home/me/project"))), value["projects"])
    }

    @Test fun theAgendaShowsDaysAndAChangeIsPreparedNotSent() {
        val event = json("""{"id":"e1","calendarId":"primary","title":"Planning","allDay":false,"start":{"dateTime":"2026-05-04T10:00:00","timeZone":"Europe/Berlin"},"end":{"dateTime":"2026-05-04T11:00:00","timeZone":"Europe/Berlin"},"location":"Room 2","attendees":[{"email":"anna@example.test"}],"recurrence":"Every week on MO","revision":"r1","canEdit":true,"notes":"Bring questions"}""")
        val saved = mutableListOf<JsonObject>(); var removed: String? = null
        show(false) { AgendaView(true, 0, { _, _ -> listOf(event) }, { _, value, done -> saved += value; done() }, { removed = it.str("id") }, LocalDate.parse("2026-05-04"), ZoneId.of("Europe/Berlin")) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("10:00–11:00  Planning").fetchSemanticsNodes().isNotEmpty() }; compose.onNodeWithText("Room 2 · Every week on MO · " + compose.activity.resources.getQuantityString(R.plurals.account_guests, 1, 1)).assertIsDisplayed()
        compose.onNodeWithText("10:00–11:00  Planning").performClick(); compose.onNodeWithText("Bring questions").assertIsDisplayed(); capture("account-agenda"); compose.onNodeWithText(text(R.string.account_delete_event)).performClick(); assertEquals("e1", removed)
        compose.onNodeWithText(text(R.string.account_new_event)).performClick(); compose.waitForIdle()
        compose.onNodeWithText(text(R.string.account_review)).assertIsNotEnabled(); compose.onNodeWithText(text(R.string.account_event_title)).performTextInput("Dentist"); compose.onNodeWithText(text(R.string.account_weekly)).performScrollTo().performClick(); compose.onNodeWithText(text(R.string.account_review)).performClick(); compose.waitForIdle()
        assertEquals(json("""{"title":"Dentist","start":{"dateTime":"2026-05-04T09:00","timeZone":"Europe/Berlin"},"end":{"dateTime":"2026-05-04T10:00","timeZone":"Europe/Berlin"},"recurrence":{"every":"week"}}"""), saved.single())
    }

    @Test fun mailIsReadAsTextAndAReplyStaysInItsConversation() {
        val thread = json("""{"id":"t","threadId":"t","from":{"name":"Anna","email":"anna@example.test"},"date":1763900000000,"subject":"Plan","snippet":"Hello","unread":true}""")
        val message = json("""{"id":"m","threadId":"t","from":{"name":"Anna","email":"anna@example.test"},"to":[{"email":"me@example.test"}],"cc":[],"date":1763900000000,"subject":"Plan","text":"<b>not markup</b>","attachments":[{"id":"x","name":"plan.pdf","bytes":10}]}""")
        var saved: JsonObject? = null; val kept = mutableListOf<String>()
        show(false) { MailView(true, { listOf(thread) }, { listOf(message) }, { kept += it }, { id, item -> kept += id + "/" + item.str("id") }) { mail, done -> saved = mail; done() } }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Plan").fetchSemanticsNodes().isNotEmpty() }; compose.onNodeWithText("Plan").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("<b>not markup</b>").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(text(R.string.account_use_here)).performClick(); compose.onNodeWithText(text(R.string.account_attachment, "plan.pdf")).performScrollTo().performClick(); assertEquals(listOf("t", "m/x"), kept); capture("account-mail")
        compose.onNodeWithText(text(R.string.account_reply)).performClick(); compose.waitForIdle(); compose.onNodeWithText(text(R.string.account_message)).performScrollTo().performTextReplacement("Monday works."); compose.onNodeWithText(text(R.string.account_review)).performClick(); compose.waitForIdle()
        assertEquals(json("""{"to":["anna@example.test"],"cc":[],"subject":"Re: Plan","text":"Monday works.","reply":{"threadId":"t","messageId":"m"}}"""), saved)
    }

    @Test fun aWriteIsShownInFullAndSentByItsOwnButton() {
        var sent = 0; var kept = 0; val write = json("""{"id":"w","kind":"mail.send","service":"mail","title":"Send “Plan” to a@example.test","description":"Google · me@example.test\nTo: a@example.test\nSubject: Plan\n\nExactly this.","state":"draft","digest":"d"}""")
        show(false) { ReviewWrite(write, false, null, { kept++ }) { sent++ } }
        compose.onNodeWithText("Google · me@example.test\nTo: a@example.test\nSubject: Plan\n\nExactly this.").assertIsDisplayed(); capture("account-review"); compose.onNodeWithText(text(R.string.account_keep_draft)).performClick(); compose.onNodeWithText(text(R.string.account_send)).performClick(); assertEquals(1, kept); assertEquals(1, sent)
        show(false) { ReviewWrite(JsonObject(write + ("state" to JsonPrimitive("unknown")) + ("error" to JsonPrimitive("It may have arrived."))), false, null, {}) { sent++ } }
        compose.onNodeWithText("It may have arrived.").assertIsDisplayed(); compose.onNodeWithText(text(R.string.account_send)).assertIsNotEnabled()
        val drafts = json("""{"writes":[{"id":"w","title":"Send","state":"draft","origin":"assistant","login":"me","updated":1763900000000},{"id":"u","title":"Lost","state":"unknown","login":"me","updated":1763900000000,"error":"The answer was lost."},{"id":"d","title":"Gone","state":"discarded"}]}""")
        val done = mutableListOf<String>()
        show(false) { DraftsView(0, { drafts }, { done += "review " + it.str("id") }, { done += "check $it" }, { done += "discard $it" }) }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Lost").fetchSemanticsNodes().isNotEmpty() }; assertEquals(0, compose.onAllNodesWithText("Gone").fetchSemanticsNodes().size)
        compose.onNodeWithText("Send").performClick(); compose.onNodeWithText(text(R.string.account_review_send)).performClick(); compose.onNodeWithText("Lost").performClick(); compose.onNodeWithText(text(R.string.account_check_arrived)).performClick(); compose.onNodeWithText(text(R.string.account_discard)).performClick(); assertEquals(listOf("review w", "check u", "discard u"), done)
    }

    @Test fun filesOpenFoldersAndGitHubReadsBeforeItWrites() {
        val folders = mutableListOf<String?>(); val kept = mutableListOf<String>()
        show(false) { DriveView({ emptyList() }, { folders += it; if (it == null) listOf(json("""{"id":"f","name":"Projects","folder":true}"""), json("""{"id":"n","name":"notes.txt","folder":false,"bytes":18400}""")) else emptyList() }) { kept += it } }
        compose.waitUntil(5_000) { compose.onAllNodesWithText("notes.txt").fetchSemanticsNodes().isNotEmpty() }; compose.onNodeWithText("notes.txt").performClick(); compose.onNodeWithText(text(R.string.account_use_here)).performClick(); assertEquals(listOf("n"), kept)
        compose.onNodeWithText("Projects").performClick(); compose.waitUntil(5_000) { folders.contains("f") }; compose.onNodeWithText(text(R.string.account_up, "Projects")).performClick()
        var saved: JsonObject? = null
        show(false) { GitHubView(true, { _, _ -> listOf(json("""{"repo":"o/r","number":7,"title":"A bug","state":"open","author":"x"}""")) }, { what, _ -> assertEquals("issue", what); json("""{"repo":"o/r","number":7,"title":"A bug","state":"open","body":"Steps","comments":[{"author":"y","at":"2026-05-01T00:00:00Z","body":"Same here"}]}""") }, { _, _ -> }) { write, done -> saved = write; done() } }
        compose.onNodeWithText(text(R.string.account_search_github)).performTextInput("repo:o/r"); compose.onNodeWithText(text(R.string.account_search)).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("A bug").fetchSemanticsNodes().isNotEmpty() }; compose.onNodeWithText("A bug").performClick(); compose.waitUntil(5_000) { compose.onAllNodesWithText("Same here").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(text(R.string.account_comment)).performClick(); compose.waitForIdle(); compose.onNodeWithText(text(R.string.account_text)).performTextInput("Fixed."); compose.onNodeWithText(text(R.string.account_review)).performClick(); compose.waitForIdle()
        assertEquals(json("""{"kind":"comment","repo":"o/r","number":7,"body":"Fixed."}"""), saved)
    }
}
