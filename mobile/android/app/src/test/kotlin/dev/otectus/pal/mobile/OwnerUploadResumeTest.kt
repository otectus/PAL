package dev.otectus.pal.mobile

import dev.otectus.pal.mobile.data.RemoteRequestException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

class OwnerUploadResumeTest {
    private val key = OwnerUploadKey("desktop", "phone", "1", "session", "artifact", "notes", "text/plain", 12, "digest")
    private fun receipt(id: String) = buildJsonObject {
        put("transferId", id)
        put("sha256", key.sha256)
        put("size", key.size)
        put("offset", 7)
    }

    @Test fun aLostStatusReplyRetainsTheVerifiedOffsetOnlyForTheSameGrant() = runBlocking {
        OwnerUploadResumes.keep(key, "transfer")
        try {
            val error = runCatching { OwnerUploadResumes.resume(key) { throw IOException("offline") } }.exceptionOrNull()
            assertEquals(IOException::class.java, error?.javaClass)
            assertNull(OwnerUploadResumes.resume(key.copy(scope = "2")) { error("Unexpected lookup") })
            assertNull(OwnerUploadResumes.resume(key.copy(deviceId = "different")) { error("Unexpected lookup") })
            assertEquals(receipt("transfer"), OwnerUploadResumes.resume(key) { receipt(it) })
        } finally {
            OwnerUploadResumes.remove(key, "transfer")
        }
    }

    @Test fun verifiedDownloadsAndFailedReadsBothReturnTheirSlots() = runBlocking {
        val bytes = "file".toByteArray()
        val leases = mutableSetOf<String>()
        suspend fun fetch(id: String, digest: String) = readDownload(
            buildJsonObject { put("transferId", id); put("size", bytes.size); put("sha256", digest); put("chunk", 2) },
            { _, _ -> }, { _, offset, count -> bytes.copyOfRange(offset.toInt(), offset.toInt() + count) }
        ) { released -> check(leases.remove(released)) }
        repeat(7) { index ->
            val id = "read-$index"
            leases.add(id)
            assertEquals("file", String(fetch(id, sha256Hex(bytes))))
        }
        leases.add("damaged")
        assertEquals(true, runCatching { fetch("damaged", "bad-digest") }.isFailure)
        assertEquals(emptySet<String>(), leases)
    }

    @Test fun expiredUploadsCanRestartAndLateCleanupCannotDiscardAnotherUpload() = runBlocking {
        OwnerUploadResumes.keep(key, "old")
        assertNull(OwnerUploadResumes.resume(key) { throw RemoteRequestException("ATTACHMENT_INVALID", "Expired") })
        assertNull(OwnerUploadResumes.resume(key) { error("An expired handle was retained") })
        OwnerUploadResumes.keep(key, "new")
        OwnerUploadResumes.remove(key, "old")
        try {
            assertEquals(receipt("new"), OwnerUploadResumes.resume(key) { receipt(it) })
        } finally {
            OwnerUploadResumes.remove(key, "new")
        }
    }
}
