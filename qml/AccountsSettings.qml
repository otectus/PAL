import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Accounts.js" as Accounts
// Settings › Connections › Accounts: GitHub, Google and Microsoft, connected with apps the owner registered. What
// assistants may do with an account is decided here, and off until it is.
CSection {
    id: accounts
    objectName: "accountsSettings"
    title: "Accounts"
    description: "GitHub, Google and Microsoft: calendar, mail, files and repositories, for you in the Workbench and, where you allow it, for assistants. PAL has no app of its own at these services: register one once, then sign in with it. Sign-ins stay in an owner-only file on this computer."
    property var info: ({ accounts: [], providers: [], flows: [] })
    property string error: ""
    property string notice: ""
    property var removing: null
    property var projects: []
    readonly property int revision: App.state.accounts?.revision || 0
    function refresh() { rpc.call("accounts.list", {}, value => { if (value.error) error = value.error; else info = value }) }
    function run(method, params, done) { error = ""; notice = ""; rpc.call("accounts." + method, params, value => { if (value.error) { error = value.error; return } if (done) done(value); refresh() }) }
    function flowFor(id) { return (info.flows || []).find(flow => flow.accountId === id && (flow.state === "waiting" || flow.state === "failed")) || null }
    function signIn(account, method) {
        run("signIn", { id: account.id, method: method }, flow => {
            if (flow.url) { notice = "Finish signing in to " + account.providerLabel + " in your browser. It returns to PAL on this computer."; Qt.openUrlExternally(flow.url) }
        })
    }
    Component.onCompleted: refresh()
    onRevisionChanged: refresh()
    RpcClient { id: rpc }
    CText { visible: !accounts.info.accounts.length; text: "No account is connected."; color: Theme.muted; font.pixelSize: Theme.secondary }
    Repeater {
        model: accounts.info.accounts
        ColumnLayout {
            id: card
            required property var modelData
            required property int index
            readonly property var flow: accounts.flowFor(modelData.id)
            readonly property var provider: accounts.info.providers.find(item => item.id === modelData.provider) || ({ methods: [] })
            objectName: "account_" + index
            Layout.fillWidth: true; spacing: Theme.space2
            Rectangle { visible: card.index > 0; Layout.fillWidth: true; Layout.preferredHeight: Theme.hairline; color: Theme.subtle }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space2
                ColumnLayout {
                    Layout.fillWidth: true; spacing: Theme.space1
                    CText { text: card.modelData.label + " · " + card.modelData.providerLabel; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
                    CText { objectName: "accountState_" + card.index; text: Accounts.stateText(card.modelData); color: card.modelData.state === "signed-in" ? Theme.accentText : card.modelData.state === "signed-out" ? Theme.muted : Theme.amber; font.pixelSize: Theme.secondary; Layout.fillWidth: true; wrapMode: Text.Wrap }
                    CText { text: Accounts.usesText(card.modelData) + "\n" + Accounts.assistantsText(card.modelData); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
                }
            }
            // A device code works from any screen: it is typed at the service, and nothing secret passes through it.
            ColumnLayout {
                visible: !!card.flow; Layout.fillWidth: true; spacing: Theme.space1
                CText { visible: card.flow?.kind === "device" && card.flow?.state === "waiting"; text: "Enter this code at " + (card.flow?.address || "").replace(/^https:\/\//, "") + ":"; Layout.fillWidth: true; wrapMode: Text.Wrap }
                CText { objectName: "accountCode_" + card.index; visible: !!card.flow?.userCode && card.flow?.state === "waiting"; text: card.flow?.userCode || ""; font.family: Theme.mono; font.pixelSize: Theme.title; Accessible.name: "Sign-in code " + (card.flow?.userCode || "").split("").join(" ") }
                CText { visible: card.flow?.state === "waiting"; text: "Waiting for you to finish there…"; color: Theme.muted; font.pixelSize: Theme.caption }
                CText { visible: card.flow?.state === "failed"; text: card.flow?.message || ""; color: Theme.amber; font.pixelSize: Theme.secondary; Layout.fillWidth: true; wrapMode: Text.Wrap }
                Flow {
                    Layout.fillWidth: true; spacing: Theme.space2
                    CButton { visible: !!card.flow?.userCode && card.flow?.state === "waiting"; text: "Copy code"; onClicked: App.copy(card.flow.userCode) }
                    CButton { visible: !!(card.flow?.address || card.flow?.url) && card.flow?.state === "waiting"; text: "Open the page"; primary: true; onClicked: Qt.openUrlExternally(card.flow.complete || card.flow.address || card.flow.url) }
                    CButton { text: card.flow?.state === "failed" ? "Dismiss" : "Cancel"; quiet: true; onClicked: accounts.run("cancel", { id: card.flow.id }) }
                }
            }
            Flow {
                Layout.fillWidth: true; spacing: Theme.space2
                CButton { objectName: "accountSignIn_" + card.index; visible: !card.flow && card.provider.methods.includes("device") && card.modelData.state !== "signed-in"; text: "Sign in with a code"; primary: true; enabled: !rpc.busy && !!card.modelData.clientId; help: card.modelData.clientId ? "Sign in at the service with a short code" : "Enter the client ID of the app you registered first"; onClicked: accounts.signIn(card.modelData, "device") }
                CButton { visible: !card.flow && card.provider.methods.includes("browser") && card.modelData.state !== "signed-in"; text: "Sign in in the browser"; primary: !card.provider.methods.includes("device"); enabled: !rpc.busy && !!card.modelData.clientId; help: card.modelData.clientId ? "The page returns to PAL on this computer" : "Enter the client ID of the app you registered first"; onClicked: accounts.signIn(card.modelData, "browser") }
                CButton { objectName: "accountToken_" + card.index; visible: !card.flow && card.provider.methods.includes("token") && card.modelData.state !== "signed-in"; text: "Use a token…"; onClicked: { tokenDialog.account = card.modelData; tokenField.text = ""; tokenDialog.open() } }
                CButton { visible: card.modelData.state === "signed-in"; text: "Check"; enabled: !rpc.busy; onClicked: accounts.run("test", { id: card.modelData.id }, value => accounts.notice = "It works: signed in as " + value.login + ".") }
                CButton { objectName: "accountEdit_" + card.index; text: "Edit…"; onClicked: editor.openFor(card.modelData) }
                CButton { visible: card.modelData.state !== "signed-out"; text: "Sign out"; quiet: true; enabled: !rpc.busy; onClicked: accounts.run("signOut", { id: card.modelData.id }, value => accounts.notice = value.revoked ? "Signed out here and at the service." : "Signed out here. To end it at the service too, remove PAL’s access there.") }
                CButton { objectName: "accountRemove_" + card.index; text: "Remove…"; quiet: true; danger: true; onClicked: { accounts.removing = card.modelData; removeDialog.open() } }
            }
        }
    }
    CText { objectName: "accountsNotice"; visible: !!accounts.notice; text: accounts.notice; color: Theme.accentText; font.pixelSize: Theme.secondary; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
    CText { objectName: "accountsError"; visible: !!accounts.error; text: accounts.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
    CButton { objectName: "addAccount"; text: "Add an account…"; iconName: "plus"; onClicked: editor.openFor(null) }

    CDialog {
        id: editor
        objectName: "accountEditor"
        accessibleTitle: account ? "Edit account" : "Add an account"
        property var account: null
        property string problem: ""
        property var uses: ({})
        property string assistants: "off"
        property string models: "local"
        property var projects: null
        readonly property string providerId: account ? account.provider : (accounts.info.providers[providerBox.currentIndex]?.id || "github")
        readonly property var provider: accounts.info.providers.find(item => item.id === providerId) || ({ services: [], methods: [], label: "" })
        function openFor(value) {
            account = value; problem = ""
            rpc.call("projects.list", {}, rows => { if (rows.error) return; const all = rows.items || rows, found = []; for (let i = 0; i < all.length && i < 24; i++) found.push(all[i]); accounts.projects = found })
            providerBox.currentIndex = 0
            uses = value ? Object.assign({}, value.services) : ({})
            assistants = value ? value.ai : "off"; models = value ? (value.destinations.cloud ? "cloud" : value.destinations.remote ? "remote" : "local") : "local"; projects = value ? value.projects : null
            nameField.text = value ? value.label : ""; clientField.text = value ? value.clientId : ""; secretField.text = ""; tenantField.text = value?.tenant || ""; hostField.text = value?.host || ""
            open()
        }
        function use(service) { return uses[service] || (account ? "off" : "read") }
        function save() {
            const services = {}; for (const service of provider.services) services[service] = use(service)
            const params = { label: nameField.text.trim() || provider.label, clientId: clientField.text.trim(), services: services, ai: assistants, destinations: { remote: models !== "local", cloud: models === "cloud" }, projects: projects, tenant: tenantField.text.trim(), host: hostField.text.trim() }
            if (secretField.text) params.clientSecret = secretField.text
            if (account) { params.id = account.id; params.expectedRevision = account.revision } else params.provider = providerId
            if (providerId !== "microsoft") delete params.tenant
            if (providerId !== "github") delete params.host
            problem = ""
            rpc.call("accounts.save", params, value => { if (value.error) { problem = value.error; return } editor.close(); accounts.notice = account ? "Saved." : "Added. Sign in to use it."; accounts.refresh() })
        }
        CText { text: editor.account ? "Edit " + editor.account.label : "Add an account"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CComboBox { id: providerBox; objectName: "accountProvider"; visible: !editor.account; Layout.fillWidth: true; model: accounts.info.providers.map(item => item.label); Accessible.name: "Service"; onActivated: editor.uses = ({}) }
        CField { id: nameField; objectName: "accountName"; Layout.fillWidth: true; placeholderText: "Name, for example " + (editor.provider.label || "Work"); Accessible.name: "Account name" }
        SectionLabel { text: "What it is for" }
        Repeater {
            model: editor.provider.services
            RowLayout {
                required property string modelData
                Layout.fillWidth: true; spacing: Theme.space2
                CText { text: Accounts.serviceLabels[modelData]; Layout.fillWidth: true }
                CComboBox { objectName: "accountUse_" + modelData; Layout.preferredWidth: Theme.pickerWidth; model: ["Off", "Read", "Read and change"]; Accessible.name: Accounts.serviceLabels[modelData] + " access"
                    currentIndex: ["off", "read", "write"].indexOf(editor.use(modelData)); onActivated: index => { const next = Object.assign({}, editor.uses); next[modelData] = ["off", "read", "write"][index]; editor.uses = next } }
            }
        }
        CText { visible: editor.providerId === "github"; text: "Reading with a GitHub app reaches public repositories only. For private ones choose “Read and change”, or use a fine-grained token limited to reading."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
        SectionLabel { text: "The app you registered" }
        CText { objectName: "accountSteps"; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap
            text: editor.providerId === "github" ? "At GitHub, register an OAuth app (any callback address), turn on Device Flow and copy its client ID. It needs no secret. Or leave this empty and use a token."
                : editor.providerId === "google" ? "In a Google Cloud project, turn on the Calendar, Gmail and Drive interfaces you chose, create an OAuth client of type “Desktop app”, and copy its client ID and secret. Add yourself as a test user while the app is unpublished."
                : "In Microsoft Entra, register an app, add the platform “Mobile and desktop applications” with the address http://localhost, allow public client flows, and copy its application (client) ID. It needs no secret." }
        CButton { text: "Open the registration page"; quiet: true; onClicked: Qt.openUrlExternally(editor.provider.register) }
        CField { id: clientField; objectName: "accountClientId"; Layout.fillWidth: true; placeholderText: editor.providerId === "github" ? "Client ID (not needed for a token)" : "Client ID"; Accessible.name: "Client ID" }
        CField { id: secretField; visible: editor.providerId === "google"; Layout.fillWidth: true; echoMode: TextInput.Password; placeholderText: editor.account?.secretSet ? "Client secret saved · enter a new one to replace it" : "Client secret"; Accessible.name: "Client secret" }
        CField { id: tenantField; visible: editor.providerId === "microsoft"; Layout.fillWidth: true; placeholderText: "Tenant (optional, for a work account)"; Accessible.name: "Microsoft tenant" }
        CField { id: hostField; visible: editor.providerId === "github"; Layout.fillWidth: true; placeholderText: "GitHub Enterprise host (optional)"; Accessible.name: "GitHub Enterprise host" }
        SectionLabel { text: "Assistants" }
        CComboBox { objectName: "accountAssistants"; Layout.fillWidth: true; model: ["Do not use this account", "May read it", "May read it and prepare changes for you to send"]; Accessible.name: "What assistants may do"; currentIndex: ["off", "read", "write"].indexOf(editor.assistants); onActivated: index => editor.assistants = ["off", "read", "write"][index] }
        CComboBox { visible: editor.assistants !== "off"; Layout.fillWidth: true; model: ["Only models on this computer", "Models here or on your own servers", "Any model, hosted ones too"]; Accessible.name: "Which models may read it"; currentIndex: ["local", "remote", "cloud"].indexOf(editor.models); onActivated: index => editor.models = ["local", "remote", "cloud"][index] }
        CText { visible: editor.assistants !== "off" && editor.models === "cloud"; text: "What is read is sent to the conversation’s model provider."; color: Theme.amber; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CComboBox { visible: editor.assistants !== "off"; Layout.fillWidth: true; model: ["Every project", "Chosen projects"]; Accessible.name: "Where assistants may use it"; currentIndex: editor.projects === null ? 0 : 1; onActivated: index => editor.projects = index === 0 ? null : (App.session?.cwd ? [App.session.cwd] : []) }
        Repeater {
            model: editor.assistants !== "off" && editor.projects !== null ? accounts.projects : []
            CCheckBox { required property var modelData; text: modelData.name + " · " + modelData.cwd; checked: (editor.projects || []).includes(modelData.cwd); onClicked: { editor.projects = checked ? (editor.projects || []).concat([modelData.cwd]) : (editor.projects || []).filter(path => path !== modelData.cwd); checked = Qt.binding(() => (editor.projects || []).includes(modelData.cwd)) } }
        }
        CText { text: "Every change an assistant prepares is shown to you in full, and nothing is sent until you say so."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CText { objectName: "accountProblem"; visible: !!editor.problem; text: editor.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
        footerContent: RowLayout {
            spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: editor.close() }
            CButton { objectName: "saveAccount"; text: "Save"; primary: true; Layout.fillWidth: true; enabled: !rpc.busy; onClicked: editor.save() }
        }
    }
    CDialog {
        id: tokenDialog
        property var account: null
        property string problem: ""
        accessibleTitle: "Use a token"
        onOpened: { problem = ""; tokenField.forceActiveFocus() }
        CText { text: "Use a token for " + (tokenDialog.account?.label || ""); font.pixelSize: Theme.title; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CText { text: "Create a fine-grained token at GitHub with only the repositories and permissions you want, and paste it here. It is checked at once and kept in the owner-only file."; color: Theme.muted; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CField { id: tokenField; objectName: "accountTokenField"; Layout.fillWidth: true; echoMode: TextInput.Password; placeholderText: "Token"; Accessible.name: "Token" }
        CText { visible: !!tokenDialog.problem; text: tokenDialog.problem; color: Theme.danger; Layout.fillWidth: true; wrapMode: Text.Wrap }
        RowLayout {
            Layout.fillWidth: true
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: tokenDialog.close() }
            CButton { objectName: "saveAccountToken"; text: "Sign in"; primary: true; Layout.fillWidth: true; enabled: !rpc.busy && tokenField.text.trim().length > 9
                onClicked: { tokenDialog.problem = ""; rpc.call("accounts.signIn", { id: tokenDialog.account.id, method: "token", token: tokenField.text.trim() }, value => { if (value.error) { tokenDialog.problem = value.error; return } tokenField.text = ""; tokenDialog.close(); accounts.notice = "Signed in as " + value.account.login + "."; accounts.refresh() }) } }
        }
    }
    CDialog {
        id: removeDialog
        accessibleTitle: "Remove account"
        CText { text: "Remove " + (accounts.removing?.label || "") + "?"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CText { text: "Its sign-in and its unsent drafts are deleted here. Files you kept from it stay, and what was sent stays recorded."; color: Theme.muted; Layout.fillWidth: true; wrapMode: Text.Wrap }
        RowLayout {
            Layout.fillWidth: true
            CButton { text: "Keep"; Layout.fillWidth: true; onClicked: removeDialog.close() }
            CButton { objectName: "confirmRemoveAccount"; text: "Remove"; danger: true; Layout.fillWidth: true; onClicked: { removeDialog.close(); accounts.run("remove", { id: accounts.removing.id }, value => accounts.notice = value.revoked ? "Removed here and at the service." : "Removed.") } }
        }
    }
}
