import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Files: the conversation's workspace folders, one folder level at a time, with name
// filtering and content search as separate actions. Names are untrusted text and render as plain text.
Item {
    id: pane
    objectName: "workspaceFiles"
    implicitHeight: pane.root ? Math.max(Theme.narrowPane, filesLayout.implicitHeight) : filesLayout.implicitHeight
    property string sessionId: ""
    property var roots: []
    property var grants: []
    property string problem: ""
    property string error: ""
    property var listing: ({ entries: [] })
    property var results: null
    property bool loading: false
    readonly property var root: roots.find(r => r.id === WorkbenchState.rootFor(sessionId)) || roots[0] || null
    readonly property string path: root ? WorkbenchState.folder(sessionId, root.id) : ""
    readonly property var crumbs: path ? path.split("/") : []
    signal settingsRequested(var root)
    readonly property string ownerKey: sessionId + ":" + (root ? root.id : "") + ":" + path
    RpcClient { id: rpc; scope: pane.ownerKey }
    RpcClient { id: rootsRpc; scope: pane.sessionId }
    readonly property int rootsRevision: App.state.workbench?.rootsRevision || 0
    readonly property bool online: App.connected
    Timer {
        id: refreshFolders
        interval: 0
        onTriggered: if (pane.visible && pane.online && pane.sessionId) pane.refreshRoots()
    }
    onRootsRevisionChanged: refreshFolders.restart()
    onOnlineChanged: if (online) refreshFolders.restart()
    onVisibleChanged: if (visible) refreshFolders.restart()
    function refreshRoots() {
        if (!sessionId) { roots = []; return }
        rootsRpc.call("workspace.roots", { sessionId: sessionId }, value => {
            if (value.error) { error = value.error; roots = []; return }
            roots = value.roots || []; grants = value.grants || []; problem = value.problem || ""; error = ""
            if (root) Qt.callLater(() => pane.load(false))
        })
    }
    function load(more) {
        if (!root) return
        if (root.status && root.status !== "available") { listing = ({ entries: [] }); return }
        if (!more) listing = ({ entries: [] })
        loading = true
        const params = { sessionId: sessionId, rootId: root.id, path: path }
        if (more && listing.nextCursor) params.cursor = listing.nextCursor
        rpc.call("files.list", params, value => {
            loading = false
            if (value.error) { error = value.error; return }
            error = ""
            listing = more ? Object.assign({}, value, { entries: (listing.entries || []).concat(value.entries) }) : value
        })
    }
    function open(entry) {
        if (entry.type === "directory") { results = null; WorkbenchState.setFolder(sessionId, root.id, entry.path); Qt.callLater(() => pane.load(false)) }
        else if (entry.type === "file") WorkbenchState.openFile(sessionId, root.id, entry.path, 1)
    }
    function goTo(index) { results = null; WorkbenchState.setFolder(sessionId, root.id, index < 0 ? "" : crumbs.slice(0, index + 1).join("/")); Qt.callLater(() => pane.load(false)) }
    function runSearch() {
        if (!root || !searchField.text.trim()) { results = null; return }
        loading = true
        rpc.call("files.search", { sessionId: sessionId, rootId: root.id, path: path, query: searchField.text, mode: regexMode.checked ? "regex" : "literal" }, value => {
            loading = false
            if (value.error) { error = value.error; return }
            error = ""; results = value
        })
    }
    function chooseFolder() { const chosen = App.chooseFolder(); if (chosen) settingsRequested({ path: chosen, policy: { write: false, organize: false, hidden: false, execute: false, destinations: { remote: false, cloud: false } } }) }
    function useConversation() { rpc.call("workspace.conversationRoot", { sessionId: sessionId }, value => { if (value.error) error = value.error; else { WorkbenchState.setRoot(sessionId, value.id); refreshRoots() } }) }
    function size(bytes) { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? Math.round(bytes / 1024) + " KiB" : (bytes / 1048576).toFixed(1) + " MiB" }
    onSessionIdChanged: { roots = []; grants = []; results = null; listing = ({ entries: [] }); problem = ""; error = ""; loading = false; refreshFolders.restart() }
    Component.onCompleted: refreshFolders.restart()

    ColumnLayout {
        id: filesLayout
        anchors.fill: parent; spacing: Theme.space2
        CText { visible: !!pane.problem; text: pane.problem; color: Theme.amber; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            visible: pane.roots.length > 0
            Layout.fillWidth: true; spacing: Theme.space2
            CComboBox {
                id: rootPicker; objectName: "workspaceRootPicker"
                Layout.fillWidth: true; visible: pane.roots.length > 0
                model: pane.roots.map(r => r.name + (r.primary ? " · primary" : "") + (r.status && r.status !== "available" ? " · " + (r.status === "missing" ? "unavailable" : "replaced") : ""))
                currentIndex: Math.max(0, pane.roots.findIndex(r => pane.root && r.id === pane.root.id))
                Accessible.name: "Workspace folder"
                onActivated: index => { WorkbenchState.setRoot(pane.sessionId, pane.roots[index].id); pane.results = null; Qt.callLater(() => pane.load(false)) }
            }
            CButton { objectName: "workspaceAddFolder"; visible: pane.roots.length > 0; implicitWidth: Theme.controlHeight; text: ""; iconName: "plus"; help: "Add a folder to this conversation’s workspace"; Accessible.name: "Add a workspace folder"; onClicked: pane.chooseFolder() }
            CButton { objectName: "workspaceUseConversation"; visible: pane.roots.length > 0 && !pane.roots.some(r => r.kind === "conversation"); implicitWidth: Theme.controlHeight; text: ""; iconName: "projects"
                help: "A private folder PAL keeps for this conversation; export what it produces later"; Accessible.name: "Use a private conversation workspace"; onClicked: pane.useConversation() }
            CButton { objectName: "workspaceFolderSettings"; visible: !!pane.root; implicitWidth: Theme.controlHeight; text: ""; iconName: "settings"; help: "Folder permissions"; Accessible.name: "Folder permissions"; onClicked: pane.settingsRequested(pane.root) }
        }
        ColumnLayout {
            visible: !pane.roots.length && !!pane.sessionId
            Layout.fillWidth: true; Layout.fillHeight: false; Layout.topMargin: Theme.space2
            spacing: Theme.space2
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space2
                CIcon { name: "projects"; color: Theme.accentText }
                CText { text: qsTr("Workspace folders"); font.pixelSize: Theme.section; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
            }
            CText {
                text: qsTr("Choose a folder to browse its files, or give this conversation its own private workspace.")
                color: Theme.muted; font.pixelSize: Theme.secondary
            }
            Flow {
                Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: pane.width; Layout.maximumWidth: pane.width; spacing: Theme.space1
                CButton { objectName: "workspaceChooseFolder"; text: qsTr("Choose folder…"); iconName: "plus"; primary: true; onClicked: pane.chooseFolder() }
                CButton { objectName: "workspaceConversationFolder"; text: qsTr("Use private workspace"); help: qsTr("Create a private folder for this conversation"); onClicked: pane.useConversation() }
            }
        }
        CText { visible: !!pane.root && pane.root.status === "missing"; text: "This folder is not available right now. If it is on a removable drive, connect it again."; color: Theme.amber; font.pixelSize: Theme.secondary }
        CText { visible: !!pane.root && pane.root.status === "replaced"; text: "A different folder now sits at this location. Remove it and choose it again to continue."; color: Theme.amber; font.pixelSize: Theme.secondary }
        Flow {
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: pane.width; Layout.maximumWidth: pane.width; spacing: Theme.space1; visible: !!pane.root
            CButton { objectName: "crumbRoot"; quiet: true; implicitHeight: Theme.compactHeight; width: Math.min(implicitWidth, pane.width); text: pane.root ? pane.root.name : ""; onClicked: pane.goTo(-1) }
            Repeater {
                model: pane.crumbs
                RowLayout {
                    required property string modelData; required property int index
                    spacing: Theme.space1
                    CText { Layout.fillWidth: false; text: "/"; color: Theme.muted }
                    CButton { quiet: true; implicitHeight: Theme.compactHeight; Layout.maximumWidth: Math.max(Theme.fieldTiny, pane.width - Theme.space4); text: modelData; Accessible.name: "Open " + modelData; onClicked: pane.goTo(index) }
                }
            }
        }
        Item {
            visible: !!pane.root; Layout.fillWidth: true; Layout.minimumWidth: 0
            implicitHeight: searchLayout.implicitHeight
            GridLayout {
                id: searchLayout
                anchors.left: parent.left; anchors.right: parent.right
                columns: pane.width < Theme.toolbarBreakpoint ? 3 : 4
                rowSpacing: Theme.space1; columnSpacing: Theme.space1
                CField {
                    id: filterField; objectName: "workspaceFilter"
                    Layout.columnSpan: pane.width < Theme.toolbarBreakpoint ? 3 : 1; Layout.fillWidth: true
                    placeholderText: qsTr("Filter names"); Accessible.name: qsTr("Filter names in this folder")
                    onTextEdited: pane.results = null
                }
                CField {
                    id: searchField; objectName: "workspaceSearch"; Layout.fillWidth: true
                    placeholderText: qsTr("Search contents"); Accessible.name: qsTr("Search file contents")
                    onAccepted: pane.runSearch()
                    onTextEdited: if (!text.trim()) pane.results = null
                }
                CCheckBox { id: regexMode; Layout.fillWidth: false; implicitWidth: Theme.fieldTiny; text: "Regex"; Accessible.name: qsTr("Regular expression search") }
                CButton { objectName: "workspaceSearchRun"; iconName: "search"; help: qsTr("Search file contents"); enabled: !pane.loading && !!searchField.text.trim(); onClicked: pane.runSearch() }
            }
        }
        CText { visible: !!pane.error; text: pane.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        GridLayout {
            visible: !!pane.results; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: pane.width; Layout.maximumWidth: pane.width
            columns: pane.width < Theme.toolbarBreakpoint ? 1 : 2
            rowSpacing: Theme.space1; columnSpacing: Theme.space2
            CText {
                objectName: "workspaceSearchSummary"
                text: pane.results ? (pane.results.files.length + " file" + (pane.results.files.length === 1 ? "" : "s") + " with matches" + (pane.results.complete ? "" : " · stopped at " + pane.results.stoppedBecause + ", so this is not every match")) : ""
                color: pane.results && !pane.results.complete ? Theme.amber : Theme.muted; font.pixelSize: Theme.secondary
            }
            CButton { Layout.alignment: Qt.AlignLeft; text: qsTr("Back to files"); iconName: "back"; quiet: true; onClicked: pane.results = null }
        }
        ListView {
            id: entries; objectName: "workspaceEntries"
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorMedium; clip: true; spacing: Theme.space1
            visible: !!pane.root && !pane.results
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            model: (pane.listing.entries || []).filter(e => !filterField.text || e.name.toLowerCase().indexOf(filterField.text.toLowerCase()) >= 0)
            keyNavigationEnabled: true; activeFocusOnTab: true
            Keys.onReturnPressed: if (currentIndex >= 0) pane.open(model[currentIndex])
            delegate: ItemDelegate {
                required property var modelData; required property int index
                objectName: "workspaceEntry_" + modelData.name
                width: entries.width - Theme.minimumTarget; height: Theme.controlHeight
                highlighted: entries.currentIndex === index
                Accessible.name: (modelData.type === "directory" ? "Folder " : modelData.type === "file" ? "File " : modelData.type + " ") + modelData.name
                background: Rectangle { radius: Theme.radiusControl; color: parent.highlighted || parent.hovered ? Theme.raised : Theme.transparent }
                onClicked: { entries.currentIndex = index; pane.open(modelData) }
                contentItem: RowLayout {
                    spacing: Theme.space2
                    CIcon { name: modelData.type === "directory" ? "projects" : modelData.type === "symlink" ? "arrow" : "file"; Layout.preferredWidth: Theme.iconSize; Layout.preferredHeight: Theme.iconSize }
                    CText { Layout.fillWidth: true; text: modelData.name; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; color: modelData.excluded || modelData.credential ? Theme.muted : Theme.text }
                    CText { Layout.fillWidth: false; Layout.maximumWidth: pane.width < Theme.toolbarBreakpoint ? Math.max(Theme.fieldTiny, pane.width * 0.36) : 16777215; text: [modelData.credential ? "credential" : "", modelData.excluded ? "skipped by search" : "", modelData.type === "symlink" ? "link, not followed" : "", modelData.links ? modelData.links + " links" : "",
                        modelData.type === "file" ? pane.size(modelData.size) : "", ["fifo","socket","device","other"].indexOf(modelData.type) >= 0 ? "special file" : ""].filter(s => s).join(" · ")
                        color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                }
            }
            footer: ColumnLayout {
                width: entries.width - Theme.minimumTarget; spacing: Theme.space1
                CButton { visible: !!pane.listing.nextCursor; Layout.fillWidth: true; quiet: true; text: "Show more"; onClicked: pane.load(true) }
                CText { visible: (pane.listing.hiddenSkipped || 0) > 0; text: pane.listing.hiddenSkipped + " hidden item" + (pane.listing.hiddenSkipped === 1 ? " is" : "s are") + " not shown. Turn on hidden files in the folder permissions to list them."; color: Theme.muted; font.pixelSize: Theme.caption }
                CText { visible: (pane.listing.unreadableNames || 0) > 0; text: pane.listing.unreadableNames + " item(s) with names PAL cannot display are not shown."; color: Theme.muted; font.pixelSize: Theme.caption }
                CText { visible: !!filterField.text && !!pane.listing.entries?.length && !entries.count; text: qsTr("No names match this filter."); color: Theme.muted; font.pixelSize: Theme.secondary }
                CText { visible: !pane.loading && pane.listing.entries && !pane.listing.entries.length; text: "This folder is empty."; color: Theme.muted; font.pixelSize: Theme.secondary }
            }
        }
        ListView {
            id: matches; objectName: "workspaceMatches"
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorMedium; clip: true; spacing: Theme.space2
            visible: !!pane.results
            ScrollBar.vertical: CScrollBar {}
            model: pane.results ? pane.results.files : []
            delegate: ColumnLayout {
                id: fileRow
                required property var modelData
                width: matches.width - Theme.space3; spacing: Theme.space1
                CButton { Layout.fillWidth: true; quiet: true; alignLeft: true; implicitHeight: Theme.compactHeight; text: modelData.path; Accessible.name: "Open " + modelData.path; onClicked: WorkbenchState.openFile(pane.sessionId, pane.root.id, modelData.path, modelData.matches[0]?.line || 1) }
                Repeater {
                    model: modelData.matches
                    CButton {
                        required property var modelData
                        Layout.fillWidth: true; quiet: true; alignLeft: true; implicitHeight: Theme.compactHeight; font.family: Theme.mono; font.pixelSize: Theme.caption
                        text: modelData.line + "  " + modelData.text
                        Accessible.name: "Line " + modelData.line + ": " + modelData.text
                        onClicked: WorkbenchState.openFile(pane.sessionId, pane.root.id, fileRow.modelData.path, modelData.line)
                    }
                }
            }
        }
        Item { visible: !pane.root; Layout.fillHeight: true }
    }
}
