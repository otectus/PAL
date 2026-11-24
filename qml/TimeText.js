.pragma library

// Words for the desktop's clock (broker/time.ts): a reading, its zone, and how long something took. Every value
// shown comes from the broker. Nothing here reads a clock, so a view cannot show a time the broker did not give it.

var zoneSources = {
    "conversation": "set for this conversation",
    "fixed-preference": "your fixed time zone",
    "message-device": "the device that sent the message",
    "broker-system": "this computer’s time zone",
    "utc-fallback": "UTC, because no time zone was found",
    "explicit-query": "the time zone you chose",
    "schedule": "the routine’s time zone"
}
function zoneSource(id) { return zoneSources[id] || String(id || "") }
function knownZoneSources() { return Object.keys(zoneSources) }

// “UTC−05:00”. Some zones use quarter hours.
function offset(seconds) {
    var size = Math.abs(Number(seconds) || 0), hours = Math.floor(size / 3600), minutes = Math.floor(size / 60) % 60
    return "UTC" + (seconds < 0 ? "−" : "+") + (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes
}
function zone(sample) { return sample && sample.timeZone ? sample.timeZone + " (" + offset(sample.offsetSeconds) + ")" : "" }

// A library script has no Locale type: 0 is Locale.LongFormat and 1 Locale.ShortFormat.
function twelveHours(format) {
    if (format === "12h") return true
    if (format === "24h") return false
    return Qt.locale().timeFormat(1).toLowerCase().indexOf("ap") >= 0
}
// The time of day from the reading's own local fields; `format` is the owner's display choice and changes nothing else.
function clock(sample, format) {
    var parts = String(sample && sample.localTime || "").split(":")
    if (parts.length < 2) return ""
    var hour = Number(parts[0])
    if (!twelveHours(format)) return parts[0] + ":" + parts[1]
    return (hour % 12 || 12) + ":" + parts[1] + " " + (hour < 12 ? Qt.locale().amText : Qt.locale().pmText)
}
function date(sample) {
    var parts = String(sample && sample.localDate || "").split("-")
    if (parts.length !== 3) return ""
    // Noon of that calendar day: this computer's own zone cannot move it to another date.
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12).toLocaleDateString(Qt.locale(), Qt.locale().dateFormat(0))
}
// “Saturday, 21 November 2026 · 11:30 AM · America/New_York (UTC−05:00)”
function line(sample, format) { return sample ? [date(sample), clock(sample, format), zone(sample)].filter(function (part) { return !!part }).join(" · ") : "" }

function count(value, one, many) { return value + " " + (value === 1 ? one : many) }
// A length of time in words, to the minute; never finer than the desktop can stand behind.
function duration(ms) {
    if (typeof ms !== "number" || !(ms >= 0)) return ""
    if (ms < 60000) return "less than a minute"
    var minutes = Math.floor(ms / 60000)
    if (minutes < 60) return count(minutes, "minute", "minutes")
    var hours = Math.floor(minutes / 60)
    if (hours < 48) return count(hours, "hour", "hours") + (minutes % 60 ? " " + count(minutes % 60, "minute", "minutes") : "")
    var days = Math.floor(hours / 24)
    return count(days, "day", "days") + (hours % 24 ? " " + count(hours % 24, "hour", "hours") : "")
}
var unknownReasons = {
    "anchor_unavailable": "Not recorded",
    "completion_time_unknown": "Not recorded",
    "no_turn": "No reply is running",
    "not_dispatched": "Not sent yet"
}
// One elapsed result (time.conversation): how long ago, or why that cannot be said.
function elapsed(result) {
    if (!result || result.status === "unknown") return unknownReasons[result && result.reason] || "Not recorded"
    if (result.status === "inconsistent") return "The clock was set back since then, so this cannot be measured"
    var words = duration(result.durationMs)
    if (!words) return "Not recorded"
    words = (words === "less than a minute" ? "Less than a minute" : "About " + words) + " ago"
    return result.reason === "clock_jump_or_sleep_during_interval" ? words + ". The clock jumped or the computer slept in between" : words
}
function status(sample) {
    if (!sample) return ""
    if (sample.clockStatus === "discontinuity-observed") return "The clock jumped or the computer slept a short while ago. Times measured across that moment are uncertain."
    if (sample.clockStatus === "unknown") return "The desktop’s clock is reporting a time PAL cannot use."
    return ""
}
// What a saved or sampled zone suggestion could not do.
var zoneReasons = {
    "device_zone_unsupported": "The sending device’s time zone is not one this desktop knows, so another was used.",
    "system_zone_unavailable": "This computer’s time zone could not be read."
}
function zoneReason(code) { return zoneReasons[code] || "" }
