package dev.otectus.pal.mobile

import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PairedDesktop
import dev.otectus.pal.mobile.protocol.Approval
import java.net.InetAddress
import org.junit.Assert.*
import org.junit.Test

class ReachabilityRulesTest {
    private val lan = InetAddress.getByName("192.168.1.20")
    private fun announced(id: String? = "d-1", version: String? = "1", address: InetAddress? = lan, port: Int = 8443, type: String = "._pal._tcp") =
        announcedEndpoint("d-1", type, buildMap { id?.let { put("id", it.toByteArray()) }; version?.let { put("v", it.toByteArray()) } }, address, port)

    @Test fun anAnnouncementMustNameThisDesktopAndThisProtocolAtALocalAddress() {
        assertEquals("wss://192.168.1.20:8443/mobile/v1", announced())
        assertNull(announced(id = "somebody-else")); assertNull(announced(id = null)); assertNull(announced(version = "2")); assertNull(announced(version = null))
        assertNull(announced(type = "._http._tcp")); assertNull(announced(port = 443)); assertNull(announced(port = 70000)); assertNull(announced(address = null))
        for (outside in listOf("8.8.8.8", "127.0.0.1", "169.254.3.4", "100.90.1.2", "fe80::1")) assertNull(outside, announced(address = InetAddress.getByName(outside)))
    }

    @Test fun theTileAndWidgetCountOnlyWhatIsTrueNow() {
        val desktop = PairedDesktop("d", "Desk", "p", "Phone", "", "", emptyList(), "a", "b", 0)
        val request = Approval(id = "a", sessionId = "s", kind = "command", title = "t", detail = "", choices = emptyList(), revision = "1", digest = "d", canAnswer = true)
        val online = MobileState(restoreReady = true, desktop = desktop, connection = ConnectionState.Online("Desk", emptySet(), 0), approvals = listOf(request), monitoring = true)
        assertEquals(1, glance(online).waiting); assertTrue(glance(online).online); assertTrue(glance(online).monitoring)
        assertEquals(0, glance(online.copy(connection = ConnectionState.Offline("x", null))).waiting)
        assertFalse(glance(MobileState()).paired); assertFalse(glance(MobileState()).ready)
    }
}
