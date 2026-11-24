package dev.otectus.pal.mobile.data

import java.net.InetAddress
import java.net.URI

/**
 * Where the desktop may be reached: the addresses in its pairing offer, then addresses the person accepted after the
 * phone found them on its own network. A found address is only a hint. It is kept after it presents the key this phone
 * paired with, and dropped when it stops doing so; nothing is sent to it before that check.
 */
object Endpoints {
    const val MAX = 5

    fun all(desktop: PairedDesktop): List<String> = (desktop.endpoints + desktop.foundEndpoints).distinct().take(MAX)
    fun host(endpoint: String): String = runCatching { URI(endpoint).host.orEmpty().removePrefix("[").removeSuffix("]") }.getOrDefault("")
    fun endpoint(address: String, port: Int): String = "wss://${if (':' in address) "[$address]" else address}:$port/mobile/v1"
    /** One the person accepted after a search, rather than one from the pairing offer. */
    fun found(desktop: PairedDesktop, endpoint: String) = endpoint !in desktop.endpoints && endpoint in desktop.foundEndpoints

    /** An address a search may offer: a private IPv4 address, never loopback, link-local, a VPN's or a public one. */
    fun local(address: InetAddress): Boolean = address is java.net.Inet4Address && address.isSiteLocalAddress
    /** An address on the carrier-grade range Tailscale uses; others cannot be told from a local network by their number. */
    fun vpn(host: String): Boolean {
        val parts = host.split('.').mapNotNull { it.toIntOrNull() }
        return parts.size == 4 && parts[0] == 100 && parts[1] in 64..127 || host.startsWith("fd7a:115c:a1e0", ignoreCase = true)
    }
    /** The order to try: the address that last worked, then VPN addresses on a VPN and local ones otherwise. */
    fun order(endpoints: List<String>, vpnActive: Boolean, last: String?): List<String> =
        endpoints.sortedWith(compareBy({ it != last }, { vpn(host(it)) != vpnActive }))
}

/** Which address to try next. A network change or a sign-in starts the order again. */
internal class EndpointRotation {
    private var attempt = 0
    private var last: String? = null
    @Synchronized fun next(endpoints: List<String>, vpnActive: Boolean): String = Endpoints.order(endpoints, vpnActive, last).let { it[attempt++ % it.size] }
    @Synchronized fun connected(endpoint: String?) { if (endpoint != null) last = endpoint; attempt = 0 }
    @Synchronized fun networkChanged() { attempt = 0; last = null }
}
