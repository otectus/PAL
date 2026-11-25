import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Working setups (broker/setups.ts, PAL Everywhere §12.3). Applying shows the actual changes and what is
// missing first; a setup never enables a skill or grants a permission. Built-ins are examples: save a copy to change one.
ColumnLayout {
    id:setups
    objectName:"setupsSettings"
    Layout.fillWidth:true;spacing:Theme.space4
    property var items:[]
    property string revision:"0"
    property string error:""
    property string feedback:""
    property var preview:null
    property var editing:null
    property var hostStartSetup:null
    property string hostStartFolder:""
    readonly property var families:["files","images","analysis","host"]
    readonly property var familyNames:({files:"Files",images:"Images",analysis:"Analysis",host:"Host commands"})
    RpcClient { id:rpc }
    function reload(){rpc.call("setups.list",{},value=>{if(value.error)setups.error=value.error;else{setups.items=value.setups||[];setups.revision=value.revision||"0"}})}
    function done(value,text){if(value.error){setups.error=value.error;setups.feedback="";return false}setups.error="";setups.feedback=text||"";setups.reload();return true}
    function summary(s){const on=setups.families.filter(f=>s.families&&s.families[f]).map(f=>setups.familyNames[f]);return [s.provider?specialistAccount.label(s.provider):"", s.connection||"", s.model||"", on.length?on.join(", "):"No Workbench", s.posture||"", counted(s.collections.length,"collection"), counted(s.skills.length,"skill")].filter(x=>x).join(" · ")}
    function counted(total,word){return total?total+" "+word+(total===1?"":"s"):""}
    function startSetup(setup,folder){rpc.call("setups.start",Object.assign({setupId:setup.id,expectedSetupRevision:String(setup.revision),cwd:folder},setup.model?{}:{model:App.state.settings?.ollama?.model||undefined}),value=>{if(setups.done(value,"Started a conversation with "+setup.name+(value.unresolved&&value.unresolved.length?". Still missing: "+value.unresolved.join(" "):"."))&&value.session)App.select(value.session.id)})}
    function chooseStart(setup){const folder=App.chooseFolder();if(!folder)return;if(setup.families?.host){hostStartSetup=setup;hostStartFolder=folder;hostStartReview.open()}else startSetup(setup,folder)}
    onVisibleChanged:if(visible){reload();loadSpecialists()}
    Component.onCompleted:{reload();loadSpecialists()}
    CSection {
        title:"Working setups"
        description:"A setup combines a model, Workbench families, a style or posture, standing instructions, collections and skills. Applying one shows exactly what changes and what is missing; it never turns on a skill or grants a permission."
        ColumnLayout {
            objectName:"setupsList";Layout.fillWidth:true;spacing:Theme.space2
            Repeater {
                model:setups.items
                ColumnLayout {
                    required property var modelData
                    Layout.fillWidth:true;spacing:Theme.space1
                    CText { text:modelData.name+(modelData.builtin?" · example":"");font.weight:Font.DemiBold }
                    CText { text:modelData.description||"";visible:!!modelData.description;color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
                    CText { text:setups.summary(modelData);color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
                    Flow { Layout.fillWidth:true;spacing:Theme.space2
                        CButton { text:"Apply to this conversation…";enabled:!!App.selectedId;Accessible.description:"Shows what would change in the open conversation first"
                            onClicked:rpc.call("setups.preview",{setupId:modelData.id,sessionId:App.selectedId},value=>{if(setups.done(value)){setups.preview=value;applyDialog.expanded=({});applyDialog.open()}}) }
                        CButton { text:"Start a conversation…";quiet:true;onClicked:setups.chooseStart(modelData) }
                        CButton { text:modelData.builtin?"Save a copy…":"Edit…";quiet:true;onClicked:{setups.editing=Object.assign({},modelData,modelData.builtin?{id:undefined,name:modelData.name+" (copy)"}:{});editor.load()} }
                        CButton { visible:!modelData.builtin;text:"Export…";quiet:true;onClicked:rpc.call("setups.export",{ids:[modelData.id]},value=>{if(value.error){setups.error=value.error;return}const path=App.saveTextAs(value.filename,value.text);setups.feedback=path?"Saved to "+path:""}) }
                        CButton { visible:!modelData.builtin;text:"Delete";danger:true;quiet:true;onClicked:rpc.call("setups.delete",{id:modelData.id},value=>setups.done(value,"Deleted.")) }
                    }
                }
            }
        }
        Flow { Layout.fillWidth:true;spacing:Theme.space2
            CButton { objectName:"newSetup";text:"New setup…";onClicked:{setups.editing={name:"",description:"",families:{},collections:[],skills:[]};editor.load()} }
            CButton { objectName:"importSetups";text:"Import setups…";onClicked:{const file=App.chooseFile();if(file)rpc.call("setups.import",{path:file},value=>setups.done(value,value.added?("Imported "+value.added.length+" setups."):""))} }
        }
        CText { visible:!!setups.error;text:setups.error;color:Theme.danger;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:!!setups.feedback;text:setups.feedback;color:Theme.accentText;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;Layout.fillWidth:true }
    }
    CDialog {
        id:hostStartReview;accessibleTitle:"Review Host commands for a new conversation"
        onClosed:{setups.hostStartSetup=null;setups.hostStartFolder=""}
        CText { text:"Start a conversation with Host commands?";font.pixelSize:Theme.title;font.weight:Font.DemiBold;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { text:"Setup · "+(setups.hostStartSetup?.name||"")+"\nTarget · new conversation\nProject · "+setups.hostStartFolder+(setups.hostStartSetup?.provider?"\nModel · "+setups.hostStartSetup.provider+(setups.hostStartSetup.model?" · "+setups.hostStartSetup.model:""):"");wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { text:"This setup enables Host commands. The model can propose commands that run outside Code Lab’s sandbox as your desktop account, with access to its files, keys and network.";color:Theme.amber;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { text:"Each command follows the new conversation’s effective approval rule. A desktop bypass or power session can allow commands to proceed without another prompt.";color:Theme.amber;font.weight:Font.DemiBold;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout { Layout.fillWidth:true
            CButton { objectName:"cancelSetupHostStart";text:"Cancel";Layout.fillWidth:true;onClicked:hostStartReview.close() }
            CButton { objectName:"confirmSetupHostStart";text:"Enable Host commands and start";primary:true;Layout.fillWidth:true;enabled:!!setups.hostStartSetup&&!!setups.hostStartFolder;onClicked:{const setup=setups.hostStartSetup,folder=setups.hostStartFolder;hostStartReview.close();setups.startSetup(setup,folder)} }
        }
    }
    // §17.2: specialists a conversation can ask (specialists_run, specialists_panel). They have no tools and change nothing;
    // a document editor's edits arrive as a change set for review. Their runs show in the Workbench Runs tab.
    property var specialists:[]
    property int concurrency:2
    property var roles:({})
    function loadSpecialists(){rpc.call("specialists.list",{},value=>{if(!value.error){setups.specialists=value.specialists||[];setups.concurrency=value.concurrency||2;setups.roles=value.roles||{}}})}
    CSection {
        objectName:"specialistsSettings"
        title:"Specialists"
        description:"Focused helpers a conversation can ask, one at a time or a few together. They read only what the conversation passes them, have no tools, and cannot approve anything."
        RowLayout { Layout.fillWidth:true
            CText { text:"Run at most";Layout.alignment:Qt.AlignVCenter }
            CComboBox { id:concurrencyBox;model:["1","2","3","4"];currentIndex:Math.max(0,setups.concurrency-1);Accessible.name:"How many specialists run at once"
                onActivated:index=>rpc.call("specialists.setConcurrency",{concurrency:index+1},value=>{if(value.error)setups.error=value.error;else setups.loadSpecialists()}) }
            CText { text:"at a time in one conversation";Layout.fillWidth:true }
        }
        Repeater {
            model:setups.specialists
            RowLayout {
                required property var modelData
                Layout.fillWidth:true
                CText { text:modelData.name+" · "+(setups.roles[modelData.role]||modelData.role)+(modelData.model?" · "+specialistAccount.label(modelData.provider)+" "+modelData.model+(modelData.connectionId?" · "+((specialistAccount.accounts||[]).find(row=>row.id===modelData.connectionId)?.name||"account missing"):""):" · helper model");Layout.fillWidth:true;elide:Text.ElideRight }
                CButton { visible:!modelData.builtin;text:"Delete";danger:true;quiet:true;onClicked:rpc.call("specialists.delete",{id:modelData.id},value=>{if(value.error)setups.error=value.error;else setups.loadSpecialists()}) }
            }
        }
        RowLayout { Layout.fillWidth:true
            CField { id:specialistName;objectName:"specialistName";Layout.fillWidth:true;placeholderText:"New specialist name" }
            CComboBox { id:specialistRole;model:Object.keys(setups.roles);displayText:setups.roles[currentText]||currentText;Accessible.name:"Specialist kind" }
        }
        ProviderAccountPicker { id:specialistAccount;name:"specialist";anyLabel:"Helper model";commandLine:false;Layout.fillWidth:true }
        RowLayout { Layout.fillWidth:true
            ModelPicker { id:specialistModel;name:"specialistModel";Layout.fillWidth:true;enabled:specialistAccount.provider.length>0;provider:specialistAccount.provider;connectionId:specialistAccount.accountId;emptyText:specialistAccount.provider?"Choose a model":"Runs on the helper model";label:"Specialist model" }
        }
        CField { id:specialistInstructions;Layout.fillWidth:true;placeholderText:"Standing instructions (optional)" }
        CButton { objectName:"specialistAdd";text:"Add specialist";enabled:specialistName.text.trim().length>0&&(!specialistAccount.provider||specialistModel.value.length>0)
            onClicked:rpc.call("specialists.save",{specialist:{name:specialistName.text,role:specialistRole.currentText,provider:specialistAccount.provider||undefined,connectionId:specialistAccount.account||undefined,model:specialistAccount.provider?specialistModel.value||undefined:undefined,instructions:specialistInstructions.text||undefined}},value=>{if(value.error){setups.error=value.error;return}specialistName.clear();specialistModel.set("");specialistAccount.set("","");specialistInstructions.clear();setups.loadSpecialists()}) }
    }
    CDialog {
        id:applyDialog
        property var expanded:({})
        function toggle(index){const next=Object.assign({},expanded);next[index]=!next[index];expanded=next}
        function compact(value){value=String(value===undefined?"":value);return value.length>140?value.slice(0,137)+"…":value}
        CText { text:"Apply "+(setups.preview?.setup?.name||"");font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Conversation · "+(App.session.title||"Untitled conversation");color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible:!(setups.preview?.changes||[]).length;text:"Nothing would change.";color:Theme.muted }
        Repeater { model:setups.preview?.changes||[]
            ColumnLayout { required property var modelData;required property int index;Layout.fillWidth:true;spacing:Theme.space1
                CText { text:"· "+modelData.label+": "+(modelData.from!==undefined?applyDialog.compact(modelData.from)+" → ":"")+applyDialog.compact(modelData.to);wrapMode:Text.Wrap;Layout.fillWidth:true }
                CButton { visible:modelData.kind==="instructions"&&(String(modelData.from||"").length>140||String(modelData.to||"").length>140);text:applyDialog.expanded[index]?"Hide full change":"Read full change";quiet:true;onClicked:applyDialog.toggle(index) }
                CText { visible:!!applyDialog.expanded[index];text:"Current standing instructions\n"+String(modelData.from??"(none)")+"\n\nProposed standing instructions\n"+String(modelData.to??"(none)");wrapMode:Text.Wrap;Layout.fillWidth:true;font.family:Theme.mono;font.pixelSize:Theme.caption;color:Theme.accentText }
            }
        }
        CText { visible:(setups.preview?.unresolved||[]).length>0;text:"Missing:";font.weight:Font.DemiBold }
        Repeater { model:setups.preview?.unresolved||[];CText { required property var modelData;text:"· "+modelData;color:Theme.amber;wrapMode:Text.Wrap;Layout.fillWidth:true } }
        Repeater { model:setups.preview?.notes||[];CText { required property var modelData;text:modelData;color:Theme.muted;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true } }
        RowLayout { Layout.fillWidth:true
            CButton { text:"Cancel";onClicked:applyDialog.close() }
            Item { Layout.fillWidth:true }
            CButton { text:"Apply these changes";primary:true;enabled:(setups.preview?.changes||[]).length>0;onClicked:rpc.call("setups.apply",{token:setups.preview.token},value=>{if(setups.done(value,"Applied: "+(value.applied||[]).join(", ")+"."))applyDialog.close()}) }
        }
    }
    CDialog {
        id:editor
        function load(){const s=setups.editing;name.text=s.name||"";description.text=s.description||"";account.set(s.provider,s.connection);model.set(s.model||"");style.text=s.style||"";posture.text=s.posture||"";instructions.text=s.instructions||"";collections.text=(s.collections||[]).join("\n");skillsText.text=(s.skills||[]).join("\n");voice.text=s.voice||"";chosen=Object.assign({},s.families||{});open()}
        property var chosen:({})
        function lines(t){return String(t||"").split("\n").map(x=>x.trim()).filter(x=>x)}
        CText { text:setups.editing&&setups.editing.id?"Edit setup":"New setup";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CField { id:name;objectName:"setupName";Layout.fillWidth:true;placeholderText:"Name";maximumLength:80 }
        CField { id:description;Layout.fillWidth:true;placeholderText:"What it is for" }
        ProviderAccountPicker { id:account;name:"setup";byName:true;Layout.fillWidth:true }
        ModelPicker { id:model;name:"setupModel";Layout.fillWidth:true;provider:account.provider;connectionId:account.accountId;emptyText:"Any model";label:"Setup model" }
        Flow { Layout.fillWidth:true;spacing:Theme.space2
            Repeater { model:setups.families;CCheckBox { required property var modelData;text:setups.familyNames[modelData];checked:!!editor.chosen[modelData];onToggled:{const next=Object.assign({},editor.chosen);next[modelData]=checked;editor.chosen=next} } }
        }
        RowLayout { Layout.fillWidth:true
            CField { id:style;Layout.fillWidth:true;placeholderText:"Style name (optional)" }
            CField { id:posture;Layout.fillWidth:true;placeholderText:"Posture, such as posture:review (optional)" }
        }
        CTextArea { id:instructions;Layout.fillWidth:true;Layout.preferredHeight:Theme.editorShort;placeholderText:"Standing instructions, such as an output format" }
        RowLayout { Layout.fillWidth:true
            CTextArea { id:collections;Layout.fillWidth:true;Layout.preferredHeight:Theme.rowDetailHeight;placeholderText:"Collections, one per line" }
            CTextArea { id:skillsText;Layout.fillWidth:true;Layout.preferredHeight:Theme.rowDetailHeight;placeholderText:"Skills, one per line" }
        }
        CField { id:voice;Layout.fillWidth:true;placeholderText:"Speaking voice (optional)" }
        RowLayout { Layout.fillWidth:true
            CButton { text:"Cancel";onClicked:editor.close() }
            Item { Layout.fillWidth:true }
            CButton { objectName:"setupSave";text:"Save";primary:true;enabled:name.text.trim().length>0
                onClicked:rpc.call("setups.save",{expectedRevision:setups.revision,setup:Object.assign(setups.editing&&setups.editing.id?{id:setups.editing.id}:{},{name:name.text,description:description.text,provider:account.provider||undefined,connection:account.account||undefined,model:model.value||undefined,families:editor.chosen,style:style.text||undefined,posture:posture.text||undefined,instructions:instructions.text||undefined,collections:editor.lines(collections.text),skills:editor.lines(skillsText.text),voice:voice.text||undefined})},value=>{if(setups.done(value,"Saved."))editor.close()}) }
        }
    }
}
