import QtQuick
import QtQuick.Layouts
Text {
    Layout.fillWidth: true
    Layout.minimumWidth: 0
    color: Theme.text
    font.family: Theme.font
    font.pixelSize: Theme.body
    lineHeight: Theme.bodyLeading
    wrapMode: Text.Wrap
    textFormat: Text.PlainText
    Accessible.role: Accessible.StaticText
    Accessible.name: text
    Accessible.focusable: false
}
