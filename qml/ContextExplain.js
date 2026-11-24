.pragma library

// Plain-language explanations for the Context drawer. A turn's recorded recall outcome
// (broker/memory.ts RecallOutcome) describes the moment that turn was prepared; current memory
// health can differ, so every summary is labelled with its time. tests/recall-outcome.test.ts
// checks every code has text.

var coverageLabels = {
    semantic_degraded: "the semantic index was unavailable or behind",
    graph_degraded: "the relationship graph was behind",
    deadline_partial: "the search stopped at its deadline",
    token_budget_trimmed: "some matches were left out for space",
    cloud_memory_denied: "local-only memories were withheld from a cloud model"
}

var reasonText = {
    "disabled/setting_off": "Memory is off in Settings.",
    "disabled/paused": "AI actions were paused, so memory was not used.",
    "disabled/temporary_conversation": "Temporary conversations never use memory.",
    "disabled/remote_scope": "This turn had no memory access from its device.",
    "disabled/unavailable": "Memory was not available for this conversation.",
    "disabled/style_withheld": "Not searched: this conversation’s style or posture withholds automatic memory recall.",
    "skipped/no_topic_words": "Not searched: the message had no topic words to look up.",
    "skipped/budget_too_small": "Not searched: the model had no room left for recalled memory.",
    "skipped/message_excluded_by_policy": "Not searched: memory policy excluded this message.",
    "no_eligible_sources/cloud_memory_not_allowed": "Not searched: this model is cloud-hosted and sharing memory with cloud models is off.",
    "no_match/nothing_cleared_relevance": "Searched memory; nothing was relevant enough to include.",
    "already_supplied/items_held_from_recent_turns": "Nothing new: the matching memories were already supplied in recent turns.",
    "timed_out/recall_deadline": "Memory did not answer in time; the reply went ahead without it.",
    "degraded/memory_changed": "Memory changed during recall; the reply went ahead without it.",
    "degraded/unavailable": "Memory was unavailable; the reply went ahead without it.",
    "degraded/no_match_partial_coverage": "Nothing was found, but part of memory could not be searched."
}

function plural(count, one, many) { return count + " " + (count === 1 ? one : many) }

function coverage(codes) {
    var parts = []
    for (var index = 0; index < (codes || []).length; index++) if (coverageLabels[codes[index]]) parts.push(coverageLabels[codes[index]])
    return parts.join("; ")
}

// One sentence for the outcome, a detail line, and when it was recorded.
function describe(outcome, now) {
    if (!outcome || !outcome.outcome) return { title: "No recall has been recorded for this conversation yet.", detail: "", when: "" }
    var title
    if (outcome.outcome === "included")
        title = "Included " + plural(outcome.items || 0, "memory", "memories") + " (about " + (outcome.estimatedTokens || 0) + " tokens)."
    else title = reasonText[outcome.outcome + "/" + outcome.reason] || ("Recall outcome: " + outcome.outcome + (outcome.reason ? " · " + outcome.reason : "") + ".")
    var details = []
    if (outcome.outcome === "included" && outcome.held) details.push(plural(outcome.held, "match was", "matches were") + " already supplied earlier")
    if (outcome.withheld) details.push(plural(outcome.withheld, "unreviewed memory was", "unreviewed memories were") + " left out; a memory search still finds " + (outcome.withheld === 1 ? "it" : "them"))
    var gaps = coverage(outcome.coverage)
    if (gaps) details.push("Coverage: " + gaps)
    if (outcome.memoryState && outcome.memoryState !== "ready" && outcome.memoryState !== "idle") details.push("Memory was " + outcome.memoryState + " then")
    var when = ""
    if (outcome.time) {
        var minutes = Math.max(0, Math.round(((now || Date.now()) - outcome.time) / 60000))
        when = minutes < 1 ? "Recorded just now" : minutes < 60 ? "Recorded " + plural(minutes, "minute", "minutes") + " ago" : "Recorded " + new Date(outcome.time).toLocaleString()
        when += "; current memory health may differ."
    }
    return { title: title, detail: details.join(". ") + (details.length ? "." : ""), when: when }
}

function knownReasons() { return Object.keys(reasonText) }
function knownCoverage() { return Object.keys(coverageLabels) }

// Web searches recorded for this conversation (broker/web.ts SearchTrace): read-only, never repeated.
var providerNames = { auto: "Automatic", duckduckgo: "DuckDuckGo", brave: "Brave", mojeek: "Mojeek", searxng: "SearXNG" }
function providerName(id) { return providerNames[id] || String(id || "") }
function seconds(ms) { return ms < 1000 ? Math.max(0, Math.round(ms)) + " ms" : (ms / 1000).toFixed(1) + " s" }
function searchLine(trace) {
    if (!trace) return ""
    var head = trace.outcome === "ok" ? providerName(trace.provider) + " · " + plural(trace.results || 0, "result", "results") + (trace.cached ? " · from PAL’s cache" : "")
        : trace.outcome === "cancelled" ? "Search stopped before it finished" : "No provider returned results"
    return head + " · " + seconds(trace.durationMs || 0) + (trace.query ? " · “" + trace.query + "”" : "")
}
function searchDetail(trace) {
    var lines = []
    // M12: what the constraints became for the provider, and what could only be requested.
    var constraints = trace && trace.constraints
    if (constraints) lines = lines.concat(constraints.applied || [], constraints.approximated || [])
    var sent = (trace && trace.attempts || []).filter(function (attempt) { return attempt.outcome === "ok" && attempt.sent })
    if (sent.length && constraints) lines.push("Sent to " + providerName(sent[0].provider) + ": " + sent[0].sent)
    var failed = (trace && trace.attempts || []).filter(function (attempt) { return attempt.outcome === "failed" })
    if (failed.length) lines.push((trace.outcome === "ok" ? "Fell back after: " : "Tried: ") + failed.map(function (attempt) { return providerName(attempt.provider) + " (" + (attempt.reason || "failed") + ")" }).join("; "))
    else if (trace && trace.requested === "auto" && !trace.cached && !lines.length) lines.push("First provider answered.")
    return lines.join("\n")
}

// The last request's plan (broker/context-plan.ts TurnPlan): sizes and codes recorded when it was sent.
var layerReasons = {
    not_needed: "not needed",
    no_room: "no room left in the window",
    older_turns_omitted: "older turns left out",
    none_supplied: "none",
    withheld_cloud_route: "withheld: the model routes to the cloud",
    tool_output_shortened: "a long tool result was shortened",
    none_offered: "none offered",
    disabled: "memory off",
    skipped: "not searched",
    no_eligible_sources: "not shareable with this model",
    no_match: "nothing relevant",
    already_supplied: "already supplied earlier",
    timed_out: "memory timed out",
    degraded: "memory unavailable",
    withheld_for_route: "some earlier file or image content withheld: its folder does not allow this model",
    setting_off: "turned off in Settings",
    time_unavailable: "the clock could not be read",
    not_sent_yet: "not sent yet",
    not_supplied: "not supplied with this request"
}
// Time awareness: what the next message will be told, and what the last request was (broker/temporal-context.ts).
function timeLine(time, source) {
    if (!time) return ""
    if (!time.enabled) return "The assistant is not told the date or time. Time awareness is off in Settings."
    return "The next message is told the time in " + time.zone + " (" + source + ")."
}
function timeDetail(time) {
    if (!time || !time.enabled) return ""
    return time.timing ? "It also says how long it has been since your previous message." : "Time since earlier messages is left out."
}
var elapsedBasis = {
    "wall-clock-estimate": "time since your previous message estimated from recorded times",
    "no_room": "time since earlier messages left out for space",
    "not_supplied": "no time since earlier messages"
}
var timeChannels = {
    "system message": "in the system message",
    "turn context": "as turn context",
    "appended system prompt": "in the appended system prompt",
    "prepended to the message": "ahead of the message"
}
function planTime(detail, zoneName) {
    var parts = []
    if (detail.local) parts.push("read at " + String(detail.local).replace("T", " "))
    if (detail.timezone) parts.push(detail.timezone + (zoneName && detail.timezoneSource ? " (" + zoneName(detail.timezoneSource) + ")" : ""))
    if (detail.channel) parts.push("sent " + (timeChannels[detail.channel] || "as " + detail.channel))
    if (detail.refresh) parts.push("renewed " + detail.refresh)
    if (detail.elapsed && elapsedBasis[detail.elapsed]) parts.push(elapsedBasis[detail.elapsed])
    if (detail.clock === "discontinuity-observed") parts.push("the clock had jumped shortly before")
    return parts.join(" · ")
}
// §11.3: which excerpts of document collections a request was given, and what was left out.
function documentsDetail(detail) {
    var parts = []
    if ((detail.excerpts || []).length) parts.push(detail.excerpts.join("; "))
    if (detail.dropped) parts.push(detail.dropped + " left out for space")
    if (detail.duplicates) parts.push(plural(detail.duplicates, "repeat", "repeats") + " given once")
    if (detail.conflicts) parts.push(plural(detail.conflicts, "excerpt disagrees", "excerpts disagree") + " with another")
    if ((detail.stale || []).length) parts.push("changed since indexing: " + detail.stale.join(", "))
    if ((detail.withheld || []).length) parts.push("withheld from this model: " + detail.withheld.join(", "))
    return parts.join(" · ")
}
function pinnedDetail(detail) {
    var parts = []
    if ((detail.included || []).length) parts.push(detail.included.join(", "))
    if ((detail.omitted || []).length) parts.push("left out: " + detail.omitted.join("; "))
    return parts.join(" · ")
}
var routeText = { local: "this computer", remote: "your own server", cloud: "a cloud service", unknown: "an unknown place" }
function destinationLine(route) {
    if (!route) return ""
    return "Messages go to " + (routeText[route.route] || route.route) + "." + (route.evidence ? " " + route.evidence + (/[.!?]$/.test(route.evidence) ? "" : ".") : "")
}
function toolsLine(tools) {
    if (!tools || !tools.available) return "No Workbench tools in this conversation."
    return plural(tools.offered, "tool is", "tools are") + " described to the model now (about " + Number(tools.tokens).toLocaleString(Qt.locale(), "f", 0) + " tokens)" + (tools.available > tools.offered ? "; " + (tools.available - tools.offered) + " more when it asks" : "") + "."
}
function helpersLine(helpers) {
    if (!helpers || !helpers.calls) return "No helper calls in this conversation."
    return plural(helpers.calls, "helper call", "helper calls") + ((helpers.models || []).length ? " with " + helpers.models.join(", ") : "") + "."
}
function tokens(value) { return value === null || value === undefined ? "unknown" : "≈" + Number(value).toLocaleString(Qt.locale(), "f", 0) + " tokens" }
function planSummary(plan) {
    if (!plan || !plan.layers) return ""
    var total = 0
    for (var index = 0; index < plan.layers.length; index++) if (plan.layers[index].included && plan.layers[index].tokens) total += plan.layers[index].tokens
    var parts = [(plan.provider || "") + (plan.model ? " · " + plan.model : "")]
    parts.push(plan.contextSize ? tokens(total) + " of " + Number(plan.contextSize).toLocaleString(Qt.locale(), "f", 0) + " in the window" : tokens(total) + " supplied by PAL")
    if (plan.rounds > 1) parts.push(plan.rounds + " tool rounds")
    // A library script has no QML Locale type, so the time uses an explicit short format.
    if (plan.time) parts.push(new Date(plan.time).toLocaleTimeString(Qt.locale(), "hh:mm"))
    return parts.join(" · ")
}
// M13: token counts the provider itself reported for the request; never an estimate or a price.
function reportedUsage(plan) {
    var reported = plan && plan.reported
    if (!reported) return ""
    var counts = []
    if (reported.inputTokens !== undefined) counts.push(Number(reported.inputTokens).toLocaleString(Qt.locale(), "f", 0) + " in")
    if (reported.outputTokens !== undefined) counts.push(Number(reported.outputTokens).toLocaleString(Qt.locale(), "f", 0) + " out")
    return counts.length ? (reported.source || "The provider") + " reported " + counts.join(", ") + " tokens for this request." : ""
}
function planRows(plan, zoneName) {
    if (!plan || !plan.layers) return []
    return plan.layers.map(function (layer) {
        var detail = layer.detail || {}, extra = ""
        if (layer.id === "continuity" && layer.included) extra = plural(detail.turns || 0, "earlier turn", "earlier turns") + " excerpted" + (detail.omittedBefore ? ", " + detail.omittedBefore + " older not shown" : "")
        else if (layer.id === "history") extra = plural(detail.keptMessages || 0, "message", "messages") + " kept" + (detail.omittedTurns ? ", " + plural(detail.omittedTurns, "turn", "turns") + " left out" : "")
        else if (layer.id === "tools" && detail.count) extra = plural(detail.count, "tool", "tools")
        else if (layer.id === "personality" && detail.channel) extra = "sent as " + detail.channel
        else if (layer.id === "attachments" && (detail.files || detail.images)) extra = plural(detail.files || 0, "file", "files") + ", " + plural(detail.images || 0, "image", "images")
        else if (layer.id === "temporal-context" && layer.included) extra = planTime(detail, zoneName)
        else if (layer.id === "documents" && layer.included) extra = documentsDetail(detail)
        else if (layer.id === "pinned") extra = pinnedDetail(detail)
        else if (layer.id === "conventions" && detail.files) extra = plural(detail.files.length, "file", "files") + (detail.redactions ? ", " + plural(detail.redactions, "secret", "secrets") + " redacted" : "")
        var status = layer.included ? (layer.reason ? "included · " + (layerReasons[layer.reason] || layer.reason) : "included") : (layerReasons[layer.reason] || layer.reason || "not included")
        return { id: layer.id, label: layer.label + (layer.trust === "untrusted" ? " (reference data)" : ""), size: layer.included ? tokens(layer.tokens) : "", status: status + (extra ? " · " + extra : ""), included: !!layer.included }
    })
}
