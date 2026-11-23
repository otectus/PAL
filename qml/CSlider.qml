import QtQuick
import QtQuick.Controls
Slider {
    id: control
    implicitHeight: Theme.compactHeight
    implicitWidth: Theme.fieldWidth
    padding: Theme.space2
    background: Rectangle {
        x: control.leftPadding; y: (control.height-height)/2
        width: control.availableWidth; height: Theme.indicatorHeight; radius: Theme.radiusChip; color: Theme.border
        Rectangle { width: control.visualPosition*parent.width; height: parent.height; radius: Theme.radiusChip; color: control.enabled ? Theme.accentText : Theme.muted }
    }
    handle: Rectangle {
        x: control.leftPadding + control.visualPosition*(control.availableWidth-width)
        y: (control.height-height)/2
        width: Theme.iconSize; height: Theme.iconSize; radius: width / 2
        color: control.enabled ? Theme.text : Theme.muted
        border.color: control.activeFocus || control.pressed ? Theme.focus : Theme.border
        border.width: control.activeFocus || control.pressed ? Theme.focusWidth : Theme.hairline
    }
}
