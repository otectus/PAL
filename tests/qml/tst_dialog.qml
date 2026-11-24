import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtTest
import "../../qml" as PAL

Item {
    id: scene
    width: 720; height: 600; visible: true
    Component {
        id: dialogComponent
        PAL.CDialog {
            id: dialog
            property real extra: 0
            readonly property alias lines: wrapped
            // Like text that needs one more line once the scroll bar takes its room.
            Item { id: wrapped; objectName: "wrapped"; Layout.fillWidth: true; implicitHeight: 120 + dialog.extra + (width < dialog.width - dialog.inset * 2 - 1 ? 40 : 0) }
        }
    }
    TestCase {
        name: "Dialog"
        when: windowShown
        function test_aBodyThatWrapsSettles() {
            const dialog = createTemporaryObject(dialogComponent, scene); verify(dialog); dialog.open(); tryCompare(dialog, "opened", true)
            const body = dialog.lines, wide = dialog.width - dialog.inset * 2
            tryCompare(body, "width", wide)
            // Growing and shrinking while it is open: the dialog follows, and no scroll bar is shown while everything fits.
            for (const extra of [60, 200, 20, 260, 0]) { dialog.extra = extra; tryCompare(dialog, "height", 120 + extra + dialog.inset * 2); compare(body.width, wide) }
            // Once it cannot fit it scrolls, makes room for the bar and stays that way; then back again.
            dialog.extra = 900; tryCompare(body, "width", wide - PAL.Theme.minimumTarget); tryVerify(() => dialog.height <= scene.height); wait(50); compare(body.width, wide - PAL.Theme.minimumTarget)
            dialog.extra = 10; tryCompare(body, "width", wide); tryCompare(dialog, "height", 130 + dialog.inset * 2)
            dialog.close(); tryCompare(dialog, "visible", false)
        }
    }
}
