import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M15: export a conversation, or one message, as Markdown, plain text, PDF or Word through the system save dialog.
// Only visible messages are exported; attachments appear by name and their contents are never copied.
CDialog {
    id:exporter;objectName:"conversationExport"
    property string sessionId:""
    property var messageIds:[]
    property int request:-1
    property string error:""
    property string feedback:""
    property int renderRequest:-1
    property int saveRequest:-1
    property var rendered:null
    readonly property bool asDocument:format.currentIndex>1
    readonly property bool busy:request>=0||renderRequest>=0||saveRequest>=0
    readonly property var session:(App.state.sessions||[]).find(item=>item.id===sessionId)||({})
    function openFor(id,ids){sessionId=id;messageIds=ids||[];error="";feedback="";keepTemporary.checked=false;includeTools.checked=false;open()}
    function run(){
        error="";feedback=""
        if(asDocument){
            renderRequest=App.rpc("documents.render",Object.assign({sessionId:sessionId,conversation:true,format:format.currentIndex===2?"pdf":"docx"},messageIds.length?{messageIds:messageIds}:{}))
            return
        }
        const params={id:sessionId,format:format.currentIndex===1?"text":"markdown",includeTools:includeTools.checked,showCitations:App.showMemoryCitations,confirmTemporary:keepTemporary.checked}
        if(messageIds.length)params.messageIds=messageIds
        request=App.rpc("session.export",params)
    }
    CText { text:exporter.messageIds.length===1?"Save this message":"Export this conversation";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:"Only your messages and replies are included, with their source links. Attachments are listed by name; their contents are not copied.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CComboBox { id:format;objectName:"exportFormat";Layout.fillWidth:true;model:["Markdown (.md)","Plain text (.txt)","PDF (.pdf)","Word (.docx)"];Accessible.name:"Export format" }
    CCheckBox { id:includeTools;objectName:"exportIncludeTools";visible:exporter.messageIds.length===0&&!exporter.asDocument;text:"Include tool activity" }
    CText { visible:exporter.asDocument&&exporter.session.temporary===true;text:"PDF and Word files are kept with a conversation, so a temporary one exports as Markdown or plain text.";color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CCheckBox { id:keepTemporary;objectName:"exportKeepTemporary";visible:exporter.session.temporary===true;text:"This conversation is temporary. Keep a copy of it anyway." }
    CText { visible:!!exporter.error;text:exporter.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CText { objectName:"exportFeedback";visible:!!exporter.feedback;text:exporter.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        Layout.fillWidth:true
        CButton { text:"Close";Layout.fillWidth:true;onClicked:exporter.close() }
        CButton { objectName:"exportSave";text:exporter.busy?"Preparing…":"Save as…";primary:true;Layout.fillWidth:true;enabled:App.connected&&!exporter.busy&&!(exporter.asDocument&&exporter.session.temporary===true)&&(exporter.session.temporary!==true||keepTemporary.checked);onClicked:exporter.run() }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id>=0&&id===exporter.renderRequest){
                exporter.renderRequest=-1
                if(value?.error){exporter.error=String(value.error.message||value.error);return}
                exporter.rendered=value
                const path=App.chooseSavePath(value.name)
                if(!path){exporter.feedback=value.name+" is kept with this conversation.";return}
                exporter.saveRequest=App.rpc("artifacts.saveAs",{sessionId:exporter.sessionId,artifactId:value.artifactId,versionId:value.versionId,path:path,replace:true})
                return
            }
            if(id>=0&&id===exporter.saveRequest){exporter.saveRequest=-1;if(value?.error)exporter.error=String(value.error.message||value.error);else exporter.feedback="Saved "+value.path;return}
            if(id!==exporter.request)return
            exporter.request=-1
            if(value?.error){exporter.error=value.error;return}
            const path=App.saveTextAs(value.filename,value.text)
            exporter.feedback=path?"Saved "+value.messages+(value.messages===1?" message":" messages")+" to "+path:"Not saved."
        }
    }
}
