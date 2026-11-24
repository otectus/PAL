pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Bookmarked messages across conversations, newest first. The phone’s Pinned sheet shows the same list.
CDialog {
    id: pinned
    objectName: "pinnedReplies"
    preferredWidth: Theme.dialogLarge
    property var rows: []
    property string error: ""
    property bool loaded: false
    function openPinned() { query.clear(); rows = []; loaded = false; error = ""; open(); load(); Qt.callLater(() => query.forceActiveFocus()) }
    function load() {
        const asked = query.text.trim()
        rpc.call("bookmarks.list", { query: asked, limit: 100 }, value => {
            if (asked !== query.text.trim()) return
            pinned.loaded = true
            if (value.error) { pinned.error = String(value.error.message || value.error); return }
            pinned.error = ""; pinned.rows = value
        })
    }
    RpcClient { id: rpc }
    Timer { id: wait; interval: 180; onTriggered: pinned.load() }
    Connections { target: App; function onStateChanged() { const count = (App.state.bookmarks || []).length; if (pinned.opened && count !== pinned.seen) { pinned.seen = count; pinned.load() } } }
    property int seen: -1
    CText { text: "Bookmarks"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
    CField { id: query; objectName: "pinnedSearch"; Layout.fillWidth: true; maximumLength: 500; placeholderText: "Search bookmarked messages"; Accessible.name: "Search bookmarked messages"; onTextChanged: wait.restart() }
    CText { objectName: "pinnedStatus"; visible: !list.count; text: pinned.error || (!pinned.loaded ? "Loading…" : query.text.trim() ? "No bookmarked message matches." : "No bookmarks yet. Choose Bookmark in a message’s menu."); color: pinned.error ? Theme.danger : Theme.muted }
    ListView {
        id: list; objectName: "pinnedList"
        visible: count > 0; Layout.fillWidth: true; Layout.preferredHeight: Theme.bubbleHeight; clip: true; spacing: Theme.space2
        boundsBehavior: Flickable.StopAtBounds; activeFocusOnTab: true; keyNavigationEnabled: true
        ScrollBar.vertical: CScrollBar {}
        model: pinned.rows
        Accessible.role: Accessible.List; Accessible.name: count + " bookmarked messages"
        delegate: Rectangle {
            id: row
            required property var modelData
            required property int index
            width: list.width - Theme.space4; implicitHeight: column.implicitHeight + Theme.space4
            radius: Theme.radiusControl; color: Theme.surface; border.color: list.currentIndex === index && list.activeFocus ? Theme.focus : Theme.subtle
            ColumnLayout {
                id: column; x: Theme.space3; y: Theme.space2; width: parent.width - 2 * Theme.space3; spacing: Theme.space1
                CText { text: (row.modelData.title || "Conversation") + " · " + new Date(row.modelData.time).toLocaleString(Qt.locale(), Locale.ShortFormat); color: Theme.accentText; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                CText { text: row.modelData.text; maximumLineCount: 4; elide: Text.ElideRight }
                RowLayout {
                    Layout.fillWidth: true; spacing: Theme.space2
                    CButton { objectName: "pinnedOpen_" + row.index; text: "Open"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: { pinned.close(); WorkbenchState.openMessage(row.modelData.sessionId, row.modelData.id) } }
                    CButton { text: "Remove bookmark"; quiet: true; implicitHeight: Theme.compactHeight; enabled: App.connected; onClicked: rpc.call("message.bookmark", { sessionId: row.modelData.sessionId, messageId: row.modelData.id, bookmarked: false }, value => { if (value.error) pinned.error = String(value.error.message || value.error); pinned.load() }) }
                    Item { Layout.fillWidth: true }
                }
            }
        }
        Keys.onReturnPressed: event => { const item = pinned.rows[currentIndex]; if (item) { pinned.close(); WorkbenchState.openMessage(item.sessionId, item.id) } event.accepted = true }
    }
    CButton { objectName: "pinnedClose"; Layout.fillWidth: true; text: "Close"; onClicked: pinned.close() }
}
