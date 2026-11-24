import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
CButton {
    id: control
    property string detail
    property bool selected: false
    /** What the row does when it is pressed: opens something, unless said otherwise. */
    property string trailingIcon: "chevron"
    primary: selected
    quiet: true
    implicitHeight: detail.length ? Theme.rowDetailHeight : Theme.controlHeight
    implicitWidth: Theme.fieldWidth
    help: detail.length ? text+"\n"+detail : text
    contentItem: RowLayout {
        spacing: Theme.space3
        ColumnLayout {
            Layout.fillWidth: true; Layout.minimumWidth: 0; spacing: Theme.space1
            Text { Layout.fillWidth: true; Layout.minimumWidth: 0; text: control.text; color: Theme.text; font.family: Theme.font; font.pixelSize: Theme.body; font.weight: Font.DemiBold; elide: Text.ElideRight; textFormat: Text.PlainText }
            Text { visible: control.detail.length>0; Layout.fillWidth: true; Layout.minimumWidth: 0; text: control.detail; color: Theme.muted; font.family: Theme.font; font.pixelSize: Theme.caption; elide: Text.ElideMiddle; textFormat: Text.PlainText }
        }
        CIcon { visible: control.trailingIcon.length > 0; name: control.trailingIcon; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall; color: Theme.muted }
    }
}
