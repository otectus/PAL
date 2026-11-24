pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Runs › Analysis session: a Python namespace that stays between cells until it is stopped. It shows what it
// holds, and says plainly that a result can depend on earlier cells; a notebook of it starts clean.
CSection {
    id: lab
    objectName: "analysisSession"
    title: "Analysis session"
    expanded: false
    Layout.fillWidth: true
    description: "Python that keeps its variables between cells, for exploring step by step. Isolated like Code Lab: no network, only the files you give it. Its state is not saved."
    property string sessionId: ""
    property var rpcEndpoint: null
    property var status: ({})
    property var last: null
    property var files: []
    property string problem: ""
    property string notice: ""
    property var runningId: ""
    readonly property var current: status.session || null
    readonly property bool busy: current?.state === "running" || !!runningId
    signal notebookReady(var spec)
    signal ran()
    signal settingsRequested(string category, string target)
    RpcClient { id: rpc; endpoint: lab.rpcEndpoint; scope: lab.sessionId }
    function failed(value) { if (!value.error) return false; problem = String(value.error.message || value.error); return true }
    function take(value) { if (value.error) { problem = String(value.error.message || value.error); refresh() } else { status = value; if (value.session) expanded = true } }
    function refresh() {
        if (!sessionId) return
        rpc.call("codelab.session", { sessionId: sessionId }, value => { if (!value.error) { status = value; if (value.session) expanded = true } })
    }
    function loadFiles() { rpc.call("artifacts.list", { sessionId: sessionId, limit: 60 }, value => { if (!value.error) files = (value.artifacts || []).filter(item => !/^(audio|video)\//.test(item.mime || "")) }) }
    function act(method, params, message) { problem = ""; notice = ""; rpc.call("codelab." + method, Object.assign({ sessionId: sessionId }, params || {}), value => { lab.take(value); if (!value.error && message) notice = message }) }
    function run() {
        if (busy || !code.text.trim()) return
        problem = ""; notice = ""; last = null
        const params = { sessionId: sessionId, code: code.text, timeoutSeconds: minutes.value * 60 }
        if (addFile.currentIndex > 0) params.inputs = [{ artifactId: files[addFile.currentIndex - 1].id }]
        rpc.call("codelab.sessionRun", params, value => { if (lab.failed(value)) { refresh(); return } runningId = value.operationId; addFile.currentIndex = 0; lab.ran() })
    }
    Timer {
        interval: 450; repeat: true; running: !!lab.runningId && lab.visible
        onTriggered: rpc.call("operations.get", { id: lab.runningId }, value => {
            if (!lab.runningId || value.error && !value.operationId) { if (value.error) { lab.problem = String(value.error.message || value.error); lab.runningId = "" } return }
            lab.last = value
            if (["queued", "running", "cancel_requested"].includes(value.state)) return
            lab.runningId = ""; lab.refresh(); lab.loadFiles(); lab.ran()
            if (value.state === "completed") { history.unshift(code.text); history = history.slice(0, 30); code.clear() }
        })
    }
    property var history: []
    onSessionIdChanged: { status = ({}); last = null; problem = ""; notice = ""; runningId = ""; history = []; refresh(); loadFiles() }
    onExpandedChanged: if (expanded) { refresh(); loadFiles() }
    Component.onCompleted: { refresh(); loadFiles() }
    CText { objectName: "sessionOff"; visible: lab.status.available === false; text: "Code Lab is turned off. It runs analysis sessions too."; color: Theme.amber; font.pixelSize: Theme.secondary }
    CButton { visible: lab.status.available === false; text: "Open Code Lab settings"; onClicked: lab.settingsRequested("connections", "workbench") }
    CText { objectName: "sessionEnded"; visible: !lab.current && !!lab.status.ended; text: lab.status.ended?.reason || ""; color: Theme.muted; font.pixelSize: Theme.secondary }
    CText { objectName: "sessionProblem"; visible: !!lab.problem; text: lab.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    CText { objectName: "sessionNotice"; visible: !!lab.notice && !lab.problem; text: lab.notice; color: Theme.accentText; font.pixelSize: Theme.secondary; Accessible.role: Accessible.StatusBar }
    CButton { objectName: "sessionStart"; visible: !lab.current && lab.status.available === true; text: rpc.busy ? "Starting…" : "Start a session"; primary: true; enabled: !rpc.busy; onClicked: lab.act("sessionStart", {}) }
    ColumnLayout {
        visible: !!lab.current; Layout.fillWidth: true; spacing: Theme.space2
        CText { objectName: "sessionState"; Layout.fillWidth: true; color: Theme.muted; font.pixelSize: Theme.secondary
            text: lab.current ? (lab.busy ? "Running a cell" : "Ready") + " · " + (lab.current.cells.length === 1 ? "1 cell" : lab.current.cells.length + " cells") + " since " + new Date(lab.current.started).toLocaleTimeString(Qt.locale(), Locale.ShortFormat) + " · ends after " + lab.status.limits.idleMinutes + " minutes without use" : "" }
        CText { objectName: "sessionDepends"; visible: (lab.current?.sinceClear || 0) > 0; text: "A result here can depend on earlier cells. Make a notebook to check that it holds from a clean start."; color: Theme.amber; font.pixelSize: Theme.caption }
        ScrollView {
            Layout.fillWidth: true; Layout.preferredHeight: Theme.editorShort; clip: true
            CTextArea { id: code; objectName: "sessionCode"; font.family: Theme.mono; font.pixelSize: Theme.secondary; textFormat: TextEdit.PlainText; wrapMode: TextEdit.NoWrap; selectByMouse: true; placeholderText: "import pandas as pd\nframe = pd.read_csv(inputs[0])\nframe.describe()"; Accessible.name: "Python for the next cell"
                Keys.onPressed: event => {
                    if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && event.modifiers & (Qt.ControlModifier | Qt.ShiftModifier)) { lab.run(); event.accepted = true }
                    else if (event.key === Qt.Key_Up && event.modifiers & Qt.ControlModifier && lab.history.length) { text = lab.history[0]; event.accepted = true }
                    else if (event.key === Qt.Key_Tab && !(event.modifiers & Qt.ShiftModifier) && selectedText.length === 0 && cursorPosition > 0 && /(^|\n)[ ]*$/.test(text.slice(0, cursorPosition))) { insert(cursorPosition, "    "); event.accepted = true }
                } }
        }
        GridLayout {
            Layout.fillWidth: true; columns: width < Theme.toolbarBreakpoint ? 1 : 2; columnSpacing: Theme.space2; rowSpacing: Theme.space2
            CComboBox { id: addFile; objectName: "sessionFile"; Layout.fillWidth: true; model: ["No new file"].concat(lab.files.map(item => "Add " + item.name)); Accessible.name: "File to add to the session" }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space2
                CText { Layout.fillWidth: false; text: "Time limit, minutes"; color: Theme.muted; font.pixelSize: Theme.secondary; wrapMode: Text.NoWrap }
                CSpinBox { id: minutes; from: 1; to: 10; value: 1; Accessible.name: "Time limit in minutes" }
                Item { Layout.fillWidth: true }
            }
        }
        Flow {
            Layout.fillWidth: true; spacing: Theme.space1
            CButton { objectName: "sessionRun"; text: "Run cell"; iconName: "play"; primary: true; help: "Ctrl+Enter"; visible: !lab.busy; enabled: code.text.trim().length > 0 && !rpc.busy; onClicked: lab.run() }
            CButton { objectName: "sessionStopCell"; text: "Stop cell"; iconName: "stop"; danger: true; visible: lab.busy; onClicked: rpc.call("codelab.sessionInterrupt", { sessionId: lab.sessionId }, value => lab.failed(value)) }
            CButton { objectName: "sessionNotebook"; text: "Make a notebook"; enabled: !lab.busy && (lab.current?.cells || []).some(cell => cell.state === "completed"); onClicked: rpc.call("codelab.sessionNotebook", { sessionId: lab.sessionId }, value => { if (lab.failed(value)) return; lab.notice = "The notebook is ready in Code Lab. It starts clean each time it runs." + (value.skipped ? " Cells that did not finish were left out." : ""); lab.notebookReady(value) }) }
            CButton { objectName: "sessionClear"; text: "Clear variables"; enabled: !lab.busy; onClicked: confirm.ask("Clear every variable?", "The session keeps running with the same files. Its cells stay in Run history.", "Clear variables", () => lab.act("sessionClear", {}, "Every variable was cleared.")) }
            CButton { objectName: "sessionRestart"; text: "Restart"; enabled: !rpc.busy; onClicked: confirm.ask("Restart the session?", "Variables and files it made are lost. The files you gave it stay available.", "Restart", () => lab.act("sessionRestart", {}, "The session started again.")) }
            CButton { objectName: "sessionStop"; text: "Stop session"; danger: true; enabled: !rpc.busy; onClicked: confirm.ask("Stop the session?", "Its variables are lost. Results and code stay in Run history.", "Stop session", () => lab.act("sessionStop", {})) }
        }
        // ── What the last cell said ──────────────────────────────────────────────────────────────
        Rectangle {
            visible: !!lab.last; Layout.fillWidth: true; implicitHeight: outcome.implicitHeight + Theme.space2 * 2; color: Theme.codeSurface; radius: Theme.radiusControl
            ColumnLayout {
                id: outcome
                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: Theme.space2; spacing: Theme.space1
                CText { text: ({ completed: "Finished", failed: "Failed", cancelled: "Stopped", interrupted: "Stopped", running: "Running", queued: "Starting", cancel_requested: "Stopping" })[lab.last?.state || ""] || ""; color: lab.last?.state === "failed" ? Theme.danger : Theme.muted; font.pixelSize: Theme.caption }
                ScrollView {
                    visible: output.text.length > 0; Layout.fillWidth: true; Layout.preferredHeight: Math.min(Theme.editorMedium, output.implicitHeight); clip: true
                    TextEdit { id: output; objectName: "sessionOutput"; readOnly: true; selectByMouse: true; textFormat: TextEdit.PlainText; color: Theme.text; font.family: Theme.mono; font.pixelSize: Theme.caption; wrapMode: TextEdit.NoWrap
                        text: (String(lab.last?.details?.stdout || "").slice(-12000) + (lab.last?.details?.stderr ? "\n" + String(lab.last.details.stderr).slice(-6000) : "")).trim(); Accessible.name: "Output of the last cell" }
                }
                CText { visible: !!lab.last?.details?.outputNote; text: lab.last?.details?.outputNote || ""; color: Theme.amber; font.pixelSize: Theme.caption }
                Repeater { model: lab.last?.state === "completed" ? lab.last.results || [] : []; ArtifactCard { required property var modelData; Layout.fillWidth: true; reference: modelData; sessionId: lab.sessionId } }
            }
        }
        // ── What it holds ────────────────────────────────────────────────────────────────────────
        CText { text: "Variables · " + (lab.current?.variables || []).length; font.weight: Font.DemiBold; font.pixelSize: Theme.secondary }
        CText { visible: !(lab.current?.variables || []).length; text: "None yet."; color: Theme.muted; font.pixelSize: Theme.secondary }
        ListView {
            id: variables; objectName: "sessionVariables"
            visible: count > 0; Layout.fillWidth: true; Layout.preferredHeight: Math.min(Theme.editorMedium, contentHeight); clip: true; boundsBehavior: Flickable.StopAtBounds; activeFocusOnTab: true
            ScrollBar.vertical: CScrollBar {}
            model: lab.current?.variables || []
            delegate: RowLayout {
                required property var modelData
                width: variables.width - Theme.space3; spacing: Theme.space2
                CText { Layout.preferredWidth: Theme.fieldShort; Layout.fillWidth: false; text: parent.modelData.name; font.family: Theme.mono; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                CText { Layout.preferredWidth: Theme.fieldShort; Layout.fillWidth: false; text: parent.modelData.type; color: Theme.accentText; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                CText { Layout.fillWidth: true; text: parent.modelData.detail; color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            }
        }
        CText { visible: (lab.current?.inputs || []).length > 0; text: "Files: " + (lab.current?.inputs || []).map((input, index) => "inputs[" + index + "] " + input.name).join(" · "); color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.WrapAnywhere }
    }
    CDialog {
        id: confirm; objectName: "sessionConfirm"
        property string heading: ""
        property string detail: ""
        property string action: ""
        property var then: null
        function ask(heading, detail, action, then) { confirm.heading = heading; confirm.detail = detail; confirm.action = action; confirm.then = then; open() }
        CText { text: confirm.heading; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: confirm.detail; color: Theme.muted; font.pixelSize: Theme.secondary }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: confirm.close() }
            CButton { objectName: "sessionConfirmYes"; text: confirm.action; danger: true; Layout.fillWidth: true; onClicked: { confirm.close(); if (confirm.then) confirm.then() } }
        }
    }
}
