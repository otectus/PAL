import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import PAL.Native 1.0
// Settings › Companion: appearance, visibility, placement and interface size.
ColumnLayout {
    id:companion
    Layout.fillWidth:true;spacing:Theme.space4
    property var settings:App.state.settings||({})
    property string savedAvatar:AvatarCatalog.defaultId
    property string draftAvatar:AvatarCatalog.defaultId
    property string savedPersonality:""
    property string savedName:"PAL"
    property string savedRevision:"0"
    property bool avatarConflict:false
    property bool avatarLoaded:false
    property int avatarRequestId:-1
    property string avatarError:""
    readonly property bool avatarDirty:draftAvatar!==savedAvatar
    property Component avatarActions: Component {
        ColumnLayout {
            spacing: Theme.space1
            CText {
                visible: companion.avatarConflict || !!companion.avatarError
                objectName: companion.avatarConflict ? "avatarConflict" : "avatarError"
                text: companion.avatarConflict ? qsTr("Companion settings changed elsewhere. Discard this selection to load the saved avatar.") : companion.avatarError
                color: companion.avatarConflict ? Theme.amber : Theme.danger
                Accessible.role: Accessible.AlertMessage
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.space2
                CText {
                    Layout.minimumWidth: 0
                    text: (companion.avatarDirty ? qsTr("Selected") : qsTr("Current avatar")) + " · " + AvatarCatalog.avatarFor(companion.draftAvatar).label
                    maximumLineCount: 2
                    elide: Text.ElideRight
                    color: Theme.muted
                    font.pixelSize: Theme.caption
                }
                CButton {
                    objectName: "avatarDiscard"
                    text: qsTr("Discard")
                    quiet: true
                    visible: companion.avatarDirty || companion.avatarConflict
                    enabled: companion.avatarRequestId < 0
                    onClicked: { companion.adoptAvatar(App.state.settings || {}); companion.avatarError = "" }
                }
                CButton {
                    objectName: "avatarSave"
                    text: companion.avatarRequestId >= 0 ? qsTr("Saving…") : qsTr("Save avatar")
                    primary: true
                    prominent: enabled
                    enabled: App.connected && companion.avatarLoaded && companion.avatarRequestId < 0 && companion.avatarDirty && !companion.avatarConflict
                    onClicked: {
                        companion.avatarError = ""
                        companion.avatarRequestId = App.rpc("settings.update", {
                            avatar: companion.draftAvatar, expectedRevision: companion.savedRevision,
                            expectedIdentity: {personality: companion.savedPersonality, assistantName: companion.savedName, avatar: companion.savedAvatar}
                        })
                    }
                }
            }
        }
    }
    function update(value){return App.rpc("settings.update",value)}
    function adoptAvatar(value){
        savedAvatar=AvatarCatalog.avatarFor(value.avatar).id
        savedPersonality=value.personality??""
        savedName=value.assistantName||"PAL"
        draftAvatar=savedAvatar;savedRevision=App.state.settingsRevision||"0"
        avatarConflict=false;avatarLoaded=true
    }
    function syncAvatar(){
        const value=App.state.settings||{}
        if(!avatarLoaded||!avatarDirty)adoptAvatar(value)
        else if(AvatarCatalog.avatarFor(value.avatar).id!==savedAvatar||(value.personality??"")!==savedPersonality||(value.assistantName||"PAL")!==savedName)avatarConflict=true
        else savedRevision=App.state.settingsRevision||"0"
    }
    Component.onCompleted:syncAvatar()
    CSection {
        title:"Avatar & colors"
        description:"Choose your companion’s appearance and matching color theme."
        GridLayout {
            id:avatarGrid
            objectName:"avatarSelection";Layout.fillWidth:true
            readonly property bool compactCards:width<Theme.avatarGalleryWide
            columns:Math.max(1,Math.min(4,Math.floor((width+columnSpacing)/(Theme.avatarTileWidth+columnSpacing))));uniformCellWidths:true;columnSpacing:Theme.space3;rowSpacing:Theme.space3
            Repeater {
                model:App.avatars
                CButton {
                    id:avatarCard
                    required property var modelData
                    objectName:"avatar_"+modelData.id
                    Layout.fillWidth:true;Layout.fillHeight:true
                    implicitHeight:Math.max(avatarGrid.compactCards?Theme.avatarTileCompact:Theme.avatarTileHeight, implicitContentHeight+topPadding+bottomPadding); quiet:!checked
                    text:modelData.label;help:modelData.description||modelData.label
                    checkable:true;autoExclusive:true
                    checked:companion.draftAvatar===modelData.id;primary:checked
                    enabled:companion.avatarRequestId<0
                    Accessible.name:modelData.label+" avatar"
                    Accessible.description:modelData.description||""
                    onClicked:{companion.draftAvatar=modelData.id;companion.avatarError=""}
                    contentItem:ColumnLayout {
                        spacing:Theme.space1
                        Item {
                            objectName:"avatarPreview_"+avatarCard.modelData.id
                            Layout.alignment:Qt.AlignHCenter
                            Layout.preferredWidth:avatarGrid.compactCards?Theme.avatarPreviewSmall:Theme.avatarPreviewWidth
                            Layout.preferredHeight:Layout.preferredWidth * 13 / 12
                            readonly property bool ready: still.status === Image.Ready || !!customPuppet.item?.ready
                            Image {
                                id: still; anchors.fill: parent; fillMode: Image.PreserveAspectFit
                                asynchronous: true
                                source: avatarCard.modelData.still || ""
                            }
                            Loader {
                                id: customPuppet; anchors.fill: parent; active: !avatarCard.modelData.still
                                sourceComponent: AvatarPuppet {
                                    source: App.assetPath + avatarCard.modelData.puppet.texture
                                    definition: avatarCard.modelData.puppet
                                    pose: avatarCard.modelData.puppet.poses["0"].joints
                                }
                            }
                        }
                        CText { text:avatarCard.modelData.label;font.weight:Font.DemiBold;horizontalAlignment:Text.AlignHCenter }
                        CText { text:(avatarCard.checked?"Selected · ":"")+(avatarCard.modelData.themeLabel||"Choose avatar");color:avatarCard.checked?Theme.accentText:Theme.muted;font.pixelSize:Theme.caption;horizontalAlignment:Text.AlignHCenter }
                    }
                }
            }
        }

    }
    CSection {
        title:"Presence"
        description:"How much of your companion you see, and when they appear."
        CText { text:"Desktop profile";color:Theme.muted;font.pixelSize:Theme.secondary }
        CComboBox { objectName:"desktopProfile";Layout.fillWidth:true;Layout.minimumWidth:0;model:["Normal","Focus","Gaming","Presentation"];currentIndex:["normal","focus","gaming","presentation"].indexOf(companion.settings.desktopProfile||"normal");Accessible.name:"Desktop profile";onActivated:companion.update({desktopProfile:["normal","focus","gaming","presentation"][currentIndex]}) }
        CText { text:"Profiles coordinate visibility, speech, motion and ordinary notifications. Pending approvals remain available from PAL’s tray.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"alwaysOnTop";text:"Always on top";checked:companion.settings.topmost===true;onClicked:companion.update({topmost:checked}) }
        CText { text:"Keep "+App.assistantName+" above your applications, including fullscreen windows.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"autostart";text:"Start PAL at login";checked:App.autostartEnabled;onClicked:{App.setAutostart(checked);checked=App.autostartEnabled} }
        CButton { objectName:"hidePAL";text:(companion.settings.hidden?"Show ":"Hide ")+App.assistantName;onClicked:companion.update({hidden:!companion.settings.hidden}) }
    }
    CSection {
        title:"Placement"
        description:"Companion size and placement on each monitor."
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Character size";font.pixelSize:Theme.secondary;Layout.fillWidth:false }
            CSlider { objectName:"characterSize";Layout.fillWidth:true;Layout.minimumWidth:0;from:.5;to:3;stepSize:.25;value:companion.settings.scale||1;Accessible.name:"Character size";onMoved:App.resizePet(value) }
            Text { text:Math.round((companion.settings.scale||1)*100)+"%";color:Theme.accentText;font.family:Theme.font;font.pixelSize:Theme.secondary }
        }
        Flow {
            Layout.fillWidth:true;Layout.minimumWidth:0;Layout.preferredWidth:0;spacing:Theme.space2
            CButton { objectName:"saveHome";text:"Save monitor home";onClicked:App.saveHomePosition() }
            CButton { objectName:"goHome";text:"Go home";onClicked:App.goHomePosition() }
            CButton { objectName:"dockLeft";text:"Dock left";onClicked:App.dockPet("left") }
            CButton { objectName:"dockRight";text:"Dock right";onClicked:App.dockPet("right") }
        }
        CText { text:"Save a home on each monitor; Go home returns your companion to the one under your pointer. Docking stops roaming.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CCheckBox { objectName:"roaming";text:"Roaming · gently follow the mouse";checked:companion.settings.roaming===true;onClicked:companion.update({roaming:checked}) }
        CText { visible:companion.settings.roaming===true;text:"Your companion follows across displays and stops short of the pointer. Hovering, dragging, open panels, fullscreen apps and active tasks pause movement.";color:Theme.muted;font.pixelSize:Theme.secondary }
    }
    CSection {
        title:"Interface"
        description:"Scale everything in PAL’s panel and workspace."
        RowLayout {
            Layout.fillWidth:true
            CText { text:"Interface size";Layout.fillWidth:false }
            CSlider { objectName:"interfaceScale";Layout.fillWidth:true;Layout.minimumWidth:0;from:.8;to:1.5;stepSize:.1;value:companion.settings.interfaceScale||1;Accessible.name:"Interface size";onMoved:companion.update({interfaceScale:value}) }
            CText { text:Math.round((companion.settings.interfaceScale||1)*100)+"%";Layout.fillWidth:false }
        }
    }
    Connections {
        target:App
        function onStateChanged(){companion.syncAvatar()}
        function onResult(id,value){
            if(id!==companion.avatarRequestId)return
            companion.avatarRequestId=-1
            if(value?.error){companion.avatarError=value.error;return}
            companion.adoptAvatar(value)
            App.notify(qsTr("Avatar saved"))
        }
    }
}
