package dev.otectus.pal.mobile.data

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Authenticated binary framing negotiated by `realtime.audio.v1`. */
object RealtimeAudioFrame {
    const val FEATURE = "realtime.audio.v1"
    const val MAX_PAYLOAD = 65_536
    private const val HEADER_BYTES = 40
    private const val TAG_BYTES = 16
    private val magic = byteArrayOf('P'.code.toByte(), 'L'.code.toByte(), 'R'.code.toByte(), 'T'.code.toByte())
    private val info = "pal-realtime-audio-v1".toByteArray(Charsets.UTF_8)
    private val nonceLabel = "pal-realtime-nonce-v1".toByteArray(Charsets.UTF_8)

    data class Value(
        val sessionId: String,
        val output: Boolean,
        val codec: String,
        val sequence: Long,
        val timestampMs: Long,
        val endOfTurn: Boolean = false,
        val discontinuity: Boolean = false,
        val audio: ByteArray,
    )

    fun isFrame(bytes: ByteArray) = bytes.size >= 4 && bytes.copyOfRange(0, 4).contentEquals(magic)

    fun encode(rootSecret: ByteArray, value: Value): ByteArray {
        require(!value.output) { "The phone may only send realtime input" }
        require(value.sequence in 0..0xffff_fffeL) { "Invalid realtime frame sequence" }
        require(value.audio.size <= MAX_PAYLOAD) { "Realtime audio frame is too large" }
        val session = UUID.fromString(value.sessionId)
        val header = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.BIG_ENDIAN)
            .put(magic).put(1).put(1).put(codecId(value.codec))
            .put(((if (value.endOfTurn) 1 else 0) or (if (value.discontinuity) 2 else 0)).toByte())
            .putLong(session.mostSignificantBits).putLong(session.leastSignificantBits)
            .putInt(value.sequence.toInt()).putLong(value.timestampMs).putInt(value.audio.size).array()
        val encrypted = cipher(Cipher.ENCRYPT_MODE, derive(rootSecret, session), header).doFinal(value.audio)
        return header + encrypted
    }

    fun decode(rootSecret: ByteArray, bytes: ByteArray, now: Long = System.currentTimeMillis()): Value {
        require(bytes.size in (HEADER_BYTES + TAG_BYTES)..(HEADER_BYTES + TAG_BYTES + MAX_PAYLOAD)) { "Invalid realtime audio frame length" }
        require(isFrame(bytes) && bytes[4].toInt() == 1) { "Unsupported realtime audio frame" }
        val kind = bytes[5].toInt() and 0xff
        val codec = codecName(bytes[6].toInt() and 0xff)
        val flags = bytes[7].toInt() and 0xff
        require(kind in 1..2 && flags and 3.inv() == 0) { "Invalid realtime audio frame header" }
        val header = bytes.copyOfRange(0, HEADER_BYTES)
        val values = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN).also { it.position(8) }
        val session = UUID(values.long, values.long)
        val sequence = values.int.toLong() and 0xffff_ffffL
        val timestamp = values.long
        val length = values.int
        require(length in 0..MAX_PAYLOAD && bytes.size == HEADER_BYTES + TAG_BYTES + length) { "Invalid realtime audio frame length" }
        require(kotlin.math.abs(now - timestamp) <= 5 * 60_000L) { "Stale realtime audio frame" }
        val audio = try { cipher(Cipher.DECRYPT_MODE, derive(rootSecret, session), header).doFinal(bytes, HEADER_BYTES, bytes.size - HEADER_BYTES) }
        catch (_: Exception) { throw IllegalArgumentException("Realtime audio frame authentication failed") }
        return Value(session.toString(), kind == 2, codec, sequence, timestamp, flags and 1 != 0, flags and 2 != 0, audio)
    }

    private fun derive(secret: ByteArray, session: UUID): ByteArray {
        require(secret.size in 32..1024) { "Realtime framing requires a connection secret" }
        val salt = ByteBuffer.allocate(16).order(ByteOrder.BIG_ENDIAN).putLong(session.mostSignificantBits).putLong(session.leastSignificantBits).array()
        val prk = hmac(salt, secret)
        return hmac(prk, info + byteArrayOf(1)).copyOf(32)
    }
    private fun cipher(mode: Int, key: ByteArray, header: ByteArray): Cipher {
        val nonce = hmac(key, nonceLabel + header.copyOfRange(5, 36)).copyOf(12)
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); updateAAD(header)
        }
    }
    private fun hmac(key: ByteArray, value: ByteArray) = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256")); doFinal(value)
    }
    private fun codecId(codec: String) = when (codec) { "pcm16" -> 1; "g711_ulaw" -> 2; "g711_alaw" -> 3; "opus" -> 4; else -> error("Unsupported realtime codec") }.toByte()
    private fun codecName(id: Int) = when (id) { 1 -> "pcm16"; 2 -> "g711_ulaw"; 3 -> "g711_alaw"; 4 -> "opus"; else -> error("Unsupported realtime codec") }
}
