import QtQuick
import QtQuick.Controls
ComboBox {
    id: control
    Accessible.onPressAction: {
        if (!enabled) return
        forceActiveFocus(Qt.OtherFocusReason)
        if (popup.visible) popup.close()
        else popup.open()
    }
    implicitHeight: Theme.controlHeight
    implicitWidth: Theme.pickerWidth
    leftPadding: Theme.space3; rightPadding: Theme.space6
    font.family: Theme.font; font.pixelSize: Theme.body
    background: Rectangle { radius: Theme.radiusControl; color: Theme.input; border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border; border.width: control.activeFocus ? Theme.focusWidth : Theme.hairline }
    contentItem: Text {
        text: control.displayText; font: control.font
        color: control.enabled ? Theme.text : Theme.muted
        verticalAlignment: Text.AlignVCenter; elide: Text.ElideRight; textFormat: Text.PlainText
    }
    indicator: CIcon { x: control.width-width-Theme.space3; y: (control.height-height)/2; width: Theme.iconSmall; height: Theme.iconSmall; name: "down"; color: Theme.muted }
    delegate: ItemDelegate {
        id: option
        required property int index
        width: control.width-Theme.space2
        text: control.textAt(index)
        implicitHeight: Math.max(Theme.controlHeight, implicitContentHeight + Theme.space3)
        font: control.font
        highlighted: control.highlightedIndex===index
        contentItem: Text { text: option.text; font: control.font; color: option.highlighted ? Theme.accentText : Theme.text; elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter; textFormat: Text.PlainText }
        background: Rectangle { radius: Theme.radiusChip; color: option.down ? Theme.raised : option.highlighted ? Theme.selected : Theme.transparent; border.color: option.visualFocus ? Theme.focus : Theme.transparent; border.width: Theme.focusWidth }
    }
    popup: Popup {
        y: control.height+Theme.space1; width: control.width; padding: Theme.space1
        implicitHeight: Math.min(Theme.menuMaxHeight, menu.contentHeight + padding * 2)
        topMargin: Theme.space2; bottomMargin: Theme.space2
        background: Rectangle { color: Theme.raised; border.color: Theme.borderStrong; radius: Theme.radiusControl }
        contentItem: ListView {
            id: menu; clip: true; implicitHeight: contentHeight
            model: control.popup.visible ? control.delegateModel : null
            currentIndex: control.highlightedIndex
            ScrollBar.vertical: CScrollBar {}
        }
    }
}
