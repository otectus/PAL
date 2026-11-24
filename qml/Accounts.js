.pragma library
// Words and small calculations shared by the account screens.
var serviceLabels = { github: "GitHub", calendar: "Calendar", mail: "Mail", drive: "Files" }
function stateText(account) {
    if (account.state === "signed-out") return "Not signed in"
    if (account.state === "problem") return account.problem || "Sign in again"
    if (account.state === "more") return "Signed in as " + account.login + " · sign in again to allow " + (account.needs || []).map(function (service) { return serviceLabels[service].toLowerCase() }).join(" and ")
    return "Signed in as " + account.login
}
function usesText(account) {
    return Object.keys(account.services || {}).map(function (service) { return serviceLabels[service] + (account.services[service] === "write" ? ": read and change" : ": read") }).join(" · ")
}
function assistantsText(account) {
    if (account.ai === "off") return "Assistants do not use it"
    var models = account.destinations.cloud ? "any model" : account.destinations.remote ? "models here or on your servers" : "models on this computer"
    return "Assistants may " + (account.ai === "write" ? "read it and prepare changes" : "read it") + " · " + models + " · " + (account.projects ? account.projects.length + (account.projects.length === 1 ? " project" : " projects") : "every project")
}
function withService(accounts, service) { return (accounts || []).filter(function (account) { return !!(account.access || {})[service] }) }
function canWrite(account, service) { return !!account && (account.access || {})[service] === "write" }
// ── Times. An event keeps its own zone; a day is grouped by the zone the person is in. ──
function dayOf(time) { return (time.date || time.dateTime || "").slice(0, 10) }
function clockOf(time) { return time.date ? "" : time.dateTime.slice(11, 16) }
function isoDay(date) { return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) }
function pad(value) { return (value < 10 ? "0" : "") + value }
function addDays(day, count) { var date = new Date(day + "T12:00:00"); date.setDate(date.getDate() + count); return isoDay(date) }
function dayTitle(day, today, locale) {
    var text = new Date(day + "T12:00:00").toLocaleDateString(locale, "dddd, d MMMM")
    return day === today ? "Today · " + text : day === addDays(today, 1) ? "Tomorrow · " + text : text
}
// Events by the days they touch, in order; a long event appears on each day it lasts.
function byDay(events, from, days) {
    var groups = []
    for (var i = 0; i < days; i++) {
        var day = addDays(from, i)
        var rows = events.filter(function (event) { var last = event.allDay ? addDays(dayOf(event.end), -1) : dayOf(event.end); return dayOf(event.start) <= day && last >= day && !(!event.allDay && dayOf(event.start) < day && clockOf(event.end) === "00:00" && dayOf(event.end) === day) })
        if (rows.length) groups.push({ day: day, events: rows })
    }
    return groups
}
function timeText(event, day, zone) {
    if (event.allDay) return "All day"
    var start = dayOf(event.start) === day ? clockOf(event.start) : "…", end = dayOf(event.end) === day ? clockOf(event.end) : "…"
    return start + "–" + end + (event.start.timeZone && event.start.timeZone !== zone ? " " + event.start.timeZone.split("/").pop().replace(/_/g, " ") : "")
}
function emails(text) { return text.split(/[,;\s]+/).map(function (item) { return item.trim() }).filter(function (item) { return item.length }) }
function person(address) { return !address ? "Unknown sender" : address.name ? address.name : address.email }
function size(bytes) { return !bytes ? "" : bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 1024) + " KB" : (bytes / 1048576).toFixed(1) + " MB" }
function writeState(write) {
    switch (write.state) {
    case "sent": return "Done" + (write.origin === "routine" ? " by a routine" : "")
    case "sending": return "Sending…"
    case "unknown": return "May have arrived"
    case "failed": return "Not sent"
    case "discarded": return "Discarded"
    default: return write.origin === "assistant" ? "Draft by the assistant" : "Draft"
    }
}
function reply(message, login) {
    var subject = /^re:/i.test(message.subject) ? message.subject : "Re: " + message.subject
    return { to: message.from ? [message.from.email] : [], cc: [], subject: subject, text: "\n\n" + person(message.from) + " wrote:\n" + message.text.split("\n").slice(0, 80).map(function (line) { return "> " + line }).join("\n"), reply: { threadId: message.threadId, messageId: message.id } }
}
