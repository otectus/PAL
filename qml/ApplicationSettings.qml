import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Settings › Application: the compositor shortcut, sending, time awareness, backups and health, and quitting.
ColumnLayout {
    id:application
    Layout.fillWidth:true;spacing:Theme.space4
    CSection {
        title:"Shortcut"
        description:"Find PAL in your application menu or tray, or bind pal toggle to a key."
        CButton { objectName:"copyShortcut";text:"Copy Hyprland shortcut";help:"Copy a suggested Super+C binding for a Lua configuration";onClicked:App.copy('hl.bind("SUPER + C", hl.dsp.exec_cmd("pal toggle"))') }
    }
    CSection {
        title:"Conversation input"
        description:"Choose which key sends a message. Shift+Enter always adds a new line, in the compact panel and the workspace."
        CComboBox {
            id:sendKeyChoice;objectName:"sendKey";Layout.fillWidth:true
            readonly property var choices:[{value:"enter",label:"Enter sends · Shift+Enter adds a line"},{value:"ctrlEnter",label:"Ctrl+Enter sends · Enter adds a line"},{value:"button",label:"Only the Send button sends · Enter adds a line"}]
            model:choices;textRole:"label"
            currentIndex:Math.max(0,choices.findIndex(choice=>choice.value===(App.state.settings?.sendKey||"enter")))
            enabled:App.connected
            Accessible.name:"Send messages with"
            onActivated:index=>{if(choices[index].value!==(App.state.settings?.sendKey||"enter"))App.rpc("settings.update",{sendKey:choices[index].value})}
        }
    }
    TimeSettings {}
    CSection {
        title:"Maintenance"
        description:"Back up or restore PAL’s state, or check the application’s health."
        GridLayout {
            Layout.fillWidth:true;columns:width>=Theme.toolbarBreakpoint?2:1;columnSpacing:Theme.space2;rowSpacing:Theme.space2
            CButton { objectName:"openBackup";Layout.fillWidth:true;text:"Backup and restore";onClicked:recovery.open() }
            CButton { objectName:"openHealth";Layout.fillWidth:true;text:"Health and recovery";onClicked:health.open() }
        }
    }
    CSection {
        title:"Quit"
        description:"Closing a panel keeps your sessions running. Quitting can too."
        GridLayout {
            Layout.fillWidth:true;columns:width>=Theme.toolbarBreakpoint?2:1;columnSpacing:Theme.space2;rowSpacing:Theme.space2
            CButton { objectName:"quitKeepSessions";Layout.fillWidth:true;text:"Quit · keep sessions running";onClicked:App.quit(false) }
            CButton { objectName:"stopAndQuit";Layout.fillWidth:true;text:"Stop sessions and quit";danger:true;onClicked:quitConfirm.open() }
        }
    }
    CDialog {
        id:quitConfirm
        CText { text:"Stop sessions and quit?";font.pixelSize:Theme.title;font.weight:Font.DemiBold }
        CText { text:"Any running turns will be interrupted. Their conversation history will stay available.";color:Theme.muted }
        RowLayout {
            Layout.fillWidth:true
            CButton { Layout.fillWidth:true;text:"Cancel";onClicked:quitConfirm.close() }
            CButton { Layout.fillWidth:true;text:"Stop and quit";danger:true;onClicked:App.quit(true) }
        }
    }
    Health { id:health }
    Recovery { id:recovery }
}
