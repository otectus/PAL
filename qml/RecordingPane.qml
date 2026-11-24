pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Recordings.js" as Recordings
// Workbench › Media: listen to a kept recording beside its time-coded transcript. Pick lines to play, ask about,
// correct or export. A correction is a new version and a clip is a new file; nothing here changes an original.
Item {
    id: pane
    objectName: "recordingPane"
    implicitHeight: layout.implicitHeight
    property string sessionId: ""
    property var items: []
    property bool canTranscribe: false
    property bool canClip: true
    property bool listed: false
    property var opened: null
    property var transcript: null
    property var cues: []
    property url source
    property string error: ""
    property string notice: ""
    property int selectedFrom: -1
    property int selectedTo: -1
    property var pending: null
    property real wanted: -1
    property int epoch: 0
    readonly property bool narrow: width < Theme.toolbarBreakpoint
    readonly property var player: surface.item
    readonly property bool playable: !!opened?.recording && !!player && !player.problem
    readonly property var session: App.session || ({})
    readonly property bool managed: ["local", "api"].includes((App.state.providerTraits || {})[session.provider || ""]?.kind)
    readonly property int artifactRevision: App.state.workbench?.artifactRevision || 0
    readonly property int current: playable ? Recordings.lineAt(cues, player.position) : -1
    readonly property bool hasSelection: selectedFrom >= 0 && selectedTo < cues.length
    readonly property var selectedCues: hasSelection ? cues.slice(selectedFrom, selectedTo + 1) : []
    readonly property real selectedStart: selectedCues.length ? selectedCues[0].start : 0
    readonly property real selectedEnd: selectedCues.length ? Math.max.apply(null, selectedCues.map(cue => cue.end)) : 0
    readonly property var found: Recordings.matches(cues, search.text)
    RpcClient { id: rpc; scope: pane.sessionId }
    function failed(value) { if (!value.error) return false; error = String(value.error.message || value.error); return true }
    function refresh() {
        if (!sessionId) return
        rpc.call("recordings.list", { sessionId: sessionId, project: true }, value => {
            if (pane.failed(value)) return
            items = value.items || []; canTranscribe = value.canTranscribe; canClip = value.canClip; listed = true
        })
    }
    function open(artifactId, versionId, transcriptId, seconds) {
        error = ""; notice = ""; wanted = seconds === undefined ? -1 : seconds
        const request = ++epoch
        rpc.call("recordings.open", Object.assign({ sessionId: sessionId, artifactId: artifactId }, versionId ? { versionId: versionId } : {}, transcriptId ? { transcriptId: transcriptId } : {}), value => {
            if (request !== epoch || pane.failed(value)) return
            const sameRecording = !!opened?.recording && opened.recording.versionId === value.recording?.versionId
            opened = value; transcript = value.transcript; clearSelection()
            cues = value.transcript?.cues || []
            if (value.transcript?.next !== undefined) more(request, value.transcript.next)
            if (!sameRecording) { source = ""; if (value.recording?.available) load(request) }
            else if (wanted >= 0) jump(wanted)
        })
    }
    // Long transcripts arrive in pages.
    function more(request, from) {
        rpc.call("recordings.cues", { sessionId: sessionId, artifactId: transcript.artifactId, versionId: transcript.versionId, from: from, limit: 1000 }, value => {
            if (request !== epoch || pane.failed(value)) return
            cues = cues.concat(value.cues)
            if (value.next !== undefined) more(request, value.next)
        })
    }
    function load(request) {
        rpc.call("artifacts.file", { sessionId: sessionId, artifactId: opened.recording.artifactId, versionId: opened.recording.versionId }, value => {
            if (request !== epoch || pane.failed(value)) return
            source = "file://" + value.path.split("/").map(part => encodeURIComponent(part)).join("/")
            if (wanted >= 0) Qt.callLater(() => pane.jump(wanted))
        })
    }
    function close() { if (player) player.pause(); epoch++; opened = null; transcript = null; cues = []; source = ""; error = ""; notice = ""; clearSelection() }
    function clearSelection() { selectedFrom = -1; selectedTo = -1 }
    function selectLine(index, extend) {
        if (extend && selectedFrom >= 0) { const from = Math.min(selectedFrom, index), to = Math.max(selectedTo, index); selectedFrom = index > selectedFrom ? selectedFrom : from; selectedTo = index > selectedFrom ? index : to }
        else if (selectedFrom === index && selectedTo === index) clearSelection()
        else { selectedFrom = index; selectedTo = index }
    }
    function jump(seconds) {
        wanted = -1
        const index = Recordings.lineAt(cues, seconds)
        if (index >= 0) { lines.positionViewAtIndex(index, ListView.Center); lines.currentIndex = index }
        if (playable) player.seek(seconds)
    }
    function playFrom(seconds) { if (!playable) return; player.stopAt = 0; player.seek(seconds); player.play() }
    function add() {
        const path = App.chooseFile()
        if (!path) return
        error = ""
        rpc.call("artifacts.import", { sessionId: sessionId, path: path }, value => {
            if (pane.failed(value)) return
            if (!/^(audio|video)\//.test(value.mime) && !/\.(vtt|srt)$/i.test(value.name)) { error = "PAL does not recognise " + value.name + " as a recording or a transcript. It was added to this conversation’s files."; return }
            refresh(); open(value.artifactId, value.versionId)
        })
    }
    // A long job is an operation: listed under background work, cancellable, and shown here until it ends.
    function follow(value, done) { pending = { id: value.operationId, label: value.label, state: value.state, done: done }; poll.restart() }
    function transcribe() { error = ""; rpc.call("recordings.transcribe", { sessionId: sessionId, artifactId: opened.recording.artifactId, versionId: opened.recording.versionId }, value => {
        if (pane.failed(value)) return
        const recording = opened.recording
        follow(value, () => { notice = "The transcript is ready."; if (opened?.recording?.versionId === recording.versionId) pane.open(recording.artifactId, recording.versionId) })
    }) }
    function ask() {
        const chosen = selectedCues, name = transcript.name.replace(/\.(vtt|srt)$/i, "")
        if (!managed) { WorkbenchState.insertIntoComposer(sessionId, Recordings.quote(chosen, name) + "\n\n"); notice = "The lines were added to your message."; return }
        rpc.call("references.pin", { sessionId: sessionId, ref: { kind: "artifact", artifactId: transcript.artifactId, versionId: transcript.versionId, span: { start: selectedStart, end: Math.max(selectedEnd, selectedStart + 0.1) } } }, value => {
            if (pane.failed(value)) return
            const list = WorkbenchState.referencesFor(sessionId).slice()
            if (list.length >= 8) { error = "Remove a reference from your message first. A message holds up to eight."; return }
            list.push(value); WorkbenchState.setReferences(sessionId, list)
            notice = "Added to your message. Ask your question in the chat."
        })
    }
    Timer {
        id: poll; interval: 700; repeat: true; running: !!pane.pending
        onTriggered: rpc.call("operations.get", { id: pane.pending.id }, value => {
            if (!pane.pending) return
            if (value.error) { pane.failed(value); pane.pending = null; return }
            if (["queued", "running", "cancel_requested"].includes(value.state)) return
            const entry = pane.pending; pane.pending = null
            if (value.state === "completed") entry.done(value); else pane.error = value.state === "cancelled" ? "Cancelled." : String(value.error?.message || value.recovery || "That did not finish.")
            pane.refresh()
        })
    }
    Connections {
        target: WorkbenchState
        function onRecordingTargetChanged() { pane.takeTarget() }
        function onTabChanged() { if (WorkbenchState.tab !== "recordings" && pane.player) pane.player.pause() }
    }
    function takeTarget() { const target = WorkbenchState.takeRecording(sessionId); if (target) open(target.artifactId, target.versionId, target.transcriptId, target.seconds) }
    onArtifactRevisionChanged: if (listed) refresh()
    // PAL never plays over a microphone recording, and stops when its pane or conversation is gone.
    readonly property bool microphone: App.state.transcription?.state === "recording"
    onMicrophoneChanged: if (microphone && player) player.pause()
    onVisibleChanged: if (!visible && player) player.pause()
    onSessionIdChanged: { close(); pending = null; items = []; listed = false; refresh(); takeTarget() }
    Component.onCompleted: { refresh(); takeTarget() }
    DocumentTools { id: documentTools; sessionId: pane.sessionId; onRefreshRequested: pane.refresh(); onDone: message => pane.notice = message }

    ColumnLayout {
        id: layout
        anchors.fill: parent; spacing: Theme.space2
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "recordingBack"; visible: !!pane.opened; text: "Recordings"; iconName: "back"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: { pane.close(); Qt.callLater(() => list.forceActiveFocus()) } }
            CText { objectName: "recordingTitle"; Layout.fillWidth: true; text: pane.opened ? (pane.opened.recording?.name || pane.transcript?.name || "") : "Recordings"; font.weight: Font.DemiBold; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
            CButton { objectName: "recordingAdd"; visible: !pane.opened; text: "Add…"; iconName: "plus"; help: "Keep an audio or video file, or a subtitle file, with this conversation"; implicitHeight: Theme.compactHeight; enabled: !rpc.busy; onClicked: pane.add() }
            CButton { objectName: "recordingMore"; visible: !!pane.opened; iconName: "more"; quiet: true; implicitHeight: Theme.compactHeight; help: "More for these files"; Accessible.name: "More"; onClicked: more.popup() }
        }
        CMenu {
            id: more
            CMenuItem { visible: !!pane.transcript; text: "Subtitles…"; onTriggered: subtitles.show(false) }
            CMenuItem { visible: !!pane.transcript; text: "Translate or file the transcript…"; onTriggered: documentTools.openMenu({ artifactId: pane.transcript.artifactId, versionId: pane.transcript.versionId, name: pane.transcript.name, mime: "text/vtt", kind: "text" }) }
            CMenuItem { visible: !!pane.opened?.recording; text: "Save a copy of the recording…"; onTriggered: { const path = App.chooseSavePath(pane.opened.recording.name); if (path) rpc.call("artifacts.saveAs", { sessionId: pane.sessionId, artifactId: pane.opened.recording.artifactId, versionId: pane.opened.recording.versionId, path: path, replace: true }, value => { if (!pane.failed(value)) pane.notice = "Saved a copy." }) } }
            CMenuItem { visible: !!pane.opened?.recording && pane.canTranscribe && !!pane.transcript; text: "Transcribe again"; enabled: !pane.pending; onTriggered: pane.transcribe() }
        }
        CText { objectName: "recordingError"; visible: !!pane.error; text: pane.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { objectName: "recordingNotice"; visible: !!pane.notice && !pane.error; text: pane.notice; color: Theme.muted; font.pixelSize: Theme.secondary; Accessible.role: Accessible.StatusBar }
        RowLayout {
            visible: !!pane.pending; Layout.fillWidth: true; spacing: Theme.space2
            CText { objectName: "recordingPending"; Layout.fillWidth: true; text: pane.pending ? pane.pending.label + "…" : ""; color: Theme.accentText; font.pixelSize: Theme.secondary; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
            CButton { text: "Cancel"; danger: true; implicitHeight: Theme.compactHeight; onClicked: rpc.call("operations.cancel", { id: pane.pending.id }, value => pane.failed(value)) }
        }

        // ── The list ─────────────────────────────────────────────────────────────────────────────
        CText { objectName: "recordingEmpty"; visible: !pane.opened && pane.listed && !pane.items.length; color: Theme.muted
            text: "Recordings you keep with this conversation appear here, with transcripts you can search, correct and ask about. Add one, or choose Keep the recording after transcribing a file." }
        ListView {
            id: list; objectName: "recordingList"
            visible: !pane.opened && count > 0
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorMedium; clip: true; spacing: Theme.space1; activeFocusOnTab: true; keyNavigationEnabled: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            model: pane.items
            Keys.onReturnPressed: if (currentIndex >= 0) pane.open(pane.items[currentIndex].artifactId, pane.items[currentIndex].versionId)
            delegate: ItemDelegate {
                id: row
                required property var modelData
                required property int index
                objectName: "recordingRow_" + index
                width: list.width - Theme.space3; padding: Theme.space2
                Accessible.name: modelData.name
                Accessible.description: detail.text
                onClicked: pane.open(modelData.artifactId, modelData.versionId)
                background: Rectangle { radius: Theme.radiusControl; color: row.hovered || list.activeFocus && list.currentIndex === row.index ? Theme.raised : Theme.surface; border.color: list.activeFocus && list.currentIndex === row.index ? Theme.focus : Theme.subtle; border.width: Theme.hairline }
                contentItem: RowLayout {
                    spacing: Theme.space2
                    CIcon { name: row.modelData.kind === "transcript" ? "file" : row.modelData.video ? "desktop" : "microphone" }
                    ColumnLayout {
                        Layout.fillWidth: true; spacing: 0
                        CText { Layout.fillWidth: true; text: row.modelData.name; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                        CText { id: detail; Layout.fillWidth: true; color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap
                            text: (row.modelData.kind === "transcript" ? "Transcript only" : (row.modelData.video ? "Video" : "Audio") + (row.modelData.transcripts ? " · transcribed" : " · no transcript")) + " · " + new Date(row.modelData.created).toLocaleDateString(Qt.locale(), Locale.ShortFormat) + (row.modelData.shared ? " · shared with this project" : "") }
                    }
                }
            }
        }
        Item { visible: !pane.opened && !pane.items.length; Layout.fillHeight: true }

        // ── The player ───────────────────────────────────────────────────────────────────────────
        Loader {
            id: surface; objectName: "recordingSurface"
            active: !!pane.opened?.recording?.available
            visible: status === Loader.Ready && pane.opened?.recording?.video === true
            Layout.fillWidth: true; Layout.preferredHeight: item ? item.implicitHeight : 0
            source: active ? "MediaPlayerView.qml" : ""
            Binding { target: surface.item; property: "source"; value: pane.source; when: !!surface.item }
            Binding { target: surface.item; property: "video"; value: pane.opened?.recording?.video === true; when: !!surface.item }
        }
        CText { objectName: "recordingNoPlayer"; visible: !!pane.opened?.recording && surface.status === Loader.Error; color: Theme.amber; font.pixelSize: Theme.secondary
            text: "Playing recordings here needs Qt Multimedia. Install the qt6-multimedia and qt6-multimedia-ffmpeg packages and restart PAL. The transcript works without it." }
        CText { visible: !!pane.opened?.recording && !pane.opened.recording.available; text: "The stored recording is missing."; color: Theme.danger; font.pixelSize: Theme.secondary }
        CText { objectName: "recordingProblem"; visible: !!pane.player?.problem; text: pane.player?.problem || ""; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { objectName: "recordingNotKept"; visible: !!pane.opened && !pane.opened.recording; text: "The recording of this transcript was not kept, so there is nothing to play."; color: Theme.muted; font.pixelSize: Theme.secondary }
        GridLayout {
            id: controls; objectName: "recordingControls"
            visible: pane.playable; Layout.fillWidth: true; columns: pane.narrow ? 1 : 2; columnSpacing: Theme.space2; rowSpacing: 0
            RowLayout {
                spacing: Theme.space1
                CButton { objectName: "recordingPlay"; iconName: pane.player?.playing ? "pause" : "play"; primary: true; help: pane.player?.playing ? "Pause (Space)" : "Play (Space)"; Accessible.name: pane.player?.playing ? "Pause" : "Play"; enabled: !!pane.player?.loaded && !pane.microphone; onClicked: pane.player.toggle() }
                CButton { text: "−10"; quiet: true; help: "Back 10 seconds"; Accessible.name: "Back 10 seconds"; onClicked: pane.player.seek(pane.player.position - 10) }
                CButton { text: "+10"; quiet: true; help: "Forward 10 seconds"; Accessible.name: "Forward 10 seconds"; onClicked: pane.player.seek(pane.player.position + 10) }
                CComboBox { objectName: "recordingRate"; Layout.preferredWidth: Theme.fieldTiny; model: ["0.75×", "1×", "1.25×", "1.5×", "2×"]; currentIndex: 1; Accessible.name: "Speed"; onActivated: pane.player.rate = [0.75, 1, 1.25, 1.5, 2][currentIndex] }
                CButton { iconName: pane.player?.muted ? "muted" : "speaker"; quiet: true; checkable: true; checked: pane.player?.muted === true; help: checked ? "Sound is off" : "Sound is on"; Accessible.name: "Mute"; onClicked: pane.player.muted = !pane.player.muted }
            }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space2
                CSlider { id: position; objectName: "recordingPosition"; Layout.fillWidth: true; from: 0; to: Math.max(0.1, pane.player?.duration || 0.1); value: pane.player?.position || 0; live: false
                    Accessible.name: "Position"; Accessible.description: positionText.text
                    Binding on value { when: !position.pressed; value: pane.player?.position || 0 }
                    onMoved: pane.player.seek(position.position * position.to) }
                CText { id: positionText; objectName: "recordingClock"; text: Recordings.clock(pane.player?.position || 0) + " / " + Recordings.clock(pane.player?.duration || 0); color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.NoWrap }
            }
        }
        CText { visible: pane.microphone && pane.playable; text: "Paused while the microphone is recording."; color: Theme.amber; font.pixelSize: Theme.caption }

        // ── The transcript ───────────────────────────────────────────────────────────────────────
        RowLayout {
            visible: !!pane.opened?.recording && !pane.transcript; Layout.fillWidth: true; spacing: Theme.space2
            CText { Layout.fillWidth: true; color: Theme.muted; text: pane.canTranscribe ? "No transcript yet." : "No transcript yet. Set up transcription in Settings › Voice, or add a subtitle file." }
            CButton { objectName: "recordingTranscribe"; visible: pane.canTranscribe; text: "Transcribe"; primary: true; enabled: !pane.pending && !rpc.busy; onClicked: pane.transcribe() }
        }
        GridLayout {
            visible: !!pane.transcript; Layout.fillWidth: true; columns: pane.narrow ? 1 : 2; columnSpacing: Theme.space2; rowSpacing: Theme.space1
            CComboBox {
                objectName: "recordingTranscripts"; visible: (pane.opened?.transcripts || []).length > 1; Layout.fillWidth: pane.narrow; Layout.preferredWidth: Theme.pickerWidth; Accessible.name: "Transcript"
                model: (pane.opened?.transcripts || []).map(entry => entry.language ? entry.language : entry.name)
                currentIndex: (pane.opened?.transcripts || []).findIndex(entry => entry.artifactId === pane.transcript?.artifactId)
                onActivated: index => { const anchor = pane.opened.recording || { artifactId: pane.opened.transcripts[index].artifactId }; pane.open(anchor.artifactId, anchor.versionId, pane.opened.transcripts[index].artifactId, pane.player?.position) }
            }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space1
                CField { id: search; objectName: "recordingSearch"; Layout.fillWidth: true; placeholderText: "Search the transcript"; Accessible.name: "Search the transcript"
                    property int at: -1
                    Connections { target: pane; function onFoundChanged() { search.at = -1; if (pane.found.length) search.step(1) } }
                    function step(by) { if (!pane.found.length) return; at = (at + by + pane.found.length) % pane.found.length; lines.currentIndex = pane.found[at]; lines.positionViewAtIndex(pane.found[at], ListView.Center) }
                    Keys.onReturnPressed: event => step(event.modifiers & Qt.ShiftModifier ? -1 : 1) }
                CText { objectName: "recordingMatches"; visible: search.text.length > 0; text: pane.found.length ? (search.at + 1) + " of " + pane.found.length : "No match"; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.NoWrap }
            }
        }
        CText { visible: pane.transcript?.truncated === true; text: "Only the first hour was transcribed."; color: Theme.amber; font.pixelSize: Theme.caption }
        CText { visible: pane.transcript?.latest === false; text: "This is an earlier version of the transcript."; color: Theme.amber; font.pixelSize: Theme.caption }
        ListView {
            id: lines; objectName: "recordingLines"
            visible: !!pane.transcript
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorMedium; clip: true; activeFocusOnTab: true; keyNavigationEnabled: false
            boundsBehavior: Flickable.StopAtBounds; reuseItems: true
            ScrollBar.vertical: CScrollBar {}
            model: pane.cues
            Accessible.role: Accessible.List; Accessible.name: "Transcript"
            // The line being said stays in view while it plays, unless the person is reading elsewhere.
            property bool following: true
            onMovementStarted: following = false
            Connections { target: pane; function onCurrentChanged() { if (pane.current >= 0 && lines.following && pane.player?.playing) lines.positionViewAtIndex(pane.current, ListView.Contain) } }
            Keys.onPressed: event => {
                const step = event.key === Qt.Key_Down ? 1 : event.key === Qt.Key_Up ? -1 : 0
                if (step) {
                    const next = Math.max(0, Math.min(count - 1, currentIndex + step))
                    if (event.modifiers & Qt.ShiftModifier) { if (pane.selectedFrom < 0) pane.selectLine(Math.max(0, currentIndex), false); pane.selectLine(next, true) }
                    currentIndex = next; positionViewAtIndex(next, ListView.Contain)
                } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { if (currentIndex >= 0) pane.playFrom(pane.cues[currentIndex].start) }
                else if (event.key === Qt.Key_Space) { if (pane.playable) pane.player.toggle() }
                else if (event.key === Qt.Key_Escape && pane.hasSelection) pane.clearSelection()
                else return
                event.accepted = true
            }
            delegate: Rectangle {
                id: line
                required property var modelData
                required property int index
                readonly property bool said: index === pane.current
                readonly property bool chosen: pane.selectedFrom >= 0 && index >= pane.selectedFrom && index <= pane.selectedTo
                objectName: "recordingLine_" + index
                width: lines.width - Theme.space3; implicitHeight: Math.max(Theme.compactHeight, text.implicitHeight + Theme.space2); height: implicitHeight; radius: Theme.radiusChip
                color: chosen ? Theme.selected : said ? Theme.raised : "transparent"
                border.width: lines.activeFocus && lines.currentIndex === index ? Theme.focusWidth : 0; border.color: Theme.focus
                Accessible.role: Accessible.ListItem; Accessible.name: Recordings.clock(modelData.start) + " " + text.text; Accessible.selected: chosen; Accessible.selectable: true
                // Text selects; the time plays from there.
                MouseArea { anchors.fill: parent; onClicked: mouse => { lines.forceActiveFocus(); lines.currentIndex = line.index; pane.selectLine(line.index, !!(mouse.modifiers & Qt.ShiftModifier)) } }
                RowLayout {
                    anchors.fill: parent; anchors.leftMargin: Theme.space1; anchors.rightMargin: Theme.space1; spacing: Theme.space2
                    CButton { objectName: "recordingTime_" + line.index; Layout.alignment: Qt.AlignTop; text: Recordings.clock(line.modelData.start); quiet: true; implicitHeight: Theme.minimumTarget + Theme.space1; leftPadding: Theme.space1; rightPadding: Theme.space1; enabled: pane.playable; help: "Play from here"; focusPolicy: Qt.NoFocus; onClicked: { lines.following = true; pane.playFrom(line.modelData.start) } }
                    CText { id: text; Layout.fillWidth: true; Layout.alignment: Qt.AlignVCenter; text: (line.modelData.speaker ? line.modelData.speaker + ": " : "") + line.modelData.text; textFormat: Text.PlainText; wrapMode: Text.Wrap; font.weight: line.said ? Font.DemiBold : Font.Normal }
                }
            }
        }
        Item { visible: !!pane.opened && !pane.transcript; Layout.fillHeight: true }
        Rectangle {
            objectName: "recordingSelection"
            visible: pane.hasSelection; Layout.fillWidth: true; implicitHeight: actions.implicitHeight + Theme.space2 * 2; color: Theme.surface; radius: Theme.radiusControl; border.color: Theme.subtle; border.width: Theme.hairline
            ColumnLayout {
                id: actions
                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: Theme.space2; spacing: Theme.space1
                CText { objectName: "recordingRange"; text: Recordings.range(pane.selectedStart, pane.selectedEnd) + " · " + (pane.selectedCues.length === 1 ? "1 line" : pane.selectedCues.length + " lines") + (pane.selectedCues.length === 1 ? ". Shift-click another line to select up to it." : ""); color: Theme.muted; font.pixelSize: Theme.caption }
                Flow {
                    Layout.fillWidth: true; spacing: Theme.space1
                    CButton { objectName: "recordingPlayPart"; text: "Play"; visible: pane.playable; implicitHeight: Theme.compactHeight; onClicked: pane.player.playPart(pane.selectedStart, pane.selectedEnd) }
                    CButton { objectName: "recordingAsk"; text: "Ask about this"; primary: true; implicitHeight: Theme.compactHeight; onClicked: pane.ask() }
                    CButton { text: "Copy"; implicitHeight: Theme.compactHeight; onClicked: { App.copy(Recordings.quote(pane.selectedCues, "").replace(/^> /gm, "")); pane.notice = "Copied." } }
                    CButton { objectName: "recordingCorrect"; text: "Correct…"; visible: pane.transcript?.latest === true; enabled: pane.selectedCues.length <= 20; help: enabled ? "" : "Correct up to 20 lines at a time"; implicitHeight: Theme.compactHeight; onClicked: correction.show() }
                    CButton { objectName: "recordingClip"; text: "Make a clip…"; visible: !!pane.opened?.recording; enabled: pane.canClip && !pane.pending; help: pane.canClip ? "" : "Install ffmpeg to make clips"; implicitHeight: Theme.compactHeight; onClicked: clip.show() }
                    CButton { text: "Subtitles…"; implicitHeight: Theme.compactHeight; onClicked: subtitles.show(true) }
                    CButton { text: "Clear"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: pane.clearSelection() }
                }
            }
        }
    }

    CDialog {
        id: correction; objectName: "recordingCorrection"
        preferredWidth: Theme.dialogWide
        property var drafts: []
        property int base: 0
        property string problem: ""
        function show() { base = pane.selectedFrom; drafts = pane.selectedCues.map(cue => ({ index: cue.index, start: cue.start, text: cue.text, original: cue.text })); problem = ""; open() }
        readonly property bool changed: drafts.some(row => row.text !== row.original)
        function save() {
            problem = ""
            rpc.call("recordings.correct", { sessionId: pane.sessionId, artifactId: pane.transcript.artifactId, versionId: pane.transcript.versionId, edits: drafts.filter(row => row.text !== row.original).map(row => ({ index: row.index, text: row.text })) }, value => {
                if (value.error) { problem = String(value.error.message || value.error); return }
                correction.close(); pane.transcript = value; pane.cues = value.cues; pane.clearSelection(); pane.notice = "Saved as a new version of the transcript."
                if (value.next !== undefined) pane.more(pane.epoch, value.next)
            })
        }
        CText { text: "Correct the transcript"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: "Times stay as they are. Emptying a line removes it. The earlier version is kept."; color: Theme.muted; font.pixelSize: Theme.secondary }
        Repeater {
            model: correction.drafts.length
            RowLayout {
                id: entry
                required property int index
                readonly property var draft: correction.drafts[index] || ({ start: 0, text: "" })
                Layout.fillWidth: true; spacing: Theme.space2
                CText { Layout.alignment: Qt.AlignTop; Layout.topMargin: Theme.space2; Layout.fillWidth: false; Layout.preferredWidth: Theme.lineNumberWidth; text: Recordings.clock(entry.draft.start); color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.NoWrap }
                CTextArea { objectName: "correctionText_" + entry.index; Layout.fillWidth: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; Accessible.name: "Line at " + Recordings.clock(entry.draft.start)
                    Component.onCompleted: text = entry.draft.text
                    onTextChanged: { const next = correction.drafts.slice(); if (!next[entry.index] || next[entry.index].text === text) return; next[entry.index] = Object.assign({}, next[entry.index], { text: text }); correction.drafts = next } }
            }
        }
        CText { visible: !!correction.problem; text: correction.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: correction.close() }
            CButton { objectName: "correctionSave"; text: "Save corrections"; primary: true; Layout.fillWidth: true; enabled: correction.changed && !rpc.busy; onClicked: correction.save() }
        }
    }
    CDialog {
        id: clip; objectName: "recordingClipDialog"
        property string problem: ""
        readonly property var start: Recordings.seconds(clipStart.text)
        readonly property var end: Recordings.seconds(clipEnd.text)
        readonly property bool valid: start !== undefined && end !== undefined && end > start && end - start <= 900
        function show() { problem = ""; clipStart.text = Recordings.clock(pane.selectedStart); clipEnd.text = Recordings.clock(Math.ceil(pane.selectedEnd)); open() }
        CText { text: "Make a clip"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: "The part becomes a new file of this conversation. The recording stays as it is, and place or device details in it are not copied."; color: Theme.muted; font.pixelSize: Theme.secondary }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            ColumnLayout { Layout.fillWidth: true; spacing: Theme.space1; CText { text: "From"; color: Theme.muted; font.pixelSize: Theme.caption } CField { id: clipStart; objectName: "clipStart"; Layout.fillWidth: true; Accessible.name: "From" } }
            ColumnLayout { Layout.fillWidth: true; spacing: Theme.space1; CText { text: "To"; color: Theme.muted; font.pixelSize: Theme.caption } CField { id: clipEnd; objectName: "clipEnd"; Layout.fillWidth: true; Accessible.name: "To" } }
        }
        CText { visible: !clip.valid; text: "Use times such as 1:30 or 1:02:03, up to 15 minutes apart."; color: Theme.amber; font.pixelSize: Theme.secondary }
        CCheckBox { id: clipText; objectName: "clipTranscript"; visible: !!pane.transcript; text: "Include its part of the transcript"; checked: true }
        CText { visible: !!clip.problem; text: clip.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: clip.close() }
            CButton { objectName: "clipMake"; text: "Make the clip"; primary: true; Layout.fillWidth: true; enabled: clip.valid && !rpc.busy && !pane.pending
                onClicked: {
                    clip.problem = ""
                    rpc.call("recordings.clip", Object.assign({ sessionId: pane.sessionId, artifactId: pane.opened.recording.artifactId, versionId: pane.opened.recording.versionId, start: clip.start, end: clip.end }, clipText.checked && pane.transcript ? { transcript: { artifactId: pane.transcript.artifactId, versionId: pane.transcript.versionId } } : {}), value => {
                        if (value.error) { clip.problem = String(value.error.message || value.error); return }
                        clip.close()
                        pane.follow(value, done => { pane.notice = "The clip is ready. Choose Recordings to open it." + (done.details?.method === "keyframe" ? " It starts at the nearest earlier key frame." : "") })
                    })
                }
            }
        }
    }
    CDialog {
        id: subtitles; objectName: "recordingSubtitles"
        property bool part: false
        property string problem: ""
        function show(selectedOnly) { part = selectedOnly; problem = ""; open() }
        CText { text: "Subtitles"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: subtitles.part ? "For " + Recordings.range(pane.selectedStart, pane.selectedEnd) + "." : "For the whole recording."; color: Theme.muted; font.pixelSize: Theme.secondary }
        CComboBox { id: subtitleFormat; objectName: "subtitleFormat"; Layout.fillWidth: true; model: ["SubRip (.srt)", "WebVTT (.vtt)"]; Accessible.name: "Format" }
        CCheckBox { id: subtitleZero; visible: subtitles.part; text: "Start times at zero, to go with a clip"; checked: false }
        CText { visible: !!subtitles.problem; text: subtitles.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: subtitles.close() }
            CButton { objectName: "subtitleMake"; text: "Make the file"; primary: true; Layout.fillWidth: true; enabled: !rpc.busy
                onClicked: {
                    subtitles.problem = ""
                    rpc.call("recordings.subtitles", Object.assign({ sessionId: pane.sessionId, artifactId: pane.transcript.artifactId, versionId: pane.transcript.versionId, format: subtitleFormat.currentIndex === 0 ? "srt" : "vtt" }, subtitles.part ? { start: pane.selectedStart, end: Math.max(pane.selectedEnd, pane.selectedStart + 0.1), fromZero: subtitleZero.checked } : {}), value => {
                        if (value.error) { subtitles.problem = String(value.error.message || value.error); return }
                        subtitles.close()
                        const path = App.chooseSavePath(value.name)
                        if (!path) { pane.notice = value.name + " was added to this conversation’s files."; return }
                        rpc.call("artifacts.saveAs", { sessionId: pane.sessionId, artifactId: value.artifactId, versionId: value.versionId, path: path, replace: true }, saved => { if (!pane.failed(saved)) pane.notice = "Saved " + value.name + "." })
                    })
                }
            }
        }
    }
}
