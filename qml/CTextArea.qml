import QtQuick
import QtQuick.Controls
// Multi-line fields share the single-line field's boundary, focus ring and type.
TextArea {
    id: control
    color: enabled ? Theme.text : Theme.textDisabled
    placeholderTextColor: Theme.muted
    selectionColor: Theme.selectionFill
    selectedTextColor: Theme.selectionInk
    font.family: Theme.font
    font.pixelSize: Theme.body
    wrapMode: TextEdit.Wrap
    selectByMouse: true
    // What is stored, as in CField.
    property string saved: ""
    onSavedChanged: text = saved
    leftPadding: Theme.space2; rightPadding: Theme.space2; topPadding: Theme.space2; bottomPadding: Theme.space2
    // Tab and Shift+Tab move between controls, so an editor never traps the keyboard.
    Keys.onTabPressed: event => { const next = control.nextItemInFocusChain(true); if (next && next !== control) next.forceActiveFocus(Qt.TabFocusReason); event.accepted = true }
    Keys.onBacktabPressed: event => { const previous = control.nextItemInFocusChain(false); if (previous && previous !== control) previous.forceActiveFocus(Qt.BacktabFocusReason); event.accepted = true }
    background: Rectangle {
        color: Theme.input; radius: Theme.radiusControl
        border.color: control.activeFocus ? Theme.focus : control.hovered ? Theme.borderHover : Theme.border
        border.width: control.activeFocus ? Theme.focusWidth : Theme.hairline
    }
}
