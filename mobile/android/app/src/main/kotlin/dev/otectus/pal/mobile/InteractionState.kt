package dev.otectus.pal.mobile

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.otectus.pal.mobile.protocol.Agent
import dev.otectus.pal.mobile.protocol.ApprovalQuestion
import dev.otectus.pal.mobile.protocol.Session

internal fun Agent.isActive() = status in setOf("starting", "running", "waiting")

private fun stateLabel(status: String): Int? = when (status) {
    "idle" -> R.string.state_idle
    "starting" -> R.string.status_starting
    "running", "working" -> R.string.state_working
    "waiting" -> R.string.state_waiting
    "completed" -> R.string.state_completed
    "failed" -> R.string.status_failed
    "error" -> R.string.state_error
    "stopping" -> R.string.status_stopping
    "interrupted" -> R.string.status_interrupted
    "disconnected" -> R.string.state_disconnected
    "closed" -> R.string.state_closed
    else -> null
}

@Composable
internal fun agentStatusLabel(status: String) = stateLabel(status)?.let { stringResource(it) } ?: status

internal fun Session.activeAgentCount() = agents.count(Agent::isActive)

internal data class SessionLabel(val string: Int? = null, val plural: Int? = null, val count: Int = 0)

internal fun sessionLabel(session: Session, pendingInput: Int = 0): SessionLabel {
    if (pendingInput > 0) return SessionLabel(plural = R.plurals.session_inputs, count = pendingInput)
    val active = session.activeAgentCount()
    if (active > 0) return SessionLabel(plural = R.plurals.session_agents, count = active)
    return SessionLabel(string = when (session.activity) {
        "recalling" -> R.string.state_recalling
        "thinking" -> R.string.state_thinking
        "speaking" -> R.string.state_speaking
        "working" -> R.string.state_using_tools
        "delegating" -> R.string.state_delegating
        "waitingForAgents" -> R.string.state_waiting_agents
        "compacting" -> R.string.state_compacting
        "planning" -> R.string.status_planning
        else -> stateLabel(session.status)
    })
}

@Composable
internal fun sessionDisplayStatus(session: Session, pendingInput: Int = 0): String {
    val label = sessionLabel(session, pendingInput)
    return label.plural?.let { pluralStringResource(it, label.count, label.count) }
        ?: label.string?.let { stringResource(it) } ?: session.status
}

internal fun questionError(question: ApprovalQuestion, answers: List<String>): Int? =
    if (question.required && answers.none(String::isNotBlank)) {
        if (question.multiSelect) R.string.required_choices else R.string.required_choice
    } else null

internal fun selectQuestionOption(question: ApprovalQuestion, current: List<String>, label: String, selected: Boolean): List<String> {
    if (!question.multiSelect) return if (selected) listOf(label) else emptyList()
    return if (selected) (current + label).distinct() else current - label
}

internal fun questionOtherValue(question: ApprovalQuestion, answers: List<String>): String {
    val labels = question.options.map { it.label }.toSet()
    return answers.filterNot { it in labels }.joinToString("\n")
}

internal fun updateQuestionOther(question: ApprovalQuestion, current: List<String>, text: String): List<String> {
    val selected = if (question.multiSelect) {
        val labels = question.options.map { it.label }.toSet()
        current.filter { it in labels }
    } else emptyList()
    return if (text.isBlank()) selected else selected + text
}
