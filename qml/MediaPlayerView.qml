import QtQuick
import QtMultimedia
// Plays one kept recording. It is loaded only while a recording is open, so PAL works without Qt Multimedia; the
// Media pane then says what to install and still shows the transcript.
Item {
    id: view
    objectName: "mediaPlayer"
    property url source
    property bool video: false
    property real rate: 1
    property bool muted: false
    /** Playing one part stops at its end. */
    property real stopAt: 0
    readonly property real position: player.position / 1000
    readonly property real duration: player.duration / 1000
    readonly property bool playing: player.playbackState === MediaPlayer.PlayingState
    readonly property bool seekable: player.seekable
    readonly property bool loaded: player.mediaStatus !== MediaPlayer.NoMedia && player.mediaStatus !== MediaPlayer.LoadingMedia && player.mediaStatus !== MediaPlayer.InvalidMedia
    readonly property string problem: player.error === MediaPlayer.NoError ? "" : player.errorString || "This recording could not be played."
    property real pendingSeek: -1
    implicitHeight: video ? Math.min(width * 9 / 16, Theme.editorLarge) : 0
    function play() { player.play() }
    function pause() { stopAt = 0; player.pause() }
    function toggle() { if (playing) pause(); else play() }
    function seek(seconds) {
        const target = Math.max(0, seconds)
        if (loaded && duration > 0) player.position = Math.round(Math.min(target, duration) * 1000); else pendingSeek = target
    }
    function playPart(start, end) { seek(start); stopAt = end; play() }
    onPositionChanged: if (stopAt > 0 && position >= stopAt) pause()
    onLoadedChanged: if (loaded && pendingSeek >= 0) { const target = pendingSeek; pendingSeek = -1; Qt.callLater(() => view.seek(target)) }
    onSourceChanged: { stopAt = 0; pendingSeek = -1 }
    MediaPlayer {
        id: player
        source: view.source
        playbackRate: view.rate
        audioOutput: AudioOutput { muted: view.muted }
        videoOutput: view.video ? surface : null
    }
    VideoOutput { id: surface; anchors.fill: parent; visible: view.video; Accessible.role: Accessible.Graphic; Accessible.name: "Video" }
}
