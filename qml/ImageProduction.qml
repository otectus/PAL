pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts

CDialog {
    id: studio
    objectName: "imageProduction"
    property string sessionId: ""
    property var items: []
    property var kits: []
    property var sets: []
    property var activeSet: null
    property var activeKitGuides: []
    property var members: []
    property var previews: []
    property var connections: []
    property string message: ""
    property bool working: false
    property int contextRevision: 0
    property int previewRevision: 0
    property var pendingIndexes: []
    property bool regenerate: false
    property string batchConnection: ""
    property bool acknowledged: false
    property string mode: modeBox.currentText
    readonly property var chosenConnection: connections[connectionBox.currentIndex]
    signal completed(string message)
    RpcClient {
        id: rpc
        scope: studio.sessionId + "|" + studio.contextRevision
    }
    function openFor(refs) {
        contextRevision++;
        items = refs || [];
        activeKitGuides = items.slice(0, 8);
        activeSet = null;
        members = [];
        previews = [];
        working = false;
        pendingIndexes = [];
        message = "";
        nameField.text = "";
        palette.text = "";
        typography.text = "";
        styleField.text = "";
        briefs.text = "";
        prefix.text = "";
        modeBox.currentIndex = items.length ? 0 : 1;
        refreshLibrary();
        rpc.call("images.connections", {}, v => {
            if (!v.error)
                connections = v.connections || [];
        });
        open();
    }
    function refreshLibrary() {
        rpc.call("images.kits", {
            sessionId: sessionId
        }, v => {
            if (v.error) {
                message = v.error;
                return;
            }
            kits = v.kits;
            sets = v.sets;
        });
    }
    function useKit(kit) {
        styleField.text = kit.style;
        palette.text = kit.palette.join(" ");
        typography.text = kit.typography;
        nameField.text = kit.name;
        activeKitGuides = kit.guides;
    }
    function loadKit(index) {
        if (index <= 0)
            return;
        rpc.call("images.openSet", Object.assign({
            sessionId: sessionId
        }, kits[index - 1]), v => {
            if (v.error)
                message = v.error;
            else
                useKit(v.kit);
        });
    }
    function spec() {
        return {
            name: nameField.text.trim(),
            style: styleField.text.trim(),
            palette: palette.text.trim().split(/[ ,]+/).filter(Boolean),
            typography: typography.text.trim(),
            guides: activeKitGuides
        };
    }
    function save(asSet) {
        const params = asSet ? {
            name: nameField.text,
            kit: spec(),
            briefs: briefs.text.split("\n").map(s => s.trim()).filter(Boolean)
        } : Object.assign(spec(), {
            shared: share.checked
        });
        working = true;
        rpc.call(asSet ? "images.saveSet" : "images.saveKit", Object.assign({
            sessionId: sessionId
        }, params), v => {
            working = false;
            if (v.error) {
                message = v.error;
                return;
            }
            message = asSet ? "Set saved. Choose a connection to generate members." : "Style kit saved.";
            refreshLibrary();
            if (asSet)
                openSet(v);
        });
    }
    function openSet(ref) {
        activeSet = ref;
        members = [];
        loadMembers(true);
    }
    function loadMembers(loadForm) {
        if (!activeSet)
            return;
        const id = activeSet.versionId;
        rpc.call("images.openSet", Object.assign({
            sessionId: sessionId
        }, activeSet), v => {
            if (activeSet?.versionId !== id)
                return;
            if (v.error) {
                message = v.error;
                return;
            }
            members = v.members;
            if (loadForm) {
                useKit(v.spec.kit);
                nameField.text = v.spec.name;
                briefs.text = v.spec.briefs.join("\n");
            }
        });
    }
    function planBatch(indexes, replacing) {
        if (!indexes.length || !activeSet || !chosenConnection)
            return;
        pendingIndexes = indexes.slice();
        regenerate = replacing;
        batchConnection = chosenConnection.id;
        acknowledged = false;
        working = true;
        rpc.call("images.previewMember", Object.assign({
            sessionId: sessionId,
            index: indexes[0],
            connectionId: batchConnection
        }, activeSet), v => {
            if (v.error) {
                working = false;
                message = v.error;
                return;
            }
            batchInfo.text = [indexes.length + " image" + (indexes.length === 1 ? "" : "s") + " · " + chosenConnection.name, "Processes on " + v.capabilities.processes, v.request.references.length + " style reference" + (v.request.references.length === 1 ? "" : "s"), v.estimate ? "Configured estimate: " + v.estimate.currency + " " + Number(v.estimate.perImage * indexes.length).toFixed(2) : v.capabilities.billed ? "Provider billing applies. The exact charge is determined by your provider." : "This connection reports no provider billing."].join("\n");
            batchDialog.open();
        });
    }
    function submitNext() {
        rpc.call("images.renderSet", Object.assign({
            sessionId: sessionId,
            indexes: pendingIndexes,
            connectionId: batchConnection,
            regenerate: regenerate,
            acknowledgeBilling: acknowledged
        }, activeSet), v => {
            working = false;
            message = v.error || ((v.submitted || []).length + " member requests processed." + (v.reason ? " " + v.reason : ""));
            pendingIndexes = [];
            loadMembers(false);
        });
    }
    function approve(index, ref) {
        rpc.call("images.approveMember", Object.assign({
            sessionId: sessionId,
            index: index,
            chosen: ref
        }, activeSet), v => {
            if (v.error)
                message = v.error;
            else {
                message = "Approved this version.";
                loadMembers(false);
            }
        });
    }
    function options() {
        return {
            sessionId: sessionId,
            items: items,
            preset: ["icons", "documentation", "slides"][preset.currentIndex],
            fit: fit.currentIndex ? "cover" : "contain",
            sheet: sheet.checked,
            manifest: manifest.checked,
            originals: originals.checked,
            prefix: prefix.text.trim()
        };
    }
    function invalidate() {
        previewRevision++;
        previews = [];
    }
    function renderPreview() {
        const revision = ++previewRevision;
        working = true;
        rpc.call("images.deliveryPreview", options(), v => {
            working = false;
            if (revision !== previewRevision)
                return;
            if (v.error)
                message = v.error;
            else {
                previews = v.outputs;
                message = "";
            }
        });
    }
    function exportKit() {
        working = true;
        rpc.call("images.deliver", options(), v => {
            working = false;
            if (v.error) {
                message = v.error;
                return;
            }
            const path = App.chooseSavePath(v.name);
            if (!path) {
                message = "Bundle kept in conversation files.";
                completed(message);
                return;
            }
            rpc.call("artifacts.saveAs", {
                sessionId: sessionId,
                artifactId: v.artifactId,
                versionId: v.versionId,
                path: path,
                replace: true
            }, saved => {
                message = saved.error || "Saved " + v.outputs.length + " images to " + saved.path;
                completed(message);
            });
        });
    }
    onSessionIdChanged: if (opened)
        close()
    onClosed: {
        contextRevision++;
        working = false;
        pendingIndexes = [];
    }
    Timer {
        interval: 1800
        repeat: true
        running: studio.opened && !!studio.activeSet && studio.members.some(m => m.operation && ["prepared", "queued", "dispatching", "running", "cancel_requested"].indexOf(m.operation.state) >= 0)
        onTriggered: if (!rpc.busy)
            studio.loadMembers(false)
    }
    CText {
        text: "Image production"
        font.pixelSize: Theme.title
        font.bold: true
    }
    CComboBox {
        id: modeBox
        objectName: "imageProductionMode"
        Layout.fillWidth: true
        model: ["Export sizes", "Style kits", "Image sets"]
        Accessible.name: "Production task"
        enabled: !studio.working
    }
    ColumnLayout {
        visible: studio.mode === "Export sizes"
        Layout.fillWidth: true
        CText {
            text: studio.items.length ? studio.items.length + " selected version" + (studio.items.length === 1 ? "" : "s") : "Select images in the gallery or approve members of a set to export."
            color: Theme.muted
        }
        CComboBox {
            id: preset
            Layout.fillWidth: true
            model: ["App icons · 32, 128, 512", "Documentation · 640×360, 1280×720", "Slides · 1280×720, 1920×1080"]
            Accessible.name: "Export preset"
            onActivated: studio.invalidate()
        }
        CComboBox {
            id: fit
            Layout.fillWidth: true
            model: ["Fit with transparent padding", "Fill with a centered crop"]
            Accessible.name: "Crop"
            onActivated: studio.invalidate()
        }
        CField {
            id: prefix
            Layout.fillWidth: true
            placeholderText: "File name prefix (optional)"
            Accessible.name: "File name prefix"
            onTextChanged: studio.invalidate()
        }
        CCheckBox {
            id: sheet
            checked: true
            text: "Include contact sheet"
        }
        CCheckBox {
            id: manifest
            checked: true
            text: "Include recipe manifest"
        }
        CCheckBox {
            id: originals
            text: "Include original files with embedded credentials"
        }
        CButton {
            objectName: "imageKitPreview"
            text: "Preview sizes"
            enabled: studio.items.length > 0 && !studio.working
            onClicked: studio.renderPreview()
        }
        Repeater {
            model: studio.previews
            RowLayout {
                required property var modelData
                Layout.fillWidth: true
                Image {
                    Layout.preferredWidth: Theme.fieldShort
                    Layout.preferredHeight: Theme.controlHeight * 2
                    source: parent.modelData.thumbnail
                    fillMode: Image.PreserveAspectFit
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    CText {
                        text: parent.parent.modelData.name
                        wrapMode: Text.WrapAnywhere
                    }
                    CText {
                        text: parent.parent.modelData.width + "×" + parent.parent.modelData.height + (parent.parent.modelData.warnings.length ? " · " + parent.parent.modelData.warnings.join(", ") : "")
                        color: Theme.muted
                    }
                    CButton {
                        text: "Inspect at 100%"
                        quiet: true
                        onClicked: {
                            const row = parent.parent.modelData;
                            rpc.call("images.deliverySample", Object.assign(studio.options(), {
                                items: [row.source],
                                width: row.width,
                                height: row.height
                            }), v => {
                                if (v.error)
                                    studio.message = v.error;
                                else {
                                    samplePicture.source = v.image;
                                    sampleTitle.text = row.name;
                                    sampleDialog.open();
                                }
                            });
                        }
                    }
                }
            }
        }
        CButton {
            objectName: "imageKitExport"
            text: "Export ZIP…"
            primary: true
            enabled: studio.previews.length > 0 && !studio.working
            onClicked: studio.exportKit()
        }
    }
    ColumnLayout {
        visible: studio.mode !== "Export sizes"
        Layout.fillWidth: true
        CComboBox {
            visible: studio.mode === "Image sets"
            Layout.fillWidth: true
            model: ["New image set"].concat(studio.sets.map(s => s.name))
            Accessible.name: "Saved image set"
            enabled: !studio.working
            onActivated: index => {
                if (index)
                    studio.openSet(studio.sets[index - 1]);
                else {
                    studio.activeSet = null;
                    studio.members = [];
                    briefs.text = "";
                }
            }
        }
        CComboBox {
            Layout.fillWidth: true
            model: ["Choose saved style kit…"].concat(studio.kits.map(s => s.name))
            Accessible.name: "Saved style kit"
            onActivated: index => studio.loadKit(index)
        }
        CField {
            id: nameField
            Layout.fillWidth: true
            placeholderText: "Name"
            Accessible.name: "Kit or set name"
        }
        CTextArea {
            id: styleField
            Layout.fillWidth: true
            placeholderText: "Describe the shared style"
            Accessible.name: "Style guidance"
        }
        CField {
            id: palette
            Layout.fillWidth: true
            placeholderText: "Palette, e.g. #132332 #eab861"
            Accessible.name: "Hex colors"
        }
        CField {
            id: typography
            Layout.fillWidth: true
            placeholderText: "Typography (optional)"
            Accessible.name: "Typography"
        }
        CText {
            text: studio.activeKitGuides.length + " style references"
            color: Theme.muted
        }
        Repeater {
            model: studio.activeKitGuides
            RowLayout {
                required property var modelData
                property var guide: modelData
                Image {
                    Layout.preferredWidth: Theme.controlHeight
                    Layout.preferredHeight: Theme.controlHeight
                    fillMode: Image.PreserveAspectFit
                    property var identity: parent.guide
                    onIdentityChanged: {
                        if (identity)
                            rpc.call("artifacts.thumbnail", {
                                sessionId: studio.sessionId,
                                artifactId: identity.artifactId,
                                versionId: identity.versionId
                            }, v => source = v.data || "");
                    }
                }
                CText {
                    text: parent.guide.name || ("Version " + parent.guide.versionId.slice(0, 8))
                    wrapMode: Text.WrapAnywhere
                }
            }
        }
        CButton {
            text: "Use gallery selection as guides"
            visible: studio.items.length > 0
            quiet: true
            onClicked: studio.activeKitGuides = studio.items.slice(0, 8)
        }
        CCheckBox {
            id: share
            visible: studio.mode === "Style kits"
            text: "Share kit with this project"
        }
        CButton {
            text: "Save style kit"
            visible: studio.mode === "Style kits"
            enabled: !!nameField.text.trim() && !studio.working
            onClicked: studio.save(false)
        }
        CTextArea {
            id: briefs
            visible: studio.mode === "Image sets"
            Layout.fillWidth: true
            placeholderText: "One image brief per line"
            Accessible.name: "Set member briefs"
        }
        CButton {
            text: studio.activeSet ? "Save as new set" : "Save set"
            visible: studio.mode === "Image sets"
            enabled: !!briefs.text.trim() && !!nameField.text.trim() && !studio.working
            onClicked: studio.save(true)
        }
    }
    ColumnLayout {
        visible: studio.mode === "Image sets" && !!studio.activeSet
        Layout.fillWidth: true
        CComboBox {
            id: connectionBox
            Layout.fillWidth: true
            model: studio.connections.map(c => c.name)
            Accessible.name: "Set generation connection"
            enabled: !studio.working
        }
        CText {
            visible: !studio.chosenConnection
            text: "Set up an image connection to generate members."
            color: Theme.muted
        }
        CButton {
            text: "Generate remaining members…"
            primary: true
            enabled: !!studio.chosenConnection && !studio.working && studio.members.some(m => !m.approved && !m.operation)
            onClicked: studio.planBatch(studio.members.filter(m => !m.approved && !m.operation).map(m => m.index), false)
        }
        Repeater {
            model: studio.members
            ColumnLayout {
                id: member
                required property var modelData
                Layout.fillWidth: true
                CText {
                    text: (member.modelData.index + 1) + ". " + member.modelData.brief
                }
                CText {
                    color: Theme.muted
                    text: [member.modelData.approved ? "Approved " + member.modelData.approved.versionId.slice(0, 8) : "", member.modelData.operation?.state || "", member.modelData.operation?.error || ""].filter(Boolean).join(" · ")
                }
                Repeater {
                    model: member.modelData.operation?.images || []
                    RowLayout {
                        id: resultRow
                        required property var modelData
                        Image {
                            Layout.preferredWidth: Theme.fieldShort
                            Layout.preferredHeight: Theme.controlHeight * 2
                            fillMode: Image.PreserveAspectFit
                            property string resultId: resultRow.modelData.versionId
                            onResultIdChanged: rpc.call("artifacts.thumbnail", Object.assign({
                                sessionId: studio.sessionId
                            }, resultRow.modelData), v => source = v.data || "")
                        }
                        CButton {
                            text: "Approve"
                            onClicked: studio.approve(member.modelData.index, resultRow.modelData)
                        }
                    }
                }
                CButton {
                    text: member.modelData.operation ? "Regenerate this member…" : "Generate member…"
                    quiet: true
                    enabled: !!studio.chosenConnection && !studio.working
                    onClicked: studio.planBatch([member.modelData.index], true)
                }
            }
        }
        CButton {
            text: "Export approved images…"
            enabled: studio.members.some(m => !!m.approved)
            onClicked: {
                studio.items = studio.members.filter(m => !!m.approved).map(m => m.approved);
                studio.invalidate();
                modeBox.currentIndex = 0;
            }
        }
    }
    CText {
        visible: !!studio.message
        text: studio.message
        color: Theme.muted
        Accessible.role: Accessible.AlertMessage
    }
    CButton {
        text: "Close"
        quiet: true
        onClicked: studio.close()
    }
    CDialog {
        id: batchDialog
        CText {
            text: "Review generation"
            font.pixelSize: Theme.title
        }
        CText {
            id: batchInfo
        }
        CButton {
            text: "Generate"
            primary: true
            onClicked: {
                studio.acknowledged = true;
                batchDialog.close();
                studio.submitNext();
            }
        }
        CButton {
            text: "Cancel"
            onClicked: batchDialog.close()
        }
        onClosed: if (!studio.acknowledged)
            studio.working = false
    }
    CDialog {
        id: sampleDialog
        CText {
            id: sampleTitle
        }
        Flickable {
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(400, samplePicture.implicitHeight)
            clip: true
            contentWidth: samplePicture.implicitWidth
            contentHeight: samplePicture.implicitHeight
            Image {
                id: samplePicture
            }
        }
        CButton {
            text: "Close"
            onClicked: sampleDialog.close()
        }
    }
}
