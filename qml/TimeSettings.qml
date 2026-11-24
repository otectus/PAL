import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "TimeText.js" as TimeText
// Settings › Application › Time awareness: whether models are told the date and time, in which zone, and how PAL
// shows times to you. The sample line is a live reading through the same resolver a message uses.
CSection {
    id: section
    title: "Time awareness"
    description: "The assistant can know the date, the time and your time zone, and how long ago earlier messages were. They are sent to the model you are talking to."
    readonly property var time: App.state.settings?.time || ({})
    readonly property bool on: time.enabled !== false
    readonly property bool fixed: time.zoneMode === "fixed"
    property string error: ""
    function update(value) {
        error = ""
        rpc.call("settings.update", { time: value }, result => { if (result.error) section.error = String(result.error.message || result.error) })
    }
    function restoreMode() { zoneMode.currentIndex = Qt.binding(() => section.fixed ? 1 : 0) }
    RpcClient { id: rpc }
    ClockSource { id: source; active: section.visible && section.expanded && !!section.Window.window?.visible }
    CCheckBox { objectName: "timeEnabled"; text: "Let the assistant use the current date and time"; checked: section.on; enabled: App.connected; onClicked: section.update({ enabled: checked }) }
    CText { text: "When off, nothing about the time is sent and the clock tools are withheld. Timers, schedules and the clock view keep working."; color: Theme.muted; font.pixelSize: Theme.secondary }
    CText { text: "Time zone"; font.weight: Font.DemiBold }
    CComboBox {
        id: zoneMode; objectName: "timeZoneMode"
        Layout.fillWidth: true
        model: ["Use the device sending the message", "Use a fixed time zone"]
        currentIndex: section.fixed ? 1 : 0
        enabled: App.connected
        Accessible.name: "Time zone"
        onActivated: index => {
            if (index === 0) { if (section.fixed) section.update({ zoneMode: "automatic" }); return }
            if (section.fixed) return
            if (section.time.fixedZone) section.update({ zoneMode: "fixed" })
            else { section.restoreMode(); zonePicker.openFor(source.sample?.timeZone || "") }
        }
    }
    CText {
        visible: !section.fixed
        text: "A message from your phone uses the phone’s time zone, and one from this computer uses this computer’s. An older phone app does not send one, so this computer’s is used."
        color: Theme.muted; font.pixelSize: Theme.secondary
    }
    CButton {
        objectName: "timeFixedZone"
        visible: section.fixed
        Layout.fillWidth: true
        text: (section.time.fixedZone || "") + " · Change…"
        Accessible.name: "Fixed time zone, " + (section.time.fixedZone || "") + ". Change"
        enabled: App.connected
        onClicked: zonePicker.openFor(section.time.fixedZone || "")
    }
    CCheckBox { objectName: "timeConversation"; text: "Include time since earlier messages"; checked: section.time.conversationTiming !== false; enabled: App.connected && section.on; onClicked: section.update({ conversationTiming: checked }) }
    CText { text: "Uses the times PAL already records for messages. It does not watch what you do."; color: Theme.muted; font.pixelSize: Theme.secondary }
    CText { text: "Time display"; font.weight: Font.DemiBold }
    CComboBox {
        objectName: "timeDisplay"
        Layout.fillWidth: true
        readonly property var formats: ["system", "12h", "24h"]
        model: ["Follow the system", "12-hour", "24-hour"]
        currentIndex: Math.max(0, formats.indexOf(section.time.clockFormat || "system"))
        enabled: App.connected
        Accessible.name: "Time display"
        onActivated: index => section.update({ clockFormat: formats[index] })
    }
    CText { objectName: "timeSample"; visible: !!text; text: TimeText.line(source.sample, source.format); color: source.stale ? Theme.muted : Theme.accentText }
    CText {
        objectName: "timeSource"; visible: !!source.sample
        text: (source.stale ? "Last reading from this desktop" : "Clock: this desktop") + " · " + TimeText.zoneSource(source.sample?.zoneSource) + (source.sample?.reason ? ". " + TimeText.zoneReason(source.sample.reason) : "")
        color: Theme.muted; font.pixelSize: Theme.secondary
    }
    CText { objectName: "timeError"; visible: !!text; text: section.error || (source.sample ? "" : source.error); color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    CButton { objectName: "openClock"; text: "Open the clock"; onClicked: clockView.openFor(App.selectedId) }
    ClockView { id: clockView; objectName: "settingsClockView"; offerSettings: false }
    ZonePicker { id: zonePicker; heading: "Fixed time zone"; onChosen: zone => section.update({ zoneMode: "fixed", fixedZone: zone }) }
}
