package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.CanonicalJson
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable

/** Where a phone's optional wake-ups stand. */
@Serializable
enum class WakeStatus { Registering, Waiting, On, Failing, Refused }

/**
 * Optional wake-ups (UnifiedPush). Off until the person chooses a push app on this phone and the desktop's owner
 * allows its server. The keys only open hints that say "connect"; they are no part of the pairing.
 */
@Serializable
data class WakeState(
    /** What the push app knows this registration by; anything with another token is ignored. */
    val token: String,
    val distributor: String,
    val privateKey: String,
    val publicKey: String,
    val auth: String,
    val endpoint: String? = null,
    /** The desktop has this endpoint. */
    val delivered: Boolean = false,
    val status: WakeStatus = WakeStatus.Registering,
    val host: String? = null,
    val problem: String? = null,
    /** The last hint accepted: an earlier one, or the same one again, is ignored. */
    val lastHint: Long = 0,
    /** Requests already announced by a wake-up, so a later one does not announce them again. */
    val announced: List<String> = emptyList(),
)

/** A Web Push message as the desktop sends it (RFC 8291, aes128gcm), and the hint inside. */
object WakePush {
    const val HINT_BYTES = 28
    private val MAGIC = "PALW".toByteArray()
    private val curve: ECParameterSpec by lazy { AlgorithmParameters.getInstance("EC").run { init(ECGenParameterSpec("secp256r1")); getParameterSpec(ECParameterSpec::class.java) } }

    class Keys(val privateKey: String, val publicKey: String, val auth: String)

    fun newKeys(): Keys {
        val pair = KeyPairGenerator.getInstance("EC").run { initialize(ECGenParameterSpec("secp256r1")); generateKeyPair() }
        val auth = ByteArray(16).also(SecureRandom()::nextBytes)
        return Keys(CanonicalJson.base64Url(fixed((pair.private as ECPrivateKey).s)), CanonicalJson.base64Url(point(pair.public as ECPublicKey)), CanonicalJson.base64Url(auth))
    }

    /** The text inside, or null for anything this phone's keys did not seal. */
    fun decrypt(message: ByteArray, privateKey: String, publicKey: String, auth: String): ByteArray? = runCatching {
        require(message.size in 104..4096)
        val salt = message.copyOfRange(0, 16)
        val idLength = message[20].toInt() and 0xff
        require(idLength == 65)
        val sender = message.copyOfRange(21, 21 + idLength)
        val body = message.copyOfRange(21 + idLength, message.size)
        val own = CanonicalJson.decodeBase64Url(publicKey)
        val shared = KeyAgreement.getInstance("ECDH").run {
            init(KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, CanonicalJson.decodeBase64Url(privateKey)), curve)))
            doPhase(KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(decodePoint(sender), curve)), true)
            generateSecret()
        }
        val input = hmac(hmac(CanonicalJson.decodeBase64Url(auth), shared), label("WebPush: info"), own, sender, ONE)
        val secret = hmac(salt, input)
        val key = hmac(secret, label("Content-Encoding: aes128gcm"), ONE).copyOf(16)
        val nonce = hmac(secret, label("Content-Encoding: nonce"), ONE).copyOf(12)
        val padded = Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); doFinal(body) }
        val end = padded.indexOfLast { it.toInt() != 0 }
        require(end >= 0 && padded[end].toInt() == 2)
        padded.copyOf(end)
    }.getOrNull()

    /** The time of a hint, or null when the message is something else. */
    fun hintTime(plain: ByteArray?): Long? {
        if (plain == null || plain.size != HINT_BYTES || !plain.copyOf(4).contentEquals(MAGIC)) return null
        return ByteBuffer.wrap(plain, 4, 8).long.takeIf { it > 0 }
    }

    private val ONE = byteArrayOf(1)
    private fun label(text: String) = text.toByteArray() + byteArrayOf(0)
    private fun hmac(key: ByteArray, vararg parts: ByteArray) = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); parts.forEach(::update); doFinal() }
    private fun fixed(value: BigInteger): ByteArray = value.toByteArray().let { bytes -> if (bytes.size > 32) bytes.copyOfRange(bytes.size - 32, bytes.size) else ByteArray(32 - bytes.size) + bytes }
    private fun point(key: ECPublicKey) = byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)
    private fun decodePoint(bytes: ByteArray): ECPoint {
        require(bytes.size == 65 && bytes[0].toInt() == 4)
        return ECPoint(BigInteger(1, bytes.copyOfRange(1, 33)), BigInteger(1, bytes.copyOfRange(33, 65)))
    }
}
