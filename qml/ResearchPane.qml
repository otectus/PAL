import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Workbench › Research: plan and steer a bounded run, inspect its evidence, and keep the cited result.
Item {
    id: research
    objectName: "researchPane"
    implicitHeight: Theme.editorLarge
    property string sessionId: ""
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
    readonly property bool narrow: width < Theme.wideToolbar
    readonly property var session: App.session || ({})
    readonly property bool supportedSession: session.id === sessionId && !session.temporary && ["ollama", "openai", "anthropic", "google", "compatible"].indexOf(session.provider || "") >= 0 && (!session.remote || session.remote.role === "owner")
    readonly property bool webEnabled: App.state.settings?.webSearch?.enabled === true
    readonly property bool working: !!selectedRun && ["planning", "searching", "reading", "synthesizing"].indexOf(selectedRun.state) >= 0
    readonly property bool paused: !!selectedRun && selectedRun.state === "paused"
    readonly property var visibleRuns: runs.filter(run => {
        if (!includeArchived && run.archived) return false
        const needle = librarySearch.text.trim().toLowerCase()
        return !needle || [run.title, run.question, run.summary, run.state].some(value => String(value || "").toLowerCase().indexOf(needle) >= 0)
    }).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(b.updated || b.created || 0) - Number(a.updated || a.created || 0))
    readonly property var reportSections: splitReport(reportText)
    signal settingsRequested(string category, string target)

    RpcClient { id: rpc; scope: research.sessionId }
    function fail(value) { error = value?.error || "Research could not complete that action."; notice = "" }
    function stateLabel(state) { return ({planning:"Planning",searching:"Searching",reading:"Reading",synthesizing:"Writing",paused:"Paused",completed:"Complete",partial:"Partial",stopped:"Finished early",failed:"Failed"})[state] || state || "Saved" }
    function progressLabel(run) { return run ? String(run.progress || stateLabel(run.state)) : "" }
    function asArray(value) { const result=[];for(const row of value||[])result.push(row);return result }
    function lines(text) { return String(text || "").split(/\n+/).map(value => value.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, 12) }
    function commaList(text) { return String(text || "").split(/[\n,]+/).map(value => value.trim()).filter(Boolean) }
    function flattenRows(rows) { const result=[];for(const row of rows||[])for(const cell of row||[])result.push(cell);return result }
    function toggleSource(id) { const next=chosenSourceIds.slice(), index=next.indexOf(id); if(index>=0)next.splice(index,1);else next.push(id);chosenSourceIds=next }
    function reload() {
        if (!sessionId) return
        const owner=sessionId,token=++listLoadToken
        rpc.call("research.list", {sessionId:sessionId,project:true}, value => {
            if(token!==listLoadToken||owner!==sessionId)return
            if(value.error){fail(value);return} runs=asArray(value)
            if(selectedId){if(!runs.some(run=>run.id===selectedId))clearSelection();else if(!historicalVersion)loadRun(selectedId,false,"",true)}
        })
    }
    function loadSources(query) {
        if (!sessionId) return
        const owner=sessionId,token=++sourceLoadToken,params={sessionId:sessionId};if(query)params.query=query
        rpc.call("research.sources",params,value=>{if(token!==sourceLoadToken||owner!==sessionId)return;if(value.error){fail(value);return}projectSources=asArray(value)})
    }
    function clearSelection(){runLoadToken++;reportLoadToken++;selectedId="";selectedRun=null;reportText="";selectedPassage=null;followupAnswer="";historicalVersion=""}
    function loadRun(id,readReport,versionId,passive){
        if(!id)return
        const token=++runLoadToken;selectedId=id
        if(!passive){currentView="report";scroll.contentY=0;selectedPassage=null;followupAnswer="";historicalVersion=versionId||""}
        rpc.call("research.get",{id:id},value=>{
            if(value.error){if(token===runLoadToken)fail(value);return}
            if(token!==runLoadToken||selectedId!==id)return
            selectedRun=value
            if(!historicalVersion)reportText=value.reportText||""
            error=""
            if(versionId)readReportVersion(versionId);else if(!passive&&(readReport===true||(!reportText&&["completed","partial","stopped"].indexOf(value.state)>=0)))readReportVersion("")
        })
    }
    function acceptWorkbenchSelection(){const selection=WorkbenchState.researchFor(sessionId);if(selection.id)loadRun(selection.id,false,selection.versionId)}
    function readReportVersion(versionId){const id=selectedId,token=++reportLoadToken,params={id:id};historicalVersion=versionId||"";if(versionId)params.versionId=versionId;rpc.call("research.readReport",params,value=>{if(token!==reportLoadToken||id!==selectedId)return;if(value.error){fail(value);return}reportText=value.text||"";selectedRun=Object.assign({},selectedRun,value.evidence?{evidence:value.evidence}:{},value.findings?{findings:value.findings}:{},value.table?{table:value.table}:{});selectedPassage=null;error=""})}
    function generatePlan(){rpc.call("research.plan",{sessionId:sessionId,question:question.text.trim(),mode:mode.currentValue},value=>{if(value.error){fail(value);return}planField.text=(value.plan||[]).join("\n");planSection.expanded=true;notice="Plan ready to edit."})}
    function start(){
        const sites=commaList(siteField.text).slice(0,5),urls=commaList(urlField.text),plan=lines(planField.text),criteria=lines(criteriaField.text)
        const params={sessionId:sessionId,question:question.text.trim(),preset:depth.currentValue,mode:mode.currentValue,scope:scope.currentValue,sourceIds:scope.currentValue==="web"?[]:chosenSourceIds.slice(),minutes:minutes.value,sources:sourceLimit.value,calls:callLimit.value,output:outputShape.currentValue}
        if(depth.currentValue==="thorough"&&parallelCheck.checked)params.parallel=true;if(plan.length)params.plan=plan;if(scope.currentValue!=="project"){if(sites.length){params.sites=sites;params.siteMode=siteMode.currentValue}if(urls.length)params.urls=urls;if(recency.currentValue)params.recency=recency.currentValue}if(criteria.length)params.criteria=criteria
        rpc.call("research.start",params,value=>{if(value.error){fail(value);return}runLoadToken++;reportLoadToken++;historicalVersion="";error="";notice="Research started.";selectedId=value.id;selectedRun=value;reportText="";selectedPassage=null;followupAnswer="";currentView="report";scroll.contentY=0;reload()})
    }
    function runAction(method,params,message){rpc.call(method,params,value=>{if(value.error){fail(value);return}error="";notice=message||"Updated.";if(selectedId&&!historicalVersion)loadRun(selectedId,false,"",true);reload()})}
    function updateRun(change,message){if(selectedId)runAction("research.update",Object.assign({id:selectedId},change),message)}
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

    Timer{interval:1500;repeat:true;running:research.visible&&(research.working||research.runs.some(run=>["planning","searching","reading","synthesizing"].indexOf(run.state)>=0));onTriggered:research.reload()}
    onSessionIdChanged:{listLoadToken++;sourceLoadToken++;runs=[];projectSources=[];chosenSourceIds=[];clearSelection();reload();loadSources("");acceptWorkbenchSelection()}
    Component.onCompleted:{reload();loadSources("");acceptWorkbenchSelection()}
    Connections{target:WorkbenchState;function onResearchSelectionsChanged(){research.acceptWorkbenchSelection()}}

    Flickable{
        id:scroll;anchors.fill:parent;clip:true;contentWidth:width;contentHeight:content.implicitHeight+Theme.space2;boundsBehavior:Flickable.StopAtBounds;flickableDirection:Flickable.VerticalFlick
        ScrollBar.vertical:CScrollBar{}
        ColumnLayout{
            id:content;width:Math.max(0,scroll.width-(scroll.contentHeight>scroll.height?Theme.minimumTarget:0));spacing:Theme.space2
            RowLayout{Layout.fillWidth:true;spacing:Theme.space1
                CButton{objectName:"researchViewNew";Layout.fillWidth:true;leftPadding:Theme.space1;rightPadding:Theme.space1;text:"New";primary:research.currentView==="new";onClicked:{research.currentView="new";scroll.contentY=0}}
                CButton{objectName:"researchViewLibrary";Layout.fillWidth:true;leftPadding:Theme.space1;rightPadding:Theme.space1;text:research.narrow?"Saved":"Library";primary:research.currentView==="library";onClicked:{research.currentView="library";scroll.contentY=0}}
                CButton{objectName:"researchViewReport";Layout.fillWidth:true;leftPadding:Theme.space1;rightPadding:Theme.space1;text:"Report";primary:research.currentView==="report";enabled:!!research.selectedRun;onClicked:{research.currentView="report";scroll.contentY=0}}
            }

            ColumnLayout{visible:research.currentView==="new";Layout.fillWidth:true;spacing:Theme.space2
                CTextArea{id:question;objectName:"researchQuestion";Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"What should PAL investigate?";Accessible.name:"Research question"}
                CText{Layout.fillWidth:true;color:Theme.muted;font.pixelSize:Theme.caption;text:"Plan a bounded run, watch what PAL reads, then keep the cited report with this project."}
                CText{visible:!research.supportedSession;Layout.fillWidth:true;color:Theme.amber;font.pixelSize:Theme.caption;text:session.temporary?"Save this conversation before starting research.":session.remote&&session.remote.role!=="owner"?"Research can only start from an owner-controlled conversation.":"Research needs an Ollama or managed API conversation."}
                GridLayout{visible:scope.currentValue!=="project"&&!research.webEnabled;Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                    CText{Layout.fillWidth:true;text:"Web search is off. Choose Project only or enable web search.";color:Theme.amber;font.pixelSize:Theme.caption}
                    CButton{Layout.fillWidth:research.narrow;text:"Web search settings";quiet:true;onClicked:research.settingsRequested("knowledge","webSearchEnabled")}
                }
                GridLayout{Layout.fillWidth:true;columns:research.width<Theme.formBreakpoint?1:3;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                    CComboBox{id:scope;objectName:"researchScope";Layout.fillWidth:true;model:[{label:"Web only",value:"web"},{label:"Web + project",value:"both"},{label:"Project only",value:"project"}];textRole:"label";valueRole:"value";Accessible.name:"Research scope"}
                    CComboBox{id:depth;objectName:"researchDepth";Layout.fillWidth:true;model:[{label:"Quick",value:"quick"},{label:"Thorough",value:"thorough"}];textRole:"label";valueRole:"value";Accessible.name:"Research depth";onCurrentValueChanged:{if(currentValue==="thorough"){minutes.value=20;sourceLimit.value=40;callLimit.value=10}else{minutes.value=5;sourceLimit.value=12;callLimit.value=3;parallelCheck.checked=false}}}
                    CComboBox{id:mode;objectName:"researchMode";Layout.fillWidth:true;model:[{label:"Answer",value:"answer"},{label:"Compare",value:"compare"},{label:"Fact check",value:"check"},{label:"Literature review",value:"literature"}];textRole:"label";valueRole:"value";Accessible.name:"Research mode";onActivated:outputShape.currentIndex=currentValue==="compare"?2:0}
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
                    CButton{id:quick;objectName:"researchQuick";text:depth.currentValue==="thorough"?"Start thorough research":"Start research";primary:true;enabled:research.supportedSession&&question.text.trim().length>=5&&(scope.currentValue==="project"||research.webEnabled)&&(scope.currentValue==="web"||chosenSourceIds.length>0);help:!research.supportedSession?"Use a saved owner-controlled Ollama or managed API conversation":scope.currentValue!=="web"&&chosenSourceIds.length===0?"Choose at least one project source":"Start this bounded research run";onClicked:research.start()}
                    CText{text:minutes.value+" min · "+sourceLimit.value+" sources · "+callLimit.value+" calls";color:Theme.muted;font.pixelSize:Theme.caption;verticalAlignment:Text.AlignVCenter}
                }
                CText{visible:!!research.error;Layout.fillWidth:true;text:research.error;color:Theme.danger;font.pixelSize:Theme.caption}
                CText{visible:!!research.notice&&!research.error;Layout.fillWidth:true;text:research.notice;color:Theme.success;font.pixelSize:Theme.caption}
                CSection{id:planSection;title:"Advanced plan, limits, and web options";hint:"optional";expanded:false
                    Flow{Layout.fillWidth:true;spacing:Theme.space1
                        CButton{text:"Generate plan";implicitHeight:Theme.compactHeight;enabled:question.text.trim().length>=5;onClicked:research.generatePlan()}
                        CText{text:"Edit the outline before starting.";color:Theme.muted;font.pixelSize:Theme.caption;verticalAlignment:Text.AlignVCenter}
                    }
                    CTextArea{id:planField;objectName:"researchPlan";Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"One planned step per line (up to 12)";Accessible.name:"Editable research plan"}
                    CTextArea{id:criteriaField;Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"One success criterion per line (up to 12)";Accessible.name:"Research success criteria"}
                    CCheckBox{id:parallelCheck;visible:depth.currentValue==="thorough";Layout.fillWidth:true;text:"Parallel subquestions (uses more model calls)";checked:false}
                    GridLayout{Layout.fillWidth:true;columns:research.width<Theme.formBreakpoint?2:6;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                        CText{text:"Minutes";color:Theme.muted;font.pixelSize:Theme.caption} CSpinBox{id:minutes;objectName:"researchMinutes";Layout.fillWidth:true;from:1;to:60;value:5;Accessible.name:"Minute limit"}
                        CText{text:"Sources";color:Theme.muted;font.pixelSize:Theme.caption} CSpinBox{id:sourceLimit;objectName:"researchSourcesLimit";Layout.fillWidth:true;from:1;to:60;value:12;Accessible.name:"Source limit"}
                        CText{text:"Calls";color:Theme.muted;font.pixelSize:Theme.caption} CSpinBox{id:callLimit;objectName:"researchCalls";Layout.fillWidth:true;from:2;to:20;value:3;Accessible.name:"Model and search call limit"}
                    }
                    GridLayout{visible:scope.currentValue!=="project";Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                        CField{id:siteField;objectName:"researchSites";Layout.fillWidth:true;placeholderText:"Preferred sites (up to 5)";Accessible.name:"Preferred research sites"}
                        CComboBox{id:recency;objectName:"researchRecency";Layout.fillWidth:true;model:[{label:"Any date",value:""},{label:"Past day",value:"day"},{label:"Past week",value:"week"},{label:"Past month",value:"month"},{label:"Past year",value:"year"}];textRole:"label";valueRole:"value";Accessible.name:"Source recency"}
                        CComboBox{id:siteMode;Layout.fillWidth:true;model:[{label:"Prefer these sites",value:"prefer"},{label:"Only these sites",value:"only"}];textRole:"label";valueRole:"value";Accessible.name:"Preferred site behavior"}
                        CComboBox{id:outputShape;Layout.fillWidth:true;model:[{label:"Brief report",value:"brief"},{label:"Timeline",value:"timeline"},{label:"Comparison matrix",value:"matrix"}];textRole:"label";valueRole:"value";Accessible.name:"Research output shape"}
                        CField{id:urlField;Layout.fillWidth:true;Layout.columnSpan:research.narrow?1:2;placeholderText:"Seed URLs, separated by commas (optional)";Accessible.name:"Seed URLs"}
                    }
                }
            }

            ColumnLayout{visible:research.currentView==="library";Layout.fillWidth:true;spacing:Theme.space2
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
                            CButton{text:modelData.pinned?"Unpin":"Pin";quiet:true;implicitHeight:Theme.compactHeight;onClicked:{selectedId=modelData.id;research.updateRun({pinned:!modelData.pinned},modelData.pinned?"Unpinned.":"Pinned.")}}
                            CButton{text:modelData.archived?"Restore":"Archive";quiet:true;implicitHeight:Theme.compactHeight;onClicked:{selectedId=modelData.id;research.updateRun({archived:!modelData.archived},modelData.archived?"Restored.":"Archived.")}}
                        }
                    }
                }
            }

            ColumnLayout{visible:research.currentView==="report"&&!!research.selectedRun;Layout.fillWidth:true;spacing:Theme.space2
                GridLayout{Layout.fillWidth:true;columns:research.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
                    ColumnLayout{Layout.fillWidth:true;spacing:Theme.space1
                        CText{Layout.fillWidth:true;text:selectedRun?selectedRun.title||selectedRun.question||"Research":"";font.pixelSize:Theme.section;font.weight:Font.DemiBold}
                        CText{Layout.fillWidth:true;text:selectedRun?research.stateLabel(selectedRun.state)+(selectedRun.summary?" · "+selectedRun.summary:""):"";color:selectedRun?.stale?Theme.amber:Theme.muted;font.pixelSize:Theme.caption}
                    }
                    Flow{Layout.fillWidth:research.narrow;Layout.alignment:Qt.AlignRight;spacing:Theme.space1
                        CButton{visible:research.working;text:"Pause";implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.pause",{id:selectedId},"Paused.")}
                        CButton{visible:research.working||research.paused;text:"Finish now";danger:true;implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.stop",{id:selectedId},"Finishing from collected evidence.")}
                        CButton{visible:!research.working;text:"Rename";implicitHeight:Theme.compactHeight;onClicked:{renameField.text=selectedRun.title||selectedRun.question||"";renameDialog.open()}}
                        CButton{visible:selectedRun?.stale||["completed","partial","stopped"].indexOf(selectedRun?.state)>=0;text:"Refresh";implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.refresh",{id:selectedId},"Refresh started.")}
                    }
                }
                Rectangle{visible:research.working||research.paused;Layout.fillWidth:true;implicitHeight:runProgress.implicitHeight+Theme.space4;color:Theme.surface;radius:Theme.radiusControl;border.color:Theme.border
                    ColumnLayout{id:runProgress;x:Theme.space2;y:Theme.space2;width:Math.max(0,parent.width-Theme.space4);spacing:Theme.space1
                        CText{Layout.fillWidth:true;text:research.progressLabel(selectedRun);font.weight:Font.DemiBold}
                        ProgressBar{Layout.fillWidth:true;indeterminate:research.working;Accessible.name:"Research is active"}
                        Repeater{model:(selectedRun?.activity||[]).slice(-8);CText{required property var modelData;Layout.fillWidth:true;text:(modelData.time?new Date(modelData.time).toLocaleTimeString(Qt.locale(),Locale.ShortFormat)+" · ":"")+modelData.text;color:Theme.muted;font.pixelSize:Theme.caption}}
                    }
                }
                CSection{visible:research.working||research.paused||selectedRun?.state==="stopped";title:"Steer or continue";expanded:research.working||research.paused
                    CField{id:steerField;objectName:"researchSteer";Layout.fillWidth:true;placeholderText:"Focus on a question, source, or angle";Accessible.name:"Research steering instruction"}
                    Flow{Layout.fillWidth:true;spacing:Theme.space1
                        CButton{visible:research.working;text:"Steer current run";enabled:steerField.text.trim().length>0;onClicked:{research.runAction("research.steer",{id:selectedId,focus:steerField.text.trim()},"Steering updated.");steerField.text=""}}
                        CButton{visible:!research.working;text:"Continue research";primary:true;onClicked:{const params={id:selectedId};if(steerField.text.trim())params.focus=steerField.text.trim();research.runAction("research.continue",params,"Research continued.");steerField.text=""}}
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
                        CSpinBox{id:monitorDays;Layout.fillWidth:true;from:0;to:365;value:selectedRun?.monitorDays||0;Accessible.name:"Monitor interval in days"}
                        CButton{Layout.fillWidth:research.narrow;text:monitorDays.value?"Monitor every "+monitorDays.value+" days":"Turn monitoring off";onClicked:research.updateRun({monitorDays:monitorDays.value},monitorDays.value?"Monitoring scheduled.":"Monitoring turned off.")}
                        CButton{Layout.fillWidth:research.narrow;text:"Refresh now";onClicked:research.runAction("research.refresh",{id:selectedId},"Refresh started.")}
                    }
                    Flow{visible:(selectedRun?.revisions||[]).length>0;Layout.fillWidth:true;spacing:Theme.space1
                        CButton{text:"Current report";primary:!research.historicalVersion;implicitHeight:Theme.compactHeight;onClicked:research.loadRun(selectedId,true,"",false)}
                        Repeater{model:selectedRun?.revisions||[];CButton{required property var modelData;text:modelData.summary||(modelData.time?new Date(modelData.time).toLocaleString(Qt.locale(),Locale.ShortFormat):"Revision");primary:research.historicalVersion===modelData.versionId;implicitHeight:Theme.compactHeight;onClicked:research.readReportVersion(modelData.versionId)}}
                    }
                    Flow{Layout.fillWidth:true;spacing:Theme.space1;Repeater{model:[{label:"Markdown",format:"markdown"},{label:"CSV",format:"csv"},{label:"BibTeX",format:"bibtex"},{label:"JSON",format:"json"}];CButton{required property var modelData;text:"Export "+modelData.label;implicitHeight:Theme.compactHeight;onClicked:research.runAction("research.export",{id:selectedId,format:modelData.format},modelData.label+" added to this conversation.")}}}
                    CTextArea{id:noteField;objectName:"researchNote";Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"Add a note to this research run";Accessible.name:"Research note"}
                    CButton{text:"Save note";enabled:noteField.text.trim().length>0;onClicked:{research.runAction("research.note",{id:selectedId,text:noteField.text.trim()},"Note saved.");noteField.text=""}}
                }
                CSection{visible:!!research.reportText;title:"Ask a follow-up";expanded:false
                    CField{id:followupField;objectName:"researchFollowup";Layout.fillWidth:true;placeholderText:"Ask about this report";Accessible.name:"Research follow-up question"}
                    CButton{text:"Ask from this research";primary:true;enabled:followupField.text.trim().length>0;onClicked:{const asked=followupField.text.trim();rpc.call("research.ask",{id:selectedId,question:asked},value=>{if(value.error)research.fail(value);else{research.error="";research.followupAnswer=value.answer||"";research.loadRun(selectedId,false,"",true)}});followupField.text=""}}
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
}
