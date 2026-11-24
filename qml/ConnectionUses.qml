pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Everything that depends on an account, and moving it to another one of the same provider before the account is removed.
CDialog {
    id: uses
    objectName: "connectionUses"
    property var app: null
    property var connection: ({})
    property var items: []
    property var targets: []
    property int total: 0
    property bool loaded: false
    property string error: ""
    property var problems: []
    readonly property int movable: items.filter(item => item.movable).length
    readonly property var kinds: ({ conversation: "Conversation", schedule: "Routine", helper: "Helper", vision: "Helper", images: "Image service", voice: "Voice", transcription: "Voice", extraction: "Memory", embedding: "Memory", "memory-task": "Memory", setup: "Saved setup", specialist: "Specialist", research: "Research" })
    signal removed()
    signal moved()
    function openFor(item) { connection = item; items = []; targets = []; total = 0; loaded = false; error = ""; problems = []; reviewed.checked = false; target.currentIndex = 0; open(); load() }
    function load() { rpc.call("connections.uses", { id: connection.id }, value => { if (value.error) { uses.error = String(value.error); return } uses.items = value.uses || []; uses.targets = value.targets || []; uses.total = value.total || 0; uses.loaded = true }) }
    RpcClient { id: rpc; endpoint: uses.app; scope: uses.connection.id || "" }
    CText { text: "Remove " + (uses.connection.name || "this account") + "?"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
    CText { objectName: "usesSummary"; text: !uses.loaded ? uses.error ? "" : "Looking at what uses it…" : uses.total ? (uses.total === 1 ? "1 thing uses" : uses.total + " things use") + " this account. It can be removed once nothing does." : "Nothing uses this account. Its saved credential is removed with it."; color: Theme.muted; font.pixelSize: Theme.secondary }
    Repeater {
        model: uses.items
        ColumnLayout {
            id: row
            required property var modelData
            required property int index
            Layout.fillWidth: true; spacing: 0
            CText { objectName: "usesItem_" + row.index; text: (uses.kinds[row.modelData.kind] || "Setting") + " · " + row.modelData.label + (row.modelData.detail && row.modelData.detail !== uses.kinds[row.modelData.kind] ? " · " + row.modelData.detail : ""); font.pixelSize: Theme.secondary; elide: Text.ElideRight; wrapMode: Text.NoWrap; Layout.fillWidth: true }
            CText { visible: !!row.modelData.where; text: row.modelData.where || ""; color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        }
    }
    CText { visible: uses.total > uses.items.length; text: "and " + (uses.total - uses.items.length) + " more"; color: Theme.muted; font.pixelSize: Theme.caption }
    ColumnLayout {
        visible: uses.movable > 0 && uses.targets.length > 0
        Layout.fillWidth: true; spacing: Theme.space2
        SectionLabel { text: "MOVE THEM" }
        CComboBox { id: target; objectName: "usesTarget"; Layout.fillWidth: true; model: uses.targets; textRole: "name"; valueRole: "id"; Accessible.name: "Account to move them to" }
        CText { text: "Each conversation keeps its readable history and sends it to the chosen account with its next message. What only the old account could read is left behind."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        CCheckBox { id: reviewed; objectName: "usesReviewed"; text: "Send their history to this account from now on" }
        CButton {
            objectName: "usesMove"; text: rpc.busy ? "Moving…" : "Move " + uses.movable + (uses.movable === 1 ? " thing" : " things"); enabled: !rpc.busy && reviewed.checked && target.currentIndex >= 0
            onClicked: { uses.error = ""; uses.problems = []; rpc.call("connections.reassign", { id: uses.connection.id, to: uses.targets[target.currentIndex].id, reviewed: true }, value => { if (value.error) { uses.error = String(value.error); return } uses.problems = value.problems || []; reviewed.checked = false; uses.moved(); uses.load() }) }
        }
    }
    CText { objectName: "usesNoTarget"; visible: uses.loaded && uses.movable > 0 && !uses.targets.length; text: "There is no other account of this provider to move them to. Add one first, or delete what uses this one."; color: Theme.amber; font.pixelSize: Theme.secondary }
    Repeater { model: uses.problems; CText { required property var modelData; text: modelData; color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true } }
    CText { objectName: "usesError"; visible: !!uses.error; text: uses.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    footerContent: RowLayout {
        spacing: Theme.space2
        Item { Layout.fillWidth: true }
        CButton { text: "Cancel"; onClicked: uses.close() }
        CButton { objectName: "usesRemove"; text: "Remove"; danger: true; enabled: uses.loaded && uses.total === 0 && !rpc.busy; onClicked: rpc.call("connections.remove", { id: uses.connection.id }, value => { if (value.error) { uses.error = String(value.error); uses.load(); return } uses.removed(); uses.close() }) }
    }
}
