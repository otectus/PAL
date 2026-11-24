pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › AI assistance › Service manifests (broker/provider-manifests.ts): which tool of a reviewed tool server
// provides a service. A manifest adds no code, key or permission, and is checked again each time it runs.
ColumnLayout {
    id: manifests
    Layout.fillWidth: true
    spacing: Theme.space2
    property var records: []
    property string error: ""
    readonly property var names: ({ inference: "Inference", "speech.transcribe": "Transcribe speech", "speech.synthesize": "Speak text", embed: "Embed text", search: "Search", "storage.upsert": "Store", "storage.query": "Query stored items", "storage.delete": "Delete stored items" })
    readonly property var servers: App.state.settings?.extensions || []
    function server(id) { return servers.find(item => item.id === id)?.name || "a tool server that is not installed" }
    function problem(value) { return String(value.error.message || value.error) }
    function load() { if (App.connected) rpc.call("providerManifests.list", {}, value => { if (value.error) manifests.error = manifests.problem(value); else { manifests.records = value; manifests.error = "" } }) }
    RpcClient { id: rpc }
    readonly property bool online: App.connected
    onOnlineChanged: if (online) load()
    Component.onCompleted: load()
    Repeater {
        model: manifests.records
        ColumnLayout {
            id: row
            required property var modelData
            required property int index
            Layout.fillWidth: true; spacing: Theme.space1
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space2
                CText { text: row.modelData.manifest.label; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                CButton { objectName: "manifestTry_" + row.index; text: "Try…"; quiet: true; implicitHeight: Theme.compactHeight; enabled: App.connected && !!App.session.id; help: App.session.id ? "Run one operation as the selected conversation" : "Select a conversation first"; onClicked: trial.openFor(row.modelData) }
                CButton { objectName: "manifestRemove_" + row.index; text: "Remove"; quiet: true; danger: true; implicitHeight: Theme.compactHeight; enabled: App.connected && !rpc.busy; onClicked: rpc.call("providerManifests.remove", { id: row.modelData.manifest.id, revision: row.modelData.revision }, value => { if (value.error) manifests.error = manifests.problem(value); manifests.load() }) }
            }
            Repeater {
                model: row.modelData.manifest.operations
                CText { required property var modelData; text: (manifests.names[modelData.operation] || modelData.operation) + " · " + modelData.tool + " on " + manifests.server(modelData.serverId); color: Theme.muted; font.pixelSize: Theme.secondary }
            }
        }
    }
    CText { visible: !manifests.records.length && !manifests.error; text: "No service manifests."; color: Theme.muted; font.pixelSize: Theme.secondary }
    CText { visible: !!manifests.error; text: manifests.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    CButton { objectName: "manifestAdd"; text: "Add from a file…"; enabled: App.connected; onClicked: { const json = App.chooseJson("Choose a service manifest"); if (json) review.openWith(json) } }
    CDialog {
        id: review; objectName: "manifestReview"
        property var value: null
        property string problem: ""
        property var expected: null
        function openWith(json) {
            value = null; problem = ""; open()
            let manifest
            try { manifest = JSON.parse(json) } catch (failure) { problem = "This file is not JSON."; return }
            const prior = manifests.records.find(item => item.manifest.id === manifest?.id)
            expected = prior ? prior.revision : null
            rpc.call("providerManifests.preview", { manifest: manifest, expectedRevision: expected }, value => { if (value.error) review.problem = manifests.problem(value); else review.value = value })
        }
        CText { text: review.expected ? "Replace this service manifest?" : "Add this service manifest?"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { visible: !!review.value; text: review.value ? review.value.manifest.label + " · " + review.value.manifest.id : ""; font.weight: Font.DemiBold }
        Repeater {
            model: review.value?.manifest.operations || []
            CText { required property var modelData; text: (manifests.names[modelData.operation] || modelData.operation) + ": the tool “" + modelData.tool + "” on " + manifests.server(modelData.serverId); color: manifests.servers.some(item => item.id === modelData.serverId) ? Theme.text : Theme.amber }
        }
        Repeater { model: review.value?.manifest.fields || []; CText { required property var modelData; text: "Option: " + modelData.label + " (" + modelData.type + ")"; color: Theme.muted; font.pixelSize: Theme.secondary } }
        CText { visible: !!review.value; text: "The tool keeps its own review and approval. Nothing runs when you add this."; color: Theme.muted; font.pixelSize: Theme.secondary }
        CText { visible: !!review.problem; text: review.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { Layout.fillWidth: true; text: "Cancel"; onClicked: review.close() }
            CButton { objectName: "manifestSave"; Layout.fillWidth: true; primary: true; text: review.expected ? "Replace" : "Add"; enabled: !!review.value && App.connected && !rpc.busy
                onClicked: rpc.call("providerManifests.save", { manifest: review.value.manifest, expectedRevision: review.expected }, value => { if (value.error) { review.problem = manifests.problem(value); return } review.close(); manifests.load() }) }
        }
    }
    CDialog {
        id: trial; objectName: "manifestTrial"
        preferredWidth: Theme.dialogWide
        property var record: null
        property string result: ""
        property string problem: ""
        readonly property var operations: record ? record.manifest.operations : []
        function openFor(value) { record = value; result = ""; problem = ""; args.text = "{}"; operation.currentIndex = 0; open() }
        function run() {
            problem = ""; result = ""
            let value
            try { value = JSON.parse(args.text) } catch (failure) { problem = "The arguments are not JSON."; return }
            rpc.call("providerManifests.invoke", { id: record.manifest.id, revision: record.revision, operation: operations[operation.currentIndex].operation, sessionId: App.session.id, args: value }, reply => { if (reply.error) trial.problem = manifests.problem(reply); else trial.result = JSON.stringify(reply, null, 2).slice(0, 20000) })
        }
        CText { text: trial.record ? "Try " + trial.record.manifest.label : ""; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: "Runs as “" + (App.session.title || "the selected conversation") + "”, under its permissions. It may ask for approval."; color: Theme.muted; font.pixelSize: Theme.secondary }
        CComboBox { id: operation; Layout.fillWidth: true; model: trial.operations.map(item => manifests.names[item.operation] || item.operation); Accessible.name: "Operation" }
        CTextArea { id: args; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorMedium; font.family: Theme.mono; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; placeholderText: "{\"query\": \"…\"}"; Accessible.name: "Tool arguments as JSON" }
        CText { visible: !!trial.problem; text: trial.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CTextArea { visible: !!trial.result; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorTall; readOnly: true; font.family: Theme.mono; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; text: trial.result; Accessible.name: "Result" }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { Layout.fillWidth: true; text: "Close"; onClicked: trial.close() }
            CButton { objectName: "manifestRun"; Layout.fillWidth: true; primary: true; text: rpc.busy ? "Running…" : "Run"; enabled: App.connected && !rpc.busy && trial.operations.length > 0; onClicked: trial.run() }
        }
    }
}
