import QtQuick
import QtQuick.Controls
MenuItem {
    id: item
    // A hidden entry takes no room, so menus can list optional actions.
    implicitHeight: visible ? Theme.compactHeight : 0
    implicitWidth: Theme.menuWidth
    leftPadding: Theme.space3; rightPadding: Theme.space3
    font.family: Theme.font; font.pixelSize: Theme.body
    contentItem: Text {
        leftPadding: item.checkable ? item.indicator.width + Theme.space2 : 0
        rightPadding: item.subMenu ? Theme.iconSize : 0
        text: item.text; font: item.font; textFormat: Text.PlainText
        color: item.enabled ? Theme.text : Theme.muted
        elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter
    }
    indicator: Rectangle {
        visible: item.checkable
        x: item.leftPadding; y: (item.height - height) / 2
        width: Theme.iconSmall; height: Theme.iconSmall; radius: Theme.radiusChip
        color: item.checked ? Theme.accentText : Theme.input
        border.color: item.checked ? Theme.accentText : Theme.border
        CIcon { anchors.fill: parent; visible: item.checked; name: "check"; color: Theme.background }
    }
    arrow: CIcon {
        visible: !!item.subMenu
        x: item.width - width - item.rightPadding; y: (item.height - height) / 2
        name: "chevron"; color: Theme.muted; width: Theme.iconSmall; height: width
    }
    background: Rectangle {
        radius: Theme.radiusChip
        color: item.highlighted ? Theme.selected : Theme.transparent
        border.color: item.visualFocus ? Theme.focus : Theme.transparent
        border.width: Theme.focusWidth
    }
}
