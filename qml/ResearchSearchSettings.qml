import QtQuick
import QtQuick.Layouts

ColumnLayout {
    id: searchSettings

    Layout.fillWidth: true
    Layout.minimumWidth: 0
    spacing: Theme.space4

    readonly property var search: App.state.settings?.webSearch || ({ enabled: false, provider: "auto", searxngUrl: "" })
    readonly property var credentialStates: App.state.webSearchCredentials || ({})
    property int settingsRequest: -1
    property int credentialRequest: -1
    property string error: ""

    RpcClient { id: rpc }

    readonly property var providers: [
        { id: "auto", label: "Automatic · DuckDuckGo first" },
        { id: "duckduckgo", label: "DuckDuckGo" },
        { id: "brave", label: "Brave" },
        { id: "mojeek", label: "Mojeek" },
        { id: "searxng", label: "SearXNG · your server" },
        { id: "perplexity", label: "Perplexity Search API" },
        { id: "google_custom", label: "Google Programmable Search · existing accounts" }
    ]

    function credentialsFor(provider) {
        return credentialStates[credentialKey(provider)] || ({})
    }
    function credentialKey(provider) {
        return provider === "google_custom" ? "google_search" : provider
    }
    function setupStatus(provider) {
        if (provider === "searxng")
            return searxngUrl.text.trim() ? "" : "Enter the server URL."
        if (provider === "google_custom" || provider === "perplexity") {
            const missing = []
            if (!credentialsFor(provider).configured) missing.push("API key")
            if (provider === "google_custom" && !googleEngineId.text.trim()) missing.push("search engine ID")
            if (missing.length) return "Needed for search: " + missing.join(" and ")
        }
        return ""
    }
    function providerDescription(provider) {
        if (provider === "auto")
            return "Automatic tries DuckDuckGo, then Brave and Mojeek. Public result pages may block or rate-limit automated searches."
        if (["duckduckgo", "brave", "mojeek"].includes(provider))
            return "Searches the provider's public results page without an API key. The provider may block or rate-limit automated searches."
        if (provider === "searxng")
            return "Uses only the SearXNG server entered here. Its JSON search endpoint must be enabled. Private or local server addresses are allowed for this trusted endpoint."
        if (provider === "perplexity")
            return "Uses Perplexity's hosted Search API. Queries leave this computer and API usage may be billed. The credential is shared with the default Perplexity account in Connections."
        return "Uses Google's hosted Custom Search JSON API for an existing Programmable Search account. Queries leave this computer and API usage may be billed. Both its dedicated API key and search engine ID are required."
    }
    function saveCredential(provider, key) {
        error = ""
        credentialRequest = rpc.call("provider.credentials", { provider: credentialKey(provider), key: key }, value => {
            credentialRequest = -1
            if (value.error) error = String(value.error.message || value.error)
        })
    }
    function updateSettings(patch) {
        error = ""
        settingsRequest = rpc.call("settings.update", patch, value => {
            settingsRequest = -1
            if (value.error) error = String(value.error.message || value.error)
        })
    }

    CSection {
        title: "Web search"
        description: "Allow research runs and conversations to search the web. This setting applies across PAL."

        CCheckBox {
            objectName: "webSearchEnabled"
            text: "Enable web search"
            checked: searchSettings.search.enabled
            enabled: App.connected && searchSettings.settingsRequest < 0
            Accessible.description: "Allows eligible conversations and Research to send search queries to the selected provider."
            onClicked: searchSettings.updateSettings({ webSearch: { enabled: checked } })
        }

        ColumnLayout {
            visible: searchSettings.search.enabled
            Layout.fillWidth: true
            Layout.minimumWidth: 0
            spacing: Theme.space3

            CText { text: "Search provider"; color: Theme.muted; font.pixelSize: Theme.secondary }
            CComboBox {
                id: provider
                objectName: "webSearchProvider"
                Layout.fillWidth: true
                Layout.minimumWidth: 0
                model: searchSettings.providers
                textRole: "label"
                valueRole: "id"
                Accessible.name: "Search provider"
                keepsChoice: true; saved: searchSettings.search.provider || "auto"
                onCurrentValueChanged: if (searchApiKey) searchApiKey.clear()
            }
            CText {
                visible: !!text
                text: searchSettings.setupStatus(provider.currentValue)
                color: Theme.amber
                font.weight: Font.DemiBold
            }

            CField {
                id: searxngUrl
                objectName: "searxngUrl"
                visible: provider.currentValue === "searxng"
                Layout.fillWidth: true
                placeholderText: "http://localhost:8080"
                saved: searchSettings.search.searxngUrl || ""
                Accessible.name: "SearXNG server base URL"
                Accessible.description: "Base URL of your SearXNG server with JSON search enabled"
            }
            CField {
                id: googleEngineId
                objectName: "googleSearchEngineId"
                visible: provider.currentValue === "google_custom"
                Layout.fillWidth: true
                placeholderText: "Programmable Search engine ID"
                saved: searchSettings.search.googleEngineId || ""
                Accessible.name: "Google Programmable Search engine ID"
            }

            CText { text: searchSettings.providerDescription(provider.currentValue); color: Theme.muted; font.pixelSize: Theme.secondary }

            ColumnLayout {
                visible: ["perplexity", "google_custom"].includes(provider.currentValue)
                Layout.fillWidth: true
                Layout.minimumWidth: 0
                spacing: Theme.space2

                CText {
                    text: provider.currentValue === "perplexity" ? "Perplexity API credential" : "Google Custom Search API credential"
                    font.weight: Font.DemiBold
                }
                CText {
                    readonly property var status: searchSettings.credentialsFor(provider.currentValue)
                    text: status.source === "environment" ? "Using " + status.environment + " from the broker environment."
                        : status.source === "saved" ? "Using the saved credential in PAL's owner-only credential store."
                        : "No credential is configured."
                    color: status.configured ? Theme.muted : Theme.amber
                    font.pixelSize: Theme.secondary
                }
                CField {
                    id: searchApiKey
                    objectName: provider.currentValue === "perplexity" ? "searchApiKey_perplexity" : "searchApiKey_google"
                    Layout.fillWidth: true
                    placeholderText: provider.currentValue === "perplexity" ? "Perplexity API key" : "Google Custom Search API key"
                    echoMode: TextInput.Password
                    onVisibleChanged: if (!visible) clear()
                    maximumLength: 8192
                    Accessible.name: placeholderText
                    Accessible.description: placeholderText
                }
                GridLayout {
                    Layout.fillWidth: true
                    columns: width >= Theme.toolbarBreakpoint ? 2 : 1
                    CButton {
                        Layout.fillWidth: true
                        text: "Save credential"
                        primary: true
                        enabled: App.connected && searchSettings.credentialRequest < 0 && searchApiKey.text.trim().length > 0
                        onClicked: {
                            searchSettings.saveCredential(provider.currentValue, searchApiKey.text.trim())
                            searchApiKey.clear()
                        }
                    }
                    CButton {
                        Layout.fillWidth: true
                        text: "Remove saved credential"
                        visible: searchSettings.credentialsFor(provider.currentValue).source === "saved"
                        enabled: App.connected && searchSettings.credentialRequest < 0
                        onClicked: {
                            searchSettings.saveCredential(provider.currentValue, "")
                            searchApiKey.clear()
                        }
                    }
                }
            }

            CButton {
                objectName: "webSearchSave"
                Layout.fillWidth: true
                text: searchSettings.settingsRequest < 0 ? "Apply search settings" : "Applying…"
                primary: true
                enabled: App.connected && searchSettings.settingsRequest < 0
                Accessible.description: "Save the selected web search provider and its visible configuration."
                onClicked: {
                    const patch = { provider: provider.currentValue }
                    if (provider.currentValue === "searxng") patch.searxngUrl = searxngUrl.text.trim()
                    if (provider.currentValue === "google_custom") patch.googleEngineId = googleEngineId.text.trim()
                    searchSettings.updateSettings({ webSearch: patch })
                }
            }

        }

        CText {
            visible: !!searchSettings.error
            text: searchSettings.error
            color: Theme.danger
            font.pixelSize: Theme.secondary
        }
    }

}
