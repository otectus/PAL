import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Recordings.js" as Recordings
Rectangle {
    id: card
    property var message
    readonly property bool assistantReply: message.role === "assistant" && !delegation
    readonly property bool compact: width < Theme.toolbarBreakpoint
    signal quoteRequested(string text)
    signal proposalRequested(string kind)
    signal taskProposed(string text)
    signal branchRequested(string text)
    signal exportRequested()
    signal documentRequested(string markdown)
    // Only the conversation view handles saving a message.
    property bool canExport:false
    // The owning vertical view lets code-header controls avoid materializing outside its clip.
    // Standalone cards (for example a pinned reply) leave this unset.
    property var verticalViewport: null
    property string contextCode: ""
    readonly property bool conversational: message.role !== "tool" && !workbench && !delegation
    readonly property bool speechActive: ["preparing", "speaking"].indexOf(App.state.speech?.state) >= 0 || (App.state.speech?.queued || 0) > 0
    function openActions(position, source, x, y) {
        contextCode = message.role === "tool" || workbench ? "" : App.messageCodeAt(body.textDocument, position)
        messageMenu.popup(source, x, y)
    }
    function codeHeaderVisible(headerY, headerHeight) {
        if(!verticalViewport)return true
        const trackedContentY=verticalViewport.contentY
        const point=body.mapToItem(verticalViewport,0,headerY)
        return trackedContentY>=verticalViewport.originY-1&&point.y+headerHeight>0&&point.y<verticalViewport.height
    }
    property string directory: App.session.cwd || ""
    // PAL's no-progress notice from its own tool loop (broker/tool-progress.ts): a warning, never an action.
    readonly property bool noProgress: message.role==="tool"&&String(message.text||"").startsWith("No progress detected\n")
    // PAL's own Delegation update (broker/delegation-pings.ts): a user-role row, but never the user's words.
    readonly property bool delegation: message.kind==="delegation"
    // A Workbench row is PAL's own record of a change set, artifact or run: plain text, never the model's words.
    readonly property bool workbench: message.role==="workbench"
    property bool initiallyCollapsed: message.role === "tool" && !noProgress
    // Scroll delegates can be recycled. Keep explicit choices with the transcript, keyed by message.
    property var foldOwner: card
    property var messageFolds: ({})
    readonly property bool collapsed: foldOwner.messageFolds[message.id] ?? initiallyCollapsed
    function toggleFold() {
        const choices = Object.assign({}, foldOwner.messageFolds)
        if (collapsed !== initiallyCollapsed) delete choices[message.id]
        else choices[message.id] = !collapsed
        foldOwner.messageFolds = choices
    }
    // The stored reply keeps its memory citations; while they are hidden this card leaves them out of
    // what it shows, copies, quotes, speaks and branches. Tool output stays as it was produced.
    readonly property bool hidesCitations: message.role!=="tool"&&!workbench&&!App.showMemoryCitations
    readonly property string displayText: hidesCitations?App.displayText(message.text,false):message.text
    // A hidden host (the other PAL window) skips document formatting while a reply streams and
    // formats once when it is shown again.
    readonly property bool hostVisible: Window.window ? Window.window.visible : true
    onHostVisibleChanged: if(hostVisible)body.scheduleFormat()
    onMessageChanged: Qt.callLater(body.scheduleFormat)
    onCollapsedChanged: if(!collapsed)Qt.callLater(body.scheduleFormat)
    Connections {
        target: App
        function onThemeChanged() { body.scheduleFormat() }
    }
    Accessible.role: Accessible.Grouping
    Accessible.name: (card.workbench ? "Workbench" : card.delegation ? App.assistantName + " delegation update" : card.message.role === "user" ? "Your message" : card.noProgress ? "No progress warning" : card.message.role === "tool" ? "Tool activity" : App.assistantName + " reply")
    Accessible.description: card.collapsed ? "Collapsed. Expand to read the full message." : ""
    HoverHandler { id:cardHover }
    clip: true
    color: assistantReply ? Theme.transparent : delegation||workbench ? Theme.surface : message.role==="user" ? Theme.userBubble : message.role==="tool" ? Theme.input : Theme.surface
    radius: Theme.radius
    border.color: assistantReply ? Theme.transparent : noProgress ? Theme.amber : delegation||workbench ? Theme.activeBorder : message.role==="user" ? Theme.userBubbleBorder : Theme.subtle
    implicitHeight: contents.implicitHeight+(card.compact?Theme.space5:Theme.space6)
    ColumnLayout {
        id:contents;anchors.fill:parent;anchors.margins:card.compact?Theme.space3:Theme.space4;anchors.leftMargin:card.assistantReply?Theme.focusWidth:anchors.margins;spacing:card.compact?Theme.space2:Theme.space3
        RowLayout {
            spacing:Theme.space1
            Rectangle { visible:card.delegation||card.workbench||card.message.role==="tool";Layout.preferredWidth:Theme.statusDot;Layout.preferredHeight:Theme.statusDot;radius: Theme.radiusChip;color:card.noProgress?Theme.amber:Theme.accentText }
            Text { objectName:"messageAuthor";text:card.workbench ? "Workbench" : card.delegation ? App.assistantName+" · Delegation update" : card.message.role==="user" ? "You" : card.noProgress ? "No progress detected" : card.message.role==="tool" ? "Tool activity" : App.assistantName;elide:Text.ElideRight;textFormat:Text.PlainText;color:card.message.role==="user"&&!card.delegation?Theme.muted:Theme.accentText;font.family:Theme.font;font.pixelSize:Theme.secondary;font.weight:Font.DemiBold;Layout.fillWidth:true;Layout.minimumWidth:0 }
            CButton{objectName:"noProgressStop";visible:card.noProgress&&card.message.sessionId===App.selectedId&&["starting","working","waiting"].indexOf(App.session.status)>=0;danger:true;text:"Stop";implicitHeight:Theme.compactHeight;help:"Stop this turn";enabled:App.connected;onClicked:App.rpc("session.stop",{id:card.message.sessionId})}
            CButton {
                id:foldButton
                objectName: "foldMessage_" + card.message.id
                visible: card.message.role === "tool" || (card.canExport && (card.collapsed || body.lineCount >= 8 || card.displayText.length >= 400))
                iconName: card.collapsed ? "chevron" : "down"; quiet: true; implicitHeight: Theme.compactHeight
                opacity:cardHover.hovered||activeFocus||copyButton.activeFocus||actionsButton.activeFocus?1:0
                help: card.collapsed ? qsTr("Expand message") : qsTr("Collapse message")
                Accessible.expanded: !card.collapsed; onClicked: card.toggleFold()
            }
            CButton{id:copyButton;objectName:"copyMessage_"+card.message.id;text:"";iconName:"copy";quiet:true;implicitHeight:Theme.compactHeight;implicitWidth:Theme.compactHeight;opacity:cardHover.hovered||activeFocus||foldButton.activeFocus||actionsButton.activeFocus?1:0;help:"Copy message";Accessible.name:"Copy message";onClicked:card.copyMessage()}
            CButton{id:actionsButton;objectName:"messageActions_"+card.message.id;text:"";iconName:"more";quiet:true;implicitHeight:Theme.compactHeight;implicitWidth:Theme.compactHeight;opacity:cardHover.hovered||activeFocus||foldButton.activeFocus||copyButton.activeFocus?1:0;help:"More message actions";Accessible.name:"Message actions";onClicked:card.openActions(body.cursorPosition,this,0,height)}
        }
        Text { visible:card.collapsed;text:card.displayText.slice(0, 240).trim().split("\n")[0];color:Theme.muted;Layout.fillWidth:true;elide:Text.ElideRight;font.pixelSize:Theme.secondary }
        Flickable {
            id:messageViewport;objectName:"messageViewport_"+card.message.id
            visible:!card.collapsed
            Layout.fillWidth:true;Layout.minimumWidth:0
            implicitHeight:body.implicitHeight+(contentWidth>width?Theme.minimumTarget:0)
            contentWidth:Math.max(width,body.contentWidth);contentHeight:height
            flickableDirection:Flickable.HorizontalFlick;clip:true
            interactive: contentWidth > width
            boundsBehavior: Flickable.StopAtBounds
            Component.onCompleted: App.routeMessageWheel(messageViewport)
            onWidthChanged:body.overflowWidth=0
            ScrollBar.horizontal:CScrollBar {}
            TextArea {
                id:body;objectName:"messageBody_"+card.message.id
                property bool formatting:false
                property real overflowWidth:0
                property var codeHeaders: []
                property string formattedMessageId: ""
                function expandForOverflow(){if(contentWidth>width+1)overflowWidth=Math.ceil(contentWidth)}
                function scheduleFormat(){
                    if(card.message.role==="tool"||card.workbench){formatTimer.stop();codeHeaders=[];return}
                    if(card.hostVisible&&!card.collapsed&&!formatTimer.running)formatTimer.start()
                }
                // Prose is formatted to the visible width; only code and tables reach past it.
                function formatDocument(){
                    // A deferred call can run after its window (and App) is gone.
                    if(formatting||typeof App==="undefined"||!card.hostVisible)return
                    if(card.message.role==="tool"||card.workbench){codeHeaders=[];return}
                    formatting=true
                    codeHeaders=App.formatMessage(textDocument,messageViewport.width,Theme.space2,Theme.compactHeight,Theme.bodyLeading)||[]
                    formattedMessageId = card.message.id
                    formatting=false
                }
                // QTextDocument emits textChanged for block-format edits too. Those edits are this
                // formatter's output, not new Markdown; scheduling them created a perpetual 32 ms loop.
                onTextChanged:if(!formatting){overflowWidth=0;scheduleFormat()}
                onWidthChanged:scheduleFormat()
                onContentWidthChanged:Qt.callLater(expandForOverflow)
                Component.onCompleted:scheduleFormat()
                // The item must cover the table so Qt paints columns reached by scrolling.
                width:Math.max(messageViewport.width,overflowWidth)
                text:card.displayText
                // Long URLs and paths break where they must instead of widening the message. Table
                // columns still keep their longest word, so a table too wide for the view scrolls.
                readOnly:true;selectByMouse:true;wrapMode:TextEdit.Wrap
                textFormat:card.message.role==="tool"||card.workbench?TextEdit.PlainText:TextEdit.MarkdownText
                color:Theme.text;selectionColor:Theme.selectionFill;selectedTextColor:Theme.selectionInk
                font.pixelSize:Theme.message;font.family:card.message.role==="tool"?Theme.mono:Theme.font
                padding:0;background:null
                palette.link:Theme.accentText
                baseUrl:"file://"+card.directory+"/"
                onLinkActivated:link=>App.openMessageLink(link,card.directory)
                TapHandler {
                    acceptedButtons: Qt.RightButton
                    onTapped: point => card.openActions(body.positionAt(point.position.x, point.position.y), body, point.position.x, point.position.y)
                }
                Keys.onPressed: event => {
                    if (event.key === Qt.Key_Menu || (event.key === Qt.Key_F10 && (event.modifiers & Qt.ShiftModifier))) {
                        card.openActions(body.cursorPosition, body, body.cursorRectangle.x, body.cursorRectangle.y + body.cursorRectangle.height)
                        event.accepted = true
                    }
                }
                ToolTip.delay:Theme.tooltipDelay
                ToolTip.visible:hoveredLink.length>0
                ToolTip.text:hoveredLink
                Timer { id:formatTimer;interval:32;onTriggered:body.formatDocument() }
            }
            Repeater {
                // A recycled delegate can still hold fence positions from the previous message.
                model: body.formattedMessageId === card.message.id ? body.codeHeaders : []
                Rectangle {
                    id:codeHeader
                    required property var modelData
                    required property int index
                    readonly property bool validPosition: Number.isFinite(Number(modelData.position)) && Number(modelData.position) >= 0 && Number(modelData.position) <= body.length
                    readonly property rect codePosition: validPosition ? body.positionToRectangle(Number(modelData.position)) : Qt.rect(0,0,0,0)
                    readonly property real headerY: codePosition.y - Theme.compactHeight
                    x: messageViewport.contentX
                    y: headerY
                    z: 2
                    width: messageViewport.width
                    height: Theme.compactHeight
                    visible: validPosition && card.codeHeaderVisible(headerY,height)
                    clip: true
                    color: Theme.codeSurface
                    border.color: Theme.line
                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: Theme.space2
                        spacing: Theme.space2
                        Text {
                            objectName: "codeFenceLanguage_" + card.message.id + "_" + index
                            Layout.fillWidth: true
                            text: modelData.language || qsTr("Code")
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            color: Theme.muted
                            font.family: Theme.mono
                            font.pixelSize: Theme.caption
                        }
                        CButton {
                            objectName: "copyCodeFence_" + card.message.id + "_" + index
                            Layout.preferredWidth: Theme.compactHeight
                            Layout.preferredHeight: Theme.compactHeight
                            implicitWidth: Theme.compactHeight
                            implicitHeight: Theme.compactHeight
                            text: ""
                            iconName: "copy"
                            quiet: true
                            help: qsTr("Copy code block")
                            Accessible.name: help
                            onClicked: App.copy(App.messageCodeAt(body.textDocument, modelData.position))
                        }
                    }
                }
            }
        }
        // §16.3: times this reply cites from a transcript it was given. Each opens the recording there.
        Flow {
            id:times
            readonly property var cited:card.collapsed||!(card.message.recordings||[]).length?[]:Recordings.cited(card.message.text,8)
            visible:cited.length>0;Layout.fillWidth:true;spacing:Theme.space1
            Repeater {
                model:times.cited
                CButton {
                    required property var modelData
                    objectName:"citedTime_"+modelData.label;text:modelData.label;iconName:"play";quiet:true;implicitHeight:Theme.compactHeight
                    readonly property var recording:card.message.recordings[0]
                    help:"Open "+recording.name+" at "+modelData.label;Accessible.description:help
                    onClicked:{App.selectedId=card.message.sessionId;WorkbenchState.openRecording(card.message.sessionId,{artifactId:recording.artifactId,versionId:recording.versionId,seconds:modelData.start})}
                }
            }
        }
        Repeater {
            model:card.collapsed?[]:(card.message.sources||[])
            CButton { required property var modelData;Layout.fillWidth:true;alignLeft:true;iconName:"arrow";text:modelData.title;help:modelData.url;Accessible.description:modelData.url;onClicked:if(/^https?:\/\//.test(modelData.url))Qt.openUrlExternally(modelData.url) }
        }
        CButton {
            objectName:"reviewChanges_"+card.message.id;visible:card.message.kind==="changes"&&!!card.message.changeSetId
            text:"Review changes";iconName:"edit";primary:true;Layout.alignment:Qt.AlignLeft
            onClicked:{App.selectedId=card.message.sessionId;WorkbenchState.openReview(card.message.changeSetId)}
        }
        // Broker-issued artifact references only; a path printed in a reply is never a file card.
        Repeater {
            model:card.collapsed?[]:(card.message.artifacts||[])
            ArtifactCard { required property var modelData;Layout.fillWidth:true;reference:modelData;sessionId:card.message.sessionId }
        }
        // M02: a formatting check the reply missed. The reply's text is never changed.
        Text {
            objectName:"styleNotes";visible:!card.collapsed&&(card.message.styleNotes||[]).length>0;Layout.fillWidth:true
            text:"Formatting check missed: "+(card.message.styleNotes||[]).map(note=>note.label+(note.count>1?" ("+note.count+")":"")).join(" · ")+". The reply is shown as written."
            wrapMode:Text.Wrap;textFormat:Text.PlainText;color:Theme.muted;font.family:Theme.font;font.pixelSize:Theme.caption
        }
    }
    CMenu {
        id:messageMenu
        CMenuItem { text:"Copy selection"; visible:body.selectedText.length>0; onTriggered:App.copy(body.selectedText) }
        CMenuItem { objectName:"copyCodeBlock"; text:"Copy code block"; visible:card.contextCode.length>0; onTriggered:App.copy(card.contextCode) }
        CMenuItem { objectName:"quoteMessage";visible:card.conversational;text:body.selectedText?"Quote selection":"Quote message";onTriggered:card.quoteRequested(body.selectedText||card.displayText) }
        CMenuItem { text:(App.state.bookmarks||[]).some(b=>b.messageId===card.message.id)?"Remove bookmark":"Bookmark";onTriggered:App.rpc("message.bookmark",{sessionId:card.message.sessionId,messageId:card.message.id,bookmarked:!(App.state.bookmarks||[]).some(b=>b.messageId===card.message.id)}) }
        CMenuItem { text:body.selectedText?"Speak selection":"Speak message";onTriggered:App.rpc("tts.speak",{text:(body.selectedText||card.displayText).slice(0,20000),sessionId:card.message.sessionId,messageId:card.message.id}) }
        CMenuItem { visible:card.assistantReply;text:"Propose project decision";onTriggered:{card.proposalRequested("decision")} }
        CMenuItem { visible:card.assistantReply;text:"Propose project constraint";onTriggered:{card.proposalRequested("constraint")} }
        CMenuItem { objectName:"proposeTask";visible:card.assistantReply;text:body.selectedText?"Propose selection as a next step":"Propose as a next step";onTriggered:card.taskProposed(body.selectedText) }
        CMenuItem { visible:card.conversational;text:"Branch with reviewed context";onTriggered:card.branchRequested(body.selectedText||card.displayText) }
        CMenuItem { objectName:"messageAsDocument";text:"Export as PDF or Word…";visible:card.canExport&&card.message.role==="assistant"&&!card.delegation&&card.displayText.trim().length>0;onTriggered:card.documentRequested(card.displayText) }
        CMenuItem { objectName:"saveMessageAs";text:"Save message as…";visible:card.canExport&&card.message.role!=="tool";onTriggered:card.exportRequested() }
        CMenuItem { visible:card.speechActive;text:"Stop speaking";onTriggered:App.rpc("tts.stop",{}) }
    }

    function copyMessage() {
        if (message.truncated) App.copySessionMessage(message.sessionId, message.id, hidesCitations)
        else App.copy(displayText)
    }

}
