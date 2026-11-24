pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// What can be done with one kept or workspace file beyond opening it: read its text, check a table, translate it, see
// an image's details, add it to a document collection, or put it in a folder as a reviewed change. Only the actions
// that apply to the file are offered. Originals are never overwritten.
Item {
    id: tools
    objectName: "documentTools"
    property string sessionId: ""
    // A kept file { artifactId, versionId, name, mime, kind } or a workspace file { rootId, path, version, name }.
    property var target: ({})
    property var roots: []
    property string error: ""
    signal done(string message)
    signal refreshRequested()
    signal settingsRequested(string category, string target)
    readonly property string name: target.name || String(target.path || "").split("/").pop() || "file"
    readonly property bool kept: !!target.artifactId
    readonly property string mime: target.mime || ""
    readonly property bool image: target.kind === "image" || target.kind === "plot" || mime.startsWith("image/")
    readonly property bool recording: kept && (/^(audio|video)\//.test(mime) || /vtt|subrip/.test(mime))
    readonly property bool table: /\.(csv|tsv)$/i.test(name) || /csv|tab-separated/.test(mime)
    readonly property bool textual: kept ? /^text\/|json|markdown|xml|vtt|subrip/.test(mime) : workspaceText.test(name)
    readonly property var workspaceText: /\.(md|markdown|txt|text|rst|adoc|csv|tsv|json|xml|html?|vtt|srt|org|tex)$/i
    readonly property var workspacePage: /\.(html?|xhtml|svg)$/i
    readonly property bool readable: kept && !image && !/^(audio|video)\//.test(mime) && mime !== "application/octet-stream"
    readonly property bool page: !kept && workspacePage.test(name)
    /** Whether a workspace file has any action here. */
    function offers(file) { return !!file.path && (workspaceText.test(file.path) || workspacePage.test(file.path)) }
    readonly property var ref: kept ? ({ sessionId: sessionId, artifactId: target.artifactId, versionId: target.versionId }) : ({ sessionId: sessionId, rootId: target.rootId, path: target.path })
    RpcClient { id: rpc; scope: tools.sessionId + "|" + (tools.target.versionId || tools.target.path || "") }
    function openMenu(file) { target = file || {}; error = ""; menu.popup() }
    function failed(value) { error = String(value.error.message || value.error); return error }
    function refOnly() { return kept ? { artifactId: target.artifactId, versionId: target.versionId } : { kind: "file", rootId: target.rootId, path: target.path } }
    DocumentExport { id: documentExport }
    CMenu {
        id: menu; objectName: "documentMenu"
        CMenuItem { objectName: "documentListen"; visible: tools.recording; text: "Open in Media"; onTriggered: WorkbenchState.openRecording(tools.sessionId, { artifactId: tools.target.artifactId, versionId: tools.target.versionId }) }
        CMenuItem { objectName: "documentRead"; visible: tools.readable; text: "Read its text…"; onTriggered: reader.show() }
        CMenuItem { objectName: "documentTable"; visible: tools.table; text: "Check the table…"; onTriggered: tableDialog.show() }
        CMenuItem { objectName: "documentCanvas"; visible: tools.page; text: "Preview in Canvas"; onTriggered: WorkbenchState.openCanvas(tools.sessionId, tools.target.rootId, tools.target.path) }
        CMenuItem { objectName: "documentTranslate"; visible: tools.textual; text: "Translate…"; onTriggered: translate.show() }
        CMenuItem { objectName: "documentDetails"; visible: tools.kept && tools.image; text: "Image details…"; onTriggered: details.show() }
        CMenuItem { objectName: "documentAs"; visible: tools.textual && !tools.page && !/html/.test(tools.mime); text: "Export as PDF or Word…"; onTriggered: documentExport.openFor(tools.sessionId, tools.kept ? { artifactId: tools.target.artifactId, versionId: tools.target.versionId } : { rootId: tools.target.rootId, path: tools.target.path }, tools.name) }
        CMenuItem { objectName: "documentCollect"; visible: tools.kept && tools.textual; text: "Add to a document collection…"; onTriggered: collect.show() }
        CMenuItem { objectName: "documentExport"; visible: tools.kept; text: "Put in a folder…"; onTriggered: exporter.show() }
    }
    CDialog {
        id: reader; objectName: "documentReader"
        preferredWidth: Theme.dialogLarge
        property var value: null
        property string problem: ""
        readonly property bool pdf: tools.mime === "application/pdf"
        readonly property string wholeText: value ? value.units.map(unit => unit.text).join("\n\n") : ""
        function locator(unit) { return Object.entries(unit.locator || {}).map(pair => pair[0] + " " + pair[1]).join(", ") }
        function show() { value = null; problem = ""; fromPage.clear(); toPage.clear(); open(); read() }
        function read() {
            problem = ""
            const options = {}
            if (fromPage.text) options.fromPage = Number(fromPage.text)
            if (toPage.text) options.toPage = Number(toPage.text)
            rpc.call("artifacts.extract", Object.assign({}, tools.ref, Object.keys(options).length ? { options: options } : {}), value => { if (value.error) reader.problem = tools.failed(value); else reader.value = value })
        }
        CText { text: "Text of " + tools.name; font.pixelSize: Theme.title; font.weight: Font.DemiBold; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
        CText { visible: rpc.busy; text: "Reading the document…"; color: Theme.muted }
        CText { objectName: "readerStatus"; visible: !!reader.value; color: Theme.muted; font.pixelSize: Theme.secondary
            text: reader.value ? (reader.value.status === "complete" ? "All of it was read" : reader.value.status === "partial" ? "Part of it was read" : "No text was found") + (reader.value.reused ? " · read before" : "") + ". Reading is not understanding: layout, pictures and embedded objects are not included." : "" }
        Repeater { model: reader.value?.warnings || []; CText { required property string modelData; text: modelData; color: Theme.amber; font.pixelSize: Theme.secondary } }
        CText { visible: !!reader.problem; text: reader.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            visible: reader.pdf; Layout.fillWidth: true; spacing: Theme.space2
            CField { id: fromPage; objectName: "readerFrom"; Layout.preferredWidth: Theme.fieldTiny; placeholderText: "From"; validator: IntValidator { bottom: 1; top: 99999 } Accessible.name: "First page" }
            CField { id: toPage; Layout.preferredWidth: Theme.fieldTiny; placeholderText: "To"; validator: IntValidator { bottom: 1; top: 99999 } Accessible.name: "Last page" }
            CButton { text: "Read these pages"; enabled: !rpc.busy; onClicked: reader.read() }
            Item { Layout.fillWidth: true }
        }
        ListView {
            id: units; objectName: "readerUnits"
            visible: count > 0; Layout.fillWidth: true; Layout.preferredHeight: Theme.bubbleHeight; clip: true; spacing: Theme.space3; activeFocusOnTab: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            model: reader.value?.units || []
            delegate: ColumnLayout {
                required property var modelData
                width: units.width - Theme.space4; spacing: Theme.space1
                CText { text: reader.locator(parent.modelData); visible: !!text; color: Theme.accentText; font.pixelSize: Theme.caption }
                CText { text: parent.modelData.text; wrapMode: Text.Wrap }
            }
        }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "readerSpeak"; Layout.fillWidth: true; visible: App.state.speech !== undefined; text: "Read aloud"; help: "Speaks the first 20,000 characters on this computer"; enabled: reader.wholeText.length > 0; onClicked: App.rpc("tts.speak", { text: reader.wholeText.slice(0, 20000) }) }
            CButton { Layout.fillWidth: true; visible: App.state.speech !== undefined; text: "Stop speaking"; onClicked: App.rpc("tts.stop", {}) }
            CButton { Layout.fillWidth: true; text: "Copy text"; enabled: reader.wholeText.length > 0; onClicked: App.copy(reader.wholeText) }
            CButton { Layout.fillWidth: true; text: "Close"; onClicked: reader.close() }
        }
    }
    CDialog {
        id: tableDialog; objectName: "documentTableDialog"
        preferredWidth: Theme.dialogLarge
        property var value: null
        property string problem: ""
        function show() { value = null; problem = ""; open(); rpc.call("tables.preview", tools.ref, value => { if (value.error) tableDialog.problem = tools.failed(value); else tableDialog.value = value }) }
        CText { text: tools.name; font.pixelSize: Theme.title; font.weight: Font.DemiBold; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
        CText { visible: rpc.busy; text: "Reading the table…"; color: Theme.muted }
        CText { visible: !!tableDialog.problem; text: tableDialog.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        TableSummary { visible: !!tableDialog.value; table: tableDialog.value }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { Layout.fillWidth: true; visible: tools.kept; text: "Analyze in Code Lab"; onClicked: { tableDialog.close(); WorkbenchState.openAnalysis(tools.sessionId, { inputs: [tools.refOnly()] }) } }
            CButton { Layout.fillWidth: true; text: "Close"; onClicked: tableDialog.close() }
        }
    }
    CDialog {
        id: translate; objectName: "documentTranslateDialog"
        property string problem: ""
        property var made: null
        property string summary: ""
        function show() { problem = ""; made = null; summary = ""; open(); language.forceActiveFocus() }
        function glossary() { return terms.text.split("\n").map(line => line.split("=")).filter(pair => pair.length >= 2 && pair[0].trim()).map(pair => ({ source: pair[0].trim(), target: pair.slice(1).join("=").trim() })) }
        function run() {
            problem = ""; made = null; summary = ""
            rpc.call("translate.run", { sessionId: tools.sessionId, targetLanguage: language.text.trim(), input: tools.refOnly(), glossary: glossary() }, value => {
                if (value.error) { translate.problem = tools.failed(value).replace("The user can choose one", "Choose one"); return }
                if (value.status !== "completed") { translate.problem = value.error?.message || value.summary || "The translation did not finish."; return }
                translate.summary = value.summary || "Translated."; translate.made = (value.artifacts || [])[0] || null
                tools.refreshRequested()
            })
        }
        CText { text: "Translate " + tools.name; font.pixelSize: Theme.title; font.weight: Font.DemiBold; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
        CText { text: "The text helper makes a new file beside the original. Headings, lists, quotes and code stay as they are. The text is sent to the helper’s model if this file’s folder allows it."; color: Theme.muted; font.pixelSize: Theme.secondary }
        CField { id: language; objectName: "translateLanguage"; Layout.fillWidth: true; maximumLength: 40; placeholderText: "Language, such as German or Brazilian Portuguese"; Accessible.name: "Language to translate into"; onAccepted: if (translateRun.enabled) translateRun.clicked() }
        CTextArea { id: terms; objectName: "translateGlossary"; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorShort; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; placeholderText: "Terms to keep, one per line: term = translation"; Accessible.name: "Glossary, one term and its translation per line" }
        CText { objectName: "translateProblem"; visible: !!translate.problem; text: translate.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { objectName: "translateDone"; visible: !!translate.summary; text: translate.summary; color: Theme.accentText; font.pixelSize: Theme.secondary }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { id: translateRun; objectName: "translateRun"; Layout.fillWidth: true; primary: true; text: rpc.busy ? "Translating…" : "Translate"; enabled: App.connected && !rpc.busy && language.text.trim().length >= 2; onClicked: translate.run() }
            CButton { Layout.fillWidth: true; visible: /text helper/.test(translate.problem); text: "Choose a helper"; onClicked: { translate.close(); tools.settingsRequested("connections", "imageConnections") } }
            CButton { Layout.fillWidth: true; visible: !!translate.made; text: "Open the translation"; onClicked: rpc.call("artifacts.file", { sessionId: tools.sessionId, artifactId: translate.made.artifactId, versionId: translate.made.versionId }, value => { if (value.error) translate.problem = tools.failed(value); else App.openPath(value.path) }) }
            CButton { Layout.fillWidth: true; text: "Close"; onClicked: translate.close() }
        }
    }
    CDialog {
        id: details; objectName: "documentDetailsDialog"
        property var value: null
        property string problem: ""
        readonly property var rows: {
            if (!value) return []
            const p = value.provenance || {}
            return [["Size", value.width + " × " + value.height + " pixels"], ["Format", String(value.format || "").toUpperCase()], ["Colour space", value.space],
                ["Transparency", value.alpha ? (value.opaquePercent !== undefined ? value.opaquePercent + "% opaque" : "yes") : "none"], ["Frames", value.frames], ["Orientation tag", value.exifOrientation],
                ["How it was made", p.kind], ["Backend", [p.connection || p.backend, p.model].filter(part => !!part).join(" · ")], ["Prompt", p.prompt]].filter(row => row[1] !== undefined && row[1] !== null && String(row[1]).length > 0)
        }
        function show() { value = null; problem = ""; open(); rpc.call("images.inspect", tools.ref, value => { if (value.error) details.problem = tools.failed(value); else details.value = value }) }
        CText { text: tools.name; font.pixelSize: Theme.title; font.weight: Font.DemiBold; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
        CText { visible: rpc.busy; text: "Reading the image…"; color: Theme.muted }
        CText { visible: !!details.problem; text: details.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        Repeater {
            model: details.rows
            RowLayout {
                required property var modelData
                Layout.fillWidth: true; spacing: Theme.space3
                CText { Layout.fillWidth: false; Layout.preferredWidth: Theme.fieldMedium; Layout.alignment: Qt.AlignTop; text: parent.modelData[0]; color: Theme.muted }
                CText { text: String(parent.modelData[1]) }
            }
        }
        CText { visible: !!details.value?.note; text: details.value?.note || ""; color: Theme.amber; font.pixelSize: Theme.secondary }
        CButton { Layout.fillWidth: true; text: "Close"; onClicked: details.close() }
    }
    CDialog {
        id: collect; objectName: "documentCollectDialog"
        property var collections: []
        property bool loaded: false
        property string problem: ""
        function show() { collections = []; loaded = false; problem = ""; open(); rpc.call("collections.list", {}, value => { collect.loaded = true; if (value.error) collect.problem = tools.failed(value); else collect.collections = value.collections || value || [] }) }
        CText { text: "Add to a document collection"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: "A copy of this version is indexed on this computer. Cloud models read a collection only if it allows them to."; color: Theme.muted; font.pixelSize: Theme.secondary }
        CText { visible: collect.loaded && !collect.collections.length; text: "There are no collections yet. Make one under More › Document collections…"; color: Theme.muted }
        CComboBox { id: collectionChoice; objectName: "collectChoice"; visible: collect.collections.length > 0; Layout.fillWidth: true; model: collect.collections; textRole: "name"; Accessible.name: "Document collection" }
        CText { visible: !!collect.problem; text: collect.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "collectAdd"; Layout.fillWidth: true; primary: true; text: rpc.busy ? "Adding…" : "Add"; enabled: App.connected && !rpc.busy && collectionChoice.currentIndex >= 0 && collect.collections.length > 0
                onClicked: { const chosen = collect.collections[collectionChoice.currentIndex]; rpc.call("collections.addArtifact", Object.assign({ id: chosen.id }, tools.ref), value => { if (value.error) { collect.problem = tools.failed(value); return } collect.close(); tools.done("Added to " + chosen.name + ".") }) } }
            CButton { Layout.fillWidth: true; text: "Cancel"; onClicked: collect.close() }
        }
    }
    CDialog {
        id: exporter; objectName: "documentExportDialog"
        property var choices: []
        property bool loaded: false
        property string problem: ""
        function show() {
            choices = []; loaded = false; problem = ""; exportPath.text = tools.name; open()
            rpc.call("workspace.roots", { sessionId: tools.sessionId }, value => { exporter.loaded = true; if (value.error) exporter.problem = tools.failed(value); else exporter.choices = (value.roots || []).filter(root => root.policy.write && root.status === "available") })
        }
        CText { text: "Put in a folder"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: "PAL prepares a change that you review before anything is written. An existing file is never replaced without showing it."; color: Theme.muted; font.pixelSize: Theme.secondary }
        CText { visible: exporter.loaded && !exporter.choices.length; text: "No folder of this conversation allows changes. Allow editing under Files › Folder permissions."; color: Theme.amber }
        CComboBox { id: exportRoot; objectName: "exportRoot"; visible: exporter.choices.length > 0; Layout.fillWidth: true; model: exporter.choices; textRole: "name"; Accessible.name: "Folder" }
        CField { id: exportPath; objectName: "exportPath"; visible: exporter.choices.length > 0; Layout.fillWidth: true; maximumLength: 1024; placeholderText: "Path inside the folder"; Accessible.name: "Path inside the folder" }
        CText { visible: !!exporter.problem; text: exporter.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "exportReview"; Layout.fillWidth: true; primary: true; text: rpc.busy ? "Preparing…" : "Review the change"; enabled: App.connected && !rpc.busy && exporter.choices.length > 0 && exportRoot.currentIndex >= 0 && exportPath.text.trim().length > 0
                onClicked: rpc.call("artifacts.export", Object.assign({}, tools.ref, { rootId: exporter.choices[exportRoot.currentIndex].id, path: exportPath.text.trim() }), value => { if (value.error) { exporter.problem = tools.failed(value); return } exporter.close(); WorkbenchState.openReview(value.id, tools.sessionId) }) }
            CButton { Layout.fillWidth: true; text: "Cancel"; onClicked: exporter.close() }
        }
    }
}
