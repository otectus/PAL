pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Images: this conversation's images and files, a Create panel that works whatever the chat
// model can do, and the image editor. Removing a card from the conversation is not deleting a file
// someone exported elsewhere; each has its own action.
Item {
    id: browser
    objectName: "artifactBrowser"
    implicitHeight: browser.editing ? imageEditor.implicitHeight : browser.creating ? Math.max(Theme.defaultWindowHeight, Math.ceil(browserLayout.implicitHeight) + Theme.space1) : Math.ceil(browserLayout.implicitHeight) + Theme.space1
    property string sessionId: ""
    property var items: []
    property var before: undefined
    property var collections: []
    property string scope: "session"
    property string collection: ""
    property string filter: "image"
    property string source: ""
    property string error: ""
    property string notice: ""
    property var thumbnails: ({})
    property var thumbnailPending: ({})
    property var selected: null
    property var details: null
    property string selectedVersionId: ""
    property var checkedIds: ({})
    property var connections: []
    property var capabilities: null
    property var target: null
    property var references: []
    property var mask: null
    property var maskBase: null
    property var operations: []
    property var partials: ({})
    property var candidatePreviews: ({})
    property var candidatePreviewPending: ({})
    property bool similarMode: false
    property bool indexing: false
    property var indexBefore: undefined
    property int indexedCount: 0
    property int skippedIndexCount: 0
    property string pendingReplay: ""
    property string readyRecipeId: ""
    property var pendingProduction: null
    property int listEpoch: 0
    property int detailEpoch: 0
    property int operationEpoch: 0
    property int actionEpoch: 0
    property int capabilityEpoch: 0
    property bool listing: false
    property bool submitting: false
    property bool filtersExpanded: false
    property bool scopeKnown: false
    property bool scopeHasAny: false
    property int probeEpoch: 0
    property bool creating: WorkbenchState.createRequested
    readonly property var imageSelection: WorkbenchState.imageFor(sessionId)
    property bool editing: !!imageSelection.artifactId && !!imageSelection.versionId
    readonly property var checkedItems: items.filter(item => !!checkedIds[item.id])
    readonly property var checkedImages: checkedItems.filter(item => item.kind === "image" || item.kind === "plot")
    readonly property var selectedRef: selected ? ({ artifactId: selected.id, versionId: selectedVersionId || selected.latestVersionId, name: selected.name }) : null
    readonly property bool maskMatchesTarget: !mask || (!!target && !!maskBase && target.artifactId === maskBase.artifactId && target.versionId === maskBase.versionId)
    readonly property bool genuineEmpty: scope === "session" && scopeKnown && !scopeHasAny && !listing
    readonly property bool sharedEmpty: scope === "project" && scopeKnown && !scopeHasAny && !listing
    readonly property bool filteredEmpty: scopeKnown && scopeHasAny && !items.length && !listing
    signal setupRequested()
    RpcClient { id: rpc; scope: browser.sessionId }
    function refresh(reset) {
        if (!sessionId || listing && reset === false) return
        const stable = reset === "stable", replace = reset !== false
        const owner = sessionId, epoch = ++listEpoch
        const wanted = stable ? Math.max(24, items.length) : 24
        const params = { sessionId: owner, scope: scope, kind: filter, source: source, query: query.text, collection: collection }
        listing = true
        function read(cursor, loaded) {
            const request = Object.assign({ limit: Math.min(200, wanted - loaded.length) }, params)
            if (cursor) request.before = cursor
            rpc.call("artifacts.list", request, value => {
                if (sessionId !== owner || epoch !== listEpoch) return
                if (value.error) { listing = false; error = value.error; return }
                const page = loaded.concat(value.artifacts || [])
                if (value.before && page.length < wanted) { read(value.before, page); return }
                const priorSelection = selected?.id
                items = replace ? page : items.concat(page.filter(fresh => !items.some(existing => existing.id === fresh.id)))
                before = value.before
                collections = value.collections || []; error = ""; similarMode = false; listing = false
                if (priorSelection && !items.some(item => item.id === priorSelection)) {
                    selected = null; details = null; selectedVersionId = ""; detailEpoch++
                }
                for (const item of page) if (!thumbnails[item.latestVersionId] && (item.kind === "image" || item.kind === "plot")) fetchThumb(item.id, item.latestVersionId)
            })
        }
        read(replace ? undefined : before, [])
        rpc.call("images.connections", {}, value => {
            if (sessionId !== owner || value.error) return
            connections = value.connections || []
            if (connections.length && !capabilities) loadCapabilities(connections[0].id)
        })
        if (replace) probeScope(owner)
    }
    function probeScope(owner) {
        const epoch = ++probeEpoch, probedScope = scope
        scopeKnown = false
        rpc.call("artifacts.list", { sessionId: owner, scope: probedScope, limit: 1 }, value => {
            if (sessionId !== owner || scope !== probedScope || epoch !== probeEpoch) return
            scopeKnown = !value.error
            scopeHasAny = !value.error && (value.artifacts || []).length > 0
        })
    }
    function fetchThumb(artifactId, versionId) {
        if (thumbnails[versionId] || thumbnailPending[versionId]) return
        const owner = sessionId
        const started = Object.assign({}, thumbnailPending)
        started[versionId] = true
        thumbnailPending = started
        rpc.call("artifacts.thumbnail", { sessionId: owner, artifactId: artifactId, versionId: versionId, size: 192 }, value => {
            if (sessionId !== owner) return
            const pending = Object.assign({}, thumbnailPending)
            delete pending[versionId]
            thumbnailPending = pending
            if (value.error || !value.data) return
            const next = Object.assign({}, thumbnails)
            next[versionId] = value.data
            thumbnails = next
        })
    }
    function select(item) {
        selected = item; selectedVersionId = item.latestVersionId
        details = null
        const owner = sessionId, artifactId = item.id, epoch = ++detailEpoch
        rpc.call("artifacts.get", { sessionId: owner, artifactId: artifactId }, value => {
            if (sessionId !== owner || epoch !== detailEpoch || selected?.id !== artifactId) return
            if (!value.error) {
                details = value
                for (const version of value.versions || []) if (!thumbnails[version.versionId]) fetchThumb(artifactId, version.versionId)
            }
        })
        shareSelection()
    }
    function shareSelection() {
        const isImage = selected?.kind === "image" || selected?.kind === "plot"
        App.rpc("images.select", { sessionId: sessionId, ref: isImage ? selectedRef : null })
    }
    function chooseVersion(versionId) {
        selectedVersionId = versionId
        if (checkedIds[selected.id]) {
            const next = Object.assign({}, checkedIds)
            next[selected.id] = versionId
            checkedIds = next
        }
        shareSelection()
    }
    function selectedRefs(limit) {
        if (!checkedItems.length) return selectedRef ? [selectedRef] : []
        return checkedItems.slice(0, limit || 16).map(item => ({ artifactId: item.id, versionId: checkedIds[item.id] || item.latestVersionId, name: item.name }))
    }
    function selectedImageRefs(limit) {
        if (!checkedImages.length) return selected && (selected.kind === "image" || selected.kind === "plot") ? [selectedRef] : []
        return checkedImages.slice(0, limit || 16).map(item => ({ artifactId: item.id, versionId: checkedIds[item.id] || item.latestVersionId, name: item.name }))
    }
    function setChecked(item, checked) {
        const next = Object.assign({}, checkedIds)
        if (checked) next[item.id] = item.id === selected?.id ? selectedVersionId || item.latestVersionId : item.latestVersionId; else delete next[item.id]
        checkedIds = next
    }
    function setTarget(ref) {
        target = Object.assign({}, ref); creating = true
        if (mask && (!maskBase || maskBase.versionId !== ref.versionId)) notice = "This mask belongs to another version. Restore its exact target or clear the mask."
    }
    function addGuide(ref, role) {
        references = references.filter(value => value.role !== role && value.versionId !== ref.versionId).concat([Object.assign({}, ref, { role: role })])
        creating = true
    }
    function useInChat(ref, text) {
        const failure = WorkbenchState.useImage(sessionId, ref, text || "")
        if (failure) error = failure; else notice = text ? "Image and question added to your draft." : "Exact image version added to your draft."
    }
    function compare(refs) {
        if (refs.length < 2) { notice = "Select two images or versions to compare."; return }
        WorkbenchState.compareImages(sessionId, refs[0], refs[1])
    }
    function contactSheet() {
        const refs = selectedImageRefs(16), owner = sessionId, epoch = ++actionEpoch
        if (!refs.length || submitting) return
        submitting = true
        rpc.call("images.contactSheet", { sessionId: owner, items: refs }, value => {
            if (sessionId !== owner || epoch !== actionEpoch) { submitting = false; return }
            submitting = false
            if (value.error) { error = value.error; return }
            notice = "Contact sheet added to this conversation."; refresh(true)
            WorkbenchState.selectImage(owner, value.artifactId, value.versionId)
        })
    }
    function openProduction(refs) {
        const chosen = refs || [], panel = productionLoader.item
        if (panel) panel.openFor(chosen); else pendingProduction = chosen
    }
    function findSimilar(item, versionId) {
        const owner = sessionId, epoch = ++listEpoch
        const chosenVersion = versionId || item.latestVersionId
        rpc.call("images.similar", { sessionId: owner, artifactId: item.id, versionId: chosenVersion, scope: scope }, value => {
            if (sessionId !== owner || epoch !== listEpoch) return
            if (value.error) { error = value.error; return }
            items = value.artifacts || []; before = undefined; checkedIds = ({}); similarMode = true
            notice = "Showing images similar to “" + item.name + "”."
            for (const row of items) if (!thumbnails[row.latestVersionId]) fetchThumb(row.id, row.latestVersionId)
        })
    }
    function selectedVersion() {
        if (!details) return null
        return (details.versions || []).find(value => value.versionId === selectedVersionId) || (details.versions || []).slice(-1)[0] || null
    }
    function openParent(ref) {
        const selectedId = selectedVersionId
        rpc.call("artifacts.get", { sessionId: sessionId, artifactId: ref.artifactId }, value => {
            if (selectedVersionId !== selectedId) return
            if (value.error) error = value.error
            else openItem(value.artifact, ref.versionId)
        })
    }
    function selectComboValue(combo, value) {
        if (value === undefined || value === null || value === "") return
        for (let index = 0; index < combo.count; ++index) if (String(combo.textAt(index)) === String(value)) { combo.currentIndex = index; return }
        if (combo.editable) combo.editText = String(value)
    }
    function applyRecipeControls(recipe, mode, chosen, originalTarget) {
        const request = recipe.request || {}, nextTarget = mode === "branch" ? Object.assign({}, chosen) : target
        const sameTarget = !!nextTarget && !!originalTarget && nextTarget.artifactId === originalTarget.artifactId && nextTarget.versionId === originalTarget.versionId
        const maskStillBound = sameTarget && !!maskBase && maskBase.artifactId === nextTarget.artifactId && maskBase.versionId === nextTarget.versionId
        if (!maskStillBound) { mask = null; maskBase = null }
        if (mode === "branch") {
            target = nextTarget || null
            references = (request.references || []).filter(ref => ref.role !== "target" && ref.role !== "edit-base").map(ref => Object.assign({}, ref, { name: ref.name || ref.versionId.slice(0, 8) }))
        }
        count.value = Math.max(count.from, Math.min(count.to, Number(request.count) || 1))
        sizeBox.currentIndex = 0; ratioBox.currentIndex = 0; resolutionBox.currentIndex = 0; qualityBox.currentIndex = 0; format.currentIndex = 0
        selectComboValue(sizeBox, request.size); selectComboValue(ratioBox, request.aspectRatio); selectComboValue(resolutionBox, request.imageSize)
        selectComboValue(qualityBox, request.quality); selectComboValue(format, request.format)
        negative.text = request.negativePrompt || ""; seedField.text = request.seed === undefined ? "" : String(request.seed)
        transparent.checked = request.background === "transparent"; protect.checked = request.protectOutside === true
        feather.value = request.mask?.feather === undefined ? 4 : request.mask.feather
        previews.checked = request.partials === true
        if (mode === "branch") prompt.text = request.prompt || prompt.text
        creating = true
        notice = mode === "branch" ? "Recipe settings loaded with this exact version as the new target." : "Recipe settings loaded. Review before generating."
    }
    function reuseRecipe(mode) {
        const version = selectedVersion(), provenance = version?.provenance || {}, operationId = provenance.operationId
        const owner = sessionId, chosen = selectedRef, originalTarget = target ? Object.assign({}, target) : null, epoch = ++actionEpoch
        if (mode === "prompt" && !operationId) {
            const legacyPrompt = provenance.prompt || provenance.revisedPrompt || ""
            if (!legacyPrompt) { notice = "This version has no recorded prompt."; return }
            prompt.text = legacyPrompt; creating = true; notice = "Recorded prompt reused."
            return
        }
        if (!operationId) { notice = "This legacy version has no recorded settings recipe."; return }
        rpc.call("images.recipe", { sessionId: owner, operationId: operationId }, recipe => {
            if (sessionId !== owner || epoch !== actionEpoch || selectedRef?.versionId !== chosen?.versionId) return
            if (recipe.error) { error = recipe.error; return }
            if (mode === "prompt") { prompt.text = recipe.request?.prompt || provenance.prompt || ""; creating = true; notice = "Recipe prompt reused."; return }
            const connectionIndex = connections.findIndex(connection => connection.id === recipe.backend?.connectionId)
            if (connectionIndex < 0) { error = "The image connection recorded by this recipe is unavailable. Reuse the prompt or choose a current connection manually."; return }
            connectionBox.currentIndex = connectionIndex
            loadCapabilities(connections[connectionIndex].id, () => {
                if (sessionId !== owner || epoch !== actionEpoch) return
                Qt.callLater(() => { if (sessionId === owner && epoch === actionEpoch) applyRecipeControls(recipe, mode, chosen, originalTarget) })
            })
        })
    }
    function replayRecipe(acknowledge) {
        const version = selectedVersion(), operationId = version?.provenance?.operationId
        const owner = sessionId, chosen = selectedRef, epoch = ++actionEpoch
        if (!operationId || submitting) { if (!operationId) notice = "This version has no generation recipe to replay."; return }
        submitting = true
        rpc.call("images.recipe", { sessionId: owner, operationId: operationId }, recipe => {
            if (sessionId !== owner || epoch !== actionEpoch || selectedRef?.versionId !== chosen?.versionId) { submitting = false; return }
            if (recipe.error) { submitting = false; error = recipe.error; return }
            pendingReplay = recipe.recipeId
            submitting = false
            runRecipeId(recipe.recipeId, acknowledge)
        })
    }
    function runRecipeId(recipeId, acknowledge) {
        if (!recipeId || submitting) return
        const owner = sessionId, epoch = ++actionEpoch
        submitting = true; pendingReplay = recipeId
        const params = Object.assign({ sessionId: owner, recipeId: recipeId, overrides: {} }, acknowledge ? { acknowledgeBilling: true } : {})
        rpc.call("images.replay", params, value => {
            if (sessionId !== owner || epoch !== actionEpoch) { submitting = false; return }
            submitting = false
            if (value.error) {
                if (value.code === "ACKNOWLEDGE_BILLING") billing.confirmFor(value.error)
                else { pendingReplay = ""; error = value.error }
                return
            }
            pendingReplay = ""; readyRecipeId = ""; notice = "Recipe started. Progress stays here."; refreshOperations()
        })
    }
    function exportSelectedRecipe() {
        const operationId = selectedVersion()?.provenance?.operationId
        if (!operationId) { notice = "This version has no generation recipe to export."; return }
        const owner = sessionId
        rpc.call("images.recipe", { sessionId: owner, operationId: operationId }, recipe => {
            if (sessionId !== owner) return
            if (recipe.error) { error = recipe.error; return }
            recipeExport.recipeId = recipe.recipeId; recipeExport.open()
        })
    }
    function chooseRecipeFile() {
        const path = App.chooseFile()
        const connection = connections[connectionBox.currentIndex]
        if (!path) return
        if (!connection) { notice = "Set up and select an image backend before importing a recipe."; return }
        recipeImport.inspect(path, connection.id)
    }
    function pasteClipboard() {
        const content = App.clipboardContent()
        if (!content.handled) { error = "Copy an image or image file, then choose Paste."; return }
        if (content.error) { error = content.error; return }
        importPaths(content.paths || [], { remote: false, cloud: false })
    }
    function importPaths(paths, destinations) {
        const owner = sessionId
        for (const path of paths) rpc.call("artifacts.import", { sessionId: owner, path: path, destinations: destinations }, value => {
            if (sessionId !== owner) return
            if (value.error) error = value.error; else { notice = "Imported " + value.name; refresh(true) }
        })
    }
    function makeSketch(width, height) {
        const owner = sessionId
        rpc.call("images.sketch", { sessionId: owner, width: width, height: height }, value => {
            if (sessionId !== owner) return
            if (value.error) error = value.error; else WorkbenchState.selectImage(owner, value.artifactId, value.versionId)
        })
    }
    function chooseImport() {
        const path = filter === "image" ? App.chooseImage() : App.chooseFile()
        if (path) importDialog.openFor(path)
    }
    function clearFilters() {
        filter = ""; source = ""; collection = ""; query.text = ""
        kindBox.currentIndex = 1; sourceBox.currentIndex = 0; collectionBox.currentIndex = 0
        refresh(true)
    }
    function openItem(item, versionId) {
        const chosen = versionId || item.latestVersionId
        if (item.kind === "image" || item.kind === "plot") { WorkbenchState.selectImage(sessionId, item.id, chosen); return }
        const owner = sessionId
        rpc.call("artifacts.file", { sessionId: owner, artifactId: item.id, versionId: chosen }, value => {
            if (sessionId !== owner) return
            if (value.error) error = value.error; else App.openPath(value.path)
        })
    }
    function refreshOperations() {
        if (!sessionId) return
        const owner = sessionId, epoch = ++operationEpoch
        rpc.call("operations.list", { sessionId: owner, limit: 12 }, value => {
            if (sessionId !== owner || epoch !== operationEpoch || value.error) return
            operations = (value || []).filter(operation => String(operation.kind || "").startsWith("image.")).slice(0, 4)
            for (const operation of operations) {
                for (const candidate of operation.details?.unprotectedCandidates || []) fetchCandidatePreview(operation.operationId, candidate.candidateId, owner)
                if (["dispatching", "running"].indexOf(operation.state) < 0) continue
                const operationId = operation.operationId
                rpc.call("operations.partial", { id: operationId }, partial => {
                    if (sessionId !== owner || epoch !== operationEpoch || !partial.data) return
                    const next = Object.assign({}, partials); next[operationId] = partial.data; partials = next
                })
            }
        })
    }
    function fetchCandidatePreview(operationId, candidateId, owner) {
        const key = operationId + ":" + candidateId
        if (candidatePreviews[key] || candidatePreviewPending[key]) return
        const started = Object.assign({}, candidatePreviewPending)
        started[key] = true
        candidatePreviewPending = started
        rpc.call("images.previewCandidate", { sessionId: owner, operationId: operationId, candidateId: candidateId }, value => {
            if (sessionId !== owner) return
            const pending = Object.assign({}, candidatePreviewPending)
            delete pending[key]
            candidatePreviewPending = pending
            if (!value.data) return
            const next = Object.assign({}, candidatePreviews); next[key] = value.data; candidatePreviews = next
        })
    }
    function indexText(reset) {
        if (reset) { indexBefore = undefined; indexedCount = 0; skippedIndexCount = 0 }
        const owner = sessionId, beforePage = indexBefore
        indexing = true
        const params = { sessionId: owner, scope: scope }
        if (beforePage !== undefined) params.before = beforePage
        rpc.call("images.indexText", params, value => {
            if (sessionId !== owner || !indexing || indexBefore !== beforePage) return
            if (value.error) { indexing = false; error = value.error; return }
            indexedCount += value.indexed || 0; skippedIndexCount += value.skipped || 0; indexBefore = value.before
            notice = "Image text index · " + indexedCount + " indexed · " + skippedIndexCount + " already indexed or skipped."
            if (indexBefore === undefined) { indexing = false; refresh(true) } else indexTimer.restart()
        })
    }
    function loadCapabilities(connectionId, after) {
        const owner = sessionId, epoch = ++capabilityEpoch
        rpc.call("images.capabilities", { connectionId: connectionId }, value => {
            if (sessionId !== owner || epoch !== capabilityEpoch) return
            capabilities = value.error ? null : value
            if (value.error) { notice = value.error; return }
            if (after) after()
        })
    }
    function request() {
        const r = { operation: target ? (mask ? "masked-edit" : "edit") : references.length ? "reference" : "generate", prompt: prompt.text, count: count.value, format: format.currentText, references: [] }
        const caps = capabilities?.summary || {}
        if (sizeBox.visible && sizeBox.currentText && sizeBox.currentText !== "auto") r.size = sizeBox.currentText
        if (ratioBox.visible && ratioBox.currentText) r.aspectRatio = ratioBox.currentText
        if (resolutionBox.visible && resolutionBox.currentText) r.imageSize = resolutionBox.currentText
        if (qualityBox.visible && qualityBox.currentText && qualityBox.currentText !== "auto") r.quality = qualityBox.currentText
        if (transparent.checked) r.background = "transparent"
        if (seedField.visible && seedField.text.trim()) r.seed = Number(seedField.text)
        if (negative.visible && negative.text.trim()) r.negativePrompt = negative.text
        if (target) r.references.push({ artifactId: target.artifactId, versionId: target.versionId, role: "target" })
        for (const ref of references) if (!r.references.some(value => value.versionId === ref.versionId)) r.references.push({ artifactId: ref.artifactId, versionId: ref.versionId, role: ref.role || "subject" })
        if (mask) { r.mask = { artifactId: mask.artifactId, versionId: mask.versionId, feather: feather.value }; r.protectOutside = protect.checked }
        if (previews.checked) r.partials = true
        return r
    }
    function estimateText() {
        const estimate = connections[connectionBox.currentIndex]?.estimate
        if (!estimate || !Number.isFinite(Number(estimate.perImage))) {
            const route = capabilities?.summary?.processes
            return route ? "Normal route · " + route : ""
        }
        const total = Number(estimate.perImage) * count.value
        const currency = estimate.currency ? estimate.currency + " " : ""
        return "Configured estimate · " + currency + total.toFixed(2) + " for " + count.value
    }
    function generate(acknowledge) {
        const connection = connections[connectionBox.currentIndex]
        if (!connection || submitting) return
        pendingReplay = ""
        const owner = sessionId, epoch = ++actionEpoch
        submitting = true
        notice = ""; error = ""
        rpc.call("images.generate", Object.assign({ sessionId: owner, connectionId: connection.id, request: request() }, acknowledge ? { acknowledgeBilling: true } : {}), value => {
            if (sessionId !== owner || epoch !== actionEpoch) { submitting = false; return }
            submitting = false
            if (value.error) { if (value.code === "ACKNOWLEDGE_BILLING") billing.confirmFor(value.error); else error = value.error; return }
            notice = value.duplicate ? "That request is already running here." : "Started. Progress and results stay in Images."; refreshOperations()
        })
    }
    function checkRequest() {
        const connection = connections[connectionBox.currentIndex]
        if (!connection || submitting) return
        const owner = sessionId, epoch = ++actionEpoch
        submitting = true
        rpc.call("images.preview", { sessionId: owner, connectionId: connection.id, request: request() }, value => {
            if (sessionId !== owner || epoch !== actionEpoch) { submitting = false; return }
            submitting = false
            if (value.error) error = value.error
            else { error = ""; notice = value.adjustments.length ? "Will be adjusted: " + value.adjustments.join("; ") : "Ready to send as shown." }
        })
    }
    function cancelOperation(operationId) {
        const owner = sessionId
        rpc.call("operations.cancel", { id: operationId }, value => {
            if (sessionId !== owner) return
            if (value.error) error = value.error
            refreshOperations()
        })
    }
    onSessionIdChanged: {
        listEpoch++; detailEpoch++; operationEpoch++; actionEpoch++; capabilityEpoch++; probeEpoch++
        listing = false; submitting = false; indexing = false
        items = []; before = undefined; collections = []; thumbnails = ({}); thumbnailPending = ({})
        operations = []; partials = ({}); candidatePreviews = ({}); candidatePreviewPending = ({})
        connections = []; capabilities = null
        selected = null; details = null; selectedVersionId = ""; checkedIds = ({}); similarMode = false
        target = null; references = []; mask = null; maskBase = null; pendingProduction = null
        pendingReplay = ""; readyRecipeId = ""; indexBefore = undefined; indexedCount = 0; skippedIndexCount = 0
        seenArtifact = ""; seenOperations = ""; stale = false
        scope = "session"; filter = "image"; source = ""; collection = ""; filtersExpanded = false; scopeKnown = false; scopeHasAny = false
        error = ""; notice = ""; creating = WorkbenchState.createRequested
        query.text = ""; emptyPrompt.text = ""; prompt.text = ""; negative.text = ""; seedField.text = ""; count.value = 1
        transparent.checked = false; previews.checked = false; protect.checked = true; feather.value = 4
        scopeBox.currentIndex = 0; kindBox.currentIndex = 0; sourceBox.currentIndex = 0; collectionBox.currentIndex = 0; connectionBox.currentIndex = 0
        sizeBox.currentIndex = 0; ratioBox.currentIndex = 0; resolutionBox.currentIndex = 0; qualityBox.currentIndex = 0; format.currentIndex = 0
        billing.close(); recipeExport.close(); recipeImport.close(); removeConfirm.close(); importDialog.close()
        recipeExport.recipeId = ""; includeRecipeInputs.checked = false
        recipeImport.path = ""; recipeImport.connectionId = ""; recipeImport.inspection = null; recipeImport.inputMap = ({})
        includeEmbedded.checked = false; reviewedMappings.checked = false; reviewedLocal.checked = false
        removeConfirm.derived = []; withDerived.checked = false
        importDialog.path = ""; importRemote.checked = false; importCloud.checked = false
        if (productionLoader.item) { productionLoader.item.close(); productionLoader.item.sessionId = sessionId }
        refresh(true)
        refreshOperations()
    }
    // Reload when this conversation's files change (an import, a finished run, a removal) or a run starts or ends.
    Connections { target: App; function onStateChanged() {
        const artifact = String(App.state.workbench?.artifactRevision || 0)
        const active = (App.state.workbench?.activeOperations || []).filter(operation => operation.sessionId === browser.sessionId).map(operation => operation.operationId + ":" + operation.state).join("|")
        if (active !== browser.seenOperations) { browser.seenOperations = active; if (browser.visible) browser.refreshOperations() }
        if (artifact !== browser.seenArtifact) { browser.seenArtifact = artifact; if (browser.visible) browser.refresh("stable"); else browser.stale = true }
    } }
    property string seenArtifact: ""
    property string seenOperations: ""
    property bool stale: false
    onVisibleChanged: if (visible && stale) { stale = false; refresh("stable"); refreshOperations() }
    Connections { target: WorkbenchState; function onImagesChanged() { if (WorkbenchState.imageFor(browser.sessionId).artifactId) browser.refresh("stable") } }
    Timer { id: indexTimer; interval: 50; onTriggered: if (browser.indexing) browser.indexText(false) }
    Timer { id: searchTimer; interval: 230; onTriggered: browser.refresh(true) }
    Timer { interval: 1500; repeat: true; running: browser.visible && browser.operations.some(operation => ["queued", "dispatching", "running", "cancel_requested"].indexOf(operation.state) >= 0); onTriggered: browser.refreshOperations() }

    ColumnLayout {
        id: browserLayout
        anchors.fill: parent; spacing: Theme.space2; visible: !browser.editing
        CField {
            id: query; objectName: "artifactQuery"; Layout.fillWidth: true
            visible: (browser.scopeHasAny || browser.filtersExpanded) && !browser.creating
            placeholderText: "Search names, prompts, OCR and tags"; Accessible.name: "Search image library"
            onTextEdited: searchTimer.restart()
            onAccepted: { searchTimer.stop(); browser.refresh(true) }
        }
        GridLayout {
            visible: browser.filtersExpanded && !browser.creating
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width; rowSpacing: Theme.space1; columnSpacing: Theme.space2
            readonly property bool compact: browser.width < Theme.toolbarBreakpoint
            columns: compact ? 2 : 4
            CComboBox { id: scopeBox; objectName: "artifactScope"; Layout.fillWidth: true; Layout.minimumWidth: 0; model: ["This conversation", "Shared with project"]; Accessible.name: "Library scope"; onActivated: index => { browser.scope = index ? "project" : "session"; browser.refresh(true) } }
            CComboBox { id: kindBox; objectName: "artifactKind"; Layout.fillWidth: true; Layout.minimumWidth: 0; model: ["Images", "All files"]; Accessible.name: "File kind"; onActivated: index => { browser.filter = index ? "" : "image"; browser.refresh(true) } }
            CComboBox { id: sourceBox; objectName: "artifactSource"; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: Theme.fieldMedium; model: ["Any source", "Generated", "Imported", "Derived"]; Accessible.name: "Source"; onActivated: index => { browser.source = ["", "model-generation", "user-import", "derived"][index]; browser.refresh(true) } }
            CComboBox { id: collectionBox; objectName: "artifactCollection"; Layout.fillWidth: true; Layout.minimumWidth: 0; model: ["All collections"].concat(browser.collections); Accessible.name: "Named collection"; onActivated: index => { browser.collection = index ? browser.collections[index - 1] : ""; browser.refresh(true) } }
        }
        Flow {
            visible: !browser.genuineEmpty || browser.creating
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width; spacing: Theme.space2
            CButton { objectName: "imagesCreate"; text: browser.creating ? "Hide Create" : "Create image"; iconName: "image"; primary: !browser.creating; onClicked: { browser.creating = !browser.creating; WorkbenchState.createRequested = false } }
            CButton { objectName: "imagesImport"; text: browser.filter === "image" ? "Import image…" : "Import file…"; iconName: "plus"; onClicked: browser.chooseImport() }
            CButton { objectName: "imagesMore"; text: browser.filteredEmpty || browser.filter !== "image" || browser.source || browser.collection || query.text ? "More · filtered" : "More"; iconName: "more"; quiet: true; onClicked: libraryMenu.popup() }
            CMenu { id: libraryMenu
                CMenuItem { text: browser.filtersExpanded ? "Hide filters" : "Show filters"; onTriggered: browser.filtersExpanded = !browser.filtersExpanded }
                CMenuItem { text: "Paste image or file"; onTriggered: browser.pasteClipboard() }
                CMenuSeparator {}
                CMenuItem { text: "Square · 1024×1024"; onTriggered: browser.makeSketch(1024, 1024) }
                CMenuItem { text: "Landscape · 1200×628"; onTriggered: browser.makeSketch(1200, 628) }
                CMenuItem { text: "Portrait · 1080×1920"; onTriggered: browser.makeSketch(1080, 1920) }
                CMenuSeparator {}
                CMenuItem { text: "Production, sets and style kits…"; onTriggered: browser.openProduction([]) }
                CMenuItem { text: "Import recipe…"; onTriggered: browser.chooseRecipeFile() }
                CMenuItem { text: browser.indexing ? "Stop indexing image text" : "Index image text"; enabled: !browser.submitting; onTriggered: { if (browser.indexing) browser.indexing = false; else browser.indexText(true) } }
            }
        }
        CText { visible: !!browser.error; text: browser.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { visible: !!browser.notice; text: browser.notice; color: Theme.accentText; font.pixelSize: Theme.secondary }
        CButton { visible: !!browser.readyRecipeId; text: browser.submitting ? "Starting…" : "Run imported recipe"; primary: true; enabled: !browser.submitting; onClicked: browser.runRecipeId(browser.readyRecipeId, false) }
        // Create works without any chat model: these controls call the same image service the model uses.
        Item {
            visible: browser.creating; Layout.fillWidth: true; Layout.minimumWidth: 0
            implicitHeight: createLayout.implicitHeight
            ColumnLayout {
                id: createLayout
                anchors.left: parent.left; anchors.right: parent.right; spacing: Theme.space2
                Item {
                    visible: !browser.connections.length; Layout.fillWidth: true; Layout.minimumWidth: 0; implicitHeight: noBackendText.implicitHeight
                    CText { id: noBackendText; anchors.left: parent.left; anchors.right: parent.right; text: "No image backend is set up yet. Add OpenAI, Google or your ComfyUI server in Settings → Connections → Images."; color: Theme.amber; font.pixelSize: Theme.secondary }
                }
                CButton { visible: !browser.connections.length; text: "Open image setup"; primary: true; onClicked: browser.setupRequested() }
                RowLayout {
                    visible: browser.connections.length > 0; Layout.fillWidth: true
                    CComboBox { id: connectionBox; objectName: "imagesConnection"; Layout.fillWidth: true; model: browser.connections.map(c => c.name + " · " + (c.kind === "comfyui" ? "your server" : "billed cloud API")); Accessible.name: "Image backend"; onActivated: index => browser.loadCapabilities(browser.connections[index].id) }
                }
                Item {
                    visible: !!browser.capabilities; Layout.fillWidth: true; Layout.minimumWidth: 0; implicitHeight: capabilityText.implicitHeight
                    CText { id: capabilityText; anchors.left: parent.left; anchors.right: parent.right; text: browser.capabilities ? (browser.capabilities.summary.notes || []).join(" ") + " Processes on " + browser.capabilities.summary.processes + "." : ""; color: Theme.muted; font.pixelSize: Theme.caption }
                }
                CTextArea { id: prompt; objectName: "imagesPrompt"; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredHeight: Theme.editorShort; placeholderText: "Describe the image"; Accessible.name: "Image prompt" }
                CField { id: negative; visible: (browser.capabilities?.summary?.negativePrompt || "").startsWith("supported"); Layout.fillWidth: true; placeholderText: "Avoid (negative prompt)"; Accessible.name: "Negative prompt" }
                Flow {
                    Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width; spacing: Theme.space2
                    CComboBox { id: sizeBox; visible: (browser.capabilities?.summary?.sizes || []).length > 0 || !!browser.capabilities?.summary?.customSize; implicitWidth: Theme.fieldWidth; editable: !!browser.capabilities?.summary?.customSize
                        model: (browser.capabilities?.summary?.sizes || []).length ? browser.capabilities.summary.sizes : ["1024x1024", "768x512", "512x768"]; Accessible.name: "Size" }
                    CComboBox { id: ratioBox; visible: (browser.capabilities?.summary?.aspectRatios || []).length > 0; implicitWidth: Theme.fieldShort; model: browser.capabilities?.summary?.aspectRatios || []; Accessible.name: "Aspect ratio" }
                    CComboBox { id: resolutionBox; visible: (browser.capabilities?.summary?.imageSizes || []).length > 0; implicitWidth: Theme.fieldShort; model: browser.capabilities?.summary?.imageSizes || []; Accessible.name: "Image size" }
                    CComboBox { id: qualityBox; visible: (browser.capabilities?.summary?.qualities || []).length > 0; implicitWidth: Theme.fieldShort; model: browser.capabilities?.summary?.qualities || []; Accessible.name: "Quality" }
                    CComboBox { id: format; implicitWidth: Theme.fieldShort; model: browser.capabilities?.summary?.formats || ["png"]; Accessible.name: "Format" }
                    CSpinBox { id: count; from: 1; to: browser.capabilities?.summary?.maxCount || 1; value: 1; Accessible.name: "Number of images" }
                    CField { id: seedField; visible: (browser.capabilities?.summary?.seed || "").startsWith("supported"); implicitWidth: Theme.fieldShort; placeholderText: "Seed"; validator: IntValidator { bottom: 0 } Accessible.name: "Seed" }
                }
                Flow {
                    Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width; spacing: Theme.space3
                    CCheckBox { id: transparent; width: implicitContentWidth + leftPadding + rightPadding; visible: !(browser.capabilities?.summary?.transparency || "").startsWith("unsupported"); text: "Transparent background" }
                    CCheckBox { id: previews; width: implicitContentWidth + leftPadding + rightPadding; visible: count.value === 1 && !(browser.capabilities?.summary?.backend !== "openai"); text: "Show previews (provisional)" }
                }
                ImageReferenceChip { visible: !!browser.target; reference: browser.target || ({}); label: "Edit target"; onRemoveRequested: { browser.target = null; browser.mask = null; browser.maskBase = null } }
                Flow { visible: browser.references.length > 0; Layout.fillWidth: true; spacing: Theme.space1
                    Repeater { model: browser.references; ImageReferenceChip { required property var modelData; reference: modelData; label: modelData.role === "style" ? "Style" : modelData.role === "composition" ? "Composition" : "Subject"; onRemoveRequested: browser.references = browser.references.filter(value => value.versionId !== modelData.versionId) } }
                }
                CText { visible: !!browser.mask; Layout.fillWidth: true; text: browser.maskMatchesTarget ? "Mask bound to target version " + String(browser.maskBase?.versionId || "").slice(0, 8) : "This mask was painted on a different version. Restore that target or clear the mask."; color: browser.maskMatchesTarget ? Theme.muted : Theme.danger; font.pixelSize: Theme.caption }
                GridLayout {
                    visible: !!browser.mask; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width
                    readonly property bool compact: browser.width < Theme.toolbarBreakpoint
                    columns: compact ? 2 : 3
                    CCheckBox { id: protect; Layout.columnSpan: parent.compact ? 2 : 1; Layout.fillWidth: true; Layout.minimumWidth: 0; checked: true; text: "Keep pixels outside the selection unchanged" }
                    CText { Layout.fillWidth: parent.compact; text: "Feather" }
                    CSpinBox { id: feather; Layout.fillWidth: parent.compact; from: 0; to: 64; value: 4; Accessible.name: "Feather" }
                }
                Flow {
                    Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width; spacing: Theme.space2
                    CButton { visible: !!browser.target || browser.references.length > 0; text: "Clear inputs"; quiet: true; onClicked: { browser.target = null; browser.references = []; browser.mask = null; browser.maskBase = null } }
                    CButton { objectName: "imagesCheck"; text: browser.submitting ? "Checking…" : "Check settings"; enabled: !browser.submitting && prompt.text.trim().length > 0 && browser.connections.length > 0 && browser.maskMatchesTarget; onClicked: browser.checkRequest() }
                    CButton { objectName: "imagesGenerate"; text: browser.submitting ? "Starting…" : browser.target ? "Make edit" : "Generate"; primary: true; enabled: !browser.submitting && prompt.text.trim().length > 0 && browser.connections.length > 0 && browser.maskMatchesTarget && App.connected; onClicked: browser.generate(false) }
                    CText { visible: !!browser.estimateText(); width: implicitWidth; height: Theme.controlHeight; verticalAlignment: Text.AlignVCenter; text: browser.estimateText(); color: Theme.muted; font.pixelSize: Theme.caption }
                }
            }
        }
        Rectangle {
            visible: !browser.items.length && !browser.creating && browser.scopeKnown
            Layout.fillWidth: true; implicitHeight: emptyState.implicitHeight + Theme.space6
            radius: Theme.radiusCard; color: Theme.surface; border.color: emptyDrop.containsDrag ? Theme.focus : Theme.border
            DropArea { id: emptyDrop; anchors.fill: parent; onDropped: drop => { const paths = []; if (drop.hasUrls) for (const url of drop.urls) { const value = String(url); if (value.startsWith("file://")) paths.push(decodeURIComponent(value.slice(7))) } browser.importPaths(paths, { remote: false, cloud: false }); drop.acceptProposedAction() } }
            ColumnLayout {
                id: emptyState; anchors.centerIn: parent; width: Math.max(0, parent.width - Theme.space6); spacing: Theme.space2
                CText { Layout.fillWidth: true; text: browser.genuineEmpty ? "What do you want to make?" : browser.sharedEmpty ? "No files are shared with this project" : "No library matches"; font.pixelSize: Theme.section; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter }
                CText { Layout.fillWidth: true; text: browser.genuineEmpty ? "Drop or paste image · or describe one to create" : browser.sharedEmpty ? "Share an item from this conversation, or return to its private library." : "Try a different kind, source, collection, or search."; color: Theme.muted; wrapMode: Text.Wrap; horizontalAlignment: Text.AlignHCenter }
                CField { id: emptyPrompt; visible: browser.genuineEmpty; Layout.fillWidth: true; placeholderText: "Describe an image…"; Accessible.name: "Start an image prompt"; onAccepted: { prompt.text = text; browser.creating = true; text = "" } }
                Flow { Layout.fillWidth: true; spacing: Theme.space1
                    CButton { visible: browser.genuineEmpty; text: "Create"; primary: true; onClicked: { if (emptyPrompt.text.trim()) prompt.text = emptyPrompt.text; emptyPrompt.text = ""; browser.creating = true } }
                    CButton { visible: browser.genuineEmpty; text: "Drop or import…"; onClicked: browser.chooseImport() }
                    CButton { visible: browser.genuineEmpty; text: "Paste image"; onClicked: browser.pasteClipboard() }
                    CButton {
                        visible: browser.genuineEmpty; text: "New sketch"; onClicked: sketchMenu.popup()
                        CMenu { id: sketchMenu
                            CMenuItem { text: "Square · 1024×1024"; onTriggered: browser.makeSketch(1024,1024) }
                            CMenuItem { text: "Landscape · 1200×628"; onTriggered: browser.makeSketch(1200,628) }
                            CMenuItem { text: "Portrait · 1080×1920"; onTriggered: browser.makeSketch(1080,1920) }
                        }
                    }
                    CButton { visible: browser.sharedEmpty; text: "This conversation"; primary: true; onClicked: { browser.scope = "session"; scopeBox.currentIndex = 0; browser.refresh(true) } }
                    CButton { visible: browser.filteredEmpty; text: "Clear filters"; primary: true; onClicked: browser.clearFilters() }
                    CButton { text: "More"; quiet: true; iconName: "more"; onClicked: libraryMenu.popup() }
                    CButton { visible: browser.genuineEmpty && !browser.connections.length; text: "Set up images"; onClicked: browser.setupRequested() }
                }
            }
        }
        ColumnLayout {
            visible: browser.operations.length > 0; Layout.fillWidth: true; spacing: Theme.space1
            CText { text: "Recent image work"; font.weight: Font.DemiBold }
            Repeater { model: browser.operations; ImageOperationCard { required property var modelData; Layout.fillWidth: true; sessionId: browser.sessionId; operation: modelData; partial: browser.partials[modelData.operationId] || ""; candidatePreviews: browser.candidatePreviews; onCancelRequested: operationId => browser.cancelOperation(operationId); onCompareRequested: refs => browser.compare(refs); onAcceptRequested: (operationId, candidateId) => { const owner = browser.sessionId; rpc.call("images.acceptUnprotected", { sessionId: owner, operationId: operationId, candidateId: candidateId }, value => { accepting = false; if (browser.sessionId !== owner) return; if (value.error) browser.error = value.error; else { browser.notice = "Unprotected candidate kept as a new version."; browser.refresh("stable"); browser.refreshOperations() } }) } } }
        }
        RowLayout {
            visible: browser.checkedItems.length > 0 || browser.similarMode; Layout.fillWidth: true
            CText { Layout.fillWidth: true; text: browser.similarMode ? "Similar images" : browser.checkedItems.length + " selected"; font.weight: Font.DemiBold }
            CButton { visible: browser.checkedImages.length >= 2; text: "Compare"; onClicked: browser.compare(browser.selectedImageRefs(2)) }
            CButton { visible: browser.checkedImages.length > 0; text: browser.submitting ? "Working…" : "Contact sheet"; enabled: !browser.submitting; onClicked: browser.contactSheet() }
            CButton { visible: browser.checkedImages.length > 0; text: "Production…"; onClicked: browser.openProduction(browser.selectedImageRefs(16)) }
            CButton { objectName: "artifactBundle"; visible: browser.checkedItems.length > 0; text: browser.submitting ? "Working…" : "ZIP…"; help: "Put the selected files and a manifest in one ZIP"; enabled: !browser.submitting; onClicked: bundleDialog.show() }
            CButton { visible: browser.similarMode; text: "Back"; quiet: true; onClicked: browser.refresh(true) }
        }
        GridView {
            id: grid; objectName: "artifactGrid"
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.galleryRowHeight; clip: true
            cellWidth: Math.max(Theme.avatarTileWidth, Math.floor(width / Math.max(1, Math.floor(width / Theme.fieldWidth)))); cellHeight: Theme.galleryRowHeight
            model: browser.items
            ScrollBar.vertical: CScrollBar {}
            keyNavigationEnabled: true; activeFocusOnTab: true
            delegate: Item {
                required property var modelData; required property int index
                readonly property bool visual: modelData.kind === "image" || modelData.kind === "plot"
                objectName: "artifactTile_" + index
                width: grid.cellWidth; height: grid.cellHeight
                Rectangle {
                    anchors.fill: parent; anchors.margins: Theme.space1; radius: Theme.radiusControl
                    color: browser.selected && browser.selected.id === modelData.id ? Theme.selected : Theme.surface; border.color: grid.currentIndex === index && grid.activeFocus ? Theme.focus : Theme.subtle
                    Accessible.role: Accessible.Button; Accessible.name: modelData.name + (modelData.latest?.image ? ", " + modelData.latest.image.width + " by " + modelData.latest.image.height : "")
                    ColumnLayout {
                        anchors.fill: parent; anchors.margins: Theme.space2; spacing: Theme.space1
                        Rectangle {
                            Layout.fillWidth: true; Layout.fillHeight: true; color: Theme.codeSurface; radius: Theme.radiusChip; clip: true
                            Image { anchors.fill: parent; fillMode: Image.PreserveAspectFit; asynchronous: true; source: browser.thumbnails[modelData.latestVersionId] || "" }
                            CText { anchors.centerIn: parent; width: implicitWidth; visible: !browser.thumbnails[modelData.latestVersionId]; text: modelData.kind === "image" ? "…" : modelData.kind; color: Theme.muted; font.pixelSize: Theme.caption }
                        }
                        CText { text: modelData.name; elide: Text.ElideMiddle; wrapMode: Text.NoWrap; font.pixelSize: Theme.caption }
                        CText { text: [modelData.latest?.image ? modelData.latest.image.width + "×" + modelData.latest.image.height : "", modelData.latest?.image?.transparent ? "transparency" : "", modelData.versions > 1 ? modelData.versions + " versions" : "",
                            modelData.latest?.source === "model-generation" ? "generated" : modelData.latest?.source === "user-import" ? "imported" : ""].filter(s => s).join(" · "); color: Theme.muted; font.pixelSize: Theme.caption; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                    }
                    CCheckBox { anchors.left: parent.left; anchors.top: parent.top; anchors.margins: Theme.space2; z: 2; checked: !!browser.checkedIds[modelData.id]; Accessible.name: "Select " + modelData.name; onClicked: browser.setChecked(modelData, checked) }
                    CButton { anchors.right: parent.right; anchors.top: parent.top; anchors.margins: Theme.space2; z: 2; text: ""; iconName: "more"; implicitWidth: Theme.compactHeight; implicitHeight: Theme.compactHeight; help: "Image actions"; onClicked: tileMenu.popup()
                        CMenu { id: tileMenu
                            CMenuItem { text: "Use in chat"; onTriggered: browser.useInChat({ artifactId: modelData.id, versionId: modelData.latestVersionId, name: modelData.name }, "") }
                            CMenuItem { visible: visual; text: "Set as edit target"; onTriggered: browser.setTarget({ artifactId: modelData.id, versionId: modelData.latestVersionId, name: modelData.name }) }
                            CMenuItem { visible: visual; text: "Subject guide"; onTriggered: browser.addGuide({ artifactId: modelData.id, versionId: modelData.latestVersionId, name: modelData.name }, "subject") }
                            CMenuItem { visible: visual; text: "Style guide"; onTriggered: browser.addGuide({ artifactId: modelData.id, versionId: modelData.latestVersionId, name: modelData.name }, "style") }
                            CMenuItem { visible: visual; text: "Composition guide"; onTriggered: browser.addGuide({ artifactId: modelData.id, versionId: modelData.latestVersionId, name: modelData.name }, "composition") }
                            CMenuItem { visible: visual; text: "Find similar"; onTriggered: browser.findSimilar(modelData) }
                        }
                    }
                    MouseArea { anchors.fill: parent; onClicked: { grid.currentIndex = index; browser.select(modelData) } onDoubleClicked: browser.openItem(modelData, modelData.latestVersionId) }
                }
            }
            Keys.onReturnPressed: if (currentIndex >= 0) browser.select(model[currentIndex])
            CText { anchors.centerIn: parent; width: parent.width - 2 * Theme.gutter; horizontalAlignment: Text.AlignHCenter; visible: !browser.items.length && browser.creating; text: "Your new images will appear here."; color: Theme.muted }
        }
        CButton { visible: browser.before !== undefined && !browser.similarMode; Layout.alignment: Qt.AlignHCenter; text: browser.listing ? "Loading…" : "Load more"; enabled: !browser.listing; onClicked: browser.refresh(false) }
        ColumnLayout {
            visible: !!browser.selected; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width; spacing: Theme.space1
            Flow {
                Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: browser.width; Layout.maximumWidth: browser.width; spacing: Theme.space1
                CButton { text: "Analyze in Code Lab"; quiet: true; implicitHeight: Theme.compactHeight
                    onClicked: WorkbenchState.openAnalysis(browser.sessionId, {inputs: [browser.selectedRef]}) }
                CButton { objectName: "imageView"; text: browser.selected?.kind === "image" || browser.selected?.kind === "plot" ? "View and edit" : "Open"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.openItem(browser.selected, browser.selectedRef.versionId) }
                ProviderArtifactActions {
                    sessionId:browser.sessionId;artifact:browser.selectedRef;version:browser.selectedVersion();implicitHeight:Theme.compactHeight
                    onRefreshed:browser.refresh(true)
                    onOriginalSelected:file=>{const problem=WorkbenchState.addOriginalFile(browser.sessionId,file);if(problem)browser.error=problem;else browser.notice="Original PDF attached to the next message."}
                }
                CButton { objectName: "imageAsk"; visible: browser.selected?.kind === "image" || browser.selected?.kind === "plot"; text: "Ask in chat"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.useInChat(browser.selectedRef, "What should I know about this image?") }
                CButton { objectName: "imageUse"; text: "Use in chat"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.useInChat(browser.selectedRef, "") }
                CButton { objectName: "imageTarget"; visible: browser.selected?.kind === "image" || browser.selected?.kind === "plot"; text: "Edit this version"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.setTarget(browser.selectedRef) }
                CButton { objectName: "imageReference"; text: "Add guide…"; quiet: true; implicitHeight: Theme.compactHeight; visible: browser.selected?.kind === "image" || browser.selected?.kind === "plot"; onClicked: detailGuideMenu.popup()
                    CMenu { id: detailGuideMenu
                        CMenuItem { text: "Subject guide"; onTriggered: browser.addGuide(browser.selectedRef, "subject") }
                        CMenuItem { text: "Style guide"; onTriggered: browser.addGuide(browser.selectedRef, "style") }
                        CMenuItem { text: "Composition guide"; onTriggered: browser.addGuide(browser.selectedRef, "composition") }
                    }
                }
                CButton { visible: browser.selected?.kind === "image" || browser.selected?.kind === "plot"; text: "Find similar"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.findSimilar(browser.selected, browser.selectedVersionId) }
                CButton { objectName: "imageSaveAs"; text: "Save as…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: { const path = App.chooseSavePath(browser.selected.name); if (path) rpc.call("artifacts.saveAs", { sessionId: browser.sessionId, artifactId: browser.selectedRef.artifactId, versionId: browser.selectedRef.versionId, path: path, replace: true }, value => browser.notice = value.error ? value.error : "Saved to " + value.path) } }
                CButton { visible: ["audio/wav","audio/x-wav","audio/wave"].includes(browser.selectedVersion()?.mime || ""); text:"Cloud transcription…"; quiet:true; implicitHeight:Theme.compactHeight; onClicked:transcribe.openFor(browser.selectedRef) }
                CButton { objectName: "artifactMore"; text: "More…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: documentTools.openMenu(Object.assign({}, browser.selectedRef, { mime: browser.selectedVersion()?.mime || "", kind: browser.selected?.kind || "" })) }
                CButton { objectName: "imagePin"; text: browser.selected?.pinned ? "Unpin" : "Pin"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: rpc.call("artifacts.update", { sessionId: browser.sessionId, artifactId: browser.selected.id, pinned: !browser.selected.pinned }, () => browser.refresh()) }
                CButton { objectName: "imageShare"; text: browser.selected?.shared ? "Stop sharing with project" : "Share with project"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: rpc.call("artifacts.update", { sessionId: browser.sessionId, artifactId: browser.selected.id, shared: !browser.selected.shared }, () => browser.refresh()) }
                CButton { objectName: "imageRemove"; text: "Remove from conversation"; danger: true; quiet: true; implicitHeight: Theme.compactHeight; onClicked: removeConfirm.open() }
            }
            CText { visible: (browser.details?.versions || []).length > 1; text: "Choose a sibling version"; color: Theme.muted; font.pixelSize: Theme.caption }
            Flow { visible: (browser.details?.versions || []).length > 1; Layout.fillWidth: true; spacing: Theme.space1
                Repeater { model: browser.details?.versions || []; CButton { required property var modelData; required property int index; text: "Version " + (index + 1); primary: browser.selectedVersionId === modelData.versionId; implicitHeight: Theme.compactHeight; onClicked: browser.chooseVersion(modelData.versionId) } }
                CButton { visible: browser.selected?.kind === "image" || browser.selected?.kind === "plot"; text: "Compare chosen with latest"; enabled: browser.selectedVersionId !== browser.selected?.latestVersionId; implicitHeight: Theme.compactHeight; onClicked: browser.compare([browser.selectedRef, { artifactId: browser.selected.id, versionId: browser.selected.latestVersionId, name: browser.selected.name }]) }
            }
            Flow {
                Layout.fillWidth: true; spacing: Theme.space1
                readonly property var version: browser.selectedVersion()
                readonly property var origin: (App.state.sessions || []).find(s => s.id === version?.sessionId)
                visible: !!version && ((version.parents || []).length > 0 || (!!origin && origin.id !== browser.sessionId))
                Repeater {
                    model: browser.selectedVersion()?.parents || []
                    CButton {
                        required property var modelData
                        text: "View source · " + modelData.relation + " · " + modelData.versionId.slice(0,8)
                        quiet: true; implicitHeight: Theme.compactHeight
                        onClicked: browser.openParent(modelData)
                    }
                }
                CButton {
                    visible: !!parent.origin && parent.origin.id !== browser.sessionId
                    text: "Open conversation · " + (parent.origin?.title || "")
                    quiet: true; implicitHeight: Theme.compactHeight
                    onClicked: { App.select(parent.origin.id); WorkbenchState.hide() }
                }
            }
            Flow { visible: browser.selected?.kind === "image" || browser.selected?.kind === "plot"; Layout.fillWidth: true; spacing: Theme.space1
                CButton { text: "Reuse prompt"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.reuseRecipe("prompt") }
                CButton { text: "Reuse settings"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.reuseRecipe("settings") }
                CButton { text: "Branch from this"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.reuseRecipe("branch") }
                CButton { text: browser.submitting ? "Starting…" : "Run recipe again"; quiet: true; implicitHeight: Theme.compactHeight; enabled: !browser.submitting; onClicked: browser.replayRecipe(false) }
                CButton { text: "Export recipe…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.exportSelectedRecipe() }
                CButton { text: "Import recipe…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.chooseRecipeFile() }
                CButton { text: "Production / style kit…"; quiet: true; implicitHeight: Theme.compactHeight; onClicked: browser.openProduction([browser.selectedRef]) }
            }
            RowLayout { Layout.fillWidth: true
                CField { id: collectionName; Layout.fillWidth: true; placeholderText: "Named collections, comma separated"; text: (browser.selected?.collections || []).join(", "); Accessible.name: "Image collections" }
                CButton { text: "Set collections"; onClicked: rpc.call("artifacts.update", { sessionId: browser.sessionId, artifactId: browser.selected.id, collections: collectionName.text.split(",").map(value => value.trim()).filter(value => value) }, value => { if (value.error) browser.error = value.error; else { browser.notice = "Collections updated."; browser.refresh(true) } }) }
            }
            Item {
                visible: !!browser.details; Layout.fillWidth: true; Layout.minimumWidth: 0
                implicitHeight: detailText.implicitHeight
                CText {
                    id: detailText; anchors.left: parent.left; anchors.right: parent.right
                    color: Theme.muted; font.pixelSize: Theme.caption; wrapMode: Text.Wrap
                    text: { const v = browser.details ? (browser.details.versions || []).find(value => value.versionId === browser.selectedVersionId) || browser.details.versions[browser.details.versions.length - 1] : null; if (!v) return ""; const p = v.provenance || {}
                        return [p.prompt ? "Prompt: " + p.prompt : "", p.revisedPrompt ? "Revised by the provider: " + p.revisedPrompt : "", p.backend ? "Made with " + (p.connection || p.backend) + (p.model ? " (" + p.model + ")" : "") + " on " + (p.route || "unknown") : "", p.parameters ? "Settings: " + p.parameters : "", p.protection || "", (v.exports || []).length ? "Saved to " + v.exports[0].destination : ""].filter(s => s).join("\n") }
                }
            }
        }
    }
    signal settingsRequested(string category, string target)
    DocumentTools { id: documentTools; sessionId: browser.sessionId; onDone: message => browser.notice = message; onRefreshRequested: browser.refresh("stable"); onSettingsRequested: (category, target) => browser.settingsRequested(category, target) }
    CDialog {
        id: bundleDialog; objectName: "bundleDialog"
        property var refs: []
        property string problem: ""
        function show() { refs = browser.selectedRefs(50); problem = ""; bundleName.text = "bundle"; open(); bundleName.forceActiveFocus(); bundleName.selectAll() }
        function make() {
            problem = ""; browser.submitting = true
            rpc.call("artifacts.bundle", { sessionId: browser.sessionId, name: bundleName.text.trim(), items: refs.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId })) }, value => {
                browser.submitting = false
                if (value.error) { bundleDialog.problem = String(value.error.message || value.error); return }
                bundleDialog.close(); browser.checkedIds = ({}); browser.notice = value.name + " was added to this conversation’s files."
                browser.filter = ""; kindBox.currentIndex = 1; browser.refresh(true)
            })
        }
        CText { text: "ZIP " + bundleDialog.refs.length + (bundleDialog.refs.length === 1 ? " file" : " files"); font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CText { text: "The exact selected versions and a manifest with their digests. The ZIP follows the strictest processing choice of its files."; color: Theme.muted; font.pixelSize: Theme.secondary }
        CField { id: bundleName; objectName: "bundleName"; Layout.fillWidth: true; maximumLength: 120; placeholderText: "Name"; Accessible.name: "ZIP name"; onAccepted: if (bundleMake.enabled) bundleDialog.make() }
        CText { visible: !!bundleDialog.problem; text: bundleDialog.problem; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        RowLayout {
            Layout.fillWidth: true; spacing: Theme.space2
            CButton { id: bundleMake; objectName: "bundleMake"; Layout.fillWidth: true; primary: true; text: browser.submitting ? "Working…" : "Make the ZIP"; enabled: App.connected && !browser.submitting && bundleName.text.trim().length > 0 && bundleDialog.refs.length > 0; onClicked: bundleDialog.make() }
            CButton { Layout.fillWidth: true; text: "Cancel"; enabled: !browser.submitting; onClicked: bundleDialog.close() }
        }
    }
    ImageWorkbench {
        id: imageEditor
        anchors.fill: parent; visible: browser.editing; sessionId: browser.sessionId
        onCloseRequested: { WorkbenchState.clearImage(browser.sessionId); browser.refresh() }
        onMaskReady: ref => { const selected = WorkbenchState.imageFor(browser.sessionId); browser.target = { artifactId: selected.artifactId, versionId: selected.versionId, name: imageEditor.info?.artifact?.name || "image" }; browser.maskBase = Object.assign({}, browser.target); browser.mask = ref; browser.creating = true; WorkbenchState.clearImage(browser.sessionId) }
    }
    Connections { target: imageEditor; ignoreUnknownSignals: true; function onEditRequested(target, instruction, maskRef) { browser.setTarget(target); prompt.text = instruction || ""; if (maskRef?.guide) browser.addGuide({ artifactId: maskRef.guide.artifactId, versionId: maskRef.guide.versionId, name: maskRef.guide.name || "markup guide" }, "composition"); else if (maskRef) { browser.mask = maskRef; browser.maskBase = Object.assign({}, target) } browser.creating = true; WorkbenchState.clearImage(browser.sessionId) } }
    Loader { id: productionLoader; active: true; source: "ImageProduction.qml"; onLoaded: { item.sessionId = browser.sessionId; if (browser.pendingProduction !== null) { item.openFor(browser.pendingProduction); browser.pendingProduction = null } } }
    Connections { target: productionLoader.item; ignoreUnknownSignals: true; function onCompleted(message) { browser.notice = message; browser.refresh(true) } }
    CDialog {
        id: recipeExport
        property string recipeId: ""
        CText { text: "Export image recipe"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: "The recipe keeps the exact prompt, backend revision and input identities. Including image copies can make the file much larger."; wrapMode: Text.Wrap }
        CCheckBox { id: includeRecipeInputs; text: "Include copies of input images (up to 100 MiB)"; checked: false }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true }
            CButton { text: "Cancel"; onClicked: recipeExport.close() }
            CButton { text: "Choose location…"; primary: true; onClicked: {
                const path = App.chooseSavePath("image recipe.pal-image.json")
                if (!path) return
                const owner = browser.sessionId
                rpc.call("images.exportRecipe", { sessionId: owner, recipeId: recipeExport.recipeId, includeInputs: includeRecipeInputs.checked, path: path, replace: true }, value => {
                    if (browser.sessionId !== owner) return
                    if (value.error) browser.error = value.error; else { browser.notice = "Recipe saved to " + value.path; recipeExport.close() }
                })
            } }
        }
    }
    CDialog {
        id: recipeImport
        property string path: ""
        property string connectionId: ""
        property string inspectionError: ""
        property var inspection: null
        property var inputMap: ({})
        function canImport() {
            if (!inspection) return false
            const dependencies = inspection.workflow?.dependencies || {}
            if ((dependencies.missingNodes || []).length || (dependencies.missingModels || []).length) return false
            if (inspection.workflow?.requiresLocalReview && !reviewedLocal.checked) return false
            if (Object.keys(inputMap).length && !reviewedMappings.checked) return false
            return (inspection.inputs || []).every(input => inputMap[input.inputId] || input.exactMatches.length || (input.embedded && includeEmbedded.checked))
        }
        function inspect(path, connectionId) {
            recipeImport.path = path; recipeImport.connectionId = connectionId; recipeImport.inspection = null; inspectionError = ""
            recipeImport.inputMap = ({}); includeEmbedded.checked = false; reviewedMappings.checked = false; reviewedLocal.checked = false; open()
            const owner = browser.sessionId
            rpc.call("images.inspectRecipeFile", { sessionId: owner, connectionId: connectionId, path: path }, value => {
                if (browser.sessionId !== owner || recipeImport.path !== path || recipeImport.connectionId !== connectionId) return
                if (value.error) inspectionError = value.error; else recipeImport.inspection = value
            })
        }
        CText { text: "Import image recipe"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: recipeImport.path; color: Theme.muted; font.family: Theme.mono; font.pixelSize: Theme.caption; wrapMode: Text.WrapAnywhere }
        CComboBox { Layout.fillWidth: true; model: browser.connections.map(connection => connection.name)
            currentIndex: browser.connections.findIndex(connection => connection.id === recipeImport.connectionId)
            Accessible.name: "Recipe destination connection"
            onActivated: index => recipeImport.inspect(recipeImport.path, browser.connections[index].id)
        }
        CText { visible: !recipeImport.inspection || !!recipeImport.inspectionError; text: recipeImport.inspectionError || "Inspecting recipe…"; color: recipeImport.inspectionError ? Theme.danger : Theme.muted; wrapMode: Text.Wrap }
        CText { visible: !!recipeImport.inspection; text: recipeImport.inspection ? "Backend · " + (recipeImport.inspection.backend?.model || recipeImport.inspection.backend?.kind || "unknown") + "\nInputs · " + (recipeImport.inspection.inputs || []).length + "\nDigest · " + String(recipeImport.inspection.digest || "").slice(0, 16) : ""; font.pixelSize: Theme.caption; wrapMode: Text.Wrap }
        CText { visible: !!recipeImport.inspection && !recipeImport.inspection.ready; text: "Some inputs or workflow dependencies need review. The broker will refuse unresolved or changed inputs."; color: Theme.amber; font.pixelSize: Theme.caption; wrapMode: Text.Wrap }
        Repeater { model: recipeImport.inspection?.inputs || []
            ColumnLayout { required property var modelData; Layout.fillWidth: true; spacing: Theme.space1
                CText { Layout.fillWidth: true; text: (modelData.role || "input") + " · " + modelData.name + " · " + (modelData.exactMatches.length ? "exact authorized match" : modelData.embedded ? "embedded copy available" : "mapping required"); color: modelData.exactMatches.length ? Theme.muted : Theme.amber; font.pixelSize: Theme.caption; wrapMode: Text.Wrap }
                CComboBox { Layout.fillWidth: true; model: ["Use exact match / embedded copy"].concat(browser.items.map(item => "Map to " + item.name)); Accessible.name: "Map " + modelData.name
                    onActivated: index => { const next = Object.assign({}, recipeImport.inputMap); if (!index) delete next[modelData.inputId]; else { const item = browser.items[index - 1]; next[modelData.inputId] = { artifactId: item.id, versionId: item.latestVersionId } } recipeImport.inputMap = next }
                }
            }
        }
        CCheckBox { id: includeEmbedded; visible: (recipeImport.inspection?.inputs || []).some(input => input.embedded); text: "Import the embedded input image copies as local-only artifacts"; checked: false }
        CCheckBox { id: reviewedMappings; visible: Object.keys(recipeImport.inputMap).length > 0; text: "I reviewed the selected replacements, including any content differences"; checked: false }
        CCheckBox { id: reviewedLocal; visible: !!recipeImport.inspection?.workflow?.requiresLocalReview; text: "I reviewed the changed/custom workflow nodes as local"; checked: false }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true }
            CButton { text: "Cancel"; onClicked: recipeImport.close() }
            CButton { text: "Import recipe"; primary: true; enabled: recipeImport.canImport(); onClicked: {
                const owner = browser.sessionId, inspection = recipeImport.inspection
                const embedded = includeEmbedded.checked ? (inspection.inputs || []).filter(input => input.embedded).map(input => input.inputId) : []
                const changed = reviewedMappings.checked ? Object.keys(recipeImport.inputMap) : []
                rpc.call("images.importRecipeFile", { sessionId: owner, connectionId: recipeImport.connectionId, path: recipeImport.path, expectedDigest: inspection.digest, inputMap: recipeImport.inputMap, reviewedChangedInputs: changed, importEmbeddedInputs: embedded, reviewedLocal: reviewedLocal.checked }, value => {
                    if (browser.sessionId !== owner) return
                    if (value.error) { recipeImport.inspectionError = value.error; browser.error = value.error; return }
                    browser.readyRecipeId = value.recipe?.recipeId || value.recipeId || ""
                    browser.notice = "Recipe imported and ready to run."
                    recipeImport.close()
                })
            } }
        }
    }
    CDialog {
        id: billing; objectName: "imagesBilling"
        property string message: ""
        function confirmFor(reason) { message = reason; open() }
        CText { text: "This backend may bill you"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: billing.message; wrapMode: Text.Wrap }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: { browser.pendingReplay = ""; billing.close() } } CButton { objectName: "imagesBillingConfirm"; text: "Continue"; primary: true; onClicked: { billing.close(); if (browser.pendingReplay) browser.runRecipeId(browser.pendingReplay, true); else browser.generate(true) } } }
    }
    CDialog {
        id:transcribe; objectName:"artifactTranscriptionDialog"
        property var ref:null
        property var connections:[]
        readonly property var providerIds:["openai","xai","google","google_cloud","azure_speech","azure_openai","mistral","openrouter"]
        readonly property string providerId:providerIds[provider.currentIndex]||"openai"
        readonly property var accounts:connections.filter(row=>row.kind===providerId&&!row.migrated)
        function openFor(value){ref=value;provider.currentIndex=0;model.text="";language.text="";region.text="";cloudUri.text="";consent.checked=false;message.text="";rpc.call("connections.list",{},result=>{if(!result.error)connections=result});open()}
        CText { text:"Cloud transcription"; font.pixelSize:Theme.title; font.bold:true }
        CText { text:"The selected immutable WAV version will be uploaded to the provider. PAL saves the structured result as a new Library artifact."; wrapMode:Text.Wrap; color:Theme.muted; Layout.fillWidth:true }
        CComboBox { id:provider; Layout.fillWidth:true; model:transcribe.providerIds.map(id=>id==="google_cloud"?"Google Cloud Speech":(App.state.providerTraits?.[id]?.label||id)); Accessible.name:"Transcription provider" }
        CComboBox { id:speechAccount; visible:transcribe.accounts.length>0; Layout.fillWidth:true; model:["Provider default"].concat(transcribe.accounts.map(row=>row.name)); Accessible.name:"Named speech account" }
        CField { id:model; Layout.fillWidth:true; placeholderText:"Model (optional)"; Accessible.name:"Transcription model" }
        CField { id:language; Layout.fillWidth:true; placeholderText:"Language, such as en-US (optional)"; Accessible.name:"Transcription language" }
        CField { id:region; visible:transcribe.providerId==="azure_speech"||transcribe.providerId==="google_cloud"; Layout.fillWidth:true; placeholderText:"Region (required by some services)"; Accessible.name:"Speech region" }
        CField { id:cloudUri; visible:transcribe.providerId==="google_cloud"; Layout.fillWidth:true; placeholderText:"Google Cloud Storage URI (optional)"; Accessible.name:"Cloud Storage URI" }
        CCheckBox { id:consent; text:"I understand this audio will leave this computer and be processed by "+transcribe.providerId+"." }
        CText { id:message; visible:!!text; color:Theme.danger; wrapMode:Text.Wrap; Layout.fillWidth:true }
        RowLayout { Layout.fillWidth:true; Item { Layout.fillWidth:true }
            CButton { text:"Cancel"; onClicked:transcribe.close() }
            CButton { text:"Transcribe"; primary:true; enabled:consent.checked; onClicked:{
                const settings={};if(model.text.trim())settings.model=model.text.trim();if(language.text.trim())settings.language=language.text.trim();if(region.text.trim())settings.region=region.text.trim();if(speechAccount.visible&&speechAccount.currentIndex>0)settings.connectionId=transcribe.accounts[speechAccount.currentIndex-1].id
                const request={sessionId:browser.sessionId,artifactId:transcribe.ref.artifactId,versionId:transcribe.ref.versionId,provider:transcribe.providerId,settings:settings,acknowledgeUpload:true};if(cloudUri.visible&&cloudUri.text.trim())request.googleCloudUri=cloudUri.text.trim()
                rpc.call("voice.transcribeArtifact",request,value=>{if(value.error)message.text=value.error;else{browser.notice="Transcription finished and was saved to the Library.";transcribe.close();browser.refresh(true)}})
            } }
        }
    }
    CDialog {
        id: removeConfirm; objectName: "artifactRemoveDialog"
        property var derived: []
        onOpened: { derived = []; withDerived.checked = false; rpc.call("artifacts.derived", { sessionId: browser.sessionId, artifactId: browser.selected.id }, value => { if (!value.error) removeConfirm.derived = value.derived || [] }) }
        CText { text: "Remove from this conversation?"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: "PAL forgets this file here. If nothing else uses it, its stored copy and thumbnails are deleted. Copies you saved or exported elsewhere are not touched." }
        CCheckBox { id: withDerived; objectName: "artifactRemoveDerived"; visible: removeConfirm.derived.length > 0
            text: "Also remove what was made from it: " + removeConfirm.derived.slice(0, 3).map(d => d.name).join(", ") + (removeConfirm.derived.length > 3 ? " and " + (removeConfirm.derived.length - 3) + " more" : "") }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: removeConfirm.close() }
            CButton { objectName: "artifactRemoveConfirm"; text: "Remove"; danger: true; onClicked: { removeConfirm.close(); rpc.call("artifacts.remove", { sessionId: browser.sessionId, artifactId: browser.selected.id, scope: withDerived.checked ? "derived" : "artifact" }, value => { if (value.error) browser.error = value.error; browser.selected = null; browser.details = null; browser.refresh() }) } } }
    }
    CDialog {
        id: importDialog
        property string path: ""
        function openFor(path) { importDialog.path = path; importRemote.checked = false; importCloud.checked = false; open() }
        CText { text: "Import a copy"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: importDialog.path; font.family: Theme.mono; font.pixelSize: Theme.caption; wrapMode: Text.WrapAnywhere; color: Theme.muted }
        CText { text: "PAL keeps a private copy; the original is not changed or watched. Who may process it:" }
        CCheckBox { checked: true; enabled: false; text: "Models and tools on this computer" }
        CCheckBox { id: importRemote; text: "Also your own servers (another computer running Ollama or ComfyUI)" }
        CCheckBox { id: importCloud; text: "Also cloud services (hosted image and vision APIs)" }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: importDialog.close() }
            CButton { objectName: "imagesImportConfirm"; text: "Import"; primary: true; onClicked: { const path = importDialog.path, destinations = { remote: importRemote.checked || importCloud.checked, cloud: importCloud.checked }; importDialog.close(); browser.importPaths([path], destinations) } } }
    }
}
