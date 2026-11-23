import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: root
    required property string sessionId
    signal inspectRequested(string recordId)
    property int offset: 0
    property var page: ({rows:[]})
    property var summary: ({})
    property var preview: null
    property var forecast: null
    property var held: []
    property string cursor: ""
    property string feedback: ""
    property var selected: null
    property var detail: null
    function openJob(row) {
        selected=row;detail=null;noteEditor.visible=false;noteEditor.text=""
        send("memory.curation.details",{job_id:row.id},r=>{if(selected?.id===row.id)detail=r})
    }
    property bool busy: false
    property int generation: 0
    RpcClient { id: rpc }
    function send(method, args, done) {
        if (!sessionId) return
        const g=generation
        busy=true
        rpc.call(method,Object.assign({sessionId:sessionId},args||{}),r=>{
            if(g!==generation)return
            busy=false
            if(r.error){feedback=String(r.error.message||r.error);return}
            done(r)
        })
    }
    function reload(){
        selected=null
        preview=null
        if(!sessionId)return
        send("memory.curation.status",{},s=>{
            summary=s
            send("memory.curation.list",{offset:offset,limit:10,state:filter.currentValue?.startsWith("auto_")?"applied":filter.currentValue||"",actor:filter.currentValue?.startsWith("auto_")?"automatic":"",action:filter.currentValue?.startsWith("auto_")?filter.currentValue.slice(5):""},r=>page=r)
        })
    }
    function changed(r){feedback=r.cancelled?"Review cancelled.":r.undone?"Decision undone.":"Review updated.";reload()}
    function previewRetention(next){send("memory.retention.preview",{limit:25,cursor:next||"",reason:"review_grace"},r=>{forecast=r;cursor=next||""})}
    function deadline(us){return us?new Date(us/1000).toLocaleString():"No scheduled expiry"}
    onSessionIdChanged:{generation++;busy=false;page=({rows:[]});forecast=null;held=[];summary=({});feedback="";offset=0;reload()}
    CText { text:"Model review";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted
        text:root.summary.profile ? ("Mode · "+root.summary.profile.mode+"    "+(root.summary.queue||[]).map(g=>g.count+" "+g.state.replace(/_/g," ")).join(" · ")+"\nToday · "+root.summary.usage.requests+" requests, "+root.summary.usage.input_tokens+" input and "+root.summary.usage.output_tokens+" output tokens used or reserved. "+(root.summary.usage.cost_micros===null?"Cost unknown.":"Estimated cost "+(root.summary.usage.cost_micros/1000000).toFixed(6)+" at configured prices.")) : "" }
    Flow {
        Layout.fillWidth:true;spacing:Theme.space2
        CButton { text:"Refresh review";enabled:!root.busy;onClicked:root.reload() }
        CButton { text:"Review existing memory";enabled:!root.busy;onClicked:root.send("memory.curation.preview",{limit:25},r=>root.preview=r) }
        CButton { text:"Expiring memories";enabled:!root.busy;onClicked:root.previewRetention("") }
    }
    ColumnLayout {
        visible:root.preview!==null;Layout.fillWidth:true
        CText { text:(root.preview?.count||0)+" eligible versions selected for assessment";wrapMode:Text.Wrap }
        CButton { text:"Queue this selection";enabled:!root.busy && (root.preview?.count||0)>0 && root.summary.profile?.mode!=="off";onClicked:root.send("memory.curation.run",{selection:root.preview.selection,ids:root.preview.rows.map(r=>r.version_id),limit:25},r=>{root.feedback="Queued "+r.queued+" memories.";root.reload()}) }
    }
    ColumnLayout {
        visible:root.forecast!==null;Layout.fillWidth:true
        CText { text:root.forecast?(root.forecast.counts.at_risk+" at risk · "+root.forecast.counts.already_protected+" already protected · "+root.forecast.counts.eligible+" eligible on this page"):"";wrapMode:Text.Wrap }
        CText { visible:!!root.forecast;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted
            text:root.forecast?("As of "+root.deadline(root.forecast.generated_at_us)+" · "+root.forecast.timezone+" · policy "+root.forecast.policy_epoch+(root.forecast.projection_incomplete?" · Projection updates pending":"")):"" }
        Repeater {
            model:root.forecast?.items||[]
            CButton { required property var modelData;Layout.fillWidth:true;alignLeft:true;text:(modelData.text||modelData.status||"Memory")+" · "+root.deadline(modelData.effective_expires_at_us);onClicked:root.inspectRequested(modelData.version_id) }
        }
        Repeater {
            model:root.held
            CButton { required property string modelData; text:"Release hold "+modelData.slice(0,8);enabled:!root.busy;onClicked:root.send("memory.retention.release",{hold_id:modelData},r=>{root.held=root.held.filter(id=>id!==modelData);root.previewRetention(root.cursor)}) }
        }
        CField { id:backup;Layout.fillWidth:true;placeholderText:"New backup file path";Accessible.name:"Backlog backup file" }
        Flow {
            Layout.fillWidth:true;spacing:Theme.space2
            CButton { text:"Back up and protect this page";enabled:!root.busy&&backup.text.trim().length>0&&root.forecast?.counts.eligible>0&&root.summary.profile?.reviewGrace===true;onClicked:root.send("memory.retention.protect",{selection:root.forecast.selection,expected_revision:root.forecast.revision,reason:"review_grace",output:backup.text.trim()},r=>{root.held=r.hold_ids||[];root.feedback="Protected "+r.protected+" memories. Backup saved to "+r.backup;root.previewRetention(root.cursor)}) }
            CButton { text:"Next forecast page";enabled:!!root.forecast?.next_cursor;onClicked:root.previewRetention(root.forecast.next_cursor) }
        }
    }
    CComboBox { id:filter;Layout.fillWidth:true;model:[{id:"",name:"All review jobs"},{id:"review_needed",name:"Recommendations"},{id:"applied",name:"Applied decisions"},{id:"auto_accept",name:"Automatically accepted"},{id:"auto_preserve",name:"Automatically preserved"},{id:"blocked",name:"Blocked"},{id:"retryable",name:"Waiting to retry"},{id:"queued",name:"Queued"},{id:"stale",name:"Changed since assessment"}];textRole:"name";valueRole:"id";Accessible.name:"Review filter";onActivated:{root.offset=0;root.reload()} }
    Repeater {
        model:root.page.rows
        CButton { required property var modelData;Layout.fillWidth:true;alignLeft:true;text:modelData.state.replace(/_/g," ")+" · "+(modelData.text||modelData.error_code||modelData.kind).slice(0,100);onClicked:root.openJob(modelData) }
    }
    ColumnLayout {
        visible:!!root.selected; Layout.fillWidth:true
        CText { Layout.fillWidth:true;wrapMode:Text.Wrap;text:root.selected?.text||"" }
        CText { Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;text:root.selected ? (root.selected.output?root.selected.output.support+" · importance "+root.selected.output.importance+"/4 · "+root.selected.output.durability+" · future use "+root.selected.output.futureUse+"/4\n"+root.selected.output.explanation+"\n"+(root.selected.producer?.assess?.modelId||""):"Unassessed") + (root.selected.action?" · "+root.selected.action:"") + (root.selected.error_code?" · "+root.selected.error_code:"") : "" }
        CText { Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;visible:!!root.detail
            text:root.detail ? ("Project "+root.detail.forecast.scope_id+" · "+root.selected.status+" · "+root.deadline(root.detail.forecast.effective_expires_at_us)+"\n"+(root.detail.forecast.protection_reasons.join(", ")||"Baseline retention")+(root.detail.decision?" · "+root.detail.decision.actor+" "+root.detail.decision.action:"")):"" }
        Repeater { model:root.detail?.context?.evidence||[]
            CText { required property var modelData;Layout.fillWidth:true;wrapMode:Text.Wrap;text:modelData.role+" · "+root.deadline(modelData.occurred_us)+"\n"+(modelData.context||"Full context expired or exceeded the review limit.");color:Theme.muted }
        }
        Repeater { model:root.detail?.context?.neighbors||[]
            CText { required property var modelData;Layout.fillWidth:true;wrapMode:Text.Wrap;text:"Related "+modelData.status+" · "+modelData.text;color:Theme.muted }
        }
        Repeater {
            model:root.selected?.evidence||[]
            CText { required property var modelData;Layout.fillWidth:true;wrapMode:Text.Wrap;text:modelData.trust+" · “"+modelData.quote+"”";color:Theme.muted }
        }
        Flow {
            Layout.fillWidth:true;spacing:Theme.space2;enabled:!root.busy
            CButton { text:"Inspect / correct / forget";onClicked:root.inspectRequested(root.selected?.after_id||root.selected.version_id) }
            CButton { text:"Confirm as my note…";onClicked:{noteEditor.text=root.selected.text;noteEditor.visible=true;noteEditor.forceActiveFocus()} }
            CButton { text:"Keep";onClicked:root.send("memory.graph",{method:"pin",params:{id:root.selected.version_id}},root.changed) }
            CButton { visible:root.selected?.state==="review_needed";text:"Keep local";onClicked:root.send("memory.curation.keep_local",{id:root.selected.version_id,expected_revision:root.selected.revision},root.changed) }
            CButton { visible:root.selected?.state==="review_needed" && root.summary.profile?.reviewGrace===true; text:"Review later";onClicked:root.send("memory.curation.review_later",{id:root.selected.version_id,expected_revision:root.selected.revision},root.changed) }
            Repeater { model:["preserve","accept","dismiss"]; CButton {
                required property string modelData
                visible:root.selected?.state==="review_needed" && root.summary.profile?.mode!=="preview" && (modelData==="dismiss" || modelData===root.selected?.recommended_action)
                text:modelData==="accept"?"Accept supported claim":modelData==="preserve"?"Apply protection":"Dismiss suggestion"
                onClicked:root.send("memory.curation.apply",{job_id:root.selected.id,assessment_id:root.selected.assessment_id,expected_revision:root.selected.revision,action:modelData},root.changed)
            } }
            CButton { visible:!!root.selected?.decision_id&&!root.selected?.undone_revision;text:"Undo decision";onClicked:root.send("memory.curation.undo",{id:root.selected.decision_id,expected_revision:root.selected.decision_revision},root.changed) }
            CButton { visible:["queued","leased","retryable"].includes(root.selected?.state);text:"Cancel review";onClicked:root.send("memory.curation.cancel",{job_id:root.selected.id},root.changed) }
            CButton { visible:["cancelled","blocked","retryable"].includes(root.selected?.state);text:"Retry review";onClicked:root.send("memory.curation.retry",{job_id:root.selected.id},root.changed) }
        }
        CTextArea { id:noteEditor;visible:false;Layout.fillWidth:true;wrapMode:TextEdit.Wrap;Accessible.name:"Review the text to save as your own project note" }
        CButton { visible:noteEditor.visible;text:"Save as my project note";enabled:!root.busy&&noteEditor.text.trim().length>0&&noteEditor.text.length<=2000;onClicked:root.send("memory.curation.confirm_note",{id:root.selected.after_id||root.selected.version_id,expected_revision:root.selected.action==="accept"?root.selected.decision_revision:root.selected.revision,text:noteEditor.text},r=>{root.feedback="Saved your reviewed note.";root.reload()}) }
    }
    RowLayout {
        CButton { text:"Previous reviews";enabled:root.offset>0&&!root.busy;onClicked:{root.offset-=10;root.reload()} }
        CButton { text:"More reviews";enabled:root.page.more===true&&!root.busy;onClicked:{root.offset+=10;root.reload()} }
    }
    CText { visible:!!root.feedback;text:root.feedback;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.accentText }
}
