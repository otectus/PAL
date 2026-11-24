import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Named provider accounts are broker-owned records. A conversation keeps its connection identity and
// revision; secrets are saved separately and never round-trip through this component.
ColumnLayout {
    id: named
    objectName: "namedConnections"
    Layout.fillWidth: true; spacing: Theme.space2
    property var items: []
    property string error: ""
    readonly property var traits: App.state.providerTraits || ({})
    readonly property var providerKinds: (App.state.providerOrder || []).filter(id => id === "ollama" || traits[id]?.kind === "api")
    RpcClient { id: rpc }
    function refresh() { rpc.call("connections.list", {}, value => { if (!value.error) items = value }) }
    Component.onCompleted: refresh()
    Connections { target: App; function onConnectedChanged() { if (App.connected) named.refresh() } }
    CText { text: "Keep separate work, personal, regional or self-hosted accounts under names. Choose the exact account in New conversation; moving a conversation to another destination requires review."; color: Theme.muted; font.pixelSize: Theme.secondary; wrapMode: Text.Wrap; Layout.fillWidth: true }
    Repeater {
        model: named.items.filter(item => !item.migrated)
        Rectangle {
            required property var modelData; required property int index
            objectName: "namedConnection_" + index
            Layout.fillWidth: true; implicitHeight: row.implicitHeight + Theme.gutter; radius: Theme.radiusControl; color: Theme.raised; border.color: Theme.border
            ColumnLayout {
                id: row; anchors.fill: parent; anchors.margins: Theme.space2; spacing: Theme.space1
                CText { text: modelData.name; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                CText { text: ((named.traits[modelData.kind]?.label || (modelData.kind === "ollama" ? "Ollama" : modelData.kind)) + (modelData.variant ? " · " + modelData.variant : "") + " · " + (modelData.host || modelData.endpoint?.baseUrl || "provider default") + " · processes on " + (modelData.task?.processing || modelData.endpoint?.processing || "unknown") + (modelData.keySet ? " · credential set" : modelData.kind === "ollama" ? "" : " · credential needed"))
                    + " · " + modelData.conversations + (modelData.conversations === 1 ? " conversation" : " conversations"); color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                Flow {
                    Layout.fillWidth: true; spacing: Theme.space2
                    CButton { objectName: "namedConnectionEdit_" + index; text: "Edit…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: editor.openFor(modelData) }
                    CButton { objectName: "namedConnectionCheck_" + index; text: "Check…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: check.openFor(modelData) }
                    CButton { objectName: "namedConnectionBridge_" + index; visible: modelData.kind === "litellm" && modelData.variant === "bridge"; text: "Bridge…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: bridge.openFor(modelData) }
                    CButton { objectName: "namedConnectionRemove_" + index; text: "Remove…"; quiet: true; danger: true; implicitHeight: Theme.compactHeight; onClicked: { named.error = ""; uses.openFor(modelData) } }
                }
            }
        }
    }
    CButton { objectName: "addNamedConnection"; text: "Add a connection…"; iconName: "plus"; enabled: App.connected; onClicked: editor.openFor(null) }
    CText { visible: !!named.error; text: named.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    ConnectionCheck {
        id: check
        // What a compatible server was found to do becomes its declaration; the key and address stay as they are.
        onDeclared: found => {
            const item = named.items.find(row => row.id === check.connectionId), endpoint = {}
            if (!item) return
            for (const pair of [["tools", "tools"], ["images", "images"], ["streaming", "streaming"]]) if (found[pair[0]] !== undefined) endpoint[pair[1]] = found[pair[0]] === true
            rpc.call("connections.save", { id: item.id, expectedRevision: item.revision, name: item.name, endpoint: endpoint }, value => { named.error = value.error || ""; named.refresh() })
        }
    }
    ConnectionUses { id: uses; onRemoved: named.refresh(); onMoved: named.refresh() }
    CDialog {
        id: editor; objectName: "namedConnectionEditor"
        property var existing: null
        readonly property string providerId: kind.currentIndex >= 0 ? named.providerKinds[kind.currentIndex] || "" : ""
        readonly property bool ollama: providerId === "ollama"
        readonly property var providerTrait: named.traits[providerId] || ({})
        readonly property var variants: providerTrait.variants || []
        readonly property var selectedVariant:variants[variant.currentIndex]||({})
        readonly property var authOptions: selectedVariant.auth?.length ? selectedVariant.auth : (providerTrait.auth || [])
        function openFor(item) {
            existing = item; kind.currentIndex = Math.max(0, named.providerKinds.indexOf(item?.kind || "ollama")); kind.enabled = !item; name.text = item?.name || ""
            address.text = item ? (item.host || item.endpoint?.baseUrl || "") : ""; processing.currentIndex = Math.max(0, ["local", "remote", "cloud", "unknown"].indexOf(item?.task?.processing || item?.endpoint?.processing || "unknown"))
            dialect.currentIndex=item?.task?.dialect==="responses"?1:0
            needsKey.checked = !!item?.endpoint?.requiresKey; authHeader.text=item?.endpoint?.authHeader||""; tools.checked = !!item?.endpoint?.tools; images.checked = !!item?.endpoint?.images; streaming.checked = item ? item.endpoint?.streaming !== false : true; usage.checked = !!item?.endpoint?.usage; contextLength.text = item?.endpoint?.contextLength ? String(item.endpoint.contextLength) : ""; maxOutput.text = item?.endpoint?.maxOutputTokens ? String(item.endpoint.maxOutputTokens) : ""; organization.text = item?.organization || ""; project.text = item?.project || ""; key.text = ""; managementKey.text = ""; deployment.text=item?.deployment||""; apiVersion.text=item?.apiVersion||""; region.text=item?.region||""; underlyingModel.text=item?.underlyingModel||""; message.text = ""; open()
            Qt.callLater(()=>{variant.currentIndex=Math.max(0,editor.variants.findIndex(row=>(row.id||row)===item?.variant))})
            Qt.callLater(()=>{auth.currentIndex=Math.max(0,editor.authOptions.findIndex(value=>(value.id||value)===item?.auth))})
        }
        CText { text: editor.existing ? "Edit connection" : "Add a connection"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CComboBox { id: kind; objectName: "namedConnectionKind"; Layout.fillWidth: true; model: named.providerKinds.map(id=>named.traits[id]?.label||id); Accessible.name: "Provider for this connection" }
        CComboBox { id:variant;visible:editor.variants.length>1;Layout.fillWidth:true;model:editor.variants;textRole:"label";valueRole:"id";Accessible.name:"Provider connection variant" }
        CComboBox { id:auth;visible:editor.authOptions.length>0 && (editor.providerId==="azure_openai" || editor.providerId==="google" && editor.selectedVariant.id==="vertex");Layout.fillWidth:true;model:editor.authOptions.map(value=>value.label||value.id||value);Accessible.name:"Authentication method" }
        CField { id: name; objectName: "namedConnectionName"; Layout.fillWidth: true; maximumLength: 60; placeholderText: "Name, such as Workstation GPU"; Accessible.name: "Connection name" }
        CField { id: address; objectName: "namedConnectionAddress"; Layout.fillWidth: true; placeholderText: editor.ollama ? "http://192.168.1.20:11434" : editor.providerId === "compatible" ? "https://gateway.example.com/v1" : "Optional custom endpoint"; Accessible.name: "Address" }
        CField { id:deployment; visible:editor.providerId==="azure_openai"; Layout.fillWidth:true; placeholderText:"Azure deployment name (required)"; Accessible.name:"Azure deployment name" }
        CField { id:underlyingModel; visible:editor.providerId==="azure_openai"; Layout.fillWidth:true; placeholderText:"Underlying model, such as gpt-5.2"; Accessible.name:"Azure underlying model" }
        CField { id:region; visible:editor.providerId==="azure_openai"; Layout.fillWidth:true; placeholderText:"Azure region (optional)"; Accessible.name:"Azure region" }
        CField { id:apiVersion; visible:editor.providerId==="azure_openai"; Layout.fillWidth:true; placeholderText:"Azure API version (optional)"; Accessible.name:"Azure API version" }
        CField { id:organization; objectName:"namedConnectionOrganization"; visible:editor.providerId==="openai"; Layout.fillWidth:true; maximumLength:72; placeholderText:"Organization ID (optional)"; Accessible.name:"OpenAI organization ID" }
        CField { id:project; objectName:"namedConnectionProject"; visible:editor.providerId==="openai"; Layout.fillWidth:true; maximumLength:72; placeholderText:"Project ID (optional)"; Accessible.name:"OpenAI project ID" }
        CComboBox { id: processing; Layout.fillWidth: true; model: ["Processes on this computer", "Processes on my own server", "Processes in a cloud service", "Not sure"]; Accessible.name: "Where it processes requests" }
        CComboBox { id:dialect; visible:editor.providerId==="compatible"; Layout.fillWidth:true; model:["Chat Completions","Responses"]; Accessible.name:"Protocol" }
        Flow {
            visible: editor.providerId==="compatible"; Layout.fillWidth: true; spacing: Theme.space3
            CCheckBox { id: needsKey; width: implicitContentWidth + leftPadding + rightPadding; text: "Needs a key" }
            CCheckBox { id: tools; width: implicitContentWidth + leftPadding + rightPadding; text: "Supports tools" }
            CCheckBox { id: images; width: implicitContentWidth + leftPadding + rightPadding; text: "Accepts images" }
            CCheckBox { id: streaming; objectName: "namedConnectionStreaming"; width: implicitContentWidth + leftPadding + rightPadding; text: "Streams replies" }
            CCheckBox { id: usage; objectName: "namedConnectionUsage"; width: implicitContentWidth + leftPadding + rightPadding; text: "Reports token usage" }
        }
        GridLayout {
            visible: editor.providerId === "compatible"; Layout.fillWidth: true; columns: width >= Theme.formBreakpoint ? 2 : 1; columnSpacing: Theme.space2; rowSpacing: Theme.space2
            CField { id: contextLength; objectName: "namedConnectionContext"; Layout.fillWidth: true; placeholderText: "Context window in tokens (8,192 assumed)"; Accessible.name: "Declared context window"; validator: IntValidator { bottom: 0; top: 10000000 } }
            CField { id: maxOutput; objectName: "namedConnectionOutput"; Layout.fillWidth: true; placeholderText: "Output limit in tokens (optional)"; Accessible.name: "Declared output limit"; validator: IntValidator { bottom: 0; top: 1000000 } }
        }
        CField { id:authHeader;visible:editor.providerId==="compatible"&&needsKey.checked;Layout.fillWidth:true;placeholderText:"Custom key header (blank uses Authorization: Bearer)";Accessible.name:"Compatible API key header name" }
        CText { visible:authHeader.visible&&!!editor.existing&&authHeader.text.trim()!==(editor.existing.endpoint?.authHeader||"");text:"Changing the header invalidates the saved credential. Re-enter the key below.";color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout { visible:!editor.ollama; Layout.fillWidth:true
            CField { id: key; Layout.fillWidth: true; echoMode: TextInput.Password; placeholderText: editor.existing?.keySet ? "Leave empty to keep the saved credential" : "Credential for this account"; Accessible.name: "Provider credential" }
            CButton { visible:!!editor.existing?.keySet; text:"Clear"; quiet:true; danger:true; onClicked:rpc.call("provider.credentials",{provider:editor.providerId,connectionId:editor.existing.id,key:null},value=>{message.text=value.error||"Credential cleared";named.refresh()}) }
        }
        RowLayout { visible:editor.providerId==="xai"; Layout.fillWidth:true
            CField { id:managementKey; Layout.fillWidth:true; echoMode:TextInput.Password; placeholderText:"Separate xAI Management API key"; Accessible.name:"xAI Management credential" }
            CButton { visible:!!editor.existing; text:"Clear"; quiet:true; danger:true; onClicked:rpc.call("provider.credentials",{provider:"xai_management",connectionId:editor.existing.id,key:null},value=>{message.text=value.error||"Management credential cleared"}) }
        }
        CText { visible: editor.providerId==="compatible"; text: "Compatible capabilities are your declaration. Processing location decides which files and images may go to it."; color: Theme.muted; font.pixelSize: Theme.caption }
        CText { id: message; visible: !!text; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
        RowLayout {
            Layout.fillWidth: true
            Item { Layout.fillWidth: true }
            CButton { text: "Cancel"; onClicked: editor.close() }
            CButton {
                objectName: "namedConnectionSave"; text: "Save"; primary: true; enabled: name.text.trim().length > 0 && (!!address.text.trim() || !editor.ollama && editor.providerId!=="compatible") && (editor.providerId!=="azure_openai" || !!deployment.text.trim())
                onClicked: {
                    const endpointValue={processing:["local","remote","cloud","unknown"][processing.currentIndex]};if(address.text.trim())endpointValue.baseUrl=address.text.trim()
                    if(editor.providerId==="compatible"){endpointValue.requiresKey=needsKey.checked;endpointValue.tools=tools.checked;endpointValue.images=images.checked;endpointValue.streaming=streaming.checked;endpointValue.usage=usage.checked;endpointValue.contextLength=Number(contextLength.text)||0;endpointValue.maxOutputTokens=Number(maxOutput.text)||0;endpointValue.authHeader=needsKey.checked?authHeader.text.trim():""}
                    const selectedVariant=variant.visible?(variant.currentValue||""):"",selectedAuth=auth.visible?(editor.authOptions[auth.currentIndex]?.id||editor.authOptions[auth.currentIndex]||""):""
                    const value = Object.assign({ name: name.text.trim(), processing:["local","remote","cloud","unknown"][processing.currentIndex] }, editor.existing ? { id: editor.existing.id, expectedRevision: editor.existing.revision } : { kind: editor.providerId },
                        editor.ollama ? { host: address.text.trim() } : { endpoint:endpointValue },selectedVariant?{variant:selectedVariant}:{},selectedAuth?{auth:selectedAuth}:{},editor.providerId==="compatible"?{dialect:dialect.currentIndex===1?"responses":"chat_completions"}:{},editor.providerId==="azure_openai"?{deployment:deployment.text.trim(),apiVersion:apiVersion.text.trim(),region:region.text.trim(),underlyingModel:underlyingModel.text.trim()}:{},editor.providerId==="openai"?{organization:organization.text.trim(),project:project.text.trim()}:{})
                    rpc.call("connections.save", value, saved => {
                        if (saved.error) { message.text = saved.error; return }
                        if (!editor.ollama && key.text) rpc.call("provider.credentials", { provider: editor.providerId, key: key.text, connectionId: saved.id }, () => named.refresh())
                        if (editor.providerId === "xai" && managementKey.text) rpc.call("provider.credentials", { provider: "xai_management", key: managementKey.text, connectionId: saved.id }, () => named.refresh())
                        editor.close(); named.refresh()
                    })
                }
            }
        }
    }
    LiteLlmBridge { id: bridge }
}
