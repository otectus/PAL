import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CDialog {
    id:sessionForm
    accessibleTitle:sessionForm.projectSettings?"Project settings":sessionForm.imported.nativeId?"Continue a CLI session":"Start a conversation"
    signal sessionOpened()
    signal projectSaved(var project)
    property bool projectSettings:false
    property var project:({})
    objectName:"newSessionDialog"
    property var imported: ({})
    property int requestId:-1
    property string error:""
    property string modelError:""
    property string desiredModel:""
    property string desiredEffort:""
    readonly property bool compactForm:width<Theme.formBreakpoint
    // A general conversation opens with the choices saved by "Save as my defaults". Project settings and
    // CLI imports do not, and no other way of starting a conversation (a project, delegation, a branch,
    // a phone) reads them. Trust is never saved: it is confirmed for each conversation's folder.
    readonly property bool general:!projectSettings&&!imported.nativeId
    property bool prefilled:false
    // M01/A06: a project's style and its convention files are saved after its defaults, each with the
    // revision the previous step returned.
    property var styleChoices:[{id:"",label:"The personality in Settings"}]
    property int stylesRequest:-1
    property string projectStage:""
    function nextProjectStep(saved){
        const profileId=projectStyle.currentIndex>0?styleChoices[projectStyle.currentIndex].id:null
        if((saved.behaviorProfileId||null)!==profileId){projectStage="style";requestId=App.rpc("projects.setProfile",{cwd:saved.cwd,expectedRevision:saved.revision,profileId:profileId});return true}
        if(!!saved.conventions!==conventions.checked){projectStage="conventions";requestId=App.rpc("projects.setConventions",{cwd:saved.cwd,expectedRevision:saved.revision,enabled:conventions.checked});return true}
        return false
    }
    property var pendingDefaults:null
    closePolicy:requestId>=0?Popup.NoAutoClose:Popup.CloseOnEscape|Popup.CloseOnPressOutside
    function openFolder(cwd) {
        if(requestId>=0){App.notify("Finish opening this conversation before choosing another folder.");return}
        imported={cwd:cwd}
        if(visible){folder.text=cwd;trust.checked=false}
        else open()
    }
    function editProject(value) {
        project=value||({})
        imported=Object.assign({},project.defaults||{},{cwd:project.cwd||"",title:project.name||""})
        open()
    }
    property var modelRequests: ({})
    // W08: the broker describes every provider (label, kind, tools) and the order to offer them in. The
    // state reaches QML as a map with sorted keys, so the order comes as a list; an older broker gets the
    // same defaults.
    readonly property var traits:App.state.providerTraits||({})
    readonly property var providerOrder:(App.state.providerOrder||[]).length?App.state.providerOrder:["codex","claude","ollama","antigravity","openai","anthropic","google","compatible"]
    property string providerName:providerOrder[provider.currentIndex]||"codex"
    readonly property var providerTrait:traits[providerName]||({})
    property bool isOllama:providerName==="ollama"
    property bool isApi:providerTrait.kind?providerTrait.kind==="api":["openai","anthropic","google","compatible"].includes(providerName)
    property bool isConversation:providerTrait.tools?providerTrait.tools==="cere":isOllama||isApi
    property string savedDefault:App.state.settings?.ollama?.model||""
    // 11.1: named connections for Ollama hosts and compatible endpoints; the first choice is Settings' default.
    property var connections:[]
    readonly property var providerConnections:connections.filter(c=>c.kind===providerName&&!c.migrated)
    property string connectionId:""
    property var connectionModels:({status:"unknown",models:[]})
    readonly property var selectedConnection:connectionId?providerConnections.find(c=>c.id===connectionId)||({}):({})
    readonly property var compatibleEndpoint:providerName==="compatible"?(connectionId?(selectedConnection.endpoint||({})):(App.state.settings?.compatible||({}))):({})
    readonly property bool compatibleCredentialReady:providerName!=="compatible"||!!compatibleEndpoint.baseUrl&&(compatibleEndpoint.requiresKey!==true||(connectionId?selectedConnection.keySet===true:capability.configured===true))
    readonly property bool connectionCredentialReady:!connectionId||isOllama||selectedConnection.keySet===true||selectedConnection.endpoint?.requiresKey===false
    // Tool scope belongs to the selected endpoint, not whichever compatible endpoint is the Settings default.
    readonly property bool apiTools:providerName!=="compatible"||compatibleEndpoint.tools===true
    RpcClient { id:connectionRpc }
    function loadConnections(){connectionRpc.call("connections.list",{},value=>{if(!value.error)sessionForm.connections=value})}
    function chooseConnection(index){
        connectionId=index>0?providerConnections[index-1].id:"";connectionModels={status:connectionId?"loading":"unknown",models:[]}
        if(connectionId){const asked=connectionId;connectionRpc.call("connections.models",{id:asked},value=>{if(sessionForm.connectionId!==asked)return;sessionForm.connectionModels=value.error?{status:"error",models:[],error:value.error}:{status:"ready",models:value.models||[]}})}
    }
    property var capability:connectionId?({modelsStatus:connectionModels.status,models:connectionModels.models,modelsError:connectionModels.error||""}):(App.state.capabilities||{})[providerName]||({})
    readonly property bool apiCredentialReady:!isApi?true:connectionId?connectionCredentialReady:providerName==="compatible"?compatibleCredentialReady:capability.configured===true
    readonly property bool providerSetupReady:isApi?apiCredentialReady:isOllama?capability.modelsStatus==="ready":capability.available===true
    readonly property string providerStatus:{
        if(!isApi&&!isOllama)return capability.available?"CLI found · Sign-in is checked when the conversation starts.":capability.error||"CLI executable not found on this computer."
        if(providerName==="compatible"&&!compatibleEndpoint.baseUrl)return "Set a compatible endpoint in Settings → Connections."
        if(isApi&&!apiCredentialReady)return providerName==="compatible"?"This endpoint requires a key. Add it in Settings → Connections.":"Add an API key in Settings → Connections."
        if(capability.modelsStatus==="loading")return "Checking the model catalog…"
        if(capability.modelsStatus==="error")return (capability.modelsError||"The model catalog could not be loaded")+(isApi?" · You can still enter a model ID.":"")
        if(capability.modelsStatus==="ready")return "Connected · "+(capability.models||[]).length+" model"+((capability.models||[]).length===1?"":"s")
        return isApi?"Credentials ready · Refresh to check models, or enter a model ID.":"Refresh to check available models."
    }
    property var modelOptions:[{id:"",displayName:isApi?"Choose a model":isOllama?(savedDefault?"Default · "+savedDefault:"Choose a model"):"CLI default",description:isApi?"Select from the catalog or enter a model ID below":isOllama?"Choose a default in Settings → Connections":"Use the model configured by the CLI",efforts:[],defaultEffort:"",isDefault:true}].concat(capability.models||[]).concat((projectSettings||prefilled)&&desiredModel&&!(capability.models||[]).some(m=>m.id===desiredModel)?[{id:desiredModel,displayName:desiredModel+" · saved",description:"Saved selection. Availability is checked when you open a session.",efforts:[],defaultEffort:""}]:[])
    property var effectiveModel:isOllama?(capability.models||[]).find(m=>m.id===(modelName.currentValue||savedDefault)):selectedModel
    property var selectedModel:modelName.currentIndex>=0&&modelName.currentIndex<modelOptions.length?modelOptions[modelName.currentIndex]:modelOptions[0]
    readonly property bool selectedToolsSupported:isConversation&&(isApi?apiTools&&!(effectiveModel?.capabilities||[]).includes("no-local-tools"):!!effectiveModel?.capabilities?.includes("tools"))
    property var effortOptions:[{id:"",displayName:"Provider default",description:"Use the provider or model default"}].concat(selectedModel&&selectedModel.efforts?selectedModel.efforts:[]).concat((projectSettings||prefilled)&&desiredEffort&&!(selectedModel?.efforts||[]).some(e=>e.id===desiredEffort)?[{id:desiredEffort,displayName:desiredEffort+" · saved"}]:[])
    readonly property bool supportsEffort:providerTrait.effort===true||effortOptions.length>1
    property var providerOptions:({})
    // A catalog that lists what a model takes, without reasoning in it, says the model does not reason.
    function withoutReasoning(model){const takes=model?.supportedParameters;return !!takes&&takes.length>0&&takes.indexOf("reasoning")<0&&takes.indexOf("reasoning_effort")<0}
    function chooseEffort(value) {
        const wanted=value===undefined?"":value
        const index=effortOptions.findIndex(option=>option.id===wanted)
        reasoningEffort.currentIndex=index>=0?index:0
        desiredEffort=reasoningEffort.currentValue||""
    }
    function chooseModel(modelValue) {
        let index=modelOptions.findIndex(option=>option.id===(modelValue||""))
        if(index<0)index=modelOptions.findIndex(option=>option.isDefault)
        modelName.currentIndex=index>=0?index:0
        desiredModel=modelName.currentValue||""
        // The effort follows once the model's efforts are listed. It is read when that pass runs: an effort
        // chosen after this pass was scheduled must not be replaced by the one wanted before.
        Qt.callLater(()=>{if(sessionForm)sessionForm.chooseEffort(sessionForm.desiredEffort)})
    }
    function refreshModels() {
        if(!App.connected)return
        if(connectionId){chooseConnection(connectionBox.currentIndex);return}
        modelError=""
        const id=App.rpc("provider.models",{provider:providerName})
        const requests=Object.assign({},modelRequests);requests[id]=providerName;modelRequests=requests
    }
    function submissionBlocker(){
        if(!App.connected)return "Reconnect PAL to continue."
        if(projectSettings){
            if(!sessionTitle.text.trim())return "Enter a project name."
            if(!folder.text.trim().startsWith("/"))return "Choose an absolute project folder."
            if(isApi&&!customModel.text.trim()&&!modelName.currentValue)return "Choose a model or enter its model ID."
            if(tools.checked&&!selectedToolsSupported)return isApi&&!apiTools?"This endpoint is not declared to support tools. Turn desktop tools off, or update its declaration.":"This model does not support tools. Choose another model or turn desktop tools off."
            return ""
        }
        if(!providerSetupReady){
            if(!isApi&&!isOllama)return "Install or repair this provider CLI, then Refresh. Sign-in is checked when the conversation starts."
            if(isOllama)return capability.modelsStatus==="loading"?"Wait for the Ollama model list.":"Connect to Ollama and refresh its models."
            if(providerName==="compatible"&&!compatibleEndpoint.baseUrl)return "Set this compatible endpoint in Settings → Connections."
            return providerName==="compatible"?"Add the key required by this endpoint in Settings → Connections.":"Add this provider’s API key in Settings → Connections."
        }
        if(tools.checked&&!selectedToolsSupported)return isApi&&!apiTools?"This endpoint is not declared to support tools. Turn desktop tools off, or update its saved declaration.":"This model does not support tools. Choose another model or turn desktop tools off."
        if(!folder.text.trim().startsWith("/")&&!(isConversation&&!tools.checked&&!folder.text.trim()))return "Choose an absolute project folder. It is optional only when desktop tools are off."
        if(isOllama&&!effectiveModel)return "Choose an available Ollama model."
        if(isApi&&!customModel.text.trim()&&!modelName.currentValue)return "Choose a model or enter its model ID."
        if(trust.visible&&!trust.checked)return isApi?"Confirm this conversation’s desktop tool access.":"Confirm that you trust this project’s CLI configuration."
        if(imported.nativeId&&!handoff.checked)return "Confirm that the external CLI session has stopped."
        return ""
    }
    readonly property string openBlocker:requestId<0?submissionBlocker():""
    onModelOptionsChanged:Qt.callLater(()=>{if(sessionForm)sessionForm.chooseModel(sessionForm.desiredModel)})
    // Each opening starts at the top, where the heading and the saved-defaults note are.
    onAboutToShow:scrollToTop()
    onOpened:{
        sessionForm.loadConnections();sessionForm.connectionId="";sessionForm.providerOptions={};connectionBox.currentIndex=0
        const saved=general?App.state.settings?.conversationDefaults:null
        prefilled=!!saved
        const start=saved||imported
        sessionTitle.text=imported.title||""
        folder.text=imported.cwd||""
        provider.currentIndex=Math.max(0,providerOrder.indexOf(start.provider||"codex"))
        desiredModel=start.model||"";desiredEffort=start.effort||"";providerOptionsEditor.reset(start.providerOptions||{})
        chooseModel(desiredModel);refreshModels()
        customModel.text="";temporary.checked=(projectSettings||prefilled)&&!!start.temporary;tools.checked=(projectSettings||prefilled)&&!!start.tools;trust.checked=projectSettings&&!!imported.trusted;favorite.checked=!!project.favorite;conventions.checked=projectSettings&&!!project.conventions;projectStage="";if(projectSettings)stylesRequest=App.rpc("presets.list",{});handoff.checked=false;saveDefaults.checked=false;error="";modelError=""
        Qt.callLater(()=>sessionTitle.forceActiveFocus())
    }
    CText { Accessible.role:Accessible.Heading;text:sessionForm.accessibleTitle;font.pixelSize:Theme.page;font.weight:Font.DemiBold }
    CText { text:sessionForm.projectSettings?"New sessions inherit these defaults. Existing conversations keep their settings.":sessionForm.imported.nativeId?"Review the details before bringing this session into PAL.":"Name the conversation, then choose where and how it should run.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    CText { objectName:"savedDefaultsNote";visible:sessionForm.prefilled;text:"Filled in from your saved defaults. Change anything you like for this one.";color:Theme.accentText;font.pixelSize:Theme.secondary }
    SectionLabel { text:"Conversation";Accessible.role:Accessible.Heading }
    CText { text:sessionForm.projectSettings?"Project name":"Title (optional)";color:Theme.muted;font.pixelSize:Theme.secondary }
    CField {
        id:sessionTitle;objectName:"sessionTitle";Layout.fillWidth:true;maximumLength:100
        placeholderText:sessionForm.projectSettings?"Project name":"Untitled session";Accessible.name:sessionForm.projectSettings?"Project name":"Session title"
    }
    CCheckBox { id:favorite;objectName:"projectFavorite";visible:sessionForm.projectSettings;text:"Keep this project at the top" }
    SectionLabel { text:"Run with";Accessible.role:Accessible.Heading;Layout.topMargin:Theme.space1 }
    CText { text:"Provider";color:Theme.muted;font.pixelSize:Theme.secondary }
    CComboBox {
        id:provider;objectName:"sessionProvider";Layout.fillWidth:true;model:sessionForm.providerOrder.map(id=>id==="compatible"?(App.state.settings?.compatible?.label||sessionForm.traits[id]?.label||"Compatible endpoint"):(sessionForm.traits[id]?.label||({codex:"Codex",claude:"Claude Code",ollama:"Ollama",antigravity:"AntiGravity",openai:"OpenAI API",anthropic:"Claude API",google:"Google AI API"})[id]||id));enabled:!sessionForm.imported.nativeId;Accessible.name:"Session provider"
        onActivated:{customModel.text="";tools.checked=false;if(sessionForm.projectSettings)trust.checked=false;sessionForm.desiredModel="";sessionForm.desiredEffort="";sessionForm.connectionId="";sessionForm.providerOptions={};connectionBox.currentIndex=0;sessionForm.chooseModel("");sessionForm.refreshModels()}
    }
    CText {
        objectName:"sessionProviderStatus";Layout.fillWidth:true;wrapMode:Text.Wrap
        text:sessionForm.providerStatus
        color:sessionForm.providerSetupReady&&sessionForm.capability.modelsStatus!=="error"?Theme.success:Theme.amber;font.pixelSize:Theme.caption
    }
    CComboBox {
        id:connectionBox;objectName:"sessionConnection";Layout.fillWidth:true;visible:!sessionForm.projectSettings&&sessionForm.providerConnections.length>0
        model:[(sessionForm.providerTrait.label||sessionForm.providerName)+" default"].concat(sessionForm.providerConnections.map(c=>c.name+" · "+(c.variant?c.variant+" · ":"")+(c.host||c.endpoint?.baseUrl||"provider endpoint")))
        Accessible.name:"Provider account or connection";onActivated:index=>{sessionForm.desiredModel="";sessionForm.providerOptions={};sessionForm.chooseConnection(index)}
    }
    CText { text:!sessionForm.projectSettings&&sessionForm.isConversation&&!tools.checked?"Project folder (optional)":"Project folder";color:Theme.muted;font.pixelSize:Theme.secondary }
    GridLayout {
        Layout.fillWidth:true
        columns:sessionForm.compactForm?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space2
        CField { id:folder;objectName:"sessionProjectPath";Layout.fillWidth:true;placeholderText:"Absolute project path";Accessible.name:"Project folder";readOnly:sessionForm.projectSettings&&!!sessionForm.project.cwd }
        CButton { visible:!sessionForm.projectSettings||!sessionForm.project.cwd;Layout.fillWidth:sessionForm.compactForm;text:"Browse";onClicked:{const p=App.chooseFolder();if(p){folder.text=p;if(sessionForm.projectSettings&&!sessionTitle.text.trim())sessionTitle.text=p.split("/").filter(v=>!!v).pop()||p}} }
    }
    RowLayout {
        Layout.fillWidth:true
        CText { text:"Model";color:Theme.muted;font.pixelSize:Theme.secondary;Layout.fillWidth:true }
        CButton { objectName:"sessionModelsBrowse";visible:(sessionForm.capability.models||[]).length>8;text:modelBrowser.visible?"Close list":"Browse…";quiet:true;onClicked:modelBrowser.shown=!modelBrowser.shown }
        CButton { objectName:"sessionModelsRefresh";text:sessionForm.capability.modelsStatus==="loading"?"Loading…":"Refresh";quiet:true;enabled:App.connected&&sessionForm.capability.modelsStatus!=="loading";onClicked:sessionForm.refreshModels() }
    }
    CComboBox {
        id:modelName;objectName:"sessionModel";Layout.fillWidth:true;model:sessionForm.modelOptions;textRole:"displayName";valueRole:"id";Accessible.name:"Session model"
        onActivated:{if(!sessionForm.selectedToolsSupported)tools.checked=false;sessionForm.desiredModel=currentValue||"";sessionForm.desiredEffort="";sessionForm.chooseEffort("")}
    }
    ModelBrowser {
        id:modelBrowser;property bool shown:false
        visible:shown&&models.length>0;Layout.fillWidth:true
        models:sessionForm.capability.models||[];current:modelName.currentValue||"";provider:sessionForm.providerName;connectionId:sessionForm.connectionId
        preferred:sessionForm.providerOptions.preferredProviders||[]
        onChosen:id=>{if(sessionForm.isApi)customModel.text="";sessionForm.desiredEffort="";sessionForm.chooseModel(id);if(!sessionForm.selectedToolsSupported)tools.checked=false}
        onPrefer:list=>providerOptionsEditor.setOption("preferredProviders",list.length?list:undefined)
        onProviderChanged:shown=false
    }
    CField { id:customModel;objectName:"sessionCustomModel";visible:sessionForm.isApi;Layout.fillWidth:true;maximumLength:512;placeholderText:"Or enter an API model ID";Accessible.name:"Custom API model ID" }
    CText { visible:sessionForm.isApi&&sessionForm.providerName!=="compatible";text:(sessionForm.connectionId?"Uses account “"+(sessionForm.selectedConnection.name||sessionForm.providerTrait.label)+"”. ":"Uses the default credential in Settings → Connections. ")+"API usage may incur charges; authorized phones use the same bound account.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:sessionForm.providerName==="compatible";text:sessionForm.compatibleEndpoint.baseUrl?(sessionForm.connectionId?"Uses saved connection “"+(sessionForm.selectedConnection.name||"Compatible endpoint")+"” · ":"Uses the Settings default · ")+sessionForm.compatibleEndpoint.baseUrl+". Tool and image access follow this endpoint’s declarations.":"Set the compatible endpoint in Settings → Connections first.";color:sessionForm.compatibleEndpoint.baseUrl?Theme.muted:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:sessionForm.providerName==="antigravity";text:"Uses your agy sign-in. Actions needing approval may be skipped by headless mode. Images are not supported.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { visible:!sessionForm.isOllama&&sessionForm.selectedModel&&!!sessionForm.selectedModel.description;text:sessionForm.selectedModel?sessionForm.selectedModel.description:"";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CText { objectName:"sessionModelFacts";visible:text.length>0&&!modelBrowser.visible;text:sessionForm.effectiveModel?.detail||"";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    CText { visible:sessionForm.supportsEffort;text:"Reasoning effort";color:Theme.muted;font.pixelSize:Theme.secondary }
    CComboBox {
        id:reasoningEffort;visible:sessionForm.supportsEffort;objectName:"sessionEffort";Layout.fillWidth:true;model:sessionForm.effortOptions;textRole:"displayName";valueRole:"id";Accessible.name:"Session effort"
        onActivated:sessionForm.desiredEffort=currentValue||""
    }
    CText { visible:!!reasoningEffort.currentValue&&reasoningEffort.currentIndex>=0&&!!sessionForm.effortOptions[reasoningEffort.currentIndex].description;text:reasoningEffort.currentIndex>=0?(sessionForm.effortOptions[reasoningEffort.currentIndex].description||""):"";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
    ColumnLayout {
        visible:providerOptionsEditor.fields.length>0;Layout.fillWidth:true;spacing:Theme.space2
        SectionLabel { text:"PROVIDER OPTIONS";Accessible.role:Accessible.Heading }
        ProviderOptionsEditor { id:providerOptionsEditor;schema:sessionForm.providerTrait.optionsSchema||[];variant:sessionForm.selectedConnection.variant||"";hiddenKeys:sessionForm.effortOptions.length>1||sessionForm.withoutReasoning(sessionForm.selectedModel)?["reasoningEffort"]:[];values:sessionForm.providerOptions;onValuesChanged:sessionForm.providerOptions=values }
    }
    CText { visible:sessionForm.isOllama;text:sessionForm.effectiveModel?.description||(sessionForm.capability.modelsStatus==="ready"?"No chat model selected. Choose a model above or pull one with Ollama and Refresh.":"Connect to Ollama in Settings → Connections.");color:Theme.muted;font.pixelSize:Theme.secondary }
    SectionLabel { text:"Access & storage";Accessible.role:Accessible.Heading;Layout.topMargin:Theme.space1 }
    CCheckBox { id:temporary;objectName:"temporarySession";visible:!sessionForm.imported.nativeId;text:"Temporary conversation";onClicked:if(checked)tools.checked=false }
    CText { visible:temporary.checked;text:"PAL keeps this text conversation in broker memory until you close it or the broker exits. Files, memory and PAL tools are unavailable. Native CLIs and external providers may retain their own histories.";color:Theme.amber;font.pixelSize:Theme.secondary }
    CCheckBox { id:tools;objectName:"sessionTools";visible:sessionForm.isConversation;text:"Enable desktop tools and delegation";enabled:!temporary.checked&&(checked||sessionForm.selectedToolsSupported) }
    CText { visible:sessionForm.isConversation;text:tools.checked?"Uses categories enabled in Settings → AI assistance. Delegated tasks ask for review unless CLI permission bypass is enabled.":"Web search and memory follow Settings. Desktop access stays off.";color:Theme.muted;font.pixelSize:Theme.secondary }
    // Workbench families are chosen separately: Files needs no CLI trust, delegation or computer control.
    ColumnLayout {
        visible:sessionForm.isConversation&&!sessionForm.projectSettings&&!temporary.checked;Layout.fillWidth:true;spacing:Theme.space1
        CText { text:"Workbench";color:Theme.muted;font.pixelSize:Theme.secondary }
        Flow {
            Layout.fillWidth:true;spacing:Theme.space3
            readonly property bool toolCapable:sessionForm.selectedToolsSupported
            CCheckBox { id:capFiles;objectName:"sessionFiles";width:implicitContentWidth + leftPadding + rightPadding;text:"Files";enabled:parent.toolCapable;Accessible.description:"Let the model read and propose changes in folders you choose" }
            CCheckBox { id:capImages;objectName:"sessionImages";width:implicitContentWidth + leftPadding + rightPadding;text:"Images";enabled:parent.toolCapable;Accessible.description:"Let the model create and edit images with a backend you set up" }
            CCheckBox { id:capAnalysis;objectName:"sessionAnalysis";width:implicitContentWidth + leftPadding + rightPadding;text:"Analysis";enabled:parent.toolCapable;Accessible.description:"Let the model run isolated Python in Code Lab" }
        }
        CText { visible:capFiles.checked;text:"After the conversation opens, choose the folders it may use in the Workbench, or use a private conversation workspace. Nothing outside them is visible, and every change is reviewed.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:!capFiles.enabled&&sessionForm.isConversation;text:"This model does not call tools, so the Workbench is yours to use by hand.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    }
    CCheckBox { id:trust;objectName:"sessionTrust";visible:(sessionForm.projectSettings||!App.state.settings?.bypassCliPermissions)&&(!sessionForm.isConversation||tools.checked);text:sessionForm.projectSettings?(sessionForm.isConversation?"Allow desktop tools for new sessions in this project":"Trust this project’s CLI configuration for new sessions"):sessionForm.isApi?"Allow this conversation to use the enabled desktop tool categories":"I trust this project’s CLI configuration and hooks" }
    CText { visible:sessionForm.projectSettings&&trust.visible;text:"Saved trust applies to this project’s new sessions. Tool approval settings still apply.";color:Theme.muted;font.pixelSize:Theme.caption }
    CText { visible:sessionForm.projectSettings;text:"Conversation style";color:Theme.muted;font.pixelSize:Theme.secondary }
    CComboBox { id:projectStyle;objectName:"projectStyle";visible:sessionForm.projectSettings;Layout.fillWidth:true;model:sessionForm.styleChoices;textRole:"label";Accessible.name:"Conversation style for this project" }
    CText { visible:sessionForm.projectSettings;text:"This project’s conversations use this style unless a conversation picks its own. Save styles in Settings › Personality.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { id:conventions;objectName:"projectConventions";visible:sessionForm.projectSettings;text:"Read AGENTS.md, CLAUDE.md and CONVENTIONS.md for Ollama and API conversations" }
    CText { visible:sessionForm.projectSettings&&conventions.checked;text:"Read fresh for every message, up to 8,000 characters, never through links. Codex and Claude Code read their own instruction files, so PAL does not add them there.";color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { id:handoff;visible:!!sessionForm.imported.nativeId;text:"I stopped the external session before handing it over" }
    CText { visible:!!sessionForm.imported.nativeId;text:"PAL continues the provider’s history. Close its terminal session before handing it over.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CCheckBox {
        id:saveDefaults;objectName:"saveDefaults";visible:sessionForm.general;text:"Save as my defaults"
        Accessible.description:"New conversations start with this provider, model, effort and mode"
    }
    CText { visible:saveDefaults.visible&&saveDefaults.checked;text:"Next time, a new conversation will use these settings. Titles, folders and trust stay your call; projects keep their own defaults.";color:Theme.muted;font.pixelSize:Theme.secondary }
    CText { objectName:"newSessionError";visible:sessionForm.error.length>0||sessionForm.modelError.length>0;text:sessionForm.error||sessionForm.modelError;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap }
    footerContent:Component { ColumnLayout {
        Layout.fillWidth:true;spacing:Theme.space2
        CText { objectName:"sessionOpenHint";visible:sessionForm.requestId<0&&!!sessionForm.openBlocker;Layout.fillWidth:true;text:sessionForm.openBlocker;color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Accessible.name:text }
        RowLayout {
            Layout.fillWidth:true;spacing:Theme.space2
            CButton { Layout.fillWidth:true;text:"Cancel";enabled:sessionForm.requestId<0;onClicked:sessionForm.close() }
            CButton {
                objectName:"sessionOpen";Layout.fillWidth:true;text:sessionForm.requestId>=0?"Saving…":sessionForm.projectSettings?"Save defaults":"Open session";primary:true;prominent:true
                enabled:sessionForm.requestId<0&&!sessionForm.openBlocker
                onClicked:{
                    const defaults={provider:sessionForm.providerName,trusted:trust.checked,temporary:temporary.visible&&temporary.checked,tools:sessionForm.isConversation&&tools.checked,model:sessionForm.isApi&&customModel.text.trim()?customModel.text.trim():modelName.currentValue||"",effort:reasoningEffort.currentValue||"",providerOptions:sessionForm.providerOptions}
                    sessionForm.error=""
                    sessionForm.pendingDefaults=sessionForm.general&&saveDefaults.checked?{provider:defaults.provider,model:defaults.model,effort:defaults.effort,tools:defaults.tools,temporary:defaults.temporary}:null
                    sessionForm.requestId=sessionForm.projectSettings?App.rpc("projects.save",{cwd:folder.text.trim(),name:sessionTitle.text.trim(),favorite:favorite.checked,expectedRevision:sessionForm.project.revision||"0",defaults:defaults}):App.rpc("session.create",Object.assign(defaults,sessionForm.connectionId?{connectionId:sessionForm.connectionId}:{},{cwd:folder.text.trim(),nativeId:sessionForm.imported.nativeId||"",handoffConfirmed:handoff.checked,title:sessionTitle.text.trim()||"Untitled session"},sessionForm.isConversation&&!(temporary.visible&&temporary.checked)?{capabilities:{files:capFiles.checked&&capFiles.enabled,images:capImages.checked&&capImages.enabled,analysis:capAnalysis.checked&&capAnalysis.enabled}}:{}))
                }
            }
        }
    } }
    Connections { target:App;function onResult(id,value){
        const requestedProvider=sessionForm.modelRequests[id]
        if(requestedProvider){const requests=Object.assign({},sessionForm.modelRequests);delete requests[id];sessionForm.modelRequests=requests;if(requestedProvider===sessionForm.providerName&&value?.error)sessionForm.modelError=value.error;return}
        // Defaults are saved once the conversation they describe has opened.
        if(id===sessionForm.stylesRequest){
            sessionForm.stylesRequest=-1
            sessionForm.styleChoices=[{id:"",label:"The personality in Settings"}].concat((value?.items||[]).map(item=>({id:item.id,label:item.label})))
            if(sessionForm.project.behaviorProfileId&&!sessionForm.styleChoices.some(item=>item.id===sessionForm.project.behaviorProfileId))sessionForm.styleChoices=sessionForm.styleChoices.concat([{id:sessionForm.project.behaviorProfileId,label:"A deleted style · falls back to Settings"}])
            projectStyle.currentIndex=Math.max(0,sessionForm.styleChoices.findIndex(item=>item.id===(sessionForm.project.behaviorProfileId||"")))
            return
        }
        if(id===sessionForm.requestId&&sessionForm.projectSettings&&!value?.error&&sessionForm.nextProjectStep(value))return
        if(id===sessionForm.requestId&&sessionForm.projectStage&&value?.error){sessionForm.requestId=-1;sessionForm.error="The defaults were saved, but not the "+sessionForm.projectStage+": "+value.error;sessionForm.projectStage="";return}
        if(id===sessionForm.requestId){sessionForm.requestId=-1;sessionForm.projectStage="";if(value?.error)sessionForm.error=value.error;else{if(sessionForm.pendingDefaults)App.rpc("settings.update",{conversationDefaults:sessionForm.pendingDefaults});sessionForm.pendingDefaults=null;sessionForm.imported={};sessionForm.close();if(sessionForm.projectSettings)sessionForm.projectSaved(value);else{App.selectedId=value.id;sessionForm.sessionOpened()}}}
    } }
}
