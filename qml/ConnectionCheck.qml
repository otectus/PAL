pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// What one saved account can do, in stages (broker/connection-tools.ts). The first stages cost nothing; trying a model
// sends short requests that the service may bill, and only when asked to.
CDialog {
    id: check
    objectName: "connectionCheck"
    /** A test supplies its own broker; the application leaves this unset. */
    property var app: null
    property string connectionId: ""
    property string provider: ""
    property string name: ""
    /** A compatible server's capabilities are declared by the person, so what was found can be kept. */
    property bool declares: false
    property var stages: []
    property var models: []
    property bool unlisted: false
    property var found: null
    property string error: ""
    property bool trying: false
    readonly property var tests: [{ id: "reply", label: "Reply" }, { id: "streaming", label: "Streaming" }, { id: "tools", label: "Tool call" }, { id: "images", label: "Images" }, { id: "structured", label: "Structured reply" }]
    property var chosen: ["reply"]
    signal declared(var found)
    function openFor(item) {
        connectionId = item.id || ""; provider = item.provider || item.kind || ""; name = item.name || item.label || ""; declares = item.kind === "compatible" && !!item.id
        stages = []; models = []; unlisted = false; found = null; error = ""; trying = false; chosen = ["reply"]; model.set("")
        open(); run([])
    }
    function choose(id, on) { chosen = tests.map(test => test.id).filter(test => test === id ? on : chosen.indexOf(test) >= 0) }
    function run(list) {
        error = ""; trying = list.length > 0
        const request = list.length ? { tests: list, model: model.value, paid: true } : {}
        if (connectionId) request.connectionId = connectionId; else request.provider = provider
        rpc.call("connections.check", request, value => {
            check.trying = false
            if (value.error) { check.error = String(value.error); return }
            check.stages = value.stages || []; check.models = value.models || []; check.unlisted = value.unlisted === true; check.found = value.found || null
            if (!model.value && check.models.length === 1) model.set(check.models[0].id)
        })
    }
    RpcClient { id: rpc; endpoint: check.app; scope: check.connectionId || check.provider }
    CText { text: "Check " + check.name; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
    Repeater {
        model: check.stages
        RowLayout {
            id: stage
            required property var modelData
            Layout.fillWidth: true; spacing: Theme.space2
            Accessible.role: Accessible.StaticText; Accessible.name: modelData.label + ", " + ({ ok: "fine", failed: "failed", unknown: "not known" })[modelData.state] + ". " + modelData.detail
            CIcon { name: stage.modelData.state === "ok" ? "check" : stage.modelData.state === "failed" ? "close" : "notice"; color: stage.modelData.state === "ok" ? Theme.accentText : stage.modelData.state === "failed" ? Theme.danger : Theme.amber; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall; Layout.alignment: Qt.AlignTop }
            CText { text: stage.modelData.label; font.weight: Font.DemiBold; Layout.fillWidth: false; Layout.preferredWidth: Theme.fieldShort; Layout.alignment: Qt.AlignTop }
            CText { objectName: "checkStage_" + stage.modelData.id; text: stage.modelData.detail; color: stage.modelData.state === "failed" ? Theme.danger : Theme.muted; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        }
    }
    CText { objectName: "checkBusy"; visible: rpc.busy; text: check.trying ? "Trying the model…" : "Checking…"; color: Theme.accentText; font.pixelSize: Theme.secondary }
    CText { objectName: "checkError"; visible: !!check.error; text: check.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
    SectionLabel { text: "TRY A MODEL" }
    ModelPicker { id: model; app: check.app; name: "checkModel"; Layout.fillWidth: true; given: check.models; label: "Model to try"; placeholder: "Model ID to try" }
    Flow {
        Layout.fillWidth: true; spacing: Theme.space3
        Repeater {
            model: check.tests
            CCheckBox { required property var modelData; objectName: "checkTest_" + modelData.id; width: implicitContentWidth + leftPadding + rightPadding; text: modelData.label; checked: check.chosen.indexOf(modelData.id) >= 0; enabled: !rpc.busy; onClicked: check.choose(modelData.id, checked) }
        }
    }
    CText { text: check.provider === "ollama" ? "This loads the model on its server and sends it short requests. Nothing is kept as a conversation." : "Each sends one short request with this account. The service may bill it. Nothing is kept as a conversation."; color: Theme.muted; font.pixelSize: Theme.caption }
    CButton { objectName: "checkDeclare"; visible: check.declares && !!check.found && check.found.reply === true; text: "Use what was found"; quiet: true; enabled: !rpc.busy; help: "Sets what this connection declares to what worked"; onClicked: { check.declared(check.found); check.close() } }
    footerContent: RowLayout {
        spacing: Theme.space2
        CButton { objectName: "checkAgain"; text: "Check again"; quiet: true; enabled: !rpc.busy; onClicked: check.run([]) }
        Item { Layout.fillWidth: true }
        CButton { text: "Close"; onClicked: check.close() }
        CButton { objectName: "checkTry"; text: check.trying ? "Trying…" : "Try it"; primary: true; enabled: !rpc.busy && model.value.length > 0 && check.chosen.length > 0; onClicked: check.run(check.chosen) }
    }
}
