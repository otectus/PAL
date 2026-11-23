import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// The Workbench: Files, Preview, Changes, Images, Runs and Terminal for the selected conversation. In the expanded
// workspace it sits beside the chat; in the compact panel it is one focused sheet with a way back.
Rectangle {
    id: bench
    objectName: "workbench"
    property bool compact: false
    property bool focusedPane: false
    signal focusRequested()
    readonly property bool tabsVisible: compact ? panesExpanded : WorkbenchState.layout.showPaneTabs
    readonly property string sessionId: App.selectedId
    readonly property var session: App.session || ({})
    readonly property bool managed: ["ollama", "openai", "anthropic", "google", "compatible"].indexOf(session.provider || "") >= 0
    readonly property var capabilities: session.capabilities || ({})
    readonly property var tabs: [
        { id: "files", label: "Files", icon: "projects" }, { id: "preview", label: "Preview", icon: "file" },
        { id: "changes", label: "Changes" + (pendingChanges ? " · " + pendingChanges : ""), icon: "edit" },
        { id: "images", label: "Images", icon: "image" }, { id: "runs", label: "Runs", icon: "workflow" }, { id: "terminal", label: "Terminal", icon: "terminal" }, { id: "research", label: "Research", icon: "search" }, { id: "canvas", label: "Canvas", icon: "desktop" }, { id: "notes", label: "Notes", icon: "memory" }, { id: "shelf", label: "Shelf", icon: "star" } ]
    readonly property int pendingChanges: (App.state.workbench?.pendingChanges || []).filter(p => p.sessionId === sessionId).length
    property var roots: []
    property var grants: []
    property bool panesExpanded: false
    property bool permissionsExpanded: false
    property var approvalAccess:null
    property string approvalError:""
    signal closeRequested()
    signal settingsRequested(string category,string target)
    readonly property bool docked: !compact && !focusedPane
    readonly property bool narrowHeader: compact && width < Theme.narrowPane
    readonly property string currentPaneLabel: tabs[paneIndex(WorkbenchState.tab)].label
    color: docked ? Theme.sidebar : Theme.background
    Rectangle {
        objectName: "workbenchSeam"; visible: bench.docked
        anchors.left: parent.left; height: parent.height; width: Theme.hairline
        color: Theme.subtle
    }
    Accessible.role: Accessible.Pane; Accessible.name: "Workbench"
    // A conversation a limited phone controls keeps its Workbench paused; the desktop and an owner phone share it.
    readonly property bool limitedRemote: !!session.remote && session.remote.role !== "owner"
    readonly property bool canBrowse: !!sessionId && session.id === sessionId && !session.temporary && !limitedRemote
    property bool initialized: false
    RpcClient { id: rpc; scope: bench.canBrowse ? bench.sessionId : "" }
    Timer {
        id: loadVisiblePane
        interval: 0
        onTriggered: {
            if (!bench.initialized || !bench.visible || !bench.canBrowse) return
            bench.refreshRoots()
            bench.ensurePane()
        }
    }
    function refreshRoots() {
        if (!sessionId) { roots = []; grants = []; return }
        rpc.call("workspace.roots", { sessionId: sessionId }, value => { if (!value.error) { roots = value.roots || []; grants = value.grants || [] } })
    }
    readonly property var paneLoaders: [filesLoader, previewLoader, changesLoader, imagesLoader, runsLoader, terminalLoader, researchLoader, canvasLoader, notesLoader, shelfLoader]
    function paneIndex(tab) { return Math.max(0, tabs.findIndex(t => t.id === tab)) }
    function focusActiveTab() {
        const active = tabRepeater.itemAt(paneIndex(WorkbenchState.tab))
        if (tabsVisible && active) active.forceActiveFocus(Qt.ShortcutFocusReason)
        else paneListButton.forceActiveFocus(Qt.ShortcutFocusReason)
    }
    function selectPane(index) {
        const next = Math.max(0, Math.min(tabs.length - 1, index))
        WorkbenchState.tab = tabs[next].id
        Qt.callLater(() => {
            const active = tabRepeater.itemAt(next)
            if (active) active.forceActiveFocus(Qt.TabFocusReason)
        })
    }
    function handlePaneKey(event, index) {
        if (event.key === Qt.Key_Left) selectPane(index - 1)
        else if (event.key === Qt.Key_Right) selectPane(index + 1)
        else if (event.key === Qt.Key_Up || event.key === Qt.Key_Down)
            selectPane(paneGrid.verticalNeighbor(index, event.key === Qt.Key_Up ? -1 : 1))
        else if (event.key === Qt.Key_Home) selectPane(0)
        else if (event.key === Qt.Key_End) selectPane(tabs.length - 1)
        else return
        event.accepted = true
    }
    function resetPanes() {
        if (notesLoader.item) notesLoader.item.save()
        for (const loader of paneLoaders) loader.source = ""
    }
    function ensurePane() {
        if (!initialized || !visible || !canBrowse) return
        const index = paneIndex(WorkbenchState.tab), loader = paneLoaders[index]
        if (loader.status !== Loader.Null) return
        const selectedSession = sessionId, selectedTab = WorkbenchState.tab
        Qt.callLater(() => {
            if (!bench.visible || !bench.canBrowse || bench.sessionId !== selectedSession || WorkbenchState.tab !== selectedTab || loader.status !== Loader.Null) return
            const properties = { sessionId: selectedSession }
            if (selectedTab === "terminal") properties.app = App
            if (selectedTab === "preview") properties.roots = filesLoader.item ? filesLoader.item.roots : bench.roots
            loader.setSource(loader.paneSource, properties)
        })
    }
    function setCapability(family, on) {
        const next = Object.assign({}, capabilities); if (on) next[family] = true; else delete next[family]
        rpc.call("session.capabilities", { id: sessionId, capabilities: next }, value => { if (value.error) capabilityError.text = value.error; else capabilityError.text = "" })
    }
    function requestCapability(family,on) {
        if(family==="host"&&on){reviewHostAccess();return}
        setCapability(family,on)
    }
    function reviewHostAccess(){
        approvalAccess=null;approvalError="";hostReview.open()
        const inspectedSession=sessionId
        rpc.call("permissions.inspect",{sessionId:inspectedSession},value=>{
            if(bench.sessionId!==inspectedSession)return
            if(value.error){approvalError=value.error;return}
            approvalAccess=(value.effective||[]).find(row=>row.sessionId===inspectedSession)||null
            if(!approvalAccess)approvalError="PAL could not confirm the current approval rule for this conversation."
        })
    }
    function capabilitySummary(){const names=[capabilities.files?"Files":"",capabilities.images?"Images":"",capabilities.analysis?"Analysis":"",capabilities.host?"Host commands":""].filter(value=>value);return "Model access · "+(names.length?names.join(", "):"none")}
    function approvalRule(){
        if(!approvalAccess)return approvalError||"Checking the current approval rule…"
        return approvalAccess.cli?("Effective now: commands may proceed without another prompt"+(approvalAccess.expiresAt?" until "+new Date(approvalAccess.expiresAt).toLocaleTimeString(Qt.locale(),Locale.ShortFormat):"")+"."):"Effective now: each command asks for approval before it runs."
    }
    onSessionIdChanged: {
        if (!initialized) return
        rootSettings.close()
        hostReview.close()
        rootSettings.sessionId = ""
        WorkbenchState.activateSession(sessionId)
        roots = []
        grants = []
        approvalAccess = null
        approvalError = ""
        permissionsExpanded = false
        capabilityError.text = ""
        resetPanes()
        loadVisiblePane.restart()
    }
    onCanBrowseChanged: {
        if (!initialized) return
        if (canBrowse) loadVisiblePane.restart()
        else { rootSettings.close(); hostReview.close(); approvalAccess = null; approvalError = ""; permissionsExpanded = false; resetPanes(); roots = []; grants = [] }
    }
    onVisibleChanged: if (initialized && visible) loadVisiblePane.restart()
    onRootsChanged: if (previewLoader.item) previewLoader.item.roots = roots
    Component.onCompleted: {
        initialized = true
        WorkbenchState.activateSession(sessionId)
        loadVisiblePane.restart()
    }
    Connections { target: WorkbenchState; function onTabChanged() { bench.ensurePane(); Qt.callLater(picker.revealCurrent); paneScroll.contentY = 0 } }
    Keys.onEscapePressed: focusedPane ? focusRequested() : closeRequested()

    ColumnLayout {
        anchors.fill: parent; anchors.margins: bench.compact ? 0 : Theme.space3; spacing: Theme.space2
        RowLayout {
            id: header
            Layout.fillWidth: true; spacing: Theme.space2
            Layout.topMargin: bench.docked ? Theme.space2 : 0
            CButton {
                objectName: "workbenchBack"; visible: bench.compact; iconName: "back"; quiet: true
                text: bench.narrowHeader ? "" : qsTr("Chat"); help: qsTr("Back to the conversation")
                implicitHeight: Theme.compactHeight
                Layout.preferredWidth: bench.narrowHeader ? Theme.compactHeight : implicitWidth
                leftPadding: bench.narrowHeader ? 0 : Theme.space3; rightPadding: leftPadding
                onClicked: bench.closeRequested()
            }
            CIcon { visible: bench.docked; name: "workbench"; color: Theme.muted }
            CText { text: bench.narrowHeader && !bench.tabsVisible ? bench.currentPaneLabel : qsTr("Workbench"); font.pixelSize: Theme.section; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            CButton {
                id: paneListButton; objectName: "workbenchPaneList"; quiet: true; implicitHeight: Theme.compactHeight
                leftPadding: bench.narrowHeader ? Theme.space1 : Theme.space3; rightPadding: leftPadding
                iconName: bench.tabsVisible ? "down" : "chevron"
                text: bench.narrowHeader || (bench.tabsVisible && !paneGrid.iconOnly) ? qsTr("Panes") : bench.currentPaneLabel
                help: bench.tabsVisible ? qsTr("Collapse pane list") : qsTr("Choose a Workbench pane")
                Accessible.expanded: bench.tabsVisible
                onClicked: {
                    if (bench.compact) bench.panesExpanded = !bench.panesExpanded
                    else WorkbenchState.layout.showPaneTabs = !WorkbenchState.layout.showPaneTabs
                    if (bench.tabsVisible) Qt.callLater(picker.revealCurrent)
                }
            }
            CButton {
                objectName: "workbenchFocus"; visible: !bench.compact; quiet: true
                iconName: bench.focusedPane ? "restore" : "expand"; implicitHeight: Theme.compactHeight
                help: bench.focusedPane ? qsTr("Restore split view") : qsTr("Expand Workbench")
                onClicked: bench.focusRequested()
            }
        }
        Flickable {
            id: picker
            visible: bench.tabsVisible
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(paneGrid.height, Math.max(Theme.compactHeight,
                header.parent.height - header.height - Theme.editorShort - Theme.space5))
            Layout.minimumHeight: Layout.preferredHeight
            clip: true; contentWidth: width; contentHeight: paneGrid.height
            layer.enabled: scrolls && GraphicsInfo.api === GraphicsInfo.Software
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.VerticalFlick
            readonly property bool scrolls: contentHeight > height + Theme.hairline
            interactive: scrolls
            ScrollBar.vertical: CScrollBar {}
            function revealCurrent() {
                revealTab(tabRepeater.itemAt(bench.paneIndex(WorkbenchState.tab)))
            }
            function revealTab(tab) {
                if (!tab || !visible) return
                if (tab.y < contentY) contentY = tab.y
                else if (tab.y + tab.height > contentY + height)
                    contentY = Math.max(0, tab.y + tab.height - height)
            }
            onVisibleChanged: if (visible) Qt.callLater(revealCurrent)
            onHeightChanged: Qt.callLater(revealCurrent)
            Item {
                id: paneGrid
                objectName: "workbenchNavigation"
                width: picker.width
                height: implicitHeight
                implicitHeight: rows * Theme.compactHeight + (rows - 1) * gap
                readonly property real gap: Theme.space1
                readonly property real inset: picker.scrolls ? Theme.minimumTarget : 0
                readonly property bool iconOnly: bench.height < Theme.compactPane && width < Theme.fullToolbar
                readonly property bool labelOnly: !iconOnly && cellWidth < Theme.fieldShort
                readonly property int fittingColumns: Math.max(1, Math.floor((width + gap) /
                    ((iconOnly || width <= Theme.narrowPane ? Theme.compactHeight : Theme.fieldShort) + gap)))
                readonly property int columns: width <= Theme.narrowPane ? Math.min(3, fittingColumns)
                    : fittingColumns >= bench.tabs.length ? bench.tabs.length : Math.min(Math.ceil(bench.tabs.length / 2), fittingColumns)
                readonly property int rows: Math.ceil(bench.tabs.length / columns)
                readonly property real cellWidth: Math.max(0, (width - 2 * inset - (columns - 1) * gap) / columns)
                function rowSize(row) { return Math.min(columns, bench.tabs.length - row * columns) }
                function columnOf(index) {
                    return index % columns + (columns - rowSize(Math.floor(index / columns))) / 2
                }
                function verticalNeighbor(index, step) {
                    const row = Math.floor(index / columns) + step
                    if (row < 0 || row >= rows) return index
                    const count = rowSize(row)
                    const aligned = Math.round(columnOf(index) - (columns - count) / 2)
                    return row * columns + Math.max(0, Math.min(count - 1, aligned))
                }
                Accessible.role: Accessible.PageTabList
                Accessible.name: qsTr("Workbench panes")
                Accessible.description: qsTr("Use the arrow keys to move between panes.")
                Repeater {
                    id:tabRepeater
                    model: bench.tabs
                    SidebarTab {
                        required property var modelData
                        required property int index
                        objectName: "workbenchTab_" + modelData.id
                        x: paneGrid.inset + paneGrid.columnOf(index) * (width + paneGrid.gap)
                        y: Math.floor(index / paneGrid.columns) * (height + paneGrid.gap)
                        width: paneGrid.cellWidth; height: Theme.compactHeight
                        label: modelData.label; iconName: paneGrid.labelOnly ? "" : modelData.icon; iconOnly: paneGrid.iconOnly
                        alignLeft: true
                        leftPadding: Theme.space2; rightPadding: leftPadding
                        primary: WorkbenchState.tab === modelData.id
                        onClicked: { WorkbenchState.tab = modelData.id; if (bench.compact) { bench.panesExpanded = false; paneListButton.forceActiveFocus() } }
                        onActiveFocusChanged: if (activeFocus) picker.revealTab(this)
                        Keys.onPressed: event => bench.handlePaneKey(event, index)
                    }
                }
            }
        }
        Rectangle { Layout.fillWidth: true; implicitHeight: Theme.hairline; color: Theme.subtle }
        Flickable {
            id: paneScroll; objectName: "workbenchScroll"
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: 0
            clip: true; contentWidth: width; contentHeight: contents.height
            // The software Shapes renderer otherwise paints scrolled icons over the pane chooser.
            layer.enabled: GraphicsInfo.api === GraphicsInfo.Software
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.VerticalFlick
            readonly property real scrollGutter: contentHeight > height + Theme.hairline ? Theme.minimumTarget : 0
            ScrollBar.vertical: CScrollBar {}
            function revealFocus() {
                const field = Window.window?.activeFocusItem
                if (!field) return
                let ancestor = field
                while (ancestor && ancestor !== contents) ancestor = ancestor.parent
                if (!ancestor || field.height > height || !scrollGutter) return
                const top = field.mapToItem(contents, 0, 0).y
                if (top < contentY) contentY = Math.max(0, top)
                else if (top + field.height > contentY + height)
                    contentY = Math.min(contentHeight - height, top + field.height - height)
            }
            Connections {
                target: paneScroll.Window.window
                function onActiveFocusItemChanged() { Qt.callLater(paneScroll.revealFocus) }
            }
            ColumnLayout {
                id: contents
                width: Math.max(0, paneScroll.width - paneScroll.scrollGutter)
                height: Math.max(paneScroll.height, Layout.minimumHeight)
                spacing: Theme.space2
                CText { visible: !bench.sessionId; text: "Open a conversation to use the Workbench."; color: Theme.muted }
                CText { visible: !!bench.session.temporary; text: "Temporary conversations stay text-only: files, images and runs need a saved conversation."; color: Theme.amber; font.pixelSize: Theme.secondary }
                CText { visible: bench.limitedRemote; text: "A phone with limited access controls this conversation. Its Workbench returns when you detach the phone."; color: Theme.amber; font.pixelSize: Theme.secondary }
                CText { visible: !!bench.session.remote && !bench.limitedRemote; text: "Continued from your phone · the same files, runs and terminals are available here."; color: Theme.muted; font.pixelSize: Theme.caption }
                ColumnLayout {
                    visible: bench.managed && !bench.session.temporary && !bench.limitedRemote; Layout.fillWidth: true; spacing: Theme.space1
                    CButton {
                        objectName: "modelAccessToggle"; Layout.fillWidth: true
                        alignLeft: true; leftPadding: 0; implicitHeight: Theme.compactHeight
                        iconName: "shield"; quiet: true; Accessible.expanded: bench.permissionsExpanded
                        text: bench.permissionsExpanded ? qsTr("Hide model access") : bench.capabilitySummary()
                        onClicked: bench.permissionsExpanded = !bench.permissionsExpanded
                    }
                    Flow {
                        visible:bench.permissionsExpanded
                        Layout.fillWidth: true; spacing: Theme.space2
                        CText { width: implicitWidth; height: Theme.compactHeight; verticalAlignment: Text.AlignVCenter; text: "The model may use"; color: Theme.muted; font.pixelSize: Theme.secondary }
                        CCheckBox { objectName: "capabilityFiles"; width: implicitContentWidth + leftPadding + rightPadding; text: "Files"; checked: !!bench.capabilities.files; onClicked: { const on=checked;checked=Qt.binding(()=>!!bench.capabilities.files);bench.requestCapability("files",on) } Accessible.name: "Let the model use workspace files" }
                        CCheckBox { objectName: "capabilityImages"; width: implicitContentWidth + leftPadding + rightPadding; text: "Images"; checked: !!bench.capabilities.images; onClicked: { const on=checked;checked=Qt.binding(()=>!!bench.capabilities.images);bench.requestCapability("images",on) } Accessible.name: "Let the model create and edit images" }
                        CCheckBox { objectName: "capabilityAnalysis"; width: implicitContentWidth + leftPadding + rightPadding; text: "Analysis"; checked: !!bench.capabilities.analysis; onClicked: { const on=checked;checked=Qt.binding(()=>!!bench.capabilities.analysis);bench.requestCapability("analysis",on) } Accessible.name: "Let the model run analysis code" }
                        CCheckBox { objectName: "capabilityHost"; width: implicitContentWidth + leftPadding + rightPadding; text: "Host commands"; checked: !!bench.capabilities.host; onClicked: { const on=checked;checked=Qt.binding(()=>!!bench.capabilities.host);bench.requestCapability("host",on) } Accessible.name: "Let the model run commands on this computer as your account" }
                    }
                    CText { visible: bench.permissionsExpanded&&!!bench.capabilities.host; Layout.fillWidth: true; wrapMode: Text.Wrap; text: "Host commands run as your desktop account, not in Code Lab’s sandbox: they can reach your files, keys and network. "+bench.approvalRule(); color: Theme.amber; font.pixelSize: Theme.caption }
                    CText { visible:bench.permissionsExpanded;text: "You can always use the Workbench yourself; these only decide what the model is offered."; color: Theme.muted; font.pixelSize: Theme.caption }
                    CText { id: capabilityError; visible: !!text; color: Theme.danger; font.pixelSize: Theme.caption }
                }
                StackLayout {
                    Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumWidth: 0
                    readonly property Item pane: bench.paneLoaders[currentIndex]?.item ?? null
                    Layout.minimumHeight: visible ? Math.max(Theme.editorShort, pane ? pane.implicitHeight : 0) : 0
                    visible: !!bench.sessionId && !bench.session.temporary && !bench.limitedRemote
                    currentIndex: bench.paneIndex(WorkbenchState.tab)
                    Loader { id: filesLoader; readonly property url paneSource: "WorkspaceFiles.qml" }
                    Loader { id: previewLoader; readonly property url paneSource: "FilePreview.qml" }
                    Loader { id: changesLoader; readonly property url paneSource: "ChangeReview.qml" }
                    Loader { id: imagesLoader; readonly property url paneSource: "ArtifactBrowser.qml" }
                    Loader { id: runsLoader; readonly property url paneSource: "RunsPane.qml" }
                    Loader { id: terminalLoader; readonly property url paneSource: "TerminalPane.qml" }
                    Loader { id: researchLoader; readonly property url paneSource: "ResearchPane.qml" }
                    Loader { id: canvasLoader; readonly property url paneSource: "CanvasPane.qml" }
                    Loader { id: notesLoader; readonly property url paneSource: "NotesPane.qml" }
                    Loader { id: shelfLoader; readonly property url paneSource: "ProjectShelf.qml" }
                }
            }
        }
        Connections {
            target: filesLoader.item
            ignoreUnknownSignals: true
            function onSettingsRequested(root) { rootSettings.openFor(bench.sessionId, root, bench.grants) }
            function onRootsChanged() { if (previewLoader.item) previewLoader.item.roots = filesLoader.item.roots }
        }
        Connections { target:terminalLoader.item;ignoreUnknownSignals:true;function onLeaveRequested(){bench.focusActiveTab()} }
        Connections { target:researchLoader.item;ignoreUnknownSignals:true;function onSettingsRequested(category,target){bench.settingsRequested(category,target)} }
    }
    RootSettings { id: rootSettings; onSaved: { if (filesLoader.item) filesLoader.item.refreshRoots(); bench.refreshRoots() } }
    CDialog {
        id:hostReview;accessibleTitle:"Review host command access"
        CText { text:"Run commands as your desktop account?";font.pixelSize:Theme.title;font.weight:Font.DemiBold;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { text:"Conversation · "+(bench.session.title||"Untitled conversation")+"\nProject · "+(bench.session.cwd||"No project folder");wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { text:"The model can propose commands that run outside Code Lab’s sandbox with access to your desktop account’s files, keys and network. Review command text carefully.";color:Theme.amber;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { text:bench.approvalRule();color:Theme.amber;font.weight:Font.DemiBold;wrapMode:Text.Wrap;Layout.fillWidth:true }
        RowLayout { Layout.fillWidth:true
            CButton { objectName:"cancelCapabilityHost";text:"Keep off";Layout.fillWidth:true;onClicked:hostReview.close() }
            CButton { objectName:"confirmCapabilityHost";text:"Allow host commands";primary:true;Layout.fillWidth:true;enabled:!!bench.approvalAccess&&!bench.approvalError;onClicked:{bench.setCapability("host",true);hostReview.close()} }
        }
    }
}
