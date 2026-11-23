.pragma library
.import QtQml 2.15 as Qml

function name(value) {
    const text = String(value || "").replace(/_/g, " ").trim()
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : qsTr("Subagent")
}

function active(state) {
    return ["starting", "running", "waiting"].indexOf(state) !== -1
}

function stateLabel(state) {
    switch (state) {
    case "starting": return qsTr("Starting")
    case "started": return qsTr("Started")
    case "running": return qsTr("Working")
    case "waiting": return qsTr("Waiting")
    case "pending": return qsTr("Pending")
    case "completed": return qsTr("Completed")
    case "closed": return qsTr("Closed")
    case "failed": return qsTr("Failed")
    case "declined": return qsTr("Declined")
    case "interrupted": return qsTr("Interrupted")
    case "unknown": return qsTr("Outcome unknown")
    case "notice": return qsTr("Notice")
    default: return ""
    }
}

function time(stamp, full) {
    if (!stamp) return ""
    const date = new Date(Number(stamp))
    if (isNaN(date.getTime())) return ""
    if (full) return date.toLocaleString(Qt.locale(), Qml.Locale.ShortFormat)
    if (date.toDateString() !== new Date().toDateString()) return date.toLocaleDateString(Qt.locale(), Qml.Locale.ShortFormat)
    return date.toLocaleTimeString(Qt.locale(), Qml.Locale.ShortFormat)
}
