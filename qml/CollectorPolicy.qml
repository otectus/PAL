import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// What PAL may observe on this computer. Every source is off until chosen, limited to approved folders where it names
// a path, and forgotten by itself; history is a separate choice.
ColumnLayout {
    id: collectors
    required property var host
    readonly property var policy: host.policy || ({})
    readonly property bool ready: host.policyLoaded
    readonly property var folders: policy.approved_roots || []
    readonly property string adapters: decodeURIComponent(String(Qt.resolvedUrl("../broker/graph-memory/adapters/")).replace("file://", ""))
    spacing: Theme.space2
    function update(patch) { host.updatePolicy(patch) }
    function listOf() { const found = []; for (let i = 0; i < folders.length; i++) found.push(folders[i]); return found }
    CText { text: "What PAL may observe"; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
    CText { text: "Everything here is off until you choose it. Observations stay on this computer and expire by themselves. No document, command or screen is read."; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
    CText { visible: !collectors.ready; text: collectors.host.policyRequest >= 0 ? "Loading the saved collector policy…" : "The saved collector policy could not be loaded; controls stay disabled."; color: Theme.muted; font.pixelSize: Theme.secondary }
    SectionLabel { text: "Approved folders" }
    ColumnLayout {
        objectName: "policyRoots"
        readonly property string text: collectors.listOf().join("\n")
        enabled: collectors.ready
        Layout.fillWidth: true; spacing: Theme.space1
        CText { visible: !collectors.folders.length; text: "No folder is approved. Shells, terminals, editors and files are observed only inside one."; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
        Repeater {
            model: collectors.folders
            RowLayout {
                id: folder
                required property string modelData
                required property int index
                Layout.fillWidth: true; spacing: Theme.space2
                CIcon { name: "projects"; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall }
                CText { objectName: "policyFolder_" + folder.index; text: folder.modelData; Layout.fillWidth: true; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                CButton { objectName: "policyRemoveFolder_" + folder.index; text: "Remove"; quiet: true; implicitHeight: Theme.compactHeight; help: "Stop observing this folder and erase its history"; Accessible.name: "Remove " + folder.modelData; onClicked: collectors.update({ approved_roots: collectors.listOf().filter(path => path !== folder.modelData) }) }
            }
        }
    }
    CButton { objectName: "policyAddFolder"; text: "Add a folder…"; iconName: "plus"; enabled: collectors.ready; onClicked: { const path = App.chooseFolder(); if (path && !collectors.listOf().includes(path)) collectors.update({ approved_roots: collectors.listOf().concat([path]) }) } }
    SectionLabel { text: "Sources" }
    CCheckBox { objectName: "policyHyprland"; text: "The focused window and workspace (Hyprland)"; enabled: collectors.ready; checked: collectors.policy.hyprland_enabled === true; onClicked: collectors.update({ hyprland_enabled: checked }) }
    CCheckBox { objectName: "policyTitles"; text: "Window titles of listed applications"; enabled: collectors.ready; checked: collectors.policy.capture_titles === true; onClicked: collectors.update({ capture_titles: checked }) }
    RowLayout {
        enabled: collectors.ready && collectors.policy.capture_titles === true
        Layout.fillWidth: true
        CField { id: titleApps; objectName: "policyTitleApplications"; Layout.fillWidth: true; placeholderText: "Application classes, comma-separated (for example kitty)"; Accessible.name: "Approved title applications"; text: (collectors.policy.title_applications || []).join(", ") }
        CButton { text: "Save"; onClicked: collectors.update({ title_applications: titleApps.text.split(",").map(s => s.trim()).filter(s => s.length) }) }
    }
    CCheckBox { objectName: "policyFish"; text: "Shell activity (Fish): folder, exit status and duration"; enabled: collectors.ready; checked: collectors.policy.fish_enabled === true; onClicked: collectors.update({ fish_enabled: checked }) }
    CCheckBox { objectName: "policyEditor"; text: "Open documents (Vim, Neovim and others that call the emitter)"; enabled: collectors.ready; checked: collectors.policy.editor_enabled === true; onClicked: collectors.update({ editor_enabled: checked }) }
    Flow {
        visible: collectors.policy.fish_enabled === true || collectors.policy.editor_enabled === true
        Layout.fillWidth: true; spacing: Theme.space1
        CButton { visible: collectors.policy.fish_enabled === true; text: "Copy the Fish line"; quiet: true; implicitHeight: Theme.compactHeight; help: "Add it to config.fish"; onClicked: App.copy("source " + collectors.adapters + "fish/pal-memory.fish") }
        CButton { visible: collectors.policy.editor_enabled === true; text: "Copy the Vim line"; quiet: true; implicitHeight: Theme.compactHeight; help: "Add it to your vimrc"; onClicked: App.copy("source " + collectors.adapters + "editor/pal-memory.vim") }
        CButton { objectName: "policyCopyNeovim"; visible: collectors.policy.editor_enabled === true; text: "Copy the Neovim line"; quiet: true; implicitHeight: Theme.compactHeight; help: "Add it to init.lua"; onClicked: App.copy("dofile(\"" + collectors.adapters + "editor/pal-memory.lua\")") }
    }
    CText { visible: collectors.policy.editor_enabled === true; text: "An editor tells PAL the path of the document it shows. A path outside the approved folders is dropped at once; the document’s text is never sent."; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
    CCheckBox { objectName: "policyFiles"; text: "Files that change in approved folders"; enabled: collectors.ready; checked: collectors.policy.filesystem_enabled === true; onClicked: collectors.update({ filesystem_enabled: checked }) }
    CCheckBox { objectName: "policyKitty"; text: "Which folder a Kitty terminal is in"; enabled: collectors.ready; checked: collectors.policy.kitty_enabled === true; onClicked: collectors.update({ kitty_enabled: checked }) }
    RowLayout {
        visible: collectors.policy.kitty_enabled === true
        Layout.fillWidth: true
        CField { id: kittyEndpoint; objectName: "policyKittyEndpoint"; Layout.fillWidth: true; enabled: collectors.ready; placeholderText: "unix:/run/user/1000/kitty-{pid}"; Accessible.name: "Kitty inspection address"; text: collectors.policy.kitty_endpoint || "" }
        CButton { text: "Save"; enabled: collectors.ready; onClicked: collectors.update({ kitty_endpoint: kittyEndpoint.text.trim() }) }
    }
    CText { visible: collectors.policy.kitty_enabled === true; text: "In kitty.conf set “allow_remote_control socket-only” and “listen_on unix:/run/user/1000/kitty”; Kitty adds its process ID, and {pid} finds every running terminal. Only its list of windows is read."; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
    CCheckBox { objectName: "policySession"; text: "When this computer is locked"; enabled: collectors.ready; checked: collectors.policy.session_enabled === true; onClicked: collectors.update({ session_enabled: checked }) }
    CText { text: "While it is locked nothing is observed, and after it slept everything is unknown until it is seen again."; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
    SectionLabel { text: "History" }
    CCheckBox { objectName: "policyHistory"; text: "Keep what I worked on in approved folders"; enabled: collectors.ready; checked: collectors.policy.history_enabled === true; onClicked: collectors.update({ history_enabled: checked }) }
    RowLayout {
        visible: collectors.policy.history_enabled === true
        Layout.fillWidth: true; spacing: Theme.space2
        CText { text: "Erased after"; Layout.fillWidth: false; Layout.alignment: Qt.AlignVCenter }
        CSpinBox { objectName: "policyHistoryDays"; from: 1; to: 90; value: collectors.policy.history_days || 7; enabled: collectors.ready; Accessible.name: "Days history is kept"; onValueModified: collectors.update({ history_days: value }) }
        CText { text: "days"; Layout.fillWidth: true; Layout.alignment: Qt.AlignVCenter }
    }
    CText { text: "Files, folders and how long, never titles, commands or text. Assistants may read their own project’s part."; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
    CButton { objectName: "openWorkspaceHistory"; text: "Workspace history…"; onClicked: history.openView() }
    WorkspaceHistory { id: history }
}
