package dev.otectus.pal.mobile.protocol

import java.io.File

/** Files shared with the broker's tests, found through the repository root Gradle passes in. */
internal object SharedFixtures {
    private val root = File(checkNotNull(System.getProperty("pal.repositoryRoot")) { "pal.repositoryRoot is not set; run through Gradle" })
    fun text(path: String): String = root.resolve(path).readText()
}
