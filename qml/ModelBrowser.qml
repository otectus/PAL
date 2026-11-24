pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A long model list, searched and narrowed: what each model holds, reads and costs, as its provider states it. For
// OpenRouter it can also say who serves one.
ColumnLayout {
    id: browser
    objectName: "modelBrowser"
    /** A test supplies its own broker; the application leaves this unset. */
    property var app: null
    property var models: []
    property string current: ""
    property string provider: ""
    property string connectionId: ""
    /** The upstream providers already preferred, by the names OpenRouter knows them by. */
    property var preferred: []
    property var only: []
    property var served: []
    property string servedFor: ""
    property string servedError: ""
    signal chosen(string id)
    signal prefer(var providers)
    readonly property var selected: find(current)
    readonly property bool priced: some(model => !!model.pricing)
    readonly property var chips: [{ id: "tools", label: "Tools" }, { id: "images", label: "Images" }, { id: "reasoning", label: "Reasoning" }, { id: "structured-output", label: "Structured replies" }, { id: "free", label: "Free" }].filter(chip => { const matching = count(model => has(model, chip.id)); return matching > 0 && matching < browser.models.length })
    readonly property var rows: {
        const words = search.text.toLowerCase().split(/\s+/).filter(word => word.length > 0), kept = []
        for (let i = 0; i < models.length; i++) {
            const model = models[i], text = (model.displayName + " " + model.id).toLowerCase()
            if (words.every(word => text.indexOf(word) >= 0) && only.every(id => has(model, id))) kept.push(model)
        }
        const order = sort.currentIndex
        if (order === 1) kept.sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0))
        else if (order === 2) kept.sort((a, b) => price(a) - price(b))
        return kept
    }
    spacing: Theme.space2
    function some(test) { for (let i = 0; i < models.length; i++) if (test(models[i])) return true; return false }
    function count(test) { let total = 0; for (let i = 0; i < models.length; i++) if (test(models[i])) total++; return total }
    function find(id) { for (let i = 0; i < models.length; i++) if (models[i].id === id) return models[i]; return null }
    function has(model, id) {
        if (id === "free") return model.free === true
        const capabilities = model.capabilities || []
        if (id === "tools" && capabilities.indexOf("no-local-tools") >= 0) return false
        return capabilities.indexOf(id) >= 0 || id === "tools" && capabilities.indexOf("local-tools") >= 0 || id === "images" && capabilities.indexOf("vision") >= 0
    }
    function price(model) { if (model.free) return 0; const total = Number(model.pricing?.prompt) + Number(model.pricing?.completion); return isNaN(total) ? Infinity : total }
    function narrow(id, on) { only = chips.map(chip => chip.id).filter(chip => chip === id ? on : only.indexOf(chip) >= 0) }
    function who() {
        const asked = current
        servedError = ""; served = []; servedFor = asked
        const request = { provider: provider, model: asked }
        if (connectionId) request.connectionId = connectionId
        rpc.call("provider.modelEndpoints", request, value => {
            if (browser.servedFor !== asked) return
            if (value.error) { browser.servedError = String(value.error); return }
            browser.served = value.endpoints || []
            if (!browser.served.length) browser.servedError = "OpenRouter names nobody who serves this model right now."
        })
    }
    function prefers(slug) { for (let i = 0; i < preferred.length; i++) if (preferred[i] === slug) return true; return false }
    function togglePreferred(slug) { const next = []; for (let i = 0; i < preferred.length; i++) if (preferred[i] !== slug) next.push(preferred[i]); if (!prefers(slug)) next.push(slug); prefer(next) }
    onCurrentChanged: { served = []; servedFor = ""; servedError = "" }
    onProviderChanged: { only = []; search.text = "" }
    onConnectionIdChanged: { served = []; servedFor = ""; servedError = "" }
    RpcClient { id: rpc; endpoint: browser.app; scope: browser.provider + "/" + browser.connectionId }
    CField { id: search; objectName: "modelSearch"; Layout.fillWidth: true; placeholderText: "Find among " + browser.models.length + " models"; maximumLength: 100; Accessible.name: "Find a model"; Keys.onDownPressed: list.focusRow(0) }
    Flow {
        Layout.fillWidth: true; spacing: Theme.space2
        Repeater {
            model: browser.chips
            CButton {
                required property var modelData
                objectName: "modelChip_" + modelData.id
                text: modelData.label; checkable: true; implicitHeight: Theme.compactHeight
                checked: browser.only.indexOf(modelData.id) >= 0; primary: checked; quiet: !checked
                Accessible.name: "Only models with " + modelData.label.toLowerCase()
                onClicked: browser.narrow(modelData.id, checked)
            }
        }
        CComboBox { id: sort; objectName: "modelSort"; width: Theme.fieldWidth; implicitHeight: Theme.compactHeight; model: browser.priced ? ["By name", "Longest context", "Lowest price"] : ["By name", "Longest context"]; Accessible.name: "Order of models" }
    }
    ListView {
        id: list
        objectName: "modelRows"
        Layout.fillWidth: true; implicitHeight: Math.min(contentHeight, Theme.editorLarge)
        /** The arrow keys walk the rows, and Up from the first one returns to the search. */
        function focusRow(index) {
            if (index < 0) { search.forceActiveFocus(); return }
            if (index >= count) return
            positionViewAtIndex(index, ListView.Contain)
            itemAtIndex(index)?.forceActiveFocus(Qt.TabFocusReason)
        }
        clip: true; model: browser.rows; spacing: Theme.space1; boundsBehavior: Flickable.StopAtBounds; reuseItems: true
        ScrollBar.vertical: CScrollBar { policy: list.contentHeight > list.height ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff }
        delegate: CActionRow {
            required property var modelData
            required property int index
            objectName: "modelRow_" + index
            width: ListView.view.width - Theme.space3
            text: modelData.displayName || modelData.id
            detail: modelData.detail || modelData.id
            selected: modelData.id === browser.current
            trailingIcon: selected ? "check" : ""
            onClicked: browser.chosen(modelData.id)
            Keys.onDownPressed: list.focusRow(index + 1)
            Keys.onUpPressed: list.focusRow(index - 1)
            Keys.onReturnPressed: browser.chosen(modelData.id)
        }
        Accessible.role: Accessible.List; Accessible.name: "Models"
    }
    CText { objectName: "modelNothing"; visible: !browser.rows.length; text: "No model of this list matches."; color: Theme.muted; font.pixelSize: Theme.secondary }
    CText { objectName: "modelCount"; visible: browser.rows.length > 0 && browser.rows.length < browser.models.length; text: browser.rows.length + " of " + browser.models.length; color: Theme.muted; font.pixelSize: Theme.caption }
    ColumnLayout {
        visible: !!browser.selected
        Layout.fillWidth: true; spacing: Theme.space1
        CText { objectName: "modelChosen"; text: browser.selected ? browser.selected.id : ""; font.weight: Font.DemiBold; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        CText { visible: !!browser.selected && !!browser.selected.detail; text: browser.selected ? browser.selected.detail || "" : ""; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        CText { visible: !!browser.selected && !!browser.selected.expires; text: browser.selected && browser.selected.expires ? "Its provider stops serving it on " + browser.selected.expires + "." : ""; color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        CText { objectName: "modelParameters"; readonly property var names: browser.selected && browser.selected.supportedParameters ? browser.selected.supportedParameters : []; visible: names.length > 0; text: visible ? "Takes " + names.join(", ") : ""; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        CButton { objectName: "modelServedBy"; visible: browser.provider === "openrouter"; text: rpc.busy ? "Asking OpenRouter…" : "Who serves it"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !rpc.busy; onClicked: browser.who() }
        Repeater {
            model: browser.served
            RowLayout {
                id: upstream
                required property var modelData
                required property int index
                Layout.fillWidth: true; spacing: Theme.space2
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 0
                    CText { objectName: "modelUpstream_" + upstream.index; text: upstream.modelData.provider + (upstream.modelData.slug ? " · " + upstream.modelData.slug : ""); font.pixelSize: Theme.secondary; Layout.fillWidth: true }
                    CText { text: (upstream.modelData.available ? "" : "Not available right now · ") + upstream.modelData.detail; color: upstream.modelData.available ? Theme.muted : Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true }
                }
                CButton { objectName: "modelPrefer_" + upstream.index; visible: !!upstream.modelData.slug; readonly property bool on: browser.prefers(upstream.modelData.slug); text: on ? "Preferred" : "Prefer"; primary: on; quiet: !on; implicitHeight: Theme.compactHeight; Accessible.name: (on ? "Stop preferring " : "Prefer ") + upstream.modelData.provider; onClicked: browser.togglePreferred(upstream.modelData.slug) }
            }
        }
        CText { objectName: "modelServedError"; visible: !!browser.servedError; text: browser.servedError; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; Accessible.role: Accessible.AlertMessage }
    }
}
