pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Which remembered things are the same. A decision joins or separates them in recall and keeps the person's own words as
// its witness; nothing is rewritten, so undoing it puts recall back exactly as it was.
CDialog {
    id: decisions
    objectName: "identityDecisions"
    preferredWidth: Theme.dialogWide
    property string sessionId: ""
    property var left: null
    property var right: null
    property var found: []
    property var list: []
    property string choosing: ""
    property string error: ""
    property string notice: ""
    readonly property var labels: ({ same: "the same", not_same: "different", possible: "possibly the same" })
    RpcClient { id: rpc; scope: decisions.sessionId + "|" + decisions.opened }
    function failed(value) { if (!value.error) return false; error = String(value.error.message || value.error); return true }
    function openFor(session, entity) { sessionId = session; left = entity || null; right = null; found = []; list = []; error = ""; notice = ""; choosing = entity ? "right" : "left"; search.clear(); statement.clear(); open(); refresh(); find() }
    function refresh() { rpc.call("memory.graph", { sessionId: sessionId, method: "identity_list", params: {} }, value => { if (!decisions.failed(value)) list = value.decisions || [] }) }
    function find() { rpc.call("memory.list", { sessionId: sessionId, kind: "entities", filter: search.text.trim() }, value => { if (decisions.failed(value)) return; found = (value.rows || value.items || []).filter(row => choosing !== "right" || !left || (row.id !== left.id && row.type === left.type)) }) }
    function pick(row) { if (choosing === "left") { left = row; choosing = "right" } else { right = row; choosing = "" } search.clear(); find() }
    function decide() {
        error = ""; notice = ""
        const decision = ["same", "not_same", "possible"][choice.currentIndex]
        rpc.call("memory.identityDecide", { sessionId: sessionId, leftId: left.id, rightId: right.id, decision: decision, statement: statement.text.trim() }, value => {
            if (decisions.failed(value)) return
            notice = decision === "possible" ? "Noted for review. Recall is unchanged." : "Recall now treats them as " + labels[decision] + "."
            right = null; choosing = "right"; statement.clear(); refresh(); find()
        })
    }
    function undo(row) { error = ""; notice = ""; rpc.call("memory.graph", { sessionId: sessionId, method: "identity", params: { revert_id: row.id, expected_revision: row.revision } }, value => { if (decisions.failed(value)) { refresh(); return } notice = "Undone. Recall is as it was before."; refresh() }) }
    Timer { id: searchSoon; interval: 220; onTriggered: decisions.find() }
    CText { text: "Same or different?"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
    CText { text: "Say whether two remembered things are the same. Their facts and sources stay as they are; only recall changes, and a decision can be undone."; color: Theme.muted; font.pixelSize: Theme.secondary }
    GridLayout {
        Layout.fillWidth: true; columns: width < Theme.formBreakpoint ? 1 : 2; columnSpacing: Theme.space2; rowSpacing: Theme.space2
        Repeater {
            model: ["left", "right"]
            CButton {
                required property string modelData
                readonly property var entity: modelData === "left" ? decisions.left : decisions.right
                objectName: "identity_" + modelData; Layout.fillWidth: true; alignLeft: true; primary: decisions.choosing === modelData
                text: entity ? entity.text + " · " + entity.type : modelData === "left" ? "Choose the first" : "Choose the second"
                enabled: modelData === "left" || !!decisions.left
                onClicked: { decisions.choosing = modelData; decisions.find() }
            }
        }
    }
    CField { id: search; objectName: "identitySearch"; visible: !!decisions.choosing; Layout.fillWidth: true; placeholderText: "Find a project, tool, person or other remembered thing"; Accessible.name: "Find a remembered thing"; onTextChanged: searchSoon.restart() }
    Flow {
        visible: !!decisions.choosing; Layout.fillWidth: true; spacing: Theme.space1
        Repeater { model: decisions.found.slice(0, 12); CButton { required property var modelData; required property int index; objectName: "identityFound_" + index; text: modelData.text + " · " + modelData.type; quiet: true; implicitHeight: Theme.compactHeight; onClicked: decisions.pick(modelData) } }
    }
    CText { objectName: "identityNone"; visible: !!decisions.choosing && !decisions.found.length && !rpc.busy; text: decisions.choosing === "right" && decisions.left ? "No other " + decisions.left.type + " matches." : "Nothing remembered matches."; color: Theme.muted; font.pixelSize: Theme.secondary }
    CComboBox { id: choice; objectName: "identityDecision"; visible: !!decisions.left && !!decisions.right; Layout.fillWidth: true; model: ["They are the same", "They are different", "They might be the same (a note only)"]; Accessible.name: "Decision" }
    CField { id: statement; objectName: "identityStatement"; visible: !!decisions.left && !!decisions.right; Layout.fillWidth: true; maximumLength: 2000; placeholderText: "Why, in your own words"; Accessible.name: "Why, in your own words" }
    CText { objectName: "identityError"; visible: !!decisions.error; text: decisions.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    CText { objectName: "identityNotice"; visible: !!decisions.notice && !decisions.error; text: decisions.notice; color: Theme.accentText; font.pixelSize: Theme.secondary; Accessible.role: Accessible.StatusBar }
    CButton { objectName: "identitySave"; visible: !!decisions.left && !!decisions.right; Layout.fillWidth: true; primary: true; text: "Record the decision"; enabled: !rpc.busy && statement.text.trim().length > 0; onClicked: decisions.decide() }
    CText { visible: decisions.list.length > 0; text: "Decisions"; font.weight: Font.DemiBold }
    ListView {
        id: rows; objectName: "identityList"
        visible: count > 0; Layout.fillWidth: true; Layout.preferredHeight: Math.min(Theme.editorLarge, contentHeight); clip: true; spacing: Theme.space2; boundsBehavior: Flickable.StopAtBounds; activeFocusOnTab: true
        ScrollBar.vertical: CScrollBar {}
        model: decisions.list
        delegate: RowLayout {
            id: row
            required property var modelData
            required property int index
            width: rows.width - Theme.space3; spacing: Theme.space2
            ColumnLayout {
                Layout.fillWidth: true; spacing: 0
                CText { objectName: "identityRow_" + row.index; Layout.fillWidth: true; text: row.modelData.left.name + " and " + row.modelData.right.name + ": " + decisions.labels[row.modelData.decision] + (row.modelData.reverted ? " (undone)" : ""); color: row.modelData.reverted ? Theme.muted : Theme.text; wrapMode: Text.Wrap }
                CText { Layout.fillWidth: true; visible: !!text; text: typeof row.modelData.witness === "string" ? row.modelData.witness : row.modelData.witness?.quote || ""; color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            }
            CButton { objectName: "identityUndo_" + row.index; visible: !row.modelData.reverted; text: "Undo"; implicitHeight: Theme.compactHeight; enabled: !rpc.busy; onClicked: decisions.undo(row.modelData) }
        }
    }
    CButton { text: "Close"; Layout.fillWidth: true; onClicked: decisions.close() }
}
