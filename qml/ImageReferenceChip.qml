import QtQuick
import QtQuick.Layouts

Rectangle {
    id: chip
    objectName: "imageReferenceChip"
    property var reference: ({})
    property string label: "Guide"
    property bool removable: true
    signal removeRequested()

    implicitWidth: row.implicitWidth + Theme.space2
    implicitHeight: Theme.compactHeight
    radius: Theme.radiusChip
    color: Theme.selected
    border.color: Theme.primaryBorder
    Accessible.role: Accessible.Grouping
    Accessible.name: label + " image, version " + String(reference.versionId || "").slice(0, 8)

    RowLayout {
        id: row
        anchors.fill: parent
        anchors.leftMargin: Theme.space2
        spacing: Theme.space1
        CText {
            Layout.fillWidth: false
            text: chip.label + " · " + (chip.reference.name || "image")
            font.pixelSize: Theme.caption
            elide: Text.ElideRight
            wrapMode: Text.NoWrap
            Layout.maximumWidth: Theme.fieldMedium
        }
        CText {
            Layout.fillWidth: false
            text: "v:" + String(chip.reference.versionId || "").slice(0, 6)
            color: Theme.muted
            font.pixelSize: Theme.caption
            font.family: Theme.mono
        }
        CButton {
            objectName: "imageReferenceRemove"
            visible: chip.removable
            text: ""
            iconName: "close"
            quiet: true
            implicitWidth: Theme.compactHeight
            implicitHeight: Theme.compactHeight
            help: "Remove " + chip.label.toLowerCase()
            onClicked: chip.removeRequested()
        }
    }
}
