import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Connections: the Ollama server, the coding CLIs PAL manages, and direct API keys.
ColumnLayout {
    id:connections
    readonly property var traits:App.state.providerTraits||({})
    readonly property var providerOrder:(App.state.providerOrder||[]).filter(id=>traits[id]?.kind==="api"&&id!=="compatible")
    property string providerQuery:""
    property int xaiManagementRequest:-1
    property string xaiManagementError:""
    readonly property var visibleProviders:providerOrder.filter(id=>{
        const needle=providerQuery.trim().toLowerCase(),trait=traits[id]||({})
        return !needle||(trait.label||id).toLowerCase().includes(needle)||id.toLowerCase().includes(needle)
    })
    Layout.fillWidth:true;spacing:Theme.space4
    CSection {
        title:"Ollama"
        description:"Local and Ollama Cloud models, and the server memory uses for embeddings."
        OllamaConnection {}
    }
    CSection {
        title:"Command-line providers"
        description:"Codex, Claude Code and AntiGravity, as installed on this computer. Each keeps its own sign-in and settings."
        ColumnLayout {
            objectName:"cliProviders";Layout.fillWidth:true;spacing:Theme.space3
            Repeater {
                model:["codex","claude","antigravity"]
                ColumnLayout {
                    required property string modelData
                    property var capability:(App.state.capabilities||{})[modelData]||({})
                    Layout.fillWidth:true;spacing:Theme.space1
                    CText { text:(modelData==="codex"?"Codex":modelData==="antigravity"?"AntiGravity":"Claude Code")+" · "+(capability.available?"Ready":"Unavailable");color:capability.available?Theme.accentText:Theme.amber;font.weight:Font.DemiBold }
                    CText { text:capability.version||capability.error||"Checking installed CLI…";color:Theme.muted;font.pixelSize:Theme.secondary }
                    CText { visible:modelData==="antigravity";text:"Sign in with agy in a terminal first. Headless actions that need approval are skipped unless allowed in AntiGravity or PAL’s CLI bypass is enabled. Desktop only; text attachments supported.";color:Theme.muted;font.pixelSize:Theme.secondary }
                }
            }
        }
    }
    AccountsSettings {}
    CSection {
        title:"AI provider accounts"
        description:"Choose a dedicated provider, save its credential, and refresh its model catalog. Keys stay in PAL’s owner-only credentials file and never enter settings, snapshots or backups."
        CField { objectName:"providerCatalogSearch";Layout.fillWidth:true;placeholderText:"Find Grok, Perplexity, Azure, Mistral…";Accessible.name:"Search AI providers";onTextChanged:connections.providerQuery=text }
        Repeater {
            model:connections.visibleProviders
            ApiConnection {
                required property string modelData
                provider:modelData
                label:connections.traits[modelData]?.label||modelData
            }
        }
        CText { visible:connections.visibleProviders.length===0;text:"No provider matches “"+connections.providerQuery.trim()+"”.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Compatible endpoint"
        description:"One OpenAI-compatible chat server of your choice, local or hosted."
        CompatibleConnection {}
    }
    CSection {
        title:"xAI Management API"
        description:"A separate Management API key is required for persistent xAI collections. It is never used for Grok inference."
        CField { id:xaiManagementKey;objectName:"apiKey_xai_management";Layout.fillWidth:true;placeholderText:"xAI Management API key";echoMode:TextInput.Password;maximumLength:8192;Accessible.name:"xAI Management API key" }
        RowLayout { Layout.fillWidth:true
            CButton { text:"Save management key";primary:true;enabled:App.connected&&connections.xaiManagementRequest<0&&xaiManagementKey.text.trim().length>0;onClicked:{connections.xaiManagementError="";connections.xaiManagementRequest=App.rpc("provider.credentials",{provider:"xai_management",key:xaiManagementKey.text.trim()});xaiManagementKey.clear()} }
            CButton { text:"Remove saved key";enabled:App.connected&&connections.xaiManagementRequest<0;onClicked:{connections.xaiManagementError="";connections.xaiManagementRequest=App.rpc("provider.credentials",{provider:"xai_management",key:""});xaiManagementKey.clear()} }
        }
        CText { visible:!!connections.xaiManagementError;text:connections.xaiManagementError;color:Theme.danger;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Saved connections"
        description:"Named accounts, deployments, gateways, Ollama computers and compatible endpoints. Each conversation keeps the exact connection it started on."
        CButton { objectName:"importPyGptProviders";text:"Import accounts from PyGPT…";onClicked:{const json=App.chooseProviderImportJson();if(json)providerImport.openWith(json)} }
        CText { visible:connections.importMigrations.length>0;text:"Models your import named that have been retired";font.weight:Font.DemiBold }
        Repeater {
            model:connections.importMigrations
            CText { required property var modelData;required property int index;objectName:"importMigration_"+index;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.secondary
                text:(connections.traits[modelData.provider]?.label||modelData.provider)+" · "+modelData.originalModel+" (from "+modelData.source+")"+(modelData.suggestedPreset?". Choose the “"+modelData.suggestedPreset+"” preset for a new conversation instead.":". Choose a current model for a new conversation.") }
        }
        NamedConnections {}
    }
    CSection {
        title:"Images & analysis"
        description:"Image backends any conversation can use, the vision helper, OCR and Code Lab. Each image request shows its backend and whether it may be billed."
        ImageConnections {}
    }
    RpcClient { id:providerImportRpc }
    property var importMigrations:[]
    function loadMigrations(){providerImportRpc.call("connections.importMigrations",{},value=>{connections.importMigrations=value.error?[]:value})}
    Component.onCompleted:loadMigrations()
    Connections { target:App;function onResult(id,value){if(id===connections.xaiManagementRequest){connections.xaiManagementRequest=-1;if(value?.error)connections.xaiManagementError=String(value.error.message||value.error);else App.notify(value?.configured?"xAI Management key saved.":"xAI Management key removed.")}} }
    CDialog {
        id:providerImport;objectName:"providerImportDialog"
        property string source:""
        property var preview:null
        property string message:""
        function inspect(){preview=null;message="Reading provider accounts…";providerImportRpc.call("connections.importPreview",{json:source,includeSecrets:includeProviderSecrets.checked},value=>{if(value.error){message=value.error;return}preview=value;message=""})}
        function openWith(json){source=json;includeProviderSecrets.checked=false;acknowledgeProviderSecrets.checked=false;open();inspect()}
        CText { text:"Import PyGPT provider accounts";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:includeProviderSecrets.checked?"Review every route and credential below. Selected secrets are copied only after the separate confirmation.":"PAL imports account names and endpoints only. Review every route below; enter credentials separately after import.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CCheckBox { id:includeProviderSecrets;text:"Also import credentials found in this PyGPT file";checked:false;onClicked:{acknowledgeProviderSecrets.checked=false;providerImport.inspect()} }
        CCheckBox { id:acknowledgeProviderSecrets;visible:includeProviderSecrets.checked;text:"I understand these credentials will be copied into PAL’s owner-only credential store";checked:false }
        CText { visible:!!providerImport.preview?.credentials;text:providerImport.preview?.credentials?"Credentials · "+(providerImport.preview.credentials.available||0)+" available · "+(providerImport.preview.credentials.selected||0)+" selected · "+(providerImport.preview.credentials.accounts||[]).length+" accounts":"";color:includeProviderSecrets.checked?Theme.amber:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:!!providerImport.message;text:providerImport.message;color:Theme.amber;wrapMode:Text.Wrap;Layout.fillWidth:true }
        Repeater {
            model:providerImport.preview?.accounts||[]
            ColumnLayout {
                required property var modelData;Layout.fillWidth:true;spacing:Theme.space1
                CText { text:(connections.traits[modelData.kind]?.label||modelData.kind)+" · "+modelData.name;font.weight:Font.DemiBold }
                CText { text:modelData.host||modelData.endpoint?.baseUrl||"Default endpoint";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
            }
        }
        CText { visible:(providerImport.preview?.duplicates||[]).length>0;text:"Already saved: "+(providerImport.preview?.duplicates||[]).join(", ");color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        Repeater { model:providerImport.preview?.notices||[];CText { required property string modelData;text:"Notice: "+modelData;color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true } }
        CText { visible:(providerImport.preview?.unmapped||[]).length>0;text:"Not imported: "+(providerImport.preview?.unmapped||[]).join(", ");color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout {
            Layout.fillWidth:true
            CButton { text:"Cancel";onClicked:providerImport.close() }
            Item { Layout.fillWidth:true }
            CButton { text:"Import "+(providerImport.preview?.accounts?.length||0)+" account"+((providerImport.preview?.accounts?.length||0)===1?"":"s");primary:true;enabled:(providerImport.preview?.accounts||[]).length>0&&(!includeProviderSecrets.checked||acknowledgeProviderSecrets.checked)
                onClicked:providerImportRpc.call("connections.importApply",{json:providerImport.source,digest:providerImport.preview.digest,includeSecrets:includeProviderSecrets.checked,acknowledgeSecrets:includeProviderSecrets.checked?true:undefined},value=>{if(value.error){providerImport.message=value.error;return}App.notify("Imported "+(value.created||[]).length+" provider account"+((value.created||[]).length===1?"":"s")+(includeProviderSecrets.checked?" with reviewed credentials.":". Add each credential separately."));connections.loadMigrations();providerImport.close()}) }
        }
    }
}
