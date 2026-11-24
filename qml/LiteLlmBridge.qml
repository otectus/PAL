pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// The optional LiteLLM bridge of one account: the Python environment it runs in, and the worker itself.
CDialog {
    id: bridge
    objectName: "liteLlmBridge"
    /** A test supplies its own broker; the application leaves this unset. */
    property var app: null
    property var connection: ({})
    property var info: ({ source: "", python: "", version: "", offered: "", installed: false, busy: false, stage: "", error: "" })
    property string asking: ""
    property string error: ""
    property string tested: ""
    property bool working: false
    property bool starting: false
    readonly property bool loaded: info.source.length > 0
    readonly property bool outdated: info.installed && !!info.offered && info.version !== info.offered
    readonly property bool usesOwn: info.source === "managed"
    readonly property string summary: !loaded ? "" : info.busy ? info.stage
        : usesOwn ? "PAL keeps LiteLLM " + info.version + " in a folder of its own." + (outdated ? " This PAL offers " + info.offered + "." : "")
        : info.source === "chosen" ? "PAL uses the Python environment you chose: " + info.python
        : "PAL does not keep LiteLLM. The system’s Python is used, if LiteLLM is installed there."
    function show(value) { if (value.error && value.source === undefined) { error = value.error; return } info = value; error = "" }
    function load() { runtime.call("providerBridge.runtime", {}, bridge.show) }
    function change(method) { asking = ""; error = ""; tested = ""; runtime.call(method, { confirmed: true }, bridge.show) }
    function openFor(item) { connection = item; asking = ""; error = ""; tested = ""; working = false; open(); load() }
    function test() {
        tested = ""; starting = true
        worker.call("providerBridge.status", { connectionId: connection.id }, value => {
            bridge.starting = false; bridge.working = !value.error && value.running === true
            bridge.tested = value.error ? String(value.error) : "LiteLLM " + value.version + " is running."
        })
    }
    RpcClient { id: runtime; endpoint: bridge.app; scope: "litellm-runtime" }
    RpcClient { id: worker; endpoint: bridge.app; scope: bridge.connection.id || "" }
    Timer { interval: 700; repeat: true; running: bridge.visible && bridge.info.busy; onTriggered: bridge.load() }
    CText { text: "LiteLLM bridge"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
    CText { text: "LiteLLM runs on this computer and reaches the provider directly, with only the credential of " + (bridge.connection.name || "this account") + "."; color: Theme.muted; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    SectionLabel { text: "LITELLM" }
    CText { objectName: "bridgeSummary"; visible: text.length > 0; text: bridge.summary; color: bridge.info.busy ? Theme.accentText : Theme.text; font.pixelSize: Theme.secondary; Layout.fillWidth: true; Accessible.role: Accessible.StaticText }
    CText { objectName: "bridgeProblem"; visible: !!bridge.info.error && !bridge.info.busy; text: bridge.info.error || ""; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; Accessible.role: Accessible.AlertMessage }
    ColumnLayout {
        visible: bridge.asking.length > 0
        Layout.fillWidth: true; spacing: Theme.space2
        CText {
            objectName: "bridgeAsk"
            text: bridge.asking === "remove" ? "PAL’s LiteLLM folder is deleted. Accounts and their credentials stay, and LiteLLM of another Python is not touched."
                : "Downloads LiteLLM " + bridge.info.offered + " and its parts from PyPI, about 80 MB, into a folder of PAL’s own (about 350 MB). Each file has to match its recorded fingerprint. System Python stays as it is."
            font.pixelSize: Theme.secondary; Layout.fillWidth: true
        }
        RowLayout {
            spacing: Theme.space2
            CButton { objectName: "bridgeConfirm"; text: bridge.asking === "remove" ? "Delete" : "Download"; primary: bridge.asking !== "remove"; danger: bridge.asking === "remove"; enabled: !runtime.busy; onClicked: bridge.change(bridge.asking === "remove" ? "providerBridge.remove" : "providerBridge.install") }
            CButton { objectName: "bridgeBack"; text: "Back"; quiet: true; onClicked: bridge.asking = "" }
        }
    }
    Flow {
        visible: bridge.loaded && !bridge.asking.length
        Layout.fillWidth: true; spacing: Theme.space2
        CButton { objectName: "bridgeInstall"; visible: !bridge.info.busy && !!bridge.info.offered; text: !bridge.info.installed ? "Let PAL keep LiteLLM…" : bridge.outdated ? "Update…" : "Install again…"; quiet: bridge.info.installed && !bridge.outdated; implicitHeight: Theme.compactHeight; onClicked: bridge.asking = "install" }
        CButton { objectName: "bridgeRemove"; visible: !bridge.info.busy && bridge.info.installed; text: "Remove…"; quiet: true; danger: true; implicitHeight: Theme.compactHeight; onClicked: bridge.asking = "remove" }
        CButton { objectName: "bridgeCancel"; visible: bridge.info.busy; text: "Stop"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !runtime.busy; onClicked: { bridge.error = ""; runtime.call("providerBridge.cancel", {}, bridge.show) } }
    }
    CText { visible: bridge.info.source === "chosen" && bridge.info.installed; text: "The Python environment you chose comes before the one PAL keeps."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
    SectionLabel { text: "THIS ACCOUNT" }
    RowLayout {
        Layout.fillWidth: true; spacing: Theme.space2
        CButton { objectName: "bridgeTest"; text: bridge.starting ? "Starting…" : "Start and test"; enabled: !bridge.starting && !bridge.info.busy; implicitHeight: Theme.compactHeight; onClicked: bridge.test() }
        CButton { objectName: "bridgeStop"; text: "Stop"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !bridge.starting; onClicked: worker.call("providerBridge.stop", { connectionId: bridge.connection.id }, value => { bridge.working = false; bridge.tested = value.error || "Stopped. It starts again with the next message." }) }
        CText { objectName: "bridgeTested"; text: bridge.tested; color: bridge.working || bridge.tested.indexOf("Stopped") === 0 ? Theme.accentText : Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    }
    CText { text: "Testing starts LiteLLM without sending anything to the provider."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
    CText { objectName: "bridgeError"; visible: !!bridge.error; text: bridge.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; Accessible.role: Accessible.AlertMessage }
    footerContent: RowLayout {
        spacing: Theme.space2
        Item { Layout.fillWidth: true }
        CButton { objectName: "bridgeClose"; text: "Close"; onClicked: bridge.close() }
    }
}
