pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Labels.js" as Labels

ColumnLayout {
    id: list
    required property var monitor
    signal taskRequested(string sessionId, string id)
    signal newRequested()
    spacing: Theme.space3
    readonly property var matches: {
        const term = search.text.trim().toLowerCase()
        return monitor.tasks.filter(task => {
            if (status.currentValue === "active" && !monitor.isActive(task)) return false
            if (status.currentValue === "resume" && !monitor.canResume(task)) return false
            return !term || [task.title, monitor.ownerLabel(task), monitor.routeLabel(task)].some(
                value => String(value || "").toLowerCase().includes(term))
        })
    }

    RowLayout {
        Layout.fillWidth: true
        ColumnLayout {
            Layout.fillWidth: true
            spacing: Theme.space1
            CText { text: "Background tasks"; font.pixelSize: Theme.section; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
            CText { text: "Follow research across conversations."; color: Theme.muted; font.pixelSize: Theme.secondary }
        }
        CButton {
            text: "Refresh"; iconName: "refresh"; quiet: true
            enabled: list.monitor.online && !list.monitor.loading
            onClicked: list.monitor.refresh()
        }
    }
    RowLayout {
        visible: list.monitor.tasks.length > 0
        Layout.fillWidth: true
        CField {
            id: search
            Layout.fillWidth: true; Layout.minimumWidth: 0
            placeholderText: "Find a task"; Accessible.name: "Find a research task"
        }
        CComboBox {
            id: status
            Layout.preferredWidth: Math.min(list.width * 0.45, Theme.fieldWidth)
            model: [{id:"all", label:"All statuses"}, {id:"active", label:"Active"}, {id:"resume", label:"Can resume"}]
            textRole: "label"; valueRole: "id"; Accessible.name: "Filter tasks by status"
        }
    }
    CText {
        visible: !!text; color: Theme.amber
        text: !list.monitor.online ? "Reconnect to update research tasks." : list.monitor.actionError || list.monitor.loadError
    }
    Rectangle {
        visible: !list.matches.length
        Layout.fillWidth: true
        implicitHeight: empty.implicitHeight + Theme.space5 * 2
        color: Theme.surface; border.color: Theme.line; radius: Theme.radiusCard
        ColumnLayout {
            id: empty
            anchors.centerIn: parent
            width: Math.max(1, parent.width - Theme.space5 * 2)
            spacing: Theme.space2
            CIcon { Layout.alignment: Qt.AlignHCenter; name: "inbox"; color: Theme.muted }
            CText {
                horizontalAlignment: Text.AlignHCenter; font.weight: Font.DemiBold
                text: list.monitor.tasks.length ? "No matching tasks" : list.monitor.loaded ? "No research tasks yet" : list.monitor.loading ? "Loading tasks…" : "Tasks unavailable"
            }
            CButton {
                Layout.alignment: Qt.AlignHCenter; visible: list.monitor.loaded
                text: list.monitor.tasks.length ? "Clear filters" : "Start a new run"
                onClicked: {
                    if (list.monitor.tasks.length) { search.clear(); status.currentIndex = 0 }
                    else list.newRequested()
                }
            }
        }
    }
    ListView {
        id: rows
        Layout.fillWidth: true; Layout.fillHeight: true
        clip: true; spacing: Theme.space2
        model: list.matches
        ScrollBar.vertical: CScrollBar {}
        delegate: Rectangle {
            id: card
            required property var modelData
            readonly property string action: list.monitor.pending[modelData.id] || ""
            readonly property bool running: list.monitor.isActive(modelData)
            width: rows.width - (rows.contentHeight > rows.height ? Theme.space3 : 0)
            height: fields.implicitHeight + 2 * Theme.space3
            color: Theme.surface; border.color: Theme.line; radius: Theme.radiusCard
            ColumnLayout {
                id: fields
                anchors.centerIn: parent
                width: Math.max(1, parent.width - Theme.space4 * 2)
                spacing: Theme.space1
                RowLayout {
                    Layout.fillWidth: true
                    CText { text: card.modelData.title || "Untitled research"; font.weight: Font.DemiBold; maximumLineCount: 2; elide: Text.ElideRight }
                    CText {
                        Layout.fillWidth: false; Layout.maximumWidth: fields.width * 0.4
                        text: card.action === "research.cancel" ? "Cancelling…" : card.action ? "Resuming…" : Labels.researchState(card.modelData.state)
                        font.pixelSize: Theme.caption
                        color: card.running ? Theme.accentText : list.monitor.canResume(card.modelData) ? Theme.amber : Theme.muted
                    }
                }
                CText { text: [list.monitor.ownerLabel(card.modelData), list.monitor.routeLabel(card.modelData)].filter(Boolean).join(" · "); color: Theme.muted; font.pixelSize: Theme.caption }
                CText { visible: !!text; text: card.modelData.progress || ""; font.pixelSize: Theme.secondary }
                RowLayout {
                    Layout.fillWidth: true; Layout.topMargin: Theme.space1
                    CButton {
                        objectName: "researchTaskOpen_" + card.modelData.id
                        text: "Open details"; iconName: "arrow"; primary: true; implicitHeight: Theme.compactHeight
                        onClicked: list.taskRequested(card.modelData.sessionId, card.modelData.id)
                    }
                    Item { Layout.fillWidth: true }
                    CButton {
                        objectName: "researchTaskCancel_" + card.modelData.id
                        visible: card.running && card.modelData.state !== "cancel_requested"
                        enabled: !card.action && list.monitor.online
                        text: "Cancel"; quiet: true; danger: true; implicitHeight: Theme.compactHeight
                        onClicked: list.monitor.act("research.cancel", card.modelData.id)
                    }
                    CButton {
                        objectName: "researchTaskResume_" + card.modelData.id
                        visible: list.monitor.canResume(card.modelData); enabled: !card.action && list.monitor.online
                        text: "Resume"; implicitHeight: Theme.compactHeight
                        onClicked: list.monitor.act("research.continue", card.modelData.id)
                    }
                }
            }
        }
    }
}
