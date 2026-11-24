package dev.otectus.pal.mobile

import android.content.Context
import android.content.Intent
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.platform.app.InstrumentationRegistry
import dev.otectus.pal.mobile.data.*
import dev.otectus.pal.mobile.protocol.Approval
import dev.otectus.pal.mobile.protocol.CanonicalJson
import java.io.File
import java.math.BigInteger
import java.net.InetAddress
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Finding the desktop again, optional wake-ups, the widget and the shortcuts: what each may say, and to whom. */
class ReachabilityTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val repository get() = (context.applicationContext as PALApp).repository
    private fun column(content: @Composable () -> Unit) {
        compose.activity.runOnUiThread { compose.activity.setContent { PALTheme { Surface { Column(Modifier.padding(PALLayout.gutter).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) { content() } } } } }
        compose.waitForIdle()
    }
    private fun capture(name: String) { runCatching { File(context.getExternalFilesDir(null), "$name.png").outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } } }
    private val lan = Endpoints.endpoint("192.168.1.20", 8443)
    private fun desktop(paired: List<String> = listOf(lan), found: List<String> = emptyList(), certificate: String = "", spki: String = "") = PairedDesktop("d-1", "Desk", "p-1", "Phone", certificate, spki, paired, "a", "b", 0, foundEndpoints = found)
    private val online = ConnectionState.Online("Desk", setOf("wake.status", "wake.register", "wake.clear"), 0)
    private fun paired(wake: WakeState? = null, connection: ConnectionState = online, desktop: PairedDesktop = desktop()) = MobileState(restoreReady = true, desktop = desktop, connection = connection, wake = wake)
    private fun registration(status: WakeStatus, problem: String? = null) = WakeState("t", "org.push", "", "", "", "https://push.example/x", true, status, "push.example", problem)

    private var keep = false
    @After fun clear() = runBlocking { if (!keep) repository.stopWake(); Unit }

    // ── The pin ───────────────────────────────────────────────────────────────────────────────────
    private class Server(key: String, certificate: String) : AutoCloseable {
        @Volatile var requests = 0
        private val socket: SSLServerSocket
        init {
            val chain = CertificateFactory.getInstance("X.509").generateCertificate(CanonicalJson.decodeBase64Url(certificate).inputStream())
            val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setKeyEntry("k", KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(CanonicalJson.decodeBase64Url(key))), CharArray(0), arrayOf(chain)) }
            val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, CharArray(0)) }
            val ssl = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }
            socket = ssl.serverSocketFactory.createServerSocket(0, 4, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
            thread(isDaemon = true) { while (!socket.isClosed) runCatching { socket.accept().use { client ->
                val line = client.inputStream.bufferedReader().readLine() ?: return@use
                if (line.startsWith("HEAD ")) { requests++; client.outputStream.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray()); client.outputStream.flush() }
            } } }
        }
        val endpoint get() = "wss://127.0.0.1:${socket.localPort}/mobile/v1"
        override fun close() = socket.close()
    }
    private fun probe(endpoint: String): Boolean {
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(CanonicalJson.decodeBase64Url(TlsFixtures.PAIRED).inputStream())
        val target = desktop(listOf("wss://10.0.2.2:8443/mobile/v1"), certificate = TlsFixtures.PAIRED, spki = CanonicalJson.base64Url(MessageDigest.getInstance("SHA-256").digest(certificate.publicKey.encoded)))
        return runCatching { PinnedTls.client(target, endpoint).newBuilder().callTimeout(8, TimeUnit.SECONDS).build().newCall(okhttp3.Request.Builder().url(endpoint.replaceFirst("wss://", "https://")).head().build()).execute().use { true } }.getOrDefault(false)
    }
    @Test fun anAddressCountsOnlyWhenItPresentsThePinnedKeyForThatAddress() {
        Server(TlsFixtures.KEY, TlsFixtures.RENEWED).use { server -> assertTrue("the desktop renewed its certificate with the same key", probe(server.endpoint)); assertEquals(1, server.requests) }
        Server(TlsFixtures.OTHER_KEY, TlsFixtures.OTHER).use { server -> assertFalse("another machine", probe(server.endpoint)); assertEquals("nothing was sent to it", 0, server.requests) }
        Server(TlsFixtures.KEY, TlsFixtures.PAIRED).use { server -> assertFalse("a certificate for another address", probe(server.endpoint)); assertEquals(0, server.requests) }
    }

    // ── Finding the desktop ───────────────────────────────────────────────────────────────────────
    @Test fun aFoundAddressIsOfferedCheckedAndOnlyThenKept() {
        val other = Endpoints.endpoint("192.168.1.77", 8443); var answer = false; val asked = mutableListOf<String>()
        column { FindDesktop(repository, paired(), { _, id -> assertEquals("d-1", id); flowOf(lan, other, other) }, { asked += it; answer }) }
        compose.onNodeWithText(context.getString(R.string.find_start)).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.find_use, "192.168.1.77")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(context.getString(R.string.find_known, "192.168.1.20")).assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.find_use, "192.168.1.77")).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.find_mismatch, "192.168.1.77")).fetchSemanticsNodes().isNotEmpty() }
        answer = true
        compose.onNodeWithText(context.getString(R.string.find_use, "192.168.1.77")).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.find_added, "192.168.1.77")).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf(other, other), asked); capture("find-desktop")
    }
    @Test fun aFullListSaysSoAndNothingFoundSaysSo() {
        val full = desktop((1..3).map { Endpoints.endpoint("192.168.9.$it", 8443) }, (4..5).map { Endpoints.endpoint("192.168.9.$it", 8443) })
        column { FindDesktop(repository, paired(desktop = full), { _, _ -> flowOf(Endpoints.endpoint("192.168.1.77", 8443)) }, { fail("not asked"); true }) }
        compose.onNodeWithContentDescription(context.getString(R.string.find_remove_description, "192.168.9.4")).assertIsDisplayed()
        compose.onNodeWithText(context.getString(R.string.find_start)).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.find_use, "192.168.1.77")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(context.getString(R.string.find_use, "192.168.1.77")).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.find_full)).fetchSemanticsNodes().isNotEmpty() }
        column { FindDesktop(repository, paired(), { _, _ -> flowOf() }) }
        compose.onNodeWithText(context.getString(R.string.find_start)).performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText(context.getString(R.string.find_none)).fetchSemanticsNodes().isNotEmpty() }
    }
    @Test fun androidsOwnSearchFindsAnAnnouncementWithThisDesktopsIdOnly() = runBlocking {
        val manager = context.getSystemService(NsdManager::class.java)!!; val listeners = mutableListOf<NsdManager.RegistrationListener>()
        fun announce(name: String, id: String) { val listener = object : NsdManager.RegistrationListener {
            override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) {}
            override fun onServiceRegistered(info: NsdServiceInfo) {}
            override fun onServiceUnregistered(info: NsdServiceInfo) {}
        }; manager.registerService(NsdServiceInfo().apply { serviceName = name; serviceType = "_pal._tcp"; port = 8443; setAttribute("v", "1"); setAttribute("id", id) }, NsdManager.PROTOCOL_DNS_SD, listener); listeners += listener }
        try {
            announce("pal-other", "somebody-else"); announce("pal-test", "d-nsd")
            delay(1_500)
            val found = withTimeoutOrNull(20_000) { DesktopSearch(context).find("d-nsd").first() }
            assertNotNull("the announcement was found", found)
            assertTrue(found!!, found.startsWith("wss://") && found.endsWith(":8443/mobile/v1") && Endpoints.local(InetAddress.getByName(Endpoints.host(found))))
            assertNull(withTimeoutOrNull(4_000) { DesktopSearch(context).find("nobody").first() })
        } finally { listeners.forEach { runCatching { manager.unregisterService(it) } } }
    }

    // ── Wake-ups ──────────────────────────────────────────────────────────────────────────────────
    @Test fun wakeUpsSayWhereTheyStandAndWhoDecides() {
        column { WakeUpSettings(repository, paired(), { emptyList() }) }
        compose.onNodeWithText(context.getString(R.string.wake_no_app)).assertIsDisplayed()
        column { WakeUpSettings(repository, paired(), { listOf(PushApp("org.push", "ntfy")) }) }
        compose.onNodeWithText(context.getString(R.string.wake_use, "ntfy")).assertIsEnabled()
        column { WakeUpSettings(repository, paired(connection = ConnectionState.Offline("x", null)), { listOf(PushApp("org.push", "ntfy")) }) }
        compose.onNodeWithText(context.getString(R.string.wake_use, "ntfy")).assertIsNotEnabled(); compose.onNodeWithText(context.getString(R.string.wake_offline)).assertIsDisplayed()
        column { WakeUpSettings(repository, paired(connection = ConnectionState.Online("Desk", emptySet(), 0)), { listOf(PushApp("org.push", "ntfy")) }) }
        compose.onNodeWithText(context.getString(R.string.wake_unsupported)).assertIsDisplayed()
        column { WakeUpSettings(repository, paired(registration(WakeStatus.Waiting))) }
        compose.onNodeWithText(context.getString(R.string.wake_waiting, "push.example")).assertIsDisplayed(); compose.onNodeWithText(context.getString(R.string.wake_stop)).assertIsEnabled(); capture("wake-waiting")
        column { WakeUpSettings(repository, paired(registration(WakeStatus.On))) }
        compose.onNodeWithText(context.getString(R.string.wake_on, "org.push (push.example)")).assertIsDisplayed()
        column { WakeUpSettings(repository, paired(registration(WakeStatus.Failing, "The push server answered HTTP 503"))) }
        compose.onNodeWithText(context.getString(R.string.wake_failing, "The push server answered HTTP 503")).assertIsDisplayed()
        column { WakeUpSettings(repository, paired(registration(WakeStatus.Refused))) }
        compose.onNodeWithText(context.getString(R.string.wake_refused, context.getString(R.string.wake_refused_detail))).assertIsDisplayed(); compose.onNodeWithText(context.getString(R.string.wake_retry)).assertIsEnabled()
    }

    @Test fun aPushAppIsAskedForAnAddressAndItsAnswerIsKept() = runBlocking {
        val push = WakeUps.apps(context).firstOrNull { it.packageName == context.packageName + ".test" }
        assertNotNull("the push app is listed", push)
        val wake = repository.beginWake(push!!.packageName)
        WakeUps.register(context, wake, "k".repeat(87))
        val endpoint = withTimeoutOrNull(10_000) { repository.state.first { it.wake?.endpoint != null }.wake }
        // Android told the push app who asked, and it got the desktop's sending key.
        assertEquals("https://push.example/known/key87", endpoint?.endpoint); assertEquals(false, endpoint?.delivered)
        assertEquals(wake.token, endpoint?.token)
    }

    private fun push(intent: Intent) = context.sendBroadcast(intent.setClassName(context.packageName, WakeReceiver::class.java.name).addFlags(Intent.FLAG_RECEIVER_FOREGROUND))
    private fun seal(plain: ByteArray, wake: WakeState): ByteArray {
        val curve = AlgorithmParameters.getInstance("EC").run { init(ECGenParameterSpec("secp256r1")); getParameterSpec(ECParameterSpec::class.java) }
        val pair = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        fun fixed(value: BigInteger) = value.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else ByteArray(32 - it.size) + it }
        fun mac(key: ByteArray, vararg parts: ByteArray) = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); parts.forEach(::update); doFinal() }
        val own = (pair.public as ECPublicKey).w.let { byteArrayOf(4) + fixed(it.affineX) + fixed(it.affineY) }; val phone = CanonicalJson.decodeBase64Url(wake.publicKey); val salt = ByteArray(16) { 3 }
        val shared = KeyAgreement.getInstance("ECDH").run { init(pair.private); doPhase(KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, phone.copyOfRange(1, 33)), BigInteger(1, phone.copyOfRange(33, 65))), curve)), true); generateSecret() }
        val one = byteArrayOf(1); val zero = byteArrayOf(0)
        val secret = mac(salt, mac(mac(CanonicalJson.decodeBase64Url(wake.auth), shared), "WebPush: info".toByteArray() + zero, phone, own, one))
        val key = mac(secret, "Content-Encoding: aes128gcm".toByteArray() + zero, one).copyOf(16); val nonce = mac(secret, "Content-Encoding: nonce".toByteArray() + zero, one).copyOf(12)
        val body = Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); doFinal(plain + byteArrayOf(2)) }
        return salt + byteArrayOf(0, 0, 16, 0, 65) + own + body
    }
    private fun hint(time: Long) = ByteBuffer.allocate(28).put("PALW".toByteArray()).putLong(time).put(ByteArray(16) { 1 }).array()

    @Test fun onlyThisPhonesTokenAndKeysCountAndAHintCountsOnce() = runBlocking {
        val wake = repository.beginWake("org.push")
        fun message(token: String, bytes: ByteArray) = push(Intent(WakeUps.MESSAGE).putExtra("token", token).putExtra("bytesMessage", bytes).putExtra("id", "x"))
        push(Intent(WakeUps.NEW_ENDPOINT).putExtra("token", "another-token").putExtra("endpoint", "https://evil.example/"))
        message("another-token", seal(hint(50), wake)); message(wake.token, ByteArray(131)); message(wake.token, seal("not a hint at all, just text".toByteArray(), wake))
        message(wake.token, seal(hint(1_000), wake.copy(auth = CanonicalJson.base64Url(ByteArray(16)))))
        delay(1_500)
        assertEquals(0L, repository.state.value.wake!!.lastHint); assertNull(repository.state.value.wake!!.endpoint)
        message(wake.token, seal(hint(2_000), wake))
        assertNotNull(withTimeoutOrNull(8_000) { repository.state.first { it.wake?.lastHint == 2_000L } })
        assertFalse("the same hint again", repository.acceptWakeHint(wake.token, seal(hint(2_000), wake))); assertFalse("an earlier one", repository.acceptWakeHint(wake.token, seal(hint(1_999), wake)))
        assertTrue(repository.acceptWakeHint(wake.token, seal(hint(2_001), wake)))
        push(Intent(WakeUps.REGISTRATION_FAILED).putExtra("token", wake.token).putExtra("reason", "VAPID_REQUIRED"))
        assertNotNull(withTimeoutOrNull(8_000) { repository.state.first { it.wake?.status == WakeStatus.Refused && it.wake?.problem == context.getString(R.string.wake_failed_key) } })
        // An address that is not HTTPS is refused in words.
        val again = repository.beginWake("org.push"); push(Intent(WakeUps.NEW_ENDPOINT).putExtra("token", again.token).putExtra("endpoint", "http://push.example/x"))
        assertNotNull(withTimeoutOrNull(8_000) { repository.state.first { it.wake?.problem?.contains("HTTPS") == true } })
    }

    /** With a paired isolated desktop only (build/completeness/wake-e2e.ts): the registration it later wakes this phone through. */
    @Test fun registersWithAPairedDesktop() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue("Needs the wake-up check's desktop", args.getString("palWakeCheck") != null)
        repository.connectWhileOpen()
        assertNotNull(withTimeoutOrNull(30_000) { repository.state.first { it.supports("wake.register") } })
        WakeUps.start(context, repository, WakeUps.apps(context).first { it.packageName == context.packageName + ".test" })
        val waiting = withTimeoutOrNull(20_000) { repository.state.first { it.wake?.status == WakeStatus.Waiting }.wake }
        assertEquals("https://push.example/known/key87", waiting?.endpoint); assertEquals("push.example", waiting?.host)
        val on = withTimeoutOrNull(30_000) { while (repository.state.value.wake?.status != WakeStatus.On) { delay(500); repository.deliverWake() }; repository.state.value.wake }
        assertNotNull("the desktop's owner allowed it", on)
        repository.flushNow(); keep = true
    }

    // ── Widget, tile and shortcuts ────────────────────────────────────────────────────────────────
    private fun texts(view: View): List<String> = when (view) { is TextView -> if (view.visibility == View.VISIBLE) listOf(view.text.toString()) else emptyList(); is android.view.ViewGroup -> (0 until view.childCount).flatMap { texts(view.getChildAt(it)) }; else -> emptyList() }
    @Test fun theWidgetShowsTheConnectionAndACountAndNothingElse() {
        val request = Approval(id = "a", sessionId = "s", kind = "command", title = "SECRET COMMAND", detail = "SECRET DETAIL", choices = listOf("allow", "deny"), revision = "1", digest = "d", canAnswer = true)
        val state = paired().copy(approvals = listOf(request, request.copy(id = "b")))
        compose.activity.runOnUiThread {
            fun shown(value: MobileState) = StatusWidget.views(context, glance(value)).apply(context, FrameLayout(context))
            val root = shown(state); assertEquals(listOf(context.resources.getQuantityString(R.plurals.glance_waiting, 2, 2), context.getString(R.string.connection_online)), texts(root))
            assertFalse(root.contentDescription.toString().contains("SECRET")); assertEquals(View.VISIBLE, root.findViewById<View>(R.id.widget_attention).visibility)
            // Offline, an earlier count is not shown as if it still held.
            assertEquals(listOf(context.getString(R.string.widget_open), context.getString(R.string.connection_offline)), texts(shown(state.copy(connection = ConnectionState.Offline("x", null)))))
            assertEquals(listOf(context.getString(R.string.widget_nothing_waiting), context.getString(R.string.connection_online)), texts(shown(paired())))
            assertEquals(context.getString(R.string.widget_not_paired), texts(shown(MobileState(restoreReady = true)))[1])
            val frame = FrameLayout(compose.activity).apply { setPadding(48, 200, 48, 48); setBackgroundColor(0xFF6A8CA0.toInt()) }
            compose.activity.setContentView(frame)
            for ((index, value) in listOf(state, paired(), MobileState(restoreReady = true)).withIndex()) frame.addView(StatusWidget.views(compose.activity, glance(value)).apply(compose.activity, frame), FrameLayout.LayoutParams(760, if (index == 1) 140 else 190).apply { topMargin = index * 260 })
        }
        compose.waitForIdle(); Thread.sleep(500)
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { shot -> File(context.getExternalFilesDir(null), "widget.png").outputStream().use { shot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
    }
    @Test fun launcherShortcutsExistOnlyWhilePaired() {
        val manager = context.getSystemService(android.content.pm.ShortcutManager::class.java)
        PhoneShortcuts.publish(context, true); assertEquals(setOf("inbox", "new"), manager.dynamicShortcuts.map { it.id }.toSet())
        assertTrue(manager.dynamicShortcuts.all { it.intent?.action in setOf(MainActivity.ACTION_OPEN_INBOX, MainActivity.ACTION_NEW_SESSION) })
        PhoneShortcuts.publish(context, false); assertTrue(manager.dynamicShortcuts.isEmpty())
    }
}
