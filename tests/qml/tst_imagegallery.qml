import QtQuick
import QtTest
import "../../qml" as PAL

Item {
    id: scene
    width: 330
    height: 640
    visible: true
    SignalSpy { id: removeSpy; signalName: "removeRequested" }
    SignalSpy { id: cancelSpy; signalName: "cancelRequested" }
    SignalSpy { id: acceptSpy; signalName: "acceptRequested" }

    Component {
        id: chipComponent
        PAL.ImageReferenceChip {
            reference: ({ artifactId: "artifact", versionId: "1234567890", name: "A deliberately long guide image name" })
            label: "Composition"
        }
    }
    Component {
        id: operationComponent
        PAL.ImageOperationCard {
            width: 330
            sessionId: "session"
            operation: ({
                operationId: "operation",
                label: "Create a narrow image",
                state: "running",
                progress: { value: 2, max: 5, note: "Sampling" },
                usage: { images: 2 },
                details: { unprotectedCandidates: [{ candidateId: "candidate" }, { candidateId: "kept", accepted: { artifactId: "artifact", versionId: "version" } }] },
                results: []
            })
        }
    }

    TestCase {
        name: "ImageGalleryComponents"
        when: windowShown

        function test_referenceChipFitsNarrowPaneAndRemoves() {
            const chip = createTemporaryObject(chipComponent, scene)
            verify(chip)
            verify(chip.implicitWidth <= 330)
            const remove = findChild(chip, "imageReferenceRemove")
            verify(remove)
            removeSpy.target = chip
            removeSpy.clear()
            mouseClick(remove)
            compare(removeSpy.count, 1)
        }

        function test_operationExposesProgressCancelAndCandidateChoice() {
            const card = createTemporaryObject(operationComponent, scene)
            verify(card)
            verify(card.implicitHeight > 0)
            const cancel = findChild(card, "imageOperationCancel")
            const candidate = findChild(card, "imageCandidate_0")
            const kept = findChild(card, "imageCandidate_1")
            verify(cancel)
            verify(candidate)
            verify(kept)
            compare(kept.text, "Kept")
            verify(!kept.enabled)
            cancelSpy.target = card
            acceptSpy.target = card
            cancelSpy.clear()
            acceptSpy.clear()
            mouseClick(cancel)
            candidate.clicked()
            compare(cancelSpy.count, 1)
            compare(cancelSpy.signalArguments[0][0], "operation")
            compare(acceptSpy.count, 1)
            compare(acceptSpy.signalArguments[0][1], "candidate")
            verify(!cancel.enabled)
            verify(!candidate.enabled)
        }
    }
}
