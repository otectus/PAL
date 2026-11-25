pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Chooses a model from its provider's own list (broker/model-choices.ts): a drop-down, a searchable list when there are
// many, and an ID of one's own for what is not listed. What is chosen here is a draft until its page saves it.
ColumnLayout {
    id: picker
    /** A test supplies its own broker; the application leaves this unset. */
    property var app: null
    /** Object name of the drop-down; its field and buttons are named after it. */
    property string name: "model"
    property string provider: ""
    property string connectionId: ""
    property string operation: "chat"
    /** A Hugging Face task, or the address of a speech server on this computer. */
    property string task: ""
    property string url: ""
    /** A list the page already has; nothing is asked for then. */
    property var given: null
    /** Which models are offered, when a page can use only some. */
    property var accepts: null
    property string saved: ""
    property string value: ""
    property string label: "Model"
    /** The first entry: what an empty choice means. */
    property string emptyText: "Choose a model"
    property string customText: "Enter a model ID…"
    property string placeholder: "Model ID"
    property bool allowCustom: true
    property int maximumLength: 512
    property var listed: []
    property bool live: false
    property string problem: ""
    property bool custom: false
    property bool browsing: false
    readonly property bool busy: rpc.busy
    readonly property string customId: "\u0000custom"
    readonly property string source: [provider, connectionId, operation, task, url].join("\n")
    readonly property var models: {
        const all = given || listed, kept = []
        for (let i = 0; i < all.length; i++) if (!accepts || accepts(all[i])) kept.push(all[i])
        return kept
    }
    readonly property var chosenModel: find(value)
    readonly property var options: {
        const rows = [{ id: "", displayName: emptyText }]
        for (let i = 0; i < models.length; i++) rows.push({ id: models[i].id, displayName: models[i].displayName || models[i].name || models[i].id })
        if (value && !custom && !rows.some(row => row.id && same(row.id, value))) rows.push({ id: value, displayName: value + (live || given ? " · not listed" : "") })
        if (allowCustom) rows.push({ id: customId, displayName: customText })
        return rows
    }
    /** A person chose a model; `value` already holds it. */
    signal chosen(string id)
    /** The box's field was finished with Enter. */
    signal accepted()
    spacing: Theme.space1
    // Ollama names a model with and without the tag it has by default.
    function same(a, b) { return a === b || provider === "ollama" && (a === b + ":latest" || b === a + ":latest") }
    function find(id) { for (let i = 0; i < models.length; i++) if (same(models[i].id, id)) return models[i]; return null }
    function set(id) { custom = false; field.text = ""; value = id || ""; show() }
    function pick(id) { set(id); chosen(value) }
    function show() { const wanted = custom ? customId : value; box.currentIndex = Math.max(0, options.findIndex(row => row.id === wanted || !!row.id && !!wanted && same(row.id, wanted))) }
    function enterCustom() { custom = true; field.text = value; show(); Qt.callLater(() => field.forceActiveFocus(Qt.TabFocusReason)) }
    function load(mode) {
        if (given || !provider) { listed = []; live = false; problem = ""; return }
        const asked = source, request = { provider: provider, operation: operation }
        if (connectionId) request.connectionId = connectionId
        if (task) request.task = task
        if (url) request.url = url
        if (mode === "known") request.known = true
        else if (mode === "refresh") request.refresh = true
        rpc.call("models.choices", request, result => {
            if (asked !== picker.source) return
            if (result.error) { picker.problem = String(result.error); return }
            picker.listed = result.models || []; picker.live = result.live === true; picker.problem = result.problem || ""
        })
    }
    // What costs a request is asked for when the list is opened; a local list and one PAL already has come at once.
    function open() { if (!live && !given) load("") }
    function restart() { listed = []; live = false; problem = ""; browsing = false; if (visible) load(provider === "ollama" || provider === "whisper" || provider === "local-server" ? "" : "known") }
    onSourceChanged: Qt.callLater(restart)
    onVisibleChanged: if (visible && !live && !listed.length) Qt.callLater(restart)
    onSavedChanged: set(saved)
    Component.onCompleted: { if (saved && !value) set(saved); Qt.callLater(restart) }
    RpcClient { id: rpc; endpoint: picker.app; scope: picker.source }
    RowLayout {
        Layout.fillWidth: true; spacing: Theme.space2
        CComboBox {
            id: box
            objectName: picker.name
            Layout.fillWidth: true; Layout.minimumWidth: 0
            model: picker.options; textRole: "displayName"; valueRole: "id"; Accessible.name: picker.label
            onModelChanged: picker.show()
            onActivated: index => { const id = picker.options[index].id; if (id === picker.customId) picker.enterCustom(); else picker.pick(id) }
            Connections { target: box.popup; function onAboutToShow() { picker.open() } }
        }
        CButton { objectName: picker.name + "Browse"; visible: picker.models.length > 12; text: picker.browsing ? "Close list" : "Browse…"; quiet: true; onClicked: picker.browsing = !picker.browsing }
        CButton { objectName: picker.name + "Refresh"; visible: !picker.given && picker.provider.length > 0 && picker.provider !== "voyage"; text: rpc.busy ? "Loading…" : "Refresh"; quiet: true; enabled: !rpc.busy; help: "Loads the list again"; onClicked: picker.load("refresh") }
    }
    CField {
        id: field
        objectName: picker.name + "Custom"
        visible: picker.custom; Layout.fillWidth: true
        maximumLength: picker.maximumLength; placeholderText: picker.placeholder; Accessible.name: picker.placeholder
        onTextChanged: if (picker.custom) picker.value = text.trim()
        onEditingFinished: if (picker.custom && picker.value) picker.chosen(picker.value)
        onAccepted: picker.accepted()
    }
    Loader {
        active: picker.browsing; visible: active; Layout.fillWidth: true
        sourceComponent: ModelBrowser {
            app: picker.app; models: picker.models; current: picker.value; provider: picker.provider; connectionId: picker.connectionId
            onChosen: id => picker.pick(id)
        }
    }
    CText { objectName: picker.name + "Facts"; readonly property string facts: picker.chosenModel ? picker.chosenModel.detail || picker.chosenModel.description || "" : ""; visible: facts.length > 0 && !picker.browsing && !picker.custom; text: facts; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
    CText { objectName: picker.name + "Problem"; visible: picker.problem.length > 0; text: picker.problem; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
}
