package dev.otectus.pal.mobile

import dev.otectus.pal.mobile.protocol.Message
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationPresentationTest {
    @Test fun newMessageCountIgnoresHistoryPrependedBeforeSeenTail() {
        val initial = listOf(message("one"), message("seen"))
        assertEquals(0, newConversationMessageCount(initial, "seen"))
        assertEquals(0, newConversationMessageCount(listOf(message("older")) + initial, "seen"))
        assertEquals(2, newConversationMessageCount(initial + listOf(message("new-1"), message("new-2")), "seen"))
        assertEquals(0, newConversationMessageCount(initial, "not-loaded"))
    }

    @Test fun markdownTableColumnsStayReadableAndBounded() {
        assertEquals(120, markdownTableColumnWidth(0))
        assertEquals(120, markdownTableColumnWidth(4))
        assertEquals(192, markdownTableColumnWidth(20))
        assertEquals(280, markdownTableColumnWidth(10_000))
    }

    @Test fun linksAllowOnlyCredentialFreeWebAddresses() {
        assertEquals("HTTPS://example.com/path?q=1", safeLink("HTTPS://example.com/path?q=1"))
        assertEquals("http://example.com", safeLink("http://example.com"))
        listOf("javascript:alert(1)", "file:///tmp/private", "https://user:secret@example.com", "https://example.com/\nattack")
            .forEach { assertNull(it, safeLink(it)) }
    }

    private fun message(id: String) = Message(id, "session", role = "assistant", text = id, revision = "1")
}
