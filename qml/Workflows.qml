pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: page
    objectName: "workflowsPage"
    spacing: Theme.space3
    property int requestedTab: 0
    signal backRequested()
    signal sessionRequested(string id)

    function focusInitial() { backButton.forceActiveFocus() }
    function openTab(tab) {
        requestedTab = tab === undefined ? 0 : tab
        if (!workflowView.active || workflowView.tab !== requestedTab) workflowView.activate(requestedTab)
        focusInitial()
    }

    RowLayout {
        Layout.fillWidth: true
        Layout.leftMargin: Theme.space4
        Layout.rightMargin: Theme.space4
        Layout.topMargin: Theme.space4
        spacing: Theme.space2
        CButton {
            id: backButton
            objectName: "workflowsBack"
            text: ""; iconName: "back"; quiet: true
            help: "Back"; Accessible.name: help
            onClicked: page.backRequested()
        }
        CText {
            text: "Project workflows"
            font.pixelSize: Theme.page
            font.weight: Font.DemiBold
            Accessible.role: Accessible.Heading
            Layout.fillWidth: true
        }
        CButton {
            objectName: "workflowsRefresh"
            text: "Refresh"; iconName: "refresh"; quiet: true
            enabled: workflowView.requestId < 0 && App.connected
            onClicked: workflowView.refresh()
        }
    }
    RowLayout {
        Layout.fillWidth: true
        Layout.leftMargin: Theme.space4
        Layout.rightMargin: Theme.space4
        spacing: Theme.space1
        Repeater {
            model: ["Project", "Recipes", "Results"]
            CButton {
                required property string modelData
                required property int index
                objectName: "workflowTab" + index
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                text: modelData
                primary: workflowView.tab === index
                Accessible.role: Accessible.PageTab
                Accessible.onPressAction: if (enabled) click()
                Accessible.selected: primary
                onClicked: workflowView.tab = index
            }
        }
    }
    Rectangle { Layout.fillWidth: true; implicitHeight: Theme.hairline; color: Theme.line }
    ScrollView {
        id: viewport
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.minimumHeight: Theme.editorShort
        clip: true
        contentWidth: availableWidth
        contentHeight: workflowView.implicitHeight + Theme.space4 * 2
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical: CScrollBar {}

        WorkflowsView {
            id: workflowView
            x: Math.max(Theme.space4, (viewport.availableWidth - width) / 2)
            y: Theme.space4
            width: Math.max(1, Math.min(Theme.workflowWidth, viewport.availableWidth - Theme.space4 * 2))
            onSessionRequested: id => page.sessionRequested(id)
        }
    }
    Connections {
        target: workflowView
        function onTabChanged() {
            page.requestedTab = workflowView.tab
            viewport.contentItem.contentY = viewport.contentItem.originY
        }
    }
    onVisibleChanged: {
        if (visible) {
            viewport.contentItem.contentY = viewport.contentItem.originY
            if (!workflowView.active) workflowView.activate(requestedTab)
            focusInitial()
        } else {
            workflowView.deactivate()
        }
    }
}
