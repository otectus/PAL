package dev.otectus.pal.mobile.data

import java.net.InetAddress
import org.junit.Assert.*
import org.junit.Test

class EndpointsTest {
    private fun desktop(paired: List<String>, found: List<String> = emptyList()) = PairedDesktop("d", "Desktop", "p", "Phone", "", "", paired, "a", "b", 0, foundEndpoints = found)
    private val lan = Endpoints.endpoint("192.168.1.20", 8443); private val vpn = Endpoints.endpoint("100.90.1.2", 8443)

    @Test fun foundAddressesFollowThePairedOnesAndFiveAreKept() {
        val many = (1..9).map { Endpoints.endpoint("192.168.7.$it", 8443) }
        assertEquals(listOf(lan, vpn) + many.take(3), Endpoints.all(desktop(listOf(lan, vpn), many)))
        assertEquals(listOf(lan), Endpoints.all(desktop(listOf(lan), listOf(lan))))
        assertTrue(Endpoints.found(desktop(listOf(lan), listOf(vpn)), vpn))
        assertFalse(Endpoints.found(desktop(listOf(lan), listOf(lan)), lan))
        assertFalse(Endpoints.found(desktop(listOf(lan)), vpn))
    }

    @Test fun onlyPrivateLocalAddressesAreOffered() {
        fun local(value: String) = Endpoints.local(InetAddress.getByName(value))
        for (value in listOf("192.168.0.9", "10.1.2.3", "172.20.0.1")) assertTrue(value, local(value))
        for (value in listOf("127.0.0.1", "169.254.1.1", "8.8.8.8", "100.90.1.2", "224.0.0.251", "fe80::1", "fd00::1", "0.0.0.0")) assertFalse(value, local(value))
    }

    @Test fun aVpnIsTriedFirstOnAVpnAndTheLocalNetworkOtherwise() {
        assertEquals(listOf(vpn, lan), Endpoints.order(listOf(lan, vpn), vpnActive = true, last = null))
        assertEquals(listOf(lan, vpn), Endpoints.order(listOf(vpn, lan), vpnActive = false, last = null))
        // The address that last worked comes first, and the rest follow in order.
        assertEquals(listOf(vpn, lan), Endpoints.order(listOf(lan, vpn), vpnActive = false, last = vpn))
        assertTrue(Endpoints.vpn("fd7a:115c:a1e0::1")); assertFalse(Endpoints.vpn("100.128.0.1")); assertFalse(Endpoints.vpn("desk.local"))
    }

    @Test fun rotationTriesEachAddressAndStartsAgainAfterSigningInOrANetworkChange() {
        val rotation = EndpointRotation(); val all = listOf(vpn, lan)
        assertEquals(lan, rotation.next(all, false)); assertEquals(vpn, rotation.next(all, false)); assertEquals(lan, rotation.next(all, false))
        rotation.connected(vpn); assertEquals(vpn, rotation.next(all, false)); assertEquals(lan, rotation.next(all, false))
        rotation.networkChanged(); assertEquals(lan, rotation.next(all, false))
        assertEquals("wss://[fd00::2]:8443/mobile/v1", Endpoints.endpoint("fd00::2", 8443)); assertEquals("fd00::2", Endpoints.host("wss://[fd00::2]:8443/mobile/v1"))
    }
}
