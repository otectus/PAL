import QtQuick
import QtQuick.Layouts
Rectangle {
    id: section
    default property alias body: contents.data
    property string title
    property string description
    property string hint
    property bool expanded: true
    function revealSection() { expanded = true }

    Layout.fillWidth: true
    Layout.minimumWidth: 0
    Layout.alignment: Qt.AlignTop
    implicitHeight: stack.implicitHeight + 2 * stack.y
    color: Theme.transparent
    radius: Theme.radiusCard
    border.width: 0

    ColumnLayout {
        id: stack
        x: 0
        y: Theme.space1
        width: Math.max(0, parent.width - 2 * x)
        spacing: Theme.space2
        CButton {
            id: heading
            objectName: "sectionToggle_" + section.title
            Layout.fillWidth: true
            quiet: true
            implicitHeight: Math.max(Theme.compactHeight, implicitContentHeight + Theme.space2)
            leftPadding: Theme.space1
            rightPadding: Theme.space1
            Accessible.name: section.title
            Accessible.expanded: section.expanded
            onClicked: section.expanded = !section.expanded
            contentItem: RowLayout {
                spacing: Theme.space2
                CText { text: section.title; Accessible.role: Accessible.Heading; font.pixelSize: Theme.section; font.weight: Font.DemiBold }
                Text {
                    visible: !!section.hint
                    Layout.maximumWidth: heading.availableWidth * 0.4
                    text: section.hint; elide: Text.ElideRight
                    color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.caption
                }
                CIcon { name: section.expanded ? "down" : "chevron"; color: Theme.muted; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall }
            }
        }
        ColumnLayout {
            id: contents
            visible: section.expanded
            Layout.fillWidth: true
            Layout.leftMargin: heading.leftPadding
            Layout.rightMargin: heading.rightPadding
            Layout.bottomMargin: Theme.space1
            spacing: Theme.space3
            CText { visible: !!text; text: section.description; color: Theme.muted; font.pixelSize: Theme.secondary }
        }
    }
}
