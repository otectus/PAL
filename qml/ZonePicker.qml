import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "TimeText.js" as TimeText
// Chooses one time zone by its name. Each row shows its offset from UTC today; a zone's offset changes with the
// season, so the name is what is saved.
CDialog {
    id: picker
    objectName: "zonePicker"
    accessibleTitle: heading
    property string heading: "Choose a time zone"
    property string selected: ""
    property var zones: []
    property string error: ""
    readonly property bool loading: rpc.busy
    // Every word must appear, so “new york”, “America/New_York” and “utc+9” all find their zones.
    readonly property var words: plain(filter.text).split(" ").filter(word => word.length > 0)
    readonly property var matches: zones.filter(item => { const where = plain(item.id + " " + TimeText.offset(item.offsetSeconds)); return words.every(word => where.indexOf(word) >= 0) })
    function plain(value) { return String(value).toLowerCase().replace(/[_\/\s]+/g, " ").replace(/−/g, "-").replace(/utc([+-])0/g, "utc$1").trim() }
    signal chosen(string zone)
    function openFor(zone) { selected = zone || ""; error = ""; filter.clear(); open() }
    onOpened: {
        filter.forceActiveFocus()
        if (zones.length) { picker.showSelected(); return }
        rpc.call("time.zones", {}, value => {
            if (value.error) { picker.error = String(value.error.message || value.error); return }
            picker.zones = value; Qt.callLater(picker.showSelected)
        })
    }
    function showSelected() {
        const at = matches.findIndex(item => item.id === selected)
        list.currentIndex = at >= 0 ? at : 0
        list.positionViewAtIndex(list.currentIndex, ListView.Center)
    }
    function choose(index) { const item = matches[index]; if (item) { chosen(item.id); close() } }
    onMatchesChanged: { list.currentIndex = matches.length ? Math.max(0, matches.findIndex(item => item.id === selected)) : -1; list.positionViewAtIndex(Math.max(0, list.currentIndex), ListView.Contain) }
    RpcClient { id: rpc }
    CText { text: picker.heading; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
    CField {
        id: filter; objectName: "zoneSearch"; Layout.fillWidth: true
        placeholderText: "Search by city or region"; Accessible.name: "Search time zones"
        onAccepted: picker.choose(list.currentIndex)
        Keys.onDownPressed: event => { if (list.count) { list.forceActiveFocus(Qt.TabFocusReason) } event.accepted = true }
    }
    CText {
        visible: !list.count; objectName: "zoneStatus"
        text: picker.loading ? "Loading time zones…" : picker.error || (picker.zones.length ? "No time zone matches “" + filter.text.trim() + "”." : "")
        color: picker.error ? Theme.danger : Theme.muted; font.pixelSize: Theme.secondary
    }
    ListView {
        id: list; objectName: "zoneList"
        Layout.fillWidth: true; Layout.preferredHeight: Theme.editorLarge
        visible: count > 0; clip: true; activeFocusOnTab: true; keyNavigationEnabled: true
        boundsBehavior: Flickable.StopAtBounds
        model: picker.matches
        ScrollBar.vertical: CScrollBar {}
        Accessible.role: Accessible.List; Accessible.name: count + " time zones"
        Keys.onReturnPressed: event => { picker.choose(currentIndex); event.accepted = true }
        Keys.onEnterPressed: event => { picker.choose(currentIndex); event.accepted = true }
        Keys.onSpacePressed: event => { picker.choose(currentIndex); event.accepted = true }
        delegate: ItemDelegate {
            id: row
            required property var modelData
            required property int index
            objectName: "zone_" + modelData.id.replace(/[^a-zA-Z0-9_-]/g, "_")
            width: list.width; height: Theme.controlHeight
            leftPadding: Theme.space3; rightPadding: Theme.space5
            highlighted: ListView.isCurrentItem
            Accessible.role: Accessible.ListItem
            Accessible.name: modelData.id + ", " + TimeText.offset(modelData.offsetSeconds)
            Accessible.selected: modelData.id === picker.selected
            Accessible.onPressAction: picker.choose(index)
            onClicked: picker.choose(index)
            background: Rectangle {
                radius: Theme.radiusChip
                color: row.highlighted || row.hovered ? Theme.selected : Theme.transparent
                border.color: row.highlighted && list.activeFocus ? Theme.focus : Theme.transparent
                border.width: Theme.focusWidth
            }
            contentItem: RowLayout {
                spacing: Theme.space2
                CIcon { name: "check"; visible: row.modelData.id === picker.selected; color: Theme.accentText; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall }
                CText { text: row.modelData.id.replace(/_/g, " "); wrapMode: Text.NoWrap; elide: Text.ElideRight }
                CText { Layout.fillWidth: false; text: TimeText.offset(row.modelData.offsetSeconds); wrapMode: Text.NoWrap; color: Theme.muted; font.pixelSize: Theme.caption }
            }
        }
    }
    CButton { objectName: "zoneCancel"; Layout.fillWidth: true; text: "Cancel"; onClicked: picker.close() }
}
