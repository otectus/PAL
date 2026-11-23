import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "ActivityText.js" as Log

ColumnLayout {
    id: card
    required property var agent
    property bool expanded: false
    signal expansionRequested(bool open)
    signal eventsRequested()
    readonly property var relatedSession: (App.state.sessions || []).find(session => session.id === agent.id)
    readonly property string title: Log.name(agent.name || relatedSession?.title || agent.id)
    readonly property string task: agent.task || ""
    readonly property string detail: App.displayText(agent.detail || "", App.showMemoryCitations)
    readonly property string parentName: {
        if (!agent.parentId) return ""
        if (agent.parentId === App.selectedId || agent.parentId === App.session.nativeId) return App.session.title || App.assistantName
        const parentAgent = (App.session.agents || []).find(a => a.id === agent.parentId)
        return parentAgent ? Log.name(parentAgent.name) : (App.state.sessions || []).find(s => s.id === agent.parentId)?.title || agent.parentId
    }
    spacing: 0
    height: implicitHeight
    ActivityRow {
        objectName: "agent_" + card.agent.id
        Layout.fillWidth: true
        text: card.title
        detail: card.expanded ? "" : card.task || card.detail
        update: !card.expanded && card.task && card.detail && card.detail !== card.task ? card.detail : ""
        eventState: card.agent.status || ""
        iconName: "agents"
        stamp: card.agent.updated || 0
        disclosed: card.expanded
        Accessible.expanded: card.expanded
        onClicked: card.expansionRequested(!card.expanded)
    }
    Loader {
        Layout.fillWidth: true
        active: card.expanded
        visible: active
        sourceComponent: Rectangle {
            implicitHeight: details.implicitHeight + 2 * Theme.space3
            color: Theme.raised
            radius: Theme.radiusControl
            ColumnLayout {
                id: details
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Theme.space3
                spacing: Theme.space2
                Flow {
                    Layout.fillWidth: true
                    Layout.preferredHeight: implicitHeight
                    spacing: Theme.space2
                    CButton {
                        objectName: "agentEvents_" + card.agent.id
                        text: qsTr("View activity")
                        iconName: "activity"
                        implicitHeight: Theme.compactHeight
                        onClicked: card.eventsRequested()
                    }
                    CButton {
                        visible: !!card.relatedSession && App.selectedId !== card.agent.id
                        text: qsTr("Open conversation")
                        iconName: "chat"
                        implicitHeight: Theme.compactHeight
                        onClicked: App.selectedId = card.agent.id
                    }
                }
                SectionLabel { visible: !!card.task; text: qsTr("Assignment") }
                CText { visible: !!card.task; text: card.task }
                SectionLabel {
                    visible: !!card.detail && card.detail !== card.task
                    text: card.agent.status === "failed" ? qsTr("Reported problem")
                        : card.agent.status === "completed" ? qsTr("Result") : qsTr("Latest update")
                }
                CText { visible: !!card.detail && card.detail !== card.task; text: card.detail }
                CText {
                    text: [card.parentName ? qsTr("Delegated by %1").arg(card.parentName) : "",
                        card.agent.updated ? qsTr("Updated %1").arg(Log.time(card.agent.updated, true)) : ""].filter(Boolean).join(" · ")
                    visible: !!text
                    color: Theme.muted
                    font.pixelSize: Theme.caption
                }
            }
        }
    }
}
