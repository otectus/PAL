package dev.otectus.pal.mobile.data

import dev.otectus.pal.mobile.protocol.CanonicalJson
import org.junit.Assert.*
import org.junit.Test

class WakePushTest {
    // RFC 8291, section 5: the receiver's keys and the message it opens.
    private val private = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
    private val public = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
    private val auth = "BTBZMqHH6r4Tts7J_aSIgg"
    private val example = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    /** A hint as the desktop's wake.ts sealed it for these keys. */
    private val desktop = "CQkJCQkJCQkJCQkJCQkJCQAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_jxslw6t-XetzHd6c9ed6oZDbSXiIYt0-Rt3Baj0Zk_IgVdvjq6lCNyQ4UwMw"
    private fun bytes(value: String) = CanonicalJson.decodeBase64Url(value)

    @Test fun opensTheStandardsExample() = assertEquals("When I grow up, I want to be a watermelon", WakePush.decrypt(bytes(example), private, public, auth)!!.decodeToString())

    @Test fun opensWhatTheDesktopSeals() {
        val plain = WakePush.decrypt(bytes(desktop), private, public, auth)
        assertEquals(WakePush.HINT_BYTES, plain!!.size)
        assertEquals(1_763_900_000_000, WakePush.hintTime(plain))
        // The standard's example opens too, but it is not a hint.
        assertNull(WakePush.hintTime(WakePush.decrypt(bytes(example), private, public, auth)))
    }

    @Test fun ignoresEverythingElse() {
        val message = bytes(desktop)
        val other = WakePush.newKeys()
        assertNull(WakePush.decrypt(message, other.privateKey, other.publicKey, other.auth))
        assertNull(WakePush.decrypt(message, private, public, other.auth))
        for (index in listOf(0, 21, message.size - 1)) assertNull(WakePush.decrypt(message.copyOf().also { it[index] = (it[index] + 1).toByte() }, private, public, auth))
        for (bad in listOf(ByteArray(0), ByteArray(200), message.copyOf(60), ByteArray(5000), message.copyOf().also { it[20] = 3 })) assertNull(WakePush.decrypt(bad, private, public, auth))
        assertNull(WakePush.hintTime(null)); assertNull(WakePush.hintTime(ByteArray(28)))
    }

    @Test fun newKeysHaveTheShapeTheDesktopExpects() {
        val keys = WakePush.newKeys()
        assertEquals(87, keys.publicKey.length); assertEquals(4, bytes(keys.publicKey)[0].toInt()); assertEquals(22, keys.auth.length); assertEquals(43, keys.privateKey.length)
        assertNotEquals(keys.privateKey, WakePush.newKeys().privateKey)
    }
}
