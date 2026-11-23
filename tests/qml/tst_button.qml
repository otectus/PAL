import QtQuick
import QtTest
import "../../qml" as PAL

Rectangle {
    id: scene
    width: 200
    height: width
    color: "black"

    Component {
        id: action
        PAL.CButton {
            quiet: true
            background: Rectangle { color: "blue" }
        }
    }

    TestCase {
        name: "IconButton"
        when: windowShown

        function test_centeredArtwork_data() {
            return [
                { tag: "compact copy", icon: "copy", size: PAL.Theme.compactHeight },
                { tag: "compact menu", icon: "more", size: PAL.Theme.compactHeight },
                { tag: "standard menu", icon: "more", size: PAL.Theme.controlHeight }
            ]
        }

        function test_centeredArtwork(data) {
            const button = createTemporaryObject(action, scene, { iconName: data.icon, width: data.size, height: data.size })
            verify(button)
            verify(waitForRendering(button))
            const image = grabImage(scene)
            // Measure the painted button and glyph in the same pixels at every display scale.
            let side = 0
            while (side < image.width && image.blue(side, 0) > 128) ++side
            verify(side > 0 && side < image.width)
            let left = side, right = -1, top = side, bottom = -1
            for (let y = 0; y < side; ++y) {
                for (let x = 0; x < side; ++x) {
                    if (image.red(x, y) < 64) continue
                    left = Math.min(left, x)
                    right = Math.max(right, x)
                    top = Math.min(top, y)
                    bottom = Math.max(bottom, y)
                }
            }
            verify(right >= left, "Icon is visible")
            fuzzyCompare((left + right + 1) / 2, side / 2, 1, "Horizontal icon center")
            fuzzyCompare((top + bottom + 1) / 2, side / 2, 1, "Vertical icon center")
        }
    }
}
