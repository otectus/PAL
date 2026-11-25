import QtQuick
import QtTest
import "../../qml"

Item {
    id: page
    width: 400; height: 200
    // As the broker sends it: each state is a new object, whether or not anything in it changed.
    property var state: ({ pitch: 0, days: 7 })
    CSlider { id: slider; width: 300; from: -6; to: 6; stepSize: .5; saved: page.state.pitch; property var kept: []; onPressedChanged: if (!pressed) kept = kept.concat([value]) }
    CSpinBox { id: days; y: 60; from: 0; to: 365; saved: page.state.days }
    TestCase {
        name: "Slider"; when: windowShown
        function init() { page.state = { pitch: -1, days: 1 }; page.state = { pitch: 0, days: 7 }; slider.kept = []; slider.forceActiveFocus(); compare(slider.value, 0); compare(days.value, 7) }
        function test_aStateUpdateWhileAKeyIsHeldDoesNotTakeTheStepBack() {
            keyPress(Qt.Key_Right); page.state = { pitch: 0, days: 7 }; keyRelease(Qt.Key_Right)
            compare(slider.value, .5); compare(slider.kept, [.5])
        }
        function test_anotherValueWaitsUntilTheHandleIsLetGo() {
            keyPress(Qt.Key_Right); page.state = { pitch: 4, days: 7 }; compare(slider.value, .5); keyRelease(Qt.Key_Right); compare(slider.kept, [.5])
            page.state = { pitch: 2, days: 7 }; compare(slider.value, 2)
        }
        function test_aDragSurvivesStateUpdates() {
            mousePress(slider, slider.width / 2, slider.height / 2); mouseMove(slider, slider.width * .6, slider.height / 2); mouseMove(slider, slider.width * .75, slider.height / 2)
            const moved = slider.value; verify(moved > 0); page.state = { pitch: 0, days: 7 }; compare(slider.value, moved)
            mouseRelease(slider, slider.width * .75, slider.height / 2); compare(slider.kept, [moved])
        }
        function test_aNumberBeingChosenIsKeptUntilTheStoredOneChanges() {
            days.forceActiveFocus(); keyClick(Qt.Key_Up); compare(days.value, 8); page.state = { pitch: 0, days: 7 }; compare(days.value, 8)
            page.state = { pitch: 0, days: 30 }; compare(days.value, 30)
        }
    }
}
