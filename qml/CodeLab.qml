import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The editor sends explicit immutable input versions, parameters and iteration parentage.
// The broker remains authoritative for availability, limits, recipes and saved analyses.
ColumnLayout {
    id: lab
    objectName: "codeLab"
    property string sessionId: ""
    // Optional endpoint keeps this component independently exercisable; production uses App.
    property var rpcEndpoint: null
    property var status: null
    property var files: []
    property var library: []
    property var chosen: []
    property int inputReviewCycle: 0
    function inputName(ref) { return ref.name || files.find(f=>f.id===ref.artifactId)?.name || ref.artifactId }
    function inputRefs() { return chosen.map(r=>({artifactId:r.artifactId,versionId:r.versionId})) }
    function addInput(ref) {
        const next=chosen.slice(), missing=next.findIndex(r=>r.available===false)
        if (missing>=0) next[missing]=ref
        else if (next.length<8) next.push(ref)
        else { error="An analysis can use up to eight inputs.";return }
        chosen=next
    }
    function moveInput(i, offset) { const next=chosen.slice(); next.splice(i+offset,0,next.splice(i,1)[0]); chosen=next }
    onChosenChanged:{ ++inputReviewCycle; preflight=({}); if (sessionId && chosen.length && !chosen.some(r=>r.available===false)) inputReview.restart() }
    Timer { id: inputReview; interval: 200; onTriggered: {
        const cycle=lab.inputReviewCycle
        rpc.call("codelab.preflight",{sessionId:lab.sessionId,inputs:lab.inputRefs(),code:code.text,parameters:lab.objectOrEmpty(parameters.text,"Parameters") || {}},value=>{
            if (cycle===lab.inputReviewCycle && !value.error) lab.preflight=value
        })
    } }
    property bool open: false
    property string error: ""
    property string loadedOperationId: ""
    property string parentId: ""
    property string analysisId: ""
    property string previousSessionId: ""
    property var drafts: WorkbenchState.analysisDrafts
    property var recipeFields: []
    property var fieldValues: ({})
    property bool sharedPython: false
    property var cells: []
    property var pendingRun: null
    property var preflight: ({})
    property int assistanceCycle: 0
    signal started(string operationId)
    signal paneRequested(string pane)
    signal settingsRequested(string category, string target)
    signal workflowsRequested()
    spacing: Theme.space2
    RpcClient { id: rpc; endpoint: lab.rpcEndpoint; scope: lab.sessionId }

    function objectOrEmpty(text, description) {
        if (!text.trim()) return {}
        try { const result = JSON.parse(text); if (!result || Array.isArray(result) || typeof result !== "object") throw new Error("not an object"); return result }
        catch (_) { error = description + " must be a JSON object"; return null }
    }
    function normalizedCells() {
        if (!cells.length) return []
        return cells.map((cell, index) => ({ name: cell.name || "Cell " + (index + 1), code: index === 0 ? code.text : (cell.code || ""), language: index === 0 ? language.currentValue : (cell.language || "python") }))
    }
    function replaceCells(next) { cells = next.map((cell, index) => ({ name: cell.name || "Cell " + (index + 1), code: cell.code || "", language: cell.language || "python" })) }
    function setMainCell(cell) {
        code.text = cell ? cell.code || "" : ""
        language.currentIndex = cell?.language === "sql" ? 1 : 0
    }
    function addCell() {
        const next = normalizedCells()
        // The main editor is the first implicit cell until a notebook is created.
        if (!next.length)
            next.push({ name: "Cell 1", code: code.text, language: language.currentValue || "python" })
        next.push({ name: "Cell " + (next.length + 1), code: "", language: language.currentValue || "python" })
        replaceCells(next)
    }
    function removeCell(index) {
        const next = normalizedCells()
        if (index < 0 || index >= next.length) return
        next.splice(index, 1)
        if (index === 0 && next.length) setMainCell(next[0])
        replaceCells(next)
    }
    function moveCell(index, delta) {
        const next = normalizedCells(), target = index + delta
        if (target < 0 || target >= next.length) return
        const item = next.splice(index, 1)[0]
        next.splice(target, 0, item)
        if (index === 0 || target === 0) setMainCell(next[0])
        replaceCells(next)
    }
    function updateCell(index, patch) {
        if (index < 0 || index >= cells.length) return
        // Mutate the data row during editing: replacing the model here destroys
        // the delegate and steals keyboard focus on its first keystroke.
        Object.assign(cells[index], patch)
    }
    function setFieldValue(key, value) { fieldValues[key] = value }
    function preflightColumns() {
        const names = []
        for (const slot of preflight?.slots || [])
            for (const name of slot.columns || [])
                if (names.indexOf(name) === -1) names.push(name)
        return names
    }
    function columnModel(field) {
        const selected = fieldValues[field.key] || field.default || ""
        const names = preflightColumns()
        if (selected && names.indexOf(selected) === -1) names.unshift(selected)
        return names.length ? names : (selected ? [selected] : [])
    }
    function apply(value) {
        const recipe = (status?.recipes || []).find(r => r.id === value.recipeId || r.code === value.code)
        recipeFields = recipe?.fields || []
        fieldValues = Object.assign({}, value.parameters || {})
        error = (value.warnings || []).join("\n")
        code.text = value.code || ""; purpose.text = value.purpose || ""; parameters.text = JSON.stringify(value.parameters || {}, null, 2)
        language.currentIndex = (value.language || "python") === "sql" ? 1 : 0
        sharedPython = value.sharedPython === true
        replaceCells(value.steps || [])
        chosen = value.slots?.length ? value.slots.map(r=>({artifactId:r.artifactId,versionId:r.versionId,name:r.name,available:r.available})) : value.inputs || []; parentId = value.parentId || value.operationId || ""; loadedOperationId = value.operationId || ""; analysisId = value.analysisId || value.id || ""
        open = true
    }
    function saveDraft(id) {
        if (!id) return
        const next = Object.assign({}, drafts)
        next[id] = { code: code.text, purpose: purpose.text, parameters: parameters.text, cells: normalizedCells(), sharedPython: sharedPython,
            language: language.currentValue || "python", timeout: timeout.value, inputs: chosen, parentId: parentId, analysisId: analysisId, loadedOperationId: loadedOperationId, open: open }
        WorkbenchState.analysisDrafts = next
    }
    function restoreDraft(id) {
        const draft = drafts[id]
        if (!draft) { sharedPython = false; code.text = ""; purpose.text = ""; parameters.text = ""; cells = []; chosen = []; parentId = ""; analysisId = ""; loadedOperationId = ""; return }
        code.text = draft.code; purpose.text = draft.purpose; parameters.text = draft.parameters; replaceCells(draft.cells || []); sharedPython = draft.sharedPython === true
        language.currentIndex = draft.language === "sql" ? 1 : 0; timeout.value = draft.timeout || 60; chosen = draft.inputs || []
        parentId = draft.parentId || ""; analysisId = draft.analysisId || ""; loadedOperationId = draft.loadedOperationId || ""; open = draft.open === true
    }
    function refresh() {
        if (!sessionId) return
        rpc.call("codelab.status", { sessionId: sessionId }, value => { if (value.error) error = value.error; else status = value })
        rpc.call("artifacts.list", { sessionId: sessionId, limit: 100, project: true }, value => { if (!value.error) files = value.artifacts || [] })
        rpc.call("codelab.library", { sessionId: sessionId }, value => { if (!value.error) library = value || [] })
    }
    function loadSample() { rpc.call("codelab.sample", { sessionId: sessionId }, value => { if (value.error) error = value.error; else apply(value) }) }
    function openRun(operationId) { rpc.call("codelab.open", { sessionId: sessionId, operationId: operationId }, value => { if (value.error) error = value.error; else apply(value) }) }
    function payload(reuseSteps) {
        const p = objectOrEmpty(parameters.text, "Parameters"), s = normalizedCells()
        if (p === null) return null
        if (chosen.some(r=>r.available===false)) {error="Choose replacement files for unavailable inputs, or remove those slots.";return null}
        Object.keys(fieldValues).forEach(key => { if (fieldValues[key] !== "") p[key] = fieldValues[key] })
        return { sessionId: sessionId, code: code.text, inputs: inputRefs(), purpose: purpose.text || "Run from the Workbench", timeoutSeconds: timeout.value,
            parameters: p, language: language.currentValue, parentId: parentId || undefined, analysisId: analysisId || undefined, steps: s, sharedPython: sharedPython && s.length > 0, reuseSteps: reuseSteps === true, notify: notify.checked }
    }
    function submitRun(payload) {
        rpc.call("codelab.run", payload, value => {
                if (value.error) error = value.error
                else { loadedOperationId = value.operationId || ""; parentId = value.operationId || parentId; started(value.operationId || "") }
            })
    }
    function run(reuseSteps) {
        const next = payload(reuseSteps)
        if (!next) return
        error = ""
        rpc.call("codelab.preflight", { sessionId: next.sessionId, inputs: next.inputs, parameters: next.parameters,
            code: next.code, language: next.language, steps: next.steps, parentId: next.parentId, analysisId: next.analysisId }, value => {
            if (value.error) { error = value.error; return }
            preflight = value
            pendingRun = next
            if ((value.warnings || []).length || (value.missingPackages || []).length) preflightDialog.open()
            else submitRun(next)
        })
    }
    function requestAssistance(context) {
        const p = objectOrEmpty(parameters.text, "Parameters")
        if (p === null) return
        const sourceSession = context?.sessionId || sessionId
        if (sourceSession !== sessionId) { error = "Open this run in its original conversation before asking about it."; return }
        const result = context?.result || undefined
        const request = assistRequest.text.trim() || (result?.row ? "Explain row " + result.row + (result.column ? ", column " + result.column : "") + " in this result." : result ? "Explain this result and what it shows." : "Explain this analysis and its selected inputs.")
        const mode = assistMode.currentValue, baseCode = code.text, baseSession = sessionId, cycle = ++assistanceCycle
        rpc.call("codelab.assist", { sessionId: sourceSession, request: request, mode: mode, code: baseCode,
            language: language.currentValue, inputs: inputRefs(), parameters: p, analysisId: analysisId || undefined,
            operationId: context?.operationId || loadedOperationId || undefined, result: result }, value => {
                if (cycle !== assistanceCycle || baseSession !== sessionId) return
                if (value.error) error = value.error
                else { assistance.value = value; assistance.mode = mode; assistance.baseCode = baseCode; assistance.baseSessionId = baseSession; assistance.open() }
            })
    }
    function assistForResult(operation, result) {
        const sourceSession = operation?.sessionId || result?.sessionId || sessionId, id = operation?.operationId || operation?.id || ""
        if (!id) { error = "This output is not linked to a Code Lab run."; return }
        if (sourceSession !== sessionId) { error = "Open this run in its original conversation before asking about its output."; return }
        const cycle = ++assistanceCycle
        rpc.call("codelab.open", { sessionId: sourceSession, operationId: id }, value => {
            if (cycle !== assistanceCycle || sourceSession !== sessionId) return
            if (value.error) { error = value.error; return }
            apply(value)
            open = true
            requestAssistance({ sessionId: sourceSession, operationId: id, result: result })
        })
    }
    Component.onDestruction: saveDraft(previousSessionId)
    Component.onCompleted: { previousSessionId = sessionId; restoreDraft(sessionId); refresh() }
    onSessionIdChanged: { ++assistanceCycle; saveDraft(previousSessionId); previousSessionId = sessionId; files = []; library = []; error = ""; restoreDraft(sessionId); refresh() }

    RowLayout {
        Layout.fillWidth: true
        CButton { objectName: "codeLabToggle"; text: lab.open ? "Hide Code Lab" : "Code Lab"; iconName: "terminal"; quiet: !lab.open; onClicked: { lab.open = !lab.open; if (lab.open) lab.refresh() } }
        Item { Layout.fillWidth: true }
        CButton { objectName: "codeLabSample"; visible: lab.open; text: "Load sample"; quiet: true; onClicked: lab.loadSample() }
    }
    CText { objectName: "codeLabStatus"; Layout.fillWidth: true; visible: !!lab.status; wrapMode: Text.Wrap
        text: !lab.status ? "" : !lab.status.available ? lab.status.problem : !lab.status.enabled ? "Off: turn it on in Settings › Connections › Images & analysis" :
              "Ready · " + (lab.status.runtime?.python || "Python") + " · no network · selected versions are read-only"
        color: lab.status && lab.status.available && lab.status.enabled ? Theme.muted : Theme.amber; font.pixelSize: Theme.caption }
    Flow { visible: !!lab.status && (!lab.status.available || !lab.status.enabled); Layout.fillWidth: true; spacing: Theme.space1
        CButton { objectName:"codeLabSetup"; visible: !!lab.status && !lab.status.enabled; text:"Open Code Lab settings"; primary:true; onClicked:lab.settingsRequested("connections", "codeLabEnabled") }
        CButton { objectName:"codeLabIsolationHelp"; visible: !!lab.status && !lab.status.available; text:"Open setup guidance"; primary:true; onClicked:lab.settingsRequested("connections", "codeLabEnabled") }
    }
    ColumnLayout {
        visible: lab.open; Layout.fillWidth: true; spacing: Theme.space2
        CText { visible: !!lab.status && lab.status.available; Layout.fillWidth: true; wrapMode: Text.Wrap; color: Theme.muted; font.pixelSize: Theme.caption
            text: "Memory: " + (lab.status?.enforced?.memory || "unknown") + ". Processes: " + (lab.status?.enforced?.processes || "unknown") + ". " + (lab.status?.enforced?.outputFiles || "Outputs are bounded.") }
        RowLayout {
            Layout.fillWidth: true
            CComboBox { id: recipe; objectName: "codeLabRecipe"; Layout.fillWidth: true; model: [{label:"Start from a recipe…"}].concat((lab.status?.recipes || []).map(r => ({label:r.label, recipe:r}))); textRole: "label"; Accessible.name: "Built-in analysis recipe"
                onActivated: index => { if (index > 0) { const r = model[index].recipe; code.text = r.code; purpose.text = r.label; parameters.text = JSON.stringify(r.parameters || {}, null, 2); recipeFields = r.fields || []; fieldValues = (r.fields || []).reduce((all, field) => { all[field.key] = field.default || ""; return all }, {}); language.currentIndex = (r.language || "python") === "sql" ? 1 : 0 } } }
            CComboBox { id: saved; objectName: "codeLabLibrary"; Layout.preferredWidth: Theme.fieldWidth; model: [{name:"Saved analyses…"}].concat(lab.library); textRole: "name"; Accessible.name: "Saved analysis"
                onActivated: index => { if (index > 0) rpc.call("codelab.load", { sessionId: lab.sessionId, id: model[index].id }, value => { if (value.error) lab.error = value.error; else lab.apply(value) }) } }
        }
        RowLayout {
            Layout.fillWidth: true
            CField { id: purpose; objectName: "codeLabPurpose"; Layout.fillWidth: true; placeholderText: "What this run is for"; Accessible.name: "Purpose" }
            CComboBox { id: language; objectName: "codeLabLanguage"; Layout.preferredWidth: Theme.fieldShort; model: [{label:"Python",value:"python"},{label:"SQL",value:"sql"}]; textRole:"label"; valueRole:"value"; Accessible.name:"Analysis language" }
            CSpinBox { id: timeout; objectName:"codeLabTimeout"; from: 1; to: 600; value: 60; Accessible.name:"Code Lab time limit in seconds" }
        }
        CText { text: language.currentValue === "sql" ? "SQL runs use selected inputs supplied by the desktop runtime." : "Python inputs are listed in /work/inputs.json; parameters are in /work/parameters.json; write outputs to /work/output."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
        GridLayout { visible: lab.recipeFields.length > 0; Layout.fillWidth: true; columns: width < Theme.narrowPane ? 1 : 2
            Repeater { model: lab.recipeFields; RowLayout { required property var modelData; Layout.fillWidth: true
                CText { Layout.preferredWidth: Theme.fieldShort; text: modelData.label || modelData.key; elide: Text.ElideRight }
                CComboBox { objectName: "codeLabRecipeField_" + modelData.key; visible: modelData.type === "column"; Layout.fillWidth: true; editable: true; model: lab.columnModel(modelData); Accessible.name: (modelData.label || modelData.key) + " column"; onEditTextChanged: lab.setFieldValue(modelData.key, editText.trim()) }
                CField { objectName: "codeLabRecipeField_" + modelData.key; visible: modelData.type !== "column"; Layout.fillWidth: true; text: fieldValues[modelData.key] || modelData.default || ""; placeholderText: modelData.type === "number" ? "Number" : "Value"; inputMethodHints: modelData.type === "number" ? Qt.ImhFormattedNumbersOnly : Qt.ImhNone; Accessible.name: modelData.label || modelData.key; onTextEdited: lab.setFieldValue(modelData.key, text.trim()) }
            } }
            CText { Layout.columnSpan: lab.width < Theme.narrowPane ? 1 : 2; Layout.fillWidth: true; text: lab.preflightColumns().length ? "Column choices were inspected from the selected input(s). You can still type a name." : "Run preflight to inspect selected input columns; you can also type a name."; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap }
        }
        ScrollView { Layout.fillWidth: true; Layout.preferredHeight: Theme.editorMedium; Layout.minimumHeight: Theme.editorShort; clip: true
            CCheckBox { visible:lab.cells.length>0; text:"Share Python variables between cells"; checked:lab.sharedPython; onToggled:lab.sharedPython=checked; Accessible.description:"Starts a fresh Python interpreter on each run. All cells must be Python." }
        CTextArea { id: code; objectName: "codeLabCode"; font.family: Theme.mono; font.pixelSize: Theme.caption; wrapMode: TextEdit.NoWrap; placeholderText: "# Analysis code"; Accessible.name: "Analysis code" } }
        CTextArea { id: parameters; objectName: "codeLabParameters"; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorShort; font.family: Theme.mono; font.pixelSize: Theme.caption; placeholderText: "Parameters as JSON, for example {\n  \"x\": \"month\", \"y\": \"sales\"\n}"; Accessible.name: "Analysis parameters as JSON" }
        CSection { title: "Notebook cells"; expanded: cells.length > 0; Layout.fillWidth: true
            CText { text: cells.length ? "Cells run in order. Earlier outputs are read-only inputs to later cells." : "Add cells to make a replayable notebook; otherwise the code above runs as one analysis."; Layout.fillWidth: true; wrapMode: Text.Wrap; color: Theme.muted; font.pixelSize: Theme.caption }
            Repeater { model: cells; ColumnLayout { required property var modelData; required property int index; Layout.fillWidth: true
                RowLayout { Layout.fillWidth: true
                    CField { objectName:"codeLabCellName_" + index; Layout.fillWidth: true; text: modelData.name; Accessible.name: "Cell " + (index + 1) + " name"; onTextEdited: lab.updateCell(index, { name: text }) }
                    CComboBox { objectName:"codeLabCellLanguage_" + index; Layout.preferredWidth: Theme.fieldShort; model: [{label:"Python",value:"python"},{label:"SQL",value:"sql"}]; textRole:"label"; valueRole:"value"; currentIndex:modelData.language === "sql" ? 1 : 0; Accessible.name:"Cell " + (index + 1) + " language"; onActivated:lab.updateCell(index,{language:currentValue}) }
                    CButton { objectName:"codeLabCellUp_" + index; text:"↑"; quiet:true; enabled:index>0; Accessible.name:"Move cell " + (index + 1) + " earlier"; onClicked:lab.moveCell(index,-1) }
                    CButton { objectName:"codeLabCellDown_" + index; text:"↓"; quiet:true; enabled:index<lab.cells.length-1; Accessible.name:"Move cell " + (index + 1) + " later"; onClicked:lab.moveCell(index,1) }
                    CButton { objectName:"codeLabCellRemove_" + index; text:"Remove"; danger:true; Accessible.name:"Remove cell " + (index + 1); onClicked:lab.removeCell(index) }
                }
                CTextArea { objectName:"codeLabCellCode_" + index; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorShort; text:index === 0 ? code.text : modelData.code; font.family:Theme.mono; font.pixelSize:Theme.caption; Accessible.name:"Cell " + (index + 1) + " code"; onTextChanged: { if (activeFocus) { if (index === 0) code.text = text; else lab.updateCell(index,{code:text}) } } }
            } }
            CButton { objectName:"codeLabAddCell"; text:"Add cell"; quiet:true; Accessible.name:"Add notebook cell"; onClicked:lab.addCell() }
        }
        CText { text: "Inputs (ordered, read-only copies)"; font.pixelSize: Theme.secondary }
        Repeater { model:lab.chosen; RowLayout { required property var modelData; required property int index; Layout.fillWidth:true
            CText { Layout.fillWidth:true; wrapMode:Text.WrapAnywhere; text:(index+1) + ". " + lab.inputName(modelData) + (modelData.available===false ? " · choose replacement" : " · " + modelData.versionId.slice(0,8)) }
            CButton { text:"↑"; quiet:true; enabled:index>0; Accessible.name:"Move input earlier"; onClicked:lab.moveInput(index,-1) }
            CButton { text:"↓"; quiet:true; enabled:index+1<lab.chosen.length; Accessible.name:"Move input later"; onClicked:lab.moveInput(index,1) }
            CButton { text:"Remove"; quiet:true; onClicked:lab.chosen=lab.chosen.filter((_,i)=>i!==index) }
        } }
        Flow { Layout.fillWidth:true; spacing:Theme.space1
            CButton { objectName:"codeLabBrowseFiles"; text:"Files"; quiet:true; onClicked:lab.paneRequested("files") }
            CButton { objectName:"codeLabBrowseArtifacts"; text:"Attachments & results"; quiet:true; onClicked:lab.paneRequested("images") }
            CButton { objectName:"codeLabBrowseShelf"; text:"Project Shelf"; quiet:true; onClicked:lab.paneRequested("shelf") }
            CButton { objectName:"codeLabWorkflows"; text:"Project workflows"; quiet:true; onClicked:lab.workflowsRequested() }
        }
        Flow { Layout.fillWidth: true; spacing: Theme.space2
            Repeater { model: lab.files
                CCheckBox { required property var modelData; width: Math.min(parent.width, implicitContentWidth + leftPadding + rightPadding)
                    text: modelData.name + (modelData.latest?.source ? " · " + modelData.latest.source : ""); checked: lab.chosen.some(c => c.artifactId === modelData.id && c.versionId === modelData.latestVersionId && c.available !== false)
                    Accessible.name: "Use input " + modelData.name
                    onToggled: { if (checked) lab.addInput({artifactId:modelData.id,versionId:modelData.latestVersionId}); else lab.chosen=lab.chosen.filter(c=>c.versionId!==modelData.latestVersionId) } }
            }
            CText { visible: !lab.files.length; width: parent.width; text: "No conversation files yet. Attach/import a file, or load the real sample when available."; color: Theme.muted; font.pixelSize: Theme.caption }
        }
        CText { visible: !!lab.parentId; text: "This run iterates on " + lab.parentId.slice(0, 8) + "."; color: Theme.muted; font.pixelSize: Theme.caption }
        CText { visible: !!lab.error; text: lab.error; color: Theme.danger; font.pixelSize: Theme.caption; Accessible.role: Accessible.AlertMessage }
        Flow { Layout.fillWidth: true; spacing: Theme.space1
            CButton { objectName: "codeLabRun"; text: "Run fresh"; primary: true; enabled: !!lab.status && lab.status.available && lab.status.enabled && code.text.trim().length > 0; onClicked: lab.run(false) }
            CButton { objectName: "codeLabRecompute"; visible: !!lab.parentId; text: "Recompute affected"; quiet: true; enabled: !!lab.status && lab.status.available && lab.status.enabled && code.text.trim().length > 0; onClicked: lab.run(true) }
            CButton { objectName: "codeLabGrant"; text: lab.status?.grant ? "Revoke grant · " + (lab.status.grant.maxRuns - lab.status.grant.usedRuns) + " left until " + new Date(lab.status.grant.expires).toLocaleTimeString() : "Let " + App.assistantName + " run code for 30 minutes"; quiet: true; visible: !!lab.status && lab.status.available && lab.status.enabled
                help: "Up to 10 Code Lab runs without asking each time. Commands in your folders always ask."
                onClicked: rpc.call(lab.status?.grant ? "codelab.revoke" : "codelab.grant", lab.status?.grant ? {sessionId: lab.sessionId, id: lab.status.grant.id} : { sessionId: lab.sessionId, minutes: 30, maxRuns: 10 }, value => { if (value.error) lab.error = value.error; else lab.refresh() }) }
            CButton { objectName:"codeLabSave"; visible: !!lab.loadedOperationId; text:"Save analysis"; quiet:true; onClicked: saveDialog.open() }
            CButton { objectName:"codeLabExport"; visible: !!lab.loadedOperationId; text:"Export result"; quiet:true; onClicked: rpc.call("codelab.export", {sessionId:lab.sessionId, operationId:lab.loadedOperationId}, value => { if(value.error) lab.error=value.error; else lab.started(lab.loadedOperationId) }) }
            CCheckBox { id: notify; objectName:"codeLabNotify"; text:"Notify when finished"; checked:false; Accessible.name:"Notify when this analysis finishes" }
        }
        CSection { title:"Assistant proposal"; expanded:false; Layout.fillWidth:true
            CText { text:"Ask about the selected inputs or a result. PAL only shows a proposed explanation, plan, or code diff; applying it never runs code."; Layout.fillWidth:true; wrapMode:Text.Wrap; color:Theme.muted; font.pixelSize:Theme.caption }
            RowLayout { Layout.fillWidth:true
                CComboBox { id:assistMode; Layout.preferredWidth:Theme.fieldShort; model:[{label:"Explain",value:"explain"},{label:"Propose revision",value:"revise"},{label:"Plan",value:"plan"}];textRole:"label";valueRole:"value";Accessible.name:"Assistance mode" }
                CField { id:assistRequest; Layout.fillWidth:true; placeholderText:"What should the assistant help with?"; Accessible.name:"Analysis assistance request"; onAccepted:lab.requestAssistance(null) }
                CButton { objectName:"codeLabAssist"; text:"Ask"; enabled:assistRequest.text.trim().length>0; onClicked:lab.requestAssistance(null) }
            }
        }
        CSection { title: "Saved analyses"; expanded: false; Layout.fillWidth: true
            CText { visible: !lab.library.length; text: "Save a completed analysis to reuse it, retain its input slots, or schedule it."; color: Theme.muted; font.pixelSize: Theme.caption }
            Repeater { model: lab.library; ColumnLayout { required property var modelData; Layout.fillWidth: true
                RowLayout { Layout.fillWidth: true
                    CText { Layout.fillWidth: true; text: modelData.name + (modelData.sourceSessionId ? " · source conversation " + String(modelData.sourceSessionId).slice(0, 8) : ""); elide:Text.ElideRight; Accessible.name:"Saved analysis " + modelData.name }
                    CSpinBox { id: days; from:0; to:365; value:modelData.days || modelData.scheduleDays || 0; Accessible.name:"Schedule interval in days for " + modelData.name }
                    CButton { text:days.value ? "Schedule" : "Paused"; quiet:true; onClicked:rpc.call("codelab.schedule",{sessionId:lab.sessionId,id:modelData.id,days:days.value},value=>{if(value.error)lab.error=value.error;else lab.refresh()}) }
                    CButton { text:"Load"; quiet:true; onClicked:rpc.call("codelab.load",{sessionId:lab.sessionId,id:modelData.id},value=>{if(value.error)lab.error=value.error;else lab.apply(value)}) }
                    CButton { text:"Remove"; danger:true; onClicked:rpc.call("codelab.remove",{sessionId:lab.sessionId,id:modelData.id},value=>{if(value.error)lab.error=value.error;else lab.refresh()}) }
                }
                CText { visible: !!modelData.paused; Layout.fillWidth: true; wrapMode: Text.Wrap; text: "Paused: " + modelData.paused; color: Theme.amber; font.pixelSize: Theme.caption }
            } }
        }
    }
    CDialog { id: saveDialog; accessibleTitle:"Save analysis"
        CText { text:"Save analysis"; font.pixelSize:Theme.section; font.weight:Font.DemiBold }
        CField { id: saveName; Layout.fillWidth:true; placeholderText:"Name"; Accessible.name:"Saved analysis name" }
        RowLayout { Layout.fillWidth:true; CButton { text:"Cancel"; onClicked:saveDialog.close() } CButton { text:"Save"; primary:true; enabled:saveName.text.trim().length>0; onClicked:rpc.call("codelab.save",{sessionId:lab.sessionId,operationId:lab.loadedOperationId,name:saveName.text.trim()},value=>{if(value.error)lab.error=value.error;else{saveDialog.close();lab.refresh()}}) } }
    }
    CDialog { id: preflightDialog; accessibleTitle:"Review analysis warnings"
        CText { text:"Review analysis warnings"; font.pixelSize:Theme.title; font.bold:true }
        CText { visible:(lab.preflight.warnings || []).length>0; Layout.fillWidth:true; wrapMode:Text.Wrap; text:(lab.preflight.warnings || []).join("\n"); color:Theme.amber }
        CText { visible:(lab.preflight.missingPackages || []).length>0; Layout.fillWidth:true; wrapMode:Text.Wrap; text:"Missing packages: " + (lab.preflight.missingPackages || []).join(", "); color:Theme.danger }
        Repeater { model:lab.preflight.slots || []; CText { required property var modelData; Layout.fillWidth:true; wrapMode:Text.Wrap; text:(modelData.name || "Input") + ": " + (modelData.columns || []).join(", ") + ((modelData.sheets || []).length ? " · sheets: " + modelData.sheets.join(", ") : ""); font.family:Theme.mono; font.pixelSize:Theme.caption } }
        RowLayout { Layout.fillWidth:true; CButton { text:"Back"; onClicked:preflightDialog.close() } Item { Layout.fillWidth:true } CButton { text:"Run anyway"; primary:true; onClicked:{preflightDialog.close();lab.submitRun(lab.pendingRun)} } }
    }
    CDialog { id: assistance; property var value:({}); property string mode:""; property string baseCode:""; property string baseSessionId:""; readonly property bool canApply: mode === "revise" && !!value.code && baseSessionId === lab.sessionId && baseCode === code.text; accessibleTitle:"Assistant proposal"
        CText { text:"Assistant proposal"; font.pixelSize:Theme.title; font.bold:true }
        CText { visible:!!assistance.value.explanation; Layout.fillWidth:true; wrapMode:Text.Wrap; text:assistance.value.explanation || "" }
        Repeater { model:assistance.value.plan || []; CText { required property var modelData; Layout.fillWidth:true; wrapMode:Text.Wrap; text:"• " + modelData } }
        CTextArea { id:proposalCode; visible:!!assistance.value.code; Layout.fillWidth:true; Layout.preferredHeight:Theme.editorMedium; readOnly:true; text:assistance.value.code || ""; font.family:Theme.mono; font.pixelSize:Theme.caption; Accessible.name:"Proposed analysis code" }
        CTextArea { visible:!!assistance.value.diff; Layout.fillWidth:true; Layout.preferredHeight:Theme.editorShort; readOnly:true; text:assistance.value.diff || ""; font.family:Theme.mono; font.pixelSize:Theme.caption; Accessible.name:"Proposed code diff" }
        CText { visible:!!assistance.value.code; text:assistance.canApply ? "Apply only replaces this unchanged draft. Review it and choose Run separately." : "This proposal was based on an earlier or different draft and cannot be applied automatically."; color:Theme.amber; Layout.fillWidth:true; wrapMode:Text.Wrap }
        RowLayout { Layout.fillWidth:true; CButton { text:"Close"; onClicked:assistance.close() } Item { Layout.fillWidth:true } CButton { visible:assistance.mode === "revise" && !!assistance.value.code; enabled:assistance.canApply; text:"Apply revision to draft"; primary:true; onClicked:{ if (!assistance.canApply) return; code.text=assistance.value.code; language.currentIndex=(assistance.value.language || "python")==="sql"?1:0; assistance.close() } } }
    }
}
