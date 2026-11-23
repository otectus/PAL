import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "ActivityText.js" as Log

ColumnLayout {
    id: details
    required property var entry
    signal backRequested()
    readonly property var log: entry.log || ({})
    readonly property var info: entry.toolActivity || ({})
    readonly property bool agentUpdate: log.kind === "agent"
    readonly property bool childTool: !!info.agentId && !agentUpdate
    readonly property string fullText: agentUpdate ? App.displayText(entry.text || "", App.showMemoryCitations) : entry.text || ""
    readonly property string bodyLabel: childTool || agentUpdate ? qsTr("Reported update") : log.noProgress || log.kind === "notice"
        ? qsTr("Notice") : info.status === "started" ? qsTr("Recorded input") : qsTr("Recorded output")
    property int previewLimit: 8000
    readonly property string metadata: {
        const parts = [Log.stateLabel(log.state)]
        if (info.exitCode !== undefined) parts.push(qsTr("Exit code %1").arg(info.exitCode))
        if (info.durationMs !== undefined) parts.push(info.durationMs < 1000 ? qsTr("%1 ms").arg(info.durationMs) : qsTr("%1 s").arg((info.durationMs / 1000).toFixed(1)))
        if (log.owner) parts.push(log.owner)
        if (entry.time) parts.push(qsTr("Logged %1").arg(Log.time(entry.time, true)))
        return parts.filter(Boolean).join(" · ")
    }
    spacing: Theme.space1
    function focusBack() { back.forceActiveFocus(Qt.TabFocusReason) }
    function copyOutput() {
        if (entry.truncated) App.copySessionMessage(entry.sessionId, entry.id, agentUpdate && !App.showMemoryCitations)
        else App.copy(fullText)
    }
    Keys.onEscapePressed: backRequested()
    RowLayout {
        Layout.fillWidth: true
        spacing: Theme.space1
        CButton {
            id: back
            objectName: "activityBack"
            iconName: "back"
            quiet: true
            help: qsTr("Back to timeline")
            implicitHeight: Theme.compactHeight
            implicitWidth: Theme.compactHeight
            onClicked: details.backRequested()
        }
        CText {
            text: details.log.title || ""
            font.weight: Font.DemiBold
            wrapMode: Text.NoWrap
            elide: Text.ElideRight
            Accessible.role: Accessible.Heading
        }
        CButton {
            objectName: "activityCopy"
            quiet: true
            iconName: "copy"
            text: details.width >= Theme.formBreakpoint ? qsTr("Copy") : ""
            help: qsTr("Copy complete log entry")
            implicitHeight: Theme.compactHeight
            onClicked: details.copyOutput()
        }
        CButton {
            id: more
            objectName: "activityMore"
            quiet: true
            iconName: "more"
            implicitHeight: Theme.compactHeight
            implicitWidth: Theme.compactHeight
            help: qsTr("More actions")
            onClicked: actions.popup(more, more.width - actions.width, more.height)
        }
    }
    Rectangle { Layout.fillWidth: true; implicitHeight: Theme.hairline; color: Theme.line }
    PageScroll {
        id: scroll
        objectName: "activityDetailScroll"
        Layout.fillWidth: true
        Layout.fillHeight: true
        maximumContentWidth: width
        ColumnLayout {
            Layout.fillWidth: true
            Layout.leftMargin: Theme.space3
            Layout.topMargin: Theme.space2
            spacing: Theme.space2
            CText {
                text: details.metadata
                color: Theme.muted
                font.pixelSize: Theme.caption
            }
            CText { visible: !!details.info.description; text: details.info.description || "" }
            SectionLabel {
                visible: !!details.info.target
                text: ["commandExecution", "Bash", "exec_command", "functions.exec_command", "host_run"].includes(details.log.name) ? qsTr("Command")
                    : details.log.name === "functions.exec" ? qsTr("Tool input") : qsTr("Target")
            }
            CText {
                visible: !!details.info.target
                objectName: "activityTarget"
                text: details.info.target || ""
                font.family: Theme.mono
            }
            CText {
                visible: !!details.log.name && details.log.name !== details.log.title
                text: qsTr("Tool · %1").arg(details.log.name || "")
                font.pixelSize: Theme.caption
                color: Theme.muted
            }
            CButton {
                objectName: "noProgressStop"
                visible: details.log.noProgress === true && details.entry.sessionId === App.selectedId
                    && ["starting", "working", "waiting"].includes(App.session.status)
                text: qsTr("Stop turn")
                danger: true
                enabled: App.connected
                onClicked: App.rpc("session.stop", {id: details.entry.sessionId})
            }
            SectionLabel { text: details.bodyLabel }
            CText { visible: !!details.info.summary; text: details.info.summary || "" }
            CText {
                visible: details.entry.truncated === true
                text: qsTr("This is a preview. Copy retrieves the complete entry.")
                font.pixelSize: Theme.caption
                color: Theme.muted
            }
            TextArea {
                id: output
                objectName: "activityOutput"
                Layout.fillWidth: true
                Layout.minimumWidth: 0
                padding: Theme.space2
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
                textFormat: TextEdit.PlainText
                text: details.fullText.slice(0, details.previewLimit)
                color: Theme.text
                selectionColor: Theme.selectionFill
                selectedTextColor: Theme.selectionInk
                font.family: details.agentUpdate || details.childTool || details.log.kind === "notice" ? Theme.font : Theme.mono
                font.pixelSize: Theme.secondary
                background: Rectangle { radius: Theme.radiusControl; color: Theme.codeSurface }
                Accessible.name: details.bodyLabel
                TapHandler {
                    acceptedButtons: Qt.RightButton
                    onTapped: point => actions.popup(output, point.position.x, point.position.y)
                }
            }
            CButton {
                visible: details.fullText.length > details.previewLimit
                text: qsTr("Show more output")
                implicitHeight: Theme.compactHeight
                onClicked: details.previewLimit += 8000
            }
            Repeater {
                model: details.entry.sources || []
                CButton {
                    required property var modelData
                    Layout.fillWidth: true
                    text: modelData.title
                    help: modelData.url
                    alignLeft: true
                    iconName: "arrow"
                    onClicked: if (/^https?:\/\//.test(modelData.url)) Qt.openUrlExternally(modelData.url)
                }
            }
            Repeater {
                model: details.entry.artifacts || []
                ArtifactCard {
                    required property var modelData
                    Layout.fillWidth: true
                    reference: modelData
                    sessionId: details.entry.sessionId
                }
            }
        }
    }
    CMenu {
        id: actions
        CMenuItem { visible: !!output.selectedText; text: qsTr("Copy selection"); onTriggered: App.copy(output.selectedText) }
        CMenuItem {
            property bool bookmarked: (App.state.bookmarks || []).some(b => b.messageId === details.entry.id)
            text: bookmarked ? qsTr("Remove bookmark") : qsTr("Bookmark")
            onTriggered: App.rpc("message.bookmark", {sessionId: details.entry.sessionId, messageId: details.entry.id, bookmarked: !bookmarked})
        }
        CMenuItem {
            text: output.selectedText ? qsTr("Speak selection") : qsTr("Speak entry")
            onTriggered: App.rpc("tts.speak", {text: (output.selectedText || details.fullText).slice(0, 20000)})
        }
        CMenuItem {
            visible: ["preparing", "speaking"].includes(App.state.speech?.state) || (App.state.speech?.queued || 0) > 0
            text: qsTr("Stop speaking")
            onTriggered: App.rpc("tts.stop", {})
        }
    }
}
