import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Skills: SKILL.md packages (broker/skills.ts). Importing runs nothing; enabling a reviewed version is
// the one approval; an update waits for its own review while the reviewed version stays active.
ColumnLayout {
    id:skills
    objectName:"skillsSettings"
    Layout.fillWidth:true;spacing:Theme.space4
    property var versions:[]
    property string revision:"0"
    property string error:""
    property var review:null
    RpcClient { id:rpc }
    function reload(){rpc.call("skills.list",{},value=>{if(value.error)skills.error=value.error;else{skills.versions=value.versions||[];skills.revision=value.revision||"0"}})}
    function imported(value){if(value.error){skills.error=value.error;return}skills.error="";skills.reload();skills.open(value.id)}
    function open(id){rpc.call("skills.review",{versionId:id},value=>{if(value.error)skills.error=value.error;else{skills.review=value;reviewDialog.open()}})}
    function stateLabel(v){return ({review:"Waiting for your review",enabled:"On",disabled:"Off",superseded:"Replaced by a newer version"})[v.status]||v.status}
    onVisibleChanged:if(visible)reload()
    Component.onCompleted:reload()
    CSection {
        title:"Skills"
        description:"Reusable instructions and files a model loads when a task fits. Importing never runs anything; you review each version once before it is offered. Skills never grant permissions."
        Flow { Layout.fillWidth:true;spacing:Theme.space2
            CButton { objectName:"importSkillFolder";text:"Import a folder…";onClicked:{const folder=App.chooseFolder();if(folder)rpc.call("skills.importFolder",{path:folder},skills.imported)} }
            CButton { text:"Import a ZIP…";onClicked:{const file=App.chooseFile();if(file)rpc.call("skills.importArchive",{path:file},skills.imported)} }
        }
        RowLayout { Layout.fillWidth:true
            CField { id:repoUrl;objectName:"skillRepository";Layout.fillWidth:true;placeholderText:"https://github.com/owner/repo (pinned to the commit it resolves to)";Accessible.name:"Skill repository address" }
            CButton { text:"Import";enabled:repoUrl.text.trim().startsWith("https://");onClicked:rpc.call("skills.importRepository",{url:repoUrl.text.trim()},skills.imported) }
        }
        Repeater {
            model:skills.versions.filter(v=>v.status!=="superseded")
            RowLayout {
                required property var modelData;Layout.fillWidth:true
                CText { Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary
                    text:modelData.name+" · "+skills.stateLabel(modelData)+(modelData.status==="enabled"?" · "+(modelData.invocation==="automatic"?"offered automatically":"when you name it")+(modelData.scope==="project"?" · "+modelData.project:""):"")
                        +"\n"+modelData.description+"\n"+modelData.source.kind+(modelData.source.uri?" · "+modelData.source.uri:"")+(modelData.source.revision?" @ "+modelData.source.revision.slice(0,12):"")+" · "+modelData.files.length+" files" }
                CButton { text:modelData.status==="review"?"Review":"Details";onClicked:skills.open(modelData.id) }
                CButton { visible:modelData.status==="enabled";text:"Turn off";onClicked:rpc.call("skills.disable",{versionId:modelData.id},()=>skills.reload()) }
                CButton { danger:true;text:"Remove";Accessible.name:"Remove "+modelData.name;onClicked:rpc.call("skills.remove",{skillId:modelData.skillId},()=>skills.reload()) }
            }
        }
        CText { visible:!skills.versions.length;text:"No skills yet.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CText { visible:!!skills.error;text:skills.error;color:Theme.danger;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
    }
    CDialog {
        id:reviewDialog;objectName:"skillReview"
        property bool automatic:false
        CText { text:skills.review?skills.review.version.name:"";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.muted;font.pixelSize:Theme.secondary
            text:skills.review?skills.review.version.source.kind+(skills.review.version.source.uri?" · "+skills.review.version.source.uri:"")+(skills.review.version.source.revision?" @ "+skills.review.version.source.revision:"")+(skills.review.version.license?" · license "+skills.review.version.license:""):"" }
        CText { visible:!!skills.review&&skills.review.executables.length>0;Layout.fillWidth:true;wrapMode:Text.Wrap;color:Theme.amber;font.pixelSize:Theme.secondary
            text:skills.review?"Executable files (they run only through your command tools, which ask first): "+skills.review.executables.join(", "):"" }
        CText { visible:!!skills.review&&!!skills.review.changes;Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.secondary
            text:skills.review&&skills.review.changes?"Changed since the version in use: "+(skills.review.changes.instructionsChanged?"instructions; ":"")+[].concat(skills.review.changes.added.map(p=>"+"+p),skills.review.changes.removed.map(p=>"−"+p),skills.review.changes.changed.map(p=>"~"+p)).join(", "):"" }
        CText { text:skills.review?"Files: "+skills.review.version.files.map(f=>f.path).join(", "):"";Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption;color:Theme.muted }
        CTextArea { Layout.fillWidth:true;Layout.preferredHeight:Theme.editorTall;readOnly:true;text:skills.review?skills.review.instructions:"";font.family:Theme.mono;font.pixelSize:Theme.caption;Accessible.name:"Skill instructions" }
        CCheckBox { id:automaticBox;text:"Offer it automatically when a task fits (otherwise only when you name it)" }
        RowLayout {
            CButton { objectName:"enableSkill";primary:true;visible:!!skills.review&&skills.review.version.status!=="enabled";text:"Enable this version"
                onClicked:rpc.call("skills.enable",{versionId:skills.review.version.id,invocation:automaticBox.checked?"automatic":"explicit",expectedRevision:skills.review.revision},value=>{if(value.error)skills.error=value.error;reviewDialog.close();skills.reload()}) }
            CButton { text:"Close";onClicked:reviewDialog.close() }
        }
    }
}
