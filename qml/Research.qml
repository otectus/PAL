pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: page
    objectName: "researchPage"
    required property var monitor
    property string section: "workspace"
    readonly property string tab: section === "workspace" ? pane.currentView : section
    readonly property bool compact: width < Theme.toolbarBreakpoint
    readonly property int margin: compact ? Theme.space2 : Theme.space4
    readonly property var conversations: {
        const items = (App.state.sessions || []).filter(s => s.id === App.selectedId || (!s.temporary && !s.archived && (!s.remote || s.remote.role === "owner")))
        if (App.session.id && !items.some(s => s.id === App.session.id)) items.unshift(App.session)
        return items.map(s => ({id:s.id, label:s.title || "Untitled conversation"}))
    }
    readonly property string reportOwner: pane.selectedRun?.sessionId || App.selectedId
    signal conversationRequested(string sessionId)
    signal backRequested()
    signal connectionSettingsRequested()
    signal createRequested()
    signal draftRequested(string sessionId)
    spacing: Theme.space2

    function showTab(name) {
        if (name === "tasks" || name === "settings") {
            section = name
            if (name === "tasks") monitor.refresh()
        } else {
            section = "workspace"
            pane.showView(name)
        }
    }
    function openTask(sessionId, id) {
        if (!sessionId || !id) return
        App.select(sessionId)
        section = "workspace"
        pane.loadRun(id, false, "", false)
    }
    function focusInitial() { back.forceActiveFocus(Qt.TabFocusReason) }

    RowLayout {
        Layout.fillWidth: true
        Layout.topMargin: page.margin; Layout.leftMargin: page.margin; Layout.rightMargin: page.margin
        spacing: Theme.space2
        CButton {
            id: back; objectName: "researchBack"
            iconName: "back"; quiet: true; help: "Back"
            onClicked: page.backRequested()
        }
        CText { text: "Research"; font.pixelSize: Theme.page; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
    }
    RowLayout {
        Layout.fillWidth: true; Layout.leftMargin: page.margin; Layout.rightMargin: page.margin
        spacing: Theme.space1
        Repeater {
            model: [
                {key:"new", title:"New run", icon:"plus"},
                {key:"tasks", title:"Tasks", icon:"activity"},
                {key:"library", title:"Library", icon:"projects"},
                {key:"report", title:"Report", icon:"file"},
                {key:"settings", title:"Settings", icon:"settings"}
            ]
            CButton {
                required property var modelData
                objectName: "researchTab_" + modelData.key
                visible: modelData.key !== "report" || !!pane.selectedId
                Layout.preferredWidth: page.compact ? 1 : implicitWidth
                Layout.fillWidth: page.compact
                leftPadding: page.compact ? Theme.space1 : Theme.space3
                rightPadding: leftPadding
                iconName: page.compact ? "" : modelData.icon
                text: modelData.title + (modelData.key === "tasks" && page.monitor.activeCount ? " · " + page.monitor.activeCount : "")
                primary: page.tab === modelData.key; quiet: !primary
                Accessible.role: Accessible.PageTab
                Accessible.selected: primary
                Accessible.onPressAction: if (enabled) click()
                onClicked: page.showTab(modelData.key)
            }
        }
        Item { visible: !page.compact; Layout.fillWidth: true }
    }
    Rectangle { Layout.fillWidth: true; implicitHeight: Theme.hairline; color: Theme.line }
    ColumnLayout {
        id: body
        Layout.fillWidth: true; Layout.fillHeight: true
        Layout.leftMargin: page.margin; Layout.rightMargin: page.margin; Layout.topMargin: page.margin
        Layout.maximumWidth: Theme.dashboardWidth
        Layout.alignment: Qt.AlignHCenter
        spacing: Theme.space3
        RowLayout {
            visible: page.section === "workspace" && page.conversations.length > 0
            Layout.fillWidth: true; spacing: Theme.space2
            CIcon { name: "chat"; color: Theme.muted }
            CText { Layout.fillWidth: false; text: "Conversation"; color: Theme.muted; font.pixelSize: Theme.secondary }
            CComboBox {
                visible: page.tab !== "report"
                objectName: "researchConversation"
                Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.maximumWidth: Theme.dialogWidth
                model: page.conversations; textRole: "label"; valueRole: "id"
                currentIndex: page.conversations.findIndex(s => s.id === App.selectedId)
                displayText: currentIndex < 0 ? "Choose a conversation" : currentText
                Accessible.name: "Research conversation"
                onActivated: App.select(currentValue)
            }
            CText {
                visible: page.tab === "report"
                text: page.conversations.find(s => s.id === page.reportOwner)?.label || "Research conversation"
                maximumLineCount: 1; elide: Text.ElideRight
            }
            CButton {
                visible: page.tab === "report"
                text: "Open chat"; quiet: true; iconName: "arrow"
                onClicked: page.conversationRequested(page.reportOwner)
            }
            Item { visible: !page.compact && page.tab !== "report"; Layout.fillWidth: true; Layout.preferredWidth: 0 }
            CButton {
                visible: page.tab === "new" && !!App.selectedId
                iconName: "plus"; quiet: true
                text: page.compact ? "" : "New conversation"
                help: "Start research in a new conversation"
                onClicked: page.createRequested()
            }
        }
        ColumnLayout {
            visible: page.section === "workspace" && !App.selectedId
            Layout.fillWidth: true; Layout.fillHeight: true
            CText { text: "Choose a conversation for research"; font.pixelSize: Theme.section; font.weight: Font.DemiBold }
            CText { text: "Your sources and reports are saved with the conversation’s project."; color: Theme.muted }
            CButton { text: "New conversation"; iconName: "plus"; primary: true; onClicked: page.createRequested() }
            Item { Layout.fillHeight: true }
        }
        ResearchPane {
            id: pane
            visible: page.section === "workspace" && !!App.selectedId
            Layout.fillWidth: true; Layout.fillHeight: true
            pageMode: true
            Binding {
                target: pane; property: "sessionId"; value: App.selectedId
                when: page.visible && page.section === "workspace"
                restoreMode: Binding.RestoreNone
            }
            onSettingsRequested: (category, target) => {
                if (category === "knowledge") page.showTab("settings")
                else page.connectionSettingsRequested()
            }
            onDraftRequested: sessionId => page.draftRequested(sessionId)
        }
        ResearchTaskList {
            visible: page.section === "tasks"
            Layout.fillWidth: true; Layout.fillHeight: true
            monitor: page.monitor
            onNewRequested: page.showTab("new")
            onTaskRequested: (sessionId, id) => page.openTask(sessionId, id)
        }
        ScrollView {
            id: preferences
            visible: page.section === "settings"
            Layout.fillWidth: true; Layout.fillHeight: true
            clip: true; contentWidth: availableWidth
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            ScrollBar.vertical: CScrollBar {}
            ColumnLayout {
                width: Math.max(0, preferences.availableWidth - Theme.space3)
                spacing: Theme.space4
                ResearchSearchSettings {}
                Rectangle { Layout.fillWidth: true; implicitHeight: Theme.hairline; color: Theme.line }
                CSection {
                    title: "Model connections"
                    description: "New runs can use Ollama or a connected provider. Choose the model for each run in New run."
                    CButton { text: "Manage connections"; iconName: "model"; onClicked: page.connectionSettingsRequested() }
                }
            }
        }
    }
}
