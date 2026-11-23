package dev.otectus.pal.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalInputTest {
    @Test fun compositionIsDeferredThenCommittedExactlyOnce() {
        assertEquals(TerminalInputEdit("", 0, ""), terminalInputEdit("", "echo", compositionStart = 0))
        assertEquals(TerminalInputEdit("echo", 0, "echo"), terminalInputEdit("", "echo", compositionStart = null))
        assertEquals(TerminalInputEdit("echo", 0, ""), terminalInputEdit("echo", "echo", compositionStart = null))
    }

    @Test fun committedPrefixPrecedesActiveComposition() {
        assertEquals(TerminalInputEdit("echo ", 0, "echo "), terminalInputEdit("", "echo again", compositionStart = 5))
        assertEquals(TerminalInputEdit("echo again", 0, "again"), terminalInputEdit("echo ", "echo again", compositionStart = null))
    }

    @Test fun sendCanFlushPreeditBeforeEnterAndEditsReconcileFromBaseline() {
        assertEquals(TerminalInputEdit("echo UX20", 0, "echo UX20"), terminalInputEdit("", "echo UX20", compositionStart = null))
        assertEquals(TerminalInputEdit("echo UX21", 1, "1"), terminalInputEdit("echo UX20", "echo UX21", compositionStart = null))
    }

    @Test fun supplementaryCharacterReplacementUsesOneTerminalBackspace() {
        assertEquals(TerminalInputEdit("echo 😃", 1, "😃"), terminalInputEdit("echo 😀", "echo 😃", compositionStart = null))
        assertEquals(TerminalInputEdit("", 0, ""), terminalInputEdit("", "😀", compositionStart = 1))
    }
}
