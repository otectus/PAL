import QtQuick
import QtQuick.Controls
SpinBox {
    id: control
    implicitWidth: Theme.fieldMedium; implicitHeight: Theme.controlHeight
    leftPadding: Theme.fieldActionInset; rightPadding: Theme.fieldActionInset; editable: true
    font.family: Theme.font; font.pixelSize: Theme.body
    // What is stored. A number being chosen outlives the state updates in between: only a stored value that really changes replaces it.
    property int saved: -1
    onSavedChanged: value = saved
    background: Rectangle { color: Theme.input; radius: Theme.radiusControl; border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border; border.width: control.activeFocus ? Theme.focusWidth : Theme.hairline }
    contentItem: TextInput {
        text: control.textFromValue(control.value,control.locale)
        font: control.font; color: Theme.text
        horizontalAlignment: Qt.AlignHCenter; verticalAlignment: Qt.AlignVCenter
        readOnly: !control.editable; validator: control.validator; selectByMouse: true
        inputMethodHints: Qt.ImhDigitsOnly
    }
    down.indicator: Rectangle {
        x: Theme.focusWidth; y: Theme.focusWidth; width: Theme.compactHeight; height: control.height-Theme.space1; radius: Theme.radiusChip
        color: control.down.pressed ? Theme.selected : control.down.hovered ? Theme.raised : Theme.transparent
        Text { anchors.centerIn: parent; text: "−"; color: control.down.indicator.enabled ? Theme.accentText : Theme.muted; font.family: Theme.font; font.pixelSize: Theme.glyph }
    }
    up.indicator: Rectangle {
        x: control.width-width-Theme.focusWidth; y: Theme.focusWidth; width: Theme.compactHeight; height: control.height-Theme.space1; radius: Theme.radiusChip
        color: control.up.pressed ? Theme.selected : control.up.hovered ? Theme.raised : Theme.transparent
        Text { anchors.centerIn: parent; text: "+"; color: control.up.indicator.enabled ? Theme.accentText : Theme.muted; font.family: Theme.font; font.pixelSize: Theme.glyph }
    }
}
