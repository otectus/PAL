#include "avatardefinition.h"
#include "avatarstartup.h"
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

static QVariantMap readRig(const QString &path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return {};
    return QJsonDocument::fromJson(file.readAll()).object().toVariantMap();
}
static bool save(const QImage &image, const QString &path) {
    QSaveFile file(path);
    return !image.isNull() && file.open(QIODevice::WriteOnly) && image.save(&file, "PNG") && file.commit();
}
int main(int argc, char **argv) {
    QGuiApplication app(argc, argv);
    const auto args = app.arguments();
    if (args.size() != 5) return 1;
    const auto base = readRig(args[1]), overrides = readRig(args[2]);
    if (base.isEmpty() || overrides.isEmpty()) return 1;
    const auto rig = AvatarDefinition::resolve(base, overrides);
    if (!rig.error.isEmpty()) return 1;
    const auto atlas = QFileInfo(args[2]).dir().filePath(rig.definition.value("texture").toString());
    auto art = AvatarStartup::render(rig.definition, atlas);
    // The runtime uses only mask alpha. Flat RGB compresses the resource without changing coverage.
    for (int y = 0; y < art.mask.height(); ++y) {
        auto line = reinterpret_cast<QRgb *>(art.mask.scanLine(y));
        for (int x = 0; x < art.mask.width(); ++x) line[x] = qRgba(0, 0, 0, qAlpha(line[x]));
    }
    if (!save(art.still, args[3]) || !save(art.mask, args[4])) {
        qCritical("Could not prepare avatar startup art for %s", qPrintable(args[2]));
        return 1;
    }
    return 0;
}
