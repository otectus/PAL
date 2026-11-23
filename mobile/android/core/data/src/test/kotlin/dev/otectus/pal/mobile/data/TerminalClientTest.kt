package dev.otectus.pal.mobile.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalClientTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test fun snapshotThenDeltaUpdatesOnlyChangedRows() {
        val screen = TerminalFrames.snapshot(json("""{"rows":3,"cols":20,"lines":[[[0,"$ ls",-1,-1,0]],[],[[2,"日本",33,-1,1]]],"cursor":[0,4,1],"alt":false,"revision":7}"""))
        assertEquals(3, screen.rows); assertEquals(7L, screen.revision); assertEquals("$ ls", TerminalScreen.plain(screen.lines[0]))
        assertTrue(screen.lines[2][0].bold); assertEquals("  日本", TerminalScreen.plain(screen.lines[2]))
        val next = TerminalFrames.apply(screen, json("""{"id":"t","base":7,"rev":8,"full":false,"rows":3,"cols":20,"cursor":[1,2,1],"alt":false,"changed":{"1":[[0,"ok",-1,-1,0]]}}""")) !!
        assertEquals(8L, next.revision); assertEquals("ok", TerminalScreen.plain(next.lines[1])); assertEquals("$ ls", TerminalScreen.plain(next.lines[0])); assertEquals(1, next.cursorRow)
    }

    @Test fun aMissedFrameMeansAttachAgainInsteadOfGuessing() {
        val screen = TerminalFrames.snapshot(json("""{"rows":2,"cols":10,"lines":[[],[]],"cursor":[0,0,1],"revision":3}"""))
        assertNull(TerminalFrames.apply(screen, json("""{"base":5,"rev":6,"full":false,"rows":2,"cols":10,"cursor":[0,0,1],"changed":{}}""")))
        assertNull(TerminalFrames.apply(null, json("""{"base":3,"rev":4,"full":false,"rows":2,"cols":10,"cursor":[0,0,1],"changed":{}}""")))
        // A resize arrives as a different row count: attach again for the whole screen.
        assertNull(TerminalFrames.apply(screen, json("""{"base":3,"rev":4,"full":false,"rows":5,"cols":10,"cursor":[0,0,1],"changed":{}}""")))
        // A full frame always replaces the screen.
        assertEquals(2, TerminalFrames.apply(screen, json("""{"base":1,"rev":9,"full":true,"rows":2,"cols":10,"cursor":[0,0,1],"lines":[[],[[0,"x",-1,-1,0]]]}"""))!!.lines.size)
    }

    @Test fun aLostAcknowledgementIsResolvedByStatusNeverByResendingBlindly() {
        assertEquals(InputRecovery.Accepted, InputRecovery.decide(json("""{"current":true,"lastSequence":4}"""), 4))
        assertEquals(InputRecovery.Resend, InputRecovery.decide(json("""{"current":true,"lastSequence":3}"""), 4))
        assertTrue(InputRecovery.decide(json("""{"current":false,"lastSequence":null}"""), 4) is InputRecovery.Abandon)
        assertTrue(InputRecovery.decide(json("""{"current":true}"""), 4) is InputRecovery.Abandon)
    }

    @Test fun leasesAndKeysHaveTheWireShapes() {
        val lease = TerminalLease.from(json("""{"leaseId":"l","epoch":2,"controllerRevision":"5","lastSequence":0}"""))!!
        assertEquals(2, lease.epoch); assertEquals("5", lease.controllerRevision)
        assertNull(TerminalLease.from(json("""{"epoch":2}""")))
        assertEquals(json("""{"key":"up","mods":4}"""), TerminalKeys.key("up", TerminalKeys.CTRL))
        assertEquals(json("""{"char":99,"mods":4}"""), TerminalKeys.char('c'.code, TerminalKeys.CTRL))
    }

    @Test fun negotiationKeepsTheDesktopsRoleAndOperations() {
        val negotiated = OwnerNegotiation.parse(json("""{"role":"owner","storedRole":"owner","operations":["terminal.create","workbench.roots"],"access":{"summary":"Host access"}}"""))!!
        assertEquals("owner", negotiated.role); assertTrue("terminal.create" in negotiated.operations)
        assertNull(OwnerNegotiation.parse(json("""{"role":"admin","operations":[]}""")))
        assertNull(OwnerNegotiation.parse(json("""{"role":"owner"}""")))
        assertTrue(OwnerNegotiation.FEATURE in OwnerNegotiation.CLIENT_FEATURES)
    }
}
