package dev.otectus.pal.mobile

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.OfflineKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MobilePresentationTest {
    @Test fun textAndControlRolesMeetContrastInBothThemes() {
        fun checkContrast(foreground: Color, background: Color, required: Float) {
            val a = foreground.luminance()
            val b = background.luminance()
            val ratio = (maxOf(a, b) + .05f) / (minOf(a, b) + .05f)
            assertTrue("$foreground against $background has contrast $ratio, requires $required", ratio >= required)
        }
        for (scheme in listOf(Day, Night)) with(scheme) {
            for (backgroundRole in listOf(background, surface, surfaceContainerLowest, surfaceContainerLow,
                surfaceContainer, surfaceContainerHigh, surfaceContainerHighest)) {
                for (textRole in listOf(onSurface, onSurfaceVariant, primary, tertiary, error))
                    checkContrast(textRole, backgroundRole, 4.5f)
                checkContrast(outline, backgroundRole, 3f)
            }
            for ((ink, fill) in listOf(onPrimary to primary, onPrimaryContainer to primaryContainer,
                onSecondary to secondary, onSecondaryContainer to secondaryContainer,
                onTertiary to tertiary, onTertiaryContainer to tertiaryContainer,
                onError to error, onErrorContainer to errorContainer, inverseOnSurface to inverseSurface))
                checkContrast(ink, fill, 4.5f)
        }
    }

    @Test fun connectionActionAndWordingFollowTheObservedState() {
        assertEquals(ConnectionPresentation.Connecting, connectionPresentation(ConnectionState.Connecting, false))
        assertEquals(ConnectionPresentation.Reconnecting, connectionPresentation(ConnectionState.Connecting, true))
        assertTrue(connectionPresentation(ConnectionState.Authenticating, true).busy)
        for ((kind, expected) in mapOf(
            OfflineKind.Unreachable to ConnectionPresentation.Unreachable,
            OfflineKind.NotConnected to ConnectionPresentation.Disconnected,
            OfflineKind.MonitoringOff to ConnectionPresentation.MonitoringOff,
            OfflineKind.PairingChange to ConnectionPresentation.Replacing,
        )) {
            val presentation = connectionPresentation(ConnectionState.Offline("fixture", null, kind), true)
            assertEquals(expected, presentation)
            assertEquals(kind != OfflineKind.PairingChange, presentation.retry)
        }
        assertEquals(ConnectionPresentation.Blocked, connectionPresentation(ConnectionState.Blocked("fixture"), true))
        assertEquals(ConnectionPresentation.Online, connectionPresentation(ConnectionState.Online("desktop", emptySet(), 0), true))
    }
}
