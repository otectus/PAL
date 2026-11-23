import QtQuick

Item {
    id: panel
    property bool expanded: false
    property int page: 0
    readonly property real pageOffset: content.item?.pageOffset || 0
    property bool prepareAsynchronously: false
    readonly property real interfaceScale: Theme.interfaceScale
    readonly property bool contentReady: content.status === Loader.Ready
    onPageChanged: if (content.item && content.item.page !== page) content.item.page = page

    Loader {
        id: content
        width: parent.width / panel.interfaceScale
        height: parent.height / panel.interfaceScale
        scale: panel.interfaceScale
        transformOrigin: Item.TopLeft
        asynchronous: panel.prepareAsynchronously
        source: "Shell.qml"
        onLoaded: {
            item.expanded = Qt.binding(() => panel.expanded)
            item.page = panel.page
            item.pageChanged.connect(() => { panel.page = item.page })
            if (panel.Window.window?.visible && panel.page === 0 && !panel.expanded && !item.workbenchVisible)
                item.openConversation()
        }
    }
}
