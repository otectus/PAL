package dev.otectus.pal.mobile

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ScrollBehaviorTest {
    @get:Rule
    val compose = createComposeRule()

    @Test fun newChatSheetHoldsItsGeometryAtTheEndAndScrollsAwayAgain() {
        compose.setContent {
            PALTheme {
                AncillarySheetScaffold(
                    title = "New Chat",
                    busy = false,
                    onDismiss = {},
                    action = { Button(onClick = {}, modifier = Modifier.fillMaxWidth()) { Text("Create conversation") } },
                ) {
                    repeat(18) { index ->
                        Text("Setup option $index", Modifier.fillMaxWidth().height(72.dp))
                    }
                    Text("Last setup option", Modifier.fillMaxWidth().height(72.dp).testTag("sheetEnd"))
                }
            }
        }

        compose.onNodeWithText("New Chat").assertIsDisplayed()
        val scrollable = compose.onAllNodes(hasScrollAction())[0]
        repeat(12) { scrollable.performTouchInput { swipeUp(durationMillis = 80) } }
        compose.onNodeWithTag("sheetEnd").assertIsDisplayed()
        val settledHeader = compose.onNodeWithText("New Chat").bounds()
        val settledEnd = compose.onNodeWithTag("sheetEnd").bounds()
        val pane = compose.onNode(androidx.compose.ui.test.SemanticsMatcher.expectValue(SemanticsProperties.PaneTitle, "New Chat"))

        // Further flings at the lower limit must not move either the sheet chrome or content.
        repeat(6) { scrollable.performTouchInput { swipeUp(durationMillis = 60) } }
        compose.waitForIdle()
        assertRectClose(settledHeader, compose.onNodeWithText("New Chat").bounds())
        assertRectClose(settledEnd, compose.onNodeWithTag("sheetEnd").bounds())

        // Inspect the active edge drag, not only the settled layout. With overscroll and the
        // content-to-sheet handoff blocked, dragging past the end does not transform a pixel.
        val settledPixels = pane.captureToImage()
        scrollable.performTouchInput { down(center); moveBy(Offset(0f, -200f)); advanceEventTime(100) }
        assertImagesEqual(settledPixels, pane.captureToImage())
        scrollable.performTouchInput { up() }

        val bottomOffset = scrollable.scrollValue()
        scrollable.performTouchInput { swipeDown(durationMillis = 250) }
        compose.onNodeWithTag("sheetEnd").assertIsNotDisplayed()
        assertTrue(scrollable.scrollValue() < bottomOffset)
    }

    @Test fun ordinaryMenuListStopsAtItsBoundAndRemainsScrollable() {
        var value by mutableStateOf(0)
        var maximum by mutableStateOf(0)
        compose.setContent {
            PALTheme {
                val state = rememberScrollState()
                value = state.value
                maximum = state.maxValue
                Column(Modifier.fillMaxSize().verticalScroll(state).testTag("menuList")) {
                    repeat(24) { index -> Text("Menu row $index", Modifier.fillMaxWidth().height(64.dp)) }
                }
            }
        }

        val menu = compose.onNodeWithTag("menuList")
        repeat(12) { menu.performTouchInput { swipeUp(durationMillis = 70) } }
        compose.waitUntil(5_000) { maximum > 0 && value == maximum }
        val end = value
        repeat(6) { menu.performTouchInput { swipeUp(durationMillis = 50) } }
        compose.runOnIdle { assertEquals(end, value) }

        menu.performTouchInput { swipeDown(durationMillis = 250) }
        compose.runOnIdle { assertTrue(value in 0 until end) }
    }

    @Test fun expandedSheetStillDismissesFromItsHandle() {
        var open by mutableStateOf(true)
        compose.setContent {
            PALTheme {
                if (open) AncillarySheetScaffold(
                    title = "Dismissible sheet",
                    busy = false,
                    onDismiss = { open = false },
                ) { Text("Sheet content") }
            }
        }

        compose.onNodeWithText("Dismissible sheet").assertIsDisplayed()
        // Start on the handle itself. The handle is 48 dp tall, so a fixed pixel offset above the
        // sheet content lands on the scrim on a low-density screen and drags nothing.
        val handle = compose.onNode(hasContentDescription("Drag handle")).bounds()
        compose.onAllNodes(androidx.compose.ui.test.isRoot())[1].performTouchInput {
            swipe(
                start = handle.center,
                end = Offset(handle.center.x, center.y + 500f),
                durationMillis = 600,
            )
        }
        compose.waitUntil(5_000) { !open }
        compose.onNodeWithText("Dismissible sheet").assertDoesNotExist()
    }

    @Test fun newChatLayoutKeepsItsScrollPositionAcrossTheCompactBreakpoint() {
        var height by mutableStateOf(600.dp)
        compose.setContent {
            PALTheme {
                Box(Modifier.fillMaxSize()) {
                    AncillarySheetLayout(
                        title = "New Chat",
                        busy = false,
                        onDismiss = {},
                        modifier = Modifier.fillMaxWidth().height(height),
                        action = { Button(onClick = {}) { Text("Create conversation") } },
                    ) {
                        repeat(18) { index ->
                            Text("Responsive option $index", Modifier.fillMaxWidth().height(72.dp))
                        }
                    }
                }
            }
        }

        val spaciousBody = compose.onAllNodes(hasScrollAction())[0]
        repeat(6) { spaciousBody.performTouchInput { swipeUp(durationMillis = 100) } }
        val before = spaciousBody.scrollValue()
        assertTrue("Expected the spacious body to be scrolled", before > 0f)

        // Simulates IME/inset or window changes crossing the 420 dp layout threshold.
        compose.runOnIdle { height = 360.dp }
        compose.waitForIdle()
        val compactSheet = compose.onAllNodes(hasScrollAction())[0]
        val after = compactSheet.scrollValue()
        assertEquals("The content offset must survive the scroll-container handoff", before, after, 1f)

        repeat(8) { compactSheet.performTouchInput { swipeUp(durationMillis = 80) } }
        compose.onNodeWithText("Responsive option 17").assertIsDisplayed()
        compactSheet.performTouchInput { swipeDown(durationMillis = 250) }
        compose.onNodeWithText("Responsive option 17").assertIsNotDisplayed()
    }

    private fun SemanticsNodeInteraction.bounds(): Rect = fetchSemanticsNode().boundsInRoot

    private fun SemanticsNodeInteraction.scrollValue(): Float =
        fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()

    private fun assertRectClose(expected: Rect, actual: Rect) {
        val tolerance = 1f
        assertEquals(expected.left, actual.left, tolerance)
        assertEquals(expected.top, actual.top, tolerance)
        assertEquals(expected.right, actual.right, tolerance)
        assertEquals(expected.bottom, actual.bottom, tolerance)
    }

    private fun assertImagesEqual(expected: ImageBitmap, actual: ImageBitmap) {
        assertEquals(expected.width, actual.width)
        assertEquals(expected.height, actual.height)
        val expectedPixels = expected.toPixelMap()
        val actualPixels = actual.toPixelMap()
        for (y in 0 until expected.height) for (x in 0 until expected.width) {
            assertEquals("Pixel changed at $x,$y during the held edge drag", expectedPixels[x, y], actualPixels[x, y])
        }
    }
}
