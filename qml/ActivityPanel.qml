import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import PAL.Native 1.0
import "ActivityText.js" as Log

ColumnLayout {
    id: panel
    property bool expanded: false
    property real maximumHeight: Theme.menuMaxHeight
    property string sessionId: App.selectedId
    property bool follow: true
    property string page: ""
    property string eventScope: "all"
    property string agentScope: "all"
    property string agentFilter: ""
    property string openAgent: ""
    property bool searching: false
    readonly property var agents: App.session.agents || []
    readonly property var activeAgents: agents.filter(agent => Log.active(agent.status))
    readonly property var agentMap: {
        const map = Object.create(null)
        for (const agent of agents) map[agent.id] = agent
        return map
    }
    readonly property bool agentPage: page === "agents"
    readonly property bool narrow: width < Theme.formBreakpoint
    readonly property bool inspecting: !!timeline.inspected.id
    readonly property string scope: agentPage ? agentScope : eventScope
    readonly property var scopes: agentPage ? [
        {id:"all", label:qsTr("All subagents")}, {id:"active", label:qsTr("Active")},
        {id:"finished", label:qsTr("Finished")}, {id:"attention", label:qsTr("Needs attention")}
    ] : [
        {id:"all", label:qsTr("All events")}, {id:"tools", label:qsTr("Tool calls")},
        {id:"agents", label:qsTr("Subagent updates")}, {id:"attention", label:qsTr("Needs attention")}
    ]
    readonly property string scopeLabel: (scopes.find(option => option.id === scope) || scopes[0]).label
    readonly property bool filtered: scope !== "all" || !!findField.text.trim() || (!agentPage && !!agentFilter)
    readonly property var agentOrder: {
        if (!expanded || !agentPage) return []
        const query = findField.text.trim().toLowerCase()
        return agents.filter(agent => {
            if (agentScope === "active" && !Log.active(agent.status)) return false
            if (agentScope === "finished" && Log.active(agent.status)) return false
            if (agentScope === "attention" && !["waiting", "failed", "interrupted"].includes(agent.status)) return false
            return !query || [Log.name(agent.name), agent.name, agent.id, agent.task, App.displayText(agent.detail || "", App.showMemoryCitations),
                Log.stateLabel(agent.status)].some(value => String(value || "").toLowerCase().includes(query))
        }).sort((a, b) => Number(Log.active(b.status)) - Number(Log.active(a.status))).map(agent => agent.id)
    }
    function belongsToSession(candidate) {
        const parents = {}
        for (const session of App.state.sessions || []) parents[session.id] = session.parentId || ""
        for (let id = candidate, depth = 0; id && depth < 16; id = parents[id], depth++) if (id === sessionId) return true
        return false
    }
    readonly property var pendingInput: (App.state.approvals || []).filter(approval => belongsToSession(approval.sessionId))
    readonly property string activityLabel: {
        switch (App.session.activity) {
        case "recalling": return qsTr("Recalling memory")
        case "thinking": return qsTr("Thinking")
        case "speaking": return qsTr("Responding")
        case "working": return qsTr("Using tools")
        case "delegating": return qsTr("Delegating")
        case "waitingForAgents": return qsTr("Waiting for subagents")
        case "compacting": return qsTr("Compacting context")
        case "planning": return qsTr("Planning")
        default: return ""
        }
    }
    readonly property string summary: {
        const parts = []
        if (pendingInput.length) parts.push(qsTr("%1 awaiting input").arg(pendingInput.length))
        if (activeAgents.length) parts.push((activeAgents.length === 1 ? qsTr("%1 subagent active") : qsTr("%1 subagents active")).arg(activeAgents.length))
        else if (activityLabel && !pendingInput.length) parts.push(activityLabel)
        else if (agents.length) parts.push((agents.length === 1 ? qsTr("%1 subagent") : qsTr("%1 subagents")).arg(agents.length))
        if (App.activityCount) parts.push((App.activityCount === 1 ? qsTr("%1 event") : qsTr("%1 events")).arg(App.activityCount))
        return parts.join(" · ")
    }
    function clearFilters() {
        findField.clear()
        if (agentPage) agentScope = "all"
        else { eventScope = "all"; agentFilter = "" }
    }
    function tabCount(total, matches, selected) {
        if (!selected || !filtered) return total
        return narrow ? matches : matches + "/" + total
    }
    function switchPage(value) {
        if (page === value) return
        page = value
        findField.clear()
        searching = false
    }
    function showAgentEvents(agent) {
        switchPage("timeline")
        agentFilter = agent.id
        eventScope = "all"
        Qt.callLater(() => activity.positionViewAtEnd())
    }
    function followLatest() {
        if (expanded && !agentPage && !inspecting && follow && !filtered && !activity.moving) activity.positionViewAtEnd()
    }
    function resetSession() {
        follow = true
        searching = false
        eventScope = "all"
        agentScope = "all"
        openAgent = ""
        agentFilter = ""
        page = ""
        if (roster) roster.clear()
        if (findField) findField.clear()
        if (timeline) timeline.inspect("")
    }
    // Updating a running agent must not recreate the row the reader is inspecting.
    function syncAgents() {
        if (!expanded || !agentPage) return
        for (let i = 0; i < agentOrder.length; ++i) {
            const key = agentOrder[i]
            if (i < roster.count && roster.get(i).agentKey === key) continue
            let previous = i + 1
            while (previous < roster.count && roster.get(previous).agentKey !== key) ++previous
            if (previous < roster.count) roster.move(previous, i, 1)
            else roster.insert(i, {agentKey:key})
        }
        if (roster.count > agentOrder.length) roster.remove(agentOrder.length, roster.count - agentOrder.length)
    }
    onAgentOrderChanged: Qt.callLater(syncAgents)
    onSessionIdChanged: resetSession()
    onExpandedChanged: {
        if (expanded && !page) page = activeAgents.length || (agents.length && !App.activityCount) ? "agents" : "timeline"
        if (expanded) Qt.callLater(followLatest)
    }

    ListModel { id: roster }
    ActivityModel {
        id: timeline
        sourceModel: panel.expanded ? App.activity : null
        scope: panel.eventScope
        query: panel.agentPage ? "" : findField.text
        agentId: panel.agentFilter
    }
    spacing: expanded ? Theme.space1 : 0
    implicitHeight: Theme.controlHeight + (expanded ? maximumHeight + spacing : 0)
    CButton {
        id: toggle
        objectName: "activityToggle"
        Layout.fillWidth: true
        quiet: true
        text: qsTr("Activity") + (panel.summary ? " · " + panel.summary : "")
        help: panel.expanded ? qsTr("Hide activity log") : qsTr("Show activity log")
        Accessible.name: qsTr("Activity")
        Accessible.description: panel.summary
        Accessible.expanded: panel.expanded
        onClicked: panel.expanded = !panel.expanded
        contentItem: RowLayout {
            spacing: Theme.space2
            CIcon { name: "activity"; color: Theme.accentText }
            CText { Layout.fillWidth: false; text: qsTr("Activity"); font.weight: Font.DemiBold }
            CText {
                text: panel.summary
                font.pixelSize: Theme.caption
                color: panel.pendingInput.length ? Theme.amber : Theme.muted
                wrapMode: Text.NoWrap
                elide: Text.ElideRight
            }
            CIcon { name: panel.expanded ? "down" : "chevron"; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall }
        }
    }
    Rectangle {
        visible: panel.expanded
        Layout.fillWidth: true
        Layout.preferredHeight: panel.maximumHeight
        color: Theme.surface
        border.color: Theme.line
        radius: Theme.radiusCard
        clip: true

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Theme.space1
            spacing: 0
            visible: !panel.inspecting
            RowLayout {
                Layout.fillWidth: true
                Layout.minimumWidth: 0
                Layout.maximumWidth: Math.max(0, parent.width - 2 * Theme.space1)
                Layout.leftMargin: Theme.space1
                Layout.rightMargin: Theme.space1
                spacing: Theme.space1
                component LogTab: CButton {
                    required property bool selected
                    quiet: true
                    primary: selected
                    implicitHeight: Theme.compactHeight
                    leftPadding: Theme.space2
                    rightPadding: Theme.space2
                    Accessible.role: Accessible.PageTab
                    Accessible.selected: selected
                }
                component LogIconButton: CButton {
                    quiet: true
                    implicitWidth: Theme.compactHeight
                    implicitHeight: Theme.compactHeight
                    Layout.minimumWidth: Theme.minimumTarget
                    leftPadding: 0
                    rightPadding: 0
                }
                LogTab {
                    objectName: "activityTimelineTab"
                    selected: !panel.agentPage
                    text: qsTr("Timeline · %1").arg(panel.tabCount(App.activityCount, activity.count, selected))
                    onClicked: panel.switchPage("timeline")
                }
                LogTab {
                    objectName: "activityAgentsTab"
                    selected: panel.agentPage
                    text: qsTr("Subagents · %1").arg(panel.tabCount(panel.agents.length, roster.count, selected))
                    onClicked: panel.switchPage("agents")
                }
                Item { Layout.fillWidth: true }
                LogIconButton {
                    objectName: "activityLatest"
                    visible: !panel.agentPage && !panel.follow && !panel.filtered && !activity.atYEnd
                    iconName: "down"
                    help: qsTr("Jump to latest event")
                    onClicked: { panel.follow = true; activity.positionViewAtEnd() }
                }
                LogIconButton {
                    id: searchButton
                    objectName: "activitySearchToggle"
                    iconName: "search"
                    primary: panel.searching
                    help: panel.agentPage ? qsTr("Search subagents") : qsTr("Search activity")
                    Accessible.expanded: panel.searching
                    onClicked: {
                        panel.searching = !panel.searching
                        if (panel.searching) findField.forceActiveFocus(Qt.ShortcutFocusReason)
                        else findField.clear()
                    }
                }
                LogIconButton {
                    id: filterButton
                    objectName: "activityFilter"
                    iconName: "filter"
                    primary: panel.scope !== "all"
                    help: qsTr("Filter · %1").arg(panel.scopeLabel)
                    onClicked: filterMenu.popup(filterButton, filterButton.width - filterMenu.width, height)
                    CMenu {
                        id: filterMenu
                        Instantiator {
                            model: panel.scopes
                            delegate: CMenuItem {
                                required property var modelData
                                objectName: "activityScope_" + modelData.id
                                text: modelData.label
                                checkable: true
                                checked: panel.scope === modelData.id
                                onTriggered: {
                                    if (panel.agentPage) panel.agentScope = modelData.id
                                    else panel.eventScope = modelData.id
                                }
                            }
                            onObjectAdded: (index, object) => filterMenu.insertItem(index, object)
                            onObjectRemoved: (index, object) => filterMenu.removeItem(object)
                        }
                    }
                }
            }
            Rectangle { Layout.fillWidth: true; Layout.topMargin: Theme.space1; implicitHeight: Theme.hairline; color: Theme.line }
            RowLayout {
                visible: panel.searching || panel.scope !== "all" || (!panel.agentPage && !!panel.agentFilter)
                Layout.fillWidth: true
                Layout.minimumWidth: 0
                Layout.maximumWidth: Math.max(0, parent.width - 2 * Theme.space1)
                Layout.margins: Theme.space1
                spacing: Theme.space1
                CField {
                    id: findField
                    objectName: "activitySearch"
                    visible: panel.searching
                    Layout.fillWidth: true
                    implicitHeight: Theme.compactHeight
                    placeholderText: panel.agentPage ? qsTr("Find a name, task or update")
                        : App.hasOlderMessages ? qsTr("Search loaded events") : qsTr("Find a tool, command or output")
                    Accessible.name: placeholderText
                    Keys.onEscapePressed: { clear(); panel.searching = false; searchButton.forceActiveFocus() }
                }
                CButton {
                    objectName: "activityClearScope"
                    visible: panel.scope !== "all" || (!panel.agentPage && !!panel.agentFilter)
                    Layout.fillWidth: !panel.searching
                    Layout.maximumWidth: panel.searching ? panel.width * .45 : panel.width
                    quiet: true
                    alignLeft: true
                    primary: true
                    iconName: "close"
                    text: [!panel.agentPage && panel.agentFilter ? Log.name(panel.agentMap[panel.agentFilter]?.name || panel.agentFilter) : "",
                        panel.scope !== "all" ? panel.scopeLabel : ""].filter(Boolean).join(" · ")
                    help: qsTr("Clear filter")
                    implicitHeight: Theme.compactHeight
                    onClicked: {
                        if (panel.agentPage) panel.agentScope = "all"
                        else { panel.agentFilter = ""; panel.eventScope = "all" }
                    }
                }
            }
            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: Theme.surface
                clip: true
                // Clip the shape icons as well as the text when Qt uses its software renderer.
                layer.enabled: visible && GraphicsInfo.api === GraphicsInfo.Software
                ListView {
                    id: activity
                    objectName: "toolActivity"
                    visible: !panel.agentPage
                    anchors.fill: parent
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    model: timeline
                    reuseItems: true
                    highlightFollowsCurrentItem: false
                    keyNavigationEnabled: false
                    function focusRow(row) {
                        if (!count) return
                        panel.follow = false
                        currentIndex = Math.max(0, Math.min(count - 1, row))
                        positionViewAtIndex(currentIndex, ListView.Contain)
                        Qt.callLater(() => { if (currentItem) currentItem.forceActiveFocus(Qt.TabFocusReason) })
                    }
                    header: CButton {
                        visible: App.hasOlderMessages && activity.count > 0
                        height: visible ? implicitHeight : 0
                        text: qsTr("Load earlier events")
                        quiet: true
                        onClicked: { panel.follow = false; App.loadOlderMessages() }
                    }
                    delegate: ActivityRow {
                        required property var entry
                        width: Math.max(0, activity.width - Theme.minimumTarget)
                        text: entry.log.title
                        detail: entry.log.kind === "agent" ? App.displayText(entry.log.preview, App.showMemoryCitations)
                            : [entry.log.owner, entry.log.preview].filter(Boolean).join(" · ")
                        iconName: entry.log.icon
                        eventState: entry.log.state
                        stamp: entry.time || 0
                        objectName: "activityEvent_" + entry.id
                        Keys.onUpPressed: activity.focusRow(activity.indexAt(1, y + height / 2) - 1)
                        Keys.onDownPressed: activity.focusRow(activity.indexAt(1, y + height / 2) + 1)
                        Keys.onPressed: event => {
                            if (event.key === Qt.Key_Home) activity.focusRow(0)
                            else if (event.key === Qt.Key_End) { activity.focusRow(activity.count - 1); panel.follow = true }
                            else return
                            event.accepted = true
                        }
                        onClicked: {
                            const messageId = entry.id
                            panel.follow = false
                            activity.currentIndex = timeline.inspect(messageId)
                            Qt.callLater(() => { if (inspector.item) inspector.item.focusBack() })
                        }
                    }
                    ScrollBar.vertical: CScrollBar {
                        objectName: "activityScrollBar"
                        onPressedChanged: if (pressed) panel.follow = false; else if (activity.atYEnd) panel.follow = true
                    }
                    onMovementStarted: panel.follow = false
                    onMovementEnded: if (atYEnd) panel.follow = true
                    onContentHeightChanged: Qt.callLater(panel.followLatest)
                    onCountChanged: Qt.callLater(panel.followLatest)
                }
                ListView {
                    id: agentsList
                    visible: panel.agentPage
                    anchors.fill: parent
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds
                    model: roster
                    reuseItems: true
                    ScrollBar.vertical: CScrollBar {}
                    delegate: AgentCard {
                        required property string agentKey
                        width: Math.max(0, agentsList.width - Theme.minimumTarget)
                        agent: panel.agentMap[agentKey] || ({})
                        expanded: panel.openAgent === agentKey
                        onExpansionRequested: open => panel.openAgent = open ? agentKey : ""
                        onEventsRequested: panel.showAgentEvents(agent)
                    }
                }
                ColumnLayout {
                    anchors.centerIn: parent
                    width: parent.width - Theme.space4
                    visible: panel.agentPage ? !roster.count : !activity.count
                    spacing: Theme.space1
                    CText {
                        horizontalAlignment: Text.AlignHCenter
                        color: Theme.muted
                        text: panel.filtered ? (panel.agentPage ? qsTr("No matching subagents") : qsTr("No matching events"))
                            : panel.agentPage ? qsTr("No subagents in this conversation yet.")
                            : panel.pendingInput.length ? qsTr("Waiting for your response.") : qsTr("Tool calls and agent updates will appear here.")
                    }
                    RowLayout {
                        Layout.alignment: Qt.AlignHCenter
                        CButton {
                            visible: panel.filtered
                            text: qsTr("Clear filters")
                            implicitHeight: Theme.compactHeight
                            onClicked: panel.clearFilters()
                        }
                        CButton {
                            visible: !panel.agentPage && App.hasOlderMessages
                            text: qsTr("Load earlier events")
                            implicitHeight: Theme.compactHeight
                            onClicked: { panel.follow = false; App.loadOlderMessages() }
                        }
                    }
                }
            }
        }
        Loader {
            id: inspector
            anchors.fill: parent
            anchors.margins: Theme.space1
            active: panel.expanded && panel.inspecting
            visible: active
            sourceComponent: ActivityDetails {
                entry: timeline.inspected
                onBackRequested: {
                    timeline.inspect("")
                    Qt.callLater(() => {
                        if (activity.currentItem) activity.currentItem.forceActiveFocus(Qt.TabFocusReason)
                        else searchButton.forceActiveFocus(Qt.TabFocusReason)
                    })
                }
            }
        }
    }
}
