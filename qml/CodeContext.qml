pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A03: code of this project, found by what it does, with what is around it. Off until chosen for the project.
ColumnLayout {
    id: code
    property string sessionId: ""
    property bool shown: false
    property var info: ({ enabled: false, refused: "", files: 0, symbols: 0, languages: [], job: null })
    property var results: []
    property bool searched: false
    property var seen: null
    property var linkable: []
    property string error: ""
    readonly property bool usable: shown && sessionId.length > 0
    spacing: Theme.space2
    function show(value) { if (value.error) { error = value.error; return false } info = value; return true }
    function load() { if (usable) reader.call("code.status", { sessionId: sessionId }, value => code.show(value)) }
    function configure(patch) {
        error = ""
        writer.call("code.configure", Object.assign({ sessionId: sessionId }, patch), value => { if (code.show(value) && !value.enabled) { code.results = []; code.seen = null; code.searched = false } else code.load() })
    }
    function find() {
        error = ""; seen = null
        finder.call("code.find", { sessionId: sessionId, query: query.text.trim() }, value => { if (value.error) { code.error = value.error; return } code.results = value.results; code.searched = true })
    }
    function look(request) {
        error = ""
        finder.call("code.around", Object.assign({ sessionId: sessionId }, request), value => {
            if (value.error) { code.error = value.error; return }
            if (value.several) { code.results = value.several; code.seen = null; return }
            code.seen = value
        })
        reader.call("code.linkable", { sessionId: sessionId }, value => { if (!value.error) code.linkable = value.decisions })
    }
    function place(row) { return row.path + ":" + row.line }
    function title(row) { return (row.container ? row.container + "." : "") + row.name }
    function lines(symbol) { return symbol.endLine > symbol.line ? "lines " + symbol.line + "–" + symbol.endLine : "line " + symbol.line }
    function sure(row) { return row.certainty === "possible" ? "possible" : row.certainty === "ambiguous" ? row.candidates > 1 ? "one of " + row.candidates : "one of several" : "" }
    // What is already tied to the code in view is not offered again.
    readonly property var offerable: seen ? linkable.filter(item => !seen.decisions.some(tied => tied.text === item.text)) : []
    readonly property var groups: {
        if (!seen) return []
        return [
            { id: "usedBy", name: "Used by", rows: seen.usedBy }, { id: "tests", name: "Tests", rows: seen.tests }, { id: "uses", name: "Uses", rows: seen.uses },
            { id: "importedBy", name: "Imported by", rows: seen.importedBy }, { id: "imports", name: "Imports", rows: seen.imports.map(item => ({ path: item.path || item.module, line: item.line, outside: !item.path })) }
        ].filter(group => group.rows.length > 0)
    }
    onUsableChanged: { results = []; seen = null; searched = false; error = ""; load() }
    RpcClient { id: reader; scope: code.sessionId }
    RpcClient { id: writer; scope: code.sessionId }
    RpcClient { id: finder; scope: code.sessionId }
    Timer { interval: 900; repeat: true; running: code.usable && !!code.info.job; onTriggered: code.load() }
    CText { text: "Code in this project"; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
    CText {
        objectName: "codeStatus"
        text: code.info.refused ? code.info.refused : !code.info.enabled ? "Off. PAL can keep an index on this computer of what this project’s code declares and calls, so you and assistants find it by what it does. The files themselves are not copied."
            : code.info.job ? "Reading " + code.info.job.processed + " of " + code.info.job.total + " files…" : code.info.symbols + (code.info.symbols === 1 ? " symbol in " : " symbols in ") + code.info.files + (code.info.files === 1 ? " file" : " files") + (code.info.languages.length ? " · " + code.info.languages.join(", ") : "") + (code.info.problems ? " · " + code.info.problems + " could not be read" : "")
        color: Theme.muted; font.pixelSize: Theme.secondary; Layout.fillWidth: true
    }
    CCheckBox { objectName: "codeEnabled"; visible: !code.info.refused; text: "Index this project’s code"; checked: code.info.enabled === true; enabled: !writer.busy; onClicked: code.configure({ enabled: checked }) }
    CCheckBox { objectName: "codeAllowCloud"; visible: code.info.enabled === true; text: "Hosted models and models on other computers may read it"; checked: code.info.allowCloud === true; enabled: !writer.busy; onClicked: code.configure({ allowCloud: checked }) }
    CText { objectName: "codeOffered"; visible: code.info.enabled === true && !!code.info.offered; text: code.info.offered || ""; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
    RowLayout {
        visible: code.info.enabled === true
        Layout.fillWidth: true; spacing: Theme.space2
        CField { id: query; objectName: "codeQuery"; Layout.fillWidth: true; placeholderText: "Find code by name or by what it does"; maximumLength: 500; Accessible.name: "Find code"; onAccepted: if (findButton.enabled) code.find() }
        CButton { id: findButton; objectName: "codeFind"; text: finder.busy ? "Looking…" : "Find"; enabled: !finder.busy && query.text.trim().length > 1; onClicked: code.find() }
    }
    CText { objectName: "codeNothing"; visible: code.searched && !code.results.length && !code.seen; text: "Nothing in the index matches."; color: Theme.muted; font.pixelSize: Theme.secondary }
    Repeater {
        model: code.seen ? [] : code.results
        CActionRow {
            id: result
            required property var modelData
            required property int index
            objectName: "codeResult_" + index
            Layout.fillWidth: true
            text: code.title(modelData)
            detail: modelData.kind + " · " + code.place(modelData)
            onClicked: code.look({ id: modelData.id })
        }
    }
    ColumnLayout {
        visible: !!code.seen
        Layout.fillWidth: true; spacing: Theme.space2
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CText { objectName: "codeSymbol"; text: code.seen ? code.seen.symbol.kind + " " + code.title(code.seen.symbol) : ""; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            CButton { objectName: "codeBack"; text: "Back"; quiet: true; implicitHeight: Theme.compactHeight; visible: code.results.length > 0; onClicked: code.seen = null }
            CButton { objectName: "codeOpen"; text: "Open file"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: App.openPath(code.info.project + "/" + code.seen.symbol.path) }
        }
        CText { objectName: "codePlace"; text: code.seen ? code.seen.symbol.path + ", " + code.lines(code.seen.symbol) + (code.seen.symbol.confidence === "guess" ? " · inferred from its shape" : "") : ""; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        CText { visible: !!code.seen && !!code.seen.symbol.about; text: code.seen ? code.seen.symbol.about : ""; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        ScrollView {
            id: sourceView
            visible: !!code.seen && code.seen.source.length > 0
            Layout.fillWidth: true; Layout.preferredHeight: Math.min(Theme.editorMedium, sourceText.implicitHeight); clip: true
            ScrollBar.vertical: CScrollBar { parent: sourceView; x: sourceView.width - width; height: sourceView.availableHeight }
            TextArea {
                id: sourceText
                objectName: "codeSource"
                readOnly: true; selectByMouse: true; text: code.seen ? code.seen.source + (code.seen.sourceCut ? "\n…" : "") : ""; textFormat: TextEdit.PlainText; wrapMode: TextEdit.WrapAnywhere
                color: Theme.text; font.family: Theme.mono; font.pixelSize: Theme.caption
                Accessible.name: "Source"
                background: Rectangle { color: Theme.input; radius: Theme.radiusChip }
            }
        }
        Repeater {
            model: code.groups
            ColumnLayout {
                id: group
                required property var modelData
                Layout.fillWidth: true; spacing: Theme.space1
                CText { text: group.modelData.name + " (" + group.modelData.rows.length + ")"; font.pixelSize: Theme.secondary; font.weight: Font.DemiBold }
                Repeater {
                    model: group.modelData.rows.slice(0, 12)
                    RowLayout {
                        id: related
                        required property var modelData
                        required property int index
                        Layout.fillWidth: true; spacing: Theme.space2
                        CButton { objectName: "codeRelated_" + group.modelData.id + "_" + related.index; visible: !!related.modelData.symbol; text: related.modelData.symbol ? code.title(related.modelData.symbol) : ""; quiet: true; implicitHeight: Theme.compactHeight; Layout.maximumWidth: Theme.fieldLong; onClicked: code.look({ id: related.modelData.symbol.id }) }
                        CText { text: related.modelData.symbol ? code.place(related.modelData) : (related.modelData.name ? related.modelData.name + " · " : "") + (related.modelData.outside ? related.modelData.path : code.place(related.modelData)); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                        CText { objectName: "codeSure_" + group.modelData.id + "_" + related.index; visible: text.length > 0; text: code.sure(related.modelData); color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: false }
                    }
                }
                CText { visible: group.modelData.rows.length > 12; text: "and " + (group.modelData.rows.length - 12) + " more"; color: Theme.muted; font.pixelSize: Theme.caption }
            }
        }
        CText { text: "Read from the text of the files: “possible” and “one of several” are inferred from names, and something not listed may still be used."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        CText { visible: code.offerable.length > 0 || !!code.seen && code.seen.decisions.length > 0; text: "Decisions about this code"; font.pixelSize: Theme.secondary; font.weight: Font.DemiBold }
        Repeater {
            model: code.seen ? code.seen.decisions : []
            RowLayout {
                id: decision
                required property var modelData
                required property int index
                Layout.fillWidth: true; spacing: Theme.space2
                CText { objectName: "codeDecision_" + decision.index; text: decision.modelData.text; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
                CButton { objectName: "codeUnlink_" + decision.index; text: "Remove"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !writer.busy; onClicked: writer.call("code.unlink", { sessionId: code.sessionId, id: decision.modelData.id }, value => { if (value.error) code.error = value.error; code.look({ id: code.seen.symbol.id }) }) }
            }
        }
        RowLayout {
            visible: code.offerable.length > 0
            Layout.fillWidth: true; spacing: Theme.space2
            CComboBox { id: decisionChoice; objectName: "codeDecisionChoice"; Layout.fillWidth: true; model: code.offerable.map(item => item.text); Accessible.name: "Decision of this project" }
            CButton { objectName: "codeLink"; text: "Tie to this code"; enabled: !writer.busy && decisionChoice.currentIndex >= 0; onClicked: writer.call("code.link", { sessionId: code.sessionId, key: code.seen.symbol.key, decision: code.offerable[decisionChoice.currentIndex].hash }, value => { if (value.error) code.error = value.error; code.look({ id: code.seen.symbol.id }) }) }
        }
    }
    CText { objectName: "codeError"; visible: !!code.error; text: code.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; Accessible.role: Accessible.AlertMessage }
}
