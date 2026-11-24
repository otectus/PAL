package dev.otectus.pal.mobile

import androidx.compose.ui.res.stringResource
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.fragment.app.FragmentActivity
import dev.otectus.pal.mobile.data.ConnectionState
import dev.otectus.pal.mobile.data.MobileState
import dev.otectus.pal.mobile.data.PALRepository
import dev.otectus.pal.mobile.data.RealtimeAudioFrame
import dev.otectus.pal.mobile.data.offersLiveVoice
import dev.otectus.pal.mobile.protocol.Message
import dev.otectus.pal.mobile.protocol.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

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

/** One negotiated, authenticated mobile realtime stream. It owns the microphone and speaker until [close]. */
internal class RealtimeVoiceClient(
    private val context: Context,
    private val repository: PALRepository,
    private val sessionId: String,
    private val rootSecret: ByteArray,
    private val inputRate: Int,
    private val outputRate: Int,
    private val inputCodec: String,
    private val outputCodec: String,
    private val status: (String) -> Unit,
    private val failure: (String) -> Unit,
) {
    private val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + Dispatchers.IO)
    private var recorder: AudioRecord? = null
    private var player: AudioTrack? = null
    private var inputSequence = 0L
    private var outputSequence = 0L
    private val writtenFrames = AtomicLong(0)
    private var recordJob: Job? = null
    private var playbackJob: Job? = null
    private var eventJob: Job? = null

    @android.annotation.SuppressLint("MissingPermission")
    fun start() {
        require(inputCodec == "pcm16" && outputCodec == "pcm16") { "This phone currently supports PCM realtime audio" }
        val inputBuffer = maxOf(AudioRecord.getMinBufferSize(inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), inputRate / 5 * 2)
        val outputBuffer = maxOf(AudioTrack.getMinBufferSize(outputRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), outputRate / 5 * 2)
        val nextRecorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(inputRate).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
            .setBufferSizeInBytes(inputBuffer).build()
        val nextPlayer = AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(outputRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(outputBuffer).build()
        if (nextRecorder.state != AudioRecord.STATE_INITIALIZED || nextPlayer.state != AudioTrack.STATE_INITIALIZED) {
            nextRecorder.release(); nextPlayer.release()
            error("Realtime audio devices could not start")
        }
        recorder = nextRecorder; player = nextPlayer
        nextPlayer.play(); nextRecorder.startRecording(); status("listening")
        val chunk = ByteArray((inputRate / 50 * 2).coerceAtLeast(640)) // 20 ms, PCM16 mono
        recordJob = scope.launch {
            try {
                while (isActive) {
                    val count = nextRecorder.read(chunk, 0, chunk.size, AudioRecord.READ_BLOCKING)
                    if (count > 0) repository.sendRealtimeFrame(RealtimeAudioFrame.encode(rootSecret, RealtimeAudioFrame.Value(
                        sessionId, false, inputCodec, inputSequence++, System.currentTimeMillis(), audio = chunk.copyOf(count))))
                    else if (count < 0) error("Microphone read failed ($count)")
                }
            } catch (error: Throwable) { if (isActive) fail(error) }
        }
        playbackJob = scope.launch {
            try {
                repository.realtimeFrames.collect { bytes ->
                    val frame = RealtimeAudioFrame.decode(rootSecret, bytes)
                    if (frame.sessionId != sessionId) return@collect
                    require(frame.output && frame.codec == outputCodec && frame.sequence == outputSequence) { "Realtime audio arrived out of order" }
                    outputSequence++
                    var offset = 0
                    while (offset < frame.audio.size) {
                        val count = nextPlayer.write(frame.audio, offset, frame.audio.size - offset, AudioTrack.WRITE_BLOCKING)
                        if (count <= 0) error("Speaker write failed ($count)")
                        offset += count; writtenFrames.addAndGet((count / 2).toLong())
                    }
                    status("speaking")
                }
            } catch (error: Throwable) { if (isActive) fail(error) }
        }
        eventJob = scope.launch {
            try {
                repository.realtimeEvents.collect { pushed ->
                    val id = pushed.data.str("sessionId") ?: return@collect
                    if (id != sessionId) return@collect
                    val event = pushed.data.obj("event") ?: return@collect
                    when (event.str("type")) {
                        "state" -> event.str("state")?.let(status)
                        "turn-complete" -> acknowledgeWhenPlaybackDrains()
                        "interrupted" -> flushPlayback()
                        "error" -> failure(event.str("message") ?: "Realtime voice failed")
                    }
                }
            } catch (error: Throwable) { if (isActive) fail(error) }
        }
    }

    private suspend fun acknowledgeWhenPlaybackDrains() {
        var target = writtenFrames.get()
        while (scope.isActive) {
            delay(30)
            val latest = writtenFrames.get()
            if (latest != target) { target = latest; continue }
            val played = player?.playbackHeadPosition?.toLong()?.and(0xffff_ffffL) ?: return
            if (played >= target) break
        }
        runCatching { repository.request("owner.realtime.playbackComplete", buildJsonObject { put("sessionId", sessionId) }) }
    }
    fun interrupt() { flushPlayback() }
    /** The stream can end on another thread while this runs; a player that is already gone has nothing to flush. */
    private fun flushPlayback() { runCatching { player?.let { it.pause(); it.flush(); it.play() }; writtenFrames.set(player?.playbackHeadPosition?.toLong()?.and(0xffff_ffffL) ?: 0) } }
    private fun fail(error: Throwable) { failure(error.message ?: "Realtime audio stopped"); close() }
    fun close() {
        recordJob?.cancel(); playbackJob?.cancel(); eventJob?.cancel(); scope.cancel()
        recorder?.let { runCatching { it.stop() }; it.release() }; recorder = null
        player?.let { runCatching { it.stop() }; it.release() }; player = null
        rootSecret.fill(0)
    }
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

/** What a voice note is doing: nothing, being recorded on this phone, or becoming text on the desktop. */
internal enum class VoiceNote { Idle, Recording, Transcribing }

/**
 * The voice of the conversation on screen: Talk (push-to-talk), live voice, and Read replies aloud. Each does one thing:
 * none of them cancels the model's reply or a job. It belongs to the conversation and not to the Voice settings window,
 * so closing the window changes nothing; what is still on is then shown, and ended, above the message field.
 */
@Stable
internal class Voice(
    private val repository: PALRepository,
    private val activity: FragmentActivity,
    private val sessionId: String,
    tools: MutableState<Boolean>,
    readAloud: MutableState<Boolean>,
    spoken: MutableState<String?>,
    private val onText: (String) -> Unit,
) {
    /** Outlives the screen: live voice that is left behind is still ended on the desktop. */
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
    private val recorder = VoiceRecorder(activity)
    private var closed = false
    private var wanted: (() -> Unit)? = null
    private var client: RealtimeVoiceClient? = null
    private var liveId: String? = null
    private var attempt = 0
    /** Asks Android for the microphone. The screen sets it and answers with [permitted]. */
    var ask: () -> Unit = {}

    var note by mutableStateOf(VoiceNote.Idle)
        private set
    var elapsed by mutableIntStateOf(0)
        private set
    /** What live voice is doing, in the desktop's words; null while it is off. */
    var live by mutableStateOf<String?>(null)
        private set
    /** The microphone and speaker are on; live voice that is still connecting has neither. */
    var liveStarted by mutableStateOf(false)
        private set
    /** Whether this desktop turns notes into text; null until it has said so. */
    var transcribes by mutableStateOf<Boolean?>(null)
        private set
    var checkFailed by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var speaker by mutableStateOf<ReplySpeaker?>(null)
        private set
    var tools by tools
    var readAloud by readAloud
    private var spoken by spoken

    suspend fun askDesktop() {
        ownerCall { repository.request("owner.voice.status", buildJsonObject {}) as JsonObject }
            .onSuccess { transcribes = it.isTrue("available"); checkFailed = null }.onFailure { checkFailed = it.message }
    }
    fun dismissError() { error = null }

    private fun withMicrophone(action: () -> Unit) {
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) action()
        else { wanted = action; ask() }
    }
    fun permitted(granted: Boolean) {
        val action = wanted
        wanted = null
        if (granted) action?.invoke() else error = activity.getString(R.string.voice_allow_the_microphone_to_talk_to_pal)
    }

    fun talk() = withMicrophone {
        if (note == VoiceNote.Idle && live == null) {
            speaker?.stop(); error = null
            runCatching { recorder.start { finishNote() } }.onSuccess { elapsed = 0; note = VoiceNote.Recording }
                .onFailure { error = activity.getString(R.string.voice_the_microphone_could_not_start, it.message) }
        }
    }
    fun tick() { elapsed = ((System.currentTimeMillis() - recorder.started) / 1000).toInt() }
    fun finishNote() {
        if (note != VoiceNote.Recording) return
        val bytes = recorder.stop()
        if (bytes == null || bytes.size < 512) { note = VoiceNote.Idle; error = activity.getString(R.string.voice_nothing_was_recorded); return }
        note = VoiceNote.Transcribing
        work.launch {
            ownerCall { repository.request("owner.voice.transcribe", buildJsonObject { put("sessionId", sessionId); put("mime", "audio/mp4"); put("audio", Base64.encodeToString(bytes, Base64.NO_WRAP)) }) as JsonObject }
                .onSuccess { result ->
                    val text = result.str("text")?.takeIf { it.isNotBlank() }
                    if (text == null) error = activity.getString(R.string.voice_no_speech_was_recognized) else if (!closed) onText(text)
                }
                .onFailure { error = it.message }
            note = VoiceNote.Idle
        }
    }
    fun discardNote() { recorder.cancel(); note = VoiceNote.Idle }

    fun startLive(model: String) = withMicrophone { connect(model) }
    private fun connect(model: String) {
        if (note != VoiceNote.Idle || live != null) return
        speaker?.stop(); error = null
        live = "connecting"
        val turn = ++attempt
        work.launch {
            var started: String? = null
            try {
                val id = (signed(activity, repository, "owner.realtime.start", buildJsonObject {
                    put("conversationId", sessionId); put("model", model); put("turnDetection", "server_vad")
                    if (tools) put("toolsEnabled", true)
                }, activity.getString(R.string.voice_start_live_review)) as JsonObject).str("sessionId") ?: error("Desktop did not start realtime voice")
                started = id
                val offer = repository.request("owner.realtime.offer", buildJsonObject { put("sessionId", id) }) as JsonObject
                val input = offer.obj("input") ?: error("Realtime input format is missing")
                val output = offer.obj("output") ?: error("Realtime output format is missing")
                val secret = Base64.decode(offer.str("frameKey") ?: error("Realtime frame key is missing"), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                // Stopped, left or put in the background while it connected: the microphone stays off.
                if (turn != attempt) { endOnDesktop(id); return@launch }
                check(activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) { activity.getString(R.string.voice_live_ended_when_pal_left_the_screen) }
                val next = RealtimeVoiceClient(activity, repository, id, secret,
                    input.int("sampleRate") ?: 24_000, output.int("sampleRate") ?: 24_000,
                    input.str("codec") ?: "pcm16", output.str("codec") ?: "pcm16",
                    { state -> main.post { if (turn == attempt) heard(state) } },
                    { message -> main.post { if (turn == attempt) { error = message; stopLive() } } })
                next.start(); client = next; liveId = id; liveStarted = true
            } catch (failure: Exception) {
                started?.let(::endOnDesktop)
                if (turn == attempt) { live = null; error = failure.message }
            }
        }
    }
    /** The desktop can end live voice too; the microphone does not stay on after it has. */
    private fun heard(state: String) {
        if (state == "closed") { liveId = null; stopLive(); error = activity.getString(R.string.voice_live_ended) } else live = state.replace('-', ' ')
    }
    fun stopLive() {
        attempt++
        val id = liveId
        client?.close(); client = null; liveId = null; live = null; liveStarted = false
        if (id != null) endOnDesktop(id)
    }
    private fun endOnDesktop(id: String) { work.launch { runCatching { repository.mutate("owner.realtime.stop", buildJsonObject { put("sessionId", id) }) } } }
    fun finishTurn() = tell("owner.realtime.commit")
    fun interrupt() { client?.interrupt(); tell("owner.realtime.interrupt") }
    private fun tell(method: String) {
        val id = liveId ?: return
        work.launch { ownerCall { repository.request(method, buildJsonObject { put("sessionId", id) }) }.onFailure { error = it.message } }
    }

    fun speech(on: Boolean) { speaker?.shutdown(); speaker = if (on) ReplySpeaker(activity) else null }
    fun retrySpeech() { if (spoken == speaker?.failedMessageId) spoken = null; speech(true) }
    /** A new reply is read aloud once, after it finishes, while Read replies is on. */
    fun read(reply: Message, busy: Boolean) {
        if (!readAloud) spoken = reply.id
        else if (!busy && reply.id != spoken && note == VoiceNote.Idle && speaker?.speak(reply) == true) spoken = reply.id
    }

    fun leaveApp() {
        if (recorder.recording) { discardNote(); error = activity.getString(R.string.voice_recording_ended_when_pal_left_the_screen) }
        if (liveStarted) { stopLive(); error = activity.getString(R.string.voice_live_ended_when_pal_left_the_screen) }
        speaker?.stop()
    }
    fun close() { closed = true; recorder.cancel(); stopLive() }
}

@Composable
internal fun rememberVoice(repository: PALRepository, activity: FragmentActivity, session: Session, messages: List<Message>, busy: Boolean, onText: (String) -> Unit): Voice {
    val reply by rememberUpdatedState(messages.lastOrNull { it.role == "assistant" })
    val tools = rememberSaveable(session.id) { mutableStateOf(false) }
    val readAloud = rememberSaveable(session.id) { mutableStateOf(false) }
    val spoken = rememberSaveable(session.id) { mutableStateOf(reply?.id) }
    val voice = remember(session.id) { Voice(repository, activity, session.id, tools, readAloud, spoken, onText) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission(), voice::permitted)
    SideEffect { voice.ask = { permission.launch(Manifest.permission.RECORD_AUDIO) } }
    DisposableEffect(voice, voice.readAloud) { voice.speech(voice.readAloud); onDispose { voice.speech(false) } }
    LaunchedEffect(voice) { snapshotFlow { voice.note }.collectLatest { while (it == VoiceNote.Recording) { delay(1_000); voice.tick() } } }
    LaunchedEffect(voice, busy, reply?.id) {
        snapshotFlow { Triple(voice.readAloud, voice.speaker?.ready, voice.note) }.collect { reply?.let { voice.read(it, busy) } }
    }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, voice) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) voice.leaveApp() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); voice.close() }
    }
    return voice
}

/** Every voice control, in a small window over the conversation. */
@Composable
internal fun VoiceSettingsDialog(voice: Voice, state: MobileState, session: Session, close: () -> Unit) {
    val liveOffered = state.offersLiveVoice(session)
    val online = state.supports("owner.voice.status")
    val target = Modifier.heightIn(min = PALLayout.target)
    val padding = PaddingValues(horizontal = PALLayout.groupGap)
    LaunchedEffect(voice, online) { if (online) voice.askDesktop() }
    ToolDialog(stringResource(R.string.voice_settings), close) {
        if (voice.note != VoiceNote.Idle) {
            NoteStatus(voice)
            if (voice.note == VoiceNote.Recording) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                Button(voice::finishNote, target.weight(1f)) { Text(stringResource(R.string.action_done)) }
                DiscardNote(voice)
            }
        } else voice.live?.let { live ->
            VoiceStatus(R.drawable.ic_mic, stringResource(R.string.voice_live_state, live))
            Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
                OutlinedButton(voice::finishTurn, target.weight(1f), enabled = voice.liveStarted, contentPadding = padding) { Text(stringResource(R.string.voice_finish_turn)) }
                OutlinedButton(voice::interrupt, target.weight(1f), enabled = voice.liveStarted, contentPadding = padding) { Text(stringResource(R.string.voice_interrupt)) }
            }
            Button(voice::stopLive, target.fillMaxWidth()) { Text(stringResource(R.string.voice_stop_live)) }
        } ?: Row(horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
            OutlinedButton(voice::talk, target.weight(1f), enabled = voice.transcribes == true && state.supports("owner.voice.transcribe"), contentPadding = padding) { Text(stringResource(R.string.voice_talk)) }
            if (liveOffered) OutlinedButton({ voice.startLive(session.model.orEmpty()) }, target.weight(1f), contentPadding = padding) { Text(stringResource(R.string.voice_live)) }
        }
        if (state.connection !is ConnectionState.Online) Text(connectionTitle(state), style = MaterialTheme.typography.bodySmall)
        else if (voice.transcribes == false) Text(stringResource(R.string.voice_voice_notes_need_a_configured_desktop_transcription_engine), style = MaterialTheme.typography.bodySmall)
        if (liveOffered && voice.live == null) ToolCheck(stringResource(R.string.voice_live_tools), voice.tools) { voice.tools = it }
        ToolCheck(stringResource(R.string.voice_read_replies), voice.readAloud) { voice.readAloud = it }
        voice.speaker?.let { speaker ->
            if (speaker.problem != null) SpeechProblem(speaker, voice)
            else if (!speaker.ready) Text(stringResource(R.string.voice_connecting_to_phone_speech), style = MaterialTheme.typography.bodySmall)
            else if (speaker.speaking) OutlinedButton(speaker::stop, target.fillMaxWidth()) { Text(stringResource(R.string.voice_stop_speaking)) }
        }
        (voice.error ?: voice.checkFailed)?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

/**
 * What is on, or went wrong, while the Voice settings window is closed: the microphone is never on without saying so here.
 * It takes no space at any other time.
 */
@Composable
internal fun VoiceStrip(voice: Voice, openSettings: () -> Unit) {
    val speaker = voice.speaker
    if (voice.note == VoiceNote.Idle && voice.live == null && speaker?.speaking != true && speaker?.problem == null && voice.error == null) return
    Surface(Modifier.fillMaxWidth().testTag("voiceStrip"), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Column(Modifier.widthIn(max = PALLayout.readingWidth).fillMaxWidth().padding(start = PALLayout.gutter, end = PALLayout.small)) {
                if (voice.note != VoiceNote.Idle) StripRow({ NoteStatus(voice) }) {
                    if (voice.note == VoiceNote.Recording) { FilledTonalButton(voice::finishNote) { Text(stringResource(R.string.action_done)) }; DiscardNote(voice) }
                }
                voice.live?.let { live -> StripRow({ VoiceStatus(R.drawable.ic_mic, stringResource(R.string.voice_live_state, live), Modifier.clickable(onClickLabel = stringResource(R.string.voice_settings), onClick = openSettings)) }) {
                    TextButton(voice::stopLive) { Text(stringResource(R.string.voice_stop_live)) }
                } }
                if (speaker?.problem != null) SpeechProblem(speaker, voice)
                else if (speaker?.speaking == true) StripRow({ VoiceStatus(R.drawable.ic_volume, stringResource(R.string.voice_reading_reply)) }) {
                    TextButton(speaker::stop) { Text(stringResource(R.string.voice_stop_speaking)) }
                }
                voice.error?.let { VoiceFailure(it) { IconButton(voice::dismissError) { Icon(Icons.Default.Close, stringResource(R.string.conversation_dismiss_error)) } } }
            }
        }
    }
}

/** A status and what ends it: on one line where both fit, on two in a narrow window or with large text. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StripRow(status: @Composable () -> Unit, actions: @Composable RowScope.() -> Unit) {
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, itemVerticalAlignment = Alignment.CenterVertically) {
        status()
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.tight), content = actions)
    }
}

/** What is on. Its [time] is apart from the announced text, so a running one is not read out every second. */
@Composable
private fun VoiceStatus(icon: Int, text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurface, time: String? = null) {
    Row(modifier.heightIn(min = PALLayout.target), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        Icon(painterResource(icon), null, Modifier.size(PALLayout.iconMedium), tint = color)
        Text(text, Modifier.weight(1f, fill = false).semantics { liveRegion = LiveRegionMode.Polite }, color = color, style = MaterialTheme.typography.bodyMedium)
        time?.let { Text(it, color = color, style = MaterialTheme.typography.bodyMedium, maxLines = 1) }
    }
}

@Composable
private fun NoteStatus(voice: Voice) {
    if (voice.note == VoiceNote.Recording) VoiceStatus(R.drawable.ic_mic, stringResource(R.string.voice_microphone_on), color = MaterialTheme.colorScheme.error, time = "%d:%02d".format(voice.elapsed / 60, voice.elapsed % 60))
    else Row(Modifier.heightIn(min = PALLayout.target), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(PALLayout.small)) {
        CircularProgressIndicator(Modifier.size(PALLayout.iconSmall), strokeWidth = PALLayout.focusStroke)
        Text(stringResource(R.string.voice_transcribing_on_the_desktop), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun DiscardNote(voice: Voice) = IconButton(voice::discardNote) { Icon(Icons.Default.Close, stringResource(R.string.voice_discard_the_recording)) }

@Composable
private fun VoiceFailure(text: String, action: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = PALLayout.target), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        action()
    }
}

@Composable
private fun SpeechProblem(speaker: ReplySpeaker, voice: Voice) = VoiceFailure(speaker.problem.orEmpty()) { TextButton(voice::retrySpeech) { Text(stringResource(R.string.voice_retry_phone_speech)) } }
