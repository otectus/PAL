import QtQuick

PaneToggle {
    id: toggle
    required property bool workbenchOpen
    required property int pendingChanges
    paneOpen: workbenchOpen
    iconName: "workbench"
    Accessible.name: workbenchOpen ? qsTr("Close Workbench") : qsTr("Open Workbench")
    Accessible.description: pendingChanges ? qsTr("Changes awaiting review") : ""
    help: Accessible.name + " (Ctrl+Shift+W)"

    Rectangle {
        visible: toggle.pendingChanges > 0
        anchors.right: parent.right; anchors.top: parent.top; anchors.margins: Theme.space1
        width: Theme.statusDot; height: Theme.statusDot; radius: Theme.radiusChip; color: Theme.amber
    }
}
