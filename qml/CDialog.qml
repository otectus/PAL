import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Popup {
    id: dialog
    default property alias body: bodyColumn.data
    property Component footerContent: null
    // A caller may supply a more specific title. Most forms start with a visible heading.
    property string accessibleTitle: {
        for (const item of bodyColumn.children) {
            if (item instanceof Text && item.visible && item.text) return item.text
        }
        return ""
    }
    // The overlay hosts the dialog's accessible object on its visual popup item.
    Binding {
        target: viewport.parent ? viewport.parent.Accessible : null
        property: "name"
        value: dialog.accessibleTitle
        when: dialog.accessibleTitle.length > 0
    }
    property real preferredWidth: Theme.dialogWidth
    readonly property real inset: width < Theme.compactPane ? Theme.space4 : Theme.space5
    readonly property real footerHeight: footerLoader.item ? footerLoader.item.implicitHeight + Theme.space4 : 0
    parent: Overlay.overlay
    anchors.centerIn: parent
    scale: Theme.interfaceScale
    width: Math.min(preferredWidth, parent ? Math.max(1, (parent.width - Theme.space5) / scale) : preferredWidth)
    implicitHeight: Math.min(bodyColumn.implicitHeight + inset * 2 + footerHeight,
                             parent ? Math.max(1, (parent.height - Theme.space6) / scale) : 720)
    modal: true
    dim: true
    focus: true
    padding: inset
    bottomPadding: inset + footerHeight
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
    function scrollToTop() { viewport.contentItem.contentY = viewport.contentItem.originY }
    // Qt restores the opener on dismissal. Keep the focused field in sight when a
    // long form is traversed with Tab, leaving sticky footer actions in place.
    Connections {
        target: bodyColumn.Window.window
        enabled: dialog.opened
        function onActiveFocusItemChanged() {
            const field = target.activeFocusItem
            let ancestor = field
            while (ancestor && ancestor !== bodyColumn) ancestor = ancestor.parent
            if (!ancestor) return
            const y = field.mapToItem(bodyColumn, 0, 0).y
            const flick = viewport.contentItem as Flickable
            if (!flick) return
            if (y < flick.contentY) flick.contentY = Math.max(0, y - Theme.space1)
            else if (y + field.height > flick.contentY + viewport.availableHeight)
                flick.contentY = Math.min(Math.max(0, flick.contentHeight - viewport.availableHeight),
                                          y + field.height - viewport.availableHeight + Theme.space1)
        }
    }
    background: Rectangle {
        color: Theme.surface
        radius: Theme.radiusDialog
        border.color: Theme.borderStrong
        Rectangle {
            visible: !!footerLoader.item
            anchors.left: parent.left; anchors.right: parent.right
            anchors.bottom: footerLoader.top; anchors.bottomMargin: Theme.space2
            height: Theme.hairline; color: Theme.line
        }
        Loader {
            id: footerLoader
            anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
            anchors.margins: dialog.inset
            sourceComponent: dialog.footerContent
        }
    }
    Overlay.modal: Rectangle { color: Theme.overlayScrim }
    contentItem: ScrollView {
        id: viewport
        clip: true
        contentWidth: availableWidth
        contentHeight: bodyColumn.implicitHeight
        rightPadding: contentHeight > availableHeight ? Theme.minimumTarget : 0
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical: CScrollBar { parent: viewport; x: viewport.width - width; height: viewport.availableHeight }
        ColumnLayout { id: bodyColumn; width: viewport.availableWidth; spacing: Theme.space3 }
    }
}
