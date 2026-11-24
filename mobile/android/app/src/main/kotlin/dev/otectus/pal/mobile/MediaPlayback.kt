package dev.otectus.pal.mobile

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.view.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File

/**
 * Plays one recording from a private file. It asks for audio focus and gives way to a call or another app, never plays
 * by itself, and deletes its file when it is released.
 */
internal class MediaPlayback(context: Context, private val file: File) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes).setOnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) pause()
    }.build()
    private var player: MediaPlayer? = null
    var ready by mutableStateOf(false); private set
    var playing by mutableStateOf(false); private set
    var position by mutableDoubleStateOf(0.0); private set
    var duration by mutableDoubleStateOf(0.0); private set
    var problem by mutableStateOf(false); private set
    var videoWidth by mutableIntStateOf(0); private set
    var videoHeight by mutableIntStateOf(0); private set
    /** Playing one part stops at its end. */
    private var stopAt = 0.0
    private var rate = 1f

    init {
        runCatching {
            player = MediaPlayer().apply {
                setAudioAttributes(attributes)
                setDataSource(file.absolutePath)
                setOnPreparedListener { this@MediaPlayback.duration = it.duration / 1000.0; this@MediaPlayback.videoWidth = it.videoWidth; this@MediaPlayback.videoHeight = it.videoHeight; ready = true }
                setOnVideoSizeChangedListener { _, width, height -> this@MediaPlayback.videoWidth = width; this@MediaPlayback.videoHeight = height }
                setOnCompletionListener { this@MediaPlayback.playing = false; audio.abandonAudioFocusRequest(focus); update() }
                setOnErrorListener { _, _, _ -> problem = true; ready = false; this@MediaPlayback.playing = false; true }
                prepareAsync()
            }
        }.onFailure { problem = true }
    }
    fun surface(value: Surface?) { runCatching { player?.setSurface(value) } }
    fun play() {
        val current = player ?: return
        if (!ready || audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return
        runCatching { current.start(); current.playbackParams = PlaybackParams().setSpeed(rate) }.onSuccess { playing = true }.onFailure { problem = true }
    }
    fun pause() { stopAt = 0.0; if (playing) runCatching { player?.pause() }; playing = false; audio.abandonAudioFocusRequest(focus); update() }
    fun toggle() { if (playing) pause() else play() }
    fun seek(seconds: Double) {
        if (!ready) return
        val target = seconds.coerceIn(0.0, duration)
        runCatching { player?.seekTo((target * 1000).toLong(), MediaPlayer.SEEK_CLOSEST) }
        position = target
    }
    fun playPart(start: Double, end: Double) { seek(start); play(); stopAt = end }
    fun speed(value: Float) { rate = value; if (playing) runCatching { player?.playbackParams = PlaybackParams().setSpeed(value) } }
    /** Called while the screen shows the player; a part that reached its end stops here. */
    fun update() {
        if (!ready) return
        runCatching { player?.currentPosition }.getOrNull()?.let { position = it / 1000.0 }
        if (stopAt > 0 && position >= stopAt) pause()
    }
    fun release() { pause(); runCatching { player?.release() }; player = null; ready = false; file.delete() }
}
