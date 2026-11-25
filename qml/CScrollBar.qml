import QtQuick
import QtQuick.Controls

ScrollBar {
    id: bar
    policy: ScrollBar.AsNeeded
    padding: 0
    minimumSize: Math.min(1, Theme.minimumTarget / Math.max(1, horizontal ? width : height))
    // Shown only where there is something to scroll, so it never takes a press meant for what lies under it.
    visible: policy === ScrollBar.AlwaysOn || policy === ScrollBar.AsNeeded && size > 0 && size < 1
    // A Flickable lays out the bar attached to it; a ScrollView leaves one at its top left.
    readonly property Item view: parent instanceof ScrollView ? parent : null
    Binding { when: !!bar.view && !bar.horizontal; bar.x: bar.view.mirrored ? 0 : bar.view.width - bar.width; bar.y: bar.view.topPadding; bar.height: bar.view.availableHeight }
    Binding { when: !!bar.view && bar.horizontal; bar.x: bar.view.leftPadding; bar.y: bar.view.height - bar.height; bar.width: bar.view.availableWidth }
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
            visible: bar.size > 0 && bar.size < 1
        }
    }
    background: null
}
