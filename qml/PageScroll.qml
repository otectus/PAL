import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window
Flickable {
    id: scroll
    default property alias body: column.data
    property real maximumContentWidth: Theme.pageWidth
    readonly property real bodyWidth: column.width
    clip: true
    contentWidth: width
    contentHeight: column.implicitHeight + Theme.space2
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    ScrollBar.vertical: CScrollBar {}
    ColumnLayout {
        id: column
        width: Math.max(0, Math.min(scroll.width - Theme.minimumTarget, scroll.maximumContentWidth))
        x: Math.max(0, (scroll.width - Theme.minimumTarget - width) / 2)
        spacing: Theme.space4
    }
    function reveal(item) {
        let ancestor = item
        while (ancestor && ancestor !== column) ancestor = ancestor.parent
        if (!ancestor || !item) return
        const point = item.mapToItem(column, 0, 0)
        if (point.y < contentY) contentY = Math.max(0, point.y - Theme.space2)
        else if (point.y + item.height > contentY + height)
            contentY = Math.min(Math.max(0, contentHeight-height), point.y + item.height-height+Theme.space2)
    }
    Connections {
        target: scroll.Window.window
        function onActiveFocusItemChanged() { scroll.reveal(scroll.Window.window.activeFocusItem) }
    }
    onHeightChanged: contentY = Math.max(0, Math.min(contentY, contentHeight-height))
    onContentHeightChanged: contentY = Math.max(0, Math.min(contentY, contentHeight-height))
}
