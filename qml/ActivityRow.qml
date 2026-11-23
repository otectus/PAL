import QtQuick
import QtQuick.Layouts
import "ActivityText.js" as Log

CButton {
    id: row
    property string detail: ""
    property string update: ""
    property string eventState: ""
    property double stamp: 0
    property bool disclosed: false
    readonly property string statusLabel: Log.stateLabel(eventState)
    readonly property color statusColor: eventState === "failed" ? Theme.danger
        : ["declined", "waiting", "pending", "interrupted", "notice"].includes(eventState) ? Theme.amber
        : eventState === "completed" ? Theme.success : Log.active(eventState) || eventState === "started" ? Theme.accentText : Theme.muted
    quiet: true
    implicitHeight: Math.max(Theme.controlHeight + Theme.space2, implicitContentHeight + Theme.space3)
    leftPadding: Theme.space3
    rightPadding: Theme.space2
    help: [text, detail, update, statusLabel, Log.time(stamp, true)].filter(Boolean).join("\n")
    Accessible.name: [text, statusLabel].filter(Boolean).join(", ")
    Accessible.description: [detail, update, Log.time(stamp, true)].filter(Boolean).join(". ")
    contentItem: RowLayout {
        spacing: Theme.space3
        Rectangle {
            implicitWidth: Theme.compactHeight
            implicitHeight: Theme.compactHeight
            radius: Theme.radiusControl
            color: Theme.badgeSurface
            CIcon {
                anchors.centerIn: parent
                name: row.iconName
                color: row.iconName === "notice" ? Theme.amber : Theme.accentText
            }
        }
        ColumnLayout {
            Layout.fillWidth: true
            Layout.minimumWidth: 0
            spacing: Theme.hairline
            CText {
                text: row.text
                lineHeight: 1
                font.weight: Font.DemiBold
                wrapMode: Text.NoWrap
                elide: Text.ElideRight
            }
            CText {
                visible: !!row.detail
                text: row.detail
                lineHeight: 1
                color: Theme.muted
                font.pixelSize: Theme.caption
                wrapMode: Text.NoWrap
                elide: Text.ElideRight
            }
            CText {
                visible: !!row.update
                text: row.update
                lineHeight: 1
                color: row.eventState === "failed" ? Theme.danger : Theme.muted
                font.pixelSize: Theme.caption
                wrapMode: Text.NoWrap
                elide: Text.ElideRight
            }
        }
        ColumnLayout {
            spacing: Theme.hairline
            CText {
                Layout.fillWidth: false
                Layout.alignment: Qt.AlignRight
                visible: !!row.statusLabel
                text: row.statusLabel
                lineHeight: 1
                color: row.statusColor
                font.pixelSize: Theme.caption
                font.weight: Font.DemiBold
            }
            CText {
                Layout.fillWidth: false
                Layout.alignment: Qt.AlignRight
                visible: !!row.stamp
                text: Log.time(row.stamp, false)
                lineHeight: 1
                color: Theme.muted
                font.pixelSize: Theme.caption
            }
        }
        CIcon {
            Layout.preferredWidth: Theme.iconSmall
            Layout.preferredHeight: Theme.iconSmall
            name: row.disclosed ? "down" : "chevron"
        }
    }
    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.leftMargin: row.leftPadding + Theme.compactHeight + Theme.space3
        height: Theme.hairline
        color: Theme.line
    }
}
