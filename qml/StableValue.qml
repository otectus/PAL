import QtQuick
// A part of the pushed state that changes only when its content does. Every state update replaces the whole state, so a
// list bound to it directly is rebuilt each time, together with whatever is being typed in its rows.
QtObject {
    property var source
    property var value
    property string content: ""
    onSourceChanged: {
        const next = JSON.stringify(source === undefined ? null : source)
        if (next !== content) { content = next; value = source }
    }
}
