package dev.otectus.pal.mobile.protocol

import java.security.MessageDigest
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.util.Base64
import kotlinx.serialization.json.*

/** RFC 8785 serialization for broker request digests and signing transcripts. */
object CanonicalJson {
    fun encode(element: JsonElement): String = when (element) {
        is JsonObject -> element.entries.sortedBy { it.key }.joinToString(",", "{", "}") {
            "${WireCodec.json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(it.key))}:${encode(it.value)}"
        }
        is JsonArray -> element.joinToString(",", "[", "]") { encode(it) }
        JsonNull -> "null"
        is JsonPrimitive -> when {
            element.isString -> WireCodec.json.encodeToString(JsonPrimitive.serializer(), element)
            element.booleanOrNull != null -> element.content
            else -> number(element)
        }
    }

    private fun number(value: JsonPrimitive): String {
        value.longOrNull?.takeIf { it in -9007199254740991L..9007199254740991L }?.let { return it.toString() }
        val binary = value.double
        require(binary.isFinite()) { "Only finite JSON numbers can be signed" }
        if (binary == 0.0) return "0"
        val magnitude = kotlin.math.abs(binary)
        val exact = BigDecimal(magnitude)
        // Older Android Double.toString implementations do not always choose the shortest
        // decimal. Find the nearest shortest decimal that parses back to the same binary64.
        for (precision in 1..17) {
            val nearest = exact.round(MathContext(precision, RoundingMode.HALF_EVEN))
            val candidate = if (nearest.toDouble() == magnitude) nearest else {
                // At a power of two the upper and lower rounding intervals have different widths.
                val direction = if (nearest < exact) RoundingMode.UP else RoundingMode.DOWN
                exact.round(MathContext(precision, direction)).takeIf { it.toDouble() == magnitude } ?: continue
            }
            val decimal = candidate.stripTrailingZeros()
            val exponent = decimal.precision() - decimal.scale() - 1
            val sign = if (binary < 0) "-" else ""
            if (exponent in -6..20) return sign + decimal.toPlainString()
            val coefficient = decimal.scaleByPowerOfTen(-exponent).toPlainString()
            return sign + coefficient + "e" + (if (exponent >= 0) "+" else "") + exponent
        }
        error("Cannot serialize JSON number")
    }

    fun sha256(element: JsonElement): String = base64Url(MessageDigest.getInstance("SHA-256").digest(encode(element).toByteArray()))
    fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun decodeBase64Url(value: String): ByteArray = Base64.getUrlDecoder().decode(value)
}

object SigningTranscripts {
    fun authentication(helloDigest: String, challenge: AuthChallenge, desktopId: String, deviceId: String, keyVersion: Int): JsonObject = buildJsonObject {
        put("domain", "cere.mobile.auth.v1")
        put("helloDigest", helloDigest)
        put("challenge", buildJsonObject {
            put("challengeId", challenge.challengeId)
            put("serverNonce", challenge.serverNonce)
            put("epoch", challenge.epoch)
            put("audience", challenge.audience)
            put("expiresAt", challenge.expiresAt)
        })
        put("desktopId", desktopId)
        put("deviceId", deviceId)
        put("keyVersion", keyVersion)
        put("epoch", challenge.epoch)
    }

    fun action(desktopId: String, deviceId: String, keyVersion: Int, scopeVersion: String, epoch: String, authSessionId: String, challengeId: String, nonce: String, method: String, paramsDigest: String, commandId: String): JsonObject = buildJsonObject {
        put("domain", "cere.mobile.action.v1")
        put("desktopId", desktopId); put("deviceId", deviceId); put("keyVersion", keyVersion)
        put("scopeVersion", scopeVersion); put("epoch", epoch); put("authSessionId", authSessionId)
        put("challengeId", challengeId); put("nonce", nonce); put("method", method); put("paramsDigest", paramsDigest); put("commandId", commandId)
    }
}
