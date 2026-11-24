package dev.otectus.pal.mobile

import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkToolsTest {
    /** The same cases as tests/command-line.test.ts, so a command means the same from either screen. */
    @Test fun commandLinesSplitExactlyAsOnTheDesktop() {
        assertEquals(listOf("npm", "test"), CommandLine.split("npm test").argv)
        assertEquals(listOf("printf", "%s\\n", "a b", "c d", ""), CommandLine.split("  printf   \"%s\\n\" 'a b' c\\ d  \"\"").argv)
        assertEquals(listOf("grep", "say \"hi\"", "file.txt"), CommandLine.split("grep \"say \\\"hi\\\"\" file.txt").argv)
        assertEquals(listOf("sh", "-c", "ls | wc -l"), CommandLine.split("sh -c 'ls | wc -l'").argv)
        assertNull(CommandLine.split("sh -c 'ls | wc -l'").operator)
        assertEquals(listOf("--flag=x yz"), CommandLine.split("--flag='x y'z").argv)
        assertTrue(CommandLine.split("   ").argv.isEmpty())
        assertTrue(CommandLine.split("echo \"unfinished").openQuote)
        for (line in listOf("ls | wc", "a && b", "make > out.txt", "sleep 1 ; echo x", "run 2>&1")) assertTrue(line, CommandLine.split(line).operator != null)
        for (line in listOf("awk a|b", "echo \"a && b\"", "echo 'x > y'", "echo a\\ \\| b")) assertNull(line, CommandLine.split(line).operator)
    }

    private fun state(vararg operations: String) = MobileState(connection = ConnectionState.Online("Desktop", operations.toSet(), 0))
    private val every = arrayOf("workbench.artifacts.extract", "owner.tables.preview", "owner.translate", "workbench.images.inspect", "workbench.images.ocr", "workbench.images.analyze", "workbench.images.generate",
        "workbench.images.transform", "workbench.images.mask", "workbench.artifacts.export", "owner.collections.addArtifact", "owner.skills.importArtifact", "workbench.artifacts.remove")

    @Test fun onlyActionsThatApplyAndThatTheDesktopOffersAreShown() {
        val all = state(*every)
        assertEquals(listOf(ArtifactTool.Read, ArtifactTool.Table, ArtifactTool.Translate, ArtifactTool.Folder, ArtifactTool.Collection, ArtifactTool.Remove), artifactTools(all, "orders.csv", "text/csv", "table"))
        assertEquals(listOf(ArtifactTool.Details, ArtifactTool.Ocr, ArtifactTool.Ask, ArtifactTool.Edit, ArtifactTool.Transform, ArtifactTool.Mask, ArtifactTool.Folder, ArtifactTool.Remove), artifactTools(all, "chart.png", "image/png", "image"))
        assertEquals(listOf(ArtifactTool.Read, ArtifactTool.Folder, ArtifactTool.Remove), artifactTools(all, "report.pdf", "application/pdf", "document"))
        assertEquals(listOf(ArtifactTool.Folder, ArtifactTool.Remove), artifactTools(all, "clip.mp4", "video/mp4", "other"))
        assertTrue(ArtifactTool.Skill in artifactTools(all, "skill.zip", "application/zip", "bundle"))
        // A desktop without an operation never shows its button.
        assertTrue(artifactTools(state("workbench.artifacts.export"), "chart.png", "image/png", "image") == listOf(ArtifactTool.Folder))
        assertTrue(artifactTools(MobileState(), "chart.png", "image/png", "image").isEmpty())
        assertFalse(ArtifactTool.Read in artifactTools(all, "blob", "application/octet-stream", "other"))
    }
}
