pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// What was worked on inside the approved folders, by day, with everything needed to erase it.
CDialog {
    id: history
    objectName: "workspaceHistory"
    accessibleTitle: "Workspace history"
    preferredWidth: Theme.dialogWidth
    property var info: ({ items: [], folders: [], records: 0 })
    property string project: ""
    property string error: ""
    property bool confirming: false
    readonly property var days: {
        const groups = []
        for (let i = 0; i < (info.items || []).length; i++) {
            const row = info.items[i], day = new Date(row.at).toLocaleDateString(Qt.locale(), "dddd, d MMMM")
            if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day: day, rows: [] })
            groups[groups.length - 1].rows.push(row)
        }
        return groups
    }
    function openView() { project = ""; error = ""; confirming = false; load(); open() }
    function load() { rpc.call("workspace.history", Object.assign({ limit: 200 }, project ? { project: project } : {}), value => { if (value.error) { error = value.error; return } info = value }) }
    function erase() { confirming = false; rpc.call("workspace.historyErase", project ? { project: project } : { all: true }, value => { if (value.error) { error = value.error; return } load() }) }
    function what(row) {
        const place = row.item || row.project.split("/").pop()
        return row.kind === "command" ? "Commands in " + place : row.kind === "focus" ? "Worked in " + place : place
    }
    function detail(row) {
        const clock = time => new Date(time).toLocaleTimeString(Qt.locale(), "HH:mm"), parts = [row.started === row.at || clock(row.started) === clock(row.at) ? clock(row.at) : clock(row.started) + "–" + clock(row.at)]
        if (row.kind === "document") parts.push(row.count ? row.count + (row.count === 1 ? " save" : " saves") : "opened")
        else if (row.kind === "file") parts.push(row.count + (row.count === 1 ? " change" : " changes"))
        else if (row.kind === "command") parts.push(row.count + (row.count === 1 ? " command" : " commands") + (row.failed ? ", " + row.failed + " failed" : ""))
        if (row.seconds >= 60) parts.push(Math.round(row.seconds / 60) + " min")
        if (!project && (info.folders || []).length > 1) parts.push(row.project.split("/").pop())
        return parts.join(" · ")
    }
    RpcClient { id: rpc }
    CText { text: "Workspace history"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
    CText { objectName: "historyStatus"; text: (history.info.enabled ? "Kept for " + history.info.days + " days." : "Off. What was kept before stays until it expires or you erase it.") + " " + (history.info.records ? history.info.records + (history.info.records === 1 ? " record." : " records.") : "Nothing is kept."); color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
    CComboBox { visible: (history.info.folders || []).length > 1; Layout.fillWidth: true; model: ["Every approved folder"].concat(history.info.folders || []); Accessible.name: "Folder"; onActivated: index => { history.project = index > 0 ? history.info.folders[index - 1] : ""; history.load() } }
    CText { visible: !!history.error; text: history.error; color: Theme.danger; wrapMode: Text.Wrap; Layout.fillWidth: true }
    Repeater {
        model: history.days
        ColumnLayout {
            id: group
            required property var modelData
            Layout.fillWidth: true; spacing: Theme.space1
            CText { text: group.modelData.day; font.weight: Font.DemiBold; font.pixelSize: Theme.secondary; Layout.topMargin: Theme.space2; Accessible.role: Accessible.Heading }
            Repeater {
                model: group.modelData.rows
                RowLayout {
                    id: row
                    required property var modelData
                    Layout.fillWidth: true; spacing: Theme.space2
                    CIcon { name: row.modelData.kind === "command" ? "terminal" : row.modelData.kind === "focus" ? "desktop" : "file"; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall }
                    CText { text: history.what(row.modelData); Layout.fillWidth: true; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                    CText { text: history.detail(row.modelData); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: false; horizontalAlignment: Text.AlignRight }
                }
            }
        }
    }
    footerContent: RowLayout {
        spacing: Theme.space2; uniformCellSizes: true
        CButton { text: "Close"; Layout.fillWidth: true; onClicked: history.close() }
        CButton { objectName: "eraseWorkspaceHistory"; visible: !history.confirming; text: history.project ? "Erase this folder’s history…" : "Erase all history…"; danger: true; Layout.fillWidth: true; enabled: !rpc.busy && history.info.records > 0; onClicked: history.confirming = true }
        CButton { objectName: "confirmEraseWorkspaceHistory"; visible: history.confirming; text: "Erase now"; danger: true; primary: true; Layout.fillWidth: true; onClicked: history.erase() }
    }
}
