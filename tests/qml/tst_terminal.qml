import QtQuick
import QtTest
import "../../qml" as PAL

Item {
    width: 800; height: 600; visible: true
    QtObject {
        id: broker
        property bool connected: true
        property var session: ({ id: "session-a" })
        property int nextId: 0
        property var calls: ({})
        signal result(int id, var value)
        signal terminalEvent(var event)
        function rpc(method, params) { const id = ++nextId; calls[id] = { method: method, params: params }; return id }
        function clipboardText() { return "" }
        function reply(id, value) { result(id, value) }
        function idFor(method, occurrence) {
            let found = 0
            for (const id of Object.keys(calls)) if (calls[id].method === method && ++found === occurrence) return Number(id)
            return -1
        }
    }
    Component { id: paneComponent; PAL.TerminalPane { width: 800; height: 600; app: broker; sessionId: broker.session.id } }
    TestCase {
        name: "TerminalPane"
        when: windowShown
        property var pane: null
        function init() {
            broker.nextId = 0; broker.calls = ({ }); broker.session = ({ id: "session-a" })
            pane = createTemporaryObject(paneComponent, null)
            verify(pane !== null)
        }
        function snapshot(id, text) { return { terminal: { id: id, state: "running", controller: null }, screen: { rows: 1, cols: 10, cursor: [0, 0, 0], revision: 1, lines: [[[0, text, -1, -1, 0]]] } } }
        function test_lateSnapshotCannotReplaceNewSelection() {
            pane.open("first"); const first = broker.idFor("terminal.snapshot", 1)
            pane.open("second"); const second = broker.idFor("terminal.snapshot", 2)
            broker.reply(second, snapshot("second", "second")); compare(pane.current.id, "second")
            broker.reply(first, snapshot("first", "first")); compare(pane.current.id, "second")
            compare(pane.terminalId, "second")
        }
        function test_lateCreateCannotStealSelectionOrSession() {
            pane.create(); const create = broker.idFor("terminal.create", 1)
            pane.open("other"); const other = broker.idFor("terminal.snapshot", 1)
            broker.reply(other, snapshot("other", "other")); compare(pane.terminalId, "other")
            broker.session = ({ id: "session-b" })
            broker.reply(create, Object.assign(snapshot("created", "created"), { lease: { leaseId: "lease", epoch: 1, lastSequence: 0 } }))
            compare(pane.terminalId, "other")
            verify(pane.current.id !== "created")
        }
    }
}
