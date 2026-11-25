import QtQuick
import QtQuick.Layouts
ColumnLayout {
    id:knowledge
    Layout.fillWidth:true;spacing:Theme.space4
    property var memory:App.state.settings?.memory||({enabled:false,model:"nomic-embed-text"})
    property var status:App.state.memory||({})
    property var connections:[]
    RpcClient { id:connectionRpc }
    property int memoryRequest:-1
    property int extractionRequest:-1
    property int extractionRefreshRequest:-1
    property string extractionProvider:memory.extractionProvider||"ollama"
    property var extractionProviders:[{id:"ollama",label:"Ollama"},{id:"google",label:"Gemini API"},{id:"anthropic",label:"Claude API"}]
    property var extractionCapability:App.state.capabilities?.[extractionProvider]||({})
    property string selectedExtractionModel:memory.extractionModel||"glm-5.3-flash:cloud"
    function matchesExtraction(id) { return id===selectedExtractionModel||id===selectedExtractionModel+":cloud"||id===selectedExtractionModel+"-cloud" }
    property var extractionChoices: {
        const models=(extractionCapability.models||[]).filter(m=>extractionProvider!=="ollama"||m.cloud)
        return models.some(m=>matchesExtraction(m.id))?models:models.concat([{id:selectedExtractionModel,displayName:selectedExtractionModel+" · unavailable"}])
    }
    property int extractionIndex:extractionChoices.findIndex(m=>matchesExtraction(m.id))
    property int checkRequest:-1
    // M07: an optional Markdown notes folder; the folder stays the source of truth.
    property var vault:App.state.settings?.notesVault||({path:"",enabled:false,allowCloud:false,folders:[]})
    property int vaultRequest:-1
    property int vaultStatusRequest:-1
    property var vaultStatus:null
    property string vaultError:""
    property string vaultFeedback:""
    function updateVault(patch,done){vaultError="";vaultFeedback=done||"";vaultRequest=App.rpc("settings.update",{notesVault:patch})}
    function counted(count,one,many){return count+" "+(count===1?one:many)}
    function scanVault(){if(App.connected&&vault.enabled)vaultStatusRequest=App.rpc("notes.status",{})}
    Component.onCompleted:{scanVault();connectionRpc.call("connections.list",{},value=>{if(!value.error)knowledge.connections=value})}
    // M09: switching the embedding model is reviewed first: what has vectors in the new space and what will be re-embedded.
    property int impactRequest:-1
    property var impact:null
    property string impactError:""
    function saveEmbedding(){impact=null;impactError="";checkAfterSave=true;memoryError="";checkResult="";memoryRequest=App.rpc("settings.update",{memory:{model:embedding.value}})}
    function impactText(){
        if(!impact)return ""
        const next=impact.next||{},current=impact.current||{}
        if(impact.unchanged)return next.model+" uses the same embedding space as "+current.model+". Nothing needs re-embedding."
        return impact.artifacts+" stored memories. "+next.records+" already have vectors for "+next.model+" ("+next.dimension+" dimensions); "+impact.missing+" will be re-embedded in the background after switching. "
            +"Vectors from "+current.model+" are kept in their own space and never mixed with the new ones. Until a memory is re-embedded, recall finds it by keywords."
            +(current.error?" The current model could not be checked: "+current.error:"")
    }
    property bool checkAfterSave:false
    property string memoryError:""
    property string checkResult:""
    property var embeddingProviders:["ollama","openai","google","mistral","azure_openai","openrouter","litellm","compatible","perplexity","voyage","xai","edenai","huggingface"].map(id=>({id:id,label:id==="ollama"?"Ollama embeddings":id==="voyage"?"Voyage AI":((App.state.providerTraits||{})[id]?.label||id)+" embeddings"}))
    ResearchSearchSettings { Layout.fillWidth:true }
    CSection {
        title:"Memory"
        description:"Share project facts and earlier conversations across Codex, Claude and Ollama."
        CCheckBox { objectName:"memoryEnabled";text:"Remember and recall conversations";checked:knowledge.memory.enabled;enabled:knowledge.memoryRequest<0;onClicked:{knowledge.checkAfterSave=false;knowledge.memoryError="";knowledge.memoryRequest=App.rpc("settings.update",{memory:{enabled:checked}})} }
        ColumnLayout {
            visible:knowledge.memory.enabled;Layout.fillWidth:true;spacing:Theme.space2
            CComboBox {
                id:embeddingProvider;objectName:"memoryEmbeddingProvider";Layout.fillWidth:true;model:knowledge.embeddingProviders;textRole:"label";valueRole:"id"
                Accessible.name:"Memory embedding provider";currentIndex:Math.max(0,knowledge.embeddingProviders.findIndex(row=>row.id===(knowledge.memory.embeddingProvider||"ollama")));enabled:knowledge.memoryRequest<0
                onActivated:{knowledge.impact=null;knowledge.checkResult="";knowledge.memoryError="";knowledge.memoryRequest=App.rpc("settings.update",{memory:{embeddingProvider:currentValue,embeddingConnectionId:"",model:currentValue==="google"?"gemini-embedding-001":currentValue==="ollama"?"nomic-embed-text":""}})}
            }
            CComboBox {
                visible:knowledge.connections.some(row=>row.kind===embeddingProvider.currentValue);Layout.fillWidth:true
                readonly property var choices:[{id:"",name:"Default account"}].concat(knowledge.connections.filter(row=>row.kind===embeddingProvider.currentValue))
                model:choices;textRole:"name";valueRole:"id";currentIndex:Math.max(0,choices.findIndex(row=>row.id===(knowledge.memory.embeddingConnectionId||"")));Accessible.name:"Embedding account"
                onActivated:knowledge.memoryRequest=App.rpc("settings.update",{memory:{embeddingConnectionId:currentValue}})
            }
            CCheckBox { objectName:"cloudEmbeddingEnabled";visible:embeddingProvider.currentValue!=="ollama";text:"Allow this provider to embed eligible memory and search queries";checked:knowledge.memory.allowCloudEmbedding===true;onClicked:knowledge.memoryRequest=App.rpc("settings.update",{memory:{allowCloudEmbedding:checked}}) }
            CField { visible:embeddingProvider.currentValue!=="ollama";Layout.fillWidth:true;placeholderText:"Dimensions (provider default)";saved:knowledge.memory.embeddingDimensions?String(knowledge.memory.embeddingDimensions):"";validator:IntValidator{bottom:1} Accessible.name:"Embedding dimensions";onEditingFinished:knowledge.memoryRequest=App.rpc("settings.update",{memory:{embeddingDimensions:text.trim()?Number(text):0}}) }
            CComboBox { visible:embeddingProvider.currentValue==="huggingface";Layout.fillWidth:true;model:[{id:"mean",label:"Mean pooling"},{id:"cls",label:"CLS token pooling"}];textRole:"label";valueRole:"id";currentIndex:Math.max(0,model.findIndex(row=>row.id===(knowledge.memory.embeddingPooling||"mean")));Accessible.name:"Hugging Face embedding pooling";onActivated:knowledge.memoryRequest=App.rpc("settings.update",{memory:{embeddingPooling:currentValue}}) }
            CText { text:"Embedding model";color:Theme.muted;font.pixelSize:Theme.secondary }
            RowLayout {
                Layout.fillWidth:true
                ModelPicker { id:embedding;name:"embeddingModel";Layout.fillWidth:true;provider:knowledge.memory.embeddingProvider||"ollama";connectionId:knowledge.memory.embeddingConnectionId||"";operation:"embed";saved:knowledge.memory.model||"";label:"Memory embedding model";emptyText:"Choose an embedding model";placeholder:"Embedding model ID" }
                CButton {
                    objectName:"memoryCheck";Layout.alignment:Qt.AlignTop;text:knowledge.checkRequest>=0||knowledge.impactRequest>=0?"Checking…":"Check & save";enabled:knowledge.memoryRequest<0&&knowledge.checkRequest<0&&knowledge.impactRequest<0&&embedding.value.length>0
                    onClicked:{
                        if(embedding.value===knowledge.memory.model){knowledge.saveEmbedding();return}
                        knowledge.impact=null;knowledge.impactError="";knowledge.checkResult="";knowledge.impactRequest=App.rpc("memory.embeddingImpact",{model:embedding.value})
                    }
                }
            }
            ColumnLayout {
                objectName:"embeddingImpact";visible:!!knowledge.impact||!!knowledge.impactError;Layout.fillWidth:true;spacing:Theme.space2
                CText { objectName:"embeddingImpactText";Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary;color:knowledge.impactError?Theme.danger:Theme.text;text:knowledge.impactError?"Could not check "+embedding.value+": "+knowledge.impactError:knowledge.impactText() }
                RowLayout {
                    Layout.fillWidth:true
                    CButton { objectName:"embeddingSwitch";Layout.fillWidth:true;primary:!knowledge.impactError;text:knowledge.impactError?"Save anyway":"Switch to "+embedding.value;enabled:knowledge.memoryRequest<0;onClicked:knowledge.saveEmbedding() }
                    CButton { objectName:"embeddingKeep";Layout.fillWidth:true;text:"Keep "+knowledge.memory.model;onClicked:{embedding.set(knowledge.memory.model);knowledge.impact=null;knowledge.impactError=""} }
                }
            }
            CText { text:embeddingProvider.currentValue==="ollama"?"Default: nomic-embed-text. Install it with ollama pull nomic-embed-text. The saved Ollama server is used for memory.":"Uses the selected provider account in Connections. Eligible memories and search queries leave this computer; local-only sources keep keyword recall. Switching provider, model or dimensions rebuilds a separate vector space.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
            CText { text:"Retrieval reranking (optional)";color:Theme.muted;font.pixelSize:Theme.secondary }
            RowLayout {
                Layout.fillWidth:true
                ModelPicker { id:voyageRerank;name:"voyageRerank";Layout.fillWidth:true;provider:"voyage";operation:"rerank";saved:knowledge.memory.voyageRerankModel||"";emptyText:"No reranking";label:"Voyage rerank model";maximumLength:128 }
                CButton { text:"Save";Layout.alignment:Qt.AlignTop;onClicked:knowledge.memoryRequest=App.rpc("settings.update",{memory:{voyageRerankModel:voyageRerank.value}}) }
            }
            CComboBox {
                objectName:"memoryExtractionProvider";Layout.fillWidth:true;model:knowledge.extractionProviders;textRole:"label";valueRole:"id"
                Accessible.name:"Memory extraction provider";currentIndex:knowledge.extractionProviders.findIndex(p=>p.id===knowledge.extractionProvider)
                enabled:knowledge.extractionRequest<0
                onActivated:{knowledge.memoryError="";knowledge.extractionRequest=App.rpc("settings.update",{memory:{extractionProvider:currentValue,extractionConnectionId:"",extractionModel:currentValue==="ollama"?"glm-5.3-flash:cloud":currentValue==="google"?"gemini-2.5-flash":"claude-haiku-4-5"}})}
            }
            CComboBox {
                objectName:"extractionAccount";visible:knowledge.extractionProvider!=="ollama"&&knowledge.connections.some(row=>row.kind===knowledge.extractionProvider);Layout.fillWidth:true
                readonly property var choices:[{id:"",name:"Default account"}].concat(knowledge.connections.filter(row=>row.kind===knowledge.extractionProvider))
                model:choices;textRole:"name";valueRole:"id";currentIndex:Math.max(0,choices.findIndex(row=>row.id===(knowledge.memory.extractionConnectionId||"")));Accessible.name:"Graph extraction account"
                onActivated:knowledge.extractionRequest=App.rpc("settings.update",{memory:{extractionConnectionId:currentValue}})
            }
            CText { text:"Graph extraction model";color:Theme.muted;font.pixelSize:Theme.secondary }
            RowLayout {
                Layout.fillWidth:true
                CComboBox {
                    id:extraction;objectName:"extractionModel";Layout.fillWidth:true;Layout.minimumWidth:0
                    model:knowledge.extractionChoices;textRole:"displayName";valueRole:"id";Accessible.name:"Memory extraction model"
                    enabled:App.connected&&knowledge.extractionRequest<0&&knowledge.extractionCapability.modelsStatus==="ready"
                    currentIndex:knowledge.extractionIndex
                    onActivated:{knowledge.memoryError="";knowledge.extractionRequest=App.rpc("settings.update",{memory:{extractionModel:currentValue}})}
                }
                CButton { objectName:"extractionModelsRefresh";text:"Refresh";enabled:App.connected&&knowledge.extractionRefreshRequest<0&&knowledge.extractionCapability.modelsStatus!=="loading";onClicked:{knowledge.memoryError="";knowledge.extractionRefreshRequest=App.rpc("provider.models",{provider:knowledge.extractionProvider})} }
            }
            CText { text:"Extraction runs in the background using the selected provider. API keys are managed in Connections. Source restrictions apply before sending text. Claims retain exact evidence and correction history. To use another saved account or provider, choose it for Extraction under Memory review.";color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { visible:knowledge.extractionCapability.modelsStatus==="loading";text:"Loading extraction models…";color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { visible:!!knowledge.extractionCapability.modelsError;text:knowledge.extractionCapability.modelsError||"";color:Theme.danger;font.pixelSize:Theme.secondary }
            CText { visible:knowledge.extractionCapability.modelsStatus==="ready"&&!(knowledge.extractionCapability.models||[]).length;text:"No models are available. Configure this provider in Connections, then Refresh.";color:Theme.amber;font.pixelSize:Theme.secondary }
            CCheckBox { objectName:"cloudExtractionEnabled";text:"Allow cloud memory extraction";checked:knowledge.memory.allowCloudExtraction===undefined?true:knowledge.memory.allowCloudExtraction;onClicked:knowledge.memoryRequest=App.rpc("settings.update",{memory:{allowCloudExtraction:checked}}) }
            CCheckBox { objectName:"cloudMemoryEnabled";text:"Share recalled memory with Codex, Claude and cloud models";checked:knowledge.memory.allowCloudMemory||false;onClicked:knowledge.memoryRequest=App.rpc("settings.update",{memory:{allowCloudMemory:checked}}) }
            CText { text:(knowledge.status.saved||0)+" saved facts · "+Math.max(0,(knowledge.status.total||0)-(knowledge.status.saved||0))+" conversation passages"+((knowledge.status.pending||0)?" · "+knowledge.status.pending+" awaiting embedding":"");color:Theme.muted;font.pixelSize:Theme.secondary }
            CText { visible:!!knowledge.checkResult;text:knowledge.checkResult;color:Theme.accentText;font.pixelSize:Theme.secondary }
            CText { visible:knowledge.status.state==="degraded";text:knowledge.status.error||"Semantic memory is unavailable. Keyword recall is still available.";color:Theme.amber;font.pixelSize:Theme.secondary }
        }
        CText { visible:!!knowledge.memoryError;text:knowledge.memoryError;color:Theme.danger;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"showMemoryCitations";text:"Show memory citations in replies";checked:App.state.settings?.showMemoryCitations===true;onClicked:App.rpc("settings.update",{showMemoryCitations:checked}) }
        CText { text:"Replies that draw on memory cite it as [evidence:…]. Off keeps those markers out of the conversation and out of copies, quotes and speech. Saved replies keep them, and PAL still records what each reply cited.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CButton { objectName:"manageMemories";text:"Manage project memory";enabled:App.connected&&!!App.session.id&&!App.session.temporary;onClicked:manager.open() }
        CText { text:App.session.id?"Review, correct or forget shared facts and conversation passages. Memory stays separate for each project and server.":"Select a conversation to manage its project’s memory.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Structured evaluation"
        id:jevSection;objectName:"jevSection"
        description:"Jev can check structured outputs as an independent service. Add its key in Connections, then choose a model. Without a model it stays off."
        property string problem:""
        property string saved:""
        function save(value){problem="";saved="";jevRpc.call("settings.update",{workbench:{jevModel:value}},result=>{if(result.error)jevSection.problem=String(result.error.message||result.error);else jevSection.saved=value?"Jev uses "+value+".":"Jev is off."})}
        RpcClient { id:jevRpc }
        RowLayout {
            Layout.fillWidth:true
            ModelPicker { id:jevModel;name:"jevModel";Layout.fillWidth:true;provider:"jev";operation:"evaluate";saved:App.state.settings?.workbench?.jevModel||"";emptyText:"Jev is off";label:"Jev evaluation model";onAccepted:jevSection.save(value) }
            CButton { objectName:"jevSave";text:"Save";Layout.alignment:Qt.AlignTop;enabled:App.connected&&!jevRpc.busy;onClicked:jevSection.save(jevModel.value) }
        }
        CText { visible:!!jevSection.problem;text:jevSection.problem;color:Theme.danger;font.pixelSize:Theme.secondary;Accessible.role:Accessible.AlertMessage }
        CText { visible:!!jevSection.saved;text:jevSection.saved;color:Theme.accentText;font.pixelSize:Theme.secondary }
    }
    MemoryCurationSettings { Layout.fillWidth:true }
    CSection {
        title:"Documents and notes"
        description:"Ground answers in your own files. Everything is read on this computer, and answers name the file they used."
        CButton { objectName:"manageCollections";text:"Document collections…";enabled:App.connected;onClicked:collections.openFor(App.session.id&&!App.session.temporary?App.session.id:"") }
        CText { text:"Index folders of text and Markdown files, then use a collection in one conversation, a project or everywhere.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CCheckBox { objectName:"notesVaultEnabled";text:"Use a Markdown notes folder";checked:knowledge.vault.enabled;enabled:knowledge.vaultRequest<0&&!!knowledge.vault.path;onClicked:knowledge.updateVault({enabled:checked},checked?"Notes are available to conversations.":"Notes are no longer available to conversations.") }
        RowLayout {
            Layout.fillWidth:true
            CText { objectName:"notesVaultPath";Layout.fillWidth:true;elide:Text.ElideMiddle;text:knowledge.vault.path||"No folder chosen";color:knowledge.vault.path?Theme.text:Theme.muted;font.pixelSize:Theme.secondary }
            CButton { objectName:"notesVaultChoose";text:knowledge.vault.path?"Change folder…":"Choose folder…";enabled:knowledge.vaultRequest<0;onClicked:{const path=App.chooseFolder();if(path)knowledge.updateVault({path:path,enabled:true},"Notes folder set.")} }
        }
        CCheckBox { objectName:"notesVaultCloud";visible:!!knowledge.vault.path;text:"Codex, Claude and cloud models may search and read notes";checked:knowledge.vault.allowCloud;enabled:knowledge.vaultRequest<0;onClicked:knowledge.updateVault({allowCloud:checked}) }
        NotesVaultScope { visible:!!knowledge.vault.path;Layout.fillWidth:true;vault:knowledge.vault;busy:knowledge.vaultRequest>=0;onChosen:folders=>knowledge.updateVault({folders:folders},folders.length?"Only these folders are used.":"The whole notes folder is used.");onRefused:reason=>{knowledge.vaultFeedback="";knowledge.vaultError=reason} }
        CText { objectName:"notesVaultProblem";visible:knowledge.vault.enabled&&!!knowledge.vaultStatus&&(!!knowledge.vaultStatus.problem||(knowledge.vaultStatus.missing||[]).length>0);color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true
            text:knowledge.vaultStatus?(knowledge.vaultStatus.problem||"Not in the notes folder: "+(knowledge.vaultStatus.missing||[]).join(", ")):"" }
        CText { objectName:"notesVaultStatus";visible:knowledge.vault.enabled&&!!knowledge.vaultStatus&&!knowledge.vaultStatus.problem;color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true
            text:knowledge.vaultStatus?knowledge.counted(knowledge.vaultStatus.notes,"readable note","readable notes")+" · "+knowledge.counted(knowledge.vaultStatus.private,"private note","private notes")+" skipped"+(knowledge.vaultStatus.ignored?" · "+knowledge.vaultStatus.ignored+" left out by .palignore":"")+(knowledge.vaultStatus.unreadable?" · "+knowledge.counted(knowledge.vaultStatus.unreadable,"note","notes")+" skipped because the front matter could not be read":""):"" }
        CText { text:"Notes marked private: true, or whose privacy settings PAL cannot read, are never searched. Hidden folders and linked files are skipped. A model can only propose an edit: you review the exact change, it is refused if the note changed meanwhile, and the previous text is kept as a private backup.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout {
            visible:!!knowledge.vault.path;Layout.fillWidth:true
            CButton { text:"Recount notes";enabled:knowledge.vault.enabled&&knowledge.vaultStatusRequest<0;onClicked:knowledge.scanVault() }
            CButton { objectName:"notesVaultClearBackups";text:"Delete edit backups";enabled:knowledge.vaultRequest<0;onClicked:{knowledge.vaultError="";knowledge.vaultFeedback="Deleted the backups of earlier note edits.";knowledge.vaultRequest=App.rpc("notes.clearBackups",{})} }
        }
        CText { visible:!!knowledge.vaultError;text:knowledge.vaultError;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:!!knowledge.vaultFeedback;text:knowledge.vaultFeedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    }
    MemoryDialog { id:manager }
    KnowledgeCollections { id:collections }
    Connections { target:App;function onResult(id,value){
        if(id===knowledge.memoryRequest){knowledge.memoryRequest=-1;if(value?.error)knowledge.memoryError=value.error;else if(knowledge.checkAfterSave)knowledge.checkRequest=App.rpc("memory.check",{});knowledge.checkAfterSave=false}
        else if(id===knowledge.extractionRequest){knowledge.extractionRequest=-1;if(value?.error)knowledge.memoryError=value.error;extraction.currentIndex=Qt.binding(()=>knowledge.extractionIndex)}
        else if(id===knowledge.extractionRefreshRequest){knowledge.extractionRefreshRequest=-1;if(value?.error)knowledge.memoryError=value.error}
        else if(id===knowledge.checkRequest){knowledge.checkRequest=-1;if(value?.error)knowledge.memoryError=value.error;else knowledge.checkResult="Ready · "+value.model}
        else if(id===knowledge.impactRequest){knowledge.impactRequest=-1;if(value?.error)knowledge.impactError=String(value.error);else knowledge.impact=value}
        else if(id===knowledge.vaultRequest){knowledge.vaultRequest=-1;if(value?.error){knowledge.vaultError=String(value.error);knowledge.vaultFeedback=""}else if(value?.notesVault?.enabled)knowledge.vaultStatusRequest=App.rpc("notes.status",{});else if(value?.notesVault)knowledge.vaultStatus=null}
        else if(id===knowledge.vaultStatusRequest){knowledge.vaultStatusRequest=-1;if(value?.error)knowledge.vaultError=String(value.error);else knowledge.vaultStatus=value}
    } }
}
