@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.otectus.pal.mobile

import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Recordings of a conversation, and transcripts whose recording was not kept. */
@Composable
internal fun RecordingsList(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var items by remember(sessionId) { mutableStateOf<List<JsonObject>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var opened by rememberSaveable(sessionId, stateSaver = recordingSaver) { mutableStateOf<OpenRecording?>(null) }
    fun load() = scope.launch { ownerCall { repository.read("workbench.recordings.list", buildJsonObject { put("sessionId", sessionId); put("project", true) }) as JsonObject }.onSuccess { items = it.list("items"); error = null }.onFailure { error = it.message } }
    LaunchedEffect(sessionId) { load() }
    AncillarySheetScaffold(stringResource(R.string.media_title), stringResource(R.string.media_subtitle), items == null && error == null, dismiss) {
        error?.let { AncillaryFeedback(it, error = true) }
        if (items?.isEmpty() == true) Text(stringResource(R.string.media_none), color = MaterialTheme.colorScheme.onSurfaceVariant)
        items.orEmpty().forEach { item -> RecordingRow(item) { opened = OpenRecording(item.str("artifactId").orEmpty(), item.str("versionId"), null) } }
    }
    opened?.let { target -> RecordingScreen(repository, state, activity, sessionId, target) { opened = null; load() } }
}
@Composable
internal fun RecordingRow(item: JsonObject, open: () -> Unit) {
    val kind = stringResource(if (item.str("kind") == "transcript") R.string.media_transcript_only else if (item.isTrue("video")) R.string.media_video else R.string.media_audio)
    val transcribed = if (item.str("kind") == "transcript") "" else " · " + stringResource(if ((item.int("transcripts") ?: 0) > 0) R.string.media_transcribed else R.string.media_not_transcribed)
    Surface(onClick = open, modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(PALLayout.groupGap)) {
            Text(item.str("name").orEmpty(), style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("$kind$transcribed · ${byteSize(item.num("bytes"))}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
internal data class OpenRecording(val artifactId: String, val versionId: String?, val seconds: Double?)
internal val recordingSaver = androidx.compose.runtime.saveable.listSaver<OpenRecording?, Any?>({ if (it == null) emptyList() else listOf(it.artifactId, it.versionId, it.seconds) }, { if (it.isEmpty()) null else OpenRecording(it[0] as String, it[1] as String?, it[2] as Double?) })

/** One recording: its player, its transcript, and what can be done with the lines that are picked. */
@Composable
internal fun RecordingScreen(repository: PALRepository, state: MobileState, activity: FragmentActivity, sessionId: String, target: OpenRecording, dismiss: () -> Unit) {
    val scope = rememberCoroutineScope(); val context = LocalContext.current; val strings = LocalResources.current
    var opened by remember(target) { mutableStateOf<JsonObject?>(null) }
    var transcript by remember(target) { mutableStateOf<JsonObject?>(null) }
    var cues by remember(target) { mutableStateOf<List<TimedText.Cue>>(emptyList()) }
    var playback by remember(target) { mutableStateOf<MediaPlayback?>(null) }
    var progress by remember(target) { mutableStateOf<Float?>(null) }
    var error by remember(target) { mutableStateOf<String?>(null) }
    var notice by remember(target) { mutableStateOf<String?>(null) }
    var busy by remember(target) { mutableStateOf(false) }
    var pending by remember(target) { mutableStateOf<String?>(null) }
    var wanted by remember(target) { mutableStateOf(target.seconds) }
    var dialog by remember(target) { mutableStateOf<RecordingDialog?>(null) }
    var selected by remember(target) { mutableStateOf<IntRange?>(null) }
    // One transcript is read at a time: pages of the one before would otherwise be added to the lines of this one.
    var reading by remember(target) { mutableStateOf<Job?>(null) }
    fun open(transcriptId: String? = null) { reading?.cancel(); reading = scope.launch {
        busy = true
        ownerCall { repository.read("workbench.recordings.open", buildJsonObject { put("sessionId", sessionId); put("artifactId", target.artifactId); target.versionId?.let { put("versionId", it) }; transcriptId?.let { put("transcriptId", it) } }) as JsonObject }
            .onSuccess { value ->
                opened = value; transcript = value.obj("transcript"); selected = null; error = null
                cues = transcript?.list("cues").orEmpty().map(TimedText::cue)
                val shown = value.obj("transcript"); var next = shown?.int("next")
                // Long transcripts arrive in pages, in order.
                while (next != null && cues.size < 10_000) {
                    val from = next
                    val page = ownerCall { repository.read("workbench.recordings.cues", buildJsonObject { put("sessionId", sessionId); put("artifactId", shown?.str("artifactId")); put("versionId", shown?.str("versionId")); put("from", from); put("limit", 400) }) as JsonObject }.getOrElse { error = it.message; break }
                    cues = cues + page.list("cues").map(TimedText::cue); next = page.int("next")?.takeIf { it > from }
                }
            }.onFailure { error = it.message }
        busy = false
    } }
    LaunchedEffect(target) { open() }
    DisposableEffect(target) { onDispose { playback?.release() } }
    // Leaving the app pauses it: nothing plays from the background.
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { playback?.pause() }
    LaunchedEffect(playback) { while (isActive) { playback?.update(); delay(200) } }
    LaunchedEffect(playback?.ready, wanted) { val seconds = wanted; if (playback?.ready == true && seconds != null) { playback?.seek(seconds); wanted = null } }
    fun load() = scope.launch {
        val recording = opened?.obj("recording") ?: return@launch
        progress = 0f; error = null
        try { playback = MediaPlayback(context, downloadRecording(context, repository, sessionId, recording.str("artifactId").orEmpty(), recording.str("versionId").orEmpty()) { done, total -> progress = done.toFloat() / total.coerceAtLeast(1) }) }
        catch (cancelled: CancellationException) { throw cancelled } catch (failure: Exception) { error = failure.message } finally { progress = null }
    }
    /** A long job on the desktop, followed until it ends. */
    fun follow(value: JsonObject, done: (JsonObject) -> Unit) = scope.launch {
        val id = value.str("operationId") ?: return@launch
        pending = value.str("label") ?: strings.getString(R.string.media_working)
        try {
            while (isActive) {
                delay(900)
                val now = ownerCall { repository.read("workbench.operations.get", buildJsonObject { put("sessionId", sessionId); put("id", id) }) as JsonObject }.getOrElse { error = it.message; break }
                val phase = now.str("state")
                if (phase in setOf("queued", "running", "cancel_requested")) continue
                if (phase == "completed") done(now) else error = now.str("error") ?: now.obj("error")?.str("message") ?: strings.getString(R.string.media_not_finished)
                break
            }
        } finally { pending = null }
    }
    fun act(method: String, title: Int, params: JsonObject, after: (JsonObject) -> Unit) = scope.launch {
        busy = true; error = null; notice = null
        ownerCall { signed(activity, repository, method, params, strings.getString(title)) as JsonObject }.onSuccess(after).onFailure { error = it.message }
        busy = false
    }
    val chosen = selected?.let { range -> cues.filterIndexed { index, _ -> index in range } }.orEmpty()
    val start = chosen.minOfOrNull { it.start } ?: 0.0; val end = chosen.maxOfOrNull { it.end } ?: 0.0
    val ref: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = { put("sessionId", sessionId); put("artifactId", transcript?.str("artifactId").orEmpty()); put("versionId", transcript?.str("versionId").orEmpty()) }
    Dialog(dismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
            RecordingContent(
                opened = opened, transcript = transcript, cues = cues, playback = playback, progress = progress, busy = busy, pending = pending, error = error, notice = notice, selected = selected, wanted = target.seconds, canTranscribe = state.supports("workbench.recordings.transcribe"),
                close = dismiss, load = ::load, select = { selected = it },
                choose = { open(it) },
                transcribe = { opened?.obj("recording")?.let { recording -> act("workbench.recordings.transcribe", R.string.media_transcribe, buildJsonObject { put("sessionId", sessionId); put("artifactId", recording.str("artifactId")); put("versionId", recording.str("versionId")) }) { follow(it) { notice = strings.getString(R.string.media_transcript_ready); open() } } } },
                ask = {
                    val reference = buildJsonObject { put("kind", "artifact"); put("artifactId", transcript?.str("artifactId")); put("versionId", transcript?.str("versionId")); put("span", buildJsonObject { put("start", start); put("end", maxOf(end, start + 0.1)) }) }
                    error = ComposerReferences.add(sessionId, (transcript?.str("name").orEmpty()) + " " + TimedText.range(start, end), reference)?.let(strings::getString)
                    if (error == null) notice = strings.getString(R.string.media_added)
                },
                copy = { if (copyText(context, strings.getString(R.string.media_title), TimedText.quote(chosen))) notice = strings.getString(R.string.media_copied) else error = strings.getString(R.string.copy_refused) },
                show = { dialog = it },
            )
        }
    }
    when (dialog) {
        RecordingDialog.Correct -> CorrectLines(chosen, busy, error, { dialog = null }) { edits ->
            act("workbench.recordings.correct", R.string.media_correct, buildJsonObject { ref(); put("edits", JsonArray(edits.map { (index, text) -> buildJsonObject { put("index", index); put("text", text) } })) }) { notice = strings.getString(R.string.media_corrected); dialog = null; open(transcript?.str("artifactId")) }
        }
        RecordingDialog.Clip -> ClipDialog(start, end, transcript != null, busy, error, { dialog = null }) { from, to, withText ->
            val recording = opened?.obj("recording") ?: return@ClipDialog
            act("workbench.recordings.clip", R.string.media_clip, buildJsonObject {
                put("sessionId", sessionId); put("artifactId", recording.str("artifactId")); put("versionId", recording.str("versionId")); put("start", from); put("end", to)
                transcript?.takeIf { withText }?.let { shown -> put("transcript", buildJsonObject { put("artifactId", shown.str("artifactId")); put("versionId", shown.str("versionId")) }) }
            }) { dialog = null; follow(it) { notice = strings.getString(R.string.media_clip_ready) } }
        }
        RecordingDialog.Subtitles -> SubtitleDialog(if (chosen.isEmpty()) null else start to end, busy, error, { dialog = null }) { format, part, zero ->
            act("workbench.recordings.subtitles", R.string.media_subtitles, buildJsonObject { ref(); put("format", format); if (part) { put("start", start); put("end", maxOf(end, start + 0.1)); put("fromZero", zero) } }) { notice = strings.getString(R.string.media_subtitles_ready, it.str("name").orEmpty()); dialog = null }
        }
        null -> Unit
    }
}
internal enum class RecordingDialog { Correct, Clip, Subtitles }

/** What the recording screen shows. Playing needs the recording on this phone, which is fetched only when asked. */
@Composable
internal fun RecordingContent(opened: JsonObject?, transcript: JsonObject?, cues: List<TimedText.Cue>, playback: MediaPlayback?, progress: Float?, busy: Boolean, pending: String?, error: String?, notice: String?, selected: IntRange?, wanted: Double?, canTranscribe: Boolean,
    close: () -> Unit, load: () -> Unit, select: (IntRange?) -> Unit, choose: (String) -> Unit, transcribe: () -> Unit, ask: () -> Unit, copy: () -> Unit, show: (RecordingDialog) -> Unit) {
    val recording = opened?.obj("recording"); val list = rememberLazyListState()
    var query by rememberSaveable { mutableStateOf("") }
    val found = remember(cues, query) { TimedText.matches(cues, query) }
    var at by remember(found) { mutableIntStateOf(0) }
    val said = if (playback?.ready == true) TimedText.lineAt(cues, playback.position) else -1
    LaunchedEffect(cues.isNotEmpty(), wanted) { if (wanted != null && cues.isNotEmpty()) list.scrollToItem(TimedText.lineAt(cues, wanted).coerceAtLeast(0)) }
    LaunchedEffect(found, at) { found.getOrNull(at)?.let { list.animateScrollToItem(it) } }
    LaunchedEffect(said, playback?.playing) { if (playback?.playing == true && said >= 0 && !list.isScrollInProgress) list.animateScrollToItem((said - 1).coerceAtLeast(0)) }
    Column(Modifier.fillMaxSize().padding(horizontal = PALLayout.gutter)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(recording?.str("name") ?: transcript?.str("name") ?: stringResource(R.string.media_title), Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            IconButton(close) { Icon(Icons.Default.Close, stringResource(R.string.action_close)) }
        }
        if (busy || opened == null && error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        notice?.takeIf { error == null }?.let { Text(it, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
        pending?.let { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) { CircularProgressIndicator(Modifier.size(PALLayout.gutter)); Text("$it…", style = MaterialTheme.typography.bodySmall) } }
        if (opened != null && recording == null) Text(stringResource(R.string.media_not_kept), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (recording != null) {
            if (playback == null) {
                if (progress != null) LinearProgressIndicator({ progress }, Modifier.fillMaxWidth())
                else Button(load, enabled = recording.isTrue("available"), modifier = Modifier.fillMaxWidth().heightIn(min = PALLayout.target)) { Icon(Icons.Default.PlayArrow, null); Text(stringResource(R.string.media_load, byteSize(recording.num("bytes")))) }
                if (!recording.isTrue("available")) Text(stringResource(R.string.media_missing), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            } else PlayerControls(playback, recording.isTrue("video"))
            if (transcript == null && opened != null) {
                Text(stringResource(R.string.media_no_transcript), style = MaterialTheme.typography.bodySmall)
                if (canTranscribe && opened.isTrue("canTranscribe")) OutlinedButton(transcribe, enabled = !busy && pending == null, modifier = Modifier.heightIn(min = PALLayout.target)) { Text(stringResource(R.string.media_transcribe)) }
                else Text(stringResource(R.string.media_set_up), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (transcript != null) {
            val transcripts = opened?.list("transcripts").orEmpty()
            if (transcripts.size > 1) FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                transcripts.forEach { item -> FilterChip(item.str("artifactId") == transcript.str("artifactId"), { choose(item.str("artifactId").orEmpty()) }, { Text(item.str("language") ?: item.str("name").orEmpty(), maxLines = 1) }) }
            }
            OutlinedTextField(query, { query = it.take(200) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.media_search)) },
                trailingIcon = if (query.isBlank()) null else { { TextButton({ if (found.isNotEmpty()) at = (at + 1) % found.size }) { Text(if (found.isEmpty()) stringResource(R.string.media_no_match) else stringResource(R.string.media_match, at + 1, found.size)) } } })
            if (transcript.isTrue("truncated")) Text(stringResource(R.string.media_truncated), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), list) {
                itemsIndexed(cues, key = { index, _ -> index }) { index, cue ->
                    val picked = selected?.contains(index) == true
                    Row(Modifier.fillMaxWidth().background(if (picked) MaterialTheme.colorScheme.secondaryContainer else if (index == said) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.surface)
                        .selectable(picked, onClick = { select(pickLine(selected, index)) }).heightIn(min = PALLayout.target), verticalAlignment = Alignment.CenterVertically) {
                        val label = stringResource(R.string.media_play_from, TimedText.clock(cue.start))
                        TextButton({ playback?.let { it.seek(cue.start); it.play() } }, enabled = playback?.ready == true, modifier = Modifier.semantics { contentDescription = label }) { Text(TimedText.clock(cue.start)) }
                        Text((if (cue.speaker.isEmpty()) "" else cue.speaker + ": ") + cue.text, Modifier.weight(1f).padding(vertical = PALLayout.tight), fontWeight = if (index == said) FontWeight.SemiBold else FontWeight.Normal)
                    }
                }
            }
            selected?.let { range ->
                val first = cues.getOrNull(range.first)?.start ?: 0.0; val last = cues.filterIndexed { index, _ -> index in range }.maxOfOrNull { it.end } ?: first
                Text(TimedText.range(first, last) + " · " + pluralStringResource(R.plurals.media_lines, range.count(), range.count()), style = MaterialTheme.typography.labelMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    if (playback?.ready == true) OutlinedButton({ playback.playPart(first, last) }) { Text(stringResource(R.string.media_play)) }
                    Button(ask) { Text(stringResource(R.string.media_ask)) }
                    OutlinedButton(copy) { Text(stringResource(R.string.media_copy)) }
                    if (transcript.isTrue("latest") && range.count() <= 20) OutlinedButton({ show(RecordingDialog.Correct) }) { Text(stringResource(R.string.media_correct)) }
                    if (recording != null) OutlinedButton({ show(RecordingDialog.Clip) }) { Text(stringResource(R.string.media_clip)) }
                    OutlinedButton({ show(RecordingDialog.Subtitles) }) { Text(stringResource(R.string.media_subtitles)) }
                    TextButton({ select(null) }) { Text(stringResource(R.string.media_clear)) }
                }
            } ?: TextButton({ show(RecordingDialog.Subtitles) }) { Text(stringResource(R.string.media_subtitles_all)) }
        }
        Spacer(Modifier.height(PALLayout.small))
    }
}
/** Tapping picks a line, tapping another extends to it, and tapping the only one clears it. */
internal fun pickLine(current: IntRange?, index: Int): IntRange? = when {
    current == null -> index..index
    current.first == index && current.last == index -> null
    index < current.first -> index..current.last
    index > current.last -> current.first..index
    else -> index..index
}

@Composable
private fun PlayerControls(playback: MediaPlayback, video: Boolean) {
    if (playback.problem) { Text(stringResource(R.string.media_cannot_play), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall); return }
    if (video) {
        val ratio = if (playback.videoWidth > 0 && playback.videoHeight > 0) playback.videoWidth.toFloat() / playback.videoHeight else 16f / 9f
        val description = stringResource(R.string.media_video)
        Box(Modifier.fillMaxWidth().heightIn(max = PALLayout.desktopPreviewHeight * 0.6f), contentAlignment = Alignment.Center) {
            AndroidView({ context -> TextureView(context).apply {
                surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                    override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) { playback.surface(Surface(texture)) }
                    override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit
                    override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean { playback.surface(null); return true }
                    override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
                }
            } }, Modifier.aspectRatio(ratio).semantics { contentDescription = description })
        }
    }
    var dragging by remember { mutableStateOf<Float?>(null) }
    val position = stringResource(R.string.media_position)
    Slider(dragging ?: playback.position.toFloat(), { dragging = it }, Modifier.fillMaxWidth().semantics { contentDescription = position }, enabled = playback.ready, valueRange = 0f..playback.duration.toFloat().coerceAtLeast(0.1f),
        onValueChangeFinished = { dragging?.let { playback.seek(it.toDouble()) }; dragging = null })
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.tight)) {
        FilledIconButton(playback::toggle, enabled = playback.ready) { if (playback.playing) Icon(painterResource(R.drawable.ic_pause), stringResource(R.string.media_pause)) else Icon(Icons.Default.PlayArrow, stringResource(R.string.media_play)) }
        val back = stringResource(R.string.media_back); val forward = stringResource(R.string.media_forward)
        TextButton({ playback.seek(playback.position - 10) }, enabled = playback.ready, modifier = Modifier.semantics { contentDescription = back }) { Text("−10") }
        TextButton({ playback.seek(playback.position + 10) }, enabled = playback.ready, modifier = Modifier.semantics { contentDescription = forward }) { Text("+10") }
        var rate by remember { mutableFloatStateOf(1f) }
        val speeds = listOf(0.75f, 1f, 1.25f, 1.5f, 2f); val speed = stringResource(R.string.media_speed)
        TextButton({ rate = speeds[(speeds.indexOf(rate) + 1) % speeds.size]; playback.speed(rate) }, enabled = playback.ready, modifier = Modifier.semantics { contentDescription = "$speed $rate" }) { Text("${if (rate % 1f == 0f) rate.toInt().toString() else rate.toString()}×") }
        Text("${TimedText.clock(playback.position)} / ${TimedText.clock(playback.duration)}", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun CorrectLines(lines: List<TimedText.Cue>, busy: Boolean, error: String?, dismiss: () -> Unit, save: (List<Pair<Int, String>>) -> Unit) {
    val drafts = remember(lines) { mutableStateListOf<String>().apply { addAll(lines.map { it.text }) } }
    val changed = lines.indices.filter { drafts[it] != lines[it].text }
    ToolDialog(stringResource(R.string.media_correct), dismiss, { TextButton({ save(changed.map { lines[it].index to drafts[it] }) }, enabled = !busy && changed.isNotEmpty()) { Text(stringResource(R.string.media_save_corrections)) } }, busy, error) {
        Text(stringResource(R.string.media_correct_hint), style = MaterialTheme.typography.bodySmall)
        lines.forEachIndexed { index, line -> OutlinedTextField(drafts[index], { drafts[index] = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text(TimedText.clock(line.start)) }) }
    }
}
@Composable
internal fun ClipDialog(start: Double, end: Double, hasTranscript: Boolean, busy: Boolean, error: String?, dismiss: () -> Unit, make: (Double, Double, Boolean) -> Unit) {
    var from by rememberSaveable { mutableStateOf(TimedText.clock(start)) }
    var to by rememberSaveable { mutableStateOf(TimedText.clock(kotlin.math.ceil(end))) }
    var withText by rememberSaveable { mutableStateOf(true) }
    val first = TimedText.seconds(from); val last = TimedText.seconds(to); val valid = first != null && last != null && last > first && last - first <= 900
    ToolDialog(stringResource(R.string.media_clip), dismiss, { TextButton({ if (first != null && last != null) make(first, last, withText && hasTranscript) }, enabled = valid && !busy) { Text(stringResource(R.string.media_make_clip)) } }, busy, error) {
        Text(stringResource(R.string.media_clip_hint), style = MaterialTheme.typography.bodySmall)
        OutlinedTextField(from, { from = it.take(12) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.media_from)) }, isError = first == null)
        OutlinedTextField(to, { to = it.take(12) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text(stringResource(R.string.media_to)) }, isError = last == null)
        if (!valid) Text(stringResource(R.string.media_clip_times), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        if (hasTranscript) ToolCheck(stringResource(R.string.media_clip_text), withText) { withText = it }
    }
}
@Composable
internal fun SubtitleDialog(part: Pair<Double, Double>?, busy: Boolean, error: String?, dismiss: () -> Unit, make: (String, Boolean, Boolean) -> Unit) {
    var format by rememberSaveable { mutableStateOf("srt") }
    var zero by rememberSaveable { mutableStateOf(false) }
    ToolDialog(stringResource(R.string.media_subtitles), dismiss, { TextButton({ make(format, part != null, zero) }, enabled = !busy) { Text(stringResource(R.string.media_make_file)) } }, busy, error) {
        Text(if (part == null) stringResource(R.string.media_subtitles_whole) else TimedText.range(part.first, part.second), style = MaterialTheme.typography.bodySmall)
        Choice("SubRip (.srt)", format == "srt") { format = "srt" }
        Choice("WebVTT (.vtt)", format == "vtt") { format = "vtt" }
        if (part != null) ToolCheck(stringResource(R.string.media_from_zero), zero) { zero = it }
    }
}
/** Times a reply cites from a transcript it was given. Each opens the recording there. */
@Composable
internal fun CitedTimes(repository: PALRepository, state: MobileState, sessionId: String, text: String, recordings: List<dev.otectus.pal.mobile.protocol.MessageRecording>) {
    val activity = LocalActivity.current as? FragmentActivity ?: return
    val source = recordings.firstOrNull() ?: return
    if (!state.supports("workbench.recordings.open")) return
    val times = remember(text) { TimedText.cited(text) }
    if (times.isEmpty()) return
    var opened by rememberSaveable(stateSaver = recordingSaver) { mutableStateOf<OpenRecording?>(null) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        times.forEach { time ->
            val label = stringResource(R.string.media_open_at, source.name, time.label)
            AssistChip({ opened = OpenRecording(source.artifactId, source.versionId, time.start) }, { Text(time.label) }, Modifier.semantics { contentDescription = label }, leadingIcon = { Icon(Icons.Default.PlayArrow, null, Modifier.size(AssistChipDefaults.IconSize)) })
        }
    }
    opened?.let { RecordingScreen(repository, state, activity, sessionId, it) { opened = null } }
}
