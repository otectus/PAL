package dev.otectus.pal.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class NavigationTest {
    @Test fun versionLabelKeepsInstalledCustomAndLegacyVersionNames() {
        assertEquals("2.0.0", mobileVersionLabel("2.0.0", 2_000_000))
        assertEquals("2.0.0-custom", mobileVersionLabel(" 2.0.0-custom ", 2_000_000))
        assertEquals("1005", mobileVersionLabel(null, 1005))
        assertEquals("1005", mobileVersionLabel("   ", 1005))
    }
}
