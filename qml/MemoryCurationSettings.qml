import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CSection {
    id: root
    title: "Memory review"
    description: "Review project memories with a model of your choice. Conversation capture and explicit saves have separate controls."
    property var profile: ({})
    property int revision: -1
    property var routes: []
    property var bindings: ({})
    property var policy: ({})
    readonly property string sessionId: App.session && !App.session.temporary ? (App.session.id || "") : ""
    property var policyPreview: null
    property var policyChange: null
    onSessionIdChanged: {policyPreview=null;policyChange=null;if(sessionId&&App.connected)Qt.callLater(loadChange)}
    function loadChange(){
        const selected=sessionId
        if(selected&&App.connected)rpc.call("memory.graph",{sessionId:selected,method:"retention_policy_status"},r=>{if(selected===sessionId&&!r.error)policyChange=r.change})
    }
    function scopeCall(method,params,done){
        const selected=sessionId
        send("memory.graph",{sessionId:selected,method:method,params:params},r=>{if(selected===sessionId)done(r)})
    }
    function recordChange(r){
        policyPreview=null
        policyChange=r
        feedback=r.changed+" existing deadlines updated."+(r.backup?" Backup saved to "+r.backup:"")
        if(r.policy_epoch!==undefined)policyEpoch=r.policy_epoch
    }
    property int policyEpoch: -1
    property bool busy: false
    property bool advanced: false
    property string feedback: ""
    property string fingerprint: ""
    property var catalog: []
    property string catalogRef: ""
    property int catalogRequest: 0
    property bool catalogLoading: false
    property string catalogMessage: ""
    readonly property string connectionRef: routes[route.currentIndex]?.ref || ""
    // null selects manual entry. An empty string leaves the task binding unset.
    property var selectedId: ""
    readonly property string modelId: selectedId === null ? customModel.text.trim() : selectedId
    readonly property var modelChoices: {
        const choices = [{id:"", displayName:task === "review" ? "Choose a model" : "Use the default model"}].concat(catalog)
        const saved = bindings[task]
        for (const id of [saved?.connectionRef === connectionRef ? saved.modelId : "", selectedId]) {
            if (id && !choices.some(choice => choice.id === id))
                choices.push({id:id, displayName:id})
        }
        choices.push({id:null, displayName:"Enter a model ID…"})
        return choices
    }
    readonly property var tasks: ["review", "extract", "adjudicate", "consolidate", "rerank"]
    readonly property string task: tasks[overrideTask.currentIndex] || "review"
    RpcClient { id: rpc }
    function send(method, params, done) {
        busy = true
        feedback = ""
        rpc.call(method, params, result => {
            busy = false
            if (result.error) { feedback = String(result.error.message || result.error); return }
            done(result)
        })
    }
    function setFields() {
        const b = bindings[task] || {}
        const ref = b.connectionRef || bindings.review?.connectionRef || "default:ollama"
        route.currentIndex = routes.findIndex(r => r.ref === ref)
        selectedId = b.modelId || ""
        customModel.text = ""
        fallbacks.text = b.fallbackBindings?.length ? JSON.stringify(b.fallbackBindings) : ""
        fingerprint = ""
        refreshModels()
    }
    function refreshModels(force = false) {
        const ref = connectionRef
        if (!force && catalogRef === ref) return
        const request = ++catalogRequest
        catalog = []
        catalogMessage = ""
        catalogLoading = visible && online && revision >= 0 && !!ref
        catalogRef = catalogLoading ? ref : ""
        if (!catalogLoading) return
        const named = ref.startsWith("connection:")
        rpc.call(named ? "connections.models" : "provider.models",
                 named ? {id:ref.slice(11)} : {provider:ref === "default:ollama" ? "ollama" : ref.slice(7)}, result => {
            if (request !== catalogRequest) return
            catalogLoading = false
            if (result.error) {
                catalogMessage = "Couldn’t load models. " + (result.error.message || result.error)
                return
            }
            catalog = named ? result.models : result
            if (!catalog.length) catalogMessage = "This connection didn’t list any models. You can enter a model ID."
        })
    }
    function loadConnections() {
        if (!online || !visible) return
        rpc.call("connections.list", {}, rows => {
            if (rows.error) { feedback = String(rows.error); return }
            const previous = connectionRef
            routes = [{ref:"default:ollama",label:"Default Ollama server",destination:"Determined from saved host and model"}].concat(rows.map(r => ({ref:"connection:"+r.id, label:r.name, destination:r.task?.processing || r.endpoint?.processing || (r.host && /localhost|127\.0\.0\.1/.test(r.host) ? "local" : "unknown")})))
                .concat((App.state.providerOrder||[]).filter(k=>App.state.providerTraits?.[k]?.kind==="api"&&k!=="compatible"&&(["openai","anthropic","google"].includes(k)||App.state.capabilities?.[k]?.available)).map(k=>({ref:"native:"+k,label:App.state.providerTraits[k].label||k,destination:"cloud"})))
            const index = routes.findIndex(r => r.ref === previous)
            if (index >= 0 && revision >= 0) {
                route.currentIndex = index
                refreshModels(true)
            } else if (revision >= 0) setFields()
        })
    }
    function load() {
        if (!online) return
        Qt.callLater(loadConnections)
        loadChange()
        rpc.call("memory.curation.settings", {}, result => {
            if (result.error) { feedback = String(result.error); return }
            applySettings(result)
        })
        rpc.call("memory.graph", {method:"policy_get"}, result => {
            if (!result.policy) return
            policy = result.policy
            policyEpoch = result.epoch
            rawDays.value = policy.raw_turn_days
            candidateDays.value = policy.candidate_days
            acceptedEvidence.checked = policy.retain_evidence
        })
    }
    function applySettings(result) {
        profile = result.profile
        revision = result.revision
        bindings = Object.assign({}, profile.overrides, {review:profile.reviewModel})
        mode.currentIndex = ["off","preview","assisted","automatic"].indexOf(profile.mode)
        cloud.checked = profile.allowCloudCuration
        preserve.checked = profile.retainCurationEvidence
        grace.checked = profile.reviewGrace
        autoAccept.checked = profile.autoAccept
        experimental.checked = !!profile.unmeasuredFingerprint
        prior.checked = profile.valuePrior
        ranking.checked = profile.rerank
        summaries.checked = profile.consolidation
        setFields()
    }
    function draftBinding() {
        if (!modelId) return null
        if (route.currentIndex < 0) return null
        let chain
        try {chain=JSON.parse(fallbacks.text.trim() || "[]")} catch(e) {return null}
        if(!Array.isArray(chain))return null
        return Object.assign({},bindings[task]||{}, {connectionRef:connectionRef, modelId:modelId,fallbackBindings:chain})
    }
    function save() {
        const b = draftBinding()
        if (selectedId === null && !modelId) { feedback = "Enter a model ID."; return }
        if (modelId && !b) { feedback = "Check the model connection and fallback bindings."; return }
        const overrides = Object.assign({},bindings)
        delete overrides.review
        if (task !== "review") { if (b) overrides[task] = b; else delete overrides[task] }
        const patch = {mode:["off","preview","assisted","automatic"][mode.currentIndex],reviewModel:task==="review"?b:bindings.review,
            overrides:overrides,allowCloudCuration:cloud.checked,retainCurationEvidence:preserve.checked,reviewGrace:grace.checked,
            autoAccept:autoAccept.checked,unmeasuredFingerprint:experimental.checked?(fingerprint||profile.unmeasuredFingerprint):"",
            valuePrior:prior.checked,rerank:ranking.checked,consolidation:summaries.checked}
        if(!threshold.acceptableInput){feedback="Enter a preservation threshold between 0 and 1.";return}
        patch.threshold=Number(threshold.text)
        patch.acceptCategories=[]
        for(let i=0;i<categories.count;i++)if(categories.itemAt(i).checked)patch.acceptCategories.push(categories.itemAt(i).modelData)
        for (let i=0;i<limits.count;i++) {
            const row=limits.itemAt(i)
            if (!row.editor.acceptableInput) { feedback="Enter a valid "+row.modelData.label.toLowerCase()+"."; return }
            patch[row.modelData.key]=row.editor.text===""?null:Number(row.editor.text)
        }
        send("memory.curation.configure",{expected_revision:revision,profile:patch},r=>{applySettings(r);feedback="Memory review settings saved."})
    }
    Component.onCompleted: Qt.callLater(load)
    readonly property bool online: App.connected
    onOnlineChanged: {
        if (online) Qt.callLater(load)
        else { revision = -1; refreshModels(true) }
    }
    onVisibleChanged: if (visible) Qt.callLater(loadConnections)
    ColumnLayout {
        Layout.fillWidth: true
        enabled: root.revision>=0 && !root.busy
        CComboBox { id:mode; objectName:"memoryCurationMode"; Layout.fillWidth:true; model:["Off","Preview recommendations","Assisted review","Automatic"]; Accessible.name:"Memory curation mode" }
        CText { Layout.fillWidth:true; wrapMode:Text.Wrap; color:Theme.muted; text:["Existing capture and retention continue.","The model assesses memories and records recommendations. Assisted review is a good starting point when you are ready to apply them.","Review each recommendation before applying it. Review grace can protect evidence while you decide.","PAL can preserve useful claims. Automatic acceptance requires separate authorization."][mode.currentIndex]||"" }
        CComboBox { id:overrideTask; visible:root.advanced; Layout.fillWidth:true; model:["Memory review model","Extraction override","Adjudication override","Episode summary override","Reranking override"]; Accessible.name:"Memory task"; onActivated:root.setFields() }
        CComboBox {
            id:route; objectName:"memoryReviewConnection"; Layout.fillWidth:true
            model:root.routes; textRole:"label"; valueRole:"ref"; displayText:currentIndex<0?"Choose a connection":currentText
            Accessible.name:"Memory model connection"
            onActivated: {
                if (currentValue === root.catalogRef) return
                const saved = root.bindings[root.task]
                root.selectedId = saved?.connectionRef === currentValue ? saved.modelId : ""
                customModel.text = ""
                root.fingerprint = ""
                root.refreshModels()
            }
        }
        CText { visible:route.currentIndex>=0; color:Theme.muted; text:"Processing destination · "+(root.routes[route.currentIndex]?.destination||"unknown") }
        CComboBox {
            objectName:"memoryReviewModel"; Layout.fillWidth:true
            enabled:!!root.connectionRef; Accessible.name:"Memory model"
            model:root.modelChoices; textRole:"displayName"; valueRole:"id"
            currentIndex:root.modelChoices.findIndex(choice => choice.id === root.selectedId)
            onActivated: index => {
                root.selectedId = root.modelChoices[index].id
                root.fingerprint = ""
                if (root.selectedId === null) customModel.forceActiveFocus()
            }
        }
        CField {
            id:customModel; objectName:"memoryReviewCustomModel"; visible:root.selectedId === null; Layout.fillWidth:true
            placeholderText:"Model ID"; Accessible.name:"Custom memory model ID"; maximumLength:512
            onTextEdited:root.fingerprint=""
        }
        CText {
            Layout.fillWidth:true; wrapMode:Text.Wrap; color:Theme.muted
            text:root.catalogLoading ? "Loading models…" : root.catalogMessage; visible:!!text
        }
        CField { id:fallbacks; visible:root.advanced;Layout.fillWidth:true;placeholderText:"Ordered fallback bindings (optional JSON array)";Accessible.name:"Ordered fallback model bindings"; onTextEdited:root.fingerprint="" }
        Flow {
            Layout.fillWidth:true; spacing:Theme.space2
            CButton { objectName:"refreshMemoryReviewModels"; text:"Refresh models"; enabled:!!root.connectionRef && !root.catalogLoading; onClicked:root.refreshModels(true) }
            CButton { text:"Test model"; enabled:!!root.draftBinding(); onClicked:root.send("memory.models.probe",{binding:root.draftBinding()},r=>{
                root.fingerprint=r.route.fingerprint;root.feedback="Validated structured output, abstention and evidence IDs using "+r.model+". Factual precision is unmeasured."
            }) }
        }
        CCheckBox { id:cloud; text:"Allow cloud models to review cloud-eligible memory" }
        CCheckBox { id:preserve; text:"Allow review to retain supporting excerpts" }
        CCheckBox { id:grace; text:"Protect expiring candidates while waiting for review"; enabled:preserve.checked }
        CButton { text:root.advanced?"Hide advanced settings":"Advanced settings"; quiet:true; onClicked:{root.advanced=!root.advanced;if(!root.advanced){overrideTask.currentIndex=0;root.setFields()}} }
        ColumnLayout {
            Layout.fillWidth:true; visible:root.advanced
            CCheckBox { id:autoAccept; text:"Automatically accept supported claims on qualified routes" }
            CText { text:"Categories eligible for automatic acceptance";visible:autoAccept.checked }
            Flow { Layout.fillWidth:true;visible:autoAccept.checked;spacing:Theme.space2
                Repeater { id:categories;model:["assertion","preference","decision","constraint","goal","relationship","biographical","project_convention","episode"]
                    CCheckBox { required property string modelData;text:modelData.replace(/_/g," ");checked:(root.profile.acceptCategories||[]).includes(modelData) }
                }
            }
            RowLayout { CText {Layout.fillWidth:true;text:"Minimum assessed value for protection"} CField {id:threshold;Layout.preferredWidth:Theme.fieldShort;Accessible.name:"Preservation threshold";text:String(root.profile.threshold??0.65);validator:RegularExpressionValidator {regularExpression:/0(\.[0-9]+)?|1(\.0+)?/} } }
            CCheckBox { id:experimental; text:"Allow experimental acceptance on this tested, unmeasured route"; enabled:autoAccept.checked&&(!!root.fingerprint||!!root.profile.unmeasuredFingerprint) }
            CCheckBox { id:prior; text:"Use assessed value as a small recall preference" }
            CCheckBox { id:ranking; text:"Rerank eligible search results" }
            CCheckBox { id:summaries; text:"Create attributed episode summaries" }
            Repeater {
                id:limits
                model:[{key:"atRiskHours",label:"Expiring soon (hours)"},{key:"graceDays",label:"Review grace (days)"},{key:"preserveDays",label:"Automatic protection (days)"},{key:"maxUnresolvedDays",label:"Maximum extension (days)"},{key:"maxProtectedRecords",label:"Protected records"},{key:"maxProtectedBytes",label:"Protected evidence (bytes)"},{key:"dailyRequests",label:"Requests per day"},{key:"dailyInput",label:"Daily input tokens"},{key:"dailyOutput",label:"Daily output tokens"},{key:"inputLimit",label:"Input tokens per request"},{key:"outputLimit",label:"Output tokens per request"},{key:"dailyCostMicros",label:"Daily cost limit (millionths of a currency unit)"},{key:"inputMicrosPerMillion",label:"Input price per million tokens (millionths)"},{key:"outputMicrosPerMillion",label:"Output price per million tokens (millionths)"},{key:"rerankMs",label:"Reranking deadline (ms)"},{key:"deepRecallMs",label:"Deep recall deadline (ms)"},{key:"timeoutMs",label:"Review request deadline (ms)"}]
                RowLayout {
                    required property var modelData
                    property alias editor:limitField
                    Layout.fillWidth:true
                    CText { Layout.fillWidth:true; wrapMode:Text.Wrap; text:modelData.label; color:Theme.muted }
                    CField { id:limitField; Layout.preferredWidth:Theme.fieldShort; text:String(root.profile[modelData.key]??""); Accessible.name:modelData.label; validator:RegularExpressionValidator {regularExpression:/[0-9]{0,10}/} }
                }
            }
        }
        CButton { objectName:"saveMemoryCuration";text:"Save review settings"; primary:true; onClicked:root.save() }
    }
    ColumnLayout {
        visible:root.advanced; Layout.fillWidth:true; enabled:root.policyEpoch>=0&&!root.busy
        CText { text:"Retention for future memories";font.bold:true }
        RowLayout { CText {text:"Raw passage days"} SpinBox { id:rawDays; onValueChanged:root.policyPreview=null; from:1;to:3650;editable:true;Accessible.name:"Raw passage retention days" } }
        RowLayout { CText {text:"Candidate days"} SpinBox { id:candidateDays; onValueChanged:root.policyPreview=null; from:1;to:365;editable:true;Accessible.name:"Candidate retention days" } }
        CCheckBox { id:acceptedEvidence; text:"Retain supporting evidence for accepted facts" }
        CButton { text:"Save retention policy"; onClicked:root.send("memory.graph",{method:"policy_update",params:{expected_epoch:root.policyEpoch,policy:{raw_turn_days:rawDays.value,candidate_days:candidateDays.value,retain_evidence:acceptedEvidence.checked}}},r=>{root.policyEpoch=r.epoch;root.feedback="Policy saved. New durations apply to future records."}) }
        CButton { text:"Preview changes to existing project memory"; enabled:!!root.sessionId; onClicked:root.scopeCall("retention_policy_preview",{raw_turn_days:rawDays.value,candidate_days:candidateDays.value,apply_to_existing:true,limit:25},r=>root.policyPreview=r) }
        ColumnLayout {
            visible:!!root.policyPreview;Layout.fillWidth:true
            CText { Layout.fillWidth:true;wrapMode:Text.Wrap;text:root.policyPreview ? (root.policyPreview.counts.changed+" baseline deadlines would change. "+root.policyPreview.counts.additional_retention+" would extend and "+root.policyPreview.counts.newly_eligible_deletion+" would become immediately due. Active protections can extend effective expiry."):"" }
            CField { id:policyBackup;Layout.fillWidth:true;placeholderText:"New backup file path";Accessible.name:"Policy change backup path" }
            CButton { text:"Back up and apply to existing records";enabled:!!root.policyPreview&&!!policyBackup.text.trim();onClicked:root.scopeCall("retention_policy_apply",{selection:root.policyPreview.selection,expected_revision:root.policyPreview.revision,output:policyBackup.text.trim()},root.recordChange) }
        }
        CButton { visible:!!root.policyChange&&!root.policyChange.complete&&!root.policyChange.undoing;text:"Apply next batch";onClicked:root.scopeCall("retention_policy_apply",{change_id:root.policyChange.change_id},root.recordChange) }
        CButton { visible:!!root.policyChange;text:"Undo retention policy change";onClicked:root.scopeCall("retention_policy_undo",{change_id:root.policyChange.change_id},r=>{root.load();root.feedback=r.restored+" deadlines restored and "+r.conflicts+" changed since application."+(r.complete?"":" Choose Undo again for the next batch.")}) }
    }
    CText { text:root.feedback;visible:text.length>0;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.text }
}
