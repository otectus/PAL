package dev.otectus.pal.mobile

import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.RemoteRequestException
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/*
 * Helpers for the owner screens (Workbench, Terminal, owner settings). Every desktop change goes through a signed
 * action exactly like the rest of the app: a trusted phone signs silently, a biometric phone confirms once per
 * action. Reads and reductions travel on the authenticated connection.
 */

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.num(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
internal fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
internal fun JsonObject.isTrue(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true
internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
internal fun JsonObject.list(key: String): List<JsonObject> = (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
internal fun JsonElement?.objects(): List<JsonObject> = (this as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()

/** A signed desktop action as a suspend call: prepared, authenticated and sent exactly once. */
internal suspend fun signed(activity: FragmentActivity, repository: PALRepository, method: String, params: JsonObject, title: String): JsonElement =
    suspendCancellableCoroutine { continuation ->
        signedReview(activity, repository, method, params, title,
            { result -> if (continuation.isActive) continuation.resume(result) },
            { message -> if (continuation.isActive) continuation.resumeWithException(IllegalStateException(message)) })
    }

internal fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/** The largest file this phone downloads into memory before saving it. */
internal const val MAX_DOWNLOAD_BYTES = 100L * 1024 * 1024

/**
 * A selected file remains in memory on the Work screen. Keep only its opaque desktop
 * handle so choosing the same bytes again after a transient disconnect can continue
 * from the desktop's committed offset. Bytes themselves are never persisted here.
 */
internal data class OwnerUploadKey(
    val desktopId: String, val deviceId: String, val scope: String?, val sessionId: String,
    val purpose: String, val name: String, val mime: String, val size: Int, val sha256: String
)
internal object OwnerUploadResumes {
    private data class Handle(val id: String, val recordedAt: Long)
    private val handles = LinkedHashMap<OwnerUploadKey, Handle>()
    private const val MAX_HANDLES = 16
    private const val MAX_AGE_MS = 30 * 60_000L

    @Synchronized fun keep(key: OwnerUploadKey, id: String) {
        handles.remove(key)
        handles[key] = Handle(id, System.currentTimeMillis())
        if (handles.size > MAX_HANDLES) handles.remove(handles.keys.first())
    }
    @Synchronized fun remove(key: OwnerUploadKey, id: String) {
        if (handles[key]?.id == id) handles.remove(key)
    }
    @Synchronized private fun retained(key: OwnerUploadKey): String? {
        val handle = handles[key] ?: return null
        if (System.currentTimeMillis() - handle.recordedAt < MAX_AGE_MS) return handle.id
        handles.remove(key)
        return null
    }

    suspend fun resume(key: OwnerUploadKey, status: suspend (String) -> JsonObject): JsonObject? {
        val id = retained(key) ?: return null
        val receipt = try {
            status(id)
        } catch (error: RemoteRequestException) {
            if (error.code != "ATTACHMENT_INVALID") throw error
            remove(key, id)
            return null
        }
        val offset = receipt.num("offset")
        if (receipt.str("transferId") != id || receipt.str("sha256") != key.sha256 ||
            receipt.num("size") != key.size.toLong() || offset == null || offset !in 0L..key.size.toLong()) {
            remove(key, id)
            error("The desktop returned a different upload. Select the file again to start over.")
        }
        return receipt
    }
}

/**
 * Downloads one artifact version from the desktop, chunk by chunk, and keeps it only when its SHA-256 matches the
 * digest the desktop stated for that immutable version. [variant] "preview" is a reduced image; "original" the file.
 */
internal suspend fun downloadArtifact(repository: PALRepository, sessionId: String, artifactId: String, versionId: String?, variant: String, progress: (Long, Long) -> Unit = { _, _ -> }): Pair<JsonObject, ByteArray> {
    val info = repository.read("transfers.download", buildJsonObject { put("sessionId", sessionId); put("artifactId", artifactId); versionId?.let { put("versionId", it) }; put("variant", variant) }) as JsonObject
    return info to readDownload(info, progress, repository::readTransferChunk) { id ->
        repository.mutate("transfers.abort", buildJsonObject { put("transferId", id) })
    }
}

internal suspend fun readDownload(
    info: JsonObject,
    progress: (Long, Long) -> Unit,
    read: suspend (String, Long, Int) -> ByteArray,
    release: suspend (String) -> Unit
): ByteArray {
    val id = info.str("transferId") ?: error("The desktop did not start the download")
    try {
        val size = info.num("size") ?: 0; val chunk = (info.int("chunk") ?: 256 * 1024).coerceIn(1, 256 * 1024)
        require(size in 0..MAX_DOWNLOAD_BYTES) { "This file is larger than this phone downloads at once (100 MB)." }
        val out = ByteArrayOutputStream(size.toInt())
        var offset = 0L
        while (offset < size) {
            val length = minOf(chunk.toLong(), size - offset).toInt()
            val part = read(id, offset, length)
            require(part.size in 1..length) { "The desktop returned an unexpected download length" }
            out.write(part); offset += part.size; progress(offset, size)
        }
        val bytes = out.toByteArray()
        require(sha256Hex(bytes) == info.str("sha256")) { "The downloaded file does not match the desktop's copy. Nothing was saved." }
        return bytes
    } finally {
        // A completed read, an oversize rejection, integrity failure, or cancellation all
        // release the server-side slot. Do this outside cancellation, but never block exit.
        withContext(NonCancellable) { withTimeoutOrNull(3_000) { runCatching { release(id) } } }
    }
}

/**
 * Sends a file from this phone to the desktop's artifact store: a signed upload that names its size and SHA-256,
 * acknowledged chunks at the committed offset, then commit, which installs exactly those bytes once. For a layer
 * or mask (image editing), the verified upload is returned uncommitted for the editor to use.
 */
internal suspend fun uploadToDesktop(activity: FragmentActivity, repository: PALRepository, sessionId: String, name: String, mime: String, bytes: ByteArray,
    purpose: String = "artifact", destinations: Pair<Boolean, Boolean>? = null, progress: (Long, Long) -> Unit = { _, _ -> }): JsonObject {
    val state = repository.state.value
    val digest = sha256Hex(bytes)
    val online = state.connection as? dev.otectus.pal.mobile.data.ConnectionState.Online ?: error("The desktop is unavailable")
    val desktop = state.desktop ?: error("The desktop is unavailable")
    val key = OwnerUploadKey(desktop.desktopId, desktop.deviceId, online.scopeVersion, sessionId, purpose, name.take(200), mime, bytes.size, digest)
    val resumed = OwnerUploadResumes.resume(key) { transferId ->
        repository.request("transfers.status", buildJsonObject { put("transferId", transferId) }) as JsonObject
    }
    val begun = resumed ?: signed(activity, repository, "transfers.upload", buildJsonObject {
        put("sessionId", sessionId); put("name", name.take(200)); put("mime", mime); put("size", bytes.size); put("sha256", digest); put("purpose", purpose)
    }, "Send $name to the desktop") as JsonObject
    val id = begun.str("transferId") ?: error("The desktop did not start the upload")
    val chunk = (begun.int("chunk") ?: 256 * 1024).coerceIn(1, 256 * 1024)
    var offset = begun.num("offset") ?: 0
    var commitStarted = false
    try {
        while (offset < bytes.size) {
            val count = minOf(chunk.toLong(), bytes.size - offset).toInt()
            val next = repository.sendTransferChunk(id, offset, bytes, offset.toInt(), count)
            require(next == offset + count) { "The desktop reported an unexpected upload position" }
            offset = next
            progress(offset, bytes.size.toLong())
        }
        val result = when {
            purpose != "artifact" || begun.str("status") == "committed" -> begun
            else -> {
                commitStarted = true
                repository.mutate("transfers.commit", buildJsonObject {
                    put("transferId", id)
                    destinations?.let { (remote, cloud) ->
                        put("destinations", buildJsonObject { put("remote", remote); put("cloud", cloud) })
                    }
                }, "Save $name") as JsonObject
            }
        }
        OwnerUploadResumes.remove(key, id)
        return result
    } catch (error: Exception) {
        if (error is CancellationException && !commitStarted) {
            OwnerUploadResumes.remove(key, id)
            withContext(NonCancellable) {
                withTimeoutOrNull(3_000) {
                    runCatching { repository.mutate("transfers.abort", buildJsonObject { put("transferId", id) }) }
                }
            }
        } else {
            OwnerUploadResumes.keep(key, id)
        }
        throw error
    }
}

/** Use Android's localized file-size units in the file lists. */
@androidx.compose.runtime.Composable
internal fun byteSize(bytes: Long?): String {
    val context = androidx.compose.ui.platform.LocalContext.current
    return bytes?.let { android.text.format.Formatter.formatShortFileSize(context, it) }.orEmpty()
}
