import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: control
    property bool primary: false
    property bool prominent: false
    property bool danger: false
    property bool quiet: false
    property bool alignLeft: false
    property string iconName: ""
    property string help: ""
    readonly property color ink: !enabled ? Theme.textDisabled : prominent ? Theme.background
        : danger ? Theme.danger : primary ? Theme.accentText : Theme.text
    Layout.minimumWidth: 0
    implicitHeight: Theme.controlHeight
    implicitWidth: Math.max(Theme.controlHeight, implicitContentWidth + leftPadding + rightPadding)
    leftPadding: Theme.space3
    rightPadding: Theme.space3
    topPadding: Theme.space2
    bottomPadding: Theme.space2
    hoverEnabled: true
    font.family: Theme.font
    font.pixelSize: Theme.body
    font.weight: prominent || primary ? Font.DemiBold : Font.Normal
    Accessible.name: text || help
    Accessible.description: help !== Accessible.name ? help : ""
    ToolTip.visible: (hovered || visualFocus) && (help.length > 0 || (label && label.truncated))
    ToolTip.text: help || text
    ToolTip.delay: Theme.tooltipDelay
    background: Rectangle {
        radius: Theme.radiusControl
        color: {
            if (!control.enabled) return control.quiet ? Theme.transparent : Theme.surface
            if (control.prominent) return control.down ? Theme.accentText : control.hovered ? Theme.text : Theme.accent
            if (control.down || control.primary) return Theme.selected
            if (control.hovered) return Theme.raised
            return control.quiet ? Theme.transparent : Theme.surface
        }
        border.color: control.visualFocus ? Theme.focus : !control.enabled ? Theme.line
            : control.prominent ? Theme.accent : control.quiet ? Theme.transparent
            : control.primary ? Theme.primaryBorder : control.danger ? Theme.dangerBorder
            : control.hovered ? Theme.borderHover : Theme.border
        border.width: control.visualFocus ? Theme.focusWidth : control.quiet ? 0 : Theme.hairline
        Behavior on color { ColorAnimation { duration: Theme.feedbackDuration; easing.type: Theme.easing } }
        Rectangle {
            visible: control.prominent && control.visualFocus
            anchors.fill: parent
            anchors.margins: Theme.space1
            radius: Math.max(0, parent.radius - Theme.space1)
            color: Theme.transparent
            border.color: Theme.background
        }
    }
    contentItem: Item {
        implicitWidth: (control.iconName ? Theme.iconSize : 0) + (control.iconName && control.text ? Theme.space2 : 0) + label.implicitWidth
        implicitHeight: Math.max(Theme.iconSize, label.implicitHeight)
        Row {
            // A lone icon can extend into the padding on both sides of a compact button.
            width: control.text ? Math.min(parent.width, parent.implicitWidth) : parent.implicitWidth
            height: parent.height
            x: control.alignLeft ? 0 : (parent.width - width) / 2
            spacing: control.iconName && control.text ? Theme.space2 : 0
            CIcon {
                visible: !!control.iconName
                name: control.iconName
                color: control.ink
                width: Theme.iconSize
                height: parent.height
            }
            Text {
                id: label
                width: Math.max(0, parent.width - (control.iconName ? Theme.iconSize + parent.spacing : 0))
                height: parent.height
                text: control.text
                font: control.font
                color: control.ink
                verticalAlignment: Text.AlignVCenter
                elide: Text.ElideRight
                textFormat: Text.PlainText
            }
        }
    }
}
