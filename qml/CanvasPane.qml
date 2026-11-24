import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
// Workbench › Canvas: an interactive preview of a page from this conversation's folders (broker/canvas.ts). It runs
// in PAL's isolated preview browser with no network; click the frame to interact, or switch to Annotate to pin a
// note to an element. The same preview is available from an owner phone.
Item {
    id: canvas
    objectName: "canvasPane"
    implicitHeight: content.implicitHeight
    readonly property bool narrow: width < Theme.wideToolbar
    property string sessionId: ""
    property var roots: []
    property var status: ({})
    property var preview: null
    property string frame: ""
    property var consoleLines: []
    property var notes: []
    property bool annotating: false
    property string error: ""
    property real pendingX: 0
    property real pendingY: 0
    RpcClient { id: rpc; scope: canvas.sessionId }
    function refreshRoots() { rpc.call("workspace.roots", { sessionId: sessionId }, value => { if (!value.error) { canvas.roots = value.roots || []; if (rootBox.currentIndex < 0 && canvas.roots.length) rootBox.currentIndex = 0; canvas.openRequested() } }) }
    // A page chosen in another pane (a file preview): shown here as soon as its folder is known.
    function openRequested() {
        if (!roots.length) return
        const target = WorkbenchState.takeCanvasTarget(sessionId)
        if (!target) return
        const index = roots.findIndex(root => root.id === target.rootId)
        if (index < 0) { error = "That page’s folder is no longer part of this conversation."; return }
        rootBox.currentIndex = index; pagePath.text = target.path
        rpc.call("canvas.open", { sessionId: sessionId, rootId: target.rootId, path: target.path }, value => { if (value.error) canvas.error = value.error; else { canvas.error = ""; canvas.preview = value; canvas.refreshFrame() } })
    }
    Connections { target: WorkbenchState; function onCanvasTargetChanged() { if (WorkbenchState.canvasTarget?.sessionId === canvas.sessionId) canvas.refreshRoots() } }
    function chooseFolder(){const path=App.chooseFolder();if(!path)return;rpc.call("workspace.addRoot",{sessionId:sessionId,path:path,policy:{write:false,organize:false,hidden:false,execute:false,destinations:{remote:false,cloud:false}}},value=>{if(value.error)canvas.error=value.error;else{canvas.error="";canvas.refreshRoots()}})}
    function choosePage(){
        const path=App.chooseFile();if(!path)return
        if(!/\.(?:html?|svg)$/i.test(path)){canvas.error="Choose an HTML or SVG page (.html, .htm or .svg).";return}
        const index=canvas.roots.findIndex(root=>path===root.path||path.indexOf(root.path+"/")===0)
        if(index<0){canvas.error="Choose a page inside one of this conversation’s folders.";return}
        rootBox.currentIndex=index;pagePath.text=path.slice(canvas.roots[index].path.length).replace(/^\//,"");canvas.error=""
    }
    function openNote(x,y){canvas.pendingX=Math.max(0,Math.min(1,x));canvas.pendingY=Math.max(0,Math.min(1,y));noteDialog.open()}
    function load() {
        rpc.call("canvas.status", {}, value => { if (!value.error) canvas.status = value })
        rpc.call("canvas.list", { sessionId: sessionId }, value => { if (!value.error && value.length && !canvas.preview) canvas.preview = value[0]; refreshFrame() })
        refreshRoots()
    }
    function refreshFrame() {
        if (!preview) return
        rpc.call("canvas.frame", { sessionId: sessionId, id: preview.id }, value => { if (value.error) { canvas.error = value.error; if (/closed/.test(value.error)) canvas.preview = null } else canvas.frame = value.data })
        rpc.call("canvas.console", { sessionId: sessionId, id: preview.id }, value => { if (!value.error) canvas.consoleLines = value.slice(-30) })
        rpc.call("canvas.annotations", { sessionId: sessionId, id: preview.id }, value => { if (!value.error) canvas.notes = value })
    }
    function viewport(width, height, mobile) { if (preview) rpc.call("canvas.resize", { sessionId: sessionId, id: preview.id, width: width, height: height, mobile: mobile }, () => canvas.refreshFrame()) }
    Timer { interval: 1200; repeat: true; running: canvas.visible && !!canvas.preview; onTriggered: canvas.refreshFrame() }
    onSessionIdChanged: { preview = null; frame = ""; load() }
    Component.onCompleted: load()
    ColumnLayout {
        id: content
        anchors.fill: parent; spacing: Theme.space2
        CText { visible: canvas.status.available === false; text: canvas.status.unavailableReason || ""; color: Theme.amber; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
        GridLayout {
            Layout.fillWidth: true; columns: canvas.narrow ? 2 : 4; columnSpacing: Theme.space2; rowSpacing: Theme.space1
            CComboBox { id: rootBox; Layout.preferredWidth: canvas.narrow ? 0 : Theme.fieldWidth; Layout.fillWidth: canvas.narrow; Layout.minimumWidth: 0; model: canvas.roots.map(r => r.name); Accessible.name: "Folder" }
            CField { id: pagePath; objectName: "canvasPath"; Layout.fillWidth: true; Layout.preferredWidth: canvas.narrow ? 0 : implicitWidth; placeholderText: "index.html or drawing.svg"; text: "index.html"; Accessible.name: "HTML or SVG page to preview" }
            CButton { objectName:"canvasChoosePage";visible:canvas.roots.length>0;Layout.fillWidth:canvas.narrow;Layout.preferredWidth:canvas.narrow?0:implicitWidth;text:"Choose page…";Accessible.name:"Choose an HTML or SVG page from this conversation’s folders";onClicked:canvas.choosePage() }
            CButton { objectName: "canvasOpen"; Layout.fillWidth: canvas.narrow; Layout.columnSpan: canvas.narrow && canvas.roots.length === 0 ? 2 : 1; Layout.preferredWidth: canvas.narrow ? 0 : implicitWidth; text: canvas.preview ? "Open another" : "Preview"; primary: true; enabled: canvas.status.available === true && rootBox.currentIndex >= 0
                onClicked: rpc.call("canvas.open", { sessionId: canvas.sessionId, rootId: canvas.roots[rootBox.currentIndex].id, path: pagePath.text.trim() }, value => { if (value.error) canvas.error = value.error; else { canvas.error = ""; canvas.preview = value; canvas.refreshFrame() } }) }
        }
        GridLayout { visible:canvas.roots.length===0;Layout.fillWidth:true;columns:canvas.narrow?1:2;columnSpacing:Theme.space2;rowSpacing:Theme.space1
            CText { Layout.fillWidth:true;text:"Choose a conversation folder before previewing a page.";color:Theme.amber;font.pixelSize:Theme.caption;wrapMode:Text.Wrap }
            CButton { objectName:"canvasChooseFolder";Layout.fillWidth:canvas.narrow;text:"Choose a conversation folder…";primary:true;onClicked:canvas.chooseFolder() }
        }
        Flow {
            visible: !!canvas.preview; Layout.fillWidth: true; spacing: Theme.space1
            CButton { text: "Desktop"; implicitHeight: Theme.compactHeight; onClicked: canvas.viewport(1280, 800, false) }
            CButton { text: "Tablet"; implicitHeight: Theme.compactHeight; onClicked: canvas.viewport(820, 1180, true) }
            CButton { text: "Phone"; implicitHeight: Theme.compactHeight; onClicked: canvas.viewport(390, 844, true) }
            CButton { text: "Reload"; implicitHeight: Theme.compactHeight; help: "Takes a new snapshot of the folder"; onClicked: rpc.call("canvas.reload", { sessionId: canvas.sessionId, id: canvas.preview.id }, value => { if (!value.error) { canvas.preview = value; canvas.refreshFrame() } }) }
            CButton { objectName: "canvasAnnotate"; width: Math.min(implicitWidth, parent.width); text: canvas.annotating ? "Annotating · click an element" : "Annotate"; primary: canvas.annotating; implicitHeight: Theme.compactHeight; onClicked: canvas.annotating = !canvas.annotating }
            CButton { visible:canvas.annotating;width:Math.min(implicitWidth,parent.width);text:"Pin center…";implicitHeight:Theme.compactHeight;help:"Keyboard alternative: start a note at the center, then adjust its horizontal and vertical position";onClicked:canvas.openNote(0.5,0.5) }
            CButton { text: "Screenshot"; implicitHeight: Theme.compactHeight; onClicked: rpc.call("canvas.screenshot", { sessionId: canvas.sessionId, id: canvas.preview.id }, value => { canvas.error = value.error || "" }) }
            CButton { text: "Export source"; implicitHeight: Theme.compactHeight; onClicked: rpc.call("canvas.export", { sessionId: canvas.sessionId, id: canvas.preview.id }, value => { canvas.error = value.error || "" }) }
            CButton { text: "Close"; implicitHeight: Theme.compactHeight; onClicked: rpc.call("canvas.close", { sessionId: canvas.sessionId, id: canvas.preview.id }, () => { canvas.preview = null; canvas.frame = "" }) }
        }
        CText { visible: !!canvas.preview; text: canvas.preview ? canvas.preview.path + " · snapshot " + canvas.preview.revision + " · " + canvas.preview.width + "×" + canvas.preview.height + " · no network" : ""; color: Theme.muted; font.pixelSize: Theme.caption }
        CText { visible: !!canvas.error; text: canvas.error; color: Theme.danger; font.pixelSize: Theme.caption; wrapMode: Text.Wrap; Layout.fillWidth: true }
        Rectangle {
            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: Theme.editorShort; color: Theme.codeSurface; border.color: Theme.subtle; clip: true
            Image {
                id: frameImage; anchors.fill: parent; anchors.margins: Theme.space1; fillMode: Image.PreserveAspectFit; source: canvas.frame; cache: false; asynchronous: false
                Accessible.name: "Preview of " + (canvas.preview ? canvas.preview.path : "")
                MouseArea {
                    // The frame's painted area, so clicks map to page coordinates exactly.
                    x: (parent.width - parent.paintedWidth) / 2; y: (parent.height - parent.paintedHeight) / 2; width: parent.paintedWidth; height: parent.paintedHeight
                    onClicked: mouse => {
                        const px = mouse.x / width, py = mouse.y / height
                        if (canvas.annotating) { canvas.openNote(px,py); return }
                        rpc.call("canvas.input", { sessionId: canvas.sessionId, id: canvas.preview.id, kind: "click", x: px, y: py }, () => canvas.refreshFrame())
                    }
                    onWheel: wheel => rpc.call("canvas.input", { sessionId: canvas.sessionId, id: canvas.preview.id, kind: "scroll", x: wheel.x / width, y: wheel.y / height, deltaY: -wheel.angleDelta.y * 2 }, () => canvas.refreshFrame())
                }
            }
            CText { anchors.centerIn: parent; width: Math.max(0, parent.width - Theme.space4); visible: !canvas.preview; text: "Preview a page from this conversation’s folders."; color: Theme.muted; horizontalAlignment: Text.AlignHCenter }
        }
        RowLayout {
            visible: !!canvas.preview; Layout.fillWidth: true
            CField { id: typing; Layout.fillWidth: true; placeholderText: "Type into the focused field of the page"; Accessible.name: "Text to type into the preview" }
            CButton { text: "Type"; onClicked: { rpc.call("canvas.input", { sessionId: canvas.sessionId, id: canvas.preview.id, kind: "type", text: typing.text }, () => canvas.refreshFrame()); typing.text = "" } }
            CButton { text: "Enter"; onClicked: rpc.call("canvas.input", { sessionId: canvas.sessionId, id: canvas.preview.id, kind: "key", key: "Enter" }, () => canvas.refreshFrame()) }
        }
        CText { visible:canvas.notes.length>0;text:"Saved notes · "+canvas.notes.length;font.weight:Font.DemiBold;font.pixelSize:Theme.caption }
        ListView { visible:canvas.notes.length>0;Layout.fillWidth:true;Layout.preferredHeight:Math.min(Theme.detailHeight,contentHeight);clip:true;spacing:Theme.space1;model:canvas.notes
            delegate:GridLayout { required property var modelData;width:ListView.view.width;columns:canvas.narrow?1:2;columnSpacing:Theme.space1;rowSpacing:Theme.space1
                CText { Layout.fillWidth: true; elide: Text.ElideRight; font.pixelSize: Theme.caption; color: modelData.current ? Theme.text : Theme.muted; text: (modelData.current ? "" : "(earlier snapshot) ") + modelData.selector + " at " + Math.round(modelData.box.x) + ", " + Math.round(modelData.box.y) + ": " + modelData.note }
                CButton { Layout.fillWidth:canvas.narrow;text: "Copy for the chat"; implicitHeight: Theme.compactHeight; onClicked: App.copy("In " + canvas.preview.path + ", the element " + modelData.selector + " (\"" + modelData.text.slice(0, 80) + "\"): " + modelData.note) }
            }
        }
        CText { visible: canvas.consoleLines.length > 0; Layout.fillWidth: true; wrapMode: Text.Wrap; font.family: Theme.mono; font.pixelSize: Theme.caption; color: Theme.muted
            text: canvas.consoleLines.slice(-6).map(m => m.level + ": " + m.text).join("\n") }
    }
    CDialog {
        id: noteDialog
        onOpened:{horizontal.value=Math.round(canvas.pendingX*100);vertical.value=Math.round(canvas.pendingY*100);note.forceActiveFocus()}
        CText { text: "Note for this element"; font.pixelSize: Theme.section; font.weight: Font.DemiBold }
        GridLayout { Layout.fillWidth:true;columns:width<Theme.compactPane?2:4;columnSpacing:Theme.space2;rowSpacing:Theme.space1
            CText { text:"Horizontal";color:Theme.muted;font.pixelSize:Theme.caption }
            CSpinBox { id:horizontal;Layout.fillWidth:true;Layout.minimumWidth:0;from:0;to:100;value:50;Accessible.name:"Horizontal pin position in percent";onValueModified:canvas.pendingX=value/100 }
            CText { text:"Vertical";color:Theme.muted;font.pixelSize:Theme.caption }
            CSpinBox { id:vertical;Layout.fillWidth:true;Layout.minimumWidth:0;from:0;to:100;value:50;Accessible.name:"Vertical pin position in percent";onValueModified:canvas.pendingY=value/100 }
        }
        CField { id: note; Layout.fillWidth: true; placeholderText: "What should change here?"; Accessible.name: "Annotation note" }
        RowLayout {
            CButton { text: "Pin note"; primary: true; onClicked: { rpc.call("canvas.annotate", { sessionId: canvas.sessionId, id: canvas.preview.id, x: canvas.pendingX, y: canvas.pendingY, note: note.text }, value => { canvas.error = value.error || ""; canvas.refreshFrame() }); note.text = ""; noteDialog.close() } }
            CButton { text: "Cancel"; onClicked: noteDialog.close() }
        }
    }
}
