import QtQuick
import "Labels.js" as Labels

// Keep the sidebar's active count available before the Research page is first visited.
Item {
    id: monitor
    visible: false
    property var app: typeof App !== "undefined" ? App : null
    property bool watching: false
    property var tasks: []
    property var pending: ({})
    property string loadError: ""
    property string actionError: ""
    property bool loading: false
    property bool loaded: false
    property bool refreshQueued: false
    readonly property bool online: !!app?.connected
    readonly property int activeCount: tasks.filter(task => isActive(task)).length

    RpcClient { id: rpc; endpoint: monitor.app }

    function isActive(task) { return Labels.researchActive(task.state) }
    function canResume(task) { return ["paused", "failed", "interrupted"].includes(task.state) }
    function ownerLabel(task) {
        const owner = task.owner || (app?.state?.sessions || []).find(s => s.id === task.sessionId)?.title
        return owner || "Untitled conversation"
    }
    function routeLabel(task) {
        return [Labels.provider(task.provider || ""), task.model].filter(Boolean).join(" · ")
    }
    function refresh() {
        if (loading || !online) return
        loading = true
        rpc.call("research.tasks", {}, value => {
            loading = false
            if (refreshQueued) {
                refreshQueued = false
                refresh()
                return
            }
            loadError = value.error || ""
            if (!value.error) {
                const rows = Array.from(value).sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))
                if (JSON.stringify(rows) !== JSON.stringify(tasks)) tasks = rows
                loaded = true
            }
        })
    }
    function act(method, id) {
        if (!online || pending[id]) return
        pending = Object.assign({}, pending, { [id]: method })
        actionError = ""
        rpc.call(method, {id: id}, value => {
            if (value.id === id && value.state) {
                tasks = tasks.map(task => task.id === id ? Object.assign({}, task, {
                    state: value.state, progress: value.progress, updated: value.updated || task.updated
                }) : task)
            }
            const next = Object.assign({}, pending)
            delete next[id]
            pending = next
            actionError = value.error || ""
            if (loading) refreshQueued = true
            else refresh()
        })
    }
    Timer {
        interval: monitor.watching || monitor.activeCount ? 1500 : 8000
        repeat: true
        running: monitor.online
        triggeredOnStart: true
        onTriggered: monitor.refresh()
    }
}
