import QtQuick
import QtTest
import "../../qml" as PAL

Item {
    id: scene
    width: 900; height: 700; visible: true
    QtObject {
        id: broker
        property bool connected: true
        property int nextId: 0
        property var calls: ({})
        property var session: ({id:"session-a",title:"Owner",cwd:"/project",provider:"ollama",model:"owner-model",temporary:false})
        property var state: ({settings:{webSearch:{enabled:true}},sessions:[session,{id:"session-b",title:"Target",cwd:"/project",provider:"ollama",model:"target-model",temporary:false}]})
        signal result(int id, var value)
        function rpc(method, params) { const id=++nextId,next=Object.assign({},calls);next[id]={method:method,params:params};calls=next;return id }
        function reply(id, value) { result(id,value) }
        function idFor(method, occurrence) { let found=0;for(const id of Object.keys(calls))if(calls[id].method===method&&++found===(occurrence||1))return Number(id);return -1 }
        function reset() { nextId=0;calls=({}) }
    }
    Component { id:tasksComponent;PAL.ResearchTasks { app:broker } }
    Component { id:taskListComponent; PAL.ResearchTaskList { width:800; height:600 } }
    Component { id:paneComponent;PAL.ResearchPane { app:broker;width:800;height:650;sessionId:"session-a" } }
    SignalSpy { id:taskSpy;signalName:"taskRequested" }
    SignalSpy { id:draftSpy;signalName:"draftRequested" }

    TestCase {
        name:"ResearchDesktop"
        when:windowShown
        property var subject:null
        function init(){broker.reset();PAL.WorkbenchState.selectResearch("session-a","","");taskSpy.clear();draftSpy.clear()}
        function cleanup(){if(subject)subject.destroy();subject=null;taskSpy.target=null;draftSpy.target=null}
        function task(id,state){return{id:id,sessionId:"session-b",owner:"Target",title:"Background research",provider:"openai",model:"gpt-fixture",state:state,progress:"Reading 2 of 4",updated:2}}

        function test_globalMonitorCancelAndOpenOwner(){
            subject=createTemporaryObject(tasksComponent,scene); verify(subject)
            tryVerify(()=>broker.idFor("research.tasks")>0)
            broker.reply(broker.idFor("research.tasks"),[task("run-1","searching")])
            const list=createTemporaryObject(taskListComponent,scene,{monitor:subject})
            verify(list); taskSpy.target=list
            tryCompare(subject,"activeCount",1)
            const open=findChild(list,"researchTaskOpen_run-1"),cancel=findChild(list,"researchTaskCancel_run-1")
            verify(open); verify(cancel); open.clicked()
            compare(taskSpy.count,1); compare(taskSpy.signalArguments[0][0],"session-b"); compare(taskSpy.signalArguments[0][1],"run-1")
            cancel.clicked()
            const cancelId=broker.idFor("research.cancel"); verify(cancelId>0); compare(broker.calls[cancelId].params.id,"run-1")
            verify(!cancel.enabled)
            broker.reply(cancelId,task("run-1","cancelled"))
            const reload=broker.idFor("research.tasks",2);verify(reload>0)
            broker.reply(reload,[task("run-1","cancelled")]); tryCompare(subject,"activeCount",0)
        }

        function answerInitialPaneCalls(route){
            const routes=broker.idFor("research.routes"),list=broker.idFor("research.list"),sources=broker.idFor("research.sources")
            verify(routes>0);verify(list>0);verify(sources>0)
            broker.reply(routes,[route||{provider:"openai",model:"gpt-route",connectionId:"11111111-1111-4111-8111-111111111111",label:"OpenAI connection · gpt-route"}])
            broker.reply(list,[]);broker.reply(sources,[{id:"source-1",title:"Fixture note",kind:"note"}])
        }
        function test_startHasStableIdentityAndRestoresSelection(){
            subject=createTemporaryObject(paneComponent,scene);verify(subject);answerInitialPaneCalls()
            const scope=findChild(subject,"researchScope"),question=findChild(subject,"researchQuestion");verify(scope);verify(question)
            scope.currentIndex=2;scope.activated(2);subject.toggleSource("source-1");question.text="What does the fixture establish?";tryCompare(subject,"supportedSession",true)
            const start=findChild(subject,"researchQuick");tryVerify(()=>start.enabled);subject.start();verify(!start.enabled)
            const id=broker.idFor("research.start");verify(id>0);const params=broker.calls[id].params
            verify(params.requestId.length>10);compare(params.provider,"openai");compare(params.model,"gpt-route");compare(params.connectionId,"11111111-1111-4111-8111-111111111111")
            subject.start();compare(broker.idFor("research.start",2),-1)
            broker.reply(id,{id:"run-started",sessionId:"session-a",state:"planning",provider:"openai",model:"gpt-route",question:question.text})
            tryCompare(subject,"selectedId","run-started");compare(PAL.WorkbenchState.researchFor("session-a").id,"run-started");compare(broker.idFor("research.get"),-1)
        }
        function test_routeWithoutCatalogAcceptsReviewedModelId(){
            subject=createTemporaryObject(paneComponent,scene);verify(subject);answerInitialPaneCalls({provider:"compatible",model:"",connectionId:"22222222-2222-4222-8222-222222222222",label:"Lab endpoint · Enter model ID"})
            const model=findChild(subject,"researchRouteModel"),scope=findChild(subject,"researchScope"),question=findChild(subject,"researchQuestion");verify(model);tryVerify(()=>model.visible);model.text="lab-chat-v2"
            scope.currentIndex=2;scope.activated(2);subject.toggleSource("source-1");question.text="Plan from the configured endpoint";tryCompare(subject,"supportedSession",true);subject.start()
            const id=broker.idFor("research.start");verify(id>0);compare(broker.calls[id].params.provider,"compatible");compare(broker.calls[id].params.model,"lab-chat-v2");compare(broker.calls[id].params.connectionId,"22222222-2222-4222-8222-222222222222")
        }
        function test_handoffOpensSavedDestinationOnce(){
            subject=createTemporaryObject(paneComponent,scene);verify(subject);draftSpy.target=subject;answerInitialPaneCalls()
            subject.selectedId="run-finished";subject.selectedRun={id:"run-finished",sessionId:"session-a",state:"completed",report:{artifactId:"a",versionId:"v"},provider:"openai",model:"gpt-route",stale:false};subject.currentView="report"
            const open=findChild(subject,"researchHandoff");tryVerify(()=>open.visible);open.clicked();const dialog=findChild(subject,"researchHandoffDialog");verify(dialog);tryCompare(dialog,"opened",true)
            const mode=findChild(subject,"researchHandoffMode"),provider=findChild(subject,"researchHandoffProvider"),create=findChild(subject,"researchHandoffCreate");verify(mode);verify(provider);verify(create)
            mode.currentIndex=1;provider.currentIndex=3;tryVerify(()=>create.enabled);create.clicked();verify(!create.enabled)
            const id=broker.idFor("research.handoff");verify(id>0);compare(broker.calls[id].params.provider,"openai");compare(broker.calls[id].params.model,"gpt-route");compare(broker.calls[id].params.connectionId,"11111111-1111-4111-8111-111111111111");verify(broker.calls[id].params.trusted===undefined)
            subject.handoff();compare(broker.idFor("research.handoff",2),-1)
            broker.reply(id,{sessionId:"session-new",draft:"Review this planning draft"});tryCompare(draftSpy,"count",1);compare(draftSpy.signalArguments[0][0],"session-new")
        }
        function test_finishEarlyUsesTheSelectedRun() {
            subject = createTemporaryObject(paneComponent, scene)
            verify(subject)
            answerInitialPaneCalls()
            subject.selectedId = "run-paused"
            subject.selectedRun = {id:"run-paused", sessionId:"session-a", state:"paused"}
            subject.showView("report")
            const finish = findChild(subject, "researchFinishEarly")
            tryVerify(() => finish.visible)
            finish.clicked()
            const stop = broker.idFor("research.stop")
            verify(stop > 0)
            compare(broker.calls[stop].params.id, "run-paused")
            subject.selectedRun = {id:"run-paused", sessionId:"session-a", state:"stopped"}
            tryVerify(() => !finish.visible)
        }
        function test_pageSelectionTransitionsClearStaleReport(){
            subject=createTemporaryObject(paneComponent,scene);verify(subject);subject.pageMode=true;answerInitialPaneCalls()
            subject.currentView="library";subject.selectedId="run-a";subject.selectedRun={id:"run-a",state:"completed",title:"First run"};subject.historicalVersion="version-1";subject.reportText="Old historical report"

            PAL.WorkbenchState.selectResearch("session-a","run-a","")
            compare(subject.currentView,"library");compare(subject.historicalVersion,"");compare(subject.reportText,"")
            const latest=broker.idFor("research.get");verify(latest>0)
            broker.reply(latest,{id:"run-a",state:"completed",title:"First run",reportText:"Latest report"})
            tryCompare(subject,"reportText","Latest report")

            PAL.WorkbenchState.selectResearch("session-a","run-b","")
            compare(subject.currentView,"library");compare(subject.selectedId,"run-b");compare(subject.selectedRun,null);compare(subject.reportText,"")
            const other=broker.idFor("research.get",2);verify(other>0)
            broker.reply(other,{id:"run-b",state:"completed",title:"Second run",reportText:"Second report"})
            tryCompare(subject,"reportText","Second report")

            subject.showView("report");subject.reload()
            const missing=broker.idFor("research.list",2);verify(missing>0);broker.reply(missing,[])
            tryCompare(subject,"selectedId","");compare(subject.currentView,"library")
        }
    }
}
