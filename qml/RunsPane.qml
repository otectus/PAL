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
    property var rpcEndpoint: null
    property var operations: []
    property var partials: ({})
    property string error: ""
    property int requestCycle: 0
    property bool listing: false
    property bool history: false
    property bool projectHistory: false
    property string query: ""
    property string kindFilter: ""
    property string stateFilter: ""
    property var selected: null
    property var baselineRun: null
    property var selectedResult: null
    property string timeRange: ""
    property bool groupRelated: false
    readonly property var visibleRows: {
        if (!groupRelated) return operations
        const groups = new Set()
        return operations.filter(op => { const key=op.groupId || op.turnId || operationId(op); if (groups.has(key)) return false; groups.add(key); return true })
    }
    property string historyBefore: ""
    property string historyNext: ""
    property int exploreCycle: 0
    property int detailActionCycle: 0
    property var detailImages: []
    readonly property bool online: rpcEndpoint ? rpcEndpoint.connected : App.connected
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
    RpcClient { id: rpc; endpoint: runs.rpcEndpoint; scope: runs.sessionId }
    signal settingsRequested(string category, string target)
    signal workflowsRequested()
    function openPane(pane) { WorkbenchState.tab = pane }
    function receiveAnalysisTarget() {
        const target = WorkbenchState.analysisTarget
        if (!visible || !target || target.sessionId !== sessionId) return
        WorkbenchState.analysisTarget = null
        if (target.edit && target.operationId) labEditor.openRun(target.operationId)
        else if (target.operationId) openDetail({operationId: target.operationId})
        else if (target.analysisId) rpc.call("codelab.load", {sessionId: sessionId, id: target.analysisId}, value => {
            if (value.error) error = value.error
            else labEditor.apply(value)
        })
        else {
            labEditor.open = true
            const next = labEditor.chosen.slice()
            for (const ref of target.inputs || []) {
                if (!next.some(r => r.artifactId === ref.artifactId && r.versionId === ref.versionId))
                    next.push({artifactId: ref.artifactId, versionId: ref.versionId})
            }
            if (next.length > 8) labEditor.error = "Remove an input first. An analysis can use up to eight files."
            else labEditor.chosen = next
            labEditor.refresh()
        }
    }
    Connections { target: WorkbenchState; function onAnalysisTargetChanged() { Qt.callLater(runs.receiveAnalysisTarget) } }
    onVisibleChanged: if (visible) Qt.callLater(receiveAnalysisTarget)
    function operationId(op) { return op.operationId || op.id || "" }
    function operationSessionName(op) {
        if (!op?.sessionId) return ""
        if (op.sessionId === App.selectedId) return App.session?.title || "This conversation"
        const session = (App.state?.sessions || []).find(item => item.id === op.sessionId)
        return session?.title || op.sessionId
    }
    function detailLimits(op) {
        const limits = op?.details?.limits
        if (!limits || typeof limits !== "object") return ""
        return Object.entries(limits).map(item => item[0] + ": " + item[1]).join(" · ")
    }
    function openChangedFile(path) {
        const rootId = selected?.witness?.root, owner = selected?.sessionId
        if (!rootId || !owner || !path) return
        App.selectedId = owner
        WorkbenchState.openFile(owner, rootId, path)
    }
    function openResultImage(reference) {
        const owner = selected?.sessionId || sessionId
        if (!owner || !reference?.artifactId || !reference?.versionId) return
        App.selectedId = owner
        WorkbenchState.selectImage(owner, reference.artifactId, reference.versionId)
        WorkbenchState.show("images")
    }
    function loadDetailImages(op) {
        const cycle = ++detailActionCycle, id = operationId(op), owner = op?.sessionId || ""
        detailImages = []
        if (!id || !owner) return
        for (const reference of op.results || []) {
            if (!reference?.artifactId || !reference?.versionId) continue
            rpc.call("artifacts.get", { sessionId: owner, artifactId: reference.artifactId }, value => {
                if (cycle !== detailActionCycle || operationId(selected) !== id || selected?.sessionId !== owner || value.error) return
                const version = (value.versions || []).find(item => item.versionId === reference.versionId)
                if (!version || !(version.kind === "image" || version.kind === "plot" || /^image\//.test(version.mime || ""))) return
                if (!detailImages.some(item => item.versionId === version.versionId))
                    detailImages = detailImages.concat([{ artifactId: version.artifactId, versionId: version.versionId, name: version.name }])
            })
        }
    }
    function openDetail(op) {
        rpc.call("operations.get", { id: operationId(op) }, value => {
            // A failed run legitimately has an `error` display field. Transport/RPC failures have no operation shape.
            if (value.error && !(value.operationId || value.id || value.kind || value.operation)) { error = value.error; return }
            selected = value.operation || value
            loadDetailImages(selected)
            detailDialog.open()
        })
    }
    function compare(keys, positional) {
        if (!baselineRun || !selected) return
        rpc.call("operations.compare", { sessionId: sessionId, left: operationId(baselineRun), right: operationId(selected), key: keys || undefined, mode: positional ? "position" : undefined }, value => { if (value.error) error = value.error; else { comparison.value = value; comparison.open() } })
    }
    function explore(reference, ownerSessionId) {
        if (!reference || !reference.artifactId) return
        const cycle = ++exploreCycle, sourceSession = ownerSessionId || reference.sessionId || (selected && selected.sessionId) || sessionId, pageSession = sessionId
        selectedResult = Object.assign({}, reference, { sessionId: sourceSession })
        rpc.call("artifacts.get", { sessionId: sourceSession, artifactId: reference.artifactId }, value => {
            if (cycle !== exploreCycle || pageSession !== runs.sessionId) return
            if (value.error) { error = value.error; return }
            const version = (value.versions || []).find(item => item.versionId === reference.versionId) || null
            if (!version) { error = "That output version is no longer available."; return }
            tableDialog.openReference(selectedResult, sourceSession, version, operationId(selected) || version.operationId || "")
        })
    }
    function refresh() {
        const cycle = ++requestCycle
        if (!sessionId) { listing = false; operations = []; usage = []; partials = ({}); return }
        listing = true
        const method = history ? "operations.history" : "operations.list"
        const request = history ? { sessionId: sessionId, project: projectHistory, query: query || undefined, kind: kindFilter || undefined, since: timeRange ? Date.now()-Number(timeRange)*86400000 : undefined, state: stateFilter || undefined, before: historyBefore || undefined } : { sessionId: sessionId, limit: 50 }
        rpc.call(method, request, value => {
            if (cycle !== requestCycle) return
            listing = false
            if (value.error) { error = value.error; return }
            operations = value.operations || value; historyNext = history && operations.length >= 50 ? operations[operations.length - 1].cursor || "" : ""; error = ""
            rpc.call("operations.usage", { sessionId: sessionId }, rows => { if (cycle === requestCycle) runs.usage = rows.error ? [] : rows })
            for (const op of operations) if (["running", "dispatching"].indexOf(op.state) >= 0 && op.kind.startsWith("image.")) rpc.call("operations.partial", { id: operationId(op) }, partial => { if (cycle === requestCycle && partial.data) { const next = Object.assign({}, runs.partials); next[operationId(op)] = partial.data; runs.partials = next } })
        })
    }
    onSessionIdChanged: { operations = []; usage = []; partials = ({}); error = ""; lastActive = "-"; baselineRun = WorkbenchState.runBaselineFor(sessionId); refresh() }
    Component.onCompleted: { refresh(); Qt.callLater(receiveAnalysisTarget) }
    Connections { target: runs.rpcEndpoint || App; function onStateChanged() { const active = ((runs.rpcEndpoint || App).state.workbench?.activeOperations || []).filter(o => o.sessionId === runs.sessionId).map(o => o.operationId + o.state).join(); if (active !== runs.lastActive) { runs.lastActive = active; runs.refresh() } } }
    property string lastActive: "-"
    Timer { interval: 1500; repeat: true; running: runs.visible && runs.operations.some(op => ["queued", "dispatching", "running", "cancel_requested"].indexOf(op.state) >= 0); onTriggered: runs.refresh() }
    Timer {
        interval: 1200; repeat: true
        running: detailDialog.opened && ["queued","running","dispatching","cancel_requested"].includes(runs.selected?.state)
        onTriggered: { const id=runs.operationId(runs.selected); rpc.call("operations.get",{id:id},value=>{if (runs.selected && runs.operationId(runs.selected)===id && value.operationId) runs.selected=value}) }
    }
    ColumnLayout {
        id: content
        anchors.fill: parent; spacing: Theme.space2
        CodeLab { id: labEditor; Layout.fillWidth: true; sessionId: runs.sessionId; rpcEndpoint: runs.rpcEndpoint; onStarted: runs.refresh(); onSettingsRequested:(category,target)=>runs.settingsRequested(category,target); onPaneRequested:pane=>runs.openPane(pane); onWorkflowsRequested:runs.workflowsRequested() }
        CSection { title: "Run history"; expanded: false; Layout.fillWidth: true
            RowLayout { Layout.fillWidth: true
                CCheckBox { id: historyToggle; text: "Search durable history"; checked: runs.history; onToggled: { runs.history = checked; runs.refresh() } }
                CCheckBox { visible: runs.history; text: "This project"; checked: runs.projectHistory; onToggled: { runs.projectHistory = checked; runs.historyBefore = ""; runs.refresh() } }
                Item { Layout.fillWidth: true }
                CButton { visible: runs.history; text: "Refresh"; quiet: true; onClicked: { runs.historyBefore = ""; runs.refresh() } }
            }
            CCheckBox { visible:runs.history; text:"Show latest in each group on this page"; checked:runs.groupRelated; onToggled:runs.groupRelated=checked }
            CField { visible: runs.history; objectName: "runsHistoryQuery"; Layout.fillWidth: true; placeholderText: "Search by purpose or filename"; Accessible.name: "Search run history"; onAccepted: { runs.query = text.trim(); runs.historyBefore = ""; runs.refresh() } }
            RowLayout { visible: runs.history; Layout.fillWidth: true
                CComboBox { id: historyKind; Layout.fillWidth: true; model: [{label:"All kinds",value:""},{label:"Code Lab",value:"codelab.run"},{label:"Research",value:"research"},{label:"Specialists",value:"specialist.run"},{label:"Images",value:"image"},{label:"Commands",value:"command"}]; textRole:"label"; valueRole:"value"; Accessible.name:"Run kind"; onActivated:{runs.kindFilter=currentValue;runs.historyBefore="";runs.refresh()} }
                CComboBox { Layout.fillWidth: true; model:[{label:"Any date",value:""},{label:"Last day",value:"1"},{label:"Last week",value:"7"},{label:"Last month",value:"30"}]; textRole:"label"; valueRole:"value"; Accessible.name:"Run date"; onActivated:{runs.timeRange=currentValue;runs.historyBefore="";runs.refresh()} }
                CComboBox { id: historyState; Layout.fillWidth: true; model: [{label:"All states",value:""},{label:"Complete",value:"completed"},{label:"Failed",value:"failed"},{label:"Running",value:"running"},{label:"Unknown",value:"unknown"}]; textRole:"label"; valueRole:"value"; Accessible.name:"Run state"; onActivated:{runs.stateFilter=currentValue;runs.historyBefore="";runs.refresh()} }
            }
        }
        CText { visible: !!runs.error; text: runs.error; color: Theme.danger; font.pixelSize: Theme.secondary }
        CText { objectName: "runsUsage"; visible: !!runs.usageText; text: runs.usageText; color: Theme.muted; font.pixelSize: Theme.caption }
        RowLayout { visible:runs.history && runs.operations.length>0; Layout.fillWidth:true
            CButton { text:"Newer"; quiet:true; enabled:!!runs.historyBefore; onClicked:{runs.historyBefore="";runs.refresh()} }
            Item { Layout.fillWidth:true }
            CButton { text:"Older"; quiet:true; enabled:!!runs.historyNext; onClicked:{runs.historyBefore=runs.historyNext;runs.refresh()} }
        }
        CText { visible: !runs.operations.length && !runs.error; text: runs.listing ? qsTr("Loading runs…") : runs.history ? "No runs match these filters." : "Try the sample in Code Lab, or run an analysis with files from this conversation."; color: Theme.muted }
        ListView {
            id: list; objectName: "runsList"
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: count ? Theme.editorShort : 0
            Layout.preferredHeight: count ? Math.max(Theme.editorShort, Math.min(600, contentHeight)) : 0
            clip: true; spacing: Theme.space2
            ScrollBar.vertical: CScrollBar {}
            model: runs.visibleRows
            delegate: Rectangle {
                id: row
                required property var modelData
                width: list.width; implicitHeight: body.implicitHeight + Theme.space4; radius: Theme.radiusControl; color: Theme.surface; border.color: Theme.subtle
                Accessible.role: Accessible.Grouping; Accessible.name: modelData.label + ", " + (runs.labels[modelData.state] || modelData.state)
                ColumnLayout {
                    id: body; x: Theme.space2; y: Theme.space2; width: parent.width - Theme.space4; spacing: Theme.space1
                    RowLayout {
                        Layout.fillWidth: true
                        CText { Layout.fillWidth: true; text: row.modelData.kind === "research.run" ? "Research · " + row.modelData.label : row.modelData.label; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                        CText { Layout.fillWidth: false; text: runs.labels[row.modelData.state] || row.modelData.state; color: row.modelData.state === "completed" ? Theme.success : ["failed", "unknown"].indexOf(row.modelData.state) >= 0 ? Theme.danger : Theme.amber; font.pixelSize: Theme.caption }
                    }
                    CText { text: [row.modelData.backend ? (row.modelData.backend.kind + (row.modelData.backend.model ? " · " + row.modelData.backend.model : "") + " · " + row.modelData.backend.route) : "", row.modelData.origin === "model" ? "started by " + App.assistantName : row.modelData.origin === "schedule" ? "scheduled analysis" : row.modelData.origin === "user" ? "started by you" : "", new Date(row.modelData.created).toLocaleTimeString()].filter(s => s).join(" · "); color: Theme.muted; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.progress && (row.modelData.progress.max > 0 || !!row.modelData.progress.note); text: row.modelData.progress ? (row.modelData.progress.max ? "Step " + row.modelData.progress.value + " of " + row.modelData.progress.max : "") + (row.modelData.progress.note ? " " + row.modelData.progress.note : "") : ""; font.pixelSize: Theme.caption }
                    Image { visible: !!runs.partials[row.modelData.operationId] && row.modelData.state !== "completed"; Layout.preferredWidth: Theme.fieldWidth; Layout.maximumWidth: body.width; Layout.preferredHeight: Theme.editorMedium; fillMode: Image.PreserveAspectFit; source: runs.partials[row.modelData.operationId] || ""
                        CText { anchors.bottom: parent.bottom; text: "Preview (provisional)"; font.pixelSize: Theme.caption; color: Theme.amber } }
                    CText { visible: !!row.modelData.error; text: row.modelData.error || ""; color: Theme.danger; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.cancellation; text: row.modelData.cancellation || ""; color: Theme.amber; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.recovery; text: row.modelData.recovery || ""; color: Theme.amber; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.note; text: row.modelData.note || ""; color: Theme.amber; font.pixelSize: Theme.caption }
                    CText { visible: (row.modelData.adjustments || []).length > 0; text: "Adjusted: " + (row.modelData.adjustments || []).join("; "); color: Theme.muted; font.pixelSize: Theme.caption }
                    CText { visible: !!row.modelData.details?.stdout || !!row.modelData.details?.stderr; text: ((row.modelData.details?.stdout || "") + (row.modelData.details?.stderr ? "\n" + row.modelData.details.stderr : "")).slice(0, 4000); font.family: Theme.mono; font.pixelSize: Theme.caption; color: Theme.text }
                    Repeater { model: (row.modelData.results || []).slice(0, 8); RowLayout { required property var modelData; Layout.fillWidth: true; ArtifactCard { Layout.fillWidth: true; reference: modelData; sessionId: row.modelData.sessionId || runs.sessionId } CButton { text:"Explore"; quiet:true; visible: !!modelData.artifactId; onClicked:runs.explore(modelData,row.modelData.sessionId) } } }
                    Flow {
                        Layout.fillWidth: true; spacing: Theme.space1
                        CButton { objectName: "runCancel"; visible: ["prepared", "awaiting_approval", "queued", "dispatching", "running"].indexOf(row.modelData.state) >= 0; text: "Cancel"; danger: true; implicitHeight: Theme.compactHeight; onClicked: rpc.call("operations.cancel", { id: row.modelData.operationId }, value => { runs.error = value.error || ""; runs.refresh() }) }
                        CButton { objectName: "runCheck"; visible: row.modelData.state === "unknown" && row.modelData.remote && row.modelData.backend?.kind === "comfyui"; text: "Check status"; implicitHeight: Theme.compactHeight; onClicked: rpc.call("operations.check", { id: row.modelData.operationId }, value => { runs.error = value.error || ""; runs.refresh() }) }
                        CButton { objectName: "runRetry"; visible: ["failed", "unknown", "interrupted", "cancelled", "expired"].indexOf(row.modelData.state) >= 0 && row.modelData.kind.startsWith("image."); text: "Try again"; implicitHeight: Theme.compactHeight
                            onClicked: rpc.call("operations.retry", { id: row.modelData.operationId, confirmed: row.modelData.state === "unknown" ? retryConfirm.confirmed : undefined }, value => { if (value.code === "CONFIRM_RETRY") { retryConfirm.operationId = row.modelData.operationId; retryConfirm.open() } else { runs.error = value.error || ""; runs.refresh() } }) }
                        CButton { objectName:"runDetails"; text:"Details"; quiet:true; implicitHeight:Theme.compactHeight; onClicked:runs.openDetail(row.modelData) }
                        CButton { objectName:"runOpenResearch"; visible:row.modelData.kind === "research.run"; text:"Open in Research"; quiet:true; implicitHeight:Theme.compactHeight; onClicked:{ if (App.selectedId !== row.modelData.sessionId) App.select(row.modelData.sessionId); WorkbenchState.selectResearch(row.modelData.sessionId,row.modelData.researchId || row.modelData.id,""); WorkbenchState.show("research") } }
                        CButton { objectName:"runBaseline"; visible:row.modelData.kind !== "research.run"; text:runs.baselineRun && runs.operationId(runs.baselineRun) === runs.operationId(row.modelData) ? "Baseline" : "Set baseline"; quiet:true; implicitHeight:Theme.compactHeight; onClicked:{ runs.baselineRun = row.modelData; WorkbenchState.setRunBaseline(runs.sessionId, row.modelData) } }
                        CButton { objectName:"runCompare"; visible:row.modelData.kind !== "research.run" && !!runs.baselineRun && runs.operationId(runs.baselineRun)!==runs.operationId(row.modelData); text:"Compare"; quiet:true; implicitHeight:Theme.compactHeight; onClicked:{runs.selected=row.modelData;runs.compare()} }
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
    CDialog {
        id: detailDialog; accessibleTitle: "Run details"
        CText { text: selected?.label || "Run details"; font.pixelSize: Theme.title; font.bold: true }
        CText { Layout.fillWidth:true; wrapMode:Text.Wrap; text: selected ? [selected.kind, labels[selected.state] || selected.state, selected.origin === "model" ? "started by " + App.assistantName : selected.origin === "schedule" ? "scheduled analysis" : selected.origin === "user" ? "started by you" : "", new Date(selected.created).toLocaleString()].filter(v=>v).join(" · ") : ""; color:Theme.muted; font.pixelSize:Theme.caption }
        CText { visible:!!selected?.sessionId || !!selected?.turnId; Layout.fillWidth:true; wrapMode:Text.Wrap; text:selected ? [selected.sessionId ? "Conversation: " + runs.operationSessionName(selected) : "", selected.turnId ? "Originating turn: " + selected.turnId : ""].filter(v=>v).join(" · ") : ""; color:Theme.muted; font.pixelSize:Theme.caption }
        CText { visible:!!selected?.recovery; Layout.fillWidth:true; wrapMode:Text.Wrap; text:selected?.recovery || ""; color:Theme.amber }
        CText { visible:!!selected?.cancellationDetail; Layout.fillWidth:true; wrapMode:Text.Wrap; text:selected?.cancellationDetail ? "Cancellation: " + (selected.cancellationDetail.confirmed ? "confirmed" : "not confirmed") + (selected.cancellationDetail.note ? " · " + selected.cancellationDetail.note : "") + (selected.cancellationDetail.requested ? " · requested " + new Date(selected.cancellationDetail.requested).toLocaleString() : "") : ""; color:Theme.amber }
        CText { visible:!!selected?.error; Layout.fillWidth:true; wrapMode:Text.Wrap; text:selected?.error || ""; color:Theme.danger }
        CText { visible:!!selected?.summary; Layout.fillWidth:true; wrapMode:Text.Wrap; text:selected?.summary || "" }
        CText { visible:!!selected?.details?.runtime; Layout.fillWidth:true; wrapMode:Text.Wrap; text:selected?.details?.runtime ? "Python " + selected?.details?.runtime.python + " · " + Object.entries(selected?.details?.runtime.packages || {}).map(x=>x.join(" ")).join(", ") : ""; font.pixelSize:Theme.caption }
        CText { visible:selected?.details?.durationMs !== undefined || selected?.details?.exitCode !== undefined; Layout.fillWidth:true; wrapMode:Text.Wrap; text:[selected?.details?.exitCode !== undefined ? "Exit status " + selected?.details?.exitCode : "", selected?.details?.durationMs !== undefined ? "Runtime " + (selected?.details?.durationMs / 1000).toFixed(2) + " s" : "", selected?.details?.timeLimitSeconds !== undefined ? "Limit " + selected?.details?.timeLimitSeconds + " s" : selected?.details?.timeoutSeconds !== undefined ? "Limit " + selected?.details?.timeoutSeconds + " s" : ""].filter(v=>v).join(" · "); font.pixelSize:Theme.caption }
        CText { visible:!!runs.detailLimits(selected); Layout.fillWidth:true; wrapMode:Text.Wrap; text:"Recorded limits · " + runs.detailLimits(selected); color:Theme.muted; font.pixelSize:Theme.caption }
        CButton { visible:!!selected?.parentId; text:"Open previous run"; quiet:true; onClicked:runs.openDetail({id:selected.parentId}) }
        CText { visible:selected?.kind === "command.run" || selected?.kind === "command.host"; text:"Command workspace" + (selected?.details?.root ? " · " + selected?.details?.root : ""); font.pixelSize:Theme.secondary }
        CText { visible:(selected?.details?.changedFiles || []).length > 0; Layout.fillWidth:true; wrapMode:Text.Wrap; text:(selected?.details?.changedFiles || []).length + " changed file(s) recorded" + (selected?.details?.changeNote ? " · " + selected?.details?.changeNote : ""); color:Theme.muted; font.pixelSize:Theme.caption }
        Repeater { model:(selected?.details?.changedFiles || []).slice(0, 20); CButton { required property var modelData; Layout.fillWidth:true; visible:!!selected?.witness?.root; text:"Preview changed file · " + modelData; quiet:true; Accessible.name:"Preview changed file " + modelData; onClicked:runs.openChangedFile(modelData) } }
        CText { visible:(selected?.details?.changedFiles || []).length > 20; text:"Only the first 20 recorded paths are shown here."; color:Theme.muted; font.pixelSize:Theme.caption }
        CText { visible:(selected?.details?.changedFiles || []).length > 0 && !selected?.witness?.root; Layout.fillWidth:true; wrapMode:Text.Wrap; text:"Changed paths were recorded, but the workspace folder ID is unavailable for preview."; color:Theme.amber; font.pixelSize:Theme.caption }
        CText { visible:detailImages.length > 0; text:"Image outputs"; font.pixelSize:Theme.secondary }
        Repeater { model:detailImages; CButton { required property var modelData; Layout.fillWidth:true; text:"Open image · " + modelData.name; quiet:true; Accessible.name:"Open image output " + modelData.name; onClicked:runs.openResultImage(modelData) } }
        CText { visible:selected?.kind === "specialist.run" && !!selected?.details?.summary; Layout.fillWidth:true; wrapMode:Text.Wrap; text:"Specialist result · " + selected?.details?.summary; font.pixelSize:Theme.caption }
        CButton { visible:!!selected?.originatingMessageId && !!selected?.sessionId; text:"Jump to originating message"; quiet:true; Layout.fillWidth:true; onClicked:{ WorkbenchState.openMessage(selected.sessionId, selected.originatingMessageId); detailDialog.close() } }
        CText { visible:!!selected?.turnId && !selected?.originatingMessageId; Layout.fillWidth:true; wrapMode:Text.Wrap; text:"The originating turn is recorded above, but its transcript message is no longer available."; color:Theme.muted; font.pixelSize:Theme.caption }
        CText { visible:(selected?.inputs || []).length>0; text:"Inputs and provenance"; font.pixelSize:Theme.secondary }
        Repeater { model:selected?.inputs || []; CText { required property var modelData; Layout.fillWidth:true; wrapMode:Text.Wrap; text:(modelData.purpose || "input") + " · " + (modelData.artifactId || "") + " · " + (modelData.versionId || ""); font.family:Theme.mono; font.pixelSize:Theme.caption } }
        CText { visible:(selected?.details?.cells || []).length>0; text:"Notebook cells"; font.pixelSize:Theme.secondary }
        Repeater { model:selected?.details?.cells || []; ColumnLayout { required property var modelData; Layout.fillWidth:true
            CText { text:(modelData.name || "Cell") + " · " + (modelData.language || "") + " · " + (modelData.state || "") + (modelData.cached ? " · reused" : "") + (modelData.durationMs !== undefined ? " · " + (modelData.durationMs / 1000).toFixed(1) + " s" : ""); font.pixelSize:Theme.caption }
            CText { visible:!!modelData.stdout || !!modelData.stderr; Layout.fillWidth:true; wrapMode:Text.WrapAnywhere; text:((modelData.stdout || "") + (modelData.stderr ? "\n" + modelData.stderr : "")).slice(0,4000); font.family:Theme.mono; font.pixelSize:Theme.caption }
        } }
        CText { visible:!!selected?.details?.stdout || !!selected?.details?.stderr; text:"Output"; font.pixelSize:Theme.secondary }
        CText { visible:!!selected?.details?.stdout || !!selected?.details?.stderr; Layout.fillWidth:true; wrapMode:Text.WrapAnywhere; text:((selected?.details?.stdout || "") + (selected?.details?.stderr ? "\n" + selected?.details?.stderr : "")).slice(0,12000); font.family:Theme.mono; font.pixelSize:Theme.caption }
        Repeater { model:selected?.results || []; RowLayout { required property var modelData; Layout.fillWidth:true; ArtifactCard { Layout.fillWidth:true; reference:modelData; sessionId:selected?.sessionId || runs.sessionId } CButton { text:"Explore"; quiet:true; visible:!!modelData.artifactId; onClicked:runs.explore(modelData,selected?.sessionId) } CButton { text:"Ask assistant"; quiet:true; visible:selected?.kind === "codelab.run"; onClicked:{detailDialog.close();labEditor.assistForResult(selected,modelData)} } } }
        RowLayout { Layout.fillWidth:true; Item { Layout.fillWidth:true } CButton { visible:selected?.kind === "codelab.run"; text:"Open in Code Lab"; primary:true; onClicked:{ detailDialog.close(); if (selected.sessionId !== runs.sessionId) { App.select(selected.sessionId); WorkbenchState.openAnalysis(selected.sessionId,{operationId:operationId(selected),edit:true}) } else labEditor.openRun(operationId(selected)) } } CButton { text:"Close"; onClicked:detailDialog.close() } }
    }
    CDialog {
        id: comparison; property var value: ({}) ; accessibleTitle:"Run comparison"
        CText { text:"Run comparison"; font.pixelSize:Theme.title; font.bold:true }
        CField { id:compareKey; visible:(comparison.value.tables || []).length>0; Layout.fillWidth:true; placeholderText:"Matching columns, e.g. customer_id"; Accessible.name:"Matching result columns" }
        Flow { visible:compareKey.visible; Layout.fillWidth:true; spacing:Theme.space1
            CButton { text:"Match by key"; enabled:!!compareKey.text.trim(); onClicked:runs.compare(compareKey.text.trim(),false) }
            CButton { text:"Match by record position"; onClicked:runs.compare("",true) }
        }
        Repeater { model:comparison.value.tables || []; ColumnLayout { required property var modelData; Layout.fillWidth:true
            CText { text:modelData.name; font.weight:Font.DemiBold }
            CText { Layout.fillWidth:true; wrapMode:Text.Wrap; text:modelData.warning || (modelData.leftRows + " → " + modelData.rightRows + " records" + (modelData.modified === undefined ? "" : " · " + modelData.modified + " changed, " + modelData.added + " added, " + modelData.removed + " removed")) }
            CText { visible:(modelData.examples || []).length>0; Layout.fillWidth:true; wrapMode:Text.WrapAnywhere; font.pixelSize:Theme.caption; text:(modelData.examples || []).slice(0,10).map(r => "Record " + (r.beforeRecord || "—") + " → " + (r.afterRecord || "—") + " · " + (r.changes || []).map(c => c.column + " " + (c.before ?? "—") + " → " + (c.after ?? "—") + (c.delta !== undefined ? " (Δ " + c.delta + ")" : "")).join(", ")).join("\n") }
        } }
        CText { Layout.fillWidth:true; wrapMode:Text.Wrap; text:(comparison.value.warnings || []).join("\n"); visible:!!text; color:Theme.amber }
        Repeater { model:comparison.value?.differences || []; RowLayout { required property var modelData; Layout.fillWidth:true
            CText { Layout.preferredWidth:Theme.fieldShort; text:modelData.field || "field"; font.weight:Font.DemiBold }
            CText { Layout.fillWidth:true; wrapMode:Text.WrapAnywhere; text:"Before: " + JSON.stringify(modelData.before) + "\nAfter: " + JSON.stringify(modelData.after); font.family:Theme.mono; font.pixelSize:Theme.caption }
        } }
        CText { visible:!(comparison.value?.differences || []).length; text:"No recorded differences."; color:Theme.muted }
        CButton { text:"Close"; onClicked:comparison.close() }
    }
    CDialog {
        id: tableDialog
        property string sessionId: ""
        property string artifactId: ""
        property string versionId: ""
        property string operationId: ""
        property string mode: "artifact"
        property int offset: 0
        property int request: 0
        property var reference: ({})
        property var version: null
        property var table: ({})
        property var selectedRows: []
        property string thumbnail: ""
        property string tableError: ""
        accessibleTitle: "Result explorer"
        function isTable(item) { return /\.(csv|tsv)$/i.test(item.name || "") }
        function isImage(item) { return item.kind === "image" || item.kind === "plot" || /^image\//.test(item.mime || "") }
        function openReference(ref, sourceSession, item, sourceOperationId) {
            sessionId = sourceSession; artifactId = ref.artifactId; versionId = ref.versionId || item.versionId; operationId = sourceOperationId || ""
            reference = ref; version = item; offset = 0; selectedRows = []; table = ({}); tableError = ""; thumbnail = ""
            mode = isTable(item) ? "table" : isImage(item) ? "image" : "artifact"
            open()
            if (mode === "table") reload()
            else if (mode === "image") {
                const token = ++request, pageSession = runs.sessionId, sourceSession = sessionId, sourceArtifact = artifactId, sourceVersion = versionId
                rpc.call("artifacts.thumbnail", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, size: 800 }, value => {
                    if (token === request && pageSession === runs.sessionId && sourceSession === sessionId && sourceArtifact === artifactId && sourceVersion === versionId && value && !value.error) thumbnail = value.data || ""
                })
            }
        }
        function reload() {
            if (mode !== "table") return
            const token = ++request, pageSession = runs.sessionId, sourceSession = sessionId, sourceArtifact = artifactId, sourceVersion = versionId
            rpc.call("codelab.table", { sessionId: sourceSession, artifactId: sourceArtifact, versionId: sourceVersion, query: tableQuery.text || undefined, sort: sortField.text || undefined, direction: direction.currentValue, offset: offset, limit: 50 }, value => {
                if (token !== request || pageSession !== runs.sessionId || sourceSession !== tableDialog.sessionId || sourceArtifact !== tableDialog.artifactId || sourceVersion !== tableDialog.versionId) return
                if (value.error) tableError = value.error
                else { table = value; tableError = ""; selectedRows = [] }
            })
        }
        function toggleRow(row, checked) { selectedRows = checked ? selectedRows.concat([row]) : selectedRows.filter(value => value !== row) }
        function exportRows(rows) {
            const token = ++request, pageSession = runs.sessionId, sourceSession = sessionId, sourceArtifact = artifactId, sourceVersion = versionId
            rpc.call("codelab.exportRows", { sessionId: sourceSession, artifactId: sourceArtifact, versionId: sourceVersion, query: tableQuery.text || undefined, sort: sortField.text || undefined, direction: direction.currentValue, rows: rows && rows.length ? rows : undefined }, value => {
                if (token !== request || pageSession !== runs.sessionId || sourceSession !== tableDialog.sessionId || sourceArtifact !== tableDialog.artifactId || sourceVersion !== tableDialog.versionId) return
                if (value.error) tableError = value.error
                else close()
            })
        }
        function askAbout(row) {
            const column = resultColumn.currentValue || ""
            if (!operationId) { tableError = "Open the producing Code Lab run before asking about an output."; return }
            close()
            labEditor.assistForResult({ operationId: operationId, sessionId: sessionId }, { artifactId: artifactId, versionId: versionId, row: row, column: column || undefined })
        }
        CText { text: tableDialog.mode === "table" ? "Result table" : tableDialog.mode === "image" ? "Result chart" : "Result file"; font.pixelSize: Theme.title; font.bold: true }
        CText { visible: tableDialog.mode === "table"; text: "Rows are read from this immutable CSV or TSV version. Export creates a new conversation artifact."; Layout.fillWidth: true; wrapMode: Text.Wrap; color: Theme.muted; font.pixelSize: Theme.caption }
        Image { visible: tableDialog.mode === "image"; Layout.alignment: Qt.AlignHCenter; Layout.maximumWidth: Theme.dialogWidth; Layout.preferredHeight: Theme.editorTall; source: tableDialog.thumbnail; fillMode: Image.PreserveAspectFit; asynchronous: true; Accessible.name: "Thumbnail of " + (tableDialog.version?.name || "result chart") }
        CText { visible: tableDialog.mode === "image" && !tableDialog.thumbnail; text: "Loading chart preview…"; color: Theme.muted }
        ArtifactCard { visible: tableDialog.mode === "artifact"; Layout.fillWidth: true; reference: tableDialog.reference; sessionId: tableDialog.sessionId }
        RowLayout { visible: tableDialog.mode === "table"; Layout.fillWidth: true
            CField { id: tableQuery; Layout.fillWidth: true; placeholderText: "Filter rows"; Accessible.name: "Filter result rows"; onAccepted: { tableDialog.offset = 0; tableDialog.reload() } }
            CField { id: sortField; Layout.preferredWidth: Theme.fieldShort; placeholderText: "Sort column"; Accessible.name: "Sort result column"; onAccepted: { tableDialog.offset = 0; tableDialog.reload() } }
            CComboBox { id: direction; Layout.preferredWidth: Theme.fieldTiny; model: [{label:"Ascending",value:"asc"},{label:"Descending",value:"desc"}]; textRole: "label"; valueRole: "value"; Accessible.name: "Sort direction"; onActivated: tableDialog.reload() }
        }
        CComboBox { id: resultColumn; visible: tableDialog.mode === "table"; Layout.fillWidth: true; model: tableDialog.table.columns || []; Accessible.name: "Column to discuss" }
        CText { visible: !!tableDialog.tableError; text: tableDialog.tableError; color: Theme.danger; Accessible.role: Accessible.AlertMessage }
        CText { visible: tableDialog.mode === "table" && (tableDialog.table.problems || []).length > 0; text: (tableDialog.table.problems || []).join("\n"); color: Theme.amber; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CText { visible: tableDialog.mode === "table"; text: (tableDialog.table.columns || []).join(" · "); Layout.fillWidth: true; wrapMode: Text.Wrap; font.weight: Font.DemiBold; font.family: Theme.mono; font.pixelSize: Theme.caption }
        Repeater { model: tableDialog.mode === "table" ? tableDialog.table.rows || [] : []; RowLayout { required property var modelData; Layout.fillWidth: true
            CCheckBox { checked: tableDialog.selectedRows.indexOf(modelData.row) >= 0; Accessible.name: "Select row " + modelData.row; onToggled: tableDialog.toggleRow(modelData.row, checked) }
            CText { Layout.fillWidth: true; wrapMode: Text.WrapAnywhere; text: String(modelData.row) + "  " + (modelData.values || []).join(" · "); font.family: Theme.mono; font.pixelSize: Theme.caption }
            CButton { text: "Ask"; quiet: true; Accessible.name: "Ask about row " + modelData.row; onClicked: tableDialog.askAbout(modelData.row) }
        } }
        RowLayout { visible: tableDialog.mode === "table"; Layout.fillWidth: true
            CText { Layout.fillWidth: true; text: (tableDialog.table.matched !== undefined ? tableDialog.table.matched : tableDialog.table.total || 0) + " matching rows"; color: Theme.muted; font.pixelSize: Theme.caption }
            CButton { text: "Previous"; enabled: tableDialog.offset > 0; onClicked: { tableDialog.offset = Math.max(0, tableDialog.offset - 50); tableDialog.reload() } }
            CButton { text: "Next"; enabled: !!tableDialog.table.rows && tableDialog.table.rows.length === 50; onClicked: { tableDialog.offset += 50; tableDialog.reload() } }
        }
        RowLayout { Layout.fillWidth: true
            CButton { visible: tableDialog.mode === "table"; text: tableDialog.selectedRows.length ? "Export selected rows" : "Export matching rows"; primary: true; onClicked: tableDialog.exportRows(tableDialog.selectedRows) }
            CButton { visible: tableDialog.mode === "image"; text: "Open chart"; primary: true; onClicked: WorkbenchState.selectImage(tableDialog.sessionId, tableDialog.artifactId, tableDialog.versionId) }
            Item { Layout.fillWidth: true }
            CButton { text: "Close"; onClicked: tableDialog.close() }
        }
    }
}
