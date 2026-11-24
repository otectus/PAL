import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// M11: audio synthesized for messages of saved conversations, kept only while the person asks for it.
ColumnLayout {
    id: cache
    readonly property var settings: App.state.settings?.speechCache || ({ enabled: false, days: 7, megabytes: 100 })
    property var info: ({ items: 0, bytes: 0 })
    property string error: ""
    spacing: Theme.space2
    function size(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB" }
    function load() { rpc.call("tts.cache", {}, value => { if (!value.error) info = value }) }
    function save(patch) { error = ""; saver.call("settings.update", { speechCache: patch }, value => { if (value.error) error = value.error; load() }) }
    RpcClient { id: rpc }
    RpcClient { id: saver }
    RpcClient { id: clearing }
    Component.onCompleted: load()
    Connections { target: App; function onStateChanged() { if (cache.visible && cache.settings.enabled && App.state.speech?.state === "idle") settle.restart() } }
    Timer { id: settle; interval: 600; onTriggered: cache.load() }
    CCheckBox { objectName: "speechCache"; text: "Keep spoken audio"; checked: cache.settings.enabled === true; enabled: !saver.busy; onClicked: cache.save({ enabled: checked }) }
    CText { text: "Audio of messages in saved conversations stays on this computer, so reading one again starts at once and is not paid for twice. It goes with its message or conversation. Temporary conversations, and voices played through Speech Dispatcher, are never kept."; color: Theme.muted; font.pixelSize: Theme.secondary; Layout.fillWidth: true }
    GridLayout {
        visible: cache.settings.enabled === true
        Layout.fillWidth: true; columns: width >= Theme.compactPane ? 4 : 2; columnSpacing: Theme.space2; rowSpacing: Theme.space2
        CText { text: "Days"; Layout.fillWidth: false }
        CSpinBox { objectName: "speechCacheDays"; from: 1; to: 90; value: cache.settings.days || 7; enabled: !saver.busy; Accessible.name: "Days spoken audio is kept"; onValueModified: cache.save({ days: value }) }
        CText { text: "Space, MB"; Layout.fillWidth: false }
        CSpinBox { objectName: "speechCacheSize"; from: 10; to: 2000; stepSize: 10; value: cache.settings.megabytes || 100; enabled: !saver.busy; Accessible.name: "Space for spoken audio in megabytes"; onValueModified: cache.save({ megabytes: value }) }
    }
    RowLayout {
        visible: cache.settings.enabled === true
        Layout.fillWidth: true; spacing: Theme.space2
        CText { objectName: "speechCacheStatus"; text: cache.info.items ? cache.info.items + (cache.info.items === 1 ? " recording, " : " recordings, ") + cache.size(cache.info.bytes) : "Nothing is kept yet."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true }
        CButton { objectName: "speechCacheClear"; text: "Delete all"; quiet: true; implicitHeight: Theme.compactHeight; visible: cache.info.items > 0; enabled: !clearing.busy; onClicked: clearing.call("tts.cacheClear", {}, value => { if (value.error) cache.error = value.error; else cache.info = value }) }
    }
    CText { visible: !!cache.error; text: cache.error; color: Theme.danger; Layout.fillWidth: true }
}
