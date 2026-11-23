package dev.otectus.pal.mobile.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Turn acceptance differs from an in-progress command-ledger acknowledgement. */
fun acceptedSendStatus(result: JsonElement): String? =
    // A duplicate mutation can return the command ledger envelope ({commandId,status}).
    // That only says whether the broker still knows the mutation, not that a provider
    // accepted this turn. A real send response always binds the acceptance to a turn.
    (result as? JsonObject)?.takeIf { it["turnId"] != null }?.get("status")
        ?.let { it as? JsonPrimitive }?.contentOrNull
        ?.takeIf { it in setOf("accepted", "completed", "queued") }

/** A replayed mutation ledger envelope must be reconciled, never treated as an operation result. */
fun commandLedgerStatus(result: JsonElement): String? =
    (result as? JsonObject)?.takeIf { it["commandId"] != null && it["turnId"] == null }?.get("status")
        ?.let { it as? JsonPrimitive }?.contentOrNull
        ?.takeIf { it in setOf("accepted", "running", "unknown", "failed", "completed") }

/**
 * Provider reasoning and tool output belong in Activity, never in reply bubbles. A Workbench result
 * card stays in the conversation, where it happened, as a desktop-only reference.
 */
fun Message.isConversationMessage(): Boolean = role in setOf("user", "assistant") &&
    kind in setOf("text", "message", "", "question", "answer", "queued", "queue-cancelled", "delegation") || isDesktopOnlyResult()

/** A Workbench result (proposed changes, files or images, a run) that is reviewed on the desktop. */
fun Message.isDesktopOnlyResult(): Boolean = role == "workbench"

/** A user-role row PAL wrote itself when delegated work reported back; never the user's own words. */
fun Message.isDelegationUpdate(): Boolean = role == "user" && kind == "delegation"

/** Keep streamed revisions when a slower history request returns an older copy. */
fun mergeMessages(current: List<Message>, incoming: List<Message>): List<Message> {
    val merged = current.associateBy(Message::id).toMutableMap()
    incoming.forEach { message ->
        val old = merged[message.id]
        if (old == null || (message.revision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) >=
            (old.revision.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)) merged[message.id] = message
    }
    return merged.values.sortedBy(Message::time)
}
