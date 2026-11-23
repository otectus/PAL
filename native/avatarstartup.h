#pragma once
#include <QImage>
#include <QVariantMap>

namespace AvatarStartup {
struct Art {
    QImage still;
    QImage mask;
};
Art render(const QVariantMap &definition, const QString &atlasPath);
}
