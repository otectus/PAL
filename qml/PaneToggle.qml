import QtQuick

CButton {
    required property bool paneOpen
    implicitWidth: Theme.toolbarHeight
    implicitHeight: Theme.toolbarHeight
    leftPadding: Theme.space2
    rightPadding: Theme.space2
    quiet: true
    primary: paneOpen
    Accessible.expanded: paneOpen
}
