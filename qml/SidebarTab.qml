import QtQuick
import QtQuick.Layouts

CButton {
    required property string label
    property bool iconOnly: false
    Layout.fillWidth: true
    implicitHeight: Theme.compactHeight
    quiet: true
    alignLeft: !iconOnly
    text: iconOnly ? "" : label
    help: iconOnly ? label : ""
    Accessible.name: label
    Accessible.role: Accessible.PageTab
    Accessible.selected: primary
    Accessible.onPressAction: if (enabled) click()
}
