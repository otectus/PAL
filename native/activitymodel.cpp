#include "activitymodel.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>

namespace {
constexpr int entryRole = Qt::UserRole + 1;
struct Action { const char *title; const char *icon; };
const QHash<QString, Action> actions{
    {"commandExecution", {"Run command", "terminal"}}, {"Bash", {"Run command", "terminal"}},
    {"exec_command", {"Run command", "terminal"}}, {"host_run", {"Run host command", "terminal"}},
    {"commands_run", {"Run saved command", "terminal"}}, {"write_stdin", {"Interact with terminal", "terminal"}},
    {"functions.exec", {"Run tool code", "terminal"}}, {"functions.wait", {"Wait for tool output", "terminal"}},
    {"functions.exec_command", {"Run command", "terminal"}}, {"functions.write_stdin", {"Interact with terminal", "terminal"}},
    {"fileChange", {"Change files", "edit"}}, {"apply_patch", {"Apply file changes", "edit"}},
    {"Edit", {"Edit file", "edit"}}, {"Write", {"Write file", "edit"}}, {"Read", {"Read file", "file"}},
    {"Grep", {"Search file contents", "search"}}, {"Glob", {"Find files", "search"}},
    {"files_read", {"Read file", "file"}}, {"files_list", {"List files", "projects"}},
    {"files_find", {"Find files", "search"}}, {"files_search", {"Search file contents", "search"}},
    {"files_propose_changes", {"Propose file changes", "edit"}}, {"files_stat", {"Inspect file", "file"}},
    {"webSearch", {"Search the web", "search"}}, {"WebSearch", {"Search the web", "search"}},
    {"web_search", {"Search the web", "search"}}, {"WebFetch", {"Read web page", "file"}},
    {"web_read", {"Read web page", "file"}}, {"memory_search", {"Search project memory", "memory"}},
    {"memory_save", {"Save project memory", "memory"}}, {"knowledge_search", {"Search knowledge", "search"}},
    {"sessions_start", {"Delegate a task", "agents"}}, {"sessions_send", {"Continue delegated work", "agents"}},
    {"sessions_read", {"Read delegated conversation", "chat"}}, {"sessions_wait", {"Wait for delegated work", "agents"}},
    {"timer_start", {"Start timer", "activity"}},
    {"imageView", {"View image", "image"}}, {"view_image", {"View image", "image"}},
    {"imageGeneration", {"Generate image", "image"}}, {"images_generate", {"Generate image", "image"}},
    {"codelab_run", {"Run code", "terminal"}}, {"mcpToolCall", {"Call server tool", "workbench"}},
    {"dynamicToolCall", {"Call tool", "workbench"}}
};

QString readable(QString name) {
    static const QRegularExpression camel("([a-z])([A-Z])");
    name.replace('_', ' ').replace(camel, "\\1 \\2");
    if (!name.isEmpty()) name[0] = name[0].toUpper();
    return name;
}
QString toolKey(const QString &name) { return name.section("__", -1); }

// Only label a simple invocation. Compound shell commands keep the general command title.
Action commandAction(QString command) {
    static const QRegularExpression shell(R"(^(?:/[^ ]*/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(.+)$)");
    const auto wrapper = shell.match(command);
    if (wrapper.hasMatch()) {
        command = wrapper.captured(1).trimmed();
        if (command.size() > 1 && (command.front() == '\'' || command.front() == '"') && command.back() == command.front())
            command = command.mid(1, command.size()-2);
    }
    static const QRegularExpression compound("[;&|`$<>\n]");
    if (!command.contains(compound)) {
        const auto program = command.section(' ', 0, 0).section('/', -1);
        if (program == "rg" || program == "grep") {
            if (command.split(' ').contains("--files")) return {"List files", "projects"};
            return {"Search file contents", "search"};
        }
        if (program == "ls") return {"List files", "projects"};
        if (program == "cat" || program == "head" || program == "tail") return {"Read file", "file"};
        if (program == "ctest" || program == "pytest" || program == "vitest" || command.startsWith("node --test ")) return {"Run tests", "terminal"};
        if (command.startsWith("cmake --build ")) return {"Build project", "terminal"};
        if (command == "git status" || command.startsWith("git status ")) return {"Check working tree", "projects"};
        if (command == "git diff" || command.startsWith("git diff ")) return {"Inspect changes", "edit"};
    }
    return {"Run command", "terminal"};
}

QVariantMap describe(const QVariantMap &entry) {
    const auto raw = entry.value("text").toString();
    const auto sample = raw.left(640);
    const auto first = sample.section('\n', 0, 0).trimmed();
    const auto info = entry.value("toolActivity").toMap();
    QString name = info.value("name").toString(), status = info.value("status").toString();
    QString owner = info.value("agentName").toString(), title, preview, icon, kind;
    const bool agent = entry.value("kind") == "agent";
    const bool noProgress = (info.isEmpty() || status == "notice") && first == "No progress detected";
    if (agent) {
        kind = "agent";
        const auto split = first.lastIndexOf(" · ");
        if (owner.isEmpty()) owner = split < 0 ? first : first.left(split);
        if (status.isEmpty() && split >= 0) status = first.mid(split + 3);
        title = readable(owner);
        if (title.isEmpty()) title = QObject::tr("Subagent update");
        preview = sample.section('\n', 1).simplified();
        icon = "agents";
    } else if (status == "notice" || noProgress || (info.isEmpty() && first.startsWith("Codex notice: "))) {
        kind = "notice";
        status = "notice";
        title = noProgress ? QObject::tr("No progress detected") : QObject::tr("Provider notice");
        preview = noProgress ? sample.section('\n', 1).simplified() : sample.simplified();
        if (preview.startsWith("Codex notice: ")) preview.remove(0, 14);
        icon = "notice";
    } else {
        kind = "tool";
        // Older rows may only have output. Only recognize an actual tool header, never guess an outcome.
        static const QRegularExpression toolHeader("^[a-zA-Z][a-zA-Z0-9_.-]{0,159}$");
        const bool oldEnvelope = info.isEmpty() && sample.contains('\n') && toolHeader.match(first).hasMatch()
            && sample.section('\n', 1).trimmed().startsWith('{');
        if (name.isEmpty() && (actions.contains(toolKey(first)) || first.startsWith("mcp__") || oldEnvelope)) name = first;
        const auto key = toolKey(name);
        const auto action = actions.constFind(key);
        if (action != actions.cend()) {
            auto label = *action;
            if (QLatin1StringView(label.title) == "Run command") label = commandAction(info.value("target").toString());
            title = QObject::tr(label.title);
            icon = label.icon;
        } else {
            title = name.isEmpty() ? QObject::tr("Tool output") : readable(key);
            icon = "workbench";
        }
        const auto operation = info.value("action").toString();
        if (operation == "read") { title = QObject::tr("Read file"); icon = "file"; }
        if (operation == "search") { title = QObject::tr("Search files"); icon = "search"; }
        if (operation == "listFiles") { title = QObject::tr("List files"); icon = "projects"; }
        preview = info.value("target").toString().left(640).simplified();
        if (preview.isEmpty() || status == "failed") {
            const auto summary = info.value("summary").toString().simplified();
            if (!summary.isEmpty()) preview = summary;
        }
        if (oldEnvelope && raw.size() <= 64 * 1024) {
            const auto result = QJsonDocument::fromJson(raw.mid(raw.indexOf('\n') + 1).toUtf8()).object();
            if (result.value("schema").toInt() == 1) preview = result.value("summary").toString().left(640).simplified();
        }
        if (preview.isEmpty() && !info.contains("agentId")) {
            preview = first == name ? sample.section('\n', 1).simplified() : first;
            if (preview == name) preview.clear();
        }
    }
    return {{"title",title}, {"preview",preview}, {"name",name}, {"owner",readable(owner)},
        {"state",status}, {"kind",kind}, {"icon",icon}, {"noProgress",noProgress}};
}

QVariantMap presented(const QModelIndex &index) {
    if (!index.isValid()) return {};
    auto entry = index.data(entryRole).toMap();
    entry.insert("log", describe(entry));
    return entry;
}
}

ActivityModel::ActivityModel(QObject *parent) : QSortFilterProxyModel(parent) {
    setFilterRole(entryRole);
}
QVariant ActivityModel::data(const QModelIndex &index, int role) const {
    return role == entryRole ? presented(mapToSource(index)) : QSortFilterProxyModel::data(index, role);
}
bool ActivityModel::filterAcceptsRow(int row, const QModelIndex &parent) const {
    if ((m_scope.isEmpty() || m_scope == "all") && m_agentId.isEmpty() && m_query.isEmpty()) return true;
    const auto entry = sourceModel()->index(row, 0, parent).data(entryRole).toMap();
    const auto info = entry.value("toolActivity").toMap();
    if (!m_agentId.isEmpty() && info.value("agentId") != m_agentId) {
        if (info.contains("agentId") || entry.value("kind") != "agent") return false;
        // Historical agent keys are <session>:agent:<turn>:<agent>. The agent ID itself can contain a colon.
        const auto key = entry.value("id").toString();
        const auto marker = key.indexOf(":agent:");
        const auto separator = marker < 0 ? -1 : key.indexOf(':', marker + 7);
        if (separator < 0 || QStringView(key).mid(separator + 1) != m_agentId) return false;
    }
    const auto log = describe(entry);
    if (m_scope == "tools" && log.value("kind") != "tool") return false;
    if (m_scope == "agents" && log.value("kind") != "agent") return false;
    static const QStringList attention{"failed", "interrupted", "declined", "waiting", "pending", "notice"};
    if (m_scope == "attention" && !attention.contains(log.value("state").toString())) return false;
    if (m_query.isEmpty()) return true;
    const auto matches = [this](const QVariant &text){ return text.toString().contains(m_query, Qt::CaseInsensitive); };
    for (const auto *key : {"title", "owner", "name", "state"}) if (matches(log.value(key))) return true;
    return matches(info.value("target")) || matches(info.value("description")) || matches(info.value("agentName")) || matches(entry.value("text"));
}
bool ActivityModel::changeFilter(QString &field, const QString &value) {
    if (field == value) return false;
#if QT_VERSION >= QT_VERSION_CHECK(6, 10, 0)
    beginFilterChange();
    field = value;
    endFilterChange(Direction::Rows);
#else
    field = value;
    invalidateRowsFilter();
#endif
    return true;
}
void ActivityModel::setQuery(const QString &value) {
    if (changeFilter(m_query, value.trimmed())) emit queryChanged();
}
void ActivityModel::setScope(const QString &value) {
    if (changeFilter(m_scope, value)) emit scopeChanged();
}
void ActivityModel::setAgentId(const QString &value) {
    if (changeFilter(m_agentId, value)) emit agentIdChanged();
}

void ActivityModel::setSourceModel(QAbstractItemModel *source) {
    if (sourceModel() == source) return;
    for (const auto &connection : std::as_const(m_connections)) disconnect(connection);
    m_connections.clear();
    m_inspected = QModelIndex();
    m_inspectedId.clear();
    QSortFilterProxyModel::setSourceModel(source);
    if (source) {
        m_connections << connect(source, &QAbstractItemModel::dataChanged, this, [this](const QModelIndex &first, const QModelIndex &last){
            if (m_inspected.isValid() && m_inspected.row() >= first.row() && m_inspected.row() <= last.row()) emit inspectedChanged();
        });
        m_connections << connect(source, &QAbstractItemModel::modelReset, this, [this]{
            if (!m_inspectedId.isEmpty()) inspect(m_inspectedId);
        });
    }
    emit inspectedChanged();
}
int ActivityModel::inspect(const QString &messageId) {
    m_inspected = QModelIndex();
    if (!messageId.isEmpty() && sourceModel()) {
        for (int row = 0; row < sourceModel()->rowCount(); ++row) {
            const auto index = sourceModel()->index(row, 0);
            if (index.data(entryRole).toMap().value("id") == messageId) { m_inspected = index; break; }
        }
    }
    m_inspectedId = m_inspected.isValid() ? messageId : QString();
    emit inspectedChanged();
    return mapFromSource(m_inspected).row();
}
QVariantMap ActivityModel::inspected() const { return presented(m_inspected); }
