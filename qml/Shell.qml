import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
Rectangle {
    id: shell
    objectName: "workspaceShell"
    property bool expanded: false
    property int page: 0
    property int workflowsReturnPage: 4
    property int workflowsTab: 0
    readonly property var tabs: [
        {key:"Chat", label:qsTr("Chat"), icon:"chat", page:0},
        {key:"Sessions", label:qsTr("Sessions"), icon:"sessions", page:1},
        {key:"Projects", label:qsTr("Projects"), icon:"projects", page:4},
        {key:"Desktop", label:qsTr("Desktop"), icon:"desktop", page:2},
        {key:"Settings", label:qsTr("Settings"), icon:"settings", page:3}
    ]
    property real pageOffset: 0
    // Reduced motion, quiet mode and zero intensity keep page changes instant (Theme.duration is then 0).
    readonly property bool animateNavigation: !expanded && Theme.navigationDuration > 0
    onPageChanged: { pageSlide.stop();pageOffset=0;syncApprovals() }
    onAnimateNavigationChanged: if(!animateNavigation){pageSlide.stop();pageOffset=0}
    function revealConversation() {
        // A Workbench explicitly opened on a narrow surface is a sheet over Chat. Choosing a
        // conversation or its Chat tab means reveal the transcript; keep dockOpen unchanged so
        // the person's saved split Workbench still returns in a wide workspace.
        if(!shell.wide){
            shell.workbenchFocused=false
            WorkbenchState.hide()
        }
    }
    function openConversation() {
        const fromSessions=page===1
        shell.revealConversation()
        page=0
        if(fromSessions&&animateNavigation){pageSlide.from=pageViewport.width;pageSlide.restart()}
        Qt.callLater(()=>conversation.focusComposer())
    }
    function showSessions() {
        page=1
        if(animateNavigation){pageSlide.from=-pageViewport.width;pageSlide.restart()}
        sessionsPage.ensure().focusSearch()
    }
    function navigate(target) {
        if(target===5){showWorkflows(0);return}
        if(target===0)shell.revealConversation()
        page=target
        App.rpc("navigation.record",{id:["page:chat","page:sessions","page:desktop","page:settings","page:projects","page:workflows"][target]})
        if(target===0)Qt.callLater(()=>conversation.focusComposer())
        else if(target===1)Qt.callLater(()=>sessionsPage.ensure().focusSearch())
        else if(target===2)Qt.callLater(()=>desktop.ensure().focusSearch())
        else if(target===3)Qt.callLater(()=>settingsPage.ensure().focusSearch())
        else if(target===4)Qt.callLater(()=>projectsPage.ensure().focusSearch())
    }
    function showWorkflows(tab) {
        if(page!==5)workflowsReturnPage=page
        const next=tab===undefined?0:tab
        workflowsTab=next
        page=5
        App.rpc("navigation.record",{id:"page:workflows"})
        Qt.callLater(()=>workflowsPage.ensure().openTab(next))
    }
    function closeWorkflows() {
        const target=workflowsReturnPage>=0&&workflowsReturnPage<5?workflowsReturnPage:4
        navigate(target)
    }
    function openFolder(id) { page=1;Qt.callLater(()=>sessionsPage.ensure().selectFolder(id)) }
    NumberAnimation { id:pageSlide;target:shell;property:"pageOffset";to:0;duration:Theme.navigationDuration;easing.type:Theme.easing }
    property var settings: App.state.settings || ({})
    property var sessions: App.state.sessions || []
    property var approvals: App.state.approvals || []
    property var globalApprovals: []
    property string approvalSessionId: App.selectedId
    function syncApprovals() {
        const next = approvals.filter(a => !(page===0 && a.sessionId===App.selectedId && (a.kind==="question" || (a.questions||[]).length>0)))
        if (JSON.stringify(next)!==JSON.stringify(globalApprovals)) globalApprovals=next
    }
    onApprovalsChanged: syncApprovals()
    onApprovalSessionIdChanged: syncApprovals()
    readonly property int activeAgents: sessions.reduce((count,s) => count+(s.agents||[]).filter(a => ["starting","running","waiting"].indexOf(a.status)>=0).length,0)
    readonly property int busySessions: sessions.filter(s => ["starting","working","stopping"].indexOf(s.status)>=0).length
    readonly property var power: App.state.power || []
    readonly property int activePower: power.filter(lease=>lease.state==="active").length
    readonly property int endingPower: power.filter(lease=>lease.state==="ending").length
    readonly property int unconfirmedPower: power.filter(lease=>lease.state==="unconfirmed").length
    readonly property string powerText: unconfirmedPower ? unconfirmedPower+" power session"+(unconfirmedPower===1?" needs":"s need")+" attention" : endingPower ? endingPower+" power session"+(endingPower===1?" is":"s are")+" ending" : activePower ? activePower+" power session"+(activePower===1?" is":"s are")+" active" : ""
    color: Theme.background
    radius: expanded ? 0 : Theme.radiusPanel
    border.color: Theme.line
    border.width: expanded ? 0 : Theme.hairline
    implicitWidth: expanded ? Theme.defaultWindowWidth : Theme.panelWidth; implicitHeight: expanded ? Theme.defaultWindowHeight : Theme.panelHeight
    focus: true
    Keys.onEscapePressed: { if(workbenchFocused)restoreSplit();else if(workbenchVisible&&page===0)closeWorkbench();else if(page===5)closeWorkflows();else if(page!==0)navigate(0);else App.closePanel() }
    Shortcut { sequence: "Ctrl+K"; onActivated: commandPalette.openPalette() }
    Shortcut { sequence: "Ctrl+N"; onActivated: shell.page===4?projectsPage.ensure().newProjectSession():newSession.open() }
    Shortcut { sequence: "Ctrl+,"; onActivated: shell.navigate(3) }
    readonly property bool wide: expanded && width >= Theme.workspaceBreakpoint
    readonly property bool defaultDock: workbench.canBrowse && WorkbenchState.layout.dockOpen
    readonly property bool workbenchVisible: page === 0 && (WorkbenchState.open || (wide && defaultDock))
    readonly property bool showWorkbenchToggle: page === 0 && (!!App.session.id || workbenchVisible)
    property bool workbenchFocused: false
    readonly property bool splitWorkbench: wide && workbenchVisible && !workbenchFocused
    readonly property int minSidebarWidth: Theme.sidebarMinimum
    readonly property int maxSidebarWidth: Math.min(Theme.sidebarLimit, width - (splitWorkbench ? Theme.paneMinimum + Theme.conversationMinimum : Theme.singleColumnMinimum))
    readonly property bool autoRail: splitWorkbench && maxSidebarWidth < minSidebarWidth
    readonly property bool rail: wide && (WorkbenchState.layout.collapsed || autoRail)
    readonly property int sidebarWidth: rail ? Theme.railWidth : Math.max(minSidebarWidth, Math.min(maxSidebarWidth, WorkbenchState.layout.sidebarWidth))
    readonly property real maxPaneWidth: Math.max(Theme.paneMinimum, Math.min(width * .58, width - sidebarWidth - Theme.conversationMinimum))
    readonly property real paneFooterSpace: workspaceFooter.reservedHeight + Theme.space2
    component WorkspaceGrip: PaneGrip {
        width: Theme.minimumTarget; height: parent.height; z: 1
        anchors.top: parent.top
        anchors.horizontalCenter: reversed ? parent.left : parent.right
        coordinateSpace: shell
        showIdleIndicator: false
    }
    function restoreSplit() {
        workbenchFocused = false
        Qt.callLater(() => workbench.focusActiveTab())
    }
    function closeWorkbench() {
        workbenchFocused = false
        if (wide) WorkbenchState.layout.dockOpen = false
        WorkbenchState.hide()
        Qt.callLater(() => conversation.focusComposer())
    }
    function toggleWorkbench() {
        if (workbenchVisible) closeWorkbench()
        else WorkbenchState.show("")
    }
    onWideChanged: if (!wide) workbenchFocused = false
    onWorkbenchVisibleChanged: if (!workbenchVisible) workbenchFocused = false
    readonly property string statusText: App.brokerUnresponsive ? "PAL is not responding…" : !App.connected ? "Reconnecting…" : approvals.length ? approvals.length+" waiting for input" : busySessions ? busySessions+(busySessions===1?" conversation working":" conversations working") : "Ready"
    readonly property bool bypassActive: settings.bypassCliPermissions||settings.bypassComputerPermissions
    readonly property string permissionText: settings.paused?"Tools paused":bypassActive?[settings.bypassCliPermissions?"CLI bypass":"",settings.bypassComputerPermissions?"Computer bypass":""].filter(s=>s).join(" · "):settings.profile==="manual"?"Manual desktop controls":settings.profile==="broad"?"Broad control · project grants apply":(settings.categories||[]).length+" AI desktop categories enabled"
    // Paused tools and permission bypasses stay visible in the one-row compact header.
    readonly property string compactStatus: statusText+(settings.paused||bypassActive?" · "+permissionText:"")
    // The conversation's own error banner already says what failed there.
    readonly property bool toastVisible: App.toast.length>0&&!(page===0&&App.toast===(App.session.error||""))
    component HeaderPortrait: PALPortrait {
        avatar: App.avatar
        Layout.preferredWidth: shell.wide && !shell.rail ? Theme.avatarMedium : Theme.avatarSmall
        Layout.preferredHeight: Layout.preferredWidth
        settings: shell.settings
        session: App.session
        moodSource: ConversationMood.forSession(App.selectedId)
        approvals: shell.approvals
        speech: App.state.speech || ({})
        connected: App.connected
        listening: conversation.listening
        assetRoot: App.assetPath
        enabled:App.connected
        speechMuted:shell.settings.speechEnabled===false
        onActivated:App.rpc("settings.update",{speechEnabled:speechMuted})
    }
    RowLayout {
        enabled:!App.state.recoveryPending
        anchors.fill: parent
        anchors.margins: shell.expanded ? 0 : Theme.hairline
        spacing: 0
        Rectangle {
            id: sidebar
            visible: shell.wide
            Layout.preferredWidth: shell.sidebarWidth
            Layout.fillHeight: true
            color: Theme.sidebar
            Rectangle { anchors.right: parent.right; width: Theme.hairline; height: sidebarGrip.height; color: Theme.subtle }
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: shell.rail ? Theme.space2 : Theme.space3
                anchors.bottomMargin: sidebarFooter.height + Theme.space3 + Theme.space2
                spacing: Theme.space2
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: Theme.space2
                    Layout.bottomMargin: Theme.space2
                    spacing: Theme.space3
                    HeaderPortrait { Layout.alignment: Qt.AlignHCenter }
                    ColumnLayout {
                        visible: !shell.rail
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: Theme.space1
                        Text {
                            Layout.fillWidth: true; Layout.minimumWidth: 0
                            text: App.assistantName; textFormat: Text.PlainText; elide: Text.ElideRight
                            color: Theme.text; font.family: Theme.font; font.pixelSize: Theme.wordmark; font.weight: Font.DemiBold
                        }
                        CText { text: shell.statusText; color: App.connected && !shell.approvals.length ? Theme.muted : Theme.amber; font.pixelSize: Theme.caption }
                    }
                }
                GridLayout {
                    Layout.fillWidth: true
                    columns: shell.rail ? 1 : 2
                    columnSpacing: Theme.space1
                    rowSpacing: Theme.space1
                    CButton {
                        objectName: "sidebarNewSession"
                        Layout.fillWidth: true
                        text: shell.rail ? "" : qsTr("New session")
                        iconName: "plus"
                        alignLeft: !shell.rail
                        help: qsTr("Start a session (Ctrl+N)")
                        Accessible.name: qsTr("New session")
                        onClicked: newSession.open()
                    }
                    CButton {
                        objectName: "sidebarCommandPalette"
                        Layout.fillWidth: shell.rail
                        iconName: "search"
                        quiet: true
                        help: qsTr("Search PAL (Ctrl+K)")
                        Accessible.name: qsTr("Search PAL")
                        onClicked: commandPalette.openPalette()
                    }
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: Theme.space1
                    Repeater {
                        model: shell.tabs
                        SidebarTab {
                            required property var modelData
                            required property int index
                            objectName: "tab_" + modelData.key
                            label: modelData.label
                            iconOnly: shell.rail
                            iconName: modelData.icon
                            primary: shell.page === modelData.page
                            onClicked: shell.navigate(modelData.page)
                        }
                    }
                    SidebarTab {
                        objectName: "sidebarWorkflows"; label: qsTr("Project workflows"); iconName: "workflow"
                        iconOnly: shell.rail; primary: shell.page === 5
                        onClicked: shell.showWorkflows(0)
                    }
                }
                SessionList {
                    visible: !shell.rail && shell.page !== 1
                    Layout.fillWidth: true; Layout.fillHeight: true
                    Layout.topMargin: Theme.space3
                    compact: true
                    onCreateRequested: newSession.open()
                    onSessionActivated: shell.openConversation()
                }
                Item { visible: shell.rail || shell.page === 1; Layout.fillHeight: true }
                Rectangle { Layout.fillWidth: true; implicitHeight: Theme.hairline; color: Theme.subtle }
            }
            Item {
                id: sidebarFooter
                anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
                anchors.margins: Theme.space3
                implicitHeight: sidebarToggle.visible ? sidebarToggle.implicitHeight : 0
                PaneToggle {
                    id: sidebarToggle; objectName: "sidebarToggle"; visible: !shell.autoRail
                    anchors.left: parent.left; anchors.bottom: parent.bottom
                    paneOpen: !shell.rail; iconName: "sidebar"
                    help: paneOpen ? qsTr("Collapse sidebar") : qsTr("Expand sidebar")
                    onClicked: WorkbenchState.layout.collapsed = !WorkbenchState.layout.collapsed
                }
                CButton {
                    visible: !shell.rail; iconName: "hide"; implicitHeight: Theme.compactHeight
                    anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                    quiet: true; help: "Hide window"; onClicked: App.closePanel()
                }
            }
            WorkspaceGrip {
                id: sidebarGrip; objectName: "sidebarResize"
                visible: !shell.rail
                height: Math.max(0, parent.height - shell.paneFooterSpace)
                label: qsTr("Resize sidebar"); extent: sidebar.width
                minimum: shell.minSidebarWidth; maximum: shell.maxSidebarWidth
                onResized: size => WorkbenchState.layout.sidebarWidth = size
                onResetRequested: WorkbenchState.layout.sidebarWidth = Theme.sidebarDefault
            }
        }
        ColumnLayout {
            Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0
            Layout.margins:shell.wide ? (shell.splitWorkbench ? Theme.space3 : Theme.gutter) : Theme.space3
            Layout.bottomMargin: workspaceFooter.visible ? workspaceFooter.reservedHeight + spacing : Theme.space3
            spacing:shell.wide ? Theme.space3 : Theme.space2
            RowLayout {
                visible:!shell.wide
                Layout.fillWidth:true;spacing:Theme.space2
                HeaderPortrait {}
                ColumnLayout {
                    Layout.fillWidth:true;Layout.minimumWidth:0;spacing:Theme.space1
                    Text { Layout.fillWidth:true;Layout.minimumWidth:0;text:App.assistantName;textFormat:Text.PlainText;elide:Text.ElideRight;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.wordmark;font.weight:Font.DemiBold }
                    CText { objectName:"compactStatus";Layout.fillWidth:true;text:shell.compactStatus;color:!App.connected||settings.paused||shell.bypassActive?Theme.amber:Theme.muted;font.pixelSize:Theme.caption;maximumLineCount:1;elide:Text.ElideRight;Accessible.name:text }
                }
                CButton {
                    objectName:"openCommandPalette";implicitWidth:Theme.controlHeight;implicitHeight:Theme.controlHeight;leftPadding:Theme.space2;rightPadding:Theme.space2
                    quiet:true;help:"Search PAL (Ctrl+K)";Accessible.name:"Search PAL"
                    contentItem:CIcon { name:"search";color:Theme.text }
                    onClicked:commandPalette.openPalette()
                }
                CButton {
                    objectName:"shellPermissionCenter";implicitWidth:Theme.controlHeight;implicitHeight:Theme.controlHeight;leftPadding:Theme.space2;rightPadding:Theme.space2
                    quiet:true;help:"Permissions · "+shell.permissionText;Accessible.name:"Permissions"
                    contentItem:CIcon { name:"shield";color:settings.paused||shell.bypassActive?Theme.amber:Theme.text }
                    onClicked:permissionCenter.open()
                }
                CButton { objectName:"expandWindow";text:"";iconName:expanded?"hide":"expand";quiet:true;help:expanded?"Hide window":"Expand workspace";onClicked:expanded?App.closePanel():App.expand() }
            }
            RowLayout {
                visible:!shell.wide;Layout.fillWidth:true;spacing:Theme.space1
                Repeater {
                    model:shell.tabs
                    CButton {
                        required property var modelData;required property int index
                        id: compactTab
                        objectName:"tab_"+modelData.key;Layout.fillWidth:true;Layout.preferredWidth:1
                        help:modelData.label;quiet:true;primary:shell.page===modelData.page
                        leftPadding:Theme.space2;rightPadding:Theme.space2
                        Accessible.name:modelData.label;Accessible.role:Accessible.PageTab; Accessible.onPressAction: if (enabled) click();Accessible.selected:shell.page===modelData.page
                        implicitHeight: Theme.compactHeight
                        text: shell.width >= Theme.narrowPane ? modelData.label : ""
                        iconName: shell.width < Theme.narrowPane ? modelData.icon : ""
                        font.pixelSize: Theme.caption
                        onClicked:shell.navigate(modelData.page)
                    }
                }
            }

            RowLayout {
                visible:(App.state.remote?.connected||[]).length>0;Layout.fillWidth:true
                CText { text:"Remote connected: "+(App.state.remote?.connected||[]).map(d=>d.name).join(", ");color:Theme.amber;font.pixelSize:Theme.secondary }
                CButton { text:"Disable";danger:true;onClicked:App.rpc("remote.off",{}) }
            }
            Rectangle {
                visible:settings.paused;Layout.fillWidth:true;implicitHeight:pausedText.implicitHeight+Theme.gutter;radius:Theme.radiusControl;color:Theme.warningSurface;border.color:Theme.warningBorder
                CText { id:pausedText;anchors.fill:parent;anchors.margins:Theme.space2;text:"AI actions, search and memory are paused.";color:Theme.amber;font.pixelSize:Theme.secondary }
            }
            RowLayout {
                visible:!!App.state.recoveryWarning;Layout.fillWidth:true
                CText { Layout.fillWidth:true;text:App.state.recoveryWarning||"";color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
                CButton { text:"Dismiss";onClicked:App.rpc("recovery.dismissWarning",{}) }
            }
            Rectangle {
                visible:!shell.wide&&shell.powerText.length>0;Layout.fillWidth:true;implicitHeight:powerStatusRow.implicitHeight+Theme.gutter
                radius:Theme.radiusControl;color:shell.unconfirmedPower?Theme.dangerSurface:Theme.warningSurface;border.color:shell.unconfirmedPower?Theme.dangerBorder:Theme.warningBorder
                RowLayout {
                    id:powerStatusRow;x: Theme.space2;y: Theme.space2;width:parent.width-Theme.gutter;spacing:Theme.space2
                    CText { text:shell.powerText;color:shell.unconfirmedPower?Theme.danger:Theme.amber;font.pixelSize:Theme.secondary;font.weight:Font.DemiBold }
                    CButton { text:"Review";quiet:true;implicitHeight:Theme.compactHeight;onClicked:permissionCenter.open() }
                }
            }
            ScrollView {
                id:approvalsScroll;objectName:"globalApprovals";visible:shell.globalApprovals.length>0
                Layout.fillWidth:true;Layout.preferredHeight:Math.min(shell.height*.28,approvalColumn.implicitHeight)
                clip:true;contentWidth:availableWidth;contentHeight:approvalColumn.implicitHeight;rightPadding:Theme.space2
                ScrollBar.horizontal.policy:ScrollBar.AlwaysOff;ScrollBar.vertical:CScrollBar{}
                Column {
                    id:approvalColumn;width:approvalsScroll.availableWidth;spacing:Theme.space2
                    Repeater { model:shell.globalApprovals;ApprovalCard { required property var modelData;width:approvalColumn.width;approval:modelData } }
                }
            }
            Item {
                id:pageViewport
                Layout.fillWidth:true;Layout.fillHeight:true;Layout.minimumWidth:0;Layout.minimumHeight:Theme.editorMedium;clip:true
                StackLayout {
                    // Under the compact Workbench sheet the conversation is hidden, not just covered, so
                    // Tab and screen readers cannot reach a composer the person cannot see.
                    anchors.fill:parent;currentIndex:shell.page;visible:!workbenchSheet.visible
                    transform:Translate { x:shell.pageOffset }
                    Chat { id:conversation;showBackButton:!shell.wide
                        onBackRequested:shell.showSessions();onCreateRequested:newSession.open()
                        onNavigateRequested:target=>{if(target==="connections"){shell.navigate(3);settingsPage.ensure().open("connections","")}else if(target==="settings")shell.navigate(3);else if(target==="sessions")shell.showSessions();else if(target==="desktop")shell.navigate(2);else if(target==="new")newSession.open();else shell.navigate(0)} }
                    LazyPage {
                        id: sessionsPage; selected: shell.page === 1; pageSource: "SessionList.qml"
                        onLoaded: {
                            item.sessionActivated.connect(shell.openConversation)
                            item.createRequested.connect(() => newSession.open())
                        }
                    }
                    LazyPage {
                        id: desktop; selected: shell.page === 2; pageSource: "Desktop.qml"
                        onLoaded: item.settingsRequested.connect(category => { shell.navigate(3); settingsPage.ensure().open(category, "") })
                    }
                    LazyPage { id: settingsPage; selected: shell.page === 3; pageSource: "Settings.qml" }
                    LazyPage {
                        id: projectsPage; selected: shell.page === 4; pageSource: "Projects.qml"
                        onLoaded: {
                            item.sessionActivated.connect(shell.openConversation)
                            item.showWorkflowsAction = Qt.binding(() => !shell.wide)
                            item.workflowsRequested.connect(() => shell.showWorkflows(0))
                            item.projectRequested.connect((cwd, archived) => { shell.page = 1; sessionsPage.ensure().selectProject(cwd, archived) })
                        }
                    }
                    LazyPage {
                        id: workflowsPage; selected: shell.page === 5; pageSource: "Workflows.qml"
                        initialProperties: ({requestedTab: shell.workflowsTab})
                        onLoaded: {
                            item.backRequested.connect(shell.closeWorkflows)
                            item.sessionRequested.connect(id => { App.selectedId = id; shell.openConversation() })
                        }
                    }
                }
                // Notices float over the page instead of pushing it down. They take no input, so the
                // controls beneath stay usable, and fade while the pointer is over them.
                Rectangle {
                    objectName:"toast";visible:shell.toastVisible;z:10;opacity:toastHover.hovered?0.2:1
                    anchors.top:parent.top;anchors.left:parent.left;anchors.right:parent.right;anchors.margins:Theme.space2
                    implicitHeight:toastText.implicitHeight+Theme.gutter
                    radius:Theme.radiusControl;color:Theme.raised;border.color:Theme.borderStrong
                    Accessible.role:Accessible.AlertMessage;Accessible.name:App.toast
                    Text { id:toastText;anchors.fill:parent;anchors.margins:Theme.space2;text:App.toast;color:Theme.text;font.family:Theme.font;font.pixelSize:Theme.secondary;wrapMode:Text.Wrap;maximumLineCount:5;elide:Text.ElideRight }
                    HoverHandler { id:toastHover }
                }
                // The compact panel shows the Workbench as one focused sheet over the conversation.
                Item { id:workbenchSheet;objectName:"workbenchSheet";anchors.fill:parent;z:5;visible:shell.workbenchVisible&&(!shell.wide||shell.workbenchFocused);onVisibleChanged:if(visible)Qt.callLater(()=>workbench.focusActiveTab()) }
            }
        }
        Item {
            id: workbenchSide; objectName: "workbenchSide"; visible: shell.splitWorkbench
            Layout.preferredWidth: Math.max(Theme.paneMinimum, Math.min(shell.maxPaneWidth, WorkbenchState.paneWidth))
            Layout.fillHeight: true
            Layout.bottomMargin: shell.paneFooterSpace
            Rectangle {
                anchors.top: parent.bottom; width: parent.width; height: shell.paneFooterSpace
                color: Theme.sidebar
                Rectangle {
                    anchors.left: parent.left; anchors.right: parent.right; anchors.margins: Theme.space3
                    height: Theme.hairline; color: Theme.subtle
                }
            }
            WorkspaceGrip {
                objectName: "workbenchResize"; reversed: true
                label: qsTr("Resize Workbench"); extent: workbenchSide.width
                minimum: Theme.paneMinimum; maximum: shell.maxPaneWidth
                onResized: size => WorkbenchState.paneWidth = size
                onResetRequested: WorkbenchState.paneWidth = Theme.paneDefault
            }
        }
    }
    Item {
        id: workspaceFooter
        readonly property bool hasJobs: (App.state.jobs || []).length > 0
        visible: shell.wide || shell.showWorkbenchToggle || hasJobs
        enabled: !App.state.recoveryPending
        anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
        anchors.leftMargin: shell.wide ? shell.sidebarWidth + (shell.splitWorkbench ? Theme.space3 : Theme.gutter) : Theme.space3
        anchors.rightMargin: shell.showWorkbenchToggle ? Theme.space3 : Theme.gutter
        anchors.bottomMargin: shell.showWorkbenchToggle ? Theme.space3 : Theme.gutter
        implicitHeight: Math.max(statusBar.visible ? statusBar.implicitHeight : 0, shell.showWorkbenchToggle ? workbenchToggle.implicitHeight : 0)
        readonly property real reservedHeight: height + anchors.bottomMargin
        RowLayout {
            id: statusBar
            visible: shell.wide || workspaceFooter.hasJobs; spacing: Theme.space2
            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            anchors.rightMargin: shell.splitWorkbench ? workbenchSide.width : workbenchToggle.visible ? workbenchToggle.width + spacing : 0
            CIcon { visible:shell.wide; name:"shield";Layout.preferredWidth:Theme.iconSmall;Layout.preferredHeight:Theme.iconSmall;color:settings.paused?Theme.amber:Theme.muted }
            Text {
                visible:shell.wide; text:shell.permissionText
                color:shell.bypassActive?Theme.amber:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption
                Layout.fillWidth:true;Layout.minimumWidth:0;elide:Text.ElideRight
            }
            // A04: downloads, indexing and file transcription, listed together while any is running.
            CButton {
                id:backgroundWork;objectName:"backgroundWork";visible:(App.state.jobs||[]).length>0;quiet:true;implicitHeight:Theme.compactHeight;font.pixelSize:Theme.caption
                text:(App.state.jobs||[]).length===1?"1 background task":(App.state.jobs||[]).length+" background tasks"
                onClicked:jobsPopup.open()
                Popup {
                    id:jobsPopup;objectName:"backgroundWorkList";y:-height-Theme.space1;x:Math.min(0,parent.width-width);width:Theme.narrowPane;padding:Theme.space3
                    background:Rectangle { color:Theme.surface;radius:Theme.radiusControl;border.color:Theme.borderStrong }
                    contentItem:ColumnLayout {
                        spacing:Theme.space2
                        Repeater {
                            model:App.state.jobs||[]
                            RowLayout {
                                required property var modelData
                                required property int index
                                Layout.fillWidth:true
                                CText { objectName:"backgroundJob_"+index;Layout.fillWidth:true;elide:Text.ElideRight;font.pixelSize:Theme.secondary
                                    text:modelData.label+(modelData.progress?" · "+Math.round(100*modelData.progress.done/Math.max(1,modelData.progress.total))+"%":"") }
                                CButton { objectName:"backgroundJobCancel_"+index;text:"Cancel";danger:true;implicitHeight:Theme.compactHeight;onClicked:App.rpc("jobs.cancel",{id:modelData.id}) }
                            }
                        }
                        CText { visible:!(App.state.jobs||[]).length;text:"Nothing is running in the background.";color:Theme.muted;font.pixelSize:Theme.secondary }
                    }
                }
            }
            Text { visible:shell.wide&&!App.connected;text:App.brokerUnresponsive?"Not responding":"Offline";color:Theme.amber;font.family:Theme.font;font.pixelSize:Theme.caption }
            CButton { objectName:"shellPermissionCenter";visible:shell.wide;text:"Permissions";quiet:true;implicitHeight:Theme.compactHeight;onClicked:permissionCenter.open() }
        }
        WorkbenchToggle {
            id: workbenchToggle
            objectName: shell.wide ? "chatWorkbench" : "compactWorkbenchToggle"
            visible: shell.showWorkbenchToggle
            anchors.right: parent.right; anchors.bottom: parent.bottom
            workbenchOpen: shell.workbenchVisible; pendingChanges: workbench.pendingChanges
            onClicked: {
                const keepKeyboardFocus = visualFocus
                shell.toggleWorkbench()
                if (keepKeyboardFocus) Qt.callLater(() => workbenchToggle.forceActiveFocus(Qt.TabFocusReason))
            }
        }
    }
    // One Workbench per window, moved between the side pane and the compact sheet so its panes, scroll
    // positions and drafts survive a resize.
    Workbench {
        id:workbench
        parent:shell.splitWorkbench?workbenchSide:workbenchSheet
        anchors.fill:parent
        compact:!shell.wide
        focusedPane: shell.workbenchFocused
        onFocusRequested: { shell.workbenchFocused = !shell.workbenchFocused; Qt.callLater(() => workbench.focusActiveTab()) }
        onCloseRequested: shell.closeWorkbench()
        onSettingsRequested:(category,target)=>{shell.navigate(3);Qt.callLater(()=>settingsPage.ensure().open(category,target))}
        onWorkflowsRequested:shell.showWorkflows(0)
    }
    Connections {
        target: WorkbenchState
        function onImageStaged(sessionId) {
            if (!shell.visible || sessionId !== App.selectedId || shell.page !== 0) return
            if (!shell.wide) shell.closeWorkbench()
            else { shell.workbenchFocused = false; Qt.callLater(() => conversation.focusComposer()) }
        }
    }
    Connections { target:WorkbenchState;function onRequested(){if(shell.page!==0)shell.page=0;if(shell.wide)WorkbenchState.layout.dockOpen=true;Qt.callLater(()=>workbench.focusActiveTab())} }
    Connections { target:App;function onAttachmentRequested(path){shell.page=0} }
    // M16: while responsiveness is measured, the window samples how late its own timer fires and sends an
    // aggregate every thirty seconds. When off, the timer is stopped.
    property var lagSamples:[]
    property real lagExpected:0
    Timer {
        id:lagTimer;interval:250;repeat:true;running:App.connected&&App.state.settings?.responsiveness===true
        onRunningChanged:{shell.lagSamples=[];shell.lagExpected=0}
        onTriggered:{
            const now=Date.now();if(shell.lagExpected)shell.lagSamples.push(Math.max(0,now-shell.lagExpected));shell.lagExpected=now+interval
            if(shell.lagSamples.length>=120){const sorted=shell.lagSamples.slice().sort((a,b)=>a-b);App.rpc("diagnostics.uiLag",{p50:sorted[Math.floor(sorted.length*.5)],p90:sorted[Math.floor(sorted.length*.9)],max:sorted[sorted.length-1],samples:sorted.length});shell.lagSamples=[]}
        }
    }
    // The compact panel is for a quick ask: opening it puts the keyboard in the composer.
    Connections {
        target:shell.Window.window
        function onVisibleChanged(){if(shell.Window.window&&shell.Window.window.visible&&!shell.expanded&&shell.page===0)Qt.callLater(()=>conversation.focusComposer())}
    }
    Connections { target:App;function onNewConversationRequested(folder){if(shell.expanded)newSession.openFolder(folder)} }
    NewSession { id:newSession;objectName:"createSessionDialog";onSessionOpened:shell.openConversation();onClosed:imported=({}) }
    PermissionCenter { id:permissionCenter }
    CommandPalette {
        id:commandPalette
        onSessionRequested:id=>{App.selectedId=id;App.rpc("session.read",{id:id});shell.openConversation()}
        onFolderRequested:id=>shell.openFolder(id)
        onSettingsRequested:(category,target)=>{shell.page=3;Qt.callLater(()=>settingsPage.ensure().open(category,target))}
        onPageRequested:target=>shell.navigate(target)
        onDesktopRequested:query=>{shell.page=2;Qt.callLater(()=>desktop.ensure().showSearch(query))}
        onWorkflowsRequested:shell.showWorkflows(1)
    }
    Shortcut { sequence:"Ctrl+Shift+W";onActivated:shell.toggleWorkbench() }
    CDialog {
        id: welcome; objectName: "welcomeDialog"
        property int request: -1
        property string problem: ""
        property bool deferred: false
        closePolicy: request < 0 ? Popup.CloseOnEscape : Popup.NoAutoClose
        onClosed: if (App.connected && settings.onboarding && request < 0) deferred = true
        accessibleTitle: qsTr("Meet %1").arg(App.assistantName)
        onOpened: startup.forceActiveFocus(Qt.TabFocusReason)
        visible: App.connected && settings.onboarding === true && !deferred
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space3
            HeaderPortrait { enabled: false }
            CText { text: welcome.accessibleTitle; font.pixelSize: Theme.page; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
        }
        CText { text:qsTr("Click your companion to open chat. Drag to move them, or right-click for appearance and visibility. Conversations keep working when you close the panel.") }
        CCheckBox { id:startup;objectName:"welcomeAutostart";text:qsTr("Start PAL when I log in") }
        CText { text:"Desktop AI tools start disabled. Enable the categories you want in Settings. Existing CLI permissions remain in effect.";color:Theme.muted;font.pixelSize:Theme.secondary }
        CText {
            visible: !!welcome.problem
            text: welcome.problem
            color: Theme.danger
            Accessible.role: Accessible.AlertMessage
        }
        CButton {
            objectName: "welcomeDone"
            text: welcome.request < 0 ? qsTr("Get started") : qsTr("Saving…")
            prominent: true
            enabled: welcome.request < 0 && App.connected
            Layout.fillWidth: true
            onClicked: {
                if (startup.checked && !App.setAutostart(true)) {
                    welcome.problem = qsTr("PAL could not save the login setting. Clear the checkbox to continue.")
                    return
                }
                welcome.problem = ""
                welcome.request = App.rpc("settings.update", {onboarding:false})
            }
        }
        Connections {
            target: App
            function onResult(id, value) {
                if (id !== welcome.request) return
                welcome.request = -1
                if (value?.error) welcome.problem = String(value.error.message || value.error)
            }
        }
    }
}
