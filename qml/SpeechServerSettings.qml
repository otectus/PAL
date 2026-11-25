import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M10: a speech server on this computer, as another way to turn a recording into words.
ColumnLayout {
    id: server
    required property var saved
    // Read through a property of its own: every state push replaces `saved`, which would reset what is being typed.
    readonly property string savedUrl: saved.serverUrl || ""
    readonly property string savedModel: saved.serverModel || ""
    property string feedback: ""
    property bool failed: false
    readonly property bool typed: address.text.trim().length > 0
    spacing: Theme.space2
    function save() {
        feedback = ""; failed = false
        rpc.call("settings.update", { transcription: { provider: "local-server", serverUrl: address.text.trim(), serverModel: model.value } }, value => { server.failed = !!value.error; server.feedback = value.error || "Saved." })
    }
    function check() {
        feedback = ""; failed = false
        rpc.call("transcription.checkServer", { url: address.text.trim() }, value => { server.failed = !!value.error || !value.answers; server.feedback = value.error || value.detail })
    }
    RpcClient { id: rpc }
    CField { id: address; objectName: "speechServerAddress"; Layout.fillWidth: true; placeholderText: "http://127.0.0.1:8080"; maximumLength: 200; saved: server.savedUrl; Accessible.name: "Speech server address"; onAccepted: if (server.typed) server.save() }
    ModelPicker { id: model; name: "speechServerModel"; Layout.fillWidth: true; provider: server.savedUrl ? "local-server" : ""; url: server.savedUrl; operation: "speech.transcribe"; saved: server.savedModel; emptyText: "The server’s default model"; label: "Speech server model"; maximumLength: 160; onAccepted: if (server.typed) server.save() }
    RowLayout {
        Layout.fillWidth: true; spacing: Theme.space2
        CButton { objectName: "speechServerSave"; text: "Save"; enabled: server.typed && !rpc.busy; onClicked: server.save() }
        CButton { objectName: "speechServerCheck"; text: "Check"; quiet: true; enabled: server.typed && !rpc.busy; onClicked: server.check() }
        CText { objectName: "speechServerFeedback"; text: server.feedback; color: server.failed ? Theme.danger : Theme.accentText; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    }
    CText { text: "whisper.cpp’s whisper-server works as it is. For a server with OpenAI’s form, end the address in /v1. Only addresses on this computer are accepted, and PAL does not start the server."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
}
