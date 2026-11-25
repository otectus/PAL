import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Workbench › Notes: a desktop-owned library of revisioned notes plus a derived Daybook.
// Legacy project scratchpads remain first-class library entries and keep their conflict behavior.
Item {
    id: notes
    objectName: "notesPane"
    implicitHeight: paneLayout.implicitHeight
    property string sessionId: ""
    readonly property string project: (App.session && App.session.id === sessionId) ? App.session.cwd : ""
    property string activeNoteId: ""
    property string activeProject: ""
    property string activeTitle: ""
    property string activeKind: "scratchpad"
    property bool applyingState: false
    property int operationSerial: 0
    property string revision: "0"
    property string saved: ""
    property bool conflictActive: false
    property string conflictRevision: ""
    property string conflictText: ""
    property bool saving: false
    property bool recordLoaded: false
    property bool ready: false
    property string error: ""
    property var library: []
    property bool libraryLoading: false
    property string libraryFilter: ""
    readonly property bool compact: width < Theme.settingsBreakpoint
    property bool compactLibraryVisible: false
    property bool daybookExpanded: false
    property bool noteMutationPending: false
    property var day: ({ items: [] })
    property date date: new Date()

    RpcClient { id: rpc; scope: notes.sessionId }

    function iso(d) { const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return local.toISOString().slice(0, 10) }
    function modifiedLabel(time) { return time ? "Modified " + new Date(time).toLocaleString(Qt.locale(), Locale.ShortFormat) : "Not saved yet" }
    function keyFor(target) { return target.kind === "scratchpad" ? target.project : target.id }
    function activeKey() { return activeKind === "scratchpad" ? activeProject : activeNoteId }
    function emptyState(target) {
        return { id: target && target.id || "", kind: target && target.kind || "scratchpad",
            project: target && target.project || "", title: target && target.title || "",
            revision: "0", saved: "", draft: "", edited: false, conflictActive: false,
            conflictRevision: "", conflictText: "", saving: false, error: "", saveToken: 0,
            loaded: false, loadToken: 0 }
    }
    function stateFor(key, target) {
        let state = WorkbenchState.noteState(key)
        if (!state) { state = emptyState(target); WorkbenchState.keepNoteState(key, state) }
        if (target) {
            if (target.id) state.id = target.id
            if (target.kind) state.kind = target.kind
            if (target.project) state.project = target.project
            if (target.title) state.title = target.title
        }
        return state
    }
    function storeActiveState() {
        const key = activeKey()
        if (!key || applyingState) return
        const state = stateFor(key)
        state.id = activeNoteId; state.kind = activeKind; state.project = activeProject; state.title = activeTitle
        state.revision = revision; state.saved = saved; state.draft = editor.text
        state.edited = state.edited || editor.text !== saved
        state.conflictActive = conflictActive; state.conflictRevision = conflictRevision
        state.conflictText = conflictText; state.saving = saving; state.error = error
    }
    function showState(key) {
        const state = key ? stateFor(key) : emptyState()
        applyingState = true
        revision = state.revision; saved = state.saved; editor.text = state.draft
        conflictActive = state.conflictActive; conflictRevision = state.conflictRevision
        conflictText = state.conflictText; saving = state.saving; error = state.error; recordLoaded = state.loaded
        applyingState = false
    }
    function syncIfActive(key) {
        if (activeKey() !== key) return
        const state = stateFor(key)
        activeNoteId = state.id; activeProject = state.project; activeTitle = state.title; activeKind = state.kind
        showState(key)
    }
    function applyRecord(key, value) {
        const state = stateFor(key)
        state.id = value.id; state.kind = value.kind; state.project = value.project; state.title = value.title
        state.revision = value.revision; state.saved = value.text; state.loaded = true; state.error = ""
        if (!state.edited) state.draft = value.text
        state.edited = state.draft !== state.saved
        state.conflictActive = false; state.conflictRevision = ""; state.conflictText = ""
        state.submitted = undefined
    }
    function loadNote(key) {
        const state = stateFor(key)
        const token = ++operationSerial
        state.loadToken = token
        const method = state.id ? "notebook.get" : "notebook.scratchpad"
        const parameters = state.id ? { id: state.id } : { project: state.project }
        rpc.call(method, parameters, value => {
            const current = WorkbenchState.noteState(key)
            if (!current || current.loadToken !== token) return
            if (value.error) current.error = value.error
            else if (current.edited && current.loaded && current.draft !== value.text && current.submitted !== value.text && current.revision !== value.revision) {
                // Keep the cached draft intact, but expose the newly fetched version as a real conflict.
                current.id = value.id; current.kind = value.kind; current.project = value.project; current.title = value.title
                current.conflictText = value.text; current.conflictRevision = value.revision
                current.conflictActive = true; current.error = ""
            } else applyRecord(key, value)
            syncIfActive(key)
            if (!value.error && current.edited && !current.conflictActive && current.draft !== current.saved) {
                if (activeKey() === key) autosave.restart()
                else saveState(key)
            }
        })
    }
    function activate(target) {
        if (!target || !target.project) return
        autosave.stop()
        const previousKey = activeKey()
        storeActiveState()
        if (previousKey) {
            const previous = stateFor(previousKey)
            if (!previous.conflictActive && previous.draft !== previous.saved)
                Qt.callLater(() => saveState(previousKey))
        }
        activeNoteId = target.id || ""; activeProject = target.project; activeTitle = target.title || ""
        activeKind = target.kind || "scratchpad"
        const key = keyFor({ id: activeNoteId, project: activeProject, kind: activeKind })
        const selected = stateFor(key, { id: activeNoteId, project: activeProject, title: activeTitle, kind: activeKind })
        // A cached project scratchpad already knows its stable id and title. Restore those before
        // the refresh completes so rename/delete never disappear while returning to it.
        activeNoteId = selected.id; activeProject = selected.project; activeTitle = selected.title; activeKind = selected.kind
        showState(key)
        loadNote(key)
        if (compact) compactLibraryVisible = false
    }
    function activateScratchpad(targetProject) {
        if (targetProject) activate({ id: "", kind: "scratchpad", project: targetProject, title: "" })
    }
    function retryPendingNotes() {
        for (const key of Object.keys(WorkbenchState.noteStates)) {
            const state = stateFor(key)
            if (state.saving) { state.saveToken++; state.saving = false }
            // The previous pane may have submitted this draft just before its callbacks went away.
            // Reconcile the stored revision before retrying. activate() already loads the active note.
            if (key !== activeKey() && state.project && !state.conflictActive && state.draft !== state.saved) loadNote(key)
        }
    }
    function loadLibrary() {
        libraryLoading = true
        rpc.call("notebook.list", {}, value => {
            libraryLoading = false
            if (value.error) { error = value.error; return }
            library = value.notes || []
        })
    }
    function visibleNotes() {
        let rows = library.slice()
        const key = activeKey()
        if (key && !rows.some(row => keyFor(row) === key)) rows.unshift({ id: activeNoteId, kind: activeKind, project: activeProject, title: activeTitle || "Current project scratchpad", revision: revision, updated: 0, preview: editor.text.slice(0, 180) })
        const query = libraryFilter.trim().toLocaleLowerCase()
        if (!query) return rows
        return rows.filter(row => (row.title + " " + row.project + " " + (row.preview || "")).toLocaleLowerCase().includes(query))
    }
    function moveDay(offset) {
        const next = new Date(date)
        next.setDate(next.getDate() + offset)
        date = next
        loadDay()
    }
    function loadDay() {
        const requestedDate = iso(date)
        rpc.call("notebook.day", { date: requestedDate, offsetMinutes: date.getTimezoneOffset() }, value => {
            if (!value.error && requestedDate === iso(notes.date)) notes.day = value
        })
    }
    function saveState(key) {
        const state = stateFor(key)
        if (!state.project || state.conflictActive || state.saving || state.draft === state.saved) return
        const token = ++state.saveToken
        const submitted = state.draft
        state.submitted = submitted
        state.saving = true; state.error = ""; syncIfActive(key)
        const method = state.kind === "scratchpad" ? "notebook.save" : "notebook.saveNote"
        const parameters = state.kind === "scratchpad"
            ? { project: state.project, text: state.draft, expectedRevision: state.revision }
            : { id: state.id, text: state.draft, expectedRevision: state.revision }
        rpc.call(method, parameters, value => {
            const current = WorkbenchState.noteState(key)
            if (!current || current.saveToken !== token) return
            current.saving = false
            if (value.error) {
                current.error = value.error
                if (value.code === "REVISION_CONFLICT") {
                    const conflictToken = ++current.loadToken
                    const loadMethod = current.kind === "scratchpad" ? "notebook.scratchpad" : "notebook.get"
                    const loadParameters = current.kind === "scratchpad" ? { project: current.project } : { id: current.id }
                    rpc.call(loadMethod, loadParameters, remote => {
                        const latest = WorkbenchState.noteState(key)
                        if (!latest || latest.loadToken !== conflictToken) return
                        if (remote.error) latest.error = remote.error
                        else if (remote.text === submitted || remote.text === latest.draft) {
                            // The preceding pane's save reached the broker before it was destroyed.
                            applyRecord(key, remote)
                            latest.conflictActive = false
                            if (latest.edited) Qt.callLater(() => saveState(key))
                        } else {
                            latest.conflictText = remote.text; latest.conflictRevision = remote.revision
                            latest.conflictActive = true; latest.error = ""; latest.loaded = true
                            latest.title = remote.title
                        }
                        syncIfActive(key)
                    })
                }
            } else {
                current.id = value.id; current.title = value.title; current.revision = value.revision; current.saved = value.text; current.loaded = true
                current.edited = current.draft !== current.saved; current.error = ""; current.submitted = undefined
                current.conflictActive = false; current.conflictRevision = ""; current.conflictText = ""
                if (current.edited) {
                    if (activeKey() === key) autosave.restart()
                    else Qt.callLater(() => saveState(key))
                }
                loadLibrary()
            }
            syncIfActive(key)
        })
    }
    function save() { if (noteMutationPending) return; storeActiveState(); const key = activeKey(); if (key) saveState(key) }
    function resolveKeepMine() {
        storeActiveState(); const key = activeKey(), state = stateFor(key)
        state.conflictActive = false; state.revision = state.conflictRevision; state.saved = state.conflictText
        saveState(key)
    }
    function resolveUseTheirs() {
        const key = activeKey(), state = stateFor(key)
        state.draft = state.conflictText; state.saved = state.conflictText; state.revision = state.conflictRevision
        state.edited = false; state.conflictActive = false; state.conflictRevision = ""; state.conflictText = ""; state.error = ""
        showState(key)
    }
    function resolveCombine() {
        storeActiveState(); const key = activeKey(), state = stateFor(key)
        state.draft = state.conflictText + (state.conflictText && state.draft ? "\n\n" : "") + state.draft
        state.conflictActive = false; state.revision = state.conflictRevision
        showState(key); saveState(key)
    }
    function showCreateDialog() {
        createTitle.text = "Untitled note"; createError.text = ""
        createDialog.open(); createTitle.forceActiveFocus(); createTitle.selectAll()
    }
    function createNote() {
        if (noteMutationPending) return
        noteMutationPending = true
        createError.text = ""
        rpc.call("notebook.create", { project: project, title: createTitle.text }, value => {
            noteMutationPending = false
            if (value.error) { createError.text = value.error; return }
            const state = emptyState(value); state.loaded = true
            WorkbenchState.keepNoteState(value.id, state)
            createDialog.close(); loadLibrary(); activate(value); compactLibraryVisible = false; editor.forceActiveFocus()
        })
    }
    function renameNote() {
        if (noteMutationPending) return
        noteMutationPending = true
        renameError.text = ""
        rpc.call("notebook.rename", { id: activeNoteId, title: renameTitle.text }, value => {
            noteMutationPending = false
            if (value.error) { renameError.text = value.error; return }
            activeTitle = value.title; stateFor(activeKey()).title = value.title
            renameDialog.close(); loadLibrary()
        })
    }
    function deleteNote() {
        if (noteMutationPending) return
        noteMutationPending = true
        autosave.stop(); storeActiveState()
        deleteError.text = ""
        const deletingKey = activeKey(), deletingId = activeNoteId, deletingRevision = revision
        rpc.call("notebook.delete", { id: deletingId, expectedRevision: deletingRevision }, value => {
            noteMutationPending = false
            if (value.error) { deleteError.text = value.error; if (editor.text !== saved) autosave.restart(); return }
            const next = Object.assign({}, WorkbenchState.noteStates); delete next[deletingKey]; WorkbenchState.noteStates = next
            // Detach before activation: activate() begins by storing its old selection, and must not
            // resurrect the just-deleted cached draft under the same key.
            applyingState = true
            activeNoteId = ""; activeProject = ""; activeTitle = ""; activeKind = "scratchpad"
            revision = "0"; saved = ""; editor.text = ""; conflictActive = false; conflictRevision = ""; conflictText = ""; saving = false; error = ""
            applyingState = false
            deleteDialog.close(); loadLibrary(); activateScratchpad(project); compactLibraryVisible = false
        })
    }

    Timer { id: autosave; interval: 1200; onTriggered: notes.save() }
    onProjectChanged: if (ready && activeKind === "scratchpad") activateScratchpad(project)
    onSessionIdChanged: {
        if (!ready) return
        const key = activeKey()
        if (key) {
            storeActiveState(); const state = stateFor(key)
            if (state.saving) { state.saveToken++; state.saving = false; saving = false }
            if (!state.conflictActive && state.draft !== state.saved) autosave.restart()
        }
        loadLibrary(); loadDay()
    }
    onVisibleChanged: if (ready && !visible && !conflictActive) save()
    Component.onCompleted: { ready = true; activateScratchpad(project); retryPendingNotes(); loadLibrary(); loadDay() }
    Connections { target: App; function onFlushDrafts() { if (notes.ready) notes.save() } }
    Component.onDestruction: storeActiveState()

    component NoteIconButton: CButton {
        quiet: true
        implicitWidth: Theme.compactHeight
        implicitHeight: Theme.compactHeight
        leftPadding: 0; rightPadding: 0; topPadding: 0; bottomPadding: 0
    }

    RowLayout {
        id: paneLayout
        anchors.fill: parent; spacing: Theme.space3
        ColumnLayout {
            visible: !notes.compact || notes.compactLibraryVisible
            Layout.preferredWidth: notes.compact ? notes.width : Math.min(Theme.fieldLong, Math.max(Theme.fieldWidth, notes.width * 0.3)); Layout.fillWidth: notes.compact; Layout.fillHeight: true; spacing: Theme.space2
            RowLayout { Layout.fillWidth: true; spacing: Theme.space2
                NoteIconButton { objectName: "closeNoteLibrary"; visible: notes.compact; iconName: "back"; help: qsTr("Back to note"); onClicked: { notes.compactLibraryVisible = false; libraryButton.forceActiveFocus(Qt.TabFocusReason) } }
                CText { text: qsTr("Note library"); font.pixelSize: Theme.section; font.weight: Font.DemiBold; wrapMode: Text.NoWrap; elide: Text.ElideRight; Accessible.role: Accessible.Heading }
                CButton { objectName: "newNote"; text: qsTr("New note"); iconName: "plus"; implicitHeight: Theme.compactHeight; enabled: !!notes.project && App.connected && !notes.noteMutationPending; onClicked: notes.showCreateDialog() }
            }
            CField { id: noteSearch; objectName: "noteLibrarySearch"; Layout.fillWidth: true; placeholderText: "Find notes…"; onTextChanged: notes.libraryFilter = text; Accessible.name: "Search your notes" }
            CText { visible: notes.libraryLoading; text: "Loading notes…"; color: Theme.muted; font.pixelSize: Theme.caption }
            CText { visible: !notes.libraryLoading && noteList.count === 0; text: notes.libraryFilter ? "No matching notes." : "Create a note or start typing in this project's scratchpad."; color: Theme.muted; wrapMode: Text.Wrap; Layout.fillWidth: true }
            ListView {
                id: noteList; objectName: "noteLibrary"; Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorShort; clip: true; spacing: Theme.space1
                model: notes.visibleNotes()
                delegate: CButton {
                    id: libraryEntry
                    required property var modelData
                    required property int index
                    objectName: "noteLibraryItem_" + index
                    width: ListView.view.width; text: modelData.title || "Untitled note"; alignLeft: true; quiet: notes.keyFor(modelData) !== notes.activeKey(); primary: notes.keyFor(modelData) === notes.activeKey(); implicitHeight: Theme.rowDetailHeight
                    help: (modelData.preview ? modelData.preview + "\n" : "") + modelData.project
                    Accessible.description: (modelData.kind === "scratchpad" ? "Project scratchpad. " : "Note. ") + modelData.project
                    contentItem: Column {
                        spacing: Theme.space1
                        CText { width: libraryEntry.availableWidth; text: modelData.title || "Untitled note"; wrapMode: Text.NoWrap; elide: Text.ElideRight; font.weight: Font.DemiBold }
                        RowLayout {
                            width: libraryEntry.availableWidth; spacing: Theme.space2
                            CText { text: modelData.project; wrapMode: Text.NoWrap; elide: Text.ElideLeft; color: Theme.muted; font.pixelSize: Theme.caption }
                            CText { Layout.fillWidth: false; Layout.maximumWidth: libraryEntry.availableWidth * 0.58; text: notes.modifiedLabel(modelData.updated); wrapMode: Text.NoWrap; elide: Text.ElideRight; color: Theme.muted; font.pixelSize: Theme.caption }
                        }
                    }
                    onClicked: { notes.activate(modelData); editor.forceActiveFocus(Qt.TabFocusReason) }
                }
            }
        }
        Rectangle { visible: !notes.compact; Layout.fillHeight: true; Layout.preferredWidth: Theme.hairline; color: Theme.line }
        ColumnLayout {
            visible: !notes.compact || !notes.compactLibraryVisible
            Layout.fillWidth: true; Layout.fillHeight: true; spacing: Theme.space2
            ColumnLayout { Layout.fillWidth: true; spacing: 0; Layout.bottomMargin: Theme.space1
                RowLayout { Layout.fillWidth: true; spacing: Theme.space1
                    CText {
                        objectName: "activeNoteTitle"; text: notes.activeTitle || (notes.activeProject ? qsTr("Project scratchpad") : qsTr("No note selected"))
                        Layout.fillWidth: true
                        font.pixelSize: Theme.section; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading
                        wrapMode: Text.NoWrap; elide: Text.ElideRight
                        HoverHandler { id: titleHover }
                        ToolTip.visible: truncated && titleHover.hovered
                        ToolTip.text: text; ToolTip.delay: Theme.tooltipDelay
                    }
                    CButton {
                        id: libraryButton; objectName: "showNoteLibrary"; visible: notes.compact
                        text: qsTr("Library"); help: qsTr("Browse notes"); quiet: true; implicitHeight: Theme.compactHeight
                        onClicked: { notes.compactLibraryVisible = true; noteSearch.forceActiveFocus(Qt.TabFocusReason) }
                    }
                    NoteIconButton {
                        objectName: "newNote"; visible: notes.compact; iconName: "plus"; help: qsTr("New note")
                        enabled: !!notes.project && App.connected && !notes.noteMutationPending
                        onClicked: notes.showCreateDialog()
                    }
                    NoteIconButton {
                        id: actionsButton; objectName: "noteActions"; iconName: "more"; help: qsTr("Note actions")
                        enabled: !!notes.activeNoteId && App.connected && !notes.noteMutationPending
                        Accessible.expanded: actionsMenu.visible
                        onClicked: actionsMenu.popup(actionsButton, actionsButton.width - actionsMenu.width, actionsButton.height)
                        CMenu {
                            id: actionsMenu; focus: true
                            CMenuItem {
                                objectName: "renameNote"; text: qsTr("Rename…")
                                onTriggered: { renameTitle.text = notes.activeTitle; renameError.text = ""; renameDialog.open(); renameTitle.forceActiveFocus(); renameTitle.selectAll() }
                            }
                            CMenuItem {
                                objectName: "deleteNote"; text: qsTr("Delete…"); enabled: !notes.saving
                                onTriggered: { deleteError.text = ""; deleteDialog.open() }
                            }
                        }
                    }
                }
                RowLayout { visible: !!notes.activeProject; Layout.fillWidth: true; spacing: Theme.space1
                    CIcon { name: "projects"; color: Theme.muted; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall }
                    CText {
                        objectName: "noteProjectPath"; text: notes.activeProject; color: Theme.muted
                        font.pixelSize: Theme.caption; wrapMode: Text.NoWrap; elide: Text.ElideMiddle
                        Accessible.description: notes.activeKind === "scratchpad" ? qsTr("Project scratchpad") : qsTr("Project for this note")
                        HoverHandler { id: pathHover }
                        ToolTip.visible: truncated && pathHover.hovered
                        ToolTip.text: text; ToolTip.delay: Theme.tooltipDelay
                    }
                }
            }
            ScrollView {
                id: editorViewport
                Layout.fillWidth: true; Layout.fillHeight: !notes.daybookExpanded; Layout.preferredHeight: notes.daybookExpanded ? Theme.editorTall : Theme.narrowPane; Layout.minimumHeight: Theme.editorShort
                clip: true; contentWidth: availableWidth
                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                ScrollBar.vertical: CScrollBar {}
                CTextArea {
                    id: editor; objectName: "scratchpadEditor"
                    placeholderText: notes.activeProject ? qsTr("Start writing…") : qsTr("Choose a note from the library")
                    font.pixelSize: Theme.message
                    leftPadding: Theme.space4; rightPadding: Theme.space4
                    topPadding: Theme.space3; bottomPadding: Theme.space3
                    readOnly: !notes.activeProject
                    persistentSelection: true
                    onTextChanged: {
                        if (notes.applyingState || !notes.activeKey()) return
                        const state = notes.stateFor(notes.activeKey())
                        state.draft = text; state.edited = state.draft !== state.saved
                        if (activeFocus && !state.conflictActive) autosave.restart()
                    }
                    Accessible.name: "Your note draft"
                    Accessible.description: qsTr("Edits save automatically. To share text, copy it and paste it into chat.")
                }
            }
            RowLayout { Layout.fillWidth: true; spacing: Theme.space2
                CText {
                    objectName: "scratchpadSaveStatus"; color: notes.conflictActive ? Theme.amber : Theme.muted; font.pixelSize: Theme.caption
                    text: {
                        if (!notes.activeProject) return ""
                        if (notes.conflictActive) return qsTr("Autosave paused")
                        if (notes.saving) return qsTr("Saving…")
                        if (editor.text !== notes.saved) return notes.error || !App.connected ? qsTr("Unsaved changes") : qsTr("Waiting to save…")
                        if (notes.error || !App.connected) return ""
                        if (!notes.recordLoaded) return qsTr("Opening note…")
                        return !notes.saved && notes.revision === "0" ? qsTr("Saves as you type") : qsTr("Saved")
                    }
                    Accessible.description: notes.recordLoaded ? qsTr("Saved revision %1").arg(notes.revision) : ""
                    HoverHandler { id: statusHover }
                    ToolTip.visible: statusHover.hovered && notes.recordLoaded && notes.revision !== "0"
                    ToolTip.text: Accessible.description; ToolTip.delay: Theme.tooltipDelay
                }
                CButton {
                    objectName: "copyNote"; text: editor.selectedText ? qsTr("Copy selection") : qsTr("Copy note"); iconName: "copy"; quiet: true
                    implicitHeight: Theme.compactHeight; enabled: editor.length > 0
                    help: qsTr("Copy to the clipboard to paste into chat")
                    onClicked: App.copy(editor.selectedText || editor.text)
                }
            }
            ColumnLayout {
                visible: notes.conflictActive; Layout.fillWidth: true
                CText { objectName: "scratchpadConflictChoice"; text: "This note changed on another device. Both versions are kept until you choose."; color: Theme.amber; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
                CText { text: "Theirs · revision " + notes.conflictRevision; font.weight: Font.DemiBold; font.pixelSize: Theme.caption }
                ScrollView {
                    id: conflictViewport
                    Layout.fillWidth: true; Layout.preferredHeight: Theme.editorShort; clip: true; contentWidth: availableWidth
                    ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                    ScrollBar.vertical: CScrollBar {}
                    CTextArea { readOnly: true; rightPadding: Theme.space4; text: notes.conflictText; placeholderText: "Their version is empty."; Accessible.name: "Note version from the other device" }
                }
                Flow {
                    Layout.fillWidth: true; spacing: Theme.space1
                    CButton { objectName: "scratchpadKeepMine"; width: Math.min(implicitWidth, parent.width); text: "Keep mine"; enabled: !notes.saving; onClicked: notes.resolveKeepMine() }
                    CButton { objectName: "scratchpadUseTheirs"; width: Math.min(implicitWidth, parent.width); text: "Use theirs"; enabled: !notes.saving; onClicked: notes.resolveUseTheirs() }
                    CButton { objectName: "scratchpadCombine"; width: Math.min(implicitWidth, parent.width); text: "Combine"; enabled: !notes.saving; onClicked: notes.resolveCombine() }
                }
            }
            CText { visible: !!notes.error && !notes.conflictActive; text: notes.error; color: Theme.danger; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
            RowLayout { Layout.fillWidth: true; spacing: Theme.space1
                CButton {
                    objectName: "toggleDaybook"; text: qsTr("Daybook"); iconName: notes.daybookExpanded ? "down" : "chevron"
                    quiet: true; alignLeft: true; leftPadding: 0; implicitHeight: Theme.compactHeight; Layout.fillWidth: true
                    Accessible.expanded: notes.daybookExpanded
                    onClicked: notes.daybookExpanded = !notes.daybookExpanded
                }
                NoteIconButton {
                    visible: notes.daybookExpanded; iconName: "back"; help: qsTr("Previous day")
                    onClicked: notes.moveDay(-1)
                }
                CText { text: notes.iso(notes.date); Layout.fillWidth: false; color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.NoWrap }
                NoteIconButton {
                    visible: notes.daybookExpanded; iconName: "arrow"; help: qsTr("Next day")
                    onClicked: notes.moveDay(1)
                }
            }
            ListView {
                visible: notes.daybookExpanded; Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: visible ? Theme.editorShort : 0; clip: true; spacing: Theme.space1; model: notes.day.items || []
                delegate: CText { required property var modelData; width: ListView.view.width; elide: Text.ElideRight; font.pixelSize: Theme.secondary
                    text: new Date(modelData.time).toLocaleTimeString(Qt.locale(), Locale.ShortFormat) + " · " + modelData.kind + " · " + modelData.title }
            }
        }
    }

    CDialog {
        id: createDialog; objectName: "createNoteDialog"; accessibleTitle: "Create note"
        CText { text: "Create a note"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Layout.fillWidth: true }
        CText { text: "The note stays in your desktop library and can be opened from any conversation."; color: Theme.muted; wrapMode: Text.Wrap; Layout.fillWidth: true }
        CField { id: createTitle; objectName: "newNoteTitle"; Layout.fillWidth: true; placeholderText: "Note title"; maximumLength: 120; onAccepted: if (text.trim()) notes.createNote() }
        CText { id: createError; visible: !!text; color: Theme.danger; wrapMode: Text.Wrap; Layout.fillWidth: true }
        RowLayout { Layout.fillWidth: true
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: createDialog.close() }
            CButton { objectName: "confirmNewNote"; text: notes.noteMutationPending ? "Creating…" : "Create"; primary: true; Layout.fillWidth: true; enabled: !!createTitle.text.trim() && !notes.noteMutationPending; onClicked: notes.createNote() }
        }
    }
    CDialog {
        id: renameDialog; objectName: "renameNoteDialog"; accessibleTitle: "Rename note"
        CText { text: "Rename note"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Layout.fillWidth: true }
        CField { id: renameTitle; objectName: "renameNoteTitle"; Layout.fillWidth: true; placeholderText: "Note title"; maximumLength: 120; onAccepted: if (text.trim()) notes.renameNote() }
        CText { id: renameError; visible: !!text; color: Theme.danger; wrapMode: Text.Wrap; Layout.fillWidth: true }
        RowLayout { Layout.fillWidth: true
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: renameDialog.close() }
            CButton { objectName: "confirmRenameNote"; text: notes.noteMutationPending ? "Renaming…" : "Rename"; primary: true; Layout.fillWidth: true; enabled: !!renameTitle.text.trim() && !notes.noteMutationPending; onClicked: notes.renameNote() }
        }
    }
    CDialog {
        id: deleteDialog; objectName: "deleteNoteDialog"; accessibleTitle: "Delete note"
        CText { text: "Delete “" + (notes.activeTitle || "this note") + "”?"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; wrapMode: Text.Wrap; Layout.fillWidth: true }
        CText { text: "This permanently deletes the note and its saved revision history from this desktop."; color: Theme.amber; wrapMode: Text.Wrap; Layout.fillWidth: true }
        CText { id: deleteError; visible: !!text; color: Theme.danger; wrapMode: Text.Wrap; Layout.fillWidth: true }
        RowLayout { Layout.fillWidth: true
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: deleteDialog.close() }
            CButton { objectName: "confirmDeleteNote"; text: notes.noteMutationPending ? "Deleting…" : "Delete note"; danger: true; Layout.fillWidth: true; enabled: !notes.noteMutationPending; onClicked: notes.deleteNote() }
        }
    }
}
