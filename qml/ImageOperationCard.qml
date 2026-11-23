pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: card
    objectName: "imageOperationCard"
    property string sessionId: ""
    property var operation: ({})
    property string partial: ""
    property var candidatePreviews: ({})
    property bool cancelling: false
    property bool accepting: false
    signal cancelRequested(string operationId)
    signal acceptRequested(string operationId, string candidateId)
    signal compareRequested(var references)

    readonly property bool active: ["prepared", "awaiting_approval", "queued", "dispatching", "running", "cancel_requested"].indexOf(operation.state) >= 0
    readonly property var labels: ({ prepared: "Prepared", awaiting_approval: "Waiting for approval", queued: "Queued", dispatching: "Sending", running: "Generating", cancel_requested: "Cancelling", completed: "Complete", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", unknown: "Outcome unknown" })
    function usageText() {
        const usage = operation.usage || {}, parts = []
        for (const key of Object.keys(usage)) if (usage[key] !== undefined && usage[key] !== "") parts.push(key.replace(/_/g, " ") + " " + usage[key])
        return parts.join(" · ")
    }
    implicitHeight: body.implicitHeight + Theme.space4
    radius: Theme.radiusControl
    color: Theme.surface
    border.color: operation.state === "failed" || operation.state === "unknown" ? Theme.dangerBorder : active ? Theme.activeBorder : Theme.border
    Accessible.role: Accessible.Grouping
    Accessible.name: (operation.label || "Image run") + ", " + (labels[operation.state] || operation.state || "")

    ColumnLayout {
        id: body
        anchors.fill: parent
        anchors.margins: Theme.space2
        spacing: Theme.space1
        RowLayout {
            Layout.fillWidth: true
            CText { Layout.fillWidth: true; text: card.operation.label || "Image run"; font.weight: Font.DemiBold; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            CText { Layout.fillWidth: false; text: card.labels[card.operation.state] || card.operation.state || ""; color: card.operation.state === "completed" ? Theme.success : card.active ? Theme.amber : Theme.muted; font.pixelSize: Theme.caption }
        }
        CText {
            visible: !!card.operation.progress && (card.operation.progress.max > 0 || !!card.operation.progress.note)
            Layout.fillWidth: true
            text: card.operation.progress ? (card.operation.progress.max ? "Step " + card.operation.progress.value + " of " + card.operation.progress.max : "") + (card.operation.progress.note ? " · " + card.operation.progress.note : "") : ""
            color: Theme.muted
            font.pixelSize: Theme.caption
        }
        ProgressBar {
            visible: card.active && !!card.operation.progress?.max
            Layout.fillWidth: true
            from: 0
            to: Math.max(1, card.operation.progress?.max || 1)
            value: card.operation.progress?.value || 0
            Accessible.name: "Image generation progress"
        }
        Image {
            visible: !!card.partial && card.operation.state !== "completed"
            Layout.fillWidth: true
            Layout.preferredHeight: Theme.editorMedium
            fillMode: Image.PreserveAspectFit
            source: card.partial
            asynchronous: true
            CText { anchors.left: parent.left; anchors.bottom: parent.bottom; text: "Provisional preview"; color: Theme.amber; font.pixelSize: Theme.caption }
        }
        CText { visible: !!card.operation.error; Layout.fillWidth: true; text: card.operation.error || ""; color: Theme.danger; font.pixelSize: Theme.caption }
        CText { visible: !!card.operation.cancellation; Layout.fillWidth: true; text: card.operation.cancellation || ""; color: Theme.amber; font.pixelSize: Theme.caption }
        CText { visible: !!card.usageText(); Layout.fillWidth: true; text: "Reported usage · " + card.usageText(); color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap }
        CText { visible: (card.operation.details?.unprotectedCandidates || []).length > 0; Layout.fillWidth: true; text: "Protected compositing could not align these results. You can keep an unprotected candidate explicitly."; color: Theme.amber; font.pixelSize: Theme.caption; wrapMode: Text.Wrap }
        Flow {
            id: candidateFlow
            visible: (card.operation.details?.unprotectedCandidates || []).length > 0
            Layout.fillWidth: true; spacing: Theme.space2
            Repeater {
                model: card.operation.details?.unprotectedCandidates || []
                Rectangle {
                    id: candidateTile
                    required property var modelData; required property int index
                    width: Math.min(Theme.fieldWidth, candidateFlow.width); implicitHeight: candidateBody.implicitHeight + Theme.space2
                    color: Theme.codeSurface; radius: Theme.radiusChip; border.color: modelData.accepted ? Theme.primaryBorder : Theme.border
                    ColumnLayout { id: candidateBody; anchors.fill: parent; anchors.margins: Theme.space1; spacing: Theme.space1
                        Image { Layout.fillWidth: true; Layout.preferredHeight: Theme.thumbHeight; fillMode: Image.PreserveAspectFit; asynchronous: true; source: card.candidatePreviews[card.operation.operationId + ":" + candidateTile.modelData.candidateId] || "" }
                        CText { visible: !card.candidatePreviews[card.operation.operationId + ":" + candidateTile.modelData.candidateId]; Layout.fillWidth: true; text: "Loading candidate…"; color: Theme.muted; font.pixelSize: Theme.caption; horizontalAlignment: Text.AlignHCenter }
                        CButton { objectName: "imageCandidate_" + candidateTile.index; Layout.fillWidth: true; text: candidateTile.modelData.accepted ? "Kept" : card.accepting ? "Keeping…" : "Keep candidate " + (candidateTile.index + 1); enabled: !candidateTile.modelData.accepted && !card.accepting; danger: !candidateTile.modelData.accepted; quiet: true; implicitHeight: Theme.compactHeight; onClicked: { card.accepting = true; card.acceptRequested(card.operation.operationId, candidateTile.modelData.candidateId) } }
                        CButton { visible: !!candidateTile.modelData.accepted && (card.operation.results || []).some(ref => ref.versionId !== candidateTile.modelData.accepted.versionId); Layout.fillWidth: true; text: "Compare"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: { const other = (card.operation.results || []).find(ref => ref.versionId !== candidateTile.modelData.accepted.versionId); card.compareRequested([candidateTile.modelData.accepted, other]) } }
                    }
                }
            }
        }
        CButton { visible: (card.operation.results || []).length >= 2; text: "Compare results"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: card.compareRequested((card.operation.results || []).slice(0, 2)) }
        Repeater {
            model: (card.operation.results || []).slice(0, 4)
            ArtifactCard { required property var modelData; Layout.fillWidth: true; reference: modelData; sessionId: card.sessionId }
        }
        CButton {
            objectName: "imageOperationCancel"
            visible: card.active && card.operation.state !== "cancel_requested"
            text: card.cancelling ? "Cancelling…" : "Cancel"
            enabled: !card.cancelling
            danger: true
            quiet: true
            implicitHeight: Theme.compactHeight
            onClicked: { card.cancelling = true; card.cancelRequested(card.operation.operationId) }
        }
    }
}
