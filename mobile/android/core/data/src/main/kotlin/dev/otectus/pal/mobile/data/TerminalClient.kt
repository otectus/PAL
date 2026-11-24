package dev.otectus.pal.mobile.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The phone's copy of a desktop terminal's screen (terminal.v1). The desktop keeps the authoritative screen; the
 * phone applies its frames in order and never parses escape sequences. A frame whose base revision is not the
 * one held here means a frame was missed (dropped under pressure, a reconnect): the view attaches again for a
 * fresh snapshot instead of guessing.
 */
data class TerminalRun(val col: Int, val text: String, val fg: Long, val bg: Long, val attrs: Int) {
    val bold get() = attrs and 1 != 0
    val italic get() = attrs and 2 != 0
    val underline get() = attrs and 4 != 0
    val reverse get() = attrs and 8 != 0
    val strike get() = attrs and 16 != 0
    val concealed get() = attrs and 64 != 0
}

data class TerminalScreen(val rows: Int, val cols: Int, val lines: List<List<TerminalRun>>, val cursorRow: Int, val cursorCol: Int, val cursorVisible: Boolean, val alt: Boolean, val revision: Long) {
    /** The screen as plain text, for copying and for accessibility. */
    fun text(): String = lines.joinToString("\n") { line -> plain(line) }.trimEnd()
    companion object {
        fun plain(line: List<TerminalRun>): String {
            val out = StringBuilder()
            for (run in line) { while (out.length < run.col) out.append(' '); out.append(run.text) }
            return out.toString()
        }
    }
}

object TerminalFrames {
    fun line(array: JsonArray): List<TerminalRun> = array.mapNotNull { element ->
        val run = (element as? JsonArray)?.takeIf { it.size >= 5 }?.map { it as? JsonPrimitive } ?: return@mapNotNull null
        TerminalRun(run[0]?.intOrNull ?: 0, run[1]?.contentOrNull ?: "", run[2]?.longOrNull ?: -1, run[3]?.longOrNull ?: -1, run[4]?.intOrNull ?: 0)
    }
    private fun cursor(value: JsonArray?) = Triple(value?.getOrNull(0)?.jsonPrimitive?.intOrNull ?: 0, value?.getOrNull(1)?.jsonPrimitive?.intOrNull ?: 0, (value?.getOrNull(2)?.jsonPrimitive?.intOrNull ?: 1) == 1)
    /** A whole screen: the `screen` of terminal.attach/create, or a full `terminal.screen` frame. */
    fun snapshot(screen: JsonObject): TerminalScreen {
        val rows = screen["rows"]?.jsonPrimitive?.intOrNull ?: 0
        val lines = screen["lines"]?.jsonArray?.map { line(it.jsonArray) } ?: emptyList()
        val (row, col, visible) = cursor(screen["cursor"] as? JsonArray)
        val revision = (screen["revision"] ?: screen["rev"])?.jsonPrimitive?.longOrNull ?: 0
        return TerminalScreen(rows, screen["cols"]?.jsonPrimitive?.intOrNull ?: 0, List(rows) { lines.getOrNull(it) ?: emptyList() }, row, col, visible, screen["alt"]?.jsonPrimitive?.booleanOrNull == true, revision)
    }
    /** Applies one `terminal.screen` frame; null when it does not continue [current] (attach again). */
    fun apply(current: TerminalScreen?, frame: JsonObject): TerminalScreen? {
        val full = frame["full"]?.jsonPrimitive?.booleanOrNull == true
        if (full) return snapshot(frame)
        val base = frame["base"]?.jsonPrimitive?.longOrNull ?: return null
        if (current == null || base != current.revision) return null
        val rows = frame["rows"]?.jsonPrimitive?.intOrNull ?: current.rows
        if (rows != current.rows) return null
        val changed = frame["changed"] as? JsonObject ?: JsonObject(emptyMap())
        val lines = current.lines.toMutableList()
        for ((row, value) in changed) { val index = row.toIntOrNull() ?: continue; if (index in lines.indices) lines[index] = line(value.jsonArray) }
        val (r, c, visible) = cursor(frame["cursor"] as? JsonArray)
        return current.copy(cols = frame["cols"]?.jsonPrimitive?.intOrNull ?: current.cols, lines = lines, cursorRow = r, cursorCol = c, cursorVisible = visible,
            alt = frame["alt"]?.jsonPrimitive?.booleanOrNull == true, revision = frame["rev"]?.jsonPrimitive?.longOrNull ?: current.revision)
    }
}

/** A control lease: input is bound to it, its epoch and the next sequence number. */
data class TerminalLease(val leaseId: String, val epoch: Int, val controllerRevision: String, val lastSequence: Long) {
    companion object {
        fun from(value: JsonObject?): TerminalLease? {
            value ?: return null
            fun part(key: String) = value[key] as? JsonPrimitive
            return TerminalLease(part("leaseId")?.contentOrNull ?: return null, part("epoch")?.intOrNull ?: return null,
                part("controllerRevision")?.contentOrNull ?: "0", part("lastSequence")?.longOrNull ?: 0)
        }
    }
}

/**
 * Input after a lost acknowledgement (handoff §7.4): never resend blindly. The desktop's input status says what it
 * accepted. A frame it accepted is done; a frame it did not accept under the same lease is safe to send again with
 * the same sequence (a duplicate would be refused); a lease that changed means control moved or the terminal
 * restarted its input, and queued input is dropped so the person looks at the screen first.
 */
sealed interface InputRecovery {
    data object Accepted : InputRecovery
    data object Resend : InputRecovery
    data class Abandon(val reason: String) : InputRecovery
    companion object {
        fun decide(status: JsonObject, sequence: Long): InputRecovery {
            val current = (status["current"] as? JsonPrimitive)?.booleanOrNull == true
            if (!current) return Abandon("Control of this terminal changed. Check the screen before typing again; nothing was sent twice.")
            val last = (status["lastSequence"] as? JsonPrimitive)?.longOrNull ?: return Abandon("The desktop could not say what it received. Check the screen.")
            return if (last >= sequence) Accepted else Resend
        }
    }
}

/** Keys a phone sends by name; the desktop encodes them for the program's current modes. */
object TerminalKeys {
    const val SHIFT = 1; const val ALT = 2; const val CTRL = 4
    fun text(value: String) = JsonObject(mapOf("text" to JsonPrimitive(value)))
    fun paste(value: String) = JsonObject(mapOf("paste" to JsonPrimitive(value)))
    fun key(name: String, mods: Int = 0) = JsonObject(mapOf("key" to JsonPrimitive(name), "mods" to JsonPrimitive(mods)))
    fun char(codePoint: Int, mods: Int) = JsonObject(mapOf("char" to JsonPrimitive(codePoint), "mods" to JsonPrimitive(mods)))
}
