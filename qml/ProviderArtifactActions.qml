pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CButton {
    id: action
    objectName: "providerArtifactActions"
    property var app: typeof App !== "undefined" ? App : null
    property string sessionId: ""
    property var artifact: null
    property var version: null
    signal refreshed()
    signal originalSelected(var file)
    text: qsTr("Provider actions…")
    enabled: !!sessionId && !!artifact && !!version
    onClicked: dialog.review()
    onSessionIdChanged: dialog.close()
    onArtifactChanged: if (dialog.opened && artifact?.versionId !== dialog.source?.versionId) dialog.close()
    RpcClient { id: rpc; endpoint: action.app; scope: action.sessionId + "/" + (action.artifact?.versionId || "") }

    CDialog {
        id: dialog
        objectName: "providerArtifactDialog"
        accessibleTitle: qsTr("Provider file actions")
        property var source: null
        property var context: null
        property var handles: []
        property string message: ""
        property string confirmRemoval: ""
        property bool working: false
        property bool loadingHandles: false
        property int epoch: 0
        readonly property bool pdf: action.version?.mime === "application/pdf"
        readonly property var accounts: context?.accounts || []
        readonly property var account: accounts[accountBox.currentIndex]
        readonly property bool ocr: account?.kind === "mistral"
        readonly property bool binaryInput: ["image-classification","object-detection","image-segmentation","audio-classification","automatic-speech-recognition","image-to-image"].includes(taskBox.currentText)
        readonly property string destination: context?.connectionName || (action.app?.state?.providerTraits || {})[context?.provider || ""]?.label || context?.provider || ""
        function request(method, params, done) {
            const reviewed = epoch
            rpc.call(method, params, result => { if (epoch === reviewed) done(result) })
        }
        function loadHandles() {
            loadingHandles = true
            request("originalFiles.list", {sessionId: action.sessionId}, rows => {
                loadingHandles = false
                if (rows.error) { message = rows.error; return }
                handles = rows.filter(row => row.versionId === source.versionId && row.state !== "deleted")
            })
        }
        function review() {
            epoch++; source = action.artifact; context = null; handles = []; message = ""; working = false; loadingHandles = false
            confirmRemoval = ""; accountBox.currentIndex = 0; taskBox.currentIndex = 0; uploadConsent.checked = false
            processConsent.checked = false; input.text = ""; parameters.text = ""; model.text = ""; pages.text = ""
            open()
            request("providerInference.context", {sessionId: action.sessionId}, value => {
                if (value.error) { message = value.error; return }
                context = value; if (pdf) loadHandles()
            })
        }
        function upload() {
            working = true
            request("originalFiles.upload", {sessionId: action.sessionId, artifactId: source.artifactId, versionId: source.versionId,
                expectedSessionRevision: context.sessionRevision, expectedConnectionRevision: context.connectionRevision, acknowledgeUpload: true}, value => {
                working = false; uploadConsent.checked = false
                message = value.error || qsTr("Uploaded. Choose “Attach to next message” to use this PDF.")
                loadHandles()
            })
        }
        function removeFile(id) {
            if (confirmRemoval !== id) { confirmRemoval = id; return }
            working = true
            request("originalFiles.remove", {sessionId: action.sessionId, id: id}, value => {
                working = false; confirmRemoval = ""; message = value.error || qsTr("Provider copy removed."); loadHandles()
            })
        }
        function processInput() {
            const ref = {artifactId: source.artifactId, versionId: source.versionId}
            const p = {sessionId: action.sessionId, expectedSessionRevision: context.sessionRevision, expectedProjectRevision: context.projectRevision,
                       connectionId: account.id, connectionRevision: account.revision}
            if (model.text.trim()) p.model = model.text.trim()
            try {
                if (ocr) {
                    p.source = ref
                    if (pages.text.trim()) p.pages = pages.text.trim()
                } else {
                    p.task = taskBox.currentText
                    const txt = input.text.trim()
                    p.inputs = binaryInput ? {kind: "artifacts", items: [ref]} : {kind: "text", value: /^[\[{]/.test(txt) ? JSON.parse(txt) : txt}
                    if (parameters.text.trim()) p.parameters = JSON.parse(parameters.text)
                    if (p.task === "feature-extraction") { p.pooling = pooling.currentText; p.normalize = normalize.checked }
                }
            } catch (e) { message = qsTr("Check the input JSON: ") + e; return }
            working = true; message = ""
            request(ocr ? "providerInference.mistralOcr" : "providerInference.run", p, value => {
                working = false; processConsent.checked = false
                message = value.error || qsTr("Result saved to the conversation Library.")
                if (!value.error) action.refreshed()
            })
        }
        CText { text: dialog.source?.name || ""; font.weight: Font.DemiBold; Accessible.role: Accessible.Heading }
        CText { visible: !dialog.context && !dialog.message; text: qsTr("Loading account settings…") }
        CText {
            visible: !!dialog.context?.originalPdf && dialog.pdf
            text: qsTr("Original PDF for %1").arg(dialog.destination)
            font.weight: Font.DemiBold
        }
        ColumnLayout {
            Layout.fillWidth: true
            visible: !!dialog.context?.originalPdf && dialog.pdf
            CCheckBox { id: uploadConsent; objectName: "originalUploadConsent"; text: qsTr("Allow uploading this PDF to %1").arg(dialog.destination) }
            CButton { objectName: "originalUpload"; text: qsTr("Upload original PDF"); enabled: uploadConsent.checked && !dialog.working && !dialog.loadingHandles; onClicked: dialog.upload() }
        }
        Repeater {
            objectName: "providerFileHandles"
            model: dialog.handles
            ColumnLayout {
                id: handleRow
                required property var modelData
                Layout.fillWidth: true
                CText { text: (handleRow.modelData.name || "") + " · " + handleRow.modelData.provider + " · " + handleRow.modelData.state }
                Flow {
                    Layout.fillWidth: true; spacing: Theme.space1
                    CButton {
                        objectName: "originalAttach_" + handleRow.modelData.id
                        text: qsTr("Attach to next message")
                        enabled: !dialog.working && handleRow.modelData.state === "ready" && (!handleRow.modelData.expires || handleRow.modelData.expires > Date.now()) &&
                            handleRow.modelData.provider === dialog.context?.provider && (handleRow.modelData.connectionId || "") === (dialog.context?.connectionId || "") && handleRow.modelData.revision === dialog.context?.connectionRevision
                        onClicked: { action.originalSelected({id: handleRow.modelData.id, name: handleRow.modelData.name}); dialog.close() }
                    }
                    CButton { text: dialog.confirmRemoval === handleRow.modelData.id ? qsTr("Confirm removal") : qsTr("Remove provider copy"); enabled: !dialog.working; onClicked: dialog.removeFile(handleRow.modelData.id) }
                }
            }
        }
        CText { visible: !!dialog.context; text: dialog.accounts.length ? qsTr("Process with a saved account") : qsTr("Add a Mistral or Hugging Face account in Settings to run OCR or inference."); font.weight: Font.DemiBold }
        ColumnLayout {
            visible: dialog.accounts.length > 0
            Layout.fillWidth: true
            CComboBox { id: accountBox; objectName: "inferenceAccount"; Layout.fillWidth: true; model: dialog.accounts; textRole: "name"; Accessible.name: qsTr("Processing account"); onActivated: { processConsent.checked = false; model.text = "" } }
            CComboBox { id: taskBox; visible: !dialog.ocr; Layout.fillWidth: true; model: dialog.context?.tasks || []; Accessible.name: qsTr("Hugging Face task"); onActivated: processConsent.checked = false }
            CField { id: model; Layout.fillWidth: true; placeholderText: dialog.ocr ? qsTr("OCR model (optional)") : qsTr("Hugging Face model ID"); Accessible.name: placeholderText }
            CField { id: pages; visible: dialog.ocr; Layout.fillWidth: true; placeholderText: qsTr("Pages (optional, e.g. 1-3)"); Accessible.name: placeholderText }
            CTextArea { id: input; visible: !dialog.ocr && !dialog.binaryInput; Layout.fillWidth: true; placeholderText: qsTr("Text input or a JSON object for this task"); Accessible.name: placeholderText }
            CField { id: parameters; visible: !dialog.ocr; Layout.fillWidth: true; placeholderText: qsTr("Task parameters as JSON (optional)"); Accessible.name: placeholderText }
            CComboBox { id: pooling; visible: !dialog.ocr && taskBox.currentText === "feature-extraction"; model: ["mean","cls","none"]; Accessible.name: qsTr("Embedding pooling") }
            CCheckBox { id: normalize; visible: pooling.visible; text: qsTr("Normalize vectors") }
            CCheckBox { id: processConsent; objectName: "inferenceConsent"; text: qsTr("Send %1 to %2").arg(dialog.ocr || dialog.binaryInput ? dialog.source?.name || "" : qsTr("the entered text")).arg(dialog.account?.name || "") }
            CButton { objectName: "inferenceRun"; text: dialog.ocr ? qsTr("Extract text with OCR") : qsTr("Run inference"); enabled: processConsent.checked && !!dialog.account && !dialog.working && (dialog.ocr ? (dialog.pdf || (action.version?.mime || "").startsWith("image/")) : !!model.text.trim() && (dialog.binaryInput || !!input.text.trim())); onClicked: dialog.processInput() }
        }
        CText { visible: dialog.working || !!dialog.message; text: dialog.working ? qsTr("Waiting for the provider…") : dialog.message }
        CButton { text: qsTr("Close"); onClicked: dialog.close() }
    }
}
