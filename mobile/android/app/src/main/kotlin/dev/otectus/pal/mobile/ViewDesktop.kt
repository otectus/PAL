package dev.otectus.pal.mobile

import androidx.compose.ui.res.stringResource
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.MobileState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * View desktop (owner phones): still frames of the computer's screen, taken while this panel is open, and pointer
 * and text input where the computer allows it. The desktop shows a notice when viewing starts and ends.
 */
@Composable
internal fun ViewDesktopPanel(repository: PALRepository, state: MobileState, activity: FragmentActivity) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    if (!state.owner || !state.supports("view.start")) return
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf<JsonObject?>(null) }
    var revision by remember { mutableStateOf<Int?>(null) }
    var bitmap by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
    var typing by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var frameError by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    var changing by remember { mutableStateOf(false) }
    val viewId = view?.str("viewId")
    val controls = view?.obj("input")
    val pointer = controls?.isTrue("pointer") == true
    val keyboard = controls?.isTrue("text") == true
    LaunchedEffect(viewId) {
        val id = viewId ?: return@LaunchedEffect
        try {
            while (true) {
                try {
                    val value = repository.request("view.frame", buildJsonObject { put("viewId", id); put("maxWidth", 1280) }) as JsonObject
                    val image = withContext(Dispatchers.Default) {
                        val bytes = Base64.decode(value.str("data").orEmpty().substringAfter("base64,"), Base64.DEFAULT)
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: error(strings.getString(R.string.viewer_could_not_read_the_desktop_frame))
                    }
                    bitmap = image
                    revision = value.int("revision")
                    frameError = null
                } catch (cancelled: CancellationException) { throw cancelled }
                  catch (cause: Exception) { frameError = cause.message ?: strings.getString(R.string.viewer_could_not_refresh_the_screen) }
                delay(1500)
            }
        } finally {
            if (view?.str("viewId") == id && repository.state.value.supports("view.stop")) withContext(NonCancellable) {
                withTimeoutOrNull(2500) { runCatching { repository.mutate("view.stop", buildJsonObject { put("viewId", id) }) } }
            }
        }
    }
    fun input(kind: String, payload: JsonObjectBuilder.() -> Unit = {}, accepted: () -> Unit = {}) {
        val id = viewId ?: return
        val frameRevision = revision ?: return
        if (sending) return
        sending = true
        scope.launch {
            try {
                val reply = repository.request("view.input", buildJsonObject { put("viewId", id); put("frameRevision", frameRevision); put("kind", kind); payload() }) as JsonObject
                if (reply.isTrue("sent")) { error = null; accepted() } else error = strings.getString(R.string.viewer_the_desktop_did_not_confirm_the_input)
            } catch (cancelled: CancellationException) { throw cancelled }
              catch (cause: Exception) { error = cause.message ?: strings.getString(R.string.viewer_could_not_send_input) }
            finally { sending = false }
        }
    }
    Surface(border = BorderStroke(PALLayout.hairline, MaterialTheme.colorScheme.outlineVariant), shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(PALLayout.gutter), verticalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            Text(stringResource(R.string.viewer_view_desktop), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            if (viewId == null) {
                Text(stringResource(R.string.viewer_show_still_frames_of_this_computers_screen_people), style = MaterialTheme.typography.bodySmall)
                Button({ changing = true; scope.launch {
                    try {
                        view = signed(activity, repository, "view.start", buildJsonObject {}, strings.getString(R.string.viewer_view_the_desktops_screen)) as JsonObject
                        error = null
                    } catch (cancelled: CancellationException) { throw cancelled }
                      catch (cause: Exception) { error = cause.message }
                    finally { changing = false }
                } }, enabled = !changing) { Text(stringResource(R.string.viewer_view_screen)) }
            } else {
                Text(when {
                    pointer && keyboard -> stringResource(R.string.viewer_viewing_tap_or_type_on_the_desktop)
                    pointer -> stringResource(R.string.viewer_viewing_tap_to_point_on_the_desktop)
                    keyboard -> stringResource(R.string.viewer_viewing_keyboard_input_available)
                    else -> stringResource(R.string.viewer_viewing_only)
                }, style = MaterialTheme.typography.titleSmall)
                controls?.str("reason")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                OutlinedButton({ changing = true; scope.launch {
                    try {
                        repository.mutate("view.stop", buildJsonObject { put("viewId", viewId) })
                        view = null; bitmap = null; revision = null; typing = ""; frameError = null; error = null
                    } catch (cancelled: CancellationException) { throw cancelled }
                      catch (cause: Exception) { error = cause.message }
                    finally { changing = false }
                } }, enabled = !changing) { Text(stringResource(R.string.viewer_stop_viewing)) }
                val image = bitmap
                if (image == null && frameError == null) Text(stringResource(R.string.viewer_waiting_for_the_first_frame))
                if (image != null) {
                    val tap = if (!pointer || changing) Modifier else Modifier.pointerInput(viewId) {
                        detectTapGestures { offset -> input("click", {
                            put("x", (offset.x / size.width.coerceAtLeast(1)).toDouble().coerceIn(0.0, 1.0))
                            put("y", (offset.y / size.height.coerceAtLeast(1)).toDouble().coerceIn(0.0, 1.0))
                        }) }
                    }
                    Image(image.asImageBitmap(), stringResource(R.string.viewer_screen_on) + view?.str("output").orEmpty(),
                        Modifier.fillMaxWidth().aspectRatio(image.width.toFloat() / image.height).then(tap))
                }
                if (keyboard) {
                    OutlinedTextField(typing, { typing = it.take(2000) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.viewer_type_on_the_desktop)) })
                    Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                        TextButton({ val text = typing; input("type", { put("text", text) }) { if (typing == text) typing = "" } },
                            enabled = typing.isNotEmpty() && revision != null && !sending && !changing) { Text(stringResource(R.string.viewer_type)) }
                        TextButton({ input("key", { put("key", "Enter") }) }, enabled = revision != null && !sending && !changing) { Text(stringResource(R.string.viewer_enter)) }
                    }
                }
                frameError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
