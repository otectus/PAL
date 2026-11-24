pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Accounts.js" as Accounts
// Workbench › Accounts: the agenda, mail, files and GitHub of the connected accounts, and what waits to be sent. Reading
// goes to the service each time. Anything written is a draft first, shown in full, and sent by its own button.
Item {
    id: pane
    objectName: "accountsPane"
    implicitHeight: Theme.editorMedium
    property string sessionId: ""
    property var list: ({ accounts: [], providers: [] })
    property string service: "calendar"
    property string error: ""
    property string notice: ""
    property bool listed: false
    signal settingsRequested(string category, string target)
    signal written()
    readonly property int revision: App.state.accounts?.revision || 0
    readonly property int waiting: App.state.accounts?.waiting || 0
    readonly property var usable: Accounts.withService(list.accounts, service)
    // Which account is kept by its ID, so a refreshed list never closes what is open or forgets the choice.
    property string chosen: ""
    readonly property string accountId: (usable.find(item => item.id === chosen) || usable[0] || ({})).id || ""
    readonly property var account: usable.find(item => item.id === accountId) || null
    readonly property bool writable: Accounts.canWrite(account, service)
    readonly property var services: [{ id: "calendar", label: "Agenda" }, { id: "mail", label: "Mail" }, { id: "drive", label: "Files" }, { id: "github", label: "GitHub" }, { id: "outbox", label: "Drafts" + (waiting ? " · " + waiting : "") }]
    readonly property var session: App.session || ({})
    RpcClient { id: rpc }
    function failed(value) { if (!value.error) return false; error = String(value.error.message || value.error); return true }
    function refresh() { rpc.call("accounts.list", {}, value => { if (pane.failed(value)) return; list = value; listed = true; if (!accountId) error = "" }) }
    function show(id) { service = id; error = ""; notice = "" }
    /** Keeps something from an account as a file of this conversation, and offers it to the next message. */
    function keep(params, what) {
        error = ""; notice = ""
        rpc.call("accounts.import", Object.assign({ sessionId: sessionId, accountId: account.id }, params), value => {
            if (pane.failed(value)) return
            const references = WorkbenchState.referencesFor(sessionId)
            if (references.length < 8) WorkbenchState.setReferences(sessionId, references.concat([{ kind: "artifact", artifactId: value.artifactId, versionId: value.versionId, label: value.name }]))
            notice = value.name + " is now a file of this conversation" + (references.length < 8 ? " and is added to your next message." : ".")
        })
    }
    onRevisionChanged: if (visible) refresh()
    onVisibleChanged: if (visible) refresh()
    // The palette opens the pane on a service.
    function take() { if (!WorkbenchState.accountsService) return; show(WorkbenchState.accountsService); WorkbenchState.accountsService = "" }
    Connections { target: WorkbenchState; function onAccountsServiceChanged() { pane.take() } }
    Component.onCompleted: { refresh(); take() }
    ColumnLayout {
        anchors.fill: parent; spacing: Theme.space2
        Flow {
            Layout.fillWidth: true; spacing: Theme.space1
            Accessible.role: Accessible.PageTabList; Accessible.name: "Accounts"
            Repeater {
                model: pane.services
                CButton { required property var modelData; objectName: "accountsTab_" + modelData.id; text: modelData.label; quiet: true; primary: pane.service === modelData.id; implicitHeight: Theme.compactHeight; Accessible.role: Accessible.PageTab; Accessible.selected: primary; onClicked: pane.show(modelData.id) }
            }
        }
        RowLayout {
            visible: pane.service !== "outbox" && pane.usable.length > 0
            Layout.fillWidth: true; spacing: Theme.space2
            CComboBox { id: accountBox; objectName: "accountsAccount"; visible: pane.usable.length > 1; Layout.fillWidth: true; model: pane.usable.map(item => item.label + " · " + item.login); currentIndex: Math.max(0, pane.usable.findIndex(item => item.id === pane.accountId)); Accessible.name: "Account"; onActivated: index => pane.chosen = pane.usable[index].id }
            CText { visible: pane.usable.length === 1; text: pane.account ? pane.account.label + " · " + pane.account.login : ""; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
        }
        CText { objectName: "accountsPaneError"; visible: !!pane.error; text: pane.error; color: Theme.danger; font.pixelSize: Theme.secondary; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
        CText { objectName: "accountsPaneNotice"; visible: !!pane.notice; text: pane.notice; color: Theme.accentText; font.pixelSize: Theme.secondary; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
        ColumnLayout {
            objectName: "accountsEmpty"
            visible: pane.listed && pane.service !== "outbox" && !pane.usable.length
            Layout.fillWidth: true; spacing: Theme.space2
            CText { text: pane.service === "github" ? "Connect GitHub to read repositories, issues and pull requests, and to prepare changes." : pane.service === "calendar" ? "Connect Google or Microsoft to see your agenda and add events." : pane.service === "mail" ? "Connect Google or Microsoft to search and read mail, and to write replies." : "Connect Google or Microsoft to find files, use them here and write versions back."; color: Theme.muted; Layout.fillWidth: true; wrapMode: Text.Wrap }
            CButton { objectName: "accountsConnect"; text: "Connect an account…"; primary: true; onClicked: pane.settingsRequested("connections", "accountsSettings") }
        }
        Loader { Layout.fillWidth: true; Layout.fillHeight: true; active: pane.service === "calendar" && !!pane.accountId; visible: active; sourceComponent: agenda }
        Loader { Layout.fillWidth: true; Layout.fillHeight: true; active: pane.service === "mail" && !!pane.accountId; visible: active; sourceComponent: mail }
        Loader { Layout.fillWidth: true; Layout.fillHeight: true; active: pane.service === "drive" && !!pane.accountId; visible: active; sourceComponent: drive }
        Loader { Layout.fillWidth: true; Layout.fillHeight: true; active: pane.service === "github" && !!pane.accountId; visible: active; sourceComponent: github }
        Loader { Layout.fillWidth: true; Layout.fillHeight: true; active: pane.service === "outbox"; visible: active; sourceComponent: outbox }
        Item { visible: pane.service !== "outbox" && !pane.account; Layout.fillHeight: true }
    }
    component Scroll: ScrollView {
        id: scroll
        default property alias rows: rows.data
        clip: true; contentWidth: availableWidth
        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
        ScrollBar.vertical: CScrollBar { parent: scroll; x: scroll.width - width; height: scroll.availableHeight }
        ColumnLayout { id: rows; width: scroll.availableWidth - Theme.space3; spacing: Theme.space1 }
    }
    // One thing in a list: what it is, what is known about it, and what can be done with it.
    component Entry: Rectangle {
        id: entry
        property string label: ""
        property string detail: ""
        property string note: ""
        property string icon: ""
        property bool strong: false
        property bool selected: false
        default property alias actions: actions.data
        signal activated()
        Layout.fillWidth: true
        implicitHeight: body.implicitHeight + 2 * Theme.space2
        radius: Theme.radiusControl
        color: entry.selected ? Theme.selected : touch.hovered ? Theme.raised : Theme.transparent
        border.width: entry.activeFocus ? Theme.focusWidth : 0; border.color: Theme.focus
        activeFocusOnTab: true
        Accessible.role: Accessible.Button; Accessible.name: entry.label + (entry.detail ? ", " + entry.detail : ""); Accessible.onPressAction: entry.activated()
        Keys.onReturnPressed: entry.activated()
        Keys.onSpacePressed: entry.activated()
        HoverHandler { id: touch }
        TapHandler { onTapped: entry.activated() }
        RowLayout {
            id: body
            x: Theme.space2; y: Theme.space2; width: parent.width - 2 * Theme.space2; spacing: Theme.space2
            CIcon { visible: !!entry.icon; name: entry.icon; Layout.preferredWidth: Theme.iconSmall; Layout.preferredHeight: Theme.iconSmall; Layout.alignment: Qt.AlignTop }
            ColumnLayout {
                Layout.fillWidth: true; Layout.minimumWidth: 0; spacing: 0
                CText { text: entry.label; font.weight: entry.strong ? Font.DemiBold : Font.Normal; Layout.fillWidth: true; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                CText { visible: !!entry.detail; text: entry.detail; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; elide: Text.ElideRight; wrapMode: Text.NoWrap }
                CText { visible: !!entry.note; text: entry.note; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight }
                Flow { id: actions; Layout.fillWidth: true; spacing: Theme.space1; visible: entry.selected && children.length > 0 }
            }
        }
    }
    component Small: CButton { quiet: true; implicitHeight: Theme.compactHeight; leftPadding: Theme.space2; rightPadding: Theme.space2; font.pixelSize: Theme.caption }

    // ── Agenda ──
    Component {
        id: agenda
        ColumnLayout {
            id: view
            spacing: Theme.space2
            readonly property string zone: pane.list.timeZone || "UTC"
            property string today: Accounts.isoDay(new Date())
            property string from: today
            property int days: 7
            property var events: []
            property var calendars: []
            property string open: ""
            property bool loaded: false
            function load() {
                const start = new Date(from + "T00:00:00"), end = new Date(Accounts.addDays(from, days) + "T00:00:00"), chosen = calendarBox.currentIndex > 0 ? calendars[calendarBox.currentIndex - 1]?.id : ""
                pane.error = ""
                rpc.call("accounts.agenda", Object.assign({ accountId: pane.accountId, from: start.getTime(), to: end.getTime() }, chosen ? { calendarId: chosen } : {}), value => { if (pane.failed(value)) return; events = value.events; loaded = true })
            }
            Component.onCompleted: { rpc.call("accounts.calendars", { accountId: pane.accountId }, value => { if (!value.error) calendars = value.calendars }); load() }
            Connections { target: pane; function onAccountIdChanged() { if (pane.accountId) view.load() } function onWritten() { if (pane.accountId) view.load() } }
            Flow {
                Layout.fillWidth: true; spacing: Theme.space1
                Small { text: "Earlier"; onClicked: { view.from = Accounts.addDays(view.from, -view.days); view.load() } }
                Small { text: "Today"; enabled: view.from !== view.today; onClicked: { view.from = view.today; view.load() } }
                Small { text: "Later"; onClicked: { view.from = Accounts.addDays(view.from, view.days); view.load() } }
                Small { text: view.days === 7 ? "Show a month" : "Show a week"; onClicked: { view.days = view.days === 7 ? 31 : 7; view.load() } }
                CButton { objectName: "newEvent"; visible: pane.writable; text: "New event…"; iconName: "plus"; implicitHeight: Theme.compactHeight; onClicked: eventEditor.openFor(null, view.from) }
            }
            CComboBox { id: calendarBox; visible: view.calendars.length > 1; Layout.fillWidth: true; model: ["My calendar"].concat(view.calendars.map(item => item.name)); Accessible.name: "Calendar"; onActivated: view.load() }
            CText { visible: view.loaded && !view.events.length; text: "Nothing on the calendar in these " + view.days + " days."; color: Theme.muted }
            Scroll {
                Layout.fillWidth: true; Layout.fillHeight: true
                Repeater {
                    model: Accounts.byDay(view.events, view.from, view.days)
                    ColumnLayout {
                        id: group
                        required property var modelData
                        Layout.fillWidth: true; spacing: 0
                        CText { text: Accounts.dayTitle(group.modelData.day, view.today, Qt.locale()); font.weight: Font.DemiBold; font.pixelSize: Theme.secondary; Layout.topMargin: Theme.space2; Accessible.role: Accessible.Heading }
                        Repeater {
                            model: group.modelData.events
                            Entry {
                                id: row
                                required property var modelData
                                objectName: "agendaEvent_" + modelData.id
                                label: Accounts.timeText(modelData, group.modelData.day, view.zone) + "  " + modelData.title
                                detail: [modelData.location, modelData.recurrence, modelData.attendees.length ? modelData.attendees.length + (modelData.attendees.length === 1 ? " guest" : " guests") : ""].filter(text => !!text).join(" · ")
                                note: selected ? modelData.notes || "" : ""
                                selected: view.open === modelData.id
                                onActivated: view.open = selected ? "" : modelData.id
                                Small { visible: pane.writable && row.modelData.canEdit; text: "Change…"; onClicked: eventEditor.openFor(row.modelData, "") }
                                Small { visible: pane.writable && row.modelData.canEdit; text: "Delete…"; onClicked: reviewer.prepare({ accountId: pane.accountId, kind: "calendar.remove", calendarId: row.modelData.calendarId, eventId: row.modelData.id, revision: row.modelData.revision }) }
                                Small { visible: !!row.modelData.link; text: "Open at the service"; onClicked: Qt.openUrlExternally(row.modelData.link) }
                            }
                        }
                    }
                }
            }
        }
    }
    // ── Mail ──
    Component {
        id: mail
        ColumnLayout {
            id: view
            spacing: Theme.space2
            property var threads: []
            property var messages: []
            property string threadId: ""
            property bool loaded: false
            function search() { pane.error = ""; threadId = ""; rpc.call("accounts.mailSearch", { accountId: pane.accountId, query: query.text.trim() }, value => { if (pane.failed(value)) return; threads = value.threads; loaded = true }) }
            function openThread(id) { pane.error = ""; rpc.call("accounts.mailThread", { accountId: pane.accountId, threadId: id }, value => { if (pane.failed(value)) return; messages = value.messages; threadId = id }) }
            Component.onCompleted: search()
            Connections { target: pane; function onAccountIdChanged() { if (pane.accountId) view.search() } }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space1
                CButton { objectName: "mailBack"; visible: !!view.threadId; text: ""; iconName: "back"; quiet: true; help: "Back to the list"; Accessible.name: help; implicitHeight: Theme.compactHeight; onClicked: view.threadId = "" }
                CField { id: query; objectName: "mailQuery"; Layout.fillWidth: true; placeholderText: "Search mail"; Accessible.name: "Search mail"; implicitHeight: Theme.compactHeight; onAccepted: view.search() }
                Small { text: "Search"; onClicked: view.search() }
                CButton { objectName: "newMail"; visible: pane.writable; text: "Write…"; iconName: "edit"; implicitHeight: Theme.compactHeight; onClicked: mailEditor.openFor(null) }
            }
            CText { visible: view.loaded && !view.threads.length && !view.threadId; text: "No mail matches."; color: Theme.muted }
            Scroll {
                visible: !view.threadId
                Layout.fillWidth: true; Layout.fillHeight: true
                Repeater {
                    model: view.threads
                    Entry { required property var modelData; objectName: "mailThread_" + modelData.threadId; icon: "inbox"; strong: modelData.unread; label: modelData.subject; detail: Accounts.person(modelData.from) + " · " + new Date(modelData.date).toLocaleString(Qt.locale(), Locale.ShortFormat) + (modelData.unread ? " · unread" : ""); note: modelData.snippet; onActivated: view.openThread(modelData.threadId) }
                }
            }
            Scroll {
                visible: !!view.threadId
                Layout.fillWidth: true; Layout.fillHeight: true
                CText { text: view.messages[0]?.subject || ""; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
                Flow {
                    Layout.fillWidth: true; spacing: Theme.space1
                    Small { objectName: "keepMail"; text: "Use in this conversation"; onClicked: pane.keep({ what: "mail", threadId: view.threadId }) }
                    Small { objectName: "replyMail"; visible: pane.writable && view.messages.length > 0; text: "Reply…"; onClicked: mailEditor.openFor({ mail: Accounts.reply(view.messages[view.messages.length - 1], pane.account.login) }) }
                }
                Repeater {
                    model: view.messages
                    ColumnLayout {
                        id: message
                        required property var modelData
                        Layout.fillWidth: true; Layout.topMargin: Theme.space2; spacing: Theme.space1
                        CText { text: Accounts.person(message.modelData.from) + (message.modelData.draft ? " · draft" : ""); font.weight: Font.DemiBold; font.pixelSize: Theme.secondary; Layout.fillWidth: true; elide: Text.ElideRight }
                        CText { text: new Date(message.modelData.date).toLocaleString(Qt.locale(), Locale.ShortFormat) + " · to " + message.modelData.to.concat(message.modelData.cc).map(item => item.email).join(", "); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
                        CText { objectName: "mailText_" + message.modelData.id; text: message.modelData.text + (message.modelData.truncated ? "\n\n[shortened]" : ""); textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap }
                        Repeater { model: message.modelData.attachments; Small { required property var modelData; text: modelData.name + " · " + Accounts.size(modelData.bytes); iconName: "file"; help: "Keep this attachment as a file of this conversation"; onClicked: pane.keep({ what: "attachment", messageId: message.modelData.id, attachmentId: modelData.id, name: modelData.name }) } }
                    }
                }
            }
        }
    }
    // ── Files ──
    Component {
        id: drive
        ColumnLayout {
            id: view
            spacing: Theme.space2
            property var items: []
            property var path: []
            property string open: ""
            property bool loaded: false
            function search() { const text = query.text.trim(); pane.error = ""; path = []; if (!text) { folder(null); return } rpc.call("accounts.driveSearch", { accountId: pane.accountId, query: text }, value => { if (pane.failed(value)) return; items = value.items; loaded = true }) }
            function folder(item) { pane.error = ""; rpc.call("accounts.driveList", Object.assign({ accountId: pane.accountId }, item ? { folderId: item.id } : {}), value => { if (pane.failed(value)) return; path = item ? path.concat([item]) : []; items = value.items; open = ""; loaded = true }) }
            Component.onCompleted: folder(null)
            Connections { target: pane; function onAccountIdChanged() { if (pane.accountId) view.folder(null) } }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space1
                CButton { visible: view.path.length > 0; text: ""; iconName: "back"; quiet: true; help: "Back"; Accessible.name: "Back to the folder above"; implicitHeight: Theme.compactHeight; onClicked: { const up = view.path.slice(0, -1); view.path = up.slice(0, -1); view.folder(up.length ? up[up.length - 1] : null) } }
                CField { id: query; objectName: "driveQuery"; Layout.fillWidth: true; placeholderText: "Find files"; Accessible.name: "Find files"; implicitHeight: Theme.compactHeight; onAccepted: view.search() }
                Small { text: "Find"; onClicked: view.search() }
            }
            CText { visible: view.path.length > 0; text: view.path.map(item => item.name).join(" / "); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; elide: Text.ElideLeft; wrapMode: Text.NoWrap }
            CText { visible: view.loaded && !view.items.length; text: "No files here."; color: Theme.muted }
            Scroll {
                Layout.fillWidth: true; Layout.fillHeight: true
                Repeater {
                    model: view.items
                    Entry {
                        id: row
                        required property var modelData
                        objectName: "driveItem_" + modelData.id
                        icon: modelData.folder ? "projects" : "file"; label: modelData.name
                        detail: modelData.folder ? "Folder" : [Accounts.size(modelData.bytes), modelData.modified ? "changed " + new Date(modelData.modified).toLocaleDateString(Qt.locale(), Locale.ShortFormat) : "", modelData.exported ? "opens as " + modelData.exported.split("/").pop() : ""].filter(text => !!text).join(" · ")
                        selected: view.open === modelData.id
                        onActivated: modelData.folder ? view.folder(modelData) : view.open = selected ? "" : modelData.id
                        Small { text: "Use in this conversation"; onClicked: pane.keep({ what: "drive", fileId: row.modelData.id }) }
                        Small { visible: pane.writable && row.modelData.canEdit; text: "Write a version back…"; help: "Choose a file of this conversation as the new version"; onClicked: filePicker.openFor(row.modelData, "") }
                        Small { visible: !!row.modelData.link; text: "Open at the service"; onClicked: Qt.openUrlExternally(row.modelData.link) }
                    }
                }
                Small { visible: pane.writable; text: "Upload a file of this conversation here…"; iconName: "plus"; onClicked: filePicker.openFor(null, view.path.length ? view.path[view.path.length - 1].id : "") }
            }
        }
    }
    // ── GitHub ──
    Component {
        id: github
        ColumnLayout {
            id: view
            spacing: Theme.space2
            property var found: []
            property var item: null
            property bool loaded: false
            readonly property var kinds: ["issues", "pulls", "repositories", "code"]
            function search() { const text = query.text.trim(); if (!text) return; pane.error = ""; item = null; rpc.call("accounts.githubSearch", { accountId: pane.accountId, kind: kinds[kind.currentIndex], query: text }, value => { if (pane.failed(value)) return; found = value.items; loaded = true }) }
            function open(entry) {
                const what = entry.number ? (kinds[kind.currentIndex] === "pulls" ? "pull" : "issue") : entry.path ? "file" : "repository"
                pane.error = ""
                rpc.call("accounts.githubRead", Object.assign({ accountId: pane.accountId, what: what, repo: entry.repo }, entry.number ? { number: entry.number } : {}, entry.path ? { path: entry.path } : {}), value => { if (pane.failed(value)) return; item = Object.assign({ what: what }, value) })
            }
            RowLayout {
                Layout.fillWidth: true; spacing: Theme.space1
                CButton { visible: !!view.item; text: ""; iconName: "back"; quiet: true; help: "Back to the results"; Accessible.name: help; implicitHeight: Theme.compactHeight; onClicked: view.item = null }
                CComboBox { id: kind; implicitHeight: Theme.compactHeight; implicitWidth: Theme.fieldWidth * 0.7; model: ["Issues", "Pull requests", "Repositories", "Code"]; Accessible.name: "What to search" }
                CField { id: query; objectName: "githubQuery"; Layout.fillWidth: true; placeholderText: "For example repo:owner/name is:open"; Accessible.name: "Search GitHub"; implicitHeight: Theme.compactHeight; onAccepted: view.search() }
                Small { text: "Search"; onClicked: view.search() }
            }
            CButton { objectName: "newIssue"; visible: pane.writable && !view.item; text: "New issue…"; iconName: "plus"; implicitHeight: Theme.compactHeight; Layout.alignment: Qt.AlignLeft; onClicked: githubEditor.openFor({ kind: "issue.create", repo: "" }) }
            CText { visible: view.loaded && !view.found.length && !view.item; text: "Nothing matches."; color: Theme.muted }
            Scroll {
                visible: !view.item
                Layout.fillWidth: true; Layout.fillHeight: true
                Repeater {
                    model: view.found
                    Entry { required property var modelData; icon: modelData.path ? "file" : modelData.number ? "context" : "projects"; label: modelData.title || modelData.path || modelData.repo; detail: [modelData.number ? modelData.repo + " #" + modelData.number : modelData.title ? modelData.repo : modelData.path ? modelData.repo : modelData.description, modelData.state, modelData.author].filter(text => !!text).join(" · "); onActivated: view.open(modelData) }
                }
            }
            Scroll {
                visible: !!view.item
                Layout.fillWidth: true; Layout.fillHeight: true
                CText { text: (view.item?.title || view.item?.path || view.item?.repo || ""); font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
                CText { text: [view.item?.repo + (view.item?.number ? " #" + view.item.number : ""), view.item?.state, view.item?.author, view.item?.head ? view.item.head + " → " + view.item.base : "", (view.item?.labels || []).join(", ")].filter(text => !!text).join(" · "); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
                Flow {
                    Layout.fillWidth: true; spacing: Theme.space1
                    Small { visible: view.item?.what !== "repository"; text: "Use in this conversation"; onClicked: pane.keep({ what: "github", github: Object.assign({ what: view.item.what, repo: view.item.repo }, view.item.number ? { number: view.item.number } : {}, view.item.path ? { path: view.item.path } : {}) }) }
                    Small { visible: pane.writable && !!view.item?.number; text: "Comment…"; onClicked: githubEditor.openFor({ kind: "comment", repo: view.item.repo, number: view.item.number }) }
                    Small { visible: pane.writable && view.item?.what === "issue"; text: "Change…"; onClicked: githubEditor.openFor({ kind: "issue.update", repo: view.item.repo, number: view.item.number, title: view.item.title, body: view.item.body, state: view.item.state, revision: view.item.revision }) }
                    Small { visible: pane.writable && view.item?.what === "repository"; text: "New issue…"; onClicked: githubEditor.openFor({ kind: "issue.create", repo: view.item.repo }) }
                    Small { visible: pane.writable && view.item?.what === "repository"; text: "Pull request…"; onClicked: githubEditor.openFor({ kind: "pull.create", repo: view.item.repo, base: view.item.defaultBranch }) }
                    Small { visible: pane.writable && view.item?.what === "repository"; text: "Draft a release…"; onClicked: githubEditor.openFor({ kind: "release.draft", repo: view.item.repo }) }
                    Small { visible: !!view.item?.link; text: "Open on GitHub"; onClicked: Qt.openUrlExternally(view.item.link) }
                }
                CText { text: view.item?.body || view.item?.text || view.item?.description || ""; textFormat: Text.PlainText; font.family: view.item?.what === "file" ? Theme.mono : Theme.font; Layout.fillWidth: true; wrapMode: Text.Wrap }
                CText { visible: (view.item?.checks || []).length > 0; text: "Checks: " + (view.item?.checks || []).map(check => check.name + " " + (check.result || check.status)).join(", "); color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
                Repeater {
                    model: view.item?.files || []
                    ColumnLayout {
                        id: file
                        required property var modelData
                        Layout.fillWidth: true; spacing: 0
                        CText { text: file.modelData.path + " · +" + file.modelData.additions + " −" + file.modelData.deletions; font.weight: Font.DemiBold; font.pixelSize: Theme.caption; Layout.fillWidth: true; elide: Text.ElideMiddle; wrapMode: Text.NoWrap }
                        CText { visible: !!file.modelData.patch; text: file.modelData.patch || ""; textFormat: Text.PlainText; font.family: Theme.mono; font.pixelSize: Theme.caption; color: Theme.muted; Layout.fillWidth: true; wrapMode: Text.WrapAnywhere }
                    }
                }
                Repeater {
                    model: view.item?.comments || []
                    ColumnLayout {
                        id: comment
                        required property var modelData
                        Layout.fillWidth: true; Layout.topMargin: Theme.space2; spacing: 0
                        CText { text: comment.modelData.author + " · " + new Date(comment.modelData.at).toLocaleString(Qt.locale(), Locale.ShortFormat); color: Theme.muted; font.pixelSize: Theme.caption }
                        CText { text: comment.modelData.body; textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap }
                    }
                }
            }
        }
    }
    // ── Drafts ──
    Component {
        id: outbox
        ColumnLayout {
            id: view
            spacing: Theme.space2
            property var writes: []
            property string open: ""
            property bool loaded: false
            function load() { rpc.call("accounts.outbox", {}, value => { if (pane.failed(value)) return; writes = value.writes.filter(write => write.state !== "discarded"); loaded = true }) }
            Component.onCompleted: load()
            Connections { target: pane; function onRevisionChanged() { view.load() } }
            CText { text: "What you or an assistant prepared, and what was sent. A draft stays on this computer until you send it."; color: Theme.muted; font.pixelSize: Theme.caption; Layout.fillWidth: true; wrapMode: Text.Wrap }
            CText { visible: view.loaded && !view.writes.length; text: "Nothing is waiting, and nothing was sent yet."; color: Theme.muted }
            Scroll {
                Layout.fillWidth: true; Layout.fillHeight: true
                Repeater {
                    model: view.writes
                    Entry {
                        id: row
                        required property var modelData
                        objectName: "write_" + modelData.id
                        label: modelData.title; strong: modelData.state !== "sent"
                        detail: Accounts.writeState(modelData) + " · " + modelData.login + " · " + new Date(modelData.updated).toLocaleString(Qt.locale(), Locale.ShortFormat)
                        note: modelData.error || ""
                        icon: modelData.state === "sent" ? "check" : modelData.state === "unknown" || modelData.state === "failed" ? "notice" : "edit"
                        selected: view.open === modelData.id
                        onActivated: view.open = selected ? "" : modelData.id
                        Small { visible: ["draft", "failed"].includes(row.modelData.state); text: "Review and send…"; primary: true; onClicked: reviewer.show(row.modelData) }
                        Small { visible: row.modelData.editable && row.modelData.kind !== "calendar.create"; text: "Edit…"; onClicked: mailEditor.openFor(row.modelData) }
                        Small { visible: row.modelData.editable && row.modelData.kind === "calendar.create"; text: "Edit…"; onClicked: eventEditor.openDraft(row.modelData) }
                        Small { visible: row.modelData.state === "unknown"; text: "Check whether it arrived"; onClicked: rpc.call("accounts.check", { id: row.modelData.id }, value => { if (!pane.failed(value)) view.load() }) }
                        Small { visible: ["draft", "failed", "unknown"].includes(row.modelData.state); text: "Discard"; onClicked: rpc.call("accounts.discard", { id: row.modelData.id }, value => { if (!pane.failed(value)) view.load() }) }
                        Small { visible: !!row.modelData.result?.link; text: "Open at the service"; onClicked: Qt.openUrlExternally(row.modelData.result.link) }
                    }
                }
            }
        }
    }

    // ── Writing ──
    // Every write passes here: exactly what will be sent, and one button that sends it.
    CDialog {
        id: reviewer
        objectName: "accountReview"
        accessibleTitle: "Review before sending"
        preferredWidth: Theme.dialogWidth
        property var write: null
        property string problem: ""
        property bool sending: false
        readonly property string verb: !write ? "Send" : write.kind === "calendar.remove" ? "Delete" : write.service === "mail" ? (write.kind === "mail.draft" ? "Save to Drafts" : "Send") : write.service === "calendar" ? "Save" : write.service === "drive" ? "Upload" : "Post"
        function show(value) { write = value; problem = ""; sending = false; open() }
        function prepare(params) { pane.error = ""; rpc.call("accounts.draft", Object.assign({ sessionId: pane.sessionId }, params), value => { if (!pane.failed(value)) reviewer.show(value) }) }
        function send() {
            problem = ""; sending = true
            rpc.call("accounts.commit", { id: write.id, digest: write.digest }, value => {
                sending = false
                if (value.error) { problem = value.error; return }
                write = value
                if (value.state === "sent") { reviewer.close(); pane.notice = value.title + ": done."; pane.written() } else problem = value.error || "It was not sent."
            })
        }
        CText { text: reviewer.write?.title || ""; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
        ScrollView {
            id: reviewScroll
            Layout.fillWidth: true; Layout.preferredHeight: Math.min(Theme.editorMedium, text.implicitHeight + Theme.space4); clip: true; contentWidth: availableWidth
            ScrollBar.vertical: CScrollBar { parent: reviewScroll; x: reviewScroll.width - width; height: reviewScroll.availableHeight }
            CText { id: text; objectName: "accountReviewText"; width: reviewScroll.availableWidth - Theme.space3; text: reviewer.write?.description || ""; textFormat: Text.PlainText; wrapMode: Text.Wrap }
        }
        CText { visible: !!reviewer.problem; text: reviewer.problem; color: reviewer.write?.state === "unknown" ? Theme.amber : Theme.danger; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
        footerContent: RowLayout {
            spacing: Theme.space2
            CButton { text: "Keep as a draft"; Layout.fillWidth: true; enabled: !reviewer.sending; onClicked: { reviewer.close(); pane.notice = "Kept in Drafts." } }
            CButton { objectName: "accountSend"; text: reviewer.sending ? "Working…" : reviewer.verb; primary: true; danger: reviewer.write?.kind === "calendar.remove"; Layout.fillWidth: true; enabled: !reviewer.sending && ["draft", "failed"].includes(reviewer.write?.state || ""); onClicked: reviewer.send() }
        }
    }
    CDialog {
        id: mailEditor
        objectName: "mailEditor"
        accessibleTitle: "Write mail"
        property var draft: null
        property var reply: null
        property string problem: ""
        function openFor(value) { draft = value?.id ? value : null; reply = value?.mail?.reply || null; problem = ""; to.text = (value?.mail?.to || []).join(", "); cc.text = (value?.mail?.cc || []).join(", "); subject.text = value?.mail?.subject || ""; body.text = value?.mail?.text || ""; open(); (to.text ? body : to).forceActiveFocus(); if (reply) body.cursorPosition = 0 }
        function save() {
            problem = ""
            const mail = Object.assign({ to: Accounts.emails(to.text), cc: Accounts.emails(cc.text), subject: subject.text.trim(), text: body.text }, reply ? { reply: reply } : {})
            rpc.call("accounts.draft", Object.assign({ sessionId: pane.sessionId, accountId: draft ? draft.accountId : pane.accountId, kind: "mail.send", mail: mail }, draft ? { id: draft.id, digest: draft.digest } : {}), value => { if (value.error) { problem = value.error; return } mailEditor.close(); reviewer.show(value) })
        }
        CText { text: mailEditor.reply ? "Reply" : mailEditor.draft ? "Edit the draft" : "Write mail"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CField { id: to; objectName: "mailTo"; Layout.fillWidth: true; placeholderText: "To"; Accessible.name: "To" }
        CField { id: cc; Layout.fillWidth: true; placeholderText: "Cc (optional)"; Accessible.name: "Cc" }
        CField { id: subject; objectName: "mailSubject"; Layout.fillWidth: true; placeholderText: "Subject"; Accessible.name: "Subject" }
        ScrollView { id: bodyScroll; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorMedium * 0.7; clip: true; ScrollBar.vertical: CScrollBar { parent: bodyScroll; x: bodyScroll.width - width; height: bodyScroll.availableHeight } CTextArea { id: body; objectName: "mailBody"; placeholderText: "Message"; Accessible.name: "Message" } }
        CText { visible: !!mailEditor.problem; text: mailEditor.problem; color: Theme.danger; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
        footerContent: RowLayout { spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: mailEditor.close() }
            CButton { objectName: "mailReview"; text: "Review…"; primary: true; Layout.fillWidth: true; enabled: !rpc.busy && body.text.trim().length > 0; onClicked: mailEditor.save() } }
    }
    CDialog {
        id: eventEditor
        objectName: "eventEditor"
        accessibleTitle: "Event"
        property var event: null
        property var draft: null
        property string problem: ""
        property string zone: "UTC"
        function fill(value, day) {
            const start = value?.start, end = value?.end
            title.text = value?.title || ""; allDay.checked = !!start?.date
            startDay.text = start ? Accounts.dayOf(start) : day; startTime.text = start && !start.date ? Accounts.clockOf(start) : "09:00"
            endDay.text = end ? (end.date ? Accounts.addDays(Accounts.dayOf(end), -1) : Accounts.dayOf(end)) : day; endTime.text = end && !end.date ? Accounts.clockOf(end) : "10:00"
            zone = start?.timeZone || pane.list.timeZone || "UTC"
            place.text = value?.location || ""; notes.text = value?.notes || ""; guests.text = (value?.attendees || []).map(item => item.email || item).join(", "); repeat.currentIndex = value?.recurrence?.every ? ["", "day", "week", "month", "year"].indexOf(value.recurrence.every) : 0; problem = ""
        }
        function openFor(value, day) { event = value; draft = null; fill(value, day); open(); title.forceActiveFocus() }
        function openDraft(write) { event = null; draft = write; fill(write.event, Accounts.isoDay(new Date())); open() }
        function save() {
            const time = (day, clock) => allDay.checked ? { date: day } : { dateTime: day + "T" + clock, timeZone: zone }
            const value = Object.assign({ title: title.text.trim(), start: time(startDay.text.trim(), startTime.text.trim()), end: allDay.checked ? { date: Accounts.addDays(endDay.text.trim(), 1) } : time(endDay.text.trim(), endTime.text.trim()) }, place.text.trim() ? { location: place.text.trim() } : {}, notes.text.trim() ? { notes: notes.text } : {}, guests.text.trim() ? { attendees: Accounts.emails(guests.text) } : {}, repeat.currentIndex > 0 ? { recurrence: { every: ["", "day", "week", "month", "year"][repeat.currentIndex] } } : {})
            problem = ""
            rpc.call("accounts.draft", Object.assign({ sessionId: pane.sessionId, accountId: draft ? draft.accountId : pane.accountId, event: value }, event ? { kind: "calendar.update", calendarId: event.calendarId, eventId: event.id, revision: event.revision } : { kind: "calendar.create" }, draft ? { id: draft.id, digest: draft.digest, calendarId: draft.calendarId } : {}), result => { if (result.error) { problem = result.error; return } eventEditor.close(); reviewer.show(result) })
        }
        CText { text: eventEditor.event ? "Change the event" : "New event"; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CField { id: title; objectName: "eventTitle"; Layout.fillWidth: true; placeholderText: "Title"; Accessible.name: "Title" }
        CCheckBox { id: allDay; text: "All day" }
        GridLayout {
            Layout.fillWidth: true; columns: allDay.checked ? 2 : 3; columnSpacing: Theme.space2; rowSpacing: Theme.space2
            CText { text: "Starts" }
            CField { id: startDay; objectName: "eventStartDay"; Layout.fillWidth: true; placeholderText: "2026-05-01"; inputMask: "9999-99-99"; Accessible.name: "Start date" }
            CField { id: startTime; visible: !allDay.checked; Layout.fillWidth: true; inputMask: "99:99"; Accessible.name: "Start time" }
            CText { text: "Ends" }
            CField { id: endDay; Layout.fillWidth: true; inputMask: "9999-99-99"; Accessible.name: "End date" }
            CField { id: endTime; visible: !allDay.checked; Layout.fillWidth: true; inputMask: "99:99"; Accessible.name: "End time" }
        }
        CText { visible: !allDay.checked; text: "Times in " + eventEditor.zone.replace(/_/g, " "); color: Theme.muted; font.pixelSize: Theme.caption }
        CComboBox { id: repeat; Layout.fillWidth: true; model: ["Does not repeat", "Every day", "Every week", "Every month", "Every year"]; Accessible.name: "Repeat" }
        CField { id: place; Layout.fillWidth: true; placeholderText: "Where (optional)"; Accessible.name: "Where" }
        CField { id: guests; Layout.fillWidth: true; placeholderText: "Guests by email (optional; the service invites them)"; Accessible.name: "Guests" }
        ScrollView { Layout.fillWidth: true; Layout.preferredHeight: Theme.editorShort; clip: true; CTextArea { id: notes; placeholderText: "Notes (optional)"; Accessible.name: "Notes" } }
        CText { visible: !!eventEditor.problem; text: eventEditor.problem; color: Theme.danger; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
        footerContent: RowLayout { spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: eventEditor.close() }
            CButton { objectName: "eventReview"; text: "Review…"; primary: true; Layout.fillWidth: true; enabled: !rpc.busy && title.text.trim().length > 0; onClicked: eventEditor.save() } }
    }
    CDialog {
        id: githubEditor
        objectName: "githubEditor"
        accessibleTitle: "Write on GitHub"
        property var write: ({})
        property string problem: ""
        readonly property string kind: write.kind || ""
        function openFor(value) { write = value; problem = ""; repo.text = value.repo || ""; ghTitle.text = value.title || ""; ghBody.text = value.body || ""; head.text = ""; base.text = value.base || ""; closed.checked = value.state === "closed"; open(); (kind === "comment" ? ghBody : repo.text ? ghTitle : repo).forceActiveFocus() }
        function save() {
            const value = { kind: kind, repo: repo.text.trim() }
            if (write.number) value.number = write.number
            if (kind === "comment") value.body = ghBody.text
            else if (kind === "release.draft") { value.tag = ghTitle.text.trim(); value.name = ghTitle.text.trim(); value.body = ghBody.text }
            else { value.title = ghTitle.text.trim(); value.body = ghBody.text }
            if (kind === "pull.create") { value.head = head.text.trim(); value.base = base.text.trim() }
            if (kind === "issue.update") { value.revision = write.revision; value.state = closed.checked ? "closed" : "open" }
            problem = ""
            rpc.call("accounts.draft", { sessionId: pane.sessionId, accountId: pane.accountId, kind: "github", write: value }, result => { if (result.error) { problem = result.error; return } githubEditor.close(); reviewer.show(result) })
        }
        CText { text: ({ "issue.create": "New issue", "issue.update": "Change the issue", "comment": "Comment", "pull.create": "Pull request", "release.draft": "Draft a release" })[githubEditor.kind] || ""; font.pixelSize: Theme.title; font.weight: Font.DemiBold }
        CField { id: repo; objectName: "githubRepo"; Layout.fillWidth: true; readOnly: !!githubEditor.write.repo; placeholderText: "owner/name"; Accessible.name: "Repository" }
        CField { id: ghTitle; objectName: "githubTitle"; visible: githubEditor.kind !== "comment"; Layout.fillWidth: true; placeholderText: githubEditor.kind === "release.draft" ? "Tag, for example v1.2.0" : "Title"; Accessible.name: placeholderText }
        RowLayout { visible: githubEditor.kind === "pull.create"; Layout.fillWidth: true; spacing: Theme.space2
            CField { id: head; Layout.fillWidth: true; placeholderText: "Branch with the changes"; Accessible.name: placeholderText }
            CField { id: base; Layout.fillWidth: true; placeholderText: "Into branch"; Accessible.name: placeholderText } }
        ScrollView { id: ghScroll; Layout.fillWidth: true; Layout.preferredHeight: Theme.editorMedium * 0.6; clip: true; ScrollBar.vertical: CScrollBar { parent: ghScroll; x: ghScroll.width - width; height: ghScroll.availableHeight } CTextArea { id: ghBody; objectName: "githubBody"; placeholderText: "Text (Markdown)"; Accessible.name: "Text" } }
        CCheckBox { id: closed; visible: githubEditor.kind === "issue.update"; text: "Closed" }
        CText { visible: !!githubEditor.problem; text: githubEditor.problem; color: Theme.danger; Layout.fillWidth: true; wrapMode: Text.Wrap; Accessible.role: Accessible.AlertMessage }
        footerContent: RowLayout { spacing: Theme.space2
            CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: githubEditor.close() }
            CButton { objectName: "githubReview"; text: "Review…"; primary: true; Layout.fillWidth: true; enabled: !rpc.busy; onClicked: githubEditor.save() } }
    }
    CDialog {
        id: filePicker
        accessibleTitle: "Choose a file of this conversation"
        property var target: null
        property string folderId: ""
        property var files: []
        function openFor(item, folder) { target = item; folderId = folder; files = []; open(); rpc.call("artifacts.list", { sessionId: pane.sessionId, limit: 60 }, value => { if (!value.error) files = value.items || [] }) }
        CText { text: filePicker.target ? "New version of " + filePicker.target.name : "Upload a file"; font.pixelSize: Theme.title; font.weight: Font.DemiBold; Layout.fillWidth: true; wrapMode: Text.Wrap }
        CText { visible: !filePicker.files.length; text: "This conversation has no files yet."; color: Theme.muted }
        Repeater {
            model: filePicker.files
            CActionRow { required property var modelData; Layout.fillWidth: true; text: modelData.name; detail: modelData.mime || modelData.kind || ""; onClicked: { filePicker.close(); reviewer.prepare(Object.assign({ accountId: pane.accountId, artifactId: modelData.id || modelData.artifactId, versionId: modelData.latestVersionId || modelData.versionId }, filePicker.target ? { kind: "drive.update", fileId: filePicker.target.id, revision: filePicker.target.revision } : Object.assign({ kind: "drive.create" }, filePicker.folderId ? { folderId: filePicker.folderId } : {}))) } }
        }
        CButton { text: "Cancel"; Layout.fillWidth: true; onClicked: filePicker.close() }
    }
}
