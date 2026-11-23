import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CheckBox {
    id: control
    Layout.fillWidth: true
    Layout.minimumWidth: 0
    implicitWidth: Theme.pickerWidth
    implicitHeight: Math.max(Theme.compactHeight, label.implicitHeight+Theme.space2)
    spacing: Theme.space2; padding: Theme.space1
    font.family: Theme.font; font.pixelSize: Theme.body
    Accessible.name: text
    indicator: Rectangle {
        x: control.leftPadding; y: (control.height-height)/2
        width: Theme.iconSize; height: Theme.iconSize; radius: Theme.radiusChip
        color: control.checked ? Theme.accentText : Theme.input
        border.color: control.visualFocus ? Theme.focus : control.hovered ? Theme.borderHover : control.checked ? Theme.accentText : Theme.border
        border.width: control.visualFocus ? Theme.focusWidth : Theme.hairline
        opacity: control.enabled ? 1 : Theme.disabledOpacity
        CIcon { anchors.centerIn: parent; name: "check"; visible: control.checked; color: Theme.background; width: Theme.iconSmall; height: width }
    }
    contentItem: Text {
        id: label
        text: control.text; font: control.font; color: control.enabled ? Theme.text : Theme.muted
        leftPadding: control.indicator.width+control.spacing
        verticalAlignment: Text.AlignVCenter; wrapMode: Text.Wrap; textFormat: Text.PlainText
    }
}
