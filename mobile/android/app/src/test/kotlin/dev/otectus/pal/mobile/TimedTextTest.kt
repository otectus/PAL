package dev.otectus.pal.mobile

import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class TimedTextTest {
    private fun cue(index: Int, start: Double, end: Double, text: String, speaker: String = "") = TimedText.Cue(index, start, end, text, speaker)
    private val cues = listOf(cue(0, 0.0, 2.0, "We launch on Monday.", "Anna"), cue(1, 2.0, 4.5, "The budget is approved."), cue(2, 4.5, 6.0, "Any questions?"))

    /** The same cases as tests/recordings.test.ts and tests/recordings-ui.test.ts, so a time means the same on both screens. */
    @Test fun timesReadAndShowAsOnTheDesktop() {
        assertEquals("12:34", TimedText.clock(754.9)); assertEquals("1:02:03", TimedText.clock(3723.0)); assertEquals("0:00–1:05", TimedText.range(0.0, 65.0))
        assertEquals(754.0, TimedText.seconds("12:34")!!, 0.0); assertEquals(3723.0, TimedText.seconds("1:02:03")!!, 0.0); assertEquals(75.0, TimedText.seconds(" 75 ")!!, 0.0); assertEquals(754.5, TimedText.seconds("12:34.5")!!, 0.0); assertEquals(1.25, TimedText.seconds("1,25")!!, 0.0)
        for (bad in listOf("", "x", "1:75", "1:75:00", "1:2:3:4", "-5", "12:")) assertNull(bad, TimedText.seconds(bad))
    }
    @Test fun theLineBeingSaidIsTheLastOneThatBegan() {
        assertEquals(-1, TimedText.lineAt(cues.drop(1), 0.5)); assertEquals(0, TimedText.lineAt(cues, 0.0)); assertEquals(1, TimedText.lineAt(cues, 4.4)); assertEquals(2, TimedText.lineAt(cues, 99.0)); assertEquals(-1, TimedText.lineAt(emptyList(), 1.0))
        assertEquals(listOf(0), TimedText.matches(cues, "anna LAUNCH")); assertTrue(TimedText.matches(cues, "  ").isEmpty())
        assertEquals("[0:00] Anna: We launch on Monday.\n[0:02] The budget is approved.", TimedText.quote(cues.take(2)))
    }
    @Test fun citedTimesAreFoundOnceInOrder() {
        assertEquals(listOf(754.0 to "12:34", 3723.0 to "1:02:03"), TimedText.cited("It starts [12:34], again [12:34–12:50], later [1:02:03]. Not [12] or 12:34 alone.").map { it.start to it.label })
        assertEquals(2, TimedText.cited("[0:01] [0:02] [0:03]", 2).size)
    }
    @Test fun tappingExtendsAndClearsASelection() {
        assertEquals(3..3, pickLine(null, 3)); assertNull(pickLine(3..3, 3)); assertEquals(1..3, pickLine(3..3, 1)); assertEquals(3..6, pickLine(3..4, 6)); assertEquals(4..4, pickLine(2..6, 4))
    }
    @Test fun referencesAreKeptUntilTheMessageThatCarriedThemIsAccepted() {
        ComposerReferences.clear()
        fun ref(name: String) = buildJsonObject { put("kind", "collection"); put("id", name) }
        repeat(8) { assertNull(ComposerReferences.add("s", "c$it", ref("c$it"))) }
        assertEquals(R.string.refs_full, ComposerReferences.add("s", "c9", ref("c9"))); assertNull("the same source is added once", ComposerReferences.add("s", "c0", ref("c0")))
        val carried = ComposerReferences.of("s").take(3); ComposerReferences.sent("s", carried)
        assertEquals(5, ComposerReferences.of("s").size); assertTrue(ComposerReferences.of("other").isEmpty())
        ComposerReferences.remove("s", ComposerReferences.of("s").first()); assertEquals(4, ComposerReferences.of("s").size)
        ComposerReferences.clear()
    }
    @Test fun documentsFollowThePhonesPageSizeAndNeedTheDesktop() {
        assertEquals("Letter", defaultPage(Locale.US)); assertEquals("A4", defaultPage(Locale.GERMANY))
        assertFalse(documentsOffered(MobileState(connection = ConnectionState.Online("Desktop", setOf("workbench.documents.render", "workbench.documents.formats"), 0))))
    }
    @Test fun recordingsAndTextOfferTheirOwnActions() {
        val state = MobileState(connection = ConnectionState.Online("Desktop", setOf("workbench.recordings.open", "workbench.documents.render", "workbench.artifacts.export"), 0))
        assertEquals(listOf(ArtifactTool.Folder, ArtifactTool.Media), artifactTools(state, "talk.mp3", "audio/mpeg", "other").sortedBy { it.name })
        assertTrue(ArtifactTool.Media in artifactTools(state, "talk.vtt", "text/vtt", "text")); assertTrue(ArtifactTool.Document in artifactTools(state, "notes.md", "text/markdown", "document"))
        assertFalse(ArtifactTool.Document in artifactTools(state, "page.html", "text/html", "document")); assertFalse(ArtifactTool.Document in artifactTools(state, "a.png", "image/png", "image"))
    }
}
