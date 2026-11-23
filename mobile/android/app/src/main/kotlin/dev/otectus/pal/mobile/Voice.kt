package dev.otectus.pal.mobile

import androidx.compose.ui.res.stringResource
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.protocol.Message
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.Locale

/**
 * Voice on a phone with full access (PAL Everywhere §16.1). Push-to-talk records a short note while the microphone is
 * shown as on; the desktop transcribes it with its own whisper.cpp and the text lands in the draft for the person to
 * read and send. The audio is never kept on either device. Replies can be read aloud here with Android's speech engine:
 * Stop speaking stops only the voice (never the reply or a running job), and starting to talk stops it too. Leaving
 * the app ends a recording; nothing restarts the microphone by itself.
 */
internal class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    var started = 0L
        private set
    val recording get() = recorder != null
    /** At most two minutes of 16 kHz mono AAC at 32 kbit/s: about 480 KB, within one request. */
    fun start(onLimit: () -> Unit) {
        val out = File(context.cacheDir, "voice-note.m4a").also { it.delete() }
        val next = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
        next.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
        next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        next.setAudioChannels(1); next.setAudioSamplingRate(16_000); next.setAudioEncodingBitRate(32_000)
        next.setMaxDuration(120_000)
        next.setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) onLimit() }
        next.setOutputFile(out.absolutePath)
        try { next.prepare(); next.start() } catch (error: Exception) { next.release(); out.delete(); throw error }
        recorder = next; file = out; started = System.currentTimeMillis()
    }
    /** The recorded note, then the file is deleted. */
    fun stop(): ByteArray? {
        val current = recorder ?: return null
        recorder = null
        return try { current.stop(); file?.readBytes() } catch (_: RuntimeException) { null } finally { current.release(); file?.delete() }
    }
    fun cancel() { recorder?.let { runCatching { it.stop() }; it.release() }; recorder = null; file?.delete() }
}

/** Android's own speech engine, for reading replies aloud on this phone only. */
internal class ReplySpeaker(private val context: Context) {
    var speaking by mutableStateOf(false)
        private set
    var ready by mutableStateOf(false)
        private set
    var problem by mutableStateOf<String?>(null)
        private set
    private val main = Handler(Looper.getMainLooper())
    private var disposed = false
    private var current: String? = null
    private var lastId: String? = null
    var failedMessageId by mutableStateOf<String?>(null)
        private set
    private val engine = TextToSpeech(context.applicationContext) { status -> main.post {
        if (!disposed) {
            ready = status == TextToSpeech.SUCCESS
            if (!ready) problem = context.getString(R.string.speech_unavailable)
        }
    } }.apply {
        setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) { main.post { if (utteranceId == lastId) speaking = false } }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { main.post {
                if (current != null && utteranceId?.startsWith("$current/") == true) {
                    failedMessageId = current
                    problem = context.getString(R.string.speech_interrupted)
                    stop()
                }
            } }
        })
    }
    fun speak(message: Message): Boolean {
        if (!ready || problem != null) return false
        if (engine.setLanguage(Locale.getDefault()) < TextToSpeech.LANG_AVAILABLE) {
            problem = context.getString(R.string.speech_language)
            return false
        }
        val plain = message.text.replace(Regex("""```[\s\S]*?```"""), context.getString(R.string.speech_code_omitted)).replace(Regex("[#*_`>|]"), "").trim()
        if (plain.isBlank()) return false
        val limit = TextToSpeech.getMaxSpeechInputLength() - 1
        current = message.id
        var offset = 0
        while (offset < plain.length) {
            var end = minOf(offset + limit, plain.length)
            if (end < plain.length) {
                val space = plain.lastIndexOf(' ', end)
                if (space > offset) end = space + 1 else if (plain[end - 1].isHighSurrogate()) end--
            }
            val id = "${message.id}/$offset"
            if (end == plain.length) lastId = id
            if (engine.speak(plain.substring(offset, end), if (offset == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, id) != TextToSpeech.SUCCESS) {
                stop()
                problem = context.getString(R.string.speech_failure)
                return false
            }
            offset = end
        }
        speaking = true
        return true
    }
    fun stop() { current = null; lastId = null; engine.stop(); speaking = false }
    fun shutdown() { disposed = true; stop(); engine.shutdown() }
}

/**
 * The voice row above the composer: Talk (push-to-talk), Read replies aloud, Stop speaking. Each control does one
 * thing: none of them cancels the model's reply or a job.
 */
@Composable
internal fun VoiceBar(repository: PALRepository, sessionId: String, messages: List<Message>, busy: Boolean, onText: (String) -> Unit) {
    val strings = androidx.compose.ui.platform.LocalResources.current

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var available by remember { mutableStateOf<Boolean?>(null) }
    val recorder = remember(sessionId) { VoiceRecorder(context) }

    var state by remember(sessionId) { mutableStateOf("idle") }
    var elapsed by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var readAloud by rememberSaveable { mutableStateOf(false) }
    var speechAttempt by remember { mutableIntStateOf(0) }
    val speaker = remember(sessionId, readAloud, speechAttempt) { if (readAloud) ReplySpeaker(context) else null }
    DisposableEffect(speaker) { onDispose { speaker?.shutdown() } }
    var spoken by rememberSaveable(sessionId) { mutableStateOf(messages.lastOrNull { it.role == "assistant" }?.id) }
    LaunchedEffect(Unit) { available = runCatching { (repository.request("owner.voice.status", buildJsonObject {}) as JsonObject).isTrue("available") }.getOrDefault(false) }
    fun transcribe() {
        val bytes = recorder.stop()
        if (bytes == null || bytes.size < 512) { state = "idle"; error = strings.getString(R.string.voice_nothing_was_recorded); return }
        state = "transcribing"
        scope.launch {
            runCatching { repository.request("owner.voice.transcribe", buildJsonObject { put("sessionId", sessionId); put("mime", "audio/mp4"); put("audio", Base64.encodeToString(bytes, Base64.NO_WRAP)) }) as JsonObject }
                .onSuccess { result -> result.str("text")?.takeIf { it.isNotBlank() }?.let(onText) ?: run { error = strings.getString(R.string.voice_no_speech_was_recognized) } }
                .onFailure { error = it.message }
            state = "idle"
        }
    }
    fun begin() {
        speaker?.stop(); error = null
        runCatching { recorder.start { transcribe() } }.onSuccess { state = "recording"; elapsed = 0 }.onFailure { error = strings.getString(R.string.voice_the_microphone_could_not_start, it.message) }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) begin() else error = strings.getString(R.string.voice_allow_the_microphone_to_talk_to_pal) }
    LaunchedEffect(state) { while (state == "recording") { delay(1000); elapsed = ((System.currentTimeMillis() - recorder.started) / 1000).toInt() } }
    // A new reply is read aloud once, after it finishes, when Read aloud is on.
    LaunchedEffect(busy, messages.lastOrNull { it.role == "assistant" }?.id, readAloud, speaker?.ready, state) {
        val last = messages.lastOrNull { it.role == "assistant" } ?: return@LaunchedEffect
        if (!readAloud) spoken = last.id
        else if (!busy && last.id != spoken && state == "idle" && speaker?.speak(last) == true) spoken = last.id
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val activeSpeaker by rememberUpdatedState(speaker)
    DisposableEffect(lifecycle, recorder) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) { if (recorder.recording) { recorder.cancel(); state = "idle"; error = strings.getString(R.string.voice_recording_ended_when_pal_left_the_screen) }; activeSpeaker?.stop() } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); recorder.cancel() }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = PALLayout.groupGap)) {
        when (state) {
            "recording" -> {
                Text(stringResource(R.string.voice_microphone_on), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                    Text("%d:%02d".format(elapsed / 60, elapsed % 60), Modifier.weight(1f))
                    FilledTonalButton({ transcribe() }) { Text(stringResource(R.string.action_done)) }
                    IconButton({ recorder.cancel(); state = "idle" }) { Icon(Icons.Default.Close, stringResource(R.string.voice_discard_the_recording)) }
                }
            }
            "transcribing" -> Text(stringResource(R.string.voice_transcribing_on_the_desktop), Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            else -> {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(PALLayout.groupGap)) {
                    if (available == true) OutlinedButton({ if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) begin() else permission.launch(Manifest.permission.RECORD_AUDIO) }) { Text(stringResource(R.string.voice_talk)) }
                    Row(Modifier.heightIn(min = PALLayout.target).toggleable(readAloud, role = Role.Switch) { readAloud = it }, verticalAlignment = Alignment.CenterVertically) {
                        Switch(readAloud, null)
                        Text(stringResource(R.string.voice_read_replies), Modifier.padding(start = PALLayout.small), style = MaterialTheme.typography.bodyMedium)
                    }
                    if (speaker?.speaking == true) TextButton({ speaker.stop() }) { Text(stringResource(R.string.voice_stop_speaking)) }
                }
                if (available == false) Text(stringResource(R.string.voice_voice_notes_need_a_configured_desktop_transcription_engine), style = MaterialTheme.typography.bodySmall)
            }
        }
        speaker?.let { voice ->
            if (voice.problem != null) {
                Text(voice.problem.orEmpty(), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error)
                TextButton({ if (spoken == voice.failedMessageId) spoken = null; speechAttempt++ }) { Text(stringResource(R.string.voice_retry_phone_speech)) }
            } else if (!voice.ready) Text(stringResource(R.string.voice_connecting_to_phone_speech), style = MaterialTheme.typography.bodySmall)
        }
    }
    error?.let { Text(it, Modifier.padding(horizontal = PALLayout.gutter), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}
