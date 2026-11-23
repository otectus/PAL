import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Terminal: a real terminal on this computer (broker/terminal/service.ts). The broker keeps the shell,
// its screen and the control lease, so an owner phone sees and can continue the same terminal. Watching never
// takes control; typing does, and taking control from a phone is an explicit choice. Closing this pane only stops
// watching: the shell keeps running until Stop terminal.
Item {
    id: term
    objectName: "terminalPane"
    implicitHeight: content.implicitHeight
    property string sessionId: ""
    // Supplied by Workbench; injectable so terminal response ordering is regression-testable.
    property var app: null
    property var profiles: ({})
    property var terminals: []
    property string terminalId: ""
    property var current: null
    property int rows: 0
    property int cols: 0
    property var cursor: [0, 0, 0]
    property int revision: -1
    property var lease: null
    property int sequence: 0
    // Every selection gets its own callback scope. A snapshot or create reply from a terminal the
    // user has since left must never replace the screen now being viewed.
    property int selectionRevision: 0
    property string error: ""
    property string notice: ""
    property bool showHistory: false
    property string historyText: ""
    signal leaveRequested()
    readonly property bool running: !!current && (current.state === "running" || current.state === "starting")
    readonly property bool controlling: !!lease && !!current && !!current.controller && current.controller.kind === "local" && Number(current.controller.revision) === Number(lease.controllerRevision)
    readonly property bool phoneControls: !!current && !!current.controller && current.controller.kind === "device"
    readonly property var session: term.app?.session || ({})
    RpcClient { id: rpc; endpoint: term.app; scope: term.sessionId + ":" + term.terminalId + ":" + term.selectionRevision }
    ListModel { id: screenModel }
    TextMetrics { id: cell; font.family: Theme.mono; font.pixelSize: Theme.secondary; text: "MMMMMMMMMM" }
    readonly property real cellWidth: Math.max(4, cell.advanceWidth / 10)
    readonly property real cellHeight: Math.ceil(cell.height * 1.15)

    // ANSI colours are the program's content, computed here rather than written as interface literals.
    readonly property var ansi: [[0,0,0],[205,49,49],[13,188,121],[229,229,16],[36,114,200],[188,63,188],[17,168,205],[229,229,229],[102,102,102],[241,76,76],[35,209,139],[245,245,67],[59,142,234],[214,112,214],[41,184,219],[255,255,255]]
    function colour(value, foreground) {
        if (value < 0) return foreground ? Theme.text : Theme.codeSurface
        if (value >= 0x1000000) { const rgb = value & 0xffffff; return Qt.rgba(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, 1) }
        if (value < 16) { const c = ansi[value]; return Qt.rgba(c[0] / 255, c[1] / 255, c[2] / 255, 1) }
        if (value < 232) { const v = value - 16, level = n => n ? (55 + n * 40) / 255 : 0; return Qt.rgba(level(Math.floor(v / 36)), level(Math.floor(v / 6) % 6), level(v % 6), 1) }
        const grey = (8 + (value - 232) * 10) / 255; return Qt.rgba(grey, grey, grey, 1)
    }
    function stateLabel(state) { return ({ starting: "Starting", running: "Running", stopping: "Stopping", exited: "Ended", interrupted: "Interrupted by a PAL restart", unknown: "Outcome unknown" })[state] || state }

    function refresh() {
        rpc.call("terminal.profiles", {}, value => { if (!value.error) { term.profiles = value; if (!shellBox.chosen) shellBox.currentIndex = Math.max(0, (value.shells || []).findIndex(s => s.id === value.default)) } })
        rpc.call("terminal.list", {}, value => { if (value.error) return; term.terminals = value; if (!term.terminalId && value.length) term.open(value[0].id) })
    }
    function applySnapshot(value) {
        if (value.error) { error = value.error; return }
        current = value.terminal
        const screen = value.screen
        rows = screen.rows; cols = screen.cols; cursor = screen.cursor; revision = screen.revision
        screenModel.clear()
        for (let r = 0; r < screen.rows; ++r) screenModel.append({ runs: JSON.stringify(screen.lines[r] || []) })
    }
    function open(id) {
        terminalId = id; selectionRevision += 1; lease = null; sequence = 0; error = ""; notice = ""; showHistory = false
        const selected = id
        rpc.call("terminal.snapshot", { terminalId: selected }, value => {
            if (term.terminalId !== selected) return
            applySnapshot(value)
        })
    }
    function create() {
        const shell = (profiles.shells || [])[shellBox.currentIndex]
        const owner = sessionId, selection = selectionRevision
        rpc.call("terminal.create", { shell: shell ? shell.id : "default", sessionId: owner, rows: Math.max(8, Math.floor(screenArea.height / cellHeight)), cols: Math.max(20, Math.floor(screenArea.width / cellWidth)) }, value => {
            if (value.error) { error = value.error; return }
            // Creating a shell is durable, but it does not steal the view after the user has
            // selected a different terminal or conversation while the broker was busy.
            if (term.sessionId !== owner || term.selectionRevision !== selection) { refresh(); return }
            terminalId = value.terminal.id; lease = value.lease; sequence = value.lease.lastSequence
            applySnapshot(value); refresh(); keys.forceActiveFocus()
        })
    }
    function takeControl(then) {
        if (!current || !running) return
        rpc.call("terminal.acquireControl", { terminalId: terminalId, expectedControllerRevision: current.controllerRevision, rows: Math.max(4, Math.floor(screenArea.height / cellHeight)), cols: Math.max(10, Math.floor(screenArea.width / cellWidth)) }, value => {
            if (value.error) { error = value.error; return }
            current = value.terminal; lease = value.lease; sequence = value.lease.lastSequence; error = ""
            if (then) then()
        })
    }
    function send(events) {
        if (!running) return
        if (!controlling) { if (phoneControls) { notice = "A phone is typing in this terminal. Take control to type here."; return } takeControl(() => send(events)); return }
        sequence += 1
        rpc.call("terminal.input", { terminalId: terminalId, leaseId: lease.leaseId, epoch: lease.epoch, sequence: sequence, events: events }, value => {
            if (value.error) {
                // A lost lease or a gap: ask what was accepted rather than resending anything.
                rpc.call("terminal.inputStatus", { terminalId: terminalId, leaseId: lease ? lease.leaseId : "", epoch: lease ? lease.epoch : 0 }, status => {
                    if (status.current) sequence = status.lastSequence; else { lease = null; notice = "Control moved elsewhere. Nothing you typed was sent twice." }
                })
            }
        })
    }
    function keyEvent(event) {
        const mods = (event.modifiers & Qt.ShiftModifier ? 1 : 0) | (event.modifiers & Qt.AltModifier ? 2 : 0) | (event.modifiers & Qt.ControlModifier ? 4 : 0)
        const named = {}
        named[Qt.Key_Return] = "enter"; named[Qt.Key_Enter] = "enter"; named[Qt.Key_Tab] = "tab"; named[Qt.Key_Backtab] = "tab"; named[Qt.Key_Backspace] = "backspace"; named[Qt.Key_Escape] = "escape"
        named[Qt.Key_Up] = "up"; named[Qt.Key_Down] = "down"; named[Qt.Key_Left] = "left"; named[Qt.Key_Right] = "right"; named[Qt.Key_Insert] = "insert"; named[Qt.Key_Delete] = "delete"
        named[Qt.Key_Home] = "home"; named[Qt.Key_End] = "end"; named[Qt.Key_PageUp] = "pageup"; named[Qt.Key_PageDown] = "pagedown"
        for (let n = 1; n <= 12; ++n) named[Qt.Key_F1 + n - 1] = "f" + n
        if ((mods & 5) === 5 && event.key === Qt.Key_V) { const text = term.app ? term.app.clipboardText() : ""; return text ? { paste: text.slice(0, 65536) } : null }
        if (named[event.key]) return { key: named[event.key], mods: event.key === Qt.Key_Backtab ? (mods | 1) : mods }
        if (mods & 6) {
            const base = event.key >= Qt.Key_A && event.key <= Qt.Key_Z ? 97 + event.key - Qt.Key_A : event.text ? event.text.toLowerCase().codePointAt(0) : 0
            if (base && base >= 32) return { char: base, mods: mods & 6 }
        }
        return event.text ? { text: event.text } : null
    }
    function resizeToFit() {
        if (!controlling || !running) return
        const r = Math.max(4, Math.min(300, Math.floor(screenArea.height / cellHeight))), c = Math.max(10, Math.min(500, Math.floor(screenArea.width / cellWidth)))
        if (r !== rows || c !== cols) rpc.call("terminal.resize", { terminalId: terminalId, leaseId: lease.leaseId, rows: r, cols: c }, () => {})
    }
    function loadHistory() {
        rpc.call("terminal.history", { terminalId: terminalId, limit: 1000 }, value => {
            if (value.error) { error = value.error; return }
            const text = line => line.map(run => run[1]).join("")
            const screen = []; for (let r = 0; r < screenModel.count; ++r) screen.push(text(JSON.parse(screenModel.get(r).runs)))
            historyText = (value.dropped ? "[" + value.dropped + " lines were not kept]\n" : "") + value.lines.map(text).join("\n") + (value.lines.length ? "\n" : "") + screen.join("\n").replace(/\s+$/, "")
        })
    }
    Timer { id: resizeTimer; interval: 150; onTriggered: term.resizeToFit() }
    Shortcut { sequence:"Ctrl+Shift+F6";context:Qt.ApplicationShortcut;enabled:term.visible;onActivated:term.leaveRequested() }
    Component.onCompleted: refresh()
    onVisibleChanged: if (visible) refresh()
    Connections {
        target: term.app
        function onTerminalEvent(event) {
            if (event.kind === "resync") { if (term.terminalId) term.open(term.terminalId); return }
            if (event.kind === "state" || event.kind === "removed") {
                if (event.kind === "removed") term.terminals = term.terminals.filter(t => t.id !== event.terminalId)
                else { const list = term.terminals.filter(t => t.id !== event.terminalId); list.unshift(event.terminal); term.terminals = list.sort((a, b) => b.created - a.created) }
                if (event.terminalId === term.terminalId && event.terminal) term.current = event.terminal
                return
            }
            if (event.kind !== "screen" || event.terminalId !== term.terminalId) return
            const f = event.frame
            // A frame that does not continue the screen this pane holds means one was missed: reread the whole screen.
            if (f.base !== term.revision && !f.full) { term.open(term.terminalId); return }
            term.cursor = f.cursor; term.revision = f.rev
            if (f.full || f.rows !== term.rows) {
                term.rows = f.rows; term.cols = f.cols
                if (f.full) { screenModel.clear(); for (let r = 0; r < f.rows; ++r) screenModel.append({ runs: JSON.stringify(f.lines[r] || []) }) }
                else { term.open(term.terminalId) }
                return
            }
            for (const row of Object.keys(f.changed)) { const index = Number(row); if (index < screenModel.count) screenModel.setProperty(index, "runs", JSON.stringify(f.changed[row])) }
        }
    }

    ColumnLayout {
        id: content
        anchors.fill: parent; spacing: Theme.space2
        Flow {
            Layout.fillWidth: true; spacing: Theme.space2
            CComboBox { id: shellBox; objectName: "terminalShell"; property bool chosen: false; width: Math.min(Theme.fieldMedium, parent.width); model: (term.profiles.shells || []).map(s => s.label); onActivated: chosen = true; Accessible.name: "Shell for a new terminal" }
            CButton { objectName: "terminalNew"; text: "New terminal"; primary: !term.terminals.length; enabled: term.profiles.worker === "available"; help: "Starts the chosen shell on this computer in this conversation’s folder"; onClicked: term.create() }
            Repeater {
                model: term.terminals
                CButton { required property var modelData; objectName: "terminal_" + modelData.id; width: Math.min(implicitWidth, parent.width); implicitHeight: Theme.compactHeight; quiet: modelData.id !== term.terminalId; primary: modelData.id === term.terminalId
                    text: modelData.title + (modelData.state === "running" ? "" : " · " + term.stateLabel(modelData.state)); onClicked: term.open(modelData.id) }
            }
        }
        CText { visible: term.profiles.worker === "missing"; text: term.profiles.unavailableReason || ""; color: Theme.amber; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
        CText { objectName: "terminalBadge";visible:!!term.current;Layout.fillWidth:true;wrapMode:Text.Wrap;font.pixelSize:Theme.caption;color:Theme.muted
            text:term.current?"On "+term.current.host+" · "+term.current.shell+" · desktop account ("+term.current.account+")\n"+term.current.cwd+" · "+term.stateLabel(term.current.state)
                +(term.current.foreground&&term.current.foreground.name!==term.current.shell?" · running "+term.current.foreground.name:"")
                +(term.phoneControls?"\nController · "+(term.current.controller.name||"a paired phone")+" is typing":term.controlling?"\nController · this desktop is typing":"\nController · viewing only"):"" }
        Flow {
            visible: !!term.current; Layout.fillWidth: true; spacing: Theme.space2
            CButton { objectName: "terminalTakeControl"; visible: term.running && !term.controlling; text: term.phoneControls ? "Take control from the phone" : "Type here"; onClicked: term.takeControl(() => keys.forceActiveFocus()) }
            CButton { objectName: "terminalInterrupt"; visible: term.running; text: "Interrupt"; help: "Sends Ctrl+C to the program in the foreground"; onClicked: rpc.call("terminal.interrupt", { terminalId: term.terminalId }, value => { if (value.error) term.error = value.error }) }
            CButton { objectName: "terminalHistory"; visible: !!term.current; text: term.showHistory ? "Live screen" : "History and copy"; onClicked: { term.showHistory = !term.showHistory; if (term.showHistory) term.loadHistory() } }
            CButton { objectName: "terminalStop"; visible: term.running; danger: true; text: "Stop terminal"; help: "Ends the shell and every program it started"; onClicked: rpc.call("terminal.close", { terminalId: term.terminalId }, value => { if (value.error) term.error = value.error; else term.current = value }) }
            CButton { objectName: "terminalForget"; visible: !!term.current && !term.running; text: "Remove"; onClicked: rpc.call("terminal.forget", { terminalId: term.terminalId }, () => { term.terminalId = ""; term.current = null; screenModel.clear(); term.refresh() }) }
        }
        CText { visible:!!term.current;text:"Ctrl+Shift+F6 — leave terminal and return to the active Workbench tab";color:Theme.accentText;font.pixelSize:Theme.caption;wrapMode:Text.Wrap;Layout.fillWidth:true }
        CText { visible: !!term.current && !!term.current.note; text: term.current ? term.current.note || "" : ""; color: Theme.amber; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
        CText { visible: !!term.current && !!term.current.stopReport; font.pixelSize: Theme.caption; color: Theme.muted; Layout.fillWidth: true; wrapMode: Text.Wrap
            text: term.current && term.current.stopReport ? "Stopped " + term.current.stopReport.signalled + " process" + (term.current.stopReport.signalled === 1 ? "" : "es") + (term.current.stopReport.remaining ? "; " + term.current.stopReport.remaining + " did not stop" : "; none remain") + "." : "" }
        CText { visible: !!term.error || !!term.notice; text: term.error || term.notice; color: term.error ? Theme.danger : Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
        Rectangle {
            id: screenArea
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorShort; color: Theme.codeSurface; border.color: keys.activeFocus ? Theme.focus : Theme.subtle; border.width: keys.activeFocus ? Theme.focusWidth : Theme.hairline; clip: true
            visible: !term.showHistory
            onWidthChanged: resizeTimer.restart(); onHeightChanged: resizeTimer.restart()
            Accessible.role: Accessible.Terminal; Accessible.name: term.current ? "Terminal " + term.current.title : "Terminal"
            ListView {
                id: screenView
                anchors.fill: parent; anchors.margins: Theme.space1; interactive: false; model: screenModel
                delegate: Item {
                    required property string runs
                    required property int index
                    width: screenView.width; height: term.cellHeight
                    readonly property var parsed: JSON.parse(runs)
                    Repeater {
                        model: parent.parsed
                        Rectangle {
                            required property var modelData
                            readonly property bool reverse: (modelData[4] & 8) !== 0
                            x: modelData[0] * term.cellWidth; width: Math.max(1, label.implicitWidth); height: term.cellHeight
                            color: reverse ? term.colour(modelData[2], true) : modelData[3] < 0 ? Theme.transparent : term.colour(modelData[3], false)
                            Text { id: label; text: modelData[1]; font.family: Theme.mono; font.pixelSize: Theme.secondary; font.bold: (modelData[4] & 1) !== 0; font.italic: (modelData[4] & 2) !== 0
                                font.underline: (modelData[4] & 4) !== 0; font.strikeout: (modelData[4] & 16) !== 0; textFormat: Text.PlainText
                                color: (modelData[4] & 64) !== 0 ? Theme.transparent : parent.reverse ? term.colour(modelData[3], false) : term.colour(modelData[2], true) }
                        }
                    }
                }
            }
            Rectangle { visible: term.running && term.cursor[2] === 1; x: Theme.space1 + term.cursor[1] * term.cellWidth; y: Theme.space1 + term.cursor[0] * term.cellHeight; width: term.cellWidth; height: term.cellHeight
                color: keys.activeFocus ? Theme.accentText : Theme.transparent; border.color: Theme.accentText; opacity: 0.6 }
            CText { anchors.centerIn: parent; width: Math.max(0, parent.width - Theme.space4); visible: !term.current; text: term.profiles.worker === "missing" ? "" : "Start a terminal to run commands on this computer."; color: Theme.muted; horizontalAlignment: Text.AlignHCenter }
            Item {
                id: keys; anchors.fill: parent; focus: true; activeFocusOnTab: true
                Keys.onPressed: event => { const input = term.keyEvent(event); if (input) { term.send([input]); event.accepted = true } }
                MouseArea { anchors.fill: parent; onClicked: keys.forceActiveFocus() }
            }
        }
        CTextArea { id: historyView; objectName: "terminalHistoryText"; visible: term.showHistory; Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: visible ? Theme.editorShort : 0; readOnly: true; text: term.historyText; font.family: Theme.mono; font.pixelSize: Theme.caption; wrapMode: TextEdit.NoWrap; Accessible.name: "Terminal history" }
    }
}
