import QtQuick
import QtQuick.Controls
import QtTest
import "../../qml" as PAL

Item {
    id: scene
    width: 320; height: 240; visible: true
    Component {
        id: scrolling
        ScrollView {
            id: view
            property real bodyHeight: 600
            property real bodyWidth: availableWidth
            readonly property alias vertical: verticalBar
            readonly property alias horizontal: horizontalBar
            width: 200; height: 120; topPadding: 6; clip: true; contentWidth: bodyWidth; contentHeight: bodyHeight
            ScrollBar.vertical: PAL.CScrollBar { id: verticalBar }
            ScrollBar.horizontal: PAL.CScrollBar { id: horizontalBar }
            Item { width: view.bodyWidth; height: view.bodyHeight }
        }
    }
    Component {
        id: flicking
        Flickable {
            property alias bar: attached
            width: 200; height: 120; contentWidth: width; contentHeight: 600
            ScrollBar.vertical: PAL.CScrollBar { id: attached }
        }
    }
    Component { id: alone; PAL.CScrollBar { policy: ScrollBar.AlwaysOn } }
    TestCase {
        name: "ScrollBar"
        when: windowShown
        function thumb(bar) { return bar.contentItem.children[0] }
        // A ScrollView does not place a bar it is given; left alone, the bar stays at its top left.
        function test_aScrollViewsBarLiesAlongItsEdge() {
            const view = createTemporaryObject(scrolling, scene); verify(view)
            const bar = view.vertical
            tryVerify(() => bar.size > 0 && bar.size < 1)
            compare(bar.x, view.width - bar.width); compare(bar.y, view.topPadding); compare(bar.height, view.availableHeight)
            verify(bar.visible && thumb(bar).visible)
            view.width = 260; view.height = 160
            compare(bar.x, view.width - bar.width); compare(bar.height, view.availableHeight)
            view.bodyWidth = 900
            tryVerify(() => view.horizontal.visible)
            compare(view.horizontal.y, view.height - view.horizontal.height); compare(view.horizontal.width, view.availableWidth)
        }
        // Nothing is drawn, and no press is taken, where there is nothing to scroll.
        function test_aPageThatFitsShowsNoThumb() {
            const view = createTemporaryObject(scrolling, scene, { bodyHeight: 40 }); verify(view)
            tryVerify(() => !view.vertical.visible); verify(!view.horizontal.visible)
            view.bodyHeight = 600; tryVerify(() => view.vertical.visible)
            view.bodyHeight = 40; tryVerify(() => !view.vertical.visible)
        }
        function test_aFlickableStillPlacesItsOwnBar() {
            const view = createTemporaryObject(flicking, scene); verify(view)
            tryVerify(() => view.bar.size > 0 && view.bar.size < 1)
            compare(view.bar.x, view.width - view.bar.width); compare(view.bar.height, view.height); verify(view.bar.visible)
        }
        function test_aBarWithoutAnythingToShowHasNoThumb() {
            const bar = createTemporaryObject(alone, scene); verify(bar)
            compare(bar.size, 0); verify(bar.visible && !thumb(bar).visible)
        }
    }
}
