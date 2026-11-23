import QtQuick
import QtQuick.Controls
// Context and overflow menus use the panels' palette, type and focus style.
Menu {
    id: menu
    padding: Theme.space1
    delegate: CMenuItem {}
    background: Rectangle {
        implicitWidth: Theme.menuWidth
        color: Theme.raised; radius: Theme.radiusControl
        border.color: Theme.borderStrong
    }
}
