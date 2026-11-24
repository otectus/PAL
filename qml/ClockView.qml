import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "TimeText.js" as TimeText
// The desktop's date and time, exact without a model, and what this conversation's times are measured from. It
// shows the same reading and zone a model would be told, and says when a reading is old.
CDialog {
    id: view
    objectName: "clockView"
    // Read aloud once when the view opens; a new minute is shown, never announced.
    property string spoken: ""
    accessibleTitle: spoken || "Date and time"
    property string sessionId: ""
    property bool offerSettings: true
    property var timing: null
    property string error: ""
    property string feedback: ""
    readonly property var session: (App.state.sessions || []).find(item => item.id === sessionId) || ({})
    readonly property string overrideZone: session.timeZone || ""
    signal settingsRequested(string category, string target)
    function openFor(id) { sessionId = id || ""; spoken = ""; error = ""; feedback = ""; timing = null; open() }
    function refreshTiming() {
        if (!sessionId) return
        rpc.call("time.conversation", { sessionId: sessionId }, value => { if (value.error) view.error = String(value.error.message || value.error); else view.timing = value })
    }
    function setZone(zone) {
        error = ""; feedback = ""
        rpc.call("session.timeZone", { id: sessionId, timeZone: zone, expectedConfigRevision: session.configRevision || "0" }, value => {
            if (value.error) { view.error = String(value.error.message || value.error); return }
            view.feedback = zone ? "The next message uses " + zone + "." : "This conversation follows your settings again."
            source.read()
        })
    }
    onOpened: refreshTiming()
    RpcClient { id: rpc; scope: view.sessionId }
    ClockSource {
        id: source
        active: view.opened; sessionId: view.sessionId
        onSampled: {
            if (!view.spoken) view.spoken = TimeText.line(source.sample, source.format)
            if (view.opened) view.refreshTiming()
        }
    }
    CText { text: "Date and time"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
    ColumnLayout {
        Layout.fillWidth: true; spacing: Theme.space1
        opacity: source.stale ? Theme.disabledOpacity : 1
        CText { objectName: "clockTime"; text: source.sample ? TimeText.clock(source.sample, source.format) : "Reading the clock…"; font.pixelSize: source.sample ? Theme.display : Theme.body; font.weight: Font.DemiBold }
        CText { objectName: "clockDate"; visible: !!source.sample; text: TimeText.date(source.sample); font.pixelSize: Theme.section }
        CText { objectName: "clockZone"; visible: !!source.sample; text: TimeText.zone(source.sample) + " · " + TimeText.zoneSource(source.sample?.zoneSource); color: Theme.muted }
    }
    CText { objectName: "clockAuthority"; text: "Clock: this desktop. PAL does not check it against a time server."; color: Theme.muted; font.pixelSize: Theme.secondary }
    CText { objectName: "clockStale"; visible: source.stale; text: "PAL is reconnecting. This is the last reading from the desktop, not the current time."; color: Theme.amber; font.pixelSize: Theme.secondary }
    CText { objectName: "clockNotice"; visible: !!text; text: TimeText.zoneReason(source.sample?.reason || "") || TimeText.status(source.sample); color: Theme.amber; font.pixelSize: Theme.secondary }
    CSection {
        objectName: "clockConversation"
        visible: !!view.sessionId
        title: "This conversation"
        description: "Times since recorded events, including every pause between messages. They are not a measure of work."
        ColumnLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            Repeater {
                model: [{ label: "Started", name: "created" }, { label: "Your previous message", name: "previousMessage" }, { label: "Last reply", name: "previousReply" }]
                RowLayout {
                    id: elapsedRow
                    required property var modelData
                    Layout.fillWidth: true; spacing: Theme.space4
                    CText { Layout.fillWidth: false; Layout.preferredWidth: Theme.pickerWidth; Layout.alignment: Qt.AlignTop; text: elapsedRow.modelData.label; color: Theme.muted }
                    CText { objectName: "clock_" + elapsedRow.modelData.name; Layout.alignment: Qt.AlignTop; text: view.timing ? TimeText.elapsed(view.timing[elapsedRow.modelData.name]) : "…" }
                }
            }
        }
        CText { text: "Time zone for this conversation"; font.weight: Font.DemiBold }
        CText {
            objectName: "conversationZone"
            text: view.overrideZone ? view.overrideZone : "Default" + (source.sample && !view.overrideZone ? " · " + source.sample.timeZone + ", " + TimeText.zoneSource(source.sample.zoneSource) : "")
        }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "chooseConversationZone"; Layout.fillWidth: true; text: "Choose a time zone…"; enabled: App.connected && !rpc.busy && view.session.mode !== undefined; onClicked: zonePicker.openFor(view.overrideZone || source.sample?.timeZone || "") }
            CButton { objectName: "clearConversationZone"; Layout.fillWidth: true; visible: !!view.overrideZone; text: "Use the default"; enabled: App.connected && !rpc.busy; onClicked: view.setZone(null) }
        }
        CText { text: "It decides which local date and time the next message is told. Timers, schedules and other conversations keep their own."; color: Theme.muted; font.pixelSize: Theme.secondary }
    }
    CText { objectName: "clockError"; visible: !!text; text: view.error || (source.sample ? "" : source.error); color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    CText { objectName: "clockFeedback"; visible: !!view.feedback; text: view.feedback; color: Theme.accentText; font.pixelSize: Theme.secondary }
    RowLayout {
        Layout.fillWidth: true; spacing: Theme.space2
        CButton { objectName: "clockSettings"; Layout.fillWidth: true; visible: view.offerSettings; text: "Time settings"; onClicked: { view.close(); view.settingsRequested("application", "timeEnabled") } }
        CButton { objectName: "clockClose"; Layout.fillWidth: true; text: "Close"; onClicked: view.close() }
    }
    ZonePicker { id: zonePicker; heading: "Time zone for this conversation"; onChosen: zone => view.setZone(zone) }
}
