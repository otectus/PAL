import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
TextField {
    id: control
    implicitHeight: Theme.controlHeight
    implicitWidth: Theme.fieldWidth
    Layout.minimumWidth: 0
    color: enabled ? Theme.text : Theme.textDisabled
    placeholderTextColor: Theme.muted
    selectionColor: Theme.selectionFill
    selectedTextColor: Theme.selectionInk
    font.family: Theme.font
    font.pixelSize: Theme.body
    leftPadding: Theme.space3
    rightPadding: Theme.space3
    selectByMouse: true
    background: Rectangle { color: Theme.input; radius: Theme.radiusControl; border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border; border.width: control.activeFocus ? Theme.focusWidth : Theme.hairline }
}
