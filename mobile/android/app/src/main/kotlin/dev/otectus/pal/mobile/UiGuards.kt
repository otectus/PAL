package dev.otectus.pal.mobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Parcel
import android.util.Base64
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.UriHandler
import androidx.core.content.FileProvider
import java.io.File
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

/*
 * What a screen meets that it cannot rule out: an answer shaped differently than expected, a row whose key repeats, a
 * link or a share no app takes, text too long for Android to hand over. Each is said or left out; none ends the app.
 */

internal fun JsonObject.array(key: String): List<JsonElement> = (this[key] as? JsonArray).orEmpty()
/** The texts of a list. Anything in it that is not text is left out. */
internal fun JsonObject.strings(key: String): List<String> = array(key).texts()
internal fun Iterable<JsonElement>.texts(): List<String> = mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
internal fun JsonObject.real(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

/**
 * Each key once, in order; a repeated one gets its turn added. A lazy list ends the app when two rows share a key, and
 * the keys of most lists here come from the desktop.
 */
internal fun uniqueKeys(keys: List<String>): List<String> {
    val turns = HashMap<String, Int>()
    return keys.map { key -> val turn = turns.getOrDefault(key, 0); turns[key] = turn + 1; if (turn == 0) key else "$key\u0000$turn" }
}
internal fun <T> LazyListScope.keyedItems(rows: List<T>, key: (T) -> String, contentType: (T) -> Any? = { null }, row: @Composable LazyItemScope.(T) -> Unit) {
    val keys = uniqueKeys(rows.map(key))
    itemsIndexed(rows, key = { index, _ -> keys[index] }, contentType = { _, item -> contentType(item) }) { _, item -> row(item) }
}

/** False when Android will not take this much text at once, so the screen can say so. */
internal fun copyText(context: Context, label: String, text: String): Boolean =
    runCatching { context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(label, text)) }.isSuccess

/** False when no app on this phone takes it. */
internal fun Context.open(intent: Intent): Boolean = runCatching { startActivity(intent) }.isSuccess
internal fun UriHandler.open(address: String?): Boolean = !address.isNullOrBlank() && runCatching { openUri(address) }.isSuccess

/**
 * A file for another app, kept in this app's private cache only as long as that takes: what was handed over more than an
 * hour ago goes first, and the rest when the app next starts or the desktop is forgotten.
 */
internal fun sharedFile(context: Context, name: String, fallback: String, bytes: ByteArray): Uri {
    val folder = File(context.cacheDir, "shared").also { it.mkdirs() }
    sweepShared(context)
    val file = File(folder, name.replace(Regex("[^A-Za-z0-9._ -]"), "_").trim('.', ' ').take(120).ifBlank { fallback })
    file.writeBytes(bytes)
    return FileProvider.getUriForFile(context, "${context.packageName}.camera", file)
}
internal fun sweepShared(context: Context, before: Long = System.currentTimeMillis() - 3_600_000) {
    runCatching { File(context.cacheDir, "shared").listFiles()?.forEach { if (it.lastModified() < before) it.delete() } }
}
/** A conversation as its text, or as a file once the text is more than Android hands over at once. */
internal fun conversationShare(context: Context, text: String, name: String): Intent {
    val intent = Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_SUBJECT, name)
    if (text.length <= 100_000) return intent.putExtra(Intent.EXTRA_TEXT, text)
    val uri = sharedFile(context, if (name.endsWith(".md", ignoreCase = true)) name else "$name.md", "conversation.md", text.toByteArray())
    intent.clipData = ClipData.newRawUri(name, uri)
    return intent.putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

/** A picture the desktop sent inside its answer; null when it is not one. */
internal fun decodePicture(data: String?): Bitmap? = runCatching {
    val bytes = Base64.decode(data.orEmpty().substringAfter("base64,"), Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}.getOrNull()

/**
 * Saved screen state travels to Android in one transaction of about a megabyte shared with everything else this app is
 * sending, and Android ends an app that goes over. Long notes or files in the fields that keep them can add up to it.
 */
internal object SavedState {
    const val LIMIT = 400 * 1024
    fun size(state: Bundle): Int { val parcel = Parcel.obtain(); return try { parcel.writeBundle(state); parcel.dataSize() } finally { parcel.recycle() } }
    fun fits(state: Bundle, limit: Int = LIMIT): Boolean = runCatching { size(state) <= limit }.getOrDefault(false)
}
