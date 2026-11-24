import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M20: a recording transcribed on this computer with whisper.cpp, reviewed before it goes into the draft.
// Nothing is sent automatically, and the converted audio is removed afterwards.
CDialog {
    id:importer;objectName:"transcriptImport"
    property string sessionId:""
    property int request:-1
    property string error:""
    property var source:({})
    property string resultSession:""
    property string path:""
    property var artifact:null
    property int keepRequest:-1
    signal insertRequested(string text)
    readonly property var transcription:App.state.transcription||({state:"unavailable"})
    readonly property bool running:request>=0
    closePolicy:running?Popup.NoAutoClose:Popup.CloseOnEscape|Popup.CloseOnPressOutside
    function start(id,path){
        sessionId=id;error="";source=({});resultSession="";transcript.text="";importer.path=path;artifact=null
        request=App.rpc("transcription.importFile",{sessionId:id,path:path})
        open()
    }
    function openRecording(){const target=artifact;WorkbenchState.openRecording(resultSession,{artifactId:target.artifactId,versionId:target.versionId});close()}
    function size(bytes){return bytes>=1048576?(bytes/1048576).toFixed(1)+" MB":Math.max(1,Math.round(bytes/1024))+" KB"}
    function duration(seconds){if(seconds===null||seconds===undefined)return "";const m=Math.floor(seconds/60),s=seconds%60;return m+":"+(s<10?"0":"")+s}
    CText { text:"Transcribe a recording";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
    CText { text:"The recording is transcribed on this computer with whisper.cpp. Review the text before inserting it; nothing is sent automatically.";color:Theme.muted;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        visible:importer.running;Layout.fillWidth:true
        CText { objectName:"transcriptImportStatus";Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.accentText;text:"Transcribing "+(importer.transcription.file||"the recording")+"… Long recordings take a while." }
        CButton { objectName:"transcriptImportCancel";text:"Cancel";danger:true;onClicked:App.rpc("transcription.cancel",{}) }
    }
    CText {
        objectName:"transcriptImportSource";visible:!!importer.source.name;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.secondary
        text:(importer.source.name||"")+" · "+importer.size(importer.source.size||0)+(importer.source.durationSeconds!==null&&importer.source.durationSeconds!==undefined?" · "+importer.duration(importer.source.durationSeconds):"")
            +(importer.source.truncated?" · Only the first hour was transcribed.":"")
    }
    CText { visible:!!importer.resultSession&&importer.resultSession!==App.selectedId;text:"This transcript belongs to another conversation. Return to it before inserting.";color:Theme.amber;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    CTextArea {
        id:transcript;objectName:"transcriptImportText";visible:!importer.running&&!!importer.resultSession;Layout.fillWidth:true;Layout.preferredHeight:Theme.editorTall
        wrapMode:TextEdit.Wrap;textFormat:TextEdit.PlainText;selectByMouse:true;Accessible.name:"Editable transcript"
    }
    // The recording is not kept unless the person asks; then it plays beside its transcript in Workbench › Media.
    Flow {
        visible:!importer.running&&!!importer.artifact&&importer.resultSession===App.selectedId;Layout.fillWidth:true;spacing:Theme.space1
        CButton { objectName:"transcriptImportKeep";text:"Keep the recording";quiet:true;enabled:importer.keepRequest<0;help:"Adds the file to this conversation, up to 100 MB, so you can play it beside the transcript";onClicked:importer.keepRequest=App.rpc("artifacts.import",{sessionId:importer.resultSession,path:importer.path}) }
        CButton { objectName:"transcriptImportOpen";text:"Open the timed transcript";quiet:true;onClicked:importer.openRecording() }
    }
    CText { objectName:"transcriptImportError";visible:!!importer.error;text:importer.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    RowLayout {
        Layout.fillWidth:true;visible:!importer.running
        CButton { text:importer.resultSession?"Discard":"Close";Layout.fillWidth:true;onClicked:{transcript.clear();importer.resultSession="";importer.close()} }
        CButton {
            objectName:"transcriptImportInsert";visible:!!importer.resultSession;text:"Insert into draft";primary:true;Layout.fillWidth:true
            enabled:importer.resultSession===App.selectedId&&transcript.text.trim().length>0
            onClicked:{importer.insertRequested(transcript.text);transcript.clear();importer.resultSession="";importer.close()}
        }
    }
    Connections {
        target:App
        function onResult(id,value){
            if(id===importer.keepRequest&&id>=0){importer.keepRequest=-1;if(value?.error)importer.error=String(value.error.message||value.error);else importer.openRecording();return}
            if(id!==importer.request)return
            importer.request=-1
            if(value?.error){importer.error=String(value.error.message||value.error);return}
            importer.source=value.source||({});importer.resultSession=value.sessionId||"";importer.artifact=value.artifact||null;transcript.text=value.text||""
        }
    }
}
