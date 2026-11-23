import QtQuick
import QtQuick.Controls

ScrollBar {
    id: bar
    policy: ScrollBar.AsNeeded
    padding: 0
    minimumSize: Math.min(1, Theme.minimumTarget / Math.max(1, horizontal ? width : height))
    Accessible.name: horizontal ? qsTr("Horizontal scroll bar") : qsTr("Vertical scroll bar")
    contentItem: Item {
        implicitWidth: Theme.minimumTarget
        implicitHeight: Theme.minimumTarget
        Rectangle {
            anchors.centerIn: parent
            width: bar.horizontal ? parent.width : Theme.space1
            height: bar.horizontal ? Theme.space1 : parent.height
            radius: Theme.radiusChip
            color: bar.pressed ? Theme.accent : bar.hovered ? Theme.scrollThumbHover : Theme.scrollThumb
            visible: bar.size < 1
        }
    }
    background: null
}
