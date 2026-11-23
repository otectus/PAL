import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Changes: every change set of the conversation and the full review of one. A review shows
// each operation, its diff or folder summary and its precondition; Accept is disabled whenever the
// review is incomplete, stale, expired or retired. Added and removed lines carry text markers, not color alone.
Item {
    id: review
    objectName: "changeReview"
    implicitHeight: review.detail ? Math.max(Theme.compactPane, reviewLayout.implicitHeight) : reviewLayout.implicitHeight
    property string sessionId: ""
    property var sets: []
    property var detail: null
    property var selected: ({})
    property string error: ""
    property string notice: ""
    property bool working: false
    RpcClient { id: rpc; scope: review.sessionId }
    readonly property var labels: ({ added: "Added", changed: "Changed", folder: "New folder", copied: "Copied", moved: "Moved", trashed: "Moved to trash", removed: "Removed folder", restored: "Restored" })
    readonly property var statusLabels: ({ pending: "Waiting for review", applying: "Applying", applied: "Applied", partial: "Partly applied", failed: "Not applied", declined: "Declined", expired: "Expired", revoked: "Retired: permissions changed", unknown: "Outcome unknown" })
    function refresh() {
        if (!sessionId) { sets = []; detail = null; return }
        rpc.call("changes.list", { sessionId: sessionId }, value => {
            if (value.error) { error = value.error; return }
            sets = value
            const wanted = WorkbenchState.changeSetFor(sessionId) || (sets.find(s => s.status === "pending") || sets[0] || {}).id
            if (wanted) open(wanted)
        })
    }
    function open(id) {
        if (WorkbenchState.changeSetFor(sessionId) !== id) { WorkbenchState.setReview(sessionId, id); return }
        rpc.call("changes.review", { id: id }, value => {
            if (WorkbenchState.changeSetFor(sessionId) !== id) return
            if (value.error) { error = value.error; return }
            error = ""; detail = value
            const all = {}; for (const op of value.operations) all[op.index] = true; selected = all
        })
    }
    function chosen() { return detail ? detail.operations.filter(op => selected[op.index]).map(op => op.index) : [] }
    function toggle(index, on) {
        // Selecting an operation selects what it needs; clearing one clears what needs it.
        const next = Object.assign({}, selected), ops = detail.operations
        const need = i => { next[i] = true; for (const d of ops[i].dependsOn) need(d) }
        const drop = i => { next[i] = false; for (const op of ops) if (op.dependsOn.indexOf(i) >= 0 && next[op.index]) drop(op.index) }
        if (on) need(index); else drop(index)
        selected = next
    }
    function accept(all) {
        working = true; notice = ""; error = ""
        const params = { id: detail.id, digest: detail.digest }
        if (!all) params.operations = chosen()
        rpc.call("changes.apply", params, value => {
            working = false
            if (value.error) { error = value.error; return }
            notice = value.decided ? "Accepted; the conversation applies it and reports each result." : (statusLabels[value.status] || value.status)
            Qt.callLater(() => { open(detail.id); refresh() })
        })
    }
    function decline() { working = true; rpc.call("changes.decline", { id: detail.id }, value => { working = false; if (value.error) error = value.error; else { open(detail.id); refresh() } }) }
    function undo() { working = true; rpc.call("changes.undo", { id: detail.id }, value => { working = false; if (value.error) error = value.error; else { notice = (value.conflicts || []).join("\n"); refresh(); open(value.id) } }) }
    onSessionIdChanged: { sets = []; detail = null; selected = ({}); error = ""; notice = ""; working = false; refresh() }
    Component.onCompleted: refresh()
    Connections { target: WorkbenchState; function onReviewsChanged() { const wanted = WorkbenchState.changeSetFor(review.sessionId); if (wanted && (!review.detail || review.detail.id !== wanted)) review.open(wanted) } }
    Connections { target: App; function onStateChanged() { const pending = (App.state.workbench?.pendingChanges || []).filter(p => p.sessionId === review.sessionId).length; if (pending !== review.pendingCount) { review.pendingCount = pending; review.refresh() } } }
    property int pendingCount: -1

    ColumnLayout {
        id: reviewLayout
        anchors.fill: parent; spacing: Theme.space2
        CText { visible: !review.sets.length; Layout.maximumWidth: review.width; text: "No changes yet. Changes PAL proposes, and edits you make in Preview, appear here for review."; color: Theme.muted }
        CComboBox {
            objectName: "changeSetPicker"; visible: review.sets.length > 0; Layout.fillWidth: true
            model: review.sets.map(s => (review.statusLabels[s.status] || s.status) + " · " + (s.reason || "Change") + " · " + s.totals.operations + " operation" + (s.totals.operations === 1 ? "" : "s"))
            currentIndex: Math.max(0, review.sets.findIndex(s => review.detail && s.id === review.detail.id))
            Accessible.name: "Change set"
            onActivated: index => review.open(review.sets[index].id)
        }
        ColumnLayout {
            visible: !!review.detail; Layout.fillWidth: true; spacing: Theme.space1
            CText { objectName: "changeReason"; text: review.detail ? (review.detail.reason || "Change") : ""; font.weight: Font.DemiBold }
            CText { objectName: "changeStatus"; text: review.detail ? (review.statusLabels[review.detail.status] || review.detail.status) + " · proposed by " + (review.detail.origin === "model" ? App.assistantName : review.detail.origin === "undo" ? "Undo" : "you") + " · " + review.detail.totals.operations + " operation(s), " + review.detail.totals.bytes + " bytes of new text" : ""; color: Theme.muted; font.pixelSize: Theme.secondary }
            CText { objectName: "changeBlocked"; visible: !!review.detail && !!review.detail.blockedBecause && review.detail.status === "pending"; text: review.detail ? (review.detail.blockedBecause || "") : ""; color: Theme.amber; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
            CText { visible: !!review.notice; text: review.notice; color: Theme.accentText; font.pixelSize: Theme.secondary }
            CText { visible: !!review.error; text: review.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        }
        ListView {
            id: ops; objectName: "changeOperations"
            visible: !!review.detail; Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorMedium; clip: true; spacing: Theme.space2
            ScrollBar.vertical: CScrollBar {}
            model: review.detail ? review.detail.operations : []
            delegate: ColumnLayout {
                id: opRow
                required property var modelData; required property int index
                width: ops.width - Theme.space3; spacing: Theme.space1
                property bool expanded: (modelData.review.diff || "").length > 0 && index < 6
                GridLayout {
                    Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: opRow.width; Layout.maximumWidth: opRow.width; rowSpacing: Theme.space1; columnSpacing: Theme.space2
                    readonly property bool compact: ops.width < Theme.toolbarBreakpoint
                    columns: compact ? 2 : 5
                    CCheckBox {
                        objectName: "changeSelect_" + index; Layout.row: 0; Layout.column: 0; Layout.fillWidth: false; implicitWidth: Theme.compactHeight
                        visible: !!review.detail && review.detail.approvable
                        checked: !!review.selected[opRow.modelData.index]
                        Accessible.name: "Include " + (review.labels[opRow.modelData.label] || opRow.modelData.label) + " " + opRow.modelData.path
                        onToggled: review.toggle(opRow.modelData.index, checked)
                    }
                    Rectangle {
                        Layout.row: 0; Layout.column: 1
                        radius: Theme.radiusChip; color: Theme.raised; border.color: Theme.border
                        implicitWidth: chip.implicitWidth + Theme.space3; implicitHeight: chip.implicitHeight + Theme.space2
                        CText { id: chip; anchors.centerIn: parent; width: implicitWidth; text: review.labels[opRow.modelData.label] || opRow.modelData.label; font.pixelSize: Theme.caption }
                    }
                    CText { Layout.row: parent.compact ? 1 : 0; Layout.column: parent.compact ? 0 : 2; Layout.columnSpan: parent.compact ? 2 : 1; Layout.fillWidth: true; text: (opRow.modelData.from ? opRow.modelData.from + "  →  " : "") + opRow.modelData.path; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; font.family: Theme.mono; font.pixelSize: Theme.secondary }
                    CText { Layout.row: parent.compact ? 2 : 0; Layout.column: parent.compact ? 0 : 3; Layout.fillWidth: parent.compact; visible: opRow.modelData.outcome.state !== "pending"; text: opRow.modelData.outcome.state === "committed" ? "done" : opRow.modelData.outcome.state; color: opRow.modelData.outcome.state === "committed" ? Theme.success : opRow.modelData.outcome.state === "skipped" ? Theme.muted : Theme.danger; font.pixelSize: Theme.caption }
                    CButton { Layout.row: parent.compact ? 2 : 0; Layout.column: parent.compact ? 1 : 4; Layout.alignment: Qt.AlignRight; visible: (opRow.modelData.review.diff || "").length > 0; quiet: true; implicitHeight: Theme.compactHeight; text: opRow.expanded ? "Hide diff" : "Show diff"; onClicked: opRow.expanded = !opRow.expanded }
                }
                Repeater { model: opRow.modelData.review.notes || []; CText { required property string modelData; Layout.leftMargin: Theme.fieldActionInset; text: modelData; color: Theme.muted; font.pixelSize: Theme.caption } }
                CText { visible: !!opRow.modelData.review.whitespace; Layout.leftMargin: Theme.fieldActionInset; text: "Whitespace-only change"; color: Theme.amber; font.pixelSize: Theme.caption }
                CText { visible: !!opRow.modelData.outcome.message; Layout.leftMargin: Theme.fieldActionInset; text: opRow.modelData.outcome.message || ""; color: opRow.modelData.outcome.state === "committed" ? Theme.muted : Theme.danger; font.pixelSize: Theme.caption }
                Rectangle {
                    visible: opRow.expanded; Layout.fillWidth: true; Layout.leftMargin: Theme.fieldActionInset
                    implicitHeight: diffColumn.implicitHeight + Theme.space3; radius: Theme.radiusControl; color: Theme.codeSurface; border.color: Theme.subtle
                    Column {
                        id: diffColumn; x: Theme.space2; y: Theme.space2; width: parent.width - Theme.space3
                        Repeater {
                            model: opRow.expanded ? (opRow.modelData.review.diff || "").split("\n").slice(2) : []
                            Text {
                                required property string modelData
                                width: diffColumn.width; wrapMode: Text.WrapAnywhere; textFormat: Text.PlainText; font.family: Theme.mono; font.pixelSize: Theme.caption
                                readonly property string sign: modelData.charAt(0)
                                text: (sign === "+" ? "+ added   " : sign === "-" ? "- removed " : modelData.startsWith("@@") ? "          " : "          ") + (modelData.startsWith("@@") ? modelData : modelData.slice(1)).replace(/\t/g, "→   ").replace(/ +$/, m => "·".repeat(m.length))
                                color: sign === "+" ? Theme.success : sign === "-" ? Theme.danger : modelData.startsWith("@@") ? Theme.accentText : Theme.text
                            }
                        }
                    }
                }
            }
        }
        Flow {
            visible: !!review.detail; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: review.width; Layout.maximumWidth: review.width; spacing: Theme.space2
            CButton { objectName: "changeAcceptAll"; visible: !!review.detail && review.detail.status === "pending"; text: "Accept all"; primary: true; enabled: !!review.detail && review.detail.approvable && !review.working && App.connected; onClicked: review.accept(true) }
            CButton { objectName: "changeAcceptSelected"; visible: !!review.detail && review.detail.status === "pending"; text: "Accept selected (" + review.chosen().length + ")"; enabled: !!review.detail && review.detail.approvable && !review.working && review.chosen().length > 0 && review.chosen().length < review.detail.operations.length; onClicked: review.accept(false) }
            CButton { objectName: "changeReject"; visible: !!review.detail && review.detail.status === "pending"; text: "Reject"; danger: true; enabled: !review.working; onClicked: review.decline() }
            CButton { objectName: "changeUndo"; visible: !!review.detail && ["applied", "partial"].indexOf(review.detail.status) >= 0; text: "Undo…"; enabled: !review.working; help: "Prepares the reverse changes for review; nothing newer is overwritten"; onClicked: review.undo() }
        }
    }
}
