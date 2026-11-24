import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// RC-10: which folders of the notes vault assistants may use, and what its .palignore leaves out.
ColumnLayout {
    id: scope
    required property var vault
    property bool busy: false
    signal chosen(var folders)
    signal refused(string reason)
    readonly property var folders: vault.folders || []
    function listOf() { const found = []; for (let i = 0; i < folders.length; i++) found.push(folders[i]); return found }
    spacing: Theme.space1
    CText { text: "Folders assistants may use"; font.weight: Font.DemiBold }
    CText { objectName: "notesVaultWhole"; visible: !scope.folders.length; text: "The whole notes folder."; color: Theme.muted; font.pixelSize: Theme.secondary }
    Repeater {
        model: scope.folders
        RowLayout {
            id: row
            required property string modelData
            required property int index
            Layout.fillWidth: true; spacing: Theme.space2
            CIcon { name: "projects"; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall }
            CText { objectName: "notesVaultFolder_" + row.index; text: row.modelData; Layout.fillWidth: true; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
            CButton { objectName: "notesVaultRemoveFolder_" + row.index; text: "Remove"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !scope.busy; Accessible.name: "Remove " + row.modelData; onClicked: scope.chosen(scope.listOf().filter(path => path !== row.modelData)) }
        }
    }
    CButton {
        objectName: "notesVaultAddFolder"; text: scope.folders.length ? "Add another folder…" : "Use only a folder…"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !scope.busy
        onClicked: {
            const path = App.chooseFolder()
            if (!path) return
            if (!path.startsWith(scope.vault.path + "/")) { scope.refused("Choose a folder inside the notes folder."); return }
            scope.chosen(scope.listOf().concat([path]))
        }
    }
    CText { text: "A .palignore file in the notes folder leaves notes and folders out, in the style of .gitignore. A line that starts with ! is not used."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
}
