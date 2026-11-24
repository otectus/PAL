pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A08: conversations in a web browser, paired like a phone and allowed much less.
ColumnLayout {
    id: companion
    objectName: "browserCompanion"
    property var candidates: []
    property var knownProjects: []
    readonly property var info: App.state.remote?.browser || ({ enabled: false, addresses: [], port: 8444, urls: [], listening: [] })
    // Read through properties of their own: every state push replaces `info`, which would reset what is being typed.
    readonly property string savedProxy: info.proxy || ""
    readonly property int savedPort: info.port
    readonly property var pairing: info.pairing || null
    readonly property var received: pairing ? pairing.received || null : null
    property var made: ({})
    property var projects: []
    property string role: "observer"
    property string error: ""
    property real now: Date.now()
    readonly property bool codeOpen: !!pairing && made.pairingId === pairing.pairingId && !!made.code
    signal changed()
    spacing: Theme.space2
    function copyOf(list) { const found = []; for (let i = 0; i < (list || []).length; i++) found.push(list[i]); return found }
    function send(method, params, done) { error = ""; rpc.call("remote." + method, params, value => { if (value.error) companion.error = value.error; else if (done) done(value); companion.changed() }) }
    function configure(patch) { send("browserConfigure", patch) }
    function toggleAddress(address, on) { configure({ addresses: copyOf(info.addresses).filter(item => item !== address).concat(on ? [address] : []) }) }
    function toggleProject(path, on) { projects = copyOf(projects).filter(item => item !== path).concat(on ? [path] : []) }
    function prepare() { send("browserPrepare", { projectPaths: projects, role: role, caps: role === "limited" ? ["chat.write", "providers.execute"].concat(answers.checked ? ["approvals.answer", "approvals.provider"] : []) : [] }, value => { companion.made = value; compare.checked = false }) }
    function timeLeft() { const seconds = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0; return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") }
    onPairingChanged: now = Date.now()
    onReceivedChanged: compare.checked = false
    RpcClient { id: rpc }
    Timer { interval: 1000; repeat: true; running: companion.visible && !!companion.pairing; onTriggered: companion.now = Date.now() }
    CText { text: "Web browser"; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
    CText { text: "Read conversations of the projects you choose in a web browser, on this computer or another. Off until you turn it on. A browser never gets full access, desktop control, files or hosted accounts. Its pairing ends after 14 days unless you renew it here."; color: Theme.muted; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    CCheckBox { objectName: "browserEnabled"; text: "Allow paired browsers"; checked: companion.info.enabled === true; enabled: !rpc.busy; onClicked: companion.configure({ enabled: checked }) }
    ColumnLayout {
        visible: companion.info.enabled === true
        Layout.fillWidth: true; spacing: Theme.space2
        SectionLabel { text: "Where" }
        CText { objectName: "browserWhere"; text: companion.info.addresses.length ? "On these addresses, encrypted with this desktop’s own certificate:" : "On this computer only. Choose an address to reach it from another device:"; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        Repeater {
            model: companion.candidates
            CCheckBox {
                required property var modelData
                required property int index
                objectName: "browserAddress_" + index
                text: modelData.address + " · " + ({ tailscale: "Tailscale", wireguard: "WireGuard", lan: "Local network" }[modelData.kind] || modelData.kind)
                checked: companion.copyOf(companion.info.addresses).includes(modelData.address); enabled: !rpc.busy; onClicked: companion.toggleAddress(modelData.address, checked)
            }
        }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CText { text: "Port"; Layout.fillWidth: false }
            CSpinBox { id: port; objectName: "browserPort"; from: 1024; to: 65535; value: companion.savedPort; enabled: !rpc.busy; Accessible.name: "Browser port"; textFromValue: number => String(number) }
            CButton { objectName: "browserPortSave"; text: "Use"; enabled: !rpc.busy && port.value !== companion.savedPort; onClicked: companion.configure({ port: port.value }) }
            Item { Layout.fillWidth: true }
        }
        CText { text: "Address of a secure proxy in front of PAL (optional)"; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CField { id: proxy; objectName: "browserProxy"; Layout.fillWidth: true; placeholderText: "https://desk.example.net"; maximumLength: 200; text: companion.savedProxy; Accessible.name: "Address of a secure proxy"; onAccepted: companion.configure({ proxy: text.trim() }) }
            CButton { objectName: "browserProxySave"; text: "Save"; enabled: !rpc.busy && proxy.text.trim() !== companion.savedProxy; onClicked: companion.configure({ proxy: proxy.text.trim() }) }
        }
        CText { objectName: "browserProblem"; visible: !!companion.info.problem; text: companion.info.problem || ""; color: Theme.amber; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        SectionLabel { text: "Pair a browser" }
        Flow {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "browserRoleObserver"; text: "Read, Stop and Deny"; primary: companion.role === "observer"; Accessible.description: "Selected: " + (companion.role === "observer" ? "yes" : "no"); onClicked: companion.role = "observer" }
            CButton { objectName: "browserRoleLimited"; text: "Read and send"; primary: companion.role === "limited"; Accessible.description: "Selected: " + (companion.role === "limited" ? "yes" : "no"); onClicked: companion.role = "limited" }
        }
        CCheckBox { id: answers; objectName: "browserAnswers"; visible: companion.role === "limited"; text: "It may also allow requests of conversations it started or continued" }
        CText { visible: companion.role === "limited"; text: "Anyone who uses that browser can do this, and so can its extensions. Its turns run with the limits of a phone with limited access."; color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        CText { text: "Projects it may read"; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        Repeater {
            model: companion.knownProjects
            CCheckBox {
                required property var modelData
                required property int index
                objectName: "browserProject_" + index
                text: modelData.name + " · " + modelData.path; checked: companion.copyOf(companion.projects).includes(modelData.path); onClicked: companion.toggleProject(modelData.path, checked)
            }
        }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "browserAddProject"; text: "Another folder…"; quiet: true; onClicked: { const path = App.chooseFolder(); if (path) companion.toggleProject(path, true) } }
            CText { visible: text.length > 0; text: companion.projects.filter(path => !companion.knownProjects.some(item => item.path === path)).join(", "); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
        }
        CButton { objectName: "browserPair"; text: companion.pairing ? "Make a new code" : "Pair a browser"; primary: !companion.pairing; enabled: !rpc.busy && companion.projects.length > 0; help: companion.projects.length ? "" : "Choose at least one project"; onClicked: companion.prepare() }
        ColumnLayout {
            visible: companion.codeOpen && !companion.received
            Layout.fillWidth: true; spacing: Theme.space1
            CText { text: "Open " + (companion.made.urls || []).join(" or ") + " and type this code:"; Layout.fillWidth: true }
            CText { objectName: "browserCode"; text: companion.made.code || ""; font.family: Theme.mono; font.pixelSize: Theme.display; color: Theme.accentText; Accessible.name: "Pairing code " + (companion.made.code || "").split("").join(" ") }
            CText { objectName: "browserFingerprint"; visible: !!companion.made.fingerprint; text: "The browser will warn that it does not know this certificate. Continue only when its SHA-256 fingerprint is " + (companion.made.fingerprint || ""); color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space2
                CButton { objectName: "browserCopyAddress"; text: "Copy the address"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: App.copy(companion.made.urls[0]) }
                CText { text: "Ends in " + companion.timeLeft(); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
                CButton { objectName: "browserCancel"; text: "Cancel"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !rpc.busy; onClicked: companion.send("browserCancel", {}) }
            }
        }
        ColumnLayout {
            visible: !!companion.received
            Layout.fillWidth: true; spacing: Theme.space2
            CText { objectName: "browserAnswered"; text: companion.received ? companion.received.name + " answered. It " + (companion.pairing.role === "observer" ? "will read, and can Stop and Deny." : "will read and send messages.") + " These six words have to be the ones it shows:" : ""; Layout.fillWidth: true }
            CText { objectName: "browserWords"; text: companion.received ? companion.received.sas : ""; font.pixelSize: Theme.section; font.weight: Font.DemiBold; color: Theme.accentText; Layout.fillWidth: true }
            CCheckBox { id: compare; objectName: "browserWordsMatch"; text: "All six words match" }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space2
                CButton { objectName: "browserConfirm"; text: "Confirm this browser"; primary: true; enabled: compare.checked && !rpc.busy; onClicked: companion.send("browserConfirm", { pairingId: companion.pairing.pairingId, sas: companion.received.sas, confirmed: true }) }
                CButton { objectName: "browserRefuse"; text: "Refuse"; danger: true; enabled: !rpc.busy; onClicked: companion.send("browserCancel", {}) }
            }
        }
    }
    CText { objectName: "browserError"; visible: !!companion.error; text: companion.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; Accessible.role: Accessible.AlertMessage }
}
