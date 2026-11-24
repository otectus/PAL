package dev.otectus.pal.mobile

import androidx.compose.runtime.saveable.SaverScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UiGuardsTest {
    private fun json(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject

    @Test fun everyRowGetsItsOwnKey() {
        assertEquals(listOf("a", "b", "c"), uniqueKeys(listOf("a", "b", "c")))
        val keys = uniqueKeys(listOf("a", "", "a", "", "a", "b"))
        assertEquals(6, keys.toSet().size); assertEquals(listOf("a", "", "b"), listOf(keys[0], keys[1], keys[5]))
        // What a row is called does not depend on the rows after it.
        assertEquals(keys.take(3), uniqueKeys(listOf("a", "", "a")))
    }

    @Test fun onlyWhatIsTextIsReadAsText() {
        val value = json("""{"list":["a",1,null,{"b":2},["c"],true],"object":{},"null":null,"number":1.5,"text":"2.5","word":"x"}""")
        assertEquals(listOf("a", "1", "true"), value.strings("list"))
        for (key in listOf("object", "null", "number", "missing")) assertEquals(emptyList<String>(), value.strings(key))
        assertEquals(1.5, value.real("number")!!, 0.0); assertEquals(2.5, value.real("text")!!, 0.0)
        for (key in listOf("word", "null", "object", "list", "missing")) assertNull(value.real(key))
    }

    @Test fun anEditInProgressIsKeptWithTheVersionItStartedFrom() {
        val edit = FileEdit("sha256:1", "Line one\nLine two\n"); val scope = SaverScope { true }
        fun kept(value: FileEdit?) = with(fileEditSaver) { scope.save(value) }
        assertEquals(edit, fileEditSaver.restore(kept(edit)!!)); assertEquals(FileEdit("v", ""), fileEditSaver.restore(kept(FileEdit("v", ""))!!))
        // Nothing is kept of a file that is only being read.
        assertNull(kept(null))
    }
}
