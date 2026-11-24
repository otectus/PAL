import QtQuick
// One reading of the desktop's clock, renewed at each new minute while it is being looked at. It is a local broker
// read: no model, network or file is involved, and nothing runs while `active` is false.
Item {
    id: source
    visible: false
    property bool active: false
    property string sessionId: ""
    property string timeZone: ""
    property var sample: null
    // The last reading is kept but marked old when the desktop cannot be asked again.
    property bool stale: false
    property string error: ""
    readonly property string format: App.state.settings?.time?.clockFormat || "system"
    readonly property string choices: JSON.stringify(App.state.settings?.time || {}) + "|" + ((App.state.sessions || []).find(item => item.id === sessionId)?.timeZone || "")
    signal sampled()
    function read() {
        if (!active) return
        const params = {}
        if (sessionId) params.sessionId = sessionId
        if (timeZone) params.timeZone = timeZone
        rpc.call("time.now", params, value => {
            if (value.error) { source.error = String(value.error.message || value.error); source.stale = !!source.sample; tick.interval = 60000 }
            else { source.error = ""; source.stale = false; source.sample = value; tick.interval = Math.max(1000, 60000 - value.sampledAtMs % 60000 + 250); source.sampled() }
            if (source.active) tick.restart()
        })
    }
    onActiveChanged: if (active) read(); else tick.stop()
    onSessionIdChanged: { sample = null; read() }
    onTimeZoneChanged: { sample = null; read() }
    onChoicesChanged: read()
    readonly property bool online: App.connected
    onOnlineChanged: if (online) read(); else stale = !!sample
    RpcClient { id: rpc; scope: source.sessionId + "|" + source.timeZone }
    Timer { id: tick; repeat: false; onTriggered: source.read() }
}
