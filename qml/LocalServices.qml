pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A07: local services PAL may run for the person. Each is off until chosen; what someone else started is only shown.
ColumnLayout {
    id: local
    objectName: "localServices"
    property var services: []
    property bool supported: true
    property bool loaded: false
    property string error: ""
    property string working: ""
    property string logId: ""
    property string logText: ""
    readonly property bool settling: services.some(row => row.state === "starting" || row.state === "stopping")
    spacing: Theme.space2
    function show(value) { if (value.error) { error = value.error; return } services = value.services || []; supported = value.supported !== false; loaded = true }
    function load() { reader.call("services.list", {}, value => local.show(value)) }
    function act(method, id) { error = ""; working = id; writer.call("services." + method, { id: id }, value => { local.working = ""; local.show(value); if (value.error) local.load() }) }
    function allow(id, key, on) {
        const current = App.state.settings?.localServices || ({ managed: [], autostart: [] }), list = [], patch = {}
        for (let i = 0; i < (current[key] || []).length; i++) if (current[key][i] !== id) list.push(current[key][i])
        patch[key] = on ? list.concat([id]) : list; error = ""
        writer.call("settings.update", { localServices: patch }, value => { if (value.error) local.error = value.error; local.load() })
    }
    function toggleLog(id) {
        if (logId === id) { logId = ""; return }
        logger.call("services.log", { id: id }, value => {
            if (value.error) { local.error = value.error; return }
            local.logText = value.text || "Nothing has been written yet."; local.logId = id
        })
    }
    function said(row) {
        const state = { ready: "Answering", partial: "Partly answering", starting: "Starting…", stopping: "Stopping…", failed: "Stopped with an error", stopped: "Not running" }[row.state]
        return state + (row.owner === "pal" ? " · started by PAL" : row.owner === "external" ? " · not started by PAL" : "")
    }
    RpcClient { id: reader }
    RpcClient { id: writer }
    RpcClient { id: logger }
    Component.onCompleted: load()
    Timer { interval: 1500; repeat: true; running: local.visible && local.settling; onTriggered: local.load() }
    CText { text: "Services PAL can run"; font.weight: Font.DemiBold }
    CText { text: "Off until you choose. PAL stops only what it started itself; a service someone else started is used and left alone. Nothing is installed."; color: Theme.muted; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    CText { objectName: "servicesUnsupported"; visible: local.loaded && !local.supported; text: "PAL runs services only in a systemd user session, which this computer does not have."; color: Theme.amber; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    Repeater {
        model: local.services
        Rectangle {
            id: row
            required property var modelData
            readonly property string serviceId: modelData.id
            readonly property bool usable: local.supported && !modelData.unavailable
            Layout.fillWidth: true; implicitHeight: column.implicitHeight + Theme.gutter; radius: Theme.radiusControl; color: Theme.raised; border.color: Theme.border
            ColumnLayout {
                id: column
                anchors.fill: parent; anchors.margins: Theme.space2; spacing: Theme.space1
                CText { text: row.modelData.label; font.weight: Font.DemiBold; Layout.fillWidth: true }
                CText { objectName: "serviceState_" + row.serviceId; text: local.said(row.modelData) + " · " + row.modelData.addresses.join(", "); color: row.modelData.state === "ready" ? Theme.accentText : row.modelData.state === "failed" ? Theme.danger : Theme.muted; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
                CText { objectName: "serviceProblem_" + row.serviceId; visible: text.length > 0; text: row.modelData.problem || (row.modelData.managed ? row.modelData.unavailable : "") || row.modelData.blocking; color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true }
                CCheckBox { objectName: "serviceManaged_" + row.serviceId; text: "Let PAL run it"; checked: row.modelData.managed; enabled: !writer.busy && (row.usable || row.modelData.managed); onClicked: local.allow(row.serviceId, "managed", checked) }
                CCheckBox { objectName: "serviceAutostart_" + row.serviceId; visible: row.modelData.managed; text: "Start it with PAL when nothing answers"; checked: row.modelData.autostart; enabled: !writer.busy; onClicked: local.allow(row.serviceId, "autostart", checked) }
                Flow {
                    visible: row.modelData.managed || row.modelData.owner === "pal"
                    Layout.fillWidth: true; spacing: Theme.space2
                    CButton { objectName: "serviceStart_" + row.serviceId; text: local.working === row.serviceId ? "Working…" : "Start"; visible: row.modelData.managed && row.modelData.owner === "none"; enabled: row.usable && !writer.busy && !local.settling; onClicked: local.act("start", row.serviceId) }
                    CButton { objectName: "serviceStop_" + row.serviceId; text: "Stop"; visible: row.modelData.owner === "pal"; enabled: !writer.busy && !local.settling && !row.modelData.blocking; help: row.modelData.blocking || "Stop what PAL started"; onClicked: local.act("stop", row.serviceId) }
                    CButton { objectName: "serviceRestart_" + row.serviceId; text: "Restart"; quiet: true; visible: row.modelData.managed && row.modelData.owner === "pal"; enabled: !writer.busy && !local.settling && !row.modelData.blocking; onClicked: local.act("restart", row.serviceId) }
                    CButton { objectName: "serviceLog_" + row.serviceId; text: local.logId === row.serviceId ? "Hide log" : "Show log"; quiet: true; enabled: !logger.busy; onClicked: local.toggleLog(row.serviceId) }
                }
                ScrollView {
                    id: logView
                    visible: local.logId === row.serviceId
                    Layout.fillWidth: true; Layout.preferredHeight: Theme.editorMedium; clip: true
                    ScrollBar.vertical: CScrollBar { parent: logView; x: logView.width - width; height: logView.availableHeight }
                    TextArea {
                        objectName: "serviceLogText"
                        readOnly: true; text: local.logText; textFormat: TextEdit.PlainText; wrapMode: TextEdit.WrapAnywhere
                        color: Theme.text; font.family: Theme.mono; font.pixelSize: Theme.caption
                        Accessible.name: row.modelData.label + " log"
                        background: Rectangle { color: Theme.input; radius: Theme.radiusChip }
                    }
                }
            }
        }
    }
    CText { objectName: "servicesError"; visible: !!local.error; text: local.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
}
