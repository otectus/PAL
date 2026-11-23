package dev.otectus.pal.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.test.platform.app.InstrumentationRegistry
import dev.otectus.pal.mobile.data.ConnectionState
import org.junit.Rule
import org.junit.Test

class CompanionHeaderTest {
    @get:Rule
    val compose = createComposeRule()

    @Test fun headerShowsTheInstalledMobileVersionAndKeepsConnectionStatus() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        @Suppress("DEPRECATION")
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val version = info.versionName?.trim()?.takeIf(String::isNotEmpty) ?: info.longVersionCode.toString()
        val desktopName = "Custom legacy desktop label"
        val connectionText = "Connected"
        val connection = ConnectionState.Online(desktopName, emptySet(), Long.MAX_VALUE)

        compose.setContent {
            MaterialTheme {
                CompanionHeader(connection, connectionText, onConnection = {}, onRetry = {})
            }
        }

        compose.onNodeWithText("PAL").assertIsDisplayed()
        compose.onNodeWithText(version).assertIsDisplayed()
        compose.onNodeWithText(connectionText).assertIsDisplayed()
        compose.onAllNodesWithText(desktopName).assertCountEquals(0)
    }
}
