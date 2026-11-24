pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A document for other people: write one from a template, or export a reply, a file or a conversation as PDF, Word, a
// web page or Markdown. Each export is a new file of the conversation; what it came from is never changed.
CDialog {
    id: writer
    objectName: "documentExportDialogFor"
    preferredWidth: writing ? Theme.dialogLarge : Theme.dialogWidth
    property string sessionId: ""
    // { markdown } | { artifactId, versionId } | { rootId, path } | { conversation, messageIds }; empty while writing.
    property var source: ({})
    property string sourceName: ""
    property bool writing: false
    property bool preview: false
    property string error: ""
    property string notice: ""
    property var formats: []
    property var templates: []
    property var saved: null
    property bool touched: false
    readonly property var format: formats[formatBox.currentIndex] || null
    readonly property var temporary: (App.state.sessions || []).find(item => item.id === sessionId)?.temporary === true
    RpcClient { id: rpc; scope: writer.sessionId + "|" + writer.opened }
    function failed(value) { if (!value.error) return false; error = String(value.error.message || value.error); return true }
    function start() {
        error = ""; notice = ""; saved = null; preview = false; touched = false
        open()
        rpc.call("documents.formats", {}, value => {
            if (writer.failed(value)) return
            formats = value.formats; templates = value.templates
            formatBox.currentIndex = Math.max(0, formats.findIndex(item => item.available))
        })
    }
    /** Exports something that exists. */
    function openFor(id, given, name) { sessionId = id; source = given; sourceName = name || ""; writing = false; titleField.text = ""; editor.text = ""; start() }
    /** Writes a new document, from a template when one is chosen. */
    function openBlank(id, markdown) { sessionId = id; source = ({}); sourceName = ""; writing = true; titleField.text = ""; editor.text = markdown || ""; templateBox.currentIndex = 0; start(); Qt.callLater(() => titleField.forceActiveFocus()) }
    function applyTemplate(id) {
        if (!id) { editor.text = ""; touched = false; return }
        rpc.call("documents.fill", { sessionId: sessionId, template: id, title: titleField.text }, value => { if (writer.failed(value)) return; editor.text = value.markdown; if (!titleField.text) titleField.text = value.title; touched = false })
    }
    function keep(done) {
        error = ""
        rpc.call("documents.save", Object.assign({ sessionId: sessionId, title: titleField.text || "Document", markdown: editor.text }, saved ? { artifactId: saved.artifactId, versionId: saved.versionId } : {}), value => {
            if (writer.failed(value)) return
            saved = value; touched = false
            if (done) done(value); else notice = value.name + " is kept with this conversation."
        })
    }
    function make() {
        error = ""; notice = ""
        const params = Object.assign({ sessionId: sessionId, format: format.id, page: pageBox.currentIndex === 1 ? "Letter" : "A4" }, titleField.text.trim() ? { title: titleField.text.trim() } : {}, writing ? { markdown: editor.text } : source)
        rpc.call("documents.render", params, value => {
            if (writer.failed(value)) return
            const path = App.chooseSavePath(value.name)
            if (!path) { notice = value.name + " is kept with this conversation."; return }
            rpc.call("artifacts.saveAs", { sessionId: sessionId, artifactId: value.artifactId, versionId: value.versionId, path: path, replace: true }, result => { if (!writer.failed(result)) { notice = "Saved " + path; openSaved.path = path } })
        })
    }
    onOpenedChanged: if (!opened) openSaved.path = ""
    CText { text: writer.writing ? "Write a document" : "Export as a document"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
    CText { visible: !writer.writing; text: writer.sourceName ? "“" + writer.sourceName + "” becomes a new file. The original stays as it is." : "This becomes a new file of the conversation."; color: Theme.muted; font.pixelSize: Theme.secondary }
    GridLayout {
        Layout.fillWidth: true; columns: writer.width < Theme.dialogWidth ? 1 : 2; columnSpacing: Theme.space2; rowSpacing: Theme.space2
        CField { id: titleField; objectName: "documentTitle"; Layout.fillWidth: true; placeholderText: writer.writing ? "Title" : "Title (from its first heading when empty)"; Accessible.name: "Title" }
        CComboBox {
            id: templateBox; objectName: "documentTemplate"; visible: writer.writing; Layout.fillWidth: true; Accessible.name: "Template"
            model: ["No template"].concat(writer.templates.map(item => item.name))
            onActivated: index => { if (writer.touched && editor.text.trim()) replaceTemplate.open(); else writer.applyTemplate(index > 0 ? writer.templates[index - 1].id : "") }
        }
    }
    CText { visible: writer.writing && templateBox.currentIndex > 0; text: writer.templates[templateBox.currentIndex - 1]?.purpose || ""; color: Theme.muted; font.pixelSize: Theme.caption }
    RowLayout {
        visible: writer.writing; Layout.fillWidth: true; spacing: Theme.space2
        CText { Layout.fillWidth: true; text: "Markdown: # headings, - lists, | tables |, [^1] notes"; color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
        CButton { objectName: "documentPreview"; text: writer.preview ? "Edit" : "Preview"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: writer.preview = !writer.preview }
    }
    ScrollView {
        visible: writer.writing && !writer.preview; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorLarge; clip: true
        CTextArea { id: editor; objectName: "documentEditor"; textFormat: TextEdit.PlainText; wrapMode: TextEdit.Wrap; selectByMouse: true; font.family: Theme.mono; placeholderText: "Write here, or choose a template to start from."; Accessible.name: "Document text"; onTextChanged: if (activeFocus) writer.touched = true }
    }
    ScrollView {
        visible: writer.writing && writer.preview; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorLarge; clip: true; contentWidth: availableWidth
        Text { objectName: "documentRendered"; width: parent.width; text: editor.text.replace(/<[^>]*>/g, ""); textFormat: Text.MarkdownText; wrapMode: Text.Wrap; color: Theme.text; font.family: Theme.font; font.pixelSize: Theme.body; onLinkActivated: link => App.openMessageLink(link, "") }
    }
    GridLayout {
        Layout.fillWidth: true; columns: 2; columnSpacing: Theme.space2; rowSpacing: Theme.space2
        CComboBox { id: formatBox; objectName: "documentFormat"; Layout.fillWidth: true; model: writer.formats.map(item => item.label); Accessible.name: "Format" }
        CComboBox { id: pageBox; objectName: "documentPage"; Layout.fillWidth: true; visible: !!writer.format && ["pdf", "docx"].includes(writer.format.id); model: ["A4", "Letter"]; currentIndex: /^en_(US|CA)/.test(Qt.locale().name) ? 1 : 0; Accessible.name: "Page size" }
    }
    CText { objectName: "documentFormatReason"; visible: writer.format?.available === false; text: writer.format?.reason || ""; color: Theme.amber; font.pixelSize: Theme.secondary }
    CText { visible: writer.temporary; text: "Temporary conversations do not keep files."; color: Theme.amber; font.pixelSize: Theme.secondary }
    CText { objectName: "documentError"; visible: !!writer.error; text: writer.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    RowLayout {
        visible: !!writer.notice && !writer.error; Layout.fillWidth: true; spacing: Theme.space2
        CText { objectName: "documentNotice"; Layout.fillWidth: true; text: writer.notice; color: Theme.accentText; font.pixelSize: Theme.secondary; wrapMode: Text.WrapAnywhere; Accessible.role: Accessible.StatusBar }
        CButton { id: openSaved; property string path: ""; visible: !!path; text: "Open"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: App.openPath(path) }
    }
    Flow {
        Layout.fillWidth: true; spacing: Theme.space2
        CButton { text: "Close"; onClicked: writer.close() }
        CButton { objectName: "documentKeep"; visible: writer.writing; text: "Keep as a file"; enabled: editor.text.trim().length > 0 && !rpc.busy && !writer.temporary; onClicked: writer.keep(null) }
        CButton { objectName: "documentMake"; text: rpc.busy ? "Working…" : "Save as…"; primary: true; enabled: !!writer.format && writer.format.available && !rpc.busy && !writer.temporary && (!writer.writing || editor.text.trim().length > 0); onClicked: writer.make() }
    }
    CDialog {
        id: replaceTemplate; objectName: "documentReplace"
        CText { text: "Replace what you wrote?"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: "The template takes the place of the text in this document."; color: Theme.muted; font.pixelSize: Theme.secondary }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { text: "Keep my text"; Layout.fillWidth: true; onClicked: replaceTemplate.close() }
            CButton { text: "Replace it"; danger: true; Layout.fillWidth: true; onClicked: { replaceTemplate.close(); writer.applyTemplate(templateBox.currentIndex > 0 ? writer.templates[templateBox.currentIndex - 1].id : "") } }
        }
    }
}
