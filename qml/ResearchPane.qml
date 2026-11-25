import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Labels.js" as Labels

// The main Research page and the conversation Workbench share the same run controls.
Item {
    id: research
    objectName: "researchPane"
    implicitHeight: Theme.editorLarge
    property var app: typeof App !== "undefined" ? App : null
    property string sessionId: ""
    property bool pageMode: false
    property var runs: []
    property var projectSources: []
    property var chosenSourceIds: []
    property var selectedRun: null
    property string selectedId: ""
    property string reportText: ""
    property var selectedPassage: null
    property string followupAnswer: ""
    property string error: ""
    property string notice: ""
    property string currentView: "new"
    property bool includeArchived: false
    property int runLoadToken: 0
    property int reportLoadToken: 0
    property int listLoadToken: 0
    property int sourceLoadToken: 0
    property string historicalVersion: ""
    property var routes: []
    property int routeLoadToken: 0
    property string cancellingId: ""
    property bool startPending: false
    property string startRequestId: ""
    property bool handoffPending: false
    property var providerJobs: []
    property var providerJob: null
    property string providerJobId: ""
    property string providerJobRequestId: ""
    property string providerJobError: ""
    property string providerJobNotice: ""
    property bool providerJobBusy: false
    property bool initialized: false
    property string loadingRunId: ""
    property int viewRevision: 0
    readonly property bool narrow: width < Theme.wideToolbar
    readonly property var session: app?.session || ({})
    readonly property var selectedRoute: routePicker.currentIndex >= 0 && routePicker.currentIndex < routes.length ? routes[routePicker.currentIndex] : null
    // The broker only publishes compatible routes whose endpoint is configured; connectionId is
    // optional for the legacy default endpoint and present for named connections.
    readonly property string selectedRouteModel: selectedRoute?.model || routeModel.value
    readonly property bool routeReady: !!selectedRoute && !!selectedRoute.provider && !!selectedRouteModel
    readonly property bool supportedSession: session.id === sessionId && !session.temporary && (!session.remote || session.remote.role === "owner") && routeReady
    readonly property bool webEnabled: app?.state?.settings?.webSearch?.enabled === true
    readonly property bool providerJobsSupported: session.id === sessionId && session.provider === "perplexity" && !session.temporary && (!session.remote || session.remote.role === "owner")
    readonly property bool providerJobActive: !!providerJob && ["queued", "in_progress", "cancelling"].indexOf(providerJob.status) >= 0
    readonly property bool working: Labels.researchActive(selectedRun?.state)
    readonly property bool paused: !!selectedRun && selectedRun.state === "paused"
    readonly property var visibleRuns: runs.filter(run => {
        if (!includeArchived && run.archived) return false
        const needle = librarySearch.text.trim().toLowerCase()
        return !needle || [run.title, run.question, run.summary, run.state].some(value => String(value || "").toLowerCase().indexOf(needle) >= 0)
    }).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(b.updated || b.created || 0) - Number(a.updated || a.created || 0))
    readonly property var reportSections: splitReport(reportText)
    signal settingsRequested(string category, string target)
    signal draftRequested(string sessionId)

    RpcClient { id: rpc; endpoint: research.app; scope: research.sessionId }
    function fail(value) { error = value?.error || "Research could not complete that action."; notice = "" }
    function progressLabel(run) { return run ? String(run.progress || Labels.researchState(run.state)) : "" }
    function asArray(value) { const result=[];for(const row of value||[])result.push(row);return result }
    function lines(text) { return String(text || "").split(/\n+/).map(value => value.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, 12) }
    function commaList(text) { return String(text || "").split(/[\n,]+/).map(value => value.trim()).filter(Boolean) }
    function flattenRows(rows) { const result=[];for(const row of rows||[])for(const cell of row||[])result.push(cell);return result }
    function toggleSource(id) { const next=chosenSourceIds.slice(), index=next.indexOf(id); if(index>=0)next.splice(index,1);else next.push(id);chosenSourceIds=next }
    function routeParams() { const route=selectedRoute||{},params={provider:route.provider||"",model:selectedRouteModel};if(route.connectionId)params.connectionId=route.connectionId;return params }
    function showView(view) {
        if (!["new", "library", "report"].includes(view)) return
        if (currentView === view) viewRevision++
        currentView = view
        scroll.contentY = 0
    }
    function refresh() {
        reload()
        loadSources(sourceSearch.text.trim())
        loadRoutes()
        loadProviderJobs()
    }
    function resetDraft() {
        routeModel.set("")
        for (const field of [question, sourceSearch, librarySearch, planField, criteriaField,
                             siteField, urlField, providerJobPrompt, steerField, followupField, noteField])
            field.clear()
        for (const picker of [scope, depth, mode, recency, siteMode, outputShape])
            picker.currentIndex = 0
        providerJobEffort.currentIndex = 2
        parallelCheck.checked = false
        minutes.value = 5
        sourceLimit.value = 12
        callLimit.value = 3
        planSection.expanded = false
    }
    function loadRoutes() {
        if (!sessionId) return
        const owner=sessionId,token=++routeLoadToken,previous=selectedRoute
        rpc.call("research.routes",{sessionId:sessionId},value=>{
            if(token!==routeLoadToken||owner!==sessionId)return
            if(value.error){fail(value);routes=[];return}
            routes=asArray(value)
            let index=previous?routes.findIndex(route=>route.provider===previous.provider&&route.model===previous.model&&(route.connectionId||"")===(previous.connectionId||"")):-1
            if(index<0)index=routes.findIndex(route=>route.provider===session.provider&&route.model===session.model&&(route.connectionId||"")===(session.connectionId||""))
            if(index<0)index=0
            routePicker.currentIndex=routes.length?index:-1
        })
    }
    function reload() {
        if (!sessionId) return
        const owner=sessionId,token=++listLoadToken
        rpc.call("research.list", {sessionId:sessionId,project:true}, value => {
            if(token!==listLoadToken||owner!==sessionId)return
            if(value.error){fail(value);return} runs=asArray(value).map(run=>run.id===cancellingId?Object.assign({},run,{state:"cancel_requested",progress:"Cancellation requested…"}):run)
            if(selectedId){if(!runs.some(run=>run.id===selectedId)){WorkbenchState.selectResearch(sessionId,"","");clearSelection("library")}else if(!historicalVersion&&loadingRunId!==selectedId)loadRun(selectedId,false,"",true)}
        })
    }
    function loadSources(query) {
        if (!sessionId) return
        const owner=sessionId,token=++sourceLoadToken,params={sessionId:sessionId};if(query)params.query=query
        rpc.call("research.sources",params,value=>{if(token!==sourceLoadToken||owner!==sessionId)return;if(value.error){fail(value);return}projectSources=asArray(value)})
    }
    function clearSelection(fallbackView) {
        runLoadToken++
        reportLoadToken++
        loadingRunId = ""
        selectedId = ""
        selectedRun = null
        reportText = ""
        selectedPassage = null
        followupAnswer = ""
        historicalVersion = ""
        if (currentView === "report") showView(fallbackView || "library")
    }
    function loadRun(id,readReport,versionId,passive){
        if(!id)return
        const nextVersion=versionId||"",changingRun=id!==selectedId,changingVersion=nextVersion!==historicalVersion
        if(passive&&loadingRunId===id&&!changingVersion)return
        const token=++runLoadToken;reportLoadToken++;loadingRunId=id
        if(changingRun){selectedRun=null;followupAnswer=""}
        if(changingRun||changingVersion){reportText="";selectedPassage=null}
        selectedId=id;historicalVersion=nextVersion
        if(!passive){currentView="report";scroll.contentY=0;followupAnswer="";WorkbenchState.selectResearch(sessionId,id,historicalVersion)}
        rpc.call("research.get",{id:id},value=>{
            if(value.error){if(token===runLoadToken){loadingRunId="";fail(value)}return}
            if(token!==runLoadToken||selectedId!==id)return
            loadingRunId=""
            selectedRun=id===cancellingId?Object.assign({},value,{state:"cancel_requested",progress:"Cancellation requested…"}):value
            if(!historicalVersion)reportText=value.reportText||""
            error=""
            if(versionId)readReportVersion(versionId);else if(!passive&&(readReport===true||(!reportText&&["completed","partial","stopped"].indexOf(value.state)>=0)))readReportVersion("")
        })
    }
    function acceptWorkbenchSelection(){const selection=WorkbenchState.researchFor(sessionId);if(selection.id&&(selection.id!==selectedId||(selection.versionId||"")!==historicalVersion))loadRun(selection.id,false,selection.versionId,pageMode)}
    function readReportVersion(versionId){const id=selectedId,token=++reportLoadToken,params={id:id};historicalVersion=versionId||"";WorkbenchState.selectResearch(sessionId,id,historicalVersion);if(versionId)params.versionId=versionId;rpc.call("research.readReport",params,value=>{if(token!==reportLoadToken||id!==selectedId)return;if(value.error){fail(value);return}reportText=value.text||"";selectedRun=Object.assign({},selectedRun,value.evidence?{evidence:value.evidence}:{},value.findings?{findings:value.findings}:{},value.table?{table:value.table}:{});selectedPassage=null;error=""})}
    function generatePlan(){rpc.call("research.plan",Object.assign({sessionId:sessionId,question:question.text.trim(),mode:mode.currentValue},routeParams()),value=>{if(value.error){fail(value);return}planField.text=(value.plan||[]).join("\n");planSection.expanded=true;notice="Plan ready to edit."})}
    function start(){
        if(startPending)return
        const owner=sessionId,viewAtStart=viewRevision
        const sites=commaList(siteField.text).slice(0,5),urls=commaList(urlField.text),plan=lines(planField.text),criteria=lines(criteriaField.text)
        if(!startRequestId)startRequestId=sessionId+":"+Date.now()+":"+Math.random().toString(36).slice(2)
        const params=Object.assign({sessionId:sessionId,requestId:startRequestId,question:question.text.trim(),preset:depth.currentValue,mode:mode.currentValue,scope:scope.currentValue,sourceIds:scope.currentValue==="web"?[]:chosenSourceIds.slice(),minutes:minutes.value,sources:sourceLimit.value,calls:callLimit.value,output:outputShape.currentValue},routeParams())
        if(depth.currentValue==="thorough"&&parallelCheck.checked)params.parallel=true;if(plan.length)params.plan=plan;if(scope.currentValue!=="project"){if(sites.length){params.sites=sites;params.siteMode=siteMode.currentValue}if(urls.length)params.urls=urls;if(recency.currentValue)params.recency=recency.currentValue}if(criteria.length)params.criteria=criteria
        startPending=true
        rpc.call("research.start",params,value=>{if(owner!==sessionId)return;startPending=false;if(value.error){if(value.code!=="CONNECTION_LOST"&&value.code!=="DISCONNECTED")startRequestId="";fail(value);return}startRequestId="";runLoadToken++;reportLoadToken++;historicalVersion="";error="";notice="Research started.";selectedId=value.id;selectedRun=value;WorkbenchState.selectResearch(sessionId,value.id,"");reportText="";selectedPassage=null;followupAnswer="";if(viewRevision===viewAtStart)showView("report");reload()})
    }
    function runAction(method,params,message){const actionId=params?.id||selectedId;if(method==="research.cancel"&&selectedRun){cancellingId=selectedId;selectedRun=Object.assign({},selectedRun,{state:"cancel_requested",progress:"Cancellation requested…"})}rpc.call(method,params,value=>{if(method==="research.cancel"&&cancellingId===actionId)cancellingId="";if(value.error){fail(value);if(selectedId===actionId)loadRun(selectedId,false,"",true);return}error="";notice=message||"Updated.";if(selectedId===actionId&&!historicalVersion)loadRun(selectedId,false,"",true);reload()})}
    function updateRun(change, message, id = selectedId) {
        if (id) runAction("research.update", Object.assign({id: id}, change), message)
    }
    function escapeHtml(text){return String(text||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;")}
    function linkedBody(text){return escapeHtml(text).replace(/\[(E\d+(?:\.P\d+)?)\]/g,'<a href="citation:$1">[$1]</a>').replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>").replace(/\n/g,"<br>")}
    function splitReport(text){
        const raw=String(text||"").split("\n"),result=[];let title="Report",body=[]
        for(let line of raw){const heading=line.match(/^#{1,3}\s+(.+)$/);if(heading){if(body.join("\n").trim()||result.length)result.push({title:title,body:body.join("\n").trim()});title=heading[1].trim();body=[]}else body.push(line)}
        if(body.join("\n").trim()||!result.length)result.push({title:title,body:body.join("\n").trim()});return result
    }
    function openCitation(link){
        const token=String(link).replace(/^citation:/,"")
        for(let source of selectedRun?.evidence||[]){const passages=source.passages||[],exact=passages.find(p=>String(p.id)===token);if(exact){selectedPassage=Object.assign({sourceTitle:source.title||source.url||source.id},exact);return}if(String(source.id)===token&&passages.length){selectedPassage=Object.assign({sourceTitle:source.title||source.url||source.id},passages[0]);return}}
        selectedPassage={id:token,sourceTitle:"Citation "+token,text:"No saved passage is attached to this citation.",location:""}
    }
    function sourceLabel(source){return(source.title||source.id||"Source")+(source.kind?" · "+source.kind:"")}
    function newProviderJobRequestId(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return(c==="x"?r:(r&3)|8).toString(16)})}
    function providerJobState(state){return({queued:"Queued",in_progress:"Running",cancelling:"Cancelling…",completed:"Complete",incomplete:"Incomplete",failed:"Failed",cancelled:"Cancelled","unknown-outcome":"Outcome uncertain"})[state]||state||"Unknown"}
    function selectProviderJob(job){providerJobId=job?.id||"";providerJob=job||null}
    function loadProviderJobs(preserveError){
        if(!providerJobsSupported)return
        const owner=sessionId
        rpc.call("research.provider.list",{sessionId:owner},value=>{
            if(owner!==sessionId)return
            if(value.error){providerJobError=value.error;return}
            providerJobs=asArray(value)
            const chosen=providerJobs.find(job=>job.id===providerJobId)||providerJobs[0]||null
            selectProviderJob(chosen);if(!preserveError)providerJobError=""
        })
    }
    function startProviderJob(){
        if(providerJobBusy||providerJobPrompt.text.trim().length<1)return
        if(!providerJobRequestId)providerJobRequestId=newProviderJobRequestId()
        providerJobBusy=true;providerJobError="";providerJobNotice=""
        rpc.call("research.provider.start",{sessionId:sessionId,requestId:providerJobRequestId,prompt:providerJobPrompt.text.trim(),effort:providerJobEffort.currentValue},value=>{
            providerJobBusy=false
            if(value.error){providerJobError=value.error+" The request ID is retained; reload or retry to reconcile the same durable start without submitting a duplicate.";loadProviderJobs(true);return}
            selectProviderJob(value);providerJobRequestId=newProviderJobRequestId();providerJobNotice="Background Agent research started.";loadProviderJobs()
        })
    }
    function pollProviderJob(){
        if(providerJobBusy||!providerJobId)return
        const id=providerJobId
        providerJobBusy=true;providerJobError=""
        rpc.call("research.provider.poll",{sessionId:sessionId,id:id},value=>{providerJobBusy=false;if(value.error){providerJobError=value.error;loadProviderJobs(true);return}selectProviderJob(value);loadProviderJobs()})
    }
    function cancelProviderJob(){
        if(providerJobBusy||!providerJobId)return
        const id=providerJobId
        providerJobBusy=true;providerJobError="";providerJob=Object.assign({},providerJob,{status:"cancelling"})
        rpc.call("research.provider.cancel",{sessionId:sessionId,id:id},value=>{providerJobBusy=false;if(value.error){providerJobError=value.error;loadProviderJobs(true);return}selectProviderJob(value);providerJobNotice="Cancellation requested.";loadProviderJobs()})
    }
    function routeLabel(route){return route.label||(Labels.provider(route.provider||"")+(route.model?" · "+route.model:""))}
    function handoffRows(){
        const result=[{provider:"codex",model:"",label:"Codex CLI"},{provider:"claude",model:"",label:"Claude CLI"},{provider:"antigravity",model:"",label:"AntiGravity CLI"}]
        for(const route of routes)if(route.model&&!result.some(row=>row.provider===route.provider&&row.model===route.model&&(row.connectionId||"")===(route.connectionId||"")))result.push(Object.assign({},route,{label:routeLabel(route)}))
        return result
    }
    function handoff(){
        if(handoffPending)return
        const params={id:selectedId}
        if(handoffMode.currentValue==="existing")params.targetSessionId=handoffTarget.currentValue
        else{
            const route=handoffProvider.currentIndex>=0?handoffProvider.model[handoffProvider.currentIndex]:null
            if(!route)return
            params.provider=route.provider
            if(route.model)params.model=route.model
            if(route.connectionId)params.connectionId=route.connectionId
            if(["codex","claude","antigravity"].indexOf(route.provider)>=0)params.trusted=handoffTrust.checked
        }
        handoffDialog.error=""
        handoffPending=true
        rpc.call("research.handoff",params,value=>{
            handoffPending=false
            if(value.error){handoffDialog.error=value.error;return}
            handoffDialog.close();draftRequested(value.sessionId)
        })
    }

    Timer{interval:1500;repeat:true;running:research.visible&&(research.working||research.runs.some(run=>Labels.researchActive(run.state)));onTriggered:research.reload()}
    Timer{interval:2500;repeat:true;running:research.visible&&research.providerJobsSupported&&research.providerJobActive&&!research.providerJobBusy;onTriggered:research.pollProviderJob()}
    function initializeSession() {
        listLoadToken++
        sourceLoadToken++
        routeLoadToken++
        cancellingId = ""
        startPending = false
        startRequestId = ""
        handoffPending = false
        runs = []
        routes = []
        projectSources = []
        chosenSourceIds = []
        providerJobs = []
        selectProviderJob(null)
        providerJobBusy = false
        providerJobError = ""
        providerJobNotice = ""
        error = ""
        notice = ""
        clearSelection("new")
        resetDraft()
        providerJobRequestId = newProviderJobRequestId()
        refresh()
        acceptWorkbenchSelection()
    }
    onSessionIdChanged:if(initialized)initializeSession()
    onCurrentViewChanged:viewRevision++
    onVisibleChanged: {
        if (visible && initialized) { refresh(); acceptWorkbenchSelection() }
    }
    Connections {
        target: rpc
        function onOnlineChanged() {
            if (rpc.online && research.visible && research.initialized) research.refresh()
        }
    }
    Component.onCompleted:{initialized=true;initializeSession()}
    Connections {
        target: WorkbenchState
        function onResearchSelectionsChanged() {
            if (research.visible) research.acceptWorkbenchSelection()
        }
    }

    Flickable{
        id:scroll;anchors.fill:parent;clip:true;contentWidth:width;contentHeight:content.implicitHeight+Theme.space2;boundsBehavior:Flickable.StopAtBounds;flickableDirection:Flickable.VerticalFlick
        ScrollBar.vertical:CScrollBar{}
        ColumnLayout{
            id:content
            width:Math.max(0,scroll.width-(scroll.contentHeight>scroll.height?Theme.minimumTarget:0))
            spacing:research.pageMode&&!research.narrow?Theme.space3:Theme.space2
            RowLayout{visible:!research.pageMode;Layout.fillWidth:true;spacing:Theme.space1
                CButton{objectName:"researchViewNew";Layout.fillWidth:true;leftPadding:Theme.space1;rightPadding:Theme.space1;text:"New";primary:research.currentView==="new";onClicked:research.showView("new")}
                CButton{objectName:"researchViewLibrary";Layout.fillWidth:true;leftPadding:Theme.space1;rightPadding:Theme.space1;text:research.narrow?"Saved":"Library";primary:research.currentView==="library";onClicked:research.showView("library")}
                CButton{objectName:"researchViewReport";Layout.fillWidth:true;leftPadding:Theme.space1;rightPadding:Theme.space1;text:"Report";primary:research.currentView==="report";enabled:!!research.selectedRun;onClicked:research.showView("report")}
            }

            CText {
                visible: !!text
                text: research.error || research.notice
                color: research.error ? Theme.danger : Theme.success
                font.pixelSize: Theme.secondary
            }
            ColumnLayout{visible:research.currentView==="new";Layout.fillWidth:true;spacing:research.pageMode&&!research.narrow?Theme.space3:Theme.space2
                ColumnLayout{visible:research.pageMode;Layout.fillWidth:true;spacing:Theme.space1
                    CText{Layout.fillWidth:true;text:"Start a research run";font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading}
                    CText{Layout.fillWidth:true;color:Theme.muted;font.pixelSize:Theme.secondary;text:"Choose the sources PAL can use to answer your question. The cited report is saved with this project."}
                }
                CTextArea{id:question;objectName:"researchQuestion";Layout.fillWidth:true;Layout.preferredHeight:research.pageMode?Theme.editorShort+Theme.space2:Theme.editorShort;placeholderText:"What should PAL investigate?";Accessible.name:"Research question"}
                CText{visible:!research.pageMode;Layout.fillWidth:true;color:Theme.muted;font.pixelSize:Theme.caption;text:"Plan a bounded run, watch what PAL reads, then keep the cited report with this project."}
                GridLayout{visible:!research.supportedSession;Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                    CText{Layout.fillWidth:true;color:Theme.amber;font.pixelSize:Theme.caption;text:session.temporary?"Save this conversation before starting research.":session.remote&&session.remote.role!=="owner"?"Research can only start from an owner-controlled conversation.":routes.length===0?"Configure Ollama or a managed API connection for research.":"Choose an available research model."}
                    CButton{visible:routes.length===0;Layout.fillWidth:research.narrow;text:"Research model settings";quiet:true;onClicked:research.settingsRequested("connections","")}
                }
                GridLayout{visible:scope.currentValue!=="project"&&!research.webEnabled;Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                    CText{Layout.fillWidth:true;text:"Web search is off. Choose Project only or enable web search.";color:Theme.amber;font.pixelSize:Theme.caption}
                    CButton{Layout.fillWidth:research.narrow;text:"Web search settings";quiet:true;onClicked:research.settingsRequested("knowledge","webSearchEnabled")}
                }
                GridLayout{Layout.fillWidth:true;columns:(research.pageMode?content.width<Theme.wideToolbar+Theme.space4*2:research.width<Theme.formBreakpoint)?1:3;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                    ColumnLayout{Layout.fillWidth:true;spacing:Theme.space1
                        CText{visible:research.pageMode;text:"Sources";color:Theme.muted;font.pixelSize:Theme.caption}
                        CComboBox{id:scope;objectName:"researchScope";Layout.fillWidth:true;model:[{label:"Web only",value:"web"},{label:"Web + project",value:"both"},{label:"Project only",value:"project"}];textRole:"label";valueRole:"value";Accessible.name:"Research scope"}
                    }
                    ColumnLayout{Layout.fillWidth:true;spacing:Theme.space1
                        CText{visible:research.pageMode;text:"Depth";color:Theme.muted;font.pixelSize:Theme.caption}
                        CComboBox{id:depth;objectName:"researchDepth";Layout.fillWidth:true;model:[{label:"Quick",value:"quick"},{label:"Thorough",value:"thorough"}];textRole:"label";valueRole:"value";Accessible.name:"Research depth";onCurrentValueChanged:{if(currentValue==="thorough"){minutes.value=20;sourceLimit.value=40;callLimit.value=10}else{minutes.value=5;sourceLimit.value=12;callLimit.value=3;parallelCheck.checked=false}}}
                    }
                    ColumnLayout{Layout.fillWidth:true;spacing:Theme.space1
                        CText{visible:research.pageMode;text:"Goal";color:Theme.muted;font.pixelSize:Theme.caption}
                        CComboBox{id:mode;objectName:"researchMode";Layout.fillWidth:true;model:[{label:"Answer",value:"answer"},{label:"Compare",value:"compare"},{label:"Fact check",value:"check"},{label:"Literature review",value:"literature"}];textRole:"label";valueRole:"value";Accessible.name:"Research mode";onActivated:outputShape.currentIndex=currentValue==="compare"?2:0}
                    }
                }
                ColumnLayout{Layout.fillWidth:true;spacing:Theme.space1
                    CText{text:"Research model";color:Theme.muted;font.pixelSize:Theme.caption}
                    CComboBox{id:routePicker;objectName:"researchRoute";Layout.fillWidth:true;model:research.routes;textRole:"label";Accessible.name:"Research provider and model";onActivated:routeModel.set("")}
                    ModelPicker{id:routeModel;app:research.app;name:"researchRouteModel";visible:!!selectedRoute&&!selectedRoute.model;Layout.fillWidth:true;provider:visible?selectedRoute.provider||"":"";connectionId:visible?selectedRoute.connectionId||"":"";label:"Research model"}
                    CText{visible:selectedRoute?.provider==="compatible";Layout.fillWidth:true;text:"Compatible routes appear only after their endpoint is configured.";color:Theme.muted;font.pixelSize:Theme.caption}
                }
                CText{visible:scope.currentValue!=="project";Layout.fillWidth:true;text:"Public search receives the question and any web filters, never project text.";color:Theme.muted;font.pixelSize:Theme.caption}
                CText{visible:mode.currentValue==="literature"&&scope.currentValue!=="project";Layout.fillWidth:true;text:"Literature mode searches scholarly records through Crossref as well as the public web.";color:Theme.muted;font.pixelSize:Theme.caption}
                CSection{visible:scope.currentValue!=="web";title:"Project sources";hint:chosenSourceIds.length+" chosen";expanded:false
                    RowLayout{Layout.fillWidth:true
                        CField{id:sourceSearch;Layout.fillWidth:true;placeholderText:"Find project sources";Accessible.name:"Search project sources"}
                        CButton{text:"Find";implicitHeight:Theme.compactHeight;onClicked:research.loadSources(sourceSearch.text.trim())}
                    }
                    CText{visible:projectSources.length===0;text:"No project sources are available yet.";color:Theme.muted;font.pixelSize:Theme.caption}
                    Repeater{model:projectSources;CCheckBox{required property var modelData;required property int index;objectName:"researchSource_"+index;Layout.fillWidth:true;text:research.sourceLabel(modelData);checked:chosenSourceIds.indexOf(modelData.id)>=0;onClicked:research.toggleSource(modelData.id)}}
                }
                Flow{Layout.fillWidth:true;spacing:Theme.space2
                    CButton{id:quick;objectName:"researchQuick";text:research.startPending?"Starting…":depth.currentValue==="thorough"?"Start thorough research":"Start research";primary:!research.pageMode;prominent:research.pageMode&&enabled;enabled:!research.startPending&&research.supportedSession&&question.text.trim().length>=5&&(scope.currentValue==="project"||research.webEnabled)&&(scope.currentValue==="web"||chosenSourceIds.length>0);help:!research.supportedSession?"Choose a saved owner-controlled conversation and configured research model":scope.currentValue!=="web"&&chosenSourceIds.length===0?"Choose at least one project source":"Start this bounded research run";onClicked:research.start()}
                    CText{height:quick.height;text:minutes.value+" min · "+sourceLimit.value+" sources · "+callLimit.value+" calls";color:Theme.muted;font.pixelSize:Theme.caption;verticalAlignment:Text.AlignVCenter}
                }
                CSection{visible:research.providerJobsSupported;title:"Perplexity Agent jobs";hint:research.providerJobActive?research.providerJobState(research.providerJob?.status):research.providerJobs.length+" saved";expanded:false
                    CText{Layout.fillWidth:true;text:"Run durable Perplexity Agent research in the background. Closing PAL does not discard the provider handle.";color:Theme.muted;font.pixelSize:Theme.caption}
                    CTextArea{id:providerJobPrompt;objectName:"providerJobPrompt";Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"What should Perplexity investigate?";Accessible.name:"Perplexity Agent research prompt";onTextChanged:{research.providerJobRequestId=research.newProviderJobRequestId();research.providerJobNotice=""}}
                    CComboBox{id:providerJobEffort;objectName:"providerJobEffort";Layout.fillWidth:true;model:[{label:"Fast",value:"fast"},{label:"Low",value:"low"},{label:"Medium",value:"medium"},{label:"High",value:"high"},{label:"Extra high",value:"xhigh"},{label:"Ultra",value:"ultra"}];textRole:"label";valueRole:"value";currentIndex:2;Accessible.name:"Perplexity Agent effort preset";onCurrentValueChanged:{research.providerJobRequestId=research.newProviderJobRequestId();research.providerJobNotice=""}}
                    Flow{Layout.fillWidth:true;spacing:Theme.space1
                        CButton{objectName:"providerJobStart";text:research.providerJobBusy?"Working…":"Start background job";primary:true;enabled:!research.providerJobBusy&&providerJobPrompt.text.trim().length>0;onClicked:research.startProviderJob()}
                        CButton{text:"Reload jobs";quiet:true;enabled:!research.providerJobBusy;onClicked:research.loadProviderJobs()}
                    }
                    CText{visible:!!research.providerJobError;Layout.fillWidth:true;text:research.providerJobError;color:Theme.danger;font.pixelSize:Theme.caption}
                    CText{visible:!!research.providerJobNotice&&!research.providerJobError;Layout.fillWidth:true;text:research.providerJobNotice;color:Theme.success;font.pixelSize:Theme.caption}
                    CText{visible:research.providerJobs.length===0;Layout.fillWidth:true;text:"No Perplexity Agent jobs for this conversation.";color:Theme.muted;font.pixelSize:Theme.caption}
                    Repeater{model:research.providerJobs
                        CButton{required property var modelData;Layout.fillWidth:true;alignLeft:true;quiet:true;text:research.providerJobState(modelData.status)+" · "+String(modelData.prompt||"Untitled job").slice(0,160);primary:research.providerJobId===modelData.id;onClicked:research.selectProviderJob(modelData)}
                    }
                    Rectangle{visible:!!research.providerJob;Layout.fillWidth:true;implicitHeight:providerJobDetail.implicitHeight+Theme.space4;color:Theme.surface;radius:Theme.radiusControl;border.color:Theme.border
                        ColumnLayout{id:providerJobDetail;x:Theme.space2;y:Theme.space2;width:Math.max(0,parent.width-Theme.space4);spacing:Theme.space1
                            CText{Layout.fillWidth:true;text:research.providerJobState(research.providerJob?.status)+(research.providerJob?.effort?" · "+research.providerJob.effort:"");font.weight:Font.DemiBold}
                            CText{visible:research.providerJob?.status==="unknown-outcome";Layout.fillWidth:true;text:"PAL saved this request before sending it, but did not receive a provider handle. Reload or retry the unchanged prompt to reconcile this durable start; PAL will not submit that request ID twice.";color:Theme.amber;font.pixelSize:Theme.caption}
                            CText{visible:!!research.providerJob?.error;Layout.fillWidth:true;text:research.providerJob?.error||"";color:Theme.amber;font.pixelSize:Theme.caption}
                            ProgressBar{visible:research.providerJobActive;Layout.fillWidth:true;indeterminate:true;Accessible.name:research.providerJobState(research.providerJob?.status)}
                            Flow{Layout.fillWidth:true;spacing:Theme.space1
                                CButton{text:"Poll now";enabled:!research.providerJobBusy&&!!research.providerJob?.remoteId&&research.providerJob?.status!=="cancelling";onClicked:research.pollProviderJob()}
                                CButton{text:research.providerJob?.status==="cancelling"?"Cancelling…":"Cancel";danger:true;visible:["queued","in_progress","cancelling"].indexOf(research.providerJob?.status)>=0;enabled:!research.providerJobBusy&&research.providerJob?.status!=="cancelling";onClicked:research.cancelProviderJob()}
                            }
                            TextEdit{visible:!!research.providerJob?.text;Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredHeight:contentHeight;text:research.providerJob?.text||"";readOnly:true;selectByMouse:true;color:Theme.text;selectionColor:Theme.selectionFill;selectedTextColor:Theme.selectionInk;font.family:Theme.font;font.pixelSize:Theme.body;wrapMode:TextEdit.Wrap;Accessible.name:"Perplexity Agent result"}
                            CText{visible:(research.providerJob?.sources||[]).length>0;Layout.fillWidth:true;text:"Citations";font.weight:Font.DemiBold;font.pixelSize:Theme.caption}
                            Repeater{model:research.providerJob?.sources||[];CButton{required property var modelData;Layout.fillWidth:true;alignLeft:true;quiet:true;text:modelData.title||modelData.url||"Source";help:modelData.url||"";enabled:/^https?:\/\//.test(modelData.url||"");onClicked:Qt.openUrlExternally(modelData.url)}}
                            CText{visible:(research.providerJob?.files||[]).length>0;Layout.fillWidth:true;text:"Attached output files: "+(research.providerJob?.files||[]).map(file=>file.name).join(", ");color:Theme.muted;font.pixelSize:Theme.caption}
                            Repeater{model:research.providerJob?.recoveryNotes||[];CText{required property var modelData;Layout.fillWidth:true;text:modelData;color:Theme.amber;font.pixelSize:Theme.caption}}
                        }
                    }
                }
                CSection{id:planSection;title:"Advanced plan, limits, and web options";hint:"optional";expanded:false
                    Flow{Layout.fillWidth:true;spacing:Theme.space1
                        CButton{text:"Generate plan";implicitHeight:Theme.compactHeight;enabled:research.supportedSession&&question.text.trim().length>=5;onClicked:research.generatePlan()}
                        CText{text:"Edit the outline before starting.";color:Theme.muted;font.pixelSize:Theme.caption;verticalAlignment:Text.AlignVCenter}
                    }
                    CTextArea{id:planField;objectName:"researchPlan";Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"One planned step per line (up to 12)";Accessible.name:"Editable research plan"}
                    CTextArea{id:criteriaField;Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"One success criterion per line (up to 12)";Accessible.name:"Research success criteria"}
                    CCheckBox{id:parallelCheck;visible:depth.currentValue==="thorough";Layout.fillWidth:true;text:"Parallel subquestions (uses more model calls)";checked:false}
                    GridLayout{Layout.fillWidth:true;columns:(research.pageMode?content.width<Theme.wideToolbar+Theme.space4*2:research.width<Theme.formBreakpoint)?2:6;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                        CText{text:"Minutes";color:Theme.muted;font.pixelSize:Theme.caption} CSpinBox{id:minutes;objectName:"researchMinutes";Layout.fillWidth:true;from:1;to:60;value:5;Accessible.name:"Minute limit"}
                        CText{text:"Sources";color:Theme.muted;font.pixelSize:Theme.caption} CSpinBox{id:sourceLimit;objectName:"researchSourcesLimit";Layout.fillWidth:true;from:1;to:60;value:12;Accessible.name:"Source limit"}
                        CText{text:"Calls";color:Theme.muted;font.pixelSize:Theme.caption} CSpinBox{id:callLimit;objectName:"researchCalls";Layout.fillWidth:true;from:2;to:20;value:3;Accessible.name:"Model and search call limit"}
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Theme.space1
                        CText { text: "Report format"; color: Theme.muted; font.pixelSize: Theme.caption }
                        CComboBox {
                            id: outputShape
                            Layout.fillWidth: true
                            model: [{label:"Brief report",value:"brief"},{label:"Timeline",value:"timeline"},{label:"Comparison matrix",value:"matrix"}]
                            textRole: "label"; valueRole: "value"; Accessible.name: "Research report format"
                        }
                    }
                    GridLayout{visible:scope.currentValue!=="project";Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                        CField{id:siteField;objectName:"researchSites";Layout.fillWidth:true;placeholderText:"Preferred sites (up to 5)";Accessible.name:"Preferred research sites"}
                        CComboBox{id:recency;objectName:"researchRecency";Layout.fillWidth:true;model:[{label:"Any date",value:""},{label:"Past day",value:"day"},{label:"Past week",value:"week"},{label:"Past month",value:"month"},{label:"Past year",value:"year"}];textRole:"label";valueRole:"value";Accessible.name:"Source recency"}
                        CComboBox{id:siteMode;Layout.fillWidth:true;model:[{label:"Prefer these sites",value:"prefer"},{label:"Only these sites",value:"only"}];textRole:"label";valueRole:"value";Accessible.name:"Preferred site behavior"}
                        CField{id:urlField;Layout.fillWidth:true;Layout.columnSpan:research.narrow?1:2;placeholderText:"Seed URLs, separated by commas (optional)";Accessible.name:"Seed URLs"}
                    }
                }
            }

            ColumnLayout{visible:research.currentView==="library";Layout.fillWidth:true;spacing:research.pageMode&&!research.narrow?Theme.space3:Theme.space2
                ColumnLayout{visible:research.pageMode;Layout.fillWidth:true;spacing:Theme.space1
                    CText{Layout.fillWidth:true;text:"Saved research";font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading}
                    CText{Layout.fillWidth:true;text:research.runs.length?research.runs.length+" run"+(research.runs.length===1?"":"s")+" saved with this project":"Completed and in-progress runs will appear here.";color:Theme.muted;font.pixelSize:Theme.secondary}
                }
                RowLayout{Layout.fillWidth:true;spacing:Theme.space2
                    CField{id:librarySearch;objectName:"researchLibrarySearch";Layout.fillWidth:true;placeholderText:"Search saved research";Accessible.name:"Search research library"}
                    CButton{text:"Reload";quiet:true;implicitHeight:Theme.compactHeight;onClicked:research.reload()}
                }
                CCheckBox{Layout.fillWidth:true;text:"Show archived";checked:research.includeArchived;onClicked:research.includeArchived=checked}
                CText{visible:research.visibleRuns.length===0;text:"No saved research matches this view.";color:Theme.muted;font.pixelSize:Theme.caption}
                Repeater{model:research.visibleRuns
                    Rectangle{required property var modelData;Layout.fillWidth:true;implicitHeight:libraryRow.implicitHeight+Theme.space4;radius:Theme.radiusControl;color:selectedId===modelData.id?Theme.selected:Theme.surface;border.color:modelData.stale?Theme.warningBorder:selectedId===modelData.id?Theme.primaryBorder:Theme.border
                        RowLayout{id:libraryRow;x:Theme.space2;y:Theme.space2;width:Math.max(0,parent.width-Theme.space4);spacing:Theme.space2
                            CButton{Layout.fillWidth:true;quiet:true;alignLeft:true;implicitHeight:Theme.compactHeight;text:(modelData.pinned?"★ ":"")+(modelData.title||modelData.question||"Untitled research")+" · "+research.progressLabel(modelData)+(modelData.stale?" · stale":"");onClicked:research.loadRun(modelData.id,false)}
                            CButton{text:modelData.pinned?"Unpin":"Pin";quiet:true;implicitHeight:Theme.compactHeight;onClicked:research.updateRun({pinned:!modelData.pinned},modelData.pinned?"Unpinned.":"Pinned.",modelData.id)}
                            CButton{text:modelData.archived?"Restore":"Archive";quiet:true;implicitHeight:Theme.compactHeight;onClicked:research.updateRun({archived:!modelData.archived},modelData.archived?"Restored.":"Archived.",modelData.id)}
                        }
                    }
                }
            }

            ColumnLayout{visible:research.pageMode&&research.currentView==="report"&&!research.selectedRun;Layout.fillWidth:true;spacing:Theme.space2
                CText{Layout.fillWidth:true;text:"Research report";font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading}
                CText{visible:!!research.loadingRunId;text:"Loading research…";color:Theme.muted;font.pixelSize:Theme.secondary}
            }

            ColumnLayout{visible:research.currentView==="report"&&!!research.selectedRun;Layout.fillWidth:true;spacing:Theme.space2
                GridLayout{Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                    ColumnLayout{Layout.fillWidth:true;spacing:Theme.space1
                        CText{Layout.fillWidth:true;text:selectedRun?selectedRun.title||selectedRun.question||"Research":"";font.pixelSize:research.pageMode?Theme.title:Theme.section;font.weight:Font.DemiBold;Accessible.role:research.pageMode?Accessible.Heading:Accessible.StaticText}
                        CText{Layout.fillWidth:true;text:selectedRun?Labels.researchState(selectedRun.state)+(selectedRun.summary?" · "+selectedRun.summary:""):"";color:selectedRun?.stale?Theme.amber:Theme.muted;font.pixelSize:Theme.caption}
                        CText{visible:!!selectedRun?.provider;Layout.fillWidth:true;text:Labels.provider(selectedRun?.provider||"")+(selectedRun?.model?" · "+selectedRun.model:"");color:Theme.muted;font.pixelSize:Theme.caption;elide:Text.ElideMiddle;maximumLineCount:1}
                        CText{visible:["failed","interrupted","cancelled"].indexOf(selectedRun?.state)>=0&&!!(selectedRun?.error||selectedRun?.note);Layout.fillWidth:true;text:selectedRun?.error||selectedRun?.note||"";color:Theme.amber;font.pixelSize:Theme.caption}
                    }
                    Flow{Layout.fillWidth:research.narrow;Layout.alignment:Qt.AlignRight;spacing:Theme.space1
                        CButton{visible:research.working&&selectedRun?.state!=="cancel_requested";text:"Pause";implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.pause",{id:selectedId},"Paused.")}
                        CButton {
                            objectName: "researchFinishEarly"
                            visible: (research.working && selectedRun?.state !== "cancel_requested") || research.paused
                            text: "Finish early"; implicitHeight: Theme.compactHeight
                            help: "Save a report with the evidence collected so far"
                            onClicked: research.runAction("research.stop", {id: selectedId}, "Finishing with the evidence collected so far.")
                        }
                        CButton{visible:(research.working&&selectedRun?.state!=="cancel_requested")||research.paused;text:"Cancel";danger:true;implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.cancel",{id:selectedId},"Cancellation requested.")}
                        CButton{visible:!research.working;text:"Rename";implicitHeight:Theme.compactHeight;onClicked:{renameField.text=selectedRun.title||selectedRun.question||"";renameDialog.open()}}
                        CButton{visible:selectedRun?.stale||["completed","partial","stopped"].indexOf(selectedRun?.state)>=0;text:"Refresh";implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.refresh",{id:selectedId},"Refresh started.")}
                        CButton{objectName:"researchHandoff";visible:["completed","partial","stopped"].indexOf(selectedRun?.state)>=0&&!!selectedRun?.report&&!selectedRun?.stale;text:research.historicalVersion?"Plan from latest report":"Plan from report";implicitHeight:Theme.compactHeight;onClicked:handoffDialog.open()}
                    }
                }
                Rectangle{visible:research.working||research.paused;Layout.fillWidth:true;implicitHeight:runProgress.implicitHeight+Theme.space4;color:Theme.surface;radius:Theme.radiusControl;border.color:Theme.border
                    ColumnLayout{id:runProgress;x:Theme.space2;y:Theme.space2;width:Math.max(0,parent.width-Theme.space4);spacing:Theme.space1
                        CText{Layout.fillWidth:true;text:research.progressLabel(selectedRun);font.weight:Font.DemiBold}
                        ProgressBar{Layout.fillWidth:true;indeterminate:research.working;Accessible.name:"Research is active"}
                        Repeater{model:(selectedRun?.activity||[]).slice(-8);CText{required property var modelData;Layout.fillWidth:true;text:(modelData.time?new Date(modelData.time).toLocaleTimeString(Qt.locale(),Locale.ShortFormat)+" · ":"")+modelData.text;color:Theme.muted;font.pixelSize:Theme.caption}}
                    }
                }
                CSection{visible:research.working||research.paused||["stopped","failed","interrupted"].indexOf(selectedRun?.state)>=0;title:"Steer or recover";expanded:research.working||research.paused
                    CField{id:steerField;objectName:"researchSteer";Layout.fillWidth:true;placeholderText:"Focus on a question, source, or angle";Accessible.name:"Research steering instruction"}
                    Flow{Layout.fillWidth:true;spacing:Theme.space1
                        CButton{visible:research.working&&selectedRun?.state!=="cancel_requested";text:"Steer current run";enabled:steerField.text.trim().length>0;onClicked:{research.runAction("research.steer",{id:selectedId,focus:steerField.text.trim()},"Steering updated.");steerField.text=""}}
                        CButton{visible:!research.working&&selectedRun?.state!=="cancelled";text:["failed","interrupted"].indexOf(selectedRun?.state)>=0?"Resume research":"Continue research";primary:true;onClicked:{const params={id:selectedId};if(steerField.text.trim())params.focus=steerField.text.trim();research.runAction("research.continue",params,"Research continued.");steerField.text=""}}
                    }
                }
                CSection{visible:(selectedRun?.plan||[]).length>0;title:"Run plan";hint:(selectedRun?.plan||[]).length+" steps";expanded:research.working
                    Repeater{model:selectedRun?.plan||[];CText{required property var modelData;required property int index;Layout.fillWidth:true;text:(index+1)+". "+modelData}}
                }
                CSection{visible:!!research.reportText;title:"Report";hint:research.reportSections.length+" sections";expanded:true
                    Repeater{model:research.reportSections
                        ColumnLayout{required property var modelData;Layout.fillWidth:true;spacing:Theme.space1
                            CText{Layout.fillWidth:true;text:modelData.title;font.weight:Font.DemiBold;font.pixelSize:Theme.section}
                            TextEdit{Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredHeight:contentHeight;text:research.linkedBody(modelData.body);textFormat:TextEdit.RichText;readOnly:true;selectByMouse:true;color:Theme.text;selectionColor:Theme.selectionFill;selectedTextColor:Theme.selectionInk;font.family:Theme.font;font.pixelSize:Theme.body;wrapMode:TextEdit.Wrap;Accessible.name:modelData.title;onLinkActivated:link=>research.openCitation(link)}
                        }
                    }
                    Rectangle{visible:!!research.selectedPassage;Layout.fillWidth:true;implicitHeight:passageColumn.implicitHeight+Theme.space4;color:Theme.questionSurface;radius:Theme.radiusControl;border.color:Theme.activeBorder
                        ColumnLayout{id:passageColumn;x:Theme.space2;y:Theme.space2;width:Math.max(0,parent.width-Theme.space4);spacing:Theme.space1
                            CText{objectName:"researchPassage";Layout.fillWidth:true;text:selectedPassage?selectedPassage.sourceTitle+(selectedPassage.location?" · "+selectedPassage.location:""):"";font.weight:Font.DemiBold;font.pixelSize:Theme.caption}
                            CText{Layout.fillWidth:true;text:selectedPassage?.text||""}
                            CButton{text:"Close passage";quiet:true;implicitHeight:Theme.compactHeight;onClicked:selectedPassage=null}
                        }
                    }
                }
                CSection{visible:(selectedRun?.findings||[]).length>0;title:"Findings";hint:(selectedRun?.findings||[]).length+" claims";expanded:false
                    Repeater{model:selectedRun?.findings||[]
                        ColumnLayout{required property var modelData;Layout.fillWidth:true;spacing:Theme.space1
                            CText{Layout.fillWidth:true;text:modelData.text+(modelData.status?" · "+modelData.status:"")}
                            Flow{Layout.fillWidth:true;spacing:Theme.space1;Repeater{model:modelData.citations||[];CButton{required property var modelData;objectName:"researchCitation_"+modelData;text:"["+modelData+"]";quiet:true;implicitHeight:Theme.compactHeight;onClicked:research.openCitation("citation:"+modelData)}}}
                        }
                    }
                }
                CSection{visible:(selectedRun?.changes||[]).length>0||(selectedRun?.table?.rows||[]).length>0;title:"Changes and comparison";expanded:false
                    Repeater{model:selectedRun?.changes||[];CText{required property var modelData;Layout.fillWidth:true;text:"• "+modelData}}
                    GridLayout{visible:(selectedRun?.table?.rows||[]).length>0;Layout.fillWidth:true;columns:Math.max(1,(selectedRun?.table?.columns||[]).length);columnSpacing:Theme.space2;rowSpacing:Theme.space1
                        Repeater{model:selectedRun?.table?.columns||[];CText{required property var modelData;text:modelData;font.weight:Font.DemiBold;font.pixelSize:Theme.caption}}
                        Repeater{model:research.flattenRows(selectedRun?.table?.rows||[]);CText{required property var modelData;text:modelData;font.pixelSize:Theme.caption}}
                    }
                }
                CSection{visible:(selectedRun?.evidence||[]).length>0;title:"Sources and exclusions";hint:(selectedRun?.evidence||[]).length+" sources";expanded:false
                    Repeater{model:selectedRun?.evidence||[]
                        GridLayout{required property var modelData;Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                            CText{Layout.fillWidth:true;text:"["+modelData.id+"] "+(modelData.title||modelData.url||"Source")+(modelData.status?" · "+modelData.status:"");color:modelData.status==="excluded"?Theme.muted:Theme.text;font.pixelSize:Theme.caption}
                            CButton{visible:modelData.status!=="excluded"&&!research.working;Layout.fillWidth:research.narrow;text:"Exclude";implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.exclude",{id:selectedId,evidenceId:modelData.id},"Source excluded. Choose Rewrite to update the report.")}
                        }
                    }
                    CButton{visible:!research.working;text:"Rewrite from included sources";onClicked:research.runAction("research.resynthesize",{id:selectedId},"Report rewrite started.")}
                }
                CSection{title:"Monitor, revisions, and output";expanded:false
                    GridLayout{Layout.fillWidth:true;columns:research.narrow?1:3;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                        CSpinBox{id:monitorDays;Layout.fillWidth:true;from:0;to:365;saved:selectedRun?.monitorDays||0;readonly property string run:selectedId||"";onRunChanged:value=saved;Accessible.name:"Monitor interval in days"}
                        CButton{Layout.fillWidth:research.narrow;text:monitorDays.value?"Monitor every "+monitorDays.value+" days":"Turn monitoring off";onClicked:research.updateRun({monitorDays:monitorDays.value},monitorDays.value?"Monitoring scheduled.":"Monitoring turned off.")}
                        CButton{Layout.fillWidth:research.narrow;text:"Refresh now";onClicked:research.runAction("research.refresh",{id:selectedId},"Refresh started.")}
                    }
                    Flow{visible:(selectedRun?.revisions||[]).length>0;Layout.fillWidth:true;spacing:Theme.space1
                        CButton{text:"Current report";primary:!research.historicalVersion;implicitHeight:Theme.compactHeight;onClicked:research.loadRun(selectedId,true,"",false)}
                        Repeater{model:selectedRun?.revisions||[];CButton{required property var modelData;text:modelData.summary||(modelData.time?new Date(modelData.time).toLocaleString(Qt.locale(),Locale.ShortFormat):"Revision");primary:research.historicalVersion===modelData.versionId;implicitHeight:Theme.compactHeight;onClicked:research.readReportVersion(modelData.versionId)}}
                    }
                    Flow{Layout.fillWidth:true;spacing:Theme.space1;Repeater{model:[{label:"PDF",format:"pdf"},{label:"Word",format:"docx"},{label:"Markdown",format:"markdown"},{label:"CSV",format:"csv"},{label:"BibTeX",format:"bibtex"},{label:"JSON",format:"json"}];CButton{required property var modelData;text:"Export "+modelData.label;implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.export",{id:selectedId,format:modelData.format},modelData.label+" added to this conversation.")}}}
                    CTextArea{id:noteField;objectName:"researchNote";Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"Add a note to this research run";Accessible.name:"Research note"}
                    CButton{text:"Save note";enabled:noteField.text.trim().length>0;onClicked:{research.runAction("research.note",{id:selectedId,text:noteField.text.trim()},"Note saved.");noteField.text=""}}
                }
                CSection{visible:!!research.reportText;title:"Ask a follow-up";expanded:false
                    CField{id:followupField;objectName:"researchFollowup";Layout.fillWidth:true;placeholderText:"Ask about this report";Accessible.name:"Research follow-up question"}
                    CButton {
                        text: "Ask from this research"; primary: true
                        enabled: followupField.text.trim().length > 0
                        onClicked: {
                            const id = research.selectedId
                            rpc.call("research.ask", {id: id, question: followupField.text.trim()}, value => {
                                if (id !== research.selectedId) return
                                if (value.error) { research.fail(value); return }
                                research.error = ""
                                research.followupAnswer = value.answer || ""
                                if (!research.historicalVersion) research.loadRun(id, false, "", true)
                            })
                            followupField.clear()
                        }
                    }
                    TextEdit{visible:!!research.followupAnswer;Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredHeight:contentHeight;text:research.linkedBody(research.followupAnswer);textFormat:TextEdit.RichText;readOnly:true;selectByMouse:true;color:Theme.text;selectionColor:Theme.selectionFill;selectedTextColor:Theme.selectionInk;font.family:Theme.font;font.pixelSize:Theme.body;wrapMode:TextEdit.Wrap;Accessible.name:"Research follow-up answer";onLinkActivated:link=>research.openCitation(link)}
                }
            }
        }
    }
    CDialog{id:renameDialog;accessibleTitle:"Rename research"
        CText{text:"Rename research";font.pixelSize:Theme.section;font.weight:Font.DemiBold}
        CField{id:renameField;Layout.fillWidth:true;placeholderText:"Research title";Accessible.name:"Research title"}
        RowLayout{Layout.fillWidth:true;CButton{text:"Save";primary:true;enabled:renameField.text.trim().length>0;onClicked:{research.updateRun({title:renameField.text.trim()},"Renamed.");renameDialog.close()}} CButton{text:"Cancel";onClicked:renameDialog.close()}}
    }
    CDialog{
        id:handoffDialog;objectName:"researchHandoffDialog";accessibleTitle:"Handoff research";property string error:""
        readonly property var targets:(research.app?.state?.sessions||[]).filter(row=>!row.temporary&&(!research.session.cwd||row.cwd===research.session.cwd)).map(row=>({id:row.id,label:(row.title||"Untitled conversation")+(row.id===research.sessionId?" · current":"")}))
        closePolicy:research.handoffPending?Popup.NoAutoClose:Popup.CloseOnEscape|Popup.CloseOnPressOutside
        onOpened:{if(research.handoffPending)return;error="";handoffMode.currentIndex=targets.length?0:1;handoffTarget.currentIndex=0;handoffProvider.currentIndex=0;handoffTrust.checked=false}
        CText{text:"Handoff research";font.pixelSize:Theme.title;font.weight:Font.DemiBold;Accessible.role:Accessible.Heading}
        CText{Layout.fillWidth:true;text:"Create a planning draft from this report. Review and send it yourself in the destination conversation.";color:Theme.muted;font.pixelSize:Theme.secondary}
        CComboBox{id:handoffMode;objectName:"researchHandoffMode";Layout.fillWidth:true;model:[{label:"Existing conversation",value:"existing"},{label:"New conversation",value:"new"}];textRole:"label";valueRole:"value";Accessible.name:"Handoff destination type"}
        CComboBox{id:handoffTarget;objectName:"researchHandoffTarget";visible:handoffMode.currentValue==="existing";Layout.fillWidth:true;model:handoffDialog.targets;textRole:"label";valueRole:"id";Accessible.name:"Existing destination conversation"}
        CComboBox{id:handoffProvider;objectName:"researchHandoffProvider";visible:handoffMode.currentValue==="new";Layout.fillWidth:true;model:research.handoffRows();textRole:"label";Accessible.name:"New conversation provider and model"}
        CCheckBox{id:handoffTrust;objectName:"researchHandoffTrust";visible:handoffMode.currentValue==="new"&&handoffProvider.currentIndex>=0&&["codex","claude","antigravity"].indexOf(handoffProvider.model[handoffProvider.currentIndex]?.provider)>=0;Layout.fillWidth:true;text:"I trust this project’s CLI configuration and hooks"}
        CText{visible:handoffMode.currentValue==="existing";Layout.fillWidth:true;text:"A destination that already has an unsent draft will not be replaced.";color:Theme.muted;font.pixelSize:Theme.caption}
        CText{visible:!!handoffDialog.error;Layout.fillWidth:true;text:handoffDialog.error;color:Theme.danger;font.pixelSize:Theme.secondary}
        RowLayout{Layout.fillWidth:true
            CButton{text:"Cancel";Layout.fillWidth:true;enabled:!research.handoffPending;onClicked:handoffDialog.close()}
            CButton{objectName:"researchHandoffCreate";text:research.handoffPending?"Creating…":"Create review draft";primary:true;Layout.fillWidth:true;enabled:!research.handoffPending&&(handoffMode.currentValue==="existing"?!!handoffTarget.currentValue:handoffProvider.currentIndex>=0&&(!handoffTrust.visible||handoffTrust.checked));onClicked:research.handoff()}
        }
    }
}
