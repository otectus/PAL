import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// A CSV or TSV before analysis: its columns with inferred types, how much is missing, a few rows and any parse
// problems (files.table and tables.preview). Cells are plain text; formulas are never evaluated.
ColumnLayout {
    id: summary
    objectName: "tableSummary"
    property var table: null
    // Cells padded to their column, so the first rows read as columns in a fixed-width face.
    function aligned(rows) {
        const widths = []
        for (const row of rows) row.forEach((cell, at) => widths[at] = Math.min(28, Math.max(widths[at] || 0, String(cell).length)))
        return rows.map(row => row.map((cell, at) => { const text = String(cell).length > 28 ? String(cell).slice(0, 27) + "…" : String(cell); return at === row.length - 1 ? text : text + " ".repeat(Math.max(0, widths[at] - text.length)) }).join("   ")).join("\n")
    }
    readonly property var types: ({ number: "number", integer: "whole number", date: "date", boolean: "yes or no", text: "text", empty: "empty" })
    Layout.fillWidth: true
    spacing: Theme.space2
    CText {
        objectName: "tableShape"; visible: !!summary.table
        text: summary.table ? summary.table.rows + (summary.table.rows === 1 ? " row" : " rows") + " · " + summary.table.columns.length + (summary.table.columns.length === 1 ? " column" : " columns") + " · separated by " + (summary.table.delimiter === "\t" ? "tabs" : "commas") : ""
        font.weight: Font.DemiBold
    }
    Repeater { model: summary.table?.problems || []; CText { required property string modelData; text: modelData; color: Theme.amber; font.pixelSize: Theme.secondary } }
    Repeater {
        model: summary.table?.columns || []
        RowLayout {
            id: columnRow
            required property var modelData
            Layout.fillWidth: true; spacing: Theme.space3
            CText { Layout.fillWidth: false; Layout.preferredWidth: Theme.fieldMedium; text: columnRow.modelData.name; elide: Text.ElideRight; wrapMode: Text.NoWrap }
            CText { text: (summary.types[columnRow.modelData.type] || columnRow.modelData.type) + " · " + columnRow.modelData.distinct + " distinct" + (columnRow.modelData.missing ? " · " + columnRow.modelData.missing + " missing" : "") + (columnRow.modelData.example !== undefined ? " · for example " + columnRow.modelData.example : ""); color: Theme.muted; font.pixelSize: Theme.secondary; elide: Text.ElideRight; wrapMode: Text.NoWrap }
        }
    }
    ScrollView {
        visible: (summary.table?.sample || []).length > 0
        Layout.fillWidth: true; Layout.preferredHeight: sampleText.implicitHeight + Theme.space5
        ScrollBar.vertical.policy: ScrollBar.AlwaysOff
        Text {
            id: sampleText
            text: summary.table ? summary.aligned([summary.table.columns.map(column => column.name)].concat(summary.table.sample || [])) : ""
            textFormat: Text.PlainText; color: Theme.text; font.family: Theme.mono; font.pixelSize: Theme.caption
            Accessible.role: Accessible.StaticText; Accessible.name: "First rows"
        }
    }
}
