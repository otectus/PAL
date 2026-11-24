import QtQuick
import QtQuick.Layouts
import "ContextExplain.js" as ContextExplain
import "TimeText.js" as TimeText
CDialog {
    id:drawer
    signal clockRequested()
    property string sessionId:""
    property string draftText:""
    property var attachmentIds:[]
    property var context:({})
    property string error:""
    property int request:-1
    property int recallRequest:-1
    property var recalled:({rows:[]})
    property var pins:({})
    property var candidates:[]
    property string pinProblem:""
    RpcClient { id:pinRpc;scope:drawer.sessionId+"|"+drawer.opened }
    Timer { id:pinSearch;interval:200;onTriggered:drawer.findSources() }
    function pinCall(method,params){pinProblem="";pinRpc.call(method,Object.assign({sessionId:sessionId},params),value=>{if(value.error)pinProblem=String(value.error.message||value.error);else{pins=value;pinQuery.clear()}})}
    function findSources(){pinRpc.call("references.search",{sessionId:sessionId,query:pinQuery.text},value=>{candidates=value.error?[]:(value.candidates||[]).filter(candidate=>!/\.(png|jpe?g|webp|gif)$/i.test(candidate.label))})}
    onOpened:{pins=({});candidates=[];pinProblem="";pinRpc.call("references.pins",{sessionId:sessionId},value=>{if(!value.error){pins=value;if(value.supported)findSources()}});recallRequest=App.rpc("memoryReview.recalled",{sessionId:sessionId});error="";context={};request=App.rpc("session.context",{id:sessionId,text:draftText,attachmentIds:attachmentIds})}
    CText { text:"Conversation context";font.pixelSize:Theme.title;font.bold:true }
    CText { text:drawer.error;color:Theme.danger;visible:!!drawer.error }
    CText { text:(drawer.context.destination?.provider||"")+" · "+(drawer.context.destination?.model||"")+"\n"+(drawer.context.destination?.cwd||"");color:Theme.accentText }
    CText { text:drawer.context.destination?.host||"";visible:!!text;color:Theme.muted }
    CText { text:"PAL will attach "+drawer.attachmentIds.length+" selected files and your message." }
    Repeater { model:drawer.context.attachments||[];CText { required property var modelData;text:modelData.name+" · "+Math.ceil(modelData.size/1024)+" KiB";font.pixelSize:Theme.secondary } }
    CText { text:"Your next message";font.weight:Font.DemiBold }
    CText { text:"Approximately "+(drawer.context.estimatedTokens||0)+" text tokens";color:Theme.accentText }
    CText { text:drawer.context.estimateLabel||"";font.pixelSize:Theme.secondary;color:Theme.muted }
    CText { text:drawer.context.nativeContext||"";font.pixelSize:Theme.secondary;color:Theme.amber }
    // Where it goes and what the model can reach, for the next message.
    CText { text:"Destination and tools";font.weight:Font.DemiBold;visible:!!drawer.context.route }
    CText { objectName:"contextRoute";visible:!!text;text:ContextExplain.destinationLine(drawer.context.route);wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"contextTools";visible:!!drawer.context.tools;text:ContextExplain.toolsLine(drawer.context.tools);font.pixelSize:Theme.secondary;color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"contextSkills";visible:(drawer.context.skills||[]).length>0;text:"Skills: "+(drawer.context.skills||[]).map(skill=>skill.name).join(", ")+". The model loads one only when it needs it.";font.pixelSize:Theme.secondary;color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"contextHelpers";visible:!!drawer.context.helpers;text:ContextExplain.helpersLine(drawer.context.helpers);font.pixelSize:Theme.secondary;color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
    // Sources kept beside every message here or in this project; each is checked again for every message.
    CText { text:"Pinned sources";font.weight:Font.DemiBold;visible:drawer.pins.supported===true }
    CText { objectName:"contextPinsEmpty";visible:drawer.pins.supported===true&&!(drawer.pins.pins||[]).length;text:"Nothing is pinned. A pinned file, folder, collection or conversation is read again for every message.";font.pixelSize:Theme.secondary;color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Repeater {
        model:drawer.pins.pins||[]
        RowLayout {
            required property var modelData
            required property int index
            Layout.fillWidth:true;spacing:Theme.space2
            CText { objectName:"contextPin_"+index;Layout.fillWidth:true;text:modelData.label+(modelData.scope==="project"?" · every conversation in this project":"");elide:Text.ElideMiddle;wrapMode:Text.NoWrap }
            CButton { objectName:"contextUnpin_"+index;text:"Unpin";quiet:true;implicitHeight:Theme.compactHeight;onClicked:drawer.pinCall("references.unkeep",{id:modelData.id}) }
        }
    }
    CText { objectName:"contextPinProblem";visible:!!drawer.pinProblem;text:drawer.pinProblem;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true;Accessible.role:Accessible.AlertMessage }
    GridLayout {
        visible:drawer.pins.supported===true;Layout.fillWidth:true;columns:width<Theme.formBreakpoint?1:3;columnSpacing:Theme.space2;rowSpacing:Theme.space2
        CField { id:pinQuery;objectName:"contextPinQuery";Layout.fillWidth:true;placeholderText:"Find a source to pin";Accessible.name:"Find a source to pin";onTextChanged:pinSearch.restart() }
        CComboBox { id:pinChoice;objectName:"contextPinChoice";Layout.fillWidth:true;model:drawer.candidates.map(candidate=>candidate.label);enabled:drawer.candidates.length>0;Accessible.name:"Source to pin" }
        CButton { objectName:"contextPinHere";text:"Pin here";enabled:drawer.candidates.length>0&&pinChoice.currentIndex>=0&&!pinRpc.busy;onClicked:drawer.pinCall("references.keep",{ref:drawer.candidates[pinChoice.currentIndex].ref,scope:"session"}) }
    }
    CButton { objectName:"contextPinProject";visible:drawer.pins.supported===true&&drawer.candidates.length>0&&!["file","folder"].includes(drawer.candidates[pinChoice.currentIndex]?.kind||"");text:"Pin for every conversation in this project";quiet:true;enabled:!pinRpc.busy;onClicked:drawer.pinCall("references.keep",{ref:drawer.candidates[pinChoice.currentIndex].ref,scope:"project"}) }
    CodeContext { Layout.fillWidth:true;sessionId:drawer.sessionId;shown:drawer.opened }
    // Which zone the next message is told the time in; the reading itself is taken when the request is sent.
    CText { text:"Date and time";font.weight:Font.DemiBold;visible:!!drawer.context.time }
    CText { objectName:"contextTime";visible:!!drawer.context.time;text:ContextExplain.timeLine(drawer.context.time,TimeText.zoneSource(drawer.context.time?.source)) }
    CText { visible:!!text;text:ContextExplain.timeDetail(drawer.context.time)+(TimeText.zoneReason(drawer.context.time?.reason||"")?" "+TimeText.zoneReason(drawer.context.time.reason):"");font.pixelSize:Theme.secondary;color:Theme.muted }
    CButton { objectName:"contextClock";visible:!!drawer.context.time;text:"Clock and time zone…";onClicked:{drawer.close();drawer.clockRequested()} }
    // The plan of the last request actually sent, recorded when it was sent; nothing is recomputed here.
    CText { text:"Last request sent";font.weight:Font.DemiBold;visible:!!drawer.context.lastPlan }
    CText { objectName:"planSummary";text:ContextExplain.planSummary(drawer.context.lastPlan);visible:!!drawer.context.lastPlan;color:Theme.accentText }
    CText { objectName:"planReported";text:ContextExplain.reportedUsage(drawer.context.lastPlan);visible:!!text;font.pixelSize:Theme.secondary;color:Theme.muted;wrapMode:Text.Wrap;Layout.fillWidth:true }
    Repeater {
        model:ContextExplain.planRows(drawer.context.lastPlan,TimeText.zoneSource)
        RowLayout {
            required property var modelData
            Layout.fillWidth:true;spacing:Theme.space2
            CText { objectName:"planLayer_"+modelData.id;Layout.preferredWidth:Theme.pickerWidth;text:modelData.label;font.pixelSize:Theme.secondary;color:modelData.included?Theme.text:Theme.muted;elide:Text.ElideRight }
            CText { Layout.preferredWidth:Theme.fieldShort;text:modelData.size;font.pixelSize:Theme.secondary;color:Theme.muted }
            CText { Layout.fillWidth:true;text:modelData.status;font.pixelSize:Theme.caption;color:Theme.muted;wrapMode:Text.Wrap }
        }
    }
    CText { objectName:"planUnknown";visible:(drawer.context.lastPlan?.unknown||[]).length>0;text:"Not visible to PAL: "+(drawer.context.lastPlan?.unknown||[]).join("; ")+".";font.pixelSize:Theme.secondary;color:Theme.amber;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { visible:!!drawer.context.lastPlan;text:"Sizes are estimates (UTF-8 bytes ÷ 2); the provider counts its own tokens. Supplied context is not proof the model used it.";font.pixelSize:Theme.caption;color:Theme.muted }
    // What automatic recall did for the last turn, as recorded then; opening this runs no recall.
    readonly property var recallText:ContextExplain.describe(drawer.context.recallOutcome||null)
    CText { text:"Memory for the last turn";font.weight:Font.DemiBold;visible:drawer.context.destination!==undefined }
    CText { objectName:"recallOutcomeTitle";text:drawer.recallText.title;visible:drawer.context.destination!==undefined }
    CText { objectName:"recallOutcomeDetail";text:drawer.recallText.detail;visible:!!text;font.pixelSize:Theme.secondary;color:Theme.muted }
    CText { objectName:"recallOutcomeTime";text:drawer.recallText.when;visible:!!text;font.pixelSize:Theme.caption;color:Theme.muted }
    CText { text:drawer.context.memoryLabel||"";font.pixelSize:Theme.secondary;color:Theme.muted }
    // Recent web searches in this conversation, as they happened; nothing is fetched again here.
    CText { text:"Web searches in this conversation";font.weight:Font.DemiBold;visible:(drawer.context.webSearches||[]).length>0 }
    Repeater {
        model:(drawer.context.webSearches||[]).slice(0,5)
        ColumnLayout {
            required property var modelData
            Layout.fillWidth:true;spacing:Theme.space1
            CText { objectName:"webSearchTrace";Layout.fillWidth:true;text:ContextExplain.searchLine(modelData);font.pixelSize:Theme.secondary;color:modelData.outcome==="ok"?Theme.text:Theme.amber;elide:Text.ElideRight }
            CText { objectName:"webSearchDetail";Layout.fillWidth:true;text:ContextExplain.searchDetail(modelData);visible:!!text;font.pixelSize:Theme.caption;color:Theme.muted;wrapMode:Text.Wrap }
        }
    }
    Repeater { model:(drawer.context.memories||[]).slice(0,12);CText { required property var modelData;text:modelData.quote||modelData.text||JSON.stringify(modelData);font.pixelSize:Theme.secondary } }
    CText { text:drawer.recalled.reason||"";color:Theme.muted;font.pixelSize:Theme.secondary }
    Repeater { model:drawer.recalled.rows||[];CButton { required property var modelData;text:"Why was this recalled? · "+modelData.id.slice(0,10);onClicked:{inspector.sessionId=drawer.sessionId;inspector.open();inspector.openRecord(modelData.id)} } }
    GraphMemoryInspector { id:inspector }
    CButton { objectName:"closeContextDrawer";text:"Close";Layout.fillWidth:true;onClicked:drawer.close() }
    Connections { target:App;function onResult(id,value){if(id===drawer.recallRequest){drawer.recallRequest=-1;if(!value?.error)drawer.recalled=value;return}if(id!==drawer.request)return;drawer.request=-1;if(value?.error)drawer.error=String(value.error.message||value.error);else drawer.context=value} }
}
