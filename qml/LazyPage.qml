import QtQuick

// Keep visited pages and their drafts. Until a page is opened, even its QML
// dependencies stay out of the first chat frame.
Loader {
    id: loader
    required property url pageSource
    required property bool selected
    property var initialProperties: ({})
    property bool initialized: false
    function ensure() {
        if (!source.toString()) setSource(pageSource, initialProperties)
        return item
    }
    Component.onCompleted: {
        initialized = true
        if (selected) ensure()
    }
    onSelectedChanged: if (initialized && selected) ensure()
}
