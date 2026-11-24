package dev.otectus.pal.mobile

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.sin

/** Recordings, documents, analysis sessions and references on the phone: what they show, send and keep. */
class MediaScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val resources get() = compose.activity.resources
    private fun show(content: @Composable () -> Unit) { compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { content() } } }; compose.waitForIdle() }
    private fun column(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) = show { Column(Modifier.verticalScroll(rememberScrollState())) { content() } }
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val cues = listOf(TimedText.Cue(0, 0.0, 2.0, "We launch on Monday.", "Anna"), TimedText.Cue(1, 2.0, 4.5, "The budget is approved.", ""), TimedText.Cue(2, 4.5, 6.0, "Any questions?", ""))
    private val transcript = json("""{"artifactId":"t","versionId":"v","name":"Talk (transcript).vtt","latest":true}""")
    private val opened = json("""{"recording":{"artifactId":"r","versionId":"w","name":"Talk.wav","mime":"audio/wav","bytes":256044,"video":false,"available":true},"transcripts":[{"artifactId":"t","name":"Talk"}],"canTranscribe":true}""")

    private fun wav(seconds: Int): File {
        val rate = 16000; val data = rate * 2 * seconds; val buffer = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put("RIFF".toByteArray()).putInt(36 + data).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(data)
        for (i in 0 until rate * seconds) buffer.putShort((sin(i / 20.0) * 4000).toInt().toShort())
        return File(compose.activity.cacheDir, "media-test-${System.nanoTime()}.wav").apply { writeBytes(buffer.array()) }
    }
    private fun content(selected: IntRange? = null, playback: MediaPlayback? = null, wanted: Double? = null, value: JsonObject = opened, text: JsonObject? = transcript, lines: List<TimedText.Cue> = cues, select: (IntRange?) -> Unit = {}, load: () -> Unit = {}, ask: () -> Unit = {}, transcribe: () -> Unit = {}, dialog: (RecordingDialog) -> Unit = {}) = show {
        RecordingContent(value, text, lines, playback, null, false, null, null, null, selected, wanted, true, {}, load, select, {}, transcribe, ask, {}, dialog)
    }

    @Test fun aPickedTimeIsTheTimeThatPlaysAndAPartStopsAtItsEnd() {
        val file = wav(6); lateinit var playback: MediaPlayback
        compose.runOnUiThread { playback = MediaPlayback(compose.activity, file) }
        compose.waitUntil(8000) { playback.ready }
        assertEquals(6.0, playback.duration, 0.2); assertFalse("nothing plays by itself", playback.playing)
        content(playback = playback)
        compose.onNodeWithContentDescription(resources.getString(R.string.media_play_from, "0:04")).performClick()
        compose.waitUntil(5000) { compose.runOnUiThread { playback.update() }; playback.position >= 4.4 }
        assertTrue(playback.playing); compose.runOnUiThread { playback.pause() }; compose.waitForIdle(); assertFalse(playback.playing)
        compose.runOnUiThread { playback.playPart(1.0, 1.6) }
        compose.waitUntil(8000) { compose.runOnUiThread { playback.update() }; !playback.playing && playback.position >= 1.5 }
        assertTrue("it stopped near the end of the part, at ${playback.position}", abs(playback.position - 1.6) < 1.0)
        compose.runOnUiThread { playback.release() }; compose.waitForIdle(); assertFalse("its private file is gone", file.exists())
    }
    @Test fun aRecordingIsFetchedOnlyWhenAsked() {
        var loads = 0
        content(load = { loads++ })
        compose.onNode(hasText(resources.getString(R.string.media_load, "|").substringBefore("|"), substring = true)).assertIsDisplayed().performClick(); compose.waitForIdle(); assertEquals(1, loads)
        // Without the recording here, a line can still be picked, but not played.
        compose.onNodeWithContentDescription(resources.getString(R.string.media_play_from, "0:00")).assertIsNotEnabled()
    }
    @Test fun linesArePickedWithTheirTimesAndAskedAbout() {
        var selected by mutableStateOf<IntRange?>(null); var asked = 0; var dialog: RecordingDialog? = null
        show { RecordingContent(opened, transcript, cues, null, null, false, null, null, null, selected, null, true, {}, {}, { selected = it }, {}, {}, { asked++ }, {}, { dialog = it }) }
        compose.onNodeWithText("The budget is approved.").performClick(); compose.waitForIdle()
        compose.onNodeWithText("Any questions?").performClick(); compose.waitForIdle()
        compose.onNodeWithText("0:02–0:06 · " + resources.getQuantityString(R.plurals.media_lines, 2, 2)).assertIsDisplayed()
        compose.onNodeWithText(resources.getString(R.string.media_ask)).performClick(); compose.waitForIdle(); assertEquals(1, asked)
        compose.onNodeWithText(resources.getString(R.string.media_clip)).performClick(); compose.waitForIdle(); assertEquals(RecordingDialog.Clip, dialog)
        compose.onNodeWithText(resources.getString(R.string.media_clear)).performClick(); compose.waitForIdle(); assertEquals(null, selected)
    }
    @Test fun aTranscriptWithoutItsRecordingSaysSoAndARecordingWithoutOneOffersIt() {
        content(value = json("""{"recording":null,"transcripts":[],"canTranscribe":true}"""))
        compose.onNodeWithText(resources.getString(R.string.media_not_kept)).assertIsDisplayed(); compose.onNodeWithText(resources.getString(R.string.media_clip)).assertDoesNotExist()
        var started = 0
        content(text = null, lines = emptyList(), transcribe = { started++ })
        compose.onNodeWithText(resources.getString(R.string.media_transcribe)).performClick(); compose.waitForIdle(); assertEquals(1, started)
    }
    @Test fun correctionsSendOnlyChangedLinesAndClipsNeedAValidPart() {
        var edits: List<Pair<Int, String>>? = null
        show { CorrectLines(cues.drop(1), false, null, {}) { edits = it } }
        compose.onNodeWithText(resources.getString(R.string.media_save_corrections)).assertIsNotEnabled()
        compose.onNodeWithText("The budget is approved.").performTextReplacement("The budget is agreed.")
        compose.onNodeWithText(resources.getString(R.string.media_save_corrections)).assertIsEnabled().performClick(); compose.waitForIdle()
        assertEquals(listOf(1 to "The budget is agreed."), edits)
        var made: Triple<Double, Double, Boolean>? = null
        show { ClipDialog(2.0, 4.5, true, false, null, {}) { from, to, text -> made = Triple(from, to, text) } }
        compose.onNodeWithText("0:05").performTextReplacement("0:01"); compose.onNodeWithText(resources.getString(R.string.media_make_clip)).assertIsNotEnabled()
        compose.onNodeWithText("0:01").performTextReplacement("0:04"); compose.onNodeWithText(resources.getString(R.string.media_make_clip)).assertIsEnabled().performClick(); compose.waitForIdle()
        assertEquals(Triple(2.0, 4.0, true), made)
    }
    @Test fun aDocumentIsWrittenFromATemplateWithoutLosingWhatWasTyped() {
        val formats = listOf(json("""{"id":"pdf","label":"PDF","available":false,"reason":"The PDF helper is not installed."}"""), json("""{"id":"docx","label":"Word","available":true}"""))
        val templates = listOf(json("""{"id":"report","name":"Report"}"""), json("""{"id":"decision","name":"Decision record"}"""))
        var filled = ""; var made: List<String>? = null
        show { DocumentForm(DocumentSource.Blank, formats, templates, null, false, null, null, {}, { template, _, done -> filled = template; done("# $template", "Title of $template") }, { _, _ -> }, { title, text, format, page -> made = listOf(title, text, format, page) }, {}, {}) }
        compose.onNodeWithText(resources.getString(R.string.docs_make)).assertIsNotEnabled()
        compose.onNodeWithText("Report").performClick(); compose.waitForIdle(); assertEquals("report", filled)
        // A second template asks before it replaces text that is there.
        compose.onNodeWithText("Decision record").performClick(); compose.waitForIdle(); assertEquals("report", filled)
        compose.onNodeWithText(resources.getString(R.string.docs_replace)).assertIsDisplayed(); compose.onNodeWithText(resources.getString(R.string.docs_replace_yes)).performClick(); compose.waitForIdle(); assertEquals("decision", filled)
        // The first format that this desktop can write is chosen; the other says why not.
        compose.onNodeWithText(resources.getString(R.string.docs_make)).performClick(); compose.waitForIdle()
        assertEquals(listOf("Title of report", "# decision", "docx"), made!!.take(3))
        compose.onNodeWithText("PDF").performScrollTo().performClick(); compose.onNodeWithText("The PDF helper is not installed.").performScrollTo().assertIsDisplayed(); compose.onNodeWithText(resources.getString(R.string.docs_make)).assertIsNotEnabled()
    }
    @Test fun anAnalysisSessionShowsWhatItHoldsAndWhatAResultDependsOn() {
        val status = json("""{"available":true,"session":{"id":"k","state":"idle","started":0,"sinceClear":2,"cells":[{"number":1,"state":"completed"},{"number":2,"state":"completed"}],"variables":[{"name":"frame","type":"pandas.DataFrame","detail":"120 × 4"}],"inputs":[]},"ended":null}""")
        var ran = ""; var action = ""
        column { AnalysisSessionContent(status, json("""{"state":"completed","details":{"stdout":"42"},"results":[]}"""), emptyList(), false, false, null, {}, { code, _ -> ran = code }, { action = it }, {}) }
        compose.onNodeWithText(resources.getString(R.string.lab_session_depends)).assertIsDisplayed(); compose.onNodeWithText("pandas.DataFrame · 120 × 4").performScrollTo().assertIsDisplayed(); compose.onNodeWithText("42").assertExists()
        compose.onNodeWithText(resources.getString(R.string.lab_session_run)).performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText(resources.getString(R.string.lab_session_code)).performScrollTo().performTextInput("frame.head()")
        compose.onNodeWithText(resources.getString(R.string.lab_session_run)).performScrollTo().performClick(); compose.waitForIdle(); assertEquals("frame.head()", ran)
        compose.onNodeWithText(resources.getString(R.string.lab_session_stop)).performScrollTo().performClick(); compose.waitForIdle(); assertEquals("a session is not ended by one tap", "", action)
        compose.onNodeWithText(resources.getString(R.string.lab_session_confirm)).performClick(); compose.waitForIdle(); assertEquals("sessionStop", action)
        column { AnalysisSessionContent(json("""{"available":true,"session":null,"ended":{"reason":"The analysis session ended after 30 minutes without use."}}"""), null, emptyList(), false, false, null, {}, { _, _ -> }, {}, {}) }
        compose.onNodeWithText("The analysis session ended after 30 minutes without use.").assertIsDisplayed(); compose.onNodeWithText(resources.getString(R.string.lab_session_start)).assertIsEnabled()
    }
    @Test fun pinsPreviewsAndQuestionsSayWhatTheyWouldDo() {
        var removed = ""
        column { PinRows(listOf(json("""{"id":"p","label":"rules.md","scope":"project"}"""))) { removed = it.str("id").orEmpty() }; ReferencePreview(json("""{"ok":false,"problem":"Notes may only be processed on this computer"}""")); ReferencePreview(json("""{"ok":true,"characters":420,"notes":["plan.md changed after you picked it"]}""")) }
        compose.onNodeWithText(resources.getString(R.string.refs_pin_everywhere)).assertIsDisplayed(); compose.onNodeWithText(resources.getString(R.string.refs_unpin)).performClick(); compose.waitForIdle(); assertEquals("p", removed)
        compose.onNodeWithText(resources.getString(R.string.refs_cannot, "Notes may only be processed on this computer")).assertIsDisplayed(); compose.onNode(hasText("plan.md changed", substring = true)).assertExists()
        column { TrialResults(json("""{"results":[{"source":"backups.md","location":"lines 3–5","excerpt":"Kept for 30 days","conflict":"old.md (different numbers)","stale":true,"weak":false}],"candidates":4,"mode":"words"}""")) }
        compose.onNodeWithText("backups.md · lines 3–5").assertIsDisplayed(); compose.onNodeWithText(resources.getString(R.string.kb_conflict, "old.md (different numbers)")).assertExists(); compose.onNodeWithText(resources.getString(R.string.kb_stale)).assertExists()
        column { TrialResults(json("""{"results":[],"candidates":0,"mode":"words"}""")) }
        assertEquals(1, compose.onAllNodesWithText(resources.getString(R.string.kb_nothing)).fetchSemanticsNodes().size)
    }
}
