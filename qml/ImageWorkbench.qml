import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// The image editor. Every change makes a new version: crops, rotations, resizes and format changes run
// locally and deterministically in the broker; annotations and masks are drawn here at the image's own
// pixel size (after EXIF orientation) and kept as an editable recipe beside the flattened result.
// A mask is its own artifact: white edits, transparent keeps.
Item {
    id: editor
    objectName: "imageWorkbench"
    implicitHeight: editorLayout.implicitHeight
    property string sessionId: ""
    readonly property var selection: WorkbenchState.imageFor(sessionId)
    readonly property string artifactId: selection.artifactId || ""
    readonly property string versionId: selection.versionId || ""
    property var info: null
    property string path: ""
    property string error: ""
    property string notice: ""
    property string tool: "pan"
    property color ink: "#ff3b30"
    property int brush: 24
    property var shapes: []
    property var undone: []
    property var maskStrokes: []
    property bool maskInverted: false
    property var cropRect: null
    property string cropRatio: "free"
    property string compareId: ""
    property string comparePath: ""
    property string loadedArtifactId: ""
    property real split: 0.5
    readonly property int naturalWidth: picture.implicitWidth
    readonly property int naturalHeight: picture.implicitHeight
    signal closeRequested()
    signal maskReady(var ref)
    signal editRequested(var target, string instruction, var maskRef)
    property string smartMask: ""
    property bool smartReady: false
    property var ocrLines: []
    property var ocrRegion: undefined
    property var other: null
    property string diffOverlay: ""
    property bool showDiff: false
    property int tolerance: 32
    property string backing: "Checkerboard"
    property string compareName: ""
    readonly property var currentVersion: (info?.versions || []).find(v=>v.versionId===versionId) || null
    readonly property var currentRef: ({artifactId:artifactId,versionId:versionId,name:info?.artifact?.name || "Image"})
    function callImage(method, extra, done) {
        error = ""
        rpc.call(method, Object.assign({sessionId:sessionId,artifactId:artifactId,versionId:versionId},extra), value => {
            if (value.error) error = value.error
            else done(value)
        })
    }
    function compareWith(ref) {
        other = ref; showDiff = false; diffOverlay = ""
        if (!ref) { comparePath = ""; return }
        rpc.call("artifacts.file",{sessionId:sessionId,artifactId:ref.artifactId,versionId:ref.versionId},value=>{
            if (other?.versionId !== ref.versionId) return
            if (value.error) error=value.error
            else { comparePath=value.path; compareName=(ref.name || value.name)+" · "+ref.versionId.slice(0,8) }
        })
    }
    function readRegion() {
        if (!cropRect || (tool !== "region" && tool !== "crop")) return undefined
        const left=Math.max(0,Math.floor(cropRect.x)), top=Math.max(0,Math.floor(cropRect.y))
        return {left:left,top:top,width:Math.min(naturalWidth-left,Math.max(1,Math.round(cropRect.width))),
                height:Math.min(naturalHeight-top,Math.max(1,Math.round(cropRect.height)))}
    }
    function stageQuestion(message, withOcr) {
        const region = withOcr ? ocrRegion : readRegion()
        function stage(ref,transcript) {
            const err=WorkbenchState.useImage(sessionId,ref,message,transcript?[transcript]:[])
            if (err) error=err
            else notice="Added to your next message."
        }
        function attach(transcript) {
            if (region) {
                message += " Use the selected region ("+region.left+", "+region.top+", "+region.width+"×"+region.height+") from "+currentRef.name+" (version "+versionId+")."
                callImage("images.region",{region:region},v=>stage(v,transcript))
            } else stage(currentRef,transcript)
        }
        if (withOcr) {
            notice="Preparing the source transcription…"
            callImage("images.ocr",{region:region,keepTranscript:true},v=>attach(v.transcript))
        } else attach(null)
    }
    function reopenAnnotations() {
        let recipe
        try { recipe=JSON.parse(currentVersion?.provenance?.recipe || "") } catch (_) { error="The annotation recipe could not be read."; return }
        const base=info.versions.find(v=>v.versionId===recipe.base)
        if (!base || !Array.isArray(recipe.shapes)) { error="The source version for these annotations is unavailable."; return }
        WorkbenchState.keepDraft(base.versionId,{shapes:recipe.shapes,mask:[],inverted:false},sessionId)
        WorkbenchState.selectImage(sessionId,base.artifactId,base.versionId)
        tool="text"
    }
    function recognize() {
        notice="Reading text on this computer…"
        const region=readRegion()
        callImage("images.ocr",{region:region},value=>{
            ocrRegion=region; ocrLines=value.lines || []
            notice=ocrLines.length ? ocrLines.length+" lines recognized" : "No readable text found."
        })
    }
    function askEdit(instruction, wantMask) {
        if (wantMask && (maskStrokes.length || maskInverted || smartMask)) saveMask(instruction)
        else editRequested(currentRef,instruction,null)
    }
    function usableMask() { return !!(maskStrokes.length || maskInverted || smartMask) && (!smartMask || smartReady) }
    function smartSelect(p) {
        callImage("images.selectColour",{point:p,tolerance:tolerance,mode:tool},value=>{
            smartMask=value.overlay; maskStrokes=[]; maskInverted=false; undone=[]; keepDraft()
            tool="mask"; notice="Refine the selection with the mask brush or eraser."
        })
    }
    onSmartMaskChanged: {
        smartReady=false
        if (smartMask) {
            maskLayer.loadImage(smartMask)
            smartReady=maskLayer.isImageLoaded(smartMask)
        }
        maskLayer.requestPaint()
    }
    readonly property string ownerKey: sessionId + ":" + artifactId + ":" + versionId
    RpcClient { id: rpc; scope: editor.ownerKey }
    Timer { id: initialLoad; interval: 0; onTriggered: editor.load() }
    function load() {
        if (loadedArtifactId !== artifactId) notice = ""
        loadedArtifactId = artifactId
        info = null; path = ""; error = ""; compareId = ""; comparePath = ""
        shapes = []; maskStrokes = []; smartMask = ""; maskInverted = false; undone = []; cropRect = null; ocrLines = []; ocrRegion = undefined; other = null; showDiff = false; diffOverlay = ""; externalDialog.saved = ""; externalDialog.baseVersion = ""
        if (!artifactId || !versionId || !sessionId) return
        rpc.call("images.select", { sessionId:sessionId, ref:currentRef })
        rpc.call("artifacts.get", { sessionId: sessionId, artifactId: artifactId }, value => { if (!value.error) info = value })
        rpc.call("artifacts.file", { sessionId: sessionId, artifactId: artifactId, versionId: versionId }, value => {
            if (value.error) { error = value.error; return }
            path = value.path; error = ""
            const draft = WorkbenchState.draft(versionId, sessionId)
            smartMask = draft?.smartMask || ""; shapes = draft ? draft.shapes : []; maskStrokes = draft ? draft.mask : []; maskInverted = draft ? draft.inverted : false; undone = []
            if (selection.compare) compareWith(selection.compare)
        })
    }
    function keepDraft() { WorkbenchState.keepDraft(versionId, shapes.length || maskStrokes.length || maskInverted || smartMask ? { smartMask:smartMask, shapes: shapes, mask: maskStrokes, inverted: maskInverted } : undefined, sessionId) }
    function add(shape) { if (shape.layer === "mask") maskStrokes = maskStrokes.concat([shape]); else shapes = shapes.concat([shape]); undone = []; keepDraft(); annotations.requestPaint(); maskLayer.requestPaint() }
    function undo() {
        const last = [...shapes, ...maskStrokes].sort((a, b) => b.at - a.at)[0]; if (!last) return
        undone = undone.concat([last]); if (last.layer === "mask") maskStrokes = maskStrokes.filter(s => s !== last); else shapes = shapes.filter(s => s !== last)
        keepDraft(); annotations.requestPaint(); maskLayer.requestPaint()
    }
    function redo() { const shape = undone[undone.length - 1]; if (!shape) return; undone = undone.slice(0, -1); if (shape.layer === "mask") maskStrokes = maskStrokes.concat([shape]); else shapes = shapes.concat([shape]); keepDraft(); annotations.requestPaint(); maskLayer.requestPaint() }
    function applySteps(steps, label) {
        notice = ""; error = ""
        rpc.call("images.transform", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, steps: steps }, value => {
            if (value.error) { error = value.error; return }
            notice = label + " · new version"; WorkbenchState.keepDraft(versionId, undefined, sessionId); WorkbenchState.selectImage(sessionId, artifactId, value.versionId)
        })
    }
    function saveAnnotations() {
        cropRect = null; annotations.requestPaint()
        const requestedOwner = ownerKey
        Qt.callLater(() => {
            if (requestedOwner !== ownerKey) return
            const data = annotations.toDataURL("image/png")
            rpc.call("images.saveEdit", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, layer: data, recipe: JSON.stringify({ base: versionId, shapes: shapes }) }, value => {
                if (value.error) { error = value.error; return }
                notice = "Annotations saved as a new version; the original is unchanged"; WorkbenchState.keepDraft(versionId, undefined, sessionId); shapes = []; WorkbenchState.selectImage(sessionId, artifactId, value.versionId)
            })
        })
    }
    function saveMask(instruction) {
        const data = maskLayer.exportMask()
        rpc.call("images.mask", { sessionId: sessionId, artifactId: artifactId, versionId: versionId, mask: data }, value => {
            if (value.error) { error = value.error; return }
            notice = "Mask saved (" + value.provenance.coverage + "% of the image)"; const ref = { artifactId:value.artifactId,versionId:value.versionId }
            if (instruction) editor.editRequested(currentRef,instruction,ref)
            else editor.maskReady(ref)
        })
    }
    function applyCrop() {
        if (!cropRect || cropRect.width < 2 || cropRect.height < 2) return
        applySteps([{ op: "crop", left: Math.round(cropRect.x), top: Math.round(cropRect.y), width: Math.round(cropRect.width), height: Math.round(cropRect.height) }], "Cropped"); cropRect = null
    }
    function ratioOf(name) { return name === "1:1" ? 1 : name === "4:3" ? 4 / 3 : name === "3:2" ? 3 / 2 : name === "16:9" ? 16 / 9 : name === "9:16" ? 9 / 16 : 0 }
    function fit() { const z = Math.min(view.width / Math.max(1, naturalWidth), view.height / Math.max(1, naturalHeight)); WorkbenchState.zoom = Math.max(0.05, Math.min(8, z)) }
    onSelectionChanged: initialLoad.restart()
    onSessionIdChanged: initialLoad.restart()
    Component.onCompleted: initialLoad.restart()
    Keys.onPressed: event => {
        if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_Z) { if (event.modifiers & Qt.ShiftModifier) redo(); else undo(); event.accepted = true }
        else if (comparePath && (event.key === Qt.Key_Left || event.key === Qt.Key_Right)) { showDiff=false; split=event.key===Qt.Key_Left?1:0; event.accepted=true }
        else if (event.key === Qt.Key_Escape) { closeRequested(); event.accepted = true }
    }
    ColumnLayout {
        id: editorLayout
        anchors.fill: parent; spacing: Theme.space2
        GridLayout {
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: editor.width; Layout.maximumWidth: editor.width; rowSpacing: Theme.space1; columnSpacing: Theme.space2
            readonly property bool compact: editor.width < Theme.toolbarBreakpoint
            columns: compact ? 2 : 3
            CButton { objectName: "imageEditorBack"; Layout.row: 0; Layout.column: 0; text: "Gallery"; iconName: "back"; quiet: true; onClicked: editor.closeRequested() }
            CText { Layout.row: parent.compact ? 1 : 0; Layout.column: parent.compact ? 0 : 1; Layout.columnSpan: parent.compact ? 2 : 1; Layout.fillWidth: true; text: (info?.artifact?.name || "") + (editor.naturalWidth ? " · " + editor.naturalWidth + "×" + editor.naturalHeight : ""); elide: Text.ElideMiddle; wrapMode: Text.NoWrap; font.weight: Font.DemiBold }
            CComboBox { objectName: "imageVersion"; Layout.row: 0; Layout.column: parent.compact ? 1 : 2; Layout.fillWidth: parent.compact; Layout.minimumWidth: 0; implicitWidth: Theme.fieldMedium; model: (editor.info?.versions || []).map((v, i) => "Version " + (i + 1)); currentIndex: Math.max(0, (editor.info?.versions || []).findIndex(v => v.versionId === editor.versionId)); Accessible.name: "Version"
                onActivated: index => WorkbenchState.selectImage(editor.sessionId, editor.artifactId, editor.info.versions[index].versionId) }
        }
        Flow {
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: editor.width; Layout.maximumWidth: editor.width; spacing: Theme.space2
            CButton { objectName:"imageAsk"; text:"Ask about this"; onClicked: { askField.text=""; askDialog.open(); askField.forceActiveFocus() } }
            CButton { objectName:"imageEditPrompt"; text:"Edit this"; primary:true; onClicked:editor.askEdit("",true) }
            CButton { text:"Use in chat"; onClicked:{ const err=WorkbenchState.useImage(editor.sessionId,editor.currentRef,""); if(err) editor.error=err; else editor.notice="This version is in your next message." } }
            CButton { objectName:"imageReadText"; text:"Read text"; onClicked:editor.recognize() }
            CButton { text:"More image tools"; onClicked:actions.open() }
        }
        CText { visible: editor.tool==="region"; text:"Drag across the part to read or ask about."; color:Theme.muted }
        Flow {
            visible:editor.ocrLines.length>0; Layout.fillWidth:true; Layout.preferredWidth:editor.width; spacing:Theme.space1
            CButton { text:"Copy text"; onClicked:{ App.copy(editor.ocrLines.map(l=>l.text).join("\n")); editor.notice="Recognized text copied." } }
            CButton { text:"Explain text"; onClicked:editor.stageQuestion("Explain the visible text and the meaning of any error.",true) }
            CButton { text:"Create issue draft"; onClicked:editor.stageQuestion("Draft an issue report from this screenshot. Quote the visible error, distinguish observations from possible causes, and identify any reproduction steps that still need confirmation.",true) }
            CButton { text:"Hide text boxes"; quiet:true; onClicked:editor.ocrLines=[] }
        }
        Flickable {
            id: view; objectName: "imageCanvas"
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorMedium; clip: true
            contentWidth: stage.width * WorkbenchState.zoom; contentHeight: stage.height * WorkbenchState.zoom
            interactive: editor.tool === "pan"; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: CScrollBar {}
            ScrollBar.horizontal: CScrollBar {}
            Item {
                id: stage; width: editor.naturalWidth; height: editor.naturalHeight; scale: WorkbenchState.zoom; transformOrigin: Item.TopLeft
                // Transparency shows as a checkerboard, never as an invented background color.
                Canvas { anchors.fill: parent; visible:editor.backing==="Checkerboard"; onPaint: { const c = getContext("2d"); for (let y = 0; y < height; y += 16) for (let x = 0; x < width; x += 16) { c.fillStyle = ((x + y) / 16) % 2 ? "#cccccc" : "#ffffff"; c.fillRect(x, y, 16, 16) } } }
                Rectangle { anchors.fill:parent; visible:editor.backing!=="Checkerboard"; color:editor.backing==="Light"?"#ffffff":"#000000" }
                Image { id: picture; onStatusChanged:if(status===Image.Ready) Qt.callLater(editor.fit); source: editor.path ? "file://" + editor.path : ""; autoTransform: true; cache: false; smooth: WorkbenchState.zoom < 2; Accessible.role: Accessible.Graphic; Accessible.name: "Image being edited" }
                // Comparing: the chosen version on the left of the divider (before), this one on the right (after).
                Item { visible: !!editor.comparePath && !editor.showDiff; x: 0; y: 0; width: parent.width * editor.split; height: parent.height; clip: true
                    Image { source: editor.comparePath ? "file://" + editor.comparePath : ""; autoTransform: true; width: stage.width; height: stage.height; fillMode: Image.PreserveAspectFit } }
                Rectangle { visible: !!editor.comparePath && !editor.showDiff; x: parent.width * editor.split - width / 2; width: 2 / WorkbenchState.zoom; height: parent.height; color: Theme.focus }
                Image { visible:editor.showDiff; source:editor.diffOverlay; anchors.fill:parent; fillMode:Image.Stretch }
                Repeater {
                    model: editor.ocrLines
                    Rectangle {
                        required property var modelData
                        x:modelData.box.left; y:modelData.box.top; width:modelData.box.width; height:modelData.box.height
                        color:"transparent"; border.color:Theme.focus; border.width:Math.max(1,2/WorkbenchState.zoom)
                        Accessible.name:modelData.text; Accessible.role:Accessible.StaticText
                    }
                }
                Canvas {
                    id: maskLayer; anchors.fill: parent; opacity: 0.45; canvasSize: Qt.size(width, height)
                    function draw(c, color, overlay) {
                        c.save(); c.clearRect(0, 0, width, height)
                        if (editor.smartMask && isImageLoaded(editor.smartMask)) c.drawImage(editor.smartMask,0,0,width,height)
                        for (const s of editor.maskStrokes) {
                            c.lineCap = "round"; c.lineJoin = "round"; c.lineWidth = s.size
                            c.globalCompositeOperation = s.erase !== !!s.inverted ? "destination-out" : "source-over"
                            c.strokeStyle = "#ffffff"; c.fillStyle = "#ffffff"
                            if (s.points.length === 1) { c.beginPath(); c.arc(s.points[0].x,s.points[0].y,s.size/2,0,Math.PI*2); c.fill() }
                            else { c.beginPath(); c.moveTo(s.points[0].x,s.points[0].y); for (const p of s.points) c.lineTo(p.x,p.y); c.stroke() }
                        }
                        if (editor.maskInverted) { c.globalCompositeOperation="xor"; c.fillStyle="#ffffff"; c.fillRect(0,0,width,height) }
                        c.globalCompositeOperation="source-in"; c.fillStyle=color; c.fillRect(0,0,width,height)
                        c.restore()
                    }
                    onImageLoaded: { editor.smartReady=!!editor.smartMask && isImageLoaded(editor.smartMask); requestPaint() }
                    onPaint: draw(getContext("2d"), Theme.danger, true)
                    // The exported mask is white where the image may change and transparent elsewhere, at full size.
                    function exportMask() { const c = getContext("2d"); draw(c, "#ffffff", false); const data = toDataURL("image/png"); requestPaint(); return data }
                }
                Canvas {
                    id: annotations; anchors.fill: parent; canvasSize: Qt.size(width, height)
                    onPaint: {
                        const c = getContext("2d"); c.clearRect(0, 0, width, height)
                        for (const s of editor.shapes) {
                            c.strokeStyle = s.color; c.fillStyle = s.color; c.lineWidth = s.size; c.lineCap = "round"; c.lineJoin = "round"
                            if (s.kind === "rect") c.strokeRect(s.x, s.y, s.w, s.h)
                            else if (s.kind === "pen") { c.beginPath(); c.moveTo(s.points[0].x, s.points[0].y); for (const p of s.points) c.lineTo(p.x, p.y); c.stroke() }
                            else if (s.kind === "arrow") { const a = Math.atan2(s.y2 - s.y, s.x2 - s.x), h = Math.max(10, s.size * 3); c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x2, s.y2); c.stroke(); c.beginPath(); c.moveTo(s.x2, s.y2); c.lineTo(s.x2 - h * Math.cos(a - 0.5), s.y2 - h * Math.sin(a - 0.5)); c.lineTo(s.x2 - h * Math.cos(a + 0.5), s.y2 - h * Math.sin(a + 0.5)); c.closePath(); c.fill() }
                            else if (s.kind === "text") { c.font = (s.size * 3) + "px sans-serif"; c.fillText(s.text, s.x, s.y) }
                        }
                    }
                }
                Rectangle {
                    visible:!!editor.cropRect && (editor.tool==="region" || editor.tool==="crop")
                    x:editor.cropRect?.x || 0; y:editor.cropRect?.y || 0
                    width:editor.cropRect?.width || 0; height:editor.cropRect?.height || 0
                    color:Theme.transparent; border.color:Theme.focus; border.width:2 / WorkbenchState.zoom
                }
                MouseArea {
                    anchors.fill: parent; enabled: editor.tool !== "pan"; cursorShape: Qt.CrossCursor
                    property var current: null
                    function clamp(p) { return { x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) } }
                    onPressed: mouse => {
                        const p = clamp(mouse)
                        if (editor.tool === "background" || editor.tool === "subject") { editor.smartSelect(p); return }
                        if (editor.tool === "crop" || editor.tool === "region") { editor.ocrLines=[]; current = { x0: p.x, y0: p.y } }
                        else if (editor.tool === "pen" || editor.tool === "mask" || editor.tool === "erase") current = { kind: "pen", layer: editor.tool === "pen" ? "annotations" : "mask", erase: editor.tool === "erase", inverted:editor.maskInverted, color: editor.ink.toString(), size: editor.brush, points: [p], at: Date.now() }
                        else if (editor.tool === "text") {
                            const existing=editor.shapes.slice().reverse().find(s=>s.kind==="text" && p.x>=s.x-4 && p.x<=s.x+Math.max(8,s.text.length*s.size*2) && p.y>=s.y-s.size*3 && p.y<=s.y+4)
                            if(existing){ labelDialog.shape=existing; labelEdit.text=existing.text; labelDialog.open(); return }
                            if (labelText.text.trim()) editor.add({ kind: "text", layer: "annotations", text: labelText.text, x: p.x, y: p.y, color: editor.ink.toString(), size: Math.max(4, editor.brush / 2), at: Date.now() }) }
                        else current = { kind: editor.tool, layer: "annotations", x: p.x, y: p.y, x2: p.x, y2: p.y, w: 0, h: 0, color: editor.ink.toString(), size: Math.max(2, editor.brush / 6), at: Date.now() }
                    }
                    onPositionChanged: mouse => {
                        if (!current) return
                        const p = clamp(mouse)
                        if (editor.tool === "crop" || editor.tool === "region") {
                            let w = p.x - current.x0, h = p.y - current.y0; const r = editor.tool === "crop" ? editor.ratioOf(editor.cropRatio) : 0
                            if (r) h = Math.sign(h || 1) * Math.abs(w) / r
                            editor.cropRect = Qt.rect(Math.min(current.x0, current.x0 + w), Math.min(current.y0, current.y0 + h), Math.abs(w), Math.min(Math.abs(h), height)); annotations.requestPaint()
                        } else if (current.points) { current.points.push(p); if (current.layer === "mask") { editor.maskStrokes = editor.maskStrokes.filter(s => s !== current).concat([current]); maskLayer.requestPaint() } else { editor.shapes = editor.shapes.filter(s => s !== current).concat([current]); annotations.requestPaint() } }
                        else { current.x2 = p.x; current.y2 = p.y; current.w = p.x - current.x; current.h = p.y - current.y; editor.shapes = editor.shapes.filter(s => s !== current).concat([current]); annotations.requestPaint() }
                    }
                    onReleased: { if (current && editor.tool !== "crop" && editor.tool !== "region") { editor.shapes = editor.shapes.filter(s => s !== current); editor.maskStrokes = editor.maskStrokes.filter(s => s !== current); editor.add(current) } current = null }
                }
            }
            onWidthChanged: if (WorkbenchState.zoom === 1 && editor.naturalWidth > width) Qt.callLater(editor.fit)
        }
        RowLayout {
            visible: !!editor.comparePath; Layout.fillWidth: true
            CText { Layout.fillWidth: false; text: "Before" } CSlider { Layout.fillWidth: true; from: 0; to: 1; value: editor.split; onMoved: editor.split = value; Accessible.name: "Comparison divider" } CText { Layout.fillWidth: false; text: "After" }
        }
        Flow {
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: editor.width; Layout.maximumWidth: editor.width; spacing: Theme.space1
            Repeater {
                model: [["pan", "Move"], ["region", "Select region"], ["crop", "Crop"], ["arrow", "Arrow"], ["rect", "Box"], ["pen", "Draw"], ["text", "Label"], ["mask", "Mask brush"], ["erase", "Mask eraser"]]
                CButton { required property var modelData; objectName: "imageTool_" + modelData[0]; text: modelData[1]; implicitHeight: Theme.compactHeight; quiet: editor.tool !== modelData[0]; primary: editor.tool === modelData[0]; Accessible.role: Accessible.RadioButton; Accessible.checked: editor.tool === modelData[0]; onClicked: { editor.tool = modelData[0]; editor.forceActiveFocus() } }
            }
        }
        Flow {
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: editor.width; Layout.maximumWidth: editor.width; spacing: Theme.space1
            CButton { text: "Fit"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: editor.fit() }
            CButton { text: "100%"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: WorkbenchState.zoom = 1 }
            CSlider { implicitWidth: Theme.fieldMedium; from: 0.05; to: 8; value: WorkbenchState.zoom; onMoved: WorkbenchState.zoom = value; Accessible.name: "Zoom" }
            CButton { text: "Undo"; implicitHeight: Theme.compactHeight; quiet: true; enabled: editor.shapes.length + editor.maskStrokes.length > 0; onClicked: editor.undo() }
            CButton { text: "Redo"; implicitHeight: Theme.compactHeight; quiet: true; enabled: editor.undone.length > 0; onClicked: editor.redo() }
            CButton { text: "Rotate"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: editor.applySteps([{ op: "rotate", degrees: 90 }], "Rotated") }
            CButton { text: "Flip"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: editor.applySteps([{ op: "flip", axis: "horizontal" }], "Flipped") }
            CButton { text: "Resize…"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: resizeDialog.open() }
            CButton { text: "Export as…"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: formatDialog.open() }
            CButton { text: "Open in another app"; implicitHeight: Theme.compactHeight; quiet: true; help: "Edit a copy elsewhere, then import it back as a new version"; onClicked: externalDialog.open() }
        }
        GridLayout {
            visible: editor.tool === "crop"; Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: editor.width; Layout.maximumWidth: editor.width; rowSpacing: Theme.space1; columnSpacing: Theme.space1
            readonly property bool compact: editor.width < Theme.toolbarBreakpoint
            columns: compact ? 2 : 3
            CComboBox { Layout.fillWidth: parent.compact; Layout.minimumWidth: 0; implicitWidth: Theme.fieldMedium; model: ["free", "1:1", "4:3", "3:2", "16:9", "9:16"]; onActivated: index => editor.cropRatio = model[index]; Accessible.name: "Crop ratio" }
            CText { Layout.row: parent.compact ? 1 : 0; Layout.column: parent.compact ? 0 : 1; Layout.columnSpan: parent.compact ? 2 : 1; Layout.fillWidth: true; text: editor.cropRect ? Math.round(editor.cropRect.width) + "×" + Math.round(editor.cropRect.height) + " at " + Math.round(editor.cropRect.x) + ", " + Math.round(editor.cropRect.y) : "Drag on the image to choose the area"; color: Theme.muted; font.pixelSize: Theme.caption }
            CButton { objectName: "imageApplyCrop"; Layout.row: 0; Layout.column: parent.compact ? 1 : 2; Layout.alignment: Qt.AlignRight; text: "Crop"; primary: true; implicitHeight: Theme.compactHeight; enabled: !!editor.cropRect; onClicked: editor.applyCrop() }
        }
        Item {
            visible: ["arrow", "rect", "pen", "text", "mask", "erase"].indexOf(editor.tool) >= 0
            Layout.fillWidth: true; Layout.minimumWidth: 0; implicitHeight: brushOptions.implicitHeight
            Flow {
                id: brushOptions
                anchors.left: parent.left; anchors.right: parent.right; spacing: Theme.space1
                Repeater { model: ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"]
                    AbstractButton {
                        id: swatch
                        required property string modelData
                        visible: editor.tool !== "mask" && editor.tool !== "erase"
                        width: Theme.minimumTarget
                        height: Theme.minimumTarget
                        hoverEnabled: true
                        Accessible.role: Accessible.RadioButton
                        Accessible.name: qsTr("Annotation color %1").arg(modelData)
                        Accessible.checked: editor.ink == modelData
                        onClicked: editor.ink = modelData
                        background: Rectangle {
                            radius: width / 2
                            color: Theme.transparent
                            border.width: Theme.focusWidth
                            border.color: swatch.visualFocus ? Theme.focus : swatch.hovered ? Theme.borderHover : Theme.transparent
                            Rectangle {
                                anchors.fill: parent
                                anchors.margins: Theme.space1
                                radius: width / 2
                                color: swatch.modelData
                                border.color: Theme.border
                                CIcon {
                                    anchors.fill: parent
                                    visible: editor.ink == swatch.modelData
                                    name: "check"
                                    color: parent.color.hslLightness > 0.5 ? Theme.background : Theme.text
                                }
                            }
                        }
                    }
                }
                CText { width: implicitWidth; height: Theme.compactHeight; verticalAlignment: Text.AlignVCenter; text: "Size" }
                CSpinBox { from: 1; to: 400; value: editor.brush; onValueModified: editor.brush = value; Accessible.name: "Brush size" }
                CField { id: labelText; visible: editor.tool === "text"; width: Math.min(implicitWidth, editor.width); placeholderText: "Label text"; Accessible.name: "Label text" }
                CButton { visible: editor.tool === "mask" || editor.tool === "erase"; text: editor.maskInverted ? "Uninvert" : "Invert"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: { editor.maskInverted = !editor.maskInverted; editor.keepDraft(); maskLayer.requestPaint() } }
                CButton { visible: editor.tool === "mask" || editor.tool === "erase"; text: "Clear mask"; implicitHeight: Theme.compactHeight; quiet: true; onClicked: { editor.maskStrokes = []; editor.smartMask = ""; editor.maskInverted = false; editor.keepDraft(); maskLayer.requestPaint() } }
            }
        }
        CText { visible: editor.tool === "background" || editor.tool === "subject"; text:editor.tool === "background" ? "Click the background color to select connected pixels." : "Click the subject to select it against its surrounding background."; color:Theme.muted }
        CSlider { visible:editor.tool === "background" || editor.tool === "subject"; from:0; to:128; value:editor.tolerance; Accessible.name:"Color tolerance"; onMoved:editor.tolerance=Math.round(value) }
        CText { visible: !!editor.error; text: editor.error; color: Theme.danger; font.pixelSize: Theme.secondary; Accessible.role: Accessible.AlertMessage }
        CText { visible: !!editor.notice; text: editor.notice; color: Theme.accentText; font.pixelSize: Theme.secondary }
        Flow {
            Layout.fillWidth: true; Layout.minimumWidth: 0; Layout.preferredWidth: editor.width; Layout.maximumWidth: editor.width; spacing: Theme.space2
            CComboBox { objectName: "imageCompare"; implicitWidth: Theme.fieldWidth; model: ["Compare with…"].concat((editor.info?.versions || []).map((v, i) => "Version " + (i + 1))); Accessible.name: "Compare with version"
                onActivated: index => { editor.compareWith(index ? editor.info.versions[index-1] : null) } }
            CText { visible:!!editor.comparePath;text:editor.compareName;color:Theme.muted }
            CButton { visible:!!editor.other; text:"Use comparison in chat";quiet:true;onClicked:{
                const error=WorkbenchState.useImage(editor.sessionId,Object.assign({},editor.other,{name:editor.compareName}),"")
                if(error)editor.error=error;else editor.notice="Comparison version added to your message."
            }}
            CButton { visible:!!editor.comparePath; text:editor.showDiff?"Show divider":"Highlight changes"; onClicked:{
                if(editor.showDiff) { editor.showDiff=false; return }
                const expected=editor.other?.versionId
                editor.callImage("images.difference",{other:editor.other},v=>{if(editor.other?.versionId!==expected)return;editor.diffOverlay=v.overlay; editor.showDiff=true; editor.notice=v.changed+" pixels differ."})
            } }
            CButton { objectName: "imageSaveAnnotations"; text: "Save annotations"; enabled: editor.shapes.length > 0; onClicked: editor.saveAnnotations() }
            CButton { objectName: "imageSaveMask"; text: "Use mask for an edit"; primary: editor.maskStrokes.length > 0; enabled: editor.usableMask(); onClicked: editor.saveMask("") }
        }
    }
    CDialog {
        id:labelDialog
        property var shape:null
        CText {text:"Edit label";font.pixelSize:Theme.title}
        CField {id:labelEdit;Layout.fillWidth:true;Accessible.name:"Label text"}
        CButton {text:"Apply";enabled:!!labelEdit.text.trim();onClicked:{
            editor.shapes=editor.shapes.map(s=>s===labelDialog.shape ? Object.assign({},s,{text:labelEdit.text}):s)
            editor.keepDraft();annotations.requestPaint();labelDialog.close()
        }}
    }
    CDialog {
        id:askDialog
        CText { text:editor.readRegion()?"Ask about this region":"Ask about this image"; font.pixelSize:Theme.title }
        CTextArea { id:askField; placeholderText:"What would you like to know?"; Layout.fillWidth:true; Accessible.name:"Image question" }
        CButton { text:"Add to chat"; primary:true; enabled:!!askField.text.trim(); onClicked:{ askDialog.close();editor.stageQuestion(askField.text.trim()) } }
        CButton { text:"Ask vision helper"; enabled:!!askField.text.trim(); onClicked:{
            askDialog.close(); editor.callImage("images.analyze",{region:editor.readRegion(),question:askField.text},v=>editor.notice=v.helper.model+" · "+v.answer)
        } }
    }
    CDialog {
        id:actions
        CText { text:"Image tools";font.pixelSize:Theme.title }
        CComboBox { model:["Checkerboard","Light","Dark"]; Accessible.name:"Transparency background"; onActivated:index=>editor.backing=model[index] }
        CButton { text:"Select background by color"; onClicked:{editor.tool="background";actions.close()} }
        CButton { text:"Select subject"; onClicked:{editor.tool="subject";actions.close()} }
        CButton { text:"Remove selected object"; enabled:editor.usableMask(); onClicked:{ actions.close();editor.askEdit("Remove the selected object and fill its area from the surrounding scene.",true) } }
        CButton { text:"Replace selected background"; enabled:editor.usableMask(); onClicked:{ actions.close();editor.askEdit("Replace the selected background with ",true) } }
        CButton { text:"Cut out selection as PNG"; enabled:editor.usableMask(); onClicked:{
            actions.close(); editor.callImage("images.cutout",{mask:maskLayer.exportMask()},v=>WorkbenchState.selectImage(editor.sessionId,v.artifactId,v.versionId))
        } }
        CComboBox { id:expandRatio; model:["16:9","9:16","1:1","4:3","3:2"]; Accessible.name:"Expanded aspect ratio" }
        CButton { text:"Expand to "+expandRatio.currentText; onClicked:{ actions.close(); editor.callImage("images.extend",{ratio:editor.ratioOf(expandRatio.currentText)},v=>editor.editRequested(v.target,"Extend the scene into the new canvas area.",v.mask)) } }
        CButton { text:"Edit saved annotations"; visible:editor.currentVersion?.provenance?.kind==="annotation"; onClicked:{actions.close();editor.reopenAnnotations()} }
        CButton { text:"Use markup as edit guide"; enabled:editor.shapes.length>0; onClicked:{
            actions.close(); editor.cropRect=null; annotations.requestPaint()
            const owner=editor.ownerKey
            Qt.callLater(()=>{ if(owner===editor.ownerKey) editor.callImage("images.markup",{layer:annotations.toDataURL("image/png")},v=>editor.editRequested(editor.currentRef,"Follow the markings in the guide, and omit them from the finished image.",{guide:v})) })
        } }
        CButton { text:"Inspect Content Credentials"; onClicked:{actions.close();editor.callImage("images.credentials",{},v=>editor.notice=[v.status,v.title,v.issuer,v.validation,(v.issues||[]).map(x=>x.code).join(", ")].filter(Boolean).join(" · "))} }
        CButton { text:"Close";quiet:true;onClicked:actions.close() }
    }
    CDialog {
        id: resizeDialog
        CText { text: "Resize"; font.pixelSize: Theme.title; font.bold: true }
        RowLayout { CSpinBox { id: newWidth; from: 1; to: 16384; value: Math.max(1, editor.naturalWidth); Accessible.name: "Width" } CText { Layout.fillWidth: false; text: "×" } CSpinBox { id: newHeight; from: 1; to: 16384; value: Math.max(1, editor.naturalHeight); Accessible.name: "Height" } }
        CCheckBox { id: nearest; text: "Nearest-neighbor (keeps pixel art crisp)" }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: resizeDialog.close() } CButton { text: "Resize"; primary: true; onClicked: { resizeDialog.close(); editor.applySteps([{ op: "resize", width: newWidth.value, height: newHeight.value, fit: "fill", kernel: nearest.checked ? "nearest" : "lanczos3" }], "Resized") } } }
    }
    CDialog {
        id: formatDialog
        CText { text: "Export as"; font.pixelSize: Theme.title; font.bold: true }
        CComboBox { id: targetFormat; model: ["png", "jpeg", "webp"]; Accessible.name: "Format" }
        CText { visible: targetFormat.currentText === "jpeg"; text: "JPEG cannot store transparency. Transparent areas are filled with:"; font.pixelSize: Theme.secondary }
        CField { id: flattenColor; visible: targetFormat.currentText === "jpeg"; text: "#ffffff"; Accessible.name: "Background color" }
        RowLayout { Layout.fillWidth: true; Item { Layout.fillWidth: true } CButton { text: "Cancel"; onClicked: formatDialog.close() }
            CButton { text: "Make version"; primary: true; onClicked: { formatDialog.close(); editor.applySteps([Object.assign({ op: "format", format: targetFormat.currentText }, targetFormat.currentText === "jpeg" ? { flatten: flattenColor.text } : {})], "Converted to " + targetFormat.currentText.toUpperCase()) } } }
    }
    CDialog {
        id: externalDialog
        property string baseVersion: ""
        property string saved: ""
        CText { text: "Edit in another application"; font.pixelSize: Theme.title; font.bold: true }
        CText { text: "Save a copy, edit it in your editor, then import the edited file back as a new version. The original stays as it is." }
        CButton { text: "Save a copy and open it"; onClicked: { const path = App.chooseSavePath(editor.info?.artifact?.name || "image.png"); if (!path) return; rpc.call("artifacts.saveAs", { sessionId: editor.sessionId, artifactId: editor.artifactId, versionId: editor.versionId, path: path, replace: true }, value => { if (value.error) editor.error = value.error; else { externalDialog.baseVersion=editor.versionId; externalDialog.saved = value.path; App.openPath(value.path) } }) } }
        CButton { text: "Import the edited file as a new version"; enabled: !!externalDialog.saved; onClicked: rpc.call("artifacts.import", { sessionId: editor.sessionId, path: externalDialog.saved, artifactId: editor.artifactId, versionId:externalDialog.baseVersion, destinations: (editor.info?.versions || []).slice(-1)[0]?.policy || {} }, value => { if (value.error) editor.error = value.error; else { externalDialog.close(); WorkbenchState.selectImage(editor.sessionId, editor.artifactId, value.versionId) } }) }
        CButton { text: "Close"; quiet: true; onClicked: externalDialog.close() }
    }
}
