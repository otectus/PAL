pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A provider and, when it has saved accounts, which of them. What was saved stays chosen even when it is no longer here.
GridLayout {
    id: picker
    /** A test supplies its own broker; the application leaves this unset. */
    property var app: null
    property string provider: ""
    /** The account by its ID, or by its name when `byName` is set; empty for the provider's default. */
    property string account: ""
    property bool byName: false
    readonly property string accountId: byName ? accounts.find(row => row.kind === provider && row.name === account)?.id || "" : account
    property string anyLabel: "Any provider"
    /** Command-line assistants hold conversations; a helper runs on a model PAL calls itself. */
    property bool commandLine: true
    property string name: "account"
    property var accounts: []
    readonly property var state: (app || App).state
    readonly property var traits: state.providerTraits || ({})
    readonly property var kinds: {
        const rows = [{ id: "", label: anyLabel }], order = state.providerOrder || []
        for (let i = 0; i < order.length; i++) if (commandLine || order[i] === "ollama" || traits[order[i]]?.kind === "api") rows.push({ id: order[i], label: label(order[i]) })
        if (provider && !rows.some(row => row.id === provider)) rows.push({ id: provider, label: provider })
        return rows
    }
    readonly property var choices: {
        const rows = [{ key: "", label: label(provider) + " default" }]
        for (let i = 0; i < accounts.length; i++) if (accounts[i].kind === provider && !accounts[i].migrated) rows.push({ key: byName ? accounts[i].name : accounts[i].id, label: accounts[i].name })
        if (account && !rows.some(row => row.key === account)) rows.push({ key: account, label: (byName ? account : "The saved account") + " · missing" })
        return rows
    }
    function label(id) { return traits[id]?.label || (id === "ollama" ? "Ollama" : id) }
    function set(nextProvider, nextAccount) { provider = nextProvider || ""; account = nextAccount || ""; refresh() }
    function refresh() { rpc.call("connections.list", {}, value => { if (!value.error) picker.accounts = value }) }
    columns: width < Theme.formBreakpoint ? 1 : 2; columnSpacing: Theme.space2; rowSpacing: Theme.space2
    Component.onCompleted: refresh()
    // An account may have been added since this page was last looked at.
    onVisibleChanged: if (visible) refresh()
    RpcClient { id: rpc; endpoint: picker.app }
    CComboBox {
        objectName: picker.name + "Provider"
        Layout.fillWidth: true
        model: picker.kinds; textRole: "label"; valueRole: "id"; Accessible.name: "Provider"
        currentIndex: Math.max(0, picker.kinds.findIndex(row => row.id === picker.provider))
        onActivated: index => { const next = picker.kinds[index].id; if (next !== picker.provider) { picker.provider = next; picker.account = "" } }
    }
    CComboBox {
        objectName: picker.name + "Account"
        Layout.fillWidth: true
        visible: picker.provider.length > 0 && picker.choices.length > 1
        model: picker.choices; textRole: "label"; valueRole: "key"; Accessible.name: "Account"
        currentIndex: Math.max(0, picker.choices.findIndex(row => row.key === picker.account))
        onActivated: index => picker.account = picker.choices[index].key
    }
}
