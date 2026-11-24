package dev.otectus.pal.mobile

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Times and lines of a recording, read the same way as on the desktop (qml/Recordings.js). */
internal object TimedText {
    data class Cue(val index: Int, val start: Double, val end: Double, val text: String, val speaker: String)
    fun cue(value: JsonObject) = Cue(value.int("index") ?: 0, value.seconds("start"), value.seconds("end"), value.str("text").orEmpty(), value.str("speaker").orEmpty())
    private fun JsonObject.seconds(key: String) = (this[key] as? JsonPrimitive)?.doubleOrNull ?: 0.0

    /** 12:34, or 1:02:03 from an hour on. */
    fun clock(seconds: Double): String {
        val total = seconds.coerceAtLeast(0.0).toLong(); fun pad(value: Long) = value.toString().padStart(2, '0')
        return if (total >= 3600) "${total / 3600}:${pad(total / 60 % 60)}:${pad(total % 60)}" else "${total / 60}:${pad(total % 60)}"
    }
    /** Reads 12:34, 1:02:03, 75 or 12:34.5; null when it is none of these. */
    fun seconds(text: String): Double? {
        val parts = text.trim().split(':'); if (parts.size > 3) return null
        val last = Regex("^(\\d{1,5})(?:[.,](\\d{1,3}))?$").matchEntire(parts.last()) ?: return null
        val rest = last.groupValues[1].toInt(); if (parts.size > 1 && rest > 59) return null
        val minutes = if (parts.size > 1) parts[parts.size - 2].takeIf { Regex("\\d{1,3}").matches(it) }?.toInt() ?: return null else 0
        val hours = if (parts.size > 2) parts[0].takeIf { Regex("\\d{1,2}").matches(it) }?.toInt() ?: return null else 0
        if (parts.size == 3 && minutes > 59) return null
        return hours * 3600.0 + minutes * 60.0 + rest + (last.groupValues[2].ifEmpty { "0" }.padEnd(3, '0').toInt() / 1000.0)
    }
    fun range(start: Double, end: Double) = "${clock(start)}–${clock(end)}"
    /** The line being said at a position, or the last one before it; -1 before the first. */
    fun lineAt(cues: List<Cue>, position: Double): Int {
        var low = 0; var high = cues.size - 1; var found = -1
        while (low <= high) { val middle = (low + high) / 2; if (cues[middle].start <= position + 0.05) { found = middle; low = middle + 1 } else high = middle - 1 }
        return found
    }
    fun matches(cues: List<Cue>, query: String): List<Int> {
        val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }; if (words.isEmpty()) return emptyList()
        return cues.indices.filter { i -> val text = (cues[i].speaker + " " + cues[i].text).lowercase(); words.all { it in text } }
    }
    fun quote(cues: List<Cue>) = cues.joinToString("\n") { "[${clock(it.start)}] ${if (it.speaker.isEmpty()) "" else it.speaker + ": "}${it.text.replace(Regex("\\s*\\n\\s*"), " ")}" }
    data class Cited(val start: Double, val label: String)
    private val citation = Regex("\\[\\s*((?:\\d{1,2}:)?\\d{1,3}:\\d{2})(?:\\s*[–-]\\s*(?:\\d{1,2}:)?\\d{1,3}:\\d{2})?\\s*]")
    /** Times a reply cites, such as [12:34] or [1:02:03–1:02:10]: each once, in the order they appear. */
    fun cited(text: String, limit: Int = 8): List<Cited> = citation.findAll(text).mapNotNull { match -> seconds(match.groupValues[1])?.let { Cited(it, clock(it)) } }.distinctBy { it.start }.take(limit).toList()
}
