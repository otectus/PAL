import QtQuick
import QtQuick.Controls

MouseArea {
    id: grip
    required property string label
    required property real extent
    required property real minimum
    required property real maximum
    required property Item coordinateSpace
    property bool vertical: false   // A vertical motion adjusts height.
    property bool reversed: false  // Top and left edges grow toward the pointer.
    property bool showIdleIndicator: true
    signal resized(real size)
    signal resetRequested()

    implicitWidth: vertical ? Theme.controlHeight : Theme.minimumTarget
    implicitHeight: vertical ? Theme.minimumTarget : Theme.controlHeight
    activeFocusOnTab: true
    hoverEnabled: true
    preventStealing: true
    cursorShape: vertical ? Qt.SplitVCursor : Qt.SplitHCursor
    Accessible.role: Accessible.Grip
    Accessible.name: label
    Accessible.description: vertical ? qsTr("Use Up and Down to resize. Home restores the default.")
                                         : qsTr("Use Left and Right to resize. Home restores the default.")
    ToolTip.visible: containsMouse && !pressed
    ToolTip.delay: Theme.tooltipDelay
    ToolTip.text: label + qsTr(" · Double-click to reset")

    property real origin: 0
    property real startExtent: 0
    function position(mouse) {
        const point = mapToItem(coordinateSpace, mouse.x, mouse.y)
        return vertical ? point.y : point.x
    }
    function adjust(start, delta) {
        resized(Math.max(minimum, Math.min(maximum, start + (reversed ? -delta : delta))))
    }
    onPressed: mouse => {
        forceActiveFocus(Qt.MouseFocusReason)
        origin = position(mouse)
        startExtent = extent
    }
    onPositionChanged: mouse => { if (pressed) adjust(startExtent, position(mouse) - origin) }
    onDoubleClicked: resetRequested()
    Keys.onPressed: event => {
        if (event.key === Qt.Key_Home) resetRequested()
        else if (event.key === (vertical ? Qt.Key_Up : Qt.Key_Left)) adjust(extent, -Theme.space5)
        else if (event.key === (vertical ? Qt.Key_Down : Qt.Key_Right)) adjust(extent, Theme.space5)
        else return
        event.accepted = true
    }
    Rectangle {
        anchors.centerIn: parent
        visible: grip.showIdleIndicator || grip.containsMouse || grip.activeFocus
        readonly property real length: Math.min(Theme.controlHeight, grip.vertical ? grip.width : grip.height)
        width: grip.vertical ? length : Theme.indicatorHeight
        height: grip.vertical ? Theme.indicatorHeight : length
        radius: Theme.radiusChip
        color: grip.activeFocus ? Theme.focus : grip.containsMouse ? Theme.scrollThumbHover : Theme.scrollThumb
    }
}
