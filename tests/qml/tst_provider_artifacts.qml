import QtQuick
import QtTest
import "../../qml" as PAL

Item {
    id: scene
    width: 750; height: 780
    QtObject {
        id: broker
        property bool connected: true
        property var state: ({providerTraits:{xai:{label:"Grok (xAI)"}}})
        property var calls: []
        signal result(int id, var value)
        function rpc(method, params) { calls = calls.concat([{method:method,params:params}]); return calls.length }
        function answer(method, response) {
            const i=calls.findIndex(call => call.method===method)
            if (i>=0) result(i+1,response)
            return i
        }
    }
    Component { id: actionComponent; PAL.ProviderArtifactActions { app: broker; sessionId:"session"; artifact:({artifactId:"pdf",versionId:"v1",name:"Review.pdf"}); version:({mime:"application/pdf"}) } }
    SignalSpy { id: attached; signalName: "originalSelected" }
    TestCase {
        name: "ProviderArtifactReview"
        when: windowShown
        function test_reviewConsentIsolationAndOcrDestination() {
            broker.calls=[]
            const item=createTemporaryObject(actionComponent,scene)
            verify(item); attached.target=item; attached.clear(); item.clicked()
            const dialog=findChild(item,"providerArtifactDialog")
            verify(dialog); tryCompare(dialog,"opened",true)
            verify(broker.answer("providerInference.context",{provider:"xai",sessionRevision:"s2",projectRevision:"p1",connectionId:"xai-acct",connectionName:"Grok Work",connectionRevision:3,originalPdf:true,tasks:["text-classification"],accounts:[{id:"mistral-acct",kind:"mistral",name:"Mistral Work",revision:5}]})>=0)
            const handle={id:"file",versionId:"v1",name:"Review.pdf",provider:"xai",state:"ready",connectionId:"xai-acct",revision:3}
            verify(broker.answer("originalFiles.list",[handle,Object.assign({},handle,{id:"other",connectionId:"other-account"})])>=0)
            const upload=findChild(dialog,"originalUpload"), run=findChild(dialog,"inferenceRun")
            verify(upload); verify(run); compare(upload.enabled,false); compare(run.enabled,false)
            findChild(dialog,"inferenceConsent").checked=true
            tryCompare(run,"enabled",true); run.clicked()
            const i=broker.answer("providerInference.mistralOcr",{artifact:{artifactId:"ocr",versionId:"result"}})
            verify(i>=0); const p=broker.calls[i].params
            compare(p.source.versionId,"v1"); compare(p.connectionId,"mistral-acct"); compare(p.connectionRevision,5)
            compare(p.expectedProjectRevision,"p1"); compare(p.expectedSessionRevision,"s2")
            const handles=findChild(dialog,"providerFileHandles"); tryCompare(handles,"count",2)
            const correct=findChild(handles.itemAt(0),"originalAttach_file"), other=findChild(handles.itemAt(1),"originalAttach_other")
            verify(correct); verify(other); compare(other.enabled,false); compare(correct.enabled,true)
            correct.clicked(); compare(attached.count,1); compare(attached.signalArguments[0][0].id,"file")
            compare(broker.calls.some(call=>call.method==="originalFiles.upload"),false)
        }
    }
}
