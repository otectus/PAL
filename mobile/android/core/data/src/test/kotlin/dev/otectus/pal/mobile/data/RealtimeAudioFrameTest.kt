package dev.otectus.pal.mobile.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RealtimeAudioFrameTest {
    private val secret = ByteArray(32) { it.toByte() }
    private val session = "019b0f7a-c3d2-7a10-8b22-0123456789ab"

    @Test fun authenticatedRoundTrip() {
        val source = RealtimeAudioFrame.Value(session, false, "pcm16", 7, 1_800_000_000_000, endOfTurn = true, audio = byteArrayOf(1, 2, 3, 4))
        val encoded = RealtimeAudioFrame.encode(secret, source)
        val decoded = RealtimeAudioFrame.decode(secret, encoded, source.timestampMs)
        assertEquals(source.sessionId, decoded.sessionId)
        assertEquals(source.output, decoded.output)
        assertEquals(source.codec, decoded.codec)
        assertEquals(source.sequence, decoded.sequence)
        assertEquals(source.timestampMs, decoded.timestampMs)
        assertEquals(source.endOfTurn, decoded.endOfTurn)
        assertArrayEquals(source.audio, decoded.audio)
    }

    @Test fun authenticationRejectsChanges() {
        val encoded = RealtimeAudioFrame.encode(secret, RealtimeAudioFrame.Value(session, false, "pcm16", 0, 1_800_000_000_000, audio = byteArrayOf(8, 9)))
        encoded[40] = (encoded[40].toInt() xor 1).toByte()
        assertThrows(IllegalArgumentException::class.java) { RealtimeAudioFrame.decode(secret, encoded, 1_800_000_000_000) }
    }
}
