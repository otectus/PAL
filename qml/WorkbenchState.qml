pragma Singleton
import QtQuick
import QtCore
// Each UI host keeps its Workbench selections and unsent edits across session and layout changes.
// Only layout preferences are written to the shared desktop settings file.
QtObject {
    id: state
    // Only an explicit request takes over a narrow conversation.
    property bool open: false
    property string tab: "files"
    property var roots: ({})
    property var folders: ({})
    // The scalar selections remain for compatibility with existing entry points; panes read the
    // session maps so one conversation can never display another conversation's file or review.
    property var file: ({})
    property var files: ({})
    property var scroll: ({})
    property string changeSetId: ""
    property var reviews: ({})
    property string artifactId: ""
    property string versionId: ""
    property var images: ({})
    // Research report links keep their run and exact revision per conversation, just like images.
    property var researchSelections: ({})
    property real zoom: 1
    property var editorDrafts: ({})
    property var fileDrafts: ({})
    property var references: ({})
    // Ready provider-upload handles selected for the next turn. Handles are scoped to one conversation/account.
    property var originalFiles: ({})
    // A run comparison baseline belongs to its conversation and survives pane/session switches.
    property var runBaselines: ({})
    // Project folders key scratchpad drafts. Independent library notes use their stable note IDs.
    property var noteStates: ({})
    /** The palette's "Create image" opens the Images pane with its Create panel showing. */
    property bool createRequested: false
    component LayoutPreferences: Settings {
        location: typeof App !== "undefined" ? App.layoutSettingsUrl : "file:///tmp/pal-qml-test-layout.ini"
        category: "navigation"
        property real paneWidth: Theme.paneDefault
        property bool collapsed: false
        property bool dockOpen: false
        property real sidebarWidth: Theme.sidebarDefault
        property real composerHeight: 0
        property real activityHeight: 0
        property real settingsNavWidth: Theme.settingsRailWidth
        property bool showPaneTabs: true
    }
    readonly property LayoutPreferences layout: LayoutPreferences { id: preferences }
    property alias paneWidth: preferences.paneWidth
    signal requested()
    function show(tab) { if (tab) state.tab = tab; open = true; requested() }
    function hide() { open = false }
    function openReview(changeSetId, sessionId) { setReview(sessionId || App.selectedId, changeSetId); show("changes") }
    function setReview(sessionId, id) { if ((reviews[sessionId] || "") === (id || "")) { changeSetId = id || ""; return } const next = Object.assign({}, reviews); if (id) next[sessionId] = id; else delete next[sessionId]; reviews = next; changeSetId = id || "" }
    function changeSetFor(sessionId) { return reviews[sessionId] || "" }
    function openFile(sessionId, rootId, path, line) { const value = { sessionId: sessionId, rootId: rootId, path: path, line: line || 1 }, next = Object.assign({}, files); next[sessionId] = value; files = next; file = value; show("preview") }
    function fileFor(sessionId) { return files[sessionId] || ({}) }
    function selectImage(sessionId, artifact, version) { const next = Object.assign({}, images); if (artifact && version) next[sessionId] = { artifactId: artifact, versionId: version }; else delete next[sessionId]; images = next; artifactId = artifact || ""; versionId = version || "" }
    function compareImages(sessionId, chosen, other) {
        const next = Object.assign({}, images)
        next[sessionId] = { artifactId: chosen.artifactId, versionId: chosen.versionId,
                            compare: {artifactId: other.artifactId, versionId: other.versionId, name: other.name || ""} }
        images = next
        artifactId = chosen.artifactId
        versionId = chosen.versionId
        show("images")
    }
    property var pendingImageText: ({})
    signal imageStaged(string sessionId)
    function useImage(sessionId, ref, message, related) {
        if (!sessionId || !ref?.artifactId || !ref.versionId) return "Choose an image version first."
        const refs = referencesFor(sessionId).slice()
        for (const source of [ref].concat(related || [])) {
            if (!refs.some(r => r.kind === "artifact" && r.artifactId === source.artifactId && r.versionId === source.versionId)) {
                refs.push({kind:"artifact",artifactId:source.artifactId,versionId:source.versionId,label:source.name || source.label || "Image"})
            }
        }
        if (refs.length > 8) return "Remove a reference from your message first. A message holds up to eight."
        setReferences(sessionId,refs)
        if (message) {
            const next = Object.assign({}, pendingImageText)
            next[sessionId] = [next[sessionId], message].filter(Boolean).join("\n")
            pendingImageText = next
        }
        imageStaged(sessionId)
        return ""
    }
    function takeImageText(sessionId) {
        const text = pendingImageText[sessionId]
        if (text) { const next = Object.assign({}, pendingImageText); delete next[sessionId]; pendingImageText = next }
        return text || ""
    }
    function imageFor(sessionId) { return images[sessionId] || ({ artifactId: "", versionId: "" }) }
    function clearImage(sessionId) { selectImage(sessionId, "", "") }
    function selectResearch(sessionId, runId, versionId) { const current=researchSelections[sessionId]||{},version=versionId||"";if((current.id||"")===(runId||"")&&(current.versionId||"")===version)return;const next = Object.assign({}, researchSelections); if (runId) next[sessionId] = { id: runId, versionId: version }; else delete next[sessionId]; researchSelections = next }
    function researchFor(sessionId) { return researchSelections[sessionId] || ({ id: "", versionId: "" }) }
    function activateSession(sessionId) { const selectedFile = fileFor(sessionId), selectedImage = imageFor(sessionId); file = selectedFile; changeSetId = changeSetFor(sessionId); artifactId = selectedImage.artifactId; versionId = selectedImage.versionId }
    function rootFor(sessionId) { return roots[sessionId] || "" }
    function setRoot(sessionId, rootId) { const next = Object.assign({}, roots); next[sessionId] = rootId; roots = next }
    function folder(sessionId, rootId) { return folders[sessionId + ":" + rootId] || "" }
    function setFolder(sessionId, rootId, path) { const next = Object.assign({}, folders); next[sessionId + ":" + rootId] = path; folders = next }
    function position(key) { return scroll[key] || 0 }
    function remember(key, y) { const next = Object.assign({}, scroll); next[key] = y; scroll = next }
    function draft(key, sessionId) { return editorDrafts[(sessionId ? sessionId + ":" : "") + key] }
    function keepDraft(key, value, sessionId) { const id = (sessionId ? sessionId + ":" : "") + key, next = Object.assign({}, editorDrafts); if (value === undefined) delete next[id]; else next[id] = value; editorDrafts = next }
    function fileDraft(sessionId, rootId, path) { return fileDrafts[sessionId + ":" + rootId + ":" + path] }
    function keepFileDraft(sessionId, rootId, path, value) { const id = sessionId + ":" + rootId + ":" + path, next = Object.assign({}, fileDrafts); if (value === undefined) delete next[id]; else next[id] = value; fileDrafts = next }
    /** Text the person chose to put in a conversation's message box, such as a filled-in MCP prompt. */
    signal insertIntoComposer(string sessionId, string text)
    function referencesFor(sessionId) { return references[sessionId] || [] }
    function setReferences(sessionId, list) { const next = Object.assign({}, references); next[sessionId] = list; references = next }
    function originalFilesFor(sessionId) { return originalFiles[sessionId] || [] }
    function setOriginalFiles(sessionId, list) { const next=Object.assign({},originalFiles);if(list&&list.length)next[sessionId]=list.slice(0,4);else delete next[sessionId];originalFiles=next }
    function addOriginalFile(sessionId, file) {
        if(!sessionId||!file?.id)return "Upload the original PDF first."
        const current=originalFilesFor(sessionId)
        if(current.some(value=>value.id===file.id))return ""
        if(current.length>=4)return "A message can include up to four original PDFs."
        setOriginalFiles(sessionId,current.concat([{id:file.id,name:file.name||"PDF"}]))
        return ""
    }
    // A recording another pane, or a time cited in a reply, asked to open; taken once by the Media pane.
    property var recordingTarget: null
    // Which account service the Accounts pane opens on.
    property string accountsService: ""
    function openAccounts(service) { accountsService = service; show("accounts") }
    function openRecording(sessionId, target) { recordingTarget = Object.assign({ sessionId: sessionId }, target); show("recordings") }
    function takeRecording(sessionId) { const target = recordingTarget; if (!target || target.sessionId !== sessionId) return null; recordingTarget = null; return target }
    // A page another pane asked the Canvas to show; taken once by the Canvas of that conversation.
    property var canvasTarget: null
    function openCanvas(sessionId, rootId, path) { canvasTarget = { sessionId: sessionId, rootId: rootId, path: path }; show("canvas") }
    function takeCanvasTarget(sessionId) { const target = canvasTarget; if (!target || target.sessionId !== sessionId) return null; canvasTarget = null; return target }
    property var analysisDrafts: ({})
    property var analysisTarget: null
    // A transcript anchor is consumed by Chat only after its conversation is active.
    property var messageTarget: null
    function openAnalysis(sessionId, target) {
        if (!sessionId) return
        App.selectedId = sessionId
        analysisTarget = Object.assign({sessionId: sessionId}, target)
        show("runs")
    }
    function openMessage(sessionId, messageId) {
        if (!sessionId || !messageId) return
        messageTarget = { sessionId: sessionId, messageId: messageId }
        App.select(sessionId)
        hide()
    }
    function runBaselineFor(sessionId) { return runBaselines[sessionId] || null }
    function setRunBaseline(sessionId, operation) { const next = Object.assign({}, runBaselines); if (operation) next[sessionId] = operation; else delete next[sessionId]; runBaselines = next }
    function noteState(project) { return noteStates[project] }
    function keepNoteState(project, value) { const next = Object.assign({}, noteStates); next[project] = value; noteStates = next }
}
