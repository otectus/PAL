import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Runs: image jobs, analysis runs and commands of this conversation, with their recorded state.
// Cancelling says whether the backend confirmed it; an unknown outcome is shown as unknown, never as a failure.
Item {
    id: runs
    objectName: "runsPane"
    implicitHeight: content.implicitHeight
    property string sessionId: ""
    property var operations: []
    property var partials: ({})
    property string error: ""
    property int requestCycle: 0
    property bool listing: false
    readonly property bool online: App.connected
    onOnlineChanged: if (online && visible) refresh()
    // 11.5: what backends and helpers reported using; never an estimate, and never a billing guarantee.
    property var usage: []
    readonly property string usageText: {
        if (!usage.length) return ""
        const sum = key => usage.reduce((total, row) => total + (Number(row[key]) || 0), 0)
        const images = usage.filter(row => String(row.kind || "").startsWith("image")).length, input = sum("inputTokens") + sum("input_tokens"), output = sum("outputTokens") + sum("output_tokens")
        const helpers = usage.filter(row => String(row.kind || "").startsWith("helper.")).length
        return "Reported use here: " + [images ? images + " image job" + (images === 1 ? "" : "s") : "", helpers ? helpers + " helper call" + (helpers === 1 ? "" : "s") : "", input || output ? input + " input and " + output + " output tokens" : ""].filter(s => s).join(" · ")
            + ". PAL does not estimate prices; your provider’s billing is authoritative."
    }
    readonly property var labels: ({ prepared: "Prepared", awaiting_approval: "Waiting for your approval", queued: "Queued", dispatching: "Sending", running: "Running", cancel_requested: "Cancelling",
        completed: "Complete", failed: "Failed", cancelled: "Cancelled", declined: "Declined", expired: "Expired", interrupted: "Interrupted", unknown: "Outcome unknown" })
    RpcClient { id: rpc; scope: runs.sessionId }
    function refresh() {
        const cycle = ++requestCycle
        if (!sessionId) { listing = false; operations = []; usage = []; partials = ({}); return }
        listing = true
        rpc.call("operations.list", { sessionId: sessionId, limit: 50 }, value => {
            if (cycle !== requestCycle) return
            listing = false
            if (value.error) { error = value.error; return }
            operations = value; error = ""
            rpc.call("operations.usage", { sessionId: sessionId }, rows => { if (cycle === requestCycle) runs.usage = rows.error ? [] : rows })
            for (const op of value) if (["running", "dispatching"].indexOf(op.state) >= 0 && op.kind.startsWith("image.")) rpc.call("operations.partial", { id: op.operationId }, partial => { if (cycle === requestCycle && partial.data) { const next = Object.assign({}, runs.partials); next[op.operationId] = partial.data; runs.partials = next } })
        })
    }
    onSessionIdChanged: { operations = []; usage = []; partials = ({}); error = ""; lastActive = "-"; refresh() }
    Component.onCompleted: refresh()
    Connections { target: App; function onStateChanged() { const active = (App.state.workbench?.activeOperations || []).filter(o => o.sessionId === runs.sessionId).map(o => o.operationId + o.state).join(); if (active !== runs.lastActive) { runs.lastActive = active; runs.refresh() } } }
    property string lastActive: "-"
    Timer { interval: 1500; repeat: true; running: runs.visible && runs.operations.some(op => ["queued", "dispatching", "running", "cancel_requested"].indexOf(op.state) >= 0); onTriggered: runs.refresh() }
    ColumnLayout {
        id: content
        anchors.fill: parent; spacing: Theme.space2
        CodeLab { Layout.fillWidth: true; sessionId: runs.sessionId; onStarted: runs.refresh() }
        CText { visible: !!runs.error; text: runs.error; color: Theme.danger; font.pixelSize: Theme.secondary }
        CText { objectName: "runsUsage"; visible: !!runs.usageText; text: runs.usageText; color: Theme.muted; font.pixelSize: Theme.caption }
        CText { visible: !runs.operations.length && !runs.error; text: runs.listing ? qsTr("Loading runs…") : "Nothing has run in this conversation yet. Image jobs and analysis runs appear here with their results."; color: Theme.muted }
        ListView {
            id: list; objectName: "runsList"
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorShort; clip: true; spacing: Theme.space2
            ScrollBar.vertical: CScrollBar {}
            model: runs.operations
            delegate: Rectangle {
                id: row
                required property var modelData
                width: list.width; implicitHeight: body.implicitHeight + Theme.space4; radius: Theme.radiusControl; color: Theme.surface; border.color: Theme.subtle
                Accessible.role: Accessible.Grouping; Accessible.name: modelData.label + ", " + (runs.labels[modelData.state] || modelData.state)
                ColumnLayout {
                    id: body; x: Theme.space2; y: Theme.space2; width: parent.width - Theme.space4; spacing: Theme.space1
                    RowLayout {
                        Layout.fillWidth: true
                        CText { Layout.fillWidth: true; text: row.modelData.label; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                        CText { Layout.fillWidth: false; text: runs.labels[row.modelData.state] || row.modelData.state; color: row.modelData.state === "completed" ? Theme.success : ["failed", "unknown"].indexOf(row.modelData.state) >= 0 ? Theme.danger : Theme.amber; font.pixelSize: Theme.caption }
                    }
                    CText { text: [row.modelData.backend ? (row.modelData.backend.kind + (row.modelData.backend.model ? " · " + row.modelData.backend.model : "") + " · " + row.modelData.backend.route) : "", row.modelData.origin === "model" ? "started by " + App.assistantName : "started by you", new Date(row.modelData.created).toLocaleTimeString()].filter(s => s).join(" · "); color: Theme.muted; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.progress && (row.modelData.progress.max > 0 || !!row.modelData.progress.note); text: row.modelData.progress ? (row.modelData.progress.max ? "Step " + row.modelData.progress.value + " of " + row.modelData.progress.max : "") + (row.modelData.progress.note ? " " + row.modelData.progress.note : "") : ""; font.pixelSize: Theme.caption }
                    Image { visible: !!runs.partials[row.modelData.operationId] && row.modelData.state !== "completed"; Layout.preferredWidth: Theme.fieldWidth; Layout.maximumWidth: body.width; Layout.preferredHeight: Theme.editorMedium; fillMode: Image.PreserveAspectFit; source: runs.partials[row.modelData.operationId] || ""
                        CText { anchors.bottom: parent.bottom; text: "Preview (provisional)"; font.pixelSize: Theme.caption; color: Theme.amber } }
                    CText { visible: !!row.modelData.error; text: row.modelData.error || ""; color: Theme.danger; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.cancellation; text: row.modelData.cancellation || ""; color: Theme.amber; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.recovery; text: row.modelData.recovery || ""; color: Theme.amber; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.note; text: row.modelData.note || ""; color: Theme.amber; font.pixelSize: Theme.caption }
                    CText { visible: (row.modelData.adjustments || []).length > 0; text: "Adjusted: " + (row.modelData.adjustments || []).join("; "); color: Theme.muted; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.details?.stdout || !!row.modelData.details?.stderr; text: ((row.modelData.details?.stdout || "") + (row.modelData.details?.stderr ? "\n" + row.modelData.details.stderr : "")).slice(0, 4000); font.family: Theme.mono; font.pixelSize: Theme.caption; color: Theme.text }
                    Repeater { model: (row.modelData.results || []).slice(0, 8); ArtifactCard { required property var modelData; Layout.fillWidth: true; reference: modelData; sessionId: runs.sessionId } }
                    Flow {
                        Layout.fillWidth: true; spacing: Theme.space1
                        CButton { objectName: "runCancel"; visible: ["prepared", "awaiting_approval", "queued", "dispatching", "running"].indexOf(row.modelData.state) >= 0; text: "Cancel"; danger: true; implicitHeight: Theme.compactHeight; onClicked: rpc.call("operations.cancel", { id: row.modelData.operationId }, value => { runs.error = value.error || ""; runs.refresh() }) }
                        CButton { objectName: "runCheck"; visible: row.modelData.state === "unknown" && row.modelData.remote && row.modelData.backend?.kind === "comfyui"; text: "Check status"; implicitHeight: Theme.compactHeight; onClicked: rpc.call("operations.check", { id: row.modelData.operationId }, value => { runs.error = value.error || ""; runs.refresh() }) }
                        CButton { objectName: "runRetry"; visible: ["failed", "unknown", "interrupted", "cancelled", "expired"].indexOf(row.modelData.state) >= 0 && row.modelData.kind.startsWith("image."); text: "Try again"; implicitHeight: Theme.compactHeight
                            onClicked: rpc.call("operations.retry", { id: row.modelData.operationId, confirmed: row.modelData.state === "unknown" ? retryConfirm.confirmed : undefined }, value => { if (value.code === "CONFIRM_RETRY") { retryConfirm.operationId = row.modelData.operationId; retryConfirm.open() } else { runs.error = value.error || ""; runs.refresh() } }) }
                    }
                }
            }
        }
    }
    CDialog {
        id: retryConfirm
        property string operationId: ""
        property bool confirmed: false
        CText { text: "Send a new request?"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: "The earlier request’s outcome is unknown: it may have finished, and it may have been billed. Trying again sends a new request." }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: retryConfirm.close() }
            CButton { text: "Send again"; primary: true; onClicked: { retryConfirm.close(); rpc.call("operations.retry", { id: retryConfirm.operationId, confirmed: true }, value => { runs.error = value.error || ""; runs.refresh() }) } } }
    }
}
