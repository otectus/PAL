#pragma once
#include <QPersistentModelIndex>
#include <QSortFilterProxyModel>
#include <QVariantMap>

// Each chat window can search and inspect the same incremental transcript independently.
class ActivityModel : public QSortFilterProxyModel {
    Q_OBJECT
    Q_PROPERTY(QString query READ query WRITE setQuery NOTIFY queryChanged)
    Q_PROPERTY(QString scope READ scope WRITE setScope NOTIFY scopeChanged)
    Q_PROPERTY(QString agentId READ agentId WRITE setAgentId NOTIFY agentIdChanged)
    Q_PROPERTY(QVariantMap inspected READ inspected NOTIFY inspectedChanged)
public:
    explicit ActivityModel(QObject *parent = nullptr);
    QString query() const { return m_query; }
    QString scope() const { return m_scope; }
    QString agentId() const { return m_agentId; }
    void setQuery(const QString &value);
    void setScope(const QString &value);
    void setAgentId(const QString &value);
    void setSourceModel(QAbstractItemModel *source) override;
    QVariant data(const QModelIndex &index, int role) const override;
    Q_INVOKABLE int inspect(const QString &messageId);
    QVariantMap inspected() const;
signals:
    void queryChanged();
    void scopeChanged();
    void agentIdChanged();
    void inspectedChanged();
protected:
    bool filterAcceptsRow(int row, const QModelIndex &parent) const override;
private:
    bool changeFilter(QString &field, const QString &value);
    QString m_query, m_scope, m_agentId;
    QString m_inspectedId;
    QPersistentModelIndex m_inspected;
    QList<QMetaObject::Connection> m_connections;
};
